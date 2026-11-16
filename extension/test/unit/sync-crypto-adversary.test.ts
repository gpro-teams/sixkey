// M1, §8.1 enrollment adversary model (enrolment v2, revision 27): a malicious server drives both production state
// machines, a user copies the pairing code from the approver's screen to the new device and the six digits back.
// Every strategy runs with the 6-digit SAS and with the SAS cut to 4 bits (16 values), in two cases:
//   - the server does not know the pairing secret S (the normal case): it wins never, at either SAS length; a
//     substitution shows on A as pairing_mismatch (before the SAS step) and on N as bad_payload;
//   - S has leaked to the server (simulated): against A the SAS is a second, independent check, so the best attack wins
//     about 1/16 at 4 bits (one guess) and never at full length; against N impersonating A succeeds every time: that is
//     the residual of SYNC-DESIGN §1.3 and §10 row 110, asserted as such.
// A "quantum" adversary handed Z (the ECDH secret) opens nothing and forges nothing N accepts.
// Everything is deterministic: ephemeral keys come from seeded scalars (node:crypto), nonces, IVs and S from a seeded
// stream, so a run's counts are fixed and the statistical bands cannot flake.
import { describe, expect, it } from "vitest";
import { createECDH, createHash } from "node:crypto";
import { fromB64, toB64, type Random } from "../../src/core/crypto/bytes";
import { hkdfAesKey } from "../../src/core/crypto/kdf";
import { formatPairingCode } from "../../src/core/crypto/pairing-code";
import type { Ephemeral } from "../../src/core/sync/crypto/device-key";
import { ApproverEnrollment, type ApproverView } from "../../src/core/sync/crypto/enroll-approver";
import {
  commitment,
  enrollKey,
  openPayload,
  openRevealName,
  payloadText,
  sasOf,
  sealPayload,
  sealRevealName,
  sharedSecret,
  transcriptHash,
  type TranscriptParts,
} from "../../src/core/sync/crypto/enroll-crypto";
import { ENROLL_LABEL } from "../../src/core/sync/crypto/enroll-labels";
import { NewDeviceEnrollment, type NewDeviceView } from "../../src/core/sync/crypto/enroll-new-device";
import { importEpk } from "../../src/core/sync/crypto/device-key";
import { parsePayloadText } from "../../src/core/sync/crypto/enroll-crypto";
import { b64u } from "../helpers/contract";
import { F, G, VK1_RAW, VK2_RAW, spkiOf, verifiedFor, vk } from "../helpers/sync-vectors";

/** The approve body built from the keybundle vector (the user's vault), through the pre-send check's verified object. */
async function approveBody(a: ApproverEnrollment, now: number) {
  const r = await a.buildApproval({ verified: await verifiedFor("approve"), now });
  if (r.kind !== "approve") throw new Error(`no approve body: ${r.reason}`);
  return r.body;
}

const FULL = 1_000_000;
const SMALL = 16;
const DEV_N = F.dev_n;
const DEV_A = F.dev_a;
const DEV_X = F.dev_s; // another device id the server could name
const DPK_N = spkiOf("dsk_N");
const NAME = "Work laptop";
const REAL = { raw: G.keybundle.raw as string, vk: VK1_RAW }; // the user's vault (approver side)
const FAKE = { raw: G.rotate_repair.request.bundle as string, vk: VK2_RAW }; // a vault the attacker controls

function drbg(seed: string): Random {
  let ctr = 0;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let o = 0; o < n; o += 32)
      out.set(
        createHash("sha256")
          .update(`${seed}|${ctr++}`)
          .digest()
          .subarray(0, Math.min(32, n - o)),
        o,
      );
    return out;
  };
}

