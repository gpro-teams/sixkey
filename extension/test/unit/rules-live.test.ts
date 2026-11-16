// The site rules' updater (TOTP autofill Stage 3, AF3-U2; docs/design/notes/AUTOFILL3-NOTES.md §10): its one network read
// (src/platform/rules-fetch.ts getCapped: every field of the request, the time limit, the byte cap, one attempt) and the
// worker's updater (src/platform/rules-live.ts createUpdater) over a real IndexedDB (fake-indexeddb), the real signed
// manifest's checks and format's checker, and a rules server played by a stub of fetch: the switch (off by default; on
// checks at once; off deletes the bundle and keeps the floor; the record ignored while off: S8), the cadence (sk-daily:
// 24 hours plus a random 0 to 6, one attempt), the record (each refusal leaves it as it was; expiry; succession), the
// switch turned off while a bundle is on its way (§9.8), and the three answers a Fill path gets (none in use; the live
// bundle's rule; the live bundle has none for the host, C24). Round 2 (the review's S2, N2): off writes the switch and the
// record in one transaction; an answer's write-back reads the record again in its own; a release that reaches the
// record's version shows no floor; a due time set while the clock was ahead does not stop the checks.
import "fake-indexeddb/auto";
import { IDBDatabase as FDatabase, IDBFactory, IDBObjectStore as FStore } from "fake-indexeddb";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FETCH_MS, getCapped, REQUEST } from "../../src/platform/rules-fetch";
import {
  createUpdater,
  DATABASE,
  DAY_MS,
  JITTER_MS,
  SWITCH_KEY,
  type Updater,
  type UpdaterDeps,
} from "../../src/platform/rules-live";
import { bundleBytes, liveBundle, newKey, pinnedOf, signedManifest, type Key } from "../helpers/rules-live-kit";

