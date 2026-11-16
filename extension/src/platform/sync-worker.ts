// The service worker's side of sync (SYNC-DESIGN §3.11, §4.8, §4.9; M5): when the engine runs here, the one network
// transport, and the toolbar badge. The engine decides everything (core/sync/engine/: what a round does, when the next
// one is due, the backoff); this module only turns its decisions into timers and alarms and its state into the badge.
//
// Who signs (SYNC-DESIGN §4.9, §4.14): a page signs its own requests, and the worker relays a finished request without
// signing it, storing it or inspecting it beyond four checks: the sender, the shape, the origin pin and the target
// exactly as signed. The worker signs only its own rounds, pushes and polls.
//
// MV3 lifetime. The worker can be stopped whenever it is idle, and nothing here is kept between events that matters:
// the engine keeps what must survive in sk_sync_state (the pending "sync soon", the failure count and the end of the
// backoff, the server clock offset), and a new worker reads it back.
//   - A wake under 30 s is a setTimeout (an MV3 worker lives at least that long after its last event); from 30 s on it is
//     a chrome.alarms alarm, which survives the worker being stopped (schedule.ts wakeAt).
//   - Every worker start calls the engine's start(), which schedules a round when there is something to send (an
//     outbox, an orphan entry, a vault changed since the last sync) and not before a running backoff ends, so a timer
//     lost with a stopped worker is not a lost upload.
//   - The 30-minute periodic alarm exists only while sync is on, with a random first delay (1 to 30 minutes) so that
//     dozens of profiles started together do not ask the server at once.
//   - While a request is out, the worker calls a cheap extension API every 20 s: Chrome stops a worker that has seen no
//     event or extension API call for 30 s, a long upload included. The transport's own timeout (60 s) bounds this.
// Triggers: a page's commit with sync on ("sync soon", runtime.ts), a page showing the unlocked vault (a round when the
// last success is over 30 s old, §4.8, and no keyless round was tried in the last 30 s while the key is still
// elsewhere), the alarms, the worker's start,
// a page telling the worker that it changed sync's state itself ("changed": the badge and the periodic alarm are
// brought up to date), and the API host permission granted or withdrawn (chrome.permissions.onAdded / onRemoved).
//
// The network switch (§4.9, revisions 21 and 22; api-permission.ts): every request this worker sends, its own or a page's
// through the bridge, first asks whether the API host permission is granted, and so does the engine in every round and
// push, after the steps that send nothing (the local stops, step 0's orphan fold) and before its first request.
// Withdrawn: the status is permission_removed at once (onRemoved) and nothing is sent; a round still does its local upkeep
// first (the steps before the engine's check), and nothing is lost; granted
// again (onAdded): a round. At a browser start, a permission still granted without a sync configuration (an enable or
// join flow whose tab closed before it finished) is removed, if Chrome lists exactly the API pattern (never a broad grant
// made for autofill in Chrome's menus, which covers the API origin too).
//
// The badge (§3.11): the number of devices waiting for approval, from the count the last status query stored; nothing
// while sync is off, and nothing in a state where no round asks the server's status, so no count would be refreshed:
// update_required, rejected_by_server, permission_removed, and the local stops (identity_missing, damaged, wrong_origin,
// cloud_restore, join_unfinished). The badge alone says nothing to a screen reader, so the toolbar button's title says
// it in words while it shows (M6: "Sixkey · devices waiting for approval: 2"), and is "Sixkey" again otherwise. The
// worker has no catalog of its own: the words come from chrome.i18n, in the browser's language.
import {
  PERIODIC_MINUTES,
  periodicPhaseMinutes,
  type Scheduler,
  type Wake,
  type WakeName,
} from "../core/sync/engine/schedule";
import type { SyncEngine } from "../core/sync/engine/engine";
import type { StateView, SyncStatus } from "../core/sync/engine/state";
import type { HttpRequest, HttpResponse, Transport } from "../core/sync/engine/transport";
import { API_ORIGIN } from "./api-origin";
import {
  apiGrantedExactly,
  apiPermissionGranted,
  apiPermissionRequired,
  permissionGated,
  removeApiPermission,
  type PermissionsLike,
} from "./api-permission";
import { FetchTransport } from "./fetch-transport";
import type { GrantList } from "./permission-grants";
import type { Runtime } from "./runtime";
import { createSyncEngine, cryptoRandom } from "./sync-engine";
import { badge } from "./badge";

