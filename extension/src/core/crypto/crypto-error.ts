// The crypto core's one error (re-exported by bytes.ts, where it was defined until the recovery code shares came): a module
// of its own that imports nothing, so a lazy chunk can use it without pulling a module of the popup's main chunk into a
// chunk of its own (docs/design/notes/SHAMIR-NOTES.md §7: that split alone cost the popup's counted bundle about 500 B).
export type CryptoErrorCode =
  | "invalid_envelope"
  | "invalid_keyring"
  | "invalid_kdf_params"
  | "decrypt_failed"
  | "unwrap_failed"
  | "no_such_method"
  | "empty_password"
  | "recovery_length"
  | "recovery_char"
  | "recovery_checksum"
  | "pairing_length"
  | "pairing_char"
  | "pairing_checksum"
  // recovery code shares (shares.ts): one share typed (a wrong length, a symbol outside the alphabet, a typo the check
  // bits caught, a share of a version or kind this Sixkey does not know), and a set of them (shares of different sets,
  // the same share twice, not exactly the set's threshold, a combination whose digest does not check out)
  | "share_length"
  | "share_char"
  | "share_checksum"
  | "share_newer"
  | "shares_mixed"
  | "shares_duplicate"
  | "shares_count"
  | "shares_digest";

export class CryptoError extends Error {
  constructor(
    readonly code: CryptoErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "CryptoError";
  }
}
