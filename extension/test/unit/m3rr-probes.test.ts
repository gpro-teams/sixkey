// The M3 re-review's probes (docs/audit/internal-reviews/M3-REREVIEW.md), adopted as regression tests. Each `it` asserts the safe behaviour the
// finding asked for; it failed on revision 2 when the finding was confirmed. RR-D's two cases are adapted to the fix
// (M3RR-7: no undo while the old identity's request can still land, so the second attempt is refused with
// unfinished_wait, and the safe outcome is asserted after the late delivery and after the window).
import { describe, expect, it } from "vitest";
import { decryptVault } from "../../src/core/crypto/envelope";
import { unlockWithRecoveryCode } from "../../src/core/crypto/keyring";
import type { Vk } from "../../src/core/crypto/vk";
import { KEYS } from "../../src/core/storage/format";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { lastSyncedOf } from "../../src/core/sync/local/state";
import { aliveEntries } from "../../src/core/vault/model";
import { deserializeVault } from "../../src/core/vault/validate";
import { commitJoin, firstUpload, joinWithRecoveryCode } from "../../src/core/sync/engine/enroll";
import {
  commitRecoveryCode,
  commitRotation,
  prepareRecoveryCode,
  prepareRotation,
} from "../../src/core/sync/engine/keys";
import { watchServer } from "../helpers/m3-check";
import { tear } from "../helpers/faulty-kv";
import { createProtected } from "../helpers/vaults";
import { contextOver, EMAIL, quiesce, World, worldOf, type Device } from "../helpers/m3-world";

const names = async (d: Device, vk?: Vk) =>
  aliveEntries(await d.vault(vk))
    .map((e) => e.issuer)
    .sort();
const headNames = async (w: World, vk: Vk) =>
  aliveEntries((await w.serverVault(vk))!)
    .map((e) => e.issuer)
    .sort();
const notices = async (d: Device) => ((await d.engine.view()).state.notices ?? []).map((x) => x.kind);

function tearActive(d: Device): void {
  const kv = d.disk.kv;
  const ptr = kv.data.get(KEYS.active) as "a" | "b";
  kv.data.set(KEYS.slot[ptr], tear(kv.data.get(KEYS.slot[ptr])));
}

/** A second context of device `d` (another page, or the worker) over the same storage, locks and network. */
function secondContext(d: Device) {
  return contextOver({
    ...d.disk,
    lock: d.lock,
    identityLock: d.identityLock,
    syncLock: d.syncLock,
    transport: d.net,
    clock: d.now,
  });
}

describe("RR-A: a rotation whose answer was lost, retried with the same handle", () => {
  it("the retry never says not_synced ('nothing sent, the code not invalid') while the server holds the rotation", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a] = w.devices as [Device, Device];
    const vk1 = await a.vk();
    const h = await prepareRotation(a.engine, w.password);
    a.net.inject({ match: "POST /v1/keys/rotate", kind: "lose_response" });
    a.net.inject({ match: "GET /v1/keys", kind: "fail_before", count: 1 });
    const e1 = await commitRotation(a.engine, h).then(
      () => null,
      (x) => x,
    );
    const row = w.server.account(EMAIL).vault!;
    const newCodeOpensServer = await unlockWithRecoveryCode(JSON.parse(row.bundle).keyring, h.recoveryCode).then(
      () => true,
      () => false,
    );
    const e2 = await commitRotation(a.engine, h).then(
      () => null,
      (x) => x,
    );
    const r = await a.engine.round();
    console.log(
      "RR-A",
      JSON.stringify({
        first: e1?.code ?? "ok",
        rotatedOnServer: row.vk_id !== vk1.id,
        newCodeOpensServer,
        retry: e2?.code ?? "ok",
        round: r.status,
        pending: (await a.engine.view()).state.pendingRecoveryWrap ?? null,
      }),
    );
    expect(e1?.code).toBe("unconfirmed");
    expect(row.vk_id).not.toBe(vk1.id); // the rotation is in effect: the new code is the server's, the old one is not
    expect(e2?.code ?? "ok").not.toBe("not_synced");
  }, 60_000);
});

