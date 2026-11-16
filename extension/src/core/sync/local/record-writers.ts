// The two VK-encrypted records written and opened, for the contexts that sync (SyncLocal); the cleanup's part, which
// every context runs, is records.ts.
//   - sk_sync_cfg (SYNC-DESIGN §2.5, d2, S5): the device signing key's copy under the vault key, with the account email,
//     through M1's sealDeviceBackup / openDeviceBackup (which check the key's JWK).
//   - sk_prejoin (§3.5 ④): the list of the vaults this profile kept from before its joins; each join in the added mode
//     appends its own inside the join's transact; nothing on it is replaced, and an entry goes only by the user's
//     confirmed delete (or by the permanent delete of an account, records.ts purge).
import { randomBytes, sha256, toB64, utf8, type Random } from "../../crypto/bytes";
import { decryptVault, encryptVault } from "../../crypto/envelope";
import type { Vk } from "../../crypto/vk";
import type { KV, Lock } from "../../storage/kv";
import { StorageError } from "../../storage/store";
import { ServiceError } from "../../service/service-error";
import { openDeviceBackup, sealDeviceBackup, type DeviceBackupPlain } from "../crypto/device-backup";
import type { IdentityState } from "./identity";
import { canonicalJson } from "../../vault/merge";
import {
  activeKeyring,
  parsePrejoin,
  PrejoinRecord,
  SyncCfgRecord,
  type CfgPlain,
  type Prejoin,
  type SyncCfg,
} from "./records";

export class SyncCfgCopy extends SyncCfgRecord {
  constructor(kv: KV, lock: Lock, rng: Random = randomBytes) {
    super(kv, lock, rng);
  }

  /**
   * Write the record under `vk` for the vault `vaultId`, the caller holding the vault lock and making `vk` the active key
   * (or keeping it so) in the same critical section (the join, §3.5). A cursor and a state already there are kept only for
   * the same deviceId; a new one is "pending" (it is written before init and before complete, §2.5 D4).
   */
  async writeInLock(vk: Vk, vaultId: string, c: CfgPlain): Promise<void> {
    const enc = await sealDeviceBackup(vk, { vaultId, deviceId: c.deviceId }, { dsk: c.dsk, email: c.email }, this.rng);
    const cur = await this.read();
    const same = cur !== null && cur !== "damaged" && cur.deviceId === c.deviceId ? cur : null;
    const cursor = same?.cursor;
    await this.kv.set({
      [this.name]: {
        v: 1,
        deviceId: c.deviceId,
        apiOrigin: c.apiOrigin,
        state: same?.state ?? "pending",
        ...(cursor ? { cursor } : {}),
        enc,
      } satisfies SyncCfg,
    });
  }

  /**
   * The identity's state, mirrored here (M2R-7): M3 calls it whenever it changes the identity's (identity.update first),
   * so an identity restored from this copy comes back "enrolled" only if it was. False when there is no record.
   */
  async setState(state: IdentityState): Promise<boolean> {
    return this.lock(async () => {
      const cur = await this.read();
      if (cur === null || cur === "damaged") return false;
      await this.kv.set({ [this.name]: { ...cur, state } satisfies SyncCfg });
      return true;
    });
  }

  /** The same, taking the vault lock, refused unless `vk` is the active key (the first device, before init, §3.1 step 5). */
  async write(vk: Vk, c: CfgPlain): Promise<void> {
    await this.lock(async () => {
      const kr = await activeKeyring(this.kv);
      if (kr.vkId !== vk.id) throw new StorageError("unreadable", "the vault key changed meanwhile");
      await this.writeInLock(vk, kr.vaultId, c);
    });
  }

  /**
   * The copy opened with `vk` (the current key) or one of `held` (a key change whose cleanup has not moved it yet): what an
   * identity restore needs (§2.5 identity_missing). Throws if none opens it.
   */
  async open(vaultId: string, vk: Vk, held: readonly Vk[] = []): Promise<{ cfg: SyncCfg; plain: DeviceBackupPlain }> {
    const cfg = await this.read();
    if (cfg === null || cfg === "damaged")
      throw new StorageError(
        "unreadable",
        cfg === null ? "no sync configuration" : "the sync configuration is damaged",
      );
    const key = [vk, ...held].find((k) => k.id === cfg.enc.vkId);
    if (!key) throw new StorageError("unreadable", "the device key copy is under a key this vault does not hold");
    return { cfg, plain: await openDeviceBackup(key, { vaultId, deviceId: cfg.deviceId }, cfg.enc) };
  }
}

