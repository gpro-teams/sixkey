// The outbox (SYNC-DESIGN §4.7, P10, D2; M3) and the upload envelope it shares with the engine's round (§4.1, §4.2 step 6).
//
// The writer is transact's afterCommit for every commit of new data while sync is on (SyncPort.afterCommit: mutate and
// applyRemote call it inside the vault lock, guarded). For the generation just committed it writes one of two records:
//   - lastSynced set: the PUSHABLE outbox. Computed with the key the generation was committed under, it is exactly the
//     PUT /v1/vault the engine would send next: the vault's plaintext padded to 16 KiB buckets and encrypted as a new
//     envelope with rev = lastSynced.version + 1, and its write proof. A context that never holds the key (the service
//     worker in "lock every time" mode, §3.11) can then fast-forward-push it. It records what it was built on: `from`
//     (lastSynced as it was) and `head`: a push goes ahead only while the server is still at exactly that version AND
//     head (a version number reused after a rollback, D5), and lastSynced moves on only while it is still `from` (D2).
//   - lastSynced null (revision 20, R3R-5): the MERGE-ONLY outbox `{v: 1, from: null, checksum, envelope}`: the committed
//     generation's own local envelope text (its local rev, the current key, not re-encrypted or padded), with no base and
//     no proof. Never pushed; it is there so a storage recovery (the hook) keeps it as an orphan entry and a later round
//     with the key folds it. Each one replaces the one before (the newest generation holds every save before it).
//   - Over MAX_ENVELOPE_BYTES nothing is written (§4.3: too_large pauses the upload), and the record already there stays:
//     an outbox the server has not confirmed is never deleted here (revision 20, R3R-1).
// D2: every commit, in every context, goes through the same lock, so the outbox is the newest generation's.
//   - No network, no cleanup, no lock taken: it runs inside the vault lock (store.ts afterCommit; webLock is not re-entrant).
// The writer and the upload envelope live in outbox-writer.ts, which the popup loads (M5 wires the writer into the
// runtime's port; M3 does not, docs/design/notes/M3-NOTES.md); this file, the records' parsers, is the engine's and stays out of the
// popup's module graph (SYNC-DESIGN §7, revision 24). It re-exports both.
//
// sk_sync_orphan (revision 20) is `{v: 1, items: [...]}`: outbox records (pushable or merge-only) a storage recovery or a
// demotion kept, each with an optional `parked` mark the engine writes when it cannot open the entry now (a key this
// keyring does not hold yet, a newer schema, a fold over the entry limit). Parsed here; written only by the recovery
// hook (local/state.ts), the engine's demotion and its retirements (engine/state.ts), and turn-off (sync-local.ts).
import { lastSyncedOf, type LastSynced } from "./state";

export { createOutboxWriter, uploadEnvelope } from "./outbox-writer";

/** sk_sync_outbox: the next upload, as computed at the commit. Hashes, numbers, the envelope text and its proof only. */
export type Outbox = {
  v: 1;
  base: number; // if_version: lastSynced.version at the commit
  head: string; // lastSynced.head at the commit: the server must still hold exactly that text
  from: LastSynced; // lastSynced as it was: the CAS of D2 compares the whole value
  checksum: string; // the committed generation's envelope checksum (lastSynced.checksum once pushed)
  envelope: string; // the upload envelope's text (rev base+1), sent as is
  proof: string; // write_proof over (vaultId, base, the upload envelope's checksum)
};

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export function parseOutbox(x: unknown): Outbox | null {
  if (!isObject(x) || x.v !== 1) return null;
  const from = lastSyncedOf({ lastSynced: x.from });
  if (
    !from ||
    !Number.isSafeInteger(x.base) ||
    typeof x.head !== "string" ||
    typeof x.checksum !== "string" ||
    typeof x.envelope !== "string" ||
    typeof x.proof !== "string"
  )
    return null;
  return {
    v: 1,
    base: x.base as number,
    head: x.head,
    from,
    checksum: x.checksum,
    envelope: x.envelope,
    proof: x.proof,
  };
}

