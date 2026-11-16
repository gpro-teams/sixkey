// PHASE0X-PLAN A2 (U1b): opening and unlocking no longer scan every copy for old key material; a marker (sk_keychange)
// says when to. What must hold, with a crash at any write (the Proc model of test/regression/enable-crash.test.ts: one
// process for local storage, the mirror and the session, dying at write N, just before or just after it lands):
//   1. At every crash point: if any copy on disk is under another key than the active one, or holds a device key the
//      active keyring no longer has, the next open or unlock will clean up (the marker is there, or sk_store_v asks for
//      a check). So the marker is written before the commit and cleared only after the cleaning.
//   2. After a restart through the NEW path only (openView, unlockWithPassword; no selfCheck, no read()): no device key
//      anywhere, every copy under the current key, the marker gone, sk_store_v set, and the accounts all there.
// Plus the cases around it: an extra marker, residue from before the marker existed, residue in the steady state (not
// cleaned: that is the trade-off, and selfCheck is the backstop), a key change by an older version, a read error or a
// broken mirror during the cleanup, two key changes before one cleanup, a vault made over lost data, and M2's hook.
import { describe, expect, it } from "vitest";
import {
  checkGeneration,
  checkKeyringCopy,
  checkSnapshot,
  KEYS,
  parseSnapshotIndex,
  type Generation,
} from "../../src/core/storage/format";
import { createMutex, MemoryKV, type KV, type Lock } from "../../src/core/storage/kv";
import { VaultStore, type Cleanup } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession, type SessionCache, type SessionData } from "../../src/core/service/types";
import { addEntry } from "../../src/core/vault/ops";
import { aliveEntries, emptyVault } from "../../src/core/vault/model";
import { createClock } from "../../src/core/vault/hlc";
import { encryptVault } from "../../src/core/crypto/envelope";
import { createKeyring, setPassword } from "../../src/core/crypto/keyring";
import { serializeVault } from "../../src/core/vault/validate";
import { createProtected, deviceMaterial, legacyDeviceVault, STRONG, NO_PAGE } from "../helpers/vaults";
import { tear } from "../helpers/faulty-kv";
import { TEST_KDF_ITERATIONS } from "../helpers/kdf";

const input = (issuer: string) => ({
  type: "totp" as const,
  issuer,
  label: "a",
  secret: "JBSWY3DPEHPK3PXP",
  algorithm: "SHA1" as const,
  digits: 6 as const,
  period: 30,
});
const NAMES = ["GitHub", "AWS", "Stripe"];
const RETENTION_ROLLING = 10;
const snapKeys = (m: MemoryKV) => [...m.data.keys()].filter((k) => k.startsWith("sk_snap_") && k !== KEYS.snapIndex);

// ---- the process model (as in test/regression/enable-crash.test.ts) -------------------------------------------------

class Dead extends Error {
  constructor() {
    super("process died");
    this.name = "Dead";
  }
}
class Proc {
  calls = 0;
  dead = false;
  constructor(
    public at = Infinity,
    public mode: "before" | "after" = "before",
  ) {}
  hit(): boolean {
    if (this.dead) throw new Dead();
    this.calls++;
    if (this.calls === this.at) {
      this.dead = true;
      return this.mode === "after";
    }
    return true;
  }
}
class ProcKV implements KV {
  constructor(
    private inner: MemoryKV,
    private p: Proc,
  ) {}
  async get(k: string[]) {
    if (this.p.dead) throw new Dead();
    return this.inner.get(k);
  }
  async keys() {
    if (this.p.dead) throw new Dead();
    return this.inner.keys();
  }
  async set(items: Record<string, unknown>) {
    const land = this.p.hit();
    if (land) await this.inner.set(items);
    if (this.p.dead) throw new Dead();
  }
  async remove(keys: string[]) {
    const land = this.p.hit();
    if (land) await this.inner.remove(keys);
    if (this.p.dead) throw new Dead();
  }
}
class ProcSession implements SessionCache {
  constructor(
    private inner: MemorySession,
    private p: Proc,
  ) {}
  async get() {
    if (this.p.dead) throw new Dead();
    return this.inner.get();
  }
  async set(d: SessionData) {
    const land = this.p.hit();
    if (land) await this.inner.set(d);
    if (this.p.dead) throw new Dead();
  }
  async clear() {
    const land = this.p.hit();
    if (land) await this.inner.clear();
    if (this.p.dead) throw new Dead();
  }
  async lockEpoch() {
    return this.inner.lockEpoch();
  }
  async bumpLockEpoch() {
    return this.inner.bumpLockEpoch();
  }
  // the session quick unlock (QUICK-UNLOCK Stage 1): passed through, not a crash point; a dead process touches nothing
  async getQuick() {
    if (this.p.dead) throw new Dead();
    return this.inner.getQuick();
  }
  async setQuick(q: Parameters<SessionCache["setQuick"]>[0]) {
    if (this.p.dead) throw new Dead();
    return this.inner.setQuick(q);
  }
  async clearQuick() {
    if (this.p.dead) throw new Dead();
    return this.inner.clearQuick();
  }
}

// ---- worlds ------------------------------------------------------------------------------------------------------------

const t = { now: 1_700_000_000_000 };
type World = { kv: MemoryKV; mirror: MemoryKV; session: MemorySession };
const svcOver = (
  w: World,
  kv: KV = w.kv,
  mirror: KV = w.mirror,
  session: SessionCache = w.session,
  lock?: Lock,
  onDiag?: (m: string) => void,
) =>
  new VaultService({
    store: new VaultStore({
      lock: createMutex(),
      kv,
      mirror,
      now: () => t.now,
      ...(lock ? { lock } : {}),
      ...(onDiag ? { onDiag } : {}),
    }),
    session,
    settings: new KvSettingsStore(w.kv),
    now: () => t.now,
    kdfIterations: TEST_KDF_ITERATIONS,
    ...(onDiag ? { onDiag } : {}),
  });