describe("RR-B: the kill switch at the moment of the write", () => {
  it("a new recovery code prepared before min_client_version rose is not sent after it", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a] = w.devices as [Device, Device];
    const h = await prepareRecoveryCode(a.engine, w.password);
    w.server.minClientVersion = "99.0";
    const before = w.server.requests.filter((r) => r.op === "PUT /v1/keys" && r.status === 200).length;
    const e = await commitRecoveryCode(a.engine, h).then(
      () => null,
      (x) => x,
    );
    const after = w.server.requests.filter((r) => r.op === "PUT /v1/keys" && r.status === 200).length;
    console.log("RR-B", JSON.stringify({ result: e?.code ?? "ok", acceptedKeyWrites: after - before }));
    expect(after - before).toBe(0);
  }, 60_000);
});

describe("RR-C: the rotation's base read against a round in another context (no sixkey-sync)", () => {
  it("a round of the worker between commitRotation's vault load and its state read: the rotation still absorbs the head it replaces", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a, b] = w.devices as [Device, Device];
    const v1 = await a.vk();
    const keys = new Map<string, Vk>([[v1.id, v1]]);
    const watch = watchServer(w, () => v1, { keyOf: (id) => keys.get(id) });
    const h = await prepareRotation(a.engine, w.password);
    w.advance(5000);
    await b.add("Y by B");
    expect((await b.engine.round()).status).toBe("ok");
    const worker = secondContext(a);
    const orig = a.ctx.flows.current.bind(a.ctx.flows);
    let armed = true;
    a.ctx.flows.current = async () => {
      const cur = await orig();
      if (armed) {
        armed = false;
        const r = await worker.engine.round(); // the worker's alarm round pulls Y, merges it, sets lastSynced
        console.log("RR-C worker round", r.status, r.pulled, r.merged);
      }
      return cur;
    };
    await commitRotation(a.engine, h);
    a.ctx.flows.current = orig;
    const vk2 = await a.vk();
    keys.set(vk2.id, vk2);
    await watch.settle();
    const headAfterRotate = await headNames(w, vk2);
    await quiesce(w, 8, [a]);
    console.log(
      "RR-C",
      JSON.stringify({ headAfterRotate, problems: watch.problems.length, headAfterNextRound: await headNames(w, vk2) }),
    );
    expect(watch.problems).toEqual([]);
  }, 60_000);
});