/** A P-256 ECDH pair from a seeded scalar, held like production holds a fresh one (non-extractable). */
async function ephemeral(rng: Random): Promise<Ephemeral> {
  for (;;) {
    const d = Buffer.from(rng(32));
    try {
      const e = createECDH("prime256v1");
      e.setPrivateKey(d);
      const pub = e.getPublicKey();
      const jwk = { kty: "EC", crv: "P-256", d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) };
      const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, [
        "deriveBits",
      ]);
      return { privateKey, raw: new Uint8Array(pub) };
    } catch {
      /* scalar out of range: draw again */
    }
  }
}

const uuidOf = (b: Uint8Array) => {
  const h = Buffer.from(b.subarray(0, 16)).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/**
 * The server's own end of one fake session: it knows its key, so it computes h and Z exactly like an honest peer would;
 * K also needs S, and `s` is what the server has for it: the real one when it leaked, else a guess.
 */
async function serverSide(own: Ephemeral, peerRaw: Uint8Array, t: TranscriptParts, s: Uint8Array) {
  const h = await transcriptHash(t);
  const k = await enrollKey(await sharedSecret(own.privateKey, await importEpk(peerRaw)), s.slice(), h);
  return { h, k };
}

const fakePayload = async () =>
  payloadText({
    vaultId: JSON.parse(FAKE.raw).vaultId,
    vk: await vk(FAKE.vk),
    bundleRaw: FAKE.raw,
    approver: DEV_A,
    at: 1,
  });

type Outcome = {
  vkToAttacker: boolean;
  nAcceptedFake: boolean;
  aFailure: string | null;
  nFailure: string | null;
};

/**
 * Two-session MITM. Toward N the server plays the approver (its key S1); toward A it plays the new device with its own
 * key S2 and nonce, committed in its own C'. The real A draws S at respond and shows it; the user types it on N, which
 * then reveals and shows its SAS; the user types that on A. `leak`: the server has S as well. Variants:
 *   grind     after N's SAS is known it reveals other values chosen to make SAS_A equal N's (breaks its commitment)
 *   rereveal  after each wrong SAS attempt it shows A a different reveal, hoping for a fresh SAS_A
 *   ablation  the protocol broken on purpose: an approver that does not pin C before respond (it accepts whatever the
 *             server reveals), with S leaked: the server grinds its reveal against N's SAS
 */
async function mitm(
  seed: string,
  space: number,
  v: { leak?: boolean; grind?: boolean; rereveal?: boolean; ablation?: boolean } = {},
): Promise<Outcome> {
  const rng = drbg(seed);
  const rid = uuidOf(rng(16));
  const { machine: n } = await NewDeviceEnrollment.start(
    { deviceId: DEV_N, dpk: DPK_N, name: NAME },
    { ephemeral: await ephemeral(rng), rng, codeSpace: space },
  );
  n.requestCreated(rid);
  const s1 = await ephemeral(rng);
  const toNView = { approver_device_id: DEV_A, approver_epk: toB64(s1.raw) };
  if ((await n.onPoll({ state: "responded", ...toNView })).kind !== "enter_code") throw new Error("N asks no code");

  const pendingFor = async (e: Ephemeral, nonce: Uint8Array): Promise<ApproverView> => ({
    state: "pending",
    new_device_id: DEV_N,
    new_sig_pubkey: toB64(DPK_N),
    commit: toB64(await commitment(DEV_N, DPK_N, e.raw, nonce)),
  });
  const s2 = await ephemeral(rng);
  const n2 = rng(32);
  const sA = rng(16); // the real approver's pairing secret
  const aEph = await ephemeral(rng);
  const startA = async (pending: ApproverView) => {
    const r = await ApproverEnrollment.start(
      { approverId: DEV_A, rid, request: pending, verified: await verifiedFor("respond") },
      { ephemeral: aEph, rng, codeSpace: space, pairingSecret: sA.slice() },
    );
    const shown = r.machine.respondAccepted();
    if (shown.kind !== "show_code") throw new Error("no code");
    return { a: r.machine, epkA: fromB64(r.respond.epk), code: shown.code };
  };
  let { a, epkA, code } = await startA(await pendingFor(s2, n2));
  // the user types the code A shows on N, which then reveals and shows its six digits
  const nStep = await n.submitPairingCode(code);
  if (nStep.kind !== "reveal") throw new Error("N did not reveal");
  const epkN = fromB64(nStep.body.epk);
  const nN = fromB64(nStep.body.nonce);
  const sasN = nStep.sas;
  const known = v.leak ? sA : rng(16); // the server's S: the real one if it leaked, else its best guess
  const toN = await serverSide(s1, epkN, { rid, devN: DEV_N, devA: DEV_A, dpkN: DPK_N, epkN, epkA: s1.raw, nN }, known);

  const revealTo = async (e: Ephemeral, nonce: Uint8Array) => {
    const t = { rid, devN: DEV_N, devA: DEV_A, dpkN: DPK_N, epkN: e.raw, epkA, nN: nonce };
    const toA = await serverSide(e, epkA, t, known);
    return {
      toA,
      view: {
        ...(await pendingFor(s2, n2)),
        state: "revealed",
        new_epk: toB64(e.raw),
        new_nonce: toB64(nonce),
        new_name_ct: await sealRevealName(toA.k, toA.h, NAME, rng),
      },
    };
  };
  let chosen = { e: s2, nonce: n2 };
  if (v.grind || v.ablation) {
    for (let i = 0; i < 512; i++) {
      const e = await ephemeral(rng);
      const nonce = rng(32);
      const h2 = await transcriptHash({ rid, devN: DEV_N, devA: DEV_A, dpkN: DPK_N, epkN: e.raw, epkA, nN: nonce });
      if ((await sasOf(h2, space)) === sasN) {
        chosen = { e, nonce };
        break;
      }
    }
    if (v.ablation) ({ a, epkA, code } = await startA(await pendingFor(chosen.e, chosen.nonce))); // C not pinned
  }
  let { toA, view } = await revealTo(chosen.e, chosen.nonce);
  if (v.ablation) view = { ...view, commit: (await pendingFor(chosen.e, chosen.nonce)).commit };
  const out: Outcome = { vkToAttacker: false, nAcceptedFake: false, aFailure: null, nFailure: null };

  // toward N, in every case: the attacker's own vault under the K it has for N
  const nResult = await n.onPoll({
    state: "approved",
    ...toNView,
    payload: await sealPayload(toN.k, toN.h, await fakePayload(), rng),
  });
  if (nResult.kind === "accepted") out.nAcceptedFake = nResult.keys.vk.id === (await vk(FAKE.vk)).id;
  out.nFailure = n.failure;

  const aStep = await a.onPoll(view);
  if (aStep.kind !== "enter_sas") return { ...out, aFailure: a.failure };
  let matched = false;
  for (let i = 0; i < 3 && !matched && a.phase === "verifying"; i++) {
    const r = await a.submitSas(sasN); // the user types what N shows
    matched = r.kind === "matched";
    if (!matched && v.rereveal && a.phase === "verifying")
      await a.onPoll((await revealTo(await ephemeral(rng), rng(32))).view);
  }
  if (!matched) return { ...out, aFailure: a.failure };
  const approve = await approveBody(a, 1);
  const stolen = await parsePayloadText(await openPayload(toA.k, toA.h, approve.payload)); // the server reads the VK
  out.vkToAttacker = stolen.vk.id === (await vk(REAL.vk)).id;
  return out;
}

async function many(count: number, f: (i: number) => Promise<Outcome>): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (let i = 0; i < count; i += 32)
    out.push(...(await Promise.all(Array.from({ length: Math.min(32, count - i) }, (_, j) => f(i + j)))));
  return out;
}
const count = (os: Outcome[], k: keyof Outcome) => {
  const n = os.filter((o) => o[k] === true).length;
  if (process.env.SIXKEY_SIM_REPORT) console.log(`${k}: ${n} of ${os.length}`);
  return n;
};
/** ±4σ around n/16, the rate of a single uniform guess among 16 values. */
const oneGuessBand = (n: number): [number, number] => {
  const sd = Math.sqrt(n * (1 / 16) * (15 / 16));
  return [Math.floor(n / 16 - 4 * sd), Math.ceil(n / 16 + 4 * sd)];
};

