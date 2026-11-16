// M2's store changes (SYNC-DESIGN §3.13, §4.4, §4.6, I3; §0.0i req. 2, 8, 15 R1): transact's ensureCurrentSnapshot,
// afterCommit and event; the beforeRecoveryWrite hook at every recovery write and nowhere else (D1); the decrypt
// fallback's previous-VK candidates (re-encrypted to the current key, a key change), with GM2-7's read rule, A4R-3's
// mirror exception, the newer_schema stop (R1) and the "changed meanwhile" refusal.
import { describe, expect, it } from "vitest";
import { utf8 } from "../../src/core/crypto/bytes";
import { decryptVault, encryptVault, type EncryptedVault } from "../../src/core/crypto/envelope";
import { createKeyring, rekey, type Keyring } from "../../src/core/crypto/keyring";
import type { Vk } from "../../src/core/crypto/vk";
import {
  checkGeneration,
  checkSnapshot,
  KEYS,
  parseSnapshotIndex,
  type Generation,
} from "../../src/core/storage/format";
import { createMutex, MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultStore, type StoreOptions } from "../../src/core/storage/store";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { SyncStateStore } from "../../src/core/sync/local/state";
import { createClock } from "../../src/core/vault/hlc";
import { emptyVault, type Vault } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { deserializeVault, serializeVault } from "../../src/core/vault/validate";
import { input } from "../helpers/m2-world";

const t = { now: 1_700_000_000_000 };
const PW = "tulip-orbit-lantern-84";

/** A KV that logs every write's keys, in order, and can be told to fail or throw on a key. */
class LogKV implements KV {
  log: string[] = [];
  failOn: ((items: Record<string, unknown>) => boolean) | null = null;
  getFails: ((keys: string[]) => boolean) | null = null;
  constructor(readonly inner = new MemoryKV()) {}
  async get(k: string[]) {
    if (this.getFails?.(k)) throw new Error("IO error: transient");
    return this.inner.get(k);
  }
  async keys() {
    return this.inner.keys();
  }
  async set(items: Record<string, unknown>) {
    this.log.push(`set:${Object.keys(items).sort().join("+")}`);
    if (this.failOn?.(items)) throw new Error("IO error: write");
    await this.inner.set(items);
  }
  async remove(keys: string[]) {
    this.log.push(`rm:${keys.join("+")}`);
    await this.inner.remove(keys);
  }
}

async function vaultOf(
  names: string[],
  keyring: Keyring,
  vk: Vk,
  rev: number,
): Promise<{ vault: Vault; envelope: EncryptedVault }> {
  const c = createClock("aaaa", { now: () => t.now });
  let v = emptyVault(keyring.vaultId);
  for (const n of names) v = addEntry(v, input(n), c, { id: `entry-${n.toLowerCase().padEnd(8, "0")}` }).vault;
  return { vault: v, envelope: await encryptVault(serializeVault(v), vk, { vaultId: keyring.vaultId, rev }) };
}

function world(o: Partial<StoreOptions> = {}) {
  const kv = new LogKV();
  const mirror = new LogKV();
  const hooks: string[] = [];
  const lock = createMutex();
  const store = (extra: Partial<StoreOptions> = {}) =>
    new VaultStore({
      kv,
      mirror,
      lock,
      now: () => t.now,
      beforeRecoveryWrite: async () => {
        hooks.push(`hook@${kv.log.length}`);
        kv.log.push("HOOK");
      },
      ...o,
      ...extra,
    });
  return { kv, mirror, hooks, lock, store };
}
type W = ReturnType<typeof world>;

async function seeded(w: W, saves = 3) {
  const { keyring, vk } = await createKeyring();
  const s = w.store();
  for (let i = 1; i <= saves; i++) {
    t.now += 1000;
    const { envelope } = await vaultOf(["GitHub", "AWS", "Stripe"].slice(0, i), keyring, vk, i);
    await s.transact(async () => ({ envelope, keyring }));
  }
  w.kv.log = [];
  w.hooks.length = 0;
  return { keyring, vk, s };
}
const ptrOf = (w: W) => w.kv.inner.data.get(KEYS.active) as "a" | "b";
const other = (p: "a" | "b") => (p === "a" ? "b" : "a");
const activeGen = async (w: W) => (await checkGeneration(w.kv.inner.data.get(KEYS.slot[ptrOf(w)])))!;
const rolling = (w: W) =>
  parseSnapshotIndex(w.kv.inner.data.get(KEYS.snapIndex))
    .filter((m) => m.kind === "rolling")
    .sort((a, b) => b.seq - a.seq);

