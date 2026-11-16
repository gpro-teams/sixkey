// Putting a code into the page the user is on (TOTP-AUTOFILL §4.4, §5, §8.2). Used by the popup's Fill button (a lazy chunk,
// src/popup/main/Fill.tsx) and by the service worker's `fill` shortcut (src/background/fill-command.ts). The one place that
// calls chrome.scripting, in three calls, each pinned as the design says:
//   1. executeScript({tabId, allFrames}, files: inject/otp.js)   installs the finder in the tab's frames (isolated world);
//   2. executeScript({tabId, allFrames}, func: inspect, [hint])  reads where the code boxes are; no code is passed, only
//      the site rule's hint (core/rules/lookup.ts hintOf: a host, paths, selectors), or null (TOTP autofill Stage 3);
//   3. executeScript({tabId, documentIds: [one]}, func: fill)    types ONE code into ONE document found in step 2.
// Step 3 is the only call that carries a secret, and it carries exactly the current code (the finder checks the rest again
// in the page: origin, host, frames). Before step 1 and before step 3 the gate `storageClosed` (platform/storage-access.ts)
// must say that storage.local and storage.session are closed to content scripts right now; else nothing is injected
// (STORAGEGATE: before Chrome 140 storage.local could not be closed, and a page that hosted a Sixkey script could read and
// write the vault there; Sixkey needs Chrome 140 since wave 1b, and the gate stays as a second layer). No `allFrames`, no `frameIds`, no tab-wide target: if the document was replaced since
// the scan (a navigation, a reload), its ID no longer exists and the call fails with nothing written.
//
// `scripting` is optional (wave 1b of the plugin platform: MOD-PLATFORM §7.2 Option I item 3; PLUGINS-W1B-NOTES.md):
// before the first Fill click asks for it, or after autofill is turned off, `chrome.scripting` does not exist, and every
// call here says so ("ask") instead of throwing. The code is not worked out here: fillCand takes it from the platform's
// capability gate (platform/plugins/autofill-gate.ts gatedCode), which checks autofill's switch and logs the ask.
//
// Who may be filled is decided here and nowhere else: `candidatesFor` returns boxes only for an account whose registered
// domains cover the page (match.ts "registered", never "possibly related": M1, M2), in a frame only if the frame and every
// page above it are covered by the same registered domain of that account (M4). What the page says in step 2 is data
// from a page: it is checked down to numbers and short text, and it never chooses an account or a domain.
import { coveredBy, hostOf, isIpHost, matchTier, usableDomain } from "../core/match";
import { isShared } from "../core/site-domains";
import type { Entry } from "../core/vault/model";
import { canGenerate, remaining } from "../ui/otp-time";
import type { Hint } from "../core/rules/lookup";
import type { Failed, Found, Inspected } from "../inject/otp";
import { storageClosed } from "./storage-access";

/** The finder's file in the package (scripts/build.mjs builds it; check-dist holds it to its budget and its rules). */
export const ENGINE_FILE = "inject/otp.js";
/** At least this many seconds of the code's period must remain to fill it; else the next code is filled (§8.2). */
export const MIN_LEFT_S = 5;
/** The finder's lead for choosing a box without asking, and the qualifying score (the same numbers as inject/otp.ts). */
export const LEAD = 20;

export type Frame = { frameId: number; documentId: string; seen: Inspected };
/**
 * `blocked`: the tab cannot be scripted (a browser page, the Web Store, a PDF, a page the extension has no access to).
 * `slow`: the page did not answer in time (a busy page); it can be looked at again.
 * `gated`: Sixkey's storage could not be closed to content scripts, so nothing was injected (STORAGEGATE, kept as a second
 * layer: every Chrome Sixkey installs on, 140 and later, can close it).
 * `ask`: Sixkey does not hold `scripting` (not asked for yet, or autofill turned off): a click has to ask first.
 */
export type Scan = { k: "ok"; frames: Frame[] } | { k: "blocked" } | { k: "slow" } | { k: "gated" } | { k: "ask" };

/**
 * Whether Sixkey holds `scripting` now, as Chrome says (contains). Not whether `chrome.scripting` exists: Chrome adds the
 * namespace at the grant, without a reload, but keeps it after the permission is given back (measured: W1b's probe).
 */
export async function scriptingHeld(): Promise<boolean> {
  const c = globalThis.chrome;
  // no permissions API at all (a page outside the extension, the unit tests' fakes): the namespace is what there is
  if (typeof c?.permissions?.contains !== "function") return typeof c?.scripting?.executeScript === "function";
  try {
    return await c.permissions.contains({ permissions: ["scripting"] });
  } catch {
    return false;
  }
}

