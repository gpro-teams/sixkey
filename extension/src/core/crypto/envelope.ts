// Encrypted vault envelope (PLAN §3). The header is authenticated as AAD, and the checksum covers
// header + iv + ciphertext only, so integrity can be checked while locked and nothing about the plaintext leaks.
import { CryptoError, bs, fromB64, randomBytes, sha256, toB64, utf8, type Random } from "./bytes";
import { vaultEncryptionKey, type Vk } from "./vk";

export type EncryptedVault = {
  format: "sixkey-vault";
  formatVersion: 1;
  cipher: "AES-256-GCM";
  vaultId: string;
  vkId: string;
  rev: number; // monotonic revision, bound into the AAD so an old envelope cannot be passed off as a newer one
  iv: string; // base64, 12 random bytes, fresh for every encryption
  ciphertext: string; // base64, includes the 16 byte GCM tag
  checksum: string; // base64 SHA-256(aad || iv || ciphertext)
};

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const HEX_RE = /^[0-9a-f]{16}$/;
const GCM_TAG_BYTES = 16;

function aadBytes(vaultId: string, vkId: string, rev: number): Uint8Array {
  return utf8(`sixkey-vault|1|${vaultId}|${vkId}|${rev}`);
}

export function validateEnvelope(x: unknown): EncryptedVault {
  const bad = (m: string): never => {
    throw new CryptoError("invalid_envelope", m);
  };
  if (typeof x !== "object" || x === null) return bad("not an object");
  const o = x as Record<string, unknown>;
  if (o.format !== "sixkey-vault" || o.formatVersion !== 1 || o.cipher !== "AES-256-GCM")
    return bad("unsupported format");
  if (typeof o.vaultId !== "string" || !ID_RE.test(o.vaultId)) return bad("bad vaultId");
  if (typeof o.vkId !== "string" || !HEX_RE.test(o.vkId)) return bad("bad vkId");
  if (typeof o.rev !== "number" || !Number.isSafeInteger(o.rev) || o.rev < 0) return bad("bad rev");
  if (typeof o.iv !== "string" || fromB64(o.iv).length !== 12) return bad("bad iv");
  if (typeof o.ciphertext !== "string" || fromB64(o.ciphertext).length < GCM_TAG_BYTES) return bad("bad ciphertext");
  if (typeof o.checksum !== "string" || fromB64(o.checksum).length !== 32) return bad("bad checksum");
  return o as EncryptedVault;
}

/** Checksum + shape check with no key. Used by startup self-check and recovery. */
export async function isEnvelopeIntact(x: unknown): Promise<boolean> {
  try {
    const e = validateEnvelope(x);
    const expected = await sha256(aadBytes(e.vaultId, e.vkId, e.rev), fromB64(e.iv), fromB64(e.ciphertext));
    return toB64(expected) === e.checksum;
  } catch {
    return false;
  }
}

export async function encryptVault(
  plaintext: Uint8Array,
  vk: Vk,
  meta: { vaultId: string; rev: number },
  rng: Random = randomBytes,
): Promise<EncryptedVault> {
  if (!ID_RE.test(meta.vaultId)) throw new CryptoError("invalid_envelope", "bad vaultId");
  if (!Number.isSafeInteger(meta.rev) || meta.rev < 0) throw new CryptoError("invalid_envelope", "bad rev");
  const aad = aadBytes(meta.vaultId, vk.id, meta.rev);
  const iv = rng(12);
  const key = await vaultEncryptionKey(vk);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bs(iv), additionalData: bs(aad), tagLength: 128 },
      key,
      bs(plaintext),
    ),
  );
  return {
    format: "sixkey-vault",
    formatVersion: 1,
    cipher: "AES-256-GCM",
    vaultId: meta.vaultId,
    vkId: vk.id,
    rev: meta.rev,
    iv: toB64(iv),
    ciphertext: toB64(ct),
    checksum: toB64(await sha256(aad, iv, ct)),
  };
}

export async function decryptVault(envelope: unknown, vk: Vk): Promise<Uint8Array> {
  const e = validateEnvelope(envelope);
  if (e.vkId !== vk.id) throw new CryptoError("decrypt_failed", "envelope was encrypted with a different key");
  const key = await vaultEncryptionKey(vk);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bs(fromB64(e.iv)),
          additionalData: bs(aadBytes(e.vaultId, e.vkId, e.rev)),
          tagLength: 128,
        },
        key,
        bs(fromB64(e.ciphertext)),
      ),
    );
  } catch {
    throw new CryptoError("decrypt_failed");
  }
}
