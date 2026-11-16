// The release gate of the sync user interface (scripts/sync-ui.mjs): the store build carries no Sync section until the
// cloud goes live (M8), dev and e2e builds always do, and opening the gate is one reviewed change of one constant.
//   - the constant, pinned here: flipping it means changing this test in the same change (with M8's store text,
//     OWNER-DECISIONS/06, and the permission text), which is what makes it reviewed;
//   - one way the value reaches the code: scripts/sync-ui.mjs → build.mjs's define (__SYNC_UI__) and check-dist; read in
//     three source modules (src/options/SyncHost.tsx, which alone imports the section, the popup's lock screen,
//     src/popup/screens/Locked.tsx, for its line about keys changed elsewhere, and the service worker,
//     src/background/sw.ts, which has no sync worker, bridge or transport with the gate closed), each as a constant of
//     its own;
//   - flipped in a private copy, the store build does carry the section and its own check-dist passes; closed (the tree
//     as it is), check-dist's tests (m6-check-dist.test.ts) show it carries none.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { popupKeys } from "../../scripts/catalog-keys.mjs";
import { SYNC_UI_IN_STORE_BUILD, syncUiIn } from "../../scripts/sync-ui.mjs";

const EXT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(join(EXT, p), "utf8");
function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(n)) out.push(p);
  }
  return out;
}
const sources = [...files(join(EXT, "src")), ...files(join(EXT, "scripts"))].map((f) => ({
  path: f
    .slice(EXT.length + 1)
    .split("\\")
    .join("/"),
  text: readFileSync(f, "utf8"),
}));
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");

