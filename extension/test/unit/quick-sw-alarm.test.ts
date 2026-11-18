// The service worker's idle auto-lock alarm does not depend on the session quick unlock's code (sw.ts): its expiry step
// has an alarm of its own, so a rejection there (a storage.session read that fails, a lock request that rejects) never
// leaves the idle alarm unarmed, which would leave an idle vault unlocked until some page looks. Harness: the fake
// chrome of test/unit/m5-sw-wiring.test.ts.
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => unknown;
const SELF = "abcdefghijklmnopabcdefghijklmnop";

function area(o: { failOn?: string } = {}) {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys?: string | string[] | null) {
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      if (o.failOn && ks.includes(o.failOn)) throw new Error("storage.session read failed");
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

function fakeChrome(failOn?: string) {
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
    command: [],
  };
  const on = (name: string) => ({ addListener: (l: Listener) => listeners[name]!.push(l) });
  const alarms = new Map<string, unknown>();
  const chrome = {
    runtime: {
      id: SELF,
      onMessage: on("message"),
      onMessageExternal: on("messageExternal"),
      onConnectExternal: on("connectExternal"),
      onInstalled: on("installed"),
      onStartup: on("startup"),
      getManifest: () => ({ version: "0.1.0" }),
      getPlatformInfo: async () => ({}),
      getContexts: async () => [],
      sendMessage: async () => undefined,
    },
    alarms: {
      onAlarm: on("alarm"),
      get: async (n: string) => (alarms.has(n) ? { name: n } : undefined),
      create: async (n: string, i: unknown) => void alarms.set(n, i),
      clear: async (n: string) => alarms.delete(n),
    },
    idle: { onStateChanged: on("idle") },
    commands: { onCommand: on("command") },
    storage: {
      local: { ...area(), onChanged: { addListener: () => undefined } },
      // onChanged: the plugin platform's watch on its proposals and on every lock (wave 2b, watchPending)
      session: Object.assign(area(failOn ? { failOn } : {}), { onChanged: { addListener: () => undefined } }),
    },
    action: { setBadgeText: async () => undefined },
    offscreen: { createDocument: async () => undefined, closeDocument: async () => undefined },
    permissions: {
      contains: async () => false,
      request: async () => false,
      remove: async () => false,
      getAll: async () => ({ origins: [] }),
      onAdded: on("permAdded"),
      onRemoved: on("permRemoved"),
    },
  };
  return { chrome, listeners, alarms };
}

describe("the idle auto-lock alarm survives a failure in the quick-unlock expiry step", () => {
  let f: ReturnType<typeof fakeChrome>;
  afterEach(() => vi.unstubAllGlobals());

  async function start(failOn?: string) {
    vi.resetModules();
    f = fakeChrome(failOn);
    vi.stubGlobal("chrome", f.chrome);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    await import("../../src/background/sw");
    await new Promise((r) => setTimeout(r, 50));
    // an unlocked vault in idle mode (the default settings: 15 minutes)
    f.chrome.storage.session.data.set("sk_session", { vk: "AAAA", lastActive: Date.now(), epoch: 0 });
    for (const l of f.listeners.message!)
      l({ type: "sk-reschedule-autolock" }, { id: SELF, url: `chrome-extension://${SELF}/popup/index.html` }, () => 0);
    await new Promise((r) => setTimeout(r, 50));
  }

  it("control: a page's sk-reschedule-autolock arms sk-autolock", async () => {
    await start();
    expect(f.alarms.has("sk-autolock")).toBe(true);
  });

  it("the same, when reading sk_quick fails: sk-autolock is still armed", async () => {
    await start("sk_quick");
    expect(f.alarms.has("sk-autolock")).toBe(true);
  });
});
