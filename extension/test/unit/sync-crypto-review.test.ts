// M1 review (docs/audit/internal-reviews/M1-REVIEW.md, revision 7 §0.0f): K0–K11 kill the eleven mutants that survived the first suite, here
// against the revised API; REPRO-1, REPRO-2 and REPRO-11 are kept as regressions of the fixed behaviour.
import { beforeAll, describe, expect, it } from "vitest";
import { fromB64, toB64 } from "../../src/core/crypto/bytes";
import { rekey, setRecovery, type Keyring } from "../../src/core/crypto/keyring";
import { evaluateSameVkBundle, unlockWithSync } from "../../src/core/sync/crypto/bundle-eval";
import { generateDeviceKey, generateEphemeral, importEpk, newDeviceId } from "../../src/core/sync/crypto/device-key";
import { formatPairingCode } from "../../src/core/crypto/pairing-code";
import { ApproverEnrollment, type ApproverView } from "../../src/core/sync/crypto/enroll-approver";
import {
  enrollKey,
  payloadText,
  sealPayload,
  sharedSecret,
  transcriptHash,
} from "../../src/core/sync/crypto/enroll-crypto";
import { NewDeviceEnrollment } from "../../src/core/sync/crypto/enroll-new-device";
import { publishKver, sealBundle } from "../../src/core/sync/crypto/keybundle";
import { preSendCheck, type VerifiedServerBundle } from "../../src/core/sync/crypto/presend";
import { P, T0, VAULT, authFor, bundleOf, keyrings, pwSalt, sealedOf, type Fixture } from "../helpers/sync-keyrings";
import { G, VK1_RAW, verifiedFor, vk } from "../helpers/sync-vectors";

let f: Fixture;
beforeAll(async () => {
  f = await keyrings();
}, 30_000);

/**
 * The server plays the approver toward N and knows K: it has the pairing secret S too (the row-110 case), so what is
 * tested here is that N's own checks of the opened payload refuse it.
 */
async function nWithPayload(p: { vaultId?: string; approver?: string; bundleRaw?: string; v?: number }) {
  const dk = await generateDeviceKey();
  const devN = newDeviceId();
  const devA = newDeviceId();
  const rid = crypto.randomUUID();
  const { machine: n } = await NewDeviceEnrollment.start({ deviceId: devN, dpk: dk.spki, name: "Laptop" });
  n.requestCreated(rid);
  const s = await generateEphemeral();
  const view = { approver_device_id: devA, approver_epk: toB64(s.raw) };
  if ((await n.onPoll({ state: "responded", ...view })).kind !== "enter_code") throw new Error("no code step");
  const secret = crypto.getRandomValues(new Uint8Array(16));
  const r = await n.submitPairingCode(await formatPairingCode(secret));
  if (r.kind !== "reveal") throw new Error("no reveal");
  const epkN = fromB64(r.body.epk);
  const h = await transcriptHash({ rid, devN, devA, dpkN: dk.spki, epkN, epkA: s.raw, nN: fromB64(r.body.nonce) });
  const k = await enrollKey(await sharedSecret(s.privateKey, await importEpk(epkN)), secret, h);
  const raw = p.bundleRaw ?? G.keybundle.raw;
  let text = payloadText({
    vaultId: p.vaultId ?? JSON.parse(raw).vaultId,
    vk: await vk(VK1_RAW),
    bundleRaw: raw,
    approver: p.approver ?? devA,
    at: 1,
  });
  if (p.v !== undefined) text = text.replace('"v":2', `"v":${p.v}`); // canonical JSON: the one "v" member
  return n.onPoll({ state: "approved", ...view, payload: await sealPayload(k, h, text) });
}

const badMacRaw = () => {
  const b = JSON.parse(G.keybundle.raw);
  b.at += 3_600_000;
  return JSON.stringify(b);
};

