// M3 (SYNC-DESIGN §4): the engine's pure parts and its storage helpers on their own: when it runs (§4.8), time (§4.14),
// min_client_version (§5.2 N21), the one writer of sk_sync_state / sk_sync_outbox / the cursor (§4.1, §4.7, §4.10; the
// CAS of D1/D2), the outbox writer (§4.7, P10, D2), and accepting remote data (§4.3, R6).
import { describe, expect, it } from "vitest";
import { bs, fromB64, sha256, toB64, utf8 } from "../../src/core/crypto/bytes";
import { decryptVault, encryptVault, validateEnvelope } from "../../src/core/crypto/envelope";
import { createKeyring } from "../../src/core/crypto/keyring";
import { generateVk } from "../../src/core/crypto/vk";

import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { SYNC_CONSTANTS } from "../../src/core/sync/crypto/constants";
import { writeKey, writeProofInput } from "../../src/core/sync/crypto/subkeys";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { createOutboxWriter, parseOutbox, uploadEnvelope } from "../../src/core/sync/local/outbox";
import { MAX_OFFSET_MS } from "../../src/core/sync/local/state";
import { clampOffset, clockNotice, offsetOf, refNow, totpOffset } from "../../src/core/sync/engine/clock";
import { versionBelow } from "../../src/core/sync/engine/engine";
import { openRemote } from "../../src/core/sync/engine/remote";
import {
  ALARM_MIN_MS,
  backoffMs,
  BACKOFF_MAX_MS,
  conflictDelay,
  DEBOUNCE_MS,
  kickWakes,
  mayRun,
  periodicPhaseMinutes,
  retryAt,
  wakeAt,
} from "../../src/core/sync/engine/schedule";
import { EngineStateStore, headOf } from "../../src/core/sync/engine/state";
import { createClock } from "../../src/core/vault/hlc";
import { emptyVault } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { deserializeVault, serializeVault } from "../../src/core/vault/validate";
import { input } from "../helpers/m2-world";

describe("§4.8 when the engine runs", () => {
  it("backoff: min(30 min, 5 s × 2^n) ± 20 %, bounded however many failures", () => {
    for (let n = 1; n <= 40; n++) {
      const base = Math.min(BACKOFF_MAX_MS, 5000 * 2 ** n);
      for (const r of [0, 0.25, 0.5, 0.999]) {
        const d = backoffMs(n, r);
        expect(d, `n=${n} r=${r}`).toBeGreaterThanOrEqual(Math.floor(base * 0.8));
        expect(d).toBeLessThanOrEqual(Math.ceil(base * 1.2));
      }
    }
    expect(backoffMs(1, 0.5)).toBe(10_000);
    expect(backoffMs(1000, 0.5)).toBe(BACKOFF_MAX_MS); // never unbounded
    expect(backoffMs(1000, 1)).toBe(BACKOFF_MAX_MS * 1.2);
    expect(backoffMs(3, 0.5)).toBeGreaterThan(backoffMs(2, 0.5)); // grows
  });
  it("Retry-After is honoured (never earlier than asked), and capped at a day", () => {
    expect(retryAt(1000, 1, 0.5, 120)).toBe(1000 + 120_000);
    expect(retryAt(1000, 1, 0.5, 1)).toBe(1000 + 10_000); // the backoff is longer
    expect(retryAt(0, 1, 0.5, 10 ** 9)).toBe(24 * 3600 * 1000);
  });
  it("under 30 s a setTimeout, from 30 s an alarm (MV3 workers are stopped)", () => {
    expect(wakeAt(0, ALARM_MIN_MS - 1).via).toBe("timeout");
    expect(wakeAt(0, ALARM_MIN_MS).via).toBe("alarm");
  });
  it("sync soon: 3 s debounce and a 30 s backstop alarm; HOTP now; a running backoff moves it to its end", () => {
    expect(kickWakes(100, {})).toEqual({
      sync: { at: 100 + DEBOUNCE_MS, via: "timeout" },
      kick: { at: 100 + 30_000, via: "alarm" },
    });
    expect(kickWakes(100, { immediate: true }).sync).toEqual({ at: 100, via: "timeout" });
    expect(kickWakes(100, { backoffUntil: 100 + 60_000 }).sync).toEqual({ at: 100 + 60_000, via: "alarm" });
    expect(mayRun(5, 10)).toBe(false);
    expect(mayRun(10, 10)).toBe(true);
    expect(mayRun(5, 10, true)).toBe(true);
  });
  it("409 jitter 200–1000 ms; the periodic alarm's phase 1–30 min", () => {
    expect(conflictDelay(0)).toBe(200);
    expect(conflictDelay(1)).toBe(1000);
    for (let r = 0; r < 1; r += 0.01) {
      const m = periodicPhaseMinutes(r);
      expect(m).toBeGreaterThanOrEqual(1);
      expect(m).toBeLessThanOrEqual(30);
    }
  });
});