type Engine = { inspect(hint: unknown): unknown; fill(...a: string[]): Promise<unknown> };
// The two functions below are serialised into the page by executeScript: they must not use anything of this module. The
// look hands its one argument on as it is: a look with an argument (a hint, or null) is a Fill path's, and the finder
// tells it from the content script's look, which has none (inject/otp.ts inspect; AUTOFILL3-NOTES.md §3).
const inspectStub = (hint: unknown) => (globalThis as unknown as { __skOtp?: Engine }).__skOtp?.inspect(hint);
const fillStub = (code: string, origin: string, domain: string, top: string, token: string) =>
  (globalThis as unknown as { __skOtp?: Engine }).__skOtp?.fill(code, origin, domain, top, token) ?? {
    ok: false,
    r: "gone",
  };

const int = (v: unknown, max: number): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const origin = (v: unknown): v is string => str(v, 300) && /^https?:\/\/[^\s/]+$/.test(v);

/** What a page's finder reported, checked down to the shapes the extension uses; null for anything else. */
export function readInspected(raw: unknown): Inspected | null {
  const r = raw as Partial<Inspected> | null | undefined;
  if (!r || typeof r !== "object" || !origin(r.o) || typeof r.top !== "boolean") return null;
  if (!Array.isArray(r.a) || r.a.length > 20 || !r.a.every(origin)) return null;
  if (!Array.isArray(r.c) || r.c.length > 4 || !int(r.x, 99) || (r.z !== 0 && r.z !== 1)) return null;
  const c: Found[] = [];
  for (const f of r.c as Partial<Found>[]) {
    if (!f || typeof f !== "object") return null;
    if (!str(f.t, 16) || !/^[0-9a-f]{16}$/.test(f.t) || (f.k !== 0 && f.k !== 1) || !int(f.n, 64) || !int(f.s, 1000))
      return null;
    if (typeof f.sent !== "boolean" || typeof f.weak !== "boolean" || !str(f.lab, 32)) return null;
    if (f.r !== undefined && f.r !== 1) return null; // 1: a site rule named the box; absent: the heuristics'
    c.push({ t: f.t, k: f.k, n: f.n, s: f.s, sent: f.sent, weak: f.weak, lab: f.lab, ...(f.r ? { r: f.r } : {}) });
  }
  return { o: r.o, a: r.a, top: r.top, c, x: r.x, z: r.z };
}

/** Seconds a call into a page may take: a page can hold a call up (a handler that never returns); the extension stops waiting. */
export const PAGE_CALL_MS = 8000;
/** The call's answer, or null once `ms` have passed (the page is not trusted to answer). */
const within = <T>(p: Promise<T>, ms = PAGE_CALL_MS): Promise<T | null> =>
  new Promise((ok, no) => {
    const timer = setTimeout(() => ok(null), ms);
    p.then(
      (v) => (clearTimeout(timer), ok(v)),
      (e) => (clearTimeout(timer), no(e)),
    );
  });

/**
 * Look for the code boxes of the tab, in every frame the browser lets this call reach. `hint`: the site rule's, for the
 * finder to apply in the frames of its host; null: the heuristics alone, as before Stage 3. The popup's and the side
 * panel's Fill paths pass the rule still being read (platform/site-rule.ts ruleForPage: TOTP autofill Stage 3, AF3-3b),
 * which is read while the finder is installed: the look waits for both, and a read that fails is no hint. The worker's
 * shortcut passes none (the maintainers' C27).
 */
export async function scan(tabId: number, hint: Hint | null | Promise<Hint | null> = null): Promise<Scan> {
  if (!(await scriptingHeld())) return { k: "ask" };
  if (!(await storageClosed())) return { k: "gated" };
  try {
    const [installed, h] = await Promise.all([
      within(chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: [ENGINE_FILE] })),
      Promise.resolve(hint).catch(() => null),
    ]);
    if (installed === null) return { k: "slow" };
    const res = await within(
      chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: inspectStub, args: [h] }),
    );
    if (res === null) return { k: "slow" };
    const frames: Frame[] = [];
    for (const r of res) {
      const seen = readInspected(r.result);
      if (seen && typeof r.documentId === "string" && int(r.frameId, 2 ** 31)) {
        frames.push({ frameId: r.frameId, documentId: r.documentId, seen });
      }
    }
    return { k: "ok", frames };
  } catch {
    return { k: "blocked" };
  }
}

/** A box the extension may fill for one account: where it is, and the one registered domain that covers it and its frames. */
export type Cand = {
  frameId: number;
  documentId: string;
  /** The frame's origin, the top page's origin and the registered domain: what the finder checks again in the page. */
  origin: string;
  top: string;
  domain: string;
  found: Found;
};

