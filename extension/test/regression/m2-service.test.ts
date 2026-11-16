// M2's service changes and sync flows (SYNC-DESIGN §3.5, §3.9, §4.3, §4.4, §4.6, §4.13, §4.14; §0.0i req. 2, 9, 10, 12,
// 13, 15). Every flow goes through the service's own steps: one transact, the marker, the pins after the commit, the
// session, the one cleanup entry point.
import { describe, expect, it } from "vitest";
import { utf8 } from "../../src/core/crypto/bytes";
import { decryptVault, encryptVault, type EncryptedVault } from "../../src/core/crypto/envelope";
import {
  retirePreviousVk,
  setPassword,
  unlockWithRecoveryCode,
  unwrapPreviousVks,
  type Keyring,
} from "../../src/core/crypto/keyring";
import { generateVk, type Vk } from "../../src/core/crypto/vk";
import {
  checkGeneration,
  checkKeyringCopy,
  checkSnapshot,
  KEYS,
  parseSnapshotIndex,
} from "../../src/core/storage/format";
import { MemoryKV } from "../../src/core/storage/kv";
import { SecurityLog } from "../../src/core/service/security-log";
import { MergeBlocked } from "../../src/core/service/sync-flows";
import { openDeviceBackup } from "../../src/core/sync/crypto/device-backup";
import { adoptedRecord } from "../../src/core/sync/crypto/keybundle";
import { preSendCheck, published } from "../../src/core/sync/crypto/presend";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { MAX_ENVELOPE_BYTES, uploadEnvelopeBytes } from "../../src/core/sync/local/size";
import { canonicalJson } from "../../src/core/vault/merge";
import { parseHlc } from "../../src/core/vault/hlc";
import { aliveEntries, emptyVault, isPurged, type Vault } from "../../src/core/vault/model";
import { addEntry, deleteEntry, editEntry, OpError, purgeEntry } from "../../src/core/vault/ops";
import { deserializeVault, LIMITS, serializeVault } from "../../src/core/vault/validate";
import { createClock } from "../../src/core/vault/hlc";
import { codeOf, createProtected, NO_PAGE, STRONG } from "../helpers/vaults";
import {
  adoptByUnlock,
  adoptSameVk,
  bundleFor,
  factsOf,
  input,
  m2World,
  markSyncOn,
  newCode,
  newIdentity,
  publishedOf,
  rotated,
  secretOf,
  steadyState,
  vaultWith,
  type M2World,
} from "../helpers/m2-world";

const names = async (w: M2World, s = w.svc()) =>
  aliveEntries((await s.read()).vault)
    .map((e) => e.issuer)
    .sort();
const vaultNow = async (w: M2World): Promise<Vault> =>
  deserializeVault(await decryptVault((await w.active()).envelope, await w.sessionVk()));
const opensCode = (k: Keyring, c: string) =>
  unlockWithRecoveryCode(k, c).then(
    () => true,
    () => false,
  );
const snapRecs = (m: MemoryKV) =>
  [...m.data]
    .filter(([k]) => k.startsWith("sk_snap_") && k !== KEYS.snapIndex)
    .map(([, v]) => v as { envelope: EncryptedVault });

/** Another secret under an existing id (no honest edit does that, I8): what the guard's secretChanged is for. */
const forge = (v: Vault, id: string, secret: string, c: ReturnType<typeof createClock>): Vault => ({
  ...v,
  entries: v.entries.map((e) => (e.id === id ? { ...e, secret, hlc: c.next() } : e)),
});

/** A remote copy of this device's vault (same vault id): decrypted, then edited as another device would. */
async function remoteOf(w: M2World, edit: (v: Vault, c: ReturnType<typeof createClock>) => Vault): Promise<Vault> {
  const v = await vaultNow(w);
  const c = createClock("bbbb", { now: () => w.t.now + 1000 });
  for (const e of v.entries) c.observe(e.hlc);
  return edit(v, c);
}

describe("mutate with sync on: the size check (§4.3 D3) and the corrected clock (§4.14)", () => {
  it("the clock runs on the server-corrected time with sync on, on this machine's with sync off", async () => {
    const w = m2World();
    await vaultWith(w, ["GitHub"]);
    await w.add(w.svc(), "Off");
    markSyncOn(w.kv, { v: 1, lastSynced: null, serverOffsetMs: 2 * 24 * 3_600_000 });
    await w.add(w.svc(), "On");
    const v = await vaultNow(w);
    const wall = (n: string) => parseHlc(v.entries.find((e) => e.issuer === n)!.hlc)!.wall;
    expect(wall("Off")).toBe(w.t.now - 60_000);
    expect(wall("On")).toBe(w.t.now + 2 * 24 * 3_600_000);
  });

  it("a vault over the limit: growing edits are refused (too_large_for_sync); trash and erase are allowed even when the measure grows; shrinking is allowed; sync off checks nothing", async () => {
    const w = m2World();
    await vaultWith(w, []);
    // about 9 MiB of accounts at the field limits (sync off: nothing is checked)
    const big = (i: number) => ({
      ...input(`I${i}`.padEnd(LIMITS.text, "i"), secretOf(`s${i}`)),
      label: "l".repeat(LIMITS.text),
      domains: Array.from({ length: LIMITS.domains }, (_, k) => `${k}`.padEnd(LIMITS.domain, "d")),
    });
    await w.svc().mutate((v, c) => {
      let x = v;
      for (let i = 0; i < 1400; i++) x = addEntry(x, big(i), c).vault;
      return x;
    });
    await w.svc().mutate((v, c) => {
      let x = v;
      for (let i = 0; i < 5; i++) x = addEntry(x, big(9000 + i), c).vault;
      return x;
    }); // +23 KB, sync off
    markSyncOn(w.kv);
    const s = w.svc();
    const sizeOf = async () => (await w.active()).envelope.ciphertext.length;
    const before = await sizeOf();
    expect(
      uploadEnvelopeBytes((await decryptVault((await w.active()).envelope, await w.sessionVk())).length, {
        vaultId: "x".repeat(22),
        vkId: "0".repeat(16),
      }),
    ).toBeGreaterThan(MAX_ENVELOPE_BYTES + 64 * 1024); // over the limit
    // more than one 16 KiB bucket more: refused, nothing written
    await expect(
      s.mutate((v, c) => {
        let x = v;
        for (let i = 0; i < 5; i++) x = addEntry(x, big(8000 + i), c).vault;
        return x;
      }),
    ).rejects.toMatchObject({ code: "too_large_for_sync" });
    expect(await sizeOf()).toBe(before);
    // the same size: allowed
    const ids = (await vaultNow(w)).entries.slice(0, 5).map((e) => e.id);
    await s.mutate((v, c) => ids.reduce((x, i) => editEntry(x, i, { label: "".padEnd(LIMITS.text, "L") }, c), v));
    // to the trash: allowed although it grows across a bucket (`deleted` and `dhlc` on 400 accounts, about 24 KB)
    const victims = (await vaultNow(w)).entries.slice(0, 400).map((e) => e.id);
    await s.mutate((v, c) => victims.reduce((x, i) => deleteEntry(x, i, c), v));
    expect(await sizeOf()).toBeGreaterThan(before);
    // erased for good (what purgeForever's own edit is): allowed
    await s.mutate((v, c) => victims.reduce((x, i) => purgeEntry(x, i, c), v));
    expect((await vaultNow(w)).entries.filter((e) => victims.includes(e.id)).every(isPurged)).toBe(true);
    // shrinking is allowed whatever the size
    const id = (await vaultNow(w)).entries.find((e) => !isPurged(e))!.id;
    await s.mutate((v, c) => editEntry(v, id, { label: "" }, c));
    expect((await vaultNow(w)).entries.find((e) => e.id === id)!.label).toBe("");
  }, 600_000);

  it("the outbox hook (M3) runs after each commit of new data, inside the save, with the key and the vault; not for a no-change save, not with sync off", async () => {
    const w = m2World();
    await vaultWith(w, ["GitHub"]);
    const seen: { seq: number; vk: string; n: number }[] = [];
    const port = {
      context: async () => (w.kv.data.has(SYNC_KEYS.cfg) ? { offsetMs: 0 } : null),
      clearLastSynced: async () => undefined,
      afterCommit: async (c: { gen: { seq: number }; vk: Vk; vault: Vault }) => {
        seen.push({ seq: c.gen.seq, vk: c.vk.id, n: c.vault.entries.length });
      },
    };
    const s = w.svc(w.kv, w.mirror, w.session, { sync: port });
    await w.add(s, "Off");
    expect(seen).toEqual([]);
    markSyncOn(w.kv);
    await w.add(s, "On");
    await s.mutate((v) => v);
    const g = await w.active();
    expect(seen).toEqual([{ seq: g.seq - 1, vk: g.keyring.vkId, n: 3 }]);
  });

  it("§0.0i req. 12: an ordinary edit keeps the keyring byte for byte (no marker), and so does applyRemote", async () => {
    const w = m2World();
    await vaultWith(w, ["GitHub", "AWS"], { syncOn: true });
    await w.svc().openView(); // the one-time check
    const before = canonicalJson((await w.active()).keyring);
    await w.add(w.svc(), "Stripe");
    expect(canonicalJson((await w.active()).keyring)).toBe(before);
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
    const remote = await remoteOf(w, (v, c) => addEntry(v, input("Remote", secretOf("Remote")), c).vault);
    expect((await w.flows().applyRemote(remote)).changed).toBe(true);
    expect(canonicalJson((await w.active()).keyring)).toBe(before);
    expect(canonicalJson(checkKeyringCopy(w.kv.data.get(KEYS.keyringCopy))!.keyring)).toBe(before);
  });
});

