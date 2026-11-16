// TOTP autofill Stage 2, patch 2: what the optional https://*/* changes for sync (AUTOFILL2-PLAN §3.4 with its review's
// m5; docs/design/notes/AUTOFILL2-NOTES.md §7), over a real engine and the FakeServer, with a chrome.permissions that
// matches patterns as Chrome does (a granted pattern covers an asked one; https://*/* covers every https origin):
//   - a site's grant (https://github.com/*) is never the API permission: it satisfies no check, its onAdded runs no round
//     that sends while the API's is withdrawn, and its onRemoved pauses nothing;
//   - "On all sites" (https://*/*) does cover the API origin, but with sync off nothing is sent (the engine reads sync's
//     own configuration first: the M8 gate), and a browser start does not try to remove the API pattern from under it:
//     only a grant Chrome lists exactly is removed (§3.4 item 3);
//   - the reverse: the API's grant is never a site (siteHostOk, the worker's end of an ask), and turning a site off never
//     gives back the API's pattern; sync's give-back gives back only the API's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { siteHostOk } from "../../src/core/autofill-sites";
import { MemoryKV } from "../../src/core/storage/kv";
import { API_ORIGIN } from "../../src/platform/api-origin";
import {
  API_PERMISSION,
  apiPermissionGranted,
  concernsApi,
  permissionGated,
  removeApiPermission,
} from "../../src/platform/api-permission";
import { acceptPending, PENDING_KEY, removeSite, SITES_KEY } from "../../src/platform/autofill-sites";
import { SYNC_ALARMS, SyncWorker, WorkerScheduler, type WorkerChrome } from "../../src/platform/sync-worker";
import { contextOver, newDisk, worldOf, type Device, type World } from "../helpers/m3-world";
import { covers } from "../helpers/sw-world";

const API = API_PERMISSION.origins[0]!;
const SITE = "https://github.com/*";
const ALL = "https://*/*";

/** chrome.permissions over a set of granted patterns, matched as Chrome matches them; what was removed, in order. */
function grants(initial: string[]) {
  const set = new Set(initial);
  const removed: string[][] = [];
  const api: WorkerChrome["permissions"] = {
    contains: async (x) => x.origins.every((a) => [...set].some((g) => covers(g, a))),
    request: async (x) => {
      for (const o of x.origins) set.add(o);
      return true;
    },
    remove: async (x) => {
      removed.push(x.origins);
      return x.origins.every((o) => set.delete(o));
    },
    getAll: async () => ({ origins: [...set] }),
  };
  return { set, removed, api };
}

function workerOver(d: Device, p: ReturnType<typeof grants>) {
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
  const worker = new SyncWorker({
    engine: ctx.engine,
    scheduler,
    chrome: c,
    transport,
    keyHere: async () => d.disk.session.data !== null,
    now: d.now,
    random: () => 0.5,
  });
  return { worker, engine: ctx.engine };
}

const sent = (w: World) => w.server.requests.length;
const stateOf = (d: Device) => d.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown> | undefined;

describe("a site's grant is not the sync API's permission", () => {
  it("no check of the API permission is satisfied by sites' grants, however many; the API's or a broad one is", async () => {
    expect(await apiPermissionGranted(grants([SITE, "https://gitlab.com/*", "http://github.com/*"]).api)).toBe(false);
    expect(await apiPermissionGranted(grants([API]).api)).toBe(true);
    expect(await apiPermissionGranted(grants([ALL]).api)).toBe(API.startsWith("https:")); // the store build's API is https
  });

  it("an event for a site is looked at (the handlers ask again), and that is all", () => {
    expect(concernsApi({ origins: [SITE] })).toBe(true); // kept wide on purpose (review m5)
  });
});

describe("the worker with sync on, and a site's grant coming and going", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
  afterEach(() => vi.useRealTimers());

  it("a site's onRemoved pauses nothing; a site's onAdded while the API's is withdrawn sends nothing", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    const p = grants([API, SITE]);
    const { worker } = workerOver(a, p);
    await worker.start();
    const status = stateOf(a)!.status;
    p.set.delete(SITE); // the site withdrawn in Chrome's settings
    await worker.permissionRemoved();
    expect(stateOf(a)!.status).toBe(status);
    expect(stateOf(a)!.status).not.toBe("permission_removed");
    // the API's withdrawn: paused; a site granted then is no reason to send
    p.set.delete(API);
    await worker.permissionRemoved();
    expect(stateOf(a)!.status).toBe("permission_removed");
    const n0 = sent(w);
    p.set.add(SITE);
    await worker.permissionAdded();
    await worker.alarm(SYNC_ALARMS.periodic);
    await worker.shown();
    expect(sent(w)).toBe(n0);
    expect(stateOf(a)!.status).toBe("permission_removed");
  }, 60_000);
});

