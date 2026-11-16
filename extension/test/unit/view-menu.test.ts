// The View menu (src/popup/main/View.tsx; docs/design/notes/QUICKVIEW-NOTES.md) rendered by Preact into a minimal document
// (test/helpers/mini-dom.ts), events dispatched as a browser would: what each of the four controls writes (the same
// preferences Settings > Appearance writes, and nothing else of the record), what it shows while the write is on its way,
// what it does when a write fails, that it follows changes made elsewhere, what its keys do, and that everything it
// registered is taken off again when it closes. The real browser (focus, layout, the list behind it) is quickview.spec.ts's.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSettings, type Settings } from "../../src/core/service/types";
import type { PopupRuntime } from "../../src/platform/runtime-base";
import { setLangChoice } from "../../src/ui/i18n";
import { THEME_KEY } from "../../src/ui/theme";
import { installMiniDom, MiniElement, type MiniDocument } from "../helpers/mini-dom";

type Listener = (e: Record<string, unknown>) => void;
/** Just the selectors View.tsx uses, over MiniElement's tree. */
function patchSelectors() {
  const proto = MiniElement.prototype as unknown as Record<string, unknown>;
  proto.querySelectorAll = function (this: MiniElement, sel: string) {
    return this.all((e) => e !== this && e.localName === sel);
  };
  proto.contains = function (this: MiniElement, n: MiniElement) {
    return this.all((e) => e === n).length > 0;
  };
  proto.querySelector = function (this: MiniElement, sel: string) {
    const checked = sel === "input:checked";
    return this.all((e) => e.localName === "input" && (!checked || e.checked))[0] ?? null;
  };
}

let dom: ReturnType<typeof installMiniDom>;
let doc: MiniDocument & {
  getElementById?: (id: string) => MiniElement | null;
  addEventListener?: (t: string, f: Listener, o?: unknown) => void;
  removeEventListener?: (t: string, f: Listener, o?: unknown) => void;
};
let root: MiniElement;
let toggle: MiniElement;
/** Document-level listeners the menu registered, by type (the capture flag is part of the key). */
let docListeners: Map<string, Set<Listener>>;
let storageListeners: Set<Listener>;
let winListeners: Set<Listener>;
let local: Map<string, string>;
let record: Settings;
let writes: Settings[];
let failWrites = false;
let reload: ReturnType<typeof vi.fn>;
let closed: number;

const BASE: Settings = {
  autoLock: { mode: "idle", minutes: 15 },
  lockOnScreenLock: true,
  display: { density: "standard", hideCodes: false, sort: "manual" },
  profile: "solo",
};
const rt = () =>
  ({
    settings: {
      get: async () => parseSettings(structuredClone(record)),
      set: async (s: Settings) => {
        if (failWrites) throw new Error("quota");
        writes.push(structuredClone(s));
        record = parseSettings(structuredClone(s));
      },
    },
  }) as unknown as PopupRuntime;

async function open(display = record.display!) {
  const { ViewMenu } = await import("../../src/popup/main/View");
  await act(async () => {
    render(
      h(ViewMenu, {
        rt: rt(),
        display,
        reload: reload as unknown as () => Promise<void>,
        onClose: () => void closed++,
      }),
      root as unknown as Element,
    );
  });
  // the text (the generated catalog) arrives; the first time, with the module itself
  for (let i = 0; i < 100 && !root.byId("view-theme-auto"); i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  expect(root.byId("view-theme-auto"), "the menu drew").not.toBeNull();
}
const input = (id: string) => root.byId(`view-${id}`)!;
const label = (id: string) => root.all((e) => e.localName === "span" && e.parentNode === input(id).parentNode)[0]!;
const text = (id: string) => label(id).textContent;
/** Choose a radio as a click does: it becomes checked, then `change` fires. */
async function pick(id: string, group: string) {
  await act(async () => {
    for (const r of root.all((e) => e.localName === "input" && e.getAttribute("name") === group)) r.checked = false;
    input(id).checked = true;
    input(id).dispatch("change");
  });
}
async function tick() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
}
const stored = () => parseSettings(record);

