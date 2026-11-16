// The M1 pure-function changes that land with M2 (SYNC-DESIGN §0.0i "M1 code changes" 1-4, GM2-5), each with a case
// its revert fails:
//   1. "the same content" = the local keyring, or adoptedRecord(bundle).digest === adopted.digest, whether or not the
//      local keyring is there; in evaluateSameVkBundle, unlockWithSync and preSendCheck alike;
//   2. the same content with another local keyring is adopted back: the same VK at once (not needs_new_password, not
//      keys_behind); preSendCheck says needs_adoption;
//   3. unlockWithSync tries the remote first when the pin differs from the local VK (R4 order), and an R3 adoption with a
//      local keyring must really unwrap the local keyring's VK (reachesLocal);
//   4. afterLocal: a pin the local keyring cannot reach stays, and the note is pin_ahead.
// And revision 12 (docs/audit/internal-reviews/M2-REVIEW.md): preSendCheck blocks only what publishes or hands out a bundle in that state
// (M2R-2); the steady state with the real adopted digest stays in sync (R31); the adopt verdicts and published() are the
// commit capabilities M2's commitKeys takes (§0.0i item 16).
import { beforeAll, describe, expect, it } from "vitest";
import { createKeyring, enableMasterPassword, setRecovery, type Keyring } from "../../src/core/crypto/keyring";
import type { Vk } from "../../src/core/crypto/vk";
import { evaluateSameVkBundle, unlockWithSync, type UnlockInput } from "../../src/core/sync/crypto/bundle-eval";
import { keysOf } from "../../src/core/sync/crypto/capability";
import { adoptedRecord, newBundleAuth, type KeyBundle } from "../../src/core/sync/crypto/keybundle";
import { preSendCheck, published } from "../../src/core/sync/crypto/presend";
import { P, P2, VAULT, authFor, bundleOf, ctx, keyrings, sealedOf, type Fixture } from "../helpers/sync-keyrings";

let f: Fixture;
let changedHere: KeyBundle; // VK1 with password P2: this device changed the password (published, pins written)
beforeAll(async () => {
  f = await keyrings();
  changedHere = await bundleOf(f.v1, f.k1b, 2);
}, 30_000);

const unlock = (over: Partial<UnlockInput>) =>
  unlockWithSync({
    secret: { password: P },
    local: f.k1,
    remote: null,
    pinnedVkId: f.v1.id,
    maxSeenKver: 2,
    needsPassword: false,
    expectedVaultId: VAULT,
    adoptedAuth: authFor(f.k1),
    adoptedDigest: null,
    ...over,
  });

