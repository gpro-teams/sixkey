// The browser probe of the backup in Chrome's sync storage (CSB-2): what Chromium does with chrome.storage.sync, pinned
// where the adapter and the layout rely on it (src/platform/csb-area.ts, src/core/cloud/slots.ts, src/options/csb/
// read.ts, and the fake area of the unit tests, test/helpers/fake-sync-area.ts). Playwright's Chromium, the unpacked
// e2e build, a fresh profile signed in to no Google account; the calls are made in the service worker (where the
// backup writes) and in an extension page (where it is read). Nothing of Sixkey's own code runs here but the worker's
// start (since CSB-3 it sets storage.sync's access level, and its backup stays off: it reads and writes nothing of the
// area); the new modules' functions run in Node on the browser's answers (the texts, the counts).
//   - storage.sync works signed out, kept on this computer; a page's onChanged gets one event for a set of many items.
//   - Chromium's count of an item is slots.ts's itemBytes for everything a slot writes (8,192 taken, 8,193 refused,
//     with and without quotes; the manifest's numbers, ".0" and the exponent form), and the fake's for any value.
//   - The refusals' exact texts (csb-area.ts REFUSALS, the fake's TEXTS), the area's limit to the byte, and what a
//     refused set leaves: nothing of it.
//   - A whole plan in one set: getBytesInUse(null) is the plan's bytes, and after a shrink what room() assumes, before
//     and after the remove of the leftovers.
//   - Write operations: set and remove counted apart, 120 calls a minute each, the 121st refused; a clear apart.
//   - The maintainers' C7: the worker's start closes storage.sync to content scripts (CSB-3, through Sixkey's own
//     restrictSyncAccess); opened again (the area's default level), a content script reads and writes it; set to
//     TRUSTED_CONTEXTS, its reads, writes and onChanged are refused while the extension's pages still read; and every
//     start closes it again.
import { expect, test, type Worker } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCloudBackup } from "../../src/core/cloud/format";
import {
  assembleSlot,
  chunkKey,
  itemBytes,
  leftovers,
  manifestKey,
  planSlot,
  QUOTA_BYTES,
  QUOTA_BYTES_PER_ITEM,
  room,
  type SlotManifest,
  type SlotPlan,
} from "../../src/core/cloud/slots";
import { REFUSALS, refusalOf } from "../../src/platform/csb-area";
import { account, protectedKeys, seal, T0, vaultOf } from "../helpers/cloud";
import { chromiumItemBytes, FakeSyncArea, TEXTS } from "../helpers/fake-sync-area";
import { grantScripting } from "./autofill-helpers";
import { close, launch, openOptions, type Profile } from "./harness";

const SLOT = "abcd1234";
const sw = (p: Profile): Worker => p.ctx.serviceWorkers()[0]!;
type Outcome = { ok: true } | { ok: false; message: string; error: boolean };

/** One call of storage.sync in the worker: resolved, or the rejection's text (and whether it was an Error). */
const call = (p: Profile, op: "set" | "remove", arg: unknown): Promise<Outcome> =>
  sw(p).evaluate(
    async ([op, arg]) => {
      try {
        if (op === "set") await chrome.storage.sync.set(arg as Record<string, unknown>);
        else await chrome.storage.sync.remove(arg as string[]);
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, message: String((e as Error)?.message), error: e instanceof Error };
      }
    },
    [op, arg] as const,
  );
const set = (p: Profile, items: Record<string, unknown>) => call(p, "set", items);
const refused = (message: string): Outcome => ({ ok: false, message, error: true });
const bytes = (p: Profile, keys: string[] | null) => sw(p).evaluate((k) => chrome.storage.sync.getBytesInUse(k), keys);
const all = (p: Profile) => sw(p).evaluate(() => chrome.storage.sync.get(null)) as Promise<Record<string, unknown>>;
const clear = (p: Profile) => sw(p).evaluate(() => chrome.storage.sync.clear());

