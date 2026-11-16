// AUTOFILL2 patch 4a (docs/design/notes/AUTOFILL2-NOTES.md §12): the Fill chunk (src/popup/main/Fill.tsx) with a page's fill
// request (R v2, the in-page suggestion's click) for here, drawn into a minimal document over a stand-in chrome.*, as in
// autofill2-popup-front.test.ts, on a fake clock:
//   - offered (Sixkey already unlocked): "Press Enter to fill the code on <host>"; a press during the surface's input delay
//     does nothing; after it, the press takes R and fills the document the user clicked, its top frame, or nothing; the
//     popup then closes;
//   - a request that can no longer be taken (another page in front now) says so and fills nothing; the next press is an
//     ordinary one (the review's S-2);
//   - resumed after an unlock that handed it on: filled into its document, once;
//   - the focus is not moved while the user is busy in the surface (the review's M-2).
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "../../src/core/vault/model";
import { installMiniDom, MiniElement } from "../helpers/mini-dom";
import { TEST_CODE } from "../helpers/gate";

const URL1 = "https://example.com/login";
const DOC = "0123456789ABCDEF0123456789ABCDEF";
const OTHER = "FEDCBA9876543210FEDCBA9876543210";
const A = "a".repeat(32);
let dom: ReturnType<typeof installMiniDom>;
let root: MiniElement;
const g = globalThis as Record<string, unknown>;
const entry = (): Entry =>
  ({
    id: "e1",
    createdAt: 0,
    type: "totp",
    issuer: "Example",
    label: "alice",
    secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    domains: ["example.com"],
    hlc: "",
    order: "a",
    phlc: "",
  }) as Entry;
const texts = () => root.all((e) => !!e.textContent).map((e) => e.textContent);
const BOX = { t: "0123456789abcdef", k: 0 as const, n: 6, s: 70, sent: false, weak: false, lab: "" };
const request = (o: { doc?: string; at?: number } = {}) => ({
  v: 2,
  nonce: A,
  tabId: 7,
  windowId: 1,
  url: URL1,
  host: "example.com",
  at: o.at ?? Date.now(),
  epoch: 0,
  why: "page",
  doc: o.doc ?? DOC,
});

type Frames = { frameId: number; documentId: string; boxes?: (typeof BOX)[] }[];
let session: Map<string, unknown>;
/** storage.session's onChanged listeners, and the test's way to fire them. */
let changed: ((c: Record<string, unknown>) => void)[];
const fire = (c: Record<string, unknown>) => changed.forEach((f) => f(c));
let frontUrl: string;
let frontTab: number;
let closed: number;
let focusAsked: { n: number };
function browser(frames: Frames = [{ frameId: 0, documentId: DOC }]) {
  const fills: { documentIds?: string[] }[] = [];
  g.chrome = {
    commands: { getAll: async () => [] },
    tabs: {
      query: async () => [{ id: frontTab, url: frontUrl }],
      get: async (id: number) => ({ id, active: true, windowId: 1 }),
    },
    windows: { get: async (id: number) => ({ id, focused: true }) },
    scripting: {
      executeScript: vi.fn(async (c: { files?: string[]; args?: unknown[]; target: { documentIds?: string[] } }) => {
        if (c.files) return [];
        if (c.target.documentIds) {
          fills.push({ documentIds: c.target.documentIds });
          return [{ result: { ok: true, how: "single" } }];
        }
        return frames.map((f) => ({
          ...f,
          // a frame of the same site under the top page: its ancestors end at the top page (candidatesFor, M4)
          result: {
            o: "https://example.com",
            a: f.frameId === 0 ? [] : ["https://example.com"],
            top: f.frameId === 0,
            c: f.boxes ?? [BOX],
            x: 0,
            z: 0,
          },
        }));
      }),
    },
    storage: {
      local: {
        get: async () => ({}),
        onChanged: { addListener: () => undefined, removeListener: () => undefined },
        setAccessLevel: async () => undefined,
      },
      session: {
        get: async (k: string) => (session.has(k) ? { [k]: structuredClone(session.get(k)) } : {}),
        set: async () => undefined,
        remove: async (k: string) => void session.delete(k),
        setAccessLevel: async () => undefined,
        onChanged: {
          addListener: (f: (c: Record<string, unknown>) => void) => void changed.push(f),
          removeListener: () => undefined,
        },
      },
    },
  };
  return fills;
}

