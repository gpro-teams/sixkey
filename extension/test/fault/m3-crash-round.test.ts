// M3 crash matrix: the engine dies at every step of a round (SYNC-DESIGN §8.2 "任意 await 点崩溃", §8.3), a step being any
// storage write or any request, before it, after it, or lied to (a write acknowledged and dropped; an answer lost); then
// the service worker restarts (storage.session kept) or the browser does (cleared, the self-check, the user unlocks), and
// every device rounds until quiet. Whatever the step: the devices and the server converge on exactly the join of what
// was committed (no account lost or brought back), lastSynced never names a state the server does not hold, and no
// accepted write fails to absorb the head it replaced.
//
// Operations: a full round that pulls, merges (applyRemote: snapshot, slots, pointer, copies, the outbox) and uploads
// (cursor, PUT, the lastSynced CAS); the outbox push of a locked worker; a round answered with 409 (the head moved
// between its pull and its PUT); M2's storage recovery (the active slot torn) followed by an edit and a round; and the
// same recovery inside a worker round's own vault load (M3R-1).
import { beforeAll, describe, expect, it } from "vitest";
import type { Vk } from "../../src/core/crypto/vk";
import { KEYS } from "../../src/core/storage/format";
import { aliveEntries } from "../../src/core/vault/model";
import { addEntry, editEntry } from "../../src/core/vault/ops";
import { tear } from "../helpers/faulty-kv";
import { input } from "../helpers/m2-world";
import { checkQuiet, Oracle, watchServer } from "../helpers/m3-check";
import { runDying, type Mode } from "../helpers/m3-crash";
import { cloneWorld, quiesce, type Context, type Device, type World, worldOf } from "../helpers/m3-world";

type Scenario = {
  name: string;
  /** From the shared base: what happens before the dying operation (on healthy contexts). */
  setup: (w: World) => Promise<void>;
  /** The dying operation on device A's context. */
  op: (c: Context, w: World) => Promise<unknown>;
  /** The A context is locked before the operation. */
  locked?: boolean;
  /** After the oracle has folded every device: damage to A's storage the operation starts from. */
  afterFold?: (w: World) => void;
  /** An account the operation adds: once its save returned, every device holds it alive in the end. */
  adds?: string;
};

/** The worlds whose operation's save returned (the user was told it was saved). */
const saved = new WeakSet<World>();

let base: World;
let vk: Vk;
beforeAll(async () => {
  base = await worldOf(2, ["GitHub", "AWS"]);
  vk = await base.devices[0]!.vk();
}, 60_000);

const SCENARIOS: Scenario[] = [
  {
    name: "a full round: pull, merge, upload",
    setup: async (w) => {
      const [a, b] = w.devices as [Device, Device];
      w.advance(1000);
      await b.add("from B");
      await b.engine.round();
      const id = (await a.vault()).entries.find((e) => e.issuer === "AWS")!.id;
      await a.svc.mutate((v, c) => editEntry(v, id, { label: "edited on A" }, c));
    },
    op: (c) => c.engine.round(),
  },
  {
    name: "the outbox push of a locked worker",
    setup: async (w) => {
      const a = w.devices[0]!;
      w.advance(1000);
      await a.add("in the outbox");
      await a.lockNow();
    },
    op: (c) => c.engine.round(),
    locked: true,
  },
  {
    name: "a round whose PUT is answered 409 (the head moved meanwhile), then merges and uploads again",
    setup: async (w) => {
      const [a, b] = w.devices as [Device, Device];
      w.advance(1000);
      await a.add("A's edit");
      await b.add("B's edit");
      w.server.fault({
        match: "PUT /v1/vault",
        kind: "hook",
        fn: async () => {
          await b.engine.round();
        },
      });
    },
    op: (c) => c.engine.round(),
  },
  {
    name: "a storage recovery (the active slot torn), an edit and a round",
    setup: async (w) => {
      const [a, b] = w.devices as [Device, Device];
      w.advance(1000);
      await a.add("synced on A");
      await a.engine.round();
      await b.engine.round();
      w.advance(1000);
      await b.add("from B");
      await b.engine.round();
    },
    afterFold: (w) => {
      const kv = w.devices[0]!.disk.kv;
      const ptr = kv.data.get(KEYS.active) as "a" | "b";
      kv.data.set(KEYS.slot[ptr], tear(kv.data.get(KEYS.slot[ptr])));
    },
    op: async (c, w) => {
      // the recovery: the pointer back to the other slot, the heal, the sync hook's clear (a refused save is reported to
      // the user and changes nothing: the round still runs)
      await c.svc.status().catch(() => undefined);
      await c.svc.ackEvents().catch(() => undefined);
      if (
        await c.svc
          .mutate((v, k) => addEntry(v, input("after the recovery"), k).vault)
          .then(
            () => true,
            () => false,
          )
      )
        saved.add(w);
      return c.engine.round();
    },
    adds: "after the recovery",
  },
  {
    // M3R-1: nothing opened the vault in this context before the round: the recovery runs inside the round's own load
    name: "a storage recovery inside a worker round's own vault load (no popup first)",
    setup: async (w) => {
      const [a, b] = w.devices as [Device, Device];
      w.advance(1000);
      await a.add("only on A and the server");
      await a.engine.round();
      w.advance(1000);
      await b.add("from B");
      await b.engine.round();
    },
    afterFold: (w) => {
      const a = w.devices[0]!;
      const kv = a.disk.kv;
      const ptr = kv.data.get(KEYS.active) as "a" | "b";
      kv.data.set(KEYS.slot[ptr], tear(kv.data.get(KEYS.slot[ptr])));
      a.restartWorker();
    },
    op: (c) => c.engine.round(),
  },
];