test("storage.sync works in a fresh profile signed in to no Google account, is kept on this computer, and a page sees a set of many items as one change", async () => {
  test.setTimeout(120_000);
  const dir = mkdtempSync(join(tmpdir(), "sixkey-e2e-"));
  let p = await launch(dir);
  try {
    const fake = new FakeSyncArea();
    expect(
      await sw(p).evaluate(() => {
        const s = chrome.storage.sync as unknown as Record<string, number>;
        return [
          s.QUOTA_BYTES,
          s.QUOTA_BYTES_PER_ITEM,
          s.MAX_ITEMS,
          s.MAX_WRITE_OPERATIONS_PER_MINUTE,
          s.MAX_WRITE_OPERATIONS_PER_HOUR,
        ];
      }),
    ).toEqual([
      QUOTA_BYTES,
      QUOTA_BYTES_PER_ITEM,
      fake.MAX_ITEMS,
      fake.MAX_WRITE_OPERATIONS_PER_MINUTE,
      fake.MAX_WRITE_OPERATIONS_PER_HOUR,
    ]);
    expect([await all(p), await bytes(p, null)]).toEqual([{}, 0]);
    const page = await openOptions(p);
    await page.evaluate(() => {
      const w = globalThis as unknown as { seen: unknown[] };
      w.seen = [];
      chrome.storage.sync.onChanged.addListener((c) => w.seen.push({ sync: c }));
      chrome.storage.onChanged.addListener((c, area) => w.seen.push({ area, keys: Object.keys(c).sort() }));
    });
    // a slot's fourteen keys at most: the manifest and chunks 0 to 12
    const keys = [manifestKey(SLOT), ...Array.from({ length: 13 }, (_, i) => chunkKey(SLOT, i))];
    const items = Object.fromEntries(keys.map((k, i) => [k, `v${i}`]));
    expect(await set(p, items)).toEqual({ ok: true });
    const seen = () => page.evaluate(() => (globalThis as unknown as { seen: unknown[] }).seen);
    await expect.poll(async () => (await seen()).length).toBe(2);
    // the two events, in whichever order Chrome sends them
    expect(await seen()).toHaveLength(2);
    expect(await seen()).toEqual(
      expect.arrayContaining([
        { sync: Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { newValue: v }])) },
        { area: "sync", keys: Object.keys(items).sort() },
      ]),
    );
    expect(await page.evaluate(() => chrome.storage.sync.get(null))).toEqual(items);
    // a set that changes nothing: no event
    const [k0, v0] = Object.entries(items)[0]!;
    expect(await set(p, { [k0]: v0 })).toEqual({ ok: true });
    await page.waitForTimeout(500);
    expect(await seen()).toHaveLength(2);
    await page.close();
    // kept on this computer: there after the browser starts again
    await close(p, false);
    p = await launch(dir);
    expect(await all(p)).toEqual(items);
    expect(await bytes(p, null)).toBe(Object.entries(items).reduce((a, [k, v]) => a + chromiumItemBytes(k, v), 0));
  } finally {
    await close(p);
  }
});

/** The values whose count the fake area must give as Chromium does: strings built in the browser from their codes. */
const STRINGS: [string, number[]][] = [
  ["plain", [...Buffer.from("abc")]],
  ["quote", [34]],
  ["backslash", [92]],
  ["bs", [8]],
  ["ff", [12]],
  ["nl", [10]],
  ["cr", [13]],
  ["tab", [9]],
  ["nul", [0]],
  ["ctl", [1, 0x1f]],
  ["del", [0x7f]],
  ["lt", [60]],
  ["gt", [62]],
  ["amp", [38]],
  ["slash", [47]],
  ["e-acute", [0xe9]],
  ["euro", [0x20ac]],
  ["emoji", [0xd83d, 0xde00]],
  ["ls", [0x2028]],
  ["ps", [0x2029]],
  ["bom", [0xfeff]],
  ["lone", [0xd800]],
];
const NUMBERS = [
  0,
  1,
  -1,
  2 ** 31 - 1,
  2 ** 31,
  -(2 ** 31),
  -(2 ** 31) - 1,
  3e9,
  1e10,
  1e11,
  999_999_999_999,
  999_999_999_999.5,
  1e12,
  1e12 + 1,
  T0,
  1_793_379_341_960,
  1_793_379_341_961,
  2 ** 53,
  1e20,
  1.5e20,
  1e21,
  1.5,
  0.1,
  0.30000000000000004,
  123.456,
  1e-5,
  1e-6,
  1.5e-6,
  1e-7,
  1.5e-7,
  5e-324,
  Number.MAX_VALUE,
];

