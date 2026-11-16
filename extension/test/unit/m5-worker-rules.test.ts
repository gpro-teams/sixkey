// The service worker's sync (src/platform/sync-worker.ts) and the runtime's outbox wiring (src/platform/runtime.ts):
// the periodic alarm created once, the page-shown round's limits, the keep-alive's end, and "sync soon" only once the
// outbox is written.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { addEntry } from "../../src/core/vault/ops";
import { createRuntime, SYNC_SOON_MESSAGE } from "../../src/platform/runtime";
import {
  keptAliveWhileSending,
  STALE_MS,
  SYNC_ALARMS,
  SyncWorker,
  WorkerScheduler,
  type WorkerChrome,
} from "../../src/platform/sync-worker";
import type { Transport } from "../../src/core/sync/engine/transport";
import { contextOver, newDisk, worldOf, type Device, type World } from "../helpers/m3-world";
import { input, secretOf } from "../helpers/m2-world";
import { createProtected } from "../helpers/vaults";

function fakeChrome() {
  const alarms = new Map<string, { when?: number; delayInMinutes?: number; periodInMinutes?: number }>();
  const creates: string[] = [];
  const c: WorkerChrome = {
    alarms: {
      create: async (n, i) => {
        creates.push(n);
        alarms.set(n, i);
      },
      clear: async (n) => alarms.delete(n),
      get: async (n) => (alarms.has(n) ? { name: n } : undefined),
    },
    setBadgeText: async () => undefined,
    ping: async () => undefined,
    permissions: {
      contains: async () => true,
      request: async () => true,
      remove: async () => true,
      getAll: async () => ({ origins: ["https://api.sixkey.app/*"] }),
    },
  };
  return { c, alarms, creates };
}
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
  return {
    worker: new SyncWorker({
      engine: ctx.engine,
      scheduler,
      chrome: f.c,
      transport: d.net,
      keyHere: async () => d.disk.session.data !== null,
      now: d.now,
      random: () => 0.5,
    }),
    f,
  };
}
const statusCalls = (w: World) => w.server.requests.filter((r) => r.op === "GET /v1/sync/status").length;

