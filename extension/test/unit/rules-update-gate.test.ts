// The site rules' updater's release gate (scripts/rules-update.mjs; TOTP autofill Stage 3, AF3-U1; docs/design/notes/
// AUTOFILL3-NOTES.md §9), the keys a build pins (scripts/rules-keys.mjs) and the graph guard (scripts/rules-guard.mjs;
// the plan's S7):
//   - the gate, pinned closed for the store build and open for dev and e2e, with one source; the updater's code reached
//     from the worker alone, through the gate's branch (AF3-U2), and the build's values for it with the gate open only;
//   - the keys: none in the store list, the test keys in dev and e2e; the store list held to the last release's
//     (test/fixtures/rules-keys/released.json), moving forward one step at a time; a build with the gate open refuses
//     without a rules origin and exactly two good keys, and a store build with a test key (updaterProblems);
//   - the guard: its hooks one by one, then real bundles: with the gate closed an import of the updater's modules from the
//     extension's own code resolves to an empty module (the worker's kind of entry and a lazy chunk's, as the Fill chunk
//     and the settings page load theirs), and an import the guard does not take (a file outside src/, an absolute path)
//     fails the build; with the gate open the module is there.
import { generateKeyPairSync, createHash } from "node:crypto";
import {
  existsSync,
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
import { build, type PluginOption } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import {
  RULES_ORIGINS,
  RULES_UPDATE_IN_STORE_BUILD,
  rulesUpdateIn,
  storeOrigin,
  testRulesHosts,
  updaterProblems,
} from "../../scripts/rules-update.mjs";
import {
  keyOrderProblem,
  pointOf,
  rulesKeysOf,
  sameKey,
  STORE_RULES_KEYS,
  TEST_RULES_KEYS,
} from "../../scripts/rules-keys.mjs";
import { gated, GATED_IN_SRC, RULES_UPDATE_OFF, rulesGuard } from "../../scripts/rules-guard.mjs";

const EXT = resolve(import.meta.dirname, "../..");
function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(n)) out.push(p);
  }
  return out;
}
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
const sources = [...files(join(EXT, "src")), ...files(join(EXT, "scripts"))].map((f) => ({
  path: f
    .slice(EXT.length + 1)
    .split("\\")
    .join("/"),
  text: code(readFileSync(f, "utf8")),
}));
// build.mjs without its line comments (block comments are left alone: its strings hold the host pattern of https sites,
// whose "/" and "*" a block comment reader would take for one)
const buildMjs = readFileSync(join(EXT, "scripts/build.mjs"), "utf8")
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("//"))
  .join("\n");

/** A P-256 key of the test's own, as rules-keys.mjs lists a key. */
const fresh = () => {
  const der = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "der" });
  return { kid: createHash("sha256").update(der).digest("hex").slice(0, 32), spki: der.toString("base64") };
};
/** The same key with its SPKI in the compressed form (59 bytes), and that form's kid. */
const compressedEntry = (spki: string) => {
  const der = Buffer.from(spki, "base64");
  const y = der.subarray(59, 91);
  const c = Buffer.concat([
    Buffer.from("3039301306072a8648ce3d020106082a8648ce3d030107032200", "hex"),
    Buffer.from([y[31]! & 1 ? 3 : 2]),
    der.subarray(27, 59),
  ]);
  return { kid: createHash("sha256").update(c).digest("hex").slice(0, 32), spki: c.toString("base64") };
};

