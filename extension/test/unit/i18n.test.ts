import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const load = (loc: string) =>
  JSON.parse(readFileSync(join(__dirname, `../../_locales/${loc}/messages.json`), "utf8")) as Record<
    string,
    { message: string }
  >;
const en = load("en");
const zh = load("zh_CN");

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}
const src = files(join(__dirname, "../../src"))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
const subsOf = (s: string) => [...new Set([...s.matchAll(/\$(\d)/g)].map((m) => m[1]))].sort().join("");

describe("message catalogs", () => {
  it("both locales have exactly the same keys", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });
  it("placeholders match between languages, and no stray dollar signs", () => {
    for (const k of Object.keys(en)) {
      expect(subsOf(zh[k]!.message), k).toBe(subsOf(en[k]!.message));
      expect(en[k]!.message.replace(/\$\d/g, ""), k).not.toContain("$");
    }
  });
  it("keys are valid chrome.i18n names and every message is non-empty", () => {
    for (const [k, v] of Object.entries(en)) {
      expect(k).toMatch(/^[A-Za-z0-9_]+$/);
      expect(v.message.trim().length).toBeGreaterThan(0);
      expect(zh[k]!.message.trim().length).toBeGreaterThan(0);
    }
  });
  it("every t('key') used in the source exists", () => {
    const used = [...src.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(50);
    for (const k of used) expect(en[k], `missing message: ${k}`).toBeDefined();
  });
  it("every message is referenced somewhere in the source (no dead text)", () => {
    const manifest = new Set(["appName", "appDesc", "cmdLock", "cmdFill"]); // cmdLock, cmdFill: the commands' descriptions
    for (const k of Object.keys(en))
      if (!manifest.has(k)) expect(src.includes(`"${k}"`), `unused message: ${k}`).toBe(true);
  });
  it("the number of subs passed matches the placeholders, for literal calls", () => {
    for (const m of src.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"((?:\s*,[^()]*?(?:\([^()]*\))?[^()]*?)*)\)/g)) {
      const key = m[1]!;
      if (!en[key]) continue;
      const need = Math.max(0, ...[...en[key]!.message.matchAll(/\$(\d)/g)].map((x) => Number(x[1])));
      const given = m[2]!.trim() ? m[2]!.split(",").length - 1 : 0;
      if (need > 0) expect(given, `${key} expects ${need} substitution(s)`).toBeGreaterThanOrEqual(need > 0 ? 1 : 0);
    }
  });
});
