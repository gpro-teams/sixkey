// "Export selected accounts" (PHASE0X-PLAN C6, SYNC-DESIGN H2): an adversarial fuzz of the subset file, adopted from
// the review (docs/audit/internal-reviews/C6-REVIEW.md, C6-3). Where backup-subset.test.ts uses tidy generated vaults, these are
// made by the real edit operations from three devices (add, edit, group, move, delete, restore, erase, an edit on another
// device after a delete, merged back), with duplicates that share a selected account's name and key, and names full of
// characters that stress escaping. The rule is stated on the output alone: every string and number in the subset is
// either content of a selected live account or a fresh value, and nothing tagged as belonging to an unselected or dead
// entry is in the decrypted text, raw or JSON-escaped.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bs, fromB64, utf8 } from "../../src/core/crypto/bytes";
import { deriveKekFromPassword } from "../../src/core/crypto/kdf";
import { openBackup, type BackupFile } from "../../src/core/backup/backup";
import { buildSubsetVault, createSubsetBackup } from "../../src/core/backup/subset";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession } from "../../src/core/service/types";
import { encodeBase32 } from "../../src/core/totp/base32";
import { createClock, parseHlc, type Clock } from "../../src/core/vault/hlc";
import { aliveEntries, emptyVault, isAlive, isPurged, type Entry, type Vault } from "../../src/core/vault/model";
import {
  addEntry,
  deleteEntry,
  editEntry,
  moveEntry,
  purgeEntry,
  restoreEntry,
  setGroup,
} from "../../src/core/vault/ops";
import { mergeVaults } from "../../src/core/vault/merge";
import { deserializeVault, serializeVault } from "../../src/core/vault/validate";
import { createProtected } from "../helpers/vaults";

const NOW = 1_900_000_000_000;
const FILE_PW = "a file password 9 for the shared profile";
const DEVICES = ["revdeva1", "revdevb2", "revdevc3"];
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

// Names that stress escaping: quotes, backslashes, control characters, RTL, zero width, combining marks, emoji, CJK.
const TRICKY = [
  '"',
  "\\",
  "\u0001",
  "\u202e",
  "\u200b",
  "é",
  "\u{1F510}",
  "中文",
  "</script>",
  "\n",
  "\t",
  'a"b\\c',
  "",
];

type Op =
  | {
      k: "add";
      issuer: number;
      label: number;
      tag: boolean;
      group: number | null;
      domains: boolean;
      hotp: boolean;
      counter: number;
      dupOf: number | null;
    }
  | { k: "edit"; at: number; label: number }
  | { k: "group"; at: number; group: number | null }
  | { k: "move"; at: number; to: number }
  | { k: "del"; at: number }
  | { k: "restore"; at: number }
  | { k: "purge"; at: number }
  | { k: "forkEdit"; at: number }; // another device edits it on a copy taken now; merged back later

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      k: fc.constant("add" as const),
      issuer: fc.nat(TRICKY.length + 3),
      label: fc.nat(TRICKY.length + 3),
      tag: fc.boolean(),
      group: fc.option(fc.nat(4), { nil: null }),
      domains: fc.boolean(),
      hotp: fc.boolean(),
      counter: fc.nat(500),
      dupOf: fc.option(fc.nat(30), { nil: null }),
    }),
  },
  fc.record({ k: fc.constant("edit" as const), at: fc.nat(40), label: fc.nat(TRICKY.length + 3) }),
  fc.record({ k: fc.constant("group" as const), at: fc.nat(40), group: fc.option(fc.nat(4), { nil: null }) }),
  fc.record({ k: fc.constant("move" as const), at: fc.nat(40), to: fc.nat(40) }),
  fc.record({ k: fc.constant("del" as const), at: fc.nat(40) }),
  fc.record({ k: fc.constant("restore" as const), at: fc.nat(40) }),
  fc.record({ k: fc.constant("purge" as const), at: fc.nat(40) }),
  fc.record({ k: fc.constant("forkEdit" as const), at: fc.nat(40) }),
);

type Built = { vault: Vault; tags: Map<string, string[]>; groups: string[]; salt: string };

