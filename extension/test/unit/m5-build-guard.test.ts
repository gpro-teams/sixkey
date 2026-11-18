// scripts/build.mjs's graph guard (every flavour's; tried here on prod builds) and define, its pinned build mode and
// per-flavour directories, the store package and the ID draft (scripts/package.mjs), and a few check-dist rules (a
// catalog that names backups.transport among them), on real builds. The builds run in a private copy of the extension's
// sources (node_modules linked), with NODE_ENV removed as in a developer's shell (vitest sets NODE_ENV=test;
// scripts/build.mjs pins production mode either way, which one test checks with NODE_ENV=test on purpose).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
/** The version the package is named after (manifest.base.json, as scripts/package.mjs reads it). */
const VERSION = (JSON.parse(readFileSync(join(__dirname, "../../manifest.base.json"), "utf8")) as { version: string })
  .version;

const EXT = resolve(__dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "sixkey-build-guard-"));
// Every build copies the repository's licence text and its site rules into itself (scripts/build.mjs,
// ../LICENSES/MPL-2.0.txt; scripts/rules-package.mjs, ../rules, TOTP autofill Stage 3, AF3-3a): the copies below sit in
// work/, so work/LICENSES and work/rules stand for the repository's.
symlinkSync(resolve(EXT, "../LICENSES"), join(work, "LICENSES"));
symlinkSync(resolve(EXT, "../rules"), join(work, "rules"));
/**
 * A folder for copies of the extension beside a rules/ of their own: the repository's, with its bundle as `bundle`
 * makes it of the committed one (written as bundle.mjs writes it unless `bundle` gives the text itself; none for null).
 */
function besideRules(name: string, bundle: (b: Record<string, unknown>) => unknown): string {
  const top = join(work, name);
  mkdirSync(top);
  symlinkSync(resolve(EXT, "../LICENSES"), join(top, "LICENSES"));
  cpSync(resolve(EXT, "../rules"), join(top, "rules"), { recursive: true });
  const f = join(top, "rules/build/baseline.json");
  const b = JSON.parse(readFileSync(f, "utf8"));
  const out = bundle(b);
  if (out === null) rmSync(f);
  else writeFileSync(f, typeof out === "string" ? out : `${JSON.stringify(b, null, 2)}\n`);
  return top;
}
// The store package needs a bundle whose source is the repository's address (scripts/rules-package.mjs sourceGate): the
// copies made for it sit in published/, whose bundle names it as a release made once the address is set would (REPO, set
// in those copies' scripts/repo-url.mjs).
const REPO = "https://example.org/o/sixkey";
const published = besideRules("published", (b) => void (b.source = `${REPO}/tree/rules-v${b.version}/rules`));
// ...and the tree as it was before the repository was public: a bundle that names no source (the copy's REPO_URL set to
// "" with setRepo).
const unpublished = besideRules("unpublished", (b) => void (b.source = ""));
/** A copy's REPO_URL (scripts/repo-url.mjs), whatever the tree's is: "" for the tree before it was public. */
const setRepo = (dir: string, url: string) => {
  const f = join(dir, "scripts/repo-url.mjs");
  const text = readFileSync(f, "utf8");
  const line = /^export const REPO_URL = "[^"]*";$/m;
  expect(text).toMatch(line); // never a silent no-op
  writeFileSync(f, text.replace(line, `export const REPO_URL = ${JSON.stringify(url)};`));
};
const env = () => {
  const e = { ...process.env };
  delete e.NODE_ENV;
  return e;
};

function copyExt(name: string, top = work): string {
  const dir = join(top, name);
  // (catalogs/: the page catalogs scripts/messages.py generates, like _locales. The lockfile: the build writes the
  // third-party notices of the packages it lists, scripts/notices.mjs)
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
    cpSync(join(EXT, n), join(dir, n), { recursive: true });
  symlinkSync(join(EXT, "node_modules"), join(dir, "node_modules"));
  return dir;
}
const build = (dir: string, args: string[] = [], extra: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["scripts/build.mjs", ...args], {
    cwd: dir,
    env: { ...env(), ...extra },
    encoding: "utf8",
  });