describe("adversary without S (the normal case): the server wins never, at either SAS length", () => {
  it("4-bit SAS: the two-session MITM gets nothing; A ends with pairing_mismatch before the SAS, N with bad_payload", async () => {
    const os = await many(800, (i) => mitm(`nosk-${i}`, SMALL));
    expect([count(os, "vkToAttacker"), count(os, "nAcceptedFake")]).toEqual([0, 0]);
    expect(new Set(os.map((o) => o.aFailure))).toEqual(new Set(["pairing_mismatch"]));
    expect(new Set(os.map((o) => o.nFailure))).toEqual(new Set(["bad_payload"]));
  }, 60_000);
  it("full-length SAS, and the grinding and re-reveal variants at 4 bits: still nothing", async () => {
    const full = await many(800, (i) => mitm(`nosk-full-${i}`, FULL));
    expect([count(full, "vkToAttacker"), count(full, "nAcceptedFake")]).toEqual([0, 0]);
    const grind = await many(200, (i) => mitm(`nosk-grind-${i}`, SMALL, { grind: true }));
    expect(count(grind, "vkToAttacker")).toBe(0);
    expect(new Set(grind.map((o) => o.aFailure))).toEqual(new Set(["commit_mismatch"]));
    const rere = await many(200, (i) => mitm(`nosk-rere-${i}`, SMALL, { rereveal: true }));
    expect([count(rere, "vkToAttacker"), count(rere, "nAcceptedFake")]).toEqual([0, 0]);
  }, 60_000);
});

