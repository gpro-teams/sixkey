// What the Sync section shows for each state (src/options/sync/model.ts): every status the engine can store, every key
// state, the local side before them, the API permission as Chrome says it now, the rail's line, the notices, the parked
// saves and the text of every failure a flow can meet. Pure functions: no engine here (m6-panel.test.ts and
// m6-flows.test.ts reach these states for real).
import { describe, expect, it } from "vitest";
import type { SyncFacts } from "../../src/options/sync/gateway";
import {
  cardOf,
  failureText,
  fixable,
  nameProblemKey,
  noticesOf,
  parkedLines,
  railOf,
  roundErrorText,
  summaryText,
  until,
  when,
  type VaultState,
} from "../../src/options/sync/model";
import type { KeyStatus, SyncStatus } from "../../src/core/sync/engine/state";

const NOW = 1_800_000_000_000;
const T = (ms: number) => `T${ms}`;
const on = (p: Partial<SyncFacts> = {}): SyncFacts => ({
  syncOn: true,
  local: "on",
  identity: { state: "enrolled", pinned: true },
  status: "ok",
  keyStatus: "ok",
  lastOkAt: NOW - 120_000,
  lastAttemptAt: NOW - 120_000,
  backoffUntil: null,
  failures: 0,
  lastErrorCode: null,
  pendingEnrollments: 0,
  notices: [],
  parked: null,
  orphans: 0,
  permission: true,
  kept: [],
  rotationOwed: null,
  pendingKeyChange: false,
  ...p,
});
const OWED = { revoked: true, waits: null };
const c = (f: SyncFacts, vault: VaultState = "unlocked") => cardOf(f, vault, NOW, T, "api.example");

/** Every status the engine stores (state.ts SyncStatus), with the card it gets. */
const STATUS: Record<SyncStatus, { id: string; tone: string; actions: string[] }> = {
  off: { id: "starting", tone: "busy", actions: ["sync_now"] },
  ok: { id: "ok", tone: "good", actions: ["sync_now"] },
  offline: { id: "offline", tone: "warn", actions: ["sync_now"] },
  locked: { id: "locked", tone: "info", actions: ["unlock"] },
  error: { id: "error", tone: "warn", actions: ["sync_now"] },
  busy: { id: "busy", tone: "busy", actions: [] },
  needs_password: { id: "needs_password", tone: "warn", actions: ["adopt"] },
  review_needed: { id: "review_needed", tone: "warn", actions: ["review"] },
  remote_unreadable: { id: "remote_unreadable", tone: "danger", actions: ["sync_now"] },
  server_older_key: { id: "server_older_key", tone: "danger", actions: ["repair", "sync_now"] },
  update_required: { id: "update_required", tone: "danger", actions: [] },
  too_large: { id: "too_large", tone: "warn", actions: ["sync_now"] },
  paused_newer: { id: "paused_newer", tone: "warn", actions: ["sync_now"] },
  different_vault: { id: "different_vault", tone: "danger", actions: ["rejoin"] },
  rejected_by_server: { id: "rejected_by_server", tone: "danger", actions: ["sync_now", "remove_identity"] },
  join_unfinished: { id: "join_unfinished", tone: "warn", actions: ["check_again", "start_over"] },
  identity_missing: { id: "identity_missing", tone: "info", actions: ["sync_now"] },
  cloud_restore: { id: "cloud_restore", tone: "danger", actions: ["restore_cloud", "backup", "start_over_vault"] },
  damaged: { id: "damaged", tone: "danger", actions: ["remove_identity"] },
  wrong_origin: { id: "wrong_origin", tone: "danger", actions: ["remove_identity"] },
  permission_removed: { id: "resuming", tone: "busy", actions: ["sync_now"] }, // stored, but Chrome says granted now
};

