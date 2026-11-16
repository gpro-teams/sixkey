// The FakeServer against the contract (M3; api/openapi.yaml, contract/vectors/sync-v1.json, SYNC-DESIGN §5): every one of
// the 29 operations, the error codes it answers with, the vectors that apply to a server, and the fault machinery the
// engine tests use. Every response is validated against the contract by the server itself (validateWire), and every
// request it receives against the request schema (violations), so a green run also says the client in api.ts sends
// what the contract describes.
import { beforeAll, describe, expect, it } from "vitest";
import { fromB64, randomBytes, sha256, toB64 } from "../../src/core/crypto/bytes";
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
import { TAG } from "../../src/core/sync/crypto/labels";
import { envelopeHead, envelopeText, padPlaintext } from "../../src/core/sync/crypto/padding";
import { signRequest } from "../../src/core/sync/crypto/signature";
import { taggedDigest, writeKey, writeProof } from "../../src/core/sync/crypto/subkeys";
import {
  ApiError,
  SyncApi,
  sessionFromToken,
  type AccountSession,
  type DeviceSigner,
  type EnrollSigner,
  type InitBody,
  type RegistrationSigner,
} from "../../src/core/sync/engine/api";
import { NetworkError, type HttpRequest } from "../../src/core/sync/engine/transport";
import { createClock } from "../../src/core/vault/hlc";
import { emptyVault } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { serializeVault } from "../../src/core/vault/validate";
import { loadContract, requestSchema, findOperation, validate } from "../helpers/contract";
import { contractOperations, FakeServer } from "../helpers/fake-server";
import { FaultyTransport, operationKey } from "../helpers/faulty-transport";
import { HOUR, P, T0, VAULT, authFor, keyrings, type Fixture } from "../helpers/sync-keyrings";

const ORIGIN = "https://api.sixkey.app";
const V = loadContract().vectors.groups;

let f: Fixture;
let auth1: BundleAuth;
let pw1: PasswordProof; // pw_auth of P under auth1 (the stored verifier after init)
let rec1: RecoveryProof; // recovery code 1
let rec2: RecoveryProof;
beforeAll(async () => {
  f = await keyrings();
  auth1 = authFor(f.k1);
  pw1 = await passwordProof(P, auth1.kdf); // the one PBKDF2 of this file at set-up
  rec1 = await recoveryProof(f.code1);
  rec2 = await recoveryProof(f.code2);
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
  const mkApi = (
    o: {
      transport?: ReturnType<FakeServer["transport"]>;
      offset?: () => number;
      origin?: string;
      onServerTime?: (s: { serverMs: number; receivedAt: number }) => void;
    } = {},
  ) =>
    new SyncApi({
      transport: o.transport ?? server.transport(),
      origin: o.origin ?? ORIGIN,
      now: () => clock.now,
      offset: o.offset ?? (() => 0),
      ...(o.onServerTime ? { onServerTime: o.onServerTime } : {}),
    });
  return { clock, server, api: mkApi(), mkApi };
}
type World = ReturnType<typeof world>;

let entryClock = 0;
/** An upload envelope (padded plaintext, §4.1) of a vault with `n` entries, under `vk`, at `rev`: the object and its text. */
async function envelope(vk: Vk, rev: number, n = 0) {
  let v = emptyVault(VAULT);
  const clock = createClock("aaaa", { now: () => T0 + ++entryClock });
  for (let i = 0; i < n; i++)
    v = addEntry(
      v,
      {
        type: "totp",
        issuer: `I${i}`,
        label: "a",
        secret: "JBSWY3DPEHPK3PXP",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      },
      clock,
    ).vault;
  const env = await encryptVault(padPlaintext(serializeVault(v)), vk, { vaultId: VAULT, rev });
  return { env, text: envelopeText(env) };
}

async function initBody(w: World, dev: Dev, o: { kver?: number } = {}) {
  const bundle = await sealBundle(f.v1, {
    vaultId: VAULT,
    kver: o.kver ?? 1,
    keyring: f.k1,
    auth: auth1,
    by: dev.id,
    now: w.clock.now,
  });
  const body: InitBody = {
    vault_id: VAULT,
    envelope: (await envelope(f.v1, 1)).text,
    bundle: bundle.raw,
    recovery_verifier: rec1.recoveryVerifier,
    password_verifier: pw1.passwordVerifier,
    write_key: await writeKey(f.v1),
    device: {
      device_id: dev.id,
      sig_pubkey: dev.spki,
      name_ct: await sealDeviceName(f.v1, { vaultId: VAULT, deviceId: dev.id }, "Laptop"),
    },
  };
  return { body, bundle };
}

/** A vault made by device A through init, for `email`. */
async function made(w: World, email = "a@example.com") {
  const a = await device();
  const session = await w.server.session(email);
  const { body, bundle } = await initBody(w, a);
  expect(await w.api.init(session, a.reg, body)).toMatchObject({ version: 1, kver: 1 });
  return { a, session, body, bundle };
}

/** A PUT /v1/vault body: an envelope at if_version + 1 under `vk`, its write proof with `proofVk`'s K_write. */
async function putBody(
  ifVersion: number,
  o: { vk?: Vk; proofVk?: Vk; rev?: number; cursor?: { cur?: string; pending: string }; n?: number } = {},
) {
  const { env, text } = await envelope(o.vk ?? f.v1, o.rev ?? ifVersion + 1, o.n ?? 1);
  const write_proof = await writeProof(o.proofVk ?? o.vk ?? f.v1, {
    vaultId: VAULT,
    ifVersion,
    checksum: env.checksum,
  });
  return {
    if_version: ifVersion,
    envelope: text,
    write_proof,
    cursor: o.cursor ?? { pending: toB64(randomBytes(16)) },
  };
}

const rejects = async (p: Promise<unknown>, status: number, code: string) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e, `expected ${status} ${code}`).toBeInstanceOf(ApiError);
  expect({ status: (e as ApiError).status, code: (e as ApiError).code }).toEqual({ status, code });
  return e as ApiError;
};

/** A raw signed request, for the cases api.ts would never build. */
async function raw(
  w: World,
  dev: Dev,
  req: {
    method: "GET" | "PUT" | "POST";
    target: string;
    body?: string;
    signTarget?: string;
    signBody?: string;
    host?: string;
    ts?: number;
    extra?: Record<string, string>;
  },
) {
  const h = await signRequest(dev.key, {
    host: req.host ?? "api.sixkey.app",
    method: req.method,
    target: req.signTarget ?? req.target,
    signer: { deviceId: dev.id },
    ts: req.ts ?? w.clock.now,
    body: req.signBody ?? req.body ?? null,
  });
  const r: HttpRequest = {
    method: req.method,
    target: req.target,
    headers: { ...h, ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}), ...req.extra },
    ...(req.body !== undefined ? { body: req.body } : {}),
  };
  return w.server.transport().send(r);
}
const codeOf = (res: { status: number; body: string }) => ({
  status: res.status,
  code: res.body ? JSON.parse(res.body).error?.code : undefined,
});