const clone = (w: World): World => {
  const c = (m: MemoryKV) => {
    const n = new MemoryKV();
    for (const [k, v] of m.data) n.data.set(k, structuredClone(v));
    return n;
  };
  const session = new MemorySession();
  session.data = w.session.data ? { ...w.session.data } : null;
  session.epoch = w.session.epoch;
  return { kv: c(w.kv), mirror: c(w.mirror), session };
};
async function addNames(svc: VaultService) {
  for (const n of NAMES) {
    t.now += 60_000;
    await svc.mutate((v, c) => addEntry(v, input(n), c).vault);
  }
}
async function daily(w: World, day: string) {
  await new VaultStore({
    lock: createMutex(),
    kv: w.kv,
    mirror: w.mirror,
    now: () => t.now,
    dayKey: () => day,
  }).ensureDailySnapshot();
}

/** A Phase 0 device-key vault with three accounts, rolling and daily snapshots, and a daily copy in the mirror. */
async function legacyWorld(): Promise<World> {
  const w: World = { kv: new MemoryKV(), mirror: new MemoryKV(), session: new MemorySession() };
  await legacyDeviceVault(new VaultStore({ lock: createMutex(), kv: w.kv, mirror: w.mirror, now: () => t.now }));
  await addNames(svcOver(w));
  await daily(w, "2026-01-01");
  return w;
}
/** A password vault in its steady state (unlocked, the one-time check done), with snapshots in both stores. */
async function protectedWorld(): Promise<World> {
  const w: World = { kv: new MemoryKV(), mirror: new MemoryKV(), session: new MemorySession() };
  const svc = svcOver(w);
  await createProtected(svc);
  await addNames(svc);
  await daily(w, "2026-01-01");
  expect((await svc.openView()).state).toBe("unlocked"); // runs the one-time check
  expect(w.kv.data.get(KEYS.storeVersion)).toMatchObject({ v: 2 });
  return w;
}

// ---- what is on disk ---------------------------------------------------------------------------------------------------

/** The generation the pointer names, read as it is (no repair). The crash modes here never tear a write, so it exists. */
async function activeOnDisk(kv: MemoryKV): Promise<Generation> {
  const ptr = kv.data.get(KEYS.active) as "a" | "b";
  const g = await checkGeneration(kv.data.get(KEYS.slot[ptr]));
  if (!g) throw new Error("no readable active generation");
  return g;
}

/**
 * Every copy that a finished key change would not leave: another key, a device key the active keyring lacks, damage.
 * A snapshot under a key the keyring does not list (neither current nor previous) is kept on purpose (store.ts), so it
 * is not reported; one under a previous key is.
 */
async function oldMaterial(w: World, active: Generation): Promise<string[]> {
  const out: string[] = [];
  const oldKeyring = (k: { vkId: string; deviceKey?: string }) =>
    k.vkId !== active.keyring.vkId || (k.deviceKey !== undefined && active.keyring.deviceKey === undefined);
  const previous = new Set(active.keyring.previous.map((p) => p.vkId));
  for (const [name, m] of [
    ["local", w.kv],
    ["mirror", w.mirror],
  ] as const) {
    const listed = new Set(parseSnapshotIndex(m.data.get(KEYS.snapIndex)).map((x) => KEYS.snap(x.id)));
    for (const [k, v] of m.data) {
      if (k === KEYS.slot.a || k === KEYS.slot.b || k === KEYS.mirrorGen) {
        const g = await checkGeneration(v);
        if (!g) out.push(`${name}:${k} damaged`);
        else if (oldKeyring(g.keyring)) out.push(`${name}:${k} old keyring`);
      } else if (k === KEYS.keyringCopy) {
        const c = checkKeyringCopy(v);
        if (!c) out.push(`${name}:${k} damaged`);
        else if (oldKeyring(c.keyring)) out.push(`${name}:${k} old keyring`);
      } else if (k.startsWith("sk_snap_") && k !== KEYS.snapIndex) {
        const rec = await checkSnapshot(v);
        if (!rec) out.push(`${name}:${k} damaged`);
        else if (previous.has(rec.envelope.vkId))
          out.push(`${name}:${k} old key${listed.has(k) ? "" : " (not in the index)"}`);
        else if (rec.envelope.vkId === active.keyring.vkId && !listed.has(k)) out.push(`${name}:${k} not in the index`);
      }
    }
  }
  if (!active.keyring.deviceKey) {
    out.push(...deviceMaterial(w.kv).map((x) => `local:${x}`));
    out.push(...deviceMaterial(w.mirror).map((x) => `mirror:${x}`));
  }
  return out;
}

/** What the next open or unlock will do: loadView's verdict (read-only here: the active slot is readable). */
async function cleanupAt(w: World): Promise<Cleanup> {
  const r = await new VaultStore({ lock: createMutex(), kv: w.kv, mirror: w.mirror, now: () => t.now }).loadView();
  if (r.status !== "ok") throw new Error(r.status);
  return r.cleanup;
}
const cleanupDue = async (w: World) => (await cleanupAt(w)) !== "none";
/**
 * The marker's promise: anything old in this store means a full cleanup at the next open or unlock; anything old only in
 * the mirror means at least the next unlock. Returns what breaks it.
 */
function brokenPromise(left: string[], due: Cleanup): string[] {
  const out: string[] = [];
  if (left.some((x) => x.startsWith("local:")) && due !== "full")
    out.push(`old material in this store but the cleanup due is "${due}"`);
  if (left.some((x) => x.startsWith("mirror:")) && due === "none")
    out.push(`old material in the mirror but no cleanup due`);
  return out;
}

/** After the cleanup: nothing old, the marker gone, sk_store_v naming the current key, every account there. */
async function expectClean(w: World, where: string) {
  const active = await activeOnDisk(w.kv);
  expect(await oldMaterial(w, active), where).toEqual([]);
  expect(w.kv.data.has(KEYS.keyChange), where).toBe(false);
  expect(w.kv.data.get(KEYS.storeVersion), where).toEqual({ v: 2, vkId: active.keyring.vkId });
}