describe("the periodic alarm and the page-shown round", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
  afterEach(() => vi.useRealTimers());

  it("the periodic alarm is created once; rounds, pages shown and changes do not re-create it (which would move it and change the rate)", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    const { worker, f } = workerOf(a);
    await worker.start();
    for (let i = 0; i < 3; i++) {
      w.advance(STALE_MS + 1000);
      await worker.shown();
      await worker.changed();
      await worker.alarm(SYNC_ALARMS.periodic);
    }
    expect(f.creates.filter((n) => n === SYNC_ALARMS.periodic)).toHaveLength(1);
  }, 60_000);

  it("a last success stamped in the future (the clock went back) does not stop the page-shown round", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    const { worker } = workerOf(a);
    await worker.start();
    w.advance(STALE_MS + 1000); // the last attempt is old
    const st = a.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>;
    a.disk.kv.data.set(SYNC_KEYS.state, { ...st, lastOkAt: w.clock.now + 3_600_000 });
    const n = statusCalls(w);
    await worker.shown();
    expect(statusCalls(w)).toBe(n + 1);
  }, 60_000);

  it("with sync off a page shown costs exactly one storage read and writes nothing", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const d = w.device("Fresh", newDisk());
    const { worker } = workerOf(d);
    await worker.start();
    let reads = 0;
    let writes = 0;
    const get = d.disk.kv.get.bind(d.disk.kv);
    const set = d.disk.kv.set.bind(d.disk.kv);
    d.disk.kv.get = async (k) => {
      reads++;
      return get(k);
    };
    d.disk.kv.set = async (x) => {
      writes++;
      return set(x);
    };
    await worker.shown();
    expect([reads, writes]).toEqual([1, 0]);
  }, 60_000);

  // The popup says "shown" at every render of its list (opening and each reload after a change), and lastOkAt is written
  // only by a full ("ok") round. A worker without the key ("lock every time") only ever has "locked" rounds, so the
  // page-shown round is also held back by the last attempt of any kind.
  it("with the key elsewhere, two pages shown within 30 s cost one status query, not two", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    a.disk.session.data = null; // the worker has no key
    const { worker } = workerOf(a);
    await worker.start();
    w.advance(STALE_MS + 1000);
    const n = statusCalls(w);
    await worker.shown();
    w.advance(1000);
    await worker.shown();
    expect(statusCalls(w)).toBe(n + 1);
    // a new worker (the old one stopped) goes by the stored attempt time alone
    w.advance(1000);
    await workerOf(a).worker.shown();
    expect(statusCalls(w)).toBe(n + 1);
    w.advance(STALE_MS);
    await worker.shown();
    expect(statusCalls(w)).toBe(n + 2);
  }, 60_000);

  it("two pages shown at once cost one status query: the second does not wait for the first one's stored attempt", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    a.disk.session.data = null;
    const { worker } = workerOf(a);
    await worker.start();
    w.advance(STALE_MS + 1000);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const send = a.net.send.bind(a.net);
    a.net.send = async (req) => {
      await held;
      return send(req);
    }; // the first round's status query is still out
    const n = statusCalls(w);
    const both = Promise.all([worker.shown(), worker.shown()]);
    for (let i = 0; i < 200; i++) await Promise.resolve();
    release();
    await both;
    expect(statusCalls(w)).toBe(n + 1);
  }, 60_000);

  it("a last attempt stamped in the future (the clock went back) does not stop the page-shown round", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    a.disk.session.data = null;
    const { worker } = workerOf(a);
    await worker.start();
    w.advance(STALE_MS + 1000);
    const st = a.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>;
    a.disk.kv.data.set(SYNC_KEYS.state, { ...st, lastOkAt: null, lastAttemptAt: w.clock.now + 3_600_000 });
    const n = statusCalls(w);
    await worker.shown();
    expect(statusCalls(w)).toBe(n + 1);
  }, 60_000);

  it("the keep-alive stops completely once nothing is out, whatever the number of requests that were", async () => {
    let pings = 0;
    const done: (() => void)[] = [];
    const inner: Transport = {
      send: () => new Promise((r) => done.push(() => r({ status: 200, headers: {}, body: "" }))),
    };
    const t = keptAliveWhileSending(inner, async () => {
      pings++;
    });
    const all = [0, 1, 2].map(() => t.send({ method: "GET", target: "/v1/keys", headers: {} }));
    for (const f of done) f();
    await Promise.all(all);
    vi.advanceTimersByTime(10 * 60_000);
    expect(pings).toBe(0);
  });
});

describe("the runtime's 'sync soon'", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("the worker is asked for a round only once the outbox is written (a page closing at once has asked for the right upload)", async () => {
    const data = new Map<string, unknown>();
    const area = {
      async get(keys?: string | string[] | null) {
        const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(ks.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
      },
      async set(items: Record<string, unknown>) {
        for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
      },
      async remove(keys: string | string[]) {
        for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
      },
    };
    const atSend: boolean[] = [];
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: async (m: { type: string }) => {
          if (m.type === SYNC_SOON_MESSAGE) atSend.push(data.has(SYNC_KEYS.outbox));
        },
      },
    });
    const sess = new Map<string, unknown>();
    const sessArea = {
      ...area,
      async get(k?: string | string[] | null) {
        const ks = k == null ? [...sess.keys()] : Array.isArray(k) ? k : [k];
        return Object.fromEntries(ks.filter((x) => sess.has(x)).map((x) => [x, sess.get(x)]));
      },
      async set(i: Record<string, unknown>) {
        for (const [x, v] of Object.entries(i)) sess.set(x, v);
      },
      async remove(k: string | string[]) {
        for (const x of Array.isArray(k) ? k : [k]) sess.delete(x);
      },
    };
    const rt = createRuntime({
      local: area as unknown as chrome.storage.StorageArea,
      session: sessArea as unknown as chrome.storage.StorageArea,
      mirror: null,
    });
    await createProtected(rt.service);
    data.set(SYNC_KEYS.cfg, { v: 1 });
    data.set(SYNC_KEYS.state, { v: 1, lastSynced: { version: 4, head: "h", checksum: "c" } });
    await rt.service.mutate(
      (v, c, now) => addEntry(v, input("GitHub", secretOf("GitHub")), c, { now: () => now }).vault,
    );
    expect(atSend).toEqual([true]);
  }, 60_000);
});
