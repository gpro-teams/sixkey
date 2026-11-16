// The fourth M3 review's probes (M3-R4-REVIEW; that report was not retained, its findings are in docs/design/notes/M3-NOTES.md §0a): attacks on revision 4
// (SYNC-DESIGN revision 20, §4.7: the orphan
// list, demote never drop, the merge-only outbox, parking). Each FINDING test asserts what the design promises and fails
// on the patch as reviewed; the others pin behaviour the review checked and found sound.
// Adopted into M3 revision 5. The FINDING tests of the findings fixed in revision 5 (R4R-1, -2, -2b, -3, -4, -5, -7, -8,
// -14) run as plain tests and pass. The five the maintainers asked to RECORD only (R4R-6, -9, -10, -11, -12: M3-NOTES
// §B) run as `it.fails` and are marked so; each turns back into `it` when its fix lands. No other edit in revision 5.
// Revision 6 edits: R4R-8's call passes the checksums (required since R5R-3), marked there; the five recorded probes'
// titles point to M3-NOTES §B (the known residuals) instead of §0. Nothing else.
import { describe, expect, it } from "vitest";
import type { Vk } from "../../src/core/crypto/vk";
import { KEYS } from "../../src/core/storage/format";
import { MergeBlocked } from "../../src/core/service/sync-flows";
import { writeProof } from "../../src/core/sync/crypto/subkeys";
import { firstUpload, resumeFirstUpload } from "../../src/core/sync/engine/enroll";
import { removeSyncIdentity, revokeDevice, turnSyncOff } from "../../src/core/sync/engine/keys";
import { discardParkedOrphans, foldParkedLocally } from "../../src/core/sync/engine/orphans";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { uploadEnvelope } from "../../src/core/sync/local/outbox";
import { lastSyncedOf } from "../../src/core/sync/local/state";
import { createClock } from "../../src/core/vault/hlc";
import { aliveEntries, type Vault } from "../../src/core/vault/model";
import { addEntry, deleteEntry, editEntry, purgeEntry } from "../../src/core/vault/ops";
import { tear } from "../helpers/faulty-kv";
import { input } from "../helpers/m2-world";
import { bulkEntries, EMAIL, quiesce, World, worldOf, type Device } from "../helpers/m3-world";
import { createProtected } from "../helpers/vaults";

const DAY = 24 * 60 * 60 * 1000;
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
/** Every snapshot (rolling and daily) removed: what is left once they rotate out (only automatic paths count here). */
function noSnapshots(d: Device): void {
  for (const k of [...d.disk.kv.data.keys()]) if (k.startsWith("sk_snap")) d.disk.kv.data.delete(k);
}
const plant = (d: Device, items: unknown[]) => d.disk.kv.data.set(SYNC_KEYS.orphan, { v: 1, items });
async function pushableOf(
  vault: Vault,
  vk: Vk,
  base: number,
  head: string,
  checksum = `planted-${base}-${head.slice(0, 6)}`,
): Promise<Record<string, unknown>> {
  const up = await uploadEnvelope(vault, vk, { vaultId: vault.vaultId, rev: base + 1 });
  const proof = await writeProof(vk, { vaultId: vault.vaultId, ifVersion: base, checksum: up.envelope.checksum });
  return { v: 1, base, head, from: { version: base, head, checksum: "planted" }, checksum, envelope: up.text, proof };
}
const clearLastSynced = (d: Device) => {
  const st = d.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>;
  d.disk.kv.data.set(SYNC_KEYS.state, { ...st, lastSynced: null });
};

