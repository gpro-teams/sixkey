// The key operations with sync on, the client halves (SYNC-DESIGN §3.6–§3.8, §3.6.0, §3.10, §3.14, §4.2's repair, §3.9
// R2/R3/R4/R6), over the engine's API client. Server first, then local (§3.6.0): nothing is committed locally until the
// server accepted the change (a 200, or §3.6.0's reconciliation by the part this device changed), and then only through
// M2's commitKeys with the capability M1 issued for it (published(), or an Adoption), in this same JS context (M1-19).
//   - Every decision reads the identity settled first (settlePins, M2-NOTES §7 item 1) and feeds M1 its pins.
//   - The pre-send check (§3.14) and the builders run in one context; its VerifiedServerBundle never leaves it.
//   - A capability that commitKeys refuses as stale is dropped and the state evaluated again; never retried (RR-1).
//   - A new recovery code is shown before anything is sent (§0.0i item 14): prepare → the page shows it → commit.
//     Until the server's answer is known, its wrap's fingerprint waits in sk_sync_state (§3.6.0), so a page that dies
//     never leads to "the new code is invalid" being said before it is known.
//   - Keyring times are floored to the hour (§2.3 T1) and every publish takes publishKver (§3.9 R1).
// Errors are KeyOpError with a fixed code (M1's refusal reasons, the contract's codes, or the few below): never data.
import { bs, randomBytes, toB64 } from "../../crypto/bytes";
import {
  rekey,
  setPassword,
  setRecovery,
  unlockWithPassword,
  unlockWithRecoveryCode,
  type Keyring,
} from "../../crypto/keyring";
import { checkPasswordPolicy } from "../../crypto/password-policy";
import type { Vk } from "../../crypto/vk";
import { ServiceError } from "../../service/service-error";
import { MergeBlocked, type CurrentVault, type MergeAnswer } from "../../service/sync-flows";
import { passwordProof, recoveryProof } from "../crypto/auth-proofs";
import { SYNC_CONSTANTS } from "../crypto/constants";
import { unlockWithSync, type UnlockSecret } from "../crypto/bundle-eval";
import { floorToHour } from "../crypto/encoding";
import { fitsEnvelopeLimit } from "../crypto/padding";
import {
  capPrevious,
  newBundleAuth,
  parseBundleText,
  publishKver,
  requiredVerifiers,
  sameWrapBytes,
  sealBundle,
  wrapOf,
  type BundleAuth,
  type KeyBundle,
} from "../crypto/keybundle";
import { canonicalJson } from "../../vault/merge";
import { checkDeviceName, openDeviceName, sealDeviceName } from "../crypto/device-name";
import { generateDeviceKey, newDeviceId } from "../crypto/device-key";
import { preSendCheck, published, type VerifiedServerBundle } from "../crypto/presend";
import { reconcileKeyOp, recoveryWrapFingerprint, type SubmittedKeyOp } from "../crypto/reconcile";
import type { SensitiveOp } from "../crypto/adoption";
import { writeKey, writeProof } from "../crypto/subkeys";
import type { GuardReport } from "../local/guard";
import type { DeviceIdentity } from "../local/identity";
import { uploadEnvelope } from "../local/outbox";
import { ApiError, type AccountSession, type DeviceSigner, type NameCtWire } from "./api";
import { versionBelow, type SyncEngine } from "./engine";
import { conflictDelay } from "./schedule";
import { undoneRevocations } from "./state";
import { openRemote } from "./remote";
import { NetworkError } from "./transport";

export type KeyOpErrorCode =
  | "not_enrolled"
  | "locked"
  | "weak_password"
  | "wrong_secret"
  | "cleanup_pending"
  | "not_synced"
  | "changed_elsewhere"
  | "offline" // nothing was sent (a check before sending could not reach the server)
  | "busy" // a round in another context held sixkey-sync for too long: nothing was sent (M3RR-4)
  | "vault_lost" // §4.7 (rev. 20, R3R-3): the local vault is lost or empty; an orphan entry waits: the cloud restore or a backup first
  | "committed_on_server" // the server accepted, the local commit was stale: in effect; this device catches up next round (P-1)
  | "unconfirmed" // the server's answer is not known yet: keep both codes; a later round tells (§3.6.0)
  | "stale" // something was committed here meanwhile: start again
  | "conflict"
  | "server"
  | "keys_behind"
  | "needs_adoption"
  | "update_required"
  | "password_changed_elsewhere"
  | "old_password_required"
  | "not_behind"
  | "invalid_bundle"
  | "bad_mac"
  | "wrong_vault"
  | "previous_dropped"
  | "auth_without_password"
  | "discontinuous"
  | "invalid_recovery_code";

export class KeyOpError extends Error {
  constructor(readonly code: KeyOpErrorCode | string) {
    super(`key operation: ${code}`);
    this.name = "KeyOpError";
  }
}

/** `epoch`: the lock epoch read just before the vault was found open (`cur`); the session a commit starts carries it. */
type Ctx = {
  id: DeviceIdentity;
  signer: DeviceSigner;
  cur: CurrentVault;
  maxSeenKver: number;
  adoptedAuth: BundleAuth | null;
  adoptedDigest: string | null;
  epoch: number;
};

/**
 * This device enrolled and unlocked, the identity settled (its pins as decisions must see them), and (M3R-3, §4.2 step 1,
 * §8.3 "停止读写") a fresh status query: a client below min_client_version publishes nothing (update_required). `gate:
 * false` only for the defensive operations: revoking and rejecting enrolments (§3.14: an emergency revoke is never
 * blocked; docs/design/notes/M3-NOTES.md §4 asks the design owner).
 */
async function context(e: SyncEngine, o: { gate?: boolean } = {}): Promise<Ctx> {
  const d = e.deps;
  const st = await d.local.status(); // settles the pins
  if (st.kind !== "on") throw new KeyOpError("not_enrolled");
  const { cur, epoch } = await openVault(e);
  const id = st.identity;
  const signer: DeviceSigner = { kind: "device", deviceId: id.deviceId, key: id.keyPair.privateKey };
  if (o.gate !== false) await versionGate(e, signer);
  return {
    id,
    signer,
    cur,
    maxSeenKver: id.maxSeenKver,
    adoptedAuth: id.adopted?.auth ?? null,
    adoptedDigest: id.adopted?.digest ?? null,
    epoch,
  };
}

/**
 * The vault open here, through requireVk (SYNC-DESIGN §4.10: sync commits go through it; locked: KeyOpError "locked"),
 * with the lock epoch read just before: a commit that starts a session hands it on (commitPublished), so a lock after
 * this check voids that session and the page stays locked (the rule of the service's commitUploadRecovery and
 * commitJoin).
 */
async function openVault(e: SyncEngine): Promise<{ cur: CurrentVault; epoch: number }> {
  const epoch = await e.deps.flows.lockEpoch();
  try {
    return { cur: await e.deps.flows.current(), epoch };
  } catch (err) {
    if (err instanceof ServiceError && err.code === "locked") throw new KeyOpError("locked");
    throw err;
  }
}

/**
 * A key operation's commit, after the user confirmed the code it showed: only while the vault is still open under the key
 * it was prepared with (a lock since the prepare, which the page may not have seen, refuses it before anything is written
 * or sent). Returns the epoch for the commit's session.
 */
async function stillOpen(e: SyncEngine, vkId: string): Promise<number> {
  const { cur, epoch } = await openVault(e);
  if (cur.vk.id !== vkId) throw new KeyOpError("changed_elsewhere");
  return epoch;
}

/** M3R-3: the server's minimum client version, asked now; below it, update_required (nothing sent after). */
export async function versionGate(e: SyncEngine, signer: DeviceSigner): Promise<void> {
  const s = await e.api.status(signer).catch((err: unknown) => {
    throw err instanceof NetworkError
      ? new KeyOpError("offline")
      : err instanceof ApiError
        ? new KeyOpError(err.code)
        : err;
  });
  if (versionBelow(e.deps.clientVersion, s.min_client_version)) throw new KeyOpError("update_required");
}

