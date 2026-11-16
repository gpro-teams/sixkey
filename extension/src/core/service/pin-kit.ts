// pin.ts's own derivations and the PIN record's rules (OWNER-DECISIONS/20), handed to its lock-screen steps
// (pin-restart-count.ts, and the lazy pin-restart-steps.ts), which import nothing of the popup's main chunk
// (docs/design/notes/SHAMIR-NOTES.md §7): the lock screens hand them this, from chunks that are not the popup's counted
// bundle (the popup's lock screen, src/popup/screens/Locked.tsx, in the screens' lazy chunk; the settings page's unlock
// bar), so sk_pin's format, the PIN's normalisation, the keyring's wraps tag, the settings' reading and the record's rules
// each have one implementation (pin.ts, pin-restart.ts, types.ts). Nothing of the popup's main chunk imports this file, pin-restart.ts
// or pin-restart-count.ts: a module the main chunk imports carries into it all its code that any chunk uses (the
// restartState rule alone cost the popup about 150 B gz that way; PIN-RESTART-NOTES.md §8).
// The active keyring's reading (core/storage/active-keyring.ts, already in the popup's main chunk through pin-store.ts) is
// here too, for the record's unlock to check, in the vault lock, that the keys are still the ones its try was counted
// for (review of PINONE, PO-01).
import { derivePinKek, normalizePin, openPinRecord, parsePinRecord, wrapsTag } from "../crypto/pin";
import { restartState } from "../crypto/pin-restart";
import { activeKeyring } from "../storage/active-keyring";
import { parseSettings, profileOf } from "./types";

export const pinKit = {
  normalizePin,
  derivePinKek,
  openPinRecord,
  parsePinRecord,
  wrapsTag,
  restartState,
  parseSettings,
  profileOf,
  activeKeyring,
};
export type PinKit = typeof pinKit;
