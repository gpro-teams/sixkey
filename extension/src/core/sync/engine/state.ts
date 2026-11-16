// The engine's one writer of sk_sync_state, sk_sync_outbox and sk_sync_cfg.cursor (SYNC-DESIGN §4.1, §4.7, §4.10; M2-NOTES
// §4.2 item 3, §7 item 6). Every write is a read-modify-write in ONE critical section under the vault lock
// (webLock("sixkey-vault")), and keeps every member it does not own: pendingPins (pins.ts), useCorrectedTotp (the UI's,
// §4.14), anything a newer version added. Nothing in here touches the network or a key, and nothing in here is ever
// called while the vault lock is held (it is not re-entrant): the engine calls these between its steps.
//   - lastSynced moves only by compare-and-set (casLastSynced, pushed): the active generation must still be the one the
//     round uploaded or found in sync (its envelope checksum), and lastSynced must still be what the round read when it
//     began. A recovery in between clears lastSynced (D1) or changes the active generation; either makes the CAS fail,
//     so an older local state is never marked "in sync" and then uploaded without a merge.
//   - the cursor in sk_sync_cfg (clone detection, §4.10) is written here too, under the same lock, keeping `enc`: the
//     cleanup's VkRecord rewrites that record under this lock (A4R-4), and an unlocked write could put an old `enc` back.
// The record holds numbers, hashes, checksums, ids and error codes only: never a key, a code or an account name.
import { sha256, toB64, utf8, type Random } from "../../crypto/bytes";
import { canonicalJson } from "../../vault/merge";
import { checkGeneration, KEYS } from "../../storage/format";
import type { KV, Lock } from "../../storage/kv";
import { SYNC_KEYS } from "../local/keys";
import {
  parseMergeOnly,
  parseOrphanItem,
  parseOrphanList,
  parseOutbox,
  sameEntry,
  type MergeOnlyOutbox,
  type OrphanItem,
  type Outbox,
  type Parked,
} from "../local/outbox";
import { parseSyncCfg } from "../local/records";
import { appendOrphan, lastSyncedOf, offsetOf, type LastSynced } from "../local/state";

/** What the sync panel shows (§6 O12). One of these at a time; key-state problems are `keyStatus`, notices are separate. */
export type SyncStatus =
  | "off"
  | "ok"
  | "offline"
  | "locked"
  | "error"
  | "busy"
  | "needs_password" // R4 / D8's second direction: the server rotated, or the pin is ahead of the local keyring
  | "review_needed" // §4.4: the guard stopped a merge
  | "remote_unreadable" // §4.3 F6a: no history version opens
  | "server_older_key" // §4.2 step 2: the server is back on a key in this device's previous list
  | "update_required" // §5.2 d6
  | "too_large" // §4.3 C5, D7
  | "paused_newer" // §4.3, R6: a newer schema; never skipped
  | "different_vault" // §3.5
  | "rejected_by_server" // §3.10 P5
  | "join_unfinished" // §3.5: the local half is written, complete is not confirmed
  | "identity_missing" // §2.5, locked: "unlock to restore sync"
  | "cloud_restore" // §2.5 cfg_missing with the local vault lost: §4.13
  | "damaged" // §2.5: a damaged identity or configuration
  | "wrong_origin" // the identity was made for another API origin (§2.5 apiOrigin)
  | "permission_removed"; // §4.9 (revision 21): the API host permission is not granted; nothing is sent, nothing else changes

/** The key state as the last round judged it (§3.9): "ok" or why no adoption happened. */
export type KeyStatus = "ok" | "needs_new_password" | "keys_behind" | "rejected" | "update_required";