/** Whether the account can be filled at all: a TOTP account with a secret. The place a protected tier will add its rule (§10). */
export const canFill = (e: Entry) => canGenerate(e);

/** How the page is served: `ok` (https, or an IP address), `insecure` (http: ask first, M5), `no` (anything else). */
export function schemeOf(url: string | undefined): "ok" | "insecure" | "no" {
  try {
    const u = new URL(url ?? "");
    if (u.protocol === "https:") return "ok";
    if (u.protocol !== "http:") return "no";
    return isIpHost(u.hostname.replace(/\.$/, "")) ? "ok" : "insecure";
  } catch {
    return "no";
  }
}

/**
 * The boxes this account may be filled into, best first (top page before frames, then by score). Only an account whose
 * registered domain covers the page's host: "possibly related" and every other account get nothing, whatever the page
 * says (M1, M2). A frame counts only if its own origin and every page above it are covered by the same registered domain
 * of the account (M4), and the page above all is the tab's (`tabUrl`, which the browser gave us).
 */
export function candidatesFor(entry: Entry, tabUrl: string | undefined, frames: readonly Frame[]): Cand[] {
  const host = hostOf(tabUrl);
  if (!canFill(entry) || host === null || matchTier(entry, host) !== "registered") return [];
  let topOrigin: string;
  try {
    topOrigin = new URL(tabUrl!).origin;
  } catch {
    return [];
  }
  // a registered domain that is a shared suffix (co.uk, github.io) could only have come from a restore or a sync: never filled
  const domains = (entry.domains ?? []).map(usableDomain).filter((d): d is string => d !== null && !isShared(d));
  const out: Cand[] = [];
  for (const f of frames) {
    const { o, a, top } = f.seen;
    if (top ? o !== topOrigin : a[a.length - 1] !== topOrigin) continue;
    const hosts = [hostOf(o), ...a.map(hostOf)];
    if (hosts.some((h) => h === null)) continue;
    const domain = domains.find((d) => hosts.every((h) => coveredBy(h!, d)));
    if (!domain) continue;
    for (const found of f.seen.c)
      out.push({ frameId: f.frameId, documentId: f.documentId, origin: o, top: topOrigin, domain, found });
  }
  return out.sort((x, y) => Number(y.frameId === 0) - Number(x.frameId === 0) || y.found.s - x.found.s);
}

/** A box fits the account's code: a group of exactly that many boxes, or a single box that takes at least that many digits. */
export const fits = (c: Cand, digits: number) =>
  c.found.k === 1 ? c.found.n === digits : c.found.n === 0 || c.found.n >= digits;

/** The box to fill without asking, or null when the user must choose: one that qualifies, leading the others by LEAD. */
export function choose(cands: readonly Cand[], digits: number): Cand | null {
  const ok = cands.filter((c) => fits(c, digits) && !c.found.weak);
  const [first, second] = ok;
  return first && (!second || first.found.s - second.found.s >= LEAD) ? first : null;
}

/**
 * Milliseconds to wait before filling, so that the code filled has at least `minLeft` seconds left (MIN_LEFT_S, or a site
 * rule's: TOTP autofill Stage 3, the plan's N5), and never more than half its period (§8.2); 0: now.
 */
export function waitFor(e: Pick<Entry, "period">, remainingS: number, minLeft: number = MIN_LEFT_S): number {
  return remainingS >= Math.min(minLeft, e.period / 2) ? 0 : Math.ceil(remainingS * 1000) + 60;
}

/**
 * `tab`, `page`: not filled, because after the wait for the next code another tab, or another address, was in front (F7).
 * `gated`: not filled, because Sixkey's storage could not be closed to content scripts just then (STORAGEGATE).
 * `off`: not filled, because the platform's gate refused the code (autofill switched off, or its record unverified).
 * `ask`: not filled, because Sixkey does not hold `scripting`.
 */
export type FillResult =
  | { k: "filled"; how: "single" | "chars" | "paste" }
  | { k: "cancelled" }
  | { k: "failed"; r: Failed | "slow" | "tab" | "page" | "gated" | "off" | "locked" | "ask" };

/** The platform's capability gate's answer (platform/plugins/autofill-gate.ts): the code, or why there is none. */
export type Gated = { code: string } | { no: "off" | "locked" };
/** The code of `e` at `timeMs`, from that gate. */
export type GatedCode = (e: Entry, timeMs: number) => Promise<Gated>;