describe("M3-R4 review: flows that delete the sync records", () => {
  it("R4R-1 (FINDING): an unconfirmed first upload, a save in the popup, a tear; resumeFirstUpload's undo (undoLocal) deletes the entry holding the only copy of the save", async () => {
    const w = new World();
    const a = w.device("A");
    w.code = (await createProtected(a.svc, w.password)).recoveryCode;
    await a.svc.openView();
    w.advance(1000);
    await a.add("GitHub");
    // §3.1 D4: init never reached the server (three network failures, or the page closed after step 5)
    a.net.inject({ match: "POST /v1/vault/init", kind: "fail_before", count: 3 });
    expect(
      await firstUpload(a.engine, {
        session: await w.server.session(EMAIL),
        password: w.password,
        recoveryCode: w.code,
        deviceName: "A",
        email: EMAIL,
      }),
    ).toEqual({ kind: "unconfirmed" });
    expect((await a.local.status()).kind).toBe("on"); // the pending identity and its copy (step 5)
    const vk = await a.vk();
    w.advance(1000);
    await a.add("the acknowledged save"); // lastSynced is null: the merge-only outbox (R3R-5)
    expect(outboxOf(a)).toMatchObject({ from: null });
    await a.lockNow(); // "lock every time": no keyed round
    tearActive(a);
    a.restartWorker();
    await a.svc.status(); // the popup opens: the recovery appends the merge-only record (revision 20 works so far)
    expect(entries(a)).toHaveLength(1);
    noSnapshots(a);
    // M6 (§10 item 14): resumeFirstUpload on a first upload's join_unfinished; the server does not know the identity
    expect(await resumeFirstUpload(a.engine)).toBe("not_created");
    expect((await a.local.status()).kind).toBe("off");
    await a.unlock();
    const kept = entries(a).length > 0;
    // the settings page's next unlock with sync off folds what the turn-off kept (§4.7, R3R-2)
    await foldParkedLocally({ flows: a.ctx.flows, kv: a.disk.kv, vaultLock: a.lock, now: () => w.clock.now });
    // §4.7: an unconfirmed outbox is deleted only where the vault holds it. Here undoLocal -> SyncLocal.turnOff deleted
    // the never-tried (unmarked) entry: M3-NOTES §0.2 item 9 says "no other caller exists", but undoLocal is one.
    expect({ inVault: (await names(a, vk)).includes("the acknowledged save"), kept }).toMatchObject({ inVault: true });
  }, 60_000);

  it("R4R-2 (FINDING, regression of revision 3): a revoked device, its last save unpushed, the slot torn and not yet loaded: removeSyncIdentity reads the list before loading the vault, finds nothing, and D11 deletes the outbox", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const vk = await a.vk();
    const aid = ((await a.local.identity.get()) as { deviceId: string }).deviceId;
    await revokeDevice(b.engine, aid, w.password);
    w.advance(1000);
    await a.add("A's last save");
    expect((await a.engine.round()).status).toBe("rejected_by_server"); // device_revoked: the outbox is never pushed
    expect(outboxOf(a)).toMatchObject({ base: expect.any(Number) });
    tearActive(a); // nothing has loaded the vault since
    noSnapshots(a);
    await removeSyncIdentity(a.engine); // §3.10: the rejected device's [remove the sync identity]
    expect((await a.local.status()).kind).toBe("off");
    await a.svc.status(); // the next load recovers to the other slot; the hook has nothing left to keep
    await foldParkedLocally({ flows: a.ctx.flows, kv: a.disk.kv, vaultLock: a.lock, now: () => w.clock.now }).catch(
      () => undefined,
    ); // the next unlock
    // revision 3's foldForFlow loaded the vault (the recovery, the hook) BEFORE reading the list; revision 4 reads the
    // list first and returns "none" without loading, so the save's only copy (the outbox) goes with the records
    expect(await names(a, vk)).toContain("A's last save");
  }, 60_000);

  it("R4R-2b (FINDING): the same with turnSyncOff: the fold check sees no entry, context() then loads (the hook appends the outbox), and SyncLocal.turnOff deletes the unmarked entry", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    a.net.inject({ match: "PUT /v1/vault", kind: "fail_before", count: 5 });
    await a.add("A's unpushed save");
    tearActive(a);
    noSnapshots(a);
    await turnSyncOff(a.engine, w.password);
    expect((await a.local.status()).kind).toBe("off");
    await foldParkedLocally({ flows: a.ctx.flows, kv: a.disk.kv, vaultLock: a.lock, now: () => w.clock.now }); // the next unlock
    expect(await names(a, vk)).toContain("A's unpushed save");
  }, 60_000);

  it("R4R-3 (FINDING): a tear and a recovery during turnSyncOff's revoke request (after its fold): the new entry is unmarked and SyncLocal.turnOff deletes it", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("saved just before turning sync off"); // the outbox; not pushed yet
    let once = true;
    const send = a.net.send.bind(a.net);
    a.net.send = async (req) => {
      if (once && req.method === "POST" && req.target.endsWith("/revoke")) {
        once = false;
        tearActive(a); // the save's slot tears; the popup opens meanwhile (the recovery and its hook)
        noSnapshots(a);
        await a.svc.status();
      }
      return send(req);
    };
    await turnSyncOff(a.engine, w.password);
    expect((await a.local.status()).kind).toBe("off");
    const kept = entries(a).length;
    await foldParkedLocally({ flows: a.ctx.flows, kv: a.disk.kv, vaultLock: a.lock, now: () => w.clock.now }); // the next unlock
    expect({ inVault: (await names(a, vk)).includes("saved just before turning sync off"), kept }).toMatchObject({
      inVault: true,
    });
  }, 60_000);
});

