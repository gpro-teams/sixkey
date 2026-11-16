// The crypto that establishes the facts adoption.ts decides on: vaultId and MAC checks (R0), which previous VKs really
// unwrap, and which keyring the typed secret opens. Pure over its inputs (WebCrypto only); M3 stores the outcome.
import { CryptoError } from "../../crypto/bytes";
import { unlockWithPassword, unlockWithRecoveryCode, unwrapPreviousVks, type Keyring } from "../../crypto/keyring";
import type { Vk } from "../../crypto/vk";
import {
  classifyKver,
  decideRemoteUnlock,
  noteAfterLocalUnlock,
  pinAfterUnlock,
  previousCovers,
  sameVkVerdict,
  unlockOrder,
  type BundleRejection,
  type LocalUnlockNote,
  type PreviousRef,
  type RemoteRelation,
  type SameVkVerdict,
} from "./adoption";
import { issue } from "./capability";
import { canonicalJsonStrict } from "./encoding";
import { SyncCryptoError } from "./errors";
import {
  adoptedRecord,
  sameKeyring,
  sameWrap,
  verifyBundleMac,
  wrapOf,
  type BundleAuth,
  type KeyBundle,
} from "./keybundle";

export type UnlockSecret = { password: string } | { recoveryCode: string };

/**
 * The VK if the secret opens this keyring, null if it does not. A malformed recovery code or an empty password is
 * thrown (Phase 0 CryptoError: recovery_length / recovery_char / recovery_checksum / empty_password): that is a typo to
 * fix, not a wrong secret.
 */
export async function openKeyring(kr: Keyring, secret: UnlockSecret): Promise<Vk | null> {
  try {
    return "password" in secret
      ? await unlockWithPassword(kr, secret.password)
      : await unlockWithRecoveryCode(kr, secret.recoveryCode);
  } catch (e) {
    if (
      e instanceof CryptoError &&
      (e.code === "unwrap_failed" || e.code === "no_such_method" || e.code === "invalid_kdf_params")
    )
      return null;
    throw e;
  }
}

const idsOf = (vks: Vk[]): Set<string> => new Set(vks.map((v) => v.id));

/** The previous VKs that really unwrap under the keyring's own VK; entries that do not open are not counted. */
export async function unwrappedPreviousIds(kr: Keyring, vk: Vk): Promise<Set<string>> {
  return idsOf(await unwrapPreviousVks(kr, vk));
}

/**
 * The local previous entries that must survive (P3), in list order: only those that really unwrap, so a garbage entry a
 * VK holder once slipped into an adopted bundle cannot make every later honest bundle look like it "dropped" history.
 * Without the local VK the listed entries are used, which can only make adoption stricter (M1-2b).
 */
export async function realPrevious(local: Keyring, localVk: Vk | undefined): Promise<PreviousRef[]> {
  if (!localVk || localVk.id !== local.vkId) return local.previous;
  const ids = await unwrappedPreviousIds(local, localVk);
  return local.previous.filter((p) => ids.has(p.vkId));
}

const authEqual = (a: BundleAuth, b: BundleAuth): boolean => canonicalJsonStrict(a) === canonicalJsonStrict(b);
const authSameAs = (adopted: BundleAuth | null, b: KeyBundle): boolean | null =>
  adopted === null ? null : authEqual(adopted, b.auth);

// ---- R0 + R1 + R2: a bundle for the VK this unlocked device holds --------------------------------------------------

export type SameVkInput = {
  bundle: KeyBundle;
  vk: Vk; // this device's VK, which is also the bundle's
  local: Keyring;
  maxSeenKver: number;
  expectedVaultId: string; // this account's vaultId (F-03)
  adoptedAuth: BundleAuth | null; // identity's adopted.auth; null only right after an identity restore (F-07)
  adoptedDigest: string | null; // identity's adopted.digest: "the same content" also when it matches (GM2-5)
};

/** The bundle is the one this device last committed (its digest is adopted.digest), whatever the local keyring. */
async function isAdopted(b: KeyBundle, adoptedDigest: string | null): Promise<boolean> {
  return adoptedDigest !== null && (await adoptedRecord(b)).digest === adoptedDigest;
}

export type { SameVkVerdict };

/**
 * What M2's commitKeys accepts for an adoption (§0.0i item 16): an `adopt` verdict exactly as evaluateSameVkBundle or
 * unlockWithSync returned it. Those two are frozen and registered (capability.ts) with the bundle, its VK, the old VKs to
 * hold and the new maxSeenKver; a copy, or one built by hand, is refused.
 */
export type Adoption = Extract<SameVkVerdict, { kind: "adopt" }> | Extract<UnlockResult, { kind: "adopt" }>;