describe("§4.14 time", () => {
  it("the offset at the exchange's midpoint, used within ±7 days", () => {
    expect(offsetOf({ serverMs: 10_000, sentAt: 1000, receivedAt: 3000 })).toBe(8000);
    expect(clampOffset(10 * MAX_OFFSET_MS)).toBe(MAX_OFFSET_MS);
    expect(clampOffset(-10 * MAX_OFFSET_MS)).toBe(-MAX_OFFSET_MS);
    expect(refNow(1000, 10 * MAX_OFFSET_MS)).toBe(1000 + MAX_OFFSET_MS);
  });
  it("S3: TOTP keeps the local clock unless the user chose the corrected time, and never corrects by more than an hour", () => {
    expect(totpOffset(40 * 60_000, false)).toBe(0);
    expect(totpOffset(40 * 60_000, true)).toBe(40 * 60_000);
    expect(totpOffset(61 * 60_000, true)).toBe(0);
    expect(clockNotice(15_000)).toBe("none");
    expect(clockNotice(15_001)).toBe("offer_correction");
    expect(clockNotice(-3_600_001)).toBe("warn_only");
  });
});

describe("§5.2 min_client_version (N21)", () => {
  it("compares per component numerically, missing components 0", () => {
    expect(versionBelow("0.0.1", "0.0.2")).toBe(true);
    expect(versionBelow("0.0.10", "0.0.9")).toBe(false);
    expect(versionBelow("1.2", "1.2.0.0")).toBe(false);
    expect(versionBelow("1.2", "1.2.0.1")).toBe(true);
    expect(versionBelow("2", "1.99999")).toBe(false);
    expect(versionBelow("0.0.1", "garbage")).toBe(false); // a malformed minimum does not stop sync
  });
});

// ---- the state writer --------------------------------------------------------------------------------------------

async function storeWithVault() {
  const kv = new MemoryKV();
  const lock = createMutex();
  const store = new VaultStore({ kv, lock });
  const { keyring, vk } = await createKeyring();
  const v = addEntry(
    emptyVault(keyring.vaultId),
    input("GitHub"),
    createClock("aaaa", { now: () => 1_700_000_000_000 }),
  ).vault;
  const gen = await store.transact(async () => ({
    envelope: await encryptVault(serializeVault(v), vk, { vaultId: keyring.vaultId, rev: 0 }),
    keyring,
  }));
  kv.data.set(SYNC_KEYS.cfg, {
    v: 1,
    deviceId: "qqqqqqqqqqqqqqqqqqqqqg",
    apiOrigin: "https://api.sixkey.app",
    enc: { vkId: vk.id, iv: "AAAAAAAAAAAAAAAA", ct: "AAAA" },
  });
  return { kv, lock, store, keyring, vk, vault: v, gen, st: new EngineStateStore(kv, lock) };
}

