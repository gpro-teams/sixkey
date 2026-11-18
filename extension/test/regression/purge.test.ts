// Review: PRIVACY.md: '"Delete forever" in the trash erases an account's details.'
import { describe, expect, it } from "vitest";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { KEYS } from "../../src/core/storage/format";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession } from "../../src/core/service/types";
import { addEntry, deleteEntry, editEntry } from "../../src/core/vault/ops";
import { decryptVault } from "../../src/core/crypto/envelope";
import { unlockWithPassword } from "../../src/core/crypto/keyring";
import { deserializeVault } from "../../src/core/vault/validate";
import { createProtected, STRONG } from "../helpers/vaults";

describe("Delete forever", () => {
  it("leaves no readable copy of the secret in the extension's own storage", async () => {
    const kv = new MemoryKV();
    const mirror = new MemoryKV();
    const t = { now: 1_760_000_000_000 };
    const store = new VaultStore({ lock: createMutex(), kv, mirror, now: () => t.now });
    const svc = new VaultService({
      store,
      session: new MemorySession(),
      settings: new KvSettingsStore(kv),
      now: () => t.now,
    });
    await createProtected(svc);
    await svc.mutate(
      (v, c) =>
        addEntry(
          v,
          {
            type: "totp",
            issuer: "Bank",
            label: "me",
            secret: "MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U",
            algorithm: "SHA1",
            digits: 6,
            period: 30,
            domains: ["bank.example"],
            note: "Shop A",
          },
          c,
        ).vault,
    );
    await store.ensureDailySnapshot(); // any service-worker wake-up
    const id = (await svc.read()).vault.entries[0]!.id;
    await svc.mutate((v, c) => editEntry(v, id, { autofill: ["login.bank.example"] }, c));
    await svc.mutate((v, c) => deleteEntry(v, id, c));
    await svc.purgeForever([id], STRONG); // options page > Trash > Delete forever, with the master password

    const vk = await unlockWithPassword((await svc.currentGeneration())!.keyring, STRONG);
    const readable: string[] = [];
    for (const [name, m] of [
      ["local", kv],
      ["mirror", mirror],
    ] as const) {
      for (const [k, v] of m.data) {
        const env = (v as any)?.envelope;
        if (!env) continue;
        try {
          const vault = deserializeVault(await decryptVault(env, vk));
          if (vault.entries.some((e) => e.secret === "MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U")) readable.push(`${name}:${k}`);
          // and none of its details: its sites, its note, the sites turned on for it (0.1.1)
          if (vault.entries.some((e) => e.domains || e.note || e.autofill)) readable.push(`${name}:${k} (details)`);
        } catch {
          /* other key */
        }
      }
    }
    expect(readable).toEqual([]);
    void KEYS;
  });
});
