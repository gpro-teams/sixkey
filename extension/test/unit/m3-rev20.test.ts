// SYNC-DESIGN revision 20 (§0.0t, §4.7, §8.2): the orphan list, demote never drop (R3R-1), the merge-only outbox
// (R3R-5), parking (R3R-4), the record-deleting flows keep parked entries (R3R-2), vault_lost (R3R-3) and the undo's
// answer (R3R-6). The third review's own probes for these are in m3r3-review-probes.test.ts; this file adds the §8.2
// cases they do not cover. Every case asserts that the save the user was told about ends up on every device and in the
// head, or, where sync is off, in this device's vault.
import { describe, expect, it } from "vitest";
import type { Vk } from "../../src/core/crypto/vk";
import { KEYS } from "../../src/core/storage/format";
import { MergeBlocked } from "../../src/core/service/sync-flows";
import { writeProof } from "../../src/core/sync/crypto/subkeys";
import { ApprovalJoin, Approver, commitJoin, joinWithRecoveryCode } from "../../src/core/sync/engine/enroll";
import {
  adoptWithSecret,
  commitRotation,
  prepareRotation,
  removeSyncIdentity,
  turnSyncOff,
} from "../../src/core/sync/engine/keys";
import { discardParkedOrphans, foldParkedLocally, readParkedOrphans } from "../../src/core/sync/engine/orphans";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { uploadEnvelope } from "../../src/core/sync/local/outbox";
import { lastSyncedOf } from "../../src/core/sync/local/state";
import { createClock } from "../../src/core/vault/hlc";
import { aliveEntries, type Vault } from "../../src/core/vault/model";
import { addEntry, deleteEntry, purgeEntry } from "../../src/core/vault/ops";
import { tear } from "../helpers/faulty-kv";
import { input } from "../helpers/m2-world";
import { cloneDisk, contextOver, EMAIL, quiesce, worldOf, type Device, type World } from "../helpers/m3-world";
import { createProtected } from "../helpers/vaults";

const names = async (d: Device, vk?: Vk) =>
  aliveEntries(await d.vault(vk))
    .map((e) => e.issuer)
    .sort();
const headNames = async (w: World, vk: Vk) =>
  aliveEntries((await w.serverVault(vk))!)
    .map((e) => e.issuer)
    .sort();
const entries = (d: Device): Record<string, unknown>[] =>
  (d.disk.kv.data.get(SYNC_KEYS.orphan) as { items?: Record<string, unknown>[] } | undefined)?.items ?? [];
const outboxOf = (d: Device) => (d.disk.kv.data.get(SYNC_KEYS.outbox) ?? null) as Record<string, unknown> | null;
function tearActive(d: Device): void {
  const kv = d.disk.kv;
  const ptr = kv.data.get(KEYS.active) as "a" | "b";
  kv.data.set(KEYS.slot[ptr], tear(kv.data.get(KEYS.slot[ptr])));
}
async function everywhere(w: World, save: string, vk: Vk): Promise<void> {
  for (const d of w.devices) expect(await names(d, vk), d.name).toContain(save);
  expect(await headNames(w, vk)).toContain(save);
}
const withEntry = (w: World, vault: Vault, issuer: string): Vault =>
  addEntry(vault, input(issuer), createClock("eeee", { now: () => w.clock.now })).vault;
async function plant(d: Device, items: Record<string, unknown>[]): Promise<void> {
  d.disk.kv.data.set(SYNC_KEYS.orphan, { v: 1, items });
}
async function pushableOf(vault: Vault, vk: Vk, base: number, head: string): Promise<Record<string, unknown>> {
  const up = await uploadEnvelope(vault, vk, { vaultId: vault.vaultId, rev: base + 1 });
  const proof = await writeProof(vk, { vaultId: vault.vaultId, ifVersion: base, checksum: up.envelope.checksum });
  return {
    v: 1,
    base,
    head,
    from: { version: base, head, checksum: "planted" },
    checksum: `planted-${base}-${head.slice(0, 4)}`,
    envelope: up.text,
    proof,
  };
}

