// Errors thrown by core/sync/crypto. The message is the code or a fixed phrase, never input data, so no key bytes,
// password, code or plaintext can reach a log or the UI through an error. Phase 0 CryptoErrors pass through unchanged.
export type SyncCryptoErrorCode =
  | "bad_encoding" // malformed base64url / base64
  | "bad_json" // not JSON text
  | "non_integer_number" // a number that is not a safe integer literal (§2.3, N20)
  | "invalid_bundle" // KeyBundle shape (§2.3), or a received bundle under another VK
  | "bad_mac" // a received bundle's MAC does not verify
  | "wrong_vault" // a received bundle belongs to another vault (§3.9 R0, F-03)
  | "kver_overflow" // the next kver would not be a safe integer (§3.9 R1, F-01)
  | "unaligned_time" // a bundle time is not a whole UTC hour (upload check, §2.3 N16)
  | "invalid_device_name" // §2.4
  | "invalid_key" // malformed dpk / epk / JWK
  | "invalid_signing_input" // §5.2
  | "invalid_argument" // a caller passed something out of range
  | "invalid_payload" // enrollment payload P (§3.2 M5)
  | "decrypt_failed"
  | "enroll_state"; // a transition the enrollment state machine does not allow

export class SyncCryptoError extends Error {
  constructor(
    readonly code: SyncCryptoErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "SyncCryptoError";
  }
}
