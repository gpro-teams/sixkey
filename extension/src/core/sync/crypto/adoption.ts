// §3.9 adoption rules, §4.2 step 2 and the §3.14 operation gate as pure decisions over facts. bundle-eval.ts and
// presend.ts establish the facts with crypto; M3 applies the outcomes (staged bundle, transact, session, pins).
// Nothing here reads storage, the network or the clock. R0 (MAC and vaultId first) is the callers' job: every function
// here assumes the bundle it is told about has passed it, which is why classifyKver is not in the public index.
import { SYNC_CONSTANTS as C } from "./constants";
import { SyncCryptoError } from "./errors";

// ---- R1 (N27) with the R0 jump cap (F-01) --------------------------------------------------------------------------

/**
 * adopt_candidate: newer than anything this device saw and different; R2/R3 decide, and maxSeenKver becomes
 * maxSeenAfterAdoption only once it is adopted. in_sync: same keyring; store maxSeenAfter. keys_behind: at or below what
 * this device saw and different (honest rollback, lagging publisher or replay; indistinguishable): never adopted silently,
 * no "take the server's" action, the only way out is repairing the cloud from this device.
 */
export type KverClass =
  | { outcome: "adopt_candidate"; maxSeenAfterAdoption: number }
  | { outcome: "in_sync" | "keys_behind"; maxSeenAfter: number };

/**
 * R0/R1. A jump of more than KVER_MAX_JUMP over a known maxSeenKver is treated as kver <= maxSeenKver: it cannot raise
 * maxSeenKver, and different content is keys_behind (whose repair always publishes). Not a hard refusal, so a device that
 * missed several maximal jumps while offline can still repair. maxSeenKver = 0 (identity just restored) has no cap.
 */
export function classifyKver(bundleKver: number, maxSeenKver: number, sameKeyring: boolean): KverClass {
  if (!Number.isSafeInteger(bundleKver) || bundleKver < 1 || !Number.isSafeInteger(maxSeenKver) || maxSeenKver < 0)
    throw new SyncCryptoError("invalid_argument", "bad kver");
  const newer = bundleKver > maxSeenKver && (maxSeenKver === 0 || bundleKver - maxSeenKver <= C.KVER_MAX_JUMP);
  if (newer)
    return sameKeyring
      ? { outcome: "in_sync", maxSeenAfter: bundleKver }
      : { outcome: "adopt_candidate", maxSeenAfterAdoption: bundleKver };
  return { outcome: sameKeyring ? "in_sync" : "keys_behind", maxSeenAfter: maxSeenKver };
}

// ---- P3: previous containment (F-02, S-5) --------------------------------------------------------------------------

/** One previous entry, in list order. Only the id matters: "oldest" means first in the list (§3.8, S-5). */
export type PreviousRef = { vkId: string };

/**
 * The bundle's previous list must keep every real local entry (§3.9 R2/R3). Both sides count only entries that really
 * unwrap (M1-2, M1-2b), so `remoteIds` are unwrapped ids and `local` the local entries that unwrap, in list order.
 * Same VK: no exception at all (no honest same-VK operation changes previous). Another VK (a rotation): only when the
 * new list has exactly 64 real entries may it lack a leading run of the local list, of any length: what capPrevious
 * drops over one or more rotations.
 */
export function previousCovers(
  local: readonly PreviousRef[],
  remoteIds: ReadonlySet<string>,
  sameVk: boolean,
): boolean {
  const missing = local.map((p) => !remoteIds.has(p.vkId));
  if (!missing.includes(true)) return true;
  if (sameVk || remoteIds.size !== C.KEYRING_PREVIOUS_MAX) return false;
  const firstKept = missing.indexOf(false);
  return firstKept === -1 || !missing.slice(firstKept).includes(true);
}

// ---- R2: same VK, this device unlocked -----------------------------------------------------------------------------

export type SameVkFacts = {
  macValid: boolean;
  previousCovers: boolean;
  passwordWrapSame: boolean; // the bundle's password wrap equals the local one byte for byte
  authSame: boolean | null; // equals adopted.auth (the auth that came with the local password wrap); null only right after an identity restore
};

/**
 * GM2-5 (§0.0i "M1 code changes" 1, 2): the bundle's digest is the identity's adopted.digest, the state this device
 * itself last committed, while the local keyring differs (a local commit lost to a power loss, the pins written). Its
 * content counts as the same: it is not keys_behind and not a password to prove again; it is adopted back.
 */
export type AdoptedBack = { adoptedBack: boolean };

