// The outbox writer (SYNC-DESIGN §4.7, P10, D2; M3) and the upload envelope it shares with the engine's round (§4.1,
// §4.2 step 6). What it writes and when: outbox.ts (the records). On its own so that the popup, whose runtime wires the
// writer into the service's port (M5), loads it without the records' parsers and the rest of the engine's code (§7,
// revision 24). It only uses modules the popup loads anyway (envelope, padding, the write proof, validate, state, keys).
import { randomBytes, type Random } from "../../crypto/bytes";
import { encryptVault, type EncryptedVault } from "../../crypto/envelope";
import type { Vk } from "../../crypto/vk";
import type { Generation } from "../../storage/format";
import type { KV } from "../../storage/kv";
import type { Vault } from "../../vault/model";
import { serializeVault } from "../../vault/validate";
import { envelopeText, fitsEnvelopeLimit, padPlaintext } from "../crypto/padding";
import { writeProof } from "../crypto/write-proof";
import { SYNC_KEYS } from "./keys";
import type { MergeOnlyOutbox, Outbox } from "./outbox";
import { lastSyncedOf, stateIfSyncOn } from "./state";

/** The upload envelope for `vault` under `vk` at server revision `rev` (§4.1: padded to 16 KiB buckets) and its text. */
export async function uploadEnvelope(
  vault: Vault,
  vk: Vk,
  o: { vaultId: string; rev: number },
  rng: Random = randomBytes,
): Promise<{ envelope: EncryptedVault; text: string }> {
  const plain = padPlaintext(serializeVault(vault));
  try {
    const envelope = await encryptVault(plain, vk, o, rng);
    return { envelope, text: envelopeText(envelope) };
  } finally {
    plain.fill(0); // the padded plaintext holds every secret
  }
}

/** transact's afterCommit for the outbox (SyncPort.afterCommit). Runs inside the vault lock; its failure is logged by the store. */
export function createOutboxWriter(
  kv: KV,
  rng: Random = randomBytes,
): (c: { gen: Generation; vk: Vk; vault: Vault }) => Promise<void> {
  return async ({ gen, vk, vault }) => {
    const on = await stateIfSyncOn(kv); // one get
    if (!on) return; // sync is off (the callers gate on it too): no outbox of any kind (§4.7)
    const from = lastSyncedOf(on.state);
    if (!from) {
      // a full pull and merge comes first (§4.7); meanwhile the merge-only record, for the recovery hook (rev. 20)
      const text = envelopeText(gen.envelope);
      if (!fitsEnvelopeLimit(text)) return; // too_large: nothing written, what is there stays (§4.7: demote, never drop)
      const mo: MergeOnlyOutbox = { v: 1, from: null, checksum: gen.envelope.checksum, envelope: text };
      await kv.set({ [SYNC_KEYS.outbox]: mo });
      return;
    }
    const vaultId = gen.envelope.vaultId;
    const up = await uploadEnvelope(vault, vk, { vaultId, rev: from.version + 1 }, rng);
    if (!fitsEnvelopeLimit(up.text)) return; // too_large: the upload is paused (§4.3); the outbox there stays (§4.7)
    const proof = await writeProof(vk, { vaultId, ifVersion: from.version, checksum: up.envelope.checksum });
    const ob: Outbox = {
      v: 1,
      base: from.version,
      head: from.head,
      from,
      checksum: gen.envelope.checksum,
      envelope: up.text,
      proof,
    };
    await kv.set({ [SYNC_KEYS.outbox]: ob });
  };
}
