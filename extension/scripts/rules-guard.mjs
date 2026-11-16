// The site rules' updater's graph guard (TOTP autofill Stage 3, AF3-U1; docs/design/notes/AUTOFILL3-NOTES.md §9; the
// plan's S7), for every pass of scripts/build.mjs: the pages (the popup, the side panel and their Fill chunk, the settings
// page, the offscreen document), the worker, the finder and the content script. With the updater's release gate closed
// (scripts/rules-update.mjs), its modules are not even loaded: an import of src/core/rules/signed.ts, or of a
// rules-fetch.ts or rules-live.ts anywhere under src/ (AF3-U2's), from the extension's own code resolves to an empty
// module of this plugin's, and the build fails if its module graph holds one all the same (an import this plugin does not
// take: another path, a query, a file outside src/ that reaches it). A static import behind a dead branch still loads its
// module, so tree-shaking alone is not the guard. The empty module exports nothing, so an import of a name from it fails
// the build too. With the gate open, the plugin does nothing.
//
// Paths are compared as the disk spells them (realpathSync.native: its own letter case, links followed), and, for a path
// not on the disk, without regard to letter case: on a disk that ignores case (macOS, Windows) `../core/rules/Signed` is
// signed.ts, and Vite keeps the id as the import spelled it (the AF3-U1 review's S1; build.mjs's rulesDataGuard does the
// same). `src` is the extension's own source folder, which build.mjs passes in (resolve(root, "src")), so nothing depends
// on what the folders above it are called (the review's N8).
// Exported for its test (test/unit/rules-update-gate.test.ts).
import { realpathSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

/** The updater's modules, by their path under src/ ("/" between folders), in any letter case. */
export const GATED_IN_SRC = /^(?:core\/rules\/signed|(?:[^/]+\/)*rules-(?:fetch|live))\.ts$/i;
export const RULES_UPDATE_OFF = "\0sixkey-rules-update-off";

const slashed = (p) => p.split("\\").join("/");
/** `p` as the disk spells it, "/" between folders; as it is when it is not on this disk. */
const onDisk = (p) => {
  try {
    return slashed(realpathSync.native(p));
  } catch {
    return slashed(p);
  }
};
/** The path of `p` under `src` ("/" between folders), letter case aside; null when it is not under it. */
function under(p, src) {
  const a = onDisk(p);
  const s = slashed(src).replace(/\/+$/, "");
  return a.toLowerCase().startsWith(`${s.toLowerCase()}/`) ? a.slice(s.length + 1) : null;
}
/** Whether `p` is one of the updater's modules under `src`. */
export function gated(p, src) {
  const rel = under(p, src);
  return rel !== null && GATED_IN_SRC.test(rel);
}

/** The plugin, for a build whose gate is `on`; `srcRoot`, the extension's src/ (by default the one beside this file). */
export function rulesGuard(on, srcRoot = fileURLToPath(new URL("../src", import.meta.url))) {
  const src = onDisk(srcRoot).replace(/\/+$/, "");
  return {
    name: "sixkey-rules-guard",
    enforce: "pre", // before Vite's own resolver, which would resolve the import to the module itself
    resolveId(source, importer) {
      if (on || !importer || !source.startsWith(".") || source.includes("?")) return null;
      const from = slashed(importer.replace(/\?.*$/, "")); // a Windows path too: resolved with "/" alone
      if (under(from, src) === null) return null;
      const to = posix.normalize(posix.join(posix.dirname(from), source));
      return gated(to, src) || gated(`${to}.ts`, src) ? RULES_UPDATE_OFF : null;
    },
    load(id) {
      return !on && id === RULES_UPDATE_OFF ? "export {};" : null;
    },
    buildEnd(err) {
      if (err || on) return;
      const bad = [...this.getModuleIds()]
        .map((id) => id.replace(/\?.*$/, "").replace(/^\0/, ""))
        .filter((id) => gated(id, src));
      if (bad.length)
        this.error(
          `a build whose release gate keeps the site rules' updater out must not contain it: ${bad.join(", ")}`,
        );
    },
  };
}
