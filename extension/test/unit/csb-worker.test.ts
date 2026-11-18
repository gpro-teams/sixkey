// The backup in Chrome's sync storage in the service worker (CSB-3; src/platform/csb-worker.ts), over the fake
// storage.sync (test/helpers/fake-sync-area.ts: Chrome's quotas, texts and counters) and real vaults in a real store:
// its two records (csb-config.ts) and the store's recovery mark (cloud-mark.ts); when it runs (the scheduling moved from
// the Drive path's worker: the debounce, its ceiling, one run at a time, the retries' delays, the daily check); that it
// runs only where this worker's start closed storage.sync (the maintainers' C7); what one run writes, decision by
// decision (core/cloud/slots.ts's rules, the link saved before and after the set, a hold saved held, the leftovers),
// Chrome's refusals (QUOTA_BYTES: the area read again before no_room), a bug, a stale view; the settings
// page's messages (on, off and what it removes, now, the switch, a restore's adoption, a held slot's merge and its
// generation check, a merge's removal of other slots); and the real sw.ts over fake chrome.*.
// The delays are written out here as numbers, not read from the module: a change of one must change this file too.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeCloudBackup } from "../../src/core/cloud/format";
import {
  assembleSlot,
  chunkKey,
  heldLink,
  manifestKey,
  planSlot,
  readSlots,
  ROOM_BYTES,
  wrapsOf,
  type SlotLink,
} from "../../src/core/cloud/slots";
import type { Generation } from "../../src/core/storage/format";
import { createMutex, MemoryKV, type Lock } from "../../src/core/storage/kv";
import { VaultStore, type LoadResult } from "../../src/core/storage/store";
import { emptyVault } from "../../src/core/vault/model";
import { CSB_CFG_KEY, markCsbHeld } from "../../src/platform/cloud-mark";
import {
  CSB_STATE_KEY,
  NEW_CSB_CONFIG,
  NEW_CSB_STATE,
  parseCsbConfig,
  parseCsbState,
  parseSlotLink,
  type CsbConfig,
} from "../../src/platform/csb-config";
import {
  createCsbWorker,
  CSB_RETRY_ALARM,
  CSB_SOON_ALARM,
  LAST_BACKUP_KEY,
  VAULT_POINTER,
  watchVault,
} from "../../src/platform/csb-worker";
import { account, PASSWORD, protectedKeys, seal, T0, vaultOf, type Keys } from "../helpers/cloud";
import { chromiumItemBytes, FakeSyncArea, TEXTS } from "../helpers/fake-sync-area";
import { loadWorker, unload } from "../helpers/sw-world";
import { legacyDeviceGeneration } from "../helpers/vaults";

const MIN = 60_000;
const SECRET = "JBSWY3DPEHPK3PXP";
const APP = "Sixkey 0.1.0";
const TAG = "0123456789abcdef";

let keys: Keys;
let otherKeys: Keys;
let g1: Generation;
let g2: Generation;
let g3: Generation;
const many = (n: number, name = "Service") => Array.from({ length: n }, (_, i) => account(`${name} ${i}`, SECRET));
beforeAll(async () => {
  keys = await protectedKeys();
  otherKeys = await protectedKeys(`${PASSWORD}-other`);
  const v = keys.keyring.vaultId;
  g1 = await seal(keys, vaultOf(v, [account("GitHub", SECRET)]), 1);
  g2 = await seal(keys, vaultOf(v, [account("GitHub", SECRET), account("GitLab", SECRET)]), 2);
  g3 = await seal(keys, vaultOf(v, [account("Gitea", SECRET)]), 3);
});

/** A slot's items as another computer (or this one) wrote them: `gen` in the file format, at `slot`, under `tag`. */
async function itemsOf(gen: Generation, slot: string, tag = TAG): Promise<Record<string, unknown>> {
  const plan = await planSlot(await makeCloudBackup(gen, "both", APP), slot, tag);
  if (plan.kind !== "plan") throw new Error("too large for a slot");
  return plan.items;
}
/** Items of no slot that take exactly `bytes` of the area (at least 100), as Chrome counts them. */
function filler(bytes: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; bytes > 0; i++) {
    const key = `zz.${i}`;
    let take = Math.min(8_000, bytes);
    if (bytes - take > 0 && bytes - take < 100) take = bytes - 100; // the last item keeps room for its key
    out[key] = "x".repeat(take - key.length - 2);
    bytes -= chromiumItemBytes(key, out[key]);
  }
  return out;
}

type Opts = { access?: boolean; items?: Record<string, unknown>; load?: () => Promise<LoadResult>; app?: string };
function world(o: Opts = {}) {
  const kv = new MemoryKV();
  const lock = createMutex();
  const s = { t: T0, access: o.access ?? true, loads: 0, vaultRequests: 0 };
  const area = new FakeSyncArea({ now: () => s.t, items: o.items ?? {} });
  const alarms = new Map<string, number>();
  const notes: string[] = [];
  // the store's lock, shared with the store as the runtime builds it (the recovery hook inside it, taking the records'
  // lock), and counted: who asked for it
  const storeLock = createMutex();
  const vaultLock: Lock = (fn) => {
    s.vaultRequests++;
    return storeLock(fn);
  };
  const store = new VaultStore({ kv, lock: vaultLock, beforeRecoveryWrite: () => markCsbHeld(kv, lock) });
  const w = createCsbWorker({
    kv,
    lock,
    vaultLock,
    load: () => {
      s.loads++;
      return o.load ? o.load() : store.load();
    },
    alarms: { create: (n, i) => void alarms.set(n, i.when), clear: async (n) => alarms.delete(n) },
    now: () => s.t,
    app: o.app ?? APP,
    access: async () => s.access,
    note: (line) => void notes.push(line),
    area,
  });
  /** The vault on disk: the store's pointer and the slot it names (what VaultStore.load reads first). */
  const put = (gen: Generation) => kv.set({ sk_active: "a", sk_slot_a: gen });
  const cfg = async () => parseCsbConfig((await kv.get([CSB_CFG_KEY]))[CSB_CFG_KEY]);
  const state = async () => parseCsbState((await kv.get([CSB_STATE_KEY]))[CSB_STATE_KEY]);
  const setCfg = async (f: (c: CsbConfig) => CsbConfig) => kv.set({ [CSB_CFG_KEY]: f(await cfg()) });
  const link = async () => (await cfg()).link!;
  /** The browser fires a one-shot alarm: it is gone, and the worker is told. */
  const fire = async (name: string) => {
    alarms.delete(name);
    expect(w.alarm(name)).toBe(true);
    await w.idle();
  };
  /** On, with `gen` on disk, and the first write done. */
  const start = async (gen = g1) => {
    await put(gen);
    expect(await w.on()).toEqual({ ok: true });
    await w.idle();
  };
  const run = async () => {
    await w.run();
    await w.idle();
  };
  const own = async () => assembleSlot(area.snapshot(), (await link()).slot);
  const sets = () => area.callsOf("set").length;
  return {
    ...{ w, kv, lock, vaultLock, s, area, alarms, notes, store, put, cfg, state, setCfg, link, fire, start, run },
    ...{ own, sets },
  };
}

/**
 * Every promise chain that waits on nothing but other promises has run its course: the fake areas, MemoryKV and the
 * in-process mutexes answer through promises alone, with no timer, so a few turns of the event loop drain them whatever
 * the machine's speed. (Not for anything that hashes or encrypts: WebCrypto answers from another thread.)
 */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

// ---- the records ------------------------------------------------------------------------------------------------------

const LINK: SlotLink = {
  v: 1,
  slot: "abcd1234",
  gen: TAG,
  seq: 3,
  sum: "A".repeat(43) + "=",
  vaultId: "vaultAAAA1",
  vkId: "0123456789abcdef",
  opens: "both",
  wraps: "password:AAAAAAAAAAAAAAAA,recovery:BBBBBBBBBBBBBBBB",
  mine: ["abcd1234"],
};

describe("the records (csb-config.ts)", () => {
  it("a configuration that checks out is read as it is, its link field by field", () => {
    const c = { v: 1, on: true, opens: "recovery", declined: false, link: LINK };
    expect(parseCsbConfig(c)).toEqual(c);
    const full = { ...LINK, pending: "fedcba9876543210", held: true, dirty: true };
    expect(parseCsbConfig({ ...c, link: full }).link).toEqual(full);
    expect(parseCsbConfig({ ...c, link: null }).link).toBeNull();
  });

  it("one that does not is a backup never set up: off, no link", () => {
    const c = { v: 1, on: true, opens: "both", declined: false, link: LINK };
    for (const bad of [
      null,
      "junk",
      [],
      { ...c, v: 2 },
      { ...c, on: "yes" },
      { ...c, opens: "password" },
      { ...c, declined: 0 },
      { ...c, extra: 1 },
      (({ declined: _d, ...x }) => x)(c),
    ])
      expect(parseCsbConfig(bad), JSON.stringify(bad)).toEqual(NEW_CSB_CONFIG);
  });

  it("a damaged link is no link (the next write makes a new slot, which overwrites nothing); the rest is kept", () => {
    const c = { v: 1, on: true, opens: "both", declined: true };
    for (const bad of [
      { ...LINK, v: 2 },
      { ...LINK, slot: "ABCD1234" },
      { ...LINK, slot: "abc" },
      { ...LINK, gen: "xyz" },
      { ...LINK, pending: "0123" },
      { ...LINK, seq: -1 },
      { ...LINK, seq: 1.5 },
      { ...LINK, sum: "nope" },
      { ...LINK, vaultId: "short" },
      { ...LINK, vkId: "ABCDEF0123456789" },
      { ...LINK, opens: "device" },
      { ...LINK, wraps: "" },
      { ...LINK, wraps: "password:<script>" },
      { ...LINK, held: false },
      { ...LINK, dirty: "yes" },
      { ...LINK, mine: ["abcd1234", "abcd1234"] },
      { ...LINK, mine: Array.from({ length: 17 }, (_, i) => `slot${String(i).padStart(4, "0")}`) },
      { ...LINK, mine: "abcd1234" },
      { ...LINK, recovered: true }, // the Drive path's mark is no field of this link
      (({ sum: _s, ...x }) => x)(LINK),
    ]) {
      expect(parseSlotLink(bad), JSON.stringify(bad)).toBeNull();
      expect(parseCsbConfig({ ...c, link: bad }), JSON.stringify(bad)).toEqual({ ...c, link: null });
    }
  });

  it("the state is read strictly too; a bad one is a fresh one", () => {
    const good = {
      ...NEW_CSB_STATE,
      lastOk: T0,
      err: "busy",
      errSince: T0,
      pendingSince: T0,
      retries: 2,
      lastRun: T0,
      bytes: 1600,
      used: 3200,
      others: { n: 1, bytes: 1600, otherVaults: 1, latest: T0 },
      seen: true,
    };
    expect(parseCsbState(good)).toEqual(good);
    for (const bad of [
      { ...good, v: 2 },
      { ...good, err: "network" }, // a Drive error is none of this backup's
      { ...good, retries: -1 },
      { ...good, lastOk: "today" },
      { ...good, bytes: -1 },
      { ...good, others: { n: 1, bytes: 0, otherVaults: 2, latest: null } },
      { ...good, others: { n: 0, bytes: 0, otherVaults: 0 } },
      { ...good, seen: 1 },
      { ...good, unsafe: 1 },
      { ...good, unsafe: null },
      { ...good, paused: false },
      (({ used: _u, ...x }) => x)(good),
    ])
      expect(parseCsbState(bad), JSON.stringify(bad)).toEqual(NEW_CSB_STATE);
    // the `unsafe` mark is read too; a record written before it existed has none, and reads false
    expect(parseCsbState({ ...good, unsafe: true })).toEqual({ ...good, unsafe: true });
    expect(parseCsbState((({ unsafe: _u, ...x }) => x)(good))).toEqual({ ...good, unsafe: false });
  });
});

