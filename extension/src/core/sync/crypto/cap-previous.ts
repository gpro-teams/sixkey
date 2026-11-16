// The cap on a keyring's previous list (§3.8 P1), on its own so that the vault service (and with it the popup, which
// loads the service) carries it without the KeyBundle code around it (SYNC-DESIGN §7, revision 24: the engine-only
// parts of the shared modules stay out of the popup's module graph). keybundle.ts re-exports it.
import type { Keyring } from "../../crypto/keyring";
import { SYNC_CONSTANTS as C } from "./constants";

/**
 * §3.8 P1 (F-11, S-5): the last 64 previous entries in list order. Phase 0 rekey appends "older ones, then the one just
 * retired" without a cap, so list order is age order and the VK just retired is always kept. Not by createdAt: rekey
 * gives every entry the same time.
 */
export function capPrevious(kr: Keyring): Keyring {
  return kr.previous.length <= C.KEYRING_PREVIOUS_MAX
    ? kr
    : { ...kr, previous: kr.previous.slice(-C.KEYRING_PREVIOUS_MAX) };
}
