// The M3 review's probes (docs/audit/internal-reviews/M3-REVIEW.md), kept as regression tests: each failed on the patch the review read and
// passes now. M3R-1: a storage recovery inside the round's own vault load; M3R-2: the rotation's base; M3R-3: the kill
// switch on the flows; the lows M3R-4 to M3R-9, M3R-12 to M3R-15; and the survivors of the review's mutants (M3R-11).
import { describe, expect, it } from "vitest";
import { utf8 } from "../../src/core/crypto/bytes";
import { decryptVault, encryptVault } from "../../src/core/crypto/envelope";
import { setPassword } from "../../src/core/crypto/keyring";
import type { Vk } from "../../src/core/crypto/vk";
import { KEYS } from "../../src/core/storage/format";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { lastSyncedOf } from "../../src/core/sync/local/state";
import { uploadEnvelope } from "../../src/core/sync/local/outbox";
import type { SyncEngine } from "../../src/core/sync/engine/engine";
import { headOf } from "../../src/core/sync/engine/state";
import { MemoryKV, type KV } from "../../src/core/storage/kv";
import { formatHlc, parseHlc } from "../../src/core/vault/hlc";
import { editEntry } from "../../src/core/vault/ops";
import { aliveEntries } from "../../src/core/vault/model";
import { deserializeVault } from "../../src/core/vault/validate";
import { ServiceError } from "../../src/core/service/service-error";
import {
  ApprovalJoin,
  Approver,
  commitJoin,
  firstUpload,
  joinWithRecoveryCode,
} from "../../src/core/sync/engine/enroll";
import {
  adoptWithSecret,
  changePassword,
  commitRecoveryCode,
  commitRotation,
  prepareRecoveryCode,
  prepareRotation,
  rejectAllRequests,
  revokeDevice,
  turnSyncOff,
} from "../../src/core/sync/engine/keys";
import { watchServer } from "../helpers/m3-check";
import { tear } from "../helpers/faulty-kv";
import { createProtected } from "../helpers/vaults";
import { contextOver, EMAIL, joinDevice, quiesce, tryMutex, World, worldOf, type Device } from "../helpers/m3-world";

/** An IndexedDB that refuses writes (the identity's pins cannot be written: they stay pending in storage.local). */
class NoWrite implements KV {
  constructor(readonly inner: MemoryKV) {}
  get(k: string[]) {
    return this.inner.get(k);
  }
  keys() {
    return this.inner.keys();
  }
  async set(): Promise<void> {
    throw new Error("IndexedDB: Internal error");
  }
  async remove(): Promise<void> {
    throw new Error("IndexedDB: Internal error");
  }
}

const NEW_PW = "violet-harbour-cinder-93";

const names = async (d: Device, vk?: Vk) =>
  aliveEntries(await d.vault(vk))
    .map((e) => e.issuer)
    .sort();
const headNames = async (w: World, vk: Vk) =>
  aliveEntries((await w.serverVault(vk))!)
    .map((e) => e.issuer)
    .sort();
const puts = (w: World) => w.server.requests.filter((r) => r.op === "PUT /v1/vault" && r.status === 200).length;

/** The active slot of `d` torn: the store recovers to the other slot at its next load(). */
function tearActive(d: Device): void {
  const kv = d.disk.kv;
  const ptr = kv.data.get(KEYS.active) as "a" | "b";
  kv.data.set(KEYS.slot[ptr], tear(kv.data.get(KEYS.slot[ptr])));
}

async function historyWith(w: World, vk: Vk, issuer: string): Promise<number[]> {
  const out: number[] = [];
  for (const h of w.server.account().history) {
    if (h.vk_id !== vk.id) continue;
    if (aliveEntries(deserializeVault(await decryptVault(JSON.parse(h.envelope), vk))).some((e) => e.issuer === issuer))
      out.push(h.version);
  }
  return out;
}

describe("M3R-1: a storage recovery inside the round's own vault load (D1)", () => {
  it("a worker round right after the active slot is torn pulls and merges first: the head keeps X, and every device ends with it", async () => {
    const w = await worldOf(3, ["GitHub", "AWS"]);
    const [a, b, c] = w.devices as [Device, Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("X only on A and the server");
    expect((await a.engine.round()).status).toBe("ok"); // X uploaded; lastSynced names A's generation with X
    tearActive(a); // the other slot holds the generation before X (the same keyring)
    a.restartWorker(); // the worker wakes on an alarm: nothing opened the vault in this context yet
    const r = await a.engine.round();
    expect(r.status).toBe("ok");
    expect(r.pulled).toBe(true); // lastSynced was cleared by the recovery: the round pulled
    expect(await headNames(w, vk)).toContain("X only on A and the server");
    await quiesce(w);
    for (const d of [a, b, c]) expect(await names(d, vk)).toContain("X only on A and the server");
    expect((await historyWith(w, vk, "X only on A and the server")).length).toBeGreaterThan(0);
  }, 60_000);

  it("control: the popup opened first (its load recovers, then the round) keeps X too", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("X");
    await a.engine.round();
    tearActive(a);
    a.restartWorker();
    await a.svc.status();
    await a.engine.round();
    await quiesce(w);
    expect(await headNames(w, vk)).toContain("X");
  }, 60_000);

  it("R1b and M3RR-3 (revision 19's D1), locked: the recovery keeps the outbox as the orphan; the worker pushes it (the server is still at its base and head), lastSynced stays null, and a full round brings the save back here", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("in the outbox");
    await a.lockNow();
    expect(a.disk.kv.data.get(SYNC_KEYS.outbox)).toBeTruthy();
    tearActive(a);
    a.restartWorker();
    const before = puts(w);
    const r = await a.engine.round();
    expect(r).toMatchObject({ status: "locked", pushedOutbox: true });
    expect(puts(w)).toBe(before + 1);
    expect(a.disk.kv.data.get(SYNC_KEYS.orphan) ?? null).toBeNull(); // retired by the 200
    expect(lastSyncedOf(a.disk.kv.data.get(SYNC_KEYS.state))).toBeNull(); // not revived (D2)
    expect(await headNames(w, vk)).toContain("in the outbox");
    await a.unlock();
    expect((await a.engine.round()).pulled).toBe(true);
    await quiesce(w);
    for (const d of [a, b]) expect(await names(d, vk)).toContain("in the outbox");
  }, 60_000);
});

