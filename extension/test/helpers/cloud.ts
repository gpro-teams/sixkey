// Vaults and generations for the cloud backup's tests (CLOUDBK): a protected keyring as first run makes one (the master
// password and the recovery key, no device key), at the test count of PBKDF2 (helpers/kdf.ts), and generations sealed
// under it.
import { encryptVault } from "../../src/core/crypto/envelope";
import { createKeyring, enableMasterPassword, type Keyring } from "../../src/core/crypto/keyring";
import type { Vk } from "../../src/core/crypto/vk";
import type { CloudBackup } from "../../src/core/cloud/format";
import type { CloudCandidate } from "../../src/core/cloud/restore";
import type { Generation } from "../../src/core/storage/format";
import { createClock, type Clock } from "../../src/core/vault/hlc";
import { emptyVault, type Vault } from "../../src/core/vault/model";
import { addEntry, type NewEntry } from "../../src/core/vault/ops";
import { serializeVault } from "../../src/core/vault/validate";
import { TEST_KDF_ITERATIONS } from "./kdf";

export const PASSWORD = "harbor-violet-cinder-29";
export const T0 = 1_900_000_000_000;

export type Keys = { keyring: Keyring; vk: Vk; recoveryCode: string };

/** A keyring with the master password and the recovery key, as first run makes it. One PBKDF2 derivation. */
export async function protectedKeys(password = PASSWORD): Promise<Keys> {
  const { keyring, vk } = await createKeyring();
  const p = await enableMasterPassword(keyring, vk, password, { iterations: TEST_KDF_ITERATIONS });
  return { keyring: p.keyring, vk, recoveryCode: p.recoveryCode };
}

export const account = (issuer: string, secret: string): NewEntry => ({
  type: "totp",
  issuer,
  label: `${issuer.toLowerCase()}@example.com`,
  secret,
  algorithm: "SHA1",
  digits: 6,
  period: 30,
});

/** A vault of these accounts, stamped by `clock`. */
export function vaultOf(
  vaultId: string,
  accounts: NewEntry[],
  clock: Clock = createClock("cloudaaa", { now: () => T0 }),
) {
  let v: Vault = emptyVault(vaultId);
  for (const a of accounts) v = addEntry(v, a, clock).vault;
  return v;
}

/** `vault` sealed under `keys` as one generation. */
export async function seal(keys: Keys, vault: Vault, seq = 1, savedAt = T0): Promise<Generation> {
  const envelope = await encryptVault(serializeVault(vault), keys.vk, { vaultId: keys.keyring.vaultId, rev: seq });
  return { v: 1, seq, savedAt, envelope, keyring: keys.keyring };
}

/** A parsed file as a restore lists it. */
export const candidate = (id: string, backup: CloudBackup, modified = T0, head = `${id}-r1`): CloudCandidate => ({
  id,
  head,
  modified,
  backup,
});
