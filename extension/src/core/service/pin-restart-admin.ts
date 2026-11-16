// The PIN's record in Settings › Security › PIN quick unlock (OWNER-DECISIONS/20 and its 2026-10-30 notes; docs/design/
// notes/PIN-RESTART-NOTES.md §4, §18): turned back on after a key event or 5 wrong tries ("Turn back on"), and what the box
// shows; and the steps the PIN box's own changes take (sealNewRestart and writeRestart: the record made with a new PIN;
// removeRestart) and the step every committed key event takes (setAsideRestart, from service.ts committed). Only the
// settings page and the service worker build it (the PIN box, PinAdmin, VaultService), so none of it is in the popup's
// bundle; the lock screen's side is pin-restart-steps.ts.
//
// It reuses the service's own steps by element access (as pin-admin.ts and device-admin.ts do): the store, the settings,
// the clock and random source, the security record, requireVk, the PIN's and the record's stores, the test hook's PBKDF2
// count; and verifyPassword itself, so the master password typed again is checked, answered and recorded exactly as
// everywhere. Every write of the record is one critical section under the vault lock, and only while the vault's keyring
// and the PIN's set-up are still the ones the record is made for. A record is used here (shown, turned back on) only once
// it is Sixkey's own (genuineRestart: every field whole and its MAC under the vault key; review r2, PINR-01): anything
// else stored there is removed and read as none.
import { CryptoError } from "../crypto/bytes";
import { unwrapPreviousVks, type Keyring } from "../crypto/keyring";
import { derivePinKek, normalizePin, openPinRecord, QUICK_TRIES, wrapsTag, type PinRecord } from "../crypto/pin";
import { parseRestart, restartState, type RestartRecord, type RestartState } from "../crypto/pin-restart";
import {
  newRestartId,
  restartIterations,
  restartMac,
  restartMacOk,
  restartOk,
  sealRestart,
} from "../crypto/pin-restart-wrap";
import type { Vk } from "../crypto/vk";
import { activeKeyring } from "../storage/active-keyring";
import type { KV, Lock } from "../storage/kv";
import { RESTART_KEY, type PinStore } from "./pin-store";
import { rewrappedBy } from "./rotated";
import type { VaultService } from "./service";
import { hasDevice } from "./service-core";
import { ServiceError } from "./service-error";
import { profileOf } from "./types";

/** How long after this page's own key event the PIN alone turns it back on (device-admin.ts's 10 minutes, Q3). */
export const REWRAPPED_MS = 10 * 60_000;

/**
 * What the box shows of it. `on`: a record Sixkey made for this vault is stored (in any state; genuineRestart). `state`:
 * what the PIN offers now (pin-restart.ts restartState: "pin", "wait", "paused"; null when no PIN is set up here).
 * `triesLeft`: of an armed one. `byPin`: paused, this page's own key event to these very keys in the last 10 minutes,
 * tries left: the PIN alone turns it back on.
 */
export type RestartView = {
  on: boolean;
  state: RestartState | null;
  triesLeft: number;
  byPin: boolean;
};

const protectedBy = (k: Keyring) => !hasDevice(k) && k.wraps.some((w) => w.method === "password");
/** The PIN store's own KV and lock (by element access: the record is the PIN's, under the same lock). */
const io = (pins: PinStore) => ({ kv: pins["kv"] as KV, lock: pins["lock"] as Lock });

/** The record as stored: one read, no lock (the settings page's reading; the lock screen's is the service's). */
export async function readRestart(pins: PinStore): Promise<RestartRecord | "damaged" | null> {
  return parseRestart((await io(pins).kv.get([RESTART_KEY]))[RESTART_KEY]);
}

/**
 * The record as stored, only if Sixkey made it for this vault (review r2, PINR-01): every field whole (restartOk), this
 * vault, and its MAC under the vault key it names: `vk`, the vault's current key, or one this keyring retired (a record
 * paused by a rotation was made under the old key). Anything else stored there (planted by a writer of the storage, who
 * has no vault key; damaged; another vault's) is removed, compare-and-set in the vault lock, and read as none: it is never
 * shown as on, turned back on, or made into a record that opens with a changed PIN. `vk` is the unlocked vault's key.
 */
export async function genuineRestart(pins: PinStore, keyring: Keyring, vk: Vk): Promise<RestartRecord | null> {
  const { kv, lock } = io(pins);
  const raw = (await kv.get([RESTART_KEY]))[RESTART_KEY];
  if (raw === undefined) return null;
  if (restartOk(raw) && raw.vaultId === keyring.vaultId) {
    const key = raw.vkId === vk.id ? vk : (await unwrapPreviousVks(keyring, vk)).find((v) => v.id === raw.vkId);
    if (key && (await restartMacOk(key.raw, raw, raw.mac))) return raw;
  }
  const seen = JSON.stringify(raw);
  await lock(async () => {
    const cur = (await kv.get([RESTART_KEY]))[RESTART_KEY];
    if (cur !== undefined && JSON.stringify(cur) === seen) await kv.remove([RESTART_KEY]);
  });
  return null;
}

