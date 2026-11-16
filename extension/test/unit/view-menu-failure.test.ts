// The View menu when its text chunk cannot be read (docs/design/notes/QUICKVIEW-NOTES.md §3): the menu loses its words,
// the rest of the popup loses nothing. The menu keeps its text in a lookup of its own, so the page's catalog (src/ui/i18n.ts)
// is never replaced; when neither language's chunk loads the menu says so in the page's own words and still closes. Each
// test loads a fresh copy of the module (its text is read once, as the module loads) with the generated file made to fail.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../../src/core/service/types";
import type { PopupRuntime } from "../../src/platform/runtime-base";
import { installMiniDom, MiniElement } from "../helpers/mini-dom";

let dom: ReturnType<typeof installMiniDom>;
let root: MiniElement;
let closed = 0;

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
  const g = globalThis as Record<string, unknown>;
  g.chrome = { storage: { local: { onChanged: { addListener: () => undefined, removeListener: () => undefined } } } };
  g.window = {
    document: dom.doc,
    innerHeight: 600,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  g.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  closed = 0;
});
afterEach(() => {
  act(() => render(null, root as unknown as Element));
  dom.undo();
  vi.doUnmock("../../catalogs/view-en.json");
  vi.doUnmock("../../catalogs/view-zh_CN.json");
  const g = globalThis as Record<string, unknown>;
  delete g.chrome;
  delete g.window;
  delete g.localStorage;
});

const fail = (lang: "en" | "zh_CN") =>
  vi.doMock(`../../catalogs/view-${lang}.json`, () => {
    throw new Error(`view-${lang}: chunk not found`);
  });

/** A fresh copy of i18n and the menu; the page's catalog is set to a sentinel before the menu loads. */
async function load(lang: "en" | "zh_CN") {
  const i18n = await import("../../src/ui/i18n");
  i18n.setLangChoice(lang);
  await i18n.loadCatalog(async () => ({
    errorTitle: { message: "Oops" },
    searchPlaceholder: { message: "the page's own text" },
  }));
  const { ViewMenu } = await import("../../src/popup/main/View");
  const rt = { settings: { get: async () => ({}) as Settings, set: async () => undefined } } as unknown as PopupRuntime;
  await act(async () => {
    render(
      h(ViewMenu, {
        rt,
        display: { density: "standard", hideCodes: false, sort: "manual" },
        reload: async () => undefined,
        onClose: () => void closed++,
      }),
      root as unknown as Element,
    );
  });
  for (let i = 0; i < 100 && !root.all((e) => e.getAttribute("role") === "dialog").length; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  return i18n;
}
const dialog = () => root.all((e) => e.getAttribute("role") === "dialog")[0]!;
const words = () => root.all((e) => e.localName === "span").map((e) => e.textContent);

describe("a chunk that cannot be loaded", () => {
  it("this language's: the menu is drawn in English, and the page's catalog is untouched", async () => {
    fail("zh_CN");
    const i18n = await load("zh_CN");
    expect(words()).toEqual(expect.arrayContaining(["Auto", "Light", "Dark", "Compact", "By name"]));
    expect(i18n.t("searchPlaceholder")).toBe("the page's own text"); // not English-ised, not emptied
    expect(i18n.t("errorTitle")).toBe("Oops");
  });

  it("both languages': the menu says so in the page's words (one alert) and still closes; the page's catalog is untouched", async () => {
    fail("zh_CN");
    fail("en");
    const i18n = await load("zh_CN");
    const alerts = root.all((e) => e.getAttribute("role") === "alert");
    expect(alerts.map((a) => a.textContent)).toEqual(["Oops"]);
    expect(root.all((e) => e.localName === "input")).toEqual([]); // no choice to make without words: no key names drawn
    expect(words().join()).not.toMatch(/look|view[A-Z]/);
    expect(i18n.t("searchPlaceholder")).toBe("the page's own text");
    expect(i18n.t("errorTitle")).toBe("Oops");
    // Escape still closes it, and its keys still do not reach the list
    const stop = vi.fn();
    dialog().dispatch("keydown", { key: "Escape", stopPropagation: stop });
    expect(closed).toBe(1);
    expect(stop).toHaveBeenCalled();
    expect(dialog().getAttribute("aria-modal")).toBe("true");
  });

  it("neither fails: the page's catalog is untouched all the same (the menu never writes to it)", async () => {
    const i18n = await load("en");
    expect(words()).toEqual(expect.arrayContaining(["Auto", "Light", "Dark"]));
    expect(i18n.t("searchPlaceholder")).toBe("the page's own text");
    expect(i18n.t("lookTheme")).toBe("lookTheme"); // the menu's words are the menu's
  });
});
