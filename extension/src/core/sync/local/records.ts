// The two records outside the store's copies that are encrypted under the vault key (SYNC-DESIGN §2.5, §3.5 ④; §0.0i
// req. 5): sk_sync_cfg's copy of the device signing key (with the account email), and sk_prejoin, the list of this
// profile's own vaults from before each join that kept one. Each is a VkRecord: the service's one cleanup entry point
// moves it to the current key before the store's own copies (§0.0i req. 5); the permanent delete scrubs sk_prejoin too.
//
// The VkRecord contract (A4R-4, service.ts): the read, the check that the vault's active key is still `current`, and the
// write are ONE critical section under the vault lock (webLock("sixkey-vault"), the store's own), and nothing inside it
// calls the store or the service. The active key is read straight from the slots for that check. A read that throws
// propagates (the cleanup then stops before the store's part and the marker stays). A record under a key nobody here
// holds is "unopenable" and never holds the marker up: sk_prejoin is kept (it is never deleted by itself), sk_sync_cfg
// asks for a new enrolment (§2.5).
//
// Every context runs the cleanup, the popup too, so this module is in its bundle and holds only the cleanup's (and the
// permanent delete's) part. The writers and openers (M1's sealDeviceBackup / openDeviceBackup, which check the key's
// JWK; the join's sk_prejoin and its confirmed delete) are record-writers.ts, for the contexts that sync. Moving sk_sync_cfg's copy to another key does not look inside it: the
// same plaintext, decrypted under the old key and the AAD M1 bound it to, encrypted under the new one (a test opens the
// result with M1's openDeviceBackup, and checks the two constants below against M1's labels).
import { bs, fromB64, randomBytes, toB64, utf8, type Random } from "../../crypto/bytes";
import { decryptVault, encryptVault, validateEnvelope, type EncryptedVault } from "../../crypto/envelope";
import { hkdfAesKey } from "../../crypto/kdf";
import type { Vk } from "../../crypto/vk";
import { activeKeyring } from "../../storage/active-keyring";
import type { KV, Lock } from "../../storage/kv";
import type { VkRecord, VkRecordResult } from "../../service/service";
import type { DeviceBackup } from "../crypto/device-backup";
import type { IdentityState } from "./identity";
import { SYNC_KEYS } from "./keys";

/** The keyring of the active generation, read straight from the slots: storage-level code, kept there and re-exported. */
export { activeKeyring };

/**
 * One record's cleanup step, to the VkRecord contract: in one critical section under the vault lock, read it; absent,
 * damaged ("unopenable": kept, never holds the marker up), or already under `current`; then the check that `current`
 * is still the vault's active key ("superseded" otherwise, nothing written); then the held key it names opens it and it
 * is written under `current`. A read that throws propagates.
 */
abstract class VkEncryptedRecord<R> implements VkRecord {
  abstract readonly name: string;
  constructor(
    protected readonly kv: KV,
    protected readonly lock: Lock,
    protected readonly rng: Random = randomBytes,
  ) {}
  protected abstract parse(x: unknown): R | "damaged" | null;
  protected abstract keyOf(r: R): string;
  /** `r` under `to` instead of `from`, for the vault `vaultId`; throws if `from` does not open it. */
  protected abstract moved(r: R, from: Vk, to: Vk, vaultId: string): Promise<R>;

  async read(): Promise<R | "damaged" | null> {
    return this.parse((await this.kv.get([this.name]))[this.name]);
  }

  reencrypt(current: Vk, held: readonly Vk[]): Promise<VkRecordResult> {
    return this.lock(async () => {
      const r = await this.read();
      if (r === null) return "absent";
      if (r === "damaged") return "unopenable";
      if (this.keyOf(r) === current.id) return "current";
      const kr = await activeKeyring(this.kv);
      if (kr.vkId !== current.id) return "superseded"; // a newer key change's own cleanup moves it
      const from = held.find((k) => k.id === this.keyOf(r));
      if (!from) return "unopenable";
      let next: R;
      try {
        next = await this.moved(r, from, current, kr.vaultId);
      } catch {
        return "unopenable"; // sealed for another vault, or damaged
      }
      await this.kv.set({ [this.name]: next });
      return "rewritten";
    });
  }
}

