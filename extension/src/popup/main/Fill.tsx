import { useEffect, useState } from "preact/hooks";
import { MAX_SITES, siteOfUrl } from "../../core/autofill-sites";
import { coveredBy, hostOf, usableDomain } from "../../core/match";
import { isShared } from "../../core/site-domains";
import type { Entry } from "../../core/vault/model";
import {
  canFill,
  candidatesFor,
  choose,
  fillCand,
  fits,
  inFront,
  inFrontOfOwnWindow,
  scan,
  schemeOf,
  scriptingHeld,
  type Cand,
  type FillResult,
  type Frame,
} from "../../platform/autofill";
import {
  answered,
  API_HOST,
  laterList,
  notNow,
  offHint,
  readList,
  requestSite,
  setOffHint,
} from "../../platform/autofill-sites";
import { gatedCode, touchSwitch } from "../../platform/plugins/autofill-gate";
import { ruleForPage } from "../../platform/site-rule";
import type { GrantKeys } from "../../core/plugins/store";
import {
  forHere,
  hereNow,
  peekRequest,
  requestArea,
  storedRequest,
  takeRequest,
  watchRequest,
  type NotHere,
} from "../../platform/fill-request";
import { Icon } from "../../ui/icons";
import { t } from "../../ui/i18n";
import { useShortcut } from "../../ui/shortcut";
import { pageDelay } from "../page-delay";
import { surface } from "../surface";
import { ft } from "./fill-text";
import * as pageFill from "./page-fill";
import type { Row } from "./model";
import "./fill.css";

/**
 * The Fill button (TOTP-AUTOFILL §0.4, §8.1; Stage 1): a lazy chunk, loaded by Main (Main.tsx `fillView`) the first time the
 * list has an account registered for the page, with its own text (fill-text.ts), so none of it is in the popup's counted
 * bundle. Two components: FillBar, above the list, looks at the page once (the finder, platform/autofill.ts, reads the
 * shape of the page's inputs and writes nothing) and says whether a code box is there; RowFill, under each card of the
 * "This site" section, is the button. The code is worked out only when a button is pressed, and goes to the page in one
 * call (platform/autofill.ts); nothing is stored, logged or copied.
 */

type Seen =
  | { k: "scanning" }
  | { k: "blocked" }
  | { k: "slow" }
  /** Sixkey's storage could not be closed to content scripts: no look, no Fill button (STORAGEGATE, the second layer). */
  | { k: "gated" }
  /** Sixkey does not hold `scripting` (not asked for yet, or autofill off): no look until a Fill click asks for it. */
  | { k: "ask" }
  | { k: "away" }
  /**
   * `minLeft`: the page's site rule's (TOTP autofill Stage 3), for the fill's wait; null: the default. `appends`: the site
   * wants the code typed right after the password, in the same box (AF3-5): said where no code box is found (noBox).
   */
  | { k: "ready"; tabId: number; url: string; frames: Frame[]; minLeft: number | null; appends: boolean };
type Per =
  | { k: "idle" }
  | { k: "busy" }
  | { k: "wait"; s: number }
  | { k: "insecure"; cand?: Cand }
  /** `doc`: a press made for a page's request, whose boxes are that document's top frame's only. */
  | { k: "pick"; doc?: string }
  | { k: "done" }
  | { k: "fail"; text: string }
  /** Nothing filled, and that is how the page is, not a failure: the "code after the password" note (AF3-5). */
  | { k: "note"; text: string }
  /** The outcome is not known (the page did not answer, or hid the box after the code went in): said plainly, not as a refusal. */
  | { k: "unsure"; text: string };

// The in-page suggestion's release gate (scripts/suggest-ui.mjs, the build's define): a constant of this module, folded by
// the build. With it open, a page's fill request (R v2) offered here binds the next press (./page-fill.ts); with it
// closed, none of that is in the build.
declare const __SUGGEST_UI__: boolean;
const SUGGEST_UI = typeof __SUGGEST_UI__ === "boolean" && __SUGGEST_UI__;

let seen: Seen = { k: "scanning" };
/** The vault key of this surface, for the platform's gate (Main connects it when it loads this chunk). */
let keysOf: () => Promise<GrantKeys | null> = async () => null;
/** Main's one call: where the gate gets the vault key (the popup's or the side panel's service). */
export function connect(keys: () => Promise<GrantKeys | null>): void {
  keysOf = keys;
}
/** Whether Sixkey holds `scripting`, as Chrome said at the last look (refreshed by every look and every grant). */
let held = false;
/**
 * The first statement of every click that may fill (Chrome grants a permission only in the user's gesture, and a gesture
 * spent on an await is gone): `scripting` asked for if it is not held, which Chrome grants without a dialog. "off": the
 * page's hint says autofill is switched off (platform/plugins/autofill-switch.ts), and nothing is asked; "no": refused,
 * or not asked because there is no click (`gesture` false: a fill resumed after an unlock never asks).
 */
