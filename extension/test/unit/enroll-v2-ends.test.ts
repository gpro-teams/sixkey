// Enrolment v2 on the approving device (SYNC-DESIGN §3.2 M2–M4, MUST 6, MUST 10; §7): every end of the approval flow
// ends the machine that holds the pairing secret S, even one the flow never stored (a lock while respond is on the
// wire); the pairing code lives at most as long as the request can, on this device's own clock, whatever the polls
// say; a lost answer to respond is asked again, so the new device is not left waiting for a code nobody shows; every
// failure the approver finds in a poll rejects the request at once; and a copied code leaves the clipboard when its
// step ends. Over the in-memory FakeServer, driven the way the Sync section drives the flows (test/helpers/m6-kit.ts).
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { fromB64, toB64 } from "../../src/core/crypto/bytes";
import { SYNC_CONSTANTS } from "../../src/core/sync/crypto/constants";
import { ApproverEnrollment } from "../../src/core/sync/crypto/enroll-approver";
import { Approver } from "../../src/core/sync/engine/enroll";
import { ApproveFlow, CODE_LIFETIME_MS } from "../../src/options/sync/approve";
import { JoinFlow } from "../../src/options/sync/join";
import { asking } from "../../src/options/sync/permission";
import { EMAIL, worldOf, type Device, type World } from "../helpers/m3-world";
import { click, emptyProfile, kitOf, permissions, until, type PermFake, type TestKit } from "../helpers/m6-kit";

function begin<F extends { start(g: Promise<boolean>): Promise<void> }>(kit: TestKit, perm: PermFake, f: F): F {
  click(
    perm,
    asking(kit, (g) => void f.start(g)),
  );
  return f;
}
const at = (f: { state: { at: string } }) => f.state.at;
const RESPOND = "POST /v1/enroll/requests/{rid}/respond";
const REJECT = "POST /v1/enroll/requests/{rid}/reject";
const sent = (w: World, op: string) => w.server.requests.filter((r) => r.op === op).length;

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
  return j;
}

/** A timer that only records what was armed; the test fires what it wants. */
function manualTimer() {
  const armed: { fn: () => void; ms: number; stopped: boolean }[] = [];
  const timer = (fn: () => void, ms: number) => {
    const t = { fn, ms, stopped: false };
    armed.push(t);
    return () => {
      t.stopped = true;
    };
  };
  return { armed, timer };
}

/** The approving device at its request list, the new device waiting. */
async function approverAtList(o: { timer?: (fn: () => void, ms: number) => () => void } = {}) {
  const w = await worldOf(1);
  const [a] = w.devices as [Device];
  const perm = permissions(true);
  const kit = kitOf(a, perm);
  const j = await newDeviceWaiting(w);
  const f = begin(kit, perm, new ApproveFlow(kit, { timer: o.timer ?? (() => () => undefined) }));
  await until(() => at(f) === "password");
  await f.submitPassword(w.password);
  const s = f.state;
  if (s.at !== "list") throw new Error(`unexpected ${s.at}`);
  return { w, a, kit, j, f, rid: s.requests[0]!.rid };
}

/** Every ApproverEnrollment made from here on, so a test can look at a machine the flow never stored. */
function captureMachines(): { machines: ApproverEnrollment[]; restore: () => void } {
  const machines: ApproverEnrollment[] = [];
  const orig = ApproverEnrollment.start.bind(ApproverEnrollment);
  const spy = vi.spyOn(ApproverEnrollment, "start").mockImplementation(async (input, opts) => {
    const r = await orig(input, opts);
    machines.push(r.machine);
    return r;
  });
  return { machines, restore: () => spy.mockRestore() };
}

/** Whether a machine can still show a pairing code (the getter throws once there is none). */
const codeOf = (m: ApproverEnrollment): string | null => {
  try {
    return m.pairingCode;
  } catch {
    return null;
  }
};

describe("every end of the approval ends the machine that holds S (MUST 6, MUST 10)", () => {
  it("a lock while respond is on the wire: the machine ends and S goes, although the flow never stored the Approver", async () => {
    const { a, f, rid } = await approverAtList();
    // respond is on the wire when the user locks Sixkey (the popup's Lock, or the idle lock)
    const api = a.engine.api as unknown as { respond: (...x: unknown[]) => Promise<void> };
    const respond = api.respond.bind(api);
    api.respond = async (...x: unknown[]) => {
      await a.lockNow();
      await f.locked();
      return respond(...x);
    };
    const cap = captureMachines();
    try {
      await f.choose(rid);
      expect(f.state).toEqual({ at: "failed", failure: { code: "locked_out" } });
      expect(cap.machines).toHaveLength(1);
      const m = cap.machines[0]!;
      expect({ phase: m.phase, code: codeOf(m) }).toEqual({ phase: "failed", code: null });
    } finally {
      cap.restore();
    }
  });

  it("the engine's reject ends the machine before anything else, so a reject refused by a lock still wipes S", async () => {
    const { w, a, rid } = await approverAtList();
    const cap = captureMachines();
    let ap: Approver;
    try {
      ap = await Approver.start(a.engine, rid, w.password);
    } finally {
      cap.restore();
    }
    const m = cap.machines[0]!;
    expect(codeOf(m)).not.toBeNull();
    await a.lockNow(); // the reject's own check (the vault's keys) now fails
    await expect(ap.reject(w.password)).rejects.toThrow();
    expect({ phase: m.phase, code: codeOf(m) }).toEqual({ phase: "failed", code: null });
    expect(sent(w, REJECT)).toBe(0);
  });
});

