// The part of the application service that the popup loads: opening, unlocking (master password, recovery code),
// editing the vault, locking, and the steps these share with the rest (the session, the security record, the input hint,
// the key-change cleanup). VaultService (service.ts) extends it with everything else: the first run, the settings page's
// key operations, restoring and importing, the permanent delete, the service worker's timers. The settings page and the
// service worker build VaultService (platform/runtime.ts); the popup builds this class alone (platform/runtime-base.ts),
// so none of the rest is in the popup's bundle (docs/design/notes/BUDGET-NOTES.md). Every member was moved here from
// service.ts unchanged; the ones VaultService's own methods use are protected rather than private.
import { CryptoError, fromB64, toB64, randomBytes, type Random } from "../crypto/bytes";
import { decryptVault, encryptVault } from "../crypto/envelope";
import {
  openWithPassword,
  unlockWithDevice,
  unlockWithRecoveryCode,
  unwrapPreviousVks,
  type Keyring,
} from "../crypto/keyring";
import { armDevice, quickLive, wrapsTag, type QuickSession } from "../crypto/pin";
import { gateCreds, hasGate, passwordRecent, pausedCreds, prfCreds, prfFor } from "../crypto/prf-record";
import type { PasswordFormat } from "../crypto/password-candidates";
import { vkFromRaw, type Vk } from "../crypto/vk";
import type { Generation } from "../storage/format";
import { createMutex, type Lock } from "../storage/kv";
import type { Cleanup, VaultStore, ViewLoad } from "../storage/store";
import { createClock, type Clock } from "../vault/hlc";
import type { Vault } from "../vault/model";
import { observeVault } from "../vault/ops";
import { deserializeVault, serializeVault } from "../vault/validate";
import type { StorageEvent } from "../storage/format";
import { PIN_KEY, RESTART_KEY, type PinStore } from "./pin-store";
import { PRF_KEY, type PrfStore } from "./prf-store";
import { formatFor, formatRecord, type PwFormatRecord, type PwFormatStore } from "./pw-format";
import type { SecurityKind, SecurityRecorder } from "./security-log";
import { ServiceError } from "./service-error";
import {
  parseSettings,
  profileOf,
  SETTINGS_KEY,
  type SessionCache,
  type SessionData,
  type Settings,
  type SettingsStore,
  type SettingsView,
} from "./types";

/**
 * Everything the popup shows when it opens, from one call (PHASE0X-PLAN A2, ux-study O2): the same state, vault,
 * events and protection as status() followed by read(), plus what the list needs from the settings store.
 */
export type OpenView =
  | { state: "empty" }
  | { state: "lost" }
  | {
      state: "locked";
      events: StorageEvent[];
      format?: PasswordFormat;
      device?: DeviceView;
    }
  | UnlockedView;
/**
 * What the lock screen needs of the PIN (QUICK-UNLOCK §5.4; pin-restart-count.ts restartOffer): its length (shown as dots
 * anyway, and the field submits when it is reached) and the tries left. Present only while the PIN can open Sixkey;
 * never anything secret.
 */
export type QuickView = { digits: number; triesLeft: number };
/**
 * What the lock screen needs to offer the device unlock (QUICK-UNLOCK §5.4, Stage 2), never anything secret: `prf`, a
 * PRF credential can open Sixkey now (its wrap is under this vault key, and the master password was typed in the last 14
 * days); `due`, one could, but the 14 days are over; `paused`, one waits for "turn back on" after a key change; `gate`,
 * the session quick unlock is the Touch ID / Windows Hello gate and it is armed; `waiting`, it is the gate's, and waits
 * for the master password (after a browser restart, 12 hours, a hard lock).
 */
export type DeviceView = { prf?: true; due?: true; paused?: true; gate?: true; waiting?: true };
/**
 * A PIN unlock's answer (pin-restart-steps.ts unlock). `ok: false`: "malformed" (not 4 to 8 digits: a typo, nothing
 * counted or recorded), "wrong" (a try spent and recorded; `triesLeft` more, for a PIN of `digits` digits), "exhausted"
 * (no tries left: the master password), "ended" (the PIN cannot open Sixkey now: removed, replaced, a key change, a
 * shared profile, waiting for the master password), "locked" (Sixkey locked while the PIN was checked: the new session
 * was voided; the try was not lost) or "waiting" (the right PIN as the 5th try in a row, with a lock during its
 * derivation: its wrap stays aside, so it waits for the master password, as after "exhausted"; nothing is recorded).
 */
export type PinUnlock =
  | ({ ok: true } & UnlockResult)
  | { ok: false; reason: "malformed" | "ended" | "exhausted" | "locked" | "waiting" }
  | { ok: false; reason: "wrong"; triesLeft: number; digits: number };
