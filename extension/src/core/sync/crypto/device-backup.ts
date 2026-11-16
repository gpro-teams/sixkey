// sk_sync_cfg.enc (§2.5, d2): the VK-encrypted copy of the device signing key and the account email, so an identity
// lost with IndexedDB can be restored after unlock. Plaintext = canonicalJson({dsk: private JWK, email}); the doc leaves
// the serialization open (only this client reads it) and this follows the shared vector.
import { bs, randomBytes, toB64, utf8, type Random } from "../../crypto/bytes";
import type { Vk } from "../../crypto/vk";
import { DEVICE_ID_RE, ID_RE, b64, canonicalJsonStrict, fromB64u, isPlainObject, parseIntegerJson } from "./encoding";
import { SyncCryptoError } from "./errors";
import { TAG } from "./labels";
import { deviceBackupKey } from "./subkeys";

export type DeviceKeyJwk = { kty: "EC"; crv: "P-256"; x: string; y: string; d: string };
export type DeviceBackupPlain = { dsk: DeviceKeyJwk; email: string };
export type DeviceBackup = { vkId: string; iv: string; ct: string };
export type BackupOwner = { vaultId: string; deviceId: string };

/** Only the five members that define the key; ext / key_ops from an export are dropped. */
export function deviceKeyJwk(j: unknown): DeviceKeyJwk {
  const o = isPlainObject(j) ? j : {};
  const coord = (v: unknown) => {
    try {
      return typeof v === "string" && fromB64u(v).length === 32;
    } catch {
      return false;
    }
  };
  if (o.kty !== "EC" || o.crv !== "P-256" || !coord(o.x) || !coord(o.y) || !coord(o.d))
    throw new SyncCryptoError("invalid_key", "not a P-256 private JWK");
  return { kty: "EC", crv: "P-256", x: o.x as string, y: o.y as string, d: o.d as string };
}

function backupAad(o: BackupOwner, vkId: string): Uint8Array {
  if (!ID_RE.test(o.vaultId) || !DEVICE_ID_RE.test(o.deviceId))
    throw new SyncCryptoError("invalid_argument", "bad vaultId or deviceId");
  return utf8(`${TAG.devkey}${o.vaultId}|${vkId}|${o.deviceId}`);
}

export async function sealDeviceBackup(
  vk: Vk,
  owner: BackupOwner,
  plain: { dsk: unknown; email: string },
  rng: Random = randomBytes,
): Promise<DeviceBackup> {
  if (typeof plain.email !== "string") throw new SyncCryptoError("invalid_argument", "bad email");
  const pt = utf8(canonicalJsonStrict({ dsk: deviceKeyJwk(plain.dsk), email: plain.email }));
  const iv = rng(12);
  try {
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: bs(iv), additionalData: bs(backupAad(owner, vk.id)), tagLength: 128 },
        await deviceBackupKey(vk),
        bs(pt),
      ),
    );
    return { vkId: vk.id, iv: toB64(iv), ct: toB64(ct) };
  } finally {
    pt.fill(0); // holds the private key
  }
}

export async function openDeviceBackup(vk: Vk, owner: BackupOwner, enc: DeviceBackup): Promise<DeviceBackupPlain> {
  if (enc?.vkId !== vk.id) throw new SyncCryptoError("decrypt_failed", "backup encrypted under another key");
  let pt: Uint8Array;
  try {
    pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bs(b64(enc.iv, 12)), additionalData: bs(backupAad(owner, vk.id)), tagLength: 128 },
        await deviceBackupKey(vk),
        bs(b64(enc.ct)),
      ),
    );
  } catch {
    throw new SyncCryptoError("decrypt_failed");
  }
  try {
    const o = parseIntegerJson(new TextDecoder().decode(pt));
    if (!isPlainObject(o) || typeof o.email !== "string") throw new SyncCryptoError("invalid_payload", "bad backup");
    return { dsk: deviceKeyJwk(o.dsk), email: o.email };
  } finally {
    pt.fill(0);
  }
}
