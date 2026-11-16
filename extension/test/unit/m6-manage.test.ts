// The Sync section's managing flows (src/options/sync/devicelist.ts, approve.ts, keyops.ts, revoke.ts, repair.ts,
// fork.ts; M6 part B) over the in-memory FakeServer, driven the way their screens drive them, with the stand-in
// chrome.permissions that grants only inside a click (test/helpers/m6-kit.ts). What is checked, besides the step
// reached: what reached the server, what the other devices see, and that every flow ends at a lock and says the engine's
// outcome ("unconfirmed" as such).
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { ApproveFlow } from "../../src/options/sync/approve";
import { formatPairingCode } from "../../src/core/crypto/pairing-code";
import { ApproverEnrollment } from "../../src/core/sync/crypto/enroll-approver";
import { DevicesCtl, isLastDevice, listDue } from "../../src/options/sync/devicelist";
import { revokeDevice } from "../../src/core/sync/engine/keys";
import { readFacts } from "../../src/options/sync/gateway";
import { DeleteFlow, ForkFlow } from "../../src/options/sync/fork";
import { JoinFlow } from "../../src/options/sync/join";
import { KeyOpFlow } from "../../src/options/sync/keyops";
import { SyncPanelCtl } from "../../src/options/sync/panel";
import { asking } from "../../src/options/sync/permission";
import { RepairFlow } from "../../src/options/sync/repair";
import { RevokeFlow } from "../../src/options/sync/revoke";
import { listDevices } from "../../src/core/sync/engine/devices";
import { EMAIL, worldOf, type Device, type World } from "../helpers/m3-world";
import { click, emptyProfile, kitOf, permissions, until, type PermFake, type TestKit } from "../helpers/m6-kit";

const NEW_PW = "another-strong-passphrase-42";

/** A synced device's kit, the permission held (sync is on). */
function kitFor(d: Device): { kit: TestKit; perm: PermFake } {
  const perm = permissions(true);
  return { kit: kitOf(d, perm), perm };
}
function begin<F extends { start(g: Promise<boolean>): Promise<void> }>(kit: TestKit, perm: PermFake, f: F): F {
  click(
    perm,
    asking(kit, (g) => void f.start(g)),
  );
  return f;
}
const typeBack = (code: string, groups: [number, number]): [string, string] => {
  const p = code.split("-");
  return [p[groups[0]]!, p[groups[1]]!];
};
const at = (f: { state: { at: string } }) => f.state.at;
/** The security record's entries for actions on the server (recordAction), as the device's flows add them. */
function actionsOf(d: Device): string[] {
  const seen: string[] = [];
  const flows = d.engine.deps.flows;
  const record = flows.recordAction.bind(flows);
  flows.recordAction = (kind) => {
    seen.push(kind);
    return record(kind);
  };
  return seen;
}

