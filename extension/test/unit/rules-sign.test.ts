// The site rules' offline signer (rules/tools/sign.mjs; TOTP autofill Stage 3, AF3-U1; docs/design/notes/
// AUTOFILL3-NOTES.md §9), run as a maintainer runs it (Node, type stripping), with the test keys of
// test/fixtures/rules-keys/ (never a real key), in a temporary folder, never on the network:
//   - the round trip: what it signs, the extension's own check (src/core/rules/signed.ts) accepts with the test keys
//     pinned, and a changed manifest, a changed bundle or another kid is refused;
//   - an encrypted key, and keys it refuses;
//   - it refuses, before signing anything and writing nothing, a bundle with a key written twice in its raw text (the
//     AF3-1a review's N4), one the format refuses as a live bundle (aliases, appends, upstream files: the plan's M1), and
//     a manifest the extension would refuse (a version out of its bounds, a validity over 180 days);
//   - a key on a device: the exact bytes to sign, then the signature assembled from DER or raw, DER read strictly;
//   - the key ids it prints are rules-keys.mjs's; its command line; no network; it never overwrites a file.
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalHost } from "../../src/core/match";
import { isShared } from "../../src/core/site-domains";
import { validate } from "../../src/core/rules/format";
import { checkSigned, importPinned, parseManifest, parseSigned, type Pinned } from "../../src/core/rules/signed";
import { TEST_RULES_KEYS } from "../../scripts/rules-keys.mjs";
import { annotationOf, annotations } from "../helpers/reuse-toml";

const REPO = resolve(import.meta.dirname, "../../..");
const TOOL = join(REPO, "rules/tools/sign.mjs");
const KEYS = join(REPO, "extension/test/fixtures/rules-keys");
const CURRENT = join(KEYS, "test-only-current.pem");
const NEXT = join(KEYS, "test-only-next.pem");
const DAY = 86_400_000;
const C = { validate, checks: { canonicalHost, isShared } };
const read = (p: string) => readFileSync(p, "utf8");

const work = mkdtempSync(join(tmpdir(), "sixkey-sign-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
let n = 0;
const dir = () => join(work, `d${++n}`);
/** The signer, as a maintainer runs it. */
function tool(args: string[], input?: string) {
  return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", TOOL, ...args], {
    encoding: "utf8",
    input,
    timeout: 30_000,
  });
}
type J = Record<string, any>;
const live = (version: number, f?: (b: J) => void): J => {
  const b: J = {
    format: "sixkey-rules",
    kind: "live",
    schema: 1,
    version,
    created: "2026-11-04",
    license: "AGPL-3.0-or-later",
    source: `https://example.org/sixkey/tree/rules-v${version}/rules`,
    rules: { a: { pages: [{ path: "/2fa", field: "input#otp", segments: 0, fill: "auto" }] } },
    hosts: { "login.example.com": "a" },
  };
  f?.(b);
  return b;
};
/** A bundle file in a folder of its own: its path. */
function bundleFile(b: J | string): string {
  const d = dir();
  mkdirSync(d);
  const f = join(d, "live.json");
  writeFileSync(f, typeof b === "string" ? b : `${JSON.stringify(b, null, 2)}\n`);
  return f;
}
let pinned: Pinned[];
beforeAll(async () => {
  const r = await importPinned(TEST_RULES_KEYS);
  if (!r.ok) throw new Error(r.error);
  pinned = r.value;
});
/** The extension's check of what the signer wrote in `out` for `version`. */
const check = (out: string, version: number, o: { file?: string; bundle?: Uint8Array; record?: unknown } = {}) =>
  checkSigned(
    o.file ?? read(join(out, "manifest.json")),
    new Uint8Array(o.bundle ?? readFileSync(join(out, `bundle-${version}.json`))),
    o.record ?? null,
    { now: Date.now(), baseline: 1, pinned },
    C,
  );
/** A PEM file of the key `spki` (base64, uncompressed) in the compressed form: the same key, written another way. */
function compressedPem(spki: string, name: string): string {
  const der = Buffer.from(spki, "base64");
  const y = der.subarray(59, 91);
  const c = Buffer.concat([
    Buffer.from("3039301306072a8648ce3d020106082a8648ce3d030107032200", "hex"),
    Buffer.from([y[31]! & 1 ? 3 : 2]),
    der.subarray(27, 59),
  ]);
  expect(createPublicKey({ key: c, format: "der", type: "spki" }).export({ type: "spki", format: "der" })).toHaveLength(
    59,
  );
  const f = join(work, `${name}.pem`);
  writeFileSync(f, `-----BEGIN PUBLIC KEY-----\n${c.toString("base64")}\n-----END PUBLIC KEY-----\n`);
  return f;
}
const nothingIn = (out: string) => expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);