describe("the pairing code's lifetime on the approving device (MUST 10: at most until the request expires)", () => {
  it("is the request's life and a minute of rounding", () => {
    expect(CODE_LIFETIME_MS).toBe((SYNC_CONSTANTS.ENROLL_TTL_S + 60) * 1000);
  });

  it("past it, the code leaves the screen and the machine ends, whatever the polls say (offline, stalled)", async () => {
    const t = manualTimer();
    const { a, f, rid } = await approverAtList({ timer: t.timer });
    const cap = captureMachines();
    try {
      await f.choose(rid);
    } finally {
      cap.restore();
    }
    if (at(f) !== "code") throw new Error(`unexpected ${at(f)}`);
    a.net.partition(true); // every poll from now on fails: the page would keep polling and showing the code
    const deadline = t.armed.filter((x) => x.ms === CODE_LIFETIME_MS);
    expect(deadline).toHaveLength(1);
    await f.pollOnce(); // a poll that cannot reach the server changes nothing
    expect(at(f)).toBe("code");
    deadline[0]!.fn();
    expect(f.state).toEqual({ at: "failed", failure: { code: "expired" } });
    const m = cap.machines[0]!;
    expect({ phase: m.phase, code: codeOf(m) }).toEqual({ phase: "failed", code: null });
    a.net.partition(false);
  });

  it("after the reveal the deadline is gone: the six digits are not cut short by it", async () => {
    const t = manualTimer();
    const { f, j, rid } = await approverAtList({ timer: t.timer });
    await f.choose(rid);
    const sc = f.state;
    if (sc.at !== "code") throw new Error(`unexpected ${sc.at}`);
    await j.pollOnce();
    await j.submitCode(sc.code);
    await f.pollOnce();
    expect(at(f)).toBe("sas");
    const deadline = t.armed.find((x) => x.ms === CODE_LIFETIME_MS)!;
    expect(deadline.stopped).toBe(true);
    deadline.fn(); // even if it fired anyway
    expect(at(f)).toBe("sas");
  });
});

describe("respond's answer lost on the way (§3.2 M2; the server's respond is idempotent for the same approver and epk)", () => {
  it("asked again: the code is shown, and the new device can take it", async () => {
    const { w, a, f, j, rid } = await approverAtList();
    a.net.inject({ match: RESPOND, kind: "lose_response" });
    await f.choose(rid);
    const sc = f.state;
    if (sc.at !== "code") throw new Error(`unexpected ${sc.at}`);
    expect(sent(w, RESPOND)).toBe(2); // the first one committed, its answer lost; the same body again: 200
    await j.pollOnce();
    await j.submitCode(sc.code);
    expect(at(j)).toBe("sas");
  });

  it("lost three times: the flow ends, the machine and S with it, the code never shown", async () => {
    const { w, a, f, rid } = await approverAtList();
    a.net.inject({ match: RESPOND, kind: "lose_response", count: 3 });
    const cap = captureMachines();
    try {
      await f.choose(rid);
    } finally {
      cap.restore();
    }
    expect(f.state).toMatchObject({ at: "failed", failure: { code: "network" } });
    expect(sent(w, RESPOND)).toBe(3);
    const m = cap.machines[0]!;
    expect({ phase: m.phase, code: codeOf(m) }).toEqual({ phase: "failed", code: null });
  });
});

describe("a failure the approver finds in a poll rejects the request at once (§3.2 M4 '拒绝并告警')", () => {
  it("a reveal that does not open the commitment (the nonce changed on the way): rejected; the new device stops waiting", async () => {
    const { w, a, f, j, rid } = await approverAtList();
    await f.choose(rid);
    const sc = f.state;
    if (sc.at !== "code") throw new Error(`unexpected ${sc.at}`);
    // a hostile server changes the nonce the approver sees
    const send = a.net.send.bind(a.net);
    a.net.send = async (req) => {
      const res = await send(req);
      if (req.method !== "GET" || !req.target.startsWith(`/v1/enroll/requests/${rid}`)) return res;
      const body = JSON.parse(res.body) as { new_nonce?: string };
      if (body.new_nonce) {
        const n = fromB64(body.new_nonce);
        n[0] = n[0]! ^ 1;
        body.new_nonce = toB64(n);
      }
      return { ...res, body: JSON.stringify(body) };
    };
    await j.pollOnce();
    await j.submitCode(sc.code);
    expect(sent(w, REJECT)).toBe(0);
    await f.pollOnce();
    expect(f.state).toMatchObject({ at: "failed", failure: { code: "commit_mismatch" } });
    expect(sent(w, REJECT)).toBe(1);
    await j.pollOnce();
    expect(at(j)).toBe("failed");
  });
});

describe("the copied pairing code leaves the clipboard when its step ends (§7; when clearing the clipboard is allowed)", () => {
  it("copied, then the reveal: cleared at once", async () => {
    const { kit, f, j, rid } = await approverAtList();
    await f.choose(rid);
    const sc = f.state;
    if (sc.at !== "code") throw new Error(`unexpected ${sc.at}`);
    expect(await f.copyCode()).toBe(true);
    expect(kit.uncopied).toEqual([]);
    await f.pollOnce();
    expect(kit.uncopied).toEqual([]); // still on screen: still needed
    await j.pollOnce();
    await j.submitCode(sc.code);
    await f.pollOnce();
    expect(at(f)).toBe("sas");
    expect(kit.uncopied).toEqual([sc.code]);
  });

  it("copied, then Cancel: cleared; never copied: nothing asked", async () => {
    const one = await approverAtList();
    await one.f.choose(one.rid);
    const sc = one.f.state;
    if (sc.at !== "code") throw new Error(`unexpected ${sc.at}`);
    await one.f.copyCode();
    await one.f.cancel();
    expect(one.kit.uncopied).toEqual([sc.code]);
    const two = await approverAtList();
    await two.f.choose(two.rid);
    await two.f.cancel();
    expect(two.kit.uncopied).toEqual([]);
  });
});
