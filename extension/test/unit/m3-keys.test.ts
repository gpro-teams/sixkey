// M3, the key operations with sync on through the engine and the FakeServer (SYNC-DESIGN §3.6–§3.9, §3.6.0, §3.14,
// §8.1's M3 bullets): change the password, a new recovery code, rotate; other devices adopt (R2, R3, R4, R6); the GM2-5
// adopt-back end to end; N27's kver rollbacks; reconciliation after a lost answer; emergency revocation never blocked;
// the Phase 0 key operations refused while sync is on.
import { describe, expect, it } from "vitest";
import { unlockWithPassword, unlockWithRecoveryCode } from "../../src/core/crypto/keyring";
import { ServiceError } from "../../src/core/service/service-error";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import {
  adoptWithSecret,
  changePassword,
  commitRecoveryCode,
  commitRotation,
  KeyOpError,
  prepareRecoveryCode,
  prepareRotation,
  repairKeys,
  revokeDevice,
  turnSyncOff,
} from "../../src/core/sync/engine/keys";
import { aliveEntries } from "../../src/core/vault/model";
import { NO_PAGE } from "../helpers/vaults";
import { cj, EMAIL, quiesce, type Device, type World, worldOf } from "../helpers/m3-world";

const NEW_PW = "violet-harbour-cinder-93";
const opens = (k: Parameters<typeof unlockWithPassword>[0], pw: string) =>
  unlockWithPassword(k, pw).then(
    () => true,
    () => false,
  );
const opensCode = (k: Parameters<typeof unlockWithRecoveryCode>[0], c: string) =>
  unlockWithRecoveryCode(k, c).then(
    () => true,
    () => false,
  );
const keyWrites = (w: World) =>
  w.server.requests.filter((r) => (r.op === "PUT /v1/keys" || r.op === "POST /v1/keys/rotate") && r.status === 200)
    .length;
const two = async (names = ["GitHub"]) => {
  const w = await worldOf(2, names);
  return { w, a: w.devices[0]! as Device, b: w.devices[1]! as Device };
};
async function newCode(w: World, d: Device): Promise<string> {
  const h = await prepareRecoveryCode(d.engine, w.password);
  await commitRecoveryCode(d.engine, h);
  w.code = h.recoveryCode;
  return h.recoveryCode;
}

describe("§3.6 change the master password; R2 on the other device", () => {
  it("server first, then the local commit; the other device keeps syncing data and adopts once the new password is typed", async () => {
    const { w, a, b } = await two();
    const k0 = w.server.account(EMAIL).vault!.kver;
    await changePassword(a.engine, w.password, NEW_PW);
    expect(w.server.account(EMAIL).vault!.kver).toBe(k0 + 1);
    const ka = (await a.generation()).keyring;
    expect(await opens(ka, NEW_PW)).toBe(true);
    expect(await opens(ka, w.password)).toBe(false);
    // B: the bundle's password wrap is not B's: not adopted until B's user proves the new password (R2)
    w.advance(1000);
    await a.add("after the change");
    await a.engine.round();
    const r = await b.engine.round();
    expect(r.keyStatus).toBe("needs_new_password");
    expect(r.status).toBe("ok");
    expect(aliveEntries(await b.vault()).map((e) => e.issuer)).toContain("after the change");
    expect(await opens((await b.generation()).keyring, w.password)).toBe(true);
    expect(await adoptWithSecret(b.engine, { password: w.password })).toMatchObject({ kind: "local" }); // the old one only unlocks locally
    expect(await adoptWithSecret(b.engine, { password: NEW_PW })).toEqual({ kind: "adopted", sameVk: true });
    expect(cj((await b.generation()).keyring)).toBe(cj(ka));
    expect((await b.engine.round()).keyStatus).toBe("ok");
  });
});

