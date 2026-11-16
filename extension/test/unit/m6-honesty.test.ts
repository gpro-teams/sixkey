// What the section says after a flow turned sync on is what is true (enable.ts, join.ts, panel.ts settled, model.ts):
//   - a flow tells the page how it ended ("done", "enrolled" or "unconfirmed"); an unconfirmed one keeps its own screen
//     (the server's answer is awaited) and gets no news;
//   - the news ("Sync is on", "This device joined") comes only after a first round that went through, and in sync;
//     otherwise the card says what happened, and a failure shown is never cleared by news;
//   - the state an unconfirmed join leaves behind is drawn as such, never as "in sync".
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { EnableFlow, type EnableOutcome } from "../../src/options/sync/enable";
import { JoinFlow, type JoinOutcome } from "../../src/options/sync/join";
import { readFacts } from "../../src/options/sync/gateway";
import { cardOf } from "../../src/options/sync/model";
import { SyncPanelCtl } from "../../src/options/sync/panel";
import { asking } from "../../src/options/sync/permission";
import { EMAIL, firstDevice, World } from "../helpers/m3-world";
import { click, emptyProfile, kitOf, permissions, protectedProfile, until, type TestKit } from "../helpers/m6-kit";

const dt = (ms: number) => new Date(ms).toISOString();

/** Joins a new profile with the recovery code as far as the summary. */
async function joinToSummary(w: World, onSyncOn: (o: JoinOutcome) => void) {
  const a = await firstDevice(w);
  await a.engine.round();
  const perm = permissions(false);
  const d = emptyProfile(w, "B", perm);
  const kit = kitOf(d, perm);
  const j = new JoinFlow(kit, { onSyncOn });
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
  expect(j.state.at).toBe("summary");
  return { d, kit, j, perm };
}

const panelOf = (kit: TestKit, w: World) =>
  new SyncPanelCtl(kit, { vault: () => "unlocked", reload: async () => undefined, now: () => w.clock.now });

describe("what is said after a flow turned sync on", () => {
  it("a join whose server half did not land reports 'unconfirmed', and its state is not drawn as in sync", async () => {
    const w = new World();
    const told: JoinOutcome[] = [];
    const { d, kit, j } = await joinToSummary(w, (o) => told.push(o));
    d.net.inject({ match: "POST /v1/enroll/requests/{rid}/complete", kind: "fail_before", count: 3 }); // every answer lost
    await j.commit();
    expect(j.state.at).toBe("unconfirmed");
    expect(told).toEqual(["unconfirmed"]);
    const card = cardOf(await readFacts(kit), "unlocked", w.clock.now, dt, "api.test");
    expect(card?.id).not.toBe("ok");
    expect(card?.tone).not.toBe("good");
    // and the round that settles it gives no news either
    const ctl = panelOf(kit, w);
    d.net.inject({ match: "POST /v1/enroll/requests/{rid}/complete", kind: "fail_before", count: 10 });
    await ctl.settled("unconfirmed", "syncDoneJoined");
    expect(ctl.state.done).toBeNull();
  });

  it("a join that got through: the news only after the first round went through", async () => {
    const w = new World();
    const told: JoinOutcome[] = [];
    const { kit, j } = await joinToSummary(w, (o) => told.push(o));
    await j.commit();
    expect(told).toEqual(["enrolled"]);
    const ctl = panelOf(kit, w);
    await ctl.settled("enrolled", "syncDoneJoined");
    expect(ctl.state.facts?.status).toBe("ok");
    expect(ctl.state.done).toBe("syncDoneJoined");
  });

  it("a first round that did not go through: no news, the card and the failure say what happened", async () => {
    const w = new World();
    const { d, kit, j } = await joinToSummary(w, () => undefined);
    await j.commit();
    const ctl = panelOf(kit, w);
    d.net.partition(true); // offline from here
    await ctl.settled("enrolled", "syncDoneJoined");
    expect(ctl.state.done).toBeNull();
    expect(ctl.state.facts?.status).not.toBe("ok");
  });

  it("turning sync on reports how it ended: done, or unconfirmed when the server's answer is lost", async () => {
    for (const lose of [false, true]) {
      const w = new World();
      const perm = permissions(false);
      const { d, code } = await protectedProfile(w, "A", perm);
      const kit = kitOf(d, perm);
      const told: EnableOutcome[] = [];
      const f = new EnableFlow(kit, { onSyncOn: (o) => told.push(o) });
      click(
        perm,
        asking(kit, (g) => void f.start(g)),
      );
      await until(() => f.state.at === "password");
      await f.submitPassword(w.password);
      await until(() => f.state.at === "signin");
      await f.signin.send(EMAIL);
      await f.signin.verify(w.server.inbox(EMAIL));
      await until(() => f.state.at === "name");
      f.submitName("A");
      f.enterCode();
      if (lose) d.net.inject({ match: "POST /v1/vault/init", kind: "lose_response", count: 3 });
      await f.submitCode(code);
      expect(f.state.at).toBe(lose ? "unconfirmed" : "done");
      expect(told).toEqual([lose ? "unconfirmed" : "done"]);
      expect(perm.granted).toBe(true); // kept for both
    }
  });

  it("news never clears a failure shown", async () => {
    const w = new World();
    const perm = permissions(true);
    const d = emptyProfile(w, "B", perm);
    const ctl = panelOf(kitOf(d, perm), w);
    await ctl.grant(Promise.resolve(false)); // a failure on the card: declined
    expect(ctl.state.failure).toEqual({ code: "declined" });
    ctl.announce("syncDoneOn");
    expect(ctl.state.failure).toEqual({ code: "declined" });
    expect(ctl.state.done).toBe("syncDoneOn");
  });
});
