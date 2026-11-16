// M6C, the dedupe after an approval join (SYNC-DESIGN §3.5, revision 24; sync-flows.ts prepareJoin/commitJoin and
// trashJoinDuplicates, engine.ts dedupeAfterJoin): the approval join adds this profile's accounts to a synced vault it
// cannot see yet, so an account both sides had is there twice once the first round has merged them. After the first
// round that goes through, the copies this join added go to the trash (never erased) where a live account the join did
// not add is the same one (secret, issuer and label), with one notice, as an ordinary local edit that syncs. Nothing
// else moves: two equal accounts the join itself brought keep each other, an account changed since is no longer a
// duplicate, a round that does not go through (offline, locked) leaves the record for the next one.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { Approver, commitJoin, joinWithRecoveryCode } from "../../src/core/sync/engine/enroll";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { isTwinOf } from "../../src/core/service/sync-flows";
import { createClock } from "../../src/core/vault/hlc";
import { aliveEntries, emptyVault, isAlive, trashEntries, type Vault } from "../../src/core/vault/model";
import { addEntry, editEntry } from "../../src/core/vault/ops";
import { JoinFlow, type JoinState } from "../../src/options/sync/join";
import { summaryText } from "../../src/options/sync/model";
import { asking } from "../../src/options/sync/permission";
import { input, secretOf } from "../helpers/m2-world";
import { EMAIL, firstDevice, joinDevice, quiesce, World, type Device } from "../helpers/m3-world";
import { click, kitOf, permissions, protectedProfile, until, type PermFake, type TestKit } from "../helpers/m6-kit";
import { approvalJoin as joinByApproval } from "../helpers/m6c-flows";

const stateOf = (j: JoinFlow): JoinState => j.state;
const alive = (v: Vault) =>
  aliveEntries(v)
    .map((e) => e.issuer)
    .sort();
const trashed = (v: Vault) =>
  trashEntries(v)
    .map((e) => e.issuer)
    .sort();
const joinRecord = (d: Device) =>
  (d.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown> | undefined)?.joinAdded;
const notices = (d: Device) =>
  (
    ((d.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>)?.notices ?? []) as { kind: string; n?: number }[]
  ).filter((n) => n.kind === "duplicates_trashed");

function begin<F extends { start(g: Promise<boolean>): Promise<void> }>(kit: TestKit, perm: PermFake, f: F): F {
  click(
    perm,
    asking(kit, (g) => void f.start(g)),
  );
  return f;
}

/** An approval join of `d` into `a`'s vault, approved on `a`, committed; returns the summary's words. */
async function approvalJoin(w: World, a: Device, d: Device, perm: PermFake): Promise<ReturnType<typeof summaryText>> {
  const kit = kitOf(d, perm);
  const j = begin(kit, perm, new JoinFlow(kit));
  await until(() => stateOf(j).at === "signin");
  await j.signin.send(EMAIL);
  await j.signin.verify(w.server.inbox(EMAIL));
  await until(() => stateOf(j).at === "choose");
  j.setName("B");
  await j.chooseApproval();
  const [req] = await Approver.list(a.engine);
  const approver = await Approver.start(a.engine, req!.request_id, w.password);
  await j.pollOnce();
  if (stateOf(j).at !== "code") throw new Error(`no code step: ${stateOf(j).at}`);
  await j.submitCode(approver.pairingCode); // the code the approver shows, typed here
  const s = stateOf(j);
  if (s.at !== "sas") throw new Error(`no sas: ${s.at}`);
  await approver.poll(w.password);
  const r = await approver.submitSas(s.sas, w.password);
  if (r.kind !== "approved") throw new Error("not approved");
  await j.pollOnce(); // approved: the payload opens under the code's key, the join is prepared
  const sum = stateOf(j);
  if (sum.at !== "summary") throw new Error(`no summary: ${sum.at}`);
  const words = summaryText(sum.summary, sum.via);
  await j.commit();
  if (stateOf(j).at !== "done") throw new Error(`join: ${stateOf(j).at}`);
  return words;
}

/** A synced first device with `mine`; a second profile with its own vault holding `theirs`, joined by approval. */
async function joined(mine: string[], theirs: string[]) {
  const w = new World();
  const a = await firstDevice(w, mine);
  await a.engine.round();
  const perm = permissions(false);
  const { d: b } = await protectedProfile(w, "B", perm, theirs);
  const words = await approvalJoin(w, a, b, perm);
  return { w, a, b, words };
}

