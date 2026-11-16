// M6C, the revocations a restore of the server undid, done again by the repair before it sends its keys (SYNC-DESIGN
// §3.10, §4.2; docs/design/notes/M6C-NOTES.md §1 item 4). A restore to before a rotation is also a restore to before the
// "lost" revocation that rotation followed: the stolen device is active again on the restored server, and the repair
// would otherwise hand it the newer keys. Which devices: those this device has seen revoked, in its stored list, where a
// revocation is sticky (revokeDevice marks it at once; every refresh, at step 1 of every round, keeps it), that the
// restored server lists as active. The repair's form names them before the click, and the repair revokes no other.
// The "lost" revocations here run through the Sync section's own flow (RevokeFlow), in its order.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { revokedBeforeRestore } from "../../src/core/sync/engine/devices";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import {
  adoptWithSecret,
  commitRotation,
  KeyOpError,
  prepareRotation,
  repairKeys,
  revokeDevice,
} from "../../src/core/sync/engine/keys";
import { asking } from "../../src/options/sync/permission";
import { RepairFlow } from "../../src/options/sync/repair";
import type { Snapshot } from "../helpers/fake-server";
import { EMAIL, type Device, type World, worldOf } from "../helpers/m3-world";
import { click, kitOf, permissions, until } from "../helpers/m6-kit";
import { deviceIdOf, revokeAsLost } from "../helpers/m6c-flows";

const revokedOn = (w: World, id: string) => w.server.state(EMAIL).devices.find((d) => d.device_id === id)!.revoked_at;
const stored = (d: Device) =>
  ((d.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>).devices ?? []) as {
    id: string;
    revoked: boolean;
  }[];
const sent = (w: World, from: number, op: string) => w.server.requests.slice(from).filter((r) => r.op === op).length;

/** The repair's form on `d` (Chrome asked in the click), up to the form. */
async function repairForm(d: Device): Promise<RepairFlow> {
  const perm = permissions(true);
  const kit = kitOf(d, perm);
  const f = new RepairFlow(kit);
  click(
    perm,
    asking(kit, (g) => void f.start(g)),
  );
  await until(() => f.state.at !== "asking", "the form");
  return f;
}

/**
 * A, B, X in sync; A revokes X as lost through the Sync section's flow (which rotates); B takes the newer keys; then
 * the server is restored to before both, before A's next round. X is active again and holds the older key.
 */
async function lostThenRestored() {
  const w = await worldOf(3, ["GitHub"]);
  const [a, b, x] = w.devices as [Device, Device, Device];
  const before = w.server.snapshot();
  const xId = await deviceIdOf(x);
  const code = await revokeAsLost(w, a, xId);
  w.advance(1000);
  await b.engine.round();
  await adoptWithSecret(b.engine, { password: w.password });
  w.server.restore(before as Snapshot);
  return { w, a, b, x, xId, code };
}