function askScripting(gesture = true): Promise<"ok" | "granted" | "off" | "no"> {
  if (offHint()) return Promise.resolve("off");
  if (held) return Promise.resolve("ok");
  if (!gesture) return Promise.resolve("no");
  let asked: Promise<boolean>;
  try {
    asked = chrome.permissions.request({ permissions: ["scripting"] });
  } catch {
    return Promise.resolve("no");
  }
  return asked.then(
    (ok) => ((held = ok), ok ? "granted" : "no"),
    () => "no",
  );
}
let siteHost = "";
/** The host the list shows now (the panel's tab watcher reads it when it fires). */
let latest = "";
const per = new Map<string, Per>();
const cancelled = new Set<string>();
/**
 * The accounts whose "not secure (http)" question was answered Fill anyway, each with the page it was answered for (the tab
 * and its address; a new look of another page clears them all). The answer lasts for the choice of box that follows and for
 * that one fill, no longer (F5).
 */
const consent = new Map<string, string>();
const consentKey = (s: { tabId: number; url: string }) => `${s.tabId} ${s.url}`;
const subs = new Set<() => void>();
const poke = () => subs.forEach((f) => f());
/** Redraws the component when the scan or any button's state changes. */
function useStore() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    subs.add(f);
    return () => void subs.delete(f);
  }, []);
}
const setSeen = (s: Seen) => {
  seen = s;
  poke();
};
const setPer = (id: string, p: Per) => {
  per.set(id, p);
  poke();
};

let inflight: { host: string; look: Promise<Seen> } | null = null;
/**
 * Look at the page the list is showing (`host`): the tab must still be on it, or the answer is "blocked". A look already
 * under way for the host is the answer (two triggers, one look). `keep`: a button's own look keeps the notes.
 */
function rescan(host: string, keep = false): Promise<Seen> {
  if (inflight?.host === host) return inflight.look;
  if (!keep) {
    for (const id of [...consent.keys()]) consent.delete(id);
    for (const id of [...per.keys()]) per.delete(id);
    siteAsk = null;
  } // the notes of an earlier page (Code filled, a refusal, the offer) do not belong to this one
  const look = scanPage(host).finally(() => (inflight = null));
  inflight = { host, look };
  return look;
}
export async function scanPage(host: string): Promise<Seen> {
  siteHost = host;
  setSeen({ k: "scanning" });
  let next: Seen = { k: "away" }; // the tab in front is not on this page (any more): nothing is looked at
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined && tab.url && hostOf(tab.url) === host) {
      held = await scriptingHeld();
      // switched off (the page hint): the page is not looked at (W1b review F-07). Else the site rule for the page is read
      // while the finder is installed, and its hint is the look's argument (TOTP autofill Stage 3, AF3-3b); without
      // `scripting` the look says a click must ask first, and no rule is read for it
      const rule = held && !offHint() ? ruleForPage(tab.url) : null;
      const r = offHint() ? ({ k: "ask" } as const) : await scan(tab.id, rule ? rule.then((x) => x.hint) : null);
      // the look's answer keeps the rest of the rule: its minLeft, and whether the site wants the code after the password
      const got = r.k === "ok" ? await rule : null;
      next =
        r.k === "ok"
          ? {
              k: "ready",
              tabId: tab.id,
              url: tab.url,
              frames: r.frames,
              minLeft: got?.minLeft ?? null,
              appends: got?.appends === true,
            }
          : { k: r.k };
    }
  } catch {
    /* blocked */
  }
  if (siteHost === host) setSeen(next);
  return next;
}

/**
 * What to draw: the last look, if it is of the site the list shows. Just after a tab switch the list is the new site's
 * while the last look is still the old one's (the next look starts a moment later): that is "scanning", not an answer.
 */
const shownSeen = (): Seen => (siteHost === latest ? seen : { k: "scanning" });

/** The page holds frames of other sites that activeTab does not let Sixkey into (so a code box in one cannot be found). */
const foreign = (s: Seen) => s.k === "ready" && s.frames.some((f) => f.seen.x > 0);
/** The page has more inputs than one look reads, or the look ran out of time. */
const complex = (s: Seen) => s.k === "ready" && s.frames.some((f) => f.seen.z === 1);
/**
 * The text for "no box found" (the strip's, and a press's that found none): on a site that wants the code typed after the
 * password (the baseline's appends, TOTP autofill Stage 3, AF3-5), that, since its sign-in has no box for the code to
 * look for; else the page may be too complex, or the box may be in a frame Sixkey cannot enter. Text only: what a press
 * does, and the copy of the card's code, are the same on every page. (A press's says that note as a note, not as a
 * refusal: pressRun.)
 */
