// M2 (SYNC-DESIGN §2.5, §4.1, §4.3, §4.4): sync's local side on its own: the reserved keys, the size measure against the
// contract's, the sync state's clear (D1), the device identity and its one-write pins, the two VK-encrypted records'
// cleanup step, the four identity/storage.local combinations, turning sync off, and the merge guard.
import { describe, expect, it } from "vitest";
import { bs, utf8 } from "../../src/core/crypto/bytes";
import { encryptVault } from "../../src/core/crypto/envelope";
import { createKeyring } from "../../src/core/crypto/keyring";
import { generateVk } from "../../src/core/crypto/vk";
import { KEYS } from "../../src/core/storage/format";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { SYNC_CONSTANTS } from "../../src/core/sync/crypto/constants";
import { openDeviceBackup, sealDeviceBackup } from "../../src/core/sync/crypto/device-backup";
import { LABEL, TAG } from "../../src/core/sync/crypto/labels";
import { envelopeSizeBytes, envelopeText, padPlaintext } from "../../src/core/sync/crypto/padding";
import { adoptedRecord } from "../../src/core/sync/crypto/keybundle";
import { blocks, guardMerge, notices } from "../../src/core/sync/local/guard";
import { IdentityStore, parseIdentity, type Pins } from "../../src/core/sync/local/identity";
import { IDENTITY_DB, LOCAL_ONLY_KEYS, SYNC_KEYS, SYNC_OFF_KEYS } from "../../src/core/sync/local/keys";
import {
  DEVICE_BACKUP_LABEL,
  DEVKEY_TAG,
  parseSyncCfg,
  PrejoinRecord,
  SyncCfgRecord,
} from "../../src/core/sync/local/records";
import { KEPT_MAX, keptId, PrejoinWriter, SyncCfgCopy } from "../../src/core/sync/local/record-writers";
import { editFits, exemptFromSizeCheck, MAX_ENVELOPE_BYTES, uploadEnvelopeBytes } from "../../src/core/sync/local/size";
import { lastSyncedOf, MAX_OFFSET_MS, offsetOf, SyncStateStore } from "../../src/core/sync/local/state";
import { pendingFor } from "../../src/core/sync/local/pins";
import { SyncLocal } from "../../src/core/sync/local/sync-local";
import { createClock } from "../../src/core/vault/hlc";
import { emptyVault } from "../../src/core/vault/model";
import { addEntry, deleteEntry, editEntry, purgeEntry, restoreEntry } from "../../src/core/vault/ops";
import { serializeVault } from "../../src/core/vault/validate";
import { bundleOf, keyrings } from "../helpers/sync-keyrings";
import { input, newIdentity } from "../helpers/m2-world";

const clock = () => createClock("aaaa", { now: () => 1_700_000_000_000 });

describe("the reserved names (§3.13, §2.5, R5)", () => {
  it("sk_sync_* and sk_prejoin; turning sync off deletes the five sk_sync_* keys (the orphan too, revision 19) and keeps sk_prejoin; sk_prf and sk_oath are apart", () => {
    expect(SYNC_KEYS).toEqual({
      cfg: "sk_sync_cfg",
      state: "sk_sync_state",
      staged: "sk_sync_staged",
      outbox: "sk_sync_outbox",
      orphan: "sk_sync_orphan",
      prejoin: "sk_prejoin",
    });
    expect([...SYNC_OFF_KEYS].sort()).toEqual(
      Object.values(SYNC_KEYS)
        .filter((k) => k !== SYNC_KEYS.prejoin)
        .sort(),
    );
    expect(Object.values(LOCAL_ONLY_KEYS)).toEqual(["sk_prf", "sk_oath", "sk_pin", "sk_pin_restart"]);
    for (const k of Object.values(LOCAL_ONLY_KEYS)) {
      expect(k.startsWith("sk_sync_")).toBe(false);
      expect(SYNC_OFF_KEYS).not.toContain(k);
    }
    expect(IDENTITY_DB).toBe("sixkey-identity");
  });
  it("none of them is vault data: a profile holding only them opens as empty (hasAnyData)", async () => {
    const kv = new MemoryKV();
    for (const k of [...Object.values(SYNC_KEYS), ...Object.values(LOCAL_ONLY_KEYS), "sk_security_log"])
      kv.data.set(k, { v: 1, x: "anything" });
    const r = await new VaultStore({ kv, mirror: new MemoryKV(), lock: createMutex() }).load();
    expect(r.status).toBe("empty");
  });
});

describe("the size check measures what the contract measures (§4.3 C5)", () => {
  it("the constant is the contract's", () => {
    expect(MAX_ENVELOPE_BYTES).toBe(SYNC_CONSTANTS.MAX_ENVELOPE_BYTES);
    expect(MAX_ENVELOPE_BYTES).toBe(8_388_608);
  });
  it("uploadEnvelopeBytes equals the UTF-8 bytes of the text of the real upload envelope, across 16 KiB bucket edges and revisions", async () => {
    const { keyring, vk } = await createKeyring();
    const B = SYNC_CONSTANTS.PAD_BUCKET_BYTES;
    for (const n of [0, 1, 15, B - 1, B, B + 1, 2 * B - 17, 3 * B + 5]) {
      for (const rev of [0, 1, 9, 10, 99_999, Number.MAX_SAFE_INTEGER]) {
        const pt = utf8("x".repeat(n));
        const env = await encryptVault(padPlaintext(pt), vk, { vaultId: keyring.vaultId, rev });
        expect(uploadEnvelopeBytes(n, { vaultId: keyring.vaultId, vkId: vk.id, rev }), `${n} ${rev}`).toBe(
          envelopeSizeBytes(envelopeText(env)),
        );
      }
    }
  });
  it("without a revision it takes the largest one, so it never measures less than the upload will be", async () => {
    const { keyring, vk } = await createKeyring();
    for (const rev of [0, 5, 123456789]) {
      const env = await encryptVault(padPlaintext(utf8("abc")), vk, { vaultId: keyring.vaultId, rev });
      expect(uploadEnvelopeBytes(3, { vaultId: keyring.vaultId, vkId: vk.id })).toBeGreaterThanOrEqual(
        envelopeSizeBytes(envelopeText(env)),
      );
    }
  });
  it("editFits: refused only when larger AND over the limit", () => {
    const M = MAX_ENVELOPE_BYTES;
    expect([
      editFits(10, 20),
      editFits(M, M),
      editFits(M - 1, M),
      editFits(M, M + 1),
      editFits(M + 5, M + 1),
      editFits(M + 1, M + 1),
    ]).toEqual([true, true, true, false, true, true]);
  });
  it("the exemption is by what the edit did: to the trash and erased for good, never a restore, an edit or an add", () => {
    const c = clock();
    let v = emptyVault("vault-0123456789");
    for (const n of ["a", "b", "c"]) v = addEntry(v, input(n), c, { id: `entry-000000${n}` }).vault;
    const id = "entry-000000a";
    expect(exemptFromSizeCheck(v, deleteEntry(v, id, c))).toBe(true);
    expect(exemptFromSizeCheck(v, purgeEntry(v, id, c))).toBe(true);
    const trashed = deleteEntry(v, id, c);
    expect(exemptFromSizeCheck(trashed, purgeEntry(trashed, id, c))).toBe(true); // erased from the trash
    expect(exemptFromSizeCheck(trashed, restoreEntry(trashed, id, c))).toBe(false);
    expect(exemptFromSizeCheck(v, editEntry(v, id, { label: "renamed" }, c))).toBe(false);
    expect(exemptFromSizeCheck(v, addEntry(v, input("d"), c).vault)).toBe(false);
    expect(exemptFromSizeCheck(v, deleteEntry(editEntry(v, id, { label: "x" }, c), "entry-000000b", c))).toBe(false); // a delete plus an edit
    expect(exemptFromSizeCheck(v, v)).toBe(true);
  });
});