describe("revision 20: the orphan list", () => {
  it("a demotion, a merge-only outbox and two recoveries make three entries; one keyed round folds all three and its lastSynced write retires them", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("E1, demoted");
    await a.lockNow();
    w.advance(1000);
    await b.add("B first");
    await b.engine.round();
    a.restartWorker();
    await a.engine.push(); // stale: demoted (R3R-1), never dropped
    expect(entries(a)).toHaveLength(1);
    expect(outboxOf(a)).toBeNull();
    expect(lastSyncedOf(a.disk.kv.data.get(SYNC_KEYS.state))).toBeNull();
    await a.unlock(); // the popup ("lock every time": no round)
    w.advance(1000);
    await a.add("E2, merge-only");
    expect(outboxOf(a)).toMatchObject({ from: null });
    await a.lockNow();
    tearActive(a); // E2's slot
    a.restartWorker();
    await a.svc.status(); // the recovery appends the merge-only record
    expect(entries(a)).toHaveLength(2);
    await a.unlock();
    w.advance(1000);
    await a.add("E3, merge-only again");
    await a.lockNow();
    tearActive(a);
    a.restartWorker();
    await a.svc.status();
    expect(entries(a)).toHaveLength(3); // always appended, never over another entry
    await a.unlock();
    expect((await a.engine.round()).status).toBe("ok");
    expect(entries(a)).toHaveLength(0); // retired in the write that set lastSynced
    expect(lastSyncedOf(a.disk.kv.data.get(SYNC_KEYS.state))).not.toBeNull();
    await quiesce(w);
    for (const s of ["E1, demoted", "E2, merge-only", "E3, merge-only again", "B first"]) await everywhere(w, s, vk);
  }, 60_000);

  it("the merge-only outbox is overwritten by every later save (the newest generation holds them all); a tear keeps the last one, which brings both saves back", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("first save");
    await a.lockNow();
    tearActive(a);
    a.restartWorker();
    await a.svc.status(); // the first save becomes an entry; lastSynced null
    await a.unlock();
    w.advance(1000);
    await a.add("M1");
    const mo1 = outboxOf(a);
    w.advance(1000);
    await a.add("M2");
    const mo2 = outboxOf(a);
    expect(mo1).toMatchObject({ from: null });
    expect(mo2).toMatchObject({ from: null, checksum: (await a.generation()).envelope.checksum });
    expect(mo2!.envelope).not.toBe(mo1!.envelope); // replaced, not appended
    expect(entries(a)).toHaveLength(1); // the outbox writer never touches the list
    await a.lockNow();
    tearActive(a); // M2's slot: the recovery falls back to M1's generation, the record keeps M2's
    a.restartWorker();
    await a.svc.status();
    expect(entries(a)).toHaveLength(2);
    await a.unlock();
    await quiesce(w);
    for (const s of ["first save", "M1", "M2"]) await everywhere(w, s, vk);
  }, 60_000);

  it("the merge-only outbox is never pushed, and a pushable entry is pushed by the locked worker only at its own (base, head)", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    const head = w.server.account(EMAIL).vault!;
    const mine = await a.vault(vk);
    await plant(a, [
      await pushableOf(withEntry(w, mine, "elsewhere-based"), vk, head.version - 1, "not the head"),
      await pushableOf(withEntry(w, mine, "head-based"), vk, head.version, head.head),
    ]);
    const st = a.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>;
    a.disk.kv.data.set(SYNC_KEYS.state, { ...st, lastSynced: null });
    a.disk.kv.data.set(SYNC_KEYS.outbox, { v: 1, from: null, checksum: "mo", envelope: "{}" });
    await a.lockNow();
    a.restartWorker();
    const puts = () => w.server.requests.filter((r) => r.op === "PUT /v1/vault" && r.status === 200).length;
    const p0 = puts();
    expect((await a.engine.push()).pushedOutbox).toBe(true);
    expect(puts()).toBe(p0 + 1); // exactly the matching entry
    expect(entries(a).map((x) => x.head)).toEqual(["not the head"]); // the pushed one retired, the other kept
    expect(await headNames(w, vk)).toContain("head-based");
    expect(outboxOf(a)).toMatchObject({ from: null }); // the merge-only record stays (never pushed, never dropped)
  }, 60_000);
});

