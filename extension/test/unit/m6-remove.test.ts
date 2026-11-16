// "Remove sync identity" from the panel, the way out that needs no network (SYNC-DESIGN §3.10 P5, §4.7): it demotes and
// never drops. Saves kept while they cannot be read stay; the accounts stay; the permission goes last. A save not yet
// folded because the page is locked refuses the removal (unlock first): then nothing is removed and the permission is not
// touched.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { SyncPanelCtl } from "../../src/options/sync/panel";
import { firstUpload } from "../../src/core/sync/engine/enroll";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { uploadEnvelope } from "../../src/core/sync/local/outbox";
import { writeProof } from "../../src/core/sync/crypto/subkeys";
import type { Vault } from "../../src/core/vault/model";
import { generateVk, type Vk } from "../../src/core/crypto/vk";
import { EMAIL, World } from "../helpers/m3-world";
import { kitOf, permissions, protectedProfile } from "../helpers/m6-kit";

async function orphanEntry(vault: Vault, vk: Vk, base: number, head: string): Promise<Record<string, unknown>> {
  const up = await uploadEnvelope(vault, vk, { vaultId: vault.vaultId, rev: base + 1 });
  const proof = await writeProof(vk, { vaultId: vault.vaultId, ifVersion: base, checksum: up.envelope.checksum });
  return {
    v: 1,
    base,
    head,
    from: { version: base, head, checksum: "planted" },
    checksum: `planted-${base}-${head}`,
    envelope: up.text,
    proof,
  };
}

async function syncedProfile() {
  const w = new World();
  const p = permissions(true);
  const { d, code } = await protectedProfile(w, "A", p, ["GitHub", "AWS"]);
  expect(
    (
      await firstUpload(d.engine, {
        session: await w.server.session(EMAIL),
        password: w.password,
        recoveryCode: code,
        deviceName: "A",
        email: EMAIL,
      })
    ).kind,
  ).toBe("done");
  expect((await d.engine.round()).status).toBe("ok");
  let vault: "unlocked" | "locked" = "unlocked";
  const ctl = new SyncPanelCtl(kitOf(d, p), {
    vault: () => vault,
    reload: async () => undefined,
    now: () => w.clock.now,
  });
  return {
    w,
    d,
    p,
    ctl,
    lock: async () => {
      await d.svc.lock();
      vault = "locked";
    },
  };
}

describe("Remove sync identity: demote, never drop", () => {
  it("parked saves stay after the removal; the accounts stay; the permission goes last", async () => {
    const { d, p, ctl } = await syncedProfile();
    const vk = await d.vk();
    // under a key this profile does not have (a newer VK, §4.7): it cannot be opened here, so it stays parked
    const other = await generateVk();
    const parked = {
      ...(await orphanEntry(await d.vault(vk), other, 1, "x")),
      parked: { reason: "key", vkId: other.id, at: 1 },
    };
    d.disk.kv.data.set(SYNC_KEYS.orphan, { v: 1, items: [parked] });
    await ctl.refresh();
    expect(ctl.state.facts!.parked).toMatchObject({ count: 1 });
    expect(await ctl.removeIdentity()).toBe(true);
    expect((await d.engine.view()).syncOn).toBe(false);
    expect((d.disk.kv.data.get(SYNC_KEYS.orphan) as { items: unknown[] } | undefined)?.items).toHaveLength(1);
    expect((await d.vault()).entries).toHaveLength(2);
    expect(p.log.at(-1)).toBe("remove");
  });

  it("locked with an unparked save: refused, nothing removed, the permission untouched", async () => {
    const { d, p, ctl, lock } = await syncedProfile();
    const vk = await d.vk();
    const open = await orphanEntry(await d.vault(vk), vk, 1, "y");
    d.disk.kv.data.set(SYNC_KEYS.orphan, { v: 1, items: [open] });
    await lock();
    await ctl.refresh();
    expect(await ctl.removeIdentity()).toBe(false);
    expect(ctl.state.failure).toMatchObject({ code: "locked" });
    expect((await d.engine.view()).syncOn).toBe(true);
    expect((d.disk.kv.data.get(SYNC_KEYS.orphan) as { items: unknown[] }).items).toHaveLength(1);
    expect(p.log).not.toContain("remove");
    expect(p.granted).toBe(true);
  });
});