describe("§3.7 a new recovery code; R2 adopts it at once elsewhere", () => {
  it("shown before it is sent; once accepted the old code no longer opens anything, the new one does on both devices", async () => {
    const { w, a, b } = await two();
    const old = w.code;
    const h = await prepareRecoveryCode(a.engine, w.password);
    expect(keyWrites(w)).toBe(0); // nothing sent before the user confirmed the code
    await commitRecoveryCode(a.engine, h);
    expect(await opensCode((await a.generation()).keyring, h.recoveryCode)).toBe(true);
    expect(await opensCode((await a.generation()).keyring, old)).toBe(false);
    expect((await a.engine.view()).state.pendingRecoveryWrap ?? null).toBeNull();
    await b.engine.round();
    expect(cj((await b.generation()).keyring)).toBe(cj((await a.generation()).keyring));
    expect((await b.engine.view()).state.notices?.some((n) => n.kind === "keys_changed")).toBe(true);
  });
});

describe("§3.8 rotate; R3/R4 on the other device", () => {
  it("rotate: the server's key, K_write and every device name (revoked too) move to VK2; the other device needs the password once, keeping its offline edits", async () => {
    const w = await worldOf(3, ["GitHub"]);
    const [a, b, c] = w.devices as [Device, Device, Device];
    await revokeDevice(a.engine, ((await c.local.settlePins()) as { deviceId: string }).deviceId, w.password);
    // B edits offline (under VK1) while A rotates
    b.net.partition(true);
    w.advance(1000);
    await b.add("offline on B");
    const h = await prepareRotation(a.engine, w.password);
    await commitRotation(a.engine, h);
    w.code = h.recoveryCode;
    const vk2 = (await a.generation()).keyring.vkId;
    expect(w.server.account(EMAIL).vault!.vk_id).toBe(vk2);
    for (const d of w.server.state(EMAIL).devices) expect(d.name_ct?.vkId, d.device_id).toBe(vk2); // C's too, though revoked
    b.net.partition(false);
    expect((await b.engine.round()).status).toBe("needs_password");
    expect(await adoptWithSecret(b.engine, { password: w.password })).toEqual({ kind: "adopted", sameVk: false });
    expect((await b.generation()).keyring.vkId).toBe(vk2);
    await quiesce(w, 8, [a, b]);
    expect(
      aliveEntries(await a.vault())
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["GitHub", "offline on B"]);
  });
});

describe("GM2-5 end to end (§8.1): the local commit lost behind the pins", () => {
  it("another VK: one password adopts the server's bundle in the R4 order (no confirm, no bad_mac or keys_behind); the edits made under the old VK are merged and uploaded", async () => {
    const { w, a, b } = await two();
    const oldCode = w.code;
    const before = new Map(a.disk.kv.data); // storage.local before the rotation's commit
    const h = await prepareRotation(a.engine, w.password);
    await commitRotation(a.engine, h);
    w.code = h.recoveryCode;
    const vk2 = (await a.generation()).keyring.vkId;
    // the power loss: storage.local loses its tail (the rotation's local commit), IndexedDB keeps the pins (VK2)
    a.disk.kv.data.clear();
    for (const [k, v] of before) a.disk.kv.data.set(k, structuredClone(v));
    await a.restartBrowser();
    expect(((await a.local.settlePins()) as { vkId: string }).vkId).toBe(vk2);
    expect((await a.generation()).keyring.vkId).not.toBe(vk2);
    expect((await a.engine.round()).status).toBe("needs_password"); // seen while locked
    await a.svc.unlockWithRecoveryCode(oldCode); // the popup unlocks the local vault as it is
    expect((await a.engine.round()).status).toBe("needs_password");
    w.advance(1000);
    await a.add("edited under VK1"); // local use goes on
    const r = await adoptWithSecret(a.engine, { password: w.password });
    expect(r).toEqual({ kind: "adopted", sameVk: false });
    expect((await a.generation()).keyring.vkId).toBe(vk2);
    expect((await a.engine.round()).keyStatus).toBe("ok");
    await b.engine.round();
    expect(await adoptWithSecret(b.engine, { password: w.password })).toEqual({ kind: "adopted", sameVk: false });
    await quiesce(w);
    expect(aliveEntries(await b.vault()).map((e) => e.issuer)).toContain("edited under VK1");
  });
  it("the same VK: the next round adopts back this device's own new recovery code (no repair offered), and records it", async () => {
    const { w, a } = await two();
    const before = new Map(a.disk.kv.data);
    const code = await newCode(w, a);
    a.disk.kv.data.clear();
    for (const [k, v] of before) a.disk.kv.data.set(k, structuredClone(v));
    a.restartWorker();
    expect(await opensCode((await a.generation()).keyring, code)).toBe(false); // the local keyring went back
    const r = await a.engine.round();
    expect(r.keyStatus).toBe("ok"); // not keys_behind: no repair offered
    expect(await opensCode((await a.generation()).keyring, code)).toBe(true);
    expect((await a.engine.view()).state.notices?.some((n) => n.kind === "keys_adopted")).toBe(true);
  });
  it("the double fault: the server also went back to VK1: needs_password stays, the vault works locally, nothing is written to the server", async () => {
    const { w, a } = await two();
    const oldCode = w.code;
    const snap = w.server.snapshot();
    const before = new Map(a.disk.kv.data);
    const h = await prepareRotation(a.engine, w.password);
    await commitRotation(a.engine, h);
    a.disk.kv.data.clear();
    for (const [k, v] of before) a.disk.kv.data.set(k, structuredClone(v));
    w.server.restore(snap);
    await a.restartBrowser();
    await a.svc.unlockWithRecoveryCode(oldCode);
    const writes = () => w.server.requests.filter((q) => !q.op.startsWith("GET")).length;
    const w0 = writes();
    expect((await a.engine.round()).status).toBe("needs_password");
    expect(await adoptWithSecret(a.engine, { password: w.password })).toMatchObject({ kind: "local" });
    w.advance(1000);
    await a.add("still works locally");
    expect((await a.engine.round()).status).toBe("needs_password");
    expect(writes()).toBe(w0);
  });
});

