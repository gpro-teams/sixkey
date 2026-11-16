// M1: the §3.14 pre-send check and the §3.6.0 reconciliation by critical parts, on real keyrings. Every refusal
// happens locally: these functions return before any request would be built.
import { beforeAll, describe, expect, it } from "vitest";
import { retirePreviousVk, setPassword, setRecovery, type Keyring } from "../../src/core/crypto/keyring";
import { generateVk } from "../../src/core/crypto/vk";
import { passwordProof, recoveryProof } from "../../src/core/sync/crypto/auth-proofs";
import { bundleMac, newBundleAuth, requiredVerifiers } from "../../src/core/sync/crypto/keybundle";
import { isVerifiedServerBundle, preSendCheck, type PreSendInput } from "../../src/core/sync/crypto/presend";
import { reconcileKeyOp, recoveryWrapFingerprint, recoveryWrapInEffect } from "../../src/core/sync/crypto/reconcile";
import { P, P2, VAULT, authFor, bundleOf, ctx, keyrings, pwSalt, type Fixture } from "../helpers/sync-keyrings";

let f: Fixture;
beforeAll(async () => {
  f = await keyrings();
}, 30_000);

const input = (over: Partial<PreSendInput> & { server?: object }): PreSendInput => {
  const { server, ...rest } = over;
  return {
    op: "revoke",
    serverRaw: server ? JSON.stringify(server) : "",
    secret: { password: P },
    local: f.k1,
    vk: f.v1,
    maxSeenKver: 1,
    expectedVaultId: VAULT,
    adoptedAuth: authFor(f.k1),
    adoptedDigest: null,
    ...rest,
  };
};

