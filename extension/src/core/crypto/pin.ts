// The Sixkey PIN (QUICK-UNLOCK §4.6 option F, §5.2, §5.4; OWNER-DECISIONS/20, its 2026-10-30 notes): a PIN of 4 to 8
// digits that reopens Sixkey after a lock, also after a browser restart or an extension reload, until 5 wrong tries in a
// row (then the master password once). Pure functions over bytes; no storage here.
//
// What the PIN opens, and with what:
//   - sk_pin (chrome.storage.local, PinRecord): the PIN's set-up. It holds pinKek = PBKDF2(NFKC(PIN)) encrypted under a
//     key derived from the vault key, and the PBKDF2 parameters. Without the vault key it tells a copy of the profile
//     nothing; with the vault key there is nothing left to protect (whoever holds it can also brute-force the PIN, so the
//     set-up text says not to reuse one).
//   - sk_pin_restart (chrome.storage.local, pin-restart.ts): the vault key under a key derived from pinKek, with the
//     tries counted. The only thing a PIN opens; a PIN is never stored anywhere in a form that opens the vault.
// What a PIN protects: someone at this computer, who gets 5 tries. What it does not protect: anyone with a copy of this
// browser profile, or a program on this computer, can guess the PIN offline (every 4-digit PIN in seconds on one
// graphics card: docs/design/notes/PIN-RESTART-NOTES.md §2.4). The settings text says both.
// sk_quick (chrome.storage.session only) is the Touch ID / Windows Hello gate's (QUICK-UNLOCK §5.2 QuickSession, §5.4
// "Gate unlock"; QuickDevice, below): memory only, for one browser session and at most 12 hours. The PIN has no part in it
// since 2026-10-30.
import { CryptoError, bs, fromB64, randomBytes, toB64, utf8, type Random } from "./bytes";
import { assertKdfParams, hkdfAesKey, newPbkdf2Params, pbkdf2Bits, type Pbkdf2Params } from "./kdf";
import type { Vk } from "./vk";

export const PIN_MIN_DIGITS = 4;
export const PIN_MAX_DIGITS = 8;
/** Wrong PINs in a row before the master password is needed (§5.4; OWNER-DECISIONS/20, 2026-10-30: the PIN's one limit). */
export const QUICK_TRIES = 5;
/** How long the Touch ID / Windows Hello gate works after the master password was typed (§9 Q1). */
export const QUICK_TTL_MS = 12 * 3_600_000;
/** A clock earlier than armedAt by more than this counts as expired (§5.5: a clock moved back). */
export const QUICK_CLOCK_SLACK_MS = 60_000;

/** The HKDF label of the key, derived from the vault key, that seals pinKek in sk_pin. Local only: not a sync label. */
export const PIN_CFG_LABEL = "sixkey/v1/pin-cfg";
/** The AAD prefix (domain tag) of sk_pin. Local only. */
export const PIN_TAG = "sixkey-pin|1|";

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/; // keyring.ts's vault id
const HEX_RE = /^[0-9a-f]{16}$/; // a vault key id
const NO_SALT = new Uint8Array(0);

/**
 * The PIN as it is used: NFKC first (a Chinese IME's full-width １２３４ is 1234), white space around it dropped (a
 * paste), then exactly 4 to 8 ASCII digits. Anything else is null: a typo, not a guess (§5.4 step 3).
 */
export function normalizePin(input: string): string | null {
  if (typeof input !== "string") return null;
  const s = input.normalize("NFKC").trim();
  return /^[0-9]{4,8}$/.test(s) ? s : null;
}

/** pinKek = PBKDF2-SHA256(NFKC(PIN), salt, iterations, 256 bits). The parameters are held to kdf.ts's range. */
export async function derivePinKek(pin: string, kdf: Pbkdf2Params): Promise<Uint8Array> {
  assertKdfParams(kdf);
  if (kdf.name !== "PBKDF2") throw new CryptoError("invalid_kdf_params", "a PIN needs PBKDF2");
  const p = normalizePin(pin);
  if (p === null) throw new CryptoError("empty_password", "not a PIN");
  return pbkdf2Bits(utf8(p), fromB64(kdf.salt), kdf.iterations, 256);
}

