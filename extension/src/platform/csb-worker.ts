// The backup in Chrome's sync storage (CSB) in the service worker: when it runs, what one run does, what it writes down,
// and what the settings page may ask of it. The layout, the plan and the write rule are core/cloud/slots.ts's; the one
// module that writes chrome.storage.sync is platform/csb-area.ts, which only this module imports; the records are
// platform/csb-config.ts's. The worker's wiring (src/background/sw.ts) gives it the store, storage.local, the alarms and
// the answer of its start's storage.sync access level.
//   - When (the scheduling, moved here from the Google Drive backup's worker, whose code is gone): SOON_MS after the
//     last change of the vault (the store's pointer, from any context; one alarm, re-armed), at most MAX_WAIT_MS after
//     the first of changes that keep coming; retries after 1, 5 and 30 minutes, then
//     the worker's six-hourly routine, which also runs a daily check when nothing changed (a slot Chrome's "clear data"
//     removed, room another computer freed). An error no retry fixes (status.ts csbStops) waits for the user, and for the
//     daily check. One run at a time, and one more after it when a change came meanwhile.
//   - Only where this worker's start closed storage.sync to content scripts (storage-access.ts restrictSyncAccess):
//     otherwise nothing runs and the backup cannot be turned on; the start wrote the diagnostics line, and the state
//     says so (`unsafe`) once a run, a page's message or the routine of a backup that is on has asked, for the card to
//     tell why nothing is written.
//   - A run writes the generation as the store reads it with no key (VaultStore.load, outside every lock): locked, in
//     "lock every time" mode, after a restart, all the same, in the cloud backup's file format (format.ts). It decides
//     and writes under the records' lock (webLock("sixkey-csb")). The store's recovery hook (cloud-mark.ts) takes that
//     lock, inside the store's own, before each recovery write, marks the link held and lets the lock go; the write lands
//     after. So a recovery write that lands while the run holds the lock had its hook run before the run took the lock,
//     and the run reads the mark: it holds (rule 3). It decides only on the generation on disk then: one a commit
//     replaced since the load is left to that commit's own run (watchVault arms it). Then slots.ts's rule over the area
//     as read (readArea): skip, hold (saved held, so that later saves cannot lift the counter past the link's), or write
//     one plan with one writeSlot, the link saved first (linkBefore: a worker stopped after the set knows the slot as
//     its own) and after (linkAfter); the chunks a shrunk slot leaves, and those a stopped worker left beside its own
//     intact slot, removed with removeLeftovers. The automatic run never removes a slot: removeSlot is for "turn off" and
//     for a merge's "remove them" alone (test/unit/source-rules.test.ts holds both). The card's numbers are worked out
//     after the lock is let go.
//   - Chrome's answers: a write-operation quota is "busy" and the area's bytes "no_room" (csb-area.ts errorOf), but only
//     if the area, read again, still has no room for the plan: another computer's shrink in flight (its new chunks here,
//     its leftovers not yet gone) can refuse one set that the next read shows fitting, and that is retried as "other".
//     "other" is retried, with Chrome's text in a diagnostics line. A malformed plan or key list (csb-area.ts AreaError,
//     slots.ts SlotError) is a bug: a diagnostics line, the error recorded, and no retry alarm.
//   - The settings page's messages (sk-csb-*, the page alone: sender-policy.ts): on, off, now, the switch, a restore's
//     adoption, a held slot's merge, a merge's removal of other slots. The merge and the adoption carry the save counter
//     and envelope checksum of the generation the page wrote, and are taken only while the vault on disk is still
//     exactly that generation: a copy put back, or a fallback, between the page's write and the handler keeps the link
//     held (the adoption: not taken), with a diagnostics line (the maintainers' call for CSB-3); the adoption also only
//     of a slot still whole under the tag the restore read and holding this vault, else its first write would overwrite
//     a slot that is not this vault's. These two lift or replace a hold, so the mark a recovery's hook has just written
//     must not be lost to them: they take the store's lock first (webLock("sixkey-vault")), then the records' lock, the
//     hook's own order. A recovery whose hook ran before they took the store's lock has landed its write by then (the
//     store keeps its lock from the hook to the write), and none can start until they let go: what they compare is the
//     vault on disk, and stays it.
import { CloudBackupError, makeCloudBackup, type CloudBackup, type CloudOpens } from "../core/cloud/format";
import {
  adoptSlot,
  assembleSlot,
  decideSlot,
  heldLink,
  leftovers,
  linkAfter,
  linkBefore,
  mergedLink,
  newSlotId,
  newTag,
  ownSlot,
  parseKey,
  planSlot,
  readSlots,
  room,
  slotLocal,
  SlotError,
  type SlotLink,
} from "../core/cloud/slots";
import { csbStops, type CsbError } from "../core/cloud/status";
import type { Random } from "../core/crypto/bytes";
import { activeGeneration } from "../core/storage/active-keyring";
import type { Generation } from "../core/storage/format";
import type { KV, Lock } from "../core/storage/kv";
import type { LoadResult } from "../core/storage/store";
import { AreaError, bytesInUse, readArea, removeLeftovers, removeSlot, writeSlot, type SyncArea } from "./csb-area";
import {
  CSB_CFG_KEY,
  CSB_STATE_KEY,
  NEW_CSB_STATE,
  parseCsbConfig,
  parseCsbState,
  type CsbConfig,
  type CsbState,
} from "./csb-config";

