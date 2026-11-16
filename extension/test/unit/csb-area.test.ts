// The one writer of chrome.storage.sync (the backup in Chrome's sync storage, CSB-2; src/platform/csb-area.ts): one
// `set` per write, of one slot's items and nothing else, its shape and content checked again (a plan past ROOM_BYTES
// refused as too_large); two removes, a slot's leftovers and a whole slot, slot keys only; Chrome's refusals told apart
// by their exact texts (Chromium 145 and 156; test/e2e/csb-probe.spec.ts pins them on 156), anything else "other";
// the reads passed through, each key asked once. Against a fake area (test/helpers/fake-sync-area.ts) where Chrome's
// quotas matter, and the fake's own facts.
import { beforeAll, describe, expect, it } from "vitest";
import { sha256, toB64, utf8 } from "../../src/core/crypto/bytes";
import { makeCloudBackup } from "../../src/core/cloud/format";
import {
  assembleSlot,
  chunkKey,
  ITEM_BYTES,
  itemBytes,
  leftovers,
  manifestKey,
  planSlot,
  planText,
  ROOM_BYTES,
  type SlotManifest,
  type SlotPlan,
  type TextPlan,
} from "../../src/core/cloud/slots";
import type { CsbError } from "../../src/core/cloud/status";
import {
  AreaError,
  bytesInUse,
  errorOf,
  readArea,
  REFUSALS,
  refusalOf,
  removeLeftovers,
  removeSlot,
  writeSlot,
  type Refusal,
  type SyncArea,
} from "../../src/platform/csb-area";
import { account, protectedKeys, seal, T0, vaultOf } from "../helpers/cloud";
import { chromiumItemBytes, FakeSyncArea, TEXTS } from "../helpers/fake-sync-area";

const SLOT = "abcd1234";
const TAG = "0123456789abcdef";

const plan = async (text: string, slot = SLOT, g = TAG): Promise<TextPlan> => {
  const p = await planText(text, slot, g, T0);
  if (p.kind !== "plan") throw new Error("too large");
  return p;
};
/** A text of the alphabet with quotes, `n` characters. */
const textOf = (n: number) => Array.from({ length: n }, (_, i) => (i % 7 === 3 ? '"' : "abcdefghij"[i % 10])).join("");
/** A text of the alphabet with quotes, `n` characters, no two of its chunks alike (a fixed pseudo-random sequence). */
const variedOf = (n: number) => {
  let x = 20261107;
  return Array.from(
    { length: n },
    () => '"abcdefghijklmnopqrstuvwxyz'[(x = (Math.imul(x, 1103515245) + 12345) >>> 0) % 27],
  ).join("");
};

/** An area whose calls are recorded and whose answers a test chooses. */
function scripted(o: { set?: () => Promise<void>; remove?: () => Promise<void> } = {}) {
  const calls: [string, unknown][] = [];
  const area: SyncArea = {
    get: async (k) => (calls.push(["get", k]), { a: 1 }),
    getBytesInUse: async (k) => (calls.push(["getBytesInUse", k]), 42),
    set: (items) => (calls.push(["set", items]), o.set ? o.set() : Promise.resolve()),
    remove: (keys) => (calls.push(["remove", keys]), o.remove ? o.remove() : Promise.resolve()),
  };
  return { area, calls };
}
const thrownAsync = async (p: Promise<unknown>) => {
  try {
    await p;
    return "no throw";
  } catch (e) {
    return e instanceof AreaError ? `${e.code}: ${e.message}` : `other: ${String(e)}`;
  }
};

/** A plan with its items under another slot id (keys made by manifestKey and chunkKey from it). */
const rekey = (p: TextPlan, slot: string): TextPlan => ({
  ...p,
  slot,
  items: Object.fromEntries([
    [manifestKey(slot), p.manifest],
    ...Array.from({ length: p.manifest.n }, (_, i) => [chunkKey(slot, i), p.items[chunkKey(p.slot, i)]!]),
  ]),
});