/** §3.14: GET /v1/keys and M1's pre-send check for `op` with the typed secret: the proof and the verified bundle, or a refusal. */
async function preSend(e: SyncEngine, c: Ctx, op: SensitiveOp, secret: UnlockSecret) {
  const k = await e.api.getKeys(c.signer).catch((err: unknown) => {
    throw err instanceof NetworkError
      ? new KeyOpError("offline")
      : err instanceof ApiError
        ? new KeyOpError(err.code)
        : err; // M3R-8
  });
  const r = await preSendCheck({
    op,
    serverRaw: k.bundle,
    secret,
    local: c.cur.gen.keyring,
    vk: c.cur.vk,
    maxSeenKver: c.maxSeenKver,
    expectedVaultId: c.cur.gen.keyring.vaultId,
    adoptedAuth: c.adoptedAuth,
    adoptedDigest: c.adoptedDigest,
  });
  if (!r.ok) throw new KeyOpError(r.reason);
  return r;
}

const pwAuth = (proof: { password_auth: string } | { recovery_auth: string }): string => {
  if (!("password_auth" in proof)) throw new KeyOpError("wrong_secret");
  return proof.password_auth;
};

/** The hour (§2.3 T1) of this device's corrected clock: every keyring operation with sync on uses it. */
const hourNow = (e: SyncEngine) => floorToHour(Math.max(0, Math.round(e.refNow())));

/**
 * Send a key operation and find out whether it took effect (§3.6.0, F2, S4): a 200; or, after a network error, a 5xx or a
 * 409 keys_conflict, GET /v1/keys judged by the part this device changed (`inEffect`, reconcileKeyOp). While the server
 * still holds exactly the bundle the operation was built on, the identical text is sent again (the server's idempotency
 * is by text). A version_conflict (a rotation's envelope) is "conflict": the caller merges and builds it again.
 * "unconfirmed" when the answer cannot be known now (offline); "changed_elsewhere" when another change won.
 */
async function sendKeyOp(
  e: SyncEngine,
  c: Ctx,
  base: KeyBundle,
  inEffect: (server: KeyBundle, vkId: string) => Promise<boolean>,
  send: () => Promise<unknown>,
  rotate = false,
  onSent?: () => Promise<void>,
): Promise<void> {
  for (let tries = 0; tries < 3; tries++) {
    try {
      try {
        await send();
      } finally {
        await onSent?.(); // M3RR-6: the pending record's clock restarts with every signature that may still land
      }
      return;
    } catch (err) {
      if (err instanceof ApiError && err.code === "version_conflict") throw new KeyOpError("conflict");
      const unknown =
        err instanceof NetworkError || (err instanceof ApiError && (err.status >= 500 || err.code === "keys_conflict"));
      if (!unknown) throw err instanceof ApiError ? new KeyOpError(err.code) : err;
      let server: KeyBundle;
      let vkId: string;
      try {
        server = parseBundleText((await e.api.getKeys(c.signer)).bundle);
        vkId = rotate ? (await e.api.status(c.signer)).vk_id : server.keyring.vkId;
      } catch (err2) {
        if (err2 instanceof NetworkError || (err2 instanceof ApiError && err2.status >= 500))
          throw new KeyOpError("unconfirmed");
        throw err2 instanceof ApiError ? new KeyOpError(err2.code) : err2;
      }
      if (await inEffect(server, vkId)) return;
      // Not in effect: the same text again while the server holds what it was built on; otherwise another change won.
      if (server.kver !== base.kver || server.mac !== base.mac) throw new KeyOpError("changed_elsewhere");
    }
  }
  throw new KeyOpError("unconfirmed");
}

/**
 * M3RR-4 (§4.9, rev. 19): a key operation holds sixkey-sync like a round, so no round in another context reads or moves
 * lastSynced and the keys under it. Busy: waited for, a bounded number of times (a round takes seconds), then "busy".
 * Never call it from inside a round (the lock is not re-entrant); the worker's transport serving a page never takes it.
 */
async function holdingSync<T>(e: SyncEngine, fn: () => Promise<T>): Promise<T> {
  for (let busy = 0; ; busy++) {
    const r = await e.deps.syncLock(fn);
    if (r.ran) return r.value;
    if (busy >= SYNC_BUSY_TRIES) throw new KeyOpError("busy");
    await e.deps.sleep(conflictDelay((e.deps.random ?? (() => 0.5))()));
  }
}
const SYNC_BUSY_TRIES = 20;

const byPart = (sub: SubmittedKeyOp) => (server: KeyBundle, vkId: string) =>
  reconcileKeyOp(sub, { bundle: server, vkId });

/**
 * published() then commitKeys (§0.0i item 16), the pins settled just before; a stale capability is dropped (RR-1). The
 * server has accepted by then, so a stale one is "committed_on_server" (P-1): the change is in effect, and this device
 * takes it on its next round (an adoption, or needs_new_password); never "start again". Every caller is a key operation
 * of this page with its secret just typed (`secret`), so the commit is `typed` (KeyCommit: the PIN after a restart's
 * PIN-only window opens, as with sync off; review r2, PINR-R2-03); an adoption never comes through here.
 */
async function commitPublished(
  e: SyncEngine,
  verified: VerifiedServerBundle,
  sent: KeyBundle,
  vk: Vk,
  secret: UnlockSecret,
  record: "password_changed" | "password_reset" | "recovery_code_new" | "key_rotated" | null,
  epoch: number,
): Promise<void> {
  const p = await published({ verified, sent, vk, secret });
  await e.deps.local.settlePins();
  try {
    await e.deps.flows.commitKeys({ keys: p, ...(record ? { record } : {}), epoch, typed: true });
  } catch (err) {
    if (err instanceof ServiceError && err.code === "bad_state" && err.message === "stale")
      throw new KeyOpError("committed_on_server");
    throw err;
  }
}

/**
 * §3.6.0: a new recovery code (a new code, or a rotation's) recorded before it is sent. `at` is on the corrected clock
 * (refNow) and is refreshed after every send attempt (touchPending), so M3R-7's "no signature of it can land any more"
 * is measured from the last request on the server's clock, not from the first on this machine's (M3RR-6).
 */
async function setPending(e: SyncEngine, bundle: KeyBundle, base: KeyBundle): Promise<void> {
  const fp = await recoveryWrapFingerprint(bundle);
  await e.state.update(() => ({
    pendingRecoveryWrap: { fp, at: e.refNow(), kver: bundle.kver, baseKver: base.kver, baseMac: base.mac },
  }));
}
async function touchPending(e: SyncEngine): Promise<void> {
  await e.state.update((cur) =>
    cur.pendingRecoveryWrap ? { pendingRecoveryWrap: { ...cur.pendingRecoveryWrap, at: e.refNow() } } : null,
  );
}
async function clearPending(e: SyncEngine): Promise<void> {
  await e.state.update(() => ({ pendingRecoveryWrap: null }));
}

// ---- §3.6 change the master password ------------------------------------------------------------------------------

/** §3.6.1: online; the old password proves (pw_auth) and the new one is wrapped around the same VK (new salt, new auth). */
/** changePassword, holding sixkey-sync like a round (M3RR-4). */
export async function changePassword(e: SyncEngine, oldPassword: string, newPassword: string): Promise<void> {
  return holdingSync(e, () => changePasswordHeld(e, oldPassword, newPassword));
}