describe("M3R-2: the rotation's base is what the uploaded vault merged", () => {
  /** A watch that opens each replaced head with its own key: A's VK before the rotation, VK2 after. */
  async function watchBoth(w: World, a: Device) {
    const keys = new Map<string, Vk>();
    const v1 = await a.vk();
    keys.set(v1.id, v1);
    const watch = watchServer(w, () => v1, { keyOf: (id) => keys.get(id) });
    return {
      watch,
      learn: async () => {
        const v = await a.vk();
        keys.set(v.id, v);
        await watch.settle();
      },
    };
  }

  it("another device writes between prepareRotation and commitRotation: the rotation merges it first; the head under VK2 has Y", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const { watch, learn } = await watchBoth(w, a);
    const h = await prepareRotation(a.engine, w.password); // a round first (ok), the code shown
    w.advance(5000); // the user reads and confirms the new code
    await b.add("Y written by B meanwhile");
    expect((await b.engine.round()).status).toBe("ok");
    await commitRotation(a.engine, h);
    await learn();
    const vk2 = await a.vk();
    expect(await headNames(w, vk2)).toContain("Y written by B meanwhile");
    expect(watch).toMatchObject({ problems: [], unverified: 0 });
    expect(watch.checked).toBeGreaterThan(0);
  }, 60_000);

  it("a 409 whose merging round cannot pull: not_synced, nothing sent over the unmerged head, the code not invalid; then it goes through", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const { watch, learn } = await watchBoth(w, a);
    const vk1 = await a.vk();
    const h = await prepareRotation(a.engine, w.password);
    w.server.fault({
      match: "POST /v1/keys/rotate",
      kind: "hook",
      fn: async () => {
        await b.add("Z written by B in the race");
        await b.engine.round();
      },
    });
    a.net.inject({ match: "GET /v1/vault", kind: "fail_before" });
    const err = await commitRotation(a.engine, h).then(
      () => null,
      (x) => x,
    );
    expect(err).toMatchObject({ code: "not_synced" });
    expect(w.server.account(EMAIL).vault!.vk_id).toBe(vk1.id); // not rotated over the unmerged head
    expect(await headNames(w, vk1)).toContain("Z written by B in the race");
    // the user tries again with the same prepared rotation (its code was never sent, so it is not invalid)
    await commitRotation(a.engine, h);
    await learn();
    const vk2 = await a.vk();
    expect(vk2.id).not.toBe(vk1.id);
    expect(await headNames(w, vk2)).toContain("Z written by B in the race");
    const { unlockWithRecoveryCode } = await import("../../src/core/crypto/keyring");
    expect(
      (await unlockWithRecoveryCode(JSON.parse(w.server.account(EMAIL).vault!.bundle).keyring, h.recoveryCode)).id,
    ).toBe(vk2.id);
    expect(watch).toMatchObject({ problems: [], unverified: 0 });
  }, 60_000);

  it("D5 between prepare and commit: the server is at lastSynced's version again but with another head: merged first", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const { watch, learn } = await watchBoth(w, a);
    const snap = w.server.snapshot(); // at V0
    w.advance(1000);
    await b.add("on the branch that is rolled back");
    await b.engine.round(); // V0 + 1, head H1
    const h = await prepareRotation(a.engine, w.password); // A in sync at (V0 + 1, H1)
    w.server.restore(snap); // back to V0
    w.advance(1000);
    await b.add("Z after the rollback");
    await b.engine.round(); // V0 + 1 again, another head H2 (it has Z)
    expect(w.server.account(EMAIL).vault!.version).toBe(lastSyncedOf(a.disk.kv.data.get(SYNC_KEYS.state))!.version);
    await commitRotation(a.engine, h);
    await learn();
    expect(await headNames(w, await a.vk())).toEqual(
      expect.arrayContaining(["Z after the rollback", "on the branch that is rolled back"]),
    );
    expect(watch).toMatchObject({ problems: [], unverified: 0 });
  }, 60_000);

  it("D5 for the rotation: a rollback that reuses lastSynced's version with another head is merged first", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const { watch, learn } = await watchBoth(w, a);
    const snap = w.server.snapshot();
    w.advance(1000);
    await b.add("on the rolled-back branch");
    await b.engine.round();
    await a.engine.round(); // lastSynced = (v+1, head with the entry)
    w.server.restore(snap);
    await b.add("after the rollback, the same version number");
    await b.engine.round(); // v+1 again, another head
    const h = await prepareRotation(a.engine, w.password);
    await commitRotation(a.engine, h);
    await learn();
    const head = await headNames(w, await a.vk());
    expect(head).toEqual(
      expect.arrayContaining(["on the rolled-back branch", "after the rollback, the same version number"]),
    );
    expect(watch).toMatchObject({ problems: [], unverified: 0 });
  }, 60_000);
});

