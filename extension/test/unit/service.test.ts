import { describe, expect, it, vi } from "vitest";
import { fromB64 } from "../../src/core/crypto/bytes";
import { decryptVault } from "../../src/core/crypto/envelope";
import { unwrapPreviousVks, validateKeyring } from "../../src/core/crypto/keyring";
import { vkFromRaw } from "../../src/core/crypto/vk";
import { KEYS } from "../../src/core/storage/format";
import { createMutex, MemoryKV, type KV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { isSessionExpired, ServiceError, VaultService, type PreparedKeys } from "../../src/core/service/service";
import {
  KvSettingsStore,
  MemorySession,
  type SessionCache,
  type SessionData,
  type SettingsStore,
} from "../../src/core/service/types";
import { SECURITY_LOG_KEY, SecurityLog, type SecurityRecorder } from "../../src/core/service/security-log";
import { createBackup, openBackup } from "../../src/core/backup/backup";
import { applyPreset } from "../../src/core/service/presets";
import { createClock } from "../../src/core/vault/hlc";
import { aliveEntries, emptyVault } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import {
  allStored,
  createProtected,
  deviceMaterial,
  legacyDeviceVault,
  STRONG,
  NO_PAGE,
  codeOf,
  resetWithCode,
} from "../helpers/vaults";

const STRONG2 = "granite-river-compass-31";

function setup(opts: { mirror?: boolean } = {}) {
  const kv = new MemoryKV();
  const mirror = opts.mirror ? new MemoryKV() : undefined;
  const session = new MemorySession();
  const t = { now: 1_700_000_000_000 };
  const settings = new KvSettingsStore(kv);
  const store = () => new VaultStore({ lock: createMutex(), kv, ...(mirror ? { mirror } : {}), now: () => t.now });
  const make = () => new VaultService({ store: store(), session, settings, now: () => t.now });
  return { kv, mirror, session, settings, t, svc: make(), fresh: make, store };
}
const input = (issuer: string) => ({
  type: "totp" as const,
  issuer,
  label: "a",
  secret: "JBSWY3DPEHPK3PXP",
  algorithm: "SHA1" as const,
  digits: 6 as const,
  period: 30,
});
const add = (svc: VaultService, issuer: string) => svc.mutate((v, c) => addEntry(v, input(issuer), c).vault);
const all = (m: MemoryKV) => JSON.stringify([...m.data.entries()]);

describe("a new vault needs a master password first", () => {
  it("is created unlocked, edits persist across restarts", async () => {
    const { svc, fresh } = setup();
    expect((await svc.status()).state).toBe("empty");
    await createProtected(svc);
    expect(await svc.status()).toMatchObject({ state: "unlocked", passwordProtected: true });
    // H1: no device wrap at all; the keyring holds exactly the password and recovery wraps
    const gen = (await svc.currentGeneration())!;
    expect(gen.keyring.deviceKey).toBeUndefined();
    expect(gen.keyring.wraps.map((x) => x.method).sort()).toEqual(["password", "recovery"]);
    await add(svc, "GitHub");
    await add(svc, "AWS");
    const again = fresh();
    expect(aliveEntries((await again.read()).vault).map((e) => e.issuer)).toEqual(["GitHub", "AWS"]);
  });
  it("create refuses to run over an existing vault", async () => {
    const { svc } = setup();
    await createProtected(svc);
    await expect(svc.create(await svc.prepareKeys(STRONG2))).rejects.toMatchObject({ code: "bad_state" });
  });
  it("concurrent edits are all kept", async () => {
    const { svc } = setup();
    await createProtected(svc);
    await Promise.all(["A", "B", "C", "D", "E"].map((n) => add(svc, n)));
    expect((await svc.read()).vault.entries).toHaveLength(5);
  });
  it("a throwing edit writes nothing", async () => {
    const { svc } = setup();
    await createProtected(svc);
    await add(svc, "A");
    const before = (await svc.currentGeneration())!.seq;
    await expect(
      svc.mutate(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await svc.currentGeneration())!.seq).toBe(before);
  });
  it("returning the same vault is a no-op for the data", async () => {
    const { svc } = setup();
    await createProtected(svc);
    await add(svc, "A");
    const before = (await svc.currentGeneration())!.envelope.checksum;
    await svc.mutate((v) => v);
    expect((await svc.currentGeneration())!.envelope.checksum).toBe(before);
  });
});

describe("turning on the master password", () => {
  async function protectedWorld(mirror = true) {
    const w = setup({ mirror });
    await legacyDeviceVault(w.store()); // the upgrade path for a Phase 0 vault; new vaults start protected
    for (const n of ["GitHub", "AWS", "Stripe"]) await add(w.svc, n);
    const beforeGen = (await w.svc.currentGeneration())!;
    const snapshot = structuredClone(Object.fromEntries(w.kv.data));
    const oldDeviceKey = beforeGen.keyring.deviceKey!;
    const recoveryCode = await codeOf((d) => w.svc.enableMasterPassword(STRONG, d));
    return { ...w, recoveryCode, oldDeviceKey, snapshot, beforeGen };
  }

  it("rejects weak passwords and does not change anything", async () => {
    const w = setup();
    await legacyDeviceVault(w.store());
    for (const pw of ["short", "aaaaaaaaaaaaaaaa", "abcdefghijklmnop", "password"]) {
      await expect(w.svc.enableMasterPassword(pw, NO_PAGE)).rejects.toMatchObject({ code: "weak_password" });
    }
    expect(await w.svc.status()).toMatchObject({ passwordProtected: false });
  });

  it("keeps the data, stays unlocked, returns a recovery code", async () => {
    const w = await protectedWorld();
    expect(w.recoveryCode).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(await w.svc.status()).toMatchObject({ state: "unlocked", passwordProtected: true });
    expect(aliveEntries((await w.svc.read()).vault).map((e) => e.issuer)).toEqual(["GitHub", "AWS", "Stripe"]);
  });

  it("leaves no trace of the device key or the old vault key anywhere on disk", async () => {
    const w = await protectedWorld();
    expect(all(w.kv)).not.toContain(w.oldDeviceKey);
    expect(all(w.mirror!)).not.toContain(w.oldDeviceKey);
    const gen = (await w.svc.currentGeneration())!;
    expect(gen.keyring.deviceKey).toBeUndefined();
    expect(gen.keyring.wraps.map((x) => x.method).sort()).toEqual(["password", "recovery"]);
    // every stored envelope (both slots, snapshots, mirror) is under the new key
    const envelopes: { vkId: string }[] = [];
    for (const m of [w.kv, w.mirror!]) {
      for (const [k, v] of m.data) {
        const o = v as any;
        if (k === KEYS.slot.a || k === KEYS.slot.b || k === KEYS.mirrorGen) envelopes.push(o.envelope);
        if (k.startsWith("sk_snap_") && k !== KEYS.snapIndex) envelopes.push(o.envelope);
      }
    }
    expect(envelopes.length).toBeGreaterThanOrEqual(5);
    for (const e of envelopes) expect(e.vkId).toBe(gen.keyring.vkId);
    for (const m of [w.kv, w.mirror!])
      for (const [k, v] of m.data)
        if (k === KEYS.slot.a || k === KEYS.slot.b || k === KEYS.keyringCopy || k === KEYS.mirrorGen) {
          const kr = (v as any).keyring;
          expect(kr.vkId).toBe(gen.keyring.vkId);
          expect(kr.deviceKey).toBeUndefined();
        }
  });

  it("the old device-only copy of the disk (taken before) cannot open the new data", async () => {
    const w = await protectedWorld();
    const oldGen = w.snapshot[KEYS.slot.b] ?? w.snapshot[KEYS.slot.a];
    const oldVk = await vkFromRaw(new Uint8Array(32)); // placeholder, replaced below
    void oldVk;
    const current = (await w.svc.currentGeneration())!;
    expect((oldGen as any).keyring.vkId).not.toBe(current.keyring.vkId);
    const oldKeyring = validateKeyring((oldGen as any).keyring);
    const { unlockWithDevice } = await import("../../src/core/crypto/keyring");
    const stolenVk = await unlockWithDevice(oldKeyring);
    await expect(decryptVault(current.envelope, stolenVk)).rejects.toMatchObject({ code: "decrypt_failed" });
  });

  it("locks, rejects a wrong password, unlocks with the password and with the recovery code", async () => {
    const w = await protectedWorld();
    await w.svc.lock();
    expect((await w.svc.status()).state).toBe("locked");
    await expect(w.svc.read()).rejects.toMatchObject({ code: "locked" });
    await expect(w.svc.unlockWithPassword("not the password")).rejects.toMatchObject({ code: "wrong_secret" });
    await w.svc.unlockWithPassword(STRONG);
    expect((await w.svc.read()).vault.entries).toHaveLength(3);
    await w.svc.lock();
    await w.svc.unlockWithRecoveryCode(w.recoveryCode.toLowerCase());
    expect((await w.svc.read()).vault.entries).toHaveLength(3);
  });

  it("a second enable is refused", async () => {
    const w = await protectedWorld();
    await expect(w.svc.enableMasterPassword(STRONG2, NO_PAGE)).rejects.toMatchObject({ code: "already_protected" });
  });

  /** Put the pre-change slot and old-key snapshots back, as if the process died right after the commit. */
  function plantOldMaterial(w: Awaited<ReturnType<typeof protectedWorld>>) {
    const stale = w.snapshot;
    const ptr = w.kv.data.get(KEYS.active) as "a" | "b";
    const otherKey = ptr === "a" ? KEYS.slot.b : KEYS.slot.a;
    w.kv.data.set(otherKey, stale[otherKey] ?? stale[KEYS.slot.a]);
    for (const [k, v] of Object.entries(stale)) if (k.startsWith("sk_snap_r")) w.kv.data.set(k, v);
    const idx = (w.kv.data.get(KEYS.snapIndex) as any[]).slice();
    w.kv.data.set(KEYS.snapIndex, [...idx, ...(stale[KEYS.snapIndex] as any[])]);
    expect(all(w.kv)).toContain(w.oldDeviceKey);
  }
  async function expectAllUnderCurrentKey(w: Awaited<ReturnType<typeof protectedWorld>>) {
    expect(all(w.kv)).not.toContain(w.oldDeviceKey);
    const gen = (await w.svc.currentGeneration())!;
    for (const [k, v] of w.kv.data)
      if (k.startsWith("sk_snap_r")) expect((v as any).envelope.vkId).toBe(gen.keyring.vkId);
    // and the snapshots are still readable with the new key
    const vk = await (await import("../../src/core/crypto/keyring")).unlockWithPassword(gen.keyring, STRONG);
    for (const [k, v] of w.kv.data)
      if (k.startsWith("sk_snap_r")) await expect(decryptVault((v as any).envelope, vk)).resolves.toBeDefined();
    // and the cleanup is recorded as done
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
    expect(w.kv.data.get(KEYS.storeVersion)).toEqual({ v: 2, vkId: gen.keyring.vkId });
  }

  it("finishes the cleanup after a crash that left old material behind", async () => {
    const w = await protectedWorld();
    plantOldMaterial(w);
    // A real crash after the commit leaves the marker too: enableMasterPassword writes it before it commits (PHASE0X-PLAN A2).
    w.kv.data.set(KEYS.keyChange, { v: 1, vkId: (await w.svc.currentGeneration())!.keyring.vkId, at: 1 });

    await w.svc.lock();
    await w.svc.unlockWithPassword(STRONG); // housekeeping runs here
    await expectAllUnderCurrentKey(w);
  });

  it("old material from before the marker existed (no marker, no sk_store_v) is cleaned by the one full check at the next unlock", async () => {
    const w = await protectedWorld();
    plantOldMaterial(w);
    w.kv.data.delete(KEYS.storeVersion); // a store last written by a version without the marker
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);

    await w.svc.lock();
    await w.svc.unlockWithPassword(STRONG);
    await expectAllUnderCurrentKey(w);
  });
});

