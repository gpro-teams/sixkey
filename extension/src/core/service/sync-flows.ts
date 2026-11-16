// The service's sync half (SYNC-DESIGN M2): merging a remote vault in (applyRemote, §4.6), committing keys after a sync key
// operation (§3.6-§3.9, §4.13), joining another device's vault (§3.5), restoring the device identity (§2.5), turning sync
// off (D11). Storage and keys only, no network: the engine (M3) fetches outside the vault lock and calls these. Keys are
// committed only as capabilities M1 issued (§0.0i item 16), and the pins catch up with every commit (item 17, pins.ts).
// SyncFlows is built on a VaultService and the whole local side (SyncLocal) by the contexts that sync (the service worker
// and the settings page, M5); the popup never imports it, so it carries none of this (PHASE0X-PLAN §0.2 rule 5).
// Everything goes through the service's own steps (accessOf, below): requireVk, the transact, committed() (the
// security record, the session, the one cleanup entry point).
import { sha256, toB64, utf8, type Random } from "../crypto/bytes";
import { decryptVault, encryptVault } from "../crypto/envelope";
import { openWithPassword, setRecovery, unwrapPreviousVks, type Keyring } from "../crypto/keyring";
import type { Vk } from "../crypto/vk";
import type { Generation, SnapshotMeta } from "../storage/format";
import type { TransactOptions, VaultStore } from "../storage/store";
import { previousCovers } from "../sync/crypto/adoption";
import { realPrevious, type Adoption } from "../sync/crypto/bundle-eval";
import { keysOf } from "../sync/crypto/capability";
import { adoptedRecord, sameWrap, truncateKeyringTimes, wrapOf, type KeyBundle } from "../sync/crypto/keybundle";
import type { Published } from "../sync/crypto/presend";
import { blocks, guardMerge, type GuardReport } from "../sync/local/guard";
import type { Pins } from "../sync/local/identity";
import { pendingFor, type JoinAdded, type PendingPins, type PinsView } from "../sync/local/pins";
import type { CfgPlain } from "../sync/local/records";
import type { SyncContext } from "../sync/local/state";
import { createClock, type Clock } from "../vault/hlc";
import { canonicalJson, mergeVaults } from "../vault/merge";
import { isAlive, isPurged, type Entry, type Vault } from "../vault/model";
import {
  addAccountsFrom,
  addedModeKey,
  addEntry,
  clampVault,
  deleteEntry,
  editEntry,
  observeVault,
  restoreEntry,
} from "../vault/ops";
import { deserializeVault, LIMITS, parseVault, serializeVault } from "../vault/validate";
import type { SecurityKind } from "./security-log";
import { ServiceError } from "./service-error";
import type { SyncPort, VaultService } from "./service";
import type { SettingsStore } from "./types";

/** What the flows need of sync's local side beyond the service's port: SyncLocal (core/sync/local/sync-local.ts). */
export type SyncLocalPort = SyncPort & {
  pins: {
    /** `joinAdded`: a join's record for the dedupe (null clears one), in the same write (pins.ts begin). */
    begin(p: PendingPins, o?: { joinAdded?: JoinAdded | null }): Promise<void>;
    commit(p: Pins): Promise<boolean>;
    view(active: Keyring | null): Promise<PinsView>;
  };
  cfg: { writeInLock(vk: Vk, vaultId: string, c: CfgPlain): Promise<void> };
  prejoin: {
    fits(plainLength: number): Promise<boolean>;
    writeInLock(cloudVk: Vk, plain: Uint8Array, vaultId: string, at: number): Promise<void>;
  };
  restoreIdentity(vk: Vk, keyring: Keyring, o: { held?: readonly Vk[]; maxSeenVersion?: number }): Promise<unknown>;
  /** `folded` (M3 revision 5, R4R-1): the orphan entries the calling flow folded first; every other entry is kept. */
  turnOff(o?: { folded?: readonly { checksum: string; envelope: string }[] }): Promise<void>;
};

/** What the flows may use of the service: its own steps, not a second copy of them (accessOf, below). */
export type FlowAccess = {
  store: VaultStore;
  settings: SettingsStore;
  sync: SyncPort | undefined; // the service's own port (the size check and clock offset read through it)
  rng: Random;
  now: () => number;
  diag: (message: string, err?: unknown) => void;
  requireVk(keyring: Keyring): Promise<Vk>;
  syncContext(): Promise<SyncContext | null>;
  refNow(sync: SyncContext | null): number;
  committed(
    kind: SecurityKind | null,
    vk: Vk,
    o: { held?: readonly Vk[]; session?: boolean; epoch?: number; typed?: true },
  ): Promise<void>;
  record(kind: SecurityKind): Promise<void>;
  /** The lock epoch now (every lock bumps it, platform/session.ts). */
  lockEpoch(): Promise<number>;
  /** The service's own local edit (VaultService.mutate: the open-vault check, the size check with sync on, the outbox). */
  mutate(fn: (vault: Vault, clock: Clock, now: number) => Vault | Promise<Vault>): Promise<Vault>;
};

/**
 * A merge the guard stops (§4.4): nothing was committed and nothing of the remote is kept. `report` says what it would do;
 * `seen` binds each blocking id to the remote's version of that entry (a SHA-256, never its content), for the answer.
 */
export class MergeBlocked extends ServiceError {
  constructor(
    readonly report: GuardReport,
    readonly seen: Readonly<Record<string, string>>,
  ) {
    super("review_needed");
    this.name = "MergeBlocked";
  }
}

/** What applyRemote did (§4.2 step 5): the envelope checksum c of the generation that is current afterwards. */
export type ApplyRemoteResult = { changed: boolean; checksum: string; vault: Vault; guard: GuardReport };

/**
 * The user's answer to a merge the guard stopped (§4.4): `accept` the ids it reported (Apply), or keep this device's
 * version of them (`keepMine`: their content and their life, alive or in the trash, re-declared with new timestamps, so
 * they win everywhere). `seen` is the MergeBlocked's the user reviewed: the answer holds only for those very remote
 * versions (M2R-11), so a remote that changed one of them between that pull and the re-pull of [Apply] stops the merge
 * again. Ids the guard reports that neither lists still stop it.
 */
export type MergeAnswer = {
  seen: Readonly<Record<string, string>>;
  accept?: readonly string[];
  keepMine?: readonly string[];
};

