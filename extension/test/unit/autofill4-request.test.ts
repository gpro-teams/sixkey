// AUTOFILL2 patch 4a (docs/design/notes/AUTOFILL2-NOTES.md §12): the pending fill request R, version 2, written for the
// user's click on the in-page suggestion (platform/fill-request.ts), and what the worker keeps for that click's `open`
// (platform/page-open.ts): the documents answered `show: true`, each opening once, and a token bucket per tab.
import { afterAll, describe, expect, it, vi } from "vitest";
// the in-page suggestion's release gate open (the build's define, stood in for by a global, set before the imports); its
// closed side is the last describe's
vi.hoisted(() => void ((globalThis as Record<string, unknown>).__SUGGEST_UI__ = true));
import { FILL_REQ_KEY, putRequest, readRequest, takeRequest, type Here } from "../../src/platform/fill-request";
import {
  BUCKET,
  noteShown,
  OPEN_KEY,
  REFILL_MS,
  SHOWN_KEY,
  SHOWN_MAX,
  SHOWN_MS,
  takeShown,
  takeToken,
} from "../../src/platform/page-open";

const DOC = "0123456789ABCDEF0123456789ABCDEF";
const URL1 = "https://github.com/sessions/two-factor";
const v1 = {
  v: 1,
  nonce: "a".repeat(32),
  tabId: 7,
  windowId: 3,
  url: URL1,
  host: "github.com",
  at: 1000,
  epoch: 0,
  why: "locked",
};
const v2 = { ...v1, v: 2, why: "page", doc: DOC };

function area() {
  const m = new Map<string, unknown>();
  return {
    m,
    get: async (k: string) => (m.has(k) ? { [k]: structuredClone(m.get(k)) } : {}),
    set: async (o: Record<string, unknown>) => void Object.entries(o).forEach(([k, v]) => m.set(k, structuredClone(v))),
    remove: async (k: string) => void m.delete(k),
  } as never as { m: Map<string, unknown> } & Parameters<typeof takeShown>[0] & Parameters<typeof putRequest>[0];
}

describe("R v2: the request of a click on the in-page suggestion", () => {
  it("is read with exactly v2's fields, and v1 with exactly v1's", () => {
    expect(readRequest(v1)).toEqual(v1);
    expect(readRequest(v2)).toEqual(v2);
  });

  it("anything else is no request: a field more or less, the other version's reason, a document of another shape", () => {
    const { doc: _doc, ...v2NoDoc } = v2;
    for (const bad of [
      { ...v1, doc: DOC }, // v1 with a document
      { ...v2NoDoc }, // v2 without one
      { ...v2, extra: 1 },
      { ...v2, why: "locked" }, // v2 is the page's only
      { ...v1, why: "page" }, // and "page" is v2's only
      { ...v2, v: 3 },
      { ...v2, doc: DOC.toLowerCase() },
      { ...v2, doc: DOC.slice(1) },
      { ...v2, doc: 7 },
    ])
      expect(readRequest(bad), JSON.stringify(bad)).toBeNull();
  });

  it("a reader of v1 only (a Sixkey before v2) sees no request in a v2 one: exactly v1's fields are required", () => {
    // the v1 reader's own rule, as it was: the keys, sorted, are v1's nine
    const v1Keys = ["at", "epoch", "host", "nonce", "tabId", "url", "v", "why", "windowId"].join();
    expect(Object.keys(v2).sort().join()).not.toBe(v1Keys);
  });

  it("putRequest with a document writes v2; without one, v1 as before", async () => {
    const a = area();
    const o = { tabId: 7, windowId: 3, url: URL1, epoch: 4 };
    const r2 = await putRequest(a, { ...o, why: "page", doc: DOC }, 5000);
    expect(r2).toMatchObject({ v: 2, why: "page", doc: DOC, host: "github.com", at: 5000, epoch: 4 });
    expect(a.m.get(FILL_REQ_KEY)).toEqual(r2);
    const r1 = await putRequest(a, { ...o, why: "locked" }, 6000);
    expect(r1).toMatchObject({ v: 1, why: "locked" });
    expect(Object.keys(r1!)).not.toContain("doc");
    // a document of the wrong shape writes nothing at all
    expect(await putRequest(a, { ...o, why: "page", doc: "x" }, 7000)).toBeNull();
    expect(a.m.get(FILL_REQ_KEY)).toEqual(r1);
  });

  it("is taken once, by its nonce, for here, like v1", async () => {
    const a = area();
    const r = (await putRequest(a, { tabId: 7, windowId: 3, url: URL1, epoch: 0, why: "page", doc: DOC }, 1000))!;
    const here: Here = { now: () => 2000, epoch: async () => 0, front: async () => ({ id: 7, url: URL1 }) };
    expect(await takeRequest(a, r.nonce, here)).toEqual({ ok: true, r });
    expect(await takeRequest(a, r.nonce, here)).toEqual({ ok: false, why: "gone" });
  });
});