describe("the dedupe after an approval join", () => {
  it("after the first round that went through, the join's copies of accounts the synced vault had go to the trash, with one notice; the other device sees them in its trash", async () => {
    const { w, a, b, words } = await joined(["GitHub", "AWS", "Bank", "Mail"], ["GitHub", "AWS", "Bank", "Personal"]);
    expect(words).toEqual({ k: "syncSummaryAddedLater", s: [4] });
    const rec = joinRecord(b) as { ids: string[] };
    expect(rec.ids).toHaveLength(4); // ids only
    const ownIds = new Set((await a.vault()).entries.map((e) => e.id));
    const r = await b.engine.round();
    expect(r.status).toBe("ok");
    const v = await b.vault();
    expect(alive(v)).toEqual(["AWS", "Bank", "GitHub", "Mail", "Personal"]);
    expect(trashed(v)).toEqual(["AWS", "Bank", "GitHub"]);
    // the ones that went are the join's copies; the synced vault's own stay alive under their ids
    for (const e of trashEntries(v)) expect(rec.ids).toContain(e.id);
    for (const e of aliveEntries(v).filter((x) => x.issuer !== "Personal")) expect(ownIds.has(e.id)).toBe(true);
    expect(trashEntries(v).every((e) => e.secret !== "")).toBe(true); // in the trash, never erased
    expect(notices(b)).toEqual([expect.objectContaining({ kind: "duplicates_trashed", n: 3 })]);
    expect(joinRecord(b)).toBeNull();
    // the trash moves went up in the same round (its rerun)
    const head = await w.serverVault(await b.vk());
    expect(trashed(head!)).toEqual(["AWS", "Bank", "GitHub"]);
    // the other device: the copies arrive already in the trash (the dedupe went up in the round that first uploaded
    // them), so no account it had alive moved and its merge says nothing (a device that rounds between the two uploads
    // sees the copies come and then go, and is told another device deleted them: docs/design/notes/M6C-NOTES.md §3)
    w.advance(1000);
    await a.engine.round();
    expect(alive(await a.vault())).toEqual(["AWS", "Bank", "GitHub", "Mail", "Personal"]);
    expect(trashed(await a.vault())).toEqual(["AWS", "Bank", "GitHub"]);
    const aNotices = ((a.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>).notices ?? []) as {
      kind: string;
    }[];
    expect(aNotices.filter((n) => n.kind === "deleted_remotely")).toEqual([]);
    // nothing more moves: a later round has no record and does nothing
    expect((await b.engine.round()).uploaded).toBe(false);
    expect(notices(b)).toHaveLength(1);
  });

  it("two equal accounts the join itself brought keep each other (only a live account the join did not add is a twin)", async () => {
    const w = new World();
    const a = await firstDevice(w, ["Mail"]);
    await a.engine.round();
    const perm = permissions(false);
    const { d: b } = await protectedProfile(w, "B", perm, ["GitHub"]);
    await b.svc.mutate((v, c) => addEntry(v, input("GitHub", secretOf("GitHub")), c).vault); // the same account twice
    await approvalJoin(w, a, b, perm);
    expect((await b.engine.round()).status).toBe("ok");
    expect(alive(await b.vault())).toEqual(["GitHub", "GitHub", "Mail"]);
    expect(trashed(await b.vault())).toEqual([]);
    expect(notices(b)).toEqual([]);
    expect(joinRecord(b)).toBeNull();
  });

  it("an account changed between the join and the first round is no longer a duplicate", async () => {
    const { b } = await joined(["GitHub", "Mail"], ["GitHub", "Personal"]);
    const gh = (await b.vault()).entries.find((e) => e.issuer === "GitHub")!;
    await b.svc.mutate((v, c) => editEntry(v, gh.id, { label: "work" }, c));
    expect((await b.engine.round()).status).toBe("ok");
    expect(alive(await b.vault())).toEqual(["GitHub", "GitHub", "Mail", "Personal"]);
    expect(trashed(await b.vault())).toEqual([]);
  });

  it("a first round that does not go through (offline, locked) moves nothing; the next one that does with the key does it", async () => {
    const { w, b } = await joined(["GitHub", "Mail"], ["GitHub", "Personal"]);
    b.net.partition(true);
    expect((await b.engine.round()).status).toBe("offline");
    expect(joinRecord(b)).not.toBeNull();
    b.net.partition(false);
    await b.lockNow();
    await b.engine.round(); // locked: the status and the push only
    expect(joinRecord(b)).not.toBeNull();
    await b.svc.unlockWithPassword(w.password);
    expect((await b.engine.round()).status).toBe("ok");
    expect(trashed(await b.vault())).toEqual(["GitHub"]);
    expect(notices(b)).toHaveLength(1);
  });

  it("the recovery-code join (it sees the synced vault, and skips duplicates itself) records nothing", async () => {
    const w = new World();
    const a = await firstDevice(w, ["GitHub"]);
    await a.engine.round();
    const b = await joinDevice(w, "B");
    expect(joinRecord(b) ?? null).toBeNull();
    expect((await b.engine.round()).status).toBe("ok");
    expect(isAlive((await b.vault()).entries[0]!)).toBe(true);
    // over a profile with accounts of its own (the added mode): GitHub skipped by the join itself, nothing recorded
    const perm = permissions(true);
    const { d: c } = await protectedProfile(w, "C", perm, ["GitHub", "Personal"]);
    const plan = await joinWithRecoveryCode(c.engine, {
      session: await w.server.session(EMAIL),
      recoveryCode: w.code,
      deviceName: "Device C",
      email: EMAIL,
    });
    expect(plan.prepared).toMatchObject({ mode: "added", added: 1, skipped: 1 });
    expect(await commitJoin(plan)).toBe("enrolled");
    expect(joinRecord(c) ?? null).toBeNull();
    expect((await c.engine.round()).status).toBe("ok");
    expect(alive(await c.vault())).toEqual(["GitHub", "Personal"]);
  });

  it("a record of another vault moves nothing; one that does not parse is cleared", async () => {
    const { b } = await joined(["GitHub", "Mail"], ["GitHub", "Personal"]);
    const st = b.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>;
    const rec = st.joinAdded as { ids: string[]; at: number };
    b.disk.kv.data.set(SYNC_KEYS.state, { ...st, joinAdded: { ...rec, vaultId: "another-vault" } });
    expect((await b.engine.round()).status).toBe("ok");
    expect(trashed(await b.vault())).toEqual([]);
    expect(joinRecord(b)).toBeNull();
    const st2 = b.disk.kv.data.get(SYNC_KEYS.state) as Record<string, unknown>;
    b.disk.kv.data.set(SYNC_KEYS.state, { ...st2, joinAdded: { ids: "not a list" } });
    expect((await b.engine.round()).status).toBe("ok");
    expect(joinRecord(b)).toBeNull();
    expect(trashed(await b.vault())).toEqual([]);
  });
});