describe("M3R-3: update_required stops the flows' writes too (§4.2 step 1, §8.3)", () => {
  it("below min_client_version: no password change, no new code, no rotation, no approval, no adoption; rejecting and revoking stay possible", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a, b] = w.devices as [Device, Device];
    w.server.minClientVersion = "99.0";
    expect((await a.engine.round()).status).toBe("update_required");
    const writes = () =>
      w.server.requests.filter((r) =>
        [
          "PUT /v1/keys",
          "POST /v1/keys/rotate",
          "POST /v1/enroll/requests/{rid}/respond",
          "POST /v1/enroll/requests/{rid}/approve",
        ].includes(r.op),
      ).length;
    const n0 = writes();
    await expect(changePassword(a.engine, w.password, `${w.password}-new`)).rejects.toMatchObject({
      code: "update_required",
    });
    await expect(prepareRecoveryCode(a.engine, w.password)).rejects.toMatchObject({ code: "update_required" });
    await expect(prepareRotation(a.engine, w.password)).rejects.toMatchObject({ code: "update_required" });
    await expect(adoptWithSecret(a.engine, { password: w.password })).rejects.toMatchObject({
      code: "update_required",
    });
    const n = w.device("N");
    const join = await ApprovalJoin.start(n.engine, {
      session: await w.server.session(EMAIL),
      deviceName: "N",
      email: EMAIL,
    });
    await expect(Approver.start(a.engine, join.requestId, w.password)).rejects.toMatchObject({
      code: "update_required",
    });
    expect(writes()).toBe(n0);
    expect(await rejectAllRequests(a.engine, w.password)).toBe(1); // defensive: rejecting stays possible
    const bid = ((await b.local.settlePins()) as { deviceId: string }).deviceId;
    await revokeDevice(a.engine, bid, w.password); // §3.14: never blocked
    expect(w.server.state(EMAIL).devices.find((d) => d.device_id === bid)!.revoked_at).not.toBeNull();
  }, 60_000);
});

describe("M3R-4: the daily retry of a rejected identity (§3.10 P5)", () => {
  it("revoked, then un-revoked by an honest rollback: two days of 30-minute wakes ask the server once a day, and the identity comes back", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const id = ((await a.local.identity.get()) as { deviceId: string }).deviceId;
    w.server.db.devices[id]!.revoked_at = w.server.now();
    expect((await a.engine.round()).status).toBe("rejected_by_server");
    w.server.db.devices[id]!.revoked_at = null;
    const statuses: number[] = [];
    for (let i = 0; i < 2 * 48; i++) {
      w.advance(30 * 60 * 1000);
      const before = w.server.requests.filter((r) => r.op === "GET /v1/sync/status").length;
      await a.engine.wake("sync");
      statuses.push(w.server.requests.filter((r) => r.op === "GET /v1/sync/status").length - before);
      if (((await a.local.identity.get()) as { state: string }).state === "enrolled") break;
    }
    expect(statuses.reduce((x, y) => x + y, 0)).toBeGreaterThanOrEqual(1);
    expect(statuses.length).toBeLessThanOrEqual(49); // within a day of wakes
    expect(((await a.local.identity.get()) as { state: string }).state).toBe("enrolled");
  }, 60_000);
});

describe("M3R-5: the server offset learned during the join is stored before the first merge and the first local edit", () => {
  it("a clock that jumps two days ahead after the join: the round's new estimate is stored before applyRemote clamps", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [, b] = w.devices as [Device, Device];
    const vk = await b.vk();
    b.skewMs = 2 * 86_400_000; // this machine's clock is now two days fast (the server's is right)
    const remote = (await w.serverVault(vk))!;
    const e = remote.entries[0]!;
    const p = parseHlc(e.hlc)!;
    const ahead = {
      ...remote,
      entries: remote.entries.map((x) =>
        x.id === e.id
          ? { ...x, label: "stamped a day and a half ahead", hlc: formatHlc(w.clock.now + 36 * 3_600_000, 0, p.device) }
          : x,
      ),
    };
    await w.server.adminSetHead(
      (await uploadEnvelope(ahead, vk, { vaultId: remote.vaultId, rev: w.server.account(EMAIL).vault!.version + 1 }))
        .text,
    );
    await b.unlock();
    await b.engine.round();
    const got = (await b.vault(vk)).entries.find((x) => x.id === e.id)!;
    expect(got.label).toBe("stamped a day and a half ahead");
    expect(parseHlc(got.hlc)!.wall).toBeLessThanOrEqual(w.clock.now + 24 * 3_600_000 + 60_000); // clamped on the server's clock
  }, 60_000);

  for (const skew of [2 * 86_400_000, -2 * 86_400_000]) {
    it(`a device ${skew > 0 ? "2 days fast" : "2 days slow"} joins and edits at once: at most one upload per device (F5), then quiet`, async () => {
      const w = await worldOf(1, ["GitHub", "AWS"]);
      const b = await joinDevice(w, "B", { skewMs: skew });
      expect(
        Math.abs(((b.disk.kv.data.get(SYNC_KEYS.state) as { serverOffsetMs?: number }).serverOffsetMs ?? 0) + skew),
      ).toBeLessThan(5_000);
      w.advance(1000);
      await b.add("edit on the skewed device");
      const p0 = puts(w);
      for (let i = 0; i < 6; i++) {
        for (const d of w.devices) {
          w.advance(1000);
          await d.engine.round({ explicit: true });
        }
      }
      expect(puts(w) - p0).toBeLessThanOrEqual(2);
    }, 60_000);
  }
});