describe("M3-R4 review: the guard answer over the list", () => {
  /** A synced device with two of its own entries alive; `erase` makes an entry (a planted orphan) that erases them. */
  async function setUp() {
    const w = await worldOf(2, ["GitHub", "AWS", "Slack"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    const mine = await a.vault(vk);
    const id = (n: string) => mine.entries.find((e) => e.issuer === n)!.id;
    const erase = async (n: string, at: number, extra?: (v: Vault) => Vault) => {
      const clock = createClock("eeee", { now: () => at });
      let v = purgeEntry(deleteEntry(mine, id(n), clock), id(n), clock);
      if (extra) v = extra(v);
      return pushableOf(v, vk, 90 + Math.floor(at % 7), "nowhere", `erase-${n}-${at}`);
    };
    return { w, a, vk, id, erase };
  }

  it("an answer given for one set does not answer a set that gained an entry erasing ANOTHER live account (fine)", async () => {
    const { w, a, id, erase } = await setUp();
    clearLastSynced(a);
    plant(a, [await erase("AWS", w.clock.now)]);
    const r1 = await a.engine.round();
    expect(r1.status).toBe("review_needed");
    expect(r1.blocked!.report.purgedAlive).toEqual([id("AWS")]);
    plant(a, [...entries(a), await erase("GitHub", w.clock.now + 1)]); // a second recovery meanwhile
    const r2 = await a.engine.round({ answer: { seen: r1.blocked!.seen, accept: [id("AWS")] } });
    expect(r2.status).toBe("review_needed"); // GitHub was never shown: blocked again, nothing folded
    expect((await names(a)).sort()).toEqual(["AWS", "GitHub", "Slack"]);
    expect(entries(a)).toHaveLength(2);
  }, 60_000);

  it("an answer given for one set does not answer a set whose combined version of the SAME account changed (fine: the digest differs)", async () => {
    const { w, a, id, erase } = await setUp();
    clearLastSynced(a);
    plant(a, [await erase("AWS", w.clock.now)]);
    const r1 = await a.engine.round();
    expect(r1.status).toBe("review_needed");
    w.advance(5000);
    plant(a, [...entries(a), await erase("AWS", w.clock.now)]); // the same account erased again, later stamps
    const r2 = await a.engine.round({ answer: { seen: r1.blocked!.seen, accept: [id("AWS")] } });
    expect(r2.status).toBe("review_needed");
    expect(r2.blocked!.seen[id("AWS")]).not.toBe(r1.blocked!.seen[id("AWS")]);
    expect(await names(a)).toContain("AWS");
  }, 60_000);

  it.fails(
    "RECORDED, not fixed (M3-NOTES §B) R4R-6 (FINDING, low): an entry stamped more than 24 h ahead (a fast clock when it was saved): the fold clamps it before the guard, so its digest moves with the clock and an answer given a second later never matches",
    async () => {
      const { w, a, id, erase } = await setUp();
      clearLastSynced(a);
      plant(a, [await erase("AWS", w.clock.now + 3 * DAY)]);
      const r1 = await a.engine.round();
      expect(r1.status).toBe("review_needed");
      w.advance(1000); // the user reads the review and presses [Apply]
      const r2 = await a.engine.round({ answer: { seen: r1.blocked!.seen, accept: [id("AWS")] } });
      // the server path digests the RAW remote (stable); the fold digests the entry clamped at fold time (departure 3)
      expect(r2.status).toBe("ok");
    },
    60_000,
  );
});

describe("M3-R4 review: the list's own edges", () => {
  it("R4R-4 (FINDING, low): a stored value that is not a list is read two ways: the fold sees no entry, the CAS sees an unparked one it did not fold, so lastSynced is never set again", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    const head = w.server.account(EMAIL).vault!;
    const save = addEntry(
      await a.vault(vk),
      input("in a bare record"),
      createClock("eeee", { now: () => w.clock.now }),
    ).vault;
    a.disk.kv.data.set(SYNC_KEYS.orphan, await pushableOf(save, vk, head.version + 3, "nowhere")); // revision 19's shape (or any non-list value)
    clearLastSynced(a);
    for (let i = 0; i < 3; i++) await a.engine.round();
    // either folded (the save in the vault, lastSynced set) or removed as damaged; never "kept forever, CAS refused"
    const ls = lastSyncedOf(a.disk.kv.data.get(SYNC_KEYS.state));
    expect({ lastSyncedSet: ls !== null, folded: (await names(a, vk)).includes("in a bare record") }).toEqual({
      lastSyncedSet: true,
      folded: true,
    });
  }, 60_000);

  it("R4R-5 (FINDING, low): an entry of a newer record format (v: 2, after a downgrade) is removed as damaged, not parked", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    const save = addEntry(
      await a.vault(vk),
      input("from a newer build"),
      createClock("eeee", { now: () => w.clock.now }),
    ).vault;
    const rec = await pushableOf(save, vk, 77, "nowhere");
    plant(a, [{ ...rec, v: 2 }]);
    await a.engine.round();
    expect(entries(a)).toHaveLength(1); // §4.7 parks what this build cannot read (a newer schema); a newer record format alike
  }, 60_000);

  it("R4R-7 (FINDING, low): foldParkedLocally does not check that sync is off: called with sync on, it folds unparked entries and retires them outside the three retirements", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    const save = addEntry(
      await a.vault(vk),
      input("unparked entry"),
      createClock("eeee", { now: () => w.clock.now }),
    ).vault;
    plant(a, [await pushableOf(save, vk, 66, "nowhere")]);
    clearLastSynced(a);
    const r = await foldParkedLocally({ flows: a.ctx.flows, kv: a.disk.kv, vaultLock: a.lock, now: () => w.clock.now });
    // with sync on, §4.7 retires an entry only by a push 200, the lastSynced write, or the checksum: refuse, or keep it
    expect({ r, kept: entries(a).length }).toMatchObject({ kept: 1 });
  }, 60_000);

  it("R4R-8 (FINDING, low): discardParkedOrphans binds to a count only, read outside the lock: an entry that a fold unparked meanwhile (folded, not yet retired) is deleted", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    const save = addEntry(
      await a.vault(vk),
      input("parked, then folded"),
      createClock("eeee", { now: () => w.clock.now }),
    ).vault;
    const rec = await pushableOf(save, vk, 55, "nowhere");
    plant(a, [{ ...rec, parked: { reason: "schema", vkId: null, at: 1 } }]);
    // the notice showed 1; between its read and the delete, a fold (an update made it readable) unparks the entry
    const kv = a.disk.kv;
    let gets = 0;
    const racing = {
      get: async (k: string[]) => {
        const r = await kv.get(k);
        if (k.includes(SYNC_KEYS.orphan) && gets++ === 0) plant(a, [rec]); // what the fold leaves: unparked, waiting for the CAS
        return r;
      },
      set: (i: Record<string, unknown>) => kv.set(i),
      remove: (k: string[]) => kv.remove(k),
      keys: () => kv.keys(),
    };
    // (M3 revision 6 edit, R5R-3: the checksums are required now; without them the delete is refused before the in-lock
    // re-read this probe attacks, so they are passed: the notice's checksum of the one parked entry)
    await discardParkedOrphans(
      { kv: racing as never, vaultLock: a.lock },
      { count: 1, checksums: [rec.checksum as string] },
    ).catch(() => 0);
    expect(entries(a)).toHaveLength(1); // "never an unparked one"
  }, 60_000);

  it.fails(
    "RECORDED, not fixed (M3-NOTES §B) R4R-9 (FINDING, low): a parked entry that becomes readable while the device is in sync and holds nothing new: folded with no change, its mark cleared, never retired; an unparked entry beside a non-null lastSynced",
    async () => {
      const w = await worldOf(2, ["GitHub", "AWS"]);
      const [a] = w.devices as [Device, Device];
      const vk = await a.vk();
      const rec = await pushableOf(await a.vault(vk), vk, 44, "nowhere", "same-content");
      plant(a, [{ ...rec, parked: { reason: "schema", vkId: null, at: 1 } }]); // readable now (as after an update)
      expect(lastSyncedOf(a.disk.kv.data.get(SYNC_KEYS.state))).not.toBeNull();
      for (let i = 0; i < 3; i++) expect((await a.engine.round()).status).toBe("ok");
      // §4.7's invariant: an entry waiting to be folded ⇒ lastSynced null. Here it is folded every round and never retired.
      expect({
        entries: entries(a).length,
        lastSynced: lastSyncedOf(a.disk.kv.data.get(SYNC_KEYS.state)) !== null,
      }).toEqual({ entries: 0, lastSynced: true });
    },
    60_000,
  );

  it.fails(
    "RECORDED, not fixed (M3-NOTES §B) R4R-10 (FINDING, low; departure 4): a fold over the entry limit parks every entry it tried, so a later small save that fits alone is parked with them and never folded while sync reports ok",
    async () => {
      const { encryptVault } = await import("../../src/core/crypto/envelope");
      const { serializeVault } = await import("../../src/core/vault/validate");
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
      const local = await a.vault(vk);
      const small = addEntry(
        local,
        input("small save, fits alone"),
        createClock("eeee", { now: () => w.clock.now }),
      ).vault;
      plant(a, [
        {
          v: 1,
          base: 98,
          head: "elsewhere",
          from: { version: 98, head: "elsewhere", checksum: "x" },
          checksum: "big",
          envelope: JSON.stringify(env),
          proof: "p",
          parked: { reason: "too_large", vkId: null, at: 1 },
        },
        await pushableOf(small, vk, 34, "nowhere", "small"),
      ]);
      clearLastSynced(a);
      await a.engine.round();
      expect(await names(a, vk)).toContain("small save, fits alone");
    },
    240_000,
  );
});