async function honestToSasOk(match = true) {
  const dk = await generateDeviceKey();
  const devN = newDeviceId();
  const devA = newDeviceId();
  const rid = crypto.randomUUID();
  const { machine: n, request } = await NewDeviceEnrollment.start({ deviceId: devN, dpk: dk.spki, name: "Laptop" });
  n.requestCreated(rid);
  const pending: ApproverView = {
    state: "pending",
    new_device_id: devN,
    new_sig_pubkey: request.sig_pubkey,
    commit: request.commit,
  };
  const { machine: a, respond } = await ApproverEnrollment.start({
    approverId: devA,
    rid,
    request: pending,
    verified: await verifiedFor("respond"),
  });
  const shown = a.respondAccepted();
  if (shown.kind !== "show_code") throw new Error("no code");
  const responded = { state: "responded", approver_device_id: devA, approver_epk: respond.epk };
  await n.onPoll(responded);
  const r = await n.submitPairingCode(shown.code);
  if (r.kind !== "reveal") throw new Error("no reveal");
  const revealed: ApproverView = {
    ...pending,
    state: "revealed",
    new_epk: r.body.epk,
    new_nonce: r.body.nonce,
    new_name_ct: r.body.name_ct,
  };
  await a.onPoll(revealed);
  if (match) await a.submitSas(r.sas);
  return { a, n, revealed, responded, reveal: r };
}

const unlockBase = { secret: { password: P }, needsPassword: false, expectedVaultId: VAULT, adoptedDigest: null };