/** The popup after a restart, through the new path only: open; if that shows the lock screen, unlock with the password. */
async function popupAfterRestart(w: World): Promise<{ protectedNow: boolean; names: string[] }> {
  const svc = svcOver(w);
  let v = await svc.openView();
  if (v.state === "locked") v = (await svc.unlockWithPassword(STRONG)).view;
  if (v.state !== "unlocked") throw new Error(v.state);
  return { protectedNow: v.passwordProtected, names: aliveEntries(v.vault).map((e) => e.issuer) };
}

// ---- 1 + 2: a crash at every write of a key change --------------------------------------------------------------------

type Op = {
  name: string;
  world: () => Promise<World>;
  run: (s: VaultService) => Promise<unknown>;
  unrelatedVersion: boolean;
  startsDue: boolean;
};
const OPS: Op[] = [
  // A Phase 0 vault never has sk_store_v, so the one-time check alone would catch its leftovers ...
  {
    name: "turning on the master password (as on a real Phase 0 vault: no sk_store_v)",
    world: legacyWorld,
    run: (s) => s.enableMasterPassword(STRONG, NO_PAGE),
    unrelatedVersion: false,
    startsDue: true,
  },
  // ... so it is run again with a sk_store_v that does not ask for a check: then only the marker can.
  {
    name: "turning on the master password (marker alone)",
    world: legacyWorld,
    run: (s) => s.enableMasterPassword(STRONG, NO_PAGE),
    unrelatedVersion: true,
    startsDue: false,
  },
  {
    name: "rotating the key (steady state: sk_store_v names the old key)",
    world: protectedWorld,
    run: (s) => s.rotateKey(STRONG, NO_PAGE),
    unrelatedVersion: false,
    startsDue: false,
  },
  {
    name: "rotating the key (marker alone)",
    world: protectedWorld,
    run: (s) => s.rotateKey(STRONG, NO_PAGE),
    unrelatedVersion: true,
    startsDue: false,
  },
];

describe.each(OPS.map((o) => [o.name, o] as const))("%s, interrupted at any write", (_name, op) => {
  it("leaves a marker (or a due check) whenever old material is on disk, and the new open/unlock path cleans everything", async () => {
    const base = await op.world();
    if (op.unrelatedVersion) base.kv.data.set(KEYS.storeVersion, { v: 2, vkId: "ffffffffffffffff" });
    expect(await cleanupDue(base)).toBe(op.startsDue); // the steady state the change starts from (a Phase 0 vault was never checked)

    const probe = clone(base);
    const pp = new Proc();
    await op.run(
      svcOver(probe, new ProcKV(probe.kv, pp), new ProcKV(probe.mirror, pp), new ProcSession(probe.session, pp)),
    );
    const total = pp.calls;
    expect(total).toBeGreaterThan(8);
    await expectClean(probe, "uninterrupted");

    const problems: string[] = [];
    for (let at = 1; at <= total; at++) {
      for (const mode of ["before", "after"] as const) {
        const where = `crash ${mode} write ${at}/${total}`;
        const w = clone(base);
        const p = new Proc(at, mode);
        await op
          .run(svcOver(w, new ProcKV(w.kv, p), new ProcKV(w.mirror, p), new ProcSession(w.session, p)))
          .catch((e) => {
            if (!(e instanceof Dead)) throw e;
          });
        expect(p.dead, where).toBe(true);

        // 1. at the moment of the crash
        const left = await oldMaterial(w, await activeOnDisk(w.kv));
        for (const b of brokenPromise(left, await cleanupAt(w)))
          problems.push(`${where}: ${b}; on disk: ${left.join(", ")}`);

        // 2. restart (the session in chrome.storage.session survives a page closing), the popup's path only
        const seen = await popupAfterRestart(w);
        expect(seen.names, where).toEqual(NAMES);
        if (!seen.protectedNow) continue; // still the device-key vault: the change never committed, nothing was promised
        const after = await oldMaterial(w, await activeOnDisk(w.kv));
        if (after.length) problems.push(`${where}: after the next open/unlock still on disk: ${after.join(", ")}`);
        if (w.kv.data.has(KEYS.keyChange)) problems.push(`${where}: marker still set after the cleanup`);
        // and it stays clean: the next popup is a plain open
        await popupAfterRestart(w);
        expect(await cleanupAt(w), where).toBe("none");
      }
    }
    expect(problems).toEqual([]);
  }, 120_000);
});

// ---- the cases around it ------------------------------------------------------------------------------------------------

