// The `fill` shortcut (manifest.base.json `commands`; TOTP-AUTOFILL §2.4, §5.3, §8.1), handled by the service worker so that
// it needs no page: it fills the code of the one account registered for the tab's site, without opening the popup. The
// shortcut is a user action that grants activeTab for the tab it was pressed on, which is what lets the worker read the
// tab's address and script it. What it does not do, it hands to the popup (or the side panel), where the user can choose
// or unlock: a locked vault, more than one account for the site, more than one code box, a page served over plain http
// (M5 asks first). The result is a badge and a tooltip on the toolbar icon of that tab, for a few seconds: no page is
// written to except by the one fill call (platform/autofill.ts), and nothing is logged.
import { hostOf, matchTier } from "../core/match";
import type { Entry } from "../core/vault/model";
import {
  candidatesFor,
  canFill,
  choose,
  fillCand,
  fits,
  scan,
  schemeOf,
  scriptingHeld,
  type FillDeps,
  type GatedCode,
} from "../platform/autofill";
import { bounded } from "../platform/bounded";
import { putRequest, type ReqArea } from "../platform/fill-request";

/**
 * `unsure`: the code may be in the box (a fill the page did not answer in time, or a box that kept the code and then went away);
 * `slow`: the page did not answer the look in time (nothing was written); `gated`: Sixkey's storage could not be closed to
 * content scripts, so nothing was injected (STORAGEGATE, kept as a second layer on Chrome 140 and later); `ask`: Sixkey does
 * not hold `scripting` (optional since wave 1b: not asked for yet, or autofill switched off), so the popup or the side
 * panel is opened, where the user's own click asks for it.
 */
export type Outcome =
  | "filled"
  | "nobox"
  | "nosite"
  | "locked"
  | "choose"
  | "blocked"
  | "insecure"
  | "failed"
  | "unsure"
  | "slow"
  | "gated"
  | "ask";
export type Tab = { id?: number; url?: string; windowId?: number };

/**
 * What the shortcut does for `tab`. `entries` is the unlocked vault's accounts, or null while the vault is locked (the
 * worker can open it only where its key is in the session; with "lock every time" it never can). `off`: whether autofill
 * is switched off (platform/plugins/autofill-switch.ts switchedOff).
 */
export async function fillOnTab(
  tab: Tab | undefined,
  entries: () => Promise<readonly Entry[] | null>,
  d: FillDeps & { code: GatedCode; off: () => Promise<boolean> },
): Promise<Outcome> {
  const host = hostOf(tab?.url);
  if (tab?.id === undefined || host === null || schemeOf(tab.url) === "no") return "blocked";
  // locked first: the unlock comes before anything else, and after it the surface offers the Fill button (W1b review F-04)
  const all = await entries();
  if (all === null) return "locked";
  const mine = all.filter((e) => canFill(e) && matchTier(e, host) === "registered");
  if (mine.length === 0) return "nosite";
  if (mine.length > 1) return "choose";
  if (schemeOf(tab.url) === "insecure") return "insecure";
  const entry = mine[0]!;
  // right before the look (W1b): switched off, the page is not looked at; without `scripting` nothing can be, and only a
  // click in Sixkey may ask for it. Either way the surface opens at its Fill button, which says why
  if (await d.off().catch(() => false)) return "ask";
  if (!(await scriptingHeld())) return "ask";
  const found = await scan(tab.id);
  if (found.k === "gated") return "gated";
  if (found.k === "slow") return "slow";
  if (found.k !== "ok") return "blocked";
  const cands = candidatesFor(entry, tab.url, found.frames);
  const usable = cands.filter((c) => fits(c, entry.digits) && !c.found.weak);
  if (usable.length === 0) return "nobox";
  const pick = choose(cands, entry.digits);
  if (!pick) return "choose";
  // After the wait (and before the code is worked out) the vault is looked at again: a lock in between stops the fill, and the
  // entry (its secret) is not used once it has gone (the review's M-1)
  const r = await fillCand(tab.id, entry, pick, {
    ...d,
    recheck: async () => (await entries())?.find((x) => x.id === entry.id) ?? null,
  });
  if (r.k === "cancelled") return "locked";
  if (r.k === "filled") return "filled";
  if (r.r === "gated") return "gated";
  if (r.r === "locked") return "locked"; // locked during the wait: the surface opens to unlock
  if (r.r === "off" || r.r === "ask") return "ask"; // switched off, or `scripting` given back: the surface says why
  return r.r === "slow" || r.r === "moved" ? "unsure" : "failed";
}

