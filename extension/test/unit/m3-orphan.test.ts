// The orphaned outbox (SYNC-DESIGN revision 19, §4.7, §4.1 D1, §8.2; M3RR-3, the design owner's rule): after a storage
// recovery the store's hook keeps the outbox, unchanged, in sk_sync_orphan. It is pushed only while the server is at its
// (base, head); a context holding the key folds it as this device's own earlier state before any other decision; it is
// retired only by the push's 200, by the write that sets lastSynced after a round that folded it, or when the active
// generation is the one it was written for. Every case asserts that the save the user was told about ends up on every
// device and in the head.
import { describe, expect, it } from "vitest";
import type { Vk } from "../../src/core/crypto/vk";
import { KEYS } from "../../src/core/storage/format";
import { MergeBlocked } from "../../src/core/service/sync-flows";
import { writeProof } from "../../src/core/sync/crypto/subkeys";
import { utf8 } from "../../src/core/crypto/bytes";
import { encryptVault } from "../../src/core/crypto/envelope";
import {
  adoptWithSecret,
  changePassword,
  commitRotation,
  prepareRotation,
  revokeDevice,
  turnSyncOff,
} from "../../src/core/sync/engine/keys";
import { commitJoin, joinWithRecoveryCode } from "../../src/core/sync/engine/enroll";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { uploadEnvelope } from "../../src/core/sync/local/outbox";
import { lastSyncedOf } from "../../src/core/sync/local/state";
import { discardParkedOrphans, readParkedOrphans } from "../../src/core/sync/engine/orphans";
import { aliveEntries, type Vault } from "../../src/core/vault/model";
import { createClock } from "../../src/core/vault/hlc";
import { addEntry, deleteEntry, purgeEntry } from "../../src/core/vault/ops";
import { input } from "../helpers/m2-world";
import { tear } from "../helpers/faulty-kv";
import { serializeVault } from "../../src/core/vault/validate";
import { bulkEntries, cloneDisk, EMAIL, quiesce, worldOf, type Device, type World } from "../helpers/m3-world";

const names = async (d: Device, vk?: Vk) =>
  aliveEntries(await d.vault(vk))
    .map((e) => e.issuer)
    .sort();
const headNames = async (w: World, vk: Vk) =>
  aliveEntries((await w.serverVault(vk))!)
    .map((e) => e.issuer)
    .sort();
/** sk_sync_orphan's entries (revision 20: a list), or null when there is none. */
const orphanOf = (d: Device): Record<string, unknown>[] | null => {
  const v = d.disk.kv.data.get(SYNC_KEYS.orphan) as { items?: Record<string, unknown>[] } | undefined | null;
  return v && Array.isArray(v.items) && v.items.length ? v.items : null;
};
const puts = (w: World) => w.server.requests.filter((r) => r.op === "PUT /v1/vault" && r.status === 200).length;

function tearActive(d: Device): void {
  const kv = d.disk.kv;
  const ptr = kv.data.get(KEYS.active) as "a" | "b";
  kv.data.set(KEYS.slot[ptr], tear(kv.data.get(KEYS.slot[ptr])));
}

/** A dirty device: a save committed (the outbox written for it), then its active slot torn. */
async function dirtyTorn(w: World, d: Device, save: string): Promise<void> {
  w.advance(1000);
  await d.add(save);
  expect(d.disk.kv.data.get(SYNC_KEYS.outbox)).toBeTruthy(); // the save lives in the outbox and in the slot about to tear
  tearActive(d);
  d.restartWorker();
}

async function everywhere(w: World, save: string, vk: Vk): Promise<void> {
  for (const d of w.devices) expect(await names(d, vk), d.name).toContain(save);
  expect(await headNames(w, vk)).toContain(save);
}

/** `vault` with one more account, added by this device's clock (an orphan holds this device's own earlier saves). */
const withEntry = (w: World, vault: Vault, issuer: string): Vault =>
  addEntry(vault, input(issuer), createClock("eeee", { now: () => w.clock.now })).vault;