describe("the marker", () => {
  it("is written before the commit: a key change that fails at the pointer write leaves the marker and the old state", async () => {
    const w = await protectedWorld();
    const before = (await activeOnDisk(w.kv)).keyring.vkId;
    // the commit is the pointer write; find it: the first write of KEYS.active after the marker
    const order: string[] = [];
    const spy: KV = {
      get: (k) => w.kv.get(k),
      keys: () => w.kv.keys(),
      remove: (k) => w.kv.remove(k),
      set: async (i) => {
        order.push(...Object.keys(i));
        if (Object.keys(i).includes(KEYS.active)) throw new Error("disk full");
        return w.kv.set(i);
      },
    };
    await expect(svcOver(w, spy).rotateKey(STRONG, NO_PAGE)).rejects.toThrow("disk full");
    expect(order.indexOf(KEYS.keyChange)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(KEYS.keyChange)).toBeLessThan(order.indexOf(KEYS.active));
    expect((await activeOnDisk(w.kv)).keyring.vkId).toBe(before); // not committed
    expect(w.kv.data.has(KEYS.keyChange)).toBe(true); // an extra marker: harmless
  });

  it("a failure to write the marker fails the key change before anything else is written", async () => {
    const w = await protectedWorld();
    const snap = JSON.stringify([...w.kv.data]);
    const spy: KV = {
      get: (k) => w.kv.get(k),
      keys: () => w.kv.keys(),
      remove: (k) => w.kv.remove(k),
      set: async (i) => {
        if (KEYS.keyChange in i) throw new Error("quota");
        return w.kv.set(i);
      },
    };
    await expect(svcOver(w, spy).rotateKey(STRONG, NO_PAGE)).rejects.toThrow("quota");
    expect(JSON.stringify([...w.kv.data])).toBe(snap);
  });

  it("an extra marker (a crash before the commit) costs one check and changes nothing else: the previous slot and the snapshots stay as they were", async () => {
    const w = await protectedWorld();
    w.kv.data.set(KEYS.keyChange, { v: 1, vkId: "0123456789abcdef", at: 1 });
    const keep =
      JSON.stringify([...w.kv.data].filter(([k]) => k !== KEYS.keyChange && k !== KEYS.storeVersion)) +
      JSON.stringify([...w.mirror.data]);
    expect(await cleanupDue(w)).toBe(true);
    expect((await svcOver(w).openView()).state).toBe("unlocked");
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
    expect(
      JSON.stringify([...w.kv.data].filter(([k]) => k !== KEYS.keyChange && k !== KEYS.storeVersion)) +
        JSON.stringify([...w.mirror.data]),
    ).toBe(keep);
  });

  it("a damaged marker counts as a marker", async () => {
    const w = await protectedWorld();
    for (const bad of [null, "garbage", 0, { torn: "x" }]) {
      w.kv.data.set(KEYS.keyChange, bad);
      expect(await cleanupDue(w)).toBe(true);
    }
  });

  // A4 (GM2-3): this test also counted a new password and a new recovery code as "saves that keep the key" and expected
  // no marker; it passed after the change only because their cleanup removes the marker again. It now says what happens:
  // an edit writes none, a new password or recovery code writes one before its commit, and its own cleanup clears it.
  it("an edit does not write it; a new password or recovery code of the same key does, before the commit, and its cleanup clears it", async () => {
    const w = await protectedWorld();
    const writes: string[][] = [];
    const spy: KV = {
      get: (k) => w.kv.get(k),
      keys: () => w.kv.keys(),
      remove: (k) => w.kv.remove(k),
      set: async (i) => {
        writes.push(Object.keys(i));
        return w.kv.set(i);
      },
    };
    const svc = svcOver(w, spy);
    const markerBeforeCommit = () => {
      const m = writes.findIndex((k) => k.includes(KEYS.keyChange));
      const c = writes.findIndex((k) => k.includes(KEYS.active));
      return m >= 0 && m < c;
    };
    await svc.mutate((v, c) => addEntry(v, input("Bank"), c).vault);
    expect(writes.some((k) => k.includes(KEYS.keyChange))).toBe(false);
    for (const [name, run] of [
      ["new password", () => svc.changePassword(STRONG, "granite-river-compass-31")],
      ["new recovery code", () => svc.newRecoveryCode("granite-river-compass-31", NO_PAGE)],
    ] as const) {
      writes.length = 0;
      await run();
      expect(markerBeforeCommit(), name).toBe(true);
      expect(w.kv.data.has(KEYS.keyChange), name).toBe(false);
      expect(await cleanupDue(w), name).toBe(false);
      await expectClean(w, name);
    }
  });

  // A4 (GM2-3): this test expected no marker for the first step (a password wrap added next to the device key, same
  // vault key), since the rule was "the key id changes or a device key goes away". Every keyring change marks now: the
  // other slot keeps the keyring from before, and after a password change that is the old wrap, which opens the data.
  it("every keyring change writes it, also with the key id kept: a password wrap added, then the device key taken away", async () => {
    const w: World = { kv: new MemoryKV(), mirror: new MemoryKV(), session: new MemorySession() };
    const store = new VaultStore({ lock: createMutex(), kv: w.kv, mirror: w.mirror, now: () => t.now });
    const { keyring, vk } = await legacyDeviceVault(store);
    const both = await setPassword(keyring, vk, STRONG); // device and password wraps, same vault key
    await store.transact(async (cur) => ({ envelope: cur!.envelope, keyring: both }));
    expect(w.kv.data.get(KEYS.keyChange)).toMatchObject({ v: 1, vkId: keyring.vkId }); // the keyring changed
    w.kv.data.delete(KEYS.keyChange); // as a finished cleanup leaves it
    const { deviceKey, ...rest } = both;
    void deviceKey;
    const passwordOnly = { ...rest, wraps: rest.wraps.filter((x) => x.method !== "device") };
    await store.transact(async (cur) => ({ envelope: cur!.envelope, keyring: passwordOnly }));
    expect(w.kv.data.get(KEYS.keyChange)).toMatchObject({ v: 1, vkId: keyring.vkId });
    w.kv.data.delete(KEYS.keyChange);
    await store.transact(async (cur) => ({ envelope: cur!.envelope, keyring: passwordOnly })); // the same keyring again
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false); // an ordinary save does not mark
  });

  it("M2's hook: transact({ keyChange: true }) writes it before the commit even when the key stays the same", async () => {
    const w = await protectedWorld();
    const store = new VaultStore({ lock: createMutex(), kv: w.kv, mirror: w.mirror, now: () => t.now });
    await store.transact(async (cur) => ({ envelope: cur!.envelope, keyring: cur!.keyring }), { keyChange: true });
    expect(w.kv.data.get(KEYS.keyChange)).toMatchObject({ v: 1, vkId: (await activeOnDisk(w.kv)).keyring.vkId });
  });
});