describe("managing a sync account from the Sync section", () => {
  describe("the device list", () => {
    it("names, this device first; rename with the master password; a lock takes the names off", async () => {
      const w = await worldOf(2);
      const [a] = w.devices as [Device, Device];
      const { kit, perm } = kitFor(a);
      const ctl = new DevicesCtl(kit);
      await ctl.load();
      expect(ctl.state.rows!.map((r) => [r.name, r.current])).toEqual([
        ["Device A", true],
        ["Device B", false],
      ]);
      const b = ctl.state.rows![1]!;
      click(perm, () => void ctl.rename(b.id, "Work laptop", "wrong", Promise.resolve(true)));
      await until(() => ctl.state.doing === null && ctl.state.failure !== null, "the wrong password");
      expect(ctl.state.failure).toMatchObject({ code: "wrong_secret" });
      expect(await ctl.rename(b.id, "  ", w.password, Promise.resolve(true))).toBe(false);
      expect(ctl.state.nameProblem).toMatchObject({ id: b.id });
      expect(await ctl.rename(b.id, "Work laptop", w.password, Promise.resolve(true))).toBe(true);
      expect(ctl.state.rows!.find((r) => r.id === b.id)!.name).toBe("Work laptop");
      ctl.locked();
      expect(ctl.state.rows!.map((r) => r.name)).toEqual([null, null]);
    });

    it("loaded by the page only with sync on here and outside the server's backoff; an earlier join's old vault seen", async () => {
      const w = await worldOf(1);
      const [a] = w.devices as [Device];
      const { kit } = kitFor(a);
      const f = await readFacts(kit);
      const now = w.clock.now;
      expect(listDue(f, now)).toBe(true);
      expect(listDue({ ...f, backoffUntil: now + 5_000 }, now)).toBe(false); // the worker ends a backoff, not the page
      expect(listDue({ ...f, backoffUntil: now - 1 }, now)).toBe(true);
      expect(listDue({ ...f, local: "identity_missing" }, now)).toBe(false);
      expect(listDue({ ...f, syncOn: false }, now)).toBe(false);
      expect(listDue(null, now)).toBe(false);
      // and the vaults kept from before a join, as stored (never opened here): an entry that can't be read is listed too
      expect(f.kept).toEqual([]);
      a.disk.kv.data.set("sk_prejoin", { kept: "something that is not a kept vault" });
      expect((await readFacts(kit)).kept).toEqual([{ id: expect.any(String), at: null }]);
    });

    it("the last device not revoked is known as such (turning it off warns, §3.10)", async () => {
      const w = await worldOf(2);
      const [a, b] = w.devices as [Device, Device];
      expect(isLastDevice(null)).toBe(false);
      expect(isLastDevice(await listDevices(a.engine))).toBe(false);
      const other = (await listDevices(a.engine)).find((r) => !r.current)!;
      await revokeDevice(a.engine, other.id, w.password);
      expect(isLastDevice(await listDevices(a.engine))).toBe(true);
      void b;
    });

    it("declined at Chrome's prompt: nothing sent; reject all and clear history with the master password (recorded)", async () => {
      const w = await worldOf(2);
      const [a] = w.devices as [Device, Device];
      const { kit } = kitFor(a);
      const ctl = new DevicesCtl(kit);
      const sent = w.server.requests.length;
      expect(await ctl.rejectAll(w.password, Promise.resolve(false))).toBe(false);
      expect(ctl.state.failure).toEqual({ code: "declined" });
      expect(w.server.requests.length).toBe(sent);
      for (const name of ["New phone", "New laptop"]) {
        const n = w.device(name);
        const j = new JoinFlow(kitOf(n, permissions(true)), { timer: () => () => undefined });
        await j.start(Promise.resolve(true));
        await j.signin.send(EMAIL);
        await j.signin.verify(w.server.inbox(EMAIL));
        await until(() => at(j) === "choose");
        j.setName(name);
        await j.chooseApproval();
        expect(at(j)).toBe("waiting");
      }
      expect(await ctl.rejectAll(w.password, Promise.resolve(true))).toBe(true);
      expect(ctl.state.done).toEqual({ k: "syncDoneRejectedAll", s: [2] });
      w.advance(1000);
      await a.add("one more version");
      await a.engine.round();
      const recorded = actionsOf(a);
      expect(await ctl.clearHistory("not it", Promise.resolve(true))).toBe(false);
      a.net.inject({ match: "DELETE /v1/vault/versions", kind: "fail_before", count: 10 }); // the password right, the server unreached
      expect(await ctl.clearHistory(w.password, Promise.resolve(true))).toBe(false);
      a.net.clearRules();
      expect(recorded).toEqual([]);
      expect(await ctl.clearHistory(w.password, Promise.resolve(true))).toBe(true);
      expect(ctl.state.done?.k).toBe("syncDoneHistoryCleared");
      expect(recorded).toEqual(["history_cleared"]);
    });
  });

  describe("approving a new device (O9)", () => {
    /** A new profile asks to join by approval, as far as its waiting step. */
    async function newDeviceWaiting(w: World) {
      const nperm = permissions(false);
      const n = emptyProfile(w, "N", nperm);
      const nkit = kitOf(n, nperm);
      const j = new JoinFlow(nkit, { timer: () => () => undefined });
      begin(nkit, nperm, j);
      await until(() => at(j) === "signin");
      await j.signin.send(EMAIL);
      await j.signin.verify(w.server.inbox(EMAIL));
      await until(() => at(j) === "choose");
      j.setName("New laptop");
      await j.chooseApproval();
      expect(at(j)).toBe("waiting");
      return { n, j };
    }

    it("the password, the request, the pairing code shown once respond was accepted and typed there, the six digits back (a wrong try, then the right ones): joined", async () => {
      const w = await worldOf(1);
      const [a] = w.devices as [Device];
      const { kit, perm } = kitFor(a);
      const { n, j } = await newDeviceWaiting(w);
      const f = begin(kit, perm, new ApproveFlow(kit, { timer: () => () => undefined }));
      await until(() => at(f) === "password");
      await f.submitPassword(w.password);
      const s1 = f.state;
      if (s1.at !== "list") throw new Error(`unexpected ${s1.at}`);
      expect(s1.requests).toHaveLength(1);
      await f.choose(s1.requests[0]!.rid);
      const sc = f.state;
      if (sc.at !== "code") throw new Error(`unexpected ${sc.at}`);
      expect(sc.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/);
      const responded = w.server.requests.findIndex((r) => r.op === "POST /v1/enroll/requests/{rid}/respond");
      expect(responded).toBeGreaterThanOrEqual(0); // shown only after the server accepted respond (MUST 5)
      expect(await f.copyCode()).toBe(true); // Copy, on the user's click: the system clipboard (kit.copy)
      expect(kit.copied).toEqual([sc.code]);
      await f.pollOnce();
      expect(at(f)).toBe("code"); // the new device has not revealed yet: the code stays on screen
      await j.pollOnce(); // the new device asks for the code once this one answered
      expect(at(j)).toBe("code");
      await j.submitCode(sc.code);
      const ns = j.state;
      if (ns.at !== "sas") throw new Error(`unexpected ${ns.at}`);
      await f.pollOnce();
      const s2 = f.state;
      if (s2.at !== "sas") throw new Error(`unexpected ${s2.at}`);
      expect(JSON.stringify(f.state).includes(sc.code)).toBe(false); // the code left this screen at the reveal
      expect(await f.copyCode()).toBe(false);
      expect(s2.claimedName).toBe("New laptop");
      const recorded = actionsOf(a);
      await f.submitSas(ns.sas === "000000" ? "111111" : "000000");
      expect(f.state).toMatchObject({ at: "sas", problem: "wrong", attemptsLeft: 2 });
      await f.submitSas("12");
      expect(f.state).toMatchObject({ at: "sas", problem: "malformed", attemptsLeft: 2 }); // no attempt used
      expect(recorded).toEqual([]);
      await f.submitSas(ns.sas);
      expect(recorded).toEqual(["device_approved"]); // the security record, once the server accepted the approval
      expect(f.state).toEqual({ at: "done" });
      const sentBefore = w.server.requests.length;
      await f.rejectCurrent(); // approved: the master password is no longer held, so nothing can be sent with it
      expect(w.server.requests.length).toBe(sentBefore);
      expect(at(f)).toBe("done");
      // approved: no longer waiting for an answer, so another approval does not list it
      const g = begin(kit, perm, new ApproveFlow(kit, { timer: () => () => undefined }));
      await until(() => at(g) === "password");
      await g.submitPassword(w.password);
      expect(g.state).toMatchObject({ at: "list", requests: [] });
      await g.cancel();
      await j.pollOnce();
      expect(at(j)).toBe("summary");
      await j.commit();
      expect(at(j)).toBe("done");
      expect((await listDevices(a.engine)).map((r) => r.name)).toContain("New laptop");
      void n;
    });

    it("the new device used another code: the mismatch screen, the request rejected with the password; the new device sees it end", async () => {
      const w = await worldOf(1);
      const [a] = w.devices as [Device];
      const { kit, perm } = kitFor(a);
      const { j } = await newDeviceWaiting(w);
      const f = begin(kit, perm, new ApproveFlow(kit, { timer: () => () => undefined }));
      await until(() => at(f) === "password");
      await f.submitPassword(w.password);
      const s1 = f.state;
      if (s1.at !== "list") throw new Error(`unexpected ${s1.at}`);
      await f.choose(s1.requests[0]!.rid);
      expect(at(f)).toBe("code");
      await j.pollOnce();
      await j.submitCode(await formatPairingCode(crypto.getRandomValues(new Uint8Array(16)))); // passes its check bits
      expect(at(j)).toBe("sas");
      const rejects = () => w.server.requests.filter((r) => r.op === "POST /v1/enroll/requests/{rid}/reject").length;
      await f.pollOnce();
      expect(f.state).toEqual({ at: "mismatch" });
      expect([f.isOver, rejects()]).toEqual([true, 1]);
      expect(actionsOf(a)).toEqual([]);
      await j.pollOnce();
      expect(j.state).toMatchObject({ at: "failed", failure: { code: "join_ended" } });
    });

    it("a lock while the pairing code is on screen ends the flow: the code gone from the screen, the machine (and S) ended", async () => {
      const w = await worldOf(1);
      const [a] = w.devices as [Device];
      const { kit, perm } = kitFor(a);
      const { j } = await newDeviceWaiting(w);
      const f = begin(kit, perm, new ApproveFlow(kit, { timer: () => () => undefined }));
      await until(() => at(f) === "password");
      await f.submitPassword(w.password);
      const s1 = f.state;
      if (s1.at !== "list") throw new Error(`unexpected ${s1.at}`);
      await f.choose(s1.requests[0]!.rid);
      const sc = f.state;
      if (sc.at !== "code") throw new Error(`unexpected ${sc.at}`);
      const aborts = vi.spyOn(ApproverEnrollment.prototype, "abort");
      await a.lockNow();
      await f.locked();
      expect(f.state).toEqual({ at: "failed", failure: { code: "locked_out" } });
      expect(aborts).toHaveBeenCalledWith("cancelled"); // the approver's machine ended: S wiped (MUST 10)
      aborts.mockRestore();
      expect(await f.copyCode()).toBe(false);
      await j.pollOnce(); // the new device asks for the code; the approver's machine was dropped with the flow
      expect(JSON.stringify(f.state).includes(sc.code)).toBe(false);
    });

    it("a wrong master password: asked again; a request rejected from the list; a lock while the digits are typed ends it", async () => {
      const w = await worldOf(1);
      const [a] = w.devices as [Device];
      const { kit, perm } = kitFor(a);
      await newDeviceWaiting(w);
      const f = begin(kit, perm, new ApproveFlow(kit, { timer: () => () => undefined }));
      await until(() => at(f) === "password");
      await f.submitPassword("not it");
      const s1 = f.state;
      if (s1.at !== "list") throw new Error(`unexpected ${s1.at}`);
      await f.choose(s1.requests[0]!.rid); // the server's pre-send check refuses the password at the first step that sends it
      expect(f.state).toMatchObject({ at: "password", failure: { code: "wrong_secret" } });
      await f.submitPassword(w.password);
      const s2 = f.state;
      if (s2.at !== "list") throw new Error(`unexpected ${s2.at}`);
      await f.reject(s2.requests[0]!.rid);
      expect(f.state).toMatchObject({ at: "list", requests: [] });
      await f.refresh(); // the server still lists it, as rejected: no longer waiting, so not shown
      expect(f.state).toMatchObject({ at: "list", requests: [] });
      // a second request, answered, then a lock
      await newDeviceWaiting(w);
      await f.refresh();
      const s3 = f.state;
      if (s3.at !== "list") throw new Error(`unexpected ${s3.at}`);
      await f.choose(s3.requests[0]!.rid);
      await a.lockNow();
      await f.locked();
      expect(f.state).toEqual({ at: "failed", failure: { code: "locked_out" } });
    });

    it("Cancel while a request is being answered gives it up (rejected with the password); the new device stops waiting", async () => {
      const w = await worldOf(1);
      const [a] = w.devices as [Device];
      const { kit, perm } = kitFor(a);
      const { j } = await newDeviceWaiting(w);
      const f = begin(kit, perm, new ApproveFlow(kit, { timer: () => () => undefined }));
      await until(() => at(f) === "password");
      await f.submitPassword(w.password);
      const s1 = f.state;
      if (s1.at !== "list") throw new Error(`unexpected ${s1.at}`);
      await f.choose(s1.requests[0]!.rid);
      const rejects = () => w.server.requests.filter((r) => r.op === "POST /v1/enroll/requests/{rid}/reject").length;
      expect(rejects()).toBe(0);
      await f.cancel();
      expect(f.state).toEqual({ at: "closed" });
      expect(rejects()).toBe(1);
      await j.pollOnce();
      expect(j.state).toMatchObject({ at: "failed" }); // the new device is told (its request is gone)
    });

    it("declined at Chrome's prompt: ended, nothing asked", async () => {
      const w = await worldOf(1);
      const [a] = w.devices as [Device];
      const { kit, perm } = kitFor(a);
      perm.answer = false;
      perm.granted = false;
      const f = begin(kit, perm, new ApproveFlow(kit));
      await until(() => f.isOver);
      expect(f.state).toEqual({ at: "failed", failure: { code: "declined" } });
    });
  });

  describe("the key operations (O11)", () => {
    it("change the master password: a wrong one and a weak one stay on the form; done, the other device takes the new one", async () => {
      const w = await worldOf(2);
      const [a, b] = w.devices as [Device, Device];
      const { kit, perm } = kitFor(a);
      const f = begin(kit, perm, new KeyOpFlow(kit, "password"));
      await until(() => at(f) === "form");
      await f.submit({ password: "wrong", newPassword: NEW_PW });
      expect(f.state).toMatchObject({ at: "form", failure: { code: "wrong_secret" } });
      await f.submit({ password: w.password, newPassword: "short" });
      expect(f.state).toMatchObject({ at: "form", failure: { code: "weak_password" } });
      await f.submit({ password: w.password, newPassword: NEW_PW });
      expect(f.state).toEqual({ at: "done", passwordChanged: true, newCode: false });
      await b.engine.round();
      expect((await b.engine.view()).state.keyStatus).toBe("needs_new_password");
    });

    it("change it and rotate the keys: the new code shown and typed back (wrong, then right) before the rotation is sent", async () => {
      const w = await worldOf(2);
      const [a] = w.devices as [Device, Device];
      const { kit, perm } = kitFor(a);
      const f = begin(kit, perm, new KeyOpFlow(kit, "password", { random: () => 0 }));
      await until(() => at(f) === "form");
      await f.submit({ password: w.password, newPassword: NEW_PW, rotate: true });
      const s = f.state;
      if (s.at !== "show") throw new Error(`unexpected ${s.at}`);
      const rotates = () => w.server.requests.filter((r) => r.op === "POST /v1/keys/rotate").length;
      expect(rotates()).toBe(0);
      f.saved();
      const c = f.state;
      if (c.at !== "confirm") throw new Error(`unexpected ${c.at}`);
      await f.confirmGroups(["0000", "0000"]);
      expect(f.state).toMatchObject({ at: "confirm", wrong: true });
      expect(rotates()).toBe(0);
      await f.confirmGroups(typeBack(s.code, c.groups));
      expect(f.state).toEqual({ at: "done", passwordChanged: true, newCode: true });
      expect(rotates()).toBe(1);
    });

    it("a new recovery code whose answer is lost: unconfirmed (keep both), never done", async () => {
      const w = await worldOf(1);
      const [a] = w.devices as [Device];
      const { kit, perm } = kitFor(a);
      const f = begin(kit, perm, new KeyOpFlow(kit, "recovery", { random: () => 0 }));
      await until(() => at(f) === "form");
      await f.submit({ password: w.password });
      const s = f.state;
      if (s.at !== "show") throw new Error(`unexpected ${s.at}`);
      f.saved();
      const c = f.state;
      if (c.at !== "confirm") throw new Error(`unexpected ${c.at}`);
      a.net.inject({ match: "PUT /v1/keys", kind: "fail_before", count: 10 });
      a.net.inject({ match: "GET /v1/keys", kind: "fail_before", count: 10 });
      await f.confirmGroups(typeBack(s.code, c.groups));
      expect(f.state).toEqual({ at: "unconfirmed", newCode: true });
    });

    it("a lock while the new code is being sent: the flow waits for the write, then says what the engine said", async () => {
      const w = await worldOf(1);
      const [a] = w.devices as [Device];
      const { kit, perm } = kitFor(a);
      const f = begin(kit, perm, new KeyOpFlow(kit, "recovery", { random: () => 0 }));
      await until(() => at(f) === "form");
      await f.submit({ password: w.password });
      const s = f.state;
      if (s.at !== "show") throw new Error(`unexpected ${s.at}`);
      f.saved();
      const c = f.state;
      if (c.at !== "confirm") throw new Error(`unexpected ${c.at}`);
      a.net.inject({ match: "PUT /v1/keys", kind: "hold", count: 1 });
      const sending = f.confirmGroups(typeBack(s.code, c.groups));
      await until(() => a.net.heldCount === 1, "the write on its way");
      await a.lockNow();
      await f.locked();
      expect(f.state).toMatchObject({ at: "confirm", busy: true }); // not ended under the write
      await a.net.release();
      await sending;
      expect(f.state).toEqual({ at: "done", passwordChanged: false, newCode: true }); // the write landed: said as such
    });

    it("rotate the keys; a lock with the new code on screen ends the flow and takes the code from its state", async () => {
      const w = await worldOf(1);
      const [a] = w.devices as [Device];
      const { kit, perm } = kitFor(a);
      const f = begin(kit, perm, new KeyOpFlow(kit, "rotate"));
      await until(() => at(f) === "form");
      await f.submit({ password: w.password });
      const s = f.state;
      if (s.at !== "show") throw new Error(`unexpected ${s.at}`);
      await a.lockNow();
      await f.locked();
      expect(f.state).toEqual({ at: "failed", failure: { code: "locked_out" } });
      expect(JSON.stringify(f.state)).not.toContain(s.code.split("-")[0]);
    });

    it("a new master password with the recovery code: the new code shown first; done; the old code no longer works", async () => {
      const w = await worldOf(1);
      const [a] = w.devices as [Device];
      const { kit, perm } = kitFor(a);
      const f = begin(kit, perm, new KeyOpFlow(kit, "reset", { random: () => 0 }));
      await until(() => at(f) === "form");
      await f.submit({ recoveryCode: w.code, newPassword: NEW_PW });
      const s = f.state;
      if (s.at !== "show") throw new Error(`unexpected ${s.at}`);
      f.saved();
      const c = f.state;
      if (c.at !== "confirm") throw new Error(`unexpected ${c.at}`);
      await f.confirmGroups(typeBack(s.code, c.groups));
      expect(f.state).toEqual({ at: "done", passwordChanged: true, newCode: true });
      await a.lockNow();
      await expect(a.svc.unlockWithRecoveryCode(w.code)).rejects.toBeTruthy();
      await a.svc.unlockWithPassword(NEW_PW);
    });
  });

  describe("revoking a device (O10)", () => {
    it("still in my hands: revoked; that device then stops", async () => {
      const w = await worldOf(2);
      const [a, b] = w.devices as [Device, Device];
      const { kit, perm } = kitFor(a);
      const target = (await listDevices(a.engine)).find((r) => !r.current)!;
      const f = begin(kit, perm, new RevokeFlow(kit, { id: target.id, name: target.name }, []));
      await until(() => at(f) === "password");
      await f.submitPassword("wrong");
      expect(f.state).toMatchObject({ at: "password", failure: { code: "wrong_secret" } });
      await f.submitPassword(w.password);
      expect(f.state).toMatchObject({ at: "reason", reason: null, protectOnly: false });
      await f.confirm();
      expect(f.state).toMatchObject({ at: "reason", failure: { code: "choose_reason" } }); // none preselected
      f.setReason("retired");
      const recorded = actionsOf(a);
      await f.confirm();
      expect(f.state).toEqual({ at: "done", reason: "retired", revoked: 1 });
      expect(recorded).toEqual(["device_revoked"]);
      expect((await b.engine.round()).status).toBe("rejected_by_server");
    });

    it("lost or stolen: the new code shown and typed back before anything is revoked; then revoked and rotated; the device that wrote the keys: only this way", async () => {
      const w = await worldOf(2);
      const [a, b] = w.devices as [Device, Device];
      const { kit, perm } = kitOf2(b);
      const target = (await listDevices(b.engine)).find((r) => !r.current)!; // A wrote the current keys (its first upload)
      const f = begin(kit, perm, new RevokeFlow(kit, { id: target.id, name: target.name }, [], { random: () => 0 }));
      await until(() => at(f) === "password");
      await f.submitPassword(w.password);
      expect(f.state).toMatchObject({ at: "reason", reason: "lost", protectOnly: true });
      f.setReason("retired"); // not offered
      expect(f.state).toMatchObject({ reason: "lost" });
      const rotates = () => w.server.requests.filter((r) => r.op === "POST /v1/keys/rotate").length;
      const revokes = () => w.server.requests.filter((r) => r.op === "POST /v1/devices/{id}/revoke").length;
      await f.confirm();
      const s = f.state;
      if (s.at !== "show") throw new Error(`unexpected ${s.at}`);
      expect(revokes()).toBe(0); // nothing revoked while the code is on screen: Cancel there leaves everything as it was
      f.saved();
      const c = f.state;
      if (c.at !== "confirm") throw new Error(`unexpected ${c.at}`);
      await f.confirmGroups(["0000", "0000"]);
      expect(f.state).toMatchObject({ at: "confirm", wrong: true });
      expect([revokes(), rotates()]).toEqual([0, 0]);
      await f.confirmGroups(typeBack(s.code, c.groups));
      expect(f.state).toEqual({ at: "done", reason: "lost", revoked: 1 });
      expect([revokes(), rotates()]).toEqual([1, 1]);
      const order = w.server.requests
        .map((r) => r.op)
        .filter((op) => op === "POST /v1/devices/{id}/revoke" || op === "POST /v1/keys/rotate");
      expect(order).toEqual(["POST /v1/devices/{id}/revoke", "POST /v1/keys/rotate"]); // revoked first, on the wire (§3.10)
      expect((await b.engine.view()).state.rotationOwed ?? null).toBeNull();
      expect((await a.engine.round()).status).toBe("rejected_by_server");
    });

    it("the devices it approved are listed ticked, and can be unticked", async () => {
      const w = await worldOf(3);
      const [a] = w.devices as [Device, Device, Device];
      const { kit } = kitFor(a);
      const rows = await listDevices(a.engine);
      const [, b, c] = rows;
      const f = new RevokeFlow(kit, { id: b!.id, name: b!.name }, [{ id: c!.id, name: c!.name }]);
      await f.start(Promise.resolve(true));
      await f.submitPassword(w.password);
      expect(f.state).toMatchObject({ at: "reason", ticked: [c!.id] });
      f.toggle(c!.id);
      expect(f.state).toMatchObject({ ticked: [] });
      f.toggle("not-a-listed-device");
      expect(f.state).toMatchObject({ ticked: [] });
    });
  });

  describe("the cards' ways out (O12)", () => {
    it("repair the cloud when the server's keys are not behind: refused, nothing changed", async () => {
      const w = await worldOf(1);
      const [a] = w.devices as [Device];
      const { kit, perm } = kitFor(a);
      const f = begin(kit, perm, new RepairFlow(kit));
      await until(() => at(f) === "form");
      await f.submit({ oldPassword: "", password: w.password, recoveryCode: w.code });
      expect(f.state).toEqual({ at: "failed", failure: { code: "not_behind" } });
    });

    it("the cloud restore: the vault lost here, the master password restores it from the synced vault", async () => {
      const w = await worldOf(1);
      const [a] = w.devices as [Device];
      const { kit } = kitFor(a);
      for (const k of ["sk_slot_a", "sk_slot_b"]) a.disk.kv.data.set(k, { broken: true });
      for (const k of [...a.disk.kv.data.keys()])
        if (k.startsWith("sk_snap") || k === "sk_keyring") a.disk.kv.data.delete(k);
      a.disk.mirror.data.clear();
      a.restartWorker();
      expect(await a.flows.vaultStatus()).toBe("lost");
      const ctl = new SyncPanelCtl(kit, { vault: () => "lost", reload: async () => undefined, now: () => w.clock.now });
      await ctl.refresh();
      await ctl.adopt(w.password);
      expect(ctl.state.done).toBe("syncDoneRestored");
      expect(await a.flows.vaultStatus()).toBe("ok");
      expect((await a.vault()).entries.length).toBeGreaterThan(0);
    });

    it("a separate device: a wrong password and a bad name stay on the form; then a device of its own", async () => {
      const w = await worldOf(2);
      const [a] = w.devices as [Device, Device];
      const { kit, perm } = kitFor(a);
      const before = (await listDevices(a.engine)).find((r) => r.current)!.id;
      const f = begin(kit, perm, new ForkFlow(kit));
      await until(() => at(f) === "form");
      await f.submit("wrong", "Copy");
      expect(f.state).toMatchObject({ at: "form", failure: { code: "wrong_secret" } });
      await f.submit(w.password, "");
      expect(f.state).toMatchObject({ at: "form", problem: "empty" });
      await f.submit(w.password, "Copy");
      expect(at(f)).toBe("done");
      const me = (await listDevices(a.engine)).find((r) => r.current)!;
      expect(me.id).not.toBe(before);
      expect(me.approvedBy).toBe(before);
    });
  });

  describe("deleting the sync account (O14)", () => {
    it("a lock while the password is being checked: the check's own failure is said as the lock; nothing deleted", async () => {
      const w = await worldOf(1);
      const [a] = w.devices as [Device];
      const { kit, perm } = kitFor(a);
      const f = begin(kit, perm, new DeleteFlow(kit));
      await until(() => at(f) === "signin");
      await f.signin.send(EMAIL);
      await f.signin.verify(w.server.inbox(EMAIL));
      await until(() => at(f) === "password");
      a.net.inject({ match: "GET /v1/keys", kind: "hold", count: 1 });
      const sending = f.submitPassword("wrong");
      await until(() => a.net.heldCount === 1, "the check on its way");
      await a.lockNow();
      await f.locked();
      expect(f.state).toMatchObject({ at: "password", busy: true });
      await a.net.release();
      await sending;
      expect(f.state).toEqual({ at: "failed", failure: { code: "locked_out" } });
      expect(() => w.server.account(EMAIL)).not.toThrow();
    });

    it("the code, then the password (wrong, then right; a stale sign-in asks again): the account gone, sync off here, the permission back last", async () => {
      const w = await worldOf(2);
      const [a, b] = w.devices as [Device, Device];
      const { kit, perm } = kitFor(a);
      const f = begin(kit, perm, new DeleteFlow(kit));
      await until(() => at(f) === "signin");
      await f.signin.send(EMAIL);
      await f.signin.verify(w.server.inbox(EMAIL));
      await until(() => at(f) === "password");
      await f.submitPassword("wrong");
      expect(f.state).toMatchObject({ at: "password", failure: { code: "wrong_secret" } });
      // a sign-in older than the server allows for this: a new code, then the password again
      w.advance(11 * 60 * 1000);
      await f.submitPassword(w.password);
      expect(at(f)).toBe("signin");
      expect(f.signin.state).toMatchObject({ at: "email", failure: { code: "session_invalid" } });
      await f.signin.send(EMAIL);
      await f.signin.verify(w.server.inbox(EMAIL));
      await until(() => at(f) === "password");
      // the permission goes last: when it is given back, this device's sync identity is gone already
      const remove = perm.remove.bind(perm);
      let syncOnAtRemove: boolean | null = null;
      perm.remove = async (...args: Parameters<typeof perm.remove>) => {
        syncOnAtRemove = (await a.engine.view()).syncOn;
        return remove(...args);
      };
      await f.submitPassword(w.password);
      expect(f.state).toEqual({ at: "done", localLeft: false });
      expect(syncOnAtRemove).toBe(false);
      expect(() => w.server.account(EMAIL)).toThrow();
      expect((await a.engine.view()).syncOn).toBe(false);
      expect(perm.log.at(-1)).toBe("remove");
      expect((await a.vault()).entries.length).toBeGreaterThan(0);
      expect(["rejected_by_server", "error"]).toContain((await b.engine.round()).status);
    });
  });
});

/** B's kit (the second device), the permission held. */
function kitOf2(d: Device) {
  return kitFor(d);
}
