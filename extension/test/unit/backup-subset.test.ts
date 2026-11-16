// "Export selected accounts" (PHASE0X-PLAN C6, SYNC-DESIGN §9.1 H2 and review H-d): the file holds the selected live
// accounts and nothing else of the vault they came from. Every source value below is a distinct token (fixed width, its
// own prefix), so "this text is nowhere in the file" means something: no token can be part of another or of a field name.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fromB64, toB64, randomBytes } from "../../src/core/crypto/bytes";
import { BackupError, createBackup, openBackup } from "../../src/core/backup/backup";
import { buildSubsetVault, createSubsetBackup, sameAsShown, selectedEntries } from "../../src/core/backup/subset";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession } from "../../src/core/service/types";
import { encodeBase32 } from "../../src/core/totp/base32";
import { createClock, formatHlc, parseHlc } from "../../src/core/vault/hlc";
import { aliveEntries, emptyVault, isAlive, type Entry, type Vault } from "../../src/core/vault/model";
import { addEntry, deleteEntry, editEntry, moveEntry, purgeEntry, rebalance, setGroup } from "../../src/core/vault/ops";
import { mergeVaults } from "../../src/core/vault/merge";
import { deserializeVault, serializeVault } from "../../src/core/vault/validate";
import { createProtected, STRONG } from "../helpers/vaults";

const NOW = 1_800_000_000_000; // the export time: far from every source time (2020-2023 below)
const FILE_PW = "a file password for the shared profile 7";
const SRC_DEVICES = ["srcdeva", "srcdevb", "srcdevc"]; // lower case: no token below (upper case) can contain one
const ENTRY_KEYS = new Set([
  "id",
  "createdAt",
  "type",
  "issuer",
  "label",
  "secret",
  "algorithm",
  "digits",
  "period",
  "counter",
  "group",
  "domains",
  "hlc",
  "order",
  "phlc",
]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type State = "alive" | "restored" | "resurrected" | "trash" | "purged";
const ALIVE: readonly State[] = ["alive", "restored", "resurrected"];
type Spec = {
  state: State;
  type: "totp" | "hotp";
  counter: number;
  totpCounter: boolean;
  group: number | null;
  domains: boolean;
  created: number;
  wall: number;
  dev: number;
  alg: "SHA1" | "SHA256" | "SHA512";
  digits: 6 | 8;
  period: number;
};
type Src = { vault: Vault; salt: string; specs: Spec[]; ids: string[]; groups: string[] };

const pad = (i: number) => String(i).padStart(3, "0");
const tok = (src: Src, i: number) => ({
  id: `src-${pad(i)}-${src.salt}`,
  issuer: `ISS${pad(i)}X${src.salt}`,
  label: `LBL${pad(i)}X${src.salt}`,
  // a canonical base32 secret, unique per entry, all the same length
  secret: encodeBase32(Uint8Array.from([0x5a, i >> 8, i & 255, ...src.salt.split("").map((c) => c.charCodeAt(0))])),
  domain: `d${pad(i)}x${src.salt.toLowerCase()}.example`,
  order: `Zz${pad(i)}${src.salt}y`,
});
const groupName = (salt: string, k: number) => `GRP${k}X${salt}`;

const specArb: fc.Arbitrary<Spec> = fc.record({
  state: fc.constantFrom<State>("alive", "alive", "restored", "resurrected", "trash", "purged"),
  type: fc.constantFrom("totp" as const, "hotp" as const),
  counter: fc.integer({ min: 0, max: 99 }),
  totpCounter: fc.boolean(), // a counter left on a TOTP entry (merge keeps it after a type change)
  group: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }),
  domains: fc.boolean(),
  created: fc.integer({ min: 1_600_000_000_000, max: 1_650_000_000_000 }),
  wall: fc.integer({ min: 1_650_000_000_000, max: 1_700_000_000_000 }),
  dev: fc.integer({ min: 0, max: SRC_DEVICES.length - 1 }),
  alg: fc.constantFrom("SHA1" as const, "SHA256" as const, "SHA512" as const),
  digits: fc.constantFrom(6 as const, 8 as const),
  period: fc.constantFrom(30, 60),
});

