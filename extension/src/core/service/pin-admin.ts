// Setting, changing and removing the PIN, and ending quick unlock (QUICK-UNLOCK §5.3, §5.4, §6.3; OWNER-DECISIONS/20 and
// its 2026-10-30 notes): what Settings › Security's PIN box does. Only the settings page builds it
// (src/options/PinBox.tsx), so none of it, nor the PIN policy, is in the popup's bundle. The unlock side (the lock
// screens, the PIN's record) is pin-restart-count.ts's and pin-restart-steps.ts's.
//
// It reuses the service's own steps, taken from the service itself by element access (as device-unlock.ts does; TypeScript
// allows it for exactly this): the session, the PIN store, the security record, requireVk, the hard lock. So there is one
// copy of each rule, and test/unit/m2-source-rules.test.ts allows this access in these two files only.
import { CryptoError } from "../crypto/bytes";
import { openWithPassword, type Keyring } from "../crypto/keyring";
import { derivePinKek, newPinKdf, QUICK_TRIES, quickLive, sealPinRecord, wrapsTag } from "../crypto/pin";
import { restartState, type RestartState } from "../crypto/pin-restart";
import { hasGate } from "../crypto/prf-record";
import { checkPinPolicy } from "../crypto/pin-policy";
import type { Vk } from "../crypto/vk";
import {
  genuineRestart,
  readRestart,
  removeRestart,
  sealNewRestart,
  setAsideRestart,
  writeRestart,
} from "./pin-restart-admin";
import type { Secret, VaultService } from "./service";
import { ServiceError } from "./service-error";
import { profileOf } from "./types";

/**
 * What the PIN box shows. `available`: "ok", or why the PIN is not offered here: no readable vault, a Phase 0 vault
 * without a master password, a profile declared shared, a runtime without a PIN store. `pin`: set up for this vault and
 * key. `restart`: what it offers (pin-restart.ts restartState: "pin", it opens Sixkey now, with `triesLeft`; "wait", the
 * master password once; "paused", after a key change), present while a PIN is set up here.
 */
export type QuickState = {
  available: "ok" | "no_vault" | "no_password" | "shared" | "off";
  pin: { digits: number } | null;
  /**
   * Present when a Touch ID / Windows Hello gate credential is enrolled (QUICK-UNLOCK Stage 2): the master password arms
   * it (OWNER-DECISIONS/17 Q1: beside the PIN). `armed`: the gate opens Sixkey now.
   */
  gate?: { armed: boolean };
  restart?: { state: RestartState; triesLeft: number };
};

const hasDevice = (k: Keyring) => k.wraps.some((w) => w.method === "device") && k.deviceKey !== undefined;
const protectedBy = (k: Keyring) => !hasDevice(k) && k.wraps.some((w) => w.method === "password");

export class PinAdmin {
  constructor(private readonly s: VaultService) {}

  private get pins() {
    return this.s["pins"];
  }
  /** A gate credential of this vault and key is enrolled (sk_prf). One read of sk_prf. */
  private async gateFirst(keyring: Keyring): Promise<boolean> {
    const r = await this.s["prfs"]?.read();
    return !!r && r !== "damaged" && r.vaultId === keyring.vaultId && hasGate(r, keyring.vkId);
  }
  private record(kind: "pin_set" | "pin_removed" | "quick_ended" | "unlock_failed"): Promise<void> {
    return this.s["record"](kind);
  }

  /**
   * The master password typed again (H3), checked as verifyPassword checks it (a generated one typed loosely too,
   * openWithPassword), returning the vault key it opens. A wrong one is recorded once (unlock_failed) and refused
   * (wrong_secret); "" is a typo, as at the lock screen (empty_password). The PIN's tries are not touched.
   */
  private async passwordVk(keyring: Keyring, password: Secret): Promise<Vk> {
    // the current PIN typed again (OWNER-DECISIONS/26): checked by confirmSecret (its tries the lock screens'), and the
    // key is the session's, as this page is unlocked
    if (typeof password !== "string") {
      await this.s.confirmSecret(password);
      return this.s["requireVk"](keyring);
    }
    let vk: Vk | null = null;
    try {
      vk = (await openWithPassword(keyring, password)).vk;
    } catch (e) {
      if (!(e instanceof CryptoError && e.code === "unwrap_failed")) throw e;
    }
    if (!vk || vk.id !== keyring.vkId) {
      await this.record("unlock_failed");
      throw new ServiceError("wrong_secret");
    }
    return vk;
  }

  /** The vault, unlocked here, with a master password. For setPin and removePin. */
  private async target(): Promise<Keyring> {
    if (!this.pins) throw new ServiceError("quick_off");
    const r = await this.s["store"].load();
    if (r.status !== "ok") throw new ServiceError("bad_state", r.status);
    const keyring = r.gen.keyring;
    if (!protectedBy(keyring)) throw new ServiceError("not_protected");
    await this.s["requireVk"](keyring); // unlocked (QUICK-UNLOCK §5.3: requirements)
    return keyring;
  }

