// M1: the §3.9 adoption rules and the §3.14 gate as pure decisions: exhaustive tables over their facts, the N27 kver
// model, and a fast-check model of hostile sequences. The crypto that gathers the facts, and sequences through the real
// evaluateSameVkBundle / unlockWithSync, are in sync-crypto-adoption-crypto.test.ts.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Keyring } from "../../src/core/crypto/keyring";
import {
  allowedWhileKeysBehind,
  classifyKver,
  classifyServerVk,
  decideRemoteUnlock,
  decideSameVk,
  noteAfterLocalUnlock,
  pinAfterUnlock,
  previousCovers,
  publishesBundle,
  sameVkVerdict,
  unlockOrder,
  type KverClass,
  type RemoteUnlockFacts,
  type SameVkFacts,
  type SensitiveOp,
} from "../../src/core/sync/crypto/adoption";
import { SYNC_CONSTANTS } from "../../src/core/sync/crypto/constants";
import { publishKver, sameKeyring } from "../../src/core/sync/crypto/keybundle";

const J = SYNC_CONSTANTS.KVER_MAX_JUMP;
const MAX = Number.MAX_SAFE_INTEGER;
const bools = [true, false];
const OUTCOMES: KverClass["outcome"][] = ["adopt_candidate", "in_sync", "keys_behind"];

describe("R1 with the R0 jump cap: classifyKver (N27, F-01)", () => {
  it("exhaustive over kver vs maxSeenKver, both sides of the cap, and same/different content", () => {
    for (const maxSeen of [0, 1, 2, 3, 6, 1000]) {
      for (const kver of [1, 2, 3, 4, 7, 8, maxSeen + 1, maxSeen + J, maxSeen + J + 1, 70000, MAX]) {
        for (const same of bools) {
          const k = classifyKver(kver, maxSeen, same);
          const newer = kver > maxSeen && (maxSeen === 0 || kver <= maxSeen + J);
          if (newer && same) expect(k, `${kver}/${maxSeen}`).toEqual({ outcome: "in_sync", maxSeenAfter: kver });
          else if (newer)
            expect(k, `${kver}/${maxSeen}`).toEqual({ outcome: "adopt_candidate", maxSeenAfterAdoption: kver });
          else if (same) expect(k, `${kver}/${maxSeen}`).toEqual({ outcome: "in_sync", maxSeenAfter: maxSeen });
          else expect(k, `${kver}/${maxSeen}`).toEqual({ outcome: "keys_behind", maxSeenAfter: maxSeen });
        }
      }
    }
    // the three revision-7 adoption vectors
    expect(classifyKver(65540, 3, true)).toEqual({ outcome: "in_sync", maxSeenAfter: 3 });
    expect(classifyKver(65540, 3, false)).toEqual({ outcome: "keys_behind", maxSeenAfter: 3 });
    expect(classifyKver(70000, 0, false)).toEqual({ outcome: "adopt_candidate", maxSeenAfterAdoption: 70000 });
  });
  it("never lowers maxSeenKver, never offers to adopt at or below it, and never raises it by more than the cap (unless it was 0)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX }),
        fc.integer({ min: 0, max: 1e15 }),
        fc.boolean(),
        (kver, maxSeen, same) => {
          const k = classifyKver(kver, maxSeen, same);
          const after = k.outcome === "adopt_candidate" ? k.maxSeenAfterAdoption : k.maxSeenAfter;
          return (
            after >= maxSeen &&
            (k.outcome !== "adopt_candidate" || kver > maxSeen) &&
            (maxSeen === 0 || after - maxSeen <= J)
          );
        },
      ),
    );
  });
  it("publishKver = min(max(server, maxSeen) + 1, server + KVER_MAX_JUMP): above the server, within its bound, kver_overflow at the top", () => {
    fc.assert(
      fc.property(fc.nat({ max: 1e15 }), fc.nat({ max: 1e15 }), (s, m) => {
        const p = publishKver(s, m);
        return p === Math.min(Math.max(s, m) + 1, s + J) && p > s && p <= s + J && (m - s >= J || p > m);
      }),
    );
    expect([publishKver(3, 6), publishKver(5, 100000), publishKver(3, MAX), publishKver(MAX - 1, 0)]).toEqual([
      7,
      65541,
      3 + J,
      MAX,
    ]);
    expect(() => publishKver(MAX, 0)).toThrow(expect.objectContaining({ code: "kver_overflow" }));
    expect(() => publishKver(MAX, MAX)).toThrow(expect.objectContaining({ code: "kver_overflow" }));
    expect(() => publishKver(-1, 0)).toThrow();
    expect(() => publishKver(1.5, 0)).toThrow();
    expect(() => classifyKver(0, 0, true)).toThrow();
  });
});

