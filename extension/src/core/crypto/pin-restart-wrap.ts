// The PIN after a restart's crypto (OWNER-DECISIONS/20; the record: pin-restart.ts; docs/design/notes/PIN-RESTART-NOTES.md
// §2): the wrap, the MAC and the full field check. Pure functions over bytes; no storage. Loaded lazily, with the unlock
// that uses it (the lock screen's PIN, src/core/service/pin-restart-steps.ts) and the settings box (pin-restart-admin.ts):
// neither the popup's nor the side panel's up-front bundle carries it.
//
//   KEK     = PBKDF2-SHA256(password = pinKek, salt = the record's own 16 random bytes, iterations >= 2,000,000, 256 bits),
//             as AES-256-GCM, not extractable. pinKek = PBKDF2-SHA256(NFKC(PIN), sk_pin's salt, 600,000): the PIN's own
//             key (pin.ts derivePinKek), which sk_pin also holds sealed under the vault key, so a master password can
//             make the wrap again without the PIN, and a PIN guess costs both derivations.
//   wrapped = AES-256-GCM(KEK, 12-byte IV, the vault key's 32 bytes,
//                         AAD = "sixkey-pin-restart|1|{vaultId}|{vkId}|{id}|{setup}|{wraps}")
//   mac     = HMAC-SHA256(HKDF-SHA256(the vault key, salt = ∅, info = "sixkey/v1/pin-restart-mac"),
//                         "sixkey-pin-restart-mac|1|{vaultId}|{vkId}|{id}|{setup}|{wraps}")
//
// The KDF is the master password's own (kdf.ts: PBKDF2-SHA256, WebCrypto has no Argon2 and the exact CSP check-dist
// enforces has no 'wasm-unsafe-eval'), at no fewer iterations than a new master-password wrap gets (RESTART_ITERATIONS,
// kdf.ts's PBKDF2_PASSWORD_WRAP_ITERATIONS restated, a test holds the two equal) nor than any password wrap of this
// keyring carries (restartIterations). The labels and tags are this file's own: local only, never a sync label, distinct
// from the PRF's, the gate's, the PIN's and the master password's (the contract test's list of local-only labels has
// them). The AAD binds the vault, the vault key, the record, the PIN set-up and the keyring's wraps, so a wrap copied into
// another record, one for another vault or key, or a record edited to look current after a key change, does not open.
// The MAC, under the vault key, is what makes a record Sixkey's own when it holds no wrap (set aside after the 5th wrong
// PIN): the master password makes the wrap again only for a record whose MAC checks, so a record planted in the profile's
// storage (by anyone who can write it, without the vault key) is never made into one that opens.
//
// It imports no module of the popup's main chunk (only the leaf crypto-error.ts): a lazy chunk that does moves those
// modules into chunks of their own and costs the popup's counted bundle (docs/design/notes/SHAMIR-NOTES.md §7, PRF-NOTES.md
// §9). So PBKDF2, HKDF, HMAC and AES-GCM are WebCrypto's own calls here, and the base64 is this file's (standard, with
// padding, bytes.ts's format). Nothing here keeps or logs pinKek, the KEK or the vault key.
import { CryptoError } from "./crypto-error";
import type { RestartRecord, RestartWrap } from "./pin-restart";

/** The AAD prefix (domain tag) of the wrap. Local only. */
export const RESTART_TAG = "sixkey-pin-restart|1|";
/** The HKDF label of the record's MAC key. Local only. */
export const RESTART_MAC_LABEL = "sixkey/v1/pin-restart-mac";
/** The prefix (domain tag) of what the MAC covers. Local only. */
export const RESTART_MAC_TAG = "sixkey-pin-restart-mac|1|";
/** A new wrap's PBKDF2 count at least: kdf.ts PBKDF2_PASSWORD_WRAP_ITERATIONS, restated (a test holds them equal). */
export const RESTART_ITERATIONS = 2_000_000;
/** kdf.ts's range for a count read back (PBKDF2_MIN_ITERATIONS, PBKDF2_MAX_ITERATIONS), restated. */
const MIN_ITERATIONS = 600_000;
const MAX_ITERATIONS = 20_000_000;
/** QUICK-UNLOCK's tries (pin.ts QUICK_TRIES), restated. */
const TRIES = 5;

