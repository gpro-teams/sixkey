// The two security presets (PHASE0X-PLAN R0; ux-study §2.8): one answer at first run, and the same two cards under
// Settings > Security later. Data and pure functions only. Which preset is "current" is never stored: it is read off the
// settings, so changing any one of its fields simply makes it "custom".
import { displayOf, profileOf, type AutoLock, type Profile, type Settings } from "./types";

export type PresetId = "standard" | "shared";

/**
 * The fields a preset decides. Everything else (density, sort, ...) is the user's and a preset leaves it alone. `profile`
 * (QUICK-UNLOCK §5.12 item 5) is what the card declares about the profile: choosing a card sets it, and a custom change
 * of one setting afterwards leaves it as it is.
 */
export type Preset = {
  readonly autoLock: Readonly<AutoLock>;
  readonly lockOnScreenLock: boolean;
  readonly hideCodes: boolean;
  readonly profile: Profile;
};

export const PRESETS: Readonly<Record<PresetId, Preset>> = {
  /** One person on their own computer: lock after 15 idle minutes and when the screen locks; codes visible. */
  standard: { autoLock: { mode: "idle", minutes: 15 }, lockOnScreenLock: true, hideCodes: false, profile: "solo" },
  /**
   * A shared, vendor-synced or script-driven profile: lock whenever the popup closes; codes hidden until asked for; no
   * PIN (the profile marker refuses session methods).
   */
  shared: { autoLock: { mode: "always" }, lockOnScreenLock: true, hideCodes: true, profile: "shared" },
};

const sameAutoLock = (a: AutoLock, b: Readonly<AutoLock>) =>
  a.mode === b.mode && (a.mode !== "idle" || (b.mode === "idle" && a.minutes === b.minutes));

/** A copy of `s` with the preset's fields set. Does not change `s`. */
export function applyPreset(s: Settings, id: PresetId): Settings {
  const p = PRESETS[id];
  return {
    ...s,
    autoLock: { ...p.autoLock },
    lockOnScreenLock: p.lockOnScreenLock,
    display: { ...displayOf(s), hideCodes: p.hideCodes },
    profile: p.profile,
  };
}

/**
 * The preset these settings match exactly, the profile marker included, or "custom". So a solo profile that locks every
 * time with codes hidden (where the PIN works) shows as Custom, never as the Shared card (where it does not).
 */
export function detectPreset(s: Settings): PresetId | "custom" {
  for (const id of ["standard", "shared"] as const) {
    const p = PRESETS[id];
    if (
      sameAutoLock(s.autoLock, p.autoLock) &&
      s.lockOnScreenLock === p.lockOnScreenLock &&
      displayOf(s).hideCodes === p.hideCodes &&
      profileOf(s) === p.profile
    )
      return id;
  }
  return "custom";
}