describe("old material and when it is cleaned", () => {
  /** The active slot's other half and the old snapshots, as a crash in an older version could leave them. */
  async function withResidue(w: World, oldW: World) {
    const ptr = w.kv.data.get(KEYS.active) as "a" | "b";
    const otherKey = ptr === "a" ? KEYS.slot.b : KEYS.slot.a;
    w.kv.data.set(otherKey, structuredClone(oldW.kv.data.get(otherKey) ?? oldW.kv.data.get(KEYS.slot.a)));
    const oldIdx = parseSnapshotIndex(oldW.kv.data.get(KEYS.snapIndex)).map((m) => ({ ...m, id: `${m.id}x` }));
    for (const m of parseSnapshotIndex(oldW.kv.data.get(KEYS.snapIndex))) {
      const rec = structuredClone(oldW.kv.data.get(KEYS.snap(m.id))) as { meta: { id: string } };
      rec.meta.id = `${m.id}x`;
      w.kv.data.set(KEYS.snap(`${m.id}x`), rec);
    }
    w.kv.data.set(KEYS.snapIndex, [...parseSnapshotIndex(w.kv.data.get(KEYS.snapIndex)), ...oldIdx]);
    expect(deviceMaterial(w.kv)).not.toEqual([]);
  }
  async function enabledWithResidue() {
    const legacy = await legacyWorld();
    const w = clone(legacy);
    await svcOver(w).enableMasterPassword(STRONG, NO_PAGE);
    await withResidue(w, legacy);
    return w;
  }

  it("from before the marker existed (no marker, no sk_store_v): the next unlock does the one full check and cleans it", async () => {
    const w = await enabledWithResidue();
    w.kv.data.delete(KEYS.storeVersion);
    await svcOver(w).lock();
    expect(await cleanupDue(w)).toBe(true);
    expect((await popupAfterRestart(w)).names).toEqual(NAMES);
    await expectClean(w, "after the unlock");
  });

  it("the same while still unlocked: the next open cleans it", async () => {
    const w = await enabledWithResidue();
    w.kv.data.delete(KEYS.storeVersion);
    expect((await svcOver(w).openView()).state).toBe("unlocked");
    await expectClean(w, "after the open");
  });

  it("a key change made by an older version (sk_store_v names a key the current keyring lists as previous): one full check", async () => {
    const w = await enabledWithResidue();
    const prev = (await activeOnDisk(w.kv)).keyring.previous[0]!.vkId;
    w.kv.data.set(KEYS.storeVersion, { v: 2, vkId: prev }); // what this version recorded before the older one changed the key
    expect(await cleanupDue(w)).toBe(true);
    await svcOver(w).openView();
    await expectClean(w, "after the open");
  });

  it("a snapshot record the index no longer lists (a crash between writing the index and removing records), under the old key, in either store: removed", async () => {
    const before = await protectedWorld();
    const w = clone(before);
    await svcOver(w).rotateKey(STRONG, NO_PAGE);
    await expectClean(w, "after the rotation");
    // Only orphans are left over: old-key records that no index names, as a crash inside a snapshot write or a cleanup leaves them.
    const oldRec = before.kv.data.get(KEYS.snap(parseSnapshotIndex(before.kv.data.get(KEYS.snapIndex))[0]!.id));
    w.kv.data.set(KEYS.snap("r999"), structuredClone(oldRec));
    w.mirror.data.set(KEYS.snap("d1999-01-01"), structuredClone(oldRec));
    w.kv.data.set(KEYS.keyChange, { v: 1, vkId: (await activeOnDisk(w.kv)).keyring.vkId, at: 1 });
    expect(await oldMaterial(w, await activeOnDisk(w.kv))).toEqual([
      "local:sk_snap_r999 old key (not in the index)",
      "mirror:sk_snap_d1999-01-01 old key (not in the index)",
    ]);
    await svcOver(w).openView();
    await expectClean(w, "after the open");
  });

  it("in the steady state (no marker, sk_store_v current) it is NOT looked for: that is the saving; selfCheck still removes a device key", async () => {
    const w = await enabledWithResidue();
    expect(await cleanupDue(w)).toBe(false);
    await svcOver(w).openView();
    await svcOver(w).lock();
    await popupAfterRestart(w);
    expect(deviceMaterial(w.kv)).not.toEqual([]); // the gate is the marker, by design (the invariant: nothing makes this state)
    await new VaultStore({ lock: createMutex(), kv: w.kv, mirror: w.mirror, now: () => t.now }).selfCheck(); // service worker start
    expect(deviceMaterial(w.kv, w.mirror)).toEqual([]);
  });

  it("a read that fails during the cleanup leaves the marker and deletes nothing; the next unlock finishes", async () => {
    const w = await enabledWithResidue();
    w.kv.data.set(KEYS.keyChange, { v: 1, vkId: (await activeOnDisk(w.kv)).keyring.vkId, at: 1 });
    const victim = KEYS.snap(parseSnapshotIndex(w.kv.data.get(KEYS.snapIndex)).at(-1)!.id);
    let fail = true;
    const flaky: KV = {
      get: async (k) => {
        if (fail && k.includes(victim)) throw new Error("IO error: transient");
        return w.kv.get(k);
      },
      set: (i) => w.kv.set(i),
      remove: (k) => w.kv.remove(k),
      keys: () => w.kv.keys(),
    };
    const diags: string[] = [];
    const svc = new VaultService({
      store: new VaultStore({ lock: createMutex(), kv: flaky, mirror: w.mirror, now: () => t.now }),
      session: w.session,
      settings: new KvSettingsStore(w.kv),
      now: () => t.now,
      onDiag: (m) => diags.push(m),
      kdfIterations: TEST_KDF_ITERATIONS,
    });
    expect((await svc.openView()).state).toBe("unlocked"); // the open itself still works
    expect(diags).toContain("key change cleanup incomplete");
    expect(w.kv.data.has(KEYS.keyChange)).toBe(true);
    expect(w.kv.data.has(victim)).toBe(true); // not dropped on account of a read that failed
    fail = false;
    await svc.openView();
    await expectClean(w, "after the retry");
  });

  it("a mirror that rejects writes: the local store is cleaned, the marker stays, and once the mirror works the next unlock clears it", async () => {
    const legacy = await legacyWorld();
    const w = clone(legacy);
    const realSet = w.mirror.set.bind(w.mirror);
    w.mirror.set = async () => {
      throw Object.assign(new Error("QuotaExceededError"), { name: "QuotaExceededError" });
    };
    await svcOver(w).enableMasterPassword(STRONG, NO_PAGE);
    const current = (await activeOnDisk(w.kv)).keyring.vkId;
    expect(w.kv.data.get(KEYS.keyChange)).toEqual({ v: 1, vkId: current, at: t.now, mirror: true }); // only the mirror is left
    expect(w.kv.data.get(KEYS.storeVersion)).toEqual({ v: 2, vkId: current });
    expect(deviceMaterial(w.kv)).toEqual([]); // the primary store is clean
    expect(deviceMaterial(w.mirror)).not.toEqual([]); // the mirror is not, and the marker says so
    expect(await cleanupAt(w)).toBe("mirror"); // an open leaves it to the next unlock (A2-1)
    await svcOver(w).openView();
    expect(deviceMaterial(w.mirror)).not.toEqual([]);
    await svcOver(w).lock();
    await popupAfterRestart(w);
    expect(w.kv.data.get(KEYS.keyChange)).toMatchObject({ mirror: true }); // still broken: still marked
    w.mirror.set = realSet;
    await svcOver(w).lock();
    await popupAfterRestart(w);
    await expectClean(w, "after the mirror healed");
  });

  it("two key changes before one cleanup finished: the next unlock moves everything to the newest key", async () => {
    const legacy = await legacyWorld();
    const w = clone(legacy);
    const realSet = w.mirror.set.bind(w.mirror);
    w.mirror.set = async () => {
      throw new Error("idb is gone");
    };
    await svcOver(w).enableMasterPassword(STRONG, NO_PAGE);
    await svcOver(w).rotateKey(STRONG, NO_PAGE);
    w.mirror.set = realSet;
    await svcOver(w).lock();
    expect((await popupAfterRestart(w)).names).toEqual(NAMES);
    await expectClean(w, "after the unlock");
  });

  it("finishKeyChange given a key that is no longer current does nothing and keeps the marker", async () => {
    const w = await protectedWorld();
    const store = new VaultStore({ lock: createMutex(), kv: w.kv, mirror: w.mirror, now: () => t.now });
    const { vk: stranger } = await createKeyring();
    w.kv.data.set(KEYS.keyChange, { v: 1, vkId: "0123456789abcdef", at: 1 });
    const snap = JSON.stringify([...w.kv.data]);
    expect(await store.finishKeyChange(stranger, async () => null)).toEqual({
      done: false,
      rewritten: 0,
      dropped: 0,
      kept: 0,
    });
    expect(JSON.stringify([...w.kv.data])).toBe(snap);
  });

  it("only the keyring copy is old (the device-key keyring put back): the cleanup replaces it", async () => {
    const legacy = await legacyWorld();
    const w = clone(legacy);
    await svcOver(w).enableMasterPassword(STRONG, NO_PAGE);
    await expectClean(w, "after the change");
    w.kv.data.set(KEYS.keyringCopy, structuredClone(legacy.kv.data.get(KEYS.keyringCopy)));
    w.kv.data.set(KEYS.keyChange, { v: 1, vkId: (await activeOnDisk(w.kv)).keyring.vkId, at: 1 });
    expect(await oldMaterial(w, await activeOnDisk(w.kv))).toEqual(
      expect.arrayContaining(["local:sk_keyring old keyring"]),
    );
    expect((await svcOver(w).openView()).state).toBe("unlocked");
    await expectClean(w, "after the open");
  });

  it("with the mirror failing, the marker becomes mirror-only only once this store is clean: a read that fails in this store's part keeps it full", async () => {
    const w = await enabledWithResidue();
    const current = (await activeOnDisk(w.kv)).keyring.vkId;
    w.kv.data.set(KEYS.keyChange, { v: 1, vkId: current, at: 1 });
    const victim = KEYS.snap(parseSnapshotIndex(w.kv.data.get(KEYS.snapIndex)).at(-1)!.id);
    let kvFails = true;
    let mirrorFails = true;
    const kv: KV = {
      get: async (k) => {
        if (kvFails && k.includes(victim)) throw new Error("IO error");
        return w.kv.get(k);
      },
      set: (i) => w.kv.set(i),
      remove: (k) => w.kv.remove(k),
      keys: () => w.kv.keys(),
    };
    const mirror: KV = {
      get: async (k) => {
        if (mirrorFails) throw new Error("idb down");
        return w.mirror.get(k);
      },
      set: async (i) => {
        if (mirrorFails) throw new Error("idb down");
        return w.mirror.set(i);
      },
      remove: (k) => w.mirror.remove(k),
      keys: async () => {
        if (mirrorFails) throw new Error("idb down");
        return w.mirror.keys();
      },
    };
    expect((await svcOver(w, kv, mirror).openView()).state).toBe("unlocked");
    expect(await cleanupAt(w)).toBe("full"); // this store's part failed: nothing claims it is clean
    expect(w.kv.data.get(KEYS.keyChange)).toEqual({ v: 1, vkId: current, at: 1 });
    kvFails = false;
    expect((await svcOver(w, kv, mirror).openView()).state).toBe("unlocked");
    expect(await cleanupAt(w)).toBe("mirror"); // this store is clean; the mirror is still out of reach
    expect((await oldMaterial(w, await activeOnDisk(w.kv))).filter((x) => x.startsWith("local:"))).toEqual([]);
    mirrorFails = false;
    await svcOver(w, kv, mirror).lock();
    expect((await popupAfterRestart(w)).names).toEqual(NAMES);
    await expectClean(w, "after the mirror came back");
  });

  it("a mirror-only marker is trusted only with a sk_store_v for the same key: with sk_store_v damaged, this store is checked again", async () => {
    const w = await enabledWithResidue(); // old material in this store ...
    const current = (await activeOnDisk(w.kv)).keyring.vkId;
    w.kv.data.set(KEYS.keyChange, { v: 1, vkId: current, at: 1, mirror: true }); // ... under a marker that says otherwise
    w.kv.data.set(KEYS.storeVersion, "garbage"); // (only external damage makes this state: sk_store_v is written first)
    expect(await cleanupAt(w)).toBe("full");
    expect((await svcOver(w).openView()).state).toBe("unlocked");
    await expectClean(w, "after the open");
  });

  it("two contexts at once (the cleanup on open in one; edits and a key rotation in the other; one shared lock): nothing lost, old material only while marked", async () => {
    for (let round = 0; round < 6; round++) {
      const w = await enabledWithResidue();
      w.kv.data.set(KEYS.keyChange, { v: 1, vkId: (await activeOnDisk(w.kv)).keyring.vkId, at: 1 }); // a crash after the commit
      const lock = createMutex(); // navigator.locks gives every context the same lock
      const popup = svcOver(w, w.kv, w.mirror, w.session, lock);
      const options = svcOver(w, w.kv, w.mirror, w.session, lock);
      const add = (s: VaultService, n: string) => s.mutate((v, c) => addEntry(v, input(n), c).vault);
      await Promise.all([popup.openView(), add(options, "E1"), popup.openView(), add(options, "E2")]);
      if (round % 2) await Promise.all([options.rotateKey(STRONG, NO_PAGE), popup.openView(), popup.openView()]);
      const names = aliveEntries((await svcOver(w, w.kv, w.mirror, w.session, lock).read()).vault)
        .map((e) => e.issuer)
        .sort();
      expect(names, `round ${round}`).toEqual([...NAMES, "E1", "E2"].sort());
      expect(
        brokenPromise(await oldMaterial(w, await activeOnDisk(w.kv)), await cleanupAt(w)),
        `round ${round}`,
      ).toEqual([]);
      await popup.lock();
      expect((await popupAfterRestart(w)).names.sort(), `round ${round}`).toEqual([...NAMES, "E1", "E2"].sort());
      await expectClean(w, `round ${round}, after an unlock`);
    }
  });

  it("M2's hook racing a cleanup: old material written inside a transact({ keyChange: true }) is never left unmarked", async () => {
    for (let round = 0; round < 6; round++) {
      const w = await enabledWithResidue();
      const current = (await activeOnDisk(w.kv)).keyring.vkId;
      // a stand-in for what M2 may leave: a valid snapshot record under a previous key (one of the planted old ones)
      const oldRec = [...w.kv.data].find(
        ([k, v]) =>
          k.startsWith("sk_snap_") &&
          k !== KEYS.snapIndex &&
          (v as { envelope?: { vkId?: string } }).envelope?.vkId !== current,
      )?.[1] as { meta: Record<string, unknown> };
      expect(oldRec).toBeDefined();
      w.kv.data.set(KEYS.keyChange, { v: 1, vkId: current, at: 1 });
      const lock = createMutex();
      expect((await svcOver(w, w.kv, w.mirror, w.session, lock).openView()).state).toBe("unlocked"); // clean first
      expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
      const store = new VaultStore({ kv: w.kv, mirror: w.mirror, now: () => t.now, lock });
      const m2 = store.transact(
        async (cur) => {
          await w.kv.set({
            [KEYS.snap("r9999")]: { ...structuredClone(oldRec), meta: { ...oldRec.meta, id: "r9999", seq: 9999 } },
          });
          return { envelope: cur!.envelope, keyring: cur!.keyring };
        },
        { keyChange: true },
      );
      await Promise.all([
        svcOver(w, w.kv, w.mirror, w.session, lock).openView(),
        m2,
        svcOver(w, w.kv, w.mirror, w.session, lock).openView(),
      ]);
      expect(
        brokenPromise(await oldMaterial(w, await activeOnDisk(w.kv)), await cleanupAt(w)),
        `round ${round}`,
      ).toEqual([]);
      await svcOver(w, w.kv, w.mirror, w.session, lock).openView();
      await expectClean(w, `round ${round}, after an open`);
    }
  });

  it("a copy under a NEWER key (a recovery fell back to an older keyring) is not looked for: opening and unlocking keep it", async () => {
    const w = await protectedWorld();
    const older = clone(w);
    await svcOver(w).rotateKey(STRONG, NO_PAGE); // everything now under the new key, cleanup done
    const newer = (await activeOnDisk(w.kv)).keyring.vkId;
    // Both slots and the keyring copy are lost; the mirror still has the generation from before the rotation.
    w.kv.data.delete(KEYS.slot.a);
    w.kv.data.delete(KEYS.slot.b);
    w.kv.data.delete(KEYS.keyringCopy);
    w.mirror.data.set(KEYS.mirrorGen, older.mirror.data.get(KEYS.mirrorGen));
    const svc = svcOver(w);
    await svc.lock();
    const v = await svc.openView(); // recovers from the mirror: the older keyring, an older snapshot of the data
    expect(v.state).toBe("locked");
    await svc.unlockWithPassword(STRONG);
    const newerCopies = () =>
      [...w.kv.data]
        .filter(
          ([k, x]) => k.startsWith("sk_snap_r") && (x as { envelope?: { vkId?: string } }).envelope?.vkId === newer,
        )
        .map(([k]) => k);
    const kept = newerCopies();
    expect(kept.length).toBeGreaterThan(0); // kept: it may be the latest data, and it is not old key material
    // A key-change cleanup that does run keeps it too (A2-4: with sync its keyring can come back), and reports it.
    w.kv.data.set(KEYS.keyChange, { v: 1, vkId: (await activeOnDisk(w.kv)).keyring.vkId, at: 1 });
    const diags: string[] = [];
    expect((await svcOver(w, w.kv, w.mirror, w.session, undefined, (m) => diags.push(m)).openView()).state).toBe(
      "unlocked",
    );
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
    expect(newerCopies()).toEqual(kept);
    expect(diags.some((m) => /^kept \d+ snapshot\(s\) under a key this vault does not know$/.test(m))).toBe(true);
  });
});