export type UnlockedView = {
  state: "unlocked";
  vault: Vault;
  events: StorageEvent[];
  passwordProtected: boolean;
  settings: Settings;
  lastBackup: number | null;
  /** What the settings store read with them for a page to show (SettingsView's `also`). */
  also?: Record<string, unknown>;
};
/** An unlock also returns the view, so the popup does not load everything again afterwards. */
export type UnlockResult = { recovered?: StorageEvent; view: UnlockedView };

export type ServiceDeps = {
  store: VaultStore;
  session: SessionCache;
  settings: SettingsStore;
  now?: () => number;
  rng?: Random;
  /** Non-fatal problems (a cleanup that will be retried). Never receives key material. */
  onDiag?: (message: string, err?: unknown) => void;
  /**
   * The local security record (H6, security-log.ts). Optional like onDiag: without it nothing is recorded. Entries are
   * added only once the step they record has happened (never inside a transact), and adding one never fails that step.
   */
  security?: SecurityRecorder;
  /**
   * Records outside the store's copies that are encrypted under the vault key (SYNC-DESIGN §0.0i M2 req. 5): the PIN's
   * set-up, the device unlock's record and the plugin grants (platform/runtime-base.ts). The one cleanup entry point
   * moves each to the current key before the store's own copies.
   */
  vkRecords?: readonly VkRecord[];
  /**
   * Test hook only: the PBKDF2 count of new master-password wraps (VaultService) and of the PIN's set-up (pin-admin.ts).
   * Production uses PBKDF2_PASSWORD_WRAP_ITERATIONS for the first and kdf.ts's 600k default for the second.
   */
  kdfIterations?: number;
  /**
   * The PIN's set-up, sk_pin (QUICK-UNLOCK §5.2; pin-store.ts), and its record, sk_pin_restart (OWNER-DECISIONS/20 and
   * its 2026-10-30 notes: the PIN's one way). Without it there is no PIN: PinAdmin.setPin refuses
   * (quick_off). The runtime also lists it in vkRecords, so a key change moves the set-up (VaultService.committed pauses
   * the record).
   */
  pins?: PinStore;
  /**
   * The device unlock's record, sk_prf (QUICK-UNLOCK §5.2, Stage 2; prf-store.ts): Touch ID / Windows Hello credentials.
   * Without it there is no device unlock. The runtime also lists it in vkRecords, so a key change pauses its PRF wraps.
   */
  prfs?: PrfStore;
  /**
   * sk_pw_format, the master-password prompts' input hint (pw-format.ts), in chrome.storage.session: written after a
   * password is set and when a password unlock shows what the stored one is. Shown, never used to decide anything.
   * Without it, nothing is read or written for it.
   */
  formats?: PwFormatStore;
  /**
   * The lock around sk_quick's try counter (QUICK-UNLOCK §5.4: webLock("sixkey-quick") across contexts). The order is
   * vault lock, then quick lock (a first-run answer saved inside the vault's transact ends the session quick unlock),
   * never the other way round: a section under the quick lock touches the session cache and nothing else
   * (test/unit/quick-source-rules.test.ts), since webLock is not re-entrant.
   */
  quickLock?: Lock;
};

/**
 * A record encrypted under the vault key that the store does not hold (see ServiceDeps.vkRecords). `reencrypt` moves it
 * to `current` if it is under one of `held` (the old keys the caller can open: the keyring's previous ones, and whatever
 * else the caller has in memory), and says what it found.
 *
 * THE CONTRACT (A4R-4; M2 implements it). The cleanup calls `reencrypt` outside the vault lock, and never from inside it,
 * so an implementation must make itself safe:
 *   - Its read, the check that the vault's active key is still `current`, and its write are ONE critical section under
 *     webLock("sixkey-vault"), the store's own lock. Split (read, re-encrypt, then a write later), a cleanup of an older
 *     key change can land after a newer one has finished and leave the record under a superseded key with no marker:
 *     staleIn never looks at these records. If the active key is no longer `current`, it writes nothing (the newer key
 *     change's own cleanup moves the record).
 *   - It never calls back into the store or the service from inside that section, and nothing that already holds the
 *     lock calls the cleanup: webLock is not re-entrant, so either deadlocks.
 *   - A read that throws must propagate: the cleanup then stops before the store's part, and the marker stays for the
 *     next unlock (§0.0i req. 5).
 *   - "unopenable": under a key none of `held` opens. The record decides what that means (the PIN's set-up is removed,
 *     a PRF wrap is paused: pin-store.ts, prf-store.ts). It never holds the marker up.
 * test/regression/gm2-fixes.test.ts has a record written to this contract racing two rotations.
 */
