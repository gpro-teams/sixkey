// Real Phase 0 keyrings for the M1 crypto-layer tests, built once per test file (each PBKDF2 at 600k costs ~0.1 s).
import { createKeyring, enableMasterPassword, rekey, setPassword, type Keyring } from "../../src/core/crypto/keyring";
import type { Vk } from "../../src/core/crypto/vk";
import { newBundleAuth, sealBundle, type BundleAuth, type KeyBundle } from "../../src/core/sync/crypto/keybundle";

export const HOUR = 3_600_000;
export const T0 = 1792051200000; // a whole UTC hour
export const ctx = { now: () => T0, vaultId: "test-vault-0001" };
export const P = "model password one 1!";
export const P2 = "model password two 2!";
export const DEV = "qqqqqqqqqqqqqqqqqqqqqg";

export type Fixture = {
  k1: Keyring;
  v1: Vk;
  code1: string; // VK1, password P
  k1b: Keyring; // VK1, password P2 (changed on another device)
  k2: Keyring;
  v2: Vk;
  code2: string; // VK2 = rotation of VK1 with P, previous [VK1]
};

let built: Promise<Fixture> | null = null;
export function keyrings(): Promise<Fixture> {
  built ??= (async () => {
    const fresh = await createKeyring(ctx);
    const on = await enableMasterPassword(fresh.keyring, fresh.vk, P, ctx);
    const k1b = await setPassword(on.keyring, fresh.vk, P2, ctx);
    const r = await rekey(on.keyring, fresh.vk, P, ctx);
    return {
      k1: on.keyring,
      v1: fresh.vk,
      code1: on.recoveryCode,
      k1b,
      k2: r.keyring,
      v2: r.vk,
      code2: r.recoveryCode,
    };
  })();
  return built;
}

export const pwSalt = (kr: Keyring): string => kr.wraps.find((w) => w.method === "password")!.kdf!.salt;

/** One auth per password wrap, as honest publishers produce them (P4: auth changes exactly with the password wrap). */
const auths = new Map<string, BundleAuth>();
export function authFor(kr: Keyring): BundleAuth {
  const salt = pwSalt(kr);
  if (!auths.has(salt)) auths.set(salt, newBundleAuth(salt));
  return auths.get(salt)!;
}

export async function sealedOf(
  vk: Vk,
  keyring: Keyring,
  kver: number,
  auth = authFor(keyring),
): Promise<{ bundle: KeyBundle; raw: string }> {
  return sealBundle(vk, { vaultId: keyring.vaultId, kver, keyring, auth, by: DEV, now: T0 + 5 * HOUR + 123 });
}

export async function bundleOf(vk: Vk, keyring: Keyring, kver: number, auth = authFor(keyring)): Promise<KeyBundle> {
  return (await sealedOf(vk, keyring, kver, auth)).bundle;
}

export const VAULT = ctx.vaultId;