/**
 * A local key commit after a sync key operation (SYNC-DESIGN §3.6 step 3, §3.7, §3.8 P4, §3.9 R2/R3/R6, §4.2's repair,
 * §4.13): the keyring of the bundle `keys` carries becomes this device's, in ONE transact with the data under its key
 * (I1). The data is opened with the key it is under (the bundle's VK, or for R3 the local VK its previous list really
 * unwraps), merged with `remote` if given (R3: the remote data of the new key), or, `overLost`, is `remote` itself
 * replacing lost local data (the cloud restore).
 */
export type KeyCommit = {
  /**
   * The keys, only as M1 issued them (§0.0i item 16): an Adoption (evaluateSameVkBundle's or unlockWithSync's `adopt`
   * verdict, the object itself) or a Published (presend.ts published(), once the server accepted). They carry the
   * bundle, its VK, the old VKs the cleanup needs and maxSeenKver.
   */
  keys: Adoption | Published;
  remote?: Vault;
  overLost?: boolean;
  /** A guard answer for the merge with `remote`. */
  answer?: MergeAnswer;
  /** The security record's entry (keys_adopted for an adoption; a published change records its own kind). */
  record?: SecurityKind;
  /**
   * The lock epoch the caller read just before it found the vault open (a key operation of this device): the session
   * the commit starts carries it, so a lock since voids that session and the page stays locked. Without it (an adoption,
   * which may unlock a locked page with the secret just typed), the session takes the epoch of the moment.
   */
  epoch?: number;
  /**
   * A key operation of this page, its secret just typed here (the engine's commitPublished: a new master password, a
   * new recovery code, a reset, a rotation, a repair): it opens the PIN after a restart's "the PIN alone turns it back
   * on" window, as the same change does with sync off (VaultService.committed `typed`, rotated.ts; review r2,
   * PINR-R2-03). Never an adoption (keys_adopted, in a background round or with a secret typed for keys changed
   * elsewhere), a join or a restore.
   */
  typed?: true;
};

/**
 * Joining another device's vault, the local half (SYNC-DESIGN §3.5; M3 has verified `bundle` and decrypted `remote` with
 * `vk`; on the approval path, `vk` came from a payload that opened under the key holding the pairing code). `device` is
 * what sk_sync_cfg keeps (§2.5), written under `vk` in the same step.
 */
/**
 * `refNow` (M3): the server-corrected time the enrolment learned (§4.14). A join runs with sync off, so no offset is
 * stored yet; without it the merge's clamp and the added mode's stamps would use this machine's uncorrected clock.
 */
export type JoinInput = {
  bundle: KeyBundle;
  vk: Vk;
  remote: Vault;
  device: CfgPlain;
  confirmLost?: boolean;
  answer?: MergeAnswer;
  refNow?: number;
  /**
   * The approval join (§3.5, revision 24): `remote` is the synced vault without its accounts (they arrive with the first
   * round), so the added mode cannot skip the accounts both sides have. The ids it adds are recorded in the commit's
   * own write, and the first round that goes through moves those that turn out to be duplicates to the trash.
   */
  dedupeAfterFirstRound?: boolean;
  /**
   * The record of an earlier approval join of this profile that did not finish (its local half undone before this join,
   * enroll.ts requireOff): kept when this join is the merged one into that same vault, so its dedupe still runs (the
   * copies it names are in this profile's vault).
   */
  carriedJoinAdded?: JoinAdded;
};
/**
 * A join prepared in memory, nothing written: what it will do, for the confirmation (§3.5 ③). `mode`: "empty" (no local
 * vault), "lost" (replaces unreadable remains; needs confirmLost), "merged" (the same vault under related keys: an
 * ordinary merge), "added" (another vault, or the same vault id under unrelated keys, C6-8: this device's live accounts
 * added to the cloud's with new ids; `skipped` were already there; the local vault is kept on sk_prejoin's list).
 */
export type PreparedJoin = Readonly<{ mode: "empty" | "lost" | "merged" | "added"; added: number; skipped: number }>;
type JoinPlan = {
  input: JoinInput;
  result: Vault;
  base: string | null;
  baseKeyring: Keyring | null;
  baseOurs: boolean;
  localVk: Vk | null;
  prejoin: { plain: Uint8Array; vaultId: string } | null;
  /** The added mode: the ids of the entries this join adds to the cloud's vault (for the approval join's dedupe). */
  addedIds: string[];
};
const preparedJoins = new WeakMap<PreparedJoin, JoinPlan>();

/** Thrown inside the lock by applyRemote when the merge changes nothing: nothing is written at all. Never leaves it. */
const NO_CHANGE = new Error("no change");
/** Thrown inside the lock when the join already landed (a retry after a write that reported an error). */
const LANDED = new Error("landed");

/** Two keyrings are related when they share the VK, or one's previous list really opens the other's VK (§3.5, C6-8). */
async function keysRelated(a: Keyring, aVk: Vk, b: Keyring, bVk: Vk): Promise<boolean> {
  if (aVk.id === bVk.id) return true;
  if ((await unwrapPreviousVks(b, bVk)).some((k) => k.id === aVk.id)) return true;
  return (await unwrapPreviousVks(a, aVk)).some((k) => k.id === bVk.id);
}

/** An untrusted vault (from the server), rebuilt field by field. A newer schema stops here (newer_schema, R1). */
const untrusted = (v: Vault): Vault => parseVault(JSON.parse(canonicalJson(v)));

/** What the user saw of each blocking id: a SHA-256 of the remote's version of that entry, as it came (MergeBlocked.seen). */
async function seenOf(remote: Vault, ids: readonly string[]): Promise<Record<string, string>> {
  const theirs = new Map(remote.entries.map((e) => [e.id, e]));
  const out: Record<string, string> = {};
  for (const id of ids) out[id] = toB64(await sha256(utf8(canonicalJson(theirs.get(id) ?? null))));
  return out;
}

/**
 * Merge `remote` into `local` (both clamped to `refNow`, §4.2 step 4) and run the guard on the result (§4.4). Stops with
 * MergeBlocked unless every blocking id was answered, for the very remote version the user reviewed. `keepMine` ids come
 * out as this device had them, re-stamped.
 */