describe("adversary with S leaked: the SAS is A's independent second check (4-bit SAS)", () => {
  const N = 1600;
  it("the committed two-session MITM wins against A about 1/16: one guess, never more", async () => {
    const os = await many(N, (i) => mitm(`mitm-${i}`, SMALL, { leak: true }));
    const wins = count(os, "vkToAttacker");
    const [lo, hi] = oneGuessBand(N);
    expect(wins).toBeGreaterThanOrEqual(lo);
    expect(wins).toBeLessThanOrEqual(hi);
    expect(os.filter((o) => !o.vkToAttacker).every((o) => o.aFailure === "sas_mismatch")).toBe(true);
  }, 60_000);
  it("residual (§1.3, §10 row 110): with S leaked, the server posing as the approver fools N in every session", async () => {
    const os = await many(400, (i) => mitm(`row110-${i}`, SMALL, { leak: true }));
    expect(count(os, "nAcceptedFake")).toBe(400); // N has no second check: the accepted residual, not a defect
    for (const o of os) expect(o.nFailure).toBeNull();
  }, 60_000);
  it("grinding after N's SAS is known breaks the pinned commitment: zero wins, every attempt visibly refused", async () => {
    const os = await many(400, (i) => mitm(`grind-${i}`, SMALL, { leak: true, grind: true }));
    expect(count(os, "vkToAttacker")).toBe(0);
    expect(new Set(os.map((o) => o.aFailure))).toEqual(new Set(["commit_mismatch"]));
  }, 60_000);
  it("changing the reveal between A's retries gains nothing: still one guess (not three), and A aborts", async () => {
    const os = await many(N, (i) => mitm(`rereveal-${i}`, SMALL, { leak: true, rereveal: true }));
    const [lo, hi] = oneGuessBand(N);
    const wins = count(os, "vkToAttacker");
    expect(wins).toBeGreaterThanOrEqual(lo);
    expect(wins).toBeLessThanOrEqual(hi); // three independent guesses would be ~3N/16 = 300
    expect(os.filter((o) => !o.vkToAttacker).every((o) => o.aFailure === "tampered")).toBe(true);
  }, 60_000);
  it("ablation control: an approver that did not pin C before respond would, once S leaked, almost always lose", async () => {
    const os = await many(200, (i) => mitm(`ablation-${i}`, SMALL, { leak: true, ablation: true }));
    expect(count(os, "vkToAttacker")).toBeGreaterThanOrEqual(190);
  }, 60_000);
});