describe("N27 kver rollbacks (§8.1 ①–⑥)", () => {
  it("① an honest rollback of the keys: every device keys_behind; one repair at a higher kver; the others recover", async () => {
    const w = await worldOf(3, ["GitHub"]);
    const [a, b, c] = w.devices as [Device, Device, Device];
    const snap = w.server.snapshot();
    await newCode(w, a);
    await newCode(w, a);
    for (const d of [b, c]) await d.engine.round();
    const kver = w.server.account(EMAIL).vault!.kver;
    w.server.restore(snap); // the keys (and the vault) back to before both changes
    for (const d of [a, b, c]) expect((await d.engine.round()).keyStatus).toBe("keys_behind");
    await repairKeys(a.engine, { oldPassword: w.password, password: w.password, recoveryCode: w.code });
    expect(w.server.account(EMAIL).vault!.kver).toBeGreaterThan(kver);
    for (const d of [b, c]) expect((await d.engine.round()).keyStatus).toBe("ok");
    expect(cj((await c.generation()).keyring)).toBe(cj((await a.generation()).keyring));
  });
  it("③ a replay of a real old bundle after the repair: not adopted, keys_behind", async () => {
    const { w, a } = await two();
    const old = structuredClone(w.server.account(EMAIL).vault!);
    await newCode(w, a);
    w.server.adminSetBundle(old.bundle, old.kver);
    expect((await a.engine.round()).keyStatus).toBe("keys_behind");
    expect(await opensCode((await a.generation()).keyring, w.code)).toBe(true); // nothing went back
  });
  it("④ in keys_behind revocation goes ahead; changing the password waits for the repair", async () => {
    const w = await worldOf(3, ["GitHub"]);
    const [a, , c] = w.devices as [Device, Device, Device];
    const old = structuredClone(w.server.account(EMAIL).vault!);
    await newCode(w, a);
    w.server.adminSetBundle(old.bundle, old.kver);
    await a.engine.round();
    await expect(changePassword(a.engine, w.password, NEW_PW)).rejects.toMatchObject({ code: "keys_behind" });
    const cid = ((await c.local.settlePins()) as { deviceId: string }).deviceId;
    await revokeDevice(a.engine, cid, w.password);
    expect(w.server.state(EMAIL).devices.find((d) => d.device_id === cid)!.revoked_at).not.toBeNull();
  });
  it("⑤ unlocking: a password that opens only the server's older bundle adopts it only after an explicit confirmation", async () => {
    const { w, a, b } = await two();
    const old = structuredClone(w.server.account(EMAIL).vault!);
    await changePassword(a.engine, w.password, NEW_PW);
    await adoptWithSecret(b.engine, { password: NEW_PW });
    // the server's bundle back to the old password; B's local keyring has the new one
    w.server.adminSetBundle(old.bundle, old.kver);
    const r = await adoptWithSecret(b.engine, { password: w.password });
    expect(r).toEqual({ kind: "confirm_older" });
    expect(await opens((await b.generation()).keyring, NEW_PW)).toBe(true); // nothing changed yet
  });
  it("⑥ an identity restored from its copy (maxSeenKver 0) while the server's kver is ahead: adopted normally, never keys_behind", async () => {
    const { w, a, b } = await two();
    await newCode(w, a);
    // B loses IndexedDB (the identity); its copy restores it once unlocked
    b.disk.idb.data.clear();
    b.restartWorker();
    const r = await b.engine.round();
    expect(r.keyStatus).not.toBe("keys_behind");
    expect(cj((await b.generation()).keyring)).toBe(cj((await a.generation()).keyring));
    expect(w.server.state(EMAIL).devices.length).toBe(2); // no new device row (§8.3)
  });
});

