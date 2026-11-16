// What the Sync section shows for the state sync is in (SYNC-DESIGN §6 O1, O12, P4): pure functions from the facts the
// gateway reads (gateway.ts SyncFacts) to a card, the rail's one line, the notices and the text of a failure. No DOM, no
// storage, no clock of its own: the tests run every state through these (test/unit/m6-model.test.ts).
//
// One card at a time, chosen in this order:
//   1. no sync records: the explanation card (O1), from which sync is turned on or a vault joined;
//   2. the local side first (§2.5): an unfinished turn-off, a damaged record, a lost identity, a lost vault;
//   3. the network switch (§4.9): the API permission withdrawn, from what Chrome says now, not only from the stored
//      status, which changes with the next round only (M5-NOTES §9 item 11);
//   4. the key state (§3.9): keys_behind, a new password needed, a bundle refused;
//   5. the status the last round stored (§6 O12): one entry per status, exhaustive (a new status fails the build).
// Text is given as keys of the Sync section's catalog (text.ts st) with their substitutions, so the tests check which
// words are shown without loading the catalog.
import type {
  DeviceNameProblem,
  Failure,
  KeyStatus,
  Notice,
  NoticeKind,
  PreparedJoin,
  SyncFacts,
  SyncStatus,
} from "./gateway";

/** A key of the Sync section's catalog and its $1..$9; a substitution may itself be a text ("Last synced $1": "5 min ago"). */
export type Sub = string | number | Text;
export type Text = { k: string; s?: Sub[] };
const tx = (k: string, ...s: Sub[]): Text => (s.length ? { k, s } : { k });

export type Tone = "good" | "busy" | "info" | "warn" | "danger";

/** What a card offers. The view binds each to its handler (the permission-asking ones through permission.ts asking). */
export type ActionId =
  | "sync_now" // a round now (explicit: also inside a backoff)
  | "grant" // ask Chrome for the API permission again, then a round
  | "unlock" // move to the page's unlock field
  | "adopt" // the master password, to take over keys changed elsewhere (§3.9 R2/R3/R4)
  | "review" // a round, to show what the guard stopped (§4.4)
  | "remove_identity" // local only, after a confirmation (§3.10 P5)
  | "check_again" // an unfinished first upload or join: ask the server (D4)
  | "start_over" // an unfinished one that did not land: start the flow again
  | "backup" // the Backup section (restore from a backup file)
  | "restore_cloud" // the vault lost here: the master password restores it from the synced vault (§4.13, an adoption)
  | "start_over_vault" // the vault lost here: Phase 0's start over, behind its own typed confirmation (the Advanced section)
  | "repair" // keys_behind, server_older_key: this device's keys published again (§4.2, N24)
  | "rejoin" // different_vault: this device leaves sync (the master password), then joins the synced vault again (§3.5)
  | "rotate_keys"; // a device revoked as lost and the keys not rotated since (§3.10): the rotation (keyops.ts "rotate")

export type Card = { id: string; tone: Tone; title: Text; lines: Text[]; actions: ActionId[] };

/** The vault as the page sees it (App's status). */
export type VaultState = "unlocked" | "locked" | "empty" | "lost";

/** When something happened, in words: "just now", "5 min ago", else the date and time (given by the caller's formatter). */
export function when(at: number | null, now: number, dateTime: (ms: number) => string): Text {
  if (at === null) return tx("syncWhenNever");
  const ago = now - at;
  if (ago >= -60_000 && ago < 60_000) return tx("syncWhenNow");
  if (ago > 0 && ago < 3_600_000) return tx("syncWhenMinutes", Math.floor(ago / 60_000));
  return tx("syncWhenAt", dateTime(at));
}

/** In words, how long until `at`: "in a moment", "in N min", else the time. */
export function until(at: number | null, now: number, dateTime: (ms: number) => string): Text | null {
  if (at === null || at <= now) return null;
  const left = at - now;
  if (left < 60_000) return tx("syncNextSoon");
  if (left < 3_600_000) return tx("syncNextMinutes", Math.ceil(left / 60_000));
  return tx("syncNextAt", dateTime(at));
}