/** The merge-only outbox (revision 20): the committed generation's local envelope, written while lastSynced is null. */
export type MergeOnlyOutbox = { v: 1; from: null; checksum: string; envelope: string };

export function parseMergeOnly(x: unknown): MergeOnlyOutbox | null {
  if (
    !isObject(x) ||
    x.v !== 1 ||
    x.from !== null ||
    typeof x.checksum !== "string" ||
    typeof x.envelope !== "string" ||
    x.proof !== undefined
  )
    return null;
  return { v: 1, from: null, checksum: x.checksum, envelope: x.envelope };
}

/**
 * Why an orphan entry is parked: a key this keyring does not hold, a newer schema, a fold over the entry limit, or
 * another vault than this profile's (revision 24: kept, for instance by a turn-off before a join to another vault, until
 * the user deletes it; it can be opened again only if this profile comes back to that vault and its key).
 */
export type ParkReason = "key" | "schema" | "too_large" | "vault";
export type Parked = { reason: ParkReason; vkId: string | null; at: number };
/**
 * One entry of sk_sync_orphan: the record as the hook or a demotion kept it, and the engine's parked mark. `newer`
 * (M3 revision 5, R4R-5): a record of a newer format (`v` above 1, after a downgrade): never opened, folded or pushed by
 * this build, parked ("schema": update Sixkey), kept by every flow.
 */
export type OrphanItem = {
  record: Outbox | MergeOnlyOutbox | null;
  pushable: Outbox | null;
  parked: Parked | null;
  checksum: string;
  envelope: string;
  newer: boolean;
};

function parseParked(x: unknown): Parked | null {
  if (
    !isObject(x) ||
    (x.reason !== "key" && x.reason !== "schema" && x.reason !== "too_large" && x.reason !== "vault") ||
    typeof x.at !== "number"
  )
    return null;
  return { reason: x.reason, vkId: typeof x.vkId === "string" ? x.vkId : null, at: x.at };
}

export function parseOrphanItem(x: unknown): OrphanItem | null {
  if (isObject(x) && typeof x.v === "number" && x.v > 1) {
    // a newer build's record: kept and parked as such, whatever its shape (§4.7 parks what this build cannot read)
    const tag = typeof x.checksum === "string" ? x.checksum : "";
    return {
      record: null,
      pushable: null,
      parked: { reason: "schema", vkId: null, at: 0 },
      checksum: tag,
      envelope: typeof x.envelope === "string" ? x.envelope : JSON.stringify(x),
      newer: true,
    };
  }
  const pushable = parseOutbox(x);
  const record = pushable ?? parseMergeOnly(x);
  if (!record) return null;
  return {
    record,
    pushable,
    parked: isObject(x) ? parseParked(x.parked) : null,
    checksum: record.checksum,
    envelope: record.envelope,
    newer: false,
  };
}

/**
 * sk_sync_orphan as stored: its entries, and how many of them do not parse (damaged: nothing in them to save). A value
 * that is not a `{v: 1, items}` list is read as a list of that one value (M3 revision 5, R4R-4: the same reading as the
 * hook's append, the CAS and the removals), so a bare record is an entry and anything else one damaged entry. Absent:
 * no entries.
 */
export function parseOrphanList(x: unknown): { items: OrphanItem[]; damaged: number; raw: unknown[] } {
  if (x === undefined || x === null) return { items: [], damaged: 0, raw: [] };
  const raw = isObject(x) && x.v === 1 && Array.isArray(x.items) ? x.items : [x];
  const items: OrphanItem[] = [];
  let damaged = 0;
  for (const it of raw) {
    const p = parseOrphanItem(it);
    if (p) items.push(p);
    else damaged++;
  }
  return { items, damaged, raw };
}

/** The same entry (by its envelope text and checksum: a parked mark does not make it another one). */
export const sameEntry = (
  a: { checksum: string; envelope: string },
  b: { checksum: string; envelope: string },
): boolean => a.checksum === b.checksum && a.envelope === b.envelope;