describe("the store's recovery mark (cloud-mark.ts)", () => {
  const CFG = { v: 1, on: true, opens: "both", declined: false, link: LINK };
  it("marks the link held, as slots.ts heldLink does, and changes nothing else", async () => {
    const kv = new MemoryKV();
    await kv.set({ [CSB_CFG_KEY]: CFG, other: 1 });
    await markCsbHeld(kv, createMutex());
    const after = (await kv.get([CSB_CFG_KEY]))[CSB_CFG_KEY];
    expect(after).toEqual({ ...CFG, link: heldLink(LINK) });
    expect(parseCsbConfig(after).link?.held).toBe(true);
    expect((await kv.get(["other"])).other).toBe(1);
  });

  it("writes nothing when the backup never wrote (no link), or the record is not one", async () => {
    for (const before of [{}, { [CSB_CFG_KEY]: { ...CFG, link: null } }, { [CSB_CFG_KEY]: "junk" }]) {
      const kv = new MemoryKV();
      await kv.set(before);
      const writes: unknown[] = [];
      const spy = { get: (k: string[]) => kv.get(k), set: async (x: object) => void writes.push(x) };
      await markCsbHeld(spy as unknown as MemoryKV, createMutex());
      expect(writes, JSON.stringify(before)).toEqual([]);
    }
  });

  it("runs under the lock it is given, and its key is this backup's own, not the Drive path's", async () => {
    const kv = new MemoryKV();
    await kv.set({ [CSB_CFG_KEY]: CFG, sk_cloud_cfg: { v: 1, link: { fileId: "f" } } });
    let held = 0;
    await markCsbHeld(kv, async (fn) => {
      held++;
      return fn();
    });
    expect(held).toBe(1);
    expect(CSB_CFG_KEY).toBe("sk_csb_cfg");
    expect((await kv.get(["sk_cloud_cfg"])).sk_cloud_cfg).toEqual({ v: 1, link: { fileId: "f" } });
  });
});

// ---- when it runs -----------------------------------------------------------------------------------------------------

describe("when it runs (the scheduling, moved from the Drive path's worker)", () => {
  it("a change while the backup is off arms nothing and writes nothing", async () => {
    const x = world();
    await x.put(g1);
    await x.w.changed();
    await x.w.routine(false);
    expect(x.alarms.size).toBe(0);
    expect(x.area.calls).toEqual([]);
    expect(x.s.loads).toBe(0);
    expect(x.kv.data.has(CSB_STATE_KEY)).toBe(false);
  });

  it("a change arms the write 30 seconds ahead, and each later change moves it: one alarm, the first change's time kept", async () => {
    const x = world();
    await x.start();
    x.s.t += MIN;
    await x.w.changed();
    expect(x.alarms.get(CSB_SOON_ALARM)).toBe(x.s.t + 30_000);
    const first = x.s.t;
    x.s.t += 10_000;
    await x.w.changed();
    expect([...x.alarms.keys()]).toEqual([CSB_SOON_ALARM]);
    expect(x.alarms.get(CSB_SOON_ALARM)).toBe(x.s.t + 30_000);
    expect((await x.state()).pendingSince).toBe(first);
  });

  it("the debounce's alarm and the retries' run the backup; no other alarm name runs anything", async () => {
    const x = world();
    await x.start();
    expect(x.sets()).toBe(1);
    await x.put(g2);
    for (const name of ["sk-daily", "sk-cloud-soon", "sk-cloud-retry", "sk-csb-soonx"])
      expect(x.w.alarm(name)).toBe(false);
    await x.w.idle();
    expect(x.sets()).toBe(1);
    await x.fire(CSB_SOON_ALARM);
    expect(x.sets()).toBe(2);
    await x.put(g3);
    await x.fire(CSB_RETRY_ALARM);
    expect(x.sets()).toBe(3);
  });

  it("the vault's watch: a write of the store's pointer, from any context, starts the debounce; any other key does not", async () => {
    let listener: ((c: Record<string, unknown>) => void) | null = null;
    const local = { onChanged: { addListener: (l: (c: Record<string, unknown>) => void) => (listener = l) } };
    let changed = 0;
    watchVault(local as unknown as chrome.storage.StorageArea, async () => void changed++);
    listener!({ sk_settings: { newValue: {} } });
    listener!({ sk_csb_cfg: { newValue: {} } });
    expect(changed).toBe(0);
    listener!({ [VAULT_POINTER]: { newValue: "b" } });
    expect(changed).toBe(1);
    expect(VAULT_POINTER).toBe("sk_active");
  });

  it("changes that keep coming wait at most 5 minutes after the first", async () => {
    const x = world();
    await x.start();
    const first = x.s.t;
    await x.w.changed();
    for (let i = 0; i < 12; i++) {
      x.s.t += 25_000;
      await x.w.changed();
    }
    expect(x.alarms.get(CSB_SOON_ALARM)).toBe(first + 5 * MIN);
    await x.put(g2);
    await x.fire(CSB_SOON_ALARM);
    expect((await x.state()).pendingSince).toBeNull();
    // with a failure waiting, the retries keep their own times and a change does not pull the run in
    x.area.fail.set = [TEXTS.minute];
    await x.put(g3);
    await x.run();
    x.s.t += 10 * MIN;
    await x.w.changed();
    expect(x.alarms.get(CSB_SOON_ALARM)).toBe(x.s.t + 30_000);
  });

  it("one run at a time: a run asked for during another starts after it, once", async () => {
    const x = world();
    await x.start();
    await x.put(g2);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const set = x.area.set.bind(x.area);
    let inFlight = 0;
    let most = 0;
    x.area.set = async (items) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await gate;
      try {
        return await set(items);
      } finally {
        inFlight--;
      }
    };
    const a = x.w.run();
    await vi.waitFor(() => expect(inFlight).toBe(1)); // the first run's set, held at the gate
    await x.put(g3);
    void x.w.run();
    void x.w.run();
    release();
    await a;
    await x.w.idle();
    expect(most).toBe(1);
    expect(x.sets()).toBe(3); // the first, g2's, then one more for the runs asked meanwhile: g3's
    expect((await x.own()).kind === "ok" && (await x.own())).toMatchObject({ backup: { generation: { seq: 3 } } });
  });

  it("a change during a run still waits after it: its time is kept, the run's own is cleared", async () => {
    const x = world();
    await x.start();
    await x.put(g2);
    await x.w.changed();
    const set = x.area.set.bind(x.area);
    let during: Promise<void> | null = null;
    x.area.set = async (items) => {
      x.s.t += 1000;
      during = x.w.changed(); // a commit while the run writes (its record waits for the run's lock)
      await settle(); // (it reads the record and waits for the lock: promises alone)
      return set(items);
    };
    await x.fire(CSB_SOON_ALARM);
    await during;
    const s = await x.state();
    expect(s.pendingSince).toBe(T0 + 1000);
    expect(s.lastOk).toBe(T0 + 1000);
  });
});