export type VkRecord = {
  /** For the diagnostics log; never secret. */
  readonly name: string;
  reencrypt(current: Vk, held: readonly Vk[]): Promise<VkRecordResult>;
  /**
   * A new vault about to be made under `next`, a new key (makeVault, before its commit): what this record grants that
   * `next` will not open, withdrawn now in a way that needs no key and only tightens (the plugin grants: each plugin
   * removed through the overlay), so that a newVault below cut short leaves nothing of the old vault honoured by a
   * reader that cannot check the record's tag (docs/design/notes/CLOUD-PLUGIN-NOTES.md §3.5). It writes only after
   * checking, in its own critical section, that the slots still hold no vault (another page may have made one since
   * makeVault looked). A failure is logged and the vault is made all the same.
   */
  beforeNewVault?(next: Vk): Promise<void>;
  /**
   * A new vault made under `current`, a new key (makeVault: the first run, a backup restored, Start over): what this
   * record holds that no key of the new vault opens, set aside as the record's own rules say (the plugin grants: listed
   * for review, W2a r3). Called once the new vault is committed and unlocked; a failure is logged, and the record's own
   * rules then meet what is left.
   */
  newVault?(current: Vk): Promise<void>;
};
/** "superseded": the vault's active key is no longer `current`; nothing written, the newer change's cleanup moves it. */
export type VkRecordResult = "absent" | "current" | "rewritten" | "unopenable" | "superseded";

/** In "lock every time" mode the popup closing is the lock; a page that stays open (settings) still gets this ceiling. */
export const ALWAYS_MODE_MAX_IDLE_MINUTES = 15;

export function isSessionExpired(settings: Settings, session: SessionData, now: number): boolean {
  const { autoLock } = settings;
  if (autoLock.mode === "session") return false;
  const minutes = autoLock.mode === "idle" ? autoLock.minutes : ALWAYS_MODE_MAX_IDLE_MINUTES;
  return now - session.lastActive > minutes * 60_000;
}

/** A Phase 0 vault: its key is wrapped by a device key stored next to it (no master password). */
export const hasDevice = (k: Keyring) => k.wraps.some((w) => w.method === "device") && k.deviceKey !== undefined;
/** The same arming of sk_quick: the same time and vault key. */
const sameArming = (a: QuickSession, b: QuickSession) => a.armedAt === b.armedAt && a.vkId === b.vkId;

/**
 * Promise.all for two steps run side by side, except that a failure is reported only once both have finished. With
 * Promise.all the other step (which may be writing: a decrypt fallback, the session) would still be running after the
 * call had already failed, racing whatever the caller does next (test/fault/open-view-diff.test.ts found this).
 */
async function both<A, B>(a: Promise<A>, b: Promise<B>): Promise<[A, B]> {
  const [ra, rb] = await Promise.allSettled([a, b]);
  if (ra.status === "rejected") throw ra.reason;
  if (rb.status === "rejected") throw rb.reason;
  return [ra.value, rb.value];
}

export class ServiceCore {
  protected readonly store: VaultStore;
  protected readonly session: SessionCache;
  protected readonly settings: SettingsStore;
  protected readonly now: () => number;
  protected readonly rng: Random;
  protected readonly iterations: number | undefined;
  protected readonly diag: (message: string, err?: unknown) => void;
  protected readonly security: SecurityRecorder | undefined;
  protected readonly vkRecords: readonly VkRecord[];
  protected readonly pins: PinStore | undefined;
  protected readonly prfs: PrfStore | undefined;
  private readonly formats: PwFormatStore | undefined;
  protected readonly quickLock: Lock;
  /**
   * What openView last read (the pointer's read, with `also`): the lock screen tells from it what the PIN offers
   * (OWNER-DECISIONS/20; pin-restart-count.ts restartOffer, in the lock screen's own chunk), so that neither a read
   * of its own nor its rules are in the popup's counted bundle. Nothing else reads it; it holds nothing the profile's
   * storage does not.
   */
  private seen: ViewLoad | undefined;
  /**
   * The master password just typed in this very service (unlockWithPassword, and nothing else: not the recovery code,
   * the gate, the PIN or a failed try): the vault key's id and the lock epoch of the session it started. The PIN's note
   * (pin-restart-steps.ts notePassword) takes it once, as its proof that the master password opened these keys here,
   * instead of deriving the password again (review of PINONE, PO-02); a lock since voids it (the epoch), every other
   * unlock and every lock here drops it. It holds no secret.
   */
  private typed: { vkId: string; epoch: number } | null = null;

  constructor(d: ServiceDeps) {
    this.store = d.store;
    this.session = d.session;
    this.settings = d.settings;
    this.now = d.now ?? Date.now;
    this.rng = d.rng ?? randomBytes;
    this.iterations = d.kdfIterations;
    this.diag = d.onDiag ?? (() => undefined);
    this.security = d.security;
    this.vkRecords = d.vkRecords ?? [];
    this.pins = d.pins;
    this.prfs = d.prfs;
    this.formats = d.formats;
    this.quickLock = d.quickLock ?? createMutex();
  }

