import type { QuickSession } from "../crypto/pin";
import type { KV } from "../storage/kv";
import { newDeviceId } from "../vault/hlc";

export type AutoLock = { mode: "idle"; minutes: number } | { mode: "always" } | { mode: "session" };
/** How the popup list looks. The defaults are what every version before this field showed. */
export type DisplaySettings = { density: "standard" | "compact"; hideCodes: boolean; sort: "manual" | "name" };
/**
 * What the user declared about this browser profile (QUICK-UNLOCK §5.12 item 5): "solo" (only me) or "shared" (shared,
 * vendor-synced or controlled by scripts). Session methods (the PIN) are refused and swept in a shared profile, whatever
 * the lock mode. Set by the first-run question and the two Security-mode cards; a custom change of one setting leaves it.
 * Like every setting it is not protected by the master password: it guards against misuse, not against someone at the
 * browser.
 */
export type Profile = "solo" | "shared";
/**
 * `display` and `profile` are optional only so callers written before them still type-check; every Settings that comes
 * out of parseSettings (and so out of any SettingsStore) has them. Read them through displayOf() and profileOf(). Pass
 * the whole object back when saving: parseSettings drops what it does not know and fills what is missing, so a partial
 * object resets the rest, except `profile`, which VaultService.updateSettings keeps when the object leaves it out.
 */
export type Settings = { autoLock: AutoLock; lockOnScreenLock: boolean; display?: DisplaySettings; profile?: Profile };
export const DEFAULT_DISPLAY: Readonly<DisplaySettings> = { density: "standard", hideCodes: false, sort: "manual" };
export const DEFAULT_SETTINGS: Settings = {
  autoLock: { mode: "idle", minutes: 15 },
  lockOnScreenLock: true,
  display: { ...DEFAULT_DISPLAY },
  profile: "solo",
};

export const displayOf = (s: Settings): DisplaySettings => s.display ?? { ...DEFAULT_DISPLAY };
/**
 * The profile marker. A record without one (saved before it existed, or a caller that left it out) reads "shared" when
 * its settings are exactly the shared preset's (lock every time, lock on screen lock, codes hidden), else "solo".
 */
export const profileOf = (s: Settings): Profile =>
  s.profile === "solo" || s.profile === "shared"
    ? s.profile
    : s.autoLock.mode === "always" && s.lockOnScreenLock && displayOf(s).hideCodes
      ? "shared"
      : "solo";

/** The unlocked VK, held only while unlocked. The platform keeps it in memory-only storage (chrome.storage.session). */
export type SessionData = { vk: string; lastActive: number; epoch?: number };
export interface SessionCache {
  get(): Promise<SessionData | null>;
  set(d: SessionData): Promise<void>;
  /** The soft lock (QUICK-UNLOCK §5.5): the unlocked key goes and the lock epoch moves on; sk_quick stays. */
  clear(): Promise<void>;
  /**
   * A counter shared by every context, bumped by each lock(). A session remembers the value from when it was unlocked and
   * is void once the counter has moved on. This is how a lock in one context (the service worker on screen lock) reaches a
   * key that another context holds in its own memory.
   */
  lockEpoch(): Promise<number>;
  bumpLockEpoch(): Promise<void>;
  /**
   * The session quick unlock (QUICK-UNLOCK §5.2 sk_quick; the Touch ID / Windows Hello gate's arming only, since the PIN is
   * its record's: OWNER-DECISIONS/20, 2026-10-30): memory only, shared by every context (chrome.storage.session
   * in the extension, never chrome.storage.local), and never in a page's own memory. A record that is not one reads as
   * null. Clearing it is the hard half of a hard lock (VaultService.hardLock does both).
   */
  getQuick(): Promise<QuickSession | null>;
  setQuick(q: QuickSession): Promise<void>;
  clearQuick(): Promise<void>;
}

/** What opening the popup needs from the settings store, in one read (PHASE0X-PLAN A2). */
export type SettingsView = {
  settings: Settings;
  lastBackup: number | null;
  /** The values of the keys the store was made to read with them (KvSettingsStore's `also`), as they are, unparsed. */
  also?: Record<string, unknown>;
};

export interface SettingsStore {
  get(): Promise<Settings>;
  /** get() and getLastBackup() together, in one read. */
  getView(): Promise<SettingsView>;
  set(s: Settings): Promise<void>;
  /** Stable per-install id used in timestamps; created on first use. */
  deviceId(): Promise<string>;
  getLastBackup(): Promise<number | null>;
  setLastBackup(at: number): Promise<void>;
}