describe("the FakeServer and the contract", () => {
  it("routes exactly the contract's 29 operations", () => {
    const ops = contractOperations();
    expect(ops).toHaveLength(29);
    for (const k of ops)
      expect(
        operationKey(
          k.split(" ")[0]!,
          k
            .split(" ")[1]!
            .replace("{v}", "3")
            .replace("{id}", "qqqqqqqqqqqqqqqqqqqqqg")
            .replace("{rid}", "00000000-0000-4000-8000-000000000000"),
        ),
        k,
      ).toBe(k);
    expect(operationKey("PATCH", "/v1/devices/fork")).toBe("PATCH /v1/devices/{id}"); // a PATCH there is a rename of a (non-)device
    expect(operationKey("POST", "/v1/devices/fork")).toBe("POST /v1/devices/fork");
    expect(operationKey("GET", "/v1/inbox")).toBeNull();
  });

  it("a tour of every operation, each response validated against the contract, and no request breaking it", async () => {
    const w = world();
    const { a, session } = await made(w);
    const b = await device();
    expect(await w.api.healthz()).toBe(true);
    expect(await w.api.account(session)).toMatchObject({ has_vault: true, device_count: 1 });
    const st = await w.api.status(a.signer);
    expect(st).toMatchObject({
      version: 1,
      kver: 1,
      vk_id: f.v1.id,
      pending_enrollments: 0,
      devices_rev: 1,
      min_client_version: "0.1.0",
    }); // M4's default
    expect(st.head).toBe(await envelopeHead(w.server.state().vault!.envelope));
    expect((await w.api.getVault(a.signer)).envelope).toBe(w.server.state().vault!.envelope); // byte for byte
    expect(await w.api.putVault(a.signer, await putBody(1))).toMatchObject({ version: 2, forked: false });
    expect((await w.api.versions(a.signer)).map((x) => x.version)).toEqual([2, 1]);
    expect((await w.api.version(a.signer, 1)).envelope).toBe(w.server.state().history[0]!.envelope);
    expect((await w.api.getKeys(a.signer)).bundle).toBe(w.server.state().vault!.bundle);
    // enrolment by approval, the new device b
    const sb = await w.server.session("a@example.com");
    const commit = toB64(randomBytes(32));
    const { request_id: rid } = await w.api.enrollCreate(sb, b.reg, { device_id: b.id, sig_pubkey: b.spki, commit });
    const eb: EnrollSigner = { kind: "enroll", rid, key: b.key };
    expect(await w.api.enrollList(a.signer)).toMatchObject([{ request_id: rid, state: "pending" }]);
    expect(await w.api.enrollGet(eb, rid)).toMatchObject({ state: "pending" });
    const epkA = toB64((await generateEphemeral()).raw);
    await w.api.respond(a.signer, rid, { epk: epkA, password_auth: pw1.passwordAuth });
    await w.api.reveal(eb, rid, {
      epk: toB64((await generateEphemeral()).raw),
      nonce: toB64(randomBytes(32)),
      name_ct: toB64(randomBytes(188)),
    });
    expect(await w.api.enrollGet(a.signer, rid)).toMatchObject({ state: "revealed", new_device_id: b.id, commit });
    const nameB = await sealDeviceName(f.v1, { vaultId: VAULT, deviceId: b.id }, "Phone");
    await w.api.approve(a.signer, rid, {
      transcript_hash: toB64(randomBytes(32)),
      payload: toB64(randomBytes(120)),
      name_ct: nameB,
      sig_pubkey_sha256: toB64(await sha256(fromB64(b.spki))),
      password_auth: pw1.passwordAuth,
    });
    expect(await w.api.enrollGet(eb, rid)).toMatchObject({
      state: "approved",
      approver_device_id: a.id,
      approver_epk: epkA,
    });
    expect(await w.api.complete(eb, rid)).toMatchObject({ device_id: b.id });
    // devices
    const devs = await w.api.devices(b.signer);
    expect(devs.current).toBe(b.id);
    expect(devs.devices.find((d) => d.device_id === b.id)).toMatchObject({
      joined_via: "approval",
      approved_by: a.id,
      name_ct: nameB,
    });
    await w.api.rename(b.signer, b.id, {
      name_ct: await sealDeviceName(f.v1, { vaultId: VAULT, deviceId: b.id }, "Phone 2"),
      password_auth: pw1.passwordAuth,
    });
    const c = await device();
    const nk = await generateDeviceKey();
    expect(
      await w.api.fork(b.signer, nk.privateKey, {
        new_device_id: c.id,
        new_sig_pubkey: toB64(nk.spki),
        name_ct: await sealDeviceName(f.v1, { vaultId: VAULT, deviceId: c.id }, "Clone"),
        password_auth: pw1.passwordAuth,
      }),
    ).toMatchObject({ device_id: c.id });
    // recovery enrolment of d, then reject and reject-all on others
    const d = await device();
    const sd = await w.server.session("a@example.com");
    const r = await w.api.enrollRecovery(sd, d.reg, {
      device_id: d.id,
      sig_pubkey: d.spki,
      recovery_auth: rec1.recoveryAuth,
    });
    expect(r).toMatchObject({ vault_id: VAULT, version: 2, kver: 1 });
    expect(
      await w.api.complete({ kind: "enroll", rid: r.request_id, key: d.key }, r.request_id, {
        name_ct: await sealDeviceName(f.v1, { vaultId: VAULT, deviceId: d.id }, "Tablet"),
      }),
    ).toMatchObject({ device_id: d.id });
    const e = await device();
    const se = await w.server.session("a@example.com");
    const { request_id: rid2 } = await w.api.enrollCreate(se, e.reg, { device_id: e.id, sig_pubkey: e.spki, commit });
    await w.api.reject(a.signer, rid2, pw1.passwordAuth);
    const e2 = await device();
    const { request_id: rid3 } = await w.api.enrollCreate(se, e2.reg, {
      device_id: e2.id,
      sig_pubkey: e2.spki,
      commit,
    });
    await w.api.reject({ kind: "enroll", rid: rid3, key: e2.key }, rid3);
    const e3 = await device();
    await w.api.enrollCreate(se, e3.reg, { device_id: e3.id, sig_pubkey: e3.spki, commit });
    expect(await w.api.rejectAll(a.signer, pw1.passwordAuth)).toBe(1);
    // keys: a recovery-code change (P4: only the recovery verifier), then a rotation
    const k1r = await sealBundle(f.v1, {
      vaultId: VAULT,
      kver: 2,
      keyring: {
        ...f.k1,
        wraps: f.k1.wraps.map((x) => (x.method === "recovery" ? { ...x, iv: toB64(randomBytes(12)) } : x)),
      },
      auth: auth1,
      by: a.id,
      now: w.clock.now,
    });
    expect(
      await w.api.putKeys(a.signer, {
        if_kver: 1,
        bundle: k1r.raw,
        password_auth: pw1.passwordAuth,
        recovery_verifier: rec2.recoveryVerifier,
      }),
    ).toMatchObject({ kver: 2 });
    const rot = await rotateBody(w, a, { ifVersion: 2, ifKver: 2 });
    expect(await w.api.rotate(a.signer, rot.body)).toMatchObject({ version: 3, kver: 3 });
    expect(await w.api.revoke(a.signer, c.id, rot.pw2.passwordAuth)).toMatchObject({
      revoked_at: Math.floor(w.clock.now / HOUR) * HOUR,
    });
    expect(await w.api.deleteVersions(a.signer, rot.pw2.passwordAuth)).toBe(2);
    await w.api.otp("someone@example.com");
    expect(await w.api.verify("someone@example.com", w.server.inbox("someone@example.com"))).toMatchObject({
      account_token: expect.any(String),
    });
    const fresh = await w.server.session("a@example.com");
    await w.api.deleteAccount(a.signer, fresh, rot.pw2.passwordAuth);
    await rejects(w.api.status(b.signer), 401, "unknown_device"); // every row of the account went with it (cascade)
    const ops = new Set(w.server.requests.map((x) => x.op));
    for (const k of contractOperations()) expect(ops.has(k), k).toBe(true);
    expect(w.server.violations).toEqual([]);
    expect(w.server.bugs).toEqual([]);
  }, 60_000);
});

let pw2Cache: PasswordProof | null = null;
/** A rotation VK1 → VK2 by `dev` (§3.8 P3): keyring2 with new auth, both verifiers, the envelope under VK2. */
async function rotateBody(
  w: World,
  dev: Dev,
  o: { ifVersion: number; ifKver: number; kver?: number; proofVk?: Vk; names?: { device_id: string }[] },
) {
  const auth2 = authFor(f.k2);
  pw2Cache ??= await passwordProof(P, auth2.kdf);
  const bundle = await sealBundle(f.v2, {
    vaultId: VAULT,
    kver: o.kver ?? o.ifKver + 1,
    keyring: f.k2,
    auth: auth2,
    by: dev.id,
    now: w.clock.now,
  });
  const { env, text } = await envelope(f.v2, o.ifVersion + 1, 2);
  const names = o.names ?? w.server.state().devices;
  const body = {
    if_version: o.ifVersion,
    if_kver: o.ifKver,
    envelope: text,
    write_proof: await writeProof(o.proofVk ?? f.v1, {
      vaultId: VAULT,
      ifVersion: o.ifVersion,
      checksum: env.checksum,
    }),
    new_write_key: await writeKey(f.v2),
    bundle: bundle.raw,
    password_auth: pw1.passwordAuth,
    recovery_verifier: rec2.recoveryVerifier,
    password_verifier: pw2Cache.passwordVerifier,
    device_names: await Promise.all(
      names.map(async (d) => ({
        device_id: d.device_id,
        name_ct: await sealDeviceName(f.v2, { vaultId: VAULT, deviceId: d.device_id }, "renamed"),
      })),
    ),
  };
  return { body, bundle, pw2: pw2Cache };
}