describe("transact: ensureCurrentSnapshot (§4.4 F11, §4.6)", () => {
  it("the state replaced is the newest rolling snapshot before the slot is written: added when missing, nothing when already there", async () => {
    const w = world();
    const { keyring, vk, s } = await seeded(w);
    const prev = await activeGen(w);
    expect((await checkSnapshot(w.kv.inner.data.get(KEYS.snap(rolling(w)[0]!.id))))!.envelope.checksum).toBe(
      prev.envelope.checksum,
    );
    const next = await vaultOf(["GitHub", "AWS", "Stripe", "Bank"], keyring, vk, 9);
    await s.transact(async () => ({ envelope: next.envelope, keyring }), { ensureCurrentSnapshot: true });
    expect(w.kv.log.filter((x) => x.includes("sk_snap_r"))).toHaveLength(1); // only the new generation's own snapshot
    // the newest rolling snapshot of the current state is gone (rotated out, or never written): it is put back first
    const cur = await activeGen(w);
    const id = rolling(w)[0]!.id;
    w.kv.inner.data.delete(KEYS.snap(id));
    w.kv.inner.data.set(
      KEYS.snapIndex,
      parseSnapshotIndex(w.kv.inner.data.get(KEYS.snapIndex)).filter((m) => m.id !== id),
    );
    w.kv.log = [];
    const third = await vaultOf(["GitHub"], keyring, vk, 10);
    w.kv.failOn = (i) => KEYS.slot.a in i || KEYS.slot.b in i; // dies at the slot write
    await expect(
      s.transact(async () => ({ envelope: third.envelope, keyring }), { ensureCurrentSnapshot: true }),
    ).rejects.toThrow("IO error");
    const snapWrite = w.kv.log.findIndex((x) => x.includes(`sk_snap_r${cur.seq}`));
    const slotWrite = w.kv.log.findIndex((x) => x.includes("sk_slot_"));
    expect(snapWrite).toBeGreaterThanOrEqual(0);
    expect(snapWrite).toBeLessThan(slotWrite);
    expect((await checkSnapshot(w.kv.inner.data.get(KEYS.snap(`r${cur.seq}`))))!.envelope.checksum).toBe(
      cur.envelope.checksum,
    );
  });
  it("a write that changes nothing adds no snapshot; a failure to make sure (an index read that throws) fails the write before anything is written", async () => {
    const w = world();
    const { keyring, vk, s } = await seeded(w);
    await s.transact(async (g) => ({ envelope: g!.envelope, keyring }), { ensureCurrentSnapshot: true });
    expect(w.kv.log.filter((x) => x.includes("sk_snap_"))).toEqual([]);
    w.kv.log = [];
    w.kv.getFails = (k) => k.includes(KEYS.snapIndex);
    const next = await vaultOf(["X"], keyring, vk, 77);
    await expect(
      s.transact(async () => ({ envelope: next.envelope, keyring }), { ensureCurrentSnapshot: true }),
    ).rejects.toThrow("IO error");
    expect(w.kv.log).toEqual([]);
  });
});

