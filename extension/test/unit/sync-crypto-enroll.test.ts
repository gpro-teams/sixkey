// M1: the two enrollment state machines (§3.2; enrolment v2, revision 27) with fresh random keys: the honest flow,
// every MUST rule as a transition the machines refuse, the pairing code's local checks (MUST 10), and the bodies they
// produce against the OpenAPI request schemas.
import { describe, expect, it } from "vitest";
import { bs, fromB64, toB64, utf8 } from "../../src/core/crypto/bytes";
import { formatPairingCode, parsePairingCode } from "../../src/core/crypto/pairing-code";
import { formatRecoveryCode } from "../../src/core/crypto/recovery-code";
import { generateDeviceKey, newDeviceId } from "../../src/core/sync/crypto/device-key";
import { ApproverEnrollment, type ApproverView } from "../../src/core/sync/crypto/enroll-approver";
import {
  commitment,
  enrollKey,
  payloadText,
  sealPayload,
  sharedSecret,
  transcriptHash,
} from "../../src/core/sync/crypto/enroll-crypto";
import { ENROLL_TAG as TAG } from "../../src/core/sync/crypto/enroll-labels";
import { NewDeviceEnrollment } from "../../src/core/sync/crypto/enroll-new-device";
import { toB64u } from "../../src/core/sync/crypto/encoding";
import { importEpk, generateEphemeral } from "../../src/core/sync/crypto/device-key";
// A reflected approver key (A's own epk handed back as N's) is in sync-crypto-adversary.test.ts.
import { startApproval, startNewDeviceEnrollment } from "../../src/core/sync/crypto";
import { findOperation, requestSchema, validate } from "../helpers/contract";
import { C, F, G, VK1_RAW, VK2_RAW, verifiedFor, vk } from "../helpers/sync-vectors";
import { preSendCheck, type VerifiedServerBundle } from "../../src/core/sync/crypto/presend";
import { parseBundleText } from "../../src/core/sync/crypto/keybundle";

const NAME = "Laptop · 工作";
const PW_AUTH = G.password_auth.cases[0].password_auth_b64;
const schemaErrors = (operation: string, body: object) =>
  validate(requestSchema(findOperation(C.openapi, operation)), body, C.openapi, operation);

/** Every way S could be written down: raw, hex, both base64s, the code with and without its hyphens. */
async function formsOf(s: Uint8Array): Promise<string[]> {
  const code = await formatPairingCode(s);
  const hex = Array.from(s, (b) => b.toString(16).padStart(2, "0")).join("");
  return [hex, toB64(s), toB64u(s), code, code.replace(/-/g, "")];
}

async function session() {
  const dk = await generateDeviceKey();
  const devN = newDeviceId();
  const devA = newDeviceId();
  const rid = crypto.randomUUID();
  const { machine: n, request } = await startNewDeviceEnrollment({ deviceId: devN, dpk: dk.spki, name: NAME });
  n.requestCreated(rid);
  const pending: ApproverView = {
    state: "pending",
    new_device_id: devN,
    new_sig_pubkey: request.sig_pubkey,
    commit: request.commit,
  };
  const seam = crypto.getRandomValues(new Uint8Array(16)); // S, through the test seam: the machine owns and wipes it
  const secret = seam.slice();
  const { machine: a, respond } = await ApproverEnrollment.start(
    { approverId: devA, rid, request: pending, verified: await verifiedFor("respond") },
    { pairingSecret: seam },
  );
  const shown = a.respondAccepted();
  if (shown.kind !== "show_code") throw new Error("no code");
  const responded = { state: "responded", approver_device_id: devA, approver_epk: respond.epk };
  return { n, a, devN, devA, rid, dk, request, pending, respond, responded, code: shown.code, secret, seam };
}

async function toReveal() {
  const s = await session();
  expect(await s.n.onPoll(s.responded)).toEqual({ kind: "enter_code" });
  const step = await s.n.submitPairingCode(s.code);
  if (step.kind !== "reveal") throw new Error("no reveal");
  const revealed: ApproverView = {
    ...s.pending,
    state: "revealed",
    new_epk: step.body.epk,
    new_nonce: step.body.nonce,
    new_name_ct: step.body.name_ct,
  };
  return { ...s, reveal: step, revealed };
}

