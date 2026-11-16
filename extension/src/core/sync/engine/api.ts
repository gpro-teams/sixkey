// The API client the engine and the enrolment drivers use (SYNC-DESIGN §5.2, §5.4; api/openapi.yaml): the 29 operations
// as typed calls over the injected Transport. It builds the exact body text, signs it with M1's signRequest (the device
// signature, the enrolment signature, the registration signature with the account session's sub), maps error bodies to
// ApiError, reports every response's server time (body server_time, or the Date header for a 204), and retries once on
// 401 clock_skew with the server's time (§4.14). Nothing is logged, and an error carries only status, code and the
// contract's detail numbers, never a body, a header value or a secret.
//
// Responses are untrusted: this layer checks only the shape the engine relies on to route a response (numbers are
// numbers, texts are texts). What a text holds (an envelope, a bundle) is checked where it is used (remote.ts, M1).
import { toB64 } from "../../crypto/bytes";
import { fromB64u, UUID_RE } from "../crypto/encoding";
import { apiHost, signForkRequest, signRequest, type RequestToSign, type Signer } from "../crypto/signature";
import { NetworkError, type HttpMethod, type HttpResponse, type Transport } from "./transport";

/** An enrolled device signs as itself (Sixkey-Device). */
export type DeviceSigner = { kind: "device"; deviceId: string; key: CryptoKey };
/** A device in enrolment signs as enroll:{rid} (Sixkey-Enroll). */
export type EnrollSigner = { kind: "enroll"; rid: string; key: CryptoKey };
/** A registration request is signed by the new key, as the body's device_id (§5.2 N8), with the session's sub. */
export type RegistrationSigner = { kind: "registration"; deviceId: string; key: CryptoKey };
/** An account session (§0.1): the token for Authorization, and its JWT sub for the signing input. Memory only. */
export type AccountSession = { token: string; sub: string };

/**
 * The account session from verify's token (§5.2; M4 hands out Supabase's ES256 access token): the JWT's `sub` is what a
 * registration signs (init, the enrolment request, the recovery join). Read, not verified: the server verifies it, and a
 * wrong sub only makes the server refuse the signature. Not a JWT, or no UUID sub: malformed_response.
 */
export function sessionFromToken(token: string): AccountSession {
  const parts = token.split(".");
  let claims: unknown = null;
  if (parts.length === 3) {
    try {
      claims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromB64u(parts[1]!)));
    } catch {
      claims = null;
    }
  }
  if (!isObj(claims) || !str(claims.sub) || !UUID_RE.test(claims.sub)) throw new ApiError(502, "malformed_response");
  return { token, sub: claims.sub };
}

export type ErrorDetails = {
  retry_after?: number;
  version?: number;
  vk_id?: string;
  kver?: number;
  handled_by?: string;
};

/** A non-2xx answer: the status, the contract's error code, and the contract's detail members (§5.4). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: ErrorDetails = {},
    readonly serverTime: number | null = null,
  ) {
    super(`api ${status} ${code}`);
    this.name = "ApiError";
  }
}

export type StatusResponse = {
  version: number;
  head: string;
  vk_id: string;
  kver: number;
  pending_enrollments: number;
  devices_rev: number;
  min_client_version: string;
  server_time: number;
};
export type VaultResponse = { version: number; envelope: string; server_time: number };
export type PutVaultBody = {
  if_version: number;
  envelope: string;
  write_proof: string;
  cursor: { cur?: string; pending: string };
};
export type PutVaultResponse = { version: number; forked: boolean; server_time: number };
export type VersionInfo = { version: number; vk_id: string; size_bytes: number; created_at: number };
export type KeysResponse = { kver: number; bundle: string; server_time: number };
export type PutKeysBody = {
  if_kver: number;
  bundle: string;
  password_auth?: string;
  recovery_auth?: string;
  recovery_verifier?: string;
  password_verifier?: string;
};
export type NameCtWire = { vkId: string; iv: string; ct: string };
export type RotateBody = {
  if_version: number;
  if_kver: number;
  envelope: string;
  write_proof: string;
  new_write_key: string;
  bundle: string;
  password_auth: string;
  recovery_verifier: string;
  password_verifier: string;
  device_names: { device_id: string; name_ct: NameCtWire }[];
};
export type DeviceInfo = {
  device_id: string;
  name_ct: NameCtWire | null;
  joined_via: string;
  approved_by: string | null;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  auth_failures: number;
};
export type DevicesResponse = { current: string; devices: DeviceInfo[]; server_time: number };
export type InitBody = {
  vault_id: string;
  envelope: string;
  bundle: string;
  recovery_verifier: string;
  password_verifier: string;
  write_key: string;
  device: { device_id: string; sig_pubkey: string; name_ct: NameCtWire };
};
export type EnrollListItem = {
  request_id: string;
  created_at: number;
  expires_at: number;
  state: string;
  handled_by?: string;
};
export type RecoveryEnrollResponse = {
  request_id: string;
  vault_id: string;
  version: number;
  envelope: string;
  kver: number;
  bundle: string;
  server_time: number;
};

/** What every response carries for the clock: the server's time and when it was observed locally (§4.14). */
export type ServerTimeSample = { serverMs: number; sentAt: number; receivedAt: number };