/**
 * How much sk_prejoin's list may hold (§3.5 ④): it is one chrome.storage.local value, rewritten whole at every key change.
 * A join whose own entry would take it past either bound is refused (kept_full) before anything is written; nothing on
 * the list is ever dropped to make room: the user deletes entries in the Sync section, then joins again.
 */
export const KEPT_MAX = { entries: 8, bytes: 2 * 1024 * 1024 } as const;
/** About what one entry of `plain` takes: its ciphertext in base64, and the envelope around it. */
const entryBytes = (plainLength: number) => Math.ceil((plainLength + 16) / 3) * 4 + 1024;

/** A kept vault's identity on the list: the hash of the entry as stored (a damaged entry has one too, so it can be deleted). */
export async function keptId(item: unknown): Promise<string> {
  return toB64(await sha256(utf8(canonicalJson(item ?? null))));
}

export class PrejoinWriter extends PrejoinRecord {
  /**
   * §3.5 ④, inside the join's transact (the caller holds the vault lock): `plain` under `cloudVk`, with its own vault id,
   * appended to the list. Every entry already there stays as it is: an earlier join's is never replaced, and a join can
   * always keep its own (a profile can join again after another join). One exception: this very join's own entry,
   * written by an attempt that died before its commit (the same cloud key, the same vault, the same plaintext), is not
   * written twice. Read back whole (after the join the new entry is the only complete copy of that vault, and the earlier
   * ones must have come through the write unchanged): anything else fails the join.
   */
  async writeInLock(cloudVk: Vk, plain: Uint8Array, vaultId: string, at: number): Promise<void> {
    const items = (await this.items()) ?? [];
    for (const p of items.map(parsePrejoin)) {
      if (p === "damaged" || p.envelope.vkId !== cloudVk.id || p.envelope.vaultId !== vaultId) continue;
      const there = await decryptVault(p.envelope, cloudVk).catch(() => null);
      if (there && there.length === plain.length && there.every((b, i) => b === plain[i])) return;
    }
    const envelope = await encryptVault(plain, cloudVk, { vaultId, rev: 0 }, this.rng);
    const next = [...items, { v: 1, at, envelope } satisfies Prejoin];
    if (next.length > KEPT_MAX.entries || JSON.stringify({ v: 2, items: next }).length > KEPT_MAX.bytes)
      throw new ServiceError("kept_full");
    await this.kv.set({ [this.name]: { v: 2, items: next } });
    const back = await this.items();
    if (
      back === null ||
      back.length !== next.length ||
      !back.every((x, i) => canonicalJson(x) === canonicalJson(next[i]))
    )
      throw new StorageError("verify_failed", "sk_prejoin did not read back");
  }

  /** Whether one more entry of `plainLength` bytes fits on the list (the join's first step asks; writeInLock decides). */
  async fits(plainLength: number): Promise<boolean> {
    const items = (await this.items()) ?? [];
    return (
      items.length < KEPT_MAX.entries &&
      JSON.stringify({ v: 2, items }).length + entryBytes(plainLength) <= KEPT_MAX.bytes
    );
  }

  /**
   * The user's confirmed delete ("Advanced"): exactly the entries shown (`ids`, keptId), in one write under the vault
   * lock; refused (bad_state) when one of them is no longer there. Never automatic (§3.5 ④). Returns how many went.
   */
  async discard(ids: readonly string[]): Promise<number> {
    return this.lock(async () => {
      const items = (await this.items()) ?? [];
      const of = await Promise.all(items.map(keptId));
      if (ids.length === 0 || !ids.every((id) => of.includes(id)))
        throw new ServiceError("bad_state", "the kept vaults changed");
      const left = items.filter((_, i) => !ids.includes(of[i]!));
      if (left.length) await this.kv.set({ [this.name]: { v: 2, items: left } });
      else await this.kv.remove([this.name]);
      return items.length - left.length;
    });
  }
}