/** Every file under a directory, as path -> bytes. */
function tree(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true }))
    if (f.isFile()) out.set(join(f.parentPath, f.name).slice(dir.length + 1), readFileSync(join(f.parentPath, f.name)));
  return out;
}
/** The entry names of a zip, from its central directory (no comment, no zip64: what scripts/package.mjs writes). */
function zipNames(z: Buffer): string[] {
  const end = z.length - 22;
  expect(z.readUInt32LE(end)).toBe(0x06054b50);
  const names: string[] = [];
  for (let at = z.readUInt32LE(end + 16), i = 0; i < z.readUInt16LE(end + 10); i++) {
    expect(z.readUInt32LE(at)).toBe(0x02014b50);
    const n = z.readUInt16LE(at + 28),
      x = z.readUInt16LE(at + 30),
      c = z.readUInt16LE(at + 32);
    names.push(z.subarray(at + 46, at + 46 + n).toString("utf8"));
    at += 46 + n + x + c;
  }
  return names;
}
const check = (dist: string, args: string[] = []) => {
  const r = spawnSync(process.execPath, ["scripts/check-dist.mjs", ...args, "--dist", dist], {
    cwd: EXT,
    env: env(),
    encoding: "utf8",
  });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
};

let clean = "";
beforeAll(() => {
  clean = copyExt("clean");
  const r = build(clean, ["--out", join(clean, "out")]);
  if (r.status !== 0) throw new Error(`prod build failed:\n${r.stdout}\n${r.stderr}`);
}, 240_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("scripts/build.mjs refuses a prod build whose module graph reaches the server sync's client or the developer page", () => {
  // [what, the file the import goes into, the import, a file the copy gets first (each is gone from the tree, DV-0b: as if
  // it came back from the history)]
  const use = (from: string, name: string) =>
    `import { ${name} as __p } from "${from}";\n(globalThis as Record<string, unknown>).__p = __p;\n`;
  const cases: [string, string, string, [string, string]?][] = [
    [
      "the enrolment (enroll.ts), in the worker",
      "src/background/sw.ts",
      use("../core/sync/engine/enroll", "firstUpload"),
      ["src/core/sync/engine/enroll.ts", "export const firstUpload = 1;\n"],
    ],
    [
      "any module of the engine, from a page",
      "src/options/main.tsx",
      use("../core/sync/local/keys", "SYNC_KEYS"),
      ["src/core/sync/local/keys.ts", "export const SYNC_KEYS = 1;\n"],
    ],
    [
      "the worker's sync",
      "src/background/sw.ts",
      use("../platform/sync-worker", "createWorkerSync"),
      ["src/platform/sync-worker.ts", "export const createWorkerSync = 1;\n"],
    ],
    [
      "the transport",
      "src/background/sw.ts",
      use("../platform/fetch-transport", "FetchTransport"),
      ["src/platform/fetch-transport.ts", "export const FetchTransport = 1;\n"],
    ],
    [
      "the service's sync flows, from the popup",
      "src/popup/main.tsx",
      use("../core/service/sync-flows", "SyncFlows"),
      ["src/core/service/sync-flows.ts", "export const SyncFlows = 1;\n"],
    ],
    [
      "the developer page, from a page",
      "src/options/main.tsx",
      'import "../devsync/main";\n',
      ["src/devsync/main.ts", "export {};\n"],
    ],
  ];
  for (const [what, file, inject, extra] of cases) {
    it(
      what,
      () => {
        const dir = copyExt(`inj-${what.replace(/\W+/g, "-")}`);
        if (extra) {
          mkdirSync(join(dir, extra[0], ".."), { recursive: true });
          writeFileSync(join(dir, extra[0]), extra[1]);
        }
        const p = join(dir, file);
        writeFileSync(p, inject + readFileSync(p, "utf8"));
        const r = build(dir, ["--out", join(dir, "out")]);
        expect(r.status, `${r.stdout}\n${r.stderr}`).not.toBe(0);
        expect(`${r.stdout}${r.stderr}`).toMatch(
          /no build may contain the Sync section, the developer sync page or the server sync's client/,
        );
      },
      120_000,
    );
  }
});

describe("scripts/build.mjs refuses a site rules' bundle the extension would not read, before building (AF3-3a)", () => {
  // each its own rules/ beside the copy: the committed bundle changed one way (or a file taken away, `top`)
  const cases: [string, (b: Record<string, unknown>) => unknown, RegExp, ((top: string) => void)?][] = [
    [
      "a bundle the extension's reader refuses (a live one)",
      (b) => void (b.kind = "live"),
      /build: rules\/build\/baseline\.json is not a baseline bundle the extension accepts: bundle\.kind/,
    ],
    [
      "a shared suffix among the hosts",
      (b) => void (b.appends as string[]).push("github.io"),
      /build: rules\/build\/baseline\.json is not a baseline bundle the extension accepts: bundle\.appends\[3\]/,
    ],
    [
      "a key written twice (the reader keeps the last one and cannot see it)",
      (b) => `${JSON.stringify(b, null, 2)}\n`.replace('"kind": "baseline",', '"kind": "live",\n  "kind": "baseline",'),
      /build: rules\/build\/baseline\.json is not in the form rules\/tools\/bundle\.mjs writes/,
    ],
    [
      "a bundle not written as bundle.mjs writes it",
      (b) => JSON.stringify(b),
      /build: rules\/build\/baseline\.json is not in the form rules\/tools\/bundle\.mjs writes/,
    ],
    [
      "an empty bundle",
      () => "",
      /build: rules\/build\/baseline\.json is not a baseline bundle the extension accepts: not JSON/,
    ],
    // what to do, not a bare ENOENT, and nothing half written (the review's NIT-6)
    [
      "no bundle at all",
      () => null,
      /build: rules\/build\/baseline\.json is missing: build Sixkey in the repository, where extension\/ sits beside rules\/, or make the bundle \(node rules\/tools\/bundle\.mjs\)/,
    ],
    [
      "no rules/NOTICE (the licence file's first part)",
      () => undefined,
      /build: rules\/NOTICE is missing: build Sixkey in the repository, where extension\/ sits beside rules\//,
      (top) => rmSync(join(top, "rules/NOTICE")),
    ],
  ];
  let n = 0;
  for (const [what, bundle, msg, after] of cases)
    it(
      what,
      () => {
        const top = besideRules(`refusing-${++n}`, bundle);
        after?.(top);
        const dir = copyExt("extension", top);
        const r = build(dir, ["--out", join(dir, "out")]);
        expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
        expect(r.stderr).toMatch(msg);
        expect(existsSync(join(dir, "out"))).toBe(false); // nothing built
      },
      60_000,
    );
});

describe("scripts/build.mjs refuses any file of the repository's rules/ in a module graph, naming who imports it (AF3-3a r2)", () => {
  // the bundle is data read from the package (src/platform/package-data.ts), never code: however a module imports a file
  // under rules/, in a page, the worker, the finder or the content script, the build fails at that graph
  const cases: [string, string, string, RegExp][] = [
    [
      "a page module, the bundle as a JSON module",
      "src/popup/main.tsx",
      'import __r from "../../../rules/build/baseline.json";\n(globalThis as Record<string, unknown>).__r = __r;\n',
      /rules\/build\/baseline\.json \(imported by src\/popup\/main\.tsx\)/,
    ],
    [
      "another page, its address (?url)",
      "src/options/main.tsx",
      'import __r from "../../../rules/build/baseline.json?url";\n(globalThis as Record<string, unknown>).__r = __r;\n',
      /rules\/build\/baseline\.json\?url \(imported by src\/options\/main\.tsx\)/,
    ],
    [
      "the worker, its text (?raw)",
      "src/background/sw.ts",
      'import __r from "../../../rules/build/baseline.json?raw";\n(globalThis as Record<string, unknown>).__r = __r;\n',
      /rules\/build\/baseline\.json\?raw \(imported by src\/background\/sw\.ts\)/,
    ],
    [
      "the worker, one field by name",
      "src/background/sw.ts",
      'import { aliases as __r } from "../../../rules/build/baseline.json";\n(globalThis as Record<string, unknown>).__r = __r;\n',
      /rules\/build\/baseline\.json \(imported by src\/background\/sw\.ts\)/,
    ],
    [
      "the finder, an upstream file",
      "src/inject/otp.ts",
      'import __r from "../../../rules/upstream/apple/shared-credentials.json";\n(globalThis as Record<string, unknown>).__r = __r;\n',
      /rules\/upstream\/apple\/shared-credentials\.json \(imported by src\/inject\/otp\.ts\)/,
    ],
    [
      "the content script, loaded later (import())",
      "src/inject/suggest.ts",
      'void import("../../../rules/build/baseline.json").then((m) => ((globalThis as Record<string, unknown>).__r = m));\n',
      /rules\/build\/baseline\.json \(imported by src\/inject\/suggest\.ts\)/,
    ],
  ];
  let n = 0;
  for (const [what, file, inject, msg] of cases)
    it(
      what,
      () => {
        const dir = copyExt(`rules-import-${++n}`);
        const p = join(dir, file);
        writeFileSync(p, inject + readFileSync(p, "utf8"));
        const r = build(dir, ["--out", join(dir, "out")]);
        expect(r.status, `${r.stdout}\n${r.stderr}`).not.toBe(0);
        const out = `${r.stdout}${r.stderr}`;
        expect(out).toMatch(
          /the site rules' data in the build \(it is read from the package, never imported\): rules\//,
        );
        expect(out).toMatch(msg);
      },
      120_000,
    );
});

describe("a file of rules/ by address (new URL(…, import.meta.url)), which reaches no module graph (AF3-3a r3)", () => {
  const line =
    '(globalThis as Record<string, unknown>).__u = new URL("../../../rules/build/baseline.json", import.meta.url).href;\n';
  it("in a page: the page build would copy it into assets/, and the build fails, naming it", () => {
    const dir = copyExt("rules-url-page");
    const p = join(dir, "src/popup/main.tsx");
    writeFileSync(p, line + readFileSync(p, "utf8"));
    const r = build(dir, ["--out", join(dir, "out")]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(
      /the site rules' data in the build \(it is read from the package, never emitted as an asset\): rules\/build\/baseline\.json \(as assets\/baseline-[\w-]+\.json\)/,
    );
  }, 120_000);
  it("in the worker: a library build writes it into the script as a data: URL, which check-dist refuses", () => {
    const dir = copyExt("rules-url-worker");
    const p = join(dir, "src/background/sw.ts");
    writeFileSync(p, line + readFileSync(p, "utf8"));
    const r = build(dir, ["--out", join(dir, "out")]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(readFileSync(join(dir, "out/sw.js"), "utf8")).toMatch(/data:application\/json;base64,/);
    const c = check(join(dir, "out"));
    expect(c.ok).toBe(false);
    expect(c.out).toMatch(/sw\.js: a JSON data: URL in a script/);
  }, 120_000);
});

describe("the prod build's own contents", () => {
  it("the worker carries no developer page path (the sender policy's page list holds the settings page, not that one)", () => {
    const sw = readFileSync(join(clean, "out/sw.js"), "utf8");
    expect(sw).not.toMatch(/devsync/);
    expect(sw).toContain('"/options/index.html"');
    // and no script of the build names it (the sender policy is also in the offscreen document's script)
    const scripts = [
      "sw.js",
      "theme-boot.js",
      ...readdirSync(join(clean, "out/assets")).map((n) => `assets/${n}`),
    ].filter((n) => n.endsWith(".js"));
    expect(scripts.length).toBeGreaterThan(5);
    expect(scripts.filter((n) => /devsync/.test(readFileSync(join(clean, "out", n), "utf8")))).toEqual([]);
  });
});

describe("check-dist: the developer origin and the URL template", () => {
  const popupChunk = (d: string) =>
    `assets/${readdirSync(join(d, "assets")).find((x) => /^popup-(?!locale)[\w-]+\.js$/.test(x))!}`;
  let n = 0;
  const mutant = (alter: (d: string) => void) => {
    const d = join(work, `m${++n}`);
    cpSync(join(clean, "out"), d, { recursive: true });
    alter(d);
    return check(d);
  };
  const edit = (d: string, f: string, fn: (t: string) => string) =>
    writeFileSync(join(d, f), fn(readFileSync(join(d, f), "utf8")));

  it("the pristine copy passes", () => {
    expect(check(join(clean, "out")).ok).toBe(true);
  });
  it("'localhost' anywhere in a prod build fails", () => {
    const r = mutant((d) => edit(d, popupChunk(d), (t) => `${t}\nconst o="ws://localhost:8787";`));
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/dev marker in a prod build: localhost/);
  });
  it("a store build named as an ID draft fails, and the ID draft's check fails a store build (review N-1)", () => {
    const r = mutant((d) =>
      edit(d, "manifest.json", (t) => t.replace('"__MSG_appName__"', '"Sixkey (ID draft, do not publish)"')),
    );
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/the store build's manifest name is "Sixkey \(ID draft, do not publish\)"/);
    const asDraft = check(join(clean, "out"), ["--id-draft"]);
    expect(asDraft.ok).toBe(false);
    expect(asDraft.out).toMatch(/the ID draft's manifest name is "__MSG_appName__"/);
    // its name alone (and no externally_connectable, as no build has)
    expect(asDraft.out).not.toMatch(/externally_connectable/);
  });
  it("only the exact http://${host}/ template is allowed, not a template with a path or over https", () => {
    for (const u of ["`http://${h}/collect?d=${x}`", "`https://${h}/`"]) {
      const r = mutant((d) => edit(d, popupChunk(d), (t) => `${t}\nconst u=${u};`));
      expect(r.ok, u).toBe(false);
      expect(r.out, u).toMatch(/URL in shipped code that is not one it may hold/);
    }
  });
});

describe("the build's mode and directories", () => {
  it("NODE_ENV=test in the environment changes nothing: the prod build is byte for byte the same", () => {
    const out = join(clean, "out-node-env-test");
    const r = build(clean, ["--out", out], { NODE_ENV: "test" });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const a = tree(join(clean, "out")),
      b = tree(out);
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const [k, v] of a) expect(b.get(k)!.equals(v), k).toBe(true);
  }, 120_000);

  it("a dev build goes to dist-dev/, never to dist/ (where the package is made from)", () => {
    const dir = copyExt("dev-dir");
    const r = build(dir, ["--dev"]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(existsSync(join(dir, "dist-dev/manifest.json"))).toBe(true);
    expect(existsSync(join(dir, "dist"))).toBe(false);
  }, 120_000);
});

describe("scripts/package.mjs (npm run package)", () => {
  const pack = (dir: string, args: string[] = []) =>
    spawnSync(process.execPath, ["scripts/package.mjs", ...args], { cwd: dir, env: env(), encoding: "utf8" });
  /** A store ID for copies whose own STORE_ID must not be the tree's: an extension ID, not the developer build's. */
  const SIXKEY_STORE = "abcdefghijklmnopabcdefghijklmnop";
  /** A copy's STORE_ID (scripts/store-id.mjs), whatever the tree's is: "" for the tree before the ID was pinned. */
  const setStoreId = (dir: string, id: string) =>
    writeFileSync(join(dir, "scripts/store-id.mjs"), `export const STORE_ID = ${JSON.stringify(id)};\n`);
  /** The tree's STORE_ID, as the store assigned it (the first uploads' step 2): an extension ID. */
  const TREE_STORE_ID = /^export const STORE_ID = "([a-p]{32})";$/m.exec(
    readFileSync(join(EXT, "scripts/store-id.mjs"), "utf8"),
  )?.[1];
  /** Sixkey's STORE_ID pinned (step 2) and the repository's address set (step 3): what the store package needs. */
  function pinned(name: string): string {
    const dir = copyExt(name, published);
    setStoreId(dir, SIXKEY_STORE);
    setRepo(dir, REPO);
    return dir;
  }
  /** Refused before anything is built: nothing in dist/ or release/. */
  const refusedEarly = (dir: string, r: ReturnType<typeof pack>) => {
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/No package written/);
    expect(existsSync(join(dir, "dist"))).toBe(false);
    expect(existsSync(join(dir, "release"))).toBe(false);
  };
  it("refuses a store package while Sixkey's own STORE_ID is empty, before building", () => {
    const dir = copyExt("package-no-store-id", published); // the repository's address set, step 2 not done
    setRepo(dir, REPO);
    setStoreId(dir, ""); // as the tree was before the ID was pinned
    const r = pack(dir, []);
    refusedEarly(dir, r);
    expect(r.stderr).toMatch(/Sixkey's store ID \(STORE_ID in scripts\/store-id\.mjs\) is empty/);
    expect(r.stderr).toMatch(/install-source check/);
    expect(r.stderr).toMatch(/--id-draft/);
    expect(r.stderr).toMatch(/README\.md, "Publishing", steps 1 and 2/); // the release steps that set it
    expect(r.stderr).not.toMatch(/the site rules' bundle names no source/);
    // no reason of the Google Drive backup's official plugin any more
    expect(r.stderr).not.toMatch(/local-development identity|cloud plugin/);
    // two kinds at once: refused too
    expect(pack(dir, ["--local-only", "--id-draft"]).status).not.toBe(0);
  });
  it("refuses a store package when STORE_ID is the developer build's ID, or not an extension ID (N2-1)", () => {
    const dir = copyExt("package-dev-store-id");
    setStoreId(dir, "pgnlbjikdnniepfeijffpefifnojjege"); // manifest.dev.json's key's: the SDK's SIXKEY_DEV_ID
    const r = pack(dir, []);
    refusedEarly(dir, r);
    expect(r.stderr).toMatch(/STORE_ID is the developer build's ID \(pgnlbjikdnniepfeijffpefifnojjege\)/);
    setStoreId(dir, "not-an-id");
    const bad = pack(dir, []);
    refusedEarly(dir, bad);
    expect(bad.stderr).toMatch(/STORE_ID in scripts\/store-id\.mjs is not an extension ID/);
  });
  it("the tree as it was before step 2: the empty STORE_ID's reason alone; the committed bundle names REPO_URL's source", () => {
    const dir = copyExt("package-neither");
    setStoreId(dir, "");
    const r = pack(dir, []);
    refusedEarly(dir, r);
    expect(r.stderr).toMatch(/STORE_ID in scripts\/store-id\.mjs\) is empty/);
    expect(r.stderr).not.toMatch(/the site rules' bundle names no source|baseline\.json's source is/); // AF3-3a
    expect(r.stderr.match(/^package: /gm)).toHaveLength(1);
    // as it was before the repository was public: both reasons, in the steps' order, in one refusal, and no other
    const before = copyExt("package-neither-before", unpublished);
    setRepo(before, "");
    setStoreId(before, "");
    const both = pack(before, []);
    refusedEarly(before, both);
    const first = both.stderr.indexOf("STORE_ID in scripts/store-id.mjs) is empty");
    const second = both.stderr.indexOf("the site rules' bundle names no source");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(both.stderr.match(/^package: /gm)).toHaveLength(2);
  });
  it("refuses a store package while the site rules' bundle names no source, or not the one REPO_URL gives (AF3-3a)", () => {
    const dir = copyExt("package-no-repo", unpublished);
    setRepo(dir, ""); // the repository's address not set
    setStoreId(dir, SIXKEY_STORE); // step 2 done
    const r = pack(dir, []);
    refusedEarly(dir, r);
    expect(r.stderr).toMatch(/the site rules' bundle names no source: REPO_URL in scripts\/repo-url\.mjs is empty/);
    expect(r.stderr).toMatch(/"Releasing a bundle"/);
    expect(r.stderr).not.toMatch(/STORE_ID/);
    // the address set, the bundle not rebuilt since: its source is still empty
    setRepo(dir, REPO);
    const unbuilt = pack(dir, []);
    refusedEarly(dir, unbuilt);
    expect(unbuilt.stderr).toMatch(
      /rules\/build\/baseline\.json's source is "", not https:\/\/example\.org\/o\/sixkey\/tree\/rules-v1\/rules: rebuild it/,
    );
    // an address the bundle's source cannot be made of: a reason like the others, not an exception (the review's NIT-4)
    const wrong = copyExt("package-bad-repo");
    setStoreId(wrong, SIXKEY_STORE);
    setRepo(wrong, "git@example.org:o/sixkey.git");
    const bad = pack(wrong, []);
    refusedEarly(wrong, bad);
    expect(bad.stderr).toMatch(/package: repo-url\.mjs: RULES_SOURCE must be an https address with \{version\} in it/);
    expect(bad.stderr).not.toMatch(/\n\s+at /); // no stack
    // a bundle built for another address
    const other = copyExt("package-other-repo", published);
    setStoreId(other, SIXKEY_STORE);
    setRepo(other, "https://example.org/someone-else/sixkey");
    const stale = pack(other, []);
    refusedEarly(other, stale);
    expect(stale.stderr).toMatch(
      /rules\/build\/baseline\.json's source is "https:\/\/example\.org\/o\/sixkey\/tree\/rules-v1\/rules", not https:\/\/example\.org\/someone-else\/sixkey\/tree\/rules-v1\/rules/,
    );
  });
  it("--local-only builds and checks dist/ for loading unpacked, and writes no zip: nothing to upload (N-1)", () => {
    const dir = copyExt("package-local");
    const r = pack(dir, ["--local-only"]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("check-dist (prod) OK");
    expect(r.stdout).toMatch(/No zip is written/);
    expect(existsSync(join(dir, "dist/manifest.json"))).toBe(true);
    expect(existsSync(join(dir, "release"))).toBe(false);
  }, 240_000);
  it("--id-draft: Sixkey's first upload, named not to publish; refused once STORE_ID is set", () => {
    const dir = copyExt("package-draft");
    setStoreId(dir, ""); // the tree before step 2
    const r = pack(dir, ["--id-draft"]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("check-dist (ID draft) OK");
    expect(readdirSync(join(dir, "release"))).toEqual([`sixkey-${VERSION}-id-draft-do-not-publish.zip`]);
    expect(r.stdout).toMatch(/never submit it for review/);
    const m = JSON.parse(readFileSync(join(dir, "dist-id-draft/manifest.json"), "utf8"));
    expect(m.name).toBe("Sixkey (ID draft, do not publish)");
    expect(m).not.toHaveProperty("key");
    // no other extension can message it: no build has externally_connectable, nor a listener
    expect(m).not.toHaveProperty("externally_connectable");
    expect(zipNames(readFileSync(join(dir, `release/sixkey-${VERSION}-id-draft-do-not-publish.zip`)))).toEqual(
      [...tree(join(dir, "dist-id-draft")).keys()].map((k) => k.split("\\").join("/")).sort(),
    );
    expect(existsSync(join(dir, "dist"))).toBe(false); // never where the store package is made from
    // Sixkey's store ID known, as in the tree today: the draft is done, and refused before anything is built
    cpSync(join(EXT, "scripts/store-id.mjs"), join(dir, "scripts/store-id.mjs"));
    rmSync(join(dir, "dist-id-draft"), { recursive: true, force: true });
    const again = pack(dir, ["--id-draft"]);
    expect(again.status).not.toBe(0);
    expect(again.stderr).toMatch(
      new RegExp(`store ID is set already \\(STORE_ID in scripts/store-id\\.mjs, ${TREE_STORE_ID}\\)`),
    );
    expect(existsSync(join(dir, "dist-id-draft"))).toBe(false);
    // and so is any other ID
    setStoreId(dir, "ponmlkjihgfedcbaponmlkjihgfedcba");
    expect(pack(dir, ["--id-draft"]).stderr).toMatch(/store ID is set already/);
    expect(existsSync(join(dir, "dist-id-draft"))).toBe(false);
  }, 240_000);
  it("the tree as it is today, STORE_ID pinned and the rules' source set: builds prod, checks it, carries the ID, and zips exactly dist/; the same sources give the same bytes", () => {
    expect(TREE_STORE_ID).toBeDefined();
    const dir = copyExt("package");
    const zip = join(dir, `release/sixkey-${VERSION}.zip`);
    const shas: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = pack(dir);
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(r.stdout).toContain("check-dist (prod) OK");
      shas.push(createHash("sha256").update(readFileSync(zip)).digest("hex"));
    }
    expect(shas[1]).toBe(shas[0]);
    const files = tree(join(dir, "dist"));
    expect(zipNames(readFileSync(zip))).toEqual([...files.keys()].map((k) => k.split("\\").join("/")).sort());
    // the prod build carries the pinned ID for its install-source check, and no manifest key (the item has its own)
    const js = [...files].filter(([k]) => k.endsWith(".js"));
    expect(js.filter(([, v]) => v.includes(TREE_STORE_ID!)).length).toBeGreaterThan(0);
    expect(JSON.parse(files.get("manifest.json")!.toString("utf8"))).not.toHaveProperty("key");
  }, 240_000);

  it("a build that check-dist fails is never packaged", () => {
    const dir = pinned("package-refused");
    const p = join(dir, "src/popup/main.tsx");
    writeFileSync(
      p,
      '(globalThis as Record<string, unknown>).__u = "https://evil.example/collect";\n' + readFileSync(p, "utf8"),
    );
    const r = pack(dir);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(
      /URL in shipped code that is not one it may hold: https:\/\/evil\.example\/collect/,
    );
    expect(`${r.stdout}${r.stderr}`).toMatch(/no package written/);
    expect(existsSync(join(dir, "release"))).toBe(false);
  }, 120_000);
});
