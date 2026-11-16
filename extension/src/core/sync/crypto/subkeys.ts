// Keys derived from the VK for sync (§2.1, §2.2): HKDF-SHA256, empty salt, 256 bits each. All are non-extractable
// CryptoKeys except K_write, which the server stores to check write proofs and therefore has to exist as bytes.
// HMAC keys are derived with an explicit length of 256: WebCrypto's HMAC deriveKey without a length yields the hash
// block size, 512 bits, and so a different MAC (§2.2, N3).
import { bs, sha256, toB64, utf8 } from "../../crypto/bytes";
import { hkdfAesKey, hkdfBits } from "../../crypto/kdf";
import type { Vk } from "../../crypto/vk";
import { LABEL } from "./labels";
import { HMAC_256, NO_SALT } from "./write-proof";

// the write proof and the HMAC live in write-proof.ts (the outbox writer, which the popup loads, needs only those)
export { HMAC_256, NO_SALT, hmacSha256, writeProof, writeProofInput, type WriteTarget } from "./write-proof";

export async function hkdfHmacKey(ikm: Uint8Array, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", bs(ikm), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bs(NO_SALT), info: bs(utf8(info)) },
    base,
    HMAC_256,
    false,
    ["sign", "verify"],
  );
}

/** K_mac: the KeyBundle MAC key. */
export const bundleMacKey = (vk: Vk): Promise<CryptoKey> => hkdfHmacKey(vk.raw, LABEL.keybundleMac);
/** K_name: AES-256-GCM for device names. */
export const deviceNameKey = (vk: Vk): Promise<CryptoKey> => hkdfAesKey(vk.raw, NO_SALT, LABEL.deviceName);
/** K_devbackup: AES-256-GCM for the VK-encrypted copy of the device key (§2.5). */
export const deviceBackupKey = (vk: Vk): Promise<CryptoKey> => hkdfAesKey(vk.raw, NO_SALT, LABEL.deviceBackup);

/** K_write as standard base64, sent as write_key / new_write_key. It reveals nothing about the VK or its other subkeys (§2.1). */
export async function writeKey(vk: Vk): Promise<string> {
  const k = await hkdfBits(vk.raw, NO_SALT, LABEL.vaultWrite, 256);
  const out = toB64(k);
  k.fill(0);
  return out;
}

/** SHA-256(tag || raw bytes): the form of both server-side verifiers (§2.2). */
export async function taggedDigest(tag: string, raw: Uint8Array): Promise<Uint8Array> {
  return sha256(utf8(tag), raw);
}