async function merged(
  a: FlowAccess,
  local: Vault,
  remote: Vault,
  refNow: number,
  answer?: MergeAnswer,
): Promise<{ vault: Vault; guard: GuardReport }> {
  if (remote.vaultId !== local.vaultId) throw new ServiceError("different_vault");
  const mine = clampVault(local, refNow);
  const theirs = clampVault(remote, refNow);
  let vault = mergeVaults(mine, theirs);
  const guard = guardMerge(mine, theirs, vault);
  if (blocks(guard)) {
    const ids = [...guard.secretChanged, ...guard.purgedAlive];
    const seen = await seenOf(remote, ids);
    const answered = new Set([...(answer?.accept ?? []), ...(answer?.keepMine ?? [])]);
    if (!ids.every((id) => answered.has(id) && answer?.seen[id] === seen[id])) throw new MergeBlocked(guard, seen);
  }
  const keep = answer?.keepMine ?? [];
  if (keep.length) {
    const clock = createClock(await a.settings.deviceId(), { now: () => refNow });
    observeVault(clock, vault);
    const own = new Map(mine.entries.map((e) => [e.id, e]));
    vault = {
      ...vault,
      entries: vault.entries.map((e) => {
        const o = own.get(e.id);
        if (!o || !keep.includes(e.id) || isPurged(o)) return e;
        // This device's content and life (alive, or in its trash), with new ticks so they win (§4.4 "keep mine"); the
        // merged placement and counter stay. Every content field is this device's, also ones added later (R3, M2R-17).
        const { group: _group, counter: _counter, ...content } = o;
        const hlc = clock.next();
        const kept: Entry = {
          ...content,
          id: e.id,
          createdAt: e.createdAt,
          hlc,
          order: e.order,
          phlc: e.phlc,
          deleted: !isAlive(o),
          dhlc: clock.next(),
        };
        if (e.counter !== undefined) kept.counter = e.counter;
        if (e.group !== undefined) kept.group = e.group;
        return kept;
      }),
    };
  }
  if (vault.entries.length > LIMITS.parsedEntries) throw new ServiceError("too_large"); // D7: never committed
  return { vault, guard };
}

async function applyRemote(a: FlowAccess, remote: Vault, answer?: MergeAnswer): Promise<ApplyRemoteResult> {
  const theirs = untrusted(remote);
  const sync = await a.syncContext();
  const refNow = a.refNow(sync);
  let out!: ApplyRemoteResult;
  let committed: { vk: Vk; vault: Vault } | null = null;
  try {
    await a.store.transact(
      async (cur) => {
        if (!cur) throw new ServiceError("bad_state", "no vault");
        const vk = await a.requireVk(cur.keyring);
        const local = deserializeVault(await decryptVault(cur.envelope, vk));
        const m = await merged(a, local, theirs, refNow, answer);
        if (canonicalJson(m.vault) === canonicalJson(local)) {
          out = { changed: false, checksum: cur.envelope.checksum, vault: local, guard: m.guard };
          throw NO_CHANGE;
        }
        const bytes = serializeVault(m.vault);
        deserializeVault(bytes);
        const envelope = await encryptVault(
          bytes,
          vk,
          { vaultId: cur.envelope.vaultId, rev: cur.envelope.rev + 1 },
          a.rng,
        );
        committed = { vk, vault: m.vault };
        out = { changed: true, checksum: envelope.checksum, vault: m.vault, guard: m.guard };
        return { envelope, keyring: cur.keyring };
      },
      { ensureCurrentSnapshot: true, ...outbox(a, sync, () => committed) },
    );
  } catch (e) {
    if (e !== NO_CHANGE) throw e;
  }
  return out;
}

/** transact's afterCommit for a commit of new data, when sync is on and the outbox writer is wired (M3), as mutate's. */
function outbox(
  a: FlowAccess,
  sync: SyncContext | null,
  committed: () => { vk: Vk; vault: Vault } | null,
): TransactOptions {
  const write = a.sync?.afterCommit;
  if (!sync || !write) return {};
  return {
    afterCommit: async (gen) => {
      const c = committed();
      if (c) await write({ gen, ...c });
    },
  };
}

/** The pins after a commit (inside the lock, after it): IndexedDB, then the pending copy cleared. The caller guards it. */
async function pin(a: FlowAccess, sync: SyncLocalPort, pins: Pins): Promise<void> {
  if (!(await sync.pins.commit(pins))) a.diag("no device identity to pin");
}

const discontinuous = () => new ServiceError("bad_state", "discontinuous");

/**
 * RR-1: M1 judged the keys against the local keyring `base` (its input; null with none, the cloud restore). They may be
 * committed only over that very keyring, or over their own (this commit, already landed: a retry). Anything committed
 * since makes them stale: refused (bad_state "stale"), nothing written, and M3 evaluates again. Checked after the other
 * checks, so a refusal those give keeps its reason.
 */
function stale(cur: Generation | null, base: Keyring | null, bundle: KeyBundle): boolean {
  const now = cur ? canonicalJson(cur.keyring) : null;
  return now !== (base ? canonicalJson(base) : null) && now !== canonicalJson(bundle.keyring);
}

/**
 * §0.0i item 16: the pins this commit must not go back past, as decisions see them inside the lock (pins.ts view): the
 * identity's (with a pending copy of the last commit laid over it), and a pending copy that cannot be settled yet (no
 * identity, or no readable keyring: the cloud restore). Their vault, and the stored keyring's, must be the bundle's; their
 * VK the bundle's or one its previous list really unwraps (F7: never led back to an old VK). A damaged identity is
 * refused: its pins cannot be read.
 */
function checkPins(view: PinsView, cur: Generation | null, bundle: KeyBundle, reach: ReadonlyMap<string, Vk>): void {
  if (view.identity === "damaged") throw discontinuous();
  const pins = [view.identity, view.action === "keep" ? view.pending : null].filter((p) => p !== null);
  if (
    (cur && cur.keyring.vaultId !== bundle.vaultId) ||
    pins.some((p) => p.vaultId !== null && p.vaultId !== bundle.vaultId)
  )
    throw new ServiceError("different_vault");
  if (pins.some((p) => p.vkId !== null && p.vkId !== bundle.keyring.vkId && !reach.has(p.vkId))) throw discontinuous();
}

