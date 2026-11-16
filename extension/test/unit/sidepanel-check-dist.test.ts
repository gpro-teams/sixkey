// scripts/check-dist.mjs's and scripts/sw-order.mjs's rules for the side panel (docs/design/notes/SIDEPANEL-NOTES.md §5),
// against a real store build altered one rule at a time (as budget-check-dist.test.ts does for its rules): `sidePanel`
// is the one permission added, required and nowhere else, and every other change of the list still fails; no `side_panel`
// manifest key; the panel's page exists and starts like every page; the panel has its own enforced budget and loads only
// the popup's catalogs; nothing names the side panel's open-on-click behaviour; and the built worker sets what the icon
// opens right after the storage access level.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error a plain .mjs script with no type declarations
import { swActionFirst } from "../../scripts/sw-order.mjs";

const EXT = resolve(__dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "sixkey-sidepanel-check-dist-"));
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
const edit = (dir: string, f: string, fn: (t: string) => string) =>
  writeFileSync(join(dir, f), fn(readFileSync(join(dir, f), "utf8")));
const manifest = (dir: string, fn: (j: Record<string, unknown>) => void) =>
  edit(dir, "manifest.json", (t) => {
    const j = JSON.parse(t) as Record<string, unknown>;
    fn(j);
    return JSON.stringify(j, null, 2);
  });
const asset = (dir: string, re: RegExp) => readdirSync(join(dir, "assets")).find((x) => re.test(x))!;
/** Text that does not compress, `kb` KiB of it. */
const noise = (kb: number) =>
  Array.from({ length: kb * 1024 }, (_, i) => String.fromCharCode(0x4e00 + ((i * 7919 + 104729) % 20000))).join("");

