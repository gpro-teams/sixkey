// The engine's additions for managing a sync account from the Sync section (M6 part B), over the in-memory FakeServer:
//   - the device list with the names opened here (none while locked), this device first;
//   - rejecting one waiting request from the list; whether revoking a device must take the "protect" way (it wrote the
//     current keys, §3.10);
//   - a new master password set with the recovery code (§3.3 step 5): both wraps replaced in one update, the new code
//     shown before anything is sent, recovery_auth standing in for pw_auth; the other devices take the new password;
//   - "make this profile a separate device" (§4.10): a new device row approved by the original, a new device id,
//     signing key and edit suffix here, the pins kept, and sync going on under the new identity;
//   - deleting the sync account (§3.12): refused without a fresh one-time-code session or with a wrong password; with
//     both, the account is gone on the server and every device's local data stays.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { Approver, ApprovalJoin } from "../../src/core/sync/engine/enroll";
import { listDevices } from "../../src/core/sync/engine/devices";
import {
  adoptWithSecret,
  changePassword,
  commitRecoveryCode,
  commitRecoveryReset,
  commitRotation,
  deleteSyncAccount,
  forkDevice,
  KeyOpError,
  prepareRecoveryCode,
  prepareRecoveryReset,
  prepareRotation,
  removeSyncIdentity,
  revokeNeedsProtect,
  turnSyncOff,
} from "../../src/core/sync/engine/keys";
import { unlockWithRecoveryCode } from "../../src/core/crypto/keyring";
import { keysChangedElsewhere } from "../../src/core/sync/local/state";
import { EMAIL, worldOf, World, type Device } from "../helpers/m3-world";

const code = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "ok",
    (e: unknown) => (e as { code?: string }).code ?? String(e),
  );

