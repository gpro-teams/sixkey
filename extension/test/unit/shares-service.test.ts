// Recovery code shares, the service (src/core/service/service.ts prepareShares, confirmShares, checkRecoveryCode;
// docs/design/notes/SHAMIR-NOTES.md §3): "replace" makes a new recovery code shown only as shares and commits it only
// after the test restore; "split" shares the current code and writes nothing; "check" writes nothing and records
// nothing. The old code works until the commit; nothing about a share, the code or R is ever stored.
import { describe, expect, it } from "vitest";
import { toB64 } from "../../src/core/crypto/bytes";
import { unlockWithRecoveryCode, type Keyring } from "../../src/core/crypto/keyring";
import { formatRecoveryCode, parseRecoveryCode } from "../../src/core/crypto/recovery-code";
import { makeShareSet, parseShare, recoveryCodeFromShares, setIdText } from "../../src/core/crypto/shares";
import { KEYS } from "../../src/core/storage/format";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService, type PreparedShares } from "../../src/core/service/service";
import { SECURITY_LOG_KEY, SecurityLog } from "../../src/core/service/security-log";
import { KvSettingsStore, MemorySession } from "../../src/core/service/types";
import { addEntry } from "../../src/core/vault/ops";
import { aliveEntries, emptyVault } from "../../src/core/vault/model";
import { readNotice } from "../../src/popup/notice";
import { createProtected, legacyDeviceVault, STRONG, codeOf } from "../helpers/vaults";
import { TEST_KDF_ITERATIONS } from "../helpers/kdf";
/** The recovery code rebuilt from share texts, as the pages and the service do it. */
const rebuild = (texts: readonly string[]) => recoveryCodeFromShares(texts, formatRecoveryCode);

const input = (issuer: string) => ({
  type: "totp" as const,
  issuer,
  label: "a",
  secret: "JBSWY3DPEHPK3PXP",
  algorithm: "SHA1" as const,
  digits: 6 as const,
  period: 30,
});

async function world(o: { sync?: { on: boolean } } = {}) {
  const kv = new MemoryKV();
  const mirror = new MemoryKV();
  const session = new MemorySession();
  const t = { now: 1_700_000_000_000 };
  const settings = new KvSettingsStore(kv);
  const security = new SecurityLog({ kv, now: () => t.now });
  const make = () =>
    new VaultService({
      store: new VaultStore({ lock: createMutex(), kv, mirror, now: () => t.now }),
      session,
      settings,
      security,
      now: () => t.now,
      kdfIterations: TEST_KDF_ITERATIONS,
      // a sync port that is only on or off (the service asks it whether sync is on: noSync)
      ...(o.sync
        ? { sync: { context: async () => (o.sync!.on ? ({} as never) : null), clearLastSynced: async () => undefined } }
        : {}),
    });
  const svc = make();
  const { recoveryCode } = await createProtected(svc);
  await svc.mutate((v, c) => addEntry(v, input("GitHub"), c).vault);
  const keyring = async (): Promise<Keyring> => (await svc.currentGeneration())!.keyring;
  const opens = async (code: string) =>
    (await unlockWithRecoveryCode(await keyring(), code).catch(() => null)) !== null;
  const disk = () => JSON.stringify([[...kv.data.entries()], [...mirror.data.entries()]]);
  const kinds = async () => (await security.read()).entries.map((e) => e.kind as string);
  return { kv, mirror, session, t, svc, make, recoveryCode, keyring, opens, disk, kinds, security };
}
type W = Awaited<ReturnType<typeof world>>;
const asked = (h: PreparedShares) => h.test.map((i) => h.shares[i]!);
const others = (h: PreparedShares) => h.shares.filter((_, i) => !h.test.includes(i));

