// The fifth M3 review's probes (M3-R5-REVIEW; that report was not retained, its findings are in docs/design/notes/M3-NOTES.md §0): attacks on
// the revision-4 -> revision-5 delta (M3-NOTES §0): the
// turn-off that keeps every entry the flow did not fold, the load-first fold, the joins that ignore the fold's status,
// the in-lock "Advanced" delete. A test named FINDING fails on revision 5 as delivered; the others pin what was checked.
// Adopted into M3 revision 6; its three FINDING tests (R5R-1, -2, -3) are fixed there and pass as plain tests. One edit,
// marked in R5R-3: a cast on the count-only call (the checksums are required in the type now). Nothing else.
import { describe, expect, it } from "vitest";
import type { Vk } from "../../src/core/crypto/vk";
import { KEYS } from "../../src/core/storage/format";
import { writeProof } from "../../src/core/sync/crypto/subkeys";
import {
  ApprovalJoin,
  Approver,
  commitJoin,
  firstUpload,
  joinWithRecoveryCode,
  resumeFirstUpload,
} from "../../src/core/sync/engine/enroll";
import { turnSyncOff } from "../../src/core/sync/engine/keys";
import { discardParkedOrphans, foldParkedLocally, readParkedOrphans } from "../../src/core/sync/engine/orphans";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { uploadEnvelope } from "../../src/core/sync/local/outbox";
import { createClock } from "../../src/core/vault/hlc";
import { aliveEntries, type Vault } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { tear } from "../helpers/faulty-kv";
import { input } from "../helpers/m2-world";
import { EMAIL, quiesce, World, worldOf, type Device } from "../helpers/m3-world";
import { createProtected } from "../helpers/vaults";

