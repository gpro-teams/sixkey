// This profile's own records in chrome.storage.local that are not vault data (store.ts hasAnyData: a profile holding only
// these opens as empty), never mirrored, synced, backed up or exported. One place, so a key is never spelled twice.
//   sk_pin          the PIN's set-up (QUICK-UNLOCK §5.2; src/core/crypto/pin.ts, src/core/service/pin-store.ts). Its
//                   memory-only half, sk_quick, lives in chrome.storage.session (src/platform/session.ts) and is never in
//                   chrome.storage.local.
//   sk_pin_restart  the PIN after a restart (OWNER-DECISIONS/20; src/core/crypto/pin-restart.ts, pin-store.ts): the vault
//                   key under a key derived from the PIN, this profile's alone.
//   sk_prf          the device unlock's record, Touch ID / Windows Hello (QUICK-UNLOCK §5.2, Stage 2; prf-store.ts).
//   sk_oath         reserved for the YubiKey features (YUBIKEY-DESIGN §2.10, §5.1 R5).
// (Moved here from the server sync's core/sync/local/keys.ts when its client went: OWNER-DECISIONS/25, DV-0b.)
export const LOCAL_ONLY_KEYS = { prf: "sk_prf", oath: "sk_oath", pin: "sk_pin", restart: "sk_pin_restart" } as const;
