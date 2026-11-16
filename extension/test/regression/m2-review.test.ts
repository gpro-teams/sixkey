// The M2 review's probes (docs/audit/internal-reviews/M2-REVIEW.md Appendix B), each turned into a regression test of the fix: M2R-1 (the pins
// catch up with the commit, §0.0i item 17), M2R-2 (revocation is never blocked), M2R-3 (no Phase 0 key operation with sync
// on, item 18), M2R-4 (commitKeys takes only keys M1 issued and checks continuity, item 16), M2R-5 (sk_prejoin is never
// replaced), M2R-6 (a restore racing "turn sync off"), M2R-7 (a restored identity keeps its state), M2R-10 (applyRemote
// writes no marker, item 2), M2R-18 (a rejoin the guard stops can be answered); PROBE-8 and PROBE-10 pin behaviour the
// review found sound.
import { describe, expect, it } from "vitest";
import { decryptVault, type EncryptedVault } from "../../src/core/crypto/envelope";
import { retirePreviousVk, setPassword, unlockWithRecoveryCode, type Keyring } from "../../src/core/crypto/keyring";
import { generateVk } from "../../src/core/crypto/vk";
import { KEYS } from "../../src/core/storage/format";
import { MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { SecurityLog } from "../../src/core/service/security-log";
import { VaultService } from "../../src/core/service/service";
import { MergeBlocked } from "../../src/core/service/sync-flows";
import { KvSettingsStore } from "../../src/core/service/types";
import { evaluateSameVkBundle, unlockWithSync } from "../../src/core/sync/crypto/bundle-eval";
import { adoptedRecord } from "../../src/core/sync/crypto/keybundle";
import { preSendCheck } from "../../src/core/sync/crypto/presend";
import type { DeviceIdentity } from "../../src/core/sync/local/identity";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { KEPT_MAX } from "../../src/core/sync/local/record-writers";
import { createClock } from "../../src/core/vault/hlc";
import { canonicalJson } from "../../src/core/vault/merge";
import { aliveEntries } from "../../src/core/vault/model";
import { addEntry, deleteEntry, purgeEntry } from "../../src/core/vault/ops";
import { deserializeVault } from "../../src/core/vault/validate";
import {
  adoptByUnlock,
  adoptSameVk,
  bundleFor,
  factsOf,
  input,
  m2World,
  markSyncOn,
  newCode,
  newIdentity,
  publishedOf,
  rotated,
  secretOf,
  steadyState,
  vaultWith,
  type M2World,
} from "../helpers/m2-world";
import { codeOf, createProtected, NO_PAGE, STRONG } from "../helpers/vaults";

const PW2 = "granite-river-compass-31";
const opensCode = (k: Keyring, c: string) =>
  unlockWithRecoveryCode(k, c).then(
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

/** IndexedDB that reads but cannot write (quota, "Internal error", or the process died before the write: the same state). */
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

/** An enrolled device in its steady state: pinned to its keyring, adopted = the bundle it last published (kver 5). */
async function device() {
  const w = m2World();
  const { recoveryCode } = await vaultWith(w, ["GitHub", "AWS"], { syncOn: true });
  const st = await steadyState(w, 5);
  return { w, ...st, published: st.bundle, recoveryCode };
}
const pinsOf = async (w: M2World) => (await w.local().identity.get()) as DeviceIdentity;
const factsFrom = (p: DeviceIdentity) => ({
  maxSeenKver: p.maxSeenKver,
  expectedVaultId: p.vaultId!,
  adoptedAuth: p.adopted!.auth,
  adoptedDigest: p.adopted!.digest,
});
/** The flows of a context whose IndexedDB writes fail: the commit lands, its pins do not. */
const noIdbWrites = (w: M2World) => w.flows(w.svc(), w.local(w.kv, new NoWriteKV(w.idb)));

describe("M2R-1: the pins catch up with a commit whose pin write was lost (§0.0i item 17)", () => {
  it("PROBE-1: this device's own new recovery code, pin write lost: the next settle writes the pins, and a replay of the previous bundle is keys_behind again (its repair re-publishes the new code), never adopted back", async () => {
    const { w, vk, published, recoveryCode: oldCode, vaultId } = await device();
    const r = await newCode((await w.active()).keyring, vk);
    const next = await bundleFor(vk, r.keyring, 6, published.auth);
    const keys = await publishedOf({
      server: published,
      local: (await w.active()).keyring,
      vk,
      op: "change_recovery",
      sent: next,
      sentVk: vk,
      sentSecret: { recoveryCode: r.recoveryCode },
    });
    await noIdbWrites(w).commitKeys({ keys, record: "recovery_code_new" });
    const g = await w.active();
    expect(canonicalJson(g.keyring)).toBe(canonicalJson(next.keyring)); // the commit landed
    expect((await pinsOf(w)).adopted!.digest).toBe((await adoptedRecord(published)).digest); // its IndexedDB pins did not
    // the pending copy names the identity it is for and its pin count when the commit began (RR-3, RR-4)
    expect((w.kv.data.get(SYNC_KEYS.state) as { pendingPins: unknown }).pendingPins).toEqual({
      vkId: vk.id,
      vaultId,
      maxSeenKver: 6,
      adopted: await adoptedRecord(next),
      deviceId: (await pinsOf(w)).deviceId,
      prev: 0,
    });
    // while IndexedDB keeps failing, the settle returns the pending pins laid over the stored ones, and writes nothing
    const before = structuredClone(w.idb.data.get("identity"));
    const overlay = (await w.local(w.kv, new NoWriteKV(w.idb)).settlePins()) as DeviceIdentity;
    expect(overlay).toMatchObject({ maxSeenKver: 6, adopted: await adoptedRecord(next) });
    expect(w.idb.data.get("identity")).toEqual(before);
    // the settle with IndexedDB working: the pins are the commit's (round-trip: the stored keyring reproduces the digest)
    const settled = (await w.local().settlePins()) as DeviceIdentity;
    expect(await pinsOf(w)).toEqual(settled);
    expect(settled).toMatchObject({ vkId: vk.id, vaultId, maxSeenKver: 6, adopted: await adoptedRecord(next) });
    expect((w.kv.data.get(SYNC_KEYS.state) as { pendingPins?: unknown }).pendingPins).toBeUndefined();
    // the server serves the previous genuine bundle again (an honest PITR rollback, or a malicious replay)
    for (const facts of [factsFrom(settled), factsFrom(overlay)]) {
      expect(await evaluateSameVkBundle({ ...facts, bundle: published, vk, local: g.keyring })).toEqual({
        kind: "keys_behind",
        maxSeenKver: 6,
      });
      const repair = await preSendCheck({
        ...facts,
        op: "repair",
        serverRaw: JSON.stringify(published),
        secret: { password: STRONG },
        local: g.keyring,
        vk,
      });
      expect(repair.ok && repair.verified.keysBehind).toBe(true);
    }
    expect(await opensCode(g.keyring, r.recoveryCode)).toBe(true);
    expect(await opensCode(g.keyring, oldCode)).toBe(false);
  }, 60_000);

  it("PROBE-2: this device's own password change, pin write lost: once settled, the honest bundle is in sync and revoke is allowed", async () => {
    const { w, vk, published } = await device();
    const next = await bundleFor(vk, await setPassword((await w.active()).keyring, vk, PW2), 6);
    const keys = await publishedOf({
      server: published,
      local: (await w.active()).keyring,
      vk,
      op: "change_password",
      sent: next,
      sentVk: vk,
      sentSecret: { password: PW2 },
    });
    await noIdbWrites(w).commitKeys({ keys, record: "password_changed" });
    const g = await w.active();
    expect(canonicalJson(g.keyring)).toBe(canonicalJson(next.keyring));
    const pins = (await w.local().settlePins()) as DeviceIdentity;
    expect(await evaluateSameVkBundle({ ...factsFrom(pins), bundle: next, vk, local: g.keyring })).toEqual({
      kind: "in_sync",
      maxSeenKver: 6,
    });
    const revoke = await preSendCheck({
      ...factsFrom(pins),
      op: "revoke",
      serverRaw: JSON.stringify(next),
      secret: { password: PW2 },
      local: g.keyring,
      vk,
    });
    expect(revoke.ok).toBe(true);
  }, 60_000);

  it("PROBE-2b and PROBE-15: a rotation, pin write lost: once settled, the pin and adopted are VK2's: every VK2 round is in sync, and the unlock tries the local keyring first with nothing refused", async () => {
    const { w, vk, published } = await device();
    const r = await rotated((await w.active()).keyring, vk);
    const b2 = await bundleFor(r.vk, r.keyring, 6);
    const keys = await publishedOf({
      server: published,
      local: (await w.active()).keyring,
      vk,
      op: "rotate",
      sent: b2,
      sentVk: r.vk,
      sentSecret: { recoveryCode: r.recoveryCode },
    });
    await noIdbWrites(w).commitKeys({ keys, record: "key_rotated" });
    const g = await w.active();
    expect(g.keyring.vkId).toBe(r.vk.id);
    expect((await pinsOf(w)).vkId).toBe(vk.id); // behind, until settled
    const pins = (await w.local().settlePins()) as DeviceIdentity;
    expect(pins).toMatchObject({ vkId: r.vk.id, maxSeenKver: 6, adopted: await adoptedRecord(b2) });
    expect(await evaluateSameVkBundle({ ...factsFrom(pins), bundle: b2, vk: r.vk, local: g.keyring })).toEqual({
      kind: "in_sync",
      maxSeenKver: 6,
    });
    const u = await unlockWithSync({
      ...factsFrom(pins),
      secret: { password: STRONG },
      local: g.keyring,
      remote: b2,
      pinnedVkId: pins.vkId,
      needsPassword: false,
    });
    expect(u).toMatchObject({ kind: "local", pin: r.vk.id, note: "none" });
    expect("remoteRejected" in u).toBe(false);
  }, 60_000);

  it("status() reports the settled identity; a pending copy of a commit that never landed is dropped, one the identity is already past (GM2-5) is dropped without moving the pins back", async () => {
    const { w, vk, published, vaultId } = await device();
    const g = await w.active();
    const pinsBefore = await pinsOf(w);
    // a commit that wrote its pending pins and died before its pointer write
    const keys = await adoptSameVk({
      ...factsFrom(pinsBefore),
      bundle: await bundleFor(vk, (await newCode(g.keyring, vk)).keyring, 7, published.auth),
      vk,
      local: g.keyring,
    });
    const dies: KV = {
      get: (k) => w.kv.get(k),
      keys: () => w.kv.keys(),
      remove: (k) => w.kv.remove(k),
      set: async (i) => {
        if (KEYS.active in i) throw new Error("power loss");
        await w.kv.set(i);
      },
    };
    await expect(w.flows(w.svc(dies)).commitKeys({ keys })).rejects.toThrow("power loss");
    expect((w.kv.data.get(SYNC_KEYS.state) as { pendingPins?: unknown }).pendingPins).toBeDefined();
    const st = await w.local().status();
    expect(st.kind === "on" && st.identity).toEqual(pinsBefore);
    expect((w.kv.data.get(SYNC_KEYS.state) as { pendingPins?: unknown }).pendingPins).toBeUndefined();
    // the identity is further than a pending copy that does name the active keyring: dropped, the pins stay
    w.kv.data.set(SYNC_KEYS.state, {
      v: 1,
      lastSynced: null,
      pendingPins: { vkId: vk.id, vaultId, maxSeenKver: 4, adopted: await adoptedRecord(published) },
    });
    await w.local().identity.update((cur) => ({ ...cur, maxSeenKver: 9 }));
    const further = await pinsOf(w);
    expect(await w.local().settlePins()).toEqual(further);
    expect(await pinsOf(w)).toEqual(further);
    expect(w.kv.data.get(SYNC_KEYS.state)).toEqual({ v: 1, lastSynced: null });
  }, 60_000);
});

describe("M2R-2: in the GM2-5 state, the pre-send check blocks only what publishes or hands out a bundle", () => {
  it("PROBE-3: local tail lost, pins kept: revoke goes ahead (it was refused with needs_adoption), the repair still waits", async () => {
    const { w, vk, published } = await device();
    const before = copyOf(w.kv);
    const r = await newCode((await w.active()).keyring, vk);
    const next = await bundleFor(vk, r.keyring, 6, published.auth);
    await w.flows().commitKeys({
      keys: await publishedOf({
        server: published,
        local: (await w.active()).keyring,
        vk,
        op: "change_recovery",
        sent: next,
        sentVk: vk,
        sentSecret: { recoveryCode: r.recoveryCode },
      }),
      record: "recovery_code_new",
    });
    restore(w.kv, before); // storage.local's tail lost; IndexedDB kept the pins
    const pins = await pinsOf(w);
    const local = (await w.active()).keyring;
    const raw = JSON.stringify(next);
    const revoke = await preSendCheck({
      ...factsFrom(pins),
      op: "revoke",
      serverRaw: raw,
      secret: { password: STRONG },
      local,
      vk,
    });
    expect(revoke.ok && revoke.verified.keysBehind).toBe(true);
    expect(
      await preSendCheck({ ...factsFrom(pins), op: "repair", serverRaw: raw, secret: { password: STRONG }, local, vk }),
    ).toEqual({ ok: false, reason: "needs_adoption" });
  }, 60_000);
});

describe("M2R-3: the Phase 0 key operations are refused while sync is on (§0.0i item 18)", () => {
  it("PROBE-4: newRecoveryCode, rotateKey, changePassword, enableMasterPassword, prepareReset and commitReset: sync_on, nothing written, nothing recorded, no code shown; with sync off they work", async () => {
    const w = m2World();
    const log = new SecurityLog({ kv: w.kv, now: () => w.t.now });
    const svc = () => w.svc(w.kv, w.mirror, w.session, { security: log });
    const { recoveryCode } = await createProtected(svc());
    const prepared = await svc().prepareReset(recoveryCode, PW2); // prepared while sync was off
    const logged = (await log.read()).entries.length;
    markSyncOn(w.kv);
    const before = dump(w.kv);
    let shown = 0;
    const page = {
      onCode: () => {
        shown++;
      },
    };
    const calls: [string, () => Promise<unknown>][] = [
      ["newRecoveryCode", () => svc().newRecoveryCode(STRONG, page)],
      ["newRecoveryCode, wrong password", () => svc().newRecoveryCode("wrong-password-123", page)],
      ["rotateKey", () => svc().rotateKey(STRONG, page)],
      ["changePassword", () => svc().changePassword(STRONG, PW2)],
      ["changePassword, wrong password", () => svc().changePassword("wrong-password-123", PW2)],
      ["enableMasterPassword", () => svc().enableMasterPassword(PW2, page)],
      ["prepareReset", () => svc().prepareReset(recoveryCode, PW2)],
      ["commitReset", () => svc().commitReset(prepared)],
    ];
    for (const [name, call] of calls) await expect(call(), name).rejects.toMatchObject({ code: "sync_on" });
    expect(dump(w.kv)).toBe(before);
    expect(shown).toBe(0);
    expect((await log.read()).entries).toHaveLength(logged); // no unlock_failed, no recovery_used
    // turned off: the Phase 0 operations as before
    w.kv.data.delete(SYNC_KEYS.cfg);
    await codeOf((d) => svc().newRecoveryCode(STRONG, d));
    await svc().commitReset(await svc().prepareReset(await codeOf((d) => svc().rotateKey(STRONG, d)), PW2));
    await svc().changePassword(PW2, STRONG);
  }, 120_000);

  it("the check is inside the transact: sync turned on while the operation waits for the vault lock still refuses it", async () => {
    const w = m2World();
    await createProtected(w.svc());
    const before = (await w.active()).keyring;
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const holding = w.store().transact(async (cur) => {
      await held;
      return { envelope: cur!.envelope, keyring: cur!.keyring };
    });
    const rotation = w.svc().rotateKey(STRONG, NO_PAGE);
    markSyncOn(w.kv); // a join in another page, while the rotation waits
    release();
    await holding;
    await expect(rotation).rejects.toMatchObject({ code: "sync_on" });
    expect(canonicalJson((await w.active()).keyring)).toBe(canonicalJson(before));
    // newRecoveryCode: its first check passed (sync off) and its password was checked; sync on before its transact
    let release2!: () => void;
    const held2 = new Promise<void>((r) => {
      release2 = r;
    });
    w.kv.data.delete(SYNC_KEYS.cfg);
    const holding2 = w.store().transact(async (cur) => {
      await held2;
      return { envelope: cur!.envelope, keyring: cur!.keyring };
    });
    let shown = 0;
    const code = w.svc().newRecoveryCode(STRONG, {
      onCode: () => {
        shown++;
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    markSyncOn(w.kv);
    release2();
    await holding2;
    await expect(code).rejects.toMatchObject({ code: "sync_on" });
    expect(shown).toBe(0);
    expect(canonicalJson((await w.active()).keyring)).toBe(canonicalJson(before));
  }, 60_000);
});

describe("M2R-4: commitKeys takes only keys M1 issued, and checks continuity itself (§0.0i item 16)", () => {
  it("PROBE-7: a hand-built commit is refused; an adoption of VK1 made before the device moved to VK2 is refused (discontinuous): the keyring and the pin never go back", async () => {
    const { w, vk, published } = await device();
    const g = await w.active();
    const stale = await adoptSameVk({
      ...factsFrom(await pinsOf(w)),
      bundle: await bundleFor(vk, (await newCode(g.keyring, vk)).keyring, 6, published.auth),
      vk,
      local: g.keyring,
    });
    const r = await rotated(g.keyring, vk);
    const b2 = await bundleFor(r.vk, r.keyring, 6);
    await w.flows().commitKeys({
      keys: await adoptByUnlock({
        ...(await factsOf(w.local(), g.keyring.vaultId)),
        secret: { password: STRONG },
        local: g.keyring,
        remote: b2,
        needsPassword: true,
      }),
    });
    expect((await w.active()).keyring.vkId).toBe(r.vk.id);
    const at2 = dump(w.kv);
    await expect(
      w.flows().commitKeys({ keys: { kind: "published", bundle: published, maxSeenKver: 9 } as never }),
    ).rejects.toMatchObject({ code: "bad_state" });
    await expect(w.flows().commitKeys({ keys: stale })).rejects.toMatchObject({
      code: "bad_state",
      message: "discontinuous",
    });
    expect(dump(w.kv)).toBe(at2);
    expect((await w.active()).keyring.vkId).toBe(r.vk.id);
    expect((await pinsOf(w)).vkId).toBe(r.vk.id);
  }, 60_000);
});

describe("the join and sk_prejoin", () => {
  async function cloud(names: string[]) {
    const cw = m2World();
    await vaultWith(cw, names);
    const vk = await cw.sessionVk();
    const kr = (await cw.active()).keyring;
    const remote = deserializeVault(await decryptVault((await cw.active()).envelope, vk));
    return { vk, bundle: await bundleFor(vk, kr, 4), remote };
  }
  it("a second added-mode join keeps the earlier join's sk_prejoin byte for byte and adds its own beside it (also when it was prepared before the earlier one was written)", async () => {
    const w = m2World();
    await vaultWith(w, ["Mine", "Trashed"]);
    await w.svc().mutate((v, c) => deleteEntry(v, aliveEntries(v).find((e) => e.issuer === "Trashed")!.id, c));
    await w.svc().openView();
    const { id, jwk } = await newIdentity();
    await w.local().identity.put(id);
    const device = { deviceId: id.deviceId, apiOrigin: id.apiOrigin, dsk: jwk, email: "" };
    const a = await cloud(["CloudA"]);
    await w.flows().commitJoin(await w.flows().prepareJoin({ ...a, device }));
    const first = structuredClone(w.kv.data.get(SYNC_KEYS.prejoin)) as { v: number; items: unknown[] };
    expect(first.items).toHaveLength(1);
    await w.flows().turnOffSync();
    expect(w.kv.data.get(SYNC_KEYS.prejoin)).toEqual(first); // kept by turning sync off
    const { id: id2, jwk: jwk2 } = await newIdentity();
    await w.local().identity.put(id2);
    const b = await cloud(["CloudB"]);
    const device2 = { deviceId: id2.deviceId, apiOrigin: id2.apiOrigin, dsk: jwk2, email: "" };
    // prepared while there is no sk_prejoin, committed after the earlier join's appeared (another page's join meanwhile)
    w.kv.data.delete(SYNC_KEYS.prejoin);
    const p = await w.flows().prepareJoin({ ...b, device: device2 });
    w.kv.data.set(SYNC_KEYS.prejoin, structuredClone(first));
    await w.flows().commitJoin(p);
    const after = w.kv.data.get(SYNC_KEYS.prejoin) as { v: number; items: { at: number; envelope: EncryptedVault }[] };
    expect(after.items).toHaveLength(2);
    // the earlier entry: the same vault, moved by the join's cleanup from this profile's key before the join (cloud A's)
    // to the new one; the new entry under cloud B's key
    const was = first.items[0] as { at: number; envelope: EncryptedVault };
    expect([after.items[0]!.at, after.items[0]!.envelope.vaultId]).toEqual([was.at, was.envelope.vaultId]);
    expect(await decryptVault(after.items[0]!.envelope, b.vk)).toEqual(await decryptVault(was.envelope, a.vk));
    expect(after.items[1]!.envelope.vkId).toBe(b.vk.id);
    expect(
      aliveEntries(deserializeVault(await decryptVault((await w.active()).envelope, b.vk)))
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["CloudA", "CloudB", "Mine"]);
  }, 120_000);

  it("a join whose own kept vault would not fit on sk_prejoin's list is refused at step one (kept_full), nothing written", async () => {
    const w = m2World();
    await vaultWith(w, ["Mine"]);
    await w.svc().openView();
    const { id, jwk } = await newIdentity();
    await w.local().identity.put(id);
    w.kv.data.set(SYNC_KEYS.prejoin, {
      v: 2,
      items: Array.from({ length: KEPT_MAX.entries }, (_, i) => ({ v: 1, at: i, envelope: { kept: i } })),
    });
    const before = dump(w.kv);
    const a = await cloud(["CloudA"]);
    await expect(
      w.flows().prepareJoin({ ...a, device: { deviceId: id.deviceId, apiOrigin: id.apiOrigin, dsk: jwk, email: "" } }),
    ).rejects.toMatchObject({ code: "kept_full" });
    expect(dump(w.kv)).toBe(before);
  }, 60_000);

  it("a join that died after writing its own sk_prejoin and before its commit is retried: the record is its own (the cloud key, this vault), so it is written again", async () => {
    const w = m2World();
    await vaultWith(w, ["Mine"]);
    await w.svc().openView();
    const { id, jwk } = await newIdentity();
    await w.local().identity.put(id);
    const device = { deviceId: id.deviceId, apiOrigin: id.apiOrigin, dsk: jwk, email: "" };
    const a = await cloud(["CloudA"]);
    const dies: KV = {
      get: (k) => w.kv.get(k),
      keys: () => w.kv.keys(),
      remove: (k) => w.kv.remove(k),
      set: async (i) => {
        if (KEYS.active in i) throw new Error("power loss");
        await w.kv.set(i);
      },
    };
    await expect(w.flows(w.svc(dies)).commitJoin(await w.flows().prepareJoin({ ...a, device }))).rejects.toThrow(
      "power loss",
    );
    expect(w.kv.data.has(SYNC_KEYS.prejoin)).toBe(true);
    await w.flows().commitJoin(await w.flows().prepareJoin({ ...a, device }));
    expect(
      aliveEntries(deserializeVault(await decryptVault((await w.active()).envelope, a.vk)))
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["CloudA", "Mine"]);
  }, 120_000);

  it("the join writes into the joining device's own identity only (not one pinned to another vault, nor another device's)", async () => {
    const { w } = await device(); // enrolled in this vault
    const a = await cloud(["CloudA"]);
    const { id, jwk } = await newIdentity();
    const p = await w
      .flows()
      .prepareJoin({ ...a, device: { deviceId: id.deviceId, apiOrigin: id.apiOrigin, dsk: jwk, email: "" } });
    const before = dump(w.kv);
    await expect(w.flows().commitJoin(p)).rejects.toMatchObject({ code: "bad_state" });
    expect(dump(w.kv)).toBe(before);
  }, 120_000);

  it("PROBE-14 (M2R-18): a rejoin (same vault, related keys) whose merge the guard stops is answered through JoinInput.answer", async () => {
    const w = m2World();
    await vaultWith(w, ["Keep", "Victim"]);
    await w.svc().openView();
    const vk = await w.sessionVk();
    const kr = (await w.active()).keyring;
    const mine = deserializeVault(await decryptVault((await w.active()).envelope, vk));
    const c = createClock("bbbb", { now: () => w.t.now + 10_000 });
    for (const e of mine.entries) c.observe(e.hlc);
    const victim = aliveEntries(mine).find((e) => e.issuer === "Victim")!.id;
    const remote = purgeEntry(mine, victim, c); // erased elsewhere, skipping this device's trash
    const { id, jwk } = await newIdentity();
    await w.local().identity.put(id);
    const j = {
      bundle: await bundleFor(vk, kr, 4),
      vk,
      remote,
      device: { deviceId: id.deviceId, apiOrigin: id.apiOrigin, dsk: jwk, email: "" },
    };
    const err = (await w
      .flows()
      .prepareJoin(j)
      .catch((e) => e)) as MergeBlocked;
    expect(err).toBeInstanceOf(MergeBlocked);
    const p = await w.flows().prepareJoin({ ...j, answer: { seen: err.seen, keepMine: [victim] } });
    expect(p.mode).toBe("merged");
    await w.flows().commitJoin(p);
    expect(
      aliveEntries(deserializeVault(await decryptVault((await w.active()).envelope, vk)))
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["Keep", "Victim"]);
  }, 60_000);
});

describe("identity restore", () => {
  it("PROBE-6 (M2R-6): a restore racing 'turn sync off' in another context does not bring the removed identity back", async () => {
    const { w, vk, identity, jwk } = await device();
    await w
      .local()
      .cfg.write(vk, { deviceId: identity.deviceId, apiOrigin: identity.apiOrigin, dsk: jwk, email: "me@example.com" });
    await w.local().identity.remove(); // identity_missing (IndexedDB wiped)
    expect((await w.local().status()).kind).toBe("identity_missing");
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
    while (n < 2) await new Promise((r) => setTimeout(r, 1));
    const off = w.local().turnOff(); // the settings page turns sync off meanwhile
    release();
    await expect(restoring).rejects.toThrow("changed meanwhile");
    await off;
    expect((await w.local().status()).kind).toBe("off");
  }, 60_000);

  it("PROBE-13 (M2R-7): the identity comes back in the state its copy mirrors: pending unless M3 recorded enrolled (or rejected)", async () => {
    const { w, vk, identity, jwk } = await device();
    const plain = { deviceId: identity.deviceId, apiOrigin: identity.apiOrigin, dsk: jwk, email: "" };
    await w.local().cfg.write(vk, plain); // written before init / complete: pending
    await w.local().identity.remove();
    expect((await w.local().restoreIdentity(vk, (await w.active()).keyring)).state).toBe("pending");
    expect(await w.local().cfg.setState("enrolled")).toBe(true);
    await w.local().cfg.write(vk, plain); // a later write of the copy keeps the state for the same device
    await w.local().identity.remove();
    expect((await w.local().restoreIdentity(vk, (await w.active()).keyring)).state).toBe("enrolled");
    await w.local().cfg.setState("rejected_by_server");
    await w.local().identity.remove();
    expect((await w.local().restoreIdentity(vk, (await w.active()).keyring)).state).toBe("rejected_by_server");
  }, 60_000);
});

describe("the recovery hook and the marker", () => {
  it("PROBE-8 (Q2, kept as built): with sync off, a read error on the hook's own get fails a recovery closed; a retry recovers", async () => {
    const w = m2World();
    await vaultWith(w, ["A", "B"]);
    await w.svc().openView();
    const ptr = w.kv.data.get(KEYS.active) as "a" | "b";
    w.kv.data.set(KEYS.slot[ptr], { torn: true }); // the active slot is damaged: recover() moves the pointer (a recovery write)
    let failOnce = true;
    const flaky: KV = {
      get: async (k: string[]) => {
        if (failOnce && k.includes(SYNC_KEYS.state) && k.includes(SYNC_KEYS.outbox)) {
          failOnce = false;
          throw new Error("IO error");
        }
        return w.kv.get(k);
      },
      keys: () => w.kv.keys(),
      set: (i) => w.kv.set(i),
      remove: (k) => w.kv.remove(k),
    };
    const before = copyOf(w.kv);
    await expect(w.svc(flaky).openView()).rejects.toThrow("IO error");
    // the same open without the hook recovers at once
    restore(w.kv, before);
    const noHook = new VaultService({
      store: new VaultStore({ kv: w.kv, mirror: w.mirror, lock: w.lock, now: () => w.t.now }),
      session: w.session,
      settings: new KvSettingsStore(w.kv),
      now: () => w.t.now,
    });
    expect((await noHook.openView()).state).toBe("unlocked");
    // and with the hook, the retry recovers (fail closed, not stuck)
    restore(w.kv, before);
    failOnce = false;
    expect((await w.svc(flaky).openView()).state).toBe("unlocked");
  }, 60_000);

  it("PROBE-9 (M2R-10, Q1): applyRemote writes no marker, so the 65th rotation right after a sync is not refused with cleanup_pending", async () => {
    const w = m2World();
    await createProtected(w.svc());
    const vk = await w.sessionVk();
    let kr: Keyring = (await w.active()).keyring;
    for (let i = 0; i < 64; i++) kr = await retirePreviousVk(kr, await generateVk(), vk);
    await w.store().transact(async (cur) => ({ envelope: cur!.envelope, keyring: kr }));
    await w.svc().openView();
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
    markSyncOn(w.kv);
    const keyring = canonicalJson((await w.active()).keyring);
    const mine = deserializeVault(await decryptVault((await w.active()).envelope, vk));
    const c = createClock("bbbb", { now: () => w.t.now + 10_000 });
    for (const e of mine.entries) c.observe(e.hlc);
    expect((await w.flows().applyRemote(addEntry(mine, input("Remote", secretOf("Remote")), c).vault)).changed).toBe(
      true,
    );
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
    expect(canonicalJson((await w.active()).keyring)).toBe(keyring);
    const lv = await w.store().loadView();
    expect(lv.status === "ok" && lv.cleanup).toBe("none");
    // with sync on a rotation is the sync one (sync_on); with sync off the Phase 0 one rotates to 64 previous keys
    await expect(w.svc().rotateKey(STRONG, NO_PAGE)).rejects.toMatchObject({ code: "sync_on" });
    w.kv.data.delete(SYNC_KEYS.cfg);
    await codeOf((d) => w.svc().rotateKey(STRONG, d));
    expect((await w.active()).keyring.previous).toHaveLength(64);
  }, 120_000);
});

describe("two contexts at once", () => {
  it("PROBE-10: the SW's applyRemote, the popup's edit and the settings page's R3 key commit, started together, all land: one lock, each re-reads", async () => {
    const { w, vk } = await device();
    const mine = deserializeVault(await decryptVault((await w.active()).envelope, vk));
    const c = createClock("bbbb", { now: () => w.t.now + 10_000 });
    for (const e of mine.entries) c.observe(e.hlc);
    const remote = addEntry(mine, input("FromServer", secretOf("FromServer")), c).vault;
    const g = await w.active();
    const r = await rotated(g.keyring, vk);
    const b2 = await bundleFor(r.vk, r.keyring, 6);
    const keys = await adoptByUnlock({
      ...(await factsOf(w.local(), g.keyring.vaultId)),
      secret: { password: STRONG },
      local: g.keyring,
      remote: b2,
      needsPassword: true,
    });
    const sw = w.flows(w.svc(), w.local());
    const page = w.flows(w.svc(), w.local());
    const results = await Promise.allSettled([
      sw.applyRemote(remote),
      w.svc().mutate((v, cl) => addEntry(v, input("FromPopup", secretOf("FromPopup")), cl).vault),
      page.commitKeys({ keys, record: "keys_adopted" }),
    ]);
    // the merge and the edit ran either before the key commit (under VK1) or after it (the session is VK2 then)
    expect(results[2].status).toBe("fulfilled");
    const a = await w.active();
    expect(a.keyring.vkId).toBe(r.vk.id);
    const issuers = aliveEntries(deserializeVault(await decryptVault(a.envelope, r.vk))).map((e) => e.issuer);
    for (const [i, x] of results.entries())
      if (x.status === "fulfilled") expect(issuers).toContain(["FromServer", "FromPopup", "GitHub"][i]);
  }, 60_000);
});
