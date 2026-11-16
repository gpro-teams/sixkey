// SYNC-DESIGN §8.1 "a local commit lost to a power loss, the identity record written" (GM2-5; §0.0i req. 9, D8's second
// direction). chrome.storage.local and IndexedDB are two LevelDBs that each lose their own unflushed tail: after a key
// commit and its pins (P4 rotation, R3 adoption, §3.5 join, a password change, a recovery-code change), storage.local's
// tail is dropped and IndexedDB's identity write kept. After the restart the local keyring is back to its old state while
// the pins and adopted are ahead, and:
//   - nothing is written: the self-check, the open and the unlock leave storage.local and the identity as they are
//     (no pin moved back, nothing "repaired");
//   - M1 sees it for what it is: with a VK change, the local unlock says pin_ahead (needs_password) and, with the
//     server's bundle at hand, one password adopts it (R4 order, no confirm_older, no bad_mac, no keys_behind); with the
//     same VK, the device's own last commit (adopted.digest) is adopted back and the pre-send check asks for that
//     (needs_adoption) for what publishes or hands out a bundle, never offering the repair that would publish the old
//     wraps, while revoke, reject and clear_history go ahead (emergency revocation is never blocked, M2R-2).
import { describe, expect, it } from "vitest";
import { decryptVault } from "../../src/core/crypto/envelope";
import { setPassword, type Keyring } from "../../src/core/crypto/keyring";
import type { Vk } from "../../src/core/crypto/vk";
import { KEYS } from "../../src/core/storage/format";
import { MemoryKV } from "../../src/core/storage/kv";
import { evaluateSameVkBundle, unlockWithSync } from "../../src/core/sync/crypto/bundle-eval";
import { adoptedRecord, type KeyBundle } from "../../src/core/sync/crypto/keybundle";
import { preSendCheck } from "../../src/core/sync/crypto/presend";
import type { DeviceIdentity } from "../../src/core/sync/local/identity";
import { canonicalJson } from "../../src/core/vault/merge";
import { createClock } from "../../src/core/vault/hlc";
import { addEntry } from "../../src/core/vault/ops";
import { deserializeVault } from "../../src/core/vault/validate";
import { STRONG } from "../helpers/vaults";
import {
  adoptByUnlock,
  adoptSameVk,
  bundleFor,
  input,
  m2World,
  newCode,
  newIdentity,
  publishedOf,
  rotated,
  secretOf,
  steadyState,
  vaultWith,
  type M2World,
} from "../helpers/m2-world";

const PW2 = "granite-river-compass-31";
const copyOf = (m: MemoryKV) => {
  const n = new MemoryKV();
  for (const [k, v] of m.data) n.data.set(k, structuredClone(v));
  return n;
};
const restore = (into: MemoryKV, from: MemoryKV) => {
  into.data.clear();
  for (const [k, v] of from.data) into.data.set(k, structuredClone(v));
};

/** An enrolled device in its steady state: pinned to its keyring, adopted = the bundle it last published. */
async function device() {
  const w = m2World();
  await vaultWith(w, ["GitHub", "AWS"], { syncOn: true });
  const { vk, bundle: published } = await steadyState(w, 5);
  return { w, vk, published };
}