/**
 * Delete it, in the vault lock, when there is one (no write otherwise): the PIN removed or changed, a profile declared
 * shared, a new vault.
 */
export function removeRestart(pins: PinStore): Promise<void> {
  const { kv, lock } = io(pins);
  return lock(async () => {
    if ((await kv.get([RESTART_KEY]))[RESTART_KEY] !== undefined) await kv.remove([RESTART_KEY]);
  });
}

/**
 * Its wrap set aside, the record kept, in the vault lock: no key material is left on disk. With no `keyring` ("End quick
 * unlock now"), whatever it is; the next master password typed on a lock screen makes a new one (pin-restart-steps.ts
 * notePassword). With `keyring` (VaultService.committed, after every key event): only one made under another vault key
 * or another set of the keyring's wraps, which the owner's rule pauses (OWNER-DECISIONS/20: a wrap under the PIN cannot
 * be moved to the new keys without the PIN; the next master password makes a new one, or the PIN alone right after this
 * page's own key event, turnBackOn); and one for another vault, or not shaped like one, is removed (it holds no vault
 * data). Until then the service never offers or opens such a record (pin-restart.ts restartState: "paused"), and the lock
 * screen's note replaces it, should a page have died before this ran.
 */
export function setAsideRestart(pins: PinStore, keyring?: Pick<Keyring, "vaultId" | "vkId" | "wraps">): Promise<void> {
  const { kv, lock } = io(pins);
  return lock(async () => {
    const r = parseRestart((await kv.get([RESTART_KEY]))[RESTART_KEY]);
    if (r === null) return;
    if (keyring && (r === "damaged" || r.vaultId !== keyring.vaultId)) return kv.remove([RESTART_KEY]);
    if (r === "damaged" || !r.wrap || (keyring && r.vkId === keyring.vkId && r.wraps === wrapsTag(keyring))) return;
    await kv.set({ [RESTART_KEY]: { ...r, wrap: null } });
  });
}
const sameBytes = (a: Uint8Array, b: Uint8Array) => {
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) d |= a[i]! ^ b[i]!;
  return d === 0;
};

/**
 * A new record for `vk` of `keyring` from the PIN's set-up `set` and its pinKek: a new id, salt and MAC, no tries
 * counted, made at `at`, at the count of a new master-password wrap (restartIterations). The derivation only: nothing is
 * read or written (PinAdmin.setPin derives it before its first write, so a page closed during the derivation leaves the
 * old PIN as it was, and one closed after it has nothing slow left to do: writeRestart).
 */
export async function sealNewRestart(
  s: VaultService,
  vk: Vk,
  keyring: Keyring,
  set: PinRecord,
  pinKek: Uint8Array,
  at: number,
): Promise<RestartRecord> {
  const head = {
    vaultId: keyring.vaultId,
    vkId: vk.id,
    id: newRestartId(s["rng"]),
    setup: set.kdf.salt,
    wraps: wrapsTag(keyring),
  };
  const wrap = await sealRestart(vk.raw, head, pinKek, restartIterations(s["iterations"], keyring), s["rng"]);
  return { v: 1, ...head, mac: await restartMac(vk.raw, head), lastPasswordAt: at, fails: 0, wrap };
}

/**
 * Write a record sealNewRestart made, in the vault lock, in place of whatever is there, only while the vault's active
 * keyring is still the one it was made for (its vault, key and wraps) and sk_pin still the set-up it names; false,
 * nothing written, otherwise.
 */
export async function writeRestart(s: VaultService, rec: RestartRecord): Promise<boolean> {
  const pins = s["pins"];
  if (!pins) return false;
  const store = io(pins);
  return store.lock(async () => {
    const kr = await activeKeyring(store.kv);
    if (kr.vaultId !== rec.vaultId || kr.vkId !== rec.vkId || wrapsTag(kr) !== rec.wraps) return false;
    const now = await pins.read();
    if (!now || now === "damaged" || now.vkId !== rec.vkId || now.kdf.salt !== rec.setup) return false;
    await store.kv.set({ [RESTART_KEY]: rec });
    return true;
  });
}

/** sealNewRestart, then writeRestart: a new record made and written (false: the keys or the set-up changed meanwhile). */
export async function makeRestart(
  s: VaultService,
  vk: Vk,
  keyring: Keyring,
  set: PinRecord,
  pinKek: Uint8Array,
  at: number,
): Promise<boolean> {
  if (!s["pins"]) return false;
  return writeRestart(s, await sealNewRestart(s, vk, keyring, set, pinKek, at));
}

export class RestartAdmin {
  constructor(private readonly s: VaultService) {}

  /** The vault, unlocked here, with a master password, a solo profile, and the PIN set up for it (bad_state without). */
  private async target(): Promise<{ keyring: Keyring; vk: Vk; set: PinRecord }> {
    if (!this.s["pins"]) throw new ServiceError("quick_off");
    if (profileOf(await this.s["settings"].get()) === "shared") throw new ServiceError("quick_off");
    const r = await this.s["store"].load();
    if (r.status !== "ok") throw new ServiceError("bad_state", r.status);
    const keyring = r.gen.keyring;
    if (!protectedBy(keyring)) throw new ServiceError("not_protected");
    const vk = await this.s["requireVk"](keyring);
    const set = await this.s["pins"].read();
    if (!set || set === "damaged" || set.vaultId !== keyring.vaultId || set.vkId !== keyring.vkId)
      throw new ServiceError("bad_state", "no PIN");
    return { keyring, vk, set };
  }