const noBox = (s: Seen) =>
  s.k === "ready" && s.appends
    ? ft("afAppend")
    : complex(s)
      ? ft("afComplex")
      : foreign(s)
        ? ft("afFrame")
        : ft("afNone");
/** Look again unless the last look was of this very tab and page (a remount, a search cleared, costs nothing). */
async function lookIfNew(host: string): Promise<void> {
  const [now] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (seen.k === "ready" && siteHost === host && now?.id === seen.tabId && now.url === seen.url) return;
  await rescan(host);
}
const usable = (c: Cand, e: Entry) => fits(c, e.digits) && !c.found.weak;

/**
 * A look of the tab and page that are in front NOW (the panel follows the user between tabs, and two tabs can be on one site).
 * The last look is used only if it is of that tab and page; else the page is looked at again, at the host the list shows
 * (just after a tab switch the list is already the new site's while the last look is still the old one's). A look that was
 * already under way is joined by `rescan`, and it may have started before the switch: its answer is checked against the tab
 * in front once more, and the page is looked at afresh if it is another one (the re-verification's F6 and a race found by
 * its test: a Fill pressed in the same instant as a tab switch went into the tab that had been in front). `fresh`: the page is
 * looked at again even if the last look is of it (a click that found no box, or found its box gone: the page may have
 * changed without a navigation, a single-page app's next step).
 */
async function lookAtFront(fresh = false): Promise<Seen> {
  for (let i = 0; i < 3; i++) {
    const [now] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    const front = (x: Seen) => x.k === "ready" && now?.id === x.tabId && now.url === x.url;
    const s = front(seen) && !(fresh && i === 0) ? seen : await rescan(latest, true);
    if (s.k !== "ready" || front(s)) return s;
  }
  return { k: "away" };
}

/** Why there is no look of the page to fill from, in words. */
const whyNot = (s: Seen) =>
  s.k === "away" ? ft("afAway") : s.k === "slow" ? ft("afLookSlow") : s.k === "gated" ? ft("afOld") : ft("afBlocked");
/** The gate's code for this surface: the switch and the ceiling checked, the ask logged (platform/plugins/autofill-gate.ts). */
const code = (e: Entry, at: number) => gatedCode(keysOf)(e, at);

/**
 * One press of a button: look (again if needed), ask what must be asked, then fill. Resolves when the result is shown.
 * `noOffer`: a fill after which the surface closes (the popup a pending request opened): no offer to turn the site on.
 */