export type BundleRejection =
  "bad_mac" | "wrong_vault" | "previous_dropped" | "auth_without_password" | "discontinuous";

export type SameVkDecision =
  | { kind: "adopt" } // only the recovery wrap changed: adopt now
  | { kind: "needs_new_password" } // keep the local password wrap until the user's password opens the new one
  | { kind: "reject"; reason: BundleRejection };

/** R2. A device only drops a password wrap it has proven usable once the user proves the replacement on this device. */
export function decideSameVk(f: SameVkFacts): SameVkDecision {
  if (!f.macValid) return { kind: "reject", reason: "bad_mac" };
  if (!f.previousCovers) return { kind: "reject", reason: "previous_dropped" };
  if (f.passwordWrapSame && f.authSame === false) return { kind: "reject", reason: "auth_without_password" };
  return f.passwordWrapSame ? { kind: "adopt" } : { kind: "needs_new_password" };
}

export type SameVkVerdict =
  | { kind: "in_sync" | "keys_behind"; maxSeenKver: number }
  | { kind: "adopt"; maxSeenKver: number } // write bundle.keyring locally first, then store maxSeenKver and adopted
  | { kind: "needs_new_password"; maxSeenKverOnAdoption: number }
  | { kind: "reject"; reason: BundleRejection };

/**
 * R0, R1 then R2 for a bundle under the VK this unlocked device holds. vaultId and MAC come first: a bundle that fails
 * them is never classified, so it cannot raise maxSeenKver or show keys_behind. In sync with a known adopted.auth that
 * differs from the bundle's is an auth-only change (F-07).
 */
export function sameVkVerdict(
  f: SameVkFacts & AdoptedBack & { vaultOk: boolean; bundleKver: number; maxSeenKver: number; sameKeyring: boolean },
): SameVkVerdict {
  if (!f.vaultOk) return { kind: "reject", reason: "wrong_vault" };
  if (!f.macValid) return { kind: "reject", reason: "bad_mac" };
  // "The same content": the local keyring, or the one this device last committed (adopted.digest), §0.0i M1 change 1.
  const k = classifyKver(f.bundleKver, f.maxSeenKver, f.sameKeyring || f.adoptedBack);
  if (k.outcome === "in_sync" && f.authSame === false) return { kind: "reject", reason: "auth_without_password" };
  if (f.adoptedBack && !f.sameKeyring) {
    // Adopted back at once (change 2): this device committed this very password wrap; the history check still holds.
    if (!f.previousCovers) return { kind: "reject", reason: "previous_dropped" };
    return { kind: "adopt", maxSeenKver: k.outcome === "adopt_candidate" ? k.maxSeenAfterAdoption : k.maxSeenAfter };
  }
  if (k.outcome !== "adopt_candidate") return { kind: k.outcome, maxSeenKver: k.maxSeenAfter };
  const d = decideSameVk(f);
  if (d.kind === "reject") return d;
  return d.kind === "adopt"
    ? { kind: "adopt", maxSeenKver: k.maxSeenAfterAdoption }
    : { kind: "needs_new_password", maxSeenKverOnAdoption: k.maxSeenAfterAdoption };
}

// ---- R3 / R4 / R6: unlocking ---------------------------------------------------------------------------------------

/** R4: in needs_password the remote bundle is tried first, even when the local wrap would open (one password, rotated). */
export function unlockOrder(needsPassword: boolean, hasRemote: boolean): ("local" | "remote")[] {
  if (!hasRemote) return ["local"];
  return needsPassword ? ["remote", "local"] : ["local", "remote"];
}

export type RemoteUnlockFacts = {
  vaultOk: boolean;
  macValid: boolean; // under the VK the secret opened
  kver: KverClass["outcome"];
  confirmedOlder: boolean; // the user chose to go back to an older key state (N27)
  vkIsPinned: boolean;
  reachesPinned: boolean; // another VK whose previous list unwraps the pinned VK (continuity)
  reachesLocal: boolean; // no local keyring, its VK, or a previous list that really unwraps the local keyring's VK (GM2-5)
  previousCovers: boolean;
  authOk: boolean; // auth changed only together with the password wrap, and not at all when in sync
};

export type RemoteUnlockDecision =
  | { kind: "adopt"; sameVk: boolean }
  | { kind: "confirm_older" } // ask "[use my current password] [adopt anyway]", then decide again with confirmedOlder
  | { kind: "reject"; reason: BundleRejection };

/**
 * R3 after the secret opened the remote bundle. Every rule is checked before the user is asked to confirm an older
 * state, so the question is never asked about a bundle that would be refused anyway. An old VK (for example a revoked
 * device's forged VK1 bundle) fails continuity: its previous list cannot unwrap the pinned VK2.
 */
