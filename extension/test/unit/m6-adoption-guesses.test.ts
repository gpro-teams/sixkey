// A wrong master password (or recovery code) typed into the adoption (SYNC-DESIGN §3.9; engine keys.ts adoptWithSecret):
// the Sync section's "Update this device" and "Unlock with the server's password", which can open a locked page. Each
// wrong guess is recorded in the security record exactly as Phase 0's unlock records its own (H6: unlock_failed,
// recovery_failed; the count the next unlock reports), whichever form took it; a right one records nothing.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { generateRecoveryCode } from "../../src/core/crypto/recovery-code";
import { SECURITY_LOG_KEY, SecurityLog } from "../../src/core/service/security-log";
import { adoptWithSecret } from "../../src/core/sync/engine/keys";
import { SyncPanelCtl } from "../../src/options/sync/panel";
import { worldOf, type Device } from "../helpers/m3-world";
import { kitOf, permissions } from "../helpers/m6-kit";

/** The test worlds build the service without a security record: give it one, as the runtime does (platform/runtime.ts). */
function withLog(d: Device): Device {
  (d.svc as unknown as { security: SecurityLog }).security = new SecurityLog({
    kv: d.disk.kv,
    lock: (fn) => fn(),
    onDiag: () => undefined,
  } as ConstructorParameters<typeof SecurityLog>[0]);
  return d;
}
const entries = (d: Device, kind: string): number => {
  const log = d.disk.kv.data.get(SECURITY_LOG_KEY) as { entries?: { kind: string }[] } | undefined;
  return (log?.entries ?? []).filter((e) => e.kind === kind).length;
};

describe("wrong secrets typed into the adoption are recorded like Phase 0's", () => {
  it("Phase 0's unlock records a wrong password", async () => {
    const w = await worldOf(1);
    const a = withLog((w.devices as [Device])[0]);
    await a.lockNow();
    await a.svc.unlockWithPassword("not the password").catch(() => undefined);
    expect(entries(a, "unlock_failed")).toBe(1);
  });

  it("the adoption on a locked page: a wrong password recorded, the page still locked; the right one records nothing", async () => {
    const w = await worldOf(1);
    const a = withLog((w.devices as [Device])[0]);
    await a.lockNow();
    const r = await adoptWithSecret(a.engine, { password: "not the password" });
    expect(r).toEqual({ kind: "rejected", reason: "wrong_secret" });
    expect((await a.svc.status()).state).toBe("locked");
    expect(entries(a, "unlock_failed")).toBe(1);
    await adoptWithSecret(a.engine, { password: w.password });
    expect(entries(a, "unlock_failed")).toBe(1);
  });

  it("a wrong recovery code (well formed) is recorded as Phase 0 records one", async () => {
    const w = await worldOf(1);
    const a = withLog((w.devices as [Device])[0]);
    await a.lockNow();
    const other = (await generateRecoveryCode()).text; // a valid code, not this vault's
    expect(await adoptWithSecret(a.engine, { recoveryCode: other })).toEqual({
      kind: "rejected",
      reason: "wrong_secret",
    });
    expect([entries(a, "recovery_failed"), entries(a, "unlock_failed")]).toEqual([1, 0]);
  });

  it("the locked card's form (the panel): each wrong password is one entry", async () => {
    const w = await worldOf(1);
    const a = withLog((w.devices as [Device])[0]);
    const kit = kitOf(a, permissions(true));
    await a.lockNow();
    const ctl = new SyncPanelCtl(kit, { vault: () => "locked", reload: async () => undefined, now: () => w.clock.now });
    await ctl.refresh();
    await ctl.adopt("guess one");
    await ctl.adopt("guess two");
    expect(ctl.state.failure).toMatchObject({ code: "wrong_secret" });
    expect(entries(a, "unlock_failed")).toBe(2);
    expect((await a.svc.status()).state).toBe("locked");
  });
});
