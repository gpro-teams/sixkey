// The review of a merge the deletion guard stopped (SYNC-DESIGN §4.4, F16; §6 O12 "需要确认"): the accounts that are alive
// on this device and that the other side would erase for good, or whose secret it would change (no honest edit does
// that, I8). Used wherever a merge can be stopped: a round, the fold of kept saves, a join, turning sync off, adopting
// keys (one review screen for all of them, §4.4). Nothing of the other side is kept meanwhile; the answer binds to the
// very versions shown (`seen`) and is held in memory only.
import type { GuardReport, MergeAnswer } from "./gateway";
import type { Vault } from "../../core/vault/model";

export type Blocked = { report: GuardReport; seen: Readonly<Record<string, string>> };
export type ReviewRow = { id: string; name: string; account: string; why: "erased" | "secret" };

/** One row per account the guard stopped on, named from this device's vault (the ids are this device's own). */
export function reviewRows(b: Blocked, vault: Vault | null): ReviewRow[] {
  const byId = new Map((vault?.entries ?? []).map((e) => [e.id, e]));
  const row = (id: string, why: ReviewRow["why"]): ReviewRow => {
    const e = byId.get(id);
    return { id, name: e ? e.issuer || e.label : "", account: e && e.issuer ? e.label : "", why };
  };
  const seen = new Set<string>();
  const out: ReviewRow[] = [];
  for (const id of b.report.purgedAlive)
    if (!seen.has(id)) {
      seen.add(id);
      out.push(row(id, "erased"));
    }
  for (const id of b.report.secretChanged)
    if (!seen.has(id)) {
      seen.add(id);
      out.push(row(id, "secret"));
    }
  return out;
}

/**
 * The user's answer for every account shown: Apply (take the other device's change) or Keep mine (this device's
 * version, re-stamped so that it wins everywhere). Bound to `seen`: a remote that changed one of them meanwhile stops
 * the merge again.
 */
export function answerOf(b: Blocked, choice: "apply" | "keep"): MergeAnswer {
  const ids = [...new Set([...b.report.purgedAlive, ...b.report.secretChanged])];
  return choice === "apply" ? { seen: b.seen, accept: ids } : { seen: b.seen, keepMine: ids };
}
