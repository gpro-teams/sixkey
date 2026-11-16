// The vault key (VK): 32 random bytes. Everything else is derived from or wraps these bytes.
import { hkdfAesKey, hkdfBits } from "./kdf";
import { randomBytes, type Random } from "./bytes";

export type Vk = { raw: Uint8Array; id: string };

const NO_SALT = new Uint8Array(0);

/** Short public fingerprint, derived (not random) so it always matches the key. Safe to store: HKDF output is independent of the key. */
async function vkId(raw: Uint8Array): Promise<string> {
  const b = await hkdfBits(raw, NO_SALT, "sixkey/v1/vk-id", 64);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function vkFromRaw(raw: Uint8Array): Promise<Vk> {
  if (raw.length !== 32) throw new RangeError("VK must be 32 bytes");
  return { raw, id: await vkId(raw) };
}

export async function generateVk(rng: Random = randomBytes): Promise<Vk> {
  return vkFromRaw(rng(32));
}

/** Non-extractable AES-256-GCM key used for the vault payload. */
export function vaultEncryptionKey(vk: Vk): Promise<CryptoKey> {
  return hkdfAesKey(vk.raw, NO_SALT, "sixkey/v1/vault-enc");
}