// ---- sk_sync_cfg (§2.5) ------------------------------------------------------------------------------------------------

/** `state`: the identity's, mirrored so a restored identity comes back as it was (M2R-7); absent reads as "pending". */
export type SyncCfg = {
  v: 1;
  deviceId: string;
  apiOrigin: string;
  state?: IdentityState;
  cursor?: { cur: string; pending?: string };
  enc: DeviceBackup;
};
export type CfgPlain = { deviceId: string; apiOrigin: string; dsk: unknown; email: string };

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{22}$/; // M1 encoding.ts's: 16 random bytes in base64url (§2.5)
/** M1 labels.ts's TAG.devkey and LABEL.deviceBackup (§2.2): the copy's AAD prefix and K_devbackup's HKDF info. */
export const DEVKEY_TAG = "sixkey-devkey|1|";
export const DEVICE_BACKUP_LABEL = "sixkey/v1/device-backup";

/** The record, checked; "damaged" for anything else that is there. */
export function parseSyncCfg(x: unknown): SyncCfg | "damaged" | null {
  if (x === undefined) return null;
  const o = (x ?? {}) as Partial<SyncCfg>;
  const e = (o.enc ?? {}) as Partial<DeviceBackup>;
  const ok =
    o.v === 1 &&
    DEVICE_ID_RE.test(String(o.deviceId)) &&
    typeof o.apiOrigin === "string" &&
    [e.vkId, e.iv, e.ct].every((v) => typeof v === "string") &&
    [undefined, "pending", "enrolled", "rejected_by_server"].includes(o.state);
  return ok ? (o as SyncCfg) : "damaged";
}

/** sk_sync_cfg as the cleanup sees it (writing and opening it: record-writers.ts). */
export class SyncCfgRecord extends VkEncryptedRecord<SyncCfg> {
  readonly name = SYNC_KEYS.cfg;
  protected parse = parseSyncCfg;
  protected keyOf(c: SyncCfg): string {
    return c.enc.vkId;
  }
  protected async moved(c: SyncCfg, from: Vk, to: Vk, vaultId: string): Promise<SyncCfg> {
    // AES-GCM under K_devbackup with M1's AAD 'sixkey-devkey|1|{vaultId}|{vkId}|{deviceId}' (device-backup.ts)
    const gcm = (iv: Uint8Array, vkId: string) => ({
      name: "AES-GCM",
      iv: bs(iv),
      additionalData: bs(utf8(`${DEVKEY_TAG}${vaultId}|${vkId}|${c.deviceId}`)),
      tagLength: 128,
    });
    const key = (vk: Vk) => hkdfAesKey(vk.raw, new Uint8Array(0), DEVICE_BACKUP_LABEL);
    const pt = new Uint8Array(
      await crypto.subtle.decrypt(gcm(fromB64(c.enc.iv), from.id), await key(from), bs(fromB64(c.enc.ct))),
    );
    try {
      const iv = this.rng(12);
      const ct = new Uint8Array(await crypto.subtle.encrypt(gcm(iv, to.id), await key(to), bs(pt)));
      return { ...c, enc: { vkId: to.id, iv: toB64(iv), ct: toB64(ct) } };
    } finally {
      pt.fill(0); // holds the private key
    }
  }
}

// ---- sk_prejoin (§3.5 ④) -----------------------------------------------------------------------------------------------

/** One kept vault: this profile's own vault from before a join, as its plaintext under the cloud key, keeping its vault id. */
export type Prejoin = { v: 1; at: number; envelope: EncryptedVault };

/**
 * sk_prejoin's entries, oldest first, as stored, or null with none. The record is a list, { v: 2, items } (every join
 * in the added mode appends its own; none is replaced, none is dropped by itself); a stored value that is not that list
 * (a single kept vault from before the list, or anything else) reads as the list's one entry, unchanged.
 */
export function prejoinItems(x: unknown): unknown[] | null {
  if (x === undefined) return null;
  const o = x as { v?: unknown; items?: unknown };
  return typeof x === "object" && x !== null && o.v === 2 && Array.isArray(o.items) ? o.items : [x];
}