/** One-time banners for M6 (§6 P4, O12): kinds and small numbers only. */
export type NoticeKind =
  | "rollback" // A5: the server's version went back (one-time)
  | "keys_adopted" // §3.9 R1 / RR-6: keys this device committed before were adopted back (a visible event)
  | "keys_changed" // another device changed the keys and this one adopted them
  | "forked" // §4.10: another copy of this identity wrote
  | "device_joined"
  | "device_revoked"
  | "auth_failures" // §3.10, §3.14 S2 (from GET /v1/devices)
  | "deleted_remotely" // §4.4: a merge moved 3 or more to the trash or erased 3 or more from it; `danger` per D6
  | "recovery_in_effect"
  | "recovery_not_in_effect" // §3.6.0
  | "rev_mismatch" // §4.3: the authenticated rev differs from the server's version (merged anyway)
  | "orphan_unreadable" // §4.7 (rev. 19, 20): an orphan entry under a key this device's chain provably no longer holds was removed
  | "duplicates_trashed" // §3.5 (rev. 24): an approval join's accounts the synced vault already had, moved to the trash
  | "clock_skew"; // §4.14 S3: more than 15 s off
export type Notice = { kind: NoticeKind; at: number; n?: number; danger?: boolean };
const MAX_NOTICES = 20;

/** The members the engine owns (and only it writes, through this file). */
export type EngineState = {
  status?: SyncStatus;
  keyStatus?: KeyStatus;
  lastErrorCode?: string | null;
  lastOkAt?: number | null;
  lastAttemptAt?: number | null;
  rejectedCheckedAt?: number | null; // §3.10 P5: the last status query sent for a rejected identity (its daily retry)
  pendingEnrollments?: number; // §3.11, §4.9: unexpired pending approval requests, for the badge (written on change)
  enrollSentAt?: number | null; // M3RR-7: refNow when a pending identity last sent its init or complete (it may still land)
  failures?: number;
  backoffUntil?: number | null;
  serverOffsetMs?: number;
  devicesRev?: number | null;
  keysSeen?: { kver: number; vkId: string; local: string } | null; // the bundle last judged, with the local keyring's digest
  devices?: { id: string; revoked: boolean; warn: boolean }[]; // the device list last seen (ids and flags only), for the banners
  kickAt?: number | null; // the newest "sync soon" (§4.8), persisted so a restarted worker still runs it
  dirtySince?: number | null;
  /**
   * §3.6.0: an unconfirmed new recovery code: its wrap's fingerprint, when and at which kver it was sent, and the server
   * bundle it was built on (kver and MAC), so "not in effect" can be said once no signature of it can land any more.
   */
  pendingRecoveryWrap?: { fp: string; at: number; kver: number; baseKver?: number; baseMac?: string } | null;
  notices?: Notice[];
  /**
   * A head this device cannot take in (too_large, paused_newer, remote_unreadable, different_vault), with the local
   * generation and the client version it was judged with: not pulled and judged again every round (D7) until one of the
   * three changes.
   */
  stuck?: { head: string; version: number; checksum: string; status: SyncStatus; client: string } | null;
  /**
   * §3.10 "lost, stolen or not sure" is revoke, then rotate: written before the first revocation of such a run, cleared
   * only once the server accepted a rotation (commitRotation). While it names the key this device holds (`vkId`), the
   * Sync section says the keys still need rotating (a device revoked as lost may have kept a recovery code it planted,
   * and still opens what it saw); a rotation adopted from another device makes it moot only when it came after the
   * revocation (`after`), since the device could have fetched one from before.
   */
  rotationOwed?: {
    at: number;
    vkId: string;
    /** The devices the run was about to revoke. */
    targets?: string[];
    /** A revocation of the run is known to have gone through (until then the card cannot say a device was revoked). */
    revoked?: boolean;
    /** The server's keys just after the last revocation (a rotation with a higher kver came after it). */
    after?: { vkId: string; kver: number } | null;
    /** Why the rotation could not be prepared, when the run revoked without it (a failure code). */
    waits?: string | null;
  } | null;
  /**
   * §3.5 (revision 24): an approval join's record for its dedupe (pins.ts JoinAdded: the vault, the ids it added). Written
   * by the join itself, in its commit's first write (PinsLedger.begin, the one other writer of this member); cleared here
   * once the first round that went through has moved the duplicates to the trash (settleJoinAdded).
   */
  joinAdded?: { vaultId: string; ids: string[]; at: number } | null;
};
const OWNED = [
  "status",
  "keyStatus",
  "lastErrorCode",
  "lastOkAt",
  "lastAttemptAt",
  "rejectedCheckedAt",
  "pendingEnrollments",
  "enrollSentAt",
  "failures",
  "backoffUntil",
  "serverOffsetMs",
  "devicesRev",
  "devices",
  "keysSeen",
  "kickAt",
  "dirtySince",
  "pendingRecoveryWrap",
  "notices",
  "stuck",
  "rotationOwed",
  "joinAdded",
] as const;