  /**
   * Set the PIN, or change it. Needs Sixkey unlocked here, a master password (not a Phase 0 device-key vault:
   * not_protected), a solo profile (quick_off), a PIN of 4 to 8 digits (bad_pin: checked first, before the password is;
   * one that is too easy to guess is taken, the box says so: OWNER-DECISIONS/20, 2026-10-30), and the master password
   * typed again (wrong_secret, recorded). The new record's derivation (sealNewRestart: PBKDF2 at the master password's
   * count, the slow part) comes first, before any write, so a page closed during it leaves the old PIN as it was. Then
   * the writes, in this order, so that a page closed between any two of them never leaves an old PIN working:
   *   1. the PIN's record, when there is one (sk_pin_restart, made from the old PIN), deleted: closed here, the change has
   *      visibly not happened (the old set-up is still there; its PIN waits for the master password);
   *   2. the new set-up written (sk_pin), in the vault lock, only while the vault key is still the one just checked;
   *   3. the new record written (writeRestart: no try counted), in the vault lock, only while the keys and
   *      the set-up are still these: it opens Sixkey from now on, also after a restart. Closed before it, or the keys
   *      changed meanwhile: the new PIN waits for the next master password, which makes it (pin-restart-steps.ts
   *      notePassword); a record of the old set-up that another page wrote meanwhile names the old salt and is never
   *      offered (pin-restart.ts: "paused");
   *   4. pin_set recorded.
   */
  async setPin(password: Secret, input: string): Promise<void> {
    const check = checkPinPolicy(input);
    if (!check.ok) throw new ServiceError("bad_pin");
    if (profileOf(await this.s["settings"].get()) === "shared") throw new ServiceError("quick_off");
    const keyring = await this.target();
    const vk = await this.passwordVk(keyring, password);
    const kdf = newPinKdf(this.s["rng"], this.s["iterations"]);
    const pinKek = await derivePinKek(check.pin, kdf);
    try {
      const rec = await sealPinRecord(vk, keyring.vaultId, pinKek, { digits: check.pin.length, kdf }, this.s["rng"]);
      // the record's derivation first, before anything is written (a page closed while it runs leaves the old PIN)
      const made = await sealNewRestart(this.s, vk, keyring, rec, pinKek, this.s["now"]());
      await removeRestart(this.pins!);
      if (!(await this.pins!.write(rec))) throw new ServiceError("bad_state", "keys changed meanwhile");
      // false: the keys changed meanwhile, and the new PIN waits for the next master password, which makes its record
      await writeRestart(this.s, made);
    } finally {
      pinKek.fill(0);
    }
    await this.record("pin_set");
  }

  /**
   * Remove the PIN, with the master password typed again (wrong_secret, recorded). Its record goes first
   * (sk_pin_restart), then the set-up: a page closed in between leaves the set-up (shown as still there, to be removed
   * again; its PIN waits for the master password), never a removed PIN that works. pin_removed is recorded when there was
   * one.
   */
  async removePin(password: Secret): Promise<void> {
    const keyring = await this.target();
    await this.passwordVk(keyring, password);
    const had = (await this.pins!.read()) !== null;
    await removeRestart(this.pins!);
    await this.pins!.remove();
    if (had) await this.record("pin_removed");
  }

  /**
   * "End quick unlock now": the hard lock, recorded (quick_ended) when there was a quick unlock to end. The PIN's record
   * has its wrap set aside first (no key material left on disk; the next master password on a lock screen makes a new
   * one: OWNER-DECISIONS/20), so a page closed half-way never leaves it working; the hard lock ends the gate's arming.
   */
  async endQuickUnlock(): Promise<void> {
    const rec = this.pins && (await readRestart(this.pins));
    const had = (await this.s["session"].getQuick()) !== null || (!!rec && rec !== "damaged" && rec.wrap !== null);
    if (this.pins) await setAsideRestart(this.pins);
    await this.s["hardLock"]();
    if (had) await this.record("quick_ended");
  }

  /** What the box shows: one load, one read of sk_pin, sk_prf, sk_pin_restart and the settings, and one of sk_quick. */
  async state(): Promise<QuickState> {
    const r = await this.s["store"].load();
    if (r.status !== "ok") return { available: "no_vault", pin: null };
    const keyring = r.gen.keyring;
    if (!protectedBy(keyring)) return { available: "no_password", pin: null };
    if (!this.pins) return { available: "off", pin: null };
    const shared = profileOf(await this.s["settings"].get()) === "shared";
    const raw = await this.pins.read();
    const pin = raw && raw !== "damaged" && raw.vaultId === keyring.vaultId && raw.vkId === keyring.vkId ? raw : null;
    const gate = !shared && (await this.gateFirst(keyring));
    const q = gate ? await this.s["session"].getQuick() : null;
    const live =
      q !== null &&
      quickLive(q, this.s["now"]()) &&
      q.vaultId === keyring.vaultId &&
      q.vkId === keyring.vkId &&
      q.wraps === wrapsTag(keyring);
    // the PIN's record: with the vault open here, only one Sixkey made (genuineRestart, PINR-01)
    const here = pin && !shared ? await this.s["currentVk"](keyring) : null;
    const rec =
      pin && !shared ? (here ? await genuineRestart(this.pins, keyring, here) : await readRestart(this.pins)) : null;
    const restart = pin ? restartState(rec, keyring, pin, shared) : null;
    const fails = rec && rec !== "damaged" ? rec.fails : 0;
    return {
      available: shared ? "shared" : "ok",
      pin: pin ? { digits: pin.digits } : null,
      ...(gate ? { gate: { armed: live } } : {}),
      ...(restart ? { restart: { state: restart, triesLeft: Math.max(0, QUICK_TRIES - fails) } } : {}),
    };
  }
}