function makeSource(salt: string, specs: Spec[]): Src {
  const src: Src = {
    vault: emptyVault(`srcvault-${salt}`),
    salt,
    specs,
    ids: [],
    groups: [0, 1, 2, 3].map((k) => groupName(salt, k)),
  };
  const entries = specs.map((s, i): Entry => {
    const k = tok(src, i);
    const h = (w: number) => formatHlc(w, i, SRC_DEVICES[s.dev]!);
    const e: Entry = {
      id: k.id,
      createdAt: s.created,
      type: s.type,
      issuer: k.issuer,
      label: k.label,
      secret: k.secret,
      algorithm: s.alg,
      digits: s.digits,
      period: s.period,
      hlc: h(s.wall),
      order: k.order,
      phlc: h(s.wall - 1),
    };
    if (s.type === "hotp" || s.totpCounter) e.counter = s.counter;
    if (s.domains) e.domains = [k.domain];
    if (s.group !== null) e.group = src.groups[s.group]!;
    if (s.state === "restored") {
      e.deleted = false;
      e.dhlc = h(s.wall - 2);
    }
    if (s.state === "resurrected") {
      e.deleted = true;
      e.dhlc = h(s.wall - 2);
    } // edited after the delete: alive again
    if (s.state === "trash") {
      e.deleted = true;
      e.dhlc = h(s.wall + 5);
    }
    if (s.state === "purged") {
      // what purgeEntry leaves: the group and order stay, the content is gone
      Object.assign(e, { issuer: "", label: "", secret: "", deleted: true, dhlc: h(s.wall + 5) });
      delete e.counter;
      delete e.domains;
    }
    return e;
  });
  src.ids = entries.map((e) => e.id);
  // through the reader, as a vault loaded from disk would be
  src.vault = deserializeVault(serializeVault({ ...src.vault, entries }));
  return src;
}

const sourceArb = fc
  .record({
    salt: fc.integer({ min: 32 ** 5, max: 32 ** 6 - 1 }).map((n) => n.toString(32).toUpperCase()),
    specs: fc.array(specArb, { minLength: 1, maxLength: 14 }),
  })
  .map((r) => makeSource(r.salt, r.specs));
/** A source and a selection from it: any of its ids (dead ones too), some twice, plus ids that match nothing. */
const caseArb = sourceArb.chain((src) =>
  fc
    .tuple(
      fc.subarray(src.specs.map((_, i) => i)),
      fc.array(fc.integer({ min: 0, max: src.specs.length - 1 }), { maxLength: 2 }),
      fc.boolean(),
    )
    .map(([pick, again, ghost]) => ({
      src,
      pick: new Set(pick),
      ids: [
        ...pick.map((i) => src.ids[i]!),
        ...again.filter((i) => pick.includes(i)).map((i) => src.ids[i]!),
        ...(ghost ? [`nothing-${src.salt}`] : []),
      ],
    })),
);

/** What the file must hold: the selected accounts the generator made alive, from the specs (not from the code under test). */
const expectedOf = (src: Src, pick: Set<number>) =>
  src.specs.map((s, i) => ({ s, i })).filter(({ s, i }) => pick.has(i) && ALIVE.includes(s.state));
const content = (e: Entry) => ({
  type: e.type,
  issuer: e.issuer,
  label: e.label,
  secret: e.secret,
  algorithm: e.algorithm,
  digits: e.digits,
  period: e.period,
  counter: e.counter,
  group: e.group,
  domains: e.domains,
});
const bySecret = <T extends { secret: string }>(a: T, b: T) => (a.secret < b.secret ? -1 : a.secret > b.secret ? 1 : 0);
const devicesOf = (v: Vault) =>
  new Set(
    v.entries
      .flatMap((e) => [e.hlc, e.phlc, e.dhlc])
      .filter((h): h is string => !!h)
      .map((h) => parseHlc(h)!.device),
  );
const text = (v: Vault) => new TextDecoder().decode(serializeVault(v));

/** The order keys rebalance gives n entries: a subset's keys depend on how many accounts it holds, nothing else. */
function spreadFor(n: number): string[] {
  const c = createClock("keys", { now: () => 1 });
  let v = emptyVault("vault-keys-only");
  for (let i = 0; i < n; i++)
    v = addEntry(
      v,
      { type: "totp", issuer: "", label: "", secret: "AAAA", algorithm: "SHA1", digits: 6, period: 30 },
      c,
      { id: `id-${pad(i)}-keys` },
    ).vault;
  return rebalance(v, c)
    .entries.map((e) => e.order)
    .sort();
}

