// The device unlock's chunks and text (docs/design/notes/PRF-NOTES.md) against real builds and scripts/messages.py:
// check-dist's rules (one lock-screen chunk, one box chunk and one text chunk per language; each text chunk exactly the
// generated file, within DEVICE_CATALOG_GZ, with keys of no other catalog; a vault's page with every lazy catalog within
// 15,360 B; none of them, and no WebAuthn call, in a page's static graph; the box the settings page's only) and the dev
// build's fixed extension ID (the manifest key: dev only, the expected ID). Each altered copy breaks one rule and must fail
// with that rule's message, as shares-check-dist.test.ts does for the shares.
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const EXT = resolve(__dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "sixkey-prf-check-dist-"));
const built = { prod: join(work, "prod"), e2e: join(work, "e2e"), dev: join(work, "dev") };
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
const popupEntry = (dir: string) =>
  readFileSync(join(dir, "popup/index.html"), "utf8").match(/<script[^>]*src="\.\.\/assets\/([^"]+\.js)"/)![1]!;
const noise = (entries: number, seed = 0) =>
  `var e={${Array.from({ length: entries }, (_, i) => `dv${i}:{message:\`${Array.from({ length: 40 }, (_, j) => String.fromCharCode(0x4e00 + ((seed * 104729 + i * 131 + j * 7919) % 20000))).join("")}\`}`).join(",")}};export{e as default};`;
const manifest = (dir: string, fn: (m: Record<string, unknown>) => void) =>
  edit(dir, "manifest.json", (t) => {
    const m = JSON.parse(t);
    fn(m);
    return JSON.stringify(m, null, 2);
  });
const otherKey = () =>
  generateKeyPairSync("rsa", { modulusLength: 2048 })
    .publicKey.export({ type: "spki", format: "der" })
    .toString("base64");

beforeAll(() => {
  build("prod");
  build("e2e");
  build("dev");
}, 300_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("check-dist and the device unlock's chunks", () => {
  it("the pristine builds pass, the device unlock's text counted against its own limit, the dev build with its ID", () => {
    for (const f of ["prod", "e2e", "dev"] as const) {
      const r = check(built[f], f);
      expect(r.ok, r.out).toBe(true);
      expect(r.out).toMatch(/device unlock text en: \d+ B gz \(limit 1600 B\)/);
      expect(r.out).toMatch(/device unlock text zh_CN: \d+ B gz \(limit 1600 B\)/);
      expect(r.out).toMatch(/a vault's page with every lazy catalog in \(zh_CN\): \d+ B gz \(limit 15360 B\)/);
    }
    expect(JSON.parse(readFileSync(join(built.dev, "manifest.json"), "utf8")).key).toBe(
      JSON.parse(readFileSync(join(EXT, "manifest.dev.json"), "utf8")).key,
    );
    for (const f of ["prod", "e2e"] as const)
      expect(JSON.parse(readFileSync(join(built[f], "manifest.json"), "utf8")).key, f).toBeUndefined();
  });

  const cases: [string, Flavour, (d: string) => void, RegExp][] = [
    [
      "the device unlock's text over its limit",
      "prod",
      (d) => writeFileSync(join(d, "assets", asset(d, /^device-locale-zh_CN-[\w-]+\.js$/)), noise(110)),
      /device unlock text zh_CN is \d+ B gz, over its limit of 1600 B/,
    ],
    [
      "a device text chunk missing",
      "e2e",
      (d) => unlinkSync(join(d, "assets", asset(d, /^device-locale-en-[\w-]+\.js$/))),
      /locale en: expected one device unlock text chunk assets\/device-locale-en-\*\.js, found 0/,
    ],
    [
      "a device text chunk that is not the generated file",
      "prod",
      (d) =>
        edit(d, `assets/${asset(d, /^device-locale-en-[\w-]+\.js$/)}`, (t) =>
          t.replace(/dvRowGate:\{message:`[^`]*`\}/, "dvRowGate:{message:`Stops everyone.`}"),
        ),
      /device-locale-en-[\w-]+\.js differs from catalogs\/device-en\.json/,
    ],
    [
      "a device key that is also a key of the full catalog",
      "prod",
      (d) =>
        edit(d, `assets/${asset(d, /^device-locale-en-[\w-]+\.js$/)}`, (t) =>
          t.replace("var e={", "var e={appName:{message:`x`},"),
        ),
      /device unlock text en: appName is also a key of the full catalog/,
    ],
    [
      "a vault's page with every lazy catalog in over 15 KB",
      "prod",
      (d) => {
        writeFileSync(join(d, "assets", asset(d, /^settings-locale-security-zh_CN-[\w-]+\.js$/)), noise(50, 1));
        writeFileSync(join(d, "assets", asset(d, /^settings-locale-accounts-zh_CN-[\w-]+\.js$/)), noise(30, 2));
        writeFileSync(join(d, "assets", asset(d, /^device-locale-zh_CN-[\w-]+\.js$/)), noise(40, 4));
      },
      /a vault's page with every lazy catalog in \(zh_CN\) is \d+ B gz, over the 15360 B it may hold/,
    ],
    [
      "two lock-screen chunks",
      "prod",
      (d) => writeFileSync(join(d, "assets/DeviceUnlock-AbC123.js"), "export{};"),
      /expected one device unlock chunk assets\/DeviceUnlock-\*\.js, found 2/,
    ],
    [
      "the lock screen's chunk imported statically by the popup's page",
      "prod",
      (d) => {
        const chunk = asset(d, /^DeviceUnlock-[\w-]+\.js$/);
        edit(d, `assets/${popupEntry(d)}`, (t) => `import "./${chunk}";\n${t}`);
      },
      /popup\/index\.html loads DeviceUnlock-[\w-]+\.js statically; it must load on first use/,
    ],
    [
      "the box reachable from the popup",
      "prod",
      (d) => {
        const box = asset(d, /^DeviceBox-[\w-]+\.js$/);
        edit(d, `assets/${popupEntry(d)}`, (t) => `${t}\n;void import("./${box}");`);
      },
      /popup\/index\.html can load the device box DeviceBox-[\w-]+\.js; it is the settings page's/,
    ],
    [
      "a WebAuthn call in the popup's static graph",
      "prod",
      (d) => edit(d, `assets/${popupEntry(d)}`, (t) => `${t}\n;navigator.credentials.get({});`),
      /popup\/index\.html calls WebAuthn from its static graph/,
    ],
    ["the dev build without its key", "dev", (d) => manifest(d, (m) => delete m.key), /manifest key missing: key/],
    [
      "the dev build with another key (another ID: a developer's passkeys would be stranded)",
      "dev",
      (d) => manifest(d, (m) => (m.key = otherKey())),
      /the dev build's manifest key gives the ID [a-p]{32}, not [a-p]{32}/,
    ],
    [
      "a key in the store build (its ID is the store's, OWNER-DECISIONS/11)",
      "prod",
      (d) => manifest(d, (m) => (m.key = otherKey())),
      /manifest key not allowed: key/,
    ],
    ["a key in the e2e build", "e2e", (d) => manifest(d, (m) => (m.key = otherKey())), /manifest key not allowed: key/],
  ];
  it.each(cases)("fails on %s", (_name, f, alter, message) => {
    const r = mutant(f, alter);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(message);
  });
});

