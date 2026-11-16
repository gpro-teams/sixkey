// The device unlock's key (QUICK-UNLOCK §5.2; exactly YUBIKEY-DESIGN §1.2.1): the vault key wrapped under a key derived
// from a credential's WebAuthn PRF output. Pure functions over bytes; no storage (the record is prf-record.ts, its writer
// src/core/service/prf-store.ts) and no WebAuthn (src/platform/webauthn.ts). Loaded lazily, with the ceremony: neither
// the popup's nor the settings page's up-front bundle carries it.
//
//   KEK     = HKDF-SHA256(ikm = the 32-byte PRF output, salt = ∅, info = "sixkey/v1/kek-prf"), AES-256-GCM, not extractable
//   wrapped = AES-GCM(KEK, 12-byte IV, the vault key's 32 bytes, AAD = "sixkey-prf|1|{vaultId}|{vkId}|{credId}")
//
// The label is this file's own (local only, never a sync label; the contract test's list of local-only labels has it).
// The AAD binds the vault, the vault key and the credential: a wrap moved to another credential, vault or key does not
// open. The salt the PRF is evaluated at is 32 random bytes per credential (newPrfSalt), passed as `first`; the WebAuthn
// PRF extension hashes it with its own context string before the authenticator sees it, so it can never be confused with a
// raw hmac-secret input of another site [transcribed from the WebAuthn spec]. The PRF output, the KEK and the unwrapped
// key never leave these functions except as the vault key the caller asked for; nothing here logs.
//
// It imports no module of the popup's main chunk (only the leaf crypto-error.ts): a lazy chunk that does moves those
// modules into chunks of their own and costs the popup's counted bundle (docs/design/notes/SHAMIR-NOTES.md §7; measured
// again for this stage, PRF-NOTES.md). So the HKDF and AES-GCM calls are WebCrypto's own here, the base64 is this file's
// (b64 / unb64, standard with padding, as bytes.ts's), and the vault key's id is worked out by the caller's `vkOf`
// (vk.ts vkFromRaw: the id is HKDF of the key, and only vk.ts derives it).
//
// A gate credential's MAC (REVIEW S1, 2026-10-23): a gate holds no key material, only the public key Sixkey checks an
// assertion against, so without this anyone who can write the profile's storage could plant a credential of their own
// authenticator. Each gate credential carries
//   mac = HMAC-SHA256(HKDF-SHA256(the vault key, salt = ∅, info = "sixkey/v1/gate-mac"),
//                     "sixkey-gate|1|{vaultId}|{credId}|{alg}|{publicKey (base64)}")
// with the id of the vault key it was made under. It is written at enrolment and "turn back on", and checked only here,
// on the lazy side, by the gate unlock with the key the arming parked (device-unlock.ts): the popup's main chunk carries
// none of it. A key change leaves it under the old key, so a gate pauses until it is turned back on, as a PRF wrap does.
import { CryptoError } from "./crypto-error";
import type { PrfCred, PrfMac, PrfWrap } from "./prf-record";
import type { Vk } from "./vk";

/** The HKDF label of the KEK (shared with the YubiKey design, which has not shipped). Local only. */
export const PRF_KEK_LABEL = "sixkey/v1/kek-prf";
/** The AAD prefix (domain tag) of a PRF wrap. Local only. */
export const PRF_TAG = "sixkey-prf|1|";
/** The HKDF label of a gate credential's MAC key. Local only. */
export const GATE_MAC_LABEL = "sixkey/v1/gate-mac";
/** The prefix (domain tag) of what a gate credential's MAC covers. Local only. */
export const GATE_TAG = "sixkey-gate|1|";

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

const aad = (vaultId: string, vkId: string, credId: string) => utf8(`${PRF_TAG}${vaultId}|${vkId}|${credId}`);

/** KEK = HKDF-SHA256(the PRF output, empty salt, PRF_KEK_LABEL), as AES-256-GCM, not extractable (kdf.ts hkdfAesKey's form). */
async function kek(prf: Uint8Array): Promise<CryptoKey> {
  if (prf.length !== 32) throw new CryptoError("unwrap_failed", "a PRF output is 32 bytes");
  const base = await crypto.subtle.importKey("raw", bs(prf), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(PRF_KEK_LABEL) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** A fresh salt for a credential's PRF: 32 random bytes. */
export const newPrfSalt = (rng: Random = randomBytes): Uint8Array => rng(32);

/** The vault key `vk` of vault `vaultId`, wrapped for credential `credId` under the KEK of its PRF output `prf`. */
export async function sealPrfWrap(
  vk: Vk,
  vaultId: string,
  credId: string,
  prf: Uint8Array,
  rng: Random = randomBytes,
): Promise<PrfWrap> {
  const iv = rng(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bs(iv), additionalData: bs(aad(vaultId, vk.id, credId)), tagLength: 128 },
      await kek(prf),
      bs(vk.raw),
    ),
  );
  return { vkId: vk.id, iv: b64(iv), wrapped: b64(ct) };
}

/**
 * The vault key from a wrap and the PRF output the credential returned. Another PRF output (another salt, credential or
 * authenticator, no user verification), another vault, key or credential id, or tampering: unwrap_failed. The key's id is
 * checked after the unwrap (QUICK-UNLOCK §7.1), with `vkOf` (vk.ts vkFromRaw).
 */
export async function openPrfWrap(
  w: PrfWrap,
  vaultId: string,
  credId: string,
  prf: Uint8Array,
  vkOf: (raw: Uint8Array) => Promise<Vk | null>,
): Promise<Vk> {
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bs(unb64(w.iv)), additionalData: bs(aad(vaultId, w.vkId, credId)), tagLength: 128 },
        await kek(prf),
        bs(unb64(w.wrapped)),
      ),
    );
  } catch {
    throw new CryptoError("unwrap_failed");
  }
  const vk = await vkOf(raw).catch(() => null);
  if (!vk || vk.id !== w.vkId) throw new CryptoError("unwrap_failed");
  return vk;
}

/** What a gate credential's MAC covers: the vault, the credential id, the algorithm, the public key as stored. */
const gateData = (vaultId: string, c: Pick<PrfCred, "id" | "alg" | "publicKey">) =>
  utf8(`${GATE_TAG}${vaultId}|${c.id}|${c.alg}|${c.publicKey}`);

/** The MAC key: HKDF-SHA256(the vault key, empty salt, GATE_MAC_LABEL), HMAC-SHA256, not extractable. */
async function macKey(vk: Vk): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", bs(vk.raw), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(GATE_MAC_LABEL) },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

/** A gate credential's MAC under the vault key `vk` of vault `vaultId` (enrolment, "turn back on"). */
export async function gateMac(vk: Vk, vaultId: string, c: Pick<PrfCred, "id" | "alg" | "publicKey">): Promise<PrfMac> {
  const tag = new Uint8Array(await crypto.subtle.sign("HMAC", await macKey(vk), bs(gateData(vaultId, c))));
  return { vkId: vk.id, tag: b64(tag) };
}

/**
 * The gate credential `c` was made by Sixkey for vault `vaultId` under the vault key `vk`: its MAC checks. None, one made
 * under another key (a key change: paused), or any field changed since (the vault, the id, the algorithm, the public key):
 * false. Never throws.
 */
export async function gateMacOk(vk: Vk, vaultId: string, c: PrfCred): Promise<boolean> {
  if (!c.mac) return false;
  try {
    return await crypto.subtle.verify("HMAC", await macKey(vk), bs(unb64(c.mac.tag)), bs(gateData(vaultId, c)));
  } catch {
    return false;
  }
}
