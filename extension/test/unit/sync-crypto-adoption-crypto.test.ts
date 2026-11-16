// M1: the adoption rules through the real bundle-eval functions on real keyrings (MACs, unwraps, digests), including the
// revision-7 cases (F-02 on the adopt and unlock paths, F-03, F-06, F-07, the kver cap, capPrevious, a multi-rotation
// catch-up) and the §8.1 requirement that some fact-level sequences run through evaluateSameVkBundle / unlockWithSync.
// Unlocks use recovery codes where they can: the rules are the same (R6) and HKDF is cheap, PBKDF2 at 600k is not.
import { beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { toB64 } from "../../src/core/crypto/bytes";
import { rekey, retirePreviousVk, setRecovery, unwrapPreviousVks, type Keyring } from "../../src/core/crypto/keyring";
import { generateVk, type Vk } from "../../src/core/crypto/vk";
import { classifyServerVk } from "../../src/core/sync/crypto/adoption";
import {
  evaluateSameVkBundle,
  openKeyring,
  unlockWithSync,
  type UnlockInput,
} from "../../src/core/sync/crypto/bundle-eval";
import { canonicalJsonStrict } from "../../src/core/sync/crypto/encoding";
import {
  adoptedRecord,
  capPrevious,
  newBundleAuth,
  publishKver,
  sameWrapBytes,
  truncateKeyringTimes,
  wrapOf,
  type KeyBundle,
} from "../../src/core/sync/crypto/keybundle";
import { P, P2, T0, VAULT, authFor, bundleOf, ctx, keyrings, pwSalt, type Fixture } from "../helpers/sync-keyrings";

let f: Fixture;
let k1: Keyring, v1: Vk, code1: string, k1b: Keyring, k2: Keyring, v2: Vk, code2: string;
const MAX = Number.MAX_SAFE_INTEGER;

beforeAll(async () => {
  f = await keyrings();
  ({ k1, v1, code1, k1b, k2, v2, code2 } = f);
  expect(truncateKeyringTimes(k1)).toEqual(k1); // T1: built at a whole hour, so truncation changes nothing
}, 30_000);

const same = (over: Partial<Parameters<typeof evaluateSameVkBundle>[0]> & { bundle: KeyBundle }) =>
  evaluateSameVkBundle({
    vk: v1,
    local: k1,
    maxSeenKver: 1,
    expectedVaultId: VAULT,
    adoptedAuth: authFor(k1),
    adoptedDigest: null,
    ...over,
  });
const unlock = (over: Partial<UnlockInput>) =>
  unlockWithSync({
    secret: { password: P },
    local: k1,
    remote: null,
    pinnedVkId: v1.id,
    maxSeenKver: 1,
    needsPassword: false,
    expectedVaultId: VAULT,
    adoptedAuth: authFor(k1),
    adoptedDigest: null,
    ...over,
  });
async function fresh64(base: Keyring, vk: Vk): Promise<Keyring> {
  let kr: Keyring = { ...base, previous: [] };
  for (let i = 0; i < 64; i++) kr = await retirePreviousVk(kr, await generateVk(), vk, ctx);
  return kr;
}

describe("evaluateSameVkBundle (R0 + R1 + R2)", () => {
  it("a changed recovery code is adopted; a changed password waits for the new password; a forged MAC is never classified", async () => {
    const rec = (await setRecovery(k1, v1, ctx)).keyring;
    expect(await same({ bundle: await bundleOf(v1, rec, 2) })).toEqual({ kind: "adopt", maxSeenKver: 2 });
    expect(await same({ bundle: await bundleOf(v1, k1b, 2) })).toEqual({
      kind: "needs_new_password",
      maxSeenKverOnAdoption: 2,
    });
    expect(await same({ bundle: { ...(await bundleOf(v1, rec, 99)), kver: 100 } })).toEqual({
      kind: "reject",
      reason: "bad_mac",
    });
    expect(await same({ bundle: await bundleOf(v1, k1, 1) })).toEqual({ kind: "in_sync", maxSeenKver: 1 });
  });
  it("previous entries with the right ids over garbage bytes count as dropped", async () => {
    const garbage: Keyring = {
      ...k2,
      previous: k2.previous.map((p) => ({ ...p, wrapped: toB64(new Uint8Array(48).fill(9)) })),
    };
    const rec = (await setRecovery(garbage, v2, ctx)).keyring;
    expect(await same({ bundle: await bundleOf(v2, rec, 5), vk: v2, local: k2, adoptedAuth: authFor(k2) })).toEqual({
      kind: "reject",
      reason: "previous_dropped",
    });
  });
  it("F-02 (adopt path, REPRO-4): 64 fresh VKs in place of the history are refused for the same VK", async () => {
    const kr = await fresh64(k2, v2);
    expect(
      await same({ bundle: await bundleOf(v2, kr, 5), vk: v2, local: k2, maxSeenKver: 2, adoptedAuth: authFor(k2) }),
    ).toEqual({ kind: "reject", reason: "previous_dropped" });
  }, 20_000);
  it("F-03: wraps copied verbatim into another vault are wrong_vault, never adopt", async () => {
    const evil: Keyring = { ...k1, vaultId: "evil-vault-0001" };
    expect(await same({ bundle: await bundleOf(v1, evil, 2, authFor(k1)) })).toEqual({
      kind: "reject",
      reason: "wrong_vault",
    });
    expect(await same({ bundle: await bundleOf(v1, k1, 2), expectedVaultId: "evil-vault-0001" })).toEqual({
      kind: "reject",
      reason: "wrong_vault",
    });
  });
  it("F-07 (REPRO-7): an auth-only change is refused in sync and in adoption; unknown adopted.auth (identity just restored) lets it through", async () => {
    const authOnly = await bundleOf(v1, k1, 2, newBundleAuth(pwSalt(k1)));
    expect(await same({ bundle: authOnly })).toEqual({ kind: "reject", reason: "auth_without_password" });
    expect(await same({ bundle: authOnly, adoptedAuth: null })).toEqual({ kind: "in_sync", maxSeenKver: 2 });
    const recNewAuth = await bundleOf(v1, (await setRecovery(k1, v1, ctx)).keyring, 2, newBundleAuth(pwSalt(k1)));
    expect(await same({ bundle: recNewAuth })).toEqual({ kind: "reject", reason: "auth_without_password" });
  });
  it("F-01 cap (K8 variants, REPRO-11): beyond KVER_MAX_JUMP a MAC-valid bundle is classified at or below maxSeenKver and cannot raise it", async () => {
    expect(await same({ bundle: await bundleOf(v1, k1, 10 ** 15), maxSeenKver: 3 })).toEqual({
      kind: "in_sync",
      maxSeenKver: 3,
    });
    expect(await same({ bundle: await bundleOf(v1, k1, MAX), maxSeenKver: 3 })).toEqual({
      kind: "in_sync",
      maxSeenKver: 3,
    }); // the burnt bundle
    expect(
      await same({ bundle: await bundleOf(v1, (await setRecovery(k1, v1, ctx)).keyring, 3 + 65537), maxSeenKver: 3 }),
    ).toEqual({ kind: "keys_behind", maxSeenKver: 3 });
    expect(await same({ bundle: await bundleOf(v1, k1, 3 + 65536), maxSeenKver: 3 })).toEqual({
      kind: "in_sync",
      maxSeenKver: 3 + 65536,
    });
    expect(await same({ bundle: { ...(await bundleOf(v1, k1, 2)), kver: 50 } })).toEqual({
      kind: "reject",
      reason: "bad_mac",
    }); // within the cap, unauthenticated
    expect(publishKver(3, 3)).toBe(4); // so after a burn attempt every device can still publish
    expect(() => publishKver(MAX, 0)).toThrow(expect.objectContaining({ code: "kver_overflow" }));
  }, 20_000);
});

describe("unlockWithSync (R0, R3, R4, R6, D8)", () => {
  it("the new password adopts a same-VK bundle whose password changed; the old one unlocks locally with the banner", async () => {
    const b = await bundleOf(v1, k1b, 2);
    expect(await unlock({ secret: { password: P2 }, remote: b })).toMatchObject({
      kind: "adopt",
      sameVk: true,
      pin: v1.id,
      maxSeenKver: 2,
    });
    expect(await unlock({ remote: b })).toMatchObject({ kind: "local", note: "enter_new_password", pin: v1.id });
    expect(await unlock({ secret: { password: "wrong password 123" }, remote: b })).toEqual({
      kind: "reject",
      reason: "wrong_secret",
    });
  }, 20_000);
  it("R4: in needs_password the rotated bundle is tried first, even though the local keyring opens with the same password", async () => {
    const r = await unlock({ remote: await bundleOf(v2, k2, 2), needsPassword: true });
    expect(r).toMatchObject({ kind: "adopt", sameVk: false, pin: v2.id });
    if (r.kind === "adopt") expect(r.previousVks.map((v) => v.id)).toContain(v1.id); // the old VK, to decrypt local data
    expect(await unlock({ remote: await bundleOf(v2, k2, 2) })).toMatchObject({
      kind: "local",
      note: "remote_rotated",
    });
  }, 20_000);
  it("an old VK cannot pull a device back (F7), not even with local data lost; a refused bundle never locks the user out", async () => {
    const forgedOld = await bundleOf(v1, k1, 99); // a revoked device still holding VK1
    const at = { remote: forgedOld, pinnedVkId: v2.id, maxSeenKver: 2, adoptedAuth: authFor(k2) };
    expect(await unlock({ ...at, local: null })).toEqual({ kind: "reject", reason: "discontinuous" });
    expect(await unlock({ ...at, local: k2, needsPassword: true })).toMatchObject({
      kind: "local",
      remoteRejected: "discontinuous",
      pin: v2.id,
    });
    expect(await unlock({ ...at, local: null, pinnedVkId: null, maxSeenKver: 0 })).toEqual({
      kind: "reject",
      reason: "no_reference",
    });
  }, 20_000);
  it("keys_behind: only the old password opens the older server bundle, so adopting it needs confirmation (N27 ⑤)", async () => {
    const i = { local: k1b, remote: await bundleOf(v1, k1, 1), maxSeenKver: 2, adoptedAuth: authFor(k1b) };
    expect(await unlock(i)).toEqual({ kind: "confirm_older" });
    expect(await unlock({ ...i, confirmedOlder: true })).toMatchObject({ kind: "adopt", sameVk: true, maxSeenKver: 2 });
  }, 20_000);
  it("D8: a keyring written before a crash moves the pin forward; R6: a recovery code unlocks like a password", async () => {
    expect(await unlock({ local: k2 })).toMatchObject({ kind: "local", pin: v2.id });
    expect(await unlock({ secret: { recoveryCode: code1 } })).toMatchObject({ kind: "local", pin: v1.id });
    await expect(unlock({ secret: { recoveryCode: "0000-0000" } })).rejects.toMatchObject({ code: "recovery_length" });
  }, 20_000);
  it("F-02 (unlock path): a same-VK bundle that replaced the history with 64 fresh VKs is refused", async () => {
    const rec = await setRecovery(await fresh64(k2, v2), v2, ctx); // a new code, so the local keyring does not open with it
    const r = await unlock({
      secret: { recoveryCode: rec.recoveryCode },
      local: k2,
      remote: await bundleOf(v2, rec.keyring, 5),
      pinnedVkId: v2.id,
      maxSeenKver: 2,
      adoptedAuth: authFor(k2),
    });
    expect(r).toEqual({ kind: "reject", reason: "previous_dropped" });
  }, 20_000);
  it("F-03: a remote bundle for another vault is wrong_vault on the unlock path too", async () => {
    const rec = await setRecovery({ ...k1, vaultId: "evil-vault-0001" }, v1, ctx);
    expect(
      await unlock({
        secret: { recoveryCode: rec.recoveryCode },
        remote: await bundleOf(v1, rec.keyring, 2, authFor(k1)),
      }),
    ).toEqual({ kind: "reject", reason: "wrong_vault" });
  }, 20_000);
  it("F-06 (REPRO-5): a cloud restore of the bundle last adopted is in sync, not an 'older key state' question", async () => {
    const current = await bundleOf(v1, k1, 4);
    const restore = {
      secret: { recoveryCode: code1 },
      local: null,
      remote: current,
      maxSeenKver: 4,
      needsPassword: true,
    };
    expect(await unlock({ ...restore, adoptedDigest: (await adoptedRecord(current)).digest })).toMatchObject({
      kind: "adopt",
      sameVk: true,
      maxSeenKver: 4,
    });
    expect(await unlock({ ...restore, adoptedDigest: null })).toEqual({ kind: "confirm_older" }); // no record: genuinely unknown
    const rec = await setRecovery(k1, v1, ctx);
    const other = await bundleOf(v1, rec.keyring, 4); // a different keyring at the same kver
    expect(
      await unlock({
        ...restore,
        secret: { recoveryCode: rec.recoveryCode },
        remote: other,
        adoptedDigest: (await adoptedRecord(current)).digest,
      }),
    ).toEqual({ kind: "confirm_older" });
  }, 20_000);
  it("F-07 after local loss: the adopted keyring under a new auth is auth_without_password", async () => {
    const adopted = await bundleOf(v1, k1, 4);
    const authOnly = await bundleOf(v1, k1, 5, newBundleAuth(pwSalt(k1)));
    const r = await unlock({
      secret: { recoveryCode: code1 },
      local: null,
      remote: authOnly,
      maxSeenKver: 4,
      needsPassword: true,
      adoptedDigest: (await adoptedRecord(adopted)).digest,
    });
    expect(r).toEqual({ kind: "reject", reason: "auth_without_password" });
  }, 20_000);
});

describe("capPrevious and the R3 catch-up across rotations (F-11, S-5, M1-3)", () => {
  let kFull: Keyring;
  beforeAll(async () => {
    kFull = await fresh64(k2, v2); // a VK2 keyring whose previous list is full: 64 real entries
  }, 20_000);
  it("REPRO-8: the 65th entry from rekey makes a bundle invalid; capPrevious keeps the last 64 in list order, the VK just retired included", async () => {
    const r = await rekey(kFull, v2, P, ctx);
    expect(r.keyring.previous.length).toBe(65);
    await expect(bundleOf(r.vk, r.keyring, 9)).rejects.toMatchObject({ code: "invalid_bundle" });
    const capped = capPrevious(r.keyring);
    expect(capped.previous.length).toBe(64);
    expect(capped.previous).toEqual(r.keyring.previous.slice(1)); // the first (oldest) entry is the one dropped
    expect(capped.previous.at(-1)!.vkId).toBe(v2.id); // the VK just retired is kept
    await bundleOf(r.vk, capped, 9);
    expect(capPrevious(k2)).toBe(k2);
  }, 20_000);
  it("a device that missed two rotations with a full list catches up: the missing entries are a leading run", async () => {
    const rb = await rekey(kFull, v2, P, ctx);
    const kb = capPrevious(rb.keyring);
    const rc = await rekey(kb, rb.vk, P, ctx);
    const kc = capPrevious(rc.keyring);
    const at = {
      secret: { recoveryCode: rc.recoveryCode },
      local: kFull,
      pinnedVkId: v2.id,
      maxSeenKver: 2,
      needsPassword: true,
      adoptedAuth: authFor(k2),
    };
    const r = await unlock({ ...at, remote: await bundleOf(rc.vk, kc, 4) });
    expect(r).toMatchObject({ kind: "adopt", sameVk: false, pin: rc.vk.id });
    // a rotation that drops an entry from the middle instead is refused
    const mid: Keyring = { ...kc, previous: [...kc.previous.slice(0, 10), ...kc.previous.slice(11)] };
    const extra = await retirePreviousVk(mid, await generateVk(), rc.vk, ctx); // back to 64 real entries
    expect(await unlock({ ...at, remote: await bundleOf(rc.vk, extra, 4) })).toEqual({
      kind: "reject",
      reason: "previous_dropped",
    });
  }, 30_000);
});

describe("a garbage previous entry once adopted does not block later honest bundles (M1-2b)", () => {
  it("rotation and recovery changes from devices that never saw the garbage entry are still adopted", async () => {
    const kGarb: Keyring = {
      ...k2,
      previous: [
        ...k2.previous,
        {
          vkId: "deadbeefdeadbeef",
          iv: toB64(new Uint8Array(12)),
          wrapped: toB64(new Uint8Array(48).fill(7)),
          createdAt: T0,
        },
      ],
    };
    const honestRec = (await setRecovery(k2, v2, ctx)).keyring; // built by a device whose keyring never had it
    expect(
      await same({
        bundle: await bundleOf(v2, honestRec, 3),
        vk: v2,
        local: kGarb,
        maxSeenKver: 2,
        adoptedAuth: authFor(k2),
      }),
    ).toEqual({ kind: "adopt", maxSeenKver: 3 });
    const r3 = await rekey(kGarb, v2, P, ctx); // Phase 0 rekey keeps only previous VKs that unwrap
    expect(r3.keyring.previous.map((p) => p.vkId)).not.toContain("deadbeefdeadbeef");
    const res = await unlock({
      secret: { recoveryCode: r3.recoveryCode },
      local: kGarb,
      remote: await bundleOf(r3.vk, r3.keyring, 3),
      pinnedVkId: v2.id,
      maxSeenKver: 2,
      needsPassword: true,
      adoptedAuth: authFor(k2),
    });
    expect(res).toMatchObject({ kind: "adopt", sameVk: false, pin: r3.vk.id });
  }, 20_000);
});

// ---- §8.1 / T-02: fact-level sequences through the real evaluateSameVkBundle and unlockWithSync ---------------------

describe("§8.1 adoption invariants through the real functions (T-02)", () => {
  type Line = { kr: Keyring; vk: Vk; codes: string[]; rank: number };
  let line: Line[];
  beforeAll(async () => {
    const r3 = await rekey(k2, v2, P, ctx);
    line = [
      { kr: k1, vk: v1, codes: [code1], rank: 1 },
      { kr: k2, vk: v2, codes: [code2], rank: 2 },
      { kr: r3.keyring, vk: r3.vk, codes: [r3.recoveryCode], rank: 3 },
    ];
  }, 20_000);

  type Op =
    | { t: "advance" | "recovery" | "sync" | "lose_local" }
    | { t: "forge"; kind: number; kver: number }
    | { t: "serve_old"; back: number }
    | { t: "unlock"; code: number; confirm: boolean; crash: boolean };
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.constantFrom<Op>({ t: "advance" }, { t: "recovery" }, { t: "sync" }, { t: "sync" }, { t: "lose_local" }),
    fc.record({ t: fc.constant("forge" as const), kind: fc.nat({ max: 7 }), kver: fc.integer({ min: 1, max: 40 }) }),
    fc.record({ t: fc.constant("serve_old" as const), back: fc.nat({ max: 4 }) }),
    fc.record({
      t: fc.constant("unlock" as const),
      code: fc.nat({ max: 6 }),
      confirm: fc.boolean(),
      crash: fc.boolean(),
    }),
  );

  it("real MACs, unwraps and digests: no lost history VK, never back to an older VK, the proven password wrap kept, forged bundles never adopted", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 12 }), async (ops) => {
        let stage = 0; // honest line position
        let honestKr = line[0]!.kr;
        let kver = 1;
        const honest: { b: KeyBundle; rank: number }[] = [{ b: await bundleOf(v1, honestKr, kver), rank: 1 }];
        let shown = honest[0]!;
        let forged = false;
        const knownCodes = [code1];
        const honestPw = line.map((l) => wrapOf(l.kr, "password")!);
        const rankOf = new Map(line.map((l) => [l.vk.id, l.rank]));
        const vkOf = new Map(line.map((l) => [l.vk.id, l.vk]));
        const dev = {
          local: k1 as Keyring | null,
          pin: v1.id,
          maxSeen: 1,
          adopted: await adoptedRecord(honest[0]!.b),
          needsPassword: false,
          held: new Set([v1.id]),
        };
        const realIds = async (kr: Keyring) =>
          new Set((await unwrapPreviousVks(kr, vkOf.get(kr.vkId)!)).map((v) => v.id));
        let provenByCode = false; // an unlock adopted a keyring with a typed recovery code
        for (const o of ops) {
          const pinBefore = dev.pin;
          const maxBefore = dev.maxSeen;
          if (o.t === "advance" && stage < 2) {
            stage++;
            honestKr = line[stage]!.kr;
            knownCodes.push(...line[stage]!.codes);
            honest.push({ b: await bundleOf(line[stage]!.vk, honestKr, ++kver), rank: line[stage]!.rank });
            shown = honest.at(-1)!;
            forged = false;
          } else if (o.t === "recovery") {
            const r = await setRecovery(honestKr, line[stage]!.vk, ctx);
            honestKr = r.keyring;
            knownCodes.push(r.recoveryCode);
            honest.push({ b: await bundleOf(line[stage]!.vk, honestKr, ++kver), rank: line[stage]!.rank });
            shown = honest.at(-1)!;
            forged = false;
          } else if (o.t === "serve_old") {
            shown = honest[Math.max(0, honest.length - 1 - o.back)]!;
            forged = false;
          } else if (o.t === "forge") {
            const vk = line[stage]!.vk;
            const kr = honestKr;
            const k = [
              async () => ({
                ...(await bundleOf(vk, (await setRecovery(kr, vk, ctx)).keyring, kver + o.kver)),
                kver: kver + o.kver + 1,
              }), // bad MAC
              async () =>
                bundleOf(
                  vk,
                  {
                    ...kr,
                    wraps: kr.wraps.map((w) =>
                      w.method === "password"
                        ? { ...w, wrapped: toB64(crypto.getRandomValues(new Uint8Array(48))) }
                        : w,
                    ),
                  },
                  kver + o.kver,
                  newBundleAuth(pwSalt(kr)),
                ), // garbage password wrap
              async () => bundleOf(vk, { ...kr, previous: [] }, kver + o.kver), // history dropped
              async () =>
                bundleOf(
                  vk,
                  { ...kr, previous: kr.previous.map((p) => ({ ...p, wrapped: toB64(new Uint8Array(48).fill(3)) })) },
                  kver + o.kver,
                ), // garbage history
              async () => bundleOf(vk, kr, kver + o.kver, newBundleAuth(pwSalt(kr))), // auth only
              async () => bundleOf(vk, { ...kr, vaultId: "evil-vault-0001" }, kver + o.kver, authFor(kr)), // other vault
              async () => bundleOf(v1, (await setRecovery(k1, v1, ctx)).keyring, kver + o.kver), // a revoked VK1 holder
              async () => bundleOf(vk, kr, dev.maxSeen + 65537 + o.kver), // beyond the cap
            ][o.kind]!;
            shown = { b: await k(), rank: o.kind === 6 ? 1 : line[stage]!.rank };
            // must never raise maxSeenKver: bad MAC, other vault, beyond the cap, and an auth-only change of the keyring this
            // device holds. (A garbage password wrap may be adopted through a recovery-code unlock, R6; history drops are
            // refused but may be no-ops; the VK1 bundle is a real older key state.)
            forged =
              [0, 5, 7].includes(o.kind) ||
              (o.kind === 4 && dev.local !== null && canonicalJsonStrict(dev.local) === canonicalJsonStrict(kr));
          } else if (o.t === "sync" && dev.local && !dev.needsPassword) {
            if (shown.b.keyring.vkId === dev.local.vkId) {
              const v = await evaluateSameVkBundle({
                bundle: shown.b,
                vk: vkOf.get(dev.local.vkId)!,
                local: dev.local,
                maxSeenKver: dev.maxSeen,
                expectedVaultId: VAULT,
                adoptedAuth: dev.adopted.auth,
                adoptedDigest: dev.adopted.digest,
              });
              if (v.kind === "adopt")
                Object.assign(dev, {
                  local: shown.b.keyring,
                  maxSeen: v.maxSeenKver,
                  adopted: await adoptedRecord(shown.b),
                });
              else if (v.kind === "in_sync" || v.kind === "keys_behind") dev.maxSeen = v.maxSeenKver;
              if (v.kind === "adopt")
                for (const x of [shown.b.keyring.vkId, ...(await realIds(shown.b.keyring))]) dev.held.add(x);
            } else if (classifyServerVk(shown.b.keyring.vkId, dev.pin, await realIds(dev.local)) === "rotated")
              dev.needsPassword = true;
          } else if (o.t === "lose_local") {
            Object.assign(dev, { local: null, needsPassword: true, held: new Set<string>() });
          } else if (o.t === "unlock") {
            const r = await unlockWithSync({
              secret: { recoveryCode: knownCodes[o.code % knownCodes.length]! },
              local: dev.local,
              remote: shown.b,
              pinnedVkId: dev.pin,
              maxSeenKver: dev.maxSeen,
              needsPassword: dev.needsPassword,
              confirmedOlder: o.confirm,
              expectedVaultId: VAULT,
              adoptedAuth: dev.adopted.auth,
              adoptedDigest: dev.adopted.digest,
            });
            if (r.kind === "adopt") {
              provenByCode = true;
              vkOf.set(r.vk.id, r.vk);
              Object.assign(dev, {
                local: r.bundle.keyring,
                maxSeen: r.maxSeenKver,
                adopted: await adoptedRecord(r.bundle),
                needsPassword: false,
                pin: o.crash ? dev.pin : r.pin,
              });
              for (const x of [r.bundle.keyring.vkId, ...(await realIds(r.bundle.keyring))]) dev.held.add(x);
            } else if (r.kind === "local") dev.pin = r.pin;
          }
          // never back to an older VK (also with local data lost)
          if ((rankOf.get(dev.pin) ?? 0) < (rankOf.get(pinBefore) ?? 0)) return false;
          if (dev.local) {
            // no lost history VK while the local data stayed
            const real = await realIds(dev.local);
            for (const x of dev.held) if (x !== dev.local.vkId && !real.has(x)) return false;
            // never locked out: the local keyring opens with a secret the user has. Its password wrap stays an honest one,
            // except after a recovery-code unlock adopted a keyring (R6): then the code just proven opens it (M1-NOTES)
            if (!honestPw.some((w) => sameWrapBytes(w, wrapOf(dev.local!, "password")))) {
              let opens = false;
              for (const c of knownCodes)
                if (!opens) opens = (await openKeyring(dev.local, { recoveryCode: c })) !== null;
              if (!opens || !provenByCode) return false;
            }
            if (dev.local.vaultId !== VAULT) return false;
          }
          // forged bundles never raise maxSeenKver
          if (forged && dev.maxSeen > maxBefore) return false;
        }
        return true;
      }),
      { numRuns: Number(process.env.SIXKEY_T02_RUNS ?? 40) },
    );
  }, 120_000);
});
