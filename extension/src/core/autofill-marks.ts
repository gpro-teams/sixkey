// The autofill list across computers (the owner's request of 2026-11-18): each account carries the sites with code
// suggestions turned on for it on some computer (Entry.autofill, in the vault, so the backup in Chrome sync carries it,
// encrypted). A computer's own list and Chrome's grant stay its own (platform/autofill-sites.ts): a site marked here that
// is not on this computer's list is only offered (Settings › Autofill), and turned on by a click there. Pure.
import { matchTier } from "./match";
import { aliveEntries, type Entry, type Vault } from "./vault/model";
import { editEntry } from "./vault/ops";
import type { Clock } from "./vault/hlc";
import { LIMITS } from "./vault/validate";

/** The sites marked on any live account, in the order first met. */
export function markedSites(entries: readonly Entry[]): string[] {
  return [...new Set(entries.flatMap((e) => e.autofill ?? []))];
}

/** The live accounts a site belongs to: those registered for it (core/match.ts), the ones its Fill card shows. */
export const accountsOf = (entries: readonly Entry[], host: string): Entry[] =>
  entries.filter((e) => matchTier(e, host) === "registered");

/** `host` marked on the live accounts `ids` that lack it (as many as an account may carry). `v` itself if none. */
export function markSite(v: Vault, ids: readonly string[], host: string, clock: Clock): Vault {
  let next = v;
  for (const e of aliveEntries(v)) {
    const cur = e.autofill ?? [];
    if (!ids.includes(e.id) || cur.includes(host) || cur.length >= LIMITS.domains) continue;
    next = editEntry(next, e.id, { autofill: [...cur, host] }, clock);
  }
  return next;
}

/** `host` taken off every live account (Settings' Remove). `v` itself if none had it. */
export function unmarkSite(v: Vault, host: string, clock: Clock): Vault {
  let next = v;
  for (const e of aliveEntries(v)) {
    if (!e.autofill?.includes(host)) continue;
    const rest = e.autofill.filter((h) => h !== host);
    next = editEntry(next, e.id, { autofill: rest.length ? rest : undefined }, clock);
  }
  return next;
}