describe("revision 20: the merge-only outbox only while sync is on", () => {
  it("no outbox of any kind on a profile where sync was never on, after turning it off, or from the sync-off local fold", async () => {
    const { World } = await import("../helpers/m3-world");
    const { createProtected } = await import("../helpers/vaults");
    const { createOutboxWriter } = await import("../../src/core/sync/local/outbox");
    const w0 = new World();
    const x = w0.device("X");
    await createProtected(x.svc, w0.password);
    await x.add("never synced");
    expect(x.disk.kv.data.get(SYNC_KEYS.outbox) ?? null).toBeNull();
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    await turnSyncOff(a.engine, w.password);
    w.advance(1000);
    await a.add("after the turn-off");
    expect(a.disk.kv.data.get(SYNC_KEYS.outbox) ?? null).toBeNull();
    await plant(a, [
      {
        ...(await pushableOf(withEntry(w, await a.vault(vk), "folded with sync off"), vk, 3, "h")),
        parked: { reason: "schema", vkId: null, at: 1 },
      },
    ]);
    expect(
      await foldParkedLocally({ flows: a.ctx.flows, kv: a.disk.kv, vaultLock: a.lock, now: () => w.clock.now }),
    ).toEqual({ folded: 1, parked: 0 });
    expect(a.disk.kv.data.get(SYNC_KEYS.outbox) ?? null).toBeNull();
    // and the writer itself, called directly with no sk_sync_cfg (a caller that did not gate): nothing written
    const g = await a.generation();
    await createOutboxWriter(a.disk.kv)({ gen: g, vk, vault: await a.vault(vk) });
    expect(a.disk.kv.data.get(SYNC_KEYS.outbox) ?? null).toBeNull();
  }, 60_000);
});

describe("revision 5: a newer build's record (R4R-5) in the locked round", () => {
  it("a v: 2 entry is kept by the locked round (never judged 'another vault' or damaged) and by the keyed one, and counts as parked", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const newer = { v: 2, shape: "a newer build's", payload: "?" };
    await plant(a, [newer]);
    await a.lockNow();
    a.restartWorker();
    await a.engine.push();
    expect(entries(a)).toEqual([newer]);
    await a.unlock();
    expect((await a.engine.round()).status).toBe("ok");
    expect(entries(a)).toEqual([newer]);
    expect(lastSyncedOf(a.disk.kv.data.get(SYNC_KEYS.state))).not.toBeNull(); // parked: it does not hold sync up
    expect((await readParkedOrphans(a.disk.kv, a.lock))?.count).toBe(1);
  }, 60_000);
});

describe("revision 20: the third demotion case", () => {
  it("the locked push answered 403 write_denied while the key really moved (a rotation elsewhere): demoted, never dropped; a tear later, the adoption folds it and the save reaches the rotated head", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    w.advance(1000);
    await a.add("saved before the rotation elsewhere");
    await a.lockNow();
    let once = true;
    const racing = {
      send: async (req: Parameters<typeof a.net.send>[0]) => {
        if (once && req.method === "PUT" && req.target === "/v1/vault") {
          once = false;
          await commitRotation(b.engine, await prepareRotation(b.engine, w.password)); // K_write moves under A's PUT
          return {
            status: 403,
            headers: {},
            body: JSON.stringify({ error: { code: "write_denied" }, server_time: w.server.now() }),
          };
        }
        return a.net.send(req);
      },
    };
    const worker = contextOver({
      ...a.disk,
      lock: a.lock,
      identityLock: a.identityLock,
      syncLock: a.syncLock,
      transport: racing,
      clock: a.now,
    });
    expect((await worker.engine.push()).status).toBe("locked");
    expect(outboxOf(a)).toBeNull();
    expect(entries(a)).toHaveLength(1); // demoted (revision 20), not dropped
    tearActive(a);
    a.restartWorker();
    await a.svc.status();
    expect((await a.engine.round()).status).toBe("needs_password");
    expect(await adoptWithSecret(a.engine, { password: w.password })).toMatchObject({ kind: "adopted" });
    await quiesce(w);
    await everywhere(w, "saved before the rotation elsewhere", await b.vk());
    expect(entries(a)).toHaveLength(0);
  }, 60_000);
});

