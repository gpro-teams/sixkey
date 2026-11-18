// TOTP autofill, Stage 1: what the popup does when a lazy part cannot be loaded (the review's m-1, m-2) and when the tab in
// front is not the page the list is for (U4). Failing closed, in words the popup already has: a locked vault is never drawn as
// an empty app, and the Fill UI draws nothing (never a key name) when its text is missing. Each test loads a fresh copy of the
// modules, with the generated catalogs or the lazy chunk made to fail.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "../../src/core/vault/model";
import { installMiniDom, MiniElement } from "../helpers/mini-dom";

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
const ticks = (n = 30) =>
  act(async () => {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 5));
  });
const texts = () => root.all((e) => !!e.textContent).map((e) => e.textContent);

beforeEach(() => {
  vi.resetModules();
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
  });
  root = dom.doc.body;
  g.chrome = {
    commands: { getAll: async () => [] },
    tabs: { query: async () => [{ id: 7, url: "https://example.com/login" }] },
    scripting: { executeScript: vi.fn(async () => []) },
    storage: {
      local: {
        onChanged: { addListener: () => undefined, removeListener: () => undefined },
        setAccessLevel: async () => undefined,
      },
      session: { setAccessLevel: async () => undefined },
    },
  };
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
  for (const f of [
    "../../catalogs/autofill-en.json",
    "../../catalogs/autofill-zh_CN.json",
    "../../src/popup/screens/late",
  ])
    vi.doUnmock(f);
  delete g.chrome;
  delete g.localStorage;
});

describe("the Fill text cannot be read: nothing of the Fill UI is drawn", () => {
  const failText = () => {
    for (const l of ["en", "zh_CN"])
      vi.doMock(`../../catalogs/autofill-${l}.json`, () => {
        throw new Error("chunk not found");
      });
  };
  async function draw() {
    const i18n = await import("../../src/ui/i18n");
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
    await ticks();
  }
  it("both languages missing: no strip, no button, no key name (afFound, afFill…) anywhere", async () => {
    failText();
    await draw();
    expect(texts().join("|")).not.toMatch(/af[A-Z]/);
    expect(root.all((e) => e.localName === "button")).toEqual([]);
    expect(root.all((e) => e.localName === "svg")).toEqual([]);
  });
  it("this language missing: English is drawn (the same words as the other language would give)", async () => {
    vi.doMock("../../catalogs/autofill-zh_CN.json", () => {
      throw new Error("chunk not found");
    });
    const i18n = await import("../../src/ui/i18n");
    i18n.setLangChoice("zh_CN");
    await draw();
    expect(texts().join("|")).toMatch(/Fill code|Looking for the code box|Code box/);
    expect(texts().join("|")).not.toMatch(/af[A-Z]/);
  });
  it("control: with the text in, the strip and the button are drawn", async () => {
    await draw();
    expect(root.all((e) => e.localName === "button").length).toBeGreaterThan(0);
  });
});

