// M6C, the repair of server_older_key (SYNC-DESIGN §4.2 step 2 and its repair; docs/design/notes/M6C-NOTES.md §1): an
// honest restore of the server to before a rotation stops every device that took the rotation ("the server went back
// to older keys"); one of them puts its VK, K_write and keyring back with POST /v1/keys/rotate, and then every device
// carries on: the ones that had the newer keys at once, without typing anything (the bundle carries the auth they
// adopted with it); one that only ever held the older key takes the newer one with its password, and brings its own
// writes with it. The older key's head is never merged into the repair's upload (R5); it stays in the server's history.
import "fake-indexeddb/auto";
import { beforeAll, describe, expect, it } from "vitest";
import { decryptVault } from "../../src/core/crypto/envelope";
import { unwrapPreviousVks } from "../../src/core/crypto/keyring";
import {
  adoptWithSecret,
  changePassword,
  commitRotation,
  KeyOpError,
  prepareRotation,
  repairKeys,
  revokeDevice,
} from "../../src/core/sync/engine/keys";
import { listDevices } from "../../src/core/sync/engine/devices";
import { dropFound, findSources, openFound } from "../../src/core/sync/engine/find";
import { aliveEntries, type Vault } from "../../src/core/vault/model";
import { deserializeVault } from "../../src/core/vault/validate";
import { readFacts } from "../../src/options/sync/gateway";
import { cardOf } from "../../src/options/sync/model";
import { asking } from "../../src/options/sync/permission";
import { RepairFlow } from "../../src/options/sync/repair";
import type { Snapshot } from "../helpers/fake-server";
import { click, kitOf, permissions, until } from "../helpers/m6-kit";
import { deviceIdOf } from "../helpers/m6c-flows";
import { cloneWorld, EMAIL, quiesce, type Device, type World, worldOf } from "../helpers/m3-world";

const names = (v: Vault) =>
  aliveEntries(v)
    .map((e) => e.issuer)
    .sort();

/**
 * Three devices in sync; A rotates and B takes the rotation; C was away and never did. Then the server is restored to its
 * state from before the rotation (an honest point-in-time restore of its database). `code` is the rotation's recovery
 * code (the one A's and B's keyrings now carry).
 */
type Restored = { w: World; a: Device; b: Device; c: Device; code: string; oldCode: string; vk1: string; vk2: string };
let base: World;
let baseCode = "";
let oldCode = "";
beforeAll(async () => {
  const w = await worldOf(3, ["GitHub", "AWS"]);
  const [a, b] = w.devices as [Device, Device, Device];
  const before = w.server.snapshot();
  oldCode = w.code;
  const h = await prepareRotation(a.engine, w.password);
  await commitRotation(a.engine, h);
  baseCode = h.recoveryCode;
  w.advance(1000);
  expect((await b.engine.round()).status).toBe("needs_password");
  await adoptWithSecret(b.engine, { password: w.password });
  w.advance(1000);
  await a.add("after the rotation");
  await a.engine.round();
  await b.engine.round();
  w.server.restore(before as Snapshot);
  base = w;
}, 60_000);

async function restored(): Promise<Restored> {
  const w = cloneWorld(base);
  w.code = baseCode;
  const [a, b, c] = w.devices as [Device, Device, Device];
  const vk1 = (await c.generation()).keyring.vkId;
  const vk2 = (await a.generation()).keyring.vkId;
  return { w, a, b, c, code: baseCode, oldCode, vk1, vk2 };
}

const serverVault = async (w: World, d: Device): Promise<Vault> => {
  const v = w.server.account(EMAIL).vault!;
  return deserializeVault(await decryptVault(JSON.parse(v.envelope), await d.vk()));
};

