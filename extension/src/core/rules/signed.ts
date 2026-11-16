// The site rules' signed manifest (TOTP autofill Stage 3, AF3-U1; docs/design/notes/AUTOFILL3-NOTES.md §9): what a
// downloaded live bundle must prove before the updater keeps it, and the one record the updater keeps between checks.
// Behind the updater's release gate (scripts/rules-update.mjs, closed in the store build): with the gate closed,
// scripts/rules-guard.mjs keeps this module out of every build, and check-dist looks for its marks in the built files.
//
// Pure: WebCrypto (crypto.subtle) and nothing else; no network, no storage, no extension API. Fetching and storage are
// the updater's (AF3-U2): it passes in what it fetched, the record it read, the clock, the built-in bundle's version and
// the pinned keys, and keeps what comes back. Nothing is imported at run time either (the format's checker is passed in,
// as format.ts takes its host checks), so rules/tools/sign.mjs runs these very checks, under Node's type stripping, on
// what it has just signed: the signer and the extension cannot disagree on what a valid signed manifest is.
//
// The signed file (the updater reads it at /v1/manifest.json): {"m": <the manifest, a JSON text>, "kid": <key id>,
// "sig": <signature>}, closed. The signature is ECDSA on P-256 with SHA-256, written as r‖s (IEEE P1363, 64 bytes,
// base64url without padding), over the bytes of "sixkey-rules-manifest\n1\n" followed by `m`. `kid` is the hex of the
// first 16 bytes of the SHA-256 of the key's SubjectPublicKeyInfo (DER) in its one form: the uncompressed point, 91
// bytes (importPinned refuses any other spelling of a key, so a key has one kid: the AF3-U1 review's S2). The manifest, `m`: {format:
// "sixkey-rules-manifest", schema: 1, version, created, expires, sha256, size, source, license}, closed, printable ASCII,
// and written exactly as JSON.stringify writes these fields in this order (manifestText): one text for one manifest, so a
// field written twice, or any other spelling of the same values, is refused. The path's major (/v1/) and `schema` stand
// for an engine version: this code reads schema 1 only; a new format is published under /v2/.
//
// A manifest and its bundle are accepted only if all of these hold (checkManifest: 1 to 3, before the bundle is fetched;
// checkSigned: all four):
//   1. `kid` is pinned by this build and not retired on this client; `m` is printable ASCII; the signature verifies with
//      the pinned key; the manifest is this format's schema 1. Before the signature verifies, `m` is not parsed and none
//      of its fields is read: only its length and its kind of characters are looked at;
//   2. created ≤ now + 1 day; created < expires; expires − created ≤ 180 days; now < expires;
//   3. `version` is an integer with baseline < version ≤ baseline + 1,000 (the built-in bundle's version), and above the
//      floor of its key (below);
//   4. the bundle is `size` bytes, at most 512 KiB, its SHA-256 is `sha256`, it is ASCII, it passes the format's checker
//      as a live bundle (format.ts validate(…, "live", …): site rules only, never aliases, appends or upstream files), and
//      it has the manifest's version, source and licence.
//
// The record, the updater's one: {kid, version, retired, held}. `kid` and `version` are the last accepted bundle's, its
// key's floor: a later bundle of that key must be above it, so an older one replayed is refused. `retired`: keys this
// client accepts nothing from any more. `held`: the accepted bundle's text and when it expires, or null.
//   - Succession: the pinned keys are ordered (current, next). A bundle signed by a key later in that order than the
//     record's is compared with the baseline only, and accepting it retires every key before it on this client: their
//     floor stops counting, and nothing they sign is accepted again. A key before the record's is retired already.
//   - At every read (readRecord): a record whose kid is no longer pinned, or is retired, is deleted, floor and all; a
//     retired key that is no longer pinned, or that comes after the record's own key in the pinned order (no function
//     here makes one), is dropped from the list; a held bundle that has expired, or that the built-in bundle has caught up
//     with (a newer release wins by itself), is deleted, and its floor stays.
//   - Turning the updates off (switchedOff) deletes the held bundle and keeps the floor and the retired keys, so off and on
//     again is not a fresh install.
//   - The updater calls these only with the keys of a successful importPinned. With no key pinned at all, nothing is
//     used and nothing is deleted: readRecord answers "no record, unchanged" (the review's N3), so a list that failed to
//     load cannot wipe a floor.
import type { Bundle, Checked, HostChecks, Options, validate as Validate } from "./format";

