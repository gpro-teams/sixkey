// The M3 re-review's FakeServer probes (docs/audit/internal-reviews/M3-REREVIEW.md item 5), adopted as regression tests. FS-1 is fixed: the
// FakeServer now refuses what M4 refuses. FS-2 .. FS-7 pin the remaining, documented differences from M4 (M3-NOTES §8):
// each test asserts what the FakeServer does and names M4's answer in a comment, so a change on either side shows here
// and the notes are updated with it. None of them is a decision the client depends on.
import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes, toB64 } from "../../src/core/crypto/bytes";
import { encryptVault } from "../../src/core/crypto/envelope";
import type { Vk } from "../../src/core/crypto/vk";
import {
  passwordProof,
  recoveryProof,
  type PasswordProof,
  type RecoveryProof,
} from "../../src/core/sync/crypto/auth-proofs";
import { generateDeviceKey, generateEphemeral, newDeviceId } from "../../src/core/sync/crypto/device-key";
import { sealDeviceName } from "../../src/core/sync/crypto/device-name";
import { sealBundle, type BundleAuth } from "../../src/core/sync/crypto/keybundle";
import { envelopeText, padPlaintext } from "../../src/core/sync/crypto/padding";
import { signRequest } from "../../src/core/sync/crypto/signature";
import { writeKey } from "../../src/core/sync/crypto/subkeys";
import {
  ApiError,
  SyncApi,
  type DeviceSigner,
  type EnrollSigner,
  type InitBody,
  type RegistrationSigner,
} from "../../src/core/sync/engine/api";
import { emptyVault } from "../../src/core/vault/model";
import { serializeVault } from "../../src/core/vault/validate";
import { FakeServer } from "../helpers/fake-server";
import { HOUR, P, T0, VAULT, authFor, keyrings, type Fixture } from "../helpers/sync-keyrings";

const ORIGIN = "https://api.sixkey.app";
let f: Fixture;
let auth1: BundleAuth;
let pw1: PasswordProof;
let rec1: RecoveryProof;
beforeAll(async () => {
  f = await keyrings();
  auth1 = authFor(f.k1);
  pw1 = await passwordProof(P, auth1.kdf);
  rec1 = await recoveryProof(f.code1);
}, 60_000);

type Dev = { id: string; key: CryptoKey; spki: string; signer: DeviceSigner; reg: RegistrationSigner };
async function device(id = newDeviceId()): Promise<Dev> {
  const k = await generateDeviceKey();
  return {
    id,
    key: k.privateKey,
    spki: toB64(k.spki),
    signer: { kind: "device", deviceId: id, key: k.privateKey },
    reg: { kind: "registration", deviceId: id, key: k.privateKey },
  };
}
function world() {
  const clock = { now: T0 + 5 * HOUR + 1234 };
  const server = new FakeServer({ now: () => clock.now, origin: ORIGIN });
  const api = new SyncApi({ transport: server.transport(), origin: ORIGIN, now: () => clock.now, offset: () => 0 });
  return { clock, server, api };
}
type World = ReturnType<typeof world>;
async function envelope(vk: Vk, rev: number) {
  const env = await encryptVault(padPlaintext(serializeVault(emptyVault(VAULT))), vk, { vaultId: VAULT, rev });
  return envelopeText(env);
}
async function initBody(w: World, dev: Dev, spki = dev.spki): Promise<InitBody> {
  const bundle = await sealBundle(f.v1, {
    vaultId: VAULT,
    kver: 1,
    keyring: f.k1,
    auth: auth1,
    by: dev.id,
    now: w.clock.now,
  });
  return {
    vault_id: VAULT,
    envelope: await envelope(f.v1, 1),
    bundle: bundle.raw,
    recovery_verifier: rec1.recoveryVerifier,
    password_verifier: pw1.passwordVerifier,
    write_key: await writeKey(f.v1),
    device: {
      device_id: dev.id,
      sig_pubkey: spki,
      name_ct: await sealDeviceName(f.v1, { vaultId: VAULT, deviceId: dev.id }, "Laptop"),
    },
  };
}
async function made(w: World) {
  const a = await device();
  const session = await w.server.session("a@example.com");
  await w.api.init(session, a.reg, await initBody(w, a));
  return { a, session };
}
const codeOf = (res: { status: number; body: string }) => ({
  status: res.status,
  code: res.body ? JSON.parse(res.body).error?.code : undefined,
});

