// The worker's permission handlers and the page-shown round after an unlock (src/platform/sync-worker.ts, sw.ts):
//   - a permission granted again still waits for a backoff the server set;
//   - an onRemoved that arrives once the permission is back changes nothing;
//   - a browser start keeps the permission of a profile with sync on, whatever its last status;
//   - a worker start (not a browser start) never removes it: an enable flow may be running in a tab;
//   - a request refused for want of the permission never starts the keep-alive;
//   - the first page-shown round after an unlock is not held back by the keyless round just before it (§4.8, §2.5):
//     it is the round that can pull, merge and restore a lost identity.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { apiPermissionGranted, permissionGated } from "../../src/platform/api-permission";
import { STALE_MS, SyncWorker, WorkerScheduler, type WorkerChrome } from "../../src/platform/sync-worker";
import { contextOver, worldOf, type Device, type World } from "../helpers/m3-world";

type Perms = { granted: boolean; removed: number; api: WorkerChrome["permissions"] };
function perms(granted = true): Perms {
  const p: Perms = {
    granted,
    removed: 0,
    api: {
      contains: async () => p.granted,
      request: async () => {
        p.granted = true;
        return true;
      },
      remove: async () => {
        const was = p.granted;
        p.granted = false;
        if (was) p.removed++;
        return was;
      },
      getAll: async () => ({ origins: p.granted ? [API] : [] }),
    },
  };
  return p;
}
function workerOver(d: Device, p = perms()) {
  const c: WorkerChrome = {
    alarms: { create: async () => undefined, clear: async () => true, get: async () => undefined },
    setBadgeText: async () => undefined,
    ping: async () => undefined,
    permissions: p.api,
  };
  const granted = () => apiPermissionGranted(p.api);
  const scheduler = new WorkerScheduler(c, d.now);
  const transport = permissionGated(d.net, granted);
  const ctx = contextOver({
    ...d.disk,
    lock: d.lock,
    identityLock: d.identityLock,
    syncLock: d.syncLock,
    transport,
    clock: d.now,
    scheduler,
    random: () => 0.5,
    networkAllowed: granted,
  });
  return {
    worker: new SyncWorker({
      engine: ctx.engine,
      scheduler,
      chrome: c,
      transport,
      keyHere: async () => d.disk.session.data !== null,
      now: d.now,
      random: () => 0.5,
    }),
    p,
  };
}
const sent = (w: World) => w.server.requests.length;
const statusCalls = (w: World) => w.server.requests.filter((r) => r.op === "GET /v1/sync/status").length;
const stateOf = (d: Device) => d.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>;

describe("the worker's permission handlers", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
  afterEach(() => vi.useRealTimers());

  it("a permission granted again waits for a backoff the server set (Retry-After); nothing is sent inside it", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    const { worker, p } = workerOver(a);
    p.granted = false;
    await worker.permissionRemoved();
    a.disk.kv.data.set(SYNC_KEYS.state, {
      ...stateOf(a),
      failures: 3,
      backoffUntil: w.clock.now + 600_000,
      lastErrorCode: "rate_limited",
    });
    p.granted = true;
    const n = sent(w);
    await worker.permissionAdded();
    expect(sent(w)).toBe(n);
    expect(stateOf(a)).toMatchObject({ failures: 3, lastErrorCode: "rate_limited" });
  }, 60_000);

  it("an onRemoved that arrives once the permission is back sends nothing and changes nothing", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    const { worker } = workerOver(a); // granted
    w.advance(STALE_MS + 1000);
    const before = JSON.stringify(stateOf(a));
    const n = sent(w);
    await worker.permissionRemoved();
    expect(sent(w)).toBe(n);
    expect(JSON.stringify(stateOf(a))).toBe(before);
  }, 60_000);

  it("a browser start keeps the permission of a profile with sync on, whatever its last status says", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    for (const status of ["offline", "error", "permission_removed", "locked", "needs_password", "identity_missing"]) {
      a.disk.kv.data.set(SYNC_KEYS.state, { ...stateOf(a), status });
      const { worker, p } = workerOver(a);
      w.advance(STALE_MS);
      await worker.browserStarted();
      expect([status, p.removed, p.granted]).toEqual([status, 0, true]);
    }
  }, 60_000);
});

describe("the page-shown round after an unlock (§4.8)", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
  afterEach(() => vi.useRealTimers());

  it("a keyless round just before the unlock holds back the renders while the key is elsewhere, and not the first one after it", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    const key = { ...a.disk.session.data! };
    w.advance(STALE_MS + 1000); // the last success is old
    a.disk.session.data = null; // locked: the worker's round is the status query alone
    const { worker } = workerOver(a);
    await worker.alarm("sk-sync-periodic");
    expect(stateOf(a).status).toBe("locked");
    w.advance(1_000);
    const n0 = statusCalls(w);
    await worker.shown(); // still locked: held back by the keyless round
    expect(statusCalls(w)).toBe(n0);
    a.disk.session.data = { ...key, lastActive: w.clock.now }; // the user unlocks in the popup
    w.advance(1_000);
    const n = sent(w);
    await worker.shown(); // the popup shows the unlocked vault
    expect(sent(w)).toBeGreaterThan(n);
    expect(stateOf(a).status).toBe("ok");
  }, 60_000);

  it("an identity lost from IndexedDB is restored by the first page-shown round after the unlock", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const b = w.devices[1]!;
    const key = { ...b.disk.session.data! };
    w.advance(STALE_MS + 1000);
    b.disk.session.data = null;
    b.disk.idb.data.clear(); // what some fingerprint browsers do at every stop
    const { worker } = workerOver(b);
    await worker.alarm("sk-sync-periodic");
    expect(stateOf(b).status).toBe("identity_missing");
    b.disk.session.data = { ...key, lastActive: w.clock.now };
    w.advance(1_000);
    await worker.shown();
    expect(stateOf(b).status).toBe("ok");
    expect(b.disk.idb.data.size).toBeGreaterThan(0);
  }, 60_000);

  it("a recent attempt of a round with the key (another stored status) holds nothing back for a worker without it", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    w.advance(STALE_MS + 1000);
    a.disk.session.data = null;
    a.disk.kv.data.set(SYNC_KEYS.state, { ...stateOf(a), status: "review_needed", lastAttemptAt: w.clock.now - 1_000 });
    const { worker } = workerOver(a);
    const n = statusCalls(w);
    await worker.shown();
    expect(statusCalls(w)).toBe(n + 1);
  }, 60_000);
});