/** The text of the last round's error code (lastErrorCode: a short snake_case word, the contract's or the engine's). */
export function roundErrorText(code: string | null): Text {
  switch (code) {
    case null:
      return tx("syncErrUnknown");
    case "rate_limited":
      return tx("syncErrBusy");
    case "unavailable":
    case "internal_error":
    case "server":
      return tx("syncErrServer");
    case "version_conflict":
    case "restart_limit":
      return tx("syncErrConflict");
    case "malformed_response":
      return tx("syncErrMalformed");
    case "write_denied":
      return tx("syncErrDenied");
    case "internal":
      return tx("syncErrInternal");
    default:
      return tx("syncErrCode", code);
  }
}

const card = (id: string, tone: Tone, title: string, lines: Text[], actions: ActionId[]): Card => ({
  id,
  tone,
  title: tx(title),
  lines,
  actions,
});

type Ctx = { f: SyncFacts; vault: VaultState; now: number; dateTime: (ms: number) => string; host: string };
const lastOk = (c: Ctx): Text => tx("syncLastOk", when(c.f.lastOkAt, c.now, c.dateTime));
const next = (c: Ctx): Text[] => {
  const u = until(c.f.backoffUntil, c.now, c.dateTime);
  return u ? [u] : [];
};

/** §6 O12: one entry per status the engine can store. A status added to SyncStatus fails the build here. */
const BY_STATUS: Record<SyncStatus, (c: Ctx) => Card> = {
  off: () => card("starting", "busy", "syncStarting", [tx("syncStartingBody")], ["sync_now"]),
  ok: (c) =>
    card(
      "ok",
      "good",
      "syncOkTitle",
      [lastOk(c), ...(c.f.pendingEnrollments > 0 ? [tx("syncPendingLine", c.f.pendingEnrollments)] : [])],
      ["sync_now"],
    ),
  offline: (c) => card("offline", "warn", "syncOfflineTitle", [tx("syncOfflineBody"), ...next(c)], ["sync_now"]),
  // a key change of this device sent and not confirmed (the page may have closed before its local commit): the master
  // password set on the server is offered beside the page's own unlock (an adoption, which opens a locked page)
  locked: (c) =>
    c.f.pendingKeyChange
      ? card(
          "locked",
          "info",
          "syncLockedTitle",
          [tx("syncLockedBody"), tx("syncLockedPendingBody")],
          ["unlock", "adopt"],
        )
      : card("locked", "info", "syncLockedTitle", [tx("syncLockedBody")], ["unlock"]),
  error: (c) => card("error", "warn", "syncErrorTitle", [roundErrorText(c.f.lastErrorCode), ...next(c)], ["sync_now"]),
  busy: () => card("busy", "busy", "syncBusyTitle", [], []),
  needs_password: () =>
    card("needs_password", "warn", "syncNeedsPasswordTitle", [tx("syncNeedsPasswordBody")], ["adopt"]),
  review_needed: () => card("review_needed", "warn", "syncReviewTitle", [tx("syncReviewBody")], ["review"]),
  remote_unreadable: () =>
    card("remote_unreadable", "danger", "syncUnreadableTitle", [tx("syncUnreadableBody")], ["sync_now"]),
  // an honest restore of the server to before a rotation stops every device here: this one holds the newer keys and
  // repairs the cloud with them (§4.2); a repair from another device clears it with the next round
  server_older_key: () =>
    card(
      "server_older_key",
      "danger",
      "syncOlderKeyTitle",
      [tx("syncOlderKeyBody"), tx("syncRepairPending")],
      ["repair", "sync_now"],
    ),
  update_required: () => card("update_required", "danger", "syncUpdateTitle", [tx("syncUpdateBody")], []),
  too_large: () => card("too_large", "warn", "syncTooLargeTitle", [tx("syncTooLargeBody")], ["sync_now"]),
  paused_newer: () => card("paused_newer", "warn", "syncNewerTitle", [tx("syncNewerBody")], ["sync_now"]),
  different_vault: () =>
    card(
      "different_vault",
      "danger",
      "syncDifferentTitle",
      [tx("syncDifferentBody"), tx("syncPausedHere")],
      ["rejoin"],
    ),
  rejected_by_server: () =>
    card(
      "rejected_by_server",
      "danger",
      "syncRejectedTitle",
      [tx("syncRejectedBody"), tx("syncUninstallNote")],
      ["sync_now", "remove_identity"],
    ),
  join_unfinished: (c) =>
    c.f.identity && !c.f.identity.pinned
      ? card("upload_unfinished", "warn", "syncUploadUnfinishedTitle", [tx("syncUnfinishedBody")], ["check_again"])
      : card(
          "join_unfinished",
          "warn",
          "syncJoinUnfinishedTitle",
          [tx("syncUnfinishedBody")],
          ["check_again", "start_over"],
        ),
  identity_missing: (c) =>
    card(
      "identity_missing",
      "info",
      "syncIdentityMissingTitle",
      [tx(c.vault === "unlocked" ? "syncIdentityMissingRestoring" : "syncIdentityMissingBody")],
      c.vault === "unlocked" ? ["sync_now"] : ["unlock"],
    ),
  cloud_restore: () =>
    card(
      "cloud_restore",
      "danger",
      "syncVaultLostTitle",
      [tx("syncVaultLostBody")],
      ["restore_cloud", "backup", "start_over_vault"],
    ),
  damaged: () => card("damaged", "danger", "syncDamagedTitle", [tx("syncDamagedBody")], ["remove_identity"]),
  wrong_origin: () =>
    card("wrong_origin", "danger", "syncWrongOriginTitle", [tx("syncWrongOriginBody")], ["remove_identity"]),
  permission_removed: (c) =>
    card("permission_removed", "warn", "syncPausedTitle", [tx("syncPausedBody", c.host)], ["grant"]),
};

