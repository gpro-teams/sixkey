// M3 (SYNC-DESIGN §3.1, §3.3, §4.1, §4.2, §4.5, §4.7): the engine end to end against the FakeServer: the first upload's
// local half, a recovery-code join, the round's pull / merge / upload, lastSynced, the outbox push while locked, 409s.
import { describe, expect, it } from "vitest";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { lastSyncedOf } from "../../src/core/sync/local/state";
import { parseOutbox } from "../../src/core/sync/local/outbox";
import { headOf } from "../../src/core/sync/engine/state";
import { aliveEntries } from "../../src/core/vault/model";
import { deleteEntry, editEntry } from "../../src/core/vault/ops";
import { cj, EMAIL, firstDevice, joinDevice, quiesce, World, worldOf } from "../helpers/m3-world";

const puts = (w: World) => w.server.requests.filter((r) => r.op === "PUT /v1/vault" && r.status === 200).length;

describe("§3.1 the first upload, §3.3 a join, §4.2 rounds", () => {
  it("the first device uploads its vault (init), pins it in sync, and the next round is a full pull that uploads nothing", async () => {
    const w = new World();
    const a = await firstDevice(w, ["GitHub", "AWS"]);
    const st = await a.local.status();
    expect(st.kind).toBe("on");
    if (st.kind !== "on") return;
    expect(st.identity.state).toBe("enrolled");
    expect(st.identity.maxSeenKver).toBe(1);
    expect(st.identity.adopted).not.toBeNull();
    expect(st.identity.vkId).toBe((await a.generation()).keyring.vkId);
    const sv = w.server.account(EMAIL).vault!;
    expect(sv.version).toBe(1);
    expect(sv.bundle).toBe(JSON.stringify(JSON.parse(sv.bundle))); // raw text kept
    const r = await a.engine.round();
    expect(r).toMatchObject({ status: "ok", pulled: true, uploaded: false });
    expect(lastSyncedOf(a.disk.kv.data.get(SYNC_KEYS.state))).toEqual({
      version: 1,
      head: sv.head,
      checksum: (await a.generation()).envelope.checksum,
    });
    expect(w.server.violations).toEqual([]);
    expect(w.server.bugs).toEqual([]);
  });

  it("a second device joins with the recovery code, pulls the vault; edits on either side reach the other; quiet rounds send nothing", async () => {
    const w = await worldOf(2, ["GitHub", "AWS", "Stripe"]);
    const [a, b] = w.devices as [(typeof w.devices)[0], (typeof w.devices)[0]];
    expect(cj(await b.vault())).toBe(cj(await a.vault()));
    expect(
      aliveEntries(await b.vault())
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["AWS", "GitHub", "Stripe"]);
    // an edit on B
    const id = aliveEntries(await b.vault()).find((e) => e.issuer === "AWS")!.id;
    w.advance(5000);
    await b.svc.mutate((v, c) => editEntry(v, id, { label: "renamed" }, c));
    const before = puts(w);
    expect((await b.engine.round()).uploaded).toBe(true);
    expect(puts(w)).toBe(before + 1);
    expect((await a.engine.round()).pulled).toBe(true);
    expect(aliveEntries(await a.vault()).find((e) => e.id === id)!.label).toBe("renamed");
    // quiet
    const quiet = puts(w);
    await a.engine.round();
    await b.engine.round();
    expect(puts(w)).toBe(quiet);
    expect(cj(await a.vault())).toBe(cj(await b.vault()));
    expect(w.server.violations).toEqual([]);
  });

  it("concurrent edits on two devices both survive (409 → pull, merge, retry); the server ends on the merge", async () => {
    const w = await worldOf(2, ["GitHub", "AWS"]);
    const [a, b] = w.devices as [(typeof w.devices)[0], (typeof w.devices)[0]];
    const v = await a.vault();
    const gh = v.entries.find((e) => e.issuer === "GitHub")!.id;
    const aws = v.entries.find((e) => e.issuer === "AWS")!.id;
    w.advance(1000);
    await a.svc.mutate((x, c) => editEntry(x, gh, { label: "from A" }, c));
    await b.svc.mutate((x, c) => deleteEntry(x, aws, c));
    await a.engine.round();
    const r = await b.engine.round(); // its first PUT is answered 409, then it merges and uploads
    expect(r.status).toBe("ok");
    expect(w.server.requests.some((q) => q.op === "PUT /v1/vault" && q.status === 409)).toBe(false); // B pulled first (needPull)
    await quiesce(w);
    const fin = await a.vault();
    expect(cj(fin)).toBe(cj(await b.vault()));
    expect(fin.entries.find((e) => e.id === gh)!.label).toBe("from A");
    expect(aliveEntries(fin).some((e) => e.id === aws)).toBe(false);
    expect(cj(await w.serverVault((await a.ctx.flows.current()).vk))).toBe(cj(fin));
  });

  it("a real 409: the head moves between this device's pull and its PUT; it pulls again, merges and uploads (never over the newer head)", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a, b] = w.devices as [(typeof w.devices)[0], (typeof w.devices)[0]];
    w.advance(1000);
    await a.add("A-new");
    await b.add("B-new");
    // B's PUT: before it lands, A uploads
    w.server.fault({
      match: "PUT /v1/vault",
      kind: "hook",
      fn: async () => {
        w.server.clearFaults();
        await a.engine.round();
      },
    });
    const r = await b.engine.round();
    expect(r.status).toBe("ok");
    expect(w.server.requests.filter((q) => q.op === "PUT /v1/vault" && q.status === 409).length).toBe(1);
    await quiesce(w);
    expect(
      aliveEntries(await a.vault())
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["A-new", "B-new", "GitHub"]);
  });

  it("§4.7: locked, the outbox written at the commit is pushed (version and head still its own), and lastSynced moves by CAS", async () => {
    const w = await worldOf(2, ["GitHub"]);
    const [a, b] = w.devices as [(typeof w.devices)[0], (typeof w.devices)[0]];
    w.advance(1000);
    await a.add("offline edit");
    const ob = parseOutbox(a.disk.kv.data.get(SYNC_KEYS.outbox))!;
    expect(ob).not.toBeNull();
    await a.lockNow();
    const r = await a.engine.round();
    expect(r).toMatchObject({ status: "locked", pushedOutbox: true });
    expect(a.disk.kv.data.get(SYNC_KEYS.outbox) ?? null).toBeNull();
    const sv = w.server.account(EMAIL).vault!;
    expect(lastSyncedOf(a.disk.kv.data.get(SYNC_KEYS.state))).toEqual({
      version: sv.version,
      head: await headOf(ob.envelope),
      checksum: ob.checksum,
    });
    expect(sv.envelope).toBe(ob.envelope);
    await b.engine.round();
    expect(aliveEntries(await b.vault()).map((e) => e.issuer)).toContain("offline edit");
    // unlocked again: nothing more to send (it evolved from lastSynced and is in sync)
    await a.unlock();
    const before = puts(w);
    expect((await a.engine.round()).uploaded).toBe(false);
    expect(puts(w)).toBe(before);
  });
});

describe("joining a vault that already has data on this device is §3.5 (covered with the join tests)", () => {
  it("a device joined with an empty profile gets the cloud keyring byte for byte", async () => {
    const w = await worldOf(1, ["GitHub"]);
    const b = await joinDevice(w, "B");
    expect(cj((await b.generation()).keyring)).toBe(cj((await w.devices[0]!.generation()).keyring));
  });
});
