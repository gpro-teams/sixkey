// The Sync section's own catalog (catalogs/sync-<lang>.json, scripts/messages.py SYNC_EN / SYNC_ZH, and the managing
// screens' catalogs/sync-manage-<lang>.json, SYNC_MANAGE_EN / SYNC_MANAGE_ZH; both read by src/options/sync/text.ts st):
// the same rules as the full catalogs' (test/unit/i18n.test.ts), and the split itself.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const EXT = join(__dirname, "../..");
type Cat = Record<string, { message: string }>;
const load = (p: string) => JSON.parse(readFileSync(join(EXT, p), "utf8")) as Cat;
// the section's text is both files (the budget relief split the managing screens' text off: BUDGET-NOTES.md)
const mainEn = load("catalogs/sync-en.json");
const manageEn = load("catalogs/sync-manage-en.json");
const en = { ...mainEn, ...manageEn };
const zh = { ...load("catalogs/sync-zh_CN.json"), ...load("catalogs/sync-manage-zh_CN.json") };
// the words the section takes from t(): the settings page's core text, the one part loaded wherever the section is drawn
const coreEn = load("catalogs/settings-core-en.json");
const fullEn = load("_locales/en/messages.json");
const fullZh = load("_locales/zh_CN/messages.json");

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}
const SRC = join(EXT, "src");
const all = files(SRC).map((f) => ({
  path: f
    .slice(SRC.length + 1)
    .split("\\")
    .join("/"),
  text: readFileSync(f, "utf8"),
}));
const section = all.filter((f) => f.path.startsWith("options/sync/"));
const sectionText = section.map((f) => f.text).join("\n");
const subsOf = (s: string) => [...new Set([...s.matchAll(/\$(\d)/g)].map((m) => m[1]))].sort().join("");
// emoji and pictographs (the design's "no emoji"); Chinese punctuation and the middle dot are text
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/u;

describe("the Sync section's catalog", () => {
  it("exists, both languages have exactly the same keys, all named sync*", () => {
    expect(Object.keys(en).length).toBeGreaterThan(100);
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en)) expect(k).toMatch(/^sync[A-Z][A-Za-z0-9_]*$/);
  });
  it("is disjoint from the full catalogs (a key lives in one of them)", () => {
    for (const k of Object.keys(en)) expect(Object.hasOwn(fullEn, k), k).toBe(false);
  });
  it("placeholders match between languages, no stray dollar signs, nothing empty, no emoji", () => {
    for (const k of Object.keys(en)) {
      expect(subsOf(zh[k]!.message), k).toBe(subsOf(en[k]!.message));
      expect(en[k]!.message.replace(/\$\d/g, ""), k).not.toContain("$");
      expect(en[k]!.message.trim().length, k).toBeGreaterThan(0);
      expect(zh[k]!.message.trim().length, k).toBeGreaterThan(0);
      expect(EMOJI.test(en[k]!.message) || EMOJI.test(zh[k]!.message), k).toBe(false);
    }
    for (const k of ["frJoinSync", "syncBadgeTitle"])
      expect(EMOJI.test(fullEn[k]!.message) || EMOJI.test(fullZh[k]!.message), k).toBe(false);
  });
  it("every st('key') of the section exists in it, and every t('key') of the section in the full catalog and the settings page's core", () => {
    const st = [...sectionText.matchAll(/\bst\(\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]!);
    expect(st.length).toBeGreaterThan(50);
    for (const k of st) expect(en[k], `missing sync text: ${k}`).toBeDefined();
    const tKeys = [...sectionText.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]!);
    expect(tKeys.length).toBeGreaterThan(5);
    for (const k of tKeys) {
      expect(fullEn[k], `missing full-catalog text: ${k}`).toBeDefined();
      expect(coreEn[k], `not in the settings page's core text: ${k}`).toBeDefined();
    }
  });
  it("its two files are disjoint, each the same keys in both languages, and the managing screens' is not empty", () => {
    expect(Object.keys(manageEn).length).toBeGreaterThan(100);
    for (const k of Object.keys(manageEn)) expect(mainEn[k], k).toBeUndefined();
    expect(Object.keys(load("catalogs/sync-manage-zh_CN.json")).sort()).toEqual(Object.keys(manageEn).sort());
    expect(Object.keys(load("catalogs/sync-zh_CN.json")).sort()).toEqual(Object.keys(mainEn).sort());
  });
  it("every key is named in the section's code (no dead text), and only there", () => {
    for (const k of Object.keys(en)) expect(sectionText.includes(`"${k}"`), `unused sync text: ${k}`).toBe(true);
    const outside = all.filter((f) => !f.path.startsWith("options/sync/"));
    for (const k of Object.keys(en))
      expect(
        outside.filter((f) => f.text.includes(`"${k}"`)).map((f) => f.path),
        k,
      ).toEqual([]);
  });
  it("only the section reads it: one module imports the catalogs, and nothing else names their files", () => {
    const importers = all.filter((f) => /catalogs\/sync-/.test(f.text)).map((f) => f.path);
    expect(importers).toEqual(["options/sync/text.ts"]);
  });
  it("the section's text never goes through t() (it is not in the full catalog), nor the page's text through st()", () => {
    for (const [, k] of sectionText.matchAll(/\bt\(\s*"(sync[A-Z][A-Za-z0-9_]*)"/g))
      expect(["syncLabel", "syncOff"], k).toContain(k);
    for (const [, k] of sectionText.matchAll(/\bst\(\s*"([A-Za-z0-9_]+)"/g)) expect(k).toMatch(/^sync/);
  });
});