test("Chromium's count: an item of 8,192 bytes by itemBytes is taken and one of 8,193 refused, quotes or not; every value as the fake area counts it; a manifest as itemBytes counts it", async () => {
  test.setTimeout(120_000);
  const p = await launch();
  try {
    // the per-item limit, for the three key lengths of a slot (manifest 12, chunks 14 and 15), without and with quotes
    for (const key of [manifestKey(SLOT), chunkKey(SLOT, 0), chunkKey(SLOT, 12)])
      for (const quotes of [0, 100])
        for (const size of [QUOTA_BYTES_PER_ITEM, QUOTA_BYTES_PER_ITEM + 1]) {
          const value = '"'.repeat(quotes) + "a".repeat(size - key.length - 2 - 2 * quotes);
          expect(itemBytes(key, value), `${key} ${quotes} ${size}`).toBe(size);
          const r = await set(p, { [key]: value });
          if (size === QUOTA_BYTES_PER_ITEM) {
            expect(r, `${key} ${quotes}`).toEqual({ ok: true });
            expect(await bytes(p, [key])).toBe(size);
          } else {
            expect(r, `${key} ${quotes}`).toEqual(refused(TEXTS.perItem));
            expect(await bytes(p, null)).toBe(0); // nothing of it written
          }
          await clear(p);
        }
    // every value of the fake's measure: one set, then Chromium's count of each key
    const nums = Object.fromEntries(NUMBERS.map((n, i) => [`n${i}`, n]));
    const other = { t: true, f: false, z: null, o: { b: 1, a: "x<" }, arr: [1, "é", [null]], e: {}, ea: [] };
    expect(
      await sw(p).evaluate(
        async ([strings, values]) => {
          const s = Object.fromEntries(strings.map(([k, codes]) => [`s.${k}`, String.fromCharCode(...codes)]));
          await chrome.storage.sync.set({ ...s, ...values });
          return "written";
        },
        [STRINGS, { ...nums, ...other }] as const,
      ),
    ).toBe("written");
    const counted: Record<string, [number, number]> = {};
    const stored = await all(p);
    for (const [k, v] of Object.entries(stored)) counted[k] = [await bytes(p, [k]), chromiumItemBytes(k, v)];
    for (const [k, [chrome, fake]] of Object.entries(counted)) expect(fake, k).toBe(chrome);
    expect(Object.keys(counted)).toHaveLength(STRINGS.length + NUMBERS.length + Object.keys(other).length);
    // what the measure says of the characters a chunk's alphabet leaves out (slots.ts): `<` takes 6, a lone surrogate 3
    expect(counted["s.lt"]![0] - "s.lt".length).toBe(8);
    expect(counted["s.lone"]![0] - "s.lone".length).toBe(5);
    expect(counted["s.del"]![0] - "s.del".length).toBe(3);
    // the numbers as stored: what was set (the double's form is the count's business only)
    expect(NUMBERS.map((_, i) => stored[`n${i}`])).toEqual(NUMBERS);
    // a key asked twice is counted twice (csb-area.ts bytesInUse asks for each once), as the fake counts it
    const twice = await bytes(p, ["n14", "n14"]);
    expect(twice).toBe(2 * (await bytes(p, ["n14"])));
    expect(await new FakeSyncArea({ items: { n14: NUMBERS[14] } }).getBytesInUse(["n14", "n14"])).toBe(twice);
    // -0, set in the worker itself, is kept as the integer 0 (1 byte), as the fake keeps it
    expect(
      await sw(p).evaluate(async () => {
        await chrome.storage.sync.set({ nz: -0 });
        return [
          await chrome.storage.sync.getBytesInUse(["nz"]),
          Object.is((await chrome.storage.sync.get("nz")).nz, -0),
        ];
      }),
    ).toEqual([3, false]);
    expect(chromiumItemBytes("nz", -0)).toBe(3);
    await clear(p);
    // a manifest: itemBytes is Chromium's count, its time a double with ".0" or in its exponent form
    const times = [
      0,
      7,
      2 ** 31 - 1,
      2 ** 31,
      999_999_999_999,
      1e12,
      1e12 + 1,
      T0,
      1_793_379_341_961,
      1.5,
      1e-6,
      1e-7,
      1e21,
    ];
    const manifests = Object.fromEntries(
      times.map((t, i): [string, SlotManifest] => [
        manifestKey(`aaaaaa${String(i).padStart(2, "0")}`),
        { v: 1, g: "0123456789abcdef", n: 12, z: 92_000, h: `${"A".repeat(43)}=`, t },
      ]),
    );
    expect(await set(p, manifests)).toEqual({ ok: true });
    for (const [k, m] of Object.entries(manifests)) expect(await bytes(p, [k]), String(m.t)).toBe(itemBytes(k, m));
    expect(await bytes(p, null)).toBe(Object.entries(manifests).reduce((a, [k, m]) => a + itemBytes(k, m)!, 0));
  } finally {
    await close(p);
  }
});