export const MANIFEST_FORMAT = "sixkey-rules-manifest";
export const MANIFEST_SCHEMA = 1;
/** What the signature covers: these bytes, then the manifest's. */
export const SIGNED_PREFIX = `${MANIFEST_FORMAT}\n${MANIFEST_SCHEMA}\n`;
/** The manifest's fields, all required, in the order its one text writes them. */
export const MANIFEST_FIELDS = [
  "format",
  "schema",
  "version",
  "created",
  "expires",
  "sha256",
  "size",
  "source",
  "license",
] as const;
/** The signed file's fields, all required. */
export const SIGNED_FIELDS = ["m", "kid", "sig"] as const;
/** The bounds (the plan's §5.2, §5.3, S9). Times in milliseconds. */
export const BOUNDS = {
  /** The signed file, in characters (it is ASCII). */
  signedFile: 4096,
  /** A live bundle, in bytes. */
  bundle: 512 * 1024,
  /** How far ahead of this clock `created` may be. */
  ahead: 86_400_000,
  /** The longest validity, expires − created. */
  validity: 180 * 86_400_000,
  /** How far above the built-in bundle's version a manifest's may be. */
  versions: 1000,
  /** Keys a build pins: current and next. */
  keys: 2,
  /** A manifest's source and licence, in characters (the bundle's own checker bounds them again). */
  source: 300,
  license: 64,
} as const;

/** A pinned key as a build lists it (scripts/rules-keys.mjs): its kid, and its SubjectPublicKeyInfo in base64. */
export type PinnedKey = { kid: string; spki: string };
/** A pinned key, imported (importPinned). */
export type Pinned = { kid: string; key: CryptoKey };
export type Manifest = {
  format: string;
  schema: number;
  version: number;
  created: string;
  expires: string;
  sha256: string;
  size: number;
  source: string;
  license: string;
};
export type Signed = { m: string; kid: string; sig: Uint8Array<ArrayBuffer> };
/** The accepted bundle's text and its manifest's `expires`. */
export type Held = { text: string; expires: string };
export type LiveRecord = { kid: string; version: number; retired: string[]; held: Held | null };
/** What the checks need from the updater: the clock (ms), the built-in bundle's version, the pinned keys in order. */
export type Context = { now: number; baseline: number; pinned: readonly Pinned[] };
/** The format's checker and its host checks (format.ts validate; match.ts canonicalHost, site-domains.ts isShared). */
export type Checker = { validate: typeof Validate; checks: HostChecks; options?: Options };
export type Accepted = { manifest: Manifest; bundle: Bundle; record: LiveRecord };

class Refused extends Error {}
function refuse(at: string, why: string): never {
  throw new Refused(`${at}: ${why}`);
}
function attempt<T>(f: () => T): Checked<T> {
  try {
    return { ok: true, value: f() };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, error: e.message };
    return { ok: false, error: "not readable" };
  }
}

