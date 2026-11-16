// Rules about the source of recovery code shares (docs/design/notes/SHAMIR-NOTES.md §5, §7) that hold by construction and
// that no run-time check would notice a new line breaking. Comments are not code.
//   - What the popup's lazy share entry may import: nothing of the popup's main chunk (a lazy chunk importing one of its
//     modules splits that chunk in two, about 500 B of the counted bundle, measured); the popup loads it by import() only.
//   - The shares, the rebuilt code and R are never written anywhere by the pages: no storage, no log, no clipboard, no URL.
//   - The one reading of Crockford text (crockford.ts) is the recovery code's and the shares' alike.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { normalizeCrockford, CROCKFORD } from "../../src/core/crypto/crockford";
import { normalizeRecoveryInput } from "../../src/core/crypto/recovery-code";

const EXT = resolve(__dirname, "../..");
const ROOT = join(EXT, "src");
function sources(dir = ROOT): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
const files = sources().map((p) => {
  const text = readFileSync(p, "utf8");
  return { path: relative(ROOT, p).split("\\").join("/"), text, code: code(text) };
});
const file = (p: string) => files.find((f) => f.path === p)!;
/** A module's static imports (not `import type`), as written. */
const imports = (p: string) =>
  [...file(p).code.matchAll(/^import (?!type\b)[^;]*?from "([^"]+)";|^import "([^"]+)";/gm)].map((m) => m[1] ?? m[2]);

describe("what the shares' lazy chunks import", () => {
  it("core/crypto/shares.ts imports only its two leaf modules, which import nothing", () => {
    expect(imports("core/crypto/shares.ts").sort()).toEqual(["./crockford", "./crypto-error"]);
    expect(imports("core/crypto/crockford.ts")).toEqual([]);
    expect(imports("core/crypto/crypto-error.ts")).toEqual([]);
  });
  it("ui/ShareEntry.tsx imports no module of the popup's main chunk: the lock key and the code's formatter are props", () => {
    expect(imports("ui/ShareEntry.tsx").sort()).toEqual(
      [
        "preact/hooks",
        "../core/crypto/crockford",
        "../core/crypto/shares",
        "./i18n",
        "./share-text",
        "./share-entry.css",
      ].sort(),
    );
    expect(imports("ui/share-text.ts")).toEqual(["./lazy-text"]);
  });
  it("the popup, the settings page and the wizard load the entry and the wizard by import() only", () => {
    const lazyOnly = (target: RegExp) =>
      files.filter((f) => imports(f.path).some((i) => target.test(i!))).map((f) => f.path);
    expect(lazyOnly(/(^|\/)ShareEntry$/)).toEqual(["options/ShareWizard.tsx"]); // itself a lazy chunk
    expect(lazyOnly(/(^|\/)ShareWizard$/)).toEqual([]);
    expect(file("popup/screens/Locked.tsx").code).toMatch(/import\("\.\.\/\.\.\/ui\/ShareEntry"\)/);
    expect(file("options/RecoveryCodeInput.tsx").code).toMatch(/import\("\.\.\/ui\/ShareEntry"\)/);
    expect(file("options/Security.tsx").code).toMatch(/import\("\.\/ShareWizard"\)/);
  });
});

describe("nothing of a share, the rebuilt code or R is kept by the pages", () => {
  const PAGES = ["ui/ShareEntry.tsx", "options/ShareWizard.tsx", "options/RecoveryCodeInput.tsx", "ui/share-text.ts"];
  it("no storage, no log, no clipboard, no address, no message", () => {
    for (const p of PAGES) {
      const c = file(p).code;
      expect(c, p).not.toMatch(/chrome\.storage\.(?:local|sync|session)\.(?:set|get)\b/);
      expect(c, p).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB)\b/);
      expect(c, p).not.toMatch(/\bconsole\./);
      expect(c, p).not.toMatch(/\bclipboard\b|writeText/); // no Copy: the system clipboard can leave the computer
      expect(c, p).not.toMatch(/location\.(?:hash|href|search)\s*=|history\.(?:push|replace)State/);
      expect(c, p).not.toMatch(/\bsendMessage\b|postMessage/);
    }
  });
  it("errors are logged by what failed, never with what was typed", () => {
    for (const p of PAGES)
      for (const m of file(p).code.matchAll(/logError\(([^)]*)\)/g)) expect(m[1], p).toMatch(/^"[^"]+", e$/);
  });
  it("the wizard's done screen keeps no share (the review's F5): its step holds the mode, the threshold, the count", () => {
    const c = file("options/ShareWizard.tsx").code;
    expect(c).toMatch(/\| \{ at: "done"; mode: PreparedShares\["mode"\]; threshold: number; count: number \}/);
    expect(c).toMatch(
      /const done = \(h: PreparedShares\): Step => \(\{ at: "done", mode: h\.mode, threshold: h\.threshold, count: h\.count \}\);/,
    );
    expect(c.match(/go\(done\(h\)\)/g)).toHaveLength(2); // the switch, and split's check
  });
  it("a start of the browser (onStartup) and of Sixkey (onInstalled) both make the shares reminder due", () => {
    // the browser tests reach only onInstalled (a relaunch loads Sixkey from the command line), so this holds onStartup
    const c = file("background/sw.ts").code;
    for (const ev of ["onStartup", "onInstalled"]) {
      const body = c.match(new RegExp(`chrome\\.runtime\\.${ev}\\.addListener\\(\\(\\) => \\{([\\s\\S]*?)\\n\\}\\);`));
      expect(body?.[1], ev).toMatch(/void rt\.service\.browserStarted\(\)\.catch\(\(\) => undefined\);/);
    }
  });
  it("the share fields are password fields until Show, autocomplete off, no name", () => {
    const c = file("ui/ShareEntry.tsx").code;
    expect(c).toMatch(/type=\{shown \? "text" : "password"\}/);
    expect(c).toMatch(/autoComplete="off"/);
    expect(c).not.toMatch(/\bname=/);
  });
});

describe("the Crockford reading", () => {
  it("the recovery code's reading is crockford.ts's, so a share is read exactly as a recovery code (property)", () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom(..."0123456789abcdefghijklmnopqrstuvwxyzOIL -_ ") }), (s) => {
        expect(normalizeRecoveryInput(s)).toBe(normalizeCrockford(s));
      }),
    );
    expect(CROCKFORD).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
    expect(normalizeCrockford("o0-Il i_1 ")).toBe("001111"); // o O as 0; i I l L as 1
  });
});
