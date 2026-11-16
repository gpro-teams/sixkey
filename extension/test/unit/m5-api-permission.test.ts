// The API host permission as the network switch (src/platform/api-permission.ts, the engine's gate, the worker's
// handlers; SYNC-DESIGN §4.9, §7, revision 21), over a real engine and the FakeServer with a stand-in chrome.permissions:
// withdrawn, a round and a push send nothing, end as permission_removed, count no failure and change nothing local but
// the status, and local edits keep writing the outbox; granted again, the next round carries on; withdrawn between the
// engine's check and the request, that request is an ordinary network failure; onRemoved pauses at once, onAdded rounds;
// a browser start removes a permission left without a sync configuration; and a round does the steps that send nothing
// first (finishing a turn-off, the cloud-restore report, step 0's orphan fold, the identity's restore), the permission
// check only after them (revision 22). Chrome's real prompt is a manual check.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEYS } from "../../src/core/storage/format";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { aliveEntries } from "../../src/core/vault/model";
import { tear } from "../helpers/faulty-kv";
import type { HttpRequest, Transport } from "../../src/core/sync/engine/transport";
import { NetworkError } from "../../src/core/sync/engine/transport";
import { API_ORIGIN } from "../../src/platform/api-origin";
import {
  API_PERMISSION,
  apiPermissionGranted,
  apiPermissionRequired,
  concernsApi,
  permissionGated,
  removeApiPermission,
  requestApiPermission,
  type PermissionsLike,
} from "../../src/platform/api-permission";
import { STALE_MS, SYNC_ALARMS, SyncWorker, WorkerScheduler, type WorkerChrome } from "../../src/platform/sync-worker";
import { contextOver, newDisk, worldOf, type Device, type World } from "../helpers/m3-world";

const ORIGIN_PATTERN = `${API_ORIGIN}/*`;

/** A stand-in chrome.permissions with one switch, recording what is asked. */
type Perms = {
  granted: boolean;
  asked: unknown[];
  removed: unknown[];
  requested: unknown[];
  api: WorkerChrome["permissions"];
};
function permissions(granted = true): Perms {
  const p: Perms = {
    granted,
    asked: [] as unknown[],
    removed: [] as unknown[],
    requested: [] as unknown[],
    api: {
      contains: async (x: { origins: string[] }) => {
        p.asked.push(x);
        return p.granted;
      },
      request: async (x: { origins: string[] }) => {
        p.requested.push(x);
        p.granted = true;
        return true;
      },
      remove: async (x: { origins: string[] }) => {
        p.removed.push(x);
        const was = p.granted;
        p.granted = false;
        return was;
      },
      getAll: async () => ({ origins: p.granted ? [ORIGIN_PATTERN] : [] }),
    },
  };
  return p;
}

function workerOver(d: Device, p = permissions(), o: { required?: boolean; granted?: () => Promise<boolean> } = {}) {
  const badges: string[] = [];
  const alarms = new Map<string, unknown>();
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
    ping: async () => undefined,
    permissions: p.api,
  };
  const granted = o.granted ?? (() => apiPermissionGranted(p.api));
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
    ...(o.required ? { permissionRequired: true } : {}),
  });
  return { worker, engine: ctx.engine, badges, alarms, p };
}

const sent = (w: World) => w.server.requests.length;
const stateOf = (d: Device) => d.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown> | undefined;
/** Everything a device keeps: storage.local (sk_sync_state without its status), the IndexedDB identity, the mirror. */
function keptOf(d: Device): unknown {
  const local = Object.fromEntries(
    [...d.disk.kv.data].map(([k, v]) => [
      k,
      k === SYNC_KEYS.state && v && typeof v === "object" ? { ...(v as object), status: "-" } : v,
    ]),
  );
  return structuredClone({
    local,
    idb: Object.fromEntries(d.disk.idb.data),
    mirror: Object.fromEntries(d.disk.mirror.data),
  });
}