describe("M3-R4 review: bounds and the merge-only outbox (fine)", () => {
  it("lock every time with a stuck server (every locked push stale or 409): at most one demotion between keyed rounds, the list grows only with recoveries, and nothing is lost", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const vk = await a.vk();
    for (let i = 0; i < 4; i++) {
      w.advance(1000);
      await a.add(`save ${i}`);
      await a.lockNow();
      w.advance(1000);
      await b.add(`B ${i}`);
      await b.engine.round();
      for (let k = 0; k < 3; k++) {
        a.restartWorker();
        await a.engine.push();
      }
      await a.unlock(); // the popup again (no round)
    }
    expect(entries(a)).toHaveLength(1); // one demotion; every later save went to the merge-only outbox
    expect(outboxOf(a)).toMatchObject({ from: null });
    expect(w.server.requests.filter((r) => r.op === "PUT /v1/vault" && r.status === 409).length).toBe(0); // stale: never even sent
    await a.lockNow();
    tearActive(a);
    a.restartWorker();
    await a.svc.status();
    expect(entries(a)).toHaveLength(2); // + the recovery's
    await a.unlock();
    await quiesce(w);
    for (let i = 0; i < 4; i++) {
      expect(await names(a, vk)).toContain(`save ${i}`);
      expect(await headNames(w, vk)).toContain(`save ${i}`);
    }
    expect(entries(a)).toHaveLength(0);
  }, 120_000);

  it("the merge-only outbox never reaches a PUT, locked or not; the round's lastSynced write removes it", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    clearLastSynced(a);
    w.advance(1000);
    await a.add("merge-only");
    const mo = outboxOf(a)!;
    expect(mo).toMatchObject({ from: null });
    await a.lockNow();
    a.restartWorker();
    const sent: string[] = [];
    const send = a.net.send.bind(a.net);
    a.net.send = async (req) => {
      if (req.method === "PUT" && req.target === "/v1/vault") sent.push(String(req.body));
      return send(req);
    };
    await a.engine.push();
    await a.engine.round();
    expect(sent).toHaveLength(0); // locked: nothing to push
    await a.unlock();
    expect((await a.engine.round()).status).toBe("ok");
    expect(sent.every((b) => !b.includes(mo.envelope as string))).toBe(true);
    expect(outboxOf(a)).toBeNull();
  }, 60_000);

  it("R4-29's tie (killer): one account edited in two entries, both more than 24 h ahead; each entry is clamped on its own (§4.7), so the HLC counter decides, not the larger raw stamp", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    const mine = await a.vault(vk);
    const aws = mine.entries.find((e) => e.issuer === "AWS")!.id;
    // entry 1: the larger raw stamp (now + 40 h), counter 0; entry 2: now + 30 h, a clock that ticked 5 times in that ms
    const c1 = createClock("eeee", { now: () => w.clock.now + 40 * 3_600_000 });
    const e1 = editEntry(mine, aws, { label: "from entry 1 (later raw stamp)" }, c1);
    const c2 = createClock("eeee", { now: () => w.clock.now + 30 * 3_600_000 });
    let e2 = mine;
    for (let i = 0; i < 6; i++)
      e2 = editEntry(e2, aws, { label: i === 5 ? "from entry 2 (higher counter)" : `tick ${i}` }, c2);
    plant(a, [await pushableOf(e1, vk, 11, "n1", "e1"), await pushableOf(e2, vk, 12, "n2", "e2")]);
    clearLastSynced(a);
    expect((await a.engine.round()).status).toBe("ok");
    const label = (await a.vault(vk)).entries.find((e) => e.id === aws)!.label;
    expect(label).toBe("from entry 2 (higher counter)"); // merge(clamp(local), clamp(e1), clamp(e2)); R4-29 (merge, then clamp) gives entry 1
  }, 60_000);
});