async function commitKeys(a: FlowAccess, sync: SyncLocalPort, c: KeyCommit): Promise<void> {
  const k = keysOf(c.keys);
  if (!k) throw new ServiceError("bad_state", "keys not issued by M1 (an Adoption or a Published)");
  const { bundle, vk } = k;
  if (c.overLost && (!c.remote || k.basis !== "opened"))
    throw new ServiceError("bad_state", "a cloud restore needs the remote vault and keys the typed secret opened");
  const theirs = c.remote ? untrusted(c.remote) : null;
  const refNow = a.refNow(await a.syncContext());
  const pins: Pins = {
    vkId: bundle.keyring.vkId,
    vaultId: bundle.vaultId,
    maxSeenKver: k.maxSeenKver,
    adopted: await adoptedRecord(bundle),
  };
  const reach = new Map((await unwrapPreviousVks(bundle.keyring, vk)).map((v) => [v.id, v]));
  await a.store.transact(
    async (cur) => {
      let vault: Vault;
      let rev: number;
      const view = await sync.pins.view(cur?.keyring ?? null);
      checkPins(view, cur, bundle, reach);
      if (c.overLost) {
        if (cur) throw new ServiceError("bad_state", "a readable vault is here");
        if (theirs!.vaultId !== bundle.vaultId) throw new ServiceError("different_vault");
        if (stale(cur, k.base, bundle)) throw new ServiceError("bad_state", "stale"); // an adoption made over a local keyring
        vault = clampVault(theirs!, refNow);
        rev = 0;
      } else {
        if (!cur) throw new ServiceError("bad_state", "no vault");
        // Continuity with what is stored now (item 16): the same VK keeps every real previous entry; another VK's previous
        // list really unwraps the local VK (the data is under it) and keeps the rest but for the 64-entry cap.
        const sameVk = cur.keyring.vkId === vk.id;
        const localVk = sameVk ? vk : reach.get(cur.keyring.vkId);
        if (!localVk || !previousCovers(await realPrevious(cur.keyring, localVk), new Set(reach.keys()), sameVk))
          throw discontinuous();
        // The lock-out guard, where it rests on what is stored (capability.ts CommitBasis): the local password wrap is still
        // the bundle's; the bundle is still the one the pins say this device last committed.
        if (
          k.basis === "same_password_wrap" &&
          !sameWrap(wrapOf(cur.keyring, "password"), wrapOf(bundle.keyring, "password"))
        )
          throw discontinuous();
        if (
          k.basis === "adopted_back" &&
          (view.identity === null ||
            view.identity === "damaged" ||
            view.identity.adopted?.digest !== pins.adopted.digest)
        )
          throw discontinuous();
        if (stale(cur, k.base, bundle)) throw new ServiceError("bad_state", "stale");
        vault = deserializeVault(await decryptVault(cur.envelope, localVk));
        if (theirs) vault = (await merged(a, vault, theirs, refNow, c.answer)).vault;
        rev = cur.envelope.rev + 1;
      }
      const bytes = serializeVault(vault);
      deserializeVault(bytes);
      await sync.pins.begin(pendingFor(pins, view.stored)); // lastSynced and the outbox cleared, pendingPins written: one write, before the commit
      return {
        envelope: await encryptVault(bytes, vk, { vaultId: bundle.vaultId, rev }, a.rng),
        keyring: bundle.keyring,
      };
    },
    {
      overwriteLost: c.overLost === true,
      ...(c.overLost
        ? { event: { kind: "cloud_restore" as const, restoredTo: a.now(), detail: "restored from the cloud" } }
        : {}),
      afterCommit: () => pin(a, sync, pins),
    },
  );
  await a.committed(c.record ?? null, vk, {
    held: k.held,
    ...(c.epoch !== undefined ? { epoch: c.epoch } : {}),
    ...(c.typed ? { typed: true as const } : {}),
  });
}

async function prepareJoin(a: FlowAccess, sync: SyncLocalPort, j: JoinInput): Promise<PreparedJoin> {
  if (j.bundle.keyring.vkId !== j.vk.id || j.bundle.vaultId !== j.bundle.keyring.vaultId)
    throw new ServiceError("bad_state", "the key is not the bundle's");
  const theirs = untrusted(j.remote);
  if (theirs.vaultId !== j.bundle.vaultId) throw new ServiceError("different_vault");
  const refNow = j.refNow ?? a.refNow(await a.syncContext());
  const r = await a.store.load();
  let plan: JoinPlan;
  let handle: PreparedJoin;
  if (r.status !== "ok") {
    plan = {
      input: j,
      result: clampVault(theirs, refNow),
      base: null,
      baseKeyring: null,
      baseOurs: false,
      localVk: null,
      prejoin: null,
      addedIds: [],
    };
    handle = Object.freeze({ mode: r.status, added: 0, skipped: 0 });
  } else {
    const localVk = await a.requireVk(r.gen.keyring);
    const plain = await decryptVault(r.gen.envelope, localVk);
    const local = deserializeVault(plain);
    const base = canonicalJson({ checksum: r.gen.envelope.checksum, keyring: r.gen.keyring });
    const baseOurs = canonicalJson(r.gen.keyring) === canonicalJson(j.bundle.keyring); // a rejoin: the cloud keyring is here already
    if (local.vaultId === theirs.vaultId && (await keysRelated(r.gen.keyring, localVk, j.bundle.keyring, j.vk))) {
      plan = {
        input: j,
        result: (await merged(a, local, theirs, refNow, j.answer)).vault,
        base,
        baseKeyring: r.gen.keyring,
        baseOurs,
        localVk,
        prejoin: null,
        addedIds: [],
      };
      handle = Object.freeze({ mode: "merged", added: 0, skipped: 0 });
    } else {
      if (!(await sync.prejoin.fits(plain.length))) throw new ServiceError("kept_full"); // nothing on the list is dropped for room
      const clock = createClock(await a.settings.deviceId(), { now: () => refNow });
      const cloud = clampVault(theirs, refNow);
      observeVault(clock, cloud);
      const added = addAccountsFrom(cloud, local, clock, "alive");
      const alive = new Set(added.vault.entries.filter(isAlive).map(addedModeKey));
      if (!local.entries.filter(isAlive).every((e) => alive.has(addedModeKey(e))))
        throw new ServiceError("bad_state", "a local account would not survive the join");
      const cloudIds = new Set(cloud.entries.map((e) => e.id));
      plan = {
        input: j,
        result: added.vault,
        base,
        baseKeyring: r.gen.keyring,
        baseOurs,
        localVk,
        prejoin: { plain, vaultId: local.vaultId },
        addedIds: added.vault.entries.filter((e) => !cloudIds.has(e.id)).map((e) => e.id),
      };
      handle = Object.freeze({ mode: "added", added: added.added, skipped: added.skipped });
    }
  }
  preparedJoins.set(handle, plan);
  return handle;
}

