// The write proof (§2.2, §5.2) and the HMAC it is made with, on their own so that the outbox writer (and with it the
// popup, whose runtime wires the writer, M5) carries them without the other VK subkeys (SYNC-DESIGN §7, revision 24: the
// engine-only parts of the shared modules stay out of the popup's module graph). subkeys.ts re-exports them.
import { bs, toB64, utf8 } from "../../crypto/bytes";
import { hkdfBits } from "../../crypto/kdf";
import type { Vk } from "../../crypto/vk";
import { ID_RE, b64 } from "./basic-encoding";
import { SyncCryptoError } from "./errors";
import { LABEL, TAG } from "./labels";

/** The empty HKDF salt every VK subkey is derived with (§2.1). */
export const NO_SALT = new Uint8Array(0);
/** HMAC-SHA256 with an explicit 256-bit key (WebCrypto's default HMAC key length is the hash block size, §2.2 N3). */
export const HMAC_256 = { name: "HMAC", hash: "SHA-256", length: 256 } as const;

export async function hmacSha256(key: CryptoKey, data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, bs(utf8(data))));
}

export type WriteTarget = { vaultId: string; ifVersion: number; checksum: string };

/** 'sixkey-write|1|{vaultId}|{if_version}|{envelope.checksum}' (§2.2, §5.2): binds the proof to one write. */
export function writeProofInput(t: WriteTarget): string {
  if (typeof t.vaultId !== "string" || !ID_RE.test(t.vaultId))
    throw new SyncCryptoError("invalid_argument", "bad vaultId");
  if (!Number.isSafeInteger(t.ifVersion) || t.ifVersion < 0)
    throw new SyncCryptoError("invalid_argument", "bad if_version");
  b64(t.checksum, 32);
  return `${TAG.write}${t.vaultId}|${t.ifVersion}|${t.checksum}`;
}

/** write_proof = HMAC-SHA256(K_write, input), standard base64. */
export async function writeProof(vk: Vk, t: WriteTarget): Promise<string> {
  const input = writeProofInput(t);
  const k = await hkdfBits(vk.raw, NO_SALT, LABEL.vaultWrite, 256);
  const key = await crypto.subtle.importKey("raw", bs(k), HMAC_256, false, ["sign"]);
  k.fill(0);
  return toB64(await hmacSha256(key, input));
}