// ---- the scheduling (moved from the Google Drive backup's worker) -------------------------------------------------

/** The debounce: a write this long after the last change. */
export const SOON_MS = 30_000;
/** The retries' delays after the first, second and third failure in a row; later ones wait for the routine. */
export const RETRY_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000];
/** The daily check: a run when none happened for this long, changes or not. */
export const DAILY_MS = 24 * 60 * 60_000;
/** The debounce's ceiling: changes that keep coming wait at most this long after the first. */
export const MAX_WAIT_MS = 5 * 60_000;
/** The key the existing backup reminder reads (core/service/types.ts): a write handed to Chrome sync counts as a backup. */
export const LAST_BACKUP_KEY = "sk_last_backup";
/** The store's pointer (core/storage/format.ts KEYS.active): every commit, in any context, moves it. */
export const VAULT_POINTER = "sk_active";

export type Alarms = {
  create(name: string, info: { when: number }): Promise<void> | void;
  clear(name: string): Promise<unknown>;
};

/** What the scheduling needs of a backup: whether it is on, three fields of its state, and its run. */
export type ScheduleDeps = {
  on(): Promise<boolean>;
  state(): Promise<{ pendingSince: number | null; err: unknown; lastRun: number | null }>;
  /** pendingSince set to `at` unless it is set already, under the records' lock: the state's two fields after. */
  pending(at: number): Promise<{ pendingSince: number | null; err: unknown }>;
  /** One run. */
  once(): Promise<void>;
  alarms: Alarms;
  now(): number;
  soonMs: number;
  /** The debounce's and the retries' alarm names. */
  soon: string;
  retry: string;
};

/** A backup's scheduling: one run at a time, the debounce, the retries' alarm, the daily check. */
export function createSchedule(d: ScheduleDeps) {
  let running: Promise<void> | null = null;
  let again = false;
  /** The first change since the current run began: the time the next run's changes have waited since. */
  let changedInRun: number | null = null;

  /** One run, unless one is going: then one more after it (a change meanwhile is not lost). */
  function run(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = d
      .once()
      .catch(() => undefined)
      .finally(() => {
        running = null;
        if (again) {
          again = false;
          void run();
        }
      });
    return running;
  }

  return {
    run,
    /** Resolves when no run is going, the one more a change asked for included. */
    async idle(): Promise<void> {
      while (running) await running;
    },
    /** At a run's start: the changes from now on wait for the next run. */
    begin(): void {
      changedInRun = null;
    },
    /** The first change since the current run began, or null: what a run that went through leaves as pendingSince. */
    changedSince: (): number | null => changedInRun,
    /** A change of the vault: the run SOON_MS after the last one. Nothing while the backup is off. */
    async changed(): Promise<void> {
      if (!(await d.on())) return;
      if (running) changedInRun ??= d.now();
      const s = await d.pending(d.now());
      // at most MAX_WAIT_MS after the first change, unless failures wait for their own retries
      const soon = d.now() + d.soonMs;
      const when = s.err === null && s.pendingSince !== null ? Math.min(soon, s.pendingSince + MAX_WAIT_MS) : soon;
      await d.alarms.create(d.soon, { when });
    },
    /** The worker's alarms: true when the name was one of this backup's. */
    alarm(name: string): boolean {
      if (name !== d.soon && name !== d.retry) return false;
      void run();
      return true;
    },
    /**
     * The worker's six-hourly routine and every start: a run when changes wait with no alarm left for them (an alarm
     * lost), or when none ran for DAILY_MS (the daily check).
     */
    async routine(pendingAlarm: boolean): Promise<void> {
      if (!(await d.on())) return;
      const s = await d.state();
      const stale = s.lastRun === null || d.now() - s.lastRun >= DAILY_MS;
      if (stale || (s.pendingSince !== null && !pendingAlarm)) await run();
    },
    /** After a failure (the `retries`-th in a row): the next retry's alarm, unless no retry fixes it or none is left. */
    async retryAfter(retries: number, stops: boolean): Promise<void> {
      if (!stops && retries <= RETRY_MS.length)
        await d.alarms.create(d.retry, { when: d.now() + RETRY_MS[retries - 1]! });
    },
  };
}

