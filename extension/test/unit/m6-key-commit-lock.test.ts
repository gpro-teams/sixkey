// A key operation's commit and a lock of Sixkey, in the engine (SYNC-DESIGN §4.10: sync commits go through requireVk;
// the rule the service's commitUploadRecovery and commitJoin keep, docs/design/notes/M6-NOTES.md §8). The page ends its flows at a
// lock it sees; these hold for the locks it does not see (an idle expiry nobody read, a status read that failed):
//   - a commit after a lock since its prepare is refused with "locked": nothing written, nothing sent, the page locked;
//   - a lock while the commit's request is on the wire: the change lands (the server accepted it, the local keys follow),
//     and the session the commit starts carries the lock epoch read before the send, so the page stays locked.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { unlockWithRecoveryCode } from "../../src/core/crypto/keyring";
import {
  adoptWithSecret,
  changePassword,
  commitRecoveryCode,
  commitRecoveryReset,
  commitRotation,
  prepareRecoveryCode,
  prepareRecoveryReset,
  prepareRotation,
} from "../../src/core/sync/engine/keys";
import { worldOf, type Device } from "../helpers/m3-world";
import { until } from "../helpers/m6-kit";

const outcome = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "ok",
    (e: unknown) => (e as { code?: string }).code ?? String(e),
  );
const NEW_PW = "brand-new-strong-passphrase-42";
const keyPuts = (a: Device, from: number) => a.net.log.slice(from).filter((x) => x.op === "PUT /v1/keys").length;
/** A lock as the browser's session does it (platform/session.ts): the key gone and the lock epoch moved. */
function lockHere(a: Device): void {
  a.disk.session.data = null;
  a.disk.session.epoch++;
}

describe("a key operation's commit after a lock", () => {
  it("a rotation: refused with locked, the page stays locked", async () => {
    const w = await worldOf(2);
    const [a] = w.devices as [Device];
    const h = await prepareRotation(a.engine, w.password);
    await a.lockNow();
    expect(await outcome(commitRotation(a.engine, h))).toBe("locked");
    expect((await a.svc.status()).state).toBe("locked");
  });

  it("a new recovery code: refused with locked, nothing sent or recorded as pending, the page stays locked", async () => {
    const w = await worldOf(2);
    const [a] = w.devices as [Device];
    const h = await prepareRecoveryCode(a.engine, w.password);
    await a.lockNow();
    const sent = a.net.log.length;
    const r = await outcome(commitRecoveryCode(a.engine, h));
    expect({ r, puts: keyPuts(a, sent), state: (await a.svc.status()).state }).toEqual({
      r: "locked",
      puts: 0,
      state: "locked",
    });
    expect((await a.engine.view()).state.pendingRecoveryWrap ?? null).toBeNull();
  });

  it("a new master password with the recovery code: refused with locked, nothing sent, the page stays locked", async () => {
    const w = await worldOf(2);
    const [a] = w.devices as [Device];
    const h = await prepareRecoveryReset(a.engine, { recoveryCode: w.code, newPassword: NEW_PW });
    await a.lockNow();
    const sent = a.net.log.length;
    const r = await outcome(commitRecoveryReset(a.engine, h));
    expect({ r, puts: keyPuts(a, sent), state: (await a.svc.status()).state }).toEqual({
      r: "locked",
      puts: 0,
      state: "locked",
    });
  });
});

describe("a key operation's commit after the keys changed under it", () => {
  it("a new recovery code prepared under keys this device has since replaced: refused before anything is sent", async () => {
    const w = await worldOf(2);
    const [a, b] = w.devices as [Device, Device];
    const h = await prepareRecoveryCode(a.engine, w.password);
    await commitRotation(b.engine, await prepareRotation(b.engine, w.password)); // another device rotates
    await a.engine.round();
    expect((await adoptWithSecret(a.engine, { password: w.password })).kind).toBe("adopted"); // this one takes the new keys
    const sent = a.net.log.length;
    expect(await outcome(commitRecoveryCode(a.engine, h))).toBe("changed_elsewhere");
    expect(keyPuts(a, sent)).toBe(0);
  });
});

describe("a lock while a key operation's request is on the wire", () => {
  it("a new recovery code: in effect on the server and here, and the page stays locked", async () => {
    const w = await worldOf(1);
    const [a] = w.devices as [Device];
    const h = await prepareRecoveryCode(a.engine, w.password);
    a.net.inject({ match: "PUT /v1/keys", kind: "hold", count: 1 });
    const sending = outcome(commitRecoveryCode(a.engine, h));
    await until(() => a.net.heldCount === 1, "the request on its way");
    lockHere(a);
    await a.net.release();
    expect(await sending).toBe("ok");
    expect((await a.svc.status()).state).toBe("locked");
    const kr = (await a.generation()).keyring;
    expect((await unlockWithRecoveryCode(kr, h.recoveryCode)).id).toBe(kr.vkId); // the new code is this device's
  });

  it("a new master password: in effect, and the page stays locked until the new password opens it", async () => {
    const w = await worldOf(1);
    const [a] = w.devices as [Device];
    a.net.inject({ match: "PUT /v1/keys", kind: "hold", count: 1 });
    const sending = outcome(changePassword(a.engine, w.password, NEW_PW));
    await until(() => a.net.heldCount === 1, "the request on its way");
    lockHere(a);
    await a.net.release();
    expect(await sending).toBe("ok");
    expect((await a.svc.status()).state).toBe("locked");
    await a.svc.unlockWithPassword(NEW_PW);
  });

  it("a rotation: in effect, and the page stays locked", async () => {
    const w = await worldOf(1);
    const [a] = w.devices as [Device];
    const h = await prepareRotation(a.engine, w.password);
    a.net.inject({ match: "POST /v1/keys/rotate", kind: "hold", count: 1 });
    const sending = outcome(commitRotation(a.engine, h));
    await until(() => a.net.heldCount === 1, "the request on its way");
    lockHere(a);
    await a.net.release();
    expect(await sending).toBe("ok");
    expect((await a.svc.status()).state).toBe("locked");
    const kr = (await a.generation()).keyring;
    expect((await unlockWithRecoveryCode(kr, h.recoveryCode)).id).toBe(kr.vkId);
  });
});