describe("K0–K11: the killers of the surviving mutants, on the revised API", () => {
  it("K0 control: the honest payload is accepted by this harness", async () => {
    expect((await nWithPayload({})).kind).toBe("accepted");
  });
  it("K1 (M01) N refuses P whose vaultId differs from the bundle's", async () => {
    expect(await nWithPayload({ vaultId: "other-vault-0001" })).toEqual({ kind: "failed", reason: "bad_payload" });
  });
  it("K2 (M02) N refuses P naming another approver than the pinned devA", async () => {
    expect(await nWithPayload({ approver: newDeviceId() })).toEqual({ kind: "failed", reason: "bad_payload" });
  });
  it("K3 (M03) N refuses P whose bundle MAC does not verify", async () => {
    expect(await nWithPayload({ bundleRaw: badMacRaw() })).toEqual({ kind: "failed", reason: "bad_payload" });
  });
  it("K12 (enrolment v2) N refuses a P that says another version: v 1, or a later one (fail closed, §2.6)", async () => {
    expect(await nWithPayload({ v: 1 })).toEqual({ kind: "failed", reason: "bad_payload" });
    expect(await nWithPayload({ v: 3 })).toEqual({ kind: "failed", reason: "bad_payload" });
  });
  it("K4 (M04) buildApproval only takes a bundle the pre-send check verified: a hand-built one with a bad MAC, or an old genuine one, is refused", async () => {
    const s = await honestToSasOk();
    const real = await verifiedFor("approve");
    const handBuilt = (raw: string) => Object.freeze({ ...real, raw, bundle: JSON.parse(raw) }) as VerifiedServerBundle;
    await expect(s.a.buildApproval({ verified: handBuilt(badMacRaw()), now: 1 })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    const old = await sealBundle(await vk(VK1_RAW), { ...G.keybundle.bundle, kver: 1, now: G.keybundle.bundle.at });
    await expect(s.a.buildApproval({ verified: handBuilt(old.raw), now: 1 })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    // and the pre-send check itself refuses the bad MAC for approve
    expect(
      await preSendCheck({
        op: "approve",
        serverRaw: badMacRaw(),
        secret: { recoveryCode: G.recovery_auth.code },
        local: G.keybundle.bundle.keyring,
        vk: await vk(VK1_RAW),
        maxSeenKver: 3,
        expectedVaultId: VAULT,
        adoptedAuth: G.keybundle.bundle.auth,
        adoptedDigest: null,
      }),
    ).toEqual({ ok: false, reason: "bad_mac" });
  });
  it("K5 (M05) the approver aborts when the reveal's nonce changes after the SAS was computed", async () => {
    const s = await honestToSasOk(false);
    expect(await s.a.onPoll({ ...s.revealed, new_nonce: toB64(new Uint8Array(32).fill(1)) })).toEqual({
      kind: "failed",
      reason: "tampered",
    });
  });
  it("K6 (M06) sealBundle refuses unaligned keyring times and an auth salt equal to the password wrap's", async () => {
    const unaligned: Keyring = { ...f.k1, wraps: f.k1.wraps.map((w) => ({ ...w, createdAt: w.createdAt + 1 })) };
    await expect(
      sealBundle(f.v1, {
        vaultId: VAULT,
        kver: 2,
        keyring: unaligned,
        auth: authFor(f.k1),
        by: "qqqqqqqqqqqqqqqqqqqqqg",
        now: T0,
      }),
    ).rejects.toMatchObject({ code: "unaligned_time" });
    const pwKdf = f.k1.wraps.find((w) => w.method === "password")!.kdf!;
    expect(pwKdf.salt).toBe(pwSalt(f.k1));
    await expect(
      sealBundle(f.v1, {
        vaultId: VAULT,
        kver: 2,
        keyring: f.k1,
        auth: { kdf: pwKdf as never },
        by: "qqqqqqqqqqqqqqqqqqqqqg",
        now: T0,
      }),
    ).rejects.toMatchObject({ code: "invalid_bundle" });
  });
  it("K7 (M21) F7: a VK1 bundle that lists the pinned VK2 over garbage bytes cannot pull the device back", async () => {
    const forged: Keyring = {
      ...f.k1,
      previous: [
        { vkId: f.v2.id, iv: toB64(new Uint8Array(12)), wrapped: toB64(new Uint8Array(48).fill(5)), createdAt: T0 },
      ],
    };
    const b = await bundleOf(f.v1, forged, 99);
    expect(
      await unlockWithSync({
        ...unlockBase,
        local: null,
        remote: b,
        pinnedVkId: f.v2.id,
        maxSeenKver: 2,
        needsPassword: true,
        adoptedAuth: authFor(f.k2),
      }),
    ).toEqual({ kind: "reject", reason: "discontinuous" });
  }, 20_000);
  it("K8 (M22) a forged same-keyring bundle is rejected, never classified: maxSeenKver cannot move, inside the cap or beyond it", async () => {
    const at = {
      vk: f.v1,
      local: f.k1,
      maxSeenKver: 1,
      expectedVaultId: VAULT,
      adoptedAuth: authFor(f.k1),
      adoptedDigest: null,
    };
    expect(
      await evaluateSameVkBundle({ ...at, bundle: { ...(await bundleOf(f.v1, f.k1, 2)), kver: 10 ** 15 } }),
    ).toEqual({ kind: "reject", reason: "bad_mac" });
    expect(await evaluateSameVkBundle({ ...at, bundle: { ...(await bundleOf(f.v1, f.k1, 2)), kver: 50 } })).toEqual({
      kind: "reject",
      reason: "bad_mac",
    }); // the mutant would raise it to 50
  }, 20_000);
  it("K9 (M23) unlock refuses a remote bundle whose MAC does not verify (an old genuine bundle with its kver bumped)", async () => {
    const old = { ...(await bundleOf(f.v1, f.k1, 1)), kver: 50 }; // would skip the N27 confirmation if trusted
    const r = await unlockWithSync({
      ...unlockBase,
      local: f.k1b,
      remote: old,
      pinnedVkId: f.v1.id,
      maxSeenKver: 2,
      adoptedAuth: authFor(f.k1b),
    });
    expect(r).toEqual({ kind: "reject", reason: "bad_mac" });
  }, 20_000);
  it("K10 (M33) the pre-send check refuses to build on a newer server bundle that dropped a history VK", async () => {
    const dropped = await sealedOf(f.v2, { ...f.k2, previous: [] }, 5);
    expect(
      await preSendCheck({
        op: "change_recovery",
        serverRaw: dropped.raw,
        secret: { password: P },
        local: f.k2,
        vk: f.v2,
        maxSeenKver: 2,
        expectedVaultId: VAULT,
        adoptedAuth: authFor(f.k2),
        adoptedDigest: null,
      }),
    ).toEqual({ ok: false, reason: "previous_dropped" });
  }, 20_000);
  it("K11 (M36) unlock refuses a rotation bundle that keeps the pinned VK but drops older history", async () => {
    const r3 = await rekey(f.k2, f.v2, P, { now: () => T0 });
    const kr = { ...r3.keyring, previous: r3.keyring.previous.filter((p) => p.vkId !== f.v1.id) };
    const res = await unlockWithSync({
      ...unlockBase,
      local: f.k2,
      remote: await bundleOf(r3.vk, kr, 3),
      pinnedVkId: f.v2.id,
      maxSeenKver: 2,
      needsPassword: true,
      adoptedAuth: authFor(f.k2),
    });
    expect(res).toMatchObject({ kind: "local", remoteRejected: "previous_dropped" });
  }, 30_000);
});

/** Run `hook` the first time crypto.subtle[method] is called while armed, then call the real method. */
function armOnce(method: "encrypt" | "decrypt" | "digest", hook: () => void): () => void {
  const subtle = crypto.subtle as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const orig = subtle[method]!.bind(crypto.subtle);
  let fired = false;
  subtle[method] = (...a: unknown[]) => {
    if (!fired) {
      fired = true;
      hook();
    }
    return orig(...a);
  };
  return () => {
    delete subtle[method];
  };
}
async function armed<T>(method: "encrypt" | "decrypt" | "digest", hook: () => void, run: () => Promise<T>): Promise<T> {
  const restore = armOnce(method, hook);
  try {
    return await run();
  } finally {
    restore();
  }
}

describe("REPRO-1 regression (MUST 7): a failure during an in-flight step wins; the step returns nothing", () => {
  it("approver: Cancel while buildApproval encrypts the payload -> failed, no body", async () => {
    const s = await honestToSasOk();
    const r = await armed(
      "encrypt",
      () => s.a.abort("cancelled"),
      async () => s.a.buildApproval({ verified: await verifiedFor("approve"), now: 1 }),
    );
    expect(r).toEqual({ kind: "failed", reason: "cancelled" });
    expect([s.a.phase, s.a.failure, s.a.approveBody]).toEqual(["failed", "cancelled", null]);
    expect(await s.a.approveAccepted()).toEqual({ kind: "failed", reason: "cancelled" });
  });
  it("new device: request rejected while the approved payload is decrypted -> failed, no keys", async () => {
    const s = await honestToSasOk();
    const built = await s.a.buildApproval({ verified: await verifiedFor("approve"), now: 1 });
    if (built.kind !== "approve") throw new Error("no body");
    expect(await s.a.approveAccepted()).toEqual({ kind: "approved" });
    const r = await armed(
      "decrypt",
      () => s.n.abort("rejected"),
      () => s.n.onPoll({ ...s.responded, state: "approved", payload: built.body.payload }),
    );
    expect(r).toEqual({ kind: "failed", reason: "rejected" });
    expect([s.n.phase, s.n.failure]).toEqual(["failed", "rejected"]);
  });
  it("new device: request expires while the reveal is built from the pairing code -> failed, no SAS, no reveal body", async () => {
    const dk = await generateDeviceKey();
    const { machine: n } = await NewDeviceEnrollment.start({ deviceId: newDeviceId(), dpk: dk.spki, name: "Laptop" });
    n.requestCreated(crypto.randomUUID());
    const epk = toB64((await generateEphemeral()).raw);
    expect(await n.onPoll({ state: "responded", approver_device_id: newDeviceId(), approver_epk: epk })).toEqual({
      kind: "enter_code",
    });
    const code = await formatPairingCode(crypto.getRandomValues(new Uint8Array(16)));
    const r = await armed(
      "encrypt",
      () => n.abort("expired"),
      () => n.submitPairingCode(code),
    );
    expect(r).toEqual({ kind: "failed", reason: "expired" });
    expect([n.phase, n.failure, n.sas, n.revealBody]).toEqual(["failed", "expired", null, null]);
  });
  it("approver: an abort before the ephemeral key is used returns the abort, not a TypeError or invalid_view", async () => {
    const dk = await generateDeviceKey();
    const { machine: n, request } = await NewDeviceEnrollment.start({
      deviceId: newDeviceId(),
      dpk: dk.spki,
      name: "Laptop",
    });
    n.requestCreated(crypto.randomUUID());
    const pending: ApproverView = {
      state: "pending",
      new_device_id: request.device_id,
      new_sig_pubkey: request.sig_pubkey,
      commit: request.commit,
    };
    const { machine: a, respond } = await ApproverEnrollment.start({
      approverId: newDeviceId(),
      rid: crypto.randomUUID(),
      request: pending,
      verified: await verifiedFor("respond"),
    });
    const shown = a.respondAccepted();
    if (shown.kind !== "show_code") throw new Error("no code");
    await n.onPoll({ state: "responded", approver_device_id: newDeviceId(), approver_epk: respond.epk });
    const rv = await n.submitPairingCode(shown.code);
    if (rv.kind !== "reveal") throw new Error("no reveal");
    const r = await armed(
      "digest",
      () => a.abort("gone"),
      () =>
        a.onPoll({
          ...pending,
          state: "revealed",
          new_epk: rv.body.epk,
          new_nonce: rv.body.nonce,
          new_name_ct: rv.body.name_ct,
        }),
    );
    expect(r).toEqual({ kind: "failed", reason: "gone" });
    expect([a.phase, a.failure]).toEqual(["failed", "gone"]);
  });
});

describe("REPRO-2 regression (MUST 8): approve and the poll racing", () => {
  it("in approving, a poll showing approved with every pinned value is the 200; the late approveAccepted agrees", async () => {
    const s = await honestToSasOk();
    const built = await s.a.buildApproval({ verified: await verifiedFor("approve"), now: 1 });
    expect(built.kind).toBe("approve");
    expect(await s.a.onPoll({ ...s.revealed, state: "approved" })).toEqual({ kind: "approved" });
    expect(await s.a.approveAccepted()).toEqual({ kind: "approved" });
    expect([s.a.phase, s.a.approveBody]).toEqual(["approved", null]);
  });
  it("approved before approve was sent is unexpected; in approving a changed reveal is tampered", async () => {
    const s = await honestToSasOk(false);
    expect(await s.a.onPoll({ ...s.revealed, state: "approved" })).toEqual({
      kind: "failed",
      reason: "unexpected_state",
    });
    const t = await honestToSasOk();
    expect(await t.a.onPoll({ ...t.revealed, state: "approved" })).toEqual({
      kind: "failed",
      reason: "unexpected_state",
    }); // sas_ok, approve not built
    const u = await honestToSasOk();
    await u.a.buildApproval({ verified: await verifiedFor("approve"), now: 1 });
    expect(
      await u.a.onPoll({ ...u.revealed, state: "approved", new_nonce: toB64(new Uint8Array(32).fill(2)) }),
    ).toEqual({ kind: "failed", reason: "tampered" });
  });
});

describe("REPRO-11 regression (F-01): kver exhaustion", () => {
  it("a MAC-valid bundle at 2^53-1 cannot raise maxSeenKver; publishKver never returns an unsafe value", async () => {
    const MAX = Number.MAX_SAFE_INTEGER;
    const burnt = await bundleOf(f.v1, f.k1, MAX);
    expect(
      await evaluateSameVkBundle({
        bundle: burnt,
        vk: f.v1,
        local: f.k1,
        maxSeenKver: 3,
        expectedVaultId: VAULT,
        adoptedAuth: authFor(f.k1),
        adoptedDigest: null,
      }),
    ).toEqual({ kind: "in_sync", maxSeenKver: 3 });
    expect(publishKver(3, 3)).toBe(4); // so every device keeps publishing above the honest server's kver
    expect(publishKver(3, MAX)).toBe(3 + 65536); // even a device whose maxSeenKver was poisoned earlier
    expect(() => publishKver(MAX, 3)).toThrow(expect.objectContaining({ code: "kver_overflow" })); // a server at the ceiling: refuse, never an unsafe kver
    const rec = (await setRecovery(f.k1, f.v1, { now: () => T0 })).keyring;
    await expect(sealedOf(f.v1, rec, publishKver(3, 3))).resolves.toMatchObject({ raw: expect.any(String) });
  }, 20_000);
});
