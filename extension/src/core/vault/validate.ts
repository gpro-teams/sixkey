// Everything read back from disk, a backup file or the server passes through here before it is trusted.
import { normalizeBase32 } from "../totp/base32";
import { isHlc } from "./hlc";
import { isOrderKey } from "./fractional";
import { canonicalJson } from "./merge";
import type { Entry, Vault } from "./model";

export class VaultError extends Error {
  constructor(
    readonly code: "invalid_vault" | "newer_schema",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "VaultError";
  }
}

/**
 * `entries`: how many accounts that are not erased a vault may have for a NEW account to be added, or an account
 * imported (SYNC-DESIGN §3.13 C13, checked by ops.ts addEntry). `parsedEntries`: what a stored vault may hold to be
 * read at all, tombstones included. A merge (sync, a backup of the same vault) may take a vault past `entries`, so the
 * parser accepts ten times as many: a vault the merge made must stay readable. (A Phase 0 build cannot read a vault
 * above 5000 entries; nothing downgrades automatically.)
 */
export const LIMITS = {
  text: 256,
  secret: 512,
  group: 64,
  note: 64,
  domain: 253,
  domains: 16,
  entries: 5000,
  parsedEntries: 50_000,
} as const;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_ENTRIES = LIMITS.parsedEntries;

/** True when an account would be accepted back when the vault is read. Writers check this so nothing is saved that cannot be loaded. */
export function fitsLimits(p: { issuer: string; label: string; secret: string; group?: string }): boolean {
  return (
    p.issuer.length <= LIMITS.text &&
    p.label.length <= LIMITS.text &&
    p.secret.length <= LIMITS.secret &&
    (p.group?.length ?? 0) <= LIMITS.group
  );
}

function bad(msg: string): never {
  throw new VaultError("invalid_vault", msg);
}
const str = (v: unknown, max: number, what: string): string =>
  typeof v === "string" && v.length <= max ? v : bad(what);

function parseEntry(x: unknown): Entry {
  if (typeof x !== "object" || x === null) return bad("entry is not an object");
  const o = x as Record<string, unknown>;
  const id = str(o.id, 64, "entry id");
  if (!ID_RE.test(id)) bad("entry id");
  if (!Number.isSafeInteger(o.createdAt) || (o.createdAt as number) < 0) bad("createdAt");
  if (o.type !== "totp" && o.type !== "hotp") bad("type");
  if (o.algorithm !== "SHA1" && o.algorithm !== "SHA256" && o.algorithm !== "SHA512") bad("algorithm");
  if (o.digits !== 6 && o.digits !== 8) bad("digits");
  if (!Number.isInteger(o.period) || (o.period as number) < 1 || (o.period as number) > 86400) bad("period");
  if (!isHlc(o.hlc) || !isHlc(o.phlc)) bad("timestamps");
  if (!isOrderKey(o.order)) bad("order");

  const deleted =
    o.deleted === undefined ? undefined : o.deleted === true ? true : o.deleted === false ? false : bad("deleted");
  if (o.dhlc !== undefined && !isHlc(o.dhlc)) bad("dhlc");
  const secretRaw = str(o.secret, LIMITS.secret, "secret");
  let secret = "";
  if (secretRaw !== "") {
    try {
      secret = normalizeBase32(secretRaw);
    } catch {
      bad("secret");
    }
    if (secret !== secretRaw) bad("secret is not canonical");
  } // an empty secret marks a purged entry

  const e: Entry = {
    id,
    createdAt: o.createdAt as number,
    type: o.type,
    issuer: str(o.issuer, LIMITS.text, "issuer"),
    label: str(o.label, LIMITS.text, "label"),
    secret,
    algorithm: o.algorithm,
    digits: o.digits,
    period: o.period as number,
    hlc: o.hlc,
    order: o.order,
    phlc: o.phlc,
  };
  if (o.counter !== undefined) {
    if (!Number.isSafeInteger(o.counter) || (o.counter as number) < 0) bad("counter");
    e.counter = o.counter as number;
  }
  if (o.domains !== undefined) {
    if (!Array.isArray(o.domains) || o.domains.length > LIMITS.domains) bad("domains");
    e.domains = o.domains.map((d) => str(d, LIMITS.domain, "domain"));
  }
  if (o.group !== undefined) e.group = str(o.group, LIMITS.group, "group");
  if (o.note !== undefined) e.note = str(o.note, LIMITS.note, "note");
  if (o.autofill !== undefined) {
    if (!Array.isArray(o.autofill) || o.autofill.length > LIMITS.domains) bad("autofill");
    e.autofill = o.autofill.map((d) => str(d, LIMITS.domain, "autofill"));
  }
  if (deleted !== undefined) e.deleted = deleted;
  if (o.dhlc !== undefined) e.dhlc = o.dhlc as string;
  return e;
}

export function parseVault(x: unknown): Vault {
  if (typeof x !== "object" || x === null) return bad("vault is not an object");
  const o = x as Record<string, unknown>;
  // Data written by a newer version is never opened for writing: saving it back could destroy fields we do not know.
  if (typeof o.schemaVersion === "number" && o.schemaVersion > 1)
    throw new VaultError("newer_schema", `schema ${o.schemaVersion}`);
  if (o.schemaVersion !== 1) return bad("schemaVersion");
  if (typeof o.vaultId !== "string" || !ID_RE.test(o.vaultId)) return bad("vaultId");
  if (!Array.isArray(o.entries) || o.entries.length > MAX_ENTRIES) return bad("entries");
  const entries = o.entries.map(parseEntry);
  if (new Set(entries.map((e) => e.id)).size !== entries.length) return bad("duplicate entry ids");
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { schemaVersion: 1, vaultId: o.vaultId, entries };
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export function serializeVault(v: Vault): Uint8Array {
  return enc.encode(canonicalJson(v));
}

export function deserializeVault(bytes: Uint8Array): Vault {
  try {
    return parseVault(JSON.parse(dec.decode(bytes)));
  } catch (e) {
    if (e instanceof VaultError) throw e;
    return bad("not valid JSON");
  }
}