const XPW = "another-strong-pass-77";
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
function tearActive(d: Device): void {
  const kv = d.disk.kv;
  const ptr = kv.data.get(KEYS.active) as "a" | "b";
  kv.data.set(KEYS.slot[ptr], tear(kv.data.get(KEYS.slot[ptr])));
}
function noSnapshots(d: Device): void {
  for (const k of [...d.disk.kv.data.keys()]) if (k.startsWith("sk_snap")) d.disk.kv.data.delete(k);
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

/**
 * A profile with its own vault (never synced, or sync turned off) holding one UNPARKED orphan entry with the only copy of
 * a save. Revision 5 makes this state ordinary: SyncLocal.turnOff keeps every entry the flow did not fold (the first
 * upload's undo keeps all of them, R4R-1; an entry appended during a turn-off's revoke, R4R-3).
 */
async function ownVaultWithKeptEntry(w: World): Promise<Device> {
  const x = w.device("X");
  await createProtected(x.svc, XPW);
  await x.svc.openView();
  await x.add("X's own account");
  const vk = await x.vk();
  const save = addEntry(
    await x.vault(vk),
    input("only in the kept entry"),
    createClock("xxxx", { now: () => w.clock.now }),
  ).vault;
  x.disk.kv.data.set(SYNC_KEYS.orphan, { v: 1, items: [await pushableOf(save, vk, 3, "nowhere", "kept-entry")] });
  return x;
}

describe("M3-R5 review: the joins and the fold's status (the maintainers' point 3)", () => {
  it("R5R-1 (FINDING): ApprovalJoin.start ignores a fold that ended `locked`; the page unlocks before the join is prepared, and prepare() never folds again: the added-mode join leaves the kept entry out, and the next round removes it as 'another vault'", async () => {
    const w = await worldOf(1, ["GitHub", "AWS"]);
    const a = w.devices[0]!;
    const x = await ownVaultWithKeptEntry(w);
    await x.lockNow(); // the settings page (or the popup's idle lock) is locked when the approval join starts
    let join: ApprovalJoin;
    try {
      join = await ApprovalJoin.start(x.engine, {
        session: await w.server.session(EMAIL),
        deviceName: "X",
        email: EMAIL,
      });
    } catch (e) {
      // a correct fix may refuse here ("unlock first"): then nothing was replaced and the entry is still there
      expect(e).toMatchObject({ code: "locked" });
      expect(entries(x).map((x) => x.checksum)).toEqual(["kept-entry"]);
      return;
    }
    const approver = await Approver.start(a.engine, join.requestId, w.password);
    await join.poll();
    const sas = (await join.submitPairingCode(approver.pairingCode)) as { sas: string };
    await approver.poll(w.password);
    await approver.submitSas(sas.sas, w.password);
    expect(await join.poll()).toEqual({ kind: "approved" });
    await x.svc.unlockWithPassword(XPW); // "要求先在本机解锁": the added mode needs the local key, so the user unlocks
    expect(await commitJoin(await join.prepare())).toBe("enrolled");
    await quiesce(w, 8, [a, x]);
    const cloudVk = await x.vk();
    const inVault = (await names(x, cloudVk)).includes("only in the kept entry");
    // §3.5 / §4.7: the join folds the entries first, so sk_prejoin and the added import see them; a fold that could not
    // run must stop the join (or the prepare must fold again), never let the entry fall out with the old vault
    expect({ inVault, kept: entries(x).length }).toMatchObject({ inVault: true });
  }, 60_000);

  it("joinWithRecoveryCode with the same kept entry while locked: the fold ends `locked` and is ignored, but prepareJoin needs the local key and refuses (locked); the entry stays (fine)", async () => {
    const w = await worldOf(1, ["GitHub", "AWS"]);
    const x = await ownVaultWithKeptEntry(w);
    await x.lockNow();
    await expect(
      joinWithRecoveryCode(x.engine, {
        session: await w.server.session(EMAIL),
        recoveryCode: w.code,
        deviceName: "X",
        email: EMAIL,
      }),
    ).rejects.toMatchObject({ code: "locked" });
    expect(entries(x).map((e) => e.checksum)).toEqual(["kept-entry"]);
  }, 60_000);

  it("joinWithRecoveryCode with the kept entry, unlocked: folded first, so the added import carries the save into the cloud vault (fine)", async () => {
    const w = await worldOf(1, ["GitHub", "AWS"]);
    const a = w.devices[0]!;
    const x = await ownVaultWithKeptEntry(w);
    const plan = await joinWithRecoveryCode(x.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "X",
      email: EMAIL,
    });
    expect(await commitJoin(plan)).toBe("enrolled");
    await quiesce(w, 8, [a, x]);
    expect(await names(x, await x.vk())).toContain("only in the kept entry");
    expect(await headNames(w, await a.vk())).toContain("only in the kept entry");
  }, 60_000);

  it("a lost local vault with a kept entry of the SAME vault: the join (confirmLost) proceeds over the fold's `vault_lost`, keeps the entry, and the first round folds it into the joined vault (fine)", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [Device, Device];
    const vk = await b.vk();
    const save = addEntry(
      await b.vault(vk),
      input("B's save in the entry"),
      createClock("bbbb", { now: () => w.clock.now }),
    ).vault;
    await turnSyncOff(b.engine, w.password);
    b.disk.kv.data.set(SYNC_KEYS.orphan, { v: 1, items: [await pushableOf(save, vk, 2, "nowhere", "b-entry")] }); // kept by a turn-off (R4R-1's rule)
    for (const k of [KEYS.slot.a, KEYS.slot.b, KEYS.keyringCopy]) b.disk.kv.data.set(k, { torn: "x" });
    noSnapshots(b);
    b.disk.mirror.data.clear();
    b.restartWorker();
    expect((await b.svc.status()).state).toBe("lost");
    const plan = await joinWithRecoveryCode(b.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "B again",
      email: EMAIL,
      confirmLost: true,
    });
    expect(entries(b)).toHaveLength(1);
    expect(await commitJoin(plan)).toBe("enrolled");
    await quiesce(w, 8, [a, b]);
    expect(await names(b, vk)).toContain("B's save in the entry");
    expect(await headNames(w, vk)).toContain("B's save in the entry");
    expect(entries(b)).toHaveLength(0);
  }, 60_000);
});

