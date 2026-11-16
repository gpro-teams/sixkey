// The M2 re-review's probes (docs/audit/internal-reviews/M2-REREVIEW.md, appendix), each turned into a regression test of the fix: RR-1 (a
// capability is bound to the local keyring M1 judged), RR-2 (it carries M1's own frozen copy), RR-3 (turning sync off
// takes the vault lock; a pending pin copy is bound to its identity), RR-4 (the order of pin writes), RR-5 (sk_prejoin's
// own-retry exception compares the plaintext); RR-6 pins the residual the design keeps (M2-NOTES §4.2); and one test per
// mutant RR-8 found surviving (Q09, Q10, Q11, Q13, Q14, Q17, Q19, Q20, Q21, Q36).
import { describe, expect, it } from "vitest";
import { decryptVault } from "../../src/core/crypto/envelope";
import { setPassword, unlockWithPassword, unlockWithRecoveryCode, type Keyring } from "../../src/core/crypto/keyring";
import { KEYS } from "../../src/core/storage/format";
import { MemoryKV, type KV } from "../../src/core/storage/kv";
import { SecurityLog } from "../../src/core/service/security-log";
import { evaluateSameVkBundle, unlockWithSync } from "../../src/core/sync/crypto/bundle-eval";
import { keysOf } from "../../src/core/sync/crypto/capability";
import { adoptedRecord } from "../../src/core/sync/crypto/keybundle";
import type { DeviceIdentity } from "../../src/core/sync/local/identity";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { canonicalJson } from "../../src/core/vault/merge";
import { aliveEntries, emptyVault } from "../../src/core/vault/model";
import { deleteEntry } from "../../src/core/vault/ops";
import { deserializeVault } from "../../src/core/vault/validate";
import {
  adoptByUnlock,
  adoptSameVk,
  bundleFor,
  factsOf,
  m2World,
  markSyncOn,
  newCode,
  newIdentity,
  publishedOf,
  rotated,
  steadyState,
  vaultWith,
  type M2World,
} from "../helpers/m2-world";
import { createProtected, STRONG } from "../helpers/vaults";

const PW2 = "granite-river-compass-31";
const opensCode = (k: Keyring, c: string) =>
  unlockWithRecoveryCode(k, c).then(
    () => true,
    () => false,
  );
const opensPw = (k: Keyring, p: string) =>
  unlockWithPassword(k, p).then(
    () => true,
    () => false,
  );
const copyOf = (m: MemoryKV) => {
  const n = new MemoryKV();
  for (const [k, v] of m.data) n.data.set(k, structuredClone(v));
  return n;
};
const restore = (into: MemoryKV, from: MemoryKV) => {
  into.data.clear();
  for (const [k, v] of from.data) into.data.set(k, structuredClone(v));
};
const dump = (m: MemoryKV) => JSON.stringify([...m.data]);
const pinsOf = async (w: M2World) => (await w.local().identity.get()) as DeviceIdentity;
const factsFrom = (p: DeviceIdentity) => ({
  maxSeenKver: p.maxSeenKver,
  expectedVaultId: p.vaultId!,
  adoptedAuth: p.adopted!.auth,
  adoptedDigest: p.adopted!.digest,
});
const stateOf = (w: M2World) =>
  w.kv.data.get(SYNC_KEYS.state) as { pendingPins?: { maxSeenKver: number; deviceId: string | null } } | undefined;
const tick = () => new Promise((r) => setTimeout(r, 1));
/** IndexedDB that reads but cannot write. */
class NoWriteKV implements KV {
  constructor(private inner: MemoryKV) {}
  get(k: string[]) {
    return this.inner.get(k);
  }
  keys() {
    return this.inner.keys();
  }
  async set(): Promise<void> {
    throw new Error("IndexedDB: Internal error");
  }
  async remove(): Promise<void> {
    throw new Error("IndexedDB: Internal error");
  }
}

