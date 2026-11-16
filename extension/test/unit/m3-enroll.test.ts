// M3, turning sync on and joining through the engine and the FakeServer (SYNC-DESIGN §3.1, §3.2, §3.3, §3.5, §2.5, §3.10,
// §4.10, §8.3): the approval with the pairing code and the SAS driving M1's machines, the first upload's RR-12 check and D4's lost answers,
// §2.5's combinations (IndexedDB wiped at every start, storage.local wiped, cfg_missing), a revoked device, an old client,
// clones and their cursor, and a clock the server refuses.
import { describe, expect, it } from "vitest";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import {
  Approver,
  ApprovalJoin,
  commitJoin,
  firstUpload,
  joinWithRecoveryCode,
  resumeFirstUpload,
} from "../../src/core/sync/engine/enroll";
import { adoptWithSecret, revokeDevice } from "../../src/core/sync/engine/keys";
import { aliveEntries } from "../../src/core/vault/model";
import { formatPairingCode } from "../../src/core/crypto/pairing-code";
import { createProtected } from "../helpers/vaults";
import {
  cj,
  cloneDisk,
  contextOver,
  EMAIL,
  firstDevice,
  joinDevice,
  newDisk,
  quiesce,
  type Device,
  World,
  worldOf,
} from "../helpers/m3-world";

const ops = (w: World, from = 0) => w.server.requests.slice(from).map((r) => r.op);
const rows = (w: World) => w.server.state(EMAIL).devices;