describe("password changes and key rotation", () => {
  async function protectedWorld() {
    const w = setup({ mirror: true });
    await legacyDeviceVault(w.store()); // kept on the upgrade path, so the device-era key is one of the previous ones
    await add(w.svc, "GitHub");
    return { ...w, code: await codeOf((d) => w.svc.enableMasterPassword(STRONG, d)) };
  }
  it("changing the password leaves the data untouched and retires the old password", async () => {
    const w = await protectedWorld();
    const before = (await w.svc.currentGeneration())!.envelope.checksum;
    await expect(w.svc.changePassword("wrong", STRONG2)).rejects.toMatchObject({ code: "wrong_secret" });
    await expect(w.svc.changePassword(STRONG, "weak")).rejects.toMatchObject({ code: "weak_password" });
    await w.svc.changePassword(STRONG, STRONG2);
    expect((await w.svc.currentGeneration())!.envelope.checksum).toBe(before);
    await w.svc.lock();
    await expect(w.svc.unlockWithPassword(STRONG)).rejects.toMatchObject({ code: "wrong_secret" });
    await w.svc.unlockWithPassword(STRONG2);
    await w.svc.lock();
    await w.svc.unlockWithRecoveryCode(w.code); // recovery code still valid
  });
  it("rotating the key re-encrypts everything, invalidates the old recovery code, keeps old versions reachable", async () => {
    const w = await protectedWorld();
    const first = (await w.svc.currentGeneration())!.keyring.vkId;
    const r1 = { recoveryCode: await codeOf((d) => w.svc.rotateKey(STRONG, d)) };
    const r2 = { recoveryCode: await codeOf((d) => w.svc.rotateKey(STRONG, d)) };
    const gen = (await w.svc.currentGeneration())!;
    expect(gen.keyring.vkId).not.toBe(first);
    expect(r1.recoveryCode).not.toBe(r2.recoveryCode);
    const vk = await w.svc
      .currentGeneration()
      .then(() => import("../../src/core/crypto/keyring").then((m) => m.unlockWithPassword(gen.keyring, STRONG)));
    expect((await unwrapPreviousVks(gen.keyring, vk)).map((v) => v.id).length).toBe(3); // device-era key + two rotations
    for (const [k, v] of w.kv.data)
      if (k.startsWith("sk_snap_r")) expect((v as any).envelope.vkId).toBe(gen.keyring.vkId);
    await w.svc.lock();
    await expect(w.svc.unlockWithRecoveryCode(w.code)).rejects.toMatchObject({ code: "wrong_secret" });
    await expect(w.svc.unlockWithRecoveryCode(r1.recoveryCode)).rejects.toMatchObject({ code: "wrong_secret" });
    await w.svc.unlockWithRecoveryCode(r2.recoveryCode);
    expect(aliveEntries((await w.svc.read()).vault)).toHaveLength(1);
  });
  it("a vault that had the password from the start: two rotations keep exactly the two retired keys", async () => {
    const w = setup({ mirror: true });
    const { recoveryCode } = await createProtected(w.svc);
    await add(w.svc, "GitHub");
    const first = (await w.svc.currentGeneration())!.keyring.vkId;
    await w.svc.rotateKey(STRONG, NO_PAGE);
    const r2 = { recoveryCode: await codeOf((d) => w.svc.rotateKey(STRONG, d)) };
    const gen = (await w.svc.currentGeneration())!;
    const { unlockWithPassword } = await import("../../src/core/crypto/keyring");
    const prev = (await unwrapPreviousVks(gen.keyring, await unlockWithPassword(gen.keyring, STRONG))).map((v) => v.id);
    expect(prev).toHaveLength(2); // no device-era key: there never was one
    expect(prev).toContain(first);
    await w.svc.lock();
    await expect(w.svc.unlockWithRecoveryCode(recoveryCode)).rejects.toMatchObject({ code: "wrong_secret" });
    await w.svc.unlockWithRecoveryCode(r2.recoveryCode);
    expect(aliveEntries((await w.svc.read()).vault)).toHaveLength(1);
  });
  it("forgot the password: the recovery code sets a new one and keeps working itself (owner, 2026-11-18)", async () => {
    const w = await protectedWorld();
    await w.svc.lock();
    await expect(resetWithCode(w.svc, "0000-0000-0000-0000-0000-0000-00VM", STRONG2)).rejects.toMatchObject({
      code: "wrong_secret",
    });
    const r = await resetWithCode(w.svc, w.code, STRONG2);
    expect(r).toBe(w.code);
    expect((await w.svc.status()).state).toBe("unlocked");
    await w.svc.lock();
    await expect(w.svc.unlockWithPassword(STRONG)).rejects.toMatchObject({ code: "wrong_secret" });
    await w.svc.unlockWithPassword(STRONG2);
    await w.svc.lock();
    await w.svc.unlockWithRecoveryCode(w.code);
    expect((await w.svc.status()).state).toBe("unlocked");
  });
  it("a fresh recovery code replaces the old one", async () => {
    const w = await protectedWorld();
    const r = { recoveryCode: await codeOf((d) => w.svc.newRecoveryCode(STRONG, d)) };
    await w.svc.lock();
    await expect(w.svc.unlockWithRecoveryCode(w.code)).rejects.toMatchObject({ code: "wrong_secret" });
    await w.svc.unlockWithRecoveryCode(r.recoveryCode);
  });
  it("editing requires the vault to be unlocked", async () => {
    const w = await protectedWorld();
    await w.svc.lock();
    await expect(add(w.svc, "X")).rejects.toBeInstanceOf(ServiceError);
    await expect(add(w.svc, "X")).rejects.toMatchObject({ code: "locked" });
  });
});