describe("signatures (§5.2)", () => {
  it("contract order: unknown device, then the signature, then revoked, then the clock", async () => {
    const w = world();
    const { a } = await made(w);
    const stranger = await device();
    await rejects(w.api.status(stranger.signer), 401, "unknown_device");
    const wrongKey = await device(a.id); // a's id, another key
    await rejects(w.api.status(wrongKey.signer), 401, "bad_signature");
    // a changed body, target or host breaks the signature
    const body = JSON.stringify(await putBody(1));
    expect(
      codeOf(
        await raw(w, a, {
          method: "PUT",
          target: "/v1/vault",
          body,
          signBody: body.replace('"if_version":1', '"if_version":2'),
        }),
      ),
    ).toEqual({ status: 401, code: "bad_signature" });
    expect(codeOf(await raw(w, a, { method: "GET", target: "/v1/sync/status", signTarget: "/v1/keys" }))).toEqual({
      status: 401,
      code: "bad_signature",
    });
    expect(codeOf(await raw(w, a, { method: "GET", target: "/v1/sync/status", host: "api.sixkey.app:8443" }))).toEqual({
      status: 401,
      code: "bad_signature",
    });
    expect(codeOf(await raw(w, a, { method: "GET", target: "/v1/sync/status" }))).toEqual({
      status: 200,
      code: undefined,
    });
    // the clock window: 300 s
    expect(codeOf(await raw(w, a, { method: "GET", target: "/v1/sync/status", ts: w.clock.now - 300_000 }))).toEqual({
      status: 200,
      code: undefined,
    });
    expect(codeOf(await raw(w, a, { method: "GET", target: "/v1/sync/status", ts: w.clock.now + 300_001 }))).toEqual({
      status: 401,
      code: "clock_skew",
    });
    // revoked: 403, but only once the signature verified (P6)
    const b = await device();
    const sb = await w.server.session("a@example.com");
    await w.api
      .enrollRecovery(sb, b.reg, { device_id: b.id, sig_pubkey: b.spki, recovery_auth: rec1.recoveryAuth })
      .then((r) => w.api.complete({ kind: "enroll", rid: r.request_id, key: b.key }, r.request_id));
    await w.api.revoke(b.signer, a.id, pw1.passwordAuth);
    await rejects(w.api.status(a.signer), 403, "device_revoked");
    await rejects(w.api.status(wrongKey.signer), 401, "bad_signature");
    expect(w.server.bugs).toEqual([]);
  });

  it("the account session's sub is in a registration's signing input, and its signer is the body's device_id", async () => {
    const w = world();
    const a = await device();
    const session = await w.server.session("a@example.com");
    const { body } = await initBody(w, a);
    await rejects(
      w.api.init({ ...session, sub: "11111111-1111-4111-8111-111111111111" }, a.reg, body),
      401,
      "bad_signature",
    );
    const other = await device();
    await rejects(w.api.init(session, other.reg, body), 401, "bad_signature"); // signed by a key that is not the body's
    await rejects(w.api.init({ token: "nope", sub: session.sub }, a.reg, body), 401, "session_invalid");
    w.clock.now += 900_000;
    await rejects(w.api.init(session, a.reg, body), 401, "session_invalid"); // 900 s
  });

  it("clock_skew carries server_time; api.ts retries once with the offset it learns from it (§4.14)", async () => {
    const w = world();
    const { a } = await made(w);
    w.server.skewMs = 400_000;
    await rejects(w.api.status(a.signer), 401, "clock_skew");
    expect(w.server.requests.filter((r) => r.op === "GET /v1/sync/status").map((r) => r.status)).toEqual([401, 401]); // one retry, not more
    let off = 0;
    const api = w.mkApi({ offset: () => off, onServerTime: (s) => (off = s.serverMs - s.receivedAt) });
    expect((await api.status(a.signer)).version).toBe(1);
  });

  it("removed mechanisms are refused: a Sixkey-Cursor or If-None-Match header, a '|' in the target (recorded as violations)", async () => {
    const w = world();
    const { a } = await made(w);
    expect(
      codeOf(await raw(w, a, { method: "GET", target: "/v1/sync/status", extra: { "Sixkey-Cursor": "x" } })),
    ).toEqual({ status: 422, code: "invalid_request" });
    expect(codeOf(await raw(w, a, { method: "GET", target: "/v1/vault", extra: { "If-None-Match": "x" } }))).toEqual({
      status: 422,
      code: "invalid_request",
    });
    expect(
      codeOf(await raw(w, a, { method: "GET", target: "/v1/sync/status?a=|", signTarget: "/v1/sync/status" })),
    ).toEqual({ status: 422, code: "invalid_request" });
    expect(w.server.violations.map((v) => v.errors[0])).toEqual([
      "removed header sixkey-cursor",
      "removed header if-none-match",
    ]);
  });

  it("requests are strict: an unknown member or a non-integer number is 422 and a schema violation is recorded; bodies over the limit are 413", async () => {
    const w = world();
    const { a } = await made(w);
    const body = await putBody(1);
    expect(
      codeOf(await raw(w, a, { method: "PUT", target: "/v1/vault", body: JSON.stringify({ ...body, extra: 1 }) })),
    ).toEqual({ status: 422, code: "invalid_request" });
    expect(w.server.violations).toHaveLength(1);
    expect(
      codeOf(
        await raw(w, a, {
          method: "PUT",
          target: "/v1/vault",
          body: JSON.stringify(body).replace('"if_version":1', '"if_version":1.0'),
        }),
      ),
    ).toEqual({ status: 422, code: "invalid_request" });
    expect(
      codeOf(
        await raw(w, a, {
          method: "POST",
          target: "/v1/devices/" + a.id + "/revoke",
          body: JSON.stringify({ password_auth: "x".repeat(70_000) }),
        }),
      ),
    ).toEqual({ status: 413, code: "too_large" });
  });
});

describe("the vault (§3.1, §4.2, §4.10, §5.3)", () => {
  it("init is idempotent on the identical request; anything else is vault_exists; a device id in use is device_exists", async () => {
    const w = world();
    const { a, session, body } = await made(w);
    expect(await w.api.init(session, a.reg, body)).toMatchObject({ version: 1, kver: 1 }); // the identical retry (D4)
    await w.api.putVault(a.signer, await putBody(1));
    expect(await w.api.init(session, a.reg, body)).toMatchObject({ version: 1, kver: 1 }); // still, after the vault moved on
    const moved = {
      ...body,
      bundle: JSON.stringify({ ...JSON.parse(body.bundle), at: JSON.parse(body.bundle).at + HOUR }),
    };
    await rejects(w.api.init(session, a.reg, moved), 409, "vault_exists"); // another bundle text
    const w2s = await w.server.session("b@example.com");
    await rejects(w.api.init(w2s, a.reg, body), 409, "device_exists"); // a's id, registered in a's account
    expect(w.server.state("a@example.com").vault!.version).toBe(2);
  });

  it("init's keyless checks: rev 1, kver 1, by = the signer, hour-aligned times (422)", async () => {
    const w = world();
    const a = await device();
    const session = await w.server.session("a@example.com");
    const { body } = await initBody(w, a);
    await rejects(
      w.api.init(session, a.reg, { ...body, envelope: (await envelope(f.v1, 2)).text }),
      422,
      "invalid_request",
    );
    await rejects(
      w.api.init(session, a.reg, { ...body, bundle: (await initBody(w, a, { kver: 2 })).body.bundle }),
      422,
      "invalid_request",
    );
    const notMine = await sealBundle(f.v1, {
      vaultId: VAULT,
      kver: 1,
      keyring: f.k1,
      auth: auth1,
      by: newDeviceId(),
      now: w.clock.now,
    });
    await rejects(w.api.init(session, a.reg, { ...body, bundle: notMine.raw }), 422, "invalid_request");
    const b = JSON.parse(body.bundle);
    b.at += 1;
    await rejects(w.api.init(session, a.reg, { ...body, bundle: JSON.stringify(b) }), 422, "invalid_request"); // N16 (a schema violation too)
    expect(await w.api.account(session)).toEqual({ has_vault: false, server_time: expect.any(Number) });
  });

  it("PUT: write proof, rev, CAS on version then vk_id; 409 version_conflict carries version, vk_id, kver", async () => {
    const w = world();
    const { a } = await made(w);
    await rejects(w.api.putVault(a.signer, await putBody(1, { proofVk: f.v2 })), 403, "write_denied");
    await rejects(w.api.putVault(a.signer, await putBody(1, { rev: 3 })), 422, "invalid_request");
    await rejects(w.api.putVault(a.signer, await putBody(1, { vk: f.v2, proofVk: f.v1 })), 409, "vk_mismatch");
    expect(await w.api.putVault(a.signer, await putBody(1))).toMatchObject({ version: 2 });
    const e = await rejects(w.api.putVault(a.signer, await putBody(1)), 409, "version_conflict");
    expect(e.details).toEqual({ version: 2, vk_id: f.v1.id, kver: 1 });
    expect(w.server.state().history.map((h) => h.version)).toEqual([1, 2]);
  });

  it("20 concurrent PUTs with the same if_version: exactly one is accepted", async () => {
    const w = world();
    const { a } = await made(w);
    const bodies = await Promise.all(Array.from({ length: 20 }, () => putBody(1)));
    const out = await Promise.allSettled(bodies.map((b) => w.api.putVault(a.signer, b)));
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(out.filter((o) => o.status === "rejected").map((o) => (o as PromiseRejectedResult).reason.code)).toEqual(
      Array(19).fill("version_conflict"),
    );
    expect(w.server.state().vault!.version).toBe(2);
  });

  it("an envelope over MAX_ENVELOPE_BYTES is 413 too_large", async () => {
    const w = world();
    const { a } = await made(w);
    const env = await encryptVault(new Uint8Array(6_400_000).fill(0x20), f.v1, { vaultId: VAULT, rev: 2 });
    const write_proof = await writeProof(f.v1, { vaultId: VAULT, ifVersion: 1, checksum: env.checksum });
    await rejects(
      w.api.putVault(a.signer, {
        if_version: 1,
        envelope: envelopeText(env),
        write_proof,
        cursor: { pending: toB64(randomBytes(16)) },
      }),
      413,
      "too_large",
    );
  });

  it("the cursor (§4.10): a chain, a lost response's replay not forked, a second copy of the identity forked", async () => {
    const w = world();
    const { a } = await made(w);
    const c = () => toB64(randomBytes(16));
    const p1 = c();
    expect((await w.api.putVault(a.signer, await putBody(1, { cursor: { pending: p1 } }))).forked).toBe(false); // first write: no cur
    expect(w.server.state().devices[0]!.cursor).toBe(p1);
    const p2 = c();
    expect((await w.api.putVault(a.signer, await putBody(2, { cursor: { cur: p1, pending: p2 } }))).forked).toBe(false);
    // the answer to {cur: p2, pending: p3} is lost; the device still has cur p2, pending p3, and writes again
    const p3 = c();
    w.server.fault({ match: "PUT /v1/vault", kind: "after" });
    await expect(
      w.api.putVault(a.signer, await putBody(3, { cursor: { cur: p2, pending: p3 } })),
    ).rejects.toBeInstanceOf(NetworkError);
    expect((await w.api.putVault(a.signer, await putBody(4, { cursor: { cur: p2, pending: p3 } }))).forked).toBe(false);
    // a clone with the same identity wrote from p3 on, then this copy (still at cur p3) writes
    const p4 = c();
    expect((await w.api.putVault(a.signer, await putBody(5, { cursor: { cur: p3, pending: p4 } }))).forked).toBe(false);
    const p5 = c();
    expect((await w.api.putVault(a.signer, await putBody(6, { cursor: { cur: p3, pending: p5 } }))).forked).toBe(true);
    expect(w.server.state().devices[0]!.cursor).toBe(p4); // unchanged by the forked write
  });

  it("history: newest first, each version byte for byte; DELETE keeps only the head, idempotent, with pw_auth", async () => {
    const w = world();
    const { a } = await made(w);
    await w.api.putVault(a.signer, await putBody(1));
    await w.api.putVault(a.signer, await putBody(2));
    const h = await w.api.versions(a.signer);
    expect(h.map((x) => x.version)).toEqual([3, 2, 1]);
    for (const x of h) expect(x.created_at % HOUR).toBe(0);
    expect((await w.api.version(a.signer, 2)).envelope).toBe(w.server.state().history[1]!.envelope);
    await rejects(w.api.version(a.signer, 9), 404, "not_found");
    await rejects(w.api.deleteVersions(a.signer, toB64(randomBytes(32))), 403, "password_mismatch");
    expect(await w.api.deleteVersions(a.signer, pw1.passwordAuth)).toBe(2);
    expect(await w.api.deleteVersions(a.signer, pw1.passwordAuth)).toBe(0);
    expect((await w.api.versions(a.signer)).map((x) => x.version)).toEqual([3]);
  });

  it("an honest rollback (snapshot/restore): the version goes back and is reused with another head (D5)", async () => {
    const w = world();
    const { a } = await made(w);
    await w.api.putVault(a.signer, await putBody(1));
    const snap = w.server.snapshot();
    await w.api.putVault(a.signer, await putBody(2));
    const before = await w.api.status(a.signer);
    w.server.restore(snap);
    const after = await w.api.status(a.signer);
    expect(after.version).toBe(2);
    await w.api.putVault(a.signer, await putBody(2));
    const reused = await w.api.status(a.signer);
    expect(reused.version).toBe(before.version);
    expect(reused.head).not.toBe(before.head);
  });

  it("admin mutators: a head nobody could decrypt, an old bundle replayed", async () => {
    const w = world();
    const { a, bundle } = await made(w);
    const v = await w.server.adminSetHead('{"garbage":true}');
    expect(v).toBe(2);
    expect((await w.api.getVault(a.signer)).envelope).toBe('{"garbage":true}');
    w.server.adminSetBundle(bundle.raw, 1);
    expect((await w.api.getKeys(a.signer)).bundle).toBe(bundle.raw);
  });
});

