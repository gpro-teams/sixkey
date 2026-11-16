// M6C crash matrix for the dedupe after an approval join (SYNC-DESIGN §3.5, revision 24; engine.ts dedupeAfterJoin): the
// joined device dies at every step of its first round, which now ends with the dedupe's two writes (the trash moves, a
// local edit with its outbox; then the record cleared with the notice), before or after each, the browser restarts,
// and the user unlocks and the devices sync until nothing moves. What must hold whatever the step was:
//   - no account is lost: every account either side had is alive, exactly once, on both devices;
//   - what went to the trash is only the join's copies, and nothing is erased;
//   - the record is gone, and the notice was given at most once (a death between the two writes leaves the moves done
//     and the notice unsaid: the residual docs/design/notes/M6C-NOTES.md §3 records);
//   - both devices end with the same vault.
import "fake-indexeddb/auto";
import { beforeAll, describe, expect, it } from "vitest";
import { Approver } from "../../src/core/sync/engine/enroll";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { canonicalJson } from "../../src/core/vault/merge";
import { aliveEntries, trashEntries } from "../../src/core/vault/model";
import { JoinFlow, type JoinState } from "../../src/options/sync/join";
import { asking } from "../../src/options/sync/permission";
import { runDying, type Mode } from "../helpers/m3-crash";
import { cloneWorld, EMAIL, firstDevice, quiesce, World, type Device } from "../helpers/m3-world";
import { click, kitOf, permissions, protectedProfile, until } from "../helpers/m6-kit";

let base: World;
let joinIds: string[] = [];
beforeAll(async () => {
  const w = new World();
  const a = await firstDevice(w, ["GitHub", "AWS", "Mail"]);
  await a.engine.round();
  const perm = permissions(false);
  const { d: b } = await protectedProfile(w, "B", perm, ["GitHub", "AWS", "Personal"]);
  const kit = kitOf(b, perm);
  const j = new JoinFlow(kit);
  click(
    perm,
    asking(kit, (g) => void j.start(g)),
  );
  await until(() => j.state.at === "signin");
  await j.signin.send(EMAIL);
  await j.signin.verify(w.server.inbox(EMAIL));
  await until(() => j.state.at === "choose");
  j.setName("B");
  await j.chooseApproval();
  const [req] = await Approver.list(a.engine);
  const approver = await Approver.start(a.engine, req!.request_id, w.password);
  await j.pollOnce();
  if (j.state.at !== "code") throw new Error(`no code step: ${j.state.at}`);
  await j.submitCode(approver.pairingCode); // the code the approver shows, typed here
  const s = j.state as JoinState; // moved on by submitCode
  if (s.at !== "sas") throw new Error("no sas");
  await approver.poll(w.password);
  const r = await approver.submitSas(s.sas, w.password);
  if (r.kind !== "approved") throw new Error("not approved");
  await j.pollOnce(); // approved: the payload opens under the code's key, the join is prepared
  await j.commit();
  expect(j.state.at).toBe("done");
  joinIds = ((b.disk.kv.data.get(SYNC_KEYS.state) as { joinAdded: { ids: string[] } }).joinAdded.ids ?? []).slice();
  expect(joinIds).toHaveLength(3);
  base = w;
}, 60_000);

const issuers = (v: Awaited<ReturnType<Device["vault"]>>) =>
  aliveEntries(v)
    .map((e) => e.issuer)
    .sort();
const dupNotices = (d: Device) =>
  (((d.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>)?.notices ?? []) as { kind: string }[]).filter(
    (n) => n.kind === "duplicates_trashed",
  ).length;

describe("the first round after an approval join dies at every step; nothing is lost, and the duplicates end in the trash", () => {
  it("the first round (with its dedupe)", async () => {
    let rows = 0;
    for (const mode of ["before", "after"] as Mode[]) {
      for (let at = 1; at < 200; at++) {
        const w = cloneWorld(base);
        const [a, b] = w.devices as [Device, Device];
        const label = `round @${at} ${mode}`;
        const r = await runDying(b, at, mode, (c) => c.engine.round({ explicit: true }));
        if (r.error !== undefined) throw r.error;
        await b.restartBrowser();
        await b.svc.unlockWithPassword(w.password);
        await quiesce(w, 8, [b, a]);
        const vb = await b.vault();
        expect(issuers(vb), `${label}: every account alive, once`).toEqual(["AWS", "GitHub", "Mail", "Personal"]);
        for (const e of trashEntries(vb))
          expect(joinIds, `${label}: only the join's copies in the trash`).toContain(e.id);
        expect(
          trashEntries(vb)
            .map((e) => e.issuer)
            .sort(),
          `${label}: the two duplicates in the trash`,
        ).toEqual(["AWS", "GitHub"]);
        expect(
          vb.entries.every((e) => e.secret !== ""),
          `${label}: nothing erased`,
        ).toBe(true);
        expect((b.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>).joinAdded ?? null, label).toBeNull();
        expect(dupNotices(b), `${label}: the notice at most once`).toBeLessThanOrEqual(1);
        expect(canonicalJson(await a.vault()), `${label}: both devices agree`).toBe(canonicalJson(vb));
        rows++;
        if (!r.reached) {
          expect(r.steps.length).toBeGreaterThan(5);
          // the whole round ran in this row: the merge, the upload, the dedupe's edit and record, the rerun's upload
          expect(r.steps.filter((x) => x === "send PUT /v1/vault")).toHaveLength(2);
          break;
        }
      }
    }
    expect(rows).toBeGreaterThan(10);
  }, 1_200_000);
});
