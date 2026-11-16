// The API permission at the edges of a flow (SYNC-DESIGN §4.9, §7, §3.10; permission.ts, panel.ts, enable.ts, join.ts).
// The invariant: sync on here means the permission is held, or the user withdrew it; and a permission granted only for
// something that did not finish is given back.
//   - A turn-off asked with the permission withdrawn: the click grants it; when its fold stops at the guard, the
//     permission stays while the review is open, so that the answer's revocation can reach the server; every other way
//     the review closes (dismissed, a lock, the tab hidden, the page closing) gives it back.
//   - Cancel, or the page closing, while a write is under way (a join's Continue, a first upload): the write ends first,
//     and a write that turned sync on keeps the permission.
//   - What the page closing may do at once (leaving): give back a permission a flow holds only for itself, never one a
//     write under way may need.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API_PERMISSION } from "../../src/platform/api-permission";

// the turn-off's engine call, stood in for (the rest of the gateway is the real one): each call takes the next answer
const calls: { granted: boolean; answer: boolean }[] = [];
let answers: ("block" | "ok")[] = [];
let perm: { contains(p: { origins: string[] }): Promise<boolean> } | null = null;
vi.mock("../../src/options/sync/gateway", async (orig) => {
  const m = await orig<typeof import("../../src/options/sync/gateway")>();
  return {
    ...m,
    turnSyncOff: async (_e: unknown, _pw: string, o: { answer?: unknown } = {}) => {
      calls.push({ granted: await perm!.contains(API_PERMISSION), answer: o.answer !== undefined });
      if (answers.shift() === "block")
        throw new m.MergeBlocked(
          { secretChanged: [], purgedAlive: ["x"], trashed: [], purgedFromTrash: [] },
          { x: "seen" },
        );
      if (!calls.at(-1)!.granted) throw Object.assign(new Error("offline"), { code: "unconfirmed" }); // what the revocation meets without it
    },
  };
});

const { SyncPanelCtl } = await import("../../src/options/sync/panel");
const { asking } = await import("../../src/options/sync/permission");
const { answerOf } = await import("../../src/options/sync/review");
const { EnableFlow } = await import("../../src/options/sync/enable");
const { JoinFlow } = await import("../../src/options/sync/join");
const { EMAIL, firstDevice, World } = await import("../helpers/m3-world");
const { click, emptyProfile, kitOf, permissions, protectedProfile, until } = await import("../helpers/m6-kit");
const { firstUpload } = await import("../../src/core/sync/engine/enroll");

beforeEach(() => {
  calls.length = 0;
  answers = [];
});

/** A profile with sync on and a panel over it; `withdrawn`: the user took the permission back in chrome://extensions. */
async function syncedPanel(withdrawn: boolean) {
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
  if (withdrawn) p.granted = false;
  await ctl.refresh();
  // StatusView's binding: the click asks Chrome first, then the panel turns off with what it answered
  const turnOff = () =>
    click(
      p,
      asking(kit, (g) => void ctl.turnOff(w.password, g, ctl.state.facts!.permission)),
    );
  return { w, d, p, kit, ctl, turnOff };
}

