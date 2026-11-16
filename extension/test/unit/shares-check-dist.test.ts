// The recovery code shares' text and chunks (docs/design/notes/SHAMIR-NOTES.md §6, §7) against real builds and against
// scripts/messages.py: check-dist's rules for the shares (one entry chunk, one wizard chunk and one text chunk per
// language; each text chunk exactly the generated file, within SHARES_CATALOG_GZ, with keys of no other catalog; none of
// them in a page's static graph; the wizard the settings page's only) and messages.py's refusals for SHARES_EN/_ZH. Each
// altered copy breaks one rule and must fail with that rule's message, as budget-check-dist.test.ts does for the parts.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const EXT = resolve(__dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "sixkey-shares-check-dist-"));
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
/** The chunk the popup's page loads first (its own script), to name or import a chunk from it. */
const popupEntry = (dir: string) =>
  readFileSync(join(dir, "popup/index.html"), "utf8").match(/<script[^>]*src="\.\.\/assets\/([^"]+\.js)"/)![1]!;
/** A catalog chunk of text that does not compress (`seed`: another text, which does not compress against it either). */
const noise = (entries: number, seed = 0) =>
  `var e={${Array.from({ length: entries }, (_, i) => `sh${i}:{message:\`${Array.from({ length: 40 }, (_, j) => String.fromCharCode(0x4e00 + ((seed * 104729 + i * 131 + j * 7919) % 20000))).join("")}\`}`).join(",")}};export{e as default};`;

beforeAll(() => {
  build("prod");
  build("e2e");
}, 300_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("check-dist and the recovery code shares' chunks", () => {
  it("the pristine builds pass, the shares' text counted against its own limit", () => {
    for (const f of ["prod", "e2e"] as const) {
      const r = check(built[f], f);
      expect(r.ok, r.out).toBe(true);
      expect(r.out).toMatch(/recovery code shares text en: \d+ B gz \(limit 3072 B\)/);
      expect(r.out).toMatch(/recovery code shares text zh_CN: \d+ B gz \(limit 3072 B\)/);
      expect(r.out).toMatch(/a vault's page with the shares' text in \(zh_CN\): \d+ B gz \(limit 15360 B\)/);
    }
  });

  const cases: [string, Flavour, (d: string) => void, RegExp][] = [
    [
      "the shares' text over its limit",
      "prod",
      (d) => writeFileSync(join(d, "assets", asset(d, /^shares-locale-zh_CN-[\w-]+\.js$/)), noise(80)),
      /shares text zh_CN is \d+ B gz, over its limit of 3072 B/,
    ],
    [
      "the shares' text over its limit, in the e2e build too",
      "e2e",
      (d) => writeFileSync(join(d, "assets", asset(d, /^shares-locale-en-[\w-]+\.js$/)), noise(80)),
      /shares text en is \d+ B gz, over its limit of 3072 B/,
    ],
    [
      "a shares text chunk missing",
      "prod",
      (d) => unlinkSync(join(d, "assets", asset(d, /^shares-locale-en-[\w-]+\.js$/))),
      /locale en: expected one shares text chunk assets\/shares-locale-en-\*\.js, found 0/,
    ],
    [
      "a shares text chunk that is not the generated file",
      "prod",
      (d) =>
        edit(d, `assets/${asset(d, /^shares-locale-en-[\w-]+\.js$/)}`, (t) =>
          t.replace(/shStale:\{message:`[^`]*`\}/, "shStale:{message:`These shares are fine.`}"),
        ),
      /shares-locale-en-[\w-]+\.js differs from catalogs\/shares-en\.json/,
    ],
    [
      "a shares key that is also a key of the full catalog",
      "prod",
      (d) =>
        edit(d, `assets/${asset(d, /^shares-locale-en-[\w-]+\.js$/)}`, (t) =>
          t.replace("var e={", "var e={appName:{message:`x`},"),
        ),
      /shares text en: appName is also a key of the full catalog/,
    ],
    [
      // each part within its own budget, the shares' text within its own: the page with it over 15 KB (and its view over
      // 12 KB, said too)
      "a vault's page with the shares' text in over 15 KB",
      "prod",
      (d) => {
        writeFileSync(join(d, "assets", asset(d, /^settings-locale-security-zh_CN-[\w-]+\.js$/)), noise(50, 1));
        writeFileSync(join(d, "assets", asset(d, /^settings-locale-accounts-zh_CN-[\w-]+\.js$/)), noise(30, 2));
        writeFileSync(join(d, "assets", asset(d, /^settings-locale-backup-zh_CN-[\w-]+\.js$/)), noise(30, 3));
        writeFileSync(join(d, "assets", asset(d, /^shares-locale-zh_CN-[\w-]+\.js$/)), noise(30, 4));
      },
      /a vault's page with the shares' text in \(zh_CN\) is \d+ B gz, over the 15360 B it may hold/,
    ],
    [
      "two share entry chunks",
      "prod",
      (d) => writeFileSync(join(d, "assets/ShareEntry-AbC123.js"), "export{};"),
      /expected one share entry chunk assets\/ShareEntry-\*\.js, found 2/,
    ],
    [
      "the share entry imported statically by the popup's page",
      "prod",
      (d) => {
        const entry = asset(d, /^ShareEntry-[\w-]+\.js$/);
        edit(d, `assets/${popupEntry(d)}`, (t) => `import "./${entry}";\n${t}`);
      },
      /popup\/index\.html loads ShareEntry-[\w-]+\.js statically; it must load on first use/,
    ],
    [
      "the wizard reachable from the popup",
      "prod",
      (d) => {
        const wizard = asset(d, /^ShareWizard-[\w-]+\.js$/);
        edit(d, `assets/${popupEntry(d)}`, (t) => `${t}\n;void import("./${wizard}");`);
      },
      /popup\/index\.html can load the shares wizard ShareWizard-[\w-]+\.js; it is the settings page's/,
    ],
  ];
  it.each(cases)("fails on %s", (_name, f, alter, message) => {
    const r = mutant(f, alter);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(message);
  });
});