type PressOptions = {
  cand?: Cand;
  anyway?: boolean;
  noOffer?: boolean;
  resumed?: boolean;
  /** A page's request (the gate open): the document whose top frame the press fills, or nothing. */
  doc?: string;
  /** Made for a page's request: the popup closes once the code is in. */
  page?: boolean;
};
async function press(e: Entry, o: PressOptions = {}): Promise<void> {
  const asked = askScripting(!o.resumed); // first: in the click's gesture (W1b; test/unit/plugins-w1b-source-rules.test.ts)
  if (SUGGEST_UI && !o.resumed && pageFill.current()) {
    // the press a page's request binds (AUTOFILL2 patch 4a): nothing during the surface's input delay, or for a press begun
    // in it (../page-delay.ts; `scripting` is held wherever such a request can come from, so the ask above showed nothing).
    // Then R is taken (the compare-and-delete) and that document filled, or none. A request that cannot be taken any more
    // (old, a lock, another tab or page in front) says so and fills nothing: the next press is an ordinary one (S-2)
    if (!pageDelay.pressOk()) return;
    const p = pageFill.current()!;
    pageFill.drop();
    const area = requestArea();
    const took = area ? await takeRequest(area, p.nonce, hereNow(area)).catch(() => null) : null;
    if (!took?.ok || took.r.v !== 2)
      return setPer(e.id, { k: "fail", text: took && !took.ok ? notHereText(took.why) : ft("afResumeOther") });
    o = { ...o, doc: took.r.doc, noOffer: true, page: true };
  }
  const holds = await pressRun(e, o, asked);
  if (!holds) consent.delete(e.id); // a "Fill anyway" is used up by the fill (or the refusal) it was given for
  // the popup opened for a page's request closes once the code is in (the side panel stays, as it always does)
  if (SUGGEST_UI && o.page && per.get(e.id)?.k === "done" && !surface.panel) setTimeout(() => window.close(), 1200);
}
/** `true`: the press ended in the question "which box?", so the answer to the http question is still needed. */
async function pressRun(e: Entry, o: PressOptions, asked: Promise<"ok" | "granted" | "off" | "no">): Promise<boolean> {
  resumeNote = null;
  cancelled.delete(e.id);
  setPer(e.id, { k: "busy" });
  const fail = (text: string) => (setPer(e.id, { k: "fail", text }), false);
  const may = await asked;
  if (may === "off") return fail(ft("afOffNow"));
  if (may === "no") return fail(ft("afAskNo"));
  let s = await lookAtFront(seen.k === "ask");
  if (s.k !== "ready") return fail(whyNot(s));
  const scheme = schemeOf(s.url);
  if (scheme === "no") return fail(ft("afBlocked"));
  if (scheme === "insecure" && !o.anyway && consent.get(e.id) !== consentKey(s))
    return (setPer(e.id, { k: "insecure", cand: o.cand }), false);
  if (o.anyway) consent.set(e.id, consentKey(s)); // the answer holds for the choice of box that follows, for this page only
  for (let attempt = 0; attempt < 2; attempt++) {
    let cands = candidatesFor(e, s.url, s.frames);
    // a press made for a page's request (the gate open): the boxes of the document clicked, its top frame, only
    if (SUGGEST_UI && o.doc !== undefined) cands = cands.filter((c) => pageFill.inDoc(c, o.doc!));
    // a page that has changed since the scan (a box that appeared, one that went): look again, once
    if (!o.cand && !cands.some((c) => usable(c, e)) && attempt === 0) {
      s = await lookAtFront(true);
      if (s.k !== "ready") return fail(whyNot(s));
      cands = candidatesFor(e, s.url, s.frames);
      if (SUGGEST_UI && o.doc !== undefined) cands = cands.filter((c) => pageFill.inDoc(c, o.doc!));
    }
    // that document gone, or a box chosen (a weak one, or from the question) that is not in it: nothing filled anywhere
    if (SUGGEST_UI && o.doc !== undefined && (cands.length === 0 || (o.cand && !pageFill.inDoc(o.cand, o.doc))))
      return fail(ft("afGone"));
    const pick = o.cand ?? choose(cands, e.digits);
    if (!pick) {
      if (cands.some((c) => usable(c, e)))
        return (setPer(e.id, SUGGEST_UI && o.doc !== undefined ? { k: "pick", doc: o.doc } : { k: "pick" }), true);
      if (cands.some((c) => !c.found.weak)) return fail(ft("afDigits", e.digits));
      // no box on a site that wants the code after the password: its sign-in has none, so the note is said plainly, not
      // as a refusal (AF3-5's note; the review's NIT, done with AF3-4)
      return s.appends ? (setPer(e.id, { k: "note", text: ft("afAppend") }), false) : fail(noBox(s));
    }
    const at = s;
    let waited = false;
    const r: FillResult = await fillCand(s.tabId, e, pick, {
      code,
      minLeft: s.minLeft, // the page's site rule's, if it has one (the plan's N5)
      waiting: (ms) => {
        waited = true;
        const end = Date.now() + ms;
        const tick = () => {
          const left = Math.ceil((end - Date.now()) / 1000);
          if (left > 0 && !cancelled.has(e.id)) {
            setPer(e.id, { k: "wait", s: left });
            setTimeout(tick, 250);
          }
        };
        tick();
      },
      cancelled: () => cancelled.has(e.id),
      // right before the code goes: the tab in front (AUTOFILL2 patch 3). The side panel is in the browser window, which must
      // be the focused one; the toolbar popup takes that window's activation itself, so it asks for its own window's front
      // tab, and closes the moment it loses the activation (P3 verify BLOCKER-1)
      front: surface.panel ? inFront : inFrontOfOwnWindow,
      // after the wait for the next code: the user may have gone to another tab, or the tab to another page (F7)
      away: async () => {
        const [now] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
        return now?.id !== at.tabId ? "tab" : now.url !== at.url ? "page" : null;
      },
    });
    if (r.k === "cancelled") return (setPer(e.id, { k: "idle" }), false);
    if (r.k === "filled") {
      setPer(e.id, { k: "done" });
      setTimeout(() => per.get(e.id)?.k === "done" && setPer(e.id, { k: "idle" }), 9000);
      if (!o.noOffer) void offerAfter(e.id, at.url);
      return false;
    }
    // a box gone after a wait is a page that changed while the user waited: no second try into whatever is there now (F7)
    if (r.r === "gone" && attempt === 0 && !o.cand && !waited) {
      s = await lookAtFront(true);
      if (s.k !== "ready") return fail(whyNot(s));
      continue;
    }
    // the code may be in the box in these two: no refusal is said (F3, F4)
    if (r.r === "moved") return (setPer(e.id, { k: "unsure", text: ft("afAfter") }), false);
    if (r.r === "slow") return (setPer(e.id, { k: "unsure", text: ft("afSlow") }), false);
    if (r.r === "gated") return fail(ft("afOld"));
    // the hint was missing: it is now; and whatever `scripting` this surface holds while Off is followed by the worker,
    // which gives it back (touchSwitch: an unchanged write, so no clock; with autofill on it takes nothing back). Always,
    // not only when this very click got it: a click that got it but found no box never reached the gate (W1b r3 S-1)
    if (r.r === "off") return (setOffHint(true), void touchSwitch(keysOf).catch(() => undefined), fail(ft("afOffNow")));
    if (r.r === "locked") return fail(ft("afLockedNow"));
    if (r.r === "ask") return ((held = false), fail(ft("afAskNo"))); // given back since the look: the next click asks
    if (r.r === "tab") return fail(ft("afLeftTab"));
    if (r.r === "page" || (r.r === "gone" && waited)) return fail(ft("afLeftPage"));
    return fail(
      r.r === "digits"
        ? ft("afDigits", e.digits)
        : r.r === "refused"
          ? ft("afRefused")
          : r.r === "origin" || r.r === "frame" || r.r === "args"
            ? ft("afMoved")
            : ft("afGone"),
    );
  }
  return false;
}