describe("P3: previousCovers (F-02, S-5: list order, no exception for the same VK)", () => {
  const ref = (vkId: string) => ({ vkId });
  const ids = (n: number, prefix = "r") => new Set(Array.from({ length: n }, (_, i) => `${prefix}${i}`));
  const local = [ref("a"), ref("b"), ref("c")]; // list order = age order: a is the oldest
  const full = (keep: string[]) => new Set([...keep, ...ids(64 - keep.length)]);
  it("same VK: every real local entry must be there, even when the new list has exactly 64", () => {
    expect(previousCovers(local, new Set(["a", "b", "c"]), true)).toBe(true);
    expect(previousCovers(local, new Set(["a", "b", "c", "d"]), true)).toBe(true);
    expect(previousCovers([], new Set(), true)).toBe(true);
    for (const keep of [["b", "c"], ["c"], []])
      expect(previousCovers(local, full(keep), true), keep.join()).toBe(false);
  });
  it("another VK: a list of exactly 64 may lack a leading run of the local list, of any length, and nothing else", () => {
    expect(previousCovers(local, new Set(["b", "c"]), false)).toBe(false); // 2 entries: no exception
    expect(previousCovers(local, full(["b", "c"]), false)).toBe(true); // a (oldest) dropped
    expect(previousCovers(local, full(["c"]), false)).toBe(true); // a, b dropped
    expect(previousCovers(local, full([]), false)).toBe(true); // all of them, by 64 newer ones
    expect(previousCovers(local, full(["a", "c"]), false)).toBe(false); // b is not in the leading run
    expect(previousCovers(local, full(["a", "b"]), false)).toBe(false); // the newest was dropped
    expect(previousCovers([ref("z"), ref("a")], full(["a"]), false)).toBe(true); // order is the list's, not alphabetical or by time
    expect(previousCovers([ref("z"), ref("a")], full(["z"]), false)).toBe(false);
    expect(previousCovers(local, new Set([...ids(65)]), false)).toBe(false); // 65 is not "exactly 64"
  });
  it("property: same VK = superset; other VK = superset, or 64 present and the missing ones a leading run in list order", () => {
    const arb = fc.uniqueArray(
      fc.integer({ min: 0, max: 0xffff }).map((n) => ({ vkId: n.toString(16).padStart(4, "0") })),
      { selector: (r) => r.vkId, maxLength: 8 },
    );
    fc.assert(
      fc.property(
        arb,
        fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
        fc.boolean(),
        fc.boolean(),
        (lst, keepMask, pad, sameVk) => {
          const remote = new Set(lst.filter((_, i) => keepMask[i]).map((r) => r.vkId));
          if (pad) for (let i = 0; remote.size < 64; i++) remote.add(`pad${i}`);
          const missing = lst.map((r) => !remote.has(r.vkId));
          const k = missing.indexOf(false);
          const expected =
            !missing.includes(true) ||
            (!sameVk && remote.size === 64 && (k === -1 || missing.slice(k).every((m) => !m)));
          return previousCovers(lst, remote, sameVk) === expected;
        },
      ),
    );
  });
});

