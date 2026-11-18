// The service worker module itself (src/background/sw.ts), loaded over fake chrome.* APIs: its listeners are registered
// once, at the top level, and stay that way however many events arrive; each alarm reaches its own handler; the `lock`
// command soft-locks; permission events that name a host reconcile autofill's sites; and nothing is ever sent. (The server
// sync's worker, bridge and transport, whose wiring this file also held, went with its client: OWNER-DECISIONS/25,
// DV-0b; test/unit/store-worker.test.ts holds every build's worker to none of it.)
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => unknown;
const SELF = "abcdefghijklmnopabcdefghijklmnop";
/** The server sync's API origin's pattern (the dev and e2e builds declared it until DV-0b): now a host like any other. */
const API = "https://api.sixkey.app/*";

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

function fakeChrome(manifest: Record<string, unknown> = { version: "0.1.0" }) {
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
  const alarmGets: string[] = [];
  const badges: string[] = [];
  const perm = { granted: new Set<string>(), asked: [] as string[][], removed: [] as string[][] };
  const chrome = {
    runtime: {
      id: SELF,
      onMessage: on("message"),
      onMessageExternal: on("messageExternal"),
      onConnectExternal: on("connectExternal"),
      onInstalled: on("installed"),
      onStartup: on("startup"),
      getManifest: () => manifest,
      getPlatformInfo: async () => ({}),
      getContexts: async () => [],
      sendMessage: async () => undefined,
    },
    alarms: {
      onAlarm: on("alarm"),
      get: async (n: string) => {
        alarmGets.push(n);
        return alarms.has(n) ? { name: n } : undefined;
      },
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
      contains: async (p: { origins?: string[]; permissions?: string[] }) => {
        if (!p.origins) return false; // autofill's `scripting` (optional since wave 1b): not held here
        perm.asked.push(p.origins);
        return perm.granted.has(p.origins[0]!);
      },
      request: async () => false,
      remove: async (p: { origins: string[] }) => {
        perm.removed.push(p.origins);
        return perm.granted.delete(p.origins[0]!);
      },
      getAll: async () => ({ origins: [...perm.granted] }),
      onAdded: on("permAdded"),
      onRemoved: on("permRemoved"),
    },
  };
  return { chrome, listeners, alarms, alarmGets, badges, perm };
}

