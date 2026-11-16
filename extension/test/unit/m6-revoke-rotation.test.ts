// "Lost, stolen or not sure" is revoke, then rotate (SYNC-DESIGN §3.10; src/options/sync/revoke.ts). The rotation's new
// code is shown and typed back before anything is revoked where it can be, so a run that stops there leaves nothing
// done; when the rotation cannot be prepared (a review waiting, an update required, offline ...), the device is revoked
// at once all the same (§3.14: revoking is never blocked) and the rotation recorded as owed, with why it waits. Once a
// "lost" run starts revoking, a rotation is owed (engine/state.ts rotationOwed) until the server accepts one, and every
// way the run can stop says so: the flow's end and the Sync section's card, which offers the rotation, lasts across a
// lock, a closed page or a new one, and says a device was revoked only when that is on the record. A rotation adopted
// from another device makes it moot only when it came after the revocation.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { listDevices } from "../../src/core/sync/engine/devices";
import {
  adoptWithSecret,
  changePassword,
  commitRotation,
  noteRotationOwed,
  prepareRotation,
  revokeDevice,
} from "../../src/core/sync/engine/keys";
import { deleteEntry, purgeEntry } from "../../src/core/vault/ops";
import { readFacts } from "../../src/options/sync/gateway";
import { KeyOpFlow } from "../../src/options/sync/keyops";
import { cardOf } from "../../src/options/sync/model";
import { SyncPanelCtl } from "../../src/options/sync/panel";
import { asking } from "../../src/options/sync/permission";
import { RevokeFlow } from "../../src/options/sync/revoke";
import { EMAIL, worldOf, type Device, type World } from "../helpers/m3-world";
import { click, kitOf, permissions, until, type TestKit } from "../helpers/m6-kit";

const NEW_PW = "violet-harbour-cinder-93";
const typeBack = (code: string, groups: [number, number]): [string, string] => {
  const p = code.split("-");
  return [p[groups[0]]!, p[groups[1]]!];
};
const revokes = (w: World) =>
  w.server.requests.filter(
    (r) => r.op === "POST /v1/devices/{id}/revoke" && typeof r.status === "number" && r.status < 300,
  ).length;
const owed = async (d: Device) => (await d.engine.view()).state.rotationOwed ?? null;
const cardFor = async (kit: TestKit, w: World) => cardOf(await readFacts(kit), "unlocked", w.clock.now, String);

/** B revokes A (which wrote the current keys, so only "lost" is offered), as far as the reason step. */
async function lostRevoke(target?: { id: string; name: string | null }) {
  const w = await worldOf(2);
  const [a, b] = w.devices as [Device, Device];
  const perm = permissions(true);
  const kit = kitOf(b, perm);
  const t = target ?? (await listDevices(b.engine)).find((r) => !r.current)!;
  const f = new RevokeFlow(kit, { id: t.id, name: t.name }, [], { random: () => 0 });
  click(
    perm,
    asking(kit, (g) => void f.start(g)),
  );
  await until(() => f.state.at === "password");
  await f.submitPassword(w.password);
  return { w, a, b, kit, perm, f };
}

/** B revokes A (it wrote the current keys) as "lost": as far as the reason confirmed. */
async function revokeWriterAsLost(b: Device, password: string) {
  const perm = permissions(true);
  const kit = kitOf(b, perm);
  const target = (await listDevices(b.engine)).find((r) => !r.current)!;
  const f = new RevokeFlow(kit, { id: target.id, name: target.name }, [], { random: () => 0 });
  click(
    perm,
    asking(kit, (g) => void f.start(g)),
  );
  await until(() => f.state.at === "password");
  await f.submitPassword(password);
  expect(f.state).toMatchObject({ at: "reason", reason: "lost", protectOnly: true });
  await f.confirm();
  return f;
}

/** On to the typed-back step, nothing revoked yet. */
async function toConfirm(f: RevokeFlow): Promise<[string, string]> {
  f.setReason("lost");
  await f.confirm();
  const s = f.state;
  if (s.at !== "show") throw new Error(`unexpected ${s.at}`);
  f.saved();
  const c = f.state;
  if (c.at !== "confirm") throw new Error(`unexpected ${c.at}`);
  return typeBack(s.code, c.groups);
}

