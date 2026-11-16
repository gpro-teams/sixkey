// otpauth:// parsing and serialisation (Google Key URI Format).
// Parsing never throws: every failure is a typed error so callers can report per line.
import { cleanBase32, decodeBase32, normalizeBase32 } from "./base32";
import type { Algorithm, Digits } from "./hotp";

export type OtpType = "totp" | "hotp";

export type OtpParams = {
  type: OtpType;
  issuer: string;
  label: string;
  secret: string; // canonical base32
  algorithm: Algorithm;
  digits: Digits;
  period: number; // totp only meaningful, kept for hotp as default 30
  counter?: number; // hotp only
};

export type OtpauthError =
  | "not_otpauth"
  | "migration_uri" // otpauth-migration://, handled by the migration module
  | "malformed"
  | "unsupported_type"
  | "missing_secret"
  | "invalid_secret"
  | "unsupported_algorithm"
  | "unsupported_digits"
  | "invalid_period"
  | "missing_counter";

export type OtpauthWarning = "short_secret" | "issuer_mismatch";

export type ParseResult =
  { ok: true; value: OtpParams; warnings: OtpauthWarning[] } | { ok: false; error: OtpauthError };

const ALGORITHMS: Record<string, Algorithm> = { SHA1: "SHA1", SHA256: "SHA256", SHA512: "SHA512" };
const MIN_SECRET_BYTES = 10; // 80 bits; shorter secrets are accepted with a warning

export function parseOtpauth(input: string): ParseResult {
  const raw = input.trim();
  if (/^otpauth-migration:\/\//i.test(raw)) return fail("migration_uri");
  const m = /^otpauth:\/\/([^/?#]*)\/?([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i.exec(raw);
  if (!m) return fail(/^otpauth:/i.test(raw) ? "malformed" : "not_otpauth");

  const type = m[1]!.toLowerCase();
  if (type !== "totp" && type !== "hotp") return fail("unsupported_type");

  let labelDecoded: string;
  try {
    labelDecoded = decodeURIComponent(m[2] ?? "");
  } catch {
    return fail("malformed");
  }
  const query = new URLSearchParams(m[3] ?? ""); // '+' means space in the query part, as encoders emit it
  const get = (k: string): string | null => query.get(k);

  // secret
  const secretRaw = get("secret");
  // nothing left once read as base32 reads it (cleanBase32: NFKC first, so a full-width "＝＝" is as missing as "==")
  if (secretRaw === null || cleanBase32(secretRaw) === "") return fail("missing_secret");
  let secret: string;
  let secretBytes: Uint8Array;
  try {
    secret = normalizeBase32(secretRaw);
    secretBytes = decodeBase32(secret);
  } catch {
    return fail("invalid_secret");
  }
  if (secretBytes.length === 0) return fail("invalid_secret");

  // algorithm
  const algRaw = get("algorithm");
  let algorithm: Algorithm = "SHA1";
  if (algRaw !== null && algRaw !== "") {
    const a = ALGORITHMS[algRaw.toUpperCase().replace(/-/g, "")];
    if (!a) return fail("unsupported_algorithm");
    algorithm = a;
  }

  // digits
  const digRaw = get("digits");
  let digits: Digits = 6;
  if (digRaw !== null && digRaw !== "") {
    if (digRaw !== "6" && digRaw !== "8") return fail("unsupported_digits");
    digits = Number(digRaw) as Digits;
  }

  // period
  const perRaw = get("period");
  let period = 30;
  if (perRaw !== null && perRaw !== "") {
    if (!/^\d+$/.test(perRaw)) return fail("invalid_period");
    period = Number(perRaw);
    if (period < 1 || period > 86400) return fail("invalid_period");
  }

  // counter (hotp)
  let counter: number | undefined;
  if (type === "hotp") {
    const cRaw = get("counter");
    if (cRaw === null || !/^\d+$/.test(cRaw) || !Number.isSafeInteger(Number(cRaw))) return fail("missing_counter");
    counter = Number(cRaw);
  }

  // issuer / label
  const warnings: OtpauthWarning[] = [];
  const issuerParam = (get("issuer") ?? "").trim();
  let prefix = "";
  let account = labelDecoded.trim();
  const colon = labelDecoded.indexOf(":");
  if (issuerParam && issuerPrefixed(labelDecoded, issuerParam)) {
    // The prefix is exactly the issuer, even when the issuer itself contains ':'.
    prefix = issuerParam;
    account = labelDecoded.slice(issuerParam.length + 1).trim();
  } else if (colon >= 0) {
    prefix = labelDecoded.slice(0, colon).trim();
    account = labelDecoded.slice(colon + 1).trim();
  }
  let issuer: string;
  let label: string;
  if (issuerParam && prefix && issuerParam.toLowerCase() !== prefix.toLowerCase()) {
    // Conflict: the parameter wins as issuer; keep the whole label so nothing is lost.
    issuer = issuerParam;
    label = labelDecoded.trim();
    warnings.push("issuer_mismatch");
  } else {
    issuer = issuerParam || prefix;
    label = account;
  }
  if (secretBytes.length < MIN_SECRET_BYTES) warnings.push("short_secret");

  const value: OtpParams = { type, issuer, label, secret, algorithm, digits, period };
  if (counter !== undefined) value.counter = counter;
  return { ok: true, value, warnings };
}

function fail(error: OtpauthError): ParseResult {
  return { ok: false, error };
}

/**
 * Whether `label` starts with `issuer` and a ':', the issuer's case aside. Compared and cut on the same string: the
 * label's first issuer.length code units, which must be followed by its ':' and equal the issuer once both are lower
 * case. Lower-casing the whole label instead and cutting the label at the issuer's length goes wrong where lower case
 * has another length ("İ", U+0130, is one code unit; its lower case, "i" and U+0307, two): the cut could fall elsewhere,
 * in the middle of a surrogate pair too, leaving a lone surrogate in the label, which encodeURIComponent then throws on
 * (an export). Here the cut is always just before a ':', which is never half of a pair. An issuer and a prefix that are
 * equal only in lower cases of different lengths are not taken as the same here; the label's own colon then splits it,
 * as for any label, and the two are compared as names below.
 */
export function issuerPrefixed(label: string, issuer: string): boolean {
  const n = issuer.length;
  return label.charAt(n) === ":" && label.slice(0, n).toLowerCase() === issuer.toLowerCase();
}

export type ListItem = { raw: string; result: ParseResult };

/** Split pasted text into URIs (newlines, spaces or run-together) and parse each one. */
export function parseOtpauthList(text: string): ListItem[] {
  const out: ListItem[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed
      .split(/(?=otpauth(?:-migration)?:\/\/)/i)
      .map((p) => p.trim())
      .filter(Boolean);
    for (const raw of parts) out.push({ raw, result: parseOtpauth(raw) });
  }
  return out;
}

export function serializeOtpauth(p: OtpParams): string {
  const enc = encodeURIComponent;
  const account = enc(p.label);
  // Without an issuer, a ':' inside the label would be read back as a prefix, so lead with an empty one.
  const path = p.issuer ? `${enc(p.issuer)}:${account}` : p.label.includes(":") ? `:${account}` : account;
  const q = [`secret=${normalizeBase32(p.secret)}`];
  if (p.issuer) q.push(`issuer=${enc(p.issuer)}`);
  q.push(`algorithm=${p.algorithm}`, `digits=${p.digits}`);
  if (p.type === "totp") q.push(`period=${p.period}`);
  else q.push(`counter=${p.counter ?? 0}`);
  return `otpauth://${p.type}/${path}?${q.join("&")}`;
}