beforeEach(() => {
  vi.resetModules();
  g.__SUGGEST_UI__ = true; // the in-page suggestion's release gate open (the build's define); closed: the last describe
  vi.useFakeTimers({ toFake: ["Date", "performance"], now: Math.floor(1_700_000_000_000 / 30_000) * 30_000 + 10_000 });
  dom = installMiniDom();
  session = new Map();
  changed = [];
  frontUrl = URL1;
  frontTab = 7;
  closed = 0;
  const focus = (focusAsked = { n: 0 }); // this test's own: a timer left by an earlier test counts into its own
  const proto = MiniElement.prototype as unknown as Record<string, unknown>;
  proto.querySelectorAll = function (this: MiniElement, sel: string) {
    return this.all((e) => e !== this && e.localName === sel);
  };
  proto.querySelector = () => null;
  proto.contains = function (this: MiniElement, n: MiniElement) {
    return this.all((e) => e === n).length > 0;
  };
  Object.assign(dom.doc, {
    documentElement: dom.doc.createElement("html"),
    querySelector: (sel: string) => (sel.includes("fillbtn") && focus.n++, null),
    getElementById: () => null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    hasFocus: () => true,
  });
  root = dom.doc.body;
  g.window = Object.assign(globalThis, {
    document: dom.doc,
    innerHeight: 600,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    close: () => void closed++,
  });
  g.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
});
afterEach(() => {
  act(() => render(null, root as unknown as Element));
  dom.undo();
  vi.useRealTimers();
  vi.doUnmock("../../src/platform/plugins/autofill-gate");
  delete g.chrome;
  delete g.localStorage;
  delete g.__SUGGEST_UI__;
  delete (g as { close?: unknown }).close;
});

const settle = () =>
  act(async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 5));
  });
const tick = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

async function draw(nonce: string | null = null) {
  vi.doMock("../../src/platform/plugins/autofill-gate", () => ({ gatedCode: () => TEST_CODE }));
  const i18n = await import("../../src/ui/i18n");
  i18n.setLangChoice("en");
  await i18n.loadCatalog(async () => ({
    cancel: { message: "Cancel" },
    afSugGo: { message: "Press Enter to fill the code on $1" },
  }));
  const { FillBar, RowFill, Resume } = await import("../../src/popup/main/Fill");
  const rows = [{ entry: entry(), tier: "registered" as const }];
  await act(async () => {
    render(
      h(
        "div",
        null,
        h(FillBar, { host: "example.com", rows }),
        h(Resume, { nonce, ready: true, rows: rows as never }),
        h(RowFill, { entry: entry(), first: true }),
      ),
      root as unknown as Element,
    );
  });
  await settle();
}
const button = () =>
  root.all((e) => e.localName === "button" && e.getAttribute("class")?.includes("fillbtn") === true)[0]!;
const press = async () => {
  await act(async () => void button().dispatch("click", {}));
  await settle();
};

