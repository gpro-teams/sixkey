// The fourth M3 review: revision 20's new writes, each operation killed at every step (every storage write and every
// request; before it, after it, or a lying write). After each death the device restarts and, where the save's only copy
// is at risk, its active slot is torn too; the save must still reach the vault (and, with sync on, every device and the
// head). Operations: the locked push that demotes (one write: the list append with outbox and lastSynced cleared); the
// keyed round that folds two entries and retires them in its lastSynced write; the sync-off local fold
// (foldParkedLocally); turnSyncOff with one parked and one unparked entry; the "Advanced" delete.
// Adopted into M3 revision 5 unchanged. Revision 6 edit: the "Advanced" delete passes the checksums (required since
// R5R-3), marked there. Nothing else.
import { beforeAll, describe, expect, it } from "vitest";
import type { Vk } from "../../src/core/crypto/vk";
import { generateVk } from "../../src/core/crypto/vk";
import { KEYS } from "../../src/core/storage/format";
import { writeProof } from "../../src/core/sync/crypto/subkeys";
import { turnSyncOff } from "../../src/core/sync/engine/keys";
import { discardParkedOrphans, foldParkedLocally } from "../../src/core/sync/engine/orphans";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { uploadEnvelope } from "../../src/core/sync/local/outbox";
import { createClock } from "../../src/core/vault/hlc";
import { aliveEntries, type Vault } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { tear } from "../helpers/faulty-kv";
import { input } from "../helpers/m2-world";
import { runDying, type Mode } from "../helpers/m3-crash";
import { cloneWorld, quiesce, worldOf, type Device, type World } from "../helpers/m3-world";

const names = async (d: Device, vk?: Vk) => aliveEntries(await d.vault(vk)).map((e) => e.issuer);
const entries = (d: Device): Record<string, unknown>[] =>
  (d.disk.kv.data.get(SYNC_KEYS.orphan) as { items?: Record<string, unknown>[] } | undefined)?.items ?? [];
function tearActive(d: Device): void {
  const kv = d.disk.kv;
  const ptr = kv.data.get(KEYS.active) as "a" | "b";
  kv.data.set(KEYS.slot[ptr], tear(kv.data.get(KEYS.slot[ptr])));
}
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
const MODES: Mode[] = ["before", "after", "lie"];
/**
 * A lie on the store's own slot or pointer write (the commit point, not read back) loses that commit's content in Phase
 * 0's store itself (M3-NOTES §3 item 18; m3-crash-round excludes it the same way). Such rows are run but not asserted;
 * the review reports the one consequence specific to revision 20 separately (R4R-11: the round's retirement trusts the
 * fold's in-memory result).
 */
const storeCommitLie = (mode: Mode, steps: string[], at: number) =>
  mode === "lie" && /^local\.set (sk_active|sk_slot_[ab])$/.test(steps[at - 1] ?? "");

/** Unlocked again after a death, the way a user gets back: a browser restart, the recovery code, rounds. */
async function back(w: World, d: Device): Promise<void> {
  await d.restartBrowser();
  await d.svc.unlockWithRecoveryCode(w.code).catch(() => undefined);
}

let demoteBase: World; // A: SAVE committed, locked; B moved the server: A's next locked push demotes the outbox
let foldBase: World; // A: two entries (SAVE demoted, SAVE2 merge-only, recovered by a tear), unlocked
let offBase: World; // A: sync off, one parked entry that opens now (PARKED SAVE)
let turnOffBase: World; // A: one entry parked under a key it never had, one unparked (UNPARKED SAVE)

