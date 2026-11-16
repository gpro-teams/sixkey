// The View menu's text (docs/design/notes/QUICKVIEW-NOTES.md): catalogs/view-<lang>.json, loaded when the menu opens. Held
// to the code the way the settings page's parts are (budget-split.test.ts): the build works out which keys
// src/popup/main/View.tsx can show, every one of them must be in the file or in the popup's catalog, every key in the file
// must be one the menu uses, and the popup's own counted catalog must not carry the menu's words.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { popupKeys, readCatalogs, VIEW_ENTRIES, viewKeys } from "../../scripts/catalog-keys.mjs";

const EXT = resolve(__dirname, "../..");
type Cat = Record<string, { message: string }>;
const json = (p: string) => JSON.parse(readFileSync(join(EXT, p), "utf8")) as Cat;
const full = readCatalogs(EXT) as Record<string, Cat>;
const view = viewKeys(EXT);
const popup = popupKeys(EXT);

describe("the menu's catalog and the menu's code", () => {
  it("the file holds exactly the keys the code can show, or the popup's catalog has them (and the ones it lists twice are said)", () => {
    const own = Object.keys(json("catalogs/view-en.json"));
    expect(view.keys.length).toBeGreaterThan(10); // not vacuous: the collector read the menu
    // every key the menu uses is in its file or in the popup's catalog (both are loaded together)
    expect(view.keys.filter((k) => !own.includes(k) && !popup.keys.includes(k))).toEqual([]);
    // every key in the file is used by the menu: nothing is loaded that is never shown
    expect(own.filter((k) => !view.keys.includes(k))).toEqual([]);
  });

  it("is the full catalogs' text, with the same keys in both languages", () => {
    const en = json("catalogs/view-en.json");
    const zh = json("catalogs/view-zh_CN.json");
    expect(Object.keys(zh)).toEqual(Object.keys(en));
    for (const k of Object.keys(en)) {
      expect(en[k], k).toEqual(full.en![k]);
      expect(zh[k], k).toEqual(full.zh_CN![k]);
    }
  });

  it('the Chinese hint keeps "5 秒" together (a no-break space), so a narrow menu does not leave "秒。" alone on a line', () => {
    expect(json("catalogs/view-zh_CN.json").listRevealHint!.message).toMatch(/5\u00a0秒。$/);
    expect(json("catalogs/settings-general-zh_CN.json").listRevealHint!.message).toMatch(/5\u00a0秒。$/); // the same text everywhere
  });

  it("reuses Appearance's words for the choices the settings page has (nothing translated twice), with two short forms of its own", () => {
    const own = Object.keys(json("catalogs/view-en.json"));
    const settings = new Set(["general", "core"].flatMap((p) => Object.keys(json(`catalogs/settings-${p}-en.json`))));
    expect(own.filter((k) => settings.has(k)).sort()).toEqual(
      [
        "listRevealHint",
        "lookDensity",
        "lookDensityCompact",
        "lookDensityStandard",
        "lookSort",
        "lookSortManual",
        "lookSortName",
        "lookTheme",
        "lookThemeDark",
        "lookThemeLight",
      ].sort(),
    );
    expect(own.filter((k) => !settings.has(k) && !popup.keys.includes(k)).sort()).toEqual(["viewAuto", "viewHide"]);
    // the names the menu shows are the ones Settings shows
    const general = json("catalogs/settings-general-en.json");
    for (const k of ["lookTheme", "lookThemeLight", "lookThemeDark", "lookDensity", "lookSort", "lookSortName"])
      expect(json("catalogs/view-en.json")[k], k).toEqual(general[k]);
  });
});

describe("the popup's counted catalog", () => {
  it("does not carry the words only the menu uses, but has the button's name; its walk stops at the menu", () => {
    for (const k of ["viewAuto", "viewHide", "lookTheme", "lookDensity", "lookSort", "lookThemeDark"])
      expect(popup.keys, k).not.toContain(k);
    expect(popup.keys).toContain("lookTitle"); // the button's name (Main.tsx), as Settings calls the section
    expect(popup.keys).toContain("listRevealHint"); // the list's own tooltip: in both
    for (const m of VIEW_ENTRIES) {
      expect(popup.modules, m).not.toContain(m);
      expect(view.modules, m).toContain(m);
    }
    // what the menu imports besides React-like code: the settings types (a type), the theme helpers, the popup's catalog source
    expect(view.modules.filter((m) => m.startsWith("src/options/"))).toEqual([]);
    expect(view.modules).not.toContain("src/ui/catalog-full.ts");
  });
});

describe("messages.py", () => {
  const top = mkdtempSync(join(tmpdir(), "sixkey-view-messages-"));
  afterAll(() => rmSync(top, { recursive: true, force: true }));
  let n = 0;
  /** The generator in a private copy, with one more fragment; its exit status and what it said. */
  function generate(fragment: string) {
    const dir = join(top, `m${++n}`);
    for (const p of ["scripts", "_locales", "catalogs", "manifest.base.json", "manifest.dev.json", "manifest.e2e.json"])
      cpSync(join(EXT, p), join(dir, p), { recursive: true });
    cpSync(join(EXT, "src"), join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "scripts/i18n/zz_extra.py"), fragment);
    const r = spawnSync("python3", ["scripts/messages.py"], { cwd: dir, encoding: "utf8" });
    return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`, dir };
  }

  it("refuses a VIEW key that is not a key of the full catalogs, and one listed twice", () => {
    let r = generate('VIEW = ["noSuchKey"]\n');
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(
      /VIEW lists 'noSuchKey', which is not a key: only keys of the full catalogs go in the view part/,
    );
    r = generate('VIEW = ["lookTheme"]\n');
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/VIEW lists 'lookTheme', which scripts\/i18n\/quickview\.py lists too/);
    r = generate("VIEW = 3\n");
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/VIEW must be a list of keys/);
  });

  it("writes the view part from the fragments' lists, and measures it against its budget", () => {
    const r = generate('VIEW = ["lookCodes"]\n'); // one more existing key
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toMatch(/view 13 keys, \d+ of 2048 B/);
    const en = JSON.parse(readFileSync(join(r.dir, "catalogs/view-en.json"), "utf8")) as Cat;
    expect(en.lookCodes).toEqual(full.en!.lookCodes);
    expect(Object.keys(en)).toHaveLength(13);
  });
});