describe("server_older_key: the repair over the older key", () => {
  it("A repairs; B (which had the newer keys) carries on without typing anything; C (only ever the older key) takes the newer one with its password and brings its own write", async () => {
    const { w, a, b, c, code, vk1, vk2 } = await restored();
    expect(w.server.account(EMAIL).vault!.vk_id).toBe(vk1);
    expect((await a.engine.round()).status).toBe("server_older_key");
    expect((await b.engine.round()).status).toBe("server_older_key");
    // C never had the newer key: for it, the restored server is the ordinary one, and it writes to it
    w.advance(1000);
    await c.add("C after the restore");
    expect((await c.engine.round()).status).toBe("ok");
    const headBefore = w.server.account(EMAIL).vault!.version;
    const kver0 = w.server.account(EMAIL).vault!.kver;

    await repairKeys(a.engine, { oldPassword: w.password, password: w.password, recoveryCode: code });

    const sv = w.server.account(EMAIL).vault!;
    expect(sv.vk_id).toBe(vk2);
    expect(sv.kver).toBeGreaterThan(kver0);
    expect(sv.version).toBe(headBefore + 1);
    expect(JSON.parse(sv.bundle).keyring.vkId).toBe(vk2);
    // the upload is A's own vault: the older key's head (C's write) is not merged into it (R5)
    expect(names(await serverVault(w, a))).toEqual(["AWS", "GitHub", "after the rotation"]);
    // the older head is still in the server's history, and find accounts opens it with the previous key and offers
    // what it holds that A does not (C's write), by the user's choice only
    expect(w.server.account(EMAIL).history.some((h) => h.version === headBefore && h.vk_id === vk1)).toBe(true);
    const older = (await findSources(a.engine)).server!.find((x) => x.kind === "server" && x.version === headBefore)!;
    const found = await openFound(a.engine, older);
    expect(found.accounts.map((x) => x.issuer)).toEqual(["C after the restore"]);
    dropFound(found);

    expect((await a.engine.round()).status).toBe("ok");
    // every device's name was put back under this device's key (§2.4), so a later rotation re-encrypts them too
    expect(w.server.state(EMAIL).devices.map((d) => d.name_ct?.vkId)).toEqual([vk2, vk2, vk2]);
    expect((await listDevices(a.engine)).map((d) => d.name)).toEqual(["Device A", "Device B", "Device C"]);
    w.advance(1000);
    const rb = await b.engine.round();
    expect(rb.status).toBe("ok");
    expect(rb.keyStatus ?? "ok").toBe("ok"); // the bundle carries the auth B adopted with keyring2: not auth_without_password
    // C: the server rotated, as far as C can tell (R4); its password takes the newer key, and its write comes along
    expect((await c.engine.round()).status).toBe("needs_password");
    const r = await adoptWithSecret(c.engine, { password: w.password });
    expect(r.kind).toBe("adopted");
    expect((await c.generation()).keyring.vkId).toBe(vk2);
    await quiesce(w);
    for (const d of [a, b, c])
      expect(names(await d.vault())).toEqual(["AWS", "C after the restore", "GitHub", "after the rotation"]);
    // K_write is A's again: an ordinary upload is accepted
    w.advance(1000);
    await b.add("B later");
    expect((await b.engine.round()).uploaded).toBe(true);
  });

  it("the typed recovery code must open this device's keyring: the code of the older keys (the server's) is refused before anything is sent", async () => {
    const { w, a, oldCode: before } = await restored();
    await a.engine.round();
    const n0 = w.server.requests.length;
    for (const recoveryCode of [before, "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA"])
      await expect(
        repairKeys(a.engine, { oldPassword: w.password, password: w.password, recoveryCode }),
      ).rejects.toBeInstanceOf(KeyOpError);
    await expect(
      repairKeys(a.engine, { oldPassword: w.password, password: w.password, recoveryCode: before }),
    ).rejects.toMatchObject({ code: "invalid_recovery_code" });
    const sent = w.server.requests.slice(n0).map((r) => r.op);
    expect(sent.filter((op) => op === "POST /v1/keys/rotate" || op === "PUT /v1/keys")).toEqual([]);
  });

  it("a wrong master password: refused at the check, nothing sent", async () => {
    const { w, a, code } = await restored();
    await a.engine.round();
    const n0 = w.server.requests.length;
    await expect(
      repairKeys(a.engine, { oldPassword: "not the password at all", password: w.password, recoveryCode: code }),
    ).rejects.toMatchObject({ code: "wrong_secret" });
    expect(w.server.requests.slice(n0).map((r) => r.op)).toEqual(["GET /v1/sync/status", "GET /v1/keys"]);
  });

  it("the answer lost on the way back: the exact bundle on the server says it took effect", async () => {
    const { w, a, code, vk2 } = await restored();
    await a.engine.round();
    a.net.inject({ match: "POST /v1/keys/rotate", kind: "lose_response" });
    await repairKeys(a.engine, { oldPassword: w.password, password: w.password, recoveryCode: code });
    expect(w.server.account(EMAIL).vault!.vk_id).toBe(vk2);
    expect(w.server.requests.filter((r) => r.op === "POST /v1/keys/rotate" && r.status === 200)).toHaveLength(1);
    expect((await a.engine.round()).status).toBe("ok");
  });

  it("a device on the older key writes while the repair is on its way (version_conflict): the upload is built again for the new head and lands", async () => {
    const { w, a, c, code, vk2 } = await restored();
    await a.engine.round();
    a.net.inject({ match: "POST /v1/keys/rotate", kind: "hold" });
    const run = repairKeys(a.engine, { oldPassword: w.password, password: w.password, recoveryCode: code });
    while (a.net.heldCount === 0) await new Promise((r) => setTimeout(r, 0));
    await c.add("C meanwhile");
    expect((await c.engine.round()).uploaded).toBe(true);
    await a.net.release();
    await run;
    const sv = w.server.account(EMAIL).vault!;
    expect(sv.vk_id).toBe(vk2);
    expect(w.server.requests.filter((r) => r.op === "POST /v1/keys/rotate").map((r) => r.status)).toEqual([409, 200]);
    expect(names(await serverVault(w, a))).not.toContain("C meanwhile"); // not merged: it comes with C's adoption
    expect((await c.engine.round()).status).toBe("needs_password");
    await adoptWithSecret(c.engine, { password: w.password });
    await quiesce(w);
    expect(names(await a.vault())).toContain("C meanwhile");
  });

  it("another device's repair lands while this one builds its upload again: changed_elsewhere, never said as done", async () => {
    const { w, a, b, c, code } = await restored();
    await a.engine.round();
    await b.engine.round();
    a.net.inject({ match: "POST /v1/keys/rotate", kind: "hold" });
    const run = repairKeys(a.engine, { oldPassword: w.password, password: w.password, recoveryCode: code }).catch(
      (e: unknown) => e,
    );
    while (a.net.heldCount === 0) await new Promise((r) => setTimeout(r, 0));
    await c.add("C meanwhile");
    await c.engine.round(); // the head moves: A's rotate comes back version_conflict, and A asks the status again
    a.net.inject({ match: "GET /v1/sync/status", kind: "hold" });
    await a.net.release();
    while (a.net.heldCount === 0) await new Promise((r) => setTimeout(r, 0));
    await repairKeys(b.engine, { oldPassword: w.password, password: w.password, recoveryCode: code }); // B's lands first
    await a.net.release();
    const err = await run;
    expect(err).toMatchObject({ code: "changed_elsewhere" });
    const bId = (await b.local.status()) as { identity?: { deviceId: string } };
    expect(JSON.parse(w.server.account(EMAIL).vault!.bundle).by).toBe(bId.identity!.deviceId); // B's, not A's
    expect((await a.engine.round()).status).toBe("ok"); // B's repair put the same keys back: A carries on
  });

  it("another device repaired first: the second repair is refused (not_behind) and its card clears with the next round", async () => {
    const { w, a, b, code } = await restored();
    await a.engine.round();
    await b.engine.round();
    await repairKeys(a.engine, { oldPassword: w.password, password: w.password, recoveryCode: code });
    await expect(
      repairKeys(b.engine, { oldPassword: w.password, password: w.password, recoveryCode: code }),
    ).rejects.toMatchObject({ code: "not_behind" });
    expect((await b.engine.round()).status).toBe("ok");
  });

  it("locked since the check: nothing sent, and the page stays locked", async () => {
    const { w, a, code } = await restored();
    await a.engine.round();
    a.net.inject({ match: "GET /v1/keys", kind: "hold" });
    const run = repairKeys(a.engine, { oldPassword: w.password, password: w.password, recoveryCode: code }).catch(
      (e: unknown) => e,
    );
    while (a.net.heldCount === 0) await new Promise((r) => setTimeout(r, 0));
    await a.lockNow();
    await a.net.release();
    const err = await run;
    expect(err).toBeInstanceOf(KeyOpError);
    expect((err as KeyOpError).code).toBe("locked");
    expect(w.server.requests.filter((r) => r.op === "POST /v1/keys/rotate")).toEqual([]);
    expect((await a.svc.status()).state).toBe("locked");
  });

  it("the older key really is one this device's previous list unwraps (the set-up of these tests)", async () => {
    const { a, vk1 } = await restored();
    const g = await a.generation();
    const prev = await unwrapPreviousVks(g.keyring, await a.vk());
    expect(prev.map((v) => v.id)).toContain(vk1);
  });
});