let serial = 0;
function build(ops: Op[], salt: string): Built {
  const clocks: Clock[] = DEVICES.map((d, i) =>
    createClock(d, { now: () => 1_700_000_000_000 + i * 7 + serial++ * 1000 }),
  );
  let v = emptyVault(`srcvault${salt}`);
  const fork: Vault[] = [];
  const tags = new Map<string, string[]>(); // entry id -> unique tagged strings it ever carried
  const groups = [0, 1, 2, 3, 4].map((g) => (g === 4 ? TRICKY[g]! + `G${salt}` : `GRP${g}${salt}\u202e"`));
  const name = (i: number, kind: string, idx: number) =>
    i < TRICKY.length ? TRICKY[i]! : `${kind}${idx}T${salt}\u200b\\"`;
  let n = 0;
  for (const op of ops) {
    const c = clocks[n % clocks.length]!;
    const ids = v.entries.map((e) => e.id);
    const pick = (at: number) => ids[at % Math.max(1, ids.length)];
    try {
      if (op.k === "add") {
        const idx = n++;
        const src = op.dupOf !== null && ids.length ? v.entries[op.dupOf % ids.length] : undefined;
        const issuer = src && src.secret ? src.issuer : name(op.issuer, "ISS", idx);
        const label = name(op.label, "LBL", idx);
        const secret = src && src.secret ? src.secret : encodeBase32(utf8(`S${idx}${salt}`));
        const own = [
          `ISS${idx}T${salt}`,
          `LBL${idx}T${salt}`,
          `dom${idx}x${salt.toLowerCase()}.example`,
          encodeBase32(utf8(`S${idx}${salt}`)),
        ];
        const r = addEntry(
          v,
          {
            type: op.hotp ? "hotp" : "totp",
            issuer,
            label,
            secret,
            algorithm: "SHA1",
            digits: 6,
            period: 30,
            ...(op.hotp ? { counter: op.counter } : {}),
            ...(op.group !== null ? { group: groups[op.group]! } : {}),
            ...(op.domains ? { domains: [`dom${idx}x${salt.toLowerCase()}.example`] } : {}),
          },
          c,
          { now: () => 1_600_000_000_000 + idx },
        );
        v = r.vault;
        tags.set(
          r.entry.id,
          own.filter((t) => [issuer, label, secret, ...(r.entry.domains ?? [])].some((x) => x.includes(t))),
        );
      } else if (op.k === "edit") {
        const id = pick(op.at);
        if (id) {
          const l = name(op.label, "EDL", n++);
          v = editEntry(v, id, { label: l }, c);
          if (l.includes("T" + salt)) tags.get(id)!.push(`EDL${n - 1}T${salt}`);
        }
      } else if (op.k === "group") {
        const id = pick(op.at);
        if (id) v = setGroup(v, id, op.group === null ? undefined : groups[op.group], c);
      } else if (op.k === "move") {
        const id = pick(op.at);
        if (id && isAlive(v.entries.find((e) => e.id === id)!)) v = moveEntry(v, id, op.to, c);
      } else if (op.k === "del") {
        const id = pick(op.at);
        if (id) v = deleteEntry(v, id, c);
      } else if (op.k === "restore") {
        const id = pick(op.at);
        if (id) v = restoreEntry(v, id, c);
      } else if (op.k === "purge") {
        const id = pick(op.at);
        if (id) v = purgeEntry(deleteEntry(v, id, c), id, c);
      } else if (op.k === "forkEdit") {
        const id = pick(op.at);
        const e0 = id ? v.entries.find((e) => e.id === id)! : undefined;
        // another device that has not seen the delete edits the account later: once merged, it is alive again
        if (e0 && e0.secret !== "") {
          const copy = { ...v, entries: v.entries.map((e) => (e.id === id ? { ...e, deleted: false } : e)) };
          fork.push(editEntry(copy, id!, { label: `FORK${n}T${salt}` }, clocks[(n + 1) % clocks.length]!));
          tags.get(id!)!.push(`FORK${n}T${salt}`);
          n++;
        }
      }
    } catch {
      /* an op that does not apply (erased entry, etc.) */
    }
  }
  for (const f of fork) v = mergeVaults(v, f); // edits after a delete bring entries back
  // odd states a crafted or older file may hold: deleted with no dhlc (alive), purged with a group of its own
  v = {
    ...v,
    entries: v.entries.map((e, i) => {
      if (e.secret === "" && i % 2 === 0) {
        const g = `PURGEDGRP${i}T${salt}`;
        tags.set(e.id, [...(tags.get(e.id) ?? []), g]);
        return { ...e, group: g };
      }
      if (e.secret !== "" && !e.deleted && i % 5 === 3) {
        const { dhlc: _d, ...rest } = e;
        return { ...rest, deleted: true };
      } // deleted, no dhlc: alive
      return e;
    }),
  };
  v = deserializeVault(serializeVault(v));
  return { vault: v, tags, groups, salt };
}

