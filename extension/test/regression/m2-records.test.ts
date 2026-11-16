// §0.0i req. 5 (A4R-4): each of M2's two real VK-encrypted records, sk_sync_cfg and sk_prejoin, races two rotations in
// two pages (gm2-fixes.test.ts's LockedRecord test, with the real records): page A's cleanup after VK1 -> VK2 is held at
// the record's very write, while page B rotates VK2 -> VK3. The record's read, key check and write are one critical
// section under the vault lock, so B waits; at the end the record is under VK3 and no marker is left. And a record a
// cleanup cannot read stops that cleanup before the store's part, keeping the marker.
import { describe, expect, it } from "vitest";
import { fromB64, utf8 } from "../../src/core/crypto/bytes";
import { decryptVault, type EncryptedVault } from "../../src/core/crypto/envelope";
import { vkFromRaw } from "../../src/core/crypto/vk";
import { KEYS } from "../../src/core/storage/format";
import { createMutex, MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultService } from "../../src/core/service/service";
import { SyncFlows } from "../../src/core/service/sync-flows";
import { KvSettingsStore, MemorySession } from "../../src/core/service/types";
import { openDeviceBackup } from "../../src/core/sync/crypto/device-backup";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { PrejoinRecord, SyncCfgRecord } from "../../src/core/sync/local/records";
import { SyncLocal } from "../../src/core/sync/local/sync-local";
import { createRuntime } from "../../src/platform/runtime";
import { NO_PAGE, STRONG } from "../helpers/vaults";
import { adoptByUnlock, bundleFor, m2World, newIdentity, rotated, vaultWith } from "../helpers/m2-world";