describe("sk_sync_state as the storage layer sees it (§4.1, D1)", () => {
  it("context: null with sync off (no sk_sync_cfg), else the clock offset clamped to ±7 days", async () => {
    const kv = new MemoryKV();
    const st = new SyncStateStore(kv);
    expect(await st.context()).toBeNull();
    kv.data.set(SYNC_KEYS.state, { v: 1, serverOffsetMs: 5000 });
    expect(await st.context()).toBeNull(); // a state alone is not "on"
    kv.data.set(SYNC_KEYS.cfg, { v: 1 });
    expect(await st.context()).toEqual({ offsetMs: 5000 });
    kv.data.set(SYNC_KEYS.state, { v: 1, serverOffsetMs: 30 * 24 * HOUR_MS });
    expect(await st.context()).toEqual({ offsetMs: MAX_OFFSET_MS });
    expect([
      offsetOf({ serverOffsetMs: -9e15 }),
      offsetOf({ serverOffsetMs: "1" }),
      offsetOf(null),
      offsetOf({ serverOffsetMs: Number.NaN }),
    ]).toEqual([-MAX_OFFSET_MS, 0, 0, 0]);
  });
  it("clearLastSynced: lastSynced and the outbox to null in ONE write, every other member kept; with nothing there it writes nothing", async () => {
    const kv = new MemoryKV();
    let sets = 0;
    const counted = {
      get: (k: string[]) => kv.get(k),
      keys: () => kv.keys(),
      remove: (k: string[]) => kv.remove(k),
      set: async (i: Record<string, unknown>) => {
        sets++;
        await kv.set(i);
      },
    };
    const st = new SyncStateStore(counted);
    await st.clearLastSynced();
    expect(sets).toBe(0);
    kv.data.set(SYNC_KEYS.state, {
      v: 1,
      lastSynced: { version: 4, head: "h", checksum: "c" },
      failures: 2,
      serverOffsetMs: 9,
    });
    kv.data.set(SYNC_KEYS.outbox, { base: 4 });
    await st.clearLastSynced();
    expect(sets).toBe(1);
    expect(kv.data.get(SYNC_KEYS.state)).toEqual({ v: 1, lastSynced: null, failures: 2, serverOffsetMs: 9 });
    expect(kv.data.get(SYNC_KEYS.outbox)).toBeNull();
    expect(lastSyncedOf(kv.data.get(SYNC_KEYS.state))).toBeNull();
    await st.clearLastSynced();
    expect(sets).toBe(1); // already clear
    kv.data.set(SYNC_KEYS.state, "garbage");
    await st.clearLastSynced();
    expect(kv.data.get(SYNC_KEYS.state)).toEqual({ v: 1, lastSynced: null });
  });
  it("recoveryHook (the store's beforeRecoveryWrite, revisions 19 and 20 D1): lastSynced to null and the outbox (pushable or merge-only) APPENDED unchanged to sk_sync_orphan's list in ONE write; never over an entry; clearLastSynced never touches the list", async () => {
    const kv = new MemoryKV();
    const writes: string[][] = [];
    const counted = {
      get: (k: string[]) => kv.get(k),
      keys: () => kv.keys(),
      remove: (k: string[]) => kv.remove(k),
      set: async (i: Record<string, unknown>) => {
        writes.push(Object.keys(i).sort());
        await kv.set(i);
      },
    };
    const st = new SyncStateStore(counted);
    await st.recoveryHook();
    expect(writes).toEqual([]); // sync off: nothing
    const ob = {
      v: 1,
      base: 4,
      head: "h",
      from: { version: 4, head: "h", checksum: "c" },
      checksum: "c2",
      envelope: "{}",
      proof: "p",
    };
    kv.data.set(SYNC_KEYS.state, { v: 1, lastSynced: { version: 4, head: "h", checksum: "c" }, failures: 2 });
    kv.data.set(SYNC_KEYS.outbox, ob);
    await st.recoveryHook();
    expect(writes).toEqual([[SYNC_KEYS.orphan, SYNC_KEYS.outbox, SYNC_KEYS.state].sort()]);
    expect(kv.data.get(SYNC_KEYS.state)).toEqual({ v: 1, lastSynced: null, failures: 2 });
    expect(kv.data.get(SYNC_KEYS.outbox)).toBeNull();
    expect(kv.data.get(SYNC_KEYS.orphan)).toEqual({ v: 1, items: [ob] });
    // a second recovery with no outbox: the list stays as it is
    await st.recoveryHook();
    expect(writes.length).toBe(1);
    expect(kv.data.get(SYNC_KEYS.orphan)).toEqual({ v: 1, items: [ob] });
    // the other flows that clear lastSynced (a join, a key commit) delete a live outbox and never touch the list
    kv.data.set(SYNC_KEYS.state, { v: 1, lastSynced: { version: 5, head: "h5", checksum: "c5" } });
    kv.data.set(SYNC_KEYS.outbox, { ...ob, base: 5 });
    await st.clearLastSynced();
    expect(kv.data.get(SYNC_KEYS.outbox)).toBeNull();
    expect(kv.data.get(SYNC_KEYS.orphan)).toEqual({ v: 1, items: [ob] });
    // a merge-only outbox (written while lastSynced is null, R3R-5) at the next recovery: appended as a second entry
    const mo = { v: 1, from: null, checksum: "c6", envelope: '{"local":1}' };
    kv.data.set(SYNC_KEYS.outbox, mo);
    await st.recoveryHook();
    expect(kv.data.get(SYNC_KEYS.orphan)).toEqual({ v: 1, items: [ob, mo] });
    expect(kv.data.get(SYNC_KEYS.outbox)).toBeNull();
    // a stored value that is not a list is kept, as an entry (the engine judges it), never overwritten
    kv.data.set(SYNC_KEYS.orphan, { odd: true });
    kv.data.set(SYNC_KEYS.outbox, mo);
    await st.recoveryHook();
    expect(kv.data.get(SYNC_KEYS.orphan)).toEqual({ v: 1, items: [{ odd: true }, mo] });
  });
  it("turnOff (D11; M3 revision 5, R4R-1: CHANGED from revision 4's 'keeps the parked entries') keeps every orphan entry the calling flow did not report folded, and deletes the key only when none is left", async () => {
    const kv = new MemoryKV();
    const local = new SyncLocal({ local: kv, identity: new MemoryKV(), vaultLock: createMutex() });
    const parked = { v: 1, from: null, checksum: "p", envelope: "{}", parked: { reason: "schema", vkId: null, at: 1 } };
    const folded = { v: 1, from: null, checksum: "f", envelope: "{}" };
    const neverTried = { v: 1, from: null, checksum: "n", envelope: '{"n":1}' };
    for (const k of SYNC_OFF_KEYS) kv.data.set(k, { x: 1 });
    kv.data.set(SYNC_KEYS.orphan, { v: 1, items: [folded, parked, neverTried] });
    await local.turnOff({ folded: [folded] });
    expect([...kv.data.keys()].filter((k) => k.startsWith("sk_sync"))).toEqual([SYNC_KEYS.orphan]);
    expect(kv.data.get(SYNC_KEYS.orphan)).toEqual({ v: 1, items: [parked, neverTried] }); // an unmarked entry stays too
    // a flow that folded nothing (the first upload's undo): every entry stays
    for (const k of SYNC_OFF_KEYS) if (k !== SYNC_KEYS.orphan) kv.data.set(k, { x: 1 });
    await local.turnOff();
    expect(kv.data.get(SYNC_KEYS.orphan)).toEqual({ v: 1, items: [parked, neverTried] });
    // every entry folded: the key goes
    kv.data.set(SYNC_KEYS.orphan, { v: 1, items: [folded] });
    await local.turnOff({ folded: [folded] });
    expect([...kv.data.keys()].filter((k) => k.startsWith("sk_sync"))).toEqual([]);
    // a stored value that is not a list is one entry (R4R-4): kept unless reported folded
    kv.data.set(SYNC_KEYS.orphan, folded);
    await local.turnOff();
    expect(kv.data.get(SYNC_KEYS.orphan)).toEqual({ v: 1, items: [folded] });
    // (M3 revision 6, R5R-2) the live outbox with no intact active generation holding it: moved into the list, never
    // deleted (the m3-rev20 tests check an intact slot, which lets it go, and a slot that fails its integrity check)
    kv.data.delete(SYNC_KEYS.orphan);
    const ob = { v: 1, from: null, checksum: "o", envelope: '{"o":1}' };
    kv.data.set(SYNC_KEYS.outbox, ob);
    await local.turnOff();
    expect([...kv.data.keys()].filter((k) => k.startsWith("sk_sync"))).toEqual([SYNC_KEYS.orphan]);
    expect(kv.data.get(SYNC_KEYS.orphan)).toEqual({ v: 1, items: [ob] });
  });
  it("a read that throws propagates (a recovery must not go ahead on a state that may still say 'in sync')", async () => {
    const st = new SyncStateStore({
      get: async () => {
        throw new Error("IO error");
      },
      set: async () => undefined,
      remove: async () => undefined,
      keys: async () => [],
    });
    await expect(st.clearLastSynced()).rejects.toThrow("IO error");
  });
});
const HOUR_MS = 3_600_000;

