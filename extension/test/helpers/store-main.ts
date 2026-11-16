// A verbatim copy of main's extension/src/core/storage/store.ts (before M3), imports re-rooted: the reference for
// test/regression/m3r3-review-phase0.test.ts (M3-R3-REVIEW, departure 3). Not product code.
// Loss-proof local storage (PLAN §4).
//
//   write:    new generation -> the slot that is NOT active -> read back and verify -> only then flip the pointer
//   redundancy: two slots, rolling snapshots (last 10 changes), daily snapshots (last 7 days), an optional second store (mirror)
//   startup:  active slot -> other slot -> newest snapshot -> mirror; every automatic recovery is recorded as an event for the UI
//
// Nothing here needs a key: integrity is judged from the envelope checksum and the key/data agreement. Decrypt-level
// fallback (a copy that passes the checksum but does not open) is handled by openVault().
//
// Key changes (PHASE0X-PLAN A2, U1b; A4: GM2-3, GM2-4). Opening the popup and unlocking do not look at every copy for
// material left under an old key. A marker says when there may be some:
//   INVARIANT: a write that can leave a copy that a superseded secret opens (the other slot, the keyring copy, the
//   mirror, a snapshot: under another key, or with a keyring that is not the current one, such as the old password wrap
//   after a password change) first writes sk_keychange, before it commits. transact() does this by itself whenever the
//   keyring changes (compared as canonicalJson: a new key, a device key gone, a new password or recovery wrap of the same
//   key) and when it overwrites lost data. A write that leaves such material without changing the keyring (M2: the
//   previous-VK fallback in openVault, and only that) must go through transact with { keyChange: true }. applyRemote does
//   not: it writes under the current key with the keyring unchanged byte for byte, into the other slot, so it only ever
//   overwrites old material, never makes any (SYNC-DESIGN §0.0i item 2, revision 12; a merge that changes the keyring,
//   R3, goes through commitKeys and gets the marker from the keyring change).
//   - The marker is changed only by finishKeyChange(), in the same locked step that checked the copies. Once this store
//     is clean (every copy under the current key, or rewritten to be) it becomes a mirror-only marker; once the mirror
//     is clean too it is removed. A full marker means "check at the next open or unlock"; a mirror-only one, "check the
//     mirror at the next unlock" (so a mirror that keeps failing costs nothing at an open). Only a transact writes a full
//     marker, so a mirror-only or absent marker always means this store holds nothing old.
//     A crash before the commit leaves an extra marker: one more cleanup, which is idempotent.
//   - sk_store_v records the key under which this store was last found clean. A store without it (written before this
//     version) gets one full check; so does a key change made by an older version (the key moved on to one whose
//     keyring lists the recorded key as previous). One written by a newer version is left alone.
//   - selfCheck() (browser start, extension install or update; not every service worker wake) still overwrites a device
//     key left in the other slot, the keyring copy or the mirror, with no key and no marker: an independent backstop for
//     device keys only. Old keys after a rotation are covered by the marker alone.
//   A snapshot under a key that is neither current nor listed as previous (SYNC-DESIGN §0.0i, GM2-4): the cleanup offers
//   it to the caller's re-encrypt callback like any other, since the callback is the one record of which keys the caller
//   holds (M2's §3.5 join holds the device's old key in memory). Re-encrypted, it is kept, with its own vault id. If the
//   callback cannot open it: one of THIS vault (same vault id: a NEWER key after a recovery fell back to an older keyring,
//   a restoreBackup of the same vault over its lost remains) is kept, reported in the diagnostics log, and ages out under
//   the normal snapshot limits, since once sync exists its keyring may come back; one of ANOTHER vault (startOver over a
//   lost vault, after the user typed DELETE; a join that crashed before its cleanup) is dropped, and counts as stale, so
//   a cleanup does run for it. A record in a newer format is never deleted.
//
// Sync (SYNC-DESIGN §3.13, §4.6, M2). The store knows nothing of sync; three hooks carry it:
//   - beforeRecoveryWrite (a StoreOptions hook, D1): called inside the lock before every write that makes the active state
//     something else than what was last committed or replaces lost data: recover() moving the pointer (a damaged or lost
//     pointer write, a newer slot) or rolling back an unfinished key change (FIXa2), writeBoth (rebuilt from a snapshot or
//     the mirror), the decrypt fallback's write, and any transact over lost data. The sync layer clears lastSynced and
//     the outbox there, so an older local state is never uploaded without a merge. A hook that throws stops the write.
//     Redundancy heals (the other slot, the keyring copy, the mirror, a missing snapshot) do not call it: they change
//     nothing the next open shows.
//   - transact's ensureCurrentSnapshot (§4.4, F11): before a changing write, the state it replaces is made the newest
//     rolling snapshot if it is not already (applyRemote). Not redundancy: a failure fails the write.
//   - transact's afterCommit (D2): runs after the commit, still inside the lock (the outbox). Guarded like the
//     redundancy writes: a committed save never reports a failure. It must not start a cleanup (the lock is not
//     re-entrant) or touch the network.
import { CryptoError, randomBytes } from "../../src/core/crypto/bytes";
import { decryptVault, encryptVault, type EncryptedVault } from "../../src/core/crypto/envelope";
import { unwrapPreviousVks, type Keyring } from "../../src/core/crypto/keyring";
import type { Vk } from "../../src/core/crypto/vk";
import { canonicalJson } from "../../src/core/vault/merge";
import type { Vault } from "../../src/core/vault/model";
import { VaultError, deserializeVault } from "../../src/core/vault/validate";
import {
  KEYS,
  RETENTION,
  bySeq,
  checkGeneration,
  checkKeyringCopy,
  checkSnapshot,
  isMirrorOnlyMarker,
  isNewerRecord,
  localDayKey,
  other,
  parseEvents,
  parseSnapshotIndex,
  parseStoreVersion,
  type Generation,
  type KeyChangeMarker,
  type SlotName,
  type SnapshotMeta,
  type SnapshotRecord,
  type StorageEvent,
  type StorageEventKind,
  type StoreVersion,
} from "../../src/core/storage/format";
import type { KV, Lock } from "../../src/core/storage/kv";

/** What a transact's callback can ask, inside the lock, read only if asked. */
export type TransactInfo = {
  /**
   * Whether a key-change cleanup is due for the current vault (a marker of any kind, or no record of a finished check):
   * capPrevious may drop the oldest previous key only when none is (SYNC-DESIGN §0.0i req. 10).
   */
  cleanupPending(): Promise<boolean>;
};