describe("keys (§2.3, §3.6.0, §3.8)", () => {
  /** A seeded server holding the vectors' keybundle (kver 3) for device qqqq…g, whose pw_auth `pwAuth` matches. */
  async function seeded() {
    const w = world();
    const dev = await device("qqqqqqqqqqqqqqqqqqqqqg"); // the vectors' bundles are by this device
    const session = await w.server.session("v@example.com");
    const pwAuth = toB64(randomBytes(32));
    const stored = V.keybundle.raw as string;
    const hour = Math.floor(w.clock.now / HOUR) * HOUR;
    const env = await envelope(f.v1, 1);
    const acct = w.server.db.accounts[session.sub]!;
    acct.vault = {
      vault_id: "test-vault-0001",
      version: 1,
      vk_id: JSON.parse(stored).keyring.vkId,
      envelope: env.text,
      head: await envelopeHead(env.text),
      devices_rev: 1,
      size_bytes: env.text.length,
      kver: 3,
      bundle: stored,
      recovery_verifier: toB64(randomBytes(32)),
      password_verifier: toB64(await taggedDigest(TAG.passwordVerifier, fromB64(pwAuth))),
      write_key: toB64(randomBytes(32)),
      created_at: hour,
      updated_at: hour,
    };
    w.server.db.devices[dev.id] = {
      device_id: dev.id,
      user: session.sub,
      sig_pubkey: dev.spki,
      name_ct: null,
      joined_via: "first",
      approved_by: null,
      created_at: hour,
      last_seen_at: null,
      revoked_at: null,
      auth_failures: 0,
      cursor: null,
    };
    return { w, dev, pwAuth, stored };
  }
  const withKver = (text: string, kver: number) => text.replace(/"kver":\d+/, `"kver":${kver}`);

  it("the vectors' kver rules (kver_rules.server_accept): the window, the CAS on if_kver, byte-identical replay", async () => {
    for (const c of V.kver_rules.server_accept) {
      const s = await seeded();
      if (c.server_kver !== 3) {
        // reach the server kver first, with the very text that is replayed
        await s.w.api.putKeys(s.dev.signer, {
          if_kver: 3,
          bundle: withKver(s.stored, c.server_kver),
          password_auth: s.pwAuth,
        });
      }
      // a text other than the stored one with the same content (members reversed), at the case's kver
      const text = c.raw_equals_stored
        ? withKver(s.stored, c.server_kver)
        : withKver(JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(s.stored)).reverse())), c.kver);
      const p = s.w.api.putKeys(s.dev.signer, { if_kver: c.if_kver, bundle: text, password_auth: s.pwAuth });
      const [status, what] = (c.expect as string).split(" ") as [string, string];
      if (status === "200")
        expect(await p, c.name).toMatchObject({ kver: c.raw_equals_stored ? c.server_kver : c.kver });
      else await rejects(p, Number(status), what);
      expect(s.w.server.bugs).toEqual([]);
    }
  });

  it("the vectors' P4 cases (keys_repair.p4_cases): exactly the verifiers the change requires, compared by iv and wrapped", async () => {
    for (const c of V.keys_repair.p4_cases) {
      const s = await seeded();
      const v = toB64(randomBytes(32));
      const send = (rv: boolean, pv: boolean) =>
        s.w.api.putKeys(s.dev.signer, {
          if_kver: 3,
          bundle: c.bundle,
          password_auth: s.pwAuth,
          ...(rv ? { recovery_verifier: v } : {}),
          ...(pv ? { password_verifier: v } : {}),
        });
      if (c.expect === "422 invalid_request") {
        for (const [rv, pv] of [
          [false, false],
          [true, false],
          [false, true],
          [true, true],
        ] as const)
          await rejects(send(rv, pv), 422, "invalid_request");
        continue;
      }
      for (const [rv, pv] of [
        [false, false],
        [true, false],
        [false, true],
        [true, true],
      ] as const) {
        if (rv === c.expect.recovery_verifier && pv === c.expect.password_verifier) continue;
        await rejects(send(rv, pv), 422, "invalid_request");
      }
      expect(await send(c.expect.recovery_verifier, c.expect.password_verifier), c.name).toMatchObject({ kver: 7 });
    }
  });

  it("pw_auth failures only count (cap 10, devices_rev with each), never lock: a valid proof still works and resets the count", async () => {
    const s = await seeded();
    const bad = toB64(randomBytes(32));
    const rev0 = s.w.server.state().vault!.devices_rev;
    for (let i = 0; i < 12; i++) {
      s.w.clock.now += 7_000; // under M4's 10 wrong proofs a minute per device (A10), so the same test holds against it
      await rejects(
        s.w.api.putKeys(s.dev.signer, { if_kver: 3, bundle: withKver(s.stored, 4), password_auth: bad }),
        403,
        "password_mismatch",
      );
    }
    expect(s.w.server.state().devices[0]!.auth_failures).toBe(10);
    expect(s.w.server.state().vault!.devices_rev).toBe(rev0 + 10);
    expect(
      await s.w.api.putKeys(s.dev.signer, { if_kver: 3, bundle: withKver(s.stored, 4), password_auth: s.pwAuth }),
    ).toMatchObject({ kver: 4 });
    expect(s.w.server.state().devices[0]!.auth_failures).toBe(0);
  });

  it("a password change's replay is the idempotent 200 even though its old pw_auth no longer matches (identical text first); a stale if_kver is keys_conflict before any proof (A5)", async () => {
    const w = world();
    const { a } = await made(w);
    const auth1b = authFor(f.k1b);
    const changed = await sealBundle(f.v1, {
      vaultId: VAULT,
      kver: 2,
      keyring: f.k1b,
      auth: auth1b,
      by: a.id,
      now: w.clock.now,
    });
    const body = {
      if_kver: 1,
      bundle: changed.raw,
      password_auth: pw1.passwordAuth,
      password_verifier: toB64(randomBytes(32)),
    };
    w.server.fault({ match: "PUT /v1/keys", kind: "after" });
    await expect(w.api.putKeys(a.signer, body)).rejects.toBeInstanceOf(NetworkError);
    expect(await w.api.putKeys(a.signer, body)).toMatchObject({ kver: 2 }); // the stored text is this request's
    // not a replay, and if_kver 1 is stale: the CAS answers before the proof (A5: an honest race is no wrong password)
    await rejects(w.api.putKeys(a.signer, { ...body, bundle: withKver(changed.raw, 3) }), 409, "keys_conflict");
    expect(w.server.state().devices[0]!.auth_failures).toBe(0);
    await rejects(
      w.api.putKeys(a.signer, {
        ...body,
        if_kver: 2,
        bundle: (
          await sealBundle(f.v1, { vaultId: VAULT, kver: 3, keyring: f.k1b, auth: auth1b, by: a.id, now: w.clock.now })
        ).raw,
        password_auth: toB64(randomBytes(32)),
      }),
      403,
      "password_mismatch",
    );
  });

  it("PUT /v1/keys' keyless checks: the vault, the current VK, by = the signer (422); a stale if_kver with another text is keys_conflict", async () => {
    const w = world();
    const { a } = await made(w);
    const k1r = {
      ...f.k1,
      wraps: f.k1.wraps.map((x) => (x.method === "recovery" ? { ...x, iv: toB64(randomBytes(12)) } : x)),
    };
    const by = (id: string, kver = 2) =>
      sealBundle(f.v1, { vaultId: VAULT, kver, keyring: k1r, auth: auth1, by: id, now: w.clock.now });
    await rejects(
      w.api.putKeys(a.signer, {
        if_kver: 1,
        bundle: (await by(newDeviceId())).raw,
        password_auth: pw1.passwordAuth,
        recovery_verifier: rec2.recoveryVerifier,
      }),
      422,
      "invalid_request",
    );
    const underVk2 = await sealBundle(f.v2, {
      vaultId: VAULT,
      kver: 2,
      keyring: f.k2,
      auth: authFor(f.k2),
      by: a.id,
      now: w.clock.now,
    });
    await rejects(
      w.api.putKeys(a.signer, {
        if_kver: 1,
        bundle: underVk2.raw,
        password_auth: pw1.passwordAuth,
        recovery_verifier: rec2.recoveryVerifier,
        password_verifier: rec2.recoveryVerifier,
      }),
      422,
      "invalid_request",
    );
    expect(
      await w.api.putKeys(a.signer, {
        if_kver: 1,
        bundle: (await by(a.id)).raw,
        password_auth: pw1.passwordAuth,
        recovery_verifier: rec2.recoveryVerifier,
      }),
    ).toMatchObject({ kver: 2 });
    await rejects(
      w.api.putKeys(a.signer, {
        if_kver: 1,
        bundle: (await by(a.id, 3)).raw,
        password_auth: pw1.passwordAuth,
        recovery_verifier: rec2.recoveryVerifier,
      }),
      409,
      "keys_conflict",
    );
  });

  it("rotate (§3.8 P3): double CAS, the write proof with the current K_write, vk_id and K_write swapped, names re-encrypted, enrolments gone, replay 200", async () => {
    const w = world();
    const { a } = await made(w);
    const n = await device();
    const sn = await w.server.session("a@example.com");
    await w.api.enrollCreate(sn, n.reg, { device_id: n.id, sig_pubkey: n.spki, commit: toB64(randomBytes(32)) });
    await w.api.putVault(a.signer, await putBody(1));
    await rejects(
      w.api.rotate(a.signer, (await rotateBody(w, a, { ifVersion: 1, ifKver: 1 })).body),
      409,
      "version_conflict",
    );
    await rejects(
      w.api.rotate(a.signer, (await rotateBody(w, a, { ifVersion: 2, ifKver: 2, kver: 3 })).body),
      409,
      "keys_conflict",
    );
    await rejects(
      w.api.rotate(a.signer, (await rotateBody(w, a, { ifVersion: 2, ifKver: 1, proofVk: f.v2 })).body),
      403,
      "write_denied",
    );
    const rev0 = w.server.state().vault!.devices_rev;
    const r = await rotateBody(w, a, { ifVersion: 2, ifKver: 1 });
    expect(await w.api.rotate(a.signer, r.body)).toMatchObject({ version: 3, kver: 2 });
    const st = w.server.state();
    expect(st.vault).toMatchObject({
      vk_id: f.v2.id,
      write_key: await writeKey(f.v2),
      kver: 2,
      devices_rev: rev0 + 1,
      bundle: r.body.bundle,
      password_verifier: r.pw2.passwordVerifier,
    });
    expect(st.devices[0]!.name_ct).toEqual(r.body.device_names[0]!.name_ct);
    expect(st.enrollments).toEqual([]);
    expect(await w.api.rotate(a.signer, r.body)).toMatchObject({ version: 3, kver: 2 }); // the identical text
    await rejects(w.api.putVault(a.signer, await putBody(3, { vk: f.v2, proofVk: f.v1 })), 403, "write_denied"); // the old K_write
    expect((await w.api.putVault(a.signer, await putBody(3, { vk: f.v2 }))).version).toBe(4);
    await rejects(w.api.putVault(a.signer, await putBody(4, { vk: f.v1, proofVk: f.v2 })), 409, "vk_mismatch");
    // pw_auth is now the new auth's: the old one fails
    await rejects(w.api.revoke(a.signer, n.id, pw1.passwordAuth), 403, "password_mismatch");
  }, 30_000);
});