/** The alarms of sync: one per engine wake, and the periodic round. */
export const SYNC_ALARMS: Readonly<Record<WakeName | "periodic", string>> = {
  sync: "sk-sync-sync",
  kick: "sk-sync-kick",
  retry: "sk-sync-retry",
  periodic: "sk-sync-periodic",
};
const WAKE_OF: Readonly<Record<string, WakeName>> = {
  "sk-sync-sync": "sync",
  "sk-sync-kick": "kick",
  "sk-sync-retry": "retry",
  "sk-sync-periodic": "sync",
};
/** A page showing the vault asks for a round only when the last success is older than this (§4.8). */
export const STALE_MS = 30_000;
export const KEEPALIVE_MS = 20_000;

/** The chrome.* calls this module makes (tests pass fakes). */
export type WorkerChrome = {
  alarms: {
    create(
      name: string,
      info: { when?: number; delayInMinutes?: number; periodInMinutes?: number },
    ): Promise<void> | void;
    clear(name: string): Promise<boolean>;
    get(name: string): Promise<{ name: string } | undefined>;
  };
  setBadgeText(text: string): Promise<void>;
  /** The toolbar button's title (chrome.action.setTitle), the badge in words; absent, the title is left alone. */
  setBadgeTitle?(title: string): Promise<void>;
  /** Any cheap extension API call (chrome.runtime.getPlatformInfo): it resets the worker's idle timer. */
  ping(): Promise<unknown>;
  /** chrome.permissions: the API host permission (api-permission.ts), and getAll for the exact grant (browserStarted). */
  permissions: PermissionsLike & GrantList;
};

/** The states in which no round asks the server's status, so the stored count is not refreshed (§3.11). */
const NO_COUNT: ReadonlySet<SyncStatus> = new Set<SyncStatus>([
  "off",
  "update_required",
  "rejected_by_server",
  "permission_removed",
  "identity_missing",
  "damaged",
  "wrong_origin",
  "cloud_restore",
  "join_unfinished",
]);

/** The toolbar button's title for a badge text: the manifest's title, or the badge in words (`words`: chrome.i18n's). */
export function badgeTitle(text: string, words: (count: string) => string): string {
  return text ? words(text) : "Sixkey";
}

/** The badge text for a sync state (§3.11): the pending enrolments, or nothing. */
export function badgeText(
  v: Pick<StateView, "syncOn"> & { state: Pick<StateView["state"], "status" | "pendingEnrollments"> },
): string {
  if (!v.syncOn) return "";
  if (v.state.status !== undefined && NO_COUNT.has(v.state.status)) return "";
  const n = v.state.pendingEnrollments ?? 0;
  if (!Number.isSafeInteger(n) || n <= 0) return "";
  return n > 99 ? "99+" : String(n);
}

/** A transport that keeps the worker alive while any request it carries is out (see the top of this file). */
export function keptAliveWhileSending(t: Transport, ping: () => Promise<unknown>, everyMs = KEEPALIVE_MS): Transport {
  let out = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    async send(req: HttpRequest): Promise<HttpResponse> {
      if (out++ === 0) timer = setInterval(() => void ping().catch(() => undefined), everyMs);
      try {
        return await t.send(req);
      } finally {
        if (--out === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      }
    },
  };
}

/** The engine's wakes as timers and alarms (§4.8). A later wake of the same name replaces the earlier one. */
export class WorkerScheduler implements Scheduler {
  private readonly timers = new Map<WakeName, ReturnType<typeof setTimeout>>();
  /** Called when a timer fires (alarms arrive through SyncWorker.alarm). Set by SyncWorker. */
  onWake: (name: WakeName) => void = () => undefined;

  constructor(
    private readonly c: WorkerChrome,
    private readonly now: () => number = Date.now,
  ) {}

