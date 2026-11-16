// The M3 re-review's seeded fuzzer for rotation races (docs/audit/internal-reviews/M3-REREVIEW.md), adopted as a regression test (the model has no rotations). Four devices (clocks 0, +2 d, -2 d,
// +3 h), only adds (so "nothing lost" is: every name ever committed is alive at the end), rounds, rotations by any
// device with interleavings between prepare and commit (another device's write and round, a 409 raised by a hook inside
// the rotate, a lost rotate answer, a lost GET /v1/keys after it, a merging round that cannot pull, a partition), the
// unconfirmed rotation retried with the same handle, lost PUT /v1/vault answers, late deliveries. Every accepted PUT and
// rotate must absorb the head it replaced (watchServer, each head opened with its own key). Then: every device adopts
// with the password where asked, quiesce, and every name is on every device and in the head.
// SIXKEY_RR_RUNS (default 6), SIXKEY_RR_STEPS (default 40), SIXKEY_RR_SEED.
import { describe, expect, it } from "vitest";
import type { Vk } from "../../src/core/crypto/vk";
import { aliveEntries } from "../../src/core/vault/model";
import {
  adoptWithSecret,
  commitRotation,
  prepareRotation,
  type PreparedRotation,
} from "../../src/core/sync/engine/keys";
import { KEYS } from "../../src/core/storage/format";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { tear } from "../helpers/faulty-kv";
import { watchServer } from "../helpers/m3-check";
import { prng } from "../helpers/faulty-transport";
import { EMAIL, quiesce, worldOf, type Device, type World } from "../helpers/m3-world";

const RUNS = Number(process.env.SIXKEY_RR_RUNS ?? 6);
const STEPS = Number(process.env.SIXKEY_RR_STEPS ?? 40);
const SEED = Number(process.env.SIXKEY_RR_SEED ?? 4242);
const DAY = 86_400_000;

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