describe("the release gate", () => {
  it("is closed for the store build until M8 opens it; dev and e2e builds always carry the section", () => {
    expect(SYNC_UI_IN_STORE_BUILD).toBe(false); // M8: true, in the change that ships the cloud (see the header)
    expect(syncUiIn("prod")).toBe(SYNC_UI_IN_STORE_BUILD);
    expect(syncUiIn("dev")).toBe(true);
    expect(syncUiIn("e2e")).toBe(true);
  });

  it("has one source: scripts/sync-ui.mjs, read by the build and by check-dist, nothing from the environment or the command line", () => {
    const importers = sources
      .filter((f) => /(?:from|import)\s*\(?\s*["'][^"']*sync-ui\.mjs["']/.test(code(f.text)))
      .map((f) => f.path)
      .sort();
    expect(importers).toEqual(["scripts/build.mjs", "scripts/check-dist.mjs"]);
    const build = code(read("scripts/build.mjs"));
    expect(build).toMatch(/const syncUi = syncUiIn\(flavour\);/);
    expect([...build.matchAll(/__SYNC_UI__/g)].length).toBe(1);
    expect(build).toMatch(/__SYNC_UI__: JSON\.stringify\(syncUi\)/);
    expect(build).not.toMatch(/process\.env\.[A-Z_]*SYNC/);
    expect(code(read("scripts/check-dist.mjs"))).toMatch(/const SYNC_UI = syncUiIn\(flavour\);/);
    expect(read("scripts/sync-ui.mjs")).toMatch(/^export const SYNC_UI_IN_STORE_BUILD = false;$/m);
  });

  it("keeps the popup lock line's words out of the popup's catalog where it is closed (scripts/catalog-keys.mjs rule 5)", () => {
    const LINE = ["lockPasswordElsewhere", "lockKeysElsewhere", "lockPendingChange", "lockOpenSync"];
    const closed = popupKeys(EXT, undefined, { syncUi: false }).keys;
    const open = popupKeys(EXT).keys;
    expect(LINE.filter((k) => closed.includes(k))).toEqual([]);
    expect(LINE.filter((k) => !open.includes(k))).toEqual([]);
    expect(open.filter((k) => !closed.includes(k)).sort()).toEqual([...LINE].sort()); // nothing else depends on the gate
  }, 120_000);

  it("is read by three modules: the settings host (which alone imports the section), the popup's, the worker", () => {
    const readers = sources
      .filter((f) => f.path.startsWith("src/") && /__SYNC_UI__/.test(code(f.text)))
      .map((f) => f.path)
      .sort();
    expect(readers).toEqual(["src/background/sw.ts", "src/options/SyncHost.tsx", "src/popup/screens/Locked.tsx"]);
    expect(code(read("src/popup/screens/Locked.tsx"))).toMatch(
      /const SYNC_UI = typeof __SYNC_UI__ === "boolean" && __SYNC_UI__;/,
    );
    // the worker: its sync worker only with the gate open, and the bridge's listener only with one
    const sw = code(read("src/background/sw.ts"));
    expect(sw).toMatch(/const SYNC_UI = typeof __SYNC_UI__ === "boolean" && __SYNC_UI__;/);
    expect(sw).toMatch(/const sync = SYNC_UI \? createWorkerSync\(rt\) : null;/);
    expect([...sw.matchAll(/createWorkerSync\(/g)].length).toBe(1);
    expect(sw).toMatch(/^if \(SYNC_UI\) chrome\.runtime\.onMessage\.addListener\(bridgeListener\);$/m);
    const host = code(read("src/options/SyncHost.tsx"));
    expect(host).toMatch(/export const SYNC_UI = typeof __SYNC_UI__ === "boolean" && __SYNC_UI__;/);
    const importers = sources
      .filter(
        (f) =>
          f.path.startsWith("src/") &&
          !f.path.startsWith("src/options/sync/") &&
          /["']\.\/sync\/|options\/sync\//.test(code(f.text)),
      )
      .map((f) => f.path);
    expect(importers).toEqual(["src/options/SyncHost.tsx"]);
    expect(host).toMatch(/if \(SYNC_UI\)\s+loading \?\?= import\("\.\/sync\/index"\)/);
    // App and FirstRun only show what the host decides: the section, the rail item, the wizard's way to the join
    expect(code(read("src/options/App.tsx"))).toMatch(
      /\.\.\.\(SYNC_UI \? \[\["sync", "syncLabel", "sync"\] as const\] : \[\]\)/,
    );
  });

  describe("opened in a private copy", () => {
    const top = mkdtempSync(join(tmpdir(), "sixkey-gate-"));
    afterAll(() => rmSync(top, { recursive: true, force: true }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_ENV"));
    // The copy sits in top/extension beside top/LICENSES, the repository's licence texts, which every build copies from
    // (scripts/build.mjs); the lockfile is copied for the build's third-party notices (scripts/notices.mjs).
    const work = join(top, "extension");

    it("a store build carries the section, its catalogs and the enrolment code, and passes its own check-dist", () => {
      symlinkSync(resolve(EXT, "../LICENSES"), join(top, "LICENSES"));
      symlinkSync(resolve(EXT, "../rules"), join(top, "rules")); // the site rules (AF3-3a)
      for (const n of [
        "scripts",
        "src",
        "public",
        "_locales",
        "catalogs",
        "manifest.base.json",
        "manifest.dev.json",
        "manifest.e2e.json",
        "package.json",
        "package-lock.json",
        "tsconfig.json",
      ])
        cpSync(join(EXT, n), join(work, n), { recursive: true });
      symlinkSync(join(EXT, "node_modules"), join(work, "node_modules"));
      const gate = join(work, "scripts/sync-ui.mjs");
      writeFileSync(
        gate,
        readFileSync(gate, "utf8").replace(
          "export const SYNC_UI_IN_STORE_BUILD = false;",
          "export const SYNC_UI_IN_STORE_BUILD = true;",
        ),
      );
      const b = spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: work, encoding: "utf8", env });
      expect(b.status, `${b.stdout}${b.stderr}`).toBe(0);
      expect(b.stdout).toContain("sync user interface in");
      const assets = readdirSync(join(work, "dist/assets"));
      expect(assets.filter((n) => /^sync-ui-[\w-]+\.js$/.test(n)).length).toBe(1);
      expect(assets.filter((n) => /^sync-locale-(en|zh_CN)-[\w-]+\.js$/.test(n)).length).toBe(2);
      // and the managing screens' catalog (a file of its own since the budget relief, BUDGET-NOTES.md)
      expect(assets.filter((n) => /^sync-manage-locale-(en|zh_CN)-[\w-]+\.js$/.test(n)).length).toBe(2);
      const c = spawnSync(process.execPath, ["scripts/check-dist.mjs"], { cwd: work, encoding: "utf8", env });
      expect(`${c.stdout}${c.stderr}`).toContain("check-dist (prod) OK");
      expect(c.stdout).toContain("sync user interface: in (release gate SYNC_UI_IN_STORE_BUILD = true)");
      expect(c.stdout).toMatch(/sync catalog zh_CN: [\d.]+ KB gz/);
      expect(c.stdout).toMatch(/sync-manage catalog zh_CN: [\d.]+ KB gz/);
    }, 300_000);
  });

  describe("closed, an import of the section that slipped past the gate", () => {
    const top = mkdtempSync(join(tmpdir(), "sixkey-gate-closed-"));
    afterAll(() => rmSync(top, { recursive: true, force: true }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_ENV"));
    // The copy sits in top/extension beside top/rules and top/LICENSES: every build checks the site rules' bundle and
    // reads the licence texts before it builds anything (scripts/rules-package.mjs; TOTP autofill Stage 3, AF3-3a).
    const work = join(top, "extension");

    it("fails the store build (the graph guard), naming the section's modules", () => {
      symlinkSync(resolve(EXT, "../rules"), join(top, "rules"));
      symlinkSync(resolve(EXT, "../LICENSES"), join(top, "LICENSES"));
      for (const n of [
        "scripts",
        "src",
        "public",
        "_locales",
        "catalogs",
        "manifest.base.json",
        "manifest.dev.json",
        "manifest.e2e.json",
        "package.json",
        "tsconfig.json",
      ])
        cpSync(join(EXT, n), join(work, n), { recursive: true });
      symlinkSync(join(EXT, "node_modules"), join(work, "node_modules"));
      const host = join(work, "src/options/SyncHost.tsx");
      writeFileSync(
        host,
        `import { prepare as __leak } from "./sync/index";\nvoid __leak;\n${readFileSync(host, "utf8")}`,
      );
      const b = spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: work, encoding: "utf8", env });
      expect(b.status).not.toBe(0);
      expect(`${b.stdout}${b.stderr}`).toMatch(
        /a prod build must not contain the developer sync page or the enrolment code: .*src\/options\/sync\//,
      );
    }, 300_000);
  });
});