describe("pre-send check", () => {
  it("the right password yields pw_auth from the server bundle's auth.kdf and a registered, frozen VerifiedServerBundle", async () => {
    const b = await bundleOf(f.v1, f.k1, 1);
    const r = await preSendCheck(input({ server: b }));
    expect(r).toEqual({
      ok: true,
      proof: { password_auth: (await passwordProof(P, b.auth.kdf)).passwordAuth },
      verified: { raw: JSON.stringify(b), bundle: b, vk: f.v1, op: "revoke", keysBehind: false },
    });
    if (!r.ok) throw new Error("unreachable");
    expect([
      isVerifiedServerBundle(r.verified),
      Object.isFrozen(r.verified),
      isVerifiedServerBundle({ ...r.verified }),
    ]).toEqual([true, true, false]);
  }, 20_000);
  it("a wrong password, and a password changed on another device, are stopped locally with distinct reasons", async () => {
    const changed = await bundleOf(f.v1, f.k1b, 2);
    expect(await preSendCheck(input({ server: changed, secret: { password: "nope nope nope 1" } }))).toEqual({
      ok: false,
      reason: "wrong_secret",
    });
    expect(await preSendCheck(input({ server: changed }))).toEqual({ ok: false, reason: "password_changed_elsewhere" });
    expect(await preSendCheck(input({ server: changed, secret: { password: P2 } }))).toMatchObject({
      ok: true,
      verified: { keysBehind: false },
    });
  }, 20_000);
  it("after a rollback past a password change: the old password is required, and only allowed operations proceed", async () => {
    const older = await bundleOf(f.v1, f.k1, 1);
    const at = { server: older, local: f.k1b, maxSeenKver: 2, adoptedAuth: authFor(f.k1b) };
    expect(await preSendCheck(input({ ...at, secret: { password: P2 } }))).toEqual({
      ok: false,
      reason: "old_password_required",
    });
    expect(await preSendCheck(input({ ...at, secret: { password: P } }))).toMatchObject({
      ok: true,
      verified: { keysBehind: true },
    });
    expect(await preSendCheck(input({ ...at, op: "change_recovery" }))).toEqual({ ok: false, reason: "keys_behind" });
    expect(await preSendCheck(input({ ...at, op: "respond" }))).toEqual({ ok: false, reason: "keys_behind" }); // M1-4
    expect(await preSendCheck(input({ ...at, op: "repair" }))).toMatchObject({
      ok: true,
      verified: { keysBehind: true, op: "repair" },
    });
  }, 20_000);
  it("a server on a VK not yet adopted needs R3 first (P9); repair is refused when the server is not older", async () => {
    expect(await preSendCheck(input({ server: await bundleOf(f.v2, f.k2, 2) }))).toEqual({
      ok: false,
      reason: "needs_adoption",
    });
    expect(await preSendCheck(input({ op: "repair", server: await bundleOf(f.v1, f.k1, 1) }))).toEqual({
      ok: false,
      reason: "not_behind",
    });
    // a device on VK2 whose server went back to VK1 (in its previous list): an older state, MAC checked with the previous VK
    const r = await preSendCheck(
      input({
        server: await bundleOf(f.v1, f.k1, 1),
        local: f.k2,
        vk: f.v2,
        maxSeenKver: 2,
        adoptedAuth: authFor(f.k2),
      }),
    );
    expect(r).toMatchObject({ ok: true, verified: { keysBehind: true } });
    if (r.ok) expect(r.verified.vk.id).toBe(f.v1.id);
    const forgedOld = { ...(await bundleOf(f.v1, f.k1, 1)), kver: 2 };
    expect(await preSendCheck(input({ server: forgedOld, local: f.k2, vk: f.v2, maxSeenKver: 2 }))).toEqual({
      ok: false,
      reason: "bad_mac",
    });
  }, 20_000);
  it("unknown members block key operations but not revocation; a broken MAC is refused", async () => {
    const b = await bundleOf(f.v1, f.k1, 2);
    const withUnknown = { ...b, newer: "x" } as typeof b;
    withUnknown.mac = await bundleMac(f.v1, withUnknown);
    expect(await preSendCheck(input({ op: "change_password", server: withUnknown }))).toEqual({
      ok: false,
      reason: "update_required",
    });
    expect(await preSendCheck(input({ op: "revoke", server: withUnknown }))).toMatchObject({ ok: true });
    expect(await preSendCheck(input({ server: { ...b, kver: 3 } }))).toEqual({ ok: false, reason: "bad_mac" });
  }, 20_000);
  it("R0 (F-08, REPRO-6): the MAC is checked before classifying, so a forged lower-kver bundle is bad_mac, not keys_behind", async () => {
    const real = await bundleOf(f.v1, f.k1b, 3);
    const forged = { ...real, kver: 1 }; // MAC no longer verifies
    expect(await preSendCheck(input({ op: "change_password", server: forged, maxSeenKver: 2 }))).toEqual({
      ok: false,
      reason: "bad_mac",
    });
    expect(await preSendCheck({ ...input({}), serverRaw: "{not json" })).toEqual({
      ok: false,
      reason: "invalid_bundle",
    });
  }, 20_000);
  it("F-03: a bundle for another vault is wrong_vault, even with the local wraps copied verbatim", async () => {
    const evil: Keyring = { ...f.k1, vaultId: "evil-vault-0001" };
    const b = await bundleOf(f.v1, evil, 2, authFor(f.k1));
    expect(await preSendCheck(input({ server: b }))).toEqual({ ok: false, reason: "wrong_vault" });
    expect(
      await preSendCheck(input({ server: await bundleOf(f.v1, f.k1, 1), expectedVaultId: "evil-vault-0001" })),
    ).toEqual({ ok: false, reason: "wrong_vault" });
  }, 20_000);
  it("F-02 (pre-send path): a newer same-VK bundle whose previous was replaced by 64 fresh VKs is previous_dropped (K10 drops it all)", async () => {
    let kr: Keyring = { ...f.k2, previous: [] };
    for (let i = 0; i < 64; i++) kr = await retirePreviousVk(kr, await generateVk(), f.v2, ctx);
    const base = { local: f.k2, vk: f.v2, maxSeenKver: 2, adoptedAuth: authFor(f.k2), op: "change_recovery" as const };
    expect(await preSendCheck(input({ ...base, server: await bundleOf(f.v2, kr, 5) }))).toEqual({
      ok: false,
      reason: "previous_dropped",
    });
    expect(await preSendCheck(input({ ...base, server: await bundleOf(f.v2, { ...f.k2, previous: [] }, 5) }))).toEqual({
      ok: false,
      reason: "previous_dropped",
    });
  }, 30_000);
  it("F-07 (pre-send path): in sync but with another auth is auth_without_password; with adopted.auth unknown (identity just restored) it passes", async () => {
    const authOnly = await bundleOf(f.v1, f.k1, 2, newBundleAuth(pwSalt(f.k1)));
    expect(await preSendCheck(input({ server: authOnly, maxSeenKver: 2 }))).toEqual({
      ok: false,
      reason: "auth_without_password",
    });
    expect(await preSendCheck(input({ server: authOnly, maxSeenKver: 2, adoptedAuth: null }))).toMatchObject({
      ok: true,
    });
  }, 20_000);
  it("recovery-code version (S6): the code opens the bundle's recovery wrap and yields recAuth", async () => {
    const b = await bundleOf(f.v1, f.k1, 1);
    expect(
      await preSendCheck(input({ op: "recovery_reset", server: b, secret: { recoveryCode: f.code1 } })),
    ).toMatchObject({ ok: true, proof: { recovery_auth: (await recoveryProof(f.code1)).recoveryAuth } });
    expect(await preSendCheck(input({ server: b, secret: { recoveryCode: f.code2 } }))).toEqual({
      ok: false,
      reason: "wrong_secret",
    });
    await expect(preSendCheck(input({ server: b, secret: { recoveryCode: "abc" } }))).rejects.toMatchObject({
      code: "recovery_length",
    });
  }, 20_000);
});