/** Every rule of the file's content (subset.ts, top), for one source and selection. */
function checkSubset(src: Src, pick: Set<number>, sub: Vault): void {
  const want = expectedOf(src, pick);
  // the vault: three fields, a new id
  expect(Object.keys(sub).sort()).toEqual(["entries", "schemaVersion", "vaultId"]);
  expect(sub.schemaVersion).toBe(1);
  expect(sub.vaultId).not.toBe(src.vault.vaultId);
  // exactly the selected live accounts, each exactly as it is in the source
  expect(sub.entries).toHaveLength(want.length);
  const wantContent = want.map(({ s, i }) => {
    const src0 = src.vault.entries.find((e) => e.id === src.ids[i])!;
    return { ...content(src0), counter: s.type === "hotp" ? s.counter : undefined };
  });
  const clean = (o: object) => JSON.parse(JSON.stringify(o)) as unknown;
  expect(clean(sub.entries.map(content).sort(bySecret))).toEqual(clean(wantContent.sort(bySecret)));
  // in the order they are listed now, on keys that depend only on how many there are
  const listed = aliveEntries(src.vault)
    .filter((e) => want.some(({ i }) => src.ids[i] === e.id))
    .map((e) => e.secret);
  expect([...sub.entries].sort((a, b) => (a.order < b.order ? -1 : 1)).map((e) => e.secret)).toEqual(listed);
  expect(sub.entries.map((e) => e.order).sort()).toEqual(spreadFor(want.length));

  const subDevices = devicesOf(sub);
  expect(subDevices.size).toBe(1); // one clock for the whole export...
  for (const d of subDevices) expect(SRC_DEVICES).not.toContain(d); // ...that is not any device of the source
  const sourceIds = new Set(src.vault.entries.map((e) => e.id));
  for (const e of sub.entries) {
    for (const k of Object.keys(e)) expect(ENTRY_KEYS.has(k), `field ${k}`).toBe(true); // never deleted or dhlc
    expect(isAlive(e)).toBe(true);
    expect(e.id).toMatch(UUID_V4);
    expect(sourceIds.has(e.id)).toBe(false);
    expect(e.createdAt).toBe(NOW);
    for (const h of [e.hlc, e.phlc]) expect(parseHlc(h)!.wall).toBe(NOW);
    if (e.type === "totp") expect(e.counter).toBeUndefined();
  }
  expect(new Set(sub.entries.map((e) => e.id)).size).toBe(sub.entries.length);

  // and nothing else, anywhere in the decrypted payload
  const plain = text(sub);
  const wanted = new Set(want.map(({ i }) => i));
  const keptGroups = new Set(sub.entries.map((e) => e.group).filter((g): g is string => !!g));
  for (const g of src.groups) {
    const used = want.some(({ s }) => s.group !== null && src.groups[s.group] === g);
    expect(keptGroups.has(g)).toBe(used);
    if (!used) expect(plain).not.toContain(g); // the name of a group no selected account is in
  }
  src.specs.forEach((s, i) => {
    const k = tok(src, i);
    const e = src.vault.entries.find((x) => x.id === k.id)!;
    expect(plain).not.toContain(k.id); // no source id, selected or not
    expect(plain).not.toContain(k.order);
    expect(plain).not.toContain(String(s.created));
    for (const h of [e.hlc, e.phlc, e.dhlc])
      if (h) {
        expect(plain).not.toContain(h);
        expect(plain).not.toContain(String(parseHlc(h)!.wall));
      }
    if (!wanted.has(i))
      for (const x of [k.issuer, k.label, k.secret, k.domain])
        expect(plain, `unselected or dead entry ${i}`).not.toContain(x);
  });
  for (const d of SRC_DEVICES) expect(plain).not.toContain(d);
  expect(plain).not.toContain(src.vault.vaultId);
  expect(plain).not.toContain("dhlc");
  expect(plain).not.toContain("deleted");
}

