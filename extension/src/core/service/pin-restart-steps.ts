// The PIN on a lock screen (OWNER-DECISIONS/20 and its 2026-10-30 notes; docs/design/notes/PIN-RESTART-NOTES.md §3,
// §18): the unlock with its record, sk_pin_restart, its tries counted on it, and the master password's note (the record
// made, or made again, when the PIN waits for it). Loaded lazily: the lock screens load it for a PIN typed and for the
// note (the popup's and the side panel's Locked.tsx, the settings page's unlock bar), so none of it, nor the crypto it
// uses (pin-restart-wrap.ts), is in the popup's counted bundle. What the PIN offers is the lock screens' own step
// (pin-restart-count.ts, no crypto, in their own chunks), and the key events' step the service's (service.ts committed),
// in every context.
//
// It reuses the service's own steps, taken from the service itself by element access (as device-unlock.ts does): the store
// and the keys its first read takes (`also`), the PIN store's KV and lock, the session and its quick lock, the settings,
// the clock and random source, the security record, the test hook's PBKDF2 count, `vkOf`, `sessionVk`, finishUnlock and
// the master password's one-shot mark (`typed`); and pin.ts's own derivations, the record's rules and the active keyring's
// reading come as `kit` (pin-kit.ts), from the lock screen that loads these steps.
// It imports no module of the popup's main chunk, only the lazy pin-restart-wrap.ts and the leaf crypto-error.ts
// (SHAMIR-NOTES.md §7).
// Every write of the record is one critical section under the record's store's lock, the vault lock
// (webLock("sixkey-vault")), and nothing inside it calls the store or the service; no derivation runs inside it. The PIN,
// pinKek, the KEK and the vault key are passed to nothing but the derivations and the unwrap, and never written or logged.
import { CryptoError } from "../crypto/crypto-error";
import type { PinRecord } from "../crypto/pin";
import type { RestartRecord } from "../crypto/pin-restart";
import {
  newRestartId,
  openRestart,
  restartIterations,
  restartMac,
  restartMacOk,
  restartOk,
  sealRestart,
  type RestartHead,
} from "../crypto/pin-restart-wrap";
import type { Vk } from "../crypto/vk";
import type { KV, Lock } from "../storage/kv";
import type { PinKit } from "./pin-kit";
import type { PinStore } from "./pin-store";
import type { PinUnlock, ServiceCore } from "./service-core";

/** The key, as pin-store.ts RESTART_KEY (core/sync/local/keys.ts LOCAL_ONLY_KEYS.restart): restated, not imported. */
const KEY = "sk_pin_restart";
/** The settings' key (types.ts SETTINGS_KEY), restated: the note reads them with the pointer. */
const SETTINGS = "sk_settings";
/** The PIN store's own KV and lock (by element access: the same chrome.storage.local and webLock("sixkey-vault")). */
type Io = { kv: KV; lock: Lock };
const io = (pins: PinStore): Io => ({ kv: pins["kv"] as KV, lock: pins["lock"] as Lock });

/** The tries (pin.ts QUICK_TRIES, restated). */
export const RESTART_TRIES = 5;

/** The record as stored now, checked in full (pin-restart-wrap.ts restartOk), or null. In the caller's lock, or none. */
async function current(store: Io): Promise<RestartRecord | null> {
  const raw = (await store.kv.get([KEY]))[KEY];
  return restartOk(raw) ? raw : null;
}
/** A try counted: the wrap it derives against (read in the lock), and the record as written. */
type Spent = { wrap: NonNullable<RestartRecord["wrap"]>; next: RestartRecord };