describe("revision 20: a demotion beside a parked entry", () => {
  it("a parked entry stays when a later outbox is demoted (always appended, never over an entry)", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const vk = await a.vk();
    const { encryptVault } = await import("../../src/core/crypto/envelope");
    const { utf8 } = await import("../../src/core/crypto/bytes");
    const vaultId = (await a.generation()).keyring.vaultId;
    const env = await encryptVault(utf8(JSON.stringify({ schemaVersion: 2, vaultId, entries: [] })), vk, {
      vaultId,
      rev: 99,
    });
    await plant(a, [{ v: 1, from: null, checksum: "newer", envelope: JSON.stringify(env) }]);
    const st = a.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>;
    a.disk.kv.data.set(SYNC_KEYS.state, { ...st, lastSynced: null });
    expect((await a.engine.round()).status).toBe("ok"); // parks it; lastSynced set
    w.advance(1000);
    await a.add("demoted beside the parked one");
    await a.lockNow();
    w.advance(1000);
    await b.add("B first");
    await b.engine.round();
    a.restartWorker();
    await a.engine.push(); // demoted
    expect(entries(a).map((x) => (x.checksum === "newer" ? "parked" : x.parked ? "?" : "demoted"))).toEqual([
      "parked",
      "demoted",
    ]);
    tearActive(a);
    a.restartWorker();
    await a.svc.status();
    await a.unlock();
    await quiesce(w);
    await everywhere(w, "demoted beside the parked one", vk);
    expect(entries(a).map((x) => x.checksum)).toEqual(["newer"]);
  }, 60_000);
});