describe("the helpers", () => {
  it("ask, request and remove exactly the build's API origin; a failure to ask or to remove says no", async () => {
    const p = permissions(false);
    expect(API_PERMISSION).toEqual({ origins: [ORIGIN_PATTERN] });
    expect(await apiPermissionGranted(p.api)).toBe(false);
    expect(await requestApiPermission(p.api)).toBe(true);
    expect(await apiPermissionGranted(p.api)).toBe(true);
    expect(await removeApiPermission(p.api)).toBe(true);
    for (const x of [...p.asked, ...p.requested, ...p.removed]) expect(x).toEqual({ origins: [ORIGIN_PATTERN] });
    const failing: PermissionsLike = {
      contains: async () => {
        throw new Error("x");
      },
      request: async () => {
        throw new Error("x");
      },
      remove: async () => {
        throw new Error("You cannot remove required permissions.");
      },
    };
    expect(await apiPermissionGranted(failing)).toBe(false);
    expect(await removeApiPermission(failing)).toBe(false);
  });

  it("an event is sync's when it names a host (the handlers ask again); a manifest requires the permission only in host_permissions", () => {
    expect(concernsApi({ origins: [ORIGIN_PATTERN] })).toBe(true);
    expect(concernsApi({ origins: [`*://${new URL(API_ORIGIN).host}/*`] })).toBe(true); // however Chrome spells it
    for (const e of [undefined, {}, { origins: [] }, { permissions: ["clipboardRead"] } as { origins?: string[] }])
      expect(concernsApi(e)).toBe(false);
    expect(apiPermissionRequired({ host_permissions: [ORIGIN_PATTERN] })).toBe(true);
    for (const m of [
      {},
      { optional_host_permissions: [ORIGIN_PATTERN] },
      { host_permissions: [] },
      { host_permissions: ORIGIN_PATTERN },
    ])
      expect(apiPermissionRequired(m)).toBe(false);
  });

  it("the gated transport sends nothing while not granted (a network error), and sends when granted", async () => {
    const seen: HttpRequest[] = [];
    const inner: Transport = {
      send: async (r) => {
        seen.push(r);
        return { status: 200, headers: {}, body: "" };
      },
    };
    let ok = false;
    const t = permissionGated(inner, async () => ok);
    const req: HttpRequest = { method: "GET", target: "/v1/sync/status", headers: {} };
    await expect(t.send(req)).rejects.toBeInstanceOf(NetworkError);
    expect(seen).toEqual([]);
    ok = true;
    expect((await t.send(req)).status).toBe(200);
    expect(seen).toEqual([req]);
  });
});