describe("managing a sync account (engine)", () => {
  it("the device list: names opened here, this device first; while locked the names are not opened", async () => {
    const w = await worldOf(2);
    const [a, b] = w.devices as [Device, Device];
    const rows = await listDevices(a.engine);
    expect(rows.map((r) => [r.name, r.current, r.joinedVia])).toEqual([
      ["Device A", true, "first"],
      ["Device B", false, "recovery"],
    ]);
    expect(rows[1]!.lastSeenAt).not.toBeNull();
    await b.lockNow();
    const locked = await listDevices(b.engine);
    expect(locked.map((r) => r.name)).toEqual([null, null]);
    expect(locked[0]!.current).toBe(true);
  });

  it("one waiting request rejected from the list, the others left; the protect check: the device that wrote the keys", async () => {
    const w = await worldOf(2);
    const [a, b] = w.devices as [Device, Device];
    const phone = w.device("New phone");
    const laptop = w.device("New laptop");
    for (const n of [phone, laptop])
      await ApprovalJoin.start(n.engine, { session: await w.server.session(EMAIL), deviceName: n.name, email: EMAIL });
    const before = await Approver.list(a.engine);
    expect(before).toHaveLength(2);
    expect(await code(Approver.rejectRequest(a.engine, before[0]!.request_id, "wrong password here"))).toBe(
      "wrong_secret",
    );
    await Approver.rejectRequest(a.engine, before[0]!.request_id, w.password);
    const after = (await Approver.list(a.engine)).filter((r) => r.state === "pending");
    expect(after.map((r) => r.request_id)).toEqual([before[1]!.request_id]);
    // A uploaded the keys (it is the bundle's `by`); B wrote nothing
    const ids = (await listDevices(a.engine)).map((r) => r.id);
    expect(await revokeNeedsProtect(b.engine, ids[0]!, w.password)).toBe(true);
    expect(await revokeNeedsProtect(a.engine, ids[1]!, w.password)).toBe(false);
    expect(await code(revokeNeedsProtect(a.engine, ids[1]!, "not it"))).toBe("wrong_secret");
  });

  it("a new master password with the recovery code: both wraps replaced, the old code retired, the others take the new password", async () => {
    const w = await worldOf(2);
    const [a, b] = w.devices as [Device, Device];
    const fresh = "brand-new-strong-passphrase-42";
    expect(
      await code(
        prepareRecoveryReset(a.engine, { recoveryCode: "0000-0000-0000-0000-0000-0000-0000", newPassword: fresh }),
      ),
    ).toMatch(/wrong_secret|invalid_recovery_code|recovery/);
    expect(await code(prepareRecoveryReset(a.engine, { recoveryCode: w.code, newPassword: "short" }))).toBe(
      "weak_password",
    );
    const h = await prepareRecoveryReset(a.engine, { recoveryCode: w.code, newPassword: fresh });
    expect(h.recoveryCode).not.toBe(w.code);
    const puts = () => w.server.requests.filter((r) => r.op === "PUT /v1/keys").length;
    const sent = puts();
    expect(sent).toBe(0); // nothing sent before the code was saved
    await commitRecoveryReset(a.engine, h);
    expect(puts()).toBe(sent + 1);
    // here: the new password opens, the old code no longer does, the new code does
    const kr = (await a.generation()).keyring;
    await expect(unlockWithRecoveryCode(kr, w.code)).rejects.toBeTruthy();
    expect((await unlockWithRecoveryCode(kr, h.recoveryCode)).id).toBe(kr.vkId);
    await a.lockNow();
    await a.svc.unlockWithPassword(fresh);
    // B: its next round sees the new password's keys (needs_new_password), and takes them with the new password; its
    // popup's lock screen says so in between (§6 P2), and stops once a round after the adoption has run
    expect(await keysChangedElsewhere(b.disk.kv)).toBeNull();
    await b.engine.round();
    expect((await b.engine.view()).state.keyStatus).toBe("needs_new_password");
    expect(await keysChangedElsewhere(b.disk.kv)).toBe("password");
    const r = await adoptWithSecret(b.engine, { password: fresh });
    expect(r.kind).toBe("adopted");
    await b.engine.round(); // the round after the adoption (the section runs it) stores the key status anew
    expect(await keysChangedElsewhere(b.disk.kv)).toBeNull();
  });

  it("a separate device: a new row approved by the original, a new id and edit suffix here, the pins kept, sync going on", async () => {
    const w = await worldOf(2);
    const [a] = w.devices as [Device, Device];
    const before = await listDevices(a.engine);
    const oldId = before.find((r) => r.current)!.id;
    const suffix = a.disk.kv.data.get("sk_device");
    expect(await code(forkDevice(a.engine, "wrong", "Laptop copy"))).toBe("wrong_secret");
    expect(await code(forkDevice(a.engine, w.password, " "))).toBe("invalid_device_name");
    await forkDevice(a.engine, w.password, "Laptop copy");
    const after = await listDevices(a.engine);
    const me = after.find((r) => r.current)!;
    expect(me.id).not.toBe(oldId);
    expect(me).toMatchObject({ name: "Laptop copy", joinedVia: "fork", approvedBy: oldId });
    expect(after.find((r) => r.id === oldId)?.revokedAt).toBeNull(); // the original copy keeps its identity
    expect(a.disk.kv.data.get("sk_device")).not.toBe(suffix);
    w.advance(1000);
    await a.add("after the fork");
    expect((await a.engine.round()).status).toBe("ok");
  });

  it("deleting the account: a fresh one-time code session and the right password, both; the local data stays", async () => {
    const w = await worldOf(2);
    const [a, b] = w.devices as [Device, Device];
    const session = await w.server.session(EMAIL);
    expect(await code(deleteSyncAccount(a.engine, session, "wrong"))).toBe("wrong_secret");
    expect(w.server.account(EMAIL).vault).toBeTruthy();
    await deleteSyncAccount(a.engine, session, w.password);
    expect(() => w.server.account(EMAIL)).toThrow(); // no such account any more
    await removeSyncIdentity(a.engine);
    expect((await a.engine.view()).syncOn).toBe(false);
    expect((await a.vault()).entries.length).toBeGreaterThan(0);
    // B: the server no longer knows it; its data stays
    expect(["rejected_by_server", "error"]).toContain((await b.engine.round()).status);
    expect((await b.vault()).entries.length).toBeGreaterThan(0);
  });

  it("keys this device committed before, adopted back from the server: the security record says so (keys_adopted_back)", async () => {
    const w = await worldOf(2);
    const [a] = w.devices as [Device, Device];
    const before = new Map(a.disk.kv.data);
    const h = await prepareRecoveryCode(a.engine, w.password);
    await commitRecoveryCode(a.engine, h);
    a.disk.kv.data.clear(); // this profile's storage goes back alone (the accepted residual of §3.9 R1)
    for (const [k, v] of before) a.disk.kv.data.set(k, structuredClone(v));
    a.restartWorker();
    const records: (string | undefined)[] = [];
    const flows = a.engine.deps.flows;
    const commit = flows.commitKeys.bind(flows);
    flows.commitKeys = (c) => {
      records.push(c.record);
      return commit(c);
    };
    await a.engine.round();
    expect(records).toEqual(["keys_adopted_back"]);
    expect((await a.engine.view()).state.notices?.some((n) => n.kind === "keys_adopted")).toBe(true);
  });

  it('the popup\'s lock-screen lookup (§6 P2): keys rotated elsewhere say "keys" until taken; sync off here, nothing', async () => {
    const w = await worldOf(2);
    const [a, b] = w.devices as [Device, Device];
    await commitRotation(a.engine, await prepareRotation(a.engine, w.password));
    await b.engine.round();
    expect((await b.engine.view()).state.status).toBe("needs_password");
    expect(await keysChangedElsewhere(b.disk.kv)).toBe("keys");
    expect((await adoptWithSecret(b.engine, { password: w.password })).kind).toBe("adopted");
    await b.engine.round();
    expect(await keysChangedElsewhere(b.disk.kv)).toBeNull();
    await turnSyncOff(b.engine, w.password);
    expect(await keysChangedElsewhere(b.disk.kv)).toBeNull();
  });

  it("a key operation refused by the engine reaches the page as a code, never a message", async () => {
    const w = await worldOf(1);
    const [a] = w.devices as [Device];
    const err = await changePassword(a.engine, "wrong", "another-strong-passphrase-9").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyOpError);
    expect((err as KeyOpError).code).toBe("wrong_secret");
    void World;
  });
});