/**
 * §3.10, §4.2: the revocations a restore of the server undid. `stored` is the device list this device keeps
 * (`devices`), in which a revocation is sticky: revokeDevice marks the device it revoked, every refresh marks what the
 * server says is revoked, and nothing marks a device active again (a revocation is final for a device id; only a restore
 * of the server's database undoes it). `server` is the server's list now. The ids the server lists as active that this
 * device has seen revoked, never this device's own.
 */
export function undoneRevocations(
  stored: EngineState["devices"],
  server: readonly { id: string; revoked: boolean }[],
  self: string,
): string[] {
  const seen = new Set((stored ?? []).filter((d) => d.revoked).map((d) => d.id));
  return server.filter((d) => seen.has(d.id) && !d.revoked && d.id !== self).map((d) => d.id);
}

/** sk_sync_state.joinAdded as stored, or null when it does not parse (§3.5's dedupe: the vault id and the ids it added). */
export function joinAddedOf(x: unknown): { vaultId: string; ids: string[]; at: number } | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.vaultId !== "string" || !Array.isArray(o.ids) || !o.ids.every((i) => typeof i === "string")) return null;
  return { vaultId: o.vaultId, ids: o.ids as string[], at: typeof o.at === "number" ? o.at : 0 };
}

/** What the engine reads in one get: the state, the outbox, the orphan list (§4.7, rev. 20) and the cursor. */
export type StateView = {
  syncOn: boolean;
  state: EngineState;
  lastSynced: LastSynced | null;
  /** the pushable outbox (lastSynced set at its commit); `mergeOnly` the record written while lastSynced is null (R3R-5) */
  outbox: Outbox | null;
  mergeOnly: MergeOnlyOutbox | null;
  /** sk_sync_orphan's entries (D1, rev. 19, 20); `orphanDamaged`: how many do not parse (nothing in them to save) */
  orphans: OrphanItem[];
  orphanDamaged: number;
  cursor: { cur?: string; pending?: string } | null;
  offsetMs: number;
  useCorrectedTotp: boolean;
};

/** The entries that count for the invariant and the "fold first" checks: every one not parked (§4.7, R3R-4). */
export const unparked = (items: readonly OrphanItem[]): OrphanItem[] => items.filter((i) => i.parked === null);
const listOf = (raw: unknown): unknown[] =>
  isObject(raw) && raw.v === 1 && Array.isArray(raw.items) ? raw.items : raw === undefined || raw === null ? [] : [raw];
const listValue = (items: unknown[]): { v: 1; items: unknown[] } | null => (items.length ? { v: 1, items } : null);

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const sameLs = (a: LastSynced | null, b: LastSynced | null) =>
  a === null || b === null ? a === b : a.version === b.version && a.head === b.head && a.checksum === b.checksum;

function parseState(st: unknown): EngineState {
  if (!isObject(st)) return {};
  const out: EngineState = {};
  for (const k of OWNED) if (st[k] !== undefined) (out as Record<string, unknown>)[k] = st[k];
  if (!Array.isArray(out.notices)) delete out.notices;
  if (!Number.isSafeInteger(out.failures)) delete out.failures;
  return out;
}

const sameRecord = (a: Outbox | null, b: Outbox): boolean =>
  a !== null && a.base === b.base && a.checksum === b.checksum && a.envelope === b.envelope;

/** SHA-256 of an envelope text, standard base64: the server's head (§4.1, D5). */
export async function headOf(text: string): Promise<string> {
  return toB64(await sha256(utf8(text)));
}

