// The names Phase 1 sync reserves in this profile's storage (SYNC-DESIGN §2.5, §3.13, §4.1, §4.7; M2). One place, so
// a key is never spelled twice and the rules about them can be tested by name.
//
// chrome.storage.local:
//   sk_sync_cfg     the device's sync configuration and the copy of its signing key encrypted under the vault key (§2.5)
//   sk_sync_state   numbers, hashes, checksums and error codes only: lastSynced, backoff, clock offset (§4.1)
//   sk_sync_staged  a remote KeyBundle waiting to be adopted (§3.9)
//   sk_sync_outbox  the next upload, computed at the commit (§4.7)
//   sk_sync_orphan  {v: 1, items}: the outboxes a storage recovery or a demotion kept, this device's own earlier states
//                   (§4.7, D1, revisions 19 and 20); turning sync off keeps every entry the flow did not fold into
//                   the vault, and moves the live outbox into it unless the active generation provably holds it
//   sk_prejoin      this profile's own vault from before it joined another, under the cloud key; never deleted by itself
// IndexedDB:
//   sixkey-identity the device identity: deviceId, the non-extractable signing key, the pins (§2.5)
//
// None of them is vault data (store.ts hasAnyData): a profile holding only these opens as empty. "Turn sync off" and
// "remove the sync identity" delete the identity and the five sk_sync_* keys in one step and keep sk_prejoin (D11;
// sk_sync_orphan stays while it holds an entry: SyncLocal.turnOff).
// sk_prf and sk_oath are reserved for the YubiKey features (YUBIKEY-DESIGN §2.10, §5.1 R5): this profile's own records,
// deliberately not under sk_sync_*, so turning sync off never touches them; not vault data either. sk_pin is the PIN's
// set-up (QUICK-UNLOCK §5.2; src/core/crypto/pin.ts, src/core/service/pin-store.ts): the same kind of record, kept by
// turning sync off, never mirrored, synced, backed up or exported. Its memory-only half, sk_quick, lives in
// chrome.storage.session (src/platform/session.ts) and is never in chrome.storage.local. sk_pin_restart is the PIN after a
// restart (OWNER-DECISIONS/20; src/core/crypto/pin-restart.ts, src/core/service/pin-store.ts): the vault key under
// a key derived from the PIN, this profile's alone, the same kind of record again (local only, kept by turning sync off).
export const SYNC_KEYS = {
  cfg: "sk_sync_cfg",
  state: "sk_sync_state",
  staged: "sk_sync_staged",
  outbox: "sk_sync_outbox",
  orphan: "sk_sync_orphan",
  prejoin: "sk_prejoin",
} as const;

/** What "turn sync off" deletes from chrome.storage.local, with the identity (D11). Not sk_prejoin, sk_prf, sk_oath. */
export const SYNC_OFF_KEYS: readonly string[] = [
  "sk_sync_cfg",
  "sk_sync_state",
  "sk_sync_staged",
  "sk_sync_outbox",
  "sk_sync_orphan",
]; // = SYNC_KEYS minus prejoin (a test checks)

/** Reserved for the YubiKey features (R5), the PIN's set-up (QUICK-UNLOCK §5.2), and the PIN after a restart. */
export const LOCAL_ONLY_KEYS = { prf: "sk_prf", oath: "sk_oath", pin: "sk_pin", restart: "sk_pin_restart" } as const;

/** The IndexedDB database of the device identity, and the one key its record is stored under. */
export const IDENTITY_DB = "sixkey-identity";
export const IDENTITY_KEY = "identity";