/** Enrolled, in its steady state at B5. */
async function device() {
  const w = m2World();
  const { recoveryCode } = await vaultWith(w, ["GitHub", "AWS"], { syncOn: true });
  const st = await steadyState(w, 5);
  return { w, ...st, B5: st.bundle, recoveryCode };
}

describe("RR-1: a capability is committed only over the local keyring M1 judged (or its own, landed)", () => {
  it("an R2 adoption issued before this device's own new recovery code, committed after it: refused as stale, nothing written; the new code still opens and the server's bundle is in sync", async () => {
    const { w, vk, B5 } = await device();
    const g5 = await w.active();
    const r6 = await newCode(g5.keyring, vk);
    const B6 = await bundleFor(vk, r6.keyring, 6, B5.auth);
    const c6 = await adoptSameVk({
      ...(await factsOf(w.local(), g5.keyring.vaultId)),
      bundle: B6,
      vk,
      local: g5.keyring,
    });
    const r7 = await newCode(B6.keyring, vk);
    const B7 = await bundleFor(vk, r7.keyring, 7, B6.auth);
    const p7 = await publishedOf({
      server: B6,
      local: g5.keyring,
      vk,
      op: "change_recovery",
      sent: B7,
      sentVk: vk,
      sentSecret: { recoveryCode: r7.recoveryCode },
      facts: { maxSeenKver: 5, adoptedAuth: B5.auth, adoptedDigest: (await adoptedRecord(B5)).digest },
    });
    await w.flows().commitKeys({ keys: p7, record: "recovery_code_new" });
    const before = dump(w.kv);
    await expect(w.flows().commitKeys({ keys: c6, record: "keys_adopted" })).rejects.toMatchObject({
      code: "bad_state",
      message: "stale",
    });
    expect(dump(w.kv)).toBe(before);
    const g = await w.active();
    expect(canonicalJson(g.keyring)).toBe(canonicalJson(B7.keyring));
    expect(await opensCode(g.keyring, r7.recoveryCode)).toBe(true);
    const pins = (await w.local().settlePins()) as DeviceIdentity;
    expect(await evaluateSameVkBundle({ ...factsFrom(pins), bundle: B7, vk, local: g.keyring })).toEqual({
      kind: "in_sync",
      maxSeenKver: 7,
    });
  }, 60_000);

  it("a Published replayed after a later Published: refused as stale; the later password change stands. The landed retry of the later one is accepted", async () => {
    const { w, vk, B5 } = await device();
    const g5 = await w.active();
    const r6 = await newCode(g5.keyring, vk);
    const B6 = await bundleFor(vk, r6.keyring, 6, B5.auth);
    const p6 = await publishedOf({
      server: B5,
      local: g5.keyring,
      vk,
      op: "change_recovery",
      sent: B6,
      sentVk: vk,
      sentSecret: { recoveryCode: r6.recoveryCode },
    });
    await w.flows().commitKeys({ keys: p6 });
    const g6 = await w.active();
    const B7 = await bundleFor(vk, await setPassword(g6.keyring, vk, PW2), 7);
    const p7 = await publishedOf({
      server: B6,
      local: g6.keyring,
      vk,
      op: "change_password",
      sent: B7,
      sentVk: vk,
      sentSecret: { password: PW2 },
    });
    await w.flows().commitKeys({ keys: p7 });
    await expect(w.flows().commitKeys({ keys: p6 })).rejects.toMatchObject({ code: "bad_state", message: "stale" });
    expect(await opensPw((await w.active()).keyring, PW2)).toBe(true);
    await w.flows().commitKeys({ keys: p7 }); // a retry of the commit that is there: fine
    expect(canonicalJson((await w.active()).keyring)).toBe(canonicalJson(B7.keyring));
  }, 60_000);

  it("a cloud restore takes only an adoption M1 made with no local keyring: one made over a keyring that is lost now is stale", async () => {
    const { w, vk, B5 } = await device();
    const g5 = await w.active();
    const remote = deserializeVault(await decryptVault(g5.envelope, vk));
    const B6 = await bundleFor(vk, (await newCode(g5.keyring, vk)).keyring, 6, B5.auth);
    const facts = await factsOf(w.local(), g5.keyring.vaultId);
    const overLocal = await adoptByUnlock({
      ...facts,
      secret: { password: STRONG },
      local: g5.keyring,
      remote: B6,
      needsPassword: true,
    });
    expect(keysOf(overLocal)!.base).toEqual(g5.keyring);
    // and the other way round: an adoption M1 made with no local keyring is stale over the readable vault that is here
    const noLocal = await adoptByUnlock({
      ...facts,
      secret: { password: STRONG },
      local: null,
      remote: B6,
      needsPassword: false,
    });
    await expect(w.flows().commitKeys({ keys: noLocal })).rejects.toMatchObject({
      code: "bad_state",
      message: "stale",
    });
    for (const k of [KEYS.slot.a, KEYS.slot.b, KEYS.keyringCopy]) w.kv.data.set(k, { torn: "x" });
    w.mirror.data.clear();
    for (const k of [...w.kv.data.keys()].filter((x) => x.startsWith("sk_snap_"))) w.kv.data.delete(k);
    await expect(w.flows().commitKeys({ keys: overLocal, remote, overLost: true })).rejects.toMatchObject({
      code: "bad_state",
      message: "stale",
    });
    const keys = await adoptByUnlock({
      ...facts,
      secret: { password: STRONG },
      local: null,
      remote: B6,
      needsPassword: false,
    });
    expect(keysOf(keys)!.base).toBeNull();
    await w.flows().commitKeys({ keys, remote, overLost: true });
    expect(canonicalJson((await w.active()).keyring)).toBe(canonicalJson(B6.keyring));
  }, 60_000);
});

