// M3 model test (SYNC-DESIGN §8.2): three devices with clocks two days apart, random interleavings of every kind of edit
// (add, rename, move, group, delete, restore, erase, HOTP), rounds, locks, offline periods, network faults (lost answers,
// duplicates, late deliveries, failures), crashes at a random step of a round with worker or browser restarts, server
// restarts and honest rollbacks (PITR), and the odd new recovery code. Seeded (fast-check), so a failure replays.
// With `families` (the M3 review's extension, docs/audit/internal-reviews/M3-REVIEW.md §5.3), four devices (clocks 0, +2 d, -2 d, +3 h) and:
//   tear  a DIRTY device (revision 19, §4.7): in sync, a save committed with its outbox, then its active slot torn (the
//         damage the two-slot store recovers from; the save is then only in the orphan). Then: "lock every time" (locked
//         at once, the worker pushes or rounds without the key), unlocked (the worker's round folds it), the popup opens
//         first, a local edit after the tear, a second tear before the upload, another device writes first (no push:
//         the fold merges), the save is an erase (the guard on the fold, answered or not), every copy is lost and the
//         cloud restore folds it, the device turns sync off (or is revoked and removes its identity: the flows fold
//         first) and joins again by recovery code, the locked orphan push meets a 409 (another device wrote between the
//         status and the PUT), or the save's pointer write was lost (the self-check's recovery: a checksum-equal orphan,
//         retired at the next fold); revision 20: another device writes (or a second save lands during the push), the
//         locked push demotes the stale outbox, then the tear (R3R-1); a second tear while an entry waits, of a save the
//         merge-only outbox holds (R3R-5);
//   hook  an interleaving inside a device's own PUT /v1/vault: an edit on that device, another device's edit and round
//         (a 409), or another context of the device opening the popup;
//   pw    a master-password change, a third of them with the PUT /v1/keys answer lost (reconciliation).
// With tears there are no PITR rollbacks: a tear and a rollback together lose the newest local state twice, a double
// failure the design does not cover (the review's harness lesson).
// Once everything is back and quiet:
//   - every device and the server hold the same vault, which is exactly the join of everything any device committed
//     (nothing lost, nothing deleted brought back, nothing invented): merge idempotence and commutativity through the engine;
//   - one more round on every device sends nothing and commits nothing;
//   - every accepted write absorbed the head it replaced (never an upload from a rolled-back or unmerged head);
//   - lastSynced never names a state the server does not hold;
//   - nothing secret (the accounts' secrets, the password, the recovery codes, the vault key) appears in any diagnostics
//     line, any engine state, any notice, the server's request log or a request the server found invalid.
import { expect } from "vitest";
import { toB64 } from "../../src/core/crypto/bytes";
import type { Vk } from "../../src/core/crypto/vk";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { KEYS } from "../../src/core/storage/format";
import { lastSyncedOf } from "../../src/core/sync/local/state";
import {
  adoptWithSecret,
  changePassword,
  commitRecoveryCode,
  prepareRecoveryCode,
  removeSyncIdentity,
  revokeDevice,
  turnSyncOff,
} from "../../src/core/sync/engine/keys";
import { commitJoin, joinWithRecoveryCode } from "../../src/core/sync/engine/enroll";
import { MergeBlocked, type MergeAnswer } from "../../src/core/service/sync-flows";
import { tear } from "./faulty-kv";
import { aliveEntries, trashEntries, type Vault } from "../../src/core/vault/model";
import {
  addEntry,
  deleteEntry,
  editEntry,
  moveEntry,
  purgeEntry,
  restoreEntry,
  setGroup,
} from "../../src/core/vault/ops";
import { checkQuiet, cj, Oracle, watchServer } from "./m3-check";
import { runDying } from "./m3-crash";
import { prng } from "./faulty-transport";
import { input, secretOf } from "./m2-world";
import { cloneWorld, contextOver, EMAIL, quiesce, type Device, type World, worldOf } from "./m3-world";

const DAY = 86_400_000;

const bases = new Map<number, { base: World; vk: Vk }>();
let vk: Vk;
/** The shared world, built once per size: three devices (clocks 0, +2 days, -2 days), or four (and +3 hours). */
export async function modelBase(n: 3 | 4 = 3): Promise<{ base: World; vk: Vk }> {
  let b = bases.get(n);
  if (!b) {
    const base = await worldOf(n, ["GitHub", "AWS", "Stripe"], [0, 2 * DAY, -2 * DAY, 3 * 3_600_000].slice(0, n));
    await quiesce(base);
    b = { base, vk: await base.devices[0]!.vk() };
    bases.set(n, b);
  }
  return b;
}

