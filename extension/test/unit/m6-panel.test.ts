// The Sync section's state and actions once a flow is over (src/options/sync/panel.ts) over the in-memory FakeServer: the
// facts it reads, the rounds the page runs, the API permission withdrawn and granted again, turning sync off (with the
// permission there, withdrawn and granted by the click, or declined), removing the sync identity, a device the server
// no longer accepts, a merge the guard stopped and the answer, keys changed elsewhere, the notices and an unfinished
// first upload. The cards are model.ts's (test/unit/m6-model.test.ts covers every one).
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { cardOf } from "../../src/options/sync/model";
import { SyncPanelCtl } from "../../src/options/sync/panel";
import { asking } from "../../src/options/sync/permission";
import { answerOf } from "../../src/options/sync/review";
import { commitJoin, firstUpload, joinWithRecoveryCode } from "../../src/core/sync/engine/enroll";
import { commitRotation, prepareRotation, revokeDevice } from "../../src/core/sync/engine/keys";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { uploadEnvelope } from "../../src/core/sync/local/outbox";
import { writeProof } from "../../src/core/sync/crypto/subkeys";
import type { Vault } from "../../src/core/vault/model";
import type { Vk } from "../../src/core/crypto/vk";
import { isAlive } from "../../src/core/vault/model";
import { deleteEntry, purgeEntry } from "../../src/core/vault/ops";
import { EMAIL, World, type Device } from "../helpers/m3-world";
import {
  click,
  emptyProfile,
  gate,
  kitOf,
  permissions,
  protectedProfile,
  until,
  type PermFake,
  type TestKit,
} from "../helpers/m6-kit";

const T = (ms: number) => new Date(ms).toISOString();

/** An orphan entry as the engine keeps one (§4.7), for `vault` under `vk` (m3-rev20.test.ts pushableOf). */
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

async function syncedPair(names = ["GitHub", "AWS"]) {
  const w = new World();
  const pa = permissions(true);
  const { d: a, code } = await protectedProfile(w, "A", pa, names);
  w.code = code;
  const up = await firstUpload(a.engine, {
    session: await w.server.session(EMAIL),
    password: w.password,
    recoveryCode: code,
    deviceName: "A",
    email: EMAIL,
  });
  expect(up.kind).toBe("done");
  expect((await a.engine.round()).status).toBe("ok");
  const pb = permissions(true);
  const b = emptyProfile(w, "B", pb);
  expect(
    await commitJoin(
      await joinWithRecoveryCode(b.engine, {
        session: await w.server.session(EMAIL),
        recoveryCode: code,
        deviceName: "B",
        email: EMAIL,
      }),
    ),
  ).toBe("enrolled");
  expect((await b.engine.round()).status).toBe("ok");
  return { w, a, b, pa, pb };
}

function panelOf(d: Device, perm: PermFake, w: World): { ctl: SyncPanelCtl; kit: TestKit; reloads: () => number } {
  const kit = kitOf(d, perm);
  let n = 0;
  let vault: "unlocked" | "locked" = "unlocked";
  const ctl = new SyncPanelCtl(kit, {
    vault: () => vault,
    reload: async () => {
      n++;
      vault = (await d.svc.status()).state === "unlocked" ? "unlocked" : "locked";
    },
    now: () => w.clock.now,
  });
  return { ctl, kit, reloads: () => n };
}
const card = (ctl: SyncPanelCtl) => cardOf(ctl.state.facts!, "unlocked", 0, T);