describe("src/background/sw.ts", () => {
  let f: ReturnType<typeof fakeChrome>;
  let fetches: string[];
  beforeEach(async () => {
    vi.resetModules();
    f = fakeChrome();
    fetches = [];
    vi.stubGlobal("chrome", f.chrome);
    vi.stubGlobal("fetch", async (url: string) => {
      fetches.push(url);
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    });
    await import("../../src/background/sw");
    await vi.waitFor(() => expect(f.alarms.has("sk-daily")).toBe(true)); // the start's routine ran
  });
  afterEach(() => vi.unstubAllGlobals());

  it("registers each listener once, at load, and no event adds another", async () => {
    const counts = () => Object.fromEntries(Object.entries(f.listeners).map(([k, v]) => [k, v.length]));
    // three message listeners: the pages', the cloud backup's (CLOUDBK patch 4) and the content script's (AUTOFILL2
    // patch 3); none for other extensions (the plugin platform went)
    const once = {
      message: 3,
      messageExternal: 0, // no listener of other extensions since the plugin platform went
      connectExternal: 0,
      alarm: 1,
      installed: 1,
      startup: 1,
      idle: 1,
      permAdded: 1,
      permRemoved: 1,
      command: 1,
    };
    expect(counts()).toEqual(once);
    for (const name of [
      "sk-daily",
      "sk-autolock",
      "sk-quick-expiry",
      "sk-sync-periodic",
      "sk-sync-retry",
      "sk-cloud-soon",
      "sk-cloud-retry",
      "something else",
    ])
      for (const l of f.listeners.alarm!) l({ name });
    for (const l of f.listeners.message!)
      l(
        { type: "sk-reschedule-autolock" },
        { id: SELF, url: `chrome-extension://${SELF}/popup/index.html` },
        () => undefined,
      );
    for (const l of [...f.listeners.permAdded!, ...f.listeners.permRemoved!]) l({ origins: [API] });
    for (const l of f.listeners.command!) l("lock");
    await new Promise((r) => setTimeout(r, 50));
    expect(counts()).toEqual(once);
    expect(fetches).toEqual([]); // nothing sent by any of that
    expect(f.badges).toEqual([]); // nor any toolbar badge drawn (the server sync's went with its worker)
  });

  it("the `lock` command soft-locks with no page open (QUICK-UNLOCK §5.12 item 3): the key goes, the epoch moves on, a PIN's sk_quick stays; any other command does nothing", async () => {
    await new Promise((r) => setTimeout(r, 50)); // the start's own reads are done
    const session = f.chrome.storage.session;
    const quick = { v: 1, method: "pin", note: "left as it is by a soft lock" };
    session.data.set("sk_session", { vk: "AAAA", lastActive: Date.now(), epoch: 0 });
    session.data.set("sk_quick", quick);
    const fire = async (name: string) => {
      for (const l of f.listeners.command!) l(name);
      await new Promise((r) => setTimeout(r, 50));
    };
    await fire("_execute_action");
    await fire("something else");
    expect(session.data.has("sk_session")).toBe(true);
    expect(session.data.get("sk_lock_epoch")).toBeUndefined();
    await fire("lock");
    expect(session.data.has("sk_session")).toBe(false);
    expect(session.data.get("sk_lock_epoch")).toBe(1);
    expect(session.data.get("sk_quick")).toEqual(quick); // soft: not the hard lock
    await fire("lock"); // locking again, with nothing to lock, only moves the epoch
    expect(session.data.get("sk_lock_epoch")).toBe(2);
    expect(fetches).toEqual([]);
  });

  it("each alarm reaches its own handler only: the daily one the snapshot routine; the server sync's old ones nothing", async () => {
    await new Promise((r) => setTimeout(r, 50)); // the start's own reads are done
    const local = f.chrome.storage.local;
    const reads = () => local.reads.length;
    const dailyChecks = () => f.alarmGets.filter((n) => n === "sk-daily").length;
    const fire = async (name: string) => {
      for (const l of f.listeners.alarm!) l({ name });
      await new Promise((r) => setTimeout(r, 50));
    };
    const [r0, d0] = [reads(), dailyChecks()];
    await fire("sk-unrelated");
    for (const name of ["sk-sync-periodic", "sk-sync-sync", "sk-sync-kick", "sk-sync-retry"]) await fire(name);
    expect([reads(), dailyChecks()]).toEqual([r0, d0]); // nothing looked at anything
    await fire("sk-daily");
    expect(dailyChecks()).toBeGreaterThan(d0); // the routine re-checks its alarm
    expect(local.reads.flat().filter((k) => k.startsWith("sk_sync_"))).toEqual([]);
    expect(fetches).toEqual([]);
  });

  it("permission events that name no host (the clipboard pair) read nothing; one that names a host, any host (the old API origin's too), is a site's: the worker looks for its own ask; nothing is sent", async () => {
    await new Promise((r) => setTimeout(r, 50));
    const reads = () => f.chrome.storage.local.reads.length + f.chrome.storage.session.reads.length;
    const r0 = reads();
    for (const l of [...f.listeners.permAdded!, ...f.listeners.permRemoved!]) l({ permissions: ["clipboardWrite"] });
    for (const l of [...f.listeners.permAdded!, ...f.listeners.permRemoved!])
      l({ origins: [], permissions: ["clipboardRead"] });
    await new Promise((r) => setTimeout(r, 50));
    expect(reads()).toBe(r0);
    const asks = () => f.chrome.storage.session.reads.filter((k) => k.includes("sk_af_pending")).length;
    const a0 = asks();
    for (const l of f.listeners.permAdded!) l({ origins: [API] });
    await new Promise((r) => setTimeout(r, 50));
    expect(asks()).toBe(a0 + 1); // acceptPending: Sixkey's own ask for a site, if any (there is none here)
    for (const l of f.listeners.permRemoved!) l({ origins: [API] });
    await new Promise((r) => setTimeout(r, 50));
    expect(f.chrome.storage.local.reads.flat().filter((k) => k.startsWith("sk_sync_"))).toEqual([]);
    expect(fetches).toEqual([]);
  });
});