let short: TextPlan; // one chunk of 100 characters
let p13: TextPlan; // thirteen chunks, the last short
/** The plan's items with some chunks other, and its manifest's z, h and its bytes made to match: a plan that checks. */
async function consistent(p: TextPlan, chunks: Record<number, string>): Promise<TextPlan> {
  const pieces = Array.from({ length: p.manifest.n }, (_, i) => chunks[i] ?? (p.items[chunkKey(p.slot, i)] as string));
  const text = pieces.join("");
  const manifest: SlotManifest = { ...p.manifest, z: text.length, h: toB64(await sha256(utf8(text))) };
  const items: TextPlan["items"] = { [manifestKey(p.slot)]: manifest };
  pieces.forEach((x, i) => (items[chunkKey(p.slot, i)] = x));
  const bytes = Object.entries(items).reduce((a, [k, v]) => a + itemBytes(k, v)!, 0);
  return { ...p, manifest, items, bytes };
}
let real: SlotPlan; // a real file of 120 accounts: 7 chunks
let small: SlotPlan; // 20 accounts of the same vault: 2 chunks
beforeAll(async () => {
  const keys = await protectedKeys();
  const file = async (n: number, seq: number) =>
    makeCloudBackup(
      await seal(
        keys,
        vaultOf(
          keys.keyring.vaultId,
          Array.from({ length: n }, (_, i) => account(`Issuer ${i}`, "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP")),
        ),
        seq,
        T0 + seq,
      ),
      "both",
      "Sixkey 0.1.0",
    );
  const p = await planSlot(await file(120, 5), SLOT, TAG);
  const q = await planSlot(await file(20, 6), SLOT, "fedcba9876543210");
  if (p.kind !== "plan" || q.kind !== "plan") throw new Error("too large");
  real = p;
  small = q;
  short = await plan(textOf(100));
  p13 = await plan("a".repeat(10 * 8160 + 2 * 8159 + 100));
});

describe("the refusals, by Chromium's exact texts", () => {
  const CASES: [string, Refusal, CsbError][] = [
    ["Resource::kQuotaBytes quota exceeded", "QUOTA_BYTES", "no_room"],
    ["Resource::kQuotaBytesPerItem quota exceeded", "QUOTA_BYTES_PER_ITEM", "other"],
    ["Resource::kMaxItems quota exceeded", "MAX_ITEMS", "other"],
    ["This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.", "MAX_WRITE_OPERATIONS_PER_MINUTE", "busy"],
    ["This request exceeds the MAX_WRITE_OPERATIONS_PER_HOUR quota.", "MAX_WRITE_OPERATIONS_PER_HOUR", "busy"],
  ];

  it.each(CASES)("%s: %s, recorded as %s", (text, refusal, error) => {
    expect(refusalOf(new Error(text))).toEqual({ ok: false, refusal, error, message: text });
  });

  it("the table is exactly these five texts, and the fake area words its refusals the same way", () => {
    expect([...REFUSALS]).toEqual(CASES.map(([t, r]) => [t, r]));
    expect(Object.values(TEXTS).sort()).toEqual(CASES.map(([t]) => t).sort());
  });

  it("each quota's own text, never another's: the area's bytes are not the item's (one text begins the other)", () => {
    expect("Resource::kQuotaBytesPerItem quota exceeded".startsWith("Resource::kQuotaBytes")).toBe(true);
    expect(refusalOf(new Error("Resource::kQuotaBytesPerItem quota exceeded")).refusal).toBe("QUOTA_BYTES_PER_ITEM");
    expect(refusalOf(new Error("Resource::kQuotaBytes quota exceeded")).refusal).toBe("QUOTA_BYTES");
  });

  it.each([
    ["the documented name, not Chromium's text", "QUOTA_BYTES quota exceeded."],
    ["Chromium's text with a period", "Resource::kQuotaBytes quota exceeded."],
    ["a space before", " Resource::kQuotaBytes quota exceeded"],
    ["a prefix", "Resource::kQuotaBytes"],
    ["in other case", "this request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota."],
    ["the deprecated sustained quota", "This request exceeds the MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE quota."],
    ["a property of every object", "constructor"],
    ["another", "__proto__"],
    ["and another", "toString"],
    ["an argument error", "Error in invocation of storage.set(object items, optional function callback)"],
    ["empty", ""],
  ])("anything else is other, its text kept: %s", (_, text) => {
    expect(refusalOf(new Error(text))).toEqual({ ok: false, refusal: "other", error: "other", message: text });
  });

  it("a rejection that is not an Error: its message if it has one, else its text; other", () => {
    expect(refusalOf({ message: TEXTS.minute })).toMatchObject({ refusal: "MAX_WRITE_OPERATIONS_PER_MINUTE" });
    expect(refusalOf({ message: 5 })).toMatchObject({ refusal: "other", message: "[object Object]" });
    expect(refusalOf(TEXTS.bytes)).toMatchObject({ refusal: "QUOTA_BYTES", message: TEXTS.bytes });
    expect(refusalOf(undefined)).toMatchObject({ refusal: "other", message: "undefined" });
    expect(refusalOf(null)).toMatchObject({ refusal: "other", message: "null" });
  });

  it("errorOf: busy for the write-operation quotas, no_room for the area's bytes, other for the rest", () => {
    const all: Refusal[] = [
      "QUOTA_BYTES",
      "QUOTA_BYTES_PER_ITEM",
      "MAX_ITEMS",
      "MAX_WRITE_OPERATIONS_PER_MINUTE",
      "MAX_WRITE_OPERATIONS_PER_HOUR",
      "too_large",
      "other",
    ];
    expect(all.map(errorOf)).toEqual(["no_room", "other", "other", "busy", "busy", "too_large", "other"]);
  });
});