describe("a 'lost' revocation when the rotation cannot be prepared: revoked at once, the rotation owed", () => {
  it("offline for the rotation's round: revoked, and the rotation owed with why it waits", async () => {
    const { w, b, kit, f } = await lostRevoke();
    expect(f.state).toMatchObject({ at: "reason", reason: "lost", protectOnly: true });
    b.net.inject({ match: "GET /v1/sync/status", kind: "fail_before", count: 20 }); // the rotation's round goes offline
    f.setReason("lost");
    await f.confirm();
    b.net.clearRules();
    expect([f.revoked, revokes(w)]).toEqual([1, 1]);
    expect(f.state).toEqual({ at: "owed", revoked: 1, waits: "not_synced" }); // the rotation needs a round that went through
    expect(await owed(b)).toMatchObject({ revoked: true, waits: "not_synced" });
    const card = await cardFor(kit, w);
    expect(card?.id).toBe("rotation_owed");
    expect(card?.lines.map((l) => l.k)).toEqual(["syncRotationOwedBody", "syncRotationOwedWaits", "syncFailNotSynced"]);
  });

  it("a round stopped for review (the device to revoke erased an account alive here): revoked all the same", async () => {
    const w = await worldOf(2);
    const [a, b] = w.devices as [Device, Device];
    const aws = (await a.vault()).entries.find((e) => e.issuer === "AWS")!.id;
    w.advance(1000);
    await a.svc.mutate((v, c) => purgeEntry(deleteEntry(v, aws, c), aws, c)); // erased in one step, past B's trash
    expect((await a.engine.round()).status).toBe("ok");
    expect((await b.engine.round()).status).toBe("review_needed");
    const f = await revokeWriterAsLost(b, w.password);
    expect(f.state).toEqual({ at: "owed", revoked: 1, waits: expect.any(String) });
    expect(revokes(w)).toBe(1);
  });

  it("an update required by the server: revoked all the same", async () => {
    const w = await worldOf(2);
    const [, b] = w.devices as [Device, Device];
    const perm = permissions(true);
    const kit = kitOf(b, perm);
    const target = (await listDevices(b.engine)).find((r) => !r.current)!;
    const f = new RevokeFlow(kit, { id: target.id, name: target.name }, [], { random: () => 0 });
    click(
      perm,
      asking(kit, (g) => void f.start(g)),
    );
    await until(() => f.state.at === "password");
    await f.submitPassword(w.password);
    (w.server as unknown as { minClientVersion: string }).minClientVersion = "99.0.0";
    await f.confirm();
    expect(f.state).toEqual({ at: "owed", revoked: 1, waits: "update_required" });
    expect(revokes(w)).toBe(1);
  });

  it("the server's keys behind this device's (a server restored from a backup): revoked all the same", async () => {
    const w = await worldOf(2);
    const [a, b] = w.devices as [Device, Device];
    const old = structuredClone(w.server.account(EMAIL).vault!);
    await changePassword(b.engine, w.password, NEW_PW);
    w.server.adminSetBundle(old.bundle, old.kver); // the keys A wrote, their verifiers with them
    Object.assign(w.server.account(EMAIL).vault!, {
      password_verifier: old.password_verifier,
      recovery_verifier: old.recovery_verifier,
    });
    expect((await b.engine.round()).keyStatus).toBe("keys_behind");
    const f = await revokeWriterAsLost(b, w.password); // the revocation proves against the server's keys, as the repair does
    expect(f.state).toEqual({ at: "owed", revoked: 1, waits: "keys_behind" });
    expect(revokes(w)).toBe(1);
    expect(await owed(b)).toMatchObject({ revoked: true, waits: "keys_behind" });
    void a;
  });

  it("keys from another device this one has not taken yet: the revocation waits for this device's update, and goes after it", async () => {
    const w = await worldOf(2);
    const [a, b] = w.devices as [Device, Device];
    const perm = permissions(true);
    const kit = kitOf(b, perm);
    await commitRotation(a.engine, await prepareRotation(a.engine, w.password)); // A wrote keys B has not taken
    const target = (await listDevices(b.engine)).find((r) => !r.current)!;
    const f = new RevokeFlow(kit, { id: target.id, name: target.name }, [], { random: () => 0 });
    click(
      perm,
      asking(kit, (g) => void f.start(g)),
    );
    await until(() => f.state.at === "password");
    await f.submitPassword(w.password);
    // the server's keys are checked with a key this device holds before the password is used against them (§3.9 R0)
    expect(f.state).toMatchObject({ at: "failed", failure: { code: "needs_adoption" } });
    expect([revokes(w), await owed(b)]).toEqual([0, null]);
    expect((await adoptWithSecret(b.engine, { password: w.password })).kind).toBe("adopted"); // the card's "Update this device"
    const g = await revokeWriterAsLost(b, w.password);
    expect(g.state.at).toBe("show");
  });
});

