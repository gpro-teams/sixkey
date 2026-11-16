// The service worker's sync (src/platform/sync-worker.ts; SYNC-DESIGN §3.11, §4.8, §4.9): the engine's wakes as timers
// and alarms, the keep-alive while a request is out, the badge, and the worker's entry points over a real engine and the
// FakeServer, across worker restarts (a new worker over the same storage): the backoff and Retry-After persist, the
// identity_missing state keeps the stored server offset, and nothing is sent while a backoff runs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALARM_MIN_MS, DEBOUNCE_MS, PERIODIC_MINUTES } from "../../src/core/sync/engine/schedule";
import { ApprovalJoin } from "../../src/core/sync/engine/enroll";
import { revokeDevice } from "../../src/core/sync/engine/keys";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import type { Transport } from "../../src/core/sync/engine/transport";
import {
  badgeText,
  keptAliveWhileSending,
  KEEPALIVE_MS,
  STALE_MS,
  SYNC_ALARMS,
  SyncWorker,
  WorkerScheduler,
  type WorkerChrome,
} from "../../src/platform/sync-worker";
import { contextOver, EMAIL, newDisk, worldOf, type Device, type World } from "../helpers/m3-world";

function fakeChrome() {
  const alarms = new Map<string, { when?: number; delayInMinutes?: number; periodInMinutes?: number }>();
  const badges: string[] = [];
  let pings = 0;
  const c: WorkerChrome = {
    alarms: {
      create: async (n, i) => {
        alarms.set(n, i);
      },
      clear: async (n) => alarms.delete(n),
      get: async (n) => (alarms.has(n) ? { name: n } : undefined),
    },
    setBadgeText: async (t) => {
      badges.push(t);
    },
    ping: async () => {
      pings++;
    },
    permissions: {
      contains: async () => true,
      request: async () => true,
      remove: async () => true,
      getAll: async () => ({ origins: ["https://api.sixkey.app/*"] }),
    },
  };
  return { c, alarms, badges, pings: () => pings };
}

describe("badgeText (§3.11)", () => {
  const v = (syncOn: boolean, status: string | undefined, n: number | undefined) => ({
    syncOn,
    state: { ...(status ? { status: status as never } : {}), ...(n !== undefined ? { pendingEnrollments: n } : {}) },
  });
  it("the pending enrolments while sync is on; nothing when off, in a state where no status query refreshes the count, or with none", () => {
    expect(badgeText(v(true, "ok", 1))).toBe("1");
    expect(badgeText(v(true, "locked", 3))).toBe("3"); // locked rounds still ask the status, and the count is fresh
    expect(badgeText(v(true, "offline", 2))).toBe("2");
    expect(badgeText(v(true, "ok", 100))).toBe("99+");
    expect(badgeText(v(true, "review_needed", 2))).toBe("2"); // after the status query: fresh
    expect(badgeText(v(true, undefined, 2))).toBe("2");
    for (const s of [
      "update_required",
      "rejected_by_server",
      "permission_removed",
      "identity_missing",
      "damaged",
      "wrong_origin",
      "cloud_restore",
      "join_unfinished",
    ]) {
      expect(badgeText(v(true, s, 2)), s).toBe("");
    }
    for (const [on, s, n] of [
      [false, "ok", 2],
      [true, "off", 2],
      [true, "update_required", 2],
      [true, "rejected_by_server", 2],
      [true, "ok", 0],
      [true, "ok", undefined],
      [true, "ok", -1],
      [true, "ok", 1.5],
    ] as const) {
      expect(badgeText(v(on, s, n)), `${on} ${s} ${n}`).toBe("");
    }
  });
});