/** A run that went through: the state's scheduling fields (`pending`: the first change since it began, or null). */
export const succeeded = (now: number, pending: number | null) => ({
  lastOk: now,
  err: null,
  errSince: null,
  pendingSince: pending,
  retries: 0,
  lastRun: now,
});

/** A run that failed with `err`: since when the errors run (the first of them), one more failure in a row. */
export const failedWith = <E>(
  s: { err: unknown; errSince: number | null; retries: number },
  err: E,
  startedAt: number,
  now: number,
) => ({
  err,
  errSince: s.err !== null && s.errSince !== null ? s.errSince : startedAt,
  retries: s.retries + 1,
  lastRun: now,
});

/**
 * The worker's watch on the vault for the debounce: a write of the store's pointer, whoever made it, calls `changed`,
 * which reads what it needs itself. Nothing of the change is read: only the name of the key.
 */
export function watchVault(area: chrome.storage.StorageArea, changed: () => Promise<void>): void {
  area.onChanged.addListener((changes) => {
    if (VAULT_POINTER in changes) void changed().catch(() => undefined);
  });
}

// ---- the backup in Chrome sync ----------------------------------------------------------------------------------------

export const CSB_SOON_ALARM = "sk-csb-soon";
export const CSB_RETRY_ALARM = "sk-csb-retry";
/** The most slots one "merge and remove them" names: more than the area can hold (512 items, 14 a slot at most). */
const MAX_DROP = 64;

export type CsbWorkerDeps = {
  /** storage.local: the two records, the backup reminder's time, and the store's slots (read here, never written). */
  kv: KV;
  /** The records' lock, the store's recovery hook's too (cloud-mark.ts). */
  lock: Lock;
  /**
   * The store's own lock (webLock("sixkey-vault")), taken before the records' lock by the two handlers that lift or
   * replace a hold, as the store takes it before its recovery hook takes the records' lock.
   */
  vaultLock: Lock;
  /** The store's load (VaultStore.load): the generation with no key, through the store's recovery ladder if it must. */
  load(): Promise<LoadResult>;
  alarms: Alarms;
  now(): number;
  app: string;
  /** Whether this worker's start closed storage.sync to content scripts (restrictSyncAccess's answer, C7). */
  access(): Promise<boolean>;
  /** One diagnostics line. */
  note(line: string): void;
  soonMs?: number;
  /** storage.sync; absent: csb-area.ts's default, Chrome's. */
  area?: SyncArea;
  /** Random bytes for slot ids and tags; absent: slots.ts's default. */
  rng?: Random;
};

/** What a file's refusal means for the status line (status.ts): a device key or no wrap to open it, or damage. */
const fileError = (e: unknown): CsbError =>
  e instanceof CloudBackupError && (e.code === "device_key" || e.code === "no_wrap") ? "no_password" : "unreadable";

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const SLOT_RE = /^[a-z0-9]{8}$/;
const TAG_RE = /^[0-9a-f]{16}$/;
const SUM_RE = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const WRAPS_RE = /^[a-z]{1,16}:[A-Za-z0-9+/=]{1,64}(?:,[a-z]{1,16}:[A-Za-z0-9+/=]{1,64}){0,15}$/;
const isSlot = (x: unknown): x is string => typeof x === "string" && SLOT_RE.test(x);
const isTag = (x: unknown): x is string => typeof x === "string" && TAG_RE.test(x);
const isSeq = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const isSum = (x: unknown): x is string => typeof x === "string" && SUM_RE.test(x);

/** The generation a page wrote, as its message names it: its save counter and its envelope's checksum. */
type Wrote = { seq: number; sum: string };
const isThat = (g: Generation | null, w: Wrote): g is Generation =>
  g !== null && g.seq === w.seq && g.envelope.checksum === w.sum;
/** A link without its hold. */
const unheld = ({ held: _held, ...rest }: SlotLink): SlotLink => rest;

/** sk-csb-restored: the slot a restore continues, the tag it read there, what the file holds, and what it wrote. */
type Restored = Wrote & { slot: string; gen: string; opens: CloudOpens; wraps: string; dirty: boolean };
function parseRestored(m: unknown): Restored | null {
  if (!isRecord(m)) return null;
  const { slot, gen, seq, sum, opens, wraps, dirty } = m;
  if (!isSlot(slot) || !isTag(gen) || !isSeq(seq) || !isSum(sum) || typeof dirty !== "boolean") return null;
  if ((opens !== "both" && opens !== "recovery") || typeof wraps !== "string" || !WRAPS_RE.test(wraps)) return null;
  return { slot, gen, seq, sum, opens, wraps, dirty };
}

