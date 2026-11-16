// Proofs the server checks without learning the secret behind them (§2.2, §3.3, §3.14). pw_auth is stretched with its
// own salt (KeyBundle.auth.kdf), so it never equals the password KEK; recAuth has its own label, so it never opens the
// recovery wrap. Both are computed from what the user just typed and never stored.
import { toB64, utf8 } from "../../crypto/bytes";
import { assertKdfParams, hkdfBits, normalizePassword, pbkdf2Bits, type Pbkdf2Params } from "../../crypto/kdf";
import { parseRecoveryCode } from "../../crypto/recovery-code";
import { b64 } from "./encoding";
import { SyncCryptoError } from "./errors";
import { LABEL, TAG } from "./labels";
import { NO_SALT, taggedDigest } from "./subkeys";

/** Both values standard base64: password_auth is sent with sensitive requests, password_verifier when the password wrap changes. */
export type PasswordProof = { passwordAuth: string; passwordVerifier: string };
export type RecoveryProof = { recoveryAuth: string; recoveryVerifier: string };

/** pw_auth = HKDF(PBKDF2-SHA256(NFKC(pw), salt_auth, iterations, 256), empty, 'sixkey/v1/password-auth', 256) (§3.14). */
export async function passwordProof(password: string, kdf: Pbkdf2Params): Promise<PasswordProof> {
  assertKdfParams(kdf); // read-time bounds: the server picks nothing here
  if (kdf.name !== "PBKDF2") throw new SyncCryptoError("invalid_argument", "pw_auth needs PBKDF2");
  const stretched = await pbkdf2Bits(utf8(normalizePassword(password)), b64(kdf.salt), kdf.iterations, 256);
  const auth = await hkdfBits(stretched, NO_SALT, LABEL.passwordAuth, 256);
  stretched.fill(0);
  const out = { passwordAuth: toB64(auth), passwordVerifier: toB64(await taggedDigest(TAG.passwordVerifier, auth)) };
  auth.fill(0);
  return out;
}

/** recAuth = HKDF(secret128, empty, 'sixkey/v1/recovery-auth', 256); verifier = SHA-256(tag || recAuth) (§2.2, §3.3). */
export async function recoveryProofFromSecret(secret: Uint8Array): Promise<RecoveryProof> {
  if (!(secret instanceof Uint8Array) || secret.length !== 16)
    throw new SyncCryptoError("invalid_argument", "recovery secret must be 16 bytes");
  const auth = await hkdfBits(secret, NO_SALT, LABEL.recoveryAuth, 256);
  const out = { recoveryAuth: toB64(auth), recoveryVerifier: toB64(await taggedDigest(TAG.recoveryVerifier, auth)) };
  auth.fill(0);
  return out;
}

/** From the typed code; Phase 0 parseRecoveryCode reports typos (recovery_length / recovery_char / recovery_checksum). */
export async function recoveryProof(code: string): Promise<RecoveryProof> {
  const secret = await parseRecoveryCode(code);
  try {
    return await recoveryProofFromSecret(secret);
  } finally {
    secret.fill(0);
  }
}