beforeAll(async () => {
  demoteBase = await worldOf(2, ["GitHub", "AWS"]);
  {
    const [a, b] = demoteBase.devices as [Device, Device];
    demoteBase.advance(1000);
    await a.add("SAVE");
    await a.lockNow();
    demoteBase.advance(1000);
    await b.add("B moved");
    await b.engine.round();
    a.restartWorker();
  }
  foldBase = cloneWorld(demoteBase);
  {
    const [a] = foldBase.devices as [Device, Device];
    await a.engine.push(); // demoted
    if (entries(a).length !== 1) throw new Error("no demotion");
    await a.unlock();
    foldBase.advance(1000);
    await a.add("SAVE2");
    await a.lockNow();
    tearActive(a);
    a.restartWorker();
    await a.svc.status();
    if (entries(a).length !== 2) throw new Error("no second entry");
    await a.unlock();
  }
  offBase = await worldOf(2, ["GitHub", "AWS"]);
  {
    const [a] = offBase.devices as [Device, Device];
    const vk = await a.vk();
    await turnSyncOff(a.engine, offBase.password);
    const save = addEntry(
      await a.vault(vk),
      input("PARKED SAVE"),
      createClock("eeee", { now: () => offBase.clock.now }),
    ).vault;
    a.disk.kv.data.set(SYNC_KEYS.orphan, {
      v: 1,
      items: [
        { ...(await pushableOf(save, vk, 3, "h", "parked-save")), parked: { reason: "schema", vkId: null, at: 1 } },
      ],
    });
  }
  turnOffBase = await worldOf(2, ["GitHub", "AWS"]);
  {
    const [a] = turnOffBase.devices as [Device, Device];
    const vk = await a.vk();
    const other = await generateVk();
    const unparked = addEntry(
      await a.vault(vk),
      input("UNPARKED SAVE"),
      createClock("eeee", { now: () => turnOffBase.clock.now }),
    ).vault;
    a.disk.kv.data.set(SYNC_KEYS.orphan, {
      v: 1,
      items: [
        {
          ...(await pushableOf(await a.vault(vk), other, 5, "x", "key-parked")),
          parked: { reason: "key", vkId: other.id, at: 1 },
        },
        await pushableOf(unparked, vk, 6, "y", "unparked"),
      ],
    });
  }
}, 240_000);

