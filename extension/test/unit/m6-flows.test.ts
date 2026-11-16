// The Sync section's flows (src/options/sync/enable.ts, join.ts, signin.ts) end to end over the in-memory FakeServer: every
// step and transition the screens show, driven the way the views drive them, with a stand-in chrome.permissions that
// grants only inside a click (test/helpers/m6-kit.ts). What is checked, besides the step reached: what reached the
// server, what changed in this profile, and whether the API permission was kept or given back (SYNC-DESIGN §7,
// revisions 21 and 23: kept only for "done" and "unconfirmed", a join's "enrolled" and "unconfirmed").
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { EnableFlow } from "../../src/options/sync/enable";
import { JoinFlow } from "../../src/options/sync/join";
import { asking } from "../../src/options/sync/permission";
import { sixDigits } from "../../src/options/sync/signin";
import { Approver } from "../../src/core/sync/engine/enroll";
import { formatPairingCode } from "../../src/core/crypto/pairing-code";
import { EMAIL, firstDevice, World } from "../helpers/m3-world";
import {
  click,
  emptyProfile,
  gate,
  kitOf,
  permissions,
  protectedProfile,
  until,
  type PermFake,
  type TestKit,
} from "../helpers/m6-kit";

const serverHas = (w: World) => w.server.account(EMAIL).vault !== undefined && w.server.account(EMAIL).vault !== null;
const requests = (d: { net: { log: { op: string }[] } }) => d.net.log.length;

/** The user clicks the flow's start button (permission.ts asking, as the views bind it). */
function begin<F extends { start(g: Promise<boolean>): Promise<void> }>(kit: TestKit, perm: PermFake, f: F): F {
  click(
    perm,
    asking(kit, (g) => void f.start(g)),
  );
  return f;
}

/** Signs a flow's sign-in in with the FakeServer's inbox. */
async function signIn(w: World, f: EnableFlow | JoinFlow, email = EMAIL): Promise<void> {
  await until(() => f.state.at === "signin", "the sign-in step");
  await f.signin.send(email);
  expect(f.signin.state.at).toBe("code");
  await f.signin.verify(w.server.inbox(email));
}