describe("writeSlot: one set of one slot's items", () => {
  it("one call, with exactly the plan's items, and nothing else asked of the area", async () => {
    const { area, calls } = scripted();
    expect(await writeSlot(real, area)).toEqual({ ok: true });
    expect(calls).toEqual([["set", real.items]]);
    expect(real.manifest.n).toBe(7);
    expect(Object.keys(calls[0]![1] as object)).toHaveLength(8);
  });

  it("a plan of 13 chunks is still one call", async () => {
    const p = await plan("a".repeat(10 * 8160 + 2 * 8159 + 100));
    expect(p.manifest.n).toBe(13);
    const { area, calls } = scripted();
    expect(await writeSlot(p, area)).toEqual({ ok: true });
    expect(calls.map(([op]) => op)).toEqual(["set"]);
  });

  it("Chrome's refusal comes back told apart, with its text; nothing more is tried", async () => {
    for (const [text, refusal] of [...REFUSALS, ["Something else", "other"] as const]) {
      const { area, calls } = scripted({ set: () => Promise.reject(new Error(text)) });
      expect(await writeSlot(real, area)).toEqual({ ok: false, refusal, error: errorOf(refusal), message: text });
      expect(calls.map(([op]) => op)).toEqual(["set"]);
    }
  });

  it("a set that throws at once, and an area that is not there: other", async () => {
    const { area } = scripted({
      set: () => {
        throw new Error("Error in invocation of storage.set");
      },
    });
    expect(await writeSlot(real, area)).toMatchObject({ ok: false, refusal: "other" });
    expect(await writeSlot(real, undefined)).toEqual({
      ok: false,
      refusal: "other",
      error: "other",
      message: "storage.sync is not available",
    });
  });

  it("chrome.storage.sync by default (none under the unit tests: other)", async () => {
    expect(globalThis.chrome).toBeUndefined();
    expect(await writeSlot(real)).toMatchObject({ ok: false, refusal: "other" });
    expect(await removeLeftovers(SLOT, 3, [chunkKey(SLOT, 3)])).toMatchObject({ ok: false, refusal: "other" });
    expect(await removeSlot(SLOT)).toMatchObject({ ok: false, refusal: "other" });
    await expect(readArea()).rejects.toThrow("storage.sync is not available");
    await expect(bytesInUse(null)).rejects.toThrow("storage.sync is not available");
  });

  const broken: [string, (p: TextPlan) => TextPlan][] = [
    ["not a plan", (p) => ({ ...p, kind: "too_large" }) as unknown as TextPlan],
    ["a key of another slot", (p) => ({ ...p, items: { ...p.items, [chunkKey("zzzz9999", 0)]: "x" } })],
    ["a key of no slot", (p) => ({ ...p, items: { ...p.items, sk_other: "x" } })],
    ["a chunk past n", (p) => ({ ...p, items: { ...p.items, [chunkKey(SLOT, p.manifest.n)]: "x" } })],
    [
      "a chunk missing",
      (p) => {
        const items = { ...p.items };
        delete items[chunkKey(SLOT, 1)];
        return { ...p, items };
      },
    ],
    [
      "the manifest missing",
      (p) => {
        const items = { ...p.items };
        delete items[manifestKey(SLOT)];
        return { ...p, items };
      },
    ],
    [
      "a manifest that does not parse",
      (p) => ({ ...p, items: { ...p.items, [manifestKey(SLOT)]: { v: 1 } as never } }),
    ],
    ["a later version's manifest", (p) => ({ ...p, items: { ...p.items, [manifestKey(SLOT)]: { v: 2 } as never } })],
    [
      "a manifest other than the plan's",
      (p) => ({ ...p, items: { ...p.items, [manifestKey(SLOT)]: { ...p.manifest, g: "ffffffffffffffff" } } }),
    ],
    ["the plan's manifest other than the item", (p) => ({ ...p, manifest: { ...p.manifest, t: p.manifest.t + 1 } })],
    ["a chunk that is not a string", (p) => ({ ...p, items: { ...p.items, [chunkKey(SLOT, 0)]: p.manifest } })],
    ["a chunk outside the alphabet", (p) => ({ ...p, items: { ...p.items, [chunkKey(SLOT, 0)]: "a<b" } })],
    [
      "a chunk past ITEM_BYTES",
      (p) => ({ ...p, items: { ...p.items, [chunkKey(SLOT, 0)]: "a".repeat(ITEM_BYTES - 14 - 2 + 1) } }),
    ],
    // a plan of one short chunk under another id, its keys made from it: only the id is wrong (with full chunks, the
    // longer keys of an id with a dot would also make them too large)
    ["a slot id with a dot (its manifest's key is a chunk's of another slot)", () => rekey(short, `${SLOT}.1`)],
    ["a slot id of the wrong shape", () => rekey(short, "ABCD1234")],
    // the content: every shape right, the text not the manifest's
    [
      "two chunks swapped (the length kept, the hash not)",
      (p) => ({
        ...p,
        items: {
          ...p.items,
          [chunkKey(SLOT, 0)]: p.items[chunkKey(SLOT, 1)]!,
          [chunkKey(SLOT, 1)]: p.items[chunkKey(SLOT, 0)]!,
        },
      }),
    ],
    [
      "the last chunk cut short (the length not z)",
      (p) => ({ ...p, items: { ...p.items, [chunkKey(SLOT, 2)]: (p.items[chunkKey(SLOT, 2)] as string).slice(1) } }),
    ],
    ["the plan's bytes not its items'", (p) => ({ ...p, bytes: 1 })],
    ["the plan's bytes one short", (p) => ({ ...p, bytes: p.bytes - 1 })],
    [
      "a hand-made plan past ROOM_BYTES (a full thirteenth chunk, z made to match, h and bytes not)",
      () => {
        const full = "a".repeat(ITEM_BYTES - 15 - 2);
        const manifest = { ...p13.manifest, z: 10 * 8160 + 2 * 8159 + full.length };
        return { ...p13, manifest, items: { ...p13.items, [chunkKey(SLOT, 12)]: full, [manifestKey(SLOT)]: manifest } };
      },
    ],
  ];

  /** Which check refuses each (the AreaError's reason): every check refuses one of them by itself. */
  const WHY = new Map<string, string>([
    ["not a plan", "not a plan"],
    ["a key of another slot", "keys"],
    ["a key of no slot", "keys"],
    ["a chunk past n", "keys"],
    ["a chunk missing", "keys"],
    ["the manifest missing", "manifest"],
    ["a manifest that does not parse", "manifest"],
    ["a later version's manifest", "manifest"],
    ["a manifest other than the plan's", "manifest"],
    ["the plan's manifest other than the item", "manifest"],
    ["a chunk that is not a string", "chunk"],
    ["a chunk outside the alphabet", "item size"],
    ["a chunk past ITEM_BYTES", "item size"],
    ["a slot id with a dot (its manifest's key is a chunk's of another slot)", "slot id"],
    ["a slot id of the wrong shape", "slot id"],
    ["two chunks swapped (the length kept, the hash not)", "text hash"],
    ["the last chunk cut short (the length not z)", "text length"],
    ["the plan's bytes not its items'", "bytes"],
    ["the plan's bytes one short", "bytes"],
    ["a hand-made plan past ROOM_BYTES (a full thirteenth chunk, z made to match, h and bytes not)", "text hash"],
  ]);
  it("each malformed plan has its reason, and every check is some plan's reason", () => {
    expect(broken.map(([name]) => name)).toEqual([...WHY.keys()]);
    expect(new Set(WHY.values())).toEqual(
      new Set(["not a plan", "keys", "manifest", "chunk", "item size", "slot id", "text hash", "text length", "bytes"]),
    );
  });

  it.each(broken)("refuses a plan that is not one slot's write, without a call: %s", async (name, f) => {
    const p = await plan(variedOf(20_000));
    expect(p.manifest.n).toBe(3);
    const { area, calls } = scripted();
    expect(await thrownAsync(writeSlot(f(p), area))).toBe(`bad_plan: ${WHY.get(name)}`);
    expect(calls).toEqual([]);
  });

  it("the same plans under an id of the right shape are written (the refusals above are the id's alone)", async () => {
    const p = await plan(textOf(20_000));
    const { area, calls } = scripted();
    for (const x of [rekey(p, SLOT), rekey(p, "zzzz9999"), rekey(short, SLOT), rekey(short, "zzzz9999")])
      expect(await writeSlot(x, area)).toEqual({ ok: true });
    expect(calls).toHaveLength(4);
  });

  it("a plan that checks but is past ROOM_BYTES: too_large, with no call (Chrome would refuse it as QUOTA_BYTES, no_room)", async () => {
    const big = await consistent(p13, { 12: "a".repeat(ITEM_BYTES - 15 - 2) });
    expect(big.bytes).toBeGreaterThan(ROOM_BYTES);
    const { area, calls } = scripted();
    expect(await writeSlot(big, area)).toEqual({
      ok: false,
      refusal: "too_large",
      error: "too_large",
      message: `${big.bytes} B, past ROOM_BYTES (${ROOM_BYTES})`,
    });
    expect(calls).toEqual([]);
    // the same plan, made to fit to the byte (the last chunk shorter by what it was over): written
    const edge = await consistent(p13, { 12: "a".repeat(ITEM_BYTES - 15 - 2 - (big.bytes - ROOM_BYTES)) });
    expect(edge.bytes).toBe(ROOM_BYTES);
    expect(await writeSlot(edge, area)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it("the manifest written is the one checked, not the plan's object (a time that changes once it has been read)", async () => {
    let reads = 0;
    const m = { ...short.manifest };
    const shifty = Object.defineProperty({ ...m }, "t", {
      enumerable: true,
      get: () => (reads++ === 0 ? m.t : m.t + 1),
    }) as SlotManifest;
    const f = new FakeSyncArea();
    expect(
      await writeSlot({ ...short, items: { ...short.items, [manifestKey(SLOT)]: shifty } }, f as unknown as SyncArea),
    ).toEqual({
      ok: true,
    });
    expect(f.snapshot()[manifestKey(SLOT)]).toEqual(m);
    expect((await assembleSlot(f.snapshot(), SLOT)).kind).toBe("invalid"); // (a text of no file: its manifest is whole)
  });

  it("an item at exactly ITEM_BYTES is written (the plan's full chunks are)", async () => {
    const p = await plan("a".repeat(8160 + 5));
    expect(p.manifest.n).toBe(2);
    const { area, calls } = scripted();
    expect(await writeSlot(p, area)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });
});

describe("removeLeftovers: one remove of a slot's chunks from index n on", () => {
  it("one call with exactly those keys (a copy)", async () => {
    const { area, calls } = scripted();
    const keys = [chunkKey(SLOT, 2), chunkKey(SLOT, 12)];
    expect(await removeLeftovers(SLOT, 2, keys, area)).toEqual({ ok: true });
    expect(calls).toEqual([["remove", keys]]);
    expect(calls[0]![1]).not.toBe(keys);
  });

  it("an empty list: no call, so no write operation spent", async () => {
    const { area, calls } = scripted();
    expect(await removeLeftovers(SLOT, 2, [], area)).toEqual({ ok: true });
    expect(calls).toEqual([]);
  });

  it.each([
    ["its manifest", manifestKey(SLOT)],
    ["a chunk below n", chunkKey(SLOT, 1)],
    ["another slot's chunk", chunkKey("zzzz9999", 5)],
    ["another slot's manifest", manifestKey("zzzz9999")],
    ["a key of no slot", "sk_settings"],
    ["chunk 13", "bk1.abcd1234.13"],
    ["a later format's", "bk2.abcd1234.5"],
    ["empty", ""],
    ["not a string", 5 as unknown as string],
    ["not a string, though it reads as the slot's chunk", { toString: () => chunkKey(SLOT, 5) } as unknown as string],
  ])("refuses any key that is not one of the slot's chunks from n on, without a call: %s", async (_, bad) => {
    const { area, calls } = scripted();
    expect(await thrownAsync(removeLeftovers(SLOT, 2, [chunkKey(SLOT, 3), bad], area))).toMatch(/^bad_keys: /);
    expect(calls).toEqual([]);
  });

  it.each([
    ["a slot id of the wrong shape", "ABCD1234", 2],
    ["a slot id with a dot", `${SLOT}.1`, 2],
    ["n 0 (every chunk of an intact slot)", SLOT, 0],
    ["n 14", SLOT, 14],
    ["n not whole", SLOT, 1.5],
  ])("refuses %s, without a call", async (_, slot, n) => {
    const { area, calls } = scripted();
    expect(await thrownAsync(removeLeftovers(slot, n, [], area))).toBe("bad_keys: slot or count");
    expect(calls).toEqual([]);
  });

  it("Chrome's refusal told apart", async () => {
    const { area } = scripted({ remove: () => Promise.reject(new Error(TEXTS.minute)) });
    expect(await removeLeftovers(SLOT, 1, [chunkKey(SLOT, 1)], area)).toEqual({
      ok: false,
      refusal: "MAX_WRITE_OPERATIONS_PER_MINUTE",
      error: "busy",
      message: TEXTS.minute,
    });
  });
});

describe("removeSlot: one remove of a whole slot", () => {
  it("one call: its manifest and every chunk key it can have", async () => {
    const { area, calls } = scripted();
    expect(await removeSlot(SLOT, area)).toEqual({ ok: true });
    expect(calls).toEqual([
      ["remove", [manifestKey(SLOT), ...Array.from({ length: 13 }, (_, i) => chunkKey(SLOT, i))]],
    ]);
  });

  it("in the fake area: the slot gone, whatever it held, every other item left", async () => {
    const f = new FakeSyncArea({ items: { ...real.items, ...rekey(short, "zzzz9999").items, sk_other: 1 } });
    expect(await removeSlot(SLOT, f as unknown as SyncArea)).toEqual({ ok: true });
    expect(f.snapshot()).toEqual({ ...rekey(short, "zzzz9999").items, sk_other: 1 });
  });

  it.each([
    ["of the wrong shape", "ABCD1234"],
    ["with a dot", `${SLOT}.1`],
    ["empty", ""],
  ])("refuses a slot id %s, without a call", async (_, slot) => {
    const { area, calls } = scripted();
    expect(await thrownAsync(removeSlot(slot, area))).toBe("bad_keys: slot");
    expect(calls).toEqual([]);
  });

  it("Chrome's refusal told apart", async () => {
    const { area } = scripted({ remove: () => Promise.reject(new Error("Something else")) });
    expect(await removeSlot(SLOT, area)).toMatchObject({ ok: false, refusal: "other", message: "Something else" });
  });
});

describe("the reads", () => {
  it("readArea: get(null) and getBytesInUse(null), and nothing else", async () => {
    const { area, calls } = scripted();
    expect(await readArea(area)).toEqual({ items: { a: 1 }, inUse: 42 });
    expect(calls.sort()).toEqual([
      ["get", null],
      ["getBytesInUse", null],
    ]);
  });

  it("bytesInUse: Chrome's count of the keys asked, each once, or of the whole area", async () => {
    const { area, calls } = scripted();
    expect(await bytesInUse([manifestKey(SLOT)], area)).toBe(42);
    expect(await bytesInUse(null, area)).toBe(42);
    expect(await bytesInUse([chunkKey(SLOT, 0), manifestKey(SLOT), chunkKey(SLOT, 0)], area)).toBe(42);
    expect(calls).toEqual([
      ["getBytesInUse", [manifestKey(SLOT)]],
      ["getBytesInUse", null],
      ["getBytesInUse", [chunkKey(SLOT, 0), manifestKey(SLOT)]],
    ]);
  });

  it("a key given twice is counted once (Chrome would count it twice: the probe, the fake)", async () => {
    const f = new FakeSyncArea({ items: short.items });
    const mk = manifestKey(SLOT);
    expect(await f.getBytesInUse([mk, mk])).toBe(2 * itemBytes(mk, short.manifest)!);
    expect(await bytesInUse([mk, mk], f as unknown as SyncArea)).toBe(itemBytes(mk, short.manifest));
  });

  it("a read's failure rejects (a read is not refused for a quota)", async () => {
    const fake = new FakeSyncArea();
    fake.fail.get = ["broken"];
    await expect(readArea(fake as unknown as SyncArea)).rejects.toThrow("broken");
  });
});

describe("against the fake area's quotas", () => {
  const sync = (f: FakeSyncArea) => f as unknown as SyncArea;

  it("a real slot: written in one set, one write operation; Chrome's count is the plan's bytes", async () => {
    const f = new FakeSyncArea();
    expect(await writeSlot(real, sync(f))).toEqual({ ok: true });
    expect(f.calls.map((c) => c.op)).toEqual(["set"]);
    expect(f.snapshot()).toEqual(real.items);
    expect(await bytesInUse(null, sync(f))).toBe(real.bytes);
    expect(await readArea(sync(f))).toEqual({ items: real.items, inUse: real.bytes });
  });

  it("a shrink: the set, then one remove of the leftovers, and the area holds the smaller slot alone", async () => {
    const f = new FakeSyncArea({ items: real.items });
    expect(await writeSlot(small, sync(f))).toEqual({ ok: true });
    const gone = leftovers(f.snapshot(), SLOT, small.manifest.n);
    expect(gone).toEqual(Array.from({ length: 5 }, (_, i) => chunkKey(SLOT, i + 2)));
    expect(await removeLeftovers(SLOT, small.manifest.n, gone, sync(f))).toEqual({ ok: true });
    expect(f.snapshot()).toEqual(small.items);
    expect(f.inUse()).toBe(small.bytes);
    expect(f.calls.map((c) => c.op)).toEqual(["set", "remove"]);
  });

  it("no room beside the other items: Chrome's QUOTA_BYTES, recorded as no_room, and nothing of the slot written", async () => {
    const filler: Record<string, string> = {};
    for (let i = 0; i < 9; i++) filler[`x${i}`] = "a".repeat(8000); // 72,036 B of keys of no slot
    const f = new FakeSyncArea({ items: filler });
    expect(await writeSlot(real, sync(f))).toEqual({
      ok: false,
      refusal: "QUOTA_BYTES",
      error: "no_room",
      message: TEXTS.bytes,
    });
    expect(f.snapshot()).toEqual(filler);
  });

  it("the 121st set within a minute: busy; the counters are per operation, so a remove still passes", async () => {
    let t = 1_000;
    const f = new FakeSyncArea({ now: () => t });
    for (let i = 0; i < 120; i++) expect((await writeSlot(small, sync(f))).ok).toBe(true);
    expect(await writeSlot(small, sync(f))).toEqual({
      ok: false,
      refusal: "MAX_WRITE_OPERATIONS_PER_MINUTE",
      error: "busy",
      message: TEXTS.minute,
    });
    expect(await removeLeftovers(SLOT, 2, [chunkKey(SLOT, 9)], sync(f))).toEqual({ ok: true });
    t += 60_001;
    expect(await writeSlot(small, sync(f))).toEqual({ ok: true });
  });

  it("the hour's counter: 1,800 sets, then busy with its own text", async () => {
    let t = 0;
    const f = new FakeSyncArea({ now: () => t });
    for (let i = 0; i < 1_800; i++) {
      if (i % 120 === 0) t += 60_001;
      expect((await writeSlot(small, sync(f))).ok).toBe(true);
    }
    t += 60_001;
    expect(await writeSlot(small, sync(f))).toMatchObject({ refusal: "MAX_WRITE_OPERATIONS_PER_HOUR", error: "busy" });
  });

  it("a refusal Chrome words otherwise: other, its text kept for the diagnostics line", async () => {
    const f = new FakeSyncArea();
    f.fail.set = ["IO error: .../Sync Extension Settings/000003.log: Read-only file system"];
    expect(await writeSlot(small, sync(f))).toEqual({
      ok: false,
      refusal: "other",
      error: "other",
      message: "IO error: .../Sync Extension Settings/000003.log: Read-only file system",
    });
    expect(f.snapshot()).toEqual({});
  });

  it("the plan check measures as Chrome does: every item of a real plan is within the fake's per-item quota", async () => {
    const f = new FakeSyncArea();
    await writeSlot(real, sync(f));
    for (const k of Object.keys(real.items)) expect(await bytesInUse([k], sync(f))).toBeLessThanOrEqual(ITEM_BYTES);
  });
});

describe("the fake area keeps to Chromium's facts (the browser probe's), as the tests above and later ones rely on them", () => {
  const big = "a".repeat(9000);
  it("an item over its quota is refused before the area's bytes; a refused set writes none of its items", async () => {
    const f = new FakeSyncArea({ items: { x: "a".repeat(8000), y: "a".repeat(8000) } });
    const fill: Record<string, string> = {};
    for (let i = 0; i < 12; i++) fill[`f${String(i).padStart(2, "0")}`] = "a".repeat(8192 - 3 - 2);
    const g = new FakeSyncArea({ items: fill });
    await expect(g.set({ big })).rejects.toThrow(TEXTS.perItem); // over both: the item's text
    await expect(g.set({ f00: "b", h: "a".repeat(8192 - 1 - 2), j: "a".repeat(4200) })).rejects.toThrow(TEXTS.bytes);
    expect(g.snapshot()).toEqual(fill);
    await expect(f.set(Object.fromEntries(Array.from({ length: 511 }, (_, i) => [`i${i}`, 0])))).rejects.toThrow(
      TEXTS.items,
    );
    expect(Object.keys(f.snapshot())).toEqual(["x", "y"]);
  });

  it("102,400 bytes are taken, one more refused", async () => {
    const fill: Record<string, string> = {};
    for (let i = 0; i < 12; i++) fill[`f${String(i).padStart(2, "0")}`] = "a".repeat(8192 - 3 - 2);
    const f = new FakeSyncArea({ items: fill });
    await f.set({ last: "a".repeat(4096 - 4 - 2) });
    expect(f.inUse()).toBe(102_400);
    await expect(f.set({ last: "a".repeat(4097 - 4 - 2) })).rejects.toThrow(TEXTS.bytes);
    expect(await f.getBytesInUse(["last", "f00", "nope"])).toBe(4096 + 8192);
  });

  it("write operations counted per operation, 120 a minute; a refused set counts; reads count nothing", async () => {
    let t = 0;
    const f = new FakeSyncArea({ now: () => t });
    for (let i = 0; i < 10; i++) await expect(f.set({ big })).rejects.toThrow(TEXTS.perItem);
    for (let i = 10; i < 120; i++) {
      await f.set({ [`w${i}`]: i });
      await f.get(null);
      await f.getBytesInUse(null);
    }
    await expect(f.set({ w: 1 })).rejects.toThrow(TEXTS.minute);
    for (let i = 0; i < 120; i++) await f.remove([`w${i}`]);
    await expect(f.remove(["w"])).rejects.toThrow(TEXTS.minute);
    await f.clear();
    t = 60_001;
    await f.set({ w: 1 });
  });

  it("getBytesInUse counts a key given twice twice; -0 is kept as the integer 0; get(null) sorts the keys", async () => {
    const f = new FakeSyncArea();
    await f.set({ nn: -1e12, b: 1, a: 2, nz: -0 });
    expect([await f.getBytesInUse(["nn", "nn"]), await f.getBytesInUse(["nn"])]).toEqual([16, 8]);
    expect([await f.getBytesInUse(["nz"]), chromiumItemBytes("nz", -0)]).toEqual([3, 3]);
    expect(Object.is((await f.get(null)).nz, -0)).toBe(false);
    expect(Object.keys(await f.get(null))).toEqual(["a", "b", "nn", "nz"]);
  });

  it("an object set again with its keys in another order is unchanged: no event", async () => {
    const f = new FakeSyncArea();
    const seen: unknown[] = [];
    f.onChanged.addListener((c) => seen.push(c));
    await f.set({ m: { a: 1, b: { c: 2, d: 3 } } });
    await f.set({ m: { b: { d: 3, c: 2 }, a: 1 } });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);
  });

  it("onChanged: one event a call, with every key it changed; none for a set that changes nothing", async () => {
    const f = new FakeSyncArea();
    const seen: unknown[] = [];
    f.onChanged.addListener((c) => seen.push(c));
    await f.set({ a: 1, b: "x" });
    await f.set({ a: 1 });
    await f.set({ a: 2, b: "x" });
    await f.remove(["b", "nope"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([
      { a: { newValue: 1 }, b: { newValue: "x" } },
      { a: { oldValue: 1, newValue: 2 } },
      { b: { oldValue: "x" } },
    ]);
  });

  it("the remote: another computer's items, delivered one by one in the order chosen, past the quotas and counters", async () => {
    let t = 0;
    const f = new FakeSyncArea({ now: () => t });
    for (let i = 0; i < 120; i++) await f.set({ [`w${i}`]: i });
    await new Promise((r) => setTimeout(r, 0)); // (their events, before the listener below)
    const seen: string[][] = [];
    f.onChanged.addListener((c) => seen.push(Object.keys(c)));
    const many: Record<string, string> = {};
    for (let i = 0; i < 14; i++) many[`r${String(i).padStart(2, "0")}`] = "a".repeat(8000);
    f.remote.put(many);
    f.remote.drop(["w0"]);
    expect(f.remote.pending()).toEqual([...Object.keys(many), "w0"]);
    f.remote.deliver("r05");
    f.remote.deliverAll([
      "w0",
      ...Object.keys(many)
        .filter((k) => k !== "r05")
        .reverse(),
    ]);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([
      ["r05"],
      ["w0"],
      ...Object.keys(many)
        .filter((k) => k !== "r05")
        .reverse()
        .map((k) => [k]),
    ]);
    expect(f.inUse()).toBeGreaterThan(f.QUOTA_BYTES); // more than a set may make
    expect(f.calls.filter((c) => c.op === "set")).toHaveLength(120); // and no call of this computer's
    expect(() => f.remote.deliver("r05")).toThrow("nothing queued");
  });
});