describe("M3-R5 review: R4R-1's fix in the flows that follow it", () => {
  it("after resumeFirstUpload's undo keeps the entry, the user simply starts the first upload again: the save reaches the head (fine)", async () => {
    const w = new World();
    const a = w.device("A");
    w.code = (await createProtected(a.svc, w.password)).recoveryCode;
    await a.svc.openView();
    w.advance(1000);
    await a.add("GitHub");
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
    const vk = await a.vk();
    w.advance(1000);
    await a.add("the acknowledged save");
    await a.lockNow();
    tearActive(a);
    a.restartWorker();
    await a.svc.status();
    noSnapshots(a);
    expect(await resumeFirstUpload(a.engine)).toBe("not_created");
    expect(entries(a)).toHaveLength(1); // kept (R4R-1)
    await a.unlock();
    // no settings-page fold in between: the first upload again (requireOff sees "off" and does not fold)
    expect(
      await firstUpload(a.engine, {
        session: await w.server.session(EMAIL),
        password: w.password,
        recoveryCode: w.code,
        deviceName: "A",
        email: EMAIL,
      }),
    ).toEqual({ kind: "done" });
    await a.engine.round(); // the first keyed round folds the kept entry (step 0) and uploads it
    expect(await headNames(w, vk)).toContain("the acknowledged save");
    expect(entries(a)).toHaveLength(0);
  }, 60_000);

  it("R5R-2 (FINDING, low; residual of R4R-2/-3): a tear during turnSyncOff's revoke that no load sees before the turn-off: D11 deletes the live outbox, the only copy of the save", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    w.advance(1000);
    await a.add("saved just before turning sync off");
    let once = true;
    const send = a.net.send.bind(a.net);
    a.net.send = async (req) => {
      if (once && req.method === "POST" && req.target.endsWith("/revoke")) {
        once = false;
        tearActive(a); // nothing loads the vault until the turn-off has run
        noSnapshots(a);
      }
      return send(req);
    };
    await turnSyncOff(a.engine, w.password);
    expect((await a.local.status()).kind).toBe("off");
    await a.svc.status(); // the next load recovers to the older slot; the hook finds no outbox (D11 deleted it)
    await foldParkedLocally({ flows: a.ctx.flows, kv: a.disk.kv, vaultLock: a.lock, now: () => w.clock.now }).catch(
      () => undefined,
    );
    expect(await names(a, vk)).toContain("saved just before turning sync off");
  }, 60_000);
});

describe("M3-R5 review: 'Advanced' (discardParked)", () => {
  it("R5R-3 (FINDING, low): `checksums` is optional; with the count alone, a parked entry the user never saw (the one shown was folded meanwhile, another parked) is deleted", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    const p1 = {
      ...(await pushableOf(await a.vault(vk), vk, 1, "x", "shown")),
      parked: { reason: "schema", vkId: null, at: 1 },
    };
    a.disk.kv.data.set(SYNC_KEYS.orphan, { v: 1, items: [p1] });
    const shown = await readParkedOrphans(a.disk.kv, a.lock);
    expect(shown).toMatchObject({ count: 1, checksums: ["shown"] });
    // meanwhile: the shown entry folded and retired; another parked (a different save the notice never listed)
    const p2 = {
      ...(await pushableOf(await a.vault(vk), vk, 2, "y", "never-shown")),
      parked: { reason: "too_large", vkId: null, at: 2 },
    };
    a.disk.kv.data.set(SYNC_KEYS.orphan, { v: 1, items: [p2] });
    await expect(
      discardParkedOrphans({ kv: a.disk.kv, vaultLock: a.lock }, { count: shown!.count, checksums: shown!.checksums }),
    ).rejects.toMatchObject({ code: "bad_state" }); // bound: refused
    // (M3 revision 6 edit: the checksums became required in the type, R5R-3's fix; the cast keeps this call compiling as
    // the count-only call a JavaScript caller could still make, which the runtime check refuses)
    await discardParkedOrphans({ kv: a.disk.kv, vaultLock: a.lock }, { count: shown!.count } as unknown as {
      count: number;
      checksums: string[];
    }).catch(() => 0);
    expect(entries(a).map((e) => e.checksum)).toEqual(["never-shown"]); // the count alone must not be enough
  }, 60_000);

  it("discardParked never deletes an entry unparked meanwhile, even with the count and checksums the user saw (the in-lock check, R4R-8) (fine)", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a] = w.devices as [Device, Device];
    const vk = await a.vk();
    const rec = await pushableOf(await a.vault(vk), vk, 1, "x", "p");
    a.disk.kv.data.set(SYNC_KEYS.orphan, {
      v: 1,
      items: [{ ...rec, parked: { reason: "schema", vkId: null, at: 1 } }],
    });
    const shown = (await readParkedOrphans(a.disk.kv, a.lock))!;
    a.disk.kv.data.set(SYNC_KEYS.orphan, { v: 1, items: [rec] }); // a fold unparked it (folded, waiting for the CAS)
    await expect(
      discardParkedOrphans({ kv: a.disk.kv, vaultLock: a.lock }, { count: shown.count, checksums: shown.checksums }),
    ).rejects.toMatchObject({ code: "bad_state" });
    expect(entries(a)).toHaveLength(1);
  }, 60_000);
});