  /**
   * The keys loadView reads with the pointer for the quick and device unlocks: sk_pin and sk_pin_restart, and sk_prf,
   * when there are their stores. No more gets: they come with the pointer's.
   */
  private get also(): string[] {
    return [...(this.pins ? [PIN_KEY, RESTART_KEY] : []), ...(this.prfs ? [PRF_KEY] : [])];
  }

  // ---- state ---------------------------------------------------------------------------------

  /**
   * Opening the popup. In the normal case four reads of chrome.storage.local, however many snapshots there are: the
   * pointer with the events and the key-change state, the active slot, the settings (twice: once inside the session
   * router), and none of the mirror. The generation is read once and decrypted once. A key change that did not finish
   * is finished here when the vault is open (see store.ts); otherwise no copy other than the active one is looked at.
   * With the main store clean and only the mirror left (IndexedDB failing), an open looks at nothing more: the unlock retries.
   * Locked, it also reads two keys of chrome.storage.session, side by side: sk_quick (the Touch ID / Windows Hello gate)
   * and the input hint (`format`, pw-format.ts: which field the lock screen shows, and nothing else). What the PIN offers
   * (its field, or that it waits for the master password) the lock screen tells from what this read (`seen`:
   * pin-restart-count.ts restartOffer, in its own chunk): sk_pin, its record and the settings come with the pointer's get
   * (`also`), so nothing more is read for it.
   * status() and read() stay as they were: the settings page uses them, and the differential tests use them as the
   * reference (test/fault/open-view-diff.test.ts).
   */
  async openView(): Promise<OpenView> {
    const r = await this.store.loadView(this.pins || this.prfs ? [...this.also, SETTINGS_KEY] : this.also);
    this.seen = r;
    if (r.status !== "ok") return { state: r.status };
    const device = hasDevice(r.gen.keyring);
    let view: Promise<SettingsView> | undefined;
    const settingsView = () => (view ??= this.settings.getView());
    const vk = device
      ? await unlockWithDevice(r.gen.keyring)
      : await this.sessionVk(r.gen.keyring, async () => (await settingsView()).settings);
    if (!vk) {
      // the hint checked against the keyring this open has read (formatFor); a read or a check that fails is no hint:
      // the plain field
      const [gate, format] = await both(
        this.lockScreenGate(r),
        this.formats
          ? this.formats
              .read()
              .then((raw) => formatFor(raw, r.gen.keyring))
              .catch(() => null)
          : Promise.resolve(null),
      );
      const settings = parseSettings(r.also?.[SETTINGS_KEY]);
      // the device unlock (Stage 2): what sk_prf, read with the pointer, offers (the gate never in a shared profile)
      const plan = this.devicePlan(r, settings, this.now());
      const device: DeviceView = {};
      if (plan.prf.length) device[plan.recent ? "prf" : "due"] = true;
      if (plan.paused) device.paused = true;
      if (gate) device.gate = true;
      else if (plan.gates.length) device.waiting = true;
      return {
        state: "locked",
        events: r.events,
        ...(format ? { format } : {}),
        ...(Object.keys(device).length ? { device } : {}),
      };
    }
    const [opened, sv] = await both(this.store.openVault(vk, r.gen), settingsView());
    // A device-key vault is not cleaned up here, as read() never did: it has no password for old copies to undermine.
    // Only a full cleanup runs on open; one where only the mirror is left waits for the next unlock (store.ts).
    if (r.cleanup === "full" && !device) await this.housekeeping(vk, opened.gen.keyring, r.cleanup);
    return this.unlockedView(opened, r.events, !device, sv);
  }

  private unlockedView(
    opened: { vault: Vault; recovered?: StorageEvent },
    events: StorageEvent[],
    passwordProtected: boolean,
    sv: SettingsView,
  ): UnlockedView {
    // `events` was read before the vault was opened, so a decrypt fallback's event is not in it yet.
    return {
      state: "unlocked",
      vault: opened.vault,
      events: opened.recovered ? [...events, opened.recovered] : events,
      passwordProtected,
      settings: sv.settings,
      lastBackup: sv.lastBackup,
      also: sv.also,
    };
  }

  /** The VK if available without asking the user: the device key, or a live, unexpired unlock session. */
  protected async currentVk(keyring: Keyring): Promise<Vk | null> {
    if (hasDevice(keyring)) return unlockWithDevice(keyring);
    const s = await this.session.get();
    if (!s) return null;
    // Void if anyone locked after this key was unlocked, or if the idle limit has passed.
    const locked = s.epoch !== undefined && (await this.session.lockEpoch()) > s.epoch;
    if (locked || isSessionExpired(await this.settings.get(), s, this.now())) {
      await this.session.clear();
      return null;
    }
    try {
      const vk = await vkFromRaw(fromB64(s.vk));
      return vk.id === keyring.vkId ? vk : null;
    } catch {
      return null;
    }
  }