describe("devices (§3.10, §4.10)", () => {
  it("fork needs the new key's signature over the same input; rename and revoke need pw_auth; revoke is idempotent", async () => {
    const w = world();
    const { a } = await made(w);
    const c = await device();
    const nk = await generateDeviceKey();
    const other = await generateDeviceKey();
    const body = {
      new_device_id: c.id,
      new_sig_pubkey: toB64(nk.spki),
      name_ct: await sealDeviceName(f.v1, { vaultId: VAULT, deviceId: c.id }, "Clone"),
      password_auth: pw1.passwordAuth,
    };
    await rejects(w.api.fork(a.signer, other.privateKey, body), 401, "bad_signature"); // Sixkey-New-Sig by another key
    const text = JSON.stringify(body);
    expect(codeOf(await raw(w, a, { method: "POST", target: "/v1/devices/fork", body: text }))).toEqual({
      status: 401,
      code: "bad_signature",
    }); // missing
    await rejects(
      w.api.fork(a.signer, nk.privateKey, { ...body, password_auth: toB64(randomBytes(32)) }),
      403,
      "password_mismatch",
    );
    expect(await w.api.fork(a.signer, nk.privateKey, body)).toMatchObject({ device_id: c.id });
    await rejects(w.api.fork(a.signer, nk.privateKey, body), 409, "device_exists");
    const devs = (await w.api.devices(a.signer)).devices;
    expect(devs.find((d) => d.device_id === c.id)).toMatchObject({ joined_via: "fork", approved_by: a.id });
    await rejects(
      w.api.rename(a.signer, newDeviceId(), { name_ct: body.name_ct, password_auth: pw1.passwordAuth }),
      404,
      "not_found",
    );
    await rejects(w.api.revoke(a.signer, c.id, toB64(randomBytes(32))), 403, "password_mismatch");
    const first = await w.api.revoke(a.signer, c.id, pw1.passwordAuth);
    w.clock.now += 2 * HOUR;
    expect((await w.api.revoke(a.signer, c.id, pw1.passwordAuth)).revoked_at).toBe(first.revoked_at);
    const cSigner: DeviceSigner = { kind: "device", deviceId: c.id, key: nk.privateKey };
    await rejects(w.api.status(cSigner), 403, "device_revoked");
  });

  it("devices_rev moves with every devices-row change except last_seen_at; status does not move it", async () => {
    const w = world();
    const { a } = await made(w);
    const rev = async () => (await w.api.status(a.signer)).devices_rev;
    const r0 = await rev();
    expect(await rev()).toBe(r0);
    w.clock.now += 2 * 86_400_000; // a new UTC day: last_seen_at is written, devices_rev stays
    expect(await rev()).toBe(r0);
    expect(w.server.state().devices[0]!.last_seen_at! % 86_400_000).toBe(0);
    await w.api.rename(a.signer, a.id, {
      name_ct: await sealDeviceName(f.v1, { vaultId: VAULT, deviceId: a.id }, "New"),
      password_auth: pw1.passwordAuth,
    });
    expect(await rev()).toBe(r0 + 1);
  });
});

