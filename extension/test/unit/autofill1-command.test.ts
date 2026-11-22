// TOTP autofill, Stage 1: the `fill` shortcut (src/background/fill-command.ts, sw.ts; TOTP-AUTOFILL §2.4, §5.3, §8.1). What it
// does for each tab and vault (fillOnTab), what it tells the user (reportFill), and the real service worker's wiring over fake
// chrome.* with a real (device-key) vault: the command reaches the one fill call with the account's current code, and the
// unlock state, the number of accounts and the number of boxes decide between filling and handing over to the popup.
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Found } from "../../src/inject/otp";
import { fillOnTab, reportFill, type FillChrome, type Outcome } from "../../src/background/fill-command";
import type { Entry } from "../../src/core/vault/model";
import { legacyDeviceGeneration } from "../helpers/vaults";
import { loadWorker, unload, wait } from "../helpers/sw-world";
import { NOT_OFF, TEST_CODE } from "../helpers/gate";

/** The tab in front of a focused window: what platform/autofill.ts inFront asks before every fill (AUTOFILL2 patch 3). */
const frontTab = async (id: number) => ({ id, active: true, windowId: 1 });
const frontWindows = { get: async () => ({ focused: true }) };

/** Both storage areas close when asked: the gate before every injection passes (STORAGEGATE; its own tests are in autofill1-gate). */
const openStorage = () => ({
  local: { setAccessLevel: async () => undefined },
  session: { setAccessLevel: async () => undefined },
});

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
let n = 0;
const entry = (o: Partial<Entry> = {}): Entry =>
  ({
    id: `e${++n}`,
    createdAt: 0,
    type: "totp",
    issuer: "Example",
    label: `alice${n}`,
    secret: SECRET,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    domains: ["example.com"],
    hlc: "",
    order: "a",
    phlc: "",
    ...o,
  }) as Entry;
const found = (o: Partial<Found> = {}): Found => ({
  t: "0123456789abcdef",
  k: 0,
  n: 6,
  s: 70,
  sent: false,
  weak: false,
  lab: "",
  ...o,
});

type Call = { target: { documentIds?: string[] }; files?: string[]; func?: unknown; args?: unknown[] };
/** A page: what its finder reports (frames), and what the fill answers. */
function page(frames: unknown[], answer: unknown = { ok: true, how: "single" }) {
  const calls: Call[] = [];
  const executeScript = vi.fn(async (c: Call) => {
    calls.push(c);
    if (c.files) return [];
    if (c.target?.documentIds) return [{ result: answer }];
    return frames;
  });
  return { calls, executeScript };
}
const topFrame = (c: Found[] = [found()], origin = "https://example.com") => [
  { frameId: 0, documentId: "doc0", result: { o: origin, a: [], top: true, c, x: 0, z: 0 } },
];
const TAB = { id: 7, url: "https://example.com/login", windowId: 3 };
const vault =
  (...es: Entry[]) =>
  async () =>
    es;
/** The fill calls: to one document (the look goes to all frames, with the hint as its one argument). */
const fillCalls = (calls: Call[]) => calls.filter((c) => c.target?.documentIds);

afterEach(() => unload());

