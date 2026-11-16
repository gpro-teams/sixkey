// Google Authenticator "export accounts" format: otpauth-migration://offline?data=<base64 protobuf>.
// Hand-written protobuf reader (varint + length-delimited), no dependency. Never throws on bad input.
// Schema: https://github.com/dim13/otpauth/blob/master/migration/migration.proto
import { encodeBase32 } from "./base32";
import type { Algorithm, Digits } from "./hotp";
import type { OtpParams } from "./otpauth";

export type MigrationEntryError =
  | "empty_secret"
  | "unsupported_algorithm"
  | "unsupported_digits"
  | "unsupported_type"
  | "invalid_counter"
  | "invalid_text";

export type MigrationEntry =
  { ok: true; value: OtpParams } | { ok: false; error: MigrationEntryError; issuer: string; label: string };

export type MigrationBatch = {
  version: number;
  batchSize: number; // number of QR codes in the export
  batchIndex: number; // zero based
  batchId: number;
  entries: MigrationEntry[];
};

export type MigrationError = "not_migration" | "malformed" | "too_large";
export type MigrationResult = { ok: true; batch: MigrationBatch } | { ok: false; error: MigrationError };

const MAX_URI_LENGTH = 256 * 1024;
const MAX_ENTRIES = 2000;
/**
 * Codes one export may say it has. A real export is far smaller (a few accounts per code, at most the vault's 5000
 * accounts); an absurd batch_size (2^31) would make every "which codes are missing" loop run that long.
 */
export const MAX_BATCH_SIZE = 1000;

class Reader {
  private p = 0;
  constructor(private readonly buf: Uint8Array) {}
  get done(): boolean {
    return this.p >= this.buf.length;
  }
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.p >= this.buf.length) throw new Error("truncated");
      const b = this.buf[this.p++]!;
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
      if (shift > 63n) throw new Error("varint too long");
    }
  }
  bytes(): Uint8Array {
    const len = Number(this.varint());
    if (!Number.isSafeInteger(len) || len < 0 || this.p + len > this.buf.length) throw new Error("truncated");
    const out = this.buf.subarray(this.p, this.p + len);
    this.p += len;
    return out;
  }
  skip(n: number): void {
    if (this.p + n > this.buf.length) throw new Error("truncated");
    this.p += n;
  }
}

type Field = { no: number; wire: 0; value: bigint } | { no: number; wire: 2; value: Uint8Array };

