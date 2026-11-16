// sk_sync_state and the outbox as far as the storage layer needs them (SYNC-DESIGN §4.1, §4.7, §4.14; M2). The engine
// (M3) owns the rest of the record; these functions only ever clear lastSynced and the outbox, append the outbox to the
// orphan list (the recovery hook, revisions 19 and 20; the engine's demotion uses the same append), and read the clock
// offset, and they keep every other member of sk_sync_state as it is.
//
// sk_sync_state: { v: 1, lastSynced: { version, head, checksum } | null, lastOkAt, lastAttemptAt, failures, backoffUntil,
//   status, lastErrorCode, serverOffsetMs, useCorrectedTotp, devicesSeenAt, pendingRecoveryWrap?, pendingPins? }: numbers,
//   hashes, checksums, ids and error codes only, never a key or an account name. pendingPins (§0.0i item 17) is pins.ts's.
//   Every writer keeps the members it does not own, and reads and writes the record in one critical section under the
//   vault lock (this module's clear runs inside it: the recovery hook, the key commits).
import type { KV } from "../../storage/kv";
import { SYNC_KEYS } from "./keys";

/** The clock offset is used only within ±7 days (§4.2, F5). */
export const MAX_OFFSET_MS = 7 * 24 * 60 * 60 * 1000;

export type LastSynced = { version: number; head: string; checksum: string };

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** lastSynced as stored, or null (absent, damaged, or cleared). A damaged value reads as null: a full pull, never wrong. */
export function lastSyncedOf(state: unknown): LastSynced | null {
  if (!isObject(state) || !isObject(state.lastSynced)) return null;
  const l = state.lastSynced;
  return Number.isSafeInteger(l.version) && typeof l.head === "string" && typeof l.checksum === "string"
    ? { version: l.version as number, head: l.head, checksum: l.checksum }
    : null;
}

/** The server clock offset, clamped to ±7 days; 0 when absent or not a finite number. */
export function offsetOf(state: unknown): number {
  const o = isObject(state) ? state.serverOffsetMs : undefined;
  return typeof o === "number" && Number.isFinite(o)
    ? Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, Math.round(o)))
    : 0;
}

/** What a local edit needs to know about sync: null when sync is off for this profile. */
export type SyncContext = { offsetMs: number };

/** What clears lastSynced and the outbox, given both as stored: nothing when both are already clear. */
export function clearingItems(r: Record<string, unknown>): Record<string, unknown> {
  const st = r[SYNC_KEYS.state];
  const items: Record<string, unknown> = {};
  if (st !== undefined && (!isObject(st) || st.lastSynced !== null))
    items[SYNC_KEYS.state] = { ...(isObject(st) ? st : { v: 1 }), lastSynced: null };
  if (r[SYNC_KEYS.outbox] !== undefined && r[SYNC_KEYS.outbox] !== null) items[SYNC_KEYS.outbox] = null;
  return items;
}

export class SyncStateStore {
  constructor(private readonly kv: KV) {}

  /**
   * Sync is on for this profile when it has a sync configuration (sk_sync_cfg: written before the first device's init and
   * before an enrollment's complete, §2.5, and deleted by "turn sync off"). One read, of both keys.
   */
  async context(): Promise<SyncContext | null> {
    const r = await this.kv.get([SYNC_KEYS.cfg, SYNC_KEYS.state]);
    return r[SYNC_KEYS.cfg] === undefined ? null : { offsetMs: offsetOf(r[SYNC_KEYS.state]) };
  }

  /**
   * lastSynced to null and the outbox to null, in one write (§3.13 D1: the store's beforeRecoveryWrite; and every flow
   * that must make the next round a full pull and merge: joining, a cloud restore, adopting or publishing new keys). Only
   * what is there is written: with sync off this reads once and writes nothing. A read that throws propagates (the
   * caller's write must not go ahead on a state that may still say "in sync").
   */
  async clearLastSynced(): Promise<void> {
    const items = clearingItems(await this.kv.get([SYNC_KEYS.state, SYNC_KEYS.outbox]));
    if (Object.keys(items).length) await this.kv.set(items);
  }

  /**
   * The store's beforeRecoveryWrite (§4.1 D1, revisions 19 and 20): lastSynced to null and the outbox (pushable or
   * merge-only) APPENDED, unchanged, to sk_sync_orphan's list, in one write and with no crypto. After a recovery the
   * outbox may be the only copy of a save the user was told was made; the engine pushes an entry only while the server is
   * at its (base, head), and folds every entry into the vault in any context holding the key (§4.7). Always appended,
   * never over another entry. The other flows that clear lastSynced (a join, a cloud restore, a key commit:
   * clearingItems) delete a live outbox and never touch the list.
   */
  async recoveryHook(): Promise<void> {
    const r = await this.kv.get([SYNC_KEYS.state, SYNC_KEYS.outbox, SYNC_KEYS.orphan]);
    const items = clearingItems(r);
    const ob = r[SYNC_KEYS.outbox];
    if (isObject(ob)) items[SYNC_KEYS.orphan] = appendOrphan(r[SYNC_KEYS.orphan], ob);
    if (Object.keys(items).length) await this.kv.set(items);
  }
}

/** sk_sync_state as stored, in the same get as the sync configuration: null when sync is off (no sk_sync_cfg). */
export async function stateIfSyncOn(kv: KV): Promise<{ state: unknown } | null> {
  const r = await kv.get([SYNC_KEYS.state, SYNC_KEYS.cfg]);
  return r[SYNC_KEYS.cfg] === undefined ? null : { state: r[SYNC_KEYS.state] };
}

/**
 * What the popup's lock screen says about keys changed elsewhere (SYNC-DESIGN §6 P2), as sk_sync_state has it:
 * "password" (needs_new_password: the master password was changed on another device), "keys" (needs_password: the
 * keys were changed on another device), "pending" (a key change made in this profile's Sync section was sent and not
 * confirmed, §3.6.0: if the page closed before its local commit, the master password set there opens the server's keys,
 * not this device's), or null (sync off, or nothing to say). One read; the popup reads it only after an unlock attempt
 * fails, and only where the release gate lets the sync user interface in.
 */
export async function keysChangedElsewhere(kv: KV): Promise<"password" | "keys" | "pending" | null> {
  const on = await stateIfSyncOn(kv);
  if (!on || !isObject(on.state)) return null;
  if (on.state.keyStatus === "needs_new_password") return "password";
  if (on.state.status === "needs_password") return "keys";
  return isObject(on.state.pendingRecoveryWrap) ? "pending" : null;
}

/** sk_sync_orphan with `ob` appended (revision 20: a list, never overwritten; a value that is not a list is kept as an entry). */
export function appendOrphan(list: unknown, ob: unknown): { v: 1; items: unknown[] } {
  const items =
    isObject(list) && list.v === 1 && Array.isArray(list.items)
      ? list.items
      : list === undefined || list === null
        ? []
        : [list];
  return { v: 1, items: [...items, ob] };
}
