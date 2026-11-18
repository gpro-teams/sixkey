// No build has the settings page's Sync section (DV-0a; OWNER-DECISIONS/25): not the store build, the test build (the
// store build's flavour), the dev build or the e2e build. Its release gate (scripts/sync-ui.mjs) is gone with it, so
// nothing can turn it back on. Held three ways:
//   - the tree: none of the section's files, its catalogs, the developer sync page, the gate, its suite or its define;
//     the settings page's routes have no Sync group, and no source names the gate;
//   - real builds of every flavour (prod, dev, e2e, each into a temporary directory): each passes check-dist with no
//     chunk, catalog, route, element or text of the section, and the rail's line is the backup in Chrome sync's; and a
//     copy of each, altered to bring one of these back, fails with that rule's message (check-dist's own mutants);
//   - the build's graph guard (scripts/build.mjs): a copy of the tree with the section's module or one of its catalogs
//     restored and imported fails to build, in a flavour that used to carry it.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GROUPS, LEAVES } from "../../src/options/route";

const EXT = resolve(__dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "sixkey-no-sync-section-"));
const built = { prod: join(work, "prod"), dev: join(work, "dev"), e2e: join(work, "e2e") };
type Flavour = keyof typeof built;
const FLAVOURS = Object.keys(built) as Flavour[];
const flag = (f: Flavour) => (f === "prod" ? [] : [`--${f}`]);
// The scripts run as from a developer's shell, without the test runner's NODE_ENV=test (the build pins its own mode).
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_ENV"));

function build(f: Flavour) {
  const r = spawnSync(process.execPath, ["scripts/build.mjs", ...flag(f), "--out", built[f]], {
    cwd: EXT,
    encoding: "utf8",
    env,
  });
  if (r.status !== 0) throw new Error(`build ${f} failed:\n${r.stdout}\n${r.stderr}`);
}
function check(dir: string, f: Flavour) {
  const r = spawnSync(process.execPath, ["scripts/check-dist.mjs", ...flag(f), "--dist", dir], {
    cwd: EXT,
    encoding: "utf8",
    env,
  });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}
let n = 0;
/** A copy of a build with `alter` applied; checked; the copy removed. */
function mutant(f: Flavour, alter: (dir: string) => void) {
  const dir = join(work, `m${++n}`);
  cpSync(built[f], dir, { recursive: true });
  alter(dir);
  try {
    return check(dir, f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const assets = (dir: string) => readdirSync(join(dir, "assets"));
const asset = (dir: string, re: RegExp) => assets(dir).find((x) => re.test(x))!;
const edit = (dir: string, f: string, fn: (t: string) => string) =>
  writeFileSync(join(dir, f), fn(readFileSync(join(dir, f), "utf8")));
const settingsChunk = (d: string) => `assets/${asset(d, /^options-[\w-]+\.js$/)}`;
const popupChunk = (d: string) => `assets/${asset(d, /^popup-(?!locale)[\w-]+\.js$/)}`;
/** Every file under `dir`, relative to it. */
function filesOf(dir: string, out: string[] = [], base = dir): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) filesOf(p, out, base);
    else
      out.push(
        p
          .slice(base.length + 1)
          .split("\\")
          .join("/"),
      );
  }
  return out;
}

