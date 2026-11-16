// Regression: what the write path accepts must be what the read path loads, or a save looks like corruption and is rolled back.
import { describe, expect, it } from "vitest";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession } from "../../src/core/service/types";
import { applyImport, planImport } from "../../src/core/import/importer";
import { aliveEntries } from "../../src/core/vault/model";
import { createProtected } from "../helpers/vaults";

function setup() {
  const kv = new MemoryKV();
  const mirror = new MemoryKV();
  const session = new MemorySession();
  const t = { now: 1_700_000_000_000 };
  const settings = new KvSettingsStore(kv);
  const make = () =>
    new VaultService({
      store: new VaultStore({ lock: createMutex(), kv, mirror, now: () => t.now }),
      session,
      settings,
      now: () => t.now,
    });
  return { kv, mirror, session, settings, t, svc: make(), fresh: make };
}

describe("importing accounts the vault could not load back", () => {
  it("a link with a 300-character label is reported as skipped; the rest are added and stay", async () => {
    const w = setup();
    await createProtected(w.svc);
    const text = [
      "otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
      "otpauth://totp/AWS:root?secret=GEZDGNBVGY3TQOJQ&issuer=AWS",
      `otpauth://totp/Corp:${"x".repeat(300)}?secret=MFRGGZDFMZTWQ2LK&issuer=Corp`,
    ].join("\n");
    const { plan } = planImport(text, []);
    expect(plan.add.map((p) => p.issuer)).toEqual(["GitHub", "AWS"]);
    expect(plan.failed).toEqual([{ index: 2, reason: "too_long" }]);

    await w.svc.mutate((v, c) => applyImport(v, plan.add, c));
    const r = await w.fresh().read();
    expect(aliveEntries(r.vault).map((e) => e.issuer)).toEqual(["GitHub", "AWS"]);
    expect(r.recovered).toBeUndefined();
  });

  it("an oversize issuer from any other path is refused at save time, with nothing written", async () => {
    const w = setup();
    await createProtected(w.svc);
    const before = (await w.svc.currentGeneration())!.seq;
    const { plan } = planImport(`otpauth://totp/${"I".repeat(257)}:bob?secret=JBSWY3DPEHPK3PXP`, []);
    expect(plan.add).toHaveLength(0);
    // bypassing the importer entirely: the service still refuses to save what it could not read back
    await expect(
      w.svc.mutate((v, c) =>
        applyImport(
          v,
          [
            {
              type: "totp",
              issuer: "I".repeat(257),
              label: "bob",
              secret: "JBSWY3DPEHPK3PXP",
              algorithm: "SHA1",
              digits: 6,
              period: 30,
            },
          ],
          c,
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_vault" });
    expect((await w.svc.currentGeneration())!.seq).toBe(before);
    expect(aliveEntries((await w.fresh().read()).vault)).toHaveLength(0);
  });
});
