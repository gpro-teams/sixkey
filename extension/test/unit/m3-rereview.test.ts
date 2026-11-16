// M3 revision 3: the re-review's findings (docs/audit/internal-reviews/M3-REREVIEW.md) that its probes (m3rr-probes.test.ts) do not already pin,
// and a killer for each of its surviving mutants (MY-01, MY-04, MY-07, MY-08a, MY-10, MY-11, MY-17, MY-18, MY-19,
// MY-23, MY-25; M3RR-11).
import { describe, expect, it } from "vitest";
import type { Vk } from "../../src/core/crypto/vk";
import { KEYS } from "../../src/core/storage/format";
import { Approver, ApprovalJoin, commitJoin, joinWithRecoveryCode } from "../../src/core/sync/engine/enroll";
import {
  changePassword,
  commitRotation,
  prepareRotation,
  revokeDevice,
  turnSyncOff,
} from "../../src/core/sync/engine/keys";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { aliveEntries } from "../../src/core/vault/model";
import { tear } from "../helpers/faulty-kv";
import { watchServer } from "../helpers/m3-check";
import { contextOver, EMAIL, firstDevice, quiesce, World, worldOf, type Device } from "../helpers/m3-world";

const DAY = 86_400_000;
const names = async (d: Device, vk?: Vk) =>
  aliveEntries(await d.vault(vk))
    .map((e) => e.issuer)
    .sort();
const headNames = async (w: World, vk: Vk) =>
  aliveEntries((await w.serverVault(vk))!)
    .map((e) => e.issuer)
    .sort();
const sent = (w: World, op: string) => w.server.requests.filter((r) => r.op === op).length;
const stateOf = (d: Device) => d.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>;
const idOf = async (d: Device) => (await d.local.identity.get()) as { deviceId: string; state: string } | null;

function tearActive(d: Device): void {
  const kv = d.disk.kv;
  const ptr = kv.data.get(KEYS.active) as "a" | "b";
  kv.data.set(KEYS.slot[ptr], tear(kv.data.get(KEYS.slot[ptr])));
}
const secondContext = (d: Device) =>
  contextOver({
    ...d.disk,
    lock: d.lock,
    identityLock: d.identityLock,
    syncLock: d.syncLock,
    transport: d.net,
    clock: d.now,
  });

describe("M3RR-1: the rotation's pending record and its reconciliation", () => {
  it("the pending fingerprint is written before the first rotate is sent", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const a = w.devices[0]!;
    const h = await prepareRotation(a.engine, w.password);
    const seen: unknown[] = [];
    w.server.fault({
      match: "POST /v1/keys/rotate",
      kind: "hook",
      count: 1,
      fn: async () => {
        seen.push(stateOf(a).pendingRecoveryWrap ?? null);
      },
    });
    await commitRotation(a.engine, h);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kver: 2 });
    expect(stateOf(a).pendingRecoveryWrap ?? null).toBeNull(); // in effect: cleared
  }, 60_000);

  it("a lost rotate, then another device's key change wins: the retry says changed_elsewhere (never not_synced), the late one is refused", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a, b] = w.devices as [Device, Device];
    const vk1 = await a.vk();
    const h = await prepareRotation(a.engine, w.password);
    a.net.inject({ match: "POST /v1/keys/rotate", kind: "late" });
    a.net.inject({ match: "GET /v1/keys", kind: "fail_before" }); // the reconciliation after the lost answer cannot ask
    await expect(commitRotation(a.engine, h)).rejects.toMatchObject({ code: "unconfirmed" });
    await commitRotation(b.engine, await prepareRotation(b.engine, w.password)); // B's rotation lands first
    const vkB = w.server.account(EMAIL).vault!.vk_id;
    await expect(commitRotation(a.engine, h)).rejects.toMatchObject({ code: "changed_elsewhere" });
    expect(stateOf(a).pendingRecoveryWrap ?? null).toBeNull();
    await a.net.flushLate(); // A's old rotate arrives: its if_kver is stale
    expect(w.server.account(EMAIL).vault!.vk_id).toBe(vkB);
    expect((await a.vk()).id).toBe(vk1.id);
    expect((await a.engine.round()).status).toBe("needs_password"); // R3 from here, as for any rotation elsewhere
  }, 60_000);
});