describe("the device identity (§2.5)", () => {
  it("round-trips with a non-extractable signing key; a damaged record is 'damaged', never 'missing'", async () => {
    const ids = new IdentityStore(new MemoryKV());
    expect(await ids.get()).toBeNull();
    const { id } = await newIdentity();
    await ids.put(id);
    const back = await ids.get();
    expect(back !== null && back !== "damaged" && back.keyPair.privateKey.extractable).toBe(false);
    expect(back).toMatchObject({ v: 1, deviceId: id.deviceId, state: "pending", vkId: null, adopted: null });
    for (const bad of [
      null,
      5,
      "x",
      { ...id, v: 2 },
      { ...id, deviceId: "short" },
      { ...id, keyPair: {} },
      { ...id, maxSeenKver: -1 },
      { ...id, vkId: "nothex" },
    ])
      expect(parseIdentity(bad), JSON.stringify(bad)).toBe("damaged");
  });
  it("setPins: vkId, vaultId, maxSeenKver and adopted in ONE write; maxSeenKver never goes down; no identity: nothing written", async () => {
    const inner = new MemoryKV();
    let sets = 0;
    const kv = {
      get: (k: string[]) => inner.get(k),
      keys: () => inner.keys(),
      remove: (k: string[]) => inner.remove(k),
      set: async (i: Record<string, unknown>) => {
        sets++;
        await inner.set(i);
      },
    };
    const ids = new IdentityStore(kv);
    const f = await keyrings();
    const adopted = await adoptedRecord(await bundleOf(f.v1, f.k1, 3));
    expect(await ids.setPins({ vkId: f.v1.id, vaultId: f.k1.vaultId, maxSeenKver: 3, adopted })).toBe(false);
    expect(sets).toBe(0);
    await ids.put((await newIdentity({ maxSeenKver: 9 })).id);
    sets = 0;
    expect(await ids.setPins({ vkId: f.v1.id, vaultId: f.k1.vaultId, maxSeenKver: 3, adopted })).toBe(true);
    expect(sets).toBe(1);
    expect(await ids.get()).toMatchObject({ vkId: f.v1.id, vaultId: f.k1.vaultId, maxSeenKver: 9, adopted });
  });
});