const contentKey = (e: Entry) =>
  JSON.stringify([
    e.type,
    e.issuer,
    e.label,
    e.secret,
    e.algorithm,
    e.digits,
    e.period,
    e.type === "hotp" ? (e.counter ?? 0) : null,
    e.group || null,
    e.domains && e.domains.length ? e.domains : null,
  ]);

function leaves(x: unknown, out: { s: string[]; n: number[]; k: string[] } = { s: [], n: [], k: [] }) {
  if (typeof x === "string") out.s.push(x);
  else if (typeof x === "number") out.n.push(x);
  else if (Array.isArray(x)) x.forEach((y) => leaves(y, out));
  else if (x && typeof x === "object")
    for (const [k, y] of Object.entries(x)) {
      out.k.push(k);
      leaves(y, out);
    }
  return out;
}

async function decryptRaw(file: BackupFile, pw: string): Promise<string> {
  const key = await deriveKekFromPassword(pw, file.kdf);
  const aad = utf8(`sixkey-backup|1|${file.created}|PBKDF2-SHA256:${file.kdf.iterations}:${file.kdf.salt}`);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bs(fromB64(file.iv)), additionalData: bs(aad), tagLength: 128 },
    key,
    bs(fromB64(file.ciphertext)),
  );
  return new TextDecoder().decode(plain);
}

/** The whole rule, stated on the output only: every leaf is either content of a selected live account or fresh. */
function checkOutput(b: Built, ids: string[], sub: Vault, plain: string) {
  const src = b.vault;
  const want = aliveEntries(src).filter((e) => ids.includes(e.id));
  expect(sub.entries).toHaveLength(want.length);
  expect(sub.entries.map(contentKey).sort()).toEqual(want.map(contentKey).sort());
  expect(Object.keys(sub).sort()).toEqual(["entries", "schemaVersion", "vaultId"]);
  for (const e of sub.entries) for (const k of Object.keys(e)) expect(ENTRY_KEYS.has(k), k).toBe(true);

  const allowedS = new Set<string>([sub.vaultId]);
  const allowedN = new Set<number>([1, NOW]);
  for (const e of want) {
    for (const s of [
      e.type,
      e.issuer,
      e.label,
      e.secret,
      e.algorithm,
      ...(e.group ? [e.group] : []),
      ...(e.domains ?? []),
    ])
      allowedS.add(s);
    for (const x of [e.digits, e.period, ...(e.type === "hotp" ? [e.counter ?? 0] : [])]) allowedN.add(x);
  }
  const fresh = new Set<string>();
  for (const e of sub.entries) {
    fresh.add(e.id);
    fresh.add(e.order);
    fresh.add(e.hlc);
    fresh.add(e.phlc);
  }
  const L = leaves(sub);
  for (const s of L.s) expect(allowedS.has(s) || fresh.has(s), `string leaf ${JSON.stringify(s)}`).toBe(true);
  for (const x of L.n) expect(allowedN.has(x), `number leaf ${x}`).toBe(true);
  // the fresh values are fresh
  const srcIds = new Set(src.entries.map((e) => e.id));
  const srcStamps = new Set(src.entries.flatMap((e) => [e.hlc, e.phlc, e.dhlc ?? ""]));
  const devs = new Set<string>();
  for (const e of sub.entries) {
    expect(srcIds.has(e.id)).toBe(false);
    for (const h of [e.hlc, e.phlc]) {
      expect(srcStamps.has(h)).toBe(false);
      const p = parseHlc(h)!;
      expect(p.wall).toBe(NOW);
      devs.add(p.device);
    }
    expect(e.createdAt).toBe(NOW);
  }
  expect(devs.size).toBeLessThanOrEqual(1);
  for (const d of devs) expect(DEVICES).not.toContain(d);
  expect(sub.vaultId).not.toBe(src.vaultId);
  // raw decrypted text: nothing tagged of an unselected or dead entry, raw or JSON-escaped; no source id, stamp, device
  const wantIds = new Set(want.map((e) => e.id));
  const keptText = [...allowedS]; // a tag of an unselected entry may also be content of a selected duplicate
  for (const e of src.entries) {
    if (!wantIds.has(e.id))
      for (const t of b.tags.get(e.id) ?? [])
        if (!keptText.some((k) => k.includes(t))) {
          expect(plain, `tag ${t}`).not.toContain(t);
          expect(plain).not.toContain(JSON.stringify(t).slice(1, -1));
        }
    expect(plain).not.toContain(e.id);
    for (const h of [e.hlc, e.phlc, e.dhlc]) if (h) expect(plain).not.toContain(h);
  }
  for (const d of DEVICES) expect(plain).not.toContain(d);
  expect(plain).not.toContain(src.vaultId);
  const keptGroups = new Set(want.map((e) => e.group).filter(Boolean));
  for (const g of b.groups)
    if (!keptGroups.has(g)) {
      expect(L.s).not.toContain(g);
      expect(plain).not.toContain(JSON.stringify(g).slice(1, -1));
    }
}

