// What the server sync's client left in a profile, removed once (OWNER-DECISIONS/25, DV-0b). That client (its engine,
// worker, bridge and transport, docs/SYNC-DESIGN.md) is gone from the extension, so nothing reads or writes these any
// more. Only a dev or e2e profile that once turned sync on or joined a synced vault can hold them: the store and test
// builds never had a way to turn sync on. So the dev and e2e builds' worker calls this when Sixkey is installed or updated
// (src/background/sw.ts, chrome.runtime.onInstalled: a reload of the unpacked build is an update), and the store and test
// builds compile it out (the build's define; check-dist holds their files to none of these names).
//   chrome.storage.local:
//     sk_sync_cfg, sk_sync_state, sk_sync_staged, sk_sync_outbox, sk_sync_orphan
//                     the sync configuration (with its signing key's copy under the vault key), its state, a key bundle
//                     waiting to be adopted, the next upload and the uploads a recovery kept (SYNC-DESIGN §2.5, §4.1, §4.7)
//     sk_prejoin      the vaults this profile kept from before it joined another, under the cloud key (§3.5 ④)
//   IndexedDB:
//     sixkey-identity the device identity: its id, its non-extractable signing key, the pins (§2.5)
//   chrome.alarms:
//     sk-sync-sync, sk-sync-kick, sk-sync-retry, sk-sync-periodic
//                     its worker's wakes and its periodic round (Chrome usually drops alarms at an update, which is not
//                     verified for the reload of an unpacked build; one left would wake the worker for nothing)
// None of them is vault data (store.ts hasAnyData): removing them changes nothing a page shows or opens. What a kept
// vault in sk_prejoin or an upload in sk_sync_orphan held is gone with them; no build can open either any more. Removing
// what is not there changes nothing, so a second run (the next update) only reads: one get, and the database's delete,
// which is a no-op for a database that does not exist.
import type { KV } from "../core/storage/kv";

/** The server sync's records in chrome.storage.local (its core/sync/local/keys.ts SYNC_KEYS, as they were). */
export const SERVER_SYNC_KEYS: readonly string[] = [
  "sk_sync_cfg",
  "sk_sync_state",
  "sk_sync_staged",
  "sk_sync_outbox",
  "sk_sync_orphan",
  "sk_prejoin",
];

/** The device identity's IndexedDB database (its core/sync/local/keys.ts IDENTITY_DB). */
export const SERVER_SYNC_IDENTITY_DB = "sixkey-identity";

/** The server sync's alarms (its sync-worker.ts SYNC_ALARMS, as they were). */
export const SERVER_SYNC_ALARMS: readonly string[] = [
  "sk-sync-sync",
  "sk-sync-kick",
  "sk-sync-retry",
  "sk-sync-periodic",
];

/** IndexedDB's one call used here (tests pass a fake). */
export type DatabaseDeleter = Pick<IDBFactory, "deleteDatabase">;
/** chrome.alarms's one call used here: true when there was such an alarm. */
export type AlarmClearer = { clear(name: string): Promise<boolean> };

/** The database deleted: settles on success, on an error, or when another connection blocks it (it goes once that closes). */
function deleteDatabase(idb: DatabaseDeleter, name: string): Promise<void> {
  return new Promise((done) => {
    try {
      const req = idb.deleteDatabase(name);
      req.onsuccess = req.onerror = req.onblocked = () => done();
    } catch {
      done(); // no IndexedDB here: nothing of it to remove
    }
  });
}

/**
 * Removes the server sync's records from `local`, its identity database from `idb` and its alarms from `alarms`, and
 * returns the keys and the alarms it found and removed (for the diagnostics log), none when there were none. One read
 * of the six keys; one remove only when any is there. A read or a remove that throws propagates (the next update tries
 * again); the database's delete and an alarm's clear never throw.
 */
export async function dropServerSyncLeftovers(
  local: KV,
  idb?: DatabaseDeleter,
  alarms?: AlarmClearer,
): Promise<{ keys: string[]; alarms: string[] }> {
  const found = await local.get([...SERVER_SYNC_KEYS]);
  const keys = SERVER_SYNC_KEYS.filter((k) => found[k] !== undefined);
  if (keys.length) await local.remove(keys);
  if (idb) await deleteDatabase(idb, SERVER_SYNC_IDENTITY_DB);
  const cleared: string[] = [];
  for (const name of alarms ? SERVER_SYNC_ALARMS : [])
    if (await alarms!.clear(name).catch(() => false)) cleared.push(name);
  return { keys, alarms: cleared };
}