describe("the two VK-encrypted records' cleanup step (§0.0i req. 5; the A4R-4 contract)", () => {
  async function world() {
    const kv = new MemoryKV();
    const lock = createMutex();
    const store = new VaultStore({ kv, lock });
    const { keyring, vk } = await createKeyring();
    await store.transact(async () => ({
      envelope: await encryptVault(serializeVault(emptyVault(keyring.vaultId)), vk, {
        vaultId: keyring.vaultId,
        rev: 0,
      }),
      keyring,
    }));
    return { kv, lock, keyring, vk, cfg: new SyncCfgCopy(kv, lock), prejoin: new PrejoinWriter(kv, lock) };
  }
  it("the cfg copy's constants are M1's, and the light re-encryption opens with M1's openDeviceBackup to the same plaintext", async () => {
    expect([DEVKEY_TAG, DEVICE_BACKUP_LABEL]).toEqual([TAG.devkey, LABEL.deviceBackup]);
    const w = await world();
    const old = await generateVk();
    const { jwk } = await newIdentity();
    const deviceId = "qqqqqqqqqqqqqqqqqqqqqg";
    w.kv.data.set(SYNC_KEYS.cfg, {
      v: 1,
      deviceId,
      apiOrigin: "https://api.sixkey.app",
      cursor: { cur: "AAAAAAAAAAAAAAAAAAAAAA==" },
      enc: await sealDeviceBackup(old, { vaultId: w.keyring.vaultId, deviceId }, { dsk: jwk, email: "me@example.com" }),
    });
    expect(await new SyncCfgRecord(w.kv, w.lock).reencrypt(w.vk, [old])).toBe("rewritten");
    const after = w.kv.data.get(SYNC_KEYS.cfg) as { enc: { vkId: string }; cursor: unknown };
    expect(after.enc.vkId).toBe(w.vk.id);
    expect(after.cursor).toEqual({ cur: "AAAAAAAAAAAAAAAAAAAAAA==" });
    const plain = await openDeviceBackup(w.vk, { vaultId: w.keyring.vaultId, deviceId }, after.enc as never);
    expect(plain).toEqual({ dsk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d }, email: "me@example.com" });
    expect((await w.cfg.open(w.keyring.vaultId, w.vk)).plain.email).toBe("me@example.com");
    expect(await new SyncCfgRecord(w.kv, w.lock).reencrypt(w.vk, [old])).toBe("current");
    // the identity's state mirrored in it (M2R-7): one of the three, or absent ("pending"); anything else is damaged
    const rec = w.kv.data.get(SYNC_KEYS.cfg) as Record<string, unknown>;
    for (const state of ["pending", "enrolled", "rejected_by_server", undefined])
      expect(parseSyncCfg({ ...rec, state }), String(state)).not.toBe("damaged");
    for (const state of ["bogus", 1, null]) expect(parseSyncCfg({ ...rec, state }), String(state)).toBe("damaged");
  });
  it("absent, current, under a key none holds (unopenable, kept), damaged (unopenable, kept), the vault on another key (superseded, nothing written)", async () => {
    const w = await world();
    const rec = new SyncCfgRecord(w.kv, w.lock);
    expect(await rec.reencrypt(w.vk, [])).toBe("absent");
    const stranger = await generateVk();
    const { jwk } = await newIdentity();
    const deviceId = "qqqqqqqqqqqqqqqqqqqqqg";
    const sealed = {
      v: 1,
      deviceId,
      apiOrigin: "x",
      enc: await sealDeviceBackup(stranger, { vaultId: w.keyring.vaultId, deviceId }, { dsk: jwk, email: "" }),
    };
    w.kv.data.set(SYNC_KEYS.cfg, structuredClone(sealed));
    expect(await rec.reencrypt(w.vk, [])).toBe("unopenable");
    expect(w.kv.data.get(SYNC_KEYS.cfg)).toEqual(sealed);
    const other = await generateVk();
    expect(await rec.reencrypt(other, [stranger])).toBe("superseded"); // `other` is not the vault's key
    expect(w.kv.data.get(SYNC_KEYS.cfg)).toEqual(sealed);
    // opened for another vault id: the AAD does not match, so it does not open (kept)
    w.kv.data.set(SYNC_KEYS.cfg, {
      ...sealed,
      enc: await sealDeviceBackup(stranger, { vaultId: "another-vault-01", deviceId }, { dsk: jwk, email: "" }),
    });
    expect(await rec.reencrypt(w.vk, [stranger])).toBe("unopenable");
    w.kv.data.set(SYNC_KEYS.cfg, "garbage");
    expect(await rec.reencrypt(w.vk, [stranger])).toBe("unopenable");
    expect(w.kv.data.get(SYNC_KEYS.cfg)).toBe("garbage");
  });
  it("sk_prejoin: moved to the current key with its own vault id and revision; unopenable or damaged, kept (never deleted by itself)", async () => {
    const w = await world();
    const cloudOld = await generateVk();
    await w.prejoin.writeInLock(cloudOld, utf8('{"the":"old vault"}'), "old-vault-00001", 5);
    expect(await new PrejoinRecord(w.kv, w.lock).reencrypt(w.vk, [cloudOld])).toBe("rewritten");
    const list = w.kv.data.get(SYNC_KEYS.prejoin) as {
      v: number;
      items: { at: number; envelope: { vkId: string; vaultId: string; rev: number } }[];
    };
    expect(list.v).toBe(2);
    const p = list.items[0]!;
    expect([list.items.length, p.at, p.envelope.vkId, p.envelope.vaultId, p.envelope.rev]).toEqual([
      1,
      5,
      w.vk.id,
      "old-vault-00001",
      0,
    ]);
    expect(await new PrejoinRecord(w.kv, w.lock).reencrypt(w.vk, [])).toBe("current");
    // a single kept vault as stored before the list (a v1 record) reads as the list's one entry, written as is until a
    // write has to change it
    const single = {
      v: 1,
      at: 1,
      envelope: await encryptVault(utf8("x"), cloudOld, { vaultId: "old-vault-00001", rev: 0 }),
    };
    w.kv.data.set(SYNC_KEYS.prejoin, structuredClone(single));
    expect(await new PrejoinRecord(w.kv, w.lock).reencrypt(w.vk, [])).toBe("unopenable");
    expect(w.kv.data.get(SYNC_KEYS.prejoin)).toEqual(single);
    // a damaged entry beside one that moves: the one moved, the damaged one kept, both on the list
    w.kv.data.set(SYNC_KEYS.prejoin, { v: 2, items: ["garbage", structuredClone(single)] });
    expect(await new PrejoinRecord(w.kv, w.lock).reencrypt(w.vk, [cloudOld])).toBe("rewritten");
    const after = w.kv.data.get(SYNC_KEYS.prejoin) as { items: unknown[] };
    expect(after.items[0]).toBe("garbage");
    expect((after.items[1] as { envelope: { vkId: string } }).envelope.vkId).toBe(w.vk.id);
    // only the user's own confirmed delete removes an entry: exactly those shown
    const ids = await Promise.all(after.items.map(keptId));
    await expect(w.prejoin.discard(["not-on-the-list"])).rejects.toMatchObject({ code: "bad_state" });
    expect(await w.prejoin.discard([ids[0]!])).toBe(1);
    expect((w.kv.data.get(SYNC_KEYS.prejoin) as { items: unknown[] }).items).toHaveLength(1);
    expect(await w.prejoin.discard([ids[1]!])).toBe(1);
    expect(w.kv.data.has(SYNC_KEYS.prejoin)).toBe(false);
  });
  it("sk_prejoin: a list at its bound refuses one more entry (kept_full) and stays as it is; nothing is dropped for room", async () => {
    const w = await world();
    const cloud = await generateVk();
    const full = Array.from({ length: KEPT_MAX.entries }, (_, i) => ({ v: 1, at: i, envelope: { kept: i } }));
    w.kv.data.set(SYNC_KEYS.prejoin, { v: 2, items: structuredClone(full) });
    expect(await w.prejoin.fits(10)).toBe(false);
    await expect(w.prejoin.writeInLock(cloud, utf8("{}"), "new-vault-00001", 9)).rejects.toMatchObject({
      code: "kept_full",
    });
    expect((w.kv.data.get(SYNC_KEYS.prejoin) as { items: unknown[] }).items).toEqual(full);
    // by size too
    w.kv.data.set(SYNC_KEYS.prejoin, {
      v: 2,
      items: [{ v: 1, at: 0, envelope: { big: "x".repeat(KEPT_MAX.bytes - 100) } }],
    });
    expect(await w.prejoin.fits(1000)).toBe(false);
    await expect(w.prejoin.writeInLock(cloud, utf8('{"a":1}'), "new-vault-00001", 9)).rejects.toMatchObject({
      code: "kept_full",
    });
    w.kv.data.delete(SYNC_KEYS.prejoin);
    expect(await w.prejoin.fits(1000)).toBe(true);
  });
  it("sk_prejoin: every join appends its own; an earlier one is kept byte for byte; this very join's retry is not written twice", async () => {
    const w = await world();
    const cloudA = await generateVk();
    const cloudB = await generateVk();
    const before = {
      v: 1,
      at: 1,
      envelope: await encryptVault(utf8('{"first":1}'), cloudA, { vaultId: "first-vault-0001", rev: 0 }),
    };
    w.kv.data.set(SYNC_KEYS.prejoin, structuredClone(before));
    await w.prejoin.writeInLock(cloudB, utf8('{"second":2}'), "second-vault-001", 7);
    await w.prejoin.writeInLock(cloudB, utf8('{"second":2}'), "second-vault-001", 8); // a retry of the same join
    const list = w.kv.data.get(SYNC_KEYS.prejoin) as {
      v: number;
      items: { at: number; envelope: { vaultId: string } }[];
    };
    expect([list.v, list.items.length]).toEqual([2, 2]);
    expect(list.items[0]).toEqual(before);
    expect([list.items[1]!.at, list.items[1]!.envelope.vaultId]).toEqual([7, "second-vault-001"]);
    // a disk that drops the write: the join fails (read back), and what was there stays
    const dropping = {
      get: (k: string[]) => w.kv.get(k),
      keys: () => w.kv.keys(),
      remove: (k: string[]) => w.kv.remove(k),
      set: async () => undefined,
    };
    const stored = structuredClone(w.kv.data.get(SYNC_KEYS.prejoin));
    await expect(
      new PrejoinWriter(dropping, w.lock).writeInLock(cloudA, utf8('{"third":3}'), "third-vault-0001", 9),
    ).rejects.toMatchObject({ code: "verify_failed" });
    expect(w.kv.data.get(SYNC_KEYS.prejoin)).toEqual(stored);
    // a disk that keeps the new entry and loses an earlier one: the read-back covers every entry, so the join fails
    const losing = {
      ...dropping,
      set: async (items: Record<string, unknown>) => {
        const v = items[SYNC_KEYS.prejoin] as { v: 2; items: unknown[] } | undefined;
        await w.kv.set(v ? { [SYNC_KEYS.prejoin]: { v: 2, items: v.items.slice(1) } } : items);
      },
    };
    await expect(
      new PrejoinWriter(losing, w.lock).writeInLock(cloudA, utf8('{"third":3}'), "third-vault-0001", 9),
    ).rejects.toMatchObject({ code: "verify_failed" });
  });
  it("a read that throws propagates (the cleanup stops and keeps the marker)", async () => {
    const w = await world();
    const broken = {
      ...w.kv,
      get: async () => {
        throw new Error("IO error");
      },
      set: (i: Record<string, unknown>) => w.kv.set(i),
      keys: () => w.kv.keys(),
      remove: (k: string[]) => w.kv.remove(k),
    };
    await expect(new SyncCfgRecord(broken, w.lock).reencrypt(w.vk, [])).rejects.toThrow("IO error");
    await expect(new PrejoinRecord(broken, w.lock).reencrypt(w.vk, [])).rejects.toThrow("IO error");
  });
  it("the step takes the vault lock: it waits for a section that holds it", async () => {
    const w = await world();
    let release!: () => void;
    const held = w.lock(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    let done = false;
    const p = new SyncCfgRecord(w.kv, w.lock).reencrypt(w.vk, []).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    release();
    await held;
    await p;
    expect(done).toBe(true);
  });
});