async function runOne(
  seed: number,
  o: { tears?: boolean } = {},
): Promise<{ log: string[]; stats: Record<string, number> }> {
  const r = prng(seed);
  const w: World = await worldOf(4, ["GitHub", "AWS"], [0, 2 * DAY, -2 * DAY, 3 * 3_600_000]);
  const keys = new Map<string, Vk>();
  const learn = async () => {
    for (const d of w.devices) {
      try {
        const v = await d.vk();
        keys.set(v.id, v);
      } catch {
        /* locked */
      }
    }
  };
  await learn();
  const v0 = await w.devices[0]!.vk();
  const watch = watchServer(w, () => v0, { keyOf: (id) => keys.get(id) });
  const added = new Set<string>(["GitHub", "AWS"]);
  const log: string[] = [];
  const stats: Record<string, number> = {
    rotations: 0,
    notSynced: 0,
    unconfirmed: 0,
    retried: 0,
    retryNotSyncedInEffect: 0,
    other: 0,
    tears: 0,
  };
  const pending: { d: Device; h: PreparedRotation }[] = [];
  const awake = async (d: Device) => {
    await d.svc.unlockWithPassword(w.password).catch(() => undefined);
  };
  const add = async (d: Device, tag: string) => {
    const n = `${tag}-${Math.floor(r() * 1e6)}`;
    w.advance(1 + Math.floor(r() * 3000));
    await awake(d); // the idle limit may have locked it (virtual time): the user types the password
    await d.add(n);
    added.add(n);
  };
  for (let i = 0; i < STEPS; i++) {
    const d = pick(r, w.devices);
    const x = r();
    if (x < 0.3) {
      await add(d, d.name);
      log.push(`${d.name} add`);
      continue;
    }
    if (x < 0.55) {
      const s = await d.engine.round();
      log.push(`${d.name} round ${s.status}`);
      continue;
    }
    if (x < 0.62) {
      const on = r() < 0.5;
      d.net.partition(on);
      log.push(`${d.name} partition ${on}`);
      continue;
    }
    if (x < 0.68) {
      d.net.inject({ kind: pick(r, ["lose_response", "late", "duplicate"] as const), match: "PUT /v1/vault" });
      log.push(`${d.name} put fault`);
      continue;
    }
    if (x < 0.7) {
      for (const e of w.devices) await e.net.flushLate();
      log.push("flush");
      continue;
    }
    if (x < 0.74 && pending.length) {
      const p = pending.shift()!;
      await awake(p.d);
      stats.retried!++;
      const before = w.server.account(EMAIL).vault!.vk_id;
      const e = await commitRotation(p.d.engine, p.h).then(
        () => "ok",
        (err) => (err as { code?: string }).code ?? String(err),
      );
      const inEffectAlready = before !== (await p.d.vk().catch(() => ({ id: "" }))).id && e === "not_synced";
      if (inEffectAlready) stats.retryNotSyncedInEffect!++;
      log.push(`${p.d.name} rotation retried: ${e}`);
      await learn();
      continue;
    }
    if (x < 0.86) {
      await awake(d);
      // a rotation with an interleaving
      const others = w.devices.filter((o) => o !== d);
      let h: PreparedRotation;
      try {
        h = await prepareRotation(d.engine, w.password);
      } catch (err) {
        log.push(`${d.name} prepare: ${(err as { code?: string }).code ?? err}`);
        continue;
      }
      const k = pick(r, [
        "other_writes",
        "hook_409",
        "lost_answer",
        "lost_answer_and_keys",
        "merge_cannot_pull",
        "none",
      ] as const);
      if (k === "other_writes") {
        const o = pick(r, others);
        await add(o, `${o.name}-between`);
        await o.engine.round();
      }
      if (k === "hook_409") {
        const o = pick(r, others);
        w.server.fault({
          match: "POST /v1/keys/rotate",
          kind: "hook",
          fn: async () => {
            await add(o, `${o.name}-in-rotate`);
            await o.engine.round();
          },
        });
      }
      if (k === "lost_answer") d.net.inject({ match: "POST /v1/keys/rotate", kind: "lose_response" });
      if (k === "lost_answer_and_keys") {
        d.net.inject({ match: "POST /v1/keys/rotate", kind: "lose_response" });
        d.net.inject({ match: "GET /v1/keys", kind: "fail_before" });
      }
      if (k === "merge_cannot_pull") {
        const o = pick(r, others);
        await add(o, `${o.name}-pre`);
        await o.engine.round();
        d.net.inject({ match: "GET /v1/vault", kind: "fail_before" });
      }
      const e = await commitRotation(d.engine, h).then(
        () => "ok",
        (err) => (err as { code?: string }).code ?? String(err),
      );
      w.server.clearFaults();
      if (e === "ok") stats.rotations!++;
      else if (e === "not_synced") {
        stats.notSynced!++;
        pending.push({ d, h });
      } else if (e === "unconfirmed") {
        stats.unconfirmed!++;
        pending.push({ d, h });
      } else stats.other!++;
      log.push(`${d.name} rotate(${k}): ${e}`);
      await learn();
      continue;
    }
    if (o.tears && x < 0.92) {
      // M3 revision 3 (§4.7, revision 19): a DIRTY device torn: a save whose only other copy is the outbox, kept as the
      // orphan by the recovery; then a rotation elsewhere or here may come before the fold (R3, the merge-first round)
      await awake(d);
      await add(d, `${d.name}-torn`);
      const ob = d.disk.kv.data.get(SYNC_KEYS.outbox) as { checksum?: string } | undefined;
      const gen = await d.generation().catch(() => null);
      if (!ob || !gen || ob.checksum !== gen.envelope.checksum) {
        log.push(`${d.name} tear skipped`);
        continue;
      } // no outbox: not a case the design covers
      if (r() < 0.5) await d.lockNow();
      const ptr = d.disk.kv.data.get(KEYS.active) as "a" | "b";
      d.disk.kv.data.set(KEYS.slot[ptr], tear(d.disk.kv.data.get(KEYS.slot[ptr])));
      d.restartWorker();
      stats.tears!++;
      log.push(`${d.name} torn, round ${(await d.engine.round()).status}`);
      continue;
    }
    w.advance(Math.floor(r() * 600_000));
    log.push("time");
  }
  // settle: the network back, every device adopts where asked (the same password across rotations), then quiet
  for (const d of w.devices) {
    d.net.partition(false);
    await d.net.flushLate();
    await awake(d);
  }
  w.server.clearFaults();
  for (let pass = 0; pass < 3; pass++) {
    for (const d of w.devices) {
      const s = await d.engine.round({ explicit: true });
      if (s.status === "needs_password") await adoptWithSecret(d.engine, { password: w.password }).catch(() => null);
    }
    await learn();
  }
  await quiesce(w, 12);
  await learn();
  await watch.settle();
  const vk = await w.devices[0]!.vk();
  const head = new Set(aliveEntries((await w.serverVault(vk))!).map((e) => e.issuer));
  const missing = [...added].filter((n) => !head.has(n));
  for (const d of w.devices) {
    const mine = new Set(aliveEntries(await d.vault()).map((e) => e.issuer));
    expect(
      [...added].filter((n) => !mine.has(n)),
      `seed ${seed} ${d.name} lost: ${log.slice(-15).join(" | ")}`,
    ).toEqual([]);
  }
  expect(missing, `seed ${seed} head lost`).toEqual([]);
  expect(watch.problems, `seed ${seed} ${log.slice(-20).join(" | ")}`).toEqual([]);
  expect(watch.unverified, `seed ${seed}: writes no key opened`).toBe(0);
  return { log, stats };
}

describe("rotation races (re-review fuzzer)", () => {
  it(`with dirty tears (revision 19's orphan meets rotations): ${RUNS} seeded runs of ${STEPS} steps`, async () => {
    const totals: Record<string, number> = {};
    for (let i = 0; i < RUNS; i++) {
      const { stats } = await runOne(SEED + 1 + i * 7919, { tears: true });
      for (const [k, v] of Object.entries(stats)) totals[k] = (totals[k] ?? 0) + v;
    }
    console.log("rotation fuzz with tears", JSON.stringify(totals));
    expect(totals.retryNotSyncedInEffect ?? 0).toBe(0);
    expect(totals.tears ?? 0).toBeGreaterThan(0);
  }, 3_600_000);

  it(`${RUNS} seeded runs of ${STEPS} steps`, async () => {
    const totals: Record<string, number> = {};
    for (let i = 0; i < RUNS; i++) {
      const { stats } = await runOne(SEED + i * 7919);
      for (const [k, v] of Object.entries(stats)) totals[k] = (totals[k] ?? 0) + v;
    }
    console.log("rotation fuzz", JSON.stringify(totals));
    expect(totals.retryNotSyncedInEffect ?? 0).toBe(0); // M3RR-1: never "not synced" for a rotation the server holds
    expect(totals.rotations ?? 0).toBeGreaterThan(0);
  }, 3_600_000);
});
