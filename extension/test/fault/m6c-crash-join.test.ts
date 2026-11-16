// M6C crash matrix for the approval join and its dedupe record (SYNC-DESIGN §3.5, revision 24): a profile with accounts
// of its own joins by approval, and dies at every step of the join (each storage write and each request, before it
// happens, or after it happened with the answer lost with the process): the request, the approval's steps, the local
// commit whose first write carries the dedupe record, the complete. The browser restarts, the user unlocks, and carries
// on: a round, and, where the join did not finish, the join again (approved again, after the old request's time),
// which takes over the earlier join's record when it is the merged one. What must hold whatever the step was: the
// joined profile ends with every account alive exactly once (the duplicates its join added in the trash, never erased,
// never a sole copy), the record cleared, and both devices on the same vault.
import "fake-indexeddb/auto";
import { beforeAll, describe, expect, it } from "vitest";
import { ApprovalJoin, Approver, commitJoin, type JoinPlan } from "../../src/core/sync/engine/enroll";
import type { SyncEngine } from "../../src/core/sync/engine/engine";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { canonicalJson } from "../../src/core/vault/merge";
import { aliveEntries, trashEntries } from "../../src/core/vault/model";
import { runDying, type Mode } from "../helpers/m3-crash";
import { cloneWorld, EMAIL, firstDevice, quiesce, World, type Device } from "../helpers/m3-world";
import { createProtected } from "../helpers/vaults";

let base: World;
beforeAll(async () => {
  const w = new World();
  const a = await firstDevice(w, ["GitHub", "AWS", "Mail"]);
  await a.engine.round();
  const b = w.device("B");
  await createProtected(b.svc, w.password);
  await b.svc.openView();
  for (const n of ["GitHub", "AWS", "Personal"]) {
    w.advance(1000);
    await b.add(n);
  }
  base = w;
}, 60_000);

/** The approval join of `e`'s profile, approved on `a` (engine level, the steps the two pages run), committed. */
async function join(w: World, a: Device, e: SyncEngine): Promise<string> {
  const j = await ApprovalJoin.start(e, {
    session: await w.server.session(EMAIL),
    deviceName: "Device B",
    email: EMAIL,
  });
  await j.poll();
  const approver = await Approver.start(a.engine, j.requestId, w.password);
  const asked = await j.poll();
  if (asked.kind !== "enter_code") throw new Error(`join: ${asked.kind}`);
  const sas = await j.submitPairingCode(approver.pairingCode);
  if (sas.kind !== "show_sas") throw new Error(`join: ${sas.kind}`);
  await approver.poll(w.password);
  const ok = await approver.submitSas(sas.sas, w.password);
  if (ok.kind !== "approved") throw new Error("not approved");
  const opened = await j.poll();
  if (opened.kind !== "approved") throw new Error(`join: ${opened.kind}`);
  return commitJoin((await j.prepare()) as JoinPlan);
}

/** The user's way back: unlock, rounds; where sync is not on (or the join did not finish), the join again. */
async function wayBack(w: World, a: Device, b: Device): Promise<void> {
  await b.restartBrowser();
  await b.svc.unlockWithPassword(w.password);
  for (let i = 0; i < 4; i++) {
    const r = await b.engine.round({ explicit: true });
    if (r.status === "ok") return;
    if (r.status === "off" || r.status === "join_unfinished") {
      w.advance(11 * 60_000); // past the time an old request could still land
      await join(w, a, b.engine);
    }
  }
}

describe("the approval join dies at every step; every account ends alive once, the duplicates in the trash", () => {
  it("the join (with its dedupe record)", async () => {
    let rows = 0;
    for (const mode of ["before", "after"] as Mode[]) {
      for (let at = 1; at < 200; at++) {
        const w = cloneWorld(base);
        const [a, b] = w.devices as [Device, Device];
        const label = `join @${at} ${mode}`;
        const r = await runDying(b, at, mode, (c) => join(w, a, c.engine));
        // a death leaves the rest of the run (which interleaves the approving device's steps) failing any way it may;
        // a run that did not die must have joined
        if (!r.reached && r.error !== undefined) throw r.error;
        await wayBack(w, a, b);
        await quiesce(w, 8, [b, a]);
        const vb = await b.vault();
        expect(
          aliveEntries(vb)
            .map((e) => e.issuer)
            .sort(),
          `${label}: every account alive, once`,
        ).toEqual(["AWS", "GitHub", "Mail", "Personal"]);
        expect(
          trashEntries(vb)
            .map((e) => e.issuer)
            .sort(),
          `${label}: the join's two duplicates in the trash`,
        ).toEqual(["AWS", "GitHub"]);
        expect(
          vb.entries.every((e) => e.secret !== ""),
          `${label}: nothing erased`,
        ).toBe(true);
        expect((b.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>).joinAdded ?? null, label).toBeNull();
        expect(canonicalJson(await a.vault()), `${label}: both devices agree`).toBe(canonicalJson(vb));
        rows++;
        if (!r.reached) {
          expect(r.steps.some((x) => x.includes("/complete"))).toBe(true);
          break;
        }
      }
    }
    expect(rows).toBeGreaterThan(20);
  }, 1_800_000);
});