describe('sync on, reachable only through "On all sites" (P2 verify NIT-5: why concernsApi stays "any host")', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
  afterEach(() => vi.useRealTimers());

  it("that grant withdrawn: its event is sync's, and sync pauses at once; given back, a round", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    const p = grants([ALL]); // the API's own pattern never granted: the broad grant is what lets it be reached
    const { worker } = workerOver(a, p);
    await worker.start();
    expect(stateOf(a)!.status).not.toBe("permission_removed");
    p.set.delete(ALL);
    const removed = { origins: [ALL] }; // what Chrome reports
    expect(concernsApi(removed)).toBe(true); // the worker's listener hands it to sync (src/background/sw.ts)
    if (concernsApi(removed)) await worker.permissionRemoved();
    expect(stateOf(a)!.status).toBe("permission_removed");
    const n0 = sent(w);
    p.set.add(ALL);
    if (concernsApi({ origins: [ALL] })) await worker.permissionAdded();
    expect(sent(w)).toBeGreaterThan(n0);
  }, 60_000);
});

describe('"On all sites" and a profile without sync', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
  afterEach(() => vi.useRealTimers());

  it("with sync off, nothing is sent (the M8 gate: sync's own configuration first), and nothing is written", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const d = w.device("Fresh", newDisk());
    const p = grants([ALL]);
    const { worker, engine } = workerOver(d, p);
    const n0 = sent(w);
    await worker.start();
    await worker.permissionAdded();
    await worker.soon();
    await worker.shown();
    await worker.alarm(SYNC_ALARMS.periodic);
    expect((await engine.round()).status).toBe("off");
    expect((await engine.push()).status).toBe("off");
    expect(sent(w)).toBe(n0);
    expect(d.disk.kv.data.has(SYNC_KEYS.state)).toBe(false);
  }, 60_000);

  it("a browser start removes only an API grant Chrome lists exactly: never from under a broad one", async () => {
    const w = await worldOf(1, ["GitHub"]);
    // the broad grant alone (chosen in Chrome's menu for autofill): left as it is
    const broad = grants([ALL, SITE]);
    await workerOver(w.device("Broad", newDisk()), broad).worker.browserStarted();
    expect(broad.removed).toEqual([]);
    expect([...broad.set]).toEqual([ALL, SITE]);
    // the exact grant left by an unfinished enable flow: removed, and only it
    const exact = grants([API, SITE]);
    await workerOver(w.device("Exact", newDisk()), exact).worker.browserStarted();
    expect(exact.removed).toEqual([[API]]);
    expect([...exact.set]).toEqual([SITE]);
    // both: the exact one goes, the broad one stays
    const both = grants([API, ALL]);
    await workerOver(w.device("Both", newDisk()), both).worker.browserStarted();
    expect(both.removed).toEqual([[API]]);
    expect([...both.set]).toEqual([ALL]);
    // with sync on, nothing is removed at all
    const on = grants([API]);
    await workerOver(w.devices[0]!, on).worker.browserStarted();
    expect(on.removed).toEqual([]);
  }, 60_000);

  it("a failure to list the grants removes nothing", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const p = grants([API]);
    p.api.getAll = async () => Promise.reject(new Error("x"));
    await workerOver(w.device("Fresh", newDisk()), p).worker.browserStarted();
    expect(p.removed).toEqual([]);
  }, 60_000);
});

describe("the reverse: the API's grant is never a site, and neither gives back the other", () => {
  it("the API host may not be turned on, and the worker's end of an ask never adds it", async () => {
    const apiHost = new URL(API_ORIGIN).hostname;
    expect(siteHostOk(apiHost, apiHost)).toBe(false);
    const local = new MemoryKV();
    const session = new MemoryKV();
    await session.set({ [PENDING_KEY]: { v: 1, host: "github.com", at: 1000 } });
    expect(await acceptPending({ origins: [API] }, local, session, 1001)).toBe(false); // sync turned on meanwhile
    expect(local.data.has(SITES_KEY)).toBe(false);
  });

  it("turning a site off never gives back the API's pattern; sync's give-back gives back only the API's", async () => {
    const local = new MemoryKV();
    await local.set({ [SITES_KEY]: { v: 1, hosts: ["github.com"] } });
    const p = grants([API, SITE]);
    await removeSite("github.com", local, p.api);
    expect(p.removed).toEqual([[SITE]]);
    expect([...p.set]).toEqual([API]);
    const q = grants([API, SITE]);
    expect(await removeApiPermission(q.api)).toBe(true);
    expect(q.removed).toEqual([[API]]);
    expect([...q.set]).toEqual([SITE]);
  });
});
