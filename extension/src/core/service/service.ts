// Application service: ties storage, crypto, the vault model and the unlock session together.
// The popup, options page and service worker all call this; none of them touch keys or storage directly.
// VaultService is the whole service, built by the settings page and the service worker. It extends ServiceCore
// (service-core.ts), the part the popup loads and builds alone, so the methods here are not in the popup's bundle
// (docs/design/notes/BUDGET-NOTES.md). The types and helpers that moved there are exported from here as before.
import { CryptoError } from "../crypto/bytes";
import { decryptVault, encryptVault, type EncryptedVault } from "../crypto/envelope";
import {
  changePassword as changePasswordWrap,
  listMethods,
  newVaultId,
  openWithPassword,
  rekey,
  setPassword,
  setRecovery,
  unlockWithDevice,
  unlockWithRecoveryCode,
  unwrapPreviousVks,
  validateKeyring,
  type Keyring,
} from "../crypto/keyring";
import { PBKDF2_PASSWORD_WRAP_ITERATIONS } from "../crypto/kdf";
import { checkPasswordPolicy } from "../crypto/password-policy";
import { quickLive, wrapsTag } from "../crypto/pin";
import { formatRecoveryCode, parseRecoveryCode } from "../crypto/recovery-code";
import { MAX_SHARES, makeShareSet, parseShare, recoveryCodeFromShares, setIdText, type Share } from "../crypto/shares";
import { generateVk, type Vk } from "../crypto/vk";
import type { Generation } from "../storage/format";
import { StorageError, type TransactInfo } from "../storage/store";
import { SYNC_CONSTANTS } from "../sync/crypto/constants";
import { capPrevious } from "../sync/crypto/cap-previous";
import { createClock, type Clock } from "../vault/hlc";
import { canonicalJson, mergeVaults } from "../vault/merge";
import { emptyVault, entryIdentity, isPurged, type Vault } from "../vault/model";
import { addAccountsFrom, clampVault, observeVault, purgeEntry } from "../vault/ops";
import { deserializeVault, serializeVault } from "../vault/validate";
import type { StorageEvent } from "../storage/format";
import { applyPreset, type PresetId } from "./presets";
import { updatePrf } from "./prf-write";
import { formatRecord, type PwFormatRecord } from "./pw-format";
import type { ExportKind, SecurityKind, SharesReminder } from "./security-log";
import { ServiceError } from "./service-error";
import { removeRestart, setAsideRestart } from "./pin-restart-admin";
import { rewrappedHere, rotatedHere } from "./rotated";
import { hasDevice, isSessionExpired, ServiceCore } from "./service-core";
import { profileOf, type Settings } from "./types";

export { ServiceError, type ServiceErrorCode } from "./service-error";

export {
  ALWAYS_MODE_MAX_IDLE_MINUTES,
  isSessionExpired,
  type OpenView,
  type PinUnlock,
  type QuickView,
  type ServiceDeps,
  type SyncPort,
  type UnlockedView,
  type UnlockResult,
  type VkRecord,
  type VkRecordResult,
} from "./service-core";

export type ServiceStatus =
  | { state: "empty" }
  | { state: "lost" }
  | { state: "locked"; events: StorageEvent[] }
  | { state: "unlocked"; passwordProtected: boolean; events: StorageEvent[] };

/**
 * Required by every operation that makes a new recovery code (GM2-1(b), A4R-5): `onCode` is the ONLY way the code leaves
 * the service. It is called as soon as the change has committed, before the session, the cleanup and the rest are
 * written, so the page shows the code at once; the call's promise settles once all of that is done, with nothing in it.
 * A page that died meanwhile has shown the code, and the key-change marker finishes the cleanup at the next open or
 * unlock. A throw from `onCode` is logged and changes nothing (the page then shows no code: pass a setter that cannot
 * throw). The code is not also returned, so no page can wait for the cleanup before showing it.
 */
export type CodeDelivery = { onCode: (recoveryCode: string) => void };

/**
 * A password reset prepared in memory (GM2-13): the new password and recovery code wrapped around the vault key, nothing
 * written. The page shows `recoveryCode`; only once the user has confirmed it is saved does commitReset write it.
 */
export type PreparedReset = { readonly recoveryCode: string };
const preparedResets = new WeakMap<
  PreparedReset,
  { base: string; keyring: Keyring; vk: Vk; format: PwFormatRecord | null }
>();

/**
 * The keys for a vault that does not exist yet (PHASE0X-PLAN A1; SYNC-DESIGN H1, Z1), made by prepareKeys before anything
 * is written: a new vault key wrapped by the master password and by a new recovery code, never by a device key. The page
 * shows `recoveryCode`, the user confirms it is saved, and only then is the handle given to create, restoreBackup or
 * startOver, which write it once. A page closed before that has written nothing, so there is nothing to undo.
 * The handle is opaque: the key and keyring stay in this module and are dropped once a write with them has committed.
 */
export type PreparedKeys = { readonly vaultId: string; readonly recoveryCode: string };
// `format`: the input hint for the new password (pw-format.ts; not the password), written once makeVault has committed
const preparedKeys = new WeakMap<PreparedKeys, { keyring: Keyring; vk: Vk; format: PwFormatRecord | null }>();

/**
 * What the shares wizard asks for (docs/design/notes/SHAMIR-NOTES.md): 2 of 3 by default, or 3 of 5; the format allows
 * any 2 <= threshold <= count <= 16.
 */
export type ShareSetup = { threshold: number; count: number };

/**
 * A share set made in memory by prepareShares (ADVANCED-RECOVERY-AND-TIERS §3.1, §3.6), nothing written. `shares[i]` is
 * member i's text (the page shows it as share i + 1); `test` are the members, chosen at random, that the person types
 * back before confirmShares accepts the set. `mode`:
 *   - "replace": the shares are of a NEW recovery code, which is not committed until confirmShares: until then the old
 *     code (and its shares) open the vault and these open nothing. The new code is never shown as one code;
 *   - "split": the shares are of the current recovery code, typed by the person; nothing is ever written for them.
 * The handle is opaque; the new keyring and the vault key stay in this module and are dropped once it is confirmed.
 */
export type PreparedShares = {
  readonly mode: "replace" | "split";
  readonly setId: string;
  readonly threshold: number;
  readonly count: number;
  readonly shares: readonly string[];
  readonly test: readonly number[];
};
// `base`: the keyring as it was when the set was made (canonical JSON); `next`: the keyring with the new recovery wrap
// and its vault key ("replace" only)
const preparedShares = new WeakMap<PreparedShares, { base: string; next: { keyring: Keyring; vk: Vk } | null }>();

/** The key events that make a new recovery code: each ends a pending shares reminder (committed). */
const RECOVERY_CHANGES: readonly SecurityKind[] = [
  "recovery_code_new",
  "key_rotated",
  "password_reset",
  "password_enabled",
];

/** What the first-run question decided (H5): a preset, saved together with the new vault. */
export type FirstRunChoice = { preset?: PresetId };

/** Thrown inside the lock when the vault already there holds the very keys being written. Never leaves makeVault. */
const LANDED = new Error("landed");

export class VaultService extends ServiceCore {
  /**
   * Every key operation here makes its new master-password wrap with this: PBKDF2_PASSWORD_WRAP_ITERATIONS (kdf.ts;
   * OWNER-DECISIONS/15), or the test hook's count. Only the wraps take it: the recovery wrap is HKDF, and the PIN's set-up
   * (pin-admin.ts) reads the hook itself and otherwise keeps kdf.ts's default, as backup files and the sync engine do.
   */
  private get ctx() {
    return { now: this.now, rng: this.rng, iterations: this.iterations ?? PBKDF2_PASSWORD_WRAP_ITERATIONS };
  }

  // ---- state ---------------------------------------------------------------------------------

  async status(): Promise<ServiceStatus> {
    const r = await this.store.load();
    if (r.status !== "ok") return { state: r.status };
    const events = await this.store.listEvents();
    const vk = await this.currentVk(r.gen.keyring);
    return vk
      ? { state: "unlocked", passwordProtected: !hasDevice(r.gen.keyring), events }
      : { state: "locked", events };
  }

