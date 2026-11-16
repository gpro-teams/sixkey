// M6C crash matrix for a revocation's new write (SYNC-DESIGN §3.10; docs/design/notes/M6C-NOTES.md §1 item 5): after the
// server's 200, revokeDevice records the action and then marks the device revoked in this device's stored list, the list
// from which a repair after a restore of the server revokes again what the restore undid. The device dies at every step
// of the revocation (each storage write and each request, before it happens, or after it happened with the answer lost
// with the process), the browser restarts, the user unlocks and a round runs. What must hold whatever the step was: the
// stored list says the device is revoked exactly when the server does (the round's first step, which refreshes the list,
// catches a mark the death left out), and a device the server has revoked is never listed active again here.
import "fake-indexeddb/auto";
import { beforeAll, describe, expect, it } from "vitest";
import { revokeDevice } from "../../src/core/sync/engine/keys";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { runDying, type Mode } from "../helpers/m3-crash";
import { cloneWorld, EMAIL, type Device, type World, worldOf } from "../helpers/m3-world";
import { deviceIdOf } from "../helpers/m6c-flows";

let base: World;
let xId = "";
beforeAll(async () => {
  base = await worldOf(3, ["GitHub"]);
  xId = await deviceIdOf(base.devices[2]!);
}, 60_000);

const storedRevoked = (d: Device) =>
  (
    ((d.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>).devices ?? []) as {
      id: string;
      revoked: boolean;
    }[]
  ).find((x) => x.id === xId)?.revoked === true;

describe("a revocation dies at every step; the stored list follows the server", () => {
  it("revokeDevice", async () => {
    let rows = 0;
    for (const mode of ["before", "after"] as Mode[]) {
      for (let at = 1; at < 60; at++) {
        const w = cloneWorld(base);
        const [a] = w.devices as [Device, Device, Device];
        const label = `revoke @${at} ${mode}`;
        const r = await runDying(a, at, mode, (c) => revokeDevice(c.engine, xId, w.password));
        if (!r.reached && r.error !== undefined) throw r.error;
        await a.restartBrowser();
        await a.svc.unlockWithPassword(w.password);
        await a.engine.round({ explicit: true });
        const onServer = w.server.state(EMAIL).devices.find((d) => d.device_id === xId)!.revoked_at !== null;
        expect(storedRevoked(a), `${label}: the stored list says what the server says`).toBe(onServer);
        rows++;
        if (!r.reached) {
          expect(onServer).toBe(true);
          break;
        }
      }
    }
    expect(rows).toBeGreaterThan(6);
  }, 600_000);
});