describe("R6: the recovery code adopts the server's keys too", () => {
  it("after a rotation elsewhere, the recovery code typed here opens the new bundle and adopts it", async () => {
    const { w, a, b } = await two();
    const h = await prepareRotation(a.engine, w.password);
    await commitRotation(a.engine, h);
    await b.engine.round();
    expect(await adoptWithSecret(b.engine, { recoveryCode: h.recoveryCode })).toEqual({
      kind: "adopted",
      sameVk: false,
    });
    expect(cj((await b.generation()).keyring)).toBe(cj((await a.generation()).keyring));
  });
});

describe('§3.6.0 reconciliation: never "the new code is invalid" before it is known', () => {
  it("the answer to PUT /v1/keys is lost: GET /v1/keys shows it in effect; committed, no second request", async () => {
    const { w, a } = await two();
    w.server.fault({ match: "PUT /v1/keys", kind: "after" });
    const code = await newCode(w, a);
    expect(await opensCode((await a.generation()).keyring, code)).toBe(true);
    expect(keyWrites(w)).toBe(0); // the one write's answer was lost; nothing sent again
    expect(await opensCode(JSON.parse(w.server.account(EMAIL).vault!.bundle).keyring, code)).toBe(true);
  });
  it("lost, and another device built on it before this one looked (S4): still in effect", async () => {
    const { w, a, b } = await two();
    const h = await prepareRecoveryCode(a.engine, w.password);
    w.server.fault({ match: "PUT /v1/keys", kind: "after" });
    // the reconciliation's GET /v1/keys: before it is answered, B adopts the new code and changes the password on top
    w.server.fault({
      match: "GET /v1/keys",
      kind: "hook",
      fn: async () => {
        await b.engine.round();
        await changePassword(b.engine, w.password, NEW_PW);
      },
    });
    await commitRecoveryCode(a.engine, h);
    expect(await opensCode(JSON.parse(w.server.account(EMAIL).vault!.bundle).keyring, h.recoveryCode)).toBe(true);
    expect(await opensCode((await a.generation()).keyring, h.recoveryCode)).toBe(true);
    expect(await opens(JSON.parse(w.server.account(EMAIL).vault!.bundle).keyring, NEW_PW)).toBe(true);
  });
  it("offline after sending: unconfirmed; the fingerprint waits in sk_sync_state; the next round says it is in effect", async () => {
    const { w, a } = await two();
    const h = await prepareRecoveryCode(a.engine, w.password);
    w.server.fault({ match: "PUT /v1/keys", kind: "after" });
    w.server.fault({ match: "GET /v1/keys", kind: "throw", count: 5 });
    await expect(commitRecoveryCode(a.engine, h)).rejects.toMatchObject({ code: "unconfirmed" });
    expect((await a.engine.view()).state.pendingRecoveryWrap).toBeTruthy();
    expect(await opensCode((await a.generation()).keyring, h.recoveryCode)).toBe(false); // not committed locally yet
    w.server.clearFaults();
    await a.engine.round();
    const n = (await a.engine.view()).state.notices ?? [];
    expect(n.some((x) => x.kind === "recovery_in_effect")).toBe(true);
    expect((await a.engine.view()).state.pendingRecoveryWrap ?? null).toBeNull();
    expect(await opensCode((await a.generation()).keyring, h.recoveryCode)).toBe(true); // R2 adopted it (the same password wrap)
  });
});

