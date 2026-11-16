// scripts/check-dist.mjs's and scripts/build.mjs's rules for the budget relief (docs/design/notes/BUDGET-NOTES.md) against
// real builds: the settings page loads its text in parts (one chunk per part and language, each within its budget,
// exactly the generated file, reached lazily by the settings page and never by the popup), no chunk of a full catalog
// exists, Chrome's getMessage keys have text, and the Sync section's two catalogs follow the section's rules. Each
// altered copy breaks one rule and must fail with that rule's message (as m5-check-dist.test.ts and m6-check-dist.test.ts
// do for theirs).
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const EXT = resolve(__dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "sixkey-budget-check-dist-"));
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
const keysOf = (p: string) => Object.keys(JSON.parse(readFileSync(join(EXT, p), "utf8")));
/** A catalog chunk with this many entries of text that does not compress (`seed`: another text, which does not compress against it either). */
const noise = (entries: number, seed = 0) =>
  `var e={${Array.from({ length: entries }, (_, i) => `k${i}:{message:\`${Array.from({ length: 40 }, (_, j) => String.fromCharCode(0x4e00 + ((seed * 104729 + i * 131 + j * 7919) % 20000))).join("")}\`}`).join(",")}};export{e as default};`;

beforeAll(() => {
  build("prod");
  build("e2e");
}, 300_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("check-dist and the settings page's text parts", () => {
  it("the pristine builds pass, every part counted against its budget; no full catalog chunk exists", () => {
    for (const f of ["prod", "e2e"] as const) {
      const r = check(built[f], f);
      expect(r.ok, r.out).toBe(true);
      expect(r.out).toMatch(
        /settings catalogs \(B gz\): core en \d+ \/ zh_CN \d+ of 5120; security en \d+ \/ zh_CN \d+ of 5120;/,
      );
      expect(r.out).toMatch(
        /settings page text loaded together \(B gz, limit 12288\): with no vault en \d+; with no vault zh_CN \d+; with a vault en \d+; with a vault zh_CN \d+; every part en \d+; every part zh_CN \d+/,
      );
      const assets = readdirSync(join(built[f], "assets"));
      expect(assets.filter((x) => /^locale-/.test(x))).toEqual([]);
      expect(assets.filter((x) => /^settings-locale-[a-z]+-(en|zh_CN)-[\w-]+\.js$/.test(x))).toHaveLength(16);
    }
  });

  const cases: [string, Flavour, (d: string) => void, RegExp][] = [
    [
      "a chunk of a full catalog",
      "prod",
      (d) => writeFileSync(join(d, "assets/locale-en-AbC123.js"), "var e={};export{e as default};"),
      /assets\/locale-en-AbC123\.js: a chunk of a full catalog; no page loads one/,
    ],
    [
      "a part's Chinese chunk missing",
      "prod",
      (d) => unlinkSync(join(d, "assets", asset(d, /^settings-locale-backup-zh_CN-[\w-]+\.js$/))),
      /locale zh_CN: expected one settings page \(backup\) catalog chunk assets\/settings-locale-backup-zh_CN-\*\.js, found 0/,
    ],
    [
      "a catalog chunk of a part that does not exist",
      "prod",
      (d) => writeFileSync(join(d, "assets/settings-locale-nopart-en-AbC123.js"), "var e={};export{e as default};"),
      /catalog chunks without a locale or a part: settings-locale-nopart-en-AbC123\.js/,
    ],
    [
      "a part over its budget",
      "prod",
      (d) => writeFileSync(join(d, "assets", asset(d, /^settings-locale-unlock-en-[\w-]+\.js$/)), noise(120)),
      /settings catalog unlock \(en\) is \d+ B gz, over its budget of 3072 B/,
    ],
    [
      "a part over its budget, in the e2e build too",
      "e2e",
      (d) => writeFileSync(join(d, "assets", asset(d, /^settings-locale-misc-zh_CN-[\w-]+\.js$/)), noise(120)),
      /settings catalog misc \(zh_CN\) is \d+ B gz, over its budget of 3072 B/,
    ],
    [
      // each within its own budget (security 4.7 KB of 5 KB, backup 2.9 KB of 3 KB), the view far over 12 KB
      "what the settings page loads together with a vault over the 12 KB its text had as one catalog",
      "prod",
      (d) => {
        writeFileSync(join(d, "assets", asset(d, /^settings-locale-security-zh_CN-[\w-]+\.js$/)), noise(50, 1));
        writeFileSync(join(d, "assets", asset(d, /^settings-locale-backup-zh_CN-[\w-]+\.js$/)), noise(30, 2));
      },
      /the settings page with a vault \(zh_CN\) loads \d+ B gz of text together, over the 12288 B its text had as one catalog/,
    ],
    [
      "every part together over 12 KB (the wizard's and the lock's parts grown, each within its budget)",
      "e2e",
      (d) => {
        writeFileSync(join(d, "assets", asset(d, /^settings-locale-firstrun-en-[\w-]+\.js$/)), noise(31, 3));
        writeFileSync(join(d, "assets", asset(d, /^settings-locale-unlock-en-[\w-]+\.js$/)), noise(31, 4));
      },
      /the settings page every part \(en\) loads \d+ B gz of text together, over the 12288 B/,
    ],
    [
      "a part's chunk that is not the generated file",
      "prod",
      (d) =>
        edit(d, `assets/${asset(d, /^settings-locale-core-en-[\w-]+\.js$/)}`, (t) =>
          t.replace(/message:`/, "message:`x"),
        ),
      /settings catalog core en: the chunk differs from catalogs\/settings-core-en\.json/,
    ],
    [
      "a key in two parts",
      "prod",
      (d) =>
        edit(d, `assets/${asset(d, /^settings-locale-unlock-en-[\w-]+\.js$/)}`, (t) =>
          t.replace("var e={", `var e={${keysOf("catalogs/settings-core-en.json")[0]}:{message:\`x\`},`),
        ),
      /settings catalog unlock en: \w+ is also in the settings catalog core/,
    ],
    [
      "a part loaded up front by the settings page",
      "prod",
      (d) =>
        edit(d, "options/index.html", (t) =>
          t.replace(
            "</head>",
            `<link rel="modulepreload" href="../assets/${asset(d, /^settings-locale-security-en-[\w-]+\.js$/)}">\n</head>`,
          ),
        ),
      /options\/index\.html loads the catalog \.\.\/assets\/settings-locale-security-en-[\w-]+\.js up front/,
    ],
    [
      "a part the settings page cannot load",
      "prod",
      (d) => {
        const name = asset(d, /^settings-locale-general-en-[\w-]+\.js$/);
        for (const f of readdirSync(join(d, "assets")).filter((x) => x.endsWith(".js") && x !== name))
          edit(d, `assets/${f}`, (t) => t.split(name).join("settings-locale-general-en-Gone.js"));
      },
      /the settings page cannot load its catalog settings-locale-general-en-[\w-]+\.js/,
    ],
    [
      "a part the popup can load",
      "prod",
      (d) =>
        edit(
          d,
          `assets/${asset(d, /^popup-(?!locale)[\w-]+\.js$/)}`,
          (t) => `${t}\nconst q=()=>import("./${asset(d, /^settings-locale-core-en-[\w-]+\.js$/)}");`,
        ),
      /the popup can load the settings page's catalog settings-locale-core-en-[\w-]+\.js/,
    ],
    [
      "a getMessage key with no text",
      "prod",
      (d) => edit(d, "sw.js", (t) => `${t}\nchrome.i18n.getMessage("noSuchBadge");`),
      /sw\.js: chrome\.i18n\.getMessage\("noSuchBadge"\) has no text in _locales\/en/,
    ],
    [
      "the managing screens' catalog in a build whose gate keeps the section out",
      "prod",
      (d) => writeFileSync(join(d, "assets/sync-manage-locale-en-AbC123.js"), "var e={};export{e as default};"),
      /assets\/sync-manage-locale-en-AbC123\.js: the sync user interface in a build whose release gate keeps it out/,
    ],
    [
      "a managing screens' key named in a build whose gate keeps the section out",
      "prod",
      (d) =>
        edit(
          d,
          `assets/${asset(d, /^options-[\w-]+\.js$/)}`,
          (t) => `${t}\nconst k="${keysOf("catalogs/sync-manage-en.json")[0]}";`,
        ),
      /names the Sync section's text \(sync\w+\) in a build whose release gate keeps it out/,
    ],
    [
      "the managing screens' Chinese catalog missing",
      "e2e",
      (d) => unlinkSync(join(d, "assets", asset(d, /^sync-manage-locale-zh_CN-[\w-]+\.js$/))),
      /locale zh_CN: expected one Sync section catalog chunk assets\/sync-manage-locale-zh_CN-\*\.js, found 0/,
    ],
    [
      "the managing screens' catalog over its limit",
      "e2e",
      (d) => writeFileSync(join(d, "assets", asset(d, /^sync-manage-locale-en-[\w-]+\.js$/)), noise(500)),
      /sync-manage catalog en is \d+ B gz, over its limit of 12288 B/,
    ],
    [
      // the managing screens' catalog grown to 5.6 KB, within its own 12 KB: both together over 12 KB
      "the Sync section's two catalogs together over 12 KB",
      "e2e",
      (d) => writeFileSync(join(d, "assets", asset(d, /^sync-manage-locale-zh_CN-[\w-]+\.js$/)), noise(60, 5)),
      /the Sync section \(zh_CN\) loads \d+ B gz of text together, over its limit of 12288 B/,
    ],
    [
      "a key in both of the section's catalogs",
      "e2e",
      (d) =>
        edit(d, `assets/${asset(d, /^sync-manage-locale-en-[\w-]+\.js$/)}`, (t) =>
          t.replace("var e={", `var e={${keysOf("catalogs/sync-en.json")[0]}:{message:\`x\`},`),
        ),
      /sync-manage catalog en: \w+ is also in sync/,
    ],
  ];
  it.each(cases)("fails on %s", (_name, f, alter, message) => {
    const r = mutant(f, alter);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(message);
  });
});

