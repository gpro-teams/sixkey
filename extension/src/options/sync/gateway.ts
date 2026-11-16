// The Sync section's one door to sync (SYNC-DESIGN §6; M6): everything the section uses of src/core/sync, of the service's
// sync flows and of the platform's sync wiring comes through this module, so the rest of the section is views and plain
// logic, and the source rules name exactly one module of the settings page that reaches sync
// (test/unit/sync-crypto-hygiene.test.ts, m2-source-rules, m3-source-rules).
//
// The engine runs in the settings page exactly as SYNC-DESIGN §4.9 describes and M5 wired it: built over the page's own
// runtime (never a second one: in "lock every time" the vault key exists only in that runtime's session), signing its own
// requests, and handing each finished request to the service worker through the bridge (platform/bridge-page.ts). The
// page itself cannot reach any host (its own connect-src 'none').
//
// What the section keeps in memory and nowhere else: the account session of a flow (§4.9), a review answer (§4.4), a
// prepared join or recovery code (until it is committed or abandoned). Nothing here logs; errors carry codes only.
import { unlockWithRecoveryCode } from "../../core/crypto/keyring";
import type { VaultService } from "../../core/service/service";
import {
  MergeBlocked,
  type MergeAnswer,
  type PreparedJoin,
  type PreparedRecovery,
} from "../../core/service/sync-flows";
import { checkDeviceName, type DeviceNameProblem } from "../../core/sync/crypto/device-name";
import { ApiError, type AccountSession } from "../../core/sync/engine/api";
import type { SyncEngine } from "../../core/sync/engine/engine";
import { listDevices, revokedBeforeRestore, type DeviceRow } from "../../core/sync/engine/devices";
import {
  ApprovalJoin,
  Approver,
  commitJoin,
  EnrollError,
  firstUpload,
  joinSummary,
  joinWithRecoveryCode,
  resumeFirstUpload,
  type FirstUploadResult,
  type JoinPlan,
  type NewDeviceStatus,
} from "../../core/sync/engine/enroll";
import {
  adoptWithSecret,
  changePassword,
  clearServerHistory,
  commitRecoveryCode,
  commitRecoveryReset,
  commitRotation,
  deleteSyncAccount,
  forkDevice,
  KeyOpError,
  noteRotationOwed,
  prepareRecoveryCode,
  prepareRecoveryReset,
  prepareRotation,
  rejectAllRequests,
  removeSyncIdentity,
  renameDevice,
  repairKeys,
  revokeDevice,
  revokeNeedsProtect,
  turnSyncOff,
  type AdoptResult,
  type OwedRotation,
  type PreparedCode,
  type PreparedRecoveryReset,
  type PreparedRotation,
} from "../../core/sync/engine/keys";
import {
  dropFound,
  findSources,
  openFound,
  recoverFound,
  type FindSource,
  type FindSources,
  type Found,
  type FoundAccount,
} from "../../core/sync/engine/find";
import {
  discardParkedOrphans,
  foldParkedLocally,
  parkedSummary,
  type ParkedSummary,
} from "../../core/sync/engine/orphans";
import type { KeyStatus, Notice, NoticeKind, SyncStatus } from "../../core/sync/engine/state";
import { NetworkError } from "../../core/sync/engine/transport";
import type { GuardReport } from "../../core/sync/local/guard";
import { SYNC_KEYS } from "../../core/sync/local/keys";
import { keptId, PrejoinWriter } from "../../core/sync/local/record-writers";
import { parsePrejoin, prejoinItems } from "../../core/sync/local/records";
import { API_ORIGIN } from "../../platform/api-origin";
import {
  apiPermissionGranted,
  removeApiPermission,
  requestApiPermission,
  type PermissionsLike,
} from "../../platform/api-permission";
import { BridgeTransport, SYNC_CHANGED_MESSAGE } from "../../platform/bridge-page";
import { armClipboardClear } from "../../platform/clipboard";
import type { Runtime } from "../../platform/runtime";
import { createSyncEngine } from "../../platform/sync-engine";

