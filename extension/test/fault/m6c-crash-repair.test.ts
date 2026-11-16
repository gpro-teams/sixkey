// M6C crash matrix for the repair over an older key (SYNC-DESIGN §4.2, server_older_key; docs/design/notes/M6C-NOTES.md
// §1): the device dies at every step of the repair (each storage write and each request, before it happens, or after it
// happened with the answer lost with the process), the browser restarts, and the user unlocks and carries on: a round,
// and the repair again where the card still asks for it. What must hold whatever the step was: the master password and
// this device's recovery code still open its vault (nothing local changed keys), no account is lost, and afterwards the
// server, this device and the device that had taken the newer keys too agree on the keys (the newer ones) and the data.
// The restore also undid a revocation (a device revoked as lost from the Sync section, in that flow's own order, the
// restore coming before this device's next round): at the end it is revoked again. The repair is given the devices its
// form would show (revokedBeforeRestore), as the page gives them.
import { beforeAll, describe, expect, it } from "vitest";
import { unlockWithPassword, unlockWithRecoveryCode, type Keyring } from "../../src/core/crypto/keyring";
import "fake-indexeddb/auto";
import { revokedBeforeRestore } from "../../src/core/sync/engine/devices";
import { adoptWithSecret, repairKeys } from "../../src/core/sync/engine/keys";
import { canonicalJson } from "../../src/core/vault/merge";
import { aliveEntries } from "../../src/core/vault/model";
import type { Snapshot } from "../helpers/fake-server";
import { runDying, type Mode } from "../helpers/m3-crash";
import { cloneWorld, EMAIL, quiesce, type Device, type World, worldOf } from "../helpers/m3-world";
import { deviceIdOf, revokeAsLost } from "../helpers/m6c-flows";

const opens = (kr: Keyring, c: { password: string } | { recoveryCode: string }) =>
  ("password" in c ? unlockWithPassword(kr, c.password) : unlockWithRecoveryCode(kr, c.recoveryCode)).then(
    () => true,
    () => false,
  );

let base: World;
let vk2 = "";
let xId = "";
beforeAll(async () => {
  const w = await worldOf(3, ["GitHub", "AWS"]);
  const [a, b, x] = w.devices as [Device, Device, Device];
  const before = w.server.snapshot();
  xId = await deviceIdOf(x);
  w.code = await revokeAsLost(w, a, xId); // the Sync section's flow: revoke, then rotate
  w.advance(1000);
  await b.engine.round();
  await adoptWithSecret(b.engine, { password: w.password });
  w.advance(1000);
  await a.add("after the rotation"); // on A alone: no round of A's before the restore
  w.server.restore(before as Snapshot); // an honest restore of the server to before the revocation and the rotation
  vk2 = (await a.generation()).keyring.vkId;
  expect((await a.engine.round()).status).toBe("server_older_key");
  base = w;
}, 60_000);

/** The user's way back after the restart: unlock, a round; the repair again while the card still asks for it. */
async function wayBack(w: World, d: Device): Promise<void> {
  await d.restartBrowser();
  await d.svc.unlockWithPassword(w.password);
  for (let i = 0; i < 4; i++) {
    const r = await d.engine.round({ explicit: true });
    if (r.status === "ok") return;
    if (r.status === "server_older_key") {
      const shown = (await revokedBeforeRestore(d.engine)).map((x) => x.id); // what the form names
      await repairKeys(d.engine, {
        oldPassword: w.password,
        password: w.password,
        recoveryCode: w.code,
        revokeAgain: shown,
      });
    }
  }
}

describe("the repair over an older key dies at every step; nothing is lost and every device ends on the newer keys", () => {
  it("repairKeys (server_older_key)", async () => {
    let rows = 0;
    for (const mode of ["before", "after"] as Mode[]) {
      for (let at = 1; at < 120; at++) {
        const w = cloneWorld(base);
        const [a, b] = w.devices as [Device, Device, Device];
        const ids = canonicalJson(
          aliveEntries(await a.vault())
            .map((e) => e.id)
            .sort(),
        );
        const shown = (await revokedBeforeRestore(a.engine)).map((x) => x.id);
        expect(shown).toEqual([xId]);
        const r = await runDying(a, at, mode, (c) =>
          repairKeys(c.engine, {
            oldPassword: w.password,
            password: w.password,
            recoveryCode: w.code,
            revokeAgain: shown,
          }),
        );
        const label = `repair @${at} ${mode}`;
        if (r.error !== undefined && !/unconfirmed|offline|network/.test(String(r.error))) throw r.error;
        await a.restartBrowser();
        const kr = (await a.generation()).keyring;
        expect(kr.vkId, `${label}: this device's key did not change`).toBe(vk2);
        expect(await opens(kr, { password: w.password }), `${label}: the password opens it`).toBe(true);
        expect(await opens(kr, { recoveryCode: w.code }), `${label}: the code opens it`).toBe(true);
        await wayBack(w, a);
        await wayBack(w, b);
        await quiesce(w, 8, [a, b]);
        const sv = w.server.account(EMAIL).vault!;
        expect(sv.vk_id, `${label}: the server is on the newer key`).toBe(vk2);
        const xRow = w.server.state(EMAIL).devices.find((d) => d.device_id === xId)!;
        expect(xRow.revoked_at, `${label}: the device the restore had brought back is revoked again`).not.toBeNull();
        const server = JSON.parse(sv.bundle).keyring as Keyring;
        expect(canonicalJson((await a.generation()).keyring), label).toBe(canonicalJson(server));
        expect(canonicalJson((await b.generation()).keyring), label).toBe(canonicalJson(server));
        expect(
          canonicalJson(
            aliveEntries(await a.vault())
              .map((e) => e.id)
              .sort(),
          ),
          `${label}: nothing lost`,
        ).toBe(ids);
        expect(canonicalJson(await b.vault()), label).toBe(canonicalJson(await a.vault()));
        rows++;
        if (!r.reached) {
          // the whole repair ran in this row: every step of it was a crash point in the rows before
          expect(r.steps.some((x) => x.includes("/v1/keys/rotate"))).toBe(true);
          expect(r.steps.some((x) => /\/v1\/devices\/[^ ]+\/revoke/.test(x))).toBe(true);
          expect(r.steps.length).toBeGreaterThan(8);
          break;
        }
      }
    }
    expect(rows).toBeGreaterThan(10);
  }, 1_200_000);
});
