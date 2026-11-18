// The independent review's probes (HYPHEN review), adopted: each one is aimed at a mutant the first suite let survive
// (named in the test). P4 is the subset export's guard after its fix (B1; password-entry-samepw.test.ts has the rest).
// (P5, step 4 (b) of turning sync on, and P6, the sync engine's key operations, went with the server sync's client:
// OWNER-DECISIONS/25, DV-0b.)
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackup, openBackup } from "../../src/core/backup/backup";
import { CryptoError } from "../../src/core/crypto/bytes";
import * as kdf from "../../src/core/crypto/kdf";
import { createKeyring, openWithPassword, setPassword } from "../../src/core/crypto/keyring";
import { formatFor } from "../../src/core/service/pw-format";
import { createRuntime } from "../../src/platform/runtime";
import { sameMasterPassword } from "../../src/options/Backup";
import { measure } from "../../src/ui/strength";
import { emptyVault } from "../../src/core/vault/model";
import { createProtected } from "../helpers/vaults";

const GEN = "JDXT-NBSG-6JQG-XBTV";
const LOOSE = "jdxt nbsg 6jqg xbtv";
afterEach(() => vi.restoreAllMocks());

/** A chrome.storage-like area over a Map (as password-entry-service.test.ts uses). */
function area() {
  const data = new Map<string, unknown>();
  return {
    async get(keys?: string | string[] | null) {
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(ks.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  } as unknown as chrome.storage.StorageArea;
}
/** The real runtime (service with its security log) over fresh storage, with a vault protected by GEN. */
async function runtimeWith(pw: string) {
  const rt = createRuntime({ local: area(), session: area(), mirror: null });
  await createProtected(rt.service, pw);
  const failures = async () => (await rt.security.read()).entries.filter((e) => e.kind === "unlock_failed").length;
  return { rt, failures };
}
const derivations = () => vi.spyOn(kdf, "deriveKekFromPassword");

describe("P1 openWithPassword: only a wrong key moves on to the second spelling (mutant R1: advance on any error)", () => {
  it("a derivation that fails for another reason is thrown at once, with its own code, after one derivation", async () => {
    const { keyring, vk } = await createKeyring();
    const kr = await setPassword(keyring, vk, GEN);
    const spy = derivations().mockRejectedValueOnce(new CryptoError("invalid_kdf_params", "simulated"));
    await expect(openWithPassword(kr, LOOSE)).rejects.toMatchObject({ code: "invalid_kdf_params" });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("P2 the hint's version is checked (mutant R2: formatFor ignores v)", () => {
  it("a record of another version is no hint, even for this very wrap and a known format", async () => {
    const { keyring, vk } = await createKeyring();
    const kr = await setPassword(keyring, vk, GEN);
    const salt = kr.wraps.find((w) => w.method === "password")!.kdf!.salt;
    expect(formatFor({ v: 1, format: "gen16-v1", salt }, kr)).toBe("gen16-v1");
    for (const v of [0, 2, "1", null, undefined])
      expect(formatFor({ v, format: "gen16-v1", salt }, kr), String(v)).toBeNull();
  });
});

describe("P3 a backup file's password typed exactly costs one derivation (mutant R3: no break after success)", () => {
  it("a file password of the user's own that has a generated shape opens as typed, without a second derivation", async () => {
    const own = "supersecretpassw"; // the 16-symbol shape, but the user's own spelling: it has a second candidate
    const file = await createBackup(emptyVault("vault-id-0123456789"), own);
    const spy = derivations();
    expect((await openBackup(file, own)).vault.vaultId).toBe("vault-id-0123456789");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("P4 the subset export's 'not the master password' guard takes every spelling the prompts take (B1)", () => {
  it("a loose spelling of the master password opens the vault, so the guard refuses it as the file's password", async () => {
    const { rt } = await runtimeWith(GEN);
    // The export's master field (grouped boxes) yields GEN; the file password is typed from memory, loosely.
    for (const subPw of [LOOSE, "jdxtnbsg6jqgxbtv", "JDXTNBSG6JQGXBTV"]) {
      expect((await measure(subPw)).ok, subPw).toBe(true); // the page's 50-bit rule does not stop it...
      await expect(rt.service.verifyPassword(subPw)).resolves.toBeUndefined(); // ...it opens the vault...
      expect(sameMasterPassword(subPw, GEN), subPw).toBe(true); // ...so the guard does
    }
  });
});