describe("the panel (§6 O12)", () => {
  it("off: no sync records, no card (the explanation card is shown instead); nothing is sent", async () => {
    const w = new World();
    const perm = permissions(false);
    const { d } = await protectedProfile(w, "A", perm);
    const { ctl } = panelOf(d, perm, w);
    await ctl.refresh();
    expect(ctl.state.facts).toMatchObject({ syncOn: false, local: "off", permission: false, orphans: 0 });
    expect(card(ctl)).toBeNull();
    await ctl.roundIfDue();
    expect(d.net.log.length).toBe(0);
  });

  it("on: the page's round when it is due, not again within 30 s; Sync now runs one anyway", async () => {
    const { w, a, pa } = await syncedPair();
    const { ctl, kit } = panelOf(a, pa, w);
    w.advance(60_000);
    await ctl.refresh();
    const before = a.net.log.length;
    await ctl.roundIfDue();
    expect(a.net.log.length).toBeGreaterThan(before);
    expect(card(ctl)!.id).toBe("ok");
    expect(kit.changes()).toBe(1); // the worker is told (the badge)
    const n = a.net.log.length;
    await ctl.roundIfDue();
    expect(a.net.log.length).toBe(n);
    await ctl.syncNow();
    expect(a.net.log.length).toBeGreaterThan(n);
  });

  it("inside a backoff the page runs no round of its own (the worker does, at its end); Sync now still does", async () => {
    const { w, a, pa } = await syncedPair();
    const { ctl } = panelOf(a, pa, w);
    a.net.partition(true);
    await ctl.syncNow();
    expect(ctl.state.facts).toMatchObject({ status: "offline", failures: 1 });
    expect(ctl.state.facts!.backoffUntil!).toBeGreaterThan(w.clock.now);
    a.net.partition(false);
    const n = a.net.log.length;
    await ctl.roundIfDue();
    expect(a.net.log.length).toBe(n);
    w.advance(ctl.state.facts!.backoffUntil! - w.clock.now + 1);
    await ctl.roundIfDue();
    expect(a.net.log.length).toBeGreaterThan(n);
    expect(ctl.state.facts!.status).toBe("ok");
  });

  it("the permission withdrawn: the card says paused at once, rounds send nothing; Allow again asks in the click, then a round resumes", async () => {
    const { w, a, pa } = await syncedPair();
    const { ctl, kit } = panelOf(a, pa, w);
    pa.granted = false;
    await ctl.refresh();
    expect(card(ctl)!.id).toBe("permission_removed"); // from Chrome's answer, though the stored status is still ok
    expect(card(ctl)!.actions).toEqual(["grant"]);
    const n = a.net.log.length;
    await ctl.syncNow();
    expect(a.net.log.length).toBe(n);
    expect(ctl.state.facts!.status).toBe("permission_removed");
    pa.answer = false;
    click(
      pa,
      asking(kit, (g) => void ctl.grant(g)),
    );
    await until(() => ctl.state.doing === null && ctl.state.failure !== null);
    expect(ctl.state.failure).toEqual({ code: "declined" });
    pa.answer = true;
    click(
      pa,
      asking(kit, (g) => void ctl.grant(g)),
    );
    await until(() => ctl.state.facts?.status === "ok", "the round after the grant");
    expect(card(ctl)!.id).toBe("ok");
    expect(pa.log.filter((x) => x.startsWith("request"))).toEqual(["request", "request"]);
  });

  it("turning sync off: the password revokes this device, then the records go and the permission is removed last", async () => {
    const { w, a, b, pb } = await syncedPair();
    const { ctl, kit } = panelOf(b, pb, w);
    await ctl.refresh();
    let ok = false;
    click(
      pb,
      asking(
        kit,
        (g) =>
          void ctl.turnOff("wrong password here", g, true).then((x) => {
            ok = x;
          }),
      ),
    );
    await until(() => ctl.state.doing === null && ctl.state.failure !== null);
    expect(ok).toBe(false);
    expect(ctl.state.failure!.code).toBe("wrong_secret");
    expect(pb.granted).toBe(true); // it was there before: kept
    expect((await b.engine.view()).syncOn).toBe(true);
    click(
      pb,
      asking(
        kit,
        (g) =>
          void ctl.turnOff(w.password, g, true).then((x) => {
            ok = x;
          }),
      ),
    );
    await until(() => ok, "the turn-off");
    expect(ctl.state.done).toBe("syncDoneOff");
    expect((await b.engine.view()).syncOn).toBe(false);
    expect(pb.log.at(-1)).toBe("remove");
    expect(pb.granted).toBe(false);
    expect((await b.vault()).entries.length).toBe(2); // the accounts stay
    const devs = await a.engine.api.devices({
      kind: "device",
      deviceId: ((await a.local.settlePins()) as { deviceId: string }).deviceId,
      key: ((await a.local.settlePins()) as { keyPair: { privateKey: CryptoKey } }).keyPair.privateKey,
    });
    expect(devs.devices.filter((x) => x.revoked_at !== null).length).toBe(1);
  });

  it("turning off with the permission withdrawn: the click asks for it; declined, only the local removal is left", async () => {
    const { w, b, pb } = await syncedPair();
    const { ctl, kit } = panelOf(b, pb, w);
    pb.granted = false;
    pb.answer = false;
    await ctl.refresh();
    const n = b.net.log.length;
    click(
      pb,
      asking(kit, (g) => void ctl.turnOff(w.password, g, false)),
    );
    await until(() => ctl.state.offlineOnly, "the local-only offer");
    expect(b.net.log.length).toBe(n);
    expect((await b.engine.view()).syncOn).toBe(true);
    expect(await ctl.removeIdentity()).toBe(true);
    expect((await b.engine.view()).syncOn).toBe(false);
    expect(ctl.state.done).toBe("syncDoneRemoved");
    expect(b.net.log.length).toBe(n); // local only
  });

  it("turning off with the permission withdrawn and granted by the click, but a wrong password: the permission goes again", async () => {
    const { w, b, pb } = await syncedPair();
    const { ctl, kit } = panelOf(b, pb, w);
    pb.granted = false;
    await ctl.refresh();
    click(
      pb,
      asking(kit, (g) => void ctl.turnOff("not it", g, false)),
    );
    await until(() => ctl.state.doing === null && ctl.state.failure !== null);
    expect(ctl.state.failure!.code).toBe("wrong_secret");
    expect(pb.granted).toBe(false); // back to how it was before the click
  });

  it("a device the server no longer accepts: the card offers a retry and the local removal; removing keeps the accounts", async () => {
    const { w, a, b, pb } = await syncedPair();
    const bid = ((await b.local.settlePins()) as { deviceId: string }).deviceId;
    await revokeDevice(a.engine, bid, w.password);
    const { ctl } = panelOf(b, pb, w);
    await ctl.syncNow();
    expect(card(ctl)).toMatchObject({ id: "rejected_by_server", actions: ["sync_now", "remove_identity"] });
    expect(await ctl.removeIdentity()).toBe(true);
    expect((await b.engine.view()).syncOn).toBe(false);
    expect((await b.vault()).entries.length).toBe(2);
    expect(pb.granted).toBe(false);
  });

  it("a merge the guard stopped is shown for review; Keep mine keeps the account here and on the other device", async () => {
    const { w, a, b, pa, pb } = await syncedPair();
    const aws = (await a.vault()).entries.find((e) => e.issuer === "AWS")!.id;
    w.advance(1000);
    await b.svc.mutate((v, c) => purgeEntry(deleteEntry(v, aws, c), aws, c)); // erased in one step, past A's trash
    expect((await b.engine.round()).status).toBe("ok");
    const { ctl } = panelOf(a, pa, w);
    await ctl.syncNow();
    expect(ctl.state.review).toMatchObject({ for: "round", report: { purgedAlive: [aws] } });
    expect(card(ctl)!.id).toBe("review_needed");
    await ctl.answer(answerOf(ctl.state.review!, "keep"));
    expect(ctl.state.review).toBeNull();
    expect(ctl.state.facts!.status).toBe("ok");
    expect(isAlive((await a.vault()).entries.find((e) => e.id === aws)!)).toBe(true);
    const { ctl: cb } = panelOf(b, pb, w);
    await cb.syncNow();
    expect(isAlive((await b.vault()).entries.find((e) => e.id === aws)!)).toBe(true);
  });

  it("keys changed on another device: the card asks for the master password, which takes them over here", async () => {
    const { w, a, b, pb } = await syncedPair();
    await commitRotation(a.engine, await prepareRotation(a.engine, w.password));
    const { ctl } = panelOf(b, pb, w);
    await ctl.syncNow();
    expect(card(ctl)).toMatchObject({ id: "needs_password", actions: ["adopt"] });
    await ctl.adopt("wrong one");
    expect(ctl.state.failure ?? ctl.state.done).toBeTruthy();
    expect(card(ctl)!.id).toBe("needs_password");
    await ctl.adopt(w.password);
    expect(ctl.state.done).toBe("syncDoneAdopted");
    await ctl.syncNow();
    expect(card(ctl)!.id).toBe("ok");
  });

  it("the notices the user has seen are removed, the ones that came after stay", async () => {
    const { w, a, pa } = await syncedPair();
    const { ctl } = panelOf(a, pa, w);
    await a.engine.state.notice({ kind: "device_joined", at: 1 });
    await a.engine.state.notice({ kind: "rollback", at: 2 });
    await ctl.refresh();
    const shown = ctl.state.facts!.notices.filter((n) => n.kind === "device_joined" || n.kind === "rollback");
    expect(shown.length).toBe(2);
    await a.engine.state.notice({ kind: "clock_skew", at: 3 });
    await ctl.dismiss(shown);
    expect(ctl.state.facts!.notices.map((n) => n.kind)).toEqual(["clock_skew"]);
  });

  it("a sync identity lost from IndexedDB: unlock to restore it; the page's round restores it and says so once", async () => {
    const { w, b, pb } = await syncedPair();
    b.disk.idb.data.clear(); // what some browsers do to IndexedDB at every stop
    gate(b, pb);
    const { ctl } = panelOf(b, pb, w);
    await ctl.refresh();
    expect(cardOf(ctl.state.facts!, "locked", 0, T)).toMatchObject({ id: "identity_missing", actions: ["unlock"] });
    expect(card(ctl)).toMatchObject({ id: "identity_missing", lines: [{ k: "syncIdentityMissingRestoring" }] });
    await ctl.syncNow();
    expect(ctl.state.facts!.local).toBe("on");
    expect(ctl.state.done).toBe("syncDoneIdentityRestored");
    expect(card(ctl)!.id).toBe("ok");
  });

  it("saves kept while they can't be read: the notice says how many and why; Advanced deletes exactly those shown, never another", async () => {
    const { w, a, pa } = await syncedPair();
    const vk = await a.vk();
    const parked = {
      ...(await orphanEntry(await a.vault(vk), vk, 1, "x")),
      parked: { reason: "schema", vkId: null, at: 1 },
    };
    const open = await orphanEntry(await a.vault(vk), vk, 2, "y");
    a.disk.kv.data.set(SYNC_KEYS.orphan, { v: 1, items: [parked, open] });
    const { ctl } = panelOf(a, pa, w);
    await ctl.refresh();
    expect(ctl.state.facts!.parked).toMatchObject({ count: 1, reasons: ["schema"] });
    const shown = ctl.state.facts!.parked!;
    // the list changes after the user saw it: the delete is refused, nothing deleted
    const another = {
      ...(await orphanEntry(await a.vault(vk), vk, 3, "z")),
      parked: { reason: "key", vkId: null, at: 2 },
    };
    a.disk.kv.data.set(SYNC_KEYS.orphan, { v: 1, items: [parked, open, another] });
    await ctl.discard(shown, "not the master password"); // it cannot be undone: the master password first
    expect(ctl.state.failure).toMatchObject({ code: "wrong_secret" });
    await ctl.discard(shown, w.password);
    expect(ctl.state.failure).toMatchObject({ code: "bad_state" });
    expect((a.disk.kv.data.get(SYNC_KEYS.orphan) as { items: unknown[] }).items).toHaveLength(3);
    // shown again from the new facts, then deleted: exactly the parked ones, the open one stays
    await ctl.discard(ctl.state.facts!.parked!, w.password);
    expect(ctl.state.done).toBe("syncDoneDiscarded");
    expect((a.disk.kv.data.get(SYNC_KEYS.orphan) as { items: { head: string }[] }).items.map((x) => x.head)).toEqual([
      "y",
    ]);
  });

  it("an unfinished first upload (every answer lost): Check again asks the server; never created, it is undone and the permission given back", async () => {
    const w = new World();
    const perm = permissions(true);
    const { d, code } = await protectedProfile(w, "A", perm);
    d.net.inject({ match: "POST /v1/vault/init", kind: "fail_before", count: 3 });
    const up = await firstUpload(d.engine, {
      session: await w.server.session(EMAIL),
      password: w.password,
      recoveryCode: code,
      deviceName: "A",
      email: EMAIL,
    });
    expect(up.kind).toBe("unconfirmed");
    const { ctl } = panelOf(d, perm, w);
    await ctl.syncNow();
    expect(card(ctl)).toMatchObject({ id: "upload_unfinished", actions: ["check_again"] });
    w.advance(11 * 60_000); // past the window in which the lost request could still land
    await ctl.checkAgain();
    expect(ctl.state.done).toBe("syncDoneNotCreated");
    expect((await d.engine.view()).syncOn).toBe(false);
    expect(perm.granted).toBe(false);
  });
});