describe("the dedupe's twin rule: one copy always stays, and only a copy that is the same account goes", () => {
  it("two profiles join by approval with the same account the synced vault lacks: whatever order their rounds take, the account keeps a live copy everywhere", async () => {
    const w = new World();
    const a = await firstDevice(w, ["Mail"]);
    await a.engine.round();
    const pb = permissions(false);
    const { d: b } = await protectedProfile(w, "B", pb, ["Z"]);
    expect((await joinByApproval(w, a, b, pb, "B")).end).toBe("done");
    w.advance(1000);
    const pc = permissions(false);
    const { d: c } = await protectedProfile(w, "C", pc, ["Z"]);
    expect((await joinByApproval(w, a, c, pc, "C")).end).toBe("done");
    // B's copy lands, but B does not hear so: its record stays
    b.net.inject({ match: "PUT /v1/vault", kind: "lose_response" });
    expect((await b.engine.round()).status).not.toBe("ok");
    expect(joinRecord(b)).not.toBeNull();
    // C sees B's copy; the rerun's upload fails
    let puts = 0;
    c.net.inject({ match: (_q, key) => key === "PUT /v1/vault" && ++puts === 2, kind: "fail_before" });
    await c.engine.round();
    w.advance(1000);
    await b.engine.round();
    await quiesce(w);
    for (const d of [a, b, c]) {
      const v = await d.vault();
      expect(alive(v).filter((n) => n === "Z")).toHaveLength(1);
      expect(trashed(v)).toEqual(["Z"]);
    }
  });

  it("a copy whose codes differ (another number of digits) is not a duplicate: both stay alive", async () => {
    const w = new World();
    const a = await firstDevice(w, ["GitHub"]);
    await a.engine.round();
    const perm = permissions(false);
    const { d: b } = await protectedProfile(w, "B", perm, []);
    await b.svc.mutate((v, c) => addEntry(v, { ...input("GitHub", secretOf("GitHub")), digits: 8 }, c).vault);
    await joinByApproval(w, a, b, perm);
    expect((await b.engine.round()).status).toBe("ok");
    expect(alive(await b.vault())).toEqual(["GitHub", "GitHub"]);
    expect(trashed(await b.vault())).toEqual([]);
    expect(joinRecord(b)).toBeNull();
  });

  it("HOTP: the join's copy goes only when the synced one's counter is not behind it; with a higher counter it stays", async () => {
    const w = new World();
    const a = await firstDevice(w, []);
    const hotp = (name: string, counter: number) => ({
      ...input(name, secretOf(name)),
      type: "hotp" as const,
      counter,
    });
    await a.svc.mutate((v, c) => addEntry(addEntry(v, hotp("Bank", 5), c).vault, hotp("Shop", 5), c).vault);
    await a.engine.round();
    const perm = permissions(false);
    const { d: b } = await protectedProfile(w, "B", perm, []);
    await b.svc.mutate((v, c) => addEntry(addEntry(v, hotp("Bank", 9), c).vault, hotp("Shop", 3), c).vault);
    await joinByApproval(w, a, b, perm);
    expect((await b.engine.round()).status).toBe("ok");
    const v = await b.vault();
    expect(alive(v)).toEqual(["Bank", "Bank", "Shop"]); // B's Bank is ahead: it stays; B's Shop is behind: it goes
    expect(trashed(v)).toEqual(["Shop"]);
  });

  it("isTwinOf: the earlier copy by (createdAt, id) is the one that stays; the same account only", () => {
    const c = createClock("devtest1");
    const one = addEntry(emptyVault("vault-1"), input("Z", secretOf("Z")), c, { now: () => 1000 }).entry;
    const later = { ...one, id: `${one.id}-later`, createdAt: 2000 };
    const sameTime = { ...one, id: `${one.id}-z` };
    expect(isTwinOf(one, later)).toBe(true);
    expect(isTwinOf(later, one)).toBe(false);
    expect(isTwinOf(one, sameTime)).toBe(sameTime.id > one.id);
    expect(isTwinOf(sameTime, one)).toBe(one.id > sameTime.id);
    expect(isTwinOf(one, { ...later, period: 60 })).toBe(false);
    expect(isTwinOf(one, { ...later, algorithm: "SHA256" })).toBe(false);
    expect(isTwinOf(one, { ...later, label: "another" })).toBe(false);
  });
});