/** New PBKDF2 parameters for a PIN: a fresh 16-byte salt, at least the 600k floor. */
export function newPinKdf(rng: Random = randomBytes, iterations?: number): Pbkdf2Params {
  return newPbkdf2Params(rng, iterations);
}

// ---- sk_pin --------------------------------------------------------------------------------------------------------

export type PinRecord = {
  v: 1;
  vaultId: string;
  vkId: string;
  digits: number;
  kdf: Pbkdf2Params;
  /** AES-GCM(HKDF(VK, ∅, PIN_CFG_LABEL), pinKek, AAD "sixkey-pin|1|{vaultId}|{vkId}") */
  iv: string;
  wrapped: string;
};

const pinAad = (vaultId: string, vkId: string) => utf8(`${PIN_TAG}${vaultId}|${vkId}`);
const cfgKey = (vk: Vk) => hkdfAesKey(vk.raw, NO_SALT, PIN_CFG_LABEL);

/** sk_pin for `vk` of vault `vaultId`: pinKek sealed under the vault key. */
export async function sealPinRecord(
  vk: Vk,
  vaultId: string,
  pinKek: Uint8Array,
  o: { digits: number; kdf: Pbkdf2Params },
  rng: Random = randomBytes,
): Promise<PinRecord> {
  if (pinKek.length !== 32) throw new RangeError("pinKek must be 32 bytes");
  const iv = rng(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bs(iv), additionalData: bs(pinAad(vaultId, vk.id)), tagLength: 128 },
      await cfgKey(vk),
      bs(pinKek),
    ),
  );
  return { v: 1, vaultId, vkId: vk.id, digits: o.digits, kdf: o.kdf, iv: toB64(iv), wrapped: toB64(ct) };
}

/**
 * pinKek from sk_pin, with the vault key it names. A CryptoError when the record is wrong: "decrypt_failed" only when the
 * AES-GCM decryption itself refuses it under this very key (WebCrypto's OperationError: its authentication failed, the
 * ciphertext is not what this key sealed, damaged or tampered with; the lengths that also give OperationError, an empty
 * IV or a ciphertext shorter than the tag, never get here: parsePinRecord takes only a 12-byte IV and a 48-byte
 * ciphertext), "unwrap_failed" otherwise (another key, a value that does not decode, a plaintext of the wrong length,
 * any other refusal). The key's own derivation (cfgKey) failing is thrown as it is: not the record's fault. The PIN's
 * note removes an sk_pin only for "decrypt_failed" (pin-restart-steps.ts notePassword; review of PINONE r2, S-02).
 */
export async function openPinRecord(r: PinRecord, vk: Vk): Promise<Uint8Array> {
  if (vk.id !== r.vkId) throw new CryptoError("unwrap_failed");
  const key = await cfgKey(vk);
  try {
    const out = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bs(fromB64(r.iv)), additionalData: bs(pinAad(r.vaultId, r.vkId)), tagLength: 128 },
        key,
        bs(fromB64(r.wrapped)),
      ),
    );
    if (out.length !== 32) throw new Error("length");
    return out;
  } catch (e) {
    throw new CryptoError((e as Error)?.name === "OperationError" ? "decrypt_failed" : "unwrap_failed");
  }
}

const isKdf = (k: unknown): k is Pbkdf2Params => {
  try {
    assertKdfParams(k);
    return (k as { name: string }).name === "PBKDF2";
  } catch {
    return false;
  }
};
const bytesOf = (s: unknown, n: number) => {
  try {
    return typeof s === "string" && fromB64(s).length === n;
  } catch {
    return false;
  }
};
const isDigits = (d: unknown): d is number =>
  Number.isInteger(d) && (d as number) >= PIN_MIN_DIGITS && (d as number) <= PIN_MAX_DIGITS;

