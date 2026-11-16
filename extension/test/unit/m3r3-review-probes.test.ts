// The third M3 review's probes (M3-R3-REVIEW; that report was not retained, its findings are in docs/design/notes/M3-NOTES.md §0b): attacks on revision 3's
// orphaned outbox (SYNC-DESIGN rev. 19
// §4.7) and the departures the implementer made from it. Each test asserts what the design promises: "an acknowledged
// save is never lost". A test named "FINDING" fails on the patch as reviewed.
// Adopted into M3 (revision 4), with SYNC-DESIGN revision 20's rules in: the FINDING tests (R3R-1, -1b, -1d, -2b, -5, -7)
// must pass; R3R-3 asserts vault_lost and R3R-4 the parked behaviour (revision 20). The orphan is a list there
// (`{v: 1, items}`), so the records these tests plant are wrapped in one; nothing else of the reviewer's text changed.
import { describe, expect, it } from "vitest";
import type { Vk } from "../../src/core/crypto/vk";
import { KEYS } from "../../src/core/storage/format";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { lastSyncedOf } from "../../src/core/sync/local/state";
import { uploadEnvelope } from "../../src/core/sync/local/outbox";
import { writeProof } from "../../src/core/sync/crypto/subkeys";
import { aliveEntries, type Vault } from "../../src/core/vault/model";
import { tear } from "../helpers/faulty-kv";
import { cloneDisk, EMAIL, quiesce, worldOf, type Device, type World } from "../helpers/m3-world";

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
const outboxOf = (d: Device) => d.disk.kv.data.get(SYNC_KEYS.outbox) ?? null;

function tearActive(d: Device): void {
  const kv = d.disk.kv;
  const ptr = kv.data.get(KEYS.active) as "a" | "b";
  kv.data.set(KEYS.slot[ptr], tear(kv.data.get(KEYS.slot[ptr])));
}

async function plant(d: Device, vault: Vault, vk: Vk, base: number, head: string, checksum = "planted"): Promise<void> {
  const up = await uploadEnvelope(vault, vk, { vaultId: vault.vaultId, rev: base + 1 });
  const proof = await writeProof(vk, { vaultId: vault.vaultId, ifVersion: base, checksum: up.envelope.checksum });
  d.disk.kv.data.set(SYNC_KEYS.orphan, {
    v: 1,
    items: [{ v: 1, base, head, from: { version: base, head, checksum }, checksum, envelope: up.text, proof }],
  });
}