describe("the engine and the worker without the permission", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
  afterEach(() => vi.useRealTimers());

  it("withdrawn: rounds and pushes send nothing, end as permission_removed, count no failure and change nothing but the status; local edits keep writing the outbox; granted again, the next round carries on", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    const { worker, engine, p } = workerOver(a);
    await worker.start();
    // an earlier failure with its backoff
    a.disk.kv.data.set(SYNC_KEYS.state, {
      ...stateOf(a),
      failures: 2,
      backoffUntil: w.clock.now + 60_000,
      lastErrorCode: "network",
    });
    p.granted = false;
    w.advance(1000);
    await a.add("Offline edit"); // a page's commit: the outbox is written as always, and the worker asked for a round
    await worker.soon();
    expect(a.disk.kv.data.get(SYNC_KEYS.outbox)).toBeTruthy();
    const kept = keptOf(a);
    const n0 = sent(w);
    for (const r of [await engine.round(), await engine.push(), await engine.round({ explicit: true })])
      expect(r.status).toBe("permission_removed");
    const session = a.disk.session.data;
    a.disk.session.data = null; // and a locked round (no key in this context)
    expect((await engine.round()).status).toBe("permission_removed");
    a.disk.session.data = session;
    await vi.advanceTimersByTimeAsync(STALE_MS); // the debounced wake, still inside the backoff
    w.advance(61_000); // the backoff is over: the next wake runs, and the gate stops it
    await worker.alarm(SYNC_ALARMS.periodic);
    await worker.shown();
    expect(sent(w)).toBe(n0);
    expect(stateOf(a)).toMatchObject({ status: "permission_removed", failures: 2, lastErrorCode: "network" });
    expect(keptOf(a)).toEqual(kept);
    // granted again: the edit goes up, the failures are reset, the status is ok again
    p.granted = true;
    await worker.permissionAdded();
    expect(stateOf(a)).toMatchObject({ status: "ok", failures: 0, backoffUntil: null });
    expect(a.disk.kv.data.get(SYNC_KEYS.outbox) ?? null).toBeNull();
    expect(w.server.requests.some((r) => r.op === "PUT /v1/vault" && r.status === 200)).toBe(true);
    expect((await w.serverVault(await a.vk()))!.entries.map((e) => e.issuer)).toContain("Offline edit");
  }, 60_000);

  it("withdrawn between the engine's check and the request: an ordinary network failure; the next round says permission_removed", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    let checks = 0;
    const { engine } = workerOver(a, permissions(), { granted: async () => checks++ === 0 });
    const n0 = sent(w);
    const r = await engine.round({ explicit: true });
    expect(r).toMatchObject({ status: "offline", error: "network" });
    expect(sent(w)).toBe(n0);
    expect(stateOf(a)).toMatchObject({ status: "offline", failures: 1, lastErrorCode: "network" });
    expect((await engine.round({ explicit: true })).status).toBe("permission_removed");
    expect(stateOf(a)).toMatchObject({ status: "permission_removed", failures: 1 });
  }, 60_000);

  it("a gate that fails to answer counts as not granted", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    const { engine } = workerOver(a, permissions(), {
      granted: async () => {
        throw new Error("no answer");
      },
    });
    const n0 = sent(w);
    expect((await engine.round()).status).toBe("permission_removed");
    expect(sent(w)).toBe(n0);
  }, 60_000);

  it("onRemoved: permission_removed at once and the badge cleared, nothing sent; onAdded: a round; an onRemoved already undone changes nothing", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    a.disk.kv.data.set(SYNC_KEYS.state, { ...stateOf(a), pendingEnrollments: 2 });
    const { worker, badges, p } = workerOver(a);
    await worker.start();
    expect(badges.at(-1)).toBe("2");
    const n0 = sent(w);
    p.granted = false;
    await worker.permissionRemoved();
    expect(stateOf(a)!.status).toBe("permission_removed");
    expect(badges.at(-1)).toBe("");
    expect(sent(w)).toBe(n0);
    p.granted = true;
    w.advance(STALE_MS + 1000);
    await worker.permissionAdded();
    expect(sent(w)).toBeGreaterThan(n0);
    expect(stateOf(a)!.status).toBe("ok");
    // removed and granted again before the worker handled the removal: the status stays as it is
    await worker.permissionRemoved();
    expect(stateOf(a)!.status).toBe("ok");
  }, 60_000);

  it("with sync off, a missing permission is no pause: 'off', nothing written, nothing sent, no round on onAdded", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const d = w.device("Fresh", newDisk());
    const { worker, engine, p } = workerOver(d, permissions(false));
    const n0 = sent(w);
    expect((await engine.round()).status).toBe("off");
    expect((await engine.push()).status).toBe("off");
    await worker.permissionRemoved();
    p.granted = true;
    await worker.permissionAdded();
    expect(sent(w)).toBe(n0);
    expect(d.disk.kv.data.has(SYNC_KEYS.state)).toBe(false);
  }, 60_000);
});