  /**
   * currentVk's session half for openView, with the settings it already reads (read only if there is a session).
   * Deliberately a copy, not shared: currentVk is the reference the differential tests compare openView against.
   */
  private async sessionVk(keyring: Keyring, settings: () => Promise<Settings>): Promise<Vk | null> {
    const s = await this.session.get();
    if (!s) return null;
    const locked = s.epoch !== undefined && (await this.session.lockEpoch()) > s.epoch;
    if (locked || isSessionExpired(await settings(), s, this.now())) {
      await this.session.clear();
      return null;
    }
    try {
      const vk = await vkFromRaw(fromB64(s.vk));
      return vk.id === keyring.vkId ? vk : null;
    } catch {
      return null;
    }
  }

  protected async requireVk(keyring: Keyring): Promise<Vk> {
    const vk = await this.currentVk(keyring);
    if (!vk) throw new ServiceError("locked");
    return vk;
  }

  /**
   * The vault key while Sixkey is unlocked here, else null: only for the plugin grant store's tag, which is derived
   * from it there and never kept (src/core/plugins/store.ts). A previous key never
   * counts here: only the key-change cleanup uses those (finishKeyChanges, the store's reencrypt). The pointer and the
   * active slot are read, as an open reads them. `activeVkId` and `cleanupPending`: the store's own readings of the
   * active key's ID and of whether a key change's cleanup is still due, for the grant store's tagged write to check
   * inside its lock that this key is still the vault's (N2, wave 2a) and that a record it cannot verify is not one that
   * cleanup has yet to re-tag (W2A-01).
   */
  async grantKeys(): Promise<{
    vk: Vk;
    activeVkId: () => Promise<string>;
    cleanupPending: () => Promise<boolean>;
  } | null> {
    const r = await this.store.loadView([]);
    const vk = r.status === "ok" ? await this.currentVk(r.gen.keyring) : null;
    return vk
      ? { vk, activeVkId: () => this.store.activeVkId(), cleanupPending: () => this.store.cleanupPending() }
      : null;
  }

  /**
   * `epoch`: the lock epoch read before the caller last checked that the vault is open (an unlock): a lock after that
   * check then voids this session at once, instead of being absorbed by an epoch read now. Without it, the epoch now.
   */
  protected async startSession(vk: Vk, epoch?: number): Promise<number> {
    const e = epoch ?? (await this.session.lockEpoch());
    await this.session.set({ vk: toB64(vk.raw), lastActive: this.now(), epoch: e });
    return e;
  }

  /**
   * Record activity so an idle timer measures time since the last use. Cheap; call on popup open and on interaction.
   * It reads and then writes, under no lock, so a lock in another context (the service worker on screen lock) can come in
   * between (GM2-10). A session that a lock has already voided is not written back, and if the lock lands between that
   * check and the write, the key just written goes again. Only the lock counter is read for this (chrome.storage.session),
   * nothing more from chrome.storage.local.
   */
  async touch(): Promise<void> {
    const s = await this.session.get();
    if (!s) return;
    const voided = async () => s.epoch !== undefined && (await this.session.lockEpoch()) > s.epoch;
    if (await voided()) return;
    await this.session.set({ ...s, lastActive: this.now() });
    if (await voided()) await this.session.clear();
  }

  /**
   * The soft lock (QUICK-UNLOCK §5.5, §5.12): Lock now in the popup, the `lock` command, the idle timer, the screen lock.
   * The unlocked key goes from everywhere and the lock epoch moves on, so every open page drops what it holds; a live
   * gate's arming (sk_quick) stays, and the PIN's record is on disk, so either reopens Sixkey.
   */
  async lock(): Promise<void> {
    this.typed = null;
    await this.session.clear();
  }

  // ---- first run and unlock ------------------------------------------------------------------

  /**
   * Unlock and return what the popup shows next (PHASE0X-PLAN A2): the same reads as opening, plus the session write.
   * The password as typed or, once, its generator spelling (openWithPassword): still one attempt, so a wrong one is one
   * record. Once open, the input hint is made to agree with the spelling that opened it (noteFormat).
   */
  async unlockWithPassword(password: string): Promise<UnlockResult> {
    let spelling = password;
    return this.unlockWith(
      async (k) => {
        const o = await openWithPassword(k, password);
        spelling = o.password;
        return o.vk;
      },
      "unlock_failed",
      undefined,
      (r) => this.noteFormat(r.gen.keyring, spelling),
      true,
    );
  }

  async unlockWithRecoveryCode(code: string): Promise<UnlockResult> {
    return this.unlockWith((k) => unlockWithRecoveryCode(k, code), "recovery_failed", "recovery_used");
  }