/** One entry, checked. */
export function parsePrejoin(x: unknown): Prejoin | "damaged" {
  try {
    const o = x as Record<string, unknown>;
    if (o.v !== 1 || typeof o.at !== "number") return "damaged";
    return { v: 1, at: o.at, envelope: validateEnvelope(o.envelope) };
  } catch {
    return "damaged";
  }
}

/**
 * sk_prejoin as the cleanup and the permanent delete see it. The cleanup (VkRecord) moves each entry a held key opens to
 * the current key and keeps every other one as it is. The permanent delete (purge) scrubs the erased accounts out of each
 * entry it can open, and keeps every other one as it is too: an entry goes only by the user's confirmed delete (§3.5 ④),
 * never by itself (docs/design/notes/M6-NOTES.md §13.5 item 12 says what that leaves for an entry nobody here can open).
 */
export class PrejoinRecord implements VkRecord {
  readonly name = SYNC_KEYS.prejoin;
  constructor(
    protected readonly kv: KV,
    protected readonly lock: Lock,
    protected readonly rng: Random = randomBytes,
  ) {}

  async items(): Promise<unknown[] | null> {
    return prejoinItems((await this.kv.get([this.name]))[this.name]);
  }

  reencrypt(current: Vk, held: readonly Vk[]): Promise<VkRecordResult> {
    return this.lock(async () => {
      const items = await this.items();
      if (items === null) return "absent";
      const parsed = items.map(parsePrejoin);
      if (parsed.every((p) => p !== "damaged" && p.envelope.vkId === current.id)) return "current";
      if ((await activeKeyring(this.kv)).vkId !== current.id) return "superseded"; // a newer key change's own cleanup moves it
      let moved = false;
      let stuck = false;
      const next: unknown[] = [];
      for (const [i, p] of parsed.entries()) {
        const from = p === "damaged" ? undefined : held.find((k) => k.id === p.envelope.vkId);
        if (p !== "damaged" && p.envelope.vkId !== current.id && from) {
          try {
            next.push({ ...p, envelope: await this.under(p, from, current) });
            moved = true;
            continue;
          } catch {
            // sealed for another key, or damaged: kept as it is
          }
        }
        if (p === "damaged" || p.envelope.vkId !== current.id) stuck = true;
        next.push(items[i]);
      }
      if (moved) await this.kv.set({ [this.name]: { v: 2, items: next } });
      return moved ? "rewritten" : stuck ? "unopenable" : "current";
    });
  }

  /** The permanent delete: `scrub` takes the erased accounts out of each entry it can open; under `current` after. */
  purge(
    current: Vk,
    held: readonly Vk[],
    scrub: (vault: Uint8Array, vaultId: string) => Promise<Uint8Array>,
  ): Promise<number> {
    return this.lock(async () => {
      const items = await this.items();
      if (items === null) return 0;
      const next: unknown[] = [];
      let scrubbed = false;
      let unchecked = 0;
      for (const [i, p] of items.map(parsePrejoin).entries()) {
        const key = p === "damaged" ? undefined : [current, ...held].find((k) => k.id === p.envelope.vkId);
        const plain = p !== "damaged" && key ? await decryptVault(p.envelope, key).catch(() => null) : null;
        if (p === "damaged" || !plain) {
          next.push(items[i]); // kept as it is: it cannot be checked, and only the user deletes an entry
          unchecked++;
          continue;
        }
        const e = p.envelope;
        next.push({
          ...p,
          envelope: await encryptVault(
            await scrub(plain, e.vaultId),
            current,
            { vaultId: e.vaultId, rev: e.rev },
            this.rng,
          ),
        });
        scrubbed = true;
      }
      if (scrubbed) await this.kv.set({ [this.name]: { v: 2, items: next } });
      return unchecked;
    });
  }

  private async under(p: Prejoin, from: Vk, to: Vk): Promise<EncryptedVault> {
    return encryptVault(
      await decryptVault(p.envelope, from),
      to,
      { vaultId: p.envelope.vaultId, rev: p.envelope.rev },
      this.rng,
    );
  }
}
