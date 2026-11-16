// The PIN's record (QUICK-UNLOCK §5.4; OWNER-DECISIONS/20 and its 2026-10-30 notes; docs/design/notes/PIN-RESTART-NOTES.md
// §18): sk_pin_restart, in chrome.storage.local, the one record a PIN opens Sixkey with, also after the browser restarts or
// the extension reloads (a store update too), until 5 wrong tries in a row. Every PIN set up has one (PinAdmin.setPin
// makes it; the master password typed on a lock screen makes it when there is none: a PIN set before 2026-10-30, whose
// record was only its session's). This module is its shape and what the PIN offers the lock screen, from what openView
// read with the pointer (loadView's `also`; pin-restart-count.ts restartOffer, in the lock screens' own chunks: nothing of
// the popup's main chunk imports this module, PIN-RESTART-NOTES.md §8). Pure functions, no crypto and no storage: the
// wrap's crypto, the MAC and the full field check are pin-restart-wrap.ts (a lazy chunk), the writes are
// pin-restart-steps.ts (lazy: the lock screens' unlock, its counter, the master password's note) and pin-restart-admin.ts
// (the settings page's, and the step every committed key event takes: setAsideRestart, from service.ts committed).
//
//   wrap.wrapped = AES-256-GCM(KEK, the vault key, AAD "sixkey-pin-restart|1|{vaultId}|{vkId}|{id}|{setup}|{wraps}")
//   KEK          = PBKDF2-SHA256(pinKek, the record's own 16-byte salt, at least 2,000,000 iterations, 256 bits)
//   pinKek       = PBKDF2-SHA256(NFKC(PIN), sk_pin's salt, its 600,000 iterations): the PIN's own key (pin.ts)
// So a guess at a copy of the profile costs both derivations (2.6M iterations at least, more than a master-password
// guess), and the master password, which opens sk_pin's pinKek with the vault key, can make the wrap again without the
// PIN (after 5 wrong tries, "End quick unlock now", a key change). The PIN, pinKek, the KEK and the unwrapped vault key
// are never stored anywhere. What a copy of the profile can do with it: guess the PIN offline, as the settings text says
// (every 4-digit PIN in seconds on one graphics card). The PIN is any PIN its policy takes (pin-policy.ts: 4 to 8 digits).
//
// What the PIN offers is decided here, against the keyring and sk_pin that loadView read with the record:
//   - nothing (null): no PIN set up for this vault and key, or a profile declared shared (never used there);
//   - "wait": the master password once makes it usable (pin-restart-steps.ts notePassword): no record of this vault (one
//     set before 2026-10-30, or lost), its wrap set aside (the 5th wrong PIN, "End quick unlock now"), 5 wrong PINs
//     counted;
//   - "paused": made under another vault key, another set of the keyring's wraps (any re-wrap: a key change, a new master
//     password, a reset, a new recovery key) or another PIN set-up (sk_pin's salt). The key event's step sets its wrap
//     aside (service.ts committed); the master password once makes it again, or, right after this page's own key event,
//     the PIN alone in Settings › Security (pin-restart-admin.ts turnBackOn);
//   - "pin": the PIN opens Sixkey with it, with QUICK_TRIES - fails tries left. No time limit (no 12 hours, no 14 days
//     since 2026-10-30): the 5 tries are the PIN's one limit.
// Not vault data (store.ts hasAnyData), never mirrored, synced, backed up or exported; turning sync off keeps it.
import type { Keyring } from "./keyring";
import { QUICK_TRIES, wrapsTag, type PinRecord } from "./pin";

/** The wrap: the vault key under the KEK (above), with the KEK's PBKDF2 parameters (its own salt). */
export type RestartWrap = {
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string; v: 1 };
  iv: string;
  wrapped: string;
};
export type RestartRecord = {
  v: 1;
  /** 16 random bytes, base64: new at every wrap made, bound in the AAD and the MAC. */
  id: string;
  vaultId: string;
  vkId: string;
  /** sk_pin's PBKDF2 salt: the PIN set-up whose pinKek the KEK is derived from. */
  setup: string;
  /** The keyring's wrapsTag (pin.ts) when it was made: any re-wrap pauses it. Not secret. */
  wraps: string;
  /** HMAC under the vault key of what the AAD binds (pin-restart-wrap.ts restartMac): made by Sixkey, for this vault. */
  mac: string;
  /** When it was made (the master password or the PIN that made it). Kept for its shape: no rule reads it since 2026-10-30. */
  lastPasswordAt: number;
  /** Wrong PINs in a row, counted before each try is derived (QUICK_TRIES: the wrap is then set aside). */
  fails: number;
  /** null: set aside (no key material left): the 5th wrong PIN, "End quick unlock now", a key change. */
  wrap: RestartWrap | null;
};

/**
 * sk_pin_restart as stored: the record, null when there is none, "damaged" when it is not even shaped like one (the settings
 * page's reading). Every field is checked in full by pin-restart-wrap.ts restartOk before anything of it is derived, made
 * again or written (a lazy chunk).
 */
export function parseRestart(x: unknown): RestartRecord | "damaged" | null {
  if (x === undefined || x === null) return null;
  const o = x as Partial<RestartRecord>;
  const ok =
    typeof o === "object" &&
    o.v === 1 &&
    typeof o.id === "string" &&
    typeof o.vaultId === "string" &&
    typeof o.vkId === "string" &&
    typeof o.setup === "string" &&
    typeof o.wraps === "string" &&
    typeof o.lastPasswordAt === "number" &&
    Number.isSafeInteger(o.fails) &&
    (o.fails as number) >= 0 &&
    (o.wrap === null || typeof o.wrap === "object");
  return ok ? (o as RestartRecord) : "damaged"; // stored as it is
}

export type RestartState = "pin" | "wait" | "paused";

/**
 * What the PIN offers this keyring with the record `x` (as stored) and sk_pin as read beside it (the list above). Only
 * what this reads is looked at: a field out of shape never offers more than a PIN field that the record's own unlock then
 * refuses, after its full check (pin-restart-wrap.ts restartOk), with no try counted.
 */
export function restartState(
  x: unknown,
  keyring: Pick<Keyring, "vaultId" | "vkId"> & { wraps: readonly { wrapped: string }[] },
  pin: PinRecord | "damaged" | null,
  shared: boolean,
): RestartState | null {
  if (shared || !pin || pin === "damaged" || pin.vaultId !== keyring.vaultId || pin.vkId !== keyring.vkId) return null;
  const r = x as Partial<RestartRecord> | null | undefined;
  if (typeof r !== "object" || r === null || r.v !== 1 || r.vaultId !== keyring.vaultId) return "wait";
  if (r.vkId !== keyring.vkId || r.wraps !== wrapsTag(keyring) || r.setup !== pin.kdf.salt) return "paused";
  return r.wrap && r.fails! < QUICK_TRIES ? "pin" : "wait";
}