async function changePasswordHeld(e: SyncEngine, oldPassword: string, newPassword: string): Promise<void> {
  if (!checkPasswordPolicy(newPassword).ok) throw new KeyOpError("weak_password");
  const c = await context(e);
  const pre = await preSend(e, c, "change_password", { password: oldPassword });
  const server = pre.verified.bundle;
  const vk = pre.verified.vk;
  const now = hourNow(e);
  const keyring = await setPassword(server.keyring, vk, newPassword, {
    now: () => now,
    rng: e.deps.rng ?? randomBytes,
  });
  const auth = newBundleAuth(wrapOf(keyring, "password")!.kdf!.salt, e.deps.rng);
  const sealed = await sealBundle(vk, {
    vaultId: server.vaultId,
    kver: publishKver(server.kver, c.maxSeenKver),
    keyring,
    auth,
    by: c.id.deviceId,
    now,
  });
  requiredVerifiers(server, sealed.bundle); // P4 (§2.3): the server would answer 422 otherwise
  const passwordVerifier = (await passwordProof(newPassword, auth.kdf)).passwordVerifier;
  const body = {
    if_kver: server.kver,
    bundle: sealed.raw,
    password_auth: pwAuth(pre.proof),
    password_verifier: passwordVerifier,
  };
  await sendKeyOp(e, c, server, byPart({ kind: "change_password", bundle: sealed.bundle, newPassword }), () =>
    e.api.putKeys(c.signer, body),
  );
  await commitPublished(e, pre.verified, sealed.bundle, vk, { password: newPassword }, "password_changed", c.epoch);
}

// ---- §3.7 a new recovery code --------------------------------------------------------------------------------------

/** A new recovery code made in memory and shown before anything is sent (§0.0i item 14). One use. */
export type PreparedCode = { readonly recoveryCode: string };
type CodePlan = { verified: VerifiedServerBundle; proof: string; keyring: Keyring; vk: Vk; server: KeyBundle; c: Ctx };
const codePlans = new WeakMap<PreparedCode, CodePlan>();

export async function prepareRecoveryCode(e: SyncEngine, password: string): Promise<PreparedCode> {
  const c = await context(e);
  const pre = await preSend(e, c, "change_recovery", { password });
  const now = hourNow(e);
  const { keyring, recoveryCode } = await setRecovery(pre.verified.bundle.keyring, pre.verified.vk, {
    now: () => now,
    rng: e.deps.rng ?? randomBytes,
  });
  const h: PreparedCode = Object.freeze({ recoveryCode });
  codePlans.set(h, {
    verified: pre.verified,
    proof: pwAuth(pre.proof),
    keyring,
    vk: pre.verified.vk,
    server: pre.verified.bundle,
    c,
  });
  return h;
}

/** The user confirmed the code is saved: PUT /v1/keys, then (accepted) the local commit. "unconfirmed": keep both codes. */
/** commitRecoveryCode, holding sixkey-sync like a round (M3RR-4). */
export async function commitRecoveryCode(e: SyncEngine, h: PreparedCode): Promise<void> {
  return holdingSync(e, () => commitRecoveryCodeHeld(e, h));
}

async function commitRecoveryCodeHeld(e: SyncEngine, h: PreparedCode): Promise<void> {
  const p = codePlans.get(h);
  if (!p) throw new KeyOpError("stale");
  const now = hourNow(e);
  const sealed = await sealBundle(p.vk, {
    vaultId: p.server.vaultId,
    kver: publishKver(p.server.kver, p.c.maxSeenKver),
    keyring: p.keyring,
    auth: p.server.auth,
    by: p.c.id.deviceId,
    now,
  });
  requiredVerifiers(p.server, sealed.bundle);
  const recoveryVerifier = (await recoveryProof(h.recoveryCode)).recoveryVerifier;
  const epoch = await stillOpen(e, p.vk.id); // before anything is written or sent
  await versionGate(e, p.c.signer); // M3RR-5: the kill switch at the moment of the write, not only at prepare
  await setPending(e, sealed.bundle, p.server); // before it is sent (§3.6.0): a page that dies leaves "unconfirmed", never "invalid"
  try {
    await sendKeyOp(
      e,
      p.c,
      p.server,
      byPart({ kind: "change_recovery", bundle: sealed.bundle }),
      () =>
        e.api.putKeys(p.c.signer, {
          if_kver: p.server.kver,
          bundle: sealed.raw,
          password_auth: p.proof,
          recovery_verifier: recoveryVerifier,
        }),
      false,
      () => touchPending(e),
    );
  } catch (err) {
    // known not to have taken effect (refused, or another change won): no longer pending; "unconfirmed" stays pending
    if (err instanceof KeyOpError && err.code !== "unconfirmed") await clearPending(e);
    throw err;
  }
  codePlans.delete(h);
  await commitPublished(
    e,
    p.verified,
    sealed.bundle,
    p.vk,
    { recoveryCode: h.recoveryCode },
    "recovery_code_new",
    epoch,
  );
  await clearPending(e);
  await e.state.notice({ kind: "recovery_in_effect", at: e.deps.now() });
}

// ---- §3.3 step 5: a new master password with the recovery code ------------------------------------------------------

/**
 * §3.3 step 5: a user who joined with the recovery code because the master password was forgotten sets a new one with
 * that code. One bundle update replaces both wraps, the password's and the recovery code's: the code that was just used
 * is retired with it, and a new one is made in memory and shown before anything is sent (§0.0i item 14; the same rule as
 * Phase 0's reset, A4). The code's proof (`recovery_auth`) stands in for pw_auth, and the pre-send check runs with the
 * code (§3.14, op "recovery_reset"). Prepare, show the new code, then commit once the user has saved it.
 */
export type PreparedRecoveryReset = { readonly recoveryCode: string };
type ResetPlan = {
  verified: VerifiedServerBundle;
  proof: string;
  keyring: Keyring;
  vk: Vk;
  server: KeyBundle;
  password: string;
  c: Ctx;
};
const resetPlans = new WeakMap<PreparedRecoveryReset, ResetPlan>();

export async function prepareRecoveryReset(
  e: SyncEngine,
  o: { recoveryCode: string; newPassword: string },
): Promise<PreparedRecoveryReset> {
  if (!checkPasswordPolicy(o.newPassword).ok) throw new KeyOpError("weak_password");
  const c = await context(e);
  const pre = await preSend(e, c, "recovery_reset", { recoveryCode: o.recoveryCode });
  if (!("recovery_auth" in pre.proof)) throw new KeyOpError("wrong_secret");
  const now = hourNow(e);
  const rng = e.deps.rng ?? randomBytes;
  const withPassword = await setPassword(pre.verified.bundle.keyring, pre.verified.vk, o.newPassword, {
    now: () => now,
    rng,
  });
  const { keyring, recoveryCode } = await setRecovery(withPassword, pre.verified.vk, { now: () => now, rng });
  const h: PreparedRecoveryReset = Object.freeze({ recoveryCode });
  resetPlans.set(h, {
    verified: pre.verified,
    proof: pre.proof.recovery_auth,
    keyring,
    vk: pre.verified.vk,
    server: pre.verified.bundle,
    password: o.newPassword,
    c,
  });
  return h;
}

/** The user saved the new code: PUT /v1/keys with recovery_auth, then the local commit. "unconfirmed": keep both codes. */
export async function commitRecoveryReset(e: SyncEngine, h: PreparedRecoveryReset): Promise<void> {
  return holdingSync(e, () => commitRecoveryResetHeld(e, h));
}

async function commitRecoveryResetHeld(e: SyncEngine, h: PreparedRecoveryReset): Promise<void> {
  const p = resetPlans.get(h);
  if (!p) throw new KeyOpError("stale");
  const now = hourNow(e);
  const auth = newBundleAuth(wrapOf(p.keyring, "password")!.kdf!.salt, e.deps.rng);
  const sealed = await sealBundle(p.vk, {
    vaultId: p.server.vaultId,
    kver: publishKver(p.server.kver, p.c.maxSeenKver),
    keyring: p.keyring,
    auth,
    by: p.c.id.deviceId,
    now,
  });
  requiredVerifiers(p.server, sealed.bundle);
  const recoveryVerifier = (await recoveryProof(h.recoveryCode)).recoveryVerifier;
  const passwordVerifier = (await passwordProof(p.password, auth.kdf)).passwordVerifier;
  const epoch = await stillOpen(e, p.vk.id); // before anything is written or sent
  await versionGate(e, p.c.signer);
  await setPending(e, sealed.bundle, p.server); // the new code, as a new recovery code's (§3.6.0)
  try {
    const body = {
      if_kver: p.server.kver,
      bundle: sealed.raw,
      recovery_auth: p.proof,
      recovery_verifier: recoveryVerifier,
      password_verifier: passwordVerifier,
    };
    await sendKeyOp(
      e,
      p.c,
      p.server,
      byPart({ kind: "change_recovery", bundle: sealed.bundle }),
      () => e.api.putKeys(p.c.signer, body),
      false,
      () => touchPending(e),
    );
  } catch (err) {
    if (err instanceof KeyOpError && err.code !== "unconfirmed") await clearPending(e);
    throw err;
  }
  resetPlans.delete(h);
  await commitPublished(e, p.verified, sealed.bundle, p.vk, { password: p.password }, "password_reset", epoch);
  await clearPending(e);
  await e.state.notice({ kind: "recovery_in_effect", at: e.deps.now() });
}

