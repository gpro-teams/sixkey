// Enrolment v2: what holds the pairing secret S lets go of it (SYNC-DESIGN §3.2 MUST 5, MUST 10: "任何结束都丢弃它").
// The bytes are watched where they are made: the code's parser (core/crypto/pairing-code.ts) and the hash its check
// bits use (core/crypto/bytes.ts sha256) are wrapped here so that a test holds the very arrays the machines and the
// codec hold, and can see them zeroed, or no longer touched, at each way out.
import { beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
  parsed: [] as Uint8Array[],
  hashed: [] as Uint8Array[],
  afterParse: null as null | (() => void),
}));

vi.mock("../../src/core/crypto/pairing-code", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/crypto/pairing-code")>();
  return {
    ...real,
    parsePairingCode: async (input: string) => {
      const s = await real.parsePairingCode(input);
      probe.parsed.push(s);
      probe.afterParse?.();
      return s;
    },
  };
});
vi.mock("../../src/core/crypto/bytes", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/crypto/bytes")>();
  return {
    ...real,
    sha256: async (...parts: Uint8Array[]) => {
      probe.hashed.push(...parts);
      return real.sha256(...parts);
    },
  };
});

import { formatPairingCode, parsePairingCode } from "../../src/core/crypto/pairing-code";
import { formatRecoveryCode, parseRecoveryCode } from "../../src/core/crypto/recovery-code";
import { generateDeviceKey, newDeviceId } from "../../src/core/sync/crypto/device-key";
import { ApproverEnrollment, type ApproverView } from "../../src/core/sync/crypto/enroll-approver";
import { startNewDeviceEnrollment } from "../../src/core/sync/crypto";
import { verifiedFor } from "../helpers/sync-vectors";

const zero = (b: Uint8Array) => b.every((x) => x === 0);

beforeEach(() => {
  probe.parsed.length = 0;
  probe.hashed.length = 0;
  probe.afterParse = null;
});

/** Both machines, the approver past respond's 200 with S through its seam (the machine owns and wipes the array). */
async function session() {
  const dk = await generateDeviceKey();
  const devN = newDeviceId();
  const devA = newDeviceId();
  const rid = crypto.randomUUID();
  const { machine: n, request } = await startNewDeviceEnrollment({ deviceId: devN, dpk: dk.spki, name: "Laptop" });
  n.requestCreated(rid);
  const pending: ApproverView = {
    state: "pending",
    new_device_id: devN,
    new_sig_pubkey: request.sig_pubkey,
    commit: request.commit,
  };
  const seam = crypto.getRandomValues(new Uint8Array(16));
  const { machine: a, respond } = await ApproverEnrollment.start(
    { approverId: devA, rid, request: pending, verified: await verifiedFor("respond") },
    { pairingSecret: seam },
  );
  const shown = a.respondAccepted();
  if (shown.kind !== "show_code") throw new Error("no code");
  const responded = { state: "responded", approver_device_id: devA, approver_epk: respond.epk };
  expect(await n.onPoll(responded)).toEqual({ kind: "enter_code" });
  return { n, a, pending, code: shown.code, seam };
}

describe("the new device wipes the S it parsed on every way out", () => {
  it("an end that lands while the code is being checked (after the parse, before the key): S is zeroed all the same", async () => {
    const s = await session();
    probe.afterParse = () => s.n.abort("cancelled"); // the user cancels, the request is rejected, ... meanwhile
    const r = await s.n.submitPairingCode(s.code);
    expect(r).toEqual({ kind: "failed", reason: "cancelled" });
    expect(probe.parsed).toHaveLength(1);
    expect(zero(probe.parsed[0]!)).toBe(true);
  });

  it("the honest way: S went into the key and is zeroed too", async () => {
    const s = await session();
    const r = await s.n.submitPairingCode(s.code);
    expect(r.kind).toBe("reveal");
    expect(zero(probe.parsed[0]!)).toBe(true);
  });
});

describe("the approver lets go of S at the reveal", () => {
  it("after the reveal the machine no longer holds the array: a later end does not touch it", async () => {
    const s = await session();
    const step = await s.n.submitPairingCode(s.code);
    if (step.kind !== "reveal") throw new Error(step.kind);
    const revealed: ApproverView = {
      ...s.pending,
      state: "revealed",
      new_epk: step.body.epk,
      new_nonce: step.body.nonce,
      new_name_ct: step.body.name_ct,
    };
    expect((await s.a.onPoll(revealed)).kind).toBe("enter_sas");
    expect(zero(s.seam)).toBe(true); // S went into K and was wiped
    s.seam.fill(7); // a marker: whatever still references the array would wipe it again at the end
    s.a.abort("cancelled");
    expect(s.seam.every((x) => x === 7)).toBe(true);
  });
});

describe("a code whose check bits fail leaves no candidate secret behind", () => {
  it("the 16 bytes read from a typo (a few bits from S) are zeroed before the error, for both kinds", async () => {
    const s = crypto.getRandomValues(new Uint8Array(16));
    for (const [text, parse, want] of [
      [await formatPairingCode(s), parsePairingCode, "pairing_checksum"],
      [await formatRecoveryCode(s), parseRecoveryCode, "recovery_checksum"],
    ] as const) {
      // the last symbol changed: it holds check bits only, so the 16 bytes read are S itself and the check fails
      const typo = text.slice(0, -1) + (text.endsWith("0") ? "1" : "0");
      probe.hashed.length = 0;
      const out = await parse(typo).then(
        () => "accepted",
        (e: { code?: string }) => e.code,
      );
      expect(out).toBe(want);
      const candidates = probe.hashed.filter((b) => b.length === 16);
      expect(candidates.length).toBeGreaterThan(0);
      for (const c of candidates) expect(zero(c)).toBe(true);
    }
  });
});