describe("RR-2: a capability carries M1's own copy, frozen", () => {
  it("the caller's bundle object changed after the verdict changes nothing: the keyring M1 evaluated is the one written; the copy cannot be changed", async () => {
    const { w, vk } = await device();
    const g5 = await w.active();
    const B6 = await bundleFor(vk, await setPassword(g5.keyring, vk, PW2), 6);
    const evaluated = structuredClone(B6.keyring);
    const keys = await adoptByUnlock({
      ...(await factsOf(w.local(), g5.keyring.vaultId)),
      secret: { password: PW2 },
      local: g5.keyring,
      remote: B6,
      needsPassword: false,
    });
    for (const wrap of B6.keyring.wraps)
      (wrap as { wrapped: string }).wrapped = (wrap.wrapped[0] === "A" ? "B" : "A") + wrap.wrapped.slice(1);
    if (keys.kind === "adopt" && "vk" in keys) keys.vk.raw.fill(0); // the VK the caller was handed, wiped after the verdict
    const carried = keysOf(keys)!;
    expect(
      Object.isFrozen(carried.bundle) &&
        Object.isFrozen(carried.bundle.keyring) &&
        Object.isFrozen(carried.bundle.keyring.wraps[0]),
    ).toBe(true);
    expect(() => {
      (carried.bundle.keyring.wraps[0] as { wrapped: string }).wrapped = "x";
    }).toThrow();
    await w.flows().commitKeys({ keys, record: "keys_adopted" });
    const g = await w.active();
    expect(canonicalJson(g.keyring)).toBe(canonicalJson(evaluated));
    expect(await opensPw(g.keyring, PW2)).toBe(true);
    const opened = await unlockWithPassword(g.keyring, PW2);
    expect(deserializeVault(await decryptVault(g.envelope, opened)).entries.length).toBeGreaterThan(0); // the data under the real key
  }, 60_000);

  it("the brand: a structured clone, a copy, a prototype child or a proxy of an issued adoption is refused; the original is accepted", async () => {
    const { w, vk, B5 } = await device();
    const g5 = await w.active();
    const B6 = await bundleFor(vk, (await newCode(g5.keyring, vk)).keyring, 6, B5.auth);
    const keys = await adoptSameVk({
      ...(await factsOf(w.local(), g5.keyring.vaultId)),
      bundle: B6,
      vk,
      local: g5.keyring,
    });
    for (const fake of [structuredClone({ ...keys }), { ...keys }, Object.create(keys), new Proxy(keys, {})]) {
      await expect(w.flows().commitKeys({ keys: fake as never })).rejects.toMatchObject({ code: "bad_state" });
    }
    expect(Object.isFrozen(keys)).toBe(true);
    await w.flows().commitKeys({ keys });
  }, 60_000);
});