/**
 * §3.10: a rotation owed after a "lost" revocation. It says a device was revoked only when that is on the record (a run
 * that stopped before its revocation went may have revoked nothing: check the list), and why the rotation waited.
 */
function owedCard(o: { revoked: boolean; waits: string | null }): Card {
  const lines = o.revoked ? [tx("syncRotationOwedBody")] : [tx("syncRotationOwedUnsure")];
  if (o.waits) lines.push(tx("syncRotationOwedWaits"), failureText({ code: o.waits }));
  return card("rotation_owed", "danger", "syncRotationOwedTitle", lines, ["rotate_keys"]);
}

/** §3.9: the key state the last round judged, when it is not "ok". */
const BY_KEY_STATUS: Record<Exclude<KeyStatus, "ok">, (c: Ctx) => Card> = {
  keys_behind: () =>
    card(
      "keys_behind",
      "danger",
      "syncKeysBehindTitle",
      [tx("syncKeysBehindBody"), tx("syncKeysBehindPaused")],
      ["repair"],
    ),
  needs_new_password: () =>
    card("needs_new_password", "warn", "syncNewPasswordTitle", [tx("syncNewPasswordBody")], ["adopt"]),
  rejected: () => card("keys_rejected", "danger", "syncKeysRejectedTitle", [tx("syncKeysRejectedBody")], ["sync_now"]),
  update_required: (c) => BY_STATUS.update_required(c),
};

/** The statuses that come from the local side and stop a round before it would ask for the permission (§4.9). */
const LOCAL_STOPS: ReadonlySet<SyncStatus> = new Set<SyncStatus>([
  "identity_missing",
  "cloud_restore",
  "damaged",
  "wrong_origin",
  "join_unfinished",
  "rejected_by_server",
]);

/** The card for the state sync is in, or null when there are no sync records here (the explanation card, O1). */
export function cardOf(
  f: SyncFacts,
  vault: VaultState,
  now: number,
  dateTime: (ms: number) => string,
  host = "api.sixkey.app",
): Card | null {
  const c: Ctx = { f, vault, now, dateTime, host };
  // the local side (§2.5)
  if (f.local === "off") return null;
  if (f.local === "damaged") return BY_STATUS.damaged(c);
  if (f.local === "identity_missing") return BY_STATUS.identity_missing(c);
  if (f.local === "cfg_missing") {
    // a pending identity never pinned is an enrolment in progress elsewhere (or a page closed before it wrote anything):
    // nothing to show but the explanation card; otherwise an unfinished turn-off (the next round finishes it), or with the
    // vault lost the cloud restore (§4.13)
    if (f.identity?.state === "pending" && !f.identity.pinned) return null;
    if (vault === "lost") return BY_STATUS.cloud_restore(c);
    return card("finishing_off", "busy", "syncFinishingOffTitle", [tx("syncFinishingOffBody")], ["sync_now"]);
  }
  const status = f.status;
  if (status !== null && LOCAL_STOPS.has(status)) return BY_STATUS[status](c);
  if (vault === "lost") return BY_STATUS.cloud_restore(c);
  // the network switch, as Chrome says now
  if (!f.permission) return BY_STATUS.permission_removed(c);
  if (status === "permission_removed")
    return card("resuming", "busy", "syncResumingTitle", [tx("syncResumingBody")], ["sync_now"]);
  // the key state, then a rotation still owed (over every round status but the lock and a round under way: the rotation
  // needs the open vault), then the round's status
  if (f.keyStatus !== null && f.keyStatus !== "ok") return BY_KEY_STATUS[f.keyStatus](c);
  if (f.rotationOwed && status !== "locked" && status !== "busy") return owedCard(f.rotationOwed);
  if (status === null) return BY_STATUS.off(c);
  return BY_STATUS[status](c);
}