describe("scripts/messages.py and the device unlock's catalog", () => {
  const top = mkdtempSync(join(tmpdir(), "sixkey-prf-messages-"));
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
  it("on this tree: writes catalogs/device-<lang>.json as the tree has them, and prints the page with every lazy catalog", () => {
    const r = run();
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toMatch(/device \d+ keys, \d+ of 1600 B/);
    expect(r.out).toMatch(/with the device unlock's too: \d+ of 15360 B/);
    for (const l of ["en", "zh_CN"])
      expect(readFileSync(join(r.dir, `catalogs/device-${l}.json`), "utf8")).toBe(
        readFileSync(join(EXT, `catalogs/device-${l}.json`), "utf8"),
      );
  });
  it.each([
    [
      "a device key that is a key of the full catalogs",
      'DEVICE_EN = {"appName": "x"}\nDEVICE_ZH = {"appName": "x"}\n',
      /device key 'appName' is also a key of another catalog/,
    ],
    [
      "a device key that is a shares key",
      'DEVICE_EN = {"shEntryAdd": "x"}\nDEVICE_ZH = {"shEntryAdd": "x"}\n',
      /device key 'shEntryAdd' is also a key of another catalog/,
    ],
    [
      "a device key added twice",
      'DEVICE_EN = {"dvUnlock": "x"}\nDEVICE_ZH = {"dvUnlock": "x"}\n',
      /device key 'dvUnlock' is also added by/,
    ],
    [
      "English and Chinese with different keys",
      'DEVICE_EN = {"dvZz": "x"}\nDEVICE_ZH = {}\n',
      /DEVICE_EN and DEVICE_ZH add different keys/,
    ],
  ])("refuses %s", (_name, body, message) => {
    const r = run(body);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(message);
  });
});