describe("subset vault (buildSubsetVault)", () => {
  it("holds exactly the selected live accounts and nothing else of the source", () => {
    fc.assert(
      fc.property(caseArb, ({ src, pick, ids }) => {
        if (expectedOf(src, pick).length === 0) {
          expect(() => buildSubsetVault(src.vault, ids, { now: () => NOW })).toThrow(RangeError); // never an empty file
          return;
        }
        checkSubset(src, pick, buildSubsetVault(src.vault, ids, { now: () => NOW }));
      }),
      { numRuns: 300 },
    );
  });

  it("two exports of the same selection share nothing but the accounts: new vault id, entry ids and device every time", () => {
    fc.assert(
      fc.property(caseArb, ({ src, pick, ids }) => {
        if (expectedOf(src, pick).length === 0) return;
        const a = buildSubsetVault(src.vault, ids, { now: () => NOW });
        const b = buildSubsetVault(src.vault, ids, { now: () => NOW });
        expect(a.vaultId).not.toBe(b.vaultId);
        const aIds = new Set(a.entries.map((e) => e.id));
        for (const e of b.entries) expect(aIds.has(e.id)).toBe(false);
        expect([...devicesOf(a)][0]).not.toBe([...devicesOf(b)][0]);
        expect(a.entries.map(content).sort(bySecret)).toEqual(b.entries.map(content).sort(bySecret));
      }),
      { numRuns: 100 },
    );
  });

  it("never uses a vault id, entry id or device id of the source, even from a random source that repeats", () => {
    const zeros = (n: number) => new Uint8Array(n); // newDeviceId gives "00000000", newVaultId "AAAA...", uuid "00000000-0000-4000-8000-..."
    const ZERO_UUID = "00000000-0000-4000-8000-000000000000";
    const one = (o: { vaultId?: string; id?: string; device?: string }) => {
      const c = createClock(o.device ?? "srcdeva", { now: () => 1_700_000_000_000 });
      return addEntry(
        emptyVault(o.vaultId ?? "source-vault-0003"),
        { type: "totp", issuer: "A", label: "a", secret: "GEZDGNBVGY3TQOJQ", algorithm: "SHA1", digits: 6, period: 30 },
        c,
        { id: o.id ?? "source-entry-1" },
      ).vault;
    };
    const v = one({});
    const sub = buildSubsetVault(
      v,
      v.entries.map((e) => e.id),
      { now: () => NOW, rng: zeros },
    ); // nothing to collide with
    expect(sub).toMatchObject({ vaultId: "AAAAAAAAAAAAAAAAAAAAAA", entries: [{ id: ZERO_UUID }] });
    expect(parseHlc(sub.entries[0]!.hlc)!.device).toBe("00000000");
    // a draw that repeats a source value is drawn again; a source of randomness stuck on it fails loudly. Draws come in
    // this order: the device id, the vault id, then one id per entry.
    const nth = (k: number) => {
      let i = 0;
      return (n: number) => (++i === k ? new Uint8Array(n) : randomBytes(n));
    };
    for (const [o, k] of [
      [{ device: "00000000" }, 1],
      [{ vaultId: "AAAAAAAAAAAAAAAAAAAAAA" }, 2],
      [{ id: ZERO_UUID }, 3],
    ] as const) {
      const w = one(o);
      const all = w.entries.map((e) => e.id);
      expect(() => buildSubsetVault(w, all, { now: () => NOW, rng: zeros }), JSON.stringify(o)).toThrow(/repeat/);
      const ok = buildSubsetVault(w, all, { now: () => NOW, rng: nth(k) });
      expect(parseHlc(ok.entries[0]!.hlc)!.device).not.toBe("00000000");
      expect(ok.vaultId).not.toBe("AAAAAAAAAAAAAAAAAAAAAA");
      expect(ok.entries[0]!.id).not.toBe(ZERO_UUID);
    }
    // two new entries never share an id either
    const two = addEntry(
      v,
      { type: "totp", issuer: "B", label: "b", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 },
      createClock("srcdeva"),
      { id: "source-entry-2" },
    ).vault;
    expect(() =>
      buildSubsetVault(
        two,
        two.entries.map((e) => e.id),
        { now: () => NOW, rng: zeros },
      ),
    ).toThrow(/repeat/);
  });

  // C6-REVIEW C6-3: "even a tombstone's" and "not one of the vault's" hold for erased entries and deletion stamps too
  it("never reuses an erased entry's id, nor a device found only in a deletion stamp", () => {
    const ZERO_UUID = "00000000-0000-4000-8000-000000000000";
    const acct = (issuer: string, secret: string) => ({
      type: "totp" as const,
      issuer,
      label: "",
      secret,
      algorithm: "SHA1" as const,
      digits: 6 as const,
      period: 30,
    });
    const nth = (k: number) => {
      let i = 0;
      return (n: number) => (++i === k ? new Uint8Array(n) : randomBytes(n));
    }; // zeros on draw k only
    const c = createClock("srcdeva", { now: () => 1_700_000_000_000 });
    // an erased entry (a tombstone) has the id the third draw (the first entry id) would give
    let v = addEntry(emptyVault("source-vault-0009"), acct("Gone", "MFRGGZDFMZTWQ2LK"), c, { id: ZERO_UUID }).vault;
    v = purgeEntry(deleteEntry(v, ZERO_UUID, c), ZERO_UUID, c);
    v = addEntry(v, acct("Kept", "GEZDGNBVGY3TQOJQ"), c, { id: "kept-entry-0001" }).vault;
    expect(buildSubsetVault(v, ["kept-entry-0001"], { now: () => NOW, rng: nth(3) }).entries[0]!.id).not.toBe(
      ZERO_UUID,
    );
    // a device that appears only as the deletion stamp of a trashed entry, as the first draw (the device) would give
    let w = addEntry(emptyVault("source-vault-0010"), acct("Kept", "GEZDGNBVGY3TQOJQ"), c, {
      id: "kept-entry-0001",
    }).vault;
    w = addEntry(w, acct("Trash", "MFRGGZDFMZTWQ2LK"), c, { id: "trash-entry-0001" }).vault;
    w = deleteEntry(w, "trash-entry-0001", createClock("00000000", { now: () => 1_700_000_100_000 }));
    expect(
      parseHlc(buildSubsetVault(w, ["kept-entry-0001"], { now: () => NOW, rng: nth(1) }).entries[0]!.hlc)!.device,
    ).not.toBe("00000000");
  });

  it("works on vaults made by the real edit operations: trash, purge, edit after delete, groups", () => {
    const c = createClock("srcdeva", { now: () => 1_700_000_000_000 });
    let v = emptyVault("source-vault-0001");
    const add = (issuer: string, secret: string, group?: string) => {
      const r = addEntry(
        v,
        {
          type: "totp",
          issuer,
          label: `${issuer.toLowerCase()}@example.com`,
          secret,
          algorithm: "SHA1",
          digits: 6,
          period: 30,
          ...(group ? { group } : {}),
          domains: [`${issuer.toLowerCase()}.example`],
        },
        c,
      );
      v = r.vault;
      return r.entry.id;
    };
    const gh = add("GitHub", "GEZDGNBVGY3TQOJQ", "Work");
    const aws = add("AWS", "JBSWY3DPEHPK3PXP", "Work");
    const bank = add("Bank", "KRSXG5CTMVRXEZLU", "Private");
    const gone = add("Gone", "MFRGGZDFMZTWQ2LK", "Old");
    const back = add("Back", "NBSWY3DPO5XXE3DE");
    v = purgeEntry(deleteEntry(v, gone, c), gone, c);
    const before = v;
    v = deleteEntry(v, back, c);
    // another device edited it after the delete, and the two copies merged: alive again
    v = mergeVaults(
      v,
      editEntry(
        before,
        back,
        { label: "edited after the delete" },
        createClock("srcdevb", { now: () => 1_700_000_100_000 }),
      ),
    );
    expect(v.entries.find((e) => e.id === back)).toMatchObject({ deleted: true });
    v = deleteEntry(v, bank, c); // in the trash
    v = setGroup(v, gh, "Work", c);

    const sub = buildSubsetVault(v, [gh, bank, gone, back], { now: () => NOW });
    expect(sub.entries.map((e) => e.issuer).sort()).toEqual(["Back", "GitHub"]);
    const plain = text(sub);
    for (const x of [
      "AWS",
      "JBSWY3DPEHPK3PXP",
      "Bank",
      "KRSXG5CTMVRXEZLU",
      "Private",
      "Old",
      "aws.example",
      "bank.example",
      v.vaultId,
      gh,
      aws,
      bank,
      gone,
      back,
      "srcdeva",
      "srcdevb",
      "1700000000000",
      "1700000100000",
    ])
      expect(plain).not.toContain(x);
    expect(sub.entries.find((e) => e.issuer === "GitHub")).toMatchObject({
      group: "Work",
      domains: ["github.example"],
      label: "github@example.com",
    });
    expect(sub.entries.find((e) => e.issuer === "Back")).toMatchObject({ label: "edited after the delete" });
    expect(selectedEntries(v, [gh, bank, gone, back]).map((e) => e.issuer)).toEqual(["GitHub", "Back"]);
  });

  it("a duplicate of a selected account that is not selected stays out (only its own name could tell them apart)", () => {
    const c = createClock("srcdeva", { now: () => 1_700_000_000_000 });
    let v = emptyVault("source-vault-0002");
    const a = addEntry(
      v,
      {
        type: "totp",
        issuer: "GitHub",
        label: "work",
        secret: "GEZDGNBVGY3TQOJQ",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      },
      c,
    );
    v = addEntry(
      a.vault,
      {
        type: "totp",
        issuer: "GitHub",
        label: "PRIVATE-COPY",
        secret: "GEZDGNBVGY3TQOJQ",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        group: "Secret group",
      },
      c,
    ).vault;
    const sub = buildSubsetVault(v, [a.entry.id], { now: () => NOW });
    expect(sub.entries).toHaveLength(1);
    expect(text(sub)).not.toContain("PRIVATE-COPY");
    expect(text(sub)).not.toContain("Secret group");
  });
});

