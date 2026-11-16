// H3 (PHASE0X-PLAN C6, SYNC-DESIGN item 62): every export asks for the master password, and no other way around it gets
// the seeds out of an unlocked browser without that password.
//
// KNOWN OPEN: C6-REVIEW C6-1 (High). Settings › Security › "Create new recovery code" asks for no password
// (VaultService.newRecoveryCode, Security.tsx). Someone at the unlocked browser makes a code, locks, resets the master
// password with it, and then passes the export check with their own password; the same password clears the security
// log. The fix (newRecoveryCode(password) calling verifyPassword first, and a password field in that box) belongs to the
// service and Security.tsx after A4, not to C6. Until it lands this test fails, so it is marked it.fails; once the fix
// is in, it passes and it.fails reports that: then make it a plain it.
import { describe, expect, it } from "vitest";
import { createBackup, openBackup } from "../../src/core/backup/backup";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { SecurityLog } from "../../src/core/service/security-log";
import { KvSettingsStore, MemorySession } from "../../src/core/service/types";
import { addEntry } from "../../src/core/vault/ops";
import { createProtected, STRONG } from "../helpers/vaults";

const MINE = "attacker chosen password 77!";

describe("H3 outside Settings › Backup", () => {
  it("C6-1: a new recovery code needs the master password, so it cannot be used to replace it and export everything", async () => {
    const kv = new MemoryKV();
    const t = { now: 1_750_000_000_000 };
    const log = new SecurityLog({ kv, now: () => t.now });
    const svc = new VaultService({
      store: new VaultStore({ kv, lock: createMutex(), now: () => t.now }),
      session: new MemorySession(),
      settings: new KvSettingsStore(kv),
      now: () => t.now,
      security: log,
    });
    await createProtected(svc); // the owner's master password: STRONG
    await svc.mutate(
      (v, c) =>
        addEntry(
          v,
          {
            type: "totp",
            issuer: "Bank",
            label: "owner",
            secret: "KRSXG5CTMVRXEZLU",
            algorithm: "SHA1",
            digits: 6,
            period: 30,
          },
          c,
        ).vault,
    );

    // The owner steps away from the unlocked browser. Without the master password (the call as Security.tsx makes it):
    let recoveryCode = "";
    let bypassed = false;
    try {
      await svc.newRecoveryCode("", {
        onCode: (c) => {
          recoveryCode = c;
        },
      }); // all they can type: not the password
      await svc.lock(); // popup: Lock
      await svc.commitReset(await svc.prepareReset(recoveryCode, MINE)); // popup: Use recovery key › Set a new password (a settings tab)
      await svc.verifyPassword(MINE); // the export check now accepts the attacker's password
      const file = await createBackup((await svc.read()).vault, MINE);
      bypassed = (await openBackup(file, MINE)).vault.entries.some((e) => e.secret === "KRSXG5CTMVRXEZLU");
    } catch {
      /* refused somewhere along the way: what the fix makes happen at the first step */
    }
    expect(bypassed).toBe(false);
    // and the owner keeps their password
    await expect(svc.verifyPassword(STRONG)).resolves.toBeUndefined();
  });
});