type Random = (n: number) => Uint8Array;
const randomBytes: Random = (n) => crypto.getRandomValues(new Uint8Array(n));
const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);
const bs = (b: Uint8Array): BufferSource => b as BufferSource;

/** Standard base64 with padding (bytes.ts toB64's format). */
export function b64(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
}
/** Standard base64 with padding, strictly (bytes.ts fromB64's rules); anything else: CryptoError invalid_envelope. */
export function unb64(s: string): Uint8Array {
  if (typeof s !== "string" || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s))
    throw new CryptoError("invalid_envelope", "bad base64");
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** What the AAD and the MAC bind of a record. */
export type RestartHead = Pick<RestartRecord, "vaultId" | "vkId" | "id" | "setup" | "wraps">;
const bound = (h: RestartHead) => `${h.vaultId}|${h.vkId}|${h.id}|${h.setup}|${h.wraps}`;

/** A new record id: 16 random bytes. */
export const newRestartId = (rng: Random = randomBytes): string => b64(rng(16));

/**
 * A new wrap's PBKDF2 count: the master password's for a new wrap (RESTART_ITERATIONS, or the service's test hook), and
 * never fewer than any password wrap of `keyring` carries, so it is never weaker than what guards the master password here.
 */
export function restartIterations(
  hook: number | undefined,
  keyring: { wraps: readonly { method: string; kdf?: object }[] },
): number {
  let n = hook ?? RESTART_ITERATIONS;
  for (const w of keyring.wraps) {
    const it = w.method === "password" ? (w.kdf as { iterations?: unknown } | undefined)?.iterations : undefined;
    if (typeof it === "number" && Number.isSafeInteger(it) && it > n && it <= MAX_ITERATIONS) n = it;
  }
  return n;
}

/** KEK = PBKDF2-SHA256(pinKek, the wrap's salt, its count), as AES-256-GCM, not extractable. */
async function kekOf(pinKek: Uint8Array, kdf: RestartWrap["kdf"]): Promise<CryptoKey> {
  if (pinKek.length !== 32) throw new CryptoError("unwrap_failed", "pinKek is 32 bytes");
  if (!kdfOk(kdf)) throw new CryptoError("invalid_kdf_params");
  const base = await crypto.subtle.importKey("raw", bs(pinKek), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: bs(unb64(kdf.salt)), iterations: kdf.iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** The vault key's raw bytes, wrapped for the record `head` under the KEK of `pinKek`, at `iterations`, with a new salt. */
export async function sealRestart(
  vkRaw: Uint8Array,
  head: RestartHead,
  pinKek: Uint8Array,
  iterations: number,
  rng: Random = randomBytes,
): Promise<RestartWrap> {
  if (vkRaw.length !== 32) throw new RangeError("the vault key is 32 bytes");
  const kdf: RestartWrap["kdf"] = { name: "PBKDF2", hash: "SHA-256", iterations, salt: b64(rng(16)), v: 1 };
  const iv = rng(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bs(iv), additionalData: bs(utf8(RESTART_TAG + bound(head))), tagLength: 128 },
      await kekOf(pinKek, kdf),
      bs(vkRaw),
    ),
  );
  return { kdf, iv: b64(iv), wrapped: b64(ct) };
}

/**
 * The vault key's raw bytes from a wrap and the pinKek a typed PIN derived. A wrong PIN, another record, vault, key, PIN
 * set-up or set of wraps, or tampering: unwrap_failed. The caller checks the key's id after it (QUICK-UNLOCK §7.1).
 */
export async function openRestart(w: RestartWrap, head: RestartHead, pinKek: Uint8Array): Promise<Uint8Array> {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bs(unb64(w.iv)), additionalData: bs(utf8(RESTART_TAG + bound(head))), tagLength: 128 },
        await kekOf(pinKek, w.kdf),
        bs(unb64(w.wrapped)),
      ),
    );
  } catch {
    throw new CryptoError("unwrap_failed");
  }
}