function specArbSample(): Spec {
  return {
    state: "alive",
    type: "totp",
    counter: 0,
    totpCounter: false,
    group: 0,
    domains: true,
    created: 1_600_000_000_000,
    wall: 1_650_000_000_000,
    dev: 0,
    alg: "SHA1",
    digits: 6,
    period: 30,
  };
}

describe("what the page showed is what is saved (sameAsShown, C6-REVIEW C6-2)", () => {
  const c = createClock("srcdeva", { now: () => 1_700_000_000_000 });
  const base = () => {
    let v = emptyVault("source-vault-0011");
    v = addEntry(
      v,
      {
        type: "totp",
        issuer: "GitHub",
        label: "alice",
        secret: "GEZDGNBVGY3TQOJQ",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        group: "Shared",
        domains: ["github.com"],
      },
      c,
      { id: "entry-gh-0001" },
    ).vault;
    v = addEntry(
      v,
      {
        type: "totp",
        issuer: "AWS",
        label: "root",
        secret: "JBSWY3DPEHPK3PXP",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      },
      c,
      { id: "entry-aws-001" },
    ).vault;
    v = addEntry(
      v,
      {
        type: "totp",
        issuer: "Other",
        label: "x",
        secret: "KRSXG5CTMVRXEZLU",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      },
      c,
      { id: "entry-oth-001" },
    ).vault;
    return v;
  };
  const ids = ["entry-gh-0001", "entry-aws-001"];
  const shown = selectedEntries(base(), ids);
  const after = (f: (v: Vault) => Vault) => selectedEntries(f(base()), ids);

  it("unchanged, reordered, or another account changed: the same", () => {
    expect(
      sameAsShown(
        shown,
        after((v) => v),
      ),
    ).toBe(true);
    expect(
      sameAsShown(
        shown,
        after((v) => moveEntry(v, "entry-aws-001", 0, c)),
      ),
    ).toBe(true);
    expect(
      sameAsShown(
        shown,
        after((v) => editEntry(v, "entry-oth-001", { issuer: "Renamed" }, c)),
      ),
    ).toBe(true);
    expect(
      sameAsShown(
        shown,
        after((v) => editEntry(v, "entry-gh-0001", { digits: 8 }, c)),
      ),
    ).toBe(true); // not shown, the account's own
  });
  it("gone, trashed, renamed, another account name, regrouped, other sites: changed", () => {
    for (const [what, f] of [
      ["trashed", (v: Vault) => deleteEntry(v, "entry-aws-001", c)],
      ["erased", (v: Vault) => purgeEntry(deleteEntry(v, "entry-aws-001", c), "entry-aws-001", c)],
      ["renamed", (v: Vault) => editEntry(v, "entry-gh-0001", { issuer: "GitHub Work" }, c)],
      ["account", (v: Vault) => editEntry(v, "entry-gh-0001", { label: "bob" }, c)],
      ["regrouped", (v: Vault) => setGroup(v, "entry-gh-0001", "Private", c)],
      ["ungrouped", (v: Vault) => setGroup(v, "entry-gh-0001", undefined, c)],
      ["grouped", (v: Vault) => setGroup(v, "entry-aws-001", "Shared", c)],
      ["sites", (v: Vault) => editEntry(v, "entry-gh-0001", { domains: ["github.com", "admin.corp.example"] }, c)],
      ["no sites", (v: Vault) => editEntry(v, "entry-gh-0001", { domains: undefined }, c)],
    ] as const)
      expect(sameAsShown(shown, after(f)), what).toBe(false);
    expect(sameAsShown(shown, [])).toBe(false);
    expect(sameAsShown(shown, selectedEntries(base(), ["entry-gh-0001", "entry-oth-001"]))).toBe(false); // same count, another account
  });
});