describe("RR-D: the M3R-9 undo while the old identity's request can still land", () => {
  it("a complete delivered late: the new join is refused while it can land (unfinished_wait); it lands; no enrolled device without a local key", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const n = w.device("N");
    const plan = await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
    });
    n.net.inject({ match: "POST /v1/enroll/requests/{rid}/complete", kind: "late", count: 3 });
    expect(await commitJoin(plan)).toBe("unconfirmed");
    expect((await n.engine.round()).status).toBe("join_unfinished");
    const oldId = ((await n.local.identity.get()) as { deviceId: string }).deviceId;
    await expect(
      joinWithRecoveryCode(n.engine, {
        session: await w.server.session(EMAIL),
        recoveryCode: w.code,
        deviceName: "N",
        email: EMAIL,
      }),
    ).rejects.toMatchObject({ code: "unfinished_wait" });
    expect(((await n.local.identity.get()) as { deviceId: string }).deviceId).toBe(oldId); // not undone
    await n.net.flushLate(); // the first complete reaches the server now (within its signature window)
    await n.engine.round();
    const rows = w.server.state(EMAIL).devices;
    const local = ((await n.local.identity.get()) as { deviceId: string } | null)?.deviceId ?? null;
    console.log(
      "RR-D",
      JSON.stringify({
        devices: rows.length,
        oldEnrolledOnServer: rows.some((d) => d.device_id === oldId && d.revoked_at === null),
        localIsOld: local === oldId,
      }),
    );
    expect(rows.filter((d) => d.revoked_at === null && d.device_id !== local).length).toBe(1); // only A: N's row is N's key
    expect((await n.local.status()).kind).toBe("on");
  }, 60_000);

  it("a complete that never lands: after the window the undo goes ahead, and the old request, delivered then, is refused", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const n = w.device("N");
    const plan = await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
    });
    n.net.inject({ match: "POST /v1/enroll/requests/{rid}/complete", kind: "late", count: 3 });
    expect(await commitJoin(plan)).toBe("unconfirmed");
    const oldId = ((await n.local.identity.get()) as { deviceId: string }).deviceId;
    w.advance(11 * 60_000);
    await n.unlock();
    const plan2 = await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
    });
    expect(await commitJoin(plan2)).toBe("enrolled");
    await n.net.flushLate(); // outside its signature window now
    const rows = w.server.state(EMAIL).devices;
    const local = ((await n.local.identity.get()) as { deviceId: string }).deviceId;
    expect(local).not.toBe(oldId);
    expect(rows.some((d) => d.device_id === oldId && d.revoked_at === null)).toBe(false);
  }, 60_000);

  it("first upload: an init delivered late; the second first upload is refused while it can land; it lands and this device is on", async () => {
    const w = new World();
    const a = w.device("A");
    const r = await createProtected(a.svc, w.password);
    w.code = r.recoveryCode;
    await a.svc.openView();
    w.advance(1000);
    await a.add("GitHub");
    a.net.inject({ match: "POST /v1/vault/init", kind: "late", count: 3 });
    const s1 = await w.server.session(EMAIL);
    expect(
      (
        await firstUpload(a.engine, {
          session: s1,
          password: w.password,
          recoveryCode: w.code,
          deviceName: "A",
          email: EMAIL,
        })
      ).kind,
    ).toBe("unconfirmed");
    const oldId = ((await a.local.identity.get()) as { deviceId: string }).deviceId;
    await expect(
      firstUpload(a.engine, {
        session: await w.server.session(EMAIL),
        password: w.password,
        recoveryCode: w.code,
        deviceName: "A",
        email: EMAIL,
      }),
    ).rejects.toMatchObject({ code: "unfinished_wait" });
    await a.net.flushLate();
    await a.engine.round();
    const rows = w.server.state(EMAIL).devices;
    const local = (await a.local.identity.get()) as { deviceId: string } | null;
    console.log(
      "RR-D2",
      JSON.stringify({
        devices: rows.map((d) => (d.device_id === oldId ? "old" : "other")),
        localIsOld: local?.deviceId === oldId,
        status: (await a.local.status()).kind,
      }),
    );
    expect(rows.some((d) => d.device_id === oldId) && local?.deviceId !== oldId).toBe(false);
    expect(rows.map((d) => d.device_id)).toEqual([oldId]);
  }, 60_000);
});

describe("RR-E: D1 drops an outbox that holds an acknowledged save (R1b after the fix)", () => {
  it("locked: a save in the outbox, the active slot torn, a worker push: the save is kept somewhere a round brings back", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("saved, in the outbox"); // acknowledged to the user; the outbox holds it ("lock every time": popup closed)
    await a.lockNow();
    tearActive(a);
    a.restartWorker();
    const r = await a.engine.round();
    await a.unlock();
    await quiesce(w);
    const everywhere =
      (await names(a, vk)).includes("saved, in the outbox") || (await names(b, vk)).includes("saved, in the outbox");
    const snaps = await a.ctx.store.snapshots();
    const inSnapshot = await Promise.all(
      snaps.map(async (m) => {
        const rec = a.disk.kv.data.get(KEYS.snap(m.id)) as { envelope: Parameters<typeof decryptVault>[0] } | undefined;
        return rec
          ? aliveEntries(deserializeVault(await decryptVault(rec.envelope, vk))).some(
              (e) => e.issuer === "saved, in the outbox",
            )
          : false;
      }),
    );
    console.log(
      "RR-E",
      JSON.stringify({
        round: r.status,
        pushed: r.pushedOutbox,
        onAnyDevice: everywhere,
        inHead: (await headNames(w, vk)).includes("saved, in the outbox"),
        inRollingSnapshot: inSnapshot.some(Boolean),
        snapshots: snaps.length,
      }),
    );
    expect(everywhere).toBe(true);
  }, 60_000);
});