describe("the dedupe across a join that did not finish", () => {
  it("the join's last step lost, then the join made again (the merged one): the first join's record is carried, and its duplicate goes to the trash after the first round", async () => {
    const w = new World();
    const a = await firstDevice(w, ["GitHub", "Mail"]);
    await a.engine.round();
    const perm = permissions(false);
    const { d: b } = await protectedProfile(w, "B", perm, ["GitHub", "Personal"]);
    b.net.inject({ match: "POST /v1/enroll/requests/{rid}/complete", kind: "fail_before", count: 3 }); // and its retries
    expect((await joinByApproval(w, a, b, perm)).end).toBe("unconfirmed");
    const first = joinRecord(b) as { ids: string[] };
    expect(first.ids).toHaveLength(2);
    expect((await b.engine.round()).status).toBe("join_unfinished");
    w.advance(11 * 60_000); // past the time the old request could still land
    const again = await joinByApproval(w, a, b, perm);
    expect(again.end).toBe("done");
    expect(joinRecord(b)).toEqual(first); // the merged join kept it
    expect((await b.engine.round()).status).toBe("ok");
    expect(alive(await b.vault())).toEqual(["GitHub", "Mail", "Personal"]);
    expect(trashed(await b.vault())).toEqual(["GitHub"]);
    expect(joinRecord(b)).toBeNull();
  });
});
