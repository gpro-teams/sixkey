// M3, the same-VK repair of the cloud (SYNC-DESIGN §4.2 "以本机为准修复云端", N24/N27) and emergency revocation in the
// GM2-5 state (M2R-2): the repair needs the password of the server's (older) bundle and this device's recovery code; a
// wrong one is refused before anything is sent; in the state where this device must adopt its own bundle back, a revoke
// typed with the newer password still goes ahead.
import { describe, expect, it } from "vitest";
import { unlockWithPassword } from "../../src/core/crypto/keyring";
import {
  adoptWithSecret,
  changePassword,
  commitRecoveryCode,
  prepareRecoveryCode,
  repairKeys,
  revokeDevice,
} from "../../src/core/sync/engine/keys";
import { EMAIL, type Device, worldOf } from "../helpers/m3-world";

const NEW_PW = "violet-harbour-cinder-93";

describe("§4.2 the same-VK repair", () => {
  it("the server's bundle went back across a password change: the repair asks for the password of that time, then republishes this device's keyring", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a, b] = w.devices as [Device, Device];
    const old = structuredClone(w.server.account(EMAIL).vault!);
    await changePassword(a.engine, w.password, NEW_PW);
    await b.engine.round();
    await adoptWithSecret(b.engine, { password: NEW_PW });
    // the keys go back to the old password's bundle, its verifiers with it (a server restored from a backup)
    w.server.adminSetBundle(old.bundle, old.kver);
    Object.assign(w.server.account(EMAIL).vault!, {
      password_verifier: old.password_verifier,
      recovery_verifier: old.recovery_verifier,
    });
    expect((await a.engine.round()).keyStatus).toBe("keys_behind");
    const n0 = w.server.requests.length;
    await expect(
      repairKeys(a.engine, { oldPassword: NEW_PW, password: NEW_PW, recoveryCode: w.code }),
    ).rejects.toMatchObject({ code: "old_password_required" });
    expect(w.server.requests.slice(n0).map((r) => r.op)).toEqual(["GET /v1/sync/status", "GET /v1/keys"]); // nothing sent (the version gate and the pre-send read only)
    await expect(
      repairKeys(a.engine, {
        oldPassword: w.password,
        password: NEW_PW,
        recoveryCode: "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA",
      }),
    ).rejects.toBeTruthy();
    await repairKeys(a.engine, { oldPassword: w.password, password: NEW_PW, recoveryCode: w.code });
    const kr = JSON.parse(w.server.account(EMAIL).vault!.bundle).keyring;
    expect(
      await unlockWithPassword(kr, NEW_PW).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    expect((await b.engine.round()).keyStatus).toBe("ok");
  });
  it("the server went back across a recovery-code change: the repair needs the new code (typed, checked here) and sends its verifier (P4)", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a, b] = w.devices as [Device, Device];
    const old = structuredClone(w.server.account(EMAIL).vault!);
    const h = await prepareRecoveryCode(a.engine, w.password);
    await commitRecoveryCode(a.engine, h);
    await b.engine.round();
    w.server.adminSetBundle(old.bundle, old.kver);
    Object.assign(w.server.account(EMAIL).vault!, {
      password_verifier: old.password_verifier,
      recovery_verifier: old.recovery_verifier,
    });
    expect((await a.engine.round()).keyStatus).toBe("keys_behind");
    await expect(
      repairKeys(a.engine, { oldPassword: w.password, password: w.password, recoveryCode: w.code }),
    ).rejects.toMatchObject({ code: "invalid_recovery_code" }); // the old code: not this keyring's
    const n0 = w.server.requests.length;
    await repairKeys(a.engine, { oldPassword: w.password, password: w.password, recoveryCode: h.recoveryCode });
    expect(w.server.requests.slice(n0).map((r) => `${r.op} ${r.status}`)).toContain("PUT /v1/keys 200");
    expect(w.server.account(EMAIL).vault!.recovery_verifier).not.toBe(old.recovery_verifier);
    const { unlockWithRecoveryCode } = await import("../../src/core/crypto/keyring");
    const kr = JSON.parse(w.server.account(EMAIL).vault!.bundle).keyring;
    expect(
      await unlockWithRecoveryCode(kr, h.recoveryCode).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    expect((await b.engine.round()).keyStatus).toBe("ok");
    expect((await a.engine.round()).keyStatus).toBe("ok");
  });
  it("not behind: a repair is refused (not_behind), nothing sent", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    await expect(
      repairKeys(a.engine, { oldPassword: w.password, password: w.password, recoveryCode: w.code }),
    ).rejects.toMatchObject({ code: "not_behind" });
  });
});

describe("M2R-2: emergency revocation in the GM2-5 state", () => {
  it("this device's own new code lost locally (the pins ahead): a revoke goes ahead before any round adopts it back", async () => {
    const w = await worldOf(3, ["GitHub"]);
    const [a, , c] = w.devices as [Device, Device, Device];
    const before = new Map(a.disk.kv.data);
    const h = await prepareRecoveryCode(a.engine, w.password);
    await commitRecoveryCode(a.engine, h);
    a.disk.kv.data.clear();
    for (const [k, v] of before) a.disk.kv.data.set(k, structuredClone(v));
    a.restartWorker();
    const cid = ((await c.local.settlePins()) as { deviceId: string }).deviceId;
    await revokeDevice(a.engine, cid, w.password);
    expect(w.server.state(EMAIL).devices.find((d) => d.device_id === cid)!.revoked_at).not.toBeNull();
  });
});