describe("the card for every status (§6 O12)", () => {
  for (const [status, want] of Object.entries(STATUS)) {
    it(status, () => {
      expect(c(on({ status: status as SyncStatus }))).toMatchObject(want);
    });
  }
  it("each card has a title and its lines from the Sync catalog's keys", () => {
    for (const s of Object.keys(STATUS)) {
      const k = c(on({ status: s as SyncStatus }))!;
      expect(k.title.k).toMatch(/^sync[A-Z]/);
      for (const l of k.lines) expect(l.k).toMatch(/^sync[A-Z]/);
    }
  });
  it("ok says when it last synced, and how many devices wait for approval (P4)", () => {
    const k = c(on({ pendingEnrollments: 2 }))!;
    expect(k.lines).toEqual([
      { k: "syncLastOk", s: [{ k: "syncWhenMinutes", s: [2] }] },
      { k: "syncPendingLine", s: [2] },
    ]);
  });
  it("offline and error say when the next try is, error with the round's code in words", () => {
    expect(c(on({ status: "offline", backoffUntil: NOW + 90_000 }))!.lines.at(-1)).toEqual({
      k: "syncNextMinutes",
      s: [2],
    });
    expect(c(on({ status: "error", lastErrorCode: "rate_limited", backoffUntil: NOW + 5_000 }))!.lines).toEqual([
      { k: "syncErrBusy" },
      { k: "syncNextSoon" },
    ]);
    expect(c(on({ status: "error", lastErrorCode: "teapot" }))!.lines[0]).toEqual({ k: "syncErrCode", s: ["teapot"] });
  });
  it("a first upload that did not finish (an unpinned identity) is told apart from a join that did not", () => {
    expect(c(on({ status: "join_unfinished", identity: { state: "pending", pinned: false } }))).toMatchObject({
      id: "upload_unfinished",
      actions: ["check_again"],
    });
    expect(c(on({ status: "join_unfinished", identity: { state: "pending", pinned: true } }))).toMatchObject({
      id: "join_unfinished",
      actions: ["check_again", "start_over"],
    });
  });
  it("a lost identity: unlock to restore it, or restoring once unlocked", () => {
    expect(c(on({ status: "identity_missing" }), "locked")).toMatchObject({
      id: "identity_missing",
      actions: ["unlock"],
      lines: [{ k: "syncIdentityMissingBody" }],
    });
    expect(c(on({ status: "identity_missing" }), "unlocked")).toMatchObject({
      lines: [{ k: "syncIdentityMissingRestoring" }],
    });
  });
  it("the paused card names the API host", () => {
    expect(c(on({ permission: false }))!.lines).toEqual([{ k: "syncPausedBody", s: ["api.example"] }]);
  });
});

describe("the order: the local side, the permission, the keys, the round", () => {
  it("no sync records: no card (the explanation card)", () => {
    expect(c(on({ syncOn: false, local: "off", status: null }))).toBeNull();
  });
  it("a pending identity never pinned and no configuration (an enrolment in progress elsewhere): no card", () => {
    expect(c(on({ syncOn: false, local: "cfg_missing", identity: { state: "pending", pinned: false } }))).toBeNull();
  });
  it("an unfinished turn-off: finishing; with the vault lost: the cloud restore", () => {
    expect(c(on({ syncOn: false, local: "cfg_missing", identity: { state: "enrolled", pinned: true } }))!.id).toBe(
      "finishing_off",
    );
    expect(
      c(on({ syncOn: false, local: "cfg_missing", identity: { state: "enrolled", pinned: true } }), "lost")!.id,
    ).toBe("cloud_restore");
  });
  it("damaged and lost identities come from the local side, whatever the stored status says", () => {
    expect(c(on({ local: "damaged", status: "ok" }))!.id).toBe("damaged");
    expect(c(on({ local: "identity_missing", syncOn: true, status: "ok" }))!.id).toBe("identity_missing");
  });
  it("the local stops win over the permission (they send nothing, so they need none)", () => {
    for (const s of [
      "identity_missing",
      "cloud_restore",
      "damaged",
      "wrong_origin",
      "join_unfinished",
      "rejected_by_server",
    ] as const)
      expect(c(on({ status: s, permission: false }))!.id, s).not.toBe("permission_removed");
  });
  it("the permission as Chrome says it now: withdrawn shows paused over any other stored status", () => {
    for (const s of ["ok", "offline", "error", "needs_password", "too_large"] as const)
      expect(c(on({ status: s, permission: false }))!.id, s).toBe("permission_removed");
    expect(c(on({ keyStatus: "keys_behind", permission: false }))!.id).toBe("permission_removed");
  });
  it("a vault lost while sync is on: the cloud restore card", () => {
    expect(c(on({ status: "ok" }), "lost")!.id).toBe("cloud_restore");
  });
  const KEY: Record<Exclude<KeyStatus, "ok">, string> = {
    keys_behind: "keys_behind",
    needs_new_password: "needs_new_password",
    rejected: "keys_rejected",
    update_required: "update_required",
  };
  for (const [k, id] of Object.entries(KEY)) {
    it(`the key state ${k} over the round's status`, () => {
      expect(c(on({ keyStatus: k as KeyStatus, status: "ok" }))!.id).toBe(id);
    });
  }
  it("keys_behind says what is paused and that removing devices still works (§3.14, N27)", () => {
    expect(c(on({ keyStatus: "keys_behind" }))!.lines.map((l) => l.k)).toEqual([
      "syncKeysBehindBody",
      "syncKeysBehindPaused",
    ]);
  });
  it("never rounded yet: getting ready", () => {
    expect(c(on({ status: null }))!.id).toBe("starting");
  });
});