// ---- the rail's line (§6: "侧栏状态卡已有的'同步'一行改为显示状态和最后同步时间") ----------------------------------------

export type RailLine = { text: Text; tone: "none" | "good" | "warn" | "bad" };

/** The rail's line; null when sync is off here (the rail then says what it says without the section: "Off"). */
export function railOf(
  f: SyncFacts,
  vault: VaultState,
  now: number,
  dateTime: (ms: number) => string,
): RailLine | null {
  const c = cardOf(f, vault, now, dateTime);
  if (!c) return null;
  if (c.id === "ok") return { text: tx("syncRailOk", when(f.lastOkAt, now, dateTime)), tone: "good" };
  if (c.tone === "busy") return { text: tx("syncRailBusy"), tone: "none" };
  if (c.id === "offline") return { text: tx("syncRailOffline"), tone: "warn" };
  if (c.id === "permission_removed" || c.id === "update_required" || c.id === "paused_newer")
    return { text: tx("syncRailPaused"), tone: "warn" };
  if (c.id === "locked" || c.id === "identity_missing") return { text: tx("syncRailLocked"), tone: "none" };
  return { text: tx("syncRailAttention"), tone: c.tone === "danger" ? "bad" : "warn" };
}

// ---- notices (§6 P4, O12): one-time, until the user has seen them ----------------------------------------------

/**
 * `link`: where the notice points: the trash (deleted accounts are there), or the backups (erased ones are not).
 * `act`: what it offers: for a profile that looks like a copy of another one, making it a device of its own (§4.10);
 * for accounts another device deleted, finding them in an earlier version (§6 P4 "[找回]", O13).
 */
export type NoticeView = {
  notice: Notice;
  tone: Tone;
  text: Text;
  link?: "trash" | "backup";
  act?: "fork" | "find";
};

const NOTICE: Record<NoticeKind, (n: Notice) => Omit<NoticeView, "notice">> = {
  rollback: () => ({ tone: "warn", text: tx("syncNoticeRollback") }),
  keys_adopted: () => ({ tone: "warn", text: tx("syncNoticeKeysAdoptedBack") }),
  keys_changed: () => ({ tone: "info", text: tx("syncNoticeKeysChanged") }),
  forked: () => ({ tone: "warn", text: tx("syncNoticeForked"), act: "fork" }),
  device_joined: () => ({ tone: "info", text: tx("syncNoticeDeviceJoined") }),
  device_revoked: () => ({ tone: "info", text: tx("syncNoticeDeviceRevoked") }),
  auth_failures: () => ({ tone: "danger", text: tx("syncNoticeAuthFailures") }),
  deleted_remotely: (n) =>
    n.danger
      ? { tone: "danger", text: tx("syncNoticeDeletedDanger", n.n ?? 3), link: "backup", act: "find" }
      : { tone: "warn", text: tx("syncNoticeDeleted", n.n ?? 3), link: "trash", act: "find" },
  recovery_in_effect: () => ({ tone: "good", text: tx("syncNoticeRecoveryOk") }),
  recovery_not_in_effect: () => ({ tone: "danger", text: tx("syncNoticeRecoveryVoid") }),
  rev_mismatch: () => ({ tone: "info", text: tx("syncNoticeRevMismatch") }),
  orphan_unreadable: (n) => ({ tone: "danger", text: tx("syncNoticeOrphanGone", n.n ?? 1) }),
  duplicates_trashed: (n) => ({ tone: "info", text: tx("syncNoticeDuplicates", n.n ?? 1), link: "trash" }),
  clock_skew: () => ({ tone: "warn", text: tx("syncNoticeClock") }),
};