test("the refusals: Chromium's exact texts, the area's limit to the byte, and a refused set writes none of its items", async () => {
  test.setTimeout(120_000);
  const p = await launch();
  try {
    // the texts csb-area.ts tells apart are Chromium's, and so are the fake's
    expect([...REFUSALS.keys()].sort()).toEqual(Object.values(TEXTS).sort());
    // 102,400 bytes are taken: twelve items of 8,192 and one of 4,096
    const fill: Record<string, string> = {};
    for (let i = 0; i < 12; i++) fill[`f${String(i).padStart(2, "0")}`] = "a".repeat(8192 - 3 - 2);
    fill.last = "a".repeat(4096 - 4 - 2);
    expect(await set(p, fill)).toEqual({ ok: true });
    expect(await bytes(p, null)).toBe(QUOTA_BYTES);
    // one byte more is refused, and the area is as it was
    const over = await set(p, { last: "a".repeat(4097 - 4 - 2) });
    expect(over).toEqual(refused(TEXTS.bytes));
    expect(refusalOf(new Error((over as { message: string }).message))).toMatchObject({
      refusal: "QUOTA_BYTES",
      error: "no_room",
    });
    expect([await bytes(p, null), ((await all(p)).last as string).length]).toEqual([QUOTA_BYTES, 4090]);
    // a set of several items, one shrinking, one new, over the area in all: none of them written
    const several = await set(p, { f00: "b", g: "a".repeat(8191 - 1 - 2) });
    expect(several).toEqual(refused(TEXTS.bytes));
    expect([await bytes(p, null), ((await all(p)).f00 as string).length, "g" in (await all(p))]).toEqual([
      QUOTA_BYTES,
      8187,
      false,
    ]);
    // an item over its own limit in a full area: the item's quota is checked first
    expect(await set(p, { big: "a".repeat(9000) })).toEqual(refused(TEXTS.perItem));
    await clear(p);
    // MAX_ITEMS: 512 items are taken, 513 refused and none written
    const n = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`i${i}`, 0]));
    expect(await set(p, n(512))).toEqual({ ok: true });
    await clear(p);
    const items = await set(p, n(513));
    expect(items).toEqual(refused(TEXTS.items));
    expect(await bytes(p, null)).toBe(0);
    for (const o of [over, items, refused(TEXTS.perItem)])
      expect(refusalOf(new Error((o as { message: string }).message)).refusal).not.toBe("other");
  } finally {
    await close(p);
  }
});