describe("M3R-6: a reveal lost on the way is sent again", () => {
  it("the reveal never arrived: the next polls resend the identical body, and the approver gets to the SAS", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    const n = w.device("N");
    const join = await ApprovalJoin.start(n.engine, {
      session: await w.server.session(EMAIL),
      deviceName: "N",
      email: EMAIL,
    });
    const approver = await Approver.start(a.engine, join.requestId, w.password);
    expect(await join.poll()).toEqual({ kind: "enter_code" });
    n.net.inject({ match: "POST /v1/enroll/requests/{rid}/reveal", kind: "fail_before" });
    const first = await join.submitPairingCode(approver.pairingCode); // the reveal is sent from the code step
    expect(first.kind).toBe("show_sas");
    const sas = (first as { sas: string }).sas;
    const later: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await join.poll();
      if (s.kind === "show_sas") expect(s.sas).toBe(sas); // MUST 2: the SAS is not recomputed
      later.push((await approver.poll(w.password)).kind);
    }
    expect(later).toContain("enter_sas");
  }, 60_000);
});

describe("M3R-7: a new recovery code whose request never reached the server is decided", () => {
  it("every PUT /v1/keys failed before delivery: unconfirmed; once no signature of it can land, a round says not in effect", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a] = w.devices as [Device, Device];
    const h = await prepareRecoveryCode(a.engine, w.password);
    a.net.inject({ match: "PUT /v1/keys", kind: "fail_before", count: 10 });
    a.net.inject({ match: "GET /v1/keys", kind: "fail_before", count: 1 });
    await expect(commitRecoveryCode(a.engine, h)).rejects.toMatchObject({ code: "unconfirmed" });
    // (the PUT faults left over are spent by nothing: the rounds below send no PUT /v1/keys)
    w.advance(60_000);
    await a.engine.round();
    expect(((await a.engine.view()).state.notices ?? []).map((x) => x.kind)).not.toContain("recovery_not_in_effect"); // not yet: it may still land
    const notices: string[] = [];
    for (let i = 0; i < 4; i++) {
      w.advance(5 * 60_000);
      await a.engine.round();
      notices.push(...((await a.engine.view()).state.notices ?? []).map((x) => x.kind));
    }
    expect(notices).toContain("recovery_not_in_effect");
    expect((await a.engine.view()).state.pendingRecoveryWrap ?? null).toBeNull();
  }, 60_000);
});

describe("M3R-8: turning sync off again after the revoke's answer was lost", () => {
  it("the second turnSyncOff finds the device revoked and finishes the local half", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [, b] = w.devices as [Device, Device];
    b.net.inject({ match: "POST /v1/devices/{id}/revoke", kind: "lose_response" });
    await expect(turnSyncOff(b.engine, w.password)).rejects.toMatchObject({ code: "unconfirmed" });
    await turnSyncOff(b.engine, w.password);
    expect((await b.local.status()).kind).toBe("off");
    expect(aliveEntries(await b.vault()).length).toBe(1); // the local data stays
  }, 60_000);
});

describe("M3R-9: a join whose complete never landed can be joined again", () => {
  it("complete answered 410: join_unfinished; joining again goes ahead without removing the identity by hand, and nothing is lost", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const n = w.device("N");
    const plan = await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
    });
    w.server.fault({
      match: "POST /v1/enroll/requests/{rid}/complete",
      kind: "status",
      status: 410,
      code: "enroll_gone",
      count: 3,
    });
    expect(await commitJoin(plan)).toBe("unconfirmed");
    w.server.clearFaults();
    expect((await n.engine.round()).status).toBe("join_unfinished");
    w.advance(1000);
    await n.add("made while unfinished");
    // M3RR-7: not while the last complete may still land
    await expect(
      joinWithRecoveryCode(n.engine, {
        session: await w.server.session(EMAIL),
        recoveryCode: w.code,
        deviceName: "N",
        email: EMAIL,
      }),
    ).rejects.toMatchObject({ code: "unfinished_wait" });
    w.advance(11 * 60_000);
    await n.unlock();
    const plan2 = await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
    });
    expect(await commitJoin(plan2)).toBe("enrolled");
    await quiesce(w);
    expect(
      aliveEntries(await w.devices[0]!.vault())
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["GitHub", "made while unfinished"]);
  }, 60_000);

  it("A17: a complete whose answer was lost is retried, gets 410, and the status as devN says enrolled", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const n = w.device("N");
    const plan = await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
    });
    n.net.inject({ match: "POST /v1/enroll/requests/{rid}/complete", kind: "lose_response" });
    expect(await commitJoin(plan)).toBe("enrolled");
    expect((await n.engine.round()).status).toBe("ok");
  }, 60_000);
});