// sw.ts over fake chrome.* APIs (as test/unit/m5-sw-wiring.test.ts loads it)
type Listener = (...args: unknown[]) => unknown;
const SELF = "abcdefghijklmnopabcdefghijklmnop";
const API = "https://api.sixkey.app/*";
function area() {
  const data = new Map<string, unknown>();
  return {
    data,
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
}
function fakeChrome(granted: boolean) {
  const listeners: Record<string, Listener[]> = {
    message: [],
    // the plugin platform's listener and its refusal of plugin-opened ports (src/platform/plugins/worker.ts)
    messageExternal: [],
    connectExternal: [],
    alarm: [],
    installed: [],
    startup: [],
    idle: [],
    permAdded: [],
    permRemoved: [],
    command: [], // the `lock` shortcut (QUICK-UNLOCK §5.12)
  };
  const on = (name: string) => ({ addListener: (l: Listener) => listeners[name]!.push(l) });
  const perm = { granted, removed: 0 };
  let pings = 0;
  const chrome = {
    runtime: {
      id: SELF,
      onMessage: on("message"),
      onMessageExternal: on("messageExternal"),
      onConnectExternal: on("connectExternal"),
      onInstalled: on("installed"),
      onStartup: on("startup"),
      getManifest: () => ({ version: "0.1.0", optional_host_permissions: [API] }),
      getPlatformInfo: async () => {
        pings++;
        return {};
      },
      getContexts: async () => [],
      sendMessage: async () => undefined,
    },
    alarms: {
      onAlarm: on("alarm"),
      get: async () => undefined,
      create: async () => undefined,
      clear: async () => true,
    },
    idle: { onStateChanged: on("idle") },
    commands: { onCommand: on("command") },
    storage: {
      local: { ...area(), onChanged: { addListener: () => undefined } },
      session: Object.assign(area(), { onChanged: { addListener: () => undefined } }),
    }, // onChanged: wave 2b's watch (watchPending)
    action: { setBadgeText: async () => undefined },
    offscreen: { createDocument: async () => undefined, closeDocument: async () => undefined },
    permissions: {
      contains: async () => perm.granted,
      request: async () => false,
      remove: async () => {
        const was = perm.granted;
        perm.granted = false;
        if (was) perm.removed++;
        return was;
      },
      getAll: async () => ({ origins: perm.granted ? [API] : [] }),
      onAdded: on("permAdded"),
      onRemoved: on("permRemoved"),
    },
  };
  return { chrome, listeners, perm, pings: () => pings };
}

describe("src/background/sw.ts and the permission", () => {
  let f: ReturnType<typeof fakeChrome>;
  let fetches: string[];
  async function load(granted: boolean) {
    vi.resetModules();
    f = fakeChrome(granted);
    fetches = [];
    vi.stubGlobal("chrome", f.chrome);
    vi.stubGlobal("fetch", async (url: string) => {
      fetches.push(url);
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("__SYNC_UI__", true); // a build with the sync user interface: the worker's sync
    await import("../../src/background/sw");
    await new Promise((r) => setTimeout(r, 50));
  }
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a worker start (not a browser start) never removes the permission: an enable flow may be running in a tab", async () => {
    await load(true); // granted, no sk_sync_cfg yet: a settings tab is between the grant and the configuration
    expect([f.perm.removed, f.perm.granted]).toEqual([0, true]);
    for (const l of f.listeners.message!)
      l(
        { type: "sk-reschedule-autolock" },
        { id: SELF, url: `chrome-extension://${SELF}/options/index.html` },
        () => undefined,
      );
    for (const l of f.listeners.alarm!) l({ name: "sk-sync-periodic" });
    await new Promise((r) => setTimeout(r, 50));
    expect([f.perm.removed, f.perm.granted]).toEqual([0, true]);
  });

  it("a request refused for want of the permission never starts the keep-alive", async () => {
    await load(false);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const p0 = f.pings();
    const replies: unknown[] = [];
    for (const l of f.listeners.message!)
      l(
        { type: "sk-api", req: { method: "GET", target: "/v1/keys", headers: {} } },
        { id: SELF, url: `chrome-extension://${SELF}/options/index.html` },
        (r: unknown) => replies.push(r),
      );
    await vi.waitFor(() => expect(replies).toEqual([{ ok: false, reason: "offline" }]));
    vi.advanceTimersByTime(120_000);
    expect(f.pings() - p0).toBe(0);
    expect(fetches).toEqual([]);
  });
});