describe("replace: a new recovery code, shown only as shares, committed only after the test restore", () => {
  it("prepare writes nothing: the old code still opens, the shares' code does not, and no single code is handed out", async () => {
    const w = await world();
    const before = w.disk();
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    expect(w.disk()).toBe(before);
    expect(h).toMatchObject({ mode: "replace", threshold: 2, count: 3 });
    expect(h.shares).toHaveLength(3);
    expect(h.test).toHaveLength(2);
    expect(Object.keys(h).sort()).toEqual(["count", "mode", "setId", "shares", "test", "threshold"]); // no code, no key
    expect(Object.isFrozen(h) && Object.isFrozen(h.shares)).toBe(true);
    expect(await w.opens(w.recoveryCode)).toBe(true);
    expect(await w.opens(await rebuild(asked(h)))).toBe(false);
  });
  it("confirm with the members asked for: committed; the shares' code opens, the old code does not, recorded once", async () => {
    const w = await world();
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    await w.svc.confirmShares(h, asked(h));
    const code = await rebuild(asked(h));
    expect(await w.opens(code)).toBe(true);
    expect(await w.opens(w.recoveryCode)).toBe(false);
    for (const pair of [
      [0, 1],
      [0, 2],
      [1, 2],
    ])
      expect(await rebuild(pair.map((i) => h.shares[i]!))).toBe(code); // any 2 of the 3
    expect((await w.kinds()).filter((k) => k === "recovery_code_new")).toHaveLength(1);
    // the vault and its accounts are as they were, and the password opens it
    await w.svc.lock();
    await w.make().unlockWithPassword(STRONG);
    expect(aliveEntries((await w.make().read()).vault).map((e) => e.issuer)).toEqual(["GitHub"]);
    // the handle is spent
    await expect(w.svc.confirmShares(h, asked(h))).rejects.toMatchObject({ code: "bad_state" });
  });
  it("3 of 5: three members asked for, any three rebuild the committed code", async () => {
    const w = await world();
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 3, count: 5 });
    expect(h.test).toHaveLength(3);
    await w.svc.confirmShares(h, [...asked(h)].reverse()); // any order
    expect(await w.opens(await rebuild(h.shares.slice(2)))).toBe(true);
  });
  it("nothing is committed without the test restore: other members, too few, a share of another set, a typo", async () => {
    const w = await world();
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    const before = w.disk();
    const other = await makeShareSet(await parseRecoveryCode(w.recoveryCode), 2, 3);
    const wrongMembers = [...others(h), asked(h)[0]!];
    await expect(w.svc.confirmShares(h, wrongMembers)).rejects.toMatchObject({ code: "bad_state" });
    await expect(w.svc.confirmShares(h, [asked(h)[0]!])).rejects.toMatchObject({ code: "bad_state" });
    await expect(w.svc.confirmShares(h, [])).rejects.toMatchObject({ code: "bad_state" });
    await expect(w.svc.confirmShares(h, [asked(h)[0]!, other.shares[h.test[1]!]!])).rejects.toMatchObject({
      code: "shares_mixed",
    });
    const typo = asked(h)[1]!.replace(/^(.)/, (c) => (c === "2" ? "3" : "2"));
    await expect(w.svc.confirmShares(h, [asked(h)[0]!, typo])).rejects.toMatchObject({ code: "share_checksum" });
    expect(w.disk()).toBe(before);
    expect(await w.opens(w.recoveryCode)).toBe(true);
    await w.svc.confirmShares(h, asked(h)); // and the right ones still work afterwards
    expect(await w.opens(w.recoveryCode)).toBe(false);
  });
  it("shares of another code that pass every check of the set (its id, threshold and members) are refused: what is committed is what the shares rebuild", async () => {
    const w = await world();
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    const id = parseInt(h.setId, 16);
    let first = true;
    const sameId = (n: number) =>
      first && n === 2
        ? ((first = false), Uint8Array.from([id >> 8, id & 0xff]))
        : crypto.getRandomValues(new Uint8Array(n));
    const forged = await makeShareSet(new Uint8Array(16).fill(0x5a), 2, 3, sameId);
    expect(forged.setId).toBe(id);
    const before = w.disk();
    await expect(
      w.svc.confirmShares(
        h,
        h.test.map((i) => forged.shares[i]!),
      ),
    ).rejects.toMatchObject({
      code: "bad_state",
    });
    expect(w.disk()).toBe(before);
    expect(await w.opens(w.recoveryCode)).toBe(true);
  });
  it("the keys changed since the set was made (a new recovery code in another page): refused, nothing written", async () => {
    const w = await world();
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    const newer = await codeOf((d) => w.make().newRecoveryCode(STRONG, d));
    const before = w.disk();
    await expect(w.svc.confirmShares(h, asked(h))).rejects.toMatchObject({ code: "bad_state" });
    expect(w.disk()).toBe(before);
    expect(await w.opens(newer)).toBe(true);
  });
  it("Sixkey locked meanwhile: refused (locked), nothing written", async () => {
    const w = await world();
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    await w.svc.lock();
    const before = w.disk();
    await expect(w.svc.confirmShares(h, asked(h))).rejects.toMatchObject({ code: "locked" });
    expect(w.disk()).toBe(before);
    expect(await w.opens(w.recoveryCode)).toBe(true);
  });
  it("a commit whose save reported an error: one of the two codes opens, never neither; the same handle then finishes it", async () => {
    const w = await world();
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    const kv = w.kv as MemoryKV & { set: MemoryKV["set"] };
    const real = kv.set.bind(kv);
    let failOnce = true;
    kv.set = async (items) => {
      await real(items);
      if (failOnce && Object.keys(items).includes(KEYS.active)) {
        failOnce = false;
        throw new Error("reported a failure after landing");
      }
    };
    const first = await w.svc.confirmShares(h, asked(h)).then(
      () => "ok",
      () => "error",
    );
    kv.set = real;
    expect(first).toBe("error"); // the commit's pointer write landed, then reported a failure
    const neu = await rebuild(asked(h));
    expect((await w.opens(neu)) !== (await w.opens(w.recoveryCode))).toBe(true); // exactly one of them
    await w.svc.confirmShares(h, asked(h)); // the same handle again: done (LANDED, or the commit made now)
    expect(await w.opens(neu)).toBe(true);
    expect(await w.opens(w.recoveryCode)).toBe(false);
  });
  it("the master password is checked first: a wrong one is refused and recorded, and nothing else is written", async () => {
    const w = await world();
    const rest = () => JSON.stringify([...w.kv.data.entries()].filter(([k]) => k !== SECURITY_LOG_KEY));
    const before = rest();
    await expect(
      w.svc.prepareShares({ password: "not-the-password-at-all-9" }, { threshold: 2, count: 3 }),
    ).rejects.toMatchObject({ code: "wrong_secret" });
    expect(rest()).toBe(before);
    expect(await w.kinds()).toContain("unlock_failed");
  });
  it("needs an unlocked vault, and a vault with a recovery code: locked; a Phase 0 device-key vault is not_protected", async () => {
    const w = await world();
    await w.svc.lock();
    await expect(w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 })).rejects.toMatchObject({
      code: "locked",
    });
    const kv = new MemoryKV();
    const store = new VaultStore({ lock: createMutex(), kv, now: () => 1 });
    await legacyDeviceVault(store);
    const svc = new VaultService({ store, session: new MemorySession(), settings: new KvSettingsStore(kv) });
    await expect(svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 })).rejects.toMatchObject({
      code: "not_protected",
    });
    await expect(svc.prepareShares({ recoveryCode: "0000" }, { threshold: 2, count: 3 })).rejects.toMatchObject({
      code: "not_protected",
    });
  });
  it("the set's shape: 2 <= threshold <= count <= 16", async () => {
    const w = await world();
    for (const s of [
      { threshold: 1, count: 3 },
      { threshold: 4, count: 3 },
      { threshold: 2, count: 17 },
      { threshold: 2.5, count: 3 },
    ])
      await expect(w.svc.prepareShares({ password: STRONG }, s)).rejects.toThrow(RangeError);
  });
  it("the members to type back are drawn uniformly: every pair of 3, every triple of 5, about equally often", async () => {
    const w = await world();
    const seen = new Map<string, number>();
    for (let i = 0; i < 150; i++) {
      const h = await w.svc.prepareShares({ recoveryCode: w.recoveryCode }, { threshold: 2, count: 3 });
      seen.set(h.test.join(), (seen.get(h.test.join()) ?? 0) + 1);
      expect([...h.test].sort()).toEqual(h.test);
    }
    expect([...seen.keys()].sort()).toEqual(["0,1", "0,2", "1,2"]);
    for (const n of seen.values()) expect(n).toBeGreaterThan(25); // about 50 each
    const triples = new Set<string>();
    for (let i = 0; i < 120; i++)
      triples.add(
        (await w.svc.prepareShares({ recoveryCode: w.recoveryCode }, { threshold: 3, count: 5 })).test.join(),
      );
    expect(triples.size).toBe(10);
  });
});