describe("M3R-12: pending_enrollments for the badge", () => {
  it("stored when it changes, locked too; recovery requests never count", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    const pending = () =>
      (a.disk.kv.data.get(SYNC_KEYS.state) as { pendingEnrollments?: number }).pendingEnrollments ?? 0;
    expect(pending()).toBe(0);
    const n = w.device("N");
    await ApprovalJoin.start(n.engine, { session: await w.server.session(EMAIL), deviceName: "N", email: EMAIL });
    await a.lockNow();
    await a.engine.round();
    expect(pending()).toBe(1);
    const m = w.device("M");
    await joinWithRecoveryCode(m.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "M",
      email: EMAIL,
    });
    await a.engine.round();
    expect(pending()).toBe(1);
  }, 60_000);
});

describe("M3R-13: the server's error code is stored only as a short word", () => {
  it("an odd code from the server is malformed_response in sk_sync_state", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    w.server.fault({
      match: "GET /v1/sync/status",
      kind: "status",
      status: 400,
      code: "<img src=x onerror=alert(1)> and a very long text",
    });
    expect((await a.engine.round()).error).toBe("malformed_response");
    expect((a.disk.kv.data.get(SYNC_KEYS.state) as { lastErrorCode?: string }).lastErrorCode).toBe(
      "malformed_response",
    );
  }, 60_000);
});

describe("M3R-14: the unlock's order from the bundle, and write_denied as a moved key", () => {
  it("a rotation with the same password, then an offline round over the stored status: the password still adopts VK2", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a, b] = w.devices as [Device, Device];
    await commitRotation(a.engine, await prepareRotation(a.engine, w.password));
    expect((await b.engine.round()).status).toBe("needs_password");
    b.net.partition(true);
    expect((await b.engine.round()).status).toBe("offline"); // the stored status is "offline" now
    b.net.partition(false);
    expect(await adoptWithSecret(b.engine, { password: w.password })).toMatchObject({ kind: "adopted", sameVk: false });
    expect((await b.vk()).id).toBe((await a.vk()).id);
  }, 60_000);

  it("a PUT answered 403 write_denied while the key really moved (another device rotated): asked again, needs_password, no failure", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a, b] = w.devices as [Device, Device];
    w.advance(1000);
    await a.add("pending");
    let once = true;
    const racing = {
      send: async (req: Parameters<typeof a.net.send>[0]) => {
        if (once && req.method === "PUT" && req.target === "/v1/vault") {
          once = false;
          await commitRotation(b.engine, await prepareRotation(b.engine, w.password)); // K_write moves under A's PUT
          return {
            status: 403,
            headers: {},
            body: JSON.stringify({ error: { code: "write_denied" }, server_time: w.server.now() }),
          };
        }
        return a.net.send(req);
      },
    };
    const c = contextOver({
      ...a.disk,
      lock: a.lock,
      identityLock: a.identityLock,
      syncLock: a.syncLock,
      transport: racing,
      clock: a.now,
    });
    const r = await c.engine.round();
    expect(r.status).toBe("needs_password");
    expect((await c.engine.view()).state.failures ?? 0).toBe(0);
  }, 60_000);

  it("M3RR-10: a persistent 403 write_denied with nothing moved: one PUT, then error write_denied (not five uploads, not version_conflict)", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    w.advance(1000);
    await a.add("pending");
    w.server.fault({ match: "PUT /v1/vault", kind: "status", status: 403, code: "write_denied", count: 100 });
    const before = w.server.requests.filter((x) => x.op === "PUT /v1/vault").length;
    const r = await a.engine.round();
    expect(r).toMatchObject({ status: "error", error: "write_denied" });
    expect(w.server.requests.filter((x) => x.op === "PUT /v1/vault").length - before).toBe(1);
    expect((await a.engine.view()).state.failures).toBe(1);
  }, 60_000);
});

describe("M3R-15: explicit rounds inside a 429 window", () => {
  it("each answered 429 with Retry-After 60: the first counts, explicit presses inside the running backoff do not (M3RR-2 kept M3R-15 for 429 only); the backoff follows Retry-After", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    w.server.fault({
      match: "GET /v1/sync/status",
      kind: "status",
      status: 429,
      code: "rate_limited",
      retryAfter: 60,
      count: 15,
    });
    for (let i = 0; i < 15; i++) {
      w.advance(1000);
      await a.engine.round({ explicit: true });
    }
    const st = (await a.engine.view()).state;
    expect(st.failures).toBe(1);
    expect(st.backoffUntil! - w.clock.now).toBeLessThanOrEqual(60_000);
  }, 60_000);
});

