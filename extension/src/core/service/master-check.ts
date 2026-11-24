// Whether a password is the vault's master password, checked without recording anything (OWNER-DECISIONS/26,
// 2026-11-24): an export confirmed with the PIN still refuses a selected-accounts file under the master password, whose
// readers would learn it, and verifyPassword would record each "no" as a wrong guess. Its spelling as the lock screens
// take it (openWithPassword: as typed, or a generated password's loose spelling).
import { CryptoError } from "../crypto/bytes";
import { openWithPassword } from "../crypto/keyring";
import type { VaultService } from "./service";

export async function isMasterPassword(s: VaultService, password: string): Promise<boolean> {
  if (!password) return false;
  const r = await s["store"].load();
  if (r.status !== "ok") return false;
  const keyring = r.gen.keyring;
  if (!keyring.wraps.some((w) => w.method === "password")) return false;
  try {
    return (await openWithPassword(keyring, password)).vk.id === keyring.vkId;
  } catch (e) {
    if (e instanceof CryptoError && e.code === "unwrap_failed") return false;
    throw e;
  }
}