/** The parts of chrome.* the report uses (each may be missing: another browser, a test). */
export type FillChrome = {
  action: {
    /** `null` with a tab ID clears this tab's own value, so the icon shows the global one again (the sync status uses it). */
    setBadgeText(o: { tabId: number; text: string | null }): Promise<void>;
    setBadgeBackgroundColor(o: { tabId: number; color: string }): Promise<void>;
    /** A title is a string: Chrome refuses `null` and nothing (and "" is a title of its own, not a reset). */
    setTitle(o: { tabId: number; title: string }): Promise<void>;
    /** Without a tab: the title every tab shows unless it has its own (the manifest's, or the sync status's). */
    getTitle(o: { tabId?: number }): Promise<string>;
    openPopup?(o?: { windowId?: number }): Promise<void>;
  };
  sidePanel?: { open?(o: { windowId: number }): Promise<void> };
  i18n: { getMessage(key: string): string };
};

/** What the icon's tooltip says (Chrome's own text catalog, _locales; the English words are the fallback). Literal keys, so the build can see them. */
function titleOf(o: Outcome, c: FillChrome): string {
  const g = (m: string, fallback: string) => m || fallback;
  switch (o) {
    case "filled":
      return g(c.i18n.getMessage("fillTitleOk"), "Sixkey: code filled");
    case "nobox":
      return g(c.i18n.getMessage("fillTitleNoBox"), "Sixkey: no code box found on this page");
    case "nosite":
      return g(c.i18n.getMessage("fillTitleNoSite"), "Sixkey: no account is registered for this site");
    case "choose":
      return g(c.i18n.getMessage("fillTitleChoose"), "Sixkey: open it to choose what to fill");
    case "locked":
      return g(c.i18n.getMessage("fillTitleLocked"), "Sixkey is locked: open it to unlock");
    case "blocked":
      return g(c.i18n.getMessage("fillTitleBlocked"), "Sixkey cannot fill on this page");
    case "insecure":
      return g(c.i18n.getMessage("fillTitleInsecure"), "Sixkey: this page is not secure (http): open Sixkey to fill");
    case "failed":
      return g(c.i18n.getMessage("fillTitleFailed"), "Sixkey: the page did not accept the code");
    case "unsure":
      return g(c.i18n.getMessage("fillTitleUnsure"), "Sixkey: the code may have been entered: check the page");
    case "slow":
      return g(c.i18n.getMessage("fillTitleSlow"), "Sixkey: the page did not answer in time: try again");
    case "gated":
      return g(c.i18n.getMessage("fillTitleOld"), "Sixkey: autofill needs Chrome 140 or later");
    case "ask":
      return g(c.i18n.getMessage("fillTitleAsk"), "Sixkey: open it and click Fill code");
  }
}
/** The outcomes the popup (or side panel) finishes: it is opened for them, where the browser lets a shortcut do that. */
const NEEDS_SURFACE: ReadonlySet<Outcome> = new Set(["locked", "choose", "insecure", "ask"]);
/**
 * The outcomes that leave a pending request R for the surface (platform/fill-request.ts): exactly those it is opened for.
 * Every other outcome is final (filled, nothing to fill, refused, gated, ...), and writes none: an R left after a fill could
 * fill a second time.
 */
export const needsRequest = (o: Outcome): o is "locked" | "choose" | "insecure" | "ask" => NEEDS_SURFACE.has(o);
const SHOWN_MS = 4000;

/** Open the side panel (when the icon opens it) or the popup (Chrome 127+); where the browser refuses, the tooltip says to open Sixkey. */
async function openSurface(c: FillChrome, opens: "popup" | "panel" | undefined, windowId: number): Promise<void> {
  try {
    if (opens === "panel" && c.sidePanel?.open) await c.sidePanel.open({ windowId });
    else await c.action.openPopup?.({ windowId });
  } catch {
    /* the tooltip says to open Sixkey */
  }
}