describe("the site rules' updater's release gate", () => {
  it("is closed for the store build; dev and e2e builds always carry the updater", () => {
    expect(RULES_UPDATE_IN_STORE_BUILD).toBe(false); // the flip: true, in the change that ships it (AF3-U3)
    expect(rulesUpdateIn("prod")).toBe(RULES_UPDATE_IN_STORE_BUILD);
    expect(rulesUpdateIn("dev")).toBe(true);
    expect(rulesUpdateIn("e2e")).toBe(true);
    // the store build's origin is not set yet; dev and e2e read a fixture host, a reserved name
    expect(RULES_ORIGINS).toEqual({ prod: "", dev: "https://rules.fix.test", e2e: "https://rules.fix.test" });
  });
  it("has one source: scripts/rules-update.mjs, read by the build and check-dist; nothing from the environment", () => {
    const importers = sources
      .filter((f) => /(?:from|import)\s*\(?\s*["'][^"']*rules-update\.mjs["']/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(importers).toEqual(["scripts/build.mjs", "scripts/check-dist.mjs"]);
    const b = buildMjs;
    expect(b).toMatch(/const rulesUpdate = rulesUpdateIn\(flavour\);/);
    expect(b).not.toMatch(/process\.env\.[A-Z_]*RULES/);
    expect(code(readFileSync(join(EXT, "scripts/check-dist.mjs"), "utf8"))).toMatch(
      /const RULES_UPDATE = rulesUpdateIn\(flavour\);/,
    );
  });
  it("every pass of the build has the guard, and a build with the gate open checks its keys before anything is built", () => {
    const b = buildMjs;
    expect([...b.matchAll(/rulesGuard\(rulesUpdate, RULES_SRC\)/g)]).toHaveLength(4);
    expect(b).toMatch(/\nconst RULES_SRC = resolve\(root, "src"\);\n/); // the extension's own src/ (the review's N8)
    for (const pass of b.split("await build({").slice(1))
      expect(pass.slice(0, pass.indexOf("build: {")), pass.slice(0, 200)).toContain(
        "rulesGuard(rulesUpdate, RULES_SRC)",
      );
    const check = b.indexOf("const problems = await updaterProblems(flavour);");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(b.indexOf("await build({"));
    expect(b.slice(check, check + 300)).toMatch(/if \(problems\.length\) \{[\s\S]*process\.exit\(1\);/);
  });
  it("the updater's code is reached from the worker alone, through the gate's own branch, and only its modules name its marks (AF3-U2)", () => {
    const importersOf = (re: RegExp) =>
      sources
        .filter((f) => f.path.startsWith("src/"))
        .filter((f) => [...f.text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].some((m) => re.test(m[1]!)))
        .map((f) => f.path)
        .sort();
    // the worker imports the updater (by import(), which the bundler puts in the one file), in the gate's branch; the
    // updater alone imports the signed manifest's checks and the read; no page imports any of the three
    expect(importersOf(/(?:^|\/)rules-live(?:\.ts)?$/)).toEqual(["src/background/sw.ts"]);
    expect(importersOf(/(?:^|\/)rules-fetch(?:\.ts)?$/)).toEqual(["src/platform/rules-live.ts"]);
    expect(importersOf(/\/rules\/signed(?:\.ts)?$|^\.\/signed(?:\.ts)?$/)).toEqual(["src/platform/rules-live.ts"]);
    const sw = sources.find((f) => f.path === "src/background/sw.ts")!.text;
    expect(sw).not.toMatch(/^import [^;]*rules-live/m); // never a static import (the guard's empty module has no names)
    expect(sw.match(/import\("\.\.\/platform\/rules-live"\)/g)).toHaveLength(1);
    // reached only through the define, used where it stands (the alarm's check, the listener's registration, the test
    // builds' hook): the import's arrow and the listener are dead code without it, which the build removes
    const gate = 'typeof __RULES_UPDATE__ === "boolean" && __RULES_UPDATE__';
    expect(sw.split(gate)).toHaveLength(4);
    expect(sw).toMatch(new RegExp(`if \\(${gate} && alarm\\.name === ALARM_DAILY\\)\\s*void rulesUpdater\\(\\)`));
    expect(sw).toMatch(
      /^if \(typeof __RULES_UPDATE__ === "boolean" && __RULES_UPDATE__\) chrome\.runtime\.onMessage\.addListener\(rulesListener\);$/m,
    );
    expect(sw.match(/rulesListener\b/g)).toHaveLength(2); // its definition and that one registration
    expect(sw.match(/rulesUpdater\(\)/g)).toHaveLength(3); // the alarm's, the listener's, the hook's
    // the marks: the manifest's format in signed.ts; the database, its switch's key, one open of it in rules-live.ts
    // (N14: the one module that opens it); no source names a rules origin (the build's define carries it)
    const named = (re: RegExp) =>
      sources.filter((f) => f.path.startsWith("src/") && re.test(f.text)).map((f) => f.path);
    expect(named(/sixkey-rules-manifest/)).toEqual(["src/core/rules/signed.ts"]);
    expect(named(/sixkey-rules-live/)).toEqual(["src/platform/rules-live.ts"]);
    expect(named(/sk_rules_switch/)).toEqual(["src/platform/rules-live.ts"]);
    expect(named(/rules\.fix\.test|rules\.sixkey\.app/)).toEqual([]);
    expect(named(/\.open\(DATABASE/)).toEqual(["src/platform/rules-live.ts"]);
    expect(named(/node:crypto|rules-keys(?:\.mjs)?["']/)).toEqual([]); // the keys come through the build's define
  });
  it("the build carries the keys, the origin and the built-in version into the code only with the gate open (AF3-U2)", () => {
    const b = buildMjs;
    expect(b).toMatch(/__RULES_UPDATE__: JSON\.stringify\(rulesUpdate\),/);
    expect(b).toMatch(/__SK_RULES_ORIGIN__: JSON\.stringify\(rulesUpdate \? RULES_ORIGINS\[flavour\] : ""\),/);
    expect(b).toMatch(/__SK_RULES_KEYS__: JSON\.stringify\(rulesUpdate \? rulesKeysOf\(flavour\) : \[\]\),/);
    // the version of the bundle this build carries, read from the very text the build checked and writes
    expect(b).toMatch(
      /__SK_RULES_BASELINE__: JSON\.stringify\(rulesUpdate \? JSON\.parse\(baseline\.text\)\.version : 0\),/,
    );
    expect(b).toMatch(/writeFileSync\(resolve\(dist, PACKAGED_BASELINE\), baseline\.text\);/);
    // and the CSP gains the rules origin's one path, with the gate open only
    expect(b).toMatch(
      /if \(rulesUpdate\)\s*manifest\.content_security_policy = \{\s*\.\.\.manifest\.content_security_policy,\s*extension_pages: cspOf\(cspOrigin, \[rulesPathOf\(RULES_ORIGINS\[flavour\]\)\]\),/,
    );
  });
});

describe("the pinned keys", () => {
  const released = JSON.parse(readFileSync(join(EXT, "test/fixtures/rules-keys/released.json"), "utf8"));
  it("the store build pins none yet; dev and e2e pin the two test keys", () => {
    expect(STORE_RULES_KEYS).toEqual([]);
    expect(rulesKeysOf("prod")).toBe(STORE_RULES_KEYS);
    expect(rulesKeysOf("dev")).toBe(TEST_RULES_KEYS);
    expect(rulesKeysOf("e2e")).toBe(TEST_RULES_KEYS);
    expect(TEST_RULES_KEYS).toHaveLength(2);
  });
  it("the store list follows the last release's (released.json) by the rule: it moves forward only at a release", () => {
    expect(Object.keys(released).sort()).toEqual(["ever", "note", "store"]);
    // every key a release pinned is in `ever`, the last release's among them (the review's S3)
    for (const k of released.store)
      expect(
        released.ever.some((e: unknown) => sameKey(e, k)),
        k.kid,
      ).toBe(true);
    expect(keyOrderProblem(released.store, STORE_RULES_KEYS, released.ever)).toBeNull();
  });
  it("the rule: the same list; a first list; one step forward; two new keys. Nothing else", () => {
    const key = (x: string) => ({ kid: x.repeat(32), spki: `spki-${x}` });
    const [A, B, C, D] = [key("a"), key("b"), key("c"), key("d")];
    const ok = (p: unknown[], n: unknown[]) => expect(keyOrderProblem(p, n), JSON.stringify(n)).toBeNull();
    const no = (p: unknown[], n: unknown[], why: RegExp) =>
      expect(keyOrderProblem(p, n), JSON.stringify(n)).toMatch(why);
    ok([], []);
    ok([], [A, B]);
    ok([A, B], [A, B]);
    ok([A, B], [B, C]); // a planned change, or `current` lost or stolen
    ok([A, B], [C, D]); // `next` lost or stolen, or both
    no([A, B], [A, C], /the first key must be the previous list's second \(b{32}\), not a{32}, or both keys new/);
    no([A, B], [C, A], /the first key must be the previous list's second/);
    no([A, B], [B, A], /the second key must be new: a{32} was in the previous list/);
    no([A, B], [B, B], /the same key twice: b{32}/);
    no([], [A, A], /the same key twice: a{32}/); // even for a first list, or two "new" keys
    no([A, B], [C, C], /the same key twice: c{32}/);
    no([A, B], [B], /two keys, not 1/);
    no([A, B], [], /two keys, not 0/);
    no([A, B], [B, C, D], /two keys, not 3/);
    no([A, B], [{ ...B, spki: "other" }, C], /the first key must be the previous list's second/);
    no([A, B], [B, { ...C, kid: A.kid }], /the second key must be new/);
    no([A, B], [B, { ...C, spki: A.spki }], /the second key must be new/);
    no("x" as unknown as unknown[], [A, B], /not a list/);
  });
  it("`ever`: a key an earlier release pinned and a later one dropped never comes back (the review's S3)", () => {
    const key = (x: string) => ({ kid: x.repeat(32), spki: `spki-${x}` });
    const [A, B, C, D] = [key("a"), key("b"), key("c"), key("d")];
    const ever = [A, B, C];
    // R pinned [A, B]; R+1 [B, C]; now from [B, C]:
    expect(keyOrderProblem([B, C], [C, D], ever)).toBeNull();
    expect(keyOrderProblem([B, C], [B, C], ever)).toBeNull();
    for (const next of [
      [C, A],
      [A, D],
      [D, A],
    ])
      expect(keyOrderProblem([B, C], next, ever), JSON.stringify(next)).toMatch(
        /^a{32} was pinned by an earlier release and dropped since: a key never comes back/,
      );
    // without `ever` the same move would pass: it is what holds the history
    expect(keyOrderProblem([B, C], [C, A])).toBeNull();
    expect(keyOrderProblem([B, C], [C, A], "x")).toMatch(/not a list/);
  });
  it("keys are compared as keys: the compressed spelling of a test key is that key (the review's S2)", () => {
    const [T0, T1] = TEST_RULES_KEYS as [{ kid: string; spki: string }, { kid: string; spki: string }];
    const c = compressedEntry(T0.spki);
    expect(c.spki).not.toBe(T0.spki);
    expect(c.kid).not.toBe(T0.kid);
    expect(pointOf(c)).toBe(pointOf(T0));
    expect(pointOf(T0)).toHaveLength(128);
    expect(sameKey(c, T0)).toBe(true);
    expect(sameKey(T1, T0)).toBe(false);
    expect(pointOf({ spki: "not a key" })).toBeNull();
    const N = fresh();
    expect(keyOrderProblem([T0, T1], [c, N])).toMatch(/the first key must be the previous list's second/);
    expect(keyOrderProblem([T0, T1], [T1, c])).toMatch(/the second key must be new/);
    expect(keyOrderProblem([], [T0, c])).toMatch(/the same key twice/);
    expect(keyOrderProblem([T1, N], [N, c], [T0, T1, N])).toMatch(/was pinned by an earlier release and dropped since/);
  });
});

describe("a build with the gate open: updaterProblems", () => {
  const ORIGIN = "https://rules.example.org";
  it("dev and e2e as they are: none", async () => {
    expect(await updaterProblems("dev")).toEqual([]);
    expect(await updaterProblems("e2e")).toEqual([]);
  }, 30_000);
  it("the store build as it is: no origin, no key", async () => {
    const p = await updaterProblems("prod");
    expect(p).toHaveLength(2);
    expect(p[0]).toMatch(/^the prod build has no rules origin \(scripts\/rules-update\.mjs RULES_ORIGINS\)/);
    expect(p[1]).toMatch(
      /^the prod build pins 0 signing keys \(scripts\/rules-keys\.mjs\): it needs two, current and next/,
    );
  }, 30_000);
  it("the store build with an origin and two keys of its own: none; with a test key, one key, a wrong kid, a bad origin: refused", async () => {
    const [k1, k2] = [fresh(), fresh()];
    expect(await updaterProblems("prod", { origin: ORIGIN, keys: [k1, k2] })).toEqual([]);
    const test = await updaterProblems("prod", { origin: ORIGIN, keys: [k1, TEST_RULES_KEYS[1]] });
    expect(test).toEqual([
      `the store build pins a test key (${TEST_RULES_KEYS[1]!.kid}): its private half is published with the tests`,
    ]);
    expect(await updaterProblems("prod", { origin: ORIGIN, keys: TEST_RULES_KEYS })).toHaveLength(2);
    expect(await updaterProblems("prod", { origin: ORIGIN, keys: [k1] })).toEqual([
      "the prod build pins 1 signing keys (scripts/rules-keys.mjs): it needs two, current and next (rules/SIGNING.md)",
    ]);
    expect(await updaterProblems("prod", { origin: ORIGIN, keys: [k1, { ...k2, kid: k1.kid }] })).toEqual([
      "the prod build's signing keys (scripts/rules-keys.mjs): keys[1].kid: not the key id of its key",
    ]);
    expect(await updaterProblems("prod", { origin: ORIGIN, keys: [k1, k1] })).toEqual([
      "the prod build's signing keys (scripts/rules-keys.mjs): keys[1].kid: a key listed twice",
    ]);
    for (const origin of [
      "",
      "http://rules.example.org",
      "https://rules.example.org/",
      "https://rules.example.org/v1",
      "https://rules.example.org:8443",
      "https://Rules.example.org",
      "https://rules",
      "https://u@rules.example.org",
    ])
      expect(await updaterProblems("prod", { origin, keys: [k1, k2] }), origin).toEqual([
        "the prod build has no rules origin (scripts/rules-update.mjs RULES_ORIGINS): an https origin, no path",
      ]);
    // the test keys are refused only in the store build
    expect(await updaterProblems("e2e", { origin: ORIGIN })).toEqual([]);
  }, 30_000);
  it("a test key in another spelling (its compressed SPKI) is still refused (the review's S2)", async () => {
    const c = compressedEntry(TEST_RULES_KEYS[0]!.spki);
    const p = await updaterProblems("prod", { origin: ORIGIN, keys: [c, fresh()] });
    expect(p).toContain(
      "the prod build's signing keys (scripts/rules-keys.mjs): keys[0].spki: not a P-256 key's SubjectPublicKeyInfo with its point uncompressed (91 bytes)",
    );
    expect(p).toContain(`the store build pins a test key (${c.kid}): its private half is published with the tests`);
  }, 30_000);
  it("the store build's origin: no reserved or local name, no IP address, not the dev and e2e builds' (the review's N2)", async () => {
    const keys = [fresh(), fresh()];
    for (const origin of [
      "https://rules.fix.test",
      "https://rules.test",
      "https://rules.example",
      "https://rules.invalid",
      "https://rules.localhost",
      "https://1.2.3.4",
      "https://10.0.0.1",
    ]) {
      expect(storeOrigin(origin), origin).toBe(false);
      expect(await updaterProblems("prod", { origin, keys }), origin).toEqual([
        `the store build's rules origin ${origin} is a test or reserved name, an IP address, or the dev and e2e builds' origin: no store build could ever reach it`,
      ]);
    }
    for (const origin of ["https://rules.sixkey.app", "https://rules.test.example.org", "https://1.rules.example.org"])
      expect(storeOrigin(origin), origin).toBe(true);
    // dev and e2e keep their fixture origin
    expect(await updaterProblems("dev", { origin: "https://rules.fix.test" })).toEqual([]);
    // the hosts a store build never names: the dev and e2e builds', even when the store build's origin is one of them
    expect(testRulesHosts()).toEqual(["rules.fix.test"]);
    expect(
      testRulesHosts({ prod: "https://rules.fix.test", dev: "https://rules.fix.test", e2e: "https://e2e.fix.test" }),
    ).toEqual(["rules.fix.test", "e2e.fix.test"]);
  }, 60_000);
});

describe("the guard's hooks", () => {
  const SW = join(EXT, "src/background/sw.ts");
  const FILL = join(EXT, "src/popup/main/Fill.tsx");
  const OPTIONS = join(EXT, "src/options/Settings.tsx");
  it("gate closed: an import of the updater's modules from the extension's own code resolves to its empty module", () => {
    const g = rulesGuard(false, join(EXT, "src"));
    expect(g.enforce).toBe("pre");
    for (const [s, from] of [
      ["../core/rules/signed", SW],
      ["../core/rules/signed.ts", SW],
      ["../../core/rules/signed", FILL],
      ["../core/rules/signed", OPTIONS],
      ["./signed", join(EXT, "src/core/rules/lookup.ts")],
      ["../platform/rules-fetch", SW],
      ["./rules-live.ts", join(EXT, "src/platform/x.ts")],
      ["../../platform/rules-live", FILL],
      ["../core/rules/signed", `${SW}?worker`],
      // in another letter case (the review's S1): on a disk that ignores case it is signed.ts; on one that does not, it is
      // taken all the same, which only ever keeps more out
      ["../core/rules/Signed", SW],
      ["../Core/Rules/signed.ts", SW],
      ["../core/rules/SIGNED.TS", SW],
      ["../platform/Rules-Live", SW],
    ] as const)
      expect(g.resolveId(s, from), `${s} from ${from}`).toBe(RULES_UPDATE_OFF);
    // a Windows path, with the source folder given in Windows's form
    expect(
      rulesGuard(false, "C:\\sixkey\\extension\\src").resolveId(
        "../core/rules/signed",
        "C:\\sixkey\\extension\\src\\background\\sw.ts",
      ),
    ).toBe(RULES_UPDATE_OFF);
    // the folder the build passes, whatever its parents are called (the review's N8): a copy whose extension folder has
    // another name is guarded the same
    expect(
      rulesGuard(false, "/x/sixkey-copy/ext/src").resolveId(
        "../core/rules/signed",
        "/x/sixkey-copy/ext/src/background/sw.ts",
      ),
    ).toBe(RULES_UPDATE_OFF);
    expect(
      rulesGuard(false, "/x/other/src").resolveId("../core/rules/signed", "/x/sixkey-copy/ext/src/background/sw.ts"),
    ).toBeNull();
    // by default, the src/ beside the guard's own folder
    expect(rulesGuard(false).resolveId("../core/rules/signed", SW)).toBe(RULES_UPDATE_OFF);
    for (const [s, from] of [
      ["./signed", join(EXT, "src/core/sync/x.ts")], // another module of that name
      ["../core/rules/signer", SW],
      ["../core/rules/signed-in", SW],
      ["../core/rules/format", SW],
      ["./rules-fetcher", SW],
      ["../core/rules/signed?raw", SW], // a query: not taken here, refused at the end (below)
      [join(EXT, "src/core/rules/signed.ts"), SW], // an absolute path: likewise
      ["../core/rules/signed", undefined],
      ["./signed", join(EXT, "../rules/tools/sign.mjs")], // not the extension's own code
    ] as const)
      expect(g.resolveId(s, from), `${s} from ${from}`).toBeNull();
    expect(g.load(RULES_UPDATE_OFF)).toBe("export {};");
    expect(g.load(join(EXT, "src/core/rules/signed.ts"))).toBeNull();
  });
  it("gate open: nothing is resolved or loaded", () => {
    const g = rulesGuard(true);
    expect(g.resolveId("../core/rules/signed", SW)).toBeNull();
    expect(g.load(RULES_UPDATE_OFF)).toBeNull();
  });
  it("gated: signed.ts in core/rules, rules-fetch.ts and rules-live.ts anywhere under the given src/, in any case", () => {
    const SRC = "/x/repo/ext/src";
    for (const p of [
      "/x/repo/ext/src/core/rules/signed.ts",
      "/x/repo/ext/src/platform/rules-fetch.ts",
      "/x/repo/ext/src/rules-live.ts",
      "/x/repo/ext/src/Core/Rules/Signed.ts",
      "/X/Repo/Ext/Src/core/rules/signed.ts",
      "/x/repo/ext/src/a/b/RULES-LIVE.TS",
    ])
      expect(gated(p, SRC), p).toBe(true);
    expect(gated("C:\\x\\ext\\src\\background\\rules-live.ts", "C:\\x\\ext\\src")).toBe(true);
    for (const p of [
      "/x/repo/ext/src/core/sync/signed.ts",
      "/x/repo/ext/src/core/rules/signed.tsx",
      "/x/repo/ext/src/platform/rules-fetch.js",
      "/x/repo/rules/tools/rules-live.ts",
      "/x/repo/ext/srcx/core/rules/signed.ts",
      "/home/src/repo/ext/core/rules/signed.ts", // a folder named src above it is not the given one
    ])
      expect(gated(p, SRC), p).toBe(false);
    expect(GATED_IN_SRC.flags).toContain("i");
    // the disk's own spelling is used where the file is there: the real signed.ts in any case on this disk
    expect(gated(join(EXT, "src/core/rules/signed.ts"), join(EXT, "src"))).toBe(true);
  });
  const end = (on: boolean, ids: string[], err?: unknown) => {
    const errors: string[] = [];
    rulesGuard(on, join(EXT, "src")).buildEnd.call(
      {
        getModuleIds: () => ids,
        error: (m: string) => {
          errors.push(m);
          throw new Error(m);
        },
      },
      err,
    );
    return errors;
  };
  it("gate closed: a graph holding any of the updater's modules fails the build", () => {
    const signed = join(EXT, "src/core/rules/signed.ts");
    expect(() => end(false, [SW, RULES_UPDATE_OFF, signed])).toThrow(
      /a build whose release gate keeps the site rules' updater out must not contain it: .*signed\.ts/,
    );
    expect(() => end(false, [SW, `${signed}?raw`])).toThrow(/must not contain it: .*signed\.ts/);
    expect(() => end(false, [SW, `\0${join(EXT, "src/platform/rules-live.ts")}`])).toThrow(/rules-live\.ts/);
    expect(() => end(false, [SW, join(EXT, "src/Core/Rules/SIGNED.ts")])).toThrow(/must not contain it: .*SIGNED\.ts/i);
    expect(() => end(false, [SW, join(EXT, "SRC/platform/rules-fetch.ts")])).toThrow(/rules-fetch\.ts/);
    expect(end(false, [SW, RULES_UPDATE_OFF, join(EXT, "src/core/rules/format.ts")])).toEqual([]);
  });
  it("the src folder given through a link (as /tmp is on macOS): compared as the disk spells it, still guarded", () => {
    const dir = mkdtempSync(join(tmpdir(), "sixkey-rules-guard-link-"));
    try {
      const link = join(dir, "src");
      symlinkSync(join(EXT, "src"), link);
      const g = rulesGuard(false, link);
      expect(g.resolveId("../core/rules/signed", SW)).toBe(RULES_UPDATE_OFF);
      expect(() =>
        g.buildEnd.call(
          {
            getModuleIds: () => [SW, join(EXT, "src/core/rules/signed.ts")],
            error: (m: string) => {
              throw new Error(m);
            },
          },
          undefined,
        ),
      ).toThrow(/must not contain it: .*signed\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("gate open, or a build already failing: no check", () => {
    expect(end(true, [SW, join(EXT, "src/core/rules/signed.ts")])).toEqual([]);
    expect(end(false, [join(EXT, "src/core/rules/signed.ts")], new Error("before"))).toEqual([]);
  });
});

describe("real bundles with the guard", () => {
  const work = mkdtempSync(join(tmpdir(), "sixkey-rules-guard-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  /** A module at `id` (a path under src/ that is not on disk), served by the test, with `text`. */
  const probe = (id: string, text: string) => ({
    name: "probe",
    enforce: "pre" as const,
    resolveId: (s: string) => (s === id ? id : null),
    load: (i: string) => (i === id ? text : null),
  });
  const bundle = async (input: string, on: boolean, extra: PluginOption[] = []) => {
    const out = (await build({
      configFile: false,
      logLevel: "silent",
      root: EXT,
      plugins: [...extra, rulesGuard(on, join(EXT, "src")) as PluginOption],
      build: { write: false, minify: false, rollupOptions: { input, output: { format: "es" } } },
    })) as { output: { type: string; code?: string }[] }[] | { output: { type: string; code?: string }[] };
    const o = Array.isArray(out) ? out[0]! : out;
    return o.output
      .filter((c) => c.type === "chunk")
      .map((c) => c.code ?? "")
      .join("\n");
  };
  const WORKER = join(EXT, "src/background/__rules-probe.ts");
  const WORKER_CODE = 'import * as signed from "../core/rules/signed";\nconsole.log(Object.keys(signed));\n';
  const LAZY = join(EXT, "src/popup/main/__rules-probe.ts");
  const LAZY_CODE = 'console.log(import("../../core/rules/signed"));\n';
  it("the worker's kind of entry: gate closed, built without the module; gate open, with it", async () => {
    const off = await bundle(WORKER, false, [probe(WORKER, WORKER_CODE)]);
    expect(off).not.toContain("sixkey-rules-manifest");
    expect(off).not.toContain("crypto.subtle.verify");
    const on = await bundle(WORKER, true, [probe(WORKER, WORKER_CODE)]);
    expect(on).toContain("sixkey-rules-manifest");
  }, 60_000);
  it("a lazy chunk's import(), as the Fill chunk's or the settings page's would be: the same", async () => {
    const off = await bundle(LAZY, false, [probe(LAZY, LAZY_CODE)]);
    expect(off).not.toContain("sixkey-rules-manifest");
    expect(await bundle(LAZY, true, [probe(LAZY, LAZY_CODE)])).toContain("sixkey-rules-manifest");
  }, 60_000);
  it("an import in another letter case (the review's S1): gate closed, built without the module", async () => {
    for (const spelled of ["../core/rules/Signed", "../Core/Rules/signed.ts"]) {
      const code = `import * as signed from ${JSON.stringify(spelled)};\nconsole.log(Object.keys(signed));\n`;
      const off = await bundle(WORKER, false, [probe(WORKER, code)]);
      expect(off, spelled).not.toContain("sixkey-rules-manifest");
      expect(off, spelled).not.toContain("crypto.subtle.verify");
    }
  }, 60_000);
  it("an import of a name from the empty module fails the build", async () => {
    const code = 'import { checkSigned } from "../core/rules/signed";\nconsole.log(checkSigned);\n';
    await expect(bundle(WORKER, false, [probe(WORKER, code)])).rejects.toThrow(/checkSigned/);
  }, 60_000);
  it("an import the guard does not take (a file outside src/, an absolute path from src/): the build fails", async () => {
    const entry = join(work, "entry.ts");
    writeFileSync(
      entry,
      `import { kidOf } from ${JSON.stringify(join(EXT, "src/core/rules/signed.ts"))};\nconsole.log(kidOf);\n`,
    );
    await expect(bundle(entry, false)).rejects.toThrow(
      /a build whose release gate keeps the site rules' updater out must not contain it: .*signed\.ts/,
    );
    const abs = `import { kidOf } from ${JSON.stringify(join(EXT, "src/core/rules/signed.ts"))};\nconsole.log(kidOf);\n`;
    await expect(bundle(WORKER, false, [probe(WORKER, abs)])).rejects.toThrow(/must not contain it: .*signed\.ts/);
    // and in another letter case, from outside src/ (the review's S1): the disk's own spelling is compared
    const caseEntry = join(work, "case.ts");
    writeFileSync(
      caseEntry,
      `import { kidOf } from ${JSON.stringify(join(EXT, "src/Core/Rules/Signed.ts"))};\nconsole.log(kidOf);\n`,
    );
    // (on a disk that keeps case apart, as Linux's, that spelling is no file, and the build fails on it as it is)
    const ignoresCase = existsSync(join(EXT, "SRC/core/rules/signed.ts"));
    await expect(bundle(caseEntry, false)).rejects.toThrow(ignoresCase ? /must not contain it: .*signed\.ts/i : /./);
  }, 60_000);
});
