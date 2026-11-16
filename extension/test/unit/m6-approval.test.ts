// The approval join at its edges (join.ts, JoinView's summary; SYNC-DESIGN §3.2, §3.5):
//   - over unreadable local data (vaultStatus "lost") nothing replaces it until the user ticked that the synced vault
//     does (§3.5: an explicit confirmation, as a restore from a backup has); only that tick reaches the engine, whose
//     commit refuses without it;
//   - the approval path prepares against the synced vault without its accounts (M3-NOTES §3 item 6): it cannot know which
//     of this profile's accounts are there already, so its summary says those go to the trash after the first sync, and
//     claims no count of skipped ones; after the first round, the extra copy is in the trash, as it said (the dedupe of
//     SYNC-DESIGN §3.5, revision 24; test/unit/m6c-dedupe.test.ts);
//   - the request's expiry the server sends is shown only when it is a time the request can end at.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { JoinFlow, type JoinState } from "../../src/options/sync/join";
import { summaryText } from "../../src/options/sync/model";
import { asking } from "../../src/options/sync/permission";
import { Approver } from "../../src/core/sync/engine/enroll";
import { SYNC_CONSTANTS } from "../../src/core/sync/crypto/constants";
import { isAlive } from "../../src/core/vault/model";
import { EMAIL, firstDevice, World, type Device } from "../helpers/m3-world";
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

function begin<F extends { start(g: Promise<boolean>): Promise<void> }>(kit: TestKit, perm: PermFake, f: F): F {
  click(
    perm,
    asking(kit, (g) => void f.start(g)),
  );
  return f;
}

/** The join's state now (read through a function: each await may have moved it). */
const stateOf = (j: JoinFlow): JoinState => j.state;

/** An approval join of `j` as far as the summary, approved on `a`; false if the flow stopped earlier. */
async function approveToSummary(w: World, a: Device, j: JoinFlow, o: { confirmLost?: boolean } = {}): Promise<boolean> {
  await until(() => stateOf(j).at === "signin");
  await j.signin.send(EMAIL);
  await j.signin.verify(w.server.inbox(EMAIL));
  await until(() => stateOf(j).at === "choose");
  j.setName("B");
  await j.chooseApproval(o);
  if (stateOf(j).at !== "waiting") return false;
  const [req] = await Approver.list(a.engine);
  const approver = await Approver.start(a.engine, req!.request_id, w.password);
  await j.pollOnce();
  if (stateOf(j).at !== "code") return false;
  await j.submitCode(approver.pairingCode); // the user types the code the approver shows
  const s = stateOf(j);
  if (s.at !== "sas") return false;
  await approver.poll(w.password);
  const r = await approver.submitSas(s.sas, w.password);
  if (r.kind !== "approved") return false;
  await j.pollOnce(); // approved: the payload opens under the code's key, the join is prepared
  return stateOf(j).at === "summary";
}

/** A profile whose vault cannot be read: both slots damaged, no snapshot, no mirror, no keyring copy (store.ts: lost). */
async function lostProfile(w: World, perm: PermFake): Promise<Device> {
  const { d } = await protectedProfile(w, "B", perm);
  for (const k of ["sk_slot_a", "sk_slot_b"]) d.disk.kv.data.set(k, { broken: true });
  for (const k of [...d.disk.kv.data.keys()])
    if (k.startsWith("sk_snap") || k === "sk_keyring") d.disk.kv.data.delete(k);
  d.disk.mirror.data.clear();
  d.restartWorker();
  gate(d, perm);
  expect(await d.flows.vaultStatus()).toBe("lost");
  return d;
}