async function commitJoin(a: FlowAccess, sync: SyncLocalPort, prepared: PreparedJoin): Promise<void> {
  const p = preparedJoins.get(prepared);
  if (!p) throw new ServiceError("bad_state", "join already done or not from prepareJoin");
  const { bundle, vk } = p.input;
  if (prepared.mode === "lost" && !p.input.confirmLost)
    throw new ServiceError("bad_state", "replacing unreadable data needs the user's confirmation");
  // A join prepared with this device's vault open is committed only while it still is, under the same key (requireVk: a
  // lock since then throws locked). The commit ends in a session under the cloud key, which would otherwise open a page
  // that locked meanwhile without the master password. Checked before the lock (a retry whose first attempt landed
  // included) and again inside it; the session it starts carries the lock epoch read just before the last check, so a
  // lock after that check (during the write, the pins, the security record) voids the new session at once.
  let epoch = await a.lockEpoch();
  const stillOpen = async (keyring: Keyring) => {
    if ((await a.requireVk(keyring)).id !== p.localVk?.id)
      throw new ServiceError("bad_state", "this device's key changed meanwhile");
  };
  if (p.localVk && p.baseKeyring) await stillOpen(p.baseKeyring);
  const pins: Pins = {
    vkId: bundle.keyring.vkId,
    vaultId: bundle.vaultId,
    maxSeenKver: bundle.kver,
    adopted: await adoptedRecord(bundle),
  };
  const ours = (g: Generation) => canonicalJson(g.keyring) === canonicalJson(bundle.keyring);
  try {
    await a.store.transact(
      async (cur) => {
        // This very join, written by an attempt that reported an error (not a profile that held the cloud keyring before
        // it): its pins, here inside the lock like every other pin write (M2R-9), then done.
        if (cur && ours(cur) && !p.baseOurs) {
          try {
            await pin(a, sync, pins);
          } catch (err) {
            a.diag("pins not written", err);
          }
          throw LANDED;
        }
        if (
          p.base === null
            ? cur !== null
            : !cur || canonicalJson({ checksum: cur.envelope.checksum, keyring: cur.keyring }) !== p.base
        )
          throw new ServiceError("bad_state", "this device's vault changed meanwhile");
        if (p.localVk && cur) {
          epoch = await a.lockEpoch();
          await stillOpen(cur.keyring);
        }
        // The pins go into this profile's device identity: it must be the joining device's, pinned to no other vault (a
        // new device's has no pins yet, §3.2), or the join would mix two enrolments.
        // There must be one (the enrolment made it, §3.2): a join after "turn sync off" removed it is refused (RR-3).
        const view = await sync.pins.view(cur?.keyring ?? null);
        const id = view.identity;
        if (
          id === null ||
          id === "damaged" ||
          id.deviceId !== p.input.device.deviceId ||
          (id.vaultId !== null && id.vaultId !== bundle.vaultId)
        )
          throw new ServiceError("bad_state", "the device identity is not the joining device's");
        if (p.prejoin) await sync.prejoin.writeInLock(vk, p.prejoin.plain, p.prejoin.vaultId, a.now());
        await sync.cfg.writeInLock(vk, bundle.vaultId, p.input.device);
        // lastSynced cleared, pendingPins written and the approval join's record for its dedupe (its own; an unfinished
        // earlier join's, carried, when this is the merged join into that vault; or none), in one write, before the commit
        const carried = p.input.carriedJoinAdded;
        const joinAdded =
          p.input.dedupeAfterFirstRound && p.addedIds.length
            ? { vaultId: bundle.vaultId, ids: p.addedIds, at: a.now() }
            : prepared.mode === "merged" && carried?.vaultId === bundle.vaultId
              ? carried
              : null;
        await sync.pins.begin(pendingFor(pins, view.stored, p.input.device.deviceId), { joinAdded });
        const envelope = await encryptVault(
          serializeVault(p.result),
          vk,
          { vaultId: bundle.vaultId, rev: cur ? cur.envelope.rev + 1 : 0 },
          a.rng,
        );
        return { envelope, keyring: bundle.keyring };
      },
      { overwriteLost: prepared.mode === "lost", afterCommit: () => pin(a, sync, pins) },
    );
  } catch (e) {
    if (e !== LANDED) throw e;
  }
  preparedJoins.delete(prepared);
  await a.committed("sync_on", vk, { held: p.localVk ? [p.localVk] : [], ...(p.localVk ? { epoch } : {}) });
}

// ---- local edits a sync flow makes: the approval join's dedupe (§3.5) and "find accounts" (§6 O13) ----------------------

/**
 * §3.5 (revision 24), the dedupe's twin rule: `twin` is the same account as `copy`, and `copy` is the one that goes. The
 * same secret, issuer and label (addedModeKey, the added mode's rule), and the same OTP parameters (type, algorithm,
 * digits, period): a copy whose codes differ is not a duplicate, it stays. For HOTP the copy goes only when the twin's
 * counter is not behind it (the counter that stays never goes back). And the twin comes first in an order every device
 * computes alike, (createdAt, id): two profiles that joined with the same account each see the other's copy outside
 * their own record, and without the order each would trash its own, leaving no live copy anywhere. createdAt is the
 * entry's own (never clamped; a merge keeps the smaller), so the order converges.
 */
export function isTwinOf(twin: Entry, copy: Entry): boolean {
  const key = addedModeKey(copy);
  if (key === null || addedModeKey(twin) !== key) return false;
  if (twin.type !== copy.type || twin.algorithm !== copy.algorithm) return false;
  if (twin.digits !== copy.digits || twin.period !== copy.period) return false;
  if (copy.type === "hotp" && (twin.counter ?? 0) < (copy.counter ?? 0)) return false;
  return twin.createdAt < copy.createdAt || (twin.createdAt === copy.createdAt && twin.id < copy.id);
}

/**
 * §3.5 (revision 24): after the first round of an approval join that went through, the accounts the join added (`ids`)
 * that the synced vault turned out to hold already, moved to the trash (never erased) in one local edit. A join-added
 * entry goes only when a live entry the join did NOT add is its twin (isTwinOf), so two equal accounts the join itself
 * brought never take each other along, and every account keeps a live copy. Decided inside the edit, against the vault
 * as it is then (an account changed since is no longer a match). Returns how many went; none writes nothing.
 */