/** sk-csb-merged: the held slot and the tag the page read there (null: none), and the generation the merge wrote. */
type Merged = Wrote & { slot: string; gen: string | null };
function parseMerged(m: unknown): Merged | null {
  if (!isRecord(m)) return null;
  const { slot, gen, seq, sum } = m;
  if (!isSlot(slot) || !(gen === null || isTag(gen)) || !isSeq(seq) || !isSum(sum)) return null;
  return { slot, gen, seq, sum };
}

/** sk-csb-drop: the slots a page merged, each with the tag it read, to remove, and the generation the merge wrote. */
type Drop = Wrote & { slots: { slot: string; gen: string }[] };
function parseDrop(m: unknown): Drop | null {
  if (!isRecord(m) || !Array.isArray(m.slots) || m.slots.length === 0 || m.slots.length > MAX_DROP) return null;
  if (!isSeq(m.seq) || !isSum(m.sum)) return null;
  const slots: { slot: string; gen: string }[] = [];
  for (const s of m.slots) {
    if (!isRecord(s) || !isSlot(s.slot) || !isTag(s.gen) || slots.some((o) => o.slot === s.slot)) return null;
    slots.push({ slot: s.slot, gen: s.gen });
  }
  return { seq: m.seq, sum: m.sum, slots };
}
/** What a removal did: the slots removed and those kept, or why none was. */
type DropAnswer =
  { ok: true; removed: string[]; kept: string[] } | { ok: false; why: string; removed: []; kept: string[] };

type Area = { items: Record<string, unknown>; inUse: number };
/** What the card's numbers are worked out from, once the lock is let go: the area as read (null: read it again). */
type View = { area: Area | null; link: SlotLink | null; vaultId: string };
/** What one run ended with, under the lock; written down by `recordRun`. */
type Outcome =
  | { kind: "off" }
  | { kind: "stale" }
  | { kind: "wrote"; view: View }
  | { kind: "skipped"; view: View }
  | { kind: "failed"; err: CsbError; view: View | null; bug?: true };
type Stats = Pick<CsbState, "bytes" | "used" | "others" | "seen">;
type Answer = { ok: true } | { ok: false; why: string };