type Case = {
  name: string;
  vkChanges: boolean;
  run: (w: M2World, vk: Vk, kr: Keyring, published: KeyBundle) => Promise<{ bundle: KeyBundle; vk: Vk; pw: string }>;
};
const CASES: Case[] = [
  {
    name: "P4 rotation (published here)",
    vkChanges: true,
    run: async (w, vk, kr, published) => {
      const r = await rotated(kr, vk);
      const bundle = await bundleFor(r.vk, r.keyring, 6);
      const keys = await publishedOf({
        server: published,
        local: kr,
        vk,
        op: "rotate",
        sent: bundle,
        sentVk: r.vk,
        sentSecret: { recoveryCode: r.recoveryCode },
      });
      await w.flows().commitKeys({ keys, record: "key_rotated" });
      return { bundle, vk: r.vk, pw: STRONG };
    },
  },
  {
    name: "R3 adoption of another device's rotation, with its data",
    vkChanges: true,
    run: async (w, vk, kr, published) => {
      const r = await rotated(kr, vk);
      const bundle = await bundleFor(r.vk, r.keyring, 6);
      const v = deserializeVault(await decryptVault((await w.active()).envelope, vk));
      const c = createClock("bbbb", { now: () => w.t.now + 5000 });
      for (const e of v.entries) c.observe(e.hlc);
      const remote = addEntry(v, input("Remote", secretOf("Remote")), c).vault;
      const pins = await adoptedRecord(published);
      const keys = await adoptByUnlock({
        secret: { password: STRONG },
        local: kr,
        remote: bundle,
        pinnedVkId: vk.id,
        maxSeenKver: 5,
        needsPassword: true,
        expectedVaultId: kr.vaultId,
        adoptedAuth: pins.auth,
        adoptedDigest: pins.digest,
      });
      await w.flows().commitKeys({ keys, remote, record: "keys_adopted" });
      return { bundle, vk: r.vk, pw: STRONG };
    },
  },
  {
    name: "a password change (same VK, published here)",
    vkChanges: false,
    run: async (w, vk, kr, published) => {
      const bundle = await bundleFor(vk, await setPassword(kr, vk, PW2), 6);
      const keys = await publishedOf({
        server: published,
        local: kr,
        vk,
        op: "change_password",
        sent: bundle,
        sentVk: vk,
        sentSecret: { password: PW2 },
      });
      await w.flows().commitKeys({ keys, record: "password_changed" });
      return { bundle, vk, pw: PW2 };
    },
  },
  {
    name: "a new recovery code (same VK, published here)",
    vkChanges: false,
    run: async (w, vk, kr, published) => {
      const r = await newCode(kr, vk);
      const bundle = await bundleFor(vk, r.keyring, 6, published.auth);
      const keys = await publishedOf({
        server: published,
        local: kr,
        vk,
        op: "change_recovery",
        sent: bundle,
        sentVk: vk,
        sentSecret: { recoveryCode: r.recoveryCode },
      });
      await w.flows().commitKeys({ keys, record: "recovery_code_new" });
      return { bundle, vk, pw: STRONG };
    },
  },
];

describe.each(CASES.map((c) => [c.name, c] as const))(
  "storage.local's tail lost after %s, the identity's write kept",
  (_n, c) => {
    it("restart: the old keyring, the pins ahead, nothing written; M1 adopts it with one password, or adopts the device's own commit back", async () => {
      const { w, vk, published } = await device();
      const oldKeyring = (await w.active()).keyring;
      const localBefore = copyOf(w.kv);
      const next = await c.run(w, vk, oldKeyring, published);
      const pins = structuredClone(w.idb.data.get("identity")) as DeviceIdentity;
      expect(pins).toMatchObject({
        vkId: next.bundle.keyring.vkId,
        maxSeenKver: 6,
        adopted: await adoptedRecord(next.bundle),
      });
      // the power loss: storage.local's tail goes (back to the moment before the commit), IndexedDB keeps its writes
      restore(w.kv, localBefore);
      w.session.data = null;
      await w.store().selfCheck();
      const afterRestart = JSON.stringify([...w.kv.data]);
      const g = await w.active();
      expect(canonicalJson(g.keyring)).toBe(canonicalJson(oldKeyring));
      // the open and the unlock (the old password still opens the old keyring) write nothing to storage.local or the identity
      expect((await w.svc().openView()).state).toBe("locked");
      await w.svc().unlockWithPassword(STRONG);
      expect(JSON.stringify([...w.kv.data])).toBe(afterRestart);
      expect(w.idb.data.get("identity")).toEqual(pins);
      const facts = {
        maxSeenKver: pins.maxSeenKver,
        expectedVaultId: g.keyring.vaultId,
        adoptedAuth: pins.adopted!.auth,
        adoptedDigest: pins.adopted!.digest,
      };
      expect(await w.local().settlePins()).toEqual(pins); // nothing pending survived the tail loss: the pins stay as they are
      let keys;
      if (c.vkChanges) {
        // locally the pin is a key this keyring cannot reach: needs_password, the pin stays
        expect(
          await unlockWithSync({
            ...facts,
            secret: { password: STRONG },
            local: g.keyring,
            remote: null,
            pinnedVkId: pins.vkId,
            needsPassword: false,
          }),
        ).toMatchObject({ kind: "local", pin: pins.vkId, note: "pin_ahead" });
        // with the server's bundle (the one this device committed): the remote first (the pin differs), adopted at once
        const r = await unlockWithSync({
          ...facts,
          secret: { password: next.pw },
          local: g.keyring,
          remote: next.bundle,
          pinnedVkId: pins.vkId,
          needsPassword: false,
        });
        expect(r).toMatchObject({ kind: "adopt", pin: next.vk.id, sameVk: true }); // the bundle's VK is the pinned one
        expect(r.kind === "adopt" && r.previousVks.map((k) => k.id)).toContain(vk.id); // the local data's key, to merge it
        keys = r;
      } else {
        // the same VK: the device's own last commit (adopted.digest) is adopted back, not keys_behind, no repair offered
        keys = await evaluateSameVkBundle({ ...facts, bundle: next.bundle, vk, local: g.keyring });
        expect(keys).toEqual({ kind: "adopt", maxSeenKver: 6 });
        const raw = JSON.stringify(next.bundle);
        for (const op of ["change_password", "change_recovery", "repair", "rotate", "respond", "approve"] as const) {
          expect(
            await preSendCheck({ ...facts, op, serverRaw: raw, secret: { password: next.pw }, local: g.keyring, vk }),
            op,
          ).toEqual({ ok: false, reason: "needs_adoption" });
        }
        // M2R-2: what neither publishes nor hands out a bundle goes ahead, against the server's (verified) bundle: emergency
        // revocation is never blocked. The password is the one of that bundle (this device's own newer one).
        for (const op of ["revoke", "reject", "reject_all", "clear_history"] as const) {
          const ok = await preSendCheck({
            ...facts,
            op,
            serverRaw: raw,
            secret: { password: next.pw },
            local: g.keyring,
            vk,
          });
          expect(ok.ok && ok.verified.keysBehind && ok.verified.bundle.kver === 6, op).toBe(true);
        }
        if (next.pw !== STRONG)
          expect(
            await preSendCheck({
              ...facts,
              op: "revoke",
              serverRaw: raw,
              secret: { password: STRONG },
              local: g.keyring,
              vk,
            }),
          ).toEqual({ ok: false, reason: "password_changed_elsewhere" });
        // and the unlock, local first (the pin is the local VK), notes nothing about it
        expect(
          await unlockWithSync({
            ...facts,
            secret: { password: STRONG },
            local: g.keyring,
            remote: next.bundle,
            pinnedVkId: pins.vkId,
            needsPassword: false,
          }),
        ).toMatchObject({ kind: "local", note: "none" });
      }
      // the adoption itself, as M3 will run it (with M1's verdict), brings the device to the state it had committed
      if (keys.kind !== "adopt") throw new Error(keys.kind);
      await w.flows().commitKeys({ keys, record: "keys_adopted" });
      expect(canonicalJson((await w.active()).keyring)).toBe(canonicalJson(next.bundle.keyring));
    }, 60_000);
  },
);