/**
 * Tell the user what happened: a badge and a tooltip on this tab's toolbar icon, restored after a few seconds to what the
 * icon showed before (the sync status uses the same badge), and the popup or the side panel opened for the outcomes that
 * need one (the side panel only when the icon opens it; the popup with `action.openPopup`, which every Chrome Sixkey runs
 * on has: 127+, and Sixkey needs 140; if the browser refuses, the tooltip says to open Sixkey). Never throws.
 */
export async function reportFill(
  outcome: Outcome,
  tab: Tab,
  c: FillChrome,
  opens: "popup" | "panel" | undefined,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  try {
    if (tab.id === undefined) return;
    const tabId = tab.id;
    // The surface first, before anything else is awaited: the shortcut is the user's action, and opening the panel or the
    // popup needs it (sidePanel.open: "in response to a user action"; test/unit/sidepanel-mode.test.ts holds the order)
    const opened =
      NEEDS_SURFACE.has(outcome) && tab.windowId !== undefined
        ? openSurface(c, opens, tab.windowId)
        : Promise.resolve();
    await Promise.all([
      c.action.setBadgeText({ tabId, text: outcome === "filled" ? "OK" : "!" }),
      c.action.setBadgeBackgroundColor({ tabId, color: outcome === "filled" ? "#17774c" : "#b3470b" }),
      c.action.setTitle({ tabId, title: titleOf(outcome, c) }),
    ]);
    await opened;
    await sleep(SHOWN_MS);
    // Back to what the icon showed. The badge has a reset for one tab (`null`); the title has none (the browser refuses
    // `null`, and "" would be this tab's own empty title), so the global title is read now and set on the tab again: until
    // the tab navigates, a change of the global title (the sync status) does not show on it.
    const back = await c.action.getTitle({}).catch(() => "Sixkey");
    await Promise.allSettled([c.action.setBadgeText({ tabId, text: null }), c.action.setTitle({ tabId, title: back })]);
  } catch {
    /* the tab closed meanwhile */
  }
}

/**
 * The `fill` shortcut for `tab`, from the key to the toolbar (sw.ts calls it with the real wiring). In this order: the lock
 * epoch, read before the vault is (a lock after the press, during the wait for the next code, which fillOnTab reports as
 * "locked", moves the epoch on and so voids the request); fillOnTab; for an outcome the surface finishes (locked, several
 * accounts, plain http) the pending request R (platform/fill-request.ts), written BEFORE the surface is opened, so that a
 * popup that opens finds it and an open side panel sees it arrive; then the report, which opens the surface. A final outcome
 * writes no R. Never throws.
 */
export async function runShortcut(
  tab: Tab | undefined,
  o: {
    epoch: () => Promise<number>;
    entries: () => Promise<readonly Entry[] | null>;
    session: ReqArea;
    chrome: FillChrome;
    opens: "popup" | "panel" | undefined;
    /** The platform's gate for the code (platform/plugins/autofill-gate.ts gatedCode), the switch, and test seams. */
    deps: FillDeps & { code: GatedCode; off: () => Promise<boolean> };
    /** The report's few seconds (tests pass a quick one). */
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<Outcome> {
  // bounded (AF-BOUND, platform/bounded.ts): a lost answer is no epoch, so no R; the press goes on to its badge and surface
  const epoch = await bounded(o.epoch()).catch(() => -1);
  let outcome: Outcome = "blocked";
  try {
    outcome = await fillOnTab(tab, o.entries, o.deps);
  } catch {
    outcome = "failed";
  }
  if (!tab) return outcome;
  if (needsRequest(outcome) && epoch >= 0 && tab.id !== undefined && tab.windowId !== undefined && tab.url)
    await putRequest(o.session, {
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url,
      epoch,
      // "ask": the surface offers the Fill button, whose click asks for `scripting` (as for a choice)
      why: outcome === "ask" ? "choose" : outcome,
    }).catch(() => null);
  await reportFill(outcome, tab, o.chrome, o.opens, o.sleep);
  return outcome;
}