  /**
   * A wrong password or code is recorded in the security log before the error is thrown; one that is not even well-formed
   * (an empty password, a recovery code of the wrong length or checksum) is a typo, not a guess, and is not. A successful
   * password unlock reads and writes nothing more than before: the degraded-mirror unlock in read-budget.test.ts is at
   * its limit (10 of 10). The master password's time for the 14 days of the device unlock is written after it by the lock
   * screen's device chunk, not here (core/service/prf-write.ts notePasswordTyped; docs/design/notes/PRF-NOTES.md §5).
   * (The input hint, `after`, is one read of chrome.storage.session after the vault is open, and a
   * write there only when it does not agree yet: nothing more of chrome.storage.local.) The popup's notice reads the log
   * itself, after the first code is on screen and only after an unlock (C7): the one documented exception, which is why
   * perf.spec.ts allows 10 in all for an unlock (9 without it).
   * An accepted recovery code is recorded before the vault is opened (one get and one set of the log under its own lock,
   * on that rare path only; no gate measures it).
   */
  private async unlockWith(
    fn: (k: Keyring) => Promise<Vk>,
    failed: SecurityKind,
    used?: SecurityKind,
    after?: (r: Extract<ViewLoad, { status: "ok" }>) => Promise<void>,
    typed = false,
  ): Promise<UnlockResult> {
    const r = await this.store.loadView(this.also);
    if (r.status !== "ok") throw new ServiceError("bad_state", r.status);
    let vk: Vk;
    try {
      vk = await fn(r.gen.keyring);
    } catch (e) {
      if (e instanceof CryptoError && e.code === "unwrap_failed") {
        await this.record(failed);
        throw new ServiceError("wrong_secret");
      }
      throw e;
    }
    if (used) await this.record(used);
    const done = await this.finishUnlock(vk, r, { arm: true, typed });
    await after?.(r);
    return done;
  }

  // ---- the input hint (sk_pw_format, pw-format.ts): shown by the prompts, never used to decide anything ----------------

  /**
   * After a password unlock: the hint made to agree with the password that just opened `keyring` (`spelling`, from
   * openWithPassword). One read of chrome.storage.session, and a write only when the record there says otherwise, so the
   * steady state writes nothing. This is how the hint comes back after a browser restart (session storage is memory
   * only), with no re-encryption; a forged or stale record is put right. Never throws: the unlock has happened.
   */
  private async noteFormat(keyring: Keyring, spelling: string): Promise<void> {
    if (!this.formats) return;
    const rec = formatRecord(keyring, spelling);
    let have: unknown;
    try {
      have = await this.formats.read();
    } catch {
      // not read: written again below, which is all a read could have saved
    }
    if ((rec?.format ?? null) !== formatFor(have, keyring)) await this.saveFormat(rec);
  }

  /**
   * The hint for a password just set (formatRecord: only for a generator spelling), or none (null: removed). Called once
   * the change has committed. Never throws.
   */
  protected async saveFormat(rec: PwFormatRecord | null): Promise<void> {
    if (!this.formats) return;
    try {
      await this.formats.write(rec);
    } catch (e) {
      this.diag("password input hint not saved", e);
    }
  }

  /**
   * `arm`: an unlock with the master password or the recovery code (the root secrets) arms the Touch ID / Windows Hello
   * gate (QUICK-UNLOCK §5.4 "Arming"); a PIN unlock does not, so the gate's 12 hours count from the root secret. `sv` and `epoch`:
   * the settings and the lock epoch the caller read before it checked the secret (the PIN unlock), so a lock meanwhile
   * voids the new session at once. `typed`: the master password opened it (unlockWithPassword): the one-shot mark the PIN's
   * note takes (`typed`, above); any other unlock drops it.
   */
  private async finishUnlock(
    vk: Vk,
    r: Extract<ViewLoad, { status: "ok" }>,
    o: { arm?: boolean; sv?: SettingsView; epoch?: number; typed?: boolean } = {},
  ): Promise<UnlockResult> {
    this.typed = null;
    const opened = await this.store.openVault(vk, r.gen); // also repairs a copy that does not decrypt
    const [epoch, sv] = await both(
      this.startSession(vk, o.epoch),
      o.sv ? Promise.resolve(o.sv) : this.settings.getView(),
    );
    if (o.typed) this.typed = { vkId: vk.id, epoch };
    if (o.arm) await this.arm(vk, opened.gen.keyring, r.also, sv.settings);
    if (r.cleanup !== "none") await this.housekeeping(vk, opened.gen.keyring, r.cleanup);
    const view = this.unlockedView(opened, r.events, !hasDevice(opened.gen.keyring), sv);
    return opened.recovered ? { recovered: opened.recovered, view } : { view };
  }

  // ---- the session gate: Touch ID / Windows Hello without PRF (QUICK-UNLOCK §5.2, §5.4 "Gate unlock") ----------------
  //
  // sk_quick (chrome.storage.session only, SessionCache) is the gate's arming: the vault key as it is (QuickDevice), armed
  // by a master password or recovery key unlock while a gate credential of this vault and key is enrolled, for at most
  // 12 hours, in a solo profile; the gate's unlock is device-unlock.ts's. Since 2026-10-30 the PIN has no part in it: the
  // PIN's one record is sk_pin_restart (pin-restart.ts), which the lock screens ask through pin-restart-steps.ts.
  // Whatever ends the PIN (its 5th wrong try, "End quick unlock now") ends the gate's arming too (OWNER-DECISIONS/17 Q1).