describe("the current password is checked before anything is sent", () => {
  it("a typo in the current-password field (the server's password typed correctly): refused as a wrong password, nothing sent; revoking from another device still works", async () => {
    const { w, a, b, c, code } = await restored();
    expect((await a.engine.round()).status).toBe("server_older_key");
    const n0 = w.server.requests.length;
    await expect(
      repairKeys(a.engine, { oldPassword: w.password, password: `${w.password}x`, recoveryCode: code }),
    ).rejects.toMatchObject({ code: "wrong_secret" });
    const sent = w.server.requests.slice(n0).map((r) => r.op);
    expect(sent.filter((op) => op === "POST /v1/keys/rotate" || op === "PUT /v1/keys")).toEqual([]);
    // the verifier on the server is still one the master password matches: an emergency revocation goes through
    await b.engine.round();
    await revokeDevice(b.engine, await deviceIdOf(c), w.password);
  });

  it("the same-VK repair (keys_behind, across a password change): a typo in the current password is refused before the PUT", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a, b] = w.devices as [Device, Device];
    const before = w.server.snapshot();
    const newPw = `${w.password}-2`;
    await changePassword(a.engine, w.password, newPw);
    w.advance(1000);
    await b.engine.round();
    await adoptWithSecret(b.engine, { password: newPw });
    w.server.restore(before as Snapshot);
    expect((await a.engine.round()).keyStatus).toBe("keys_behind");
    const n0 = w.server.requests.length;
    await expect(
      repairKeys(a.engine, { oldPassword: w.password, password: `${newPw}x`, recoveryCode: w.code }),
    ).rejects.toMatchObject({ code: "wrong_secret" });
    expect(w.server.requests.slice(n0).filter((q) => q.op === "PUT /v1/keys")).toEqual([]);
  });

  it("a restore across a password change, over the older key: the form stays open saying the password of that time is needed, and takes it", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a, b] = w.devices as [Device, Device];
    const before = w.server.snapshot(); // the old password, VK1
    const newPw = `${w.password}-2`;
    await changePassword(a.engine, w.password, newPw);
    const h = await prepareRotation(a.engine, newPw);
    await commitRotation(a.engine, h);
    w.advance(1000);
    await b.engine.round();
    await adoptWithSecret(b.engine, { password: newPw });
    w.server.restore(before as Snapshot);
    expect((await a.engine.round()).status).toBe("server_older_key");
    const perm = permissions(true);
    const kit = kitOf(a, perm);
    const f = new RepairFlow(kit);
    click(
      perm,
      asking(kit, (g) => void f.start(g)),
    );
    await until(() => f.state.at === "form", "the form");
    await f.submit({ oldPassword: "", password: newPw, recoveryCode: h.recoveryCode });
    expect(f.state).toMatchObject({ at: "form", failure: { code: "old_password_required" } });
    await f.submit({ oldPassword: w.password, password: newPw, recoveryCode: h.recoveryCode });
    expect(f.state.at).toBe("done");
    w.advance(1000);
    expect((await b.engine.round()).status).toBe("ok");
  });
});

