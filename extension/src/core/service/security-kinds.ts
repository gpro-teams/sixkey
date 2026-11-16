// The kinds of the local security record (security-log.ts), by name: what Sixkey records and the settings page lists
// (src/options/SecurityCard.tsx, a label for every kind). Only the settings page and the service's types need the names:
// the record itself (the class every page and the worker build, the popup's and the side panel's included) checks a
// kind's form only (security-log.ts isKind), so that no page has to carry this list (docs/design/notes/BUDGET3-NOTES.md
// §2, §5.1: about 165 B of the popup's counted bundle). No module imports it but for its types, so the popup and the
// side panel never load it (test/unit/budget3-rules.test.ts, its first group); and every kind a caller passes is one of
// these: `SecurityKind` types it, and a source rule holds the first argument of every record(…) and recordAction(…) to
// a quoted name of this list, or to one of a few typed parameters it lists.

/**
 * Version 1 (Phase 0.x):
 * - unlock_failed: a wrong master password, wherever it was asked: the lock screen, or again before an export
 *   (verifyPassword), a password change or a key rotation.
 * - recovery_failed: a wrong recovery code (unlocking with it, or resetting the password with it). A code that is not
 *   even well-formed is a typo, not a guess, and is not recorded.
 * - recovery_used: the recovery code was accepted for an unlock. Recorded as soon as it is accepted, before the vault is
 *   opened, so whoever holds the code cannot avoid the entry (even if opening then fails).
 * - export_encrypted / export_plain / export_subset: recorded by the settings page after an export (recordExport).
 * - password_enabled (a Phase 0 vault got its master password), password_changed, password_reset (by the recovery code),
 *   key_rotated, recovery_code_new: the keys changed.
 * - log_cleared: the log was cleared (with the master password); the one entry clear() leaves, so clearing is not silent.
 * Added by version 2 (M2; docs/design/notes/M2-NOTES.md §4.14 says which flow records which):
 * - sync_on / sync_off: this profile turned sync on (first device, or joined by approval or the recovery code) / off
 *   (or removed its sync identity, D11).
 * - identity_restored: the device identity came back from its copy encrypted under the vault key (§2.5 identity_missing).
 * - keys_adopted: keys changed on another device (a new password, a new recovery code, a rotation) were adopted here
 *   (§3.9 R2, R3, R6), so a recovery code planted elsewhere is visible here too (§3.7).
 * - device_approved / device_revoked: this profile approved a new device / revoked one (§3.2, §3.10).
 * - history_cleared: this profile cleared the server's history (§5.4 DELETE /v1/vault/versions).
 * - prf_enrolled / prf_removed / prf_failed: the device unlock (Touch ID / Windows Hello, QUICK-UNLOCK Stage 2) added,
 *   removed, or an answer that did not open its wrap. prf_failed is not a wrong-password guess and is not counted with
 *   them. (They were reserved with oath_on / oath_off for the YubiKey features in the one bump of YUBIKEY-DESIGN §5.1 R8;
 *   since SYNC-DESIGN revision 25 a version keeps the entries of kinds it does not know, so a kind needs no reservation:
 *   the YubiKey kinds come with that feature, and oath_on / oath_off, never recorded, were dropped; BUDGET3-NOTES.md §3.)
 * Added in version 2 without a bump (M6): a new kind needs none, since a version keeps the entries of kinds it does not
 * know when it rewrites the record (security-log.ts StoredEntry; so does every version from this one on, and none before
 * shipped):
 * - keys_adopted_back: keys this device had committed before were adopted back from the server (§3.9 R1; the accepted
 *   residual there: an IndexedDB that went back alone could make an old bundle look like this device's own), so the
 *   one case where keys are taken without asking is visible in the record as well as in the Sync section's notice.
 * Added in version 2 without a bump (QUICK-UNLOCK §5.10, Stage 1; the rule above, not that document's "one bump"):
 * - pin_set / pin_removed: the PIN was set (or changed) / removed, each after the master password was typed again.
 * - pin_failed: a wrong PIN at the lock screen. A wrong guess like a wrong password: counted in FAILURES, so the popup's
 *   notice reports it. A PIN that is not even 4 to 8 digits is a typo, not a guess, and is not recorded.
 * - quick_ended: quick unlock was ended: the 5th wrong PIN, or "End quick unlock now". The Touch ID / Windows Hello
 *   gate's 12-hour end, a browser restart and the hard locks that follow a key change are not recorded.
 * - shares_made: recovery code shares of the current code (docs/design/notes/SHAMIR-NOTES.md §3): the strongest root
 *   copied once more, as an export is recorded; a set that replaced the code is recovery_code_new.
 * pin_restart_on / pin_restart_off (the PIN's "Also after a restart" switch turned on / off, docs/design/notes/
 * BUDGET3-NOTES.md §5) went with that switch (OWNER-DECISIONS/20, its second 2026-10-30 note: the PIN always works after
 * a restart): nothing records them, so they are not kinds any more (budget3-rules: no kind nobody records), and entries of
 * theirs already in a record are kept there as a newer version's are, not listed.
 */
export const SECURITY_KINDS = [
  "unlock_failed",
  "recovery_failed",
  "recovery_used",
  "export_encrypted",
  "export_plain",
  "export_subset",
  "password_enabled",
  "password_changed",
  "password_reset",
  "key_rotated",
  "recovery_code_new",
  "log_cleared",
  "sync_on",
  "sync_off",
  "identity_restored",
  "keys_adopted",
  "device_approved",
  "device_revoked",
  "history_cleared",
  "prf_enrolled",
  "prf_removed",
  "prf_failed",
  "keys_adopted_back",
  "pin_set",
  "pin_removed",
  "pin_failed",
  "quick_ended",
  "shares_made",
] as const;
export type SecurityKind = (typeof SECURITY_KINDS)[number];