describe("M3RR-1: after an unknown send, never a known outcome too early", () => {
  it("a rotate queued in the network (outcome unknown), retried while offline: unconfirmed again (it may still land), the pending record kept", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const a = w.devices[0]!;
    const h = await prepareRotation(a.engine, w.password);
    a.net.inject({ match: "POST /v1/keys/rotate", kind: "late", count: 3 });
    a.net.inject({ match: "GET /v1/keys", kind: "fail_before" });
    await expect(commitRotation(a.engine, h)).rejects.toMatchObject({ code: "unconfirmed" });
    a.net.partition(true);
    await expect(commitRotation(a.engine, h)).rejects.toMatchObject({ code: "unconfirmed" }); // not "offline": one may land
    expect(stateOf(a).pendingRecoveryWrap ?? null).not.toBeNull();
    a.net.partition(false);
    await a.net.flushLate(); // it lands now
    await commitRotation(a.engine, h); // the retry finds it in effect
    expect(w.server.account(EMAIL).vault!.vk_id).toBe((await a.vk()).id);
  }, 60_000);
});

describe("M3RR-4: key operations hold sixkey-sync like a round", () => {
  it("a round in another context while a password change is being sent: busy, nothing interleaved", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const a = w.devices[0]!;
    const worker = secondContext(a);
    const during: string[] = [];
    w.server.fault({
      match: "PUT /v1/keys",
      kind: "hook",
      count: 1,
      fn: async () => {
        during.push((await worker.engine.round()).status);
      },
    });
    await changePassword(a.engine, w.password, `${w.password}-2`);
    expect(during).toEqual(["busy"]);
  }, 60_000);

  it("a round in another context while the rotate is in flight: busy", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const a = w.devices[0]!;
    const worker = secondContext(a);
    const during: string[] = [];
    const h = await prepareRotation(a.engine, w.password);
    w.server.fault({
      match: "POST /v1/keys/rotate",
      kind: "hook",
      count: 1,
      fn: async () => {
        during.push((await worker.engine.round()).status);
      },
    });
    await commitRotation(a.engine, h);
    expect(during).toEqual(["busy"]);
  }, 60_000);
});