describe("fillOnTab: what the shortcut does", () => {
  const run = async (
    tab: typeof TAB | undefined,
    entries: () => Promise<readonly Entry[] | null>,
    p = page(topFrame()),
  ) => {
    vi.stubGlobal("chrome", {
      windows: frontWindows,
      tabs: { get: frontTab },
      storage: openStorage(),
      scripting: { executeScript: p.executeScript },
    });
    return {
      out: await fillOnTab(tab, entries, { code: async () => ({ code: "123456" }), now: () => 31_000, off: NOT_OFF }),
      calls: p.calls,
    };
  };
  // wave 1b: the switch and `scripting` (PLUGINS-W1B-NOTES.md; the W1b review's F-04, F-07 and R22)
  const w1b = async (o: {
    entries: () => Promise<readonly Entry[] | null>;
    off?: boolean;
    held?: boolean;
    gate?: "off" | "locked";
  }) => {
    const p = page(topFrame());
    vi.stubGlobal("chrome", {
      windows: frontWindows,
      tabs: { get: frontTab },
      storage: openStorage(),
      scripting: { executeScript: p.executeScript },
      permissions: { contains: async () => o.held ?? true },
    });
    const out = await fillOnTab(TAB, o.entries, {
      code: async () => (o.gate ? { no: o.gate } : { code: "123456" }),
      now: () => 31_000,
      off: async () => o.off ?? false,
    });
    return { out, calls: p.calls };
  };
  it("locked and linked with Sixkey for Mac: the page looked at first, then the app's code filled; refused, the unlock", async () => {
    const asked: string[] = [];
    const answer = {
      codes: [
        { code: "654321", until: 60_000 },
        { code: "111222", until: 90_000 },
      ],
      digits: 6 as const,
      period: 30,
      domains: ["example.com"],
    };
    const go = async (frames: unknown[], reply: typeof answer | null) => {
      const p = page(frames);
      vi.stubGlobal("chrome", {
        windows: frontWindows,
        tabs: { get: frontTab },
        storage: openStorage(),
        scripting: { executeScript: p.executeScript },
        permissions: { contains: async () => true },
      });
      const out = await fillOnTab(TAB, async () => null, {
        code: async () => ({ code: "000000" }), // the gate's: never asked while locked
        now: () => 31_000,
        off: NOT_OFF,
        mac: async (host) => (asked.push(host), reply),
      });
      return { out, calls: p.calls };
    };
    const filled = await go(topFrame(), answer);
    expect(filled.out).toBe("filled");
    expect(asked).toEqual(["example.com"]);
    expect(fillCalls(filled.calls)[0]!.args![0]).toBe("654321"); // the app's code for now, not the gate's
    expect((await go(topFrame(), null)).out).toBe("locked"); // cancelled, Touch ID off, no app: as before
    // no box on the page: the app is not asked (nobody touches for nothing)
    asked.length = 0;
    const none = [
      { frameId: 0, documentId: "doc0", result: { o: "https://example.com", a: [], top: true, c: [], x: 0, z: 0 } },
    ];
    expect((await go(none, answer)).out).toBe("nobox");
    expect(asked).toEqual([]);
  });

  it("switched off: the page is not looked at; Sixkey opens at its Fill button (`ask`), which says so", async () => {
    const { out, calls } = await w1b({ entries: vault(entry()), off: true });
    expect(out).toBe("ask");
    expect(calls).toEqual([]);
  });
  it("without `scripting`: nothing is looked at, `ask`; locked comes first, so the unlock is what the surface asks for", async () => {
    expect(await w1b({ entries: vault(entry()), held: false })).toEqual({ out: "ask", calls: [] });
    expect(await w1b({ entries: async () => null, held: false })).toEqual({ out: "locked", calls: [] });
    expect(await w1b({ entries: async () => null, off: true })).toEqual({ out: "locked", calls: [] });
    // and what needs no look is said as before (no account for the site)
    expect((await w1b({ entries: vault(entry({ domains: ["other.org"] })), held: false })).out).toBe("nosite");
  });
  it("the gate refuses after the look: switched off meanwhile opens Sixkey (`ask`), locked meanwhile asks for the unlock", async () => {
    const off = await w1b({ entries: vault(entry()), gate: "off" });
    expect(off.out).toBe("ask");
    expect(fillCalls(off.calls)).toEqual([]);
    const locked = await w1b({ entries: vault(entry()), gate: "locked" });
    expect(locked.out).toBe("locked");
    expect(fillCalls(locked.calls)).toEqual([]);
  });

  it("one account registered for the site, one box: fills, with the current code, in the document that was inspected", async () => {
    const { out, calls } = await run(TAB, vault(entry()));
    expect(out).toBe("filled");
    const f = fillCalls(calls);
    expect(f).toHaveLength(1);
    expect(f[0]!.target).toEqual({ tabId: 7, documentIds: ["doc0"] });
    expect(f[0]!.args).toEqual([
      "123456",
      "https://example.com",
      "example.com",
      "https://example.com",
      "0123456789abcdef",
    ]);
  });
  it("a locked vault is handed to the popup, and nothing is injected", async () => {
    const { out, calls } = await run(TAB, async () => null);
    expect(out).toBe("locked");
    expect(calls).toEqual([]);
  });
  it("no account registered for the site (a name guess is not enough): nothing is injected", async () => {
    const guess = entry({ domains: undefined });
    const other = entry({ domains: ["elsewhere.org"] });
    const { out, calls } = await run(TAB, vault(guess, other));
    expect(out).toBe("nosite");
    expect(calls).toEqual([]);
  });
  it("two accounts registered for the site: the popup chooses; nothing is injected", async () => {
    const { out, calls } = await run(TAB, vault(entry(), entry()));
    expect(out).toBe("choose");
    expect(calls).toEqual([]);
  });
  it("HOTP accounts do not count as a match", async () => {
    const { out } = await run(TAB, vault(entry({ type: "hotp" }), entry()));
    expect(out).toBe("filled");
  });
  it("what the page's answer to the fill makes of the outcome: a box that kept the code and went away is 'unsure', not 'failed'; a refused one is 'failed'", async () => {
    const r = (answer: unknown) => run(TAB, vault(entry()), page(topFrame(), answer)).then((x) => x.out);
    expect(await r({ ok: false, r: "moved" })).toBe("unsure");
    expect(await r({ ok: false, r: "refused" })).toBe("failed");
    expect(await r({ ok: false, r: "gone" })).toBe("failed");
    expect(await r({ ok: true, how: "single" })).toBe("filled");
  });
  it("a look the page does not answer in time is 'slow' (nothing is written), not 'blocked'", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("chrome", {
        windows: frontWindows,
        tabs: { get: frontTab },
        storage: openStorage(),
        scripting: { executeScript: vi.fn(() => new Promise(() => undefined)) },
      });
      const out = fillOnTab(TAB, vault(entry()), {
        code: async () => ({ code: "123456" }),
        now: () => 31_000,
        off: NOT_OFF,
      });
      await vi.advanceTimersByTimeAsync(8100);
      expect(await out).toBe("slow");
    } finally {
      vi.useRealTimers();
    }
  });
  it("a fill the page does not answer in time is 'unsure' (the code may be in the box)", async () => {
    vi.useFakeTimers();
    try {
      const calls: Call[] = [];
      vi.stubGlobal("chrome", {
        windows: frontWindows,
        tabs: { get: frontTab },
        storage: openStorage(),
        scripting: {
          executeScript: vi.fn((c: Call) => {
            calls.push(c);
            if (c.files) return Promise.resolve([]);
            if (c.target?.documentIds) return new Promise(() => undefined);
            return Promise.resolve(topFrame());
          }),
        },
      });
      const out = fillOnTab(TAB, vault(entry()), {
        code: async () => ({ code: "123456" }),
        now: () => 31_000,
        off: NOT_OFF,
      });
      await vi.advanceTimersByTimeAsync(8100);
      expect(await out).toBe("unsure");
    } finally {
      vi.useRealTimers();
    }
  });
  it("no box found: says so, writes nothing", async () => {
    const { out, calls } = await run(TAB, vault(entry()), page(topFrame([])));
    expect(out).toBe("nobox");
    expect(fillCalls(calls)).toEqual([]);
  });
  it("a box that is too short for the account's digits, or only a weak (focused) box: nobox, not a fill", async () => {
    expect((await run(TAB, vault(entry()), page(topFrame([found({ n: 4 })])))).out).toBe("nobox");
    expect((await run(TAB, vault(entry()), page(topFrame([found({ weak: true })])))).out).toBe("nobox");
    expect((await run(TAB, vault(entry({ digits: 8 })), page(topFrame([found({ k: 1, n: 6 })])))).out).toBe("nobox");
  });
  it("two boxes with no clear winner: the popup chooses", async () => {
    const { out, calls } = await run(
      TAB,
      vault(entry()),
      page(topFrame([found({ t: "a".repeat(16), s: 60 }), found({ t: "b".repeat(16), s: 70 })])),
    );
    expect(out).toBe("choose");
    expect(fillCalls(calls)).toEqual([]);
  });
  it("the vault locks during the wait for the next code: nothing is filled, the account's code is never worked out (the review's M-1)", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("chrome", {
      windows: frontWindows,
      tabs: { get: frontTab },
      storage: openStorage(),
      scripting: {
        executeScript: vi.fn(async (c: Call) => {
          calls.push(c);
          return c.files ? [] : c.target?.documentIds ? [{ result: { ok: true, how: "single" } }] : topFrame();
        }),
      },
    });
    let reads = 0;
    let clock = 27_000; // 3 s left of the period: the fill waits
    const code = vi.fn(async () => ({ code: "123456" }));
    const out = await fillOnTab(TAB, async () => (++reads === 1 ? [entry()] : null), {
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      code,
      off: NOT_OFF,
    });
    expect(out).toBe("locked");
    expect(reads).toBeGreaterThanOrEqual(2); // the vault was read again after the wait
    expect(fillCalls(calls)).toEqual([]);
    expect(code).not.toHaveBeenCalled();
  });
  it("the account is read again after the wait and the fresh one is used (a secret changed meanwhile)", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("chrome", {
      windows: frontWindows,
      tabs: { get: frontTab },
      storage: openStorage(),
      scripting: {
        executeScript: vi.fn(
          async (c: Call) => (
            calls.push(c),
            c.files ? [] : c.target?.documentIds ? [{ result: { ok: true, how: "single" } }] : topFrame()
          ),
        ),
      },
    });
    const first = entry();
    const fresh = { ...first, secret: "JBSWY3DPEHPK3PXP" };
    let reads = 0;
    const used: string[] = [];
    await fillOnTab(TAB, async () => (++reads === 1 ? [first] : [fresh]), {
      now: () => 31_000,
      code: async (e) => (used.push(e.secret), { code: "123456" }),
      off: NOT_OFF,
    });
    expect(used).toEqual([fresh.secret]);
  });
  it("the page cannot name the tab: a top frame that reports another origin than the tab's is not filled, whatever the account", async () => {
    const frames = [
      {
        frameId: 0,
        documentId: "doc0",
        result: { o: "https://evil.test", a: [], top: true, c: [found()], x: 0, z: 0 },
      },
    ];
    const { out, calls } = await run(TAB, vault(entry()), page(frames));
    expect(out).toBe("nobox");
    expect(fillCalls(calls)).toEqual([]);
  });
  it("the tab's address is the browser's, not the page's: a top frame of a registered host under another registered address is not the tab's page", async () => {
    // the tab is example.com; the page reports its top frame as login.example.com (also covered by the account's domain)
    const frames = [
      {
        frameId: 0,
        documentId: "doc0",
        result: { o: "https://login.example.com", a: [], top: true, c: [found()], x: 0, z: 0 },
      },
    ];
    const { out, calls } = await run(TAB, vault(entry()), page(frames));
    expect(out).toBe("nobox");
    expect(fillCalls(calls)).toEqual([]);
  });
  it("a page the extension cannot script: blocked", async () => {
    vi.stubGlobal("chrome", {
      windows: frontWindows,
      tabs: { get: frontTab },
      storage: openStorage(),
      scripting: { executeScript: vi.fn(async () => Promise.reject(new Error("Cannot access"))) },
    });
    expect(await fillOnTab(TAB, vault(entry()), { code: TEST_CODE, off: NOT_OFF })).toBe("blocked");
  });
  it("no tab, no address, or not a web page: blocked, and the vault is not even read", async () => {
    const read = vi.fn(async () => [entry()]);
    for (const tab of [
      undefined,
      { id: 1 },
      { id: 1, url: "chrome://extensions" },
      { id: 1, url: "file:///x" },
      { url: "https://example.com/" },
    ]) {
      vi.stubGlobal("chrome", {
        windows: frontWindows,
        tabs: { get: frontTab },
        storage: openStorage(),
        scripting: { executeScript: vi.fn() },
      });
      expect(await fillOnTab(tab, read, { code: TEST_CODE, off: NOT_OFF }), JSON.stringify(tab)).toBe("blocked");
    }
    expect(read).not.toHaveBeenCalled();
  });
  it("a page served over plain http asks first (M5): the popup; nothing is injected", async () => {
    const { out, calls } = await run({ ...TAB, url: "http://example.com/login" }, vault(entry()));
    expect(out).toBe("insecure");
    expect(calls).toEqual([]);
    expect(
      await run(
        { ...TAB, url: "http://10.0.0.5/" },
        vault(entry({ domains: ["10.0.0.5"] })),
        page(topFrame([found()], "http://10.0.0.5")),
      ),
    ).toMatchObject({ out: "filled" });
  });
  it("a page that refuses the code: failed", async () => {
    expect((await run(TAB, vault(entry()), page(topFrame(), { ok: false, r: "refused" }))).out).toBe("failed");
  });
  it("a frame of another site on a registered page is never filled", async () => {
    const frames = [
      ...topFrame([]),
      {
        frameId: 5,
        documentId: "evil",
        result: { o: "https://evil.test", a: ["https://example.com"], top: false, c: [found()], x: 0, z: 0 },
      },
    ];
    const { out, calls } = await run(TAB, vault(entry()), page(frames));
    expect(out).toBe("nobox");
    expect(fillCalls(calls)).toEqual([]);
  });
});

