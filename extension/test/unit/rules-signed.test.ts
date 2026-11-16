// The site rules' signed manifest (src/core/rules/signed.ts; TOTP autofill Stage 3, AF3-U1; docs/design/notes/
// AUTOFILL3-NOTES.md §9; the plan's §5.2, M3, N10): every rule of what a downloaded bundle must prove, each bound on both
// sides, and the record's transitions (the floor, succession and retirement, a key no longer pinned, expiry, the switch
// turned off), with keys made here by WebCrypto (P-256) and signatures made as the signer makes them.
import { createPrivateKey, createPublicKey, createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { canonicalHost } from "../../src/core/match";
import { isShared } from "../../src/core/site-domains";
import { validate } from "../../src/core/rules/format";
import {
  BOUNDS,
  checkManifest,
  checkSigned,
  heldBundle,
  importPinned,
  kidOf,
  manifestText,
  MANIFEST_FIELDS,
  P256_SPKI_PREFIX,
  parseManifest,
  parseSigned,
  readRecord,
  SIGNED_PREFIX,
  signedBytes,
  signedFile,
  switchedOff,
  type Checker,
  type LiveRecord,
  type Manifest,
  type Pinned,
} from "../../src/core/rules/signed";
import { TEST_RULES_KEYS } from "../../scripts/rules-keys.mjs";

const EXT = resolve(import.meta.dirname, "../..");
const C: Checker = { validate, checks: { canonicalHost, isShared } };
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);
const iso = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");
const enc = (s: string) => new TextEncoder().encode(s);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

type Key = { kid: string; spki: string; priv: CryptoKey };
async function newKey(): Promise<Key> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
  return { kid: await kidOf(spki), spki: b64(spki), priv: kp.privateKey };
}
async function pin(...keys: Key[]): Promise<Pinned[]> {
  const r = await importPinned(keys.map(({ kid, spki }) => ({ kid, spki })));
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
const sign = async (key: Key, bytes: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.priv, bytes));

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
const bytesOf = (b: J | string) => enc(typeof b === "string" ? b : `${JSON.stringify(b, null, 2)}\n`);
/** The manifest for `bytes` (its bundle `b`), as the signer writes it, with `over` changing fields. */
const manifestFor = (bytes: Uint8Array, b: J, over: Partial<Manifest> = {}): Manifest => ({
  format: "sixkey-rules-manifest",
  schema: 1,
  version: b.version,
  created: iso(T0),
  expires: iso(T0 + 120 * DAY),
  sha256: sha(bytes),
  size: bytes.length,
  source: b.source,
  license: b.license,
  ...over,
});
/** A signed file: the manifest's text `m` (or the one of `over`), signed by `key`, with its kid unless another is said. */
async function signed(
  key: Key,
  bytes: Uint8Array,
  b: J,
  over: Partial<Manifest> = {},
  o: { m?: string; kid?: string } = {},
) {
  const m = o.m ?? manifestText(manifestFor(bytes, b, over));
  return signedFile(m, o.kid ?? key.kid, await sign(key, signedBytes(m)));
}

/** The compressed form of an uncompressed P-256 SPKI (base64): the same key, another spelling (59 bytes). */
function compressed(spki: string): Uint8Array<ArrayBuffer> {
  const der = Buffer.from(spki, "base64");
  const x = der.subarray(27, 59);
  const y = der.subarray(59, 91);
  const head = Buffer.from("3039301306072a8648ce3d020106082a8648ce3d030107032200", "hex");
  return new Uint8Array(Buffer.concat([head, Buffer.from([y[31]! & 1 ? 3 : 2]), x]));
}

let A: Key, B: Key, X: Key;
let AB: Pinned[];
beforeAll(async () => {
  [A, B, X] = [await newKey(), await newKey(), await newKey()];
  AB = await pin(A, B);
});
const ctx = (o: { now?: number; baseline?: number; pinned?: Pinned[] } = {}) => ({
  now: T0,
  baseline: 1,
  pinned: AB,
  ...o,
});
const refused = (r: { ok: boolean; error?: string }, why: RegExp) => {
  expect(r.ok, "refused").toBe(false);
  expect(r.error).toMatch(why);
};
/** A bundle of `version`, its bytes, and a manifest signed by `key` with `over`; checked against `record` and `c`. */
async function run(
  key: Key,
  version: number,
  record: unknown = null,
  c = ctx(),
  over: Partial<Manifest> = {},
  f?: (b: J) => void,
) {
  const b = live(version, f);
  const bytes = bytesOf(b);
  return checkSigned(await signed(key, bytes, b, over), bytes, record, c, C);
}
const ok = (r: Awaited<ReturnType<typeof checkSigned>>) => {
  if (!r.ok) throw new Error(`refused: ${r.error}`);
  return r.value;
};