describe("§3.2 approval (enrolment v2): the pairing code from the approver to the new device, the SAS back (M1's machines over the signed API)", () => {
  it("end to end: the new device joins, completes and pulls; its row says approval, approved_by the approver", async () => {
    const w = await worldOf(1, ["GitHub", "AWS"]);
    const a = w.devices[0]!;
    const n = w.device("N");
    const join = await ApprovalJoin.start(n.engine, {
      session: await w.server.session(EMAIL),
      deviceName: "New laptop",
      email: EMAIL,
    });
    expect((await join.poll()).kind).toBe("waiting");
    const list = await Approver.list(a.engine);
    expect(list.map((r) => r.request_id)).toEqual([join.requestId]);
    const approver = await Approver.start(a.engine, join.requestId, w.password);
    expect(await join.poll()).toEqual({ kind: "enter_code" }); // no reveal, no SAS before the code (MUST 10)
    expect(w.server.requests.some((r) => r.op === "POST /v1/enroll/requests/{rid}/reveal")).toBe(false);
    const sas = await join.submitPairingCode(approver.pairingCode);
    expect(sas.kind).toBe("show_sas");
    expect(w.server.requests.filter((r) => r.op === "POST /v1/enroll/requests/{rid}/reveal")).toHaveLength(1);
    const step = await approver.poll(w.password);
    expect(step).toMatchObject({ kind: "enter_sas", claimedName: "New laptop" });
    expect(() => approver.pairingCode).toThrow(); // off the approver once the new device revealed
    const ok = await approver.submitSas((sas as { sas: string }).sas, w.password);
    expect(ok).toEqual({ kind: "approved" });
    expect(await join.poll()).toEqual({ kind: "approved" });
    expect(n.disk.kv.data.has(SYNC_KEYS.cfg)).toBe(false); // nothing written before commitJoin
    const plan = await join.prepare();
    expect(n.disk.kv.data.has(SYNC_KEYS.cfg)).toBe(false);
    expect(await commitJoin(plan)).toBe("enrolled");
    const row = rows(w).find((d) => d.joined_via === "approval")!;
    expect(row.approved_by).toBe(((await a.local.settlePins()) as { deviceId: string }).deviceId);
    await n.engine.round();
    expect(
      aliveEntries(await n.vault())
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["AWS", "GitHub"]);
    expect(w.server.violations).toEqual([]);
  });
  it("a malformed code or wrong check bits: said on the new device, nothing sent, the request untouched", async () => {
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
    const before = w.server.requests.length;
    expect(await join.submitPairingCode("ABCD-EFGH")).toEqual({ kind: "malformed" });
    expect(await join.submitPairingCode(w.code)).toEqual({ kind: "wrong_code" }); // the recovery code: other check bits
    expect(w.server.requests.length).toBe(before); // no request at all: no oracle, no attempt counted
    expect(await join.poll()).toEqual({ kind: "enter_code" });
    expect((await join.submitPairingCode(approver.pairingCode)).kind).toBe("show_sas");
  });
  it("a payload that does not open under the key holding the code: bad_payload, the request rejected, the pending identity removed, nothing written", async () => {
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
    expect(await approver.submitSas(sas.sas, w.password)).toEqual({ kind: "approved" });
    // the server swaps the payload for one it made (it does not know the pairing code)
    const e = Object.values(w.server.db.enrollments)[0]!;
    e.payload = Buffer.from(crypto.getRandomValues(new Uint8Array(400))).toString("base64");
    expect(await join.poll()).toEqual({ kind: "failed", reason: "bad_payload" });
    expect(n.disk.idb.data.size).toBe(0);
    expect([...n.disk.kv.data.keys()].filter((k) => k.startsWith("sk_sync") || k.startsWith("sk_slot"))).toEqual([]);
    expect(w.server.state(EMAIL).enrollments).toEqual([]);
    expect(ops(w).filter((o) => o === "POST /v1/enroll/requests/{rid}/reject")).toHaveLength(1);
  });
  it("a code past the check bits that is another code: the approver ends it (pairing_mismatch) and rejects; the new device sees only an end", async () => {
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
    const other = await formatPairingCode(crypto.getRandomValues(new Uint8Array(16)));
    expect((await join.submitPairingCode(other)).kind).toBe("show_sas");
    expect(await approver.poll(w.password)).toEqual({ kind: "failed", reason: "pairing_mismatch" });
    expect(w.server.state(EMAIL).enrollments).toEqual([]); // rejected with pw_auth
    expect(await join.poll()).toEqual({ kind: "failed", reason: "gone" });
  });
  it("three wrong SAS on the approver: the request is void (rejected)", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const n = w.device("N");
    const join = await ApprovalJoin.start(n.engine, {
      session: await w.server.session(EMAIL),
      deviceName: "N",
      email: EMAIL,
    });
    const approver = await Approver.start(w.devices[0]!.engine, join.requestId, w.password);
    await join.poll();
    const sas = (await join.submitPairingCode(approver.pairingCode)) as { sas: string };
    await approver.poll(w.password);
    const wrong = sas.sas === "000000" ? "111111" : "000000";
    await approver.submitSas(wrong, w.password);
    await approver.submitSas(wrong, w.password);
    expect(await approver.submitSas(wrong, w.password)).toMatchObject({ kind: "failed", reason: "sas_mismatch" });
    expect(w.server.state(EMAIL).enrollments).toEqual([]);
    expect((await join.poll()).kind).toBe("failed");
  });
});

