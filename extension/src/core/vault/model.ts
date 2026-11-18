// Vault data model (PLAN §3). An entry is three independent last-writer-wins registers, so a rename on one
// device and a reorder or delete on another all survive a merge:
//   content   (hlc)  issuer, label, secret, algorithm, digits, period, type, counter, domains, note, autofill
//   placement (phlc) group, order
//   deletion  (dhlc) deleted
import type { Algorithm, Digits } from "../totp/hotp";
import type { OtpParams, OtpType } from "../totp/otpauth";
import type { Hlc } from "./hlc";

export type Entry = {
  id: string;
  createdAt: number;

  type: OtpType;
  issuer: string;
  label: string;
  secret: string; // canonical base32; empty once purged
  algorithm: Algorithm;
  digits: Digits;
  period: number;
  counter?: number; // hotp; merged with max, never goes backwards
  domains?: string[];
  /** The person's own words to tell an account from another of the same name (the owner's report of 2026-11-18). */
  note?: string;
  /**
   * The sites with code suggestions turned on for this account on some computer (the owner's request of 2026-11-18: the
   * autofill list across computers). Each computer's own list and Chrome's grant stay its own (platform/autofill-sites.ts):
   * these are only offered there (Settings › Autofill), and turned on by a click.
   */
  autofill?: string[];
  hlc: Hlc;

  group?: string;
  order: string;
  phlc: Hlc;

  deleted?: boolean;
  dhlc?: Hlc;
};

export type Vault = {
  schemaVersion: 1;
  vaultId: string;
  entries: Entry[]; // kept sorted by id so the serialised form is canonical
};

export type EntryInput = Omit<OtpParams, "period"> & { period?: number; group?: string; domains?: string[] };

/** Alive unless a deletion is newer than the last edit. An edit made after the delete brings the entry back. */
export function isAlive(e: Entry): boolean {
  if (e.secret === "") return false; // purged: only a marker is left, and nothing can bring it back
  return !e.deleted || e.hlc > (e.dhlc ?? "");
}

export function isPurged(e: Entry): boolean {
  return e.secret === "";
}

/**
 * What makes two entries the same account across vaults, where ids differ (the added mode gives new ids): the secret
 * key, for an entry that still has one; null for an erased entry, which is the same as nothing. Every place that judges
 * identity by the secret goes through here and isPurged (SYNC-DESIGN §0.0i req. 15 R3: a YubiKey entry will have no
 * secret, and this is where it gets its own identity), never through `e.secret` directly.
 */
export function entryIdentity(e: Entry): string | null {
  return isPurged(e) ? null : `secret:${e.secret}`;
}

function byOrder(a: Entry, b: Entry): number {
  return a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function aliveEntries(v: Vault): Entry[] {
  return v.entries.filter(isAlive).sort(byOrder);
}

/** Deleted but not purged: the recycle bin. */
export function trashEntries(v: Vault): Entry[] {
  return v.entries.filter((e) => !isAlive(e) && !isPurged(e)).sort(byOrder);
}

export function emptyVault(vaultId: string): Vault {
  return { schemaVersion: 1, vaultId, entries: [] };
}