describe("R2: decideSameVk and sameVkVerdict (R0 first, F-07 in sync)", () => {
  it("decideSameVk: exhaustive table", () => {
    for (const macValid of bools)
      for (const covers of bools)
        for (const pwSame of bools)
          for (const authSame of [true, false, null]) {
            const f: SameVkFacts = { macValid, previousCovers: covers, passwordWrapSame: pwSame, authSame };
            const d = decideSameVk(f);
            const want = !macValid
              ? { kind: "reject", reason: "bad_mac" }
              : !covers
                ? { kind: "reject", reason: "previous_dropped" }
                : pwSame && authSame === false
                  ? { kind: "reject", reason: "auth_without_password" }
                  : pwSame
                    ? { kind: "adopt" }
                    : { kind: "needs_new_password" };
            expect(d, JSON.stringify(f)).toEqual(want);
            if (d.kind === "adopt") expect(pwSame).toBe(true); // a proven password wrap is never dropped without proof of the replacement
          }
  });
  it("sameVkVerdict: vaultId and MAC before any classification; an auth-only change in sync is refused", () => {
    for (const vaultOk of bools)
      for (const macValid of bools)
        for (const same of bools)
          for (const authSame of [true, false, null])
            for (const kver of [2, 5, 2 + J + 1]) {
              const v = sameVkVerdict({
                vaultOk,
                macValid,
                bundleKver: kver,
                maxSeenKver: 2,
                sameKeyring: same,
                previousCovers: true,
                passwordWrapSame: same,
                authSame,
                adoptedBack: false,
              });
              const k = classifyKver(kver, 2, same);
              const want = !vaultOk
                ? { kind: "reject", reason: "wrong_vault" }
                : !macValid
                  ? { kind: "reject", reason: "bad_mac" }
                  : k.outcome === "in_sync" && authSame === false
                    ? { kind: "reject", reason: "auth_without_password" }
                    : k.outcome === "in_sync" || k.outcome === "keys_behind"
                      ? { kind: k.outcome, maxSeenKver: k.maxSeenAfter }
                      : { kind: "needs_new_password", maxSeenKverOnAdoption: kver }; // different keyring here also means a different password wrap
              expect(v, JSON.stringify({ vaultOk, macValid, same, authSame, kver })).toEqual(want);
            }
  });
  it("sameVkVerdict with adoptedBack (GM2-5, M2R-12 R31): exhaustive; the bundle this device last committed counts as the same content, it is adopted back only when the local keyring differs (the steady state, bundle = local = adopted, stays in sync), and the history check still holds", () => {
    let adopts = 0;
    for (const adoptedBack of bools)
      for (const vaultOk of bools)
        for (const macValid of bools)
          for (const same of bools)
            for (const covers of bools)
              for (const authSame of [true, false, null])
                for (const kver of [1, 2, 5, 2 + J + 1]) {
                  const v = sameVkVerdict({
                    vaultOk,
                    macValid,
                    bundleKver: kver,
                    maxSeenKver: 2,
                    sameKeyring: same,
                    previousCovers: covers,
                    passwordWrapSame: same,
                    authSame,
                    adoptedBack,
                  });
                  const k = classifyKver(kver, 2, same || adoptedBack);
                  const want = !vaultOk
                    ? { kind: "reject", reason: "wrong_vault" }
                    : !macValid
                      ? { kind: "reject", reason: "bad_mac" }
                      : k.outcome === "in_sync" && authSame === false
                        ? { kind: "reject", reason: "auth_without_password" }
                        : adoptedBack && !same
                          ? !covers
                            ? { kind: "reject", reason: "previous_dropped" }
                            : {
                                kind: "adopt",
                                maxSeenKver: k.outcome === "adopt_candidate" ? k.maxSeenAfterAdoption : k.maxSeenAfter,
                              }
                          : k.outcome === "in_sync" || k.outcome === "keys_behind"
                            ? { kind: k.outcome, maxSeenKver: k.maxSeenAfter }
                            : !covers
                              ? { kind: "reject", reason: "previous_dropped" }
                              : { kind: "needs_new_password", maxSeenKverOnAdoption: kver };
                  expect(v, JSON.stringify({ adoptedBack, vaultOk, macValid, same, covers, authSame, kver })).toEqual(
                    want,
                  );
                  if (same && v.kind === "adopt") throw new Error("adopted the keyring it already has");
                  if (v.kind === "adopt") adopts++;
                }
    expect(adopts).toBeGreaterThan(0);
  });
});

describe("R3: decideRemoteUnlock and the local-unlock note", () => {
  it("exhaustive: every rule before the confirmation question; adoption needs all of them", () => {
    let n = 0;
    for (const vaultOk of bools)
      for (const macValid of bools)
        for (const kver of OUTCOMES)
          for (const confirmedOlder of bools)
            for (const vkIsPinned of bools)
              for (const reachesPinned of bools)
                for (const reachesLocal of bools)
                  for (const covers of bools)
                    for (const authOk of bools) {
                      const f: RemoteUnlockFacts = {
                        vaultOk,
                        macValid,
                        kver,
                        confirmedOlder,
                        vkIsPinned,
                        reachesPinned,
                        reachesLocal,
                        previousCovers: covers,
                        authOk,
                      };
                      const d = decideRemoteUnlock(f);
                      const want = !vaultOk
                        ? { kind: "reject", reason: "wrong_vault" }
                        : !macValid
                          ? { kind: "reject", reason: "bad_mac" }
                          : !vkIsPinned && !reachesPinned
                            ? { kind: "reject", reason: "discontinuous" }
                            : !reachesLocal
                              ? { kind: "reject", reason: "discontinuous" } // M2 (GM2-5): the local data must be reachable
                              : !covers
                                ? { kind: "reject", reason: "previous_dropped" }
                                : !authOk
                                  ? { kind: "reject", reason: "auth_without_password" }
                                  : kver === "keys_behind" && !confirmedOlder
                                    ? { kind: "confirm_older" }
                                    : { kind: "adopt", sameVk: vkIsPinned };
                      expect(d, JSON.stringify(f)).toEqual(want);
                      if (d.kind === "adopt")
                        expect(
                          vaultOk &&
                            macValid &&
                            (vkIsPinned || reachesPinned) &&
                            covers &&
                            authOk &&
                            (kver !== "keys_behind" || confirmedOlder),
                        ).toBe(true);
                      n++;
                    }
    expect(n).toBe(768); // M2 added reachesLocal to the facts: twice the combinations
  });
  it("note after a local unlock", () => {
    for (const macValid of bools)
      for (const kver of [...OUTCOMES, null])
        for (const pwSame of bools) {
          expect(noteAfterLocalUnlock({ remote: "none", macValid, kver, passwordWrapSame: pwSame })).toBe("none");
          expect(noteAfterLocalUnlock({ remote: "other_vk", macValid, kver, passwordWrapSame: pwSame })).toBe(
            "remote_rotated",
          );
          expect(noteAfterLocalUnlock({ remote: "older_vk", macValid, kver, passwordWrapSame: pwSame })).toBe(
            "server_older_key",
          );
          const same = noteAfterLocalUnlock({ remote: "same_vk", macValid, kver, passwordWrapSame: pwSame });
          expect(same).toBe(
            !macValid
              ? "none"
              : kver === "keys_behind"
                ? "keys_behind"
                : kver === "adopt_candidate" && !pwSame
                  ? "enter_new_password"
                  : "none",
          );
        }
  });
  it("R4 order, D8 pin repair, and the server vk_id classification", () => {
    expect(unlockOrder(false, true)).toEqual(["local", "remote"]);
    expect(unlockOrder(true, true)).toEqual(["remote", "local"]);
    expect(unlockOrder(true, false)).toEqual(["local"]);
    expect(pinAfterUnlock(null, "v2", new Set())).toBe("v2");
    expect(pinAfterUnlock("v2", "v2", new Set())).toBe("v2");
    expect(pinAfterUnlock("v1", "v2", new Set(["v1"]))).toBe("v2"); // keyring written, pin update lost
    expect(pinAfterUnlock("v2", "v1", new Set(["v0"]))).toBe("v2"); // local behind the pin: the pin stays
    expect(classifyServerVk("v2", "v2", new Set(["v1"]))).toBe("current");
    expect(classifyServerVk("v1", "v2", new Set(["v1"]))).toBe("older");
    expect(classifyServerVk("v3", "v2", new Set(["v1"]))).toBe("rotated");
  });
});