// ---- §3.8 rotate the vault key ---------------------------------------------------------------------------------------

export type PreparedRotation = { readonly recoveryCode: string };
type RotationPlan = {
  verified: VerifiedServerBundle;
  proof: string;
  keyring: Keyring;
  vk2: Vk;
  vk1: Vk;
  server: KeyBundle;
  password: string;
  c: Ctx;
  /** Sealed at the first commit and kept: every retry of this handle sends the identical bundle text. */
  sealed?: {
    bundle: Awaited<ReturnType<typeof sealBundle>>;
    recoveryVerifier: string;
    passwordVerifier: string;
    newWriteKey: string;
  };
  /** The new code's fingerprint is pending (written before the first send). */
  pending?: boolean;
  /** A send of this handle ended with its answer unknown: it may still take effect (A4). */
  unknownSend?: boolean;
};
const rotations = new WeakMap<PreparedRotation, RotationPlan>();

/**
 * §3.8 P1/P2: after a normal round (so the rotation includes everything), with no key-change cleanup pending (§0.0i item
 * 10: capPrevious may drop the oldest previous key only then), rekey in memory and cap the previous list (F-11). The new
 * recovery code is shown; nothing is sent yet.
 */
export async function prepareRotation(e: SyncEngine, password: string): Promise<PreparedRotation> {
  const r = await e.round({ explicit: true });
  if (r.status === "update_required") throw new KeyOpError("update_required");
  if (r.status !== "ok") throw new KeyOpError("not_synced");
  const c = await context(e);
  const pre = await preSend(e, c, "rotate", { password });
  const now = hourNow(e);
  const rk = await rekey(pre.verified.bundle.keyring, pre.verified.vk, password, {
    now: () => now,
    rng: e.deps.rng ?? randomBytes,
  });
  // capPrevious drops the oldest previous key only when the list is full; then no cleanup may still need it (§0.0i item 10)
  if (rk.keyring.previous.length > SYNC_CONSTANTS.KEYRING_PREVIOUS_MAX && (await e.deps.flows.cleanupDue()))
    throw new KeyOpError("cleanup_pending");
  const h: PreparedRotation = Object.freeze({ recoveryCode: rk.recoveryCode });
  rotations.set(h, {
    verified: pre.verified,
    proof: pwAuth(pre.proof),
    keyring: capPrevious(rk.keyring),
    vk2: rk.vk,
    vk1: pre.verified.vk,
    server: pre.verified.bundle,
    password,
    c,
  });
  return h;
}

/**
 * §3.8 P3/P4: POST /v1/keys/rotate (the envelope under VK2 at version+1, the write proof under the current K_write, the new
 * K_write, the bundle, the verifiers, every device name re-encrypted under VK2), then the local commit.
 *
 * The envelope is this device's vault, so its base is the version that vault has merged (M3R-2): lastSynced, read after
 * the vault (M3R-1), and only while the server still holds exactly that version and head (the outbox rule, D5). Each
 * pass (the vault load, the state read, the status, the send) holds sixkey-sync like a round (M3RR-4: a round in
 * another context cannot move lastSynced under it); the merging round runs between passes.
 *   - The server's key or kver already moved (M3RR-1): this very rotation, sent before and its answer lost, or another
 *     device's key change. Reconciled first (GET /v1/keys and the VK): in effect, the local commit; not, changed_elsewhere
 *     (the code shown is void).
 *   - The head is not the one this vault merged, or a 409 (P3: "回到 P1 的合并步骤"): a round that must come back "ok"
 *     merges first; otherwise not_synced. not_synced means "not in effect now": when an earlier send of this handle had
 *     an unknown answer it is unconfirmed instead (A4: the code may still take effect, its pending record stays).
 * The bundle, its auth and the verifiers are sealed once per handle, so every retry sends the identical text (the
 * server's idempotent 200 is by text). Its recovery code's fingerprint is pending from before the first send until a
 * known outcome (§3.6.0, M3RR-1): a later round says "in effect" or "not in effect", never too early.
 */
export async function commitRotation(e: SyncEngine, h: PreparedRotation): Promise<void> {
  const p = rotations.get(h);
  if (!p) throw new KeyOpError("stale");
  const vaultId = p.server.vaultId;
  if (!p.sealed) {
    const auth = newBundleAuth(wrapOf(p.keyring, "password")!.kdf!.salt, e.deps.rng);
    p.sealed = {
      bundle: await sealBundle(p.vk2, {
        vaultId,
        kver: publishKver(p.server.kver, p.c.maxSeenKver),
        keyring: p.keyring,
        auth,
        by: p.c.id.deviceId,
        now: hourNow(e),
      }),
      recoveryVerifier: (await recoveryProof(h.recoveryCode)).recoveryVerifier,
      passwordVerifier: (await passwordProof(p.password, auth.kdf)).passwordVerifier,
      newWriteKey: await writeKey(p.vk2),
    };
  }
  const sealed = p.sealed;
  const sub: SubmittedKeyOp = { kind: "rotate", bundle: sealed.bundle.bundle };
  const known = async (err: KeyOpError): Promise<never> => {
    await clearPending(e); // a known outcome for every send of this handle: the code shown is void
    throw err;
  };
  let epoch = 0; // read in every pass, just before its open-vault check
  const committed = async (): Promise<void> => {
    rotations.delete(h);
    // the server took the rotation: none is owed (§3.10), once a revocation is on the record (otherwise the card still
    // asks to check that the device went)
    await e.state.update((s) => (s.rotationOwed?.revoked ? { rotationOwed: null } : null));
    await commitPublished(e, p.verified, sealed.bundle.bundle, p.vk2, { password: p.password }, "key_rotated", epoch);
    await clearPending(e);
    await e.state.notice({ kind: "recovery_in_effect", at: e.deps.now() });
  };
  for (let tries = 0, busy = 0; ;) {
    const pass = await e.deps.syncLock(async (): Promise<"done" | "merge"> => {
      const open = await openVault(e);
      const cur = open.cur;
      epoch = open.epoch;
      const ls = (await e.state.read()).lastSynced; // after the vault
      const s = await e.api.status(p.c.signer).catch((err: unknown) => {
        throw err instanceof NetworkError
          ? new KeyOpError(p.unknownSend ? "unconfirmed" : "offline")
          : err instanceof ApiError
            ? new KeyOpError(err.code)
            : err;
      });
      if (versionBelow(e.deps.clientVersion, s.min_client_version)) throw new KeyOpError("update_required"); // M3R-3
      if (s.vk_id !== p.vk1.id || s.kver !== p.server.kver) {
        // M3RR-1: the keys moved since the plan: this rotation landed (its answer was lost), or another change won
        const k = await e.api.getKeys(p.c.signer).catch((err: unknown) => {
          throw err instanceof NetworkError
            ? new KeyOpError(p.unknownSend ? "unconfirmed" : "offline")
            : err instanceof ApiError
              ? new KeyOpError(err.code)
              : err;
        });
        let server: KeyBundle | null = null;
        try {
          server = parseBundleText(k.bundle);
        } catch {
          server = null;
        }
        if (server && (await reconcileKeyOp(sub, { bundle: server, vkId: s.vk_id }))) return "done";
        return known(new KeyOpError("changed_elsewhere"));
      }
      if (cur.vk.id !== p.vk1.id) throw new KeyOpError("stale");
      if (!ls || s.version !== ls.version || s.head !== ls.head) return "merge"; // the head is not the one this vault merged
      const base = ls.version;
      const up = await uploadEnvelope(cur.vault, p.vk2, { vaultId, rev: base + 1 }, e.deps.rng);
      const proof = await writeProof(p.vk1, { vaultId, ifVersion: base, checksum: up.envelope.checksum });
      const names = await reencryptNames(e, p.c.signer, vaultId, p.vk1, p.vk2);
      const body = {
        if_version: base,
        if_kver: p.server.kver,
        envelope: up.text,
        write_proof: proof,
        new_write_key: sealed.newWriteKey,
        bundle: sealed.bundle.raw,
        password_auth: p.proof,
        recovery_verifier: sealed.recoveryVerifier,
        password_verifier: sealed.passwordVerifier,
        device_names: names,
      };
      if (!p.pending) {
        await setPending(e, sealed.bundle.bundle, p.server); // before the first send (§3.6.0, M3RR-1)
        p.pending = true;
      }
      try {
        await sendKeyOp(
          e,
          p.c,
          p.server,
          byPart(sub),
          () => e.api.rotate(p.c.signer, body),
          true,
          () => touchPending(e),
        );
      } catch (err) {
        if (err instanceof KeyOpError && err.code === "conflict") return "merge"; // P3: the data moved, the keys did not
        if (err instanceof KeyOpError && err.code === "unconfirmed") p.unknownSend = true;
        else if (err instanceof KeyOpError && !p.unknownSend) await clearPending(e); // refused, every send known
        throw err;
      }
      return "done";
    });
    if (!pass.ran) {
      // a round runs in another context: wait for it (bounded)
      if (++busy > SYNC_BUSY_TRIES) throw new KeyOpError(p.unknownSend ? "unconfirmed" : "busy");
      await e.deps.sleep(conflictDelay((e.deps.random ?? (() => 0.5))()));
      continue;
    }
    if (pass.value === "done") return committed();
    // the merge first, outside the lock (the round takes it); "ok" or nothing is decided
    if (tries++ >= 3 || (await e.round({ explicit: true })).status !== "ok")
      throw new KeyOpError(p.unknownSend ? "unconfirmed" : "not_synced");
  }
}

