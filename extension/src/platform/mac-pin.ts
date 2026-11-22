// The PIN for Sixkey for Mac (OWNER-DECISIONS/23, 2026-11-19: "需要同步 不然解锁太麻烦了"): one PIN for both, set once
// here. What the link sends the app (platform/mac-link.ts sends it; this module only reads and decides): the PIN's record
// (sk_pin_restart, core/crypto/pin-restart.ts) as it is stored, the PIN's digits and its set-up's PBKDF2 count (sk_pin),
// while the PIN opens Sixkey here ("pin": restartState); null otherwise (none, waiting for the master password, paused
// by a key change, a profile declared shared), which takes the app's copy away. The app opens the record with the same
// PIN as pin-restart-wrap.ts does and counts its own 5 tries. The record holds nothing a copy of this profile does not
// already give (the PIN can be guessed offline from it, as the settings text says, here as on the Mac).
import { parsePinRecord } from "../core/crypto/pin";
import { restartState } from "../core/crypto/pin-restart";
import { parseSettings, profileOf, SETTINGS_KEY } from "../core/service/types";
import { LOCAL_ONLY_KEYS } from "../core/storage/local-keys";
import type { ViewLoad } from "../core/storage/store";

/** The link's `pin` field. */
export type MacPin = { restart: unknown; digits: number; setupIterations: number };

/** The PIN as the app opens it, or null when the PIN does not open Sixkey here now. Reads; writes nothing. */
export async function pinForMac(loadView: (also: readonly string[]) => Promise<ViewLoad>): Promise<MacPin | null> {
  const v = await loadView([LOCAL_ONLY_KEYS.pin, LOCAL_ONLY_KEYS.restart, SETTINGS_KEY]);
  if (v.status !== "ok") return null;
  const set = parsePinRecord(v.also?.[LOCAL_ONLY_KEYS.pin]);
  const restart = v.also?.[LOCAL_ONLY_KEYS.restart];
  const shared = profileOf(parseSettings(v.also?.[SETTINGS_KEY])) === "shared";
  if (set === null || set === "damaged" || restartState(restart, v.gen.keyring, set, shared) !== "pin") return null;
  return { restart, digits: set.digits, setupIterations: set.kdf.iterations };
}