describe("§3.14 keys_behind gate", () => {
  const ALL: SensitiveOp[] = [
    "change_password",
    "change_recovery",
    "recovery_reset",
    "rotate",
    "repair",
    "respond",
    "approve",
    "revoke",
    "reject",
    "reject_all",
    "rename",
    "fork",
    "clear_history",
    "delete_account",
  ];
  it("only bundle-publishing and bundle-handing operations wait; repair and revocation never do", () => {
    const blocked = ALL.filter((op) => !allowedWhileKeysBehind(op));
    expect(blocked.sort()).toEqual(
      ["approve", "change_password", "change_recovery", "recovery_reset", "respond", "rotate"].sort(),
    );
    expect(allowedWhileKeysBehind("revoke")).toBe(true);
    expect(allowedWhileKeysBehind("repair")).toBe(true);
    expect(ALL.filter(publishesBundle).sort()).toEqual([
      "change_password",
      "change_recovery",
      "recovery_reset",
      "repair",
      "rotate",
    ]);
  });
});

// ---- N27 model: devices, a server that can roll back or replay, and the production R1 / publish rules -------------

type Kr = Keyring; // the model uses small stand-in objects; R1 compares them by canonicalJson like real keyrings
const kr = (tag: string): Kr =>
  ({
    format: "sixkey-keyring",
    v: 1,
    vaultId: "model-vault",
    vkId: "0000000000000000",
    wraps: [],
    previous: [],
    tag,
  }) as unknown as Kr;
type Dev = { local: Kr; maxSeen: number; status: "ok" | "keys_behind" };
type Server = { kver: number; keyring: Kr };

function sync(d: Dev, s: Server): void {
  const k = classifyKver(s.kver, d.maxSeen, sameKeyring(s.keyring, d.local));
  if (k.outcome === "adopt_candidate")
    Object.assign(d, { local: s.keyring, maxSeen: k.maxSeenAfterAdoption, status: "ok" });
  else Object.assign(d, { maxSeen: k.maxSeenAfter, status: k.outcome === "keys_behind" ? "keys_behind" : "ok" });
}
/** A publish (change or repair) as M4 accepts it: kver > if_kver, CAS on if_kver = the server kver the device just saw. */
function publish(d: Dev, s: Server, content: Kr): boolean {
  const kver = publishKver(s.kver, d.maxSeen);
  if (!(kver > s.kver)) return false;
  Object.assign(s, { kver, keyring: content });
  Object.assign(d, { local: content, maxSeen: kver, status: "ok" });
  return true;
}

