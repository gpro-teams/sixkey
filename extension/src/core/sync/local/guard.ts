// The destructive-change guard on a merge (SYNC-DESIGN §4.4, F16, D6): what applying a remote vault would do to this
// device's vault, judged before anything is committed. Pure; the engine (M3) runs it before applyRemote, and
// applyRemote runs it again inside its transact on what it actually merges.
//   Blocking (status review_needed, nothing committed, nothing of the remote kept):
//     - secretChanged: one entry id whose secret is set on both sides and differs (I8: no honest edit does that);
//     - purgedAlive: an entry alive on this device that the merge erases for good (it skipped this device's trash).
//   Not blocking, for the banner: entries the merge moves to the trash, and entries already in this device's trash that
//   it erases for good (3 or more of either shows "another device deleted N accounts").
// Identity goes through the vault model's named helpers (entryIdentity, isPurged, isAlive; §0.0i req. 15 R3).
import { entryIdentity, isAlive, isPurged, type Vault } from "../../vault/model";

export type GuardReport = {
  secretChanged: string[];
  purgedAlive: string[];
  trashed: string[];
  purgedFromTrash: string[];
};

/** The banner's threshold (§4.4). */
export const NOTICE_AT = 3;

export function guardMerge(local: Vault, remote: Vault, merged: Vault): GuardReport {
  const mine = new Map(local.entries.map((e) => [e.id, e]));
  const theirs = new Map(remote.entries.map((e) => [e.id, e]));
  const r: GuardReport = { secretChanged: [], purgedAlive: [], trashed: [], purgedFromTrash: [] };
  for (const [id, a] of mine) {
    const b = theirs.get(id);
    const x = entryIdentity(a);
    const y = b ? entryIdentity(b) : null;
    if (x !== null && y !== null && x !== y) r.secretChanged.push(id);
  }
  for (const m of merged.entries) {
    const a = mine.get(m.id);
    if (!a) continue;
    if (isAlive(a) && isPurged(m)) r.purgedAlive.push(m.id);
    else if (isAlive(a) && !isAlive(m)) r.trashed.push(m.id);
    else if (!isAlive(a) && !isPurged(a) && isPurged(m)) r.purgedFromTrash.push(m.id);
  }
  return r;
}

export const blocks = (g: GuardReport): boolean => g.secretChanged.length > 0 || g.purgedAlive.length > 0;
export const notices = (g: GuardReport): boolean =>
  g.trashed.length >= NOTICE_AT || g.purgedFromTrash.length >= NOTICE_AT;