describe("the tree", () => {
  it("has none of the section's files, its catalogs, the developer sync page, the gate or the suite that drove them", () => {
    for (const p of [
      "src/options/sync",
      "src/options/SyncHost.tsx",
      "src/devsync",
      "scripts/sync-ui.mjs",
      "scripts/sync-ui.d.mts",
      "scripts/i18n/m6c.py",
      "scripts/i18n/enroll2.py",
      "playwright.sync.config.ts",
      "test/sync",
      "test/unit/m6-gate.test.ts",
    ])
      expect(existsSync(join(EXT, p)), p).toBe(false);
    expect(readdirSync(join(EXT, "catalogs")).filter((x) => x.startsWith("sync-"))).toEqual([]);
    expect(Object.keys(JSON.parse(readFileSync(join(EXT, "package.json"), "utf8")).scripts)).not.toContain("e2e:sync");
  });

  it("no source names the gate, its define or the section's modules; the build defines no __SYNC_UI__", () => {
    const sources = [
      ...filesOf(join(EXT, "src")).map((p) => `src/${p}`),
      ...filesOf(join(EXT, "scripts")).map((p) => `scripts/${p}`),
    ]
      .filter((p) => /\.(?:ts|tsx|mjs|mts|py)$/.test(p))
      .map((p) => ({ p, text: readFileSync(join(EXT, p), "utf8") }));
    expect(sources.length).toBeGreaterThan(100);
    for (const word of [
      "__SYNC_UI__",
      "SYNC_UI_IN_STORE_BUILD",
      "syncUiIn",
      "sync-ui.mjs",
      "SyncHost",
      "options/sync/",
    ])
      expect(
        sources
          .filter(
            (f) => f.text.includes(word) && !(f.p === "scripts/build.mjs" && /SyncHost|options\/sync\//.test(word)),
          )
          .map((f) => f.p),
        word,
      ).toEqual([]);
    // the build's graph guard names the section's paths to refuse them, in every flavour (below), and nothing else does
    const build = readFileSync(join(EXT, "scripts/build.mjs"), "utf8");
    expect(build).toMatch(/const SYNC_SECTION_FORBIDDEN = \[/);
    expect(build).toMatch(
      /function syncSectionGuard\(\) \{[\s\S]{0,120}buildEnd\(err\) \{\s+if \(err\) return;\s+const bad/,
    ); // every flavour
    expect(build).not.toMatch(/__SYNC_UI__|syncUi\b/);
    // messages.py takes no table of the section's catalogs from a fragment
    expect(readFileSync(join(EXT, "scripts/messages.py"), "utf8")).not.toMatch(/"SYNC_(?:MANAGE_)?(?:EN|ZH)"/);
  });

  it("the settings page's routes have no Sync group or leaf", () => {
    expect(GROUPS.map((g) => g.id)).not.toContain("sync");
    expect(LEAVES).not.toContain("sync");
  });
});

describe("every build", () => {
  beforeAll(() => {
    for (const f of FLAVOURS) build(f);
  }, 600_000);
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it.each(FLAVOURS)(
    "%s: passes check-dist with nothing of the section, and the backup in Chrome sync's rail line",
    (f) => {
      const r = check(built[f], f);
      expect(r.ok, r.out).toBe(true);
      const dir = built[f];
      expect(assets(dir).filter((x) => x.startsWith("sync-"))).toEqual([]);
      expect(existsSync(join(dir, "devsync"))).toBe(false);
      const settings = readFileSync(join(dir, settingsChunk(dir)), "utf8");
      expect(settings).toContain("rail-csb");
      expect(settings).not.toContain("rail-sync");
      // the popup's catalog carries no word of the lock screen's line that pointed to the section
      const popupCatalog = readFileSync(join(dir, "assets", asset(dir, /^popup-locale-en-[\w-]+\.js$/)), "utf8");
      for (const k of ["lockPasswordElsewhere", "lockKeysElsewhere", "lockPendingChange", "lockOpenSync"])
        expect(popupCatalog, k).not.toContain(k);
      // and the full catalogs no key of the rail's sync line or of the ways into the section
      const full = JSON.parse(readFileSync(join(dir, "_locales/en/messages.json"), "utf8"));
      for (const k of ["syncLabel", "syncOff", "frJoinSync", "secKeysInSyncTitle", "lockOpenSync"])
        expect(Object.hasOwn(full, k), k).toBe(false);
    },
  );

  // [what, flavour, alter, the message]: across the flavours, the dev build (unminified) and the e2e build being the
  // ones that carried the section
  const cases: [string, Flavour, (d: string) => void, RegExp][] = [
    [
      "the section's chunk",
      "prod",
      (d) => writeFileSync(join(d, "assets/sync-ui-AbC123.js"), "export const x=1;"),
      /assets\/sync-ui-AbC123\.js: the Sync section in the prod build/,
    ],
    [
      "the section's chunk",
      "dev",
      (d) => writeFileSync(join(d, "assets/sync-ui-AbC123.js"), "export const x=1;"),
      /assets\/sync-ui-AbC123\.js: the Sync section in the dev build/,
    ],
    [
      "the section's chunk",
      "e2e",
      (d) => writeFileSync(join(d, "assets/sync-ui-AbC123.js"), "export const x=1;"),
      /assets\/sync-ui-AbC123\.js: the Sync section in the e2e build/,
    ],
    [
      "one of its catalogs' chunks",
      "e2e",
      (d) => writeFileSync(join(d, "assets/sync-locale-zh_CN-AbC123.js"), "var e={};export{e as default};"),
      /assets\/sync-locale-zh_CN-AbC123\.js: the Sync section in the e2e build/,
    ],
    [
      "the managing screens' catalog's chunk",
      "dev",
      (d) => writeFileSync(join(d, "assets/sync-manage-locale-en-AbC123.js"), "var e={};export{e as default};"),
      /assets\/sync-manage-locale-en-AbC123\.js: the Sync section in the dev build/,
    ],
    [
      "its stylesheet",
      "prod",
      (d) => writeFileSync(join(d, "assets/sync-AbC123.css"), ".sas{}"),
      /assets\/sync-AbC123\.css: the Sync section in the prod build/,
    ],
    [
      "the page engine's chunk it shared with the developer page",
      "e2e",
      (d) => writeFileSync(join(d, "assets/sync-engine-AbC123.js"), "export const x=1;"),
      /assets\/sync-engine-AbC123\.js: the Sync section in the e2e build/,
    ],
    [
      "its text named in a shipped script",
      "e2e",
      (d) => edit(d, settingsChunk(d), (t) => `${t}\nconst k="syncClose";`),
      /options-[\w-]+\.js: names the Sync section's text \(syncClose\) in the e2e build/,
    ],
    // the minified catalog chunks key their entries without quotes: a catalog under another name is caught too
    [
      "a catalog of its text under another name",
      "prod",
      (d) => writeFileSync(join(d, "assets/strings-AbC123.js"), "var e={syncLead:{message:`x`}};export{e as default};"),
      /strings-AbC123\.js: names the Sync section's text \(syncLead\) in the prod build/,
    ],
    [
      "the rail's label of it",
      "dev",
      (d) => edit(d, settingsChunk(d), (t) => `${t}\nconst k = t("syncLabel");`),
      /names the Sync section's text \(syncLabel\) in the dev build/,
    ],
    [
      "its route",
      "dev",
      (d) => edit(d, settingsChunk(d), (t) => `${t}\nconst GROUPS = [{ id: "sync", leaves: ["sync"] }], to = "#sync";`),
      /options-[\w-]+\.js: the Sync section's route \("#sync"\) in the dev build/,
    ],
    [
      "first run's way to its join",
      "e2e",
      (d) => edit(d, settingsChunk(d), (t) => `${t}\nlocation.hash="#sync/join";`),
      /the Sync section's route \("#sync\/join"\) in the e2e build/,
    ],
    [
      "the rail's line of the live sync",
      "prod",
      (d) => edit(d, settingsChunk(d), (t) => `${t}\nconst r="rail-sync";`),
      /options-[\w-]+\.js: the Sync section's element rail-sync in the prod build/,
    ],
    [
      "the popup lock screen's line",
      "e2e",
      (d) => edit(d, popupChunk(d), (t) => `${t}\nconst p="lock-keys-elsewhere";`),
      /popup-[\w-]+\.js: the Sync section's element lock-keys-elsewhere in the e2e build/,
    ],
    [
      "first run's join button",
      "dev",
      (d) => edit(d, settingsChunk(d), (t) => `${t}\nconst b = 'fr-to-join';`),
      /the Sync section's element fr-to-join in the dev build/,
    ],
    [
      "the Security section's box pointing to it",
      "e2e",
      (d) => edit(d, settingsChunk(d), (t) => `${t}\nconst b=\`sec-keys-in-sync\`;`),
      /the Sync section's element sec-keys-in-sync in the e2e build/,
    ],
    [
      "its sign-in",
      "dev",
      (d) => edit(d, settingsChunk(d), (t) => `${t}\nconst i = "sync-email";`),
      /the Sync section's element sync-email in the dev build/,
    ],
    [
      "no rail line of the backup in Chrome sync",
      "dev",
      (d) => {
        for (const f of assets(d))
          if (f.endsWith(".js")) edit(d, `assets/${f}`, (t) => t.split("rail-csb").join("rail-gone"));
      },
      /the settings page's code has no rail line rail-csb/,
    ],
    [
      "the developer sync page",
      "e2e",
      (d) => {
        mkdirSync(join(d, "devsync"));
        writeFileSync(join(d, "devsync/index.html"), "<!doctype html><title>x</title>");
      },
      /devsync\/ \(the developer sync page\) is in the e2e build/,
    ],
    [
      "the developer sync page's marker",
      "dev",
      (d) => edit(d, popupChunk(d), (t) => `${t}\nconst m = "sixkey-dev-sync";`),
      /the developer sync page's marker in the dev build/,
    ],
    [
      "the enrolment code",
      "dev",
      (d) => edit(d, settingsChunk(d), (t) => `${t}\nconst k = "sixkey/v2/enroll-key";`),
      /enrolment code in the dev build \(sixkey\/v2\/enroll-key\)/,
    ],
  ];
  it.each(cases)("fails on %s (%s)", (_what, f, alter, message) => {
    const r = mutant(f, alter);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(message);
  });
});

describe("the build's graph guard, in a flavour that used to carry the section", () => {
  const top = mkdtempSync(join(tmpdir(), "sixkey-no-sync-section-build-"));
  afterAll(() => rmSync(top, { recursive: true, force: true }));
  let m = 0;
  /** A private copy of the tree (beside the repository's licences and site rules, which every build reads), altered. */
  function buildCopy(f: Flavour, alter: (dir: string) => void) {
    const dir = join(top, `b${++m}`, "extension");
    mkdirSync(dir, { recursive: true });
    symlinkSync(resolve(EXT, "../LICENSES"), join(top, `b${m}`, "LICENSES"), "dir");
    symlinkSync(resolve(EXT, "../rules"), join(top, `b${m}`, "rules"), "dir");
    for (const p of [
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
      "test/fixtures/rules", // the e2e build's own test rules (scripts/rules-package.mjs e2eBaselineText)
    ])
      cpSync(join(EXT, p), join(dir, p), { recursive: true });
    symlinkSync(join(EXT, "node_modules"), join(dir, "node_modules"));
    alter(dir);
    const r = spawnSync(process.execPath, ["scripts/build.mjs", ...flag(f)], { cwd: dir, encoding: "utf8", env });
    return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
  }
  const prepend = (dir: string, f: string, text: string) =>
    writeFileSync(join(dir, f), `${text}\n${readFileSync(join(dir, f), "utf8")}`);

  it.each([
    [
      "the section's module brought back and imported by the settings page",
      "e2e" as Flavour,
      (d: string) => {
        mkdirSync(join(d, "src/options/sync"));
        writeFileSync(join(d, "src/options/sync/index.tsx"), "export const prepare = async () => undefined;\n");
        prepend(d, "src/options/App.tsx", 'import { prepare as __leak } from "./sync/index";\nvoid __leak;');
      },
      /no build may contain the Sync section, the developer sync page or the server sync's client: src\/options\/sync\/index\.tsx/,
    ],
    [
      "one of its catalogs brought back and imported",
      "dev" as Flavour,
      (d: string) => {
        writeFileSync(join(d, "catalogs/sync-en.json"), '{"syncLead": {"message": "x"}}\n');
        prepend(d, "src/options/App.tsx", 'import __c from "../../catalogs/sync-en.json";\nvoid __c;');
      },
      /no build may contain the Sync section, the developer sync page or the server sync's client: catalogs\/sync-en\.json/,
    ],
  ])(
    "stops on %s",
    (_what, f, alter, message) => {
      const r = buildCopy(f, alter);
      expect(r.ok).toBe(false);
      expect(r.out).toMatch(message);
    },
    300_000,
  );
});