export type Family = "tear" | "hook" | "pw";
export type Ctx = {
  w: World;
  rnd: () => number;
  oracle: Oracle;
  locked: Set<Device>;
  snaps: ReturnType<World["server"]["snapshot"]>[];
  log: string[];
  codes: string[];
  families: ReadonlySet<Family>;
  passwords: string[];
};

const pick = <T>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

/** The user unlocks with whichever recovery code they hold that opens this device's keyring (a newer one may not yet). */
async function unlockAny(c: Ctx, d: Device): Promise<void> {
  for (const code of [...c.codes].reverse()) {
    try {
      await d.svc.unlockWithRecoveryCode(code);
      return;
    } catch {
      // not this one
    }
  }
  throw new Error(`${d.name}: no code opens it`);
}

async function edit(c: Ctx, d: Device): Promise<void> {
  if (c.locked.has(d)) return;
  const v = await d.vault(vk);
  const alive = aliveEntries(v);
  const trash = trashEntries(v);
  const kind = pick(c.rnd, [
    "add",
    "add",
    "rename",
    "rename",
    "move",
    "group",
    "delete",
    "delete",
    "restore",
    "purge",
    "hotp",
  ] as const);
  c.w.advance(Math.floor(c.rnd() * 5000) + 1);
  const n = `acct-${Math.floor(c.rnd() * 1e6)}`;
  let f: ((x: Vault, k: import("../../src/core/vault/hlc").Clock) => Vault) | null = null;
  if (kind === "add") f = (x, k) => addEntry(x, input(n, secretOf(n)), k).vault;
  else if (kind === "hotp")
    f = (x, k) =>
      addEntry(
        x,
        {
          type: "hotp",
          issuer: n,
          label: "h",
          secret: secretOf(n),
          algorithm: "SHA1",
          digits: 6,
          period: 30,
          counter: Math.floor(c.rnd() * 5),
        },
        k,
      ).vault;
  else if (kind === "rename" && alive.length) {
    const e = pick(c.rnd, alive);
    f = (x, k) => editEntry(x, e.id, { label: `l${Math.floor(c.rnd() * 1000)}` }, k);
  } else if (kind === "move" && alive.length > 1) {
    const e = pick(c.rnd, alive);
    const to = Math.floor(c.rnd() * alive.length);
    f = (x, k) => moveEntry(x, e.id, to, k);
  } else if (kind === "group" && alive.length) {
    const e = pick(c.rnd, alive);
    f = (x, k) => setGroup(x, e.id, c.rnd() < 0.5 ? undefined : "Work", k);
  } else if (kind === "delete" && alive.length) {
    const e = pick(c.rnd, alive);
    f = (x, k) => deleteEntry(x, e.id, k);
  } else if (kind === "restore" && trash.length) {
    const e = pick(c.rnd, trash);
    f = (x, k) => restoreEntry(x, e.id, k);
  } else if (kind === "purge" && trash.length) {
    const e = pick(c.rnd, trash);
    f = (x, k) => purgeEntry(x, e.id, k);
  }
  if (!f) return;
  const g = f;
  try {
    await d.svc.mutate((x, k) => {
      try {
        return g(x, k);
      } catch {
        return x; // the entry changed under the edit (a concurrent merge): no edit
      }
    });
  } catch (e) {
    if ((e as { code?: string }).code === "locked") {
      c.locked.add(d);
      c.log.push(`${d.name} idle-locked`);
      return;
    } // the idle limit passed
    throw e;
  }
  await c.oracle.foldDevice(d, vk);
  c.log.push(`${d.name} ${kind}`);
}

async function round(c: Ctx, d: Device): Promise<void> {
  const r = await d.engine.round();
  c.log.push(`${d.name} round ${r.status}${r.error ? ` ${r.error}` : ""}`);
  if (r.status === "review_needed" && r.blocked && c.rnd() < 0.7) {
    await d.engine.round({
      answer: { seen: r.blocked.seen, accept: [...r.blocked.report.secretChanged, ...r.blocked.report.purgedAlive] },
    });
  }
  await c.oracle.foldDevice(d, vk);
}