describe("1 + 2: the device's own last commit is the same content, adopted back (GM2-5)", () => {
  it("evaluateSameVkBundle: adopt at once with the adopted digest; without it the same bundle is keys_behind", async () => {
    const adopted = await adoptedRecord(changedHere);
    const base = { bundle: changedHere, vk: f.v1, local: f.k1, maxSeenKver: 2, expectedVaultId: VAULT };
    expect(await evaluateSameVkBundle({ ...base, adoptedAuth: adopted.auth, adoptedDigest: adopted.digest })).toEqual({
      kind: "adopt",
      maxSeenKver: 2,
    });
    expect(await evaluateSameVkBundle({ ...base, adoptedAuth: authFor(f.k1), adoptedDigest: null })).toEqual({
      kind: "keys_behind",
      maxSeenKver: 2,
    });
    // a newer kver of the same content is still adopted back (not needs_new_password: this device made that wrap)
    const newer = await bundleOf(f.v1, f.k1b, 3);
    const a3 = await adoptedRecord(newer);
    expect(
      await evaluateSameVkBundle({ ...base, bundle: newer, adoptedAuth: a3.auth, adoptedDigest: a3.digest }),
    ).toEqual({ kind: "adopt", maxSeenKver: 3 });
  });
  it("adopted back only after R0, and the history check still holds", async () => {
    const adopted = await adoptedRecord(changedHere);
    const base = {
      vk: f.v1,
      local: f.k1,
      maxSeenKver: 2,
      expectedVaultId: VAULT,
      adoptedAuth: adopted.auth,
      adoptedDigest: adopted.digest,
    };
    expect(await evaluateSameVkBundle({ ...base, bundle: { ...changedHere, kver: 9 } })).toEqual({
      kind: "reject",
      reason: "bad_mac",
    });
    expect(await evaluateSameVkBundle({ ...base, bundle: changedHere, expectedVaultId: "evil-vault-0001" })).toEqual({
      kind: "reject",
      reason: "wrong_vault",
    });
    // VK2 with VK1 in its history; this device's own commit dropped it (it never would): refused
    const dropped = await bundleOf(f.v2, { ...f.k2, previous: [] }, 4);
    const d = await adoptedRecord(dropped);
    expect(
      await evaluateSameVkBundle({
        ...base,
        vk: f.v2,
        local: f.k2,
        bundle: dropped,
        adoptedAuth: d.auth,
        adoptedDigest: d.digest,
      }),
    ).toEqual({ kind: "reject", reason: "previous_dropped" });
  });
  it("preSendCheck: needs_adoption for what publishes or hands out a bundle (not keys_behind, whose only way out, the repair, would publish the old wraps); revoke and the rest go ahead as in keys_behind (M2R-2)", async () => {
    const adopted = await adoptedRecord(changedHere);
    const raw = JSON.stringify(changedHere);
    const base = {
      serverRaw: raw,
      secret: { password: P2 },
      local: f.k1,
      vk: f.v1,
      maxSeenKver: 2,
      expectedVaultId: VAULT,
    };
    for (const op of [
      "repair",
      "change_password",
      "change_recovery",
      "recovery_reset",
      "rotate",
      "respond",
      "approve",
    ] as const) {
      expect(await preSendCheck({ ...base, op, adoptedAuth: adopted.auth, adoptedDigest: adopted.digest }), op).toEqual(
        { ok: false, reason: "needs_adoption" },
      );
    }
    for (const op of ["revoke", "reject", "reject_all", "rename", "fork", "clear_history", "delete_account"] as const) {
      const r = await preSendCheck({ ...base, op, adoptedAuth: adopted.auth, adoptedDigest: adopted.digest });
      expect(r.ok && r.verified.keysBehind && r.verified.raw === raw, op).toBe(true);
    }
    // the old password opens only the local (lost-commit) keyring: the server's is this device's own newer one
    expect(
      await preSendCheck({
        ...base,
        op: "revoke",
        secret: { password: P },
        adoptedAuth: adopted.auth,
        adoptedDigest: adopted.digest,
      }),
    ).toEqual({ ok: false, reason: "password_changed_elsewhere" });
    expect(
      await preSendCheck({ ...base, op: "change_password", adoptedAuth: authFor(f.k1), adoptedDigest: null }),
    ).toEqual({ ok: false, reason: "keys_behind" });
    expect(
      await preSendCheck({ ...base, op: "repair", adoptedAuth: authFor(f.k1), adoptedDigest: null }),
    ).toMatchObject({ ok: true }); // the repair it would have offered
  });
  it("unlockWithSync, local first (the pin is the local VK): the note is none, not keys_behind", async () => {
    const adopted = await adoptedRecord(changedHere);
    expect(
      await unlock({ remote: changedHere, adoptedAuth: adopted.auth, adoptedDigest: adopted.digest }),
    ).toMatchObject({ kind: "local", note: "none" });
    expect(await unlock({ remote: changedHere })).toMatchObject({ kind: "local", note: "keys_behind" });
  });
});

describe("3: the remote first when the pin differs from the local VK; R3 must reach the local keyring's VK", () => {
  let k2rec: Keyring;
  let rotatedHere: KeyBundle;
  beforeAll(async () => {
    k2rec = f.k2;
    rotatedHere = await bundleOf(f.v2, k2rec, 3); // this device rotated to VK2 and pinned it; its local commit was lost
  }, 30_000);
  it("one password adopts the pinned VK2 bundle, although the same password opens the local VK1 keyring too", async () => {
    const adopted = await adoptedRecord(rotatedHere);
    const r = await unlock({
      remote: rotatedHere,
      pinnedVkId: f.v2.id,
      maxSeenKver: 3,
      adoptedAuth: adopted.auth,
      adoptedDigest: adopted.digest,
    });
    expect(r).toMatchObject({ kind: "adopt", pin: f.v2.id, sameVk: true });
    expect(r.kind === "adopt" && r.previousVks.map((k) => k.id)).toContain(f.v1.id); // the local data's key, for the merge
  });
  it("a remote that does not reach the local keyring's VK is refused (discontinuous); the local keyring still opens, the pin stays", async () => {
    // an unrelated local keyring, the same password: the VK2 bundle's history does not unwrap its key
    const fresh = await createKeyring({ ...ctx, vaultId: VAULT });
    const other = (await enableMasterPassword(fresh.keyring, fresh.vk, P, ctx)).keyring;
    const r = await unlock({
      local: other,
      remote: rotatedHere,
      pinnedVkId: f.v2.id,
      maxSeenKver: 3,
      adoptedAuth: authFor(other),
    });
    expect(r).toMatchObject({ kind: "local", pin: f.v2.id, note: "pin_ahead", remoteRejected: "discontinuous" });
    // with no local keyring there is nothing to reach: adopted
    expect(
      await unlock({
        local: null,
        remote: rotatedHere,
        pinnedVkId: f.v2.id,
        maxSeenKver: 3,
        adoptedAuth: authFor(k2rec),
        adoptedDigest: (await adoptedRecord(rotatedHere)).digest,
      }),
    ).toMatchObject({ kind: "adopt" });
  });
});