export class EngineStateStore {
  constructor(
    private readonly kv: KV,
    private readonly vaultLock: Lock,
  ) {}

  /** One read of the three keys (no lock: a snapshot for decisions; every write re-reads under the lock). */
  async read(): Promise<StateView> {
    const r = await this.kv.get([SYNC_KEYS.state, SYNC_KEYS.outbox, SYNC_KEYS.cfg, SYNC_KEYS.orphan]);
    const st = r[SYNC_KEYS.state];
    const cfg = parseSyncCfg(r[SYNC_KEYS.cfg]);
    const orphans = parseOrphanList(r[SYNC_KEYS.orphan]);
    return {
      syncOn: r[SYNC_KEYS.cfg] !== undefined,
      state: parseState(st),
      lastSynced: lastSyncedOf(st),
      outbox: parseOutbox(r[SYNC_KEYS.outbox]),
      mergeOnly: parseMergeOnly(r[SYNC_KEYS.outbox]),
      orphans: orphans.items,
      orphanDamaged: orphans.damaged,
      cursor: cfg && cfg !== "damaged" ? (cfg.cursor ?? null) : null,
      offsetMs: offsetOf(st),
      useCorrectedTotp: isObject(st) && st.useCorrectedTotp === true,
    };
  }

  /**
   * Engine-owned members changed by `fn` (given the members as stored now), under the vault lock; the rest of the record
   * kept as stored. Nothing is written when nothing changes, or when sync was turned off meanwhile (no sk_sync_cfg: the
   * engine must not bring sk_sync_state back after "turn sync off", D11).
   */
  async update(fn: (cur: EngineState) => EngineState | null): Promise<EngineState> {
    return this.vaultLock(async () => {
      const r = await this.kv.get([SYNC_KEYS.state, SYNC_KEYS.cfg]);
      const raw = isObject(r[SYNC_KEYS.state]) ? (r[SYNC_KEYS.state] as Record<string, unknown>) : null;
      const cur = parseState(raw);
      const patch = fn(cur);
      if (!patch || r[SYNC_KEYS.cfg] === undefined) return cur;
      const next: Record<string, unknown> = { ...(raw ?? { v: 1, lastSynced: null }) };
      let changed = raw === null;
      for (const [k, v] of Object.entries(patch)) {
        if (!(OWNED as readonly string[]).includes(k)) continue;
        if (canonicalJson(next[k] ?? null) !== canonicalJson(v ?? null)) changed = true;
        next[k] = v;
      }
      if (changed) await this.kv.set({ [SYNC_KEYS.state]: next });
      return parseState(next);
    });
  }

  /** A notice appended (deduplicated by kind within the list's lifetime of `at`), under the lock. */
  async notice(n: Notice): Promise<void> {
    await this.update((cur) => {
      const list = (cur.notices ?? []).filter((x) => !(x.kind === n.kind && x.at === n.at));
      return { notices: [...list, n].slice(-MAX_NOTICES) };
    });
  }

  /**
   * §3.10: a device this device revoked (the server said 200), marked so in the stored list at once, whatever a refresh
   * said before (undoneRevocations: the repair after a restore revokes again what the restore undid).
   */
  async rememberRevoked(deviceId: string): Promise<void> {
    await this.update((st) => {
      const list = st.devices ?? [];
      const known = list.some((d) => d.id === deviceId);
      if (known && list.every((d) => d.id !== deviceId || d.revoked)) return null;
      return {
        devices: known
          ? list.map((d) => (d.id === deviceId ? { ...d, revoked: true } : d))
          : [...list, { id: deviceId, revoked: true, warn: false }],
      };
    });
  }

  /**
   * §3.5 (revision 24): the approval join's dedupe ran: its record cleared and, when it moved accounts (`n` > 0), the one
   * notice that says so, in one write.
   */
  async settleJoinAdded(n: Notice | null): Promise<void> {
    await this.update((cur) => {
      const list = (cur.notices ?? []).filter((x) => !(n && x.kind === n.kind && x.at === n.at));
      return { joinAdded: null, ...(n ? { notices: [...list, n].slice(-MAX_NOTICES) } : {}) };
    });
  }

