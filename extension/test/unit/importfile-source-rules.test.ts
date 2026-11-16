// File import and camera scan (IMPORT-FILE-NOTES.md §7): rules that hold by construction in the source, which nothing
// at run time would notice breaking. The popup's module graph holds none of the new modules (its bytes and budget stay
// as they are); the pure readers touch no browser API; nothing new logs; only Add account's click deletes a file, and
// only file-access.ts calls remove() on a handle; only the settings page's camera calls getUserMedia.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { popupKeys } from "../../scripts/catalog-keys.mjs";

const EXT = resolve(__dirname, "../..");
const SRC = join(EXT, "src");
function sources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const files = sources().map((p) => ({ path: relative(SRC, p).split("\\").join("/"), text: readFileSync(p, "utf8") }));
/** The code of a file without its comments (line comments and block comments), so a rule reads code only. */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const at = (re: RegExp) => files.filter((f) => re.test(code(f.text))).map((f) => f.path);

const NEW = [
  "core/import/file-formats.ts",
  "core/import/file-text.ts",
  "core/import/file-plan.ts",
  "core/import/scan-batch.ts",
  "platform/camera.ts",
  "platform/file-access.ts",
  "options/import-read.ts",
  "options/import-handoff.ts",
  "options/AddCamera.tsx",
];
const PURE = NEW.filter((p) => p.startsWith("core/"));

describe("file import: source rules", () => {
  it("finds the new modules (so the rules below are not vacuous)", () => {
    for (const p of NEW)
      expect(
        files.some((f) => f.path === p),
        p,
      ).toBe(true);
  });

  it("the popup's module graph holds none of them", () => {
    const popup = popupKeys(EXT).modules;
    expect(popup).toContain("src/core/import/importer.ts"); // the popup's confirm page: the graph is the real one
    for (const p of NEW) expect(popup, p).not.toContain(`src/${p}`);
  });

  it("the readers in core touch no browser API: no chrome.*, DOM, network or storage", () => {
    for (const p of PURE) {
      const t = code(files.find((f) => f.path === p)!.text);
      expect(t, p).not.toMatch(
        /\bchrome\.|\bdocument\b|\bwindow\b|\bnavigator\b|\blocalStorage\b|\bindexedDB\b|\bfetch\b/,
      );
    }
  });

  it("nothing new logs: no console, no logError, no diagnostics record", () => {
    for (const p of NEW) {
      const t = code(files.find((f) => f.path === p)!.text);
      expect(t, p).not.toMatch(/\bconsole\.|\blogError\b|\bdiag\(/);
    }
    for (const p of ["options/AddAccounts.tsx"])
      expect(code(files.find((f) => f.path === p)!.text), p).not.toMatch(/\bconsole\.|\blogError\b/);
  });

  it("a file is deleted only by file-access.ts, from Add account's Delete click", () => {
    expect(at(/\bhandle\.remove\(/)).toEqual(["platform/file-access.ts"]);
    for (const p of [...NEW, "options/AddAccounts.tsx", "options/Backup.tsx"].filter(
      (x) => x !== "platform/file-access.ts",
    ))
      expect(code(files.find((f) => f.path === p)!.text), p).not.toMatch(/\.remove\(\s*\)|\bremoveEntry\(/);
    expect(at(/\bdeletePicked\(/).sort()).toEqual(["options/AddAccounts.tsx", "platform/file-access.ts"]);
    const add = code(files.find((f) => f.path === "options/AddAccounts.tsx")!.text);
    // its one caller is remove(), and remove() is called only from the delete prompt's onDelete, a click
    expect(add.match(/\bdeletePicked\(/g)).toHaveLength(1);
    expect(add).toMatch(/async function remove\(a: Ask\) \{[\s\S]{0,300}?deletePicked\(a\.handle, a\.seen\)/);
    expect(add.match(/\bremove\(a\)/g)).toHaveLength(1);
    expect(add).toMatch(/onDelete=\{\(a\) => void remove\(a\)\}/);
    expect(add).toMatch(/onClick=\{\(\) => onDelete\(a\)\}/);
  });

  it("only the settings page's camera opens a camera", () => {
    expect(at(/\bgetUserMedia\s*\(/).sort()).toEqual(["options/AddCamera.tsx", "platform/camera.ts"]);
    expect(at(/\bnew CameraScan\(/)).toEqual(["options/AddCamera.tsx"]);
  });
});
