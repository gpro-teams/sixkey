// The backup in Chrome's sync storage, its pure core (CSB-1; src/core/cloud/slots.ts): the keys, the manifest, the
// cut and the exact measure, assembly and torn sets, the room, the empty-vault bound, the write rule in its order, the
// link, the size of real vaults, and two random models: two writers' items in any order, and device histories against
// a fake Chrome sync that carries each item on its own.
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256, toB64, utf8 } from "../../src/core/crypto/bytes";
import { encryptVault } from "../../src/core/crypto/envelope";
import { PBKDF2_PASSWORD_WRAP_ITERATIONS } from "../../src/core/crypto/kdf";
import { createKeyring, setRecovery, type Keyring } from "../../src/core/crypto/keyring";
import type { Vk } from "../../src/core/crypto/vk";
import { cloudBackupText, makeCloudBackup, type CloudBackup } from "../../src/core/cloud/format";
import { newestFirst, openCloudBackups } from "../../src/core/cloud/restore";
import {
  adoptSlot,
  assembleSlot,
  chunkKey,
  decideSlot,
  EMPTY_BELOW,
  isEmptyVault,
  itemBytes,
  leftovers,
  linkAfter,
  linkBefore,
  manifestKey,
  MAX_CHUNKS,
  MAX_MINE,
  mergedLink,
  heldLink,
  newSlotId,
  newTag,
  ownSlot,
  parseKey,
  parseManifest,
  planSlot,
  planText,
  QUOTA_BYTES,
  QUOTA_BYTES_PER_ITEM,
  AREA_MARGIN,
  ITEM_BYTES,
  ITEM_MARGIN,
  readSlots,
  room,
  ROOM_BYTES,
  slotCandidate,
  slotLocal,
  SlotError,
  wrapsOf,
  type Assembled,
  type OwnSlot,
  type SlotDecision,
  type SlotLink,
  type SlotLocal,
  type SlotManifest,
  type SlotPlan,
  type TextPlan,
  type WriteDecision,
} from "../../src/core/cloud/slots";
import type { CloudError } from "../../src/core/cloud/status";
import type { Generation } from "../../src/core/storage/format";
import { createClock } from "../../src/core/vault/hlc";
import { canonicalJson } from "../../src/core/vault/merge";
import { emptyVault, type Entry, type Vault } from "../../src/core/vault/model";
import { addEntry, purgeEntry } from "../../src/core/vault/ops";
import { deserializeVault, serializeVault } from "../../src/core/vault/validate";
import { protectedKeys, T0 } from "../helpers/cloud";
import { chromiumItemBytes } from "../helpers/fake-sync-area";

const APP = "Sixkey 0.1.0";
const SLOT = "abcd1234";
const TAG = "0123456789abcdef";
const H = "A".repeat(43) + "=";
type Area = Record<string, unknown>;
type Ok = Extract<Assembled, { kind: "ok" }>;

/** planText's cut of a text, which must fit. */
const plan = async (text: string, slot = SLOT, g = TAG, t = T0): Promise<TextPlan> => {
  const p = await planText(text, slot, g, t);
  if (p.kind !== "plan") throw new Error(`too large: ${p.bytes}`);
  return p;
};
const pieces = (p: TextPlan): string[] =>
  Array.from({ length: p.manifest.n }, (_, i) => p.items[chunkKey(p.slot, i)] as string);
/** An item's bytes as Chromium counts them: the tests' own measure (the fake area's, which the browser probe pins). */
const chromeBytes = chromiumItemBytes;
const hashOf = async (text: string) => toB64(await sha256(utf8(text)));
const thrown = async (p: Promise<unknown>) => {
  try {
    await p;
    return "planned";
  } catch (e) {
    return e instanceof SlotError ? e.code : `other: ${String(e)}`;
  }
};

// ---- vaults and files ---------------------------------------------------------------------------------------------

type QuickKeys = { keyring: Keyring; vk: Vk; recoveryCode: string };
/** A keyring with the recovery wrap alone (no PBKDF2): what "只用恢复密钥打开" uploads. */
async function quickKeys(vaultId?: string): Promise<QuickKeys> {
  const { keyring, vk } = await createKeyring(vaultId ? { vaultId } : {});
  const r = await setRecovery(keyring, vk);
  const { deviceKey: _drop, ...rest } = r.keyring;
  return {
    keyring: { ...rest, wraps: rest.wraps.filter((w) => w.method !== "device") },
    vk,
    recoveryCode: r.recoveryCode,
  };
}

const ISSUERS = [
  "GitHub",
  "Google",
  "Microsoft",
  "Amazon Web Services",
  "Dropbox",
  "Cloudflare",
  "1Password",
  "Binance",
];
/** n typical accounts (the size model's: a 32-character secret, an e-mail label, one site), added by addEntry. */
function typicalVault(vaultId: string, n: number): Vault {
  const clock = createClock("k3x9q2ab", { now: () => T0 });
  let v = emptyVault(vaultId);
  for (let i = 0; i < n; i++) {
    const issuer = ISSUERS[i % ISSUERS.length]!;
    v = addEntry(
      v,
      {
        type: "totp",
        issuer,
        label: "alice.smith@example.com",
        secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        domains: [`${issuer.toLowerCase().replace(/\s+/g, "")}.com`],
      },
      clock,
      { now: () => T0 },
    ).vault;
  }
  return v;
}

async function generation(
  keys: { keyring: Keyring; vk: Vk },
  vault: Vault,
  seq: number,
  savedAt = T0,
): Promise<Generation> {
  const envelope = await encryptVault(serializeVault(vault), keys.vk, { vaultId: keys.keyring.vaultId, rev: seq });
  return { v: 1, seq, savedAt, envelope, keyring: keys.keyring };
}

let rk: QuickKeys; // vault 1, recovery wrap only
let rk2: QuickKeys; // vault 2
let fileA: CloudBackup; // vault 1, 20 accounts, seq 10
let fileB: CloudBackup; // vault 1, 20 accounts, seq 11: the same length as fileA, other bytes
let fileC: CloudBackup; // vault 1, 45 accounts, seq 12: longer, more chunks
let fileO: CloudBackup; // vault 1, 20 accounts, seq 13: the copy before two writers
let fileOther: CloudBackup; // vault 2, 3 accounts

beforeAll(async () => {
  rk = await quickKeys();
  rk2 = await quickKeys();
  const v20 = typicalVault(rk.keyring.vaultId, 20);
  fileA = await makeCloudBackup(await generation(rk, v20, 10, T0 + 10), "recovery", APP);
  fileB = await makeCloudBackup(await generation(rk, v20, 11, T0 + 11), "recovery", APP);
  fileC = await makeCloudBackup(
    await generation(rk, typicalVault(rk.keyring.vaultId, 45), 12, T0 + 12),
    "recovery",
    APP,
  );
  fileO = await makeCloudBackup(await generation(rk, v20, 13, T0 + 13), "recovery", APP);
  fileOther = await makeCloudBackup(
    await generation(rk2, typicalVault(rk2.keyring.vaultId, 3), 4, T0 + 4),
    "recovery",
    APP,
  );
});

// ---- the keys -------------------------------------------------------------------------------------------------------