describe("§3.1 the first upload: RR-12 and D4", () => {
  it("RR-12: a Phase 0 key operation in another tab between the truncation and step 5 stops it before init; the local half undone", async () => {
    const w = new World();
    const a = w.device("A");
    w.code = (await createProtected(a.svc, w.password)).recoveryCode;
    const put = a.local.identity.put.bind(a.local.identity);
    a.local.identity.put = async (id) => {
      // another tab, before sk_sync_cfg exists: not refused, and it leaves the keyring unaligned
      w.advance(1234);
      await a.svc.changePassword(w.password, "another-strong-pass-77");
      return put(id);
    };
    const n0 = w.server.requests.length;
    const r = await firstUpload(a.engine, {
      session: await w.server.session(EMAIL),
      password: w.password,
      recoveryCode: w.code,
      deviceName: "A",
      email: EMAIL,
    });
    expect(r).toEqual({ kind: "keyring_changed" });
    expect(ops(w, n0)).not.toContain("POST /v1/vault/init");
    expect(a.disk.kv.data.has(SYNC_KEYS.cfg)).toBe(false);
    expect(a.disk.idb.data.size).toBe(0);
  });
  it("D4: init's answer lost: the identical text again is the same 201; one device row", async () => {
    const w = new World();
    w.server.fault({ match: "POST /v1/vault/init", kind: "after" });
    await firstDevice(w, ["GitHub"]);
    expect(rows(w).length).toBe(1);
    expect(w.server.requests.filter((r) => r.op === "POST /v1/vault/init").map((r) => r.status)).toEqual(["lost", 201]);
  });
  it("D4: every answer lost (the page then closed): unconfirmed; the signed status query later says it exists and the round pins it in sync", async () => {
    const w = new World();
    const a = w.device("A");
    w.code = (await createProtected(a.svc, w.password)).recoveryCode;
    await a.svc.openView();
    w.server.fault({ match: "POST /v1/vault/init", kind: "after", count: 3 });
    const r = await firstUpload(a.engine, {
      session: await w.server.session(EMAIL),
      password: w.password,
      recoveryCode: w.code,
      deviceName: "A",
      email: EMAIL,
    });
    expect(r).toEqual({ kind: "unconfirmed" });
    expect(await resumeFirstUpload(a.engine)).toBe("created");
    const rr = await a.engine.round();
    expect(rr.status).toBe("ok");
    const id = await a.local.settlePins();
    expect(id).toMatchObject({ state: "enrolled", maxSeenKver: 1 });
    expect((id as { adopted: unknown }).adopted).not.toBeNull();
    expect(rows(w).length).toBe(1);
  });
  it("409 vault_exists (another device made this account's vault first): not ours, so the local half is undone and the join path offered", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const b = w.device("B");
    w.code = w.code; // B has its own vault
    const own = (await createProtected(b.svc, "another-strong-pass-77")).recoveryCode;
    await b.svc.openView();
    // the account check said "no vault" when B started (a race): the server answers init with 409
    w.server.fault({ match: "GET /v1/account", kind: "status", status: 200, code: "x" } as never);
    w.server.clearFaults();
    const session = await w.server.session(EMAIL);
    const acct = b.engine.api.account.bind(b.engine.api);
    b.engine.api.account = async (s) => ({ ...(await acct(s)), has_vault: false });
    const r = await firstUpload(b.engine, {
      session,
      password: "another-strong-pass-77",
      recoveryCode: own,
      deviceName: "B",
      email: EMAIL,
    });
    expect(r).toEqual({ kind: "vault_exists" });
    expect(b.disk.kv.data.has(SYNC_KEYS.cfg)).toBe(false);
    expect(rows(w).length).toBe(1);
  });
});

describe("§3.3 the recovery-code join: a lost complete", () => {
  it("complete's answer lost three times: unconfirmed; the next round's signed status query confirms it; no second device row", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const n = w.device("N");
    w.server.fault({ match: "POST /v1/enroll/requests/{rid}/complete", kind: "after", count: 3 });
    const plan = await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
    });
    expect(await commitJoin(plan)).toBe("unconfirmed");
    expect(((await n.local.settlePins()) as { state: string }).state).toBe("pending");
    expect((await n.engine.round()).status).toBe("ok");
    expect(((await n.local.settlePins()) as { state: string }).state).toBe("enrolled");
    expect((n.disk.kv.data.get(SYNC_KEYS.cfg) as { state: string }).state).toBe("enrolled");
    expect(rows(w).length).toBe(2);
  });
});

