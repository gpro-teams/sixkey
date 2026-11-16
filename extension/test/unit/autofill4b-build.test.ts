// TOTP autofill Stage 2, patch 4b (docs/design/notes/AUTOFILL2-NOTES.md §13): the in-page suggestion's graph guard
// (scripts/suggest-guard.mjs; the patch 4 plan's R2-S1). With the release gate closed the content script's import of the
// suggestion resolves to an empty module, and a build whose module graph holds the suggestion's modules all the same fails;
// with the gate open it does nothing. The plugin's three hooks one by one, then two real bundles of the content script.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { SUGGEST_OFF, suggestGuard } from "../../scripts/suggest-guard.mjs";

const EXT = resolve(__dirname, "../..");
const SUGGEST = join(EXT, "src/inject/suggest.ts");

describe("the guard's hooks", () => {
  it("gate closed: the content script's import of the suggestion resolves to its empty module", () => {
    const g = suggestGuard(false);
    expect(g.enforce).toBe("pre"); // before Vite's resolver, which would find the module itself
    for (const s of ["./suggest-ui", "./suggest-ui.ts", "./suggest-arm", "./suggest-arm.ts"]) {
      expect(g.resolveId(s, SUGGEST), s).toBe(SUGGEST_OFF);
      expect(g.resolveId(s, "C:\\sixkey\\extension\\src\\inject\\suggest.ts"), s).toBe(SUGGEST_OFF);
    }
    for (const [s, from] of [
      ["./suggest-core", SUGGEST],
      ["./suggest-uix", SUGGEST],
      ["../inject/suggest-ui", join(EXT, "src/popup/App.tsx")],
      ["./suggest-ui", join(EXT, "src/popup/suggest.ts")],
      ["./suggest-ui", undefined],
    ] as const)
      expect(g.resolveId(s, from), `${s} from ${from}`).toBeNull();
    expect(g.load(SUGGEST_OFF)).toBe("export const startSuggestion = () => undefined;");
    expect(g.load(join(EXT, "src/inject/suggest-ui.ts"))).toBeNull();
  });
  it("gate open: nothing is resolved or loaded", () => {
    const g = suggestGuard(true);
    expect(g.resolveId("./suggest-ui", SUGGEST)).toBeNull();
    expect(g.load(SUGGEST_OFF)).toBeNull();
  });
  const end = (on: boolean, ids: string[], err?: unknown) => {
    const errors: string[] = [];
    suggestGuard(on).buildEnd.call(
      {
        getModuleIds: () => ids,
        error: (m: string) => {
          errors.push(m);
          throw new Error(m);
        },
      },
      err,
    );
    return errors;
  };
  it("gate closed: a graph holding either module of the suggestion fails the build", () => {
    const ui = join(EXT, "src/inject/suggest-ui.ts");
    const arm = join(EXT, "src/inject/suggest-arm.ts");
    expect(() => end(false, [SUGGEST, SUGGEST_OFF, arm])).toThrow(
      /a build whose release gate keeps the in-page suggestion out must not contain it: .*suggest-arm\.ts/,
    );
    expect(() => end(false, [SUGGEST, `${ui}?x=1`])).toThrow(/must not contain it: .*suggest-ui\.ts/);
    expect(() => end(false, [SUGGEST, "C:\\x\\src\\inject\\suggest-ui.ts"])).toThrow(/must not contain it/);
    expect(end(false, [SUGGEST, SUGGEST_OFF, join(EXT, "src/inject/suggest-core.ts")])).toEqual([]);
  });
  it("gate open, or a build already failing: no check", () => {
    expect(end(true, [SUGGEST, join(EXT, "src/inject/suggest-ui.ts")])).toEqual([]);
    expect(end(false, [join(EXT, "src/inject/suggest-ui.ts")], new Error("before"))).toEqual([]);
  });
});

describe("two real bundles of the content script with the gate closed", () => {
  const work = mkdtempSync(join(tmpdir(), "sixkey-4b-guard-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const bundle = async (input: string) => {
    const out = (await build({
      configFile: false,
      logLevel: "silent",
      root: EXT,
      plugins: [suggestGuard(false)],
      define: { __SUGGEST_UI__: "false", __SUGGEST_DBG__: "false" },
      build: {
        write: false,
        minify: false,
        rollupOptions: { input, output: { format: "iife", codeSplitting: false } },
      },
    })) as { output: { type: string; code?: string }[] }[] | { output: { type: string; code?: string }[] };
    const o = Array.isArray(out) ? out[0]! : out;
    return o.output
      .filter((c) => c.type === "chunk")
      .map((c) => c.code ?? "")
      .join("\n");
  };
  it("the content script itself: built, with none of the suggestion in it", async () => {
    const code = await bundle(SUGGEST);
    expect(code).toContain("sk-af-cand");
    for (const mark of ["sk-af-open", "attachShadow", "IntersectionObserver", "afSugFill", "takeRecords"])
      expect(code, mark).not.toContain(mark);
  }, 60_000);
  it("an import of the suggestion that the empty module does not take (another path): the build fails", async () => {
    const entry = join(work, "entry.ts");
    writeFileSync(
      entry,
      `import { judge } from ${JSON.stringify(join(EXT, "src/inject/suggest-arm.ts"))};\nconsole.log(judge);\n`,
    );
    await expect(bundle(entry)).rejects.toThrow(/must not contain it: .*suggest-arm\.ts/);
  }, 60_000);
});
