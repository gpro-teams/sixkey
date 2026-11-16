// The worker's end of the content script's messages with the in-page suggestion's release gate open (scripts/suggest-ui.mjs;
// AUTOFILL2 patch 4a, docs/design/notes/AUTOFILL2-NOTES.md §12): ./content-channel.ts hands its messages here when the gate
// is open and the suggestion's worker end is given (sw.ts, through ./content-page-worker.ts). A build with the gate closed
// calls none of this, and has none of it.
//
// The same sender, rate limit and checks as patch 3's channel and AFSWITCH's, and then:
//   - `cand` is answered: `{show: true, key}` (the content script may draw its suggestion next to the box; `key` is the
//     Fill shortcut as set) for the top frame, `{show: false}` for anything else. The answer is the same whether Sixkey is
//     locked or not and whatever it holds: nothing here opens the vault. `show: true` is answered only once the document
//     is recorded in storage.session (platform/page-open.ts), then in this worker's memory; within CAND_MS or not at all;
//   - `open` (the user's click on that suggestion) opens Sixkey's own surface for that document, once. In this order: the
//     sender; the shared rate limit; the top frame; then, without awaiting anything (sidePanel.open needs the click's
//     gesture, which no await keeps), in panel mode the side panel, only for a document this worker has answered
//     `show: true` and not opened yet (a worker started since has no such record in memory: that click gets the badge,
//     and the icon opens the panel with the request offered). Then, awaited: the switch, the storage gate, the list and
//     the grant; the document recorded `show: true` and not opened (marked opened now); a token of the tab's bucket; the
//     tab in front of a focused window (the review's M6); the lock epoch and the request R v2 for that document
//     (platform/fill-request.ts), written BEFORE the popup opens; in popup mode the popup, in that tab's window; the badge.
//     `open` is never answered.
import type { CandAnswer, Channel, ChannelDeps, ChannelOutcome, PageDeps } from "./content-channel";
import { bounded } from "./bounded";
import { contentSender, contentType } from "./sender-policy";

/** How long a document answered `show: true` may still open Sixkey, and how many such documents are kept. */
export const SHOWN_MS = 10 * 60_000;
export const SHOWN_MAX = 64;
/**
 * The worker's deadline on `cand` (AUTOFILL2-NOTES.md §13.8, the 4b review's S-1): answered within it, or not at all.
 * One lost browser call would otherwise keep the answer back for as long as the content script's channel lives. The path
 * is eight calls in a row, each about a millisecond on an idle machine; at a load average of 600 to 800 they took up to
 * 0.6 s each and the worker stalled 12 s once, and a 3 s deadline turned those slow answers into none (§13.8). 15 s
 * still answers a slow machine. Longer than a storage call's bound twice (page-open.ts STORE_MS: the lock goes first),
 * shorter than the content script's wait (src/inject/suggest-arm.ts ASK_MS: it asks again at its next look).
 */
export const CAND_MS = 15_000;

export function pageChannel(d: ChannelDeps, page: PageDeps, limited: (tabId: number, now: number) => boolean): Channel {
  // the documents this worker answered `show: true`, and whether each has opened (memory: the synchronous panel open's
  // only record; storage.session's is the one every `open` is checked against)
  const shownHere = new Map<string, { at: number; opened: boolean }>();
  const remember = (doc: string, at: number) => {
    const opened = shownHere.get(doc)?.opened ?? false;
    shownHere.delete(doc); // to the end: the oldest first out, so a document answered again keeps its `opened`
    shownHere.set(doc, { at, opened });
    for (const [k, v] of shownHere) if (shownHere.size > SHOWN_MAX || at - v.at >= SHOWN_MS) shownHere.delete(k);
  };
  /** The switch, the storage gate, the list and the grant: null when all say yes, else why not. */
  const checks = async (s: { host: string; topHost: string }): Promise<ChannelOutcome | null> => {
    if (await d.off().catch(() => true)) return "off";
    if (!(await d.gate())) return "gated";
    const list = await d.sites();
    for (const host of new Set([s.host, s.topHost]))
      if (!list.includes(host) || !(await d.granted(host))) return "not-on";
    return null;
  };
  return async (msg, sender, reply) => {
    const type = contentType(msg);
    if (type === null) return "ignored";
    const s = contentSender(sender as Parameters<typeof contentSender>[0], d.selfId);
    if (s === null) return "ignored";
    const now = (d.now ?? Date.now)();
    // `cand` is answered, always (no-show for every refusal)
    const answer = (a: CandAnswer) => void (type === "sk-af-cand" && reply?.(a));
    if (limited(s.tabId, now)) return (answer({ show: false }), "limited");
    if (type === "sk-af-open") {
      // ---- the synchronous part: nothing is awaited before the panel (its gesture) ----
      if (s.frameId !== 0) return "frame";
      const mem = shownHere.get(s.documentId);
      const known = mem !== undefined && !mem.opened && now - mem.at < SHOWN_MS;
      if (known) mem.opened = true;
      if (known && page.opens() === "panel") page.openPanel(s.windowId);
      // ---- then the checks, each awaited ----
      const no = await checks(s);
      if (no) return no;
      if (!(await page.shown.take(s.documentId, now).catch(() => false))) return "unseen";
      if (!(await page.token(s.tabId, now).catch(() => false))) return d.badge(s.tabId).then(() => "bucket");
      if (!(await page.front(s.tabId).catch(() => false))) return "behind";
      const url = (sender as { tab: { url: string } }).tab.url; // contentSender checked it is the tab's address
      const epoch = await bounded(page.epoch()).catch(() => -1); // (AF-BOUND: a lost answer is no request)
      if (epoch < 0) return "norequest";
      const r = await page
        .request({ tabId: s.tabId, windowId: s.windowId, url, epoch, doc: s.documentId })
        .catch(() => null);
      if (!r) return "norequest";
      if (page.opens() !== "panel") await page.openPopup(s.windowId).catch(() => undefined);
      await d.badge(s.tabId);
      return "opened";
    }
    // ---- `cand`: answered within CAND_MS, or not at all (the content script asks again at its next look) ----
    let late = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<ChannelOutcome>((done) => {
      timer = setTimeout(() => {
        late = true;
        done("deadline");
      }, CAND_MS);
    });
    const say = (a: CandAnswer) => void (!late && answer(a));
    const work = (async (): Promise<ChannelOutcome> => {
      const no = await checks(s);
      if (no) return (say({ show: false }), no);
      await d.badge(s.tabId);
      if (s.frameId !== 0) return (say({ show: false }), "badge");
      // `show: true` only once the document's record is written (an `open` is checked against it): its write failed, or
      // came too late, and nothing is answered, nothing kept in memory
      if (
        !(await page.shown.note(s.documentId, now).then(
          () => !late,
          () => false,
        ))
      )
        return "unnoted";
      remember(s.documentId, now);
      say({ show: true, key: await page.key().catch(() => "") });
      return "badge";
    })();
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
}