  /**
   * Arm sk_quick for `vk` from sk_prf as loadView read it (`also`), from now: the Touch ID / Windows Hello gate when a gate
   * credential of this key is enrolled. Never in a profile declared shared. Never throws: the unlock it follows has
   * happened.
   */
  private async arm(vk: Vk, keyring: Keyring, also: Record<string, unknown> | undefined, settings: Settings) {
    if (profileOf(settings) === "shared" || !this.hasGate(also, keyring)) return;
    const q = armDevice(vk, keyring.vaultId, this.now(), wrapsTag(keyring));
    try {
      await this.quickLock(() => this.session.setQuick(q));
    } catch (e) {
      this.diag("quick unlock not armed", e);
    }
  }

  /**
   * sk_quick usable with this keyring (its vault, key and wraps unchanged since the arming) at `now`, while a gate
   * credential of this vault and key is enrolled (sk_prf as loadView read it: `also`).
   */
  private quickUsable(q: QuickSession, keyring: Keyring, also: Record<string, unknown> | undefined, now: number) {
    return (
      quickLive(q, now) &&
      q.vaultId === keyring.vaultId &&
      q.vkId === keyring.vkId &&
      q.wraps === wrapsTag(keyring) &&
      this.hasGate(also, keyring)
    );
  }

  /** Delete sk_quick if it is still the arming `q` (armed again meanwhile: left alone). In the quick lock. */
  private async dropIfSame(q: QuickSession): Promise<boolean> {
    return this.quickLock(async () => {
      const cur = await this.session.getQuick();
      if (!cur || !sameArming(cur, q)) return false;
      await this.session.clearQuick();
      return true;
    });
  }

  /**
   * The lock screen's look at sk_quick (openView, locked): sk_prf and the keyring came with loadView's reads, sk_quick is
   * one read of chrome.storage.session, so a lock screen reads nothing more from chrome.storage.local. True when the gate
   * can open Sixkey now (its button). One that cannot be used is deleted here only when that is the record's own fault
   * (expired, the clock set back): a mismatch with sk_prf or the keyring may be this look's own stale read, racing a new
   * arming, and is left to the unlock, which reads them again after it. A profile declared shared has none:
   * RoutedSession.get(), which openView has just called, sweeps it (and each unlock checks the profile itself).
   */
  private async lockScreenGate(r: Extract<ViewLoad, { status: "ok" }>): Promise<boolean> {
    if (!this.prfs) return false;
    const q = await this.session.getQuick();
    if (!q) return false;
    const now = this.now();
    if (this.quickUsable(q, r.gen.keyring, r.also, now)) return true;
    if (!quickLive(q, now)) await this.dropIfSame(q);
    return false;
  }

  // ---- the device unlock's steps (QUICK-UNLOCK Stage 2) --------------------------------------------------------------
  //
  // For device-unlock.ts, a lazy chunk that imports nothing of the popup's main chunk (docs/design/notes/PRF-NOTES.md):
  // the rules it applies are read here, where the lock screen's view reads them, by the same functions.

  /**
   * What sk_prf, read with the pointer (`r.also`), offers this keyring at `now` with these settings: the PRF credentials
   * whose wraps open this vault key (`prf`), whether one waits for "turn back on" (`paused`), whether the master password
   * was typed in the last 14 days (`recent`, Q3), and the gate credentials when the gate is the session method in a solo
   * profile (`gates`; none in a shared one).
   */
  private devicePlan(r: Extract<ViewLoad, { status: "ok" }>, settings: Settings, now: number) {
    const k = r.gen.keyring;
    const prf = this.prfs ? prfFor(r.also?.[PRF_KEY], k) : null;
    return {
      prf: prf ? prfCreds(prf, k.vkId) : [],
      paused: !!prf && pausedCreds(prf, k.vkId).length > 0,
      recent: !!prf && passwordRecent(prf, now),
      gates: prf && profileOf(settings) !== "shared" ? gateCreds(prf, k.vkId) : [],
    };
  }

  /** sk_prf (loadView's `also`) has a gate credential of this vault and key: the master password arms the gate too. */
  private hasGate(also: Record<string, unknown> | undefined, keyring: Keyring): boolean {
    const prf = this.prfs ? prfFor(also?.[PRF_KEY], keyring) : null;
    return prf !== null && hasGate(prf, keyring.vkId);
  }

  /** A vault key's raw bytes as a Vk (its id derived by vk.ts), or null. */
  private vkOf(raw: Uint8Array): Promise<Vk | null> {
    return vkFromRaw(raw).catch(() => null);
  }