  /**
   * The hard lock: the soft lock, and the Touch ID / Windows Hello gate's arming ended (sk_quick deleted, under its lock),
   * so only the master password, the recovery code or the PIN (its own record's, pin-restart.ts) opens Sixkey again.
   * "End quick unlock now" sets the PIN's record aside first (PinAdmin.endQuickUnlock).
   */
  private async hardLock(): Promise<void> {
    // sk_quick first: a page that dies in between is left unlocked as before, never with the gate still working
    await this.quickLock(() => this.session.clearQuick());
    await this.session.clear();
  }

  /** The gate's arming ended, the unlocked key left as it is (a key change that restarts the session itself). */
  private async endQuickQuietly(): Promise<void> {
    try {
      await this.quickLock(() => this.session.clearQuick());
    } catch (e) {
      this.diag("session quick unlock not ended", e);
    }
  }

  /**
   * For the service worker's sk-quick-expiry alarm: delete sk_quick once it can no longer be used (its 12 hours are over,
   * the clock went back). Returns when it ends if it is still live, else null.
   */
  async enforceQuickExpiry(): Promise<number | null> {
    return this.quickLock(async () => {
      const q = await this.session.getQuick();
      if (!q) return null;
      if (quickLive(q, this.now())) return q.expiresAt;
      await this.session.clearQuick();
      return null;
    });
  }

  /**
   * For the service worker's timer. Returns true if it locked. Also clears a session that a lock has voided (an older
   * lock epoch, as touch() racing a lock could leave), so the raw key does not wait in chrome.storage.session for the
   * next page to look at it.
   */
  async enforceAutoLock(): Promise<boolean> {
    const s = await this.session.get();
    if (!s) return false;
    const voided = s.epoch !== undefined && (await this.session.lockEpoch()) > s.epoch;
    if (voided || isSessionExpired(await this.settings.get(), s, this.now())) {
      await this.session.clear();
      return true;
    }
    return false;
  }

  async getSettings(): Promise<Settings> {
    return this.settings.get();
  }

  /**
   * Switching to "lock every time" locks now, so a key already stored for other contexts does not outlive the choice. A
   * change of lock mode, and declaring the profile shared, are hard locks (QUICK-UNLOCK §5.5): the gate's arming ends with
   * them. `next` without a profile keeps the one stored (a caller written before the marker cannot flip it). A profile
   * declared shared also loses the PIN's record (OWNER-DECISIONS/20: no PIN there), at every save there; a change of lock
   * mode leaves it ("lock every time" opens with the PIN too).
   */
  async updateSettings(next: Settings): Promise<void> {
    if ((await this.saveSettings(next)) !== "shared" || !this.pins) return;
    await removeRestart(this.pins);
  }

  /**
   * updateSettings' own step, which the first-run answer also takes inside the vault's transact (saveChoice): it takes the
   * quick lock only (the hard lock), never the vault lock, which webLock would not give twice. makeVault removes the PIN's
   * record itself, once its write is done. Returns the profile saved.
   */
  private async saveSettings(next: Settings): Promise<"solo" | "shared"> {
    const prev = await this.settings.get();
    const merged: Settings = next.profile === undefined ? { ...next, profile: profileOf(prev) } : next;
    await this.settings.set(merged);
    const toShared = profileOf(merged) === "shared" && profileOf(prev) !== "shared";
    if (merged.autoLock.mode !== prev.autoLock.mode || toShared) await this.hardLock();
    return profileOf(merged);
  }

  // ---- first run and unlock ------------------------------------------------------------------

  /**
   * Step one of every way to get a vault (new, restored from a backup, started over): the master password goes in first
   * (H1). Checks the password policy and builds the keyring in memory, the same way rekey does: a new VK with a password
   * wrap and a recovery wrap, no device key, nothing previous. Writes nothing at all. `vaultId` is for a restore, which
   * keeps the backup's id.
   */
  async prepareKeys(password: string, opts: { vaultId?: string } = {}): Promise<PreparedKeys> {
    this.requirePolicy(password);
    const vk = await generateVk(this.rng);
    const base: Keyring = {
      format: "sixkey-keyring",
      v: 1,
      vaultId: opts.vaultId ?? newVaultId(this.rng),
      vkId: vk.id,
      wraps: [],
      previous: [],
    };
    const { keyring, recoveryCode } = await setRecovery(await setPassword(base, vk, password, this.ctx), vk, this.ctx);
    validateKeyring(keyring); // a malformed vault id fails here, before a recovery code is ever shown
    const handle: PreparedKeys = Object.freeze({ vaultId: keyring.vaultId, recoveryCode });
    preparedKeys.set(handle, { keyring, vk, format: formatRecord(keyring, password) });
    return handle;
  }

  /**
   * The keys of a vault restored from the cloud backup (CLOUDBK patch 5; CLOUD-BACKUP.md §3.6 step 5): the restored keyring
   * and vault key as they are, for restoreBackup to write, with no new recovery code (the restored one stays). A password
   * restore keeps the wrap the typed password opened (`typed`, for the generated password's format); a recovery-key restore
   * has the recovery wrap only and is the reset: `newPassword` becomes the master password (held to the floor). A keyring
   * with no password wrap is refused, so no restored vault is ever written without one.
   */
  async prepareRestoredKeys(
    keyring: Keyring,
    vk: Vk,
    password: { typed: string } | { newPassword: string },
  ): Promise<PreparedKeys> {
    let k = validateKeyring(keyring);
    if (k.vkId !== vk.id) throw new ServiceError("bad_state", "the vault key is not the keyring's");
    if ("newPassword" in password) {
      this.requirePolicy(password.newPassword);
      k = await setPassword(k, vk, password.newPassword, this.ctx);
    }
    if (!listMethods(k).includes("password"))
      throw new ServiceError("bad_state", "a restored keyring needs a password");
    const pw = "newPassword" in password ? password.newPassword : password.typed;
    const handle: PreparedKeys = Object.freeze({ vaultId: k.vaultId, recoveryCode: "" });
    preparedKeys.set(handle, { keyring: k, vk, format: formatRecord(k, pw) });
    return handle;
  }

  /**
   * This vault's earlier backup files, opened (CLOUDBK patch 5: a page merges them before the worker deletes them; review
   * r3 S1, S2): each generation of this vault under the vault key or an earlier one this keyring holds, decrypted; null
   * for one of another vault, under a key not held here, or that does not read. Writes nothing; needs the unlocked key.
   */
  async openOwnGenerations(gens: readonly Generation[]): Promise<(Vault | null)[]> {
    const r = await this.store.load();
    if (r.status !== "ok") throw new ServiceError("bad_state", "no vault");
    const vk = await this.requireVk(r.gen.keyring);
    const keys = [vk, ...(await unwrapPreviousVks(r.gen.keyring, vk).catch((): Vk[] => []))];
    return Promise.all(
      gens.map(async (g) => {
        if (g.keyring?.vaultId !== r.gen.keyring.vaultId) return null;
        const key = keys.find((k) => k.id === g.envelope?.vkId);
        if (!key) return null;
        try {
          const v = deserializeVault(await decryptVault(g.envelope, key));
          return v.vaultId === r.gen.keyring.vaultId ? v : null;
        } catch {
          return null;
        }
      }),
    );
  }

  private keysOf(keys: PreparedKeys): { keyring: Keyring; vk: Vk; format: PwFormatRecord | null } {
    const k = preparedKeys.get(keys);
    if (!k) throw new ServiceError("bad_state", "keys already used or not from prepareKeys");
    return k;
  }

  /**
   * Runs inside the lock, after the check that no vault appeared and before the keyring is written. So the first-run answer
   * is in place before the key is: in "lock every time" mode startSession then keeps the key in this page's memory, and a
   * second setup page that lost the race is refused before it can change anything. Changing the lock mode clears the
   * session; with no vault yet that costs nothing. If the write after it fails, the answer stays saved with no vault:
   * harmless, since every way to a vault asks again and saves the new answer.
   */
  private async saveChoice(choice: FirstRunChoice): Promise<void> {
    if (choice.preset) await this.saveSettings(applyPreset(await this.settings.get(), choice.preset));
  }