  /**
   * The user has seen these notices (§6 P4, O12: the settings page's "Got it"): exactly the entries shown, by kind and
   * time, are removed, under the lock; a notice that arrived after the page drew them stays. Nothing else changes.
   */
  async dismissNotices(shown: readonly { kind: NoticeKind; at: number }[]): Promise<void> {
    if (!shown.length) return;
    await this.update((cur) => {
      const list = cur.notices ?? [];
      const left = list.filter((x) => !shown.some((s) => s.kind === x.kind && s.at === x.at));
      return left.length === list.length ? null : { notices: left };
    });
  }

  /**
   * lastSynced := next, only if the active generation's envelope checksum is still `checksum` and lastSynced is still
   * `expect` (§4.1, D1). The stale outbox is removed in the same write (§4.7: a full round's success clears it: a pushable
   * one built on a version the server has moved past, and the merge-only one, whose generation the round's holds).
   * §4.7 (rev. 20): the orphan entries this round folded (`retire`) go in the same write (retirement 2), the damaged ones
   * with them; parked entries stay. Never while an unparked entry this round did not fold remains: "an unparked entry ⇒
   * lastSynced null" holds by mechanism, and a recovery in between (which appends one) makes the CAS fail.
   */
  async casLastSynced(
    expect: LastSynced | null,
    next: LastSynced,
    checksum: string,
    retire: readonly { checksum: string; envelope: string }[] = [],
  ): Promise<boolean> {
    return this.vaultLock(async () => {
      const r = await this.kv.get([SYNC_KEYS.state, SYNC_KEYS.outbox, SYNC_KEYS.cfg, KEYS.active, SYNC_KEYS.orphan]);
      if (r[SYNC_KEYS.cfg] === undefined) return false;
      if (!sameLs(lastSyncedOf(r[SYNC_KEYS.state]), expect)) return false;
      if ((await this.activeChecksum(r[KEYS.active])) !== checksum) return false;
      const raw = listOf(r[SYNC_KEYS.orphan]);
      const keep: unknown[] = [];
      for (const it of raw) {
        const p = parseOrphanItem(it);
        if (!p) continue; // damaged: nothing in it to save
        if (retire.some((x) => sameEntry(x, p))) continue; // retirement 2
        if (p.parked === null) return false; // an unparked entry this round did not fold
        keep.push(it);
      }
      const st = r[SYNC_KEYS.state];
      const items: Record<string, unknown> = {
        [SYNC_KEYS.state]: { ...(isObject(st) ? st : { v: 1 }), lastSynced: next },
      };
      const ob = parseOutbox(r[SYNC_KEYS.outbox]);
      if ((ob && ob.base < next.version) || parseMergeOnly(r[SYNC_KEYS.outbox])) items[SYNC_KEYS.outbox] = null;
      if (keep.length !== raw.length) items[SYNC_KEYS.orphan] = listValue(keep);
      await this.kv.set(items);
      return true;
    });
  }

  /**
   * The outbox `ob` reached the server as version ob.base + 1 (D2): lastSynced moves on only while it is still ob.from
   * (a recovery in between cleared it), to {base+1, head of the outbox text, the committed generation's checksum}; and the
   * outbox is removed if it is still this one. True if lastSynced moved.
   */
  async pushed(ob: Outbox): Promise<boolean> {
    const head = await headOf(ob.envelope);
    return this.vaultLock(async () => {
      const r = await this.kv.get([SYNC_KEYS.state, SYNC_KEYS.outbox, SYNC_KEYS.cfg]);
      if (r[SYNC_KEYS.cfg] === undefined) return false;
      const items: Record<string, unknown> = {};
      const moved = sameLs(lastSyncedOf(r[SYNC_KEYS.state]), ob.from);
      const st = r[SYNC_KEYS.state];
      if (moved)
        items[SYNC_KEYS.state] = {
          ...(isObject(st) ? st : { v: 1 }),
          lastSynced: { version: ob.base + 1, head, checksum: ob.checksum },
        };
      const now = parseOutbox(r[SYNC_KEYS.outbox]);
      if (now && now.base === ob.base && now.checksum === ob.checksum && now.envelope === ob.envelope)
        items[SYNC_KEYS.outbox] = null;
      if (Object.keys(items).length) await this.kv.set(items);
      return moved;
    });
  }