const ASCII = /^[\x20-\x7e]*$/;
/** The first 27 bytes of every P-256 public key's SubjectPublicKeyInfo with its point uncompressed (then x and y, 32 each). */
export const P256_SPKI_PREFIX = "3059301306072a8648ce3d020106082a8648ce3d03010703420004";
const KID = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** A plain object, as JSON.parse makes it, with exactly these fields. */
function closed(v: unknown, at: string, fields: readonly string[]): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype)
    refuse(at, "not an object");
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!fields.includes(k)) refuse(at, `unknown field "${k.slice(0, 80)}"`);
  for (const k of fields) if (!Object.hasOwn(o, k)) refuse(at, `missing field "${k}"`);
  return o;
}
/** A UTC time written YYYY-MM-DDTHH:MM:SSZ, as milliseconds. */
function time(v: unknown, at: string): number {
  if (typeof v !== "string" || !TIME.test(v)) refuse(at, "not a UTC time written YYYY-MM-DDTHH:MM:SSZ");
  const t = Date.parse(v);
  if (Number.isNaN(t) || new Date(t).toISOString() !== `${v.slice(0, 19)}.000Z`) refuse(at, "not a calendar time");
  return t;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
async function sha256Hex(b: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));
}
function base64(b: Uint8Array, url: boolean): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  const t = btoa(s);
  return url ? t.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : t;
}
/** Base64 (standard, padded) or base64url (unpadded), in its one canonical spelling; null for anything else. */
function unbase64(s: string, url: boolean): Uint8Array<ArrayBuffer> | null {
  if (!(url ? /^[A-Za-z0-9_-]*$/ : /^[A-Za-z0-9+/]*={0,2}$/).test(s)) return null;
  if (url ? s.length % 4 === 1 : s.length % 4 !== 0) return null;
  const std = url ? s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4) : s;
  let bin: string;
  try {
    bin = atob(std);
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return base64(out, url) === s ? out : null;
}
const TEXT = /^[\t\n\r\x20-\x7e]*$/;

/** The key id of a key: the hex of the first 16 bytes of the SHA-256 of its SubjectPublicKeyInfo (DER). */
export async function kidOf(spki: Uint8Array<ArrayBuffer>): Promise<string> {
  return (await sha256Hex(spki)).slice(0, 32);
}

/**
 * A build's pinned keys, in their order (current, then next), imported for checkSigned: each entry exactly {kid, spki},
 * its SubjectPublicKeyInfo a P-256 public key in canonical base64 whose kid is `kid`, no kid twice, at most two keys.
 */
export async function importPinned(list: unknown): Promise<Checked<Pinned[]>> {
  try {
    if (!Array.isArray(list)) refuse("keys", "not a list");
    if (list.length > BOUNDS.keys) refuse("keys", `more than ${BOUNDS.keys} keys`);
    const out: Pinned[] = [];
    for (const [i, entry] of list.entries()) {
      const at = `keys[${i}]`;
      const o = closed(entry, at, ["kid", "spki"]);
      if (typeof o.kid !== "string" || !KID.test(o.kid)) refuse(`${at}.kid`, "not 32 lower-case hex digits");
      const der = typeof o.spki === "string" ? unbase64(o.spki, false) : null;
      if (!der) refuse(`${at}.spki`, "not base64");
      if (der.length !== 91 || hex(der.subarray(0, 27)) !== P256_SPKI_PREFIX)
        refuse(`${at}.spki`, "not a P-256 key's SubjectPublicKeyInfo with its point uncompressed (91 bytes)");
      let key: CryptoKey;
      try {
        key = await crypto.subtle.importKey("spki", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      } catch {
        refuse(`${at}.spki`, "not a P-256 public key");
      }
      if ((await kidOf(der)) !== o.kid) refuse(`${at}.kid`, "not the key id of its key");
      if (out.some((k) => k.kid === o.kid)) refuse(`${at}.kid`, "a key listed twice");
      out.push({ kid: o.kid, key });
    }
    return { ok: true, value: out };
  } catch (e) {
    return { ok: false, error: e instanceof Refused ? e.message : "not readable" };
  }
}

/** The signed file's three fields: `m` as it is, the kid, the signature's 64 bytes. Signature not checked yet. */
export function parseSigned(text: string): Checked<Signed> {
  return attempt(() => {
    if (typeof text !== "string") refuse("file", "not text");
    if (text.length > BOUNDS.signedFile) refuse("file", `longer than ${BOUNDS.signedFile} characters`);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      refuse("file", "not JSON");
    }
    const o = closed(raw, "file", SIGNED_FIELDS);
    if (typeof o.m !== "string") refuse("m", "not a string");
    if (!ASCII.test(o.m)) refuse("m", "not printable ASCII");
    if (typeof o.kid !== "string" || !KID.test(o.kid)) refuse("kid", "not 32 lower-case hex digits");
    const sig = typeof o.sig === "string" ? unbase64(o.sig, true) : null;
    if (!sig || sig.length !== 64) refuse("sig", "not 64 bytes in base64url (r and s, IEEE P1363)");
    return { m: o.m, kid: o.kid, sig };
  });
}