export type TransactOptions = {
  /** Lost data may be replaced (create, restore, start over, cloud restore): writes the marker and calls the recovery hook. */
  overwriteLost?: boolean;
  /** The write leaves material that an old secret opens although the keyring is unchanged: write the marker (store.ts top). */
  keyChange?: boolean;
  /** Before a write that changes the data, make the state it replaces the newest rolling snapshot (applyRemote, §4.6). */
  ensureCurrentSnapshot?: boolean;
  /** After the commit, inside the lock, guarded (the sync outbox, D2). Gets the generation just committed. */
  afterCommit?: (gen: Generation) => Promise<void>;
  /** A notice for the user, recorded after the commit (a cloud restore, §4.13). Guarded. */
  event?: { kind: StorageEventKind; restoredTo: number; detail: string };
};

export class StorageError extends Error {
  constructor(
    readonly code: "verify_failed" | "lost_needs_confirm" | "unreadable",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "StorageError";
  }
}

export type StoreOptions = {
  kv: KV;
  mirror?: KV;
  /**
   * Required (GM2-11, SYNC-DESIGN §0.0i M2 req. 3): every store over the same data, in every context, must take the same
   * lock, or a transact and a cleanup in two contexts interleave. There is no default to fall back on silently.
   * Production builds its one store in platform/runtime.ts, with webLock("sixkey-vault"); tests pass createMutex().
   */
  lock: Lock;
  now?: () => number;
  dayKey?: (ms: number) => string;
  /** Non-fatal problems (a failed mirror write, a snapshot that could not be pruned). Never contains key material. */
  onDiag?: (message: string, err?: unknown) => void;
  /**
   * Called inside the lock before every recovery write (see the top of this file; SYNC-DESIGN §3.13, D1). The sync layer
   * clears lastSynced and the outbox here. It must not call the store. A throw stops the recovery write.
   */
  beforeRecoveryWrite?: () => Promise<void>;
};

export type LoadResult =
  { status: "ok"; gen: Generation; events: StorageEvent[] } | { status: "empty" } | { status: "lost" };

export type Candidate = {
  source: string;
  kind: "slot" | "snapshot" | "mirror";
  at: number;
  seq: number;
  envelope: EncryptedVault;
  keyring?: Keyring;
};

/**
 * Which key-change cleanup is due: "full" at the next open or unlock, "mirror" (only the mirror is left) at the next
 * unlock, or none.
 */
export type Cleanup = "none" | "mirror" | "full";

/**
 * What opening needs, read once (PHASE0X-PLAN A2): the generation, every unacknowledged event, and which cleanup is
 * due. Same state and events as load() followed by listEvents().
 */
export type ViewLoad =
  | { status: "ok"; gen: Generation; events: StorageEvent[]; cleanup: Cleanup }
  | { status: "empty" }
  | { status: "lost" };

type Reencrypt = (env: EncryptedVault) => Promise<EncryptedVault | null>;

const asSlot = (v: unknown): SlotName | null => (v === "a" || v === "b" ? v : null);
const isSnapKey = (k: string) => k.startsWith("sk_snap_") && k !== KEYS.snapIndex;

/**
 * Full: a full marker (any value that is not a mirror-only marker for the current key, even a damaged one), no record of
 * a finished check, or a key change made without a marker. Mirror: a mirror-only marker. A sk_store_v from a newer
 * version starts nothing by itself.
 */
function cleanupNeeded(marker: unknown, version: unknown, keyring: Keyring): Cleanup {
  const v = parseStoreVersion(version);
  if (v === null || (v !== "newer" && v.vkId !== keyring.vkId && keyring.previous.some((p) => p.vkId === v.vkId)))
    return "full";
  if (marker === undefined) return "none";
  return isMirrorOnlyMarker(marker, keyring.vkId) ? "mirror" : "full";
}

/** The snapshot limits: the last 10 changes and the last 7 days; the mirror keeps 7 (daily only). */
function retained(idx: SnapshotMeta[], mirror: boolean): SnapshotMeta[] {
  if (mirror) return [...idx].sort(bySeq).slice(0, RETENTION.daily);
  const keep = (k: SnapshotMeta["kind"], n: number) =>
    idx
      .filter((m) => m.kind === k)
      .sort((a, b) => bySeq(a, b) || (a.id < b.id ? 1 : -1))
      .slice(0, n);
  return [...keep("rolling", RETENTION.rolling), ...keep("daily", RETENTION.daily)];
}

export class VaultStore {
  private readonly kv: KV;
  private readonly mirror?: KV;
  private readonly lock: Lock;
  private readonly now: () => number;
  private readonly dayKey: (ms: number) => string;
  private readonly diag: (m: string, e?: unknown) => void;
  private readonly recoveryHook: (() => Promise<void>) | undefined;

  constructor(o: StoreOptions) {
    this.kv = o.kv;
    if (o.mirror) this.mirror = o.mirror;
    this.lock = o.lock;
    this.now = o.now ?? Date.now;
    this.dayKey = o.dayKey ?? localDayKey;
    this.diag = o.onDiag ?? (() => undefined);
    this.recoveryHook = o.beforeRecoveryWrite;
  }

  /** Before a recovery write (see the top of this file). Inside the lock. */
  private async beforeRecovery(): Promise<void> {
    if (this.recoveryHook) await this.recoveryHook();
  }

  // ---- reading -------------------------------------------------------------------------------

  /** Fast path for opening the popup: read the active slot, and only walk the recovery ladder if it is unusable. */
  load(): Promise<LoadResult> {
    return this.lock(() => this.loadInner());
  }

  /** Full startup self-check: look at both slots and the pointer, repair what can be repaired. */
  selfCheck(): Promise<LoadResult> {
    return this.lock(() => this.recover());
  }

  private async loadInner(): Promise<LoadResult> {
    const ptr = await this.readPointer();
    if (ptr) {
      const g = await this.readSlot(ptr);
      if (g) return { status: "ok", gen: g, events: [] };
    }
    return this.recover();
  }

  /**
   * load() for opening the popup: the pointer, the events and the key-change state in one read, then the active slot.
   * Anything wrong goes down the same recovery ladder as load(). A read that throws propagates, as everywhere here.
   */
  loadView(): Promise<ViewLoad> {
    return this.lock(async () => {
      const meta = await this.kv.get([KEYS.active, KEYS.events, KEYS.keyChange, KEYS.storeVersion]);
      const ptr = asSlot(meta[KEYS.active]);
      let gen = ptr ? await this.readSlot(ptr) : null;
      let events = parseEvents(meta[KEYS.events]);
      if (!gen) {
        const r = await this.recover();
        if (r.status !== "ok") return r;
        gen = r.gen;
        events = await this.readEvents(); // now including what the recovery just recorded
      }
      // recover() never writes the marker or sk_store_v, so the values read above still hold.
      return {
        status: "ok",
        gen,
        events,
        cleanup: cleanupNeeded(meta[KEYS.keyChange], meta[KEYS.storeVersion], gen.keyring),
      };
    });
  }

  private async readPointer(): Promise<SlotName | null> {
    return asSlot((await this.kv.get([KEYS.active]))[KEYS.active]);
  }