describe("the build and the settings page's text", () => {
  // The build in a private copy of the tree, changed in one place; each change must stop it with the rule's message.
  const top = mkdtempSync(join(tmpdir(), "sixkey-budget-build-"));
  afterAll(() => rmSync(top, { recursive: true, force: true }));
  let m = 0;
  function buildCopy(alter: (dir: string) => void) {
    const dir = join(top, `b${++m}`, "extension");
    mkdirSync(dir, { recursive: true });
    symlinkSync(resolve(EXT, "../LICENSES"), join(top, `b${m}`, "LICENSES"), "dir");
    symlinkSync(resolve(EXT, "../rules"), join(top, `b${m}`, "rules"), "dir"); // the site rules (AF3-3a)
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
    ])
      cpSync(join(EXT, p), join(dir, p), { recursive: true });
    symlinkSync(join(EXT, "node_modules"), join(dir, "node_modules"));
    alter(dir);
    const r = spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: dir, encoding: "utf8", env });
    return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
  }
  const prepend = (dir: string, f: string, text: string) =>
    writeFileSync(join(dir, f), `${text}\n${readFileSync(join(dir, f), "utf8")}`);

  it.each([
    [
      "the settings page loading the full catalog again",
      (d: string) =>
        prepend(d, "src/options/main.tsx", 'import { fullCatalog as __full } from "../ui/catalog-full";\nvoid __full;'),
      /the settings page can load the full catalog _locales\/(en|zh_CN)\/messages\.json/,
    ],
    [
      "a part's catalog imported statically",
      (d: string) =>
        prepend(
          d,
          "src/options/App.tsx",
          'import __core from "../../catalogs/settings-security-en.json";\nvoid __core;',
        ),
      /the settings catalog chunk assets\/settings-locale-security-en-[\w-]+\.js is imported statically|the settings page cannot load the catalogs/,
    ],
    [
      "a key the page's code names that no settings catalog has",
      (d: string) => {
        const py = join(d, "scripts/i18n/budget.py");
        const text = readFileSync(py, "utf8");
        if (!/\n\s*"cancel",/.test(text)) throw new Error("budget.py does not place cancel");
        writeFileSync(py, text.replace(/\n\s*"cancel",/, ""));
        const r = spawnSync("python3", ["scripts/messages.py"], { cwd: d, encoding: "utf8" });
        if (r.status !== 0) throw new Error(r.stderr);
      },
      /settings page code mentions message keys no settings catalog has: cancel \(/,
    ],
    [
      "the managing screens' catalog imported where the gate is closed",
      (d: string) =>
        prepend(d, "src/options/App.tsx", 'import __m from "../../catalogs/sync-manage-en.json";\nvoid __m;'),
      /a prod build must not contain the developer sync page or the enrolment code: catalogs\/sync-manage-en\.json/,
    ],
  ])(
    "stops on %s",
    (_name, alter, message) => {
      const r = buildCopy(alter);
      expect(r.ok).toBe(false);
      expect(r.out).toMatch(message);
    },
    120_000,
  );
});