describe("transact: afterCommit and event (§4.7 D2, §4.13)", () => {
  it("afterCommit runs once, after the commit, inside the lock, with the committed generation; a throw from it does not fail the save", async () => {
    const diag: string[] = [];
    const w = world({ onDiag: (m) => diag.push(m) });
    const { keyring, vk, s } = await seeded(w);
    const next = await vaultOf(["A", "B"], keyring, vk, 20);
    let seen: Generation | null = null;
    let lockedOut = true;
    const g = await s.transact(async () => ({ envelope: next.envelope, keyring }), {
      afterCommit: async (gen) => {
        seen = gen;
        expect(w.kv.inner.data.get(KEYS.active)).toBe(ptrOf(w)); // committed
        expect((await activeGen(w)).envelope.checksum).toBe(next.envelope.checksum);
        // the lock is held: a section asked for now runs only after this one
        let ran = false;
        const other = w.lock(async () => {
          ran = true;
        });
        await new Promise((r) => setTimeout(r, 5));
        lockedOut = !ran;
        void other;
      },
    });
    expect(seen).toEqual(g);
    expect(lockedOut).toBe(true);
    const third = await vaultOf(["A"], keyring, vk, 21);
    await expect(
      s.transact(async () => ({ envelope: third.envelope, keyring }), {
        afterCommit: async () => {
          throw new Error("outbox broke");
        },
      }),
    ).resolves.toBeDefined();
    expect((await activeGen(w)).envelope.checksum).toBe(third.envelope.checksum);
    expect(diag).toContain("after commit failed");
  });
  it("not called when the commit fails; the event is recorded after the commit", async () => {
    const w = world();
    const { keyring, vk, s } = await seeded(w);
    const next = await vaultOf(["A"], keyring, vk, 30);
    let calls = 0;
    w.kv.failOn = (i) => KEYS.active in i;
    await expect(
      s.transact(async () => ({ envelope: next.envelope, keyring }), {
        afterCommit: async () => {
          calls++;
        },
      }),
    ).rejects.toThrow("IO error");
    expect(calls).toBe(0);
    w.kv.failOn = null;
    await s.transact(async () => ({ envelope: next.envelope, keyring }), {
      event: { kind: "cloud_restore", restoredTo: 5, detail: "restored from the cloud" },
    });
    expect(await s.listEvents()).toMatchObject([{ kind: "cloud_restore", restoredTo: 5 }]);
  });
});

