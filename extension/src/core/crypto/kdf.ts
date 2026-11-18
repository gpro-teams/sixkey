// Key derivation. PBKDF2 for the master password (WebCrypto has no Argon2 yet), HKDF for high-entropy secrets.
// Parameters are versioned and stored beside every wrapped key so they can be raised later.
import { CryptoError, bs, fromB64, randomBytes, toB64, utf8, type Random } from "./bytes";

export const PBKDF2_MIN_ITERATIONS = 600_000; // OWASP floor for PBKDF2-HMAC-SHA256; also enforced when reading stored params
export const PBKDF2_MAX_ITERATIONS = 20_000_000; // bound the work a hostile server can ask the client to do
/** Every PBKDF2 use that names no count: backup files and the PIN (pin.ts); the server sync's engine too, until DV-0b. */
export const PBKDF2_DEFAULT_ITERATIONS = 600_000;
/**
 * New master-password wraps of this device's keyring (VaultService: first run, restore, start over, turning the master
 * password on, a password change, the reset, a key rotation). The user now chooses the password and may keep one below
 * the 50-bit bar (OWNER-DECISIONS/15), so each offline guess at a copied profile costs 3.3 times what 600k cost; the
 * value was measured in Chrome (docs/design/notes/OWN-PASSWORD-NOTES.md §2). A wrap is read at the count it carries, within
 * the range below, so a 600k wrap still opens; it is re-wrapped at this count only when a new wrap is made (the next
 * password change), never on an unlock. Nothing else uses it.
 */
export const PBKDF2_PASSWORD_WRAP_ITERATIONS = 2_000_000;

export type Pbkdf2Params = { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string; v: 1 };
export type HkdfParams = { name: "HKDF"; hash: "SHA-256"; salt: string; v: 1 };
export type KdfParams = Pbkdf2Params | HkdfParams;

const aesGcm = { name: "AES-GCM", length: 256 } as const;

export function newPbkdf2Params(rng: Random = randomBytes, iterations = PBKDF2_DEFAULT_ITERATIONS): Pbkdf2Params {
  const p: Pbkdf2Params = { name: "PBKDF2", hash: "SHA-256", iterations, salt: toB64(rng(16)), v: 1 };
  assertKdfParams(p);
  return p;
}

export function newHkdfParams(rng: Random = randomBytes): HkdfParams {
  return { name: "HKDF", hash: "SHA-256", salt: toB64(rng(16)), v: 1 };
}

export function assertKdfParams(p: unknown): asserts p is KdfParams {
  const bad = (m: string): never => {
    throw new CryptoError("invalid_kdf_params", m);
  };
  if (typeof p !== "object" || p === null) return bad("not an object");
  const o = p as Record<string, unknown>;
  if (o.v !== 1 || o.hash !== "SHA-256" || typeof o.salt !== "string") return bad("unsupported kdf version or hash");
  if (fromB64(o.salt).length < 16) return bad("salt too short");
  if (o.name === "HKDF") return;
  if (o.name !== "PBKDF2") return bad("unknown kdf");
  const it = o.iterations;
  if (typeof it !== "number" || !Number.isInteger(it) || it < PBKDF2_MIN_ITERATIONS || it > PBKDF2_MAX_ITERATIONS)
    return bad("iterations out of range");
}

/** NFKC so full-width and half-width input from different IMEs derive the same key. */
export function normalizePassword(password: string): string {
  const n = password.normalize("NFKC");
  if (n.length === 0) throw new CryptoError("empty_password");
  return n;
}

/** Low-level PBKDF2, exported for known-answer tests. Callers should use deriveKekFromPassword. */
export async function pbkdf2Bits(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  bits: number,
): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", bs(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: bs(salt), iterations }, base, bits),
  );
}

export async function hkdfBits(ikm: Uint8Array, salt: Uint8Array, info: string, bits: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", bs(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: bs(salt), info: bs(utf8(info)) }, base, bits),
  );
}

/** Non-extractable AES-GCM key derived from a high-entropy secret. */
export async function hkdfAesKey(ikm: Uint8Array, salt: Uint8Array, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", bs(ikm), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bs(salt), info: bs(utf8(info)) },
    base,
    aesGcm,
    false,
    ["encrypt", "decrypt"],
  );
}

export async function deriveKekFromPassword(password: string, params: KdfParams): Promise<CryptoKey> {
  assertKdfParams(params);
  if (params.name !== "PBKDF2") throw new CryptoError("invalid_kdf_params", "password needs PBKDF2");
  const base = await crypto.subtle.importKey("raw", bs(utf8(normalizePassword(password))), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: bs(fromB64(params.salt)), iterations: params.iterations },
    base,
    aesGcm,
    false,
    ["encrypt", "decrypt"],
  );
}