/** Above the list: whether the page has a code box for one of the accounts below. Looks once per page. */
export function FillBar({ host, rows }: { host: string; rows: Row[] }) {
  useStore();
  const entries = rows.map((r) => r.entry);
  const key = useShortcut("fill");
  useEffect(() => void ft.loaded.then(poke), []);
  const any = entries.some(canFill); // an account that can make a code (not a HOTP one): else the page is not looked at
  useEffect(() => {
    if (any) void lookIfNew(host);
  }, [host, any]);
  // the side panel stays open while the user moves between tabs and pages: look again when the tab in front changes or
  // loads another page (the popup closes by itself; a tab change there is a new popup)
  latest = host;
  useEffect(() => {
    let timer = 0;
    const stop = any
      ? surface.panel?.watchTab(() => {
          clearTimeout(timer);
          timer = window.setTimeout(() => void lookIfNew(latest), 250);
        })
      : undefined;
    return () => {
      clearTimeout(timer);
      stop?.();
    };
  }, [any]);
  if (!ft.words() || !any) return null; // no text (the chunk of it could not be read): nothing of the Fill UI is drawn
  const sn = shownSeen();
  if (sn.k === "ask") return null; // not looked at yet: the first Fill click asks for `scripting`, then looks
  const found = sn.k === "ready" && entries.some((e) => candidatesFor(e, sn.url, sn.frames).some((c) => !c.found.weak));
  const text =
    sn.k === "scanning"
      ? ft("afScanning")
      : sn.k === "blocked"
        ? ft("afBlocked")
        : sn.k === "slow"
          ? ft("afLookSlow")
          : sn.k === "gated"
            ? ft("afOld")
            : found
              ? ft("afFound")
              : noBox(sn);
  return (
    <div class={`fillbar${found ? " ok" : ""}`} role="status" title={key ? `${ft("afFillShort")} (${key})` : undefined}>
      <Icon name={found ? "check" : sn.k === "scanning" ? "scan" : "info"} size={14} />
      <span>{text}</span>
      {sn.k !== "scanning" && sn.k !== "gated" && !found && (
        <button type="button" class="btn sm quiet" onClick={() => void rescan(host)}>
          {ft("afAgain")}
        </button>
      )}
    </div>
  );
}

