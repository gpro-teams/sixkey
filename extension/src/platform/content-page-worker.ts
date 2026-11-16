// The in-page suggestion's worker end over the real APIs (AUTOFILL2 patch 4a; docs/design/notes/AUTOFILL2-NOTES.md §12):
// what sw.ts builds its content channel from when the suggestion's release gate is open (scripts/suggest-ui.mjs). With the
// gate closed sw.ts builds patch 3's channel (./content-channel.ts workerChannel) and none of this is in the build.
import { readList, siteGranted } from "./autofill-sites";
import { createContentChannel, showCanFill, type PageDeps } from "./content-channel";
import { putRequest, type ReqArea } from "./fill-request";
import { noteShown, takeShown, takeToken, type OpenArea } from "./page-open";

/** The parts of chrome.* the in-page suggestion's worker end uses. */
export type PageChrome = {
  storage: { session: ReqArea & OpenArea };
  commands: { getAll(): Promise<{ name?: string; shortcut?: string }[]> };
  action: { openPopup?(o?: { windowId?: number }): Promise<void> };
  sidePanel?: { open?(o: { windowId: number }): Promise<void> };
};
export type PageWiring = {
  front: (tabId: number) => Promise<boolean>;
  epoch: () => Promise<number>;
  opens: () => "popup" | "panel" | undefined;
};

/** The suggestion's worker end: the records, the request R v2, the surfaces. */
export function workerPage(o: PageWiring, c: PageChrome = chrome as unknown as PageChrome): PageDeps {
  const area = c.storage.session;
  return {
    key: async () => (await c.commands.getAll()).find((x) => x.name === "fill")?.shortcut ?? "",
    shown: { note: (doc, now) => noteShown(area, doc, now), take: (doc, now) => takeShown(area, doc, now) },
    token: (tabId, now) => takeToken(area, tabId, now),
    front: o.front,
    epoch: o.epoch,
    request: (r) => putRequest(area, { ...r, why: "page" }),
    opens: o.opens,
    openPanel: (windowId) => {
      try {
        void c.sidePanel?.open?.({ windowId }).catch(() => undefined);
      } catch {
        /* no side panel here: the badge says to open Sixkey */
      }
    },
    openPopup: async (windowId) => {
      await c.action.openPopup?.({ windowId });
    },
  };
}

/** The worker's content channel with the suggestion: patch 3's dependencies, and the suggestion's worker end. */
export function workerPageChannel(
  selfId: string,
  gate: () => Promise<boolean>,
  off: () => Promise<boolean>,
  o: PageWiring,
) {
  return createContentChannel({
    selfId,
    off,
    gate,
    sites: () => readList(),
    granted: (host) => siteGranted(host),
    badge: (tabId) => showCanFill(tabId),
    page: workerPage(o),
  });
}
