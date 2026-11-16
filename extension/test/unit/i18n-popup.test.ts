// The popup-only catalog on this tree (scripts/catalog-keys.mjs, scripts/build.mjs): the full catalog holds every key in
// both languages (the settings page loads it in parts: test/unit/budget-split.test.ts); the popup loads a part of it that
// holds every key popup code can use, with the same text. Some
// checks here deliberately share no code with the collector (a plain text scan of the popup's folders, and the error
// texts compared under both catalogs), so a collector that drops a key fails them on its own.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { popupKeys, readCatalogs, subsetCatalog, type Collected } from "../../scripts/catalog-keys.mjs";
import { fullCatalog } from "../../src/ui/catalog-full";
import { describeError, errorLine, sectionOf } from "../../src/ui/errors";
import { loadCatalog, setLangChoice, t, type Catalog, type CatalogSource } from "../../src/ui/i18n";

const ROOT = resolve(__dirname, "../..");
const LANGS = ["en", "zh_CN"] as const;
const catalogs = readCatalogs(ROOT) as Record<(typeof LANGS)[number], Catalog>;
const ALL = Object.keys(catalogs.en);
let popup: Collected;
let popupSource: CatalogSource;
beforeAll(() => {
  popup = popupKeys(ROOT); // throws, listing every problem, if the tree has a lookup it cannot follow
  popupSource = async (lang) => subsetCatalog(catalogs[lang], popup.keys, lang);
}, 30_000);
afterAll(async () => {
  setLangChoice("en");
  await loadCatalog(fullCatalog);
});

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx?$/.test(n) && !n.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const rel = (f: string) =>
  f
    .slice(ROOT.length + 1)
    .split("\\")
    .join("/");