async function backup(accounts: number, seq: number) {
  const keys = await protectedKeys();
  const list = Array.from({ length: accounts }, (_, i) =>
    account(`Issuer number ${i}`, "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"),
  );
  return makeCloudBackup(
    await seal(keys, vaultOf(keys.keyring.vaultId, list), seq, 1_793_379_341_961 + seq),
    "both",
    "Sixkey 0.1.0",
  );
}

test("a whole plan in one set: getBytesInUse(null) is its bytes; a shrink's set leaves what room() assumes, and its remove the smaller slot's bytes", async () => {
  test.setTimeout(120_000);
  const big = await planSlot(await backup(200, 7), SLOT, "0123456789abcdef");
  const small = await planSlot(await backup(30, 8), SLOT, "fedcba9876543210");
  if (big.kind !== "plan" || small.kind !== "plan") throw new Error("too large");
  expect([big.manifest.n, small.manifest.n]).toEqual([11, 2]);
  const p = await launch();
  try {
    expect(await set(p, big.items)).toEqual({ ok: true });
    const area = await all(p);
    expect(area).toEqual(big.items);
    expect(await assembleSlot(area, SLOT)).toMatchObject({ kind: "ok", manifest: big.manifest });
    for (const k of Object.keys(big.items)) expect(await bytes(p, [k]), k).toBe(itemBytes(k, big.items[k]));
    const inUse = await bytes(p, null);
    expect(inUse).toBe(big.bytes);
    // the shrink: room's verdict, and Chrome's count after the set (the leftovers still there) as room assumes it
    expect(room(small as SlotPlan, area, inUse)).toEqual({ kind: "ok" });
    const freed = Object.keys(small.items).reduce((a, k) => a + (k in area ? itemBytes(k, area[k])! : 0), 0);
    expect(await set(p, small.items)).toEqual({ ok: true });
    expect(await bytes(p, null)).toBe(inUse - freed + small.bytes);
    const gone = leftovers(await all(p), SLOT, small.manifest.n);
    expect(gone).toEqual(Array.from({ length: 9 }, (_, i) => chunkKey(SLOT, i + 2)));
    expect(await call(p, "remove", gone)).toEqual({ ok: true });
    expect(await bytes(p, null)).toBe(small.bytes);
    expect(await all(p)).toEqual(small.items);
  } finally {
    await close(p);
  }
});

test("write operations: set and remove are counted apart, 120 calls a minute each, and a clear apart from both; a set refused for its bytes counts; local writes and reads count nothing", async () => {
  test.setTimeout(120_000);
  const p = await launch();
  try {
    const r = await sw(p).evaluate(async () => {
      const s = chrome.storage.sync;
      const tried = async (f: () => Promise<unknown>) => {
        try {
          await f();
          return "ok";
        } catch (e) {
          return (e as Error).message;
        }
      };
      for (let i = 0; i < 200; i++) await chrome.storage.local.set({ [`sk_probe_${i}`]: i });
      const sets: string[] = [];
      for (let i = 0; i < 10; i++) sets.push(await tried(() => s.set({ big: "a".repeat(9000) })));
      for (let i = 10; i < 120; i++) {
        sets.push(await tried(() => s.set({ [`w${i}`]: i })));
        await s.get(null);
        await s.getBytesInUse(null);
      }
      const set121 = await tried(() => s.set({ w: 1 }));
      const removes: string[] = [];
      for (let i = 0; i < 120; i++) removes.push(await tried(() => s.remove([`w${i}`])));
      const remove121 = await tried(() => s.remove(["w"]));
      const clear = await tried(() => s.clear());
      const local = await tried(() => chrome.storage.local.set({ sk_probe: 1 }));
      const read = await tried(() => s.get(null));
      return { sets, set121, removes, remove121, clear, local, read };
    });
    expect(r.sets.slice(0, 10)).toEqual(Array(10).fill(TEXTS.perItem));
    expect(r.sets.slice(10)).toEqual(Array(110).fill("ok"));
    expect(r.set121).toBe(TEXTS.minute);
    expect(r.removes).toEqual(Array(120).fill("ok"));
    expect(r.remove121).toBe(TEXTS.minute);
    expect([r.clear, r.local, r.read]).toEqual(["ok", "ok", "ok"]);
    expect(refusalOf(new Error(r.set121))).toEqual({
      ok: false,
      refusal: "MAX_WRITE_OPERATIONS_PER_MINUTE",
      error: "busy",
      message: TEXTS.minute,
    });
  } finally {
    await close(p);
  }
});