describe("auto-lock", () => {
  it("idle timeout locks, activity postpones it", async () => {
    const w = setup();
    await createProtected(w.svc);
    await w.settings.set({ autoLock: { mode: "idle", minutes: 5 }, lockOnScreenLock: true });
    w.t.now += 4 * 60_000;
    expect((await w.svc.status()).state).toBe("unlocked");
    await w.svc.touch();
    w.t.now += 4 * 60_000;
    expect((await w.svc.status()).state).toBe("unlocked");
    w.t.now += 2 * 60_000;
    expect(await w.svc.enforceAutoLock()).toBe(true);
    expect((await w.svc.status()).state).toBe("locked");
    expect(await w.session.get()).toBeNull();
  });
  it("browser-session mode never expires by time; 'lock every time' still has a 15 minute ceiling for pages left open", async () => {
    const w = setup();
    await createProtected(w.svc);
    await w.settings.set({ autoLock: { mode: "session" }, lockOnScreenLock: true });
    w.t.now += 30 * 86_400_000;
    expect((await w.svc.status()).state).toBe("unlocked");
    await w.settings.set({ autoLock: { mode: "always" }, lockOnScreenLock: true });
    await w.svc.unlockWithPassword(STRONG);
    w.t.now += 14 * 60_000;
    expect((await w.svc.status()).state).toBe("unlocked");
    w.t.now += 2 * 60_000;
    expect((await w.svc.status()).state).toBe("locked");
  });
  it("isSessionExpired is exact at the boundary", () => {
    const s = { vk: "", lastActive: 1000 };
    const idle = { autoLock: { mode: "idle" as const, minutes: 1 }, lockOnScreenLock: true };
    expect(isSessionExpired(idle, s, 1000 + 60_000)).toBe(false);
    expect(isSessionExpired(idle, s, 1000 + 60_001)).toBe(true);
  });
  it("a session holding some other key is treated as locked", async () => {
    const w = setup();
    await createProtected(w.svc);
    await w.session.set({ vk: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))), lastActive: w.t.now });
    expect((await w.svc.status()).state).toBe("locked");
    await w.session.set({ vk: "###not base64###", lastActive: w.t.now });
    expect((await w.svc.status()).state).toBe("locked");
    void fromB64;
  });
});

describe("recovery is visible through the service", () => {
  it("a damaged active slot shows up as an event and the data is still there", async () => {
    const w = setup({ mirror: true });
    await createProtected(w.svc);
    await add(w.svc, "A");
    await add(w.svc, "B");
    const ptr = w.kv.data.get(KEYS.active) as string;
    w.kv.data.set(ptr === "a" ? KEYS.slot.a : KEYS.slot.b, "garbage");
    const s = await w.fresh().status();
    expect(s.state).toBe("unlocked");
    expect((s as any).events.map((e: any) => e.kind)).toEqual(["slot_fallback"]);
  });
});

describe("lock every time", () => {
  it("never writes the key to shared session storage, so closing the popup is the lock", async () => {
    const { RoutedSession } = await import("../../src/platform/session");
    const kv = new MemoryKV();
    const settings = new KvSettingsStore(kv);
    const shared = new MemorySession();
    const ctxA = new RoutedSession(shared, settings); // one popup
    const mk = (session: any) =>
      new VaultService({ store: new VaultStore({ lock: createMutex(), kv }), session, settings });
    const a = mk(ctxA);
    await createProtected(a);
    await a.updateSettings({ autoLock: { mode: "always" }, lockOnScreenLock: true });
    await a.unlockWithPassword(STRONG);
    expect((await a.status()).state).toBe("unlocked");
    expect(await shared.get()).toBeNull(); // nothing for another context (or a service worker) to find
    const ctxB = mk(new RoutedSession(shared, settings)); // the next popup
    expect((await ctxB.status()).state).toBe("locked");
  });
  it("switching to it while unlocked locks immediately", async () => {
    const w = setup();
    await createProtected(w.svc);
    expect((await w.svc.status()).state).toBe("unlocked");
    await w.svc.updateSettings({ autoLock: { mode: "always" }, lockOnScreenLock: true });
    expect((await w.svc.status()).state).toBe("locked");
  });
});

describe("a crash right after turning on the password", () => {
  it("the next self-check overwrites a slot or mirror copy that still has the device key, without needing any key", async () => {
    const w = setup({ mirror: true });
    await legacyDeviceVault(w.store());
    await add(w.svc, "A");
    const old = structuredClone(Object.fromEntries(w.kv.data));
    const oldDeviceKey = ((old[KEYS.slot.a] ?? old[KEYS.slot.b]) as any).keyring.deviceKey as string;
    await w.svc.enableMasterPassword(STRONG, NO_PAGE);
    const ptr = w.kv.data.get(KEYS.active) as "a" | "b";
    const otherKey = ptr === "a" ? KEYS.slot.b : KEYS.slot.a;
    w.kv.data.set(otherKey, old[KEYS.slot.a] ?? old[KEYS.slot.b]);
    w.mirror!.data.set(KEYS.mirrorGen, old[KEYS.slot.a] ?? old[KEYS.slot.b]);
    expect(all(w.kv)).toContain(oldDeviceKey);
    await new VaultStore({ lock: createMutex(), kv: w.kv, mirror: w.mirror!, now: () => w.t.now }).selfCheck();
    expect((w.kv.data.get(otherKey) as any).keyring.deviceKey).toBeUndefined();
    expect(all(w.mirror!)).not.toContain(oldDeviceKey);
  });
});

// ---- H1: the master password comes before anything is written (PHASE0X-PLAN A1) ------------------------------------

/** Unreadable stored data with no key material in it at all: what startOver and a restore over "lost" start from. */
function lostStore(kv: MemoryKV) {
  kv.data.set(KEYS.active, "a");
  kv.data.set(KEYS.slot.a, "garbage");
  kv.data.set(KEYS.slot.b, { torn: "half a write" });
}
const backupOf = (vaultId: string) =>
  addEntry(emptyVault(vaultId), input("Bank"), createClock("bbbb", { now: () => 1_700_000_000_000 })).vault;

