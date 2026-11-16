// A lock, or a hidden tab, at an awkward moment (enable.ts, join.ts, panel.ts; core/service/sync-flows.ts commitJoin):
//   - Chrome's permission prompt still open when the flow ends (a lock, a cancel): an Allow given afterwards has no flow
//     to serve, and is given back; a run that a newer one replaced (Ask again, clicked twice) leaves the grant to it;
//   - a lock between a join's last check and the session it starts: the session carries the lock epoch read before that
//     check, so the page stays locked;
//   - the tab hidden while a turn-off review's answer runs: the answer keeps the permission its revocation needs, and a
//     hide during an action that then stops for a review does not leave that review holding a password or a permission.
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { API_PERMISSION } from "../../src/platform/api-permission";

// the turn-off's engine call, stood in for (the rest of the gateway is the real one): `answers` says what each call does
const calls: { granted: boolean; answer: boolean }[] = [];
let answers: ("block" | "ok")[] = [];
let perm: { contains(p: { origins: string[] }): Promise<boolean> } | null = null;
let gate: Promise<void> = Promise.resolve();
vi.mock("../../src/options/sync/gateway", async (orig) => {
  const m = await orig<typeof import("../../src/options/sync/gateway")>();
  return {
    ...m,
    turnSyncOff: async (_e: unknown, _pw: string, o: { answer?: unknown } = {}) => {
      await gate; // the revocation on its way
      calls.push({ granted: await perm!.contains(API_PERMISSION), answer: o.answer !== undefined });
      if (answers.shift() === "block")
        throw new m.MergeBlocked(
          { secretChanged: [], purgedAlive: ["x"], trashed: [], purgedFromTrash: [] },
          { x: "seen" },
        );
      if (!calls.at(-1)!.granted) throw Object.assign(new Error("offline"), { code: "unconfirmed" });
    },
  };
});

const { SyncPanelCtl } = await import("../../src/options/sync/panel");
const { asking } = await import("../../src/options/sync/permission");
const { answerOf } = await import("../../src/options/sync/review");
const { EnableFlow } = await import("../../src/options/sync/enable");
const { JoinFlow } = await import("../../src/options/sync/join");
const { EMAIL, firstDevice, World } = await import("../helpers/m3-world");
const { click, kitOf, permissions, protectedProfile, until } = await import("../helpers/m6-kit");
const { firstUpload } = await import("../../src/core/sync/engine/enroll");

type Perm = ReturnType<typeof permissions>;

/** Chrome's prompt held open: each request waits until the test answers it (in the order asked). */
function heldPrompt(p: Perm): ((ok: boolean) => void)[] {
  const answers: ((ok: boolean) => void)[] = [];
  p.request = () => {
    p.log.push("request");
    return new Promise<boolean>((r) =>
      answers.push((ok) => {
        if (ok) p.granted = true;
        r(ok);
      }),
    );
  };
  return answers;
}
const settle = () => new Promise((r) => setTimeout(r, 10));

/** A profile with sync on and a panel over it, the permission withdrawn in chrome://extensions. */
async function syncedPanelWithdrawn() {
  const w = new World();
  const p = permissions(true);
  perm = p;
  const { d, code } = await protectedProfile(w, "A", p);
  expect(
    (
      await firstUpload(d.engine, {
        session: await w.server.session(EMAIL),
        password: w.password,
        recoveryCode: code,
        deviceName: "A",
        email: EMAIL,
      })
    ).kind,
  ).toBe("done");
  const kit = kitOf(d, p);
  const ctl = new SyncPanelCtl(kit, { vault: () => "unlocked", reload: async () => undefined, now: () => w.clock.now });
  p.granted = false;
  await ctl.refresh();
  return { w, p, kit, ctl };
}