/** What a "lost" run recorded (state.ts rotationOwed), for the calls that follow it. */
export type OwedRotation = {
  /** Nothing was revoked after all (the first revocation refused): what was recorded before comes back. */
  undo(): Promise<void>;
  /** A device went: the record says so, with the server's keys just after it (`after`, revokeDevice). */
  revoked(after: ServerKeys | null): Promise<void>;
};

/**
 * §3.10 "lost, stolen or not sure": a rotation is owed from before the first revocation of such a run (`targets`, the
 * devices the run is about to revoke) until the server accepts one (commitRotation clears it once a revocation is on the
 * record), so that a run that stops between the two (a failure, a lock, the page closing) leaves the Sync section saying
 * so: "revoked, keys not rotated", or, when no revocation is on the record, "may not have finished". `waits`: why the
 * rotation could not be prepared when the run revoked without it (a failure code: not_synced, review_needed, ...).
 */
export async function noteRotationOwed(
  e: SyncEngine,
  o: { targets: readonly string[]; waits?: string | null },
): Promise<OwedRotation> {
  const { cur } = await openVault(e); // the key this device holds now (a revocation needs the open vault anyway)
  const before = (await e.state.read()).state.rotationOwed ?? null;
  await e.state.update(() => ({
    rotationOwed: {
      at: e.deps.now(),
      vkId: cur.vk.id,
      targets: [...o.targets],
      revoked: false,
      after: null,
      waits: o.waits ?? null,
    },
  }));
  return {
    undo: async () => {
      await e.state.update(() => ({ rotationOwed: before }));
    },
    revoked: async (after) => {
      await e.state.update((s) =>
        s.rotationOwed
          ? { rotationOwed: { ...s.rotationOwed, revoked: true, after: after ?? s.rotationOwed.after ?? null } }
          : null,
      );
    },
  };
}

/** §2.4: every device name (revoked ones too) re-encrypted under the new VK; a name that does not open is left out. */
async function reencryptNames(
  e: SyncEngine,
  signer: DeviceSigner,
  vaultId: string,
  from: Vk,
  to: Vk,
): Promise<{ device_id: string; name_ct: NameCtWire }[]> {
  const list = await e.api.devices(signer);
  const out: { device_id: string; name_ct: NameCtWire }[] = [];
  for (const dv of list.devices) {
    if (!dv.name_ct) continue;
    try {
      const name = await openDeviceName(from, { vaultId, deviceId: dv.device_id }, dv.name_ct);
      out.push({
        device_id: dv.device_id,
        name_ct: await sealDeviceName(to, { vaultId, deviceId: dv.device_id }, name, e.deps.rng),
      });
    } catch {
      // under another key, or damaged: the server keeps what it has for that device
    }
  }
  return out;
}

// ---- §4.2 repair the cloud from this device (keys_behind, and the server back on an older VK) ----------------------

/**
 * The server's keys are older than this device's (§4.2, §3.9 R1, N24, N27), and this device publishes its own keyring
 * again at publishKver, so every device that synced takes it. `oldPassword` opens the server's (older) bundle (the
 * pw_auth its verifier matches); `password` is the current one, which opens the local keyring. The recovery code is the
 * one of the local keyring, typed (I9: never stored) and checked here first, and so is the current password: the new
 * password verifier is computed from it, and a verifier the keys do not match would leave every device's pw_auth refused
 * (revoking among them) until a reset with the recovery code. Every local check comes before anything is sent. Then the
 * revocations a restore of the server undid are done again (revokeAgain: `revokeAgain` are the ones the page showed).
 * Two cases, told apart by the key the pre-send check verified the server's bundle with:
 *   - keys_behind (the same VK): PUT /v1/keys with the local keyring;
 *   - server_older_key (the server's VK is one this device's previous list really unwraps, §4.2 step 2, an honest
 *     restore of the server to before a rotation): POST /v1/keys/rotate without a new VK (republishOverOlderKey), which
 *     puts this device's VK and K_write back on the server.
 */
/** What the repair is given: the typed secrets, and the devices the page showed it would revoke again (revokeAgain). */
export type RepairInput = {
  oldPassword: string;
  password: string;
  recoveryCode: string;
  revokeAgain?: readonly string[];
};

/** repairKeys, holding sixkey-sync like a round (M3RR-4). */
export async function repairKeys(e: SyncEngine, o: RepairInput): Promise<void> {
  return holdingSync(e, () => repairKeysHeld(e, o));
}