/**
 * R0, R1 and R2 (adoption.ts sameVkVerdict) with the facts established here. An `adopt` verdict is the capability
 * commitKeys takes (Adoption): the same VK, nothing else to hold; "adopted_back" when it is the bundle this device last
 * committed (GM2-5), else "same_password_wrap" (R2 adopts at once only then).
 */
export async function evaluateSameVkBundle(i: SameVkInput): Promise<SameVkVerdict> {
  if (i.bundle.keyring.vkId !== i.vk.id || i.local.vkId !== i.vk.id)
    throw new SyncCryptoError("invalid_argument", "not a same-VK bundle");
  const vaultOk = i.bundle.vaultId === i.expectedVaultId;
  const macValid = vaultOk && (await verifyBundleMac(i.vk, i.bundle));
  const same = sameKeyring(i.bundle.keyring, i.local);
  const adoptedBack = macValid && (await isAdopted(i.bundle, i.adoptedDigest));
  const v = sameVkVerdict({
    vaultOk,
    macValid,
    bundleKver: i.bundle.kver,
    maxSeenKver: i.maxSeenKver,
    sameKeyring: same,
    adoptedBack,
    previousCovers:
      macValid &&
      previousCovers(await realPrevious(i.local, i.vk), await unwrappedPreviousIds(i.bundle.keyring, i.vk), true),
    passwordWrapSame: sameWrap(wrapOf(i.local, "password"), wrapOf(i.bundle.keyring, "password")),
    authSame: authSameAs(i.adoptedAuth, i.bundle),
  });
  if (v.kind !== "adopt") return v;
  return issue(v, {
    bundle: i.bundle,
    vk: i.vk,
    held: [],
    maxSeenKver: v.maxSeenKver,
    basis: adoptedBack && !same ? "adopted_back" : "same_password_wrap",
    base: i.local,
  });
}

// ---- R3 / R4 / R6 / D8: unlocking with sync on ---------------------------------------------------------------------

export type UnlockInput = {
  secret: UnlockSecret; // R6: a recovery code follows the same rules
  local: Keyring | null; // null when local storage is lost (cloud restore, §4.13)
  remote: KeyBundle | null; // the server's current bundle when online, the staged one when offline
  pinnedVkId: string | null; // null when the identity was restored from its copy (§2.5)
  maxSeenKver: number;
  needsPassword: boolean; // R4
  confirmedOlder?: boolean; // the answer to a previous confirm_older
  expectedVaultId: string; // the local keyring's vaultId, or the identity's when the keyring is lost (F-03)
  adoptedAuth: BundleAuth | null; // identity's adopted.auth (F-07)
  adoptedDigest: string | null; // identity's adopted.digest: "same content" when the local keyring is lost (F-06)
};

export type UnlockResult =
  | { kind: "local"; vk: Vk; pin: string; note: LocalUnlockNote; remoteRejected?: BundleRejection }
  | { kind: "adopt"; vk: Vk; bundle: KeyBundle; sameVk: boolean; previousVks: Vk[]; pin: string; maxSeenKver: number }
  | { kind: "confirm_older" }
  | { kind: "reject"; reason: "wrong_secret" | "no_reference" | BundleRejection };

/**
 * §3.9 R3: the local keyring first, then the server's bundle (R4: the other way round in needs_password). A refused
 * remote bundle never locks the user out: the local keyring is still tried. `adopt` means: decrypt local data with the
 * old VK (it is in previousVks for a new VK), merge, one transact with the new keyring, startSession, then the pins:
 * M2's commitKeys, which takes this very object (Adoption: frozen and registered, "opened" by the typed secret).
 */
export async function unlockWithSync(i: UnlockInput): Promise<UnlockResult> {
  let refused: BundleRejection | undefined;
  // GM2-5: a pin that differs from the local keyring's VK (both plain ids, seen while locked) tries the remote first, as
  // needs_password does (R4): a pin ahead adopts with one password, a pin behind is moved on by D8.
  const pinDiffers = i.pinnedVkId !== null && i.local !== null && i.pinnedVkId !== i.local.vkId;
  for (const where of unlockOrder(i.needsPassword || pinDiffers, i.remote !== null)) {
    if (where === "local") {
      const vk = i.local && (await openKeyring(i.local, i.secret));
      if (vk) return afterLocal(i, i.local!, vk, refused);
    } else {
      const vk = await openKeyring(i.remote!.keyring, i.secret);
      if (!vk) continue;
      const r = await afterRemote(i, i.remote!, vk);
      if (r.kind !== "reject") return r;
      if (r.reason === "no_reference" || r.reason === "wrong_secret") return r; // no local keyring and no pin: nothing to unlock against
      refused = r.reason;
    }
  }
  return { kind: "reject", reason: refused ?? "wrong_secret" };
}

