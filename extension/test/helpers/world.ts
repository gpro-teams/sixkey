import { utf8 } from "../../src/core/crypto/bytes";
import { encryptVault, type EncryptedVault } from "../../src/core/crypto/envelope";
import { createKeyring, type Keyring } from "../../src/core/crypto/keyring";
import type { Vk } from "../../src/core/crypto/vk";
import { createClock } from "../../src/core/vault/hlc";
import { emptyVault } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { serializeVault } from "../../src/core/vault/validate";

/** One vault and keyring, plus a way to mint distinguishable saved states: state(n) contains n entries. */
export async function makeWorld() {
  const { keyring, vk } = await createKeyring();
  const clock = createClock("aaaa", { now: () => 1_700_000_000_000 });
  const states = new Map<number, EncryptedVault>();
  async function state(n: number): Promise<EncryptedVault> {
    const hit = states.get(n);
    if (hit) return hit;
    let v = emptyVault(keyring.vaultId);
    for (let i = 0; i < n; i++) {
      v = addEntry(
        v,
        {
          type: "totp",
          issuer: `Issuer${i}`,
          label: "a",
          secret: "JBSWY3DPEHPK3PXP",
          algorithm: "SHA1",
          digits: 6,
          period: 30,
        },
        clock,
        { id: `entry-${String(i).padStart(7, "0")}` },
      ).vault;
    }
    const env = await encryptVault(serializeVault(v), vk, { vaultId: keyring.vaultId, rev: n });
    states.set(n, env);
    return env;
  }
  return { keyring, vk, state };
}
export type World = Awaited<ReturnType<typeof makeWorld>>;
export type { Keyring, Vk };
