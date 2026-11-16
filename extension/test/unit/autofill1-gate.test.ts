// STORAGEGATE: nothing of Sixkey's goes into a page unless storage.local AND storage.session are closed to content scripts,
// asked of the browser just then (src/platform/storage-access.ts `storageClosed`, awaited by src/platform/autofill.ts before
// every injection). Before Chrome 140 `storage.local.setAccessLevel` does not exist (Chromium a8f1f337, M140), so a page
// that hosted the look or the fill could read and write the vault (AUTOFILL2-PLAN-REVIEW M5). Sixkey requires Chrome 140
// since wave 1b of the plugin platform (manifest minimum_chrome_version; OWNER-DECISIONS/14 OQ1 (a)): the gate tested here
// is the second layer, for a browser that refuses the call anyway. Here: the gate itself, and
// each path that injects (the look on open or on a press, the fill of a press, the shortcut's look and fill) with the gate
// shut, shut only at the fill, and shut by each area alone.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Found } from "../../src/inject/otp";
import type { Entry } from "../../src/core/vault/model";
import { NOT_OFF, TEST_CODE } from "../helpers/gate";

/** The tab in front of a focused window: what platform/autofill.ts inFront asks before every fill (AUTOFILL2 patch 3). */
const frontTab = async (id: number) => ({ id, active: true, windowId: 1 });
const frontWindows = { get: async () => ({ focused: true }) };

type Mode = "ok" | "reject" | "throw" | "missing" | "hang";
const g = globalThis as Record<string, unknown>;
/** chrome.storage whose two areas answer setAccessLevel as told (a list: one answer per call, the last one repeats). */
function storage(local: Mode | Mode[], session: Mode | Mode[] = "ok") {
  const asked: string[] = [];
  const area = (name: string, modes: Mode | Mode[]) => {
    const list = Array.isArray(modes) ? modes : [modes];
    let i = 0;
    const next = () => list[Math.min(i++, list.length - 1)]!;
    if (list.every((m) => m === "missing")) return {};
    return {
      setAccessLevel(o: { accessLevel: string }) {
        asked.push(`${name} ${o.accessLevel}`);
        const m = next();
        if (m === "throw" || m === "missing") throw new Error("setAccessLevel is not a function");
        if (m === "reject") return Promise.reject(new Error("not allowed"));
        if (m === "hang") return new Promise<void>(() => undefined);
        return Promise.resolve();
      },
    };
  };
  return { local: area("local", local), session: area("session", session), asked };
}

type Call = { target: { documentIds?: string[] }; files?: string[]; func?: unknown; args?: unknown[] };
const found = (): Found => ({ t: "0123456789abcdef", k: 0, n: 6, s: 70, sent: false, weak: false, lab: "" });
const frames = [
  { frameId: 0, documentId: "doc0", result: { o: "https://example.com", a: [], top: true, c: [found()], x: 0, z: 0 } },
];
/** chrome with this storage and a page that would answer every call: the calls made into the page are recorded. */
function world(st: ReturnType<typeof storage>) {
  const calls: Call[] = [];
  vi.stubGlobal("chrome", {
    windows: frontWindows,
    tabs: { get: frontTab },
    storage: st,
    scripting: {
      executeScript: vi.fn(async (c: Call) => {
        calls.push(c);
        return c.files ? [] : c.target?.documentIds ? [{ result: { ok: true, how: "single" } }] : frames;
      }),
    },
  });
  return calls;
}
const entry = (): Entry =>
  ({
    id: "e1",
    createdAt: 0,
    type: "totp",
    issuer: "Example",
    label: "alice",
    secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    domains: ["example.com"],
    hlc: "",
    order: "a",
    phlc: "",
  }) as Entry;
const cand = {
  frameId: 0,
  documentId: "doc0",
  origin: "https://example.com",
  top: "https://example.com",
  domain: "example.com",
  found: found(),
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
  delete g.chrome;
});