/** Yields varint and length-delimited fields; fixed32/fixed64 are skipped; groups are an error. */
function* fields(buf: Uint8Array): Generator<Field> {
  const r = new Reader(buf);
  while (!r.done) {
    const key = r.varint();
    const no = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) yield { no, wire: 0, value: r.varint() };
    else if (wire === 2) yield { no, wire: 2, value: r.bytes() };
    else if (wire === 1) r.skip(8);
    else if (wire === 5) r.skip(4);
    else throw new Error("unsupported wire type");
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function parseEntry(buf: Uint8Array): MigrationEntry {
  let secret: Uint8Array = new Uint8Array(0);
  let name = "";
  let issuer = "";
  let alg = 0;
  let dig = 0;
  let type = 0;
  let counter = 0n;
  let textOk = true;
  for (const f of fields(buf)) {
    if (f.wire === 2) {
      if (f.no === 1) secret = f.value;
      else if (f.no === 2 || f.no === 3) {
        try {
          const s = utf8.decode(f.value);
          if (f.no === 2) name = s;
          else issuer = s;
        } catch {
          textOk = false;
        }
      }
    } else if (f.no === 4) alg = Number(f.value);
    else if (f.no === 5) dig = Number(f.value);
    else if (f.no === 6) type = Number(f.value);
    else if (f.no === 7) counter = f.value;
  }

  // "Issuer:account" is the usual name form; strip the prefix when it repeats the issuer.
  let label = name.trim();
  const colon = label.indexOf(":");
  if (colon >= 0) {
    const prefix = label.slice(0, colon).trim();
    if (!issuer) issuer = prefix;
    if (prefix.toLowerCase() === issuer.trim().toLowerCase()) label = label.slice(colon + 1).trim();
  }
  issuer = issuer.trim();

  const bad = (error: MigrationEntryError): MigrationEntry => ({ ok: false, error, issuer, label });
  if (!textOk) return bad("invalid_text");
  if (secret.length === 0) return bad("empty_secret");
  // proto3 omits zero values: 0 means "unspecified" and falls back to the usual default.
  const algorithm: Algorithm | undefined =
    alg === 0 || alg === 1 ? "SHA1" : alg === 2 ? "SHA256" : alg === 3 ? "SHA512" : undefined;
  if (!algorithm) return bad("unsupported_algorithm"); // includes 4 = MD5
  const digits: Digits | undefined = dig === 0 || dig === 1 ? 6 : dig === 2 ? 8 : undefined;
  if (!digits) return bad("unsupported_digits");
  if (type !== 0 && type !== 1 && type !== 2) return bad("unsupported_type");
  const isHotp = type === 1;
  const value: OtpParams = {
    type: isHotp ? "hotp" : "totp",
    issuer,
    label,
    secret: encodeBase32(secret),
    algorithm,
    digits,
    period: 30,
  };
  if (isHotp) {
    if (counter > BigInt(Number.MAX_SAFE_INTEGER)) return bad("invalid_counter");
    value.counter = Number(counter);
  }
  return { ok: true, value };
}

function decodeData(uri: string): Uint8Array | null {
  const m = /[?&]data=([^&#]*)/i.exec(uri);
  if (!m) return null;
  let raw: string;
  try {
    raw = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  // Standard base64 expected. A raw '+' arrives as a space after form decoding, and some tools emit url-safe base64.
  const b64 = raw.replace(/\s/g, "+").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(b64) || b64.length % 4 === 1) return null;
  try {
    const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
    return bin.length === 0 ? null : Uint8Array.from(bin, (c) => c.charCodeAt(0)); // an empty payload is not an export
  } catch {
    return null;
  }
}

export function parseMigrationUri(input: string): MigrationResult {
  const uri = input.trim();
  if (!/^otpauth-migration:\/\/offline\?/i.test(uri)) return { ok: false, error: "not_migration" };
  if (uri.length > MAX_URI_LENGTH) return { ok: false, error: "too_large" };
  const data = decodeData(uri);
  if (!data) return { ok: false, error: "malformed" };

  const batch: MigrationBatch = { version: 0, batchSize: 0, batchIndex: 0, batchId: 0, entries: [] };
  try {
    for (const f of fields(data)) {
      if (f.no === 1 && f.wire === 2) {
        if (batch.entries.length >= MAX_ENTRIES) return { ok: false, error: "too_large" };
        batch.entries.push(parseEntry(f.value));
      } else if (f.wire === 0) {
        if (f.no === 2) batch.version = Number(BigInt.asIntN(32, f.value));
        else if (f.no === 3) batch.batchSize = Number(BigInt.asIntN(32, f.value));
        else if (f.no === 4) batch.batchIndex = Number(BigInt.asIntN(32, f.value));
        else if (f.no === 5) batch.batchId = Number(BigInt.asIntN(32, f.value)); // may be negative
      }
    }
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (batch.batchSize < 0 || batch.batchSize > MAX_BATCH_SIZE) return { ok: false, error: "malformed" };
  return { ok: true, batch };
}

export type BatchProgress = {
  batchId: number;
  batchSize: number;
  received: number[]; // indices seen, sorted
  missing: number[]; // indices still needed
  complete: boolean;
  entries: MigrationEntry[]; // from all received codes, in index order
};

/** Group scanned codes by batch id so the UI can say "2 of 3 scanned". Duplicate scans of one index are ignored. */
export function collectBatches(batches: MigrationBatch[]): BatchProgress[] {
  const byId = new Map<number, Map<number, MigrationBatch>>();
  for (const b of batches) {
    const m = byId.get(b.batchId) ?? new Map<number, MigrationBatch>();
    if (!m.has(b.batchIndex)) m.set(b.batchIndex, b);
    byId.set(b.batchId, m);
  }
  const out: BatchProgress[] = [];
  for (const [batchId, m] of byId) {
    const sorted = [...m.values()].sort((a, c) => a.batchIndex - c.batchIndex);
    const batchSize = Math.max(1, ...sorted.map((b) => b.batchSize));
    const received = sorted.map((b) => b.batchIndex);
    const missing: number[] = [];
    for (let i = 0; i < batchSize; i++) if (!m.has(i)) missing.push(i);
    out.push({
      batchId,
      batchSize,
      received,
      missing,
      complete: missing.length === 0,
      entries: sorted.flatMap((b) => b.entries),
    });
  }
  return out;
}

/** Same secret + issuer + label is the same account; keeps the first occurrence. */
export function dedupeParams(items: OtpParams[]): OtpParams[] {
  const seen = new Set<string>();
  return items.filter((p) => {
    const key = `${p.secret}\u0000${p.issuer.toLowerCase()}\u0000${p.label.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