describe("turning sync on (§3.1, O1–O3)", () => {
  it("with the recovery code the user has: password, sign-in, name, code, upload; the permission is kept", async () => {
    const w = new World();
    const perm = permissions(false);
    const { d, code } = await protectedProfile(w, "A", perm);
    const kit = kitOf(d, perm);
    let on = 0;
    const f = begin(kit, perm, new EnableFlow(kit, { onSyncOn: () => on++ }));
    expect(perm.log).toEqual(["request"]); // asked inside the click, before anything else
    await until(() => f.state.at === "password", "the password step");
    expect(requests(d)).toBe(0); // nothing sent before the password
    await f.submitPassword("not the password");
    expect(f.state).toMatchObject({ at: "password", failure: { code: "wrong_secret" } }); // fixable: the flow stays
    await f.submitPassword(w.password);
    await signIn(w, f);
    await until(() => f.state.at === "name", "the name step");
    f.submitName("Work laptop");
    expect(f.state).toMatchObject({ at: "recovery", mode: "choose" });
    f.enterCode();
    await f.submitCode("0000-0000-0000-0000-0000-0000-0000");
    expect(f.state).toMatchObject({ at: "recovery", mode: "enter", failure: { code: "recovery_not_local" } });
    await f.submitCode(code);
    expect(f.state.at).toBe("done");
    expect(on).toBe(1);
    expect(kit.changes()).toBe(1);
    expect(serverHas(w)).toBe(true);
    expect((await d.engine.view()).syncOn).toBe(true);
    expect(perm.log).not.toContain("remove");
    expect(perm.granted).toBe(true);
    expect(f.signin.session).toBeNull(); // the account session is dropped at the end
  });

  it("with a new recovery code: shown before it is written, two groups typed back, the old code stops working only then", async () => {
    const w = new World();
    const perm = permissions(false);
    const { d, code: old } = await protectedProfile(w, "A", perm);
    const kit = kitOf(d, perm);
    const f = begin(kit, perm, new EnableFlow(kit, { random: () => 0 }));
    await until(() => f.state.at === "password");
    await f.submitPassword(w.password);
    await signIn(w, f);
    await until(() => f.state.at === "name");
    f.submitName("Laptop");
    await f.newCode();
    const s = f.state;
    if (s.at !== "recovery" || s.mode !== "show") throw new Error(`unexpected ${JSON.stringify(s)}`);
    const fresh = s.code;
    expect(fresh).not.toBe(old);
    // shown, not written: the old code still opens this profile
    await d.svc.lock();
    await d.svc.unlockWithRecoveryCode(old);
    f.saved();
    const c = f.state;
    if (c.at !== "recovery" || c.mode !== "confirm") throw new Error("no confirm step");
    expect(c.groups).toEqual([0, 1]); // random() = 0: the first two groups
    const parts = fresh.split("-");
    await f.confirmGroups(["XXXX", "YYYY"]);
    expect(f.state).toMatchObject({ at: "recovery", mode: "confirm", wrong: true });
    await d.svc.lock();
    await d.svc.unlockWithRecoveryCode(old); // still nothing written
    await f.confirmGroups([parts[0]!.toLowerCase(), parts[1]!]); // read the way the code is read
    expect(f.state.at).toBe("done");
    await d.svc.lock();
    await expect(d.svc.unlockWithRecoveryCode(old)).rejects.toThrow();
    await d.svc.unlockWithRecoveryCode(fresh);
    expect(perm.granted).toBe(true);
  });

  it("declined: nothing is sent and nothing changes; asking again is a new click", async () => {
    const w = new World();
    const perm = permissions(false);
    perm.answer = false;
    const { d } = await protectedProfile(w, "A", perm);
    const kit = kitOf(d, perm);
    const f = begin(kit, perm, new EnableFlow(kit));
    await until(() => f.state.at === "declined");
    expect(requests(d)).toBe(0);
    perm.answer = true;
    click(
      perm,
      asking(kit, (g) => void f.start(g)),
    );
    await until(() => f.state.at === "password");
    expect(perm.log).toEqual(["request", "request"]);
  });

  it("a request made after the click's first await is refused by Chrome: the flow says declined, nothing is sent", async () => {
    const w = new World();
    const perm = permissions(false);
    const { d } = await protectedProfile(w, "A", perm);
    const kit = kitOf(d, perm);
    const f = new EnableFlow(kit);
    // what a handler that awaited something first would do: the gesture is spent when it asks
    click(perm, () => void Promise.resolve().then(() => f.start(kit.perm.request({ origins: [] }))));
    await until(() => f.state.at === "declined");
    expect(perm.log).toEqual(["request-without-gesture"]);
    expect(perm.granted).toBe(false);
    expect(requests(d)).toBe(0);
  });

  it("a wrong or malformed one-time code stays on the code step; another email goes back", async () => {
    const w = new World();
    const perm = permissions(false);
    const { d } = await protectedProfile(w, "A", perm);
    const kit = kitOf(d, perm);
    const f = begin(kit, perm, new EnableFlow(kit));
    await until(() => f.state.at === "password");
    await f.submitPassword(w.password);
    await f.signin.send("not an email");
    expect(f.signin.state).toMatchObject({ at: "email", failure: { code: "invalid_email" } });
    await f.signin.send(EMAIL);
    await f.signin.verify("12345");
    expect(f.signin.state).toMatchObject({ at: "code", failure: { code: "otp_format" } });
    const right = w.server.inbox(EMAIL);
    await f.signin.verify(right === "000000" ? "111111" : "000000");
    expect(f.signin.state).toMatchObject({ at: "code", failure: { code: "otp_invalid" } });
    await f.signin.resend(); // under a minute: nothing
    expect(f.signin.state.at).toBe("code");
    f.signin.again();
    expect(f.signin.state).toMatchObject({ at: "email", email: EMAIL });
    expect(sixDigits(" 123-456 ")).toBe("123456");
    expect(perm.log).not.toContain("remove"); // the flow is still open
  });

  it("cancelled: the permission is given back and the session dropped", async () => {
    const w = new World();
    const perm = permissions(false);
    const { d } = await protectedProfile(w, "A", perm);
    const kit = kitOf(d, perm);
    const f = begin(kit, perm, new EnableFlow(kit));
    await until(() => f.state.at === "password");
    await f.submitPassword(w.password);
    await signIn(w, f);
    await until(() => f.state.at === "name");
    await f.cancel();
    expect(f.state.at).toBe("closed");
    expect(perm.log.at(-1)).toBe("remove");
    expect(perm.granted).toBe(false);
    expect(f.signin.session).toBeNull();
    expect(serverHas(w)).toBe(false);
  });

  it("the sign-in expires before the upload: sign in again, and the upload goes on with what was given", async () => {
    const w = new World();
    const perm = permissions(false);
    const { d, code } = await protectedProfile(w, "A", perm);
    const kit = kitOf(d, perm);
    const f = begin(kit, perm, new EnableFlow(kit));
    await until(() => f.state.at === "password");
    await f.submitPassword(w.password);
    await signIn(w, f);
    await until(() => f.state.at === "name");
    f.submitName("Laptop");
    f.enterCode();
    // the account session lives 15 minutes; the page stays in use meanwhile (no idle lock)
    for (let i = 0; i < 4; i++) {
      w.advance(4 * 60_000);
      await d.svc.touch();
    }
    await f.submitCode(code);
    expect(f.state.at).toBe("signin");
    expect(f.signin.state).toMatchObject({ at: "email", failure: { code: "session_invalid" } });
    await f.signin.send(EMAIL);
    await f.signin.verify(w.server.inbox(EMAIL));
    await until(() => f.state.at === "done", "the upload after signing in again");
    expect(serverHas(w)).toBe(true);
  });

  it("this email has a vault already: the join takes the sign-in and the permission over (§3.5)", async () => {
    const w = new World();
    await firstDevice(w);
    const perm = permissions(false);
    const { d } = await protectedProfile(w, "B", perm, ["AWS"]);
    const kit = kitOf(d, perm);
    const f = begin(kit, perm, new EnableFlow(kit));
    await until(() => f.state.at === "password");
    await f.submitPassword(w.password);
    await signIn(w, f);
    await until(() => f.state.at === "exists");
    const signin = f.handOver();
    expect(f.state.at).toBe("closed");
    await f.cancel(); // leaving the closed flow gives nothing back
    expect(perm.log).not.toContain("remove");
    const j = new JoinFlow(kit, { signin });
    await until(() => j.state.at === "choose", "the warning card");
    expect(j.state).toMatchObject({ at: "choose", info: { devices: 1 } });
    expect(perm.granted).toBe(true);
  });

  it("another device made the vault after the check (vault_exists, a result): the permission is given back at once", async () => {
    const w = new World();
    const perm = permissions(false);
    const { d, code } = await protectedProfile(w, "B", perm);
    const kit = kitOf(d, perm);
    const f = begin(kit, perm, new EnableFlow(kit));
    await until(() => f.state.at === "password");
    await f.submitPassword(w.password);
    await signIn(w, f);
    await until(() => f.state.at === "name");
    f.submitName("Laptop");
    f.enterCode();
    await firstDevice(w); // another profile turns sync on for the same email first
    await f.submitCode(code);
    expect(f.state).toEqual({ at: "vault_exists", newCode: false });
    expect(perm.log.at(-1)).toBe("remove");
    expect(perm.granted).toBe(false);
    expect((await d.engine.view()).syncOn).toBe(false);
  });

  it("a failure that ends the flow (offline at the upload) gives the permission back; starting again is a new click", async () => {
    const w = new World();
    const perm = permissions(false);
    const { d, code } = await protectedProfile(w, "A", perm);
    const kit = kitOf(d, perm);
    const f = begin(kit, perm, new EnableFlow(kit));
    await until(() => f.state.at === "password");
    await f.submitPassword(w.password);
    await signIn(w, f);
    await until(() => f.state.at === "name");
    f.submitName("Laptop");
    f.enterCode();
    d.net.partition(true);
    await f.submitCode(code);
    expect(f.state).toMatchObject({ at: "failed", failure: { code: "network" } });
    expect(perm.granted).toBe(false);
    d.net.partition(false);
    click(
      perm,
      asking(kit, (g) => void f.start(g)),
    );
    await until(() => f.state.at === "password");
    expect(perm.granted).toBe(true);
  });
});