async function add(c: Ctx, d: Device, tag: string): Promise<void> {
  if (c.locked.has(d)) return;
  const n = `${tag}-${Math.floor(c.rnd() * 1e6)}`;
  try {
    await d.svc.mutate((x, k) => addEntry(x, input(n, secretOf(n)), k).vault);
  } catch (e) {
    if ((e as { code?: string }).code === "locked") {
      c.locked.add(d);
      return;
    }
    throw e;
  }
  await c.oracle.foldDevice(d, vk);
  c.log.push(`${d.name} add ${tag}`);
}

/** The review's families (see the top of this file); false when none applies to this draw. */
async function familyStep(c: Ctx, d: Device, x: number): Promise<boolean> {
  if (c.families.has("tear") && x < 0.08) {
    if (c.locked.has(d)) return true;
    // A DIRTY device (revision 19, §4.7): in sync, then a save committed (its outbox written for the active generation in
    // the same lock), then the active slot torn: the save lives only in the outbox, which the recovery keeps as the orphan.
    const r = await d.engine.round({ explicit: true });
    await c.oracle.foldDevice(d, vk);
    if (r.status !== "ok" || !lastSyncedOf(d.disk.kv.data.get(SYNC_KEYS.state))) {
      c.log.push(`${d.name} tear skipped (${r.status})`);
      return true;
    }
    const kind = pick(c.rnd, [
      "lock_every_time",
      "unlocked",
      "popup_first",
      "edit_after",
      "double_tear",
      "server_moved",
      "purge",
      "cloud_restore",
      "turn_off_rejoin",
      "revoked_rejoin",
      "orphan_push_409",
      "lost_pointer",
      "elsewhere_then_push",
      "save_during_push",
      "second_tear",
    ] as const);
    if (kind === "purge") {
      // an erase in one step (delete and purge): the fold of the orphan meets the guard (review_needed) on this device
      const alive = aliveEntries(await d.vault(vk));
      if (!alive.length) return true;
      const e = pick(c.rnd, alive);
      c.w.advance(1000);
      try {
        await d.svc.mutate((v, k) => {
          try {
            return purgeEntry(deleteEntry(v, e.id, k), e.id, k);
          } catch {
            return v;
          }
        });
      } catch (err) {
        if ((err as { code?: string }).code === "locked") {
          c.locked.add(d);
          return true;
        } // the idle limit passed
        throw err;
      }
      await c.oracle.foldDevice(d, vk);
    } else await add(c, d, "torn-save");
    if (c.locked.has(d)) return true; // idle-locked meanwhile: no save made
    if (!d.disk.kv.data.get(SYNC_KEYS.outbox)) {
      c.log.push(`${d.name} tear (${kind}) skipped (no outbox)`);
      return true;
    }
    if (kind === "lock_every_time" || kind === "orphan_push_409") {
      await d.lockNow();
      c.locked.add(d);
    }
    if (kind === "lost_pointer") {
      // the pointer write of the save was lost: the browser's self-check finds the newer slot and moves the pointer back
      // to it (a recovery: the hook keeps the outbox as the orphan), and the active generation is the very one the
      // orphan was written for: retirement 3 at the next fold
      const kv = d.disk.kv;
      kv.data.set(KEYS.active, kv.data.get(KEYS.active) === "a" ? "b" : "a");
      await d.restartBrowser();
      if (!d.disk.kv.data.get(SYNC_KEYS.orphan)) throw new Error(`${d.name}: the lost pointer write made no orphan`);
      await unlockAny(c, d);
      c.locked.delete(d);
      const r1 = await d.engine.round();
      if (d.disk.kv.data.get(SYNC_KEYS.orphan))
        throw new Error(`${d.name}: the checksum-equal orphan was not retired (${r1.status})`);
      c.log.push(`${d.name} tear (lost_pointer): round ${r1.status}`);
      await c.oracle.foldDevice(d, vk);
      return true;
    }
    if (kind === "server_moved") {
      // another device writes first: the orphan's (base, head) is not the server's any more (no push; the fold merges)
      const o = pick(c.rnd, c.w.devices.filter((x) => x !== d && !c.locked.has(x)).concat([d]));
      if (o !== d) {
        await add(c, o, "past-orphan");
        await o.engine.round();
        await c.oracle.foldDevice(o, vk);
      }
    }
    const tearIt = () => {
      const kv = d.disk.kv;
      const ptr = kv.data.get(KEYS.active) as "a" | "b";
      kv.data.set(KEYS.slot[ptr], tear(kv.data.get(KEYS.slot[ptr])));
      d.restartWorker();
    };
    if (kind === "elsewhere_then_push" || kind === "save_during_push") {
      // revision 20 (R3R-1), §8.2: the order "another device writes (or a second save lands during the push) → the locked
      // push finds the outbox stale → the tear". The push demotes it (never drops it); the tear then cannot lose the save
      await d.lockNow();
      c.locked.add(d);
      const mine = ((await d.local.identity.get()) as { deviceId: string }).deviceId;
      if (kind === "elsewhere_then_push") {
        const others = c.w.devices.filter((x) => x !== d && !c.locked.has(x));
        if (others.length) {
          const o = pick(c.rnd, others);
          o.net.partition(false).clearRules();
          await add(c, o, "before-locked-push");
          await o.engine.round();
          await c.oracle.foldDevice(o, vk);
        }
      } else {
        const signer = (req: { headers: Readonly<Record<string, string>> }) =>
          Object.entries(req.headers).find(([k]) => k.toLowerCase() === "sixkey-device")?.[1];
        let fired = false;
        c.w.server.fault({
          match: (key, req) => key === "PUT /v1/vault" && signer(req) === mine && !fired,
          kind: "hook",
          count: 1,
          fn: async () => {
            fired = true;
            await unlockAny(c, d); // the popup, holding the key in "lock every time", commits a second save during the push
            c.locked.delete(d);
            await add(c, d, "during-push");
            await d.lockNow();
            c.locked.add(d);
          },
        });
      }
      d.restartWorker();
      const r1 = await d.engine.push();
      c.w.server.clearFaults();
      d.restartWorker();
      const r2 = await d.engine.push(); // the next kick (or the 30-minute alarm): a stale outbox here is demoted
      tearIt();
      await d.svc.status().catch(() => undefined); // the popup's open: the recovery
      c.log.push(
        `${d.name} tear (${kind}): push ${r1.status}/${r2.status}, entries ${((d.disk.kv.data.get(SYNC_KEYS.orphan) as { items?: unknown[] } | undefined)?.items ?? []).length}`,
      );
      await c.oracle.foldDevice(d, vk);
      return true;
    }
    if (kind === "second_tear") {
      // revision 20 (R3R-5): a tear (the save becomes an entry), then the popup saves again while the entry waits (the
      // merge-only outbox), then a second tear of that slot: the recovery appends it as a second entry
      tearIt();
      await d.svc.status().catch(() => undefined);
      await unlockAny(c, d);
      c.locked.delete(d);
      await add(c, d, "while-the-entry-waits");
      if (c.locked.has(d)) return true;
      await d.lockNow();
      c.locked.add(d);
      tearIt();
      await d.svc.status().catch(() => undefined);
      c.log.push(
        `${d.name} tear (second_tear): entries ${((d.disk.kv.data.get(SYNC_KEYS.orphan) as { items?: unknown[] } | undefined)?.items ?? []).length}`,
      );
      await c.oracle.foldDevice(d, vk);
      return true;
    }
    if (kind === "cloud_restore") {
      // every copy of the vault unreadable (the store says "lost"); the save only in the outbox: the cloud restore
      // (adoptWithSecret over the lost vault) keeps it as the orphan at its own write and folds it into the restored vault
      const kv = d.disk.kv;
      for (const k of [KEYS.slot.a, KEYS.slot.b, KEYS.keyringCopy]) kv.data.set(k, { torn: "x" });
      for (const k of [...kv.data.keys()]) if (k.startsWith("sk_snap")) kv.data.delete(k);
      d.disk.mirror.data.clear();
      d.restartWorker();
      let res = "none";
      for (const pw of [...c.passwords].reverse()) {
        const a = await adoptWithSecret(d.engine, { password: pw }).catch((e: unknown) => ({
          kind: `threw ${(e as { code?: string }).code ?? e}`,
        }));
        res = a.kind;
        if (a.kind === "adopted") break;
      }
      c.log.push(`${d.name} tear (cloud_restore): ${res}`);
      if (res !== "adopted") throw new Error(`${d.name}: the cloud restore did not adopt (${res})`);
      await c.oracle.foldDevice(d, vk);
      return true;
    }
    tearIt();
    if (kind === "turn_off_rejoin" || kind === "revoked_rejoin") {
      // the flows that delete the sync records fold the orphan first (§3.10, D11); then the device joins again. The
      // network is fine for these steps (the user is at the settings page), so the outcome is the flow's, not a fault's.
      const all = (e: MergeBlocked): MergeAnswer => ({
        seen: e.seen,
        accept: [...e.report.secretChanged, ...e.report.purgedAlive],
      });
      const fine = async (x: Device) => {
        x.net.partition(false).clearRules();
        await x.net.flushLate();
      };
      await fine(d);
      await d.svc.status().catch(() => undefined); // the recovery (the orphan kept)
      await unlockAny(c, d); // the settings page: the user unlocked (an idle lock may have passed meanwhile)
      c.locked.delete(d);
      let off = "none";
      if (kind === "turn_off_rejoin") {
        for (const pw of [...c.passwords].reverse()) {
          off = await turnSyncOff(d.engine, pw).then(
            () => "off",
            async (e: unknown) => {
              if (e instanceof MergeBlocked)
                return turnSyncOff(d.engine, pw, { answer: all(e) }).then(
                  () => "off",
                  (e2: unknown) => `refused ${(e2 as { code?: string }).code ?? e2}`,
                );
              return `refused ${(e as { code?: string }).code ?? e}`;
            },
          );
          if (off === "off") break;
        }
      } else {
        const others = c.w.devices.filter((x) => x !== d && !c.locked.has(x));
        const o = others.length ? pick(c.rnd, others) : null;
        const id = (await d.local.identity.get()) as { deviceId: string } | null;
        if (!o || !id) {
          c.log.push(`${d.name} tear (revoked_rejoin) skipped`);
          await d.engine.round();
          await c.oracle.foldDevice(d, vk);
          return true;
        }
        await fine(o);
        await unlockAny(c, o);
        c.locked.delete(o);
        let revoked = false;
        for (const pw of [...c.passwords].reverse()) {
          revoked = await revokeDevice(o.engine, id.deviceId, pw).then(
            () => true,
            () => false,
          );
          if (revoked) break;
        }
        let r1 = await d.engine.round({ explicit: true }); // rejected_by_server (the orphan folded in step 0 first)
        if (r1.status === "review_needed" && r1.blocked)
          r1 = await d.engine.round({
            explicit: true,
            answer: {
              seen: r1.blocked.seen,
              accept: [...r1.blocked.report.secretChanged, ...r1.blocked.report.purgedAlive],
            },
          });
        off = `${revoked ? "revoked" : "not revoked"}, round ${r1.status}`;
        if (r1.status === "rejected_by_server") {
          off = await removeSyncIdentity(d.engine).then(
            () => "off",
            async (e: unknown) => {
              if (e instanceof MergeBlocked)
                return removeSyncIdentity(d.engine, { answer: all(e) }).then(
                  () => "off",
                  (e2: unknown) => `refused ${(e2 as { code?: string }).code ?? e2}`,
                );
              return `refused ${(e as { code?: string }).code ?? e}`;
            },
          );
        }
      }
      await c.oracle.foldDevice(d, vk); // the save is in this vault now (it stays when sync is off)
      if (off !== "off") throw new Error(`${d.name}: could not take sync off (${off})`);
      let joined = "none";
      for (const code of [...c.codes].reverse()) {
        try {
          const go = async (answer?: MergeAnswer) =>
            joinWithRecoveryCode(d.engine, {
              session: await c.w.server.session(EMAIL),
              recoveryCode: code,
              deviceName: d.name,
              email: EMAIL,
              ...(answer ? { answer } : {}),
            });
          const plan = await go().catch(async (e: unknown) => {
            if (e instanceof MergeBlocked) return go(all(e));
            throw e;
          });
          joined = await commitJoin(plan);
          break;
        } catch (e) {
          joined = `refused ${(e as { code?: string }).code ?? e}`;
        }
      }
      c.log.push(`${d.name} tear (${kind}): off, join ${joined}`);
      if (joined !== "enrolled") throw new Error(`${d.name}: the rejoin did not enrol (${joined})`);
      await d.engine.round();
      await c.oracle.foldDevice(d, vk);
      return true;
    }
    let out: string;
    if (kind === "orphan_push_409") {
      // locked, the orphan's push answered 409: another device writes between the status and the PUT; the orphan stays
      // (merge-only from now on) until a context with the key folds it
      const others = c.w.devices.filter((x) => x !== d && !c.locked.has(x));
      const mine = ((await d.local.identity.get()) as { deviceId: string }).deviceId;
      const signer = (req: { headers: Readonly<Record<string, string>> }) =>
        Object.entries(req.headers).find(([k]) => k.toLowerCase() === "sixkey-device")?.[1];
      let moved = "no hook";
      if (others.length) {
        const o = pick(c.rnd, others);
        o.net.partition(false).clearRules(); // the other device's write must land first (that is the case)
        c.w.server.fault({
          match: (key, req) => key === "PUT /v1/vault" && signer(req) === mine && moved === "no hook",
          kind: "hook",
          count: 1,
          fn: async () => {
            await add(c, o, "before-orphan-push");
            moved = `other ${(await o.engine.round()).status}`;
            await c.oracle.foldDevice(o, vk);
          },
        });
      }
      const r1 = await d.engine.push();
      c.w.server.clearFaults();
      out = `push ${r1.status} (${moved}, orphan kept: ${d.disk.kv.data.get(SYNC_KEYS.orphan) ? "yes" : "no"})`;
      if (moved === "other ok" && !d.disk.kv.data.get(SYNC_KEYS.orphan) && r1.uploaded)
        throw new Error(`${d.name}: the orphan's push over a moved head was taken`);
    } else if (kind === "lock_every_time")
      out = `worker ${c.rnd() < 0.5 ? (await d.engine.push()).status : (await d.engine.round()).status}`;
    else if (kind === "popup_first") {
      await d.svc.status().catch(() => undefined);
      out = `popup, round ${(await d.engine.round()).status}`;
    } else if (kind === "edit_after") {
      await d.svc.status().catch(() => undefined); // the popup's open recovers (the orphan kept)
      await add(c, d, "after-tear"); // a local edit before any round: no outbox (lastSynced is null), the orphan untouched
      out = `edit after, round ${(await d.engine.round()).status}`;
    } else if (kind === "double_tear") {
      d.net.inject({ kind: "fail_before", match: "PUT /v1/vault" });
      const r1 = await d.engine.round(); // the fold commits locally; the upload fails: the orphan is not retired
      await c.oracle.foldDevice(d, vk);
      tearIt(); // the fold's generation torn too
      out = `round ${r1.status}, torn again, round ${(await d.engine.round()).status}`;
    } else {
      const r1 = await d.engine.round();
      if (r1.status === "review_needed" && r1.blocked && c.rnd() < 0.7) {
        await d.engine.round({
          answer: {
            seen: r1.blocked.seen,
            accept: [...r1.blocked.report.secretChanged, ...r1.blocked.report.purgedAlive],
          },
        });
      }
      out = `round ${r1.status}`;
    }
    c.log.push(`${d.name} tear (${kind}): ${out}`);
    await c.oracle.foldDevice(d, vk);
    return true;
  }
  if (c.families.has("hook") && x < 0.18) {
    if (c.locked.has(d)) return true;
    const others = c.w.devices.filter((o) => o !== d && !c.locked.has(o));
    const kind = pick(c.rnd, ["edit_here", "other_writes", "popup_here"] as const);
    const signer = (req: { headers: Readonly<Record<string, string>> }) =>
      Object.entries(req.headers).find(([k]) => k.toLowerCase() === "sixkey-device")?.[1];
    const mine = ((await d.local.identity.get()) as { deviceId: string }).deviceId;
    let fired = false;
    c.w.server.fault({
      match: (key, req) => key === "PUT /v1/vault" && signer(req) === mine && !fired,
      kind: "hook",
      count: 1,
      fn: async () => {
        fired = true;
        if (kind === "edit_here") await add(c, d, "during-put");
        else if (kind === "other_writes" && others.length) {
          const o = pick(c.rnd, others);
          await add(c, o, "race");
          await o.engine.round();
          await c.oracle.foldDevice(o, vk);
        } else if (kind === "popup_here") {
          await contextOver({
            ...d.disk,
            lock: d.lock,
            identityLock: d.identityLock,
            syncLock: d.syncLock,
            transport: d.net,
            clock: d.now,
          })
            .svc.status()
            .catch(() => undefined);
        }
      },
    });
    await add(c, d, "before-hook");
    const r = await d.engine.round();
    c.w.server.clearFaults();
    c.log.push(`${d.name} hook ${kind} fired=${fired} round ${r.status}`);
    await c.oracle.foldDevice(d, vk);
    return true;
  }
  if (c.families.has("pw") && x < 0.21) {
    if (c.locked.has(d)) return true;
    const cur = c.passwords[c.passwords.length - 1]!;
    const next = `${cur}!${Math.floor(c.rnd() * 100)}`;
    if (c.rnd() < 0.3) d.net.inject({ kind: "lose_response", match: "PUT /v1/keys" });
    try {
      await changePassword(d.engine, cur, next);
      c.log.push(`${d.name} password changed`);
    } catch (e) {
      c.log.push(`${d.name} password change: ${(e as { code?: string }).code ?? e}`);
    }
    c.passwords.push(next); // either may be in effect now: the settle tries every one
    return true;
  }
  return false;
}