describe("M3-R3 review probes", () => {
  it("R3R-1 (FINDING): lock every time, the server moved on, the locked push drops the stale outbox; a later tear of the dirty slot loses the save", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("A's acknowledged save");
    expect(outboxOf(a)).toBeTruthy();
    await a.lockNow(); // "lock every time": the worker never holds the key
    w.advance(1000);
    await b.add("B moved the server");
    await b.engine.round();
    a.restartWorker();
    expect((await a.engine.push()).status).toBe("locked"); // built on a head the server no longer has: dropped (D5)
    expect(outboxOf(a)).toBeNull(); // on this patch the save now lives only in the active slot (and a rolling snapshot no path reads)
    tearActive(a); // the dirty device's slot tears before the next unlocked round (weeks, in this mode)
    a.restartWorker();
    await a.svc.status(); // the popup opens: the recovery
    // (on this patch the hook finds no outbox to keep: no orphan)
    await a.unlock();
    await quiesce(w);
    expect(await names(a, vk)).toContain("A's acknowledged save");
    expect(await headNames(w, vk)).toContain("A's acknowledged save");
  }, 60_000);

  it("R3R-1b (FINDING): the same with the push's 409 (the server moved between the status and the PUT)", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("A's acknowledged save");
    await a.lockNow();
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
    expect((await a.engine.push()).status).toBe("locked");
    w.server.clearFaults();
    expect(outboxOf(a)).toBeNull(); // 409: dropped
    tearActive(a);
    a.restartWorker();
    await a.svc.status();
    await a.unlock();
    await quiesce(w);
    expect(await headNames(w, vk)).toContain("A's acknowledged save");
  }, 60_000);

  /** A on VK1 again (a storage rollback past its adoption of VK2) with an orphan under VK2 holding the only copy of a save. */
  async function fixa2(): Promise<{ w: World; a: Device; vk2: Vk }> {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const { adoptWithSecret, commitRotation, prepareRotation } = await import("../../src/core/sync/engine/keys");
    const { addEntry } = await import("../../src/core/vault/ops");
    const { createClock } = await import("../../src/core/vault/hlc");
    const { input } = await import("../helpers/m2-world");
    const before = cloneDisk(a.disk); // A on VK1
    await commitRotation(b.engine, await prepareRotation(b.engine, w.password));
    expect((await a.engine.round()).status).toBe("needs_password");
    await adoptWithSecret(a.engine, { password: w.password });
    await a.engine.round();
    const vk2 = await a.vk();
    const head = w.server.account(EMAIL).vault!;
    const save = addEntry(
      await a.vault(vk2),
      input("only in the orphan (VK2)"),
      createClock("eeee", { now: () => w.clock.now }),
    ).vault;
    for (const [k, v] of before.kv.data) a.disk.kv.data.set(k, structuredClone(v));
    a.disk.session.data = before.session.data ? { ...before.session.data } : null;
    await plant(a, save, vk2, head.version, head.head);
    a.restartWorker();
    expect((await a.engine.round()).status).toBe("needs_password");
    expect(orphanOf(a)).not.toBeNull(); // kept, as §4.7 says, until an adoption brings VK2
    return { w, a, vk2 };
  }

  it("R3R-2a (fine): unlocked on VK1 with a VK2 orphan the fold must keep, turnSyncOff is refused by the pre-send check (needs_adoption) and the orphan stays", async () => {
    const { w, a } = await fixa2();
    const { turnSyncOff } = await import("../../src/core/sync/engine/keys");
    await expect(turnSyncOff(a.engine, w.password)).rejects.toMatchObject({ code: "needs_adoption" });
    expect(orphanOf(a)).not.toBeNull();
    expect((await a.local.status()).kind).toBe("on");
  }, 60_000);

  it("R3R-2b (FINDING, low): the same state, removeSyncIdentity (no password, no pre-send check) deletes the kept orphan unfolded", async () => {
    const { w, a, vk2 } = await fixa2();
    const { removeSyncIdentity } = await import("../../src/core/sync/engine/keys");
    let err: unknown = null;
    await removeSyncIdentity(a.engine).catch((e: unknown) => {
      err = e;
    });
    const off = (await a.local.status()).kind === "off";
    const saved =
      (await names(a)).includes("only in the orphan (VK2)") ||
      (await headNames(w, vk2)).includes("only in the orphan (VK2)");
    // §4.7: "打不开时保留，直到能打开". Either the removal refuses (the orphan kept), or the save survives.
    expect({ off, saved, orphanKept: orphanOf(a) !== null, err: err ? String(err) : null }).toEqual(
      expect.objectContaining({ orphanKept: true }),
    );
  }, 60_000);

  it("R3R-3: a lost vault with an orphan (an overwriteLost transact refused after the hook ran): removeSyncIdentity and turnSyncOff say vault_lost (revision 20), not locked", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const { removeSyncIdentity, turnSyncOff } = await import("../../src/core/sync/engine/keys");
    w.advance(1000);
    await a.add("the lost vault's last save");
    for (const k of [KEYS.slot.a, KEYS.slot.b, KEYS.keyringCopy]) a.disk.kv.data.set(k, { torn: "x" });
    for (const k of [...a.disk.kv.data.keys()]) if (k.startsWith("sk_snap")) a.disk.kv.data.delete(k);
    a.disk.mirror.data.clear();
    a.restartWorker();
    expect((await a.svc.status()).state).toBe("lost");
    // a flow writing over lost data whose function then refuses (the cloud restore's commitKeys: discontinuous,
    // different_vault, stale; a lost-mode commitJoin: bad_state): the hook ran first (revision 3's store change)
    await expect(
      a.ctx.store.transact(
        async () => {
          throw new Error("refused inside");
        },
        { overwriteLost: true },
      ),
    ).rejects.toThrow("refused inside");
    expect(orphanOf(a)).not.toBeNull();
    expect(lastSyncedOf(a.disk.kv.data.get(SYNC_KEYS.state))).toBeNull();
    expect(outboxOf(a)).toBeNull();
    expect((await a.svc.status()).state).toBe("lost"); // nothing else changed
    await expect(removeSyncIdentity(a.engine)).rejects.toMatchObject({ code: "vault_lost" });
    await expect(turnSyncOff(a.engine, w.password)).rejects.toMatchObject({ code: "vault_lost" });
    // the round errors (bad_state lost) every time; the locked push still works on the orphan
    expect((await a.engine.round()).status).toBe("error");
  }, 60_000);

  it("R3R-4: an orphan no round can fold (a newer schema) is parked (revision 20): lastSynced is set, rounds stop pulling the head, and the device can rotate (revoke and protect)", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const { encryptVault } = await import("../../src/core/crypto/envelope");
    const { utf8 } = await import("../../src/core/crypto/bytes");
    const { commitRotation, prepareRotation } = await import("../../src/core/sync/engine/keys");
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
    const pulls = () => w.server.requests.filter((r) => r.op === "GET /v1/vault").length;
    const p0 = pulls();
    for (let i = 0; i < 5; i++) {
      w.advance(60_000);
      expect((await a.engine.round()).status).toBe("ok");
    }
    const perRound = (pulls() - p0) / 5;
    expect(lastSyncedOf(a.disk.kv.data.get(SYNC_KEYS.state))).not.toBeNull();
    expect(orphanOf(a)?.length).toBe(1); // kept, parked
    let rot: unknown = null;
    try {
      await commitRotation(a.engine, await prepareRotation(a.engine, w.password));
    } catch (e) {
      rot = e;
    }
    // revision 20 (R3R-4): the first round folds what it can and parks the entry; after it, a quiet device pulls nothing
    expect({ perRound, rotation: rot ? ((rot as { code?: string }).code ?? String(rot)) : "done" }).toMatchObject({
      perRound: 0.2,
      rotation: "done",
    });
  }, 60_000);

  it("R3R-1d (FINDING): one device alone: a second popup save while the worker's push of the first is in flight leaves an outbox the next locked push drops; a tear then loses it", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("E1");
    await a.lockNow();
    a.restartWorker();
    const aid = ((await a.local.identity.get()) as { deviceId: string }).deviceId;
    // the popup (holding the key in "lock every time") commits E2 while the worker's locked PUT of E1's outbox is in flight
    w.server.fault({
      match: (k, req) =>
        k === "PUT /v1/vault" &&
        Object.entries(req.headers).some(([h, v]) => h.toLowerCase() === "sixkey-device" && v === aid),
      kind: "hook",
      count: 1,
      fn: async () => {
        await a.unlock();
        w.advance(500);
        await a.add("E2, saved during the push");
        await a.lockNow();
      },
    });
    expect((await a.engine.push()).pushedOutbox).toBe(true); // E1 reached the server; E2's outbox is now on a stale base
    w.server.clearFaults();
    a.restartWorker();
    await a.engine.push(); // the next locked push (a kick, or the 30-minute alarm): E2's outbox is stale
    tearActive(a); // E2's slot
    a.restartWorker();
    await a.svc.status();
    await a.unlock();
    await quiesce(w);
    expect(await headNames(w, vk)).toContain("E1");
    expect(await headNames(w, vk)).toContain("E2, saved during the push");
  }, 60_000);

  it("R3R-1c (severity): after R3R-1's loss the save is still in a rolling snapshot (no automatic path reads it); only 'find accounts' brings it back", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("A's acknowledged save");
    await a.lockNow();
    w.advance(1000);
    await b.add("B moved the server");
    await b.engine.round();
    a.restartWorker();
    await a.engine.push();
    tearActive(a);
    a.restartWorker();
    const st = await a.svc.status();
    const { decryptVault } = await import("../../src/core/crypto/envelope");
    const { deserializeVault } = await import("../../src/core/vault/validate");
    const snaps = [...a.disk.kv.data.entries()]
      .filter(([k]) => k.startsWith("sk_snap_") && k !== KEYS.snapIndex)
      .map(([, v]) => v as { envelope: Parameters<typeof decryptVault>[0] });
    let inSnapshot = false;
    for (const r of snaps) {
      try {
        if (
          aliveEntries(deserializeVault(await decryptVault(r.envelope, vk))).some(
            (e) => e.issuer === "A's acknowledged save",
          )
        )
          inSnapshot = true;
      } catch {
        /* another key */
      }
    }
    expect({ inSnapshot, events: (st as { events?: unknown[] }).events?.length ?? null }).toMatchObject({
      inSnapshot: true,
    });
  }, 60_000);

  it("R3R-5 (FINDING, medium): a save made after the first recovery (no outbox while lastSynced is null, the one orphan kept) is lost to a second tear before a keyed round", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("E1 before the first tear");
    await a.lockNow();
    tearActive(a);
    a.restartWorker();
    await a.svc.status(); // the first recovery: E1 kept as the orphan
    expect(orphanOf(a)).not.toBeNull();
    await a.unlock(); // the popup ("lock every time": the popup holds the key, it runs no round)
    w.advance(1000);
    await a.add("E2 after the first recovery");
    expect(outboxOf(a)).toMatchObject({ from: null }); // revision 20: lastSynced is null, so the merge-only outbox holds E2
    await a.lockNow();
    tearActive(a); // a second tear, of E2's slot
    a.restartWorker();
    await a.svc.status();
    await a.unlock();
    await quiesce(w);
    expect(await headNames(w, vk)).toContain("E1 before the first tear"); // the orphan works
    expect(await headNames(w, vk)).toContain("E2 after the first recovery");
  }, 60_000);

  it("R3R-6: a fold blocked by the guard inside the R3 adoption is swallowed; the next round shows it bound to the orphan's own digests, a digest of another version does not answer it", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const { adoptWithSecret, commitRotation, prepareRotation } = await import("../../src/core/sync/engine/keys");
    const { deleteEntry, purgeEntry } = await import("../../src/core/vault/ops");
    const aws = (await a.vault()).entries.find((e) => e.issuer === "AWS")!.id;
    w.advance(1000);
    await a.svc.mutate((v, c) => purgeEntry(deleteEntry(v, aws, c), aws, c)); // erased in one step: the fold will block
    await a.lockNow();
    tearActive(a);
    a.restartWorker();
    await a.svc.status();
    expect(orphanOf(a)).not.toBeNull();
    await commitRotation(b.engine, await prepareRotation(b.engine, w.password));
    expect((await a.engine.round()).status).toBe("needs_password");
    expect(await adoptWithSecret(a.engine, { password: w.password })).toMatchObject({ kind: "adopted", sameVk: false });
    expect(orphanOf(a)).not.toBeNull(); // the fold's block left for the round
    expect(await names(a)).toContain("AWS");
    const r = await a.engine.round();
    expect(r.status).toBe("review_needed");
    expect(r.blocked!.report.purgedAlive).toEqual([aws]);
    const wrong = { seen: { [aws]: "AAAA" + r.blocked!.seen[aws]!.slice(4) }, accept: [aws] };
    expect((await a.engine.round({ answer: wrong })).status).toBe("review_needed");
    expect(orphanOf(a)).not.toBeNull();
    const ok = await a.engine.round({ answer: { seen: r.blocked!.seen, accept: [aws] } });
    expect(ok.status).toBe("ok");
    expect(orphanOf(a)).toBeNull();
    await quiesce(w);
    expect(await names(b)).not.toContain("AWS");
  }, 60_000);

  it("R3R-7 (FINDING, low): an orphan of a newer schema (a downgrade) is deleted unfolded by turnSyncOff (orphanLockedOut says false: unlocked)", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const { encryptVault } = await import("../../src/core/crypto/envelope");
    const { utf8 } = await import("../../src/core/crypto/bytes");
    const { turnSyncOff } = await import("../../src/core/sync/engine/keys");
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
    await turnSyncOff(a.engine, w.password);
    expect(orphanOf(a)).not.toBeNull(); // "kept for a newer build" (fold) — but the turn-off deletes it with the records
  }, 60_000);

  // killers for this review's surviving mutants (they pass on the patch)
  const withSave = async (w: World, d: Device, issuer: string) => {
    const { addEntry } = await import("../../src/core/vault/ops");
    const { createClock } = await import("../../src/core/vault/hlc");
    const { input } = await import("../helpers/m2-world");
    const vk = await d.vk();
    const head = w.server.account(EMAIL).vault!;
    await plant(
      d,
      addEntry(await d.vault(vk), input(issuer), createClock("eeee", { now: () => w.clock.now })).vault,
      vk,
      head.version,
      head.head,
    );
  };

  it("RV-03 killer: an unfinished turn-off (cfg missing, the vault readable) folds the orphan before it finishes", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    await withSave(w, a, "only in the orphan");
    a.disk.kv.data.delete(SYNC_KEYS.cfg);
    a.restartWorker();
    expect((await a.engine.round()).status).toBe("off");
    expect(await names(a)).toContain("only in the orphan");
  }, 60_000);

  it("RV-04 killer: a round that stops at wrong_origin still folds the orphan first (§4.2 step 0)", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    await withSave(w, a, "only in the orphan");
    await a.local.identity.update((i) => ({ ...i, apiOrigin: "https://elsewhere.example" }));
    a.restartWorker();
    expect((await a.engine.round()).status).toBe("wrong_origin");
    expect(await names(a)).toContain("only in the orphan");
  }, 60_000);

  it("RV-12 killer: the orphan's push whose answer was lost is recognised by the next locked round (base+1, its own head) and retired while still locked", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("pushed, answer lost");
    await a.lockNow();
    tearActive(a);
    a.restartWorker();
    await a.svc.status();
    expect(orphanOf(a)).not.toBeNull();
    a.net.inject({ match: "PUT /v1/vault", kind: "lose_response" });
    await a.engine.push(); // delivered, the answer lost: the orphan kept
    expect(orphanOf(a)).not.toBeNull();
    expect(await headNames(w, vk)).toContain("pushed, answer lost");
    a.restartWorker();
    expect((await a.engine.push()).status).toBe("locked");
    expect(orphanOf(a)).toBeNull(); // retired without the key: the server holds exactly its text
  }, 60_000);

  it("RV-17 killer: an orphan's own deletions (three moved to the trash) raise no deleted-elsewhere notice", async () => {
    const w = await worldOf(2, ["GitHub", "AWS", "One", "Two", "Three"]);
    const [a] = w.devices as [Device, Device];
    const { deleteEntry } = await import("../../src/core/vault/ops");
    const ids = (await a.vault()).entries.filter((e) => ["One", "Two", "Three"].includes(e.issuer)).map((e) => e.id);
    w.advance(1000);
    await a.svc.mutate((v, c) => ids.reduce((x, id) => deleteEntry(x, id, c), v));
    await a.lockNow();
    tearActive(a);
    a.restartWorker();
    await a.svc.status();
    expect(orphanOf(a)).not.toBeNull();
    await a.unlock();
    expect((await a.engine.round()).status).toBe("ok");
    expect(orphanOf(a)).toBeNull();
    expect(((await a.engine.view()).state.notices ?? []).filter((x) => x.kind === "deleted_remotely")).toEqual([]);
  }, 60_000);

  it("RV-21 killer: turnSyncOff stopped by the guard on the orphan's fold has revoked nothing yet", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const { turnSyncOff } = await import("../../src/core/sync/engine/keys");
    const { MergeBlocked } = await import("../../src/core/service/sync-flows");
    const { deleteEntry, purgeEntry } = await import("../../src/core/vault/ops");
    const aws = (await a.vault()).entries.find((e) => e.issuer === "AWS")!.id;
    w.advance(1000);
    await a.svc.mutate((v, c) => purgeEntry(deleteEntry(v, aws, c), aws, c));
    tearActive(a);
    await a.svc.status();
    const revokes = () =>
      w.server.requests.filter((r) => r.op.startsWith("POST /v1/devices/") && r.op.endsWith("/revoke")).length;
    const r0 = revokes();
    await expect(turnSyncOff(a.engine, w.password)).rejects.toBeInstanceOf(MergeBlocked);
    expect(revokes()).toBe(r0);
    expect((await a.engine.round()).status).toBe("review_needed"); // still enrolled: the server answers this device
  }, 60_000);

  it("RV-23 killer: a lost vault's orphan (a refused write over it) is pushed by the locked worker while the server is at its base, never removed as another vault's", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("the lost vault's last save");
    await a.lockNow();
    for (const k of [KEYS.slot.a, KEYS.slot.b, KEYS.keyringCopy]) a.disk.kv.data.set(k, { torn: "x" });
    for (const k of [...a.disk.kv.data.keys()]) if (k.startsWith("sk_snap")) a.disk.kv.data.delete(k);
    a.disk.mirror.data.clear();
    a.restartWorker();
    await expect(
      a.ctx.store.transact(
        async () => {
          throw new Error("refused inside");
        },
        { overwriteLost: true },
      ),
    ).rejects.toThrow("refused inside");
    expect(orphanOf(a)).not.toBeNull();
    a.restartWorker();
    await a.engine.push();
    expect(await headNames(w, vk)).toContain("the lost vault's last save");
  }, 60_000);

  it("RV-22 killer: removeSyncIdentity stopped by the guard on the orphan's fold goes ahead with the user's answer", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const { removeSyncIdentity, revokeDevice } = await import("../../src/core/sync/engine/keys");
    const { MergeBlocked } = await import("../../src/core/service/sync-flows");
    const { deleteEntry, purgeEntry } = await import("../../src/core/vault/ops");
    const aid = ((await a.local.identity.get()) as { deviceId: string }).deviceId;
    await revokeDevice(b.engine, aid, w.password);
    const aws = (await a.vault()).entries.find((e) => e.issuer === "AWS")!.id;
    w.advance(1000);
    await a.svc.mutate((v, c) => purgeEntry(deleteEntry(v, aws, c), aws, c));
    tearActive(a);
    await a.svc.status();
    let blocked: InstanceType<typeof MergeBlocked> | null = null;
    await removeSyncIdentity(a.engine).catch((e: unknown) => {
      if (e instanceof MergeBlocked) blocked = e;
      else throw e;
    });
    expect(blocked).not.toBeNull();
    await removeSyncIdentity(a.engine, { answer: { seen: blocked!.seen, accept: [aws] } });
    expect((await a.local.status()).kind).toBe("off");
    expect(await names(a)).not.toContain("AWS");
  }, 60_000);
});