/** The manifest's one text: JSON.stringify of its fields in MANIFEST_FIELDS's order. */
export function manifestText(m: Manifest): string {
  return JSON.stringify(Object.fromEntries(MANIFEST_FIELDS.map((k) => [k, m[k]])));
}

/** The manifest in `m`, checked for its form (not yet against a clock, a baseline or a bundle). */
export function parseManifest(m: string): Checked<Manifest> {
  return attempt(() => {
    if (typeof m !== "string" || !ASCII.test(m)) refuse("m", "not printable ASCII");
    let raw: unknown;
    try {
      raw = JSON.parse(m);
    } catch {
      refuse("m", "not JSON");
    }
    const o = closed(raw, "m", MANIFEST_FIELDS);
    if (o.format !== MANIFEST_FORMAT) refuse("m.format", `not "${MANIFEST_FORMAT}"`);
    if (o.schema !== MANIFEST_SCHEMA) refuse("m.schema", `not ${MANIFEST_SCHEMA}`);
    if (typeof o.version !== "number" || !Number.isSafeInteger(o.version) || o.version < 1)
      refuse("m.version", "not a counter from 1");
    time(o.created, "m.created");
    time(o.expires, "m.expires");
    if (typeof o.sha256 !== "string" || !SHA256.test(o.sha256)) refuse("m.sha256", "not 64 lower-case hex digits");
    if (typeof o.size !== "number" || !Number.isSafeInteger(o.size) || o.size < 1 || o.size > BOUNDS.bundle)
      refuse("m.size", `not 1 to ${BOUNDS.bundle}`);
    if (typeof o.source !== "string" || o.source.length > BOUNDS.source) refuse("m.source", "not a source address");
    if (typeof o.license !== "string" || o.license.length > BOUNDS.license) refuse("m.license", "not a licence");
    const manifest: Manifest = {
      format: o.format,
      schema: o.schema,
      version: o.version,
      created: o.created as string,
      expires: o.expires as string,
      sha256: o.sha256,
      size: o.size,
      source: o.source,
      license: o.license,
    };
    if (manifestText(manifest) !== m)
      refuse("m", "not written as its one text (JSON.stringify, the fields in order, each once)");
    return manifest;
  });
}