async function trashJoinDuplicates(a: FlowAccess, vaultId: string, ids: readonly string[]): Promise<number> {
  let n = 0;
  await a.mutate((v, clock) => {
    n = 0;
    if (v.vaultId !== vaultId) return v;
    const added = new Set(ids);
    const others = v.entries.filter((e) => isAlive(e) && !added.has(e.id));
    let out = v;
    for (const e of v.entries) {
      if (!added.has(e.id) || !isAlive(e)) continue;
      if (!others.some((t) => isTwinOf(t, e))) continue;
      out = deleteEntry(out, e.id, clock);
      n++;
    }
    return out;
  });
  return n;
}

/**
 * §6 O13 "find accounts": the accounts the user chose from an earlier version (`chosen`: that version's entries), brought
 * back in one local edit. Each is checked again inside it, against the vault as it is then: one alive here already, by
 * its identity, issuer and label, or by its id in the same vault, is left as it is.
 *   - The same vault, the entry in the trash here: declared again with new ticks (§4.6), back from the trash with the
 *     version's names and settings. Its secret and type are the entry's own (no edit changes them), and its HOTP counter
 *     stays this device's (a counter never goes back).
 *   - Erased here (nothing brings an erased entry back, vault/model.ts), not here at all, or of another vault (an old
 *     vault's snapshot kept from before a join, §3.5 ⑥): a new entry with the version's content (the added mode).
 * Returns how many came back.
 */
async function recoverAccounts(a: FlowAccess, chosen: readonly Entry[], o: { sameVault: boolean }): Promise<number> {
  let n = 0;
  await a.mutate((v, clock, now) => {
    n = 0;
    let out = v;
    for (const s of chosen) {
      const key = addedModeKey(s);
      if (!isAlive(s) || key === null || out.entries.some((e) => isAlive(e) && addedModeKey(e) === key)) continue;
      const here = o.sameVault ? out.entries.find((e) => e.id === s.id) : undefined;
      if (here && isAlive(here)) continue;
      if (here && !isPurged(here)) {
        out = restoreEntry(out, here.id, clock);
        out = editEntry(
          out,
          here.id,
          {
            issuer: s.issuer,
            label: s.label,
            algorithm: s.algorithm,
            digits: s.digits,
            period: s.period,
            domains: s.domains, // undefined: none, as in that version
          },
          clock,
        );
      } else {
        const { type, issuer, label, secret, algorithm, digits, period, counter, group, domains } = s;
        out = addEntry(
          out,
          {
            type,
            issuer,
            label,
            secret,
            algorithm,
            digits,
            period,
            ...(counter !== undefined ? { counter } : {}),
            ...(group ? { group } : {}),
            ...(domains ? { domains } : {}),
          },
          clock,
          { now: () => now },
        ).vault;
      }
      n++;
    }
    return out;
  });
  return n;
}

// ---- M3: what the engine reads per round, and §3.1's local steps before the first upload ----------------------------

/** The vault as it is now, opened with the session key (requireVk: never cached, §4.6), for one round (§4.2 step 4). */
export type CurrentVault = { gen: Generation; vk: Vk; vault: Vault };

async function current(a: FlowAccess): Promise<CurrentVault> {
  const r = await a.store.load();
  if (r.status !== "ok") throw new ServiceError("bad_state", r.status);
  const vk = await a.requireVk(r.gen.keyring);
  return { gen: r.gen, vk, vault: deserializeVault(await decryptVault(r.gen.envelope, vk)) };
}

/** §3.1 step 4 and the truncation are Phase 0-level writes made before sync is on; with sync on they are refused (item 18). */
async function noSync(a: FlowAccess): Promise<void> {
  if (await a.syncContext()) throw new ServiceError("sync_on");
}

/**
 * §3.1 step 4, §2.3 T1 (revision 13, RR-12): before the first upload, every createdAt of the local keyring floored to the
 * hour in one transact, so the keyring sent with init is the local one byte for byte. Nothing is written when it is
 * aligned already. It changes the keyring, so the store writes the marker and the one cleanup entry point runs after it.
 * Refused with sync_on once sk_sync_cfg exists (§0.0i item 18), checked inside the transact.
 */
async function truncateForUpload(a: FlowAccess): Promise<boolean> {
  let vk: Vk | null = null;
  try {
    await a.store.transact(async (cur) => {
      await noSync(a);
      if (!cur) throw new ServiceError("bad_state", "no vault");
      vk = await a.requireVk(cur.keyring);
      const keyring = truncateKeyringTimes(cur.keyring);
      if (canonicalJson(keyring) === canonicalJson(cur.keyring)) throw NO_CHANGE;
      return { envelope: cur.envelope, keyring };
    });
  } catch (e) {
    if (e !== NO_CHANGE) throw e;
    return false;
  }
  await a.committed(null, vk!, { held: [], session: false });
  return true;
}

/** §3.1 step 4 (b): a new recovery code shown before it is written (§0.0i item 14). Opaque; one use. */
export type PreparedRecovery = { readonly recoveryCode: string };
const preparedRecoveries = new WeakMap<PreparedRecovery, { base: string; keyring: Keyring; vk: Vk }>();

/**
 * §3.1 step 4 (b), step one: the master password opens the local keyring (it is asked for at step 1 anyway, and a code is
 * as strong as the password, C6-1), and a new recovery wrap is made in memory, with its time floored to the hour and the
 * whole keyring truncated (so the truncation after it writes nothing). Nothing is written. With sync on: sync_on.
 */
async function prepareUploadRecovery(a: FlowAccess, password: string): Promise<PreparedRecovery> {
  await noSync(a);
  const r = await a.store.load();
  if (r.status !== "ok") throw new ServiceError("bad_state", r.status);
  const vk = await a.requireVk(r.gen.keyring);
  try {
    // as typed or its generator spelling, as service.verifyPassword took it at step 2 (openWithPassword)
    if ((await openWithPassword(r.gen.keyring, password)).vk.id !== vk.id) throw new ServiceError("wrong_secret");
  } catch (e) {
    if (e instanceof ServiceError) throw e;
    await a.record("unlock_failed");
    throw new ServiceError("wrong_secret");
  }
  const hour = Math.floor(a.now() / 3_600_000) * 3_600_000;
  const { keyring, recoveryCode } = await setRecovery(r.gen.keyring, vk, { now: () => hour, rng: a.rng });
  const handle: PreparedRecovery = Object.freeze({ recoveryCode });
  preparedRecoveries.set(handle, { base: canonicalJson(r.gen.keyring), keyring: truncateKeyringTimes(keyring), vk });
  return handle;
}

/**
 * Step two, once the user confirmed the code is saved: one transact, refused if the keyring changed since step one
 * (bad_state), sync is on (sync_on), or the vault locked since step one (locked). A retry after a write that landed and
 * reported an error counts as done.
 */