/**
 * The PIN unlock (QUICK-UNLOCK §5.4's steps, for its record on disk). A PIN that is not 4 to 8 digits is a typo
 * ("malformed": nothing counted); then the lock epoch, then the settings (a solo profile, else "ended"), then
 *   1. the store as loadView reads it (the record, sk_pin, the keyring with the pointer): it must offer the PIN now
 *      (pin-restart.ts restartState "pin": this vault, key, wraps and PIN set-up, a wrap, a try left),
 *      checked again here whoever asks (review r2, PINR-03), be whole (restartOk), and hold a wrap of no fewer iterations
 *      than a new one gets now (restartIterations: the master password's count and the keyring's; PINR-02); else
 *      "ended", nothing counted;
 *   2. in the vault lock, the same record (its id) read again and one try spent, written FIRST: a page closed during the
 *      derivations has spent it, and two pages never use the same try; the 5th also sets its wrap aside in that very
 *      write (PINR-07: no key material is left on disk whatever happens to this page; the derivation uses the wrap read);
 *      no try left: "exhausted";
 *   3. outside the lock, the derivations (pinKek, then the KEK at the count the wrap states: 2.6M iterations at least),
 *      the unwrap and the key's id;
 *   4. wrong: pin_failed recorded; the 5th: the Touch ID / Windows Hello gate's arming ended too (sk_quick, in the
 *      quick lock: whatever ends the PIN ends the gate, OWNER-DECISIONS/17 Q1), quick_ended recorded, "exhausted"; else
 *      "wrong" with the tries left;
 *   5. right: in the vault lock, compare-and-set on the record the try was counted on (one ended, removed or made again
 *      meanwhile refuses it: "ended"), and the vault's active keyring read again: its key and wraps must still be the
 *      record's, else "ended" and nothing written (a key event during the derivation: the old key never opens a session,
 *      and no wrap under it comes back; review of PINONE, PO-01; an unreadable keyring is "ended" too). Then the count
 *      back to none; the 5th try's wrap, set aside with its count, put back when the record is still exactly as that try
 *      wrote it and nothing locked meanwhile (the limit is 5 wrong in a row, OWNER-DECISIONS/20, 2026-10-30); with a lock
 *      meanwhile it stays aside, and the answer is "waiting": the master password once, as after the 5th wrong one
 *      (PO-03; nothing recorded). Then the same session start as a password unlock, with the epoch of the start: a lock
 *      during the derivations voids it ("locked").
 *      It never arms the gate (sk_quick): its 12 hours count from the master password.
 */