async function row(
  s: Scenario,
  at: number,
  mode: Mode,
  restart: "worker" | "browser",
): Promise<{ reached: boolean; error?: unknown }> {
  const w = cloneWorld(base);
  const watch = watchServer(w, () => vk);
  const [a, b] = w.devices as [Device, Device];
  await s.setup(w);
  const oracle = new Oracle();
  await oracle.foldDevice(a, vk);
  await oracle.foldDevice(b, vk);
  s.afterFold?.(w);
  const r = await runDying(a, at, mode, (c) => s.op(c, w));
  w.server.clearFaults();
  if (restart === "worker") a.restartWorker();
  else {
    await a.restartBrowser();
    await a.unlock();
  }
  if (s.locked || restart === "browser") await a.unlock().catch(() => undefined);
  await quiesce(w);
  await oracle.foldDevice(a, vk); // a "keep" answer would commit a new state; none here, so this adds nothing
  await checkQuiet(w, vk, { oracle, label: `${s.name} @${at} ${mode} ${restart}` });
  // A lie on the vault store's own slot or pointer write loses an acknowledged save in Phase 0's store itself (the pointer
  // is the commit point and is not read back; docs/design/notes/M3-NOTES.md §3 item 18): outside M3, so not counted here. Every other lie,
  // M3's and M2's sync writes included, is.
  const lied = mode === "lie" ? (r.steps[at - 1] ?? "") : "";
  if (s.adds && saved.has(w) && !/^local\.set (sk_active|sk_slot_[ab])$/.test(lied)) {
    for (const d of w.devices)
      expect(
        aliveEntries(await d.vault(vk)).map((e) => e.issuer),
        `${s.name} @${at} ${mode} ${restart} ${r.steps.join(",")}`,
      ).toContain(s.adds);
  }
  expect(watch.problems, `${s.name} @${at} ${mode} ${restart}`).toEqual([]);
  return r;
}

describe("M3 crash matrix: a round dies at every step", () => {
  for (const s of SCENARIOS) {
    for (const restart of ["worker", "browser"] as const) {
      it(`${s.name}, then a ${restart} restart`, async () => {
        let rows = 0;
        for (const mode of ["before", "after", "lie"] as const) {
          for (let at = 1; at < 200; at++) {
            const r = await row(s, at, mode, restart);
            if (r.error !== undefined && !(r.error instanceof Error && /network|NetworkError/.test(String(r.error)))) {
              // an engine error other than the injected death is a finding unless the round reports it as a status
              throw r.error;
            }
            rows++;
            if (!r.reached) break; // the operation finished before step `at`: every step was covered
          }
        }
        expect(rows).toBeGreaterThan(10); // not vacuous
      }, 600_000);
    }
  }
});