describe("retries and the daily check", () => {
  it("a failure retries after 1, 5 and 30 minutes, then waits for the routine; a success clears it all", async () => {
    const x = world();
    await x.start();
    await x.put(g2);
    const at: number[] = [];
    for (let i = 0; i < 4; i++) {
      x.area.fail.set = ["Error: something Chrome said"];
      await x.run();
      at.push((x.alarms.get(CSB_RETRY_ALARM) ?? 0) - x.s.t);
      x.alarms.delete(CSB_RETRY_ALARM);
    }
    expect(at).toEqual([MIN, 5 * MIN, 30 * MIN, -x.s.t]);
    const s = await x.state();
    expect(s).toMatchObject({ err: "other", retries: 4, errSince: T0 });
    x.alarms.set(CSB_RETRY_ALARM, x.s.t + 1);
    await x.run();
    expect(await x.state()).toMatchObject({ err: null, errSince: null, retries: 0, lastOk: x.s.t });
    expect(x.alarms.has(CSB_RETRY_ALARM)).toBe(false);
  });

  it("a write-operation quota is busy and retried with the same delays", async () => {
    const x = world();
    await x.start();
    await x.put(g2);
    x.area.fail.set = [TEXTS.minute];
    await x.run();
    expect(await x.state()).toMatchObject({ err: "busy", retries: 1 });
    expect(x.alarms.get(CSB_RETRY_ALARM)).toBe(x.s.t + MIN);
    x.area.fail.set = [TEXTS.hour];
    await x.run();
    expect(await x.state()).toMatchObject({ err: "busy", retries: 2 });
    expect(x.alarms.get(CSB_RETRY_ALARM)).toBe(x.s.t + 5 * MIN);
  });

  it("an error no retry fixes arms no retry: it waits for the user and the daily check", async () => {
    // held (the store's mark), and a vault no slot can hold: both stop; unreadable and no_password: below
    const x = world();
    await x.start();
    await markCsbHeld(x.kv, x.lock);
    await x.put(g2);
    await x.run();
    expect(await x.state()).toMatchObject({ err: "held", retries: 1 });
    expect(x.alarms.has(CSB_RETRY_ALARM)).toBe(false);
    const y = world();
    await y.start(await seal(keys, vaultOf(keys.keyring.vaultId, many(260)), 1));
    expect(await y.state()).toMatchObject({ err: "too_large", retries: 1 });
    expect(y.alarms.has(CSB_RETRY_ALARM)).toBe(false);
  });

  it("the daily check runs when none ran for a day, changes or not; not sooner", async () => {
    const x = world();
    await x.start();
    const n = x.s.loads;
    x.s.t += 24 * 60 * MIN - 1;
    await x.w.routine(false);
    expect(x.s.loads).toBe(n);
    x.s.t += 1;
    await x.w.routine(false);
    expect(x.s.loads).toBe(n + 1);
    expect((await x.state()).lastRun).toBe(x.s.t);
  });

  it("a change whose alarm was lost runs at the routine; one whose alarm is still armed waits for it", async () => {
    const x = world();
    await x.start();
    await x.w.changed();
    const n = x.s.loads;
    await x.w.routine(true);
    expect(x.s.loads).toBe(n);
    await x.w.routine(false);
    expect(x.s.loads).toBe(n + 1);
  });

  it("does nothing while the backup is off, even a day on", async () => {
    const x = world();
    await x.start();
    await x.w.off();
    const n = x.s.loads;
    x.s.t += 2 * 24 * 60 * MIN;
    await x.w.routine(false);
    await x.w.changed();
    await x.run();
    expect(x.s.loads).toBe(n);
    expect(x.alarms.size).toBe(0);
  });

  it("a write sets the backup reminder's time; a failure or a run that writes nothing does not", async () => {
    const x = world();
    await x.start();
    expect((await x.kv.get([LAST_BACKUP_KEY]))[LAST_BACKUP_KEY]).toBe(T0);
    expect(LAST_BACKUP_KEY).toBe("sk_last_backup");
    x.s.t += MIN;
    await x.run(); // nothing changed: a skip
    expect((await x.kv.get([LAST_BACKUP_KEY]))[LAST_BACKUP_KEY]).toBe(T0);
    await x.put(g2);
    x.area.fail.set = [TEXTS.minute];
    await x.run();
    expect((await x.kv.get([LAST_BACKUP_KEY]))[LAST_BACKUP_KEY]).toBe(T0);
    x.s.t += MIN;
    await x.run();
    expect((await x.kv.get([LAST_BACKUP_KEY]))[LAST_BACKUP_KEY]).toBe(x.s.t);
  });
});

describe("C7: only where this worker's start closed storage.sync to content scripts", () => {
  it("refused: it cannot be turned on, nothing is written, and the state says why for the card", async () => {
    const x = world({ access: false });
    await x.put(g1);
    expect(await x.w.on()).toEqual({ ok: false, why: "unsafe_area" });
    await x.w.idle();
    expect(await x.cfg()).toEqual(NEW_CSB_CONFIG);
    expect(await x.state()).toEqual({ ...NEW_CSB_STATE, unsafe: true });
    expect(x.area.calls).toEqual([]);
  });

  it("refused in this worker's life after it was turned on in an earlier one: no run reads or writes anything", async () => {
    const x = world();
    await x.start();
    x.s.access = false;
    await x.put(g2);
    const before = structuredClone([...x.kv.data]);
    await x.w.changed();
    await x.fire(CSB_SOON_ALARM);
    x.s.t += 2 * 24 * 60 * MIN;
    await x.w.routine(false);
    expect(x.sets()).toBe(1);
    expect(x.s.loads).toBe(1);
    expect([...x.kv.data].filter(([k]) => k !== CSB_STATE_KEY)).toEqual(before.filter(([k]) => k !== CSB_STATE_KEY));
    expect((await x.state()).lastRun).toBe(T0); // the run that wrote, nothing since
    expect((await x.state()).unsafe).toBe(true); // and the card can say why
    // and a restore's adoption is refused the same
    expect(
      await x.w.restored({
        slot: "abcd1234",
        gen: TAG,
        seq: 2,
        sum: g2.envelope.checksum,
        opens: "both",
        wraps: LINK.wraps,
        dirty: false,
      }),
    ).toEqual({ ok: false, why: "unsafe_area" });
    // given in a later life, the next run goes on, and the mark goes
    x.s.access = true;
    await x.run();
    expect(x.sets()).toBe(2);
    expect((await x.state()).unsafe).toBe(false);
  });

  it("the mark for the card: written by a run, a page's message and the routine of a backup that is on, once", async () => {
    const x = world();
    await x.start();
    let written = 0;
    const set = x.kv.set.bind(x.kv);
    x.kv.set = async (items) => {
      if (CSB_STATE_KEY in items) written++;
      return set(items);
    };
    const marks = () => written;
    // a later life refuses: the routine at its start writes it down, before anything changed
    x.s.access = false;
    let before = marks();
    await x.w.routine(false);
    expect((await x.state()).unsafe).toBe(true);
    expect(marks()).toBe(before + 1);
    // asked again (a run, now, the routine): already said, nothing more written
    before = marks();
    await x.w.routine(false);
    expect(await x.w.now()).toEqual({ ok: false, why: "unsafe_area" });
    await x.put(g2);
    await x.w.changed();
    await x.fire(CSB_SOON_ALARM);
    expect(marks()).toBe(before + 1); // the change's pendingSince only
    expect((await x.state()).unsafe).toBe(true);
    // let through again: the routine clears it
    x.s.access = true;
    await x.w.routine(true);
    expect((await x.state()).unsafe).toBe(false);
  });

  it("off, the routine asks nothing: no mark is written while the backup is off", async () => {
    const x = world({ access: false });
    await x.put(g1);
    await x.w.routine(false);
    expect(x.kv.data.has(CSB_STATE_KEY)).toBe(false);
  });
});

// ---- what a run writes ------------------------------------------------------------------------------------------------