describe("split: shares of the current recovery code, nothing written", () => {
  it("the shares rebuild the current code; making them is recorded (shares_made), the test restore writes nothing", async () => {
    const w = await world();
    const vault = () => JSON.stringify([...w.kv.data.entries()].filter(([k]) => k !== SECURITY_LOG_KEY));
    const was = vault();
    const h = await w.svc.prepareShares({ recoveryCode: w.recoveryCode }, { threshold: 2, count: 3 });
    expect(vault()).toBe(was); // nothing of the vault
    expect((await w.kinds())[0]).toBe("shares_made"); // newest first; a kind, no set id, no share
    const before = w.disk();
    expect(h.mode).toBe("split");
    expect(await rebuild(asked(h))).toBe(w.recoveryCode);
    await w.svc.confirmShares(h, asked(h));
    expect(w.disk()).toBe(before);
    expect(await w.opens(w.recoveryCode)).toBe(true);
  });
  it("the typed code is accepted the way the recovery code is read (lower case, spaces)", async () => {
    const w = await world();
    const loose = w.recoveryCode.toLowerCase().replace(/-/g, " ");
    const h = await w.svc.prepareShares({ recoveryCode: loose }, { threshold: 2, count: 3 });
    expect(await rebuild(asked(h))).toBe(w.recoveryCode);
  });
  it("a wrong code: refused and recorded as recovery_failed; a malformed one is a typo, not recorded", async () => {
    const w = await world();
    const other = (await makeShareSet(new Uint8Array(16).fill(7), 2, 2)).shares; // a well-formed code of no vault
    const wrong = await rebuild(other);
    await expect(w.svc.prepareShares({ recoveryCode: wrong }, { threshold: 2, count: 3 })).rejects.toMatchObject({
      code: "wrong_secret",
    });
    expect((await w.kinds()).filter((k) => k === "recovery_failed")).toHaveLength(1);
    await expect(w.svc.prepareShares({ recoveryCode: "ABCD" }, { threshold: 2, count: 3 })).rejects.toMatchObject({
      code: "recovery_length",
    });
    expect((await w.kinds()).filter((k) => k === "recovery_failed")).toHaveLength(1);
  });
  it("the code changed after the shares were made: the test restore is refused (wrong_secret)", async () => {
    const w = await world();
    const h = await w.svc.prepareShares({ recoveryCode: w.recoveryCode }, { threshold: 2, count: 3 });
    await codeOf((d) => w.make().newRecoveryCode(STRONG, d));
    await expect(w.svc.confirmShares(h, asked(h))).rejects.toMatchObject({ code: "wrong_secret" });
  });
});

