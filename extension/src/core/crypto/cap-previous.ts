// The cap on a keyring's previous list (SYNC-DESIGN §3.8 P1), on its own so that the vault service (and with it the popup,
// which loads the service) carries it without anything around it. It came from the server sync's crypto
// (core/sync/crypto/), whose client is gone from the extension (OWNER-DECISIONS/25, DV-0b); the key rotation keeps it.
import type { Keyring } from "./keyring";

/** At most this many previous keys in a keyring: validateKeyring (keyring.ts) allows no more. */
export const KEYRING_PREVIOUS_MAX = 64;

/**
 * §3.8 P1 (F-11, S-5): the last 64 previous entries in list order. Phase 0 rekey appends "older ones, then the one just
 * retired" without a cap, so list order is age order and the VK just retired is always kept. Not by createdAt: rekey
 * gives every entry the same time.
 */
export function capPrevious(kr: Keyring): Keyring {
  return kr.previous.length <= KEYRING_PREVIOUS_MAX
    ? kr
    : { ...kr, previous: kr.previous.slice(-KEYRING_PREVIOUS_MAX) };
}