async function repairKeysHeld(e: SyncEngine, o: RepairInput): Promise<void> {
  const c = await context(e);
  const pre = await preSend(e, c, "repair", { password: o.oldPassword });
  const server = pre.verified.bundle;
  const local = c.cur.gen.keyring;
  let opened: Vk;
  try {
    opened = await unlockWithRecoveryCode(local, o.recoveryCode);
  } catch {
    throw new KeyOpError("invalid_recovery_code");
  }
  if (opened.id !== c.cur.vk.id) throw new KeyOpError("invalid_recovery_code");
  const byPassword = await unlockWithPassword(local, o.password).catch(() => null);
  if (!byPassword || byPassword.id !== c.cur.vk.id) throw new KeyOpError("wrong_secret");
  // P4: the auth goes with the password wrap. The local wrap is the server's: its auth. Otherwise the auth this device
  // adopted with its own wrap (the pins' adopted.auth), or a new one.
  const samePw = sameWrapBytes(wrapOf(local, "password"), wrapOf(server.keyring, "password"));
  const auth = samePw
    ? server.auth
    : c.adoptedAuth && canonicalJson(c.adoptedAuth) !== canonicalJson(server.auth)
      ? c.adoptedAuth
      : newBundleAuth(wrapOf(local, "password")!.kdf!.salt, e.deps.rng);
  const now = hourNow(e);
  const sealed = await sealBundle(c.cur.vk, {
    vaultId: server.vaultId,
    kver: publishKver(server.kver, c.maxSeenKver),
    keyring: local,
    auth,
    by: c.id.deviceId,
    now,
  });
  const need = requiredVerifiers(server, sealed.bundle);
  const older = pre.verified.vk.id !== c.cur.vk.id;
  // §4.2 step 2: the server is back on a VK this device's previous list unwraps (the pre-send check verified the
  // server's bundle with it). Every wrap differs from that VK's, so P4 asks for both verifiers.
  if (older && (!need.recoveryVerifier || !need.passwordVerifier)) throw new KeyOpError("invalid_bundle");
  await revokeAgain(e, c, pwAuth(pre.proof), o.revokeAgain ?? []);
  if (older) {
    const epoch = await republishOverOlderKey(e, c, pre.verified, sealed, {
      password_auth: pwAuth(pre.proof),
      recovery_verifier: (await recoveryProof(o.recoveryCode)).recoveryVerifier,
      password_verifier: (await passwordProof(o.password, auth.kdf)).passwordVerifier,
    });
    await commitPublished(e, pre.verified, sealed.bundle, c.cur.vk, { password: o.password }, null, epoch);
    return;
  }
  // P4 decides both verifiers (the openapi's repair note says recovery_verifier "from a typed recovery code": that holds
  // when the rollback crossed a recovery-code change; when the recovery wrap is the server's, P4 forbids it and the typed
  // code is only checked here, N24; docs/design/notes/M3-NOTES.md §8).
  const body: {
    if_kver: number;
    bundle: string;
    password_auth: string;
    recovery_verifier?: string;
    password_verifier?: string;
  } = {
    if_kver: server.kver,
    bundle: sealed.raw,
    password_auth: pwAuth(pre.proof),
  };
  if (need.recoveryVerifier) body.recovery_verifier = (await recoveryProof(o.recoveryCode)).recoveryVerifier;
  if (need.passwordVerifier) body.password_verifier = (await passwordProof(o.password, auth.kdf)).passwordVerifier;
  // Reconciled by the exact bundle: a repair is in effect only while the server holds the very text this device sent.
  await sendKeyOp(
    e,
    c,
    server,
    async (srv) => srv.mac === sealed.bundle.mac,
    () => e.api.putKeys(c.signer, body),
  );
  await commitPublished(e, pre.verified, sealed.bundle, c.cur.vk, { password: o.password }, null, c.epoch);
}

/**
 * Before the repair sends its keys: the revocations a restore of the server undid, done again. A restore to before a
 * rotation is also a restore to before the revocation that rotation may have followed (§3.10, a device "lost or
 * stolen"); that device is active on the restored server again, and over an older VK it holds that key, which the
 * republished keyring's previous list opens: the repair would hand it the newer keys. Which devices: those this device
 * has seen revoked (the stored list, where a revocation is sticky: undoneRevocations) that the restored server lists as
 * active. They must all be among those the page showed (`shown`, from revokedBeforeRestore, the same rule): another one
 * refuses with "stale" before anything is sent, and the page shows the list again. Each is revoked with the pw_auth the
 * pre-send check computed (§3.14: revoking is never blocked), only while the vault is still open under the key the
 * repair was built for (a lock since refuses, and nothing more is sent), then recorded as any revocation is, marked
 * revoked here, and counted in one notice. A refusal or a network error stops the repair before its keys are sent
 * ("offline": a revocation whose answer was lost may have taken effect, which is safe, and the next repair lists only
 * the devices still active).
 */
async function revokeAgain(e: SyncEngine, c: Ctx, passwordAuth: string, shown: readonly string[]): Promise<void> {
  const stored = (await e.state.read()).state.devices;
  if (!stored?.some((d) => d.revoked)) return;
  const asKeyOp = (err: unknown): never => {
    throw err instanceof NetworkError
      ? new KeyOpError("offline")
      : err instanceof ApiError
        ? new KeyOpError(err.code)
        : err;
  };
  const list = await e.api.devices(c.signer).catch(asKeyOp);
  const again = undoneRevocations(
    stored,
    list.devices.map((d) => ({ id: d.device_id, revoked: d.revoked_at !== null })),
    c.id.deviceId,
  );
  if (again.some((id) => !shown.includes(id))) throw new KeyOpError("stale");
  const at = e.deps.now();
  let n = 0;
  for (const id of again) {
    await stillOpen(e, c.cur.vk.id);
    await e.api.revoke(c.signer, id, passwordAuth).catch(asKeyOp);
    await e.deps.flows.recordAction("device_revoked");
    await e.state.rememberRevoked(id);
    await e.state.notice({ kind: "device_revoked", at, n: ++n }); // one notice, its count kept at every step
  }
}

/** How many times the repair over an older VK builds its upload again for a head another device moved meanwhile. */
const OLDER_KEY_TRIES = 3;

/**
 * §4.2's repair when the server is back on an older VK (server_older_key; docs/design/notes/M6C-NOTES.md §1 states
 * the rule as built): POST /v1/keys/rotate that changes no key here. The server takes this device's VK back (`vk_id`),
 * its K_write (`new_write_key`), its keyring under its auth (`sealed`, built once by the caller: every send of this repair
 * carries the identical bundle text, so a send whose answer was lost comes back as the server's idempotent 200), and
 * every device name re-encrypted under it. The write proof is the restored server's: K_write of `verified.vk`, the older
 * VK the pre-send check verified the server's bundle with.
 *
 * The envelope is this device's vault, encrypted under its VK at the server's version + 1. The server's head is under
 * the older VK and is not merged into it: a remote version under a previous VK is never merged automatically (§4.3 R5,
 * §4.6), and a restore to before a rotation may also have undone the revocation the rotation followed, so that device
 * could have written to that head. The head stays in the server's history for as long as §5.8 keeps it (the newest 30
 * versions plus each UTC day's last for 30 days, within 64 MiB), where find accounts opens versions under the previous
 * keys this device holds; and a device that holds only the older VK brings its own writes when it takes this VK (§3.9 R3
 * merges its local data).
 *
 * Each pass reads the vault (still open under the key it was built for: a lock since refuses) and the status: the
 * server's keys moved since the check means this very repair landed (an answer lost) or another change won, decided by
 * the exact bundle; a version_conflict (a device still on the older VK wrote meanwhile) builds the upload again for the
 * new head, a bounded number of times. Returns the lock epoch read just before the last pass's open-vault check, for
 * the commit's session.
 */