export {
  ApprovalJoin,
  adoptWithSecret,
  commitJoin,
  checkDeviceName,
  discardParkedOrphans,
  firstUpload,
  foldParkedLocally,
  joinSummary,
  joinWithRecoveryCode,
  MergeBlocked,
  removeSyncIdentity,
  resumeFirstUpload,
  turnSyncOff,
};
export type {
  AccountSession,
  AdoptResult,
  DeviceNameProblem,
  FirstUploadResult,
  GuardReport,
  JoinPlan,
  KeyStatus,
  MergeAnswer,
  NewDeviceStatus,
  Notice,
  NoticeKind,
  ParkedSummary,
  PreparedJoin,
  PreparedRecovery,
  SyncStatus,
};
// what managing a sync account that is on uses (devices.ts, approve.ts, keyops.ts, revoke.ts and the rest)
export {
  Approver,
  changePassword,
  clearServerHistory,
  commitRecoveryCode,
  commitRecoveryReset,
  commitRotation,
  deleteSyncAccount,
  forkDevice,
  listDevices,
  noteRotationOwed,
  prepareRecoveryCode,
  prepareRecoveryReset,
  prepareRotation,
  rejectAllRequests,
  renameDevice,
  repairKeys,
  revokedBeforeRestore,
  revokeDevice,
  revokeNeedsProtect,
};
export type { DeviceRow, OwedRotation, PreparedCode, PreparedRecoveryReset, PreparedRotation };
// finding accounts in an earlier version (find.ts, §6 O13)
export { dropFound, findSources, openFound, recoverFound };
export type { FindSource, FindSources, Found, FoundAccount };

/** What the section's controllers need of a context that syncs. The page's is kitFor(rt); tests build one over a test world. */
export type SyncKit = {
  service: VaultService;
  engine: SyncEngine;
  /** chrome.permissions (the API host permission, platform/api-permission.ts). */
  perm: PermissionsLike;
  /** The worker brings the badge and its periodic alarm up to date (bridge-page.ts SYNC_CHANGED_MESSAGE). */
  changed(): void;
  /** Copy on an explicit click, with the clipboard's clean-up armed when the user allowed it (platform/clipboard.ts). */
  copy(text: string): Promise<boolean>;
  /** What `copy` put there is no longer needed: cleared now if the clipboard still holds it (when the user allowed it). */
  uncopy(text: string): void;
};

const kits = new WeakMap<Runtime, SyncKit>();

/** The settings page's kit: one engine per page, over the page's own runtime (M5-NOTES §12 item 2). */
export function kitFor(rt: Runtime): SyncKit {
  let k = kits.get(rt);
  if (!k) {
    const { engine } = createSyncEngine({ rt, transport: new BridgeTransport() });
    k = {
      service: rt.service,
      engine,
      perm: chrome.permissions as unknown as PermissionsLike,
      changed: () => void chrome.runtime.sendMessage({ type: SYNC_CHANGED_MESSAGE }).catch(() => undefined),
      copy: async (text) => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          return false; // the text is on screen to copy by hand
        }
        await armClipboardClear(text);
        return true;
      },
      uncopy: (text) => void armClipboardClear(text, 0).catch(() => false),
    };
    kits.set(rt, k);
  }
  return k;
}

// ---- the API host permission (§4.9, §7; revisions 21 and 23) ---------------------------------------------------------

/** The host Chrome's prompt names (api.sixkey.app in the store build): the section says it in the same words. */
export const API_HOST = new URL(API_ORIGIN).host;

/** Chrome's prompt; must be the first statement of the click handler (permission.ts says why). */
export const askPermission = (kit: SyncKit): Promise<boolean> => requestApiPermission(kit.perm);
export const holdsPermission = (kit: SyncKit): Promise<boolean> => apiPermissionGranted(kit.perm);
export const dropPermission = (kit: SyncKit): Promise<boolean> => removeApiPermission(kit.perm);

// ---- what the panel shows (§6 O12) -------------------------------------------------------------------------------