describe("RR-3: turning sync off under the vault lock; a pending pin copy bound to its identity", () => {
  it("turnOff racing a key commit in another context waits for it, then removes everything: off, no pending copy; a commit that starts after it leaves a copy no later identity takes", async () => {
    const { w, vk, B5 } = await device();
    const g5 = await w.active();
    const r6 = await newCode(g5.keyring, vk);
    const B6 = await bundleFor(vk, r6.keyring, 6, B5.auth);
    const p6 = await publishedOf({
      server: B5,
      local: g5.keyring,
      vk,
      op: "change_recovery",
      sent: B6,
      sentVk: vk,
      sentSecret: { recoveryCode: r6.recoveryCode },
    });
    let gateOpen!: () => void;
    const gate = new Promise<void>((r) => {
      gateOpen = r;
    });
    let waited = false;
    const slow: KV = {
      get: async (k) => {
        if (!waited && k.includes(SYNC_KEYS.state) && k.includes(SYNC_KEYS.outbox)) {
          waited = true;
          await gate;
        }
        return w.kv.get(k);
      },
      keys: () => w.kv.keys(),
      set: (i) => w.kv.set(i),
      remove: (k) => w.kv.remove(k),
    };
    const committing = w.flows(w.svc(slow), w.local(slow)).commitKeys({ keys: p6 });
    while (!waited) await tick();
    const off = w.flows().turnOffSync(); // the settings page: waits for the vault lock
    await tick();
    gateOpen();
    await committing;
    await off;
    expect((await w.local().status()).kind).toBe("off");
    expect(w.kv.data.has(SYNC_KEYS.state)).toBe(false);
    // a commit whose transact runs after sync was turned off: its copy is for no identity
    const g6 = await w.active();
    const r7 = await newCode(g6.keyring, vk);
    const B7 = await bundleFor(vk, r7.keyring, 7, B6.auth);
    await w.flows().commitKeys({
      keys: await publishedOf({
        server: B6,
        local: g6.keyring,
        vk,
        op: "change_recovery",
        sent: B7,
        sentVk: vk,
        sentSecret: { recoveryCode: r7.recoveryCode },
        facts: { maxSeenKver: 6, adoptedAuth: B6.auth, adoptedDigest: (await adoptedRecord(B6)).digest },
      }),
    });
    expect(stateOf(w)!.pendingPins).toMatchObject({ maxSeenKver: 7, deviceId: null });
    // the next enrolment's fresh identity (§3.1 step 5) is not settled onto it
    const { id } = await newIdentity();
    await w.local().identity.put(id);
    expect(await w.local().status()).toMatchObject({
      kind: "cfg_missing",
      identity: { deviceId: id.deviceId, vkId: null, maxSeenKver: 0, adopted: null },
    });
    expect(stateOf(w)!.pendingPins).toBeUndefined();
  }, 60_000);

  it("RR-3b: a join racing 'turn sync off' completes first; turnOff then removes its copy and identity: off, and nothing is restored; a join after turnOff (no identity) is refused", async () => {
    const w = m2World();
    await vaultWith(w, ["Mine"]);
    await w.svc().openView();
    const { id, jwk } = await newIdentity();
    await w.local().identity.put(id);
    const device = { deviceId: id.deviceId, apiOrigin: id.apiOrigin, dsk: jwk, email: "" };
    const cw = m2World();
    await vaultWith(cw, ["CloudA"]);
    const cvk = await cw.sessionVk();
    const remote = deserializeVault(await decryptVault((await cw.active()).envelope, cvk));
    const bundle = await bundleFor(cvk, (await cw.active()).keyring, 4);
    const p = await w.flows().prepareJoin({ bundle, vk: cvk, remote, device });
    let gateOpen!: () => void;
    const gate = new Promise<void>((r) => {
      gateOpen = r;
    });
    let waiting = false;
    const slow: KV = {
      get: (k) => w.kv.get(k),
      keys: () => w.kv.keys(),
      remove: (k) => w.kv.remove(k),
      set: async (i) => {
        if (!waiting && SYNC_KEYS.prejoin in i) {
          waiting = true;
          await gate;
        }
        await w.kv.set(i);
      },
    };
    const joining = w.flows(w.svc(slow), w.local(slow)).commitJoin(p);
    while (!waiting) await tick();
    const off = w.flows().turnOffSync();
    await tick();
    gateOpen();
    await joining;
    await off;
    expect((await w.local().status()).kind).toBe("off");
    await expect(w.flows().restoreSyncIdentity()).rejects.toThrow();
    // prepared, then sync turned off (the identity removed), then committed: refused, nothing written
    const v = m2World();
    await vaultWith(v, ["Mine"]);
    await v.svc().openView();
    const { id: id2, jwk: jwk2 } = await newIdentity();
    await v.local().identity.put(id2);
    const p2 = await v.flows().prepareJoin({
      bundle,
      vk: cvk,
      remote,
      device: { deviceId: id2.deviceId, apiOrigin: id2.apiOrigin, dsk: jwk2, email: "" },
    });
    await v.flows().turnOffSync();
    const before = dump(v.kv);
    await expect(v.flows().commitJoin(p2)).rejects.toMatchObject({ code: "bad_state" });
    expect(dump(v.kv)).toBe(before);
  }, 120_000);
});

