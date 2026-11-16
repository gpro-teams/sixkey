// The fourth M3 review: killers for the review's surviving mutants that are real test gaps (M3-R4-REVIEW,
// "Mutants"; that report was not retained, its findings are in docs/design/notes/M3-NOTES.md §0a). Each passes on the patch and fails on its mutant.
import { describe, expect, it } from "vitest";
import { generateVk, type Vk } from "../../src/core/crypto/vk";
import { encryptVault } from "../../src/core/crypto/envelope";
import { utf8 } from "../../src/core/crypto/bytes";
import { MemoryKV } from "../../src/core/storage/kv";
import type { Generation } from "../../src/core/storage/format";
import { writeProof } from "../../src/core/sync/crypto/subkeys";
import { foldParkedLocally, parkedSummary } from "../../src/core/sync/engine/orphans";
import { turnSyncOff } from "../../src/core/sync/engine/keys";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { createOutboxWriter, parseOrphanItem, uploadEnvelope } from "../../src/core/sync/local/outbox";
import { lastSyncedOf } from "../../src/core/sync/local/state";
import { createClock } from "../../src/core/vault/hlc";
import { emptyVault, type Vault } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { serializeVault } from "../../src/core/vault/validate";
import { input } from "../helpers/m2-world";
import { bulkEntries, worldOf, type Device } from "../helpers/m3-world";

const entries = (d: Device): Record<string, unknown>[] =>
  (d.disk.kv.data.get(SYNC_KEYS.orphan) as { items?: Record<string, unknown>[] } | undefined)?.items ?? [];
async function pushableOf(
  vault: Vault,
  vk: Vk,
  base: number,
  head: string,
  checksum: string,
): Promise<Record<string, unknown>> {
  const up = await uploadEnvelope(vault, vk, { vaultId: vault.vaultId, rev: base + 1 });
  const proof = await writeProof(vk, { vaultId: vault.vaultId, ifVersion: base, checksum: up.envelope.checksum });
  return { v: 1, base, head, from: { version: base, head, checksum: "planted" }, checksum, envelope: up.text, proof };
}