/** The local side of sync as the panel needs it, read in one go (none of it holds a key or an account name). */
export type SyncFacts = {
  syncOn: boolean;
  local: "off" | "on" | "identity_missing" | "cfg_missing" | "damaged";
  /** The identity's state; `pinned`: it has pins (a first upload's pending identity has none until it is confirmed). */
  identity: { state: "pending" | "enrolled" | "rejected_by_server"; pinned: boolean } | null;
  status: SyncStatus | null;
  keyStatus: KeyStatus | null;
  lastOkAt: number | null;
  lastAttemptAt: number | null;
  backoffUntil: number | null;
  failures: number;
  /** The contract's or the engine's code of the last failure: a short snake_case word at most (api.ts). */
  lastErrorCode: string | null;
  pendingEnrollments: number;
  notices: Notice[];
  parked: ParkedSummary | null;
  /** How many saves the orphan list keeps (§4.7), parked or not: with sync off, the page's unlock folds them. */
  orphans: number;
  /** The API host permission as Chrome says now (the stored status changes only with the next round, M5-NOTES §9 item 11). */
  permission: boolean;
  /**
   * A "lost" revocation owes a rotation (§3.10; state.ts rotationOwed): `revoked`, whether a revocation of that run is
   * on the record (otherwise it may not have finished); `waits`, why the rotation could not be prepared then. null: none
   * owed, or a rotation adopted from another device came after the revocation and makes it moot.
   */
  rotationOwed: { revoked: boolean; waits: string | null } | null;
  /**
   * A key change of this device (a new recovery code, a new master password set with the recovery code) is recorded as
   * sent and not yet confirmed (§3.6.0 pendingRecoveryWrap): if the page closed before its local commit, the master
   * password set on the server may be the only one that opens it (the locked card offers that, model.ts).
   */
  pendingKeyChange: boolean;
  /** The vaults this profile kept from before its joins (sk_prejoin's list, §3.5 ④): what "Advanced" shows and deletes. */
  kept: KeptVault[];
};

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

export async function readFacts(kit: SyncKit): Promise<SyncFacts> {
  const [view, local, permission, prejoin] = await Promise.all([
    kit.engine.view(),
    kit.engine.deps.local.status().catch(() => ({ kind: "damaged" as const, what: "identity" as const })),
    apiPermissionGranted(kit.perm),
    keptVaults(kit),
  ]);
  const s = view.state;
  const id = local.kind === "on" || local.kind === "cfg_missing" ? local.identity : null;
  return {
    syncOn: view.syncOn,
    local: local.kind,
    identity: id ? { state: id.state, pinned: id.vkId !== null || id.adopted !== null } : null,
    status: s.status ?? null,
    keyStatus: s.keyStatus ?? null,
    lastOkAt: num(s.lastOkAt),
    lastAttemptAt: num(s.lastAttemptAt),
    backoffUntil: num(s.backoffUntil),
    failures: num(s.failures) ?? 0,
    lastErrorCode:
      typeof s.lastErrorCode === "string" && /^[a-z_]{1,40}$/.test(s.lastErrorCode) ? s.lastErrorCode : null,
    pendingEnrollments: num(s.pendingEnrollments) ?? 0,
    notices: Array.isArray(s.notices)
      ? s.notices.filter((n) => n && typeof n.kind === "string" && typeof n.at === "number")
      : [],
    parked: parkedSummary(view.orphans),
    orphans: view.orphans.length,
    permission,
    kept: prejoin,
    rotationOwed: owedOf(s.rotationOwed, local.kind === "on" ? local.identity : null),
    pendingKeyChange: isObject(s.pendingRecoveryWrap),
  };
}

/**
 * The owed rotation as the page shows it. Moot once this device holds keys of a rotation that came after the revocation:
 * another key than the server had just after it, at a higher kver (a rotation from before it the device could have seen).
 */
function owedOf(x: unknown, id: { vkId: string | null; maxSeenKver: number } | null): SyncFacts["rotationOwed"] {
  if (!isObject(x) || typeof x.vkId !== "string") return null;
  const revoked = x.revoked === true;
  const after =
    isObject(x.after) && typeof x.after.vkId === "string" && typeof x.after.kver === "number" ? x.after : null;
  if (revoked && after && id && id.vkId !== null && id.vkId !== after.vkId && id.maxSeenKver > (after.kver as number))
    return null;
  return { revoked, waits: typeof x.waits === "string" && /^[a-z_]{1,40}$/.test(x.waits) ? x.waits : null };
}

/** A kept vault as the page shows it: its id on the list (keptId), and when it was kept (null: an entry that can't be read). */
export type KeptVault = { id: string; at: number | null };

/** sk_prejoin's entries, as stored (never decrypted here); none when it cannot be read. */
async function keptVaults(kit: SyncKit): Promise<KeptVault[]> {
  try {
    const items = prejoinItems((await kit.engine.deps.kv.get([SYNC_KEYS.prejoin]))[SYNC_KEYS.prejoin]) ?? [];
    return await Promise.all(
      items.map(async (x) => {
        const p = parsePrejoin(x);
        return { id: await keptId(x), at: p === "damaged" ? null : p.at };
      }),
    );
  } catch {
    return [];
  }
}