describe("what a round does before it asks: the steps that send nothing (§4.9, §4.2, revision 22)", () => {
  /** The device's records, the request count and the failure accounting, for "nothing sent, nothing else written". */
  const accounts = (d: Device) => ({
    failures: stateOf(d)?.failures ?? 0,
    backoffUntil: stateOf(d)?.backoffUntil ?? null,
    lastErrorCode: stateOf(d)?.lastErrorCode ?? null,
  });

  for (const how of ["round", "push"] as const) {
    it(`an unfinished turn-off (no sk_sync_cfg, the vault readable) is finished without the permission (${how})`, async () => {
      const w = await worldOf(2, ["GitHub"]);
      const b = w.devices[1]!;
      b.disk.kv.data.delete(SYNC_KEYS.cfg);
      const { engine } = workerOver(b, permissions(false));
      const n0 = sent(w);
      expect((await engine[how]()).status).toBe("off");
      expect(sent(w)).toBe(n0);
      expect(b.disk.idb.data.size).toBe(0); // the identity gone: the turn-off's local half is done
      for (const k of [SYNC_KEYS.state, SYNC_KEYS.outbox, SYNC_KEYS.orphan])
        expect(b.disk.kv.data.get(k) ?? null, k).toBeNull();
      expect(aliveEntries(await b.vault()).map((e) => e.issuer)).toEqual(["GitHub"]); // the vault kept
    }, 60_000);
  }

  it("a lost local vault is reported as cloud_restore to a page without the permission, and nothing is sent or written", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const b = w.devices[1]!;
    b.disk.kv.data.clear();
    b.disk.mirror.data.clear();
    await b.restartBrowser();
    const idb = structuredClone(Object.fromEntries(b.disk.idb.data));
    const { engine } = workerOver(b, permissions(false));
    const n0 = sent(w);
    expect((await engine.round()).status).toBe("cloud_restore");
    expect(sent(w)).toBe(n0);
    expect(b.disk.kv.data.get(SYNC_KEYS.state) ?? null).toBeNull();
    expect(Object.fromEntries(b.disk.idb.data)).toEqual(idb);
  }, 60_000);

  it("step 0's orphan fold runs without the permission: the save is back in the vault; nothing is sent, no failure counted", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    const st = stateOf(a)!;
    a.disk.kv.data.set(SYNC_KEYS.state, {
      ...st,
      failures: 1,
      backoffUntil: w.clock.now - 1,
      lastErrorCode: "network",
    });
    w.advance(1000);
    await a.add("Saved, then torn");
    const ptr = a.disk.kv.data.get(KEYS.active) as "a" | "b";
    a.disk.kv.data.set(KEYS.slot[ptr], tear(a.disk.kv.data.get(KEYS.slot[ptr]))); // the slot holding the save, torn
    const { engine } = workerOver(a, permissions(false));
    const before = accounts(a);
    const n0 = sent(w);
    expect((await engine.round()).status).toBe("permission_removed");
    expect(sent(w)).toBe(n0);
    expect(
      aliveEntries(await a.vault())
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["GitHub", "Saved, then torn"]); // folded
    expect(accounts(a)).toEqual(before);
    expect(stateOf(a)!.status).toBe("permission_removed");
  }, 60_000);

  it("a damaged orphan list is cleared by step 0 without the permission, and nothing else changes", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    a.disk.kv.data.set(SYNC_KEYS.orphan, "damaged");
    const { engine } = workerOver(a, permissions(false));
    const kept = keptOf(a) as { local: Record<string, unknown> };
    const n0 = sent(w);
    expect((await engine.round()).status).toBe("permission_removed");
    expect(sent(w)).toBe(n0);
    const now = keptOf(a) as { local: Record<string, unknown> };
    expect(now.local[SYNC_KEYS.orphan] ?? null).toBeNull();
    delete kept.local[SYNC_KEYS.orphan];
    delete now.local[SYNC_KEYS.orphan];
    expect(now).toEqual(kept);
  }, 60_000);

  it("an identity lost from IndexedDB is restored from its copy without the permission (unlocked), and nothing is sent", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const b = w.devices[1]!;
    const id0 = await b.local.settlePins();
    b.disk.idb.data.clear();
    const { engine } = workerOver(b, permissions(false));
    const n0 = sent(w);
    expect((await engine.round()).status).toBe("permission_removed");
    expect(sent(w)).toBe(n0);
    expect(b.disk.idb.data.size).toBeGreaterThan(0);
    expect(((await b.local.settlePins()) as { deviceId: string }).deviceId).toBe(
      (id0 as { deviceId: string }).deviceId,
    );
  }, 60_000);
});

describe("a browser start (§7)", () => {
  it("removes a permission granted without a sync configuration; keeps it with sync on; never touches a required one", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const on = w.devices[0]!;
    const off = w.device("Fresh", newDisk());

    const left = workerOver(off);
    await left.worker.browserStarted();
    expect(left.p.removed).toEqual([{ origins: [ORIGIN_PATTERN] }]);
    expect(left.p.granted).toBe(false);

    const none = workerOver(off, permissions(false));
    await none.worker.browserStarted();
    expect(none.p.removed).toEqual([]); // not granted: nothing to remove

    const synced = workerOver(on);
    await synced.worker.browserStarted();
    expect(synced.p.removed).toEqual([]);
    expect(synced.p.granted).toBe(true);

    const required = workerOver(off, permissions(), { required: true });
    await required.worker.browserStarted();
    expect([required.p.asked, required.p.removed]).toEqual([[], []]);
  }, 60_000);
});