describe("M3-R4 review: killers", () => {
  it("RV4-07 killer (departure 6): with lastSynced set, a commit over MAX_ENVELOPE_BYTES leaves the pushable outbox there as it was", async () => {
    const kv = new MemoryKV();
    const vk = await generateVk();
    const before = {
      v: 1,
      base: 4,
      head: "h4",
      from: { version: 4, head: "h4", checksum: "c4" },
      checksum: "older",
      envelope: "{}",
      proof: "p",
    };
    kv.data.set(SYNC_KEYS.cfg, { v: 1 });
    kv.data.set(SYNC_KEYS.state, { v: 1, lastSynced: { version: 4, head: "h4", checksum: "c4" } });
    kv.data.set(SYNC_KEYS.outbox, before);
    const big: Vault = { ...emptyVault("vault-big1"), entries: bulkEntries(30_000, "big", 1_792_051_200_000) };
    const gen = { envelope: { vaultId: "vault-big1", checksum: "new" } } as unknown as Generation;
    await createOutboxWriter(kv)({ gen, vk, vault: big });
    expect(kv.data.get(SYNC_KEYS.outbox)).toEqual(before); // the older outbox (an ancestor) is still the one the worker may push
  }, 120_000);

  it("RV4-13 killer: a parked entry whose reason changes (a key brought by an adoption, then a newer schema behind it) gets the new reason", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    const vaultId = (await a.generation()).keyring.vaultId;
    const env = await encryptVault(utf8(JSON.stringify({ schemaVersion: 2, vaultId, entries: [] })), vk, {
      vaultId,
      rev: 9,
    });
    a.disk.kv.data.set(SYNC_KEYS.orphan, {
      v: 1,
      items: [
        {
          v: 1,
          from: null,
          checksum: "newer",
          envelope: JSON.stringify(env),
          parked: { reason: "key", vkId: "vk-gone", at: 1 },
        },
      ],
    });
    await a.engine.round();
    expect(entries(a)[0]!.parked).toMatchObject({ reason: "schema" }); // the UI's way out follows the reason (§6 O12)
  }, 60_000);

  it("RV4-14 killer: after a fold over the entry limit, no entry it tried is left unparked: lastSynced is set (sync is not held up)", async () => {
    const w = await worldOf(2, ["GitHub"], [], { validateWire: false });
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    const vaultId = (await a.generation()).keyring.vaultId;
    const mine = await a.vault(vk);
    const big: Vault = {
      ...mine,
      entries: [...mine.entries, ...bulkEntries(49_000, "imported", w.clock.now - 1000)].sort((x, y) =>
        x.id < y.id ? -1 : 1,
      ),
    };
    const env = await encryptVault(serializeVault(big), vk, { vaultId, rev: 99 });
    w.advance(1000);
    await a.svc.mutate((v) => ({
      ...v,
      entries: [...v.entries, ...bulkEntries(1500, "after", w.clock.now - 500, { device: "aftrrr" })].sort((x, y) =>
        x.id < y.id ? -1 : 1,
      ),
    }));
    // built on the vault before the local adds, so the two entries together stay under the limit (R4R-14 is the other case)
    const small = addEntry(mine, input("second entry"), createClock("eeee", { now: () => w.clock.now })).vault;
    a.disk.kv.data.set(SYNC_KEYS.orphan, {
      v: 1,
      items: [
        {
          v: 1,
          base: 98,
          head: "elsewhere",
          from: { version: 98, head: "elsewhere", checksum: "x" },
          checksum: "big",
          envelope: JSON.stringify(env),
          proof: "p",
        },
        await pushableOf(small, vk, 34, "nowhere", "small"),
      ],
    });
    const st = a.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>;
    a.disk.kv.data.set(SYNC_KEYS.state, { ...st, lastSynced: null });
    await a.engine.round();
    expect(entries(a).every((x) => x.parked)).toBe(true);
    expect(lastSyncedOf(a.disk.kv.data.get(SYNC_KEYS.state))).not.toBeNull();
  }, 240_000);

  it("RV4-19 killer: the parked notice counts parked entries only (the count 'Advanced' must be confirmed with)", () => {
    const rec = (checksum: string, parked?: unknown) =>
      parseOrphanItem({ v: 1, from: null, checksum, envelope: "{}", ...(parked ? { parked } : {}) })!;
    // (M3 revision 5 edit: the summary also lists the parked entries' checksums, which "Advanced" binds to, R4R-8)
    expect(parkedSummary([rec("a", { reason: "schema", vkId: null, at: 1 }), rec("b")])).toEqual({
      count: 1,
      reasons: ["schema"],
      checksums: ["a"],
    });
    expect(parkedSummary([rec("b")])).toBeNull();
  });
  it("RV4-21 killer: with sync off, the local fold removes what it folded and KEEPS what is still parked", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    await turnSyncOff(a.engine, w.password);
    const other = await generateVk();
    const back = addEntry(
      await a.vault(vk),
      input("back after the update"),
      createClock("eeee", { now: () => w.clock.now }),
    ).vault;
    a.disk.kv.data.set(SYNC_KEYS.orphan, {
      v: 1,
      items: [
        { ...(await pushableOf(back, vk, 3, "h", "openable")), parked: { reason: "schema", vkId: null, at: 1 } },
        {
          ...(await pushableOf(await a.vault(vk), other, 4, "h2", "still-parked")),
          parked: { reason: "key", vkId: other.id, at: 1 },
        },
      ],
    });
    expect(
      await foldParkedLocally({ flows: a.ctx.flows, kv: a.disk.kv, vaultLock: a.lock, now: () => w.clock.now }),
    ).toEqual({ folded: 1, parked: 1 });
    expect(entries(a).map((x) => x.checksum)).toEqual(["still-parked"]);
  }, 60_000);

  it("RV4-24 killer: a worker start schedules a round for a parked entry that carries a write proof (it may be pushable at its own (base, head))", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    a.disk.kv.data.set(SYNC_KEYS.orphan, {
      v: 1,
      items: [
        {
          ...(await pushableOf(await a.vault(vk), vk, 7, "h7", "parked-pushable")),
          parked: { reason: "schema", vkId: null, at: 1 },
        },
      ],
    });
    a.restartWorker();
    a.scheduler.wakes.clear();
    await a.engine.start();
    expect(a.scheduler.wakes.has("sync")).toBe(true);
  }, 60_000);
});