describe("N27 model sequences ①–⑥", () => {
  it("① honest multi-step rollback 10 → 7: everyone is keys_behind, one repair at 11 brings everyone back", () => {
    const k10 = kr("k10");
    const devs: Dev[] = [0, 1, 2].map(() => ({ local: k10, maxSeen: 10, status: "ok" }));
    const s: Server = { kver: 7, keyring: kr("k7") };
    for (const d of devs) sync(d, s);
    expect(devs.map((d) => d.status)).toEqual(["keys_behind", "keys_behind", "keys_behind"]);
    expect(devs.every((d) => d.local === k10)).toBe(true); // nothing adopted
    expect(publish(devs[0]!, s, devs[0]!.local)).toBe(true);
    expect(s.kver).toBe(11);
    for (const d of devs) sync(d, s);
    expect(devs.map((d) => [d.status, d.maxSeen])).toEqual([
      ["ok", 11],
      ["ok", 11],
      ["ok", 11],
    ]);
  });
  it("② lagging publisher: A (saw 8) repairs at 9; B (saw 10) is not silently moved; B repairs at 11; A adopts", () => {
    const A: Dev = { local: kr("k8"), maxSeen: 8, status: "ok" };
    const B: Dev = { local: kr("k10"), maxSeen: 10, status: "ok" };
    const s: Server = { kver: 7, keyring: kr("k7") };
    sync(A, s);
    sync(B, s);
    expect([A.status, B.status]).toEqual(["keys_behind", "keys_behind"]);
    publish(A, s, A.local);
    expect(s.kver).toBe(9);
    sync(B, s);
    expect(B.status).toBe("keys_behind");
    expect(sameKeyring(B.local, kr("k10"))).toBe(true); // B keeps its own keyring
    publish(B, s, B.local);
    expect(s.kver).toBe(11);
    sync(A, s);
    expect([A.status, sameKeyring(A.local, kr("k10")), A.maxSeen]).toEqual(["ok", true, 11]);
    // A's recovery code from k8 is gone from the server: §3.6.0's pending-fingerprint check reports "did not take effect"
    expect(sameKeyring(s.keyring, kr("k8"))).toBe(false);
  });
  it("③ after the repair a malicious server replays a genuine old bundle: not adopted, keys_behind", () => {
    const d: Dev = { local: kr("k11"), maxSeen: 11, status: "ok" };
    sync(d, { kver: 7, keyring: kr("k7") });
    expect([d.status, sameKeyring(d.local, kr("k11")), d.maxSeen]).toEqual(["keys_behind", true, 11]);
    sync(d, { kver: 11, keyring: kr("k10-forged-same-kver") });
    expect(d.status).toBe("keys_behind"); // equal kver, different content: the old R1 adopted this silently
  });
  it("④ in keys_behind revocation goes through; changing the password and approving wait for the repair", () => {
    expect([
      allowedWhileKeysBehind("revoke"),
      allowedWhileKeysBehind("change_password"),
      allowedWhileKeysBehind("approve"),
    ]).toEqual([true, false, false]);
  });
  it("⑤ R3: a password that opens only the older server bundle needs an explicit confirmation", () => {
    const base = {
      vaultOk: true,
      macValid: true,
      vkIsPinned: true,
      reachesPinned: false,
      reachesLocal: true,
      previousCovers: true,
      authOk: true,
    };
    expect(decideRemoteUnlock({ ...base, kver: "keys_behind", confirmedOlder: false })).toEqual({
      kind: "confirm_older",
    });
    expect(decideRemoteUnlock({ ...base, kver: "keys_behind", confirmedOlder: true })).toEqual({
      kind: "adopt",
      sameVk: true,
    });
  });
  it("⑥ identity restored with maxSeenKver = 0: a server ahead is adopted, not reported as keys_behind", () => {
    const d: Dev = { local: kr("k10"), maxSeen: 0, status: "ok" };
    sync(d, { kver: 12, keyring: kr("k12") });
    expect([d.status, sameKeyring(d.local, kr("k12")), d.maxSeen]).toEqual(["ok", true, 12]);
    const e: Dev = { local: kr("k12"), maxSeen: 0, status: "ok" };
    sync(e, { kver: 12, keyring: kr("k12") });
    expect([e.status, e.maxSeen]).toEqual(["ok", 12]);
  });
  it("fast-check: random publishes, rollbacks, replays and identity restores never adopt silently, never lower maxSeenKver, and always settle after one repair", () => {
    const op = fc.oneof(
      fc.record({ t: fc.constant("publish" as const), d: fc.nat({ max: 2 }) }),
      fc.record({ t: fc.constant("rollback" as const), back: fc.nat({ max: 8 }) }),
      fc.record({ t: fc.constant("sync" as const), d: fc.nat({ max: 2 }) }),
      fc.record({ t: fc.constant("restore" as const), d: fc.nat({ max: 2 }) }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
        const s: Server = { kver: 1, keyring: kr("g0") };
        const history: Server[] = [{ ...s }];
        const devs: Dev[] = [0, 1, 2].map(() => ({ local: s.keyring, maxSeen: 1, status: "ok" }));
        let fresh = 0;
        for (const o of ops) {
          if (o.t === "publish") {
            const d = devs[o.d]!;
            sync(d, s);
            if (d.status === "ok" && publish(d, s, kr(`g${++fresh}`))) history.push({ ...s });
          } else if (o.t === "rollback") {
            Object.assign(s, history[Math.max(0, history.length - 1 - o.back)]!); // PITR or a replayed genuine bundle
          } else if (o.t === "sync") {
            const d = devs[o.d]!;
            const before = { ...d };
            sync(d, s);
            if (d.maxSeen < before.maxSeen) return false;
            if (d.local !== before.local && !(s.kver > before.maxSeen)) return false; // adopted at or below maxSeenKver
          } else devs[o.d]!.maxSeen = 0; // identity restored from its copy (§2.5)
        }
        // settle: a device in keys_behind repairs, everyone syncs, repeat; nobody may stay stuck (at most one repair per device)
        for (let round = 0; round <= devs.length; round++) {
          for (const d of devs) sync(d, s);
          const stuck = devs.find((d) => d.status === "keys_behind");
          if (!stuck) break;
          publish(stuck, s, stuck.local);
        }
        return devs.every((d) => d.status === "ok" && sameKeyring(d.local, s.keyring));
      }),
      { numRuns: 300 },
    );
  });
});