async function republishOverOlderKey(
  e: SyncEngine,
  c: Ctx,
  verified: VerifiedServerBundle,
  sealed: { bundle: KeyBundle; raw: string },
  proofs: { password_auth: string; recovery_verifier: string; password_verifier: string },
): Promise<number> {
  const server = verified.bundle;
  const vaultId = server.vaultId;
  const older = verified.vk;
  const mine = c.cur.vk;
  const newWriteKey = await writeKey(mine);
  const sent = async (srv: KeyBundle) => srv.mac === sealed.bundle.mac;
  const asKeyOp = (err: unknown): never => {
    throw err instanceof NetworkError
      ? new KeyOpError("offline")
      : err instanceof ApiError
        ? new KeyOpError(err.code)
        : err;
  };
  for (let tries = 0; tries < OLDER_KEY_TRIES; tries++) {
    const open = await openVault(e);
    if (open.cur.vk.id !== mine.id) throw new KeyOpError("stale"); // the keys changed here since the check
    const s = await e.api.status(c.signer).catch(asKeyOp);
    if (versionBelow(e.deps.clientVersion, s.min_client_version)) throw new KeyOpError("update_required");
    if (s.vk_id !== older.id || s.kver !== server.kver) {
      const k = await e.api.getKeys(c.signer).catch(asKeyOp);
      let held: KeyBundle | null = null;
      try {
        held = parseBundleText(k.bundle);
      } catch {
        held = null;
      }
      if (held && s.vk_id === mine.id && (await sent(held))) return open.epoch; // this repair, its answer lost
      throw new KeyOpError("changed_elsewhere");
    }
    const up = await uploadEnvelope(open.cur.vault, mine, { vaultId, rev: s.version + 1 }, e.deps.rng);
    if (!fitsEnvelopeLimit(up.text)) throw new KeyOpError("too_large");
    const body = {
      if_version: s.version,
      if_kver: server.kver,
      envelope: up.text,
      write_proof: await writeProof(older, { vaultId, ifVersion: s.version, checksum: up.envelope.checksum }),
      new_write_key: newWriteKey,
      bundle: sealed.raw,
      ...proofs,
      device_names: await reencryptNames(e, c.signer, vaultId, older, mine),
    };
    try {
      await sendKeyOp(e, c, server, sent, () => e.api.rotate(c.signer, body), true);
      return open.epoch;
    } catch (err) {
      if (err instanceof KeyOpError && err.code === "conflict") continue; // the head moved: build the upload again
      throw err;
    }
  }
  throw new KeyOpError("version_conflict");
}

// ---- §3.10, §3.14: revoke, rename, reject all, clear history, turn sync off --------------------------------------

/** The server's keys at a moment: the vault key's id and the bundle's kver. */
export type ServerKeys = { vkId: string; kver: number };

/**
 * Revoke a device (§3.10). Never blocked: not by keys_behind (the pre-send check lets it through, against the server's
 * bundle), nor by an update the server requires, nor by anything that stops a round or a rotation. Returns the server's
 * keys just after the revocation (a status query; the pre-send check's bundle when that fails): a rotation with a higher
 * kver came after it, so the revoked device cannot have fetched it.
 */
export async function revokeDevice(e: SyncEngine, deviceId: string, password: string): Promise<ServerKeys> {
  const c = await context(e, { gate: false }); // never blocked, update_required included (§3.14; a design-owner question)
  const pre = await preSend(e, c, "revoke", { password });
  await apiOp(() => e.api.revoke(c.signer, deviceId, pwAuth(pre.proof)));
  await e.deps.flows.recordAction("device_revoked");
  await e.state.rememberRevoked(deviceId); // in the stored list at once (the repair after a restore revokes again what it undid)
  const s = await e.api.status(c.signer).catch(() => null);
  return s
    ? { vkId: s.vk_id, kver: s.kver }
    : { vkId: pre.verified.bundle.keyring.vkId, kver: pre.verified.bundle.kver };
}

/**
 * Before revoking `deviceId` (§3.10): whether the current KeyBundle is the one that device wrote (`by`, read from the bundle
 * the pre-send check verified with the password). Then "I still control it" is not offered: it may have planted a
 * recovery code, so only the "protect" way (revoke, then rotate) is.
 */
export async function revokeNeedsProtect(e: SyncEngine, deviceId: string, password: string): Promise<boolean> {
  const c = await context(e, { gate: false });
  const pre = await preSend(e, c, "revoke", { password });
  return pre.verified.bundle.by === deviceId;
}

/**
 * §4.10 "make this profile a separate device" (the forked notice: this profile is a copy of another one, a clone or a
 * vendor's sync): with the master password (pw_auth, so that a copy of the device's credentials alone cannot breed new
 * devices), POST /v1/devices/fork signed by the current device, with a new device id and signing key whose possession
 * the second signature proves (S5); the server makes a new row approved by the original. Then the local half
 * (SyncLocal.switchIdentity): the new device's copy and identity, with this one's pins (the same vault and keys), a new
 * device suffix for this profile's edits, lastSynced cleared. The original copy keeps the original identity.
 */
export async function forkDevice(e: SyncEngine, password: string, name: string): Promise<void> {
  const nm = checkDeviceName(name);
  if (!nm.ok) throw new KeyOpError("invalid_device_name");
  return holdingSync(e, async () => {
    const c = await context(e);
    const pre = await preSend(e, c, "fork", { password });
    const vaultId = c.cur.gen.keyring.vaultId;
    const rng = e.deps.rng ?? randomBytes;
    const key = await generateDeviceKey();
    const publicKey = await crypto.subtle.importKey(
      "spki",
      bs(key.spki),
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    const deviceId = newDeviceId(rng);
    const { plain } = await e.deps.local.cfg.open(vaultId, c.cur.vk);
    const nameCt = await sealDeviceName(pre.verified.vk, { vaultId, deviceId }, nm.name, rng);
    await apiOp(() =>
      e.api.fork(c.signer, key.privateKey, {
        new_device_id: deviceId,
        new_sig_pubkey: toB64(key.spki),
        name_ct: nameCt,
        password_auth: pwAuth(pre.proof),
      }),
    );
    const next: DeviceIdentity = {
      ...c.id,
      deviceId,
      keyPair: { privateKey: key.privateKey, publicKey },
      state: "enrolled",
    };
    await e.deps.local.switchIdentity(
      c.cur.vk,
      vaultId,
      { deviceId, apiOrigin: e.deps.origin, dsk: key.jwk, email: plain.email },
      next,
    );
    await e.state.update(() => ({ devicesRev: null, stuck: null }));
  });
}

/**
 * §3.12, O14: delete the sync account on the server. Three things together, as the server requires: this device's
 * signature, an account session from a fresh one-time code (the server checks it is new and this device's account) and
 * pw_auth. The server deletes the account's vault, history and devices (§5.7); the local data of every device stays.
 * This device's own sync identity is not touched here: the caller removes it next (removeSyncIdentity, which folds what
 * it can and keeps the rest), and its page gives the API permission back, last.
 */
export async function deleteSyncAccount(e: SyncEngine, session: AccountSession, password: string): Promise<void> {
  const c = await context(e, { gate: false }); // a way out, like revoking: never blocked by a minimum version
  const pre = await preSend(e, c, "delete_account", { password });
  await apiOp(() => e.api.deleteAccount(c.signer, session, pwAuth(pre.proof)));
}

export async function renameDevice(e: SyncEngine, deviceId: string, name: string, password: string): Promise<void> {
  const c = await context(e);
  const pre = await preSend(e, c, "rename", { password });
  const nameCt = await sealDeviceName(
    pre.verified.vk,
    { vaultId: pre.verified.bundle.vaultId, deviceId },
    name,
    e.deps.rng,
  );
  await apiOp(() => e.api.rename(c.signer, deviceId, { name_ct: nameCt, password_auth: pwAuth(pre.proof) }));
}

export async function rejectAllRequests(e: SyncEngine, password: string): Promise<number> {
  const c = await context(e, { gate: false }); // defensive, like revoking and rejecting one request: not gated (M3R-3)
  const pre = await preSend(e, c, "reject_all", { password });
  return apiOp(() => e.api.rejectAll(c.signer, pwAuth(pre.proof)));
}

export async function clearServerHistory(e: SyncEngine, password: string): Promise<number> {
  const c = await context(e);
  const pre = await preSend(e, c, "clear_history", { password });
  const n = await apiOp(() => e.api.deleteVersions(c.signer, pwAuth(pre.proof)));
  await e.deps.flows.recordAction("history_cleared");
  return n;
}

/**
 * §3.10 "turn sync off": revoke this device (pw_auth, S8), then the local half (D11). The local data and sk_prejoin stay.
 * Idempotent (M3R-8): a server that already says this device is revoked or unknown (an earlier try whose answer was lost)
 * is "revoked", and the local half is finished.
 */
export async function turnSyncOff(e: SyncEngine, password: string, o: { answer?: MergeAnswer } = {}): Promise<void> {
  const gone = (err: unknown) =>
    err instanceof KeyOpError && (err.code === "device_revoked" || err.code === "unknown_device");
  // §3.10, §4.7 (rev. 19, 20): the entries are folded into the vault that stays before anything is revoked or deleted (the
  // password was typed, the key is here); a guard block throws MergeBlocked and nothing is revoked yet; locked with an
  // unparked entry, refused (locked: unlock first, its save would go with the records); the local vault lost, vault_lost.
  // Parked entries are kept by the turn-off itself (revision 20, R3R-2), never a refusal
  const why = await e.orphanLockedOut(o.answer);
  if (why.refuse) throw new KeyOpError(why.refuse);
  try {
    const c = await context(e, { gate: false });
    const pre = await preSend(e, c, "revoke", { password });
    await apiOp(() => e.api.revoke(c.signer, c.id.deviceId, pwAuth(pre.proof)));
  } catch (err) {
    if (!gone(err)) throw err;
  }
  await e.deps.flows.turnOffSync({ folded: why.folded }); // an entry appended during the revoke stays (R4R-3)
}

/** §3.10: "remove the sync identity" for a device the server rejects (local only, no password: P5). */
export async function removeSyncIdentity(e: SyncEngine, o: { answer?: MergeAnswer } = {}): Promise<void> {
  // §4.7 (rev. 19, 20): the entries folded first when the key is here (a guard block throws MergeBlocked); locked or with
  // the local vault lost while an unparked one remains, refused; parked entries are kept by the turn-off (R3R-2)
  const why = await e.orphanLockedOut(o.answer);
  if (why.refuse) throw new KeyOpError(why.refuse); // its save would go with the records
  await e.deps.flows.turnOffSync({ folded: why.folded });
}

async function apiOp<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (err) {
    if (err instanceof ApiError) throw new KeyOpError(err.code);
    if (err instanceof NetworkError) throw new KeyOpError("unconfirmed");
    throw err;
  }
}

