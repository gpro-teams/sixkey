// TOTP autofill Stage 2, patch 3, after its verify (BLOCKER-1; docs/design/notes/AUTOFILL2-NOTES.md §9.3 P3-5): which "tab in
// front" rule each fill asks right before its code goes. Chrome's `focused` is the native window's key status, and the
// toolbar popup is a widget of its own that takes the activation, so the browser window under it does not report focused
// while the user is in the popup. So:
//   - the popup's Fill (popup/main/Fill.tsx) asks for the tab in front of its own window (inFrontOfOwnWindow): it fills with
//     that window reported unfocused, and fills nothing when another tab is in front;
//   - the side panel's Fill and the shortcut's fill (fill-command.ts) ask inFront: an unfocused window gets nothing.
// The Fill chunk is drawn into a minimal document (test/helpers/mini-dom.ts) over a stand-in chrome.*, as in
// autofill1-fallbacks.test.ts; the shortcut's fillOnTab is called directly.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "../../src/core/vault/model";
import { installMiniDom, MiniElement } from "../helpers/mini-dom";
import { NOT_OFF, TEST_CODE } from "../helpers/gate";

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

/** The browser: tab 7 in front of window 1 at the page; `focused` is what windows.get says of window 1. */
function browser(o: { focused: boolean; front?: number }) {
  const fills: unknown[] = [];
  g.chrome = {
    commands: { getAll: async () => [] },
    tabs: {
      query: async () => [{ id: o.front ?? 7, url: "https://example.com/login" }],
      get: async (id: number) => ({ id, active: id === (o.front ?? 7), windowId: 1 }),
    },
    windows: { get: async (id: number) => ({ id, focused: o.focused }) },
    scripting: {
      executeScript: vi.fn(async (c: { target?: { documentIds?: string[] }; files?: string[]; args?: unknown[] }) => {
        if (c.files) return [];
        if (c.target?.documentIds) {
          fills.push(c.args);
          return [{ result: { ok: true, how: "single" } }];
        }
        return [
          {
            frameId: 0,
            documentId: "d0",
            result: { o: "https://example.com", a: [], top: true, c: [BOX], x: 0, z: 0 },
          },
        ];
      }),
    },
    storage: {
      local: {
        get: async () => ({}),
        onChanged: { addListener: () => undefined, removeListener: () => undefined },
        setAccessLevel: async () => undefined,
      },
      session: {
        get: async () => ({}),
        set: async () => undefined,
        remove: async () => undefined,
        setAccessLevel: async () => undefined,
        onChanged: { addListener: () => undefined, removeListener: () => undefined },
      },
    },
  };
  return fills;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"], now: Math.floor(1_700_000_000_000 / 30_000) * 30_000 + 10_000 }); // 20 s left: no wait
  dom = installMiniDom();
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
    querySelector: () => null,
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
});

async function pressFill(panel: boolean): Promise<void> {
  if (panel) {
    const { surface } = await import("../../src/popup/surface");
    surface.panel = { watchTab: () => () => undefined, shown: () => undefined, attach: () => () => undefined };
  }
  // the platform's gate, open (its switch, ceiling and log: test/unit/plugins-w1b-gate.test.ts): the front-tab rule is what
  // is tested here
  vi.doMock("../../src/platform/plugins/autofill-gate", () => ({ gatedCode: () => TEST_CODE }));
  const i18n = await import("../../src/ui/i18n");
  i18n.setLangChoice("en");
  await i18n.loadCatalog(async () => ({ cancel: { message: "Cancel" } }));
  const { FillBar, RowFill } = await import("../../src/popup/main/Fill");
  await act(async () => {
    render(
      h(
        "div",
        null,
        h(FillBar, { host: "example.com", rows: [{ entry: entry(), tier: "registered" }] }),
        h(RowFill, { entry: entry(), first: true }),
      ),
      root as unknown as Element,
    );
  });
  const settle = () =>
    act(async () => {
      for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 5));
    });
  await settle();
  expect(texts()).toContain("Code box found on this page");
  const btn = root.all((e) => e.localName === "button" && e.getAttribute("class")?.includes("fillbtn") === true)[0]!;
  await act(async () => void btn.dispatch("click", {}));
  await settle();
}

describe("the toolbar popup: the tab in front of its own window", () => {
  it("fills with the browser window reported unfocused (the popup has the activation)", async () => {
    const fills = browser({ focused: false });
    await pressFill(false);
    expect(fills).toHaveLength(1);
    expect(texts()).toContain("Code filled. Continue on the page.");
  });

  it("fills nothing when its window's front tab is another (the look's tab is no longer in front)", async () => {
    const fills = browser({ focused: true, front: 8 });
    const { fillCand, inFrontOfOwnWindow } = await import("../../src/platform/autofill");
    const cand = {
      frameId: 0,
      documentId: "d0",
      origin: "https://example.com",
      top: "https://example.com",
      domain: "example.com",
      found: BOX,
    };
    expect(await fillCand(7, entry(), cand, { front: inFrontOfOwnWindow, code: TEST_CODE })).toEqual({
      k: "failed",
      r: "tab",
    });
    expect(fills).toEqual([]);
  });
});

describe("the side panel and the shortcut: the active tab of the focused window", () => {
  it("the side panel's Fill with the window unfocused: nothing filled, and it says so", async () => {
    const fills = browser({ focused: false });
    await pressFill(true);
    expect(fills).toEqual([]);
    expect(texts()).toContain("Not filled: you switched tabs while Sixkey waited for the new code.");
  });

  it("the side panel's Fill with the window focused: filled", async () => {
    const fills = browser({ focused: true });
    await pressFill(true);
    expect(fills).toHaveLength(1);
  });

  it("the shortcut (fillOnTab) with the window unfocused: not filled; focused: filled", async () => {
    const { fillOnTab } = await import("../../src/background/fill-command");
    const tab = { id: 7, url: "https://example.com/login", windowId: 1 };
    let fills = browser({ focused: false });
    expect(await fillOnTab(tab, async () => [entry()], { code: TEST_CODE, off: NOT_OFF })).toBe("failed");
    expect(fills).toEqual([]);
    fills = browser({ focused: true });
    expect(await fillOnTab(tab, async () => [entry()], { code: TEST_CODE, off: NOT_OFF })).toBe("filled");
    expect(fills).toHaveLength(1);
  });
});
