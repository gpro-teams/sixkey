// Saves of another vault (SYNC-DESIGN §4.7, revision 24): an entry this profile kept (for instance when sync was turned
// off) that belongs to a vault it no longer syncs is never removed by itself. A join to another vault keeps it, every
// round keeps it (parked, "another vault"), the Sync section says what it is and how to get it back, and only the
// user's confirmed "Advanced" delete removes it, exactly the entries shown.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { utf8 } from "../../src/core/crypto/bytes";
import { encryptVault } from "../../src/core/crypto/envelope";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { JoinFlow } from "../../src/options/sync/join";
import { parkedLines } from "../../src/options/sync/model";
import { SyncPanelCtl } from "../../src/options/sync/panel";
import { asking } from "../../src/options/sync/permission";
import { EMAIL, firstDevice, World } from "../helpers/m3-world";
import { click, kitOf, permissions, protectedProfile, until } from "../helpers/m6-kit";

const entries = (d: { disk: { kv: { data: Map<string, unknown> } } }) =>
  (d.disk.kv.data.get(SYNC_KEYS.orphan) as { items?: unknown[] } | undefined)?.items ?? [];

describe("saves of another vault", () => {
  it("kept through a join to another vault and every round, shown with their way out, deleted only as the user confirms", async () => {
    const w = new World();
    const a = await firstDevice(w, ["GitHub"]);
    await a.engine.round();
    const perm = permissions(false);
    const { d } = await protectedProfile(w, "B", perm, ["AWS"]);
    // a save of this profile's own vault that this build cannot read (a newer Sixkey wrote it), kept when sync went off
    const bvk = await d.vk();
    const own = (await d.generation()).keyring.vaultId;
    const env = await encryptVault(utf8(JSON.stringify({ schemaVersion: 2, vaultId: own, entries: [] })), bvk, {
      vaultId: own,
      rev: 9,
    });
    d.disk.kv.data.set(SYNC_KEYS.orphan, {
      v: 1,
      items: [
        {
          v: 1,
          from: null,
          checksum: "kept-at-turn-off",
          envelope: JSON.stringify(env),
          parked: { reason: "schema", vkId: null, at: 1 },
        },
      ],
    });
    const kit = kitOf(d, perm);
    const ctl = new SyncPanelCtl(kit, {
      vault: () => "unlocked",
      reload: async () => undefined,
      now: () => w.clock.now,
    });
    expect((await ctl.refresh()).parked).toMatchObject({ count: 1, reasons: ["schema"] });

    // the profile joins the synced vault (another vault than the save's)
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
    await j.chooseRecovery();
    await j.submitRecovery(w.code);
    await j.commit();
    expect(j.state.at).toBe("done");
    expect(entries(d)).toHaveLength(1); // the join removed nothing

    for (let i = 0; i < 2; i++) expect((await d.engine.round()).status).toBe("ok"); // in sync, and the save still kept
    expect(entries(d)).toHaveLength(1);
    const f = await ctl.refresh();
    expect(f.parked).toMatchObject({ count: 1, reasons: ["vault"] });
    expect(parkedLines(f.parked!).ways).toEqual([{ k: "syncParkedVault" }]);
    expect(f.notices.map((n) => n.kind)).not.toContain("orphan_unreadable");

    // "Advanced": deleted after the user confirmed exactly what was shown
    await ctl.discard(f.parked!, w.password);
    expect(ctl.state.done).toBe("syncDoneDiscarded");
    expect(entries(d)).toHaveLength(0);
    expect(ctl.state.facts?.parked).toBeNull();
  });
});