export function createCsbWorker(d: CsbWorkerDeps) {
  const cfgOf = async (): Promise<CsbConfig> => parseCsbConfig((await d.kv.get([CSB_CFG_KEY]))[CSB_CFG_KEY]);
  const stateOf = async (): Promise<CsbState> => parseCsbState((await d.kv.get([CSB_STATE_KEY]))[CSB_STATE_KEY]);
  const putCfg = (c: CsbConfig) => d.kv.set({ [CSB_CFG_KEY]: c });
  const putState = (s: CsbState) => d.kv.set({ [CSB_STATE_KEY]: s });
  /** Read, change and write one record under the records' lock. */
  const editCfg = (fn: (c: CsbConfig) => CsbConfig) =>
    d.lock(async () => {
      const next = fn(await cfgOf());
      await putCfg(next);
      return next;
    });
  const editState = (fn: (s: CsbState) => CsbState) =>
    d.lock(async () => {
      const next = fn(await stateOf());
      await putState(next);
      return next;
    });
  /**
   * The store's lock, then the records' lock: no commit and no recovery write, in any context, can run while `fn` runs
   * (every one of them holds the store's lock, and a recovery's hook takes the records' lock inside it), so the vault on
   * disk that `fn` reads stays the vault on disk until it returns. The order is the hook's: no deadlock. `fn` calls no
   * store method (the store's lock is not re-entrant).
   */
  const lockedFromStore = <T>(fn: () => Promise<T>): Promise<T> => d.vaultLock(() => d.lock(fn));

  const sched = createSchedule({
    on: async () => (await cfgOf()).on,
    state: stateOf,
    pending: (at) => editState((s) => ({ ...s, pendingSince: s.pendingSince ?? at })),
    once,
    alarms: d.alarms,
    now: d.now,
    soonMs: d.soonMs ?? SOON_MS,
    soon: CSB_SOON_ALARM,
    retry: CSB_RETRY_ALARM,
  });

  /**
   * The card's numbers, worked out after the records' lock is let go (they are only read, and hashing every slot need
   * not hold up a recovery waiting for that lock): this device's slot, the whole area, the other slots, the evidence.
   */
  async function statsOf(view: View): Promise<Stats> {
    const area = view.area ?? (await readArea(d.area));
    const link = view.link;
    const { slots } = await readSlots(area.items);
    const own = slots.find((s) => s.slot === link?.slot);
    const others = slots.filter((s) => s !== own);
    const whole = others.flatMap((s) => (s.read.kind === "ok" ? [s.read] : []));
    return {
      bytes: own ? await bytesInUse(own.keys, d.area) : null,
      used: area.inUse,
      others: {
        n: others.length,
        bytes: others.length
          ? await bytesInUse(
              others.flatMap((s) => s.keys),
              d.area,
            )
          : 0,
        otherVaults: whole.filter((a) => a.backup.generation.envelope.vaultId !== view.vaultId).length,
        latest: whole.length ? Math.max(...whole.map((a) => a.manifest.t)) : null,
      },
      // a slot this device did not create came through sync (an adopted one too: it was restored from it)
      seen: slots.some((s) => !(link?.mine ?? []).includes(s.slot)),
    };
  }

  /**
   * Whether this worker's start closed storage.sync to content scripts (nothing is written in its life otherwise),
   * written down in the state (`unsafe`) when the state says otherwise, for the card.
   */
  async function gate(): Promise<boolean> {
    const ok = await d.access();
    if ((await stateOf()).unsafe === ok) await editState((s) => ({ ...s, unsafe: !ok }));
    return ok;
  }

  /** One run: the header's steps. The load comes first and outside every lock; the numbers come after the lock. */
  async function once(): Promise<void> {
    if (!(await cfgOf()).on) return;
    if (!(await gate())) return; // not closed to web pages in this worker's life (its start wrote the diagnostics line)
    const startedAt = d.now();
    sched.begin();
    const loaded = await d.load().catch(() => ({ status: "lost" }) as const);
    if (loaded.status === "empty") return; // nothing to back up yet (no vault)
    const outcome: Outcome =
      loaded.status === "ok"
        ? await d
            .lock(() => decideAndWrite(loaded.gen))
            .catch((e: unknown): Outcome => {
              // a malformed plan or key list is a bug: written down, never retried by an alarm
              if (e instanceof AreaError || e instanceof SlotError) {
                d.note(`csb: bug: ${e.name} ${e.code}: ${e.message}`);
                return { kind: "failed", err: "other", view: null, bug: true };
              }
              d.note(`csb: a run failed: ${e instanceof Error ? e.message : String(e)}`); // a read of the area, say
              return { kind: "failed", err: "other", view: null };
            })
        : { kind: "failed", err: "unreadable", view: null };
    const view = outcome.kind === "off" || outcome.kind === "stale" ? null : outcome.view;
    const stats = view ? await statsOf(view).catch((): Stats | null => null) : null;
    await recordRun(outcome, stats, startedAt);
  }

  /**
   * The run's decision and its one write, under the records' lock. No store call in here: the store's recovery hook
   * takes this lock inside the store's, so the order is the store's lock, then this one, never the other way.
   */
  async function decideAndWrite(loaded: Generation): Promise<Outcome> {
    const cfg = await cfgOf();
    if (!cfg.on) return { kind: "off" };
    // the generation on disk now: one a commit replaced since the load is left to that commit's own run (watchVault
    // armed it), and one that cannot be read the way the store reads it first is the next load's to recover
    const current = await activeGeneration(d.kv);
    if (!isThat(current, { seq: loaded.seq, sum: loaded.envelope.checksum })) return { kind: "stale" };
    let backup: CloudBackup;
    try {
      backup = await makeCloudBackup(loaded, cfg.opens, d.app);
    } catch (e) {
      return { kind: "failed", err: fileError(e), view: null };
    }
    const local = slotLocal(backup);
    const area = await readArea(d.area);
    // A link of another vault than the one on disk (started over, or another vault restored from a file over this one,
    // both over data that could not be read, which the store's recovery hook marked held): its slot is that vault's,
    // perhaps its only copy, and this vault gets a slot of its own (rule 6 forks; rule 4 writes one where none is), so
    // the hold protects nothing of this vault, and it is not let stop it. Nothing of that slot is touched.
    const link = cfg.link?.held && cfg.link.vaultId !== local.vaultId ? unheld(cfg.link) : cfg.link;
    const read = link ? await assembleSlot(area.items, link.slot) : null;
    const own = read ? ownSlot(read) : null;
    const decision = decideSlot(local, link, own);
    const view = (a: Area | null, l: SlotLink | null): View => ({ area: a, link: l, vaultId: local.vaultId });

    if (decision.kind === "skip") {
      // its own intact slot (rule 8 checked the tag; an empty vault's skip checked nothing): the chunks past its count
      // that a worker stopped between its set and its remove left
      if (decision.why === "unchanged" && read?.kind === "ok") {
        const left = leftovers(area.items, link!.slot, read.manifest.n);
        if (left.length) noteRefusal(await removeLeftovers(link!.slot, read.manifest.n, left, d.area));
      }
      return { kind: "skipped", view: view(area, link) };
    }
    if (decision.kind === "hold") {
      // saved held, so that saves made since cannot lift the counter past the link's and let a later run overwrite
      const held = heldLink(link!);
      if (!link!.held) await putCfg({ ...cfg, link: held });
      return { kind: "failed", err: "held", view: view(area, held) };
    }
    const taken = new Set(Object.keys(area.items).flatMap((k) => parseKey(k)?.slot ?? []));
    const slot = decision.to === "new" ? newSlotId(taken, d.rng) : link!.slot;
    const plan = await planSlot(backup, slot, newTag(d.rng));
    if (plan.kind === "too_large") return { kind: "failed", err: "too_large", view: view(area, link) };
    if (room(plan, area.items, area.inUse).kind === "no_room")
      return { kind: "failed", err: "no_room", view: view(area, link) };
    const before = linkBefore(link, own, decision, plan);
    await putCfg({ ...cfg, link: before });
    const w = await writeSlot(plan, d.area);
    if (!w.ok) {
      if (w.refusal === "QUOTA_BYTES") {
        // the area as it is now: no room for the plan in it is no_room; room in it means another computer's shrink was
        // in flight (its new chunks here, its leftovers not yet gone), a passing refusal
        const now = await readArea(d.area);
        const fits = room(plan, now.items, now.inUse).kind === "ok";
        if (fits) d.note("csb: Chrome refused a write for the area's bytes, and the area has room for it now");
        return { kind: "failed", err: fits ? "other" : "no_room", view: view(now, before) };
      }
      noteRefusal(w);
      return { kind: "failed", err: w.error, view: view(area, before) };
    }
    // a slot that shrank: its chunks past the plan's count, as the area was read (the set left them)
    const left = leftovers(area.items, plan.slot, plan.manifest.n);
    if (left.length) noteRefusal(await removeLeftovers(plan.slot, plan.manifest.n, left, d.area));
    const after = linkAfter(link, decision, plan);
    await putCfg({ ...cfg, link: after });
    await d.kv.set({ [LAST_BACKUP_KEY]: d.now() }); // the backup reminder counts a write handed to Chrome sync (C4)
    return { kind: "wrote", view: view(null, after) }; // (the area read again for the numbers, after the lock)
  }

  /** Chrome's "other" refusal of a write or a remove, in a diagnostics line with its text. */
  function noteRefusal(r: { ok: true } | { ok: false; error: CsbError; message: string }): void {
    if (!r.ok && r.error === "other") d.note(`csb: Chrome refused: ${r.message}`);
  }

  /** What a run ended with, in the state record, and the retry's alarm. */
  async function recordRun(o: Outcome, numbers: Stats | null, startedAt: number): Promise<void> {
    if (o.kind === "off" || o.kind === "stale") return;
    const now = d.now();
    const pending = sched.changedSince();
    const stats = (s: CsbState) => (numbers ? { ...numbers, seen: s.seen || numbers.seen } : {});
    const s = await editState((s) =>
      o.kind === "wrote"
        ? { ...s, ...succeeded(now, pending), ...stats(s) }
        : o.kind === "skipped"
          ? // the slot already holds what the vault holds: nothing waits, nothing failed; lastOk stays the last write's
            { ...s, err: null, errSince: null, pendingSince: pending, retries: 0, lastRun: now, ...stats(s) }
          : { ...s, ...failedWith(s, o.err, startedAt, now), ...stats(s) },
    );
    if (o.kind !== "failed") await d.alarms.clear(CSB_RETRY_ALARM);
    else if (!o.bug) await sched.retryAfter(s.retries, csbStops(o.err));
  }

  /**
   * sk-csb-off (C3): off, and this device's own slot removed, but while it is held (it may be newer than this data).
   * "Its own" is the slot under a tag this device wrote or is writing (the link's `gen` or `pending`); a slot under
   * another tag was taken over by another computer (rule 5) and stays, and so do chunks with no manifest beside them
   * (another computer's write may be arriving). A slot another computer adopted at a restore but has not written yet
   * still carries this device's tag, and goes: that computer writes it again at its next change, or at its daily check
   * at the latest (rule 4), and until then Chrome sync holds no copy of it.
   */
  async function turnOff(): Promise<{ ok: true; removed: boolean }> {
    const removed = await d.lock(async () => {
      const cfg = await cfgOf();
      await putCfg({ ...cfg, on: false, declined: true });
      const link = cfg.link;
      if (!link || link.held) return false;
      // a link of another vault than the one on disk (started over, or another vault restored from a file): that slot
      // is the old vault's, perhaps its only copy, and stays; so does the link (a run of this vault forks, and the ids
      // this device created stay known: the old slot is never taken for another computer's)
      const now = await activeGeneration(d.kv).catch(() => null);
      if (!now || now.envelope.vaultId !== link.vaultId) return false;
      const area = await readArea(d.area).catch(() => null);
      const own = area ? ownSlot(await assembleSlot(area.items, link.slot)) : null;
      if (!own || (own.g !== link.gen && own.g !== link.pending)) return false;
      return (await removeSlot(link.slot, d.area)).ok;
    });
    await d.alarms.clear(CSB_SOON_ALARM);
    await d.alarms.clear(CSB_RETRY_ALARM);
    return { ok: true, removed };
  }

  /**
   * sk-csb-drop (the explicit "merge them into this computer and remove them"): the slots a page opened and merged into
   * this vault, each named with the tag it was read under, and the generation that merge wrote (`seq`, `sum`). Under the
   * store's lock, then the records' lock, as the merge and the adoption: taken only while the vault on disk is still that
   * generation (a fallback since then lost what the merge brought in, and removing the slots would lose it twice: none is
   * removed, and the page merges again), and only if this device's copy of the vault fits in the area once they are gone
   * (else Chrome sync would be left with neither: none is removed). Then each is removed only while it is still whole
   * under the tag the page read; this device's own slot never. The rest are kept.
   */
  async function dropSlots(m: unknown): Promise<DropAnswer> {
    const r = parseDrop(m);
    if (!r) return { ok: false, why: "bad_message", removed: [], kept: [] };
    const all = r.slots.map((s) => s.slot);
    const out = await lockedFromStore(async (): Promise<DropAnswer> => {
      const gen = await activeGeneration(d.kv);
      if (!isThat(gen, r)) {
        d.note("csb: a merge's removal not taken: the vault on disk is not the one the merge wrote");
        return { ok: false, why: "not_that_generation", removed: [], kept: all };
      }
      const cfg = await cfgOf();
      const area = await readArea(d.area);
      const going: string[] = [];
      for (const { slot, gen: g } of r.slots) {
        const a = await assembleSlot(area.items, slot);
        if (slot !== cfg.link?.slot && a.kind === "ok" && a.manifest.g === g) going.push(slot);
      }
      if (!(await fitsWithout(gen, cfg, area, going))) {
        d.note("csb: a merge's removal not taken: this device's copy would not fit even without those slots");
        return { ok: false, why: "would_not_fit", removed: [], kept: all };
      }
      const removed: string[] = [];
      const kept: string[] = [];
      for (const slot of all) (going.includes(slot) && (await removeSlot(slot, d.area)).ok ? removed : kept).push(slot);
      return { ok: true, removed, kept };
    });
    if (out.removed.length) void sched.run(); // the room it freed
    return out;
  }

  /**
   * Whether this device's copy of `gen` fits in the area (slots.ts planSlot and room) once the slots `going` are gone:
   * planned under its own slot when the link is this vault's, else as the new slot the next run would make.
   */
  async function fitsWithout(gen: Generation, cfg: CsbConfig, area: Area, going: readonly string[]): Promise<boolean> {
    let backup: CloudBackup;
    try {
      backup = await makeCloudBackup(gen, cfg.opens, d.app);
    } catch {
      return false; // a copy this device cannot write (a device key, damage): removing others frees nothing for it
    }
    const gone = Object.keys(area.items).filter((k) => going.includes(parseKey(k)?.slot ?? ""));
    const items = Object.fromEntries(Object.entries(area.items).filter(([k]) => !gone.includes(k)));
    const inUse = area.inUse - (gone.length ? await bytesInUse(gone, d.area) : 0);
    const link = cfg.link;
    const taken = new Set(Object.keys(area.items).flatMap((k) => parseKey(k)?.slot ?? []));
    const slot = link && link.vaultId === gen.envelope.vaultId ? link.slot : newSlotId(taken, d.rng);
    const plan = await planSlot(backup, slot, newTag(d.rng));
    return plan.kind === "plan" && room(plan, items, inUse).kind === "ok";
  }

  /**
   * sk-csb-restored: a page restored this device from slots and wrote the vault (`seq`, `sum`): this device continues
   * `slot` from the tag it read there (slots.ts adoptSlot), with the file's wraps, so a restore that changed the keys
   * (a new master password after the recovery key) writes at the first run; `dirty` when it merged more than one slot.
   * Turned on, as the restore says. Taken only while the vault on disk is still the one the restore wrote, and the slot
   * is still whole, under that tag, holding a copy of this vault: else the next write would overwrite a slot that is
   * not this vault's. A slot this device did not create is the evidence that sync carries the area.
   */
  async function adopt(m: unknown): Promise<Answer> {
    const r = parseRestored(m);
    if (!r) return { ok: false, why: "bad_message" };
    if (!(await gate())) return { ok: false, why: "unsafe_area" };
    const out = await lockedFromStore(async (): Promise<Answer> => {
      const gen = await activeGeneration(d.kv);
      if (!isThat(gen, r)) {
        d.note("csb: a restore's adoption not taken: the vault on disk is not the one the restore wrote");
        return { ok: false, why: "not_that_generation" };
      }
      const a = await assembleSlot((await readArea(d.area)).items, r.slot);
      if (a.kind !== "ok" || a.manifest.g !== r.gen) {
        d.note("csb: a restore's adoption not taken: the slot is not whole under the tag the restore read");
        return { ok: false, why: "slot_changed" };
      }
      if (a.backup.generation.envelope.vaultId !== gen.envelope.vaultId) {
        d.note("csb: a restore's adoption not taken: the slot holds another vault");
        return { ok: false, why: "other_vault" };
      }
      let backup: CloudBackup;
      try {
        backup = await makeCloudBackup(gen, r.opens, d.app);
      } catch {
        return { ok: false, why: "unreadable" };
      }
      const cfg = await cfgOf();
      const link = adoptSlot(cfg.link, r.slot, r.gen, { ...slotLocal(backup), wraps: r.wraps }, r.dirty);
      await putCfg({ ...cfg, on: true, opens: r.opens, declined: false, link });
      const seen = (await stateOf()).seen || !link.mine.includes(r.slot); // (adoptSlot keeps this device's own ids)
      const now = d.now();
      await putState({ ...NEW_CSB_STATE, lastOk: now, lastRun: now, seen });
      return { ok: true };
    });
    if (out.ok) void sched.run();
    return out;
  }

  /**
   * sk-csb-merged: a page merged the held slot (`gen`: the tag it read there) into this vault and wrote the merge
   * (`seq`, `sum`). The link is re-based on it (slots.ts mergedLink) only while the vault on disk, read under the
   * store's lock and the records' lock, is still exactly that generation; otherwise it stays held, with a line.
   */
  async function merge(m: unknown): Promise<Answer> {
    const r = parseMerged(m);
    if (!r) return { ok: false, why: "bad_message" };
    const out = await lockedFromStore(async (): Promise<Answer> => {
      const cfg = await cfgOf();
      const link = cfg.link;
      if (!link?.held) return { ok: false, why: "not_held" };
      const gen = await activeGeneration(d.kv);
      if (!isThat(gen, r)) {
        d.note("csb: a merge of the held slot not taken: the vault on disk is not the one the merge wrote");
        return { ok: false, why: "not_that_generation" };
      }
      let backup: CloudBackup;
      try {
        backup = await makeCloudBackup(gen, cfg.opens, d.app);
      } catch {
        return { ok: false, why: "unreadable" };
      }
      const area = await readArea(d.area);
      const own = ownSlot(await assembleSlot(area.items, link.slot));
      const next = mergedLink(link, slotLocal(backup), { slot: r.slot, g: r.gen }, own);
      if (next === link) return { ok: false, why: "slot_changed" }; // another write there, or not whole: merge again
      await putCfg({ ...cfg, link: next });
      const s = await stateOf();
      await putState({ ...s, err: null, errSince: null, retries: 0, pendingSince: s.pendingSince ?? d.now() });
      return { ok: true };
    });
    if (out.ok) void sched.run();
    return out;
  }

  return {
    run: sched.run,
    idle: sched.idle,
    changed: sched.changed,
    alarm: sched.alarm,
    /** The worker's routine and every start (the schedule's), that answer written down first while the backup is on. */
    async routine(pendingAlarm: boolean): Promise<void> {
      if ((await cfgOf()).on) await gate();
      await sched.routine(pendingAlarm);
    },
    /** sk-csb-on: on (no unlock needed) and a run now. Refused where storage.sync could not be closed (C7). */
    async on(): Promise<Answer> {
      if (!(await gate())) return { ok: false, why: "unsafe_area" };
      await editCfg((c) => ({ ...c, on: true, declined: false }));
      await editState((s) => ({
        ...s,
        err: null,
        errSince: null,
        retries: 0,
        pendingSince: s.pendingSince ?? d.now(),
      }));
      void sched.run();
      return { ok: true };
    },
    off: turnOff,
    /**
     * sk-csb-now: a run now, answered once it and any run a change asked for meanwhile are done; "off" or "unsafe_area"
     * when no run would do anything.
     */
    async now(): Promise<Answer> {
      if (!(await cfgOf()).on) return { ok: false, why: "off" };
      if (!(await gate())) return { ok: false, why: "unsafe_area" };
      await sched.run();
      await sched.idle();
      return { ok: true };
    },
    /** sk-csb-opens: the switch "只用恢复密钥打开", kept, and written at once while on. */
    async opens(x: unknown): Promise<boolean> {
      if (x !== "both" && x !== "recovery") return false;
      const c = await editCfg((c) => ({ ...c, opens: x }));
      if (c.on) void sched.run();
      return true;
    },
    restored: adopt,
    merged: merge,
    drop: dropSlots,
  };
}

export type CsbWorker = ReturnType<typeof createCsbWorker>;
