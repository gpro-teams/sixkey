// A lock of Sixkey while a sync flow is open. What a lock protects does not wait on the page for whoever sits down next
// (Backup.tsx's convention for the export password), and a locked page is never opened without the master password:
//   - the engine refuses by itself (core/service/sync-flows.ts): a new recovery code prepared before the lock is not
//     written by a confirmation made after it, and a join prepared with this profile's vault open is not committed once
//     the vault has locked (its commit would start a session under the cloud key);
//   - the flows end at a lock (lock.ts calls their locked()): the secrets and the prepared steps dropped, nothing of them
//     left in the state the screens draw, the permission given back; a write under way is waited for, and its outcome is
//     what the flow says;
//   - a lock is a real one: an epoch that moves in a profile with nothing to lock (the first-run join's) is not.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { EnableFlow } from "../../src/options/sync/enable";
import { JoinFlow } from "../../src/options/sync/join";
import { LOCK_EPOCH_KEY, watchLock, type LockArea } from "../../src/options/sync/lock";
import { asking } from "../../src/options/sync/permission";
import { Approver } from "../../src/core/sync/engine/enroll";
import { EMAIL, firstDevice, World } from "../helpers/m3-world";
import {
  click,
  emptyProfile,
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
async function signIn(w: World, f: EnableFlow | JoinFlow): Promise<void> {
  await until(() => f.state.at === "signin", "the sign-in step");
  await f.signin.send(EMAIL);
  await f.signin.verify(w.server.inbox(EMAIL));
}

/** Turning sync on as far as the new recovery code on screen. */
async function newCodeShown(w: World, perm: PermFake) {
  const { d, code: old } = await protectedProfile(w, "A", perm);
  const kit = kitOf(d, perm);
  const f = begin(kit, perm, new EnableFlow(kit, { random: () => 0 }));
  await until(() => f.state.at === "password");
  await f.submitPassword(w.password);
  await signIn(w, f);
  await until(() => f.state.at === "name");
  f.submitName("Laptop");
  await f.newCode();
  const s = f.state;
  if (s.at !== "recovery" || s.mode !== "show") throw new Error(`unexpected ${JSON.stringify(s)}`);
  const opens = (rc: string) =>
    d.svc.unlockWithRecoveryCode(rc).then(
      () => true,
      () => false,
    );
  return { d, kit, f, old, fresh: s.code, opens };
}

/** The two groups the confirmation asks for, typed back. */
async function typeBack(f: EnableFlow, fresh: string): Promise<void> {
  f.saved();
  const c = f.state;
  if (c.at !== "recovery" || c.mode !== "confirm") throw new Error(`unexpected ${JSON.stringify(c)}`);
  const parts = fresh.split("-");
  await f.confirmGroups([parts[c.groups[0]]!, parts[c.groups[1]]!]);
}

/** Joining with the recovery code as far as the summary, over a profile with an account of its own. */
async function joinToSummary(w: World, perm: PermFake) {
  const a = await firstDevice(w, ["GitHub"]);
  await a.engine.round();
  const { d } = await protectedProfile(w, "B", perm, ["AWS"]);
  const kit = kitOf(d, perm);
  const j = begin(kit, perm, new JoinFlow(kit));
  await signIn(w, j);
  await until(() => j.state.at === "choose");
  j.setName("B");
  await j.chooseRecovery();
  await j.submitRecovery(w.code);
  expect(j.state).toMatchObject({ at: "summary", summary: { mode: "added" } });
  return { a, d, kit, j };
}

describe("a lock while a sync flow is open", () => {
  describe("the engine refuses by itself", () => {
    it("turning sync on: a new recovery code shown before the lock is not written by a confirmation made after it", async () => {
      const w = new World();
      const perm = permissions(false);
      const { d, f, old, fresh, opens } = await newCodeShown(w, perm);
      await d.svc.lock(); // the idle lock, or the popup's Lock, while the code is on screen
      expect((await d.svc.status()).state).toBe("locked");
      await typeBack(f, fresh); // someone at the locked page reads the code off the screen and confirms it
      expect(f.state).toMatchObject({ at: "failed", failure: { code: "locked_out" } });
      expect({ fresh: await opens(fresh) }).toEqual({ fresh: false });
      await d.svc.lock();
      expect({ old: await opens(old) }).toEqual({ old: true });
      expect(perm.granted).toBe(false);
    });

    it("joining: a join prepared before the lock does not unlock the page when committed after it", async () => {
      const w = new World();
      const perm = permissions(false);
      const { d, j } = await joinToSummary(w, perm);
      await d.svc.lock(); // the user walks away from the summary; the page locks
      await j.commit(); // someone at the locked page presses Continue
      expect((await d.svc.status()).state).toBe("locked");
      expect((await d.engine.view()).syncOn).toBe(false);
      expect(j.state).toMatchObject({ at: "failed", failure: { code: "locked_out" } });
      expect(perm.granted).toBe(false);
    });
  });

  describe("the flows end at a lock", () => {
    it("turning sync on, the new code on screen: the flow ends, the code is no longer in its state, the permission goes back", async () => {
      const w = new World();
      const perm = permissions(false);
      const { d, f, old, fresh, opens } = await newCodeShown(w, perm);
      await d.svc.lock();
      await f.locked();
      expect(f.state).toEqual({ at: "failed", failure: { code: "locked_out" } });
      expect(JSON.stringify(f.state)).not.toContain(fresh.split("-")[0]);
      f.saved(); // the screen's buttons do nothing any more
      expect(f.state.at).toBe("failed");
      expect(perm.granted).toBe(false);
      expect(await opens(fresh)).toBe(false);
      expect(await opens(old)).toBe(true);
    });

    it("a lock that lands while the new code is written waits for it; the flow then ends and says that code is in effect", async () => {
      const w = new World();
      const perm = permissions(false);
      const { f, fresh, opens } = await newCodeShown(w, perm);
      f.saved();
      const c = f.state;
      if (c.at !== "recovery" || c.mode !== "confirm") throw new Error("no confirmation");
      const parts = fresh.split("-");
      const writing = f.confirmGroups([parts[c.groups[0]]!, parts[c.groups[1]]!]);
      expect(f.state).toMatchObject({ at: "recovery", mode: "confirm", busy: true });
      await f.locked(); // the lock's news arrives while the write is under way (the write itself got through)
      expect(f.state).toMatchObject({ busy: true }); // not ended under the write's feet
      await writing;
      expect(f.state).toEqual({ at: "failed", failure: { code: "locked_out" }, newCode: true });
      expect(await opens(fresh)).toBe(true); // written: the screen says it is the code that works now
      expect(perm.granted).toBe(false); // nothing was uploaded: sync is not on
    });

    it("joining at the summary: the join ends, Continue does nothing, the permission goes back", async () => {
      const w = new World();
      const perm = permissions(false);
      const { d, j } = await joinToSummary(w, perm);
      await d.svc.lock();
      await j.locked();
      expect(j.state).toEqual({ at: "failed", failure: { code: "locked_out" } });
      await j.commit();
      expect(j.state.at).toBe("failed");
      expect((await d.engine.view()).syncOn).toBe(false);
      expect(perm.granted).toBe(false);
    });

    it("a lock's news while Continue writes: it waits, and a join that got through stays on with the permission", async () => {
      const w = new World();
      const perm = permissions(false);
      const { d, j } = await joinToSummary(w, perm);
      const writing = j.commit();
      await j.locked(); // arrives while the commit runs; the commit itself got through before any lock
      await writing;
      expect(j.state.at).toBe("done");
      expect((await d.engine.view()).syncOn).toBe(true);
      expect(perm.granted).toBe(true);
    });

    it("an approval request open at the lock is given up with the join", async () => {
      const w = new World();
      const a = await firstDevice(w);
      await a.engine.round();
      const perm = permissions(false);
      const { d } = await protectedProfile(w, "B", perm, ["AWS"]);
      const kit = kitOf(d, perm);
      const j = begin(kit, perm, new JoinFlow(kit, { timer: () => () => undefined }));
      await signIn(w, j);
      await until(() => j.state.at === "choose");
      j.setName("B");
      await j.chooseApproval();
      expect(j.state.at).toBe("waiting");
      expect(await Approver.list(a.engine)).toHaveLength(1);
      await d.svc.lock();
      await j.locked();
      expect(j.state).toEqual({ at: "failed", failure: { code: "locked_out" } });
      expect(await Approver.list(a.engine)).toHaveLength(0);
      expect(perm.granted).toBe(false);
    });

    it("a flow that is over is left as it is", async () => {
      const w = new World();
      const perm = permissions(false);
      const d = emptyProfile(w, "B", perm);
      const kit = kitOf(d, perm);
      const j = new JoinFlow(kit);
      click(
        perm,
        asking(kit, () => undefined),
      ); // granted elsewhere
      await j.cancel();
      await j.locked();
      expect(j.state.at).toBe("closed");
    });
  });

  describe("what counts as a lock (lock.ts)", () => {
    function area() {
      const listeners = new Set<(c: Record<string, unknown>) => void>();
      const a: LockArea & { bump(): void; other(): void; count(): number } = {
        onChanged: { addListener: (f) => void listeners.add(f), removeListener: (f) => void listeners.delete(f) },
        bump: () => listeners.forEach((f) => f({ [LOCK_EPOCH_KEY]: { newValue: 1 } })),
        other: () => listeners.forEach((f) => f({ sk_session: { newValue: 1 } })),
        count: () => listeners.size,
      };
      return a;
    }
    const tick = () => new Promise((r) => setTimeout(r, 0));

    it("the epoch moving with the service saying locked; not another key, not a profile with nothing to lock", async () => {
      for (const [state, want] of [
        ["locked", 1],
        ["unlocked", 0],
        ["empty", 0],
        ["lost", 0],
      ] as const) {
        const a = area();
        let locks = 0;
        watchLock(
          a,
          async () => ({ state }),
          () => locks++,
        );
        a.other();
        await tick();
        expect(locks, state).toBe(0);
        a.bump();
        await tick();
        expect(locks, state).toBe(want);
      }
    });

    it("stops when told: no listener left, and an answer that comes after the stop is not acted on", async () => {
      const a = area();
      let locks = 0;
      let answer: (s: { state: "locked" }) => void = () => undefined;
      const stop = watchLock(
        a,
        () => new Promise((r) => (answer = r)),
        () => locks++,
      );
      a.bump();
      stop();
      answer({ state: "locked" });
      await tick();
      expect(locks).toBe(0);
      expect(a.count()).toBe(0);
    });

    it("the first-run join of an empty profile goes on through an epoch that moves (nothing to lock)", async () => {
      const w = new World();
      const a0 = await firstDevice(w);
      await a0.engine.round();
      const perm = permissions(false);
      const d = emptyProfile(w, "B", perm);
      const kit = kitOf(d, perm);
      const j = begin(kit, perm, new JoinFlow(kit));
      const a = area();
      watchLock(
        a,
        () => kit.service.status(),
        () => void j.locked(),
      );
      await signIn(w, j);
      await until(() => j.state.at === "choose");
      await d.svc.lock(); // what a lock elsewhere does to this profile: nothing (no vault to lock)
      a.bump();
      await tick();
      j.setName("B");
      await j.chooseRecovery();
      await j.submitRecovery(w.code);
      await j.commit();
      expect(j.state.at).toBe("done");
    });
  });
});