describe("the re-review's surviving mutants (M3RR-11)", () => {
  it("MY-01: a tear before a locked push(): the orphan is what is pushed, and the push's 200 retires it", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("pushed from the orphan");
    await a.lockNow();
    tearActive(a);
    a.restartWorker();
    const r = await a.engine.push();
    expect(r).toMatchObject({ status: "locked", pushedOutbox: true });
    expect(a.disk.kv.data.get(SYNC_KEYS.orphan) ?? null).toBeNull();
    expect(await headNames(w, vk)).toContain("pushed from the orphan");
  }, 60_000);

  it("MY-04: a tear between prepareRotation and commitRotation: the rotation merges first, so the rotated head has the save; every write absorbed its head", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const v1 = await a.vk();
    const keys = new Map<string, Vk>([[v1.id, v1]]);
    const watch = watchServer(w, () => v1, { keyOf: (id) => keys.get(id) });
    const h = await prepareRotation(a.engine, w.password);
    w.advance(1000);
    await a.add("saved before the rotation");
    tearActive(a); // the save now only in the outbox (the recovery keeps it as the orphan)
    await commitRotation(a.engine, h);
    const v2 = await a.vk();
    keys.set(v2.id, v2);
    expect(await headNames(w, v2)).toContain("saved before the rotation");
    await watch.settle();
    expect(watch.problems).toEqual([]);
  }, 60_000);

  it("MY-07: the kill switch raised between prepareRotation and commitRotation: update_required, no rotate sent", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const a = w.devices[0]!;
    const h = await prepareRotation(a.engine, w.password);
    w.server.minClientVersion = "99.0";
    await expect(commitRotation(a.engine, h)).rejects.toMatchObject({ code: "update_required" });
    expect(sent(w, "POST /v1/keys/rotate")).toBe(0);
  }, 60_000);

  it("MY-08a (the test helper): watchServer opens the rotate's envelope; a rotate that did not absorb the head is flagged", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a, b] = w.devices as [Device, Device];
    const v1 = await a.vk();
    const keys = new Map<string, Vk>([[v1.id, v1]]);
    const watch = watchServer(w, () => v1, { keyOf: (id) => keys.get(id) });
    w.advance(1000);
    await b.add("only on B and the server");
    await b.engine.round();
    // A forged lastSynced: the server's head as if A had merged it (it has not)
    const head = w.server.account(EMAIL).vault!;
    const st = stateOf(a);
    a.disk.kv.data.set(SYNC_KEYS.state, {
      ...st,
      lastSynced: { version: head.version, head: head.head, checksum: (await a.generation()).envelope.checksum },
    });
    await commitRotation(a.engine, await prepareRotation(a.engine, w.password));
    const v2 = await a.vk();
    keys.set(v2.id, v2);
    await watch.settle();
    expect(watch.problems.length).toBeGreaterThan(0);
  }, 60_000);

  async function landedJoinAnswerLost(w: World): Promise<Device> {
    const n = w.device("N");
    const plan = await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
    });
    n.net.inject({ match: "POST /v1/enroll/requests/{rid}/complete", kind: "lose_response" });
    n.net.inject({ match: "POST /v1/enroll/requests/{rid}/complete", kind: "fail_before", count: 2 });
    expect(await commitJoin(plan)).toBe("unconfirmed");
    return n;
  }

  it("MY-10: a 5xx on M3R-9's status (a landed join, past the window) undoes nothing: the identity the server knows is kept", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const n = await landedJoinAnswerLost(w);
    const id0 = (await idOf(n))!.deviceId;
    w.advance(11 * 60_000);
    await n.unlock();
    w.server.fault({ match: "GET /v1/sync/status", kind: "status", status: 503, code: "unavailable", count: 1 });
    await expect(
      joinWithRecoveryCode(n.engine, {
        session: await w.server.session(EMAIL),
        recoveryCode: w.code,
        deviceName: "N",
        email: EMAIL,
      }),
    ).rejects.toMatchObject({ code: "status_failed" });
    expect((await idOf(n))?.deviceId).toBe(id0);
    expect((await n.engine.round()).status).toBe("ok");
    expect((await n.local.status()).kind).toBe("on");
  }, 60_000);

  it("MY-11: a landed join (the status answers 200): a new join is refused as already_on and the identity kept", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const n = await landedJoinAnswerLost(w);
    const id0 = (await idOf(n))!.deviceId;
    w.advance(11 * 60_000);
    await n.unlock();
    await expect(
      joinWithRecoveryCode(n.engine, {
        session: await w.server.session(EMAIL),
        recoveryCode: w.code,
        deviceName: "N",
        email: EMAIL,
      }),
    ).rejects.toMatchObject({ code: "already_on" });
    expect((await idOf(n))?.deviceId).toBe(id0);
    expect(w.server.state(EMAIL).devices.some((d) => d.device_id === id0)).toBe(true);
  }, 60_000);

  it("MY-17: a 410 after an unknown complete, the status saying the device is unknown: unconfirmed, never enrolled", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const n = w.device("N");
    const plan = await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
    });
    n.net.inject({ match: "POST /v1/enroll/requests/{rid}/complete", kind: "late" }); // never delivered in this test
    w.server.fault({
      match: "POST /v1/enroll/requests/{rid}/complete",
      kind: "status",
      status: 410,
      code: "enroll_gone",
      count: 1,
    });
    expect(await commitJoin(plan)).toBe("unconfirmed");
    expect((await idOf(n))?.state).toBe("pending");
  }, 60_000);

  it("MY-18: turning sync off with a wrong password is refused, and nothing local is undone", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const a = w.devices[0]!;
    await expect(turnSyncOff(a.engine, "not the password")).rejects.toBeTruthy();
    expect((await a.local.status()).kind).toBe("on");
    expect(a.disk.kv.data.has(SYNC_KEYS.cfg)).toBe(true);
  }, 60_000);

  it("MY-19: the kill switch raised between the approver's start and its SAS step: no approval is sent", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    const n = w.device("N");
    const join = await ApprovalJoin.start(n.engine, {
      session: await w.server.session(EMAIL),
      deviceName: "N",
      email: EMAIL,
    });
    const approver = await Approver.start(a.engine, join.requestId, w.password);
    await join.poll();
    const sas = (await join.submitPairingCode(approver.pairingCode)) as { sas: string };
    await approver.poll(w.password);
    w.server.minClientVersion = "99.0";
    const r = await approver.submitSas(sas.sas, w.password).then(
      (x) => x.kind,
      (e: { code?: string }) => e.code,
    );
    expect(r).not.toBe("approved");
    expect(w.server.requests.filter((q) => q.op.endsWith("/approve")).length).toBe(0);
  }, 60_000);

  it("MY-23: the first upload stores the server offset (M3R-5): local edits from then on stamp with the corrected clock", async () => {
    const w = new World();
    const a = await firstDevice(w, ["GitHub"], { skewMs: 2 * DAY });
    const off = (stateOf(a).serverOffsetMs as number | undefined) ?? 0;
    expect(Math.abs(off + 2 * DAY)).toBeLessThan(60_000);
  }, 60_000);

  it("MY-25: an error code with markup in it (short) is not taken as it came: malformed_response", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    w.server.fault({ match: "GET /v1/sync/status", kind: "status", status: 400, code: "<b>x</b>", count: 1 });
    const r = await a.engine.round({ explicit: true });
    expect(r.error).toBe("malformed_response");
    expect(JSON.stringify(stateOf(a))).not.toContain("<b>");
  }, 60_000);
});

