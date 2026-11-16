import { parseQuick, type QuickSession } from "../core/crypto/pin";
import {
  MemorySession,
  profileOf,
  type SessionCache,
  type SessionData,
  type SettingsStore,
} from "../core/service/types";

const KEY = "sk_session";
/** The unlocked key's record in chrome.storage.session (standard mode): a long-lived page watches it to follow an unlock elsewhere. */
export const SESSION_KEY = KEY;
const EPOCH_KEY = "sk_lock_epoch";
/**
 * The key every lock bumps in chrome.storage.session: pages that hold an unlocked vault watch it (onChanged) and drop
 * the key and the codes on screen at once (QUICK-UNLOCK §5.12 item 3).
 */
export const LOCK_EPOCH_KEY = EPOCH_KEY;
/**
 * The session quick unlock's parked key (QUICK-UNLOCK §5.2): chrome.storage.session only. This file is the only place
 * the name is spelled, and it is only ever passed to the session area (test/unit/quick-source-rules.test.ts).
 */
const QUICK_KEY = "sk_quick";
/** A change in chrome.storage.session that concerns the session quick unlock (its record, or a lock): for a page that shows it. */
export const quickChanged = (changes: Record<string, unknown>): boolean => QUICK_KEY in changes || EPOCH_KEY in changes;

/** chrome.storage.session: memory only, cleared when the browser closes or the extension updates or reloads. */
export class ChromeSessionCache implements SessionCache {
  constructor(private readonly area: chrome.storage.StorageArea = chrome.storage.session) {}
  async get(): Promise<SessionData | null> {
    const v = (await this.area.get(KEY))[KEY] as Partial<SessionData> | undefined;
    return v && typeof v.vk === "string" && typeof v.lastActive === "number"
      ? { vk: v.vk, lastActive: v.lastActive, ...(typeof v.epoch === "number" ? { epoch: v.epoch } : {}) }
      : null;
  }
  async set(d: SessionData): Promise<void> {
    await this.area.set({ [KEY]: d });
  }
  async clear(): Promise<void> {
    await this.area.remove(KEY);
  }
  async lockEpoch(): Promise<number> {
    const v = (await this.area.get(EPOCH_KEY))[EPOCH_KEY];
    return typeof v === "number" ? v : 0;
  }
  async bumpLockEpoch(): Promise<void> {
    await this.area.set({ [EPOCH_KEY]: (await this.lockEpoch()) + 1 });
  }
  async getQuick(): Promise<QuickSession | null> {
    return parseQuick((await this.area.get(QUICK_KEY))[QUICK_KEY]);
  }
  async setQuick(q: QuickSession): Promise<void> {
    await this.area.set({ [QUICK_KEY]: q });
  }
  async clearQuick(): Promise<void> {
    await this.area.remove(QUICK_KEY);
  }
}

/**
 * Picks where the unlocked key lives. In "lock every time" mode (the popup closing is the lock; QUICK-UNLOCK §5.12 item 4
 * calls it "lock when the popup closes") it stays in this page's memory only, so closing the popup is what locks it:
 * nothing has to run afterwards, which matters because a service worker cannot be relied on to notice the popup closing.
 * In the other modes it lives in chrome.storage.session so every context shares it.
 * The session quick unlock (sk_quick) always lives in chrome.storage.session, in every mode, so a popup that locked by
 * closing reopens with the PIN; never in a page's memory. In a profile declared shared (§5.12 item 5) it may not exist
 * at all: every get() sweeps it out, so a record written by a context that had not yet seen the switch does not stay.
 */
export class RoutedSession implements SessionCache {
  private readonly memory = new MemorySession();
  constructor(
    private readonly persistent: SessionCache,
    private readonly settings: SettingsStore,
  ) {}
  async get() {
    const s = await this.settings.get();
    if (profileOf(s) === "shared") await this.persistent.clearQuick(); // a remove, no read
    if (s.autoLock.mode === "always") {
      // In this mode nothing may sit in shared storage. Sweep out anything a context wrote just before the switch.
      if (await this.persistent.get()) await this.persistent.clear();
      return this.memory.get();
    }
    return this.persistent.get();
  }
  async set(d: SessionData) {
    return (await this.settings.get()).autoLock.mode === "always" ? this.memory.set(d) : this.persistent.set(d);
  }
  /** The soft lock: the key goes from here and from shared storage, the epoch moves on; sk_quick stays (§5.5). */
  async clear() {
    await this.memory.clear();
    await this.persistent.clear();
    await this.persistent.bumpLockEpoch(); // reaches keys held in other contexts' memory
  }
  /**
   * Drop the key this page holds in its own memory ("lock every time"), and nothing else: the key in shared storage and
   * the lock epoch are left as they are, so no other page locks. The side panel's close and idle lock in that mode
   * (src/sidepanel/guard.ts): the same as the popup closing, which other pages do not notice either.
   */
  forget(): void {
    void this.memory.clear(); // MemorySession.clear has no await: the key is gone when this returns
  }
  lockEpoch() {
    return this.persistent.lockEpoch();
  }
  bumpLockEpoch() {
    return this.persistent.bumpLockEpoch();
  }
  // The service decides whether sk_quick may be written (a solo profile, a master password just typed); these read and
  // write chrome.storage.session without a settings read of their own, so a lock screen reads nothing more for them.
  getQuick() {
    return this.persistent.getQuick();
  }
  setQuick(q: QuickSession) {
    return this.persistent.setQuick(q);
  }
  clearQuick() {
    return this.persistent.clearQuick();
  }
}