describe("a vault made over unreadable data", () => {
  /** The remains of a vault whose keyring is gone: damaged slots, and snapshots (seq 31-40) under its lost key. */
  async function lostRemains(w: World, vaultId?: string) {
    const { keyring: k0, vk } = await createKeyring();
    const keyring = vaultId ? { ...k0, vaultId } : k0;
    const env = await encryptVault(serializeVault(emptyVault(keyring.vaultId)), vk, {
      vaultId: keyring.vaultId,
      rev: 40,
    });
    w.kv.data.set(KEYS.active, "a");
    w.kv.data.set(KEYS.slot.a, tear({ v: 1, seq: 41, keyring }));
    w.kv.data.set(KEYS.slot.b, "garbage");
    for (let s = 31; s <= 40; s++)
      w.kv.data.set(KEYS.snap(`r${s}`), { v: 1, meta: { id: `r${s}`, kind: "rolling", at: s, seq: s }, envelope: env });
    w.kv.data.set(
      KEYS.snapIndex,
      Array.from({ length: 10 }, (_, i) => ({ id: `r${31 + i}`, kind: "rolling", at: 31 + i, seq: 31 + i })),
    );
    return keyring.vaultId;
  }
  const oldIds = (w: World) =>
    parseSnapshotIndex(w.kv.data.get(KEYS.snapIndex))
      .filter((m) => m.seq <= 40)
      .map((m) => m.id);
  const newIds = (w: World) =>
    parseSnapshotIndex(w.kv.data.get(KEYS.snapIndex))
      .filter((m) => m.seq > 40)
      .map((m) => m.id);
  const unlisted = (w: World) =>
    snapKeys(w.kv).filter((k) => !parseSnapshotIndex(w.kv.data.get(KEYS.snapIndex)).some((m) => KEYS.snap(m.id) === k));

  // A4 (SYNC-DESIGN §0.0i GM2-4): this test expected the lost vault's copies to be kept although they belong to another
  // vault (its vault id is not the backup's). The decision splits it by vault id: another vault's copies that no key
  // here opens are dropped by the cleanup the marker asks for; the same vault's are kept and age out (the next test).
  it("restoreBackup of ANOTHER vault over lost data writes the marker; the cleanup drops the old vault's copies nobody can open; the new vault's snapshots work at once", async () => {
    const w: World = { kv: new MemoryKV(), mirror: new MemoryKV(), session: new MemorySession() };
    const lostId = await lostRemains(w);
    expect(lostId).not.toBe("vault-backup-01");
    const svc = svcOver(w);
    expect((await svc.status()).state).toBe("lost");

    const backup = addEntry(
      emptyVault("vault-backup-01"),
      input("Bank"),
      createClock("bbbb", { now: () => t.now }),
    ).vault;
    await svc.restoreBackup(backup, await svc.prepareKeys(STRONG, { vaultId: "vault-backup-01" }));
    expect(w.kv.data.has(KEYS.keyChange)).toBe(true); // written by the transact that overwrote the lost data
    expect(oldIds(w).length).toBe(9); // nothing is dropped before the cleanup (the new vault's first snapshot took one place)

    const diags: string[] = [];
    const v = await svcOver(w, w.kv, w.mirror, w.session, undefined, (m) => diags.push(m)).openView();
    expect(v.state === "unlocked" && aliveEntries(v.vault).map((e) => e.issuer)).toEqual(["Bank"]);
    await expectClean(w, "after the open"); // the damaged slot is overwritten
    expect(oldIds(w)).toEqual([]); // another vault's copies under a key nobody here has: dropped (GM2-4)
    expect(unlisted(w)).toEqual([]); // and their records removed, not just unlisted
    expect(newIds(w).length).toBeGreaterThan(0); // the new vault's own snapshot is there from the first save (P-6)
    expect(diags.some((m) => /^kept \d+ snapshot/.test(m))).toBe(false);
  });

  it("restoreBackup of the SAME vault over its lost remains: the copies nobody can open are kept (bounded by the limits), reported, and age out", async () => {
    const w: World = { kv: new MemoryKV(), mirror: new MemoryKV(), session: new MemorySession() };
    const lostId = await lostRemains(w, "vault-backup-01");
    const svc = svcOver(w);
    expect((await svc.status()).state).toBe("lost");

    const backup = addEntry(emptyVault(lostId), input("Bank"), createClock("bbbb", { now: () => t.now })).vault;
    await svc.restoreBackup(backup, await svc.prepareKeys(STRONG, { vaultId: lostId }));
    expect(w.kv.data.has(KEYS.keyChange)).toBe(true);
    const before = oldIds(w).length;
    expect(before).toBe(9); // (the new vault's first snapshot took one place)

    const diags: string[] = [];
    const v = await svcOver(w, w.kv, w.mirror, w.session, undefined, (m) => diags.push(m)).openView();
    expect(v.state === "unlocked" && aliveEntries(v.vault).map((e) => e.issuer)).toEqual(["Bank"]);
    await expectClean(w, "after the open");
    expect(oldIds(w).length).toBe(before); // all kept (A2-4): a keyring that opens them may come back
    expect(diags.some((m) => /^kept \d+ snapshot\(s\) under a key this vault does not know$/.test(m))).toBe(true);
    expect(newIds(w).length).toBeGreaterThan(0); // (P-6)
    // bounded: they age out under the normal limits as the new vault is used
    for (let i = 0; i < RETENTION_ROLLING; i++)
      await svcOver(w).mutate((x, c) => addEntry(x, input(`Mail${i}`), c).vault);
    expect(oldIds(w)).toEqual([]);
    expect(unlisted(w)).toEqual([]);
  });
});