describe("the documents answered show: true (page-open.ts)", () => {
  it("one open per document, only after show: true, within its time", async () => {
    const a = area();
    expect(await takeShown(a, DOC, 1000)).toBe(false); // never answered show: true
    await noteShown(a, DOC, 1000);
    expect(await takeShown(a, DOC, 2000)).toBe(true);
    expect(await takeShown(a, DOC, 3000)).toBe(false); // opened already
    // answered again (the content script asked again): still opened
    await noteShown(a, DOC, 4000);
    expect(await takeShown(a, DOC, 5000)).toBe(false);
    const other = "F".repeat(32);
    await noteShown(a, other, 10_000);
    expect(await takeShown(a, other, 10_000 + SHOWN_MS)).toBe(false); // too late
  });

  it("keeps at most SHOWN_MAX, the newest; a record of another shape reads as empty", async () => {
    const a = area();
    for (let i = 0; i < SHOWN_MAX + 5; i++) await noteShown(a, `D${String(i).padStart(4, "0")}`, 1000 + i);
    expect(Object.keys(a.m.get(SHOWN_KEY) as object)).toHaveLength(SHOWN_MAX);
    expect(await takeShown(a, "D0000", 2000)).toBe(false); // the oldest went
    expect(await takeShown(a, `D${String(SHOWN_MAX + 4).padStart(4, "0")}`, 2000)).toBe(true);
    a.m.set(SHOWN_KEY, { [DOC]: { at: "x", o: 0 } });
    expect(await takeShown(a, DOC, 2000)).toBe(false);
  });
});

describe("the bucket of opens per tab (page-open.ts)", () => {
  it(`${BUCKET} at once, then one each ${REFILL_MS / 1000} s; another tab has its own`, async () => {
    const a = area();
    const t0 = 1_000_000;
    expect(await takeToken(a, 7, t0)).toBe(true);
    expect(await takeToken(a, 7, t0 + 1)).toBe(true);
    expect(await takeToken(a, 7, t0 + 2)).toBe(false);
    expect(await takeToken(a, 8, t0 + 2)).toBe(true);
    expect(await takeToken(a, 7, t0 + REFILL_MS - 1)).toBe(false);
    expect(await takeToken(a, 7, t0 + REFILL_MS)).toBe(true);
    expect(await takeToken(a, 7, t0 + REFILL_MS + 1)).toBe(false);
    // a long while later the bucket is full again, no more than full
    expect(await takeToken(a, 7, t0 + 10 * REFILL_MS)).toBe(true);
    expect(await takeToken(a, 7, t0 + 10 * REFILL_MS)).toBe(true);
    expect(await takeToken(a, 7, t0 + 10 * REFILL_MS)).toBe(false);
  });

  it("is kept in storage.session (a worker restart keeps it), and a clock gone back refills nothing", async () => {
    const a = area();
    const t0 = 2_000_000;
    await takeToken(a, 7, t0);
    await takeToken(a, 7, t0);
    expect(a.m.get(OPEN_KEY)).toEqual({ "7": { n: 0, at: t0 } });
    expect(await takeToken(a, 7, t0 - 5 * REFILL_MS)).toBe(false);
  });
});

describe("the gate closed (a store build until the flip): request v2 is neither read nor written", () => {
  afterAll(() => void ((globalThis as Record<string, unknown>).__SUGGEST_UI__ = true));
  it("a v2 request reads as none, as in a Sixkey before v2, and putRequest writes no v2; v1 is as before", async () => {
    delete (globalThis as Record<string, unknown>).__SUGGEST_UI__;
    vi.resetModules();
    const closed = await import("../../src/platform/fill-request");
    expect(closed.readRequest(v2)).toBeNull();
    expect(closed.readRequest(v1)).toEqual(v1);
    const a = area();
    const o = { tabId: 7, windowId: 3, url: URL1, epoch: 4 };
    expect(await closed.putRequest(a, { ...o, why: "page", doc: DOC }, 5000)).toBeNull();
    expect(a.m.has(FILL_REQ_KEY)).toBe(false);
    expect(await closed.putRequest(a, { ...o, why: "locked" }, 5000)).toMatchObject({ v: 1, why: "locked" });
  });
});