describe("FakeServer decisions against M4's", () => {
  it("FS-1 (fixed) json_content_type: charset=utf8, a quoted charset and a repeated parameter are refused, 422, as M4 does (pipeline.py:269-279, openapi:1299); spaces around ';' and the case of the charset are allowed", async () => {
    const w = world();
    const { a } = await made(w);
    const body = JSON.stringify({ password_auth: pw1.passwordAuth });
    for (const ct of [
      "application/json; charset=utf8",
      'application/json; charset="utf-8"',
      "application/json; charset=utf-8; charset=utf-8",
      "application/json; charset = utf-8",
    ]) {
      const h = await signRequest(a.key, {
        host: "api.sixkey.app",
        method: "POST",
        target: "/v1/enroll/reject-all",
        signer: { deviceId: a.id },
        ts: w.clock.now,
        body,
      });
      const res = await w.server
        .transport()
        .send({ method: "POST", target: "/v1/enroll/reject-all", headers: { ...h, "Content-Type": ct }, body });
      expect(codeOf(res), ct).toEqual({ status: 422, code: "invalid_request" }); // M4: 422 invalid_request
    }
    for (const ct of ["application/json", "application/json;charset=utf-8", "Application/JSON ; Charset=UTF-8"]) {
      w.clock.now += 1000;
      const h = await signRequest(a.key, {
        host: "api.sixkey.app",
        method: "POST",
        target: "/v1/enroll/reject-all",
        signer: { deviceId: a.id },
        ts: w.clock.now,
        body,
      });
      const res = await w.server
        .transport()
        .send({ method: "POST", target: "/v1/enroll/reject-all", headers: { ...h, "Content-Type": ct }, body });
      expect(codeOf(res), ct).toEqual({ status: 200, code: undefined });
    }
  });

  it("FS-2 last_seen_at: any device-signed request writes it on the FakeServer (M4 vault.py:112: only GET /v1/sync/status)", async () => {
    const w = world();
    const { a } = await made(w);
    w.clock.now += 2 * 86_400_000;
    await w.api.getKeys(a.signer); // not a status query
    expect(w.server.state().devices[0]!.last_seen_at).toBe(Math.floor(w.clock.now / 86_400_000) * 86_400_000); // M4: still null
  });

  it("FS-3 respond with a wrong pw_auth on a gone request: the FakeServer says 410 and counts nothing (M4 enroll.py:133-135: enforce_proof first, 403 password_mismatch, counted, devices_rev +1)", async () => {
    const w = world();
    const { a } = await made(w);
    const n = await device();
    const s = await w.server.session("a@example.com");
    const { request_id: rid } = await w.api.enrollCreate(s, n.reg, {
      device_id: n.id,
      sig_pubkey: n.spki,
      commit: toB64(randomBytes(32)),
    });
    await w.api.reject(a.signer, rid, pw1.passwordAuth);
    const rev = w.server.state().vault!.devices_rev;
    const e = await w.api
      .respond(a.signer, rid, { epk: toB64((await generateEphemeral()).raw), password_auth: toB64(randomBytes(32)) })
      .then(
        () => null,
        (x: unknown) => x as ApiError,
      );
    expect({ status: e!.status, code: e!.code }).toEqual({ status: 410, code: "enroll_gone" }); // M4: 403 password_mismatch
    expect(w.server.state().devices[0]!.auth_failures).toBe(0); // M4: 1
    expect(w.server.state().vault!.devices_rev).toBe(rev); // M4: rev + 1
  });

  it("FS-4 a registration whose sig_pubkey is not a point on P-256: the FakeServer says 401 bad_signature (M4 pipeline.py:388 wire.spki_public_key: 422 invalid_request)", async () => {
    const w = world();
    const a = await device();
    const session = await w.server.session("a@example.com");
    const spki = Buffer.from(a.spki, "base64");
    spki.fill(0, 27); // the SPKI prefix and 0x04 kept, x = y = 0: not on the curve
    const e = await w.api.init(session, a.reg, await initBody(w, a, spki.toString("base64"))).then(
      () => null,
      (x: unknown) => x as ApiError,
    );
    expect({ status: e!.status, code: e!.code }).toEqual({ status: 401, code: "bad_signature" }); // M4: 422 invalid_request
  });

  it("FS-5 a target with '|': the FakeServer says 422 before authenticating (M4 sigauth.py:40 raw_target None: 401 bad_signature, after the body)", async () => {
    const w = world();
    const { a } = await made(w);
    const target = "/v1/sync/status?a=|";
    const h = await signRequest(a.key, {
      host: "api.sixkey.app",
      method: "GET",
      target: "/v1/sync/status",
      signer: { deviceId: a.id },
      ts: w.clock.now,
      body: null,
    });
    const res = await w.server.transport().send({ method: "GET", target, headers: h });
    expect(codeOf(res)).toEqual({ status: 422, code: "invalid_request" }); // M4: 401 bad_signature
  });

  it("FS-6 an expired request still on file, signed with a wrong key: the FakeServer says 410 before the signature (M4 pipeline.py:349-359 finds the row, verify_signer 401 bad_signature)", async () => {
    const w = world();
    await made(w);
    const n = await device();
    const s = await w.server.session("a@example.com");
    const { request_id: rid, expires_at } = await w.api.enrollCreate(s, n.reg, {
      device_id: n.id,
      sig_pubkey: n.spki,
      commit: toB64(randomBytes(32)),
    });
    w.clock.now = expires_at + 1;
    const wrong = await generateDeviceKey();
    const e = await w.api.enrollGet({ kind: "enroll", rid, key: wrong.privateKey } as EnrollSigner, rid).then(
      () => null,
      (x: unknown) => x as ApiError,
    );
    expect({ status: e!.status, code: e!.code }).toEqual({ status: 410, code: "enroll_gone" }); // M4: 401 bad_signature
  });

  it("FS-7 the account session of an account the FakeServer no longer knows is session_invalid (M4 account_session.py:39-74 checks only the JWT: GET /v1/account answers 200 has_vault false)", async () => {
    const w = world();
    const s = await w.server.session("gone@example.com");
    delete w.server.db.accounts[s.sub]; // as DELETE /v1/account leaves it on the FakeServer
    const e = await w.api.account(s).then(
      () => null,
      (x: unknown) => x as ApiError,
    );
    expect({ status: e!.status, code: e!.code }).toEqual({ status: 401, code: "session_invalid" }); // M4: 200 { has_vault: false } until exp
  });

  it("aligned: pending_enrollments counts unexpired approval requests in state pending only (M4 vault.py:108-110)", async () => {
    const w = world();
    const { a } = await made(w);
    const n1 = await device();
    const { request_id: r1 } = await w.api.enrollCreate(await w.server.session("a@example.com"), n1.reg, {
      device_id: n1.id,
      sig_pubkey: n1.spki,
      commit: toB64(randomBytes(32)),
    });
    const n2 = await device();
    await w.api.enrollCreate(await w.server.session("a@example.com"), n2.reg, {
      device_id: n2.id,
      sig_pubkey: n2.spki,
      commit: toB64(randomBytes(32)),
    });
    const n3 = await device();
    await w.api.enrollRecovery(await w.server.session("a@example.com"), n3.reg, {
      device_id: n3.id,
      sig_pubkey: n3.spki,
      recovery_auth: rec1.recoveryAuth,
    });
    expect((await w.api.status(a.signer)).pending_enrollments).toBe(2);
    await w.api.respond(a.signer, r1, { epk: toB64((await generateEphemeral()).raw), password_auth: pw1.passwordAuth });
    expect((await w.api.status(a.signer)).pending_enrollments).toBe(1); // a responded request no longer counts (both servers)
    w.clock.now += 11 * 60_000;
    expect((await w.api.status(a.signer)).pending_enrollments).toBe(0);
  });
});