const caseArb = fc
  .record({
    ops: fc.array(opArb, { minLength: 1, maxLength: 70, size: "large" }),
    salt: fc.integer({ min: 36 ** 4, max: 36 ** 5 - 1 }).map((x) => x.toString(36).toUpperCase()),
    sel: fc.array(fc.nat(60), { maxLength: 30 }),
    ghost: fc.boolean(),
    byGroup: fc.option(fc.nat(4), { nil: null }),
  })
  .map(({ ops, salt, sel, ghost, byGroup }) => {
    const b = build(ops, salt);
    const all = b.vault.entries.map((e) => e.id);
    const ids = sel.map((i) => all[i % Math.max(1, all.length)]).filter((x): x is string => !!x);
    // selection by group, as a buggy picker might make it: every entry with that group name, trash and tombstones too
    if (byGroup !== null) ids.push(...b.vault.entries.filter((e) => e.group === b.groups[byGroup]).map((e) => e.id));
    if (ghost) ids.push("ghost-id-not-in-vault", b.vault.vaultId);
    return { b, ids };
  });

describe("subset privacy against vaults made by real edits (adversarial fuzz)", () => {
  it("random vaults made by real ops (trash, purge, resurrect, duplicates, tricky unicode): only selected live content, all else fresh", () => {
    fc.assert(
      fc.property(caseArb, ({ b, ids }) => {
        const want = aliveEntries(b.vault).filter((e) => ids.includes(e.id));
        if (want.length === 0) {
          expect(() => buildSubsetVault(b.vault, ids, { now: () => NOW })).toThrow(RangeError);
          return;
        }
        const sub = buildSubsetVault(b.vault, ids, { now: () => NOW });
        checkOutput(b, ids, sub, new TextDecoder().decode(serializeVault(sub)));
      }),
      { numRuns: 600 },
    );
  });

  it("the encrypted file: raw decrypted bytes obey the same rule; the envelope holds nothing else", async () => {
    await fc.assert(
      fc.asyncProperty(
        caseArb.filter(({ b, ids }) => aliveEntries(b.vault).some((e) => ids.includes(e.id))),
        async ({ b, ids }) => {
          const { file } = await createSubsetBackup(b.vault, ids, FILE_PW, { now: () => NOW });
          const raw = JSON.stringify(file);
          expect(Object.keys(file).sort()).toEqual(["app", "ciphertext", "created", "format", "iv", "kdf", "v"]);
          expect(Object.keys(file.kdf).sort()).toEqual(["hash", "iterations", "name", "salt", "v"]);
          for (const e of b.vault.entries)
            for (const t of [...(b.tags.get(e.id) ?? []), e.id]) expect(raw).not.toContain(t);
          const plain = await decryptRaw(file, FILE_PW);
          const { vault } = await openBackup(file, FILE_PW);
          expect(new TextDecoder().decode(serializeVault(vault))).toBe(plain); // nothing in the bytes beyond the parsed vault
          checkOutput(b, ids, vault, plain);
        },
      ),
      { numRuns: 12 },
    );
  }, 180_000);

  it("n >= 200 (addEntry's own rebalance fires): stamps, counters and order keys depend only on n", () => {
    const mk = (n: number, salt: string, shuffle: boolean) => {
      const c = createClock("revdeva1", { now: () => 1_700_000_000_000 });
      let v = emptyVault(`srcvault${salt}`);
      for (let i = 0; i < n; i++)
        v = addEntry(
          v,
          {
            type: "totp",
            issuer: `I${i}${salt}`,
            label: "",
            secret: encodeBase32(utf8(`K${i}${salt}`)),
            algorithm: "SHA1",
            digits: 6,
            period: 30,
          },
          c,
        ).vault;
      if (shuffle) for (let i = 0; i < 40; i++) v = moveEntry(v, v.entries[(i * 7) % n]!.id, (i * 13) % n, c);
      return v;
    };
    const shape = (s: Vault) =>
      [...s.entries]
        .sort((a, b) => (a.order < b.order ? -1 : 1))
        .map((e) => [e.order, parseHlc(e.hlc)!.counter, parseHlc(e.phlc)!.counter].join("|"));
    const a = mk(260, "AAA", false);
    const b = mk(260, "BBB", true);
    const sa = buildSubsetVault(
      a,
      a.entries.map((e) => e.id),
      { now: () => NOW },
    );
    const sb = buildSubsetVault(
      b,
      b.entries.map((e) => e.id),
      { now: () => NOW },
    );
    expect(shape(sa)).toEqual(shape(sb));
    expect(Math.max(...sa.entries.map((e) => e.order.length))).toBeLessThan(6);
  });

  it("two files from the same vault and selection share only content, n-determined keys and the export time", () => {
    fc.assert(
      fc.property(
        caseArb.filter(({ b, ids }) => aliveEntries(b.vault).some((e) => ids.includes(e.id))),
        ({ b, ids }) => {
          const x = buildSubsetVault(b.vault, ids, { now: () => NOW });
          const y = buildSubsetVault(b.vault, ids, { now: () => NOW });
          const content = new Set(
            leaves(
              aliveEntries(b.vault).map((e) => [
                e.type,
                e.issuer,
                e.label,
                e.secret,
                e.algorithm,
                e.group ?? "",
                ...(e.domains ?? []),
              ]),
            ).s,
          );
          const ys = new Set(leaves(y).s);
          const orders = new Set(x.entries.map((e) => e.order));
          for (const s of leaves(x).s) if (ys.has(s)) expect(content.has(s) || orders.has(s), `shared ${s}`).toBe(true);
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe("importing a subset file never removes, overwrites or downgrades an account", () => {
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

  it("property: every account of the receiving vault is still there, unchanged; only new entries appear", async () => {
    await fc.assert(
      fc.asyncProperty(
        caseArb.filter(({ b, ids }) => aliveEntries(b.vault).some((e) => ids.includes(e.id))),
        fc.array(fc.nat(60), { maxLength: 8 }),
        fc.integer({ min: 0, max: 999 }),
        async ({ b, ids }, copy, bump) => {
          const w = world();
          await createProtected(w.svc);
          // the receiver holds some of the same accounts already, with a HOTP counter further on, and some renamed
          await w.svc.mutate((v, c) => {
            let x = v;
            for (const i of copy) {
              const e = aliveEntries(b.vault)[i % Math.max(1, aliveEntries(b.vault).length)];
              if (!e) continue;
              x = addEntry(
                x,
                {
                  type: e.type,
                  issuer: e.issuer,
                  label: i % 3 === 0 ? `${e.label}renamed` : e.label,
                  secret: e.secret,
                  algorithm: e.algorithm,
                  digits: e.digits,
                  period: e.period,
                  ...(e.type === "hotp" ? { counter: (e.counter ?? 0) + bump } : {}),
                },
                c,
              ).vault;
            }
            return x;
          });
          const before = (await w.svc.read()).vault;
          const { file } = await createSubsetBackup(b.vault, ids, FILE_PW, { now: () => NOW });
          const { vault: opened } = await openBackup(file, FILE_PW);
          const r = await w.svc.importBackup(opened);
          expect(r.mode).toBe("added");
          const after = (await w.svc.read()).vault;
          for (const e of before.entries) expect(after.entries.find((x) => x.id === e.id)).toEqual(e);
          expect(after.entries.length - before.entries.length).toBe(r.added);
          expect(aliveEntries(after).length - aliveEntries(before).length).toBe(r.added);
        },
      ),
      { numRuns: 15 },
    );
  }, 120_000);
});

describe("the fuzz's own generator", () => {
  it("produces the states the rule is about: trash, erased, alive again, crafted, dead and live selections, odd names", () => {
    const st = {
      trash: 0,
      purged: 0,
      resurrected: 0,
      noDhlc: 0,
      selDead: 0,
      selAlive: 0,
      tricky: 0,
      grouped: 0,
      hotp: 0,
      maxN: 0,
    };
    for (const { b, ids } of fc.sample(caseArb, 300)) {
      st.maxN = Math.max(st.maxN, b.vault.entries.length);
      for (const e of b.vault.entries) {
        if (isPurged(e)) st.purged++;
        else if (!isAlive(e)) st.trash++;
        else if (e.deleted) st.resurrected++;
        if (e.deleted && !e.dhlc) st.noDhlc++;
        if (ids.includes(e.id)) {
          if (isAlive(e)) st.selAlive++;
          else st.selDead++;
        }
        if (/["\\\u0001\u202e\u200b]/.test(e.issuer + e.label)) st.tricky++;
        if (e.group) st.grouped++;
        if (e.type === "hotp") st.hotp++;
      }
    }
    for (const [k, n] of Object.entries(st)) expect(n, k).toBeGreaterThan(k === "maxN" ? 15 : 20);
  });
});