describe("storage.local's tail lost after a §3.5 join, the identity's write kept", () => {
  it("restart: this profile's own vault again, the pins on the cloud's key and vault: pin_ahead, nothing written", async () => {
    const w = m2World();
    await vaultWith(w, ["Mine"]);
    await w.svc().openView(); // its steady state (the one-time check done)
    const g0 = await w.active();
    const cw = m2World();
    await vaultWith(cw, ["Cloud"]);
    const cvk = await cw.sessionVk();
    const bundle = await bundleFor(cvk, (await cw.active()).keyring, 4);
    const remote = deserializeVault(await decryptVault((await cw.active()).envelope, cvk));
    const { id, jwk } = await newIdentity();
    await w.local().identity.put(id);
    const localBefore = copyOf(w.kv);
    await w.flows().commitJoin(
      await w.flows().prepareJoin({
        bundle,
        vk: cvk,
        remote,
        device: { deviceId: id.deviceId, apiOrigin: id.apiOrigin, dsk: jwk, email: "" },
      }),
    );
    const pins = structuredClone(w.idb.data.get("identity")) as DeviceIdentity;
    expect(pins).toMatchObject({ vkId: cvk.id, vaultId: bundle.vaultId });
    restore(w.kv, localBefore);
    w.session.data = null;
    await w.store().selfCheck();
    const snap = JSON.stringify([...w.kv.data]);
    await w.svc().unlockWithPassword(STRONG);
    expect(JSON.stringify([...w.kv.data])).toBe(snap);
    expect(w.idb.data.get("identity")).toEqual(pins);
    const g = await w.active();
    expect(canonicalJson(g.keyring)).toBe(canonicalJson(g0.keyring));
    expect(
      await unlockWithSync({
        secret: { password: STRONG },
        local: g.keyring,
        remote: null,
        pinnedVkId: pins.vkId,
        maxSeenKver: pins.maxSeenKver,
        needsPassword: false,
        expectedVaultId: pins.vaultId!,
        adoptedAuth: pins.adopted!.auth,
        adoptedDigest: pins.adopted!.digest,
      }),
    ).toMatchObject({ kind: "local", pin: cvk.id, note: "pin_ahead" });
    void KEYS;
  }, 60_000);
});