describe("STORAGEGATE: where Sixkey cannot close its storage to the page's scripts (the second layer: before Chrome 140, or a browser that refuses)", () => {
  it("the page is not looked at, no Fill button is drawn, and the strip says why", async () => {
    const st = (g.chrome as { storage: { local: Record<string, unknown> } }).storage;
    delete st.local.setAccessLevel; // as before Chrome 140 (Sixkey requires 140 since wave 1b; the gate is the second layer)
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
    await ticks();
    expect(texts()).toContain("Autofill needs Chrome 140 or later.");
    expect(root.all((e) => e.localName === "button")).toEqual([]); // no Fill, no Look again
    expect(
      (g.chrome as { scripting: { executeScript: ReturnType<typeof vi.fn> } }).scripting.executeScript,
    ).not.toHaveBeenCalled();
  });
  it("a press whose own look comes back gated (the page changed after an open look) says the Chrome 140 line under the card, never 'cannot look at this kind of page'", async () => {
    const c = g.chrome as {
      tabs: { query: unknown };
      storage: { local: Record<string, unknown> };
      scripting: { executeScript: ReturnType<typeof vi.fn> };
    };
    const box = { t: "0123456789abcdef", k: 0, n: 6, s: 70, sent: false, weak: false, lab: "" };
    c.scripting.executeScript = vi.fn(async (o: { files?: string[] }) =>
      o.files
        ? []
        : [
            {
              frameId: 0,
              documentId: "d0",
              result: { o: "https://example.com", a: [], top: true, c: [box], x: 0, z: 0 },
            },
          ],
    );
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
    await ticks();
    expect(texts()).toContain("Code box found on this page"); // the open look
    // now the tab shows another page, and storage.local can no longer be closed (as before Chrome 140)
    c.tabs.query = async () => [{ id: 7, url: "https://example.com/login?next" }];
    delete c.storage.local.setAccessLevel;
    const calls = c.scripting.executeScript.mock.calls.length;
    const fill = root.all((e) => e.localName === "button" && e.getAttribute("class")?.includes("fillbtn") === true)[0]!;
    await act(async () => void fill.dispatch("click", {}));
    await ticks();
    expect(texts()).toContain("Autofill needs Chrome 140 or later.");
    expect(texts().join("|")).not.toMatch(/cannot look at this kind of page/);
    expect(c.scripting.executeScript.mock.calls.length).toBe(calls); // nothing injected after the refusal
    expect(root.all((e) => e.localName === "button")).toEqual([]);
  });
});

describe("the lazy screens chunk cannot be loaded: a locked vault is not an empty app", () => {
  it("says so with the popup's own words (the counted catalog) and offers Retry; Retry tries again", async () => {
    let tries = 0;
    vi.doMock("../../src/popup/screens/late", () => {
      tries++;
      throw new Error("Failed to fetch dynamically imported module");
    });
    const i18n = await import("../../src/ui/i18n");
    await i18n.loadCatalog(async () => ({
      errorTitle: { message: "Something went wrong" },
      retry: { message: "Retry" },
    }));
    const { Late } = await import("../../src/popup/App");
    await act(async () => {
      render(
        h(Late, {
          rt: {} as never,
          screen: { k: "locked" },
          reload: async () => undefined,
          onUnlocked: async () => undefined,
        }),
        root as unknown as Element,
      );
    });
    await ticks();
    expect(texts()).toEqual(expect.arrayContaining(["Something went wrong", "Retry"]));
    expect(root.all((e) => e.getAttribute("id") === "late-failed")).toHaveLength(1);
    expect(root.all((e) => e.localName === "input")).toEqual([]);
    const before = tries;
    const retry = root.all((e) => e.localName === "button" && e.textContent === "Retry")[0]!;
    // Retry: the chunk asked for again; failed again, the page is reloaded (its build may be gone from disk)
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    await act(async () => void retry.dispatch("click", {}));
    await ticks();
    expect(tries).toBeGreaterThan(before);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe("the look is of the page the list is for (U4)", () => {
  it("a tab in front that is on another host is not scripted at all", async () => {
    (g.chrome as { tabs: { query: unknown } }).tabs.query = async () => [{ id: 9, url: "https://other.example.org/" }];
    const { scanPage } = await import("../../src/popup/main/Fill");
    const seen = await scanPage("example.com");
    expect(seen).toEqual({ k: "away" });
    expect(
      (g.chrome as { scripting: { executeScript: ReturnType<typeof vi.fn> } }).scripting.executeScript,
    ).not.toHaveBeenCalled();
  });
  it("a tab with no address (activeTab not granted) is not scripted either", async () => {
    (g.chrome as { tabs: { query: unknown } }).tabs.query = async () => [{ id: 9 }];
    const { scanPage } = await import("../../src/popup/main/Fill");
    expect(await scanPage("example.com")).toEqual({ k: "away" });
  });
});
