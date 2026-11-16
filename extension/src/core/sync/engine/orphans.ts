// The orphan list's fold, and what the settings page needs of it with sync off (SYNC-DESIGN §4.7, revision 20).
//
// An orphan entry is a record of this device's own earlier state: an outbox (pushable or merge-only) that a storage
// recovery or a demotion kept. With the key in this context (the service worker unlocked, the settings page; never the
// popup) every entry is opened (the current VK, or a VK the local keyring lists as previous, the vault id checked):
//   - one whose checksum is the active generation's is retired at once (retirement 3: the recovery lost nothing);
//   - one that does not open (checksum, AEAD) is removed: nothing to save;
//   - one under a key this keyring cannot open now, of a newer schema, whose fold would pass the entry limit, or of
//     another vault than this profile's (revision 24: kept by a turn-off, then a join to another vault; its key not being
//     in the new vault's chain says nothing about whether it is gone) is PARKED (R3R-4): marked, kept, retried by every
//     later fold, and it no longer holds sync up. Only the user deletes a parked entry ("Advanced" in the Sync section),
//     except one of this very vault whose key is provably gone (the round's rule, engine.ts);
//   - the others are merged, all at once, by M2's applyRemote as one more remote (the clamp, the guard, one commit). A
//     guard block keeps every entry (MergeBlocked: the answer binds to the digests the user saw).
// Folding does not retire an entry (only the push's 200, the round's lastSynced write, or the checksum do), except with
// sync off, where the vault is the only place left (foldParkedLocally). No network here.
import { unwrapPreviousVks } from "../../crypto/keyring";
import type { Vk } from "../../crypto/vk";
import { ServiceError } from "../../service/service-error";
import { MergeBlocked, type CurrentVault, type MergeAnswer, type SyncFlows } from "../../service/sync-flows";
import type { KV, Lock } from "../../storage/kv";
import { mergeVaults } from "../../vault/merge";
import { LIMITS } from "../../vault/validate";
import { clampVault } from "../../vault/ops";
import type { Vault } from "../../vault/model";
import type { GuardReport } from "../local/guard";
import type { OrphanItem, Parked, ParkReason } from "../local/outbox";
import { openRemote } from "./remote";
import { EngineStateStore, unparked } from "./state";

export type FoldOutcome =
  | { kind: "blocked"; report: GuardReport; seen: Readonly<Record<string, string>> }
  | { kind: "locked" }
  | { kind: "done"; folded: OrphanItem[]; parked: { item: OrphanItem; parked: Parked }[] };

/** `refNow`: the clamp's reference (§4.14: the server-corrected time with sync on; the local clock with sync off). */
type FoldDeps = {
  flows: Pick<SyncFlows, "applyRemote">;
  state: EngineStateStore;
  now: () => number;
  refNow: () => number;
  diag: (m: string) => void;
};

const isLocked = (e: unknown): boolean => e instanceof ServiceError && e.code === "locked";

/** The fold of `items` into `cur` (see the top of this file). Writes the parked marks and the removals itself. */
export async function foldOrphans(
  d: FoldDeps,
  cur: CurrentVault,
  items: readonly OrphanItem[],
  answer?: MergeAnswer,
): Promise<FoldOutcome> {
  const vaultId = cur.gen.keyring.vaultId;
  const gone: OrphanItem[] = [];
  const parked: { item: OrphanItem; parked: Parked }[] = [];
  const open: { item: OrphanItem; vault: Vault }[] = [];
  let previous: Vk[] | null = null;
  const park = (item: OrphanItem, reason: ParkReason, vkId: string | null = null) =>
    parked.push({ item, parked: { reason, vkId, at: d.now() } });
  for (const item of items) {
    if (item.newer) continue; // a newer build's record (R4R-5): parked as it is, never opened here
    if (item.checksum === cur.gen.envelope.checksum) {
      gone.push(item); // retirement 3
      continue;
    }
    let opened = await openRemote(item.envelope, cur.vk, vaultId);
    if (opened.kind === "other_key") {
      const want = opened.vkId;
      previous ??= await unwrapPreviousVks(cur.gen.keyring, cur.vk);
      const prev = previous.find((v) => v.id === want);
      if (!prev) {
        park(item, "key", want); // FIXa2: a newer key this keyring does not hold yet, until an adoption brings it
        continue;
      }
      opened = await openRemote(item.envelope, prev, vaultId);
    }
    if (opened.kind === "wrong_vault") {
      park(item, "vault"); // revision 24: never removed by itself, a join to another vault included
      continue;
    }
    if (opened.kind === "unreadable") {
      d.diag("damaged orphan removed");
      gone.push(item);
      continue;
    }
    if (opened.kind === "newer_schema")
      park(item, "schema"); // kept for a newer build (after a downgrade)
    else if (opened.kind === "ok") open.push({ item, vault: opened.vault });
    else park(item, "key"); // other_key under a previous key that still did not open it
  }
  if (gone.length) await d.state.removeOrphans(gone);
  let folded: OrphanItem[] = [];
  if (open.length) {
    // §4.7: merge(clamp(local), clamp(entry₁), …): each entry clamped on its own before they are combined (applyRemote
    // clamps the local side and, again, the combination: idempotent on clamped stamps)
    const now = d.refNow();
    const combined = open.map((x) => clampVault(x.vault, now)).reduce((a, b) => mergeVaults(a, b));
    try {
      // entries that each fit can pass the entry limit together (M3 revision 5, R4R-14): the same as a fold over the
      // limit (parked, too_large), never the parse error applyRemote's check of its remote would throw
      if (combined.entries.length > LIMITS.parsedEntries) throw new ServiceError("too_large");
      await d.flows.applyRemote(combined, answer);
      folded = open.map((x) => x.item);
    } catch (e) {
      if (e instanceof MergeBlocked) {
        await writeMarks(d, parked, []);
        return { kind: "blocked", report: e.report, seen: e.seen };
      }
      if (e instanceof ServiceError && e.code === "too_large") for (const x of open) park(x.item, "too_large");
      else if (isLocked(e)) {
        await writeMarks(d, parked, []);
        return { kind: "locked" };
      } else throw e;
    }
  }
  await writeMarks(d, parked, folded);
  return { kind: "done", folded, parked };
}