export function parseSettings(x: unknown): Required<Settings> {
  const o = (typeof x === "object" && x !== null ? x : {}) as Record<string, unknown>;
  const a = (typeof o.autoLock === "object" && o.autoLock !== null ? o.autoLock : {}) as Record<string, unknown>;
  let autoLock: AutoLock = DEFAULT_SETTINGS.autoLock;
  if (a.mode === "always") autoLock = { mode: "always" };
  else if (a.mode === "session") autoLock = { mode: "session" };
  else if (a.mode === "idle" && typeof a.minutes === "number" && Number.isFinite(a.minutes))
    autoLock = { mode: "idle", minutes: Math.min(24 * 60, Math.max(1, Math.round(a.minutes))) };
  // Records saved before `display` existed have none: each field falls back on its own, so one bad value resets only itself.
  const d = (typeof o.display === "object" && o.display !== null ? o.display : {}) as Record<string, unknown>;
  const display: DisplaySettings = {
    density: d.density === "standard" || d.density === "compact" ? d.density : DEFAULT_DISPLAY.density,
    hideCodes: typeof d.hideCodes === "boolean" ? d.hideCodes : DEFAULT_DISPLAY.hideCodes,
    sort: d.sort === "manual" || d.sort === "name" ? d.sort : DEFAULT_DISPLAY.sort,
  };
  const lockOnScreenLock =
    typeof o.lockOnScreenLock === "boolean" ? o.lockOnScreenLock : DEFAULT_SETTINGS.lockOnScreenLock;
  const profile = profileOf({
    autoLock,
    lockOnScreenLock,
    display,
    ...(o.profile === "solo" || o.profile === "shared" ? { profile: o.profile } : {}),
  });
  return { autoLock, lockOnScreenLock, display, profile };
}

/** Where KvSettingsStore keeps the settings; openView also reads it with the pointer (service-core.ts, the PIN's line). */
export const SETTINGS_KEY = "sk_settings";

/**
 * Settings and device id kept in any KV (chrome.storage.local in the extension). Not secret. `also`: keys outside the
 * settings that a page shows beside the list (the popup's: the backup in Chrome sync's two records), read in getView's
 * one get, so the open reads nothing more for them.
 */
export class KvSettingsStore implements SettingsStore {
  constructor(
    private readonly kv: KV,
    private readonly also: readonly string[] = [],
  ) {}
  async get(): Promise<Settings> {
    return parseSettings((await this.kv.get([SETTINGS_KEY]))[SETTINGS_KEY]);
  }
  async getView(): Promise<SettingsView> {
    const r = await this.kv.get([SETTINGS_KEY, "sk_last_backup", ...this.also]);
    return {
      settings: parseSettings(r[SETTINGS_KEY]),
      lastBackup: typeof r.sk_last_backup === "number" ? r.sk_last_backup : null,
      also: Object.fromEntries(this.also.map((k) => [k, r[k]])),
    };
  }
  async set(s: Settings): Promise<void> {
    await this.kv.set({ [SETTINGS_KEY]: parseSettings(s) });
  }
  async getLastBackup(): Promise<number | null> {
    const v = (await this.kv.get(["sk_last_backup"])).sk_last_backup;
    return typeof v === "number" ? v : null;
  }
  async setLastBackup(at: number): Promise<void> {
    await this.kv.set({ sk_last_backup: at });
  }
  async deviceId(): Promise<string> {
    const cur = (await this.kv.get(["sk_device"])).sk_device;
    if (typeof cur === "string" && /^[a-z0-9]{4,16}$/.test(cur)) return cur;
    const id = newDeviceId();
    await this.kv.set({ sk_device: id });
    return id;
  }
}

export class MemorySession implements SessionCache {
  data: SessionData | null = null;
  quick: QuickSession | null = null;
  epoch = 0;
  async lockEpoch() {
    return this.epoch;
  }
  async bumpLockEpoch() {
    this.epoch++;
  }
  async get() {
    return this.data ? { ...this.data } : null;
  }
  async set(d: SessionData) {
    this.data = { ...d };
  }
  async clear() {
    this.data = null;
  }
  async getQuick() {
    return this.quick ? structuredClone(this.quick) : null;
  }
  async setQuick(q: QuickSession) {
    this.quick = structuredClone(q);
  }
  async clearQuick() {
    this.quick = null;
  }
}