describe("the one writer of sk_sync_state (M2-NOTES §4.2 item 3, §7 item 6)", () => {
  it("keeps every member it does not own (pendingPins, useCorrectedTotp, a newer version's), and writes nothing when nothing changes", async () => {
    const w = await storeWithVault();
    const raw = {
      v: 1,
      lastSynced: { version: 3, head: "h", checksum: "c" },
      pendingPins: { vkId: "x" },
      useCorrectedTotp: true,
      future: { a: 1 },
      status: "ok",
    };
    w.kv.data.set(SYNC_KEYS.state, raw);
    await w.st.update(() => ({ status: "offline", failures: 2, notAnEngineMember: 1 }) as never);
    expect(w.kv.data.get(SYNC_KEYS.state)).toEqual({ ...raw, status: "offline", failures: 2 });
    let writes = 0;
    const set = w.kv.set.bind(w.kv);
    w.kv.set = async (items) => {
      writes++;
      return set(items);
    };
    await w.st.update(() => ({ status: "offline", failures: 2 }));
    expect(writes).toBe(0);
  });
  it("never brings sk_sync_state back after sync was turned off (no sk_sync_cfg)", async () => {
    const w = await storeWithVault();
    w.kv.data.delete(SYNC_KEYS.cfg);
    await w.st.update(() => ({ status: "ok" }));
    expect(w.kv.data.has(SYNC_KEYS.state)).toBe(false);
  });
  it("lastSynced moves only by CAS: the active generation must still be the one, and lastSynced still what the round read", async () => {
    const w = await storeWithVault();
    const c = w.gen.envelope.checksum;
    const next = { version: 5, head: "H5", checksum: c };
    expect(await w.st.casLastSynced(null, next, "some other checksum")).toBe(false); // the active generation changed
    expect(await w.st.casLastSynced({ version: 1, head: "h", checksum: c }, next, c)).toBe(false); // lastSynced was not that
    expect(w.kv.data.has(SYNC_KEYS.state)).toBe(false);
    expect(await w.st.casLastSynced(null, next, c)).toBe(true);
    expect((w.kv.data.get(SYNC_KEYS.state) as { lastSynced: unknown }).lastSynced).toEqual(next);
  });
  it("D1: a round that began from null, with a recovery in between that cleared it again, does not mark an older local state in sync", async () => {
    const w = await storeWithVault();
    const c0 = w.gen.envelope.checksum;
    // the round read lastSynced = null and the generation c0; meanwhile a newer edit, then a recovery back to c0's slot?
    // The recovery replaces the active generation: modelled by another commit, whose checksum differs from c0.
    await w.store.transact(async (cur) => ({
      envelope: await encryptVault(serializeVault(w.vault), w.vk, {
        vaultId: w.keyring.vaultId,
        rev: cur!.envelope.rev + 1,
      }),
      keyring: cur!.keyring,
    }));
    expect(await w.st.casLastSynced(null, { version: 9, head: "H", checksum: c0 }, c0)).toBe(false);
  });
  it("D2: the outbox push moves lastSynced only while it is still the outbox's `from`, and removes only that outbox", async () => {
    const w = await storeWithVault();
    const from = { version: 4, head: "H4", checksum: "c3" };
    const ob = {
      v: 1 as const,
      base: 4,
      head: "H4",
      from,
      checksum: w.gen.envelope.checksum,
      envelope: '{"x":1}',
      proof: "p",
    };
    w.kv.data.set(SYNC_KEYS.state, { v: 1, lastSynced: null, pendingPins: { keep: 1 } }); // a recovery cleared it meanwhile
    w.kv.data.set(SYNC_KEYS.outbox, ob);
    expect(await w.st.pushed(ob)).toBe(false);
    expect((w.kv.data.get(SYNC_KEYS.state) as { lastSynced: unknown }).lastSynced).toBeNull(); // not brought back
    expect(w.kv.data.get(SYNC_KEYS.outbox)).toBeNull(); // the pushed one is gone
    w.kv.data.set(SYNC_KEYS.state, { v: 1, lastSynced: from, pendingPins: { keep: 1 } });
    const newer = { ...ob, checksum: "newer", envelope: '{"y":2}' };
    w.kv.data.set(SYNC_KEYS.outbox, newer);
    expect(await w.st.pushed(ob)).toBe(true);
    expect(w.kv.data.get(SYNC_KEYS.state)).toEqual({
      v: 1,
      lastSynced: { version: 5, head: await headOf(ob.envelope), checksum: ob.checksum },
      pendingPins: { keep: 1 },
    });
    expect(w.kv.data.get(SYNC_KEYS.outbox)).toEqual(newer); // a newer commit's outbox stays
  });
  it("§4.10: the cursor's pending value is written before the PUT, under the lock, keeping enc; cur := pending after a 200", async () => {
    const w = await storeWithVault();
    const before = structuredClone(w.kv.data.get(SYNC_KEYS.cfg)) as Record<string, unknown>;
    const rng = (n: number) => new Uint8Array(n).fill(7);
    const c1 = await w.st.cursorForPut(rng);
    expect(c1).toEqual({ pending: toB64(new Uint8Array(16).fill(7)) });
    expect(w.kv.data.get(SYNC_KEYS.cfg)).toEqual({ ...before, cursor: { pending: c1!.pending } });
    expect(await w.st.cursorForPut((n) => new Uint8Array(n).fill(9))).toEqual(c1); // a pending one is reused (a lost answer)
    await w.st.cursorAccepted(c1!.pending);
    expect((w.kv.data.get(SYNC_KEYS.cfg) as { cursor: unknown }).cursor).toEqual({ cur: c1!.pending });
    const c2 = await w.st.cursorForPut((n) => new Uint8Array(n).fill(9));
    expect(c2).toEqual({ cur: c1!.pending, pending: toB64(new Uint8Array(16).fill(9)) });
    expect((w.kv.data.get(SYNC_KEYS.cfg) as { enc: unknown }).enc).toEqual(before.enc);
  });
});