describe("check my shares: writes nothing, records nothing", () => {
  it("current, then stale after a new recovery code; the disk and the security record are untouched", async () => {
    const w = await world();
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    await w.svc.confirmShares(h, asked(h));
    const code = await rebuild(others(h).concat(asked(h)).slice(0, 2));
    let before = w.disk();
    expect(await w.svc.checkRecoveryCode(code)).toBe("current_before_restart"); // the switch's reminder stays (N1)
    expect(w.disk()).toBe(before);
    await w.svc.browserStarted();
    before = w.disk();
    expect(await w.svc.checkRecoveryCode(code)).toBe("current"); // and the reminder of the switch, its one write, goes
    expect(w.disk()).toBe(
      before.replace(/,"remind":\{"kind":"shares","at":\d+,"due":true,"id":"[0-9a-f]{16}","set":"[0-9A-F]{4}"\}/, ""),
    );
    before = w.disk();
    expect(await w.svc.checkRecoveryCode(code)).toBe("current");
    expect(w.disk()).toBe(before); // nothing at all now
    await codeOf((d) => w.make().newRecoveryCode(STRONG, d)); // the recovery code changed: the shares are stale
    before = w.disk();
    expect(await w.svc.checkRecoveryCode(code)).toBe("stale");
    expect(w.disk()).toBe(before); // not even the security record
  });
  it("needs an unlocked vault (no oracle for someone at a locked page), and a well-formed code", async () => {
    const w = await world();
    await expect(w.svc.checkRecoveryCode("12")).rejects.toMatchObject({ code: "recovery_length" });
    await w.svc.lock();
    await expect(w.svc.checkRecoveryCode(w.recoveryCode)).rejects.toMatchObject({ code: "locked" });
  });
});

describe("no persistence: no share, no code and no R anywhere Sixkey stores", () => {
  async function found(w: W, h: PreparedShares) {
    const code = await rebuild(asked(h));
    const r = await parseRecoveryCode(code);
    const needles = [
      ...h.shares,
      ...h.shares.map((s) => s.replace(/-/g, "")),
      code,
      code.replace(/-/g, ""),
      toB64(r),
      Buffer.from(r).toString("hex"),
      ...(await Promise.all(h.shares.map(parseShare))).map((p) => toB64(p.value)),
    ];
    const stored = [
      JSON.stringify([...w.kv.data.entries()]),
      JSON.stringify([...w.mirror.data.entries()]),
      JSON.stringify(await w.session.get()),
      JSON.stringify(await w.session.getQuick()),
    ].join("\n");
    return needles.filter((n) => stored.includes(n));
  }
  it("after prepare, after the commit (replace), after a split and a check", async () => {
    const w = await world();
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 3, count: 5 });
    expect(await found(w, h)).toEqual([]);
    await w.svc.confirmShares(h, asked(h));
    expect(await found(w, h)).toEqual([]);
    const s = await w.svc.prepareShares({ recoveryCode: await rebuild(asked(h)) }, { threshold: 2, count: 3 });
    await w.svc.confirmShares(s, asked(s));
    await w.svc.checkRecoveryCode(await rebuild(asked(s)));
    expect(await found(w, s)).toEqual([]);
    expect(await found(w, h)).toEqual([]);
  });
});