describe("a 'lost' revocation stopped before anything is revoked", () => {
  it("a lock while the rotation's code is on screen: nothing revoked, nothing owed", async () => {
    const { w, b, f } = await lostRevoke();
    f.setReason("lost");
    await f.confirm();
    expect(f.state.at).toBe("show");
    await b.lockNow();
    await f.locked();
    expect(f.state).toEqual({ at: "failed", failure: { code: "locked_out" } });
    expect([f.revoked, revokes(w), await owed(b)]).toEqual([0, 0, null]);
  });

  it("Cancel on the code's steps: nothing revoked, nothing owed", async () => {
    const { w, b, f } = await lostRevoke();
    await toConfirm(f);
    await f.cancel();
    expect(f.state).toEqual({ at: "closed" });
    expect([revokes(w), await owed(b)]).toEqual([0, null]);
  });

  it("the revocation refused before any device went: the owed rotation recorded for this run is taken back", async () => {
    const { w, b, f } = await lostRevoke({ id: "AAAAAAAAAAAAAAAAAAAAAA", name: "no such device" });
    await f.confirmGroups(await toConfirm(f));
    expect(f.state.at).toBe("failed");
    expect(JSON.stringify(f.state)).not.toMatch(/rotation_owed/);
    expect([revokes(w), await owed(b)]).toEqual([0, null]);
  });
});