  /**
   * null means the slot was read and is absent or damaged. A read that throws is not the same thing: it may be a passing
   * I/O error on a perfectly good slot, so the error propagates and nothing is repaired or overwritten on its account.
   */
  private async readSlot(slot: SlotName, kv: KV = this.kv): Promise<Generation | null> {
    const key = KEYS.slot[slot];
    return checkGeneration((await kv.get([key]))[key]);
  }

  // ---- recovery ladder -----------------------------------------------------------------------

  private async recover(): Promise<LoadResult> {
    const [ptr, ga, gb] = await Promise.all([this.readPointer(), this.readSlot("a"), this.readSlot("b")]);
    const events: StorageEvent[] = [];
    const good = (
      [
        ["a", ga],
        ["b", gb],
      ] as [SlotName, Generation | null][]
    ).filter((x): x is [SlotName, Generation] => x[1] !== null);

    if (good.length > 0) {
      // Highest sequence wins; a tie goes to the slot the pointer already names.
      good.sort((x, y) => y[1].seq - x[1].seq || (x[0] === ptr ? -1 : 1));
      let [slot, gen] = good[0]!;
      // Except a keyring change (P-1, FIXa2; the owner's decision: rely on the slot the pointer names, so an unfinished key
      // change is always rolled back). A newer slot the pointer does not name, with another keyring, is a key change, a
      // password reset or a new recovery code whose commit never landed: its new recovery code may never have been
      // shown. Committing it here would make the code the user saved stop working. load() trusts the pointer the same way,
      // so the self-check and every open now agree. The cost: if a power loss drops only the pointer write after the
      // user saw the change succeed, it is rolled back (the old password and recovery code open the vault again; no
      // account is lost, the data is the same). Ordinary saves (same keyring) keep "highest sequence wins".
      // The rejected generation is overwritten in the same step (GM2-2): left in the other slot, a later fault on the
      // pointer slot would commit it after all, and the code the user saved would stop working then. It is reported as a
      // diagnostics line, not as an event: every event is shown as "data restored automatically", which this is not (a
      // user-facing notice needs its own event kind and text: GM2-2(b), before release). Not kept for forensics either
      // (A4R-7): a copy of it anywhere the recovery ladder reads is exactly what a later fault would commit, and its
      // only content beyond the data the pointer slot has is the new wrap, which proves nothing the line does not say.
      const named = ptr === "a" ? ga : ptr === "b" ? gb : null;
      let rejected = false;
      if (named && slot !== ptr && canonicalJson(named.keyring) !== canonicalJson(gen.keyring)) {
        this.diag(`key change rolled back: slot ${slot} (seq ${gen.seq}) never committed`);
        [slot, gen] = [ptr!, named];
        rejected = true;
      }
      const pointerSlotBroken = ptr !== null && (ptr === "a" ? ga : gb) === null;
      // The active state becomes another generation, or a rolled-back key change is overwritten: a recovery write.
      if (ptr !== slot || rejected) await this.beforeRecovery();
      if (ptr !== slot) await this.kv.set({ [KEYS.active]: slot });
      if (pointerSlotBroken) {
        events.push(await this.pushEvent("slot_fallback", gen.savedAt, `slot ${ptr} was damaged; using slot ${slot}`));
      }
      await this.restoreRedundancy(slot, gen, rejected ? null : slot === "a" ? gb : ga);
      await this.gcSnapshots();
      return { status: "ok", gen, events };
    }

    // Both slots are unusable. The keyring survives in its own copy and in the mirror; snapshots hold data only.
    // A source whose read throws is skipped, but remembered (P-4): if nothing usable is found, that error is reported
    // instead of "lost". "Lost" leads to restoring or starting over, which would overwrite data that a retry can read.
    let unread: unknown = null;
    const skipped = (e: unknown) => {
      unread ??= e;
      this.diag("recovery source unreadable", e);
    };
    const mirrorGen = this.mirror ? await this.readMirrorGen(skipped) : null;
    let copyRaw: unknown;
    try {
      copyRaw = (await this.kv.get([KEYS.keyringCopy]))[KEYS.keyringCopy];
    } catch (e) {
      skipped(e);
    }
    const copy = checkKeyringCopy(copyRaw);
    const sources: { keyring: Keyring; at: number }[] = [];
    if (mirrorGen) sources.push({ keyring: mirrorGen.keyring, at: mirrorGen.savedAt });
    if (copy) sources.push({ keyring: copy.keyring, at: copy.savedAt });
    sources.sort((x, y) => y.at - x.at);

    const candidates = await this.snapshotCandidates(skipped);
    if (mirrorGen)
      candidates.push({
        source: "mirror",
        kind: "mirror",
        at: mirrorGen.savedAt,
        seq: mirrorGen.seq,
        envelope: mirrorGen.envelope,
        keyring: mirrorGen.keyring,
      });
    candidates.sort(bySeq);
    const topSeq = Math.max(0, mirrorGen?.seq ?? 0, ...candidates.map((c) => c.seq));

    for (const src of sources) {
      const pick = candidates.find(
        (c) => c.envelope.vkId === src.keyring.vkId && c.envelope.vaultId === src.keyring.vaultId,
      );
      if (!pick) continue;
      const gen = await this.writeBoth(src.keyring, pick.envelope, pick.at, topSeq + 1);
      const kind: StorageEventKind = pick.kind === "mirror" ? "mirror_restore" : "snapshot_restore";
      events.push(await this.pushEvent(kind, pick.at, `restored from ${pick.source}`));
      return { status: "ok", gen, events };
    }
    if (unread !== null) throw unread;
    return (await this.hasAnyData()) ? { status: "lost" } : { status: "empty" };
  }

  /**
   * After a fault is survived, put back whatever redundancy it cost: the other slot, the keyring copy, a snapshot of the
   * current data, the mirror. Otherwise a second, unrelated fault later could be fatal. A valid but older other slot is
   * deliberately left alone: it is the previous good state. `otherGen` null: the other slot is overwritten (it is absent,
   * damaged, or holds a key change that was just rolled back).
   */
  private async restoreRedundancy(slot: SlotName, gen: Generation, otherGen: Generation | null): Promise<void> {
    // A leftover device key next to a keyring that no longer has one defeats the master password: overwrite it.
    const staleDeviceKey = !gen.keyring.deviceKey && otherGen?.keyring.deviceKey !== undefined;
    if (!otherGen || staleDeviceKey) {
      await this.guarded("heal other slot", async () => {
        await this.kv.set({ [KEYS.slot[other(slot)]]: gen });
      });
    }
    await this.guarded("heal keyring copy", async () => {
      // A read that throws fails this step (logged, retried at the next self-check) instead of counting as no copy.
      const copy = checkKeyringCopy((await this.kv.get([KEYS.keyringCopy]))[KEYS.keyringCopy]);
      if (!copy || canonicalJson(copy.keyring) !== canonicalJson(gen.keyring)) {
        await this.kv.set({ [KEYS.keyringCopy]: { v: 1, savedAt: gen.savedAt, keyring: gen.keyring } });
      }
    });
    await this.guarded("heal snapshot", async () => {
      const newest = (await this.readIndexStrict(this.kv)).sort(bySeq)[0];
      const rec = newest
        ? await checkSnapshot((await this.kv.get([KEYS.snap(newest.id)]))[KEYS.snap(newest.id)])
        : null;
      if (!rec) await this.addSnapshot("rolling", gen);
    });
    if (this.mirror) {
      await this.guarded("heal mirror", async () => {
        const m = await this.readMirrorGen();
        const stale = m !== null && !gen.keyring.deviceKey && m.keyring.deviceKey !== undefined;
        if (!m || stale || m.seq !== gen.seq || m.envelope.checksum !== gen.envelope.checksum)
          await this.mirror!.set({ [KEYS.mirrorGen]: gen });
      });
    }
  }