describe("enrolment (§3.2, §3.3, §5.4)", () => {
  async function requested(w: World, email = "a@example.com") {
    const n = await device();
    const s = await w.server.session(email);
    const { request_id: rid, expires_at } = await w.api.enrollCreate(s, n.reg, {
      device_id: n.id,
      sig_pubkey: n.spki,
      commit: toB64(randomBytes(32)),
    });
    return { n, s, rid, expires_at, en: { kind: "enroll", rid, key: n.key } as EnrollSigner };
  }
  const point = async () => toB64((await generateEphemeral()).raw);

  it("the state machine: one request per session, views by state (F-10), one approver, only it approves, key_mismatch, identical retries (A15), complete once (A17)", async () => {
    const w = world();
    const { a } = await made(w);
    const b = await device();
    await w.api
      .enrollRecovery(await w.server.session("a@example.com"), b.reg, {
        device_id: b.id,
        sig_pubkey: b.spki,
        recovery_auth: rec1.recoveryAuth,
      })
      .then((r) => w.api.complete({ kind: "enroll", rid: r.request_id, key: b.key }, r.request_id));
    const { n, s, rid, expires_at, en } = await requested(w);
    expect(expires_at).toBe(Math.ceil((w.clock.now + 600_000) / 60_000) * 60_000); // A13: rounded up to the minute
    const n2 = await device();
    await rejects(
      w.api.enrollCreate(s, n2.reg, { device_id: n2.id, sig_pubkey: n2.spki, commit: toB64(randomBytes(32)) }),
      409,
      "one_per_session",
    );
    await rejects(
      w.api.enrollCreate(await w.server.session("a@example.com"), a.reg, {
        device_id: a.id,
        sig_pubkey: a.spki,
        commit: toB64(randomBytes(32)),
      }),
      409,
      "device_exists",
    );
    await rejects(
      w.api.enrollCreate(await w.server.session("nobody@example.com"), n2.reg, {
        device_id: n2.id,
        sig_pubkey: n2.spki,
        commit: toB64(randomBytes(32)),
      }),
      404,
      "no_vault",
    );
    const listed = await w.api.enrollList(a.signer);
    expect(listed).toEqual([
      { request_id: rid, created_at: Math.floor(w.clock.now / 60_000) * 60_000, expires_at, state: "pending" },
    ]);
    expect((await w.api.status(a.signer)).pending_enrollments).toBe(1);
    expect(await w.api.enrollGet(en, rid)).toEqual({ state: "pending", server_time: expect.any(Number) });
    await rejects(
      w.api.reveal(en, rid, { epk: await point(), nonce: toB64(randomBytes(32)), name_ct: toB64(randomBytes(188)) }),
      409,
      "enroll_state",
    );
    const epkA = await point();
    await rejects(
      w.api.respond(a.signer, rid, { epk: epkA, password_auth: toB64(randomBytes(32)) }),
      403,
      "password_mismatch",
    );
    await w.api.respond(a.signer, rid, { epk: epkA, password_auth: pw1.passwordAuth });
    await w.api.respond(a.signer, rid, { epk: epkA, password_auth: pw1.passwordAuth }); // A15: the identical retry is 200
    await rejects(
      w.api.respond(a.signer, rid, { epk: await point(), password_auth: pw1.passwordAuth }),
      409,
      "enroll_state",
    ); // another epk
    const e = await rejects(
      w.api.respond(b.signer, rid, { epk: await point(), password_auth: pw1.passwordAuth }),
      409,
      "enroll_state",
    );
    expect(e.details.handled_by).toBe(a.id);
    expect(await w.api.enrollList(a.signer)).toMatchObject([{ state: "responded", handled_by: a.id }]);
    expect(await w.api.enrollGet(en, rid)).toMatchObject({
      state: "responded",
      approver_device_id: a.id,
      approver_epk: epkA,
    });
    const reveal = { epk: await point(), nonce: toB64(randomBytes(32)), name_ct: toB64(randomBytes(188)) };
    await w.api.reveal(en, rid, reveal);
    await w.api.reveal(en, rid, reveal); // A15: the identical retry is 200
    await rejects(w.api.reveal(en, rid, { ...reveal, nonce: toB64(randomBytes(32)) }), 409, "enroll_state"); // other values
    expect(await w.api.enrollGet(b.signer, rid)).toMatchObject({
      state: "revealed",
      new_device_id: n.id,
      new_epk: reveal.epk,
      new_nonce: reveal.nonce,
      new_name_ct: reveal.name_ct,
    });
    const nameN = await sealDeviceName(f.v1, { vaultId: VAULT, deviceId: n.id }, "New");
    const approve = {
      transcript_hash: toB64(randomBytes(32)),
      payload: toB64(randomBytes(200)),
      name_ct: nameN,
      sig_pubkey_sha256: toB64(await sha256(fromB64(n.spki))),
      password_auth: pw1.passwordAuth,
    };
    expect((await rejects(w.api.approve(b.signer, rid, approve), 409, "enroll_state")).details.handled_by).toBe(a.id);
    await rejects(
      w.api.approve(a.signer, rid, { ...approve, sig_pubkey_sha256: toB64(randomBytes(32)) }),
      422,
      "key_mismatch",
    );
    await w.api.approve(a.signer, rid, approve);
    expect(await w.api.enrollGet(en, rid)).toMatchObject({ state: "approved", payload: approve.payload });
    await rejects(w.api.approve(a.signer, rid, approve), 409, "enroll_state"); // A15: a repeated approve
    expect(await w.api.complete(en, rid)).toMatchObject({ device_id: n.id });
    await rejects(w.api.complete(en, rid), 410, "enroll_gone"); // A17: the request is gone; D4 is the status query as devN
    expect((await w.api.status(n.signer)).version).toBe(1);
    await rejects(w.api.enrollGet(en, rid), 410, "enroll_gone");
    expect((await w.api.devices(n.signer)).devices.find((d) => d.device_id === n.id)).toMatchObject({
      joined_via: "approval",
      approved_by: a.id,
      name_ct: nameN,
    });
    expect(await w.api.enrollList(a.signer)).toEqual([]);
    expect(w.server.violations).toEqual([]);
  });

  it("expiry (10 minutes on the server clock): every step answers 410 enroll_gone and the request leaves the list", async () => {
    const w = world();
    const { a } = await made(w);
    const { rid, en, expires_at } = await requested(w);
    w.clock.now = expires_at - 1;
    expect(await w.api.enrollGet(en, rid)).toMatchObject({ state: "pending" }); // A13: alive until the rounded-up minute
    w.clock.now = expires_at;
    await rejects(
      w.api.respond(a.signer, rid, { epk: await point(), password_auth: pw1.passwordAuth }),
      410,
      "enroll_gone",
    );
    await rejects(w.api.enrollGet(en, rid), 410, "enroll_gone");
    expect(await w.api.enrollList(a.signer)).toEqual([]);
    await rejects(w.api.enrollGet(a.signer, "00000000-0000-4000-8000-000000000000"), 410, "enroll_gone");
  });

  it("reject: by the new device itself (no pw_auth) or by a device (pw_auth); reject-all; a revoked approver's approvals are void", async () => {
    const w = world();
    const { a } = await made(w);
    const r1 = await requested(w);
    await w.api.reject(r1.en, r1.rid);
    await rejects(w.api.enrollGet(r1.en, r1.rid), 410, "enroll_gone");
    const r2 = await requested(w);
    await rejects(w.api.reject(a.signer, r2.rid, toB64(randomBytes(32))), 403, "password_mismatch");
    await w.api.reject(a.signer, r2.rid, pw1.passwordAuth);
    await rejects(w.api.reject(a.signer, r2.rid, pw1.passwordAuth), 410, "enroll_gone");
    await requested(w);
    await requested(w);
    expect(await w.api.rejectAll(a.signer, pw1.passwordAuth)).toBe(2);
    // b approves via respond, then a revokes b: the request goes
    const b = await device();
    await w.api
      .enrollRecovery(await w.server.session("a@example.com"), b.reg, {
        device_id: b.id,
        sig_pubkey: b.spki,
        recovery_auth: rec1.recoveryAuth,
      })
      .then((r) => w.api.complete({ kind: "enroll", rid: r.request_id, key: b.key }, r.request_id));
    const r3 = await requested(w);
    await w.api.respond(b.signer, r3.rid, { epk: await point(), password_auth: pw1.passwordAuth });
    await w.api.revoke(a.signer, b.id, pw1.passwordAuth);
    await rejects(w.api.enrollGet(r3.en, r3.rid), 410, "enroll_gone");
  });

  it("recovery (§3.3): a wrong code is recovery_mismatch; the right one returns the vault and bundle byte for byte; a retry the same request", async () => {
    const w = world();
    await made(w);
    const n = await device();
    const s = await w.server.session("a@example.com");
    await rejects(
      w.api.enrollRecovery(s, n.reg, { device_id: n.id, sig_pubkey: n.spki, recovery_auth: rec2.recoveryAuth }),
      403,
      "recovery_mismatch",
    );
    const r = await w.api.enrollRecovery(s, n.reg, {
      device_id: n.id,
      sig_pubkey: n.spki,
      recovery_auth: rec1.recoveryAuth,
    });
    const st = w.server.state();
    expect(r).toMatchObject({
      vault_id: VAULT,
      version: st.vault!.version,
      kver: 1,
      envelope: st.vault!.envelope,
      bundle: st.vault!.bundle,
    });
    expect(
      (await w.api.enrollRecovery(s, n.reg, { device_id: n.id, sig_pubkey: n.spki, recovery_auth: rec1.recoveryAuth }))
        .request_id,
    ).toBe(r.request_id);
    const en: EnrollSigner = { kind: "enroll", rid: r.request_id, key: n.key };
    await rejects(w.api.enrollGet(en, r.request_id), 410, "enroll_gone"); // a recovery request is not polled
    const nameN = await sealDeviceName(f.v1, { vaultId: VAULT, deviceId: n.id }, "Rec");
    expect(await w.api.complete(en, r.request_id, { name_ct: nameN })).toMatchObject({ device_id: n.id });
    expect((await w.api.devices(n.signer)).devices.find((d) => d.device_id === n.id)).toMatchObject({
      joined_via: "recovery",
      approved_by: null,
      name_ct: nameN,
    });
    await rejects(
      w.api.enrollRecovery(await w.server.session("a@example.com"), n.reg, {
        device_id: n.id,
        sig_pubkey: n.spki,
        recovery_auth: rec1.recoveryAuth,
      }),
      409,
      "device_exists",
    );
  });
});