describe("the approval join", () => {
  it("over unreadable local data: nothing is replaced, and no request opened, until the user ticked that it may be", async () => {
    const w = new World();
    const a = await firstDevice(w);
    await a.engine.round();
    const perm = permissions(false);
    const d = await lostProfile(w, perm);
    const kit = kitOf(d, perm);
    const j = begin(kit, perm, new JoinFlow(kit));
    // only the steps every approval join has: the tick is never given
    expect(await approveToSummary(w, a, j)).toBe(false);
    expect(j.state).toMatchObject({ at: "choose", lost: true, failure: { code: "confirm_lost" } });
    expect(await Approver.list(a.engine)).toHaveLength(0);
    expect(await d.flows.vaultStatus()).toBe("lost");
  });

  it("over unreadable local data, ticked: the synced vault replaces it", async () => {
    const w = new World();
    const a = await firstDevice(w, ["GitHub"]);
    await a.engine.round();
    const perm = permissions(false);
    const d = await lostProfile(w, perm);
    const kit = kitOf(d, perm);
    const j = begin(kit, perm, new JoinFlow(kit));
    expect(await approveToSummary(w, a, j, { confirmLost: true })).toBe(true);
    expect(j.state).toMatchObject({ at: "summary", summary: { mode: "lost" } });
    await j.commit();
    expect(j.state.at).toBe("done");
    expect(await d.flows.vaultStatus()).toBe("ok");
  });

  it("the summary over a profile with accounts: what it says is what the vault holds after the first round", async () => {
    const w = new World();
    const a = await firstDevice(w, ["GitHub"]);
    await a.engine.round();
    const perm = permissions(false);
    const { d } = await protectedProfile(w, "B", perm, ["GitHub", "AWS"]);
    // B's GitHub is the very same account as A's (same secret, issuer and label)
    const ga = (await a.vault()).entries.find((e) => e.issuer === "GitHub")!;
    const gb = (await d.vault()).entries.find((e) => e.issuer === "GitHub")!;
    await d.svc.mutate((v) => ({
      ...v,
      entries: v.entries.map((e) => (e.id === gb.id ? { ...e, secret: ga.secret, label: ga.label } : e)),
    }));
    const kit = kitOf(d, perm);
    const j = begin(kit, perm, new JoinFlow(kit));
    expect(await approveToSummary(w, a, j)).toBe(true);
    const s = stateOf(j);
    if (s.at !== "summary") throw new Error("no summary");
    // the words on the screen: both accounts added, those the synced vault has already to the trash after the first
    // sync; no "skipped"
    expect(summaryText(s.summary, s.via)).toEqual({ k: "syncSummaryAddedLater", s: [2] });
    await j.commit();
    expect((await d.engine.round()).status).toBe("ok");
    const github = (await d.vault()).entries.filter((e) => e.issuer === "GitHub");
    expect(github.filter(isAlive)).toHaveLength(1); // as the summary said: the extra copy in the trash, nothing lost
    expect(github.filter((e) => !isAlive(e) && e.secret !== "")).toHaveLength(1);
    expect((await d.vault()).entries.filter((e) => isAlive(e) && e.issuer === "AWS")).toHaveLength(1);
  });

  it("the request's expiry: the server's when it is a time the request can end at, else the latest it can be", async () => {
    for (const [sent, kept] of [
      [(now: number) => now + 600_000, true],
      [() => Number.NaN, false],
      [(now: number) => now + 86_400_000, false],
      [(now: number) => now - 3_600_000, false],
    ] as const) {
      const w = new World();
      const a = await firstDevice(w);
      await a.engine.round();
      const perm = permissions(false);
      const d = emptyProfile(w, "B", perm);
      const api = d.engine.api as unknown as { enrollCreate: (...x: unknown[]) => Promise<{ expires_at: number }> };
      const real = api.enrollCreate.bind(api);
      let given = 0;
      api.enrollCreate = async (...x) => ({ ...(await real(...x)), expires_at: (given = sent(d.engine.refNow())) });
      const kit = kitOf(d, perm);
      const j = begin(kit, perm, new JoinFlow(kit, { timer: () => () => undefined }));
      await until(() => stateOf(j).at === "signin");
      await j.signin.send(EMAIL);
      await j.signin.verify(w.server.inbox(EMAIL));
      await until(() => stateOf(j).at === "choose");
      j.setName("B");
      await j.chooseApproval();
      const s = stateOf(j);
      if (s.at !== "waiting") throw new Error(`unexpected ${s.at}`);
      const latest = d.engine.refNow() + (SYNC_CONSTANTS.ENROLL_TTL_S + 60) * 1000;
      if (kept) expect(s.expiresAt).toBe(given);
      else {
        expect(Number.isFinite(s.expiresAt)).toBe(true);
        expect(Math.abs(s.expiresAt - latest)).toBeLessThan(5_000);
      }
      await j.cancel();
    }
  });
});