describe("RR-F: M3R-7's 10 minutes on this machine's clock", () => {
  it("a clock that jumps 11 minutes ahead: 'not in effect' is never said for a request the server still accepts", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a] = w.devices as [Device, Device];
    const h = await prepareRecoveryCode(a.engine, w.password);
    a.net.inject({ match: "PUT /v1/keys", kind: "late", count: 3 }); // queued in the network, delivered later
    await expect(commitRecoveryCode(a.engine, h)).rejects.toMatchObject({ code: "unconfirmed" });
    a.skewMs += 11 * 60_000; // this machine's clock jumps (resume from sleep, NTP); the server's does not
    await a.engine.round();
    const said = await notices(a);
    await a.net.flushLate(); // the queued PUT arrives within its signature window (server time has not moved)
    const inEffect = await unlockWithRecoveryCode(
      JSON.parse(w.server.account(EMAIL).vault!.bundle).keyring,
      h.recoveryCode,
    ).then(
      () => true,
      () => false,
    );
    await a.engine.round();
    console.log("RR-F", JSON.stringify({ saidBefore: said, inEffect, after: await notices(a) }));
    expect(said.includes("recovery_not_in_effect") && inEffect).toBe(false);
  }, 60_000);
});

describe("RR-G: M3R-15's fix and a sustained overload", () => {
  it("503 unavailable with Retry-After 5 (M4's db/pool/body answer) for an hour: the retries back off", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const [a] = w.devices as [Device];
    w.server.fault({
      match: "GET /v1/sync/status",
      kind: "status",
      status: 503,
      code: "unavailable",
      retryAfter: 5,
      count: 10_000,
    });
    const start = w.clock.now;
    let rounds = 0;
    while (w.clock.now - start < 60 * 60_000) {
      const v = await a.engine.view();
      const until = v.state.backoffUntil ?? w.clock.now;
      w.clock.now = Math.max(w.clock.now + 1, until);
      await a.engine.wake("retry");
      rounds++;
      if (rounds > 2000) break;
    }
    const v = await a.engine.view();
    console.log(
      "RR-G",
      JSON.stringify({
        roundsInAnHour: rounds,
        failures: v.state.failures ?? 0,
        lastGapS: Math.round(((v.state.backoffUntil ?? 0) - w.clock.now) / 1000),
      }),
    );
    expect(rounds).toBeLessThan(60); // pre-fix: exponential to 30 min (about a dozen tries in an hour)
  }, 120_000);
});

describe("RR-H: recovery inside two contexts at once (sanity: expected to pass)", () => {
  it("a worker round and the popup's open race over a torn slot; the popup commits an edit in between: nothing lost", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("X");
    expect((await a.engine.round()).status).toBe("ok");
    tearActive(a);
    const popup = secondContext(a);
    const worker = a.ctx;
    const orig = worker.flows.current.bind(worker.flows);
    let armed = true;
    worker.flows.current = async () => {
      if (armed) {
        armed = false;
        await popup.svc.status(); // the popup's open recovers first
        await popup.svc.mutate((v, c, now) => v); // a no-op save
      }
      return orig();
    };
    const r = await worker.engine.round();
    worker.flows.current = orig;
    await quiesce(w);
    console.log(
      "RR-H",
      JSON.stringify({
        round: r.status,
        a: (await names(a, vk)).includes("X"),
        b: (await names(b, vk)).includes("X"),
        head: (await headNames(w, vk)).includes("X"),
      }),
    );
    expect((await names(b, vk)).includes("X")).toBe(true);
  }, 60_000);

  it("both slots torn: the recovery from the rolling snapshot inside the worker's round load pulls and merges first", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("X2");
    expect((await a.engine.round()).status).toBe("ok");
    for (const s of ["a", "b"] as const) a.disk.kv.data.set(KEYS.slot[s], tear(a.disk.kv.data.get(KEYS.slot[s])));
    a.restartWorker();
    const r = await a.engine.round();
    await quiesce(w);
    console.log(
      "RR-H2",
      JSON.stringify({
        round: r.status,
        pulled: r.pulled,
        b: (await names(b, vk)).includes("X2"),
        ls: lastSyncedOf(a.disk.kv.data.get(SYNC_KEYS.state)) !== null,
      }),
    );
    expect((await names(b, vk)).includes("X2")).toBe(true);
  }, 60_000);
});