/** The MAC key: HKDF-SHA256(the vault key, empty salt, RESTART_MAC_LABEL), HMAC-SHA256, not extractable. */
async function macKey(vkRaw: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", bs(vkRaw), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(RESTART_MAC_LABEL) },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

/** The record's MAC under the vault key whose raw bytes are `vkRaw` (made with every wrap). */
export async function restartMac(vkRaw: Uint8Array, head: RestartHead): Promise<string> {
  return b64(
    new Uint8Array(await crypto.subtle.sign("HMAC", await macKey(vkRaw), bs(utf8(RESTART_MAC_TAG + bound(head))))),
  );
}

/** The record was made by Sixkey for this vault key (its MAC checks, in constant time). Never throws. */
export async function restartMacOk(vkRaw: Uint8Array, head: RestartHead, mac: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      "HMAC",
      await macKey(vkRaw),
      bs(unb64(mac)),
      bs(utf8(RESTART_MAC_TAG + bound(head))),
    );
  } catch {
    return false;
  }
}

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/; // keyring.ts's vault id
const HEX_RE = /^[0-9a-f]{16}$/; // a vault key id
const WRAPS_RE = /^[A-Za-z0-9+/=,]{1,8192}$/; // pin.ts wrapsTag: base64 joined by commas
const isTime = (t: unknown): t is number => typeof t === "number" && Number.isSafeInteger(t) && t >= 0;
/** Standard base64 of exactly `n` bytes, without decoding it. */
const b64Of = (s: unknown, n: number) =>
  typeof s === "string" &&
  /^[A-Za-z0-9+/]*={0,2}$/.test(s) &&
  s.length % 4 === 0 &&
  (s.length / 4) * 3 - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0) === n;
/** PBKDF2-SHA256, version 1, a 16-byte salt, a count within kdf.ts's range. */
const kdfOk = (k: unknown): k is RestartWrap["kdf"] => {
  const o = k as Partial<RestartWrap["kdf"]> | null;
  return (
    typeof o === "object" &&
    o !== null &&
    o.name === "PBKDF2" &&
    o.hash === "SHA-256" &&
    o.v === 1 &&
    Number.isSafeInteger(o.iterations) &&
    (o.iterations as number) >= MIN_ITERATIONS &&
    (o.iterations as number) <= MAX_ITERATIONS &&
    b64Of(o.salt, 16)
  );
};

/**
 * Every field of the record: its version, a 16-byte id, the vault id and key id, a 16-byte set-up salt, the wraps as
 * pin.ts writes them, a 32-byte MAC, the time, the count (0 to 5), and the wrap: null, or PBKDF2 parameters within kdf.ts's
 * range, a 12-byte IV and 48 bytes (the key and the tag); and nothing else. Whether the MAC checks is for the caller to
 * ask, with the vault key (restartMacOk).
 */
export function restartOk(x: unknown): x is RestartRecord {
  const o = x as Partial<RestartRecord> | null;
  return (
    typeof o === "object" &&
    o !== null &&
    o.v === 1 &&
    b64Of(o.id, 16) &&
    typeof o.vaultId === "string" &&
    ID_RE.test(o.vaultId) &&
    typeof o.vkId === "string" &&
    HEX_RE.test(o.vkId) &&
    b64Of(o.setup, 16) &&
    typeof o.wraps === "string" &&
    WRAPS_RE.test(o.wraps) &&
    b64Of(o.mac, 32) &&
    isTime(o.lastPasswordAt) &&
    Number.isSafeInteger(o.fails) &&
    (o.fails as number) >= 0 &&
    (o.fails as number) <= TRIES &&
    (o.wrap === null ||
      (typeof o.wrap === "object" &&
        o.wrap !== undefined &&
        kdfOk(o.wrap.kdf) &&
        b64Of(o.wrap.iv, 12) &&
        b64Of(o.wrap.wrapped, 48) &&
        Object.keys(o.wrap).length === 3)) &&
    Object.keys(o).every((k) =>
      ["v", "id", "vaultId", "vkId", "setup", "wraps", "mac", "lastPasswordAt", "fails", "wrap"].includes(k),
    )
  );
}