describe("the join's merge on the server-corrected clock (found by the model's rejoin kinds, revision 3)", () => {
  it("a device two days slow joins: the cloud's stamps are not clamped by its uncorrected clock, and it uploads nothing", async () => {
    const w = await worldOf(1, ["GitHub", "AWS"]);
    const vk = await w.devices[0]!.vk();
    const stamps = async () =>
      Object.fromEntries((await w.serverVault(vk))!.entries.map((e) => [e.id, [e.hlc, e.phlc]]));
    const before = await stamps();
    const n = w.device("N", undefined, { skewMs: -2 * DAY });
    const plan = await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
    });
    expect(await commitJoin(plan)).toBe("enrolled");
    const nid = (await idOf(n))!.deviceId;
    await n.engine.round();
    await quiesce(w);
    expect(await stamps()).toEqual(before);
    expect(w.server.requests.filter((r) => r.op === "PUT /v1/vault" && r.deviceId === nid).length).toBe(0);
  }, 60_000);

  it("a device two days slow turns sync off (its stored offset goes) and joins again: its own unsent entry keeps its stamps", async () => {
    const w = await worldOf(2, ["GitHub"], [0, -2 * DAY]);
    const b = w.devices[1]!;
    const vk = await b.vk();
    w.advance(1000);
    await b.add("stamped on the corrected clock"); // not sent: no round
    const stampOf = async (v: Promise<import("../../src/core/vault/model").Vault>) => {
      const e = (await v).entries.find((x) => x.issuer === "stamped on the corrected clock")!;
      return [e.hlc, e.phlc];
    };
    const before = await stampOf(b.vault(vk));
    await turnSyncOff(b.engine, w.password);
    const plan = await joinWithRecoveryCode(b.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "B",
      email: EMAIL,
    });
    expect(await commitJoin(plan)).toBe("enrolled");
    expect(await stampOf(b.vault(vk))).toEqual(before);
    await quiesce(w);
    expect(await stampOf(w.serverVault(vk) as Promise<import("../../src/core/vault/model").Vault>)).toEqual(before);
  }, 60_000);
});

describe("M3RR-9: a fresh worker signs with the stored offset", () => {
  it("a device two days fast: its restarted worker's locked push is signed on the corrected clock at once (no clock_skew round trip)", async () => {
    const w = await worldOf(2, ["GitHub"], [0, 2 * DAY]);
    const b = w.devices[1]!;
    await b.engine.round();
    w.advance(1000);
    await b.add("pushed by a fresh worker");
    await b.lockNow();
    b.restartWorker();
    const bid = (await idOf(b))!.deviceId;
    const n0 = w.server.requests.length;
    expect((await b.engine.push()).pushedOutbox).toBe(true);
    expect(w.server.requests.slice(n0).filter((r) => r.deviceId === bid && r.status === 401)).toEqual([]);
  }, 60_000);
});

