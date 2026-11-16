// The API host permission in the Sync section (SYNC-DESIGN §3.1 step 1, §3.10, §4.9, §7; revisions 21 and 23). The
// permission is the extension's network switch: a profile that never turns sync on never holds it.
//   - Asking. Every click that starts something needing the network (turn sync on, join, try again, allow again, turn
//     sync off) asks first, as the handler's first statement, before any await: Chrome grants a request only within the
//     user's gesture, and the first await spends it. Asking for a permission that is already granted answers true
//     without a prompt. The handlers below are the only places that ask; each does it on its first line.
//   - Giving back. A flow that turns sync on (a first upload) or joins keeps the permission only when it ended "done" or
//     "unconfirmed" (a join: "enrolled" or "unconfirmed"; "unconfirmed" leaves the outcome to the next round). Every other
//     outcome gives it back at once while sync is not on: cancelled, refused, failed, and the results that are not
//     exceptions ("vault_exists", "keyring_changed"). A tab closed mid-flow is the worker's browser-start cleanup's.
//   - Turning sync off and removing the sync identity give it back last, once sync is off. A turn-off whose click granted
//     it again (it had been withdrawn) and that stopped for a review keeps it while the review is open (the answer's
//     revocation needs it), and gives it back on every other way the review closes (panel.ts closeReview).
//   - Never while a write is under way (a first upload, a join's Continue): cancel, the page closing and a lock wait for
//     the write, whose outcome may be that sync is on. What the page closing may give back at once, before any await,
//     is only a permission a flow holds for itself and that nothing it started can still need (enable.ts, join.ts
//     leaving). Sync on here therefore means the permission is held, or the user withdrew it.
import { askPermission, dropPermission, type SyncKit } from "./gateway";

/** The outcomes of an enable or join flow after which sync is on, or will be once the next round confirms it. */
export const KEPT_OUTCOMES: ReadonlySet<string> = new Set(["done", "unconfirmed", "enrolled"]);

/**
 * The permission given back unless sync is on now (§7): after a flow that did not turn it on, the profile holds no
 * permission again. With sync on (a configuration written, e.g. a join whose earlier attempt is still settling) the
 * permission is what the next round needs, and stays.
 */
export async function giveBack(kit: SyncKit): Promise<boolean> {
  if ((await kit.engine.view()).syncOn) return false;
  return dropPermission(kit);
}

/** A flow ended with `outcome`: kept for the outcomes that turn sync on, given back for every other one. */
export async function settlePermission(kit: SyncKit, outcome: string): Promise<boolean> {
  if (KEPT_OUTCOMES.has(outcome)) return false;
  return giveBack(kit);
}

/**
 * A click handler that needs the permission: `ask` is called synchronously, as the first thing the handler does, and the
 * flow continues with its answer. Callers pass the result of this straight to onClick, so nothing can come before it.
 */
export function asking(kit: SyncKit, then: (granted: Promise<boolean>) => void): () => void {
  return () => {
    const granted = askPermission(kit);
    then(granted);
  };
}