describe("RR-4: the order of pin writes", () => {
  it("commit A pinned, commit B at the same maxSeenKver pinned, storage.local's tail lost back to A's pending copy: the settle keeps B (it was moved back to A); B's own copy carries the capability's maxSeenKver, not the bundle's (Q36)", async () => {
    const { w, vk, B5 } = await device();
    const g5 = await w.active();
    const r6 = await newCode(g5.keyring, vk);
    const A = await bundleFor(vk, r6.keyring, 6, B5.auth);
    await w.flows().commitKeys({
      keys: await adoptSameVk({
        ...(await factsOf(w.local(), g5.keyring.vaultId)),
        bundle: A,
        vk,
        local: g5.keyring,
      }),
    });
    const pendA = {
      vkId: vk.id,
      vaultId: g5.keyring.vaultId,
      maxSeenKver: 6,
      adopted: await adoptedRecord(A),
      deviceId: (await pinsOf(w)).deviceId,
      prev: 0,
    };
    const tail = copyOf(w.kv);
    tail.data.set(SYNC_KEYS.state, { ...(tail.data.get(SYNC_KEYS.state) as object), pendingPins: pendA });
    // B: the server went back to B5 and the user confirmed the older state (R3, kver 5 under maxSeenKver 6)
    const gA = await w.active();
    const facts = await factsOf(w.local(), gA.keyring.vaultId);
    const ask = await unlockWithSync({
      ...facts,
      secret: { password: STRONG },
      local: gA.keyring,
      remote: B5,
      needsPassword: true,
    });
    expect(ask.kind).toBe("confirm_older");
    const keysB = await adoptByUnlock({
      ...facts,
      secret: { password: STRONG },
      local: gA.keyring,
      remote: B5,
      needsPassword: true,
      confirmedOlder: true,
    });
    await w.flows(w.svc(), w.local(w.kv, new NoWriteKV(w.idb))).commitKeys({ keys: keysB }); // its IndexedDB write lost
    expect(stateOf(w)!.pendingPins!.maxSeenKver).toBe(6); // the capability's, which bundle.kver (5) is not
    expect(await w.local().settlePins()).toMatchObject({ maxSeenKver: 6, adopted: await adoptedRecord(B5) }); // caught up
    restore(w.kv, tail); // the tail loss: A's copy again
    const settled = (await w.local().settlePins()) as DeviceIdentity;
    expect(settled.adopted!.digest).toBe((await adoptedRecord(B5)).digest);
    expect((await pinsOf(w)).adopted!.digest).toBe((await adoptedRecord(B5)).digest);
  }, 60_000);
});

