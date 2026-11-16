// The release gate of TOTP autofill's in-page suggestion (scripts/suggest-ui.mjs; AUTOFILL2 patch 4, AUTOFILL2-NOTES.md §12):
// the store build carries none of it until the gate is opened, dev and e2e builds always do, and opening it is one reviewed
// change of one constant.
//   - the constant, pinned here: flipping it means changing this test in the same change (with the README rows and the
//     store text), which is what makes it reviewed;
//   - one way the value reaches the code: scripts/suggest-ui.mjs → build.mjs's define (__SUGGEST_UI__) and check-dist; read
//     in the source only as a constant of the module that branches on it, in exactly the modules listed below.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SUGGEST_UI_IN_STORE_BUILD, suggestUiIn } from "../../scripts/suggest-ui.mjs";

const EXT = resolve(__dirname, "../..");
function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(n)) out.push(p);
  }
  return out;
}
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
const sources = [...files(join(EXT, "src")), ...files(join(EXT, "scripts"))].map((f) => ({
  path: f
    .slice(EXT.length + 1)
    .split("\\")
    .join("/"),
  text: code(readFileSync(f, "utf8")),
}));

describe("the in-page suggestion's release gate", () => {
  it("is closed for the store build; dev and e2e builds always carry the suggestion", () => {
    expect(SUGGEST_UI_IN_STORE_BUILD).toBe(false); // the flip: true, in the change that ships it (see the header)
    expect(suggestUiIn("prod")).toBe(SUGGEST_UI_IN_STORE_BUILD);
    expect(suggestUiIn("dev")).toBe(true);
    expect(suggestUiIn("e2e")).toBe(true);
  });

  it("has one source: scripts/suggest-ui.mjs, read by the build and check-dist; nothing from the environment", () => {
    const importers = sources
      .filter((f) => /(?:from|import)\s*\(?\s*["'][^"']*suggest-ui\.mjs["']/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(importers).toEqual(["scripts/build.mjs", "scripts/check-dist.mjs"]);
    const build = sources.find((f) => f.path === "scripts/build.mjs")!.text;
    expect(build).toMatch(/const suggestUi = suggestUiIn\(flavour\);/);
    expect([...build.matchAll(/__SUGGEST_UI__/g)].length).toBe(1);
    expect(build).toMatch(/__SUGGEST_UI__: JSON\.stringify\(suggestUi\)/);
    expect(build).not.toMatch(/process\.env\.[A-Z_]*SUGGEST/);
  });

  it("is read in the source only where the code branches on it, each time as a constant of that module", () => {
    const readers = sources
      .filter((f) => f.path.startsWith("src/") && f.text.includes("__SUGGEST_UI__"))
      .map((f) => f.path)
      .sort();
    // the worker's (the message table, the channel, its wiring, request v2) and the surface's (App, which starts the input
    // delay; the lock screen; the Fill chunk). Their helpers (content-page*.ts, page-open.ts, page-delay.ts, page-lock.ts,
    // page-fill.ts) are reached only through these modules' gated code, so a build with the gate closed has none of them.
    // And the content script's (patch 4b): its listener, or the suggestion (./suggest-ui.ts and ./suggest-arm.ts, which a
    // build with the gate closed does not even load: scripts/suggest-guard.mjs)
    expect(readers).toEqual([
      "src/background/sw.ts",
      "src/inject/suggest.ts",
      "src/platform/content-channel.ts",
      "src/platform/fill-request.ts",
      "src/platform/sender-policy.ts",
      "src/popup/App.tsx",
      "src/popup/main/Fill.tsx",
      "src/popup/screens/Locked.tsx",
    ]);
    for (const p of readers) {
      const t = sources.find((f) => f.path === p)!.text;
      expect(t, p).toMatch(/const SUGGEST_UI = typeof __SUGGEST_UI__ === "boolean" && __SUGGEST_UI__;/);
      expect([...t.matchAll(/__SUGGEST_UI__/g)].length, p).toBe(3); // the declare, and the one constant
    }
  });
});