describe("reportFill: the toolbar icon says what happened, then goes back", () => {
  function chromeFake(opts: { openPopup?: "ok" | "throws" | "missing"; panel?: boolean } = {}) {
    const log: string[] = [];
    const state = { text: "SYNC", title: "Sixkey · 2" };
    const c: FillChrome = {
      action: {
        setBadgeText: async (o) => void log.push(`text:${o.tabId}:${o.text}`),
        setBadgeBackgroundColor: async (o) => void log.push(`color:${o.tabId}`),
        // Chrome's own check (probe in test/e2e/autofill1.spec.ts): a title is a string; null and nothing are refused, and ""
        // is accepted as this tab's own empty title (it does not reset it)
        setTitle: async (o) => {
          if (typeof (o as { title?: unknown }).title !== "string")
            throw new TypeError("Error in invocation of action.setTitle: Missing required property 'title'.");
          log.push(`title:${o.tabId}:${o.title}`);
        },
        getTitle: async () => state.title,
        ...(opts.openPopup === "missing"
          ? {}
          : {
              openPopup: async (o?: { windowId?: number }) => {
                if (opts.openPopup === "throws") throw new Error("no");
                log.push(`openPopup:${o?.windowId}`);
              },
            }),
      },
      ...(opts.panel
        ? { sidePanel: { open: async (o: { windowId: number }) => void log.push(`panel:${o.windowId}`) } }
        : {}),
      i18n: { getMessage: (k) => (k === "fillTitleOk" ? "Done!" : "") },
    };
    return { c, log, state };
  }
  const sleep = async () => undefined;
  it("filled: OK on this tab, then its badge is cleared (null: the global one shows again) and its title is set back to the global title, a string Chrome accepts (F1)", async () => {
    const { c, log } = chromeFake();
    await reportFill("filled", TAB, c, "popup", sleep);
    expect(log).toEqual(["text:7:OK", "color:7", "title:7:Done!", "text:7:null", "title:7:Sixkey · 2"]);
  });
  it("the title is restored even when clearing the badge fails, and a failing getTitle falls back to the name", async () => {
    const a = chromeFake();
    a.c.action.setBadgeText = async (o) => {
      if (o.text === null) throw new Error("no");
    };
    await reportFill("locked", TAB, a.c, "popup", sleep);
    expect(a.log).toContain("title:7:Sixkey · 2");
    const b = chromeFake();
    b.c.action.getTitle = async () => Promise.reject(new Error("no"));
    await reportFill("filled", TAB, b.c, "popup", sleep);
    expect(b.log.at(-1)).toBe("title:7:Sixkey");
  });
  it("what the tooltip says for a fill the page did not answer, and for a look it did not answer", async () => {
    const a = chromeFake();
    await reportFill("unsure", TAB, a.c, "popup", sleep);
    expect(a.log).toContain("title:7:Sixkey: the code may have been entered: check the page");
    const b = chromeFake();
    await reportFill("slow", TAB, b.c, "popup", sleep);
    expect(b.log).toContain("title:7:Sixkey: the page did not answer in time: try again");
  });
  it("a missing translation falls back to English text", async () => {
    const { c, log } = chromeFake();
    await reportFill("nobox", TAB, c, "popup", sleep);
    expect(log).toContain("title:7:Sixkey: no code box found on this page");
    expect(log).toContain("text:7:!");
  });
  it("locked, several accounts, plain http: the popup is opened (or the side panel, when the icon opens it)", async () => {
    for (const o of ["locked", "choose", "insecure"] as Outcome[]) {
      const a = chromeFake();
      await reportFill(o, TAB, a.c, "popup", sleep);
      expect(a.log, o).toContain("openPopup:3");
      const b = chromeFake({ panel: true });
      await reportFill(o, TAB, b.c, "panel", sleep);
      expect(b.log, o).toContain("panel:3");
      expect(b.log, o).not.toContain("openPopup:3");
    }
  });
  it("the other outcomes open nothing", async () => {
    for (const o of ["filled", "nobox", "nosite", "blocked", "failed", "unsure", "slow"] as Outcome[]) {
      const a = chromeFake({ panel: true });
      await reportFill(o, TAB, a.c, "panel", sleep);
      expect(
        a.log.filter((x) => /^(openPopup|panel):/.test(x)),
        o,
      ).toEqual([]);
    }
  });
  it("a browser that cannot open the popup from a shortcut leaves the tooltip to say so; nothing throws", async () => {
    for (const openPopup of ["throws", "missing"] as const) {
      const { c, log } = chromeFake({ openPopup });
      await expect(reportFill("locked", TAB, c, "popup", sleep)).resolves.toBeUndefined();
      expect(log).toContain("title:7:Sixkey is locked: open it to unlock");
    }
  });
  it("a tab that closed meanwhile: nothing throws", async () => {
    const { c } = chromeFake();
    c.action.setBadgeText = async () => Promise.reject(new Error("No tab with id"));
    await expect(reportFill("filled", TAB, c, "popup", sleep)).resolves.toBeUndefined();
    await expect(reportFill("filled", { windowId: 1 }, c, "popup", sleep)).resolves.toBeUndefined();
  });
});