/** sk_pin as stored: the record, null when there is none, "damaged" for anything else that is there. */
export function parsePinRecord(x: unknown): PinRecord | "damaged" | null {
  if (x === undefined || x === null) return null;
  const o = x as Partial<PinRecord>;
  const ok =
    typeof o === "object" &&
    o.v === 1 &&
    typeof o.vaultId === "string" &&
    ID_RE.test(o.vaultId) &&
    typeof o.vkId === "string" &&
    HEX_RE.test(o.vkId) &&
    isDigits(o.digits) &&
    isKdf(o.kdf) &&
    bytesOf(o.iv, 12) &&
    bytesOf(o.wrapped, 48);
  return ok ? (o as PinRecord) : "damaged"; // checked field by field above; stored as it is
}

/** The keyring's wraps as one comparable value: every re-wrap changes it (each carries a fresh IV and salt). */
export const wrapsTag = (k: { wraps: readonly { wrapped: string }[] }): string =>
  k.wraps.map((w) => w.wrapped).join(",");

const isTime = (t: unknown): t is number => typeof t === "number" && Number.isSafeInteger(t) && t >= 0;

// ---- sk_quick (method "device") --------------------------------------------------------------------------------------

/**
 * The parked key of the session layer, method "device" (QUICK-UNLOCK §5.2 QuickSession, §5.4 "Gate unlock"): a Touch ID
 * or Windows Hello credential enrolled without PRF (a gate) reopens Sixkey after a lock, once a user-verified assertion
 * has passed the check against its stored public key (src/core/service/device-unlock.ts). `vk` is the vault key itself,
 * base64, as in sk_session: NOT PROTECTED. The gate is the UI, nothing more: programs on this computer and anyone who
 * opens the browser's developer tools read it, which the label says (quickOnGate). Memory only, for at most 12 hours
 * (QUICK_TTL_MS, the clock rule below) and while `wraps` holds (any re-wrap of the keyring ends it); it is written only by
 * a master password or recovery key unlock, and by the enrolment that has just checked the master password.
 */
export type QuickDevice = {
  v: 1;
  method: "device";
  vaultId: string;
  vkId: string;
  armedAt: number;
  expiresAt: number;
  vk: string;
  wraps: string;
};
/** sk_quick: the gate's arming (the PIN's own half went on 2026-10-30: its record is sk_pin_restart). */
export type QuickSession = QuickDevice;

/** sk_quick for the gate: `vk` of vault `vaultId`, armed at `armedAt` (now) under the keyring whose wrapsTag is `wraps`. */
export function armDevice(vk: Vk, vaultId: string, armedAt: number, wraps: string): QuickDevice {
  return {
    v: 1,
    method: "device",
    vaultId,
    vkId: vk.id,
    armedAt,
    expiresAt: armedAt + QUICK_TTL_MS,
    vk: toB64(vk.raw),
    wraps,
  };
}

/** sk_quick as stored, or null for none or anything else (an unusable value: it is gone at the next restart). */
export function parseQuick(x: unknown): QuickSession | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Partial<QuickDevice>;
  const head =
    o.v === 1 &&
    typeof o.vaultId === "string" &&
    ID_RE.test(o.vaultId) &&
    typeof o.vkId === "string" &&
    HEX_RE.test(o.vkId) &&
    isTime(o.armedAt) &&
    isTime(o.expiresAt) &&
    typeof o.wraps === "string" &&
    o.wraps.length > 0;
  // a PIN arming of before 2026-10-30 (method "pin") is none: chrome.storage.session did not outlive the update anyway
  return head && o.method === "device" && bytesOf(o.vk, 32) ? (o as QuickDevice) : null; // checked field by field
}

/**
 * Still usable at `now`: not past expiresAt (now = expiresAt still counts), the clock not behind armedAt by more than a
 * minute, and a window no longer than 12 hours.
 */
export function quickLive(q: QuickSession, now: number): boolean {
  return now <= q.expiresAt && now >= q.armedAt - QUICK_CLOCK_SLACK_MS && q.expiresAt - q.armedAt <= QUICK_TTL_MS;
}