/** The notices to show, newest first; kinds this version does not know are left for a newer one. */
export function noticesOf(list: readonly Notice[]): NoticeView[] {
  return [...list]
    .filter((n) => Object.hasOwn(NOTICE, n.kind))
    .sort((a, b) => b.at - a.at)
    .map((n) => ({ notice: n, ...NOTICE[n.kind](n) }));
}

// ---- parked entries (§4.7, §6 O12) -----------------------------------------------------------------------------

/** Each reason's way out (outbox.ts ParkReason); a reason this version does not know is said as the entry limit's. */
const PARKED_WAY: Record<string, string> = {
  schema: "syncParkedSchema",
  key: "syncParkedKey",
  too_large: "syncParkedTooLarge",
  vault: "syncParkedVault",
};

/** The parked notice: how many saves wait, and each reason's way out. */
export function parkedLines(p: { count: number; reasons: readonly string[] }): { title: Text; ways: Text[] } {
  const ways = p.reasons.map((r) => tx(Object.hasOwn(PARKED_WAY, r) ? PARKED_WAY[r]! : "syncParkedTooLarge"));
  return { title: tx("syncParkedTitle", p.count), ways };
}

// ---- the failures of a flow (O2, O3, O7, O9; the service's own codes, §3.13) -----------------------------------

/** What a flow's failure means, in words, and whether the user can fix it in place (the flow stays open). */
export function failureText(f: Failure): Text {
  const secs = f.wait !== undefined ? Math.max(1, Math.ceil(f.wait / 1000)) : null;
  switch (f.code) {
    case "network":
    case "offline":
      return tx("syncFailNetwork");
    case "wrong_secret":
      return tx("syncFailPassword");
    case "otp_invalid":
      return tx("syncFailCode");
    case "otp_format":
      return tx("syncFailCodeFormat");
    case "recovery_not_local":
      return tx("syncFailRecoveryNotLocal");
    case "confirm_lost":
      return tx("syncFailConfirmLost");
    case "declined":
      return tx("syncFailDeclined");
    case "stale":
    case "bad_state":
      return tx("syncFailChanged");
    case "password_mismatch":
      return tx("syncFailPassword");
    case "needs_adoption":
      return tx("syncNeedsPasswordBody");
    case "keys_behind":
      return tx("syncKeysBehindBody");
    case "device_revoked":
    case "unknown_device":
      return tx("syncRejectedBody");
    case "bad_mac":
    case "wrong_vault":
    case "invalid_bundle":
    case "auth_without_password":
    case "previous_dropped":
    case "discontinuous":
      return tx("syncKeysRejectedBody");
    case "invalid_email":
      return tx("syncFailEmail");
    case "rate_limited":
      return secs === null
        ? tx("syncFailTooMany")
        : secs >= 120
          ? tx("syncFailTooManyMinutes", Math.ceil(secs / 60))
          : tx("syncFailTooManySeconds", secs);
    case "session_invalid":
      return tx("syncFailSession");
    case "recovery_mismatch":
      return tx("syncFailRecoveryMismatch");
    case "invalid_recovery_code":
    case "recovery_char":
    case "recovery_checksum":
    case "recovery_length":
      return tx("syncFailRecoveryFormat");
    case "invalid_device_name":
      return tx("syncNameInvalid");
    case "locked":
      return tx("syncFailLocked");
    case "locked_out":
      return tx("syncFailLockedOut");
    case "vault_lost":
      return tx("syncFailVaultLost");
    case "unfinished_wait":
      return tx("syncFailUnfinishedWait", Math.max(1, Math.ceil((f.wait ?? 60_000) / 60_000)));
    case "already_on":
      return tx("syncFailAlreadyOn");
    case "status_failed":
    case "server":
    case "unavailable":
    case "internal_error":
      return tx("syncErrServer");
    case "paused_newer":
    case "newer_schema":
      return tx("syncNewerBody");
    case "update_required":
      return tx("syncUpdateBody");
    case "remote_unreadable":
    case "bad_bundle":
      return tx("syncFailBundle");
    case "keyring_changed":
      return tx("syncFailKeyringChanged");
    case "one_per_session":
      return tx("syncFailOnePerSession");
    case "gone":
    case "enroll_gone":
    case "expired":
    case "rejected":
      return tx("syncFailGone");
    case "join_ended": // the new device, after its reveal: perhaps the approver's "did not match" (join.ts)
      return tx("syncFailJoinEnded");
    case "pairing_mismatch":
      return tx("syncApproveMismatch");
    case "tampered":
    case "unexpected_state":
    case "reflected_key":
    case "invalid_view":
    case "bad_payload":
      return tx("syncFailTampered");
    case "cancelled":
      return tx("syncFailCancelled");
    case "too_many_devices":
      return tx("syncFailTooManyDevices");
    case "busy":
      return tx("syncFailBusy");
    case "unconfirmed":
      return tx("syncFailUnconfirmed");
    case "too_large":
    case "too_large_for_sync":
      return tx("syncTooLargeBody");
    case "different_vault":
      return tx("syncDifferentBody");
    case "review_needed":
      return tx("syncReviewBody");
    // the managing flows (part B)
    case "choose_reason":
      return tx("syncFailChooseReason");
    case "rotation_owed":
      return tx("syncFailRotationOwed");
    case "rotation_owed_first":
      return tx("syncFailRotationOwedFirst");
    case "kept_full":
      return tx("syncFailKeptFull");
    case "delete_unconfirmed":
      return tx("syncFailDeleteUnconfirmed");
    case "not_synced":
      return tx("syncFailNotSynced");
    case "changed_elsewhere":
      return tx("syncFailChangedElsewhere");
    case "weak_password":
      return tx("syncFailWeakPassword");
    case "cleanup_pending":
      return tx("syncFailCleanupPending");
    case "password_changed_elsewhere":
      return tx("syncFailPasswordElsewhere");
    case "old_password_required":
      return tx("syncFailOldPassword");
    case "not_behind":
      return tx("syncFailNotBehind");
    case "sas_mismatch":
      return tx("syncFailSasMismatch");
    case "keys_changed":
      return tx("syncFailKeysChanged");
    case "not_enrolled":
      return tx("syncFailNotEnrolled");
    default:
      return tx("syncFailOther", f.code);
  }
}