describe("§2.5's four combinations, turning sync off (D11)", () => {
  async function world() {
    const kv = new MemoryKV();
    const idb = new MemoryKV();
    const lock = createMutex();
    const store = new VaultStore({ kv, lock });
    const { keyring, vk } = await createKeyring();
    await store.transact(async () => ({
      envelope: await encryptVault(serializeVault(emptyVault(keyring.vaultId)), vk, {
        vaultId: keyring.vaultId,
        rev: 0,
      }),
      keyring,
    }));
    return { kv, idb, keyring, vk, local: new SyncLocal({ local: kv, identity: idb, vaultLock: lock }) };
  }
  it("off; identity_missing (storage.local has the copy: restored once unlocked, pins from the local keyring, adopted null, maxSeenKver 0); on; cfg_missing; damaged is not missing", async () => {
    const w = await world();
    expect((await w.local.status()).kind).toBe("off");
    const { id, jwk } = await newIdentity({ state: "enrolled", maxSeenKver: 12, maxSeenVersion: 40 });
    await w.local.cfg.write(w.vk, {
      deviceId: id.deviceId,
      apiOrigin: id.apiOrigin,
      dsk: jwk,
      email: "me@example.com",
    });
    expect((await w.local.status()).kind).toBe("identity_missing"); // e.g. GoLogin deleted IndexedDB
    expect(await w.local.cfg.setState("enrolled")).toBe(true); // M3, once init or complete is confirmed (M2R-7)
    const restored = await w.local.restoreIdentity(w.vk, w.keyring, { maxSeenVersion: 41 });
    expect(restored).toMatchObject({
      deviceId: id.deviceId,
      apiOrigin: id.apiOrigin,
      state: "enrolled",
      vkId: w.keyring.vkId,
      vaultId: w.keyring.vaultId,
      maxSeenVersion: 41,
      maxSeenKver: 0,
      adopted: null,
    });
    expect(restored.keyPair.privateKey.extractable).toBe(false);
    // the restored key is the same key: it verifies what the original signs
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, id.keyPair.privateKey, bs(utf8("x")));
    expect(
      await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, restored.keyPair.publicKey, sig, bs(utf8("x"))),
    ).toBe(true);
    expect((await w.local.status()).kind).toBe("on");
    await expect(w.local.restoreIdentity(w.vk, w.keyring)).rejects.toThrow(); // only when missing
    w.kv.data.delete(SYNC_KEYS.cfg);
    expect((await w.local.status()).kind).toBe("cfg_missing");
    w.idb.data.set("identity", { v: 1, garbage: true });
    expect(await w.local.status()).toEqual({ kind: "damaged", what: "identity" });
  });
  it("turnOff deletes the identity and the four sk_sync_* keys, keeps sk_prejoin, sk_prf, sk_oath and the vault; afterwards no unlock can restore the identity", async () => {
    const w = await world();
    const { id, jwk } = await newIdentity({ state: "enrolled" });
    await w.local.identity.put(id);
    await w.local.cfg.write(w.vk, { deviceId: id.deviceId, apiOrigin: id.apiOrigin, dsk: jwk, email: "" });
    for (const k of [
      SYNC_KEYS.state,
      SYNC_KEYS.outbox,
      SYNC_KEYS.staged,
      SYNC_KEYS.prejoin,
      LOCAL_ONLY_KEYS.prf,
      LOCAL_ONLY_KEYS.oath,
      LOCAL_ONLY_KEYS.pin,
    ])
      w.kv.data.set(k, { v: 1 });
    const vaultKeys = [...w.kv.data.keys()].filter((k) => k.startsWith("sk_slot") || k === "sk_active");
    await w.local.turnOff();
    expect((await w.local.status()).kind).toBe("off");
    for (const k of SYNC_OFF_KEYS) expect(w.kv.data.has(k), k).toBe(false);
    for (const k of [SYNC_KEYS.prejoin, LOCAL_ONLY_KEYS.prf, LOCAL_ONLY_KEYS.oath, LOCAL_ONLY_KEYS.pin, ...vaultKeys])
      expect(w.kv.data.has(k), k).toBe(true);
    await expect(w.local.restoreIdentity(w.vk, w.keyring)).rejects.toThrow();
  });
  it("a crash between the two halves of turnOff leaves an identity without its copy (cfg_missing), never a copy that would bring the identity back", async () => {
    const w = await world();
    const { id, jwk } = await newIdentity({ state: "enrolled" });
    await w.local.identity.put(id);
    await w.local.cfg.write(w.vk, { deviceId: id.deviceId, apiOrigin: id.apiOrigin, dsk: jwk, email: "" });
    const dying = new SyncLocal({
      local: w.kv,
      identity: {
        ...w.idb,
        get: (k) => w.idb.get(k),
        set: (i) => w.idb.set(i),
        keys: () => w.idb.keys(),
        remove: async () => {
          throw new Error("died");
        },
      },
      vaultLock: createMutex(),
    });
    await expect(dying.turnOff()).rejects.toThrow("died");
    expect((await w.local.status()).kind).toBe("cfg_missing");
    await w.local.turnOff();
    expect((await w.local.status()).kind).toBe("off");
  });
});