describe("P4 consistency of outgoing key operations (§2.3)", () => {
  it("recovery-only, password-only and no-op changes ask for the right verifiers; inconsistent ones never leave the device", async () => {
    const server = await bundleOf(f.v1, f.k1, 1);
    const recOnly = await bundleOf(f.v1, (await setRecovery(f.k1, f.v1, ctx)).keyring, 2, server.auth);
    expect(requiredVerifiers(server, recOnly)).toEqual({ recoveryVerifier: true, passwordVerifier: false });
    const pwOnly = await bundleOf(f.v1, f.k1b, 2); // its own auth: the password wrap changed
    expect(requiredVerifiers(server, pwOnly)).toEqual({ recoveryVerifier: false, passwordVerifier: true });
    expect(requiredVerifiers(server, await bundleOf(f.v1, f.k1, 2, server.auth))).toEqual({
      recoveryVerifier: false,
      passwordVerifier: false,
    });
    const authOnly = await bundleOf(f.v1, (await setRecovery(f.k1, f.v1, ctx)).keyring, 2, newBundleAuth(pwSalt(f.k1))); // new auth, same password wrap
    expect(() => requiredVerifiers(server, authOnly)).toThrow(expect.objectContaining({ code: "invalid_bundle" }));
    const pwReusedAuth = await bundleOf(f.v1, f.k1b, 2, server.auth); // new password wrap, auth reused
    expect(() => requiredVerifiers(server, pwReusedAuth)).toThrow(expect.objectContaining({ code: "invalid_bundle" }));
    expect(requiredVerifiers(server, await bundleOf(f.v2, f.k2, 2))).toEqual({
      recoveryVerifier: true,
      passwordVerifier: true,
    }); // rotation
  }, 20_000);
});

describe("reconciliation by critical parts (§3.6.0, S4)", () => {
  it("recovery change: in effect while my recovery wrap is on the server, even after another device changed the password on top", async () => {
    const mine = await bundleOf(f.v1, (await setRecovery(f.k1, f.v1, ctx)).keyring, 2);
    const onTop = await bundleOf(f.v1, await setPassword(mine.keyring, f.v1, P2, ctx), 3);
    expect(await reconcileKeyOp({ kind: "change_recovery", bundle: mine }, { bundle: mine, vkId: f.v1.id })).toBe(true);
    expect(await reconcileKeyOp({ kind: "change_recovery", bundle: mine }, { bundle: onTop, vkId: f.v1.id })).toBe(
      true,
    );
    expect(
      await reconcileKeyOp(
        { kind: "change_recovery", bundle: mine },
        { bundle: await bundleOf(f.v1, f.k1, 2), vkId: f.v1.id },
      ),
    ).toBe(false);
    const fp = await recoveryWrapFingerprint(mine);
    expect(fp).not.toContain(f.code1);
    expect([
      await recoveryWrapInEffect(onTop, fp),
      await recoveryWrapInEffect(await bundleOf(f.v1, f.k1, 4), fp),
    ]).toEqual([true, false]);
  }, 20_000);
  it("password change: my wrap on the server, or a later wrap my new password opens; otherwise failed", async () => {
    const mine = await bundleOf(f.v1, f.k1b, 2);
    const reWrapped = await bundleOf(f.v1, await setPassword(f.k1b, f.v1, P2, ctx), 3); // another device, same new password
    const op = { kind: "change_password" as const, bundle: mine, newPassword: P2 };
    expect(await reconcileKeyOp(op, { bundle: mine, vkId: f.v1.id })).toBe(true);
    expect(await reconcileKeyOp(op, { bundle: reWrapped, vkId: f.v1.id })).toBe(true);
    expect(await reconcileKeyOp(op, { bundle: await bundleOf(f.v1, f.k1, 2), vkId: f.v1.id })).toBe(false);
  }, 20_000);
  it("rotation: judged by the server's vk_id alone", async () => {
    const mine = await bundleOf(f.v2, f.k2, 2);
    expect(await reconcileKeyOp({ kind: "rotate", bundle: mine }, { bundle: mine, vkId: f.v2.id })).toBe(true);
    expect(
      await reconcileKeyOp({ kind: "rotate", bundle: mine }, { bundle: await bundleOf(f.v1, f.k1, 3), vkId: f.v1.id }),
    ).toBe(false);
  });
});
