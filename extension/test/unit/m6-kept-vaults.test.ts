// The vaults a profile kept from before its joins (sk_prejoin's list, SYNC-DESIGN §3.5 ④; core/sync/local/records.ts,
// record-writers.ts), as the Sync section shows and deletes them, and as the permanent delete of an account scrubs them:
//   - listed as stored, never opened by the page; an entry that can't be read is listed too;
//   - deleted only by the user's confirmed delete, exactly the entries shown; a list that changed meanwhile is not touched;
//   - "delete forever" takes the erased accounts out of every kept vault it can open (by the account's identity, as in
//     another vault's copies), and keeps what it cannot open as it is (only the user's confirmed delete removes one).
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { decryptVault, encryptVault, type EncryptedVault } from "../../src/core/crypto/envelope";
import { generateVk } from "../../src/core/crypto/vk";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { aliveEntries } from "../../src/core/vault/model";
import { deserializeVault, serializeVault } from "../../src/core/vault/validate";
import { readFacts } from "../../src/options/sync/gateway";
import { SyncPanelCtl } from "../../src/options/sync/panel";
import { keptVaultCount, type Runtime } from "../../src/platform/runtime";
import { worldOf, type Device } from "../helpers/m3-world";
import { kitOf, permissions } from "../helpers/m6-kit";

type Item = { v: 1; at: number; envelope: EncryptedVault };
const list = (a: Device) => a.disk.kv.data.get(SYNC_KEYS.prejoin) as { v: 2; items: unknown[] } | undefined;

/** A vault kept from before a join: this profile's accounts as they are now, under another vault id, under `vk`. */
async function keptCopy(
  a: Device,
  at: number,
  vk = undefined as Awaited<ReturnType<Device["vk"]>> | undefined,
): Promise<Item> {
  const v = { ...(await a.vault()), vaultId: `kept-vault-${String(at).padStart(5, "0")}` };
  const key = vk ?? (await a.vk());
  return { v: 1, at, envelope: await encryptVault(serializeVault(v), key, { vaultId: v.vaultId, rev: 0 }) };
}

describe("the vaults kept from before a join", () => {
  it("listed as stored; deleted only as shown, by the confirmed delete, on an unlocked page; a changed list is not touched", async () => {
    const w = await worldOf(1);
    const [a] = w.devices as [Device];
    const kit = kitOf(a, permissions(true));
    a.disk.kv.data.set(SYNC_KEYS.prejoin, { v: 2, items: [await keptCopy(a, 1000), "not a kept vault"] });
    const f = await readFacts(kit);
    expect(f.kept.map((k) => k.at)).toEqual([1000, null]);
    const ctl = new SyncPanelCtl(kit, {
      vault: () => "unlocked",
      reload: async () => undefined,
      now: () => w.clock.now,
    });
    await ctl.refresh();
    // not on a locked page
    const locked = new SyncPanelCtl(kit, {
      vault: () => "locked",
      reload: async () => undefined,
      now: () => w.clock.now,
    });
    await locked.refresh();
    await locked.discardKept(f.kept, w.password);
    expect(locked.state.failure).toEqual({ code: "locked" });
    // it cannot be undone: the master password first; a wrong one deletes nothing (QUICK-PIN-NOTES, the owner's rule)
    await ctl.discardKept(f.kept, "not the master password");
    expect(ctl.state.failure).toMatchObject({ code: "wrong_secret" });
    expect(list(a)!.items).toHaveLength(2);
    expect(list(a)!.items).toHaveLength(2);
    // another page's join adds one meanwhile: what was shown is not what is there; nothing deleted
    const third = await keptCopy(a, 3000);
    a.disk.kv.data.set(SYNC_KEYS.prejoin, { v: 2, items: [...list(a)!.items, third] });
    await ctl.discardKept(f.kept.slice(0, 1).concat([{ id: "gone", at: null }]), w.password);
    expect(ctl.state.failure).toMatchObject({ code: "bad_state" });
    expect(list(a)!.items).toHaveLength(3);
    // the two shown, deleted; the one that came since stays
    await ctl.discardKept(f.kept, w.password);
    expect(ctl.state.done).toBe("syncDoneKeptDeleted");
    expect(list(a)!.items).toEqual([third]);
    await ctl.discardKept((await readFacts(kit)).kept, w.password);
    expect(list(a)).toBeUndefined();
  });

  it("delete forever scrubs every kept vault it can open, by the account's identity, and keeps what it cannot open as it is", async () => {
    const w = await worldOf(1);
    const [a] = w.devices as [Device];
    await a.add("Secret");
    const opened = await keptCopy(a, 1000); // holds GitHub, AWS and Secret
    const stranger = await keptCopy(a, 2000, await generateVk()); // under a key this profile does not hold
    a.disk.kv.data.set(SYNC_KEYS.prejoin, { v: 2, items: [opened, stranger, "damaged"] });
    const secret = aliveEntries(await a.vault()).find((e) => e.issuer === "Secret")!;
    expect(await a.svc.purgeForever([secret.id], w.password)).toEqual({ keptUnchecked: 2 }); // said at that moment (the trash's line)
    expect(aliveEntries(await a.vault()).map((e) => e.issuer)).not.toContain("Secret");
    const left = list(a)!.items as Item[];
    expect(left).toHaveLength(3);
    expect(left[1]).toEqual(stranger); // under a key this profile does not hold: kept, byte for byte
    expect(left[2]).toBe("damaged");
    expect(left[0]!.envelope.vaultId).toBe(opened.envelope.vaultId);
    const kept = deserializeVault(await decryptVault(left[0]!.envelope, await a.vk()));
    expect(kept.vaultId).toBe(opened.envelope.vaultId);
    expect(
      aliveEntries(kept)
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(
      aliveEntries(deserializeVault(await decryptVault(opened.envelope, await a.vk())))
        .map((e) => e.issuer)
        .filter((x) => x !== "Secret")
        .sort(),
    );
    expect(JSON.stringify(kept)).not.toContain(secret.secret);
  });

  it("delete forever with nothing it can open writes nothing: the record stays as it was", async () => {
    const w = await worldOf(1);
    const [a] = w.devices as [Device];
    const stored = { v: 1, at: 1, envelope: (await keptCopy(a, 1000, await generateVk())).envelope };
    a.disk.kv.data.set(SYNC_KEYS.prejoin, structuredClone(stored));
    const gh = aliveEntries(await a.vault())[0]!;
    expect(await a.svc.purgeForever([gh.id], w.password)).toEqual({ keptUnchecked: 1 });
    expect(a.disk.kv.data.get(SYNC_KEYS.prejoin)).toEqual(stored);
  });

  it("start over's box counts them (it leaves them): one read, none when there are none", async () => {
    const w = await worldOf(1);
    const [a] = w.devices as [Device];
    const rt = { local: a.disk.kv } as unknown as Runtime;
    expect(await keptVaultCount(rt)).toBe(0);
    a.disk.kv.data.set(SYNC_KEYS.prejoin, { v: 2, items: ["one", "two"] });
    expect(await keptVaultCount(rt)).toBe(2);
    a.disk.kv.data.set(SYNC_KEYS.prejoin, { v: 1, at: 1, envelope: {} }); // a single record from before the list
    expect(await keptVaultCount(rt)).toBe(1);
  });
});