describe("§4.7 the outbox writer (afterCommit)", () => {
  it("with lastSynced: the next PUT exactly (rev base+1, padded, the write proof over base and the upload's checksum), built on version and head", async () => {
    const w = await storeWithVault();
    const ls = { version: 6, head: "H6", checksum: "c" };
    w.kv.data.set(SYNC_KEYS.state, { v: 1, lastSynced: ls });
    await createOutboxWriter(w.kv)({ gen: w.gen, vk: w.vk, vault: w.vault });
    const ob = parseOutbox(w.kv.data.get(SYNC_KEYS.outbox))!;
    expect(ob).toMatchObject({ base: 6, head: "H6", from: ls, checksum: w.gen.envelope.checksum });
    const env = validateEnvelope(JSON.parse(ob.envelope));
    expect(env.rev).toBe(7);
    expect(env.vaultId).toBe(w.keyring.vaultId);
    const plain = await decryptVault(env, w.vk);
    expect(plain.length % 16_384).toBe(0);
    expect(deserializeVault(plain)).toEqual(w.vault);
    const key = await crypto.subtle.importKey(
      "raw",
      bs(fromB64(await writeKey(w.vk))),
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign"],
    );
    const mac = toB64(
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          bs(utf8(writeProofInput({ vaultId: w.keyring.vaultId, ifVersion: 6, checksum: env.checksum }))),
        ),
      ),
    );
    expect(ob.proof).toBe(mac);
  });
  it("without lastSynced (revision 20, R3R-5): the merge-only outbox, the committed generation's own local envelope text with no base and no proof, over whatever was there; never pushed", async () => {
    const w = await storeWithVault();
    w.kv.data.set(SYNC_KEYS.state, { v: 1, lastSynced: null });
    w.kv.data.set(SYNC_KEYS.outbox, {
      v: 1,
      base: 1,
      head: "h",
      from: { version: 1, head: "h", checksum: "x" },
      checksum: "x",
      envelope: "{}",
      proof: "p",
    });
    const writes: string[][] = [];
    const counted = {
      get: (k: string[]) => w.kv.get(k),
      keys: () => w.kv.keys(),
      remove: (k: string[]) => w.kv.remove(k),
      set: async (i: Record<string, unknown>) => {
        writes.push(Object.keys(i));
        await w.kv.set(i);
      },
    };
    await createOutboxWriter(counted)({ gen: w.gen, vk: w.vk, vault: w.vault });
    expect(w.kv.data.get(SYNC_KEYS.outbox)).toEqual({
      v: 1,
      from: null,
      checksum: w.gen.envelope.checksum,
      envelope: JSON.stringify(w.gen.envelope),
    });
    expect(writes).toEqual([[SYNC_KEYS.outbox]]); // one write, nothing else touched (the orphan list is the hook's)
    expect(
      deserializeVault(
        await decryptVault(JSON.parse((w.kv.data.get(SYNC_KEYS.outbox) as { envelope: string }).envelope), w.vk),
      ),
    ).toEqual(w.vault); // not re-encrypted: the local envelope itself
  });
  it("over MAX_ENVELOPE_BYTES nothing is written and the record there stays (never an unconfirmed outbox deleted, R3R-1)", async () => {
    const w = await storeWithVault();
    const big = {
      ...w.gen,
      envelope: { ...w.gen.envelope, ciphertext: "A".repeat(SYNC_CONSTANTS.MAX_ENVELOPE_BYTES) },
    };
    const before = { v: 1, from: null, checksum: "older", envelope: "{}" };
    w.kv.data.set(SYNC_KEYS.state, { v: 1, lastSynced: null });
    w.kv.data.set(SYNC_KEYS.outbox, before);
    await createOutboxWriter(w.kv)({ gen: big as typeof w.gen, vk: w.vk, vault: w.vault });
    expect(w.kv.data.get(SYNC_KEYS.outbox)).toEqual(before);
  });
  it("the shared upload envelope: padded to 16 KiB buckets, the vault unchanged after JSON.parse", async () => {
    const vk = await generateVk();
    const v = emptyVault("vault-0001");
    const { envelope, text } = await uploadEnvelope(v, vk, { vaultId: "vault-0001", rev: 3 });
    expect(JSON.parse(text)).toEqual(envelope);
    expect(deserializeVault(await decryptVault(envelope, vk))).toEqual(v);
  });
});