describe("§2.5 the four combinations", () => {
  it("IndexedDB deleted before every start (GoLogin): restored from its copy after unlock, no new device row, no approval; locked: nothing signed", async () => {
    const { w, b } = await (async () => {
      const w = await worldOf(2, ["GitHub"]);
      return { w, b: w.devices[1]! };
    })();
    for (let i = 0; i < 3; i++) {
      b.disk.idb.data.clear();
      await b.restartBrowser(); // locked
      const n0 = w.server.requests.length;
      expect((await b.engine.round()).status).toBe("identity_missing");
      expect(w.server.requests.length).toBe(n0); // nothing signed, nothing pushed
      await b.unlock();
      expect((await b.engine.round()).status).toBe("ok");
      expect(rows(w).length).toBe(2);
      expect(w.server.state(EMAIL).enrollments).toEqual([]); // no enrolment, no approval asked for
    }
  });
  it("storage.local wiped, IndexedDB (the identity and the mirror) kept… and the mirror too: the cloud restore (§4.13) with the pins guarding it", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const b = w.devices[1]!;
    b.disk.kv.data.clear();
    b.disk.mirror.data.clear();
    await b.restartBrowser();
    expect((await b.engine.round()).status).toBe("cloud_restore");
    const r = await adoptWithSecret(b.engine, { password: w.password });
    expect(r).toEqual({ kind: "adopted", sameVk: false });
    expect(
      aliveEntries(await b.vault())
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["AWS", "GitHub"]);
  });
  it("cfg_missing with a readable vault (an unfinished turn-off): finished, never a round or a signature", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const b = w.devices[1]!;
    b.disk.kv.data.delete(SYNC_KEYS.cfg);
    b.restartWorker();
    const n0 = w.server.requests.length;
    expect((await b.engine.round()).status).toBe("off");
    expect(w.server.requests.length).toBe(n0);
    expect(b.disk.idb.data.size).toBe(0);
    expect((await b.engine.round()).status).toBe("off");
  });
  it("identity and storage.local both lost: a new enrolment; the old device id can be revoked with pw_auth (no rows pile up)", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a, b] = w.devices as [Device, Device];
    const oldId = ((await b.local.settlePins()) as { deviceId: string }).deviceId;
    b.disk.kv.data.clear();
    b.disk.mirror.data.clear();
    b.disk.idb.data.clear();
    b.restartWorker();
    expect((await b.engine.round()).status).toBe("off");
    const b2 = await joinDevice(w, "B2", { disk: b.disk });
    await revokeDevice(a.engine, oldId, w.password);
    expect(rows(w).filter((d) => !d.revoked_at).length).toBe(2);
    await b2.engine.round();
  });
});

describe("§3.10 P5: rejected by the server", () => {
  it("revoked: the identity is marked, never deleted, the local data kept; one retry a day; an explicit retry after an honest rollback brings it back", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a, b] = w.devices as [Device, Device];
    const snap = w.server.snapshot();
    const bid = ((await b.local.settlePins()) as { deviceId: string }).deviceId;
    await revokeDevice(a.engine, bid, w.password);
    expect((await b.engine.round()).status).toBe("rejected_by_server");
    expect(((await b.local.settlePins()) as { state: string }).state).toBe("rejected_by_server");
    expect((b.disk.kv.data.get(SYNC_KEYS.cfg) as { state: string }).state).toBe("rejected_by_server");
    expect(aliveEntries(await b.vault()).length).toBe(1);
    const n0 = w.server.requests.length;
    w.advance(3_600_000);
    expect((await b.engine.round()).status).toBe("rejected_by_server");
    expect(w.server.requests.length).toBe(n0); // not before a day has passed
    w.server.restore(snap); // the server went back to before the revocation
    await b.unlock(); // an hour idle: the session ended
    expect((await b.engine.round({ explicit: true })).status).toBe("ok");
    expect(((await b.local.settlePins()) as { state: string }).state).toBe("enrolled");
  });
});

describe("§5.2 d6: min_client_version", () => {
  it("an old client stops all reads and writes (update_required)", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    w.server.minClientVersion = "0.1.1";
    w.advance(1000);
    await a.add("pending");
    const n0 = w.server.requests.length;
    expect((await a.engine.round()).status).toBe("update_required");
    expect(ops(w, n0)).toEqual(["GET /v1/sync/status"]);
  });
  it("M4's default minimum (0.1.0) against the manifest's version (0.0.1): every round stops (the review's D1, M5's configuration item)", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const manifest = JSON.parse(
      (await import("node:fs")).readFileSync(new URL("../../manifest.base.json", import.meta.url), "utf8"),
    ).version as string;
    const a = w.devices[0]!;
    const old = contextOver({
      ...a.disk,
      lock: a.lock,
      identityLock: a.identityLock,
      syncLock: a.syncLock,
      transport: a.net,
      clock: a.now,
      clientVersion: manifest,
    });
    expect(w.server.minClientVersion).toBe("0.1.0");
    expect((await old.engine.round()).status).toBe(manifest === "0.0.1" ? "update_required" : "ok");
  });
});

