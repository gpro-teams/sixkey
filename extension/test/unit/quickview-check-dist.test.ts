// scripts/check-dist.mjs's and scripts/build.mjs's rules for the View menu (docs/design/notes/QUICKVIEW-NOTES.md) against a
// real build: its code is one chunk and its text one chunk per language, exactly the generated file, within their own
// budget; the popup and the side panel reach them by import() only and the settings page not at all; and a build whose
// source loads the menu up front, or lets it show a key with no text, stops. Each altered copy breaks one rule and must
// fail with that rule's message (as budget-check-dist.test.ts does for the settings page's parts).
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
const work = mkdtempSync(join(tmpdir(), "sixkey-quickview-check-dist-"));
const prod = join(work, "prod");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_ENV"));

function check(dir: string) {
  const r = spawnSync(process.execPath, ["scripts/check-dist.mjs", "--dist", dir], { cwd: EXT, encoding: "utf8", env });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}
let n = 0;
function mutant(alter: (dir: string) => void) {
  const dir = join(work, `m${++n}`);
  cpSync(prod, dir, { recursive: true });
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
const noise = (entries: number) =>
  `var e={${Array.from({ length: entries }, (_, i) => `k${i}:{message:\`${Array.from({ length: 40 }, (_, j) => String.fromCharCode(0x4e00 + ((i * 131 + j * 7919) % 20000))).join("")}\`}`).join(",")}};export{e as default};`;

beforeAll(() => {
  const r = spawnSync(process.execPath, ["scripts/build.mjs", "--out", prod], { cwd: EXT, encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`build failed:\n${r.stdout}\n${r.stderr}`);
}, 300_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("check-dist and the View menu's chunks", () => {
  it("the pristine build passes: one code chunk, one text chunk per language, within the budget, none up front", () => {
    const r = check(prod);
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toMatch(/View menu catalogs \(B gz, loaded when the menu opens\): en \d+ \/ zh_CN \d+ of 2048/);
    const assets = readdirSync(join(prod, "assets"));
    expect(assets.filter((x) => /^View-[\w-]+\.js$/.test(x))).toHaveLength(1);
    expect(assets.filter((x) => /^view-locale-(en|zh_CN)-[\w-]+\.js$/.test(x))).toHaveLength(2);
    // none of it is in the pages' HTML, and the counted bundle is only what the HTML names
    for (const page of ["popup", "sidepanel", "options"])
      expect(readFileSync(join(prod, page, "index.html"), "utf8"), page).not.toMatch(/\/View-|view-locale/);
  });

  const cases: [string, (d: string) => void, RegExp][] = [
    [
      "the menu's code chunk missing",
      (d) => unlinkSync(join(d, "assets", asset(d, /^View-[\w-]+\.js$/))),
      /expected one View menu chunk assets\/View-\*\.js, found 0/,
    ],
    [
      "the menu's Chinese text missing",
      (d) => unlinkSync(join(d, "assets", asset(d, /^view-locale-zh_CN-[\w-]+\.js$/))),
      /locale zh_CN: expected one View menu catalog chunk assets\/view-locale-zh_CN-\*\.js, found 0/,
    ],
    [
      "the menu's text over its budget",
      (d) => writeFileSync(join(d, "assets", asset(d, /^view-locale-en-[\w-]+\.js$/)), noise(120)),
      /View menu catalog \(en\) is \d+ B gz, over its budget of 2048 B/,
    ],
    [
      "the menu's text that is not the generated file",
      (d) => edit(d, `assets/${asset(d, /^view-locale-en-[\w-]+\.js$/)}`, (t) => t.replace(/message:`/, "message:`x")),
      /View menu catalog en: the chunk differs from catalogs\/view-en\.json/,
    ],
    [
      "the menu's text loaded up front by the popup",
      (d) =>
        edit(d, "popup/index.html", (t) =>
          t.replace(
            "</head>",
            `<link rel="modulepreload" href="../assets/${asset(d, /^view-locale-en-[\w-]+\.js$/)}">\n</head>`,
          ),
        ),
      /popup\/index\.html (loads the View menu catalog view-locale-en-[\w-]+\.js up front|preloads a catalog chunk statically)|popup\/index\.html loads the View menu catalog/,
    ],
    [
      "the menu's code loaded up front by the popup",
      (d) =>
        edit(d, "popup/index.html", (t) =>
          t.replace("</head>", `<link rel="modulepreload" href="../assets/${asset(d, /^View-[\w-]+\.js$/)}">\n</head>`),
        ),
      /popup\/index\.html loads the View menu View-[\w-]+\.js up front/,
    ],
    [
      "the menu's text that the popup cannot load",
      (d) => {
        const name = asset(d, /^view-locale-en-[\w-]+\.js$/);
        for (const f of readdirSync(join(d, "assets")).filter((x) => x.endsWith(".js") && x !== name))
          edit(d, `assets/${f}`, (t) => t.split(name).join("view-locale-en-Gone.js"));
      },
      /the popup cannot load its View menu catalog view-locale-en-[\w-]+\.js/,
    ],
    [
      "the menu that the settings page can load",
      (d) =>
        edit(
          d,
          `assets/${asset(d, /^options-[\w-]+\.js$/)}`,
          (t) => `${t}\nconst q=()=>import("./${asset(d, /^View-[\w-]+\.js$/)}");`,
        ),
      /the settings page can load the View menu/,
    ],
    [
      "the menu's text that the settings page can load",
      (d) =>
        edit(
          d,
          `assets/${asset(d, /^options-[\w-]+\.js$/)}`,
          (t) => `${t}\nconst q=()=>import("./${asset(d, /^view-locale-zh_CN-[\w-]+\.js$/)}");`,
        ),
      /the settings page can load the View menu catalog view-locale-zh_CN-[\w-]+\.js/,
    ],
  ];
  it.each(cases)("fails on %s", (_name, alter, message) => {
    const r = mutant(alter);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(message);
  });
});

describe("the build and the View menu", () => {
  // The build in a private copy of the tree, changed in one place; each change must stop it with the rule's message.
  const top = mkdtempSync(join(tmpdir(), "sixkey-quickview-build-"));
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
      "the popup's list importing the menu up front",
      (d: string) => prepend(d, "src/popup/main/Main.tsx", 'import { ViewMenu as __v } from "./View";\nvoid __v;'),
      /assets\/(popup|sidepanel)-[\w-]+\.js imports assets\/[\w-]+\.js up front; the View menu loads only when it is opened/,
    ],
    [
      "a key the menu can show that has no text in its catalog or the popup's",
      (d: string) =>
        prepend(d, "src/popup/main/View.tsx", 'import { t as __t } from "../../ui/i18n";\nvoid __t("advLead");'),
      /the View menu \(src\/popup\/main\/View\.tsx\) can show keys that neither the popup's catalog nor catalogs\/view-en\.json has: advLead/,
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
