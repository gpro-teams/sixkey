// PHASE0X-PLAN C4: the colour theme choice (src/ui/theme.ts), and public/theme-boot.js, which applies it before the
// first paint and must agree with theme.ts on the key and the values.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, getThemeChoice, THEME_CHOICES, THEME_KEY, type ThemeChoice } from "../../src/ui/theme";
import { followTheme, setThemeChoice } from "../../src/ui/theme-set";

const BOOT = readFileSync(join(__dirname, "../../public/theme-boot.js"), "utf8");

/** Just enough of a page for the theme code: <html>'s attributes and the color-scheme meta. */
function fakeDoc(meta = true) {
  const attrs = new Map<string, string>();
  const metaAttrs = new Map<string, string>([["content", "light dark"]]);
  const root = {
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
    getAttribute: (k: string) => attrs.get(k) ?? null,
  };
  const metaEl = { setAttribute: (k: string, v: string) => void metaAttrs.set(k, v) };
  const doc = {
    documentElement: root,
    querySelector: (sel: string) => (meta && sel === 'meta[name="color-scheme"]' ? metaEl : null),
  };
  return {
    doc: doc as unknown as Document,
    theme: () => attrs.get("data-theme") ?? null,
    scheme: () => metaAttrs.get("content"),
  };
}

function fakeStorage(initial: Record<string, string> = {}, broken = false) {
  const m = new Map(Object.entries(initial));
  const guard = () => {
    if (broken) throw new DOMException("denied", "SecurityError");
  };
  return {
    map: m,
    getItem: (k: string) => (guard(), m.get(k) ?? null),
    setItem: (k: string, v: string) => {
      guard();
      m.set(k, String(v));
    },
    removeItem: (k: string) => {
      guard();
      m.delete(k);
    },
  };
}

const runBoot = (storage: ReturnType<typeof fakeStorage>, doc: Document) =>
  runInNewContext(BOOT, { localStorage: storage, document: doc });

afterEach(() => vi.unstubAllGlobals());

describe("theme choice", () => {
  it("reads light and dark, and anything else (nothing stored, junk, no storage) as auto", () => {
    for (const [stored, want] of [
      [undefined, "auto"],
      ["light", "light"],
      ["dark", "dark"],
      ["auto", "auto"],
      ["Dark", "auto"],
      ["", "auto"],
    ] as const) {
      vi.stubGlobal("localStorage", fakeStorage(stored === undefined ? {} : { [THEME_KEY]: stored }));
      expect(getThemeChoice(), String(stored)).toBe(want);
    }
    vi.stubGlobal("localStorage", fakeStorage({ [THEME_KEY]: "dark" }, true));
    expect(getThemeChoice()).toBe("auto");
  });

  it("applies a choice: data-theme for the stylesheets, the color-scheme meta for the browser's own canvas", () => {
    const f = fakeDoc();
    applyTheme("dark", f.doc);
    expect([f.theme(), f.scheme()]).toEqual(["dark", "dark"]);
    applyTheme("light", f.doc);
    expect([f.theme(), f.scheme()]).toEqual(["light", "light"]);
    applyTheme("auto", f.doc); // following the system: no attribute at all, both schemes declared
    expect([f.theme(), f.scheme()]).toEqual([null, "light dark"]);
    expect(() => applyTheme("dark", fakeDoc(false).doc)).not.toThrow(); // a page without the meta
  });

  it("remembers a choice and applies it; auto removes the stored value", () => {
    const s = fakeStorage();
    vi.stubGlobal("localStorage", s);
    const f = fakeDoc();
    setThemeChoice("dark", f.doc);
    expect(s.map.get(THEME_KEY)).toBe("dark");
    expect(getThemeChoice()).toBe("dark");
    expect(f.theme()).toBe("dark");
    setThemeChoice("auto", f.doc);
    expect(s.map.has(THEME_KEY)).toBe(false);
    expect([f.theme(), f.scheme()]).toEqual([null, "light dark"]);
  });

  it("without storage, a choice still applies to this page", () => {
    vi.stubGlobal("localStorage", fakeStorage({}, true));
    const f = fakeDoc();
    expect(() => setThemeChoice("light", f.doc)).not.toThrow();
    expect(f.theme()).toBe("light");
  });
});

