#!/usr/bin/env node
// Sixkey Phase 1 M0: known-answer vector generator (docs/SYNC-DESIGN.md §2.2–§3.14, §4.1, §5.2, §8.1).
//
// A separate reference implementation on Node WebCrypto. It imports nothing from extension/src. Separate code is not
// independent authorship: this file, contract/py and the extension were written in the same AI-assisted process from
// the same design, so a misreading of the design they share would not show up here (contract/M0-NOTES.md,
// "Caveats on independence").
// node:crypto is used for one thing only: turning a fixed test private scalar into its public point.
//
//   node contract/tools/gen-vectors.mjs           write contract/vectors/sync-v1.json
//   node contract/tools/gen-vectors.mjs --check   recompute everything and fail if the file differs (writes nothing)
//
// ECDSA signatures are randomized. An existing signature is kept when it still verifies for the same key and
// signing input, so reruns do not churn the file. Every input is a fixed, obviously fake test value.
import { createECDH } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const subtle = globalThis.crypto.subtle;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "contract", "vectors", "sync-v1.json");
const CHECK = process.argv.includes("--check");
const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;

// ---------------------------------------------------------------------------------------------------- bytes

const te = new TextEncoder();
const utf8 = (s) => te.encode(s);
const hex = (b) => Buffer.from(b).toString("hex");
const fromHex = (h) => new Uint8Array(Buffer.from(h, "hex"));
const b64 = (b) => Buffer.from(b).toString("base64");
const fromB64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const b64u = (b) => Buffer.from(b).toString("base64url"); // RFC 4648 §5, no padding
const fill = (byte, n) => new Uint8Array(n).fill(byte);
const seq = (start, n) => Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);
const EMPTY = new Uint8Array(0);

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function assert(cond, msg) {
  if (!cond) throw new Error(`generator self-check failed: ${msg}`);
}

/** Strict base64url: alphabet [A-Za-z0-9_-], no padding, length % 4 != 1, canonical trailing bits. */
function fromB64uStrict(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error("bad base64url");
  const b = new Uint8Array(Buffer.from(s, "base64url"));
  if (b64u(b) !== s) throw new Error("non-canonical base64url");
  return b;
}

/** Phase 0 standard base64 rules (core/crypto/bytes.ts fromB64): padding required, strict alphabet. */
function fromB64Phase0(s) {
  if (typeof s !== "string" || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error("bad base64");
  return new Uint8Array(Buffer.from(atob(s), "latin1"));
}

// ---------------------------------------------------------------------------------------------------- primitives

async function sha256(...parts) {
  return new Uint8Array(await subtle.digest("SHA-256", concat(...parts)));
}

async function hkdf(ikm, salt, info, bits) {
  const base = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: utf8(info) }, base, bits));
}

async function hmac(key, data) {
  const k = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, data));
}

async function pbkdf2(password, salt, iterations, bits) {
  const base = await subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, bits));
}

async function gcmEncrypt(key, iv, plaintext, aad) {
  const k = await subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  return new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, k, plaintext),
  );
}

async function gcmOpens(key, iv, ciphertext, aad) {
  const k = await subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  try {
    await subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, k, ciphertext);
    return true;
  } catch {
    return false;
  }
}

/** WebCrypto hazard the labels guard against: deriveKey(AES-256) exported equals deriveBits(256) for one info. */
async function deriveKeyAesExport(ikm, info) {
  const base = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  const k = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: EMPTY, info: utf8(info) },
    base,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"],
  );
  return new Uint8Array(await subtle.exportKey("raw", k));
}

/** deriveKey(HMAC-SHA-256) with no length gives a 512-bit key (the hash block size), not 256. */
async function deriveKeyHmacDefaultExport(ikm, info) {
  const base = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  const k = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: EMPTY, info: utf8(info) },
    base,
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign"],
  );
  return new Uint8Array(await subtle.exportKey("raw", k));
}

