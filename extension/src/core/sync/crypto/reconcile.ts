// §3.6.0 (F2, S4): after a network error, timeout, 5xx or 409 on a key operation, GET /v1/keys and judge by the part this
// device changed, not the whole bundle: another device may already have built on it. Until this says "failed", the UI
// never tells the user a new recovery code is invalid.
import { sha256, toB64 } from "../../crypto/bytes";
import { openKeyring } from "./bundle-eval";
import { b64 } from "./encoding";
import { sameWrapBytes, wrapOf, type KeyBundle } from "./keybundle";

export type SubmittedKeyOp =
  | { kind: "change_recovery"; bundle: KeyBundle }
  | { kind: "change_password"; bundle: KeyBundle; newPassword: string }
  | { kind: "rotate"; bundle: KeyBundle };

export type ServerKeys = { bundle: KeyBundle; vkId: string }; // GET /v1/keys, and vk_id from the status

/** True: the operation took effect (possibly with later changes on top). False: it did not. */
export async function reconcileKeyOp(sub: SubmittedKeyOp, server: ServerKeys): Promise<boolean> {
  const mine = sub.bundle.keyring;
  const theirs = server.bundle.keyring;
  switch (sub.kind) {
    case "change_recovery":
      return sameWrapBytes(wrapOf(mine, "recovery"), wrapOf(theirs, "recovery"));
    case "change_password":
      if (sameWrapBytes(wrapOf(mine, "password"), wrapOf(theirs, "password"))) return true;
      // a later bundle built on mine: the new password opens the server's current password wrap
      return theirs.vkId === mine.vkId && (await openKeyring(theirs, { password: sub.newPassword })) !== null;
    case "rotate":
      return server.vkId === mine.vkId;
  }
}

/** Kept in sk_sync_state while a recovery-code change is unconfirmed: SHA-256(iv || wrapped), no secret (§3.6.0). */
export async function recoveryWrapFingerprint(bundle: KeyBundle): Promise<string> {
  const w = wrapOf(bundle.keyring, "recovery")!;
  return toB64(await sha256(b64(w.iv), b64(w.wrapped)));
}

/** Later syncs: "the recovery code generated on this device at {time} is in effect" or "did not take effect". */
export async function recoveryWrapInEffect(server: KeyBundle, fingerprint: string): Promise<boolean> {
  return (await recoveryWrapFingerprint(server)) === fingerprint;
}