export async function step(c: Ctx): Promise<void> {
  const d = pick(c.rnd, c.w.devices);
  const x = c.rnd();
  if (c.families.size && (await familyStep(c, d, x))) return;
  if (x < 0.34) return edit(c, d);
  if (x < 0.6) return round(c, d);
  if (x < 0.64) {
    if (c.locked.has(d)) {
      await unlockAny(c, d);
      c.locked.delete(d);
      c.log.push(`${d.name} unlock`);
    } else {
      await d.lockNow();
      c.locked.add(d);
      c.log.push(`${d.name} lock`);
    }
    return;
  }
  if (x < 0.68) {
    const on = c.rnd() < 0.5;
    d.net.partition(on);
    c.log.push(`${d.name} partition ${on}`);
    return;
  }
  if (x < 0.74) {
    const kind = pick(c.rnd, ["lose_response", "fail_before", "duplicate", "late"] as const);
    d.net.inject({ kind, ...(c.rnd() < 0.5 ? { match: "PUT /v1/vault" } : {}) });
    c.log.push(`${d.name} fault ${kind}`);
    return;
  }
  if (x < 0.76) {
    for (const e of c.w.devices) await e.net.flushLate(c.rnd() < 0.5 ? "fifo" : "reverse");
    c.log.push("flush late");
    return;
  }
  if (x < 0.82) {
    const at = 1 + Math.floor(c.rnd() * 18);
    const mode = c.rnd() < 0.5 ? "before" : "after";
    await runDying(d, at, mode, (ctx) => ctx.engine.round());
    if (c.rnd() < 0.5) d.restartWorker();
    else {
      await d.restartBrowser();
      c.locked.add(d);
    }
    c.log.push(`${d.name} crash @${at} ${mode}`);
    return;
  }
  if (x < 0.84) {
    c.w.server.restart();
    c.log.push("server restart");
    return;
  }
  if (x < 0.87) {
    c.snaps.push(c.w.server.snapshot());
    c.log.push("snapshot");
    return;
  }
  if (x < 0.89 && c.snaps.length && !c.families.has("tear")) {
    c.w.server.restore(pick(c.rnd, c.snaps));
    c.log.push("server rollback");
    return;
  }
  if (x < 0.9 && !c.locked.has(d)) {
    try {
      await unlockAny(c, d);
      const h = await prepareRecoveryCode(d.engine, c.passwords[c.passwords.length - 1]!);
      await commitRecoveryCode(d.engine, h);
      c.codes.push(h.recoveryCode);
      c.w.code = h.recoveryCode;
      c.log.push(`${d.name} new code`);
    } catch (e) {
      c.log.push(`${d.name} new code failed ${(e as { code?: string }).code ?? e}`);
    }
    return;
  }
  c.w.advance(Math.floor(c.rnd() * 600_000));
  c.log.push("time");
}