describe("a page's request offered in an unlocked surface", () => {
  it("says what Enter will do; a press during the input delay does nothing; after it, that document is filled and the popup closes", async () => {
    session.set("sk_fill_req", request());
    const fills = browser();
    await draw();
    expect(texts()).toContain("Press Enter to fill the code on example.com");
    expect(button().getAttribute("aria-disabled")).toBe("true");
    await press(); // at about 0.1 s: inside the delay
    expect(fills).toEqual([]);
    expect(session.has("sk_fill_req")).toBe(true);
    await tick(700);
    await press();
    expect(fills).toEqual([{ documentIds: [DOC] }]);
    expect(session.has("sk_fill_req")).toBe(false); // taken
    expect(texts()).toContain("Code filled. Continue on the page.");
    await act(async () => void (await new Promise((r) => setTimeout(r, 1300))));
    expect(closed).toBe(1);
  });

  it("another page in front now: the press says so and fills nothing; the next press is an ordinary one (S-2)", async () => {
    session.set("sk_fill_req", request());
    const fills = browser();
    await draw();
    await tick(700);
    frontUrl = "https://example.com/login?step=2"; // the page moved on since the click
    await press();
    expect(fills).toEqual([]);
    expect(texts().some((x) => x?.startsWith("Not filled:"))).toBe(true);
    await press();
    expect(fills).toHaveLength(1); // ordinary: the page in front now, as the user asked in Sixkey
  });

  it("the document clicked is gone (a reload): nothing is filled anywhere else", async () => {
    session.set("sk_fill_req", request({ doc: OTHER }));
    const fills = browser();
    await draw();
    await tick(700);
    await press();
    expect(fills).toEqual([]);
    expect(texts()).toContain("The page changed. Try again.");
  });

  it("that document only in its top frame: the same document ID in another frame is not it", async () => {
    session.set("sk_fill_req", request());
    const fills = browser([
      { frameId: 0, documentId: OTHER },
      { frameId: 3, documentId: DOC },
    ]);
    await draw();
    await tick(700);
    await press();
    expect(fills).toEqual([]);
    expect(texts()).toContain("The page changed. Try again.");
  });

  it("the focus moves to Fill when the user is not busy in the surface", async () => {
    session.set("sk_fill_req", request());
    browser();
    await draw();
    expect(focusAsked.n).toBeGreaterThan(0);
  });

  it("but not while the user is busy in it (a key or a click within the delay: the review's M-2)", async () => {
    // an earlier test's focus retries (10 × 100 ms, real timers, on the global document) are let run out first
    await new Promise((r) => setTimeout(r, 1100));
    focusAsked.n = 0;
    session.set("sk_fill_req", request());
    browser();
    const delay = await import("../../src/popup/page-delay");
    delay.onPress({ type: "keydown", key: "a", target: { localName: "input", type: "text" } });
    await draw();
    expect(focusAsked.n).toBe(0);
    expect(texts()).toContain("Press Enter to fill the code on example.com");
  });
});

describe("a page's request that arrives at a surface already open (the side panel's case)", () => {
  it("starts the input delay again: a press at once does nothing, one 600 ms later fills", async () => {
    const fills = browser();
    const delay = await import("../../src/popup/page-delay");
    delay.startPageDelay(); // the surface's document started here (App's call)
    await tick(5000); // long open: its own delay is over
    expect(delay.pageDelay.ready()).toBe(true);
    session.set("sk_fill_req", request()); // written after the surface started
    await draw();
    expect(texts()).toContain("Press Enter to fill the code on example.com");
    await press();
    expect(fills).toEqual([]);
    await tick(700);
    await press();
    expect(fills).toEqual([{ documentIds: [DOC] }]);
  });
});

describe("a page's request resumed after an unlock that handed it on", () => {
  it("fills its document once, with no press and no delay (the unlock was the press)", async () => {
    session.set("sk_fill_req", request());
    const fills = browser();
    await draw(A);
    expect(fills).toEqual([{ documentIds: [DOC] }]);
    expect(session.has("sk_fill_req")).toBe(false);
  });
});

const BOX2 = { ...BOX, t: "fedcba9876543210", s: 65 };
const BOX3 = { ...BOX, t: "1111222233334444", s: 60 };
const ghosts = () => root.all((e) => e.localName === "button" && e.getAttribute("class") === "btn sm ghost");

describe("a press that begins inside the input delay does not count when it ends after it", () => {
  it("Fill pressed down at 300 ms and let go at 1,000 ms fills nothing; the next press fills", async () => {
    session.set("sk_fill_req", request());
    const fills = browser();
    const delay = await import("../../src/popup/page-delay");
    await draw();
    await tick(300);
    delay.onPress({ type: "pointerdown", target: { localName: "button" } }); // down inside the delay (it re-arms it)
    await tick(700); // up at 1,000 ms, the delay over
    await press();
    expect(fills).toEqual([]);
    delay.onPress({ type: "pointerdown", target: { localName: "button" } }); // a new press, begun after the delay
    await press();
    expect(fills).toEqual([{ documentIds: [DOC] }]);
  });
});

