// sk_pin, the PIN's set-up (QUICK-UNLOCK §5.2, §5.9; the record itself: src/core/crypto/pin.ts). The only code that
// writes it: setPin and removePin (pin-admin.ts) call write() and remove(), and the one cleanup entry point calls
// reencrypt() after a key change. Each is one critical section under the vault lock (webLock("sixkey-vault"), the store's
// own, as service.ts's VkRecord contract asks), and nothing inside it calls the store or the service.
//   - write: only while the vault's active keyring is still the vault and key the record was sealed for (read straight
//     from the slots, as the device unlock's record does), so a key change in another page cannot leave the set-up under a key that
//     is no longer the vault's.
//   - reencrypt (the VkRecord contract, service.ts): a set-up under an older key that this cleanup holds moves to the
//     current key (pinKek is the same, so the user's PIN stays). One under a key nobody here holds, for another vault, or
//     damaged, is removed: it holds no vault data, and the PIN can be set again. It never holds the marker up.
// The PIN's record, sk_pin_restart (OWNER-DECISIONS/20 and its 2026-10-30 notes; src/core/crypto/pin-restart.ts), is the PIN's too,
// so it is written through this store's own KV and lock (the same chrome.storage.local and webLock("sixkey-vault")), but
// by none of this file's code, which is in the popup's counted bundle: by the lock screens' lazy chunk
// (pin-restart-steps.ts: the record's own unlock and counter, the master password's note) and the settings page's and the
// service worker's (pin-restart-admin.ts: made with a new PIN, removed, turned back on, and its wrap set aside after every
// key event, VaultService.committed). Only its key is named here.
// Not vault data (store.ts hasAnyData), never mirrored, synced, backed up or exported (core/storage/local-keys.ts).
import { randomBytes, type Random } from "../crypto/bytes";
import { openPinRecord, parsePinRecord, sealPinRecord, type PinRecord } from "../crypto/pin";
import type { Vk } from "../crypto/vk";
import type { KV, Lock } from "../storage/kv";
import { activeKeyring } from "../storage/active-keyring";
import { LOCAL_ONLY_KEYS } from "../storage/local-keys";
import type { VkRecord, VkRecordResult } from "./service";

export const PIN_KEY = LOCAL_ONLY_KEYS.pin;
export const RESTART_KEY = LOCAL_ONLY_KEYS.restart;

export class PinStore implements VkRecord {
  readonly name = PIN_KEY;
  constructor(
    private readonly kv: KV,
    /** The store's own lock: webLock("sixkey-vault"). */
    private readonly lock: Lock,
    private readonly rng: Random = randomBytes,
  ) {}

  /** One read, no lock. A read that throws propagates. */
  async read(): Promise<PinRecord | "damaged" | null> {
    return parsePinRecord((await this.kv.get([PIN_KEY]))[PIN_KEY]);
  }

  /**
   * Write `rec` if the vault's active keyring is still `rec`'s vault and key. Returns false, with nothing written, if it
   * is not (a key change landed meanwhile: the caller says so, and the PIN can be set again).
   */
  write(rec: PinRecord): Promise<boolean> {
    return this.lock(async () => {
      const kr = await activeKeyring(this.kv);
      if (kr.vaultId !== rec.vaultId || kr.vkId !== rec.vkId) return false;
      await this.kv.set({ [PIN_KEY]: rec });
      return true;
    });
  }

  /** Delete it (the PIN removed, or a set-up for a vault that is no longer this profile's). */
  remove(): Promise<void> {
    return this.lock(() => this.kv.remove([PIN_KEY]));
  }

  reencrypt(current: Vk, held: readonly Vk[]): Promise<VkRecordResult> {
    return this.lock(async () => {
      const r = await this.read();
      if (r === null) return "absent";
      const kr = await activeKeyring(this.kv);
      if (kr.vkId !== current.id) return "superseded"; // a newer key change's own cleanup moves it
      const drop = async (): Promise<VkRecordResult> => {
        await this.kv.remove([PIN_KEY]);
        return "unopenable";
      };
      if (r === "damaged" || r.vaultId !== kr.vaultId) return drop();
      if (r.vkId === current.id) return "current";
      const from = held.find((k) => k.id === r.vkId);
      if (!from) return drop();
      let next: PinRecord;
      try {
        const pinKek = await openPinRecord(r, from);
        next = await sealPinRecord(current, kr.vaultId, pinKek, { digits: r.digits, kdf: r.kdf }, this.rng);
      } catch {
        return drop();
      }
      await this.kv.set({ [PIN_KEY]: next });
      return "rewritten";
    });
  }
}