describe("the pins catch up with the commit (pins.ts; §0.0i item 17, M2R-1; RR-3, RR-4, RR-7, RR-9)", () => {
  /** A vault in a store (the active keyring is what settle checks pendingPins against), an identity, the ledger. */
  async function world(o: { identity?: boolean } = {}) {
    const kv = new MemoryKV();
    const idb = new MemoryKV();
    const lock = createMutex();
    const store = new VaultStore({ kv, lock });
    const { keyring, vk } = await createKeyring();
    await store.transact(async () => ({
      envelope: await encryptVault(serializeVault(emptyVault(keyring.vaultId)), vk, {
        vaultId: keyring.vaultId,
        rev: 0,
      }),
      keyring,
    }));
    const local = new SyncLocal({ local: kv, identity: idb, vaultLock: lock });
    const { id } = await newIdentity({
      state: "enrolled",
      vkId: keyring.vkId,
      vaultId: keyring.vaultId,
      maxSeenKver: 3,
      maxSeenVersion: 900,
    });
    if (o.identity !== false) await local.identity.put(id);
    const auth = (salt = "AAAAAAAAAAAAAAAAAAAAAA==") => ({
      kdf: { name: "PBKDF2" as const, hash: "SHA-256" as const, iterations: 600_000, salt },
    });
    const pinsFor = async (kr = keyring, maxSeenKver = 5, a = auth()) => ({
      vkId: kr.vkId,
      vaultId: kr.vaultId,
      maxSeenKver,
      adopted: await adoptedRecord({ keyring: kr, auth: a } as never),
    });
    /** The pending copy a commit beginning now writes (the identity as stored now). */
    const pend = async (p: Pins, deviceId?: string) => pendingFor(p, await local.identity.get(), deviceId);
    let writes = 0;
    const counted = {
      get: (k: string[]) => kv.get(k),
      keys: () => kv.keys(),
      remove: (k: string[]) => kv.remove(k),
      set: async (i: Record<string, unknown>) => {
        writes++;
        await kv.set(i);
      },
    };
    return { kv, idb, keyring, vk, local, id, auth, pinsFor, pend, counted, writes: () => writes, lock };
  }
  const stateOf = (kv: MemoryKV) => kv.data.get(SYNC_KEYS.state) as Record<string, unknown> | undefined;
  const failingIdb = (inner: MemoryKV) => ({
    get: (k: string[]) => inner.get(k),
    keys: () => inner.keys(),
    set: async () => {
      throw new Error("IndexedDB: Internal error");
    },
    remove: async () => {
      throw new Error("IndexedDB: Internal error");
    },
  });
  /** IndexedDB that acknowledges writes and drops them (A4R-10's lying disk). */
  const lyingIdb = (inner: MemoryKV) => ({
    get: (k: string[]) => inner.get(k),
    keys: () => inner.keys(),
    set: async () => undefined,
    remove: async () => undefined,
  });

  it("begin: lastSynced and the outbox cleared and pendingPins written in ONE write, always (also when lastSynced is already null), every other member kept; the copy carries the identity it is for and its pinCount", async () => {
    const w = await world();
    const p = await w.pend(await w.pinsFor());
    expect([p.deviceId, p.prev]).toEqual([w.id.deviceId, 0]);
    for (const st of [
      undefined,
      { v: 1, lastSynced: null, serverOffsetMs: 5 },
      { v: 1, lastSynced: { version: 2, head: "h", checksum: "c" }, failures: 3 },
    ]) {
      if (st) w.kv.data.set(SYNC_KEYS.state, st);
      else w.kv.data.delete(SYNC_KEYS.state);
      w.kv.data.set(SYNC_KEYS.outbox, { any: 1 });
      const before = w.writes();
      await new SyncLocal({ local: w.counted, identity: w.idb, vaultLock: w.lock }).pins.begin(p);
      expect(w.writes() - before).toBe(1);
      expect(stateOf(w.kv)).toEqual({ ...(st ?? { v: 1 }), lastSynced: null, pendingPins: p });
      expect(w.kv.data.get(SYNC_KEYS.outbox)).toBeNull();
    }
    // the recovery hook's clear (and any other writer) keeps it (RR-8 Q18)
    w.kv.data.set(SYNC_KEYS.state, { ...stateOf(w.kv), lastSynced: { version: 3, head: "h", checksum: "c" } });
    await new SyncStateStore(w.kv).clearLastSynced();
    expect(stateOf(w.kv)!.pendingPins).toEqual(p);
  });
  it("commit: the IndexedDB pins (pinCount one up), read back, then pendingPins cleared (only if it is still these pins); no identity: false, the copy stays; a lying IndexedDB: refused, the copy stays (RR-7)", async () => {
    const w = await world();
    const p = await w.pinsFor();
    await w.local.pins.begin(await w.pend(p));
    expect(await w.local.pins.commit(p)).toBe(true);
    expect(await w.local.identity.get()).toMatchObject({ maxSeenKver: 5, adopted: p.adopted, pinCount: 1 });
    expect(stateOf(w.kv)).toEqual({ v: 1, lastSynced: null });
    const newer = await w.pend(await w.pinsFor(w.keyring, 6));
    await w.local.pins.begin(newer);
    await w.local.pins.commit(p); // a late commit of older pins does not clear the newer pending copy
    expect(stateOf(w.kv)!.pendingPins).toEqual(newer);
    const v = await world({ identity: false });
    const q = await v.pinsFor();
    await v.local.pins.begin(await v.pend(q));
    expect(await v.local.pins.commit(q)).toBe(false);
    expect(stateOf(v.kv)!.pendingPins).toMatchObject(q);
    // RR-7: IndexedDB says yes and keeps nothing: the read-back refuses, the pending copy stays for the settle
    const l = await world();
    const r = await l.pinsFor(l.keyring, 7);
    await l.local.pins.begin(await l.pend(r));
    const lying = new SyncLocal({ local: l.kv, identity: lyingIdb(l.idb), vaultLock: l.lock });
    await expect(lying.pins.commit(r)).rejects.toThrow("did not read back");
    expect(stateOf(l.kv)!.pendingPins).toMatchObject(r);
    expect(await lying.settlePins()).toMatchObject({ maxSeenKver: 7, adopted: r.adopted }); // the overlay; still kept
    expect(stateOf(l.kv)!.pendingPins).toMatchObject(r);
    expect(await l.local.settlePins()).toMatchObject({ maxSeenKver: 7, adopted: r.adopted });
    expect(stateOf(l.kv)!.pendingPins).toBeUndefined();
  });
  it("settle: applied when it names the active keyring and moves forward; dropped when it names another keyring or would move the pins back; kept with no identity; IndexedDB failing: the overlay, nothing written, kept", async () => {
    const w = await world();
    const p = await w.pinsFor();
    // names the active keyring, forward: applied, cleared
    await w.local.pins.begin(await w.pend(p));
    expect(await w.local.settlePins()).toMatchObject({ maxSeenKver: 5, adopted: p.adopted });
    expect(await w.local.identity.get()).toMatchObject({ maxSeenKver: 5, adopted: p.adopted });
    expect(stateOf(w.kv)!.pendingPins).toBeUndefined();
    // another keyring (its commit never landed): dropped, the pins as they were
    const { keyring: other } = await createKeyring({ vaultId: w.keyring.vaultId });
    await w.local.pins.begin(await w.pend(await w.pinsFor(other, 9)));
    const now = await w.local.identity.get();
    expect(await w.local.settlePins()).toEqual(now);
    expect(stateOf(w.kv)!.pendingPins).toBeUndefined();
    // the same keyring under another auth than the stored keyring reproduces: dropped (the digest is the check)
    await w.local.pins.begin(await w.pend({ ...p, maxSeenKver: 9, adopted: { ...p.adopted, digest: "AAAA" } }));
    expect(await w.local.settlePins()).toEqual(now);
    // backward (the identity is further, GM2-5): a copy begun before the pins moved on, at a lower kver: dropped
    const old = await w.pend(await w.pinsFor(w.keyring, 7));
    await w.local.identity.setPins(await w.pinsFor(w.keyring, 8, w.auth("BBBBBBBBBBBBBBBBBBBBBA==")));
    await w.local.pins.begin(old);
    const further = await w.local.identity.get();
    expect(await w.local.settlePins()).toEqual(further);
    expect(stateOf(w.kv)!.pendingPins).toBeUndefined();
    // another vault in the identity: dropped
    await w.local.identity.update((c) => ({ ...c, vaultId: "another-vault-01" }));
    await w.local.pins.begin(await w.pend(await w.pinsFor(w.keyring, 20)));
    expect((await w.local.settlePins()) as { vaultId: string }).toMatchObject({
      vaultId: "another-vault-01",
      maxSeenKver: 8,
    });
    // no pins yet (a new device's identity): applied
    await w.local.identity.update((c) => ({ ...c, vkId: null, vaultId: null, maxSeenKver: 0, adopted: null }));
    await w.local.pins.begin(await w.pend(p));
    expect(await w.local.settlePins()).toMatchObject({ vkId: w.keyring.vkId, maxSeenKver: 5 });
    // IndexedDB failing: the pending pins laid over the stored ones, nothing written, the copy kept for the next settle
    await w.local.identity.update((c) => ({ ...c, maxSeenKver: 5, adopted: null }));
    const q = await w.pend(await w.pinsFor(w.keyring, 6));
    await w.local.pins.begin(q);
    const stored = structuredClone(w.idb.data.get("identity"));
    const overlay = await new SyncLocal({ local: w.kv, identity: failingIdb(w.idb), vaultLock: w.lock }).settlePins();
    expect(overlay).toMatchObject({ maxSeenKver: 6, adopted: q.adopted });
    expect(w.idb.data.get("identity")).toEqual(stored);
    expect(stateOf(w.kv)!.pendingPins).toEqual(q);
    expect(await w.local.settlePins()).toMatchObject({ maxSeenKver: 6, adopted: q.adopted });
    // no readable active keyring (lost data): nothing to check it against, kept, and laid over when it moves forward (RR-9)
    const lostPtr = w.kv.data.get(KEYS.active);
    w.kv.data.set(KEYS.active, "c");
    const lost = await w.pend(await w.pinsFor(w.keyring, 30));
    await w.local.pins.begin(lost);
    expect(await w.local.settlePins()).toMatchObject({ maxSeenKver: 30, adopted: lost.adopted });
    expect(stateOf(w.kv)!.pendingPins).toEqual(lost);
    expect((await w.local.identity.get()) as { maxSeenKver: number }).toMatchObject({ maxSeenKver: 6 }); // nothing written
    w.kv.data.set(KEYS.active, lostPtr);
    // no identity: kept until there is one to pin
    const v = await world({ identity: false });
    const r = await v.pend(await v.pinsFor());
    await v.local.pins.begin(r);
    expect(await v.local.settlePins()).toBeNull();
    expect(stateOf(v.kv)!.pendingPins).toEqual(r);
  });
  it("RR-4: the order of pin writes, not maxSeenKver alone: an older copy at an equal kver is dropped after the pins went on (also A -> B -> A); one begun when the pins were where they still are is applied, whatever its kver (the capped publish), and maxSeenKver never goes down; maxSeenVersion plays no part (Q02)", async () => {
    const w = await world();
    const A = await w.pinsFor(w.keyring, 6, w.auth("AAAAAAAAAAAAAAAAAAAAAA=="));
    const B = await w.pinsFor(w.keyring, 6, w.auth("BBBBBBBBBBBBBBBBBBBBBA=="));
    const pendA = await w.pend(A); // A's commit begins
    await w.local.identity.setPins(A); // ... is pinned (its pending clear later lost)
    await w.local.identity.setPins(B); // B is committed and pinned, at the same maxSeenKver
    await w.local.pins.begin(pendA); // storage.local's tail lost back to A's copy
    expect(await w.local.settlePins()).toMatchObject({ adopted: B.adopted });
    expect(await w.local.identity.get()).toMatchObject({ adopted: B.adopted });
    expect(stateOf(w.kv)!.pendingPins).toBeUndefined();
    // A -> B -> A by digest: the count still tells the copy is older
    const pendB = await w.pend(B);
    await w.local.identity.setPins(A);
    await w.local.pins.begin(pendB);
    expect(await w.local.settlePins()).toMatchObject({ adopted: A.adopted });
    // begun with the pins as they still are: applied, also at a lower or an equal kver (only adopted moves; never maxSeenKver down)
    await w.local.identity.update((c) => ({ ...c, maxSeenKver: 40, maxSeenVersion: 2 }));
    const low = await w.pend(B); // B's maxSeenKver 6 < 40: a publish capped by KVER_MAX_JUMP
    await w.local.pins.begin(low);
    expect(await w.local.settlePins()).toMatchObject({ adopted: B.adopted, maxSeenKver: 40 });
    // a higher kver applies even when the pins moved since (they never go past a newer commit's kver)
    const pendHigh = await w.pend(await w.pinsFor(w.keyring, 41, w.auth("CCCCCCCCCCCCCCCCCCCCCA==")));
    await w.local.identity.setPins(A);
    await w.local.pins.begin(pendHigh);
    expect(await w.local.settlePins()).toMatchObject({ maxSeenKver: 41, adopted: pendHigh.adopted });
  });
  it("RR-3: a copy written for another identity (or for none) is never laid onto this one: a later enrolment's fresh identity does not inherit it", async () => {
    const w = await world();
    const stale = pendingFor(await w.pinsFor(w.keyring, 6), null); // a commit that ran after "turn sync off"
    await w.local.identity.remove();
    await w.local.pins.begin(stale);
    const { id: fresh } = await newIdentity(); // the next enrolment's (pending, no pins)
    await w.local.identity.put(fresh);
    expect(await w.local.settlePins()).toEqual(await w.local.identity.get());
    expect(await w.local.identity.get()).toMatchObject({ vkId: null, maxSeenKver: 0, adopted: null });
    expect(stateOf(w.kv)!.pendingPins).toBeUndefined();
    const forOther = pendingFor(await w.pinsFor(w.keyring, 6), null, "zzzzzzzzzzzzzzzzzzzzzg");
    await w.local.pins.begin(forOther);
    expect(await w.local.settlePins()).toMatchObject({ vkId: null });
  });
});