describe("the binding goes with its request (the review's SHOULD 3)", () => {
  it("after its minute: the line goes, and the next press is an ordinary one that fills", async () => {
    session.set("sk_fill_req", request());
    const fills = browser();
    await draw();
    await tick(61_000);
    await act(async () => void 0);
    await press();
    expect(fills).toEqual([{ documentIds: [DOC] }]);
    expect(texts().some((x) => x?.startsWith("Not filled:"))).toBe(false);
  });

  it("replaced by another request (the shortcut's): unbound; the next press is ordinary and takes nothing", async () => {
    session.set("sk_fill_req", request());
    const fills = browser();
    await draw();
    const shortcut = { ...request(), v: 1, why: "locked", nonce: "b".repeat(32) } as Record<string, unknown>;
    delete shortcut.doc;
    session.set("sk_fill_req", shortcut);
    await act(async () => fire({ sk_fill_req: {} }));
    await settle();
    expect(texts()).not.toContain("Press Enter to fill the code on example.com");
    await press(); // at once: no page's delay any more
    expect(fills).toHaveLength(1);
    expect(session.get("sk_fill_req")).toEqual(shortcut); // an ordinary press takes no request
  });

  it("a lock since: unbound", async () => {
    session.set("sk_fill_req", request());
    browser();
    await draw();
    session.set("sk_lock_epoch", 1);
    await act(async () => fire({ sk_lock_epoch: {} }));
    await settle();
    expect(texts()).not.toContain("Press Enter to fill the code on example.com");
  });

  it("the side panel, another tab in front: unbound; only the page under it changing keeps it (S-2)", async () => {
    const tabs: (() => void)[] = [];
    const { surface } = await import("../../src/popup/surface");
    surface.panel = {
      watchTab: (f: () => void) => (tabs.push(f), () => undefined),
      shown: () => undefined,
      attach: () => () => undefined,
    } as never;
    session.set("sk_fill_req", request());
    browser();
    await draw();
    frontUrl = "https://example.com/login?step=2"; // the same tab, another address
    for (const f of tabs) f();
    await settle();
    expect(texts()).toContain("Press Enter to fill the code on example.com");
    frontTab = 8; // another tab in front
    for (const f of tabs) f();
    await settle();
    expect(texts()).not.toContain("Press Enter to fill the code on example.com");
  });
});

describe("the binding holds on the 'which box?' path (the review's SHOULD 4)", () => {
  it("the boxes offered are the clicked document's top frame's only, and the one chosen fills that document", async () => {
    session.set("sk_fill_req", request());
    const fills = browser([
      { frameId: 0, documentId: DOC, boxes: [BOX, BOX2] }, // two boxes a press must choose between
      { frameId: 3, documentId: OTHER, boxes: [BOX3] }, // a box of another document, in a frame
    ]);
    await draw();
    await tick(700);
    await press();
    expect(fills).toEqual([]);
    expect(ghosts()).toHaveLength(2); // not the frame's box
    await act(async () => void ghosts()[1]!.dispatch("click", {}));
    await settle();
    expect(fills).toEqual([{ documentIds: [DOC] }]);
  });
});

describe("the binding holds on the weak-box path (the 4a-r2 review's N-1)", () => {
  it("a weak box in another frame, offered while the clicked document's top frame has a box: pressed, nothing is filled", async () => {
    session.set("sk_fill_req", request());
    const UNFIT = { ...BOX, t: "3333444455556666", n: 4 }; // takes 4 digits: no good box, and no weak one, for a 6-digit code
    const WEAK = { ...BOX, t: "7777888899990000", weak: true };
    const fills = browser([
      { frameId: 0, documentId: DOC, boxes: [UNFIT] }, // the clicked document's top frame
      { frameId: 3, documentId: OTHER, boxes: [WEAK] }, // another document, in a frame
    ]);
    await draw();
    await tick(700);
    const weakButton = root.all((e) => e.localName === "button" && e.textContent === "Fill the box that has focus")[0]!;
    expect(weakButton).toBeDefined();
    await act(async () => void weakButton.dispatch("click", {}));
    await settle();
    expect(fills).toEqual([]); // the chosen box is not in the clicked document's top frame
    expect(texts()).toContain("The page changed. Try again.");
  });
});

describe("the gate closed (a store build until the flip)", () => {
  it("a request v2 is no request: no line, not drawn held, and a press at once is an ordinary fill that takes nothing", async () => {
    delete g.__SUGGEST_UI__;
    session.set("sk_fill_req", request());
    const fills = browser();
    await draw();
    expect(texts()).not.toContain("Press Enter to fill the code on example.com");
    expect(button().getAttribute("aria-disabled")).toBeNull();
    await press();
    expect(fills).toHaveLength(1);
    expect(session.has("sk_fill_req")).toBe(true);
  });
});
