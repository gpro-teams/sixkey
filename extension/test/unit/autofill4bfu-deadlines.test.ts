// TOTP autofill Stage 2, follow-up 4B-FU (docs/design/notes/AUTOFILL2-NOTES.md §13.8; the 4b review's S-1): the `cand`
// path's deadlines, against browser calls whose answers never come.
//   - platform/page-open.ts: each storage call inside `sixkey-af-open` is bounded by STORE_MS. A call that never answers
//     fails its operation, and the lock is let go: the next operation, on storage that answers, goes through. One case per
//     bound (six), so that removing any one is seen;
//   - platform/content-page.ts: `show: true` only once the document's record is written, and kept in memory only then; the
//     whole `cand` within CAND_MS, or no answer at all (the content script then asks again at its next look);
//   - the three deadlines nest: a storage call's, inside the worker's, inside the content script's.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ASK_MS } from "../../src/inject/suggest-arm";
import { CAND_MS } from "../../src/platform/content-page";
import * as po from "../../src/platform/page-open";

const SELF = "abcdefghijklmnopabcdefghijklmnop";
const DOC = "0123456789ABCDEF0123456789ABCDEF";
const never = <T>() => new Promise<T>(() => undefined);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** storage.session as a map; `hang` makes the next get or set never answer (once). */
function area() {
  const m = new Map<string, unknown>();
  const a = {
    m,
    hang: null as null | "get" | "set",
    get: (k: string) => {
      if (a.hang === "get") return ((a.hang = null), never<Record<string, unknown>>());
      return Promise.resolve(m.has(k) ? { [k]: structuredClone(m.get(k)) } : {});
    },
    set: (o: Record<string, unknown>) => {
      if (a.hang === "set") return ((a.hang = null), never<void>());
      Object.entries(o).forEach(([k, v]) => m.set(k, structuredClone(v)));
      return Promise.resolve();
    },
  };
  return a;
}
/** A promise's state, without awaiting it (a never-settling one stays "pending", and the test still ends). */
function watch<T>(p: Promise<T>) {
  const s = { state: "pending" as "pending" | "ok" | "failed", value: undefined as T | undefined };
  p.then(
    (v) => ((s.state = "ok"), (s.value = v)),
    () => (s.state = "failed"),
  );
  return s;
}

describe("page-open.ts: every storage call inside the lock is bounded, and a lost one lets the lock go", () => {
  const { STORE_MS } = po;
  const cases: [string, "get" | "set", (a: ReturnType<typeof area>) => Promise<unknown>][] = [
    ["noteShown's read", "get", (a) => po.noteShown(a as never, DOC, 1000)],
    ["noteShown's write", "set", (a) => po.noteShown(a as never, DOC, 1000)],
    ["takeShown's read", "get", (a) => po.takeShown(a as never, DOC, 1000)],
    ["takeShown's write", "set", (a) => po.takeShown(a as never, DOC, 1000)],
    ["takeToken's read", "get", (a) => po.takeToken(a as never, 7, 1000)],
    ["takeToken's write", "set", (a) => po.takeToken(a as never, 7, 1000)],
  ];
  for (const [what, call, op] of cases)
    it(`${what} never answered: the operation fails at STORE_MS; the lock is free for the next`, async () => {
      vi.useFakeTimers();
      const a = area();
      // takeShown writes only for a document answered show: true (and not opened yet)
      if (what.startsWith("takeShown")) {
        const noted = watch(po.noteShown(a as never, DOC, 1000));
        await vi.advanceTimersByTimeAsync(0);
        expect(noted.state).toBe("ok");
      }
      a.hang = call;
      const first = watch(op(a));
      await vi.advanceTimersByTimeAsync(STORE_MS - 1);
      expect(first.state).toBe("pending");
      await vi.advanceTimersByTimeAsync(2);
      expect(first.state).toBe("failed");
      // the next operation of the lock, on storage that answers: through at once
      const next = watch(po.takeToken(a as never, 99, 1000));
      await vi.advanceTimersByTimeAsync(0);
      expect(next).toEqual({ state: "ok", value: true });
    });
  it("STORE_MS is 5 s", () => expect(STORE_MS).toBe(5000));
});