  /** Whether any vault data is left. Settings, the device id, the diagnostics log and similar are not vault data. */
  private async hasAnyData(): Promise<boolean> {
    const isVaultKey = (k: string) =>
      k === KEYS.active ||
      k === KEYS.slot.a ||
      k === KEYS.slot.b ||
      k === KEYS.keyringCopy ||
      k === KEYS.mirrorGen ||
      k.startsWith("sk_snap_");
    if ((await this.kv.keys()).some(isVaultKey)) return true;
    return this.mirror ? (await this.mirror.keys()).some(isVaultKey) : false;
  }

  /** `skipped`: told about a read that threw (the copy is then treated as absent); without it the error is only logged. */
  private async readMirrorGen(skipped?: (e: unknown) => void): Promise<Generation | null> {
    try {
      return await checkGeneration((await this.mirror!.get([KEYS.mirrorGen]))[KEYS.mirrorGen]);
    } catch (e) {
      if (skipped) skipped(e);
      else this.diag("mirror unreadable", e);
      return null;
    }
  }

  /** For display only (snapshots()): a read that throws shows as no snapshots. Nothing is ever written from this. */
  private async readIndex(kv: KV): Promise<SnapshotMeta[]> {
    try {
      return parseSnapshotIndex((await kv.get([KEYS.snapIndex]))[KEYS.snapIndex]);
    } catch {
      return [];
    }
  }

  /** The index as stored (a damaged value reads as empty); a read that throws propagates. Used before any write. */
  private async readIndexStrict(kv: KV): Promise<SnapshotMeta[]> {
    return parseSnapshotIndex((await kv.get([KEYS.snapIndex]))[KEYS.snapIndex]);
  }

  /**
   * Every readable snapshot, in both stores. A read that throws skips that store or record and is told to `skipped`, with
   * the save counter the index gives for that record (none when the index itself could not be read: anything may be
   * missing then), and whether it was the mirror.
   */
  private async snapshotCandidates(
    skipped: (e: unknown, seq?: number, mirror?: boolean) => void,
  ): Promise<Candidate[]> {
    const out: Candidate[] = [];
    for (const [kv, label] of [
      [this.kv, "snapshot"],
      [this.mirror, "mirror snapshot"],
    ] as [KV | undefined, string][]) {
      if (!kv) continue;
      let idx: SnapshotMeta[] = [];
      try {
        idx = await this.readIndexStrict(kv);
      } catch (e) {
        skipped(e, undefined, kv !== this.kv);
      }
      for (const meta of idx) {
        let rec: SnapshotRecord | null = null;
        try {
          rec = await checkSnapshot((await kv.get([KEYS.snap(meta.id)]))[KEYS.snap(meta.id)]);
        } catch (e) {
          skipped(e, meta.seq, kv !== this.kv);
        }
        if (rec)
          out.push({
            source: `${label} ${meta.id}`,
            kind: kv === this.kv ? "snapshot" : "mirror",
            at: rec.meta.at,
            seq: rec.meta.seq,
            envelope: rec.envelope,
          });
      }
    }
    return out;
  }

  /**
   * Snapshot records the index does not list (P-2). A valid one is listed again, as if just added (the limits apply);
   * one in a newer format is left alone; only a damaged one is removed. A crash between writing a record and its index,
   * or a lost or damaged index, therefore costs no history. Reads that throw propagate.
   * Returns the index to write (null: unchanged) and the records to remove.
   */
  private async orphans(kv: KV, idx: SnapshotMeta[]): Promise<{ idx: SnapshotMeta[] | null; remove: string[] }> {
    const listed = new Set(idx.map((m) => KEYS.snap(m.id)));
    const unlisted = (await kv.keys()).filter((k) => isSnapKey(k) && !listed.has(k));
    const adopted: SnapshotMeta[] = [];
    const remove: string[] = [];
    for (const k of unlisted) {
      const raw = (await kv.get([k]))[k];
      if (raw === undefined || isNewerRecord(raw)) continue;
      const rec = await checkSnapshot(raw);
      const meta = rec ? parseSnapshotIndex([rec.meta])[0] : undefined;
      if (meta && KEYS.snap(meta.id) === k) adopted.push(meta);
      else remove.push(k);
    }
    if (!adopted.length) return { idx: null, remove };
    const all = [...idx, ...adopted];
    const kept = retained(all, kv !== this.kv);
    for (const m of all) if (!kept.includes(m)) remove.push(KEYS.snap(m.id));
    return { idx: kept, remove };
  }

  /** Put unlisted snapshot records back in the index, or remove them if they are damaged (startup self-check). */
  private async gcSnapshots(): Promise<void> {
    try {
      const o = await this.orphans(this.kv, await this.readIndexStrict(this.kv));
      if (o.idx) await this.kv.set({ [KEYS.snapIndex]: o.idx });
      if (o.remove.length) await this.kv.remove(o.remove);
    } catch (e) {
      this.diag("snapshot gc failed", e);
    }
  }

  /** The highest save counter any snapshot on disk has (in either store), so a vault made over lost data starts above it. */
  private async highestSnapshotSeq(): Promise<number> {
    let top = Math.max(0, ...(await this.readIndexStrict(this.kv)).map((m) => m.seq));
    if (this.mirror) {
      try {
        top = Math.max(top, ...(await this.readIndexStrict(this.mirror)).map((m) => m.seq));
      } catch (e) {
        this.diag("mirror unreadable", e);
      }
    }
    return top;
  }

  /** Both slots and the pointer, written and verified; used when rebuilding from a snapshot or the mirror. */
  private async writeBoth(
    keyring: Keyring,
    envelope: EncryptedVault,
    savedAt: number,
    seq: number,
  ): Promise<Generation> {
    const gen: Generation = { v: 1, seq, savedAt, envelope, keyring };
    if (!(await checkGeneration(gen))) throw new StorageError("verify_failed", "restored generation is inconsistent");
    await this.beforeRecovery();
    await this.kv.set({ [KEYS.slot.a]: gen });
    await this.verifySlot("a", gen);
    await this.kv.set({ [KEYS.active]: "a" });
    await this.kv.set({ [KEYS.slot.b]: gen, [KEYS.keyringCopy]: { v: 1, savedAt, keyring } });
    return gen;
  }

