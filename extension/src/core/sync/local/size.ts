// The local size check for sync (SYNC-DESIGN §4.3 C5, D3): the client refuses an edit the server would refuse to store,
// before it is saved. One constant and one measure, the contract's: MAX_ENVELOPE_BYTES, and the UTF-8 bytes of the text
// of the envelope that would be uploaded (also the server's size_bytes). That envelope is the vault's plaintext padded to
// 16 KiB buckets and encrypted as an ordinary EncryptedVault, so its text length follows from the plaintext length
// exactly; nothing is encrypted to measure it.
import type { EncryptedVault } from "../../crypto/envelope";
import { canonicalJson } from "../../vault/merge";
import { isPurged, type Entry, type Vault } from "../../vault/model";
import { SYNC_CONSTANTS } from "../crypto/constants";
import { envelopeSizeBytes, envelopeText, paddedLength } from "../crypto/padding";

export const MAX_ENVELOPE_BYTES = SYNC_CONSTANTS.MAX_ENVELOPE_BYTES;

const GCM_TAG_BYTES = 16;
const b64Length = (bytes: number) => 4 * Math.ceil(bytes / 3);

/**
 * The size of the upload envelope for a plaintext of `plaintextBytes` (the serialized vault, before padding), under
 * `vaultId` and `vkId`, at revision `rev`: an envelope of the very shape encryptVault makes (same members, the same
 * order, fixed-length iv and checksum), measured with the contract's function. `rev` is the server version the upload
 * would get; it is part of the text, so the local check passes the largest it could be (MAX_SAFE_INTEGER, 16 digits) and
 * never measures less than the upload will be (at most 15 bytes more).
 */
export function uploadEnvelopeBytes(
  plaintextBytes: number,
  o: { vaultId: string; vkId: string; rev?: number },
): number {
  const shape: EncryptedVault = {
    format: "sixkey-vault",
    formatVersion: 1,
    cipher: "AES-256-GCM",
    vaultId: o.vaultId,
    vkId: o.vkId,
    rev: o.rev ?? Number.MAX_SAFE_INTEGER,
    iv: "A".repeat(b64Length(12)),
    ciphertext: "",
    checksum: "A".repeat(b64Length(32)),
  };
  // The ciphertext is base64, one byte per character in UTF-8: added, not built (it can be megabytes).
  return envelopeSizeBytes(envelopeText(shape)) + b64Length(paddedLength(plaintextBytes) + GCM_TAG_BYTES);
}

/**
 * Whether a local edit may be saved while sync is on (§4.3, D3): refused only when it makes the measure larger AND the
 * result is over the limit. Moving to the trash and erasing for good are exempt whatever the sizes (the caller decides
 * that, by what the edit did, not by the sizes: a delete can cross a 16 KiB bucket upward). Anything that shrinks the
 * vault, or stays within the limit, is allowed, so a vault over the limit can always be cleaned up.
 */
export function editFits(before: number, after: number): boolean {
  return after <= before || after <= MAX_ENVELOPE_BYTES;
}

/** An entry without its deletion register (deleted, dhlc). */
const restOf = (e: Entry) => canonicalJson({ ...e, deleted: undefined, dhlc: undefined });

/**
 * The edit only moves entries to the trash or erases them for good (§4.3 D3's exemption), judged by what changed, entry by
 * entry: no entry added or removed, and every entry that differs either is now erased (it was not before) or differs
 * only in its deletion register, now set to deleted. A restore from the trash, an edit, an add: not exempt.
 */
export function exemptFromSizeCheck(before: Vault, after: Vault): boolean {
  if (after.entries.length !== before.entries.length) return false;
  const was = new Map(before.entries.map((e) => [e.id, e]));
  for (const n of after.entries) {
    const o = was.get(n.id);
    if (!o) return false;
    if (canonicalJson(o) === canonicalJson(n)) continue;
    if (isPurged(n) && !isPurged(o)) continue;
    if (n.deleted === true && restOf(o) === restOf(n)) continue;
    return false;
  }
  return true;
}