beforeAll(() => setLangChoice("en")); // (the Chinese text is the same file's other half: view-catalog.test.ts)
beforeEach(() => {
  dom = installMiniDom();
  doc = dom.doc as typeof doc;
  patchSelectors();
  // what applyTheme touches
  Object.assign(doc, {
    documentElement: doc.createElement("html"),
    querySelector: () => null,
  });
  root = doc.body;
  toggle = doc.createElement("button");
  toggle.setAttribute("id", "view-toggle");
  (toggle as unknown as Record<string, unknown>).getBoundingClientRect = () => ({ bottom: 90 });
  docListeners = new Map();
  doc.getElementById = (id) => (id === "view-toggle" ? toggle : root.byId(id));
  doc.addEventListener = (t, f) => void docListeners.set(t, (docListeners.get(t) ?? new Set()).add(f));
  doc.removeEventListener = (t, f) => void docListeners.get(t)?.delete(f);
  storageListeners = new Set();
  winListeners = new Set();
  local = new Map();
  const g = globalThis as Record<string, unknown>;
  g.chrome = {
    storage: {
      local: {
        onChanged: {
          addListener: (f: Listener) => void storageListeners.add(f),
          removeListener: (f: Listener) => void storageListeners.delete(f),
        },
      },
    },
  };
  g.window = {
    document: doc,
    addEventListener: (_t: string, f: Listener) => void winListeners.add(f),
    removeEventListener: (_t: string, f: Listener) => void winListeners.delete(f),
  };
  g.localStorage = {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, v),
    removeItem: (k: string) => void local.delete(k),
  };
  record = structuredClone(BASE);
  writes = [];
  failWrites = false;
  reload = vi.fn(async () => undefined);
  closed = 0;
});
afterEach(() => {
  act(() => render(null, root as unknown as Element));
  dom.undo();
  const g = globalThis as Record<string, unknown>;
  delete g.chrome;
  delete g.window;
  delete g.localStorage;
});