describe("a 'lost' revocation whose rotation is not in effect", () => {
  it("the rotation refused after the revocation: the end says the keys still need rotating, and the card offers it", async () => {
    const { w, b, kit, f } = await lostRevoke();
    const back = await toConfirm(f);
    b.net.inject({ match: "GET /v1/sync/status", kind: "fail_before", count: 50 }); // the rotation's first request (the revocation sends none)
    await f.confirmGroups(back);
    expect(f.revoked).toBe(1);
    expect(revokes(w)).toBe(1);
    expect(f.state).toEqual({ at: "failed", failure: { code: "rotation_owed" } });
    b.net.clearRules();
    expect(await owed(b)).not.toBeNull();
    expect((await cardFor(kit, w))?.id).toBe("rotation_owed");
  });

  it("a lock while the devices are being revoked: revoked, and the end says the rotation is owed (the card too)", async () => {
    const { w, b, kit, f } = await lostRevoke();
    const back = await toConfirm(f);
    b.net.inject({ match: "POST /v1/devices/{id}/revoke", kind: "hold", count: 1 });
    const sending = f.confirmGroups(back);
    await until(() => b.net.heldCount === 1, "the revocation on its way");
    await b.lockNow();
    await f.locked();
    await b.net.release();
    await sending;
    expect(f.revoked).toBe(1);
    expect(f.state).toEqual({ at: "failed", failure: { code: "rotation_owed" } });
    await b.unlock();
    expect((await cardFor(kit, w))?.id).toBe("rotation_owed");
  });

  it("the page gone between the revocation and the rotation: the card says so until a rotation is in effect, which clears it", async () => {
    const w = await worldOf(2);
    const [, b] = w.devices as [Device, Device];
    const kit = kitOf(b, permissions(true));
    const target = (await listDevices(b.engine)).find((r) => !r.current)!;
    const record = await noteRotationOwed(b.engine, { targets: [target.id] });
    // the page closed before the revocation was sent: the card does not say a device was revoked
    expect((await readFacts(kit)).rotationOwed).toEqual({ revoked: false, waits: null });
    expect((await cardFor(kit, w))?.lines.map((l) => l.k)).toEqual(["syncRotationOwedUnsure"]);
    await record.revoked(await revokeDevice(b.engine, target.id, w.password));
    // the page closed here; a new one opens
    expect((await readFacts(kit)).rotationOwed).toEqual({ revoked: true, waits: null });
    expect((await cardFor(kit, w))?.actions).toEqual(["rotate_keys"]);
    // the card's rotation (keyops.ts "rotate"): in effect, nothing owed any more
    const perm = permissions(true);
    const k2 = kitOf(b, perm);
    const r = new KeyOpFlow(k2, "rotate", { random: () => 0 });
    click(
      perm,
      asking(k2, (g) => void r.start(g)),
    );
    await until(() => r.state.at === "form");
    await r.submit({ password: w.password });
    const s = r.state;
    if (s.at !== "show") throw new Error(`unexpected ${s.at}`);
    r.saved();
    const c = r.state;
    if (c.at !== "confirm") throw new Error(`unexpected ${c.at}`);
    await r.confirmGroups(typeBack(s.code, c.groups));
    expect(r.state.at).toBe("done");
    expect(await owed(b)).toBeNull();
    expect((await cardFor(kit, w))?.id).toBe("ok");
  });

  it("a record with no revocation on it is not cleared by a rotation: the card still asks to check the device list", async () => {
    const w = await worldOf(2);
    const [, b] = w.devices as [Device, Device];
    const kit = kitOf(b, permissions(true));
    const target = (await listDevices(b.engine)).find((r) => !r.current)!;
    await noteRotationOwed(b.engine, { targets: [target.id] }); // the page closed before the revocation was sent
    await commitRotation(b.engine, await prepareRotation(b.engine, w.password));
    expect((await readFacts(kit)).rotationOwed).toEqual({ revoked: false, waits: null });
    expect((await cardFor(kit, w))?.lines.map((l) => l.k)).toEqual(["syncRotationOwedUnsure"]);
  });

  it("a rotation adopted from another device makes the owed one moot when it came after the revocation", async () => {
    const w = await worldOf(3);
    const [a, b, c] = w.devices as [Device, Device, Device];
    const kit = kitOf(b, permissions(true));
    const target = (await listDevices(b.engine)).find((r) => r.name === "Device C")!;
    const record = await noteRotationOwed(b.engine, { targets: [target.id] });
    await record.revoked(await revokeDevice(b.engine, target.id, w.password));
    expect((await readFacts(kit)).rotationOwed).toEqual({ revoked: true, waits: null });
    await commitRotation(a.engine, await prepareRotation(a.engine, w.password)); // another device rotates, after it
    await b.engine.round();
    expect((await adoptWithSecret(b.engine, { password: w.password })).kind).toBe("adopted");
    await b.engine.round();
    expect((await readFacts(kit)).rotationOwed).toBeNull();
    void c;
  });

  it("a rotation from before the revocation does not: the revoked device could have fetched it", async () => {
    const w = await worldOf(3);
    const [a, b, c] = w.devices as [Device, Device, Device];
    const kit = kitOf(b, permissions(true));
    const target = (await listDevices(b.engine)).find((r) => r.name === "Device C")!;
    const vk1 = (await b.vk()).id;
    await commitRotation(a.engine, await prepareRotation(a.engine, w.password)); // before the revocation
    await b.engine.round();
    expect((await adoptWithSecret(b.engine, { password: w.password })).kind).toBe("adopted"); // B takes it (revoking needs that)
    await b.engine.round();
    const record = await noteRotationOwed(b.engine, { targets: [target.id] });
    await record.revoked(await revokeDevice(b.engine, target.id, w.password));
    expect((await readFacts(kit)).rotationOwed).toEqual({ revoked: true, waits: null });
    // even when the record names the key from before that rotation (written before this device took it): not moot
    await b.engine.state.update((st) => ({ rotationOwed: { ...st.rotationOwed!, vkId: vk1 } }));
    expect((await readFacts(kit)).rotationOwed).toEqual({ revoked: true, waits: null });
    void c;
  });
});

describe("an owed rotation and leaving sync on this device", () => {
  it("turning off and removing the sync identity keep the record unless the user chooses to drop it", async () => {
    const w = await worldOf(2);
    const [, b] = w.devices as [Device, Device];
    const perm = permissions(true);
    const kit = kitOf(b, perm);
    const target = (await listDevices(b.engine)).find((r) => !r.current)!;
    const record = await noteRotationOwed(b.engine, { targets: [target.id] });
    await record.revoked(await revokeDevice(b.engine, target.id, w.password));
    const ctl = new SyncPanelCtl(kit, {
      vault: () => "unlocked",
      reload: async () => undefined,
      now: () => w.clock.now,
    });
    await ctl.refresh();
    expect(await ctl.turnOff(w.password, Promise.resolve(true), true)).toBe(false);
    expect(ctl.state.failure).toEqual({ code: "rotation_owed_first" });
    expect(await ctl.removeIdentity()).toBe(false);
    expect(ctl.state.failure).toEqual({ code: "rotation_owed_first" });
    expect((await b.engine.view()).syncOn).toBe(true);
    expect(await owed(b)).not.toBeNull();
    // the user's choice: turned off, the record with it
    expect(await ctl.turnOff(w.password, Promise.resolve(true), true, undefined, { dropOwed: true })).toBe(true);
    expect((await b.engine.view()).syncOn).toBe(false);
  });
});