describe("revision 20: parked entries (R3R-4) and the flows that delete the sync records (R3R-2)", () => {
  /** A on VK1 again (a storage rollback past its adoption of VK2) with an entry under VK2 holding the only copy of a save. */
  async function fixa2(): Promise<{ w: World; a: Device; b: Device; vk2: Vk }> {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const before = cloneDisk(a.disk);
    await commitRotation(b.engine, await prepareRotation(b.engine, w.password));
    expect((await a.engine.round()).status).toBe("needs_password");
    await adoptWithSecret(a.engine, { password: w.password });
    await a.engine.round();
    const vk2 = await a.vk();
    const head = w.server.account(EMAIL).vault!;
    const save = withEntry(w, await a.vault(vk2), "only in the entry (VK2)");
    for (const [k, v] of before.kv.data) a.disk.kv.data.set(k, structuredClone(v));
    a.disk.session.data = before.session.data ? { ...before.session.data } : null;
    await plant(a, [await pushableOf(save, vk2, head.version, head.head)]);
    a.restartWorker();
    return { w, a, b, vk2 };
  }

  it("FIXa2: the entry under the newer key is parked (reason key, its key id), kept; the adoption brings the key and the next fold folds it", async () => {
    const { w, a, vk2 } = await fixa2();
    expect((await a.engine.round()).status).toBe("needs_password");
    expect(entries(a).map((x) => (x.parked as { reason: string; vkId: string }) ?? null)).toEqual([
      expect.objectContaining({ reason: "key", vkId: vk2.id }),
    ]);
    expect(await readParkedOrphans(a.disk.kv, a.lock)).toMatchObject({
      count: 1,
      reasons: ["key"],
      checksums: [entries(a)[0]!.checksum],
    }); // the UI's notice (§6 O12)
    expect(await adoptWithSecret(a.engine, { password: w.password })).toMatchObject({ kind: "adopted" });
    await quiesce(w);
    await everywhere(w, "only in the entry (VK2)", vk2);
    expect(entries(a)).toHaveLength(0);
  }, 60_000);

  it("an entry parked under a newer key, folded after the adoption, is no longer parked: turning sync off right then deletes it with the records (its content is in the vault)", async () => {
    const { w, a } = await fixa2();
    expect((await a.engine.round()).status).toBe("needs_password");
    expect(entries(a)[0]!.parked).toMatchObject({ reason: "key" });
    expect(await adoptWithSecret(a.engine, { password: w.password })).toMatchObject({ kind: "adopted" }); // folds it (mark cleared)
    expect(entries(a).map((x) => x.parked ?? null)).toEqual([null]); // folded, waiting for the round's retirement
    await turnSyncOff(a.engine, w.password);
    expect(await names(a)).toContain("only in the entry (VK2)");
    expect(a.disk.kv.data.get(SYNC_KEYS.orphan) ?? null).toBeNull(); // not kept as if it were still parked
  }, 60_000);

  it("removeSyncIdentity and turnSyncOff keep parked entries (no refusal: the emergency exits work); sk_sync_orphan survives D11 holding only them", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const { generateVk } = await import("../../src/core/crypto/vk");
    const other = await generateVk();
    const head = w.server.account(EMAIL).vault!;
    const vk = await a.vk();
    // one entry under a key this keyring does not hold (parked), one openable (folded first by the turn-off)
    await plant(a, [
      await pushableOf(await a.vault(vk), other, head.version + 7, "nowhere"),
      await pushableOf(
        withEntry(w, await a.vault(vk), "folded by the turn-off"),
        vk,
        head.version + 9,
        "nowhere either",
      ),
    ]);
    await turnSyncOff(a.engine, w.password);
    expect((await a.local.status()).kind).toBe("off");
    expect(await names(a)).toContain("folded by the turn-off");
    expect([...a.disk.kv.data.keys()].filter((k) => k.startsWith("sk_sync"))).toEqual([SYNC_KEYS.orphan]);
    expect(entries(a).map((x) => (x.parked as { reason: string }).reason)).toEqual(["key"]);
    expect(await readParkedOrphans(a.disk.kv, a.lock)).toEqual({
      count: 1,
      reasons: ["key"],
      checksums: [entries(a)[0]!.checksum],
    }); // the security page's notice
  }, 60_000);

  it("with sync off, an unlock of the settings page retries the local fold of the parked entries (no engine, no network); the folded one is removed, a parked one stays", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    await turnSyncOff(a.engine, w.password);
    // a parked entry that opens now (as after an update, or with room under the entry limit again)
    const openable = await pushableOf(withEntry(w, await a.vault(vk), "back after the update"), vk, 3, "h");
    await plant(a, [{ ...openable, parked: { reason: "schema", vkId: null, at: 1 } }]);
    const reqs = w.server.requests.length;
    expect(
      await foldParkedLocally({ flows: a.ctx.flows, kv: a.disk.kv, vaultLock: a.lock, now: () => w.clock.now }),
    ).toEqual({ folded: 1, parked: 0 });
    expect(await names(a)).toContain("back after the update");
    expect(a.disk.kv.data.get(SYNC_KEYS.orphan) ?? null).toBeNull(); // the last entry folded: the key goes
    // (revision 5, the fourth review's RV4-21: this case ADDED) beside one that still does not open (under a key this
    // keyring does not hold): the folded one is removed, the parked one stays
    const openable2 = await pushableOf(withEntry(w, await a.vault(vk), "back after the update, 2"), vk, 5, "j");
    const { generateVk } = await import("../../src/core/crypto/vk");
    const stillParked = {
      ...(await pushableOf(await a.vault(vk), await generateVk(), 4, "i")),
      parked: { reason: "key", vkId: null, at: 1 },
    };
    await plant(a, [{ ...openable2, parked: { reason: "schema", vkId: null, at: 1 } }, stillParked]);
    expect(
      await foldParkedLocally({ flows: a.ctx.flows, kv: a.disk.kv, vaultLock: a.lock, now: () => w.clock.now }),
    ).toEqual({ folded: 1, parked: 1 });
    expect(await names(a)).toContain("back after the update, 2");
    expect(entries(a).map((x) => x.checksum)).toEqual([(stillParked as unknown as { checksum: string }).checksum]); // the parked one stays
    await plant(a, []);
    expect(w.server.requests.length).toBe(reqs); // nothing sent
    await a.lockNow();
    await plant(a, [{ ...openable, parked: { reason: "schema", vkId: null, at: 1 } }]);
    expect(
      await foldParkedLocally({ flows: a.ctx.flows, kv: a.disk.kv, vaultLock: a.lock, now: () => w.clock.now }),
    ).toBe("locked");
  }, 60_000);

  it("'Advanced': the parked entries deleted only after the user confirmed exactly the count shown; never an unparked one", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    const p1 = {
      ...(await pushableOf(await a.vault(vk), vk, 1, "x")),
      parked: { reason: "schema", vkId: null, at: 1 },
    };
    const unp = await pushableOf(withEntry(w, await a.vault(vk), "not parked"), vk, 2, "y");
    await plant(a, [p1, unp]);
    const p1c = (p1 as unknown as { checksum: string }).checksum;
    const unpc = (unp as unknown as { checksum: string }).checksum;
    await expect(
      discardParkedOrphans({ kv: a.disk.kv, vaultLock: a.lock }, { count: 2, checksums: [p1c, unpc] }),
    ).rejects.toMatchObject({ code: "bad_state" }); // the list shown had 1
    // (revision 6, R5R-3: the checksums are required) a count that disagrees with them, or none at all: refused
    await expect(
      discardParkedOrphans({ kv: a.disk.kv, vaultLock: a.lock }, { count: 2, checksums: [p1c] }),
    ).rejects.toMatchObject({ code: "bad_state" });
    await expect(
      discardParkedOrphans({ kv: a.disk.kv, vaultLock: a.lock }, { count: 1 } as unknown as {
        count: number;
        checksums: string[];
      }),
    ).rejects.toMatchObject({ code: "bad_state" });
    expect(entries(a)).toHaveLength(2);
    expect(await discardParkedOrphans({ kv: a.disk.kv, vaultLock: a.lock }, { count: 1, checksums: [p1c] })).toBe(1);
    expect(entries(a).map((x) => x.head)).toEqual(["y"]);
  }, 60_000);

  it("a locked context with an unparked entry: the record-deleting flows refuse (locked); with only parked entries they go ahead", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    await plant(a, [await pushableOf(withEntry(w, await a.vault(vk), "unparked"), vk, 50, "z")]);
    await a.lockNow();
    await expect(removeSyncIdentity(a.engine)).rejects.toMatchObject({ code: "locked" });
    expect(entries(a)).toHaveLength(1);
    a.disk.kv.data.set(SYNC_KEYS.orphan, {
      v: 1,
      items: entries(a).map((x) => ({ ...x, parked: { reason: "schema", vkId: null, at: 1 } })),
    });
    await removeSyncIdentity(a.engine); // only parked: no refusal
    expect((await a.local.status()).kind).toBe("off");
    expect(entries(a)).toHaveLength(1);
  }, 60_000);
});

