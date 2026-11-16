// What the PIN offers on the lock screens (OWNER-DECISIONS/20 and its 2026-10-30 notes; docs/design/notes/
// PIN-RESTART-NOTES.md §3, §18), told from what openView read (ServiceCore.seen: no read of its own): its field when its
// record opens Sixkey, or that it waits for the master password once (or for it, or Settings, after a key change). In the
// lock screens' own chunks only (the popup's and the side panel's Locked.tsx, in the chunk loaded with the lock screen; the
// settings page's UnlockBar), never in the popup's counted bundle; and without the record's crypto (pin-restart-wrap.ts)
// or its own unlock (pin-restart-steps.ts, a lazy chunk loaded for a PIN typed or the master password's note).
//
// It imports nothing but types: pin.ts's and the record's rules come as `kit` (pin-kit.ts).
import type { PinRecord } from "../crypto/pin";
import type { RestartRecord, RestartState } from "../crypto/pin-restart";
import type { PinKit } from "./pin-kit";
import type { QuickView, ServiceCore } from "./service-core";

/** The key (pin-store.ts RESTART_KEY, core/sync/local/keys.ts LOCAL_ONLY_KEYS.restart), restated, not imported. */
const KEY = "sk_pin_restart";
/** The settings' key (types.ts SETTINGS_KEY), restated: openView reads it with the pointer. */
const SETTINGS = "sk_settings";
/** The tries (pin.ts QUICK_TRIES), restated. */
const TRIES = 5;

/** What the PIN offers on this lock screen. `state`: pin-restart.ts restartState's answer. `field`: when it opens Sixkey. */
export type RestartOffer = { state: RestartState; field?: QuickView };

/**
 * What the PIN offers now, from what openView last read (ServiceCore.seen: the record, sk_pin and the settings came with
 * the pointer): null when no PIN is set up for these keys, or in a profile declared shared.
 */
export function restartOffer(s: ServiceCore, kit: PinKit): RestartOffer | null {
  const r = s["seen"];
  const pins = s["pins"];
  if (!r || r.status !== "ok" || !pins) return null;
  const rec = r.also?.[KEY] as Partial<RestartRecord> | undefined;
  const set = kit.parsePinRecord(r.also?.[pins.name]);
  const shared = kit.profileOf(kit.parseSettings(r.also?.[SETTINGS])) === "shared";
  const state = kit.restartState(rec, r.gen.keyring, set, shared);
  if (state === null) return null;
  if (state !== "pin") return { state };
  // restartState answers "pin" only for a record and a set-up of this vault and key
  return { state, field: { digits: (set as PinRecord).digits, triesLeft: TRIES - rec!.fails! } };
}