  /**
   * §4.7 (rev. 20): the orphan entries removed that are `entries` (retirement 1, a push answered 200; 3, the active
   * generation is the one an entry was written for; an entry of another vault, or one whose key is provably gone), and
   * with `damaged` every entry that does not parse. Under the vault lock; the key is deleted when no entry is left.
   */
  async removeOrphans(
    entries: readonly { checksum: string; envelope: string }[],
    o: { damaged?: boolean } = {},
  ): Promise<void> {
    await this.editOrphans((raw) =>
      raw.filter((it) => {
        const p = parseOrphanItem(it);
        if (!p) return !o.damaged;
        return !entries.some((x) => sameEntry(x, p));
      }),
    );
  }

  /** The parked marks of `marks` set (a reason) or cleared (null), entry by entry (§4.7 R3R-4: written by the fold). */
  async markOrphans(
    marks: readonly { entry: { checksum: string; envelope: string }; parked: Parked | null }[],
  ): Promise<void> {
    if (!marks.length) return;
    await this.editOrphans((raw) =>
      raw.map((it) => {
        const p = parseOrphanItem(it);
        const m = p ? marks.find((x) => sameEntry(x.entry, p)) : undefined;
        if (!m || !isObject(it)) return it;
        const { parked: _old, ...rest } = it;
        void _old;
        return m.parked ? { ...rest, parked: m.parked } : rest;
      }),
    );
  }

  /**
   * "Advanced" (R4R-8; M3 revision 6, R5R-3): the parked entries deleted only if they are still exactly the entries with
   * `confirm.checksums`, in that order (required: a count alone could match a set the user never saw), and
   * `confirm.count` of them, read and written in ONE critical section under the vault lock; never an entry without a
   * parked mark. The count deleted, or null when the list no longer matches or the checksums are missing (nothing
   * written).
   */
  async discardParked(confirm: { count: number; checksums: readonly string[] }): Promise<number | null> {
    return this.vaultLock(async () => {
      const before = (await this.kv.get([SYNC_KEYS.orphan]))[SYNC_KEYS.orphan];
      const raw = listOf(before);
      const isParked = (it: unknown) => parseOrphanItem(it)?.parked != null;
      const parked = raw.filter(isParked).map((it) => parseOrphanItem(it)!);
      const shown = confirm.checksums as unknown;
      const same =
        Array.isArray(shown) &&
        parked.length === confirm.count &&
        shown.length === parked.length &&
        parked.every((p, i) => p.checksum === shown[i]);
      if (!parked.length || !same) return null;
      // and a compare-and-set: every writer of the list holds this lock, so it cannot change here; read again anyway
      // before deleting (a delete is never undone)
      if (
        canonicalJson((await this.kv.get([SYNC_KEYS.orphan]))[SYNC_KEYS.orphan] ?? null) !==
        canonicalJson(before ?? null)
      )
        return null;
      await this.kv.set({ [SYNC_KEYS.orphan]: listValue(raw.filter((it) => !isParked(it))) });
      return parked.length;
    });
  }

  /** sk_sync_orphan's raw entries changed by `fn`, under the vault lock (nothing written when nothing changes). */
  private async editOrphans(fn: (raw: unknown[]) => unknown[]): Promise<void> {
    await this.vaultLock(async () => {
      const cur = (await this.kv.get([SYNC_KEYS.orphan]))[SYNC_KEYS.orphan];
      const raw = listOf(cur);
      const next = fn(raw);
      if (canonicalJson(next) === canonicalJson(raw)) return;
      await this.kv.set({ [SYNC_KEYS.orphan]: listValue(next) });
    });
  }