describe("joining a synced vault (§3.2, §3.3, §3.5, O4–O7)", () => {
  it("with the recovery code, into a new profile: the warning, the code, the summary, the join; the permission is kept", async () => {
    const w = new World();
    const a = await firstDevice(w, ["GitHub", "AWS"]);
    await a.engine.round();
    const perm = permissions(false);
    const d = emptyProfile(w, "B", perm);
    const kit = kitOf(d, perm);
    let on = 0;
    const j = begin(kit, perm, new JoinFlow(kit, { onSyncOn: () => on++ }));
    await signIn(w, j);
    await until(() => j.state.at === "choose");
    expect(j.state).toMatchObject({ at: "choose", info: { devices: 1 }, lost: false });
    j.setName("");
    await j.chooseRecovery();
    expect(j.state).toMatchObject({ at: "choose", problem: "empty" });
    j.setName("Home");
    await j.chooseRecovery();
    expect(j.state.at).toBe("recovery");
    await j.submitRecovery("0000-0000-0000-0000-0000-0000-0000");
    expect(j.state).toMatchObject({ at: "recovery", failure: { code: "invalid_recovery_code" } }); // the checksum: nothing sent for it
    await j.submitRecovery(w.code);
    expect(j.state).toMatchObject({ at: "summary", summary: { mode: "empty" }, via: "recovery" });
    await j.commit();
    expect(j.state).toEqual({ at: "done", via: "recovery" });
    expect(on).toBe(1);
    expect(perm.log).not.toContain("remove");
    expect((await d.engine.round()).status).toBe("ok");
    expect((await d.vault()).entries.map((e) => e.issuer).sort()).toEqual(["AWS", "GitHub"]);
  });

  it("with the recovery code, over a profile of its own: its accounts are added (the summary says how many)", async () => {
    const w = new World();
    await firstDevice(w, ["GitHub"]);
    const perm = permissions(false);
    const { d } = await protectedProfile(w, "B", perm, ["AWS", "GitHub"]);
    const kit = kitOf(d, perm);
    const j = begin(kit, perm, new JoinFlow(kit));
    await signIn(w, j);
    await until(() => j.state.at === "choose");
    j.setName("Second");
    await j.chooseRecovery();
    await j.submitRecovery(w.code);
    expect(j.state).toMatchObject({ at: "summary", summary: { mode: "added", added: 1, skipped: 1 } });
    await j.commit();
    expect(j.state.at).toBe("done");
  });

  it("a recovery code that does not open the vault stays on the step (fixable), the permission held", async () => {
    const w = new World();
    await firstDevice(w);
    const perm = permissions(false);
    const d = emptyProfile(w, "B", perm);
    const kit = kitOf(d, perm);
    const j = begin(kit, perm, new JoinFlow(kit));
    await signIn(w, j);
    await until(() => j.state.at === "choose");
    j.setName("B");
    await j.chooseRecovery();
    const other = await protectedProfile(w, "C", permissions(true));
    await j.submitRecovery(other.code); // a well-formed code of another vault: the server's recovery_mismatch
    expect(j.state).toMatchObject({ at: "recovery", failure: { code: "recovery_mismatch" } });
    expect(perm.granted).toBe(true);
    await j.submitRecovery(w.code);
    expect(j.state.at).toBe("summary");
  });

  it("no vault for this email: the user can turn sync on instead", async () => {
    const w = new World();
    const perm = permissions(false);
    const d = emptyProfile(w, "B", perm);
    const kit = kitOf(d, perm);
    const j = begin(kit, perm, new JoinFlow(kit));
    await signIn(w, j);
    await until(() => j.state.at === "no_vault");
    await j.cancel();
    expect(perm.granted).toBe(false);
  });

  it("a locked page with a vault of its own is told to unlock first, before anything is sent for the join", async () => {
    const w = new World();
    await firstDevice(w);
    const perm = permissions(false);
    const { d } = await protectedProfile(w, "B", perm);
    const kit = kitOf(d, perm);
    const j = begin(kit, perm, new JoinFlow(kit));
    await signIn(w, j);
    await until(() => j.state.at === "choose");
    await d.svc.lock();
    const before = requests(d);
    j.setName("B");
    await j.chooseRecovery();
    expect(j.state).toMatchObject({ at: "choose", failure: { code: "locked" } });
    await j.chooseApproval();
    expect(j.state).toMatchObject({ at: "choose", failure: { code: "locked" } });
    expect(requests(d)).toBe(before);
  });

  it("over unreadable data: neither way in goes on until the user ticked that the synced vault replaces it", async () => {
    const w = new World();
    await firstDevice(w);
    const perm = permissions(false);
    const { d } = await protectedProfile(w, "B", perm);
    // the profile's vault becomes unreadable: both slots damaged, no snapshot, no mirror, no keyring copy (store.ts: lost)
    for (const k of ["sk_slot_a", "sk_slot_b"]) d.disk.kv.data.set(k, { broken: true });
    for (const k of [...d.disk.kv.data.keys()])
      if (k.startsWith("sk_snap") || k === "sk_keyring") d.disk.kv.data.delete(k);
    d.disk.mirror.data.clear();
    d.restartWorker();
    gate(d, perm);
    const kit = kitOf(d, perm);
    expect(await d.flows.vaultStatus()).toBe("lost");
    const j = begin(kit, perm, new JoinFlow(kit));
    await signIn(w, j);
    await until(() => j.state.at === "choose");
    expect(j.state).toMatchObject({ lost: true });
    j.setName("B");
    const before = requests(d);
    await j.chooseRecovery();
    expect(j.state).toMatchObject({ at: "choose", failure: { code: "confirm_lost" } });
    await j.chooseApproval();
    expect(j.state).toMatchObject({ at: "choose", failure: { code: "confirm_lost" } });
    expect(requests(d)).toBe(before); // nothing sent
    await j.chooseRecovery({ confirmLost: true });
    await j.submitRecovery(w.code);
    expect(j.state).toMatchObject({ at: "summary", summary: { mode: "lost" } });
    await j.commit();
    expect(j.state.at).toBe("done");
    expect(await d.flows.vaultStatus()).toBe("ok");
  });

  describe("by approval from another device (§3.2)", () => {
    async function twoProfiles() {
      const w = new World();
      const a = await firstDevice(w);
      await a.engine.round();
      const perm = permissions(false);
      const d = emptyProfile(w, "B", perm);
      const kit = kitOf(d, perm);
      const timers: (() => void)[] = [];
      const j = begin(
        kit,
        perm,
        new JoinFlow(kit, {
          timer: (fn) => {
            timers.push(fn);
            return () => undefined;
          },
        }),
      );
      await signIn(w, j);
      await until(() => j.state.at === "choose");
      j.setName("New laptop");
      await j.chooseApproval();
      expect(j.state.at).toBe("waiting");
      if (j.state.at === "waiting") expect(j.state.expiresAt).toBeGreaterThan(w.clock.now);
      const [req] = await Approver.list(a.engine);
      const approver = await Approver.start(a.engine, req!.request_id, w.password);
      return { w, a, d, perm, kit, j, approver, timers };
    }

    it("the pairing code shown there, typed here; the SAS shown here, typed there; then the summary and the join", async () => {
      const { w, d, perm, j, approver } = await twoProfiles();
      await j.pollOnce();
      expect(j.state).toMatchObject({ at: "code" }); // asked before anything is revealed (MUST 10)
      const before = w.server.requests.length;
      await j.submitCode("ABCD-EFGH");
      expect(j.state).toMatchObject({ at: "code", problem: "malformed" }); // no attempt used, nothing sent
      await j.submitCode(w.code); // the recovery code: its check bits are another domain's
      expect(j.state).toMatchObject({ at: "code", problem: "wrong" });
      expect(w.server.requests.length).toBe(before);
      expect("attemptsLeft" in j.state).toBe(false); // the code step counts no attempts
      await j.submitCode(approver.pairingCode.toLowerCase());
      const s = j.state;
      if (s.at !== "sas") throw new Error(`no SAS: ${JSON.stringify(s)}`);
      expect(s.sas).toMatch(/^\d{6}$/);
      expect(JSON.stringify(j.state).includes(approver.pairingCode)).toBe(false); // the flow keeps no code
      await approver.poll(w.password);
      const r = await approver.submitSas(s.sas, w.password);
      expect(r).toEqual({ kind: "approved" });
      await j.pollOnce();
      expect(j.state).toMatchObject({ at: "summary", via: "approval", summary: { mode: "empty" } });
      await j.commit();
      expect(j.state).toEqual({ at: "done", via: "approval" });
      expect(perm.granted).toBe(true);
      expect((await d.engine.round()).status).toBe("ok");
      expect((await d.vault()).entries.length).toBe(2);
    });

    it("a code past the check bits that is not the approver's: the approver ends it; here the request ended, perhaps mistyped", async () => {
      const { w, perm, j, approver } = await twoProfiles();
      await j.pollOnce();
      await j.submitCode(await formatPairingCode(crypto.getRandomValues(new Uint8Array(16))));
      expect(j.state.at).toBe("sas");
      expect(await approver.poll(w.password)).toEqual({ kind: "failed", reason: "pairing_mismatch" });
      await j.pollOnce();
      expect(j.state).toMatchObject({ at: "failed", failure: { code: "join_ended" } });
      expect(perm.granted).toBe(false);
    });

    it("a payload that does not open under the code's key ends it (bad_payload): rejected, the permission given back", async () => {
      const { w, perm, j, approver } = await twoProfiles();
      await j.pollOnce();
      await j.submitCode(approver.pairingCode);
      const s = j.state;
      if (s.at !== "sas") throw new Error("no SAS");
      await approver.poll(w.password);
      expect(await approver.submitSas(s.sas, w.password)).toEqual({ kind: "approved" });
      const e = Object.values(w.server.db.enrollments)[0]!;
      e.payload = Buffer.from(crypto.getRandomValues(new Uint8Array(400))).toString("base64"); // the server's own
      await j.pollOnce();
      expect(j.state).toMatchObject({ at: "failed", failure: { code: "bad_payload" } });
      expect(perm.granted).toBe(false);
      expect(w.server.state(EMAIL).enrollments).toEqual([]);
    });

    it("a poll that lands while the code is checked waits for it (the engine runs them one after the other)", async () => {
      const { w, j, approver } = await twoProfiles();
      await j.pollOnce();
      const submit = j.submitCode(approver.pairingCode);
      const poll = j.pollOnce();
      await Promise.all([submit, poll]);
      expect(j.state.at).toBe("sas");
      expect((await approver.poll(w.password)).kind).toBe("enter_sas");
    });

    it("cancelled while waiting: the request is rejected (MUST 6) and the permission given back", async () => {
      const { a, perm, j } = await twoProfiles();
      await j.cancel();
      expect(j.state.at).toBe("closed");
      expect(perm.granted).toBe(false);
      expect((await Approver.list(a.engine)).filter((x) => x.state === "pending" || x.state === "responded")).toEqual(
        [],
      );
    });

    it("polls only while the request is open, every 2 s (the page's timer), and never re-opens one by itself (MUST 3)", async () => {
      const { j, timers } = await twoProfiles();
      expect(timers.length).toBe(1);
      timers.shift()!();
      await until(() => j.state.at === "code" && timers.length === 1, "the next poll scheduled");
      await j.cancel();
      const n = timers.length;
      timers.shift()?.(); // a timer that fires after the cancel does nothing
      await new Promise((r) => setTimeout(r, 5));
      expect(timers.length).toBe(Math.max(0, n - 1));
      expect(j.state.at).toBe("closed");
    });
  });
});