describe("sign: the round trip with the test key", () => {
  it("writes the signed manifest and the bundle byte for byte; the extension accepts them", async () => {
    const f = bundleFile(live(5));
    const out = dir();
    const before = Math.floor(Date.now() / 1000) * 1000;
    const r = tool(["sign", "--bundle", f, "--key", CURRENT, "--out", out]);
    const after = Date.now();
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(out).sort()).toEqual(["bundle-5.json", "manifest.json"]);
    expect(readFileSync(join(out, "bundle-5.json"))).toEqual(readFileSync(f));
    const v = await check(out, 5);
    if (!v.ok) throw new Error(v.error);
    expect(v.value.record).toMatchObject({ kid: TEST_RULES_KEYS[0]!.kid, version: 5, retired: [] });
    const m = v.value.manifest;
    const created = Date.parse(m.created);
    expect(created).toBeGreaterThanOrEqual(before);
    expect(created).toBeLessThanOrEqual(after);
    expect(Date.parse(m.expires) - created).toBe(120 * DAY); // the default validity
    expect(r.stderr).toContain(`signed version 5 with key ${TEST_RULES_KEYS[0]!.kid}`);
    expect(r.stderr).toContain("not a key the store build pins");
    expect(r.stderr).toContain("publish the bundle first, then the manifest");
    // the file: one line, the three fields
    const s = parseSigned(read(join(out, "manifest.json")));
    expect(s.ok && s.value.kid).toBe(TEST_RULES_KEYS[0]!.kid);
    expect(read(join(out, "manifest.json")).split("\n")).toHaveLength(2);
  });
  it("the next key's bundle: accepted, and it retires the current key on that client", async () => {
    const out = dir();
    expect(tool(["sign", "--bundle", bundleFile(live(6)), "--key", NEXT, "--out", out]).status).toBe(0);
    const v = await check(out, 6);
    expect(v.ok && v.value.record.retired).toEqual([TEST_RULES_KEYS[0]!.kid]);
  });
  it("--days: 1 to 180, whole days; anything else refused before anything is written", async () => {
    const out = dir();
    expect(
      tool(["sign", "--bundle", bundleFile(live(5)), "--key", CURRENT, "--days", "180", "--out", out]).status,
    ).toBe(0);
    const m = parseManifest(JSON.parse(read(join(out, "manifest.json"))).m);
    expect(m.ok && Date.parse(m.value.expires) - Date.parse(m.value.created)).toBe(180 * DAY);
    for (const d of ["181", "0", "1.5", "x", "-3", "400"]) {
      const o = dir();
      const r = tool(["sign", "--bundle", bundleFile(live(5)), "--key", CURRENT, "--days", d, "--out", o]);
      expect(r.status, d).toBe(1);
      expect(r.stderr).toMatch(/--days: not a whole number of days from 1 to 180/);
      nothingIn(o);
    }
  });
  it("what the extension refuses in its output: a changed manifest, a changed bundle, another kid, an unpinned kid", async () => {
    const out = dir();
    expect(tool(["sign", "--bundle", bundleFile(live(5)), "--key", CURRENT, "--out", out]).status).toBe(0);
    const file = JSON.parse(read(join(out, "manifest.json")));
    const bundle = readFileSync(join(out, "bundle-5.json"));
    const as = (o: J) => `${JSON.stringify({ ...file, ...o })}\n`;
    const no = async (o: Parameters<typeof check>[2], why: RegExp) => {
      const r = await check(out, 5, o);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(why);
    };
    await no({ file: as({ m: file.m.replace('"version":5', '"version":6') }) }, /^sig: does not verify/);
    await no({ file: as({ m: file.m.replace(/"expires":"\d{4}/, '"expires":"2099') }) }, /^sig: does not verify/);
    const changed = Buffer.from(bundle);
    changed[changed.length - 1] = 0x20;
    await no({ bundle: changed }, /^bundle: its SHA-256 is not the manifest's/);
    await no({ file: as({ kid: TEST_RULES_KEYS[1]!.kid }) }, /^sig: does not verify/);
    await no({ file: as({ kid: "0".repeat(32) }) }, /^kid: not a key this build pins/);
    expect((await check(out, 5)).ok).toBe(true);
  });
  it("never overwrites: a second run into the same folder is refused, the files untouched", () => {
    const f = bundleFile(live(5));
    const out = dir();
    expect(tool(["sign", "--bundle", f, "--key", CURRENT, "--out", out]).status).toBe(0);
    const was = read(join(out, "manifest.json"));
    const r = tool(["sign", "--bundle", f, "--key", CURRENT, "--out", out]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/is there already: nothing is overwritten/);
    expect(read(join(out, "manifest.json"))).toBe(was);
  });
});

describe("the keys", () => {
  it("an encrypted PKCS#8 key, its passphrase on standard input", async () => {
    const enc = join(work, "enc.pem");
    writeFileSync(
      enc,
      createPrivateKey(read(CURRENT)).export({
        type: "pkcs8",
        format: "pem",
        cipher: "aes-256-cbc",
        passphrase: "test only",
      }),
    );
    const out = dir();
    const r = tool(
      ["sign", "--bundle", bundleFile(live(5)), "--key", enc, "--passphrase-stdin", "--out", out],
      "test only\n",
    );
    expect(r.status, r.stderr).toBe(0);
    expect((await check(out, 5)).ok).toBe(true);
    for (const [args, input, why] of [
      [["--passphrase-stdin"], "wrong\n", /cannot be opened with this passphrase/],
      [[], undefined, /encrypted: give its passphrase with --passphrase-stdin/],
    ] as const) {
      const o = dir();
      const x = tool(["sign", "--bundle", bundleFile(live(5)), "--key", enc, ...args, "--out", o], input);
      expect(x.status).toBe(1);
      expect(x.stderr).toMatch(why);
      nothingIn(o);
    }
  });
  it("refused: a key that is not PKCS#8, not P-256, a public key", () => {
    const sec1 = join(work, "sec1.pem");
    writeFileSync(sec1, createPrivateKey(read(CURRENT)).export({ type: "sec1", format: "pem" }));
    const p384 = join(work, "p384.pem");
    writeFileSync(
      p384,
      generateKeyPairSync("ec", { namedCurve: "P-384" }).privateKey.export({ type: "pkcs8", format: "pem" }),
    );
    const pub = join(work, "pub.pem");
    writeFileSync(pub, createPublicKey(read(CURRENT)).export({ type: "spki", format: "pem" }));
    for (const [key, why] of [
      [sec1, /not a PKCS#8 private key in PEM/],
      [p384, /not a P-256 \(prime256v1\) key/],
      [pub, /not a PKCS#8 private key in PEM/],
    ] as const) {
      const o = dir();
      const r = tool(["sign", "--bundle", bundleFile(live(5)), "--key", key, "--out", o]);
      expect(r.status, key).toBe(1);
      expect(r.stderr).toMatch(why);
      nothingIn(o);
    }
  });
  it("kid: the entry rules-keys.mjs lists, from the private key, its public PEM or its DER", () => {
    for (const [i, file] of [CURRENT, NEXT].entries()) {
      const want = TEST_RULES_KEYS[i]!;
      const r = tool(["kid", "--key", file]);
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual(want);
      const pem = join(work, `kid-${i}.pem`);
      writeFileSync(pem, createPublicKey(read(file)).export({ type: "spki", format: "pem" }));
      expect(JSON.parse(tool(["kid", "--public", pem]).stdout)).toEqual(want);
      const der = join(work, `kid-${i}.der`);
      writeFileSync(der, createPublicKey(read(file)).export({ type: "spki", format: "der" }));
      expect(JSON.parse(tool(["kid", "--public", der]).stdout)).toEqual(want);
    }
    expect(tool(["kid", "--public", CURRENT]).stderr).toMatch(/not a public key/);
  });
  it("a public key in the compressed form gives the same, uncompressed entry (the review's S2)", () => {
    for (const [i, T] of TEST_RULES_KEYS.entries()) {
      const pem = compressedPem(T.spki, `kid-c${i}`);
      const r = tool(["kid", "--public", pem]);
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual(T);
    }
  });
});

describe("refused before anything is signed, nothing written", () => {
  const refusedFor = (b: J | string, why: RegExp, extra: string[] = []) => {
    const o = dir();
    const r = tool(["sign", "--bundle", bundleFile(b), "--key", CURRENT, ...extra, "--out", o]);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(why);
    nothingIn(o);
  };
  it("a JSON key written twice in the raw text (the AF3-1a review's N4), at any depth, escapes read", () => {
    const text = `${JSON.stringify(live(5), null, 2)}\n`;
    refusedFor(text.replace('"version": 5,', '"version": 9,\n  "version": 5,'), /the key "version" is written twice/);
    refusedFor(
      text.replace('"login.example.com": "a"', '"login.example.com": "a", "login.example.com": "a"'),
      /the key "login\.example\.com" is written twice/,
    );
    refusedFor(
      text.replace('"fill": "auto"', '"fill": "auto", "fil\\u006c": "auto"'),
      /the key "fill" is written twice/,
    );
  });
  it("whatever the format refuses as a live bundle: aliases, appends, upstream (M1), a baseline, a shared suffix", () => {
    for (const k of ["aliases", "appends", "upstream"])
      refusedFor(
        live(5, (b) => (b[k] = [])),
        new RegExp(`not a live bundle the extension accepts: bundle: a live bundle carries no "${k}"`),
      );
    refusedFor(
      live(5, (b) => (b.kind = "baseline")),
      /not a live bundle the extension accepts: bundle\.kind: not "live"/,
    );
    refusedFor(
      live(5, (b) => (b.hosts = { "github.io": "a" })),
      /not a live bundle the extension accepts: .*"github\.io" is a shared suffix/,
    );
    refusedFor(
      live(5, (b) => (b.source = "")),
      /not a live bundle the extension accepts: bundle\.source/,
    );
  });
  it("not ASCII, not JSON, over 512 KiB", () => {
    refusedFor(JSON.stringify(live(5)).replace("input#otp", "input#ötp"), /not ASCII text/);
    refusedFor("{", /not JSON/);
    const t = JSON.stringify(live(5));
    refusedFor(t + " ".repeat(512 * 1024 + 1 - t.length), /larger than 524288 bytes/);
  });
  it("a manifest the extension would refuse: its version not above the baseline, or above it by more than 1,000", () => {
    // the default baseline: the committed rules/build/baseline.json's version
    const committed = JSON.parse(read(join(REPO, "rules/build/baseline.json"))).version as number;
    refusedFor(
      live(committed),
      new RegExp(
        `the extension would refuse this manifest: m\\.version: not above the built-in rules' version ${committed}`,
      ),
    );
    refusedFor(live(6), /m\.version: not above the built-in rules' version 6/, ["--baseline", "6"]);
    refusedFor(live(1007), /m\.version: more than 1000 above the built-in rules' version 6/, ["--baseline", "6"]);
    // --baseline is digits only (the review's N5): "" or " " is no 0, "0x10" no 16, "1e3" no 1000
    for (const b of ["", " ", "0x10", "1e3", "-1", "6.0", "+6"])
      refusedFor(live(1006), /--baseline: not a version \(digits only\)/, ["--baseline", b]);
    const o = dir();
    expect(
      tool(["sign", "--bundle", bundleFile(live(1006)), "--key", CURRENT, "--baseline", "6", "--out", o]).status,
    ).toBe(0);
  });
});

describe("a key on a device: prepare, sign elsewhere, assemble", () => {
  const pubOf = (file: string) => {
    const p = join(work, `pub-${++n}.pem`);
    writeFileSync(p, createPublicKey(read(file)).export({ type: "spki", format: "pem" }));
    return p;
  };
  /** prepare for `key`'s public half: the folder, the bundle, the public key file. */
  function prepare(version: number, key = CURRENT) {
    const prep = dir();
    const f = bundleFile(live(version));
    const pub = pubOf(key);
    const r = tool(["prepare", "--bundle", f, "--public", pub, "--days", "30", "--out", prep]);
    expect(r.status, r.stderr).toBe(0);
    return { prep, f, pub };
  }
  const assemble = (p: { prep: string; f: string; pub: string }, sig: Buffer, format: string, out = dir()) => {
    const s = join(p.prep, `sig-${++n}`);
    writeFileSync(s, sig);
    const r = tool([
      "assemble",
      "--bundle",
      p.f,
      "--public",
      p.pub,
      "--body",
      join(p.prep, "manifest-body.txt"),
      "--sig",
      s,
      "--sig-format",
      format,
      "--out",
      out,
    ]);
    return { r, out };
  };
  it("prepare writes the manifest and the exact bytes to sign, and signs nothing", () => {
    const { prep } = prepare(5);
    expect(readdirSync(prep).sort()).toEqual(["manifest-body.txt", "to-sign.bin"]);
    const m = read(join(prep, "manifest-body.txt"));
    const p = parseManifest(m);
    expect(p.ok && Date.parse(p.value.expires) - Date.parse(p.value.created)).toBe(30 * DAY);
    expect(readFileSync(join(prep, "to-sign.bin")).toString("latin1")).toBe(`sixkey-rules-manifest\n1\n${m}`);
  });
  it("prepare says how to sign: over the SHA-256, and prints it for a device that signs a digest (the review's N6)", () => {
    const prep = dir();
    const r = tool(["prepare", "--bundle", bundleFile(live(5)), "--public", pubOf(CURRENT), "--out", prep]);
    expect(r.status, r.stderr).toBe(0);
    const digest = createHash("sha256")
      .update(readFileSync(join(prep, "to-sign.bin")))
      .digest("hex");
    expect(r.stderr).toContain(`this SHA-256 of the file: ${digest}`);
    expect(r.stderr).toContain("CKM_ECDSA_SHA256");
    expect(r.stderr).not.toContain("the device hashes it");
  });
  it("a compressed public key: prepare and assemble name the same key, and the result is accepted", async () => {
    const prep = dir();
    const f = bundleFile(live(5));
    const pub = compressedPem(TEST_RULES_KEYS[0]!.spki, "prep-c");
    expect(tool(["prepare", "--bundle", f, "--public", pub, "--out", prep]).status).toBe(0);
    const s = join(prep, "sig.der");
    writeFileSync(s, sign("sha256", readFileSync(join(prep, "to-sign.bin")), createPrivateKey(read(CURRENT))));
    const out = dir();
    const r = tool([
      "assemble",
      "--bundle",
      f,
      "--public",
      pub,
      "--body",
      join(prep, "manifest-body.txt"),
      "--sig",
      s,
      "--sig-format",
      "der",
      "--out",
      out,
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(read(join(out, "manifest.json"))).kid).toBe(TEST_RULES_KEYS[0]!.kid);
    expect((await check(out, 5)).ok).toBe(true);
  });
  it("a DER signature (as OpenSSL and most devices write it) and a raw one: assembled, and accepted", async () => {
    for (const format of ["der", "raw"]) {
      const p = prepare(5);
      const data = readFileSync(join(p.prep, "to-sign.bin"));
      const key = createPrivateKey(read(CURRENT));
      const sig = sign("sha256", data, format === "der" ? key : { key, dsaEncoding: "ieee-p1363" });
      const { r, out } = assemble(p, sig, format);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain("assembled the signature of version 5");
      expect((await check(out, 5)).ok).toBe(true);
    }
  });
  it("refused, nothing written: another key's signature, a raw one of 63 bytes, DER read as raw, raw read as DER", () => {
    const p = prepare(5);
    const data = readFileSync(join(p.prep, "to-sign.bin"));
    const other = createPrivateKey(read(NEXT));
    const mine = createPrivateKey(read(CURRENT));
    for (const [sig, format, why] of [
      [sign("sha256", data, other), "der", /failed the extension's own check: sig: does not verify/],
      [sign("sha256", data, { key: mine, dsaEncoding: "ieee-p1363" }).subarray(1), "raw", /64 bytes/],
      [sign("sha256", data, mine), "raw", /a raw signature is r and s, 64 bytes/],
      [sign("sha256", data, { key: mine, dsaEncoding: "ieee-p1363" }), "der", /not DER/],
    ] as const) {
      const { r, out } = assemble(p, Buffer.from(sig), format);
      expect(r.status, `${format} ${r.stderr}`).toBe(1);
      expect(r.stderr).toMatch(why);
      nothingIn(out);
    }
  });
  it("DER to r‖s, strictly: a padded r or s, a short one; refused: not minimal, negative, zero, trailing, long form", async () => {
    const { p1363FromDer } = (await import(pathToFileURL(TOOL).href)) as {
      p1363FromDer(der: Uint8Array): Buffer;
    };
    const key = createPrivateKey(read(CURRENT));
    const data = Buffer.from("sixkey");
    // real signatures until one has a 33-byte integer (a 0 before a high bit) and one a shorter one (31 bytes or less)
    let padded = false;
    let short = false;
    for (let i = 0; i < 20_000 && !(padded && short); i++) {
      const der = sign("sha256", data, key);
      const lens = [der[3]!, der[5 + der[3]!]!];
      padded ||= lens.includes(33);
      short ||= lens.some((l) => l < 32);
      const raw = p1363FromDer(der);
      expect(raw.length).toBe(64);
      expect(verify("sha256", data, { key: createPublicKey(key), dsaEncoding: "ieee-p1363" }, raw)).toBe(true);
    }
    expect(padded && short).toBe(true);
    const int = (v: number[]) => [0x02, v.length, ...v];
    const seq = (...parts: number[][]) => {
      const body = parts.flat();
      return Uint8Array.from([0x30, body.length, ...body]);
    };
    const one = Array(32).fill(1);
    expect(p1363FromDer(seq(int(one), int(one))).length).toBe(64);
    for (const [der, why] of [
      [seq(int([0x00, 0x01, ...one.slice(2)]), int(one)), /r is not written in its shortest form/],
      [seq(int([0x80, ...one.slice(1)]), int(one)), /r is negative/],
      [seq(int([0x00]), int(one)), /r is zero/],
      [seq(int(one), int([0x00, 0x00])), /s is not written in its shortest form/],
      [Uint8Array.from([...seq(int(one), int(one)), 0x00]), /SEQUENCE's length/],
      [seq(int(one), int(one), int([1])), /bytes after the SEQUENCE/],
      [Uint8Array.from([0x30, 0x81, 68, ...int(one), ...int(one)]), /SEQUENCE's length/],
      [seq(int([0x01, ...one]), int(one)), /r is longer than 32 bytes/],
      [Uint8Array.from([0x31, 68, ...int(one), ...int(one)]), /no SEQUENCE/],
      [seq(int(one)), /ends too soon/],
    ] as const)
      expect(() => p1363FromDer(der), String(why)).toThrow(why);
  });
});

describe("its command line, its reach, its licence", () => {
  it("anything it does not take: the usage, exit code 2, nothing written", () => {
    const f = bundleFile(live(5));
    const o = dir();
    for (const args of [
      [],
      ["sigh"],
      ["sign"],
      ["sign", "--bundle", f, "--key", CURRENT],
      ["sign", "--bundle", f, "--key", CURRENT, "--out", o, "--out", o],
      ["sign", "--bundle", f, "--key", CURRENT, "--out", o, "--public", CURRENT],
      ["sign", "--bundle", f, "--key", "--out", o],
      ["sign", "--bundle", f, "--key", CURRENT, "--out", o, "extra"],
      ["prepare", "--bundle", f, "--key", CURRENT, "--out", o],
      ["assemble", "--bundle", f, "--public", CURRENT, "--body", f, "--sig", f, "--out", o],
      ["assemble", "--bundle", f, "--public", CURRENT, "--body", f, "--sig", f, "--sig-format", "pem", "--out", o],
      ["kid"],
      ["kid", "--public", CURRENT, "--key", CURRENT],
      ["kid", "--public", CURRENT, "--passphrase-stdin"],
      ["__proto__"],
    ]) {
      const r = tool(args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toMatch(/^usage: node rules\/tools\/sign\.mjs sign/);
    }
    nothingIn(o);
  });
  it("reaches no network", () => {
    const src = read(TOOL);
    expect(src).not.toMatch(/\bfetch\b|https?\.request|node:https?|node:net|node:dgram|node:tls/);
  });
  it("REUSE: the tool AGPL as the other rules tools, its document CC-BY, the checker and the test keys MPL, the schema CC0", () => {
    const entries = annotations(REPO);
    const id = (p: string) => annotationOf(entries, p)?.id;
    expect(id("rules/tools/sign.mjs")).toBe("AGPL-3.0-or-later");
    expect(id("rules/SIGNING.md")).toBe("CC-BY-4.0");
    expect(id("extension/src/core/rules/signed.ts")).toBe("MPL-2.0");
    expect(id("extension/test/fixtures/rules-keys/test-only-current.pem")).toBe("MPL-2.0");
    expect(id("extension/scripts/rules-keys.mjs")).toBe("MPL-2.0");
    expect(id("contract/rules/1/manifest.schema.json")).toBe("CC0-1.0");
  });
});