/** The button under one card of the "This site" section. `first`: the top match, the recommended one. */
export function RowFill({ entry, first }: { entry: Entry; first: boolean }) {
  useStore();
  useEffect(() => () => void cancelled.add(entry.id), [entry.id]);
  const sn = shownSeen();
  if (!ft.words() || !canFill(entry)) return null;
  const p = per.get(entry.id) ?? { k: "idle" };
  // no button where Sixkey could not close its storage to the page's scripts: the line above the list says why, and a press
  // whose own look came back so says it under the card as well (STORAGEGATE verify, NIT-4)
  if (sn.k === "gated")
    return p.k === "fail" ? (
      <div class="fill">
        <p class="fillnote bad" role="status">
          <Icon name="alert" size={13} />
          <span>{p.text}</span>
        </p>
      </div>
    ) : null;
  const cands = sn.k === "ready" ? candidatesFor(entry, sn.url, sn.frames) : [];
  const good = cands.filter((c) => usable(c, entry));
  const weak = cands.filter((c) => c.found.weak && fits(c, entry.digits));
  const sent = good.length > 0 && good.every((c) => c.found.sent);
  const name = entry.issuer || entry.label;
  const busy = p.k === "busy" || p.k === "wait";
  // a page's request here (the gate open), during the surface's input delay: drawn disabled (a press now does nothing)
  const held = SUGGEST_UI && pageFill.held();
  // M6: on a page other than a registered host itself (a subdomain of it) the button names the host it fills on
  const reg = (entry.domains ?? []).map(usableDomain).find((d) => d && !isShared(d) && coveredBy(latest, d));
  const sub = !!reg && reg !== latest;
  const label = (c: Cand, i: number) =>
    c.found.k === 1 ? ft("afSegs", c.found.n) : c.found.lab ? ft("afBox", i + 1, c.found.lab) : ft("afBoxPlain", i + 1);
  return (
    <div class="fill">
      {p.k === "insecure" ? (
        <>
          <p class="fillnote warn" role="status">
            <Icon name="shieldAlert" size={13} />
            <span>{ft("afInsecure")}</span>
          </p>
          <div class="fillacts">
            <button
              type="button"
              class="btn sm fillanyway"
              onClick={() => void press(entry, { anyway: true, ...(p.cand ? { cand: p.cand } : {}) })}
            >
              {ft("afAnyway")}
            </button>
            <button
              type="button"
              class="btn sm quiet"
              onClick={() => (consent.delete(entry.id), setPer(entry.id, { k: "idle" }))}
            >
              {t("cancel")}
            </button>
          </div>
        </>
      ) : p.k === "pick" ? (
        <>
          <p class="fillnote" role="status">
            <span>{ft("afPick")}</span>
          </p>
          <div class="fillacts">
            {(SUGGEST_UI && p.doc !== undefined ? good.filter((c) => pageFill.inDoc(c, p.doc!)) : good).map((c, i) => (
              <button
                key={c.found.t}
                type="button"
                class="btn sm ghost"
                onClick={() =>
                  void press(
                    entry,
                    SUGGEST_UI && p.doc !== undefined ? { cand: c, doc: p.doc, page: true } : { cand: c },
                  )
                }
              >
                {label(c, i)}
              </button>
            ))}
            <button
              type="button"
              class="btn sm quiet"
              onClick={() => (consent.delete(entry.id), setPer(entry.id, { k: "idle" }))}
            >
              {t("cancel")}
            </button>
          </div>
        </>
      ) : (
        <>
          <div class="fillacts">
            <button
              type="button"
              class={`btn sm fillbtn${first && good.length > 0 ? "" : " ghost"}`}
              disabled={busy}
              title={siteHost}
              {...(SUGGEST_UI && held ? { "aria-disabled": true, style: { opacity: 0.55 } } : {})}
              onClick={() => void press(entry)}
            >
              <Icon name="keyboard" size={15} />
              {good.length > 0 ? (sub ? ft("afFillOn", latest) : ft("afFill")) : ft("afFillShort")}
              <span class="vh">{` (${name}, ${siteHost})`}</span>
            </button>
            {p.k === "wait" && (
              <button type="button" class="btn sm quiet" onClick={() => cancelled.add(entry.id)}>
                {t("cancel")}
              </button>
            )}
            {good.length === 0 && weak[0] && p.k === "idle" && (
              <button type="button" class="btn sm quiet" onClick={() => void press(entry, { cand: weak[0]! })}>
                {ft("afFocus")}
              </button>
            )}
          </div>
          {p.k === "wait" && (
            <p class="fillnote" role="status">
              <Icon name="clock" size={13} />
              <span>{ft("afWait", p.s)}</span>
            </p>
          )}
          {p.k === "done" && (
            <p class="fillnote ok" role="status">
              <Icon name="check" size={13} />
              <span>{ft("afDone")}</span>
            </p>
          )}
          {p.k === "unsure" && (
            <p class="fillnote warn" role="status">
              <Icon name="alert" size={13} />
              <span>{p.text}</span>
            </p>
          )}
          {p.k === "note" && (
            <p class="fillnote" role="status">
              <Icon name="info" size={13} />
              <span>{p.text}</span>
            </p>
          )}
          {p.k === "fail" && (
            <p class="fillnote bad" role="status">
              <Icon name="alert" size={13} />
              <span>{p.text}</span>
            </p>
          )}
          {sent && p.k === "idle" && (
            <p class="fillnote" role="status">
              <Icon name="info" size={13} />
              <span>{ft("afSent")}</span>
            </p>
          )}
          {siteAsk?.id === entry.id && <SiteOffer o={siteAsk} />}
        </>
      )}
    </div>
  );
}