describe("M3-R4 review: MergeBlocked from the sync-off fold (fine)", () => {
  it("foldParkedLocally: a guard block throws MergeBlocked, keeps the entry and its mark; the answer folds and removes it", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    await turnSyncOff(a.engine, w.password);
    const mine = await a.vault(vk);
    const aws = mine.entries.find((e) => e.issuer === "AWS")!.id;
    const clock = createClock("eeee", { now: () => w.clock.now });
    plant(a, [
      {
        ...(await pushableOf(purgeEntry(deleteEntry(mine, aws, clock), aws, clock), vk, 3, "h")),
        parked: { reason: "schema", vkId: null, at: 1 },
      },
    ]);
    let blocked: MergeBlocked | null = null;
    await foldParkedLocally({ flows: a.ctx.flows, kv: a.disk.kv, vaultLock: a.lock, now: () => w.clock.now }).catch(
      (e: unknown) => {
        if (e instanceof MergeBlocked) blocked = e;
        else throw e;
      },
    );
    expect(blocked).not.toBeNull();
    expect(entries(a)).toHaveLength(1);
    expect(entries(a)[0]!.parked).toBeTruthy();
    const b = blocked as unknown as MergeBlocked;
    expect(
      await foldParkedLocally(
        { flows: a.ctx.flows, kv: a.disk.kv, vaultLock: a.lock, now: () => w.clock.now },
        { seen: b.seen, accept: [aws] },
      ),
    ).toEqual({ folded: 1, parked: 0 });
    expect(await names(a, vk)).not.toContain("AWS");
    expect(entries(a)).toHaveLength(0);
  }, 60_000);
});

