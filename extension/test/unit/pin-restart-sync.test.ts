// The PIN after a restart with sync on (review r2, PINR-R2-03; docs/design/notes/PIN-RESTART-NOTES.md §16): a key change
// this page makes through the sync engine, its secret just typed here (a new master password, a new recovery code, a
// reset, a rotation), opens the "the PIN alone turns it back on" window as the same change does with sync off
// (KeyCommit `typed`, from the engine's commitPublished, to VaultService.committed; rotated.ts rewrappedHere); so does
// the new recovery code made before a first upload (SyncFlows.commitUploadRecovery), and a repair (r4: the r3 review's
// Z05; it records nothing, but its secrets were typed here). A key adopted (in a background round, or with a secret
// typed for keys changed on another device) and a join never do: nobody typed anything for this page's keys. The
// window is what RestartAdmin.byPin reads: this page's last key event, for these very keys.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { wrapsTag } from "../../src/core/crypto/pin";
import { rewrappedBy } from "../../src/core/service/rotated";
import {
  adoptWithSecret,
  changePassword,
  commitRecoveryCode,
  commitRecoveryReset,
  commitRotation,
  prepareRecoveryCode,
  prepareRecoveryReset,
  prepareRotation,
  repairKeys,
} from "../../src/core/sync/engine/keys";
import { EMAIL, newDisk, World, worldOf, type Device } from "../helpers/m3-world";
import { createProtected } from "../helpers/vaults";

const NEW_PW = "brand-new-strong-passphrase-42";

/** The device's keyring now. */
const keyringOf = async (d: Device) => (await d.svc.currentGeneration())!.keyring;
/** Whether this page's PIN-only window is open for the keys it holds now (RestartAdmin.byPin's test, but the time). */
async function windowOpen(d: Device): Promise<boolean> {
  const k = await keyringOf(d);
  const t = rewrappedBy(d.svc);
  return !!t && t.vkId === k.vkId && t.wraps === wrapsTag(k);
}

describe("PINR-R2-03: a key change typed on this page through the sync engine opens the PIN-only window", () => {
  it("a new master password", async () => {
    const w = await worldOf(2);
    const [a] = w.devices as [Device];
    expect(await windowOpen(a)).toBe(false);
    await changePassword(a.engine, w.password, NEW_PW);
    expect(await windowOpen(a)).toBe(true);
  }, 60_000);

  it("a rotation (a new vault key)", async () => {
    const w = await worldOf(2);
    const [a] = w.devices as [Device];
    const before = (await keyringOf(a)).vkId;
    await commitRotation(a.engine, await prepareRotation(a.engine, w.password));
    expect((await keyringOf(a)).vkId).not.toBe(before);
    expect(await windowOpen(a)).toBe(true);
  }, 60_000);

  it("a new recovery code", async () => {
    const w = await worldOf(2);
    const [a] = w.devices as [Device];
    const before = wrapsTag(await keyringOf(a));
    await commitRecoveryCode(a.engine, await prepareRecoveryCode(a.engine, w.password));
    expect(wrapsTag(await keyringOf(a))).not.toBe(before);
    expect(await windowOpen(a)).toBe(true);
  }, 60_000);

  it("a master password reset with the recovery code", async () => {
    const w = await worldOf(2);
    const [a] = w.devices as [Device];
    const before = wrapsTag(await keyringOf(a));
    await commitRecoveryReset(
      a.engine,
      await prepareRecoveryReset(a.engine, { recoveryCode: w.code, newPassword: NEW_PW }),
    );
    expect(wrapsTag(await keyringOf(a))).not.toBe(before);
    expect(await windowOpen(a)).toBe(true);
  }, 60_000);

  it("a repair (the password of the server's bundle, the master password and the recovery code typed here; it records nothing, record null, and is typed all the same: the r3 review's Z05)", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a, b] = w.devices as [Device, Device];
    const old = structuredClone(w.server.account(EMAIL).vault!);
    await changePassword(a.engine, w.password, NEW_PW);
    await b.engine.round();
    await adoptWithSecret(b.engine, { password: NEW_PW });
    // the server's keys go back to the old password's bundle (a server restored from a backup): this device repairs it
    w.server.adminSetBundle(old.bundle, old.kver);
    Object.assign(w.server.account(EMAIL).vault!, {
      password_verifier: old.password_verifier,
      recovery_verifier: old.recovery_verifier,
    });
    expect((await a.engine.round()).keyStatus).toBe("keys_behind");
    a.restartWorker(); // nothing in memory: the window the password change opened is gone; the session is kept
    expect(rewrappedBy(a.svc)).toBeUndefined();
    await repairKeys(a.engine, { oldPassword: w.password, password: NEW_PW, recoveryCode: w.code });
    expect(await windowOpen(a)).toBe(true);
  }, 60_000);

  it("the new recovery code made before a first upload (SyncFlows.commitUploadRecovery, the password typed for it)", async () => {
    const w = new World();
    const d = w.device("A", newDisk());
    await createProtected(d.svc, w.password);
    const h = await d.flows.prepareUploadRecovery(w.password);
    await d.flows.commitUploadRecovery(h);
    expect(await windowOpen(d)).toBe(true);
  }, 60_000);
});

describe("PINR-R2-03: keys this page did not type for never open it", () => {
  it("a new recovery code made on another device, adopted here in a background round", async () => {
    const w = await worldOf(2);
    const [a, b] = w.devices as [Device, Device];
    const before = wrapsTag(await keyringOf(a));
    await commitRecoveryCode(b.engine, await prepareRecoveryCode(b.engine, w.password));
    await a.engine.round();
    expect(wrapsTag(await keyringOf(a)), "a adopted the new keys in its round").not.toBe(before);
    expect(await windowOpen(a)).toBe(false);
  }, 60_000);

  it("a rotation made on another device, adopted here with the master password typed (keys_adopted)", async () => {
    const w = await worldOf(2);
    const [a, b] = w.devices as [Device, Device];
    await commitRotation(b.engine, await prepareRotation(b.engine, w.password));
    await a.engine.round();
    expect((await adoptWithSecret(a.engine, { password: w.password })).kind).toBe("adopted");
    expect((await keyringOf(a)).vkId).toBe((await keyringOf(b)).vkId);
    expect(await windowOpen(a)).toBe(false);
  }, 60_000);

  it("a join (sync_on): the joining device's keys came from the account", async () => {
    const w = await worldOf(2);
    const b = w.devices[1]!;
    expect(rewrappedBy(b.svc)).toBeUndefined();
    expect(await windowOpen(b)).toBe(false);
  }, 60_000);
});