describe("revision 15 (§0.0o) and M4's order of the checks", () => {
  const point = async () => toB64((await generateEphemeral()).raw);
  async function requested(w: World, email = "a@example.com") {
    const n = await device();
    const s = await w.server.session(email);
    const { request_id: rid, expires_at } = await w.api.enrollCreate(s, n.reg, {
      device_id: n.id,
      sig_pubkey: n.spki,
      commit: toB64(randomBytes(32)),
    });
    return { n, s, rid, expires_at, en: { kind: "enroll", rid, key: n.key } as EnrollSigner };
  }

  it("the account token is an ES256 JWT whose sub the client reads (sessionFromToken); a forged or tampered one is session_invalid", async () => {
    const w = world();
    const s = await w.server.session("j@example.com");
    const [h, c] = s.token
      .split(".")
      .slice(0, 2)
      .map((x) => JSON.parse(Buffer.from(x!, "base64url").toString()));
    expect(h).toMatchObject({ alg: "ES256", typ: "JWT" });
    expect(c).toMatchObject({ sub: s.sub, aud: "authenticated", role: "authenticated" });
    expect(sessionFromToken(s.token)).toEqual({ token: s.token, sub: s.sub });
    expect(await w.api.account(s)).toMatchObject({ has_vault: false });
    const [ph, pc, ps] = s.token.split(".") as [string, string, string];
    const other = Buffer.from(JSON.stringify({ ...c, sub: "11111111-1111-4111-8111-111111111111" })).toString(
      "base64url",
    );
    await rejects(w.api.account({ token: `${ph}.${other}.${ps}`, sub: s.sub }), 401, "session_invalid"); // the claims changed under the signature
    const none = Buffer.from(JSON.stringify({ ...h, alg: "none" })).toString("base64url");
    await rejects(w.api.account({ token: `${none}.${pc}.${ps}`, sub: s.sub }), 401, "session_invalid");
    expect(() => sessionFromToken("not-a-jwt")).toThrow(ApiError);
    w.clock.now += 900_000;
    await rejects(w.api.account(s), 401, "session_invalid"); // exp
  });

  it("PUT /v1/vault: the CAS before the write proof (a write racing a rotation is 409, never 403 write_denied)", async () => {
    const w = world();
    const { a } = await made(w);
    await w.api.rotate(a.signer, (await rotateBody(w, a, { ifVersion: 1, ifKver: 1 })).body);
    await rejects(w.api.putVault(a.signer, await putBody(1)), 409, "version_conflict"); // stale version and the old K_write
    await rejects(w.api.putVault(a.signer, await putBody(2, { vk: f.v1 })), 409, "vk_mismatch"); // the old key and its K_write
    await rejects(w.api.putVault(a.signer, await putBody(2, { vk: f.v2, proofVk: f.v1 })), 403, "write_denied"); // the CAS holds, the proof does not
  }, 30_000);

  it("rotate: keys_conflict first when both are stale (A7), then version_conflict, then the write proof, then pw_auth (A5)", async () => {
    const w = world();
    const { a } = await made(w);
    await w.api.putVault(a.signer, await putBody(1));
    const k1r = await sealBundle(f.v1, {
      vaultId: VAULT,
      kver: 2,
      keyring: {
        ...f.k1,
        wraps: f.k1.wraps.map((x) => (x.method === "recovery" ? { ...x, iv: toB64(randomBytes(12)) } : x)),
      },
      auth: auth1,
      by: a.id,
      now: w.clock.now,
    });
    await w.api.putKeys(a.signer, {
      if_kver: 1,
      bundle: k1r.raw,
      password_auth: pw1.passwordAuth,
      recovery_verifier: rec2.recoveryVerifier,
    });
    const bad = toB64(randomBytes(32));
    await rejects(
      w.api.rotate(a.signer, { ...(await rotateBody(w, a, { ifVersion: 1, ifKver: 1 })).body, password_auth: bad }),
      409,
      "keys_conflict",
    ); // both stale
    await rejects(
      w.api.rotate(a.signer, { ...(await rotateBody(w, a, { ifVersion: 1, ifKver: 2 })).body, password_auth: bad }),
      409,
      "version_conflict",
    );
    await rejects(
      w.api.rotate(a.signer, {
        ...(await rotateBody(w, a, { ifVersion: 2, ifKver: 2, proofVk: f.v2 })).body,
        password_auth: bad,
      }),
      403,
      "write_denied",
    );
    expect(w.server.state().devices[0]!.auth_failures).toBe(0); // none of these was a guess
    await rejects(
      w.api.rotate(a.signer, { ...(await rotateBody(w, a, { ifVersion: 2, ifKver: 2 })).body, password_auth: bad }),
      403,
      "password_mismatch",
    );
    expect(w.server.state().devices[0]!.auth_failures).toBe(1);
    const dup = (await rotateBody(w, a, { ifVersion: 2, ifKver: 2 })).body;
    await rejects(
      w.api.rotate(a.signer, { ...dup, device_names: [dup.device_names[0]!, dup.device_names[0]!] }),
      422,
      "invalid_request",
    ); // A6: no duplicate id
    const under1 = {
      ...dup,
      device_names: [
        { ...dup.device_names[0]!, name_ct: await sealDeviceName(f.v1, { vaultId: VAULT, deviceId: a.id }, "old key") },
      ],
    };
    await rejects(w.api.rotate(a.signer, under1), 422, "invalid_request"); // A6/A19: names under the new VK
    expect(await w.api.rotate(a.signer, dup)).toMatchObject({ version: 3, kver: 3 });
  }, 30_000);

  it("complete: once (a retry is 410, A17); another request for the same device and key 200; a taken device id 409 and the request survives (A16); name_ct only on the recovery path, under the current VK", async () => {
    const w = world();
    const { a } = await made(w);
    const n = await device();
    const r1 = await w.api.enrollRecovery(await w.server.session("a@example.com"), n.reg, {
      device_id: n.id,
      sig_pubkey: n.spki,
      recovery_auth: rec1.recoveryAuth,
    });
    const e1: EnrollSigner = { kind: "enroll", rid: r1.request_id, key: n.key };
    await rejects(
      w.api.complete(e1, r1.request_id, {
        name_ct: await sealDeviceName(f.v2, { vaultId: VAULT, deviceId: n.id }, "wrong key"),
      }),
      422,
      "invalid_request",
    ); // A19
    // another session's request for the same device and key, then the first completes
    const r2 = await w.api.enrollRecovery(await w.server.session("a@example.com"), n.reg, {
      device_id: n.id,
      sig_pubkey: n.spki,
      recovery_auth: rec1.recoveryAuth,
    });
    expect(r2.request_id).toBe(r1.request_id); // the same device and key in the window: the same request (§3.3)
    expect(await w.api.complete(e1, r1.request_id)).toMatchObject({ device_id: n.id });
    await rejects(w.api.complete(e1, r1.request_id), 410, "enroll_gone");
    expect((await w.api.devices(n.signer)).devices.find((d) => d.device_id === n.id)).toMatchObject({
      joined_via: "recovery",
      name_ct: null,
    });
    // a device id taken meanwhile (another account's init with the same id)
    const m = await device();
    const r3 = await w.api.enrollRecovery(await w.server.session("a@example.com"), m.reg, {
      device_id: m.id,
      sig_pubkey: m.spki,
      recovery_auth: rec1.recoveryAuth,
    });
    const thief = await device(m.id);
    const w2s = await w.server.session("b@example.com");
    await w.api.init(w2s, thief.reg, (await initBody(w, thief)).body);
    const e3: EnrollSigner = { kind: "enroll", rid: r3.request_id, key: m.key };
    await rejects(w.api.complete(e3, r3.request_id), 409, "enroll_state");
    expect(w.server.state("a@example.com").enrollments.map((e) => e.request_id)).toContain(r3.request_id); // survives
    // the approval path: name_ct in complete is 422
    const q = await requested(w);
    await w.api.respond(a.signer, q.rid, { epk: await point(), password_auth: pw1.passwordAuth });
    await w.api.reveal(q.en, q.rid, {
      epk: await point(),
      nonce: toB64(randomBytes(32)),
      name_ct: toB64(randomBytes(188)),
    });
    const nameQ = await sealDeviceName(f.v1, { vaultId: VAULT, deviceId: q.n.id }, "Q");
    await w.api.approve(a.signer, q.rid, {
      transcript_hash: toB64(randomBytes(32)),
      payload: toB64(randomBytes(200)),
      name_ct: nameQ,
      sig_pubkey_sha256: toB64(await sha256(fromB64(q.n.spki))),
      password_auth: pw1.passwordAuth,
    });
    await rejects(w.api.complete(q.en, q.rid, { name_ct: nameQ }), 422, "invalid_request");
    expect(await w.api.complete(q.en, q.rid)).toMatchObject({ device_id: q.n.id });
  }, 30_000);

  it("reject-all: approval and recovery requests alike, only those created up to the signed minute (A14, A2); pending_enrollments counts pending approvals only", async () => {
    const w = world();
    const { a } = await made(w);
    const p = await requested(w);
    const rn = await device();
    await w.api.enrollRecovery(await w.server.session("a@example.com"), rn.reg, {
      device_id: rn.id,
      sig_pubkey: rn.spki,
      recovery_auth: rec1.recoveryAuth,
    });
    expect((await w.api.status(a.signer)).pending_enrollments).toBe(1); // the recovery request never counts
    expect((await w.api.enrollList(a.signer)).map((x) => x.request_id)).toEqual([p.rid]); // nor is it listed
    // two minutes later a new request; a reject-all signed a minute before it (inside the window): the later one stays
    w.clock.now += 120_000;
    const later = await requested(w);
    const early = w.mkApi({ offset: () => -60_000 });
    expect(await early.rejectAll(a.signer, pw1.passwordAuth)).toBe(2);
    expect(w.server.state().enrollments.map((e) => e.request_id)).toEqual([later.rid]);
  });

  it("revision 16's json_content_type: a JSON body without Content-Type application/json is 422 before anything else", async () => {
    const w = world();
    const { a } = await made(w);
    const body = JSON.stringify({ password_auth: pw1.passwordAuth });
    for (const [ct, ok] of [
      ["application/json", true],
      ["Application/JSON; charset=UTF-8", true],
      ["application/json ;charset=utf-8", true],
      ["application/json; charset=latin-1", false],
      ["text/plain", false],
      [undefined, false],
      // FS-1 (revision 18, exactly as M4): no alias, no quoted value, no repeated parameter, no space around '=', no trailing ';'
      ["application/json; charset=utf8", false],
      ['application/json; charset="utf-8"', false],
      ["application/json; charset=utf-8; charset=utf-8", false],
      ["application/json; charset = utf-8", false],
      ["application/json;", false],
    ] as const) {
      const h = await signRequest(a.key, {
        host: "api.sixkey.app",
        method: "POST",
        target: "/v1/enroll/reject-all",
        signer: { deviceId: a.id },
        ts: w.clock.now,
        body,
      });
      const res = await w.server.transport().send({
        method: "POST",
        target: "/v1/enroll/reject-all",
        headers: { ...h, ...(ct ? { "Content-Type": ct } : {}) },
        body,
      });
      expect(codeOf(res), String(ct)).toEqual(
        ok ? { status: 200, code: undefined } : { status: 422, code: "invalid_request" },
      );
    }
    const stranger = await device();
    const res = await w.server.transport().send({
      method: "POST",
      target: "/v1/enroll/reject-all",
      headers: {
        ...(await signRequest(stranger.key, {
          host: "api.sixkey.app",
          method: "POST",
          target: "/v1/enroll/reject-all",
          signer: { deviceId: stranger.id },
          ts: w.clock.now,
          body,
        })),
        "Content-Type": "text/plain",
      },
      body,
    });
    expect(codeOf(res)).toEqual({ status: 422, code: "invalid_request" }); // checked before the signer (M4's precheck)
  });

  it("A11: an enrolled device's reject without pw_auth is 403, not counted; A12: a valid proof that clears the failures moves devices_rev", async () => {
    const w = world();
    const { a } = await made(w);
    const q = await requested(w);
    await rejects(w.api.reject(a.signer, q.rid), 403, "password_mismatch");
    expect(w.server.state().devices[0]!.auth_failures).toBe(0);
    await rejects(w.api.reject(a.signer, q.rid, toB64(randomBytes(32))), 403, "password_mismatch");
    const rev = w.server.state().vault!.devices_rev;
    await w.api.reject(a.signer, q.rid, pw1.passwordAuth);
    expect(w.server.state().vault!.devices_rev).toBe(rev + 1);
  });

  it("A18 strict JSON (duplicate key, lone surrogate: 422, after authentication); A20 both signer headers: bad_signature", async () => {
    const w = world();
    const { a } = await made(w);
    const dupKey = '{"password_auth":"x","password_auth":"y"}';
    expect(codeOf(await raw(w, a, { method: "POST", target: "/v1/enroll/reject-all", body: dupKey }))).toEqual({
      status: 422,
      code: "invalid_request",
    });
    expect(
      codeOf(await raw(w, a, { method: "POST", target: "/v1/enroll/reject-all", body: '{"password_auth":"\\ud800"}' })),
    ).toEqual({ status: 422, code: "invalid_request" });
    const stranger = await device();
    expect(codeOf(await raw(w, stranger, { method: "POST", target: "/v1/enroll/reject-all", body: dupKey }))).toEqual({
      status: 401,
      code: "unknown_device",
    }); // the signer first
    const q = await requested(w);
    expect(
      codeOf(
        await raw(w, a, { method: "GET", target: `/v1/enroll/requests/${q.rid}`, extra: { "Sixkey-Enroll": q.rid } }),
      ),
    ).toEqual({ status: 401, code: "bad_signature" });
  });
});