describe("prepared keys: the password first, nothing written before the vault itself", () => {
  it("prepareKeys refuses a weak password and writes nothing", async () => {
    const w = setup({ mirror: true });
    for (const pw of ["short", "aaaaaaaaaaaaaaaa", "abcdefghijklmnop", "password"]) {
      await expect(w.svc.prepareKeys(pw)).rejects.toMatchObject({ code: "weak_password" });
    }
    expect([...w.kv.data.keys()]).toEqual([]);
    expect([...w.mirror!.data.keys()]).toEqual([]);
    expect(await w.session.get()).toBeNull();
  });

  it("prepareKeys for a good password still writes nothing; only create does", async () => {
    const w = setup({ mirror: true });
    const keys = await w.svc.prepareKeys(STRONG);
    expect(keys.recoveryCode).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect([...w.kv.data.keys()]).toEqual([]);
    expect([...w.mirror!.data.keys()]).toEqual([]);
    expect(await w.session.get()).toBeNull();
    expect((await w.svc.status()).state).toBe("empty"); // the page closing here leaves a fresh install
    await w.svc.create(keys);
    expect((await w.svc.status()).state).toBe("unlocked");
  });

  it("the handle carries the recovery code and the vault id, and no key material", async () => {
    const w = setup();
    const keys = await w.svc.prepareKeys(STRONG);
    expect(Object.keys(keys).sort()).toEqual(["recoveryCode", "vaultId"]);
    expect(Object.isFrozen(keys)).toBe(true);
    await w.svc.create(keys);
    const gen = (await w.svc.currentGeneration())!;
    expect(gen.keyring.vaultId).toBe(keys.vaultId);
    expect(JSON.stringify(keys)).not.toContain(gen.keyring.wraps[0]!.wrapped);
  });

  it("create leaves no device key and no device wrap anywhere in storage; the keyring is password + recovery only", async () => {
    const w = setup({ mirror: true });
    await createProtected(w.svc);
    await add(w.svc, "GitHub");
    await w.store().ensureDailySnapshot(); // every redundancy path has run: slots, snapshots, keyring copy, mirror, daily
    await w.store().selfCheck();
    expect(deviceMaterial(w.kv, w.mirror!)).toEqual([]);
    expect(allStored(w.kv)).not.toContain("deviceKey");
    expect(allStored(w.mirror!)).not.toContain("deviceKey");
    const gen = (await w.svc.currentGeneration())!;
    expect(gen.keyring.wraps.map((x) => x.method).sort()).toEqual(["password", "recovery"]);
    expect(gen.keyring.previous).toEqual([]);
    expect(gen.envelope.vkId).toBe(gen.keyring.vkId);
    expect(validateKeyring(structuredClone(gen.keyring))).toBeTruthy();
  });

  it("the password and the recovery code both open it, and the wraps are bound to this vault", async () => {
    const w = setup();
    const { recoveryCode } = await createProtected(w.svc);
    await add(w.svc, "GitHub");
    await w.svc.lock();
    await expect(w.svc.unlockWithPassword(STRONG2)).rejects.toMatchObject({ code: "wrong_secret" });
    await w.svc.unlockWithPassword(STRONG);
    await w.svc.lock();
    await w.svc.unlockWithRecoveryCode(recoveryCode);
    expect(aliveEntries((await w.svc.read()).vault).map((e) => e.issuer)).toEqual(["GitHub"]);
    // AAD binding: the same wraps moved to another vault id do not open
    const { unlockWithPassword, unlockWithRecoveryCode } = await import("../../src/core/crypto/keyring");
    const k = (await w.svc.currentGeneration())!.keyring;
    await expect(unlockWithPassword({ ...k, vaultId: "another-vault-01" }, STRONG)).rejects.toMatchObject({
      code: "unwrap_failed",
    });
    await expect(unlockWithRecoveryCode({ ...k, vaultId: "another-vault-01" }, recoveryCode)).rejects.toMatchObject({
      code: "unwrap_failed",
    });
  });

  it("a handle is spent once its write commits: it opens nothing anywhere else", async () => {
    const a = setup();
    const keys = await a.svc.prepareKeys(STRONG);
    await a.svc.create(keys);
    const b = setup(); // another, empty install: the call would succeed with fresh keys
    await expect(b.svc.create(keys)).rejects.toMatchObject({ code: "bad_state" });
    await expect(b.svc.restoreBackup(backupOf(keys.vaultId), keys)).rejects.toMatchObject({ code: "bad_state" });
    const c = setup();
    lostStore(c.kv);
    await expect(c.svc.startOver(keys)).rejects.toMatchObject({ code: "bad_state" });
    expect((await b.svc.status()).state).toBe("empty");
    expect((await c.svc.status()).state).toBe("lost");
    expect(await b.session.get()).toBeNull();
  });

  it("a refused write does not spend the handle, so a retry commits the recovery code the user already saved", async () => {
    const taken = setup();
    await createProtected(taken.svc);
    const keys = await taken.svc.prepareKeys(STRONG2);
    await expect(taken.svc.create(keys)).rejects.toMatchObject({ code: "bad_state" });
    const w = setup();
    await w.svc.create(keys);
    await w.svc.lock();
    await w.svc.unlockWithRecoveryCode(keys.recoveryCode);
  });

  it("restoreBackup refuses keys prepared for another vault id, and writes nothing", async () => {
    const w = setup({ mirror: true });
    const keys = await w.svc.prepareKeys(STRONG); // a random vault id, not the backup's
    await expect(w.svc.restoreBackup(backupOf("backup-vault-id-1"), keys)).rejects.toMatchObject({ code: "bad_state" });
    expect([...w.kv.data.keys()]).toEqual([]);
    expect([...w.mirror!.data.keys()]).toEqual([]);
    await expect(w.svc.prepareKeys(STRONG, { vaultId: "bad id!" })).rejects.toMatchObject({ code: "invalid_keyring" });
  });

  it("restoreBackup and startOver write no device material either, onto an empty store or over unreadable data", async () => {
    const cases: [string, (w: ReturnType<typeof setup>) => Promise<{ vaultId: string; entries: number }>][] = [
      [
        "restore, fresh install",
        async (w) => {
          const keys = await w.svc.prepareKeys(STRONG, { vaultId: "backup-vault-id-1" });
          await w.svc.restoreBackup(backupOf("backup-vault-id-1"), keys);
          return { vaultId: "backup-vault-id-1", entries: 1 };
        },
      ],
      [
        "restore over unreadable data",
        async (w) => {
          lostStore(w.kv);
          const keys = await w.svc.prepareKeys(STRONG, { vaultId: "backup-vault-id-1" });
          await w.svc.restoreBackup(backupOf("backup-vault-id-1"), keys);
          return { vaultId: "backup-vault-id-1", entries: 1 };
        },
      ],
      [
        "start over",
        async (w) => {
          lostStore(w.kv);
          const keys = await w.svc.prepareKeys(STRONG);
          await w.svc.startOver(keys);
          return { vaultId: keys.vaultId, entries: 0 };
        },
      ],
    ];
    for (const [name, run] of cases) {
      const w = setup({ mirror: true });
      const want = await run(w);
      expect(await w.svc.status(), name).toMatchObject({ state: "unlocked", passwordProtected: true });
      const { vault } = await w.svc.read();
      expect(vault.vaultId, name).toBe(want.vaultId);
      expect(aliveEntries(vault), name).toHaveLength(want.entries);
      await add(w.svc, "Later");
      await w.store().ensureDailySnapshot();
      await w.store().selfCheck();
      expect(deviceMaterial(w.kv, w.mirror!), name).toEqual([]);
      expect(allStored(w.kv) + allStored(w.mirror!), name).not.toContain("deviceKey");
      expect((await w.svc.currentGeneration())!.keyring.wraps.map((x) => x.method).sort(), name).toEqual([
        "password",
        "recovery",
      ]);
    }
  });

  it("startOver is refused unless the stored data is unreadable", async () => {
    const w = setup();
    await expect(w.svc.startOver(await w.svc.prepareKeys(STRONG))).rejects.toMatchObject({ code: "bad_state" }); // empty
    await createProtected(w.svc);
    await expect(w.svc.startOver(await w.svc.prepareKeys(STRONG2))).rejects.toMatchObject({ code: "bad_state" }); // readable
  });
});

// ---- H5: the first-run answer is saved before the key is (PHASE0X-PLAN A1) -----------------------------------------