describe("revision 20: the undo's answer (R3R-6)", () => {
  it("M3R-9's undo blocked by the guard on the fold: the join's own answer answers it, and the join goes ahead", async () => {
    const w = await worldOf(1, ["GitHub", "AWS"]);
    const n = w.device("N");
    const plan = await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
    });
    w.server.fault({
      match: "POST /v1/enroll/requests/{rid}/complete",
      kind: "status",
      status: 410,
      code: "enroll_gone",
      count: 3,
    });
    expect(await commitJoin(plan)).toBe("unconfirmed");
    w.server.clearFaults();
    const vk = await n.vk();
    const mine = await n.vault(vk);
    const aws = mine.entries.find((e) => e.issuer === "AWS")!.id;
    const clock = createClock("eeee", { now: () => w.clock.now });
    const erased = purgeEntry(deleteEntry(mine, aws, clock), aws, clock); // N's own erase, only in the entry
    const head = w.server.account(EMAIL).vault!;
    await plant(n, [await pushableOf(erased, vk, head.version, head.head)]);
    w.advance(11 * 60_000);
    await n.unlock();
    let blocked: MergeBlocked | null = null;
    await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
    }).catch((e: unknown) => {
      if (e instanceof MergeBlocked) blocked = e;
      else throw e;
    });
    expect(blocked).not.toBeNull();
    const b = blocked as unknown as MergeBlocked;
    expect(b.report.purgedAlive).toEqual([aws]);
    expect((await n.local.status()).kind).toBe("on"); // nothing undone yet
    const plan2 = await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
      answer: { seen: b.seen, accept: [aws] },
    });
    expect(await commitJoin(plan2)).toBe("enrolled");
    await quiesce(w);
    expect(await names(n, vk)).not.toContain("AWS");
  }, 60_000);

  it("the revoked-pending undo (M3RR-8) blocked by the guard on the fold: the join's own answer answers it too", async () => {
    const w = await worldOf(1, ["GitHub", "AWS"]);
    const a = w.devices[0]!;
    const n = w.device("N");
    const plan = await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
    });
    n.net.inject({ match: "POST /v1/enroll/requests/{rid}/complete", kind: "lose_response" });
    n.net.inject({ match: "POST /v1/enroll/requests/{rid}/complete", kind: "fail_before", count: 2 });
    expect(await commitJoin(plan)).toBe("unconfirmed"); // it landed, the answer was lost
    const nid = ((await n.local.identity.get()) as { deviceId: string }).deviceId;
    const { revokeDevice } = await import("../../src/core/sync/engine/keys");
    await revokeDevice(a.engine, nid, w.password); // the owner revokes the "unknown" N
    const vk = await n.vk();
    const mine = await n.vault(vk);
    const aws = mine.entries.find((e) => e.issuer === "AWS")!.id;
    const clock = createClock("eeee", { now: () => w.clock.now });
    const head = w.server.account(EMAIL).vault!;
    await plant(n, [
      await pushableOf(purgeEntry(deleteEntry(mine, aws, clock), aws, clock), vk, head.version, head.head),
    ]);
    let blocked: MergeBlocked | null = null;
    await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
    }).catch((e: unknown) => {
      if (e instanceof MergeBlocked) blocked = e;
      else throw e;
    });
    expect(blocked).not.toBeNull();
    const b = blocked as unknown as MergeBlocked;
    const plan2 = await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
      answer: { seen: b.seen, accept: [aws] },
    });
    expect(await commitJoin(plan2)).toBe("enrolled");
  }, 60_000);
});