describe("adversary: full-length SAS", () => {
  it("with S leaked, the committed MITM never wins against A (2000 deterministic sessions); N is the row-110 residual", async () => {
    const os = await many(2000, (i) => mitm(`full-${i}`, FULL, { leak: true }));
    expect(count(os, "vkToAttacker")).toBe(0);
    expect(count(os, "nAcceptedFake")).toBe(2000); // §10 row 110
  }, 60_000);
  it("10^5 trials at the hash level (SAS depends only on h, the server's values fixed before epk_A): zero matches; the same harness finds ~1/16 at 4 bits", async () => {
    // a cheap seeded stream (xorshift32) for the 6 x 10^5 transcript values; the hashing is all production code
    let x = 0x9e3779b9;
    const rng = (n: number) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        out[i] = x & 0xff;
      }
      return out;
    };
    const point = () => {
      const p = rng(65);
      p[0] = 0x04;
      return p;
    };
    const trial = async (space: number) => {
      const [epkN, nN, s1, s2, n2, epkA] = [point(), rng(32), point(), point(), rng(32), point()];
      const base = { rid: F.rid, devN: DEV_N, devA: DEV_A, dpkN: DPK_N };
      const [h1, h2] = await Promise.all([
        transcriptHash({ ...base, epkN, epkA: s1, nN }),
        transcriptHash({ ...base, epkN: s2, epkA, nN: n2 }),
      ]);
      return (await sasOf(h1, space)) === (await sasOf(h2, space));
    };
    let full = 0;
    for (let i = 0; i < 100_000; i += 2000)
      full += (await Promise.all(Array.from({ length: 2000 }, () => trial(FULL)))).filter(Boolean).length;
    expect(full).toBe(0);
    let small = 0;
    for (let i = 0; i < 16_000; i += 2000)
      small += (await Promise.all(Array.from({ length: 2000 }, () => trial(SMALL)))).filter(Boolean).length;
    if (process.env.SIXKEY_SIM_REPORT) console.log(`hash-level: full ${full} of 100000, 4-bit ${small} of 16000`);
    const sd = Math.sqrt(16_000 / 16);
    expect(Math.abs(small - 1000)).toBeLessThanOrEqual(4 * sd);
  }, 60_000);
  it.skipIf(!process.env.SIXKEY_LONG_SIM)(
    "10^5 full-length sessions through the state machines (SIXKEY_LONG_SIM=1)",
    async () => {
      const os = await many(100_000, (i) => mitm(`long-${i}`, FULL, { leak: true }));
      expect(count(os, "vkToAttacker")).toBe(0);
    },
    600_000,
  );
});

