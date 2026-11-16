// The sync engine (SYNC-DESIGN §4; M3): one round of sync (§4.2), the outbox push (§4.7), and when to run (§4.8). A pure,
// injectable state machine: no fetch, no timers, no chrome.*, no clock of its own (deps.ts). Everything it must remember
// across a stopped service worker is in storage (sk_sync_state through state.ts, the identity, the outbox), so a new
// engine over the same storage carries on where an old one died; a round interrupted at any step leaves storage in a
// state the next round handles (the crash tests in test/fault/m3-* run it through every step).
//
// A round, holding webLock("sixkey-sync") (ifAvailable: busy means "rerun"), in this order:
//   0. the local side (§2.5): off, damaged, identity_missing (restored from its copy once unlocked), cfg_missing (an
//      unfinished turn-off: finished, never a round, RR-10; with the vault lost, the cloud restore), the identity's origin;
//      with the key here, the orphan entries folded (§4.7). None of it sends anything, so it all comes before the network
//      switch: then the API host permission (§4.9, revision 22), and without it the round ends as permission_removed;
//   1. GET /v1/sync/status: min_client_version (update_required stops everything), the server clock (§4.14), a pending or
//      rejected identity confirmed (§3.1 D4, §3.10 P5), D8 (the pin moved forward, or needs_password), the server's key
//      against the pin (§4.2 step 2: an older key stops with server_older_key, another needs_password, R4), the keys when
//      they changed (§3.9 via M1, after settlePins: adopt through commitKeys, or keys_behind / needs_new_password), the
//      devices when devices_rev changed, and the one-time rollback warning (A5);
//   3. needPull (version or head differs from lastSynced, D5) and dirty (the active envelope's checksum differs, F3):
//      neither → done; dirty only → upload the local vault as is (it evolved from lastSynced, §4.1); needPull → GET the
//      head, accept it (§4.3: remote.ts; a newer schema pauses, F6a walks the history);
//   4. the merge: both sides clamped to refNow (F5), the guard first on the engine's own copy (§4.4: a block stops with
//      review_needed and keeps nothing), then applyRemote (which merges again inside the vault lock, guarded again);
//   6. the upload, when there was no remote, the head was unreadable, or the merge differs from the RAW remote
//      (canonicalJson, F5): PUT with if_version = the head seen (base), rev base+1, the write proof and the cursor (only
//      here and in the outbox push, §4.10 T2); 409 restarts the round (at most 5 times, 200–1000 ms apart);
//   then lastSynced by compare-and-set (state.ts): only while the active generation is still the one uploaded or found
//   in sync, and lastSynced is still what the round read (a recovery in between, D1, makes it fail).
// Locked (no VK in this context): the status only, never a pull, never a write to the vault (C8), and the outbox pushed
// if the server is still at exactly the version and head it was built on (§4.7, D2, D5).
import type { Random } from "../../crypto/bytes";
import { randomBytes } from "../../crypto/bytes";
import { MergeBlocked, type CurrentVault, type MergeAnswer } from "../../service/sync-flows";
import { ServiceError } from "../../service/service-error";
import type { Generation } from "../../storage/format";
import { canonicalJson, mergeVaults } from "../../vault/merge";
import { parseHlc } from "../../vault/hlc";
import { isAlive, isPurged, type Vault } from "../../vault/model";
import { clampVault } from "../../vault/ops";
import { classifyServerVk } from "../crypto/adoption";
import { SYNC_CONSTANTS } from "../crypto/constants";
import { evaluateSameVkBundle, unwrappedPreviousIds } from "../crypto/bundle-eval";
import { fitsEnvelopeLimit } from "../crypto/padding";
import { adoptedRecord, parseBundleText, sameKeyring, type KeyBundle } from "../crypto/keybundle";
import { recoveryWrapInEffect } from "../crypto/reconcile";
import { writeProof } from "../crypto/subkeys";
import { blocks, guardMerge, notices as guardNotices, type GuardReport } from "../local/guard";
import type { DeviceIdentity } from "../local/identity";
import { uploadEnvelope, type OrphanItem, type Parked } from "../local/outbox";
import { ApiError, SyncApi, type DeviceSigner, type StatusResponse } from "./api";
import { clockNotice, offsetOf, OFFSET_WRITE_THRESHOLD_MS, refNow } from "./clock";
import type { EngineDeps } from "./deps";
import { envelopeVaultId, openRemote, walkHistory } from "./remote";
import { conflictDelay, CONFLICT_RETRIES, kickWakes, mayRun, retryAt, wakeAt, type WakeName } from "./schedule";
import { foldOrphans } from "./orphans";
import {
  EngineStateStore,
  headOf,
  joinAddedOf,
  unparked,
  type EngineState,
  type KeyStatus,
  type StateView,
  type SyncStatus,
} from "./state";
import { NetworkError } from "./transport";

export type RoundOptions = {
  /** The user's answer to a merge the guard stopped (§4.4): [Apply] or [Keep mine], for the versions they reviewed. */
  answer?: MergeAnswer;
  /** A user's "sync now" or "retry": runs inside a backoff and retries a rejected identity before its daily turn. */
  explicit?: boolean;
};

export type RoundResult = {
  status: SyncStatus;
  keyStatus?: KeyStatus;
  pulled: boolean;
  merged: boolean;
  uploaded: boolean;
  pushedOutbox: boolean;
  /** review_needed: what the guard reported and the digests its answer must carry back (in memory only, never stored). */
  blocked?: { report: GuardReport; seen: Readonly<Record<string, string>> };
  /** The error code of a failed round (the contract's, or a fixed engine code); never data. */
  error?: string;
};

type Stop = { stop: SyncStatus; error?: string; blocked?: RoundResult["blocked"] };
type Ready = { id: DeviceIdentity; signer: DeviceSigner };

const DAY_MS = 24 * 60 * 60 * 1000;
/** M3R-7: after this, a request signed when the code was sent can no longer be accepted (twice the ±300 s window). */
const UNDECIDED_MS = 2 * SYNC_CONSTANTS.SIG_WINDOW_S * 1000;
const LAST_OK_WRITE_MS = 30_000;
const isLocked = (e: unknown) => e instanceof ServiceError && e.code === "locked";
const empty = (status: SyncStatus, more: Partial<RoundResult> = {}): RoundResult => ({
  status,
  pulled: false,
  merged: false,
  uploaded: false,
  pushedOutbox: false,
  ...more,
});