describe("the commit's guards, one at a time (the review's R4, R5, R6)", () => {
  it("R4: the test restore with the asked members of ANOTHER set of the same code is refused (shares_mixed), split and replace", async () => {
    const w = await world();
    const a = await w.svc.prepareShares({ recoveryCode: w.recoveryCode }, { threshold: 2, count: 3 });
    const b = await w.svc.prepareShares({ recoveryCode: w.recoveryCode }, { threshold: 2, count: 3 });
    const fromA = b.test.map((i) => a.shares[i]!); // the members B asks for, from A's papers: the same R, another set
    expect(await rebuild(fromA)).toBe(w.recoveryCode); // they combine, so only the set id tells them apart
    await expect(w.svc.confirmShares(b, fromA)).rejects.toMatchObject({ code: "shares_mixed" });
    const c = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    const d = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    const before = w.disk();
    await expect(
      w.svc.confirmShares(
        d,
        d.test.map((i) => c.shares[i]!),
      ),
    ).rejects.toMatchObject({
      code: "shares_mixed",
    });
    expect(w.disk()).toBe(before);
  });
  it("R5: a commit that landed and stayed (it reported an error and could not be taken back) is done when tried again", async () => {
    const w = await world();
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    const kv = w.kv as MemoryKV & { set: MemoryKV["set"] };
    const real = kv.set.bind(kv);
    let phase: "normal" | "landed" | "broken" = "normal";
    kv.set = async (items) => {
      if (phase === "broken") throw new Error("the disk refuses every write now");
      await real(items);
      if (phase === "normal" && Object.keys(items).includes(KEYS.active)) {
        phase = "broken"; // the pointer landed; the error, and the store's write taking it back, both fail
        throw new Error("reported a failure after landing");
      }
    };
    await expect(w.svc.confirmShares(h, asked(h))).rejects.toThrow();
    kv.set = real;
    const neu = await rebuild(asked(h));
    expect(await w.opens(neu)).toBe(true); // it stayed: the keyring on disk is the new one
    await w.svc.confirmShares(h, asked(h)); // LANDED: done, not "keys changed meanwhile"
    expect(await w.opens(neu)).toBe(true);
    expect(await w.opens(w.recoveryCode)).toBe(false);
  });
  it("R6: sync turned on between the set and the switch: refused (sync_on), nothing written", async () => {
    const sync = { on: false };
    const w = await world({ sync });
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    sync.on = true;
    const before = w.disk();
    await expect(w.svc.confirmShares(h, asked(h))).rejects.toMatchObject({ code: "sync_on" });
    expect(w.disk()).toBe(before);
    expect(await w.opens(w.recoveryCode)).toBe(true);
  });
});

describe("the reminder after a switch: at every unlock from the next start of the browser, until a check (F1)", () => {
  it("set (not due) by the switch, due after browserStarted, gone when Check my shares passes", async () => {
    const w = await world();
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    expect((await w.security.read()).remind).toBeUndefined();
    await w.svc.confirmShares(h, asked(h));
    expect((await w.security.read()).remind).toBeUndefined(); // not in this browser session
    await w.svc.browserStarted();
    expect((await w.security.read()).remind).toBe("shares");
    await w.svc.browserStarted(); // again: still due, nothing else
    expect((await w.security.read()).remind).toBe("shares");
    expect(await w.svc.checkRecoveryCode(await rebuild(asked(h).slice().reverse()))).toBe("current");
    expect((await w.security.read()).remind).toBeUndefined();
  });
  it("a stale check keeps it; any other recovery code change drops it; a split never sets one; nothing secret in it", async () => {
    const w = await world();
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    await w.svc.confirmShares(h, asked(h));
    await w.svc.browserStarted();
    let oset = await makeShareSet(new Uint8Array(16).fill(3), 2, 2);
    while (setIdText(oset.setId) === h.setId) oset = await makeShareSet(new Uint8Array(16).fill(3), 2, 2);
    const other = await rebuild(oset.shares);
    expect(await w.svc.checkRecoveryCode(other, setIdText(oset.setId))).toBe("stale"); // another set's: just stale (FU-2)
    expect(await w.svc.checkRecoveryCode(other)).toBe("stale"); // no set said: just stale
    expect(await w.svc.checkRecoveryCode(other, h.setId)).toBe("stale_after_switch"); // the switched set's: lost
    expect((await w.security.read()).remind).toBe("shares");
    const stored = JSON.stringify((await w.kv.get([SECURITY_LOG_KEY]))[SECURITY_LOG_KEY]);
    for (const n of [...h.shares, await rebuild(asked(h))])
      expect(stored).not.toContain(n.replace(/-/g, "").slice(0, 8));
    await codeOf((d) => w.make().newRecoveryCode(STRONG, d));
    expect((await w.security.read()).remind).toBeUndefined();
    const s2 = await w.svc
      .prepareShares({ recoveryCode: w.recoveryCode }, { threshold: 2, count: 3 })
      .catch(() => null);
    expect(s2).toBeNull(); // the old code is no more: wrong_secret (and no reminder from a split either way)
    await w.svc.browserStarted();
    expect((await w.security.read()).remind).toBeUndefined();
  });
});