describe("the permission at the edges of a flow", () => {
  describe("a turn-off that stopped for a review, the permission withdrawn before its click", () => {
    it("the review's answer runs the revocation with the permission the click granted; then it goes, last", async () => {
      const { p, ctl, turnOff } = await syncedPanel(true);
      answers = ["block", "ok"];
      turnOff();
      await until(() => ctl.state.review !== null, "the review");
      expect(p.granted).toBe(true); // held for the answer
      await ctl.answer(answerOf(ctl.state.review!, "keep")); // the review's Keep mine
      expect(calls.map((c) => c.answer)).toEqual([false, true]);
      expect(calls[1]!.granted).toBe(true);
      expect(ctl.state.done).toBe("syncDoneOff");
      expect(p.granted).toBe(false);
    });

    it("dismissed: the permission granted for it goes back at once", async () => {
      const { d, p, ctl, turnOff } = await syncedPanel(true);
      answers = ["block"];
      turnOff();
      await until(() => ctl.state.review !== null, "the review");
      ctl.dismissReview();
      expect(p.log.at(-1)).toBe("remove"); // asked before dismissReview returned
      await until(() => !p.granted, "the permission given back");
      expect(ctl.state.review).toBeNull();
      expect((await d.engine.view()).syncOn).toBe(true); // not turned off: paused as it was
    });

    it("a lock, or the tab hidden: the review closes, the password is forgotten, the permission goes back", async () => {
      const { p, ctl, turnOff } = await syncedPanel(true);
      answers = ["block"];
      turnOff();
      await until(() => ctl.state.review !== null, "the review");
      const forgot = ctl.state.forgot;
      ctl.locked();
      expect(ctl.state.review).toBeNull();
      expect(ctl.state.forgot).toBe(forgot + 1); // the view empties its password fields with it
      await until(() => !p.granted, "the permission given back");
      await ctl.answer(
        answerOf(
          { report: { secretChanged: [], purgedAlive: ["x"], trashed: [], purgedFromTrash: [] }, seen: { x: "seen" } },
          "keep",
        ),
      );
      expect(calls).toHaveLength(1); // no answer runs without the review, and the password is gone
    });

    it("the page closing: given back before anything is awaited", async () => {
      const { p, ctl, turnOff } = await syncedPanel(true);
      answers = ["block"];
      turnOff();
      await until(() => ctl.state.review !== null, "the review");
      const n = p.log.length;
      ctl.leaving();
      expect(p.log.slice(n)).toEqual(["remove"]);
    });

    it("the permission held all along: dismissing the review keeps it (sync stays on)", async () => {
      const { p, ctl, turnOff } = await syncedPanel(false);
      answers = ["block"];
      turnOff();
      await until(() => ctl.state.review !== null, "the review");
      ctl.dismissReview();
      ctl.leaving();
      await new Promise((r) => setTimeout(r, 10));
      expect(p.log).not.toContain("remove");
      expect(p.granted).toBe(true);
    });

    it("the answer stopped again by the guard: the new review holds the permission the same way, and dismissing it gives it back", async () => {
      const { p, ctl, turnOff } = await syncedPanel(true);
      answers = ["block", "block"];
      turnOff();
      await until(() => ctl.state.review !== null, "the review");
      await ctl.answer(answerOf(ctl.state.review!, "keep"));
      expect(calls).toHaveLength(2);
      expect(ctl.state.review).not.toBeNull(); // a second review
      expect(p.granted).toBe(true);
      ctl.dismissReview();
      await until(() => !p.granted, "the permission given back");
    });

    it("the answer's revocation failing: the review closes and the permission goes back", async () => {
      const { p, ctl, turnOff } = await syncedPanel(true);
      answers = ["block"];
      turnOff();
      await until(() => ctl.state.review !== null, "the review");
      p.granted = false; // withdrawn again meanwhile: the answer's revocation cannot get through
      await ctl.answer(answerOf(ctl.state.review!, "keep"));
      expect(ctl.state.review).toBeNull();
      expect(ctl.state.failure).toEqual({ code: "unconfirmed" });
      expect(p.granted).toBe(false);
    });
  });

  describe("a write under way", () => {
    it("Cancel during a join's Continue never leaves sync on without the permission", async () => {
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
      expect(j.leaving()).toBe(false); // Continue may be pressed any moment: the page closing must not drop it now
      const committing = j.commit(); // Continue
      await j.cancel(); // and Cancel (from the page closing, or the section going away: the screen offers none now)
      await committing.catch(() => undefined);
      const on = (await d.engine.view()).syncOn;
      expect({ syncOn: on, permission: p.granted }).toEqual(
        on ? { syncOn: true, permission: true } : { syncOn: false, permission: false },
      );
    });

    it("Cancel during the first upload: the upload ends first, and sync on keeps the permission", async () => {
      const w = new World();
      const p = permissions(false);
      const { d, code } = await protectedProfile(w, "A", p);
      const kit = kitOf(d, p);
      const f = new EnableFlow(kit);
      click(
        p,
        asking(kit, (g) => void f.start(g)),
      );
      await until(() => f.state.at === "password");
      expect(f.leaving()).toBe(true); // held only for this flow, nothing written: the page closing may drop it at once
      await f.submitPassword(w.password);
      await until(() => f.state.at === "signin");
      await f.signin.send(EMAIL);
      await f.signin.verify(w.server.inbox(EMAIL));
      await until(() => f.state.at === "name");
      f.submitName("A");
      f.enterCode();
      const uploading = f.submitCode(code);
      await until(() => f.state.at === "uploading", "the upload");
      expect(f.leaving()).toBe(false);
      await f.cancel();
      await uploading;
      const on = (await d.engine.view()).syncOn;
      expect({ syncOn: on, permission: p.granted }).toEqual(
        on ? { syncOn: true, permission: true } : { syncOn: false, permission: false },
      );
    });
  });

  describe("what the page closing may do at once", () => {
    it("a join holding the permission for itself, sync off: give it back; handed over from turning on: not this flow's", async () => {
      const w = new World();
      const a = await firstDevice(w);
      await a.engine.round();
      const p = permissions(false);
      const d = emptyProfile(w, "B", p);
      const kit = kitOf(d, p);
      const j = new JoinFlow(kit);
      expect(j.leaving()).toBe(false); // not started: nothing of its own
      click(
        p,
        asking(kit, (g) => void j.start(g)),
      );
      await until(() => j.state.at === "signin");
      await until(() => j.leaving(), "sync known to be off");
      const e = new EnableFlow(kit);
      const handed = new JoinFlow(kit, { signin: e.handOver() });
      expect(handed.leaving()).toBe(false);
    });

    it("a flow replaced by another gives nothing back (the new one's click has just asked for it)", async () => {
      const w = new World();
      const p = permissions(false);
      const d = emptyProfile(w, "B", p);
      const kit = kitOf(d, p);
      const j = new JoinFlow(kit);
      click(
        p,
        asking(kit, (g) => void j.start(g)),
      );
      await until(() => j.state.at === "signin");
      j.retire();
      await new Promise((r) => setTimeout(r, 10));
      expect(j.state.at).toBe("closed");
      expect(p.log).not.toContain("remove");
      expect(p.granted).toBe(true);
    });
  });
});