describe("the first-run answer", () => {
  async function routed() {
    const { RoutedSession } = await import("../../src/platform/session");
    const kv = new MemoryKV();
    const settings = new KvSettingsStore(kv);
    const shared = new MemorySession(); // chrome.storage.session: what every other context can see
    const lock = createMutex(); // navigator.locks: one lock for every context
    const page = (session = new RoutedSession(shared, settings)) =>
      new VaultService({ store: new VaultStore({ kv, lock }), session, settings });
    return { kv, settings, shared, page };
  }

  it("'shared or automated': lock every time and hide codes, and the setup page is still unlocked, with the key only in its memory", async () => {
    const w = await routed();
    const tab = w.page();
    await tab.create(await tab.prepareKeys(STRONG), { preset: "shared" });
    expect(await w.settings.get()).toMatchObject({
      autoLock: { mode: "always" },
      lockOnScreenLock: true,
      display: { hideCodes: true },
    });
    expect((await tab.status()).state).toBe("unlocked"); // step 4, adding the first account, needs this
    expect(await w.shared.get()).toBeNull(); // nothing for the service worker or another page to find
    expect((await w.page().status()).state).toBe("locked"); // the next popup
  });

  it("why the order matters: the same answer saved after the vault would lock the user out before the first account", async () => {
    const w = await routed();
    const tab = w.page();
    await tab.create(await tab.prepareKeys(STRONG)); // key saved under the default (idle) mode
    await tab.updateSettings(applyPreset(await tab.getSettings(), "shared"));
    expect((await tab.status()).state).toBe("locked");
  });

  it("'only me': 15 idle minutes or screen lock, codes shown, the key shared with the popup", async () => {
    const w = await routed();
    await w.settings.set({ autoLock: { mode: "session" }, lockOnScreenLock: false });
    const tab = w.page();
    await tab.create(await tab.prepareKeys(STRONG), { preset: "standard" });
    expect(await w.settings.get()).toMatchObject({
      autoLock: { mode: "idle", minutes: 15 },
      lockOnScreenLock: true,
      display: { hideCodes: false },
    });
    expect(await w.shared.get()).not.toBeNull();
    expect((await w.page().status()).state).toBe("unlocked");
  });

  it("restoreBackup and startOver save the answer the same way", async () => {
    for (const how of ["restore", "startOver"] as const) {
      const w = await routed();
      const tab = w.page();
      if (how === "restore")
        await tab.restoreBackup(
          backupOf("backup-vault-id-1"),
          await tab.prepareKeys(STRONG, { vaultId: "backup-vault-id-1" }),
          { preset: "shared" },
        );
      else {
        lostStore(w.kv);
        await tab.startOver(await tab.prepareKeys(STRONG), { preset: "shared" });
      }
      expect((await w.settings.get()).autoLock, how).toEqual({ mode: "always" });
      expect((await tab.status()).state, how).toBe("unlocked");
      expect(await w.shared.get(), how).toBeNull();
    }
  });

  it("a second setup page that loses the race changes nothing: not the vault, not the answer, not the winner's session", async () => {
    const w = await routed();
    const first = w.page();
    const second = w.page();
    const [k1, k2] = await Promise.all([first.prepareKeys(STRONG), second.prepareKeys(STRONG2)]);
    // Both pass the "no vault yet" check before either writes; the lock decides.
    const results = await Promise.allSettled([
      first.create(k1, { preset: "standard" }),
      second.create(k2, { preset: "shared" }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: "bad_state" });
    expect((await w.settings.get()).autoLock).toEqual({ mode: "idle", minutes: 15 });
    expect((await first.status()).state).toBe("unlocked");
    expect((await first.currentGeneration())!.keyring.vaultId).toBe(k1.vaultId);
  });
});

// ---- a write that landed but reported a failure (A1 review F1) -----------------------------------------------------

/** The slot write lands, then the read-back of that slot throws once (a passing I/O error). */
class ReadBackFails implements KV {
  armed = false;
  fired = false;
  constructor(readonly inner: MemoryKV) {}
  async get(k: string[]) {
    if (this.armed && !this.fired && k.includes(KEYS.slot.a)) {
      this.fired = true;
      throw new Error("io error on read-back");
    }
    return this.inner.get(k);
  }
  async keys() {
    return this.inner.keys();
  }
  async set(items: Record<string, unknown>) {
    await this.inner.set(items);
    if (KEYS.slot.a in items) this.armed = true;
  }
  async remove(k: string[]) {
    return this.inner.remove(k);
  }
}
class SessionSetFailsOnce extends MemorySession {
  failed = false;
  override async set(d: SessionData) {
    if (!this.failed) {
      this.failed = true;
      throw new Error("session storage failed");
    }
    return super.set(d);
  }
}

describe("a write that landed although it reported a failure: the retry finishes it, it is not 'refused'", () => {
  const flows: [
    string,
    boolean,
    (s: VaultService) => Promise<PreparedKeys>,
    (s: VaultService, k: PreparedKeys) => Promise<void>,
    number,
  ][] = [
    ["create", false, (s) => s.prepareKeys(STRONG), (s, k) => s.create(k, { preset: "shared" }), 0],
    [
      "restore, fresh install",
      false,
      (s) => s.prepareKeys(STRONG, { vaultId: "backup-vault-id-1" }),
      (s, k) => s.restoreBackup(backupOf("backup-vault-id-1"), k, { preset: "shared" }),
      1,
    ],
    [
      "restore over unreadable data",
      true,
      (s) => s.prepareKeys(STRONG, { vaultId: "backup-vault-id-1" }),
      (s, k) => s.restoreBackup(backupOf("backup-vault-id-1"), k, { preset: "shared" }),
      1,
    ],
    ["start over", true, (s) => s.prepareKeys(STRONG), (s, k) => s.startOver(k, { preset: "shared" }), 0],
  ];

  it.each(flows)("%s: the read-back after the slot write fails once", async (_name, lost, prepare, run, entries) => {
    const mem = new MemoryKV();
    if (lost) lostStore(mem);
    const settings = new KvSettingsStore(mem);
    const session = new MemorySession();
    const svc = new VaultService({
      store: new VaultStore({ lock: createMutex(), kv: new ReadBackFails(mem) }),
      session,
      settings,
    });
    const keys = await prepare(svc);
    await expect(run(svc, keys)).rejects.toThrow("io error on read-back"); // what the page saw: an error, not success
    await run(svc, keys); // the retry recognises its own vault: done, not "changed in another page"
    expect((await svc.status()).state).toBe("unlocked");
    expect((await settings.get()).autoLock).toEqual({ mode: "always" });
    const fresh = new VaultService({
      store: new VaultStore({ lock: createMutex(), kv: mem }),
      session: new MemorySession(),
      settings,
    });
    await fresh.unlockWithRecoveryCode(keys.recoveryCode); // the code the user saved is the live one
    expect((await fresh.currentGeneration())!.keyring.vaultId).toBe(keys.vaultId);
    expect(aliveEntries((await fresh.read()).vault)).toHaveLength(entries);
    await expect(svc.create(keys)).rejects.toMatchObject({ code: "bad_state" }); // and now the keys are spent
  });

  it.each(flows)("%s: storing the session fails after the commit", async (_name, lost, prepare, run) => {
    const kv = new MemoryKV();
    if (lost) lostStore(kv);
    const svc = new VaultService({
      store: new VaultStore({ lock: createMutex(), kv }),
      session: new SessionSetFailsOnce(),
      settings: new KvSettingsStore(kv),
    });
    const keys = await prepare(svc);
    await expect(run(svc, keys)).rejects.toThrow("session storage failed");
    const seq = (await svc.currentGeneration())!.seq;
    await run(svc, keys); // the keys were not spent: the retry unlocks the vault it already wrote
    expect((await svc.status()).state).toBe("unlocked");
    expect((await svc.currentGeneration())!.seq).toBe(seq); // without writing it again
  });

  it("two calls with the same keys at once (a double click): one vault, written once, both succeed", async () => {
    const w = setup();
    const keys = await w.svc.prepareKeys(STRONG);
    const results = await Promise.allSettled([w.svc.create(keys), w.svc.create(keys)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await w.svc.currentGeneration())!.seq).toBe(1);
  });

  it("a vault made with other keys is still refused", async () => {
    const w = setup();
    await createProtected(w.svc);
    await expect(w.svc.create(await w.svc.prepareKeys(STRONG2))).rejects.toMatchObject({ code: "bad_state" });
  });
});

// ---- create never overwrites unreadable data (A1 review F3) --------------------------------------------------------

describe("create over unreadable data", () => {
  it("is refused before the lock, and nothing changes on disk", async () => {
    const w = setup({ mirror: true });
    lostStore(w.kv);
    const before = allStored(w.kv) + allStored(w.mirror!);
    await expect(w.svc.create(await w.svc.prepareKeys(STRONG), { preset: "shared" })).rejects.toMatchObject({
      code: "bad_state",
    });
    expect(allStored(w.kv) + allStored(w.mirror!)).toBe(before);
    expect((await w.svc.status()).state).toBe("lost");
  });
  it("is refused inside the lock too, if the data became unreadable after the check", async () => {
    const w = setup({ mirror: true });
    lostStore(w.kv);
    const before = allStored(w.kv) + allStored(w.mirror!);
    class StaleFirstLoad extends VaultStore {
      // the first look (outside the lock) still saw an empty install
      first = true;
      override load() {
        if (this.first) {
          this.first = false;
          return Promise.resolve({ status: "empty" as const });
        }
        return super.load();
      }
    }
    const svc = new VaultService({
      store: new StaleFirstLoad({ lock: createMutex(), kv: w.kv, mirror: w.mirror! }),
      session: w.session,
      settings: w.settings,
    });
    await expect(svc.create(await svc.prepareKeys(STRONG), { preset: "shared" })).rejects.toMatchObject({
      code: "lost_needs_confirm",
    });
    expect(allStored(w.kv) + allStored(w.mirror!)).toBe(before); // not even the answer was saved
  });
});

// ---- H3 + H6: asking for the password again, and the local security log (PHASE0X-PLAN A3) ---------------------------

/** A session that records every call made to it: verifyPassword must make none. */
class SpySession implements SessionCache {
  calls: string[] = [];
  constructor(readonly inner: SessionCache) {}
  async get() {
    this.calls.push("get");
    return this.inner.get();
  }
  async set(d: SessionData) {
    this.calls.push("set");
    return this.inner.set(d);
  }
  async clear() {
    this.calls.push("clear");
    return this.inner.clear();
  }
  async lockEpoch() {
    this.calls.push("lockEpoch");
    return this.inner.lockEpoch();
  }
  async bumpLockEpoch() {
    this.calls.push("bumpLockEpoch");
    return this.inner.bumpLockEpoch();
  }
  async getQuick() {
    this.calls.push("getQuick");
    return this.inner.getQuick();
  }
  async setQuick(q: Parameters<SessionCache["setQuick"]>[0]) {
    this.calls.push("setQuick");
    return this.inner.setQuick(q);
  }
  async clearQuick() {
    this.calls.push("clearQuick");
    return this.inner.clearQuick();
  }
}
/** A KV that counts every call, for "this touched the log not at all". */
class CountingKV extends MemoryKV {
  calls = 0;
  override async get(keys: string[]) {
    this.calls++;
    return super.get(keys);
  }
  override async set(items: Record<string, unknown>) {
    this.calls++;
    return super.set(items);
  }
  override async remove(keys: string[]) {
    this.calls++;
    return super.remove(keys);
  }
}
/** A KV where everything fails, as storage can for good. */
class DeadKV extends MemoryKV {
  override async get(): Promise<Record<string, unknown>> {
    throw Object.assign(new Error("Internal error"), { name: "UnknownError" });
  }
  override async set(): Promise<void> {
    throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
  }
}

describe("H3 and H6: verifyPassword and the local security log", () => {
  function logged(opts: { mirror?: boolean; logKv?: KV; security?: SecurityRecorder } = {}) {
    const w = setup(opts);
    const diag: string[] = [];
    const onDiag = (m: string) => {
      diag.push(m);
    };
    const log = new SecurityLog({ kv: opts.logKv ?? w.kv, now: () => w.t.now, onDiag });
    const make = (session: SessionCache = w.session) =>
      new VaultService({
        store: w.store(),
        session,
        settings: w.settings,
        now: () => w.t.now,
        onDiag,
        security: opts.security ?? log,
      });
    return { ...w, log, diag, svc: make(), make };
  }
  const kinds = async (log: SecurityLog) => (await log.read()).entries.map((e) => e.kind).reverse(); // oldest first
  const WRONG_CODE = "0000-0000-0000-0000-0000-0000-00VM"; // well-formed, opens nothing
  const GUESS = "orchid-tram-velvet-77";
  const withoutLog = (m: MemoryKV) => JSON.stringify([...m.data.entries()].filter(([k]) => k !== SECURITY_LOG_KEY));

  it("wrong passwords and recovery codes at the lock screen are recorded and counted; a malformed code is a typo, not a guess", async () => {
    const w = logged();
    const { recoveryCode } = await createProtected(w.svc);
    await w.svc.lock();
    for (let i = 0; i < 3; i++)
      await expect(w.svc.unlockWithPassword(GUESS)).rejects.toMatchObject({ code: "wrong_secret" });
    await expect(w.svc.unlockWithRecoveryCode(WRONG_CODE)).rejects.toMatchObject({ code: "wrong_secret" });
    await expect(w.svc.unlockWithRecoveryCode("not a code")).rejects.toMatchObject({ code: "recovery_length" });
    expect(await kinds(w.log)).toEqual(["unlock_failed", "unlock_failed", "unlock_failed", "recovery_failed"]);
    expect(await w.log.failuresSinceAck()).toBe(4);
    await w.svc.unlockWithPassword(STRONG); // adds nothing
    await w.svc.lock();
    await w.svc.unlockWithRecoveryCode(recoveryCode);
    expect(await kinds(w.log)).toEqual([
      "unlock_failed",
      "unlock_failed",
      "unlock_failed",
      "recovery_failed",
      "recovery_used",
    ]);
    expect(await w.log.failuresSinceAck()).toBe(4);
  });

  it("a successful password unlock, and the next open, neither read nor write the log (the popup's read budget has no room)", async () => {
    const logKv = new CountingKV();
    const w = logged({ logKv });
    await createProtected(w.svc);
    await w.svc.lock();
    await expect(w.svc.unlockWithPassword(GUESS)).rejects.toMatchObject({ code: "wrong_secret" });
    const before = logKv.calls;
    expect(before).toBeGreaterThan(0);
    await w.svc.unlockWithPassword(STRONG);
    expect((await w.make().openView()).state).toBe("unlocked");
    expect(logKv.calls).toBe(before);
  });

  it("each key change is recorded once it has happened; a wrong password or code for one is counted and writes nothing of the vault", async () => {
    const w = logged({ mirror: true });
    await legacyDeviceVault(w.store());
    await add(w.svc, "GitHub");
    // refusals that are not a wrong guess are not recorded
    await expect(w.svc.rotateKey(STRONG, NO_PAGE)).rejects.toMatchObject({ code: "not_protected" });
    await expect(w.svc.changePassword(STRONG, STRONG2)).rejects.toMatchObject({ code: "not_protected" });
    expect(w.kv.data.has(SECURITY_LOG_KEY)).toBe(false);
    const enabled = { recoveryCode: await codeOf((d) => w.svc.enableMasterPassword(STRONG, d)) };
    const g0 = JSON.stringify(await w.svc.currentGeneration());
    await expect(w.svc.changePassword(GUESS, STRONG2)).rejects.toMatchObject({ code: "wrong_secret" });
    await expect(w.svc.rotateKey(GUESS, NO_PAGE)).rejects.toMatchObject({ code: "wrong_secret" });
    expect(JSON.stringify(await w.svc.currentGeneration())).toBe(g0);
    await expect(w.svc.changePassword(STRONG, "weak")).rejects.toMatchObject({ code: "weak_password" }); // no guess made
    await w.svc.changePassword(STRONG, STRONG2);
    await w.svc.rotateKey(STRONG2, NO_PAGE);
    const fresh = { recoveryCode: await codeOf((d) => w.svc.newRecoveryCode(STRONG2, d)) };
    await w.svc.lock();
    const g1 = JSON.stringify(await w.svc.currentGeneration());
    await expect(resetWithCode(w.svc, enabled.recoveryCode, STRONG)).rejects.toMatchObject({ code: "wrong_secret" }); // replaced since
    expect(JSON.stringify(await w.svc.currentGeneration())).toBe(g1);
    await resetWithCode(w.svc, fresh.recoveryCode, STRONG);
    // (A4: the reset runs in two steps, as the settings tab does it; the accepted code is recorded at the first)
    expect(await kinds(w.log)).toEqual([
      "password_enabled",
      "unlock_failed",
      "unlock_failed",
      "password_changed",
      "key_rotated",
      "recovery_code_new",
      "recovery_failed",
      "recovery_used",
      "password_reset",
    ]);
    expect(await w.log.failuresSinceAck()).toBe(3);
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false); // the key changes still finished their cleanup
  });

  it("verifyPassword: the right password resolves, and nothing changes at all; the session is not even asked", async () => {
    const w = logged({ mirror: true });
    await createProtected(w.svc);
    await add(w.svc, "GitHub");
    const session = new SpySession(w.session);
    const svc = w.make(session);
    const snap = () => ({
      kv: allStored(w.kv),
      mirror: allStored(w.mirror!),
      session: JSON.stringify(w.session.data),
      epoch: w.session.epoch,
    });
    const before = snap();
    await expect(svc.verifyPassword(STRONG)).resolves.toBeUndefined();
    await expect(svc.verifyPassword(STRONG.normalize("NFKD"))).resolves.toBeUndefined(); // the same text, as unlock reads it
    expect(snap()).toEqual(before);
    expect(session.calls).toEqual([]);
    expect(w.diag).toEqual([]);
  });

  it("verifyPassword: anything else is wrong_secret and recorded as a wrong password; that entry is the only write; the password is stored nowhere", async () => {
    const w = logged({ mirror: true });
    await createProtected(w.svc);
    const session = new SpySession(w.session);
    const svc = w.make(session);
    const before = {
      kv: withoutLog(w.kv),
      mirror: allStored(w.mirror!),
      session: JSON.stringify(w.session.data),
      epoch: w.session.epoch,
    };
    for (const pw of [GUESS, STRONG + " ", STRONG.toUpperCase(), STRONG.slice(0, -1)]) {
      await expect(svc.verifyPassword(pw), JSON.stringify(pw)).rejects.toMatchObject({ code: "wrong_secret" });
    }
    expect({
      kv: withoutLog(w.kv),
      mirror: allStored(w.mirror!),
      session: JSON.stringify(w.session.data),
      epoch: w.session.epoch,
    }).toEqual(before);
    expect(session.calls).toEqual([]);
    expect(await kinds(w.log)).toEqual(Array(4).fill("unlock_failed"));
    expect(await w.log.failuresSinceAck()).toBe(4);
    expect((await svc.status()).state).toBe("unlocked"); // still unlocked: a wrong check locks nothing
    const everything = allStored(w.kv) + allStored(w.mirror!) + w.diag.join("\n");
    for (const secret of [GUESS, STRONG, STRONG.slice(0, 8)]) expect(everything).not.toContain(secret);
  });

  it("verifyPassword asks for the master password only: the recovery code is a wrong password there (and counted)", async () => {
    const w = logged();
    const { recoveryCode } = await createProtected(w.svc);
    await expect(w.svc.verifyPassword(recoveryCode)).rejects.toMatchObject({ code: "wrong_secret" });
    await expect(w.svc.verifyPassword(recoveryCode.replace(/-/g, ""))).rejects.toMatchObject({ code: "wrong_secret" });
    expect(await kinds(w.log)).toEqual(["unlock_failed", "unlock_failed"]);
  });

  it("an empty password is a typo, not a guess, at both prompts: the same empty_password error, and nothing recorded", async () => {
    const w = logged();
    await createProtected(w.svc);
    await expect(w.svc.verifyPassword("")).rejects.toMatchObject({ code: "empty_password" });
    await w.svc.lock();
    await expect(w.svc.unlockWithPassword("")).rejects.toMatchObject({ code: "empty_password" });
    expect(w.kv.data.has(SECURITY_LOG_KEY)).toBe(false);
  });

  it("verifyPassword works the same while locked, and in 'lock every time' mode with the key in another page's memory", async () => {
    const { RoutedSession } = await import("../../src/platform/session");
    const w = logged();
    const shared = new MemorySession();
    const spy = new SpySession(shared);
    const pageA = w.make(new RoutedSession(spy, w.settings)); // the settings page, unlocked
    await createProtected(pageA);
    await pageA.updateSettings({ autoLock: { mode: "always" }, lockOnScreenLock: true });
    await pageA.unlockWithPassword(STRONG);
    const pageB = w.make(new RoutedSession(spy, w.settings)); // another page: locked
    expect((await pageB.status()).state).toBe("locked");
    spy.calls = [];
    const epoch = shared.epoch;
    await expect(pageA.verifyPassword(STRONG)).resolves.toBeUndefined();
    await expect(pageB.verifyPassword(STRONG)).resolves.toBeUndefined();
    await expect(pageB.verifyPassword(GUESS)).rejects.toMatchObject({ code: "wrong_secret" });
    expect(spy.calls).toEqual([]);
    expect(shared.epoch).toBe(epoch);
    expect(await shared.get()).toBeNull();
    expect((await pageA.status()).state).toBe("unlocked");
    expect((await pageB.status()).state).toBe("locked");
    expect(await w.log.failuresSinceAck()).toBe(1);
  });

  it("verifyPassword: a Phase 0 device-key vault is not_protected and nothing is written; no vault or unreadable data is bad_state", async () => {
    const w = logged({ mirror: true });
    await expect(w.svc.verifyPassword(STRONG)).rejects.toMatchObject({ code: "bad_state" });
    await legacyDeviceVault(w.store());
    const before = allStored(w.kv) + allStored(w.mirror!);
    await expect(w.svc.verifyPassword(STRONG)).rejects.toMatchObject({ code: "not_protected" });
    await expect(w.svc.verifyPassword("")).rejects.toMatchObject({ code: "not_protected" });
    expect(allStored(w.kv) + allStored(w.mirror!)).toBe(before);
    expect(w.kv.data.has(SECURITY_LOG_KEY)).toBe(false);
    const l = logged();
    lostStore(l.kv);
    expect((await l.svc.status()).state).toBe("lost");
    await expect(l.svc.verifyPassword(STRONG)).rejects.toMatchObject({ code: "bad_state" });
    await expect(l.svc.verifyPassword(GUESS)).rejects.toMatchObject({ code: "bad_state" });
    expect(l.kv.data.has(SECURITY_LOG_KEY)).toBe(false); // nothing to check against, so no wrong guess either
  });

  it("recordExport adds the export's kind, and ignores anything that is not one", async () => {
    const w = logged();
    await createProtected(w.svc);
    await w.svc.recordExport("plain");
    await w.svc.recordExport("encrypted");
    await w.svc.recordExport("subset");
    await w.svc.recordExport("everything" as never);
    expect(await kinds(w.log)).toEqual(["export_plain", "export_encrypted", "export_subset"]);
    expect((w.kv.data.get(SECURITY_LOG_KEY) as { entries: { kind: string }[] }).entries.map((e) => e.kind)).toEqual([
      "export_plain",
      "export_encrypted",
      "export_subset",
    ]);
    expect(await w.log.failuresSinceAck()).toBe(0);
  });

  it("a log that cannot be written never fails what it records, nor changes what the caller is told", async () => {
    for (const [name, opts] of [
      ["storage that fails", { logKv: new DeadKV() }],
      [
        "a recorder that rejects",
        {
          security: {
            append: () => Promise.reject(new Error("broken")),
            clear: () => Promise.reject(new Error("broken")),
          },
        },
      ],
    ] as const) {
      const w = logged(opts);
      const { recoveryCode } = await createProtected(w.svc);
      await add(w.svc, "GitHub");
      await w.svc.lock();
      await expect(w.svc.unlockWithPassword(GUESS), name).rejects.toMatchObject({ code: "wrong_secret" });
      await expect(w.svc.unlockWithRecoveryCode(WRONG_CODE), name).rejects.toMatchObject({ code: "wrong_secret" });
      await w.svc.unlockWithRecoveryCode(recoveryCode);
      await expect(w.svc.verifyPassword(GUESS), name).rejects.toMatchObject({ code: "wrong_secret" });
      await w.svc.verifyPassword(STRONG);
      await expect(w.svc.changePassword(GUESS, STRONG2), name).rejects.toMatchObject({ code: "wrong_secret" });
      await w.svc.changePassword(STRONG, STRONG2);
      const r = { recoveryCode: await codeOf((d) => w.svc.rotateKey(STRONG2, d)) };
      await w.svc.newRecoveryCode(STRONG2, NO_PAGE);
      await w.svc.recordExport("plain");
      await w.svc.lock();
      await expect(resetWithCode(w.svc, r.recoveryCode, STRONG), name).rejects.toMatchObject({ code: "wrong_secret" });
      const n = await w.svc.unlockWithPassword(STRONG2);
      expect(
        aliveEntries(n.view.vault).map((e) => e.issuer),
        name,
      ).toEqual(["GitHub"]);
      expect(w.kv.data.has(KEYS.keyChange), name).toBe(false);
      expect(w.diag.filter((m) => m === "security log entry not written").length, name).toBeGreaterThanOrEqual(10);
    }
  });

  it("is not the 'data restored' events: wrong passwords show no banner and push out no unread restore; acking one leaves the other", async () => {
    const w = logged({ mirror: true });
    await createProtected(w.svc);
    await add(w.svc, "A");
    const ptr = w.kv.data.get(KEYS.active) as string;
    w.kv.data.set(ptr === "a" ? KEYS.slot.a : KEYS.slot.b, "garbage"); // a real recovery, unread
    await w.svc.lock();
    for (let i = 0; i < 25; i++)
      await expect(w.svc.unlockWithPassword(GUESS)).rejects.toMatchObject({ code: "wrong_secret" });
    const v = (await w.svc.unlockWithPassword(STRONG)).view;
    expect(v.events.map((e) => e.kind)).toEqual(["slot_fallback"]);
    const events = JSON.stringify(w.kv.data.get(KEYS.events));
    await w.log.ack(25);
    await w.log.clear();
    expect(JSON.stringify(w.kv.data.get(KEYS.events))).toBe(events);
    const log = JSON.stringify(w.kv.data.get(SECURITY_LOG_KEY));
    await w.svc.ackEvents();
    expect(JSON.stringify(w.kv.data.get(SECURITY_LOG_KEY))).toBe(log);
    const next = await w.make().openView();
    expect(next.state).toBe("unlocked");
    expect(next.state === "unlocked" && next.events).toEqual([]);
  });

  it("is not vault data: a store holding only the log (and settings) is empty, and every way to a vault keeps the log as it was", async () => {
    const ways: [string, (w: ReturnType<typeof logged>) => Promise<void>][] = [
      [
        "create",
        async (w) => {
          await createProtected(w.svc);
        },
      ],
      [
        "restore over unreadable data",
        async (w) => {
          lostStore(w.kv);
          expect((await w.svc.status()).state).toBe("lost");
          await w.svc.restoreBackup(
            backupOf("backup-vault-id-1"),
            await w.svc.prepareKeys(STRONG, { vaultId: "backup-vault-id-1" }),
          );
        },
      ],
      [
        "start over",
        async (w) => {
          lostStore(w.kv);
          await w.svc.startOver(await w.svc.prepareKeys(STRONG));
        },
      ],
    ];
    for (const [name, run] of ways) {
      const w = logged({ mirror: true });
      await w.log.append("unlock_failed");
      await w.log.append("export_plain");
      await w.settings.set({ autoLock: { mode: "idle", minutes: 5 }, lockOnScreenLock: true });
      expect((await w.svc.status()).state, name).toBe("empty");
      expect((await w.svc.openView()).state, name).toBe("empty");
      const log = JSON.stringify(w.kv.data.get(SECURITY_LOG_KEY));
      await run(w);
      expect((await w.svc.status()).state, name).toBe("unlocked");
      // device history, not the vault's: no way to a vault clears it or adds to it
      expect(JSON.stringify(w.kv.data.get(SECURITY_LOG_KEY)), name).toBe(log);
    }
  });

  it("never reaches a backup: the encrypted backup and a merge of one carry none of it", async () => {
    const w = logged();
    await createProtected(w.svc);
    await add(w.svc, "GitHub");
    await w.svc.lock();
    await expect(w.svc.unlockWithPassword(GUESS)).rejects.toMatchObject({ code: "wrong_secret" });
    await w.svc.unlockWithPassword(STRONG);
    await w.svc.recordExport("encrypted");
    const file = await createBackup((await w.svc.read()).vault, STRONG2);
    const inside = JSON.stringify((await openBackup(file, STRONG2)).vault) + JSON.stringify(file);
    for (const s of [SECURITY_LOG_KEY, "unlock_failed", "export_encrypted", "failed"]) expect(inside).not.toContain(s);
    const log = JSON.stringify(w.kv.data.get(SECURITY_LOG_KEY));
    await w.svc.importBackup((await openBackup(file, STRONG2)).vault);
    expect(JSON.stringify(w.kv.data.get(SECURITY_LOG_KEY))).toBe(log);
  });

  it("a recovery code with a typo (bad checksum, wrong length) is not a guess, at the lock screen or for a reset", async () => {
    const w = logged();
    await createProtected(w.svc);
    await w.svc.lock();
    const BAD_CHECKSUM = "0000-0000-0000-0000-0000-0000-00VN"; // well-formed but for its check symbols
    await expect(w.svc.unlockWithRecoveryCode(BAD_CHECKSUM)).rejects.toMatchObject({ code: "recovery_checksum" });
    await expect(resetWithCode(w.svc, BAD_CHECKSUM, STRONG2)).rejects.toMatchObject({ code: "recovery_checksum" });
    await expect(resetWithCode(w.svc, "0000-0000", STRONG2)).rejects.toMatchObject({ code: "recovery_length" });
    expect(w.kv.data.has(SECURITY_LOG_KEY)).toBe(false);
  });

  it("a key operation that fails records nothing (a new recovery code while locked, a key change on no vault)", async () => {
    const w = logged();
    await expect(w.svc.newRecoveryCode(STRONG, NO_PAGE)).rejects.toMatchObject({ code: "bad_state" });
    await expect(w.svc.rotateKey(STRONG, NO_PAGE)).rejects.toMatchObject({ code: "bad_state" });
    await createProtected(w.svc);
    await w.svc.lock();
    await expect(w.svc.newRecoveryCode(STRONG, NO_PAGE)).rejects.toMatchObject({ code: "locked" });
    expect(w.kv.data.has(SECURITY_LOG_KEY)).toBe(false);
  });

  // A4 (GM2-1(a)): this test pinned "the call rejects" and checked only that the change was recorded. A session write
  // that fails after the commit is now logged and the call succeeds: the change was made, and a page told "failed" would
  // lose the new recovery code. So it asserts more: the code returned is the live one, the cleanup still ran, the
  // failure is in the diagnostics log, and a rotation's old key is not left in session storage.
  it("a key change that committed succeeds, is recorded, and returns its live code even when the session write after it fails", async () => {
    class FailingSet extends MemorySession {
      fail = false;
      override async set(d: SessionData) {
        if (this.fail) throw new Error("session storage unavailable");
        return super.set(d);
      }
    }
    const cases: [string, string, (svc: VaultService, code: string) => Promise<string | void>][] = [
      ["changePassword", "password_changed", (svc) => svc.changePassword(STRONG, STRONG2)],
      ["rotateKey", "key_rotated", (svc) => codeOf((d) => svc.rotateKey(STRONG, d))],
      ["resetPasswordWithRecovery", "password_reset", (svc, code) => resetWithCode(svc, code, STRONG2)],
    ];
    for (const [name, kind, run] of cases) {
      const w = logged();
      const session = new FailingSet();
      const svc = w.make(session);
      const { recoveryCode } = await createProtected(svc);
      const before = (await svc.currentGeneration())!.keyring;
      const oldVk = session.data!.vk;
      session.fail = true;
      const r = await run(svc, recoveryCode);
      const now = (await svc.currentGeneration())!;
      expect(JSON.stringify(now.keyring), name).not.toBe(JSON.stringify(before)); // it committed
      if (r) {
        const fresh = new VaultService({
          store: w.store(),
          session: new MemorySession(),
          settings: w.settings,
          now: () => w.t.now,
        });
        await expect(fresh.unlockWithRecoveryCode(r), name).resolves.toBeDefined(); // the code delivered is the live one
      }
      // (A4: the reset runs in two steps, as the settings tab does it; the accepted code is recorded at the first)
      expect(await kinds(w.log), name).toEqual(name === "resetPasswordWithRecovery" ? ["recovery_used", kind] : [kind]);
      expect(w.diag, name).toContain("session not stored after a key change");
      expect(w.kv.data.has(KEYS.keyChange), name).toBe(false); // and the cleanup after it still ran
      if (name === "rotateKey") expect(session.data?.vk, name).not.toBe(oldVk); // the old key is not left in session storage
    }
    // and the Phase 0 upgrade
    const w = logged();
    const session = new FailingSet();
    const svc = w.make(session);
    await legacyDeviceVault(w.store());
    session.fail = true;
    const recoveryCode = await codeOf((d) => svc.enableMasterPassword(STRONG, d));
    expect((await svc.currentGeneration())!.keyring.deviceKey).toBeUndefined();
    await expect(
      new VaultService({ store: w.store(), session: new MemorySession(), settings: w.settings }).unlockWithRecoveryCode(
        recoveryCode,
      ),
    ).resolves.toBeDefined();
    expect(await kinds(w.log)).toEqual(["password_enabled"]);
    expect(deviceMaterial(w.kv)).toEqual([]);
  });

  it("an accepted recovery code is recorded before the vault is opened, so it stays recorded if opening then fails", async () => {
    const w = logged();
    const { recoveryCode } = await createProtected(w.svc);
    await w.svc.lock();
    const broken: SettingsStore = {
      get: () => w.settings.get(),
      set: (x) => w.settings.set(x),
      deviceId: () => w.settings.deviceId(),
      getLastBackup: () => w.settings.getLastBackup(),
      setLastBackup: (x) => w.settings.setLastBackup(x),
      getView: () => Promise.reject(new Error("settings unreadable")),
    };
    const svc = new VaultService({
      store: w.store(),
      session: w.session,
      settings: broken,
      now: () => w.t.now,
      security: w.log,
    });
    await expect(svc.unlockWithRecoveryCode(recoveryCode)).rejects.toThrow("settings unreadable");
    expect(await kinds(w.log)).toEqual(["recovery_used"]);
  });

  it("clearing the log needs the master password: a wrong one is refused and recorded; locked or not, the right one clears it", async () => {
    const w = logged();
    await createProtected(w.svc);
    await w.svc.lock();
    for (let i = 0; i < 3; i++)
      await expect(w.svc.unlockWithPassword(GUESS)).rejects.toMatchObject({ code: "wrong_secret" });
    await expect(w.svc.clearSecurityLog(GUESS)).rejects.toMatchObject({ code: "wrong_secret" });
    await expect(w.svc.clearSecurityLog("")).rejects.toMatchObject({ code: "empty_password" });
    expect(await w.log.failuresSinceAck()).toBe(4); // the attempt to clear is itself a wrong guess
    expect(await kinds(w.log)).toEqual(Array(4).fill("unlock_failed"));
    await w.svc.clearSecurityLog(STRONG); // the owner, at a locked browser
    expect(await w.log.read()).toEqual({
      state: "ok",
      entries: [{ at: w.t.now, kind: "log_cleared" }],
      failed: 0,
      ackAt: null,
    });
    expect((await w.svc.status()).state).toBe("locked"); // proving the password unlocks nothing
  });

  it("clearing: a Phase 0 device-key vault has no password to ask for, so it clears; with no readable vault it is refused", async () => {
    const d = logged();
    await legacyDeviceVault(d.store());
    await d.svc.recordExport("plain");
    await d.svc.clearSecurityLog("");
    expect(await kinds(d.log)).toEqual(["log_cleared"]);
    const l = logged();
    await l.log.append("unlock_failed");
    lostStore(l.kv);
    await expect(l.svc.clearSecurityLog(STRONG)).rejects.toMatchObject({ code: "bad_state" });
    const e = logged();
    await e.log.append("unlock_failed");
    await expect(e.svc.clearSecurityLog(STRONG)).rejects.toMatchObject({ code: "bad_state" });
    for (const x of [l, e]) expect(await kinds(x.log)).toEqual(["unlock_failed"]);
  });

  it("the extension's own wiring records too: createRuntime gives the service the log, and the pages can read it", async () => {
    const { createRuntime } = await import("../../src/platform/runtime");
    const area = () => {
      const data = new Map<string, unknown>();
      return {
        data,
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
    };
    // navigator.locks as in the extension (Node has none, and webLock would fall back to a per-context mutex)
    const names: string[] = [];
    vi.stubGlobal("navigator", {
      locks: {
        request: (name: string, _o: unknown, fn: () => Promise<unknown>) => {
          names.push(name);
          return fn();
        },
      },
    });
    try {
      const local = area();
      const mirror = new MemoryKV();
      const rt = createRuntime({
        local: local as unknown as chrome.storage.StorageArea,
        session: area() as unknown as chrome.storage.StorageArea,
        mirror,
      });
      await rt.service.create(await rt.service.prepareKeys(STRONG));
      names.length = 0;
      await expect(rt.service.verifyPassword(GUESS)).rejects.toMatchObject({ code: "wrong_secret" });
      await rt.service.recordExport("plain");
      expect((await rt.security.recent(5)).map((e) => e.kind)).toEqual(["export_plain", "unlock_failed"]);
      expect(await rt.security.failuresSinceAck()).toBe(1);
      expect(local.data.get(SECURITY_LOG_KEY)).toMatchObject({ v: 2, failed: 1 }); // R8: version 2
      expect(mirror.data.has(SECURITY_LOG_KEY)).toBe(false); // local storage only, never the mirror
      expect(names.filter((n) => n === "sixkey-security-log")).toHaveLength(2); // one cross-context lock per entry
      // the pages can read and ack, but not clear: that is service.clearSecurityLog(password)
      expect(Object.keys(rt.security).sort()).toEqual(["ack", "failuresSinceAck", "read", "recent"]);
      expect("clear" in rt.security).toBe(false);
      await rt.service.clearSecurityLog(STRONG);
      expect((await rt.security.read()).entries.map((e) => e.kind)).toEqual(["log_cleared"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