describe("what a run writes", () => {
  it("the generation as the store reads it with no key, in the file format, in one set of a new slot; the link and the state", async () => {
    const x = world();
    await x.start();
    const set = x.area.callsOf("set");
    expect(set).toHaveLength(1);
    const l = await x.link();
    expect(Object.keys(set[0] as object).sort()).toEqual([manifestKey(l.slot), chunkKey(l.slot, 0)].sort());
    const a = await x.own();
    expect(a.kind).toBe("ok");
    if (a.kind !== "ok") return;
    expect(a.backup).toEqual(await makeCloudBackup(g1, "both", APP));
    expect(l).toMatchObject({
      v: 1,
      gen: a.manifest.g,
      seq: 1,
      sum: g1.envelope.checksum,
      vaultId: g1.envelope.vaultId,
    });
    expect(l.pending).toBeUndefined();
    expect(l.mine).toEqual([l.slot]);
    expect(await x.state()).toMatchObject({ lastOk: T0, err: null, pendingSince: null, retries: 0, lastRun: T0 });
    expect((await x.state()).bytes).toBe(x.area.inUse());
    expect((await x.state()).used).toBe(x.area.inUse());
  });

  it("an empty vault is handed over at once, so a second computer finds it; its first account is written too", async () => {
    const x = world();
    await x.start(await seal(keys, emptyVault(keys.keyring.vaultId), 1));
    expect(x.sets()).toBe(1);
    expect((await x.cfg()).link).not.toBeNull();
    expect(await x.state()).toMatchObject({ err: null, lastOk: T0, pendingSince: null });
    await x.put(g2);
    await x.run();
    expect(x.sets()).toBe(2);
  });

  it("nothing changed and the slot whole: no write; the state says nothing waits, and keeps the last write's time", async () => {
    const x = world();
    await x.start();
    x.s.t += MIN;
    await x.w.changed();
    await x.run();
    expect(x.sets()).toBe(1);
    expect(await x.state()).toMatchObject({ lastOk: T0, pendingSince: null, err: null, lastRun: T0 + MIN });
  });

  it("a change overwrites this device's slot under its id, with a new tag; nothing else of the area is touched", async () => {
    const mine = await itemsOf(g1, "zzzzzzzz");
    const x = world({ items: mine });
    await x.start();
    const l1 = await x.link();
    await x.put(g2);
    await x.run();
    const l2 = await x.link();
    expect(l2.slot).toBe(l1.slot);
    expect(l2.gen).not.toBe(l1.gen);
    expect(l2).toMatchObject({ seq: 2, sum: g2.envelope.checksum });
    expect(l2.pending).toBeUndefined();
    const snap = x.area.snapshot();
    for (const [k, v] of Object.entries(mine)) expect(snap[k], k).toEqual(v); // the other slot, as it was
    expect(x.area.callsOf("remove")).toEqual([]);
  });

  it("the link saved before the set already names the write, its tag pending: a worker stopped after the set knows the slot as its own", async () => {
    const x = world();
    await x.start();
    const l1 = await x.link();
    await x.put(g2);
    const set = x.area.set.bind(x.area);
    let before: CsbConfig | null = null;
    x.area.set = async (items) => {
      before = await x.cfg();
      return set(items);
    };
    await x.run();
    const written = (await x.own()) as Extract<Awaited<ReturnType<typeof x.own>>, { kind: "ok" }>;
    expect(before!.link).toMatchObject({ slot: l1.slot, gen: l1.gen, pending: written.manifest.g, seq: 2 });
    // stopped there: the link as it was before the set, the slot written; the next run writes nothing
    await x.setCfg((c) => ({ ...c, link: before!.link }));
    x.area.set = set;
    await x.run();
    expect(x.sets()).toBe(2);
    // stopped before the set instead: the slot still carries the old tag, and the next run writes it again ("repair")
    const y = world();
    await y.start();
    await y.put(g2);
    y.area.fail.set = ["Error: stopped"];
    await y.run();
    expect((await y.link()).pending).toBeDefined();
    expect((await y.own()).kind === "ok" && ((await y.own()) as { manifest: { g: string } }).manifest.g).toBe(
      (await y.link()).gen,
    );
    await y.run();
    expect(y.sets()).toBe(3);
    expect((await y.link()).pending).toBeUndefined();
    expect(((await y.own()) as { backup: { generation: { seq: number } } }).backup.generation.seq).toBe(2);
  });

  it("its slot gone (Chrome's clear data, a merge-and-remove elsewhere): written again under the same id (rule 4)", async () => {
    const x = world();
    await x.start();
    const slot = (await x.link()).slot;
    await x.area.clear();
    x.s.t += 24 * 60 * MIN;
    await x.w.routine(false);
    expect((await x.link()).slot).toBe(slot);
    expect((await x.own()).kind).toBe("ok");
  });

  it("its slot carrying another computer's tag (it adopted the slot): a new slot, theirs left as it is (rule 5)", async () => {
    const x = world();
    await x.start();
    const slot = (await x.link()).slot;
    // theirs is larger than what this device now writes: its chunks past the new plan's count are theirs too
    const theirs = await itemsOf(
      await seal(keys, vaultOf(keys.keyring.vaultId, many(40)), 3),
      slot,
      "fedcba9876543210",
    );
    expect(Object.keys(theirs).length).toBeGreaterThan(3);
    for (const [k, v] of Object.entries(theirs)) x.area.applyRemote(k, { value: v });
    await x.put(g2);
    await x.run();
    const l = await x.link();
    expect(l.slot).not.toBe(slot);
    expect(l.mine).toEqual([slot, l.slot]);
    const snap = x.area.snapshot();
    for (const [k, v] of Object.entries(theirs)) expect(snap[k], k).toEqual(v);
    expect(x.area.callsOf("remove")).toEqual([]);
    // and the write went through: no leftovers of the new slot looked for among theirs (csb-area.ts would refuse them)
    expect(l.pending).toBeUndefined();
    expect(await x.state()).toMatchObject({ err: null });
    expect(x.notes).toEqual([]);
  });

  it("another vault (start over): a new slot, the old one left whole, every chunk of it (rule 6)", async () => {
    const x = world();
    await x.start(await seal(keys, vaultOf(keys.keyring.vaultId, many(40)), 1));
    const old = await x.link();
    const before = x.area.snapshot();
    expect(Object.keys(before).length).toBeGreaterThan(3);
    await x.put(await seal(otherKeys, vaultOf(otherKeys.keyring.vaultId, [account("Other", SECRET)]), 1));
    await x.run();
    const l = await x.link();
    expect(l.slot).not.toBe(old.slot);
    expect(l.vaultId).toBe(otherKeys.keyring.vaultId);
    const snap = x.area.snapshot();
    for (const [k, v] of Object.entries(before)) expect(snap[k], k).toEqual(v);
    expect(x.area.callsOf("remove")).toEqual([]);
    expect(l.pending).toBeUndefined();
    expect(await x.state()).toMatchObject({ err: null });
    expect(x.notes).toEqual([]);
  });

  it("another vault over data that could not be read (its hold left by the recovery): a new slot, the old one left whole", async () => {
    // started over, or another vault restored from a file, over data the store could not read: the recovery hook marked
    // the old vault's link held; this vault is not held by it (the slot is the old vault's, perhaps its only copy)
    const x = world();
    await x.start(await seal(keys, vaultOf(keys.keyring.vaultId, many(40)), 1));
    const old = await x.link();
    const before = x.area.snapshot();
    await markCsbHeld(x.kv, x.lock);
    await x.put(await seal(otherKeys, emptyVault(otherKeys.keyring.vaultId), 1)); // nothing in it yet: a new slot
    await x.run();
    expect(x.sets()).toBe(2);
    expect(await x.state()).toMatchObject({ err: null });
    await x.put(await seal(otherKeys, vaultOf(otherKeys.keyring.vaultId, [account("Other", SECRET)]), 2));
    await x.run();
    const l = await x.link();
    expect(l.slot).not.toBe(old.slot);
    expect(l.vaultId).toBe(otherKeys.keyring.vaultId);
    expect(l.held).toBeUndefined();
    expect(l.mine).toEqual([old.slot, l.slot]); // the old slot is still known as this device's: no evidence of sync
    const snap = x.area.snapshot();
    for (const [k, v] of Object.entries(before)) expect(snap[k], k).toEqual(v);
    expect(x.area.callsOf("remove")).toEqual([]);
    expect(await x.state()).toMatchObject({ err: null, seen: false, others: { n: 1, otherVaults: 1 } });
    // and the same vault's hold still holds (rule 3): the fallback of this vault is not let write over its slot
    const y = world();
    await y.start(g2);
    await markCsbHeld(y.kv, y.lock);
    await y.put(g3);
    await y.run();
    expect(y.sets()).toBe(1);
    expect(await y.state()).toMatchObject({ err: "held" });
  });

  it("an older copy put back (a save counter below the link's): held and saved held, so later saves still hold (rule 7)", async () => {
    const x = world();
    await x.start(g2);
    await x.put(g1);
    await x.run();
    expect(x.sets()).toBe(1);
    expect((await x.link()).held).toBe(true);
    expect(await x.state()).toMatchObject({ err: "held" });
    await x.put(g3); // saves on the put-back copy lift its counter past the link's: still held
    await x.run();
    expect(x.sets()).toBe(1);
    expect(((await x.own()) as { backup: { generation: { seq: number } } }).backup.generation.seq).toBe(2);
  });

  it("held by the store's recovery mark (rule 3): nothing written until a page merges", async () => {
    const x = world();
    await x.start();
    await markCsbHeld(x.kv, x.lock);
    await x.put(g2);
    await x.run();
    expect(x.sets()).toBe(1);
    expect(await x.state()).toMatchObject({ err: "held" });
  });

  it("a slot that shrank: one set, then one remove of exactly its chunks past the new count", async () => {
    const big = await seal(keys, vaultOf(keys.keyring.vaultId, many(40)), 1);
    const x = world();
    await x.start(big);
    const slot = (await x.link()).slot;
    const n = ((await x.own()) as { manifest: { n: number } }).manifest.n;
    expect(n).toBeGreaterThan(2);
    await x.put(g2);
    await x.run();
    expect(x.area.callsOf("remove")).toEqual([Array.from({ length: n - 1 }, (_, i) => chunkKey(slot, i + 1))]);
    expect(Object.keys(x.area.snapshot()).sort()).toEqual([manifestKey(slot), chunkKey(slot, 0)].sort());
    expect((await x.own()).kind).toBe("ok");
  });

  it("chunks a stopped worker left beside its own whole slot are removed by the next run that writes nothing", async () => {
    const x = world();
    await x.start();
    const slot = (await x.link()).slot;
    x.area.items.set(chunkKey(slot, 1), "left");
    x.area.items.set(chunkKey(slot, 7), "left");
    await x.run();
    expect(x.sets()).toBe(1);
    expect(x.area.callsOf("remove")).toEqual([[chunkKey(slot, 1), chunkKey(slot, 7)]]);
    await x.run();
    expect(x.area.callsOf("remove")).toHaveLength(1); // none left: no call
  });

  it("an empty new vault over this device's slot gets a new slot, and the old slot's chunks past its count stay", async () => {
    const x = world();
    await x.start();
    const slot = (await x.link()).slot;
    x.area.items.set(chunkKey(slot, 3), "past its count");
    await x.put(await seal(otherKeys, emptyVault(otherKeys.keyring.vaultId), 1)); // start over, nothing in it yet
    await x.run();
    expect(x.area.callsOf("remove")).toEqual([]);
    expect(x.sets()).toBe(2);
    expect(x.area.items.get(chunkKey(slot, 3))).toBe("past its count");
  });

  it("a vault no slot can hold: too_large, nothing written, no retry", async () => {
    const x = world();
    await x.start(await seal(keys, vaultOf(keys.keyring.vaultId, many(260)), 1));
    expect(x.area.callsOf("set")).toEqual([]);
    expect((await x.cfg()).link).toBeNull();
    expect(await x.state()).toMatchObject({ err: "too_large" });
  });

  it("the other copies leave no room for it: no_room, nothing written, theirs untouched; room to the byte is written", async () => {
    const plan = await planSlot(await makeCloudBackup(g1, "both", APP), "aaaaaaaa", TAG);
    if (plan.kind !== "plan") throw new Error("plan");
    const full = filler(ROOM_BYTES - plan.bytes + 1);
    const x = world({ items: full });
    await x.start();
    expect(x.area.callsOf("set")).toEqual([]);
    expect(await x.state()).toMatchObject({ err: "no_room", others: { n: 0 } });
    expect(x.alarms.has(CSB_RETRY_ALARM)).toBe(false);
    expect(x.area.snapshot()).toEqual(full);
    const y = world({ items: filler(ROOM_BYTES - plan.bytes) });
    await y.start();
    expect(y.sets()).toBe(1);
    expect(await y.state()).toMatchObject({ err: null });
  });

  it("Chrome refuses the set for the area's bytes, and the area read again has room: retried as other, with a line", async () => {
    const x = world();
    await x.start();
    await x.put(g2);
    x.area.fail.set = [TEXTS.bytes];
    await x.run();
    expect(await x.state()).toMatchObject({ err: "other", retries: 1 });
    expect(x.alarms.get(CSB_RETRY_ALARM)).toBe(x.s.t + MIN);
    expect(x.notes).toEqual(["csb: Chrome refused a write for the area's bytes, and the area has room for it now"]);
  });

  it("refused for its bytes because another computer's items arrived, and the area read again has no room either: no_room", async () => {
    const x = world();
    await x.start();
    await x.put(g2);
    const set = x.area.set.bind(x.area);
    x.area.set = async (items) => {
      x.area.remote.put(filler(ROOM_BYTES - 1_000)); // arriving just now
      x.area.remote.deliverAll();
      return set(items);
    };
    await x.run();
    expect(await x.state()).toMatchObject({ err: "no_room", retries: 1 });
    expect(x.alarms.has(CSB_RETRY_ALARM)).toBe(false);
    expect(x.notes).toEqual([]);
  });

  it("refused for its bytes once its own slot went and other items came: the room worked out again from the new read alone", async () => {
    // the first read has this device's slot, whose items the plan overwrites (their bytes freed); by the set, Chrome
    // sync removed them and delivered other items: what is free now must be worked out from the new read's items
    const x = world();
    await x.start();
    const slot = (await x.link()).slot;
    const ownKeys = Object.keys(x.area.snapshot());
    const ownBytes = x.area.inUse();
    await x.put(g2);
    const plan = await planSlot(await makeCloudBackup(g2, "both", APP), "aaaaaaaa", TAG);
    if (plan.kind !== "plan") throw new Error("plan");
    // Chrome refuses the set (100 bytes past its quota); with the new read's items alone the plan cannot fit (less the
    // 256 bytes' margin), and with the slot's old items counted as freed it would
    const others = 102_400 - plan.bytes + 100;
    expect(ownBytes).toBeGreaterThan(356);
    const set = x.area.set.bind(x.area);
    x.area.set = async (items) => {
      x.area.remote.drop(ownKeys);
      x.area.remote.put(filler(others));
      x.area.remote.deliverAll();
      return set(items);
    };
    await x.run();
    expect(await x.state()).toMatchObject({ err: "no_room", retries: 1 });
    expect(x.notes).toEqual([]);
    expect(Object.keys(x.area.snapshot()).some((k) => k.startsWith(manifestKey(slot)))).toBe(false);
  });

  it("any other refusal: other, retried, Chrome's text in a diagnostics line", async () => {
    const x = world();
    await x.start();
    await x.put(g2);
    x.area.fail.set = ["Something new Chrome says"];
    await x.run();
    expect(await x.state()).toMatchObject({ err: "other" });
    expect(x.notes).toEqual(["csb: Chrome refused: Something new Chrome says"]);
  });

  it("a bug (a text outside the slots' alphabet, a plan or key list the writer refuses): a line, recorded, no retry alarm", async () => {
    const x = world({ app: "Sixkey <0.1.0>" }); // "<" is never in a file: planSlot refuses it
    await x.start();
    expect(x.area.callsOf("set")).toEqual([]);
    expect(await x.state()).toMatchObject({ err: "other", retries: 1 });
    expect(x.alarms.has(CSB_RETRY_ALARM)).toBe(false);
    expect(x.notes).toEqual(["csb: bug: SlotError bad_text: bad_text"]);
  });

  it("a read of the area that fails: other, retried, with a line", async () => {
    const x = world();
    await x.put(g1);
    x.area.fail.get = ["Error: the area is gone"];
    await x.w.on();
    await x.w.idle();
    expect(await x.state()).toMatchObject({ err: "other", retries: 1 });
    expect(x.alarms.get(CSB_RETRY_ALARM)).toBe(x.s.t + MIN);
    expect(x.notes).toEqual(["csb: a run failed: Error: the area is gone"]);
  });

  it("a store that cannot be read: unreadable; a keyring a device key opens: no_password; neither retried, nothing written", async () => {
    const x = world({ load: async () => ({ status: "lost" }) });
    await x.w.on();
    await x.w.idle();
    expect(await x.state()).toMatchObject({ err: "unreadable", retries: 1 });
    const y = world();
    await y.start(await legacyDeviceGeneration([account("GitHub", SECRET)]));
    expect(await y.state()).toMatchObject({ err: "no_password" });
    for (const w of [x, y]) {
      expect(w.area.callsOf("set")).toEqual([]);
      expect(w.alarms.has(CSB_RETRY_ALARM)).toBe(false);
    }
  });

  it("a commit between the load and the decision: nothing decided on the older view, the change still waits", async () => {
    let gen = g1;
    const x = world({ load: async () => ({ status: "ok", gen, events: [] }) });
    await x.start();
    expect(x.sets()).toBe(1);
    await x.w.changed();
    await x.put(g2); // on disk now; the load still answers g1
    await x.run();
    expect(x.sets()).toBe(1);
    expect((await x.state()).pendingSince).toBe(T0);
    gen = g2;
    await x.run();
    expect(x.sets()).toBe(2);
    expect((await x.state()).pendingSince).toBeNull();
  });

  it("the generation on disk at the decision: one with the loaded counter but other data, or none readable, decides nothing", async () => {
    const same = await seal(keys, vaultOf(keys.keyring.vaultId, [account("Other", SECRET)]), g2.seq); // g2's counter
    let gen = g1;
    const x = world({ load: async () => ({ status: "ok", gen, events: [] }) });
    await x.start(g1);
    expect(x.sets()).toBe(1);
    x.s.t = T0 + MIN;
    gen = g2; // the load answers g2; on disk, the same counter with another envelope
    await x.put(same);
    await x.run();
    expect(x.sets()).toBe(1);
    await x.kv.remove(["sk_active"]); // no pointer: the store's own read would walk its recovery ladder
    await x.run();
    expect(x.sets()).toBe(1);
    expect(await x.state()).toMatchObject({ err: null, retries: 0, lastRun: T0 }); // nothing recorded
    gen = same;
    await x.put(same);
    await x.run();
    expect(x.sets()).toBe(2);
  });

  it("what the area holds, for the card: this slot's bytes, the whole area, the other slots, another vault's, the evidence", async () => {
    const theirs = await itemsOf(g3, "other001", "1111111111111111");
    const foreign = await itemsOf(
      await seal(otherKeys, vaultOf(otherKeys.keyring.vaultId, [account("Else", SECRET)]), 4, T0 + 5),
      "other002",
      "2222222222222222",
    );
    const x = world({ items: { ...theirs, ...foreign } });
    await x.start();
    const s = await x.state();
    const l = await x.link();
    const own = Object.keys(x.area.snapshot()).filter((k) => k.startsWith(manifestKey(l.slot)));
    expect(s.bytes).toBe(await x.area.getBytesInUse(own));
    expect(s.used).toBe(x.area.inUse());
    expect(s.others).toEqual({
      n: 2,
      bytes: await x.area.getBytesInUse([...Object.keys(theirs), ...Object.keys(foreign)]),
      otherVaults: 1,
      latest: T0 + 5,
    });
    expect(s.seen).toBe(true);
    // the evidence stays once seen: the other slots gone, the next run still says sync carried one
    await x.w.drop({
      seq: g1.seq,
      sum: g1.envelope.checksum,
      slots: [
        { slot: "other001", gen: "1111111111111111" },
        { slot: "other002", gen: "2222222222222222" },
      ],
    });
    await x.w.idle();
    await x.put(g2);
    await x.run();
    expect(await x.state()).toMatchObject({ seen: true, others: { n: 0, bytes: 0, otherVaults: 0, latest: null } });
    const lone = world();
    await lone.start();
    expect((await lone.state()).seen).toBe(false); // its own slot alone is no evidence
  });
});

