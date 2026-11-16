// A new master password set with the recovery code (SYNC-DESIGN §3.3 step 5) whose local commit never happened: the
// server accepted the new bundle, then the page closed (or the local write failed). This profile's keyring still has
// the forgotten password's wrap and the old code's; the server has the new password and the new code. The screens told
// the user to keep the old code until Sixkey says the change is done; and the locked page offers the new password:
//   - the new password does not open this device's own keys, the old code still does;
//   - the change is recorded as sent and not confirmed (pendingRecoveryWrap): the locked card offers "unlock with the
//     server's password" beside the page's own unlock, and the popup's lock line points there after a failed unlock;
//   - that unlock (the engine's adoption with the new password) opens the locked page.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { commitRecoveryReset, prepareRecoveryReset } from "../../src/core/sync/engine/keys";
import { keysChangedElsewhere } from "../../src/core/sync/local/state";
import { readFacts } from "../../src/options/sync/gateway";
import { cardOf } from "../../src/options/sync/model";
import { SyncPanelCtl } from "../../src/options/sync/panel";
import { worldOf, type Device } from "../helpers/m3-world";
import { kitOf, permissions } from "../helpers/m6-kit";

const opens = (p: Promise<unknown>) =>
  p.then(
    () => true,
    () => false,
  );
const NEW_PW = "brand-new-strong-passphrase-42";

describe("a new master password with the recovery code, accepted on the server and not committed here", () => {
  it("the locked page offers the password set on the server, and it opens the page", async () => {
    const w = await worldOf(2);
    const [a] = w.devices as [Device];
    const h = await prepareRecoveryReset(a.engine, { recoveryCode: w.code, newPassword: NEW_PW });
    const flows = a.engine.deps.flows;
    const real = flows.commitKeys.bind(flows);
    flows.commitKeys = async () => {
      throw new Error("the page closed here");
    };
    await expect(commitRecoveryReset(a.engine, h)).rejects.toThrow();
    flows.commitKeys = real;
    await a.lockNow();
    expect({
      newPw: await opens(a.svc.unlockWithPassword(NEW_PW)),
      oldCode: await opens(a.svc.unlockWithRecoveryCode(w.code)),
    }).toEqual({ newPw: false, oldCode: true });
    await a.lockNow();
    // the worker's round on the locked profile, then the page's card and the popup's line
    expect((await a.engine.round()).status).toBe("locked");
    const kit = kitOf(a, permissions(true));
    const card = cardOf(await readFacts(kit), "locked", w.clock.now, String);
    expect(card?.actions).toEqual(["unlock", "adopt"]);
    expect(await keysChangedElsewhere(a.disk.kv)).toBe("pending");
    // the card's form: the new password, on the locked page
    const ctl = new SyncPanelCtl(kit, { vault: () => "locked", reload: async () => undefined, now: () => w.clock.now });
    await ctl.refresh();
    await ctl.adopt(NEW_PW);
    expect(ctl.state.failure).toBeNull();
    expect((await a.svc.status()).state).toBe("unlocked");
  });

  it("an unconfirmed new code with the password unchanged: the page's own password, typed in that form, opens it too", async () => {
    const w = await worldOf(1);
    const [a] = w.devices as [Device];
    const kit = kitOf(a, permissions(true));
    await a.engine.state.update(() => ({ pendingRecoveryWrap: { fp: "x", at: w.clock.now, kver: 9 } })); // sent, not confirmed
    await a.lockNow();
    expect((await a.engine.round()).status).toBe("locked");
    expect(cardOf(await readFacts(kit), "locked", w.clock.now, String)?.actions).toEqual(["unlock", "adopt"]);
    const ctl = new SyncPanelCtl(kit, { vault: () => "locked", reload: async () => undefined, now: () => w.clock.now });
    await ctl.refresh();
    await ctl.adopt(w.password); // this device's own keys open with it: Phase 0's unlock, with the same password
    expect(ctl.state.failure).toBeNull();
    expect((await a.svc.status()).state).toBe("unlocked");
  });
});