export type ApiOptions = {
  transport: Transport;
  /** The configured API origin (§5.2: its URL.host is the signed host, never a Host header seen behind a proxy). */
  origin: string;
  /** This machine's clock. */
  now: () => number;
  /** The current server offset estimate (ms, already clamped by the caller): Sixkey-Ts is corrected time (§4.14). */
  offset: () => number;
  /** Every response's server time, for the offset (§4.14). */
  onServerTime?: (s: ServerTimeSample) => void;
};

type Call = {
  method: HttpMethod;
  target: string;
  body?: unknown; // serialized with JSON.stringify: envelopes and bundles are already strings in it (raw text, §2.3)
  signer?: DeviceSigner | EnrollSigner | RegistrationSigner;
  session?: AccountSession;
  forkKey?: CryptoKey; // POST /v1/devices/fork: Sixkey-New-Sig by the new key over the same input (N1)
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const int = (x: unknown): x is number => Number.isSafeInteger(x);
const str = (x: unknown): x is string => typeof x === "string";

/** A response that does not have the shape the contract promises: treated like a server failure (nothing trusted). */
function malformed(status: number): ApiError {
  return new ApiError(status >= 200 && status < 300 ? 502 : status, "malformed_response");
}

export class SyncApi {
  readonly host: string;
  constructor(private readonly o: ApiOptions) {
    this.host = apiHost(o.origin);
  }

  // ---- the generic exchange ---------------------------------------------------------------------------------------

  private async exchange(c: Call, retried = false): Promise<{ status: number; json: unknown }> {
    const text = c.body === undefined ? undefined : JSON.stringify(c.body);
    const headers: Record<string, string> = {};
    if (text !== undefined) headers["Content-Type"] = "application/json";
    if (c.session) headers["Authorization"] = `Bearer ${c.session.token}`;
    if (c.signer) {
      const ts = Math.max(0, Math.round(this.o.now() + this.o.offset()));
      const signer: Signer = c.signer.kind === "enroll" ? { enrollRid: c.signer.rid } : { deviceId: c.signer.deviceId };
      const req: RequestToSign = {
        host: this.host,
        method: c.method,
        target: c.target,
        signer,
        sub: c.session?.sub ?? null,
        ts,
        body: text ?? null,
      };
      Object.assign(
        headers,
        c.forkKey ? await signForkRequest(c.signer.key, c.forkKey, req) : await signRequest(c.signer.key, req),
      );
    }
    const sentAt = this.o.now();
    let res: HttpResponse;
    try {
      res = await this.o.transport.send({
        method: c.method,
        target: c.target,
        headers,
        ...(text !== undefined ? { body: text } : {}),
      });
    } catch (e) {
      throw e instanceof NetworkError ? e : new NetworkError("unknown");
    }
    const receivedAt = this.o.now();
    let json: unknown = undefined;
    if (res.body !== "") {
      try {
        json = JSON.parse(res.body);
      } catch {
        json = undefined;
      }
    }
    // A server_time of 0 (M4's outermost 500 handler can send it) is no clock: the Date header, or nothing (D-review)
    const serverMs =
      isObj(json) && int(json.server_time) && json.server_time > 0 ? json.server_time : dateHeader(res.headers["date"]);
    if (serverMs !== null) this.o.onServerTime?.({ serverMs, sentAt, receivedAt });
    if (res.status >= 200 && res.status < 300) return { status: res.status, json };
    const err = isObj(json) && isObj(json.error) && str(json.error.code) ? json.error : null;
    // M3R-13: the code is stored (lastErrorCode) and shown: only a short snake_case word is taken as it came
    const fallback = res.status >= 500 ? (res.status === 503 ? "unavailable" : "internal_error") : "malformed_response";
    const code =
      err && /^[a-z_]{1,40}$/.test(err.code as string) ? (err.code as string) : err ? "malformed_response" : fallback;
    const details: ErrorDetails = {};
    if (err) {
      if (int(err.retry_after)) details.retry_after = err.retry_after;
      if (int(err.version)) details.version = err.version;
      if (str(err.vk_id)) details.vk_id = err.vk_id;
      if (int(err.kver)) details.kver = err.kver;
      if (str(err.handled_by)) details.handled_by = err.handled_by;
    }
    const ra = retryAfterHeader(res.headers["retry-after"]);
    if (details.retry_after === undefined && ra !== null) details.retry_after = ra;
    // §4.14: a signature outside the window is answered with the server's time; adopt it and try once more.
    if (res.status === 401 && code === "clock_skew" && c.signer && !retried) return this.exchange(c, true);
    throw new ApiError(res.status, code, details, serverMs);
  }

  private async json(c: Call, check: (j: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    const r = await this.exchange(c);
    if (!isObj(r.json) || !check(r.json)) throw malformed(r.status);
    return r.json;
  }

  // ---- account session (§5.2) -------------------------------------------------------------------------------------

  async otp(email: string): Promise<void> {
    await this.exchange({ method: "POST", target: "/v1/auth/otp", body: { email } });
  }

  async verify(email: string, token: string): Promise<{ account_token: string; expires_at: number }> {
    return (await this.json(
      { method: "POST", target: "/v1/auth/verify", body: { email, token } },
      (j) => str(j.account_token) && int(j.expires_at),
    )) as { account_token: string; expires_at: number };
  }

  /** verify, then the session the registrations use (its `sub` read from the token, sessionFromToken). */
  async signIn(email: string, code: string): Promise<AccountSession & { expiresAt: number }> {
    const v = await this.verify(email, code);
    return { ...sessionFromToken(v.account_token), expiresAt: v.expires_at };
  }

  async account(
    session: AccountSession,
  ): Promise<{ has_vault: boolean; vault_created_at?: number; device_count?: number }> {
    return (await this.json(
      { method: "GET", target: "/v1/account", session },
      (j) => typeof j.has_vault === "boolean",
    )) as { has_vault: boolean };
  }

  async deleteAccount(s: DeviceSigner, session: AccountSession, passwordAuth: string): Promise<void> {
    await this.exchange({
      method: "DELETE",
      target: "/v1/account",
      signer: s,
      session,
      body: { password_auth: passwordAuth },
    });
  }

  // ---- the vault (§3.1, §4.2, §5.4) -------------------------------------------------------------------------------

  async init(
    session: AccountSession,
    reg: RegistrationSigner,
    body: InitBody,
  ): Promise<{ version: number; kver: number }> {
    return (await this.json(
      { method: "POST", target: "/v1/vault/init", session, signer: reg, body },
      (j) => j.version === 1 && j.kver === 1,
    )) as { version: number; kver: number };
  }

  async status(s: DeviceSigner): Promise<StatusResponse> {
    return (await this.json(
      { method: "GET", target: "/v1/sync/status", signer: s },
      (j) =>
        int(j.version) &&
        str(j.head) &&
        str(j.vk_id) &&
        int(j.kver) &&
        int(j.pending_enrollments) &&
        int(j.devices_rev) &&
        str(j.min_client_version) &&
        int(j.server_time),
    )) as StatusResponse;
  }

  async getVault(s: DeviceSigner): Promise<VaultResponse> {
    return (await this.json(
      { method: "GET", target: "/v1/vault", signer: s },
      (j) => int(j.version) && str(j.envelope),
    )) as VaultResponse;
  }

  async putVault(s: DeviceSigner, body: PutVaultBody): Promise<PutVaultResponse> {
    return (await this.json(
      { method: "PUT", target: "/v1/vault", signer: s, body },
      (j) => int(j.version) && typeof j.forked === "boolean",
    )) as PutVaultResponse;
  }

  async versions(s: DeviceSigner): Promise<VersionInfo[]> {
    const j = await this.json({ method: "GET", target: "/v1/vault/versions", signer: s }, (x) =>
      Array.isArray(x.versions),
    );
    const out = (j.versions as unknown[]).filter(
      (v): v is VersionInfo => isObj(v) && int(v.version) && str(v.vk_id) && int(v.size_bytes),
    );
    if (out.length !== (j.versions as unknown[]).length) throw malformed(200);
    return out;
  }

  async version(s: DeviceSigner, v: number): Promise<VaultResponse> {
    return (await this.json(
      { method: "GET", target: `/v1/vault/versions/${v}`, signer: s },
      (j) => int(j.version) && str(j.envelope),
    )) as VaultResponse;
  }

  async deleteVersions(s: DeviceSigner, passwordAuth: string): Promise<number> {
    return (
      await this.json(
        { method: "DELETE", target: "/v1/vault/versions", signer: s, body: { password_auth: passwordAuth } },
        (j) => int(j.deleted),
      )
    ).deleted as number;
  }

  // ---- keys (§3.6–§3.8, §4.2 repair) ------------------------------------------------------------------------------

  async getKeys(s: DeviceSigner): Promise<KeysResponse> {
    return (await this.json(
      { method: "GET", target: "/v1/keys", signer: s },
      (j) => int(j.kver) && str(j.bundle),
    )) as KeysResponse;
  }

  async putKeys(s: DeviceSigner, body: PutKeysBody): Promise<{ kver: number }> {
    return (await this.json({ method: "PUT", target: "/v1/keys", signer: s, body }, (j) => int(j.kver))) as {
      kver: number;
    };
  }

  async rotate(s: DeviceSigner, body: RotateBody): Promise<{ version: number; kver: number }> {
    return (await this.json(
      { method: "POST", target: "/v1/keys/rotate", signer: s, body },
      (j) => int(j.version) && int(j.kver),
    )) as { version: number; kver: number };
  }

  // ---- devices (§3.10, §4.10) -------------------------------------------------------------------------------------

  async devices(s: DeviceSigner): Promise<DevicesResponse> {
    return (await this.json(
      { method: "GET", target: "/v1/devices", signer: s },
      (j) => str(j.current) && Array.isArray(j.devices),
    )) as DevicesResponse;
  }

  async rename(s: DeviceSigner, id: string, body: { name_ct: NameCtWire; password_auth: string }): Promise<void> {
    await this.exchange({ method: "PATCH", target: `/v1/devices/${id}`, signer: s, body });
  }

  async revoke(s: DeviceSigner, id: string, passwordAuth: string): Promise<{ revoked_at: number }> {
    return (await this.json(
      { method: "POST", target: `/v1/devices/${id}/revoke`, signer: s, body: { password_auth: passwordAuth } },
      (j) => int(j.revoked_at),
    )) as { revoked_at: number };
  }

  async fork(
    s: DeviceSigner,
    newKey: CryptoKey,
    body: { new_device_id: string; new_sig_pubkey: string; name_ct: NameCtWire; password_auth: string },
  ): Promise<{ device_id: string }> {
    return (await this.json({ method: "POST", target: "/v1/devices/fork", signer: s, forkKey: newKey, body }, (j) =>
      str(j.device_id),
    )) as { device_id: string };
  }

  // ---- enrolment (§3.2, §3.3) -------------------------------------------------------------------------------------

  async enrollCreate(
    session: AccountSession,
    reg: RegistrationSigner,
    body: { device_id: string; sig_pubkey: string; commit: string },
  ): Promise<{ request_id: string; expires_at: number }> {
    return (await this.json(
      { method: "POST", target: "/v1/enroll/requests", session, signer: reg, body },
      (j) => str(j.request_id) && int(j.expires_at),
    )) as { request_id: string; expires_at: number };
  }

  async enrollList(s: DeviceSigner): Promise<EnrollListItem[]> {
    const j = await this.json({ method: "GET", target: "/v1/enroll/requests", signer: s }, (x) =>
      Array.isArray(x.requests),
    );
    return (j.requests as unknown[]).filter((r): r is EnrollListItem => isObj(r) && str(r.request_id) && str(r.state));
  }

  /** The view of one request: the new device's (EnrollSigner) or the approver's (DeviceSigner), as the server sent it. */
  async enrollGet(s: DeviceSigner | EnrollSigner, rid: string): Promise<Record<string, unknown>> {
    return this.json({ method: "GET", target: `/v1/enroll/requests/${rid}`, signer: s }, (j) => str(j.state));
  }

  async respond(s: DeviceSigner, rid: string, body: { epk: string; password_auth: string }): Promise<void> {
    await this.exchange({ method: "POST", target: `/v1/enroll/requests/${rid}/respond`, signer: s, body });
  }

  async reveal(s: EnrollSigner, rid: string, body: { epk: string; nonce: string; name_ct: string }): Promise<void> {
    await this.exchange({ method: "POST", target: `/v1/enroll/requests/${rid}/reveal`, signer: s, body });
  }

  async approve(
    s: DeviceSigner,
    rid: string,
    body: {
      transcript_hash: string;
      payload: string;
      name_ct: NameCtWire;
      sig_pubkey_sha256: string;
      password_auth: string;
    },
  ): Promise<void> {
    await this.exchange({ method: "POST", target: `/v1/enroll/requests/${rid}/approve`, signer: s, body });
  }

  async complete(s: EnrollSigner, rid: string, body: { name_ct?: NameCtWire } = {}): Promise<{ device_id: string }> {
    return (await this.json({ method: "POST", target: `/v1/enroll/requests/${rid}/complete`, signer: s, body }, (j) =>
      str(j.device_id),
    )) as { device_id: string };
  }

  async reject(s: DeviceSigner | EnrollSigner, rid: string, passwordAuth?: string): Promise<void> {
    await this.exchange({
      method: "POST",
      target: `/v1/enroll/requests/${rid}/reject`,
      signer: s,
      body: passwordAuth ? { password_auth: passwordAuth } : {},
    });
  }

  async rejectAll(s: DeviceSigner, passwordAuth: string): Promise<number> {
    return (
      await this.json(
        { method: "POST", target: "/v1/enroll/reject-all", signer: s, body: { password_auth: passwordAuth } },
        (j) => int(j.rejected),
      )
    ).rejected as number;
  }

  async enrollRecovery(
    session: AccountSession,
    reg: RegistrationSigner,
    body: { device_id: string; sig_pubkey: string; recovery_auth: string },
  ): Promise<RecoveryEnrollResponse> {
    return (await this.json(
      { method: "POST", target: "/v1/enroll/recovery", session, signer: reg, body },
      (j) => str(j.request_id) && str(j.vault_id) && int(j.version) && str(j.envelope) && int(j.kver) && str(j.bundle),
    )) as RecoveryEnrollResponse;
  }

  async healthz(): Promise<boolean> {
    const r = await this.exchange({ method: "GET", target: "/healthz" });
    return isObj(r.json) && r.json.ok === true;
  }
}

/** A Date header in ms, or null (§5.4: a 204 has no body, the clock is the Date header). */
function dateHeader(v: string | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Retry-After in seconds (delta-seconds only; an HTTP date is ignored). */
function retryAfterHeader(v: string | undefined): number | null {
  if (!v || !/^\d{1,9}$/.test(v.trim())) return null;
  return Number(v.trim());
}

/** Standard base64 of raw bytes, for body fields (§5.4 N18). */
export const b64 = (b: Uint8Array): string => toB64(b);