// ---- the settings page's messages ---------------------------------------------------------------------------------------

describe("the settings page's messages", () => {
  it("off with a link of another vault than the one on disk (started over, another vault restored): off, its slot kept", async () => {
    const x = world();
    await x.start(g2);
    const before = x.area.snapshot();
    const link = await x.link();
    await x.put(await seal(otherKeys, vaultOf(otherKeys.keyring.vaultId, [account("Other", SECRET)]), 1));
    expect(await x.w.off()).toEqual({ ok: true, removed: false });
    expect(x.area.snapshot()).toEqual(before);
    expect(x.area.callsOf("remove")).toEqual([]);
    expect(await x.cfg()).toMatchObject({ on: false, declined: true, link });
    // nothing readable on disk: kept too
    const y = world();
    await y.start(g2);
    await y.kv.set({ sk_slot_a: { torn: true } });
    expect(await y.w.off()).toEqual({ ok: true, removed: false });
    expect(y.area.callsOf("remove")).toEqual([]);
  });

  it("on: on, the reminder's handover allowed again, and a run now; twice is once", async () => {
    const x = world();
    await x.put(g1);
    await x.setCfg((c) => ({ ...c, declined: true }));
    expect(await x.w.on()).toEqual({ ok: true });
    expect(await x.w.on()).toEqual({ ok: true });
    await x.w.idle();
    expect(await x.cfg()).toMatchObject({ on: true, declined: false });
    expect(x.sets()).toBe(1);
  });

  it("on clears the last error; with no vault yet, a run records nothing (there is nothing to back up)", async () => {
    const x = world();
    await x.kv.set({ [CSB_STATE_KEY]: { ...NEW_CSB_STATE, err: "no_room", errSince: T0 - MIN, retries: 2 } });
    expect((await x.state()).err).toBe("no_room");
    expect(await x.w.on()).toEqual({ ok: true });
    await x.w.idle();
    expect(x.s.loads).toBe(1);
    expect(await x.state()).toMatchObject({ err: null, errSince: null, retries: 0, lastRun: null, lastOk: null });
    expect(x.sets()).toBe(0);
    expect(x.alarms.has(CSB_RETRY_ALARM)).toBe(false);
  });

  it("off (C3): off, this device's slot removed in one call, the alarms cleared; turned on again, written again under the same id", async () => {
    const theirs = await itemsOf(g3, "other001");
    const x = world({ items: theirs });
    await x.start();
    await x.w.changed();
    const slot = (await x.link()).slot;
    expect(await x.w.off()).toEqual({ ok: true, removed: true });
    expect(x.area.callsOf("remove")).toEqual([
      [manifestKey(slot), ...Array.from({ length: 13 }, (_, i) => chunkKey(slot, i))],
    ]);
    expect(x.area.snapshot()).toEqual(theirs);
    expect(await x.cfg()).toMatchObject({ on: false, declined: true, link: { slot } });
    expect(x.alarms.size).toBe(0);
    await x.w.on();
    await x.w.idle();
    expect((await x.link()).slot).toBe(slot);
    expect((await x.own()).kind).toBe("ok");
  });

  it("off while held: the slot stays (it may be newer than this data); off over a slot another computer took: it stays", async () => {
    const x = world();
    await x.start();
    await markCsbHeld(x.kv, x.lock);
    expect(await x.w.off()).toEqual({ ok: true, removed: false });
    expect((await x.own()).kind).toBe("ok");
    const y = world();
    await y.start();
    const slot = (await y.link()).slot;
    for (const [k, v] of Object.entries(await itemsOf(g3, slot, "fedcba9876543210")))
      y.area.applyRemote(k, { value: v });
    expect(await y.w.off()).toEqual({ ok: true, removed: false });
    expect((await assembleSlot(y.area.snapshot(), slot)).kind).toBe("ok");
    for (const w of [x, y]) expect(w.area.callsOf("remove")).toEqual([]);
  });

  it("off after a write whose link was not saved after it: the slot under the pending tag is this device's, removed", async () => {
    // the worker was stopped between its set and the link saved after it: the slot carries the tag saved as pending
    const x = world();
    await x.start();
    const l = await x.link();
    await x.setCfg((c) => ({ ...c, link: { ...l, gen: "9999999999999999", pending: l.gen } }));
    expect(await x.w.off()).toEqual({ ok: true, removed: true });
    expect(x.area.snapshot()).toEqual({});
  });

  it("off over chunks with no manifest beside them: kept (another computer's write may be arriving)", async () => {
    const x = world();
    await x.start(await seal(keys, vaultOf(keys.keyring.vaultId, many(40)), 1));
    const slot = (await x.link()).slot;
    x.area.items.delete(manifestKey(slot));
    const chunks = x.area.snapshot();
    expect(Object.keys(chunks).length).toBeGreaterThan(1);
    expect(await x.w.off()).toEqual({ ok: true, removed: false });
    expect(x.area.snapshot()).toEqual(chunks);
    expect(x.area.callsOf("remove")).toEqual([]);
  });

  it("now: answered once the run, and any run a change asked for meanwhile, is done", async () => {
    const x = world();
    await x.start();
    await x.put(g2);
    expect(await x.w.now()).toEqual({ ok: true });
    expect(x.sets()).toBe(2);
  });

  it("now, off: refused as off; where this worker could not close storage.sync to content scripts: unsafe_area", async () => {
    const x = world();
    await x.put(g1);
    expect(await x.w.now()).toEqual({ ok: false, why: "off" });
    expect(x.s.loads).toBe(0);
    await x.start();
    x.s.access = false;
    await x.put(g2);
    expect(await x.w.now()).toEqual({ ok: false, why: "unsafe_area" });
    await x.w.idle();
    expect(x.s.loads).toBe(1);
    expect(x.sets()).toBe(1);
  });

  it("the switch: kept, written at once while on (the copy then opens with the recovery key only); anything else refused", async () => {
    const x = world();
    await x.start();
    expect(await x.w.opens("recovery")).toBe(true);
    await x.w.idle();
    expect((await x.cfg()).opens).toBe("recovery");
    expect(x.sets()).toBe(2);
    expect(((await x.own()) as { backup: { opens: string } }).backup.opens).toBe("recovery");
    for (const bad of ["password", 1, null, undefined]) expect(await x.w.opens(bad)).toBe(false);
    expect((await x.cfg()).opens).toBe("recovery");
  });

  /** What a restore page sends: the slot, the tag it read, the generation it wrote, the file's switch and wraps. */
  const restoredOf = async (slot: string, g: string, gen: Generation, dirty: boolean) => ({
    slot,
    gen: g,
    seq: gen.seq,
    sum: gen.envelope.checksum,
    opens: "both",
    wraps: wrapsOf((await makeCloudBackup(gen, "both", APP)).generation.keyring.wraps),
    dirty,
  });

  it("a restore's adoption: this device continues the slot it read, on; dirty (several slots merged): written at the first run", async () => {
    const theirs = await itemsOf(g1, "restored", "3333333333333333");
    const x = world({ items: theirs });
    await x.put(g2); // the restore wrote the merge of two slots
    expect(await x.w.restored(await restoredOf("restored", "3333333333333333", g2, true))).toEqual({ ok: true });
    await x.w.idle();
    const l = await x.link();
    expect(l).toMatchObject({ slot: "restored", seq: 2, sum: g2.envelope.checksum, mine: [] });
    expect(l.dirty).toBeUndefined();
    expect(await x.cfg()).toMatchObject({ on: true });
    expect(x.sets()).toBe(1);
    expect(((await x.own()) as { backup: { generation: { seq: number } } }).backup.generation.seq).toBe(2);
    expect((await x.state()).seen).toBe(true);
  });

  it("an adoption not dirty, of a file with this vault's wraps: nothing to write until a change; other wraps: written at once", async () => {
    const theirs = await itemsOf(g1, "restored", "3333333333333333");
    const x = world({ items: theirs });
    await x.put(g1);
    x.s.t = T0 + MIN;
    expect(await x.w.restored(await restoredOf("restored", "3333333333333333", g1, false))).toEqual({ ok: true });
    await x.w.idle();
    expect(x.sets()).toBe(0);
    expect((await x.link()).gen).toBe("3333333333333333");
    // the slot holds what the vault holds: the restore counts as the last write, and the run after it kept that
    expect(await x.state()).toMatchObject({ lastOk: T0 + MIN, lastRun: T0 + MIN, err: null });
    const y = world({ items: theirs });
    await y.put(g1);
    const m = await restoredOf("restored", "3333333333333333", g1, false);
    expect(await y.w.restored({ ...m, wraps: "password:AAAAAAAAAAAAAAAA" })).toEqual({ ok: true });
    await y.w.idle();
    expect(y.sets()).toBe(1); // the file opened with other wraps (a new password after the recovery key): rewritten
  });

  it("an adoption is taken only for the generation the restore wrote, and only with its counter and checksum", async () => {
    const x = world({ items: await itemsOf(g1, "restored", "3333333333333333") });
    await x.put(g3);
    const m = await restoredOf("restored", "3333333333333333", g2, false); // the restore wrote g2; g3 is on disk
    expect(await x.w.restored(m)).toEqual({ ok: false, why: "not_that_generation" });
    expect(x.notes).toEqual([
      "csb: a restore's adoption not taken: the vault on disk is not the one the restore wrote",
    ]);
    for (const bad of [
      (({ seq: _s, ...r }) => r)(m),
      (({ sum: _s, ...r }) => r)(m),
      { ...m, slot: "BAD" },
      { ...m, gen: null },
      { ...m, opens: "device" },
      { ...m, dirty: "no" },
      { ...m, wraps: "" },
      null,
    ])
      expect(await x.w.restored(bad), JSON.stringify(bad)).toEqual({ ok: false, why: "bad_message" });
    expect(await x.cfg()).toEqual(NEW_CSB_CONFIG);
  });

  it("an adoption is taken only of a slot still whole under the tag the restore read, and holding this vault", async () => {
    const theirs = await seal(otherKeys, vaultOf(otherKeys.keyring.vaultId, [account("Theirs", SECRET)]), 7);
    const foreign = await itemsOf(theirs, "theirs01", "1111111111111111");
    const x = world({ items: foreign });
    await x.put(g1);
    const m = await restoredOf("theirs01", "1111111111111111", g1, true);
    expect(await x.w.restored(m)).toEqual({ ok: false, why: "other_vault" });
    expect(await x.w.restored({ ...m, gen: "2222222222222222" })).toEqual({ ok: false, why: "slot_changed" });
    expect(await x.w.restored({ ...m, slot: "absent00" })).toEqual({ ok: false, why: "slot_changed" });
    expect(x.notes).toEqual([
      "csb: a restore's adoption not taken: the slot holds another vault",
      "csb: a restore's adoption not taken: the slot is not whole under the tag the restore read",
      "csb: a restore's adoption not taken: the slot is not whole under the tag the restore read",
    ]);
    await x.w.idle();
    expect(await x.cfg()).toEqual(NEW_CSB_CONFIG);
    expect(x.area.snapshot()).toEqual(foreign);
    expect(x.sets()).toBe(0);
    // this vault's slot, a chunk of it gone: not whole
    const y = world({ items: await itemsOf(g1, "restored", "3333333333333333") });
    y.area.items.delete(chunkKey("restored", 0));
    await y.put(g1);
    const n = await restoredOf("restored", "3333333333333333", g1, false);
    expect(await y.w.restored(n)).toEqual({ ok: false, why: "slot_changed" });
    expect(await y.cfg()).toEqual(NEW_CSB_CONFIG);
  });

  it("an adoption of this device's own slot (restored on the computer that wrote it) is no evidence that sync works", async () => {
    const x = world();
    await x.start();
    const l = await x.link();
    expect((await x.state()).seen).toBe(false);
    const tag = ((await x.own()) as { manifest: { g: string } }).manifest.g;
    await x.put(g3); // what the restore wrote
    expect(await x.w.restored(await restoredOf(l.slot, tag, g3, false))).toEqual({ ok: true });
    await x.w.idle();
    expect((await x.link()).mine).toEqual([l.slot]);
    expect((await x.state()).seen).toBe(false);
  });

  /**
   * Another context's recovery as the store runs it: in the store's lock, its hook marks the link held (taking the
   * records' lock and letting it go), and its write of `gen` lands once `land` is called.
   */
  function recovery(x: ReturnType<typeof world>, gen: Generation) {
    let land!: () => void;
    const landing = new Promise<void>((r) => (land = r));
    x.s.vaultRequests = 0;
    const done = x.vaultLock(async () => {
      await markCsbHeld(x.kv, x.lock);
      await landing;
      await x.put(gen);
    });
    return { land, done };
  }
  /** `p`, and whether it has settled. */
  function watched<T>(p: Promise<T>) {
    const w = { settled: false, p };
    void p.finally(() => (w.settled = true));
    return w;
  }

  it("a restore's adoption while a recovery's hook has run and its write has not landed: it waits for the write", async () => {
    const x = world({ items: await itemsOf(g1, "restored", "3333333333333333") });
    await x.put(g2); // what the restore wrote
    const m = await restoredOf("restored", "3333333333333333", g2, true);
    const older = await seal(keys, vaultOf(keys.keyring.vaultId, [account("Older", SECRET)]), g2.seq + 1);
    const r = recovery(x, older); // a fallback's restore of an older copy, at the next counter
    const answer = watched(x.w.restored(m));
    await vi.waitFor(() => expect(x.s.vaultRequests).toBe(2)); // the adoption asked for the store's lock ...
    await settle();
    expect(answer.settled).toBe(false); // ... and waits there
    r.land();
    await r.done;
    expect(await answer.p).toEqual({ ok: false, why: "not_that_generation" });
    await x.w.idle();
    expect(await x.cfg()).toEqual(NEW_CSB_CONFIG);
    expect(x.sets()).toBe(0);
  });

  /** A device held over its slot, the slot's tag, and the generation a page's merge wrote. */
  async function heldWorld() {
    const x = world();
    await x.start(g2);
    await markCsbHeld(x.kv, x.lock);
    const tag = ((await x.own()) as { manifest: { g: string } }).manifest.g;
    await x.put(g3); // the page's merge of the slot into this vault, committed
    return { x, tag, slot: (await x.link()).slot };
  }

  it("a held slot's merge: re-based on the merged generation, which the next run writes over the slot", async () => {
    const { x, tag, slot } = await heldWorld();
    expect(await x.w.merged({ slot, gen: tag, seq: g3.seq, sum: g3.envelope.checksum })).toEqual({ ok: true });
    await x.w.idle();
    expect((await x.link()).held).toBeUndefined();
    expect(x.sets()).toBe(2);
    expect(((await x.own()) as { backup: { generation: { seq: number } } }).backup.generation.seq).toBe(3);
    expect(await x.state()).toMatchObject({ err: null });
    expect(x.notes).toEqual([]);
  });

  it("a merge that the vault on disk is no longer (an older copy put back after the page's merge): held still, with a line", async () => {
    const { x, tag, slot } = await heldWorld();
    await x.put(g1); // put back between the page's merge (g3) and this message
    expect(await x.w.merged({ slot, gen: tag, seq: g3.seq, sum: g3.envelope.checksum })).toEqual({
      ok: false,
      why: "not_that_generation",
    });
    await x.w.idle();
    expect((await x.link()).held).toBe(true);
    expect(x.notes).toEqual([
      "csb: a merge of the held slot not taken: the vault on disk is not the one the merge wrote",
    ]);
    // the same counter with other data is not the merge either
    await x.put(await seal(keys, vaultOf(keys.keyring.vaultId, [account("Other", SECRET)]), g3.seq));
    expect((await x.w.merged({ slot, gen: tag, seq: g3.seq, sum: g3.envelope.checksum })).ok).toBe(false);
    await x.run();
    expect(x.sets()).toBe(1);
  });

  it("a merge while a recovery's hook has run and its write has not landed: it waits for the write, and stays held", async () => {
    const { x, tag, slot } = await heldWorld();
    const older = await seal(keys, vaultOf(keys.keyring.vaultId, [account("Older", SECRET)]), g3.seq + 1);
    const r = recovery(x, older); // a fallback's restore of an older copy, at the next counter
    const answer = watched(x.w.merged({ slot, gen: tag, seq: g3.seq, sum: g3.envelope.checksum }));
    await vi.waitFor(() => expect(x.s.vaultRequests).toBe(2)); // the merge asked for the store's lock ...
    await settle();
    expect(answer.settled).toBe(false); // ... and waits there
    r.land();
    await r.done;
    expect(await answer.p).toEqual({ ok: false, why: "not_that_generation" });
    await x.w.idle();
    expect((await x.link()).held).toBe(true);
    await x.run();
    expect(x.sets()).toBe(1); // the held slot keeps the merge's source: the older copy is not written over it
  });

  it("a merge's removal while a recovery's hook has run and its write has not landed: it waits for the write, removes none", async () => {
    const a = await itemsOf(g1, "othera00", "aaaaaaaaaaaaaaaa");
    const x = world({ items: a });
    await x.start(g2); // what the page's merge wrote
    const older = await seal(keys, vaultOf(keys.keyring.vaultId, [account("Older", SECRET)]), g2.seq + 1);
    const r = recovery(x, older); // a fallback's restore of an older copy, at the next counter
    const answer = watched(
      x.w.drop({ seq: g2.seq, sum: g2.envelope.checksum, slots: [{ slot: "othera00", gen: "aaaaaaaaaaaaaaaa" }] }),
    );
    await vi.waitFor(() => expect(x.s.vaultRequests).toBe(2)); // the removal asked for the store's lock ...
    await settle();
    expect(answer.settled).toBe(false); // ... and waits there
    r.land();
    await r.done;
    expect(await answer.p).toMatchObject({ ok: false, why: "not_that_generation" });
    for (const k of Object.keys(a)) expect(x.area.snapshot()[k], k).toEqual(a[k]);
  });

  it("a merge while a recovery holds the store's lock and its hook has not run yet: the hook runs first, no deadlock", async () => {
    // the hook takes the records' lock inside the store's: a handler that took the records' lock first and then waited
    // for the store's would wait for the recovery, and the recovery for it
    const { x, tag, slot } = await heldWorld();
    const older = await seal(keys, vaultOf(keys.keyring.vaultId, [account("Older", SECRET)]), g3.seq + 1);
    let go!: () => void;
    const gate = new Promise<void>((r) => (go = r));
    x.s.vaultRequests = 0;
    const done = watched(
      x.vaultLock(async () => {
        await gate;
        await markCsbHeld(x.kv, x.lock);
        await x.put(older);
      }),
    );
    const answer = watched(x.w.merged({ slot, gen: tag, seq: g3.seq, sum: g3.envelope.checksum }));
    await vi.waitFor(() => expect(x.s.vaultRequests).toBe(2));
    await settle();
    go();
    await vi.waitFor(() => expect([done.settled, answer.settled]).toEqual([true, true]), { timeout: 5_000 });
    expect(await answer.p).toEqual({ ok: false, why: "not_that_generation" });
  });

  it("a merge's message without the generation's counter and checksum, or of a link not held, or after another write there: refused", async () => {
    const { x, tag, slot } = await heldWorld();
    const m = { slot, gen: tag, seq: g3.seq, sum: g3.envelope.checksum };
    for (const bad of [
      { slot, gen: tag },
      { slot, gen: tag, seq: g3.seq },
      { slot, gen: tag, sum: g3.envelope.checksum },
      { ...m, seq: "3" },
      { ...m, sum: "x" },
      { ...m, slot: 7 },
      { ...m, gen: "zz" },
    ])
      expect(await x.w.merged(bad), JSON.stringify(bad)).toEqual({ ok: false, why: "bad_message" });
    // another computer wrote the slot since the page read it: merge again
    for (const [k, v] of Object.entries(await itemsOf(g1, slot, "4444444444444444")))
      x.area.applyRemote(k, { value: v });
    expect(await x.w.merged(m)).toEqual({ ok: false, why: "slot_changed" });
    expect((await x.link()).held).toBe(true);
    const y = world();
    await y.start();
    expect(await y.w.merged({ slot: (await y.link()).slot, gen: null, seq: 1, sum: g1.envelope.checksum })).toEqual({
      ok: false,
      why: "not_held",
    });
  });

  it("a merge's removal (C12): exactly the slots still whole under the tag the page read; never this device's own", async () => {
    const a = await itemsOf(g1, "othera00", "aaaaaaaaaaaaaaaa");
    const b = await itemsOf(g1, "otherb00", "bbbbbbbbbbbbbbbb");
    const c = await itemsOf(g1, "otherc00", "cccccccccccccccc");
    const x = world({ items: { ...a, ...b, ...c } });
    await x.start();
    const own = (await x.link()).slot;
    x.area.items.delete(chunkKey("otherc00", 0)); // c is no longer whole
    const r = await x.w.drop({
      seq: g1.seq,
      sum: g1.envelope.checksum,
      slots: [
        { slot: "othera00", gen: "aaaaaaaaaaaaaaaa" },
        { slot: "otherb00", gen: "9999999999999999" }, // written again since the page read it
        { slot: "otherc00", gen: "cccccccccccccccc" },
        { slot: own, gen: (await x.link()).gen },
      ],
    });
    expect(r).toEqual({ ok: true, removed: ["othera00"], kept: ["otherb00", "otherc00", own] });
    const snap = x.area.snapshot();
    expect(Object.keys(snap).some((k) => k.startsWith("bk1.othera00"))).toBe(false);
    for (const k of Object.keys(b)) expect(snap[k], k).toEqual(b[k]);
    expect((await x.own()).kind).toBe("ok");
    const w = { seq: g1.seq, sum: g1.envelope.checksum };
    for (const bad of [
      {},
      { ...w, slots: [] },
      { ...w, slots: [{ slot: "othera00" }] },
      { ...w, slots: [{ slot: "x", gen: "aaaaaaaaaaaaaaaa" }] },
      {
        ...w,
        slots: [
          { slot: "otherb00", gen: "bbbbbbbbbbbbbbbb" },
          { slot: "otherb00", gen: "bbbbbbbbbbbbbbbb" },
        ],
      },
      { ...w, slots: Array.from({ length: 65 }, (_, i) => ({ slot: `s${String(i).padStart(7, "0")}`, gen: TAG })) },
      // the generation the merge wrote, missing or malformed
      { slots: [{ slot: "otherb00", gen: "bbbbbbbbbbbbbbbb" }] },
      { seq: g1.seq, slots: [{ slot: "otherb00", gen: "bbbbbbbbbbbbbbbb" }] },
      { sum: g1.envelope.checksum, slots: [{ slot: "otherb00", gen: "bbbbbbbbbbbbbbbb" }] },
      { seq: -1, sum: g1.envelope.checksum, slots: [{ slot: "otherb00", gen: "bbbbbbbbbbbbbbbb" }] },
      { seq: g1.seq, sum: "x", slots: [{ slot: "otherb00", gen: "bbbbbbbbbbbbbbbb" }] },
    ])
      expect(await x.w.drop(bad), JSON.stringify(bad)).toEqual({
        ok: false,
        why: "bad_message",
        removed: [],
        kept: [],
      });
    expect(x.area.callsOf("remove")).toHaveLength(1);
  });

  it("a merge's removal only while the vault on disk is the generation the merge wrote: else none, and a line", async () => {
    const a = await itemsOf(g1, "othera00", "aaaaaaaaaaaaaaaa");
    const x = world({ items: a });
    await x.start(g2);
    // the page's merge wrote g2; the store has fallen back since (another generation on disk)
    await x.put(g3);
    const r = await x.w.drop({
      seq: g2.seq,
      sum: g2.envelope.checksum,
      slots: [{ slot: "othera00", gen: "aaaaaaaaaaaaaaaa" }],
    });
    expect(r).toEqual({ ok: false, why: "not_that_generation", removed: [], kept: ["othera00"] });
    for (const k of Object.keys(a)) expect(x.area.snapshot()[k], k).toEqual(a[k]);
    expect(x.notes.some((n) => n.includes("removal not taken"))).toBe(true);
    // the same counter with other data: refused too
    const same = await seal(keys, vaultOf(keys.keyring.vaultId, [account("Same", SECRET)]), g3.seq);
    expect(
      await x.w.drop({
        seq: same.seq,
        sum: same.envelope.checksum,
        slots: [{ slot: "othera00", gen: "aaaaaaaaaaaaaaaa" }],
      }),
    ).toMatchObject({ ok: false, why: "not_that_generation" });
    expect(x.area.callsOf("remove")).toEqual([]);
  });

  it("a merge's removal only if this device's copy then fits: another vault merged in that leaves it too large, none removed", async () => {
    // this vault and another, 150 accounts each, the other's copy taking the room this one's needs (no_room); merged
    // in, this vault holds both: it would not fit even once the other's copy were gone
    const mine = await seal(keys, vaultOf(keys.keyring.vaultId, many(150)), 1);
    const theirs = await seal(otherKeys, vaultOf(otherKeys.keyring.vaultId, many(150)), 1);
    const t = await itemsOf(theirs, "theirs09", "9999999999999999");
    const x = world({ items: t });
    await x.start(mine);
    expect(await x.state()).toMatchObject({ err: "no_room" });
    const both = await seal(keys, vaultOf(keys.keyring.vaultId, [...many(150), ...many(150, "Theirs")]), 2);
    await x.put(both);
    const r = await x.w.drop({
      seq: both.seq,
      sum: both.envelope.checksum,
      slots: [{ slot: "theirs09", gen: "9999999999999999" }],
    });
    expect(r).toEqual({ ok: false, why: "would_not_fit", removed: [], kept: ["theirs09"] });
    for (const k of Object.keys(t)) expect(x.area.snapshot()[k], k).toEqual(t[k]);
    expect(x.area.callsOf("remove")).toEqual([]);
    // a copy of this vault (another computer's), which the merge adds nothing from: removing it lets this one fit
    const small = await seal(keys, vaultOf(keys.keyring.vaultId, many(60)), 1);
    const sib = await itemsOf(small, "sibling0", "8888888888888888");
    const y = world({ items: { ...sib, ...t } });
    await y.start(small);
    expect(await y.state()).toMatchObject({ err: "no_room" });
    expect(
      await y.w.drop({
        seq: small.seq,
        sum: small.envelope.checksum,
        slots: [{ slot: "sibling0", gen: "8888888888888888" }],
      }),
    ).toEqual({ ok: true, removed: ["sibling0"], kept: [] });
    await y.w.idle();
    expect(await y.state()).toMatchObject({ err: null }); // the room it freed: this one written
  });

  it("a merge's removal where this device cannot write a copy at all (a device key opens the vault): none removed", async () => {
    const a = await itemsOf(g1, "othera00", "aaaaaaaaaaaaaaaa");
    const x = world({ items: a });
    const gen = await legacyDeviceGeneration([account("GitHub", SECRET)]);
    await x.start(gen);
    expect(await x.state()).toMatchObject({ err: "no_password" });
    expect(
      await x.w.drop({
        seq: gen.seq,
        sum: gen.envelope.checksum,
        slots: [{ slot: "othera00", gen: "aaaaaaaaaaaaaaaa" }],
      }),
    ).toEqual({ ok: false, why: "would_not_fit", removed: [], kept: ["othera00"] });
    for (const k of Object.keys(a)) expect(x.area.snapshot()[k], k).toEqual(a[k]);
    expect(x.area.callsOf("remove")).toEqual([]);
  });
});