describe("the four controls", () => {
  it("draw the settings as they are, with Appearance's words", async () => {
    record.display = { density: "compact", hideCodes: true, sort: "name" };
    await open();
    expect(["theme-auto", "theme-light", "theme-dark"].map((i) => input(i).checked)).toEqual([true, false, false]);
    expect(["density-standard", "density-compact"].map((i) => input(i).checked)).toEqual([false, true]);
    expect(["sort-manual", "sort-name"].map((i) => input(i).checked)).toEqual([false, true]);
    expect(input("hide").checked).toBe(true);
    expect([text("theme-auto"), text("theme-light"), text("theme-dark")]).toEqual(["Auto", "Light", "Dark"]);
    expect([text("density-compact"), text("sort-name")]).toEqual(["Compact", "By name"]);
    // the dialog is named by the button that opened it
    const dialog = root.all((e) => e.getAttribute("role") === "dialog")[0]!;
    expect(dialog.getAttribute("aria-labelledby")).toBe("view-toggle");
  });

  for (const [what, id, group, part] of [
    ["rows: compact", "density-compact", "view-density", { density: "compact" }],
    ["order: by name", "sort-name", "view-sort", { sort: "name" }],
  ] as const)
    it(`${what}: writes the whole record with only \`display.${Object.keys(part)[0]}\` changed, then the list is drawn again from storage`, async () => {
      await open();
      await pick(id, group);
      await tick();
      expect(writes).toHaveLength(1);
      expect(writes[0]).toEqual({ ...BASE, display: { ...BASE.display, ...part } });
      expect(stored().autoLock).toEqual(BASE.autoLock);
      expect(stored().profile).toBe("solo");
      // the list is drawn again from storage once the write is in, and again when the change event comes (as Chrome sends it)
      expect(reload).toHaveBeenCalledTimes(1);
      expect(storageListeners.size).toBe(1);
      storageListeners.forEach((f) => f({ sk_settings: {} }));
      expect(reload).toHaveBeenCalledTimes(2);
    });

  it("hidden codes: the box writes `display.hideCodes` as a boolean, both ways", async () => {
    await open();
    await act(async () => {
      input("hide").checked = true;
      input("hide").dispatch("change");
    });
    await tick();
    expect(writes.at(-1)!.display).toEqual({ ...BASE.display, hideCodes: true });
    await act(async () => {
      input("hide").checked = false;
      input("hide").dispatch("change");
    });
    await tick();
    expect(writes.at(-1)!.display).toEqual(BASE.display);
    expect(writes).toHaveLength(2);
  });

  it("theme: the key Settings reads, with auto as no key at all, and nothing is written to the settings record", async () => {
    await open();
    await pick("theme-dark", "view-theme");
    expect(local.get(THEME_KEY)).toBe("dark");
    await pick("theme-light", "view-theme");
    expect(local.get(THEME_KEY)).toBe("light");
    await pick("theme-auto", "view-theme");
    expect(local.has(THEME_KEY)).toBe(false);
    expect(writes).toEqual([]); // the theme is the browser's, not part of the settings record (or of a backup)
  });

  it("each choice shows at once, before its write has finished", async () => {
    let finish!: () => void;
    const slow = rt();
    const real = slow.settings.set;
    slow.settings.set = async (s: Settings) => {
      await new Promise<void>((r) => (finish = r));
      return real(s);
    };
    const { ViewMenu } = await import("../../src/popup/main/View");
    await act(async () => {
      render(
        h(ViewMenu, { rt: slow, display: BASE.display!, reload: reload as never, onClose: () => undefined }),
        root as unknown as Element,
      );
      await new Promise((r) => setTimeout(r, 20));
    });
    await pick("sort-name", "view-sort");
    await tick();
    expect(input("sort-name").checked).toBe(true);
    // drawn as chosen, though the settings it was drawn from have not changed: the bar's filled option moved
    const filled = (id: string) => /\bon\b/.test((input(id).parentNode as MiniElement).getAttribute("class") ?? "");
    expect([filled("sort-name"), filled("sort-manual")]).toEqual([true, false]);
    expect(root.all((e) => e.localName === "label" && /\bon\b/.test(e.getAttribute("class") ?? ""))).toHaveLength(3); // one chosen in each bar
    await act(async () => finish());
    await tick();
  });

  it("a choice that changes nothing in storage (no change event) is not left pending: the list is drawn again and the menu follows it", async () => {
    record.display = { ...record.display!, density: "compact" }; // stored already; the menu was drawn with the old props
    await open({ ...BASE.display! });
    await pick("density-compact", "view-density");
    await tick();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(input("density-compact").checked).toBe(false); // what is drawn is the props' (the redraw brings the new ones)
    expect(input("density-standard").checked).toBe(true);
  });

  it("two choices made before the first write has started are written one after the other too", async () => {
    await open();
    await act(async () => {
      for (const [id, group] of [
        ["density-compact", "view-density"],
        ["sort-name", "view-sort"],
      ] as const) {
        for (const r of root.all((e) => e.localName === "input" && e.getAttribute("name") === group)) r.checked = false;
        input(id).checked = true;
        input(id).dispatch("change");
      }
    });
    await tick();
    expect(writes.map((w) => w.display)).toEqual([
      { density: "compact", hideCodes: false, sort: "manual" },
      { density: "compact", hideCodes: false, sort: "name" },
    ]);
  });

  it("two quick choices are written one after the other, each over the record as stored: neither undoes the other", async () => {
    await open();
    await pick("density-compact", "view-density");
    await pick("sort-name", "view-sort");
    await tick();
    expect(writes.map((w) => w.display)).toEqual([
      { density: "compact", hideCodes: false, sort: "manual" },
      { density: "compact", hideCodes: false, sort: "name" },
    ]);
  });

  it("Tab goes round from the theme that is chosen, not from the first one in the bar (a radio group is one stop)", async () => {
    await open();
    await pick("theme-dark", "view-theme");
    const dialog = root.all((e) => e.getAttribute("role") === "dialog")[0]!;
    input("theme-dark").focus();
    const e = dialog.dispatch("keydown", { key: "Tab", shiftKey: true, stopPropagation: () => undefined });
    expect(e.defaultPrevented).toBe(true); // it was the first stop: round to the last
    expect(doc.activeElement).toBe(input("hide"));
  });

  it("a part of the record written elsewhere meanwhile (the lock rules) is kept, not put back", async () => {
    await open();
    record = { ...record, autoLock: { mode: "session" }, lockOnScreenLock: false };
    await pick("sort-name", "view-sort");
    await tick();
    expect(writes[0]).toMatchObject({ autoLock: { mode: "session" }, lockOnScreenLock: false, profile: "solo" });
  });

  it("a failed write is said, and the choice goes back to what is stored", async () => {
    await open();
    failWrites = true;
    await pick("density-compact", "view-density");
    await tick();
    expect(root.all((e) => e.getAttribute("role") === "alert")).toHaveLength(1);
    expect(input("density-compact").checked).toBe(false);
    expect(input("density-standard").checked).toBe(true);
    failWrites = false;
    await pick("density-compact", "view-density");
    await tick();
    expect(root.all((e) => e.getAttribute("role") === "alert")).toHaveLength(0);
    expect(writes).toHaveLength(1);
  });
});

