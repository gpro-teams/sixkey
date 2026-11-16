// Where the Sync section sits in the settings page (src/options/SyncHost.tsx, SHORT-SETTINGS-NOTES.md §3): its code
// arrives after the click on the rail's link, when the empty frame's heading already has the focus, so the focus goes to
// the new heading (and is not taken when nobody had it); and what is typed in its views is dropped, by drawing them again,
// each time another leaf is shown. The section itself is replaced by a stand-in here; the real browser is
// short-settings.spec.ts's. Rendered by Preact into a minimal document (test/helpers/mini-dom.ts).
import { h, render, type ComponentType } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom, type MiniDocument, type MiniElement } from "../helpers/mini-dom";

const sync = vi.hoisted(() => ({ release: () => undefined as void }));
vi.mock("../../src/options/sync/index", () => ({
  prepare: () => new Promise<void>((r) => (sync.release = r)),
  SyncSection: ({ wiped }: { wiped?: number }) =>
    h(
      "section",
      { id: "sync" },
      h("h2", { id: "sync-h2", tabIndex: -1 }, "Sync"),
      h("span", { id: "wiped" }, String(wiped)),
    ),
}));

let dom: ReturnType<typeof installMiniDom>;
let doc: MiniDocument;
let root: MiniElement;
let SyncHost: ComponentType<{ ctx: never; onRail: () => void; shown?: boolean }>;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("__SYNC_UI__", true);
  vi.stubGlobal("location", { hash: "#sync" });
  vi.stubGlobal("chrome", { storage: { local: { get: async () => ({}) } } });
  dom = installMiniDom();
  doc = dom.doc;
  root = doc.body;
  Object.assign(doc, {
    querySelector: (sel: string) => (sel === "#sync h2" ? root.byId("sync-h2") : null),
  });
  (Object.getPrototypeOf(root) as { contains: (n: unknown) => boolean }).contains = function (this: MiniElement, n) {
    return n === this || this.all((e) => e === n).length > 0;
  };
  ({ SyncHost } = (await import("../../src/options/SyncHost")) as unknown as { SyncHost: typeof SyncHost });
});
afterEach(() => {
  act(() => render(null, root as unknown as Element));
  dom.undo();
  vi.unstubAllGlobals();
});

const put = (shown: boolean) =>
  act(() => render(h(SyncHost, { ctx: {} as never, onRail: () => undefined, shown }), root as unknown as Element));
const tick = (ms = 20) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
/** The section's code arrives: the import is made, then released. */
const loaded = async () => {
  await tick(); // the dynamic import is made, and `prepare` is waiting
  await act(async () => {
    sync.release();
    await new Promise((r) => setTimeout(r, 0));
  });
  await tick(0);
};

describe("SyncHost", () => {
  it("the focus the empty frame's heading had goes to the section's heading when it replaces the frame", async () => {
    put(true);
    const frame = root.all((e) => e.localName === "h2")[0]!;
    expect(root.byId("sync-h2")).toBeNull(); // not loaded yet
    act(() => frame.focus()); // the page's focus move on the switch
    await tick(); // the import is made
    await loaded();
    expect(root.byId("sync-h2")).not.toBeNull();
    expect(doc.activeElement).toBe(root.byId("sync-h2"));
  });

  it("nothing takes the focus when nobody had it in the frame", async () => {
    put(true);
    await loaded();
    expect(root.byId("sync-h2")).not.toBeNull();
    expect(doc.activeElement).toBeNull();
  });

  it("each time another leaf is shown the section is told, so its views are drawn again without what was typed", async () => {
    put(true);
    await loaded();
    expect(root.byId("wiped")!.textContent).toBe("0");
    put(false);
    expect(root.byId("wiped")!.textContent).toBe("1");
    put(true);
    expect(root.byId("wiped")!.textContent).toBe("1"); // coming back wipes nothing more
    put(false);
    expect(root.byId("wiped")!.textContent).toBe("2");
  });
});