describe("WorkerScheduler: a wake under 30 s is a timer, from 30 s an alarm (§4.8)", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
  afterEach(() => vi.useRealTimers());

  it("timeouts fire onWake at their time; alarms are created with the absolute time; a later wake of the same name replaces the earlier one", async () => {
    const f = fakeChrome();
    let now = 1_000_000;
    const s = new WorkerScheduler(f.c, () => now);
    const woke: string[] = [];
    s.onWake = (n) => woke.push(n);
    s.schedule("sync", { at: now + DEBOUNCE_MS, via: "timeout" });
    s.schedule("kick", { at: now + ALARM_MIN_MS, via: "alarm" });
    await Promise.resolve();
    expect(f.alarms.get(SYNC_ALARMS.kick)).toEqual({ when: now + ALARM_MIN_MS });
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    expect(woke).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(woke).toEqual(["sync"]);
    // replaced: an alarm by a timeout (the alarm is cleared), a timeout by an alarm (the timer never fires)
    s.schedule("retry", { at: now + 60_000, via: "alarm" });
    s.schedule("retry", { at: now + 5_000, via: "timeout" });
    await Promise.resolve();
    expect(f.alarms.has(SYNC_ALARMS.retry)).toBe(false);
    s.schedule("retry", { at: now + 90_000, via: "alarm" });
    vi.advanceTimersByTime(10_000);
    expect(woke).toEqual(["sync"]);
    await Promise.resolve();
    expect(f.alarms.get(SYNC_ALARMS.retry)).toEqual({ when: now + 90_000 });
    s.cancel("retry");
    await Promise.resolve();
    expect(f.alarms.has(SYNC_ALARMS.retry)).toBe(false);
    // a wake in the past: an alarm at once (Chrome fires it as soon as it can)
    now += 1000;
    s.schedule("retry", { at: now - 5000, via: "alarm" });
    await Promise.resolve();
    expect(f.alarms.get(SYNC_ALARMS.retry)).toEqual({ when: now });
  });

  it("keptAliveWhileSending pings every 20 s while any request is out, and stops when the last one is back", async () => {
    let pings = 0;
    const pending: (() => void)[] = [];
    const inner: Transport = {
      send: () => new Promise((r) => pending.push(() => r({ status: 200, headers: {}, body: "" }))),
    };
    const t = keptAliveWhileSending(inner, async () => {
      pings++;
    });
    const a = t.send({ method: "GET", target: "/v1/keys", headers: {} });
    const b = t.send({ method: "GET", target: "/v1/keys", headers: {} });
    vi.advanceTimersByTime(KEEPALIVE_MS * 2 + 1);
    expect(pings).toBe(2); // one timer for both
    pending.shift()!();
    await a;
    vi.advanceTimersByTime(KEEPALIVE_MS);
    expect(pings).toBe(3); // b still out
    pending.shift()!();
    await b;
    vi.advanceTimersByTime(KEEPALIVE_MS * 5);
    expect(pings).toBe(3);
    expect(KEEPALIVE_MS).toBeLessThan(30_000); // Chrome stops an idle worker after 30 s
  });
});

/** A worker over device `d`'s storage, as the service worker builds it (one engine, the worker's scheduler). */
function workerOf(d: Device, f = fakeChrome()) {
  const scheduler = new WorkerScheduler(f.c, d.now);
  const ctx = contextOver({
    ...d.disk,
    lock: d.lock,
    identityLock: d.identityLock,
    syncLock: d.syncLock,
    transport: d.net,
    clock: d.now,
    scheduler,
    random: () => 0.5,
  });
  const worker = new SyncWorker({
    engine: ctx.engine,
    scheduler,
    chrome: f.c,
    transport: d.net,
    keyHere: async () => d.disk.session.data !== null,
    now: d.now,
    random: () => 0.5,
  });
  return { worker, f, ctx, scheduler };
}
const statusCalls = (w: World) => w.server.requests.filter((r) => r.op === "GET /v1/sync/status").length;
const stateOf = (d: Device) =>
  d.disk.kv.data.get(SYNC_KEYS.state) as
    | {
        failures?: number;
        backoffUntil?: number | null;
        serverOffsetMs?: number;
        status?: string;
        pendingEnrollments?: number;
      }
    | undefined;