async function toApproved() {
  const s = await toReveal();
  expect(await s.a.onPoll(s.revealed)).toEqual({ kind: "enter_sas", claimedName: NAME });
  expect(await s.a.submitSas(s.reveal.sas)).toEqual({ kind: "matched" });
  const built = await s.a.buildApproval({ verified: await verifiedFor("approve"), now: Date.UTC(2026, 9, 16) });
  if (built.kind !== "approve") throw new Error("no approve body");
  const approve = built.body;
  expect(await s.a.approveAccepted()).toEqual({ kind: "approved" });
  const approved = { ...s.responded, state: "approved", payload: approve.payload };
  return { ...s, approve, approved };
}

describe("honest enrollment with fresh keys", () => {
  it("runs to the end on both sides; every body matches its OpenAPI request schema; none holds S in any form", async () => {
    const s = await toApproved();
    expect(schemaErrors("POST /v1/enroll/requests", s.request)).toEqual([]);
    expect(schemaErrors("POST /v1/enroll/requests/{rid}/respond", { ...s.respond, password_auth: PW_AUTH })).toEqual(
      [],
    );
    expect(schemaErrors("POST /v1/enroll/requests/{rid}/reveal", s.reveal.body)).toEqual([]);
    expect(schemaErrors("POST /v1/enroll/requests/{rid}/approve", { ...s.approve, password_auth: PW_AUTH })).toEqual(
      [],
    );
    expect(Object.keys(s.respond)).toEqual(["epk"]); // MUST 5: respond carries epk_A only
    const wire = JSON.stringify([s.request, s.respond, s.reveal.body, s.approve]);
    for (const f of await formsOf(s.secret)) expect(wire.includes(f), f).toBe(false);
    expect(fromB64(s.reveal.body.name_ct).length).toBe(188);
    const done = await s.n.onPoll(s.approved);
    expect(done.kind).toBe("accepted");
    if (done.kind === "accepted")
      expect([done.keys.vk.id, done.keys.approver, done.keys.bundleRaw]).toEqual([
        (await vk(VK1_RAW)).id,
        s.devA,
        G.keybundle.raw,
      ]);
    expect([s.n.phase, s.a.phase]).toEqual(["accepted", "approved"]);
    expect(await s.n.onPoll(s.approved)).toEqual({ kind: "wait" });
  });
  it("the transitions are the only ones: no restart, no way to re-create a request (MUST 3), no confirmation code", () => {
    expect(Object.getOwnPropertyNames(NewDeviceEnrollment.prototype).sort()).toEqual([
      "abort",
      "constructor",
      "failure",
      "onPoll",
      "phase",
      "requestCreated",
      "revealBody",
      "sas",
      "submitPairingCode",
    ]);
    expect(Object.getOwnPropertyNames(ApproverEnrollment.prototype).sort()).toEqual([
      "abort",
      "approveAccepted",
      "approveBody",
      "approveRefused",
      "buildApproval",
      "constructor",
      "failure",
      "onPoll",
      "pairingCode",
      "phase",
      "respondAccepted",
      "submitSas",
    ]);
  });
  it("ephemeral and signing private keys are non-extractable", async () => {
    expect((await generateEphemeral()).privateKey.extractable).toBe(false);
    expect((await generateDeviceKey()).privateKey.extractable).toBe(false);
  });
  it("enrollKey wipes Z and S (and refuses the wrong lengths, wiping them too)", async () => {
    const z = crypto.getRandomValues(new Uint8Array(32));
    const s = crypto.getRandomValues(new Uint8Array(16));
    await enrollKey(z, s, new Uint8Array(32));
    expect([z.every((b) => b === 0), s.every((b) => b === 0)]).toEqual([true, true]);
    const z2 = crypto.getRandomValues(new Uint8Array(32));
    const short = crypto.getRandomValues(new Uint8Array(15));
    await expect(enrollKey(z2, short, new Uint8Array(32))).rejects.toMatchObject({ code: "invalid_argument" });
    expect([z2.every((b) => b === 0), short.every((b) => b === 0)]).toEqual([true, true]);
  });
});