describe("the page with the shares' text: at most 15,360 B (the owner's decision, SHAMIR-NOTES.md §6)", () => {
  it("is the 12 KB view limit plus the shares' budget, in messages.py and in check-dist alike", () => {
    const py = readFileSync(join(EXT, "scripts/messages.py"), "utf8");
    const dist = readFileSync(join(EXT, "scripts/check-dist.mjs"), "utf8");
    const view = +/^VIEW_LIMIT = (\d+)$/m.exec(py)![1]!;
    const shares = +/^ {4}"shares": (\d+),$/m.exec(py)![1]!;
    expect(+/^SHARES_PAGE_LIMIT = (\d+)$/m.exec(py)![1]!).toBe(view + shares);
    expect(view + shares).toBe(15360);
    expect(dist).toMatch(/^const SHARES_PAGE_GZ = 15 \* 1024;$/m);
    expect(dist).toMatch(/^const SHARES_CATALOG_GZ = 3072;$/m);
  });
});

describe("scripts/messages.py and the shares' catalog", () => {
  const top = mkdtempSync(join(tmpdir(), "sixkey-shares-messages-"));
  afterAll(() => rmSync(top, { recursive: true, force: true }));
  let m = 0;
  function run(body?: string) {
    const dir = join(top, `m${++m}`);
    for (const p of [
      "scripts/messages.py",
      "scripts/i18n",
      "manifest.base.json",
      "manifest.dev.json",
      "manifest.e2e.json",
      "src",
    ])
      cpSync(join(EXT, p), join(dir, p), { recursive: true });
    if (body) writeFileSync(join(dir, "scripts/i18n/zz.py"), body);
    const r = spawnSync("python3", ["scripts/messages.py"], { cwd: dir, encoding: "utf8" });
    return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`, dir };
  }
  it("on this tree: writes catalogs/shares-<lang>.json as the tree has them, and prints the page with them in", () => {
    const r = run();
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toMatch(/shares \d+ keys, \d+ of 3072 B/);
    expect(r.out).toMatch(
      /a vault's page with the shares' text in \(lazy, not held to 12288 B; SHAMIR-NOTES\.md §6\): \d+ of 15360 B/,
    );
    for (const l of ["en", "zh_CN"])
      expect(readFileSync(join(r.dir, `catalogs/shares-${l}.json`), "utf8")).toBe(
        readFileSync(join(EXT, `catalogs/shares-${l}.json`), "utf8"),
      );
  });
  it.each([
    [
      "a shares key that is a key of the full catalogs",
      `SHARES_EN = {"appName": "x"}\nSHARES_ZH = {"appName": "x"}\n`,
      /shares key 'appName' is also a key of another catalog \(the sets are disjoint\)/,
    ],
    [
      "a shares key that is the Fill button's",
      `SHARES_EN = {"afFill": "x"}\nSHARES_ZH = {"afFill": "x"}\n`,
      /shares key 'afFill' is also a key of another catalog/,
    ],
    [
      "a shares key added twice",
      `SHARES_EN = {"shStale": "x"}\nSHARES_ZH = {"shStale": "x"}\n`,
      /shares key 'shStale' is also added by scripts\/i18n\/shares\.py/,
    ],
    [
      "English and Chinese with different shares keys",
      `SHARES_EN = {"shOnlyEnglish": "x"}\nSHARES_ZH = {}\n`,
      /SHARES_EN and SHARES_ZH add different keys: \['shOnlyEnglish'\]/,
    ],
    [
      "the shares' catalog over its budget",
      `SHARES_EN = {${Array.from({ length: 80 }, (_, i) => `"shX${i}": "${Array.from({ length: 40 }, (_, j) => String.fromCharCode(0x4e00 + ((i * 131 + j * 7919) % 20000))).join("")}"`).join(", ")}}\nSHARES_ZH = SHARES_EN\n`,
      /catalog shares is \d+ B gzipped, over its budget of 3072 B/,
    ],
  ])("refuses %s, and writes nothing", (_name, body, message) => {
    const r = run(body);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(message);
    expect(readdirSync(r.dir)).not.toContain("catalogs");
  });
});