describe("the review's N1: a check before the restart proves nothing about the commit, and keeps the reminder", () => {
  it("switch, check at once, a browser start: still due; the popup says so; a check after the start drops it", async () => {
    const w = await world();
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    await w.svc.confirmShares(h, asked(h));
    const code = await rebuild(asked(h));
    expect(await w.svc.checkRecoveryCode(code)).toBe("current_before_restart");
    expect(await w.svc.checkRecoveryCode(code)).toBe("current_before_restart"); // as often as asked
    await w.svc.browserStarted();
    expect(await readNotice({ security: w.security })).toEqual({ remind: true });
    expect(await readNotice({ security: w.security })).toEqual({ remind: true }); // at every unlock, until a check (N4)
    expect(await w.svc.checkRecoveryCode(code)).toBe("current");
    expect(await readNotice({ security: w.security })).toBeNull();
    expect(await w.svc.checkRecoveryCode(code)).toBe("current"); // nothing left to say
  });
  it("without a switch waiting: current and stale as before, whatever the restarts", async () => {
    const w = await world();
    await w.svc.browserStarted();
    expect(await w.svc.checkRecoveryCode(w.recoveryCode)).toBe("current");
    const other = await rebuild((await makeShareSet(new Uint8Array(16).fill(5), 2, 2)).shares);
    expect(await w.svc.checkRecoveryCode(other)).toBe("stale");
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    await w.svc.confirmShares(h, asked(h));
    expect(await w.svc.checkRecoveryCode(other)).toBe("stale"); // not yet due: these may be any other shares
  });
});

describe("the review's N2: a new vault ends the reminder (the security record outlives the vault)", () => {
  /** A world whose switch's reminder is due, then its vault's data gone (the security record kept): "empty" or "lost". */
  async function due(state: "empty" | "lost") {
    const w = await world();
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    await w.svc.confirmShares(h, asked(h));
    await w.svc.browserStarted();
    expect((await w.security.read()).remind).toBe("shares");
    for (const k of [...w.kv.data.keys()]) if (k !== SECURITY_LOG_KEY) w.kv.data.delete(k);
    w.mirror.data.clear();
    if (state === "lost") {
      w.kv.data.set(KEYS.active, "a");
      w.kv.data.set(KEYS.slot.a, "garbage");
      w.kv.data.set(KEYS.slot.b, { torn: "half a write" });
    }
    const svc = w.make();
    expect((await svc.status()).state).toBe(state);
    return { w, svc };
  }
  it.each([
    ["a first vault", "empty", (svc: VaultService) => createProtected(svc)],
    [
      "a backup restored",
      "empty",
      async (svc: VaultService) =>
        svc.restoreBackup(
          emptyVault("backup-vault-id-1"),
          await svc.prepareKeys(STRONG, { vaultId: "backup-vault-id-1" }),
        ),
    ],
    [
      "a backup restored over unreadable data",
      "lost",
      async (svc: VaultService) =>
        svc.restoreBackup(
          emptyVault("backup-vault-id-1"),
          await svc.prepareKeys(STRONG, { vaultId: "backup-vault-id-1" }),
        ),
    ],
    ["Start over", "lost", async (svc: VaultService) => svc.startOver(await svc.prepareKeys(STRONG))],
  ] as const)("%s: no reminder after it, and the record's entries kept", async (_name, state, make) => {
    const { w, svc } = await due(state);
    const kinds = await w.kinds();
    await make(svc);
    expect((await w.security.read()).remind).toBeUndefined();
    expect(await readNotice({ security: w.security })).toBeNull();
    expect(await w.kinds()).toEqual(kinds);
  });
});

