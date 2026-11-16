// The in-memory FakeServer for the sync engine's tests (M3; SYNC-DESIGN §5.2–§5.5, §3.6.0, §4.10; api/openapi.yaml). It
// implements the contract's 29 operations at the HTTP level, through the engine's Transport interface: status codes,
// error bodies {"error": {code, …details}, "server_time"}, server_time in every JSON body, a 204 with only a Date header,
// envelope and bundle texts stored and returned byte for byte. So the engine tests that run against it can later run
// against the real server (M4) by swapping the transport.
//
// It is the oracle the engine's data-loss tests rely on, so it checks what the real server checks, with M1's own functions:
// signatures (signingInput / verifyInput over the configured host and the raw target), write proofs (HMAC with the stored
// K_write over writeProofInput), the verifiers (SHA-256 of the tag and the raw proof), the bundle's upload shape
// (checkBundleShape), P4 (requiredVerifiers), strict JSON (A18) with integer-only number tokens, the kver window,
// byte-identical idempotency, the cursor's fork detection, the enrolment state machine with its expiry. Every request
// body is validated against the contract's request schema (a failure is 422 and is recorded in `violations`), and with
// validateWire every response against its response schema and the operation's x-sixkey-errors list (a failure is a
// FakeServer bug: thrown).
//
// It follows SYNC-DESIGN revision 15 (§0.0o) and the real server (api/server, M4) where the order of the checks decides
// the answer: the account session is an ES256 JWT whose `sub` signs registrations; the signer is authenticated before the
// body is read (M4's pipeline); PUT /v1/keys and rotate check the idempotent replay, then the CAS, then the proofs (A5,
// A7); PUT /v1/vault checks the CAS before the write proof; a completed request is deleted, so a retried complete is 410
// (A17) and a taken device id 409 (A16); identical respond/reveal retries are 200 (A15); reject-all covers recovery
// requests up to the signed minute (A14); expires_at is rounded up to the minute (A13); a JSON body needs Content-Type
// application/json (revision 16's json_content_type); min_client_version defaults to
// M4's "0.1.0" (the test devices say 0.1.0; the manifest's 0.0.1 is M5's to bump).
//
// Not a production server: no rate limits (a fault injects 429/503), no retention policy (history is kept whole; DELETE
// /v1/vault/versions trims it), nothing logged. The request log keeps only the operation, the status and the device id.
import { bs, fromB64, randomBytes, sha256, toB64, utf8 } from "../../src/core/crypto/bytes";
import { isEnvelopeIntact, validateEnvelope, type EncryptedVault } from "../../src/core/crypto/envelope";
import { SYNC_CONSTANTS as C } from "../../src/core/sync/crypto/constants";
import { DEVICE_ID_RE, UUID_RE, bytesEqual, floorToUnit, fromB64u, toB64u } from "../../src/core/sync/crypto/encoding";
import { checkBundleShape, requiredVerifiers, type KeyBundle } from "../../src/core/sync/crypto/keybundle";
import { TAG } from "../../src/core/sync/crypto/labels";
import { envelopeHead, envelopeSizeBytes } from "../../src/core/sync/crypto/padding";
import { apiHost, bodyHash, signingInput, verifyInput, type Signer } from "../../src/core/sync/crypto/signature";
import { taggedDigest, writeProofInput } from "../../src/core/sync/crypto/subkeys";
import { sessionFromToken, type AccountSession, type NameCtWire } from "../../src/core/sync/engine/api";
import {
  NetworkError,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "../../src/core/sync/engine/transport";
import { deref, loadContract, operations, parseStrictJson, requestSchema, validate, type J } from "./contract";
import { operationKey, pathParams } from "./faulty-transport";

// ---- the database --------------------------------------------------------------------------------------------------

export type VaultRow = {
  vault_id: string;
  version: number;
  vk_id: string;
  envelope: string; // the stored text, byte for byte
  head: string; // SHA-256 of `envelope`, standard base64 (D5)
  devices_rev: number;
  size_bytes: number;
  kver: number;
  bundle: string; // the stored text, byte for byte
  recovery_verifier: string;
  password_verifier: string;
  write_key: string; // K_write, standard base64
  created_at: number; // hour
  updated_at: number; // hour
};
export type VersionRow = { version: number; vk_id: string; envelope: string; size_bytes: number; created_at: number };
export type DeviceRow = {
  device_id: string;
  user: string; // the account's sub
  sig_pubkey: string; // SPKI DER, standard base64
  name_ct: NameCtWire | null;
  joined_via: "first" | "approval" | "recovery" | "fork";
  approved_by: string | null;
  created_at: number; // hour
  last_seen_at: number | null; // UTC midnight
  revoked_at: number | null; // hour
  auth_failures: number; // capped at 10, alarms only (§3.14)
  cursor: string | null; // clone soft detection (§4.10)
};
export type EnrollState = "pending" | "responded" | "revealed" | "approved";
export type EnrollRow = {
  request_id: string;
  user: string;
  via: "approval" | "recovery";
  session_ref: string; // the JWT's session_id: one open request per account session (F8)
  new_device_id: string;
  new_sig_pubkey: string;
  commit: string | null;
  state: EnrollState;
  approver_device_id: string | null;
  approver_epk: string | null;
  new_epk: string | null;
  new_nonce: string | null;
  new_name_ct: string | null;
  transcript_hash: string | null;
  payload: string | null;
  name_ct: NameCtWire | null; // from approve (K_name of the vault)
  created_at: number; // minute (floored)
  expires_at: number; // minute (now + 600 s rounded up, A13)
};
export type AccountRow = {
  sub: string;
  email: string;
  vault: VaultRow | null;
  history: VersionRow[];
  created_at: number;
};
export type Db = {
  accounts: Record<string, AccountRow>;
  emailToSub: Record<string, string>;
  devices: Record<string, DeviceRow>;
  enrollments: Record<string, EnrollRow>;
  otps: Record<string, { code: string; exp: number; attempts: number }>;
};
export type Snapshot = Db;

const emptyDb = (): Db => ({ accounts: {}, emailToSub: {}, devices: {}, enrollments: {}, otps: {} });

// ---- faults (server side) ------------------------------------------------------------------------------------------

export type ServerFault =
  /** Answered before the operation runs: nothing changes (429 rate_limited and 503 unavailable carry retry_after). */
  | { kind: "status"; status: number; code: string; retryAfter?: number }
  /** The operation runs and commits, then the answer is lost: the caller gets a NetworkError (a "result unknown"). */
  | { kind: "after" }
  /** The caller gets a NetworkError and the operation never runs. */
  | { kind: "throw" }
  /** A callback before the operation runs (an interleaving: another device's write, a rollback, a clock jump). */
  | { kind: "hook"; fn: (s: FakeServer, req: HttpRequest) => void | Promise<void> };
export type FaultRule = ServerFault & {
  match?: string | ((key: string | null, req: HttpRequest) => boolean);
  count?: number;
};

export type FakeServerOptions = {
  origin?: string;
  /** The server clock (ms). Tests share a virtual clock with the clients; `skewMs` moves this one alone. */
  now?: () => number;
  minClientVersion?: string;
  /** Validate every response against the contract (default true). Requests are always validated. */
  validateWire?: boolean;
};

type EnvFacts = { env: EncryptedVault | null; intact: boolean; size: number; head: string };

class HttpErr {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {}
}
const fail = (status: number, code: string, details: Record<string, unknown> = {}): never => {
  throw new HttpErr(status, code, details);
};

const HOUR = C.TRUNC_HOUR_MS;
const DAY = C.TRUNC_DAY_MS;
const MINUTE = C.TRUNC_MINUTE_MS;
const MAX_DEVICES = 200;
const OTP_TTL_MS = 600_000;
const SESSION_TTL_MS = 900_000;
const STEP_UP_MS = 600_000;
const BODY_LIMIT_VAULT = 9_437_184;
const BODY_LIMIT_OTHER = 65_536;
const VAULT_BODY_OPS = new Set(["POST /v1/vault/init", "PUT /v1/vault", "POST /v1/keys/rotate"]);
const REMOVED_HEADERS = ["sixkey-cursor", "if-none-match"];
const ANY_ERRORS = new Set(["internal_error", "unavailable"]);
const JWT_KID = "fake-es256-1";
const JWT_ISS = "https://fake.supabase.invalid/auth/v1";
const ceilToUnit = (ms: number, unit: number): number => Math.ceil(ms / unit) * unit;

/**
 * §5.4 json_content_type, exactly as M4 (pipeline.py) and revision 18 put it (FS-1): application/json, case-insensitive,
 * optionally one parameter charset=utf-8 (case-insensitive) with optional whitespace around the ';'. charset=utf8, a
 * quoted value, any other or repeated parameter, a trailing ';' and "charset = utf-8" are refused.
 */
function jsonContentType(v: string | undefined): boolean {
  if (v === undefined) return false;
  const parts = v.split(";");
  if (parts[0]!.trim().toLowerCase() !== "application/json" || parts.length > 2) return false;
  return parts.length === 1 || parts[1]!.trim().toLowerCase() === "charset=utf-8";
}

type Ctx = {
  key: string;
  req: HttpRequest;
  headers: Record<string, string>;
  params: string[];
  body: J; // the parsed body once gate() ran, else undefined
  bodyText: string;
  op: J;
  gated: boolean;
};

let CONTRACT: J | null = null;
const contract = (): J => (CONTRACT ??= loadContract().openapi);
/**
 * For responses: the contract without the inner schema of the stored texts. A server returns the envelope and bundle
 * texts it stored, byte for byte, whatever they hold (a corrupt head, a replayed or forged bundle are attacks the engine
 * must survive, §4.3), so only the outer shape of a response is the server's to get right.
 */
let RESPONSES: J | null = null;
const responseContract = (): J => {
  if (RESPONSES) return RESPONSES;
  const o = structuredClone(contract());
  for (const n of ["EnvelopeText", "BundleText"]) {
    delete o.components.schemas[n].contentSchema;
    delete o.components.schemas[n].contentMediaType;
  }
  return (RESPONSES = o);
};

/**
 * The body as the schema gate sees it: an envelope text of more than 64 KiB has its ciphertext checked here, linearly, and
 * replaced by a short placeholder. The contract's B64 pattern, (?:[A-Za-z0-9+/]{4})*…, makes V8's backtracking regex run
 * out of stack on megabytes; what it checks is the same (standard base64 with padding).
 */
function forSchema(body: J): J {
  if (body === null || typeof body !== "object" || typeof body.envelope !== "string" || body.envelope.length <= 65_536)
    return body;
  let env: J;
  try {
    env = JSON.parse(body.envelope);
  } catch {
    return body;
  }
  if (env === null || typeof env !== "object" || typeof env.ciphertext !== "string") return body;
  const c: string = env.ciphertext;
  const ok = c.length % 4 === 0 && /^[A-Za-z0-9+/]*$/.test(c.replace(/={1,2}$/, ""));
  return { ...body, envelope: JSON.stringify({ ...env, ciphertext: ok ? "AAAAAAAAAAAAAAAAAAAAAA==" : "!" }) };
}

export class FakeServer {
  db: Db = emptyDb();
  skewMs = 0;
  readonly origin: string;
  readonly host: string;
  minClientVersion: string;
  /** Requests that broke the contract's request schema or a removed header (the engine must send none). */
  readonly violations: { op: string; errors: string[] }[] = [];
  /** Unexpected exceptions inside the server (answered 500): a FakeServer bug. Tests assert none. */
  readonly bugs: string[] = [];
  /** One line per request: the operation, the status, the signing device. No body, no header value. */
  readonly requests: { op: string; status: number | "lost" | "thrown"; deviceId?: string }[] = [];
  restarts = 0;
  private faults: (FaultRule & { left: number })[] = [];
  private readonly clock: () => number;
  private readonly validateWire: boolean;
  private removedHeader: string | null = null;
  private jwtKey: Promise<CryptoKeyPair> | null = null;

  constructor(o: FakeServerOptions = {}) {
    this.origin = o.origin ?? "https://api.sixkey.app";
    this.host = apiHost(this.origin);
    this.clock = o.now ?? (() => Date.now());
    this.minClientVersion = o.minClientVersion ?? "0.1.0"; // M4's default (config.py)
    this.validateWire = o.validateWire ?? true;
  }

  // ---- the admin and test interface (not over HTTP) ----------------------------------------------------------------

  /** The server's clock (ms). */
  now(): number {
    return Math.round(this.clock() + this.skewMs);
  }

  /** An in-process Transport. Each call is asynchronous on both sides (microtasks), so ordering bugs show. */
  transport(): Transport {
    return { send: (req) => this.send(req) };
  }

  /**
   * An account session for `email`, through the server's own OTP and verify (as the FakeAuthProvider inbox would), and
   * the client's own reading of the token (sessionFromToken: the JWT's sub, as against M4).
   */
  async session(email: string): Promise<AccountSession> {
    const otp = await this.send({
      method: "POST",
      target: "/v1/auth/otp",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (otp.status !== 202) throw new Error(`otp ${otp.status}`);
    const v = await this.send({
      method: "POST",
      target: "/v1/auth/verify",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, token: this.inbox(email) }),
    });
    if (v.status !== 200) throw new Error(`verify ${v.status}`);
    return sessionFromToken(JSON.parse(v.body).account_token as string);
  }

  /** The last one-time code mailed to `email` (FakeAuthProvider's inbox). */
  inbox(email: string): string {
    const o = this.db.otps[email.toLowerCase()];
    if (!o) throw new Error("no code was sent");
    return o.code;
  }

  /** A deep copy of the whole database: an honest PITR point (§1.2 A5). */
  snapshot(): Snapshot {
    return structuredClone(this.db);
  }

  /** Back to a snapshot: versions, kver, bundles, devices, enrolments, everything (an honest rollback). */
  restore(s: Snapshot): void {
    this.db = structuredClone(s);
  }
  adminRollback(s: Snapshot): void {
    this.restore(s);
  }

  /** A server process restart: in-memory state is dropped, the database stays. */
  restart(): void {
    this.removedHeader = null; // the only in-memory state besides the test's own fault script, which stays
    this.restarts++;
  }

  /** The next `count` (default 1) requests matching `match` (an operation key such as "PUT /v1/vault", or a predicate). */
  fault(f: FaultRule): this {
    this.faults.push({ ...f, left: f.count ?? 1 });
    return this;
  }
  clearFaults(): void {
    this.faults = [];
  }

  /** The account of `email`, or the only account that has a vault. */
  account(email?: string): AccountRow {
    if (email !== undefined) {
      const sub = this.db.emailToSub[email.toLowerCase()];
      const a = sub ? this.db.accounts[sub] : undefined;
      if (!a) throw new Error("no such account");
      return a;
    }
    const withVault = Object.values(this.db.accounts).filter((a) => a.vault);
    if (withVault.length !== 1) throw new Error(`${withVault.length} accounts have a vault: name one`);
    return withVault[0]!;
  }

  /** Copies of the account's rows, for assertions. */
  state(email?: string): {
    vault: VaultRow | null;
    history: VersionRow[];
    devices: DeviceRow[];
    enrollments: EnrollRow[];
  } {
    const a = this.account(email);
    return structuredClone({
      vault: a.vault,
      history: a.history,
      devices: Object.values(this.db.devices).filter((d) => d.user === a.sub),
      enrollments: Object.values(this.db.enrollments).filter((e) => e.user === a.sub),
    });
  }

  /** A new head version with this exact text, unchecked (a buggy or malicious holder of the VK; a broken disk). */
  async adminSetHead(envelope: string, email?: string): Promise<number> {
    const a = this.account(email);
    const v = a.vault!;
    v.version += 1;
    v.envelope = envelope;
    v.head = await envelopeHead(envelope);
    v.size_bytes = envelopeSizeBytes(envelope);
    v.updated_at = this.hour();
    a.history.push({ version: v.version, vk_id: v.vk_id, envelope, size_bytes: v.size_bytes, created_at: this.hour() });
    return v.version;
  }

  /** Replace the stored bundle text and kver, unchecked (a replay of an old bundle; a malicious server). */
  adminSetBundle(text: string, kver: number, email?: string): void {
    const v = this.account(email).vault!;
    v.bundle = text;
    v.kver = kver;
  }

  /**
   * The request gate alone (strict JSON, an envelope over the limit, the schema), as it runs after authentication, for
   * the contract's wire examples: null when the body passes, else the error (a schema failure is recorded too).
   */
  requestGate(key: string, bodyText: string): { status: number; code: string } | null {
    const req: HttpRequest = {
      method: key.split(" ")[0] as HttpRequest["method"],
      target: key.split(" ")[1]!,
      headers: {},
      body: bodyText,
    };
    const c: Ctx = {
      key,
      req,
      headers: {},
      params: [],
      body: undefined,
      bodyText,
      op: this.operation(key),
      gated: false,
    };
    try {
      this.gate(c);
      return null;
    } catch (e) {
      if (e instanceof HttpErr) return { status: e.status, code: e.code };
      throw e;
    }
  }

  // ---- the exchange ------------------------------------------------------------------------------------------------

  async send(req: HttpRequest): Promise<HttpResponse> {
    await Promise.resolve();
    const key = operationKey(req.method, req.target);
    const fault = this.takeFault(key, req);
    const op = key ?? req.target;
    if (fault?.kind === "throw") {
      this.requests.push({ op, status: "thrown" });
      throw new NetworkError("offline");
    }
    let res: HttpResponse;
    let deviceId: string | undefined;
    if (fault?.kind === "status") {
      res = this.errorResponse(
        new HttpErr(fault.status, fault.code, fault.retryAfter !== undefined ? { retry_after: fault.retryAfter } : {}),
      );
    } else {
      if (fault?.kind === "hook") await fault.fn(this, req);
      const r = await this.handle(key, req);
      res = r.res;
      deviceId = r.deviceId;
      if (this.validateWire && key) this.checkResponse(key, res);
    }
    if (fault?.kind === "after") {
      this.requests.push({ op, status: "lost", ...(deviceId ? { deviceId } : {}) });
      throw new NetworkError("timeout");
    }
    this.requests.push({ op, status: res.status, ...(deviceId ? { deviceId } : {}) });
    await Promise.resolve();
    return res;
  }

  private takeFault(key: string | null, req: HttpRequest): FaultRule | null {
    for (const f of this.faults) {
      const hit = f.match === undefined || (typeof f.match === "string" ? f.match === key : f.match(key, req));
      if (f.left > 0 && hit) {
        f.left--;
        this.faults = this.faults.filter((x) => x.left > 0);
        return f;
      }
    }
    return null;
  }

  private respond(status: number, body?: Record<string, unknown>, extra: Record<string, string> = {}): HttpResponse {
    const now = this.now();
    const headers: Record<string, string> = { date: new Date(now).toUTCString(), ...extra };
    if (body === undefined) return { status, headers, body: "" };
    headers["content-type"] = "application/json";
    return { status, headers, body: JSON.stringify({ ...body, server_time: now }) };
  }

  private errorResponse(e: HttpErr): HttpResponse {
    const extra: Record<string, string> = {};
    if (typeof e.details.retry_after === "number") extra["retry-after"] = String(e.details.retry_after);
    return this.respond(e.status, { error: { code: e.code, ...e.details } }, extra);
  }

  private async handle(key: string | null, req: HttpRequest): Promise<{ res: HttpResponse; deviceId?: string }> {
    const ctx = { deviceId: undefined as string | undefined };
    try {
      if (!key) return { res: this.errorResponse(new HttpErr(404, "not_found")) };
      const c = this.context(key, req);
      const res = await this.dispatch(c, ctx);
      return { res, ...(ctx.deviceId ? { deviceId: ctx.deviceId } : {}) };
    } catch (e) {
      if (e instanceof HttpErr)
        return { res: this.errorResponse(e), ...(ctx.deviceId ? { deviceId: ctx.deviceId } : {}) };
      this.bugs.push(`${key}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
      return { res: this.errorResponse(new HttpErr(500, "internal_error")) };
    }
  }

  /**
   * What needs no body (M4's step 1): the body limit, on every operation (A9: one without a request body too), removed
   * headers and the raw target. The body itself is read by gate(), after authentication, as M4 does.
   */
  private context(key: string, req: HttpRequest): Ctx {
    const op = this.operation(key);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
    const bodyText = req.body ?? "";
    if (utf8(bodyText).length > (VAULT_BODY_OPS.has(key) ? BODY_LIMIT_VAULT : BODY_LIMIT_OTHER)) fail(413, "too_large");
    // x-sixkey-request-rules json_content_type (revision 16, M4 S6): before the body is read, an operation with a JSON
    // body needs Content-Type application/json (case-insensitive), with no parameter but charset=utf-8
    if (requestSchema(op) && !jsonContentType(headers["content-type"])) fail(422, "invalid_request");
    for (const h of REMOVED_HEADERS) {
      if (headers[h] !== undefined) {
        this.violations.push({ op: key, errors: [`removed header ${h}`] });
        this.removedHeader = key; // answered 422 even where the contract lists no 422: the test oracle is strict here
        fail(422, "invalid_request");
      }
    }
    if (req.target.includes("|")) {
      this.removedHeader = key; // §5.2: any target with '|' is refused, whatever the operation lists
      fail(422, "invalid_request");
    }
    return { key, req, headers, params: pathParams(req.target, key), body: undefined, bodyText, op, gated: false };
  }

  /**
   * The body (M4's step 4, after the signer is verified): strict JSON (A18: no duplicate key, NUL or lone surrogate,
   * integer tokens only), an envelope over MAX_ENVELOPE_BYTES 413 before the schema (A8), then the request schema. 422.
   */
  private gate(c: Ctx): J {
    if (c.gated) return c.body;
    c.gated = true;
    const schema = requestSchema(c.op);
    if (!schema) return undefined;
    let body: J;
    try {
      body = parseStrictJson(c.bodyText);
    } catch {
      return fail(422, "invalid_request");
    }
    if (
      body !== null &&
      typeof body === "object" &&
      typeof body.envelope === "string" &&
      envelopeSizeBytes(body.envelope) > C.MAX_ENVELOPE_BYTES
    )
      fail(413, "too_large");
    const errors = validate(schema, forSchema(body), contract());
    if (errors.length) {
      this.violations.push({ op: c.key, errors: errors.slice(0, 5) });
      fail(422, "invalid_request");
    }
    c.body = body;
    return body;
  }

  private operation(key: string): J {
    const [method, path] = key.split(" ", 2) as [string, string];
    return contract().paths[path][method.toLowerCase()];
  }

  /** The response against the contract: a status the operation declares, its schema, and an error code it lists. */
  private checkResponse(key: string, res: HttpResponse): void {
    const op = this.operation(key);
    if (this.removedHeader === key && res.status === 422) {
      this.removedHeader = null;
      return;
    }
    const spec = op.responses[String(res.status)];
    if (!spec) throw new Error(`FakeServer bug: ${key} answered ${res.status}, which the contract does not declare`);
    const r = deref(responseContract(), spec);
    const schema = r.content?.["application/json"]?.schema;
    if (!schema) {
      if (res.body !== "") throw new Error(`FakeServer bug: ${key} ${res.status} must have no body`);
      return;
    }
    const json = JSON.parse(res.body);
    const errs = validate(schema, json, responseContract());
    if (errs.length) throw new Error(`FakeServer bug: ${key} ${res.status} body: ${errs.slice(0, 3).join("; ")}`);
    if (res.status >= 400) {
      const code = json.error.code as string;
      const listed: string[] = op["x-sixkey-errors"]?.[String(res.status)] ?? [];
      if (!listed.includes(code) && !ANY_ERRORS.has(code))
        throw new Error(`FakeServer bug: ${key} answered ${code}, not listed for ${res.status}`);
    }
  }

  // ---- authentication (§5.2; M4's pipeline order) ------------------------------------------------------------------

  private hour(): number {
    return floorToUnit(this.now(), HOUR);
  }

  /** The signing key of the account tokens (an ES256 JWT, as Supabase issues and M4 checks: alg, kid, claims). */
  private async jwtKeys(): Promise<CryptoKeyPair> {
    return (this.jwtKey ??= crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]) as Promise<CryptoKeyPair>);
  }

  private async issueToken(sub: string, now: number): Promise<string> {
    const enc = (o: unknown) => toB64u(utf8(JSON.stringify(o)));
    const iat = Math.floor(now / 1000);
    const head = enc({ alg: "ES256", kid: JWT_KID, typ: "JWT" });
    const claims = enc({
      sub,
      session_id: crypto.randomUUID(),
      iat,
      exp: iat + SESSION_TTL_MS / 1000,
      aud: "authenticated",
      role: "authenticated",
      iss: JWT_ISS,
      is_anonymous: false,
    });
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        (await this.jwtKeys()).privateKey,
        bs(utf8(`${head}.${claims}`)),
      ),
    );
    return `${head}.${claims}.${toB64u(sig)}`;
  }

  /** The account session (M4's account_session.verify): ES256 with our kid, the claims, exp and iat on the server clock. */
  private async sessionOf(c: Ctx): Promise<{ sub: string; sid: string; iat: number }> {
    const m = /^Bearer (\S+)$/.exec(c.headers["authorization"] ?? "");
    const parts = m ? m[1]!.split(".") : [];
    const bad = (): never => fail(401, "session_invalid");
    if (parts.length !== 3 || m![1]!.length > 8192) return bad();
    let head: J;
    let claims: J;
    let sig: Uint8Array;
    try {
      head = JSON.parse(new TextDecoder().decode(fromB64u(parts[0]!)));
      claims = JSON.parse(new TextDecoder().decode(fromB64u(parts[1]!)));
      sig = fromB64u(parts[2]!);
    } catch {
      return bad();
    }
    if (head?.alg !== "ES256" || head?.kid !== JWT_KID || sig.length !== 64) return bad();
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      (await this.jwtKeys()).publicKey,
      bs(sig),
      bs(utf8(`${parts[0]}.${parts[1]}`)),
    );
    if (!ok) return bad();
    const now = this.now();
    if (
      !Number.isSafeInteger(claims.exp) ||
      !Number.isSafeInteger(claims.iat) ||
      claims.exp * 1000 <= now ||
      claims.iat * 1000 > now + 60_000
    )
      return bad();
    if (
      typeof claims.sub !== "string" ||
      !UUID_RE.test(claims.sub) ||
      typeof claims.session_id !== "string" ||
      !UUID_RE.test(claims.session_id)
    )
      return bad();
    if (
      claims.aud !== "authenticated" ||
      claims.role !== "authenticated" ||
      claims.iss !== JWT_ISS ||
      claims.is_anonymous === true
    )
      return bad();
    if (!this.db.accounts[claims.sub]) return bad();
    return { sub: claims.sub, sid: claims.session_id, iat: claims.iat * 1000 };
  }

  /** The signature headers' shape (Sixkey-Ts, Sixkey-Sig), checked before any row is looked up (M4). */
  private sigShape(c: Ctx, sigHeader = "sixkey-sig"): { ts: number; sig: string } {
    const ts = c.headers["sixkey-ts"];
    const sig = c.headers[sigHeader];
    if (!ts || !/^[0-9]{1,16}$/.test(ts) || !sig || !/^[A-Za-z0-9_-]{86}$/.test(sig)) return fail(401, "bad_signature");
    return { ts: Number(ts), sig };
  }

  /** The signature over the signing input, verified against `spki` for `signer`; wrong: 401 bad_signature. */
  private async verify(
    c: Ctx,
    signer: Signer,
    spkiB64: string,
    sub: string | null,
    sigHeader = "sixkey-sig",
  ): Promise<number> {
    const { ts, sig } = this.sigShape(c, sigHeader);
    let input: string;
    try {
      input = signingInput({
        host: this.host,
        method: c.req.method,
        target: c.req.target,
        signer,
        sub,
        ts,
        bodySha256: await bodyHash(c.req.body ?? null),
      });
    } catch {
      return fail(401, "bad_signature");
    }
    let ok = false;
    try {
      ok = await verifyInput(fromB64(spkiB64), sig, input);
    } catch {
      ok = false;
    }
    if (!ok) fail(401, "bad_signature");
    return ts;
  }

  private checkTs(ts: number): void {
    if (Math.abs(ts - this.now()) > C.SIG_WINDOW_S * 1000) fail(401, "clock_skew");
  }

  /**
   * An enrolled device, M4's order: the headers' shape, the row (401 unknown_device), the signature (bad_signature),
   * revoked (403), the window (clock_skew), then the body (gate, 422). last_seen_at once a UTC day.
   */
  private async device(c: Ctx, sub: string | null = null, onId?: (id: string) => void): Promise<DeviceRow> {
    const id = c.headers["sixkey-device"];
    this.sigShape(c);
    if (!id || !DEVICE_ID_RE.test(id)) return fail(401, "bad_signature");
    const d = this.db.devices[id];
    if (!d) return fail(401, "unknown_device");
    onId?.(id);
    const ts = await this.verify(c, { deviceId: id }, d.sig_pubkey, sub);
    if (d.revoked_at !== null) fail(403, "device_revoked");
    this.checkTs(ts);
    this.gate(c);
    const day = floorToUnit(this.now(), DAY);
    if (d.last_seen_at !== day) d.last_seen_at = day; // the one write a status query makes (T2)
    return d;
  }

  /**
   * A device in enrolment (Sixkey-Enroll: rid), M4's order: the shape; the rid must be the path's (A20: else
   * bad_signature); an unknown or expired request is 410 enroll_gone; the signature; the window; the body.
   */
  private async enrollee(c: Ctx): Promise<EnrollRow> {
    const rid = c.headers["sixkey-enroll"];
    this.sigShape(c);
    if (!rid || !UUID_RE.test(rid) || rid !== c.params[0]) return fail(401, "bad_signature");
    const e = this.liveEnrollment(rid);
    if (!e) return fail(410, "enroll_gone");
    const ts = await this.verify(c, { enrollRid: rid }, e.new_sig_pubkey, null);
    this.checkTs(ts);
    this.gate(c);
    return e;
  }

  /** A2O: exactly one of Sixkey-Device and Sixkey-Enroll on the operations either may call; otherwise bad_signature. */
  private signerKind(c: Ctx): "device" | "enroll" {
    const dev = c.headers["sixkey-device"] !== undefined;
    const enr = c.headers["sixkey-enroll"] !== undefined;
    if (dev === enr) return fail(401, "bad_signature");
    return dev ? "device" : "enroll";
  }

  /**
   * A registration (init, enrolment request, recovery), M4's order: the account session, the headers' shape, the body
   * (422), then Sixkey-Device = the body's device_id, the signature by the body's key with the session's sub, the window.
   */
  private async registration(
    c: Ctx,
    idOf: (b: J) => { deviceId: string; spki: string },
  ): Promise<{ sub: string; sid: string; b: J }> {
    const s = await this.sessionOf(c);
    this.sigShape(c);
    const b = this.gate(c);
    const { deviceId, spki } = idOf(b);
    if (c.headers["sixkey-device"] !== deviceId) fail(401, "bad_signature");
    const ts = await this.verify(c, { deviceId }, spki, s.sub);
    this.checkTs(ts);
    return { sub: s.sub, sid: s.sid, b };
  }

  private liveEnrollment(rid: string): EnrollRow | null {
    const e = this.db.enrollments[rid];
    if (!e) return null;
    if (this.now() >= e.expires_at) {
      delete this.db.enrollments[rid]; // expired rows are deleted on access (§5.3)
      return null;
    }
    return e;
  }

  private openEnrollments(user: string): EnrollRow[] {
    return Object.keys(this.db.enrollments)
      .map((rid) => this.liveEnrollment(rid))
      .filter((e): e is EnrollRow => e !== null && e.user === user);
  }

  private vaultOf(user: string): VaultRow {
    const v = this.db.accounts[user]?.vault;
    return v ?? fail(404, "no_vault");
  }

  /** SHA-256(tag || raw proof) as stored, standard base64. */
  private async verifierOf(tag: string, proofB64: string): Promise<string> {
    return toB64(await taggedDigest(tag, fromB64(proofB64)));
  }

  /**
   * pw_auth or recovery_auth against the stored verifier (§3.14): a wrong one counts against this device (capped at 10,
   * devices_rev with it) and is refused; never a lockout or a backoff. A valid one resets the count, and a reset bumps
   * devices_rev too (A12: the other devices drop the banner). `digest` is computed before (async); the comparison and
   * the counter are in the caller's synchronous step.
   */
  private checkProof(d: DeviceRow | null, vault: VaultRow, digest: string, kind: "password" | "recovery"): void {
    const stored = kind === "password" ? vault.password_verifier : vault.recovery_verifier;
    if (!bytesEqual(fromB64(digest), fromB64(stored))) {
      if (d && d.auth_failures < 10) {
        d.auth_failures += 1;
        vault.devices_rev += 1;
      }
      fail(403, kind === "password" ? "password_mismatch" : "recovery_mismatch");
    }
    if (d && d.auth_failures > 0) {
      d.auth_failures = 0;
      vault.devices_rev += 1;
    }
  }

  private async hmac(keyB64: string, input: string): Promise<string> {
    const k = await crypto.subtle.importKey(
      "raw",
      bs(fromB64(keyB64)),
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign"],
    );
    return toB64(new Uint8Array(await crypto.subtle.sign("HMAC", k, bs(utf8(input)))));
  }

  /** The write proof (§5.2): HMAC(K_write, 'sixkey-write|1|{vaultId}|{if_version}|{checksum}'), constant-time compare. */
  private async writeProofOk(
    vault: VaultRow,
    ifVersion: number,
    checksum: string,
    proof: string,
  ): Promise<{ ok: boolean; key: string }> {
    let input: string;
    try {
      input = writeProofInput({ vaultId: vault.vault_id, ifVersion, checksum });
    } catch {
      return { ok: false, key: vault.write_key };
    }
    const mac = await this.hmac(vault.write_key, input);
    return { ok: bytesEqual(fromB64(mac), fromB64(proof)), key: vault.write_key };
  }

  /** What the keyless checks need of an envelope text (§4.3; strict JSON, A18), before the synchronous step. */
  private async envelopeFacts(text: string): Promise<EnvFacts> {
    let env: EncryptedVault | null = null;
    try {
      env = validateEnvelope(parseStrictJson(text));
    } catch {
      env = null;
    }
    return {
      env,
      intact: env !== null && (await isEnvelopeIntact(env)),
      size: envelopeSizeBytes(text),
      head: await envelopeHead(text),
    };
  }

  /** The Phase 0 shape, integer tokens and checksum (422), then the size (413). */
  private envelope(f: EnvFacts): EncryptedVault {
    if (!f.env || !f.intact) return fail(422, "invalid_request");
    if (f.size > C.MAX_ENVELOPE_BYTES) fail(413, "too_large");
    return f.env;
  }

  /** A bundle text from a request: strict JSON (A18), then M1's upload shape (hour-aligned times, auth salt); 422. */
  private bundle(text: string): KeyBundle {
    try {
      return checkBundleShape(parseStrictJson(text), "upload");
    } catch {
      return fail(422, "invalid_request");
    }
  }

  private storedBundle(v: VaultRow): KeyBundle {
    return checkBundleShape(JSON.parse(v.bundle), "read");
  }

  /** P4 (§2.3, S-2): exactly the verifiers M1's requiredVerifiers says, keyless; anything else 422. */
  private p4(
    stored: KeyBundle,
    next: KeyBundle,
    body: { recovery_verifier?: string; password_verifier?: string },
  ): void {
    let need: { recoveryVerifier: boolean; passwordVerifier: boolean };
    try {
      need = requiredVerifiers(stored, next);
    } catch {
      return fail(422, "invalid_request");
    }
    if (
      need.recoveryVerifier !== (body.recovery_verifier !== undefined) ||
      need.passwordVerifier !== (body.password_verifier !== undefined)
    )
      fail(422, "invalid_request");
  }

  private kverWindow(ifKver: number, kver: number): void {
    if (!(kver > ifKver && kver <= ifKver + C.KVER_MAX_JUMP)) fail(422, "invalid_request");
  }

  /** A19: a device name sealed under the account's current VK (`vkId`), else 422. */
  private nameUnder(n: NameCtWire | undefined | null, vkId: string): void {
    if (n && n.vkId !== vkId) fail(422, "invalid_request");
  }

  // ---- the operations ----------------------------------------------------------------------------------------------

  private async dispatch(c: Ctx, out: { deviceId: string | undefined }): Promise<HttpResponse> {
    const seen = (id: string) => {
      out.deviceId = id;
    };
    switch (c.key) {
      case "GET /healthz":
        return this.respond(200, { ok: true });

      // -- the account session (§5.2) --
      case "POST /v1/auth/otp": {
        const b = this.gate(c);
        const email = String(b.email).trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, "invalid_email");
        const code = String(Math.floor((new DataView(randomBytes(4).buffer).getUint32(0) / 2 ** 32) * 1e6)).padStart(
          6,
          "0",
        );
        this.db.otps[email] = { code, exp: this.now() + OTP_TTL_MS, attempts: 0 };
        return this.respond(202, {});
      }
      case "POST /v1/auth/verify": {
        const b = this.gate(c);
        const email = String(b.email).trim().toLowerCase();
        const o = this.db.otps[email];
        if (!o || this.now() >= o.exp || o.attempts >= 5) return fail(401, "otp_invalid");
        o.attempts += 1;
        if (o.code !== b.token) return fail(401, "otp_invalid");
        delete this.db.otps[email];
        let sub = this.db.emailToSub[email];
        if (!sub || !this.db.accounts[sub]) {
          sub = crypto.randomUUID();
          this.db.emailToSub[email] = sub;
          this.db.accounts[sub] = { sub, email, vault: null, history: [], created_at: this.hour() };
        }
        const now = this.now();
        const token = await this.issueToken(sub, now);
        return this.respond(200, { account_token: token, expires_at: Math.floor(now / 1000) * 1000 + SESSION_TTL_MS });
      }
      case "GET /v1/account": {
        const s = await this.sessionOf(c);
        const a = this.db.accounts[s.sub]!;
        if (!a.vault) return this.respond(200, { has_vault: false });
        const count = Object.values(this.db.devices).filter((d) => d.user === s.sub && d.revoked_at === null).length;
        return this.respond(200, { has_vault: true, vault_created_at: a.vault.created_at, device_count: count });
      }
      case "DELETE /v1/account": {
        const s = await this.sessionOf(c);
        const d = await this.device(c, s.sub, seen);
        const b = c.body;
        if (s.sub !== d.user || this.now() - s.iat > STEP_UP_MS) fail(401, "step_up_required");
        const vault = this.vaultOf(d.user);
        const digest = await this.verifierOf(TAG.passwordVerifier, b.password_auth);
        this.checkProof(d, vault, digest, "password");
        const a = this.db.accounts[d.user]!;
        for (const [id, x] of Object.entries(this.db.devices)) if (x.user === a.sub) delete this.db.devices[id];
        for (const [id, x] of Object.entries(this.db.enrollments)) if (x.user === a.sub) delete this.db.enrollments[id];
        delete this.db.accounts[a.sub];
        delete this.db.emailToSub[a.email];
        return this.respond(204);
      }

      // -- the vault (§3.1, §4.2, §5.3) --
      case "POST /v1/vault/init": {
        const { sub, b } = await this.registration(c, (x) => ({
          deviceId: x.device.device_id,
          spki: x.device.sig_pubkey,
        }));
        const dev = b.device;
        const facts = await this.envelopeFacts(b.envelope);
        const env = this.envelope(facts);
        const bundle = this.bundle(b.bundle);
        if (
          env.rev !== 1 ||
          env.vaultId !== b.vault_id ||
          bundle.vaultId !== b.vault_id ||
          bundle.kver !== 1 ||
          bundle.keyring.vkId !== env.vkId ||
          bundle.by !== dev.device_id
        )
          fail(422, "invalid_request");
        this.nameUnder(dev.name_ct, env.vkId);
        // one synchronous step from here: of two concurrent inits, one wins
        const a = this.db.accounts[sub]!;
        if (a.vault) {
          // D4, as M4: the same vault id and bundle text, and this very device and key in the account: the same 201
          const mine = this.db.devices[dev.device_id];
          if (
            a.vault.vault_id === b.vault_id &&
            a.vault.bundle === b.bundle &&
            mine?.user === sub &&
            mine.sig_pubkey === dev.sig_pubkey
          )
            return this.respond(201, { version: 1, kver: 1 });
          return fail(409, "vault_exists");
        }
        if (this.db.devices[dev.device_id]) fail(409, "device_exists");
        const head = facts.head;
        const hour = this.hour();
        const size = facts.size;
        a.vault = {
          vault_id: b.vault_id,
          version: 1,
          vk_id: env.vkId,
          envelope: b.envelope,
          head,
          devices_rev: 1,
          size_bytes: size,
          kver: 1,
          bundle: b.bundle,
          recovery_verifier: b.recovery_verifier,
          password_verifier: b.password_verifier,
          write_key: b.write_key,
          created_at: hour,
          updated_at: hour,
        };
        a.history = [{ version: 1, vk_id: env.vkId, envelope: b.envelope, size_bytes: size, created_at: hour }];
        this.db.devices[dev.device_id] = {
          device_id: dev.device_id,
          user: a.sub,
          sig_pubkey: dev.sig_pubkey,
          name_ct: dev.name_ct,
          joined_via: "first",
          approved_by: null,
          created_at: hour,
          last_seen_at: null,
          revoked_at: null,
          auth_failures: 0,
          cursor: null,
        };
        return this.respond(201, { version: 1, kver: 1 });
      }
      case "GET /v1/sync/status": {
        const d = await this.device(c, null, seen);
        const v = this.vaultOf(d.user);
        const pending = this.openEnrollments(d.user).filter(
          (e) => e.via === "approval" && e.state === "pending",
        ).length;
        return this.respond(200, {
          version: v.version,
          head: v.head,
          vk_id: v.vk_id,
          kver: v.kver,
          pending_enrollments: pending,
          devices_rev: v.devices_rev,
          min_client_version: this.minClientVersion,
        });
      }
      case "GET /v1/vault": {
        const d = await this.device(c, null, seen);
        const v = this.vaultOf(d.user);
        return this.respond(200, { version: v.version, envelope: v.envelope });
      }
      case "PUT /v1/vault": {
        // M4's order: the envelope (shape, rev, vaultId: 422), the CAS (409 version_conflict, vk_mismatch), then the write
        // proof (403 write_denied), then the transaction. A write racing a rotation is therefore a 409, never a 403.
        const d = await this.device(c, null, seen);
        const b = c.body;
        const facts = await this.envelopeFacts(b.envelope);
        const env0 = this.envelope(facts);
        if (env0.rev !== b.if_version + 1) fail(422, "invalid_request");
        const proof = await this.writeProofOk(this.vaultOf(d.user), b.if_version, env0.checksum, b.write_proof);
        // The transaction: one synchronous step from here (the device row's lock and the CAS, §5.3 C3).
        const v = this.vaultOf(d.user);
        if (env0.vaultId !== v.vault_id) fail(422, "invalid_request");
        if (v.version !== b.if_version)
          fail(409, "version_conflict", { version: v.version, vk_id: v.vk_id, kver: v.kver });
        if (v.vk_id !== env0.vkId) fail(409, "vk_mismatch");
        if (!proof.ok || v.write_key !== proof.key) fail(403, "write_denied");
        if (this.db.devices[d.device_id]?.revoked_at !== null) fail(403, "device_revoked");
        const cur: string | undefined = b.cursor.cur;
        const pend: string = b.cursor.pending;
        let forked = false;
        if (d.cursor === null || d.cursor === cur) d.cursor = pend;
        else if (d.cursor !== pend) forked = true;
        v.version += 1;
        v.envelope = b.envelope;
        v.head = facts.head;
        v.size_bytes = facts.size;
        v.updated_at = this.hour();
        this.db.accounts[d.user]!.history.push({
          version: v.version,
          vk_id: v.vk_id,
          envelope: b.envelope,
          size_bytes: v.size_bytes,
          created_at: this.hour(),
        });
        return this.respond(200, { version: v.version, forked });
      }
      case "GET /v1/vault/versions": {
        const d = await this.device(c, null, seen);
        this.vaultOf(d.user);
        const h = [...this.db.accounts[d.user]!.history].sort((x, y) => y.version - x.version);
        return this.respond(200, {
          versions: h.map((r) => ({
            version: r.version,
            vk_id: r.vk_id,
            size_bytes: r.size_bytes,
            created_at: r.created_at,
          })),
        });
      }
      case "DELETE /v1/vault/versions": {
        const d = await this.device(c, null, seen);
        const v = this.vaultOf(d.user);
        const digest = await this.verifierOf(TAG.passwordVerifier, c.body.password_auth);
        this.checkProof(d, v, digest, "password");
        const a = this.db.accounts[d.user]!;
        const before = a.history.length;
        a.history = a.history.filter((r) => r.version === v.version);
        return this.respond(200, { deleted: before - a.history.length });
      }
      case "GET /v1/vault/versions/{v}": {
        const d = await this.device(c, null, seen);
        this.vaultOf(d.user);
        const raw = c.params[0] ?? "";
        const n = /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : NaN;
        const r = this.db.accounts[d.user]!.history.find((x) => x.version === n);
        if (!r) return fail(404, "not_found");
        return this.respond(200, { version: r.version, envelope: r.envelope });
      }

      // -- keys (§3.6–§3.8, §4.2; the check order of §5.3 A5) --
      case "GET /v1/keys": {
        const d = await this.device(c, null, seen);
        const v = this.vaultOf(d.user);
        return this.respond(200, { kver: v.kver, bundle: v.bundle });
      }
      case "PUT /v1/keys": {
        // A5: shape and the kver range (422); the byte-identical stored text (the idempotent 200, before any proof: a
        // replay carries the proof of the state it replaced); the CAS (409, before the proof: an honest race is not a
        // wrong password); the proof (403, counted); vaultId, vkId, by and P4 (422); the transaction.
        const d = await this.device(c, null, seen);
        const b = c.body;
        const next = this.bundle(b.bundle);
        this.kverWindow(b.if_kver, next.kver);
        const kind = b.password_auth !== undefined ? "password" : "recovery";
        const digest = await this.verifierOf(
          kind === "password" ? TAG.passwordVerifier : TAG.recoveryVerifier,
          kind === "password" ? b.password_auth : b.recovery_auth,
        );
        // one synchronous step from here
        const v = this.vaultOf(d.user);
        if (b.bundle === v.bundle) return this.respond(200, { kver: v.kver });
        if (b.if_kver !== v.kver) fail(409, "keys_conflict");
        this.checkProof(d, v, digest, kind);
        if (next.vaultId !== v.vault_id || next.keyring.vkId !== v.vk_id || next.by !== d.device_id)
          fail(422, "invalid_request");
        this.p4(this.storedBundle(v), next, b);
        v.bundle = b.bundle;
        v.kver = next.kver;
        if (b.recovery_verifier !== undefined) v.recovery_verifier = b.recovery_verifier;
        if (b.password_verifier !== undefined) v.password_verifier = b.password_verifier;
        return this.respond(200, { kver: v.kver });
      }
      case "POST /v1/keys/rotate": {
        // A5, A7: shape (the envelope, the bundle, rev = if_version + 1, the kver range: 422); the idempotent 200; the CAS
        // with keys_conflict first when both are stale (a key race voids this rotation); version_conflict; the write
        // proof (403); pw_auth (403, counted); vaultId, vkId, by, P4 (both verifiers) and the names (A6: no duplicate,
        // under the new VK, devices of this account: 422); then the transaction.
        const d = await this.device(c, null, seen);
        const b = c.body;
        const facts = await this.envelopeFacts(b.envelope);
        const env = this.envelope(facts);
        const next = this.bundle(b.bundle);
        if (env.rev !== b.if_version + 1) fail(422, "invalid_request");
        this.kverWindow(b.if_kver, next.kver);
        const digest = await this.verifierOf(TAG.passwordVerifier, b.password_auth);
        const proof = await this.writeProofOk(this.vaultOf(d.user), b.if_version, env.checksum, b.write_proof);
        // one synchronous transaction from here (§5.3)
        const v = this.vaultOf(d.user);
        if (b.bundle === v.bundle) return this.respond(200, { version: v.version, kver: v.kver });
        if (v.kver !== b.if_kver) fail(409, "keys_conflict");
        if (v.version !== b.if_version)
          fail(409, "version_conflict", { version: v.version, vk_id: v.vk_id, kver: v.kver });
        if (!proof.ok || v.write_key !== proof.key) fail(403, "write_denied");
        this.checkProof(d, v, digest, "password");
        if (
          env.vaultId !== v.vault_id ||
          next.vaultId !== v.vault_id ||
          next.keyring.vkId !== env.vkId ||
          next.by !== d.device_id
        )
          fail(422, "invalid_request");
        this.p4(this.storedBundle(v), next, b);
        const names: { device_id: string; name_ct: NameCtWire }[] = b.device_names;
        const ids = new Set<string>();
        for (const n of names) {
          if (ids.has(n.device_id)) fail(422, "invalid_request");
          ids.add(n.device_id);
          this.nameUnder(n.name_ct, env.vkId);
        }
        if (this.db.devices[d.device_id]?.revoked_at !== null) fail(403, "device_revoked");
        for (const n of names) if (this.db.devices[n.device_id]?.user !== d.user) fail(422, "invalid_request");
        v.version += 1;
        v.envelope = b.envelope;
        v.head = facts.head;
        v.size_bytes = facts.size;
        v.vk_id = next.keyring.vkId;
        v.write_key = b.new_write_key;
        v.kver = next.kver;
        v.bundle = b.bundle;
        v.recovery_verifier = b.recovery_verifier;
        v.password_verifier = b.password_verifier;
        v.updated_at = this.hour();
        this.db.accounts[d.user]!.history.push({
          version: v.version,
          vk_id: v.vk_id,
          envelope: b.envelope,
          size_bytes: v.size_bytes,
          created_at: this.hour(),
        });
        for (const n of names) this.db.devices[n.device_id]!.name_ct = n.name_ct;
        if (names.length) v.devices_rev += 1;
        for (const [rid, e] of Object.entries(this.db.enrollments))
          if (e.user === d.user) delete this.db.enrollments[rid];
        return this.respond(200, { version: v.version, kver: v.kver });
      }

      // -- devices (§3.10, §4.10) --
      case "GET /v1/devices": {
        const d = await this.device(c, null, seen);
        const list = Object.values(this.db.devices)
          .filter((x) => x.user === d.user)
          .map((x) => ({
            device_id: x.device_id,
            name_ct: x.name_ct,
            joined_via: x.joined_via,
            approved_by: x.approved_by,
            created_at: x.created_at,
            last_seen_at: x.last_seen_at,
            revoked_at: x.revoked_at,
            auth_failures: x.auth_failures,
          }));
        return this.respond(200, { current: d.device_id, devices: list });
      }
      case "PATCH /v1/devices/{id}": {
        const d = await this.device(c, null, seen);
        const v = this.vaultOf(d.user);
        const digest = await this.verifierOf(TAG.passwordVerifier, c.body.password_auth);
        this.checkProof(d, v, digest, "password");
        const target = this.db.devices[c.params[0] ?? ""];
        if (!target || target.user !== d.user) return fail(404, "not_found");
        this.nameUnder(c.body.name_ct, v.vk_id);
        target.name_ct = c.body.name_ct;
        v.devices_rev += 1;
        return this.respond(200, {});
      }
      case "POST /v1/devices/{id}/revoke": {
        const d = await this.device(c, null, seen);
        const v = this.vaultOf(d.user);
        const digest = await this.verifierOf(TAG.passwordVerifier, c.body.password_auth);
        this.checkProof(d, v, digest, "password");
        const target = this.db.devices[c.params[0] ?? ""];
        if (!target || target.user !== d.user) return fail(404, "not_found");
        if (target.revoked_at === null) {
          target.revoked_at = this.hour();
          v.devices_rev += 1;
          // its unfinished approvals are void (§3.10)
          for (const [rid, e] of Object.entries(this.db.enrollments))
            if (e.approver_device_id === target.device_id) delete this.db.enrollments[rid];
        }
        return this.respond(200, { revoked_at: target.revoked_at });
      }
      case "POST /v1/devices/fork": {
        const d = await this.device(c, null, seen);
        const b = c.body;
        await this.verify(c, { deviceId: d.device_id }, b.new_sig_pubkey, null, "sixkey-new-sig");
        const v = this.vaultOf(d.user);
        const digest = await this.verifierOf(TAG.passwordVerifier, b.password_auth);
        this.checkProof(d, v, digest, "password");
        this.nameUnder(b.name_ct, v.vk_id);
        if (this.db.devices[b.new_device_id]) fail(409, "device_exists");
        if (this.liveDevices(d.user) >= MAX_DEVICES) fail(409, "too_many_devices");
        this.db.devices[b.new_device_id] = {
          device_id: b.new_device_id,
          user: d.user,
          sig_pubkey: b.new_sig_pubkey,
          name_ct: b.name_ct,
          joined_via: "fork",
          approved_by: d.device_id,
          created_at: this.hour(),
          last_seen_at: null,
          revoked_at: null,
          auth_failures: 0,
          cursor: null,
        };
        v.devices_rev += 1;
        return this.respond(201, { device_id: b.new_device_id });
      }

      // -- enrolment (§3.2, §3.3; §5.4 A13–A17) --
      case "POST /v1/enroll/requests": {
        const { sub, sid, b } = await this.registration(c, (x) => ({ deviceId: x.device_id, spki: x.sig_pubkey }));
        this.vaultOf(sub);
        if (this.db.devices[b.device_id]) fail(409, "device_exists");
        if (this.sessionBusy(sid, sub)) fail(409, "one_per_session");
        const now = this.now();
        const rid = crypto.randomUUID();
        const expires = ceilToUnit(now + C.ENROLL_TTL_S * 1000, MINUTE); // A13
        this.db.enrollments[rid] = {
          request_id: rid,
          user: sub,
          via: "approval",
          session_ref: sid,
          new_device_id: b.device_id,
          new_sig_pubkey: b.sig_pubkey,
          commit: b.commit,
          state: "pending",
          approver_device_id: null,
          approver_epk: null,
          new_epk: null,
          new_nonce: null,
          new_name_ct: null,
          transcript_hash: null,
          payload: null,
          name_ct: null,
          created_at: floorToUnit(now, MINUTE),
          expires_at: expires,
        };
        return this.respond(201, { request_id: rid, expires_at: expires });
      }
      case "GET /v1/enroll/requests": {
        const d = await this.device(c, null, seen);
        const list = this.openEnrollments(d.user)
          .filter((e) => e.via === "approval")
          .map((e) => ({
            request_id: e.request_id,
            created_at: e.created_at,
            expires_at: e.expires_at,
            state: e.state,
            ...(e.approver_device_id ? { handled_by: e.approver_device_id } : {}),
          }));
        return this.respond(200, { requests: list });
      }
      case "GET /v1/enroll/requests/{rid}": {
        if (this.signerKind(c) === "enroll") {
          const e = await this.enrollee(c);
          if (e.via !== "approval") fail(410, "enroll_gone"); // A14: a recovery request is never polled
          const view: Record<string, unknown> = { state: e.state };
          if (e.state !== "pending")
            Object.assign(view, { approver_device_id: e.approver_device_id, approver_epk: e.approver_epk });
          if (e.state === "approved") view.payload = e.payload;
          return this.respond(200, view);
        }
        const d = await this.device(c, null, seen);
        const e = this.requestOf(c, d);
        const view: Record<string, unknown> = {
          state: e.state,
          new_device_id: e.new_device_id,
          new_sig_pubkey: e.new_sig_pubkey,
          commit: e.commit,
        };
        if (e.state === "revealed" || e.state === "approved")
          Object.assign(view, { new_epk: e.new_epk, new_nonce: e.new_nonce, new_name_ct: e.new_name_ct });
        return this.respond(200, view);
      }
      case "POST /v1/enroll/requests/{rid}/respond": {
        const d = await this.device(c, null, seen);
        const v = this.vaultOf(d.user);
        this.requestOf(c, d);
        const digest = await this.verifierOf(TAG.passwordVerifier, c.body.password_auth);
        this.checkProof(d, v, digest, "password");
        const e = this.requestOf(c, d);
        // A15: the same approver with the same epk again is 200 (its answer was lost); anything else 409
        if (e.state === "responded" && e.approver_device_id === d.device_id && e.approver_epk === c.body.epk)
          return this.respond(200, { state: "responded" });
        if (e.state !== "pending")
          fail(409, "enroll_state", e.approver_device_id ? { handled_by: e.approver_device_id } : {});
        e.state = "responded";
        e.approver_device_id = d.device_id;
        e.approver_epk = c.body.epk;
        return this.respond(200, { state: "responded" });
      }
      case "POST /v1/enroll/requests/{rid}/reveal": {
        const e = await this.enrollee(c);
        const b = c.body;
        if (e.via !== "approval") fail(410, "enroll_gone");
        // A15: an identical reveal again is 200 (revealed, or already approved); different values 409
        if (
          (e.state === "revealed" || e.state === "approved") &&
          e.new_epk === b.epk &&
          e.new_nonce === b.nonce &&
          e.new_name_ct === b.name_ct
        )
          return this.respond(200, { state: "revealed" });
        if (e.state !== "responded")
          fail(409, "enroll_state", e.approver_device_id ? { handled_by: e.approver_device_id } : {});
        e.state = "revealed";
        e.new_epk = b.epk;
        e.new_nonce = b.nonce;
        e.new_name_ct = b.name_ct;
        return this.respond(200, { state: "revealed" });
      }
      case "POST /v1/enroll/requests/{rid}/approve": {
        const d = await this.device(c, null, seen);
        const v = this.vaultOf(d.user);
        const b = c.body;
        this.requestOf(c, d);
        const digest = await this.verifierOf(TAG.passwordVerifier, b.password_auth);
        this.checkProof(d, v, digest, "password");
        const e = this.requestOf(c, d);
        const keyHash = toB64(await sha256(fromB64(e.new_sig_pubkey)));
        // A15: a repeated approve is 409 (MUST 8: a lost 200 is recovered by polling)
        if (e.state !== "revealed" || e.approver_device_id !== d.device_id)
          fail(409, "enroll_state", e.approver_device_id ? { handled_by: e.approver_device_id } : {});
        if (b.sig_pubkey_sha256 !== keyHash) fail(422, "key_mismatch");
        this.nameUnder(b.name_ct, v.vk_id);
        e.state = "approved";
        e.transcript_hash = b.transcript_hash;
        e.payload = b.payload;
        e.name_ct = b.name_ct;
        return this.respond(200, { state: "approved" });
      }
      case "POST /v1/enroll/requests/{rid}/complete": {
        // A16, A17: the first complete deletes the request, so a retry of this rid is 410 (the joining device then asks
        // the status as devN, D4); another request for the same device and key in this account is 200; a device id
        // taken meanwhile is 409 enroll_state and the request survives. name_ct: 422 on the approval path; optional on
        // the recovery path, under the current VK (A19).
        const e = await this.enrollee(c);
        const b = c.body;
        if (e.state !== "approved")
          fail(409, "enroll_state", e.approver_device_id ? { handled_by: e.approver_device_id } : {});
        const v = this.vaultOf(e.user);
        if (e.via === "approval" && b.name_ct !== undefined) fail(422, "invalid_request");
        if (e.via === "recovery") this.nameUnder(b.name_ct, v.vk_id);
        const existing = this.db.devices[e.new_device_id];
        if (existing) {
          if (existing.user === e.user && existing.sig_pubkey === e.new_sig_pubkey) {
            delete this.db.enrollments[e.request_id];
            return this.respond(200, { device_id: existing.device_id });
          }
          return fail(409, "enroll_state");
        }
        if (this.liveDevices(e.user) >= MAX_DEVICES) fail(409, "too_many_devices");
        this.db.devices[e.new_device_id] = {
          device_id: e.new_device_id,
          user: e.user,
          sig_pubkey: e.new_sig_pubkey,
          name_ct: e.via === "approval" ? e.name_ct : (b.name_ct ?? null),
          joined_via: e.via,
          approved_by: e.via === "approval" ? e.approver_device_id : null,
          created_at: this.hour(),
          last_seen_at: null,
          revoked_at: null,
          auth_failures: 0,
          cursor: null,
        };
        v.devices_rev += 1;
        delete this.db.enrollments[e.request_id];
        return this.respond(200, { device_id: e.new_device_id });
      }
      case "POST /v1/enroll/requests/{rid}/reject": {
        if (this.signerKind(c) === "enroll") {
          const e = await this.enrollee(c);
          if (c.body.password_auth !== undefined) fail(422, "invalid_request");
          delete this.db.enrollments[e.request_id];
          return this.respond(200, {});
        }
        const d = await this.device(c, null, seen);
        const v = this.vaultOf(d.user);
        // A11: an enrolled device without pw_auth made no guess: 403, not counted
        if (c.body.password_auth === undefined) fail(403, "password_mismatch");
        const digest = await this.verifierOf(TAG.passwordVerifier, c.body.password_auth);
        this.checkProof(d, v, digest, "password");
        const rid = c.params[0] ?? "";
        const e0 = this.liveEnrollment(rid);
        if (!e0 || e0.user !== d.user) fail(410, "enroll_gone");
        delete this.db.enrollments[rid];
        return this.respond(200, {});
      }
      case "POST /v1/enroll/reject-all": {
        // A14, A2: every open request of the account, approval and recovery alike, created at or before the minute of
        // the signed Sixkey-Ts (a replay in the window cannot reject later requests); `rejected` counts the unexpired ones.
        const d = await this.device(c, null, seen);
        const v = this.vaultOf(d.user);
        const digest = await this.verifierOf(TAG.passwordVerifier, c.body.password_auth);
        this.checkProof(d, v, digest, "password");
        const bound = floorToUnit(Number(c.headers["sixkey-ts"]), MINUTE);
        const open = this.openEnrollments(d.user).filter((e) => e.created_at <= bound);
        for (const e of open) delete this.db.enrollments[e.request_id];
        return this.respond(200, { rejected: open.length });
      }
      case "POST /v1/enroll/recovery": {
        const { sub, sid, b } = await this.registration(c, (x) => ({ deviceId: x.device_id, spki: x.sig_pubkey }));
        const v = this.vaultOf(sub);
        const digest = await this.verifierOf(TAG.recoveryVerifier, b.recovery_auth);
        this.checkProof(null, this.vaultOf(sub), digest, "recovery");
        const answer = (e: EnrollRow) =>
          this.respond(200, {
            request_id: e.request_id,
            vault_id: v.vault_id,
            version: v.version,
            envelope: v.envelope,
            kver: v.kver,
            bundle: v.bundle,
          });
        const again = this.openEnrollments(sub).find(
          (e) => e.via === "recovery" && e.new_device_id === b.device_id && e.new_sig_pubkey === b.sig_pubkey,
        );
        if (again) return answer(again); // the same device and key within the window: the same result (§3.3)
        if (this.db.devices[b.device_id]) fail(409, "device_exists");
        if (this.sessionBusy(sid, sub)) fail(409, "one_per_session");
        const now = this.now();
        const rid = crypto.randomUUID();
        const row: EnrollRow = {
          request_id: rid,
          user: sub,
          via: "recovery",
          session_ref: sid,
          new_device_id: b.device_id,
          new_sig_pubkey: b.sig_pubkey,
          commit: null,
          state: "approved",
          approver_device_id: null,
          approver_epk: null,
          new_epk: null,
          new_nonce: null,
          new_name_ct: null,
          transcript_hash: null,
          payload: null,
          name_ct: null,
          created_at: floorToUnit(now, MINUTE),
          expires_at: ceilToUnit(now + C.ENROLL_TTL_S * 1000, MINUTE),
        };
        this.db.enrollments[rid] = row;
        return answer(row);
      }
    }
    return fail(404, "not_found");
  }

  /** The request in the path, as an enrolled device of the same account may handle it (approval only); else 410. */
  private requestOf(c: Ctx, d: DeviceRow): EnrollRow {
    const e = this.liveEnrollment(c.params[0] ?? "");
    if (!e || e.user !== d.user || e.via !== "approval") return fail(410, "enroll_gone");
    return e;
  }

  private sessionBusy(sid: string, user: string): boolean {
    return this.openEnrollments(user).some((e) => e.session_ref === sid);
  }

  private liveDevices(user: string): number {
    return Object.values(this.db.devices).filter((d) => d.user === user && d.revoked_at === null).length;
  }
}

/** Every operation of the contract, as "METHOD /path" keys (for coverage assertions). */
export const contractOperations = (): string[] => operations(contract()).map((o) => `${o.method} ${o.path}`);