describe("adversary: the pinning rules and the pairing code, one strategy at a time", () => {
  async function honestStart(seed: string, space = FULL) {
    const rng = drbg(seed);
    const rid = uuidOf(rng(16));
    const nEph = await ephemeral(rng);
    const { machine: n, request } = await NewDeviceEnrollment.start(
      { deviceId: DEV_N, dpk: DPK_N, name: NAME },
      { ephemeral: nEph, rng, codeSpace: space },
    );
    n.requestCreated(rid);
    const pending: ApproverView = {
      state: "pending",
      new_device_id: DEV_N,
      new_sig_pubkey: request.sig_pubkey,
      commit: request.commit,
    };
    const s = rng(16);
    const aEph = await ephemeral(rng);
    const { machine: a, respond } = await ApproverEnrollment.start(
      { approverId: DEV_A, rid, request: pending, verified: await verifiedFor("respond") },
      { ephemeral: aEph, rng, codeSpace: space, pairingSecret: s.slice() },
    );
    const shown = a.respondAccepted();
    if (shown.kind !== "show_code") throw new Error("no code");
    const responded: NewDeviceView = { state: "responded", approver_device_id: DEV_A, approver_epk: respond.epk };
    return { rng, rid, n, a, pending, respond, responded, s, code: shown.code, nEph, aEph };
  }
  async function honestReveal(seed: string) {
    const s = await honestStart(seed);
    await s.n.onPoll(s.responded);
    const r = await s.n.submitPairingCode(s.code);
    if (r.kind !== "reveal") throw new Error("no reveal");
    const revealed = {
      ...s.pending,
      state: "revealed",
      new_epk: r.body.epk,
      new_nonce: r.body.nonce,
      new_name_ct: r.body.name_ct,
    };
    return { ...s, reveal: r, revealed };
  }
  async function honestUntilApproved(seed: string) {
    const s = await honestReveal(seed);
    await s.a.onPoll(s.revealed);
    await s.a.submitSas(s.reveal.sas);
    const approve = await approveBody(s.a, 7);
    expect(await s.a.approveAccepted()).toEqual({ kind: "approved" });
    return { ...s, approve };
  }

  it("P1-1: C changed after A responded → A aborts", async () => {
    const s = await honestStart("p1-1");
    const other = await honestStart("p1-1-other");
    expect(await s.a.onPoll({ ...s.pending, commit: other.pending.commit })).toEqual({
      kind: "failed",
      reason: "tampered",
    });
  });
  it("P1-2: epk_A changed after N revealed (or while it asks for the code) → N aborts; two approvers racing likewise", async () => {
    const s = await honestReveal("p1-2");
    const other = await honestStart("p1-2-other");
    expect(await s.n.onPoll({ ...s.responded, state: "revealed", approver_epk: other.respond.epk })).toEqual({
      kind: "failed",
      reason: "tampered",
    });
    const u = await honestStart("p1-2-code");
    await u.n.onPoll(u.responded);
    expect(await u.n.onPoll({ ...u.responded, approver_epk: other.respond.epk })).toEqual({
      kind: "failed",
      reason: "tampered",
    });
    const t = await honestReveal("race");
    expect(await t.n.onPoll({ state: "revealed", approver_device_id: DEV_X, approver_epk: other.respond.epk })).toEqual(
      { kind: "failed", reason: "tampered" },
    );
  });
  it("P1-3: forcing N to start over: a gone request is terminal, the machine shows no second SAS and makes no new request", async () => {
    const s = await honestReveal("p1-3");
    s.n.abort("gone");
    expect([s.n.phase, s.n.sas]).toEqual(["failed", null]);
    expect(await s.n.onPoll(s.responded)).toEqual({ kind: "failed", reason: "gone" });
    expect(() => s.n.requestCreated(s.rid)).toThrow(); // only a new machine, started by the user, makes a request
  });
  it("F1: the server posing as the approver to N, without S: no guess of S makes a payload N accepts", async () => {
    let accepted = 0;
    for (let i = 0; i < 64; i++) {
      const s = await honestStart(`f1-${i}`);
      const sv = await ephemeral(s.rng);
      const view = { approver_device_id: DEV_A, approver_epk: toB64(sv.raw) };
      await s.n.onPoll({ state: "responded", ...view });
      const r = await s.n.submitPairingCode(s.code); // the user types the real approver's code
      if (r.kind !== "reveal") throw new Error("no reveal");
      const t = {
        rid: s.rid,
        devN: DEV_N,
        devA: DEV_A,
        dpkN: DPK_N,
        epkN: fromB64(r.body.epk),
        epkA: sv.raw,
        nN: fromB64(r.body.nonce),
      };
      const toN = await serverSide(sv, t.epkN, t, s.rng(16)); // a guess of S
      const res = await s.n.onPoll({
        state: "approved",
        ...view,
        payload: await sealPayload(toN.k, toN.h, await fakePayload(), s.rng),
      });
      if (res.kind === "accepted") accepted++;
      else expect(res).toEqual({ kind: "failed", reason: "bad_payload" }); // never written, imported or completed
    }
    expect(accepted).toBe(0);
  });
  it("F1, residual (§10 row 110): the same attack with S leaked succeeds: N accepts the attacker's vault", async () => {
    const s = await honestStart("f1-leak");
    const sv = await ephemeral(s.rng);
    const view = { approver_device_id: DEV_A, approver_epk: toB64(sv.raw) };
    await s.n.onPoll({ state: "responded", ...view });
    const r = await s.n.submitPairingCode(s.code);
    if (r.kind !== "reveal") throw new Error("no reveal");
    const t = {
      rid: s.rid,
      devN: DEV_N,
      devA: DEV_A,
      dpkN: DPK_N,
      epkN: fromB64(r.body.epk),
      epkA: sv.raw,
      nN: fromB64(r.body.nonce),
    };
    const toN = await serverSide(sv, t.epkN, t, s.s);
    const res = await s.n.onPoll({
      state: "approved",
      ...view,
      payload: await sealPayload(toN.k, toN.h, await fakePayload(), s.rng),
    });
    expect(res.kind === "accepted" && res.keys.vk.id).toBe((await vk(FAKE.vk)).id);
  });
  it("a 'quantum' adversary handed Z opens neither the name nor the payload, and forges no payload N accepts", async () => {
    const s = await honestUntilApproved("quantum");
    const h = await transcriptHash({
      rid: s.rid,
      devN: DEV_N,
      devA: DEV_A,
      dpkN: DPK_N,
      epkN: fromB64(s.reveal.body.epk),
      epkA: fromB64(s.respond.epk),
      nN: fromB64(s.reveal.body.nonce),
    });
    // Z as a future quantum computer would recover it from the recorded epk_N and epk_A
    const zOf = async () => sharedSecret(s.aEph.privateKey, await importEpk(fromB64(s.reveal.body.epk)));
    const keys: [string, () => Promise<CryptoKey>][] = [
      ["HKDF(Z, h, v1 label)", async () => hkdfAesKey(await zOf(), h, "sixkey/v1/enroll-key")],
      ["HKDF(Z, h, v2 label)", async () => hkdfAesKey(await zOf(), h, ENROLL_LABEL.enrollKey)],
      ["HKDF(Z || guess, h)", async () => enrollKey(await zOf(), s.rng(16), h)],
      ["HKDF(Z || zeros, h)", async () => enrollKey(await zOf(), new Uint8Array(16), h)],
    ];
    for (const [name, key] of keys) {
      await expect(openRevealName(await key(), h, s.reveal.body.name_ct), name).rejects.toMatchObject({
        code: "decrypt_failed",
      });
      await expect(openPayload(await key(), h, s.approve.payload), name).rejects.toMatchObject({
        code: "decrypt_failed",
      });
    }
    // and it cannot make N accept anything: each forged payload in a fresh honest session is bad_payload
    for (const [name, key] of keys) {
      const t = await honestReveal(`quantum-forge-${name}`);
      const th = await transcriptHash({
        rid: t.rid,
        devN: DEV_N,
        devA: DEV_A,
        dpkN: DPK_N,
        epkN: fromB64(t.reveal.body.epk),
        epkA: fromB64(t.respond.epk),
        nN: fromB64(t.reveal.body.nonce),
      });
      const tz = await sharedSecret(t.aEph.privateKey, await importEpk(fromB64(t.reveal.body.epk)));
      const forgeKey = name.includes("v1")
        ? await hkdfAesKey(tz, th, "sixkey/v1/enroll-key")
        : name.includes("v2 label")
          ? await hkdfAesKey(tz, th, ENROLL_LABEL.enrollKey)
          : await enrollKey(tz, name.includes("zeros") ? new Uint8Array(16) : t.rng(16), th);
      void key;
      const res = await t.n.onPoll({
        ...t.responded,
        state: "approved",
        payload: await sealPayload(forgeKey, th, await fakePayload(), t.rng),
      });
      expect(res, name).toEqual({ kind: "failed", reason: "bad_payload" });
    }
  });
  it("replay across requests: an old payload is useless in a new request (K is bound to h and S)", async () => {
    const one = await honestUntilApproved("replay-1");
    const two = await honestReveal("replay-2");
    expect(await two.n.onPoll({ ...two.responded, state: "approved", payload: one.approve.payload })).toEqual({
      kind: "failed",
      reason: "bad_payload",
    });
  });
  it("an old request's pairing code typed into a new request: it parses, but the approver refuses the name (pairing_mismatch)", async () => {
    const one = await honestStart("oldcode-1");
    const two = await honestStart("oldcode-2");
    await two.n.onPoll(two.responded);
    const r = await two.n.submitPairingCode(one.code);
    if (r.kind !== "reveal") throw new Error("no reveal");
    expect(
      await two.a.onPoll({
        ...two.pending,
        state: "revealed",
        new_epk: r.body.epk,
        new_nonce: r.body.nonce,
        new_name_ct: r.body.name_ct,
      }),
    ).toEqual({ kind: "failed", reason: "pairing_mismatch" });
    expect(one.code).not.toBe(two.code);
    expect(await formatPairingCode(two.s)).toBe(two.code);
  });
  it("reflection: A's own epk handed back as N's is refused before anything is derived", async () => {
    const s = await honestStart("reflect");
    expect(
      await s.a.onPoll({
        ...s.pending,
        state: "revealed",
        new_epk: s.respond.epk,
        new_nonce: toB64(new Uint8Array(32)),
        new_name_ct: toB64(new Uint8Array(188)),
      }),
    ).toEqual({ kind: "failed", reason: "reflected_key" });
  });
  it("unknown key share: the server names another approver to N (or another device to A); N never accepts, at any SAS length", async () => {
    let accepted = 0;
    let sasStage = 0;
    for (let i = 0; i < 64; i++) {
      const s = await honestStart(`uks-${i}`, SMALL);
      await s.n.onPoll({ ...s.responded, approver_device_id: DEV_X }); // N believes devX approves
      const r = await s.n.submitPairingCode(s.code); // and the user types the right code
      if (r.kind !== "reveal") throw new Error("no reveal");
      const aStep = await s.a.onPoll({
        ...s.pending,
        state: "revealed",
        new_epk: r.body.epk,
        new_nonce: r.body.nonce,
        new_name_ct: r.body.name_ct,
      });
      expect(aStep).toEqual({ kind: "failed", reason: "pairing_mismatch" }); // the name is under N's K, not A's
      if (s.a.phase === "verifying") sasStage++;
      const res = await s.n.onPoll({
        state: "approved",
        approver_device_id: DEV_X,
        approver_epk: s.respond.epk,
        payload: toB64(s.rng(300)),
      });
      if (res.kind === "accepted") accepted++;
    }
    expect([accepted, sasStage]).toEqual([0, 0]);
    const t = await honestStart("uks-a");
    await t.n.onPoll(t.responded);
    const tr = await t.n.submitPairingCode(t.code);
    if (tr.kind !== "reveal") throw new Error("no reveal");
    const { machine: a2 } = await ApproverEnrollment.start(
      {
        approverId: DEV_A,
        rid: t.rid,
        request: { ...t.pending, new_device_id: DEV_X },
        verified: await verifiedFor("respond"),
      },
      { ephemeral: await ephemeral(t.rng) },
    );
    a2.respondAccepted();
    expect(
      await a2.onPoll({
        ...t.pending,
        new_device_id: DEV_X,
        state: "revealed",
        new_epk: tr.body.epk,
        new_nonce: tr.body.nonce,
        new_name_ct: tr.body.name_ct,
      }),
    ).toEqual({ kind: "failed", reason: "commit_mismatch" });
  });
});