// ---- patch revision 6: the approval join's prepare folds again (R5R-1), the turn-off keeps the live outbox (R5R-2) ----

const XPW = "another-strong-pass-77";
/** A profile with its own vault, never synced (another vault than the world's). */
async function ownVault(w: World): Promise<Device> {
  const x = w.device("X");
  await createProtected(x.svc, XPW);
  await x.svc.openView();
  await x.add("X's own account");
  return x;
}
/**
 * The approval join from start to the opened payload (the pairing code typed, the SAS matched, approved); `between`
 * runs after the start, before the join is prepared (prepare() is where it folds).
 */
async function approvalJoin(w: World, a: Device, x: Device, between: () => Promise<void>) {
  const join = await ApprovalJoin.start(x.engine, {
    session: await w.server.session(EMAIL),
    deviceName: "X",
    email: EMAIL,
  });
  const approver = await Approver.start(a.engine, join.requestId, w.password);
  await join.poll();
  const sas = (await join.submitPairingCode(approver.pairingCode)) as { sas: string };
  await approver.poll(w.password);
  expect(await approver.submitSas(sas.sas, w.password)).toEqual({ kind: "approved" });
  expect(await join.poll()).toEqual({ kind: "approved" });
  await between();
  return { join };
}

describe("patch revision 6: the approval join folds again at the prepare (R5R-1)", () => {
  it("a locked start with an unparked entry it cannot fold refuses (locked) before anything is sent or written: no pending identity, no request", async () => {
    const w = await worldOf(1, ["GitHub", "AWS"]);
    const x = await ownVault(w);
    const vk = await x.vk();
    await plant(x, [await pushableOf(withEntry(w, await x.vault(vk), "the start must not go on"), vk, 3, "nowhere")]);
    await x.lockNow();
    const session = await w.server.session(EMAIL);
    const reqs = w.server.requests.length;
    await expect(ApprovalJoin.start(x.engine, { session, deviceName: "X", email: EMAIL })).rejects.toMatchObject({
      code: "locked",
    });
    expect(w.server.requests.length).toBe(reqs); // no enrolment request
    expect(await x.local.identity.get()).toBeNull(); // no pending identity
    expect(entries(x)).toHaveLength(1);
  }, 60_000);

  it("an unparked entry that came after the start (the only copy of a save): the prepare folds it, so the join carries the save into the cloud vault", async () => {
    const w = await worldOf(1, ["GitHub", "AWS"]);
    const a = w.devices[0]!;
    const x = await ownVault(w);
    const vk = await x.vk();
    const { join } = await approvalJoin(w, a, x, async () => {
      await plant(x, [await pushableOf(withEntry(w, await x.vault(vk), "came after the start"), vk, 3, "nowhere")]);
    });
    expect(await commitJoin(await join.prepare())).toBe("enrolled");
    await quiesce(w, 8, [a, x]);
    expect(await names(x, await x.vk())).toContain("came after the start");
    expect(await headNames(w, await a.vk())).toContain("came after the start");
  }, 60_000);

  it("a parked entry the locked start could not open opens after the unlock: the prepare folds it (the start went on: nothing unparked was left)", async () => {
    const w = await worldOf(1, ["GitHub", "AWS"]);
    const a = w.devices[0]!;
    const x = await ownVault(w);
    const vk = await x.vk();
    await plant(x, [
      {
        ...(await pushableOf(withEntry(w, await x.vault(vk), "parked, opens after the unlock"), vk, 3, "nowhere")),
        parked: { reason: "schema", vkId: null, at: 1 },
      },
    ]);
    await x.lockNow();
    const { join } = await approvalJoin(w, a, x, () => x.svc.unlockWithPassword(XPW).then(() => undefined));
    expect(await commitJoin(await join.prepare())).toBe("enrolled");
    await quiesce(w, 8, [a, x]);
    expect(await headNames(w, await a.vk())).toContain("parked, opens after the unlock");
  }, 60_000);

  it("locked again at the prepare with an unparked entry: refused (locked), nothing prepared, the entry kept; cancel and start again folds it", async () => {
    const w = await worldOf(1, ["GitHub", "AWS"]);
    const a = w.devices[0]!;
    const x = await ownVault(w);
    const vk = await x.vk();
    const { join } = await approvalJoin(w, a, x, async () => {
      await plant(x, [await pushableOf(withEntry(w, await x.vault(vk), "kept through the refusal"), vk, 3, "nowhere")]);
      await x.lockNow();
    });
    await expect(join.prepare()).rejects.toMatchObject({ code: "locked" });
    expect(entries(x)).toHaveLength(1);
    await expect(join.prepare()).rejects.toMatchObject({ code: "stale" }); // one prepare per opened payload
    await join.cancel();
    await x.svc.unlockWithPassword(XPW);
    const again = await approvalJoin(w, a, x, async () => undefined); // requireOff: the unpinned pending identity is replaced
    expect(await commitJoin(await again.join.prepare())).toBe("enrolled");
    await quiesce(w, 8, [a, x]);
    expect(await headNames(w, await a.vk())).toContain("kept through the refusal");
  }, 60_000);
});