describe("§4.10 clones (d3): the cursor travels with writes only", () => {
  it("a profile copied with its storage: both write; the second writer is told forked; a read-only copy never is", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    await a.engine.round();
    w.advance(1000);
    await a.add("before the copy");
    await a.engine.round(); // A has a cursor now
    const copy = w.device("A-copy", cloneDisk(a.disk));
    const reader = w.device("A-reader", cloneDisk(a.disk));
    w.advance(1000);
    await a.add("A writes");
    await a.engine.round();
    expect((await a.engine.view()).state.notices?.some((n) => n.kind === "forked") ?? false).toBe(false);
    await copy.add("the copy writes");
    await copy.engine.round();
    expect((await copy.engine.view()).state.notices?.some((n) => n.kind === "forked")).toBe(true);
    await reader.engine.round();
    expect((await reader.engine.view()).state.notices?.some((n) => n.kind === "forked") ?? false).toBe(false);
  });
  it("a single crash (the pending value written, the answer lost) is not a clone; status polls carry no cursor and change none", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    w.advance(1000);
    await a.add("x");
    w.server.fault({ match: "PUT /v1/vault", kind: "after" });
    await a.engine.round(); // the PUT landed, its answer was lost
    const cur0 = structuredClone(w.server.state(EMAIL).devices[0]!.cursor);
    for (let i = 0; i < 3; i++) await a.engine.round();
    expect(w.server.state(EMAIL).devices[0]!.cursor).toEqual(cur0); // status polls change nothing
    w.advance(1000);
    await a.add("y");
    await a.engine.round();
    expect((await a.engine.view()).state.notices?.some((n) => n.kind === "forked") ?? false).toBe(false);
    expect(w.server.violations).toEqual([]); // no Sixkey-Cursor header, ever
  });
  it("a page's round and the worker's outbox push in one profile at once: serialized by sixkey-sync, never a false fork", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    w.advance(1000);
    await a.add("x");
    const page = a.ctx;
    a.restartWorker();
    const worker = a.ctx;
    const [r1, r2] = await Promise.all([page.engine.round(), worker.engine.push()]);
    expect([r1.status, r2.status].sort()).toEqual(["busy", "ok"].sort());
    await page.engine.round();
    expect((await page.engine.view()).state.notices?.some((n) => n.kind === "forked") ?? false).toBe(false);
  });
});

describe("§4.14: 401 clock_skew", () => {
  it("a device 10 minutes off before it knows the offset: the server's time is adopted and the request retried once", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const b = await joinDevice(w, "B");
    b.skewMs = 10 * 60_000;
    b.restartWorker();
    // forget the stored offset (as if never measured)
    const st = b.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>;
    b.disk.kv.data.set(SYNC_KEYS.state, { ...st, serverOffsetMs: 0 });
    expect((await b.engine.round()).status).toBe("ok");
    expect(w.server.requests.filter((r) => r.status === 401).length).toBe(1);
    expect(cj(await b.vault())).toBe(cj(await w.devices[0]!.vault()));
  });
});

describe("§3.5 a rejoin after a crash before complete", () => {
  it("the local half written, complete never sent: a second join merges (the same vault and key), nothing lost", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const n = w.device("N");
    w.server.fault({ match: "POST /v1/enroll/requests/{rid}/complete", kind: "throw", count: 3 });
    const plan = await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
    });
    expect(await commitJoin(plan)).toBe("unconfirmed");
    w.advance(1000);
    await n.add("made before complete");
    // the user turns it off and joins again ("joining not finished")
    await n.flows.turnOffSync();
    const plan2 = await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
    });
    expect(plan2.prepared.mode).toBe("merged");
    expect(await commitJoin(plan2)).toBe("enrolled");
    await quiesce(w);
    expect(
      aliveEntries(await w.devices[0]!.vault())
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["GitHub", "made before complete"]);
  });
});

export { newDisk };