describe("the review's plausible findings", () => {
  it("P-1: a commit refused as stale after the server accepted is committed_on_server, and the next round catches up", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a] = w.devices as [Device, Device];
    const flows = a.ctx.engine.deps.flows as { commitKeys: (c: unknown) => Promise<void> };
    const real = flows.commitKeys.bind(flows);
    let once = true;
    flows.commitKeys = async (c) => {
      if (once) {
        once = false;
        throw new ServiceError("bad_state", "stale");
      }
      return real(c);
    };
    await expect(changePassword(a.engine, w.password, NEW_PW)).rejects.toMatchObject({ code: "committed_on_server" });
    expect((await a.engine.round()).keyStatus).toBe("needs_new_password"); // the server has it; the new password adopts it
    expect(await adoptWithSecret(a.engine, { password: NEW_PW })).toMatchObject({ kind: "adopted" });
  }, 60_000);

  it("P-2: a history version pruned between the list and the fetch is skipped, not a failed round", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    const vk = await a.vk();
    const good = (await w.serverVault(vk))!;
    w.advance(1000);
    await a.add("v2");
    await a.engine.round(); // v2
    const vaultId = good.vaultId;
    const { uploadEnvelope } = await import("../../src/core/sync/local/outbox");
    const other = await (await import("../../src/core/crypto/vk")).generateVk();
    await w.server.adminSetHead((await uploadEnvelope(good, other, { vaultId, rev: 3 })).text); // a head this key cannot open
    // v2 is listed, then pruned before it is fetched (M4 prunes inside PUT and rotate)
    w.server.fault({ match: "GET /v1/vault/versions/{v}", kind: "status", status: 404, code: "not_found" });
    const r = await a.engine.round();
    expect(r.status).toBe("ok"); // walked past the pruned v2 to v1, merged, uploaded over the unreadable head
    expect(w.server.requests.filter((x) => x.op === "GET /v1/vault/versions/{v}").map((x) => x.status)).toEqual([
      404, 200,
    ]);
    expect(
      aliveEntries((await w.serverVault(vk))!)
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["GitHub", "v2"]);
  }, 60_000);

  it("P-3: init's vault_exists with the follow-up status unanswered: unconfirmed, the local half kept for the round", async () => {
    const w = new World();
    const a = w.device("A");
    w.code = (await createProtected(a.svc, w.password)).recoveryCode;
    await a.svc.openView();
    a.net.inject({ match: "POST /v1/vault/init", kind: "lose_response" }); // landed, answer lost
    a.net.inject({ match: "GET /v1/sync/status", kind: "fail_before", count: 1 });
    // the retry of init is answered 409 vault_exists (the bundle text differs? no: identical, so 201): force the 409 path
    w.server.fault({ match: "POST /v1/vault/init", kind: "status", status: 409, code: "vault_exists", count: 5 });
    const r = await firstUpload(a.engine, {
      session: await w.server.session(EMAIL),
      password: w.password,
      recoveryCode: w.code,
      deviceName: "A",
      email: EMAIL,
    });
    expect(r).toEqual({ kind: "unconfirmed" });
    expect((await a.local.status()).kind).toBe("on"); // not undone
  }, 60_000);
});