describe("patch revision 6: the turn-off and the live outbox (R5R-2)", () => {
  it("the active slot on disk holds the outbox's generation (intact, the same checksum): the outbox goes with the records", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    w.advance(1000);
    await a.add("in the active generation");
    expect(outboxOf(a)).not.toBeNull();
    await a.local.turnOff();
    expect([...a.disk.kv.data.keys()].filter((k) => k.startsWith("sk_sync"))).toEqual([]);
  }, 60_000);

  it("the active slot fails its integrity check, although its checksum field is the outbox's: the outbox is moved into the list, never deleted", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    w.advance(1000);
    await a.add("only in the outbox if the slot is bad");
    const ob = outboxOf(a)!;
    const kv = a.disk.kv;
    const ptr = kv.data.get(KEYS.active) as "a" | "b";
    const slot = JSON.parse(JSON.stringify(kv.data.get(KEYS.slot[ptr]))) as {
      envelope: { ciphertext: string; checksum: string };
    };
    expect(slot.envelope.checksum).toBe(ob.checksum);
    const c = slot.envelope.ciphertext;
    slot.envelope.ciphertext = (c[0] === "A" ? "B" : "A") + c.slice(1); // a bit flip: the checksum field kept, the content not
    kv.data.set(KEYS.slot[ptr], slot);
    await a.local.turnOff();
    expect([...kv.data.keys()].filter((k) => k.startsWith("sk_sync"))).toEqual([SYNC_KEYS.orphan]);
    expect(entries(a)).toEqual([ob]);
  }, 60_000);
});