export async function settle(c: Ctx): Promise<void> {
  for (const d of c.w.devices) {
    d.net.partition(false);
    await d.net.flushLate();
    await unlockAny(c, d); // every device, also one the idle limit locked meanwhile
  }
  c.locked.clear();
  // the adoption a device asks for (a key change elsewhere) is the user's: one recovery code or password typed
  for (let i = 0; i < 2; i++) {
    for (const d of c.w.devices) {
      const r = await d.engine.round({ explicit: true });
      if (process.env.SIXKEY_M3_TRACE)
        c.log.push(
          `settle ${d.name} ${r.status}/${r.keyStatus ?? "-"} ${r.error ?? ""} pulled=${r.pulled} up=${r.uploaded}`,
        );
      if (r.status === "needs_password" || r.keyStatus === "needs_new_password") {
        for (const pw of [...c.passwords].reverse()) {
          const a = await adoptWithSecret(d.engine, { password: pw }).catch(() => null);
          if (a && (a.kind === "adopted" || a.kind === "local")) break;
        }
      }
    }
  }
  await quiesce(c.w, 12);
}

function secretsOf(c: Ctx, vault: Vault): string[] {
  return [
    ...vault.entries.map((e) => e.secret).filter((s) => s.length > 0),
    ...c.passwords,
    ...c.codes,
    c.w.code,
    toB64(vk.raw),
  ];
}