  private async verifySlot(slot: SlotName, gen: Generation): Promise<void> {
    const key = KEYS.slot[slot];
    const back = (await this.kv.get([key]))[key];
    if (canonicalJson(back) !== canonicalJson(gen) || !(await checkGeneration(back)))
      throw new StorageError("verify_failed", `slot ${slot} did not read back`);
  }

  // ---- writing -------------------------------------------------------------------------------

  /**
   * Read-modify-write under the lock, so two popups cannot overwrite each other with stale state.
   * `fn` receives the current generation (or null for a new vault) and returns what to store. It runs inside the
   * cross-context lock: no network, no call back into this store (SYNC-DESIGN §4.6).
   */
  transact(
    fn: (current: Generation | null, info: TransactInfo) => Promise<{ envelope: EncryptedVault; keyring: Keyring }>,
    opts: TransactOptions = {},
  ): Promise<Generation> {
    return this.lock(() => this.write(fn, opts, false));
  }

  /** transact's body, inside the lock. `recovery`: the decrypt fallback's write (calls the recovery hook). */
  private async write(
    fn: (current: Generation | null, info: TransactInfo) => Promise<{ envelope: EncryptedVault; keyring: Keyring }>,
    opts: TransactOptions,
    recovery: boolean,
  ): Promise<Generation> {
    const cur = await this.loadInner();
    if (cur.status === "lost" && !opts.overwriteLost)
      throw new StorageError("lost_needs_confirm", "stored data is unreadable; refusing to overwrite it");
    const prev = cur.status === "ok" ? cur.gen : null;
    const info: TransactInfo = {
      cleanupPending: async () => {
        if (!prev) return false;
        const m = await this.kv.get([KEYS.keyChange, KEYS.storeVersion]);
        return cleanupNeeded(m[KEYS.keyChange], m[KEYS.storeVersion], prev.keyring) !== "none";
      },
    };
    const next = await fn(prev, info);

    const ptr = prev ? ((await this.readPointer()) ?? "a") : null;
    const target: SlotName = ptr ? other(ptr) : "a";
    // Over lost data, count on from the highest snapshot left on disk (P-6): the old snapshots keep their places in the
    // limits by save counter, and a new vault starting again at 1 would have every new snapshot pruned at once.
    const base = prev ? prev.seq : cur.status === "lost" ? await this.highestSnapshotSeq() : 0;
    const gen: Generation = {
      v: 1,
      seq: base + 1,
      savedAt: this.now(),
      envelope: next.envelope,
      keyring: next.keyring,
    };
    if (!(await checkGeneration(gen)))
      throw new StorageError("verify_failed", "refusing to write an inconsistent generation");
    const changed = !prev || prev.envelope.checksum !== gen.envelope.checksum;
    // The state being replaced is kept as the newest rolling snapshot before anything is written (applyRemote, F11).
    // It normally is already (every changing commit adds one); a failure to make sure fails the write.
    if (opts.ensureCurrentSnapshot && prev && changed) await this.ensureSnapshotOf(prev);
    // Replacing lost data, or the decrypt fallback's restore: a recovery write (D1).
    if (recovery || cur.status === "lost") await this.beforeRecovery();

    // The marker goes down before the commit, and a failure to write it fails the save (see the top of this file). Any
    // keyring change counts (GM2-3): after a new password or recovery code of the same key, the other slot, the keyring
    // copy and the mirror still hold the old wrap, which opens the current data with the old secret (P-5).
    const leavesOldMaterial =
      opts.keyChange === true ||
      (prev ? canonicalJson(prev.keyring) !== canonicalJson(gen.keyring) : cur.status === "lost");
    if (leavesOldMaterial) {
      const marker: KeyChangeMarker = { v: 1, vkId: gen.keyring.vkId, at: gen.savedAt };
      await this.kv.set({ [KEYS.keyChange]: marker });
    }

    try {
      await this.kv.set({ [KEYS.slot[target]]: gen });
      await this.verifySlot(target, gen);
      await this.kv.set({ [KEYS.active]: target }); // the commit point
    } catch (e) {
      // A keyring change the caller is told failed does not stay in the slot either (P-1, FIXb; recover() also refuses
      // to commit one, FIXa2, which covers a process that dies here). Only then: for a save that keeps the keyring, the
      // slot is left as written, since prev may be exactly the copy that does not open (a decrypt fallback restoring
      // the good copy into this slot) and writing it back would replace the only good slot with it. Best effort: if
      // this write fails too, the error reported is still the first.
      if (prev && canonicalJson(prev.keyring) !== canonicalJson(gen.keyring))
        await this.kv.set({ [KEYS.slot[target]]: prev }).catch(() => undefined);
      throw e;
    }

    // Everything below is redundancy. A failure here must not fail a save that already succeeded.
    if (changed) await this.guarded("rolling snapshot", () => this.addSnapshot("rolling", gen));
    await this.guarded("keyring copy", async () => {
      await this.kv.set({ [KEYS.keyringCopy]: { v: 1, savedAt: gen.savedAt, keyring: gen.keyring } });
    });
    await this.guarded("mirror", async () => {
      await this.mirror?.set({ [KEYS.mirrorGen]: gen });
    });
    if (opts.event) {
      const ev = opts.event;
      await this.guarded("event", async () => {
        await this.pushEvent(ev.kind, ev.restoredTo, ev.detail);
      });
    }
    if (opts.afterCommit) {
      const after = opts.afterCommit;
      await this.guarded("after commit", () => after(gen));
    }
    return gen;
  }

  /** The newest rolling snapshot holds `gen`'s envelope, or one is added for it. Reads that throw propagate. */
  private async ensureSnapshotOf(gen: Generation): Promise<void> {
    const newest = (await this.readIndexStrict(this.kv)).filter((m) => m.kind === "rolling").sort(bySeq)[0];
    const rec = newest ? await checkSnapshot((await this.kv.get([KEYS.snap(newest.id)]))[KEYS.snap(newest.id)]) : null;
    if (!rec || rec.envelope.checksum !== gen.envelope.checksum) await this.addSnapshot("rolling", gen);
  }

