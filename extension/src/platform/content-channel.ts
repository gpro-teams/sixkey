// The worker's end of the content script's messages (TOTP autofill Stage 2, patch 3: no in-page UI; AUTOFILL2-PLAN §4.1 and
// §8 with its review's M6 and m6; docs/design/notes/AUTOFILL2-NOTES.md §9). One message, `sk-af-cand`: the user clicked or
// typed in a code box on a site they turned on. What the worker does with it is browser UI the page cannot see or touch: the
// toolbar badge of that tab, "1", and its tooltip, "Sixkey can fill the code here: press Alt+Shift+F" (the shortcut then
// fills as it always does: platform/autofill.ts, with its gate, or the pending request of patch 1 when Sixkey is locked).
// With the in-page suggestion's release gate closed (the store build), the page gets no answer, so it learns nothing from
// sending it, not even whether Sixkey is locked (with it open, see below: `cand` is answered with whether to draw it).
//
// Before the badge, in this order, each a reason to do nothing at all:
//   1. the sender, as the browser gives it (sender-policy.ts contentSender): this extension's content script, in a tab in
//      front of its window, not incognito, in a live document, its frame and top page on https at the default port. Every
//      field of the message but its type is ignored: it cannot claim an origin, a URL or a tab;
//   2. at most CAND_PER_MINUTE messages per tab in a minute (in the worker's memory: best effort, reset when the worker
//      stops; the badge is all a message can ever cause);
//   3. Autofill's own switch is on (plugins/autofill-switch.ts switchedOff; a failure to read it counts as Off). Off
//      unregisters the script and gives back each listed site's own grant, but a page already open keeps its script until
//      its next load, and a broad grant the user chose in Chrome's own menu ("On all sites") stays, so the list and the
//      grant alone would still let that page's message through;
//   4. this worker start's storage gate (the content script cannot run without it either);
//   5. the frame's host and the top page's host are both sites the user turned on, and Chrome grants each its pattern now.
// Nothing here opens the vault, counts as activity (sk_session's lastActive is never touched) or writes anything but the
// badge and the tooltip; nothing is logged.
//
// With the in-page suggestion's release gate open (scripts/suggest-ui.mjs; AUTOFILL2 patch 4a, AUTOFILL2-NOTES.md §12), and
// a `page` given, the channel is ./content-page.ts's instead: `cand` is answered, and the suggestion's click, `open`, opens
// Sixkey's own surface. With the gate closed, this module is patches 1 to 3's as it was (the build folds the gate).
import { readList, siteGranted } from "./autofill-sites";
import { contentSender, contentType } from "./sender-policy";
import { pageChannel } from "./content-page";

// The release gate, as the build's define gives it: a constant of this module, folded by the build.
declare const __SUGGEST_UI__: boolean;
const SUGGEST_UI = typeof __SUGGEST_UI__ === "boolean" && __SUGGEST_UI__;

/** Messages a tab's content script may send in a minute (AUTOFILL2-PLAN §4.1). */
export const CAND_PER_MINUTE = 10;

export type ChannelDeps = {
  selfId: string;
  /** Whether Autofill is switched off (platform/plugins/autofill-switch.ts switchedOff). */
  off(): Promise<boolean>;
  /** This worker start's storage gate (platform/storage-access.ts closedBy). */
  gate(): Promise<boolean>;
  /** The sites the user turned on. */
  sites(): Promise<string[]>;
  /** Whether Chrome grants this site's pattern now. */
  granted(host: string): Promise<boolean>;
  /** The toolbar badge and tooltip of this tab. */
  badge(tabId: number): Promise<void>;
  now?(): number;
  /** The in-page suggestion's worker end (./content-page.ts), with its release gate open only. */
  page?: PageDeps;
};

/** What the worker needs for the in-page suggestion (AUTOFILL2 patch 4a; ./content-page.ts, ./content-page-worker.ts). */
export type PageDeps = {
  /** The Fill shortcut as the user set it ("" for none). */
  key(): Promise<string>;
  /** The documents answered `show: true` (platform/page-open.ts noteShown / takeShown). */
  shown: { note(doc: string, now: number): Promise<void>; take(doc: string, now: number): Promise<boolean> };
  /** A token of the tab's bucket (platform/page-open.ts takeToken). */
  token(tabId: number, now: number): Promise<boolean>;
  /** The tab is the active tab of a focused window (platform/autofill.ts inFront). */
  front(tabId: number): Promise<boolean>;
  /** The lock epoch now. */
  epoch(): Promise<number>;
  /** The request R v2 written (platform/fill-request.ts putRequest). */
  request(o: { tabId: number; windowId: number; url: string; epoch: number; doc: string }): Promise<unknown>;
  /** What the toolbar icon opens, as this worker knows it now (no read). */
  opens(): "popup" | "panel" | undefined;
  /** The side panel of that window, called synchronously in the message's own task, never awaited. */
  openPanel(windowId: number): void;
  /** The popup, in that window. */
  openPopup(windowId: number): Promise<void>;
};