/** The parked marks: set on the entries parked now (if new or changed), cleared on the ones folded now. */
async function writeMarks(
  d: FoldDeps,
  parked: readonly { item: OrphanItem; parked: Parked }[],
  folded: readonly OrphanItem[],
): Promise<void> {
  const marks = [
    ...parked
      .filter((p) => p.item.parked?.reason !== p.parked.reason || p.item.parked?.vkId !== p.parked.vkId)
      .map((p) => ({ entry: p.item, parked: p.parked })),
    ...folded.filter((f) => f.parked !== null).map((f) => ({ entry: f, parked: null })),
  ];
  await d.state.markOrphans(marks);
}

/**
 * What the UI shows about parked entries (§6 O12, M6): how many, and why (the way out: update Sixkey, unlock with the
 * newer password, make room; for another vault's, only the user's delete).
 */
export type ParkedSummary = { count: number; reasons: ParkReason[]; checksums: string[] };

export function parkedSummary(items: readonly OrphanItem[]): ParkedSummary | null {
  const parked = items.filter((i) => i.parked !== null);
  if (!parked.length) return null;
  return {
    count: parked.length,
    reasons: [...new Set(parked.map((i) => i.parked!.reason))].sort(),
    checksums: parked.map((i) => i.checksum),
  };
}

/** The parked entries as stored, with sync on or off (the settings page's notice, §4.7: "the security page" once sync is off). */
export async function readParkedOrphans(kv: KV, vaultLock: Lock): Promise<ParkedSummary | null> {
  return parkedSummary((await new EngineStateStore(kv, vaultLock).read()).orphans);
}

/**
 * With sync off, every unlock of the settings page (the key in hand) retries the local fold of the parked entries kept
 * by turning sync off (§4.7, R3R-2). No engine, no network. A folded entry is removed (the vault is the only place left
 * for it: there is no round to retire it), a parked one stays. A guard block throws MergeBlocked (the page shows the
 * review and calls again with the answer). "locked" when the vault is locked; "vault_lost" when there is none readable.
 */
export async function foldParkedLocally(
  o: {
    flows: Pick<SyncFlows, "applyRemote" | "current">;
    kv: KV;
    vaultLock: Lock;
    now: () => number;
    diag?: (m: string) => void;
  },
  answer?: MergeAnswer,
): Promise<{ folded: number; parked: number } | "locked" | "vault_lost" | "sync_on"> {
  const state = new EngineStateStore(o.kv, o.vaultLock);
  const view = await state.read();
  // with sync on the round folds and retires (the three retirements of §4.7): this fold's own removal would be a fourth
  // (M3 revision 5, R4R-7)
  if (view.syncOn) return "sync_on";
  if (view.orphanDamaged) await state.removeOrphans([], { damaged: true });
  if (!view.orphans.length) return { folded: 0, parked: 0 };
  let cur: CurrentVault;
  try {
    cur = await o.flows.current();
  } catch (e) {
    if (isLocked(e)) return "locked";
    if (e instanceof ServiceError) return "vault_lost";
    throw e;
  }
  const f = await foldOrphans(
    { flows: o.flows, state, now: o.now, refNow: o.now, diag: o.diag ?? (() => undefined) },
    cur,
    view.orphans,
    answer,
  );
  if (f.kind === "blocked") throw new MergeBlocked(f.report, f.seen);
  if (f.kind === "locked") return "locked";
  if (f.folded.length) await state.removeOrphans(f.folded);
  return { folded: f.folded.length, parked: f.parked.length };
}

/**
 * "Advanced" (§6 O12, R3R-4): delete the parked entries after the user confirmed exactly what was shown: `confirm` is
 * the `count` and the `checksums` of the `parkedSummary` the user confirmed (both required, M3 revision 6, R5R-3), and
 * they must still describe the parked entries, checked in the same critical section as the delete (M3 revision 5,
 * R4R-8): a list that changed meanwhile deletes nothing (`bad_state`: show it again). Never an unparked entry. Returns
 * how many were deleted.
 */
export async function discardParkedOrphans(
  o: { kv: KV; vaultLock: Lock },
  confirm: { count: number; checksums: readonly string[] },
): Promise<number> {
  const n = await new EngineStateStore(o.kv, o.vaultLock).discardParked(confirm);
  if (n === null) throw new ServiceError("bad_state", "the parked entries changed: show them again");
  return n;
}

export { unparked };