// ---- the offer to suggest codes on this site (AUTOFILL2 patch 2; platform/autofill-sites.ts) --------------------------
// After a fill on an https page whose host may be turned on (core/autofill-sites.ts siteOfUrl: not http, not at another
// port, not an IP address, a shared suffix or the sync API's host) and is not on the list, the card offers once to turn
// code suggestions on for exactly that host. "Turn on" asks Chrome for that one origin, as the first thing its click does;
// granted, the site goes on the list (and if this popup closes meanwhile, the worker finishes it). "Not now", or a refusal
// in Chrome's dialog: not offered again until the browser restarts. A page that changes takes the offer with it.
// (The wording is a draft, pending the owner's OQ3: OWNER-DECISIONS/14.)

type SiteAsk = { id: string; host: string; k: "ask" | "asking" | "on" };
/** The offer under the card of the account just filled, or none. */
let siteAsk: SiteAsk | null = null;
const setSiteAsk = (o: SiteAsk | null) => {
  siteAsk = o;
  poke();
};
const askIs = (o: SiteAsk) => siteAsk?.id === o.id && siteAsk.host === o.host;

async function offerAfter(id: string, url: string): Promise<void> {
  const host = siteOfUrl(url, API_HOST);
  if (host === null || siteAsk?.host === host) return;
  try {
    const [listed, later] = await Promise.all([readList(), laterList()]);
    if (listed.includes(host) || later.includes(host) || listed.length >= MAX_SITES) return;
  } catch {
    return;
  }
  if (seen.k === "ready" && seen.url === url) setSiteAsk({ id, host, k: "ask" }); // still that page (a new look drops it)
}

/** "Turn on for <host>": Chrome's prompt FIRST, in the click itself (a gesture spent on an await is gone), then the list. */
function turnOn(o: SiteAsk): void {
  const asked = requestSite(o.host);
  setSiteAsk({ ...o, k: "asking" });
  void asked
    .catch(() => false)
    .then((granted) => answered(o.host, granted))
    .then(
      (on) => askIs(o) && setSiteAsk(on ? { ...o, k: "on" } : null),
      () => askIs(o) && setSiteAsk(null),
    );
}

function SiteOffer({ o }: { o: SiteAsk }) {
  if (o.k === "on")
    return (
      <p class="fillnote ok" role="status">
        <Icon name="check" size={13} />
        <span>{ft("afSiteOn", o.host)}</span>
      </p>
    );
  return (
    <div class="fillsite" role="group" aria-label={ft("afSiteAsk", o.host)}>
      <p class="fillnote">
        <b>{ft("afSiteAsk", o.host)}</b>
      </p>
      <p class="fillnote">
        <span>{ft("afSiteBody", o.host)}</span>
      </p>
      <div class="fillacts">
        <button type="button" class="btn sm fillsiteon" disabled={o.k === "asking"} onClick={() => turnOn(o)}>
          {ft("afSiteYes", o.host)}
        </button>
        <button
          type="button"
          class="btn sm quiet"
          disabled={o.k === "asking"}
          onClick={() => (setSiteAsk(null), void notNow(o.host).catch(() => undefined))}
        >
          {ft("afSiteNo")}
        </button>
      </div>
    </div>
  );
}

// ---- the pending fill request (AUTOFILL2 patch 1; platform/fill-request.ts) ------------------------------------------
// The `fill` shortcut pressed while Sixkey could not fill by itself left a request R, and opened this surface. Two cases:
//  - this surface's own lock screen showed R's line and the user unlocked there (App passes the nonce it showed): R is
//    taken (the compare-and-delete: still that nonce, fresh, no lock since, its tab in front of this window at its address)
//    and, for R from a locked vault and exactly one account, the ordinary press of that account's Fill button runs, once:
//    the look, the M5 question on an http page, "Which box?", the wait for the next code, FU's `away` and STORAGEGATE all
//    come with it. Several accounts, no account, or an R that is no longer for here: nothing is filled, a line says why.
//  - otherwise (the vault was open, or unlocked elsewhere and followed here): R is only offered: the Fill button of the
//    first account gets the focus; nothing is filled until it is pressed.

/** The nonces this page has acted on (one resume each) and the requests it has offered (focused once each). */
const resumed = new Set<string>();
const offered = new Set<string>();
/** What the list says about a request it did not finish by itself; cleared by the next press. */
let resumeNote: string | null = null;
const setNote = (text: string | null) => {
  resumeNote = text;
  poke();
};
const notHereText = (why: NotHere) => (why === "tab" ? ft("afResumeTab") : ft("afResumeOther"));