describe("M3-R4 review: survivors and remaining edges", () => {
  it("R4-14 killer: the fold stopped by a lock (applyRemote: locked) folds nothing; a round that then needs no upload must not set lastSynced beside the unparked entry", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    const save = addEntry(
      await a.vault(vk),
      input("waiting in the entry"),
      createClock("eeee", { now: () => w.clock.now }),
    ).vault;
    plant(a, [await pushableOf(save, vk, 21, "nowhere", "waiting")]);
    clearLastSynced(a);
    const flows = a.ctx.flows;
    const orig = flows.applyRemote.bind(flows);
    let first = true;
    flows.applyRemote = async (remote, answer) => {
      if (first) {
        first = false;
        await a.svc.lock(); // the idle lock (or another page's lock) lands while the fold is about to commit
      }
      return orig(remote, answer);
    };
    await a.engine.round(); // the fold: locked; the round goes on with the vault it loaded: the server holds the same content
    expect(entries(a)).toHaveLength(1);
    expect(lastSyncedOf(a.disk.kv.data.get(SYNC_KEYS.state))).toBeNull(); // §4.7: an unparked entry => lastSynced null
  }, 60_000);

  it.fails(
    "RECORDED, not fixed (M3-NOTES §B) R4R-11 (FINDING, low; a lying pointer write): the fold's commit point is dropped, the round's lastSynced write still retires the entry it 'folded' although the vault it uploaded does not hold it",
    async () => {
      const { runDying } = await import("../helpers/m3-crash");
      const { cloneWorld } = await import("../helpers/m3-world");
      const w0 = await worldOf(2, ["GitHub", "AWS"]);
      const [a0] = w0.devices as [Device, Device];
      const vk = await a0.vk();
      w0.advance(1000);
      await a0.add("SAVE2");
      await a0.lockNow();
      tearActive(a0);
      a0.restartWorker();
      await a0.svc.status(); // SAVE2 now only in the entry
      await a0.unlock();
      const dry = cloneWorld(w0);
      const d = dry.devices[0]!;
      await d.svc.unlockWithRecoveryCode(dry.code);
      const steps = (await runDying(d, 9999, "before", (c) => c.engine.round())).steps;
      const at = steps.indexOf("local.set sk_active") + 1; // the fold's commit point
      expect(at).toBeGreaterThan(0);
      const w = cloneWorld(w0);
      const [a, b] = w.devices as [Device, Device];
      await a.svc.unlockWithRecoveryCode(w.code);
      await runDying(a, at, "lie", (c) => c.engine.round());
      await quiesce(w, 8, [a, b]);
      // Phase 0's store loses a commit whose pointer write lies (M3-NOTES §3 item 18). Here the commit only re-committed a
      // save the entry still held; retiring the entry in the CAS on the strength of the fold's in-memory result turns that
      // into a loss. A check that the round's vault is the fold's generation (or retiring only what the upload holds) closes it.
      const kept = entries(a).length > 0;
      expect({ head: (await headNames(w, vk)).includes("SAVE2"), kept }).toMatchObject({ head: true });
    },
    60_000,
  );

  it("R4R-12, closed by SYNC-DESIGN revision 24 (§4.7): parked entries kept by a turn-off, then a join to ANOTHER vault: kept after the join and every round (parked as another vault's), until the user deletes them", async () => {
    const { commitJoin, joinWithRecoveryCode } = await import("../../src/core/sync/engine/enroll");
    const { encryptVault } = await import("../../src/core/crypto/envelope");
    const { utf8 } = await import("../../src/core/crypto/bytes");
    const w = await worldOf(1, ["GitHub", "AWS"]);
    const x = w.device("X");
    await createProtected(x.svc, "another-strong-pass-77");
    await x.svc.openView();
    await x.add("X's own account");
    const xvk = await x.vk();
    const vaultId = (await x.generation()).keyring.vaultId;
    // a save from a newer build (after a downgrade), parked and kept by an earlier turn-off (R3R-2)
    const env = await encryptVault(utf8(JSON.stringify({ schemaVersion: 2, vaultId, entries: [] })), xvk, {
      vaultId,
      rev: 9,
    });
    plant(x, [
      {
        v: 1,
        from: null,
        checksum: "newer-build",
        envelope: JSON.stringify(env),
        parked: { reason: "schema", vkId: null, at: 1 },
      },
    ]);
    const plan = await joinWithRecoveryCode(x.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "X",
      email: EMAIL,
    });
    expect(await commitJoin(plan)).toBe("enrolled");
    expect(entries(x)).toHaveLength(1); // still kept after the join
    await x.engine.round();
    const notices = ((x.disk.kv.data.get(SYNC_KEYS.state) as { notices?: { kind: string }[] }).notices ?? []).map(
      (n) => n.kind,
    );
    // §4.7 (revision 24): an entry of another vault is never removed by itself (its key not being in the joined vault's
    // chain says nothing about whether it is gone); it stays, parked as another vault's, for the Sync section to show
    expect({ kept: entries(x).length, told: notices.includes("orphan_unreadable") }).toEqual({ kept: 1, told: false });
    await x.engine.round();
    expect(entries(x)).toHaveLength(1);
  }, 60_000);
});