/** What a message led to: the badge, the surface, or nothing (and why, for the tests). */
export type ChannelOutcome =
  | "badge"
  | "ignored"
  | "limited"
  | "off"
  | "gated"
  | "not-on"
  // `cand` with the gate open only (./content-page.ts): its record not written, or its deadline passed (no answer)
  | "unnoted"
  | "deadline"
  // `open` only (./content-page.ts):
  | "opened"
  | "frame"
  | "unseen"
  | "bucket"
  | "behind"
  | "norequest";
/** The answer to `cand` with the gate open. */
export type CandAnswer = { show: true; key: string } | { show: false };
/** The channel: a content script's message and its sender, as the browser gives them; `reply`, `cand`'s answer (gate open). */
export type Channel = (msg: unknown, sender: unknown, reply?: (a: CandAnswer) => void) => Promise<ChannelOutcome>;

export function createContentChannel(d: ChannelDeps): Channel {
  const recent = new Map<number, number[]>();
  const limited = (tabId: number, now: number) => {
    const xs = (recent.get(tabId) ?? []).filter((t) => t >= 0 && now - t < 60_000);
    const over = xs.length >= CAND_PER_MINUTE;
    if (!over) xs.push(now);
    recent.set(tabId, xs);
    return over;
  };
  // the gate open and the suggestion's worker end given: its channel (the same sender, rate limit and checks, and more)
  if (SUGGEST_UI && d.page) return pageChannel(d, d.page, limited);
  return async (msg, sender) => {
    if (contentType(msg) === null) return "ignored";
    const s = contentSender(sender as Parameters<typeof contentSender>[0], d.selfId);
    if (s === null) return "ignored";
    if (limited(s.tabId, (d.now ?? Date.now)())) return "limited";
    if (await d.off().catch(() => true)) return "off";
    if (!(await d.gate())) return "gated";
    const list = await d.sites();
    for (const host of new Set([s.host, s.topHost]))
      if (!list.includes(host) || !(await d.granted(host))) return "not-on";
    await d.badge(s.tabId);
    return "badge";
  };
}

/** The parts of chrome.* the badge uses. */
export type BadgeChrome = {
  action: {
    setBadgeText(o: { tabId: number; text: string }): Promise<void>;
    setBadgeBackgroundColor(o: { tabId: number; color: string }): Promise<void>;
    setTitle(o: { tabId: number; title: string }): Promise<void>;
  };
  commands: { getAll(): Promise<{ name?: string; shortcut?: string }[]> };
  i18n: { getMessage(key: string, subs?: string[]): string };
};

/**
 * "1" on this tab's toolbar icon, and the tooltip naming the `fill` shortcut as the user set it (or saying to open Sixkey,
 * when it has none). Tab-specific: Chrome drops it when the tab loads another page.
 */
export async function showCanFill(tabId: number, c: BadgeChrome = chrome as unknown as BadgeChrome): Promise<void> {
  const key = (await c.commands.getAll().catch(() => [])).find((x) => x.name === "fill")?.shortcut ?? "";
  const title = key
    ? c.i18n.getMessage("afCanFill", [key]) || `Sixkey can fill the code here: press ${key}`
    : c.i18n.getMessage("afCanFillOpen") || "Sixkey can fill the code here: open Sixkey";
  await Promise.allSettled([
    c.action.setBadgeText({ tabId, text: "1" }),
    c.action.setBadgeBackgroundColor({ tabId, color: "#1d5fbf" }),
    c.action.setTitle({ tabId, title }),
  ]);
}

/** The worker's channel over the real APIs (src/background/sw.ts). */
export function workerChannel(selfId: string, gate: () => Promise<boolean>, off: () => Promise<boolean>) {
  return createContentChannel({
    selfId,
    off,
    gate,
    sites: () => readList(),
    granted: (host) => siteGranted(host),
    badge: (tabId) => showCanFill(tabId),
  });
}