async function resumeFill(nonce: string, mine: Entry[]): Promise<void> {
  const area = requestArea();
  if (!area) return setNote(ft("afResumeOther"));
  const here = hereNow(area);
  const r = await storedRequest(area); // bounded (AF-BOUND): a lost answer is no request (the caller's note says so)
  if (!r || r.nonce !== nonce || (r.why !== "locked" && !(SUGGEST_UI && r.why === "page")))
    return setNote(ft("afResumeOther"));
  const not = await forHere(r, here);
  if (not) return setNote(notHereText(not));
  if (mine.length === 0) return setNote(ft("afResumeNone", r.host));
  if (mine.length > 1) {
    setNote(ft("afResumeChoose", r.host));
    return focusFill();
  }
  // without `scripting` a fill needs the user's own click (its gesture asks for it): the button is offered, nothing more.
  // Chrome's answer is kept for the press below, which never asks without a click (W1b review F-09)
  if (!(held = await scriptingHeld())) return focusFill();
  const took = await takeRequest(area, nonce, here);
  if (!took.ok) return setNote(notHereText(took.why));
  const e = mine[0]!;
  await press(
    e,
    SUGGEST_UI && took.r.v === 2
      ? { noOffer: !surface.panel, resumed: true, doc: took.r.doc }
      : surface.panel
        ? { resumed: true }
        : { noOffer: true, resumed: true },
  );
  // the popup opened for this request closes once the code is in (the side panel stays, as it always does)
  if (per.get(e.id)?.k === "done" && !surface.panel) setTimeout(() => window.close(), 1200);
}

/** Focus the first card's Fill button (the side panel only while it has the focus: never pull keys from the page). */
function focusFill(tries = 10): void {
  if (surface.panel && !document.hasFocus()) return;
  const b = document.querySelector<HTMLButtonElement>(".sect.site .fillbtn");
  if (b) b.focus();
  else if (tries > 0) setTimeout(() => focusFill(tries - 1), 100);
}

/** A request for here that this page did not unlock for: offered (its Fill button focused), once. */
async function offer(): Promise<void> {
  const area = requestArea();
  if (!area) return;
  if (SUGGEST_UI) await pageFill.refresh(); // a page's binding goes with its request (./page-fill.ts)
  const r = await peekRequest(area, hereNow(area)).catch(() => null);
  if (!r || offered.has(r.nonce) || resumed.has(r.nonce)) return;
  offered.add(r.nonce);
  // a page's request (the gate open): the next press is bound to it; the focus stays put while the user is busy here
  if (SUGGEST_UI && r.v === 2 && !pageFill.bind(r)) return;
  focusFill();
}
if (SUGGEST_UI) pageFill.connect(poke);

/** Under the strip, with the gate open: what Enter will do for a page's request offered here, and the resume's note. */
function PageGo({ host, note }: { host: string; note: string | null }) {
  return (
    <>
      <p class="fillnote resume" id="fill-page-go" role="status">
        <Icon name="keyboard" size={13} />
        <span>{SUGGEST_UI && t("afSugGo", host)}</span>
      </p>
      {note && (
        <p class="fillnote resume" role="status">
          <Icon name="info" size={13} />
          <span>{note}</span>
        </p>
      )}
    </>
  );
}

/** Under the strip: acts on the request of this surface's own unlock (`nonce`), or offers one; says what it could not do. */
export function Resume({ nonce, ready, rows }: { nonce: string | null; ready: boolean; rows: Row[] }) {
  useStore();
  useEffect(() => void ft.loaded.then(poke), []);
  useEffect(() => {
    if (!ready) return;
    if (nonce && !resumed.has(nonce)) {
      resumed.add(nonce);
      const mine = rows.map((r) => r.entry).filter(canFill);
      void ft.loaded.then(() => resumeFill(nonce, mine)).catch(() => setNote(ft("afResumeOther")));
    } else void offer();
    // a later request (a new press while this list stays open, as a side panel does) is offered too (the verify's NIT-1)
    return watchRequest(() => void offer());
  }, [nonce, ready]);
  if (SUGGEST_UI) useEffect(() => pageFill.watch(), []); // the side panel's tab changes (./page-fill.ts)
  const go = SUGGEST_UI ? pageFill.line() : null;
  if (SUGGEST_UI && go !== null && ft.words()) return <PageGo host={go} note={resumeNote} />;
  if (!ft.words() || !resumeNote) return null;
  return (
    <p class="fillnote resume" role="status">
      <Icon name="info" size={13} />
      <span>{resumeNote}</span>
    </p>
  );
}