// ---- §8.1 adoption invariants over arbitrary sequences of hostile bundles (fact level) ------------------------------
// A fact-level device runs the production deciders (sameVkVerdict, classifyServerVk, unlockOrder, classifyKver,
// decideRemoteUnlock, pinAfterUnlock, previousCovers) against a server that publishes honestly, rolls back and forges.
// sync-crypto-adoption-crypto.test.ts runs the same kind of sequence through the real bundle-eval functions.

type AWrap = { id: string; pw: string | null }; // the password that opens this wrap; null: garbage nothing opens
type APrev = { vkId: string; real: boolean }; // real: it unwraps under its keyring's VK
type AKr = { vault: string; vk: string; pw: AWrap; rec: string; prev: APrev[] };
type AB = { kr: AKr; kver: number; auth: string; mac: boolean };
type Forge =
  | "old_vk"
  | "garbage_pw"
  | "drop_prev"
  | "garbage_prev"
  | "extra_garbage_prev"
  | "auth_only"
  | "bad_mac"
  | "forward_vk"
  | "wrong_vault"
  | "huge_kver";
type AOp =
  | { t: "rotate" | "password" | "recovery" | "sync" | "lose_local" }
  | { t: "serve"; back: number }
  | { t: "forge"; kind: Forge; kver: number; knowsPw: boolean }
  | { t: "unlock"; pw: number; confirm: boolean; crash: boolean };

const realIds = (kr: AKr) => new Set(kr.prev.filter((p) => p.real).map((p) => p.vkId));
const realRefs = (kr: AKr) => kr.prev.filter((p) => p.real);
const sameAKr = (a: AKr, b: AKr) => sameKeyring(a as unknown as Keyring, b as unknown as Keyring);
const FORGES: Forge[] = [
  "old_vk",
  "garbage_pw",
  "drop_prev",
  "garbage_prev",
  "extra_garbage_prev",
  "auth_only",
  "bad_mac",
  "forward_vk",
  "wrong_vault",
  "huge_kver",
];

const aop: fc.Arbitrary<AOp> = fc.oneof(
  fc.constantFrom<AOp>(
    { t: "rotate" },
    { t: "password" },
    { t: "recovery" },
    { t: "sync" },
    { t: "sync" },
    { t: "lose_local" },
  ),
  fc.record({ t: fc.constant("serve" as const), back: fc.nat({ max: 6 }) }),
  fc.record({
    t: fc.constant("forge" as const),
    kind: fc.constantFrom<Forge>(...FORGES),
    kver: fc.integer({ min: 1, max: 60 }),
    knowsPw: fc.boolean(),
  }),
  fc.record({ t: fc.constant("unlock" as const), pw: fc.nat({ max: 5 }), confirm: fc.boolean(), crash: fc.boolean() }),
);