describe("the rail's line", () => {
  it("off is null (the rail's own words); ok with when; offline; paused; locked; attention by tone", () => {
    const r = (f: SyncFacts, v: VaultState = "unlocked") => railOf(f, v, NOW, T);
    expect(r(on({ syncOn: false, local: "off" }))).toBeNull();
    expect(r(on())).toEqual({ text: { k: "syncRailOk", s: [{ k: "syncWhenMinutes", s: [2] }] }, tone: "good" });
    expect(r(on({ status: "offline" }))).toEqual({ text: { k: "syncRailOffline" }, tone: "warn" });
    expect(r(on({ permission: false }))).toEqual({ text: { k: "syncRailPaused" }, tone: "warn" });
    expect(r(on({ status: "update_required" }))).toEqual({ text: { k: "syncRailPaused" }, tone: "warn" });
    expect(r(on({ status: "locked" }))).toEqual({ text: { k: "syncRailLocked" }, tone: "none" });
    expect(r(on({ status: "busy" }))).toEqual({ text: { k: "syncRailBusy" }, tone: "none" });
    expect(r(on({ status: "rejected_by_server" }))).toEqual({ text: { k: "syncRailAttention" }, tone: "bad" });
    expect(r(on({ status: "needs_password" }))).toEqual({ text: { k: "syncRailAttention" }, tone: "warn" });
  });
});

describe("times in words", () => {
  it("when: never, just now, minutes, then the date", () => {
    expect(when(null, NOW, T)).toEqual({ k: "syncWhenNever" });
    expect(when(NOW - 30_000, NOW, T)).toEqual({ k: "syncWhenNow" });
    expect(when(NOW + 30_000, NOW, T)).toEqual({ k: "syncWhenNow" }); // a clock a little behind
    expect(when(NOW - 59 * 60_000, NOW, T)).toEqual({ k: "syncWhenMinutes", s: [59] });
    expect(when(NOW - 2 * 3_600_000, NOW, T)).toEqual({ k: "syncWhenAt", s: [T(NOW - 2 * 3_600_000)] });
  });
  it("until: nothing when past, soon, minutes, then the time", () => {
    expect(until(null, NOW, T)).toBeNull();
    expect(until(NOW - 1, NOW, T)).toBeNull();
    expect(until(NOW + 10_000, NOW, T)).toEqual({ k: "syncNextSoon" });
    expect(until(NOW + 10 * 60_000, NOW, T)).toEqual({ k: "syncNextMinutes", s: [10] });
    expect(until(NOW + 2 * 3_600_000, NOW, T)).toEqual({ k: "syncNextAt", s: [T(NOW + 2 * 3_600_000)] });
  });
  it("the round's error codes", () => {
    expect(roundErrorText(null)).toEqual({ k: "syncErrUnknown" });
    for (const [code, k] of [
      ["unavailable", "syncErrServer"],
      ["internal_error", "syncErrServer"],
      ["version_conflict", "syncErrConflict"],
      ["restart_limit", "syncErrConflict"],
      ["malformed_response", "syncErrMalformed"],
      ["write_denied", "syncErrDenied"],
      ["internal", "syncErrInternal"],
    ] as const)
      expect(roundErrorText(code).k, code).toBe(k);
  });
});