  schedule(name: WakeName, wake: Wake): void {
    this.stopTimer(name);
    if (wake.via === "timeout") {
      void Promise.resolve(this.c.alarms.clear(SYNC_ALARMS[name])).catch(() => undefined);
      this.timers.set(
        name,
        setTimeout(
          () => {
            this.timers.delete(name);
            this.onWake(name);
          },
          Math.max(0, wake.at - this.now()),
        ),
      );
    } else {
      void Promise.resolve(this.c.alarms.create(SYNC_ALARMS[name], { when: Math.max(wake.at, this.now()) })).catch(
        () => undefined,
      );
    }
  }

  cancel(name: WakeName): void {
    this.stopTimer(name);
    void Promise.resolve(this.c.alarms.clear(SYNC_ALARMS[name])).catch(() => undefined);
  }

  private stopTimer(name: WakeName): void {
    const t = this.timers.get(name);
    if (t !== undefined) clearTimeout(t);
    this.timers.delete(name);
  }
}

export class SyncWorker {
  private badgeShown: string | null = null;
  /**
   * When this worker last started a page-shown round. Two renders arrive together (one message each), and the stored
   * attempt time is written only when the first round ends: without this, the second would find the sync lock taken,
   * ask the first round to run again, and cost a second status query.
   */
  private shownAt: number | null = null;

  /**
   * `permissionRequired`: the build declares the API host permission as required (the e2e build), so there is none to
   * remove at a browser start. `keyHere`: whether this worker holds the vault key now (its session).
   */
  constructor(
    private readonly o: {
      engine: SyncEngine;
      scheduler: WorkerScheduler;
      chrome: WorkerChrome;
      transport: Transport;
      permissionRequired?: boolean;
      keyHere: () => Promise<boolean>;
      now?: () => number;
      random?: () => number;
      words?: (count: string) => string;
    },
  ) {
    o.scheduler.onWake = (name) => void this.run(() => o.engine.wake(name)).catch(() => undefined);
  }

  /** The transport pages use through the bridge (bridge-worker.ts): the same one the worker's own rounds use. */
  get transport(): Transport {
    return this.o.transport;
  }

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Every worker start. With sync off: one read, then the periodic alarm and the badge cleared. */
  async start(): Promise<void> {
    const v = await this.o.engine.view();
    if (v.syncOn) await this.o.engine.start();
    await this.settle(v);
  }

  /** A chrome.alarms alarm fired: true when it was one of sync's. */
  async alarm(name: string): Promise<boolean> {
    const wake = WAKE_OF[name];
    if (!wake) return false;
    await this.run(() => this.o.engine.wake(wake));
    return true;
  }

  /**
   * A page committed with sync on (§4.8): the engine persists the request and schedules the debounced round. A message
   * that arrives with sync off (sent before a turn-off, or by an older page) schedules nothing.
   */
  async soon(): Promise<void> {
    if (!(await this.o.engine.view()).syncOn) return;
    await this.o.engine.kick();
  }

  /**
   * A page shows the unlocked vault (§4.8): a round in the background when the last success is over 30 s old. The popup
   * says so at every render of its list, so the round is also held back:
   *   - while the last page-shown round this worker started is under 30 s old (two renders arrive together);
   *   - while a keyless round is under 30 s old (the stored status is one a round without the key ends with, `locked` or
   *     `identity_missing`, and its lastAttemptAt is recent) and this worker still has no key: such a worker only ever
   *     runs keyless rounds, which never write lastOkAt, and would otherwise ask the server's status at every render.
   *     Once the key is here (the user unlocked), the next render gets its round at once: it is the one that can pull,
   *     merge and restore a lost identity, which the keyless round could not.
   * A stamp in the future (the clock went back) holds nothing back.
   */
  async shown(): Promise<void> {
    const v = await this.o.engine.view();
    if (!v.syncOn) return;
    const recent = (t: number | null | undefined): boolean =>
      typeof t === "number" && this.now >= t && this.now - t < STALE_MS;
    if (recent(v.state.lastOkAt)) return;
    const keyless = v.state.status === "locked" || v.state.status === "identity_missing";
    if (keyless && recent(v.state.lastAttemptAt) && !(await this.o.keyHere().catch(() => false))) return;
    if (recent(this.shownAt)) return; // after the last await: a call that came in meanwhile has set it
    this.shownAt = this.now;
    await this.run(() => this.o.engine.wake("sync"));
  }