export async function unlock(s: ServiceCore, input: string, kit: PinKit): Promise<PinUnlock> {
  const pin = kit.normalizePin(input);
  if (pin === null) return { ok: false, reason: "malformed" };
  const epoch = await s["session"].lockEpoch();
  const sv = await s["settings"].getView();
  const pins = s["pins"];
  if (!pins || kit.profileOf(sv.settings) === "shared") return { ok: false, reason: "ended" };
  const store = io(pins);
  const r = await s["store"].loadView(s["also"]);
  if (r.status !== "ok") return { ok: false, reason: "ended" };
  const k = r.gen.keyring;
  const set = kit.parsePinRecord(r.also?.[pins.name]);
  const raw = r.also?.[KEY];
  if (
    !restartOk(raw) ||
    kit.restartState(raw, k, set, false) !== "pin" ||
    raw.wrap!.kdf.iterations < restartIterations(s["iterations"], k)
  )
    return { ok: false, reason: "ended" };
  const spent = await store.lock(async (): Promise<Spent | "ended" | "exhausted"> => {
    const cur = await current(store);
    if (!cur || cur.id !== raw.id || !cur.wrap) return "ended";
    if (cur.fails >= RESTART_TRIES) return "exhausted";
    const fails = cur.fails + 1;
    const next = { ...cur, fails, wrap: fails >= RESTART_TRIES ? null : cur.wrap };
    await store.kv.set({ [KEY]: next });
    return { wrap: cur.wrap, next };
  });
  if (typeof spent === "string") return { ok: false, reason: spent };
  const p = set as PinRecord; // restartState answered "pin": a set-up of this vault and key
  let vk: Vk | null = null;
  try {
    const pinKek = await kit.derivePinKek(pin, p.kdf);
    try {
      vk = await s["vkOf"](await openRestart(spent.wrap, spent.next, pinKek));
    } finally {
      pinKek.fill(0);
    }
  } catch (e) {
    if (!(e instanceof CryptoError)) throw e;
  }
  if (!vk || vk.id !== k.vkId) {
    await s["record"]("pin_failed");
    if (spent.next.fails < RESTART_TRIES)
      return { ok: false, reason: "wrong", triesLeft: RESTART_TRIES - spent.next.fails, digits: p.digits };
    await s["quickLock"](() => s["session"].clearQuick()); // the 5th: its wrap went with the count, and the gate goes
    await s["record"]("quick_ended");
    return { ok: false, reason: "exhausted" };
  }
  const still = await store.lock(async (): Promise<"ok" | "ended" | "waiting"> => {
    const cur = await current(store);
    if (!cur || cur.id !== spent.next.id || JSON.stringify(cur.wrap) !== JSON.stringify(spent.next.wrap))
      return "ended";
    // the keys the try was counted for are still the vault's: a key event during the derivation (a new password, a reset,
    // a rotation, one taken from sync) leaves a record whose wrap is already aside as it was, so only the keyring tells
    let kr: Awaited<ReturnType<PinKit["activeKeyring"]>>;
    try {
      kr = await kit.activeKeyring(store.kv);
    } catch {
      return "ended"; // the keyring unreadable now (StorageError): nothing is put back, nothing opens
    }
    if (cur.vkId !== kr.vkId || cur.wraps !== kit.wrapsTag(kr)) return "ended";
    // the right PIN as the 5th try in a row: its wrap went aside with the count (PINR-07), and comes back now that the PIN
    // is proved (5 wrong in a row is the limit, not 5 tries), only onto the record exactly as that try wrote it and with
    // no lock meanwhile; a lock meanwhile ("End quick unlock now" too) leaves it aside, the count gone: "waiting"
    const back = !spent.next.wrap && JSON.stringify(cur) === JSON.stringify(spent.next);
    if (back && (await s["session"].lockEpoch()) !== epoch) {
      await store.kv.set({ [KEY]: { ...cur, fails: 0 } });
      return "waiting";
    }
    if (back) await store.kv.set({ [KEY]: { ...cur, fails: 0, wrap: spent.wrap } });
    else if (cur.fails) await store.kv.set({ [KEY]: { ...cur, fails: 0 } });
    return "ok";
  });
  if (still !== "ok") return { ok: false, reason: still };
  const done = await s["finishUnlock"](vk, r, { sv, epoch });
  if ((await s["session"].lockEpoch()) !== epoch) {
    await s["session"].clear(); // locked during the derivations: that lock wins
    return { ok: false, reason: "locked" };
  }
  return { ok: true, ...done };
}

/**
 * The master password has just unlocked Sixkey on a lock screen (the popup's, the side panel's, the settings page's unlock
 * bar): the PIN made usable again, the master password being what 5 wrong tries, "End quick unlock now" and a key change
 * ask for (OWNER-DECISIONS/20, 2026-10-30). Its proof is the service's one-shot mark (ServiceCore `typed`): set by
 * unlockWithPassword in this very service and by nothing else, taken here once, void after any lock (its epoch) or for
 * other keys; without it nothing is read or written (review r2, PINR-06: a recovery code, a wrong or a missing password,
 * the gate, the PIN, another page's unlock change nothing). The vault key is the session's (sessionVk), as that unlock
 * started it: no derivation of the password again (review of PINONE, PO-02). One load of the store as loadView reads it,
 * with the settings (the record, sk_pin and the settings come with the pointer; the session's own look reads the settings
 * once more). With a PIN set up for these keys in a solo profile (restartState not null):
 *   - a record that offers the PIN, whole (restartOk), with no try counted, a wrap of no fewer iterations than a new one
 *     gets now (restartIterations: PINR-02) and its MAC under the vault key (Sixkey's own, review r3, PINR-R2-01: one
 *     planted in its place is never kept), is left as it is: nothing is derived or written (the steady state);
 *   - anything else is replaced by a new record: none yet (a PIN set before 2026-10-30, whose arming was only its
 *     session's), its wrap set aside (the 5th wrong PIN, "End quick unlock now"), a try counted, paused by a key change,
 *     weaker than a new one, or not even whole (planted, damaged, another vault's: never renewed, only replaced). It is
 *     made from sk_pin's pinKek (the vault key opens it: no PIN needed), with a new salt and id, at the count of a new
 *     master-password wrap (restartIterations: one derivation), its MAC under the vault key, no try counted; written in
 *     the vault lock only if the record is still the one read (compare-and-set: a try counted meanwhile in another page,
 *     or a record made meanwhile, is never overwritten by it);
 *   - an sk_pin whose shape is whole but whose AES-GCM authentication fails under the vault key (its ciphertext damaged:
 *     no record can ever be made from it; pin.ts openPinRecord's "decrypt_failed", and nothing else: S-02) is removed,
 *     with any record beside it, compare-and-delete in the vault lock, as removePin removes them (the record first): the
 *     settings page then shows no PIN, and one can be set again (PO-04). No security record for it (rare; S-05).
 * One made for a set-up that a change of the PIN in another page replaced meanwhile names the old salt and is never
 * offered ("paused"); the change makes its own. A write that is lost only asks for the master password again. Never
 * throws. The lock screens wait for it (capped) before they show the list, so a popup closed at once does not lose it.
 */