describe("sk_prejoin's own-retry exception is the very same record", () => {
  it("an earlier completed join's sk_prejoin is kept when, after a backup of that vault was restored, the same cloud is joined again; the new join adds its own", async () => {
    const w = m2World();
    await vaultWith(w, ["Mine", "Trashed"]);
    await w.svc().mutate((v, c) => deleteEntry(v, aliveEntries(v).find((e) => e.issuer === "Trashed")!.id, c));
    await w.svc().openView();
    const v0 = (await w.active()).keyring.vaultId;
    const { id, jwk } = await newIdentity();
    await w.local().identity.put(id);
    const cw = m2World();
    await vaultWith(cw, ["CloudA"]);
    const cvk = await cw.sessionVk();
    const remote = deserializeVault(await decryptVault((await cw.active()).envelope, cvk));
    const bundle = await bundleFor(cvk, (await cw.active()).keyring, 4);
    await w.flows().commitJoin(
      await w.flows().prepareJoin({
        bundle,
        vk: cvk,
        remote,
        device: { deviceId: id.deviceId, apiOrigin: id.apiOrigin, dsk: jwk, email: "" },
      }),
    );
    const first = structuredClone(w.kv.data.get(SYNC_KEYS.prejoin)) as { items: unknown[] };
    await w.flows().turnOffSync();
    for (const k of [KEYS.slot.a, KEYS.slot.b, KEYS.keyringCopy]) w.kv.data.set(k, { torn: "x" });
    w.mirror.data.clear();
    for (const k of [...w.kv.data.keys()].filter((x) => x.startsWith("sk_snap_"))) w.kv.data.delete(k);
    const s = w.svc();
    await s.restoreBackup(emptyVault(v0), await s.prepareKeys(STRONG, { vaultId: v0 }));
    const { id: id2, jwk: jwk2 } = await newIdentity();
    await w.local().identity.put(id2);
    await w.flows().commitJoin(
      await w.flows().prepareJoin({
        bundle,
        vk: cvk,
        remote,
        device: { deviceId: id2.deviceId, apiOrigin: id2.apiOrigin, dsk: jwk2, email: "" },
      }),
    );
    const after = w.kv.data.get(SYNC_KEYS.prejoin) as { items: unknown[] };
    expect(after.items).toHaveLength(2); // a different plaintext (the restored backup): not the earlier join's own retry
    expect(after.items[0]).toEqual(first.items[0]);
  }, 120_000);

  it("a damaged sk_prejoin is kept as an entry, and the join adds its own beside it", async () => {
    const w = m2World();
    await vaultWith(w, ["Mine"]);
    await w.svc().openView();
    const { id, jwk } = await newIdentity();
    await w.local().identity.put(id);
    const cw = m2World();
    await vaultWith(cw, ["CloudA"]);
    const cvk = await cw.sessionVk();
    const remote = deserializeVault(await decryptVault((await cw.active()).envelope, cvk));
    const bundle = await bundleFor(cvk, (await cw.active()).keyring, 4);
    const damaged = { v: 1, at: 1, envelope: { damaged: true } };
    w.kv.data.set(SYNC_KEYS.prejoin, structuredClone(damaged));
    await w.flows().commitJoin(
      await w.flows().prepareJoin({
        bundle,
        vk: cvk,
        remote,
        device: { deviceId: id.deviceId, apiOrigin: id.apiOrigin, dsk: jwk, email: "" },
      }),
    );
    const after = w.kv.data.get(SYNC_KEYS.prejoin) as { items: unknown[] };
    expect(after.items).toHaveLength(2);
    expect(after.items[0]).toEqual(damaged);
  }, 60_000);

  it("Q14: the join refuses the joining device's own identity when it is pinned to another vault", async () => {
    const { w } = await device(); // this identity is pinned to this profile's vault
    const id = await pinsOf(w);
    const cw = m2World();
    await vaultWith(cw, ["CloudA"]);
    const cvk = await cw.sessionVk();
    const remote = deserializeVault(await decryptVault((await cw.active()).envelope, cvk));
    const bundle = await bundleFor(cvk, (await cw.active()).keyring, 4);
    const { jwk } = await newIdentity();
    const p = await w.flows().prepareJoin({
      bundle,
      vk: cvk,
      remote,
      device: { deviceId: id.deviceId, apiOrigin: id.apiOrigin, dsk: jwk, email: "" },
    });
    const before = dump(w.kv);
    await expect(w.flows().commitJoin(p)).rejects.toMatchObject({ code: "bad_state" });
    expect(dump(w.kv)).toBe(before);
  }, 120_000);
});