  private async make(vk: Vk, keyring: Keyring, set: PinRecord, at: number): Promise<void> {
    const pinKek = await openPinRecord(set, vk);
    try {
      if (!(await makeRestart(this.s, vk, keyring, set, pinKek, at)))
        throw new ServiceError("bad_state", "keys changed meanwhile");
    } finally {
      pinKek.fill(0);
    }
  }

  /**
   * Turn it back on here (paused by a key event, or waiting for the master password; the next master password on a lock
   * screen does the same, pin-restart-steps.ts notePassword): with the master password typed again (verifyPassword: a
   * wrong one refused with wrong_secret and recorded as unlock_failed), or, for a paused one right after this page's own
   * key event to these very keys (`byPin`, rotated.ts: its secret was typed for it), the PIN alone, checked against the
   * PIN's set-up (a wrong one refused with wrong_secret and recorded as pin_failed; one that is not 4 to 8 digits:
   * bad_pin, a typo). The PIN alone is counted as the lock screens count it (review r2, PINR-10): the try is written on
   * the record FIRST, in the vault lock, before the derivation, and with 5 counted it is refused (the master password
   * then). Either way a new record is made, its count none. Only for a record that is stored and Sixkey's own
   * (genuineRestart; bad_state otherwise: with none, the master password on a lock screen makes it).
   */
  async turnBackOn(o: { password: string } | { pin: string }): Promise<void> {
    const { keyring, vk, set } = await this.target();
    const rec = await genuineRestart(this.s["pins"]!, keyring, vk);
    if (!rec) throw new ServiceError("bad_state", "not on");
    if ("password" in o) await this.s.verifyPassword(o.password);
    else {
      const t = restartState(rec, keyring, set, false) === "paused" ? this.byPin(keyring) : null;
      if (t === null) throw new ServiceError("wrong_secret");
      if (normalizePin(o.pin) === null) throw new ServiceError("bad_pin"); // not a PIN: a typo, not a guess
      const { kv, lock } = io(this.s["pins"]!);
      const counted = await lock(async () => {
        const cur = (await kv.get([RESTART_KEY]))[RESTART_KEY];
        if (!restartOk(cur) || cur.id !== rec.id || cur.fails >= QUICK_TRIES) return false;
        await kv.set({ [RESTART_KEY]: { ...cur, fails: cur.fails + 1 } });
        return true;
      });
      if (!counted) throw new ServiceError("wrong_secret"); // its tries spent (or the record went): the master password
      let typed: Uint8Array | null = null;
      try {
        typed = await derivePinKek(o.pin, set.kdf);
      } catch (e) {
        if (!(e instanceof CryptoError)) throw e;
        throw new ServiceError("bad_pin");
      }
      const own = await openPinRecord(set, vk);
      const ok = sameBytes(typed, own);
      typed.fill(0);
      own.fill(0);
      if (!ok) {
        await this.s["record"]("pin_failed");
        throw new ServiceError("wrong_secret");
      }
    }
    await this.make(vk, keyring, set, this.s["now"]());
  }

  /** This page's own key event to `keyring`'s very keys in the last 10 minutes: its time; else null. */
  private byPin(keyring: Keyring): number | null {
    const t = rewrappedBy(this.s);
    const age = t ? this.s["now"]() - t.at : -1;
    return t && t.vkId === keyring.vkId && t.wraps === wrapsTag(keyring) && age >= 0 && age <= REWRAPPED_MS
      ? t.at
      : null;
  }

  /**
   * What the box shows: one load, one read of the settings, sk_pin and the record, whose MAC is checked under the vault key
   * (genuineRestart: one not Sixkey's is removed and shown as off). Null: nothing to show here (locked, too: the box is the
   * unlocked settings page's).
   */
  async state(): Promise<RestartView | null> {
    const pins = this.s["pins"];
    if (!pins) return null;
    const r = await this.s["store"].load();
    if (r.status !== "ok" || !protectedBy(r.gen.keyring)) return null;
    const keyring = r.gen.keyring;
    const shared = profileOf(await this.s["settings"].get()) === "shared";
    const set = await pins.read();
    if (shared || !set || set === "damaged" || set.vaultId !== keyring.vaultId || set.vkId !== keyring.vkId)
      return null;
    const vk = await this.s["currentVk"](keyring);
    if (!vk) return null;
    const rec = await genuineRestart(pins, keyring, vk);
    const state = restartState(rec, keyring, set, shared);
    const fails = rec ? rec.fails : 0;
    return {
      on: !!rec,
      state,
      triesLeft: Math.max(0, QUICK_TRIES - fails),
      byPin: state === "paused" && fails < QUICK_TRIES && this.byPin(keyring) !== null,
    };
  }
}