  /**
   * The one locked write that makes a vault from prepared keys (create, restoreBackup, startOver): from one of the states
   * in `from`, with the first-run answer saved first, then the vault unlocked. Keys are spent only once all of that worked;
   * keys whose write committed cannot be used again.
   *
   * A write can land and still report a failure: the read-back after the slot write throws, or the session cannot be
   * stored after the commit. A retry with the same keys then finds a vault holding exactly these keys. It is this
   * attempt's own vault, opened by the recovery code the user already saved, so it counts as done; refusing it would tell
   * the user nothing was written and push them to throw away the one code that opens their vault.
   */
  private async makeVault(
    keys: PreparedKeys,
    choice: FirstRunChoice,
    from: readonly ("empty" | "lost")[],
    first: (keyring: Keyring, vk: Vk) => Promise<EncryptedVault>,
    after?: (gen: Generation) => void,
  ): Promise<void> {
    const { keyring, vk, format } = this.keysOf(keys);
    const ours = (g: Generation) => canonicalJson(g.keyring) === canonicalJson(keyring);
    const cur = await this.store.load();
    let landed = cur.status === "ok" && ours(cur.gen);
    if (!landed) {
      if (cur.status === "ok" || !from.includes(cur.status)) throw new ServiceError("bad_state", cur.status);
      // what the records beside the old vault grant, which the new key will not verify, withdrawn before the commit
      // (VkRecord.beforeNewVault): a newVault below cut short then leaves none of it honoured; never failing the making
      for (const rec of this.vkRecords)
        await rec
          .beforeNewVault?.(vk)
          .catch((e: unknown) => this.diag(`${rec.name}: not withdrawn before the new vault`, e));
      try {
        await this.store.transact(
          async (now) => {
            if (now && ours(now)) throw LANDED; // these same keys, written by a concurrent call
            if (now) throw new ServiceError("bad_state", "a vault appeared meanwhile"); // another page got there first
            await this.saveChoice(choice);
            return { envelope: await first(keyring, vk), keyring };
          },
          { overwriteLost: cur.status === "lost", ...(after ? { afterCommit: async (g) => after(g) } : {}) },
        );
      } catch (e) {
        if (e !== LANDED) throw e;
        landed = true;
      }
    }
    if (landed) await this.saveChoice(choice); // saved with the write already; this keeps an answer changed since
    // a new vault (a first one, a backup restored, Start over): a reminder to check shares of the vault before is moot,
    // and its shares can never pass here (the security record outlives the vault). Never rejects.
    await this.security?.remind?.(null);
    await this.endQuickQuietly(); // a new vault key: no session quick unlock from before it (QUICK-UNLOCK §5.5)
    await this.startSession(vk);
    preparedKeys.delete(keys); // dropped from memory only now, so a failed session write above can be retried
    await this.dropStalePin(keyring);
    await this.dropStalePrf(keyring);
    await this.dropRestart();
    // the records kept beside the vault before this one that the new key cannot open (the plugin grants), set aside for
    // the new vault by their own rules (VkRecord.newVault, W2a r3), as the PIN's and the device unlock's are dropped
    // above; never failing the vault's making
    for (const rec of this.vkRecords)
      await rec.newVault?.(vk).catch((e: unknown) => this.diag(`${rec.name}: not set aside for the new vault`, e));
    await this.saveFormat(format);
  }

  /** A PIN set up for another vault or key is of no use: removed (it holds no vault data). Never throws. */
  private async dropStalePin(keyring: Keyring): Promise<void> {
    if (!this.pins) return;
    try {
      const p = await this.pins.read();
      if (p !== null && (p === "damaged" || p.vaultId !== keyring.vaultId || p.vkId !== keyring.vkId))
        await this.pins.remove();
    } catch (e) {
      this.diag("stale PIN set-up not removed", e);
    }
  }

  /**
   * The PIN's record is of no use after a new vault (a first one, a backup restored, Start over: a new vault key,
   * whatever the vault id): removed, whatever it holds (OWNER-DECISIONS/20). Never throws.
   */
  private async dropRestart(): Promise<void> {
    try {
      if (this.pins) await removeRestart(this.pins);
    } catch (e) {
      this.diag("PIN record not removed", e);
    }
  }

  /**
   * The device unlock's record for another vault is of no use after a new vault (QUICK-UNLOCK §7.1: a start over or a
   * restore with a new vault id clears everything): removed, like the PIN's set-up; its passkeys stay in the OS, and can be
   * added again. One for this vault (a restore that keeps the backup's id) is left to the key-change rules: its wraps are
   * under another vault key, so it shows as paused. Never throws.
   */
  private async dropStalePrf(keyring: Keyring): Promise<void> {
    if (!this.prfs) return;
    try {
      await updatePrf(this.prfs, (r) =>
        r !== null && (r === "damaged" || r.vaultId !== keyring.vaultId) ? null : undefined,
      );
    } catch (e) {
      this.diag("stale device unlock record not removed", e);
    }
  }

  /** A new, empty vault under keys from prepareKeys, with the first-run answer. Refused if a vault (another one) exists. */
  async create(keys: PreparedKeys, choice: FirstRunChoice = {}): Promise<void> {
    await this.makeVault(keys, choice, ["empty"], (keyring, vk) =>
      encryptVault(serializeVault(emptyVault(keyring.vaultId)), vk, { vaultId: keyring.vaultId, rev: 0 }, this.rng),
    );
  }

  // ---- the security log (H6) and asking for the password again (H3) ---------------------------

  /**
   * A key operation that checks a password or a recovery code inside its transact: a wrong one is recorded once the
   * transact has given up (outside its lock, nothing of the vault written), then the error goes on to the caller.
   */
  private async guarding<T>(failed: SecurityKind, op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (e) {
      if (e instanceof ServiceError && e.code === "wrong_secret") await this.record(failed);
      throw e;
    }
  }

  /**
   * Is this the master password? For H3: every export asks for it again, even when the vault is unlocked. Checked against
   * the keyring of the vault as stored now, and nothing else changes: the session is not read or written (so it works the
   * same in "lock every time" mode, with the key in another page's memory, and while locked), no vault key is written.
   * The one write is the security log's entry for a wrong password (unlock_failed, as at the lock screen). As at the lock
   * screen, a generated password typed loosely is accepted (openWithPassword: one key derivation more at most, still one
   * answer and one record).
   *   - Resolves if it is the password. Rejects with wrong_secret for any other password, and records each: every wrong
   *     answer looks the same. Only the master password counts: the recovery code is a wrong password here.
   *   - The empty string: the lock screen's CryptoError("empty_password"), not recorded, exactly as unlockWithPassword("")
   *     does. Nothing typed is not a guess (pages keep the button disabled on an empty field, as the lock screen does).
   *   - not_protected: a Phase 0 device-key vault has no master password to ask for (the page warns instead).
   *   - bad_state: no readable vault; nothing recorded. Reading goes through the store's load(), which repairs a damaged
   *     active copy as every open does; on a healthy store it writes nothing at all.
   * Not rate-limited beyond that key derivation (PBKDF2, at the count the wrap carries: 2M for a wrap made since
   * OWNER-DECISIONS/15, 600k for an older one): the lock screen is the same oracle and has no
   * limit either, a delay held in one page is gone by opening another, and a lockout is what SYNC-DESIGN rejects (F23:
   * it slows no one with a copy of the profile and becomes a way to lock the user out). Each wrong guess is recorded
   * instead, which is what the security card shows.
   */
  async verifyPassword(password: string): Promise<void> {
    const r = await this.store.load();
    if (r.status !== "ok") throw new ServiceError("bad_state", r.status);
    const keyring = r.gen.keyring;
    if (hasDevice(keyring) || !keyring.wraps.some((w) => w.method === "password"))
      throw new ServiceError("not_protected");
    let ok = false;
    try {
      ok = (await openWithPassword(keyring, password)).vk.id === keyring.vkId; // as typed or its generator spelling
    } catch (e) {
      if (!(e instanceof CryptoError && e.code === "unwrap_failed")) throw e;
    }
    if (!ok) {
      await this.record("unlock_failed");
      throw new ServiceError("wrong_secret");
    }
  }