describe("§8.1 adoption invariants (fast-check over hostile sequences, fact level)", () => {
  it("no lock-out from a proven password, no lost history VK, never back to an older VK (also with local data lost), D8 repairs the pin, forged bundles never move maxSeenKver", () => {
    fc.assert(
      fc.property(fc.array(aop, { maxLength: 30 }), (ops) => {
        let seq = 0;
        const id = (p: string) => `${p}${++seq}`;
        const rank = new Map<string, number>([["V1", 1]]);
        const passwords = ["pw1"];
        let honest: AB = {
          kr: { vault: "vault-A", vk: "V1", pw: { id: "w0", pw: "pw1" }, rec: "r0", prev: [] },
          kver: 1,
          auth: "a0",
          mac: true,
        };
        const history: AB[] = [honest];
        let shown = honest;
        let shownForged = false;
        const dev = {
          pin: "V1",
          local: honest.kr as AKr | null,
          adopted: { kr: honest.kr, auth: honest.auth },
          maxSeen: 1,
          needsPassword: false,
          held: new Set(["V1"]),
        };
        const hold = (kr: AKr) => [kr.vk, ...realIds(kr)].forEach((x) => dev.held.add(x));
        const adopt = (b: AB, maxSeen: number) =>
          Object.assign(dev, { local: b.kr, adopted: { kr: b.kr, auth: b.auth }, maxSeen });
        const publish = (kr: AKr, auth = honest.auth) => {
          honest = { kr, kver: honest.kver + 1, auth, mac: true };
          history.push(honest);
          shown = honest;
          shownForged = false;
        };
        for (const o of ops) {
          const pinBefore = dev.pin;
          const pwBefore = dev.local?.pw.id;
          const maxSeenBefore = dev.maxSeen;
          let provedWith: string | null = null;
          let openedLocal = false;
          switch (o.t) {
            case "rotate": {
              const vk = `V${rank.size + 1}`;
              rank.set(vk, rank.size + 1);
              publish(
                {
                  vault: "vault-A",
                  vk,
                  pw: { id: id("w"), pw: passwords.at(-1)! },
                  rec: id("r"),
                  prev: [...realRefs(honest.kr), { vkId: honest.kr.vk, real: true }],
                },
                id("a"),
              );
              break;
            }
            case "password":
              passwords.push(id("pw"));
              publish({ ...honest.kr, pw: { id: id("w"), pw: passwords.at(-1)! } }, id("a"));
              break;
            case "recovery":
              publish({ ...honest.kr, rec: id("r") });
              break;
            case "serve":
              shown = history[Math.max(0, history.length - 1 - o.back)]!; // rollback, or a genuine old bundle replayed
              shownForged = false;
              break;
            case "forge": {
              const kr = honest.kr;
              const old =
                [...rank.keys()].filter((v) => v.startsWith("V") && rank.get(v)! < rank.get(kr.vk)!).at(0) ?? kr.vk;
              const forged: Record<Forge, AB> = {
                old_vk: {
                  kr: {
                    vault: "vault-A",
                    vk: old,
                    pw: { id: id("w"), pw: o.knowsPw ? passwords[0]! : null },
                    rec: id("r"),
                    prev: [],
                  },
                  kver: o.kver,
                  auth: id("a"),
                  mac: true,
                },
                garbage_pw: { kr: { ...kr, pw: { id: id("w"), pw: null } }, kver: o.kver, auth: id("a"), mac: true },
                drop_prev: { kr: { ...kr, prev: kr.prev.slice(1) }, kver: o.kver, auth: honest.auth, mac: true },
                garbage_prev: {
                  kr: { ...kr, prev: kr.prev.map((p) => ({ ...p, real: false })) },
                  kver: o.kver,
                  auth: honest.auth,
                  mac: true,
                },
                extra_garbage_prev: {
                  kr: { ...kr, prev: [...kr.prev, { vkId: id("Z"), real: false }] },
                  kver: o.kver,
                  auth: honest.auth,
                  mac: true,
                },
                auth_only: { kr, kver: o.kver, auth: id("a"), mac: true },
                bad_mac: { kr: { ...kr, rec: id("r") }, kver: o.kver, auth: honest.auth, mac: false },
                forward_vk: {
                  kr: {
                    vault: "vault-A",
                    vk: id("F"),
                    pw: { id: id("w"), pw: o.knowsPw ? passwords.at(-1)! : null },
                    rec: id("r"),
                    prev: [...realRefs(kr), { vkId: kr.vk, real: true }],
                  },
                  kver: o.kver,
                  auth: id("a"),
                  mac: true,
                },
                wrong_vault: { kr: { ...kr, vault: "vault-EVIL" }, kver: o.kver, auth: honest.auth, mac: true },
                huge_kver: { kr, kver: dev.maxSeen + J + o.kver, auth: honest.auth, mac: true }, // same content, beyond the cap
              };
              shown = forged[o.kind];
              // refused (or, garbage_pw, never adopted without proof); auth_only only counts against the device's own reference
              shownForged =
                ["bad_mac", "wrong_vault", "huge_kver", "garbage_pw"].includes(o.kind) ||
                (o.kind === "auth_only" && sameAKr(kr, dev.adopted.kr));
              if (o.kind === "forward_vk") rank.set(shown.kr.vk, rank.get(kr.vk)! + 0.5); // a current-VK holder may rotate forward
              break;
            }
            case "sync": {
              const local = dev.local;
              if (!local || dev.needsPassword) break;
              if (shown.kr.vk === local.vk) {
                const v = sameVkVerdict({
                  vaultOk: shown.kr.vault === "vault-A",
                  macValid: shown.mac,
                  bundleKver: shown.kver,
                  maxSeenKver: dev.maxSeen,
                  sameKeyring: sameAKr(shown.kr, local),
                  previousCovers: previousCovers(realRefs(local), realIds(shown.kr), true),
                  passwordWrapSame: shown.kr.pw.id === local.pw.id,
                  authSame: shown.auth === dev.adopted.auth,
                  adoptedBack: false,
                });
                if (v.kind === "adopt") {
                  adopt(shown, v.maxSeenKver);
                  hold(shown.kr);
                } else if (v.kind === "in_sync" || v.kind === "keys_behind") dev.maxSeen = v.maxSeenKver;
              } else if (classifyServerVk(shown.kr.vk, dev.pin, realIds(local)) === "rotated") dev.needsPassword = true;
              break;
            }
            case "lose_local":
              Object.assign(dev, { local: null, needsPassword: true, held: new Set<string>() });
              break;
            case "unlock": {
              const typed = passwords[o.pw % passwords.length]!; // the user may type any password it ever had
              // M2 (GM2-5): a pin that differs from the local keyring's VK tries the remote first, as unlockWithSync does
              for (const where of unlockOrder(
                dev.needsPassword || (dev.local !== null && dev.pin !== dev.local.vk),
                true,
              )) {
                if (where === "local") {
                  if (dev.local && dev.local.pw.pw === typed) {
                    dev.pin = pinAfterUnlock(dev.pin, dev.local.vk, realIds(dev.local));
                    openedLocal = true;
                    break;
                  }
                } else if (shown.kr.pw.pw === typed) {
                  const local = dev.local;
                  const vaultOk = shown.kr.vault === "vault-A";
                  if (!vaultOk || !shown.mac) continue; // R0: never classified
                  const keyringAsAdopted = local === null && sameAKr(dev.adopted.kr, shown.kr);
                  const same =
                    local !== null ? sameAKr(local, shown.kr) : keyringAsAdopted && dev.adopted.auth === shown.auth; // F-06 digest
                  const k = classifyKver(shown.kver, dev.maxSeen, same);
                  const sameVk = local !== null && local.vk === shown.kr.vk;
                  const pwSame = sameVk && local!.pw.id === shown.kr.pw.id;
                  const authSame = dev.adopted.auth === shown.auth;
                  const d = decideRemoteUnlock({
                    vaultOk,
                    macValid: shown.mac,
                    kver: k.outcome,
                    confirmedOlder: o.confirm,
                    vkIsPinned: shown.kr.vk === dev.pin,
                    reachesPinned: realIds(shown.kr).has(dev.pin),
                    reachesLocal: local === null || local.vk === shown.kr.vk || realIds(shown.kr).has(local.vk), // M2 (GM2-5)
                    previousCovers: previousCovers(local ? realRefs(local) : [], realIds(shown.kr), sameVk),
                    authOk: authSame || !(pwSame || k.outcome === "in_sync" || keyringAsAdopted),
                  });
                  if (d.kind === "adopt") {
                    adopt(shown, k.outcome === "adopt_candidate" ? k.maxSeenAfterAdoption : k.maxSeenAfter);
                    Object.assign(dev, { needsPassword: false, pin: o.crash ? dev.pin : shown.kr.vk });
                    hold(shown.kr);
                    provedWith = typed;
                    break;
                  }
                }
              }
              break;
            }
          }
          // I1: the local password wrap always opens with a password the user has, and only changes when just proven
          if (dev.local && (dev.local.pw.pw === null || !passwords.includes(dev.local.pw.pw))) return false;
          if (dev.local && pwBefore !== undefined && dev.local.pw.id !== pwBefore && provedWith !== dev.local.pw.pw)
            return false;
          // I2: every real VK held since the local data was last intact is still the current or a previous one
          if (dev.local) for (const v of dev.held) if (v !== dev.local.vk && !realIds(dev.local).has(v)) return false;
          // I3: never back to an older VK, local data or not; never into another vault
          if ((rank.get(dev.pin) ?? -1) < (rank.get(pinBefore) ?? -1)) return false;
          if (dev.local && dev.local.vault !== "vault-A") return false;
          // D8: after an unlock that opened the local keyring, a pin the keyring's previous list covers has moved forward
          if (openedLocal && dev.pin !== dev.local!.vk && realIds(dev.local!).has(dev.pin)) return false;
          // R0 / F-01: a forged bundle (bad MAC, other vault, auth-only, beyond the cap) never raises maxSeenKver
          if (shownForged && dev.maxSeen > maxSeenBefore) return false;
        }
        return true;
      }),
      { numRuns: 1000 },
    );
  });
});