describe("the review's N7: the reminder is set before the switch's save, and put back if the save is refused", () => {
  const remindOn = async (w: W) =>
    ((await w.kv.get([SECURITY_LOG_KEY]))[SECURITY_LOG_KEY] as { remind?: unknown } | undefined)?.remind;
  it("the order of writes: the reminder first, then the save's pointer", async () => {
    const w = await world();
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    const kv = w.kv as MemoryKV & { set: MemoryKV["set"] };
    const real = kv.set.bind(kv);
    const order: string[] = [];
    kv.set = async (items) => {
      const log = items[SECURITY_LOG_KEY] as { remind?: unknown } | undefined;
      if (log?.remind) order.push("remind");
      if (KEYS.active in items) order.push("pointer");
      await real(items);
    };
    await w.svc.confirmShares(h, asked(h));
    kv.set = real;
    expect(order.indexOf("remind")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("remind")).toBeLessThan(order.indexOf("pointer"));
    expect(await remindOn(w)).toMatchObject({ kind: "shares", at: w.t.now, due: false, set: h.setId });
    expect((await remindOn(w)) as { id: string }).toHaveProperty("id", expect.stringMatching(/^[0-9a-f]{16}$/));
  });
  it("refused before anything is written (locked, sync on, keys changed): no reminder written at all", async () => {
    const sync = { on: false };
    const w = await world({ sync });
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    const before = w.disk();
    sync.on = true;
    await expect(w.svc.confirmShares(h, asked(h))).rejects.toMatchObject({ code: "sync_on" });
    sync.on = false;
    await w.svc.lock();
    await expect(w.svc.confirmShares(h, asked(h))).rejects.toMatchObject({ code: "locked" });
    expect(w.disk()).toBe(before);
  });
  it("refused under the store's lock after the reminder was set: put back as it was (an earlier switch's, due)", async () => {
    const sync = { on: false };
    const w = await world({ sync });
    const h1 = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    await w.svc.confirmShares(h1, asked(h1));
    await w.svc.browserStarted();
    const earlier = await remindOn(w);
    expect(earlier).toMatchObject({ due: true });
    w.t.now += 60_000;
    const h2 = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    const kv = w.kv as MemoryKV & { set: MemoryKV["set"] };
    const real = kv.set.bind(kv);
    kv.set = async (items) => {
      await real(items);
      if ((items[SECURITY_LOG_KEY] as { remind?: { due: boolean } } | undefined)?.remind?.due === false) sync.on = true;
    };
    await expect(w.svc.confirmShares(h2, asked(h2))).rejects.toMatchObject({ code: "sync_on" });
    kv.set = real;
    expect(await remindOn(w)).toEqual(earlier); // the earlier switch's, exactly
    expect(await w.opens(await rebuild(asked(h1)))).toBe(true); // that switch is the one in force
  });
  it("refused because another key change came first: no reminder, not even an earlier switch's (that change ends one)", async () => {
    const w = await world();
    const h1 = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    await w.svc.confirmShares(h1, asked(h1));
    await w.svc.browserStarted();
    expect(await remindOn(w)).toMatchObject({ due: true });
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    const remind = w.security.remind.bind(w.security);
    let raced = false;
    w.security.remind = async (to) => {
      const r = await remind(to);
      if (to !== null && !raced) {
        raced = true; // another page, between the reminder and the save
        await codeOf((d) => w.make().newRecoveryCode(STRONG, d));
      }
      return r;
    };
    await expect(w.svc.confirmShares(h, asked(h))).rejects.toMatchObject({ code: "bad_state" });
    expect(raced).toBe(true);
    expect(await remindOn(w)).toBeUndefined();
  });
  it("a save that reported an error but landed and stayed: the reminder stays; the same handle then finishes", async () => {
    const w = await world();
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    const kv = w.kv as MemoryKV & { set: MemoryKV["set"] };
    const real = kv.set.bind(kv);
    let phase: "normal" | "broken" = "normal";
    kv.set = async (items) => {
      // the vault's writes refused from here on (so the save cannot be taken back); the security record's still work
      if (phase === "broken" && !(SECURITY_LOG_KEY in items))
        throw new Error("the disk refuses the vault's writes now");
      await real(items);
      if (KEYS.active in items) {
        phase = "broken";
        throw new Error("reported a failure after landing");
      }
    };
    await expect(w.svc.confirmShares(h, asked(h))).rejects.toThrow();
    kv.set = real;
    expect(await w.opens(await rebuild(asked(h)))).toBe(true); // it landed
    expect(await remindOn(w)).toMatchObject({ kind: "shares", due: false }); // and its reminder stayed (not taken back)
    await w.svc.confirmShares(h, asked(h));
    expect(await remindOn(w)).toMatchObject({ kind: "shares", due: false });
  });
  it("a save that reported an error and was taken back: the reminder too", async () => {
    const w = await world();
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    const kv = w.kv as MemoryKV & { set: MemoryKV["set"] };
    const real = kv.set.bind(kv);
    kv.set = async (items) => {
      if (KEYS.active in items && kv.set !== real) {
        kv.set = real;
        throw new Error("the pointer write failed");
      }
      await real(items);
    };
    await expect(w.svc.confirmShares(h, asked(h))).rejects.toThrow("the pointer write failed");
    kv.set = real;
    expect(await w.opens(w.recoveryCode)).toBe(true); // not landed
    expect(await remindOn(w)).toBeUndefined();
  });
});