describe("4: D8's second direction (afterLocal)", () => {
  it("a pin the local keyring cannot reach stays, and the note is pin_ahead; one it can reach moves on (D8's first direction)", async () => {
    expect(await unlock({ pinnedVkId: f.v2.id })).toMatchObject({ kind: "local", pin: f.v2.id, note: "pin_ahead" });
    expect(await unlock({ local: f.k2, pinnedVkId: f.v1.id, adoptedAuth: authFor(f.k2) })).toMatchObject({
      kind: "local",
      pin: f.v2.id,
      note: "none",
    });
  });
  it("pin_ahead wins over notes about the server's bundle (nothing about it is decided in that state)", async () => {
    const rec = (await setRecovery(f.k1, f.v1, ctx)).keyring;
    const sameVk = (await sealedOf(f.v1, rec, 9)).bundle;
    expect(await unlock({ pinnedVkId: f.v2.id, remote: sameVk, secret: { recoveryCode: f.code1 } })).toMatchObject({
      kind: "local",
      note: "pin_ahead",
    });
  });
});

describe("R31 (M2R-12): the steady state with the real adopted digest, bundle = local = adopted", () => {
  it("evaluateSameVkBundle is in sync, never an adoption; preSendCheck lets every operation through (the repair has nothing to repair); the unlock notes nothing", async () => {
    const steady = await bundleOf(f.v1, f.k1, 2);
    const a = await adoptedRecord(steady);
    const facts = { maxSeenKver: 2, expectedVaultId: VAULT, adoptedAuth: a.auth, adoptedDigest: a.digest };
    expect(await evaluateSameVkBundle({ ...facts, bundle: steady, vk: f.v1, local: f.k1 })).toEqual({
      kind: "in_sync",
      maxSeenKver: 2,
    });
    expect(
      await evaluateSameVkBundle({ ...facts, bundle: await bundleOf(f.v1, f.k1, 3), vk: f.v1, local: f.k1 }),
    ).toEqual({ kind: "in_sync", maxSeenKver: 3 });
    const raw = JSON.stringify(steady);
    for (const op of [
      "change_password",
      "change_recovery",
      "rotate",
      "respond",
      "approve",
      "revoke",
      "clear_history",
    ] as const) {
      const r = await preSendCheck({ ...facts, op, serverRaw: raw, secret: { password: P }, local: f.k1, vk: f.v1 });
      expect(r.ok && !r.verified.keysBehind, op).toBe(true);
    }
    expect(
      await preSendCheck({ ...facts, op: "repair", serverRaw: raw, secret: { password: P }, local: f.k1, vk: f.v1 }),
    ).toEqual({ ok: false, reason: "not_behind" });
    expect(await unlock({ remote: steady, adoptedAuth: a.auth, adoptedDigest: a.digest })).toEqual(
      expect.objectContaining({ kind: "local", note: "none" }),
    );
  });
});

