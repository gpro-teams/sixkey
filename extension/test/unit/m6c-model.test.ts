// M6C, what the Sync section shows (src/options/sync/model.ts) for what M6C adds: every card that pauses sync has a way
// out (SYNC-DESIGN §9 M8 item 17: server_older_key now repairs the cloud from this device); the notices of accounts
// another device deleted offer finding them (§6 P4 "[找回]", O13); the approval join's duplicates moved to the trash are
// said once, pointing to the trash; the approval join's summary says that the duplicates go to the trash.
import { describe, expect, it } from "vitest";
import type { SyncFacts } from "../../src/options/sync/gateway";
import { cardOf, noticesOf, summaryText } from "../../src/options/sync/model";
import type { KeyStatus, SyncStatus } from "../../src/core/sync/engine/state";

const NOW = 1_800_000_000_000;
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
const card = (f: SyncFacts) => cardOf(f, "unlocked", NOW, (ms) => `T${ms}`, "api.example")!;

const STATUSES: SyncStatus[] = [
  "off",
  "ok",
  "offline",
  "locked",
  "error",
  "busy",
  "needs_password",
  "review_needed",
  "remote_unreadable",
  "server_older_key",
  "update_required",
  "too_large",
  "paused_newer",
  "different_vault",
  "rejected_by_server",
  "join_unfinished",
  "identity_missing",
  "cloud_restore",
  "damaged",
  "wrong_origin",
  "permission_removed",
];
const KEY_STATES: KeyStatus[] = ["needs_new_password", "keys_behind", "rejected", "update_required"];

describe("every card that pauses sync has a way out (§9 M8 item 17)", () => {
  it("each warning or danger card offers an action, but for the one whose way out is outside Sixkey (an update)", () => {
    const cards = [
      ...STATUSES.map((s) => card(on({ status: s }))),
      ...KEY_STATES.map((k) => card(on({ keyStatus: k }))),
      card(on({ rotationOwed: { revoked: true, waits: null } })),
    ];
    // update_required: Chrome updates Sixkey by itself (chrome://extensions' Update does it now); the store link the
    // card is to carry waits for the store ID (M6-NOTES §6 item 6), not for this card
    const without = cards.filter((c) => (c.tone === "warn" || c.tone === "danger") && c.actions.length === 0);
    expect(without.map((c) => c.id)).toEqual(["update_required", "update_required"]);
  });
  it("server_older_key: repair the cloud from this device, then Sync now (a repair from another device clears it)", () => {
    const c = card(on({ status: "server_older_key" }));
    expect(c.actions).toEqual(["repair", "sync_now"]);
    expect(c.lines.map((l) => l.k)).toEqual(["syncOlderKeyBody", "syncRepairPending"]);
  });
});

describe("the notices M6C adds to", () => {
  it("accounts another device deleted: finding them is offered beside the trash, and beside the backups when they were erased (D6)", () => {
    const [warn, danger] = [false, true].map((d) =>
      noticesOf([{ kind: "deleted_remotely", at: NOW, n: 4, danger: d }]),
    );
    expect(warn![0]).toMatchObject({ tone: "warn", link: "trash", act: "find", text: { k: "syncNoticeDeleted" } });
    expect(danger![0]).toMatchObject({
      tone: "danger",
      link: "backup",
      act: "find",
      text: { k: "syncNoticeDeletedDanger" },
    });
  });
  it("the approval join's duplicates moved to the trash: said once, with how many, pointing to the trash", () => {
    expect(noticesOf([{ kind: "duplicates_trashed", at: NOW, n: 3 }])).toEqual([
      {
        notice: { kind: "duplicates_trashed", at: NOW, n: 3 },
        tone: "info",
        text: { k: "syncNoticeDuplicates", s: [3] },
        link: "trash",
      },
    ]);
  });
  it("the approval join's summary: the duplicates go to the trash after the first sync; no count of skipped ones", () => {
    expect(summaryText({ mode: "added", added: 5, skipped: 0 }, "approval")).toEqual({
      k: "syncSummaryAddedLater",
      s: [5],
    });
  });
});
