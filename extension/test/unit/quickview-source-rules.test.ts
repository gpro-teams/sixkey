// The View menu's rules, read from the source (docs/design/notes/QUICKVIEW-NOTES.md): it is loaded when first used and
// nothing else loads it, it writes what Settings > Appearance writes and nothing more, it stops its keys from reaching the
// list, it takes off every listener it puts on, and what follows changes made elsewhere is where it is meant to be. The
// behaviour itself is view-menu.test.ts's (the component rendered) and quickview.spec.ts's (the real browser).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(EXT, "src");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
const code = (t: string) =>
  t
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
const files = walk(SRC).map((p) => ({
  path: relative(SRC, p).split("\\").join("/"),
  code: code(readFileSync(p, "utf8")),
}));
const file = (path: string) => files.find((f) => f.path === path)!.code;
const view = file("popup/main/View.tsx");
const main = file("popup/main/Main.tsx");
/** The module specifiers a file imports, statically (`from "…"`, `import "…"`) and by import(). */
const importsOf = (c: string) => ({
  statics: [...c.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s*"([^"]+)"|^import\s*"([^"]+)"/gm)].map(
    (m) => m[1] ?? m[2]!,
  ),
  dynamic: [...c.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]!),
});

describe("loaded when first used, by nothing else", () => {
  it("only Main.tsx names the menu, by import() alone; the add view is loaded the same way", () => {
    for (const f of files) {
      const { statics, dynamic } = importsOf(f.code);
      expect(
        statics.filter((s) => /(^|\/)View$/.test(s)),
        `${f.path} imports the View menu statically`,
      ).toEqual([]);
      expect(
        statics.filter((s) => /^\.\/AddMenu$/.test(s)),
        `${f.path} imports the add view statically`,
      ).toEqual([]);
      if (dynamic.some((s) => /(^|\/)View$/.test(s))) expect(f.path).toBe("popup/main/Main.tsx");
    }
    expect(importsOf(main).dynamic).toEqual(expect.arrayContaining(["./View", "./AddMenu"]));
    // what the list needs of the add view without it is a module of its own
    expect(importsOf(main).statics).toContain("./add-input");
    expect(importsOf(file("popup/main/AddMenu.tsx")).statics).toContain("./add-input");
  });

  it("the popup's own code imports nothing only the menu needs: the theme's setter and follower, the menu's text", () => {
    for (const p of [
      "popup/App.tsx",
      "popup/boot.tsx",
      "popup/chrome.tsx",
      "popup/main/Main.tsx",
      "popup/main/List.tsx",
    ]) {
      const { statics } = importsOf(file(p));
      expect(
        statics.filter((s) => /theme-set|view\.css|catalogs\//.test(s)),
        p,
      ).toEqual([]);
    }
    // the menu's own list of imports: nothing that would pull a shared chunk apart in the popup's counted bundle (icons,
    // the art, the service's value exports), which cost bytes when the menu first had them (QUICKVIEW-NOTES.md §4)
    expect(importsOf(view).statics.sort()).toEqual(
      [
        "preact/hooks",
        "../../core/service/types", // a type
        "../../platform/runtime-base", // a type
        "../../ui/i18n",
        "../../ui/lazy-text", // the lookup of a lazy part's own text, shared with the Fill button (AUTOFILL1-NOTES.md §6a)
        "../../ui/theme",
        "../../ui/theme-set",
        "./view.css",
      ].sort(),
    );
    expect(view).toMatch(/import type \{ DisplaySettings \} from "..\/..\/core\/service\/types"/);
    expect(view).toMatch(/import type \{ PopupRuntime \} from "..\/..\/platform\/runtime-base"/);
  });

  it("the page's own catalog is never touched by the menu: it reads its text into a lookup of its own", () => {
    expect(view).not.toMatch(/loadCatalog|popup-catalog|virtual:popup-catalog/);
    expect(importsOf(view).dynamic.sort()).toEqual([
      "../../../catalogs/view-en.json",
      "../../../catalogs/view-zh_CN.json",
    ]);
  });

  it("the button sits in the search field, named, and the menu is drawn from Main's state", () => {
    const search = main.slice(main.indexOf('<div class="search">'), main.indexOf("<Notices "));
    expect(search).toContain('id="view-toggle"');
    const button = search.slice(
      search.indexOf('<button\n          class="tb"'),
      search.indexOf("</button>", search.indexOf('id="view-toggle"')),
    );
    expect(button).toContain('t("lookTitle")');
    expect(button).toContain("aria-expanded");
    expect(main).toMatch(/\{Menu && <Menu /);
  });

  it("hiding codes ends any reveal in progress, and the menu belongs to the list", () => {
    expect(main).toMatch(/useEffect\([^;]*setShownId\(null\)[^;]*\[hide\]\)/);
    expect(main).toMatch(/useEffect\([^;]*view !== "list"[^;]*setMenu\(null\)[^;]*\[view\]\)/);
  });
});

describe("what it writes", () => {
  it("only `display`, through the settings store, as the whole record read just before: nothing else of it, no other key", () => {
    expect([...view.matchAll(/\.set\(/g)]).toHaveLength(1);
    expect(view).toMatch(/rt\.settings\.get\(\)/);
    expect(view).toMatch(/rt\.settings\.set\(\{ \.\.\.s, display:/);
    for (const word of ["autoLock", "lockOnScreenLock", "profile", "updateSettings", "hardLock", "lock("])
      expect(view, word).not.toContain(word);
    // no storage written by hand, no other storage read: the one chrome.* use is the change listener
    expect(view).not.toMatch(/storage\.(local|session|sync)\.(set|remove|clear|get)\b/);
    expect(view).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(
      [
        ...new Set([...view.matchAll(/\bchrome\.[a-zA-Z.]+/g)].map((m) => m[0].replace(/\.(add|remove)Listener$/, ""))),
      ].sort(),
    ).toEqual(["chrome.storage.StorageChange", "chrome.storage.local.onChanged"]);
  });

  it("the box and its hint are tied together for assistive technology; the dialog is modal to them", () => {
    expect(view).toMatch(/aria-describedby="view-hide-note"/);
    expect(view).toMatch(/id="view-hide-note"/);
    expect(view).toMatch(/"aria-modal": true/);
  });

  it("the parts are the settings record's own names, with Appearance's values, each from its own control", () => {
    const appearance = file("options/Appearance.tsx");
    for (const v of ["standard", "compact", "manual", "name", "auto", "light", "dark"]) {
      expect(view, v).toMatch(new RegExp(`\\["${v}", `));
      expect(appearance, v).toMatch(new RegExp(`\\["${v}", `));
    }
    expect(view).toMatch(/set\(\{\s*density\s*\}\)/);
    expect(view).toMatch(/set\(\{\s*sort\s*\}\)/);
    expect(view).toMatch(/set\(\{\s*hideCodes:/);
    expect(appearance).toMatch(/setDisplay\(\{\s*density\s*\}\)/);
    expect(appearance).toMatch(/setDisplay\(\{\s*sort\s*\}\)/);
    expect(appearance).toMatch(/setDisplay\(\{\s*hideCodes:/);
    // the theme: the same setter as Appearance's, which is the one that knows the key
    expect(view).toMatch(/setThemeChoice\(v\)/);
    expect(appearance).toMatch(/setThemeChoice\(v\)/);
    expect(importsOf(appearance).statics).toContain("../ui/theme-set");
  });
});

describe("keys, focus and listeners", () => {
  it("every key typed in the menu stops there; Escape closes; Tab goes round (the behaviour is view-menu.test.ts's)", () => {
    expect(view).toMatch(/function keys\(e: KeyboardEvent\) \{[^}]*e\.stopPropagation\(\)/);
    expect(view).toMatch(/onKeyDown: keys/);
    expect(view).toMatch(/"Escape"/);
    expect(view).toMatch(/"Tab"/);
  });

  it("the settings listener looks at the key's name and nothing else (as the worker's does: action-mode.ts)", () => {
    expect(view).toMatch(/"sk_settings" in c/);
    expect(view).not.toMatch(/newValue|oldValue/);
    expect(file("options/settings-store.ts")).not.toMatch(/newValue|oldValue/);
  });
});

describe("following changes made elsewhere, where it belongs", () => {
  it("the side panel and the settings page follow the theme at their entries, the settings page the record in its App", () => {
    for (const entry of ["sidepanel/main.tsx", "options/main.tsx"]) {
      expect(file(entry), entry).toMatch(/import \{ followTheme \} from "..\/ui\/theme-set"/);
      expect([...file(entry).matchAll(/followTheme\(\)/g)], entry).toHaveLength(1);
    }
    expect(file("options/Appearance.tsx")).toMatch(/followTheme\(setTheme\)/); // its radio
    expect(file("options/App.tsx")).toMatch(/watchSettings\(rt\)/);
    // the refresh goes behind the page's own saves, and hands the record to every panel (settings-refresh.test.ts)
    expect(file("options/settings-store.ts")).toMatch(/queue\.then\(async \(\) => \{[^}]*getSettings\(\)/);
  });

  it("there is one `storage` listener for the theme, in one place", () => {
    const users = files.filter((f) => /addEventListener\("storage"/.test(f.code)).map((f) => f.path);
    expect(users).toEqual(["ui/theme-set.ts"]);
    expect([...file("ui/theme-set.ts").matchAll(/win\.addEventListener\("storage", on\)/g)]).toHaveLength(1);
    expect([...file("ui/theme-set.ts").matchAll(/win\.removeEventListener\("storage", on\)/g)]).toHaveLength(1);
  });
});