describe("§3.14: the pre-send check refuses locally", () => {
  it("a wrong password: refused before anything is sent (only the version gate's status and GET /v1/keys)", async () => {
    const { w, a } = await two();
    const n0 = w.server.requests.length;
    await expect(changePassword(a.engine, "wrong-password-entirely-1", NEW_PW)).rejects.toMatchObject({
      code: "wrong_secret",
    });
    expect(w.server.requests.slice(n0).map((r) => r.op)).toEqual(["GET /v1/sync/status", "GET /v1/keys"]); // M3R-3: the gate reads first
  });
});

describe("§0.0i item 18: the Phase 0 key operations with sync on", () => {
  it("refused with sync_on, nothing written", async () => {
    const { a } = await two();
    const g = cj(await a.generation());
    await expect(a.svc.changePassword("tulip-orbit-lantern-84", NEW_PW)).rejects.toMatchObject({ code: "sync_on" });
    await expect(a.svc.newRecoveryCode("tulip-orbit-lantern-84", NO_PAGE)).rejects.toMatchObject({ code: "sync_on" });
    await expect(a.flows.truncateForUpload()).rejects.toBeInstanceOf(ServiceError);
    expect(cj(await a.generation())).toBe(g);
  });
  it("recovery code shares: a new code as shares is refused with sync_on before the password is checked (SHAMIR-NOTES §3)", async () => {
    const { a } = await two();
    const g = cj(await a.generation());
    for (const pw of ["tulip-orbit-lantern-84", "a-wrong-password-not-checked-1"])
      await expect(a.svc.prepareShares({ password: pw }, { threshold: 2, count: 3 })).rejects.toMatchObject({
        code: "sync_on",
      });
    expect(cj(await a.generation())).toBe(g);
  });
});

describe("§3.10 turn sync off", () => {
  it("revokes this device (pw_auth), then the local half; the next unlock does not bring the identity back (D11)", async () => {
    const { w, a } = await two();
    await turnSyncOff(a.engine, w.password);
    expect(
      w.server.state(EMAIL).devices.find((d) => !d.revoked_at && d.device_id === (a.disk.idb.data.size ? "?" : "x")),
    ).toBeUndefined();
    expect(a.disk.kv.data.has(SYNC_KEYS.cfg)).toBe(false);
    expect(a.disk.idb.data.size).toBe(0);
    await a.lockNow();
    await a.unlock();
    expect((await a.engine.round()).status).toBe("off");
    expect(a.disk.idb.data.size).toBe(0);
  });
});

describe("§4.2 step 2: the server back on an older key", () => {
  it("rolled back to before a rotation: server_older_key; nothing uploaded; this device's key and data stay", async () => {
    const { w, a, b } = await two();
    const snap = w.server.snapshot();
    const h = await prepareRotation(a.engine, w.password);
    await commitRotation(a.engine, h);
    await b.engine.round();
    await adoptWithSecret(b.engine, { password: w.password });
    w.advance(1000);
    await a.add("after the rotation");
    w.server.restore(snap); // the server's key is VK1 again
    const puts = w.server.requests.filter((r) => r.op === "PUT /v1/vault").length;
    const vk2 = (await a.generation()).keyring.vkId;
    expect((await a.engine.round()).status).toBe("server_older_key");
    expect(w.server.requests.filter((r) => r.op === "PUT /v1/vault").length).toBe(puts);
    expect((await a.generation()).keyring.vkId).toBe(vk2);
    expect(aliveEntries(await a.vault()).map((e) => e.issuer)).toContain("after the rotation");
  });
});