/** One seeded run of `steps` random steps, then the settle and every check (throws with the last steps on a failure). */
export async function runModel(
  seed: number,
  steps: number,
  o: { onLog?: (c: Ctx) => void; families?: Family[]; watchProblems?: string[] } = {},
): Promise<Ctx> {
  const families = new Set(o.families ?? []);
  const b = await modelBase(families.size ? 4 : 3);
  const base = b.base;
  vk = b.vk;
  const w = cloneWorld(base);
  const watch = watchServer(w, () => vk);
  const c: Ctx = {
    w,
    rnd: prng(seed),
    oracle: new Oracle(),
    locked: new Set(),
    snaps: [],
    log: [],
    codes: [w.code],
    families,
    passwords: [w.password],
  };
  for (const d of w.devices) await c.oracle.foldDevice(d, vk);
  try {
    for (let i = 0; i < steps; i++) await step(c);
    await settle(c);
    await checkQuiet(w, vk, { oracle: c.oracle, label: `seed ${seed}` });
    if (watch.problems.length && process.env.SIXKEY_M3_TRACE) console.log(watch.problems.join("\n"));
    if (o.watchProblems)
      o.watchProblems.push(...watch.problems); // the caller judges them (M3RR-13's replay)
    else expect(watch.problems, `seed ${seed}`).toEqual([]);
    // idempotent: one more round each sends nothing and commits nothing
    const puts = w.server.requests.filter((r) => r.op === "PUT /v1/vault").length;
    const gens = await Promise.all(w.devices.map(async (d) => cj(await d.generation())));
    for (const d of w.devices) await d.engine.round({ explicit: true });
    expect(w.server.requests.filter((r) => r.op === "PUT /v1/vault").length, `seed ${seed}: quiet`).toBe(puts);
    expect(await Promise.all(w.devices.map(async (d) => cj(await d.generation()))), `seed ${seed}: no commit`).toEqual(
      gens,
    );
    // nothing secret anywhere observable
    const secrets = secretsOf(c, c.oracle.vault!);
    const observable = JSON.stringify([
      w.devices.map((d) => [d.diag, d.disk.kv.data.get(SYNC_KEYS.state), d.disk.kv.data.get(SYNC_KEYS.cfg)]),
      w.server.requests,
      w.server.violations,
      w.server.bugs,
    ]);
    for (const s of secrets) expect(observable.includes(s), `seed ${seed}: a secret leaked`).toBe(false);
    expect(w.server.violations, `seed ${seed}`).toEqual([]);
    expect(w.server.bugs, `seed ${seed}`).toEqual([]);
    if (process.env.SIXKEY_M3_STATS) {
      const count = (re: RegExp) => c.log.filter((l) => re.test(l)).length;
      console.log(
        `seed ${seed}: edits ${count(/ (add|rename|move|group|delete|restore|purge|hotp)$/)} rounds ${count(/round/)} crashes ${count(/crash/)} faults ${count(/fault/)} rollbacks ${count(/rollback/)} codes ${count(/new code$/)} tears ${count(/ tear \(/)} (${["lock_every_time", "unlocked", "popup_first", "edit_after", "double_tear", "server_moved", "purge", "cloud_restore", "turn_off_rejoin", "revoked_rejoin", "orphan_push_409", "lost_pointer", "elsewhere_then_push", "save_during_push", "second_tear"].map((k) => `${k} ${count(new RegExp(` tear \\(${k}\\)`))}`).join(", ")}) hooks ${count(/ hook .* fired=true/)} pw ${count(/ password change/)} puts ${w.server.requests.filter((r) => r.op === "PUT /v1/vault" && r.status === 200).length} 409s ${w.server.requests.filter((r) => r.status === 409).length} entries ${c.oracle.vault!.entries.length}`,
      );
    }
  } catch (e) {
    if (process.env.SIXKEY_M3_STACK) console.log((e as Error).stack);
    if (process.env.SIXKEY_M3_TRACE) {
      console.log(c.log.join("\n"));
      for (const d of w.devices)
        console.log(
          d.name,
          JSON.stringify((await d.engine.view()).state),
          JSON.stringify((await d.engine.view()).lastSynced),
          (await d.generation()).envelope.checksum,
        );
      console.log("server", w.server.account().vault!.version, w.server.account().vault!.head);
      for (const d of w.devices) console.log(d.name, "net", JSON.stringify(d.net.log.slice(-12)));
      console.log("server requests", JSON.stringify(w.server.requests.slice(-30)));
    }
    throw new Error(`seed ${seed} failed after: ${c.log.slice(-25).join(" | ")}\n${(e as Error).message}`);
  }
  return c;
}
