// AUTOFILL2 patch 4a (docs/design/notes/AUTOFILL2-NOTES.md §12): the worker's real wiring (src/background/sw.ts over the
// fake chrome.* of sw-world.ts) for the in-page suggestion. With the release gate's define (stood in for by a global): the
// content script's `cand` is answered, and its `open` writes R v2 and opens the popup in that tab's window. Without it:
// `cand` keeps no channel open and `open` is no message at all.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SITES_KEY } from "../../src/platform/autofill-sites";
import { FILL_REQ_KEY } from "../../src/platform/fill-request";
import { loadWorker, unload, wait } from "../helpers/sw-world";

const SELF_ID = "abcdefghijklmnopabcdefghijklmnop";
const DOC = "0123456789ABCDEF0123456789ABCDEF";
const list = (...hosts: string[]) => ({ [SITES_KEY]: { v: 1, hosts } });
const sender = (frameId = 0) => ({
  id: SELF_ID,
  url: "https://github.com/sessions/two-factor",
  origin: "https://github.com",
  frameId,
  documentId: DOC,
  documentLifecycle: "active",
  tab: { id: 7, windowId: 1, url: "https://github.com/sessions/two-factor", active: true, incognito: false },
});
// the tab in front of a focused window (inFront)
const front = {
  tabs: { get: async (id: number) => ({ id, active: true, windowId: 1 }) },
  windows: { get: async () => ({ focused: true }) },
};

describe("the worker's wiring of the in-page suggestion", () => {
  afterEach(unload);

  it("gate open: cand answered {show: true, key}; open writes R v2 for that document, then opens the popup", async () => {
    vi.stubGlobal("__SUGGEST_UI__", true);
    const w = await loadWorker({ seedLocal: list("github.com"), grants: ["https://github.com/*"], chrome: front });
    await wait();
    const replies: unknown[] = [];
    const kept = w.send({ type: "sk-af-cand" }, sender(), (r) => void replies.push(r));
    expect(kept.filter((x) => x === true)).toHaveLength(1); // the content listener keeps the channel for the answer
    await wait();
    expect(replies).toEqual([{ show: true, key: "Alt+Shift+F" }]);
    const none: unknown[] = [];
    const k2 = w.send({ type: "sk-af-open" }, sender(), (r) => void none.push(r));
    expect(k2.every((x) => x !== true)).toBe(true); // never answered
    await wait();
    const r = w.session.data.get(FILL_REQ_KEY) as Record<string, unknown> | undefined;
    expect(r).toMatchObject({ v: 2, why: "page", doc: DOC, tabId: 7, windowId: 1, host: "github.com" });
    expect(w.icon).toContainEqual(["openPopup"]);
    expect(none).toEqual([]);
  });

  it("gate open: a frame's cand is answered {show: false}, and its open does nothing", async () => {
    vi.stubGlobal("__SUGGEST_UI__", true);
    const w = await loadWorker({ seedLocal: list("github.com"), grants: ["https://github.com/*"], chrome: front });
    await wait();
    const replies: unknown[] = [];
    w.send({ type: "sk-af-cand" }, sender(2), (r) => void replies.push(r));
    await wait();
    expect(replies).toEqual([{ show: false }]);
    w.send({ type: "sk-af-open" }, sender(2));
    await wait();
    expect(w.session.data.has(FILL_REQ_KEY)).toBe(false);
    expect(w.icon).not.toContainEqual(["openPopup"]);
  });

  it("gate closed: cand keeps no channel open and gets no answer; open is no message (no R, no popup)", async () => {
    const w = await loadWorker({ seedLocal: list("github.com"), grants: ["https://github.com/*"], chrome: front });
    await wait();
    const replies: unknown[] = [];
    const kept = w.send({ type: "sk-af-cand" }, sender(), (r) => void replies.push(r));
    expect(kept.every((x) => x !== true)).toBe(true);
    await wait();
    expect(replies).toEqual([]);
    expect(w.tabBadges.get(7)).toMatchObject({ text: "1" }); // patch 3's badge, as before
    w.send({ type: "sk-af-open" }, sender());
    await wait();
    expect(w.session.data.has(FILL_REQ_KEY)).toBe(false);
    expect(w.icon).not.toContainEqual(["openPopup"]);
  });
});