/**
 * The failures a user fixes on the same screen (a typo, a code to send again, a sign-in to repeat): the flow stays open
 * and keeps the API permission while it does. Every other failure ends the flow, and the permission is given back.
 * "locked" is not among them: a lock during a flow ends it (lock.ts). The join's warning card says "unlock first" when
 * the page is locked as the user chooses a way in (join.ts ready), and that card stays open.
 */
export const FIXABLE: ReadonlySet<string> = new Set([
  "wrong_secret",
  "otp_invalid",
  "otp_format",
  "invalid_email",
  "rate_limited",
  "session_invalid",
  "recovery_mismatch",
  "invalid_recovery_code",
  "recovery_char",
  "recovery_checksum",
  "recovery_length",
  "recovery_not_local",
  "confirm_lost",
  "invalid_device_name",
  "review_needed",
]);
export const fixable = (f: Failure): boolean => FIXABLE.has(f.code);

/** §2.4's rules for a device name, one sentence each (N28: the emoji joiner counts as a zero-width character). */
const NAME_PROBLEM: Record<DeviceNameProblem, string> = {
  not_well_formed: "syncNameNotWellFormed",
  empty: "syncNameEmpty",
  too_long: "syncNameTooLong",
  control_char: "syncNameControl",
  bidi_control: "syncNameBidi",
  zero_width: "syncNameZeroWidth",
};
export const nameProblemKey = (p: string): string =>
  Object.hasOwn(NAME_PROBLEM, p) ? NAME_PROBLEM[p as DeviceNameProblem] : "syncNameNotWellFormed";

// ---- the join's summary (§3.5 ③) ---------------------------------------------------------------------------------

/**
 * What a join will do to this profile, for its summary. The approval path prepares against the synced vault without its
 * accounts (they reach this device only with the first round, M3-NOTES §3 item 6), so it cannot know which of this
 * profile's accounts are there already: it says that those go to the trash after the first sync (the dedupe, §3.5,
 * revision 24; engine.ts dedupeAfterJoin), never a count of skipped ones.
 */
export function summaryText(p: PreparedJoin, via: "recovery" | "approval"): Text {
  switch (p.mode) {
    case "added":
      return via === "approval" ? tx("syncSummaryAddedLater", p.added) : tx("syncSummaryAdded", p.added, p.skipped);
    case "merged":
      return tx("syncSummaryMerged");
    case "lost":
      return tx("syncSummaryLost");
    default:
      return tx("syncSummaryEmpty");
  }
}
