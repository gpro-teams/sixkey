// §3.14 pre-send check: an honest client never sends a wrong pw_auth, never builds a key operation on a bundle it must
// not build on, and blocks what keys_behind blocks, all before any request leaves the device. Its success value, a
// VerifiedServerBundle, is what the respond / approve (and, from M3, PUT /v1/keys and rotate) builders require (F-09).
// published() turns a key operation the server accepted into the capability M2's commitKeys takes (§0.0i item 16).
import type { Keyring } from "../../crypto/keyring";
import type { Vk } from "../../crypto/vk";
import { unwrapPreviousVks } from "../../crypto/keyring";
import {
  allowedWhileKeysBehind,
  classifyKver,
  decideSameVk,
  previousCovers,
  publishesBundle,
  type BundleRejection,
  type SensitiveOp,
} from "./adoption";
import { passwordProof, recoveryProof } from "./auth-proofs";
import { openKeyring, realPrevious, unwrappedPreviousIds, type UnlockSecret } from "./bundle-eval";
import { issue } from "./capability";
import { canonicalJsonStrict } from "./encoding";
import { SyncCryptoError } from "./errors";
import {
  adoptedRecord,
  bundleHasUnknownFields,
  parseBundleText,
  sameKeyring,
  sameWrap,
  verifyBundleMac,
  wrapOf,
  type BundleAuth,
  type KeyBundle,
} from "./keybundle";

export type PreSendInput = {
  op: SensitiveOp;
  serverRaw: string; // the bundle text GET /v1/keys just returned
  secret: UnlockSecret; // typed for this operation; the recovery-code version is §3.14 S6
  local: Keyring;
  vk: Vk; // this device's unlocked VK
  maxSeenKver: number;
  expectedVaultId: string; // this account's vaultId (F-03)
  adoptedAuth: BundleAuth | null; // identity's adopted.auth (F-07)
  adoptedDigest: string | null; // identity's adopted.digest (GM2-5): "the same content" also when it matches
};

/**
 * The server's current bundle, its exact text, the VK it is under (this device's, or a previous one when the server went
 * back), the operation it was checked for, and whether the device is behind it. Only preSendCheck makes these: they are
 * frozen and registered, so a hand-built or copied object is refused by every builder.
 */
export type VerifiedServerBundle = Readonly<{
  raw: string;
  bundle: KeyBundle;
  vk: Vk;
  op: SensitiveOp;
  keysBehind: boolean;
}>;

const ISSUED = new WeakSet<object>();
/** The local keyring each VerifiedServerBundle was checked against (a copy): what a published() capability is bound to (RR-1). */
const JUDGED = new WeakMap<object, Keyring>();
export const isVerifiedServerBundle = (x: unknown): x is VerifiedServerBundle =>
  typeof x === "object" && x !== null && ISSUED.has(x);

export type PreSendRefusal =
  | "invalid_bundle" // the text is not a valid bundle
  | "wrong_secret"
  | "password_changed_elsewhere" // the local (old) wrap opens, the server's newer one does not: ask for the new password
  | "old_password_required" // the server went back past a password change: the password of that time is needed (§4.2)
  | "needs_adoption" // the server is on a VK this device has not adopted (unlock through R3 first, P9), or, for what publishes or hands out a bundle, holds what this device last committed while the local keyring differs (GM2-5: adopt it back first)
  | "keys_behind" // N27: this operation waits for the repair
  | "not_behind" // a repair would overwrite a server state that is not older than this device's (M1-5)
  | "update_required" // unknown members: no key operation may be built on this bundle (§2.3)
  | BundleRejection;

export type PreSendResult =
  | { ok: true; proof: { password_auth: string } | { recovery_auth: string }; verified: VerifiedServerBundle }
  | { ok: false; reason: PreSendRefusal };

/**
 * R0 first: parse, vaultId, MAC (with this device's VK, or the previous VK the server went back to); only then R1/R2 and
 * the keys_behind gate. Then the typed secret must open this bundle's wrap, and only then the proof, from this bundle's
 * auth.kdf. In keys_behind the allowed operations prove against the server's current bundle, which its verifier matches.
 */