describe("the identity's lock (M2R-6)", () => {
  it("putIfAbsent writes only with no identity and its copy still there (checked under the lock); remove runs turnOff's storage.local half first, under the same lock", async () => {
    const idb = new MemoryKV();
    const store = new IdentityStore(idb);
    const { id } = await newIdentity();
    expect(await store.putIfAbsent(id, async () => false)).toBe(false);
    expect(await store.get()).toBeNull();
    expect(await store.putIfAbsent(id, async () => true)).toBe(true);
    const { id: other } = await newIdentity();
    expect(await store.putIfAbsent(other, async () => true)).toBe(false); // one is there
    expect((await store.get()) as { deviceId: string }).toMatchObject({ deviceId: id.deviceId });
    // remove: turnOff's storage.local half first (the identity still there), then the identity (PROBE-6 in
    // test/regression/m2-review.test.ts races a whole restore against it)
    let seen: unknown = "not run";
    await store.remove(async () => {
      seen = await store.get().then((x) => (x && x !== "damaged" ? x.deviceId : x));
    });
    expect(seen).toBe(id.deviceId);
    expect(await store.get()).toBeNull();
  });
});

describe("the merge guard (§4.4, I8; identity by entryIdentity, R3)", () => {
  const c = clock();
  const base = () => {
    let v = emptyVault("vault-0123456789");
    for (const n of ["a", "b", "c", "d", "e"])
      v = addEntry(v, input(n, `JBSWY3DPEHPK3PX${n === "a" ? "A" : "B"}`), c, { id: `entry-000000${n}` }).vault;
    return v;
  };
  it("blocks only on a changed secret or an erase of an entry alive here; notices three moves to the trash or three erases from the trash", () => {
    const local = base();
    const remote = purgeEntry(local, "entry-000000b", c);
    const g = guardMerge(local, remote, remote);
    expect(g.purgedAlive).toEqual(["entry-000000b"]);
    expect(blocks(g)).toBe(true);
    const changed = {
      ...local,
      entries: local.entries.map((e) => (e.id === "entry-000000a" ? { ...e, secret: "GEZDGNBVGY3TQOJQ" } : e)),
    };
    expect(guardMerge(local, changed, local).secretChanged).toEqual(["entry-000000a"]);
    let trashed = local;
    for (const id of ["entry-000000a", "entry-000000b", "entry-000000c"]) trashed = deleteEntry(trashed, id, c);
    const t = guardMerge(local, trashed, trashed);
    expect([blocks(t), notices(t), t.trashed.length]).toEqual([false, true, 3]);
    let erased = trashed;
    for (const id of ["entry-000000a", "entry-000000b", "entry-000000c"]) erased = purgeEntry(erased, id, c);
    const e = guardMerge(trashed, erased, erased);
    expect([blocks(e), notices(e), e.purgedFromTrash.length]).toEqual([false, true, 3]);
    const two = deleteEntry(deleteEntry(local, "entry-000000a", c), "entry-000000b", c);
    expect(notices(guardMerge(local, two, two))).toBe(false);
  });
});