describe("§0.0i item 16: the adopt verdicts and published() are the commit capabilities, and nothing else is", () => {
  it("evaluateSameVkBundle's adopt is frozen and carries the bundle, its VK, nothing to hold and maxSeenKver: same_password_wrap for R2, adopted_back for GM2-5; other verdicts and copies carry nothing", async () => {
    const rec = (await setRecovery(f.k1, f.v1, ctx)).keyring;
    const bundle = await bundleOf(f.v1, rec, 3, authFor(f.k1));
    const base = { vk: f.v1, local: f.k1, maxSeenKver: 2, expectedVaultId: VAULT };
    const v = await evaluateSameVkBundle({ ...base, bundle, adoptedAuth: authFor(f.k1), adoptedDigest: null });
    expect(v).toEqual({ kind: "adopt", maxSeenKver: 3 });
    expect(Object.isFrozen(v)).toBe(true);
    expect(keysOf(v)).toEqual({ bundle, vk: f.v1, held: [], maxSeenKver: 3, basis: "same_password_wrap", base: f.k1 }); // base: the local keyring judged (RR-1)
    for (const copy of [{ ...v }, structuredClone(v), JSON.parse(JSON.stringify(v))]) expect(keysOf(copy)).toBeNull();
    const back = await adoptedRecord(changedHere);
    const vb = await evaluateSameVkBundle({
      ...base,
      bundle: changedHere,
      adoptedAuth: back.auth,
      adoptedDigest: back.digest,
    });
    expect(keysOf(vb)).toMatchObject({ bundle: changedHere, basis: "adopted_back", maxSeenKver: 2 });
    const nn = await evaluateSameVkBundle({
      ...base,
      maxSeenKver: 1,
      bundle: changedHere,
      adoptedAuth: authFor(f.k1),
      adoptedDigest: null,
    });
    expect(nn.kind).toBe("needs_new_password"); // R2: never committed on this verdict
    expect(keysOf(nn)).toBeNull();
    expect(
      keysOf(
        await evaluateSameVkBundle({
          ...base,
          bundle: await bundleOf(f.v1, f.k1, 2),
          adoptedAuth: authFor(f.k1),
          adoptedDigest: null,
        }),
      ),
    ).toBeNull(); // in sync
  });
  it("unlockWithSync's adopt carries the VK the typed secret opened and the previous VKs it unwraps (opened); a local unlock carries nothing", async () => {
    const r = await unlock({ remote: await bundleOf(f.v2, f.k2, 3), needsPassword: true });
    expect(r).toMatchObject({ kind: "adopt", sameVk: false });
    expect(Object.isFrozen(r)).toBe(true);
    expect(keysOf(r)).toMatchObject({ vk: f.v2, maxSeenKver: 3, basis: "opened" });
    expect(keysOf(r)!.held.map((k) => k.id)).toEqual([f.v1.id]);
    expect(keysOf(await unlock({}))).toBeNull();
  });
  it("published(): only from preSendCheck's VerifiedServerBundle for an operation that publishes, and a sent bundle that is the server's continuation, above its kver, opened by the secret it was built with (built_here)", async () => {
    const steady = await bundleOf(f.v1, f.k1, 2);
    const a = await adoptedRecord(steady);
    const check = async (op: "change_password" | "rotate" | "revoke") => {
      const r = await preSendCheck({
        op,
        serverRaw: JSON.stringify(steady),
        secret: { password: P },
        local: f.k1,
        vk: f.v1,
        maxSeenKver: 2,
        expectedVaultId: VAULT,
        adoptedAuth: a.auth,
        adoptedDigest: a.digest,
      });
      if (!r.ok) throw new Error(r.reason);
      return r.verified;
    };
    const pw = await check("change_password");
    const sent = await bundleOf(f.v1, f.k1b, 3, newBundleAuth(pwSaltOf(f.k1b)));
    const p = await published({ verified: pw, sent, vk: f.v1, secret: { password: P2 } });
    expect(p).toEqual({ kind: "published", bundle: sent, maxSeenKver: 3 });
    expect(keysOf(p)).toEqual({ bundle: sent, vk: f.v1, held: [], maxSeenKver: 3, basis: "built_here", base: f.k1 }); // the pre-send check's local keyring (RR-1)
    const rot = await check("rotate");
    const sent2 = await bundleOf(f.v2, f.k2, 3);
    expect(
      keysOf(await published({ verified: rot, sent: sent2, vk: f.v2, secret: { recoveryCode: f.code2 } })),
    ).toMatchObject({ vk: f.v2, held: [f.v1], basis: "built_here" });
    const refused = async (o: Parameters<typeof published>[0]) =>
      expect(published(o)).rejects.toMatchObject({ code: "invalid_argument" });
    await refused({ verified: pw, sent, vk: f.v1, secret: { password: P } }); // the secret does not open what it sends: a lock-out
    await refused({ verified: pw, sent: await bundleOf(f.v1, f.k1b, 2), vk: f.v1, secret: { password: P2 } }); // not above the server's kver
    await refused({ verified: { ...pw }, sent, vk: f.v1, secret: { password: P2 } }); // a copy of the verified bundle
    await refused({ verified: await check("revoke"), sent, vk: f.v1, secret: { password: P2 } }); // revoke publishes nothing
    await refused({ verified: pw, sent: sent2, vk: f.v2, secret: { recoveryCode: f.code2 } }); // a new VK is only a rotation
    await refused({ verified: rot, sent, vk: f.v1, secret: { password: P2 } }); // a rotation changes the VK
    await refused({ verified: pw, sent: { ...sent, mac: steady.mac }, vk: f.v1, secret: { password: P2 } }); // its MAC
    await refused({
      verified: rot,
      sent: await bundleOf(f.v2, { ...f.k2, previous: [] }, 3),
      vk: f.v2,
      secret: { recoveryCode: f.code2 },
    }); // discontinuous
  });
});

const pwSaltOf = (kr: Keyring) => kr.wraps.find((w) => w.method === "password")!.kdf!.salt;
void (null as unknown as Vk);
