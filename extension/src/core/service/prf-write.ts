// sk_prf's writes outside a key change (QUICK-UNLOCK §5.3, §5.6, Stage 2): the enrolment, the removal, "turn back on" and
// the session method (device-admin.ts), and the master password's time (notePasswordTyped). Lazy chunks only: the popup's
// main chunk carries only the record's shape and the key change's step (prf-store.ts), and this module imports nothing of
// it (docs/design/notes/SHAMIR-NOTES.md §7, PRF-NOTES.md §9).
//
// Each write is one critical section under the vault lock (webLock("sixkey-vault"), the store's own, which the PrfStore
// holds), and nothing inside it calls the store or the service: `fn` is synchronous and gets the record with its usable
// credentials only (prf-check.ts usableRecord; "damaged" when the record itself is not one), and, when asked for, the
// vault's active keyring's ids, read straight from the slots by the caller's reader (as pin-store.ts reads them). A record
// that had something unusable left out is stored healed by the first write, even one that `fn` leaves alone.
import { usableRecord } from "../crypto/prf-check";
import type { PrfRecord } from "../crypto/prf-record";
import type { KV, Lock } from "../storage/kv";
import type { PrfStore } from "./prf-store";

/** The key, as prf-store.ts PRF_KEY (core/sync/local/keys.ts LOCAL_ONLY_KEYS.prf): restated, not imported (see above). */
const KEY = "sk_prf";
/** The master password's time is written at most this often (YR-14: a write of chrome.storage.local at most once a day). */
export const PRF_NOTE_MS = 86_400_000;

export type PrfStep = (
  rec: PrfRecord | "damaged" | null,
  active: { vaultId: string; vkId: string } | null,
) => PrfRecord | null | undefined;

/** The store's storage and lock (PrfStore's own, by element access: the same KV and the same webLock). */
const io = (s: PrfStore) => ({ kv: s["kv"] as KV, lock: s["lock"] as Lock });

/**
 * The one write: in the vault lock, the record read (its usable credentials; with `keyring` the active keyring's ids too),
 * then `fn` decides: a record to write, null to delete it, undefined to leave it (stored healed if something unusable was
 * left out of it). A read that throws propagates, with nothing written. Returns `fn`'s answer.
 */
export function updatePrf(
  store: PrfStore,
  fn: PrfStep,
  keyring?: (kv: KV) => Promise<{ vaultId: string; vkId: string }>,
): Promise<PrfRecord | null | undefined> {
  const { kv, lock } = io(store);
  return lock(async () => {
    const u = usableRecord((await kv.get([KEY]))[KEY]);
    const cur = u === null || u === "damaged" ? u : u.rec;
    const next = fn(cur, keyring ? await keyring(kv) : null);
    if (next === null && cur !== null) await kv.remove([KEY]);
    else if (next) await kv.set({ [KEY]: next });
    else if (next === undefined && u !== null && u !== "damaged" && u.dropped) await kv.set({ [KEY]: u.rec });
    return next;
  });
}

/** The time stored is a day old or more, or ahead of the clock (it was set back): due to be written again. */
export const noteDue = (r: PrfRecord, now: number): boolean =>
  r.creds.length > 0 &&
  (r.lastPasswordAt === undefined || !(now - r.lastPasswordAt < PRF_NOTE_MS && r.lastPasswordAt <= now));

/**
 * The master password has just unlocked Sixkey on a lock screen that offers the device unlock: its time goes into sk_prf,
 * at most once a day (noteDue); the 14 days of Q3 count from it. Called by that lock screen (the popup's, the side panel's,
 * the settings page's unlock bar) after a master-password unlock only: a recovery key proves the root, not that the
 * password is remembered. One read of sk_prf, and a write only when due. A write that is lost only asks for the master
 * password sooner. Never throws.
 */
export async function notePasswordTyped(store: PrfStore, now: number): Promise<void> {
  try {
    await updatePrf(store, (r) =>
      r && r !== "damaged" && noteDue(r, now) ? { ...r, lastPasswordAt: now } : undefined,
    );
  } catch {
    // not written: the next master password writes it
  }
}