describe("M3-R4 review: departure 3 and the entry limit", () => {
  it("R4R-14 (FINDING, low): two entries whose union passes 50 000 entries: the combined remote fails parseVault before applyRemote, so the fold throws (not too_large): every keyed round errors at step 0 and turnSyncOff cannot run", async () => {
    const { encryptVault } = await import("../../src/core/crypto/envelope");
    const { serializeVault } = await import("../../src/core/vault/validate");
    const w = await worldOf(2, ["GitHub"], [], { validateWire: false });
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    const vaultId = (await a.generation()).keyring.vaultId;
    const mine = await a.vault(vk);
    const sorted = (v: Vault): Vault => ({ ...v, entries: [...v.entries].sort((x, y) => (x.id < y.id ? -1 : 1)) });
    const e1 = sorted({ ...mine, entries: [...mine.entries, ...bulkEntries(30_000, "one", w.clock.now - 1000)] });
    const e2 = sorted({
      ...mine,
      entries: [...mine.entries, ...bulkEntries(30_000, "two", w.clock.now - 900, { device: "twoooo" })],
    });
    const rec = async (v: Vault, c: string) => ({
      v: 1,
      from: null,
      checksum: c,
      envelope: JSON.stringify(await encryptVault(serializeVault(v), vk, { vaultId, rev: 50 })),
    });
    plant(a, [await rec(e1, "e1"), await rec(e2, "e2")]); // each alone is fine; together 60 001 entries
    clearLastSynced(a);
    const r = await a.engine.round();
    let off: unknown = "ok";
    await turnSyncOff(a.engine, w.password).catch((e: unknown) => {
      off = e instanceof Error ? `${e.name}: ${(e as { code?: string }).code ?? e.message}` : e;
    });
    // §4.7 / R3R-4: "或并入会超过条目上限" parks, and sync goes on; R3R-2: the turn-off is an emergency exit, never refused
    expect({ round: r.status, error: r.error ?? null, off }).toEqual({ round: "ok", error: null, off: "ok" });
  }, 300_000);
});