describe("notices (§6 P4)", () => {
  it("newest first, kinds this version does not know left out, the deletion banner danger by D6, linked to where the accounts can come back from", () => {
    const list = noticesOf([
      { kind: "device_joined", at: 1 },
      { kind: "deleted_remotely", at: 3, n: 4, danger: true },
      { kind: "something_new" as never, at: 4 },
      { kind: "deleted_remotely", at: 2, n: 5 },
    ]);
    expect(list.map((x) => [x.notice.at, x.tone, x.text.k, x.link ?? null])).toEqual([
      [3, "danger", "syncNoticeDeletedDanger", "backup"], // erased: not in the trash any more
      [2, "warn", "syncNoticeDeleted", "trash"],
      [1, "info", "syncNoticeDeviceJoined", null],
    ]);
  });
  it("every notice kind has its text, and the visible events are not good news (keys taken back, the recovery code's outcome, a device's wrong passwords)", () => {
    const kinds = [
      "rollback",
      "keys_adopted",
      "keys_changed",
      "forked",
      "device_joined",
      "device_revoked",
      "auth_failures",
      "deleted_remotely",
      "recovery_in_effect",
      "recovery_not_in_effect",
      "rev_mismatch",
      "orphan_unreadable",
      "clock_skew",
    ] as const;
    const v = noticesOf(kinds.map((kind, at) => ({ kind, at })));
    expect(v.length).toBe(kinds.length);
    const tone = (k: string) => v.find((x) => x.notice.kind === k)!.tone;
    expect(tone("keys_adopted")).toBe("warn");
    expect(tone("auth_failures")).toBe("danger");
    expect(tone("recovery_not_in_effect")).toBe("danger");
    expect(tone("recovery_in_effect")).toBe("good");
    expect(v.find((x) => x.notice.kind === "keys_adopted")!.text.k).toBe("syncNoticeKeysAdoptedBack");
  });
});

describe("the parked saves (§4.7)", () => {
  it("the count and each reason's way out", () => {
    expect(parkedLines({ count: 2, reasons: ["key", "schema", "too_large", "vault"] })).toEqual({
      title: { k: "syncParkedTitle", s: [2] },
      ways: [{ k: "syncParkedKey" }, { k: "syncParkedSchema" }, { k: "syncParkedTooLarge" }, { k: "syncParkedVault" }],
    });
  });
  it("a reason this version does not know is not left without words", () => {
    expect(parkedLines({ count: 1, reasons: ["toString"] }).ways).toEqual([{ k: "syncParkedTooLarge" }]);
  });
});

describe("a flow's failures", () => {
  it("each code has its words; an unknown one is said with its code; waits in seconds or minutes", () => {
    const codes = [
      "network",
      "offline",
      "wrong_secret",
      "otp_invalid",
      "otp_format",
      "invalid_email",
      "rate_limited",
      "session_invalid",
      "recovery_mismatch",
      "invalid_recovery_code",
      "recovery_not_local",
      "confirm_lost",
      "declined",
      "invalid_device_name",
      "locked",
      "vault_lost",
      "unfinished_wait",
      "already_on",
      "status_failed",
      "rotation_owed",
      "paused_newer",
      "update_required",
      "remote_unreadable",
      "bad_bundle",
      "keyring_changed",
      "one_per_session",
      "gone",
      "join_ended",
      "pairing_mismatch",
      "bad_payload",
      "tampered",
      "cancelled",
      "too_many_devices",
      "busy",
      "unconfirmed",
      "too_large",
      "different_vault",
      "review_needed",
      "stale",
      "bad_mac",
      "device_revoked",
    ];
    for (const code of codes) expect(failureText({ code }).k, code).not.toBe("syncFailOther");
    expect(failureText({ code: "frobnicated" })).toEqual({ k: "syncFailOther", s: ["frobnicated"] });
    expect(failureText({ code: "rate_limited", wait: 30_000 })).toEqual({ k: "syncFailTooManySeconds", s: [30] });
    expect(failureText({ code: "rate_limited", wait: 600_000 })).toEqual({ k: "syncFailTooManyMinutes", s: [10] });
    expect(failureText({ code: "unfinished_wait", wait: 90_000 })).toEqual({ k: "syncFailUnfinishedWait", s: [2] });
  });
  it("what the user fixes in place keeps the flow open; the rest ends it, a lock among them", () => {
    for (const code of [
      "wrong_secret",
      "otp_invalid",
      "session_invalid",
      "recovery_mismatch",
      "invalid_recovery_code",
      "rate_limited",
      "confirm_lost",
    ])
      expect(fixable({ code }), code).toBe(true);
    for (const code of [
      "network",
      "vault_exists",
      "keyring_changed",
      "bad_bundle",
      "tampered",
      "pairing_mismatch",
      "join_ended",
      "bad_payload",
      "gone",
      "unknown",
      "locked",
      "locked_out",
    ])
      expect(fixable({ code }), code).toBe(false);
    expect(failureText({ code: "locked_out" }).k).toBe("syncFailLockedOut");
  });
  it("the join's summary: a count of skipped accounts only where the join could see them (the recovery code); on the approval path, the duplicates go to the trash after the first sync", () => {
    expect(summaryText({ mode: "added", added: 2, skipped: 1 }, "recovery")).toEqual({
      k: "syncSummaryAdded",
      s: [2, 1],
    });
    expect(summaryText({ mode: "added", added: 2, skipped: 0 }, "approval")).toEqual({
      k: "syncSummaryAddedLater",
      s: [2],
    });
    expect(summaryText({ mode: "merged", added: 0, skipped: 0 }, "approval").k).toBe("syncSummaryMerged");
    expect(summaryText({ mode: "lost", added: 0, skipped: 0 }, "recovery").k).toBe("syncSummaryLost");
    expect(summaryText({ mode: "empty", added: 0, skipped: 0 }, "approval").k).toBe("syncSummaryEmpty");
  });
  it("device name problems (§2.4, N28)", () => {
    for (const p of ["not_well_formed", "empty", "too_long", "control_char", "bidi_control", "zero_width"])
      expect(nameProblemKey(p)).toMatch(/^syncName/);
    expect(nameProblemKey("toString")).toBe("syncNameNotWellFormed");
  });
});

