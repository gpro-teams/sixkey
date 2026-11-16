// The service worker module's routing (src/background/sw.ts over fake chrome.* APIs, as
// test/unit/m5-sw-wiring.test.ts loads it) and the engine's wiring in a syncing context (src/platform/sync-engine.ts,
// src/platform/locks.ts) under a recording Web Locks stub: Node has no navigator.locks, so the real lock paths (the
// names, ifAvailable) run here against a stub that keeps the browser's rules (one holder per name, ifAvailable answers
// at once).
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKV } from "../../src/core/storage/kv";

type Listener = (...args: unknown[]) => unknown;
const SELF = "abcdefghijklmnopabcdefghijklmnop";
const OPTIONS = `chrome-extension://${SELF}/options/index.html`;

function area() {
  const data = new Map<string, unknown>();
  const reads: string[][] = [];
  return {
    data,
    reads,
    async get(keys?: string | string[] | null) {
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      reads.push(ks);
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

function fakeChrome() {
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
  const alarms = new Map<string, unknown>();
  const badges: string[] = [];
  let pings = 0;
  const chrome = {
    runtime: {
      id: SELF,
      onMessage: on("message"),
      onMessageExternal: on("messageExternal"),
      onConnectExternal: on("connectExternal"),
      onInstalled: on("installed"),
      onStartup: on("startup"),
      getManifest: () => ({ version: "0.1.0" }),
      getPlatformInfo: async () => {
        pings++;
        return {};
      },
      getContexts: async () => [],
      sendMessage: async () => undefined,
    },
    alarms: {
      onAlarm: on("alarm"),
      get: async (n: string) => (alarms.has(n) ? { name: n } : undefined),
      create: async (n: string, i: unknown) => {
        alarms.set(n, i);
      },
      clear: async (n: string) => alarms.delete(n),
    },
    idle: { onStateChanged: on("idle") },
    commands: { onCommand: on("command") },
    storage: {
      local: { ...area(), onChanged: { addListener: () => undefined } },
      session: Object.assign(area(), { onChanged: { addListener: () => undefined } }),
    }, // onChanged: wave 2b's watch (watchPending)
    action: {
      setBadgeText: async (d: { text: string }) => {
        badges.push(d.text);
      },
    },
    offscreen: { createDocument: async () => undefined, closeDocument: async () => undefined },
    permissions: {
      contains: async () => true,
      request: async () => false,
      remove: async () => false,
      getAll: async () => ({ origins: ["https://api.sixkey.app/*"] }),
      onAdded: on("permAdded"),
      onRemoved: on("permRemoved"),
    },
  };
  return { chrome, listeners, badges, pings: () => pings };
}

describe("src/background/sw.ts routing", () => {
  let f: ReturnType<typeof fakeChrome>;
  let release: (() => void) | null;
  beforeEach(async () => {
    vi.resetModules();
    f = fakeChrome();
    release = null;
    vi.stubGlobal("chrome", f.chrome);
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/slow"))
        await new Promise<void>((r) => {
          release = r;
        });
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("__SYNC_UI__", true); // a build with the sync user interface: the worker's sync
    await import("../../src/background/sw");
    await vi.waitFor(() => expect(f.badges).toEqual([""]));
    await new Promise((r) => setTimeout(r, 50));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const send = (msg: unknown, url = OPTIONS) =>
    f.listeners.message!.map((l) => l(msg, { id: SELF, url }, () => undefined));
  const syncReads = () => f.chrome.storage.local.reads.filter((k) => k.includes("sk_sync_state")).length;

  it("only a bridge message keeps the channel open; every other message gets `undefined` from every listener", async () => {
    for (const type of [
      "sk-reschedule-autolock",
      "sk-sync-soon",
      "sk-sync-changed",
      "sk-clip-arm",
      "sk-offscreen-done",
      "other",
    ]) {
      expect(
        send({ type, hash: "x" }).filter((r) => r === true),
        type,
      ).toEqual([]);
    }
  });

  it("with sync off, a page shown, 'sync soon' and 'sync changed' each reach sync's state once, and only once", async () => {
    for (const type of ["sk-reschedule-autolock", "sk-sync-soon", "sk-sync-changed"]) {
      const n = syncReads();
      send({ type });
      await new Promise((r) => setTimeout(r, 50));
      expect(syncReads() - n, type).toBe(1);
    }
  });

  it("a request the worker carries keeps it alive (an extension API call every 20 s) until the answer is in", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let reply: unknown = null;
    for (const l of f.listeners.message!)
      l(
        { type: "sk-api", req: { method: "GET", target: "/slow", headers: {} } },
        { id: SELF, url: OPTIONS },
        (r: unknown) => {
          reply = r;
        },
      );
    await vi.waitFor(() => expect(release).not.toBeNull());
    const p0 = f.pings();
    vi.advanceTimersByTime(45_000);
    expect(f.pings() - p0).toBe(2);
    release!();
    await vi.waitFor(() => expect(reply).toMatchObject({ ok: true }));
    vi.advanceTimersByTime(60_000);
    expect(f.pings() - p0).toBe(2);
  });
});

/** A Web Locks stub that records every request (name, ifAvailable) and grants each name to one holder at a time. */
function recordingLocks() {
  const log: { name: string; ifAvailable: boolean }[] = [];
  const tails = new Map<string, Promise<void>>();
  const held = new Set<string>();
  return {
    log,
    held,
    request: async (name: string, opts: { ifAvailable?: boolean }, fn: (lock: unknown) => Promise<unknown>) => {
      log.push({ name, ifAvailable: opts?.ifAvailable === true });
      if (opts?.ifAvailable && held.has(name)) return fn(null);
      const before = tails.get(name) ?? Promise.resolve();
      let done!: () => void;
      tails.set(
        name,
        before.then(
          () =>
            new Promise<void>((r) => {
              done = r;
            }),
        ),
      );
      await before;
      held.add(name);
      try {
        return await fn({ name });
      } finally {
        held.delete(name);
        done();
      }
    },
  };
}

describe("the engine of a syncing context, over the browser's locks (platform/sync-engine.ts)", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function build() {
    vi.resetModules();
    const locks = recordingLocks();
    vi.stubGlobal("navigator", { locks, onLine: true });
    const asked: unknown[] = [];
    vi.stubGlobal("chrome", {
      runtime: { getManifest: () => ({ version: "0.1.0" }), sendMessage: async () => undefined },
      permissions: {
        contains: async (p: unknown) => {
          asked.push(p);
          return false;
        },
      },
    });
    const { createRuntime } = await import("../../src/platform/runtime");
    const { createSyncEngine } = await import("../../src/platform/sync-engine");
    const { createProtected } = await import("../helpers/vaults");
    const a = area();
    const rt = createRuntime({
      local: a as unknown as chrome.storage.StorageArea,
      session: area() as unknown as chrome.storage.StorageArea,
      mirror: null,
    });
    const { engine } = createSyncEngine({
      rt,
      transport: {
        send: async () => {
          throw new Error("no network in this test");
        },
      },
      identity: new MemoryKV(),
    });
    await createProtected(rt.service);
    return {
      locks,
      engine,
      asked,
      d: (
        engine as unknown as {
          d: {
            vaultLock: (f: () => Promise<number>) => Promise<number>;
            syncLock: (f: () => Promise<number>) => Promise<{ ran: boolean }>;
            clientVersion: string;
            networkAllowed?: () => Promise<boolean>;
          };
        }
      ).d,
    };
  }

  it("the engine's vault lock is the store's (sixkey-vault), so sync's records and every commit are serialized across contexts", async () => {
    const { locks, d } = await build();
    const storeNames = new Set(locks.log.map((l) => l.name));
    expect(storeNames).toContain("sixkey-vault"); // the store's transact took it (createProtected)
    locks.log.length = 0;
    await d.vaultLock(async () => 1);
    expect(locks.log).toEqual([{ name: "sixkey-vault", ifAvailable: false }]);
  }, 60_000);

  it("the sync lock is the one name every context shares, taken only if free: a second taker is told 'busy' at once", async () => {
    const { locks, d } = await build();
    locks.log.length = 0;
    let out!: () => void;
    const holding = d.syncLock(
      () =>
        new Promise<number>((r) => {
          out = () => r(1);
        }),
    );
    await vi.waitFor(() => expect(locks.held.has("sixkey-sync")).toBe(true));
    const second = await Promise.race([
      d.syncLock(async () => 2),
      new Promise((r) => setTimeout(() => r("waited"), 300)),
    ]);
    expect(second).toEqual({ ran: false });
    out();
    expect(await holding).toEqual({ ran: true, value: 1 });
    expect(locks.log.every((l) => l.name === "sixkey-sync" && l.ifAvailable)).toBe(true);
  }, 60_000);

  it("the engine reports the manifest's version (the kill switch compares it with min_client_version)", async () => {
    const { d } = await build();
    expect(d.clientVersion).toBe("0.1.0");
  }, 60_000);

  it("the engine's network switch is chrome.permissions.contains for the API origin; with sync off a round stops locally and asks nothing", async () => {
    const { engine, asked, d } = await build();
    expect(await d.networkAllowed!()).toBe(false);
    expect(asked).toEqual([{ origins: ["https://api.sixkey.app/*"] }]);
    expect((await engine.round()).status).toBe("off"); // the local stop comes first (§4.9, revision 22)
    expect((await engine.push()).status).toBe("off");
    expect(asked).toHaveLength(1);
  }, 60_000);
});

describe("the worker's sync over its runtime (platform/sync-worker.ts createWorkerSync)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("its 'key here' is its own session: true while the vault is unlocked in the worker, false once locked", async () => {
    vi.resetModules();
    vi.stubGlobal("navigator", { locks: recordingLocks(), onLine: true });
    vi.stubGlobal("chrome", {
      runtime: {
        getManifest: () => ({ version: "0.1.0" }),
        sendMessage: async () => undefined,
        getPlatformInfo: async () => ({}),
      },
      alarms: { create: async () => undefined, clear: async () => true, get: async () => undefined },
      action: { setBadgeText: async () => undefined },
      permissions: {
        contains: async () => false,
        request: async () => false,
        remove: async () => false,
        getAll: async () => ({ origins: [] }),
      },
    });
    const { createRuntime } = await import("../../src/platform/runtime");
    const { createWorkerSync } = await import("../../src/platform/sync-worker");
    const { createProtected } = await import("../helpers/vaults");
    const rt = createRuntime({
      local: area() as unknown as chrome.storage.StorageArea,
      session: area() as unknown as chrome.storage.StorageArea,
      mirror: null,
      worker: true,
    });
    const worker = createWorkerSync(rt);
    const keyHere = (worker as unknown as { o: { keyHere: () => Promise<boolean> } }).o.keyHere;
    expect(await keyHere()).toBe(false);
    await createProtected(rt.service); // unlocked here
    expect(await keyHere()).toBe(true);
    await rt.service.lock();
    expect(await keyHere()).toBe(false);
  }, 60_000);
});
