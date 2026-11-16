// Is an account being added already in the vault (PHASE0X-PLAN B3, ux-study §2.9)? Pure functions, no UI.
//
// Keys are compared as the bytes they decode to, never as text: case, spaces, "=" padding and the unused low bits of
// the last base32 character (normalizeBase32 keeps those) can all differ between two copies of the same key.
// Names are compared after NFKC folding, trimmed and in lower case.
//
//   exists    the same key under the same issuer: nothing to add.
//   same_key  the same key under another name: probably the same QR code scanned twice; the user decides.
//   rebind    another key under the same issuer and account: probably the site issued a new key; the user chooses
//             "keep both" or "replace". Never decided here, and never automatic.
//   repeat    the same key as an earlier item of the same paste or scan: dropped, it adds nothing.
// Only live entries count: an account in the trash is neither a duplicate nor something to replace.
import { decodeBase32 } from "../totp/base32";
import type { Clock } from "../vault/hlc";
import { aliveEntries, isAlive, type Entry, type Vault } from "../vault/model";
import { addEntry, deleteEntry, moveEntry, type NewEntry } from "../vault/ops";
import { LIMITS } from "../vault/validate";

export type Candidate = { secret: string; issuer: string; label: string };
export type Verdict = { k: "new" } | { k: "repeat" } | { k: "exists" | "same_key" | "rebind"; entry: Entry };

/** The key's bytes as hex, or null when it is empty or not base32 (it then matches nothing). */
export function keyBytes(secret: string): string | null {
  try {
    const b = decodeBase32(secret);
    return b.length ? Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("") : null;
  } catch {
    return null;
  }
}

const fold = (s: string) => s.normalize("NFKC").trim().toLowerCase();

/** How `c` relates to the live entries in `existing`. */
export function verdictOf(c: Candidate, existing: readonly Entry[]): Verdict {
  const key = keyBytes(c.secret);
  const issuer = fold(c.issuer);
  const label = fold(c.label);
  const live = existing.filter(isAlive); // isAlive is false for purged entries too
  const same = key === null ? [] : live.filter((e) => keyBytes(e.secret) === key);
  const exact = same.find((e) => fold(e.issuer) === issuer);
  if (exact) return { k: "exists", entry: exact };
  if (same[0]) return { k: "same_key", entry: same[0] };
  // An account with no name at all is not "the same account": every bare key pasted would look like a re-bind.
  if (issuer || label) {
    const named = live.find((e) => fold(e.issuer) === issuer && fold(e.label) === label);
    if (named) return { k: "rebind", entry: named };
  }
  return { k: "new" };
}

/** Verdicts for a whole paste or scan, in order. An item whose key an earlier item already has is a "repeat". */
export function verdicts(items: readonly Candidate[], existing: readonly Entry[]): Verdict[] {
  const seen = new Set<string>();
  return items.map((c) => {
    const key = keyBytes(c.secret);
    if (key !== null && seen.has(key)) return { k: "repeat" };
    if (key !== null) seen.add(key);
    return verdictOf(c, existing);
  });
}

/**
 * Add `input` with the id `id`; with `replace`, also move that entry to the trash, in the same edit. The new entry
 * takes the old one's group, sites and place in the list (it stands for the same account). The old entry is only
 * deleted, never purged: it stays in the trash with its key and can be restored.
 */
export function addOrReplace(v: Vault, input: NewEntry, clock: Clock, opts: { id: string; replace?: string }): Vault {
  const old = opts.replace ? aliveEntries(v).find((e) => e.id === opts.replace) : undefined;
  if (opts.replace && !old) throw new Error("no such entry"); // gone or already in the trash: nothing is changed
  const domains = [...new Set([...(old?.domains ?? []), ...(input.domains ?? [])])].slice(0, LIMITS.domains);
  const carried: NewEntry = old ? { ...input, group: old.group, domains: domains.length ? domains : undefined } : input;
  let next = addEntry(v, carried, clock, { id: opts.id }).vault;
  if (!old) return next;
  const at = aliveEntries(next)
    .filter((e) => e.id !== opts.id)
    .findIndex((e) => e.id === old.id);
  next = deleteEntry(next, old.id, clock);
  return moveEntry(next, opts.id, at, clock); // where the old one was, among the others
}