describe("beforeRecoveryWrite: before every recovery write, inside the lock, and nowhere else (§3.13, D1)", () => {
  it("not for ordinary saves, healthy opens and self-checks, or redundancy heals (the mirror, the keyring copy, the other slot)", async () => {
    const w = world();
    const { keyring, vk, s } = await seeded(w);
    await s.transact(async () => ({ envelope: (await vaultOf(["Q"], keyring, vk, 40)).envelope, keyring }));
    await s.load();
    await s.loadView();
    await s.selfCheck();
    await s.openVault(vk);
    w.mirror.inner.data.delete(KEYS.mirrorGen);
    w.kv.inner.data.delete(KEYS.keyringCopy);
    w.kv.inner.data.set(KEYS.slot[other(ptrOf(w))], { torn: "x" });
    await s.selfCheck();
    expect(w.mirror.inner.data.has(KEYS.mirrorGen)).toBe(true); // healed
    expect(w.hooks).toEqual([]);
  });
  it("a damaged active slot: before the pointer moves", async () => {
    const w = world();
    const { s } = await seeded(w);
    w.kv.inner.data.set(KEYS.slot[ptrOf(w)], { torn: "x" });
    await s.load();
    expect(w.hooks).toHaveLength(1);
    expect(w.kv.log.indexOf("HOOK")).toBeLessThan(w.kv.log.indexOf("set:sk_active"));
  });
  it("a lost pointer write (a newer slot, same keyring): before the pointer moves to it", async () => {
    const w = world();
    const { s } = await seeded(w);
    w.kv.inner.data.set(KEYS.active, other(ptrOf(w)));
    await s.selfCheck();
    expect(w.hooks).toHaveLength(1);
    expect(w.kv.log.indexOf("HOOK")).toBeLessThan(w.kv.log.indexOf("set:sk_active"));
  });
  it("FIXa2: a key change that never committed is rolled back: before its slot is overwritten", async () => {
    const w = world();
    const { keyring, vk, s } = await seeded(w);
    const r = await rekey(keyring, vk, PW);
    const ptr = ptrOf(w);
    const plain = await decryptVault((await activeGen(w)).envelope, vk);
    const newer: Generation = {
      v: 1,
      seq: 99,
      savedAt: t.now,
      envelope: await encryptVault(plain, r.vk, { vaultId: keyring.vaultId, rev: 50 }),
      keyring: r.keyring,
    };
    w.kv.inner.data.set(KEYS.slot[other(ptr)], newer);
    await s.selfCheck();
    expect(ptrOf(w)).toBe(ptr);
    expect(w.hooks).toHaveLength(1);
    expect(w.kv.log.indexOf("HOOK")).toBeLessThan(w.kv.log.findIndex((x) => x.includes(KEYS.slot[other(ptr)])));
  });
  it("writeBoth (both slots lost, rebuilt from a snapshot): before the first slot write", async () => {
    const w = world();
    const { s } = await seeded(w);
    w.kv.inner.data.set(KEYS.slot.a, { torn: "x" });
    w.kv.inner.data.set(KEYS.slot.b, { torn: "x" });
    expect((await s.load()).status).toBe("ok");
    expect(w.hooks).toHaveLength(1);
    expect(w.kv.log.indexOf("HOOK")).toBeLessThan(w.kv.log.findIndex((x) => x.includes("sk_slot_a")));
  });
  it("the decrypt fallback's write, and a transact over lost data: before their first write", async () => {
    const w = world();
    const { keyring, vk, s } = await seeded(w);
    const act = await activeGen(w);
    w.kv.inner.data.set(KEYS.slot[ptrOf(w)], {
      ...act,
      envelope: await encryptVault(utf8("not a vault"), vk, { vaultId: keyring.vaultId, rev: act.envelope.rev }),
    });
    w.kv.log = [];
    const r = await s.openVault(vk);
    expect(r.recovered?.kind).toBe("decrypt_fallback");
    expect(w.hooks).toHaveLength(1);
    expect(w.kv.log.indexOf("HOOK")).toBeLessThan(w.kv.log.findIndex((x) => x.includes("sk_slot_")));
    // over lost data
    const v = world();
    await seeded(v);
    for (const k of [KEYS.slot.a, KEYS.slot.b, KEYS.keyringCopy]) v.kv.inner.data.set(k, { torn: "x" });
    v.mirror.inner.data.clear();
    for (const k of [...v.kv.inner.data.keys()].filter((x) => x.startsWith("sk_snap_"))) v.kv.inner.data.delete(k);
    const s2 = v.store();
    expect((await s2.load()).status).toBe("lost");
    v.hooks.length = 0;
    v.kv.log = [];
    const fresh = await createKeyring();
    await s2.transact(
      async () => ({ envelope: (await vaultOf([], fresh.keyring, fresh.vk, 0)).envelope, keyring: fresh.keyring }),
      { overwriteLost: true },
    );
    expect(v.hooks).toHaveLength(1);
    expect(v.kv.log.indexOf("HOOK")).toBeLessThan(v.kv.log.findIndex((x) => x.includes("sk_slot_")));
  });
  it("a hook that throws stops the recovery write: nothing moves, and the error goes to the caller", async () => {
    const w = world({
      beforeRecoveryWrite: async () => {
        throw new Error("state unreadable");
      },
    });
    const { s } = await seeded(w);
    const ptr = ptrOf(w);
    w.kv.inner.data.set(KEYS.slot[ptr], { torn: "x" });
    const before = JSON.stringify([...w.kv.inner.data]);
    await expect(s.load()).rejects.toThrow("state unreadable");
    expect(JSON.stringify([...w.kv.inner.data])).toBe(before);
  });
  it("wired to the sync state: lastSynced null and the outbox moved to the orphan list before the recovery writes anything (one write, D1 as revisions 19 and 20 have it)", async () => {
    const w = world();
    await seeded(w);
    const st = new SyncStateStore(w.kv);
    const synced = new VaultStore({
      kv: w.kv,
      mirror: w.mirror,
      lock: w.lock,
      now: () => t.now,
      beforeRecoveryWrite: () => st.recoveryHook(),
    });
    w.kv.inner.data.set(SYNC_KEYS.state, { v: 1, lastSynced: { version: 5, head: "h", checksum: "c" }, failures: 0 });
    w.kv.inner.data.set(SYNC_KEYS.outbox, { base: 5 });
    w.kv.inner.data.set(KEYS.slot[ptrOf(w)], { torn: "x" });
    w.kv.log = [];
    await synced.load();
    expect(w.kv.log[0]).toBe(`set:${[SYNC_KEYS.orphan, SYNC_KEYS.outbox, SYNC_KEYS.state].sort().join("+")}`);
    expect(w.kv.inner.data.get(SYNC_KEYS.state)).toEqual({ v: 1, lastSynced: null, failures: 0 });
    expect(w.kv.inner.data.get(SYNC_KEYS.outbox)).toBeNull();
    expect(w.kv.inner.data.get(SYNC_KEYS.orphan)).toEqual({ v: 1, items: [{ base: 5 }] }); // kept, unchanged (M3RR-3), appended to the list (rev. 20)
  });
  it("a transact over lost data: the hook runs before the caller's function, so a flow that clears its own sync state there finds the outbox already kept (M3, rev. 19 §4.7)", async () => {
    const v = world();
    await seeded(v);
    for (const k of [KEYS.slot.a, KEYS.slot.b, KEYS.keyringCopy]) v.kv.inner.data.set(k, { torn: "x" });
    v.mirror.inner.data.clear();
    for (const k of [...v.kv.inner.data.keys()].filter((x) => x.startsWith("sk_snap_"))) v.kv.inner.data.delete(k);
    const st = new SyncStateStore(v.kv);
    const synced = new VaultStore({
      kv: v.kv,
      mirror: v.mirror,
      lock: v.lock,
      now: () => t.now,
      beforeRecoveryWrite: () => st.recoveryHook(),
    });
    v.kv.inner.data.set(SYNC_KEYS.state, { v: 1, lastSynced: { version: 5, head: "h", checksum: "c" }, failures: 0 });
    v.kv.inner.data.set(SYNC_KEYS.outbox, { base: 5 });
    expect((await synced.load()).status).toBe("lost");
    const fresh = await createKeyring();
    const seen: unknown[] = [];
    await synced.transact(
      async () => {
        seen.push(v.kv.inner.data.get(SYNC_KEYS.orphan) ?? null);
        await st.clearLastSynced(); // the flow's own clear (the cloud restore's pins.begin): the live outbox only
        return { envelope: (await vaultOf([], fresh.keyring, fresh.vk, 0)).envelope, keyring: fresh.keyring };
      },
      { overwriteLost: true },
    );
    expect(seen).toEqual([{ v: 1, items: [{ base: 5 }] }]);
    expect(v.kv.inner.data.get(SYNC_KEYS.orphan)).toEqual({ v: 1, items: [{ base: 5 }] });
    // a function that throws over lost data: the hook has run (conservative: a full pull, the orphan kept), nothing written
    const w2 = world();
    await seeded(w2);
    for (const k of [KEYS.slot.a, KEYS.slot.b, KEYS.keyringCopy]) w2.kv.inner.data.set(k, { torn: "x" });
    w2.mirror.inner.data.clear();
    for (const k of [...w2.kv.inner.data.keys()].filter((x) => x.startsWith("sk_snap_"))) w2.kv.inner.data.delete(k);
    const s3 = w2.store();
    w2.hooks.length = 0;
    await expect(
      s3.transact(
        async () => {
          throw new Error("refused");
        },
        { overwriteLost: true },
      ),
    ).rejects.toThrow("refused");
    expect(w2.hooks).toHaveLength(1);
    expect((await s3.load()).status).toBe("lost");
  });
});