export async function notePassword(s: ServiceCore, kit: PinKit): Promise<void> {
  const typed = s["typed"];
  s["typed"] = null; // one shot
  const pins = s["pins"];
  if (!pins || !typed) return;
  const store = io(pins);
  try {
    const r = await s["store"].loadView([...s["also"], SETTINGS]);
    if (r.status !== "ok") return;
    const k = r.gen.keyring;
    const pinRaw = r.also?.[pins.name];
    const set = kit.parsePinRecord(pinRaw);
    const settings = kit.parseSettings(r.also?.[SETTINGS]);
    const raw = r.also?.[KEY];
    const state = kit.restartState(raw, k, set, kit.profileOf(settings) === "shared");
    if (state === null) return; // no PIN here
    // the master password typed in this service for these very keys, and no lock since the session it started
    if (typed.vkId !== k.vkId || (await s["session"].lockEpoch()) !== typed.epoch) return;
    const vk = await s["sessionVk"](k, async () => settings);
    if (!vk || vk.id !== k.vkId) return;
    const count = restartIterations(s["iterations"], k);
    if (state === "pin" && restartOk(raw) && !raw.fails && raw.wrap!.kdf.iterations >= count) {
      if (await restartMacOk(vk.raw, raw, raw.mac)) return; // the steady state
    }
    const p = set as PinRecord; // restartState answered: a set-up of this vault and key
    let pinKek: Uint8Array;
    try {
      pinKek = await kit.openPinRecord(p, vk);
    } catch (e) {
      // its authentication failed under the session's very key: damaged for good, it goes; any other failure (the key's
      // derivation, WebCrypto itself) leaves it as it is (review of PINONE r2, S-02)
      if (e instanceof CryptoError && e.code === "decrypt_failed") await dropSetup(store, pins.name, pinRaw);
      return;
    }
    const h: RestartHead = {
      vaultId: k.vaultId,
      vkId: vk.id,
      id: newRestartId(s["rng"]),
      setup: p.kdf.salt,
      wraps: kit.wrapsTag(k),
    };
    let next: RestartRecord;
    try {
      const wrap = await sealRestart(vk.raw, h, pinKek, count, s["rng"]);
      next = { v: 1, ...h, mac: await restartMac(vk.raw, h), lastPasswordAt: s["now"](), fails: 0, wrap };
    } finally {
      pinKek.fill(0);
    }
    const seen = JSON.stringify(raw);
    await store.lock(async () => {
      const cur = (await store.kv.get([KEY]))[KEY];
      if (JSON.stringify(cur) === seen) await store.kv.set({ [KEY]: next });
    });
  } catch {
    // not written: the next master password writes it
  }
}

/**
 * sk_pin as `seen` (whole, of these keys, but its ciphertext not opened by the vault key), removed with the record beside
 * it, in the vault lock, only if it is still that very set-up (a PIN set meanwhile in another page is left alone).
 */
async function dropSetup(store: Io, name: string, seen: unknown): Promise<void> {
  await store.lock(async () => {
    const cur = (await store.kv.get([name]))[name];
    if (cur === undefined || JSON.stringify(cur) !== JSON.stringify(seen)) return;
    await store.kv.remove([KEY]);
    await store.kv.remove([name]);
  });
}