  /**
   * Before anything that cannot be undone (the owner's rule, 2026-10-19; docs/design/notes/QUICK-PIN-NOTES.md): the
   * master password typed again whenever there is one, so that what opened the vault (a PIN guessed within its tries, an
   * unlocked browser left alone) never reaches it. verifyPassword's answers and records (a wrong one is recorded as
   * unlock_failed; "" is a typo). A Phase 0 device-key vault has no password to ask for: anyone at it can open the vault
   * anyway, so there `password` is ignored. With no readable vault: bad_state.
   */
  async requireMasterPassword(password: string): Promise<void> {
    try {
      await this.verifyPassword(password);
    } catch (e) {
      if (!(e instanceof ServiceError && e.code === "not_protected")) throw e;
    }
  }

  /**
   * The settings page calls this once an export has been written (H3, H6). Never throws; an unknown kind adds nothing:
   * checked here, since the record itself knows a kind by its form only (security-log.ts isKind), and `export_${kind}`
   * of any word has that form.
   */
  async recordExport(kind: ExportKind): Promise<void> {
    if (kind === "encrypted" || kind === "plain" || kind === "subset") await this.record(`export_${kind}`);
  }

  /**
   * Empty the security log (it keeps one log_cleared entry). The only way the pages can: the master password is checked
   * first (verifyPassword, so a wrong one is refused and recorded), because the person the log warns about is someone at
   * this browser without it, locked or not. A Phase 0 device-key vault has no password, and anyone at it can open the
   * vault anyway, so there it needs none (`password` is ignored). With no readable vault (bad_state) it is refused: there
   * is nothing to prove ownership of. A failure to write rejects; nothing is cleared then.
   */
  async clearSecurityLog(password: string): Promise<void> {
    try {
      await this.verifyPassword(password);
    } catch (e) {
      if (!(e instanceof ServiceError && e.code === "not_protected")) throw e;
    }
    await this.security?.clear();
  }

  // ---- reading and editing the vault ---------------------------------------------------------

  async read(): Promise<{ vault: Vault; recovered?: StorageEvent }> {
    const r = await this.store.load();
    if (r.status !== "ok") throw new ServiceError("bad_state", r.status);
    const vk = await this.requireVk(r.gen.keyring);
    const opened = await this.store.openVault(vk);
    if (!hasDevice(r.gen.keyring))
      await this.store.scrubStaleDeviceKey().catch((e) => this.diag("stale device key check failed", e));
    return opened.recovered ? { vault: opened.vault, recovered: opened.recovered } : { vault: opened.vault };
  }

  // ---- master password and recovery -----------------------------------------------------------

  private requirePolicy(password: string): void {
    if (!checkPasswordPolicy(password).ok) throw new ServiceError("weak_password");
  }

  /**
   * SYNC-DESIGN §0.0i item 18 (M2R-3): the Phase 0 key operations below commit locally first, so with sync on the next
   * round would take the server's bundle back over them (or call the server's key older). With sync on they are refused
   * (sync_on): the key operations go through the server first and then SyncFlows.commitKeys (§3.6–§3.8), and the pages
   * send the user there (M6). Checked inside each one's transact, so a join turning sync on in another page cannot land in
   * between, and before any secret is checked or recorded. One read; the popup runs none of them.
   */
  private async noSync(): Promise<void> {
    if (this.sync && (await this.sync.context())) throw new ServiceError("sync_on");
  }

  /**
   * Turn on the master password for a vault made before it was required (a device-key vault from Phase 0; new vaults
   * always start with one). The vault key is replaced (so a copy that still holds the old device-wrapped key cannot
   * open anything current), the device key is deleted, the other slot and all snapshots are rewritten, and the old key is
   * kept only inside the new keyring. The recovery code, to be shown once, goes to `deliver.onCode` as soon as the change
   * has committed (CodeDelivery). With sync on: sync_on (noSync).
   */
  async enableMasterPassword(password: string, deliver: CodeDelivery): Promise<void> {
    this.requirePolicy(password);
    let oldVk!: Vk;
    let newVk!: Vk;
    let recoveryCode!: string;
    let format: PwFormatRecord | null = null;
    await this.store.transact(async (cur, info) => {
      await this.noSync();
      if (!cur) throw new ServiceError("bad_state", "no vault");
      if (!hasDevice(cur.keyring)) throw new ServiceError("already_protected");
      oldVk = await unlockWithDevice(cur.keyring);
      const plain = await decryptVault(cur.envelope, oldVk);
      const r = await rekey(cur.keyring, oldVk, password, this.ctx);
      newVk = r.vk;
      recoveryCode = r.recoveryCode;
      format = formatRecord(r.keyring, password);
      const envelope = await encryptVault(
        plain,
        newVk,
        { vaultId: cur.envelope.vaultId, rev: cur.envelope.rev + 1 },
        this.rng,
      );
      return { envelope, keyring: await this.capped(r.keyring, info) };
    });
    await this.committed("password_enabled", newVk, { oldVk, code: recoveryCode, deliver, typed: true });
    await this.saveFormat(format);
  }

  /**
   * New key, same password, new recovery code (to `deliver.onCode`). For when the old key may have been exposed. With sync
   * on: sync_on (noSync; the sync rotation is §3.8, then SyncFlows.commitKeys).
   */
  async rotateKey(password: string, deliver: CodeDelivery): Promise<void> {
    let oldVk!: Vk;
    let newVk!: Vk;
    let recoveryCode!: string;
    let format: PwFormatRecord | null = null;
    await this.guarding("unlock_failed", () =>
      this.store.transact(async (cur, info) => {
        await this.noSync();
        if (!cur) throw new ServiceError("bad_state", "no vault");
        if (hasDevice(cur.keyring)) throw new ServiceError("not_protected");
        const opened = await this.unlockWith2(cur.keyring, password);
        oldVk = opened.vk;
        const plain = await decryptVault(cur.envelope, oldVk);
        // The same password, re-wrapped: the spelling that opened the keyring (the stored one), never a looser one typed
        // for it, which would otherwise become the password from now on.
        const r = await rekey(cur.keyring, oldVk, opened.password, this.ctx);
        newVk = r.vk;
        recoveryCode = r.recoveryCode;
        format = formatRecord(r.keyring, opened.password); // a new salt: the hint is written again for it
        return {
          envelope: await encryptVault(
            plain,
            newVk,
            { vaultId: cur.envelope.vaultId, rev: cur.envelope.rev + 1 },
            this.rng,
          ),
          keyring: await this.capped(r.keyring, info),
        };
      }),
    );
    await this.committed("key_rotated", newVk, { oldVk, code: recoveryCode, deliver, typed: true });
    rotatedHere.set(this, { vkId: newVk.id, at: this.now() });
    await this.saveFormat(format);
  }

  /**
   * After rekey (which adds the retired key and never drops one), at most KEYRING_PREVIOUS_MAX previous keys: capPrevious
   * keeps the last 64 in list order, so the key just retired always stays (GM2-15, P-8; F-11). Only when no key-change
   * cleanup is pending (§0.0i req. 10): the key it drops could still be the only one to some copy a cleanup has not
   * reached yet: the rotation is refused (cleanup_pending) and writes nothing; the next open or unlock finishes that
   * cleanup (the marker asks for it), and the rotation can then be made. Inside the transact (the lock). Reads nothing
   * unless the list is full.
   */
  private async capped(keyring: Keyring, info: TransactInfo): Promise<Keyring> {
    if (keyring.previous.length <= SYNC_CONSTANTS.KEYRING_PREVIOUS_MAX) return keyring;
    if (await info.cleanupPending()) throw new ServiceError("cleanup_pending");
    return capPrevious(keyring);
  }