describe("M3R-11: the gaps behind the review's surviving mutants", () => {
  const deviceOf = (req: { headers: Readonly<Record<string, string>> }) =>
    Object.entries(req.headers).find(([k]) => k.toLowerCase() === "sixkey-device")?.[1];
  const idOf = async (d: Device) => ((await d.local.identity.get()) as { deviceId: string }).deviceId;
  /** lastSynced, when set, names a version the server's history has with exactly that head. */
  async function lastSyncedHeld(w: World, d: Device): Promise<void> {
    const ls = lastSyncedOf(d.disk.kv.data.get(SYNC_KEYS.state));
    if (!ls) return;
    const h = w.server.account(EMAIL).history.find((x) => x.version === ls.version);
    expect(h, `${d.name}: lastSynced.version ${ls.version} exists`).toBeDefined();
    expect(await headOf(h!.envelope), `${d.name}: lastSynced.head is that version's`).toBe(ls.head);
  }

  it("MR-06: a remote that changed a secret but carries an older stamp still stops the merge (review_needed); nothing uploaded", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    const remote = (await w.serverVault(vk))!;
    const e = remote.entries.find((x) => x.issuer === "GitHub")!;
    const old = parseHlc(e.hlc)!;
    const tampered = {
      ...remote,
      entries: remote.entries.map((x) =>
        x.id === e.id
          ? { ...x, secret: "KRSXG5CTMVRXEZLUKN2XAZLSKNSWG4TFOQ", hlc: formatHlc(old.wall - 60_000, 0, old.device) }
          : x,
      ),
    };
    await w.server.adminSetHead(
      (await uploadEnvelope(tampered, vk, { vaultId: remote.vaultId, rev: w.server.account(EMAIL).vault!.version + 1 }))
        .text,
    );
    const before = puts(w);
    const r = await a.engine.round();
    expect({ status: r.status, uploaded: puts(w) - before }).toEqual({ status: "review_needed", uploaded: 0 });
    expect(r.blocked!.report.secretChanged).toEqual([e.id]);
  }, 60_000);

  it("F5 end to end (MR-09): a remote stamp days ahead reaches the server clamped, and a real edit two days later wins on every device", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const vk = await a.vk();
    // forged from A's own vault, its content and placement stamps both ten days ahead: the clamp shifts an entry's stamps
    // together, so the merge equals the clamped remote exactly and only the comparison with the RAW remote (F5) uploads
    const remote = await a.vault(vk);
    const e = remote.entries.find((x) => x.issuer === "GitHub")!;
    const p = parseHlc(e.hlc)!;
    const future = formatHlc(w.clock.now + 10 * 86_400_000, 0, p.device);
    const ahead = {
      ...remote,
      entries: remote.entries.map((x) =>
        x.id === e.id ? { ...x, label: "from the future", hlc: future, phlc: future } : x,
      ),
    };
    await w.server.adminSetHead(
      (await uploadEnvelope(ahead, vk, { vaultId: remote.vaultId, rev: w.server.account(EMAIL).vault!.version + 1 }))
        .text,
    );
    expect((await a.engine.round()).uploaded).toBe(true); // once: the clamped stamps go back to the server
    const head = (await w.serverVault(vk))!.entries.find((x) => x.id === e.id)!;
    expect(parseHlc(head.hlc)!.wall).toBeLessThan(w.clock.now + 2 * 86_400_000); // the clamped stamp reached the server
    w.advance(2 * 86_400_000); // past the clamp's +24 h, before the forged +10 d
    await a.unlock();
    await b.unlock();
    await b.engine.round();
    await b.svc.mutate((v, c) => editEntry(v, e.id, { label: "a real edit two days later" }, c));
    await quiesce(w);
    for (const d of [a, b])
      expect((await d.vault(vk)).entries.find((x) => x.id === e.id)!.label).toBe("a real edit two days later");
  }, 60_000);

  it("MR-02: a locked push answered 409 is dropped, never taken as pushed: lastSynced names only what the server holds", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a, b] = w.devices as [Device, Device];
    w.advance(1000);
    await a.add("in the outbox");
    await a.lockNow();
    const aid = await idOf(a);
    w.server.fault({
      match: (k, req) => k === "PUT /v1/vault" && deviceOf(req) === aid,
      kind: "hook",
      fn: async () => {
        await b.add("B wins the race");
        await b.engine.round();
      },
    });
    const r = await a.engine.round();
    expect(r.pushedOutbox).toBe(false);
    await lastSyncedHeld(w, a);
    await a.unlock();
    await quiesce(w);
    expect(await names(b)).toEqual(["B wins the race", "GitHub", "in the outbox"]);
  }, 60_000);

  it("MR-04: an outbox push that never arrived is not taken as landed because the server is at base + 1 (another device's write)", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a, b] = w.devices as [Device, Device];
    w.advance(1000);
    await a.add("in the outbox");
    await a.lockNow();
    a.net.inject({ match: "PUT /v1/vault", kind: "fail_before" });
    expect((await a.engine.round()).status).toBe("offline");
    await b.add("B at base + 1");
    await b.engine.round();
    expect((await a.engine.round()).pushedOutbox).toBe(false);
    await lastSyncedHeld(w, a);
    await a.unlock();
    await quiesce(w);
    expect(await names(b)).toEqual(["B at base + 1", "GitHub", "in the outbox"]);
  }, 60_000);

  it("MR-11: a paused head that is replaced is pulled again (the memo is keyed on the head)", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    const good = (await w.serverVault(vk))!;
    const vaultId = good.vaultId;
    const v2 = await encryptVault(utf8(JSON.stringify({ schemaVersion: 2, vaultId, entries: [] })), vk, {
      vaultId,
      rev: w.server.account(EMAIL).vault!.version + 1,
    });
    await w.server.adminSetHead(JSON.stringify(v2));
    expect((await a.engine.round()).status).toBe("paused_newer");
    expect((await a.engine.round()).status).toBe("paused_newer"); // remembered: not pulled again
    await w.server.adminSetHead(
      (await uploadEnvelope(good, vk, { vaultId, rev: w.server.account(EMAIL).vault!.version + 1 })).text,
    ); // repaired
    const r = await a.engine.round();
    expect(r).toMatchObject({ status: "ok", pulled: true });
  }, 60_000);

  it("MR-12: the rollback warning is shown once (maxSeenVersion is lowered to what the server says)", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a, b] = w.devices as [Device, Device];
    const snap = w.server.snapshot();
    for (const n of ["one", "two"]) {
      w.advance(1000);
      await b.add(n);
      await b.engine.round();
    }
    await a.engine.round(); // A saw v + 2
    w.server.restore(snap); // back two versions
    await a.engine.round(); // the warning, a merge, an upload (v + 1)
    for (let i = 0; i < 2; i++) {
      w.advance(60_000); // a notice is one per kind and time: later rounds would add new ones
      await a.engine.round();
    }
    expect(((await a.engine.view()).state.notices ?? []).filter((x) => x.kind === "rollback").length).toBe(1);
  }, 60_000);

  it("MR-14: after a key commit whose pin write failed, the next key operations still go ahead (keys.ts settles first)", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a, b] = w.devices as [Device, Device];
    const broken = contextOver({
      kv: a.disk.kv,
      mirror: a.disk.mirror,
      idb: new NoWrite(a.disk.idb),
      session: a.disk.session,
      lock: a.lock,
      identityLock: a.identityLock,
      syncLock: a.syncLock,
      transport: a.net,
      clock: a.now,
    });
    await changePassword(broken.engine, w.password, NEW_PW);
    expect((a.disk.kv.data.get(SYNC_KEYS.state) as { pendingPins?: unknown }).pendingPins).toBeDefined();
    await changePassword(broken.engine, NEW_PW, `${NEW_PW}-2`);
    const bid = await idOf(b);
    await revokeDevice(broken.engine, bid, `${NEW_PW}-2`);
    expect(w.server.state(EMAIL).devices.find((d) => d.device_id === bid)!.revoked_at).not.toBeNull();
  }, 60_000);

  it("MR-16: a round in another context while the new code's PUT is in flight says nothing about it until the server answers", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a] = w.devices as [Device, Device];
    const h = await prepareRecoveryCode(a.engine, w.password);
    a.net.inject({ match: "PUT /v1/keys", kind: "hold" });
    const sent = commitRecoveryCode(a.engine, h);
    for (let i = 0; i < 400 && a.net.heldCount < 1; i++) await new Promise((r) => setTimeout(r, 5));
    expect(a.net.heldCount).toBe(1);
    // the settings page rounds meanwhile, and judges the keys again (as after another device's key change)
    const st = a.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>;
    a.disk.kv.data.set(SYNC_KEYS.state, { ...st, keysSeen: null });
    const page = contextOver({
      ...a.disk,
      lock: a.lock,
      identityLock: a.identityLock,
      syncLock: tryMutex(),
      transport: w.server.transport(),
      clock: a.now,
    });
    await page.engine.round();
    const kinds = async () => ((await (page.engine as SyncEngine).view()).state.notices ?? []).map((x) => x.kind);
    expect(await kinds()).not.toContain("recovery_not_in_effect");
    expect((await page.engine.view()).state.pendingRecoveryWrap).toBeTruthy();
    await a.net.release();
    await sent;
    expect(await kinds()).toContain("recovery_in_effect");
  }, 60_000);

  it("MR-19: cfg_missing with a readable vault (an unfinished turn-off): no adoption, nothing signed", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a] = w.devices as [Device, Device];
    a.disk.kv.data.delete(SYNC_KEYS.cfg);
    expect((await a.local.status()).kind).toBe("cfg_missing");
    const n0 = w.server.requests.length;
    await expect(adoptWithSecret(a.engine, { password: w.password })).rejects.toMatchObject({ code: "not_enrolled" });
    expect(w.server.requests.length).toBe(n0);
  }, 60_000);

  it("MR-20 (MUST 8): after an approve that never arrived, no approval; after one whose answer was lost, approved once a poll confirms", async () => {
    for (const kind of ["fail_before", "lose_response"] as const) {
      const w = await worldOf(1, ["GitHub"]);
      const a = w.devices[0]!;
      const n = w.device("N");
      const join = await ApprovalJoin.start(n.engine, {
        session: await w.server.session(EMAIL),
        deviceName: "N",
        email: EMAIL,
      });
      const ap = await Approver.start(a.engine, join.requestId, w.password);
      await join.poll();
      const sas = (await join.submitPairingCode(ap.pairingCode)) as { sas: string };
      await ap.poll(w.password);
      a.net.inject({ match: "POST /v1/enroll/requests/{rid}/approve", kind });
      const r = await ap.submitSas(sas.sas, w.password);
      if (kind === "fail_before") expect(r.kind).toBe("failed");
      else {
        expect(r.kind).toBe("approved");
        const ops = w.server.requests.map((x) => x.op);
        expect(ops.lastIndexOf("GET /v1/enroll/requests/{rid}")).toBeGreaterThan(
          ops.lastIndexOf("POST /v1/enroll/requests/{rid}/approve"),
        );
      }
    }
  }, 60_000);

  it("MR-21 (RR-12): a keyring changed by another writer between step 5 and step 6, hour-aligned: keyring_changed, nothing sent", async () => {
    const w = new World();
    const a = w.device("A");
    w.code = (await createProtected(a.svc, w.password)).recoveryCode;
    await a.svc.openView();
    const cfg = a.local.cfg as { write: (...x: unknown[]) => Promise<unknown> };
    const write = cfg.write.bind(cfg);
    cfg.write = async (...args: unknown[]) => {
      const r = await write(...args);
      const g = await a.generation();
      const vk = await a.vk();
      const kr = await setPassword(g.keyring, vk, "another-strong-pass-77", {
        now: () => Math.floor(w.clock.now / 3_600_000) * 3_600_000,
      });
      await a.ctx.store.transact(async (cur) => ({ envelope: cur!.envelope, keyring: kr }));
      return r;
    };
    const r = await firstUpload(a.engine, {
      session: await w.server.session(EMAIL),
      password: w.password,
      recoveryCode: w.code,
      deviceName: "A",
      email: EMAIL,
    });
    expect(r).toEqual({ kind: "keyring_changed" });
    expect(w.server.requests.map((x) => x.op)).not.toContain("POST /v1/vault/init");
  }, 60_000);

  it("MR-22: the recovery join checks the bundle against the vault id the server names", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const n = w.device("N");
    w.server.fault({
      match: "POST /v1/enroll/recovery",
      kind: "hook",
      fn: (s) => {
        s.account(EMAIL).vault!.vault_id = "another-vault-id-01";
      },
    });
    await expect(
      joinWithRecoveryCode(n.engine, {
        session: await w.server.session(EMAIL),
        recoveryCode: w.code,
        deviceName: "N",
        email: EMAIL,
      }),
    ).rejects.toMatchObject({ code: "bad_bundle" });
  }, 60_000);

  it("MR-28: a worker start finds a commit with no kick (the page died before kicking) and schedules a round", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    w.advance(1000);
    await a.add("committed, never kicked");
    a.disk.kv.data.delete(SYNC_KEYS.outbox); // nothing but the derived dirty says there is work (a lost or unwired outbox)
    a.restartWorker();
    a.scheduler.wakes.clear();
    await a.engine.start();
    expect(a.scheduler.wakes.has("sync")).toBe(true);
  }, 60_000);
});

describe("the review's §4 smaller differences the engine handles", () => {
  it("a 500 whose body says server_time 0 (M4's outermost handler) moves no clock", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    let once = true;
    const odd = {
      send: async (req: Parameters<typeof a.net.send>[0]) => {
        if (once && req.target === "/v1/sync/status") {
          once = false;
          return { status: 500, headers: {}, body: '{"error":{"code":"internal_error"},"server_time":0}' };
        }
        return a.net.send(req);
      },
    };
    const c = contextOver({
      ...a.disk,
      lock: a.lock,
      identityLock: a.identityLock,
      syncLock: a.syncLock,
      transport: odd,
      clock: a.now,
    });
    expect((await c.engine.round()).error).toBe("internal_error");
    expect(Math.abs(c.engine.serverOffset)).toBeLessThan(60_000);
  }, 60_000);
});