/** The bytes the signature covers. */
export const signedBytes = (m: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(`${SIGNED_PREFIX}${m}`);

/** The signed file's text, as the signer writes it (one line, and a newline). */
export const signedFile = (m: string, kid: string, sig: Uint8Array): string =>
  `${JSON.stringify({ m, kid, sig: base64(sig, true) })}\n`;

/** A stored record of the record's shape, as it is (nothing pinned is looked at). */
function shape(stored: unknown): Checked<LiveRecord> {
  return attempt(() => {
    const o = closed(stored, "record", ["kid", "version", "retired", "held"]);
    if (typeof o.kid !== "string" || !KID.test(o.kid)) refuse("record.kid", "not a kid");
    if (typeof o.version !== "number" || !Number.isSafeInteger(o.version) || o.version < 1)
      refuse("record.version", "not a counter");
    if (
      !Array.isArray(o.retired) ||
      !o.retired.every((k) => typeof k === "string" && KID.test(k)) ||
      new Set(o.retired).size !== o.retired.length
    )
      refuse("record.retired", "not a list of kids");
    let held: Held | null = null;
    if (o.held !== null) {
      const h = closed(o.held, "record.held", ["text", "expires"]);
      if (typeof h.text !== "string" || h.text.length > BOUNDS.bundle) refuse("record.held.text", "not a bundle");
      time(h.expires, "record.held.expires");
      held = { text: h.text, expires: h.expires as string };
    }
    return { kid: o.kid, version: o.version, retired: o.retired as string[], held };
  });
}

/** The record as it is to be read now (see the header), and whether that differs from what was stored. */
export function readRecord(
  stored: unknown,
  ctx: Pick<Context, "now" | "baseline" | "pinned">,
): { record: LiveRecord | null; changed: boolean } {
  if (ctx.pinned.length === 0) return { record: null, changed: false }; // no key: nothing used, nothing deleted
  const gone = { record: null, changed: stored !== null && stored !== undefined };
  const r = shape(stored);
  if (!r.ok) return gone;
  const rec = r.value;
  const pinned = ctx.pinned.map((k) => k.kid);
  if (!pinned.includes(rec.kid) || rec.retired.includes(rec.kid)) return gone;
  // retired: pinned keys before the record's own (the review's N10: a later one would block the succession)
  const retired = pinned.slice(0, pinned.indexOf(rec.kid)).filter((k) => rec.retired.includes(k));
  const held = rec.held && ctx.now < Date.parse(rec.held.expires) && rec.version > ctx.baseline ? rec.held : null;
  return {
    record: { kid: rec.kid, version: rec.version, retired, held },
    changed: retired.length !== rec.retired.length || held !== rec.held,
  };
}

/**
 * The record after the updates are turned off: no bundle; the floor and the retired keys kept as they are (the next
 * readRecord, with the keys pinned then, does the rest). Null only for a stored value that is no record.
 */
export function switchedOff(stored: unknown): LiveRecord | null {
  const r = shape(stored);
  return r.ok ? { ...r.value, held: null } : null;
}

/** Every key this client takes nothing from: the record's retired keys, and every pinned key before the record's. */
function retiredOn(record: LiveRecord | null, pinned: readonly Pinned[]): Set<string> {
  if (!record) return new Set();
  const at = pinned.findIndex((k) => k.kid === record.kid);
  return new Set([...record.retired, ...pinned.slice(0, Math.max(at, 0)).map((k) => k.kid)]);
}

/** A live bundle of the format, from its text: ASCII (tabs and line ends allowed), JSON, accepted by the checker. */
function liveBundle(text: string, at: string, checker: Checker): Bundle {
  if (!TEXT.test(text)) refuse(at, "not ASCII text");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    refuse(at, "not JSON");
  }
  const v = checker.validate(raw, "live", checker.checks, checker.options);
  if (!v.ok) refuse(at, v.error);
  if (v.value.kind !== "live") refuse(at, "not a live bundle");
  return v.value;
}
/** The text of `bytes`, one character a byte (liveBundle refuses any that is not ASCII). */
function latin1(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return text;
}

/**
 * Steps 1 to 3 of the header: the signed file, its key and signature, the manifest's form, times and version, against the
 * record and the context, before the bundle is fetched (the updater fetches it only for a manifest that passes these).
 * The answer is the manifest and the record as read now, or the first reason it was refused. Never throws.
 */