describe("RR-I: M3R-9 with the old identity revoked (not unknown)", () => {
  it("complete landed with its answer lost, the new device revoked from another device: a new join goes ahead", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
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
    const nid = ((await n.local.identity.get()) as { deviceId: string }).deviceId;
    const { revokeDevice } = await import("../../src/core/sync/engine/keys");
    await revokeDevice(a.engine, nid, w.password); // the owner sees an unknown "N" in the list and revokes it
    const r = await n.engine.round();
    const e = await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
    }).then(
      () => null,
      (x) => x,
    );
    console.log("RR-I", JSON.stringify({ round: r.status, rejoin: e?.code ?? "ok" }));
    expect(e).toBeNull();
  }, 60_000);
});

describe("RR-H3: a tear and the popup's recovery between the worker round's state read and its PUT (sanity)", () => {
  it("the worker uploads the newer generation it loaded; the CAS fails; the next rounds merge everything", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("X3 synced");
    expect((await a.engine.round()).status).toBe("ok");
    w.advance(1000);
    await a.add("Y3 dirty");
    const popup = secondContext(a);
    const worker = a.ctx;
    const orig = worker.engine.state.read.bind(worker.engine.state);
    let n = 0;
    worker.engine.state.read = async () => {
      const v = await orig();
      if (n++ === 0) {
        tearActive(a);
        await popup.svc.status(); // the popup recovers (D1 hook) ...
        w.advance(1000);
        await popup.svc.mutate((v0, c, now) => v0); // and opens; nothing else
      }
      return v;
    };
    const r = await worker.engine.round();
    worker.engine.state.read = orig;
    await quiesce(w);
    console.log("RR-H3", JSON.stringify({ round: r.status, uploaded: r.uploaded, b: await names(b, vk) }));
    expect(await names(b, vk)).toEqual(expect.arrayContaining(["X3 synced", "Y3 dirty"]));
  }, 60_000);
});

describe("RR-J: a fresh engine whose round stops in the prelude keeps the stored server offset", () => {
  it("identity_missing (locked) after a worker restart: sk_sync_state.serverOffsetMs is not reset to 0", async () => {
    const w = await worldOf(2, ["GitHub"], [0, 2 * 86_400_000]);
    const [, b] = w.devices as [Device, Device];
    await b.engine.round();
    const off0 = (b.disk.kv.data.get(SYNC_KEYS.state) as { serverOffsetMs?: number }).serverOffsetMs ?? 0;
    await b.lockNow();
    b.disk.idb.data.clear(); // IndexedDB wiped (the identity gone): identity_missing until unlocked
    b.restartWorker();
    const r = await b.engine.round();
    const off1 = (b.disk.kv.data.get(SYNC_KEYS.state) as { serverOffsetMs?: number }).serverOffsetMs ?? 0;
    const r2 = await b.engine.push();
    const off2 = (b.disk.kv.data.get(SYNC_KEYS.state) as { serverOffsetMs?: number }).serverOffsetMs ?? 0;
    console.log(
      "RR-J",
      JSON.stringify({
        off0h: Math.round(off0 / 3.6e6),
        round: r.status,
        off1h: Math.round(off1 / 3.6e6),
        push: r2.status,
        off2h: Math.round(off2 / 3.6e6),
      }),
    );
    expect(Math.abs(off0)).toBeGreaterThan(86_400_000);
    expect(off1).toBe(off0);
  }, 60_000);
});

describe("RR-K: a persistent 403 write_denied (M3R-14 treats it as a conflict)", () => {
  it("one round sends the full envelope at most twice when nothing about the key moved", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    w.advance(1000);
    await a.add("pending");
    w.server.fault({ match: "PUT /v1/vault", kind: "status", status: 403, code: "write_denied", count: 100 });
    const before = w.server.requests.filter((r) => r.op === "PUT /v1/vault").length;
    const r = await a.engine.round();
    const puts = w.server.requests.filter((r) => r.op === "PUT /v1/vault").length - before;
    console.log(
      "RR-K",
      JSON.stringify({ round: r.status, error: r.error, puts, failures: (await a.engine.view()).state.failures }),
    );
    expect(puts).toBeLessThanOrEqual(2);
  }, 60_000);
});