  /**
   * §4.7 (rev. 20, R3R-1): demote, never drop. A pushable outbox the locked path cannot send (409, write_denied with the
   * key moved, the server not at its (base, head)) is appended to the orphan list, and the outbox and lastSynced cleared,
   * in ONE write under the vault lock: the recovery hook's own write. Only while the outbox is still `ob`. Always
   * appended, never over another entry; from then on the orphan rules apply (a keyed round folds it, its CAS retires it).
   */
  async demoteOutbox(ob: Outbox): Promise<void> {
    await this.vaultLock(async () => {
      const r = await this.kv.get([SYNC_KEYS.outbox, SYNC_KEYS.orphan, SYNC_KEYS.state]);
      if (!sameRecord(parseOutbox(r[SYNC_KEYS.outbox]), ob)) return;
      const st = r[SYNC_KEYS.state];
      await this.kv.set({
        [SYNC_KEYS.outbox]: null,
        [SYNC_KEYS.orphan]: appendOrphan(r[SYNC_KEYS.orphan], r[SYNC_KEYS.outbox]),
        ...(st !== undefined ? { [SYNC_KEYS.state]: { ...(isObject(st) ? st : { v: 1 }), lastSynced: null } } : {}),
      });
    });
  }

  /**
   * The outbox removed if it is still `ob`. Only where §4.7 (rev. 20) allows deleting an unconfirmed outbox: a full round
   * with nothing to upload (the vault it merged holds the outbox's content). Everywhere else: demoteOutbox.
   */
  async dropOutbox(ob: Outbox): Promise<void> {
    await this.vaultLock(async () => {
      if (sameRecord(parseOutbox((await this.kv.get([SYNC_KEYS.outbox]))[SYNC_KEYS.outbox]), ob))
        await this.kv.set({ [SYNC_KEYS.outbox]: null });
    });
  }

  /**
   * §4.10: the cursor for the next PUT. With no pending value one is made and written first (before the request, so a
   * response that is lost is not mistaken for a clone the next time). Under the vault lock, keeping the rest of sk_sync_cfg.
   * Null when there is no configuration (sync turned off meanwhile).
   */
  async cursorForPut(rng: Random): Promise<{ cur?: string; pending: string } | null> {
    return this.vaultLock(async () => {
      const raw = (await this.kv.get([SYNC_KEYS.cfg]))[SYNC_KEYS.cfg];
      const cfg = parseSyncCfg(raw);
      if (!cfg || cfg === "damaged") return null;
      const c = cfg.cursor;
      if (c?.pending) return { ...(c.cur ? { cur: c.cur } : {}), pending: c.pending };
      const pending = toB64(rng(16));
      await this.kv.set({
        [SYNC_KEYS.cfg]: {
          ...(raw as Record<string, unknown>),
          cursor: { ...(c?.cur ? { cur: c.cur } : {}), pending },
        },
      });
      return { ...(c?.cur ? { cur: c.cur } : {}), pending };
    });
  }

  /** After a 200: cur := the pending value that was sent (§4.10), if it is still the pending one. */
  async cursorAccepted(pending: string): Promise<void> {
    await this.vaultLock(async () => {
      const raw = (await this.kv.get([SYNC_KEYS.cfg]))[SYNC_KEYS.cfg];
      const cfg = parseSyncCfg(raw);
      if (!cfg || cfg === "damaged" || cfg.cursor?.pending !== pending) return;
      await this.kv.set({ [SYNC_KEYS.cfg]: { ...(raw as Record<string, unknown>), cursor: { cur: pending } } });
    });
  }

  /** The active generation's envelope checksum (inside the lock), or null when there is none readable. */
  private async activeChecksum(ptr: unknown): Promise<string | null> {
    const key = ptr === "a" || ptr === "b" ? KEYS.slot[ptr] : null;
    if (!key) return null;
    const g = await checkGeneration((await this.kv.get([key]))[key]);
    return g ? g.envelope.checksum : null;
  }
}
