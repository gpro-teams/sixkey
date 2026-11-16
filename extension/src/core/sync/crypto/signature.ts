// Device request signatures (§5.2): ECDSA P-256 / SHA-256 over
//   sixkey-req|1|{host}|{METHOD}|{target}|{signer}|{sub}|{ts}|{base64url(SHA-256(body))}
// carried as IEEE P1363 r||s, base64url, in Sixkey-Sig. Fork adds Sixkey-New-Sig: the new key's signature over the very
// same input (§4.10, N1). Building the request and sending it is the platform layer's job.
import { bs, sha256, utf8 } from "../../crypto/bytes";
import { DEVICE_ID_RE, UUID_RE, fromB64u, toB64u } from "./encoding";
import { SyncCryptoError } from "./errors";
import { importDpk } from "./device-key";
import { TAG } from "./labels";

const ECDSA_SHA256 = { name: "ECDSA", hash: "SHA-256" } as const;
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** Enrolled devices sign as their deviceId (Sixkey-Device); a device in enrollment as enroll:{rid} (Sixkey-Enroll). */
export type Signer = { deviceId: string } | { enrollRid: string };

/** host = URL.host of the configured API origin: lowercase, the port only when it is not the default (§5.2, N9). */
export function apiHost(origin: string): string {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    throw new SyncCryptoError("invalid_argument", "bad API origin");
  }
  if (
    (u.protocol !== "https:" && u.protocol !== "http:") ||
    u.username ||
    u.password ||
    (u.pathname !== "/" && u.pathname !== "") ||
    u.search ||
    u.hash
  ) {
    throw new SyncCryptoError("invalid_argument", "bad API origin");
  }
  return u.host;
}

/** base64url(SHA-256(body bytes)); a request without a body hashes zero bytes. */
export async function bodyHash(body?: Uint8Array | string | null): Promise<string> {
  const bytes = body == null ? new Uint8Array(0) : typeof body === "string" ? utf8(body) : body;
  return toB64u(await sha256(bytes));
}

export type SigningParams = {
  host: string;
  method: string;
  target: string; // raw request target: path and query exactly as sent
  signer: Signer;
  sub: string | null; // JWT sub when the request carries an account session
  ts: number; // ms, the same value as Sixkey-Ts
  bodySha256: string;
};

const FIELD = /^[\x21-\x7b\x7d\x7e]+$/; // printable ASCII without '|' and without spaces

function signerText(s: Signer): string {
  if ("deviceId" in s) {
    if (!DEVICE_ID_RE.test(s.deviceId)) throw new SyncCryptoError("invalid_signing_input", "bad deviceId");
    return s.deviceId;
  }
  if (!UUID_RE.test(s.enrollRid)) throw new SyncCryptoError("invalid_signing_input", "bad request id");
  return `enroll:${s.enrollRid}`;
}

/** The exact signing input. Every field comes from an alphabet without '|', and anything else is refused. */
export function signingInput(p: SigningParams): string {
  const bad = (m: string): never => {
    throw new SyncCryptoError("invalid_signing_input", m);
  };
  if (typeof p.host !== "string" || !FIELD.test(p.host) || p.host !== p.host.toLowerCase()) bad("bad host");
  if (typeof p.method !== "string" || !/^[A-Z]+$/.test(p.method)) bad("method must be uppercase");
  if (typeof p.target !== "string" || !p.target.startsWith("/") || !FIELD.test(p.target)) bad("bad target");
  const sub = p.sub ?? "-";
  if (typeof sub !== "string" || !FIELD.test(sub)) bad("bad sub");
  if (!Number.isSafeInteger(p.ts) || p.ts < 0) bad("bad ts");
  try {
    if (fromB64u(p.bodySha256).length !== 32) bad("bad body hash");
  } catch {
    bad("bad body hash");
  }
  return `${TAG.req}${p.host}|${p.method}|${p.target}|${signerText(p.signer)}|${sub}|${p.ts}|${p.bodySha256}`;
}

/** P1363 r||s from WebCrypto, base64url. */
export async function signInput(privateKey: CryptoKey, input: string): Promise<string> {
  return toB64u(new Uint8Array(await crypto.subtle.sign(ECDSA_SHA256, privateKey, bs(utf8(input)))));
}

/** 64 bytes and 0 < r, s < n (the server's checks before converting to DER). */
export function p1363InRange(sig: Uint8Array): boolean {
  if (sig.length !== 64) return false;
  let r = 0n;
  let s = 0n;
  for (let i = 0; i < 32; i++) {
    r = (r << 8n) | BigInt(sig[i]!);
    s = (s << 8n) | BigInt(sig[32 + i]!);
  }
  return r > 0n && r < P256_N && s > 0n && s < P256_N;
}

/** Verifies a Sixkey-Sig / Sixkey-New-Sig value against an SPKI public key. False for anything malformed. */
export async function verifyInput(spki: Uint8Array, sigB64u: string, input: string): Promise<boolean> {
  try {
    const sig = fromB64u(sigB64u);
    if (!p1363InRange(sig)) return false;
    return await crypto.subtle.verify(ECDSA_SHA256, await importDpk(spki), bs(sig), bs(utf8(input)));
  } catch {
    return false;
  }
}

export type RequestToSign = {
  host: string;
  method: string;
  target: string;
  signer: Signer;
  sub?: string | null;
  ts: number;
  body?: Uint8Array | string | null; // the exact bytes that will be sent
};

export type SignatureHeaders = Record<"Sixkey-Ts" | "Sixkey-Sig", string> &
  Partial<Record<"Sixkey-Device" | "Sixkey-Enroll" | "Sixkey-New-Sig", string>>;

async function inputOf(req: RequestToSign): Promise<string> {
  return signingInput({
    host: req.host,
    method: req.method,
    target: req.target,
    signer: req.signer,
    sub: req.sub ?? null,
    ts: req.ts,
    bodySha256: await bodyHash(req.body),
  });
}

function baseHeaders(req: RequestToSign, sig: string): SignatureHeaders {
  const who =
    "deviceId" in req.signer ? { "Sixkey-Device": req.signer.deviceId } : { "Sixkey-Enroll": req.signer.enrollRid };
  return { ...who, "Sixkey-Ts": String(req.ts), "Sixkey-Sig": sig };
}

/** The Sixkey-* header values for one request. Registration endpoints sign as { deviceId: body.device_id } (N8). */
export async function signRequest(privateKey: CryptoKey, req: RequestToSign): Promise<SignatureHeaders> {
  const input = await inputOf(req);
  return baseHeaders(req, await signInput(privateKey, input));
}

/** POST /v1/devices/fork: the current DSK signs as usual and the new key signs the identical input (Sixkey-New-Sig). */
export async function signForkRequest(
  currentKey: CryptoKey,
  newKey: CryptoKey,
  req: RequestToSign,
): Promise<SignatureHeaders> {
  if (!("deviceId" in req.signer))
    throw new SyncCryptoError("invalid_signing_input", "fork is signed by an enrolled device");
  const input = await inputOf(req);
  return { ...baseHeaders(req, await signInput(currentKey, input)), "Sixkey-New-Sig": await signInput(newKey, input) };
}