  /** The vault key and the spelling of the password that opened it (openWithPassword); wrong_secret if neither did. */
  private async unlockWith2(keyring: Keyring, password: string): Promise<{ vk: Vk; password: string }> {
    try {
      return await openWithPassword(keyring, password);
    } catch (e) {
      if (e instanceof CryptoError && e.code === "unwrap_failed") throw new ServiceError("wrong_secret");
      throw e;
    }
  }

  /**
   * The key change is committed before this runs, so a failure here must not look like a failed operation: the caller
   * would lose the new recovery code. Whatever is left over is finished at the next unlock (housekeeping).
   */
  private async scrubQuietly(held: readonly Vk[], newVk: Vk): Promise<Keyring | null> {
    try {
      return await this.scrub(held, newVk);
    } catch (e) {
      this.diag("key change cleanup incomplete", e);
      return null;
    }
  }

  /** The cleanup after a key change; returns the keyring it ran under (the one just committed), or null. */
  private async scrub(held: readonly Vk[], newVk: Vk): Promise<Keyring | null> {
    const r = await this.store.load();
    if (r.status !== "ok") return null;
    // The transact above wrote the key-change marker before it committed; this clears it once everything is rewritten.
    const done = await this.finishKeyChanges(newVk, r.gen.keyring, held);
    if (!done.done) this.diag("key change cleanup incomplete");
    return r.gen.keyring;
  }

  /**
   * Everything after a key change has committed (GM2-1). The change is made, so from here on nothing reports a failure
   * (SYNC-DESIGN I2: a page that dies or a session that cannot be stored means "locked, enter the password"):
   *   1. a new recovery code goes to the page (CodeDelivery.onCode) before anything else is written;
   *   2. the security log's entry, right after it (A4R-2): seeing the code implies the entry, so a page closed while the
   *      cleanup runs cannot leave a new code, a rotation or a reset unrecorded. The log has its own key and lock, and
   *      never throws; the marker does not cover it, so it must not wait for the cleanup;
   *   3. the session under the key, unless the caller is already unlocked with it (`session: false`); a write that fails
   *      is logged, and after a rotation the old key is taken out of session storage (best effort);
   *   4. the cleanup, through the one entry point: the other slot, the keyring copy, the mirror and the snapshots move
   *      to the new keyring (GM2-3: also after a new password or recovery code of the same key, whose old wrap still
   *      opens the data there); a failure is logged and the marker finishes it at the next open or unlock.
   */
  private async committed(
    kind: SecurityKind | null,
    vk: Vk,
    o: {
      oldVk?: Vk;
      held?: readonly Vk[];
      code?: string;
      deliver?: CodeDelivery;
      session?: boolean;
      epoch?: number;
      /** confirmShares: the reminder of this very switch was set just before its commit, and stays. */
      keepRemind?: boolean;
      /**
       * A key event of this page's own, its secret just typed here (a new or changed master password, a reset, a new
       * recovery key, a rotation, shares confirmed; with sync on, the same changes made through the sync engine, which
       * hands it on: sync-flows.ts KeyCommit `typed`, from the engine's commitPublished, and the new recovery code before
       * a first upload): it opens the PIN record's "the PIN alone turns it back on" for a while (rotated.ts
       * rewrappedHere). Never a key adopted (in a background round, or with a secret typed for keys changed elsewhere),
       * a join or a restore (review r2, PINR-09 and PINR-R2-03).
       */
      typed?: true;
    } = {},
  ): Promise<void> {
    if (o.code !== undefined && o.deliver) {
      try {
        o.deliver.onCode(o.code);
      } catch (e) {
        this.diag("onCode failed", e);
      }
    }
    if (kind) await this.record(kind);
    // a new recovery code by any way: a reminder to check shares of the one before is moot (confirmShares sets its own)
    if (kind && RECOVERY_CHANGES.includes(kind) && !o.keepRemind) await this.security?.remind?.(null);
    const held = o.held ?? [o.oldVk ?? vk];
    // A hard lock for the gate's arming (QUICK-UNLOCK §5.5): every key event that is recorded (a new password, a reset, a
    // new recovery code, a rotation, an adoption, a join), and any change of the vault key. Only a rewrite that records
    // nothing and keeps the key (the keyring's times floored before a first upload) leaves it. The next master password
    // arms it again; sk_pin itself moves to a new key with the cleanup (pin-store.ts).
    if (kind !== null || held.some((k) => k.id !== vk.id)) await this.endQuickQuietly();
    if (o.session !== false) {
      try {
        await this.startSession(vk, o.epoch);
      } catch (e) {
        this.diag("session not stored after a key change", e);
        if (held.some((k) => k.id !== vk.id)) await this.session.clear().catch(() => undefined);
      }
    }
    const keyring = await this.scrubQuietly(held, vk);
    // the PIN's record (OWNER-DECISIONS/20): any re-wrap or new key pauses it, its wrap set aside (no old key material on
    // disk; a record still of these keys is left as it is) until the next master password makes it again; and after this
    // page's own key event, its secret just typed (`typed`), for a while the PIN alone turns it back on here (rotated.ts,
    // pin-restart-admin.ts), as one touch does for Touch ID after a key change
    if (keyring && this.pins)
      await setAsideRestart(this.pins, keyring).catch((e: unknown) => this.diag("PIN record not paused", e));
    if (o.typed && keyring) rewrappedHere.set(this, { vkId: keyring.vkId, wraps: wrapsTag(keyring), at: this.now() });
  }