async function commitUploadRecovery(a: FlowAccess, handle: PreparedRecovery): Promise<void> {
  const p = preparedRecoveries.get(handle);
  if (!p) throw new ServiceError("bad_state", "already used or not from prepareUploadRecovery");
  const mine = canonicalJson(p.keyring);
  try {
    await a.store.transact(async (cur) => {
      if (cur && canonicalJson(cur.keyring) === mine) throw LANDED;
      await noSync(a);
      if (!cur || canonicalJson(cur.keyring) !== p.base) throw new ServiceError("bad_state", "keys changed meanwhile");
      // still unlocked, under the key it was prepared with (requireVk: a lock since step one throws locked), so a code
      // left on the screen of a page that locked cannot be confirmed into force by whoever sits down next
      if ((await a.requireVk(cur.keyring)).id !== p.vk.id)
        throw new ServiceError("bad_state", "keys changed meanwhile");
      return { envelope: cur.envelope, keyring: p.keyring };
    });
  } catch (e) {
    if (e !== LANDED) throw e;
  }
  preparedRecoveries.delete(handle);
  // a new recovery code, the master password typed for it on this page: as newRecoveryCode with sync off (PINR-R2-03)
  await a.committed("recovery_code_new", p.vk, { held: [], session: false, typed: true });
}

async function restoreSyncIdentity(a: FlowAccess, sync: SyncLocalPort, o: { maxSeenVersion?: number }): Promise<void> {
  const r = await a.store.load();
  if (r.status !== "ok") throw new ServiceError("bad_state", r.status);
  const vk = await a.requireVk(r.gen.keyring);
  await sync.restoreIdentity(vk, r.gen.keyring, {
    held: await unwrapPreviousVks(r.gen.keyring, vk),
    ...(o.maxSeenVersion !== undefined ? { maxSeenVersion: o.maxSeenVersion } : {}),
  });
  await a.record("identity_restored");
}

async function turnOffSync(
  a: FlowAccess,
  sync: SyncLocalPort,
  o?: { folded?: readonly { checksum: string; envelope: string }[] },
): Promise<void> {
  await sync.turnOff(o);
  await a.record("sync_off");
}

/**
 * The service's own steps, taken from the service itself (its private members, by element access, which TypeScript
 * allows for exactly this): the flows reuse requireVk, the transact, committed() and the security record instead of a
 * second copy of them, and the service has no extra public method for them (nor bytes in the popup's bundle).
 * test/unit/m2-source-rules.test.ts allows this access in this file only.
 */
function accessOf(s: VaultService): FlowAccess {
  return {
    store: s["store"],
    settings: s["settings"],
    sync: s["sync"],
    rng: s["rng"],
    now: s["now"],
    diag: s["diag"],
    requireVk: (k) => s["requireVk"](k),
    syncContext: async () => (s["sync"] ? s["sync"].context() : null),
    refNow: (c) => s["now"]() + (c?.offsetMs ?? 0), // §4.14: the server-corrected time with sync on
    committed: (kind, vk, o) => s["committed"](kind, vk, o),
    record: (kind) => s["record"](kind),
    lockEpoch: () => s["session"].lockEpoch(),
    mutate: (fn) => s.mutate(fn),
  };
}

/** The service's sync half: build it on the one VaultService of a context and that context's SyncLocal. */
export class SyncFlows {
  private readonly a: FlowAccess;
  constructor(
    service: VaultService,
    private readonly local: SyncLocalPort,
  ) {
    this.a = accessOf(service);
  }

  /**
   * Bring the remote vault's changes in (SYNC-DESIGN §4.2 step 5, §4.6). In one transact: the current generation is read
   * again, decrypted with the session key (requireVk: locked meanwhile fails, and nothing of the remote is kept), both
   * sides clamped and merged, the guard run again (MergeBlocked unless `answer` covers it), and the result written as the
   * next generation (rev+1) under the same key and keyring, with the state it replaces kept as the newest rolling
   * snapshot first (ensureCurrentSnapshot), and no key-change marker: nothing old is made (§0.0i item 2, revision 12;
   * the first open after it reads what any open reads). Never a replacement: data only ever
   * merges in. A merge that changes nothing writes nothing (I10) and returns the current checksum. A remote of another
   * vault is refused (I6: the join is §3.5), a newer schema on either side stops it (R1), and a merge past the parse limit
   * is not committed (D7). Over the size limit it is committed all the same (merged data is never dropped): the engine
   * stops uploading (too_large).
   */
  applyRemote(remote: Vault, answer?: MergeAnswer): Promise<ApplyRemoteResult> {
    return applyRemote(this.a, remote, answer);
  }

  /**
   * A key commit after a sync key operation (KeyCommit), only with keys M1 issued (§0.0i item 16: a hand-built or copied
   * object is refused with bad_state). In order (§2.5, I2, GM2-1):
   *   1. one transact. Inside it, against what is stored then, the checks that need no secret, any failure writing
   *      nothing (bad_state "discontinuous"): the pins (the identity's, settled; a pending copy) are this vault's and the
   *      bundle reaches their VK (F7); not a cloud restore: the same VK keeps every real previous entry, or the bundle's
   *      previous list really unwraps the local VK (whose data it opens) and keeps the rest but for the 64-entry cap; and
   *      the lock-out guard where it rests on the stored state ("same_password_wrap": the local password wrap is still
   *      the bundle's; "adopted_back": the pins still name this bundle; "opened" and "built_here" were proven by M1);
   *      last, the stored keyring must be the one M1 judged the keys against (`base`), or theirs (a retry of this very
   *      commit, already landed): anything committed since makes them stale (bad_state "stale", RR-1; M3 evaluates
   *      again). The keys are M1's own frozen copy, taken when it issued them (RR-2). Then the data under the bundle's
   *      VK, the keyring `bundle.keyring` itself (byte for byte: canonicalJson is the store's measure of a key change,
   *      §0.0i req. 12), and before the commit, in one write, lastSynced and the outbox cleared (§4.1) and the pins
   *      written as pendingPins (item 17); the marker comes with the keyring change (or the lost data). A cloud restore
   *      (`overLost`) takes only keys the typed secret opened (unlockWithSync, local null);
   *   2. after the commit, in the same lock, the pins: vkId, vaultId, maxSeenKver (never lowered) and adopted (M1's
   *      adoptedRecord) in one IndexedDB write (§0.0f M2 req. 1-5), read back, then pendingPins cleared. Guarded: a
   *      failure is logged, and SyncLocal.settlePins() catches the pins up before the next decision;
   *   3. the security record, the session under the bundle's VK (a failure: "locked, enter the password"), then the
   *      cleanup through the one entry point, with the old VKs the keys carry (non-fatal; the marker finishes it).
   * Never the Phase 0 key-change methods: they commit locally first, and are refused while sync is on (sync_on, item 18).
   */
  commitKeys(c: KeyCommit): Promise<void> {
    return commitKeys(this.a, this.local, c);
  }