describe("RR-6 (a residual the design keeps, M2-NOTES §4.2): adopted_back trusts the identity in IndexedDB", () => {
  it("IndexedDB alone rolled back to its kver-5 state while storage.local holds kver 7, and the server replays B5: M1 adopts it back, and commitKeys writes it (no stored-state check can tell this from GM2-5 without changing M1's AdoptedRecord)", async () => {
    const { w, vk, B5 } = await device();
    const oldIdb = copyOf(w.idb);
    const g5 = await w.active();
    const r6 = await newCode(g5.keyring, vk);
    const B6 = await bundleFor(vk, r6.keyring, 6, B5.auth);
    await w.flows().commitKeys({
      keys: await publishedOf({
        server: B5,
        local: g5.keyring,
        vk,
        op: "change_recovery",
        sent: B6,
        sentVk: vk,
        sentSecret: { recoveryCode: r6.recoveryCode },
      }),
    });
    const g6 = await w.active();
    const B7 = await bundleFor(vk, await setPassword(g6.keyring, vk, PW2), 7);
    await w.flows().commitKeys({
      keys: await publishedOf({
        server: B6,
        local: g6.keyring,
        vk,
        op: "change_password",
        sent: B7,
        sentVk: vk,
        sentSecret: { password: PW2 },
      }),
    });
    restore(w.idb, oldIdb);
    const g7 = await w.active();
    const facts = factsFrom((await w.local().settlePins()) as DeviceIdentity);
    const v = await evaluateSameVkBundle({ ...facts, bundle: B5, vk, local: g7.keyring });
    expect(v.kind).toBe("adopt");
    await w.flows().commitKeys({ keys: v as never });
    expect(canonicalJson((await w.active()).keyring)).toBe(canonicalJson(B5.keyring));
  }, 60_000);
});