describe("a valid signed manifest", () => {
  it("is accepted with its bundle, and gives the record to keep", async () => {
    const b = live(5);
    const bytes = bytesOf(b);
    const file = await signed(A, bytes, b);
    expect(file.endsWith("\n")).toBe(true);
    const v = ok(await checkSigned(file, bytes, null, ctx(), C));
    expect(v.manifest.version).toBe(5);
    expect(v.bundle.kind).toBe("live");
    expect(v.bundle.rules.get("a")?.pages[0]?.field).toBe("input#otp");
    expect(v.record).toEqual({
      kid: A.kid,
      version: 5,
      retired: [],
      held: { text: new TextDecoder().decode(bytes), expires: iso(T0 + 120 * DAY) },
    });
    // checkManifest: steps 1 to 3 alone, before the bundle is fetched
    const m = await checkManifest(file, null, ctx());
    expect(m.ok && m.value.manifest.sha256).toBe(sha(bytes));
  });
  it('the signature covers the prefix and m: the exact bytes are "sixkey-rules-manifest\\n1\\n" + m', async () => {
    expect(SIGNED_PREFIX).toBe("sixkey-rules-manifest\n1\n");
    const b = live(5);
    const bytes = bytesOf(b);
    const m = manifestText(manifestFor(bytes, b));
    expect(Buffer.from(signedBytes(m)).toString("latin1")).toBe(`sixkey-rules-manifest\n1\n${m}`);
    // signed over m alone, or with another schema line: refused
    for (const data of [m, `sixkey-rules-manifest\n2\n${m}`, `sixkey-rules-manifest\n1${m}`]) {
      const file = signedFile(m, A.kid, await sign(A, enc(data)));
      refused(await checkSigned(file, bytes, null, ctx(), C), /^sig: does not verify/);
    }
  });
});

describe("the signed file: closed, {m, kid, sig}", () => {
  const good = { m: "{}", kid: "0".repeat(32), sig: b64url(new Uint8Array(64)) };
  const parse = (o: unknown) => parseSigned(typeof o === "string" ? o : JSON.stringify(o));
  it("reads the three fields; refuses an unknown field, a missing one, anything not an object, not JSON, too long", () => {
    const r = parse(good);
    expect(r.ok && r.value.sig.length).toBe(64);
    refused(parse({ ...good, x: 1 }), /^file: unknown field "x"/);
    for (const k of ["m", "kid", "sig"]) {
      const o: J = { ...good };
      delete o[k];
      refused(parse(o), new RegExp(`^file: missing field "${k}"`));
    }
    for (const v of ["[]", "null", '"x"', "3"]) refused(parse(v), /^file: not an object/);
    refused(parse("{"), /^file: not JSON/);
    refused(parse({ ...good, m: "x".repeat(BOUNDS.signedFile) }), /^file: longer than 4096 characters/);
  });
  it("m: a string of printable ASCII", () => {
    refused(parse({ ...good, m: 3 }), /^m: not a string/);
    for (const m of ["café", "a\nb", "a\u0000", "\u007f"]) refused(parse({ ...good, m }), /^m: not printable ASCII/);
  });
  it("kid: 32 lower-case hex digits", () => {
    for (const kid of ["0".repeat(31), "0".repeat(33), "A".repeat(32), "g".repeat(32), 7])
      refused(parse({ ...good, kid }), /^kid: not 32 lower-case hex digits/);
  });
  it("sig: 64 bytes in canonical base64url, no padding, no other alphabet", () => {
    const sig = new Uint8Array(64).fill(0xfb); // base64 "+" and "/" in the standard alphabet
    expect(parse({ ...good, sig: b64url(sig) }).ok).toBe(true);
    for (const s of [
      Buffer.from(sig).toString("base64"), // the standard alphabet, padded
      `${b64url(sig)}=`,
      b64url(new Uint8Array(63)),
      b64url(new Uint8Array(65)),
      `${b64url(new Uint8Array(64)).slice(0, -1)}B`, // the last character's unused bits not zero
      b64url(new Uint8Array(72)), // a DER signature's length
      7,
    ])
      refused(parse({ ...good, sig: s }), /^sig: not 64 bytes in base64url/);
  });
});

