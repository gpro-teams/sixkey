// sk_prf, the device unlock's record (QUICK-UNLOCK §5.2, §5.9; the record itself: src/core/crypto/prf-record.ts), as
// every context's runtime holds it: one read, and the key change's step. Its other writes (the enrolment, the removal,
// "turn back on", the session method, the master password's time, a new vault's removal of another vault's record) are
// prf-write.ts's, a lazy module that writes through this store's own KV and lock, so the popup's counted bundle carries
// none of them (docs/design/notes/PRF-NOTES.md §9). Each write is one critical section under the vault lock
// (webLock("sixkey-vault"), the store's own, as service-core.ts's VkRecord contract asks), and nothing inside it calls the
// store or the service.
//   - reencrypt (the VkRecord contract): a PRF wrap cannot be moved to a new key without the authenticator, so every wrap
//     under another key than `current` is set to null (the credential stays; "turn back on" asks for one touch:
//     YUBIKEY-DESIGN D13), and the old key's wrap leaves the record. A record for another vault, or one not even shaped like
//     one, is removed: it holds no vault data, and a passkey can be added again. Gate credentials hold no key material:
//     kept, their MAC as it is: made under the old key, it no longer counts (prf-record.ts gateCreds), so the gate is
//     paused until it is turned back on, as a PRF credential is. With no record it reads nothing more (the
//     degraded-mirror unlock's read budget).
// Not vault data (store.ts hasAnyData), never mirrored, synced, backed up or exported; turning sync off keeps it.
import { parsePrfRecord, type PrfCred, type PrfRecord } from "../crypto/prf-record";
import type { Vk } from "../crypto/vk";
import type { KV, Lock } from "../storage/kv";
import { activeKeyring } from "../sync/local/records";
import { LOCAL_ONLY_KEYS } from "../sync/local/keys";
import type { VkRecord, VkRecordResult } from "./service-core";

export const PRF_KEY = LOCAL_ONLY_KEYS.prf;

export class PrfStore implements VkRecord {
  readonly name = PRF_KEY;
  constructor(
    private readonly kv: KV,
    /** The store's own lock: webLock("sixkey-vault"). */
    private readonly lock: Lock,
  ) {}

  /** One read, no lock. A read that throws propagates. */
  async read(): Promise<PrfRecord | "damaged" | null> {
    return parsePrfRecord((await this.kv.get([PRF_KEY]))[PRF_KEY]);
  }

  /** The VkRecord contract (service-core.ts). No record: "absent", and the keyring is not read. */
  reencrypt(current: Vk): Promise<VkRecordResult> {
    return this.lock(async () => {
      const r = await this.read();
      if (r === null) return "absent";
      const kr = await activeKeyring(this.kv);
      if (kr.vkId !== current.id) return "superseded"; // a newer key change's own cleanup sees to it
      if (r === "damaged" || r.vaultId !== kr.vaultId) {
        await this.kv.remove([PRF_KEY]);
        return "unopenable";
      }
      const stale = (c: PrfCred) => c?.mode === "prf" && c.wrap != null && c.wrap.vkId !== current.id;
      if (!r.creds.some(stale)) return "current";
      await this.kv.set({ [PRF_KEY]: { ...r, creds: r.creds.map((c) => (stale(c) ? { ...c, wrap: null } : c)) } });
      return "rewritten";
    });
  }
}
