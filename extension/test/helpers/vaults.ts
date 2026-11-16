// Ways to get a vault in a test (PHASE0X-PLAN A1, appendix A). A new vault always has a master password (H1), so a
// test that needs one goes through prepareKeys + create like the first-run page does. The Phase 0 device-key vault can
// no longer be made through the service; it still exists on users' disks, so the upgrade path (enableMasterPassword)
// and its warnings are tested on one written here directly.
import { encryptVault, type EncryptedVault } from "../../src/core/crypto/envelope";
import { createKeyring, type Keyring } from "../../src/core/crypto/keyring";
import type { Vk } from "../../src/core/crypto/vk";
import type { CodeDelivery, VaultService } from "../../src/core/service/service";
import type { Generation } from "../../src/core/storage/format";
import type { VaultStore } from "../../src/core/storage/store";
import { createClock } from "../../src/core/vault/hlc";
import { emptyVault, type Vault } from "../../src/core/vault/model";
import { addEntry, type NewEntry } from "../../src/core/vault/ops";
import { serializeVault } from "../../src/core/vault/validate";

export const STRONG = "tulip-orbit-lantern-84";

/** A new vault through the service, exactly as the first-run page makes one. Unlocked afterwards. */
export async function createProtected(svc: VaultService, pw = STRONG): Promise<{ recoveryCode: string }> {
  const keys = await svc.prepareKeys(pw);
  await svc.create(keys);
  return { recoveryCode: keys.recoveryCode };
}

/** onCode for a caller that does not show the new recovery code (it is a required parameter: A4R-5). */
export const NO_PAGE: CodeDelivery = Object.freeze({ onCode: () => undefined });

/** Run an operation that makes a recovery code, and return the code it delivered through onCode, its only way out. */
export async function codeOf(op: (deliver: CodeDelivery) => Promise<unknown>): Promise<string> {
  let code: string | null = null;
  await op({
    onCode: (c) => {
      code = c;
    },
  });
  if (code === null) throw new Error("no recovery code was delivered");
  return code;
}

/**
 * Forgot the password, as the settings page does it (A4R-1): prepareReset, then commitReset, which "Continue" after "I
 * have saved my recovery code" calls. Records recovery_used at the first step and password_reset at the second. The new code.
 */
export async function resetWithCode(svc: VaultService, code: string, password: string): Promise<string> {
  const prepared = await svc.prepareReset(code, password);
  await svc.commitReset(prepared);
  return prepared.recoveryCode;
}

/** A device-key vault holding `entries`, sealed as Phase 0 sealed it. Test-only: shipped code can no longer make one. */
export async function legacyDeviceVaultData(
  entries: NewEntry[] = [],
  now = 1_700_000_000_000,
): Promise<{ keyring: Keyring; vk: Vk; vault: Vault; envelope: EncryptedVault }> {
  const { keyring, vk } = await createKeyring();
  const clock = createClock("aaaa", { now: () => now });
  let vault = emptyVault(keyring.vaultId);
  for (const e of entries) vault = addEntry(vault, e, clock).vault;
  const envelope = await encryptVault(serializeVault(vault), vk, { vaultId: keyring.vaultId, rev: 0 });
  return { keyring, vk, vault, envelope };
}

/** Write a legacy device-key vault through the store (both slots' rules, snapshot, keyring copy, mirror), as Phase 0 did. */
export async function legacyDeviceVault(
  store: VaultStore,
  entries: NewEntry[] = [],
): Promise<{ keyring: Keyring; vk: Vk }> {
  const { keyring, vk, envelope } = await legacyDeviceVaultData(entries);
  await store.transact(async (cur) => {
    if (cur) throw new Error("legacyDeviceVault: a vault already exists");
    return { envelope, keyring };
  });
  return { keyring, vk };
}

/** The same vault as one generation, for a test that writes it into a browser profile's chrome.storage.local itself. */
export async function legacyDeviceGeneration(entries: NewEntry[] = [], now = Date.now()): Promise<Generation> {
  const { keyring, envelope } = await legacyDeviceVaultData(entries, now);
  return { v: 1, seq: 1, savedAt: now, envelope, keyring };
}

/** Every value in a KV, as JSON, for "this text appears nowhere in storage" checks. */
export const allStored = (m: { data: Map<string, unknown> }) => JSON.stringify([...m.data.entries()]);

/** Device-key material in a store: the key itself, or a wrap made with it. Empty means none. */
export function deviceMaterial(...stores: { data: Map<string, unknown> }[]): string[] {
  const found: string[] = [];
  for (const m of stores) {
    for (const [k, v] of m.data) {
      const s = JSON.stringify(v) ?? "";
      if (s.includes('"deviceKey"')) found.push(`${k}: deviceKey`);
      if (s.includes('"method":"device"')) found.push(`${k}: device wrap`);
    }
  }
  return found;
}