describe("§4.3 accepting remote data", () => {
  it("ok; another vault; another key (R5); a bad checksum; a newer schema (R1/R6); garbage", async () => {
    const vk = await generateVk();
    const other = await generateVk();
    const v = addEntry(emptyVault("vault-0001"), input("A"), createClock("aaaa", { now: () => 1 })).vault;
    const env = await encryptVault(serializeVault(v), vk, { vaultId: "vault-0001", rev: 4 });
    expect(await openRemote(JSON.stringify(env), vk, "vault-0001")).toEqual({ kind: "ok", vault: v, rev: 4 });
    expect((await openRemote(JSON.stringify(env), vk, "vault-0002")).kind).toBe("wrong_vault");
    expect(
      await openRemote(
        JSON.stringify(await encryptVault(serializeVault(v), other, { vaultId: "vault-0001", rev: 4 })),
        vk,
        "vault-0001",
      ),
    ).toEqual({ kind: "other_key", vkId: other.id });
    expect(
      (await openRemote(JSON.stringify({ ...env, checksum: toB64(await sha256(utf8("x"))) }), vk, "vault-0001")).kind,
    ).toBe("unreadable");
    const v2 = utf8(JSON.stringify({ schemaVersion: 2, vaultId: "vault-0001", entries: [] })); // a synthetic newer version (R6)
    expect(
      (
        await openRemote(
          JSON.stringify(await encryptVault(v2, vk, { vaultId: "vault-0001", rev: 4 })),
          vk,
          "vault-0001",
        )
      ).kind,
    ).toBe("newer_schema");
    expect((await openRemote("not json", vk, "vault-0001")).kind).toBe("unreadable");
    expect(
      (
        await openRemote(
          JSON.stringify(await encryptVault(utf8("{}"), vk, { vaultId: "vault-0001", rev: 4 })),
          vk,
          "vault-0001",
        )
      ).kind,
    ).toBe("unreadable");
  });
  it("the head is SHA-256 of the exact text (D5): the same envelope re-serialized is another head", async () => {
    const vk = await generateVk();
    const env = await encryptVault(utf8("{}"), vk, { vaultId: "vault-0001", rev: 1 });
    const a = JSON.stringify(env);
    const b = JSON.stringify(env, null, 1);
    expect(await headOf(a)).not.toBe(await headOf(b));
  });
});