describe("following the rest of Sixkey", () => {
  it("a change of the settings record, by whoever made it, draws the list again (and any other key does not)", async () => {
    await open();
    storageListeners.forEach((f) => f({ sk_last_backup: {}, sk_active: {} }));
    expect(reload).not.toHaveBeenCalled();
    storageListeners.forEach((f) => f({ sk_settings: {} }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("the drawn settings catching up clears a pending choice; a new `display` shows (Settings changed it)", async () => {
    await open();
    expect(input("density-compact").checked).toBe(false);
    await open({ density: "compact", hideCodes: true, sort: "name" }); // the same menu, drawn again with new props
    expect(input("density-compact").checked).toBe(true);
    expect(input("hide").checked).toBe(true);
    expect(input("sort-name").checked).toBe(true);
  });

  it("a theme chosen on another page (the `storage` event) shows in the open menu", async () => {
    await open();
    expect(input("theme-auto").checked).toBe(true);
    local.set(THEME_KEY, "dark");
    await act(async () => winListeners.forEach((f) => f({ key: THEME_KEY })));
    expect(input("theme-dark").checked).toBe(true);
    expect(input("theme-auto").checked).toBe(false);
  });
});

describe("keys, focus and leaving", () => {
  const dialog = () => root.all((e) => e.getAttribute("role") === "dialog")[0]!;
  const key = (k: string, extra: Record<string, unknown> = {}) => {
    const stop = vi.fn();
    const e = dialog().dispatch("keydown", { key: k, stopPropagation: stop, ...extra });
    return { e, stop };
  };

  it("no key typed in the menu goes on to the list behind it", async () => {
    await open();
    for (const k of ["ArrowDown", "ArrowUp", "Enter", " ", "g", "Home", "/", "Escape", "Tab"])
      expect(key(k).stop, k).toHaveBeenCalledTimes(1);
  });

  it("Escape closes it and puts the focus back on the button; Tab goes round its controls, a radio group being one stop", async () => {
    await open();
    expect(doc.activeElement).toBe(input("theme-auto")); // the focus goes in, on the chosen theme
    input("hide").focus();
    let r = key("Tab");
    expect(r.e.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(input("theme-auto"));
    r = key("Tab", { shiftKey: true });
    expect(r.e.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(input("hide"));
    input("density-standard").focus();
    expect(key("Tab").e.defaultPrevented).toBe(false); // in the middle the browser's own step
    expect(key("Escape").e.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(toggle);
    expect(closed).toBe(1);
  });

  it("a press outside closes it; one inside, or on the button that opened it, does not", async () => {
    await open();
    const down = () => [...(docListeners.get("pointerdown") ?? [])];
    expect(down()).toHaveLength(1);
    down()[0]!({ target: input("hide") });
    down()[0]!({ target: toggle });
    expect(closed).toBe(0);
    down()[0]!({ target: doc.createElement("div") });
    expect(closed).toBe(1);
  });

  it("everything it registered is taken off when it closes", async () => {
    await open();
    expect(storageListeners.size).toBe(1);
    expect(winListeners.size).toBe(1);
    expect(docListeners.get("pointerdown")?.size).toBe(1);
    act(() => render(null, root as unknown as Element));
    expect(storageListeners.size).toBe(0);
    expect(winListeners.size).toBe(0);
    expect(docListeners.get("pointerdown")?.size ?? 0).toBe(0);
  });
});