export async function preSendCheck(i: PreSendInput): Promise<PreSendResult> {
  if (i.local.vkId !== i.vk.id) throw new SyncCryptoError("invalid_argument", "the VK is not the local keyring's");
  const refuse = (reason: PreSendRefusal): PreSendResult => ({ ok: false, reason });
  let server: KeyBundle;
  try {
    server = parseBundleText(i.serverRaw);
  } catch {
    return refuse("invalid_bundle");
  }
  if (server.vaultId !== i.expectedVaultId || i.local.vaultId !== i.expectedVaultId) return refuse("wrong_vault");
  const sameVk = server.keyring.vkId === i.vk.id;
  const macVk = sameVk ? i.vk : (await unwrapPreviousVks(i.local, i.vk)).find((v) => v.id === server.keyring.vkId);
  if (!macVk) return refuse("needs_adoption");
  if (!(await verifyBundleMac(macVk, server))) return refuse("bad_mac");

  // §0.0i M1 changes 1, 2 (GM2-5): the server holds what this device itself last committed (adopted.digest) while the
  // local keyring differs (a local commit lost). Not keys_behind, whose only button, the repair, would publish the old
  // wraps over the user's own change: what publishes or hands out a bundle (the repair too) waits until the device has
  // adopted it back. Everything else goes ahead as in keys_behind, against the server's bundle, whose MAC is verified and
  // whose auth matches the server's verifier: emergency revocation is never blocked (§3.9 R1, M2R-2).
  const adoptedBack = i.adoptedDigest !== null && (await adoptedRecord(server)).digest === i.adoptedDigest;
  const adoptBack = adoptedBack && !sameKeyring(i.local, server.keyring);
  if (adoptBack && (publishesBundle(i.op) || !allowedWhileKeysBehind(i.op))) return refuse("needs_adoption");
  const kver = classifyKver(
    server.kver,
    i.maxSeenKver,
    sameVk && (sameKeyring(i.local, server.keyring) || adoptedBack),
  );
  const behind = adoptBack || !sameVk || kver.outcome === "keys_behind";
  if (behind && !allowedWhileKeysBehind(i.op)) return refuse("keys_behind");
  if (i.op === "repair" && !behind) return refuse("not_behind");
  if (i.op !== "repair" && publishesBundle(i.op) && bundleHasUnknownFields(server)) return refuse("update_required");
  if (!behind) {
    const authSame =
      i.adoptedAuth === null ? null : canonicalJsonStrict(i.adoptedAuth) === canonicalJsonStrict(server.auth);
    if (kver.outcome === "in_sync" && authSame === false) return refuse("auth_without_password");
    if (kver.outcome === "adopt_candidate") {
      const d = decideSameVk({
        macValid: true,
        previousCovers: previousCovers(
          await realPrevious(i.local, i.vk),
          await unwrappedPreviousIds(server.keyring, macVk),
          true,
        ),
        passwordWrapSame: sameWrap(wrapOf(i.local, "password"), wrapOf(server.keyring, "password")),
        authSame,
      });
      if (d.kind === "reject") return refuse(d.reason);
    }
  }

  const opened = await openKeyring(server.keyring, i.secret);
  if (!opened) {
    const localOpens =
      "password" in i.secret &&
      !sameWrap(wrapOf(i.local, "password"), wrapOf(server.keyring, "password")) &&
      (await openKeyring(i.local, i.secret)) !== null;
    // adopted back: the server's wrap is this device's own newer one, so the old password is the stale one
    return refuse(
      !localOpens ? "wrong_secret" : behind && !adoptBack ? "old_password_required" : "password_changed_elsewhere",
    );
  }
  const proof =
    "password" in i.secret
      ? { password_auth: (await passwordProof(i.secret.password, server.auth.kdf)).passwordAuth }
      : { recovery_auth: (await recoveryProof(i.secret.recoveryCode)).recoveryAuth };
  const verified: VerifiedServerBundle = Object.freeze({
    raw: i.serverRaw,
    bundle: server,
    vk: macVk,
    op: i.op,
    keysBehind: behind,
  });
  ISSUED.add(verified);
  JUDGED.set(verified, structuredClone(i.local));
  return { ok: true, proof, verified };
}

/**
 * A key operation this device built, sent and the server accepted (§3.6–§3.8 step "then the local transact", §4.2's
 * repair: a 200, or §3.6.0's reconcileKeyOp true), as the capability M2's commitKeys takes for it (§0.0i item 16). Call it
 * only then: before that the operation may not have happened.
 */
export type Published = Readonly<{ kind: "published"; bundle: KeyBundle; maxSeenKver: number }>;

/**
 * Published, only from the VerifiedServerBundle the operation was checked against (an operation that publishes a bundle)
 * and the bundle this device sent: the same vault, MACed under `vk`, a kver above the server's, continuous with the
 * server's bundle (the same VK keeping every real previous entry; a rotation, or a repair over an older VK, whose previous
 * list really unwraps the server's VK and keeps the rest but for the 64-entry cap), and opened by `secret`, the secret it
 * was built with (the new password, the new recovery code, or the password of a rotation): the lock-out guard. It is
 * bound to the local keyring the pre-send check saw (RR-1: committed over any other, it is stale). `held`:
 * old VKs the cleanup needs beyond the new keyring's previous list (default: the server bundle's VK when it changes).
 * Throws invalid_argument otherwise. One KDF when `secret` is a password.
 */
export async function published(o: {
  verified: VerifiedServerBundle;
  sent: KeyBundle;
  vk: Vk;
  secret: UnlockSecret;
  held?: readonly Vk[];
}): Promise<Published> {
  const bad = (m: string): never => {
    throw new SyncCryptoError("invalid_argument", m);
  };
  if (!isVerifiedServerBundle(o.verified) || !publishesBundle(o.verified.op))
    bad("not a key operation checked by preSendCheck");
  const server = o.verified.bundle;
  const sent = o.sent;
  if (sent.keyring.vkId !== o.vk.id || sent.vaultId !== server.vaultId || sent.keyring.vaultId !== server.vaultId)
    bad("not the bundle's VK or vault");
  if (!(await verifyBundleMac(o.vk, sent))) bad("bad mac");
  if (sent.kver <= server.kver) bad("not above the server's kver");
  const sameVk = o.vk.id === o.verified.vk.id;
  if (o.verified.op === "rotate" ? sameVk : !sameVk && o.verified.op !== "repair")
    bad("a rotation changes the VK, nothing else does");
  const ids = await unwrappedPreviousIds(sent.keyring, o.vk);
  if (!sameVk && !ids.has(server.keyring.vkId)) bad("discontinuous");
  if (!previousCovers(await realPrevious(server.keyring, o.verified.vk), ids, sameVk)) bad("previous_dropped");
  if ((await openKeyring(sent.keyring, o.secret))?.id !== o.vk.id) bad("the secret does not open the bundle");
  const p: Published = { kind: "published", bundle: sent, maxSeenKver: sent.kver };
  return issue(p, {
    bundle: sent,
    vk: o.vk,
    held: o.held ?? (sameVk ? [] : [o.verified.vk]),
    maxSeenKver: sent.kver,
    basis: "built_here",
    base: JUDGED.get(o.verified)!,
  });
}