describe("the ways out part B adds to the cards (§6 O12)", () => {
  it("keys behind: the repair; a lost vault: the cloud restore first, then a backup, then start over; another vault: rejoin", () => {
    expect(c(on({ keyStatus: "keys_behind" }))!.actions).toEqual(["repair"]);
    expect(c(on({ status: "ok" }), "lost")!.actions).toEqual(["restore_cloud", "backup", "start_over_vault"]);
    expect(c(on({ status: "different_vault" }))!.actions).toEqual(["rejoin"]);
  });
  it("a device revoked as lost and the keys not rotated: a danger card offers the rotation, over the round's status", () => {
    const k = c(on({ rotationOwed: OWED }))!;
    expect([k.id, k.tone, k.actions]).toEqual(["rotation_owed", "danger", ["rotate_keys"]]);
    expect(c(on({ rotationOwed: OWED, status: "offline" }))!.id).toBe("rotation_owed");
    expect(railOf(on({ rotationOwed: OWED }), "unlocked", NOW, T)).toEqual({
      text: { k: "syncRailAttention" },
      tone: "bad",
    });
    // not over what stops sync, the paused permission, the key state, the lock (the rotation needs the open vault), a round
    expect(c(on({ rotationOwed: OWED, status: "damaged" }))!.id).toBe("damaged");
    expect(c(on({ rotationOwed: OWED, permission: false }))!.id).toBe("permission_removed");
    expect(c(on({ rotationOwed: OWED, keyStatus: "keys_behind" }))!.id).toBe("keys_behind");
    expect(c(on({ rotationOwed: OWED, status: "locked" }))!.id).toBe("locked");
    expect(c(on({ rotationOwed: OWED, status: "busy" }))!.id).toBe("busy");
    // it says a device was revoked only when that is on the record, and why the rotation waited
    expect(c(on({ rotationOwed: { revoked: false, waits: null } }))!.lines).toEqual([{ k: "syncRotationOwedUnsure" }]);
    expect(c(on({ rotationOwed: { revoked: true, waits: "update_required" } }))!.lines.map((l) => l.k)).toEqual([
      "syncRotationOwedBody",
      "syncRotationOwedWaits",
      "syncUpdateBody",
    ]);
  });
  it("a key change of this device sent and not confirmed: the locked card offers the master password set on the server", () => {
    expect(c(on({ status: "locked" }), "locked")!.actions).toEqual(["unlock"]);
    const k = c(on({ status: "locked", pendingKeyChange: true }), "locked")!;
    expect(k.actions).toEqual(["unlock", "adopt"]);
    expect(k.lines.map((l) => l.k)).toContain("syncLockedPendingBody");
  });
  it("a profile that looks like a copy of another one: the notice offers making it a device of its own", () => {
    expect(noticesOf([{ kind: "forked", at: 1 }]).map((n) => n.act ?? null)).toEqual(["fork"]);
    expect(noticesOf([{ kind: "device_joined", at: 1 }]).map((n) => n.act ?? null)).toEqual([null]);
  });
});