export function decideRemoteUnlock(f: RemoteUnlockFacts): RemoteUnlockDecision {
  if (!f.vaultOk) return { kind: "reject", reason: "wrong_vault" };
  if (!f.macValid) return { kind: "reject", reason: "bad_mac" };
  if (!f.vkIsPinned && !f.reachesPinned) return { kind: "reject", reason: "discontinuous" };
  // The local data is under the local keyring's VK: an adoption that cannot open it cannot merge it (§3.9 R3, GM2-5).
  if (!f.reachesLocal) return { kind: "reject", reason: "discontinuous" };
  if (!f.previousCovers) return { kind: "reject", reason: "previous_dropped" };
  if (!f.authOk) return { kind: "reject", reason: "auth_without_password" };
  if (f.kver === "keys_behind" && !f.confirmedOlder) return { kind: "confirm_older" };
  return { kind: "adopt", sameVk: f.vkIsPinned };
}

/** What the server's bundle means once the local keyring opened. */
export type RemoteRelation = "none" | "same_vk" | "older_vk" | "other_vk";
export type LocalUnlockFacts = {
  remote: RemoteRelation;
  macValid: boolean;
  kver: KverClass["outcome"] | null;
  passwordWrapSame: boolean;
};
export type LocalUnlockNote =
  | "none"
  | "enter_new_password" // R2: the password changed on another device; the banner asks for the new one
  | "keys_behind" // N27 panel
  | "remote_rotated" // R4: needs_password
  | "server_older_key" // §4.2 step 2: the server is back on a VK in this device's previous list
  | "pin_ahead"; // D8's second direction (GM2-5): the pin is a key the local keyring cannot reach; needs_password

export function noteAfterLocalUnlock(f: LocalUnlockFacts): LocalUnlockNote {
  switch (f.remote) {
    case "none":
      return "none";
    case "other_vk":
      return "remote_rotated";
    case "older_vk":
      return "server_older_key";
    case "same_vk":
      if (!f.macValid) return "none"; // a forged or foreign bundle changes nothing; the sync round reports it
      if (f.kver === "keys_behind") return "keys_behind";
      return f.kver === "adopt_candidate" && !f.passwordWrapSame ? "enter_new_password" : "none";
  }
}

/**
 * D8: the keyring was written but the pin update did not happen (crash). If the local keyring's previous list unwraps
 * the pinned VK, the pin moves forward. Without a pin (identity restored from the copy, §2.5) the local keyring is the
 * reference. Otherwise the pin stays: a local keyring behind the pin is never a reason to go back.
 */
export function pinAfterUnlock(
  pinned: string | null,
  localVkId: string,
  localPreviousIds: ReadonlySet<string>,
): string {
  if (pinned === null || pinned === localVkId) return localVkId;
  return localPreviousIds.has(pinned) ? localVkId : pinned;
}

/** §4.2 step 2: the server's vk_id against the pinned VK. */
export function classifyServerVk(
  serverVkId: string,
  pinnedVkId: string,
  localPreviousIds: ReadonlySet<string>,
): "current" | "older" | "rotated" {
  if (serverVkId === pinnedVkId) return "current";
  return localPreviousIds.has(serverVkId) ? "older" : "rotated";
}

// ---- §3.14: which sensitive operations wait in keys_behind ---------------------------------------------------------

export type SensitiveOp =
  | "change_password"
  | "change_recovery"
  | "recovery_reset"
  | "rotate"
  | "repair" // publish a bundle
  | "respond"
  | "approve" // hand a bundle to a new device
  | "revoke"
  | "reject"
  | "reject_all"
  | "rename"
  | "fork"
  | "clear_history"
  | "delete_account";

const PUBLISHES: ReadonlySet<SensitiveOp> = new Set([
  "change_password",
  "change_recovery",
  "recovery_reset",
  "rotate",
  "repair",
]);
const HANDS_OUT: ReadonlySet<SensitiveOp> = new Set(["respond", "approve"]);

export const publishesBundle = (op: SensitiveOp): boolean => PUBLISHES.has(op);

/**
 * N27, §3.14: while the server's key state is older than this device's, only operations that publish or hand out a
 * bundle wait for the repair (which is itself allowed); `respond` waits with `approve` (M1-4). Revocation never waits.
 */
export function allowedWhileKeysBehind(op: SensitiveOp): boolean {
  return op === "repair" || (!PUBLISHES.has(op) && !HANDS_OUT.has(op));
}