describe("the service worker: the `fill` command", () => {
  async function world(es: Entry[], p = page(topFrame()), extra: { title?: string } = {}) {
    const gen = await legacyDeviceGeneration(
      es.map((e) => ({
        type: "totp",
        issuer: e.issuer,
        label: e.label,
        secret: e.secret,
        algorithm: e.algorithm,
        digits: e.digits,
        period: e.period,
        ...(e.domains ? { domains: e.domains } : {}),
      })) as never,
    );
    const badge: string[] = [];
    const w = await loadWorker({
      seedLocal: { sk_slot_a: gen, sk_active: "a", sk_keyring: { v: 1, savedAt: gen.savedAt, keyring: gen.keyring } },
      chrome: {
        tabs: { query: async () => [TAB], get: frontTab },
        windows: frontWindows,
        scripting: { executeScript: p.executeScript },
        i18n: { getMessage: () => "" },
        action: {
          getBadgeText: async () => "",
          getTitle: async () => extra.title ?? "Sixkey",
          setBadgeText: async (d: { tabId?: number; text: string | null }) =>
            void badge.push(`${d.tabId ?? "all"}:${d.text}`),
          setBadgeBackgroundColor: async () => undefined,
          setTitle: async () => undefined,
        },
      },
    });
    return { w, p, badge };
  }
  const press = async (w: Awaited<ReturnType<typeof loadWorker>>, tab: unknown = TAB) => {
    for (const l of w.listeners.command!) l("fill", tab);
    await wait(900);
  };
  it("is registered, and the lock command still locks", async () => {
    const { w } = await world([]);
    expect(w.listeners.command).toHaveLength(1);
  });
  it("fills the one matching account with its real, current code, and says OK on the icon", async () => {
    const { w, p, badge } = await world([entry()]);
    for (const l of w.listeners.command!) l("fill", TAB);
    await vi.waitFor(() => expect(fillCalls(p.calls)).toHaveLength(1), { timeout: 15_000 });
    await vi.waitFor(() => expect(badge).toContain("7:OK"), { timeout: 15_000 });
    const f = fillCalls(p.calls);
    expect(f).toHaveLength(1);
    expect(f[0]!.target).toEqual({ tabId: 7, documentIds: ["doc0"] });
    expect(f[0]!.args![0]).toMatch(/^\d{6}$/);
    expect(f[0]!.args!.slice(1)).toEqual([
      "https://example.com",
      "example.com",
      "https://example.com",
      "0123456789abcdef",
    ]);
    expect(badge).toContain("7:OK");
  });
  it("two accounts for the site: no injection, a mark on the icon, and the popup is asked for", async () => {
    const { w, p, badge } = await world([entry(), entry()]);
    await press(w);
    expect(p.calls).toEqual([]);
    expect(badge).toContain("7:!");
  });
  it("an account for another site: nothing happens to the page", async () => {
    const { w, p } = await world([entry({ domains: ["elsewhere.org"] })]);
    await press(w);
    expect(p.calls).toEqual([]);
  });
  it("without a tab in the event it asks the browser for the active one", async () => {
    const { w, p } = await world([entry()]);
    for (const l of w.listeners.command!) l("fill", undefined);
    await vi.waitFor(() => expect(fillCalls(p.calls)).toHaveLength(1), { timeout: 15_000 });
  });
});