describe("the keys", () => {
  it("are bk1.<slot> for the manifest and bk1.<slot>.<i> for chunk i: 12, 14 and 15 characters", () => {
    expect(manifestKey(SLOT)).toBe("bk1.abcd1234");
    expect(chunkKey(SLOT, 0)).toBe("bk1.abcd1234.0");
    expect(chunkKey(SLOT, 12)).toBe("bk1.abcd1234.12");
    expect([manifestKey(SLOT).length, chunkKey(SLOT, 9).length, chunkKey(SLOT, 10).length]).toEqual([12, 14, 15]);
  });

  it("are read back exactly, chunks 0 to 12 in plain decimal, nothing else", () => {
    expect(parseKey("bk1.abcd1234")).toEqual({ slot: SLOT, chunk: null });
    for (let i = 0; i < MAX_CHUNKS; i++) expect(parseKey(`bk1.abcd1234.${i}`)).toEqual({ slot: SLOT, chunk: i });
    for (const k of [
      "bk1.abcd1234.13", // past the last chunk
      "bk1.abcd1234.01", // a leading zero
      "bk1.abcd1234.-1",
      "bk1.abcd1234.",
      "bk1.abcd1234.1.0",
      "bk1.ABCD1234", // upper case
      "bk1.abcd123", // seven characters
      "bk1.abcd12345", // nine
      "bk1.abcd_234",
      "bk2.abcd1234", // a later format's
      "bk1abcd1234",
      " bk1.abcd1234",
      "bk1.abcd1234 ",
      "sk_csb_cfg",
      "",
    ])
      expect(parseKey(k), k).toBeNull();
  });

  it("a new slot id is 8 of [a-z0-9], never one taken, and unbiased (bytes from 252 up are drawn again)", () => {
    for (let i = 0; i < 200; i++) expect(newSlotId(new Set())).toMatch(/^[a-z0-9]{8}$/);
    // scripted bytes: 252 to 255 are skipped; 0 is "a", 35 is "9", 36 is "a" again
    const script = (bytes: number[]) => {
      let at = 0;
      return (n: number) => Uint8Array.from({ length: n }, () => bytes[at++ % bytes.length]!);
    };
    expect(newSlotId(new Set(), script([252, 0, 253, 35, 254, 36, 255, 1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe("a9abcdef");
    // the first id drawn is taken: drawn again
    const taken = new Set(["aaaaaaaa"]);
    expect(newSlotId(taken, script([...Array(16).fill(0), ...Array(16).fill(1)]))).toBe("bbbbbbbb");
  });

  it("a new tag is 64 random bits in hex", () => {
    const tags = new Set(Array.from({ length: 100 }, () => newTag()));
    expect(tags.size).toBe(100);
    for (const t of tags) expect(t).toMatch(/^[0-9a-f]{16}$/);
    expect(newTag(() => Uint8Array.from([0, 1, 2, 0xab, 0xcd, 0xef, 0x10, 0xff]))).toBe("000102abcdef10ff");
  });
});

// ---- the manifest ---------------------------------------------------------------------------------------------------

const M: SlotManifest = { v: 1, g: TAG, n: 3, z: 20_000, h: H, t: T0 };

describe("the manifest", () => {
  it("is read back as exactly its six fields", () => {
    expect(parseManifest({ ...M })).toEqual(M);
    expect(parseManifest(JSON.parse(JSON.stringify(M)))).toEqual(M);
    expect(parseManifest({ ...M, n: 1, z: 1 })).toEqual({ ...M, n: 1, z: 1 });
    // the most 13 chunks of any writer hold: the whole 8,192 B item less the key (14, or 15 from chunk 10) and quotes
    const most = 10 * 8176 + 3 * 8175;
    expect(parseManifest({ ...M, n: 13, z: most })).toEqual({ ...M, n: 13, z: most });
    expect(parseManifest({ ...M, n: 11, z: 10 * 8176 + 8175 })).toEqual({ ...M, n: 11, z: 10 * 8176 + 8175 });
    expect(parseManifest({ ...M, t: 0 })).toEqual({ ...M, t: 0 });
    // every canonical last character of a 32-byte hash (the two low bits zero)
    for (const c of "AEIMQUYcgkosw048") expect(parseManifest({ ...M, h: `${"A".repeat(42)}${c}=` })).not.toBeNull();
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["a string (the manifest's JSON text)", JSON.stringify(M)],
    ["an array", [M]],
    ["a number", 1],
    ["an empty object", {}],
    ["a field missing (g)", (({ g: _g, ...r }) => r)(M)],
    ["a field missing (t)", (({ t: _t, ...r }) => r)(M)],
    ["a field more", { ...M, d: "laptop" }],
    ["__proto__ as a field", JSON.parse(`{"__proto__":1,${JSON.stringify(M).slice(1)}`)],
    ["v 0", { ...M, v: 0 }],
    ["v as a string", { ...M, v: "1" }],
    ["v 1.5", { ...M, v: 1.5 }],
    ["g in upper case", { ...M, g: TAG.toUpperCase() }],
    ["g of 15 characters", { ...M, g: TAG.slice(1) }],
    ["g of 17 characters", { ...M, g: `${TAG}0` }],
    ["g a number", { ...M, g: 123 }],
    ["n 0", { ...M, n: 0 }],
    ["n 0 and z 0 (no chunk at all)", { ...M, n: 0, z: 0 }],
    ["n 14, past the last chunk", { ...M, n: 14, z: 14 * 8000 }],
    ["n 1.5", { ...M, n: 1.5 }],
    ["n as a string", { ...M, n: "3" }],
    ["n negative", { ...M, n: -1 }],
    ["z below n (an empty chunk)", { ...M, n: 3, z: 2 }],
    ["z past n full chunks", { ...M, n: 3, z: 3 * 8176 + 1 }],
    ["z past what 11 chunks hold (chunk 10 has a key of 15)", { ...M, n: 11, z: 11 * 8176 }],
    ["z past what 13 chunks hold", { ...M, n: 13, z: 10 * 8176 + 3 * 8175 + 1 }],
    ["z 1.5", { ...M, z: 1.5 }],
    ["h without its padding", { ...M, h: "A".repeat(43) }],
    ["h in base64url", { ...M, h: `${"-".repeat(43)}=` }],
    ["h of 45 characters", { ...M, h: `${"A".repeat(44)}=` }],
    ["h not canonical (the last character's low bits set)", { ...M, h: `${"A".repeat(42)}B=` }],
    ["h not canonical (…/=)", { ...M, h: `${"A".repeat(42)}/=` }],
    ["t negative", { ...M, t: -1 }],
    ["t as a string", { ...M, t: String(T0) }],
    ["t not finite", { ...M, t: Infinity }],
    ["t NaN", { ...M, t: NaN }],
    ["t -0 (Chromium would write a double, -0.0)", { ...M, t: -0 }],
  ])("refuses %s", (_what, x) => {
    expect(parseManifest(x)).toBeNull();
  });

  it("a later version's is 'newer', whatever its other fields: that version owns them", () => {
    expect(parseManifest({ ...M, v: 2 })).toBe("newer");
    expect(parseManifest({ v: 7, anything: true })).toBe("newer");
    expect(parseManifest({ ...M, v: 2.5 })).toBeNull();
    expect(parseManifest({ ...M, v: Infinity })).toBeNull();
  });
});

// ---- the measure ----------------------------------------------------------------------------------------------------

describe("what an item takes", () => {
  it("a chunk: its key, two quotes, its length and one more per quote", () => {
    expect(itemBytes("bk1.abcd1234.0", "abc")).toBe(14 + 2 + 3);
    expect(itemBytes("bk1.abcd1234.0", '{"a":1}')).toBe(14 + 2 + 7 + 2);
    for (const s of ["", "abc", '{"a":"b"}', " !#$%'()*+,-./09:;=?@AZ[]^_`az{|}~"])
      expect(itemBytes("bk1.abcd1234.10", s)).toBe(chromeBytes("bk1.abcd1234.10", s));
  });

  it("nothing for a string outside the alphabet: not measured, not guessed", () => {
    for (const s of ["é", "\n", "\t", "\x7f", "\x00", "<", ">", "&", "\\", String.fromCharCode(0x2028), "😀"])
      expect(itemBytes("bk1.abcd1234.0", s), JSON.stringify(s)).toBeNull();
  });

  it("a manifest: its JSON, a time past 32 bits counted as Chromium writes a double ('.0', or its exponent form)", () => {
    // JSON.stringify's length, and what Chromium writes for t in its place (measured in the browser probe)
    const as = (t: number, chromium: string) =>
      expect(itemBytes("bk1.abcd1234", { ...M, t }), String(t)).toBe(
        12 + JSON.stringify({ ...M, t }).length - String(t).length + chromium.length,
      );
    as(5, "5");
    as(2 ** 31 - 1, "2147483647");
    as(2 ** 31, "2147483648.0");
    as(999_999_999_999, "999999999999.0"); // a decimal exponent of 11: decimal
    as(1e12, "1e+12"); // 12: exponent form
    as(1e12 + 1, "1.000000000001e+12");
    as(T0, "1.9e+12");
    as(1_793_379_341_960, "1.79337934196e+12");
    as(1.5, "1.5");
    as(0.000001, "0.000001"); // a decimal exponent of -6: decimal
    as(0.0000015, "0.0000015");
    as(1e-7, "1e-7"); // -7: exponent form
    as(1e21, "1e+21");
    for (const t of [0, 7, 2 ** 31, 999_999_999_999.5, 1e12, T0, 1_793_379_341_961, 2 ** 53, 1e-6, 1e-7, 5e-324])
      expect(itemBytes("bk1.abcd1234", { ...M, t }), String(t)).toBe(chromeBytes("bk1.abcd1234", { ...M, t }));
  });

  it("nothing for anything else: an object that is not a manifest, a number, null", () => {
    for (const v of [{ ...M, x: 1 }, { ...M, v: 2 }, 5, null, true, [M]]) expect(itemBytes("k", v)).toBeNull();
  });
});

// ---- the plan -------------------------------------------------------------------------------------------------------

describe("planSlot and its cut (planText)", () => {
  it("the cut refuses a bad slot id, tag or time, an empty text and one outside the alphabet", async () => {
    expect(await thrown(planText("x", "ABCD1234", TAG, T0))).toBe("bad_slot");
    expect(await thrown(planText("x", "abcd123", TAG, T0))).toBe("bad_slot");
    expect(await thrown(planText("x", SLOT, TAG.toUpperCase(), T0))).toBe("bad_tag");
    expect(await thrown(planText("x", SLOT, TAG.slice(1), T0))).toBe("bad_tag");
    for (const t of [-1, -0, NaN, Infinity]) expect(await thrown(planText("x", SLOT, TAG, t))).toBe("bad_time");
    expect(await thrown(planText("", SLOT, TAG, T0))).toBe("bad_text");
    for (const c of ["é", "\n", "\t", "\x7f", "\x00", "<", ">", "&", "\\", "😀"])
      expect(await thrown(planText(`ab${c}cd`, SLOT, TAG, T0)), JSON.stringify(c)).toBe("bad_text");
    expect(await thrown(planText(" !\"#$%'()*+,-./09:;=?@AZ[]^_`az{|}~", SLOT, TAG, T0))).toBe("planned");
  });

  it("keeps ITEM_MARGIN (16 B) of every item: 8,176 by this measure, never Chrome's whole 8,192", () => {
    expect([QUOTA_BYTES_PER_ITEM, ITEM_MARGIN, ITEM_BYTES]).toEqual([8_192, 16, 8_176]);
  });

  it("chunk limits: 8,175 and 8,176 bytes in one item, 8,177 cut in two (16 B under Chrome's 8,191, 8,192, 8,193)", async () => {
    // bk1.abcd1234.0 (14) + the two quotes: 8,160 characters of text fill the item
    const at = async (len: number) => plan("a".repeat(len));
    const under = await at(8159);
    expect(under.manifest.n).toBe(1);
    expect(itemBytes(chunkKey(SLOT, 0), under.items[chunkKey(SLOT, 0)])).toBe(ITEM_BYTES - 1);
    const full = await at(8160);
    expect(full.manifest.n).toBe(1);
    expect(itemBytes(chunkKey(SLOT, 0), full.items[chunkKey(SLOT, 0)])).toBe(ITEM_BYTES);
    expect(chromeBytes(chunkKey(SLOT, 0), full.items[chunkKey(SLOT, 0)])).toBe(QUOTA_BYTES_PER_ITEM - ITEM_MARGIN);
    const over = await at(8161);
    expect(over.manifest.n).toBe(2);
    expect(pieces(over).map((s) => s.length)).toEqual([8160, 1]);
    expect(itemBytes(chunkKey(SLOT, 0), over.items[chunkKey(SLOT, 0)])).toBe(ITEM_BYTES);
  });

  it("an escape at the edge: a quote that would pass 8,176 goes to the next chunk", async () => {
    const p = await plan(`${"a".repeat(8159)}"b`);
    expect(pieces(p)).toEqual(["a".repeat(8159), '"b']);
    expect(itemBytes(chunkKey(SLOT, 0), pieces(p)[0])).toBe(ITEM_BYTES - 1);
    const q = await plan(`${"a".repeat(8158)}"b`); // 14 + 2 + 8,158 + 2 = 8,176: fits
    expect(pieces(q)).toEqual([`${"a".repeat(8158)}"`, "b"]);
    expect(itemBytes(chunkKey(SLOT, 0), pieces(q)[0])).toBe(ITEM_BYTES);
  });

  it("chunks 10 to 12 have one character less room (a key of 15)", async () => {
    // (thirteen full chunks would be past ROOM_BYTES: twelve full ones and a short last)
    const p = await plan("a".repeat(10 * 8160 + 2 * 8159 + 100));
    expect(p.manifest.n).toBe(13);
    expect(pieces(p).map((s) => s.length)).toEqual([...Array(10).fill(8160), 8159, 8159, 100]);
    for (let i = 0; i < 12; i++) expect(chromeBytes(chunkKey(SLOT, i), pieces(p)[i])).toBe(ITEM_BYTES);
    expect(chromeBytes(chunkKey(SLOT, 12), pieces(p)[12])).toBe(15 + 2 + 100);
  });

  it("a real file: the text, its savedAt and its generation all from the one file; items within ITEM_BYTES", async () => {
    const text = cloudBackupText(fileC);
    const p = await planSlot(fileC, SLOT, TAG);
    if (p.kind !== "plan") throw new Error("too large");
    expect(p.local).toEqual(slotLocal(fileC));
    expect(p.manifest).toEqual({
      v: 1,
      g: TAG,
      n: p.manifest.n,
      z: text.length,
      h: await hashOf(text),
      t: fileC.generation.savedAt,
    });
    // the same cut as planText's of that text and time
    const { local: _local, ...cut } = p;
    expect(cut).toEqual(await plan(text, SLOT, TAG, fileC.generation.savedAt));
    expect(p.manifest.n).toBeGreaterThan(2);
    expect(pieces(p).join("")).toBe(text);
    expect(Object.keys(p.items).sort()).toEqual(
      [manifestKey(SLOT), ...Array.from({ length: p.manifest.n }, (_, i) => chunkKey(SLOT, i))].sort(),
    );
    let sum = 0;
    for (const [k, v] of Object.entries(p.items)) {
      expect(chromeBytes(k, v)).toBeLessThanOrEqual(ITEM_BYTES);
      expect(itemBytes(k, v)).toBe(chromeBytes(k, v));
      sum += chromeBytes(k, v);
    }
    expect(p.bytes).toBe(sum);
    // every chunk but the last is full: the next character would not fit
    for (let i = 0; i < p.manifest.n - 1; i++) {
      const next =
        text[
          pieces(p)
            .slice(0, i + 1)
            .join("").length
        ]!;
      expect(chromeBytes(chunkKey(SLOT, i), pieces(p)[i]! + next)).toBeGreaterThan(ITEM_BYTES);
    }
    // and its slot assembles to that file
    expect(await assembleSlot(p.items, SLOT)).toMatchObject({ kind: "ok", backup: fileC });
  });

  it("is too large exactly past ROOM_BYTES (102,400 less AREA_MARGIN, 256), and says how large", async () => {
    expect([QUOTA_BYTES, AREA_MARGIN, ROOM_BYTES]).toEqual([102_400, 256, 102_144]);
    expect(ROOM_BYTES).toBe(QUOTA_BYTES - AREA_MARGIN);
    // (both margins are kept for browsers not measured: in Chromium 156 the measure is Chrome's to the byte, the probe)
    const base = await plan("a".repeat(100_000));
    const len = 100_000 + (ROOM_BYTES - base.bytes);
    const edge = await plan("a".repeat(len));
    expect(edge.bytes).toBe(ROOM_BYTES);
    expect(edge.manifest.n).toBe(13);
    expect(await planText("a".repeat(len + 1), SLOT, TAG, T0)).toEqual({ kind: "too_large", bytes: ROOM_BYTES + 1 });
    const huge = await planText("a".repeat(300_000), SLOT, TAG, T0);
    expect(huge.kind).toBe("too_large");
    expect(huge.bytes).toBeGreaterThan(300_000);
  });

  it("any text that fits has at most 13 chunks and every item within 8,176 (random texts, quotes included)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 110_000 }),
        fc.integer({ min: 0, max: 30 }),
        fc.integer(),
        async (len, quotePct, seed) => {
          let x = seed >>> 0;
          let text = "";
          for (let i = 0; i < len; i++) {
            x = (x * 1103515245 + 12345) >>> 0;
            text += x % 100 < quotePct ? '"' : "abcdefghij"[x % 10];
          }
          const p = await planText(text, SLOT, TAG, T0);
          if (p.kind === "too_large") {
            expect(p.bytes).toBeGreaterThan(ROOM_BYTES);
            return;
          }
          expect(p.manifest.n).toBeLessThanOrEqual(MAX_CHUNKS);
          expect(p.bytes).toBeLessThanOrEqual(ROOM_BYTES);
          expect(pieces(p).join("")).toBe(text);
          for (const [k, v] of Object.entries(p.items)) expect(chromeBytes(k, v)).toBeLessThanOrEqual(ITEM_BYTES);
          // and the manifest is one the reader takes (the length within what n chunks hold)
          expect(parseManifest(p.manifest)).toEqual(p.manifest);
        },
      ),
      { numRuns: 25 },
    );
  });

  it("leftovers: the slot's chunks past a count that are there now, nothing else", async () => {
    const area: Area = {
      [chunkKey(SLOT, 1)]: "x",
      [chunkKey(SLOT, 2)]: "x",
      [chunkKey(SLOT, 4)]: "x",
      [chunkKey(SLOT, 12)]: "x",
      "bk1.abcd1234.13": "x", // not a chunk key
      [chunkKey("zzzz9999", 3)]: "x", // another slot's
      [manifestKey(SLOT)]: M,
    };
    expect(leftovers(area, SLOT, 2)).toEqual([chunkKey(SLOT, 2), chunkKey(SLOT, 4), chunkKey(SLOT, 12)]);
    expect(leftovers(area, SLOT, 13)).toEqual([]);
    expect(leftovers(area, "zzzz9999", 1)).toEqual([chunkKey("zzzz9999", 3)]);
    expect(leftovers({}, SLOT, 1)).toEqual([]);
  });
});

// ---- the room -------------------------------------------------------------------------------------------------------

describe("room", () => {
  it("fits up to ROOM_BYTES less what is in use, to the byte", async () => {
    const p = await plan("a".repeat(30_000));
    expect(room(p, {}, 0)).toEqual({ kind: "ok" });
    expect(room(p, {}, ROOM_BYTES - p.bytes)).toEqual({ kind: "ok" });
    expect(room(p, {}, ROOM_BYTES - p.bytes + 1)).toEqual({ kind: "no_room", need: p.bytes, free: p.bytes - 1 });
  });

  it("the items it overwrites free their bytes; a shrinking slot's leftovers do not, until they are removed", async () => {
    const old = await plan("a".repeat(40_000), SLOT, "1111111111111111"); // five chunks
    const next = await plan("a".repeat(20_000), SLOT, "2222222222222222"); // three
    // what the old write keeps while the new one lands: its chunks 3 and 4
    const kept = [3, 4].reduce((a, i) => a + itemBytes(chunkKey(SLOT, i), old.items[chunkKey(SLOT, i)])!, 0);
    const others = ROOM_BYTES - kept - next.bytes; // exactly enough
    expect(others + old.bytes + next.bytes).toBeGreaterThan(ROOM_BYTES); // without the credit it would not fit
    expect(room(next, old.items, others + old.bytes)).toEqual({ kind: "ok" });
    expect(room(next, old.items, others + old.bytes + 1)).toEqual({
      kind: "no_room",
      need: next.bytes,
      free: next.bytes - 1,
    });
    // the same write as a new slot gets no credit
    const fresh = await plan("a".repeat(20_000), "zzzz9999", "2222222222222222");
    expect(room(fresh, old.items, others + old.bytes)).toEqual({
      kind: "no_room",
      need: fresh.bytes,
      free: ROOM_BYTES - others - old.bytes,
    });
  });

  it("an item it cannot measure under one of its keys frees nothing", async () => {
    const p = await plan("a".repeat(20_000));
    const area: Area = { [chunkKey(SLOT, 0)]: { not: "a chunk" }, [manifestKey(SLOT)]: { ...M, v: 2 } };
    expect(room(p, area, ROOM_BYTES - p.bytes + 1).kind).toBe("no_room");
    expect(room(p, area, ROOM_BYTES - p.bytes).kind).toBe("ok");
  });
});

// ---- reading --------------------------------------------------------------------------------------------------------

describe("assembleSlot", () => {
  let pA: TextPlan;
  let pB: TextPlan;
  let pC: TextPlan;
  beforeAll(async () => {
    pA = await plan(cloudBackupText(fileA), SLOT, "aaaaaaaaaaaaaaaa", fileA.generation.savedAt);
    pB = await plan(cloudBackupText(fileB), SLOT, "bbbbbbbbbbbbbbbb", fileB.generation.savedAt);
    pC = await plan(cloudBackupText(fileC), SLOT, "cccccccccccccccc", fileC.generation.savedAt);
  });

  it("the setup: A and B are the same length, cut at the same places, with other bytes; C is longer", () => {
    expect(pA.manifest.z).toBe(pB.manifest.z);
    expect(pieces(pA).map((s) => s.length)).toEqual(pieces(pB).map((s) => s.length));
    expect(pA.manifest.n).toBeGreaterThanOrEqual(2);
    expect(pieces(pA)[1]).not.toBe(pieces(pB)[1]);
    expect(pC.manifest.n).toBeGreaterThan(pA.manifest.n);
  });

  it("a whole slot: the text, the file parsed, its tag and time; slotCandidate is what restore.ts takes", async () => {
    const a = await assembleSlot(pA.items, SLOT);
    expect(a.kind).toBe("ok");
    const ok = a as Ok;
    expect(ok.text).toBe(cloudBackupText(fileA));
    expect(ok.backup).toEqual(fileA);
    expect(ok.manifest).toEqual(pA.manifest);
    expect(slotCandidate(SLOT, ok)).toEqual({
      id: SLOT,
      head: "aaaaaaaaaaaaaaaa",
      modified: fileA.generation.savedAt,
      backup: fileA,
    });
  });

  it("absent: nothing under the id; another slot's items are not read", async () => {
    expect(await assembleSlot({}, SLOT)).toEqual({ kind: "absent" });
    const other = await plan(cloudBackupText(fileA), "zzzz9999", TAG, fileA.generation.savedAt);
    expect(await assembleSlot(other.items, SLOT)).toEqual({ kind: "absent" });
    expect(await thrown(assembleSlot({}, "ABCD1234"))).toBe("bad_slot");
  });

  it("torn: chunks with no manifest yet", async () => {
    const { [manifestKey(SLOT)]: _m, ...chunks } = pA.items;
    expect(await assembleSlot(chunks, SLOT)).toEqual({ kind: "partial", manifest: null, why: "manifest" });
    expect(await assembleSlot({ [chunkKey(SLOT, 12)]: "x" }, SLOT)).toEqual({
      kind: "partial",
      manifest: null,
      why: "manifest",
    });
  });

  it("torn: a chunk missing (the first, a middle one, the last)", async () => {
    for (const i of [0, 1, pC.manifest.n - 1]) {
      const { [chunkKey(SLOT, i)]: _gone, ...rest } = pC.items;
      expect(await assembleSlot(rest, SLOT), `chunk ${i}`).toEqual({
        kind: "partial",
        manifest: pC.manifest,
        why: "chunk",
      });
    }
  });

  it("torn: a wrong length (a chunk of the longer write under the shorter one's manifest, or cut short)", async () => {
    const mixed = {
      ...pA.items,
      [chunkKey(SLOT, 0)]: pC.items[chunkKey(SLOT, 0)],
      [chunkKey(SLOT, 1)]: pC.items[chunkKey(SLOT, 1)],
    };
    // C's first two chunks are full, A's second is not: the length is not A's
    expect(await assembleSlot(mixed, SLOT)).toEqual({ kind: "partial", manifest: pA.manifest, why: "length" });
    const short = { ...pA.items, [chunkKey(SLOT, 1)]: (pA.items[chunkKey(SLOT, 1)] as string).slice(1) };
    expect(await assembleSlot(short, SLOT)).toEqual({ kind: "partial", manifest: pA.manifest, why: "length" });
  });

  it("torn: a wrong hash (one character changed, the length kept)", async () => {
    const c1 = pA.items[chunkKey(SLOT, 1)] as string;
    const flipped = { ...pA.items, [chunkKey(SLOT, 1)]: (c1[0] === "A" ? "B" : "A") + c1.slice(1) };
    expect(await assembleSlot(flipped, SLOT)).toEqual({ kind: "partial", manifest: pA.manifest, why: "hash" });
  });

  it("torn: two writes of the same length mixed, either way round, never used", async () => {
    const bManifestAChunks = { ...pA.items, [manifestKey(SLOT)]: pB.manifest };
    expect(await assembleSlot(bManifestAChunks, SLOT)).toEqual({ kind: "partial", manifest: pB.manifest, why: "hash" });
    const aWithBsSecond = { ...pA.items, [chunkKey(SLOT, 1)]: pB.items[chunkKey(SLOT, 1)] };
    expect(await assembleSlot(aWithBsSecond, SLOT)).toEqual({ kind: "partial", manifest: pA.manifest, why: "hash" });
    const bWithAsFirst = { ...pB.items, [chunkKey(SLOT, 0)]: pA.items[chunkKey(SLOT, 0)] };
    expect(await assembleSlot(bWithAsFirst, SLOT)).toEqual({ kind: "partial", manifest: pB.manifest, why: "hash" });
  });

  it("a shrunk slot's leftover chunks past n are not read", async () => {
    const shrunk = { ...pC.items, ...pA.items };
    expect(Object.keys(shrunk).length).toBeGreaterThan(Object.keys(pA.items).length);
    const a = await assembleSlot(shrunk, SLOT);
    expect(a.kind).toBe("ok");
    expect((a as Ok).backup).toEqual(fileA);
  });

  it("invalid: a manifest of the wrong shape, a chunk that is not a string, a text that is not a file, a time that disagrees", async () => {
    expect(await assembleSlot({ ...pA.items, [manifestKey(SLOT)]: { ...pA.manifest, x: 1 } }, SLOT)).toEqual({
      kind: "invalid",
      manifest: null,
      why: "manifest",
    });
    expect(await assembleSlot({ ...pA.items, [chunkKey(SLOT, 1)]: 5 }, SLOT)).toEqual({
      kind: "invalid",
      manifest: pA.manifest,
      why: "chunk",
    });
    const notAFile = await plan('{"hello":"world"}', SLOT, TAG, T0);
    expect(await assembleSlot(notAFile.items, SLOT)).toEqual({
      kind: "invalid",
      manifest: notAFile.manifest,
      why: "file",
    });
    // a file whose envelope checksum does not hold (the store's own check, in format.ts) is refused too: its first
    // character changed (to another one: the checksum is random)
    const sum = fileA.generation.envelope.checksum;
    const damaged = cloudBackupText(fileA).replace(sum, `${sum[0] === "A" ? "B" : "A"}${sum.slice(1)}`);
    const pd = await plan(damaged, SLOT, TAG, fileA.generation.savedAt);
    expect(await assembleSlot(pd.items, SLOT)).toEqual({ kind: "invalid", manifest: pd.manifest, why: "file" });
    const late = await plan(cloudBackupText(fileA), SLOT, TAG, fileA.generation.savedAt + 1);
    expect(await assembleSlot(late.items, SLOT)).toEqual({ kind: "invalid", manifest: late.manifest, why: "time" });
  });

  it("newer: a later version's manifest, or a later version's file", async () => {
    expect(await assembleSlot({ ...pA.items, [manifestKey(SLOT)]: { ...pA.manifest, v: 2 } }, SLOT)).toEqual({
      kind: "newer",
      manifest: null,
    });
    const later = await plan(JSON.stringify({ format: "sixkey-cloud-backup", v: 2, more: [] }), SLOT, TAG, T0);
    expect(await assembleSlot(later.items, SLOT)).toEqual({ kind: "newer", manifest: later.manifest });
  });

  it("a writer with no margin (whole 8,192 B items: a later Sixkey) is read; only past the quota is it not ours", async () => {
    const text = cloudBackupText(fileC);
    const cuts: string[] = [];
    for (let at = 0, i = 0; at < text.length; i++) {
      const room = QUOTA_BYTES_PER_ITEM - chunkKey(SLOT, i).length - 2; // no quote in this file's ciphertext part
      let take = 0;
      for (let left = room; at + take < text.length; take++) {
        const cost = text[at + take] === '"' ? 2 : 1;
        if (cost > left) break;
        left -= cost;
      }
      cuts.push(text.slice(at, at + take));
      at += take;
    }
    const m: SlotManifest = {
      v: 1,
      g: TAG,
      n: cuts.length,
      z: text.length,
      h: await hashOf(text),
      t: fileC.generation.savedAt,
    };
    const area: Area = { [manifestKey(SLOT)]: m };
    cuts.forEach((c, i) => (area[chunkKey(SLOT, i)] = c));
    expect(Math.max(...cuts.map((c, i) => chromeBytes(chunkKey(SLOT, i), c)))).toBe(QUOTA_BYTES_PER_ITEM);
    expect(await assembleSlot(area, SLOT)).toMatchObject({ kind: "ok", backup: fileC });
  });

  it("a manifest no writer makes is 'invalid', not 'partial' for ever: a non-canonical hash, a length past n chunks", async () => {
    const h = pA.manifest.h;
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const odd = `${h.slice(0, 42)}${ALPHABET[ALPHABET.indexOf(h[42]!) + 1]}=`; // the same 32 bytes, read leniently
    expect(await assembleSlot({ ...pA.items, [manifestKey(SLOT)]: { ...pA.manifest, h: odd } }, SLOT)).toEqual({
      kind: "invalid",
      manifest: null,
      why: "manifest",
    });
    const long = { ...pA.manifest, z: 10 * 8176 + 8175 + 1, n: 11 };
    expect(await assembleSlot({ ...pA.items, [manifestKey(SLOT)]: long }, SLOT)).toEqual({
      kind: "invalid",
      manifest: null,
      why: "manifest",
    });
  });

  it("ownSlot: what the write rule sees of each", async () => {
    const m = pA.manifest;
    const cases: [Assembled, OwnSlot][] = [
      [
        { kind: "ok", manifest: m, text: "", backup: fileA },
        { g: m.g, intact: true },
      ],
      [{ kind: "absent" }, null],
      [{ kind: "partial", manifest: null, why: "manifest" }, null],
      [
        { kind: "partial", manifest: m, why: "hash" },
        { g: m.g, intact: false },
      ],
      [
        { kind: "invalid", manifest: m, why: "file" },
        { g: m.g, intact: false },
      ],
      [
        { kind: "invalid", manifest: null, why: "manifest" },
        { g: null, intact: false },
      ],
      [
        { kind: "newer", manifest: null },
        { g: null, intact: false },
      ],
      [
        { kind: "newer", manifest: m },
        { g: m.g, intact: false },
      ],
    ];
    for (const [a, want] of cases) expect(ownSlot(a), JSON.stringify(a.kind)).toEqual(want);
  });
});

describe("readSlots", () => {
  it("every slot by id, each assembled with its keys; the keys of no slot apart, never read", async () => {
    const one = await plan(cloudBackupText(fileA), "aaaa0000", TAG, fileA.generation.savedAt);
    const two = await plan(cloudBackupText(fileOther), "bbbb1111", TAG, fileOther.generation.savedAt);
    const area: Area = {
      ...two.items,
      ...one.items,
      [chunkKey("cccc2222", 3)]: "late", // a slot whose manifest has not arrived
      "bk2.dddd3333": { v: 1 },
      "bk1.abcd1234.13": "x",
      "bk1.EEEE4444": M,
      sk_other: 1,
    };
    const r = await readSlots(area);
    expect(r.foreign).toEqual(["bk1.EEEE4444", "bk1.abcd1234.13", "bk2.dddd3333", "sk_other"]);
    expect(r.slots.map((s) => s.slot)).toEqual(["aaaa0000", "bbbb1111", "cccc2222"]);
    expect(r.slots[0]!.keys).toEqual(Object.keys(one.items).sort());
    expect((r.slots[0]!.read as Ok).backup).toEqual(fileA);
    expect((r.slots[1]!.read as Ok).backup).toEqual(fileOther);
    expect(r.slots[2]).toEqual({
      slot: "cccc2222",
      keys: [chunkKey("cccc2222", 3)],
      read: { kind: "partial", manifest: null, why: "manifest" },
    });
    expect(await readSlots({})).toEqual({ slots: [], foreign: [] });
  });

  it("the intact slots open with restore.ts as they are: merged, the newest the base", async () => {
    // two devices of vault 1 (A older, C newer) and a torn third: a restore by the recovery key takes the intact two
    const a = await plan(cloudBackupText(fileA), "aaaa0000", "aaaaaaaaaaaaaaaa", fileA.generation.savedAt);
    const c = await plan(cloudBackupText(fileC), "cccc0000", "cccccccccccccccc", fileC.generation.savedAt);
    const torn = await plan(cloudBackupText(fileB), "bbbb0000", "bbbbbbbbbbbbbbbb", fileB.generation.savedAt);
    const { [chunkKey("bbbb0000", 0)]: _gone, ...tornItems } = torn.items;
    const { slots } = await readSlots({ ...a.items, ...c.items, ...tornItems });
    const intact = slots.filter((s) => s.read.kind === "ok").map((s) => slotCandidate(s.slot, s.read as Ok));
    expect(intact.map((x) => x.id)).toEqual(["aaaa0000", "cccc0000"]);
    const r = await openCloudBackups(
      intact,
      { recoveryKey: rk.recoveryCode },
      { now: T0 + 60_000, device: "restored1" },
    );
    expect(r).not.toBeNull();
    expect(r!.base.id).toBe("cccc0000");
    expect(r!.base.head).toBe("cccccccccccccccc");
    expect(r!.merged).toEqual(["cccc0000", "aaaa0000"]);
    expect(r!.vault.entries.length).toBe(65);
    expect(r!.needsPassword).toBe(true);
  });
});

// ---- the empty vault ------------------------------------------------------------------------------------------------

/** A vault with one entry, every field at its shortest that the vault's reader accepts. */
const minimalEntry = (): Entry => ({
  id: "a".repeat(8),
  createdAt: 0,
  type: "totp",
  issuer: "",
  label: "",
  secret: "",
  algorithm: "SHA1",
  digits: 6,
  period: 1,
  hlc: "0000000000000.0000.aaaa",
  order: "a",
  phlc: "0000000000000.0000.aaaa",
});

describe("the empty-vault bound (rule 1)", () => {
  it("an empty vault is at most 168 base64 characters, with the longest vault id; under 256", async () => {
    const keys = await quickKeys();
    let most = 0;
    for (let len = 8; len <= 64; len++) {
      const id = "v".repeat(len);
      const env = await encryptVault(serializeVault(emptyVault(id)), keys.vk, { vaultId: id, rev: 1 });
      // the plaintext: {"entries":[],"schemaVersion":1,"vaultId":"…"}; AES-GCM adds 16 bytes; base64
      expect(serializeVault(emptyVault(id)).length).toBe(45 + len);
      expect(env.ciphertext.length).toBe(4 * Math.ceil((45 + len + 16) / 3));
      expect(isEmptyVault(env)).toBe(true);
      most = Math.max(most, env.ciphertext.length);
    }
    expect(most).toBe(168);
    expect(most).toBeLessThan(EMPTY_BELOW);
  });

  it("one entry at every field's shortest, with the shortest vault id, is 356: past 256", async () => {
    const keys = await quickKeys();
    const v: Vault = { schemaVersion: 1, vaultId: "v".repeat(8), entries: [minimalEntry()] };
    const plain = serializeVault(v);
    expect(deserializeVault(plain)).toEqual(v); // the reader takes it
    expect(plain.length).toBe(251);
    const env = await encryptVault(plain, keys.vk, { vaultId: v.vaultId, rev: 1 });
    expect(env.ciphertext.length).toBe(356);
    expect(isEmptyVault(env)).toBe(false);
    expect(EMPTY_BELOW).toBe(256);
  });

  it("no one-entry vault the reader takes is shorter (each field longer, or an optional one more)", async () => {
    const base = canonicalJson({ schemaVersion: 1, vaultId: "v".repeat(8), entries: [minimalEntry()] }).length;
    await fc.assert(
      fc.property(
        fc.record({
          id: fc.stringMatching(/^[A-Za-z0-9_-]{8,64}$/),
          createdAt: fc.nat(),
          issuer: fc.string({ maxLength: 20 }),
          label: fc.string({ maxLength: 20 }),
          secret: fc.constantFrom("", "JBSWY3DPEHPK3PXP"),
          algorithm: fc.constantFrom("SHA1" as const, "SHA256" as const, "SHA512" as const),
          digits: fc.constantFrom(6 as const, 8 as const),
          period: fc.integer({ min: 1, max: 86_400 }),
          device: fc.stringMatching(/^[a-z0-9]{4,16}$/),
          order: fc.stringMatching(/^[0-9A-Za-z]{0,5}[1-9A-Za-z]$/),
          deleted: fc.boolean(),
          group: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
          vaultId: fc.stringMatching(/^[A-Za-z0-9_-]{8,64}$/),
        }),
        (r) => {
          const h = `0000000000000.0000.${r.device}`;
          const e: Entry = {
            ...minimalEntry(),
            id: r.id,
            createdAt: r.createdAt,
            issuer: r.issuer,
            label: r.label,
            secret: r.secret,
            algorithm: r.algorithm,
            digits: r.digits,
            period: r.period,
            hlc: h,
            phlc: h,
            order: r.order,
            ...(r.group !== undefined ? { group: r.group } : {}),
            ...(r.deleted ? { deleted: true, dhlc: h } : {}),
          };
          const v: Vault = { schemaVersion: 1, vaultId: r.vaultId, entries: [e] };
          const plain = serializeVault(v);
          expect(deserializeVault(plain).entries.length).toBe(1);
          expect(plain.length).toBeGreaterThanOrEqual(base);
          // so its ciphertext is at least 356 characters
          expect(4 * Math.ceil((plain.length + 16) / 3)).toBeGreaterThanOrEqual(356);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("an erased account, as the vault keeps it, is far past the bound; slotLocal says empty only for an empty vault", async () => {
    const keys = await quickKeys();
    const clock = createClock("k3x9q2ab", { now: () => T0 });
    const one = typicalVault(keys.keyring.vaultId, 1);
    const erased = purgeEntry(one, one.entries[0]!.id, clock);
    const files = await Promise.all(
      [emptyVault(keys.keyring.vaultId), erased, one].map(async (v, i) =>
        makeCloudBackup(await generation(keys, v, i + 1), "recovery", APP),
      ),
    );
    expect(files.map((f) => slotLocal(f).empty)).toEqual([true, false, false]);
    expect(files[1]!.generation.envelope.ciphertext.length).toBeGreaterThan(400);
  });
});

// ---- the write rule -------------------------------------------------------------------------------------------------

const L0: SlotLocal = {
  seq: 20,
  sum: "SUM0",
  vaultId: "vault-one",
  vkId: "1111222233334444",
  opens: "both",
  wraps: "password:AAAAAAAAAAAAAAAA,recovery:BBBBBBBBBBBBBBBB",
  empty: false,
};
const K0: SlotLink = {
  v: 1,
  slot: SLOT,
  gen: "aaaaaaaaaaaaaaaa",
  seq: 20,
  sum: "SUM0",
  vaultId: "vault-one",
  vkId: "1111222233334444",
  opens: "both",
  wraps: "password:AAAAAAAAAAAAAAAA,recovery:BBBBBBBBBBBBBBBB",
  mine: [SLOT],
};
const O0: OwnSlot = { g: "aaaaaaaaaaaaaaaa", intact: true };
const d = (l: Partial<SlotLocal>, k: Partial<SlotLink> | null, o: OwnSlot = O0): SlotDecision =>
  decideSlot({ ...L0, ...l }, k === null ? null : { ...K0, ...k }, o);
const W = (to: "new" | "same", why: string) => ({ kind: "write", to, why });

describe("decideSlot: each rule", () => {
  it("8: nothing changed, the slot intact: skip", () => {
    expect(d({}, {})).toEqual({ kind: "skip", why: "unchanged" });
  });

  it("1: an empty vault with no slot of its vault writes nothing", () => {
    expect(d({ empty: true }, null)).toEqual({ kind: "skip", why: "empty" });
    expect(d({ empty: true, vaultId: "vault-two" }, {})).toEqual({ kind: "skip", why: "empty" });
    // a slot of its vault exists: the rule goes on (here: nothing changed)
    expect(d({ empty: true }, {})).toEqual({ kind: "skip", why: "unchanged" });
    expect(d({ empty: true, seq: 21 }, {})).toEqual(W("same", "changed"));
  });

  it("2: no link: a new slot", () => {
    expect(d({}, null)).toEqual(W("new", "first"));
    expect(d({}, null, null)).toEqual(W("new", "first"));
  });

  it("3: held: hold", () => {
    expect(d({ seq: 25 }, { held: true })).toEqual({ kind: "hold", why: "held" });
  });

  it("4: its own slot absent: written again under the same id", () => {
    expect(d({}, {}, null)).toEqual(W("same", "gone"));
  });

  it("5: its own slot carries a tag it did not write: a new slot", () => {
    expect(d({ seq: 21 }, {}, { g: "bbbbbbbbbbbbbbbb", intact: true })).toEqual(W("new", "other_writer"));
    expect(d({}, {}, { g: null, intact: false })).toEqual(W("new", "other_writer"));
    // the race the rule is for: another writer's manifest has arrived, its chunks not yet (not intact): still theirs
    expect(d({}, {}, { g: "bbbbbbbbbbbbbbbb", intact: false })).toEqual(W("new", "other_writer"));
    expect(d({ seq: 21 }, {}, { g: "bbbbbbbbbbbbbbbb", intact: false })).toEqual(W("new", "other_writer"));
    // the tag recorded before a write that landed (`pending`) is its own
    expect(d({ seq: 21 }, { pending: "bbbbbbbbbbbbbbbb" }, { g: "bbbbbbbbbbbbbbbb", intact: true })).toEqual(
      W("same", "changed"),
    );
    // and the one it wrote last still is, while a write is pending that never landed
    expect(d({ seq: 21 }, { pending: "bbbbbbbbbbbbbbbb" })).toEqual(W("same", "changed"));
  });

  it("8: a write recorded but not landed (the slot still carries gen) is written again, though nothing changed", () => {
    expect(d({}, { pending: "bbbbbbbbbbbbbbbb" })).toEqual(W("same", "repair"));
    expect(d({}, { pending: "bbbbbbbbbbbbbbbb" }, { g: "bbbbbbbbbbbbbbbb", intact: true })).toEqual({
      kind: "skip",
      why: "unchanged",
    });
  });

  it("6: another vault: a new slot, the old one left", () => {
    expect(d({ vaultId: "vault-two" }, {})).toEqual(W("new", "other_vault"));
  });

  it("7: a save counter below the link's, or the link's counter with another envelope: hold", () => {
    expect(d({ seq: 19 }, {})).toEqual({ kind: "hold", why: "older" });
    // the store numbers a save one past the copy it has: save 20 with other data is a branch from an older copy
    expect(d({ sum: "SUM1" }, {})).toEqual({ kind: "hold", why: "older" });
    expect(d({ sum: "SUM1" }, { dirty: true })).toEqual({ kind: "hold", why: "older" });
  });

  it("7, an older copy put back by hand (the review's PB1, PB2, PB3): held, then the documented window", () => {
    // the slot holds save 20; save 19 is put back
    const put = (seq: number, sum: string) => d({ seq, sum }, {});
    expect(put(19, "SUM19")).toEqual({ kind: "hold", why: "older" }); // the worker ran before any save
    expect(put(20, "SUM19+1")).toEqual({ kind: "hold", why: "older" }); // one save first: the counter is the link's
    // two saves before the worker ran (30 s after the last change): the counter has passed the link's, the copy looks
    // like a descendant, and its write overwrites the slot (slots.ts rule 7: the window it cannot close)
    expect(put(21, "SUM19+2")).toEqual(W("same", "changed"));
  });

  it("8 and 9: each change writes; a torn own slot is repaired; a merge owed is written", () => {
    expect(d({ seq: 21 }, {})).toEqual(W("same", "changed"));
    expect(d({ seq: 21, sum: "SUM1" }, {})).toEqual(W("same", "changed"));
    expect(d({ vkId: "5555666677778888" }, {})).toEqual(W("same", "changed"));
    expect(d({ opens: "recovery" }, {})).toEqual(W("same", "changed"));
    expect(d({ wraps: "recovery:BBBBBBBBBBBBBBBB" }, {})).toEqual(W("same", "changed"));
    expect(d({}, {}, { g: "aaaaaaaaaaaaaaaa", intact: false })).toEqual(W("same", "repair"));
    expect(d({}, { dirty: true })).toEqual(W("same", "dirty"));
    expect(d({ seq: 21 }, { dirty: true })).toEqual(W("same", "changed"));
  });
});

describe("decideSlot: the order", () => {
  it.each<[string, Partial<SlotLocal>, Partial<SlotLink> | null, OwnSlot, SlotDecision]>([
    ["1 before 2", { empty: true }, null, null, { kind: "skip", why: "empty" }],
    ["1 before 3", { empty: true, vaultId: "vault-two" }, { held: true }, O0, { kind: "skip", why: "empty" }],
    ["2 before 4", {}, null, null, W("new", "first") as SlotDecision],
    ["3 before 4", {}, { held: true }, null, { kind: "hold", why: "held" }],
    ["3 before 5", {}, { held: true }, { g: "bbbbbbbbbbbbbbbb", intact: true }, { kind: "hold", why: "held" }],
    ["3 before 6", { vaultId: "vault-two" }, { held: true }, O0, { kind: "hold", why: "held" }],
    ["4 before 6", { vaultId: "vault-two" }, {}, null, W("same", "gone") as SlotDecision],
    ["4 before 7", { seq: 19 }, {}, null, W("same", "gone") as SlotDecision],
    [
      "5 before 6",
      { vaultId: "vault-two" },
      {},
      { g: "bbbbbbbbbbbbbbbb", intact: true },
      W("new", "other_writer") as SlotDecision,
    ],
    ["5 before 7", { seq: 19 }, {}, { g: "bbbbbbbbbbbbbbbb", intact: true }, W("new", "other_writer") as SlotDecision],
    ["5 before 8", {}, {}, { g: "bbbbbbbbbbbbbbbb", intact: true }, W("new", "other_writer") as SlotDecision],
    ["6 before 7", { vaultId: "vault-two", seq: 19 }, {}, O0, W("new", "other_vault") as SlotDecision],
    ["6 before 8", { vaultId: "vault-two" }, {}, O0, W("new", "other_vault") as SlotDecision],
    [
      "7 before 8 (a torn slot is not repaired while held back)",
      { seq: 19 },
      {},
      { g: "aaaaaaaaaaaaaaaa", intact: false },
      { kind: "hold", why: "older" },
    ],
    ["7 before 8 (dirty)", { seq: 19 }, { dirty: true }, O0, { kind: "hold", why: "older" }],
    [
      "5 before 8 (another's tag, not intact: not repaired)",
      {},
      {},
      { g: "b".repeat(16), intact: false },
      W("new", "other_writer") as SlotDecision,
    ],
    [
      "6 before 7 (another envelope at the link's counter)",
      { vaultId: "vault-two", sum: "SUM1" },
      {},
      O0,
      W("new", "other_vault") as SlotDecision,
    ],
  ])("%s", (_what, l, k, o, want) => {
    expect(d(l, k, o)).toEqual(want);
  });

  it("every combination, against the rules written as a table (first row that matches)", () => {
    const owns: OwnSlot[] = [
      null,
      { g: null, intact: false },
      { g: "f".repeat(16), intact: true },
      { g: "f".repeat(16), intact: false }, // another writer's manifest arrived, its chunks not yet
      O0,
      { g: "aaaaaaaaaaaaaaaa", intact: false },
      { g: "e".repeat(16), intact: true },
    ];
    let n = 0;
    const seen = new Set<string>();
    for (const empty of [false, true])
      for (const linked of [false, true])
        for (const held of [false, true])
          for (const pending of [false, true])
            for (const own of owns)
              for (const vault of ["vault-one", "vault-two"])
                for (const seq of [19, 20, 21])
                  for (const sum of ["SUM0", "SUM1"])
                    for (const vk of ["1111222233334444", "5555666677778888"])
                      for (const opens of ["both", "recovery"] as const)
                        for (const wraps of [L0.wraps, "recovery:CCCCCCCCCCCCCCCC"])
                          for (const dirty of [false, true]) {
                            const local: SlotLocal = { ...L0, empty, vaultId: vault, seq, sum, vkId: vk, opens, wraps };
                            const link: SlotLink | null = linked
                              ? {
                                  ...K0,
                                  ...(held ? { held: true } : {}),
                                  ...(dirty ? { dirty: true } : {}),
                                  ...(pending ? { pending: "e".repeat(16) } : {}),
                                }
                              : null;
                            const ours =
                              own !== null &&
                              own.g !== null &&
                              link !== null &&
                              (own.g === link.gen || own.g === link.pending);
                            const same = seq === 20 && vk === K0.vkId && opens === "both" && wraps === L0.wraps;
                            const rows: [boolean, SlotDecision][] = [
                              [empty && (!link || link.vaultId !== vault), { kind: "skip", why: "empty" }],
                              [!link, W("new", "first") as SlotDecision],
                              [held, { kind: "hold", why: "held" }],
                              [own === null, W("same", "gone") as SlotDecision],
                              [!ours, W("new", "other_writer") as SlotDecision],
                              [vault !== K0.vaultId, W("new", "other_vault") as SlotDecision],
                              [seq < K0.seq || (seq === K0.seq && sum !== K0.sum), { kind: "hold", why: "older" }],
                              [
                                same && !!own?.intact && (!pending || own?.g === "e".repeat(16)) && !dirty,
                                { kind: "skip", why: "unchanged" },
                              ],
                              [true, W("same", !same ? "changed" : dirty ? "dirty" : "repair") as SlotDecision],
                            ];
                            const want = rows.find(([hit]) => hit)![1];
                            expect(decideSlot(local, link, own)).toEqual(want);
                            seen.add(JSON.stringify(want));
                            n++;
                          }
    expect(n).toBe(2 * 2 * 2 * 2 * 7 * 2 * 3 * 2 * 2 * 2 * 2 * 2);
    // every decision is reached
    expect(seen.size).toBe(11);
  });
});

// ---- the link -------------------------------------------------------------------------------------------------------

describe("the link", () => {
  const L1: SlotLocal = { ...L0, seq: 21, sum: "SUM1" };
  /** A plan of `local` (the generation the link records; planSlot takes it from the file, here it is given). */
  const P = async (slot: string, g: string, local = L1): Promise<SlotPlan> => ({
    ...(await plan("a".repeat(100), slot, g)),
    local,
  });

  it("an overwrite records what it writes first, its tag as pending; the tag read there becomes gen", async () => {
    const p = await P(SLOT, "bbbbbbbbbbbbbbbb");
    const dec: WriteDecision = { kind: "write", to: "same", why: "changed" };
    const L1fields = { seq: 21, sum: "SUM1" };
    expect(linkBefore(K0, O0, dec, p)).toEqual({ ...K0, ...L1fields, pending: "bbbbbbbbbbbbbbbb" });
    // a write that landed earlier but was never recorded: its tag (pending) is promoted
    const landed: SlotLink = { ...K0, pending: "cccccccccccccccc" };
    expect(linkBefore(landed, { g: "cccccccccccccccc", intact: true }, dec, p)).toEqual({
      ...K0,
      ...L1fields,
      gen: "cccccccccccccccc",
      pending: "bbbbbbbbbbbbbbbb",
    });
    // its own slot absent (rule 4): gen as it was
    expect(linkBefore(K0, null, { kind: "write", to: "same", why: "gone" }, p)).toEqual({
      ...K0,
      ...L1fields,
      pending: "bbbbbbbbbbbbbbbb",
    });
    // held, dirty: gone with the write (rule 3 holds before any write; the write is the merge owed)
    expect(linkBefore({ ...K0, dirty: true }, O0, dec, p).dirty).toBeUndefined();
    // an overwrite is of the link's own slot, and needs a link
    expect(() => linkBefore(K0, O0, dec, { ...p, slot: "zzzz9999" })).toThrow(SlotError);
    expect(() => linkBefore(null, O0, dec, p)).toThrow(SlotError);
  });

  it("a new slot's link is the final one at once, the slot among its own", async () => {
    const p = await P("zzzz9999", "bbbbbbbbbbbbbbbb");
    const dec: WriteDecision = { kind: "write", to: "new", why: "other_vault" };
    const want: SlotLink = {
      v: 1,
      slot: "zzzz9999",
      gen: "bbbbbbbbbbbbbbbb",
      seq: 21,
      sum: "SUM1",
      vaultId: L0.vaultId,
      vkId: L0.vkId,
      opens: "both",
      wraps: L0.wraps,
      mine: [SLOT, "zzzz9999"],
    };
    expect(linkBefore({ ...K0, held: true, dirty: true, pending: "cccccccccccccccc" }, O0, dec, p)).toEqual(want);
    expect(linkAfter({ ...K0, held: true, dirty: true, pending: "cccccccccccccccc" }, dec, p)).toEqual(want);
    expect(linkAfter(null, { kind: "write", to: "new", why: "first" }, p).mine).toEqual(["zzzz9999"]);
  });

  it("after an overwrite: the new tag and what was written; pending, held and dirty gone; its own slots as they were", async () => {
    const p = await P(SLOT, "bbbbbbbbbbbbbbbb");
    const adopted: SlotLink = { ...K0, mine: ["x0000000"], pending: "bbbbbbbbbbbbbbbb", dirty: true };
    expect(linkAfter(adopted, { kind: "write", to: "same", why: "dirty" }, p)).toEqual({
      v: 1,
      slot: SLOT,
      gen: "bbbbbbbbbbbbbbbb",
      seq: 21,
      sum: "SUM1",
      vaultId: L0.vaultId,
      vkId: L0.vkId,
      opens: "both",
      wraps: L0.wraps,
      mine: ["x0000000"],
    });
  });

  it("its own slot ids: the last 16, each once, the newest last", async () => {
    let link: SlotLink | null = null;
    const ids = Array.from({ length: 20 }, (_, i) => `s${String(i).padStart(7, "0")}`);
    for (const id of [...ids, ids[17]!])
      link = linkAfter(link, { kind: "write", to: "new", why: "first" }, await P(id, TAG));
    expect(link!.mine).toEqual([...ids.slice(4, 17), ...ids.slice(18), ids[17]!]);
    expect(link!.mine.length).toBe(MAX_MINE);
  });

  it("a worker stopped before the set, or after it, finds its slot its own and writes it again, never forks", async () => {
    const p = await P(SLOT, "bbbbbbbbbbbbbbbb");
    const before = linkBefore(K0, O0, { kind: "write", to: "same", why: "changed" }, p);
    // stopped before the set: the slot still carries gen, and not what the link says: written again
    expect(decideSlot(L1, before, O0)).toEqual(W("same", "repair"));
    // stopped after it: the slot carries pending and holds what the link says
    expect(decideSlot(L1, before, { g: "bbbbbbbbbbbbbbbb", intact: true })).toEqual({ kind: "skip", why: "unchanged" });
    expect(decideSlot({ ...L1, seq: 22, sum: "SUM2" }, before, { g: "bbbbbbbbbbbbbbbb", intact: true })).toEqual(
      W("same", "changed"),
    );
    // and an older copy put back after it is held: the slot holds the newer write (the history model found this)
    expect(decideSlot(L0, before, { g: "bbbbbbbbbbbbbbbb", intact: true })).toEqual({ kind: "hold", why: "older" });
    // a new slot stopped before its set: absent, written again under its id
    const fresh = await P("zzzz9999", "cccccccccccccccc");
    const nb = linkBefore(K0, O0, { kind: "write", to: "new", why: "other_vault" }, fresh);
    expect(decideSlot(L1, nb, null)).toEqual(W("same", "gone"));
    // and after it: its own, nothing to do
    expect(decideSlot(L1, nb, { g: "cccccccccccccccc", intact: true })).toEqual({ kind: "skip", why: "unchanged" });
  });

  it("adoption: the slot and tag read, the restored vault's counter, dirty when it merged more than one slot", () => {
    const L: SlotLocal = { ...L0, seq: 3, sum: "SUMR", vaultId: "vault-one" };
    expect(adoptSlot(null, "zzzz9999", "dddddddddddddddd", L, false)).toEqual({
      v: 1,
      slot: "zzzz9999",
      gen: "dddddddddddddddd",
      seq: 3,
      sum: "SUMR",
      vaultId: "vault-one",
      vkId: L0.vkId,
      opens: "both",
      wraps: L0.wraps,
      mine: [],
    });
    const a = adoptSlot({ ...K0, held: true, pending: "e".repeat(16) }, "zzzz9999", "dddddddddddddddd", L, true);
    expect(a.dirty).toBe(true);
    expect(a.held).toBeUndefined();
    expect(a.pending).toBeUndefined();
    expect(a.mine).toEqual([SLOT]);
    // the first run writes the merge; without dirty, nothing until a change
    expect(decideSlot(L, a, { g: "dddddddddddddddd", intact: true })).toEqual(W("same", "dirty"));
    expect(decideSlot(L, { ...a, dirty: undefined }, { g: "dddddddddddddddd", intact: true })).toEqual({
      kind: "skip",
      why: "unchanged",
    });
  });

  it("a hold is saved as held (heldLink), and stays one whatever the saves after it do", () => {
    const h = heldLink(K0);
    expect(h).toEqual({ ...K0, held: true });
    expect(heldLink(h)).toEqual(h);
    // rule 7 held it at save 19; then saves on the older copy pass the link's counter: still held (rule 3)
    expect(decideSlot({ ...L0, seq: 19 }, K0, O0)).toEqual({ kind: "hold", why: "older" });
    for (const seq of [19, 20, 21, 40])
      expect(decideSlot({ ...L0, seq, sum: `S${seq}` }, h, O0)).toEqual({ kind: "hold", why: "held" });
  });

  it("a held slot merged by a page: the link re-based on the merge, so neither rule 3 nor rule 7 holds it again", () => {
    // the store fell back from save 20 to save 17; the page merged; the merge's save is 18, below the link's 20
    const held: SlotLink = { ...K0, held: true };
    const merged: SlotLocal = { ...L0, seq: 18, sum: "SUMM" };
    const m = mergedLink(held, merged, { slot: SLOT, g: O0!.g }, O0);
    expect(m).toEqual({ ...K0, seq: 18, sum: "SUMM", dirty: true });
    // the next run writes the merge (dirty), or what changed after it
    expect(decideSlot(merged, m, O0)).toEqual(W("same", "dirty"));
    expect(decideSlot({ ...merged, seq: 19, sum: "SUMN" }, m, O0)).toEqual(W("same", "changed"));
    // the slot written by someone else since the page read it: still held
    expect(mergedLink(held, merged, { slot: SLOT, g: O0!.g }, { g: "bbbbbbbbbbbbbbbb", intact: true })).toBe(held);
    // the page found none, and there is none: re-based, written again under its id (rule 4)
    const none = mergedLink(held, merged, { slot: SLOT, g: null }, null);
    expect(none.held).toBeUndefined();
    expect(decideSlot(merged, none, null)).toEqual(W("same", "gone"));
    // the page found none, but one has arrived since: still held
    expect(mergedLink(held, merged, { slot: SLOT, g: null }, O0)).toBe(held);
    // another slot, or a link that is not held: nothing
    expect(mergedLink(held, merged, { slot: "zzzz9999", g: O0!.g }, O0)).toBe(held);
    expect(mergedLink(K0, merged, { slot: SLOT, g: O0!.g }, O0)).toBe(K0);
    // the vault and the tag are kept: another vault still forks, a slot another device took still does
    const other = mergedLink(
      { ...held, gen: "1".repeat(16) },
      { ...merged, vaultId: "vault-two" },
      { slot: SLOT, g: O0!.g },
      O0,
    );
    expect(other.vaultId).toBe("vault-one");
    expect(decideSlot({ ...merged, vaultId: "vault-two" }, other, O0)).toEqual(W("new", "other_writer"));
  });

  it("the held merge keeps a pending tag (the review's RA1): the slot carrying it is still its own", () => {
    // held while a write of its own was in flight: the slot carries `pending`
    const held: SlotLink = { ...K0, held: true, pending: "cccccccccccccccc" };
    const ours: OwnSlot = { g: "cccccccccccccccc", intact: true };
    const merged: SlotLocal = { ...L0, seq: 18, sum: "SUMM" };
    const m = mergedLink(held, merged, { slot: SLOT, g: "cccccccccccccccc" }, ours);
    expect(m).toEqual({ ...K0, pending: "cccccccccccccccc", seq: 18, sum: "SUMM", dirty: true });
    // written again (the merge), not forked away from its own slot
    expect(decideSlot(merged, m, ours)).toEqual(W("same", "dirty"));
    const { pending: _p, ...dropped } = m;
    expect(decideSlot(merged, dropped, ours)).toEqual(W("new", "other_writer"));
  });

  it("the held merge waits while the slot it read is not whole (another write may be arriving under that manifest)", () => {
    const held: SlotLink = { ...K0, held: true };
    const merged: SlotLocal = { ...L0, seq: 18, sum: "SUMM" };
    const torn: OwnSlot = { g: O0!.g, intact: false };
    expect(mergedLink(held, merged, { slot: SLOT, g: O0!.g }, torn)).toBe(held);
    // once whole again, the page's merge goes through
    expect(mergedLink(held, merged, { slot: SLOT, g: O0!.g }, O0).held).toBeUndefined();
  });

  it("wrapsOf: the methods and IVs, sorted, as the Drive path's (copied; that path's code is gone)", () => {
    // the Google Drive backup's own, as its rules.ts wrote it: each wrap's method and IV, sorted, joined by commas
    const driveWrapsOf = (ws: readonly { method: string; iv: string }[]) =>
      ws
        .map((w) => `${w.method}:${w.iv}`)
        .sort()
        .join(",");
    const ws = [
      { method: "recovery", iv: "BBBBBBBBBBBBBBBB" },
      { method: "password", iv: "AAAAAAAAAAAAAAAA" },
    ];
    expect(wrapsOf(ws)).toBe("password:AAAAAAAAAAAAAAAA,recovery:BBBBBBBBBBBBBBBB");
    expect(wrapsOf([...ws].reverse())).toBe(wrapsOf(ws));
    expect(wrapsOf([])).toBe("");
    fc.assert(
      fc.property(fc.array(fc.record({ method: fc.string(), iv: fc.string() }), { maxLength: 4 }), (x) => {
        expect(wrapsOf(x)).toBe(driveWrapsOf(x));
      }),
      { numRuns: 100 },
    );
  });

  it("slotLocal: the file's counter, envelope checksum, vault, key, opens and wraps", () => {
    expect(slotLocal(fileA)).toEqual({
      seq: 10,
      sum: fileA.generation.envelope.checksum,
      vaultId: rk.keyring.vaultId,
      vkId: rk.keyring.vkId,
      opens: "recovery",
      wraps: wrapsOf(fileA.generation.keyring.wraps),
      empty: false,
    });
  });
});

// ---- the size of real vaults ----------------------------------------------------------------------------------------

describe("how many accounts fit (the size model, pinned with the real code)", () => {
  let shipped: { keyring: Keyring; vk: Vk };
  beforeAll(async () => {
    // the master password and the recovery key, as first run makes them; the password wrap's count set to the shipped
    // one (2,000,000: a character more than the tests' 600,000), which changes the file's length and nothing else read
    const k = await protectedKeys();
    shipped = {
      vk: k.vk,
      keyring: {
        ...k.keyring,
        wraps: k.keyring.wraps.map((w) =>
          w.kdf?.name === "PBKDF2" ? { ...w, kdf: { ...w.kdf, iterations: PBKDF2_PASSWORD_WRAP_ITERATIONS } } : w,
        ),
      },
    };
  });
  const slotOf = async (n: number) => {
    const file = await makeCloudBackup(
      await generation(shipped, typicalVault(shipped.keyring.vaultId, n), 12_345, 1_793_379_341_960),
      "both",
      APP,
    );
    return planSlot(file, SLOT, TAG);
  };

  it("30, 100 and 200 typical accounts: the bytes in Chrome sync", async () => {
    const [s30, s100, s200] = await Promise.all([slotOf(30), slotOf(100), slotOf(200)]);
    expect([s30.kind, s100.kind, s200.kind]).toEqual(["plan", "plan", "plan"]);
    expect([s30.bytes, s100.bytes, s200.bytes]).toEqual(SIZES);
    const per = (s200.bytes - s30.bytes) / 170;
    // the size model's ~454 B an account, measured
    expect(Math.abs(per - 454) / 454).toBeLessThan(0.05);
  });

  it("one, two and three computers writing: as many typical accounts as fit", async () => {
    const fits = async (share: number) => {
      let lo = 1;
      let hi = 400;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const s = await slotOf(mid);
        if (s.kind === "plan" && s.bytes * share <= ROOM_BYTES) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    expect([await fits(1), await fits(2), await fits(3)]).toEqual(FITS);
  });
});
// Measured with this code (its margins: ITEM_MARGIN, AREA_MARGIN); the size model's: ~15 KB, ~220, ~108, ~70.
const SIZES = [15_180, 48_148, 92_699];
const FITS = [220, 106, 70];

// ---- two writers, items in any order --------------------------------------------------------------------------------

describe("two writers' items, delivered in any order", () => {
  const S = "abcd1234";
  let texts: string[]; // the old write's (fileO), A's, B's (the same length as A's), C's (longer)
  let plans: TextPlan[];
  let keys: string[];
  beforeAll(async () => {
    const files = [fileO, fileA, fileB, fileC];
    texts = files.map(cloudBackupText);
    plans = await Promise.all(files.map((f, i) => plan(texts[i]!, S, `${i}`.repeat(16), f.generation.savedAt)));
    keys = [...new Set(plans.flatMap((p) => Object.keys(p.items)))].sort();
  });
  /** Which two writers wrote over the old write, in which order. */
  const WRITERS = fc.constantFrom([1, 2], [2, 1], [1, 3], [3, 2], [2, 3]);
  /** What the reader holds: mostly one source's items (0 none, 1 the old write, 2 and 3 the writers), a few another's. */
  const VIEW = fc.record({
    most: fc.nat(3),
    keys: fc.array(fc.oneof({ weight: 4, arbitrary: fc.constant(-1) }, { weight: 1, arbitrary: fc.nat(3) }), {
      minLength: 14,
      maxLength: 14,
    }),
  });
  /** Each key holds the old write's item, either writer's, or nothing (not arrived, or a leftover removed). */
  const read = async ([x, y]: readonly number[], view: { most: number; keys: number[] }): Promise<string> => {
    const area: Area = {};
    keys.forEach((k, i) => {
      const pick = view.keys[i]! < 0 ? view.most : view.keys[i]!;
      const from = [undefined, plans[0]!, plans[x!]!, plans[y!]!][pick];
      if (from && Object.hasOwn(from.items, k)) area[k] = from.items[k];
    });
    const a = await assembleSlot(area, S);
    expect(["ok", "partial", "absent"]).toContain(a.kind);
    if (a.kind !== "ok") return a.kind;
    expect([texts[0], texts[x!], texts[y!]]).toContain(a.text);
    return `ok ${texts.indexOf(a.text)}`;
  };

  it("assemble to one writer's text, or to nothing usable yet; never to a third text, never 'invalid'", async () => {
    expect(keys.length).toBeLessThanOrEqual(14);
    await fc.assert(
      fc.asyncProperty(WRITERS, VIEW, async (w, v) => void (await read(w, v))),
      { numRuns: 300 },
    );
  });

  it("the mixes of a fixed seed include each write whole, torn ones and none", async () => {
    const seen = new Set<string>();
    await fc.assert(
      fc.asyncProperty(WRITERS, VIEW, async (w, v) => void seen.add(await read(w, v))),
      { numRuns: 300, seed: 1106 },
    );
    expect([...seen].sort()).toEqual(["absent", "ok 0", "ok 1", "ok 2", "ok 3", "partial"]);
  });
});

// ---- device histories against a fake Chrome sync --------------------------------------------------------------------

/** An item as one place holds it: a value, or its removal, with its write's time (Chrome sync: the last write wins). */
type Held = { v: unknown; at: number } | { gone: true; at: number };
type Content = { vaultId: string; tokens: number[] };
type Gen = { content: Content; backup: CloudBackup; text: string };
type Dev = {
  live: boolean;
  gen: Gen | null;
  /** Earlier generations and links, for a fallback and a profile put back. */
  older: { gen: Gen; link: SlotLink | null }[];
  link: SlotLink | null;
  stopped: CloudError | null;
  area: Map<string, Held>;
  /** The tags this device wrote or adopted, and the slots it created or adopted: what it owns. */
  tags: Set<string>;
  slots: Set<string>;
  /** What this computer (this install: a clone starts afresh) wrote, and where, since Chrome's last clear. */
  wrote: { slot: string; tokens: number[] }[];
};
type Act =
  | { a: "edit" | "erase"; d: number; k: number }
  | { a: "run"; d: number; crash: "none" | "pending" | "set" | "remove" }
  | { a: "up" | "down"; d: number; k: number }
  /** An older copy of the vault put back by hand, the link as it was, then `saves` saves before the worker runs. */
  | { a: "putback"; d: number; saves: number }
  | { a: "restore" | "new" | "recover" | "revert" | "merge" | "die"; d: number }
  | { a: "clone"; from: number; to: number }
  | { a: "sync" }
  | { a: "clear" };

const N = 3;
const devIx = fc.nat(N - 1);
const act: fc.Arbitrary<Act> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({ a: fc.constant("edit" as const), d: devIx, k: fc.constantFrom(1, 1, 2, 3, 40, 120) }),
  },
  { weight: 1, arbitrary: fc.record({ a: fc.constant("erase" as const), d: devIx, k: fc.constantFrom(1, 60) }) },
  {
    weight: 8,
    arbitrary: fc.record({
      a: fc.constant("run" as const),
      d: devIx,
      crash: fc.constantFrom("none" as const, "none" as const, "pending" as const, "set" as const, "remove" as const),
    }),
  },
  { weight: 3, arbitrary: fc.record({ a: fc.constantFrom("up" as const, "down" as const), d: devIx, k: fc.nat(40) }) },
  { weight: 4, arbitrary: fc.constant({ a: "sync" as const }) },
  // the rare paths the rules are for, weighted up: adoption, start over, fallbacks, put-backs, merges, clones
  { weight: 4, arbitrary: fc.record({ a: fc.constant("restore" as const), d: devIx }) },
  {
    weight: 3,
    arbitrary: fc.record({ a: fc.constant("putback" as const), d: devIx, saves: fc.constantFrom(0, 1, 2) }),
  },
  { weight: 2, arbitrary: fc.record({ a: fc.constantFrom("new" as const, "revert" as const), d: devIx }) },
  { weight: 3, arbitrary: fc.record({ a: fc.constant("recover" as const), d: devIx }) },
  { weight: 4, arbitrary: fc.record({ a: fc.constant("merge" as const), d: devIx }) },
  { weight: 2, arbitrary: fc.record({ a: fc.constant("clone" as const), from: devIx, to: devIx }) },
  { weight: 1, arbitrary: fc.record({ a: fc.constant("die" as const), d: devIx }) },
  { weight: 1, arbitrary: fc.constant({ a: "clear" as const }) },
);

const ENTRY_OF = (token: number, vaultId: string): Entry => ({
  id: `${vaultId.slice(0, 8)}-${String(token).padStart(27, "0")}`,
  createdAt: T0 + token,
  type: "totp",
  issuer: ISSUERS[token % ISSUERS.length]!,
  label: "alice.smith@example.com",
  secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
  algorithm: "SHA1",
  digits: 6,
  period: 30,
  domains: ["example.com"],
  hlc: `${T0 + token}.0000.k3x9q2ab`,
  order: `a${token.toString(36)}`,
  phlc: `${T0 + token}.0000.k3x9q2ab`,
});

/** What the histories reached, over all runs: each decision, each stop, each crash point, each event. */
const REACHED = new Map<string, number>();
const reach = (what: string) => REACHED.set(what, (REACHED.get(what) ?? 0) + 1);

class SyncWorld {
  stamp = 0;
  /** The new slot ids' bytes, from a fixed sequence: a history with a fixed seed takes the same course every time. */
  ids = 0x5eed;
  idBytes = (n: number) =>
    Uint8Array.from({ length: n }, () => (this.ids = (Math.imul(this.ids, 1103515245) + 12345) >>> 0) >>> 24);
  now = T0;
  token = 0;
  server = new Map<string, Held>();
  keys = new Map<string, QuickKeys>();
  /** Each file the model made, by its ciphertext: what it holds (a restore opens it without a key). */
  contents = new Map<string, Content>();
  /** The accounts erased on some computer: no copy has to keep them. */
  erased = new Set<number>();
  /**
   * The accounts one computer wrote into a slot that another then overwrote without them: two writers on one slot (an
   * adoption, a clone), the race slots.ts's header accepts. Lost only if the first no longer holds them.
   */
  raced = new Set<number>();
  /** The accounts a put-back copy overwrote in the rule-7 window (two saves or more before the worker ran). */
  window = new Set<number>();
  devs: Dev[] = [];

  async vaultKeys(vaultId?: string): Promise<{ vaultId: string; keys: QuickKeys }> {
    if (vaultId) return { vaultId, keys: this.keys.get(vaultId)! };
    const keys = await quickKeys();
    this.keys.set(keys.keyring.vaultId, keys);
    return { vaultId: keys.keyring.vaultId, keys };
  }

  async gen(content: Content, seq: number): Promise<Gen> {
    const keys = this.keys.get(content.vaultId)!;
    const vault: Vault = {
      schemaVersion: 1,
      vaultId: content.vaultId,
      entries: content.tokens.map((t) => ENTRY_OF(t, content.vaultId)),
    };
    this.now += 1000;
    const backup = await makeCloudBackup(await generation(keys, vault, seq, this.now), "recovery", APP);
    this.contents.set(backup.generation.envelope.ciphertext, content);
    return { content, backup, text: cloudBackupText(backup) };
  }

  view(d: Dev): Area {
    const out: Area = {};
    for (const [k, h] of d.area) if (!("gone" in h)) out[k] = h.v;
    return out;
  }

  /**
   * chrome.storage.sync.set, as Chrome checks it: each item within 8,192, the area within 102,400. Measured with
   * JSON.stringify on purpose, not with Chromium's count (chromeBytes): this model is about the write rule, not the room,
   * and a manifest's time it counts up to 5 B short is far inside AREA_MARGIN.
   */
  set(d: Dev, items: Record<string, unknown>) {
    const next = { ...this.view(d), ...items };
    let total = 0;
    for (const [k, v] of Object.entries(next)) {
      const b = k.length + JSON.stringify(v).length;
      if (Object.hasOwn(items, k) && b > QUOTA_BYTES_PER_ITEM) throw new Error(`QUOTA_BYTES_PER_ITEM: ${k} ${b}`);
      total += b;
    }
    if (total > QUOTA_BYTES) throw new Error(`QUOTA_BYTES: ${total}`);
    for (const [k, v] of Object.entries(items)) d.area.set(k, { v: JSON.parse(JSON.stringify(v)), at: ++this.stamp });
  }

  remove(d: Dev, keys: string[]) {
    for (const k of keys) d.area.set(k, { gone: true, at: ++this.stamp });
  }

  inUse(d: Dev): number {
    return Object.entries(this.view(d)).reduce((a, [k, v]) => a + k.length + JSON.stringify(v).length, 0);
  }

  up(d: Dev, k?: number) {
    const keys = [...d.area].filter(([key, h]) => (this.server.get(key)?.at ?? -1) < h.at).map(([key]) => key);
    for (const key of k === undefined ? keys : keys.length ? [keys[k % keys.length]!] : [])
      this.server.set(key, d.area.get(key)!);
  }

  down(d: Dev, k?: number) {
    const keys = [...this.server].filter(([key, h]) => (d.area.get(key)?.at ?? -1) < h.at).map(([key]) => key);
    for (const key of k === undefined ? keys : keys.length ? [keys[k % keys.length]!] : [])
      d.area.set(key, this.server.get(key)!);
  }

  sync() {
    for (const d of this.devs) if (d.live) this.up(d);
    for (const d of this.devs) if (d.live) this.down(d);
  }

  /**
   * One run of the worker, stopped where `crash` says: decide; a hold saved (heldLink); on a skip of its own intact
   * slot, its leftover chunks removed; else plan, room, the link before (linkBefore), the one `set`, the `remove` of
   * the leftovers, the link after (linkAfter). Whether it wrote.
   */
  async run(d: Dev, crash: "none" | "pending" | "set" | "remove" = "none"): Promise<boolean> {
    if (!d.live || !d.gen) return false;
    const area = this.view(d);
    const local = slotLocal(d.gen.backup);
    const read = d.link ? await assembleSlot(area, d.link.slot) : null;
    const own = read ? ownSlot(read) : null;
    const dec = decideSlot(local, d.link, own);
    reach(`${dec.kind} ${dec.why}`);
    if (dec.kind === "skip") {
      if (dec.why === "unchanged" && read?.kind === "ok") {
        const gone = leftovers(area, d.link!.slot, read.manifest.n);
        if (gone.length) reach("leftovers removed on a skip");
        this.remove(d, gone);
      }
      d.stopped = null;
      return false;
    }
    if (dec.kind === "hold") {
      d.link = heldLink(d.link!);
      d.stopped = "held";
      return false;
    }
    const taken = new Set(Object.keys(area).flatMap((k) => parseKey(k)?.slot ?? []));
    const slot = dec.to === "same" ? d.link!.slot : newSlotId(taken, this.idBytes);
    const p = await planSlot(d.gen.backup, slot, newTag());
    if (p.kind === "too_large") {
      reach("too_large");
      d.stopped = "too_large";
      return false;
    }
    expect(p.local).toEqual(local);
    for (const [k, v] of Object.entries(p.items))
      expect(k.length + JSON.stringify(v).length).toBeLessThanOrEqual(ITEM_BYTES);
    if (room(p, area, this.inUse(d)).kind === "no_room") {
      reach("no_room");
      d.stopped = "no_room";
      return false;
    }
    // never a slot it does not own: one it created or adopted, whose tag it wrote or adopted, or a fresh id
    const m = area[manifestKey(slot)];
    const tag = m === undefined ? null : ((parseManifest(m) as SlotManifest | null)?.g ?? "unreadable");
    if (dec.to === "new") expect(Object.keys(area).some((k) => parseKey(k)?.slot === slot)).toBe(false);
    else {
      expect(d.slots.has(slot)).toBe(true);
      expect(tag === null || d.tags.has(tag)).toBe(true);
    }
    d.link = linkBefore(d.link, own, dec, p);
    d.tags.add(p.manifest.g);
    d.slots.add(slot);
    reach(`stopped at ${crash}`);
    if (crash === "pending") return false;
    this.set(d, p.items);
    // another computer's accounts this write leaves out, from a slot both wrote: the race (Dev.wrote, SyncWorld.raced)
    for (const other of this.devs)
      if (other !== d)
        for (const r of other.wrote)
          if (r.slot === slot) for (const t of r.tokens) if (!d.gen.content.tokens.includes(t)) this.raced.add(t);
    d.wrote.push({ slot, tokens: [...d.gen.content.tokens] });
    if (crash === "set") return true;
    const gone = leftovers(this.view(d), p.slot, p.manifest.n);
    if (gone.length) reach("leftovers removed");
    this.remove(d, gone);
    if (crash === "remove") return true;
    d.link = linkAfter(d.link, dec, p);
    d.stopped = null;
    return true;
  }

  async restore(d: Dev) {
    if (d.gen && d.gen.content.tokens.length) return; // a restore is for a computer with no accounts yet
    const { slots } = await readSlots(this.view(d));
    const cands = slots.filter((s) => s.read.kind === "ok").map((s) => slotCandidate(s.slot, s.read as Ok));
    if (!cands.length) return;
    cands.sort(newestFirst);
    const base = cands[0]!;
    const opened = cands.map((c) => this.contents.get(c.backup.generation.envelope.ciphertext)!);
    const tokens = [...new Set(opened.flatMap((c) => c.tokens))].sort((a, b) => a - b);
    if (d.gen) d.older.push({ gen: d.gen, link: d.link });
    d.gen = await this.gen({ vaultId: opened[0]!.vaultId, tokens }, (d.gen?.backup.generation.seq ?? 0) + 1);
    d.link = adoptSlot(d.link, base.id, base.head, slotLocal(d.gen.backup), cands.length > 1);
    reach(cands.length > 1 ? "restore of several slots" : "restore of one slot");
    d.tags.add(base.head);
    d.slots.add(base.id);
    d.stopped = null;
  }

  /**
   * An older copy of the vault put back by hand, `saves` saves on it, then the worker's run. With the counter still
   * at or below the link's, rule 7 must hold it. Past it, the run overwrites the slot with the older data: the window
   * slots.ts's rule 7 documents; the accounts it drops are recorded there, and only those are let go by the end check.
   */
  async putBack(d: Dev, saves: number) {
    const back = d.older.pop();
    if (!back) return;
    d.gen = back.gen;
    for (let i = 0; i < saves; i++) {
      d.older.push({ gen: d.gen, link: d.link });
      d.gen = await this.gen(
        { vaultId: d.gen.content.vaultId, tokens: [...d.gen.content.tokens, ++this.token] },
        d.gen.backup.generation.seq + 1,
      );
    }
    const link = d.link;
    if (link && !link.held && d.gen.backup.generation.seq > link.seq) {
      reach("put back: the window");
      const a = await assembleSlot(this.view(d), link.slot);
      if (a.kind === "ok")
        for (const t of this.contents.get(a.backup.generation.envelope.ciphertext)!.tokens)
          if (!d.gen.content.tokens.includes(t)) this.window.add(t);
    } else if (link) reach("put back: held or nothing newer");
    await this.run(d);
  }
}

/**
 * One history: computer 0 has a vault of three accounts and has handed it to Chrome sync; 1 and 2 are new. Then the
 * acts, then Chrome delivers everything and every live device runs until nothing more is written. Checked: each write
 * was to a slot the device owns (SyncWorld.run); at the end every live device with accounts is stopped, or its own
 * slot is intact and holds its vault; and no account a live device wrote into a slot is lost, but those erased on
 * purpose, those before Chrome's "clear data", those of the two-writer race and of the rule-7 window (SyncWorld.raced,
 * .window), each recorded where it happens.
 */
async function history(acts: Act[]): Promise<SyncWorld> {
  const w = new SyncWorld();
  const fresh = (): Dev => ({
    live: true,
    gen: null,
    older: [],
    link: null,
    stopped: null,
    area: new Map(),
    tags: new Set(),
    slots: new Set(),
    wrote: [],
  });
  w.devs = Array.from({ length: N }, fresh);
  const first = await w.vaultKeys();
  w.devs[0]!.gen = await w.gen({ vaultId: first.vaultId, tokens: [++w.token, ++w.token, ++w.token] }, 1);
  await w.run(w.devs[0]!);
  w.sync();
  for (const x of acts) {
    if (x.a === "sync") {
      w.sync();
      continue;
    }
    if (x.a === "clear") {
      // Chrome's "clear data": every copy is gone, everywhere; what was written before is not owed any more
      w.server.clear();
      for (const d of w.devs) if (d.live) d.area.clear();
      for (const d of w.devs) d.wrote = [];
      continue;
    }
    if (x.a === "clone") {
      const s = w.devs[x.from]!;
      if (x.from === x.to || !s.live) continue;
      reach("clone");
      w.devs[x.to] = {
        ...s,
        older: [...s.older],
        link: s.link && { ...s.link, mine: [...s.link.mine] },
        area: new Map(s.area),
        tags: new Set(s.tags),
        slots: new Set(s.slots),
        wrote: [],
      };
      continue;
    }
    const d = w.devs[x.d]!;
    if (!d.live) continue;
    const seq = (d.gen?.backup.generation.seq ?? 0) + 1;
    switch (x.a) {
      case "edit": {
        const content = d.gen ? d.gen.content : { vaultId: (await w.vaultKeys()).vaultId, tokens: [] };
        if (d.gen) d.older.push({ gen: d.gen, link: d.link });
        d.gen = await w.gen(
          {
            vaultId: content.vaultId,
            tokens: [...content.tokens, ...Array.from({ length: x.k }, () => ++w.token)],
          },
          seq,
        );
        break;
      }
      case "erase": // accounts erased: the file gets shorter (a shrinking slot)
        if (!d.gen || d.gen.content.tokens.length === 0) break;
        d.older.push({ gen: d.gen, link: d.link });
        for (const t of d.gen.content.tokens.slice(-x.k)) w.erased.add(t);
        d.gen = await w.gen({ vaultId: d.gen.content.vaultId, tokens: d.gen.content.tokens.slice(0, -x.k) }, seq);
        break;
      case "run":
        await w.run(d, x.crash);
        break;
      case "up":
        w.up(d, x.k);
        break;
      case "down":
        w.down(d, x.k);
        break;
      case "restore":
        await w.restore(d);
        break;
      case "new": // start over: a new, empty vault
        if (d.gen) d.older.push({ gen: d.gen, link: d.link });
        d.gen = await w.gen({ vaultId: (await w.vaultKeys()).vaultId, tokens: [] }, seq);
        break;
      case "putback":
        await w.putBack(d, x.saves);
        break;
      case "recover": // the store falls back to its previous copy; its recovery hook marks the link held
      case "revert": {
        // (revert: the whole profile put back, the vault and the link of that time)
        const back = d.older.pop();
        if (!back) break;
        d.gen = back.gen;
        if (x.a === "revert") d.link = back.link;
        else if (d.link) d.link = heldLink(d.link);
        break;
      }
      case "merge": {
        // the card's "合并并继续": the held slot opened and merged, then the worker told
        if (!d.link?.held || !d.gen) break;
        const a = await assembleSlot(w.view(d), d.link.slot);
        if (a.kind !== "ok" && a.kind !== "absent") break; // nothing the page can merge yet
        if (a.kind === "ok") {
          const theirs = w.contents.get(a.backup.generation.envelope.ciphertext)!;
          const tokens = [...new Set([...d.gen.content.tokens, ...theirs.tokens])].sort((p, q) => p - q);
          d.older.push({ gen: d.gen, link: d.link });
          d.gen = await w.gen({ vaultId: d.gen.content.vaultId, tokens }, seq);
        }
        const own = ownSlot(a);
        reach(`held merge, ${a.kind}`);
        d.link = mergedLink(
          d.link,
          slotLocal(d.gen.backup),
          { slot: d.link.slot, g: a.kind === "ok" ? a.manifest.g : null },
          own,
        );
        expect(d.link.held).toBeUndefined();
        expect(decideSlot(slotLocal(d.gen.backup), d.link, own).kind).not.toBe("hold");
        break;
      }
      case "die":
        d.live = false;
        break;
    }
  }
  // then Chrome delivers everything and every live device runs, until nothing more is written
  let wrote = true;
  for (let round = 0; round < 8 && wrote; round++) {
    w.sync();
    wrote = false;
    for (const d of w.devs) if (await w.run(d)) wrote = true;
  }
  expect(wrote).toBe(false);
  for (const d of w.devs) {
    if (!d.live || !d.gen || d.gen.content.tokens.length === 0) continue; // an empty vault is never written
    if (d.stopped !== null) {
      expect(["held", "no_room", "too_large"]).toContain(d.stopped);
      reach(`ends ${d.stopped}`);
      continue;
    }
    reach("ends intact");
    const a = await assembleSlot(w.view(d), d.link!.slot);
    expect(a.kind).toBe("ok");
    expect(w.contents.get((a as Ok).backup.generation.envelope.ciphertext)).toEqual(d.gen.content);
  }
  // and no account a live computer handed to Chrome sync is lost: it is in a live computer's vault or in an intact
  // slot, unless erased on purpose, or Chrome's "clear data" came after, or it is one the race or the window dropped
  const known = new Set<number>();
  for (const d of w.devs) if (d.live && d.gen) for (const t of d.gen.content.tokens) known.add(t);
  const server: Area = {};
  for (const [k, h] of w.server) if (!("gone" in h)) server[k] = h.v;
  for (const { read } of (await readSlots(server)).slots)
    if (read.kind === "ok")
      for (const t of w.contents.get(read.backup.generation.envelope.ciphertext)!.tokens) known.add(t);
  for (const d of w.devs)
    for (const { tokens } of d.live ? d.wrote : [])
      for (const t of tokens) {
        if (known.has(t) || w.erased.has(t)) continue;
        expect(w.raced.has(t) || w.window.has(t), `account ${t} lost`).toBe(true);
        reach(w.window.has(t) ? "lost in the window" : "lost in the race");
      }
  return w;
}

const HISTORIES = fc.array(act, { minLength: 20, maxLength: 40, size: "max" });

describe("random device histories against a fake Chrome sync, with real files", () => {
  it("a device writes only slots it owns; every live vault ends in an intact slot or stopped; nothing written is lost", async () => {
    await fc.assert(
      fc.asyncProperty(HISTORIES, async (acts) => void (await history(acts))),
      { numRuns: 40 },
    );
  });

  it("the histories of a fixed seed reach every decision, stop, crash point and event the rule has", async () => {
    REACHED.clear();
    await fc.assert(
      fc.asyncProperty(HISTORIES, async (acts) => void (await history(acts))),
      { numRuns: 80, seed: SEED },
    );
    const missing = REACH_ALL.filter((k) => !REACHED.has(k));
    expect(missing, JSON.stringify([...REACHED].sort())).toEqual([]);
  });
});
/** A seed whose 80 histories reach all of REACH_ALL (a change to the model may need another). */
const SEED = 20261106;
const REACH_ALL = [
  "skip empty",
  "skip unchanged",
  "hold held",
  "hold older",
  "write first",
  "write other_writer",
  "write other_vault",
  "write gone",
  "write changed",
  "write repair",
  "write dirty",
  "too_large",
  "no_room",
  "stopped at none",
  "stopped at pending",
  "stopped at set",
  "stopped at remove",
  "leftovers removed",
  "restore of one slot",
  "restore of several slots",
  "held merge, ok",
  "put back: the window",
  "put back: held or nothing newer",
  "clone",
  "ends intact",
  "ends held",
  "ends no_room",
  "ends too_large",
].sort();

// ---- the same model, in histories written out -----------------------------------------------------------------------

describe("histories written out", () => {
  const dev = (w: SyncWorld, i: number) => w.devs[i]!;
  const slotOf = async (w: SyncWorld, i: number) => assembleSlot(w.view(dev(w, i)), dev(w, i).link!.slot);
  const tokensIn = (w: SyncWorld, a: Assembled) =>
    a.kind === "ok" ? w.contents.get(a.backup.generation.envelope.ciphertext)!.tokens : null;

  it("PB1, PB2: an older copy put back, one save, then the worker: held (rule 7), the newer slot kept", async () => {
    // computer 0 wrote [1, 2, 3] (save 1) and [1, 2, 3, 4] (save 2); save 1 is put back and saved once more (save 2
    // again, with account 5): before the review's fix, that save overwrote the slot and account 4 was gone
    const w = await history([
      { a: "edit", d: 0, k: 1 },
      { a: "run", d: 0, crash: "none" },
      { a: "putback", d: 0, saves: 1 },
    ]);
    expect(dev(w, 0).stopped).toBe("held");
    expect(dev(w, 0).link!.held).toBe(true);
    expect(tokensIn(w, await slotOf(w, 0))).toEqual([1, 2, 3, 4]);
    expect([...w.window]).toEqual([]);
  });

  it("PB3: two saves on the put-back copy before the worker ran: the documented window, and nothing else lost", async () => {
    const w = await history([
      { a: "edit", d: 0, k: 1 },
      { a: "run", d: 0, crash: "none" },
      { a: "putback", d: 0, saves: 2 },
    ]);
    // the counter passed the link's: the run overwrote the slot with the older copy and its two saves
    expect(dev(w, 0).stopped).toBeNull();
    expect(tokensIn(w, await slotOf(w, 0))).toEqual([1, 2, 3, 5, 6]);
    expect([...w.window]).toEqual([4]); // account 4: only in the overwritten slot, gone (history() let only it go)
  });

  it("the review's MRA2: held while an adopter rewrote the slot, then merged: it forks, never writes the adopter's", async () => {
    const w = await history([
      { a: "restore", d: 1 }, // computer 1 adopts computer 0's slot
      { a: "edit", d: 0, k: 1 }, // save 2 on 0 (account 4), not written
      { a: "edit", d: 1, k: 1 }, // account 5 on 1
      { a: "run", d: 1, crash: "none" }, // 1 rewrites the adopted slot
      { a: "sync" },
      { a: "recover", d: 0 }, // 0's store falls back to save 1: held
      { a: "merge", d: 0 }, // the page merges the slot (1's write, under 1's tag)
      { a: "run", d: 0, crash: "none" },
    ]);
    const s0 = dev(w, 1).link!.slot;
    expect(dev(w, 0).link!.slot).not.toBe(s0); // 0 forked (rule 5): the tag it merged is 1's
    expect(tokensIn(w, await slotOf(w, 0))).toEqual([1, 2, 3, 5]);
    expect(tokensIn(w, await slotOf(w, 1))).toEqual([1, 2, 3, 5]);
  });

  it("start over: the new vault gets a new slot, the old vault's last copy is left (rule 6)", async () => {
    const w = await history([
      { a: "new", d: 0 },
      { a: "edit", d: 0, k: 1 },
      { a: "run", d: 0, crash: "none" },
    ]);
    const d0 = dev(w, 0);
    expect(tokensIn(w, await slotOf(w, 0))).toEqual([4]);
    const { slots } = await readSlots(w.view(d0));
    const old = slots.find((x) => x.slot !== d0.link!.slot)!;
    expect(tokensIn(w, old.read)).toEqual([1, 2, 3]);
  });

  it("a write stopped after its set, then the older copy put back: held, as the link already says what was written", async () => {
    const w = await history([
      { a: "edit", d: 0, k: 1 },
      { a: "run", d: 0, crash: "set" }, // the slot holds save 2; the worker stopped before its link after
      { a: "putback", d: 0, saves: 0 }, // save 1 put back
    ]);
    expect(dev(w, 0).stopped).toBe("held");
    expect(tokensIn(w, await slotOf(w, 0))).toEqual([1, 2, 3, 4]);
  });

  it("the review's RA6: another writer's manifest has arrived, its chunks not yet: a new slot, never a repair", async () => {
    const w = await history([
      { a: "restore", d: 1 }, // 1 adopts 0's slot
      { a: "edit", d: 1, k: 1 },
      { a: "run", d: 1, crash: "none" }, // 1 rewrites it: a manifest and a chunk
      { a: "up", d: 1, k: 0 }, // both reach the server
      { a: "up", d: 1, k: 0 },
      { a: "down", d: 0, k: 0 }, // only the manifest reaches 0: under 1's tag, its chunk still 0's own
      { a: "run", d: 0, crash: "none" },
    ]);
    const s0 = dev(w, 1).link!.slot;
    expect(dev(w, 0).link!.slot).not.toBe(s0); // 0 forked (rule 5), it did not "repair" 1's slot
    expect(tokensIn(w, await slotOf(w, 0))).toEqual([1, 2, 3]);
    expect(tokensIn(w, await slotOf(w, 1))).toEqual([1, 2, 3, 4]);
  });

  it("the race slots.ts accepts: an adopter overwrites, and the first computer starts over before it sees that", async () => {
    const w = await history([
      { a: "restore", d: 2 }, // 2 adopts 0's slot as it was ([1, 2, 3])
      { a: "edit", d: 0, k: 1 }, // 0 adds account 4 and writes it
      { a: "run", d: 0, crash: "none" },
      { a: "edit", d: 2, k: 1 }, // 2 adds account 5 and writes, before 0's write reached it
      { a: "run", d: 2, crash: "none" },
      { a: "new", d: 0 }, // 0 starts over
    ]);
    // 2's write landed last; 0 no longer holds account 4: gone, and recorded as the race
    expect(tokensIn(w, await slotOf(w, 2))).toEqual([1, 2, 3, 5]);
    expect([...w.raced]).toEqual([4]);
  });

  it("N1: leftover chunks of a write stopped before its remove go at the next run, though it writes nothing", async () => {
    const w = await history([
      { a: "edit", d: 0, k: 60 }, // a large vault: several chunks
      { a: "run", d: 0, crash: "none" },
      { a: "erase", d: 0, k: 60 }, // back to one chunk
      { a: "run", d: 0, crash: "set" }, // the set landed, the remove did not
    ]);
    // the end's runs skipped (nothing changed) and removed chunks 1 and up
    const d0 = dev(w, 0);
    const keys = Object.keys(w.view(d0)).filter((k) => parseKey(k)?.slot === d0.link!.slot);
    expect(keys.sort()).toEqual([manifestKey(d0.link!.slot), chunkKey(d0.link!.slot, 0)]);
  });
});