describe("applyRemote (§4.2 step 5, §4.6)", () => {
  it("merges both sides in one save: rev+1, the same keyring byte for byte and no marker (§0.0i item 2, revision 12: nothing to clean up after it), the state it replaced kept as the newest rolling snapshot (put back if it was missing), the checksum returned is the active one", async () => {
    const w = m2World();
    await vaultWith(w, ["GitHub", "AWS"], { syncOn: true });
    await w.svc().openView();
    await w.add(w.svc(), "LocalOnly");
    const pre = await w.active();
    // the current state's own rolling snapshot is gone (rotated out, a failed write): applyRemote puts it back first
    w.kv.data.delete(KEYS.snap(`r${pre.seq}`));
    w.kv.data.set(
      KEYS.snapIndex,
      parseSnapshotIndex(w.kv.data.get(KEYS.snapIndex)).filter((m) => m.id !== `r${pre.seq}`),
    );
    const remote = await remoteOf(w, (v, c) => {
      const gh = v.entries.find((e) => e.issuer === "GitHub")!;
      return addEntry(
        editEntry(
          v.entries.some((e) => e.issuer === "LocalOnly")
            ? { ...v, entries: v.entries.filter((e) => e.issuer !== "LocalOnly") }
            : v,
          gh.id,
          { label: "renamed" },
          c,
        ),
        input("RemoteOnly", secretOf("RemoteOnly")),
        c,
      ).vault;
    });
    const r = await w.flows().applyRemote(remote);
    const g = await w.active();
    expect(r).toMatchObject({ changed: true, checksum: g.envelope.checksum });
    expect(g.envelope.rev).toBe(pre.envelope.rev + 1);
    expect(canonicalJson(g.keyring)).toBe(canonicalJson(pre.keyring));
    expect(await names(w)).toEqual(["AWS", "GitHub", "LocalOnly", "RemoteOnly"]); // never a replacement: the local-only one stays
    expect((await vaultNow(w)).entries.find((e) => e.issuer === "GitHub")!.label).toBe("renamed");
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
    const lv = await w.store().loadView();
    expect(lv.status === "ok" && lv.cleanup).toBe("none");
    const idx = parseSnapshotIndex(w.kv.data.get(KEYS.snapIndex))
      .filter((m) => m.kind === "rolling")
      .sort((a, b) => b.seq - a.seq);
    expect(idx.map((m) => m.seq).slice(0, 2)).toEqual([g.seq, pre.seq]);
    expect((await checkSnapshot(w.kv.data.get(KEYS.snap(`r${pre.seq}`))))!.envelope.checksum).toBe(
      pre.envelope.checksum,
    );
  });
  it("a merge that changes nothing writes nothing at all (I10) and returns the current checksum", async () => {
    const w = m2World();
    await vaultWith(w, ["GitHub"], { syncOn: true });
    await w.svc().openView();
    const remote = await vaultNow(w);
    const before = JSON.stringify([...w.kv.data]);
    const r = await w.flows().applyRemote(remote);
    expect(r).toMatchObject({ changed: false, checksum: (await w.active()).envelope.checksum });
    expect(JSON.stringify([...w.kv.data])).toBe(before);
  });
  it("refuses, writing nothing: another vault (I6), a newer schema on either side (R1), locked (the remote is not kept)", async () => {
    const w = m2World();
    await vaultWith(w, ["GitHub"], { syncOn: true });
    const mine = await vaultNow(w);
    const before = () => JSON.stringify([...w.kv.data].filter(([k]) => k !== "sk_security_log"));
    const b0 = before();
    await expect(w.flows().applyRemote({ ...mine, vaultId: "another-vault-01" })).rejects.toMatchObject({
      code: "different_vault",
    });
    await expect(w.flows().applyRemote({ ...mine, schemaVersion: 2 } as unknown as Vault)).rejects.toMatchObject({
      code: "newer_schema",
    });
    expect(before()).toBe(b0);
    // local: a newer schema in the active slot
    const vk = await w.sessionVk();
    const act = await w.active();
    const future = await encryptVault(
      utf8(JSON.stringify({ schemaVersion: 2, vaultId: act.keyring.vaultId, entries: [] })),
      vk,
      { vaultId: act.keyring.vaultId, rev: 50 },
    );
    w.kv.data.set(KEYS.slot[w.kv.data.get(KEYS.active) as "a" | "b"], { ...act, envelope: future });
    const b1 = before();
    await expect(w.flows().applyRemote(mine)).rejects.toMatchObject({ code: "newer_schema" });
    expect(before()).toBe(b1);
    const v = m2World();
    await vaultWith(v, ["GitHub"], { syncOn: true });
    const r = await vaultNow(v);
    await v.svc().lock();
    const b2 = JSON.stringify([...v.kv.data]);
    await expect(v.flows().applyRemote(r)).rejects.toMatchObject({ code: "locked" });
    expect(JSON.stringify([...v.kv.data])).toBe(b2);
  });
  it("the guard (§4.4): a remote that erases an account alive here is stopped, nothing written; Apply accepts it; Keep mine re-declares it so it wins", async () => {
    const w = m2World();
    await vaultWith(w, ["GitHub", "AWS"], { syncOn: true });
    const id = (await vaultNow(w)).entries.find((e) => e.issuer === "GitHub")!.id;
    const remote = await remoteOf(w, (v, c) => purgeEntry(v, id, c));
    const b0 = JSON.stringify([...w.kv.data]);
    const err = await w
      .flows()
      .applyRemote(remote)
      .catch((e) => e);
    expect(err).toBeInstanceOf(MergeBlocked);
    const blocked = err as MergeBlocked;
    expect(blocked.report.purgedAlive).toEqual([id]);
    expect(Object.keys(blocked.seen)).toEqual([id]);
    expect(JSON.stringify(blocked.seen)).not.toContain(secretOf("GitHub")); // a digest, never the content
    expect(JSON.stringify([...w.kv.data])).toBe(b0);
    // keep mine: the account comes out alive, with this device's content, stamped after the erase
    await w.flows().applyRemote(remote, { seen: blocked.seen, keepMine: [id] });
    const kept = (await vaultNow(w)).entries.find((e) => e.id === id)!;
    expect([kept.issuer, kept.secret, kept.deleted]).toEqual(["GitHub", secretOf("GitHub"), false]);
    const erased = remote.entries.find((e) => e.id === id)!;
    expect(kept.hlc > erased.hlc && kept.dhlc! > erased.dhlc!).toBe(true);
    // the next sync of the same remote now merges to "kept" (it wins), and the guard has nothing to say
    expect((await w.flows().applyRemote(remote)).changed).toBe(false);
    // Apply: the erase is accepted
    const v = m2World();
    await vaultWith(v, ["GitHub", "AWS"], { syncOn: true });
    const id2 = (await vaultNow(v)).entries.find((e) => e.issuer === "AWS")!.id;
    const remote2 = await remoteOf(v, (x, c) => purgeEntry(x, id2, c));
    const seen2 = (
      (await v
        .flows()
        .applyRemote(remote2)
        .catch((e) => e)) as MergeBlocked
    ).seen;
    await v.flows().applyRemote(remote2, { seen: seen2, accept: [id2] });
    expect(await names(v)).toEqual(["GitHub"]);
  });
  it("M2R-11: an answer covers only what it names (R22: answering one of two blocking ids still stops), and only the remote versions the user reviewed (a secret changed again before Apply's re-pull stops it again)", async () => {
    const w = m2World();
    await vaultWith(w, ["GitHub", "AWS", "Stripe"], { syncOn: true });
    const mine = await vaultNow(w);
    const [gh, aws] = ["GitHub", "AWS"].map((n) => mine.entries.find((e) => e.issuer === n)!.id) as [string, string];
    const remote = await remoteOf(w, (v, c) => forge(purgeEntry(v, gh, c), aws, secretOf("forged"), c));
    const blocked = (await w
      .flows()
      .applyRemote(remote)
      .catch((e) => e)) as MergeBlocked;
    expect([blocked.report.purgedAlive, blocked.report.secretChanged]).toEqual([[gh], [aws]]);
    const b0 = JSON.stringify([...w.kv.data]);
    for (const partial of [{ accept: [gh] }, { keepMine: [aws] }, { accept: [aws] }]) {
      await expect(w.flows().applyRemote(remote, { seen: blocked.seen, ...partial })).rejects.toBeInstanceOf(
        MergeBlocked,
      );
    }
    // the same ids answered for another remote version of one of them: stopped again, with the new version's digest
    const again = await remoteOf(w, (v, c) => forge(purgeEntry(v, gh, c), aws, secretOf("forged-again"), c));
    const err = (await w
      .flows()
      .applyRemote(again, { seen: blocked.seen, accept: [gh, aws] })
      .catch((e) => e)) as MergeBlocked;
    expect(err).toBeInstanceOf(MergeBlocked);
    expect(err.seen[gh]).toBe(blocked.seen[gh]);
    expect(err.seen[aws]).not.toBe(blocked.seen[aws]);
    expect(JSON.stringify([...w.kv.data])).toBe(b0);
    // answered in full for what was reviewed: it goes through
    await w.flows().applyRemote(again, { seen: err.seen, accept: [gh, aws] });
    expect((await vaultNow(w)).entries.find((e) => e.id === aws)!.secret).toBe(secretOf("forged-again"));
  });
  it("R23, R24: a changed secret on an account in this device's trash still stops the merge; Keep mine keeps this device's version in its trash (content and life), and never brings it back", async () => {
    const w = m2World();
    await vaultWith(w, ["GitHub", "AWS"], { syncOn: true });
    const id = (await vaultNow(w)).entries.find((e) => e.issuer === "AWS")!.id;
    await w.svc().mutate((v, c) => deleteEntry(v, id, c));
    const remote = await remoteOf(w, (v, c) => forge(v, id, secretOf("forged"), c));
    const blocked = (await w
      .flows()
      .applyRemote(remote)
      .catch((e) => e)) as MergeBlocked;
    expect(blocked).toBeInstanceOf(MergeBlocked);
    expect(blocked.report.secretChanged).toEqual([id]);
    await w.flows().applyRemote(remote, { seen: blocked.seen, keepMine: [id] });
    const v = await vaultNow(w);
    const e = v.entries.find((x) => x.id === id)!;
    expect(e.secret).toBe(secretOf("AWS"));
    expect(aliveEntries(v).map((x) => x.issuer)).toEqual(["GitHub"]); // still in the trash
    expect(e.deleted === true && e.dhlc! > e.hlc && e.hlc > remote.entries.find((x) => x.id === id)!.hlc).toBe(true);
  });
});

