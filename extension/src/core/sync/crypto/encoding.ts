// Encodings shared by the sync wire formats: strict base64url (§2.2), hour truncation (§2.3 T1), and JSON whose numbers
// are safe integers only, so this client, the server and Python serialize the same values the same way (§2.3, N20).
import { toB64 } from "../../crypto/bytes";
import { canonicalJson } from "../../vault/merge";
import { b64 } from "./basic-encoding";
import { SYNC_CONSTANTS as C } from "./constants";
import { SyncCryptoError } from "./errors";

export { ID_RE, b64 } from "./basic-encoding";
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{22}$/; // 16 random bytes, base64url (§2.5)
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/; // request id, as in T

export function toB64u(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict base64url (§2.2, N19): URL alphabet, no padding, length % 4 != 1, and only the canonical trailing bits. */
export function fromB64u(s: string): Uint8Array {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1)
    throw new SyncCryptoError("bad_encoding", "bad base64url");
  const out = b64(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  if (toB64u(out) !== s) throw new SyncCryptoError("bad_encoding", "non-canonical base64url");
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

// ---- time --------------------------------------------------------------------------------------------------------

/** floor(ms / unit) * unit for a non-negative ms timestamp; with TRUNC_HOUR_MS this is the UTC hour (§2.3, N4). */
export function floorToUnit(ms: number, unit: number): number {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new SyncCryptoError("invalid_argument", "bad timestamp");
  return ms - (ms % unit);
}

export const floorToHour = (ms: number): number => floorToUnit(ms, C.TRUNC_HOUR_MS);

export const isHourAligned = (ms: unknown): boolean =>
  Number.isSafeInteger(ms) && (ms as number) >= 0 && (ms as number) % C.TRUNC_HOUR_MS === 0;

// ---- integer-only JSON -------------------------------------------------------------------------------------------

const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * True when every number token in the JSON text is an integer literal with |n| <= 2^53 - 1 (§2.3, §5.4, N20).
 * It reads the raw text: JSON.parse turns 3.0, 6e5 or 1.7920512e12 into integers, so a check on parsed values misses them.
 */
export function integerTokensOnly(text: string): boolean {
  for (let i = 0; i < text.length;) {
    const c = text.charCodeAt(i);
    if (c === 0x22) {
      for (i++; i < text.length && text.charCodeAt(i) !== 0x22;) i += text.charCodeAt(i) === 0x5c ? 2 : 1;
      i++;
    } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (!m || m[1] !== undefined || m[2] !== undefined) return false;
      const v = BigInt(m[0]);
      if (v > MAX_SAFE || v < -MAX_SAFE) return false;
      i += m[0].length;
    } else i++;
  }
  return true;
}

/** JSON.parse after the integer-token check. The result is generic JSON: unknown members survive (§2.3 forward compatibility). */
export function parseIntegerJson(text: string): unknown {
  if (typeof text !== "string") throw new SyncCryptoError("bad_json");
  if (!integerTokensOnly(text)) throw new SyncCryptoError("non_integer_number");
  try {
    return JSON.parse(text);
  } catch {
    throw new SyncCryptoError("bad_json");
  }
}

function assertJsonValue(v: unknown, depth: number): void {
  if (depth > 32) throw new SyncCryptoError("invalid_argument", "too deep");
  if (v === null || typeof v === "string" || typeof v === "boolean") return;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new SyncCryptoError("non_integer_number");
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) assertJsonValue(x, depth + 1);
    return;
  }
  if (isPlainObject(v)) {
    for (const x of Object.values(v)) if (x !== undefined) assertJsonValue(x, depth + 1);
    return;
  }
  throw new SyncCryptoError("invalid_argument", "not a JSON value");
}

/** Phase 0 canonicalJson, limited to the values it serializes exactly like Python: strings, booleans, null, safe integers, arrays and plain objects. */
export function canonicalJsonStrict(v: unknown): string {
  assertJsonValue(v, 0);
  return canonicalJson(v);
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}