/** §5.2 N21: Chrome manifest versions compared per component, numerically; a missing component is 0. */
export function versionBelow(mine: string, min: string): boolean {
  const re = /^\d{1,5}(\.\d{1,5}){0,3}$/;
  if (!re.test(min)) return false; // a malformed minimum is ignored rather than stopping sync on a server bug
  if (!re.test(mine)) return true;
  const a = mine.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** The digest the engine keeps of the local keyring next to the server's (kver, vk_id), so a local key commit re-evaluates. */
async function keyringDigest(kr: CurrentVault["gen"]["keyring"]): Promise<string> {
  return headOf(canonicalJson(kr));
}

export class SyncEngine {
  readonly api: SyncApi;
  readonly state: EngineStateStore;
  private offset = 0;
  /** A server time was received during the current guarded run (M3RR-9: only then is the offset written back). */
  private timeSeen = false;
  private rerun = false;
  private readonly rng: Random;
  private readonly random: () => number;

  constructor(private readonly d: EngineDeps) {
    this.state = new EngineStateStore(d.kv, d.vaultLock);
    this.rng = d.rng ?? randomBytes;
    this.random = d.random ?? (() => 0.5);
    this.api = new SyncApi({
      transport: d.transport,
      origin: d.origin,
      now: d.now,
      offset: () => this.offset,
      onServerTime: (s) => {
        this.offset = offsetOf(s);
        this.timeSeen = true;
      },
    });
  }

  private diag(m: string): void {
    this.d.diag?.(m);
  }

  /** The dependencies, for the key operations and the enrolment drivers built on this engine (keys.ts, enroll.ts). */
  get deps(): EngineDeps {
    return this.d;
  }

  /** refNow (§4.2, §4.14): this machine's clock with the server offset this context last estimated. */
  refNow(): number {
    return refNow(this.d.now(), this.offset);
  }

  // ---- entry points ----------------------------------------------------------------------------------------------

  /** One round (§4.2): the full one with the vault key in this context, the status and the outbox push without it. */
  async round(o: RoundOptions = {}): Promise<RoundResult> {
    for (let i = 0; ; i++) {
      this.rerun = false;
      const startedAt = this.d.now();
      const r = await this.d.syncLock(() => this.guarded(() => this.roundInner(o), o.explicit === true));
      if (!r.ran) {
        this.rerun = true;
        return empty("busy");
      }
      if (r.value.status !== "ok" && r.value.status !== "locked") return r.value;
      const v = await this.state.read();
      const kicked = (v.state.kickAt ?? 0) > startedAt;
      if (i < 2 && (this.rerun || kicked)) continue; // §4.2 step 7
      return r.value;
    }
  }

  /** The outbox push alone (§4.7: the service worker woken without the key, or after "lock every time" closed the popup). */
  async push(): Promise<RoundResult> {
    const r = await this.d.syncLock(() =>
      this.guarded(async () => {
        const pre = await this.prelude();
        if ("stop" in pre) return empty(pre.stop, pre.error ? { error: pre.error } : {});
        if (!(await this.allowed())) return empty("permission_removed"); // after the local stops, before any request
        const gen = await this.d.flows.generation(); // the vault first, then the state (M3R-1)
        const view = await this.state.read();
        this.offset = view.offsetMs; // M3RR-9: a fresh worker signs with the stored offset, never 0
        return this.lockedRound(pre, view, false, gen);
      }, false),
    );
    return r.ran ? r.value : empty("busy");
  }

  /**
   * "Sync soon" (§4.8): a page committed a local edit (its outbox is written already). The kick is persisted, a round
   * is scheduled 3 s later (HOTP: now, §4.12) with a 30 s alarm as the backstop.
   */
  async kick(o: { immediate?: boolean } = {}): Promise<void> {
    const now = this.d.now();
    const s = await this.state.update((cur) => ({ kickAt: now, dirtySince: cur.dirtySince ?? now }));
    const w = kickWakes(now, { ...(o.immediate ? { immediate: true } : {}), backoffUntil: s.backoffUntil ?? null });
    this.d.scheduler?.schedule("sync", w.sync);
    this.d.scheduler?.schedule("kick", w.kick);
  }

  /** A timer or alarm fired (M5). Runs a round unless a backoff is still running; schedules what comes next. */
  async wake(name: WakeName, o: { explicit?: boolean } = {}): Promise<RoundResult> {
    const now = this.d.now();
    const v = await this.state.read();
    if (!mayRun(now, v.state.backoffUntil, o.explicit)) {
      this.d.scheduler?.schedule("retry", wakeAt(now, v.state.backoffUntil!));
      return empty(v.state.status ?? "ok");
    }
    if (name === "kick") this.d.scheduler?.cancel("sync");
    return this.round(o.explicit ? { explicit: true } : {});
  }

  /**
   * The service worker started (§4.8): a round when sync is on and there is something to send: an outbox, or dirty (derived
   * again here, §4.1: the active envelope's checksum against lastSynced, so a kick lost with a stopped worker is not lost).
   */
  async start(): Promise<void> {
    const v = await this.state.read();
    if (!v.syncOn) return; // sync off: nothing loaded (the read budget)
    const now = this.d.now();
    // Only a schedule is decided here: a recovery inside this load makes `dirty` true either way (lastSynced cleared, or
    // a checksum that differs from the stale one), and the round itself loads the vault before reading the state.
    const gen = await this.d.flows.generation();
    const dirty = !v.lastSynced || (gen !== null && gen.envelope.checksum !== v.lastSynced.checksum);
    if (v.outbox || unparked(v.orphans).length || v.orphans.some((i) => i.pushable) || v.state.dirtySince || dirty)
      this.d.scheduler?.schedule("sync", wakeAt(now, Math.max(now, v.state.backoffUntil ?? now)));
  }

  /** What the panel shows (§6 O12), from storage. */
  async view(): Promise<StateView> {
    return this.state.read();
  }

  // ---- the network switch (§4.9, revisions 21 and 22) ------------------------------------------------------------
  // Asked inside a round, after the steps that send nothing (the local stops of the prelude and step 0's fold) and
  // before the first request; a page's or the worker's transport asks again before every request (M5).

  /** Whether the API host permission is granted (no gate: granted). A gate that throws counts as not granted. */
  private async allowed(): Promise<boolean> {
    if (!this.d.networkAllowed) return true;
    try {
      return await this.d.networkAllowed();
    } catch {
      return false;
    }
  }

  /**
   * The permission was withdrawn (chrome.permissions.onRemoved): the pause is recorded at once, without waiting for the
   * next round, and nothing is sent. If it is back already (its onAdded follows), nothing changes.
   */
  async permissionWithdrawn(): Promise<void> {
    if (!(await this.allowed())) await this.paused();
  }

  /**
   * The permission is gone: no request, and nothing of sync's records changes but the status (so the panel can say so).
   * Not a failure: the failure count and the backoff stay as they were, and so do lastSynced, the outbox, the orphan
   * list, the identity and the pins; local edits keep writing the outbox, and the first round after the grant carries on.
   * With sync off nothing is written (state.update writes nothing without sk_sync_cfg, D11).
   */
  private async paused(): Promise<void> {
    await this.state.update((cur) => (cur.status === "permission_removed" ? null : { status: "permission_removed" }));
  }

  // ---- the frame of every round: failures counted, never a lockout ----------------------------------------------

  /** Runs one attempt and records its outcome: success resets the backoff; a failure counts it and schedules a retry. */
  private async guarded(fn: () => Promise<RoundResult>, explicit: boolean): Promise<RoundResult> {
    const now = this.d.now();
    this.timeSeen = false;
    try {
      const r = await fn();
      if (r.status === "off") return r; // sync is off: nothing to record (and no sk_sync_state to keep, D11)
      if (r.status === "permission_removed") {
        // not an outcome of the server's: only the status is recorded
        await this.paused();
        return r;
      }
      const ok = !r.error;
      await this.state.update((cur) => {
        const patch: EngineState = {};
        if (cur.status !== r.status) patch.status = r.status;
        if (r.keyStatus && cur.keyStatus !== r.keyStatus) patch.keyStatus = r.keyStatus;
        if (ok) {
          if ((cur.failures ?? 0) !== 0) patch.failures = 0;
          if (cur.backoffUntil) patch.backoffUntil = null;
          if (cur.lastErrorCode) patch.lastErrorCode = null;
          if (r.status === "ok" && (!cur.lastOkAt || now - cur.lastOkAt >= LAST_OK_WRITE_MS || cur.status !== "ok"))
            patch.lastOkAt = now;
          if (r.status === "ok" && cur.dirtySince) patch.dirtySince = null;
          if (r.status === "ok" && cur.stuck) patch.stuck = null;
        }
        // M3RR-9: only an offset learned from a server time in this run (a fresh engine that stopped before any response
        // would otherwise write its initial 0 over the stored one)
        if (this.timeSeen && Math.abs((cur.serverOffsetMs ?? 0) - this.offset) >= OFFSET_WRITE_THRESHOLD_MS)
          patch.serverOffsetMs = this.offset;
        // A quiet round changes nothing but the attempt time: written at most every 30 s, so the status poll stays cheap.
        if (Object.keys(patch).length || !cur.lastAttemptAt || now - cur.lastAttemptAt >= LAST_OK_WRITE_MS)
          patch.lastAttemptAt = now;
        return Object.keys(patch).length ? patch : null;
      });
      if (r.error) await this.failed(r.error, now);
      return r;
    } catch (e) {
      const code =
        e instanceof NetworkError
          ? "network"
          : e instanceof ApiError
            ? e.code
            : e instanceof ServiceError
              ? e.code
              : "internal";
      const retryAfter = e instanceof ApiError ? e.details.retry_after : undefined;
      if (!(e instanceof NetworkError || e instanceof ApiError || e instanceof ServiceError))
        this.diag("sync round failed");
      // Every failure counts, a 503 with Retry-After too (M3RR-2: an overload must back off exponentially, Retry-After is
      // only the floor). M3R-15 kept: an explicit "sync now" pressed while a backoff is still running and answered 429
      // with Retry-After does not count again (the press is the user's, the schedule the server's).
      const pressedIn429 = explicit && e instanceof ApiError && e.status === 429 && retryAfter !== undefined;
      await this.failed(code, now, retryAfter, e instanceof NetworkError ? "offline" : "error", pressedIn429);
      return empty(e instanceof NetworkError ? "offline" : "error", { error: code });
    }
  }

  private async failed(
    code: string,
    now: number,
    retryAfter?: number,
    status?: SyncStatus,
    pressedIn429 = false,
  ): Promise<void> {
    const s = await this.state.update((cur) => {
      const inBackoff = (cur.backoffUntil ?? 0) > now;
      const failures = (cur.failures ?? 0) + (pressedIn429 && inBackoff ? 0 : 1);
      return {
        failures,
        backoffUntil: retryAt(now, failures, this.random(), retryAfter),
        lastErrorCode: code,
        lastAttemptAt: now,
        ...(status ? { status } : {}),
      };
    });
    if (s.backoffUntil) this.d.scheduler?.schedule("retry", wakeAt(now, s.backoffUntil));
  }

  // ---- 0. the local side ----------------------------------------------------------------------------------------

  private async prelude(answer?: MergeAnswer): Promise<Ready | Stop> {
    let st = await this.d.local.status(); // settles the pins (M2: before every decision)
    if (st.kind === "identity_missing") {
      // §2.5: restored from its copy once unlocked; maxSeenVersion from lastSynced (a lower bound of what was seen).
      try {
        await this.d.flows.restoreSyncIdentity({ maxSeenVersion: (await this.state.read()).lastSynced?.version ?? 0 });
      } catch (e) {
        if (isLocked(e)) return { stop: "identity_missing" };
        throw e;
      }
      st = await this.d.local.status();
    }
    switch (st.kind) {
      case "off":
        return { stop: "off" };
      case "damaged":
        return { stop: "damaged" };
      case "identity_missing":
        return { stop: "identity_missing" };
      case "cfg_missing": {
        // A pending identity that was never pinned is an enrolment in progress (§3.1 step 5, §3.2 N1): never touched.
        const id = st.identity;
        if (id.state === "pending" && id.vkId === null && id.adopted === null) return { stop: "off" };
        // RR-10: an unfinished turn-off with a readable vault. Finish it; never sign or run a round here.
        if ((await this.d.flows.vaultStatus()) === "ok") {
          // §4.7 (rev. 19, 20): the entries are folded before the turn-off deletes the records (with the key here; locked
          // with an unparked one, the round waits; parked ones are kept by the turn-off)
          let folded: OrphanItem[];
          try {
            const why = await this.orphanLockedOut(answer);
            if (why.refuse) return { stop: why.refuse === "vault_lost" ? "cloud_restore" : "locked" };
            folded = why.folded;
          } catch (e) {
            if (e instanceof MergeBlocked)
              return { stop: "review_needed", blocked: { report: e.report, seen: e.seen } };
            throw e;
          }
          await this.d.flows.turnOffSync({ folded });
          return { stop: "off" };
        }
        return { stop: "cloud_restore" }; // §4.13: the vault is lost, the identity's pins guard the cloud restore
      }
    }
    const id = st.identity;
    if (id.apiOrigin !== this.d.origin) return { stop: "wrong_origin" };
    return { id, signer: { kind: "device", deviceId: id.deviceId, key: id.keyPair.privateKey } };
  }

  private async markRejected(id: DeviceIdentity): Promise<void> {
    // §3.10 P5: never deleted, local data kept; the identity is marked and sync stops (a daily retry, or the user's).
    if (id.state === "pending") return; // a pending enrolment is "unfinished", not rejected
    await this.d.local.identity.update((i) => ({ ...i, state: "rejected_by_server" }));
    await this.d.local.cfg.setState("rejected_by_server");
    await this.state.update(() => ({ rejectedCheckedAt: this.d.now() })); // the answer just seen counts as today's question
  }

  private async markEnrolled(id: DeviceIdentity): Promise<void> {
    if (id.state === "enrolled") return;
    await this.d.local.identity.update((i) => ({ ...i, state: "enrolled" }));
    await this.d.local.cfg.setState("enrolled"); // M2-NOTES §7 item 8: the copy mirrors every state change
  }

  /** GET /v1/sync/status with what every round does with it first. A stop for update_required and identity problems. */
  private async statusOf(pre: Ready, view: StateView, explicit: boolean): Promise<StatusResponse | Stop> {
    // §3.10 P5 (M3R-4): a rejected identity asks once a day, by when it last asked (not by the rounds that stopped here)
    const rejected = pre.id.state === "rejected_by_server";
    if (rejected && !explicit && view.state.rejectedCheckedAt && this.d.now() - view.state.rejectedCheckedAt < DAY_MS)
      return { stop: "rejected_by_server" };
    let s: StatusResponse;
    try {
      s = await this.api.status(pre.signer);
    } catch (e) {
      if (
        e instanceof ApiError &&
        ((e.status === 401 && e.code === "unknown_device") || (e.status === 403 && e.code === "device_revoked"))
      ) {
        if (pre.id.state === "pending") return { stop: "join_unfinished" };
        await this.markRejected(pre.id); // writes rejectedCheckedAt: the server answered
        return { stop: "rejected_by_server" };
      }
      throw e; // offline or a failure: not today's answer (M3RR-12: the daily retry is not spent)
    }
    // M3R-12: the badge's count (§3.11, §4.9), locked too; written only when it changed (the steady state writes nothing),
    // and before the kill switch's stop, so update_required does not freeze a stale count
    if (s.pending_enrollments !== (view.state.pendingEnrollments ?? 0))
      await this.state.update(() => ({ pendingEnrollments: s.pending_enrollments }));
    if (versionBelow(this.d.clientVersion, s.min_client_version)) return { stop: "update_required" };
    if (clockNotice(this.offset) !== "none" && clockNotice(view.offsetMs) === "none")
      await this.state.notice({ kind: "clock_skew", at: this.d.now() });
    await this.markEnrolled(pre.id); // a 200 means the device row exists (§3.1 D4, §3.2 M7, §3.10's retry)
    return s;
  }

  // ---- the round --------------------------------------------------------------------------------------------------

  /**
   * The vault, then the sync state (M3R-1, D1), on every attempt. Loading the vault may be the storage recovery, whose hook
   * clears lastSynced and the outbox before the pointer moves to the older generation: a state read after the load sees
   * that (the round pulls and merges first), and a load after the state read can only have recovered from a generation
   * newer than the one that read describes. Read the other way round, a round decided "dirty only" from the lastSynced of
   * the generation just abandoned and uploaded the older state over the head.
   */
  private async loaded(
    answer?: MergeAnswer,
  ): Promise<
    | { cur: CurrentVault; view: StateView; folded: OrphanItem[]; parked: { item: OrphanItem; parked: Parked }[] }
    | { locked: Generation | null; view: StateView }
    | { blocked: RoundResult }
  > {
    let held: { cur: CurrentVault; view: StateView } | null = null;
    try {
      const cur = await this.d.flows.current();
      held = { cur, view: await this.state.read() };
    } catch (e) {
      if (!isLocked(e)) throw e;
    }
    if (held) {
      // §4.2 step 0 (rev. 19, 20): with the key here, every orphan entry is folded first, however the round then ends
      if (held.view.orphanDamaged) await this.state.removeOrphans([], { damaged: true });
      if (!held.view.orphans.length) return { ...held, folded: [], parked: [] };
      const f = await foldOrphans(
        {
          flows: this.d.flows,
          state: this.state,
          now: this.d.now,
          refNow: () => refNow(this.d.now(), held.view.offsetMs),
          diag: (m) => this.diag(m),
        },
        held.cur,
        held.view.orphans,
        answer,
      ); // the stored offset, as applyRemote clamps
      if (f.kind === "blocked")
        return { blocked: empty("review_needed", { blocked: { report: f.report, seen: f.seen } }) }; // every entry kept
      if (f.kind === "locked") return { ...held, folded: [], parked: [] };
      const cur = await this.d.flows.current(); // the vault the fold produced (or the same: idempotent)
      return { cur, view: await this.state.read(), folded: f.folded, parked: f.parked };
    }
    const gen = await this.d.flows.generation();
    return { locked: gen, view: await this.state.read() };
  }

  private async roundInner(o: RoundOptions): Promise<RoundResult> {
    const pre = await this.prelude(o.answer);
    if ("stop" in pre) {
      // §4.2 step 0 (rev. 19): the fold happens however the round ends; a damaged identity or another origin stop here
      if (pre.stop === "damaged" || pre.stop === "wrong_origin") {
        try {
          await this.foldForFlow(o.answer);
        } catch (e) {
          if (e instanceof MergeBlocked) return empty("review_needed", { blocked: { report: e.report, seen: e.seen } });
          throw e;
        }
      }
      return empty(pre.stop, {
        ...(pre.error ? { error: pre.error } : {}),
        ...(pre.blocked ? { blocked: pre.blocked } : {}),
      });
    }
    for (let attempt = 0; ; attempt++) {
      const l = await this.loaded(o.answer);
      if ("blocked" in l) return l.blocked; // the entries' fold stopped at the guard (§4.7: every entry stays)
      // the network switch (§4.9): after the local stops and step 0's fold, which send nothing, before the first request
      if (attempt === 0 && !(await this.allowed())) return empty("permission_removed");
      if (attempt === 0) this.offset = l.view.offsetMs;
      if (!("cur" in l))
        return attempt === 0 ? this.lockedRound(pre, l.view, o.explicit === true, l.locked) : empty("locked");
      const r = await this.attempt(pre, l.cur, l.view, o, l.folded, l.parked);
      if (r !== "restart" && r !== "conflict") {
        // only a join writes the record, so one absent when the round began is absent now: no read in the steady state
        if (r.status === "ok" && l.view.state.joinAdded != null) await this.dedupeAfterJoin();
        return r;
      }
      if (attempt + 1 >= CONFLICT_RETRIES)
        return empty("error", { error: r === "conflict" ? "version_conflict" : "restart_limit" });
      if (r === "conflict") await this.d.sleep(conflictDelay(this.random()));
      const p2 = await this.prelude(); // the local side may have changed (a key commit, a turn-off)
      if ("stop" in p2) return empty(p2.stop);
      pre.id = p2.id;
      pre.signer = p2.signer;
    }
  }

  /** One pass of §4.2 steps 1–6 with the key. "restart": go round again (the keys or the head moved); "conflict": a 409. */
  private async attempt(
    pre: Ready,
    cur: CurrentVault,
    view: StateView,
    o: RoundOptions,
    folded: OrphanItem[] = [],
    parked: { item: OrphanItem; parked: Parked }[] = [],
  ): Promise<RoundResult | "restart" | "conflict"> {
    // ---- 1. status, and the devices when devices_rev moved (§4.2 step 1): before the key checks, so a round that stops
    // at them (needs_password, server_older_key) still learns a revocation (refreshDevices keeps a revocation sticky)
    const s = await this.statusOf(pre, view, o.explicit === true);
    if ("stop" in s) return empty(s.stop);
    if (s.devices_rev !== (view.state.devicesRev ?? null)) await this.refreshDevices(pre, s);
    const local = cur.gen.keyring;
    const vaultId = local.vaultId;
    let id = pre.id;

    // §3.1 D4 / RR-12: an identity never pinned (the first upload's local half did not finish) is pinned "in sync" from
    // GET /v1/keys, only when that bundle is exactly the local keyring under this device's key.
    if (id.vkId === null && id.adopted === null) {
      const done = await this.pinFirstUpload(pre, cur);
      if (done !== "ok") return empty(done);
      return "restart";
    }

    // D8 (§3.9): the pin against the local keyring. Forward when the local keyring's previous list really unwraps it;
    // otherwise the local commit was lost behind the pins (GM2-5): needs_password, and nothing of the server is decided.
    let prevIds: Set<string> | null = null;
    const prev = async () => (prevIds ??= await unwrappedPreviousIds(local, cur.vk));
    if (id.vkId !== null && id.vkId !== local.vkId) {
      if (!(await prev()).has(id.vkId)) return empty("needs_password", { keyStatus: "ok" });
      await this.d.local.identity.update((i) => ({ ...i, vkId: local.vkId }));
      id = { ...id, vkId: local.vkId };
    }
    // §4.2 step 2: the server's key against the pin (R4; a server back on an older key never makes this device go back).
    if (s.vk_id !== local.vkId) {
      const where = classifyServerVk(s.vk_id, local.vkId, await prev());
      return empty(where === "older" ? "server_older_key" : "needs_password");
    }

    // The keys, when they changed (§3.9 R0-R2 through M1, after settlePins), and the devices (§3.10).
    const keyDigest = await keyringDigest(local);
    let keyStatus: KeyStatus = view.state.keyStatus ?? "ok";
    const ks = view.state.keysSeen;
    const judge = !ks || ks.kver !== s.kver || ks.vkId !== s.vk_id || ks.local !== keyDigest;
    if (judge) {
      const k = await this.syncKeys(pre, cur, view);
      if (k === "restart") return "restart";
      keyStatus = k;
      await this.state.update(() => ({ keysSeen: { kver: s.kver, vkId: s.vk_id, local: keyDigest }, keyStatus }));
    }
    if (!judge) await this.pendingDue(pre, view); // the keys did not change: a pending code is still judged in time (M3R-7)
    // §4.7 (rev. 19, 20): an entry parked under a key not held here is removed (one orphan_unreadable) only once this
    // round confirmed the device holds the server's whole key chain (the server on the local key, the keys in sync) and
    // that key is still not in it (capPrevious dropped it); until then it stays parked (FIXa2: an adoption may bring it).
    // Revision 24: only an entry of this very vault; one of another vault stays until the user deletes it.
    if (parked.length && s.vk_id === local.vkId && keyStatus === "ok") {
      const listed = (id: string) => local.vkId === id || local.previous.some((p) => p.vkId === id);
      const gone = parked
        .filter(
          (p) =>
            p.parked.reason === "key" &&
            p.parked.vkId !== null &&
            !listed(p.parked.vkId) &&
            envelopeVaultId(p.item.envelope) === vaultId,
        )
        .map((p) => p.item);
      if (gone.length) {
        await this.state.removeOrphans(gone);
        await this.state.notice({ kind: "orphan_unreadable", at: this.d.now(), n: gone.length });
      }
    }

    // A5: the server's version went back (an honest PITR, or a malicious one): warned once, then merged as usual.
    if (s.version < id.maxSeenVersion) {
      await this.state.notice({ kind: "rollback", at: this.d.now(), n: id.maxSeenVersion - s.version });
      await this.d.local.identity.update((i) => ({ ...i, maxSeenVersion: s.version }));
      id = { ...id, maxSeenVersion: s.version };
    }

    // ---- 3. what to do
    const ls0 = view.lastSynced;
    const base = s.version;
    const needPull = !ls0 || ls0.version !== s.version || ls0.head !== s.head;
    const dirty = !ls0 || cur.gen.envelope.checksum !== ls0.checksum;
    // D7: a head judged before as one this device cannot take in is not pulled again while nothing changed.
    const stuck = view.state.stuck;
    if (
      stuck &&
      stuck.head === s.head &&
      stuck.version === s.version &&
      stuck.checksum === cur.gen.envelope.checksum &&
      stuck.client === this.d.clientVersion
    )
      return empty(stuck.status, { keyStatus });
    const stop = async (status: SyncStatus, more: Partial<RoundResult> = {}): Promise<RoundResult> => {
      const checksum = (await this.d.flows.generation())?.envelope.checksum ?? cur.gen.envelope.checksum;
      await this.state.update(() => ({
        stuck: { head: s.head, version: s.version, checksum, status, client: this.d.clientVersion },
      }));
      return empty(status, { keyStatus, ...more });
    };
    if (!needPull && !dirty) {
      if (view.outbox) await this.state.dropOutbox(view.outbox); // nothing to send: an outbox here is stale
      return empty("ok", { keyStatus });
    }
    let remote: Vault | null = null;
    let headUnreadable = false;
    if (needPull) {
      const v = await this.api.getVault(pre.signer);
      if (v.version !== s.version || (await headOf(v.envelope)) !== s.head) return "restart"; // the head moved meanwhile
      const opened = await openRemote(v.envelope, cur.vk, vaultId);
      if (opened.kind === "newer_schema") return stop("paused_newer", { pulled: true }); // R1/R6: nothing uploaded
      if (opened.kind === "wrong_vault") return stop("different_vault", { pulled: true });
      if (opened.kind === "ok") {
        remote = opened.vault;
        if (opened.rev !== s.version) await this.state.notice({ kind: "rev_mismatch", at: this.d.now() });
      } else {
        // F6a: the head does not open under the current key; the newest history version that does (never past a newer schema).
        const w = await walkHistory(this.api, pre.signer, s.version, cur.vk, vaultId);
        if (w.kind === "newer_schema") return stop("paused_newer", { pulled: true });
        if (w.kind === "none") return stop("remote_unreadable", { pulled: true });
        remote = w.vault;
        headUnreadable = true;
      }
      if (id.maxSeenVersion < s.version) {
        await this.d.local.identity.update((i) => ({ ...i, maxSeenVersion: Math.max(i.maxSeenVersion, s.version) }));
        id = { ...id, maxSeenVersion: s.version };
      }
    }

    // ---- 4/5. merge
    let committed: { vault: Vault; checksum: string } = { vault: cur.vault, checksum: cur.gen.envelope.checksum };
    let mergedAny = false;
    if (remote) {
      const now = refNow(this.d.now(), this.offset);
      const mine = clampVault(cur.vault, now);
      const theirs = clampVault(remote, now);
      const merged = mergeVaults(mine, theirs);
      const g = guardMerge(mine, theirs, merged);
      if (canonicalJson(merged) !== canonicalJson(cur.vault) || blocks(g)) {
        try {
          // M3R-5: applyRemote clamps with the stored offset (and local edits stamp with it): this round's estimate first
          if (Math.abs((view.state.serverOffsetMs ?? 0) - this.offset) >= OFFSET_WRITE_THRESHOLD_MS)
            await this.state.update(() => ({ serverOffsetMs: this.offset }));
          const res = await this.d.flows.applyRemote(remote, o.answer);
          committed = { vault: res.vault, checksum: res.checksum };
          mergedAny = res.changed;
          if (res.changed) await this.mergeNotices(res.guard, cur.vault, now);
        } catch (e) {
          if (e instanceof MergeBlocked)
            return empty("review_needed", { keyStatus, pulled: true, blocked: { report: e.report, seen: e.seen } }); // C1: nothing kept
          if (e instanceof ServiceError && e.code === "too_large") return stop("too_large", { pulled: true }); // D7: not committed
          if (e instanceof ServiceError && e.code === "different_vault")
            return stop("different_vault", { pulled: true });
          if (isLocked(e)) return empty("locked", { pulled: true });
          throw e;
        }
      }
    }

    // ---- 6. upload
    const needUpload = !remote || headUnreadable || canonicalJson(committed.vault) !== canonicalJson(remote);
    if (!needUpload) {
      await this.state.casLastSynced(
        ls0,
        { version: base, head: s.head, checksum: committed.checksum },
        committed.checksum,
        folded,
      );
      return empty("ok", { keyStatus, pulled: needPull, merged: mergedAny });
    }
    const up = await uploadEnvelope(committed.vault, cur.vk, { vaultId, rev: base + 1 }, this.rng);
    if (!fitsEnvelopeLimit(up.text)) return stop("too_large", { pulled: needPull, merged: mergedAny }); // §4.3: kept locally, upload paused
    const proof = await writeProof(cur.vk, { vaultId, ifVersion: base, checksum: up.envelope.checksum });
    try {
      await this.d.flows.unlockedKey(local); // locked since the round began: nothing more is sent (§4.6)
    } catch (e) {
      if (isLocked(e)) return empty("locked", { keyStatus, pulled: needPull, merged: mergedAny });
      throw e;
    }
    const put = await this.putVault(pre, { if_version: base, envelope: up.text, write_proof: proof });
    if (put === "conflict") return "conflict";
    if (put === "write_denied")
      return (await this.keyMoved(pre, s))
        ? "restart"
        : empty("error", { keyStatus, error: "write_denied", pulled: needPull, merged: mergedAny });
    if (typeof put === "string") return empty(put as SyncStatus, { keyStatus, pulled: needPull, merged: mergedAny });
    if (put.version !== base + 1) return "restart"; // not what a PUT with this if_version can return: ask again
    await this.state.casLastSynced(
      ls0,
      { version: base + 1, head: await headOf(up.text), checksum: committed.checksum },
      committed.checksum,
      folded,
    );
    await this.d.local.identity.update((i) => (i.maxSeenVersion >= base + 1 ? i : { ...i, maxSeenVersion: base + 1 }));
    return empty("ok", { keyStatus, pulled: needPull, merged: mergedAny, uploaded: true });
  }

  /**
   * §3.5 (revision 24): an approval join adds this profile's accounts to a synced vault it cannot see yet, so an account
   * both had is there twice once the first round has merged the two. After a round with the key that went through (the
   * synced vault merged here: lastSynced set), the accounts the join recorded that a live account it did not add matches
   * (SyncFlows.trashJoinDuplicates) go to the trash, never erased, in one ordinary local edit that syncs like any other;
   * then the record is cleared, with one notice when any went. A failure (a lock meanwhile, a storage error) leaves the
   * record for the next such round; a record that does not parse is cleared. The trash moves go up with the next pass of
   * this round (rerun).
   */
  private async dedupeAfterJoin(): Promise<void> {
    const v = await this.state.read();
    const raw = v.state.joinAdded;
    if (raw === undefined || raw === null) return;
    const rec = joinAddedOf(raw);
    if (!rec) return this.state.settleJoinAdded(null);
    if (!v.lastSynced) return;
    let n: number;
    try {
      n = await this.d.flows.trashJoinDuplicates(rec.vaultId, rec.ids);
    } catch {
      this.diag("join dedupe waits");
      return;
    }
    await this.state.settleJoinAdded(n > 0 ? { kind: "duplicates_trashed", at: this.d.now(), n } : null);
    if (n > 0) this.rerun = true;
  }

  /**
   * PUT /v1/vault with the cursor (§4.10: made and written before the request; cur := pending after a 200). The result,
   * "conflict" for a 409, or a status to stop with. Other errors propagate (counted as failures by guarded()).
   */
  private async putVault(
    pre: Ready,
    body: { if_version: number; envelope: string; write_proof: string },
  ): Promise<{ version: number } | "conflict" | "write_denied" | SyncStatus> {
    const cursor = await this.state.cursorForPut(this.rng);
    if (!cursor) return "off";
    try {
      const r = await this.api.putVault(pre.signer, { ...body, cursor });
      await this.state.cursorAccepted(cursor.pending);
      if (r.forked) await this.state.notice({ kind: "forked", at: this.d.now() });
      return { version: r.version };
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 409 && (e.code === "version_conflict" || e.code === "vk_mismatch")) return "conflict";
        // a write_denied may be K_write moving under a rotation (a server that checks the proof before the CAS, M3R-14):
        // the caller asks the status once more and goes round again only if the key or kver moved (M3RR-10)
        if (e.status === 403 && e.code === "write_denied") return "write_denied";
        if (e.status === 413) return "too_large";
        if ((e.status === 401 && e.code === "unknown_device") || (e.status === 403 && e.code === "device_revoked")) {
          await this.markRejected(pre.id);
          return "rejected_by_server";
        }
      }
      throw e;
    }
  }

  // ---- locked: the status and the outbox push --------------------------------------------------------------------

  private async lockedRound(
    pre: Ready,
    view: StateView,
    explicit: boolean,
    gen: Generation | null,
  ): Promise<RoundResult> {
    const s = await this.statusOf(pre, view, explicit);
    if ("stop" in s) return empty(s.stop);
    if (s.devices_rev !== (view.state.devicesRev ?? null)) await this.refreshDevices(pre, s); // §4.2 step 1, as above
    const pinned = pre.id.vkId;
    if (pinned !== null && s.vk_id !== pinned) {
      // Plain ids, readable while locked: the server rotated (R4) or went back to a key listed as previous (§4.2 step 2).
      return empty("needs_password");
    }
    // D8's second direction, seen while locked: the pin is a key the local keyring does not even list (its commit was lost).
    const local = gen?.keyring;
    if (pinned !== null && local && local.vkId !== pinned && !local.previous.some((p) => p.vkId === pinned))
      return empty("needs_password");
    await this.pendingDue(pre, view); // M3R-7: readable while locked (the bundle's MAC and fingerprint need no key)
    const ob = view.outbox; // the pushable one: a merge-only outbox is never pushed (it has no proof, R3R-5)
    if (view.orphanDamaged) await this.state.removeOrphans([], { damaged: true }); // nothing in them to save
    // §4.7 (revision 24): an entry of another vault than this profile's is never pushed, and stays until the user deletes
    // it (with the key the fold parks it: "vault"); a newer build's record is not judged here (R4R-5)
    const items = gen
      ? view.orphans.filter((i) => i.newer || envelopeVaultId(i.envelope) === gen.keyring.vaultId)
      : view.orphans;
    if (!ob) return this.pushOrphan(pre, s, items);
    if (s.version === ob.base && s.head === ob.head) {
      const put = await this.putVault(pre, { if_version: ob.base, envelope: ob.envelope, write_proof: ob.proof });
      if (put === "write_denied") {
        if (!(await this.keyMoved(pre, s))) return empty("locked", { error: "write_denied" }); // kept: the round tells
        await this.state.demoteOutbox(ob); // revision 20 (R3R-1): demoted, never dropped
        return empty("locked");
      }
      if (put === "conflict") {
        await this.state.demoteOutbox(ob); // §4.7 (rev. 20): the server moved on; demoted, a full round with the key folds it
        return empty("locked");
      }
      if (typeof put === "string") return empty(put as SyncStatus);
      if (put.version === ob.base + 1) await this.state.pushed(ob);
      await this.d.local.identity.update((i) =>
        i.maxSeenVersion >= ob.base + 1 ? i : { ...i, maxSeenVersion: ob.base + 1 },
      );
      return empty("locked", { pushedOutbox: true, uploaded: true });
    }
    if (s.version === ob.base + 1 && s.head === (await headOf(ob.envelope))) {
      await this.state.pushed(ob); // it landed already (its response was lost): the server holds exactly its text
      return empty("locked", { pushedOutbox: true });
    }
    await this.state.demoteOutbox(ob); // built on a version or head the server no longer has (D5): never pushed over it, never dropped (R3R-1)
    return empty("locked");
  }

  /** M3RR-10: after a write_denied, whether the server's key or kver moved since `s` (one more status query). */
  private async keyMoved(pre: Ready, s: StatusResponse): Promise<boolean> {
    const s2 = await this.api.status(pre.signer);
    return s2.vk_id !== s.vk_id || s2.kver !== s.kver;
  }

  /**
   * §4.7 (rev. 20): an orphan entry pushed by the same path and check as a live outbox: only one with a write proof, and
   * only while the server is at exactly its (base, head) (the head is a SHA-256 of an envelope text: at most one
   * matches). 200 (or an earlier push's answer lost: the server at base + 1 with that entry's own text) retires it;
   * lastSynced is not brought back (it is null: D2's CAS). Anything else keeps it: a context with the key folds it.
   */
  private async pushOrphan(pre: Ready, s: StatusResponse, items: readonly OrphanItem[]): Promise<RoundResult> {
    for (const it of items) {
      const ob = it.pushable;
      if (ob && s.version === ob.base + 1 && s.head === (await headOf(ob.envelope))) {
        await this.state.removeOrphans([it]); // its push landed before (the answer was lost)
        return empty("locked", { pushedOutbox: true });
      }
    }
    const it = items.find((i) => i.pushable && s.version === i.pushable.base && s.head === i.pushable.head);
    const ob = it?.pushable;
    if (!it || !ob) return empty("locked");
    const put = await this.putVault(pre, { if_version: ob.base, envelope: ob.envelope, write_proof: ob.proof });
    if (typeof put === "object" && put.version === ob.base + 1) {
      await this.state.removeOrphans([it]); // retirement 1
      await this.d.local.identity.update((i) =>
        i.maxSeenVersion >= ob.base + 1 ? i : { ...i, maxSeenVersion: ob.base + 1 },
      );
      return empty("locked", { pushedOutbox: true, uploaded: true });
    }
    if (typeof put === "string" && put !== "conflict" && put !== "write_denied") return empty(put as SyncStatus);
    return empty("locked"); // kept, for the fold
  }

  /**
   * For a flow about to delete the sync records (turn-off, removeSyncIdentity, M3R-9's undo and the revoked-pending undo,
   * the prelude's unfinished turn-off): every entry it can fold is folded first. Null when nothing unfolded and unparked
   * is left (parked entries are kept by the turn-off, revision 20 R3R-2: never a refusal for them); else why not:
   * "locked" (unlock first: the save would go with the records), "vault_lost" (no local vault to fold into, R3R-3: the
   * cloud restore or a backup comes first). A guard block throws MergeBlocked: nothing was deleted yet.
   */
  async orphanLockedOut(
    answer?: MergeAnswer,
  ): Promise<{ refuse: null | "locked" | "vault_lost"; folded: OrphanItem[] }> {
    const f = await this.foldForFlow(answer);
    const left = unparked((await this.state.read()).orphans).filter(
      (i) => !f.folded.some((x) => x.envelope === i.envelope && x.checksum === i.checksum),
    );
    if (!left.length) return { refuse: null, folded: f.folded }; // the flow passes `folded` to turnOffSync: the rest is kept (R4R-1)
    return { refuse: f.status === "vault_lost" ? "vault_lost" : "locked", folded: f.folded };
  }

  /**
   * The fold for the flows that replace, re-key or delete this vault (§4.7: a join, a cloud restore, an R3 adoption, the
   * turn-off; keys.ts and enroll.ts call it first). Needs the key in this context; a guard block throws MergeBlocked (the
   * flow passes the user's answer back in). "none" when there is no entry; "locked" or "vault_lost" (R3R-3: the local
   * vault is lost or empty) when there is no vault to fold into; "done" with what it folded (parked entries stay).
   */
  async foldForFlow(
    answer?: MergeAnswer,
  ): Promise<{ status: "none" | "done" | "locked" | "vault_lost"; folded: OrphanItem[] }> {
    // the vault first, then the state (M3R-1; M3 revision 5, R4R-2): the load runs a pending recovery, whose hook moves
    // the outbox into the list; read the other way round a tear no load has seen yet loses the save with the records
    await this.d.flows.generation();
    const view = await this.state.read();
    if (view.orphanDamaged) await this.state.removeOrphans([], { damaged: true });
    if (!view.orphans.length) return { status: "none", folded: [] };
    let cur: CurrentVault;
    try {
      cur = await this.d.flows.current();
    } catch (e) {
      if (isLocked(e)) return { status: "locked", folded: [] };
      if (e instanceof ServiceError) return { status: "vault_lost", folded: [] };
      throw e;
    }
    const f = await foldOrphans(
      {
        flows: this.d.flows,
        state: this.state,
        now: this.d.now,
        refNow: () => refNow(this.d.now(), view.offsetMs),
        diag: (m) => this.diag(m),
      },
      cur,
      view.orphans,
      answer,
    );
    if (f.kind === "blocked") throw new MergeBlocked(f.report, f.seen);
    if (f.kind === "locked") return { status: "locked", folded: [] };
    return { status: "done", folded: f.folded };
  }

  // ---- the keys (§3.9) ---------------------------------------------------------------------------------------------

  /**
   * GET /v1/keys and M1's verdict for a bundle under this device's key, with the settled pins (M2-NOTES §7 item 1). An
   * adoption is committed at once (commitKeys with the very verdict object; a stale one is evaluated again, never
   * retried); everything else becomes the key status. Never an alarm on a refusal: M1's verdict is what the user sees.
   */
  private async syncKeys(pre: Ready, cur: CurrentVault, view: StateView): Promise<KeyStatus | "restart"> {
    const k = await this.api.getKeys(pre.signer);
    let bundle: KeyBundle;
    try {
      bundle = parseBundleText(k.bundle);
    } catch {
      return "rejected";
    }
    if (bundle.keyring.vkId !== cur.vk.id || bundle.kver !== k.kver) return "rejected";
    const pid = await this.d.local.settlePins();
    const pin = pid && pid !== "damaged" ? pid : null;
    const v = await evaluateSameVkBundle({
      bundle,
      vk: cur.vk,
      local: cur.gen.keyring,
      maxSeenKver: pin?.maxSeenKver ?? 0,
      expectedVaultId: cur.gen.keyring.vaultId,
      adoptedAuth: pin?.adopted?.auth ?? null,
      adoptedDigest: pin?.adopted?.digest ?? null,
    });
    await this.recoveryNotice(bundle, view);
    switch (v.kind) {
      case "in_sync":
        return "ok";
      case "adopt": {
        const back = pin?.adopted?.digest !== undefined && (await adoptedRecord(bundle)).digest === pin.adopted.digest;
        try {
          await this.d.flows.commitKeys({ keys: v, record: back ? "keys_adopted_back" : "keys_adopted" });
        } catch (e) {
          if (e instanceof ServiceError && e.code === "bad_state" && e.message === "stale") return "restart"; // RR-1: evaluate again
          if (e instanceof ServiceError && (e.code === "bad_state" || e.code === "different_vault")) return "rejected";
          throw e;
        }
        await this.state.notice({ kind: back ? "keys_adopted" : "keys_changed", at: this.d.now() });
        return "restart";
      }
      case "needs_new_password":
        return "needs_new_password";
      case "keys_behind":
        return "keys_behind";
      default:
        return "rejected";
    }
  }

  /**
   * §3.6.0: an unconfirmed new recovery code, judged against the server's bundle: in effect, or not. "Not in effect" only
   * once it is known: the server's kver reached the code's (another change won), or (M3R-7) the server still holds
   * exactly the bundle the code was built on and no signature of the request can be accepted any more (UNDECIDED_MS,
   * twice the signature window, after it was sent). Until then nothing is said (A4: never "invalid" while it may land).
   */
  private async recoveryNotice(bundle: KeyBundle, view: StateView): Promise<void> {
    const p = view.state.pendingRecoveryWrap;
    if (!p) return;
    const inEffect = await recoveryWrapInEffect(bundle, p.fp);
    // on the corrected clock, from the last send attempt (M3RR-6: `at` is refNow, refreshed after every send)
    const expired =
      p.baseMac !== undefined &&
      bundle.kver === p.baseKver &&
      bundle.mac === p.baseMac &&
      this.refNow() - p.at > UNDECIDED_MS;
    if (!inEffect && bundle.kver < (p.kver ?? Infinity) && !expired) return; // not decided yet
    await this.state.update(() => ({ pendingRecoveryWrap: null }));
    await this.state.notice({ kind: inEffect ? "recovery_in_effect" : "recovery_not_in_effect", at: this.d.now() });
  }

  /** M3R-7: a pending code past UNDECIDED_MS is judged even when the keys did not change (GET /v1/keys once). */
  private async pendingDue(pre: Ready, view: StateView): Promise<void> {
    const p = view.state.pendingRecoveryWrap;
    if (!p || this.refNow() - p.at <= UNDECIDED_MS) return;
    let bundle: KeyBundle;
    try {
      bundle = parseBundleText((await this.api.getKeys(pre.signer)).bundle);
    } catch (e) {
      if (e instanceof ApiError || e instanceof NetworkError) throw e;
      return;
    }
    await this.recoveryNotice(bundle, view);
  }

  /**
   * §3.1 step 7's recovery (D4, RR-12): the init landed (the status query answered) but its pins were never written. Pinned
   * "in sync" only if GET /v1/keys holds exactly the local keyring under this device's key (M1's in_sync, MAC checked);
   * otherwise an ordinary key evaluation follows on the next round with the identity pinned to the local keyring.
   */
  private async pinFirstUpload(pre: Ready, cur: CurrentVault): Promise<SyncStatus | "ok"> {
    const k = await this.api.getKeys(pre.signer);
    let bundle: KeyBundle;
    try {
      bundle = parseBundleText(k.bundle);
    } catch {
      return "error";
    }
    const local = cur.gen.keyring;
    if (bundle.keyring.vkId !== cur.vk.id) return "needs_password";
    const v = await evaluateSameVkBundle({
      bundle,
      vk: cur.vk,
      local,
      maxSeenKver: 0,
      expectedVaultId: local.vaultId,
      adoptedAuth: null,
      adoptedDigest: null,
    });
    const pins =
      v.kind === "in_sync" && sameKeyring(bundle.keyring, local)
        ? { vkId: local.vkId, vaultId: local.vaultId, maxSeenKver: bundle.kver, adopted: await adoptedRecord(bundle) }
        : null;
    if (pins) await this.d.local.identity.setPins(pins);
    // D8's reference and the vault this identity belongs to (a cloud restore's guard: §4.13 needs vaultId). M3R-10: vaultId
    // is a pin field that should go through setPins, which needs an adopted record this unpinned identity does not have;
    // an unpinned first-upload identity has no pending copy to be ordered against (the review), so update() stays here
    // until M2 offers a setReference() (docs/design/notes/M3-NOTES.md §8)
    else await this.d.local.identity.update((i) => ({ ...i, vkId: local.vkId, vaultId: local.vaultId }));
    return "ok";
  }

  // ---- devices (§3.10, §3.14 S2) -----------------------------------------------------------------------------------

  /** GET /v1/devices when devices_rev moved: banners for joins, revocations and repeated wrong passwords (state, never a lockout). */
  private async refreshDevices(pre: Ready, s: StatusResponse): Promise<void> {
    const r = await this.api.devices(pre.signer);
    const view = await this.state.read();
    const known = new Map((view.state.devices ?? []).map((d) => [d.id, d]));
    const now = this.d.now();
    // a revocation is sticky (state.ts undoneRevocations): a device seen revoked stays so in this list, also when a
    // restore of the server lists it as active again
    const list = r.devices.map((x) => ({
      id: x.device_id,
      revoked: x.revoked_at !== null || known.get(x.device_id)?.revoked === true,
      warn: x.auth_failures >= 3,
    }));
    const fresh = known.size > 0 ? list.filter((x) => !known.has(x.id) && x.id !== pre.id.deviceId) : [];
    const revoked = list.filter((x) => x.revoked && known.get(x.id)?.revoked === false);
    const warn = list.filter((x) => x.warn && !known.get(x.id)?.warn);
    if (fresh.length) await this.state.notice({ kind: "device_joined", at: now, n: fresh.length });
    if (revoked.length) await this.state.notice({ kind: "device_revoked", at: now, n: revoked.length });
    if (warn.length) await this.state.notice({ kind: "auth_failures", at: now, n: warn.length, danger: true });
    await this.state.update(() => ({ devicesRev: s.devices_rev, devices: list }));
  }

  // ---- §4.4's banners ---------------------------------------------------------------------------------------------

  private async mergeNotices(g: GuardReport, local: Vault, now: number): Promise<void> {
    if (!guardNotices(g)) return;
    const own = this.d.hlcDevice ? await this.d.hlcDevice() : null;
    const byId = new Map(local.entries.map((e) => [e.id, e]));
    // D6: entries erased that another device had moved to the trash within 24 hours: the danger colour.
    const recent = g.purgedFromTrash.filter((idOf) => {
      const e = byId.get(idOf);
      const p = e?.dhlc ? parseHlc(e.dhlc) : null;
      return !!e && !isAlive(e) && !isPurged(e) && !!p && p.device !== own && now - p.wall <= DAY_MS;
    });
    await this.state.notice({
      kind: "deleted_remotely",
      at: this.d.now(),
      n: Math.max(g.trashed.length, g.purgedFromTrash.length),
      danger: recent.length >= 3,
    });
  }

  /** The server offset this context estimated from its last response (§4.14), for the key operations and enrolment. */
  get serverOffset(): number {
    return this.offset;
  }
}