beforeAll(() => {
  const r = spawnSync(process.execPath, ["scripts/build.mjs", "--out", built], { cwd: EXT, encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`build failed:\n${r.stdout}\n${r.stderr}`);
}, 300_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("check-dist and the side panel", () => {
  it("the pristine build passes, the panel counted against its own budget, the popup against its own", () => {
    const r = check(built);
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toMatch(/popup gzip, bytes: \d+ of 61440 = static \d+ \+ catalog \d+/);
    expect(r.out).toMatch(/side panel gzip, bytes: \d+ of 63488 = static \d+ \+ catalog \d+ \(zh_CN\)/);
    const m = JSON.parse(readFileSync(join(built, "manifest.json"), "utf8"));
    expect(m.permissions).toEqual([
      "storage",
      "unlimitedStorage",
      "activeTab",
      "alarms",
      "idle",
      "offscreen",
      "sidePanel",
    ]);
    // autofill's `scripting`: optional since wave 1b of the plugin platform (PLUGINS-W1B-NOTES.md)
    expect(m.optional_permissions).toContain("scripting");
    expect(m.side_panel).toBeUndefined();
  });

  const permission: [string, (j: Record<string, unknown>) => void, RegExp][] = [
    [
      "sidePanel left out",
      (j) => void (j.permissions = (j.permissions as string[]).filter((p) => p !== "sidePanel")),
      /permissions must be exactly/,
    ],
    [
      "tabs added (an install warning: history)",
      (j) => void (j.permissions as string[]).push("tabs"),
      /permissions must be exactly/,
    ],
    [
      "scripting required again (optional since wave 1b)",
      (j) => void (j.permissions as string[]).push("scripting"),
      /permissions must be exactly/,
    ],
    [
      "declarativeContent added (TOTP-AUTOFILL §2.4's optional extra: not in Stage 1)",
      (j) => void (j.permissions as string[]).push("declarativeContent"),
      /permissions must be exactly/,
    ],
    [
      "webNavigation added",
      (j) => void (j.permissions as string[]).push("webNavigation"),
      /permissions must be exactly/,
    ],
    [
      "sidePanel twice, nothing else",
      (j) => void (j.permissions as string[]).push("sidePanel"),
      /permissions must be exactly/,
    ],
    [
      "sidePanel moved to the optional permissions",
      (j) => {
        j.permissions = (j.permissions as string[]).filter((p) => p !== "sidePanel");
        (j.optional_permissions as string[]).push("sidePanel");
      },
      /permissions must be exactly/,
    ],
    [
      "sidePanel also optional",
      (j) => void (j.optional_permissions as string[]).push("sidePanel"),
      /optional permission not allowed: sidePanel/,
    ],
    [
      "a manifest side_panel key",
      (j) => void (j.side_panel = { default_path: "sidepanel/index.html" }),
      /manifest key not allowed: side_panel/,
    ],
  ];
  for (const [what, alter, msg] of permission)
    it(`fails: ${what}`, () => {
      const r = mutant((d) => manifest(d, alter));
      expect(r.ok, r.out).toBe(false);
      expect(r.out).toMatch(msg);
    });

  it("fails: the side panel's page missing (the worker names it), or starting without its own policy and theme", () => {
    let r = mutant((d) => rmSync(join(d, "sidepanel"), { recursive: true }));
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/sidepanel\/index\.html missing: the worker opens it as the side panel's page/);
    r = mutant((d) =>
      edit(d, "sidepanel/index.html", (t) =>
        t.replace(`<meta http-equiv="Content-Security-Policy" content="connect-src 'none'">`, ""),
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/sidepanel\/index\.html: no page-level connect-src 'none'/);
    r = mutant((d) =>
      edit(d, "sidepanel/index.html", (t) => t.replace(/<script src="\.\.\/theme-boot\.js"><\/script>/, "")),
    );
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/sidepanel\/index\.html: theme-boot\.js is not loaded/);
  });

  it("fails: the panel over its budget only once its catalog is counted (the static part alone is within it)", () => {
    // a pad that lands the static part within the budget and the whole over it, whatever the headroom is today (the
    // cloud backup's patches took some of it, which put the earlier fixed 3 KB pad at the budget on its own): the
    // first that does
    let landed = false;
    for (const kb of [3, 2.75, 2.5, 2.25, 2, 1.75, 1.5, 1.25, 1]) {
      const r = mutant((d) => {
        const entry = asset(d, /^sidepanel-.*\.js$/);
        edit(d, `assets/${entry}`, (t) => `${t}\nvar __pad=${JSON.stringify(noise(kb))};`);
      });
      const m = /side panel gzip, bytes: (\d+) of (\d+) = static (\d+) \+ catalog (\d+)/.exec(r.out)!;
      const [total, budget, statics] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (statics >= budget) continue; // this pad alone fails: a smaller one
      expect(total, `${kb} KB`).toBeGreaterThan(budget);
      expect(r.ok).toBe(false);
      expect(r.out).toMatch(/side panel bundle \d+ B gz exceeds budget 63488 B/);
      landed = true;
      break;
    }
    expect(landed).toBe(true);
  });

  it("fails: the panel over its budget, with the popup within its own", () => {
    const r = mutant((d) => {
      const entry = asset(d, /^sidepanel-.*\.js$/);
      edit(d, `assets/${entry}`, (t) => `${t}\nvar __pad=${JSON.stringify(noise(4))};`);
    });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/side panel bundle \d+ B gz exceeds budget 63488 B/);
    expect(r.out).not.toMatch(/popup bundle \d+ B gz exceeds/);
  });

  it("fails: the panel able to load a settings page catalog, or preloading its catalog", () => {
    let r = mutant((d) => {
      const entry = asset(d, /^sidepanel-.*\.js$/);
      const settings = asset(d, /^settings-locale-core-en-.*\.js$/);
      edit(d, `assets/${entry}`, (t) => `${t}\nvar __x="${settings}";`);
    });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/the side panel can load the settings page's catalog settings-locale-core-en-/);
    r = mutant((d) => {
      const cat = asset(d, /^popup-locale-zh_CN-.*\.js$/);
      edit(d, "sidepanel/index.html", (t) =>
        t.replace("</head>", `<link rel="modulepreload" href="../assets/${cat}"></head>`),
      );
    });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/sidepanel\/index\.html preloads a catalog chunk statically/);
  });

  for (const name of ["openPanelOnActionClick", "setPanelBehavior"])
    it(`fails: a shipped script naming ${name} (the panel would lose activeTab)`, () => {
      const r = mutant((d) => {
        const entry = asset(d, /^sidepanel-.*\.js$/);
        edit(d, `assets/${entry}`, (t) => `${t}\n/* ${name} */`);
      });
      expect(r.ok).toBe(false);
      expect(r.out).toMatch(/the side panel's open-on-click behaviour/);
    });

  it("fails: a worker that no longer sets what the icon opens at start (the read and the listeners gone)", () => {
    const r = mutant((d) =>
      edit(d, "sw.js", (t) => {
        const out = t.replace(/\.onClicked\?\.addListener\(/g, ".onClickedGone?.addListener(");
        expect(out).not.toBe(t);
        return out;
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(
      /right after the access level, the worker must add the toolbar icon's click and change listeners/,
    );
  });

  it("the built worker passes the order check on its own, and the order check refuses the stand-ins it should", () => {
    const sw = readFileSync(join(built, "sw.js"), "utf8");
    const order = swActionFirst as (src: string) => { ok: boolean; reason: string; first: string[] };
    expect(order(sw)).toMatchObject({ ok: true });
    const L =
      "chrome.storage.local.setAccessLevel({});chrome.storage.session.setAccessLevel({});chrome.storage.sync.setAccessLevel({});";
    const CLICK = "chrome.action.onClicked.addListener(function(){});";
    const CHANGE = "chrome.storage.local.onChanged.addListener(function(){});";
    const READ = "chrome.storage.local.get(['sk_opener','sk_settings']);";
    const MSG = "chrome.runtime.onMessage.addListener(function(){});";
    expect(order(`${L}${CLICK}${CHANGE}${READ}${MSG}`).ok).toBe(true);
    for (const src of [
      `${L}${MSG}${CLICK}${CHANGE}${READ}`, // another listener first
      `${L}${CLICK}${CHANGE}${MSG}${READ}`, // the read after another listener
      `${L}${CLICK}${CHANGE}`, // no read at start
      `${L}${CHANGE}${CLICK}${READ}`, // the change listener first
      `${L}${MSG}`,
      "throw new Error('x')",
    ])
      expect(order(src).ok, src).toBe(false);
  });
});