// ---- §3.9 R2/R3/R4/R6: the typed secret adopts the server's keys -------------------------------------------------

export type AdoptResult =
  | { kind: "adopted"; sameVk: boolean }
  | { kind: "local"; note: string } // the local keyring opened: unlock as usual (Phase 0), with the note's banner
  | { kind: "confirm_older" } // R3 (N27): ask "[use my current password] [adopt anyway]", then call again with confirmOlder
  // §4.4: the new key's remote data would erase an account alive here or change a secret. Nothing committed; show the
  // report, then call again with { answer: { seen, accept | keepMine } } (the answer holds for these remote versions only)
  | { kind: "review_needed"; report: GuardReport; seen: Readonly<Record<string, string>> }
  | { kind: "rejected"; reason: string };

/**
 * Unlocking with sync (§3.9 R3, R4 needs_password first, R6 recovery code, R2 the new password from another device, and
 * the cloud restore of §4.13 when the local vault is lost): M1's unlockWithSync on the server's current bundle, with the
 * settled pins. An adoption is committed with the very object M1 returned (commitKeys), the remote data of a new key
 * merged in the same transact (I1), and keys_adopted recorded (RR-6: a visible event). Works while locked (it is the
 * unlock); the session starts with the committed key.
 */
/** adoptWithSecret, holding sixkey-sync like a round (M3RR-4). */
export async function adoptWithSecret(
  e: SyncEngine,
  secret: UnlockSecret,
  o: { confirmOlder?: boolean; answer?: MergeAnswer } = {},
): Promise<AdoptResult> {
  return holdingSync(e, () => adoptWithSecretHeld(e, secret, o));
}

async function adoptWithSecretHeld(
  e: SyncEngine,
  secret: UnlockSecret,
  o: { confirmOlder?: boolean; answer?: MergeAnswer },
): Promise<AdoptResult> {
  const d = e.deps;
  const st = await d.local.status();
  const gen = await d.flows.generation();
  // cfg_missing only for the cloud restore (§4.13: the local vault is lost); with a readable vault it is an unfinished
  // turn-off, never a place to adopt or sign (RR-10)
  const id = st.kind === "on" || (st.kind === "cfg_missing" && gen === null) ? st.identity : null;
  if (!id) throw new KeyOpError("not_enrolled");
  const signer: DeviceSigner = { kind: "device", deviceId: id.deviceId, key: id.keyPair.privateKey };
  const local = gen?.keyring ?? null;
  await versionGate(e, signer); // M3R-3
  const k = await apiOp(() => e.api.getKeys(signer));
  let remote: KeyBundle;
  try {
    remote = parseBundleText(k.bundle);
  } catch {
    return { kind: "rejected", reason: "invalid_bundle" };
  }
  const view = await e.state.read();
  // R4's order (needs_password: the server's bundle first) from what is true now, not from the last round's stored status,
  // which an offline round may have overwritten (M3R-14): the server's key is not the local one, or the pin is ahead of it.
  const rotated =
    local !== null && (remote.keyring.vkId !== local.vkId || (id.vkId !== null && id.vkId !== local.vkId));
  const r = await unlockWithSync({
    secret,
    local,
    remote,
    pinnedVkId: id.vkId,
    maxSeenKver: id.maxSeenKver,
    needsPassword: rotated || view.state.status === "needs_password",
    ...(o.confirmOlder ? { confirmedOlder: true } : {}),
    expectedVaultId: local?.vaultId ?? id.vaultId ?? remote.vaultId,
    adoptedAuth: id.adopted?.auth ?? null,
    adoptedDigest: id.adopted?.digest ?? null,
  });
  if (r.kind === "confirm_older") return r;
  if (r.kind === "reject") {
    // a master password or recovery code that opens nothing here or on the server: a wrong guess, recorded as Phase 0's
    // unlock records one (security-log.ts; the count the next unlock reports), whichever form took it
    if (r.reason === "wrong_secret")
      await d.flows.recordAction("password" in secret ? "unlock_failed" : "recovery_failed");
    return { kind: "rejected", reason: r.reason };
  }
  if (r.kind === "local") {
    if (r.pin !== id.vkId && id.vkId !== null) await d.local.identity.update((i) => ({ ...i, vkId: r.pin })); // D8 forward, after the settle
    return { kind: "local", note: r.note };
  }
  // The new key's remote data, merged in the same transact as the keyring (§3.9 R3); under the same key as the local data
  // there is nothing to merge here (the next round pulls it). M1's sameVk is "the pinned key", not the local one (GM2-5).
  const newKey = local === null || r.vk.id !== local.vkId;
  let remoteVault = undefined;
  if (newKey) {
    const v = await apiOp(() => e.api.getVault(signer));
    const opened = await openRemote(v.envelope, r.vk, r.bundle.vaultId);
    if (opened.kind === "newer_schema") return { kind: "rejected", reason: "paused_newer" };
    if (opened.kind !== "ok") {
      if (local === null) return { kind: "rejected", reason: "remote_unreadable" };
    } else remoteVault = opened.vault;
  }
  await d.local.settlePins();
  try {
    await d.flows.commitKeys({
      keys: r,
      ...(remoteVault ? { remote: remoteVault } : {}),
      ...(local === null ? { overLost: true } : {}),
      ...(o.answer ? { answer: o.answer } : {}),
      record: "keys_adopted",
    });
  } catch (err) {
    if (err instanceof MergeBlocked) return { kind: "review_needed", report: err.report, seen: err.seen }; // C1: nothing kept
    if (err instanceof ServiceError && err.code === "bad_state" && err.message === "stale")
      return { kind: "rejected", reason: "stale" };
    if (err instanceof ServiceError)
      return { kind: "rejected", reason: err.message === "discontinuous" ? "discontinuous" : err.code };
    throw err;
  }
  await e.state.notice({ kind: "keys_changed", at: d.now() });
  // §4.7 (rev. 19, 20): a new key (R3, the cloud restore) re-keys the vault: the entries are folded now that the key is
  // here (they open through the new keyring's previous list, or by the new key: FIXa2); a guard block is left for the round
  if (newKey)
    await e.foldForFlow(o.answer).catch((err: unknown) => {
      if (!(err instanceof MergeBlocked)) throw err;
    });
  return { kind: "adopted", sameVk: !newKey };
}
