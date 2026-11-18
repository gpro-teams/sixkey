// The test build (scripts/build.mjs --test, npm run build:test, dist-test/): the store build for testing by hand, on one
// computer or two, with its own name, a manifest key of its own (a fixed ID, so copies on two computers share their data
// in Chrome sync) and the install-source check off; nothing else of it may differ from the store build. On real builds
// in a temporary directory, as m5-check-dist.test.ts does: a test build passes check-dist --test and fails the prod
// check, the store build fails check-dist --test, --test with another kind of build is refused, the pinned ID is the
// key's, and the two builds' files are the same but for the manifest and what the install-source check's define changes.
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const EXT = resolve(__dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "sixkey-test-build-"));
const built = { prod: join(work, "prod"), test: join(work, "test") };
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_ENV"));
const run = (script: string, args: string[], cwd = EXT) => {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env, timeout: 240_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const check = (dir: string, args: string[] = []) => {
  const r = run("scripts/check-dist.mjs", [...args, "--dist", dir]);
  return { ok: r.status === 0, out: r.out };
};
let n = 0;
/** A copy of a build, changed by `alter`, then checked as `args` says. */
function mutant(from: string, args: string[], alter: (dir: string) => void) {
  const dir = join(work, `m${++n}`);
  cpSync(from, dir, { recursive: true });
  alter(dir);
  try {
    return check(dir, args);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const manifestOf = (dir: string) => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const setManifest = (dir: string, fn: (m: Record<string, unknown>) => void) => {
  const m = manifestOf(dir);
  fn(m);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
};
/** An extension's ID from its manifest key, as Chrome makes it: SHA-256 of the key's bytes, 32 hex digits as a to p. */
const idOfKey = (key: string) =>
  [...createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join("");
const checkDistText = readFileSync(join(EXT, "scripts/check-dist.mjs"), "utf8");
const pinned = (name: string) => new RegExp(`^const ${name} = "([a-p]{32})";$`, "m").exec(checkDistText)?.[1];
const TEST_ID = pinned("TEST_EXTENSION_ID");
const DEV_ID = pinned("DEV_EXTENSION_ID");
const STORE_ID = /^export const STORE_ID = "([a-p]{32})";$/m.exec(
  readFileSync(join(EXT, "scripts/store-id.mjs"), "utf8"),
)?.[1];
const overlay = JSON.parse(readFileSync(join(EXT, "manifest.test.json"), "utf8"));
/** Every file under a directory, as path -> bytes. */
function tree(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true }))
    if (f.isFile()) out.set(join(f.parentPath, f.name).slice(dir.length + 1), readFileSync(join(f.parentPath, f.name)));
  return out;
}

beforeAll(() => {
  for (const [f, dir] of Object.entries(built)) {
    const r = run("scripts/build.mjs", [...(f === "test" ? ["--test"] : []), "--out", dir]);
    if (r.status !== 0) throw new Error(`build ${f} failed:\n${r.out}`);
  }
}, 480_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("the test build's key and ID", () => {
  it("manifest.test.json holds the name and a public key alone, whose ID check-dist pins: neither the dev build's nor the store's", () => {
    expect(Object.keys(overlay).sort()).toEqual(["key", "name"]);
    expect(overlay.name).toBe("Sixkey (test)");
    // a public key (SPKI, DER), as manifest.dev.json's: never a private key
    expect(overlay.key).not.toMatch(/PRIVATE|-----/);
    const pub = createPublicKey({ key: Buffer.from(overlay.key, "base64"), format: "der", type: "spki" });
    expect(pub.type).toBe("public");
    expect(pub.asymmetricKeyType).toBe("rsa");
    expect(Buffer.from(overlay.key, "base64").toString("base64")).toBe(overlay.key); // plain base64, one line
    expect(TEST_ID).toBeDefined();
    expect(idOfKey(overlay.key)).toBe(TEST_ID);
    expect(DEV_ID).toBe("pgnlbjikdnniepfeijffpefifnojjege");
    expect(STORE_ID).toBeDefined();
    expect(TEST_ID).not.toBe(DEV_ID);
    expect(TEST_ID).not.toBe(STORE_ID);
  });
});

describe("check-dist --test", () => {
  it("a test build passes it, with its name, its key and no install-source check", () => {
    const r = check(built.test, ["--test"]);
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toContain("check-dist (test build) OK");
    const m = manifestOf(built.test);
    expect(m.name).toBe("Sixkey (test)");
    expect(m.key).toBe(overlay.key);
    expect(idOfKey(m.key)).toBe(TEST_ID);
  });

  it("the prod check refuses a test build: its key, its name and its missing install-source check, each on its own", () => {
    const r = check(built.test);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/check-dist \(prod\) FAILED/);
    expect(r.out).toMatch(/manifest key not allowed: key/);
    expect(r.out).toMatch(/the store build's manifest name is "Sixkey \(test\)"/);
    expect(r.out).toMatch(/install-source check \(chrome\.management\.getSelf\) is off or missing in this build/);
    // the key alone, on the store build: refused
    const keyed = mutant(built.prod, [], (d) => setManifest(d, (m) => void (m.key = overlay.key)));
    expect(keyed.ok).toBe(false);
    expect(keyed.out).toMatch(/manifest key not allowed: key/);
    // the name alone, on the store build: refused
    const named = mutant(built.prod, [], (d) => setManifest(d, (m) => void (m.name = "Sixkey (test)")));
    expect(named.ok).toBe(false);
    expect(named.out).toMatch(/the store build's manifest name is "Sixkey \(test\)"/);
  });

  it("refuses the store build, and a test build with another key or none", () => {
    const r = check(built.prod, ["--test"]);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/check-dist \(test build\) FAILED/);
    expect(r.out).toMatch(/manifest key missing: key/);
    expect(r.out).toMatch(/the test build's manifest name is "__MSG_appName__"/);
    expect(r.out).toMatch(/: the install-source check \(chrome\.management\.getSelf\) is on in the test build/);
    // another key: the dev build's, and one made here (its private half thrown away with it)
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .publicKey.export({ type: "spki", format: "der" })
      .toString("base64");
    const devKey = JSON.parse(readFileSync(join(EXT, "manifest.dev.json"), "utf8")).key;
    for (const [key, id] of [
      [devKey, DEV_ID],
      [other, idOfKey(other)],
    ]) {
      const k = mutant(built.test, ["--test"], (d) => setManifest(d, (m) => void (m.key = key)));
      expect(k.ok).toBe(false);
      expect(k.out).toContain(`the test build's manifest key gives the ID ${id}, not ${TEST_ID}`);
    }
    const none = mutant(built.test, ["--test"], (d) => setManifest(d, (m) => void delete m.key));
    expect(none.ok).toBe(false);
    expect(none.out).toMatch(/manifest key missing: key/);
  });
});

describe("--test with another kind of build", () => {
  it("is refused by the build, before anything is built", () => {
    for (const other of ["--dev", "--e2e", "--id-draft"]) {
      const out = join(work, `refused${other}`);
      const r = run("scripts/build.mjs", ["--test", other, "--out", out]);
      expect(r.status, other).toBe(2);
      expect(r.out, other).toMatch(
        /build: --test is the prod build for testing by hand; it takes neither --dev, --e2e nor --id-draft/,
      );
      expect(existsSync(out), other).toBe(false);
    }
  });
  it("is refused by check-dist", () => {
    for (const other of ["--dev", "--e2e", "--id-draft"]) {
      const r = check(built.test, ["--test", other]);
      expect(r.ok, other).toBe(false);
      expect(r.out, other).toMatch(
        /check-dist: --test is the prod build for testing by hand; it takes neither --dev, --e2e nor --id-draft/,
      );
    }
  });
  it("is refused by scripts/package.mjs, which never packages a test build, before anything is built", () => {
    // in a copy holding the scripts alone: whatever happened, nothing could be built or zipped there
    const dir = join(work, "package-copy");
    mkdirSync(dir);
    cpSync(join(EXT, "scripts"), join(dir, "scripts"), { recursive: true });
    cpSync(join(EXT, "package.json"), join(dir, "package.json"));
    const r = run("scripts/package.mjs", ["--test"], dir);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(
      /package: --test is the build for testing by hand .*it is never packaged\. No package written\./,
    );
    expect(readdirSync(dir).sort()).toEqual(["package.json", "scripts"]);
    // and the packages are made of dist/ and dist-id-draft/ alone
    const pack = readFileSync(join(EXT, "scripts/package.mjs"), "utf8");
    expect(pack).toContain('const dist = resolve(root, idDraft ? "dist-id-draft" : "dist");');
    expect(pack.match(/zipDirectory\(/g)).toEqual(["zipDirectory("]); // one call, of that directory
    expect(pack).toContain("zipDirectory(dist)");
    expect(pack).not.toMatch(/["'`]dist-test["'`/]/); // named in its comments and refusal, never as a path
  });
});

// A build's files with the content hashes taken out of their names (assets/<name>-<8 characters>.<ext>) and out of every
// file's references to them. One chunk's change renames it and so every file that names it, all the way up to the pages:
// byte equality of the two trees cannot hold, but equality of what is left once the hashes are gone can, and must. Some
// chunks share a name (assets/dist-#.js), so each name maps to the sorted list of its files' contents.
const HASHED = /^(assets\/.+)-[A-Za-z0-9_-]{8}(\.[a-z0-9]+)$/;
function unhashed(dir: string): Map<string, string[]> {
  const files = tree(dir);
  const names = new Map<string, string>(); // a hashed basename -> the same without its hash
  for (const k of files.keys()) {
    const m = HASHED.exec(k);
    if (m) names.set(k.slice("assets/".length), `${m[1]!.slice("assets/".length)}-#${m[2]}`);
  }
  const out = new Map<string, string[]>();
  for (const [k, v] of files) {
    let text = v.toString("latin1"); // byte for byte, whatever the file
    for (const [h, u] of names) text = text.split(h).join(u);
    const name = names.has(k.slice("assets/".length)) ? `assets/${names.get(k.slice("assets/".length))}` : k;
    (out.get(name) ?? out.set(name, []).get(name)!).push(text);
  }
  for (const v of out.values()) v.sort();
  return out;
}
/** A script's plain string literals (no `${…}`: the minifier renames what is inside one), with their counts. */
const literals = (code: string) => {
  const out = new Map<string, number>();
  for (const [x] of code.matchAll(/`[^`]*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g))
    if (!x.includes("${")) out.set(x.slice(1, -1), (out.get(x.slice(1, -1)) ?? 0) + 1);
  return out;
};

describe("the test build is the store build", () => {
  it("its manifest is the store build's but for its name and its key", () => {
    const { name: testName, key, ...test } = manifestOf(built.test);
    const { name: prodName, ...prod } = manifestOf(built.prod);
    expect([testName, prodName]).toEqual(["Sixkey (test)", "__MSG_appName__"]);
    expect(key).toBe(overlay.key);
    expect(JSON.stringify(test)).toBe(JSON.stringify(prod)); // every other key, in the same order
  });

  it("its files are the store build's, but for the manifest and the chunk the install-source check's define changes", () => {
    const prod = unhashed(built.prod);
    const test = unhashed(built.test);
    expect([...test.keys()].sort()).toEqual([...prod.keys()].sort());
    const differ = [...prod.keys()].filter((k) => JSON.stringify(prod.get(k)) !== JSON.stringify(test.get(k))).sort();
    // the chunk that holds src/platform/install-source.ts: the store build's calls getSelf, and it alone
    const checking = [...prod].filter(([k, v]) => k.endsWith(".js") && v.some((t) => t.includes("getSelf")));
    expect(checking.map(([k]) => k)).toHaveLength(1);
    const [chunk] = checking[0]!;
    expect(differ).toEqual(["manifest.json", chunk].sort());
    // that chunk, in the test build: the check's code compiled out (no getSelf, no record of its answer) and nothing
    // added. The minifier renames the chunk's variables, so its bytes differ throughout: its string literals are what
    // can be compared. The test build's are the store build's, less the install-source check's own (its two modules')
    // and nothing else, the store ID included (__STORE_ID__ is the store build's).
    const [p] = prod.get(chunk)!;
    const [t] = test.get(chunk)!;
    expect(prod.get(chunk)).toHaveLength(1);
    expect(t).not.toContain("getSelf");
    expect(t).not.toContain("sk_install");
    expect(t).toContain(STORE_ID!);
    expect(t!.length).toBeLessThan(p!.length);
    const own = new Set<string>();
    for (const f of ["src/platform/install-source.ts", "src/core/install-source.ts"])
      for (const [k] of literals(readFileSync(join(EXT, f), "utf8"))) own.add(k);
    const [lp, lt] = [literals(p!), literals(t!)];
    const gained = [...lt].filter(([k, c]) => c > (lp.get(k) ?? 0)).map(([k]) => k);
    const lost = [...lp].filter(([k, c]) => c > (lt.get(k) ?? 0)).map(([k]) => k);
    expect(gained).toEqual([]);
    expect(lost).toContain("sk_install");
    expect(lost.filter((k) => !own.has(k))).toEqual([]);
    // and no file of the test build calls getSelf
    expect([...test].filter(([, v]) => v.some((x) => x.includes("getSelf"))).map(([k]) => k)).toEqual([]);
  });
});
