// M2's service changes that every build still runs (SYNC-DESIGN §0.0i req. 10, 12, 13; C13), over the store and the
// service alone. The server sync's flows that were tested here (applyRemote, commitKeys, the join, the size check and the
// server-corrected clock of a local edit, the security record's sync kinds) went with that sync's client
// (OWNER-DECISIONS/25, DV-0b); what they shared with the rest of the service is tested here without them: an ordinary
// edit's keyring, the permanent delete's reach into a copy of another vault (which the join made, by identity), the cap
// on previous keys in a rotation, and the account limits.
import { describe, expect, it } from "vitest";
import { fromB64 } from "../../src/core/crypto/bytes";
import { decryptVault, encryptVault, type EncryptedVault } from "../../src/core/crypto/envelope";
import { retirePreviousVk, unwrapPreviousVks, type Keyring } from "../../src/core/crypto/keyring";
import { generateVk, vkFromRaw, type Vk } from "../../src/core/crypto/vk";
import { checkGeneration, checkKeyringCopy, KEYS, type Generation } from "../../src/core/storage/format";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession } from "../../src/core/service/types";
import { canonicalJson } from "../../src/core/vault/merge";
import { createClock } from "../../src/core/vault/hlc";
import { aliveEntries, emptyVault, isPurged, type Vault } from "../../src/core/vault/model";
import { addEntry, OpError, purgeEntry } from "../../src/core/vault/ops";
import { deserializeVault, LIMITS, serializeVault } from "../../src/core/vault/validate";
import { TEST_KDF_ITERATIONS } from "../helpers/kdf";
import { codeOf, createProtected, NO_PAGE, STRONG, totpInput as input } from "../helpers/vaults";

/** A distinct valid base32 secret per name, so identities (entryIdentity: the secret) differ. */
function secretOf(name: string): string {
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let h = 7;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return Array.from({ length: 16 }, (_, i) => B32[((h >>> (i % 27)) % 32) ^ (i % 5)]!)
    .join("")
    .replace(/[^A-Z2-7]/g, "A");
}

/** One profile: the store and the service as platform/runtime.ts builds them, over memory. */
function world() {
  const kv = new MemoryKV();
  const mirror = new MemoryKV();
  const session = new MemorySession();
  const t = { now: 1_700_000_000_000 };
  const lock = createMutex();
  const store = () => new VaultStore({ kv, mirror, lock, now: () => t.now });
  const svc = () =>
    new VaultService({
      store: store(),
      session,
      settings: new KvSettingsStore(kv),
      now: () => t.now,
      kdfIterations: TEST_KDF_ITERATIONS,
    });
  const add = async (s: VaultService, n: string) => {
    t.now += 60_000;
    await s.mutate((v, c) => addEntry(v, input(n, secretOf(n)), c).vault);
  };
  const active = async (): Promise<Generation> =>
    (await checkGeneration(kv.data.get(KEYS.slot[kv.data.get(KEYS.active) as "a" | "b"])))!;
  const sessionVk = async (): Promise<Vk> => vkFromRaw(fromB64(session.data!.vk));
  return { kv, mirror, session, t, store, svc, add, active, sessionVk };
}
type World = ReturnType<typeof world>;

/** A protected vault with `names`, unlocked. */
async function vaultWith(w: World, names: string[]) {
  await createProtected(w.svc());
  for (const n of names) await w.add(w.svc(), n);
}
const names = async (w: World) =>
  aliveEntries((await w.svc().read()).vault)
    .map((e) => e.issuer)
    .sort();
const vaultNow = async (w: World): Promise<Vault> =>
  deserializeVault(await decryptVault((await w.active()).envelope, await w.sessionVk()));
const snapRecs = (m: MemoryKV) =>
  [...m.data]
    .filter(([k]) => k.startsWith("sk_snap_") && k !== KEYS.snapIndex)
    .map(([, v]) => v as { envelope: EncryptedVault });

describe("§0.0i req. 12: an ordinary edit", () => {
  it("keeps the keyring byte for byte (no marker), in the slot and in the keyring copy", async () => {
    const w = world();
    await vaultWith(w, ["GitHub", "AWS"]);
    await w.svc().openView(); // the one-time check
    const before = canonicalJson((await w.active()).keyring);
    await w.add(w.svc(), "Stripe");
    expect(canonicalJson((await w.active()).keyring)).toBe(before);
    expect(w.kv.data.has(KEYS.keyChange)).toBe(false);
    expect(canonicalJson(checkKeyringCopy(w.kv.data.get(KEYS.keyringCopy))!.keyring)).toBe(before);
  });
});

describe("§0.0i req. 13 (A4R-12): erasing for good reaches a copy of another vault under a held key, by identity", () => {
  // The server sync's join in added mode kept the joining profile's old vault re-encrypted under the cloud's key, for
  // "find accounts" (§3.5 D9): a snapshot of another vault id, under the current key, holding the same accounts under
  // other ids. No build makes one now; a developer profile that joined may still hold one, and the permanent delete still
  // reaches it (service.ts purgeForever). Written here as the join left it: a snapshot record of its own, which the
  // store lists again (orphans).
  it("the erased account's secret leaves the other vault's copy too; that vault's other accounts stay", async () => {
    const w = world();
    await vaultWith(w, ["Keep", "Erase"]);
    const vk = await w.sessionVk();
    const c = createClock("bbbb", { now: () => w.t.now });
    let old = emptyVault("other-vault-0001");
    for (const n of ["Keep", "Erase", "Mine"]) old = addEntry(old, input(n, secretOf(n)), c).vault;
    const envelope = await encryptVault(serializeVault(old), vk, { vaultId: old.vaultId, rev: 4 });
    w.kv.data.set(KEYS.snap("kept-other-vault"), {
      v: 1,
      meta: { id: "kept-other-vault", kind: "rolling", at: w.t.now, seq: 1 },
      envelope,
    });
    const target = (await vaultNow(w)).entries.find((e) => e.issuer === "Erase")!;
    const inOld = async () => {
      const out: string[] = [];
      for (const r of snapRecs(w.kv).filter((x) => x.envelope.vaultId === old.vaultId))
        for (const e of deserializeVault(await decryptVault(r.envelope, vk)).entries)
          if (!isPurged(e)) out.push(e.secret);
      return out;
    };
    expect(await inOld()).toContain(target.secret); // not vacuous: the other vault's copy holds it
    await w.svc().purgeForever([target.id], STRONG);
    const left = await inOld();
    expect(left).not.toContain(target.secret);
    expect(left).toEqual(expect.arrayContaining([secretOf("Keep"), secretOf("Mine")]));
    expect(JSON.stringify([...w.kv.data, ...w.mirror.data])).not.toContain(target.secret);
  });
});

describe("§0.0i req. 10 (GM2-15 / P-8): capPrevious in a rotation, only with no cleanup pending", () => {
  async function full(w: World) {
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
    const w = world();
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
    const w = world();
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
    const w = world();
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