export type FillDeps = {
  /** The seconds the code must still have: the page's site rule's (platform/site-rule.ts; AF3-3b), else MIN_LEFT_S. */
  minLeft?: number | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called with the wait when the code in the window is too close to expiring (the popup shows "New code in …"). */
  waiting?: (ms: number) => void;
  /**
   * True once the user has cancelled, the vault has locked, or the popup has closed: nothing more is done. Asked after the
   * wait and before the code is worked out (the worker looks the vault up again: a lock during the wait stops the fill).
   */
  cancelled?: () => boolean | Promise<boolean>;
  /** The account as it is now, or null if the vault has locked or the account is gone (the worker reads the vault again). */
  recheck?: () => Promise<Entry | null>;
  /**
   * Asked after a wait for the next code (only then): "tab" if the tab in front is no longer the one the fill is for, "page"
   * if it shows another address, else null. The code is then not filled into a page the user has left (F7).
   */
  away?: () => Promise<"tab" | "page" | null>;
  /**
   * Whether the tab is still the one in front, asked right before the fill call (AUTOFILL2 patch 3: P1-VERIFY item 4,
   * review M2 and M6). Default: inFront, the rule for the fills the worker makes (the shortcut) and the side panel's; the
   * toolbar popup passes inFrontOfOwnWindow (P3 verify BLOCKER-1). A failure to ask is a no.
   */
  front?: (tabId: number) => Promise<boolean>;
};

/**
 * Whether `tabId` is the tab in front of the window the user is in: the active tab of its window, and that window focused
 * (Chrome's `focused` is the native window's key status). For the fills the worker makes and the side panel's (a view
 * inside the browser window's own widget): no code goes into a tab the user is not looking at. What it cannot see, the page
 * checks itself in the same call as the write (inject/otp.ts fill: `visibilityState`).
 */
export async function inFront(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.active === true && (await chrome.windows.get(tab.windowId)).focused === true;
  } catch {
    return false;
  }
}

/**
 * For the toolbar popup (popup/main/Fill.tsx): whether `tabId` is the tab in front of the popup's own window, the comparator
 * of its look (lookAtFront) and of FU's `away`. The popup is a widget of its own that takes the activation from the browser
 * window under it, so that window does not report `focused` while the user is in the popup [`focused` is the window's key
 * status: verified in Chromium source; the popup taking the activation: inferred, owner checklist 25; P3 verify
 * BLOCKER-1]; and the popup closes, its fill with it, the moment it loses the activation.
 */
export async function inFrontOfOwnWindow(tabId: number): Promise<boolean> {
  try {
    return (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id === tabId;
  } catch {
    return false;
  }
}

/**
 * Type the account's current code into `cand`. If less than MIN_LEFT_S (or the page's rule's `d.minLeft`) of the code's
 * period remains, wait for the next period and fill that code instead (the document is pinned by ID, so a page that went
 * away in the meantime fails the call, and nothing is written; and with `away`, a page the user has left for another tab
 * or address is not filled either). The code is computed after the wait, here, and is passed to the page as the only
 * secret.
 */
export async function fillCand(
  tabId: number,
  entry: Entry,
  cand: Cand,
  d: FillDeps & { code: GatedCode },
): Promise<FillResult> {
  const now = d.now ?? Date.now;
  const wait = waitFor(entry, remaining(entry, now()), d.minLeft ?? MIN_LEFT_S);
  if (wait > 0) {
    d.waiting?.(wait);
    await (d.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(wait);
  }
  if (await d.cancelled?.()) return { k: "cancelled" };
  const left = wait > 0 && d.away ? await d.away() : null;
  if (left) return { k: "failed", r: left };
  if (!(await scriptingHeld())) return { k: "failed", r: "ask" };
  if (!(await storageClosed())) return { k: "failed", r: "gated" };
  const live = d.recheck ? await d.recheck() : entry;
  if (!live) return { k: "cancelled" };
  const gated = await d.code(live, now());
  if (!("code" in gated)) return { k: "failed", r: gated.no }; // refused: nothing goes to the page
  const code = gated.code;
  if (!(await (d.front ?? inFront)(tabId))) return { k: "failed", r: "tab" };
  try {
    const res = await within(
      chrome.scripting.executeScript({
        target: { tabId, documentIds: [cand.documentId] },
        func: fillStub,
        args: [code, cand.origin, cand.domain, cand.top, cand.found.t],
      }),
    );
    if (res === null) return { k: "failed", r: "slow" };
    const [r] = res;
    const v = r?.result as { ok?: unknown; how?: unknown; r?: unknown } | undefined;
    if (v?.ok === true && (v.how === "single" || v.how === "chars" || v.how === "paste"))
      return { k: "filled", how: v.how };
    const why = v?.r;
    return {
      k: "failed",
      r:
        why === "args" ||
        why === "origin" ||
        why === "frame" ||
        why === "digits" ||
        why === "refused" ||
        why === "moved"
          ? why
          : "gone",
    };
  } catch {
    return { k: "failed", r: "gone" };
  }
}