describe("the manifest's form: closed, schema 1, one text", () => {
  const b = live(5);
  const bytes = bytesOf(b);
  const M = manifestFor(bytes, b);
  const text = manifestText(M);
  it("its one text: JSON.stringify of the fields in order", () => {
    expect(Object.keys(JSON.parse(text))).toEqual([...MANIFEST_FIELDS]);
    expect(text).toBe(JSON.stringify(M));
    expect(parseManifest(text)).toEqual({ ok: true, value: M });
  });
  it("anything else written for the same values is refused: spaces, another order, a key twice, 5.0, a string", () => {
    for (const m of [
      text.replace(/,/g, ", "),
      text.replace("{", "{ "),
      JSON.stringify(Object.fromEntries(Object.entries(M).reverse())), // the same fields, another order
      text.replace('"version":5', '"version":5,"version":5'),
      text.replace('"version":5', '"version":6,"version":5'),
      text.replace('"version":5', '"version":5.0'),
      text.replace('"version":5', '"version":5e0'),
    ])
      refused(parseManifest(m), /^m: not written as its one text/);
    refused(parseManifest(text.replace('"version":5', '"version":"5"')), /^m\.version: not a counter/);
    refused(parseManifest(JSON.stringify(M, null, 1)), /^m: not printable ASCII/); // its line ends
  });
  it("closed: an unknown field, a missing one", () => {
    refused(parseManifest(JSON.stringify({ ...M, minEngine: 1 })), /^m: unknown field "minEngine"/);
    for (const k of MANIFEST_FIELDS) {
      const o: J = { ...M };
      delete o[k];
      refused(parseManifest(JSON.stringify(o)), new RegExp(`^m: missing field "${k}"`));
    }
  });
  it("each field's form", () => {
    const one = (over: J) => parseManifest(JSON.stringify({ ...M, ...over }));
    refused(one({ format: "sixkey-rules" }), /^m\.format: not "sixkey-rules-manifest"/);
    for (const schema of [2, 0, "1"]) refused(one({ schema }), /^m\.schema: not 1/);
    for (const version of [0, -1, 1.5, 2 ** 53]) refused(one({ version }), /^m\.version: not a counter from 1/);
    for (const t of [
      "2026-11-06T12:00:00.000Z",
      "2026-11-06T12:00:00+00:00",
      "2026-11-06 12:00:00Z",
      "2026-11-06T12:00Z",
      "2026-11-06",
    ])
      refused(one({ created: t }), /^m\.created: not a UTC time/);
    for (const t of ["2026-02-30T12:00:00Z", "2026-11-06T24:00:00Z", "2026-13-01T00:00:00Z"])
      refused(one({ expires: t }), /^m\.expires: not a calendar time/);
    for (const s of ["A".repeat(64), "0".repeat(63), 5]) refused(one({ sha256: s }), /^m\.sha256: not 64/);
    for (const size of [0, BOUNDS.bundle + 1, 1.5, "9"]) refused(one({ size }), /^m\.size: not 1 to 524288/);
    expect(one({ size: BOUNDS.bundle }).ok).toBe(true);
    refused(one({ source: "x".repeat(301) }), /^m\.source/);
    refused(one({ license: 3 }), /^m\.license/);
  });
});