describe("commitKeys: a key commit after a sync key operation (§3.6-§3.9, §4.13), only with keys M1 issued (§0.0i item 16)", () => {
  /** Enrolled and in sync at kver 4: the local keyring is the bundle's, the identity pinned to it (adopted = that bundle). */
  async function enrolled(w: M2World) {
    const r = await vaultWith(w, ["GitHub", "AWS"], { syncOn: true });
    return { ...r, ...(await steadyState(w, 4)) };
  }
  const stateOf = (w: M2World) => w.kv.data.get(SYNC_KEYS.state) as { lastSynced: unknown; pendingPins?: unknown };

  it("same VK, a new recovery code from another device (R2): the bundle's keyring itself, one transact; pins after it (adopted = M1's adoptedRecord, maxSeenKver never lowered), the pending copy cleared; keys_adopted; the old code gone from every copy after the cleanup", async () => {
    const w = m2World();
    const log = new SecurityLog({ kv: w.kv, now: () => w.t.now });
    const { recoveryCode: old, vk, vaultId, bundle: k4 } = await enrolled(w);
    const g = await w.active();
    const { keyring: k2, recoveryCode } = await newCode(g.keyring, vk);
    const bundle = await bundleFor(vk, k2, 9, k4.auth); // the auth changes only with the password wrap (F-07)
    w.kv.data.set(SYNC_KEYS.state, { v: 1, lastSynced: { version: 3, head: "h", checksum: "c" } });
    const keys = await adoptSameVk({ ...(await factsOf(w.local(), vaultId)), bundle, vk, local: g.keyring });
    expect(keys).toEqual({ kind: "adopt", maxSeenKver: 9 });
    const s = w.svc(w.kv, w.mirror, w.session, { security: log });
    await w.flows(s).commitKeys({ keys, record: "keys_adopted" });
    const a = await w.active();
    expect(canonicalJson(a.keyring)).toBe(canonicalJson(bundle.keyring));
    expect(a.envelope.vkId).toBe(vk.id);
    expect(await opensCode(a.keyring, recoveryCode)).toBe(true);
    const id = await w.local().identity.get();
    expect(id).toMatchObject({
      vkId: vk.id,
      vaultId: g.keyring.vaultId,
      maxSeenKver: 9,
      adopted: await adoptedRecord(bundle),
    });
    expect(stateOf(w)).toEqual({ v: 1, lastSynced: null }); // cleared, and the pending pins gone once IndexedDB has them
    expect((await log.read()).entries.map((e) => e.kind)).toEqual(["keys_adopted"]);
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false); // the cleanup ran through the one entry point
    for (const [k, v] of [...w.kv.data, ...w.mirror.data]) {
      const kr = k === KEYS.keyringCopy ? checkKeyringCopy(v)?.keyring : (await checkGeneration(v))?.keyring;
      if (kr) expect(await opensCode(kr, old), k).toBe(false); // P-5: the old code opens nothing current
    }
    // an adoption M1 made on stale facts (maxSeenKver 0) never lowers maxSeenKver
    const k3 = (await newCode(a.keyring, vk)).keyring;
    const low = await adoptSameVk({
      bundle: await bundleFor(vk, k3, 2, k4.auth),
      vk,
      local: a.keyring,
      maxSeenKver: 0,
      expectedVaultId: vaultId,
      adoptedAuth: null,
      adoptedDigest: null,
    });
    await w.flows(s).commitKeys({ keys: low });
    expect(await w.local().identity.get()).toMatchObject({ maxSeenKver: 9 });
  });
  it("another VK (R3, §3.8 P4 on another device): unlockWithSync's adoption; the local data opened with the old key the bundle's previous list unwraps, merged with the remote, under the new key; the session moves on; the cleanup moves snapshots and the sync copy to the new key", async () => {
    const w = m2World();
    const { vk: vk1, vaultId } = await enrolled(w);
    const g = await w.active();
    // the sync copy of the device key, under VK1 (written as the first device does, §3.1 step 5)
    const { id: idn, jwk } = await newIdentity();
    await w
      .local()
      .cfg.write(vk1, { deviceId: idn.deviceId, apiOrigin: idn.apiOrigin, dsk: jwk, email: "me@example.com" });
    const r2 = await rotated(g.keyring, vk1);
    const bundle = await bundleFor(r2.vk, r2.keyring, 10);
    const remote = await remoteOf(w, (v, c) => addEntry(v, input("Remote", secretOf("Remote")), c).vault);
    const keys = await adoptByUnlock({
      ...(await factsOf(w.local(), vaultId)),
      secret: { password: STRONG },
      local: g.keyring,
      remote: bundle,
      needsPassword: true,
    });
    await w.flows().commitKeys({ keys, remote, record: "keys_adopted" });
    const a = await w.active();
    expect([a.envelope.vkId, a.keyring.vkId]).toEqual([r2.vk.id, r2.vk.id]);
    expect((await w.sessionVk()).id).toBe(r2.vk.id);
    expect(await names(w)).toEqual(["AWS", "GitHub", "Remote"]);
    expect(snapRecs(w.kv).every((r) => r.envelope.vkId === r2.vk.id)).toBe(true);
    expect(snapRecs(w.mirror).every((r) => r.envelope.vkId === r2.vk.id)).toBe(true);
    const cfg = w.kv.data.get(SYNC_KEYS.cfg) as { enc: { vkId: string } };
    expect(cfg.enc.vkId).toBe(r2.vk.id); // the record went through the cleanup entry point
    expect(
      (await openDeviceBackup(r2.vk, { vaultId: g.keyring.vaultId, deviceId: idn.deviceId }, cfg.enc as never)).email,
    ).toBe("me@example.com");
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
    expect(await w.local().identity.get()).toMatchObject({
      vkId: r2.vk.id,
      maxSeenKver: 10,
      adopted: await adoptedRecord(bundle),
    });
  });
  it("a key operation this device published (§3.7): published() from the pre-send check's VerifiedServerBundle and the sent bundle; refused for a bundle the secret does not open or that is not the server's continuation", async () => {
    const w = m2World();
    const { vk, bundle: server } = await enrolled(w);
    const g = await w.active();
    const r = await newCode(g.keyring, vk);
    const sent = await bundleFor(vk, r.keyring, 5, server.auth);
    const keys = await publishedOf({
      server,
      local: g.keyring,
      vk,
      op: "change_recovery",
      sent,
      sentVk: vk,
      sentSecret: { recoveryCode: r.recoveryCode },
    });
    expect(keys).toEqual({ kind: "published", bundle: sent, maxSeenKver: 5 });
    await w.flows().commitKeys({ keys, record: "recovery_code_new" });
    expect(canonicalJson((await w.active()).keyring)).toBe(canonicalJson(sent.keyring));
    expect(await w.local().identity.get()).toMatchObject({ maxSeenKver: 5, adopted: await adoptedRecord(sent) });
    // what published() refuses (no capability is made)
    const r3 = await newCode(sent.keyring, vk);
    const next = await bundleFor(vk, r3.keyring, 6, server.auth);
    const base = { server: sent, local: (await w.active()).keyring, vk, op: "change_recovery" as const, sentVk: vk };
    await expect(
      publishedOf({ ...base, sent: next, sentSecret: { recoveryCode: r.recoveryCode } }),
    ).rejects.toMatchObject({ code: "invalid_argument" }); // the old code does not open it
    await expect(
      publishedOf({
        ...base,
        sent: await bundleFor(vk, r3.keyring, 5, server.auth),
        sentSecret: { recoveryCode: r3.recoveryCode },
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" }); // not above the server's kver
    const rot = await rotated(sent.keyring, vk);
    await expect(
      publishedOf({
        ...base,
        sent: await bundleFor(rot.vk, rot.keyring, 6),
        sentVk: rot.vk,
        sentSecret: { recoveryCode: rot.recoveryCode },
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" }); // a new VK is only a rotation
    const k1 = (await w.active()).keyring;
    const dropped = await bundleFor(vk, { ...r3.keyring, previous: [] }, 6, server.auth);
    const v2 = await generateVk();
    const withPrev = await retirePreviousVk(r3.keyring, v2, vk);
    const sentPrev = await bundleFor(vk, withPrev, 6, server.auth);
    expect(k1.previous).toHaveLength(0);
    await expect(
      publishedOf({ ...base, sent: dropped, sentSecret: { recoveryCode: r3.recoveryCode } }),
    ).resolves.toMatchObject({ kind: "published" }); // nothing to drop
    await expect(
      publishedOf({
        ...base,
        server: sentPrev,
        local: sentPrev.keyring,
        sent: await bundleFor(vk, { ...withPrev, previous: [] }, 7, server.auth),
        sentSecret: { recoveryCode: r3.recoveryCode },
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" }); // drops a previous key
    const verified = await preSendCheck({
      op: "revoke",
      serverRaw: JSON.stringify(sent),
      secret: { password: STRONG },
      local: k1,
      vk,
      maxSeenKver: 5,
      expectedVaultId: sent.vaultId,
      adoptedAuth: sent.auth,
      adoptedDigest: (await adoptedRecord(sent)).digest,
    });
    if (!verified.ok) throw new Error(verified.reason);
    await expect(
      published({ verified: verified.verified, sent: next, vk, secret: { recoveryCode: r3.recoveryCode } }),
    ).rejects.toMatchObject({ code: "invalid_argument" }); // revoke publishes nothing
    await expect(
      published({
        verified: { ...verified.verified, op: "change_recovery" },
        sent: next,
        vk,
        secret: { recoveryCode: r3.recoveryCode },
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" }); // a copy is not verified
  });
  it("refuses, writing nothing: anything M1 did not issue (built by hand, a copy), another vault's bundle (R01, and the cloud restore's R02), a stale adoption the stored keyring has moved past (PROBE-7: never back to an older VK), a lock-out the stored state shows", async () => {
    const w = m2World();
    const { vk, vaultId, bundle: k4 } = await enrolled(w);
    const g = await w.active();
    const r2 = await rotated(g.keyring, vk);
    const b2 = await bundleFor(r2.vk, r2.keyring, 6);
    const facts = await factsOf(w.local(), vaultId);
    const ok = await adoptByUnlock({
      ...facts,
      secret: { password: STRONG },
      local: g.keyring,
      remote: b2,
      needsPassword: true,
    });
    const before = JSON.stringify([...w.kv.data]);
    const idBefore = structuredClone(w.idb.data.get("identity"));
    const unchanged = () => {
      expect(JSON.stringify([...w.kv.data])).toBe(before);
      expect(w.idb.data.get("identity")).toEqual(idBefore);
    };
    for (const fake of [
      { kind: "adopt", maxSeenKver: 6 },
      { ...ok },
      structuredClone({ kind: "published", bundle: b2, maxSeenKver: 6 }),
    ]) {
      await expect(w.flows().commitKeys({ keys: fake as never })).rejects.toMatchObject({ code: "bad_state" });
    }
    // another vault: an adoption of another account's bundle (M1 was given that vault as the expected one)
    const ow = m2World();
    await vaultWith(ow, ["Cloud"]);
    const other = await bundleFor(await ow.sessionVk(), (await ow.active()).keyring, 6);
    const foreign = await adoptByUnlock({
      ...facts,
      expectedVaultId: other.vaultId,
      secret: { password: STRONG },
      local: null,
      remote: other,
      pinnedVkId: other.keyring.vkId,
      maxSeenKver: 0,
      needsPassword: false,
      adoptedAuth: null,
      adoptedDigest: null,
    });
    await expect(w.flows().commitKeys({ keys: foreign })).rejects.toMatchObject({ code: "different_vault" }); // the pins say this vault (R01)
    await w.local().identity.update((cur) => ({ ...cur, vaultId: null })); // no pinned vault: the stored keyring's check
    await expect(w.flows().commitKeys({ keys: foreign })).rejects.toMatchObject({ code: "different_vault" });
    await w.local().identity.update((cur) => ({ ...cur, vaultId }));
    unchanged();
    // PROBE-7: a VK1 adoption made while VK1 was current, committed after the device moved on to VK2
    const stale = await adoptSameVk({
      ...facts,
      bundle: await bundleFor(vk, (await newCode(g.keyring, vk)).keyring, 5, k4.auth),
      vk,
      local: g.keyring,
    });
    await w.flows().commitKeys({ keys: ok, record: "keys_adopted" });
    const at2 = JSON.stringify([...w.kv.data].filter(([k]) => k !== "sk_security_log"));
    await expect(w.flows().commitKeys({ keys: stale })).rejects.toMatchObject({
      code: "bad_state",
      message: "discontinuous",
    });
    expect((await w.active()).keyring.vkId).toBe(r2.vk.id);
    expect((await w.local().identity.get()) as { vkId: string }).toMatchObject({ vkId: r2.vk.id });
    expect(JSON.stringify([...w.kv.data].filter(([k]) => k !== "sk_security_log"))).toBe(at2);
  });
  it("continuity against what is stored, not what M1 was told: an adoption M1 made on a stale copy of the local keyring (without its previous key) is refused", async () => {
    const w = m2World();
    const { vk, vaultId } = await enrolled(w);
    const g = await w.active();
    // the device rotates (VK2, previous [VK1]); M3 then hands M1 its old copy of the keyring by mistake, rotated afresh
    const r2 = await rotated(g.keyring, vk);
    const b2 = await bundleFor(r2.vk, r2.keyring, 6);
    await w.flows().commitKeys({
      keys: await adoptByUnlock({
        ...(await factsOf(w.local(), vaultId)),
        secret: { password: STRONG },
        local: g.keyring,
        remote: b2,
        needsPassword: true,
      }),
    });
    const local = (await w.active()).keyring;
    expect(local.previous.map((p) => p.vkId)).toEqual([vk.id]);
    const stale = { ...local, previous: [] };
    const k3 = await bundleFor(r2.vk, (await newCode(stale, r2.vk)).keyring, 7, b2.auth);
    const keys = await adoptSameVk({ ...(await factsOf(w.local(), vaultId)), bundle: k3, vk: r2.vk, local: stale });
    const before = JSON.stringify([...w.kv.data]);
    await expect(w.flows().commitKeys({ keys })).rejects.toMatchObject({ code: "bad_state", message: "discontinuous" }); // it would drop VK1
    expect(JSON.stringify([...w.kv.data])).toBe(before);
  });
  it("the lock-out guard where it rests on the stored state: a same-password-wrap adoption after the local password wrap changed; an adopted-back one after the pins moved on", async () => {
    const w = m2World();
    const { vk, vaultId, bundle: server } = await enrolled(w);
    const g = await w.active();
    const facts = await factsOf(w.local(), vaultId);
    const rec = await adoptSameVk({
      ...facts,
      bundle: await bundleFor(vk, (await newCode(g.keyring, vk)).keyring, 7, server.auth),
      vk,
      local: g.keyring,
    });
    // meanwhile this device changed its password (published, committed): the adoption's password wrap is no longer the local one
    const pw2 = await bundleFor(vk, await setPassword(g.keyring, vk, "granite-river-compass-31"), 5, server.auth);
    await w.flows().commitKeys({
      keys: await publishedOf({
        server,
        local: g.keyring,
        vk,
        op: "change_password",
        sent: pw2,
        sentVk: vk,
        sentSecret: { password: "granite-river-compass-31" },
      }),
    });
    const before = JSON.stringify([...w.kv.data]);
    await expect(w.flows().commitKeys({ keys: rec })).rejects.toMatchObject({
      code: "bad_state",
      message: "discontinuous",
    });
    expect(JSON.stringify([...w.kv.data])).toBe(before);
    // adopted back (GM2-5), then the pins name another bundle: refused
    const local = (await w.active()).keyring;
    const k3 = await bundleFor(vk, (await newCode(local, vk)).keyring, 6, server.auth);
    await w.local().identity.update((cur) => ({ ...cur, maxSeenKver: 6 }));
    await w.local().identity.setPins({ vkId: vk.id, vaultId, maxSeenKver: 6, adopted: await adoptedRecord(k3) });
    const back = await adoptSameVk({ ...(await factsOf(w.local(), vaultId)), bundle: k3, vk, local });
    await w.local().identity.setPins({ vkId: vk.id, vaultId, maxSeenKver: 7, adopted: await adoptedRecord(pw2) });
    await expect(w.flows().commitKeys({ keys: back })).rejects.toMatchObject({
      code: "bad_state",
      message: "discontinuous",
    });
    expect(JSON.stringify([...w.kv.data])).toBe(before);
  });
  it("the cloud restore (§4.13): only keys the typed secret opened (unlockWithSync, no local keyring); over lost local data, the recovery hook first (lastSynced cleared), the remote at rev 0 under the bundle's key, a cloud_restore notice, the pins; refused (R02) for another vault than the identity's, or a bundle that cannot reach the pinned key", async () => {
    const w = m2World();
    const { vk, vaultId, bundle: k4 } = await enrolled(w);
    const g = await w.active();
    const remote = await vaultNow(w);
    const bundle = await bundleFor(vk, g.keyring, 6, k4.auth);
    for (const k of [KEYS.slot.a, KEYS.slot.b, KEYS.keyringCopy]) w.kv.data.set(k, { torn: "x" });
    w.mirror.data.clear();
    for (const k of [...w.kv.data.keys()].filter((x) => x.startsWith("sk_snap_"))) w.kv.data.delete(k);
    w.kv.data.set(SYNC_KEYS.state, { v: 1, lastSynced: { version: 9, head: "h", checksum: "c" } });
    expect((await w.svc().openView()).state).toBe("lost");
    const facts = await factsOf(w.local(), vaultId);
    const keys = await adoptByUnlock({
      ...facts,
      secret: { password: STRONG },
      local: null,
      remote: bundle,
      needsPassword: false,
    });
    // not keys the typed secret opened: refused
    const same = await adoptSameVk({
      ...facts,
      bundle: await bundleFor(vk, (await newCode(g.keyring, vk)).keyring, 7, k4.auth),
      vk,
      local: g.keyring,
    });
    await expect(w.flows().commitKeys({ keys: same, remote, overLost: true })).rejects.toMatchObject({
      code: "bad_state",
    });
    await expect(w.flows().commitKeys({ keys })).rejects.toMatchObject({ name: "StorageError" }); // not over lost data unless asked
    // R02: the identity's vault is another; a pinned key the bundle cannot reach
    await w.local().identity.update((cur) => ({ ...cur, vaultId: "another-vault-01" }));
    await expect(w.flows().commitKeys({ keys, remote, overLost: true })).rejects.toMatchObject({
      code: "different_vault",
    });
    await w.local().identity.update((cur) => ({ ...cur, vaultId, vkId: "0123456789abcdef" }));
    await expect(w.flows().commitKeys({ keys, remote, overLost: true })).rejects.toMatchObject({
      code: "bad_state",
      message: "discontinuous",
    });
    await w.local().identity.update((cur) => ({ ...cur, vkId: vk.id }));
    // a pending pin copy of a later commit (its slots lost with the rest) is checked too: it cannot be settled here
    const st = w.kv.data.get(SYNC_KEYS.state);
    w.kv.data.set(SYNC_KEYS.state, {
      v: 1,
      lastSynced: null,
      pendingPins: { vkId: "0123456789abcdef", vaultId, maxSeenKver: 9, adopted: await adoptedRecord(bundle) },
    });
    await expect(w.flows().commitKeys({ keys, remote, overLost: true })).rejects.toMatchObject({
      code: "bad_state",
      message: "discontinuous",
    });
    w.kv.data.set(SYNC_KEYS.state, st);
    await expect(
      w.flows().commitKeys({ keys, remote: { ...remote, vaultId: "another-vault-01" }, overLost: true }),
    ).rejects.toMatchObject({ code: "different_vault" });
    expect((await w.svc().openView()).state).toBe("lost"); // nothing written by any of these
    await w.flows().commitKeys({ keys, remote, overLost: true });
    const v = await w.svc().openView();
    expect(
      v.state === "unlocked" &&
        aliveEntries(v.vault)
          .map((e) => e.issuer)
          .sort(),
    ).toEqual(["AWS", "GitHub"]);
    expect(v.state === "unlocked" && v.events.map((e) => e.kind)).toEqual(["cloud_restore"]);
    expect((await w.active()).envelope.rev).toBe(0);
    expect(stateOf(w).lastSynced).toBeNull();
    expect(await w.local().identity.get()).toMatchObject({ maxSeenKver: 6, adopted: await adoptedRecord(bundle) });
    await expect(w.flows().commitKeys({ keys, remote, overLost: true })).rejects.toMatchObject({ code: "bad_state" }); // a vault is readable now
  });
  it("the pins are written only after the commit: a commit that fails leaves the identity exactly as it was, and its pending copy (which names a keyring that never committed) is dropped by the next settle", async () => {
    const w = m2World();
    const { vk, vaultId, bundle: k4 } = await enrolled(w);
    const g = await w.active();
    const before = structuredClone(w.idb.data.get("identity"));
    const keys = await adoptSameVk({
      ...(await factsOf(w.local(), vaultId)),
      bundle: await bundleFor(vk, (await newCode(g.keyring, vk)).keyring, 11, k4.auth),
      vk,
      local: g.keyring,
    });
    const failing = {
      get: (k: string[]) => w.kv.get(k),
      keys: () => w.kv.keys(),
      remove: (k: string[]) => w.kv.remove(k),
      set: async (i: Record<string, unknown>) => {
        if (KEYS.active in i) throw new Error("IO error");
        await w.kv.set(i);
      },
    };
    await expect(w.flows(w.svc(failing)).commitKeys({ keys })).rejects.toThrow("IO error");
    expect(w.idb.data.get("identity")).toEqual(before);
    expect(stateOf(w).pendingPins).toBeDefined(); // written before the commit, in the same write as lastSynced's clear
    expect(await w.local().settlePins()).toEqual(before);
    expect(stateOf(w).pendingPins).toBeUndefined();
    expect(w.idb.data.get("identity")).toEqual(before);
  });
});

describe("joining another device's vault, the local half (§3.5)", () => {
  async function cloud(_w: M2World, accounts: string[]) {
    // the cloud's vault: another keyring (a first device made it), under its own key and vault id
    const other = m2World();
    await vaultWith(other, accounts);
    const kr = (await other.active()).keyring;
    const vk = await other.sessionVk();
    const remote = deserializeVault(await decryptVault((await other.active()).envelope, vk));
    const bundle = await bundleFor(vk, kr, 4);
    return { kr, vk, remote, bundle };
  }
  async function device(w: M2World) {
    const { id, jwk } = await newIdentity();
    await w.local().identity.put(id);
    return { id, plain: { deviceId: id.deviceId, apiOrigin: id.apiOrigin, dsk: jwk, email: "me@example.com" } };
  }
  it("an empty profile: the cloud's vault at rev 0 under the cloud key; sk_sync_cfg under it; no sk_prejoin; pins; sync_on; the session", async () => {
    const w = m2World();
    const c = await cloud(w, ["GitHub", "AWS"]);
    const d = await device(w);
    const log = new SecurityLog({ kv: w.kv, now: () => w.t.now });
    const s = w.svc(w.kv, w.mirror, w.session, { security: log });
    const p = await w.flows(s).prepareJoin({ bundle: c.bundle, vk: c.vk, remote: c.remote, device: d.plain });
    expect(p).toEqual({ mode: "empty", added: 0, skipped: 0 });
    expect(w.kv.data.size).toBe(0); // nothing written by step one
    await w.flows(s).commitJoin(p);
    const a = await w.active();
    expect(canonicalJson(a.keyring)).toBe(canonicalJson(c.bundle.keyring));
    expect(a.envelope.rev).toBe(0);
    expect(await names(w, s)).toEqual(["AWS", "GitHub"]);
    const cfg = w.kv.data.get(SYNC_KEYS.cfg) as { deviceId: string; enc: { vkId: string } };
    expect(cfg.enc.vkId).toBe(c.vk.id); // the DSK copy under the cloud key, for the cloud vault id
    expect(
      (await openDeviceBackup(c.vk, { vaultId: c.kr.vaultId, deviceId: d.id.deviceId }, cfg.enc as never)).email,
    ).toBe("me@example.com");
    expect(w.kv.data.has(SYNC_KEYS.prejoin)).toBe(false);
    expect(await w.local().identity.get()).toMatchObject({
      vkId: c.vk.id,
      vaultId: c.kr.vaultId,
      maxSeenKver: 4,
      adopted: await adoptedRecord(c.bundle),
    });
    expect((await w.sessionVk()).id).toBe(c.vk.id);
    expect((await log.read()).entries.map((e) => e.kind)).toEqual(["sync_on"]);
    await expect(w.flows(s).commitJoin(p)).rejects.toMatchObject({ code: "bad_state" }); // the handle is spent
  });
  it("this profile has its own vault (another vault id): added mode (dedupe against the cloud's live accounts), every live local account alive in the result, sk_prejoin under the cloud key with the old vault id, the old snapshots moved to the cloud key keeping their vault id (D9)", async () => {
    const w = m2World();
    await vaultWith(w, ["GitHub", "Local1", "Local2"]);
    const localVaultId = (await w.active()).keyring.vaultId;
    const vkLocal = await w.sessionVk();
    const c = await cloud(w, ["GitHub", "AWS"]);
    // the cloud has "GitHub" with the same secret, issuer and label: skipped; and "Local2" only in its trash
    const cl = createClock("cccc", { now: () => w.t.now });
    let remote = addEntry(c.remote, input("Local2", secretOf("Local2")), cl, { id: "cloud-trashed-01" }).vault;
    remote = deleteEntry(remote, "cloud-trashed-01", cl);
    const d = await device(w);
    const p = await w.flows().prepareJoin({ bundle: c.bundle, vk: c.vk, remote, device: d.plain });
    expect(p).toEqual({ mode: "added", added: 2, skipped: 1 });
    await w.flows().commitJoin(p);
    const v = await vaultNow(w);
    expect(v.vaultId).toBe(c.kr.vaultId);
    expect(
      aliveEntries(v)
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["AWS", "GitHub", "Local1", "Local2"]);
    const kept = w.kv.data.get(SYNC_KEYS.prejoin) as { v: 2; items: { envelope: EncryptedVault }[] };
    expect(kept.items).toHaveLength(1); // the list's one entry (§3.5 ④)
    const pj = kept.items[0]!;
    expect([pj.envelope.vkId, pj.envelope.vaultId]).toEqual([c.vk.id, localVaultId]);
    expect(
      aliveEntries(deserializeVault(await decryptVault(pj.envelope, c.vk)))
        .map((e) => e.issuer)
        .sort(),
    ).toEqual(["GitHub", "Local1", "Local2"]);
    const old = snapRecs(w.kv).filter((r) => r.envelope.vaultId === localVaultId);
    expect(old.length).toBeGreaterThan(0);
    expect(old.every((r) => r.envelope.vkId === c.vk.id)).toBe(true); // re-encrypted with the local key held in memory
    expect(snapRecs(w.kv).some((r) => r.envelope.vkId === vkLocal.id)).toBe(false);
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
  });
  it("C6-8: the same vault id under unrelated keys is joined in added mode; the same vault id under related keys merges", async () => {
    const w = m2World();
    const c = await cloud(w, ["GitHub", "AWS"]);
    const keys = await w.svc().prepareKeys(STRONG, { vaultId: c.kr.vaultId }); // e.g. restored from a subset file with that id
    await w.svc().restoreBackup(c.remote, keys);
    const d = await device(w);
    expect((await w.flows().prepareJoin({ bundle: c.bundle, vk: c.vk, remote: c.remote, device: d.plain })).mode).toBe(
      "added",
    );
    // after a join that crashed before complete, the profile holds the cloud's own keyring: related, an ordinary merge
    const v = m2World();
    const d2 = await device(v);
    await v
      .flows()
      .commitJoin(await v.flows().prepareJoin({ bundle: c.bundle, vk: c.vk, remote: c.remote, device: d2.plain }));
    const d3 = await device(v); // the retried enrolment makes a new device identity
    const p = await v.flows().prepareJoin({ bundle: c.bundle, vk: c.vk, remote: c.remote, device: d3.plain });
    expect(p).toEqual({ mode: "merged", added: 0, skipped: 0 });
    // the profile held the cloud keyring before this join: not mistaken for "this join already landed", so the new
    // device's copy of its signing key is written
    await v.flows().commitJoin(p);
    expect((v.kv.data.get(SYNC_KEYS.cfg) as { deviceId: string }).deviceId).toBe(d3.id.deviceId);
  });
  it("R03: a remote of another vault than the bundle's is refused at step one (different_vault), nothing written", async () => {
    const w = m2World();
    await vaultWith(w, ["GitHub"]);
    const c = await cloud(w, ["AWS"]);
    const d = await device(w);
    const before = JSON.stringify([...w.kv.data]);
    await expect(
      w.flows().prepareJoin({
        bundle: c.bundle,
        vk: c.vk,
        remote: { ...c.remote, vaultId: "another-vault-01" },
        device: d.plain,
      }),
    ).rejects.toMatchObject({ code: "different_vault" });
    expect(JSON.stringify([...w.kv.data])).toBe(before);
  });
  it("an sk_prejoin under the cloud key but of another vault (an earlier join's, not this one's) is kept, and the join adds its own beside it", async () => {
    const w = m2World();
    await vaultWith(w, ["GitHub"]);
    const c = await cloud(w, ["AWS"]);
    const d = await device(w);
    await w.local().prejoin.writeInLock(c.vk, utf8("{}"), "old-vault-00001", 1);
    const earlier = structuredClone((w.kv.data.get(SYNC_KEYS.prejoin) as { items: unknown[] }).items[0]);
    await w
      .flows()
      .commitJoin(await w.flows().prepareJoin({ bundle: c.bundle, vk: c.vk, remote: c.remote, device: d.plain }));
    const kept = w.kv.data.get(SYNC_KEYS.prejoin) as { items: { envelope: EncryptedVault }[] };
    expect(kept.items).toHaveLength(2);
    expect(kept.items[0]).toEqual(earlier); // under the cloud key already: nothing to move
    expect(kept.items[1]!.envelope.vaultId).not.toBe("old-vault-00001");
  });
  it("M2R-9: a join whose commit landed although it reported a failure: the retry with the same handle counts as done, and writes its pins inside the lock", async () => {
    const w = m2World();
    await vaultWith(w, ["Mine"]);
    const c = await cloud(w, ["Cloud"]);
    const d = await device(w);
    const p = await w.flows().prepareJoin({ bundle: c.bundle, vk: c.vk, remote: c.remote, device: d.plain });
    // the pointer write lands and throws, and FIXb's write-back of the old generation fails too: committed, told "failed"
    let pointer = false;
    let backFails = false;
    const landsThenThrows = {
      get: (k: string[]) => w.kv.get(k),
      keys: () => w.kv.keys(),
      remove: (k: string[]) => w.kv.remove(k),
      set: async (i: Record<string, unknown>) => {
        if (backFails && (KEYS.slot.a in i || KEYS.slot.b in i)) {
          backFails = false;
          throw new Error("IO error");
        }
        await w.kv.set(i);
        if (!pointer && KEYS.active in i) {
          pointer = true;
          backFails = true;
          throw new Error("IO error after the write");
        }
      },
    };
    await expect(w.flows(w.svc(landsThenThrows)).commitJoin(p)).rejects.toThrow("IO error after the write");
    expect(canonicalJson((await w.active()).keyring)).toBe(canonicalJson(c.bundle.keyring)); // it landed
    expect(await w.local().identity.get()).toMatchObject({ vkId: null, adopted: null }); // its pins did not
    await w.flows().commitJoin(p);
    expect(await w.local().identity.get()).toMatchObject({
      vkId: c.vk.id,
      vaultId: c.kr.vaultId,
      maxSeenKver: 4,
      adopted: await adoptedRecord(c.bundle),
    });
    expect((w.kv.data.get(SYNC_KEYS.state) as { pendingPins?: unknown }).pendingPins).toBeUndefined();
  });
  it("lost local data needs the user's confirmation; a vault that changed since step one is refused, nothing written", async () => {
    const w = m2World();
    await vaultWith(w, ["GitHub"]);
    const c = await cloud(w, ["AWS"]);
    const d = await device(w);
    const p = await w.flows().prepareJoin({ bundle: c.bundle, vk: c.vk, remote: c.remote, device: d.plain });
    await w.add(w.svc(), "Meanwhile");
    const before = JSON.stringify([...w.kv.data]);
    await expect(w.flows().commitJoin(p)).rejects.toMatchObject({ code: "bad_state" });
    expect(JSON.stringify([...w.kv.data])).toBe(before);
    const v = m2World();
    await vaultWith(v, ["GitHub"]);
    for (const k of [KEYS.slot.a, KEYS.slot.b, KEYS.keyringCopy]) v.kv.data.set(k, { torn: "x" });
    v.mirror.data.clear();
    for (const k of [...v.kv.data.keys()].filter((x) => x.startsWith("sk_snap_"))) v.kv.data.delete(k);
    const dv = await device(v);
    const lost = await v.flows().prepareJoin({ bundle: c.bundle, vk: c.vk, remote: c.remote, device: dv.plain });
    expect(lost.mode).toBe("lost");
    await expect(v.flows().commitJoin(lost)).rejects.toMatchObject({ code: "bad_state" });
    const ok = await v
      .flows()
      .prepareJoin({ bundle: c.bundle, vk: c.vk, remote: c.remote, device: dv.plain, confirmLost: true });
    await v.flows().commitJoin(ok);
    expect(await names(v)).toEqual(["AWS"]);
  });
});

describe("§0.0i req. 13 (A4R-12): erasing for good reaches the other vault's copies kept for 'find accounts', by identity", () => {
  it("after a join in added mode, erasing a joined account also clears its secret from the old vault's snapshots; the old vault's other accounts stay", async () => {
    const w = m2World();
    await vaultWith(w, ["Keep", "Erase"]);
    const oldVaultId = (await w.active()).keyring.vaultId;
    const other = m2World();
    await vaultWith(other, ["Cloud"]);
    const vk = await other.sessionVk();
    const bundle = await bundleFor(vk, (await other.active()).keyring, 2);
    const remote = deserializeVault(await decryptVault((await other.active()).envelope, vk));
    const { id, jwk } = await newIdentity();
    await w.local().identity.put(id);
    await w.flows().commitJoin(
      await w.flows().prepareJoin({
        bundle,
        vk,
        remote,
        device: { deviceId: id.deviceId, apiOrigin: id.apiOrigin, dsk: jwk, email: "" },
      }),
    );
    const joined = (await vaultNow(w)).entries.find((e) => e.issuer === "Erase")!;
    const secret = joined.secret;
    const inOld = async () => {
      const out: string[] = [];
      for (const r of snapRecs(w.kv).filter((x) => x.envelope.vaultId === oldVaultId))
        for (const e of deserializeVault(await decryptVault(r.envelope, vk)).entries)
          if (!isPurged(e)) out.push(e.secret);
      return out;
    };
    expect(await inOld()).toContain(secret);
    await w.svc().purgeForever([joined.id], STRONG);
    const left = await inOld();
    expect(left).not.toContain(secret);
    expect(left).toContain(secretOf("Keep"));
    expect(JSON.stringify([...w.kv.data, ...w.mirror.data])).not.toContain(secret);
  });
});

describe("§0.0i req. 10 (GM2-15 / P-8): capPrevious in a rotation, only with no cleanup pending", () => {
  async function full(w: M2World) {
    await createProtected(w.svc());
    const g = await w.active();
    const vk = await w.sessionVk();
    let kr: Keyring = g.keyring;
    for (let i = 0; i < 64; i++) kr = await retirePreviousVk(kr, await generateVk(), vk);
    await w.store().transact(async (cur) => ({ envelope: cur!.envelope, keyring: kr }));
    await w.svc().openView(); // the cleanup the keyring change asked for
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
    return { vk, kr };
  }
  it("a keyring with 64 previous keys rotates to exactly 64: the oldest goes, the key just retired is kept, every kept one unwraps", async () => {
    const w = m2World();
    const { vk, kr } = await full(w);
    await w.svc().rotateKey(STRONG, NO_PAGE);
    const a = await w.active();
    expect(a.keyring.previous).toHaveLength(64);
    expect(a.keyring.previous.at(-1)!.vkId).toBe(vk.id);
    expect(a.keyring.previous.map((p) => p.vkId)).not.toContain(kr.previous[0]!.vkId);
    expect(a.keyring.previous.map((p) => p.vkId)).toEqual([...kr.previous.slice(1).map((p) => p.vkId), vk.id]);
    expect(await unwrapPreviousVks(a.keyring, await w.sessionVk())).toHaveLength(64);
  }, 60_000);
  it("with a cleanup pending, the rotation is refused (cleanup_pending) and writes nothing; once the cleanup ran it goes through", async () => {
    const w = m2World();
    await full(w);
    w.kv.data.set(KEYS.keyChange, { v: 1, vkId: (await w.active()).keyring.vkId, at: 1 });
    const before = JSON.stringify([...w.kv.data]);
    let delivered = 0;
    await expect(
      w.svc().rotateKey(STRONG, {
        onCode: () => {
          delivered++;
        },
      }),
    ).rejects.toMatchObject({ code: "cleanup_pending" });
    expect(delivered).toBe(0);
    expect(JSON.stringify([...w.kv.data])).toBe(before);
    await w.svc().openView();
    await codeOf((d) => w.svc().rotateKey(STRONG, d));
    expect((await w.active()).keyring.previous).toHaveLength(64);
  }, 60_000);
});

describe("C13: 5000 accounts at add time, 50 000 at read time; importBackup's added mode as before", () => {
  it("addEntry refuses the 5001st live account (erased ones do not count); a vault a merge took past 5000 still reads", () => {
    const c = createClock("aaaa", { now: () => 1_700_000_000_000 });
    let v = emptyVault("vault-0123456789");
    const entries = Array.from({ length: LIMITS.entries }, (_, i) => ({ id: `entry-${String(i).padStart(8, "0")}` }));
    v = {
      ...v,
      entries: entries.map((e, i) => addEntry(emptyVault(v.vaultId), input(`I${i}`), c, { id: e.id }).entry),
    };
    expect(() => addEntry(v, input("one more"), c)).toThrow(OpError);
    v = purgeEntry(v, entries[0]!.id, c);
    expect(() => addEntry(v, input("one more"), c)).not.toThrow();
    const bigger = {
      ...v,
      entries: [
        ...v.entries,
        ...Array.from(
          { length: 10 },
          (_, i) =>
            addEntry(emptyVault(v.vaultId), input(`X${i}`), c, { id: `merged-${String(i).padStart(8, "0")}` }).entry,
        ),
      ],
    };
    expect(deserializeVault(serializeVault(bigger)).entries).toHaveLength(LIMITS.entries + 10);
    expect(LIMITS.parsedEntries).toBe(50_000);
  });
  it("importBackup of another vault adds both of two identical accounts, as before M2", async () => {
    const w = m2World();
    await vaultWith(w, ["GitHub"]);
    const c = createClock("dddd", { now: () => 1_700_000_000_000 });
    let b = emptyVault("other-vault-0001");
    b = addEntry(b, input("Twin", secretOf("Twin")), c).vault;
    b = addEntry(b, input("Twin", secretOf("Twin")), c).vault;
    b = addEntry(b, input("GitHub", secretOf("GitHub")), c).vault; // already here: skipped
    expect(await w.svc().importBackup(b)).toEqual({ mode: "added", added: 2 });
    expect(await names(w)).toEqual(["GitHub", "Twin", "Twin"]);
  });
});

describe("the security record's version 2 kinds come from the flows (R8)", () => {
  it("identity_restored and sync_off", async () => {
    const w = m2World();
    const log = new SecurityLog({ kv: w.kv, now: () => w.t.now });
    await vaultWith(w, ["GitHub"]);
    const vk = await w.sessionVk();
    const { id, jwk } = await newIdentity({ state: "enrolled" });
    await w.local().cfg.write(vk, { deviceId: id.deviceId, apiOrigin: id.apiOrigin, dsk: jwk, email: "" });
    const s = w.svc(w.kv, w.mirror, w.session, { security: log });
    await w.flows(s).restoreSyncIdentity({ maxSeenVersion: 3 });
    expect(await w.local().identity.get()).toMatchObject({
      deviceId: id.deviceId,
      maxSeenVersion: 3,
      maxSeenKver: 0,
      adopted: null,
    });
    await w.flows(s).turnOffSync();
    expect((await w.local().status()).kind).toBe("off");
    expect((await log.read()).entries.map((e) => e.kind).reverse()).toEqual(["identity_restored", "sync_off"]);
    expect(w.kv.data.get("sk_security_log")).toMatchObject({ v: 2 });
  });
});
