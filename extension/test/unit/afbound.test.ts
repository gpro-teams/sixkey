// AF-BOUND (docs/design/notes/AUTOFILL2-NOTES.md §13.10): the shortcut's and R's browser calls are bounded, against calls
// whose answers never come (a never-settling fake), one case per bound:
//   - platform/bounded.ts itself: an answer passes; none fails at STORE_MS; its timer goes either way;
//   - platform/fill-request.ts: putRequest's write, and in takeRequest, R's read, the lock epoch, the tab in front and the
//     removal: each lost one fails that operation, and `sixkey-fill-req` is free for the next; peekRequest's read the same;
//   - background/fill-command.ts runShortcut: the lock epoch lost is no epoch, so no R, and the press goes on to its badge
//     and its surface (the fallback a press without R always had: the user unlocks there, and presses again);
//   - platform/content-page.ts (the gate open): the `open`'s lock epoch lost is no request, and no popup;
//   - popup/main/Fill.tsx reads R only through fill-request's bounded functions.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bounded, STORE_MS } from "../../src/platform/bounded";
import { FILL_REQ_KEY, peekRequest, putRequest, takeRequest, type Here } from "../../src/platform/fill-request";

const never = <T>() => new Promise<T>(() => undefined);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function watch<T>(p: Promise<T>) {
  const s = { state: "pending" as "pending" | "ok" | "failed", value: undefined as T | undefined };
  p.then(
    (v) => ((s.state = "ok"), (s.value = v)),
    () => (s.state = "failed"),
  );
  return s;
}
/** storage.session as a map; `hang` makes the next call of that name never answer (once). */
function area() {
  const m = new Map<string, unknown>();
  const a = {
    m,
    hang: null as null | "get" | "set" | "remove",
    get: (k: string) => {
      if (a.hang === "get") return ((a.hang = null), never<Record<string, unknown>>());
      return Promise.resolve(m.has(k) ? { [k]: structuredClone(m.get(k)) } : {});
    },
    set: (o: Record<string, unknown>) => {
      if (a.hang === "set") return ((a.hang = null), never<void>());
      Object.entries(o).forEach(([k, v]) => m.set(k, structuredClone(v)));
      return Promise.resolve();
    },
    remove: (k: string) => {
      if (a.hang === "remove") return ((a.hang = null), never<void>());
      m.delete(k);
      return Promise.resolve();
    },
  };
  return a;
}
const URL1 = "https://github.com/sessions/two-factor";
const R0 = { tabId: 7, windowId: 3, url: URL1, epoch: 4, why: "locked" as const };
/** Here and now for the take: this tab in front at R's address, the epoch as R's; either part may never answer. */
const here = (o: { epoch?: "never"; front?: "never" } = {}): Here => ({
  now: () => Date.now(),
  epoch: () => (o.epoch ? never<number>() : Promise.resolve(4)),
  front: () => (o.front ? never<{ id?: number; url?: string }>() : Promise.resolve({ id: 7, url: URL1 })),
});
/** The lock is free: a write on storage that answers goes through at once. */
async function lockFree(a: ReturnType<typeof area>) {
  const next = watch(putRequest(a as never, R0));
  await vi.advanceTimersByTimeAsync(0);
  expect(next.state, "the next operation of sixkey-fill-req").toBe("ok");
}