// ---- the real worker --------------------------------------------------------------------------------------------------

describe("in the real worker (src/background/sw.ts)", () => {
  afterEach(unload);
  const OPTIONS = {
    id: "abcdefghijklmnopabcdefghijklmnop",
    url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/options/index.html",
  };
  const POPUP = { ...OPTIONS, url: OPTIONS.url.replace("options", "popup") };
  const vault = (gen: Generation) => ({
    sk_slot_a: gen,
    sk_active: "a",
    sk_keyring: { v: 1, savedAt: gen.savedAt, keyring: gen.keyring },
  });
  const on = { sk_csb_cfg: { v: 1, on: true, opens: "both", declined: false, link: null } };
  const ran = { sk_csb_state: { ...NEW_CSB_STATE, lastRun: Date.now() } };
  const ask = (w: Awaited<ReturnType<typeof loadWorker>>, type: string, sender = OPTIONS) =>
    new Promise<unknown>((resolve) => {
      const kept = w.send({ type }, sender, resolve).some((r) => r === true);
      if (!kept) resolve("no answer");
    });

  // (Node has no Web Locks: the worker's locks are in-process mutexes, and its fake storage answers through promises,
  // so `settle` drains whatever a change or a refused message starts that hashes nothing)
  it("a write of the store's pointer, and no other key, arms the debounce 30 s ahead while the backup is on", async () => {
    const w = await loadWorker({ seedLocal: { ...on, ...ran } });
    for (const l of w.listeners.localChanged!) l({ sk_settings: { newValue: {} } });
    await settle();
    expect(w.alarms.has(CSB_SOON_ALARM)).toBe(false);
    const t = Date.now();
    for (const l of w.listeners.localChanged!) l({ sk_active: { newValue: "b" } });
    await vi.waitFor(() => expect(w.alarms.has(CSB_SOON_ALARM)).toBe(true));
    const when = (w.alarms.get(CSB_SOON_ALARM) as { when: number }).when;
    expect(when - t).toBeGreaterThanOrEqual(30_000);
    expect(when - t).toBeLessThan(31_000);
    unload();
    const off = await loadWorker({ seedLocal: { ...ran } });
    for (const l of off.listeners.localChanged!) l({ sk_active: { newValue: "b" } });
    await settle();
    expect(off.alarms.has(CSB_SOON_ALARM)).toBe(false);
  });

  it("the settings page turns it on, and the store's generation, locked, goes to storage.sync; the popup cannot", async () => {
    const w = await loadWorker({ seedLocal: { ...vault(g1) } });
    expect(await ask(w, "sk-csb-on", POPUP)).toBe("no answer");
    await settle();
    expect(w.local.data.has("sk_csb_cfg")).toBe(false); // not turned on
    expect(w.sync.callsOf("set")).toEqual([]);
    expect(await ask(w, "sk-csb-on")).toEqual({ ok: true });
    await vi.waitFor(() => expect(w.sync.callsOf("set")).toHaveLength(1), { timeout: 5_000 });
    expect(await ask(w, "sk-csb-now")).toEqual({ ok: true }); // (answered once no run is going)
    expect(w.sync.callsOf("set")).toHaveLength(1); // nothing changed since
    const l = parseCsbConfig(w.local.data.get("sk_csb_cfg")).link!;
    const a = await assembleSlot(w.sync.snapshot(), l.slot);
    expect(a.kind === "ok" && a.backup.generation.seq).toBe(1);
  });

  it("the backup's alarm runs it; a device-key vault is refused before anything is written", async () => {
    const dev = await legacyDeviceGeneration([]);
    const w = await loadWorker({ seedLocal: { ...on, ...ran, ...vault(dev) } });
    const state = () => w.local.data.get("sk_csb_state");
    for (const l of w.listeners.alarm!) l({ name: "sk-daily-not-the-backup" });
    // a run now, answered once no run is going: the only one (a run the other alarm started would be a second)
    expect(await ask(w, "sk-csb-now")).toEqual({ ok: true });
    expect(state()).toMatchObject({ err: "no_password", retries: 1 });
    for (const l of w.listeners.alarm!) l({ name: CSB_SOON_ALARM });
    await vi.waitFor(() => expect(state()).toMatchObject({ err: "no_password", retries: 2 }), { timeout: 5_000 });
    expect(w.sync.callsOf("set")).toEqual([]);
  });

  it("a start whose storage.sync level was refused: not turned on, the alarm writes nothing, one diagnostics line", async () => {
    const w = await loadWorker({ sync: "reject", seedLocal: { ...on, ...ran, ...vault(g1) } });
    expect(await ask(w, "sk-csb-on")).toEqual({ ok: false, why: "unsafe_area" });
    for (const l of w.listeners.alarm!) l({ name: CSB_SOON_ALARM });
    const diag = () => ((w.local.data.get("sk_diag") ?? []) as { message: string }[]).map((d) => d.message);
    await vi.waitFor(() => expect(diag()).toHaveLength(1));
    await settle(); // the run's two reads, the record and the start's answer, and it stops
    expect(w.sync.calls.filter((c) => c.op !== "get" && c.op !== "getBytesInUse")).toEqual([]);
    expect(diag()).toEqual(["storage access level not restricted: sync"]);
  });

  it("the store's recovery hook, as the runtime wires it, marks the link held: the run that fell back writes nothing", async () => {
    // the generation it falls back to as the link says, but for the wraps: unmarked, the run would write ("changed")
    const link = {
      ...LINK,
      seq: g2.seq,
      sum: g2.envelope.checksum,
      vaultId: g2.envelope.vaultId,
      vkId: g2.keyring.vkId,
      wraps: "password:AAAAAAAAAAAAAAAA",
    };
    const seed = {
      sk_csb_cfg: { v: 1, on: true, opens: "both", declined: false, link },
      ...ran,
      sk_active: "a",
      sk_slot_a: { torn: "half a write" },
      sk_slot_b: g2,
      sk_keyring: { v: 1, savedAt: g2.savedAt, keyring: g2.keyring },
    };
    const w = await loadWorker({ seedLocal: seed, seedSync: await itemsOf(g2, "abcd1234") });
    for (const l of w.listeners.alarm!) l({ name: CSB_SOON_ALARM });
    await vi.waitFor(() => expect(w.local.data.get("sk_csb_state")).toMatchObject({ err: "held" }), { timeout: 5_000 });
    expect(parseCsbConfig(w.local.data.get("sk_csb_cfg")).link?.held).toBe(true);
    expect(w.sync.callsOf("set")).toEqual([]);
  });
});