describe("the account session (§5.2, §3.12)", () => {
  it("otp and verify; has_vault; DELETE /v1/account needs a fresh session of this account and pw_auth, answers 204 with a Date header", async () => {
    const w = world();
    await rejects(w.api.otp("not-an-email"), 400, "invalid_email");
    await w.api.otp("x@example.com");
    await rejects(
      w.api.verify("x@example.com", w.server.inbox("x@example.com") === "000000" ? "111111" : "000000"),
      401,
      "otp_invalid",
    );
    const { a, session } = await made(w);
    expect(await w.api.account(await w.server.session("x@example.com"))).toMatchObject({ has_vault: false });
    w.clock.now += 601_000;
    const fresh = await w.server.session("a@example.com");
    await rejects(w.api.deleteAccount(a.signer, session, pw1.passwordAuth), 401, "step_up_required"); // valid for 900 s, but not fresh (600 s)
    await rejects(
      w.api.deleteAccount(a.signer, await w.server.session("x@example.com"), pw1.passwordAuth),
      401,
      "step_up_required",
    ); // another account
    await rejects(w.api.deleteAccount(a.signer, fresh, toB64(randomBytes(32))), 403, "password_mismatch");
    let dated = false;
    const api = w.mkApi({ onServerTime: (s) => (dated = s.serverMs > 0) });
    await api.deleteAccount(a.signer, fresh, pw1.passwordAuth);
    expect(dated).toBe(true); // from the Date header of the 204
    expect(w.server.requests.at(-1)).toMatchObject({ op: "DELETE /v1/account", status: 204 });
    await rejects(w.api.status(a.signer), 401, "unknown_device");
  });
});

describe("faults", () => {
  it("server faults: a status before running (Retry-After parsed), a lost response after committing, a throw before, a hook", async () => {
    const w = world();
    const { a } = await made(w);
    w.server.fault({ match: "GET /v1/sync/status", kind: "status", status: 503, code: "unavailable", retryAfter: 7 });
    expect((await rejects(w.api.status(a.signer), 503, "unavailable")).details.retry_after).toBe(7);
    w.server.fault({ match: "PUT /v1/vault", kind: "throw" });
    await expect(w.api.putVault(a.signer, await putBody(1))).rejects.toBeInstanceOf(NetworkError);
    expect(w.server.state().vault!.version).toBe(1);
    w.server.fault({ match: "PUT /v1/vault", kind: "after" });
    await expect(w.api.putVault(a.signer, await putBody(1))).rejects.toBeInstanceOf(NetworkError);
    expect(w.server.state().vault!.version).toBe(2);
    let ran = false;
    w.server.fault({ match: "GET /v1/vault", kind: "hook", fn: () => void (ran = true) });
    await w.api.getVault(a.signer);
    expect(ran).toBe(true);
    w.server.fault({
      match: (k) => k === "GET /v1/keys",
      kind: "status",
      status: 429,
      code: "rate_limited",
      retryAfter: 3,
      count: 2,
    });
    await rejects(w.api.getKeys(a.signer), 429, "rate_limited");
    await rejects(w.api.getKeys(a.signer), 429, "rate_limited");
    await w.api.getKeys(a.signer);
    w.server.restart();
    expect((await w.api.status(a.signer)).version).toBe(2); // the database survives a restart
  });

  it("FaultyTransport: lose_response, fail_before, duplicate, late, hold/reorder, partition, latency; a seeded mix replays", async () => {
    const w = world();
    const { a } = await made(w);
    const slept: number[] = [];
    const ft = new FaultyTransport(w.server.transport(), async (ms) => void slept.push(ms));
    const api = w.mkApi({ transport: ft });
    ft.inject({ match: "PUT /v1/vault", kind: "lose_response" });
    await expect(api.putVault(a.signer, await putBody(1))).rejects.toBeInstanceOf(NetworkError);
    expect(w.server.state().vault!.version).toBe(2); // delivered
    ft.inject({ match: "PUT /v1/vault", kind: "fail_before" });
    await expect(api.putVault(a.signer, await putBody(2))).rejects.toBeInstanceOf(NetworkError);
    expect(w.server.state().vault!.version).toBe(2); // not delivered
    ft.inject({ match: "PUT /v1/vault", kind: "duplicate" });
    expect((await api.putVault(a.signer, await putBody(2))).version).toBe(3);
    expect(ft.orphans.at(-1)).toEqual({ op: "PUT /v1/vault", status: 409 }); // the duplicate lost the CAS
    ft.inject({ match: "PUT /v1/vault", kind: "late" });
    await expect(api.putVault(a.signer, await putBody(3))).rejects.toBeInstanceOf(NetworkError);
    expect(w.server.state().vault!.version).toBe(3);
    await ft.flushLate();
    expect(w.server.state().vault!.version).toBe(4); // it arrived after the client gave up
    // hold two status queries and a PUT, then deliver in reverse
    ft.inject({ kind: "hold", count: 2 });
    const p1 = api.status(a.signer);
    const p2 = api.putVault(a.signer, await putBody(4));
    for (let i = 0; i < 400 && ft.heldCount < 2; i++) await new Promise((r) => setTimeout(r, 5));
    expect(ft.heldCount).toBe(2);
    await ft.release("reverse");
    expect((await p2).version).toBe(5);
    expect((await p1).version).toBe(5); // delivered after the PUT
    ft.partition(true);
    await expect(api.status(a.signer)).rejects.toBeInstanceOf(NetworkError);
    ft.partition(false);
    ft.inject({ kind: "latency", ms: 250 });
    await api.status(a.signer);
    expect(slept).toEqual([250]);
    const kinds = (seed: number) => {
      const t = new FaultyTransport(w.server.transport()).random({
        seed,
        rates: { fail_before: 0.3, lose_response: 0.2 },
      });
      return Promise.all(
        Array.from({ length: 30 }, () =>
          w
            .mkApi({ transport: t })
            .status(a.signer)
            .then(
              () => "ok",
              () => "err",
            ),
        ),
      ).then(() => t.log.map((l) => l.kind));
    };
    expect(await kinds(42)).toEqual(await kinds(42));
    expect(await kinds(42)).not.toEqual(await kinds(43));
    expect(JSON.stringify(ft.log)).not.toMatch(/envelope|Sixkey|bundle/); // the log keeps operations only
  });
});

describe("the vectors' wire examples through the server's request gate", () => {
  it("every request example the vectors call valid passes the schema gate; every counterexample is refused 422 with a violation", async () => {
    const o = loadContract().openapi;
    const w = world();
    for (const ex of V.wire_examples.examples.filter((x: { kind: string }) => x.kind === "request")) {
      const valid = ex.expect_valid ?? true;
      expect(validate(requestSchema(findOperation(o, ex.operation)), ex.body, o).length === 0, ex.operation).toBe(
        valid,
      );
      const [method, path] = ex.operation.split(" ");
      const target = path
        .replace("{rid}", "00000000-0000-4000-8000-000000000000")
        .replace("{id}", "qqqqqqqqqqqqqqqqqqqqqg");
      const before = w.server.violations.length;
      // the gate as it runs after authentication (M4's order): an unsigned request never reaches it
      const unsigned = await w.server.transport().send({
        method: method as HttpRequest["method"],
        target,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ex.body),
      });
      expect(unsigned.status, ex.operation).not.toBe(422);
      const res = w.server.requestGate(ex.operation, JSON.stringify(ex.body));
      if (valid) expect([res, w.server.violations.length], ex.operation).toEqual([null, before]);
      else expect(res, `${ex.operation}: ${ex.why}`).toEqual({ status: 422, code: "invalid_request" });
    }
    expect(w.server.bugs).toEqual([]);
  });
});