describe("storageClosed: both areas, asked now, or no", () => {
  const ask = async () => (await import("../../src/platform/storage-access")).storageClosed();
  it("true only when both areas accept TRUSTED_CONTEXTS; each area alone, a rejection, a throw or a missing API is no", async () => {
    const cases: [Mode, Mode, boolean][] = [
      ["ok", "ok", true],
      ["missing", "ok", false], // storage.local without setAccessLevel (before Chrome 140, which Sixkey now requires)
      ["reject", "ok", false],
      ["throw", "ok", false],
      ["ok", "reject", false],
      ["ok", "missing", false],
      ["ok", "throw", false],
    ];
    for (const [local, session, want] of cases) {
      const st = storage(local, session);
      vi.stubGlobal("chrome", { storage: st });
      expect(await ask(), `local ${local}, session ${session}`).toBe(want);
      if (local === "ok" && session === "ok")
        expect(st.asked).toEqual(["local TRUSTED_CONTEXTS", "session TRUSTED_CONTEXTS"]);
    }
    vi.stubGlobal("chrome", {});
    expect(await ask()).toBe(false);
    vi.stubGlobal("chrome", undefined);
    expect(await ask()).toBe(false);
    // a throw while reaching chrome.storage (not expected): still a no, never a rejection of the look or the fill
    vi.stubGlobal("chrome", {
      get storage(): never {
        throw new Error("no storage here");
      },
    });
    await expect(ask()).resolves.toBe(false);
  });
  it("an answer that does not come within GATE_MS is a no (a hanging call never opens the gate)", async () => {
    vi.useFakeTimers();
    const { storageClosed, GATE_MS } = await import("../../src/platform/storage-access");
    for (const [local, session] of [
      ["hang", "ok"],
      ["ok", "hang"],
    ] as const) {
      vi.stubGlobal("chrome", { storage: storage(local, session) });
      let out: boolean | undefined;
      void storageClosed().then((v) => (out = v));
      await vi.advanceTimersByTimeAsync(GATE_MS - 50);
      expect(out, "still waiting just before the limit").toBeUndefined();
      await vi.advanceTimersByTimeAsync(100);
      expect(out).toBe(false);
    }
  });
  it("nothing is remembered: every call asks the browser again, in the same page and after a new start of the module", async () => {
    // a store that outlives the module, as storage.session outlives a worker restart: a remembered "yes" would be found here
    const kept = new Map<string, unknown>();
    const area = (modes: Mode[]) => ({
      ...storage(modes).local,
      get: async (k: string) => (kept.has(k) ? { [k]: kept.get(k) } : {}),
      set: async (o: Record<string, unknown>) => void Object.entries(o).forEach(([k, v]) => kept.set(k, v)),
    });
    const st = { local: area(["ok", "reject"]), session: area(["ok"]) };
    vi.stubGlobal("chrome", { storage: st });
    expect(await ask()).toBe(true);
    expect(await ask()).toBe(false); // the same module: the browser refused this time
    vi.resetModules(); // a new start of the module (a worker restart, a new popup)
    vi.stubGlobal("chrome", { storage: { local: area(["reject"]), session: area(["ok"]) } });
    expect(await ask()).toBe(false);
  });
});

describe("every path that injects is gated", () => {
  it("the look (on open, on a press, and the shortcut's): with the gate shut nothing is injected, for each area alone", async () => {
    for (const [local, session] of [
      ["missing", "ok"],
      ["reject", "ok"],
      ["ok", "reject"],
      ["hang", "ok"],
    ] as const) {
      vi.useFakeTimers();
      const calls = world(storage(local, session));
      const { scan } = await import("../../src/platform/autofill");
      const out = scan(7);
      await vi.advanceTimersByTimeAsync(6000);
      expect(await out, `${local}/${session}`).toEqual({ k: "gated" });
      expect(calls, `${local}/${session}`).toEqual([]);
      vi.useRealTimers();
      vi.resetModules();
    }
  });
  it("the fill (a press, the shortcut): shut at the moment of the fill, after an open look, nothing is injected and the code is not worked out", async () => {
    const calls = world(storage(["ok", "reject"]));
    const { scan, fillCand } = await import("../../src/platform/autofill");
    expect((await scan(7)).k).toBe("ok");
    const before = calls.length;
    const code = vi.fn(async () => ({ code: "123456" }));
    expect(await fillCand(7, entry(), cand, { now: () => 31_000, code })).toEqual({ k: "failed", r: "gated" });
    expect(calls.length).toBe(before);
    expect(calls.filter((c) => c.target?.documentIds)).toEqual([]);
    expect(code).not.toHaveBeenCalled();
  });
  it("control: with both areas closed the look and the fill go ahead", async () => {
    const calls = world(storage("ok", "ok"));
    const { scan, fillCand } = await import("../../src/platform/autofill");
    expect((await scan(7)).k).toBe("ok");
    expect(await fillCand(7, entry(), cand, { now: () => 31_000, code: async () => ({ code: "123456" }) })).toEqual({
      k: "filled",
      how: "single",
    });
    expect(calls.filter((c) => c.target?.documentIds)).toHaveLength(1);
  });
  it("the shortcut: a shut gate at its look or at its fill is 'gated' (nothing injected after the gate), and the icon says why with '!'", async () => {
    const { fillOnTab, reportFill } = await import("../../src/background/fill-command");
    const tab = { id: 7, url: "https://example.com/login", windowId: 3 };
    const vault = async () => [entry()];
    let calls = world(storage("missing"));
    expect(await fillOnTab(tab, vault, { now: () => 31_000, code: TEST_CODE, off: NOT_OFF })).toBe("gated");
    expect(calls).toEqual([]);
    calls = world(storage(["ok", "reject"]));
    expect(await fillOnTab(tab, vault, { now: () => 31_000, code: TEST_CODE, off: NOT_OFF })).toBe("gated");
    expect(calls.filter((c) => c.target?.documentIds)).toEqual([]);
    const log: string[] = [];
    await reportFill(
      "gated",
      tab,
      {
        action: {
          setBadgeText: async (o) => void log.push(`text:${o.text}`),
          setBadgeBackgroundColor: async () => undefined,
          setTitle: async (o) => void log.push(`title:${o.title}`),
          getTitle: async () => "Sixkey",
        },
        i18n: { getMessage: () => "" },
      },
      "popup",
      async () => undefined,
    );
    expect(log.slice(0, 2)).toEqual(["text:!", "title:Sixkey: autofill needs Chrome 140 or later"]);
  });
});
