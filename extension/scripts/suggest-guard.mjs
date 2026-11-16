// The in-page suggestion's graph guard (the patch 4 plan's R2-S1; AUTOFILL2-NOTES.md §13), for the build of the content
// script inject/suggest.js (scripts/build.mjs). With the release gate closed (scripts/suggest-ui.mjs), the suggestion's
// modules are not even loaded: src/inject/suggest.ts's import of ./suggest-ui resolves to an empty module of this plugin's,
// and the build fails if its module graph holds either module all the same (a static import left behind a dead branch
// still loads the module, so the bundler's tree-shaking alone is not the guard). With the gate open, it does nothing.
// Exported for its test (test/unit/autofill4b-build.test.ts).
const UI = /[\\/]src[\\/]inject[\\/]suggest-(?:ui|arm)\.ts$/;
export const SUGGEST_OFF = "\0sixkey-suggest-off";

/** The plugin, for a build whose gate is `on`. */
export function suggestGuard(on) {
  return {
    name: "sixkey-suggest-guard",
    enforce: "pre", // before Vite's own resolver, which would resolve the import to the module itself
    resolveId(source, importer) {
      if (on || !importer || !/[\\/]src[\\/]inject[\\/]/.test(importer)) return null;
      return /^\.\/suggest-(?:ui|arm)(?:\.ts)?$/.test(source) ? SUGGEST_OFF : null;
    },
    load(id) {
      return !on && id === SUGGEST_OFF ? "export const startSuggestion = () => undefined;" : null;
    },
    buildEnd(err) {
      if (err || on) return;
      const bad = [...this.getModuleIds()].map((id) => id.replace(/\?.*$/, "")).filter((id) => UI.test(id));
      if (bad.length)
        this.error(
          `a build whose release gate keeps the in-page suggestion out must not contain it: ${bad.join(", ")}`,
        );
    },
  };
}