test("the maintainers' C7: the worker's start closes storage.sync; opened, a content script reads and writes it; setAccessLevel(TRUSTED_CONTEXTS) is accepted and refuses its reads, writes and onChanged, the worker and the pages going on; every start closes it", async () => {
  test.setTimeout(180_000);
  const dir = mkdtempSync(join(tmpdir(), "sixkey-e2e-"));
  const PAGE = "http://granted.fix.test/csb-probe"; // a host the e2e build holds (manifest.e2e.json), served here
  const serve = (p: Profile) =>
    p.ctx.route("http://granted.fix.test/**", (r) =>
      r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>probe</title><p>probe</p>" }),
    );
  /** What a content script (Sixkey's isolated world in a web page) gets of storage.sync. */
  const contentScript = async (p: Profile) => {
    const tab = await p.ctx.newPage();
    await tab.goto(PAGE);
    const r = await sw(p).evaluate(async (url) => {
      const [t] = await chrome.tabs.query({ url });
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: t!.id! },
        world: "ISOLATED",
        func: async () => {
          const tried = async (f: () => Promise<unknown>) => {
            try {
              const v = await f();
              return v === undefined ? "done" : JSON.stringify(v);
            } catch (e) {
              return `refused: ${(e as Error).message}`;
            }
          };
          const s = chrome.storage.sync;
          return {
            api: typeof s,
            get: await tried(() => s.get(null)),
            bytes: await tried(() => s.getBytesInUse(null)),
            set: await tried(() => s.set({ "bk1.zzzz9999": "from a page" })),
            remove: await tried(() => s.remove(["bk1.zzzz9999"])),
          };
        },
      });
      return res?.result;
    }, PAGE);
    await tab.close();
    return r;
  };
  /** In the tab at `url`, Sixkey's isolated world: listen to storage.onChanged and storage.sync.onChanged, or collect. */
  const inTab = (p: Profile, url: string, what: "listen" | "collect") =>
    sw(p).evaluate(
      async ([url, what]) => {
        const [t] = await chrome.tabs.query({ url });
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: t!.id! },
          world: "ISOLATED",
          args: [what],
          func: (w: string) => {
            const g = globalThis as unknown as { seen?: unknown[] };
            if (w === "collect") return g.seen ?? null;
            g.seen = [];
            try {
              chrome.storage.onChanged.addListener((c, area) => g.seen!.push({ area, changes: c }));
              chrome.storage.sync.onChanged.addListener((c) => g.seen!.push({ sync: c }));
              return "listening";
            } catch (e) {
              return `threw: ${(e as Error).message}`;
            }
          },
        });
        return res?.result as unknown;
      },
      [url, what] as const,
    );
  const REFUSED = "refused: Access to storage is not allowed from this context.";
  const closed = { api: "object", get: REFUSED, bytes: REFUSED, set: REFUSED, remove: REFUSED };
  /** The worker sets storage.sync's level (the probe's own call: the area's default to open it, or the backup's). */
  const level = (p: Profile, accessLevel: "TRUSTED_CONTEXTS" | "TRUSTED_AND_UNTRUSTED_CONTEXTS") =>
    sw(p).evaluate(async (l) => {
      const area = chrome.storage.sync as unknown as { setAccessLevel(o: { accessLevel: string }): Promise<void> };
      await area.setAccessLevel({ accessLevel: l });
      return "accepted";
    }, accessLevel);
  let p = await launch(dir);
  try {
    await grantScripting(p);
    await serve(p);
    expect(await set(p, { [chunkKey(SLOT, 0)]: "the copy" })).toEqual({ ok: true });
    // the worker's start closed it already (CSB-3: background/storage-access-first.ts restrictSyncAccess)
    expect(await contentScript(p)).toEqual(closed);
    // opened again, at the area's default level: a content script reads the area, and could write and delete in it
    expect(await level(p, "TRUSTED_AND_UNTRUSTED_CONTEXTS")).toBe("accepted");
    expect(await contentScript(p)).toEqual({
      api: "object",
      get: JSON.stringify({ [chunkKey(SLOT, 0)]: "the copy" }),
      bytes: String(chunkKey(SLOT, 0).length + 10),
      set: "done",
      remove: "done",
    });
    // and its onChanged listeners get every change with its values
    const ONE = `${PAGE}-1`;
    const TWO = `${PAGE}-2`;
    const tab1 = await p.ctx.newPage();
    await tab1.goto(ONE);
    expect(await inTab(p, ONE, "listen")).toBe("listening");
    expect(await set(p, { [chunkKey(SLOT, 0)]: "before" })).toEqual({ ok: true });
    const before = { [chunkKey(SLOT, 0)]: { oldValue: "the copy", newValue: "before" } };
    await expect
      .poll(() => inTab(p, ONE, "collect"))
      .toEqual(expect.arrayContaining([{ area: "sync", changes: before }, { sync: before }]));
    expect(await inTab(p, ONE, "collect")).toHaveLength(2);
    // the call restrict() makes (storage-access.ts restrictSyncAccess), from the worker: accepted, twice
    expect(await level(p, "TRUSTED_CONTEXTS")).toBe("accepted");
    expect(await level(p, "TRUSTED_CONTEXTS")).toBe("accepted");
    expect(await contentScript(p)).toEqual(closed);
    // the worker still writes, removes and reads; the listener added before gets nothing more, nor one added now (its
    // addListener does not throw)
    expect(await set(p, { [chunkKey(SLOT, 0)]: "after, the old listener" })).toEqual({ ok: true });
    const tab2 = await p.ctx.newPage();
    await tab2.goto(TWO);
    expect(await inTab(p, TWO, "listen")).toBe("listening");
    expect(await set(p, { [chunkKey(SLOT, 0)]: "after, a new listener", [chunkKey(SLOT, 1)]: "x" })).toEqual({
      ok: true,
    });
    expect(await call(p, "remove", [chunkKey(SLOT, 1)])).toEqual({ ok: true });
    expect(await all(p)).toEqual({ [chunkKey(SLOT, 0)]: "after, a new listener" });
    await tab2.waitForTimeout(800);
    expect(await inTab(p, TWO, "collect")).toEqual([]);
    expect(await inTab(p, ONE, "collect")).toEqual(
      expect.arrayContaining([{ area: "sync", changes: before }, { sync: before }]),
    );
    expect(await inTab(p, ONE, "collect")).toHaveLength(2);
    await tab1.close();
    await tab2.close();
    // the extension's own pages still read it
    const page = await openOptions(p);
    expect(await page.evaluate(() => chrome.storage.sync.get(null))).toEqual({
      [chunkKey(SLOT, 0)]: "after, a new listener",
    });
    await page.close();
    // after a restart, opened again before it: the new worker's start closes it (whether the level alone outlives a
    // restart, which CSB-2 showed with no call at the start, cannot be told apart any more: every start makes the call)
    expect(await level(p, "TRUSTED_AND_UNTRUSTED_CONTEXTS")).toBe("accepted");
    await close(p, false);
    p = await launch(dir);
    await serve(p);
    expect(await contentScript(p)).toEqual(closed);
  } finally {
    await close(p);
    rmSync(dir, { recursive: true, force: true });
  }
});