// ---- the decrypt fallback with previous-VK candidates (I3, §0.0i req. 2, 8; R1) -----------------------------------------

/**
 * A vault rotated from VK1 to VK2 whose cleanup never ran: the VK1 copies are still on disk (the other slot, the
 * snapshots). Then the active VK2 copy stops opening (it passes its checksum), and the VK2 rolling snapshot of that save
 * is gone, so the newest copy that opens is under VK1.
 */
async function rotatedThenBroken(o: { v2Candidate?: boolean; mirrorFails?: boolean } = {}) {
  const w = world();
  const { keyring, vk, s } = await seeded(w); // 3 saves under VK1: GitHub, AWS, Stripe
  const r = await rekey(keyring, vk, PW);
  const plain = await decryptVault((await activeGen(w)).envelope, vk);
  await s.transact(async () => ({
    envelope: await encryptVault(plain, r.vk, { vaultId: keyring.vaultId, rev: 4 }),
    keyring: r.keyring,
  })); // VK2, marker
  const act = await activeGen(w);
  w.kv.inner.data.set(KEYS.slot[ptrOf(w)], {
    ...act,
    envelope: await encryptVault(utf8("not a vault"), r.vk, { vaultId: keyring.vaultId, rev: 5 }),
  });
  w.kv.inner.data.delete(KEYS.snap(`r${act.seq}`));
  w.kv.inner.data.set(
    KEYS.snapIndex,
    parseSnapshotIndex(w.kv.inner.data.get(KEYS.snapIndex)).filter((m) => m.id !== `r${act.seq}`),
  );
  w.kv.inner.data.set(KEYS.slot[other(ptrOf(w))], { torn: "x" }); // the other slot is gone too: only snapshots are left
  w.mirror.inner.data.delete(KEYS.mirrorGen);
  if (o.v2Candidate) {
    // the newest VK1 snapshot holds a vault from a newer schema (R1): it must stop the fallback, not be passed over
    const newest = rolling(w)[0]!;
    const rec = w.kv.inner.data.get(KEYS.snap(newest.id)) as { envelope: EncryptedVault };
    rec.envelope = await encryptVault(
      utf8(JSON.stringify({ schemaVersion: 2, vaultId: keyring.vaultId, entries: [] })),
      vk,
      { vaultId: keyring.vaultId, rev: rec.envelope.rev },
    );
    w.kv.inner.data.set(KEYS.snap(newest.id), rec);
  }
  if (o.mirrorFails) w.mirror.getFails = () => true;
  w.kv.log = [];
  w.hooks.length = 0;
  return { w, s, vk1: vk, vk2: r.vk, keyring2: r.keyring, act };
}

