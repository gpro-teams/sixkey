// scripts/check-dist.mjs's rules for the Sync section (M6) against real builds: a prod build (the release gate closed)
// carries none of it, an e2e build carries all of it, lazily and away from the popup (but for the popup's lock-screen
// line and the settings page's rail line, which follow the same gate: the rail shows the backup in Chrome sync's line in
// a build without the section), within its catalog's limit. Each
// altered copy breaks one rule and must fail with that rule's message (as m5-check-dist.test.ts does for M5's rules).
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const EXT = resolve(__dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "sixkey-m6-check-dist-"));
const built = { prod: join(work, "prod"), e2e: join(work, "e2e") };
type Flavour = keyof typeof built;
const flag = (f: Flavour) => (f === "prod" ? [] : [`--${f}`]);
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
const asset = (dir: string, re: RegExp) => readdirSync(join(dir, "assets")).find((x) => re.test(x))!;
const edit = (dir: string, f: string, fn: (t: string) => string) =>
  writeFileSync(join(dir, f), fn(readFileSync(join(dir, f), "utf8")));
const syncKey = Object.keys(JSON.parse(readFileSync(join(EXT, "catalogs/sync-en.json"), "utf8")))[0]!;

beforeAll(() => {
  build("prod");
  build("e2e");
}, 300_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("check-dist and the Sync section", () => {
  it("the pristine builds pass: prod without it, e2e with it, its catalogs counted", () => {
    const p = check(built.prod, "prod");
    expect(p.ok, p.out).toBe(true);
    expect(p.out).toContain("sync user interface: out (release gate SYNC_UI_IN_STORE_BUILD = false)");
    expect(readdirSync(join(built.prod, "assets")).filter((x) => x.startsWith("sync-"))).toEqual([]);
    const e = check(built.e2e, "e2e");
    expect(e.ok, e.out).toBe(true);
    expect(e.out).toMatch(/sync catalog en: [\d.]+ KB gz \(limit 12 KB\)/);
    expect(e.out).toMatch(/sync catalog zh_CN: [\d.]+ KB gz \(limit 12 KB\)/);
    // the popup's catalog carries the lock-screen line's words only where the gate lets the line in
    const popupCatalog = (dir: string) =>
      readFileSync(join(dir, "assets", asset(dir, /^popup-locale-en-[\w-]+\.js$/)), "utf8");
    expect(popupCatalog(built.prod)).not.toContain("lockPasswordElsewhere");
    expect(popupCatalog(built.e2e)).toContain("lockPasswordElsewhere");
    // the rail: the live sync's line where the gate lets the section in, the backup in Chrome sync's where it does not
    const settingsCode = (dir: string) => readFileSync(join(dir, "assets", asset(dir, /^options-[\w-]+\.js$/)), "utf8");
    expect(settingsCode(built.prod)).not.toContain("rail-sync");
    expect(settingsCode(built.prod)).toContain("rail-csb");
    expect(settingsCode(built.e2e)).toContain("rail-sync");
    expect(settingsCode(built.e2e)).not.toContain("rail-csb");
  });

  const prodCases: [string, (d: string) => void, RegExp][] = [
    [
      "a sync-ui chunk",
      (d) => writeFileSync(join(d, "assets/sync-ui-AbC123.js"), "export const x=1;"),
      /assets\/sync-ui-AbC123\.js: the sync user interface in a build whose release gate keeps it out/,
    ],
    [
      "a sync catalog chunk",
      (d) => writeFileSync(join(d, "assets/sync-locale-en-AbC123.js"), "export default {};"),
      /assets\/sync-locale-en-AbC123\.js: the sync user interface in a build whose release gate keeps it out/,
    ],
    [
      "the section's text named in a shipped script",
      (d) => edit(d, `assets/${asset(d, /^options-[\w-]+\.js$/)}`, (t) => `${t}\nconst k="${syncKey}";`),
      new RegExp(`names the Sync section's text \\(${syncKey}\\)`),
    ],
    // the minified catalog chunks key their entries without quotes: the catalog itself, renamed, is caught too
    [
      "the section's catalog under another name",
      (d) =>
        writeFileSync(join(d, "assets/strings-AbC123.js"), `var e={${syncKey}:{message:\`x\`}};export{e as default};`),
      new RegExp(`strings-AbC123\\.js: names the Sync section's text \\(${syncKey}\\)`),
    ],
    [
      "the section's CSS",
      (d) => writeFileSync(join(d, "assets/sync-AbC123.css"), ".sas{}"),
      /assets\/sync-AbC123\.css: the sync user interface/,
    ],
    // the engine's own chunk exists only beside the developer page (dev and e2e builds), never in a store build
    [
      "an engine chunk",
      (d) => writeFileSync(join(d, "assets/sync-engine-AbC123.js"), "export const x=1;"),
      /assets\/sync-engine-AbC123\.js: the sync user interface in a build whose release gate keeps it out/,
    ],
    // the popup's lock-screen line (§6 P2) is sync user interface too: a store build whose gate is closed drops it
    [
      "the popup's lock-screen sync line",
      (d) =>
        edit(d, `assets/${asset(d, /^popup-(?!locale)[\w-]+\.js$/)}`, (t) => `${t}\nconst p="lock-keys-elsewhere";`),
      /popup-[\w-]+\.js: the popup's lock-screen sync line \(lock-keys-elsewhere\) in a build whose release gate keeps it out/,
    ],
    // the settings page's rail: the live sync's line in a store build whose gate is closed, or the backup's line gone
    [
      "the rail's line of the live sync",
      (d) => edit(d, `assets/${asset(d, /^options-[\w-]+\.js$/)}`, (t) => `${t}\nconst r="rail-sync";`),
      /options-[\w-]+\.js: the rail line rail-sync in a build whose release gate keeps the sync user interface out/,
    ],
    [
      "no rail line of the backup in Chrome sync",
      (d) => edit(d, `assets/${asset(d, /^options-[\w-]+\.js$/)}`, (t) => t.split("rail-csb").join("rail-gone")),
      /the settings page's code has no rail line rail-csb in a build whose release gate keeps the sync user interface out/,
    ],
  ];
  for (const [what, alter, msg] of prodCases) {
    it(`prod: fails on ${what}`, () => {
      const r = mutant("prod", alter);
      expect(r.ok).toBe(false);
      expect(r.out).toMatch(msg);
    });
  }

  const e2eCases: [string, (d: string) => void, RegExp][] = [
    [
      "no sync-ui chunk",
      (d) => unlinkSync(join(d, "assets", asset(d, /^sync-ui-[\w-]+\.js$/))),
      /expected one Sync section chunk assets\/sync-ui-\*\.js, found 0/,
    ],
    [
      "two sync-ui chunks",
      (d) => writeFileSync(join(d, "assets/sync-ui-Extra1.js"), "export {};"),
      /expected one Sync section chunk assets\/sync-ui-\*\.js, found 2/,
    ],
    [
      "no Chinese sync catalog",
      (d) => unlinkSync(join(d, "assets", asset(d, /^sync-locale-zh_CN-[\w-]+\.js$/))),
      /locale zh_CN: expected one Sync section catalog chunk/,
    ],
    [
      "a sync catalog that is not the generated one",
      (d) =>
        edit(d, `assets/${asset(d, /^sync-locale-en-[\w-]+\.js$/)}`, (t) =>
          t.replace(/message:`[^`]*`/, "message:`changed`"),
        ),
      /sync catalog chunk for en differs from catalogs\/sync-en\.json/,
    ],
    [
      "a sync catalog over its limit",
      (d) =>
        edit(
          d,
          `assets/${asset(d, /^sync-locale-en-[\w-]+\.js$/)}`,
          (t) => `${t}\n//${Array.from({ length: 30_000 }, (_, i) => ((i * 2654435761) >>> 7).toString(36)).join("")}`,
        ),
      /sync catalog en is \d+ B gz, over its limit of 12288 B/,
    ],
    [
      "the settings page loading the section up front",
      (d) =>
        edit(d, "options/index.html", (t) =>
          t.replace(
            "</head>",
            `<script type="module" src="../assets/${asset(d, /^sync-ui-[\w-]+\.js$/)}"></script></head>`,
          ),
        ),
      /options\/index\.html loads \.\.\/assets\/sync-ui-[\w-]+\.js up front/,
    ],
    [
      "the popup able to load the section",
      (d) =>
        edit(
          d,
          `assets/${asset(d, /^popup-(?!locale)[\w-]+\.js$/)}`,
          (t) => `${t}\n//${asset(d, /^sync-ui-[\w-]+\.js$/)}`,
        ),
      /the popup can load the Sync section/,
    ],
    [
      "the popup without its lock-screen sync line",
      (d) => {
        for (const f of readdirSync(join(d, "assets")))
          if (f.endsWith(".js")) edit(d, `assets/${f}`, (t) => t.split("lock-keys-elsewhere").join("lock-gone"));
      },
      /the popup's code has no lock-screen sync line \(lock-keys-elsewhere\)/,
    ],
    [
      "the settings page without the rail's line of the live sync",
      (d) => edit(d, `assets/${asset(d, /^options-[\w-]+\.js$/)}`, (t) => t.split("rail-sync").join("rail-gone")),
      /the settings page's code has no rail line rail-sync in a build whose release gate lets the sync user interface in/,
    ],
    [
      "the rail's line of the backup in Chrome sync beside it",
      (d) => edit(d, `assets/${asset(d, /^options-[\w-]+\.js$/)}`, (t) => `${t}\nconst r="rail-csb";`),
      /options-[\w-]+\.js: the rail line rail-csb in a build whose release gate lets the sync user interface in/,
    ],
    [
      "the settings page unable to load it",
      (d) => {
        for (const f of readdirSync(join(d, "assets")))
          if (f.endsWith(".js") && !f.startsWith("sync-ui-"))
            edit(d, `assets/${f}`, (t) => t.split(asset(d, /^sync-ui-[\w-]+\.js$/)).join("gone.js"));
      },
      /the settings page cannot load the Sync section chunk/,
    ],
  ];
  for (const [what, alter, msg] of e2eCases) {
    it(`e2e: fails on ${what}`, () => {
      const r = mutant("e2e", alter);
      expect(r.ok).toBe(false);
      expect(r.out).toMatch(msg);
    });
  }
});