/** An orphan record as the hook would have kept it: `vault` under `vk`, built on (base, head). */
async function plant(d: Device, vault: Vault, vk: Vk, base: number, head: string, checksum = "planted"): Promise<void> {
  const up = await uploadEnvelope(vault, vk, { vaultId: vault.vaultId, rev: base + 1 });
  const proof = await writeProof(vk, { vaultId: vault.vaultId, ifVersion: base, checksum: up.envelope.checksum });
  d.disk.kv.data.set(SYNC_KEYS.orphan, {
    v: 1,
    items: [{ v: 1, base, head, from: { version: base, head, checksum }, checksum, envelope: up.text, proof }],
  });
}

describe("revision 19: the orphaned outbox", () => {
  it("unlocked: a dirty slot torn; the worker round folds the orphan first, uploads, and retires it in the write that sets lastSynced", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    await dirtyTorn(w, a, "saved, then torn");
    const r = await a.engine.round();
    expect(r).toMatchObject({ status: "ok", uploaded: true });
    expect(orphanOf(a)).toBeNull();
    expect(lastSyncedOf(a.disk.kv.data.get(SYNC_KEYS.state))).not.toBeNull();
    await quiesce(w);
    await everywhere(w, "saved, then torn", vk);
  }, 60_000);

  it("locked, the server moved on meanwhile: the orphan's push is not made (another head) and it is kept; unlocked, it is folded and uploaded", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("A's save");
    await a.lockNow();
    await b.add("B moved the server");
    await b.engine.round();
    tearActive(a);
    a.restartWorker();
    const p0 = puts(w);
    expect((await a.engine.round()).status).toBe("locked");
    expect(puts(w)).toBe(p0);
    expect(orphanOf(a)).not.toBeNull(); // kept: merge-only from now on
    await a.unlock();
    await quiesce(w);
    await everywhere(w, "A's save", vk);
    await everywhere(w, "B moved the server", vk);
    expect(orphanOf(a)).toBeNull();
  }, 60_000);

  it("the orphan's push answered 409 (the server moved between the status and the PUT): kept, folded later", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("A's save");
    await a.lockNow();
    tearActive(a);
    a.restartWorker();
    const aid = ((await a.local.identity.get()) as { deviceId: string }).deviceId;
    w.server.fault({
      match: (k, req) =>
        k === "PUT /v1/vault" &&
        Object.entries(req.headers).some(([h, v]) => h.toLowerCase() === "sixkey-device" && v === aid),
      kind: "hook",
      fn: async () => {
        await b.add("B in the race");
        await b.engine.round();
      },
    });
    expect((await a.engine.round()).status).toBe("locked");
    expect(orphanOf(a)).not.toBeNull();
    await a.unlock();
    await quiesce(w);
    await everywhere(w, "A's save", vk);
    await everywhere(w, "B in the race", vk);
  }, 60_000);

  it("a second tear before the upload: the fold alone does not retire the orphan, so the save survives the second tear too", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    await dirtyTorn(w, a, "survives two tears");
    a.net.inject({ match: "PUT /v1/vault", kind: "fail_before" });
    expect((await a.engine.round()).status).toBe("offline"); // folded locally, the upload failed
    expect(orphanOf(a)).not.toBeNull(); // not retired by the fold
    tearActive(a); // the fold's generation torn too
    a.restartWorker();
    await quiesce(w);
    await everywhere(w, "survives two tears", vk);
    expect(orphanOf(a)).toBeNull();
  }, 60_000);

  it("a local edit after the tear (before any round) does not delete the orphan; both saves arrive", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    await dirtyTorn(w, a, "before the tear");
    await a.svc.status(); // the popup opens: the recovery (the hook keeps the orphan)
    w.advance(1000);
    await a.add("after the tear"); // the outbox writer, with lastSynced null: no outbox, the orphan untouched
    expect(orphanOf(a)).not.toBeNull();
    await quiesce(w);
    await everywhere(w, "before the tear", vk);
    await everywhere(w, "after the tear", vk);
  }, 60_000);

  it("a guard block on the fold: review_needed, the orphan kept; the answer folds it, and the round retires it", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const vk = await a.vk();
    const aws = (await a.vault()).entries.find((e) => e.issuer === "AWS")!.id;
    w.advance(1000);
    await a.svc.mutate((v, c) => purgeEntry(deleteEntry(v, aws, c), aws, c)); // this device erased AWS in one step
    tearActive(a);
    a.restartWorker();
    const r = await a.engine.round();
    expect(r.status).toBe("review_needed");
    expect(r.blocked!.report.purgedAlive).toEqual([aws]);
    expect(orphanOf(a)).not.toBeNull();
    const r2 = await a.engine.round({ answer: { seen: r.blocked!.seen, accept: [aws] } });
    expect(r2.status).toBe("ok");
    expect(orphanOf(a)).toBeNull();
    await quiesce(w);
    expect(await names(b, vk)).not.toContain("AWS");
    expect(
      ((await a.engine.view()).state.notices ?? []).filter((x) => x.kind === "deleted_remotely" && x.danger),
    ).toEqual([]); // its own deletion
  }, 60_000);

  it("turning sync off with an orphan: folded into the vault that stays, then deleted with the other sync records", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    await dirtyTorn(w, a, "kept after turning off");
    await a.svc.status(); // the recovery (the popup)
    await turnSyncOff(a.engine, w.password);
    expect((await a.local.status()).kind).toBe("off");
    expect(orphanOf(a)).toBeNull();
    expect(await names(a)).toContain("kept after turning off");
  }, 60_000);

  it("turning sync off while locked with an orphan is refused (locked) before anything is revoked; unlocked, it folds and goes ahead", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    w.advance(1000);
    await a.add("kept through a locked turn-off");
    await a.lockNow();
    tearActive(a);
    a.restartWorker();
    await a.svc.status();
    expect(orphanOf(a)).not.toBeNull();
    const revokes = () =>
      w.server.requests.filter((r) => r.op.startsWith("POST /v1/devices/") && r.op.endsWith("/revoke")).length;
    const r0 = revokes();
    await expect(turnSyncOff(a.engine, w.password)).rejects.toMatchObject({ code: "locked" });
    expect(revokes()).toBe(r0);
    expect((await a.local.status()).kind).toBe("on");
    await a.unlock();
    await turnSyncOff(a.engine, w.password);
    expect((await a.local.status()).kind).toBe("off");
    expect(await names(a)).toContain("kept through a locked turn-off");
  }, 60_000);

  it("a revoked device with an orphan: the fold happens before the status says rejected; removing the identity keeps the save", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const aid = ((await a.local.identity.get()) as { deviceId: string }).deviceId;
    await revokeDevice(b.engine, aid, w.password);
    await dirtyTorn(w, a, "saved before learning of the revocation");
    expect((await a.engine.round()).status).toBe("rejected_by_server");
    expect(await names(a)).toContain("saved before learning of the revocation"); // folded in step 0
    const { removeSyncIdentity } = await import("../../src/core/sync/engine/keys");
    await removeSyncIdentity(a.engine);
    expect((await a.local.status()).kind).toBe("off");
    expect(await names(a)).toContain("saved before learning of the revocation");
  }, 60_000);

  it("a revoked device, locked, with an orphan: removing the identity is refused (locked) and the orphan kept; unlocked, it folds and goes ahead", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const aid = ((await a.local.identity.get()) as { deviceId: string }).deviceId;
    w.advance(1000);
    await a.add("kept through a locked removal");
    await a.lockNow();
    tearActive(a);
    a.restartWorker();
    await a.svc.status();
    await revokeDevice(b.engine, aid, w.password);
    expect((await a.engine.round()).status).toBe("rejected_by_server");
    const { removeSyncIdentity } = await import("../../src/core/sync/engine/keys");
    await expect(removeSyncIdentity(a.engine)).rejects.toMatchObject({ code: "locked" });
    expect(orphanOf(a)).not.toBeNull();
    expect((await a.local.status()).kind).not.toBe("off");
    await a.unlock();
    await removeSyncIdentity(a.engine);
    expect((await a.local.status()).kind).toBe("off");
    expect(await names(a)).toContain("kept through a locked removal");
  }, 60_000);

  it("an orphan under a newer key than the recovered keyring (FIXa2): kept while it cannot be opened, folded once the adoption brings the key", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const before = cloneDisk(a.disk); // A on VK1
    await commitRotation(b.engine, await prepareRotation(b.engine, w.password));
    expect((await a.engine.round()).status).toBe("needs_password");
    await adoptWithSecret(a.engine, { password: w.password }); // A on VK2
    await a.engine.round();
    const vk2 = await a.vk();
    const head = w.server.account(EMAIL).vault!;
    const mine = await a.vault(vk2);
    const save = withEntry(w, mine, "only in the orphan (VK2)");
    // the rollback: A's storage back to its VK1 state (a keyring change undone by FIXa2), the VK2 outbox kept as the orphan
    for (const [k, v] of before.kv.data) a.disk.kv.data.set(k, structuredClone(v));
    a.disk.session.data = before.session.data ? { ...before.session.data } : null;
    await plant(a, save, vk2, head.version, head.head);
    a.restartWorker();
    const r = await a.engine.round();
    expect(r.status).toBe("needs_password");
    expect(orphanOf(a)).not.toBeNull(); // VK2 is not in VK1's keyring: kept, never removed here
    expect(await adoptWithSecret(a.engine, { password: w.password })).toMatchObject({ kind: "adopted" });
    expect(await names(a, vk2)).toContain("only in the orphan (VK2)"); // the adoption's own fold, before any round
    await quiesce(w);
    await everywhere(w, "only in the orphan (VK2)", vk2);
    expect(orphanOf(a)).toBeNull();
  }, 60_000);

  it("R3 with an orphan under the old key: the adoption of the new key folds it (it opens through the previous list) and the save reaches the rotated head", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    w.advance(1000);
    await a.add("A's save under VK1");
    await a.lockNow();
    tearActive(a);
    a.restartWorker();
    await a.svc.status(); // the recovery: the orphan (under VK1)
    expect(orphanOf(a)).not.toBeNull();
    await commitRotation(b.engine, await prepareRotation(b.engine, w.password));
    expect((await a.engine.round()).status).toBe("needs_password"); // locked: nothing folds, the orphan is not pushed (another head)
    expect(orphanOf(a)).not.toBeNull();
    // still locked: the user types the password into the adoption (the unlock with sync, R3); the adoption's own fold
    expect(await adoptWithSecret(a.engine, { password: w.password })).toMatchObject({ kind: "adopted", sameVk: false });
    expect(await names(a)).toContain("A's save under VK1");
    await quiesce(w);
    const vk2 = await b.vk();
    await everywhere(w, "A's save under VK1", vk2);
    expect(orphanOf(a)).toBeNull();
  }, 60_000);

  it("a cloud restore over a lost vault: the outbox kept as the orphan at the restore's write and folded into the restored vault", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("the lost vault's last save");
    await a.lockNow();
    // every copy of the vault unreadable (the store reports "lost"); the outbox, with the last save, still there
    for (const k of [KEYS.slot.a, KEYS.slot.b, KEYS.keyringCopy]) a.disk.kv.data.set(k, { torn: "x" });
    for (const k of [...a.disk.kv.data.keys()]) if (k.startsWith("sk_snap")) a.disk.kv.data.delete(k);
    a.disk.mirror.data.clear();
    expect(a.disk.kv.data.get(SYNC_KEYS.outbox)).toBeTruthy();
    a.restartWorker();
    expect((await a.svc.status()).state).toBe("lost");
    expect(await adoptWithSecret(a.engine, { password: w.password })).toMatchObject({ kind: "adopted" });
    expect(await names(a)).toContain("the lost vault's last save");
    await quiesce(w);
    await everywhere(w, "the lost vault's last save", vk);
  }, 60_000);

  it("a join over an unfinished one (M3R-9's undo): the orphan folded before the undo and the join, so the joined vault has it", async () => {
    const w = await worldOf(1, ["GitHub"]);
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
    const withSave = withEntry(w, mine, "in N's orphan");
    const head = w.server.account(EMAIL).vault!;
    await plant(n, withSave, vk, head.version, head.head);
    w.advance(11 * 60_000);
    await n.unlock();
    const plan2 = await joinWithRecoveryCode(n.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "N",
      email: EMAIL,
    });
    expect(await commitJoin(plan2)).toBe("enrolled");
    await quiesce(w);
    await everywhere(w, "in N's orphan", vk);
  }, 60_000);

  it("a damaged orphan record is removed; an orphan for the active generation itself (the recovery lost nothing) is retired", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    a.disk.kv.data.set(SYNC_KEYS.orphan, { v: 1, garbage: true });
    await a.engine.round();
    expect(orphanOf(a)).toBeNull();
    const vk = await a.vk();
    const g = await a.generation();
    const head = w.server.account(EMAIL).vault!;
    await plant(a, await a.vault(vk), vk, head.version, head.head, g.envelope.checksum);
    const p0 = puts(w);
    expect((await a.engine.round()).status).toBe("ok");
    expect(orphanOf(a)).toBeNull();
    expect(puts(w)).toBe(p0);
  }, 60_000);

  it("an orphan under a key no keyring here lists: removed with one orphan_unreadable notice once a full round confirmed the key chain", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    const { generateVk } = await import("../../src/core/crypto/vk");
    const lost = await generateVk();
    const head = w.server.account(EMAIL).vault!;
    await plant(a, await a.vault(), lost, head.version, head.head);
    await a.engine.round();
    expect(orphanOf(a)).toBeNull();
    expect(((await a.engine.view()).state.notices ?? []).filter((x) => x.kind === "orphan_unreadable").length).toBe(1);
  }, 60_000);

  it("startOver over a lost vault: the orphan of the old vault is kept, parked as another vault's, never pushed, until the user deletes it; a locked round keeps another vault's orphan too and pushes nothing (revision 24)", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    w.advance(1000);
    await a.add("in the lost vault");
    for (const k of [KEYS.slot.a, KEYS.slot.b, KEYS.keyringCopy]) a.disk.kv.data.set(k, { torn: "x" });
    for (const k of [...a.disk.kv.data.keys()]) if (k.startsWith("sk_snap")) a.disk.kv.data.delete(k);
    a.disk.mirror.data.clear();
    a.restartWorker();
    expect((await a.svc.status()).state).toBe("lost");
    await a.svc.startOver(await a.svc.prepareKeys(w.password)); // the user confirmed: a new vault (a new vault id)
    expect(orphanOf(a)).not.toBeNull(); // the hook kept the lost vault's outbox
    const p0 = puts(w);
    await a.engine.round();
    expect(orphanOf(a)).toHaveLength(1); // the fold: another vault's envelope (wrong_vault), kept
    expect((orphanOf(a)![0]!.parked as { reason?: string } | undefined)?.reason).toBe("vault");
    expect(puts(w)).toBe(p0);
    await a.engine.round(); // and again: still kept, and it no longer holds sync up
    expect(orphanOf(a)).toHaveLength(1);
    const shown = await readParkedOrphans(a.engine.deps.kv, a.engine.deps.vaultLock);
    expect(shown).toMatchObject({ count: 1, reasons: ["vault"] });
    expect(await discardParkedOrphans({ kv: a.engine.deps.kv, vaultLock: a.engine.deps.vaultLock }, shown!)).toBe(1); // the user's "Advanced" delete
    expect(orphanOf(a)).toBeNull();
    // locked: an orphan whose envelope names another vault id is removed without a push
    const b = w.devices[1]!;
    const vk = await b.vk();
    const head = w.server.account(EMAIL).vault!;
    await plant(
      b,
      { ...(await b.vault(vk)), vaultId: "00000000-0000-4000-8000-000000000000" },
      vk,
      head.version,
      head.head,
    );
    await b.lockNow();
    b.restartWorker();
    const p1 = puts(w);
    expect((await b.engine.push()).status).toBe("locked");
    expect(orphanOf(b)).toHaveLength(1);
    expect(puts(w)).toBe(p1);
  }, 60_000);

  it("a profile holding only sync records (an orphan among them) opens as empty: none of them is vault data", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const a = w.devices[0]!;
    w.advance(1000);
    await a.add("x");
    await a.lockNow();
    tearActive(a);
    a.restartWorker();
    await a.svc.status();
    expect(orphanOf(a)).not.toBeNull();
    for (const k of [...a.disk.kv.data.keys()])
      if (k.startsWith("sk_slot") || k.startsWith("sk_snap") || k === KEYS.active || k === KEYS.keyringCopy)
        a.disk.kv.data.delete(k);
    a.disk.mirror.data.clear();
    a.restartWorker();
    expect((await a.svc.status()).state).toBe("empty");
  }, 60_000);

  it("an entry no round can open now (a newer schema, after a downgrade) is parked (R3R-4): sync goes on (lastSynced set, no full pull every round, the outbox written, a rotation works), the entry is kept and retried", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    const vaultId = (await a.generation()).keyring.vaultId;
    const head = w.server.account(EMAIL).vault!;
    const env = await encryptVault(utf8(JSON.stringify({ schemaVersion: 2, vaultId, entries: [] })), vk, {
      vaultId,
      rev: head.version + 1,
    });
    a.disk.kv.data.set(SYNC_KEYS.orphan, {
      v: 1,
      items: [
        {
          v: 1,
          base: head.version - 1,
          head: "elsewhere",
          from: { version: head.version - 1, head: "elsewhere", checksum: "x" },
          checksum: "newer",
          envelope: JSON.stringify(env),
          proof: "p",
        },
      ],
    });
    const st = a.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>;
    a.disk.kv.data.set(SYNC_KEYS.state, { ...st, lastSynced: null });
    expect((await a.engine.round()).status).toBe("ok");
    expect(orphanOf(a)?.map((x) => (x.parked as { reason: string }).reason)).toEqual(["schema"]); // kept for a newer build, parked
    expect(lastSyncedOf(a.disk.kv.data.get(SYNC_KEYS.state))).not.toBeNull(); // the parked entry does not hold sync up
    const pulls = () => w.server.requests.filter((r) => r.op === "GET /v1/vault").length;
    const p0 = pulls();
    w.advance(60_000);
    expect((await a.engine.round()).status).toBe("ok");
    expect(pulls()).toBe(p0); // in sync: no full pull
    w.advance(1000);
    await a.add("a save while the entry is parked");
    expect((a.disk.kv.data.get(SYNC_KEYS.outbox) as { proof?: string } | undefined)?.proof).toBeTruthy(); // a pushable outbox again
    await a.lockNow();
    expect((await a.engine.push()).pushedOutbox).toBe(true); // "lock every time" works
    await a.unlock();
    await commitRotation(a.engine, await prepareRotation(a.engine, w.password)); // never not_synced for a parked entry
    const b = w.devices[1]!;
    expect((await b.engine.round()).status).toBe("needs_password");
    expect(await adoptWithSecret(b.engine, { password: w.password })).toMatchObject({ kind: "adopted" });
    await quiesce(w);
    await everywhere(w, "a save while the entry is parked", await a.vk());
    expect(orphanOf(a)?.map((x) => x.checksum)).toEqual(["newer"]); // still kept, retried by every round
  }, 60_000);

  it("the orphan is not pushed when the server is at its base version with another head (D5: a rollback reused the version)", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const vk = await a.vk();
    const snap = w.server.snapshot(); // the server before the orphan's base
    w.advance(1000);
    await b.add("B's write at the base version");
    await b.engine.round();
    await a.engine.round(); // A in sync at the base (version v, head h)
    w.advance(1000);
    await a.add("A's save");
    await a.lockNow();
    tearActive(a);
    a.restartWorker();
    await a.svc.status(); // the orphan on (v, h)
    w.server.restore(snap); // an honest PITR to v - 1
    w.advance(1000);
    await b.add("B again, the same version number, another head");
    await b.engine.round(); // version v again, another head
    const p0 = puts(w);
    expect((await a.engine.push()).status).toBe("locked");
    expect(puts(w)).toBe(p0); // never pushed over a head it was not built on
    expect(orphanOf(a)).not.toBeNull();
    await a.unlock();
    await quiesce(w);
    await everywhere(w, "A's save", vk);
    await everywhere(w, "B again, the same version number, another head", vk);
  }, 60_000);

  it("an orphan under a key this device does not hold is not dropped while the keys are not confirmed (a password changed elsewhere: needs_new_password); dropped with the notice once they are", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const { generateVk } = await import("../../src/core/crypto/vk");
    const lost = await generateVk();
    const head = w.server.account(EMAIL).vault!;
    await plant(a, await a.vault(), lost, head.version + 5, "not the head");
    await changePassword(b.engine, w.password, `${w.password}-new`);
    const r = await a.engine.round();
    expect(r.keyStatus).toBe("needs_new_password");
    expect(orphanOf(a)).not.toBeNull(); // the chain is not confirmed yet
    expect(((await a.engine.view()).state.notices ?? []).some((x) => x.kind === "orphan_unreadable")).toBe(false);
    expect(await adoptWithSecret(a.engine, { password: `${w.password}-new` })).toMatchObject({ kind: "adopted" });
    await a.engine.round();
    expect(orphanOf(a)).toBeNull();
    expect(((await a.engine.view()).state.notices ?? []).filter((x) => x.kind === "orphan_unreadable").length).toBe(1);
  }, 60_000);

  it("a fold that would pass 50 000 entries (the third review's RV-08) keeps the orphan: too_large is not a reason to drop a save", async () => {
    // reachable through a big import torn before its upload and local adds after the recovery; the remote is planted
    // without the upload padding, as the D7 test does (only a holder of the VK can make it)
    const w = await worldOf(2, ["GitHub"], [], { validateWire: false });
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    const g = await a.generation();
    const vaultId = g.keyring.vaultId;
    const head = w.server.account(EMAIL).vault!;
    const mine = await a.vault(vk);
    const big: Vault = {
      ...mine,
      entries: [...mine.entries, ...bulkEntries(49_000, "imported", w.clock.now - 1000)].sort((x, y) =>
        x.id < y.id ? -1 : 1,
      ),
    };
    const env = await encryptVault(serializeVault(big), vk, { vaultId, rev: head.version + 1 });
    a.disk.kv.data.set(SYNC_KEYS.orphan, {
      v: 1,
      items: [
        {
          v: 1,
          base: head.version,
          head: "elsewhere",
          from: { version: head.version, head: "elsewhere", checksum: "x" },
          checksum: "big",
          envelope: JSON.stringify(env),
          proof: "p",
        },
      ],
    });
    const st = a.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>;
    a.disk.kv.data.set(SYNC_KEYS.state, { ...st, lastSynced: null });
    w.advance(1000);
    await a.svc.mutate((v) => ({
      ...v,
      entries: [...v.entries, ...bulkEntries(1500, "after", w.clock.now - 500, { device: "aftrrr" })].sort((x, y) =>
        x.id < y.id ? -1 : 1,
      ),
    }));
    await a.engine.round();
    expect(orphanOf(a)?.map((x) => [x.checksum, (x.parked as { reason?: string } | undefined)?.reason])).toEqual([
      ["big", "too_large"],
    ]); // kept, parked (rev. 20)
    expect(aliveEntries(await a.vault()).length).toBe(1 + 1500); // nothing half-merged
  }, 180_000);

  it("the popup never folds (it has no engine): only a context with the key does; MergeBlocked in a flow is the user's to answer", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const aws = (await a.vault()).entries.find((e) => e.issuer === "AWS")!.id;
    w.advance(1000);
    await a.svc.mutate((v, c) => purgeEntry(deleteEntry(v, aws, c), aws, c));
    tearActive(a);
    await a.svc.status(); // the popup's open: the recovery, nothing folded
    expect(orphanOf(a)).not.toBeNull();
    expect(await names(a)).toContain("AWS");
    await expect(turnSyncOff(a.engine, w.password)).rejects.toBeInstanceOf(MergeBlocked); // the turn-off asks first
    expect((await a.local.status()).kind).toBe("on"); // nothing revoked or deleted yet
  }, 60_000);
});