describe("the decrypt fallback opens copies under a previous key (I3)", () => {
  it("the newest copy that opens is under VK1: restored re-encrypted to VK2 (same data, vault id and revision), as a key change (marker), with a notice and the hook", async () => {
    const { w, s, vk1, vk2, keyring2 } = await rotatedThenBroken();
    const snap = rolling(w)[0]!;
    const rec = (await checkSnapshot(w.kv.inner.data.get(KEYS.snap(snap.id))))!;
    expect(rec.envelope.vkId).toBe(vk1.id);
    w.kv.inner.data.delete(KEYS.keyChange); // as if the rotation's own marker had been cleared already
    const r = await s.openVault(vk2);
    expect(r.recovered?.kind).toBe("decrypt_fallback");
    expect(r.gen.envelope.vkId).toBe(vk2.id);
    expect(r.gen.keyring).toEqual(keyring2);
    expect(r.gen.envelope.rev).toBe(rec.envelope.rev);
    expect(deserializeVault(await decryptVault(r.gen.envelope, vk2))).toEqual(
      deserializeVault(await decryptVault(rec.envelope, vk1)),
    );
    expect(w.kv.inner.data.get(KEYS.keyChange)).toMatchObject({ v: 1, vkId: vk2.id }); // the VK1 snapshot is still there
    expect(w.hooks).toHaveLength(1);
    expect(
      (await w.store().loadView()).status === "ok" && ((await w.store().loadView()) as { cleanup: string }).cleanup,
    ).toBe("full");
  });
  it("R1: a newer schema in the active slot stops at once: newer_schema, no write, no event", async () => {
    const w = world();
    const { keyring, vk, s } = await seeded(w);
    const act = await activeGen(w);
    const future = await encryptVault(
      utf8(JSON.stringify({ schemaVersion: 2, vaultId: keyring.vaultId, entries: [] })),
      vk,
      { vaultId: keyring.vaultId, rev: 9 },
    );
    w.kv.inner.data.set(KEYS.slot[ptrOf(w)], { ...act, envelope: future });
    const before = JSON.stringify([...w.kv.inner.data]);
    w.kv.log = [];
    await expect(s.openVault(vk)).rejects.toMatchObject({ code: "newer_schema" });
    expect(w.kv.log).toEqual([]);
    expect(JSON.stringify([...w.kv.inner.data])).toBe(before);
    expect(await s.listEvents()).toEqual([]);
  });
  it("R1 among previous-VK candidates: the newest is from a newer schema; it stops there (no older v1 copy is restored over it), nothing written", async () => {
    const { w, s, vk2 } = await rotatedThenBroken({ v2Candidate: true });
    const before = JSON.stringify([...w.kv.inner.data]);
    await expect(s.openVault(vk2)).rejects.toMatchObject({ code: "newer_schema" });
    expect(w.kv.log).toEqual([]);
    expect(JSON.stringify([...w.kv.inner.data])).toBe(before);
    expect(w.hooks).toEqual([]);
  });
  it("GM2-7 still holds with previous-key candidates: a newer copy whose read throws is not passed over for an older VK1 one; nothing written", async () => {
    const { w, s, vk2 } = await rotatedThenBroken();
    const [newest, older] = rolling(w);
    expect(older).toBeDefined();
    w.kv.getFails = (k) => k.length === 1 && k[0] === KEYS.snap(newest!.id);
    await expect(s.openVault(vk2)).rejects.toThrow("IO error");
    expect(w.kv.log).toEqual([]);
    // an unreadable local index hides every snapshot: nothing is restored either
    w.kv.getFails = (k) => k.length === 1 && k[0] === KEYS.snapIndex;
    await expect(s.openVault(vk2)).rejects.toThrow();
    expect(w.kv.log).toEqual([]);
  });
  it("A4R-3 still holds: a mirror that always fails counts as the active slot's save, so the older VK1 snapshot is restored", async () => {
    const { w, s, vk2 } = await rotatedThenBroken({ mirrorFails: true });
    // the newest VK1 snapshot has the active slot's counter minus one: a mirror source of unknown age counts as the
    // active slot's save, which is newer, so the open fails (the remaining A4R-3 case) ...
    await expect(s.openVault(vk2)).rejects.toThrow("IO error");
    // ... unless the copy that opens is of the active slot's own save: give it that counter
    const act = await activeGen(w);
    const snap = rolling(w)[0]!;
    const rec = w.kv.inner.data.get(KEYS.snap(snap.id)) as { meta: { seq: number } };
    w.kv.inner.data.set(KEYS.snap(snap.id), { ...rec, meta: { ...rec.meta, seq: act.seq } });
    w.kv.inner.data.set(
      KEYS.snapIndex,
      parseSnapshotIndex(w.kv.inner.data.get(KEYS.snapIndex)).map((m) =>
        m.id === snap.id ? { ...m, seq: act.seq } : m,
      ),
    );
    const r = await s.openVault(vk2);
    expect(r.recovered?.kind).toBe("decrypt_fallback");
  });
  it("a copy of another vault under a previous key is never a fallback; neither is one under a key the keyring does not list", async () => {
    const { w, s, vk1, vk2 } = await rotatedThenBroken();
    for (const m of parseSnapshotIndex(w.kv.inner.data.get(KEYS.snapIndex))) {
      const rec = w.kv.inner.data.get(KEYS.snap(m.id)) as { envelope: EncryptedVault };
      const plain = await decryptVault(rec.envelope, vk1).catch(() => null);
      if (!plain) continue;
      rec.envelope = await encryptVault(plain, vk1, { vaultId: "another-vault-01", rev: rec.envelope.rev }); // another vault id
      w.kv.inner.data.set(KEYS.snap(m.id), rec);
    }
    await expect(s.openVault(vk2)).rejects.toThrow("no stored copy could be opened");
    expect(w.kv.log).toEqual([]);
  });
  it("the active copy changed since it was read (another page saved meanwhile): the fallback writes nothing over it", async () => {
    const { w, s, vk2, act } = await rotatedThenBroken();
    const stale = { ...act, envelope: (await activeGen(w)).envelope };
    const good = await encryptVault(utf8(JSON.stringify(emptyVault(act.keyring.vaultId))), vk2, {
      vaultId: act.keyring.vaultId,
      rev: 77,
    });
    w.kv.inner.data.set(KEYS.slot[ptrOf(w)], { ...act, envelope: good }); // a good save landed after the caller read `stale`
    await expect(s.openVault(vk2, stale)).rejects.toThrow();
    expect((await activeGen(w)).envelope.checksum).toBe(good.checksum);
  });
});