/**
 * The kept vaults the user confirmed, deleted: exactly those shown (record-writers.ts PrejoinWriter.discard). It cannot be
 * undone, so the master password first (VaultService.requireMasterPassword: wrong_secret, recorded, deletes nothing).
 */
export const discardKept = async (kit: SyncKit, shown: readonly KeptVault[], password: string): Promise<number> => {
  await kit.service.requireMasterPassword(password);
  return new PrejoinWriter(kit.engine.deps.kv, kit.engine.deps.vaultLock).discard(shown.map((k) => k.id));
};

/** The notices the user has seen, removed (state.ts dismissNotices). Not the security record, which only the popup acknowledges. */
export const dismissNotices = (kit: SyncKit, shown: readonly Notice[]): Promise<void> =>
  kit.engine.state.dismissNotices(shown);

/**
 * The parked entries the user confirmed, deleted ("Advanced", §4.7): both the count and the checksums shown. It cannot be
 * undone, so the master password first, as for the kept vaults.
 */
export const discardParked = async (kit: SyncKit, shown: ParkedSummary, password: string): Promise<number> => {
  await kit.service.requireMasterPassword(password);
  return discardParkedOrphans(
    { kv: kit.engine.deps.kv, vaultLock: kit.engine.deps.vaultLock },
    { count: shown.count, checksums: shown.checksums },
  );
};

/** With sync off, at every unlock of this page: the kept entries folded into the vault here (M3-NOTES §10 item 15). */
export const foldKeptLocally = (kit: SyncKit, answer?: MergeAnswer) =>
  foldParkedLocally(
    {
      flows: kit.engine.deps.flows,
      kv: kit.engine.deps.kv,
      vaultLock: kit.engine.deps.vaultLock,
      now: kit.engine.deps.now,
    },
    answer,
  );

// ---- the flows' local steps ------------------------------------------------------------------------------------

/** Whether the typed recovery code opens this profile's own keyring (§3.1 step 4 (a)); nothing is written. */
export async function recoveryOpensLocal(kit: SyncKit, code: string): Promise<boolean> {
  const cur = await kit.engine.deps.flows.current();
  try {
    return (await unlockWithRecoveryCode(cur.gen.keyring, code)).id === cur.vk.id;
  } catch {
    return false;
  }
}

/** §3.1 step 4 (b): a new recovery code made in memory (show before commit), then written once the user has saved it. */
export const prepareRecovery = (kit: SyncKit, password: string): Promise<PreparedRecovery> =>
  kit.engine.deps.flows.prepareUploadRecovery(password);
export const commitRecovery = (kit: SyncKit, handle: PreparedRecovery): Promise<void> =>
  kit.engine.deps.flows.commitUploadRecovery(handle);

/** What this profile's vault is now: "ok", none ("empty") or unreadable ("lost"). */
export const vaultStatus = (kit: SyncKit) => kit.engine.deps.flows.vaultStatus();

// ---- errors -------------------------------------------------------------------------------------------------------

/** A failure as the section tells it: a fixed code, and for some a number (seconds or ms) to say how long to wait. */
export type Failure = {
  code: string;
  wait?: number;
  blocked?: { report: GuardReport; seen: Readonly<Record<string, string>> };
};

const IDENT = /^[a-z][a-z0-9_]{0,40}$/;

/** Every error the section can meet, as a Failure: never its message (which could carry anything). */
export function failureOf(e: unknown): Failure {
  if (e instanceof MergeBlocked) return { code: "review_needed", blocked: { report: e.report, seen: e.seen } };
  if (e instanceof NetworkError) return { code: "network" };
  if (e instanceof ApiError)
    return {
      code: IDENT.test(e.code) ? e.code : "server",
      ...(e.details.retry_after !== undefined ? { wait: e.details.retry_after * 1000 } : {}),
    };
  if (e instanceof EnrollError)
    return {
      code: IDENT.test(e.code) ? e.code : "unknown",
      ...(e.retryAfterMs !== undefined ? { wait: e.retryAfterMs } : {}),
    };
  if (e instanceof KeyOpError) return { code: IDENT.test(e.code) ? e.code : "unknown" };
  const code = e instanceof Error ? (e as { code?: unknown }).code : undefined;
  return { code: typeof code === "string" && IDENT.test(code) ? code : "unknown" };
}