describe("new device: MUST 2, 3, 5, 6, 10", () => {
  it("(devA, epk_A) are pinned at the first responded; nothing is revealed and no SAS exists before the code is typed", async () => {
    const s = await session();
    expect(await s.n.onPoll(s.responded)).toEqual({ kind: "enter_code" });
    expect([s.n.phase, s.n.sas, s.n.revealBody]).toEqual(["entering_code", null, null]);
    for (let i = 0; i < 3; i++) expect(await s.n.onPoll(s.responded)).toEqual({ kind: "wait" }); // still no reveal
    expect([s.n.sas, s.n.revealBody]).toEqual([null, null]);
    const other = toB64((await generateEphemeral()).raw);
    expect(await s.n.onPoll({ ...s.responded, approver_epk: other })).toEqual({ kind: "failed", reason: "tampered" });
    const t = await session();
    await t.n.onPoll(t.responded);
    expect(await t.n.onPoll({ ...t.responded, approver_device_id: newDeviceId() })).toEqual({
      kind: "failed",
      reason: "tampered",
    });
  });
  it("after the reveal the SAS is the one computed once; any later change aborts", async () => {
    const s = await toReveal();
    expect(await s.n.onPoll(s.responded)).toEqual({ kind: "wait" });
    expect(s.n.sas).toBe(s.reveal.sas);
    expect(s.n.revealBody).toEqual(s.reveal.body);
    const other = toB64((await generateEphemeral()).raw);
    expect(await s.n.onPoll({ ...s.responded, approver_epk: other })).toEqual({ kind: "failed", reason: "tampered" });
    expect([s.n.phase, s.n.sas, s.n.revealBody]).toEqual(["failed", null, null]);
  });
  it("a malformed code, wrong check bits or a recovery code change nothing and cost nothing, however often", async () => {
    const s = await session();
    await s.n.onPoll(s.responded);
    const flat = s.code.replace(/-/g, "");
    const typo = flat.slice(0, 5) + (flat[5] === "Z" ? "Y" : "Z") + flat.slice(6);
    const typoResult = await parsePairingCode(typo).then(
      () => "accepted",
      (e: { code: string }) => e.code,
    );
    const asRecovery = await formatRecoveryCode(s.secret);
    for (let i = 0; i < 5; i++) {
      expect(await s.n.submitPairingCode(flat.slice(0, 27))).toEqual({ kind: "malformed" });
      expect(await s.n.submitPairingCode(`${flat.slice(0, 27)}U`)).toEqual({ kind: "malformed" });
      expect(await s.n.submitPairingCode("")).toEqual({ kind: "malformed" });
      expect(await s.n.submitPairingCode(asRecovery)).toEqual({ kind: "wrong_code" }); // the check bits' domain
      if (typoResult === "pairing_checksum") expect(await s.n.submitPairingCode(typo)).toEqual({ kind: "wrong_code" });
    }
    expect([s.n.phase, s.n.failure, s.n.sas, s.n.revealBody]).toEqual(["entering_code", null, null, null]);
    expect(await s.n.onPoll(s.responded)).toEqual({ kind: "wait" });
    // the right code, pasted the way people paste it, still works
    const step = await s.n.submitPairingCode(`  ${s.code.toLowerCase().replace(/-/g, " ")}\n`);
    expect(step.kind).toBe("reveal");
    expect(s.n.phase).toBe("showing_sas");
  });
  it("the code step is the only way to the reveal: it is refused before responded and after the reveal", async () => {
    const s = await session();
    await expect(s.n.submitPairingCode(s.code)).rejects.toMatchObject({ code: "enroll_state" }); // waiting
    const t = await toReveal();
    await expect(t.n.submitPairingCode(t.code)).rejects.toMatchObject({ code: "enroll_state" }); // revealed already
    expect(t.n.revealBody).toEqual(t.reveal.body);
  });
  it("two transitions at once cannot run: two polls, or a poll and the code step", async () => {
    const s = await session();
    const results = await Promise.allSettled([s.n.onPoll(s.responded), s.n.onPoll(s.responded)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(s.n.phase).toBe("entering_code");
    const both = await Promise.allSettled([s.n.submitPairingCode(s.code), s.n.onPoll(s.responded)]);
    expect(both.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(s.n.phase).toBe("showing_sas");
  });
  it("states the server reports ahead of this side, reflected keys and malformed views abort", async () => {
    const s = await session();
    expect(await s.n.onPoll({ ...s.responded, state: "approved", payload: "AAAA" })).toEqual({
      kind: "failed",
      reason: "unexpected_state",
    });
    for (const state of ["revealed", "approved"]) {
      const t = await session();
      await t.n.onPoll(t.responded);
      expect(await t.n.onPoll({ ...t.responded, state, payload: "AAAA" }), state).toEqual({
        kind: "failed",
        reason: "unexpected_state", // this side has not revealed yet
      });
    }
    // reflection: the commitment hides epk_N until reveal, so inject it to play a server that somehow has it
    const eph = await generateEphemeral();
    const r = await NewDeviceEnrollment.start(
      { deviceId: newDeviceId(), dpk: (await generateDeviceKey()).spki, name: NAME },
      { ephemeral: eph },
    );
    r.machine.requestCreated(crypto.randomUUID());
    expect(
      await r.machine.onPoll({ state: "responded", approver_device_id: newDeviceId(), approver_epk: toB64(eph.raw) }),
    ).toEqual({ kind: "failed", reason: "reflected_key" });
    const u = await session();
    expect(await u.n.onPoll({ ...u.responded, approver_epk: "not base64" })).toEqual({
      kind: "failed",
      reason: "invalid_view",
    });
    const v = await startNewDeviceEnrollment({
      deviceId: newDeviceId(),
      dpk: (await generateDeviceKey()).spki,
      name: NAME,
    });
    v.machine.requestCreated("00000000-0000-4000-8000-00000000000A");
    expect(v.machine.failure).toBe("invalid_view");
    await expect(
      startNewDeviceEnrollment({ deviceId: newDeviceId(), dpk: (await generateDeviceKey()).spki, name: "a\u202Eb" }),
    ).rejects.toMatchObject({ code: "invalid_device_name" });
  });
  it("only a payload that opens under K (which holds S) is used: garbage or one sealed without S is bad_payload, terminal", async () => {
    const garbage = toB64(crypto.getRandomValues(new Uint8Array(200)));
    const s = await toReveal();
    expect(await s.n.onPoll({ ...s.responded, state: "approved", payload: garbage })).toEqual({
      kind: "failed",
      reason: "bad_payload",
    });
    expect(await s.n.onPoll({ ...s.responded, state: "approved", payload: garbage })).toEqual({
      kind: "failed",
      reason: "bad_payload",
    });
    // a well-formed payload under K' = HKDF(Z || S', h) with an S' the server made up: it never opens
    const t = await toReveal();
    const h = await transcriptHashOf(t);
    const v = await verifiedFor("approve");
    const forgedK = await enrollKey(
      new Uint8Array(32), // the server does not know Z either: any guess
      crypto.getRandomValues(new Uint8Array(16)),
      h,
    );
    const text = payloadText({ vaultId: F.vault_id, vk: v.vk, bundleRaw: v.raw, approver: t.devA, at: 1 });
    const forged = await sealPayload(forgedK, h, text);
    expect(await t.n.onPoll({ ...t.responded, state: "approved", payload: forged })).toEqual({
      kind: "failed",
      reason: "bad_payload",
    });
    expect([t.n.phase, t.n.sas, t.n.revealBody]).toEqual(["failed", null, null]);
  });
  it("a code that passes its check bits but is another S: the reveal goes out, and the approver ends it (pairing_mismatch)", async () => {
    const s = await session();
    await s.n.onPoll(s.responded);
    const otherCode = await formatPairingCode(crypto.getRandomValues(new Uint8Array(16)));
    const step = await s.n.submitPairingCode(otherCode);
    if (step.kind !== "reveal") throw new Error("no reveal");
    const revealed = {
      ...s.pending,
      state: "revealed",
      new_epk: step.body.epk,
      new_nonce: step.body.nonce,
      new_name_ct: step.body.name_ct,
    };
    expect(await s.a.onPoll(revealed)).toEqual({ kind: "failed", reason: "pairing_mismatch" });
    expect(await s.a.submitSas(step.sas)).toEqual({ kind: "failed", reason: "pairing_mismatch" }); // terminal
    expect(s.seam.every((b) => b === 0)).toBe(true);
  });
  it("abort ends the machine for good", async () => {
    const t = await toReveal();
    t.n.abort("expired");
    expect([t.n.phase, t.n.failure, t.n.sas]).toEqual(["failed", "expired", null]);
    expect(await t.n.onPoll(t.responded)).toEqual({ kind: "failed", reason: "expired" });
    const u = await session();
    await u.n.onPoll(u.responded);
    u.n.abort("cancelled");
    expect(await u.n.submitPairingCode(u.code)).toEqual({ kind: "failed", reason: "cancelled" });
  });
});

describe("approver: MUST 1, 4, 5, 10", () => {
  it("a request missing any pinned value, not pending, or naming the approver itself is refused before respond", async () => {
    const s = await session();
    const v = await verifiedFor("respond");
    for (const drop of ["new_device_id", "new_sig_pubkey", "commit"] as const) {
      const r = { ...s.pending };
      delete r[drop];
      await expect(
        startApproval({ approverId: s.devA, rid: s.rid, request: r, verified: v }),
        drop,
      ).rejects.toMatchObject({ code: "invalid_argument" });
    }
    await expect(
      startApproval({ approverId: s.devA, rid: s.rid, request: { ...s.pending, state: "responded" }, verified: v }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      startApproval({ approverId: s.devN, rid: s.rid, request: s.pending, verified: v }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      startApproval({ approverId: s.devA, rid: s.rid.toUpperCase(), request: s.pending, verified: v }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });
  it("the pairing code exists only from respond's acceptance to the reveal (MUST 5); S is then wiped", async () => {
    const pending = (await session()).pending;
    const seam = crypto.getRandomValues(new Uint8Array(16));
    const code = await formatPairingCode(seam);
    const { machine: a, respond } = await ApproverEnrollment.start(
      { approverId: newDeviceId(), rid: crypto.randomUUID(), request: pending, verified: await verifiedFor("respond") },
      { pairingSecret: seam },
    );
    expect(JSON.stringify(respond).includes(code.replace(/-/g, ""))).toBe(false);
    expect(a.phase).toBe("responding");
    expect(() => a.pairingCode).toThrow(expect.objectContaining({ code: "enroll_state" }));
    await expect(a.onPoll({ ...pending, state: "responded" })).rejects.toMatchObject({ code: "enroll_state" });
    expect(a.respondAccepted()).toEqual({ kind: "show_code", code });
    expect(a.pairingCode).toBe(code);
    expect(() => a.respondAccepted()).toThrow(expect.objectContaining({ code: "enroll_state" })); // once
    const s = await toReveal();
    expect(s.a.pairingCode).toBe(s.code);
    await s.a.onPoll(s.revealed);
    expect(() => s.a.pairingCode).toThrow(expect.objectContaining({ code: "enroll_state" })); // gone at the reveal
    expect(s.seam.every((b) => b === 0)).toBe(true);
  });
  it("every end before the reveal wipes S and takes the code away: a refused respond, a cancel, a tampered view", async () => {
    for (const end of ["respond_refused", "cancel", "tampered"] as const) {
      const s = await session();
      if (end === "respond_refused") {
        const fresh = crypto.getRandomValues(new Uint8Array(16));
        const r = await ApproverEnrollment.start(
          {
            approverId: s.devA,
            rid: s.rid,
            request: s.pending,
            verified: await verifiedFor("respond"),
          },
          { pairingSecret: fresh },
        );
        r.machine.abort("rejected"); // what enroll.ts does when respond fails
        expect(fresh.every((b) => b === 0)).toBe(true);
        expect(() => r.machine.pairingCode).toThrow();
        continue;
      }
      if (end === "cancel") s.a.abort("cancelled");
      else
        expect(await s.a.onPoll({ ...s.pending, commit: toB64(new Uint8Array(32)) })).toMatchObject({ kind: "failed" });
      expect(
        s.seam.every((b) => b === 0),
        end,
      ).toBe(true);
      expect(() => s.a.pairingCode, end).toThrow();
    }
  });
  it("(rid, devN, dpk_N, C) stay pinned: any change in a later poll aborts", async () => {
    const other = await session();
    for (const [k, v] of [
      ["commit", other.request.commit],
      ["new_sig_pubkey", other.request.sig_pubkey],
      ["new_device_id", other.devN],
    ] as const) {
      const s = await session();
      expect(await s.a.onPoll({ ...s.pending, [k]: v }), k).toEqual({ kind: "failed", reason: "tampered" });
    }
  });
  it("a reveal that does not open the pinned commitment is refused; identical duplicates are ignored; a different second reveal aborts", async () => {
    const s = await toReveal();
    const other = await toReveal();
    expect(await s.a.onPoll({ ...s.revealed, new_nonce: other.revealed.new_nonce })).toEqual({
      kind: "failed",
      reason: "commit_mismatch",
    });
    const t = await toReveal();
    await t.a.onPoll(t.revealed);
    expect(await t.a.onPoll(t.revealed)).toEqual({ kind: "wait" });
    expect(await t.a.onPoll({ ...t.revealed, new_name_ct: other.revealed.new_name_ct })).toEqual({
      kind: "failed",
      reason: "tampered",
    });
  });
  it("a reveal name that does not open under K (another S, or changed on the way) is pairing_mismatch, before any SAS", async () => {
    const s = await toReveal();
    const other = await toReveal();
    // the commitment opens (same epk and nonce), only the name ciphertext is another session's
    expect(await s.a.onPoll({ ...s.revealed, new_name_ct: other.revealed.new_name_ct })).toEqual({
      kind: "failed",
      reason: "pairing_mismatch",
    });
    await expect(s.a.buildApproval({ verified: await verifiedFor("approve"), now: 1 })).resolves.toEqual({
      kind: "failed",
      reason: "pairing_mismatch",
    });
  });
  it("three SAS attempts against the one SAS_A; a malformed one is free; then the request is void", async () => {
    const s = await toReveal();
    await s.a.onPoll(s.revealed);
    expect(await s.a.submitSas(wrong(s.reveal.sas))).toMatchObject({ kind: "retry", attemptsLeft: 2 });
    expect(await s.a.submitSas("abcdef")).toEqual({ kind: "malformed" });
    expect(await s.a.submitSas(s.reveal.sas)).toEqual({ kind: "matched" }); // the same SAS still counts on the second try
    const t = await toReveal();
    await t.a.onPoll(t.revealed);
    for (let i = 0; i < 2; i++) await t.a.submitSas(wrong(t.reveal.sas));
    expect(await t.a.submitSas(wrong(t.reveal.sas))).toEqual({ kind: "failed", reason: "sas_mismatch" });
    expect(await t.a.submitSas(t.reveal.sas)).toEqual({ kind: "failed", reason: "sas_mismatch" }); // terminal: the right SAS no longer helps
  });
  it("approve is built only after the SAS matched and from the approve check; a refused approve ends the request", async () => {
    const s = await toReveal();
    await s.a.onPoll(s.revealed);
    await expect(s.a.buildApproval({ verified: await verifiedFor("approve"), now: 1 })).rejects.toMatchObject({
      code: "enroll_state",
    });
    await s.a.submitSas(s.reveal.sas);
    await expect(s.a.buildApproval({ verified: await verifiedFor("respond"), now: 1 })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(s.a.phase).toBe("sas_ok"); // a caller error does not end the request
    const built = await s.a.buildApproval({ verified: await verifiedFor("approve"), now: 1 });
    expect(built.kind === "approve" && s.a.approveBody).toEqual(built.kind === "approve" && built.body);
    s.a.approveRefused();
    expect([s.a.phase, s.a.failure]).toEqual(["failed", "approve_refused"]);
    expect(await s.a.approveAccepted()).toEqual({ kind: "failed", reason: "approve_refused" });
  });
  it("the claimed name is checked again on the approver: a bidi name from a hostile new device that knows S is refused", async () => {
    const s = await session();
    // a hostile N: same commitment structure and the right S, but it encrypts a name the §2.4 rules reject
    const eph = await generateEphemeral();
    const nN = crypto.getRandomValues(new Uint8Array(32));
    const commit = await commitment(s.devN, s.dk.spki, eph.raw, nN);
    const pending = { ...s.pending, commit: toB64(commit) };
    const secret = crypto.getRandomValues(new Uint8Array(16));
    const { machine: a, respond } = await ApproverEnrollment.start(
      { approverId: s.devA, rid: s.rid, request: pending, verified: await verifiedFor("respond") },
      { pairingSecret: secret.slice() },
    );
    a.respondAccepted();
    const epkA = fromB64(respond.epk);
    const h = await transcriptHash({
      rid: s.rid,
      devN: s.devN,
      devA: s.devA,
      dpkN: s.dk.spki,
      epkN: eph.raw,
      epkA,
      nN,
    });
    const k = await enrollKey(await sharedSecret(eph.privateKey, await importEpk(epkA)), secret, h);
    const padded = new Uint8Array(160).fill(0x20);
    padded.set(utf8("evil\u202Etxt.exe"));
    const iv = new Uint8Array(12);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: bs(iv), additionalData: bs(utf8(TAG.enrollName + toB64u(h))) },
        k,
        bs(padded),
      ),
    );
    const wire = toB64(new Uint8Array([...iv, ...ct]));
    expect(
      await a.onPoll({
        ...pending,
        state: "revealed",
        new_epk: toB64(eph.raw),
        new_nonce: toB64(nN),
        new_name_ct: wire,
      }),
    ).toEqual({ kind: "failed", reason: "bad_name" });
  });
});

function wrong(code: string): string {
  return String((Number(code) + 1) % 1_000_000).padStart(6, "0");
}

async function transcriptHashOf(s: Awaited<ReturnType<typeof toReveal>>): Promise<Uint8Array> {
  return transcriptHash({
    rid: s.rid,
    devN: s.devN,
    devA: s.devA,
    dpkN: s.dk.spki,
    epkN: fromB64(s.reveal.body.epk),
    epkA: fromB64(s.respond.epk),
    nN: fromB64(s.reveal.body.nonce),
  });
}

describe("F-09: approval only from the pre-send check's VerifiedServerBundle", () => {
  it("start needs the respond check, buildApproval the approve check; copies, other ops and keys_behind objects are refused", async () => {
    const s = await session();
    const respond = await verifiedFor("respond");
    const approve = await verifiedFor("approve");
    const forged = { ...approve } as VerifiedServerBundle; // same fields, not issued by preSendCheck
    for (const bad of [
      approve,
      { ...respond } as VerifiedServerBundle,
      { ...respond, keysBehind: true } as VerifiedServerBundle,
    ]) {
      await expect(
        startApproval({ approverId: newDeviceId(), rid: crypto.randomUUID(), request: s.pending, verified: bad }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
    }
    const t = await toReveal();
    await t.a.onPoll(t.revealed);
    await t.a.submitSas(t.reveal.sas);
    for (const bad of [respond, forged])
      await expect(t.a.buildApproval({ verified: bad, now: 1 })).rejects.toMatchObject({ code: "invalid_argument" });
    expect(t.a.phase).toBe("sas_ok");
  });
  it("a VK change between the respond and approve checks ends the request (keys_changed), without a body", async () => {
    const g = G.rotate_repair;
    const b2 = parseBundleText(g.request.bundle);
    const r = await preSendCheck({
      op: "approve",
      serverRaw: g.request.bundle,
      secret: { recoveryCode: g.recovery_code2 },
      local: b2.keyring,
      vk: await vk(VK2_RAW),
      maxSeenKver: b2.kver,
      expectedVaultId: F.vault_id,
      adoptedAuth: b2.auth,
      adoptedDigest: null,
    });
    if (!r.ok) throw new Error(r.reason);
    const t = await toReveal();
    await t.a.onPoll(t.revealed);
    await t.a.submitSas(t.reveal.sas);
    expect(await t.a.buildApproval({ verified: r.verified, now: 1 })).toEqual({
      kind: "failed",
      reason: "keys_changed",
    });
    expect([t.a.phase, t.a.approveBody]).toEqual(["failed", null]);
    expect(await t.a.approveAccepted()).toEqual({ kind: "failed", reason: "keys_changed" });
  });
});

describe("F-10: the poll fields the contract now requires", () => {
  it("N: a later view without the approver fields aborts (REPRO-9 is now the intended behaviour)", async () => {
    const s = await toReveal();
    expect(await s.n.onPoll({ state: "revealed" })).toEqual({ kind: "failed", reason: "tampered" });
    const t = await session();
    expect(await t.n.onPoll({ state: "responded", approver_device_id: t.devA })).toEqual({
      kind: "failed",
      reason: "tampered",
    });
    const u = await toReveal();
    expect(await u.n.onPoll({ ...u.responded, state: "approved" })).toEqual({ kind: "failed", reason: "tampered" }); // approved without payload
    const w = await session();
    await w.n.onPoll(w.responded);
    expect(await w.n.onPoll({ state: "responded" })).toEqual({ kind: "failed", reason: "tampered" }); // while the code is asked for
  });
  it("A: a revealed view without new_epk / new_nonce / new_name_ct aborts", async () => {
    for (const drop of ["new_epk", "new_nonce", "new_name_ct"] as const) {
      const s = await toReveal();
      const v = { ...s.revealed };
      delete v[drop];
      expect(await s.a.onPoll(v), drop).toEqual({ kind: "failed", reason: "tampered" });
    }
  });
});