describe("the full catalog", () => {
  it("is every key, in both languages, exactly as _locales has it", async () => {
    expect(Object.keys(catalogs.zh_CN)).toEqual(ALL);
    for (const lang of LANGS) {
      const c = await fullCatalog(lang);
      expect(c).toEqual(catalogs[lang]);
      expect(Object.keys(c).length).toBe(ALL.length);
    }
  });
  it("no page loads it (the settings page loads its parts first, core before anything), and nothing in the popup's graph can load it", () => {
    const options = readFileSync(join(ROOT, "src/options/main.tsx"), "utf8");
    expect(options).toMatch(/void loadParts\(\["core"\]\)\.then\(\(\) => render\(<App \/>/);
    expect(options).not.toMatch(/catalog-full|fullCatalog|_locales/);
    // the popup and the side panel both start from boot.tsx, which loads the popup's catalog and nothing else
    const main = readFileSync(join(ROOT, "src/popup/boot.tsx"), "utf8");
    expect(main).toMatch(/loadCatalog\(popupCatalog\)/);
    expect([...main.matchAll(/import\("([^"]+)"\)/g)].map((m) => m[1]).sort()).toEqual([
      "virtual:popup-catalog/en",
      "virtual:popup-catalog/zh_CN",
    ]);
    for (const entry of ["src/popup/main.tsx", "src/sidepanel/main.tsx"]) {
      const e = readFileSync(join(ROOT, entry), "utf8");
      expect(e, entry).toMatch(/\bboot\("(popup|panel)"\)/);
      expect(e, entry).not.toMatch(/catalog-full|fullCatalog|_locales|loadCatalog|import\(/);
    }
    expect(popup.modules).toContain("src/sidepanel/main.tsx"); // the panel's own code is read for the same catalog
    expect(popup.modules).not.toContain("src/ui/catalog-full.ts");
    expect(popup.modules.filter((m) => m.startsWith("src/options/"))).toEqual([]);
  });
});

describe("the popup's catalog", () => {
  it("is a part of the full one, with the same keys and text in both languages", async () => {
    const want = new Set(popup.keys);
    expect(popup.keys.length).toBeGreaterThan(100);
    expect(popup.keys.length).toBeLessThan(ALL.length - 100); // the point of it: the settings page's text stays out
    expect(ALL.filter((k) => want.has(k))).toEqual(popup.keys); // catalog order, no strangers
    for (const lang of LANGS) {
      const c = await popupSource(lang);
      expect(Object.keys(c)).toEqual(popup.keys);
      for (const k of popup.keys) expect(c[k], `${lang} ${k}`).toEqual(catalogs[lang][k]);
    }
  });

  it("covers the popup's modules: lazy chunks and shared code, never the settings page", () => {
    for (const m of [
      "src/popup/main.tsx",
      "src/popup/App.tsx",
      "src/popup/main/AddConfirm.tsx",
      "src/core/site-domains.ts",
      "src/lib/qr.ts",
      "src/core/import/importer.ts",
      "src/ui/errors.ts",
      "src/ui/i18n.ts",
      "src/core/service/service-core.ts",
    ])
      expect(popup.modules, m).toContain(m);
    // the rest of the service (VaultService: the settings page's key operations) and the runtime that builds it are the
    // settings page's and the service worker's only (budget relief)
    for (const m of ["src/core/service/service.ts", "src/platform/runtime.ts"])
      expect(popup.modules, m).not.toContain(m);
  });

  it("is traced from t(), not only kept by mention: parameters, tables, destructuring, map columns", () => {
    // each of these reaches t() through something other than a literal argument (src/ui/errors.ts, AddMenu.tsx, AddConfirm.tsx, Locked.tsx)
    for (const k of [
      "advancedTitle",
      "backupTitle",
      "errNextBackupPw",
      "errorTitle",
      "errRead",
      "newerBody",
      "optGoogleD",
      "optScan",
      "rTooLarge",
      "rMalformed",
      "wrongRecovery",
      "recoveryLabel",
      "secNoticeBad",
    ])
      expect(popup.traced, k).toContain(k);
    for (const k of ["frSoloTitle", "secLogNewer", "lockOnScreenLock"]) expect(popup.traced, k).not.toContain(k);
    expect(popup.keys).toContain("lockOnScreenLock"); // a settings field of the same name (core code): mentioned, so kept
  });

  it("holds every key that popup and shared UI code passes to t() as a literal (a text scan, not the collector)", () => {
    const want = new Set(popup.keys);
    // (the View menu's text is not the popup's: it comes with the menu, test/unit/view-catalog.test.ts)
    const scanned = [...files(join(ROOT, "src/popup")), ...files(join(ROOT, "src/ui"))].filter(
      (f) => !f.endsWith("popup/main/View.tsx"),
    );
    let n = 0;
    for (const f of scanned) {
      for (const m of readFileSync(f, "utf8").matchAll(/\bt\(\s*["'`]([A-Za-z0-9_]+)["'`]/g)) {
        n++;
        expect(want.has(m[1]!), `${rel(f)}: t("${m[1]}") is not in the popup catalog`).toBe(true);
      }
    }
    expect(n).toBeGreaterThan(150);
  });

  for (const lang of LANGS) {
    it(`${lang}: every error text (src/ui/errors.ts) is the same with the popup's catalog as with the full one`, async () => {
      // Every code and class name errors.ts knows, and some it does not: every identifier in its source, plus errors.
      const words = [
        ...new Set(readFileSync(join(ROOT, "src/ui/errors.ts"), "utf8").match(/\b[A-Za-z][A-Za-z0-9_]*\b/g)!),
      ];
      const cases: unknown[] = [
        ...words,
        ...words.map((w) => ({ code: w })),
        ...words.map((w) => ({ name: w })),
        new TypeError("x"),
        new DOMException("q", "QuotaExceededError"),
        null,
        42,
      ];
      setLangChoice(lang);
      await loadCatalog(fullCatalog);
      const full = cases.map((e) => [describeError(e), errorLine(e), sectionOf(e)]);
      await loadCatalog(popupSource);
      const pop = cases.map((e) => [describeError(e), errorLine(e), sectionOf(e)]);
      expect(pop).toEqual(full);
      for (const [d] of pop as [{ what: string; next: string }][])
        for (const s of [d.what, d.next]) expect(ALL, s).not.toContain(s); // never a key name
    });
    it(`${lang}: t() gives the same text with the popup's catalog for every key it holds`, async () => {
      setLangChoice(lang);
      await loadCatalog(fullCatalog);
      const full = popup.keys.map((k) => t(k, 1, "x", 3));
      await loadCatalog(popupSource);
      expect(popup.keys.map((k) => t(k, 1, "x", 3))).toEqual(full);
      expect(t("frSoloTitle")).toBe("frSoloTitle"); // a settings-page key is not there: shown as its name, which the e2e guard reports
    });
  }
});

describe("the test-build guard in t()", () => {
  it("reports a key with no text when the build turns it on, and stays silent otherwise", async () => {
    const g = globalThis as { __I18N_GUARD__?: boolean; location?: unknown };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      t("no_such_key_anywhere");
      expect(errors).not.toHaveBeenCalled(); // this module was loaded without the define, as in a prod build
      vi.resetModules();
      g.__I18N_GUARD__ = true;
      g.location ??= { pathname: "/popup/index.html" };
      const fresh = await import("../../src/ui/i18n");
      await fresh.loadCatalog(async () => ({ hello: { message: "Hello" } }));
      expect(fresh.t("hello")).toBe("Hello");
      expect(errors).not.toHaveBeenCalled();
      expect(fresh.t("missingKey")).toBe("missingKey"); // the same fallback as ever
      expect(errors).toHaveBeenCalledWith('sixkey i18n: no text for "missingKey" on /popup/index.html');
    } finally {
      delete g.__I18N_GUARD__;
      errors.mockRestore();
      vi.resetModules();
    }
  });
});