export async function checkManifest(
  file: string,
  stored: unknown,
  ctx: Context,
): Promise<Checked<{ manifest: Manifest; kid: string; record: LiveRecord | null }>> {
  try {
    const s = parseSigned(file);
    if (!s.ok) return s;
    const { m, kid, sig } = s.value;
    const { record } = readRecord(stored, ctx);
    // 1. the key, then the signature, then the manifest's form: `m` is not parsed, nor any field of it read, before its
    // signature verifies (parseSigned looked at its length and its kind of characters only)
    const at = ctx.pinned.findIndex((k) => k.kid === kid);
    if (at < 0) refuse("kid", "not a key this build pins");
    if (retiredOn(record, ctx.pinned).has(kid)) refuse("kid", "a key retired on this client");
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ctx.pinned[at]!.key, sig, signedBytes(m));
    if (!ok) refuse("sig", "does not verify with the pinned key");
    const pm = parseManifest(m);
    if (!pm.ok) return pm;
    const manifest = pm.value;
    // 2. the times
    const created = Date.parse(manifest.created);
    const expires = Date.parse(manifest.expires);
    if (created > ctx.now + BOUNDS.ahead) refuse("m.created", "more than a day after this clock's time");
    if (created >= expires) refuse("m.expires", "not after created");
    if (expires - created > BOUNDS.validity) refuse("m.expires", "more than 180 days after created");
    if (ctx.now >= expires) refuse("m.expires", "passed");
    // 3. the version: above the built-in bundle's, by at most 1,000, and above its key's floor; a later key's bundle is
    // compared with the baseline only (an earlier key's was refused above)
    const v = manifest.version;
    if (v <= ctx.baseline) refuse("m.version", `not above the built-in rules' version ${ctx.baseline}`);
    if (v > ctx.baseline + BOUNDS.versions)
      refuse("m.version", `more than ${BOUNDS.versions} above the built-in rules' version ${ctx.baseline}`);
    if (record && record.kid === kid && v <= record.version)
      refuse("m.version", `not above ${record.version}, the last version accepted from this key`);
    return { ok: true, value: { manifest, kid, record } };
  } catch (e) {
    return { ok: false, error: e instanceof Refused ? e.message : "not readable" };
  }
}

/**
 * Check a signed manifest (the file's text) and the bundle it names (its bytes) against the stored record and the
 * context: every step of the header. The answer is the manifest, the bundle and the record to keep, or the first reason
 * it was refused (the stored record is then kept as it is). Never throws.
 */
export async function checkSigned(
  file: string,
  bundle: Uint8Array<ArrayBuffer>,
  stored: unknown,
  ctx: Context,
  checker: Checker,
): Promise<Checked<Accepted>> {
  const c = await checkManifest(file, stored, ctx);
  if (!c.ok) return c;
  const { manifest, kid, record } = c.value;
  try {
    // 4. the bundle
    if (bundle.length > BOUNDS.bundle) refuse("bundle", `larger than ${BOUNDS.bundle} bytes`);
    if (bundle.length !== manifest.size) refuse("bundle", `not ${manifest.size} bytes, as the manifest says`);
    if ((await sha256Hex(bundle)) !== manifest.sha256) refuse("bundle", "its SHA-256 is not the manifest's");
    const text = latin1(bundle);
    const live = liveBundle(text, "bundle", checker);
    if (live.version !== manifest.version) refuse("bundle.version", `not the manifest's (${manifest.version})`);
    if (live.source !== manifest.source) refuse("bundle.source", "not the manifest's");
    if (live.license !== manifest.license) refuse("bundle.license", "not the manifest's");
    // accepted: the floor is this key's; every key before it is retired (succession)
    const at = ctx.pinned.findIndex((k) => k.kid === kid);
    const gone = new Set([...retiredOn(record, ctx.pinned), ...ctx.pinned.slice(0, at).map((k) => k.kid)]);
    return {
      ok: true,
      value: {
        manifest,
        bundle: live,
        record: {
          kid,
          version: manifest.version,
          retired: ctx.pinned.map((k) => k.kid).filter((k) => gone.has(k)),
          held: { text, expires: manifest.expires },
        },
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Refused ? e.message : "not readable" };
  }
}

/** The bundle the record holds, if it is to be used now: unexpired, above the built-in one, and still a live bundle. */
export function heldBundle(
  stored: unknown,
  ctx: Pick<Context, "now" | "baseline" | "pinned">,
  checker: Checker,
): Bundle | null {
  const { record } = readRecord(stored, ctx);
  if (!record?.held) return null;
  try {
    const b = liveBundle(record.held.text, "record.held", checker);
    return b.version === record.version ? b : null;
  } catch {
    return null;
  }
}