describe("M3RR-2: every 503 counts", () => {
  it("a 503 with Retry-After counts inside a running backoff too, explicit or not (only an explicit press answered 429 does not)", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    w.server.fault({
      match: "GET /v1/sync/status",
      kind: "status",
      status: 503,
      code: "unavailable",
      retryAfter: 5,
      count: 3,
    });
    const failures = async () => (await a.engine.view()).state.failures ?? 0;
    await a.engine.round();
    expect(await failures()).toBe(1);
    await a.engine.round({ explicit: true }); // pressed while the backoff runs
    expect(await failures()).toBe(2);
    await a.engine.round(); // a page's round while the backoff runs
    expect(await failures()).toBe(3);
    w.server.fault({
      match: "GET /v1/sync/status",
      kind: "status",
      status: 429,
      code: "rate_limited",
      retryAfter: 3600,
      count: 1,
    });
    await a.engine.round({ explicit: true });
    expect(await failures()).toBe(3); // M3R-15: the press inside the backoff, answered 429, is not counted again
    expect((await a.engine.view()).state.backoffUntil ?? 0).toBeGreaterThanOrEqual(w.clock.now + 3600_000); // but waited as asked
  }, 60_000);
});

describe("the approval join on the server-corrected clock (the third review's RV-19)", () => {
  it("a device two days slow turns sync off and joins again by approval: its own unsent entry keeps its stamps", async () => {
    const w = await worldOf(2, ["GitHub"], [0, -2 * DAY]);
    const [a, b] = w.devices as [Device, Device];
    const vk = await b.vk();
    w.advance(1000);
    await b.add("stamped on the corrected clock (approval)"); // not sent: no round
    const stampOf = async (v: Promise<import("../../src/core/vault/model").Vault>) => {
      const e = (await v).entries.find((x) => x.issuer === "stamped on the corrected clock (approval)")!;
      return [e.hlc, e.phlc];
    };
    const before = await stampOf(b.vault(vk));
    await turnSyncOff(b.engine, w.password); // its stored offset goes with the sync records
    const join = await ApprovalJoin.start(b.engine, {
      session: await w.server.session(EMAIL),
      deviceName: "B again",
      email: EMAIL,
    });
    const approver = await Approver.start(a.engine, join.requestId, w.password);
    await join.poll();
    const sas = (await join.submitPairingCode(approver.pairingCode)) as { sas: string };
    await approver.poll(w.password);
    const ok = await approver.submitSas(sas.sas, w.password);
    expect(ok.kind).toBe("approved");
    expect(await join.poll()).toEqual({ kind: "approved" });
    expect(await commitJoin(await join.prepare())).toBe("enrolled");
    expect(await stampOf(b.vault(vk))).toEqual(before);
    await quiesce(w);
    expect(await stampOf(w.serverVault(vk) as Promise<import("../../src/core/vault/model").Vault>)).toEqual(before);
  }, 60_000);
});

describe("M3RR-12: the rejected identity's daily question", () => {
  it("offline at the daily retry: the day is not spent, the next wake asks the server", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a, b] = w.devices as [Device, Device];
    const aid = (await idOf(a))!.deviceId;
    await revokeDevice(b.engine, aid, w.password);
    expect((await a.engine.round()).status).toBe("rejected_by_server");
    const asked = () => w.server.requests.filter((r) => r.op === "GET /v1/sync/status" && r.deviceId === aid).length;
    w.advance(25 * 3_600_000);
    a.net.partition(true);
    expect((await a.engine.round()).status).toBe("offline");
    a.net.partition(false);
    w.advance(10 * 60_000);
    const before = asked();
    expect((await a.engine.round()).status).toBe("rejected_by_server");
    expect(asked() - before).toBe(1); // asked again (not "already asked today")
    w.advance(10 * 60_000);
    await a.engine.round();
    expect(asked() - before).toBe(1); // answered today: the next question tomorrow
  }, 60_000);
});

describe('M3RR-3 with "lock every time" (P10): the worker never holds the key', () => {
  it("locked throughout: the outbox and the orphan are pushed by the worker alone; the save is everywhere before any unlock", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("first, then locked");
    await a.lockNow();
    expect((await a.engine.push()).status).toBe("locked"); // the live outbox, pushed
    await a.unlock();
    w.advance(1000);
    await a.add("second, torn");
    await a.lockNow();
    tearActive(a);
    a.restartWorker();
    expect((await a.engine.round()).pushedOutbox).toBe(true); // the orphan, pushed (the server still at its base)
    await b.engine.round();
    expect(await names(b, vk)).toEqual(expect.arrayContaining(["first, then locked", "second, torn"]));
    await a.unlock();
    await quiesce(w);
    expect(await names(a, vk)).toEqual(expect.arrayContaining(["first, then locked", "second, torn"]));
  }, 60_000);
});