async function channelWorld(
  o: { note?: () => Promise<void>; sites?: () => Promise<string[]>; key?: () => Promise<string> } = {},
) {
  vi.resetModules();
  vi.stubGlobal("__SUGGEST_UI__", true);
  const channel = await import("../../src/platform/content-channel");
  const log: string[] = [];
  const shown = new Set<string>();
  const on = channel.createContentChannel({
    selfId: SELF,
    off: async () => false,
    gate: async () => true,
    sites: o.sites ?? (async () => ["login.example.com"]),
    granted: async () => true,
    badge: async (tabId) => void log.push(`badge:${tabId}`),
    now: () => 1_000_000,
    page: {
      key: o.key ?? (async () => "Alt+Shift+F"),
      shown: {
        note: o.note ?? (async (doc) => void shown.add(doc)),
        take: async (doc) => shown.has(doc),
      },
      token: async () => true,
      front: async () => true,
      epoch: async () => 5,
      request: async (r) => r,
      opens: () => "panel",
      openPanel: (w) => void log.push(`panel:${w}`),
      openPopup: async () => undefined,
    },
  });
  const sender = {
    id: SELF,
    url: "https://login.example.com/2fa",
    origin: "https://login.example.com",
    frameId: 0,
    documentId: DOC,
    documentLifecycle: "active",
    tab: { id: 7, windowId: 3, url: "https://login.example.com/2fa", active: true, incognito: false },
  };
  const replies: unknown[] = [];
  const cand = () => watch(on({ type: "sk-af-cand" }, sender, (a) => void replies.push(a)));
  // `open` in panel mode: the panel is opened at once only for a document this worker answered show: true (memory)
  const open = () => watch(on({ type: "sk-af-open" }, sender));
  return { cand, open, replies, log, channel };
}

describe("content-page.ts: `cand` answered show: true only after its record, within CAND_MS or not at all", () => {
  it("the record written: show: true, at once", async () => {
    vi.useFakeTimers();
    const w = await channelWorld();
    const c = w.cand();
    await vi.advanceTimersByTimeAsync(0);
    expect(c).toEqual({ state: "ok", value: "badge" });
    expect(w.replies).toEqual([{ show: true, key: "Alt+Shift+F" }]);
  });
  it("the record's write failed: no answer, nothing kept in memory (a later open does not open the panel)", async () => {
    vi.useFakeTimers();
    const w = await channelWorld({ note: () => Promise.reject(new Error("lost")) });
    const c = w.cand();
    await vi.advanceTimersByTimeAsync(0);
    expect(c).toEqual({ state: "ok", value: "unnoted" });
    expect(w.replies).toEqual([]);
    w.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.log.filter((l) => l.startsWith("panel"))).toEqual([]);
  });
  it("the record's write never answered: at CAND_MS the handler gives up, and answers nothing", async () => {
    vi.useFakeTimers();
    const w = await channelWorld({ note: () => never<void>() });
    const c = w.cand();
    await vi.advanceTimersByTimeAsync(CAND_MS - 1);
    expect(c.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(2);
    expect(c).toEqual({ state: "ok", value: "deadline" });
    expect(w.replies).toEqual([]);
  });
  it("any earlier call never answered (the list of sites): the same deadline", async () => {
    vi.useFakeTimers();
    const w = await channelWorld({ sites: () => never<string[]>() });
    const c = w.cand();
    await vi.advanceTimersByTimeAsync(CAND_MS + 1);
    expect(c).toEqual({ state: "ok", value: "deadline" });
    expect(w.replies).toEqual([]);
  });
  it("the record written only after the deadline: still no answer, and nothing kept in memory", async () => {
    vi.useFakeTimers();
    let done: () => void = () => undefined;
    const w = await channelWorld({ note: () => new Promise<void>((r) => (done = r)) });
    const c = w.cand();
    await vi.advanceTimersByTimeAsync(CAND_MS + 1);
    expect(c.value).toBe("deadline");
    done();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.replies).toEqual([]);
    w.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.log.filter((l) => l.startsWith("panel"))).toEqual([]);
  });
  it("the shortcut read only after the deadline: no answer, though the record is written", async () => {
    vi.useFakeTimers();
    let done: (k: string) => void = () => undefined;
    const w = await channelWorld({ key: () => new Promise<string>((r) => (done = r)) });
    const c = w.cand();
    await vi.advanceTimersByTimeAsync(CAND_MS + 1);
    expect(c.value).toBe("deadline");
    done("Alt+Shift+F");
    await vi.advanceTimersByTimeAsync(0);
    expect(w.replies).toEqual([]);
  });
  it("the checks done only after the deadline, with a refusal: no answer either (not even show: false)", async () => {
    vi.useFakeTimers();
    let done: (l: string[]) => void = () => undefined;
    const w = await channelWorld({ sites: () => new Promise<string[]>((r) => (done = r)) });
    const c = w.cand();
    await vi.advanceTimersByTimeAsync(CAND_MS + 1);
    expect(c.value).toBe("deadline");
    done([]); // the site is not on the list: a show: false that is now too late
    await vi.advanceTimersByTimeAsync(0);
    expect(w.replies).toEqual([]);
  });
  it("answered in time: the document is kept in memory (its open opens the panel at once)", async () => {
    vi.useFakeTimers();
    const w = await channelWorld();
    w.cand();
    await vi.advanceTimersByTimeAsync(0);
    w.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.log).toContain("panel:3");
  });
  it("the three deadlines nest: a storage call's (5 s, twice in the lock) < the worker's (15 s) < the content script's (20 s)", () => {
    expect([po.STORE_MS, CAND_MS, ASK_MS]).toEqual([5000, 15_000, 20_000]);
    expect(2 * po.STORE_MS).toBeLessThan(CAND_MS);
  });
});