describe("subset backup file (createSubsetBackup)", () => {
  it("round trip: opens with its own password to exactly the selection; the raw file holds nothing of the source", async () => {
    await fc.assert(
      fc.asyncProperty(
        caseArb.filter(({ src, pick }) => expectedOf(src, pick).length > 0),
        async ({ src, pick, ids }) => {
          const { file, count } = await createSubsetBackup(src.vault, ids, FILE_PW, { now: () => NOW });
          expect(count).toBe(expectedOf(src, pick).length);
          const raw = JSON.stringify(file);
          // the standard v1 envelope, nothing added
          expect(Object.keys(file).sort()).toEqual(["app", "ciphertext", "created", "format", "iv", "kdf", "v"]);
          expect(file).toMatchObject({ format: "sixkey-backup", v: 1, created: NOW, app: "sixkey" });
          src.specs.forEach((_, i) => {
            const k = tok(src, i);
            for (const x of [k.id, k.issuer, k.label, k.secret, k.domain, k.order]) expect(raw).not.toContain(x); // the selected ones too: it is encrypted
          });
          for (const x of [src.vault.vaultId, ...src.groups, ...SRC_DEVICES]) expect(raw).not.toContain(x);
          const { vault, created } = await openBackup(JSON.parse(raw), FILE_PW);
          expect(created).toBe(NOW);
          checkSubset(src, pick, vault);
        },
      ),
      { numRuns: 10 },
    );
  }, 120_000);

  it("a wrong password and any tampering fail the same way (property)", async () => {
    const src = makeSource("QWERTY", [specArbSample(), { ...specArbSample(), state: "trash" }]);
    const { file } = await createSubsetBackup(src.vault, src.ids, FILE_PW, { now: () => NOW });
    expect((await openBackup(file, FILE_PW)).vault.entries).toHaveLength(1);
    const flip = (b64: string, at: number, bit: number) => {
      const b = fromB64(b64);
      b[at % b.length]! ^= 1 << bit;
      return toB64(b);
    };
    const tamper = fc.oneof(
      fc
        .record({ at: fc.nat(), bit: fc.integer({ min: 0, max: 7 }) })
        .map(({ at, bit }) => ({ ...file, ciphertext: flip(file.ciphertext, at, bit) })),
      fc
        .record({ at: fc.nat(), bit: fc.integer({ min: 0, max: 7 }) })
        .map(({ at, bit }) => ({ ...file, iv: flip(file.iv, at, bit) })),
      fc
        .record({ at: fc.nat(), bit: fc.integer({ min: 0, max: 7 }) })
        .map(({ at, bit }) => ({ ...file, kdf: { ...file.kdf, salt: flip(file.kdf.salt, at, bit) } })),
      fc
        .integer({ min: -1000, max: 1000 })
        .filter((d) => d !== 0)
        .map((d) => ({ ...file, created: file.created + d })),
    );
    await fc.assert(
      fc.asyncProperty(tamper, async (bad) => {
        await expect(openBackup(bad, FILE_PW)).rejects.toMatchObject({ code: "wrong_password_or_damaged" });
      }),
      { numRuns: 6 },
    );
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1, maxLength: 40 })
          .filter((p) => p.normalize("NFKC") !== FILE_PW && p.normalize("NFKC").length > 0),
        async (pw) => {
          await expect(openBackup(file, pw)).rejects.toMatchObject({ code: "wrong_password_or_damaged" });
        },
      ),
      { numRuns: 5 },
    );
    await expect(openBackup(file, STRONG)).rejects.toMatchObject({ code: "wrong_password_or_damaged" }); // the master password opens nothing here
  });

  it("refuses a weak file password and an empty selection, as a full backup does", async () => {
    const src = makeSource("ZXCVBN", [specArbSample()]);
    await expect(createSubsetBackup(src.vault, src.ids, "short")).rejects.toBeInstanceOf(BackupError);
    await expect(createSubsetBackup(src.vault, ["nothing-like-it"], FILE_PW)).rejects.toThrow(RangeError);
    await expect(createSubsetBackup(src.vault, [], FILE_PW)).rejects.toThrow(RangeError);
  });

  it("is the same format as a full backup: a full backup's reader opens it and a full backup of the subset matches it", async () => {
    const src = makeSource("POIUYT", [specArbSample(), { ...specArbSample(), group: 1 }]);
    const sub = buildSubsetVault(src.vault, src.ids, { now: () => NOW });
    const full = await openBackup(await createBackup(sub, FILE_PW, { now: () => NOW }), FILE_PW);
    expect(full.vault).toEqual(sub);
  });
});