describe("M3-R4 review: revision 20's writes, dying at every step", () => {
  it("the locked push that demotes (then the dirty slot torn): the save reaches every device and the head", async () => {
    let rows = 0;
    for (const mode of MODES) {
      for (let at = 1; at < 200; at++) {
        const w = cloneWorld(demoteBase);
        const [a, b] = w.devices as [Device, Device];
        const r = await runDying(a, at, mode, (c) => c.engine.push());
        a.restartWorker();
        if (mode === "lie") await a.engine.push(); // a lying write: the next wake does it again
        tearActive(a); // the save's slot: from here its only copy is the outbox or the entry
        a.restartWorker();
        await a.svc.status();
        await back(w, a);
        await quiesce(w, 8, [a, b]);
        const vk = await a.vk();
        if (storeCommitLie(mode, r.steps, at)) {
          rows++;
          continue;
        }
        expect(await names(a, vk), `@${at} ${mode}`).toContain("SAVE");
        expect(await names(b, vk), `@${at} ${mode}`).toContain("SAVE");
        expect(
          aliveEntries((await w.serverVault(vk))!).map((e) => e.issuer),
          `@${at} ${mode}: head`,
        ).toContain("SAVE");
        expect(entries(a), `@${at} ${mode}: retired`).toHaveLength(0);
        rows++;
        if (!r.reached) break;
      }
    }
    expect(rows).toBeGreaterThan(6);
  }, 1_200_000);

  it("the keyed round that folds two entries and retires them (then the active slot torn): both saves reach every device and the head", async () => {
    let rows = 0;
    for (const mode of MODES) {
      for (let at = 1; at < 300; at++) {
        const w = cloneWorld(foldBase);
        const [a, b] = w.devices as [Device, Device];
        await a.svc.unlockWithRecoveryCode(w.code);
        const r = await runDying(a, at, mode, (c) => c.engine.round());
        await a.lockNow().catch(() => undefined);
        tearActive(a); // whatever the fold committed: if the entries were retired, the head must hold them
        a.restartWorker();
        await a.svc.status().catch(() => undefined);
        await back(w, a);
        await quiesce(w, 8, [a, b]);
        const vk = await a.vk();
        if (storeCommitLie(mode, r.steps, at)) {
          rows++;
          continue;
        }
        for (const s of ["SAVE", "SAVE2"]) {
          expect(await names(a, vk), `@${at} ${mode}: A ${s}`).toContain(s);
          expect(await names(b, vk), `@${at} ${mode}: B ${s}`).toContain(s);
          expect(
            aliveEntries((await w.serverVault(vk))!).map((e) => e.issuer),
            `@${at} ${mode}: head ${s}`,
          ).toContain(s);
        }
        expect(entries(a), `@${at} ${mode}: retired`).toHaveLength(0);
        rows++;
        if (!r.reached) break;
      }
    }
    expect(rows).toBeGreaterThan(20);
  }, 1_800_000);

  it("foldParkedLocally (sync off): the parked save ends in the vault, the entry removed once folded", async () => {
    let rows = 0;
    for (const mode of MODES) {
      for (let at = 1; at < 100; at++) {
        const w = cloneWorld(offBase);
        const [a] = w.devices as [Device, Device];
        const r = await runDying(a, at, mode, (c) =>
          foldParkedLocally({
            flows: c.flows,
            kv: c.local["local"] as never,
            vaultLock: a.lock,
            now: () => w.clock.now,
          }),
        );
        await back(w, a);
        const again = await foldParkedLocally({
          flows: a.ctx.flows,
          kv: a.disk.kv,
          vaultLock: a.lock,
          now: () => w.clock.now,
        });
        if (storeCommitLie(mode, r.steps, at)) {
          rows++;
          if (!r.reached) break;
          continue;
        }
        expect(again, `@${at} ${mode}`).not.toBe("vault_lost");
        expect(await names(a), `@${at} ${mode}`).toContain("PARKED SAVE");
        expect(entries(a), `@${at} ${mode}`).toHaveLength(0);
        rows++;
        if (!r.reached) break;
      }
    }
    expect(rows).toBeGreaterThan(3);
  }, 600_000);

  it("turnSyncOff with a parked and an unparked entry: the unparked save ends in the vault, the parked entry kept, sync off", async () => {
    let rows = 0;
    for (const mode of ["before", "after"] as Mode[]) {
      for (let at = 1; at < 200; at++) {
        const w = cloneWorld(turnOffBase);
        const [a] = w.devices as [Device, Device];
        await a.svc.unlockWithRecoveryCode(w.code);
        const r = await runDying(a, at, mode, (c) => turnSyncOff(c.engine, w.password));
        await back(w, a);
        for (let i = 0; i < 4; i++) {
          const st = (await a.local.status()).kind;
          if (st === "off") break;
          if (st === "on") await turnSyncOff(a.engine, w.password).catch(() => undefined);
          else await a.engine.round().catch(() => undefined);
        }
        expect((await a.local.status()).kind, `@${at} ${mode}`).toBe("off");
        const kept = entries(a);
        const inVault = (await names(a)).includes("UNPARKED SAVE");
        expect(inVault || kept.some((x) => x.checksum === "unparked"), `@${at} ${mode}: the unparked save`).toBe(true);
        expect(
          kept.map((x) => x.checksum),
          `@${at} ${mode}: the parked entry kept`,
        ).toContain("key-parked");
        rows++;
        if (!r.reached) break;
      }
    }
    expect(rows).toBeGreaterThan(6);
  }, 1_200_000);

  it("'Advanced' delete: dying at its one write leaves either both kept or the parked one deleted; never the unparked one", async () => {
    for (const mode of MODES) {
      const w = cloneWorld(turnOffBase);
      const [a] = w.devices as [Device, Device];
      // (M3 revision 6 edit, R5R-3: the checksums are required now; without them the delete would be refused outright and
      // the write this test kills would never run, so the notice's checksum of the one parked entry is passed)
      await runDying(a, 1, mode, async (c) =>
        discardParkedOrphans(
          { kv: c.local["local"] as never, vaultLock: a.lock },
          { count: 1, checksums: ["key-parked"] },
        ),
      );
      expect(
        entries(a).map((x) => x.checksum),
        mode,
      ).toContain("unparked");
    }
  }, 120_000);
});