  /**
   * Finish a key change that a crash interrupted, or do the one full check a store from before the marker gets
   * (PHASE0X-PLAN A2): scrub old key material and re-encrypt snapshots. Runs only when loadView says it is due. A
   * failure does not fail the unlock or the open: it is logged, the marker stays, and the next one tries again.
   */
  private async housekeeping(vk: Vk, keyring: Keyring, cleanup: Cleanup): Promise<void> {
    try {
      // A mirror-only marker is left only by a cleanup that finished this store, records first (below): the records are
      // under this key already, so only the store's mirror part runs (it keeps the degraded unlock's reads where they were).
      await this.finishKeyChanges(vk, keyring, [], cleanup === "full");
      // Not done means the mirror is out of reach: the store has logged why, and its marker asks the next unlock to retry.
    } catch (e) {
      this.diag("key change cleanup incomplete", e);
    }
  }

  /**
   * The one cleanup entry point (SYNC-DESIGN §0.0i M2 req. 5, GM2-4): after a key change, or when a check is due, move
   * every copy that is not under the current key `vk` to it. Nothing else calls the store's finishKeyChange
   * (test/unit/source-rules.test.ts): the unlock and open cleanup (housekeeping), the one after this page's own key
   * changes (scrub) both come through here.
   *   - The keys it can open with: `keyring`'s previous ones, plus `held`, the old keys the caller has in memory (a
   *     rotation's old key). The re-encrypt
   *     callback built from them is the only record of which keys the caller holds; a copy it cannot open is kept or
   *     dropped by the store's rule (this vault: kept; another vault: dropped).
   *   - First the records outside the store (vkRecords), then the store's copies. A read that throws stops it where it
   *     is, before the store's part if it was a record's, and the marker stays for the next unlock. A record no key opens
   *     never holds the marker up. `records: false` only for a mirror-only marker (housekeeping).
   */
  protected async finishKeyChanges(
    vk: Vk,
    keyring: Keyring,
    held: readonly Vk[] = [],
    records = true,
  ): Promise<{ done: boolean }> {
    const keys = [...held, ...(await unwrapPreviousVks(keyring, vk))].filter(
      (k, i, all) => k.id !== vk.id && all.findIndex((o) => o.id === k.id) === i,
    );
    for (const rec of records ? this.vkRecords : []) {
      if ((await rec.reencrypt(vk, keys)) === "unopenable") this.diag(`${rec.name}: no key opens it`);
    }
    return this.store.finishKeyChange(vk, async (env) => {
      const old = keys.find((o) => o.id === env.vkId);
      if (!old) return null;
      return encryptVault(await decryptVault(env, old), vk, { vaultId: env.vaultId, rev: env.rev }, this.rng);
    });
  }

  // ---- the security log (H6) and asking for the password again (H3) ---------------------------

  /** Add to the security log. Never throws: the step being recorded has already happened. */
  protected async record(kind: SecurityKind): Promise<void> {
    if (!this.security) return;
    try {
      await this.security.append(kind);
    } catch (e) {
      this.diag("security log entry not written", e);
    }
  }

  // ---- reading and editing the vault ---------------------------------------------------------

  /**
   * Edit the vault. `fn` gets the current vault, a clock that is already past every timestamp in it, and the reference
   * time (this machine's clock), and returns the new vault (or the same object for "no change"). The read-edit-write is
   * one locked step. `after`: called with the generation committed, still inside the store's lock, guarded by the store
   * (a throw is a diagnostics line): the settings page's message to the worker about the very generation it wrote (the
   * backup in Chrome sync's merges).
   */
  async mutate(
    fn: (vault: Vault, clock: Clock, now: number) => Vault | Promise<Vault>,
    after?: (gen: Generation) => void,
  ): Promise<Vault> {
    let result!: Vault;
    const device = await this.settings.deviceId();
    await this.store.transact(
      async (cur) => {
        if (!cur) throw new ServiceError("bad_state", "no vault");
        const vk = await this.requireVk(cur.keyring);
        const vault = deserializeVault(await decryptVault(cur.envelope, vk));
        const clock = createClock(device, { now: () => this.now() });
        observeVault(clock, vault);
        const next = await fn(vault, clock, this.now());
        result = next;
        if (next === vault) return { envelope: cur.envelope, keyring: cur.keyring };
        // Refuse to save anything the next load would reject: a save that cannot be read back looks like corruption and gets rolled back.
        const bytes = serializeVault(next);
        deserializeVault(bytes);
        const envelope = await encryptVault(
          bytes,
          vk,
          { vaultId: cur.envelope.vaultId, rev: cur.envelope.rev + 1 },
          this.rng,
        );
        return { envelope, keyring: cur.keyring };
      },
      after ? { afterCommit: async (gen) => after(gen) } : {},
    );
    return result;
  }

  async ackEvents(ids?: string[]): Promise<void> {
    await this.store.ackEvents(ids);
  }
}