describe("a subset file through the service", () => {
  function world() {
    const kv = new MemoryKV();
    const t = { now: 1_750_000_000_000 };
    const svc = new VaultService({
      store: new VaultStore({ kv, lock: createMutex(), now: () => t.now }),
      session: new MemorySession(),
      settings: new KvSettingsStore(kv),
      now: () => t.now,
    });
    return { kv, svc, t };
  }
  const acct = (issuer: string, label: string, secret: string, group?: string) => ({
    type: "totp" as const,
    issuer,
    label,
    secret,
    algorithm: "SHA1" as const,
    digits: 6 as const,
    period: 30,
    ...(group ? { group } : {}),
  });
  const names = (v: Vault) =>
    aliveEntries(v)
      .map((e) => `${e.issuer}/${e.label}`)
      .sort();

  async function source() {
    const w = world();
    await createProtected(w.svc);
    await w.svc.mutate((v, c) => {
      let x = addEntry(v, acct("GitHub", "alice", "GEZDGNBVGY3TQOJQ", "Shared"), c).vault;
      x = addEntry(x, acct("AWS", "root", "JBSWY3DPEHPK3PXP", "Shared"), c).vault;
      x = addEntry(x, acct("Bank", "me", "KRSXG5CTMVRXEZLU", "Private"), c).vault;
      return x;
    });
    const vault = (await w.svc.read()).vault;
    const id = (issuer: string) => vault.entries.find((e) => e.issuer === issuer)!.id;
    return { ...w, vault, id };
  }

  it("restores a fresh profile (keys prepared for the file's vault id, as the first-run wizard does) to exactly the selection", async () => {
    const s = await source();
    const { file } = await createSubsetBackup(s.vault, [s.id("GitHub"), s.id("AWS")], FILE_PW);
    const { vault: opened } = await openBackup(JSON.parse(JSON.stringify(file)), FILE_PW);
    expect(opened.vaultId).not.toBe(s.vault.vaultId);

    const fresh = world();
    // keys for the source's vault id do not fit the file: it is another vault
    await expect(
      fresh.svc.restoreBackup(opened, await fresh.svc.prepareKeys(STRONG, { vaultId: s.vault.vaultId })),
    ).rejects.toMatchObject({ code: "bad_state" });
    await fresh.svc.restoreBackup(opened, await fresh.svc.prepareKeys(STRONG, { vaultId: opened.vaultId }));
    const got = (await fresh.svc.read()).vault;
    expect(got.vaultId).toBe(opened.vaultId);
    expect(names(got)).toEqual(["AWS/root", "GitHub/alice"]);
    expect(got.entries).toHaveLength(2); // no tombstones, no trash: nothing else came along
    expect(JSON.stringify([...fresh.kv.data.entries()])).not.toContain("KRSXG5CTMVRXEZLU");
  });

  it("imports into an existing vault as new accounts, and an updated export adds only what is new (a renamed account comes in again)", async () => {
    const s = await source();
    const other = world();
    await createProtected(other.svc);
    await other.svc.mutate((v, c) => addEntry(v, acct("Mail", "x", "MFRGGZDFMZTWQ2LK"), c).vault);

    const first = await openBackup(
      JSON.parse(JSON.stringify((await createSubsetBackup(s.vault, [s.id("GitHub"), s.id("AWS")], FILE_PW)).file)),
      FILE_PW,
    );
    expect(await other.svc.importBackup(first.vault)).toEqual({ mode: "added", added: 2 });
    expect(names((await other.svc.read()).vault)).toEqual(["AWS/root", "GitHub/alice", "Mail/x"]);

    // later: AWS renamed at the source, Bank added to the selection
    s.t.now += 60_000;
    await s.svc.mutate((v, c) => editEntry(v, s.id("AWS"), { label: "root-renamed" }, c));
    const later = (await s.svc.read()).vault;
    const second = await openBackup(
      (await createSubsetBackup(later, [s.id("GitHub"), s.id("AWS"), s.id("Bank")], FILE_PW)).file,
      FILE_PW,
    );
    expect(second.vault.vaultId).not.toBe(first.vault.vaultId);
    expect(await other.svc.importBackup(second.vault)).toEqual({ mode: "added", added: 2 });
    // GitHub not twice; the renamed AWS as a second entry (H-d: the user deletes the old one)
    expect(names((await other.svc.read()).vault)).toEqual([
      "AWS/root",
      "AWS/root-renamed",
      "Bank/me",
      "GitHub/alice",
      "Mail/x",
    ]);

    // and back into the source vault itself: everything is already there
    expect(await s.svc.importBackup(second.vault)).toEqual({ mode: "added", added: 0 });
  });

  it("a profile restored from one file merges a re-import of that same file without duplicates", async () => {
    const s = await source();
    const opened = await openBackup((await createSubsetBackup(s.vault, [s.id("Bank")], FILE_PW)).file, FILE_PW);
    const fresh = world();
    await fresh.svc.restoreBackup(opened.vault, await fresh.svc.prepareKeys(STRONG, { vaultId: opened.vault.vaultId }));
    expect(await fresh.svc.importBackup(opened.vault)).toMatchObject({ mode: "merged", added: 0 });
    expect(names((await fresh.svc.read()).vault)).toEqual(["Bank/me"]);
  });
});