describe("the revocations a restore undid: done again by the repair", () => {
  it("revoked as lost from the Sync section, then the server restored before this device's next round: the form names it, the repair revokes it before the keys go, and it never gets them", async () => {
    const { w, a, b, x, xId, code } = await lostThenRestored();
    expect(stored(a).find((d) => d.id === xId)?.revoked).toBe(true); // marked at once by the revocation itself
    expect(revokedOn(w, xId)).toBeNull();
    expect((await a.engine.round()).status).toBe("server_older_key");
    expect(stored(a).find((d) => d.id === xId)?.revoked).toBe(true); // the restored list did not unmark it (sticky)
    const f = await repairForm(a);
    expect(f.state).toMatchObject({ at: "form", again: [{ id: xId, name: "Device C" }] }); // its name opens under the older key
    await f.submit({ oldPassword: "", password: w.password, recoveryCode: code });
    expect(f.state.at).toBe("done");
    expect(revokedOn(w, xId)).not.toBeNull();
    const ops = w.server.requests.map((r) => r.op);
    expect(ops.lastIndexOf("POST /v1/devices/{id}/revoke")).toBeLessThan(ops.lastIndexOf("POST /v1/keys/rotate"));
    const notices = (await a.engine.view()).state.notices ?? [];
    expect(notices.filter((n) => n.kind === "device_revoked")).toEqual([expect.objectContaining({ n: 1 })]);
    // X: refused by the server; with the master password it still cannot take the newer keys
    expect((await x.engine.round()).status).toBe("rejected_by_server");
    const tried = await adoptWithSecret(x.engine, { password: w.password }).then(
      (r) => r.kind,
      (e: unknown) => (e as KeyOpError).code,
    );
    expect(tried).toBe("device_revoked");
    expect((await x.generation()).keyring.vkId).not.toBe((await a.generation()).keyring.vkId);
    expect((await b.engine.round()).status).toBe("ok");
  });

  it("a device still waiting for the password of a newer key learns the revocation at its round's first step: its repair revokes the stolen device again, which never reads what came after", async () => {
    const w = await worldOf(3, ["GitHub"]);
    const [a, b, x] = w.devices as [Device, Device, Device];
    const before = w.server.snapshot(); // VK1, X active
    const xId = await deviceIdOf(x);
    // a routine rotation VK1 -> VK2, taken by B and X
    const h1 = await prepareRotation(a.engine, w.password);
    await commitRotation(a.engine, h1);
    for (const d of [b, x]) {
      w.advance(1000);
      await d.engine.round();
      await adoptWithSecret(d.engine, { password: w.password });
      await d.engine.round();
    }
    await a.engine.round();
    // X is lost: A revokes it from the Sync section, which rotates VK2 -> VK3
    await revokeAsLost(w, a, xId);
    w.advance(1000);
    // B has not typed its password since (needs_password) and keeps editing locally (R4)
    expect((await b.engine.round()).status).toBe("needs_password");
    expect(stored(b).find((d) => d.id === xId)?.revoked).toBe(true); // learnt at step 1, before the key check
    await b.add("B after X was revoked");
    w.server.restore(before as Snapshot); // back to VK1: X active again
    expect((await b.engine.round()).status).toBe("server_older_key");
    const shown = (await revokedBeforeRestore(b.engine)).map((r) => r.id); // what B's form names
    expect(shown).toEqual([xId]);
    await repairKeys(b.engine, {
      oldPassword: w.password,
      password: w.password,
      recoveryCode: h1.recoveryCode,
      revokeAgain: shown,
    });
    expect(revokedOn(w, xId)).not.toBeNull();
    expect((await x.engine.round()).status).toBe("rejected_by_server");
    expect((await x.vault()).entries.some((e) => e.issuer === "B after X was revoked")).toBe(false);
  });

  it("the page showed another list: refused before anything is sent (stale), and the form comes back with the list as it is now", async () => {
    const { w, a, b, xId, code } = await lostThenRestored();
    await a.engine.round();
    const n0 = w.server.requests.length;
    await expect(
      repairKeys(a.engine, { oldPassword: w.password, password: w.password, recoveryCode: code, revokeAgain: [] }),
    ).rejects.toMatchObject({ code: "stale" });
    expect(sent(w, n0, "POST /v1/devices/{id}/revoke") + sent(w, n0, "POST /v1/keys/rotate")).toBe(0);
    // through the form: it showed X; meanwhile another revocation this device saw comes to light (marked here)
    const f = await repairForm(a);
    expect(f.state).toMatchObject({ at: "form", again: [{ id: xId }] });
    const bId = await deviceIdOf(b);
    await a.engine.state.rememberRevoked(bId);
    await f.submit({ oldPassword: "", password: w.password, recoveryCode: code });
    expect(f.state).toMatchObject({ at: "form", failure: { code: "stale" } });
    expect((f.state as unknown as { again: { id: string }[] }).again.map((r) => r.id).sort()).toEqual(
      [xId, bId].sort(),
    );
    expect(sent(w, n0, "POST /v1/devices/{id}/revoke")).toBe(0);
  });

  it("a lock while the revocations go: no more is sent, neither the next revocation nor the keys", async () => {
    const w = await worldOf(4, ["GitHub"]);
    const [a, b, x, y] = w.devices as [Device, Device, Device, Device];
    const before = w.server.snapshot();
    const [xId, yId] = [await deviceIdOf(x), await deviceIdOf(y)];
    await revokeAsLost(w, a, xId);
    const code = await revokeAsLost(w, a, yId);
    w.advance(1000);
    await b.engine.round();
    await adoptWithSecret(b.engine, { password: w.password });
    w.server.restore(before as Snapshot);
    expect((await a.engine.round()).status).toBe("server_older_key");
    const shown = (await revokedBeforeRestore(a.engine)).map((r) => r.id); // what the form names
    expect(shown.sort()).toEqual([xId, yId].sort());
    a.net.inject({ match: "POST /v1/devices/{id}/revoke", kind: "hold" });
    const run = repairKeys(a.engine, {
      oldPassword: w.password,
      password: w.password,
      recoveryCode: code,
      revokeAgain: shown,
    }).catch((e: unknown) => e);
    while (a.net.heldCount === 0) await new Promise((r) => setTimeout(r, 0));
    a.disk.session.data = null; // a lock as the browser's session does it
    a.disk.session.epoch++;
    const n0 = w.server.requests.length;
    await a.net.release();
    expect(await run).toMatchObject({ code: "locked" });
    expect(sent(w, n0, "POST /v1/devices/{id}/revoke")).toBe(1); // the one on the wire, and no other
    expect(sent(w, n0, "POST /v1/keys/rotate")).toBe(0);
    expect([revokedOn(w, xId) !== null, revokedOn(w, yId) !== null].filter(Boolean)).toHaveLength(1);
  });

  it("a network error in a revocation: the repair stops before its keys, said as the network (not as an answer still awaited)", async () => {
    const { w, a, code } = await lostThenRestored();
    await a.engine.round();
    const f = await repairForm(a);
    a.net.inject({ match: "POST /v1/devices/{id}/revoke", kind: "fail_before" });
    const n0 = w.server.requests.length;
    await f.submit({ oldPassword: "", password: w.password, recoveryCode: code });
    expect(f.state).toEqual({ at: "failed", failure: { code: "offline" } });
    expect(sent(w, n0, "POST /v1/keys/rotate")).toBe(0);
  });

  it("a revocation the restore kept (made before the restore point): not sent again", async () => {
    const w = await worldOf(3, ["GitHub"]);
    const [a, b, x] = w.devices as [Device, Device, Device];
    const xId = await deviceIdOf(x);
    await revokeDevice(a.engine, xId, w.password);
    await a.engine.round();
    const before = w.server.snapshot(); // after the revocation, before the rotation
    const h = await prepareRotation(a.engine, w.password);
    await commitRotation(a.engine, h);
    await b.engine.round();
    await adoptWithSecret(b.engine, { password: w.password });
    w.server.restore(before as Snapshot);
    await a.engine.round();
    const f = await repairForm(a);
    expect(f.state).toMatchObject({ at: "form", again: [] });
    const n0 = w.server.requests.length;
    await f.submit({ oldPassword: "", password: w.password, recoveryCode: h.recoveryCode });
    expect(f.state.at).toBe("done");
    expect(sent(w, n0, "POST /v1/devices/{id}/revoke")).toBe(0);
    expect((await b.engine.round()).status).toBe("ok");
  });

  it("a failed device list at a round's first step fails that round; the next one reaches the key state", async () => {
    const { w, b } = await lostThenRestored();
    w.server.fault({ match: "GET /v1/devices", kind: "status", status: 503, code: "unavailable", retryAfter: 1 });
    expect((await b.engine.round({ explicit: true })).status).toBe("error");
    expect((await b.engine.round({ explicit: true })).status).toBe("server_older_key");
  });
});

describe("where the revocations come from: the stored list, refreshed at a round's first step", () => {
  it("a locked device waiting for a newer key's password learns a revocation from its locked round, before the key check", async () => {
    const w = await worldOf(3, ["GitHub"]);
    const [a, b, x] = w.devices as [Device, Device, Device];
    const xId = await deviceIdOf(x);
    await revokeAsLost(w, a, xId); // revokes, then rotates: B now waits for the newer key's password
    await b.lockNow();
    expect((await b.engine.round()).status).toBe("needs_password");
    expect(stored(b).find((d) => d.id === xId)?.revoked).toBe(true);
  });
});