describe("bounded(): an answer, or a failure at STORE_MS", () => {
  it("STORE_MS is 5 s", () => expect(STORE_MS).toBe(5000));
  it("an answer passes, and leaves no timer", async () => {
    vi.useFakeTimers();
    const b = watch(bounded(Promise.resolve(7)));
    await vi.advanceTimersByTimeAsync(0);
    expect(b).toEqual({ state: "ok", value: 7 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("no answer: a failure at STORE_MS, not before, and no timer left", async () => {
    vi.useFakeTimers();
    const b = watch(bounded(never()));
    await vi.advanceTimersByTimeAsync(STORE_MS - 1);
    expect(b.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(2);
    expect(b.state).toBe("failed");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("fill-request.ts: each call on R's path bounded; sixkey-fill-req never held by a lost answer", () => {
  it("putRequest: its write never answered fails at STORE_MS; the lock is free", async () => {
    vi.useFakeTimers();
    const a = area();
    a.hang = "set";
    const p = watch(putRequest(a as never, R0));
    await vi.advanceTimersByTimeAsync(STORE_MS - 1);
    expect(p.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(2);
    expect(p.state).toBe("failed");
    await lockFree(a);
  });
  for (const [what, setup] of [
    ["R's read", (a: ReturnType<typeof area>) => ((a.hang = "get"), here())],
    ["the lock epoch", () => here({ epoch: "never" })],
    ["the tab in front", () => here({ front: "never" })],
    ["R's removal", (a: ReturnType<typeof area>) => ((a.hang = "remove"), here())],
  ] as const)
    it(`takeRequest: ${what} never answered fails at STORE_MS; the lock is free`, async () => {
      vi.useFakeTimers();
      const a = area();
      const r = watch(putRequest(a as never, R0));
      await vi.advanceTimersByTimeAsync(0);
      const h = setup(a);
      const t = watch(takeRequest(a as never, r.value!.nonce, h));
      await vi.advanceTimersByTimeAsync(STORE_MS - 1);
      expect(t.state).toBe("pending");
      await vi.advanceTimersByTimeAsync(2);
      expect(t.state).toBe("failed");
      await lockFree(a);
    });
  it("takeRequest with every call answered: R taken, once", async () => {
    vi.useFakeTimers();
    const a = area();
    const r = watch(putRequest(a as never, R0));
    await vi.advanceTimersByTimeAsync(0);
    const t = watch(takeRequest(a as never, r.value!.nonce, here()));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.value).toMatchObject({ ok: true });
    expect(a.m.has(FILL_REQ_KEY)).toBe(false);
  });
  it("peekRequest: its read never answered fails at STORE_MS (the lock screen then shows no line)", async () => {
    vi.useFakeTimers();
    const a = area();
    watch(putRequest(a as never, R0));
    await vi.advanceTimersByTimeAsync(0);
    a.hang = "get";
    const p = watch(peekRequest(a as never, here()));
    await vi.advanceTimersByTimeAsync(STORE_MS + 1);
    expect(p.state).toBe("failed");
  });
});

describe("runShortcut: the lock epoch's read lost is no epoch, and the press goes on", () => {
  it("at STORE_MS: locked, no R written, the badge set and the popup opened", async () => {
    vi.useFakeTimers();
    const a = area();
    const log: string[] = [];
    vi.stubGlobal("chrome", { storage: { local: {}, session: {} } });
    const { runShortcut } = await import("../../src/background/fill-command");
    const out = watch(
      runShortcut(
        { id: 7, windowId: 3, url: URL1 },
        {
          epoch: () => (log.push("epoch"), never<number>()),
          entries: async () => (log.push("vault"), null),
          session: a as never,
          chrome: {
            action: {
              setBadgeText: async (o: { text: string | null }) => void log.push(`badge:${o.text}`),
              setBadgeBackgroundColor: async () => undefined,
              setTitle: async () => undefined,
              getTitle: async () => "Sixkey",
              openPopup: async () => void log.push("popup"),
            },
            i18n: { getMessage: () => "" },
          } as never,
          opens: "popup",
          deps: { code: (() => undefined) as never, off: async () => false } as never,
          sleep: async () => undefined,
        },
      ),
    );
    await vi.advanceTimersByTimeAsync(STORE_MS - 1);
    expect(out.state).toBe("pending");
    expect(log).toEqual(["epoch"]);
    await vi.advanceTimersByTimeAsync(2);
    expect(out).toEqual({ state: "ok", value: "locked" });
    expect(a.m.has(FILL_REQ_KEY)).toBe(false);
    expect(log).toEqual(["epoch", "vault", "popup", "badge:!", "badge:null"]);
  });
});

describe("content-page.ts (the gate open): the `open`'s lock epoch lost is no request", () => {
  it("at STORE_MS: norequest, and no popup", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubGlobal("__SUGGEST_UI__", true);
    const channel = await import("../../src/platform/content-channel");
    const DOC = "0123456789ABCDEF0123456789ABCDEF";
    const SELF = "abcdefghijklmnopabcdefghijklmnop";
    const log: string[] = [];
    const on = channel.createContentChannel({
      selfId: SELF,
      off: async () => false,
      gate: async () => true,
      sites: async () => ["login.example.com"],
      granted: async () => true,
      badge: async () => undefined,
      now: () => 1_000_000,
      page: {
        key: async () => "",
        shown: { note: async () => undefined, take: async () => true },
        token: async () => true,
        front: async () => true,
        epoch: () => never<number>(),
        request: async (r) => (log.push("request"), r),
        opens: () => "popup",
        openPanel: () => undefined,
        openPopup: async () => void log.push("popup"),
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
    const o = watch(on({ type: "sk-af-open" }, sender));
    await vi.advanceTimersByTimeAsync(STORE_MS - 1);
    expect(o.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(2);
    expect(o).toEqual({ state: "ok", value: "norequest" });
    expect(log).toEqual([]);
  });
});

describe("Fill.tsx reads R only through fill-request's bounded functions", () => {
  it("no read of R's key of its own", () => {
    const src = readFileSync(resolve(__dirname, "../../src/popup/main/Fill.tsx"), "utf8");
    expect(src).not.toMatch(/\.get\(\s*FILL_REQ_KEY\s*\)/);
    expect(src).toMatch(/const r = await storedRequest\(area\);/);
  });
});