  /**
   * Step one of joining (§3.5): read this device's state and work out the result in memory, writing nothing. With a local
   * vault, the page must be unlocked (its key opens the local data). Same vault id and related keys: an ordinary merge
   * (with the guard; `answer` for a merge it stopped). Otherwise the added mode: the dedupe against the cloud's live
   * accounts and the check that every live local account is live in the result (②); a failure writes nothing. The local
   * vault is then kept on sk_prejoin's list beside any an earlier join kept (commitJoin).
   */
  prepareJoin(j: JoinInput): Promise<PreparedJoin> {
    return prepareJoin(this.a, this.local, j);
  }

  /**
   * Step two, once the user confirmed (§3.5 ③-⑥): one transact, refused if this device's vault changed since step one,
   * or if the profile's device identity is not the joining device's (or there is none: sync was turned off since,
   * RR-3), or is pinned to another vault. Inside it, before the commit: sk_prejoin (added mode: the local vault under the
   * cloud key, its own vault id, appended to the list and read back; nothing on the list replaced or dropped), sk_sync_cfg
   * under the cloud key ("pending"), lastSynced cleared and pendingPins written. Then the cloud keyring and the result. After it: the pins, sync_on, the
   * session, and the cleanup holding the local key in memory (⑥: the old vault's snapshots move to the cloud key and keep
   * their vault id, D9; a crash before it drops them, the data is in sk_prejoin, GM2-4). A retry with the same handle
   * after a write that landed and reported an error counts as done (as makeVault), its pins written inside the lock.
   * A join prepared with this device's vault open is refused with locked once the vault locked since step one.
   */
  commitJoin(prepared: PreparedJoin): Promise<void> {
    return commitJoin(this.a, this.local, prepared);
  }

  /**
   * M3: the vault as it is now and the session key it opens with (requireVk: a locked context throws locked, and nothing
   * is cached, §4.6), for one round. A vault that is not there throws bad_state with its status (empty, lost).
   */
  current(): Promise<CurrentVault> {
    return current(this.a);
  }

  /** M3: the active generation as stored (its keyring is plain: R3's unlock reads it while locked), or null with none. */
  async generation(): Promise<Generation | null> {
    const r = await this.a.store.load();
    return r.status === "ok" ? r.gen : null;
  }

  /** M3: whether this profile has a readable vault (ok), none (empty) or an unreadable one (lost): §2.5 cfg_missing. */
  async vaultStatus(): Promise<"ok" | "empty" | "lost"> {
    return (await this.a.store.load()).status;
  }

  /** M3: the session key for `keyring`, checked again just before an upload (requireVk; locked meanwhile throws). */
  unlockedKey(keyring: Keyring): Promise<Vk> {
    return this.a.requireVk(keyring);
  }

  /** M3, §3.8 P1 (§0.0i item 10): whether a key-change cleanup is still due (capPrevious must wait for it). */
  async cleanupDue(): Promise<boolean> {
    const r = await this.a.store.loadView();
    return r.status === "ok" && r.cleanup !== "none";
  }

  /** §3.1 step 4: the keyring's createdAt floored to the hour before the first upload (truncateForUpload above). */
  truncateForUpload(): Promise<boolean> {
    return truncateForUpload(this.a);
  }

  /** §3.1 step 4 (b), show before commit: prepareUploadRecovery, show the code, then commitUploadRecovery. */
  prepareUploadRecovery(password: string): Promise<PreparedRecovery> {
    return prepareUploadRecovery(this.a, password);
  }

  commitUploadRecovery(handle: PreparedRecovery): Promise<void> {
    return commitUploadRecovery(this.a, handle);
  }

  /** §2.5 identity_missing, once unlocked: rebuild the device identity from its copy (SyncLocal.restoreIdentity). */
  restoreSyncIdentity(o: { maxSeenVersion?: number } = {}): Promise<void> {
    return restoreSyncIdentity(this.a, this.local, o);
  }

  /** "Turn sync off", the local half (D11): the vault and sk_prejoin stay. */
  /** `folded`: the orphan entries the calling flow folded into the vault first (§4.7); every other entry stays (R4R-1). */
  turnOffSync(o?: { folded?: readonly { checksum: string; envelope: string }[] }): Promise<void> {
    return turnOffSync(this.a, this.local, o);
  }

  /** The lock epoch now (every lock bumps it): read before an open-vault check whose session must not outlive a lock. */
  lockEpoch(): Promise<number> {
    return this.a.lockEpoch();
  }

  /**
   * §3.5 (revision 24): the approval join's duplicates (the ids it recorded, `joinAdded`) moved to the trash after its
   * first round went through, where a live entry it did not add is the same account. An ordinary local edit.
   */
  trashJoinDuplicates(vaultId: string, ids: readonly string[]): Promise<number> {
    return trashJoinDuplicates(this.a, vaultId, ids);
  }

  /** §6 O13: this device's snapshots as the store lists them (newest first; for display, nothing written). */
  snapshots(): Promise<SnapshotMeta[]> {
    return this.a.store.snapshots();
  }

  /** §6 O13: accounts chosen from an earlier version brought back, in one ordinary local edit (recoverAccounts above). */
  recoverAccounts(chosen: readonly Entry[], o: { sameVault: boolean }): Promise<number> {
    return recoverAccounts(this.a, chosen, o);
  }

  /**
   * The security record's entry for an action this profile took on the server alone, which changes nothing stored here
   * (the kinds docs/design/notes/M2-NOTES.md §4.14 reserved for the network flows): a new device approved, a device revoked, the
   * server's history cleared, recorded once the server accepted it; and a wrong master password or recovery code typed
   * into the adoption (engine keys.ts adoptWithSecret), recorded as Phase 0's unlock records its own.
   */
  recordAction(
    kind: "device_approved" | "device_revoked" | "history_cleared" | "unlock_failed" | "recovery_failed",
  ): Promise<void> {
    return this.a.record(kind);
  }
}