describe("SyncWorker over the engine and the FakeServer", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
  afterEach(() => vi.useRealTimers());

  it("sync off: a worker start reads the state once, clears the periodic alarm and the badge, and sends nothing", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const d = w.device("Fresh", newDisk());
    let reads = 0;
    const get = d.disk.kv.get.bind(d.disk.kv);
    d.disk.kv.get = async (k) => {
      reads++;
      return get(k);
    };
    const f = fakeChrome();
    f.alarms.set(SYNC_ALARMS.periodic, { periodInMinutes: 30 }); // left from an earlier time with sync on
    const { worker } = workerOf(d, f);
    const n0 = w.server.requests.length;
    await worker.start();
    expect(reads).toBe(1);
    expect(f.alarms.has(SYNC_ALARMS.periodic)).toBe(false);
    expect(f.badges).toEqual([""]);
    await worker.shown();
    await worker.soon(); // a stray "sync soon" (sent before a turn-off): no timer, no alarm
    expect(vi.getTimerCount()).toBe(0);
    expect([...f.alarms.keys()]).toEqual([]);
    expect(w.server.requests.length).toBe(n0);
    expect(d.disk.kv.data.has(SYNC_KEYS.state)).toBe(false); // nothing of sync written with sync off
  });

  it("sync on: the periodic alarm with a random first delay; a page commit's 'sync soon' becomes the debounced round; a page showing the vault rounds only when the last success is old", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    const { worker, f } = workerOf(a);
    await worker.start();
    const p = f.alarms.get(SYNC_ALARMS.periodic)!;
    expect(p.periodInMinutes).toBe(PERIODIC_MINUTES);
    expect(p.delayInMinutes).toBeGreaterThanOrEqual(1);
    expect(p.delayInMinutes).toBeLessThanOrEqual(30);
    // a commit in a page, then its "sync soon": nothing at once, a round 3 s later (the timer), the 30 s backstop alarm
    w.advance(1000);
    await a.add("Edited");
    const n0 = statusCalls(w);
    await worker.soon();
    expect(statusCalls(w)).toBe(n0);
    expect(f.alarms.has(SYNC_ALARMS.kick)).toBe(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await vi.waitFor(() =>
      expect(w.server.requests.some((r) => r.op === "PUT /v1/vault" && r.status === 200)).toBe(true),
    );
    // shown(): the last success is fresh, nothing; 31 s later, a round
    const n1 = statusCalls(w);
    await worker.shown();
    expect(statusCalls(w)).toBe(n1);
    w.advance(STALE_MS + 1000);
    await worker.shown();
    expect(statusCalls(w)).toBe(n1 + 1);
    // an alarm that is not sync's is not handled
    expect(await worker.alarm("sk-daily")).toBe(false);
    expect(await worker.alarm(SYNC_ALARMS.periodic)).toBe(true);
    expect(statusCalls(w)).toBe(n1 + 2);
  });

  it("a sustained 503 (§4.8): every failure counts, the gaps grow, Retry-After is the floor, and a restarted worker keeps waiting for the stored backoff", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    w.server.fault({
      match: "GET /v1/sync/status",
      kind: "status",
      status: 503,
      code: "unavailable",
      retryAfter: 5,
      count: 1000,
    });
    let { worker, f } = workerOf(a);
    const gaps: number[] = [];
    let sent = statusCalls(w);
    for (let i = 0; i < 6; i++) {
      expect(await worker.alarm(SYNC_ALARMS.periodic)).toBe(true);
      expect(statusCalls(w)).toBe(sent + 1); // exactly one attempt per wake: the transport does not retry
      sent++;
      const s = stateOf(a)!;
      expect(s.failures).toBe(i + 1);
      const gap = s.backoffUntil! - w.clock.now;
      expect(gap).toBeGreaterThanOrEqual(5_000);
      gaps.push(gap);
      // a worker restart in the middle of the backoff: the new worker's start schedules no earlier than the stored end,
      // and a wake before it sends nothing
      vi.clearAllTimers();
      ({ worker, f } = workerOf(a));
      await worker.start();
      const scheduled = [...f.alarms.entries()].filter(([n]) => n !== SYNC_ALARMS.periodic).map(([, x]) => x.when ?? 0);
      for (const at of scheduled) expect(at).toBeGreaterThanOrEqual(s.backoffUntil!);
      w.advance(Math.floor(gap / 2));
      await worker.alarm(SYNC_ALARMS.periodic);
      expect(statusCalls(w)).toBe(sent);
      w.advance(gap);
    }
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]!, `gap ${i}`).toBeGreaterThan(gaps[i - 1]!);
    // the server recovers: the next wake after the backoff succeeds and clears it (the virtual clock has moved past the
    // idle lock by now, so the round is the locked one: the status query alone)
    w.server.clearFaults();
    await worker.alarm(SYNC_ALARMS.periodic);
    expect(stateOf(a)).toMatchObject({ failures: 0, backoffUntil: null, status: "locked" });
  }, 60_000);

  it("a worker restart in identity_missing (§2.5, §4.14): locked, nothing is signed or sent and the stored server offset stays; unlocked, the identity comes back from its copy", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const b = w.devices[1]!;
    w.server.skewMs = 120_000;
    await b.engine.round({ explicit: true });
    const offset = stateOf(b)!.serverOffsetMs!;
    expect(Math.abs(offset - 120_000)).toBeLessThan(2_000);
    const rows = () => w.server.state(EMAIL).devices.length;
    const rows0 = rows();
    await b.lockNow();
    b.disk.idb.data.clear(); // the browser (or a fingerprint browser's profile manager) dropped IndexedDB
    b.disk.kv.data.set(SYNC_KEYS.state, { ...stateOf(b), pendingEnrollments: 2 }); // a count no round will refresh now
    w.advance(1000);
    const n0 = w.server.requests.length;
    const { worker, f } = workerOf(b);
    await worker.start();
    await worker.alarm(SYNC_ALARMS.periodic);
    expect(w.server.requests.length).toBe(n0);
    expect(stateOf(b)!.status).toBe("identity_missing");
    expect(f.badges.at(-1)).toBe(""); // no status query answers in this state, so no count is shown
    expect(stateOf(b)!.serverOffsetMs).toBe(offset);
    // the next worker, unlocked: restored from the copy, same device, no new row, the offset learned again
    await b.unlock();
    const again = workerOf(b);
    await again.worker.start();
    await again.worker.alarm(SYNC_ALARMS.periodic);
    expect(stateOf(b)!.status).toBe("ok");
    expect(rows()).toBe(rows0);
    expect(Math.abs(stateOf(b)!.serverOffsetMs! - 120_000)).toBeLessThan(2_000);
  }, 60_000);

  it("the badge: the devices waiting for approval; cleared on update_required, on rejected_by_server, and when sync is turned off", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a, b] = w.devices as [Device, Device];
    const { worker, f } = workerOf(a);
    await worker.start();
    expect(f.badges.at(-1)).toBe("");
    // a new profile asks to join by approval (§3.2): a pending request on the server
    const n = w.device("New", newDisk());
    await ApprovalJoin.start(n.engine, { session: await w.server.session(EMAIL), deviceName: "New", email: EMAIL });
    await worker.alarm(SYNC_ALARMS.periodic);
    expect(stateOf(a)!.pendingEnrollments).toBe(1);
    expect(f.badges.at(-1)).toBe("1");
    // the kill switch: the count is not refreshed any more, so the badge goes
    w.server.minClientVersion = "9.0.0";
    w.advance(STALE_MS + 1000);
    await worker.alarm(SYNC_ALARMS.periodic);
    expect(stateOf(a)!.status).toBe("update_required");
    expect(f.badges.at(-1)).toBe("");
    w.server.minClientVersion = "0.1.0";
    await worker.alarm(SYNC_ALARMS.periodic);
    expect(f.badges.at(-1)).toBe("1");
    // this device revoked elsewhere: rejected_by_server, the badge goes
    const id = (await a.local.settlePins()) as { deviceId: string };
    await revokeDevice(b.engine, id.deviceId, w.password);
    w.advance(1000);
    await worker.alarm(SYNC_ALARMS.periodic);
    expect(stateOf(a)!.status).toBe("rejected_by_server");
    expect(f.badges.at(-1)).toBe("");
    // turned off (the local records gone): a page tells the worker, the badge and the periodic alarm follow
    for (const k of [SYNC_KEYS.cfg, SYNC_KEYS.state]) a.disk.kv.data.delete(k);
    await worker.changed();
    expect(f.badges.at(-1)).toBe("");
    expect(f.alarms.has(SYNC_ALARMS.periodic)).toBe(false);
  }, 60_000);
});
