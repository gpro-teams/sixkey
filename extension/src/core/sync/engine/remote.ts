// Accepting remote data (SYNC-DESIGN §4.3: bad data never overwrites good data). The head envelope's text is checked
// without a key (shape, checksum), then for this vault and this device's current key (R5: a version under a previous
// key is never merged automatically; only "find accounts" opens one, by the user's choice), then decrypted (the rev is
// in the AAD) and parsed. A newer schema stops everything (paused_newer, R1/R6); any other failure walks the history
// back (F6a) to the newest version the current key opens, and stops at a newer schema on the way: it never skips one to
// merge an older version and upload it over the head.
import { decryptVault, isEnvelopeIntact, validateEnvelope } from "../../crypto/envelope";
import type { Vk } from "../../crypto/vk";
import type { Vault } from "../../vault/model";
import { VaultError, deserializeVault } from "../../vault/validate";
import { ApiError, type DeviceSigner, type SyncApi } from "./api";

export type Opened =
  | { kind: "ok"; vault: Vault; rev: number }
  | { kind: "newer_schema" }
  | { kind: "wrong_vault" } // §3.5: another vault id (different_vault)
  | { kind: "other_key"; vkId: string } // under a key other than the current one (R5)
  | { kind: "unreadable" }; // not an envelope, a bad checksum, does not decrypt, or not a vault

/** The envelope text `text` as remote data for the vault `vaultId` under the current key `vk`. */
export async function openRemote(text: string, vk: Vk, vaultId: string): Promise<Opened> {
  let env;
  try {
    env = validateEnvelope(JSON.parse(text));
    if (!(await isEnvelopeIntact(env))) return { kind: "unreadable" };
  } catch {
    return { kind: "unreadable" };
  }
  if (env.vaultId !== vaultId) return { kind: "wrong_vault" };
  if (env.vkId !== vk.id) return { kind: "other_key", vkId: env.vkId };
  let plain: Uint8Array;
  try {
    plain = await decryptVault(env, vk);
  } catch {
    return { kind: "unreadable" };
  }
  try {
    const vault = deserializeVault(plain);
    return vault.vaultId === vaultId ? { kind: "ok", vault, rev: env.rev } : { kind: "wrong_vault" };
  } catch (e) {
    return e instanceof VaultError && e.code === "newer_schema" ? { kind: "newer_schema" } : { kind: "unreadable" };
  } finally {
    plain.fill(0);
  }
}

/** The vault id an envelope's header names, readable without any key; null when the text is no envelope (damaged). */
export function envelopeVaultId(text: string): string | null {
  try {
    return validateEnvelope(JSON.parse(text)).vaultId;
  } catch {
    return null;
  }
}

export type Walked =
  { kind: "ok"; vault: Vault; version: number } | { kind: "newer_schema"; version: number } | { kind: "none" };

/**
 * F6a: the history, newest first below the head, until a version the current key opens (`ok`) or one of a newer schema
 * (`newer_schema`: stop, R6). Versions under another key are passed over (R5); unreadable ones too.
 */
export async function walkHistory(
  api: SyncApi,
  signer: DeviceSigner,
  headVersion: number,
  vk: Vk,
  vaultId: string,
): Promise<Walked> {
  const list = (await api.versions(signer))
    .filter((v) => v.version < headVersion)
    .sort((x, y) => y.version - x.version);
  for (const v of list) {
    if (v.vk_id !== vk.id) continue;
    let r: Awaited<ReturnType<SyncApi["version"]>>;
    try {
      r = await api.version(signer, v.version);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) continue; // pruned between the list and the fetch (M4 prunes in PUT): skip it
      throw e;
    }
    if (r.version !== v.version) continue;
    const o = await openRemote(r.envelope, vk, vaultId);
    if (o.kind === "ok") return { kind: "ok", vault: o.vault, version: v.version };
    if (o.kind === "newer_schema") return { kind: "newer_schema", version: v.version };
  }
  return { kind: "none" };
}