describe("RR-8: the mutants the re-review left alive", () => {
  it("Q09: published() refuses a rotation whose keyring the secret given does not open", async () => {
    const { w, vk, B5 } = await device();
    const g5 = await w.active();
    const r = await rotated(g5.keyring, vk);
    const other = await rotated(g5.keyring, vk);
    await expect(
      publishedOf({
        server: B5,
        local: g5.keyring,
        vk,
        op: "rotate",
        sent: await bundleFor(r.vk, r.keyring, 6),
        sentVk: r.vk,
        sentSecret: { recoveryCode: other.recoveryCode },
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  }, 60_000);

  it("Q10: changePassword's check is inside its transact: sync turned on while it waits for the lock still refuses it", async () => {
    const w = m2World();
    await createProtected(w.svc());
    const before = canonicalJson((await w.active()).keyring);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const holding = w.store().transact(async (cur) => {
      await held;
      return { envelope: cur!.envelope, keyring: cur!.keyring };
    });
    const change = w.svc().changePassword(STRONG, PW2);
    await tick();
    markSyncOn(w.kv);
    release();
    await holding;
    await expect(change).rejects.toMatchObject({ code: "sync_on" });
    expect(canonicalJson((await w.active()).keyring)).toBe(before);
  }, 60_000);

  it("Q11: prepareReset with sync on refuses before the code is checked: a wrong code is not recorded as recovery_failed", async () => {
    const w = m2World();
    const log = new SecurityLog({ kv: w.kv, now: () => w.t.now });
    await createProtected(w.svc(w.kv, w.mirror, w.session, { security: log }));
    markSyncOn(w.kv);
    const n = (await log.read()).entries.length;
    await expect(
      w.svc(w.kv, w.mirror, w.session, { security: log }).prepareReset("0000-0000-0000-0000-0000-0000-00VM", PW2),
    ).rejects.toMatchObject({ code: "sync_on" });
    expect((await log.read()).entries).toHaveLength(n);
  }, 60_000);

  it("Q19: a reset that landed before sync was turned on, retried after: it counts as done (not sync_on)", async () => {
    const w = m2World();
    const { recoveryCode } = await createProtected(w.svc());
    const p = await w.svc().prepareReset(recoveryCode, PW2);
    let pointer = false;
    let backFails = false;
    const kv: KV = {
      get: (k) => w.kv.get(k),
      keys: () => w.kv.keys(),
      remove: (k) => w.kv.remove(k),
      set: async (i) => {
        if (backFails && (KEYS.slot.a in i || KEYS.slot.b in i)) {
          backFails = false;
          throw new Error("IO error");
        }
        await w.kv.set(i);
        if (!pointer && KEYS.active in i) {
          pointer = true;
          backFails = true;
          throw new Error("IO error after the write");
        }
      },
    };
    await expect(w.svc(kv).commitReset(p)).rejects.toThrow("IO error after the write");
    expect(await opensPw((await w.active()).keyring, PW2)).toBe(true); // it landed
    markSyncOn(w.kv);
    await w.svc().commitReset(p);
  }, 60_000);

  it("Q13: the restore re-checks under the identity lock that the copy is still the same device's", async () => {
    const { w, vk, identity, jwk } = await device();
    await w.local().cfg.write(vk, { deviceId: identity.deviceId, apiOrigin: identity.apiOrigin, dsk: jwk, email: "" });
    await w.local().identity.remove();
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: KV = {
      get: async (k: string[]) => {
        const v = await w.kv.get(k);
        if (k.length === 1 && k[0] === SYNC_KEYS.cfg && ++n === 2) await gate;
        return v;
      },
      keys: () => w.kv.keys(),
      set: (i) => w.kv.set(i),
      remove: (k) => w.kv.remove(k),
    };
    const restoring = w.local(slow, w.idb).restoreIdentity(vk, (await w.active()).keyring);
    while (n < 2) await tick();
    const { id: other, jwk: jwk2 } = await newIdentity(); // another device's copy replaces it meanwhile (a new enrolment)
    await w.local().cfg.write(vk, { deviceId: other.deviceId, apiOrigin: other.apiOrigin, dsk: jwk2, email: "" });
    release();
    await expect(restoring).rejects.toThrow("changed meanwhile");
    expect(await w.local().identity.get()).toBeNull();
  }, 60_000);

  it("Q20, Q21: a copy with no state restores as pending; another device's copy written over this one does not keep its state", async () => {
    const { w, vk, identity, jwk } = await device();
    await w.local().cfg.write(vk, { deviceId: identity.deviceId, apiOrigin: identity.apiOrigin, dsk: jwk, email: "" });
    expect(await w.local().cfg.setState("enrolled")).toBe(true);
    const { id: y, jwk: jy } = await newIdentity();
    await w.local().cfg.write(vk, { deviceId: y.deviceId, apiOrigin: y.apiOrigin, dsk: jy, email: "" });
    expect((w.kv.data.get(SYNC_KEYS.cfg) as { state: string }).state).toBe("pending");
    const { state: _s, ...noState } = w.kv.data.get(SYNC_KEYS.cfg) as Record<string, unknown>;
    w.kv.data.set(SYNC_KEYS.cfg, noState);
    await w.local().identity.remove();
    expect((await w.local().restoreIdentity(vk, (await w.active()).keyring)).state).toBe("pending");
  }, 60_000);
});