describe("at an awkward moment", () => {
  describe("the permission prompt still open when the flow ends", () => {
    it("turning on: a lock, then Allow: no permission is left behind", async () => {
      const w = new World();
      const p = permissions(false);
      const { d } = await protectedProfile(w, "A", p);
      const prompt = heldPrompt(p);
      const kit = kitOf(d, p);
      const f = new EnableFlow(kit);
      click(
        p,
        asking(kit, (g) => void f.start(g)),
      ); // the prompt is open
      await d.svc.lock();
      await f.locked(); // what the section's lock watcher calls
      prompt[0]!(true); // the user answers Allow afterwards
      await settle();
      expect({ state: f.state.at, granted: p.granted }).toEqual({ state: "failed", granted: false });
    });

    it("joining: Cancel, then Allow: no permission is left behind", async () => {
      const w = new World();
      const p = permissions(false);
      const { d } = await protectedProfile(w, "B", p);
      const prompt = heldPrompt(p);
      const kit = kitOf(d, p);
      const j = new JoinFlow(kit);
      click(
        p,
        asking(kit, (g) => void j.start(g)),
      );
      await j.cancel();
      prompt[0]!(true);
      await settle();
      expect({ state: j.state.at, granted: p.granted }).toEqual({ state: "closed", granted: false });
    });

    it("Ask again clicked twice: the first answer arriving late takes nothing from the run that replaced it", async () => {
      const w = new World();
      const p = permissions(false);
      const { d } = await protectedProfile(w, "A", p);
      const prompt = heldPrompt(p);
      const kit = kitOf(d, p);
      const f = new EnableFlow(kit);
      click(
        p,
        asking(kit, (g) => void f.start(g)),
      );
      click(
        p,
        asking(kit, (g) => void f.start(g)),
      ); // a second click, the first prompt not answered yet
      prompt[0]!(true);
      await settle();
      expect(p.granted).toBe(true);
      prompt[1]!(true);
      await until(() => f.state.at === "password", "the password step");
      expect(p.log).not.toContain("remove");
    });
  });

  it("a lock between the join's last check and the session it starts leaves the page locked", async () => {
    const w = new World();
    const a = await firstDevice(w, ["GitHub"]);
    await a.engine.round();
    const p = permissions(false);
    const { d } = await protectedProfile(w, "B", p, ["AWS"]);
    const kit = kitOf(d, p);
    const j = new JoinFlow(kit);
    click(
      p,
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
    // the lock lands while the commit writes (as it keeps this profile's own vault aside, sk_prejoin): after its last
    // check of the lock, before the session it starts
    const kv = d.disk.kv;
    const set = kv.set.bind(kv);
    let locked = 0;
    kv.set = async (items: Record<string, unknown>) => {
      if ("sk_prejoin" in items) {
        d.disk.session.data = null; // what a lock does (the key gone, the epoch moved)
        d.disk.session.epoch++;
        locked++;
      }
      return set(items);
    };
    await j.commit();
    expect(locked).toBe(1);
    expect(j.state.at).toBe("done"); // the join itself went through
    expect((await d.svc.status()).state).toBe("locked"); // but the page that locked stays locked
  });

  it("with no lock, the joined page is unlocked under the synced vault's key", async () => {
    const w = new World();
    const a = await firstDevice(w, ["GitHub"]);
    await a.engine.round();
    const p = permissions(false);
    const { d } = await protectedProfile(w, "B", p, ["AWS"]);
    const kit = kitOf(d, p);
    const j = new JoinFlow(kit);
    click(
      p,
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
    expect((await d.svc.status()).state).toBe("unlocked");
  });

  describe("the tab hidden while a turn-off is on its way", () => {
    it("while a review's answer runs: the answer keeps the permission its revocation needs", async () => {
      calls.length = 0;
      answers = ["block", "ok"];
      const { p, kit, ctl } = await syncedPanelWithdrawn();
      click(
        p,
        asking(kit, (g) => void ctl.turnOff("unused", g, ctl.state.facts!.permission)),
      );
      await until(() => ctl.state.review !== null, "the review");
      let go!: () => void;
      gate = new Promise((r) => (go = r));
      const answering = ctl.answer(answerOf(ctl.state.review!, "keep")); // Keep mine: the revocation starts
      await settle();
      ctl.forgetPassword(); // the user switches tabs meanwhile
      go();
      await answering;
      gate = Promise.resolve();
      expect(calls[1]).toMatchObject({ answer: true, granted: true });
      expect(ctl.state.done).toBe("syncDoneOff");
      expect(p.granted).toBe(false); // given back last, as ever
    });

    it("during the first click's revocation, which then stops for a review: the review is not kept, the permission goes back", async () => {
      calls.length = 0;
      answers = ["block"];
      const { p, kit, ctl } = await syncedPanelWithdrawn();
      let go!: () => void;
      gate = new Promise((r) => (go = r));
      click(
        p,
        asking(kit, (g) => void ctl.turnOff("unused", g, ctl.state.facts!.permission)),
      );
      await until(() => p.granted, "the click's grant");
      await settle();
      ctl.forgetPassword(); // hidden while the revocation is on its way
      go();
      await until(() => ctl.state.doing === null && calls.length === 1, "the turn-off's end");
      gate = Promise.resolve();
      expect(ctl.state.review).toBeNull();
      await until(() => !p.granted, "the permission given back");
    });
  });
});