async function afterLocal(
  i: UnlockInput,
  local: Keyring,
  vk: Vk,
  remoteRejected: BundleRejection | undefined,
): Promise<UnlockResult> {
  const needPrev =
    (i.pinnedVkId !== null && i.pinnedVkId !== local.vkId) ||
    (i.remote !== null && i.remote.keyring.vkId !== local.vkId);
  const prevIds = needPrev ? await unwrappedPreviousIds(local, vk) : new Set<string>();
  const pin = pinAfterUnlock(i.pinnedVkId, local.vkId, prevIds);
  let note: LocalUnlockNote = "none";
  if (pin !== local.vkId) {
    // D8's second direction (§0.0i M1 change 4): the local keyring cannot reach the pin (a local commit lost, the pins
    // written). The pin stays, and nothing about the server's bundle is decided here: M3 sets needs_password.
    note = "pin_ahead";
  } else if (i.remote && !remoteRejected) {
    const rv = i.remote.keyring.vkId;
    const relation: RemoteRelation = rv === local.vkId ? "same_vk" : prevIds.has(rv) ? "older_vk" : "other_vk";
    const verified =
      relation === "same_vk" && i.remote.vaultId === i.expectedVaultId && (await verifyBundleMac(vk, i.remote)); // R0 before any classification
    note = noteAfterLocalUnlock({
      remote: relation,
      macValid: verified,
      kver: verified
        ? classifyKver(
            i.remote.kver,
            i.maxSeenKver,
            sameKeyring(local, i.remote.keyring) || (await isAdopted(i.remote, i.adoptedDigest)),
          ).outcome
        : null,
      passwordWrapSame: verified && sameWrap(wrapOf(local, "password"), wrapOf(i.remote.keyring, "password")),
    });
  }
  return remoteRejected ? { kind: "local", vk, pin, note, remoteRejected } : { kind: "local", vk, pin, note };
}

async function afterRemote(i: UnlockInput, remote: KeyBundle, vk: Vk): Promise<UnlockResult> {
  const ref = i.pinnedVkId ?? i.local?.vkId ?? null;
  if (ref === null) return { kind: "reject", reason: "no_reference" };
  const vaultOk = remote.vaultId === i.expectedVaultId && (i.local === null || i.local.vaultId === i.expectedVaultId);
  const macValid = vaultOk && (await verifyBundleMac(vk, remote));
  if (!vaultOk || !macValid) return { kind: "reject", reason: vaultOk ? "bad_mac" : "wrong_vault" }; // R0: never classified
  const previousVks = await unwrapPreviousVks(remote.keyring, vk);
  const ids = idsOf(previousVks);
  const sameVk = i.local !== null && vk.id === i.local.vkId;
  const localVk = i.local ? [vk, ...previousVks].find((v) => v.id === i.local!.vkId) : undefined; // to tell real local entries from garbage
  const localPrev = i.local ? await realPrevious(i.local, localVk) : [];
  // Local keyring lost (F-06): adopted.digest stands in for it. The same keyring under the adopted auth reproducing the
  // digest means only auth changed, which F-07 refuses even though no password wrap is at hand to compare (M1-NOTES).
  // "The same content" (§0.0i M1 change 1): the local keyring, or adopted.digest, whether or not the local keyring is there.
  const same = (i.local !== null && sameKeyring(i.local, remote.keyring)) || (await isAdopted(remote, i.adoptedDigest));
  let onlyAuthChanged = false;
  if (i.local === null && !same && i.adoptedDigest !== null) {
    onlyAuthChanged =
      i.adoptedAuth !== null && (await adoptedRecord({ ...remote, auth: i.adoptedAuth })).digest === i.adoptedDigest;
  }
  const kver = classifyKver(remote.kver, i.maxSeenKver, same);
  const passwordWrapSame = sameVk && sameWrap(wrapOf(i.local!, "password"), wrapOf(remote.keyring, "password"));
  const authSame = authSameAs(i.adoptedAuth, remote);
  const d = decideRemoteUnlock({
    vaultOk,
    macValid,
    kver: kver.outcome,
    confirmedOlder: i.confirmedOlder === true,
    vkIsPinned: vk.id === ref,
    reachesPinned: ids.has(ref),
    reachesLocal: i.local === null || vk.id === i.local.vkId || ids.has(i.local.vkId),
    previousCovers: previousCovers(localPrev, ids, sameVk),
    authOk: authSame !== false || !(passwordWrapSame || kver.outcome === "in_sync" || onlyAuthChanged),
  });
  if (d.kind !== "adopt") return d;
  const maxSeenKver = kver.outcome === "adopt_candidate" ? kver.maxSeenAfterAdoption : kver.maxSeenAfter;
  const r: UnlockResult = { kind: "adopt", vk, bundle: remote, sameVk: d.sameVk, previousVks, pin: vk.id, maxSeenKver };
  return issue(r, { bundle: remote, vk, held: previousVks, maxSeenKver, basis: "opened", base: i.local });
}