  private async guarded(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.diag(`${what} failed`, e);
    }
  }

  private async addSnapshot(kind: "rolling" | "daily", gen: Generation, day?: string): Promise<void> {
    const id = kind === "rolling" ? `r${gen.seq}` : `d${day}`;
    const meta: SnapshotMeta = { id, kind, at: gen.savedAt, seq: gen.seq, ...(day ? { day } : {}) };
    const rec: SnapshotRecord = { v: 1, meta, envelope: gen.envelope };
    // A read of the index that throws fails this snapshot (the caller logs it), rather than counting as an empty index
    // and replacing it with this one entry, which would leave every other snapshot unlisted (P-2).
    const idx = (await this.readIndexStrict(this.kv)).filter((m) => m.id !== id);
    idx.push(meta);
    const kept = retained(idx, false);
    const dropped = idx.filter((m) => !kept.includes(m));
    await this.kv.set({ [KEYS.snap(id)]: rec, [KEYS.snapIndex]: kept });
    if (dropped.length) await this.kv.remove(dropped.map((m) => KEYS.snap(m.id)));
    if (kind === "daily" && this.mirror) {
      const mIdx = (await this.readIndexStrict(this.mirror)).filter((m) => m.id !== id);
      mIdx.push(meta);
      const mKept = retained(mIdx, true);
      await this.mirror.set({ [KEYS.snap(id)]: rec, [KEYS.snapIndex]: mKept });
      const gone = mIdx.filter((m) => !mKept.includes(m)).map((m) => KEYS.snap(m.id));
      if (gone.length) await this.mirror.remove(gone);
    }
  }

  /** At most one daily snapshot per local calendar day. Cheap to call often (SW start, popup open, alarm). */
  ensureDailySnapshot(): Promise<boolean> {
    return this.lock(async () => {
      const cur = await this.loadInner();
      if (cur.status !== "ok") return false;
      const day = this.dayKey(this.now());
      if ((await this.readIndexStrict(this.kv)).some((m) => m.kind === "daily" && m.day === day)) return false;
      const gen = { ...cur.gen, savedAt: this.now() };
      await this.addSnapshot("daily", gen, day);
      return true;
    });
  }

  async snapshots(): Promise<SnapshotMeta[]> {
    return (await this.readIndex(this.kv)).sort(bySeq);
  }

  // ---- key changes ---------------------------------------------------------------------------

  /**
   * Cheap check for the window after turning the password on: if the previous slot still has a device key while the
   * active keyring does not, overwrite it. One read when nothing is wrong. read() (the settings page) still runs it on
   * every open; the popup relies on the key-change marker instead.
   */
  scrubStaleDeviceKey(): Promise<boolean> {
    return this.lock(async () => {
      const cur = await this.loadInner();
      if (cur.status !== "ok" || cur.gen.keyring.deviceKey) return false;
      const target = other((await this.readPointer()) ?? "a");
      const og = await this.readSlot(target);
      if (!og?.keyring.deviceKey) return false;
      await this.kv.set({ [KEYS.slot[target]]: cur.gen });
      return true;
    });
  }

  /**
   * Finish a key change (or check a store from before the marker existed), in one locked step: look at every copy in
   * this store and the mirror, rewrite what is not under the current key, then record the outcome. `vk` must be the
   * current key: if the key changed again meanwhile, nothing is done here (that change wrote its own marker).
   *   - This store clean (found so, or rewritten): sk_store_v names the current key.
   *   - The mirror clean too: the marker is removed. The mirror not reachable or not writable (it is redundancy: logged,
   *     never fatal): the marker becomes mirror-only, so only the next unlock tries again and an open does not.
   *   - A mirror-only marker for the current key skips this store: nothing but a transact can put old material here,
   *     and a transact that does writes a full marker first.
   * A read that throws propagates and leaves the marker as it was, so nothing is deleted on account of a read that failed.
   * `reencrypt` is offered every copy not under the current key, including one under a key the keyring does not list
   * (see the top of this file for what is kept when it cannot open one). Pages and the service worker never call this
   * directly: VaultService has one cleanup entry point (SYNC-DESIGN §0.0i M2 req. 5).
   */
  finishKeyChange(
    vk: Vk,
    reencrypt: Reencrypt,
  ): Promise<{ done: boolean; rewritten: number; dropped: number; kept: number }> {
    return this.lock(async () => {
      const meta = await this.kv.get([KEYS.keyChange, KEYS.storeVersion, KEYS.active]);
      let ptr = asSlot(meta[KEYS.active]);
      let gen = ptr ? await this.readSlot(ptr) : null;
      if (!gen) {
        const r = await this.recover();
        if (r.status !== "ok") throw new StorageError("unreadable", r.status);
        gen = r.gen;
        ptr = await this.readPointer();
      }
      const slot = ptr ?? "a";
      const nothing = { rewritten: 0, dropped: 0, kept: 0 };
      if (gen.keyring.vkId !== vk.id) return { done: false, ...nothing };

      const version = parseStoreVersion(meta[KEYS.storeVersion]);
      const thisStoreClean =
        isMirrorOnlyMarker(meta[KEYS.keyChange], vk.id) &&
        version !== null &&
        (version === "newer" || version.vkId === vk.id);
      const p = thisStoreClean ? { stale: false, unknown: 0 } : await this.staleIn(this.kv, gen, slot);
      let m: { stale: boolean; unknown: number } | "unreadable" = { stale: false, unknown: 0 };
      if (this.mirror) {
        try {
          m = await this.staleIn(this.mirror, gen, slot);
        } catch (e) {
          this.diag("mirror unreadable", e);
          m = "unreadable";
        }
      }
      const mirrorStale = m !== "unreadable" && m.stale;
      let r = { ...nothing, mirrorDone: true };
      // Only what is stale is rewritten: with a mirror that keeps failing, each retry does not rewrite the clean store again.
      if (p.stale || mirrorStale)
        r = await this.rewriteInner(gen, slot, reencrypt, {
          primary: p.stale,
          mirror: mirrorStale,
          unknownKey: "offer",
        });
      const done = m !== "unreadable" && r.mirrorDone;
      // Copies of this vault under a key nobody here can open are kept (see the top of this file), and reported.
      const kept = Math.max(r.kept, p.unknown + (m === "unreadable" ? 0 : m.unknown));
      if (kept) this.diag(`kept ${kept} snapshot(s) under a key this vault does not know`);

      // This store is clean now (anything that failed above threw before this line).
      if (version !== "newer" && version?.vkId !== vk.id)
        await this.kv.set({ [KEYS.storeVersion]: { v: 2, vkId: vk.id } satisfies StoreVersion });
      if (done) {
        if (meta[KEYS.keyChange] !== undefined) await this.kv.remove([KEYS.keyChange]); // the very last step
      } else if (!isMirrorOnlyMarker(meta[KEYS.keyChange], vk.id)) {
        const marker: KeyChangeMarker = { v: 1, vkId: vk.id, at: this.now(), mirror: true };
        await this.kv.set({ [KEYS.keyChange]: marker });
      }
      return { done, rewritten: r.rewritten, dropped: r.dropped, kept };
    });
  }

  /**
   * Whether `kv` still holds anything a key change has not reached: the other slot (or the mirror's copy) or the keyring
   * copy with a keyring other than the current one (GM2-3: another key, a device key, an old password or recovery wrap of
   * the same key), or damaged; a snapshot under a key the keyring lists as previous, or damaged; a snapshot of another
   * vault under a key the keyring does not know (GM2-4: offered to the callback, dropped if it cannot open it); a
   * snapshot record the index does not list. Not stale: a snapshot of this vault under a key the keyring does not know
   * (kept, see the top of this file; `unknown` counts them when nothing is stale), and any record in a newer format.
   * Reads that throw propagate.
   */
  private async staleIn(kv: KV, gen: Generation, ptr: SlotName): Promise<{ stale: boolean; unknown: number }> {
    const stale = { stale: true, unknown: 0 };
    let unknown = 0;
    const current = canonicalJson(gen.keyring);
    const old = (k: Keyring) => canonicalJson(k) !== current;
    const previous = new Set(gen.keyring.previous.map((p) => p.vkId));
    const genKey = kv === this.kv ? KEYS.slot[other(ptr)] : KEYS.mirrorGen;
    const g = (await kv.get([genKey]))[genKey];
    if (g !== undefined) {
      const ok = await checkGeneration(g);
      if (!ok || old(ok.keyring)) return stale;
    }
    if (kv === this.kv) {
      const c = (await kv.get([KEYS.keyringCopy]))[KEYS.keyringCopy];
      if (c !== undefined) {
        const ok = checkKeyringCopy(c);
        if (!ok || old(ok.keyring)) return stale;
      }
    }
    const idx = await this.readIndexStrict(kv);
    for (const m of idx) {
      const raw = (await kv.get([KEYS.snap(m.id)]))[KEYS.snap(m.id)];
      if (isNewerRecord(raw)) continue;
      const rec = await checkSnapshot(raw);
      if (!rec) return stale;
      if (rec.envelope.vkId === gen.keyring.vkId) continue;
      if (previous.has(rec.envelope.vkId) || rec.envelope.vaultId !== gen.keyring.vaultId) return stale;
      unknown++;
    }
    const listed = new Set(idx.map((m) => KEYS.snap(m.id)));
    for (const k of await kv.keys()) {
      if (!isSnapKey(k) || listed.has(k)) continue;
      if (!isNewerRecord((await kv.get([k]))[k])) return stale;
    }
    return { stale: false, unknown };
  }

  /**
   * Overwrite the other slot with the current generation, and pass every snapshot to `reencrypt` (drop it if that
   * returns nothing usable). For purgeForever only: this is erasure, not a key-change cleanup (SYNC-DESIGN §0.0i GM2-4;
   * a key change is finished by finishKeyChange, through VaultService's one cleanup entry point). Reads that throw
   * propagate (P-3): a purge that cannot read the index fails and can be retried, instead of writing an empty index. A
   * snapshot under a key nobody has is dropped here, whatever its vault, since it cannot be checked for the purged
   * secret; a record in a newer format is kept.
   */
  rewriteForKeyChange(
    reencrypt: Reencrypt,
    opts: { all?: boolean } = {},
  ): Promise<{ rewritten: number; dropped: number }> {
    return this.lock(async () => {
      const cur = await this.loadInner();
      if (cur.status !== "ok") throw new StorageError("unreadable", cur.status);
      const { rewritten, dropped } = await this.rewriteInner(cur.gen, (await this.readPointer()) ?? "a", reencrypt, {
        all: opts.all === true,
        primary: true,
        mirror: true,
        unknownKey: "drop",
      });
      return { rewritten, dropped };
    });
  }

  /**
   * The rewrite itself, inside the lock. Reads that throw propagate. Unlisted snapshot records are listed again or removed
   * first (orphans()). `primary` / `mirror`: which stores to rewrite. `unknownKey`: what to do with a snapshot under a key
   * that is neither current nor previous when `reencrypt` cannot move it to the current key: "offer" (a key-change
   * cleanup) keeps one of this vault and drops one of another vault; "drop" (a purge) drops it. Either way it is offered
   * to `reencrypt` first. `mirrorDone` is false if any part of the mirror failed (logged, never thrown).
   */
  private async rewriteInner(
    gen: Generation,
    ptr: SlotName,
    reencrypt: Reencrypt,
    opts: { all?: boolean; primary: boolean; mirror: boolean; unknownKey: "offer" | "drop" },
  ): Promise<{ rewritten: number; dropped: number; kept: number; mirrorDone: boolean }> {
    if (opts.primary) {
      await this.kv.set({ [KEYS.slot[other(ptr)]]: gen });
      await this.verifySlot(other(ptr), gen);
      await this.kv.set({ [KEYS.keyringCopy]: { v: 1, savedAt: gen.savedAt, keyring: gen.keyring } });
    }
    const mirror = opts.mirror ? this.mirror : undefined;
    let mirrorDone = true;
    const inMirror = async (what: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        mirrorDone = false;
        this.diag(`${what} failed`, e);
      }
    };
    if (mirror)
      await inMirror("mirror", async () => {
        await mirror.set({ [KEYS.mirrorGen]: gen });
      });

    const current = gen.keyring.vkId;
    const previous = new Set(gen.keyring.previous.map((p) => p.vkId));
    let rewritten = 0;
    let dropped = 0;
    let kept = 0;
    const processKv = async (kv: KV): Promise<void> => {
      let idx = await this.readIndexStrict(kv);
      const o = await this.orphans(kv, idx);
      const remove = [...o.remove];
      if (o.idx) idx = o.idx;
      const keep: SnapshotMeta[] = [];
      for (const m of idx) {
        const key = KEYS.snap(m.id);
        const raw = (await kv.get([key]))[key];
        if (isNewerRecord(raw)) {
          keep.push(m);
          continue;
        }
        const rec = await checkSnapshot(raw);
        if (!rec) {
          remove.push(key);
          dropped++;
          continue;
        }
        const vkId = rec.envelope.vkId;
        if (!opts.all && vkId === current) {
          keep.push(m);
          continue;
        }
        let env: EncryptedVault | null = null;
        try {
          env = await reencrypt(rec.envelope);
        } catch {
          env = null;
        }
        if (env && env.vkId === current && (await checkSnapshot({ ...rec, envelope: env }))) {
          await kv.set({ [key]: { ...rec, envelope: env } });
          keep.push(m);
          rewritten++;
        } else if (
          opts.unknownKey === "offer" &&
          vkId !== current &&
          !previous.has(vkId) &&
          rec.envelope.vaultId === gen.keyring.vaultId
        ) {
          keep.push(m); // this vault, under a key nobody here holds: its keyring may come back (see the top of this file)
          kept++;
        } else {
          remove.push(key);
          dropped++;
        }
      }
      await kv.set({ [KEYS.snapIndex]: keep });
      if (remove.length) await kv.remove(remove);
    };
    if (opts.primary) await processKv(this.kv);
    // The mirror is redundancy: if it cannot be written, the primary store is still correct and the next unlock retries.
    if (mirror) await inMirror("mirror snapshots", () => processKv(mirror));
    return { rewritten, dropped, kept, mirrorDone };
  }

  // ---- decrypt-level fallback ------------------------------------------------------------------

  /**
   * Open the vault with a key. If the active copy passes its checksum but does not decrypt or parse, fall back to
   * older copies and make the one that works the new active state. A newer schema is never "recovered" around: it stops
   * the fallback and is thrown, whatever copy it is found in, before anything is written (YUBIKEY-DESIGN §5.1 R1).
   * A copy under one of the keyring's previous keys (an old-key copy a key change has not reached yet) is a candidate
   * too (SYNC-DESIGN I3, §0.0i req. 2): it is opened with that key, re-encrypted to `vk` before it is written, and the
   * write is a key change (the marker), since the old-key copy it came from is still on disk.
   * A copy whose read throws is not passed over for an older one (GM2-7, SYNC-DESIGN §0.0i M2 req. 8; the rule P-4 set
   * for recover()): if it may be newer than the copy that opens, nothing is committed and the read's error goes to the
   * caller, so the page offers Retry. A local index that cannot be read may hide anything (counts as newer than all). The
   * mirror (IndexedDB) cannot hide a save newer than the active slot: its generation is written after the local commit,
   * with the same counter, so an unreadable mirror source of unknown age counts as the active slot's save (A4R-3).
   * Otherwise an IndexedDB that always fails ("Internal error opening backing store") would make every open throw,
   * although the local copy of the very same save opens. Copies of another vault (re-encrypted to this key for "find
   * accounts", §3.5 D9) are never a fallback for this one. The write is a recovery write (the hook runs first), and it is
   * refused if the active copy changed since it was read (another page saved meanwhile: open again).
   */
  async openVault(vk: Vk, known?: Generation): Promise<{ vault: Vault; gen: Generation; recovered?: StorageEvent }> {
    // `known`: the generation the caller has just read (openView, unlock), so it is not read a second time.
    let active = known;
    if (!active) {
      const cur = await this.load();
      if (cur.status !== "ok") throw new StorageError("unreadable", cur.status);
      active = cur.gen;
    }
    const first = await this.tryOpen(active.envelope, vk);
    if (first.ok) return { vault: first.vault, gen: active };
    if (first.newerSchema) throw first.error;

    const [ga, gb] = await Promise.all([this.readSlot("a"), this.readSlot("b")]);
    // The newest save counter among the copies that could not be read (Infinity: unknown, so possibly newer than anything).
    let unread: { error: unknown; seq: number } | null = null;
    const skipped = (e: unknown, seq?: number, mirror = false) => {
      this.diag("fallback source unreadable", e);
      const at = seq ?? (mirror ? active.seq : Infinity);
      unread = { error: unread?.error ?? e, seq: Math.max(unread?.seq ?? -Infinity, at) };
    };
    const cands: Candidate[] = [];
    for (const g of [ga, gb])
      if (g && g.seq !== active.seq)
        cands.push({
          source: `slot (seq ${g.seq})`,
          kind: "slot",
          at: g.savedAt,
          seq: g.seq,
          envelope: g.envelope,
          keyring: g.keyring,
        });
    cands.push(...(await this.snapshotCandidates(skipped)));
    if (this.mirror) {
      const m = await this.readMirrorGen((e) => skipped(e, undefined, true));
      if (m)
        cands.push({
          source: "mirror",
          kind: "mirror",
          at: m.savedAt,
          seq: m.seq,
          envelope: m.envelope,
          keyring: m.keyring,
        });
    }
    cands.sort(bySeq);
    const failed = active;
    // The keys that open a candidate: the current one, and the previous ones the keyring really unwraps (I3).
    const keys = [vk, ...(failed.keyring.vkId === vk.id ? await unwrapPreviousVks(failed.keyring, vk) : [])];
    for (const c of cands) {
      if (c.envelope.checksum === failed.envelope.checksum) continue;
      if (c.envelope.vaultId !== failed.keyring.vaultId) continue;
      const key = keys.find((k) => k.id === c.envelope.vkId);
      if (!key) continue; // under a key this keyring does not open
      const r = await this.tryOpen(c.envelope, key);
      if (r.ok) {
        const u = unread as { error: unknown; seq: number } | null;
        if (u && u.seq > c.seq) throw u.error;
        const oldKey = key.id !== vk.id;
        // Under a previous key: the same plaintext, re-encrypted to the current key (a generation's envelope and keyring
        // must agree, I1), keeping its vault id and revision.
        const envelope = oldKey
          ? await encryptVault(r.plain, vk, { vaultId: c.envelope.vaultId, rev: c.envelope.rev }, randomBytes)
          : c.envelope;
        const gen = await this.lock(() =>
          this.write(
            async (p) => {
              if (p && p.envelope.checksum !== failed.envelope.checksum) throw new StorageError("unreadable"); // changed meanwhile: open again
              return { envelope, keyring: p?.keyring ?? failed.keyring };
            },
            { keyChange: oldKey },
            true,
          ),
        );
        const recovered = await this.lock(() =>
          this.pushEvent("decrypt_fallback", c.at, `active copy did not open; restored from ${c.source}`),
        );
        return { vault: r.vault, gen, recovered };
      }
      if (r.newerSchema) throw r.error;
    }
    throw new StorageError("unreadable", "no stored copy could be opened");
  }

  private async tryOpen(
    env: EncryptedVault,
    vk: Vk,
  ): Promise<{ ok: true; vault: Vault; plain: Uint8Array } | { ok: false; newerSchema: boolean; error: Error }> {
    if (env.vkId !== vk.id)
      return { ok: false, newerSchema: false, error: new CryptoError("decrypt_failed", "different key") };
    try {
      const plain = await decryptVault(env, vk);
      return { ok: true, vault: deserializeVault(plain), plain };
    } catch (e) {
      return { ok: false, newerSchema: e instanceof VaultError && e.code === "newer_schema", error: e as Error };
    }
  }

  // ---- events --------------------------------------------------------------------------------

  private async pushEvent(kind: StorageEventKind, restoredTo: number, detail: string): Promise<StorageEvent> {
    const events = await this.readEvents();
    const at = this.now();
    const ev: StorageEvent = { id: `${at}-${events.length}-${kind}`, kind, at, restoredTo, detail };
    events.push(ev);
    await this.kv.set({ [KEYS.events]: events.slice(-RETENTION.events) });
    return ev;
  }

  private async readEvents(): Promise<StorageEvent[]> {
    try {
      return parseEvents((await this.kv.get([KEYS.events]))[KEYS.events]);
    } catch {
      return [];
    }
  }

  /** Recoveries the user has not acknowledged yet. */
  listEvents(): Promise<StorageEvent[]> {
    return this.readEvents();
  }

  ackEvents(ids?: string[]): Promise<void> {
    return this.lock(async () => {
      const left = ids ? (await this.readEvents()).filter((e) => !ids.includes(e.id)) : [];
      await this.kv.set({ [KEYS.events]: left });
    });
  }
}
