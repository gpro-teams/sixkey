// W1b r3's review, S-1 (docs/design/notes/PLUGINS-W1C-NOTES.md): when the platform's gate answers "off", the popup's Fill
// always writes the record again, unchanged (touchSwitch), so the worker follows the switch and gives back whatever
// `scripting` this surface holds while Off, whether or not this very click got it from Chrome; a fill the gate allows
// writes nothing. The Fill chunk is drawn into a minimal document (test/helpers/mini-dom.ts) over a stand-in chrome.*,
// as in autofill2-popup-front.test.ts; the gate is mocked, `scripting` is held (the page was looked at before the click).
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "../../src/core/vault/model";
import { installMiniDom, MiniElement } from "../helpers/mini-dom";
import { TEST_CODE } from "../helpers/gate";

let dom: ReturnType<typeof installMiniDom>;
/** The gate the Fill chunk gets (its switch said off), and the unchanged write it asks for. */
let gate: (e: Entry, at: number) => Promise<unknown> = TEST_CODE;
const touched = vi.fn(async () => undefined);
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

/** The browser: tab 7 in front of window 1, at the page; what the Fill chunk sends into the page is recorded. */
function browser() {
  const fills: unknown[] = [];
  g.chrome = {
    commands: { getAll: async () => [] },
    tabs: {
      query: async () => [{ id: 7, url: "https://example.com/login" }],
      get: async (id: number) => ({ id, active: id === 7, windowId: 1 }),
    },
    windows: { get: async (id: number) => ({ id, focused: false }) },
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

async function pressFill(): Promise<void> {
  // the platform's gate (its switch, ceiling and log are test/unit/plugins-w1b-gate.test.ts's): what it answers is the
  // test's `gate`, and its unchanged write is recorded
  vi.doMock("../../src/platform/plugins/autofill-gate", () => ({ gatedCode: () => gate, touchSwitch: touched }));
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

describe("the popup's Fill, the gate saying off", () => {
  it("writes the record again (touchSwitch) though `scripting` was held already and this click asked Chrome nothing", async () => {
    gate = async () => ({ no: "off" });
    touched.mockClear();
    const fills = browser();
    await pressFill();
    expect(fills).toEqual([]);
    expect(texts()).toContain("Autofill is off. Turn it on in Settings › Security › Autofill.");
    expect(touched).toHaveBeenCalledTimes(1);
  });
  it("and a fill the gate allows writes nothing", async () => {
    gate = TEST_CODE;
    touched.mockClear();
    const fills = browser();
    await pressFill();
    expect(fills).toHaveLength(1);
    expect(touched).not.toHaveBeenCalled();
  });
});