/** Phase 0 canonicalJson (core/vault/merge.ts), restricted to safe integers so every language agrees. */
function canonicalJson(v) {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("canonicalJson: only safe integers are cross-language stable");
    return JSON.stringify(v);
  }
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
    .join(",")}}`;
}

const truncHour = (ms) => Math.floor(ms / 3_600_000) * 3_600_000;
const truncDay = (ms) => Math.floor(ms / 86_400_000) * 86_400_000;
const truncMinute = (ms) => Math.floor(ms / 60_000) * 60_000;
const ceilMinute = (ms) => Math.ceil(ms / 60_000) * 60_000; // enrollments.expires_at (§5.3, §0.0o A13)

async function sixDigits(prefix, h) {
  const d = await sha256(utf8(prefix), h);
  const u32 = new DataView(d.buffer).getUint32(0, false);
  return { u32, code: String(u32 % 1_000_000).padStart(6, "0") };
}

// ---------------------------------------------------------------------------------------------------- EC P-256

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const SPKI_P256_PREFIX = fromHex("3059301306072a8648ce3d020106082a8648ce3d030107034200");
const SPKI_P256_COMPRESSED_PREFIX = fromHex("3039301306072a8648ce3d020106082a8648ce3d030107032200");
const SPKI_P384_PREFIX = fromHex("3076301006072a8648ce3d020106052b81040022036200");

function ecFixed(dByte, curve = "prime256v1", size = 32) {
  const d = fill(dByte, size);
  const e = createECDH(curve);
  e.setPrivateKey(Buffer.from(d));
  const point = new Uint8Array(e.getPublicKey(null, "uncompressed"));
  return { d, point, x: point.slice(1, 1 + size), y: point.slice(1 + size) };
}

const jwk = (k) => ({ kty: "EC", crv: "P-256", d: b64u(k.d), x: b64u(k.x), y: b64u(k.y) });

async function ecdh(own, peerPoint) {
  const priv = await subtle.importKey("jwk", jwk(own), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const pub = await subtle.importKey("raw", peerPoint, { name: "ECDH", namedCurve: "P-256" }, true, []);
  return new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256));
}

async function spkiOf(point) {
  const pub = await subtle.importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  return new Uint8Array(await subtle.exportKey("spki", pub));
}

async function ecdsaSign(k, msg) {
  const key = await subtle.importKey("jwk", jwk(k), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, msg)); // IEEE P1363 r||s
}

async function ecdsaVerify(spki, sig, msg) {
  const key = await subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, msg);
}

const toBig = (b) => BigInt(`0x${hex(b) || "0"}`);

/** Server-side format check before P1363 -> DER (§5.1 wire.py): exactly 64 bytes, 0 < r, s < n. */
function p1363FormatOk(sig) {
  if (sig.length !== 64) return false;
  const r = toBig(sig.slice(0, 32));
  const s = toBig(sig.slice(32));
  return r > 0n && r < P256_N && s > 0n && s < P256_N;
}

function derInt(b) {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  let v = b.slice(i);
  if (v[0] & 0x80) v = concat(Uint8Array.of(0), v);
  return concat(Uint8Array.of(0x02, v.length), v);
}

function p1363ToDer(sig) {
  if (sig.length !== 64) throw new Error("P1363 signature must be 64 bytes");
  const body = concat(derInt(sig.slice(0, 32)), derInt(sig.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

/** §2.2: epk is always the 65-byte uncompressed point; dpk is always SPKI DER of such a point. */
function epkFormatOk(raw) {
  return raw.length === 65 && raw[0] === 0x04;
}
function dpkFormatOk(spki) {
  return spki.length === 91 && hex(spki.slice(0, 26)) === hex(SPKI_P256_PREFIX) && spki[26] === 0x04;
}
async function pointImports(raw) {
  try {
    await subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, true, []);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------- Phase 0 pieces

// The 28-symbol code: 128-bit secret || 12 check bits, Crockford base32, 7 groups of 4. The check bits are the first 12
// bits of SHA-256(UTF-8(tag) || secret): the recovery code has the empty tag (Phase 0, unchanged), the pairing code
// 'sixkey-pairing-code|1|' (§3.2 MUST 10), so one typed where the other belongs fails its check bits.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAIRING_TAG = "sixkey-pairing-code|1|";
async function checkBits12(tag, secret) {
  const h = await sha256(utf8(tag), secret);
  return (BigInt(h[0]) << 4n) | BigInt(h[1] >> 4);
}
async function codeText(secret, tag) {
  assert(secret.length === 16, "a 28-symbol code holds 16 bytes");
  let n = (toBig(secret) << 12n) | (await checkBits12(tag, secret));
  let s = "";
  for (let i = 0; i < 28; i++) {
    s = CROCKFORD[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return s.match(/.{4}/g).join("-");
}
async function codeParse(input, tag, kind) {
  const s = input
    .toUpperCase()
    .replace(/[\s\-_]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (s.length !== 28) throw new Error(`${kind}_length`);
  let n = 0n;
  for (const ch of s) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) throw new Error(`${kind}_char`);
    n = (n << 5n) | BigInt(v);
  }
  const secret = fromHex((n >> 12n).toString(16).padStart(32, "0"));
  if ((await checkBits12(tag, secret)) !== (n & 0xfffn)) throw new Error(`${kind}_checksum`);
  return secret;
}
const recoveryCodeText = (secret) => codeText(secret, "");
const recoveryCodeParse = (input) => codeParse(input, "", "recovery");
const pairingCodeText = (secret) => codeText(secret, PAIRING_TAG);
const pairingCodeParse = (input) => codeParse(input, PAIRING_TAG, "pairing");

const vkIdOf = async (vk) => hex(await hkdf(vk, EMPTY, "sixkey/v1/vk-id", 64));

// ---------------------------------------------------------------------------------------------------- labels

const HKDF_LABELS = [
  {
    label: "sixkey/v1/vk-id",
    status: "existing",
    ikm: "VK",
    salt: "empty",
    bits: 64,
    use: "vkId fingerprint",
    section: "§2.2",
  },
  {
    label: "sixkey/v1/vault-enc",
    status: "existing",
    ikm: "VK",
    salt: "empty",
    bits: 256,
    use: "K_enc, AES-256-GCM vault key",
    section: "§2.2",
  },
  {
    label: "sixkey/v1/kek-device",
    status: "existing",
    ikm: "Phase 0 deviceKey",
    salt: "random 16 B",
    bits: 256,
    use: "Phase 0 device wrap KEK (never used by sync; listed so the distinctness check covers it)",
    section: "core/crypto/keyring.ts",
  },
  {
    label: "sixkey/v1/kek-recovery",
    status: "existing",
    ikm: "recovery secret (128 bit)",
    salt: "random 16 B",
    bits: 256,
    use: "recovery-code KEK",
    section: "§2.2",
  },
  {
    label: "sixkey/v1/kek-previous",
    status: "existing",
    ikm: "VK (new)",
    salt: "empty",
    bits: 256,
    use: "KEK wrapping previous VKs",
    section: "§2.2",
  },
  {
    label: "sixkey/v1/keybundle-mac",
    status: "new",
    ikm: "VK",
    salt: "empty",
    bits: 256,
    use: "K_mac, HMAC-SHA256 key for KeyBundle.mac",
    section: "§2.2, §2.3",
  },
  {
    label: "sixkey/v1/device-name",
    status: "new",
    ikm: "VK",
    salt: "empty",
    bits: 256,
    use: "K_name, AES-256-GCM key for device names",
    section: "§2.2, §2.4",
  },
  {
    label: "sixkey/v1/vault-write",
    status: "new",
    ikm: "VK",
    salt: "empty",
    bits: 256,
    use: "K_write, write-proof HMAC key (held by the server)",
    section: "§2.2, §5.2",
  },
  {
    label: "sixkey/v1/device-backup",
    status: "new",
    ikm: "VK",
    salt: "empty",
    bits: 256,
    use: "K_devbackup, AES-256-GCM key for sk_sync_cfg.enc",
    section: "§2.2, §2.5",
  },
  {
    label: "sixkey/v1/recovery-auth",
    status: "new",
    ikm: "recovery secret (128 bit)",
    salt: "empty",
    bits: 256,
    use: "recAuth (sent as recovery_auth)",
    section: "§2.2, §3.3",
  },
  {
    label: "sixkey/v1/password-auth",
    status: "new",
    ikm: "PBKDF2-SHA256(NFKC(pw), auth salt, iter, 256)",
    salt: "empty",
    bits: 256,
    use: "pw_auth (sent as password_auth)",
    section: "§2.2, §3.14",
  },
  {
    label: "sixkey/v2/enroll-key",
    status: "new",
    ikm: "Z || S: the ECDH P-256 shared secret Z (32 B), then the pairing secret S (16 B)",
    salt: "h (transcript hash, 32 B)",
    bits: 256,
    use: "K_enroll, AES-256-GCM key for the enrollment payload and name (enrolment v2, revision 27)",
    section: "§2.2, §3.2, §0.0aa",
  },
];

const DOMAIN_TAGS = [
  { tag: "sixkey-vault|1|", kind: "aes-gcm-aad", status: "existing", section: "§2.2" },
  { tag: "sixkey-wrap|1|", kind: "aes-gcm-aad", status: "existing", section: "§2.2" },
  { tag: "sixkey-prev|1|", kind: "aes-gcm-aad", status: "existing", section: "§2.2" },
  { tag: "sixkey-keybundle|1|", kind: "hmac-input-prefix", status: "new", section: "§2.2, §2.3" },
  { tag: "sixkey-devname|1|", kind: "aes-gcm-aad", status: "new", section: "§2.2, §2.4" },
  { tag: "sixkey-write|1|", kind: "hmac-input-prefix", status: "new", section: "§2.2, §5.2" },
  { tag: "sixkey-devkey|1|", kind: "aes-gcm-aad", status: "new", section: "§2.2, §2.5" },
  { tag: "sixkey-recovery-verifier|1|", kind: "sha256-prefix", status: "new", section: "§2.2" },
  { tag: "sixkey-password-verifier|1|", kind: "sha256-prefix", status: "new", section: "§2.2, §3.14" },
  { tag: "sixkey-enroll-commit|2|", kind: "sha256-prefix", status: "new", section: "§2.2, §3.2, §0.0aa" },
  { tag: "sixkey-enroll|2|", kind: "sha256-prefix", status: "new", section: "§2.2, §3.2, §0.0aa" },
  { tag: "sixkey/v2/enroll-sas|", kind: "sha256-prefix", status: "new", section: "§2.2, §3.2, §0.0aa" },
  { tag: "sixkey-pairing-code|1|", kind: "sha256-prefix", status: "new", section: "§2.2, §3.2 MUST 10, §0.0aa" },
  { tag: "sixkey-enroll-payload|2|", kind: "aes-gcm-aad", status: "new", section: "§2.2, §3.2, §0.0aa" },
  { tag: "sixkey-enroll-name|2|", kind: "aes-gcm-aad", status: "new", section: "§2.2, §3.2, §0.0aa" },
  { tag: "sixkey-req|1|", kind: "ecdsa-input-prefix", status: "new", section: "§2.2, §5.2" },
];

// ---------------------------------------------------------------------------------------------------- fixed test inputs

const VK0 = seq(0x40, 32); // an older VK, retired into VK1's previous list
const VK1 = seq(0x00, 32); // the current VK in most vectors
const VK2 = seq(0x20, 32); // the VK after a rotation
const VAULT_ID = "test-vault-0001";
const DEV_N = b64u(fill(0x11, 16)); // new device
const DEV_A = b64u(fill(0xaa, 16)); // approver
const DEV_S = b64u(fill(0x55, 16)); // an id invented by a hostile server
const RID = "00000000-0000-4000-8000-000000000001";
const RID_OTHER = "00000000-0000-4000-8000-000000000002";
const SUB = "00000000-0000-4000-8000-0000000000aa";
const NOW = 1792051594787; // an arbitrary instant, ms since the Unix epoch
const AT = truncHour(NOW);
const PASSWORD = "Sixkey test password 1";
const PASSWORD_FULLWIDTH = "Ｓｉｘｋｅｙ　ｔｅｓｔ　ｐａｓｓｗｏｒｄ　１"; // NFKC -> PASSWORD
const PASSWORD_LIGATURE = "Sixkey test password ﬁ"; // NFKC -> "... fi"
const ITER = 600_000;
const SALT_KEK = seq(0xd0, 16); // password wrap salt
const SALT_AUTH = seq(0xc0, 16); // KeyBundle.auth salt (must differ from the wrap salt, §2.3)
const RECOVERY_SECRET = seq(0xa0, 16);
const PAIRING_SECRET = seq(0x38, 16); // S, drawn by the approver at respond (§3.2 M2, MUST 10)
const SALT_RECOVERY = seq(0xb0, 16);
const N_N = fill(0x6e, 32); // N's enrollment nonce
const N_S = fill(0x73, 32); // a nonce invented by a hostile server
const iv = (n) => fill(n, 12);
const EMAIL = "alice@example.invalid";

const KEYS = {
  dsk_N: ecFixed(0x01), // N's device signing key
  dsk_A: ecFixed(0x02), // A's device signing key
  esk_N: ecFixed(0x03), // N's ephemeral ECDH key
  esk_A: ecFixed(0x04), // A's ephemeral ECDH key
  esk_S1: ecFixed(0x05), // hostile server's ephemeral key toward N
  esk_S2: ecFixed(0x06), // hostile server's ephemeral key toward A
  dsk_F: ecFixed(0x08), // the new signing key a cloned profile creates when it forks (§4.10)
};
const DEV_F = b64u(fill(0x66, 16)); // the new device id of that fork
const P384 = ecFixed(0x07, "secp384r1", 48);

// ---------------------------------------------------------------------------------------------------- groups

async function genLabels() {
  const labels = HKDF_LABELS.map((l) => l.label);
  const tags = DOMAIN_TAGS.map((t) => t.tag);
  assert(new Set(labels).size === labels.length, "HKDF labels pairwise distinct");
  assert(new Set([...labels, ...tags]).size === labels.length + tags.length, "labels and tags globally distinct");
  for (const a of tags)
    for (const b of tags) assert(a === b || !b.startsWith(a), `domain tag ${a} is a prefix of ${b}`);
  return {
    section: "§2.1, §2.2, §8.1",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib"],
    note: "Every HKDF info used anywhere in Sixkey, and every hash/MAC/AAD domain tag. WebCrypto deriveKey(AES-256) and deriveBits(256) give the same bytes for the same info (see vk_subkeys.webcrypto_hazard), so equal labels would hand K_enc to the server with K_write.",
    hkdf_info: HKDF_LABELS,
    domain_tags: DOMAIN_TAGS,
    assertions: {
      hkdf_info_pairwise_distinct: true,
      labels_and_tags_globally_distinct: true,
      domain_tags_prefix_free: true,
    },
  };
}

async function genBase64() {
  const enc = [
    "",
    "00",
    "0000",
    "000000",
    "fbff",
    "ffffff",
    "fbefbe",
    "00010203",
    hex(fill(0x11, 16)),
    hex(seq(0, 32)),
  ];
  const u = enc.map((h) => ({ hex: h, b64u: b64u(fromHex(h)) }));
  const s = enc.map((h) => ({ hex: h, b64: b64(fromHex(h)) }));
  const badU = [
    { input: "AA==", why: "padding is not used" },
    { input: "AAA=", why: "padding is not used" },
    { input: "A", why: "length % 4 == 1 is impossible" },
    { input: "AAAAA", why: "length % 4 == 1 is impossible" },
    { input: "AB", why: "non-canonical trailing bits (canonical form of 00 is AA)" },
    { input: "AAB", why: "non-canonical trailing bits (canonical form of 0000 is AAA)" },
    { input: "A+", why: "standard-alphabet character" },
    { input: "A/", why: "standard-alphabet character" },
    { input: "A A", why: "whitespace" },
    { input: "AA\n", why: "whitespace" },
    { input: "AA.", why: "not in the alphabet" },
  ];
  for (const c of u) assert(hex(fromB64uStrict(c.b64u)) === c.hex, "b64u round trip");
  for (const c of badU) {
    let threw = false;
    try {
      fromB64uStrict(c.input);
    } catch {
      threw = true;
    }
    assert(threw, `b64u reject ${JSON.stringify(c.input)}`);
  }
  const badS = [
    { input: "AA", why: "missing padding" },
    { input: "AAA", why: "missing padding" },
    { input: "AA=", why: "length % 4 != 0" },
    { input: "A===", why: "too much padding" },
    { input: "AA==AA==", why: "padding inside" },
    { input: "-_8=", why: "base64url alphabet" },
    { input: " AA=", why: "whitespace" },
  ];
  for (const c of badS) {
    let threw = false;
    try {
      fromB64Phase0(c.input);
    } catch {
      threw = true;
    }
    assert(threw, `b64 reject ${c.input}`);
  }
  const lenientS = [
    {
      input: "AB==",
      hex: "00",
      why: "non-canonical trailing bits are accepted by Phase 0 fromB64 (atob); M0 keeps that behaviour for standard base64",
    },
  ];
  for (const c of lenientS) assert(hex(fromB64Phase0(c.input)) === c.hex, "lenient b64");
  return {
    base64url: {
      section: "§2.2 (concatenated fields), §5.2 (Sixkey-Sig), §5.4 (IDs)",
      verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib"],
      rule: "RFC 4648 §5 alphabet, no padding. Decoding is strict: reject padding, other characters, length % 4 == 1, and any string that does not re-encode to itself (non-canonical trailing bits). §2.2 (§0.0d N19).",
      encode: u,
      decode_reject: badU,
    },
    base64: {
      section: "§5.4 (all other byte fields), Phase 0 core/crypto/bytes.ts",
      verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib"],
      rule: "RFC 4648 §4 alphabet with padding, Phase 0 fromB64 rules: length % 4 == 0 and /^[A-Za-z0-9+/]*={0,2}$/.",
      encode: s,
      decode_reject: badS,
      decode_accept_noncanonical: lenientS,
    },
  };
}

async function genCanonicalJson() {
  const inputs = [
    { name: "sorted keys, nested", input: '{"b":1,"a":[3,{"d":null,"c":"x"}]}' },
    { name: "code-unit order: uppercase, underscore, lowercase", input: '{"a":1,"_":2,"B":3,"aa":4,"A":5}' },
    { name: "non-ASCII stays literal", input: '{"name":"Chrome 配置文件 é","k":"ﬁ"}' },
    { name: "escapes: control, quote, backslash, newline, tab", input: '{"s":"a\\u0001b\\n\\t\\"\\\\\\u001f"}' },
    { name: "U+007F, U+2028 and U+2029 stay literal", input: '{"s":"\\u007f\\u2028\\u2029"}' },
    { name: "null is kept, empty containers", input: '{"a":null,"b":{},"c":[]}' },
    { name: "integers incl. ms timestamps and 2^53-1", input: '{"z":0,"n":-1,"t":1792051594787,"m":9007199254740991}' },
    { name: "booleans and array order preserved", input: '{"x":[true,false,null,"b","a"]}' },
    { name: "whitespace in the input is irrelevant", input: '{ "b" : [ 1 , 2 ] ,\n "a" : "x" }' },
  ];
  return {
    section: "§2.2 KeyBundle MAC input, §3.2 M5 payload P, §3.9 P2",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib"],
    rule: "Phase 0 canonicalJson (core/vault/merge.ts): keys sorted by UTF-16 code units, undefined members dropped, primitives as JSON.stringify. Cross-language stable only for strings, booleans, null and safe integers (Python: json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False)). §2.3, §5.4 (§0.0d N20): every number is a safe integer; see number_tokens.",
    cases: inputs.map((c) => ({ ...c, canonical: canonicalJson(JSON.parse(c.input)) })),
  };
}

async function genTime() {
  const ms = [0, 1, 3_599_999, 3_600_000, 3_600_001, NOW, AT, AT + 3_599_999, AT + 3_600_000, 86_399_999, 86_400_000];
  return {
    section: "§2.3 T1, §5.3 C14",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib"],
    rule: "floor to the UTC hour/day/minute of the ms Unix timestamp: floor(ms / 3600000) * 3600000. Postgres date_trunc on timestamptz uses the session TimeZone, so the migration sets ALTER ROLE sixkey_api SET timezone = 'UTC'. §2.3, §5.3 (§0.0d N4).",
    cases: ms.map((t) => ({
      ms: t,
      hour: truncHour(t),
      day: truncDay(t),
      minute: truncMinute(t),
      hour_aligned: t % 3_600_000 === 0,
    })),
  };
}

async function genPadding() {
  const PAD = 16384;
  const lengths = [1, 2, 16383, 16384, 16385, 32768, 32769, 100_000];
  const texts = [
    '{"schemaVersion":1,"vaultId":"test-vault-0001","entries":[]}',
    '{"schemaVersion":1,"vaultId":"test-vault-0001","entries":[{"id":"e1","issuer":"例子","label":"alice@example.invalid","secret":"JBSWY3DPEHPK3PXP"}]}',
  ];
  const concrete = [];
  for (const t of texts) {
    const b = utf8(t);
    const padded = new Uint8Array(Math.ceil(b.length / PAD) * PAD).fill(0x20);
    padded.set(b);
    assert(
      JSON.stringify(JSON.parse(new TextDecoder().decode(padded))) === JSON.stringify(JSON.parse(t)),
      "padding parses back",
    );
    concrete.push({
      plaintext: t,
      utf8_len: b.length,
      padded_len: padded.length,
      padded_sha256_b64: b64(await sha256(padded)),
    });
  }
  return {
    section: "§3.13, §4.1",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib"],
    rule: "append ASCII spaces (0x20) to the UTF-8 plaintext until its length is a multiple of 16384; a plaintext already at a multiple gets no bytes (§4.1, §0.0d N23). JSON.parse ignores the trailing whitespace.",
    bucket_bytes: PAD,
    lengths: lengths.map((l) => ({ utf8_len: l, padded_len: Math.ceil(l / PAD) * PAD })),
    concrete,
  };
}

async function genVkSubkeys() {
  const vkLabels = HKDF_LABELS.filter((l) => l.ikm === "VK" || l.ikm === "VK (new)");
  const out = [];
  for (const [name, vk] of [
    ["VK1", VK1],
    ["VK2", VK2],
    ["VK0", VK0],
  ]) {
    const sub = [];
    for (const l of vkLabels)
      sub.push({ label: l.label, bits: l.bits, hex: hex(await hkdf(vk, EMPTY, l.label, l.bits)) });
    assert(new Set(sub.map((s) => s.hex.slice(0, 16))).size === sub.length, `${name} subkeys distinct`);
    out.push({ vk: name, vk_hex: hex(vk), vk_id: await vkIdOf(vk), subkeys: sub });
  }
  const hazard = [];
  for (const label of ["sixkey/v1/vault-write", "sixkey/v1/vault-enc"]) {
    const bits = await hkdf(VK1, EMPTY, label, 256);
    const key = await deriveKeyAesExport(VK1, label);
    assert(hex(bits) === hex(key), "deriveKey == deriveBits");
    hazard.push({ label, derive_bits_256_hex: hex(bits), derive_key_aes256_export_hex: hex(key), equal: true });
  }
  return {
    section: "§2.1, §2.2",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib"],
    rule: "HKDF-SHA256(VK, salt = empty, info = label), 256 bits except vk-id (64 bits, lowercase hex). §2.2 (§0.0d N3): every HKDF output is 256 bits except vk-id; HMAC keys are derived with an explicit length of 256 (WebCrypto's HMAC deriveKey without a length gives 512 bits and a different MAC, kept as a counterexample in keybundle.mac_cases).",
    keys: out,
    webcrypto_hazard: {
      note: "deriveKey(HKDF -> AES-256-GCM, extractable) exported equals deriveBits(256) for the same info. This is why every label must differ: with one label, K_write (sent to the server) would equal K_enc.",
      cases: hazard,
    },
  };
}

async function genEnvelope() {
  const vkId = await vkIdOf(VK1);
  const plaintext = '{"schemaVersion":1,"vaultId":"test-vault-0001","entries":[]}';
  const rev = 42;
  const aad = `sixkey-vault|1|${VAULT_ID}|${vkId}|${rev}`;
  const kEnc = await hkdf(VK1, EMPTY, "sixkey/v1/vault-enc", 256);
  const ivB = iv(0x0e);
  const ct = await gcmEncrypt(kEnc, ivB, utf8(plaintext), utf8(aad));
  const envelope = {
    format: "sixkey-vault",
    formatVersion: 1,
    cipher: "AES-256-GCM",
    vaultId: VAULT_ID,
    vkId,
    rev,
    iv: b64(ivB),
    ciphertext: b64(ct),
    checksum: b64(await sha256(utf8(aad), ivB, ct)),
  };
  const text = JSON.stringify(envelope);
  const spaced = JSON.stringify(envelope, null, 1);
  const flip = (b, i) => {
    const c = b.slice();
    c[i] ^= 0x01;
    return c;
  };
  const aadWith = (vaultId, vkId_, r) => `sixkey-vault|1|${vaultId}|${vkId_}|${r}`;
  const otherVkId = await vkIdOf(VK2);
  const tamper = [
    { name: "ciphertext byte flipped", iv_b64: b64(ivB), ciphertext_b64: b64(flip(ct, 3)), aad },
    { name: "tag byte flipped", iv_b64: b64(ivB), ciphertext_b64: b64(flip(ct, ct.length - 1)), aad },
    { name: "iv byte flipped", iv_b64: b64(flip(ivB, 0)), ciphertext_b64: b64(ct), aad },
    {
      name: "AAD with another vaultId",
      iv_b64: b64(ivB),
      ciphertext_b64: b64(ct),
      aad: aadWith("test-vault-0002", vkId, rev),
    },
    {
      name: "AAD with another vkId",
      iv_b64: b64(ivB),
      ciphertext_b64: b64(ct),
      aad: aadWith(VAULT_ID, otherVkId, rev),
    },
    { name: "AAD with rev + 1", iv_b64: b64(ivB), ciphertext_b64: b64(ct), aad: aadWith(VAULT_ID, vkId, rev + 1) },
    { name: "AAD with rev - 1", iv_b64: b64(ivB), ciphertext_b64: b64(ct), aad: aadWith(VAULT_ID, vkId, rev - 1) },
  ];
  for (const m of tamper) {
    m.opens = await gcmOpens(kEnc, fromB64(m.iv_b64), fromB64(m.ciphertext_b64), utf8(m.aad));
    assert(m.opens === false, `envelope tamper ${m.name}`);
  }
  return {
    section: "§3.13, §4.1, §4.2, §5.3 (head), Phase 0 core/crypto/envelope.ts",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib", "python-cryptography"],
    note: "Unpadded plaintext to keep the file small; real uploads pad first (padding group). The envelope travels and is stored as this exact JSON text; head = SHA-256 of its UTF-8 bytes, standard base64.",
    vk: "VK1",
    vault_id: VAULT_ID,
    rev,
    iv_b64: b64(ivB),
    plaintext,
    aad,
    envelope,
    envelope_text: text,
    checksum_b64: envelope.checksum,
    head_b64: b64(await sha256(utf8(text))),
    head_of_reserialized_text: {
      envelope_text: spaced,
      head_b64: b64(await sha256(utf8(spaced))),
      note: "same object, different text: different head. The server hashes the raw text it stores.",
    },
    must_not_open: tamper,
  };
}

async function genWriteProof(envelope) {
  const kWrite1 = await hkdf(VK1, EMPTY, "sixkey/v1/vault-write", 256);
  const kWrite2 = await hkdf(VK2, EMPTY, "sixkey/v1/vault-write", 256);
  const kEnc1 = await hkdf(VK1, EMPTY, "sixkey/v1/vault-enc", 256);
  const ifVersion = envelope.rev - 1;
  const input = (vaultId, v, checksum) => `sixkey-write|1|${vaultId}|${v}|${checksum}`;
  const good = input(VAULT_ID, ifVersion, envelope.checksum);
  const proof = b64(await hmac(kWrite1, utf8(good)));
  const otherChecksum = b64(fill(0x99, 32));
  const verify = [
    {
      name: "correct",
      vault_id: VAULT_ID,
      if_version: ifVersion,
      checksum_b64: envelope.checksum,
      proof_b64: proof,
      valid: true,
    },
    {
      name: "if_version off by one (bound to one write)",
      vault_id: VAULT_ID,
      if_version: ifVersion + 1,
      checksum_b64: envelope.checksum,
      proof_b64: proof,
      valid: false,
    },
    {
      name: "different envelope checksum",
      vault_id: VAULT_ID,
      if_version: ifVersion,
      checksum_b64: otherChecksum,
      proof_b64: proof,
      valid: false,
    },
    {
      name: "different vaultId",
      vault_id: "test-vault-0002",
      if_version: ifVersion,
      checksum_b64: envelope.checksum,
      proof_b64: proof,
      valid: false,
    },
    {
      name: "proof made with K_enc (wrong label)",
      vault_id: VAULT_ID,
      if_version: ifVersion,
      checksum_b64: envelope.checksum,
      proof_b64: b64(await hmac(kEnc1, utf8(good))),
      valid: false,
    },
    {
      name: "proof made with K_write of VK2",
      vault_id: VAULT_ID,
      if_version: ifVersion,
      checksum_b64: envelope.checksum,
      proof_b64: b64(await hmac(kWrite2, utf8(good))),
      valid: false,
    },
    {
      name: "proof made over the input without the domain tag",
      vault_id: VAULT_ID,
      if_version: ifVersion,
      checksum_b64: envelope.checksum,
      proof_b64: b64(await hmac(kWrite1, utf8(good.slice("sixkey-write|1|".length)))),
      valid: false,
    },
  ];
  return {
    section: "§2.2, §4.2, §4.7, §5.2",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib"],
    rule: "K_write = HKDF(VK, empty, 'sixkey/v1/vault-write', 256), sent as write_key / new_write_key (standard base64). write_proof = HMAC-SHA256(K_write, UTF-8('sixkey-write|1|{vaultId}|{if_version}|{envelope.checksum}')), standard base64. if_version is decimal; the checksum is the envelope's standard-base64 checksum field verbatim.",
    vk: "VK1",
    write_key_b64: b64(kWrite1),
    new_write_key_b64_vk2: b64(kWrite2),
    vault_id: VAULT_ID,
    if_version: ifVersion,
    envelope_rev: envelope.rev,
    checksum_b64: envelope.checksum,
    input: good,
    write_proof_b64: proof,
    verify,
  };
}

async function genRecoveryAuth() {
  const code = await recoveryCodeText(RECOVERY_SECRET);
  assert(hex(await recoveryCodeParse(code)) === hex(RECOVERY_SECRET), "recovery code round trip");
  const recAuth = await hkdf(RECOVERY_SECRET, EMPTY, "sixkey/v1/recovery-auth", 256);
  const verifier = await sha256(utf8("sixkey-recovery-verifier|1|"), recAuth);
  const kekRecovery = await hkdf(RECOVERY_SECRET, SALT_RECOVERY, "sixkey/v1/kek-recovery", 256);
  const recAuthWithSalt = await hkdf(RECOVERY_SECRET, SALT_RECOVERY, "sixkey/v1/recovery-auth", 256);
  const verifierOverText = await sha256(utf8(`sixkey-recovery-verifier|1|${b64(recAuth)}`));
  assert(hex(kekRecovery) !== hex(recAuth), "recAuth != KEK");
  const variants = [
    code.toLowerCase(),
    code.replace(/-/g, " "),
    code.replace(/-/g, ""),
    code.replace(/0/g, "O").replace(/1/g, "I"),
  ];
  for (const v of variants) assert(hex(await recoveryCodeParse(v)) === hex(RECOVERY_SECRET), `variant ${v}`);
  // A one-symbol typo that the 12 check bits catch (searched deterministically).
  let typo = null;
  for (let i = 0; i < 28 && !typo; i++) {
    const flat = code.replace(/-/g, "");
    for (const ch of CROCKFORD) {
      if (ch === flat[i]) continue;
      const cand = (flat.slice(0, i) + ch + flat.slice(i + 1)).match(/.{4}/g).join("-");
      try {
        await recoveryCodeParse(cand);
      } catch (e) {
        if (e.message === "recovery_checksum") {
          typo = cand;
          break;
        }
      }
    }
  }
  return {
    section: "§2.2, §3.3, Phase 0 core/crypto/recovery-code.ts",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib"],
    rule: "recAuth = HKDF(secret128, empty, 'sixkey/v1/recovery-auth', 256), sent as recovery_auth (standard base64). recovery_verifier = SHA-256(UTF-8('sixkey-recovery-verifier|1|') || recAuth raw 32 bytes), standard base64.",
    secret_hex: hex(RECOVERY_SECRET),
    code,
    equivalent_inputs: variants,
    rejected_inputs: [
      { input: typo, error: "recovery_checksum" },
      { input: code.slice(0, -1), error: "recovery_length" },
      { input: `${code.slice(0, -1)}U`, error: "recovery_char" },
    ],
    recovery_auth_b64: b64(recAuth),
    recovery_verifier_b64: b64(verifier),
    contrast: {
      note: "These must all differ from recovery_auth / recovery_verifier: the server learns recAuth, which must not open the recovery wrap.",
      kek_recovery_salt_b64: b64(SALT_RECOVERY),
      kek_recovery_hex: hex(kekRecovery),
      recovery_auth_with_wrap_salt_b64: b64(recAuthWithSalt),
      verifier_over_base64_text_b64: b64(verifierOverText),
    },
  };
}

async function genPasswordAuth() {
  const cases = [];
  for (const [name, pw] of [
    ["ascii", PASSWORD],
    ["fullwidth (NFKC equal to ascii)", PASSWORD_FULLWIDTH],
    ["ligature", PASSWORD_LIGATURE],
  ]) {
    const norm = pw.normalize("NFKC");
    const pb = await pbkdf2(utf8(norm), SALT_AUTH, ITER, 256);
    const pwAuth = await hkdf(pb, EMPTY, "sixkey/v1/password-auth", 256);
    const verifier = await sha256(utf8("sixkey-password-verifier|1|"), pwAuth);
    cases.push({
      name,
      password: pw,
      nfkc: norm,
      pbkdf2_hex: hex(pb),
      password_auth_b64: b64(pwAuth),
      password_verifier_b64: b64(verifier),
    });
  }
  assert(cases[0].password_auth_b64 === cases[1].password_auth_b64, "NFKC equivalence");
  return {
    section: "§2.2, §3.14",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib"],
    rule: "pw_auth = HKDF(PBKDF2-SHA256(UTF-8(NFKC(pw)), salt_auth, iterations, 256 bits), empty, 'sixkey/v1/password-auth', 256 bits), sent as password_auth (standard base64). password_verifier = SHA-256(UTF-8('sixkey-password-verifier|1|') || pw_auth raw 32 bytes), standard base64. salt_auth and iterations come from KeyBundle.auth.kdf and must differ from the password wrap's salt.",
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITER, salt: b64(SALT_AUTH), v: 1 },
    cases,
    kdf_params: {
      note: "Read-time bounds (Phase 0 core/crypto/kdf.ts assertKdfParams, enforced again by §3.14): 600000 <= iterations <= 20000000, salt >= 16 bytes, v 1, hash SHA-256.",
      accept: [
        { name: "PBKDF2", hash: "SHA-256", iterations: 600000, salt: b64(SALT_AUTH), v: 1 },
        { name: "PBKDF2", hash: "SHA-256", iterations: 20000000, salt: b64(SALT_AUTH), v: 1 },
      ],
      reject: [
        { name: "PBKDF2", hash: "SHA-256", iterations: 599999, salt: b64(SALT_AUTH), v: 1 },
        { name: "PBKDF2", hash: "SHA-256", iterations: 20000001, salt: b64(SALT_AUTH), v: 1 },
        { name: "PBKDF2", hash: "SHA-256", iterations: 600000, salt: b64(fill(0xc0, 15)), v: 1 },
        { name: "PBKDF2", hash: "SHA-1", iterations: 600000, salt: b64(SALT_AUTH), v: 1 },
        { name: "PBKDF2", hash: "SHA-256", iterations: 600000, salt: b64(SALT_AUTH), v: 2 },
      ],
    },
  };
}

async function buildKeyring() {
  const vkId = await vkIdOf(VK1);
  const vk0Id = await vkIdOf(VK0);
  const kdfPw = { name: "PBKDF2", hash: "SHA-256", iterations: ITER, salt: b64(SALT_KEK), v: 1 };
  const kdfRec = { name: "HKDF", hash: "SHA-256", salt: b64(SALT_RECOVERY), v: 1 };
  const aadPw = `sixkey-wrap|1|password|${vkId}|${VAULT_ID}|PBKDF2-SHA256:${ITER}:${kdfPw.salt}`;
  const aadRec = `sixkey-wrap|1|recovery|${vkId}|${VAULT_ID}|HKDF-SHA256:${kdfRec.salt}`;
  const aadPrev = `sixkey-prev|1|${VAULT_ID}|${vkId}|${vk0Id}`;
  const kekPw = await pbkdf2(utf8(PASSWORD.normalize("NFKC")), SALT_KEK, ITER, 256);
  const kekRec = await hkdf(RECOVERY_SECRET, SALT_RECOVERY, "sixkey/v1/kek-recovery", 256);
  const kekPrev = await hkdf(VK1, EMPTY, "sixkey/v1/kek-previous", 256);
  const wPw = await gcmEncrypt(kekPw, iv(0x01), VK1, utf8(aadPw));
  const wRec = await gcmEncrypt(kekRec, iv(0x02), VK1, utf8(aadRec));
  const wPrev = await gcmEncrypt(kekPrev, iv(0x03), VK0, utf8(aadPrev));
  const keyring = {
    format: "sixkey-keyring",
    v: 1,
    vaultId: VAULT_ID,
    vkId,
    wraps: [
      { method: "password", vkId, iv: b64(iv(0x01)), wrapped: b64(wPw), createdAt: AT - 7_200_000, kdf: kdfPw },
      { method: "recovery", vkId, iv: b64(iv(0x02)), wrapped: b64(wRec), createdAt: AT - 3_600_000, kdf: kdfRec },
    ],
    previous: [{ vkId: vk0Id, iv: b64(iv(0x03)), wrapped: b64(wPrev), createdAt: AT - 86_400_000 }],
  };
  return {
    keyring,
    aad: { password: aadPw, recovery: aadRec, previous: aadPrev },
    kek_hex: { password: hex(kekPw), recovery: hex(kekRec), previous: hex(kekPrev) },
  };
}

const macInput = (bundle) => {
  const { mac: _m, ...rest } = bundle;
  return `sixkey-keybundle|1|${canonicalJson(rest)}`;
};

async function signBundle(bundle, kMac = null) {
  const key = kMac ?? (await hkdf(VK1, EMPTY, "sixkey/v1/keybundle-mac", 256));
  return { ...bundle, mac: b64(await hmac(key, utf8(macInput(bundle)))) };
}

function reorderDeep(v) {
  if (Array.isArray(v)) return v.map(reorderDeep);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v)
        .reverse()
        .map((k) => [k, reorderDeep(v[k])]),
    );
  return v;
}

async function genKeyBundle() {
  const { keyring, aad, kek_hex } = await buildKeyring();
  const kMac1 = await hkdf(VK1, EMPTY, "sixkey/v1/keybundle-mac", 256);
  const base = {
    format: "sixkey-keybundle",
    v: 1,
    vaultId: VAULT_ID,
    kver: 3,
    keyring,
    auth: { kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITER, salt: b64(SALT_AUTH), v: 1 } },
    by: DEV_A,
    at: AT,
  };
  const bundle = await signBundle(base);
  const raw = JSON.stringify(bundle);
  const clone = () => JSON.parse(raw);

  const macCases = [];
  const addMac = (name, text, mac_valid, why) => macCases.push({ name, raw: text, mac_valid, ...(why ? { why } : {}) });
  addMac("as uploaded", raw, true);
  addMac(
    "same bundle, other key order and whitespace",
    JSON.stringify(reorderDeep(bundle), null, 2),
    true,
    "the MAC is over canonicalJson, not the raw text",
  );
  const withUnknown = await signBundle({ ...base, x_future: { note: "a field added by a newer client" } });
  addMac(
    "unknown top-level field included under the MAC",
    JSON.stringify(withUnknown),
    true,
    "forward compatible: verifies and can be adopted, but the client must refuse key operations on it (§2.3)",
  );
  const tamper = (fn) => {
    const b = clone();
    fn(b);
    return JSON.stringify(b);
  };
  addMac(
    "unknown field added after the MAC",
    tamper((b) => (b.x_future = 1)),
    false,
  );
  addMac(
    "kver raised",
    tamper((b) => (b.kver = 4)),
    false,
  );
  addMac(
    "auth salt changed",
    tamper((b) => (b.auth.kdf.salt = b64(seq(0xe0, 16)))),
    false,
  );
  addMac(
    "recovery wrap iv changed",
    tamper((b) => (b.keyring.wraps[1].iv = b64(iv(0x09)))),
    false,
  );
  addMac(
    "previous VK dropped",
    tamper((b) => (b.keyring.previous = [])),
    false,
  );
  addMac(
    "by changed",
    tamper((b) => (b.by = DEV_S)),
    false,
  );
  addMac(
    "at changed",
    tamper((b) => (b.at = AT + 3_600_000)),
    false,
  );
  addMac(
    "createdAt changed",
    tamper((b) => (b.keyring.wraps[0].createdAt += 3_600_000)),
    false,
  );
  const kEnc1 = await hkdf(VK1, EMPTY, "sixkey/v1/vault-enc", 256);
  addMac("MAC key from the wrong label (vault-enc)", JSON.stringify(await signBundle(base, kEnc1)), false);
  const k512 = await deriveKeyHmacDefaultExport(VK1, "sixkey/v1/keybundle-mac");
  assert(k512.length === 64 && hex(k512.slice(0, 32)) === hex(kMac1), "512-bit HMAC key prefix");
  addMac(
    "MAC with WebCrypto's default 512-bit HMAC key",
    JSON.stringify(await signBundle(base, k512)),
    false,
    "deriveKey(HMAC) without length yields 64 bytes; §2.2 requires length 256 (§0.0d N3)",
  );
  const noPrefix = { ...base, mac: b64(await hmac(kMac1, utf8(canonicalJson(base)))) };
  addMac("MAC without the 'sixkey-keybundle|1|' prefix", JSON.stringify(noPrefix), false);
  addMac(
    "MAC made with VK2",
    JSON.stringify(await signBundle(base, await hkdf(VK2, EMPTY, "sixkey/v1/keybundle-mac", 256))),
    false,
    "verified with VK1",
  );

  // Shape rules stated in the doc. MACs are recomputed so only the named rule fails.
  const shape = [];
  const addShape = async (name, rule, fn, schemaExpressible = true) => {
    const b = JSON.parse(JSON.stringify(base));
    fn(b);
    shape.push({
      name,
      rule,
      raw: JSON.stringify(await signBundle(b)),
      shape_valid: false,
      schema_expressible: schemaExpressible,
    });
  };
  shape.push({ name: "as uploaded", rule: "-", raw, shape_valid: true, schema_expressible: true });
  await addShape("a device wrap is present", "§2.3/§3.13: wraps are exactly {password, recovery}", (b) =>
    b.keyring.wraps.push({ ...b.keyring.wraps[1], method: "device" }),
  );
  await addShape("no recovery wrap", "§2.3/§3.13: wraps are exactly {password, recovery}", (b) =>
    b.keyring.wraps.pop(),
  );
  await addShape(
    "two password wraps",
    "§2.3/§3.13: wraps are exactly {password, recovery}",
    (b) => (b.keyring.wraps[1] = { ...b.keyring.wraps[0] }),
  );
  await addShape("deviceKey present", "§2.3/§3.13: no deviceKey", (b) => (b.keyring.deviceKey = b64(fill(0x44, 32))));
  await addShape("65 previous VKs", "§2.3: previous <= 64", (b) => {
    b.keyring.previous = Array.from({ length: 65 }, (_, i) => ({
      ...b.keyring.previous[0],
      vkId: i.toString(16).padStart(16, "0"),
    }));
  });
  await addShape("kver 0", "§2.3: kver >= 1", (b) => (b.kver = 0));
  await addShape(
    "bundle vaultId differs from keyring.vaultId",
    "§2.3: one vaultId (implied by the AADs and the server's vaultId check)",
    (b) => (b.vaultId = "test-vault-0002"),
    false,
  );
  await addShape(
    "auth iterations below the floor",
    "§2.3/§3.14: KDF parameters in range",
    (b) => (b.auth.kdf.iterations = 599_999),
  );
  await addShape("wrong format tag", "§2.3: format sixkey-keybundle, v 1", (b) => (b.format = "sixkey-keyring"));
  await addShape("by is not a device id", "§2.3: by is a deviceId", (b) => (b.by = "not a device"));
  const ALIGN =
    "§2.3 (§0.0d N16): at, wraps[].createdAt and previous[].createdAt are multiples of 3600000; the server answers 422, clients do not check on read";
  await addShape("at not hour-aligned (+1 ms)", ALIGN, (b) => (b.at += 1));
  await addShape("a wrap createdAt not hour-aligned (+1 s)", ALIGN, (b) => (b.keyring.wraps[0].createdAt += 1000));
  await addShape(
    "a previous createdAt not hour-aligned (+1 min)",
    ALIGN,
    (b) => (b.keyring.previous[0].createdAt += 60_000),
  );
  // 64 previous entries is the edge that is still allowed.
  const b64prev = JSON.parse(JSON.stringify(base));
  b64prev.keyring.previous = Array.from({ length: 64 }, (_, i) => ({
    ...base.keyring.previous[0],
    vkId: i.toString(16).padStart(16, "0"),
  }));
  shape.push({
    name: "exactly 64 previous VKs",
    rule: "§2.3: previous <= 64",
    raw: JSON.stringify(await signBundle(b64prev)),
    shape_valid: true,
    schema_expressible: true,
  });

  return {
    section: "§2.3, §3.9, §3.13",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib", "python-cryptography"],
    rule: "mac = base64(HMAC-SHA256(K_mac, UTF-8('sixkey-keybundle|1|' + canonicalJson(bundle without mac)))), K_mac = HKDF(VK, empty, 'sixkey/v1/keybundle-mac', 256). The bundle travels and is stored as raw JSON text; receivers parse generically and keep unknown fields. Time fields (at, wraps[].createdAt, previous[].createdAt) are truncated to the hour before upload (T1).",
    vk: "VK1",
    password: PASSWORD,
    recovery_secret_hex: hex(RECOVERY_SECRET),
    vk0_hex: hex(VK0),
    aad,
    kek_hex,
    bundle,
    raw,
    mac_input: macInput(bundle),
    mac_b64: bundle.mac,
    k_mac_hex: hex(kMac1),
    mac_cases: macCases,
    shape_cases: shape,
  };
}

const NAME_BYTES = 160;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/u;
/** §2.4 (revision 5, §0.0d N5): NFKC, trim U+0020 at both ends, then reject in this order. */
function deviceNameRule(input) {
  if (!input.isWellFormed()) return { valid: false, reason: "not_well_formed" };
  const n = input.normalize("NFKC").replace(/^ +| +$/g, "");
  const cps = [...n].length;
  if (cps < 1) return { valid: false, reason: "empty", normalized: n };
  if (cps > 40) return { valid: false, reason: "too_long", normalized: n, code_points: cps };
  if (/\p{Cc}/u.test(n)) return { valid: false, reason: "control_char", normalized: n };
  if (BIDI_CONTROL.test(n)) return { valid: false, reason: "bidi_control", normalized: n };
  if (ZERO_WIDTH.test(n)) return { valid: false, reason: "zero_width", normalized: n };
  const bytes = utf8(n);
  assert(bytes.length <= NAME_BYTES, "40 code points fit in 160 bytes");
  const padded = new Uint8Array(NAME_BYTES).fill(0x20);
  padded.set(bytes);
  const decoded = new TextDecoder().decode(padded).replace(/ +$/, "");
  assert(decoded === n, "trimmed names round-trip exactly");
  return {
    valid: true,
    normalized: n,
    code_points: cps,
    utf16_units: n.length,
    utf8_len: bytes.length,
    padded_b64: b64(padded),
    decoded,
  };
}

async function genDeviceName() {
  const inputs = [
    ["default name", "Chrome 配置文件"],
    ["ascii", "Work profile 3"],
    ["fullwidth folds to ascii", "Ｗｏｒｋ"],
    ["ligature folds", "ﬁle server"],
    ["leading and trailing spaces are trimmed", "  Work  "],
    ["ideographic spaces become U+0020 under NFKC, then are trimmed", "\u3000Work\u3000"],
    ["inner spaces are kept", "a  b"],
    ["40 code points (edge)", "a".repeat(40)],
    ["40 code points once the surrounding spaces are trimmed", ` ${"a".repeat(40)} `],
    ["41 code points", "a".repeat(41)],
    ["40 emoji = 40 code points = 80 UTF-16 units = 160 bytes (passes)", "😀".repeat(40)],
    ["41 emoji", "😀".repeat(41)],
    ["NFKC expansion to exactly 40", "㍿".repeat(10)],
    ["NFKC expansion past 40", "㍿".repeat(11)],
    ["empty", ""],
    ["all spaces: empty after trimming", "   "],
    ["BEL (C0 control)", "a\u0007b"],
    ["TAB is a control character", "tab\tname"],
    ["DEL", "a\u007fb"],
    ["NEL (C1 control)", "a\u0085b"],
    ["RLO U+202E (bidi control)", "a\u202eb"],
    ["ALM U+061C (bidi control)", "a\u061cb"],
    ["LRM U+200E (bidi control)", "a\u200eb"],
    ["LRI U+2066 (bidi control)", "a\u2066b"],
    ["ZWSP U+200B (zero width)", "a\u200bb"],
    ["ZWJ U+200D inside an emoji sequence (zero width; rejection kept, §6 O3, §0.0e N28)", "👩\u200d💻"],
    ["WORD JOINER U+2060 (zero width)", "a\u2060b"],
    ["BOM U+FEFF (zero width)", "\ufeffname"],
    ["precedence: too long before a control character", `\u0007${"a".repeat(40)}`],
    ["precedence: control character before bidi control", "a\u0007\u202eb"],
    ["precedence: bidi control before zero width", "a\u200b\u202eb"],
    ["lone surrogate", "a\ud800b"],
  ];
  const cases = inputs.map(([name, input]) => ({ name, input, ...deviceNameRule(input) }));
  // Encryption under K_name (§2.4): name_ct = {vkId, iv, ct}, AAD binds vault, VK and device.
  const vkId = await vkIdOf(VK1);
  const kName = await hkdf(VK1, EMPTY, "sixkey/v1/device-name", 256);
  const enc = [];
  for (const [dev, ivByte, name] of [
    [DEV_N, 0x21, "Chrome 配置文件"],
    [DEV_A, 0x22, "Work profile 3"],
  ]) {
    const r = deviceNameRule(name);
    const aad = `sixkey-devname|1|${VAULT_ID}|${vkId}|${dev}`;
    const ct = await gcmEncrypt(kName, iv(ivByte), fromB64(r.padded_b64), utf8(aad));
    assert(ct.length === 176, "fixed-length name ciphertext");
    enc.push({ device_id: dev, name, aad, name_ct: { vkId, iv: b64(iv(ivByte)), ct: b64(ct) } });
  }
  const first = enc[0];
  const ctB = fromB64(first.name_ct.ct);
  const kName2 = await hkdf(VK2, EMPTY, "sixkey/v1/device-name", 256);
  const ctFlip = ctB.slice();
  ctFlip[5] ^= 0x01;
  const negDefs = [
    { name: "AAD for another device", key: "VK1", ct: ctB, aad: `sixkey-devname|1|${VAULT_ID}|${vkId}|${DEV_A}` },
    { name: "AAD for another vault", key: "VK1", ct: ctB, aad: `sixkey-devname|1|test-vault-0002|${vkId}|${DEV_N}` },
    {
      name: "AAD with another vkId",
      key: "VK1",
      ct: ctB,
      aad: `sixkey-devname|1|${VAULT_ID}|${await vkIdOf(VK2)}|${DEV_N}`,
    },
    { name: "K_name of VK2", key: "VK2", ct: ctB, aad: first.aad },
    {
      name: "device-backup AAD tag instead of devname",
      key: "VK1",
      ct: ctB,
      aad: `sixkey-devkey|1|${VAULT_ID}|${vkId}|${DEV_N}`,
    },
    { name: "ciphertext byte flipped", key: "VK1", ct: ctFlip, aad: first.aad },
  ];
  const neg = [];
  for (const d of negDefs) {
    const opens = await gcmOpens(d.key === "VK1" ? kName : kName2, iv(0x21), d.ct, utf8(d.aad));
    assert(opens === false, d.name);
    neg.push({ name: d.name, key: d.key, iv_b64: b64(iv(0x21)), ct_b64: b64(d.ct), aad: d.aad, opens });
  }
  return {
    section: "§2.4",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib", "python-cryptography"],
    rule: "§2.4 (§0.0d N5): NFKC; trim U+0020 at both ends; then reject, in this order: not_well_formed (lone surrogate), empty, too_long (> 40 code points, not UTF-16 units), control_char (General_Category Cc), bidi_control (U+061C, U+200E-200F, U+202A-202E, U+2066-2069), zero_width (U+200B-200D, U+2060, U+FEFF). UTF-8, right-pad with 0x20 to exactly 160 bytes; decoding strips trailing 0x20, which now round-trips exactly. name_ct = {vkId, iv, ct} with ct = AES-256-GCM(K_name(VK), padded, AAD 'sixkey-devname|1|{vaultId}|{vkId}|{deviceId}'), so ct is always 176 bytes (236 base64 chars).",
    padded_bytes: NAME_BYTES,
    max_code_points: 40,
    cases,
    encrypt: { vk: "VK1", k_name_hex: hex(kName), cases: enc, must_not_open: neg },
  };
}

async function genDeviceBackup() {
  const vkId = await vkIdOf(VK1);
  const k = await hkdf(VK1, EMPTY, "sixkey/v1/device-backup", 256);
  const aad = `sixkey-devkey|1|${VAULT_ID}|${vkId}|${DEV_N}`;
  const plaintext = canonicalJson({ dsk: { ...jwk(KEYS.dsk_N) }, email: EMAIL });
  const ct = await gcmEncrypt(k, iv(0x31), utf8(plaintext), utf8(aad));
  return {
    section: "§2.2, §2.5",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib", "python-cryptography"],
    note: "sk_sync_cfg.enc = {vkId, iv, ct}. The doc does not fix the plaintext serialization (only this client reads it); canonicalJson of {dsk: private JWK, email} is used here.",
    vk: "VK1",
    device_id: DEV_N,
    aad,
    plaintext,
    enc: { vkId, iv: b64(iv(0x31)), ct: b64(ct) },
  };
}

function keyView(name, k) {
  return {
    name,
    d_hex: hex(k.d),
    point_b64u: b64u(k.point),
    point_b64: b64(k.point),
    x_hex: hex(k.x),
    y_hex: hex(k.y),
  };
}

async function genPublicKeys() {
  const keys = [];
  for (const [name, k] of Object.entries(KEYS)) {
    const spki = await spkiOf(k.point);
    assert(hex(spki) === hex(concat(SPKI_P256_PREFIX, k.point)), "SPKI = fixed prefix + point");
    keys.push({ ...keyView(name, k), spki_b64: b64(spki), spki_b64u: b64u(spki) });
  }
  const p = KEYS.dsk_N.point;
  const compressed = concat(Uint8Array.of(0x02 | (p[64] & 1)), p.slice(1, 33));
  const yPlus = (toBig(p.slice(33)) + 1n).toString(16).padStart(64, "0");
  const offCurve = concat(Uint8Array.of(0x04), p.slice(1, 33), fromHex(yPlus));
  const xBig = concat(Uint8Array.of(0x04), fill(0xff, 32), p.slice(33));
  const epkReject = [
    {
      name: "compressed point (33 bytes)",
      b64: b64(compressed),
      why: "WebCrypto and pyca accept compressed points, so the 65-byte 0x04 rule must be an explicit check",
    },
    { name: "64 bytes, 0x04 prefix missing", b64: b64(p.slice(1)) },
    { name: "SPKI DER where the raw point belongs", b64: b64(concat(SPKI_P256_PREFIX, p)) },
    { name: "0x04 prefix but not on the curve (y + 1)", b64: b64(offCurve) },
    { name: "x >= p", b64: b64(xBig) },
  ];
  for (const r of epkReject) {
    const raw = fromB64(r.b64);
    assert(!epkFormatOk(raw) || !(await pointImports(raw)), `epk reject ${r.name}`);
  }
  const dpkReject = [
    { name: "raw 65-byte point where SPKI belongs", b64: b64(p) },
    { name: "SPKI with a compressed point", b64: b64(concat(SPKI_P256_COMPRESSED_PREFIX, compressed)) },
    { name: "SPKI of a P-384 key", b64: b64(concat(SPKI_P384_PREFIX, P384.point)) },
    { name: "SPKI with an off-curve point", b64: b64(concat(SPKI_P256_PREFIX, offCurve)) },
  ];
  return {
    section: "§2.2 (dpk = SPKI DER, epk = 65-byte uncompressed point), §5.1 wire.py",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib", "python-cryptography"],
    note: "Test-only keys: each private scalar d is one byte repeated (01..01, 02..02, ...). Never use them for anything real.",
    spki_p256_prefix_hex: hex(SPKI_P256_PREFIX),
    keys,
    epk_reject: epkReject,
    dpk_reject: dpkReject,
  };
}

// Enrolment v2 (revision 27, §0.0aa): every domain separation of the approval join is at version 2, and the key that
// protects the reveal name and the payload mixes in the approver's 128-bit pairing secret S, which Sixkey never sends.
const ENROLL_KEY_INFO = "sixkey/v2/enroll-key";
const SAS_TAG = "sixkey/v2/enroll-sas|";
const commitInput = (devN, dpk, epkN, n) => `sixkey-enroll-commit|2|${devN}|${b64u(dpk)}|${b64u(epkN)}|${b64u(n)}`;
const transcript = (t) =>
  `sixkey-enroll|2|${t.rid}|${t.devN}|${t.devA}|${b64u(t.dpkN)}|${b64u(t.epkN)}|${b64u(t.epkA)}|${b64u(t.nN)}`;
const nameAadOf = (h) => `sixkey-enroll-name|2|${b64u(h)}`;
const payloadAadOf = (h) => `sixkey-enroll-payload|2|${b64u(h)}`;
/** K = HKDF(IKM = Z || S, salt = h, 'sixkey/v2/enroll-key', 256): Z the 32-byte ECDH secret, S the 16-byte pairing secret. */
const enrollKey = (z, s, h) => hkdf(concat(z, s), h, ENROLL_KEY_INFO, 256);
const flipBit = (b, i, mask = 0x01) => {
  const c = b.slice();
  c[i] ^= mask;
  return c;
};

async function genEnrollment(keybundleRaw) {
  const dpkN = await spkiOf(KEYS.dsk_N.point);
  const epkN = KEYS.esk_N.point;
  const epkA = KEYS.esk_A.point;
  const cIn = commitInput(DEV_N, dpkN, epkN, N_N);
  const C = await sha256(utf8(cIn));
  const tr = { rid: RID, devN: DEV_N, devA: DEV_A, dpkN, epkN, epkA, nN: N_N };
  const T = transcript(tr);
  const h = await sha256(utf8(T));
  const zN = await ecdh(KEYS.esk_N, epkA);
  const zA = await ecdh(KEYS.esk_A, epkN);
  assert(hex(zN) === hex(zA), "ECDH agreement");
  const S = PAIRING_SECRET;
  const code = await pairingCodeText(S);
  assert(hex(await pairingCodeParse(code)) === hex(S), "pairing code round trip");
  const ikm = concat(zN, S);
  assert(ikm.length === 48, "IKM is Z (32 B) || S (16 B)");
  const K = await enrollKey(zN, S, h);
  assert(hex(K) === hex(await hkdf(ikm, h, ENROLL_KEY_INFO, 256)), "K over the IKM");
  const sas = await sixDigits(SAS_TAG, h);

  const name = deviceNameRule("Chrome 配置文件");
  const nameAad = nameAadOf(h);
  const nameCt = await gcmEncrypt(K, iv(0x41), fromB64(name.padded_b64), utf8(nameAad));
  const P = canonicalJson({
    format: "sixkey-enroll-payload",
    v: 2,
    vaultId: VAULT_ID,
    vk: b64(VK1),
    bundle: keybundleRaw,
    approver: DEV_A,
    at: NOW,
  });
  const payloadAad = payloadAadOf(h);
  const payloadCt = await gcmEncrypt(K, iv(0x42), utf8(P), utf8(payloadAad));
  const payload = concat(iv(0x42), payloadCt);
  const revealName = concat(iv(0x41), nameCt);

  // One-field substitutions by a hostile server: each gives a different h and SAS.
  const subs = [
    ["rid", RID_OTHER],
    ["devN", DEV_S],
    ["devA", DEV_S],
    ["dpkN", await spkiOf(KEYS.esk_S1.point)],
    ["epkN", KEYS.esk_S2.point],
    ["epkA", KEYS.esk_S1.point],
    ["nN", N_S],
  ];
  const substitutions = [];
  for (const [field, value] of subs) {
    const t2 = { ...tr, [field]: value };
    const h2 = await sha256(utf8(transcript(t2)));
    const s2 = await sixDigits(SAS_TAG, h2);
    assert(hex(h2) !== hex(h) && s2.code !== sas.code, `substitution ${field}`);
    substitutions.push({
      field,
      value_b64u: typeof value === "string" ? value : b64u(value),
      transcript: transcript(t2),
      h_hex: hex(h2),
      sas: s2.code,
    });
  }

  // Full two-session MITM: S plays A toward N (esk_S1) and N toward A (esk_S2 with its own commitment).
  const h1 = await sha256(utf8(transcript({ ...tr, epkA: KEYS.esk_S1.point })));
  const tA = { ...tr, epkN: KEYS.esk_S2.point, nN: N_S };
  const h2 = await sha256(utf8(transcript(tA)));
  const mitm = {
    note: "The server runs two sessions: toward N it answers with its own epk (N computes h1), toward A it reveals its own epk and nonce, committed in a substituted C' (A computes h2). Every enrolment ciphertext is under K = HKDF(Z || S, h), so without the pairing secret S the server can make neither a reveal name_ct that A opens (A ends with pairing_mismatch, before the SAS step) nor a payload that N opens (N ends with bad_payload): 2^-128 each. If S has leaked, it must still make SAS(h1) == SAS(h2) to pass A (10^-6, one guess per request); toward N there is no second check (§1.3, §10 row 110).",
    commit_substituted_b64: b64(await sha256(utf8(commitInput(DEV_N, dpkN, KEYS.esk_S2.point, N_S)))),
    h1_hex: hex(h1),
    h2_hex: hex(h2),
    sas_shown_by_N: (await sixDigits(SAS_TAG, h1)).code,
    sas_expected_by_A: (await sixDigits(SAS_TAG, h2)).code,
  };
  assert(mitm.sas_shown_by_N !== mitm.sas_expected_by_A, "MITM SAS differ");

  // A's check at M4: the revealed (epk_N, n_N) must open the commitment A pinned before respond (MUST 1).
  const cB64 = b64(C);
  const commitChecks = [
    {
      name: "honest reveal",
      dev_n: DEV_N,
      dpk_n_b64: b64(dpkN),
      epk_n_b64: b64(epkN),
      nonce_b64: b64(N_N),
      opens_pinned_commit: true,
    },
    {
      name: "server substituted epk_N",
      dev_n: DEV_N,
      dpk_n_b64: b64(dpkN),
      epk_n_b64: b64(KEYS.esk_S2.point),
      nonce_b64: b64(N_N),
      opens_pinned_commit: false,
    },
    {
      name: "server substituted the nonce",
      dev_n: DEV_N,
      dpk_n_b64: b64(dpkN),
      epk_n_b64: b64(epkN),
      nonce_b64: b64(N_S),
      opens_pinned_commit: false,
    },
    {
      name: "server substituted dpk_N",
      dev_n: DEV_N,
      dpk_n_b64: b64(await spkiOf(KEYS.esk_S1.point)),
      epk_n_b64: b64(epkN),
      nonce_b64: b64(N_N),
      opens_pinned_commit: false,
    },
    {
      name: "server substituted devN",
      dev_n: DEV_S,
      dpk_n_b64: b64(dpkN),
      epk_n_b64: b64(epkN),
      nonce_b64: b64(N_N),
      opens_pinned_commit: false,
    },
  ];
  for (const c of commitChecks) {
    const got =
      b64(
        await sha256(utf8(commitInput(c.dev_n, fromB64(c.dpk_n_b64), fromB64(c.epk_n_b64), fromB64(c.nonce_b64)))),
      ) === cB64;
    assert(got === c.opens_pinned_commit, c.name);
  }

  // Keys that must not open anything. The first three are what a recording adversary holding Z (a future quantum
  // computer solving ECDH) could derive without S; the S with one bit flipped is a typo past the check bits.
  const kZOnlyV1 = await hkdf(zN, h, "sixkey/v1/enroll-key", 256);
  const kZOnlyV2 = await hkdf(zN, h, ENROLL_KEY_INFO, 256);
  const sFlipped = flipBit(S, 15);
  const kSFlipped = await enrollKey(zN, sFlipped, h);
  const kSwapped = await hkdf(concat(S, zN), h, ENROLL_KEY_INFO, 256);
  const kNoSalt = await hkdf(ikm, EMPTY, ENROLL_KEY_INFO, 256);
  const hSub = fromHex(substitutions[5].h_hex);
  const kSub = await enrollKey(zN, S, hSub);
  for (const k of [kZOnlyV1, kZOnlyV2, kSFlipped, kSwapped, kNoSalt, kSub]) assert(hex(k) !== hex(K), "a distinct key");
  const mnoDefs = [
    { name: "payload with the name AAD", target: "payload", key: K, wire: payload, aad: nameAad },
    { name: "name with the payload AAD", target: "reveal_name_ct", key: K, wire: revealName, aad: payloadAad },
    {
      name: "K from Z only (the v1 derivation, no S): payload",
      target: "payload",
      key: kZOnlyV1,
      wire: payload,
      aad: payloadAad,
    },
    {
      name: "K from Z only (the v1 derivation, no S): reveal name",
      target: "reveal_name_ct",
      key: kZOnlyV1,
      wire: revealName,
      aad: nameAad,
    },
    { name: "K from Z only with the v2 label", target: "payload", key: kZOnlyV2, wire: payload, aad: payloadAad },
    {
      name: "S with one bit flipped: reveal name",
      target: "reveal_name_ct",
      key: kSFlipped,
      wire: revealName,
      aad: nameAad,
    },
    { name: "S with one bit flipped: payload", target: "payload", key: kSFlipped, wire: payload, aad: payloadAad },
    { name: "IKM in the wrong order (S || Z)", target: "payload", key: kSwapped, wire: payload, aad: payloadAad },
    { name: "K derived without salt h", target: "payload", key: kNoSalt, wire: payload, aad: payloadAad },
    {
      name: "K and AAD from a substituted transcript (epk_A)",
      target: "payload",
      key: kSub,
      wire: payload,
      aad: payloadAadOf(hSub),
    },
    {
      name: "right K, AAD with h in standard base64",
      target: "payload",
      key: K,
      wire: payload,
      aad: `sixkey-enroll-payload|2|${b64(h)}`,
    },
    {
      name: "right K, the v1 payload AAD",
      target: "payload",
      key: K,
      wire: payload,
      aad: `sixkey-enroll-payload|1|${b64u(h)}`,
    },
    {
      name: "right K, the v1 name AAD",
      target: "reveal_name_ct",
      key: K,
      wire: revealName,
      aad: `sixkey-enroll-name|1|${b64u(h)}`,
    },
    { name: "payload ciphertext byte flipped", target: "payload", key: K, wire: flipBit(payload, 40), aad: payloadAad },
    { name: "payload iv byte flipped", target: "payload", key: K, wire: flipBit(payload, 0), aad: payloadAad },
    {
      name: "reveal name tag byte flipped",
      target: "reveal_name_ct",
      key: K,
      wire: flipBit(revealName, revealName.length - 1),
      aad: nameAad,
    },
  ];
  const mustNotOpen = [];
  for (const d of mnoDefs) {
    const opens = await gcmOpens(d.key, d.wire.slice(0, 12), d.wire.slice(12), utf8(d.aad));
    assert(opens === false, d.name);
    mustNotOpen.push({ name: d.name, target: d.target, key_hex: hex(d.key), wire_b64: b64(d.wire), aad: d.aad, opens });
  }

  // The check bits are domain-separated: the same 16 bytes as a recovery code and as a pairing code.
  const asRecovery = await recoveryCodeText(S);
  const recoveryBits = await checkBits12("", S);
  const pairingBits = await checkBits12(PAIRING_TAG, S);
  assert(recoveryBits !== pairingBits && asRecovery !== code, "the two check-bit domains differ for S");
  await pairingCodeParse(asRecovery).then(
    () => assert(false, "a recovery code must not parse as a pairing code"),
    (e) => assert(e.message === "pairing_checksum", "recovery code as pairing code: checksum"),
  );
  await recoveryCodeParse(code).then(
    () => assert(false, "a pairing code must not parse as a recovery code"),
    (e) => assert(e.message === "recovery_checksum", "pairing code as recovery code: checksum"),
  );

  return {
    section: "§2.2, §3.2 (M1–M7, MUST 1–10), §8.1, §0.0aa",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib", "python-cryptography"],
    rule: "Enrolment v2 (revision 27). C = SHA-256(UTF-8(commit_input)); h = SHA-256(UTF-8(T)); Z = ECDH(esk, peer epk), 32 bytes; S = the approver's 16-byte pairing secret (shown as pairing_code, typed on the new device before reveal, never sent); K = HKDF(IKM = Z || S, salt = h, 'sixkey/v2/enroll-key', 256); SAS = uint32be(SHA-256(UTF-8('sixkey/v2/enroll-sas|') || h raw)[0..4]) mod 10^6, zero-padded to 6 digits. There is no confirmation code. In T and in the AADs every byte field is base64url without padding; in request bodies they are standard base64. rid is the lowercase hyphenated UUID. payload and the reveal name_ct travel as standard base64 of iv(12) || ciphertext || tag(16) (§3.2, §0.0d N6); the reveal name is padded to 160 bytes first, so its wire value is 188 bytes (§2.4, §0.0d N5).",
    inputs: {
      rid: RID,
      dev_n: DEV_N,
      dev_a: DEV_A,
      dpk_n_spki_b64: b64(dpkN),
      epk_n_b64: b64(epkN),
      epk_a_b64: b64(epkA),
      n_n_b64: b64(N_N),
      esk_n: "public_keys.keys[esk_N]",
      esk_a: "public_keys.keys[esk_A]",
      dsk_n: "public_keys.keys[dsk_N]",
      pairing_secret_hex: hex(S),
      pairing_code: code,
      ikm_hex: hex(ikm),
    },
    commit_input: cIn,
    commit_b64: cB64,
    transcript: T,
    h_hex: hex(h),
    h_b64: b64(h),
    h_b64u: b64u(h),
    z_hex: hex(zN),
    k_enroll_hex: hex(K),
    sas: sas.code,
    sas_u32: sas.u32,
    sig_pubkey_sha256_b64: b64(await sha256(dpkN)),
    reveal_name: {
      plaintext_padded_b64: name.padded_b64,
      aad: nameAad,
      iv_b64: b64(iv(0x41)),
      wire_b64: b64(revealName),
      wire_bytes: revealName.length,
    },
    payload: { plaintext: P, aad: payloadAad, iv_b64: b64(iv(0x42)), wire_b64: b64(payload) },
    substitutions,
    mitm,
    commit_checks: commitChecks,
    must_not_open: mustNotOpen,
    label_swap: {
      note: "The check bits are domain-separated (§3.2 MUST 10): the same 16 bytes as a recovery code (first 12 bits of SHA-256(S), no tag) and as a pairing code (SHA-256(UTF-8('sixkey-pairing-code|1|') || S)) differ in their check bits, so each is rejected where the other belongs (about 1 in 4096 would slip through for some other secret).",
      secret_hex: hex(S),
      as_pairing_code: code,
      as_recovery_code: asRecovery,
      pairing_check_bits: Number(pairingBits),
      recovery_check_bits: Number(recoveryBits),
      recovery_code_as_pairing_code: "pairing_checksum",
      pairing_code_as_recovery_code: "recovery_checksum",
    },
  };
}

async function genSas() {
  const cases = [];
  const add = async (name, h) => {
    const s = await sixDigits(SAS_TAG, h);
    cases.push({ name, h_hex: hex(h), sas_u32: s.u32, sas: s.code });
  };
  await add("h = 32 zero bytes", fill(0, 32));
  await add("h = 32 0xff bytes", fill(0xff, 32));
  const want = [
    ["SAS with a leading zero (< 100000)", (u) => u % 1e6 < 100_000],
    ["SAS with three leading zeros (< 1000)", (u) => u % 1e6 < 1000],
    ["uint32 >= 2^31 (a signed shift would go negative)", (u) => u >= 0x80000000],
    ["uint32 < 2^24 (top byte zero)", (u) => u < 0x1000000],
  ];
  for (const [j, [name, pred]] of want.entries()) {
    for (let i = 0; ; i++) {
      const seed = `sixkey-test-vector|sas-search-${j}|${i}`;
      const h = await sha256(utf8(seed));
      if (pred((await sixDigits(SAS_TAG, h)).u32)) {
        await add(`${name}; h = SHA-256('${seed}')`, h);
        break;
      }
    }
  }
  return {
    section: "§2.2, §3.2, §0.0aa",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib"],
    rule: "SAS = uint32be(SHA-256(UTF-8('sixkey/v2/enroll-sas|') || h)[0..4]) mod 10^6 (enrolment v2, revision 27). h is the raw 32-byte transcript hash. The value is the 6-digit zero-padded decimal string; the UI shows it as two groups of 3. The new device shows it, the approver types it (3 tries). There is no confirmation code since revision 27.",
    cases,
  };
}

async function genPairingCode() {
  const S = PAIRING_SECRET;
  const code = await pairingCodeText(S);
  const cases = [];
  for (const [name, secret] of [
    ["16 zero bytes", fill(0, 16)],
    ["16 0xff bytes", fill(0xff, 16)],
    ["the enrollment vectors' S", S],
    ["S with its last bit flipped", flipBit(S, 15)],
  ]) {
    const text = await pairingCodeText(secret);
    assert(hex(await pairingCodeParse(text)) === hex(secret), `round trip ${name}`);
    cases.push({
      name,
      secret_hex: hex(secret),
      code: text,
      check_bits: Number(await checkBits12(PAIRING_TAG, secret)),
    });
  }
  assert(/[01]/.test(code), "the fixed code holds a 0 or a 1, so the O/I/L reading is exercised");
  const flat = code.replace(/-/g, "");
  const equivalent = [
    code.toLowerCase(),
    code.replace(/-/g, " "),
    flat,
    code.replace(/0/g, "O").replace(/1/g, (_, i) => (i % 2 ? "I" : "L")),
    `  ${code}\n`,
    `${flat.slice(0, 14).toLowerCase()} - ${flat.slice(14)}`,
    code.replace(/-/g, "_"),
  ];
  for (const v of equivalent) assert(hex(await pairingCodeParse(v)) === hex(S), `equivalent ${JSON.stringify(v)}`);
  // A one-symbol typo that the 12 check bits catch (searched deterministically), and other formats.
  let typo = null;
  for (let i = 0; i < 28 && !typo; i++) {
    for (const ch of CROCKFORD) {
      if (ch === flat[i]) continue;
      const cand = (flat.slice(0, i) + ch + flat.slice(i + 1)).match(/.{4}/g).join("-");
      const r = await pairingCodeParse(cand).then(
        () => null,
        (e) => e.message,
      );
      if (r === "pairing_checksum") {
        typo = cand;
        break;
      }
    }
  }
  const recoveryOfS = await recoveryCodeText(S);
  const otherRecovery = await recoveryCodeText(RECOVERY_SECRET);
  const rejected = [
    { input: typo, error: "pairing_checksum", why: "one symbol mistyped; the check bits catch it" },
    { input: code.slice(0, -1), error: "pairing_length", why: "27 symbols" },
    { input: `${code}0`, error: "pairing_length", why: "29 symbols" },
    { input: "", error: "pairing_length", why: "empty" },
    { input: `${code.slice(0, -1)}U`, error: "pairing_char", why: "U is not a Crockford symbol" },
    { input: `${code.slice(0, -1)}*`, error: "pairing_char", why: "not a symbol" },
    {
      input: recoveryOfS,
      error: "pairing_checksum",
      why: "the same secret formatted as a recovery code (no tag in its check bits)",
    },
    {
      input: otherRecovery,
      error: "pairing_checksum",
      why: "the recovery_auth group's recovery code typed where the pairing code belongs",
    },
  ];
  for (const r of rejected) {
    const got = await pairingCodeParse(r.input).then(
      () => "accepted",
      (e) => e.message,
    );
    assert(got === r.error, `rejected ${JSON.stringify(r.input)}: ${got}`);
  }
  return {
    section: "§2.2, §3.2 MUST 10, §0.0aa",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib"],
    rule: "The pairing code shows the 16-byte pairing secret S like a recovery code: n = S (128 bits) << 12 | check, where check = the first 12 bits of SHA-256(UTF-8('sixkey-pairing-code|1|') || S); 28 Crockford base32 symbols (0123456789ABCDEFGHJKMNPQRSTVWXYZ), most significant first, shown as 7 groups of 4 joined by '-'. Reading: upper-case, drop whitespace, '-' and '_', read O as 0 and I and L as 1; then not 28 symbols is pairing_length, a symbol outside the alphabet pairing_char, wrong check bits pairing_checksum. All three are local (no attempt used, no state change); a recovery code is rejected by its check bits.",
    cases,
    code,
    equivalent_inputs: equivalent,
    rejected_inputs: rejected,
  };
}

const EMPTY_SHA256_B64U = "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU";

function signingInput(c) {
  for (const k of ["host", "method", "target", "signer", "sub"]) if (c[k].includes("|")) throw new Error(`'|' in ${k}`);
  if (!c.target.startsWith("/")) throw new Error("target must start with /");
  if (!/^[A-Z]+$/.test(c.method)) throw new Error("method must be uppercase");
  if (!/^[0-9]+$/.test(String(c.ts))) throw new Error("ts must be decimal");
  return `sixkey-req|1|${c.host}|${c.method}|${c.target}|${c.signer}|${c.sub}|${c.ts}|${c.body_sha256_b64u}`;
}

function reuseSignature(name, input, spki) {
  const old = previous?.groups?.request_signature?.cases?.find((c) => c.name === name);
  return old && old.signing_input === input && old.signer_key_spki_b64 === b64(spki) ? old.sig_p1363_b64u : null;
}

async function genRequestSignature(envelopeText, writeProof) {
  const putBody = JSON.stringify({
    if_version: 41,
    envelope: envelopeText,
    write_proof: writeProof,
    cursor: { pending: b64(fill(0x77, 16)) },
  });
  const nameBody = JSON.stringify({
    name_ct: { vkId: "0000000000000000", iv: b64(iv(0x21)), ct: b64(fill(0, 176)) },
    password_auth: b64(fill(0x88, 32)),
  });
  const defs = [
    {
      name: "device GET, no body",
      key: "dsk_A",
      host: "api.sixkey.app",
      method: "GET",
      target: "/v1/sync/status",
      signer: DEV_A,
      sub: "-",
      ts: NOW,
      body: "",
    },
    {
      name: "device PUT /v1/vault with a JSON body",
      key: "dsk_A",
      host: "api.sixkey.app",
      method: "PUT",
      target: "/v1/vault",
      signer: DEV_A,
      sub: "-",
      ts: NOW,
      body: putBody,
    },
    {
      name: "registration: account session + new key (init)",
      key: "dsk_N",
      host: "api.sixkey.app",
      method: "POST",
      target: "/v1/vault/init",
      signer: DEV_N,
      sub: SUB,
      ts: NOW,
      body: '{"vault_id":"test-vault-0001"}',
    },
    {
      name: "enrolling device polls its request",
      key: "dsk_N",
      host: "api.sixkey.app",
      method: "GET",
      target: `/v1/enroll/requests/${RID}`,
      signer: `enroll:${RID}`,
      sub: "-",
      ts: NOW,
      body: "",
    },
    {
      name: "device + account session (DELETE /v1/account)",
      key: "dsk_A",
      host: "api.sixkey.app",
      method: "DELETE",
      target: "/v1/account",
      signer: DEV_A,
      sub: SUB,
      ts: NOW,
      body: '{"password_auth":"iIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIg="}',
    },
    {
      name: "non-ASCII body bytes, path with a device id",
      key: "dsk_A",
      host: "api.sixkey.app",
      method: "PATCH",
      target: `/v1/devices/${DEV_N}`,
      signer: DEV_A,
      sub: "-",
      ts: NOW,
      body: nameBody.replace("0000000000000000", "设备"),
    },
    {
      name: "raw target keeps the query string and percent-encoding verbatim",
      key: "dsk_A",
      host: "api.sixkey.app",
      method: "GET",
      target: "/v1/sync/status?b=2&a=%7C",
      signer: DEV_A,
      sub: "-",
      ts: NOW,
      body: "",
    },
    {
      name: "e2e origin: host includes the non-default port (§5.2, §0.0d N9)",
      key: "dsk_A",
      host: "127.0.0.1:8787",
      method: "GET",
      target: "/v1/sync/status",
      signer: DEV_A,
      sub: "-",
      ts: NOW,
      body: "",
    },
  ];
  const cases = [];
  for (const d of defs) {
    const k = KEYS[d.key];
    const spki = await spkiOf(k.point);
    const bodyHash = b64u(await sha256(utf8(d.body)));
    const input = signingInput({ ...d, body_sha256_b64u: bodyHash });
    let sigU = reuseSignature(d.name, input, spki);
    if (!sigU || !(await ecdsaVerify(spki, fromB64uStrict(sigU), utf8(input))))
      sigU = b64u(await ecdsaSign(k, utf8(input)));
    const sig = fromB64uStrict(sigU);
    assert(await ecdsaVerify(spki, sig, utf8(input)), "fresh signature verifies");
    cases.push({
      name: d.name,
      signer_key: d.key,
      signer_key_spki_b64: b64(spki),
      host: d.host,
      method: d.method,
      target: d.target,
      signer: d.signer,
      sub: d.sub,
      ts: d.ts,
      body: d.body,
      body_sha256_b64u: bodyHash,
      signing_input: input,
      sig_p1363_b64u: sigU,
      sig_der_hex: hex(p1363ToDer(sig)),
    });
  }
  assert(cases[0].body_sha256_b64u === EMPTY_SHA256_B64U, "empty body hash");

  // Verification negatives against case 0 (and one against case 2).
  const c0 = cases[0];
  const sig0 = fromB64uStrict(c0.sig_p1363_b64u);
  const flip = sig0.slice();
  flip[10] ^= 0x01;
  const alter = (patch) => signingInput({ ...c0, ...patch });
  const verify = [
    {
      name: "as signed",
      signing_input: c0.signing_input,
      sig_p1363_b64u: c0.sig_p1363_b64u,
      key_spki_b64: c0.signer_key_spki_b64,
      valid: true,
    },
    {
      name: "one signature bit flipped",
      signing_input: c0.signing_input,
      sig_p1363_b64u: b64u(flip),
      key_spki_b64: c0.signer_key_spki_b64,
      valid: false,
    },
    {
      name: "other target",
      signing_input: alter({ target: "/v1/vault" }),
      sig_p1363_b64u: c0.sig_p1363_b64u,
      key_spki_b64: c0.signer_key_spki_b64,
      valid: false,
    },
    {
      name: "other host (proxy Host header used instead of the configured host)",
      signing_input: alter({ host: "sixkey-api.internal" }),
      sig_p1363_b64u: c0.sig_p1363_b64u,
      key_spki_b64: c0.signer_key_spki_b64,
      valid: false,
    },
    {
      name: "other method",
      signing_input: alter({ method: "POST" }),
      sig_p1363_b64u: c0.sig_p1363_b64u,
      key_spki_b64: c0.signer_key_spki_b64,
      valid: false,
    },
    {
      name: "sub added",
      signing_input: alter({ sub: SUB }),
      sig_p1363_b64u: c0.sig_p1363_b64u,
      key_spki_b64: c0.signer_key_spki_b64,
      valid: false,
    },
    {
      name: "other ts",
      signing_input: alter({ ts: NOW + 1 }),
      sig_p1363_b64u: c0.sig_p1363_b64u,
      key_spki_b64: c0.signer_key_spki_b64,
      valid: false,
    },
    {
      name: "other signer",
      signing_input: alter({ signer: DEV_N }),
      sig_p1363_b64u: c0.sig_p1363_b64u,
      key_spki_b64: c0.signer_key_spki_b64,
      valid: false,
    },
    {
      name: "body changed",
      signing_input: alter({ body_sha256_b64u: b64u(await sha256(utf8("{}"))) }),
      sig_p1363_b64u: c0.sig_p1363_b64u,
      key_spki_b64: c0.signer_key_spki_b64,
      valid: false,
    },
    {
      name: "right input, another device's key",
      signing_input: c0.signing_input,
      sig_p1363_b64u: c0.sig_p1363_b64u,
      key_spki_b64: cases[2].signer_key_spki_b64,
      valid: false,
    },
  ];
  for (const v of verify)
    assert(
      (await ecdsaVerify(fromB64(v.key_spki_b64), fromB64uStrict(v.sig_p1363_b64u), utf8(v.signing_input))) === v.valid,
      v.name,
    );

  const nBytes = fromHex(P256_N.toString(16));
  const formatReject = [
    { name: "DER signature in the header", sig_b64u: b64u(fromHex(c0.sig_der_hex)) },
    { name: "63 bytes", sig_b64u: b64u(sig0.slice(0, 63)) },
    { name: "65 bytes", sig_b64u: b64u(concat(sig0, Uint8Array.of(0))) },
    { name: "r = 0", sig_b64u: b64u(concat(fill(0, 32), sig0.slice(32))) },
    { name: "s = 0", sig_b64u: b64u(concat(sig0.slice(0, 32), fill(0, 32))) },
    { name: "r = n", sig_b64u: b64u(concat(nBytes, sig0.slice(32))) },
    { name: "s = n", sig_b64u: b64u(concat(sig0.slice(0, 32), nBytes)) },
  ];
  for (const f of formatReject) assert(!p1363FormatOk(fromB64uStrict(f.sig_b64u)), f.name);

  const conv = [
    ["no high bits", concat(fill(0x7f, 32), fill(0x01, 32))],
    ["both high bits set (0x00 prefix)", concat(fill(0x80, 32), fill(0xff, 32))],
    ["leading zero bytes stripped", concat(fill(0, 2), fill(0x12, 30), fill(0, 31), Uint8Array.of(0x01))],
    ["r = s = 1", concat(fill(0, 31), Uint8Array.of(1), fill(0, 31), Uint8Array.of(1))],
    ["leading zero then a high bit", concat(Uint8Array.of(0), fill(0x80, 31), fill(0x55, 32))],
  ].map(([name, s]) => ({ name, p1363_hex: hex(s), der_hex: hex(p1363ToDer(s)) }));

  const inputReject = [
    {
      name: "'|' in the target",
      host: "api.sixkey.app",
      method: "GET",
      target: "/v1/devices/a|b",
      signer: DEV_A,
      sub: "-",
      ts: NOW,
    },
    {
      name: "target without a leading slash",
      host: "api.sixkey.app",
      method: "GET",
      target: "v1/sync/status",
      signer: DEV_A,
      sub: "-",
      ts: NOW,
    },
    {
      name: "lowercase method",
      host: "api.sixkey.app",
      method: "get",
      target: "/v1/sync/status",
      signer: DEV_A,
      sub: "-",
      ts: NOW,
    },
    {
      name: "'|' in the host",
      host: "api.sixkey.app|evil",
      method: "GET",
      target: "/v1/sync/status",
      signer: DEV_A,
      sub: "-",
      ts: NOW,
    },
  ];
  for (const r of inputReject) {
    let threw = false;
    try {
      signingInput({ ...r, body_sha256_b64u: EMPTY_SHA256_B64U });
    } catch {
      threw = true;
    }
    assert(threw, r.name);
  }

  return {
    section: "§2.2, §5.2, §8.4",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib", "python-cryptography"],
    rule: "input = 'sixkey-req|1|{host}|{METHOD}|{target}|{signer}|{sub}|{ts}|{base64url(SHA-256(body bytes))}'. host = configured API host (URL.host: lowercase, port only when non-default); target = raw request target (path + query, verbatim, never containing '|'); signer = deviceId or 'enroll:{rid}'; sub = JWT sub when the request carries an account session, else '-'; ts = the Sixkey-Ts header (decimal ms). No body = SHA-256 of zero bytes. Signature: ECDSA P-256 / SHA-256, IEEE P1363 r||s (64 bytes), base64url in Sixkey-Sig. The server converts to DER for verification.",
    empty_body_sha256_b64u: EMPTY_SHA256_B64U,
    cases,
    verify,
    signature_format_reject: formatReject,
    p1363_to_der: conv,
    signing_input_reject: inputReject,
  };
}

/** §2.3, §5.4 (§0.0d N20): every number token is an integer literal within ±(2^53 - 1); no fraction, no exponent. */
function integerTokensOnly(text) {
  let i = 0;
  let inStr = false;
  const num = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i += 2;
      else {
        if (c === '"') inStr = false;
        i++;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      i++;
      continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      num.lastIndex = i;
      const m = num.exec(text);
      if (!m || m[1] || m[2]) return false;
      const v = BigInt(m[0]);
      if (v > 9007199254740991n || v < -9007199254740991n) return false;
      i += m[0].length;
      continue;
    }
    i++;
  }
  return true;
}

async function genNumberTokens(kbRaw) {
  const variant = (from, to) => {
    assert(kbRaw.includes(from), `number token variant: ${from}`);
    return kbRaw.split(from).join(to);
  };
  assert(1.7920512e12 === AT, "the exponent form names the same instant");
  const same = (text) => canonicalJson(JSON.parse(text)) === canonicalJson(JSON.parse(kbRaw));
  const bundleCases = [
    { name: "the bundle as uploaded", text: kbRaw, integer_only: true },
    { name: "bundle with kver written as 3.0", text: variant('"kver":3,', '"kver":3.0,'), integer_only: false },
    {
      name: "bundle with at in exponent form (1.7920512e12, the same instant)",
      text: variant(`"at":${AT},`, '"at":1.7920512e12,'),
      integer_only: false,
    },
    {
      name: "bundle with every iterations written as 6e5",
      text: variant('"iterations":600000', '"iterations":6e5'),
      integer_only: false,
    },
  ].map((c) => ({ ...c, same_value_after_json_parse: same(c.text) }));
  for (const c of bundleCases.slice(1)) assert(c.same_value_after_json_parse, `${c.name}: JSON.parse hides the token`);
  const other = [
    { name: "request body with if_kver written as 2.0", text: '{"if_kver":2.0,"bundle":"{}"}', integer_only: false },
    { name: "exponent 1e3", text: '{"n":1e3}', integer_only: false },
    { name: "exponent 1E3", text: '{"n":1E3}', integer_only: false },
    { name: "fraction -1.5", text: '{"n":-1.5}', integer_only: false },
    { name: "integer above 2^53 - 1", text: '{"n":9007199254740993}', integer_only: false },
    { name: "the safe-integer bounds", text: '{"n":9007199254740991,"m":-9007199254740991}', integer_only: true },
    { name: "negative, zero, nested arrays", text: '{"n":-1,"z":0,"a":[1,[2,3]]}', integer_only: true },
    {
      name: "number-like text inside strings is not a token",
      text: '{"s":"3.0 and 1e3 in a string","q":"\\"2.5\\"","k":"1.5e3"}',
      integer_only: true,
    },
  ];
  const cases = [...bundleCases, ...other];
  for (const c of cases) {
    JSON.parse(c.text);
    assert(integerTokensOnly(c.text) === c.integer_only, `number tokens: ${c.name}`);
  }
  return {
    section: "§2.3, §5.4 (§0.0d N20)",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib"],
    rule: "Every number in a KeyBundle, the enrollment payload and every request body is a safe integer written as an integer literal: no fraction, no exponent, |n| <= 2^53 - 1. The server rejects any other number token with 422 invalid_request. The check is on the raw text: JSON.parse turns 3.0, 1.7920512e12 and 6e5 into integers, so a check on parsed values would miss them (same_value_after_json_parse). Python: json.loads with parse_float and parse_constant raising and parse_int range-checked.",
    cases,
  };
}

async function genForkSignature(g) {
  const oldK = KEYS.dsk_A;
  const newK = KEYS.dsk_F;
  const oldSpki = await spkiOf(oldK.point);
  const newSpki = await spkiOf(newK.point);
  const vkId = await vkIdOf(VK1);
  const kName = await hkdf(VK1, EMPTY, "sixkey/v1/device-name", 256);
  const nameRule = deviceNameRule("Forked profile");
  const nameAad = `sixkey-devname|1|${VAULT_ID}|${vkId}|${DEV_F}`;
  const nameCt = await gcmEncrypt(kName, iv(0x24), fromB64(nameRule.padded_b64), utf8(nameAad));
  const bodyOf = (newId) =>
    JSON.stringify({
      new_device_id: newId,
      new_sig_pubkey: b64(newSpki),
      name_ct: { vkId, iv: b64(iv(0x24)), ct: b64(nameCt) },
      password_auth: g.password_auth.cases[0].password_auth_b64,
    });
  const body = bodyOf(DEV_F);
  const base = { host: "api.sixkey.app", method: "POST", target: "/v1/devices/fork", signer: DEV_A, sub: "-", ts: NOW };
  const inputFor = async (b, signer = DEV_A) =>
    signingInput({ ...base, signer, body_sha256_b64u: b64u(await sha256(utf8(b))) });
  const input = await inputFor(body);
  const prev = previous?.groups?.fork_signature;
  const keep = async (field, spki) => {
    const s = prev && prev.signing_input === input ? prev[field] : null;
    return s && (await ecdsaVerify(spki, fromB64uStrict(s), utf8(input))) ? s : null;
  };
  const sig = (await keep("sixkey_sig_b64u", oldSpki)) ?? b64u(await ecdsaSign(oldK, utf8(input)));
  const newSig = (await keep("sixkey_new_sig_b64u", newSpki)) ?? b64u(await ecdsaSign(newK, utf8(input)));
  const verify = [
    {
      name: "Sixkey-Sig with the current DSK",
      signing_input: input,
      sig_p1363_b64u: sig,
      key_spki_b64: b64(oldSpki),
      valid: true,
    },
    {
      name: "Sixkey-New-Sig with the body's new_sig_pubkey",
      signing_input: input,
      sig_p1363_b64u: newSig,
      key_spki_b64: b64(newSpki),
      valid: true,
    },
    {
      name: "Sixkey-New-Sig checked with the current DSK",
      signing_input: input,
      sig_p1363_b64u: newSig,
      key_spki_b64: b64(oldSpki),
      valid: false,
    },
    {
      name: "Sixkey-Sig checked with the new key",
      signing_input: input,
      sig_p1363_b64u: sig,
      key_spki_b64: b64(newSpki),
      valid: false,
    },
    {
      name: "Sixkey-New-Sig against a body with another new_device_id",
      signing_input: await inputFor(bodyOf(DEV_S)),
      sig_p1363_b64u: newSig,
      key_spki_b64: b64(newSpki),
      valid: false,
    },
    {
      name: "Sixkey-New-Sig against the input with the new id as signer",
      signing_input: await inputFor(body, DEV_F),
      sig_p1363_b64u: newSig,
      key_spki_b64: b64(newSpki),
      valid: false,
    },
  ];
  for (const v of verify)
    assert(
      (await ecdsaVerify(fromB64(v.key_spki_b64), fromB64uStrict(v.sig_p1363_b64u), utf8(v.signing_input))) === v.valid,
      v.name,
    );
  return {
    section: "§4.10, §5.2, §5.4 (§0.0d N1)",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib", "python-cryptography"],
    rule: "POST /v1/devices/fork carries two signatures over ONE signing input (the normal one, with the current deviceId as signer): Sixkey-Sig by the current DSK, verified with the device row's key, and Sixkey-New-Sig by the new private key, verified with the body's new_sig_pubkey. Both headers are base64url P1363 (64 bytes). The body has no new_sig member. A missing or wrong Sixkey-New-Sig is 401 bad_signature.",
    signer_device: DEV_A,
    new_device_id: DEV_F,
    old_key_spki_b64: b64(oldSpki),
    new_key_spki_b64: b64(newSpki),
    name: { name: "Forked profile", aad: nameAad },
    ...base,
    body,
    body_sha256_b64u: b64u(await sha256(utf8(body))),
    signing_input: input,
    sixkey_sig_b64u: sig,
    sixkey_new_sig_b64u: newSig,
    verify,
  };
}

async function envelopeFor(vk, rev, ivB, plaintext) {
  const vkId = await vkIdOf(vk);
  const aad = `sixkey-vault|1|${VAULT_ID}|${vkId}|${rev}`;
  const ct = await gcmEncrypt(await hkdf(vk, EMPTY, "sixkey/v1/vault-enc", 256), ivB, utf8(plaintext), utf8(aad));
  return {
    format: "sixkey-vault",
    formatVersion: 1,
    cipher: "AES-256-GCM",
    vaultId: VAULT_ID,
    vkId,
    rev,
    iv: b64(ivB),
    ciphertext: b64(ct),
    checksum: b64(await sha256(utf8(aad), ivB, ct)),
  };
}

async function genRotateRepair(g) {
  const vk0Id = await vkIdOf(VK0);
  const vk1Id = await vkIdOf(VK1);
  const vk2Id = await vkIdOf(VK2);
  const SECRET2 = seq(0x90, 16);
  const SALT_REC2 = seq(0x80, 16);
  const SALT_KEK2 = seq(0x70, 16);
  const SALT_AUTH2 = seq(0x60, 16);
  const code2 = await recoveryCodeText(SECRET2);
  const kdfPw = { name: "PBKDF2", hash: "SHA-256", iterations: ITER, salt: b64(SALT_KEK2), v: 1 };
  const kdfRec = { name: "HKDF", hash: "SHA-256", salt: b64(SALT_REC2), v: 1 };
  const aadPw = `sixkey-wrap|1|password|${vk2Id}|${VAULT_ID}|PBKDF2-SHA256:${ITER}:${kdfPw.salt}`;
  const aadRec = `sixkey-wrap|1|recovery|${vk2Id}|${VAULT_ID}|HKDF-SHA256:${kdfRec.salt}`;
  const kekPw = await pbkdf2(utf8(PASSWORD), SALT_KEK2, ITER, 256);
  const kekRec = await hkdf(SECRET2, SALT_REC2, "sixkey/v1/kek-recovery", 256);
  const kekPrev = await hkdf(VK2, EMPTY, "sixkey/v1/kek-previous", 256);
  const prevOf = async (old, oldId, ivByte, createdAt) => ({
    vkId: oldId,
    iv: b64(iv(ivByte)),
    wrapped: b64(await gcmEncrypt(kekPrev, iv(ivByte), old, utf8(`sixkey-prev|1|${VAULT_ID}|${vk2Id}|${oldId}`))),
    createdAt,
  });
  const keyring2 = {
    format: "sixkey-keyring",
    v: 1,
    vaultId: VAULT_ID,
    vkId: vk2Id,
    wraps: [
      {
        method: "password",
        vkId: vk2Id,
        iv: b64(iv(0x51)),
        wrapped: b64(await gcmEncrypt(kekPw, iv(0x51), VK2, utf8(aadPw))),
        createdAt: AT,
        kdf: kdfPw,
      },
      {
        method: "recovery",
        vkId: vk2Id,
        iv: b64(iv(0x52)),
        wrapped: b64(await gcmEncrypt(kekRec, iv(0x52), VK2, utf8(aadRec))),
        createdAt: AT,
        kdf: kdfRec,
      },
    ],
    previous: [await prevOf(VK0, vk0Id, 0x53, AT - 86_400_000), await prevOf(VK1, vk1Id, 0x54, AT)],
  };
  const server = {
    version: g.envelope.rev,
    kver: g.keybundle.bundle.kver,
    vk_id: vk1Id,
    head_b64: g.envelope.head_b64,
  };
  const device = { max_seen_kver: 6 }; // what this device saw before the server was rolled back
  const bundle2 = await signBundle(
    {
      format: "sixkey-keybundle",
      v: 1,
      vaultId: VAULT_ID,
      kver: publishKver(server.kver, device.max_seen_kver),
      keyring: keyring2,
      auth: { kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITER, salt: b64(SALT_AUTH2), v: 1 } },
      by: DEV_A,
      at: AT,
    },
    await hkdf(VK2, EMPTY, "sixkey/v1/keybundle-mac", 256),
  );
  const plaintext = '{"schemaVersion":1,"vaultId":"test-vault-0001","entries":[]}';
  const envelope2 = await envelopeFor(VK2, server.version + 1, iv(0x0f), plaintext);
  const kWrite1 = await hkdf(VK1, EMPTY, "sixkey/v1/vault-write", 256);
  const writeInput = `sixkey-write|1|${VAULT_ID}|${server.version}|${envelope2.checksum}`;
  const pwAuthServer = await hkdf(
    await pbkdf2(utf8(PASSWORD), SALT_AUTH, ITER, 256),
    EMPTY,
    "sixkey/v1/password-auth",
    256,
  );
  assert(
    b64(pwAuthServer) === g.password_auth.cases[0].password_auth_b64,
    "pw_auth follows the rolled-back bundle's auth.kdf",
  );
  const pwAuth2 = await hkdf(
    await pbkdf2(utf8(PASSWORD), SALT_AUTH2, ITER, 256),
    EMPTY,
    "sixkey/v1/password-auth",
    256,
  );
  const recAuth2 = await hkdf(SECRET2, EMPTY, "sixkey/v1/recovery-auth", 256);
  const kName2 = await hkdf(VK2, EMPTY, "sixkey/v1/device-name", 256);
  const deviceNames = [];
  for (const [dev, ivByte, name] of [
    [DEV_A, 0x55, "Work profile 3"],
    [DEV_N, 0x56, "Chrome 配置文件"],
  ]) {
    const aad = `sixkey-devname|1|${VAULT_ID}|${vk2Id}|${dev}`;
    deviceNames.push({
      device_id: dev,
      name_ct: {
        vkId: vk2Id,
        iv: b64(iv(ivByte)),
        ct: b64(await gcmEncrypt(kName2, iv(ivByte), fromB64(deviceNameRule(name).padded_b64), utf8(aad))),
      },
    });
  }
  const request = {
    if_version: server.version,
    if_kver: server.kver,
    envelope: JSON.stringify(envelope2),
    write_proof: b64(await hmac(kWrite1, utf8(writeInput))),
    new_write_key: b64(await hkdf(VK2, EMPTY, "sixkey/v1/vault-write", 256)),
    bundle: JSON.stringify(bundle2),
    password_auth: b64(pwAuthServer),
    recovery_verifier: b64(await sha256(utf8("sixkey-recovery-verifier|1|"), recAuth2)),
    password_verifier: b64(await sha256(utf8("sixkey-password-verifier|1|"), pwAuth2)),
    device_names: deviceNames,
  };
  assert(envelope2.vkId === keyring2.vkId && keyring2.vkId !== server.vk_id, "repair publishes this device's VK");
  return {
    section: "§4.2 (以本机为准修复云端, §0.0d N24), §3.8 P3, §5.4",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib", "python-cryptography"],
    rule: "Repair is a rotate that does not change this device's VK: the server was rolled back to the state of the envelope and keybundle groups (VK1, kver 3), while this device holds VK2 and keyring2 (previous contains VK1). envelope and bundle.keyring use VK2 and may differ from the server's vk_id; if_version / if_kver are the server's values and bundle.kver = publishKver(server kver, maxSeenKver) = min(max(3, 6) + 1, 3 + KVER_MAX_JUMP) = 7 (§3.9 R1, §0.0e N27, §0.0f F-01); write_proof uses K_write of VK1 (the server's current write_key); new_write_key is K_write of VK2; password_auth follows the rolled-back bundle's auth.kdf; recovery_verifier is required and comes from a recovery code the user types (or a new one), since the device never stores the code (I9); password_verifier uses the new auth salt.",
    password: PASSWORD,
    server,
    device,
    recovery_secret2_hex: hex(SECRET2),
    recovery_code2: code2,
    plaintext,
    write_input: writeInput,
    aad: { password: aadPw, recovery: aadRec },
    request,
  };
}

/** §2.3, §3.9 R0/R1 (§0.0f F-01): the largest kver jump the server accepts and a known maxSeenKver lets raise it. */
const KVER_MAX_JUMP = 65536;

/** §3.9 R1 (§0.0e N27, §0.0f F-01): min(max(server kver, maxSeenKver) + 1, server kver + KVER_MAX_JUMP); not a safe integer -> kver_overflow. */
function publishKver(serverKver, maxSeenKver) {
  const next = Math.min(Math.max(serverKver, maxSeenKver) + 1, serverKver + KVER_MAX_JUMP);
  if (!Number.isSafeInteger(next)) throw new Error("kver_overflow");
  return next;
}

/** §2.3, §3.6.0, §5.3: app-layer check if_kver < kver <= if_kver + KVER_MAX_JUMP (422), then the CAS on if_kver; a failed CAS with the same text is 200. */
function serverAccept({ server_kver, if_kver, kver, raw_equals_stored }) {
  if (!(kver > if_kver && kver <= if_kver + KVER_MAX_JUMP)) return "422 invalid_request";
  if (if_kver !== server_kver) return raw_equals_stored ? "200 idempotent" : "409 keys_conflict";
  return "200 applied";
}

/**
 * §3.9 R0/R1 (§0.0e N27, §0.0f F-01): only kver > maxSeenKver can be adopted; at or below it, same content is in sync and
 * different content is keys_behind. A jump past maxSeenKver + KVER_MAX_JUMP counts as at or below it, unless maxSeenKver is 0.
 */
function adoption(maxSeen, kver, same) {
  if (kver > maxSeen && (maxSeen === 0 || kver <= maxSeen + KVER_MAX_JUMP))
    return same
      ? { outcome: "in_sync", max_seen_after: kver }
      : { outcome: "adopt_candidate", max_seen_after_adoption: kver };
  return same
    ? { outcome: "in_sync", max_seen_after: maxSeen }
    : { outcome: "keys_behind", max_seen_after: maxSeen, r3_unlock_needs_confirmation: true };
}

async function genKeysRepair(g) {
  const vk1Id = await vkIdOf(VK1);
  const SECRET3 = seq(0xe0, 16);
  const SALT_REC3 = seq(0x50, 16);
  const SALT_KEK3 = seq(0x44, 16);
  const SALT_AUTH3 = seq(0x34, 16);
  const code3 = await recoveryCodeText(SECRET3);
  const kdfPw = { name: "PBKDF2", hash: "SHA-256", iterations: ITER, salt: b64(SALT_KEK3), v: 1 };
  const kdfRec = { name: "HKDF", hash: "SHA-256", salt: b64(SALT_REC3), v: 1 };
  const aadPw = `sixkey-wrap|1|password|${vk1Id}|${VAULT_ID}|PBKDF2-SHA256:${ITER}:${kdfPw.salt}`;
  const aadRec = `sixkey-wrap|1|recovery|${vk1Id}|${VAULT_ID}|HKDF-SHA256:${kdfRec.salt}`;
  const kekPw = await pbkdf2(utf8(PASSWORD), SALT_KEK3, ITER, 256);
  const kekRec = await hkdf(SECRET3, SALT_REC3, "sixkey/v1/kek-recovery", 256);
  // This device's keyring (same VK1): it changed password and recovery code before the server lost that change.
  const keyring = {
    format: "sixkey-keyring",
    v: 1,
    vaultId: VAULT_ID,
    vkId: vk1Id,
    wraps: [
      {
        method: "password",
        vkId: vk1Id,
        iv: b64(iv(0x61)),
        wrapped: b64(await gcmEncrypt(kekPw, iv(0x61), VK1, utf8(aadPw))),
        createdAt: AT,
        kdf: kdfPw,
      },
      {
        method: "recovery",
        vkId: vk1Id,
        iv: b64(iv(0x62)),
        wrapped: b64(await gcmEncrypt(kekRec, iv(0x62), VK1, utf8(aadRec))),
        createdAt: AT,
        kdf: kdfRec,
      },
    ],
    previous: JSON.parse(JSON.stringify(g.keybundle.bundle.keyring.previous)),
  };
  const server = { kver: g.keybundle.bundle.kver, vk_id: vk1Id };
  const device = { max_seen_kver: 6 };
  const kver = publishKver(server.kver, device.max_seen_kver);
  const bundle = await signBundle({
    format: "sixkey-keybundle",
    v: 1,
    vaultId: VAULT_ID,
    kver,
    keyring,
    auth: { kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITER, salt: b64(SALT_AUTH3), v: 1 } },
    by: DEV_A,
    at: AT,
  });
  const pwAuth3 = await hkdf(
    await pbkdf2(utf8(PASSWORD), SALT_AUTH3, ITER, 256),
    EMPTY,
    "sixkey/v1/password-auth",
    256,
  );
  const recAuth3 = await hkdf(SECRET3, EMPTY, "sixkey/v1/recovery-auth", 256);
  const request = {
    if_kver: server.kver,
    bundle: JSON.stringify(bundle),
    password_auth: g.password_auth.cases[0].password_auth_b64, // pw_auth under the server's (rolled-back) auth.kdf
    recovery_verifier: b64(await sha256(utf8("sixkey-recovery-verifier|1|"), recAuth3)),
    password_verifier: b64(await sha256(utf8("sixkey-password-verifier|1|"), pwAuth3)),
  };
  assert(
    kver > request.if_kver &&
      serverAccept({ server_kver: server.kver, if_kver: request.if_kver, kver, raw_equals_stored: false }) ===
        "200 applied",
    "repair accepted",
  );
  // P4 (§2.3, §0.0f S-2): which verifiers a key request must carry, judged against the server's current bundle (the
  // keybundle group). A wrap "changed" when its iv or wrapped bytes did; createdAt and the other members do not count.
  const sb = g.keybundle.bundle;
  const repl = (kr, method, w) => ({ ...kr, wraps: kr.wraps.map((x) => (x.method === method ? w : x)) });
  const mw = (m) => keyring.wraps.find((w) => w.method === m);
  const p4 = async (name, kr, auth, expect) => ({
    name,
    bundle: JSON.stringify(await signBundle({ ...sb, kver: kver, keyring: kr, auth, mac: undefined })),
    expect,
  });
  const newAuth = { kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITER, salt: b64(SALT_AUTH3), v: 1 } };
  const p4Cases = [
    await p4("password and recovery wraps changed, auth.kdf changed (the repair above)", keyring, newAuth, {
      recovery_verifier: true,
      password_verifier: true,
    }),
    await p4("only the recovery wrap changed", repl(sb.keyring, "recovery", mw("recovery")), sb.auth, {
      recovery_verifier: true,
      password_verifier: false,
    }),
    await p4(
      "both wraps differ only in createdAt (truncation): not a change",
      { ...sb.keyring, wraps: sb.keyring.wraps.map((w) => ({ ...w, createdAt: w.createdAt + 3_600_000 })) },
      sb.auth,
      { recovery_verifier: false, password_verifier: false },
    ),
    await p4("auth.kdf changed without the password wrap", sb.keyring, newAuth, "422 invalid_request"),
    await p4(
      "the password wrap changed but auth.kdf did not",
      repl(sb.keyring, "password", mw("password")),
      sb.auth,
      "422 invalid_request",
    ),
  ];
  for (const c of p4Cases)
    assert(JSON.stringify(p4Expect(sb, JSON.parse(c.bundle))) === JSON.stringify(c.expect), `P4 case ${c.name}`);
  return {
    section: "§4.2 (只有 bundle 回档), §3.9 R1, §3.6.0, §5.4 PUT /v1/keys (§0.0e N27)",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib", "python-cryptography"],
    rule: "Same-VK repair through PUT /v1/keys: the server's bundle went back (keybundle group, VK1, kver 3) while this device holds a newer VK1 keyring (new password and recovery wraps) and saw kver 6, so it is in keys_behind. It republishes its own keyring with if_kver = the server's kver and bundle.kver = publishKver(3, 6) = min(max(3, 6) + 1, 3 + KVER_MAX_JUMP) = 7 (a jump, accepted because if_kver < kver <= if_kver + KVER_MAX_JUMP). No write proof. password_auth follows the server's current bundle; recovery_verifier comes from a recovery code the user types; password_verifier is required because the password wrap and auth.kdf changed (P4).",
    password: PASSWORD,
    server,
    device,
    recovery_secret3_hex: hex(SECRET3),
    recovery_code3: code3,
    aad: { password: aadPw, recovery: aadRec },
    request,
    p4_rule:
      "P4 (§2.3, §0.0f S-2), keyless, server and client alike: the recovery wrap changed <=> recovery_verifier is required; the password wrap changed <=> auth.kdf changed <=> password_verifier is required; otherwise 422 invalid_request. A wrap changed when its iv or its wrapped bytes did; createdAt and every other member are ignored.",
    p4_cases: p4Cases,
  };
}

/** P4 against the server's current bundle; wraps compared by iv + wrapped only (S-2). */
function p4Expect(server, next) {
  const w = (b, m) => b.keyring.wraps.find((x) => x.method === m);
  const changed = (m) => w(server, m).iv !== w(next, m).iv || w(server, m).wrapped !== w(next, m).wrapped;
  const authChanged = canonicalJson(server.auth.kdf) !== canonicalJson(next.auth.kdf);
  if (changed("password") !== authChanged) return "422 invalid_request";
  return { recovery_verifier: changed("recovery"), password_verifier: changed("password") };
}

async function genKverRules(g) {
  const reordered = JSON.stringify(reorderDeep(g.keybundle.bundle.keyring));
  const keyrings = {
    keybundle: g.keybundle.bundle.keyring,
    keys_repair: JSON.parse(g.keys_repair.request.bundle).keyring,
    keybundle_reordered: JSON.parse(reordered),
  };
  const kverOf = { keybundle: g.keybundle.bundle.kver, keys_repair: JSON.parse(g.keys_repair.request.bundle).kver };
  const publishCase = (s, m) => {
    try {
      return { server_kver: s, max_seen_kver: m, publish_kver: publishKver(s, m) };
    } catch {
      return { server_kver: s, max_seen_kver: m, error: "kver_overflow" };
    }
  };
  const publish = [
    [3, 6],
    [10, 10],
    [7, 10],
    [12, 10],
    [1, 0],
    [3, 3],
    [5, 100000],
    [Number.MAX_SAFE_INTEGER, 0],
  ].map(([s, m]) => publishCase(s, m));
  assert(publish.at(-2).publish_kver === 65541 && publish.at(-1).error === "kver_overflow", "publish cap and overflow");
  const accept = [
    { name: "if_kver current, jumped kver", server_kver: 3, if_kver: 3, kver: 7, raw_equals_stored: false },
    { name: "if_kver current, next kver", server_kver: 3, if_kver: 3, kver: 4, raw_equals_stored: false },
    { name: "kver equal to if_kver", server_kver: 3, if_kver: 3, kver: 3, raw_equals_stored: false },
    { name: "kver below if_kver", server_kver: 3, if_kver: 3, kver: 2, raw_equals_stored: false },
    { name: "stale if_kver, different text", server_kver: 3, if_kver: 2, kver: 7, raw_equals_stored: false },
    {
      name: "replay of the request that set the stored bundle (stale if_kver, same text)",
      server_kver: 7,
      if_kver: 3,
      kver: 7,
      raw_equals_stored: true,
    },
    {
      name: "jump of exactly KVER_MAX_JUMP",
      server_kver: 3,
      if_kver: 3,
      kver: 3 + KVER_MAX_JUMP,
      raw_equals_stored: false,
    },
    {
      name: "jump of KVER_MAX_JUMP + 1",
      server_kver: 3,
      if_kver: 3,
      kver: 3 + KVER_MAX_JUMP + 1,
      raw_equals_stored: false,
    },
  ].map((c) => ({ ...c, expect: serverAccept(c) }));
  assert(accept.at(-2).expect === "200 applied" && accept.at(-1).expect === "422 invalid_request", "the jump bound");
  const defs = [
    ["a newer bundle with a different keyring", 3, "keys_repair", "keybundle"],
    ["identity restored (maxSeenKver = 0): a newer bundle with a different keyring", 0, "keys_repair", "keybundle"],
    ["the repaired bundle reaches a device that already has that keyring", 6, "keys_repair", "keys_repair"],
    ["rolled-back bundle, and this device already has that keyring", 6, "keybundle", "keybundle"],
    ["rolled-back bundle, or a lagging publisher, with a different keyring", 6, "keybundle", "keys_repair"],
    [
      "a lagging publisher at an equal kver with different content (old R1 adopted this silently)",
      3,
      "keybundle",
      "keys_repair",
    ],
    ["a genuine old bundle replayed after the repair", 7, "keybundle", "keys_repair"],
    ["content is compared with canonicalJson, so key order does not matter", 6, "keybundle", "keybundle_reordered"],
  ];
  const cases = defs.map(([name, maxSeen, bundleRef, localRef]) => {
    const same = canonicalJson(keyrings[bundleRef]) === canonicalJson(keyrings[localRef]);
    return {
      name,
      max_seen_kver: maxSeen,
      bundle: bundleRef,
      bundle_kver: kverOf[bundleRef],
      local_keyring: localRef,
      same_keyring: same,
      ...adoption(maxSeen, kverOf[bundleRef], same),
    };
  });
  assert(cases.filter((c) => c.outcome === "keys_behind").length === 3, "three keys_behind cases");
  // F-01's client cap (§3.9 R0): classification facts only. The bundles referenced give the content; bundle_kver is the
  // hypothetical kver under test (facts_only), not that bundle's own kver.
  const capped = [
    [
      "beyond the cap, same keyring: in sync, maxSeenKver not raised",
      3,
      3 + KVER_MAX_JUMP + 1,
      "keybundle",
      "keybundle",
    ],
    [
      "beyond the cap, different keyring: keys_behind, maxSeenKver not raised",
      3,
      3 + KVER_MAX_JUMP + 1,
      "keys_repair",
      "keybundle",
    ],
    ["identity just restored (maxSeenKver = 0): no cap", 0, 70000, "keys_repair", "keybundle"],
  ].map(([name, maxSeen, kver, bundleRef, localRef]) => {
    const same = canonicalJson(keyrings[bundleRef]) === canonicalJson(keyrings[localRef]);
    return {
      name,
      facts_only: true,
      max_seen_kver: maxSeen,
      bundle: bundleRef,
      bundle_kver: kver,
      local_keyring: localRef,
      same_keyring: same,
      ...adoption(maxSeen, kver, same),
    };
  });
  assert(
    capped[0].outcome === "in_sync" &&
      capped[0].max_seen_after === 3 &&
      capped[1].outcome === "keys_behind" &&
      capped[2].max_seen_after_adoption === 70000,
    "the cap cases",
  );
  cases.push(...capped);
  return {
    section: "§3.9 R1, §2.3, §3.6.0, §5.3 (§0.0e N27)",
    verified_by: ["node-webcrypto", "ts-phase0", "python-stdlib"],
    rule: "Publish: kver = publishKver(server kver, maxSeenKver) = min(max(server kver, maxSeenKver) + 1, server kver + KVER_MAX_JUMP); a result that is not a safe integer is the error kver_overflow and nothing is published. Server: the app layer accepts only if_kver < kver <= if_kver + KVER_MAX_JUMP, else 422 invalid_request; the CAS is on if_kver; a failed CAS whose stored bundle text equals the submitted text is the idempotent 200, otherwise 409 keys_conflict. Adoption (R0/R1, only MAC- and vaultId-verified bundles are classified): kver > maxSeenKver may be adopted (R2/R3 still apply; maxSeenKver = kver afterwards), except that when maxSeenKver > 0 a kver above maxSeenKver + KVER_MAX_JUMP counts as kver <= maxSeenKver (it cannot raise maxSeenKver); kver <= maxSeenKver with the same keyring (canonicalJson) is in sync and maxSeenKver stays; with a different keyring it is keys_behind: not adopted, no 'take the server's' action, the only way out is repairing the cloud from this device, and R3 asks for confirmation before an old password may adopt it. Bundles are referenced by group: keybundle = the server's rolled-back bundle (kver 3), keys_repair = the repaired bundle (kver 7); a facts_only case uses the bundle only for its content and classifies the given bundle_kver. §3.9 (§0.0e N27, §0.0f F-01).",
    kver_max_jump: KVER_MAX_JUMP,
    keybundle_reordered_text: reordered,
    publish,
    server_accept: accept,
    adoption: cases,
  };
}

async function genWireExamples(g) {
  const enr = g.enrollment;
  const kb = g.keybundle;
  const st = { server_time: NOW };
  const vaultPut = JSON.parse(g.request_signature.cases[1].body);
  const keysPut = {
    if_kver: 2,
    bundle: kb.raw,
    password_auth: g.password_auth.cases[0].password_auth_b64,
    recovery_verifier: g.recovery_auth.recovery_verifier_b64,
  };
  const once = (text, from, to) => {
    if (text.split(from).length !== 2)
      throw new Error(`wire_examples: ${JSON.stringify(from)} must occur exactly once`);
    return text.replace(from, to);
  };
  const name = g.device_name.encrypt.cases[0].name_ct;
  return {
    section: "§5.4",
    verified_by: ["ts-phase0", "python-stdlib"],
    note: "Bodies assembled from the vectors above, validated against the OpenAPI request/response schemas; expect_valid false marks a counterexample the schema must reject. Values are reused across groups, so this is not one consistent session (the rotate_repair body is self-consistent).",
    examples: [
      {
        operation: "POST /v1/vault/init",
        kind: "request",
        body: {
          vault_id: VAULT_ID,
          envelope: g.envelope.envelope_text,
          bundle: kb.raw,
          recovery_verifier: g.recovery_auth.recovery_verifier_b64,
          password_verifier: g.password_auth.cases[0].password_verifier_b64,
          write_key: g.write_proof.write_key_b64,
          device: {
            device_id: DEV_A,
            sig_pubkey: g.public_keys.keys.find((k) => k.name === "dsk_A").spki_b64,
            name_ct: g.device_name.encrypt.cases[1].name_ct,
          },
        },
      },
      { operation: "PUT /v1/vault", kind: "request", body: vaultPut },
      { operation: "PUT /v1/vault", kind: "response", status: "200", body: { version: 42, forked: false, ...st } },
      {
        operation: "GET /v1/sync/status",
        kind: "response",
        status: "200",
        body: {
          version: 42,
          head: g.envelope.head_b64,
          vk_id: g.vk_subkeys.keys[0].vk_id,
          kver: 3,
          pending_enrollments: 0,
          devices_rev: 7,
          min_client_version: "1.0.0",
          ...st,
        },
      },
      { operation: "GET /v1/keys", kind: "response", status: "200", body: { kver: 3, bundle: kb.raw, ...st } },
      { operation: "PUT /v1/keys", kind: "request", body: keysPut },
      {
        operation: "POST /v1/enroll/requests",
        kind: "request",
        body: { device_id: DEV_N, sig_pubkey: enr.inputs.dpk_n_spki_b64, commit: enr.commit_b64 },
      },
      {
        operation: "POST /v1/enroll/requests",
        kind: "response",
        status: "201",
        body: { request_id: RID, expires_at: ceilMinute(NOW + 600_000), ...st },
        why: "expires_at is (now + 600 s) rounded up to the UTC minute, a multiple of 60000 (§5.3, §0.0o A13)",
      },
      {
        operation: "POST /v1/enroll/requests/{rid}/respond",
        kind: "request",
        body: { epk: enr.inputs.epk_a_b64, password_auth: g.password_auth.cases[0].password_auth_b64 },
      },
      {
        operation: "POST /v1/enroll/requests/{rid}/reveal",
        kind: "request",
        body: { epk: enr.inputs.epk_n_b64, nonce: enr.inputs.n_n_b64, name_ct: enr.reveal_name.wire_b64 },
      },
      {
        operation: "POST /v1/enroll/requests/{rid}/approve",
        kind: "request",
        body: {
          transcript_hash: enr.h_b64,
          payload: enr.payload.wire_b64,
          name_ct: name,
          sig_pubkey_sha256: enr.sig_pubkey_sha256_b64,
          password_auth: g.password_auth.cases[0].password_auth_b64,
        },
      },
      {
        operation: "GET /v1/enroll/requests/{rid}",
        kind: "response",
        status: "200",
        body: {
          state: "approved",
          approver_device_id: DEV_A,
          approver_epk: enr.inputs.epk_a_b64,
          payload: enr.payload.wire_b64,
          ...st,
        },
      },
      {
        operation: "GET /v1/enroll/requests/{rid}",
        kind: "response",
        status: "200",
        body: {
          state: "revealed",
          new_device_id: DEV_N,
          new_sig_pubkey: enr.inputs.dpk_n_spki_b64,
          commit: enr.commit_b64,
          new_epk: enr.inputs.epk_n_b64,
          new_nonce: enr.inputs.n_n_b64,
          new_name_ct: enr.reveal_name.wire_b64,
          ...st,
        },
      },
      {
        operation: "POST /v1/enroll/recovery",
        kind: "request",
        body: {
          device_id: DEV_N,
          sig_pubkey: enr.inputs.dpk_n_spki_b64,
          recovery_auth: g.recovery_auth.recovery_auth_b64,
        },
      },
      {
        operation: "PATCH /v1/devices/{id}",
        kind: "request",
        body: { name_ct: name, password_auth: g.password_auth.cases[0].password_auth_b64 },
      },
      {
        operation: "DELETE /v1/vault/versions",
        kind: "request",
        body: { password_auth: g.password_auth.cases[0].password_auth_b64 },
      },
      {
        operation: "PUT /v1/vault",
        kind: "response",
        status: "409",
        body: { error: { code: "version_conflict", version: 43, vk_id: g.vk_subkeys.keys[0].vk_id, kver: 3 }, ...st },
      },
      {
        operation: "POST /v1/auth/otp",
        kind: "response",
        status: "429",
        body: { error: { code: "rate_limited", retry_after: 120 }, ...st },
      },
      { operation: "POST /v1/devices/fork", kind: "request", body: JSON.parse(g.fork_signature.body) },
      {
        operation: "POST /v1/keys/rotate",
        kind: "request",
        body: g.rotate_repair.request,
        why: "repair use (§4.2, §0.0d N24)",
      },
      {
        operation: "PUT /v1/keys",
        kind: "request",
        body: g.keys_repair.request,
        why: "same-VK repair: if_kver = server kver, jumped bundle.kver, recovery_verifier and password_verifier (§4.2, §0.0e N27)",
      },
      {
        operation: "PUT /v1/keys",
        kind: "request",
        body: {
          if_kver: 2,
          bundle: g.keybundle.shape_cases.find((s) => s.name.startsWith("at not hour-aligned")).raw,
          password_auth: g.password_auth.cases[0].password_auth_b64,
        },
        expect_valid: false,
        why: "bundle at is not hour-aligned: 422 (§2.3, §0.0d N16)",
      },
      {
        operation: "POST /v1/devices/fork",
        kind: "request",
        body: { ...JSON.parse(g.fork_signature.body), new_sig: b64(fill(0, 64)) },
        expect_valid: false,
        why: "new_sig is no longer a body member; it is the Sixkey-New-Sig header (§0.0d N1)",
      },
      {
        operation: "GET /v1/sync/status",
        kind: "response",
        status: "200",
        body: {
          version: 42,
          head: g.envelope.head_b64,
          vk_id: g.vk_subkeys.keys[0].vk_id,
          kver: 3,
          pending_enrollments: 0,
          devices_changed_at: AT,
          min_client_version: "1.0.0",
          ...st,
        },
        expect_valid: false,
        why: "devices_changed_at was replaced by devices_rev (§0.0d N15)",
      },
      {
        operation: "POST /v1/keys/rotate",
        kind: "request",
        body: (({ recovery_verifier: _r, ...rest }) => rest)(g.rotate_repair.request),
        expect_valid: false,
        why: "recovery_verifier is required, also for repair (§0.0d N24)",
      },
      {
        operation: "GET /v1/enroll/requests/{rid}",
        kind: "response",
        status: "200",
        body: { state: "responded", approver_device_id: DEV_A, ...st },
        expect_valid: false,
        why: "from responded on, the new device's view carries approver_epk (§3.2, §5.4, §0.0f F-10)",
      },
      {
        operation: "GET /v1/keys",
        kind: "response",
        status: "200",
        body: { kver: 2 ** 53, bundle: kb.raw, ...st },
        expect_valid: false,
        why: "a kver is a safe integer, at most 2^53-1 (§3.9 R0, §0.0f F-01)",
      },
      // Strict JSON (§5.4, §0.0o A18). Each is valid under a lenient parse (JSON.parse, json.loads) and fails only the
      // strict rules; the nested texts carry the escapes \u0000 and \ud800 exactly as a client would send them.
      {
        operation: "PUT /v1/keys",
        kind: "request",
        body: {
          ...keysPut,
          bundle: once(
            kb.raw,
            '{"format":"sixkey-keybundle",',
            '{"format":"sixkey-keybundle","format":"sixkey-keybundle",',
          ),
        },
        expect_valid: false,
        why: "duplicate object key inside the bundle text: 422 (§5.4, §0.0o A18)",
      },
      {
        operation: "PUT /v1/vault",
        kind: "request",
        body: {
          ...vaultPut,
          envelope: once(vaultPut.envelope, '"cipher":"AES-256-GCM",', '"cipher":"AES-256-GCM","note":"a\\u0000b",'),
        },
        expect_valid: false,
        why: "NUL character in a string of the envelope text: 422 (§5.4, §0.0o A18)",
      },
      {
        operation: "PUT /v1/keys",
        kind: "request",
        body: {
          ...keysPut,
          bundle: once(kb.raw, '{"format":"sixkey-keybundle",', '{"format":"sixkey-keybundle","note":"\\ud800",'),
        },
        expect_valid: false,
        why: "lone surrogate in a string of the bundle text: 422 (§5.4, §0.0o A18)",
      },
      {
        operation: "PUT /v1/vault",
        kind: "request",
        body: { ...vaultPut, envelope: once(vaultPut.envelope, '"rev":42,', '"rev":42.0,') },
        expect_valid: false,
        why: "non-integer number token inside the envelope text: the integer-token rule applies there too, 422 (§5.4, §0.0o A18)",
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------------- assemble

async function main() {
  const groups = {};
  groups.labels = await genLabels();
  Object.assign(groups, await genBase64());
  groups.canonical_json = await genCanonicalJson();
  groups.time_truncation = await genTime();
  groups.padding = await genPadding();
  groups.vk_subkeys = await genVkSubkeys();
  groups.envelope = await genEnvelope();
  groups.write_proof = await genWriteProof(groups.envelope.envelope);
  groups.recovery_auth = await genRecoveryAuth();
  groups.password_auth = await genPasswordAuth();
  groups.keybundle = await genKeyBundle();
  groups.number_tokens = await genNumberTokens(groups.keybundle.raw);
  groups.device_name = await genDeviceName();
  groups.device_backup = await genDeviceBackup();
  groups.public_keys = await genPublicKeys();
  groups.enrollment = await genEnrollment(groups.keybundle.raw);
  groups.sas = await genSas();
  groups.pairing_code = await genPairingCode();
  groups.request_signature = await genRequestSignature(
    groups.envelope.envelope_text,
    groups.write_proof.write_proof_b64,
  );
  groups.fork_signature = await genForkSignature(groups);
  groups.rotate_repair = await genRotateRepair(groups);
  groups.keys_repair = await genKeysRepair(groups);
  groups.kver_rules = await genKverRules(groups);
  groups.wire_examples = await genWireExamples(groups);

  const doc = {
    format: "sixkey-contract-vectors",
    v: 1,
    title: "Sixkey Phase 1 sync: shared known-answer vectors (M0)",
    source:
      "docs/SYNC-DESIGN.md (revision 15; the M0 notes N0-N29 are resolved in §0.0d and §0.0e, the M1 review in §0.0f, the M4 backend review in §0.0o; enrolment v2 and the pairing code: revision 27, §0.0aa). Remaining observations: contract/M0-NOTES.md.",
    generator:
      "contract/tools/gen-vectors.mjs (Node WebCrypto). Verified by extension/test/unit/contract-vectors.test.ts and contract/py/test_contract.py.",
    warning:
      "Every key, password, code, email and id here is a fixed, obviously fake test value. Never use any of it for real data.",
    verifier_ids: {
      "node-webcrypto": "the generator itself (self-checks, --check)",
      "ts-phase0": "vitest: WebCrypto plus the shipped Phase 0 primitives where they exist",
      "python-stdlib":
        "Python stdlib only: hashlib, hmac, HKDF by hand, pbkdf2_hmac, unicodedata, pure-Python P-256 arithmetic",
      "python-cryptography":
        "pyca/cryptography for AES-GCM (and a second ECDH/ECDSA check); skipped with a message when not installed",
    },
    fixed_inputs: {
      vk1_hex: hex(VK1),
      vk2_hex: hex(VK2),
      vk0_hex: hex(VK0),
      vault_id: VAULT_ID,
      dev_n: DEV_N,
      dev_a: DEV_A,
      dev_s: DEV_S,
      rid: RID,
      sub: SUB,
      now_ms: NOW,
      at_ms: AT,
      email: EMAIL,
    },
    groups,
  };
  // Escape invisible and bidi characters so the file stays readable and reviewable.
  const text = `${JSON.stringify(doc, null, 2).replace(/[\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\u3000\ufeff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
  JSON.parse(text);
  if (CHECK) {
    const cur = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (cur !== text) {
      console.error(
        `gen-vectors --check: ${OUT} differs from a fresh computation. Rerun without --check and review the diff.`,
      );
      process.exit(1);
    }
    console.log(`gen-vectors --check: ${Object.keys(groups).length} groups recomputed, file matches.`);
    return;
  }
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT} (${text.length} bytes, ${Object.keys(groups).length} groups)`);
}

await main();