describe("1. the key and the signature", () => {
  it("a key this build does not pin is refused, whatever it signed", async () => {
    refused(await run(X, 5), /^kid: not a key this build pins/);
    expect((await run(X, 5, null, ctx({ pinned: await pin(X) }))).ok).toBe(true);
  });
  it("a manifest changed after signing, a changed signature, another pinned key's kid: refused", async () => {
    const b = live(5);
    const bytes = bytesOf(b);
    const m = manifestText(manifestFor(bytes, b));
    const sig = await sign(A, signedBytes(m));
    // m tampered (still its one text): another version, another hash
    for (const t of [m.replace('"version":5', '"version":6'), m.replace(/"sha256":"./, '"sha256":"0')])
      refused(await checkSigned(signedFile(t, A.kid, sig), bytes, null, ctx(), C), /^sig: does not verify/);
    const flipped = sig.slice();
    flipped[10] = flipped[10]! ^ 1;
    refused(await checkSigned(signedFile(m, A.kid, flipped), bytes, null, ctx(), C), /^sig: does not verify/);
    // signed by A, said to be B's (B pinned too): verified with B's key, and refused
    refused(await checkSigned(signedFile(m, B.kid, sig), bytes, null, ctx(), C), /^sig: does not verify/);
    // nothing of the manifest is read before its signature: an unreadable m is refused for its signature first
    refused(
      await checkSigned(signedFile("{}", A.kid, sig), bytes, null, ctx(), C),
      /^sig: does not verify with the pinned key/,
    );
  });
});

describe("2. the times, each bound on both sides", () => {
  const at = (created: number, expires: number, now = T0) =>
    run(A, 5, null, ctx({ now }), { created: iso(created), expires: iso(expires) });
  it("created ≤ now + 1 day", async () => {
    expect((await at(T0 + DAY, T0 + 30 * DAY)).ok).toBe(true);
    refused(await at(T0 + DAY + 1000, T0 + 30 * DAY), /^m\.created: more than a day after this clock's time/);
  });
  it("created < expires", async () => {
    expect((await at(T0 - 1000, T0 + 1000)).ok).toBe(true);
    refused(await at(T0, T0, T0 - 1), /^m\.expires: not after created/);
    refused(await at(T0 + 1000, T0, T0 - 1), /^m\.expires: not after created/);
  });
  it("expires − created ≤ 180 days", async () => {
    expect((await at(T0, T0 + 180 * DAY)).ok).toBe(true);
    refused(await at(T0, T0 + 180 * DAY + 1000), /^m\.expires: more than 180 days after created/);
    refused(await at(T0, T0 + 400 * DAY), /^m\.expires: more than 180 days after created/);
  });
  it("now < expires", async () => {
    expect((await at(T0 - DAY, T0 + 1000, T0 + 999)).ok).toBe(true);
    refused(await at(T0 - DAY, T0 + 1000, T0 + 1000), /^m\.expires: passed/);
  });
});

describe("3. the version", () => {
  it("baseline < version ≤ baseline + 1,000", async () => {
    refused(await run(A, 7, null, ctx({ baseline: 7 })), /^m\.version: not above the built-in rules' version 7/);
    expect((await run(A, 8, null, ctx({ baseline: 7 }))).ok).toBe(true);
    expect((await run(A, 1007, null, ctx({ baseline: 7 }))).ok).toBe(true);
    refused(
      await run(A, 1008, null, ctx({ baseline: 7 })),
      /^m\.version: more than 1000 above the built-in rules' version 7/,
    );
  });
  it("above its key's floor: an older or the same bundle replayed is refused", async () => {
    const rec = ok(await run(A, 10)).record;
    refused(await run(A, 10, rec), /^m\.version: not above 10, the last version accepted from this key/);
    refused(await run(A, 9, rec), /^m\.version: not above 10/);
    expect(ok(await run(A, 11, rec)).record.version).toBe(11);
    // the floor counts whatever the baseline says, and the baseline whatever the floor says
    refused(await run(A, 10, rec, ctx({ baseline: 3 })), /^m\.version: not above 10/);
    refused(await run(A, 12, rec, ctx({ baseline: 12 })), /^m\.version: not above the built-in rules' version 12/);
  });
});

describe("4. the bundle", () => {
  it("exactly `size` bytes, at most 512 KiB", async () => {
    const b = live(5);
    // a bundle of exactly 512 KiB (padded with JSON's own whitespace): accepted
    const base = `${JSON.stringify(b)}`;
    const full = enc(base + " ".repeat(BOUNDS.bundle - base.length));
    expect(full.length).toBe(BOUNDS.bundle);
    expect((await checkSigned(await signed(A, full, b), full, null, ctx(), C)).ok).toBe(true);
    // one byte more, with the manifest saying 512 KiB: refused for its size
    const over = enc(base + " ".repeat(BOUNDS.bundle + 1 - base.length));
    refused(
      await checkSigned(await signed(A, over, b, { size: BOUNDS.bundle }), over, null, ctx(), C),
      /^bundle: larger than 524288 bytes/,
    );
    // the manifest's size one more or one less than the bundle's
    const bytes = bytesOf(b);
    for (const size of [bytes.length + 1, bytes.length - 1])
      refused(
        await checkSigned(await signed(A, bytes, b, { size }), bytes, null, ctx(), C),
        new RegExp(`^bundle: not ${size} bytes, as the manifest says`),
      );
  });
  it("its SHA-256 is the manifest's", async () => {
    const b = live(5);
    const bytes = bytesOf(b);
    const file = await signed(A, bytes, b);
    const other = bytes.slice();
    other[other.length - 1] = 0x20; // the final newline made a space: the same size, still JSON
    expect(JSON.parse(new TextDecoder().decode(other)).version).toBe(5);
    refused(await checkSigned(file, other, null, ctx(), C), /^bundle: its SHA-256 is not the manifest's/);
  });
  it("ASCII text, JSON, and a live bundle the format's checker accepts", async () => {
    const b = live(5);
    const at = async (text: string) => {
      const bytes = enc(text);
      return checkSigned(await signed(A, bytes, b), bytes, null, ctx(), C);
    };
    refused(await at(JSON.stringify(b).replace("input#otp", "input#ötp")), /^bundle: not ASCII text/);
    refused(await at(`${JSON.stringify(b)}\u0001`), /^bundle: not ASCII text/);
    refused(await at(JSON.stringify(b).slice(1)), /^bundle: not JSON/);
    // M1: a live bundle never carries aliases, appends or upstream files, even empty
    for (const k of ["aliases", "appends", "upstream"])
      refused(
        await at(JSON.stringify({ ...b, [k]: [] })),
        new RegExp(`^bundle: bundle: a live bundle carries no "${k}": they ship with releases only`),
      );
    refused(await at(JSON.stringify({ ...b, kind: "baseline" })), /^bundle: bundle\.kind: not "live"/);
    refused(
      await at(JSON.stringify({ ...b, hosts: { "github.io": "a" } })),
      /^bundle: bundle\.hosts\["github\.io"\]: "github\.io" is a shared suffix/,
    );
    refused(await at(JSON.stringify({ ...b, source: "" })), /^bundle: bundle\.source: not an https address/);
  });
  it("its version, source and licence are the manifest's", async () => {
    const b = live(5);
    const bytes = bytesOf(b);
    refused(
      await checkSigned(await signed(A, bytes, b, { version: 6 }), bytes, null, ctx(), C),
      /^bundle\.version: not the manifest's \(6\)/,
    );
    refused(
      await checkSigned(await signed(A, bytes, b, { source: "https://example.org/x" }), bytes, null, ctx(), C),
      /^bundle\.source: not the manifest's/,
    );
    refused(
      await checkSigned(await signed(A, bytes, b, { license: "MIT" }), bytes, null, ctx(), C),
      /^bundle\.license: not the manifest's/,
    );
  });
  it("the format's checker is passed in, with its options: reserved names only when the caller allows them", async () => {
    const b = live(5, (x) => (x.hosts = { "login.rules.test": "a" }));
    const bytes = bytesOf(b);
    const file = await signed(A, bytes, b);
    refused(await checkSigned(file, bytes, null, ctx(), C), /is a reserved name/);
    expect((await checkSigned(file, bytes, null, ctx(), { ...C, options: { allowReserved: true } })).ok).toBe(true);
  });
});

describe("the record: floor, succession, retirement", () => {
  it("a bundle of the later key is compared with the baseline only, and retires every earlier key", async () => {
    const a = ok(await run(A, 40)).record;
    // B's version 2 is below A's floor (40) and above the baseline: accepted, and A retired
    const b = ok(await run(B, 2, a)).record;
    expect(b).toMatchObject({ kid: B.kid, version: 2, retired: [A.kid] });
    // from then on A is refused whatever its version; B is held to its own floor
    refused(await run(A, 41, b), /^kid: a key retired on this client/);
    refused(await run(B, 2, b), /^m\.version: not above 2/);
    expect(ok(await run(B, 3, b)).record).toMatchObject({ kid: B.kid, version: 3, retired: [A.kid] });
  });
  it("a fresh client's first bundle from the later key retires the earlier one too", async () => {
    const r = ok(await run(B, 5)).record;
    expect(r.retired).toEqual([A.kid]);
    refused(await run(A, 6, r), /^kid: a key retired on this client/);
  });
  it("a key before the record's is retired even if the stored list lost it", async () => {
    const r: LiveRecord = { ...ok(await run(B, 5)).record, retired: [] };
    refused(await run(A, 6, r), /^kid: a key retired on this client/);
  });
  it("a record whose key is no longer pinned is deleted at the next read, floor and all", async () => {
    const a = ok(await run(A, 40)).record;
    // the next release pins [B, C]: A's record is gone, and B's version 2 is compared with the baseline only
    const C2 = await newKey();
    const BC = await pin(B, C2);
    expect(readRecord(a, ctx({ pinned: BC }))).toEqual({ record: null, changed: true });
    expect(ok(await run(B, 2, a, ctx({ pinned: BC }))).record).toMatchObject({ kid: B.kid, version: 2, retired: [] });
    // and with A still pinned its floor stays
    expect(readRecord(a, ctx()).record).toMatchObject({ kid: A.kid, version: 40 });
    refused(await run(A, 40, a), /^m\.version: not above 40/);
  });
  it("a retired key after the record's own in the pinned order is dropped from the list, not the record (N10)", async () => {
    const a = ok(await run(A, 5)).record;
    const bad = { ...a, retired: [B.kid] }; // no function here makes it: B comes after A
    expect(readRecord(bad, ctx())).toEqual({ record: { ...a, retired: [] }, changed: true });
    // so B can still take over: its bundle is accepted, and retires A
    expect(ok(await run(B, 3, bad)).record).toMatchObject({ kid: B.kid, version: 3, retired: [A.kid] });
  });
  it("a retired key that is no longer pinned is forgotten; one still pinned is kept", async () => {
    const b = ok(await run(B, 5)).record; // retired [A]
    const C2 = await newKey();
    expect(readRecord(b, ctx({ pinned: await pin(B, C2) }))).toMatchObject({
      record: { kid: B.kid, retired: [] },
      changed: true,
    });
    expect(readRecord(b, ctx())).toMatchObject({ record: { kid: B.kid, retired: [A.kid] }, changed: false });
  });
  it("a record whose own key is retired, or that is not a record, is deleted", () => {
    const rec = { kid: A.kid, version: 4, retired: [A.kid], held: null };
    expect(readRecord(rec, ctx())).toEqual({ record: null, changed: true });
    const good = { kid: A.kid, version: 4, retired: [], held: null };
    expect(readRecord(good, ctx())).toEqual({ record: good, changed: false });
    for (const bad of [
      { ...good, extra: 1 },
      { ...good, kid: "x" },
      { ...good, version: 0 },
      { ...good, version: 1.5 },
      { ...good, retired: [B.kid, B.kid] },
      { ...good, retired: "x" },
      { ...good, held: { text: "{}" } },
      { ...good, held: { text: "{}", expires: "soon" } },
      { ...good, held: { text: 3, expires: iso(T0) } },
      [],
      "x",
    ])
      expect(readRecord(bad, ctx()), JSON.stringify(bad)).toEqual({ record: null, changed: true });
    expect(readRecord(null, ctx())).toEqual({ record: null, changed: false });
    expect(readRecord(undefined, ctx())).toEqual({ record: null, changed: false });
  });
  it("a refusal leaves nothing to keep: the stored record stays as it was", async () => {
    const a = ok(await run(A, 10)).record;
    const before = JSON.stringify(a);
    const r = await run(A, 9, a);
    expect(r.ok).toBe(false);
    expect("value" in r).toBe(false);
    expect(JSON.stringify(a)).toBe(before);
  });
});

describe("the held bundle: expiry, a newer release, the switch", () => {
  it("in use while unexpired and above the built-in rules", async () => {
    const r = ok(await run(A, 5)).record;
    const b = heldBundle(r, ctx(), C);
    expect(b?.version).toBe(5);
    expect(b?.kind).toBe("live");
    expect(heldBundle(r, ctx({ now: T0 + 120 * DAY - 1 }), C)?.version).toBe(5);
  });
  it("expired: the bundle is deleted at the next read and its floor stays (M3 NIT b)", async () => {
    const r = ok(await run(A, 5)).record;
    const later = ctx({ now: T0 + 120 * DAY });
    expect(heldBundle(r, later, C)).toBeNull();
    const read = readRecord(r, later);
    expect(read).toEqual({ record: { kid: A.kid, version: 5, retired: [], held: null }, changed: true });
    // the floor still counts: version 5 again (re-signed, unexpired) is refused, 6 accepted
    const now = { now: T0 + 121 * DAY };
    refused(
      await run(A, 5, read.record, ctx(now), { created: iso(now.now), expires: iso(now.now + DAY) }),
      /not above 5/,
    );
    expect((await run(A, 6, read.record, ctx(now), { created: iso(now.now), expires: iso(now.now + DAY) })).ok).toBe(
      true,
    );
  });
  it("a release whose built-in bundle is as new: the download is deleted, the floor stays", async () => {
    const r = ok(await run(A, 5)).record;
    expect(heldBundle(r, ctx({ baseline: 5 }), C)).toBeNull();
    expect(readRecord(r, ctx({ baseline: 5 }))).toEqual({
      record: { kid: A.kid, version: 5, retired: [], held: null },
      changed: true,
    });
    expect(readRecord(r, ctx({ baseline: 4 })).changed).toBe(false);
  });
  it("turned off: the bundle deleted, the floor and the retired keys kept (M3 NIT c); off and on is no fresh install", async () => {
    const b = ok(await run(B, 7)).record; // retired [A]
    const off = switchedOff(b);
    expect(off).toEqual({ kid: B.kid, version: 7, retired: [A.kid], held: null });
    expect(heldBundle(off, ctx(), C)).toBeNull();
    refused(await run(B, 7, off), /^m\.version: not above 7/);
    refused(await run(A, 8, off), /^kid: a key retired on this client/);
    expect(switchedOff(null)).toBeNull();
    expect(switchedOff({ ...b, kid: "x" })).toBeNull();
    // it reads no pinned list: a record whose key is no longer pinned keeps its floor too, for the next read to judge
    const C2 = await newKey();
    expect(switchedOff({ ...b, kid: C2.kid })).toEqual({ kid: C2.kid, version: 7, retired: [A.kid], held: null });
  });
  it("no key pinned at all (a list that failed to load): no record used, none deleted (the review's N3)", async () => {
    const b = ok(await run(B, 7)).record;
    expect(readRecord(b, ctx({ pinned: [] }))).toEqual({ record: null, changed: false });
    expect(readRecord({ junk: 1 }, ctx({ pinned: [] }))).toEqual({ record: null, changed: false });
    expect(heldBundle(b, ctx({ pinned: [] }), C)).toBeNull();
    refused(await run(B, 8, b, ctx({ pinned: [] })), /^kid: not a key this build pins/);
    // and with the keys back, the record and its floor are there
    expect(readRecord(b, ctx())).toMatchObject({ record: { kid: B.kid, version: 7 }, changed: false });
  });
  it("a held text that is no longer a live bundle of the record's version is not used", async () => {
    const r = ok(await run(A, 5)).record;
    for (const text of ["{", JSON.stringify(live(6)), JSON.stringify({ ...live(5), aliases: [] }), "ü"])
      expect(heldBundle({ ...r, held: { ...r.held!, text } }, ctx(), C), text).toBeNull();
  });
});

describe("the pinned keys", () => {
  it("each exactly {kid, spki}: a P-256 key in canonical base64, its kid its own, no key twice, at most two", async () => {
    expect((await importPinned([])).ok).toBe(true);
    expect((await importPinned([A, B].map(({ kid, spki }) => ({ kid, spki })))).ok).toBe(true);
    const e = async (list: unknown, why: RegExp) => refused(await importPinned(list), why);
    await e("x", /^keys: not a list/);
    await e(
      [A, B, X].map(({ kid, spki }) => ({ kid, spki })),
      /^keys: more than 2 keys/,
    );
    await e([{ kid: A.kid, spki: A.spki, x: 1 }], /^keys\[0\]: unknown field "x"/);
    await e([{ kid: A.kid }], /^keys\[0\]: missing field "spki"/);
    await e([{ kid: B.kid, spki: A.spki }], /^keys\[0\]\.kid: not the key id of its key/);
    await e([{ kid: A.kid.toUpperCase(), spki: A.spki }], /^keys\[0\]\.kid: not 32 lower-case hex/);
    await e([{ kid: A.kid, spki: A.spki.replace(/=+$/, "") }], /^keys\[0\]\.spki: not base64/);
    // one key, one form (the review's S2): its point uncompressed, 91 bytes, the fixed prefix; the compressed form of the
    // same key (another kid) is refused, so a key cannot be listed twice under two kids, nor a test key slip in so
    for (const T of TEST_RULES_KEYS) {
      const c = compressed(T.spki);
      expect(c.length).toBe(59);
      await e(
        [{ kid: await kidOf(c), spki: b64(c) }],
        /^keys\[0\]\.spki: not a P-256 key's SubjectPublicKeyInfo with its point uncompressed/,
      );
      await e(
        [T, { kid: await kidOf(c), spki: b64(c) }],
        /^keys\[1\]\.spki: not a P-256 key's SubjectPublicKeyInfo with its point uncompressed/,
      );
    }
    // the prefix's bytes, and the length, exactly
    const der = new Uint8Array(Buffer.from(A.spki, "base64"));
    const other = der.slice();
    other[5] = other[5]! ^ 1;
    await e(
      [{ kid: await kidOf(other), spki: b64(other) }],
      /^keys\[0\]\.spki: not a P-256 key's SubjectPublicKeyInfo/,
    );
    const longer = new Uint8Array([...der, 0]);
    await e(
      [{ kid: await kidOf(longer), spki: b64(longer) }],
      /^keys\[0\]\.spki: not a P-256 key's SubjectPublicKeyInfo/,
    );
    expect(Buffer.from(der.subarray(0, 27)).toString("hex")).toBe(P256_SPKI_PREFIX);
    // the right form around a point that is not on the curve: refused by the import
    const off = der.slice();
    off[90] = off[90]! ^ 1;
    await e([{ kid: await kidOf(off), spki: b64(off) }], /^keys\[0\]\.spki: not a P-256 public key/);
    // the test key's SPKI has "+" and "/" in it: written with base64url's alphabet instead, it is refused
    const T = TEST_RULES_KEYS[0]!;
    expect(T.spki).toMatch(/\+/);
    expect(T.spki).toMatch(/\//);
    await e([{ kid: T.kid, spki: T.spki.replace(/\+/g, "-").replace(/\//g, "_") }], /^keys\[0\]\.spki: not base64/);
    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" }).publicKey.export({ type: "spki", format: "der" });
    const ed = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
    for (const der of [p384, ed])
      await e(
        [{ kid: await kidOf(new Uint8Array(der)), spki: der.toString("base64") }],
        /^keys\[0\]\.spki: not a P-256/,
      );
    await e(
      [
        { kid: A.kid, spki: A.spki },
        { kid: A.kid, spki: A.spki },
      ],
      /^keys\[1\]\.kid: a key listed twice/,
    );
  });
  it("kid: the first 16 bytes of the SHA-256 of the SPKI, in hex; the test keys' entries are their files' public halves", async () => {
    const dir = join(EXT, "test/fixtures/rules-keys");
    const files = ["test-only-current.pem", "test-only-next.pem"];
    const derived = await Promise.all(
      files.map(async (f) => {
        const der = createPublicKey(createPrivateKey(readFileSync(join(dir, f), "utf8"))).export({
          type: "spki",
          format: "der",
        });
        expect(await kidOf(new Uint8Array(der))).toBe(sha(der).slice(0, 32));
        return { kid: await kidOf(new Uint8Array(der)), spki: der.toString("base64") };
      }),
    );
    expect(TEST_RULES_KEYS).toEqual(derived);
    expect((await importPinned(TEST_RULES_KEYS)).ok).toBe(true);
    for (const T of TEST_RULES_KEYS) expect(Buffer.from(T.spki, "base64")).toHaveLength(91);
    for (const f of files)
      expect(readFileSync(join(dir, f), "utf8")).toMatch(/^TEST-ONLY KEY \("(current|next)"\), NOT A SECRET/);
  });
});

describe("pure: WebCrypto only, nothing imported at run time", () => {
  it("signed.ts imports types only, and touches no network, storage or extension API", () => {
    const src = readFileSync(join(EXT, "src/core/rules/signed.ts"), "utf8");
    const imports = src.split("\n").filter((l) => /^\s*import\b/.test(l));
    expect(imports).toEqual([
      'import type { Bundle, Checked, HostChecks, Options, validate as Validate } from "./format";',
    ]);
    const code = src
      .split("\n")
      .filter(
        (l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"),
      )
      .join("\n");
    for (const re of [
      /\bfetch\b/,
      /indexedDB/,
      /\bchrome\./,
      /XMLHttpRequest/,
      /localStorage/,
      /\bimport\(/,
      /\brequire\(/,
    ])
      expect(code, String(re)).not.toMatch(re);
    expect(code).toMatch(/crypto\.subtle\.verify\(/);
  });
});

describe("the JSON Schema (contract/rules/1/manifest.schema.json) says what signed.ts says", () => {
  const schema = JSON.parse(readFileSync(join(EXT, "../contract/rules/1/manifest.schema.json"), "utf8"));
  const m = schema.$defs.manifest;
  it("2020-12, its id, closed: the signed file's fields and the manifest's, all required, in the manifest's order", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("urn:sixkey:rules:1:manifest");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["m", "kid", "sig"]);
    expect(Object.keys(schema.properties)).toEqual(["m", "kid", "sig"]);
    expect(schema.properties.m.contentSchema).toEqual({ $ref: "#/$defs/manifest" });
    expect(m.additionalProperties).toBe(false);
    expect(m.required).toEqual([...MANIFEST_FIELDS]);
    expect(Object.keys(m.properties)).toEqual([...MANIFEST_FIELDS]);
    expect(m.properties.format.const).toBe("sixkey-rules-manifest");
    expect(m.properties.schema.const).toBe(1);
    expect(m.properties.size.maximum).toBe(BOUNDS.bundle);
    expect(m.properties.source.maxLength).toBe(BOUNDS.source);
    expect(m.properties.license.maxLength).toBe(BOUNDS.license);
  });
  it("its patterns judge samples as the checker does", () => {
    const re = (p: { pattern: string }) => new RegExp(p.pattern, "u");
    const file = (o: J) =>
      parseSigned(JSON.stringify({ m: "{}", kid: "0".repeat(32), sig: b64url(new Uint8Array(64)), ...o }));
    for (const kid of ["0".repeat(32), "a".repeat(32), "A".repeat(32), "0".repeat(31), "g".repeat(32)])
      expect(re(schema.properties.kid).test(kid), kid).toBe(file({ kid }).ok);
    for (const sig of [
      b64url(new Uint8Array(64)),
      b64url(new Uint8Array(64).fill(0xff)),
      `${b64url(new Uint8Array(64)).slice(0, -1)}B`,
      `${b64url(new Uint8Array(64))}=`,
      b64url(new Uint8Array(63)),
    ])
      expect(re(schema.properties.sig).test(sig), sig).toBe(file({ sig }).ok);
    for (const s of ["{}", "café", "a\nb", "~ !"]) expect(re(schema.properties.m).test(s), s).toBe(file({ m: s }).ok);
    const b = live(5);
    const M = manifestFor(bytesOf(b), b);
    for (const t of ["2026-11-06T12:00:00Z", "2026-11-06T12:00:00.000Z", "2026-11-06 12:00:00Z"])
      expect(re(schema.$defs.time).test(t), t).toBe(parseManifest(JSON.stringify({ ...M, created: t })).ok);
    for (const h of ["0".repeat(64), "A".repeat(64), "0".repeat(63)])
      expect(re(m.properties.sha256).test(h), h).toBe(parseManifest(JSON.stringify({ ...M, sha256: h })).ok);
  });
});