  /**
   * Change the password; the old one must be given. Only the password wrap changes, the data is untouched. The cleanup
   * after it takes the old wrap out of the other slot, the keyring copy and the mirror (GM2-3, P-5). With sync on:
   * sync_on (noSync; §3.6).
   */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    this.requirePolicy(newPassword);
    let vk!: Vk;
    let format: PwFormatRecord | null = null;
    await this.guarding("unlock_failed", () =>
      this.store.transact(async (cur) => {
        await this.noSync();
        if (!cur) throw new ServiceError("bad_state", "no vault");
        if (hasDevice(cur.keyring)) throw new ServiceError("not_protected");
        vk = (await this.unlockWith2(cur.keyring, oldPassword)).vk;
        const keyring = await changePasswordWrap(cur.keyring, vk, newPassword, this.ctx); // the new one exactly as given
        format = formatRecord(keyring, newPassword);
        return { envelope: cur.envelope, keyring };
      }),
    );
    await this.committed("password_changed", vk, { typed: true });
    await this.saveFormat(format);
  }

  /**
   * Forgot the password, step one (GM2-13; the pattern of prepareKeys): the recovery code opens the vault key, and a new
   * password and a new recovery code are wrapped around it in memory. Nothing of the vault is written. The page (the
   * settings tab, src/options/Reset.tsx; never the popup, which closes when the user goes to save the code: A4R-1) shows
   * `recoveryCode` and asks the user to confirm it is saved; only then commitReset writes it. A page closed before that
   * has changed nothing: the old recovery code still opens the vault, and the one shown opens nothing. The key
   * derivations run here, outside the vault lock.
   * A wrong code is recorded (recovery_failed) and refused (wrong_secret); one that is not even well-formed is a typo,
   * not a guess, and is not recorded. The new password is held to the policy first, before any guess is counted. A code
   * that is accepted is recorded at once (recovery_used, as at the lock screen, A3-9): otherwise whoever holds it could
   * learn it is valid here, go Back, and leave no entry. With sync on: sync_on, before the code is checked (noSync).
   */
  async prepareReset(code: string, newPassword: string): Promise<PreparedReset> {
    this.requirePolicy(newPassword);
    await this.noSync(); // before the code is checked or recorded
    const r = await this.store.load();
    if (r.status !== "ok") throw new ServiceError("bad_state", r.status);
    let vk: Vk;
    try {
      vk = await unlockWithRecoveryCode(r.gen.keyring, code);
    } catch (e) {
      if (e instanceof CryptoError && e.code === "unwrap_failed") {
        await this.record("recovery_failed");
        throw new ServiceError("wrong_secret");
      }
      throw e;
    }
    await this.record("recovery_used"); // accepted: before the new keys are made
    const { keyring, recoveryCode } = await setRecovery(
      await setPassword(r.gen.keyring, vk, newPassword, this.ctx),
      vk,
      this.ctx,
    );
    const handle: PreparedReset = Object.freeze({ recoveryCode });
    preparedResets.set(handle, {
      base: canonicalJson(r.gen.keyring),
      keyring,
      vk,
      format: formatRecord(keyring, newPassword),
    });
    return handle;
  }

  /**
   * Step two: write the reset prepareReset made, once the user has confirmed the new code is saved. Unlocked with the new
   * password afterwards (a session that cannot be stored means unlocking with it: the page then says so). Refused with
   * bad_state, writing nothing, if the vault's keys changed since step one (a reset, a new code or a rotation in another
   * page: the code on screen will never work, start again), or if the handle was already used. A write that landed
   * although it reported a failure is recognised by a retry with the same handle and counts as done, as makeVault does.
   * The handle is spent once the change has committed. There is no one-call reset (A4R-5): every reset shows its code
   * before it is written, in the settings tab (popup: the button opens it). Sync turned on since step one: sync_on.
   */
  async commitReset(prepared: PreparedReset): Promise<void> {
    const p = preparedResets.get(prepared);
    if (!p) throw new ServiceError("bad_state", "reset already used");
    const mine = canonicalJson(p.keyring);
    try {
      await this.store.transact(async (cur) => {
        if (!cur) throw new ServiceError("bad_state", "no vault");
        const now = canonicalJson(cur.keyring);
        if (now === mine) throw LANDED; // this very reset, written by an attempt that reported an error
        await this.noSync();
        if (now !== p.base) throw new ServiceError("bad_state", "keys changed meanwhile");
        return { envelope: cur.envelope, keyring: p.keyring };
      });
    } catch (e) {
      if (e !== LANDED) throw e;
    }
    preparedResets.delete(prepared);
    await this.committed("password_reset", p.vk, { typed: true });
    await this.saveFormat(p.format);
  }

  /**
   * Issue a fresh recovery code (the old one stops working; the new one goes to `deliver.onCode`). Needs an unlocked vault
   * AND the master password (H3, C6-1): a recovery code resets the master password, so making one is as strong as knowing
   * it, and someone at an unlocked browser without it must not get one. The password is checked first, as verifyPassword
   * does (outside the vault lock; a wrong one is refused with wrong_secret and recorded as unlock_failed; "" is a typo and
   * not recorded). A Phase 0 device-key vault has no master password (not_protected): anyone at it can open the vault
   * anyway, so there `password` is ignored, as in clearSecurityLog and the export. With sync on: sync_on, before the
   * password is checked (noSync; §3.7).
   */
  async newRecoveryCode(password: string, deliver: CodeDelivery): Promise<void> {
    await this.noSync(); // before the password is checked or recorded
    try {
      await this.verifyPassword(password);
    } catch (e) {
      if (!(e instanceof ServiceError && e.code === "not_protected")) throw e;
    }
    let recoveryCode!: string;
    let vk!: Vk;
    await this.store.transact(async (cur) => {
      await this.noSync();
      if (!cur) throw new ServiceError("bad_state", "no vault");
      vk = await this.requireVk(cur.keyring);
      const r = await setRecovery(cur.keyring, vk, this.ctx);
      recoveryCode = r.recoveryCode;
      return { envelope: cur.envelope, keyring: r.keyring };
    });
    // Already unlocked with this key: no session to write.
    await this.committed("recovery_code_new", vk, { code: recoveryCode, deliver, session: false, typed: true });
  }

  // ---- recovery code shares (docs/design/notes/SHAMIR-NOTES.md) --------------------------------------------------

  /**
   * Make a share set (ADVANCED-RECOVERY-AND-TIERS §3.1, §3.7), in memory; nothing of the vault is written.
   *   - `{password}`, "replace" (the recommended way): a new recovery code, shown only as shares. As newRecoveryCode, it
   *     needs an unlocked vault AND the master password (a recovery code resets the master password); with sync on it is
   *     refused (sync_on, before the password is checked: the new wrap would have to go through the server, §3.7). The
   *     password's answers are verifyPassword's (a wrong one refused with wrong_secret and recorded as unlock_failed;
   *     "" is a typo). The new keyring is made here and kept in this module; confirmShares commits it.
   *   - `{recoveryCode}`, "split": the shares are of the current code, which must open the vault now (a stale or wrong
   *     code would give shares that open nothing). Needs an unlocked vault; a wrong code is refused (wrong_secret) and
   *     recorded as recovery_failed, as everywhere a recovery code is typed; a malformed one is a typo (recovery_*),
   *     not recorded. Allowed with sync on: it writes nothing.
   * A vault without a recovery wrap (a Phase 0 device-key vault) has nothing to share: not_protected. The code is taken
   * by recoveryKeyFrom, the one way to it. The random members to type back are drawn here (`test`), uniformly. The secret
   * itself is zeroed once the shares are made.
   */
  async prepareShares(
    from: { password: string } | { recoveryCode: string },
    setup: ShareSetup,
  ): Promise<PreparedShares> {
    const { threshold, count } = setup;
    if (
      !Number.isInteger(threshold) ||
      !Number.isInteger(count) ||
      threshold < 2 ||
      threshold > count ||
      count > MAX_SHARES
    )
      throw new RangeError("a share set is 2 <= threshold <= count <= 16");
    const { code, keyring, next } = await this.recoveryKeyFrom(from);
    const replace = next !== null;
    const secret = await parseRecoveryCode(code);
    let set;
    try {
      set = await makeShareSet(secret, threshold, count, this.rng);
    } finally {
      secret.fill(0);
    }
    const handle: PreparedShares = Object.freeze({
      mode: replace ? "replace" : "split",
      setId: setIdText(set.setId),
      threshold,
      count,
      shares: Object.freeze(set.shares),
      test: Object.freeze(pickMembers(threshold, count, this.rng)),
    });
    preparedShares.set(handle, { base: canonicalJson(keyring), next });
    // shares of the current code are on screen now, and it is not otherwise recorded (as an export is: §3, H6)
    if (!replace) await this.record("shares_made");
    return handle;
  }

  /**
   * The recovery code in hand (ADVANCED-RECOVERY-AND-TIERS §0.3, §5.1: "enter your recovery key, two shares, or make a new
   * one", built once; docs/design/notes/SHAMIR-NOTES.md §3). The shares take it through here, and so are protected
   * accounts and the inheritance kit to, never a second way:
   *   - `{recoveryCode}`: the current code, typed or rebuilt from shares, which must open the current recovery wrap (a
   *     wrong one is refused with wrong_secret and recorded as recovery_failed; a malformed one is a typo, not recorded);
   *   - `{password}`: a new recovery code, made in memory (sync_on first, before the password is checked; then the master
   *     password, verifyPassword's answers and records); the keyring with its wrap is returned, nothing is written.
   * Needs an unlocked vault (locked) with a recovery wrap (not_protected for a Phase 0 device-key vault). Returns the
   * code's text, the keyring it was taken against, and for a new code the new keyring and its vault key.
   */
  private async recoveryKeyFrom(
    from: { password: string } | { recoveryCode: string },
  ): Promise<{ code: string; keyring: Keyring; next: { keyring: Keyring; vk: Vk } | null }> {
    const fresh = "password" in from;
    if (fresh) {
      await this.noSync(); // before the password is checked or recorded
      await this.verifyPassword(from.password);
    }
    const r = await this.store.load();
    if (r.status !== "ok") throw new ServiceError("bad_state", r.status);
    const keyring = r.gen.keyring;
    const vk = await this.requireVk(keyring);
    if (hasDevice(keyring) || !keyring.wraps.some((w) => w.method === "recovery"))
      throw new ServiceError("not_protected");
    if (fresh) {
      const made = await setRecovery(keyring, vk, this.ctx);
      validateKeyring(made.keyring);
      return { code: made.recoveryCode, keyring, next: { keyring: made.keyring, vk } };
    }
    try {
      await unlockWithRecoveryCode(keyring, from.recoveryCode);
    } catch (e) {
      if (e instanceof CryptoError && e.code === "unwrap_failed") {
        await this.record("recovery_failed");
        throw new ServiceError("wrong_secret");
      }
      throw e;
    }
    return { code: from.recoveryCode, keyring, next: null };
  }

  /**
   * The test restore (§3.6): `typed` are the shares the person typed back, exactly the members `prepared.test` asks for,
   * of this set (else shares_mixed, or bad_state for the wrong members); they must rebuild the set's recovery code.
   *   - "replace": that code must open the NEW keyring's recovery wrap (so what is committed is what the shares rebuild),
   *     and only then is the keyring written, in one locked save, the same as newRecoveryCode's: the old recovery code
   *     works until that save commits (an interrupted one is rolled back at the next start, Interrupted key changes), and
   *     every share of it stops working with it. Refused, writing nothing, with bad_state if the keys changed since the
   *     set was made (a new code, a reset or a rotation in another page: these shares would never work), with sync_on if
   *     sync was turned on meanwhile, and with locked if Sixkey locked. A save that landed although it reported an error
   *     counts as done when tried again with the same handle. After it: recorded as recovery_code_new, the PIN's
   *     session ended, the cleanup (`committed`), as for a new recovery code. The shares reminder is set just before the
   *     save (SHAMIR-NOTES.md §4), so no lost write can keep the commit and lose it; a refused save puts it back as it was
   *     while it is still this switch's own (`unremind`; unless the save landed after all, or that cannot be told: then
   *     it stays, and the page has said the switch failed; a check of these shares after the restart says the switch
   *     did not complete).
   *   - "split": nothing is written; the code must open the vault now (wrong_secret: it changed meanwhile).
   * The handle is spent once confirmed.
   */
  async confirmShares(prepared: PreparedShares, typed: readonly string[]): Promise<void> {
    const p = preparedShares.get(prepared);
    if (!p) throw new ServiceError("bad_state", "share set already used");
    const parsed: Share[] = [];
    try {
      for (const t of typed) parsed.push(await parseShare(t));
      if (parsed.some((s) => setIdText(s.setId) !== prepared.setId || s.threshold !== prepared.threshold))
        throw new CryptoError("shares_mixed");
      const members = parsed.map((s) => s.index).sort((a, b) => a - b);
      if (members.join() !== prepared.test.join()) throw new ServiceError("bad_state", "not the shares asked for");
    } finally {
      for (const s of parsed) s.value.fill(0);
    }
    const code = await recoveryCodeFromShares(typed, formatRecoveryCode);
    if (!p.next) {
      const r = await this.store.load();
      if (r.status !== "ok") throw new ServiceError("bad_state", r.status);
      await this.requireVk(r.gen.keyring);
      try {
        await unlockWithRecoveryCode(r.gen.keyring, code);
      } catch (e) {
        if (e instanceof CryptoError && e.code === "unwrap_failed") throw new ServiceError("wrong_secret");
        throw e;
      }
      preparedShares.delete(prepared);
      return;
    }
    const next = p.next;
    if ((await unlockWithRecoveryCode(next.keyring, code).catch(() => null))?.id !== next.vk.id)
      throw new ServiceError("bad_state", "the shares do not rebuild the new code");
    const mine = canonicalJson(next.keyring);
    /** The save's conditions, on the keyring there: true when it is this very set's (an attempt that reported an error). */
    const landed = async (k: Keyring | undefined): Promise<boolean> => {
      if (!k) throw new ServiceError("bad_state", "no vault");
      const now = canonicalJson(k);
      if (now === mine) return true;
      await this.noSync();
      if (now !== p.base) throw new ServiceError("bad_state", "keys changed meanwhile");
      await this.requireVk(k);
      return false;
    };
    const r = await this.store.load();
    await landed(r.status === "ok" ? r.gen.keyring : undefined); // refused here, nothing is written
    // From the next browser start on: check the shares before destroying the old code. The commit can still be rolled
    // back by a power loss (Interrupted key changes); a check after a restart shows it was not (SHAMIR-NOTES.md §4). Set
    // before the save: writes are lost newest first, so a loss can drop the commit and keep the reminder, never the reverse.
    const id = Array.from(this.rng(8), (b) => b.toString(16).padStart(2, "0")).join(""); // this switch's own
    const before = await this.security?.remind?.({ id, set: prepared.setId });
    try {
      await this.store.transact(async (cur) => {
        if (await landed(cur?.keyring)) throw LANDED; // again under the store's lock: another page may have been first
        return { envelope: cur!.envelope, keyring: next.keyring };
      });
    } catch (e) {
      if (e !== LANDED) {
        await this.unremind(id, before, mine);
        throw e;
      }
    }
    preparedShares.delete(prepared);
    // Already unlocked with this key: no session to write. No code to deliver: the shares were shown before the commit.
    await this.committed("recovery_code_new", next.vk, { session: false, keepRemind: true, typed: true });
  }

  /**
   * A switch to shares was refused (review FU-1): its reminder, set before the save (`id`), is taken back to `before`.
   *   1. `before` undefined: the reminder was not written, or not known to be: nothing is taken back;
   *   2. the keys cannot be read: it stays;
   *   3. the keys are this switch's (the save landed after all): it stays;
   *   4. else `before` replaces it, under the security record's own lock, only while the reminder there is still this
   *      switch's: one written since (another page's switch, at the same time) or a drop (a recovery code change since)
   *      is left alone.
   * A reminder for a switch that did not land is the safe side: the page said the switch failed, and a check of its
   * shares after the restart says so (checkRecoveryCode).
   */
  private async unremind(id: string, before: SharesReminder | null | undefined, mine: string): Promise<void> {
    if (before === undefined) return;
    const r = await this.store.load().catch(() => null);
    if (r?.status !== "ok") return;
    if (canonicalJson(r.gen.keyring) === mine) return;
    await this.security?.putBack?.(id, before);
  }

  /**
   * The browser or the extension has started (the service worker's onStartup and onInstalled): a shares reminder set by a
   * switch before it becomes due, for the popup to show after every unlock until a check passes (security-log.ts
   * `remind`). Never rejects.
   */
  async browserStarted(): Promise<void> {
    await this.security?.started?.();
  }

  /**
   * "Check my shares" (§3.6), and anywhere a recovery code is to be checked without using it: does `code` open the vault
   * now ("current"), or not ("stale": shares that rebuild a valid code which does not open this vault belong to an older
   * recovery code, or to another vault)? Writes nothing of the vault and records nothing: it needs an unlocked vault
   * (locked), so it is no oracle for someone at a locked page, where every recovery code typed is recorded. With a
   * switch to shares not yet checked after a browser restart (the security record's `remind`, SHAMIR-NOTES.md §4):
   *   - "current_before_restart": the code opens the vault, but the browser has not restarted since the switch, which a
   *     power loss could still roll back: the reminder stays; check again after a restart;
   *   - "current", the reminder due: the switch survived a restart; the reminder goes (the one thing this writes);
   *   - "stale_after_switch", the reminder due and `set` (the id of the set the shares are of) the switched set's: the
   *     switch did not complete (or was rolled back): the old code is still in force. The reminder stays.
   * A malformed code: recovery_*.
   */
  async checkRecoveryCode(
    code: string,
    set?: string,
  ): Promise<"current" | "current_before_restart" | "stale" | "stale_after_switch"> {
    const r = await this.store.load();
    if (r.status !== "ok") throw new ServiceError("bad_state", r.status);
    await this.requireVk(r.gen.keyring);
    try {
      await unlockWithRecoveryCode(r.gen.keyring, code);
    } catch (e) {
      if (e instanceof CryptoError && e.code === "unwrap_failed") {
        const c = await this.security?.checked?.(false);
        return c?.state === "due" && set !== undefined && c.set === set ? "stale_after_switch" : "stale";
      }
      throw e;
    }
    return (await this.security?.checked?.(true))?.state === "set" ? "current_before_restart" : "current";
  }

  // ---- restoring and importing ---------------------------------------------------------------

  /**
   * Adopt a backup as this install's vault. Only for a fresh install or when stored data is unreadable. It keeps the
   * backup's vault id (identity matters once sync exists), so the keys must have been prepared with that id. The
   * accounts are written under the master password from the start: never under a device key, whose old copies the
   * browser's database could keep on disk next to the real secrets (SYNC-DESIGN H1, review H-a).
   * Never replaces a readable vault: use importBackup for that. `after`: called with the generation written, inside the
   * store's lock (the transact's afterCommit; not when an earlier attempt with these keys had written it already).
   */
  async restoreBackup(
    backup: Vault,
    keys: PreparedKeys,
    choice: FirstRunChoice = {},
    after?: (gen: Generation) => void,
  ): Promise<void> {
    if (this.keysOf(keys).keyring.vaultId !== backup.vaultId)
      throw new ServiceError("bad_state", "keys were prepared for another vault id");
    const clamped = clampVault(backup, this.now());
    await this.makeVault(
      keys,
      choice,
      ["empty", "lost"],
      (keyring, vk) => encryptVault(serializeVault(clamped), vk, { vaultId: keyring.vaultId, rev: 0 }, this.rng),
      after,
    );
  }

  /**
   * Bring a backup into an existing vault. The same vault (an older copy of it): merged, so edits and deletions on both
   * sides are kept. A different vault: its accounts are added as new entries, skipping ones already present. `after`:
   * called with the generation committed, inside the store's lock (ServiceCore.mutate).
   */
  async importBackup(
    backup: Vault,
    after?: (gen: Generation) => void,
  ): Promise<{ mode: "merged" | "added"; added: number }> {
    let result = { mode: "merged" as "merged" | "added", added: 0 };
    await this.mutate((vault, clock, now) => {
      if (backup.vaultId === vault.vaultId) {
        const merged = mergeVaults(vault, clampVault(backup, now));
        observeVault(clock, merged);
        result = { mode: "merged", added: merged.entries.length - vault.entries.length };
        return merged;
      }
      // Purged or trashed entries are not imported; one already here (by identity, issuer and label, in the trash too) is skipped.
      const a = addAccountsFrom(vault, backup, clock, "all");
      result = { mode: "added", added: a.added };
      return a.vault;
    }, after);
    return result;
  }

  /**
   * Erase accounts for good: the secret is removed from the vault and from every copy Sixkey itself keeps (the previous
   * slot, rolling and daily snapshots, the mirror, the vaults kept from before a join that a held key opens). Copies in
   * files the user exported are not touched, nor a kept vault under a key this profile no longer holds (`keptUnchecked`
   * says how many there are, for the page to say so), and the browser's database may keep old bytes on disk until it
   * compacts (see docs/security/local-vault.md). The master password first (requireMasterPassword): a wrong one is
   * refused (wrong_secret, recorded) and nothing is erased.
   */
  async purgeForever(ids: string[], password: string): Promise<{ keptUnchecked: number }> {
    await this.requireMasterPassword(password); // irreversible: never on the strength of a PIN or an open page alone
    let keptUnchecked = 0;
    if (ids.length === 0) return { keptUnchecked };
    const device = await this.settings.deviceId();
    const purgeIn = (vault: Vault, clock: Clock): Vault =>
      ids.reduce((v, id) => (v.entries.some((e) => e.id === id && !isPurged(e)) ? purgeEntry(v, id, clock) : v), vault);
    // The accounts erased, by identity: another vault's copies (kept re-encrypted for "find accounts" after a join, §3.5
    // D9) gave them other ids in added mode, so there they are found by identity (§0.0i req. 13, A4R-12; R3).
    const gone = new Set<string>();
    await this.mutate((vault, clock) => {
      for (const e of vault.entries) {
        const k = ids.includes(e.id) ? entryIdentity(e) : null;
        if (k !== null) gone.add(k);
      }
      return purgeIn(vault, clock);
    });
    const purgeOther = (vault: Vault, clock: Clock): Vault =>
      vault.entries.reduce((v, e) => {
        const k = entryIdentity(e);
        return k !== null && gone.has(k) ? purgeEntry(v, e.id, clock) : v;
      }, vault);
    const r = await this.store.load();
    if (r.status !== "ok") return { keptUnchecked };
    const vk = await this.requireVk(r.gen.keyring);
    const olds = await unwrapPreviousVks(r.gen.keyring, vk);
    const vaultId = r.gen.keyring.vaultId;
    await this.store.rewriteForKeyChange(
      async (env: EncryptedVault) => {
        const key = [vk, ...olds].find((k) => k.id === env.vkId);
        if (!key) return null;
        const vault = deserializeVault(await decryptVault(env, key));
        const clock = createClock(device, { now: this.now });
        observeVault(clock, vault);
        // Under the current key (P-7): an old-key copy waiting for a key-change cleanup is moved on, not dropped. Not the
        // whole other-vault copy: the rest of its deleted accounts may still be wanted back.
        const next = env.vaultId === vaultId ? purgeIn(vault, clock) : purgeOther(vault, clock);
        return encryptVault(serializeVault(next), vk, { vaultId: env.vaultId, rev: env.rev }, this.rng);
      },
      { all: true },
    );
    // the vaults kept from before a join (sk_prejoin, §3.5 ④): copies Sixkey keeps too
    for (const rec of this.vkRecords) {
      keptUnchecked +=
        (await rec.purge?.(vk, olds, async (plain, id) => {
          const vault = deserializeVault(plain);
          const clock = createClock(device, { now: this.now });
          observeVault(clock, vault);
          return serializeVault(id === vaultId ? purgeIn(vault, clock) : purgeOther(vault, clock));
        })) ?? 0;
    }
    return { keptUnchecked };
  }

  async lastBackupAt(): Promise<number | null> {
    return this.settings.getLastBackup();
  }

  async markBackedUp(): Promise<void> {
    await this.settings.setLastBackup(this.now());
  }

  /**
   * Begin again with an empty vault when stored data is unreadable and no backup exists, under keys from prepareKeys.
   * This overwrites whatever unreadable remains are left, so the UI must put it behind an explicit confirmation.
   */
  async startOver(keys: PreparedKeys, choice: FirstRunChoice = {}): Promise<void> {
    // makeVault checks again inside the lock: a backup restored from another page meanwhile must not be erased.
    await this.makeVault(keys, choice, ["lost"], (keyring, vk) =>
      encryptVault(serializeVault(emptyVault(keyring.vaultId)), vk, { vaultId: keyring.vaultId, rev: 0 }, this.rng),
    );
  }

  async methods(): Promise<string[]> {
    const r = await this.store.load();
    return r.status === "ok" ? listMethods(r.gen.keyring) : [];
  }

  // exposed for tests and diagnostics
  async currentGeneration(): Promise<Generation | null> {
    const r = await this.store.load();
    return r.status === "ok" ? r.gen : null;
  }
}

export { StorageError };

/**
 * `t` of the members 0 .. n - 1, uniformly at random (a partial Fisher-Yates shuffle, each draw by rejection sampling
 * from one random byte), in order: the shares the test restore asks for (§3.6).
 */
function pickMembers(t: number, n: number, rng: (k: number) => Uint8Array): number[] {
  const all = [...Array(n).keys()];
  for (let i = n - 1; i >= n - t; i--) {
    const bound = 256 - (256 % (i + 1)); // bytes at or above it would favour the low values
    let b: number;
    do b = rng(1)[0]!;
    while (b >= bound);
    const j = b % (i + 1);
    [all[i], all[j]] = [all[j]!, all[i]!];
  }
  return all.slice(n - t).sort((a, b) => a - b);
}