const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);
const ORIGIN = "https://rules.example.net";
const HOST = "login.example.com";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- the rules server, as a stub of fetch ---------------------------------------------------------------------------
type Reply = { status?: number; body?: Uint8Array | string; hold?: Promise<void> } | "throw";
type Server = { files: Map<string, Reply>; asked: { url: string; init: RequestInit }[]; get: typeof fetch };
function server(): Server {
  const files = new Map<string, Reply>();
  const asked: Server["asked"] = [];
  const get = (async (url: string, init: RequestInit) => {
    asked.push({ url, init });
    const r = files.get(url) ?? { status: 404, body: "not found" };
    if (r === "throw") throw new TypeError("Failed to fetch"); // what a CORS refusal or a network error looks like
    if (r.hold) await r.hold;
    const body = typeof r.body === "string" ? new TextEncoder().encode(r.body) : (r.body ?? new Uint8Array());
    return new Response(body as Uint8Array<ArrayBuffer>, { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { files, asked, get };
}

let A: Key, B: Key, X: Key;
beforeAll(async () => {
  [A, B, X] = [await newKey(), await newKey(), await newKey()];
});

type World = { u: Updater; srv: Server; idb: IDBFactory; clock: { now: number }; dice: { r: number } };
function world(o: Partial<UpdaterDeps> = {}): World {
  const srv = server();
  const idb = new IDBFactory();
  const clock = { now: T0 };
  const dice = { r: 0 };
  const u = createUpdater({
    idb,
    get: srv.get,
    now: () => clock.now,
    random: () => dice.r,
    keys: [pinnedOf(A), pinnedOf(B)],
    origin: ORIGIN,
    baseline: 1,
    allowReserved: false,
    ...o,
  });
  return { u, srv, idb, clock, dice };
}
/** Publish bundle `b` on the world's server, its manifest signed by `key` at the world's time (`o` as signedManifest). */
async function publish(
  w: World,
  key: Key,
  b: Record<string, unknown>,
  o: Omit<Parameters<typeof signedManifest>[3], "now"> & { now?: number; bytes?: Uint8Array } = {},
) {
  const bytes = bundleBytes(b);
  const file = await signedManifest(key, bytes, b, { now: w.clock.now, ...o });
  w.srv.files.set(`${ORIGIN}/v1/manifest.json`, { body: file });
  w.srv.files.set(`${ORIGIN}/v1/bundle-${b.version as number}.json`, { body: o.bytes ?? bytes });
}
/** The database's content, read as a page never does (the test reads it directly). */
async function stored(idb: IDBFactory): Promise<Record<string, unknown>> {
  const db = await new Promise<IDBDatabase>((ok, no) => {
    const r = idb.open(DATABASE, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
  const t = db.transaction("kv", "readonly");
  const s = t.objectStore("kv");
  const keys = await new Promise<IDBValidKey[]>((ok) => {
    const r = s.getAllKeys();
    r.onsuccess = () => ok(r.result);
  });
  const out: Record<string, unknown> = {};
  for (const k of keys)
    out[String(k)] = await new Promise((ok) => {
      const r = s.get(k);
      r.onsuccess = () => ok(r.result);
    });
  db.close();
  return out;
}
async function put(idb: IDBFactory, items: Record<string, unknown>) {
  const db = await new Promise<IDBDatabase>((ok, no) => {
    const r = idb.open(DATABASE, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
  const t = db.transaction("kv", "readwrite");
  for (const [k, v] of Object.entries(items)) t.objectStore("kv").put(v, k);
  await new Promise<void>((ok) => (t.oncomplete = () => ok()));
  db.close();
}
const paths = (w: World) => w.srv.asked.map((a) => a.url.slice(ORIGIN.length));
const ruleOf = (field: string) => ({ pages: [{ path: "/2fa", field, segments: 0, fill: "auto" }] });

// ---- the read ---------------------------------------------------------------------------------------------------------
describe("the one read of the rules origin (rules-fetch.ts getCapped)", () => {
  it("asks exactly this: GET, no credentials, no referrer, no redirect, no cache, Accept-Language *, a 20 s signal", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const got: RequestInit[] = [];
    const get = (async (_u: string, init: RequestInit) => {
      got.push(init);
      return new Response("ok");
    }) as unknown as typeof fetch;
    expect(await getCapped(`${ORIGIN}/v1/manifest.json`, 4096, get)).toEqual(new TextEncoder().encode("ok"));
    expect(FETCH_MS).toBe(20_000);
    expect(timeout).toHaveBeenCalledWith(20_000);
    expect(got).toHaveLength(1);
    const { signal, ...rest } = got[0]!;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(rest).toEqual({
      method: "GET",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
      cache: "no-store",
      headers: { "Accept-Language": "*" },
    });
    expect(REQUEST).toEqual(rest);
  });
  it("one attempt: a failed read (network, CORS, a redirect refused) is null and not tried again", async () => {
    let n = 0;
    const get = (async () => {
      n++;
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await getCapped(`${ORIGIN}/v1/manifest.json`, 4096, get)).toBeNull();
    expect(n).toBe(1);
  });
  it("only a 200 is a file: 204, 301, 304, 404 and 500 are null", async () => {
    for (const status of [204, 301, 304, 404, 500]) {
      const get = (async () =>
        new Response(status === 204 || status === 304 ? null : "x", {
          status,
          ...(status === 301 ? { headers: { location: "/" } } : {}),
        })) as unknown as typeof fetch;
      expect(await getCapped(`${ORIGIN}/v1/manifest.json`, 4096, get), String(status)).toBeNull();
    }
  });
  it("the byte cap: exactly the cap is read; one byte more is null, and the read is cancelled there", async () => {
    const chunked = (sizes: number[], pulled: { n: number; cancelled: boolean }) =>
      (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              const s = sizes[pulled.n++];
              if (s === undefined) c.close();
              else c.enqueue(new Uint8Array(s));
            },
            cancel() {
              pulled.cancelled = true;
            },
          }),
        )) as unknown as typeof fetch;
    const p1 = { n: 0, cancelled: false };
    expect((await getCapped("u", 4096, chunked([2048, 2048], p1)))?.length).toBe(4096);
    const p2 = { n: 0, cancelled: false };
    expect(await getCapped("u", 4096, chunked([2048, 2049, 4096, 4096], p2))).toBeNull();
    expect(p2.cancelled).toBe(true);
    expect(p2.n).toBeLessThanOrEqual(3); // nothing after the chunk past the cap is asked for
    const p3 = { n: 0, cancelled: false };
    expect((await getCapped("u", 512 * 1024, chunked(Array(8).fill(64 * 1024), p3)))?.length).toBe(512 * 1024);
    const p4 = { n: 0, cancelled: false };
    expect(await getCapped("u", 512 * 1024, chunked([...Array(8).fill(64 * 1024), 1], p4))).toBeNull();
  });
  it("the time limit covers the body: a body that stops half way ends when the signal fires, as null", async () => {
    const ctl = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(ctl.signal);
    const get = (async (_u: string, init: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array(10));
            init.signal!.addEventListener("abort", () => c.error(new DOMException("timed out", "TimeoutError")));
          },
        }),
      )) as unknown as typeof fetch;
    const read = getCapped("u", 4096, get);
    setTimeout(() => ctl.abort(), 20);
    expect(await read).toBeNull();
  });
});

// ---- the updater ------------------------------------------------------------------------------------------------------
describe("the switch", () => {
  it("is off until turned on: no check reads anything, no answer, the built-in rules in the status", async () => {
    const w = world();
    await publish(w, A, liveBundle(2));
    expect(await w.u.check(true)).toBe("off");
    expect(await w.u.check()).toBe("off");
    expect(await w.u.answer(HOST)).toBeNull();
    expect(await w.u.status()).toEqual({
      on: false,
      v: null,
      got: null,
      base: 1,
      floor: null,
      host: "rules.example.net",
    });
    expect(w.srv.asked).toEqual([]);
  });
  it("on: a check at once, the manifest first, then the bundle it names; the bundle is in use and the status says when", async () => {
    const w = world();
    await publish(w, A, liveBundle(2));
    const s = await w.u.status(true);
    expect(paths(w)).toEqual(["/v1/manifest.json", "/v1/bundle-2.json"]);
    expect(s).toEqual({ on: true, v: 2, got: T0, base: 1, floor: null, host: "rules.example.net" });
    const db = await stored(w.idb);
    expect(db[SWITCH_KEY]).toBe(true);
    expect(db.record).toMatchObject({ kid: A.kid, version: 2, retired: [] });
  });
  it("the three answers: the live bundle's rule; none for a host it does not name (C24); null with no bundle in use", async () => {
    const w = world();
    await publish(w, A, liveBundle(2, { a: ruleOf("input#live") }, { [HOST]: "a" }));
    expect(await w.u.answer(HOST)).toBeNull(); // off: nothing in use
    await w.u.status(true);
    const a = await w.u.answer(HOST);
    expect(a).toEqual({
      v: 2,
      rule: {
        id: "a",
        host: HOST,
        from: "live",
        rule: { pages: [{ path: "/2fa", field: "input#live", segments: 0, fill: "auto" }], sent: false, minLeft: null },
      },
    });
    // a host the live bundle does not name: a live answer with no rule, not null (the Fill path must not take the
    // package's rule for it: the live bundle replaces the built-in rules whole)
    expect(await w.u.answer("other.example.com")).toEqual({ v: 2, rule: null });
    expect(await w.u.answer("www.login.example.com")).toEqual({ v: 2, rule: null });
  });
  it("off: the bundle goes in the same click, the floor and the retired keys stay; on again waits for a newer version", async () => {
    const w = world();
    await publish(w, B, liveBundle(2)); // signed by the later key: A is retired on this client
    await w.u.status(true);
    expect((await stored(w.idb)).record).toMatchObject({ kid: B.kid, version: 2, retired: [A.kid] });
    const off = await w.u.status(false);
    expect(off).toEqual({ on: false, v: null, got: null, base: 1, floor: null, host: "rules.example.net" });
    const db = await stored(w.idb);
    expect(db.record).toEqual({ kid: B.kid, version: 2, retired: [A.kid], held: null });
    expect(db.got).toBeUndefined();
    expect(await w.u.answer(HOST)).toBeNull();
    // on again: the same version is not above the floor: no bundle, and the status says what it waits for
    w.srv.asked.length = 0;
    const on = await w.u.status(true);
    expect(paths(w)).toEqual(["/v1/manifest.json"]);
    expect(on).toEqual({ on: true, v: null, got: null, base: 1, floor: 2, host: "rules.example.net" });
    expect(await w.u.answer(HOST)).toBeNull();
    // and a retired key's bundle is still refused
    await publish(w, A, liveBundle(3));
    expect(await w.u.check(true)).toBe("manifest");
    // a newer one of the record's key is taken
    await publish(w, B, liveBundle(3));
    expect(await w.u.check(true)).toBe("new");
    expect(await w.u.status()).toMatchObject({ on: true, v: 3, floor: null });
  });
  it("S8: a record holding a bundle is not used while the switch is off, whatever it holds", async () => {
    const w = world();
    await publish(w, A, liveBundle(2));
    await w.u.status(true);
    const record = (await stored(w.idb)).record;
    // the switch off with the bundle still in the record (as a write cut short could leave it): nothing is used
    await put(w.idb, { [SWITCH_KEY]: false, record });
    const fresh = createUpdater({
      idb: w.idb,
      get: w.srv.get,
      now: () => T0,
      random: () => 0,
      keys: [pinnedOf(A), pinnedOf(B)],
      origin: ORIGIN,
      baseline: 1,
      allowReserved: false,
    });
    expect(await fresh.answer(HOST)).toBeNull();
    expect(await fresh.status()).toMatchObject({ on: false, v: null, got: null });
    expect(await fresh.check()).toBe("off");
  });
});

describe("the daily check (sk-daily)", () => {
  it("is due 24 hours after the last one plus a random 0 to 6 hours; before that it reads nothing", async () => {
    for (const r of [0, 0.5, 0.999999]) {
      const w = world();
      w.dice.r = r;
      await publish(w, A, liveBundle(2));
      await w.u.status(true);
      const due = T0 + DAY_MS + Math.floor(r * JITTER_MS);
      expect((await stored(w.idb)).due, String(r)).toBe(due);
      expect(JITTER_MS).toBe(6 * 3_600_000);
      w.srv.asked.length = 0;
      w.clock.now = due - 1;
      expect(await w.u.check()).toBe("later");
      expect(w.srv.asked).toEqual([]);
      w.clock.now = due;
      expect(await w.u.check()).toBe("same"); // the same version: the usual answer, the bundle not fetched
      expect(paths(w)).toEqual(["/v1/manifest.json"]);
    }
  });
  it("one attempt: a read that fails waits for the next due time too", async () => {
    const w = world();
    await w.u.status(true); // nothing published: the manifest is a 404
    expect(paths(w)).toEqual(["/v1/manifest.json"]);
    expect(await w.u.check()).toBe("later");
    w.srv.files.set(`${ORIGIN}/v1/manifest.json`, "throw");
    w.clock.now = T0 + DAY_MS;
    expect(await w.u.check()).toBe("net");
    expect(await w.u.check()).toBe("later");
    expect(paths(w)).toEqual(["/v1/manifest.json", "/v1/manifest.json"]);
  });
  it("a newer version is fetched and taken; the answer follows it", async () => {
    const w = world();
    await publish(w, A, liveBundle(2, { a: ruleOf("input#two") }, { [HOST]: "a" }));
    await w.u.status(true);
    await publish(w, A, liveBundle(3, { b: ruleOf("input#three") }, { [HOST]: "b" }));
    w.clock.now = T0 + 2 * DAY_MS;
    expect(await w.u.check()).toBe("new");
    expect((await w.u.answer(HOST))?.rule?.rule.pages[0]?.field).toBe("input#three");
    expect(await w.u.status()).toMatchObject({ v: 3, got: T0 + 2 * DAY_MS });
  });
  it("checks run one after another: a second asked while one waits starts after it", async () => {
    const w = world();
    await publish(w, A, liveBundle(2));
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const file = w.srv.files.get(`${ORIGIN}/v1/manifest.json`) as { body: string };
    w.srv.files.set(`${ORIGIN}/v1/manifest.json`, { body: file.body, hold });
    await put(w.idb, { [SWITCH_KEY]: true });
    const one = w.u.check(true);
    const two = w.u.check(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(paths(w)).toEqual(["/v1/manifest.json"]);
    release();
    expect(await one).toBe("new");
    expect(await two).toBe("same");
  });
});

describe("what is refused leaves the record as it was", () => {
  const cases: [string, (w: World) => Promise<void>, string][] = [
    ["a manifest signed by a key the build does not pin", (w) => publish(w, X, liveBundle(3)), "manifest"],
    [
      "a manifest claiming a pinned key's id, signed by another",
      (w) => publish(w, X, liveBundle(3), { kid: A.kid }),
      "manifest",
    ],
    ["a version not above the built-in rules'", (w) => publish(w, A, liveBundle(1)), "same"],
    ["a version more than 1,000 above them", (w) => publish(w, A, liveBundle(1002)), "manifest"],
    [
      "a manifest made more than a day ahead of this clock",
      (w) => publish(w, A, liveBundle(3), { now: T0 + 3 * DAY_MS }),
      "manifest",
    ],
    ["a manifest valid for more than 180 days", (w) => publish(w, A, liveBundle(3), { days: 181 }), "manifest"],
    [
      "a bundle that is not the manifest's (another byte)",
      async (w) => {
        const b = liveBundle(3);
        const bytes = bundleBytes(b);
        const other = bundleBytes({ ...b, created: "2026-11-05" });
        await publish(w, A, b, { bytes: other.length === bytes.length ? other : bytes.slice().fill(32, 0, 1) });
      },
      "bundle",
    ],
    [
      "a live bundle with alias groups (M1)",
      (w) => publish(w, A, liveBundle(3, undefined, undefined, { aliases: [] })),
      "bundle",
    ],
    [
      "a live bundle with appends (M1)",
      (w) => publish(w, A, liveBundle(3, undefined, undefined, { appends: [] })),
      "bundle",
    ],
    [
      "a live bundle naming a reserved test host",
      (w) => publish(w, A, liveBundle(3, undefined, { "live.fix.test": "a" })),
      "bundle",
    ],
    [
      "a rule with a selector the grammar refuses",
      (w) => publish(w, A, liveBundle(3, { a: ruleOf("input:has(b)") })),
      "bundle",
    ],
  ];
  for (const [what, serve, outcome] of cases)
    it(what, async () => {
      const w = world();
      await publish(w, A, liveBundle(2));
      await w.u.status(true);
      const before = await stored(w.idb);
      await serve(w);
      w.clock.now = T0 + DAY_MS + JITTER_MS;
      expect(await w.u.check(), what).toBe(outcome);
      expect(await stored(w.idb)).toEqual({ ...before, due: w.clock.now + DAY_MS });
      expect((await w.u.answer(HOST))?.v).toBe(2);
    });
  it("the e2e build's checker takes its reserved test hosts (allowReserved), as its reader does", async () => {
    const w = world({ allowReserved: true });
    await publish(w, A, liveBundle(2, undefined, { "live.fix.test": "a" }));
    await w.u.status(true);
    expect((await w.u.answer("live.fix.test"))?.rule?.id).toBe("a");
  });
  it("no pinned key can be imported: nothing is read, written or answered (signed.ts's functions get good keys only)", async () => {
    for (const keys of [[], [{ kid: A.kid, spki: B.spki }], "x"]) {
      const w = world({ keys });
      await publish(w, A, liveBundle(2));
      const record = { kid: A.kid, version: 5, retired: [], held: null };
      await put(w.idb, { [SWITCH_KEY]: true, record });
      expect(await w.u.check(true), JSON.stringify(keys)).toBe("keys");
      expect(await w.u.answer(HOST)).toBeNull();
      expect(w.srv.asked).toEqual([]);
      expect((await stored(w.idb)).record).toEqual(record);
    }
  });
});

describe("the record at a read", () => {
  it("expiry: the bundle is gone at the instant it expires, its floor stays", async () => {
    const w = world();
    await publish(w, A, liveBundle(2), { days: 10 });
    await w.u.status(true);
    w.clock.now = T0 + 10 * DAY_MS - 1;
    expect((await w.u.answer(HOST))?.v).toBe(2);
    w.clock.now = T0 + 10 * DAY_MS;
    expect(await w.u.answer(HOST)).toBeNull();
    expect((await stored(w.idb)).record).toEqual({ kid: A.kid, version: 2, retired: [], held: null });
    expect(await w.u.status()).toMatchObject({ v: null, floor: 2 });
  });
  it("a release whose built-in rules reach the bundle's version: the built-in rules (the bundle deleted, the floor kept)", async () => {
    const w = world();
    await publish(w, A, liveBundle(2));
    await w.u.status(true);
    const later = createUpdater({
      idb: w.idb,
      get: w.srv.get,
      now: () => T0,
      random: () => 0,
      keys: [pinnedOf(A), pinnedOf(B)],
      origin: ORIGIN,
      baseline: 2,
      allowReserved: false,
    });
    expect(await later.answer(HOST)).toBeNull();
    expect((await stored(w.idb)).record).toMatchObject({ version: 2, held: null });
  });
  it("§9.8: the switch turned off while the bundle is on its way: the record holding it is never written", async () => {
    const w = world();
    await publish(w, A, liveBundle(2));
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const b = w.srv.files.get(`${ORIGIN}/v1/bundle-2.json`) as { body: Uint8Array };
    w.srv.files.set(`${ORIGIN}/v1/bundle-2.json`, { body: b.body, hold });
    await put(w.idb, { [SWITCH_KEY]: true });
    const checking = w.u.check(true);
    await vi.waitFor(() => expect(paths(w)).toEqual(["/v1/manifest.json", "/v1/bundle-2.json"]));
    await w.u.status(false);
    release();
    expect(await checking).toBe("off");
    const db = await stored(w.idb);
    expect(db[SWITCH_KEY]).toBe(false);
    expect(db.record).toBeUndefined();
    expect(db.got).toBeUndefined();
  });
});

describe("round 2: what the review's probes pin (S2), and a clock that was ahead (N2)", () => {
  it("off writes the switch and the record in one transaction (C33; the review's MY3)", async () => {
    const w = world();
    await publish(w, A, liveBundle(2));
    await w.u.status(true);
    const writes: { key: string; tx: unknown }[] = [];
    const put = FStore.prototype.put;
    const del = FStore.prototype.delete;
    vi.spyOn(FStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, v: unknown, k?: IDBValidKey) {
      writes.push({ key: String(k), tx: this.transaction });
      return put.call(this, v, k);
    });
    vi.spyOn(FStore.prototype, "delete").mockImplementation(function (
      this: IDBObjectStore,
      k: IDBValidKey | IDBKeyRange,
    ) {
      writes.push({ key: String(k), tx: this.transaction });
      return del.call(this, k);
    });
    await w.u.status(false);
    const sw = writes.find((x) => x.key === SWITCH_KEY);
    const rec = writes.find((x) => x.key === "record");
    expect(sw).toBeDefined();
    expect(rec).toBeDefined();
    expect(sw!.tx).toBe(rec!.tx);
  });
  it("an answer's write-back reads the record again in its own transaction: a record written just before is kept (the review's MY1)", async () => {
    // the record v3 another check would write (made in a world of its own, 11 days on)
    const w3 = world();
    w3.clock.now = T0 + 11 * DAY_MS;
    await publish(w3, A, liveBundle(3));
    await w3.u.status(true);
    const rec3 = (await stored(w3.idb)).record;
    expect(rec3).toMatchObject({ version: 3 });
    // this browser: v2, valid 10 days; 11 days on, an answer finds it expired and writes the record without its bundle
    const w = world();
    await publish(w, A, liveBundle(2), { days: 10 });
    await w.u.status(true);
    w.clock.now = T0 + 11 * DAY_MS;
    // just before the answer's write-back transaction, another transaction writes v3 (transactions on one store run in
    // the order they are made)
    const tx = FDatabase.prototype.transaction;
    let inject = true;
    vi.spyOn(FDatabase.prototype, "transaction").mockImplementation(function (
      this: IDBDatabase,
      ...a: Parameters<IDBDatabase["transaction"]>
    ) {
      if (a[1] === "readwrite" && inject) {
        inject = false;
        tx.call(this, "kv", "readwrite").objectStore("kv").put(rec3, "record");
      }
      return tx.apply(this, a);
    });
    const answer = await w.u.answer(HOST);
    expect(inject).toBe(false); // the write-back happened, after the injected write
    expect(answer).toBeNull(); // the answer itself was read before v3 arrived
    expect((await stored(w.idb)).record).toEqual(rec3);
  });
  it("a release whose built-in rules reach the record's version shows no floor (the review's MY2)", async () => {
    const w = world();
    await publish(w, A, liveBundle(2));
    await w.u.status(true);
    const later = createUpdater({
      idb: w.idb,
      get: w.srv.get,
      now: () => w.clock.now,
      random: () => 0,
      keys: [pinnedOf(A), pinnedOf(B)],
      origin: ORIGIN,
      baseline: 2,
      allowReserved: false,
    });
    expect(await later.status()).toMatchObject({ on: true, v: null, base: 2, floor: null });
  });
  it("N2: a due time further away than a check can set (the clock was ahead) is due now; one just inside it is not", async () => {
    const w = world();
    await put(w.idb, { [SWITCH_KEY]: true, due: T0 + DAY_MS + JITTER_MS });
    expect(await w.u.check()).toBe("later"); // the farthest a check sets: still waited for
    expect(w.srv.asked).toEqual([]);
    await put(w.idb, { due: T0 + DAY_MS + JITTER_MS + 1 });
    expect(await w.u.check()).toBe("net"); // checked now (nothing published: the manifest is a 404)
    expect(paths(w)).toEqual(["/v1/manifest.json"]);
    expect((await stored(w.idb)).due).toBe(T0 + DAY_MS); // and due again a day on (random 0)
    // a clock a year ahead when the switch was turned on, then put right
    const y = world();
    y.clock.now = T0 + 365 * DAY_MS;
    await y.u.status(true);
    y.clock.now = T0;
    expect(await y.u.check()).toBe("net");
  });
});

describe("the module", () => {
  const src = readFileSync(resolve(import.meta.dirname, "../../src/platform/rules-live.ts"), "utf8");
  it("checks a bundle with the format's whole checker (validate, the host checks, the build's option)", () => {
    expect(src).toMatch(/const checker: Checker = \{\s*validate,\s*checks: \{ canonicalHost, isShared \},/);
    expect(src).toMatch(/checkSigned\(text, bundle, s\.record, ctx, checker\)/);
    expect(src).toMatch(/heldBundle\(record, ctxAt\(keys\), checker\)/);
  });
  it("reads the manifest before the bundle, and fetches the bundle only for a manifest checkManifest took", () => {
    const run = src.slice(src.indexOf("async function run("));
    const order = ["/v1/manifest.json", "checkManifest(", "if (!m.ok)", "/v1/bundle-", "checkSigned("].map((x) =>
      run.indexOf(x),
    );
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
