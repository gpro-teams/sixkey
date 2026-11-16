// The vault id's form and the strict base64 reader, on their own so that the write proof (write-proof.ts, which the
// popup loads with the outbox writer) uses them without the rest of the wire encodings. encoding.ts re-exports them.
import { fromB64 } from "../../crypto/bytes";
import { SyncCryptoError } from "./errors";

export const ID_RE = /^[A-Za-z0-9_-]{8,64}$/; // vaultId (Phase 0)

/** Standard base64 with the Phase 0 rules (fromB64), optionally of an exact length. */
export function b64(s: unknown, length?: number): Uint8Array {
  let out: Uint8Array;
  try {
    out = fromB64(s as string);
  } catch {
    throw new SyncCryptoError("bad_encoding", "bad base64");
  }
  if (length !== undefined && out.length !== length) throw new SyncCryptoError("bad_encoding", "wrong length");
  return out;
}