describe("the card's way out: the Sync section's repair (repair.ts RepairFlow)", () => {
  const cardNow = async (w: World, kit: ReturnType<typeof kitOf>) =>
    cardOf(await readFacts(kit), "unlocked", w.clock.now, String)!;

  it("the card offers it; Chrome asked in the click; the repair; the card is clear after the next round", async () => {
    const { w, a, code } = await restored();
    await a.engine.round();
    const perm = permissions(true);
    const kit = kitOf(a, perm);
    expect((await cardNow(w, kit)).actions[0]).toBe("repair");
    const f = new RepairFlow(kit);
    click(
      perm,
      asking(kit, (g) => void f.start(g)),
    );
    expect(perm.log).toEqual(["request"]);
    await until(() => f.state.at === "form", "the form");
    await f.submit({ oldPassword: "", password: w.password, recoveryCode: code }); // the old one empty: the same
    expect(f.state.at).toBe("done");
    expect(kit.changes()).toBe(1);
    await a.engine.round();
    expect((await cardNow(w, kit)).id).toBe("ok");
  });

  it("a lock while the repair is on the wire: it lands, the flow says so, and the page stays locked", async () => {
    const { w, a, code, vk2 } = await restored();
    await a.engine.round();
    const perm = permissions(true);
    const kit = kitOf(a, perm);
    const f = new RepairFlow(kit);
    click(
      perm,
      asking(kit, (g) => void f.start(g)),
    );
    await until(() => f.state.at === "form", "the form");
    a.net.inject({ match: "POST /v1/keys/rotate", kind: "hold" });
    const run = f.submit({ oldPassword: w.password, password: w.password, recoveryCode: code });
    while (a.net.heldCount === 0) await new Promise((r) => setTimeout(r, 0));
    // a lock as the browser's session does it (platform/session.ts): the key gone and the lock epoch moved
    a.disk.session.data = null;
    a.disk.session.epoch++;
    await f.locked();
    await a.net.release();
    await run;
    expect(f.state.at).toBe("done");
    expect(w.server.account(EMAIL).vault!.vk_id).toBe(vk2);
    expect((await a.svc.status()).state).toBe("locked");
  });

  it("a lock at the form ends the flow; nothing is sent", async () => {
    const { w, a } = await restored();
    await a.engine.round();
    const perm = permissions(true);
    const kit = kitOf(a, perm);
    const f = new RepairFlow(kit);
    click(
      perm,
      asking(kit, (g) => void f.start(g)),
    );
    await until(() => f.state.at === "form", "the form");
    const n0 = w.server.requests.length;
    await f.locked();
    expect(f.state).toEqual({ at: "failed", failure: { code: "locked_out" } });
    expect(w.server.requests.length).toBe(n0);
  });
});
