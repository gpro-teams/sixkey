// The PIN record's chunks and text (docs/design/notes/PIN-RESTART-NOTES.md §8, §18) against a real build and
// scripts/messages.py: check-dist's rules (one steps chunk, one chunk of the PIN box's lazy part, and one text chunk per
// language; each text chunk exactly the generated file, within its limit, with keys of no other catalog; the settings
// page's catalog counted in a vault's page with every lazy catalog, held to 15,360 B; none of them, nor the record's
// crypto, in the popup's static graph; the steps every page's, the PIN box's part and its text the settings page's only),
// and messages.py's (disjoint keys, the same keys in both languages, the catalog as the tree has it, no lock-screen
// catalog since 2026-10-30). Each altered copy breaks one rule and must fail with that rule's message, as
// prf-check-dist.test.ts does.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const EXT = resolve(__dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "sixkey-pin-restart-check-dist-"));
const built = join(work, "prod");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_ENV"));

function check(dir: string) {
  const r = spawnSync(process.execPath, ["scripts/check-dist.mjs", "--dist", dir], { cwd: EXT, encoding: "utf8", env });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}
let n = 0;
function mutant(alter: (dir: string) => void) {
  const dir = join(work, `m${++n}`);
  cpSync(built, dir, { recursive: true });
  alter(dir);
  try {
    return check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const asset = (dir: string, re: RegExp) => readdirSync(join(dir, "assets")).find((x) => re.test(x))!;
const edit = (dir: string, f: string, fn: (t: string) => string) =>
  writeFileSync(join(dir, f), fn(readFileSync(join(dir, f), "utf8")));
const entry = (dir: string, page: string) =>
  readFileSync(join(dir, page), "utf8").match(/<script[^>]*src="\.\.\/assets\/([^"]+\.js)"/)![1]!;
/** A catalog chunk of `entries` messages of 40 CJK characters each: incompressible enough to weigh what it says. */
const noise = (entries: number, keys: string[]) =>
  `var e={${keys.map((k) => `${k}:{message:\`x\`}`).join(",")},${Array.from(
    { length: entries },
    (_, i) =>
      `zz${i}:{message:\`${Array.from({ length: 40 }, (_, j) => String.fromCharCode(0x4e00 + ((i * 131 + j * 7919) % 20000))).join("")}\`}`,
  ).join(",")}};export{e as default};`;

beforeAll(() => {
  const r = spawnSync(process.execPath, ["scripts/build.mjs", "--out", built], { cwd: EXT, encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`build failed:\n${r.stdout}\n${r.stderr}`);
}, 300_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("check-dist and the PIN record's chunks", () => {
  it("the pristine build passes, its text counted against its own limit, the settings page's in a vault's page", () => {
    const r = check(built);
    expect(r.ok, r.out).toBe(true);
    for (const l of ["en", "zh_CN"])
      expect(r.out).toMatch(new RegExp(`PIN record text ${l}: \\d+ B gz \\(limit 2048 B\\)`));
    expect(r.out).not.toMatch(/lock-screen text/); // its lock screen's catalog went on 2026-10-30
    const view = +/every other lazy catalog in \(zh_CN\): (\d+) B gz/.exec(r.out)![1]!;
    expect(view).toBeLessThanOrEqual(15360 - 80); // the maintainers' floor for what is left (PIN-RESTART-NOTES.md §8)
  });

  const cases: [string, (d: string) => void, RegExp][] = [
    [
      "its text over its limit",
      (d) => writeFileSync(join(d, "assets", asset(d, /^restart-locale-zh_CN-/)), noise(80, ["rsCost"])),
      /PIN record text zh_CN is \d+ B gz, over its limit of 2048 B/,
    ],
    [
      // (with the plugin platform's text gone, the PIN record's alone, within its limit, no longer takes the page over:
      // the autofill switch's text, within its own, is padded too)
      "its text within its limit, but a vault's page with every lazy catalog over 15,360 B",
      (d) => {
        writeFileSync(join(d, "assets", asset(d, /^restart-locale-zh_CN-/)), noise(18, ["rsCost"]));
        writeFileSync(join(d, "assets", asset(d, /^plugins-locale-zh_CN-/)), noise(26, ["pxAfName"]));
      },
      /a vault's page with the plugins' text and every other lazy catalog in \(zh_CN\) is \d+ B gz, over 15360 B/,
    ],
    [
      "a text chunk missing",
      (d) => unlinkSync(join(d, "assets", asset(d, /^restart-locale-en-/))),
      /locale en: expected one PIN record text chunk/,
    ],
    [
      "a text chunk that is not the generated file",
      (d) => edit(d, `assets/${asset(d, /^restart-locale-en-/)}`, (t) => t.replace(/offline/, "off-line")),
      /differs from catalogs\/restart-en\.json/,
    ],
    [
      "a key of the full catalog in its text",
      (d) => edit(d, `assets/${asset(d, /^restart-locale-en-/)}`, (t) => t.replace(/rsCost:/, "unlock:")),
      /PIN record text en: unlock is also a key of the full catalog/,
    ],
    [
      "two steps chunks",
      (d) => {
        const f = asset(d, /^pin-restart-steps-[A-Za-z0-9_-]+\.js$/);
        writeFileSync(join(d, "assets", "pin-restart-steps-AAAAAAAA.js"), readFileSync(join(d, "assets", f)));
      },
      /expected one PIN record steps chunk assets\/pin-restart-steps-\*\.js, found 2/,
    ],
    [
      "the steps chunk in the popup's static graph",
      (d) =>
        edit(
          d,
          `assets/${entry(d, "popup/index.html")}`,
          (t) => `import "./${asset(d, /^pin-restart-steps-[A-Za-z0-9_-]+\.js$/)}";\n${t}`,
        ),
      /popup\/index\.html loads pin-restart-steps-[A-Za-z0-9_-]+\.js statically/,
    ],
    [
      "the record's crypto in the popup's static graph",
      (d) => edit(d, `assets/${entry(d, "popup/index.html")}`, (t) => `${t}\nvar zz="sixkey-pin-restart|1|";`),
      /popup\/index\.html carries the PIN record's crypto in its static graph/,
    ],
    [
      "the PIN box's lazy part reachable from the popup",
      (d) =>
        edit(d, `assets/${entry(d, "popup/index.html")}`, (t) => `${t}\nvar zz="./${asset(d, /^PinRestartBox-/)}";`),
      /popup\/index\.html can load PinRestartBox-[A-Za-z0-9_-]+\.js: the PIN box's lazy part is the settings page's own/,
    ],
    [
      "its text reachable from the side panel",
      (d) =>
        edit(
          d,
          `assets/${entry(d, "sidepanel/index.html")}`,
          (t) => `${t}\nvar zz="./${asset(d, /^restart-locale-zh_CN-/)}";`,
        ),
      /sidepanel\/index\.html can load restart-locale-zh_CN-[A-Za-z0-9_-]+\.js: the PIN box's lazy part is the settings page's own/,
    ],
  ];
  it.each(cases)("fails on %s", (_, alter, message) => {
    const r = mutant(alter);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(message);
  });
});

describe("scripts/messages.py and the PIN record's catalog", () => {
  const top = mkdtempSync(join(tmpdir(), "sixkey-pin-restart-messages-"));
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
  it("on this tree: writes its catalog as the tree has it, within its budget, and no lock-screen catalog any more", () => {
    const r = run();
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toMatch(/restart 1 keys, \d+ of 2048 B/);
    expect(r.out).not.toMatch(/restart-popup/);
    expect(readdirSync(join(r.dir, "catalogs")).filter((n) => n.startsWith("restart-popup"))).toEqual([]);
    for (const name of ["restart"])
      for (const l of ["en", "zh_CN"])
        expect(readFileSync(join(r.dir, `catalogs/${name}-${l}.json`), "utf8"), `${name}-${l}`).toBe(
          readFileSync(join(EXT, `catalogs/${name}-${l}.json`), "utf8"),
        );
  });
  it.each([
    [
      "a restart key that is a key of the full catalogs",
      'RESTART_EN = {"unlock": "x"}\nRESTART_ZH = {"unlock": "x"}\n',
    ],
    ["a restart key that is the device unlock's", 'RESTART_EN = {"dvDue": "x"}\nRESTART_ZH = {"dvDue": "x"}\n'],
    ["a key added twice", 'RESTART_EN = {"rsCost": "x"}\nRESTART_ZH = {"rsCost": "x"}\n'],
    ["English and Chinese with different keys", 'RESTART_EN = {"rsA": "x"}\nRESTART_ZH = {"rsB": "x"}\n'],
  ])("refuses %s", (_, body) => {
    const r = run(body);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/restart key|RESTART_EN and RESTART_ZH add different keys/);
  });
});