  /** chrome.permissions.onRemoved for the API origin: permission_removed at once, the badge cleared; nothing is sent. */
  async permissionRemoved(): Promise<void> {
    await this.run(() => this.o.engine.permissionWithdrawn());
  }

  /** chrome.permissions.onAdded for the API origin: with sync on, a round (not before a running backoff ends). */
  async permissionAdded(): Promise<void> {
    if (!(await this.o.engine.view()).syncOn) return;
    await this.run(() => this.o.engine.wake("sync"));
  }

  /**
   * runtime.onStartup (§7): the permission granted while there is no sync configuration is left from an enable or join
   * flow that never finished (its tab closed); it is removed. A required one (the e2e build) cannot be. Only the exact
   * API pattern, as Chrome lists it (AUTOFILL2-PLAN §3.4 item 3): "On all sites" (https://*\/*, chosen in Chrome's own
   * menus) also covers the API origin, and is the user's choice for autofill, not a leftover of sync's. What removing the
   * narrower pattern does under it is not verified, so it is not tried, and with sync off nothing is sent anyway.
   */
  async browserStarted(): Promise<void> {
    if (this.o.permissionRequired) return;
    if ((await this.o.engine.view()).syncOn) return;
    if (await apiGrantedExactly(this.o.chrome.permissions)) await removeApiPermission(this.o.chrome.permissions);
  }

  /** A page changed sync's state itself (turned it on or off, ran a round): the badge and the periodic alarm follow. */
  async changed(): Promise<void> {
    await this.settle(await this.o.engine.view());
  }

  private async run(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } finally {
      await this.settle(await this.o.engine.view());
    }
  }

  /** The badge and the periodic alarm, from the stored state. */
  private async settle(v: StateView): Promise<void> {
    const text = badgeText(v);
    if (text !== this.badgeShown) {
      await this.o.chrome.setBadgeText(text).catch(() => undefined);
      const words = this.o.words;
      if (this.o.chrome.setBadgeTitle && words)
        await this.o.chrome.setBadgeTitle(badgeTitle(text, words)).catch(() => undefined);
      this.badgeShown = text;
    }
    const a = this.o.chrome.alarms;
    if (!v.syncOn) {
      await a.clear(SYNC_ALARMS.periodic).catch(() => false);
      return;
    }
    if (!(await a.get(SYNC_ALARMS.periodic).catch(() => undefined))) {
      await Promise.resolve(
        a.create(SYNC_ALARMS.periodic, {
          delayInMinutes: periodicPhaseMinutes((this.o.random ?? cryptoRandom)()),
          periodInMinutes: PERIODIC_MINUTES,
        }),
      ).catch(() => undefined);
    }
  }
}

/** The worker's sync over its runtime, with the real chrome.* APIs and the build's API origin. */
export function createWorkerSync(rt: Runtime): SyncWorker {
  const c: WorkerChrome = {
    alarms: chrome.alarms,
    // through the icon's one badge, which a plugin waiting for the user's answer shares (platform/badge.ts, wave 2b)
    setBadgeText: (text) => badge.syncText(text),
    setBadgeTitle: (title) => badge.syncTitle(title),
    ping: () => chrome.runtime.getPlatformInfo(),
    permissions: chrome.permissions as unknown as WorkerChrome["permissions"],
  };
  const granted = (): Promise<boolean> => apiPermissionGranted(c.permissions);
  const scheduler = new WorkerScheduler(c);
  // the check first: a request refused for want of the permission never starts the keep-alive
  const transport = permissionGated(keptAliveWhileSending(new FetchTransport({ origin: API_ORIGIN }), c.ping), granted);
  const { engine } = createSyncEngine({ rt, transport, scheduler, networkAllowed: granted });
  const words = (count: string) => chrome.i18n.getMessage("syncBadgeTitle", [count]) || `Sixkey · ${count}`;
  return new SyncWorker({
    engine,
    scheduler,
    chrome: c,
    transport,
    permissionRequired: apiPermissionRequired(chrome.runtime.getManifest()),
    keyHere: async () => (await rt.session.get()) !== null,
    words,
  });
}