describe("followTheme: a choice made on another extension page", () => {
  /** A window that keeps its `storage` listeners, as the page that follows has them. */
  function fakeWindow(doc: Document) {
    const listeners = new Set<(e: { key: string | null }) => void>();
    return {
      win: {
        document: doc,
        addEventListener: (_: string, f: (e: { key: string | null }) => void) => listeners.add(f),
        removeEventListener: (_: string, f: (e: { key: string | null }) => void) => listeners.delete(f),
      } as unknown as Window,
      fire: (key: string | null) => listeners.forEach((f) => f({ key })),
      size: () => listeners.size,
    };
  }

  it("applies the stored choice to this page and tells the page that asked, for its key (and for a cleared storage)", () => {
    const s = fakeStorage();
    vi.stubGlobal("localStorage", s);
    const f = fakeDoc();
    const w = fakeWindow(f.doc);
    const seen: string[] = [];
    followTheme((c) => seen.push(c), w.win);
    s.map.set(THEME_KEY, "dark"); // what another page's setThemeChoice leaves in the shared storage
    w.fire(THEME_KEY);
    expect([f.theme(), f.scheme(), seen]).toEqual(["dark", "dark", ["dark"]]);
    s.map.delete(THEME_KEY);
    w.fire(THEME_KEY);
    expect([f.theme(), f.scheme(), seen]).toEqual([null, "light dark", ["dark", "auto"]]);
    s.map.set(THEME_KEY, "light");
    w.fire(null); // localStorage.clear()
    expect([f.theme(), seen.at(-1)]).toEqual(["light", "light"]);
  });

  it("ignores every other key, and stops when told to", () => {
    const s = fakeStorage({ [THEME_KEY]: "dark" });
    vi.stubGlobal("localStorage", s);
    const f = fakeDoc();
    const w = fakeWindow(f.doc);
    const seen: string[] = [];
    const stop = followTheme((c) => seen.push(c), w.win);
    w.fire("sk_lang");
    expect([f.theme(), seen]).toEqual([null, []]);
    expect(w.size()).toBe(1);
    stop();
    expect(w.size()).toBe(0);
    w.fire(THEME_KEY);
    expect(seen).toEqual([]);
  });

  it("is in theme-set.ts, not theme.ts: the toolbar popup, which only applies the choice, carries none of it", () => {
    const apply = readFileSync(join(__dirname, "../../src/ui/theme.ts"), "utf8");
    expect(apply).not.toMatch(/setThemeChoice|followTheme|addEventListener/);
    const boot = readFileSync(join(__dirname, "../../src/popup/boot.tsx"), "utf8");
    expect(boot).not.toMatch(/theme-set/);
  });
});

describe("public/theme-boot.js", () => {
  it("is a classic script: no module syntax, nothing fetched", () => {
    expect(BOOT).not.toMatch(/^\s*(import|export)\b/m);
    expect(BOOT).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|import\s*\(/);
  });

  it("leaves the page exactly as theme.ts would set it, for every stored value", () => {
    for (const stored of [undefined, ...THEME_CHOICES, "Dark", "junk", ""]) {
      const s = fakeStorage(stored === undefined ? {} : { [THEME_KEY]: stored });
      const boot = fakeDoc();
      runBoot(s, boot.doc);
      vi.stubGlobal("localStorage", s);
      const ref = fakeDoc();
      applyTheme(getThemeChoice(), ref.doc);
      expect([boot.theme(), boot.scheme()], String(stored)).toEqual([ref.theme(), ref.scheme()]);
    }
  });

  it("does nothing and does not throw when storage cannot be read, or the page has no meta", () => {
    const f = fakeDoc();
    expect(() => runBoot(fakeStorage({ [THEME_KEY]: "dark" }, true), f.doc)).not.toThrow();
    expect([f.theme(), f.scheme()]).toEqual([null, "light dark"]);
    const g = fakeDoc(false);
    runBoot(fakeStorage({ [THEME_KEY]: "dark" }), g.doc);
    expect(g.theme()).toBe("dark");
  });

  it("knows exactly the choices theme.ts offers", () => {
    const manual = THEME_CHOICES.filter((c): c is Exclude<ThemeChoice, "auto"> => c !== "auto");
    for (const c of manual) expect(BOOT).toContain(`"${c}"`);
    expect(BOOT).toContain(`"${THEME_KEY}"`);
  });
});
