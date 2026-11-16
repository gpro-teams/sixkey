// The service worker module itself (src/background/sw.ts), loaded over fake chrome.* APIs: its listeners are registered
// once, at the top level, and stay that way however many events arrive; a bridge request from the settings page is sent
// exactly once, with the build's API origin, and only while the API host permission is granted; one from another page is
// not sent at all; with sync off a start sends nothing and clears the badge; a browser start removes a permission left
// without a sync configuration.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => unknown;
const SELF = "abcdefghijklmnopabcdefghijklmnop";
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
  const perm = { granted: new Set([API]), asked: [] as string[][], removed: [] as string[][] };
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
    vi.stubGlobal("__SYNC_UI__", true); // a build with the sync user interface: the worker's sync
    await import("../../src/background/sw");
    await vi.waitFor(() => expect(f.badges).toEqual([""])); // the start, with sync off
  });
  afterEach(() => vi.unstubAllGlobals());

  it("registers each listener once, at load, and no event adds another", async () => {
    const counts = () => Object.fromEntries(Object.entries(f.listeners).map(([k, v]) => [k, v.length]));
    // four message listeners: the pages', the bridge's, the cloud backup's (CLOUDBK patch 4) and the content script's
    // (AUTOFILL2 patch 3); and one for the official and listed plugins' messages, one that refuses their ports
    // (src/platform/plugins/worker.ts)
    const once = {
      message: 4,
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
    expect(fetches).toEqual([]); // sync is off: nothing sent by any of that
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

  it("each alarm reaches its own handler only: sync's alarms the engine, the daily one the snapshot routine", async () => {
    await new Promise((r) => setTimeout(r, 50)); // the start's own reads are done
    const local = f.chrome.storage.local;
    const syncReads = () => local.reads.filter((k) => k.includes("sk_sync_state")).length;
    const dailyChecks = () => f.alarmGets.filter((n) => n === "sk-daily").length;
    const fire = async (name: string) => {
      for (const l of f.listeners.alarm!) l({ name });
      await new Promise((r) => setTimeout(r, 50));
    };
    const [s0, d0] = [syncReads(), dailyChecks()];
    await fire("sk-unrelated");
    expect([syncReads(), dailyChecks()]).toEqual([s0, d0]);
    await fire("sk-sync-periodic");
    expect(syncReads()).toBeGreaterThan(s0); // the engine looked (sync is off: it does nothing more)
    expect(dailyChecks()).toBe(d0); // and the daily routine did not run
    const s1 = syncReads();
    await fire("sk-daily");
    expect(dailyChecks()).toBeGreaterThan(d0); // the routine re-checks its alarm
    expect(syncReads()).toBe(s1);
  });

  it("a bridge request from the settings page is sent exactly once, to the API origin; from the popup, not at all", async () => {
    const ask = (url: string, keeps = 1) =>
      new Promise<unknown>((resolve) => {
        let kept = 0;
        for (const l of f.listeners.message!)
          if (
            l(
              { type: "sk-api", req: { method: "GET", target: "/healthz", headers: {} } },
              { id: SELF, url },
              resolve,
            ) === true
          )
            kept++;
        expect(kept).toBe(keeps); // one listener keeps the channel open for the settings page; none for any other sender
        setTimeout(() => resolve("no answer"), 200);
      });
    expect(await ask(`chrome-extension://${SELF}/options/index.html`)).toMatchObject({
      ok: true,
      res: { status: 200, body: '{"ok":true}' },
    });
    expect(fetches).toEqual(["https://api.sixkey.app/healthz"]);
    expect(await ask(`chrome-extension://${SELF}/popup/index.html`, 0)).toBe("no answer");
    expect(fetches).toHaveLength(1);
    // after any number of daily alarms, still exactly one send per request
    for (let i = 0; i < 3; i++) for (const l of f.listeners.alarm!) l({ name: "sk-daily" });
    await ask(`chrome-extension://${SELF}/options/index.html`);
    expect(fetches).toHaveLength(2);
    // the permission withdrawn: the request is refused before it leaves (a network error to the page), nothing is sent
    f.perm.granted.clear();
    expect(await ask(`chrome-extension://${SELF}/options/index.html`)).toEqual({ ok: false, reason: "offline" });
    expect(fetches).toHaveLength(2);
    expect(f.perm.asked.every((o) => o.length === 1 && o[0] === API)).toBe(true);
  });

  it("a browser start removes an API permission granted without a sync configuration (an enable flow whose tab closed), and only then", async () => {
    const start = async () => {
      for (const l of f.listeners.startup!) l();
      await new Promise((r) => setTimeout(r, 50));
    };
    await start(); // granted, no sk_sync_cfg: removed
    expect(f.perm.removed).toEqual([[API]]);
    await start(); // not granted any more: nothing to remove
    expect(f.perm.removed).toHaveLength(1);
    f.perm.granted.add(API);
    f.chrome.storage.local.data.set("sk_sync_cfg", { v: 1 }); // sync configured: the permission is the one it needs
    await start();
    expect(f.perm.removed).toHaveLength(1);
    expect(f.perm.granted.has(API)).toBe(true);
    expect(fetches).toEqual([]);
  });

  it("a build that requires the permission (e2e) never removes it at a browser start", async () => {
    vi.resetModules();
    f = fakeChrome({ version: "0.1.0", host_permissions: [API] });
    vi.stubGlobal("chrome", f.chrome);
    vi.stubGlobal("__SYNC_UI__", true); // a build with the sync user interface: the worker's sync
    await import("../../src/background/sw");
    await vi.waitFor(() => expect(f.badges).toEqual([""]));
    for (const l of f.listeners.startup!) l();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.perm.removed).toEqual([]);
  });

  it("permission events that name no host (the clipboard pair) are not sync's; one that names a host is handled and sends nothing with sync off", async () => {
    await new Promise((r) => setTimeout(r, 50));
    const reads = () => f.chrome.storage.local.reads.length;
    const r0 = reads();
    for (const l of [...f.listeners.permAdded!, ...f.listeners.permRemoved!]) l({ permissions: ["clipboardWrite"] });
    for (const l of [...f.listeners.permAdded!, ...f.listeners.permRemoved!])
      l({ origins: [], permissions: ["clipboardRead"] });
    await new Promise((r) => setTimeout(r, 50));
    expect(reads()).toBe(r0);
    for (const l of f.listeners.permAdded!) l({ origins: [API] });
    await new Promise((r) => setTimeout(r, 50));
    expect(reads()).toBe(r0 + 1); // the state, once: sync is off, so no round
    const asked = f.perm.asked.length;
    for (const l of f.listeners.permRemoved!) l({ origins: [API] });
    await new Promise((r) => setTimeout(r, 50));
    expect(f.perm.asked.length).toBe(asked + 1); // asked again (still granted here: nothing to pause)
    expect(reads()).toBe(r0 + 2); // and the badge brought up to date from the state
    expect(fetches).toEqual([]);
  });
});