describe("the review's FU-1: a refused switch takes back only its own reminder", () => {
  /**
   * Two pages (two services over one storage, one store lock, one security record). B's save waits at the store until
   * `go()`; `at` resolves once B has passed its check and written its reminder (the reviewer's repro).
   */
  async function two() {
    const kv = new MemoryKV();
    const mirror = new MemoryKV();
    const session = new MemorySession();
    const lock = createMutex();
    const t = { now: 1_700_000_000_000 }; // one millisecond for everything: the reminders' times all collide
    const security = new SecurityLog({ kv, now: () => t.now });
    const settings = new KvSettingsStore(kv);
    const page = () => {
      const store = new VaultStore({ lock, kv, mirror, now: () => t.now });
      const svc = new VaultService({
        store,
        session,
        settings,
        security,
        now: () => t.now,
        kdfIterations: TEST_KDF_ITERATIONS,
      });
      return { store, svc };
    };
    const A = page();
    const B = page();
    await createProtected(A.svc);
    let go!: () => void;
    const gate = new Promise<void>((r) => (go = r));
    let reached!: () => void;
    const at = new Promise<void>((r) => (reached = r));
    const real = B.store.transact.bind(B.store);
    (B.store as { transact: typeof real }).transact = (async (fn: Parameters<typeof real>[0]) => {
      reached();
      await gate;
      return real(fn);
    }) as typeof real;
    const opens = async (code: string) =>
      (await unlockWithRecoveryCode((await A.svc.currentGeneration())!.keyring, code).catch(() => null)) !== null;
    return { A, B, security, go, at, opens };
  }
  const outcome = (p: Promise<void>) =>
    p.then(
      () => "ok",
      (e) => (e as { code?: string }).code,
    );
  it("two pages switch at once: A lands, B is refused under the lock; A's reminder stays", async () => {
    const w = await two();
    const hA = await w.A.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    const hB = await w.B.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    const pB = outcome(w.B.svc.confirmShares(hB, asked(hB)));
    await w.at; // B passed its check and set its reminder
    await w.A.svc.confirmShares(hA, asked(hA)); // A lands: its done screen says to keep the old code until a check
    w.go();
    expect(await pB).toBe("bad_state"); // keys changed meanwhile
    expect(await w.opens(await rebuild(asked(hA)))).toBe(true); // A's code in force
    await w.A.svc.browserStarted();
    expect(await readNotice({ security: w.security })).toEqual({ remind: true });
    expect(await w.A.svc.checkRecoveryCode(await rebuild(asked(hB)), hB.setId)).toBe("stale"); // B's set: not A's
  });
  it("an earlier switch's due reminder, then a new switch raced by a password change: the earlier one is put back", async () => {
    const w = await two();
    const h1 = await w.A.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    await w.A.svc.confirmShares(h1, asked(h1));
    await w.A.svc.browserStarted(); // due, not yet checked
    const earlier = (await w.security.checked(false)).set;
    const hB = await w.B.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    const pB = outcome(w.B.svc.confirmShares(hB, asked(hB)));
    await w.at;
    await w.A.svc.changePassword(STRONG, "violet-harbor-copper-93"); // not a recovery code change
    w.go();
    expect(await pB).toBe("bad_state");
    expect(await w.opens(await rebuild(asked(h1)))).toBe(true); // switch 1's code in force, unchecked
    expect(await readNotice({ security: w.security })).toEqual({ remind: true });
    expect(await w.security.checked(false)).toEqual({ state: "due", set: earlier });
  });
  it("rule 1: a reminder whose write reported an error is not taken back by a refused save (an earlier one stays covered)", async () => {
    const sync = { on: false };
    const w = await world({ sync });
    const h1 = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    await w.svc.confirmShares(h1, asked(h1));
    await w.svc.browserStarted();
    const h2 = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    const kv = w.kv as MemoryKV & { set: MemoryKV["set"] };
    const real = kv.set.bind(kv);
    kv.set = async (items) => {
      await real(items);
      if ((items[SECURITY_LOG_KEY] as { remind?: { due: boolean } } | undefined)?.remind?.due === false) {
        kv.set = real;
        sync.on = true; // and the save is refused
        throw new Error("the reminder's write landed, then reported a failure");
      }
    };
    await expect(w.svc.confirmShares(h2, asked(h2))).rejects.toMatchObject({ code: "sync_on" });
    kv.set = real;
    // what was there before is not known: the reminder written stays (it becomes due at the next start, as one must)
    expect(await w.security.checked(false)).toEqual({ state: "set", set: h2.setId });
  });
  it("rule 2: the keys cannot be read after a refused save: the reminder stays", async () => {
    const w = await world();
    const h = await w.svc.prepareShares({ password: STRONG }, { threshold: 2, count: 3 });
    const kv = w.kv as MemoryKV & { set: MemoryKV["set"]; get: MemoryKV["get"] };
    const real = { set: kv.set.bind(kv), get: kv.get.bind(kv) };
    let broken = false;
    kv.set = async (items) => {
      await real.set(items);
      if ((items[SECURITY_LOG_KEY] as { remind?: unknown } | undefined)?.remind) broken = true;
    };
    kv.get = async (keys) => {
      if (broken && keys.some((k) => k !== SECURITY_LOG_KEY)) throw new Error("the vault's data cannot be read now");
      return real.get(keys);
    };
    await expect(w.svc.confirmShares(h, asked(h))).rejects.toThrow("cannot be read");
    kv.set = real.set;
    kv.get = real.get;
    expect(await w.opens(w.recoveryCode)).toBe(true); // not landed
    expect(await w.security.checked(false)).toEqual({ state: "set", set: h.setId }); // kept: it cannot be told
  });
});