/** The records' view of storage.local, whose write of `key` waits at a gate (the other page tries to run meanwhile). */
function gated(inner: MemoryKV, key: string) {
  let release!: () => void;
  let reached!: () => void;
  const atGate = new Promise<void>((r) => {
    reached = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let armed = true;
  const kv: KV = {
    get: (k) => inner.get(k),
    keys: () => inner.keys(),
    remove: (k) => inner.remove(k),
    set: async (i) => {
      if (armed && key in i) {
        armed = false;
        reached();
        await gate;
      }
      await inner.set(i);
    },
  };
  return { kv, atGate, release };
}

describe.each([[SYNC_KEYS.cfg], [SYNC_KEYS.prejoin]])("A4R-4 with the real record %s", (key) => {
  it("page A's cleanup (VK1 -> VK2) held at the record's write, page B's rotation (VK2 -> VK3): the record ends under VK3, no marker left", async () => {
    const w = m2World();
    await vaultWith(w, ["GitHub"]);
    await w.svc().openView();
    const vk1 = await w.sessionVk();
    const vaultId = (await w.active()).keyring.vaultId;
    const { id, jwk } = await newIdentity();
    await w
      .local()
      .cfg.write(vk1, { deviceId: id.deviceId, apiOrigin: id.apiOrigin, dsk: jwk, email: "me@example.com" });
    await w.local().prejoin.writeInLock(vk1, utf8('{"old":true}'), "old-vault-00001", 1);
    const g = gated(w.kv, key);
    const page = (session: MemorySession, recordsKv: KV) =>
      new VaultService({
        store: w.store(),
        session,
        settings: new KvSettingsStore(w.kv),
        now: () => w.t.now,
        vkRecords: [new SyncCfgRecord(recordsKv, w.lock), new PrejoinRecord(recordsKv, w.lock)],
      });
    const sessA = new MemorySession();
    sessA.data = { ...w.session.data! };
    const a = page(sessA, g.kv).rotateKey(STRONG, NO_PAGE);
    await g.atGate; // A's record step holds the vault lock, its re-encryption done, its write not yet landed
    const sessB = new MemorySession();
    sessB.data = { ...sessA.data! }; // B is unlocked with VK2
    const b = page(sessB, w.kv).rotateKey(STRONG, NO_PAGE); // waits for the lock
    await new Promise((r) => setTimeout(r, 10));
    g.release();
    await Promise.all([a, b]);
    const vk3 = await vkFromRaw(fromB64(sessB.data!.vk));
    expect((await w.active()).keyring.vkId).toBe(vk3.id);
    const cfg = w.kv.data.get(SYNC_KEYS.cfg) as { enc: { vkId: string } };
    const pj = (w.kv.data.get(SYNC_KEYS.prejoin) as { items: { envelope: EncryptedVault }[] }).items[0]!; // its one kept vault
    expect([cfg.enc.vkId, pj.envelope.vkId]).toEqual([vk3.id, vk3.id]);
    expect((await openDeviceBackup(vk3, { vaultId, deviceId: id.deviceId }, cfg.enc as never)).email).toBe(
      "me@example.com",
    );
    expect(new TextDecoder().decode(await decryptVault(pj.envelope, vk3))).toBe('{"old":true}');
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
  });
});

describe("a record the cleanup cannot read stops it before the store's part (§0.0i req. 5)", () => {
  it("the marker stays and the store's copies are not touched; the next unlock finishes", async () => {
    const w = m2World();
    await vaultWith(w, ["GitHub"]);
    await w.svc().openView();
    const vk1 = await w.sessionVk();
    const { id, jwk } = await newIdentity();
    await w.local().cfg.write(vk1, { deviceId: id.deviceId, apiOrigin: id.apiOrigin, dsk: jwk, email: "" });
    const failing: KV = {
      get: async (k) => {
        if (k.includes(SYNC_KEYS.cfg)) throw new Error("IO error: transient");
        return w.kv.get(k);
      },
      keys: () => w.kv.keys(),
      set: (i) => w.kv.set(i),
      remove: (k) => w.kv.remove(k),
    };
    const s = new VaultService({
      store: w.store(),
      session: w.session,
      settings: new KvSettingsStore(w.kv),
      now: () => w.t.now,
      vkRecords: [new SyncCfgRecord(failing, w.lock), new PrejoinRecord(w.kv, w.lock)],
    });
    await s.rotateKey(STRONG, NO_PAGE); // committed; its cleanup stops at the record
    const vk2 = await w.sessionVk();
    expect(w.kv.data.get(KEYS.keyChange)).toMatchObject({ vkId: vk2.id });
    const snaps = [...w.kv.data]
      .filter(([k]) => k.startsWith("sk_snap_r"))
      .map(([, v]) => (v as { envelope: EncryptedVault }).envelope.vkId);
    expect(snaps).toContain(vk1.id); // the store's part did not run
    await w.svc().lock();
    await w.svc().unlockWithPassword(STRONG); // the real records read fine now
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
    expect((w.kv.data.get(SYNC_KEYS.cfg) as { enc: { vkId: string } }).enc.vkId).toBe(vk2.id);
  });
});

describe("R06 (M2R-12): the runtime's own wiring moves both records with every key change", () => {
  function area() {
    const data = new Map<string, unknown>();
    const a = {
      async get(keys?: string | string[] | null) {
        const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(ks.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
      },
      async set(items: Record<string, unknown>) {
        for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
      },
      async remove(keys: string | string[]) {
        for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
      },
    };
    return { data, area: a as unknown as chrome.storage.StorageArea };
  }
  it("createRuntime: a Phase 0 rotation (sync off) moves sk_prejoin to the new key; an adopted rotation (sync on, commitKeys) moves sk_sync_cfg and sk_prejoin", async () => {
    const local = area();
    const session = area();
    const rt = createRuntime({ local: local.area, session: session.area, mirror: null });
    expect(rt.sync.records.map((r) => r.name)).toEqual([SYNC_KEYS.cfg, SYNC_KEYS.prejoin]);
    await rt.service.create(await rt.service.prepareKeys(STRONG));
    const sessionVk = async () => vkFromRaw(fromB64((session.data.get("sk_session") as { vk: string }).vk));
    const vk1 = await sessionVk();
    const syncLocal = new SyncLocal({ local: rt.local, identity: new MemoryKV(), vaultLock: createMutex() });
    await syncLocal.prejoin.writeInLock(vk1, utf8("{}"), "old-vault-00001", 1); // an earlier join's, under the current key
    const under = (k: string) => {
      const r = local.data.get(k) as { enc?: { vkId: string }; items?: { envelope: { vkId: string } }[] };
      return (r.enc ?? r.items![0]!.envelope).vkId; // sk_prejoin: its one kept vault
    };
    await rt.service.rotateKey(STRONG, NO_PAGE);
    const vk2 = await sessionVk();
    expect(vk2.id).not.toBe(vk1.id);
    expect(under(SYNC_KEYS.prejoin)).toBe(vk2.id);
    // sync on: the device key's copy, then another device's rotation adopted with the password
    const { id, jwk } = await newIdentity();
    await syncLocal.cfg.write(vk2, {
      deviceId: id.deviceId,
      apiOrigin: id.apiOrigin,
      dsk: jwk,
      email: "me@example.com",
    });
    const kr = (await rt.service.currentGeneration())!.keyring;
    const r = await rotated(kr, vk2);
    const keys = await adoptByUnlock({
      secret: { password: STRONG },
      local: kr,
      remote: await bundleFor(r.vk, r.keyring, 2),
      pinnedVkId: null,
      maxSeenKver: 0,
      needsPassword: true,
      expectedVaultId: kr.vaultId,
      adoptedAuth: null,
      adoptedDigest: null,
    });
    await new SyncFlows(rt.service, syncLocal).commitKeys({ keys });
    expect([under(SYNC_KEYS.cfg), under(SYNC_KEYS.prejoin)]).toEqual([r.vk.id, r.vk.id]);
    expect(local.data.has(KEYS.keyChange)).toBe(false);
  }, 60_000);
});
