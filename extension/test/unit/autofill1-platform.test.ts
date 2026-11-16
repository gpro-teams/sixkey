// TOTP autofill, Stage 1: who may be filled and how (src/platform/autofill.ts, TOTP-AUTOFILL §4.4, §5, §8.2). The rules M1 to M5,
// the frame rule, the time window, the shape checks on what a page reports, and the three chrome.scripting calls with their
// exact targets and arguments, over a fake chrome.scripting.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Found, Inspected } from "../../src/inject/otp";
import {
  candidatesFor,
  choose,
  ENGINE_FILE,
  fillCand,
  fits,
  readInspected,
  PAGE_CALL_MS,
  scan,
  schemeOf,
  waitFor,
  type Cand,
  type Frame,
} from "../../src/platform/autofill";
import type { Entry } from "../../src/core/vault/model";
import { TEST_CODE } from "../helpers/gate";

/** The tab in front of a focused window: what platform/autofill.ts inFront asks before every fill (AUTOFILL2 patch 3). */
const frontTab = async (id: number) => ({ id, active: true, windowId: 1 });
const frontWindows = { get: async () => ({ focused: true }) };

/** Both storage areas close when asked: the gate before every injection passes (STORAGEGATE; its own tests are in autofill1-gate). */
const openStorage = () => ({
  local: { setAccessLevel: async () => undefined },
  session: { setAccessLevel: async () => undefined },
});

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // RFC 6238's seed
let n = 0;
const entry = (o: Partial<Entry> = {}): Entry =>
  ({
    id: `e${++n}`,
    createdAt: 0,
    type: "totp",
    issuer: "Example",
    label: "alice",
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
const frame = (o: { frameId?: number; origin: string; ancestors?: string[]; top?: boolean; c?: Found[] }): Frame => ({
  frameId: o.frameId ?? 0,
  documentId: `doc${o.frameId ?? 0}`,
  seen: { o: o.origin, a: o.ancestors ?? [], top: o.top ?? true, c: o.c ?? [found()], x: 0, z: 0 },
});
const PAGE = "https://example.com/login";
const top = frame({ origin: "https://example.com" });
const urls = (c: Cand[]) => c.map((x) => `${x.frameId}:${x.origin}`);

describe("who may be filled: only the registered tier (M1, M2, M3)", () => {
  it("an account registered for the page's domain or a parent of its host", () => {
    expect(candidatesFor(entry(), PAGE, [top])).toHaveLength(1);
    expect(
      candidatesFor(entry(), "https://login.example.com/x", [frame({ origin: "https://login.example.com" })]),
    ).toHaveLength(1);
    expect(
      candidatesFor(entry({ domains: ["login.example.com"] }), "https://login.example.com/", [
        frame({ origin: "https://login.example.com" }),
      ]),
    ).toHaveLength(1);
  });
  it("the candidate carries the origin, the top origin and the one domain that covers them: what the page checks again", () => {
    const [c] = candidatesFor(entry({ domains: ["other.org", "example.com"] }), "https://a.example.com/", [
      frame({ origin: "https://a.example.com" }),
    ]);
    expect(c).toMatchObject({
      origin: "https://a.example.com",
      top: "https://a.example.com",
      domain: "example.com",
      frameId: 0,
      documentId: "doc0",
    });
  });
  it('"possibly related" never fills: an issuer that looks like the host, with no registered domain', () => {
    expect(candidatesFor(entry({ issuer: "Example", domains: undefined }), PAGE, [top])).toEqual([]);
    expect(candidatesFor(entry({ issuer: "Example", domains: [] }), PAGE, [top])).toEqual([]);
  });
  it("an account registered for other sites gets nothing, however much its name looks like the host", () => {
    expect(candidatesFor(entry({ issuer: "Example", domains: ["elsewhere.org"] }), PAGE, [top])).toEqual([]);
  });
  it("look-alikes do not match (label boundaries, punycode, no decoding)", () => {
    for (const host of [
      "notexample.com",
      "example.com.attacker.io",
      "example.com-login.ru",
      "xn--exmple-cua.com",
      "example.co",
    ])
      expect(candidatesFor(entry(), `https://${host}/`, [frame({ origin: `https://${host}` })]), host).toEqual([]);
  });
  it("an IP address matches only itself", () => {
    const e = entry({ domains: ["10.0.0.5"] });
    expect(candidatesFor(e, "http://10.0.0.5:8080/x", [frame({ origin: "http://10.0.0.5:8080" })])).toHaveLength(1);
    expect(candidatesFor(e, "http://110.0.0.5/", [frame({ origin: "http://110.0.0.5" })])).toEqual([]);
    expect(candidatesFor(entry(), "http://1.2.3.4/", [frame({ origin: "http://1.2.3.4" })])).toEqual([]);
  });
  it("a stored domain that is not a usable host is ignored, never widened", () => {
    for (const d of ["com", "*.example.com", "https://example.com", "localhost", ""])
      expect(candidatesFor(entry({ domains: [d] }), PAGE, [top]), d).toEqual([]);
  });
  it("HOTP and erased accounts cannot be filled", () => {
    expect(candidatesFor(entry({ type: "hotp" }), PAGE, [top])).toEqual([]);
    expect(candidatesFor(entry({ secret: "" }), PAGE, [top])).toEqual([]);
  });
  it("no tab address, or a page that is not http(s): nothing", () => {
    for (const u of [
      undefined,
      "",
      "chrome://extensions",
      "about:blank",
      "file:///x",
      "chrome-extension://abc/x.html",
      "not a url",
    ])
      expect(candidatesFor(entry(), u, [top]), String(u)).toEqual([]);
  });
});

describe("a registered domain that is a shared suffix is never filled (defence in depth: a restore or a sync can bring one in)", () => {
  it("co.uk, github.io, vercel.app and the like cover nothing; an ordinary domain still does", () => {
    for (const [d, host] of [
      ["co.uk", "foo.co.uk"],
      ["github.io", "someone.github.io"],
      ["vercel.app", "x.vercel.app"],
      ["com.cn", "a.com.cn"],
    ] as const)
      expect(
        candidatesFor(entry({ domains: [d] }), `https://${host}/`, [frame({ origin: `https://${host}` })]),
        d,
      ).toEqual([]);
    expect(candidatesFor(entry({ domains: ["co.uk", "example.com"] }), PAGE, [top])).toHaveLength(1);
  });
});

describe("frames (M4)", () => {
  const e = entry();
  const inner = (origin: string, ancestors: string[], frameId = 3, c?: Found[]) =>
    frame({ frameId, origin, ancestors, top: false, ...(c ? { c } : {}) });
  it("a frame fills only if it and every page above it are covered by the same registered domain, and the top page is the tab's", () => {
    expect(urls(candidatesFor(e, PAGE, [inner("https://auth.example.com", ["https://example.com"])]))).toEqual([
      "3:https://auth.example.com",
    ]);
    // the frame is another site (a hostile page's frame) or the top page is not the tab's
    expect(candidatesFor(e, PAGE, [inner("https://evil.test", ["https://example.com"])])).toEqual([]);
    expect(candidatesFor(e, PAGE, [inner("https://auth.example.com", ["https://evil.test"])])).toEqual([]);
    expect(candidatesFor(e, PAGE, [inner("https://auth.example.com", ["https://other.example.com"])])).toEqual([]);
  });
  it("a hostile top page framing the real login page does not fill (the tab is the hostile one, so nothing is registered for it)", () => {
    expect(
      candidatesFor(e, "https://evil.test/", [
        frame({ origin: "https://evil.test", c: [] }),
        inner("https://example.com", ["https://evil.test"]),
      ]),
    ).toEqual([]);
  });
  it("an intermediate page that is not covered blocks the frame", () => {
    expect(
      candidatesFor(e, PAGE, [inner("https://auth.example.com", ["https://evil.test", "https://example.com"])]),
    ).toEqual([]);
    expect(
      urls(
        candidatesFor(e, PAGE, [inner("https://auth.example.com", ["https://a.example.com", "https://example.com"])]),
      ),
    ).toEqual(["3:https://auth.example.com"]);
  });
  it("a frame whose report has no ancestors (the browser gave none) is not trusted as a frame of the tab", () => {
    expect(candidatesFor(e, PAGE, [inner("https://auth.example.com", [])])).toEqual([]);
    expect(candidatesFor(e, PAGE, [inner("https://auth.example.com", ["?"] as unknown as string[])])).toEqual([]);
  });
  it("two domains of one account do not mix: one domain must cover the frame and all its ancestors", () => {
    const two = entry({ domains: ["example.com", "example.org"] });
    expect(candidatesFor(two, PAGE, [inner("https://auth.example.org", ["https://example.com"])])).toEqual([]);
  });
  it("a top frame that says it is not the tab's origin is dropped", () => {
    expect(candidatesFor(e, PAGE, [frame({ origin: "https://login.example.com" })])).toEqual([]);
  });
  it("the top page's boxes come before a frame's, then the better score", () => {
    const f = inner("https://auth.example.com", ["https://example.com"], 5, [found({ s: 99, t: "aaaaaaaaaaaaaaaa" })]);
    const t = frame({
      origin: "https://example.com",
      c: [found({ s: 50, t: "bbbbbbbbbbbbbbbb" }), found({ s: 60, t: "cccccccccccccccc" })],
    });
    expect(candidatesFor(e, PAGE, [f, t]).map((c) => c.found.t)).toEqual([
      "cccccccccccccccc",
      "bbbbbbbbbbbbbbbb",
      "aaaaaaaaaaaaaaaa",
    ]);
  });
});

describe("the page's scheme (M5)", () => {
  it("https is fine, http asks first except for an IP address, anything else is no page", () => {
    expect(schemeOf("https://example.com/")).toBe("ok");
    expect(schemeOf("http://192.168.1.2:5001/")).toBe("ok");
    expect(schemeOf("http://[::1]/")).toBe("ok");
    expect(schemeOf("http://example.com/")).toBe("insecure");
    expect(schemeOf("http://localhost:3000/")).toBe("insecure");
    for (const u of ["ftp://example.com", "chrome://x", "file:///x", "javascript:alert(1)", "", undefined, "nope"])
      expect(schemeOf(u as string | undefined), String(u)).toBe("no");
  });
});

describe("which box, and does the code fit", () => {
  const cand = (o: Partial<Found>): Cand => ({
    frameId: 0,
    documentId: "d",
    origin: "https://example.com",
    top: "https://example.com",
    domain: "example.com",
    found: found(o),
  });
  it("a single box fits when it takes at least the code's digits (or has no limit); a group fits at exactly that size", () => {
    expect(fits(cand({ k: 0, n: 6 }), 6)).toBe(true);
    expect(fits(cand({ k: 0, n: 0 }), 8)).toBe(true);
    expect(fits(cand({ k: 0, n: 8 }), 6)).toBe(true);
    expect(fits(cand({ k: 0, n: 4 }), 6)).toBe(false);
    expect(fits(cand({ k: 1, n: 6 }), 6)).toBe(true);
    expect(fits(cand({ k: 1, n: 6 }), 8)).toBe(false);
    expect(fits(cand({ k: 1, n: 8 }), 6)).toBe(false);
  });
  it("the best box wins when it leads by 20 or more, else the user chooses; weak and ill-fitting boxes are not chosen", () => {
    expect(choose([cand({ s: 80 })], 6)?.found.s).toBe(80);
    expect(choose([cand({ s: 80 }), cand({ s: 60 })], 6)?.found.s).toBe(80);
    expect(choose([cand({ s: 80 }), cand({ s: 61 })], 6)).toBeNull();
    expect(choose([cand({ s: 80, n: 4 }), cand({ s: 60 })], 6)?.found.s).toBe(60);
    expect(choose([cand({ s: 80, weak: true })], 6)).toBeNull();
    expect(choose([], 6)).toBeNull();
  });
});

describe("the time window (§8.2): fill the current code only with 5 s or more left", () => {
  const e = { period: 30 };
  it("waits for the next period when under 5 s remain, and not otherwise", () => {
    expect(waitFor(e, 30)).toBe(0);
    expect(waitFor(e, 12.5)).toBe(0);
    expect(waitFor(e, 5)).toBe(0);
    expect(waitFor(e, 4.999)).toBeGreaterThan(4999);
    expect(waitFor(e, 4.2)).toBe(4200 + 60);
    expect(waitFor(e, 0.2)).toBe(200 + 60);
  });
  it("a very short period cannot keep the 5 s rule: half of it is the limit", () => {
    expect(waitFor({ period: 8 }, 4)).toBe(0);
    expect(waitFor({ period: 8 }, 3.9)).toBeGreaterThan(3900);
  });
});

describe("what a page reports is checked down to numbers and short text", () => {
  const good: Inspected = { o: "https://example.com", a: [], top: true, c: [found()], x: 0, z: 0 };
  it("accepts a well-formed report", () => expect(readInspected(good)).toEqual(good));
  it("refuses anything else", () => {
    const bad: unknown[] = [
      null,
      undefined,
      "x",
      [],
      { ...good, o: "javascript:alert(1)" },
      { ...good, o: "https://example.com/path" },
      { ...good, o: "https://a b" },
      { ...good, top: "yes" },
      { ...good, z: 2 },
      { ...good, z: undefined },
      { ...good, x: -1 },
      { ...good, x: 100 },
      { ...good, x: "1" },
      { ...good, x: undefined },
      { ...good, a: "https://x.com" },
      { ...good, a: Array.from({ length: 21 }, () => "https://a.com") },
      { ...good, a: ["ftp://x"] },
      { ...good, c: Array.from({ length: 5 }, () => found()) },
      { ...good, c: [{ ...found(), t: "not-a-token" }] },
      { ...good, c: [{ ...found(), t: "0123456789ABCDEF" }] },
      { ...good, c: [{ ...found(), k: 2 }] },
      { ...good, c: [{ ...found(), n: -1 }] },
      { ...good, c: [{ ...found(), n: 65 }] },
      { ...good, c: [{ ...found(), n: 1.5 }] },
      { ...good, c: [{ ...found(), s: "9" }] },
      { ...good, c: [{ ...found(), sent: 1 }] },
      { ...good, c: [{ ...found(), lab: "x".repeat(33) }] },
      // TOTP autofill Stage 3 (AF3-2): a site rule's box is r: 1, the heuristics' has no r
      { ...good, c: [{ ...found(), r: 0 }] },
      { ...good, c: [{ ...found(), r: 2 }] },
      { ...good, c: [{ ...found(), r: "1" }] },
      { ...good, c: [{ ...found(), r: true }] },
      { ...good, c: [{ ...found(), r: null }] },
      { ...good, c: [null] },
    ];
    for (const b of bad) expect(readInspected(b), JSON.stringify(b)).toBeNull();
  });
  it("keeps only the known fields (a page cannot smuggle others through)", () => {
    const r = readInspected({
      ...good,
      extra: 1,
      c: [{ ...found(), account: "x", domain: "evil.test" }],
    }) as unknown as { extra?: unknown; c: Record<string, unknown>[] };
    expect(r.extra).toBeUndefined();
    expect(Object.keys(r.c[0]!).sort()).toEqual(["k", "lab", "n", "s", "sent", "t", "weak"]);
    // a site rule's box keeps its mark, and only that (AF3-2)
    const ruled = readInspected({ ...good, c: [{ ...found(), r: 1 }, found()] })!;
    expect(ruled.c.map((c) => c.r)).toEqual([1, undefined]);
    expect(Object.keys(ruled.c[0]!).sort()).toEqual(["k", "lab", "n", "r", "s", "sent", "t", "weak"]);
    expect(Object.keys(ruled.c[1]!)).not.toContain("r");
  });
});

type Call = { target: Record<string, unknown>; files?: string[]; func?: unknown; args?: unknown[] };
function fakeChrome(handler: (c: Call, i: number) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal("chrome", {
    windows: frontWindows,
    tabs: { get: frontTab },
    storage: openStorage(),
    scripting: {
      executeScript: vi.fn(async (c: Call) => {
        calls.push(c);
        const r = handler(c, calls.length - 1);
        if (r instanceof Error) throw r;
        return r;
      }),
    },
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe("scan: the finder is installed and asked, in every frame the browser allows", () => {
  it("installs the file in all frames, then inspects all frames, and returns each frame's report with its IDs", async () => {
    const calls = fakeChrome((_, i) =>
      i === 0
        ? []
        : [
            {
              frameId: 0,
              documentId: "top-doc",
              result: { o: "https://example.com", a: [], top: true, c: [found()], x: 0, z: 0 },
            },
            {
              frameId: 7,
              documentId: "frame-doc",
              result: { o: "https://auth.example.com", a: ["https://example.com"], top: false, c: [], x: 0, z: 0 },
            },
            { frameId: 9, documentId: "junk", result: { o: "javascript:1", a: [], top: true, c: [], x: 0, z: 0 } },
            { frameId: 11, documentId: "none", result: undefined },
          ],
    );
    const r = await scan(41);
    expect(calls[0]).toEqual({ target: { tabId: 41, allFrames: true }, files: [ENGINE_FILE] });
    expect(calls[1]!.target).toEqual({ tabId: 41, allFrames: true });
    // no code, no account: only the site rule's hint, null while no rule reaches the Fill paths (AF3-2)
    expect(calls[1]!.args).toEqual([null]);
    expect(r.k === "ok" && r.frames.map((f) => [f.frameId, f.documentId])).toEqual([
      [0, "top-doc"],
      [7, "frame-doc"],
    ]);
  });
  it("passes the hint it is given to the look, as its one argument, and nothing else (AF3-2)", async () => {
    const calls = fakeChrome(() => []);
    const hint = { d: ["example.com"], p: [{ at: "/2fa", sel: "input#otp", n: 0, how: 0 as const }], sent: false };
    await scan(41, hint);
    expect(calls[1]!.args).toEqual([hint]);
    expect(calls).toHaveLength(2);
  });
  it("a tab that cannot be scripted is blocked, not an error", async () => {
    fakeChrome(() => new Error("Cannot access a chrome:// URL"));
    expect(await scan(1)).toEqual({ k: "blocked" });
  });
  it("without `scripting` (optional since W1b: not asked for yet, or given back) it says a click must ask first", async () => {
    vi.stubGlobal("chrome", { storage: openStorage() });
    expect(await scan(1)).toEqual({ k: "ask" });
    // Chrome's answer is what counts where it has a permissions API: the namespace stays after the permission is given back
    vi.stubGlobal("chrome", {
      storage: openStorage(),
      scripting: { executeScript: async () => [] },
      permissions: { contains: async () => false },
    });
    expect(await scan(1)).toEqual({ k: "ask" });
  });
});

describe("a page can hold a call up: the extension stops waiting", () => {
  afterEach(() => vi.useRealTimers());
  it("a look that never answers is slow (not blocked) after PAGE_CALL_MS; a fill that never answers is slow, and no code is retried", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("chrome", {
      windows: frontWindows,
      tabs: { get: frontTab },
      storage: openStorage(),
      scripting: { executeScript: vi.fn(() => new Promise(() => undefined)) },
    });
    const looking = scan(5);
    await vi.advanceTimersByTimeAsync(PAGE_CALL_MS + 10);
    expect(await looking).toEqual({ k: "slow" });
    const e = entry();
    const cand: Cand = {
      frameId: 0,
      documentId: "d",
      origin: "https://example.com",
      top: "https://example.com",
      domain: "example.com",
      found: found(),
    };
    const filling = fillCand(5, e, cand, { now: () => 1_700_000_005_000, code: async () => ({ code: "333333" }) });
    await vi.advanceTimersByTimeAsync(PAGE_CALL_MS + 10);
    expect(await filling).toEqual({ k: "failed", r: "slow" });
    expect(vi.mocked(chrome.scripting.executeScript)).toHaveBeenCalledTimes(2); // the install (never answered), then the fill: one try each
  });
});

describe("a page that installs the finder but never answers the look", () => {
  afterEach(() => vi.useRealTimers());
  it("is slow too (not 'blocked': that says the page cannot be looked at at all)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("chrome", {
      windows: frontWindows,
      tabs: { get: frontTab },
      storage: openStorage(),
      scripting: {
        executeScript: vi.fn((c: { files?: string[] }) =>
          c.files ? Promise.resolve([]) : new Promise(() => undefined),
        ),
      },
    });
    const looking = scan(5);
    await vi.advanceTimersByTimeAsync(PAGE_CALL_MS + 10);
    expect(await looking).toEqual({ k: "slow" });
    expect(vi.mocked(chrome.scripting.executeScript)).toHaveBeenCalledTimes(2);
  });
});

describe("fillCand: one code, to one document, with nothing else", () => {
  const e = entry();
  const cand: Cand = {
    frameId: 4,
    documentId: "DOC-4",
    origin: "https://example.com",
    top: "https://example.com",
    domain: "example.com",
    found: found({ t: "feedfacefeedface" }),
  };
  const T0 = 1_700_000_000_000;
  // a clock 10 s into a period (20 s left), and one 27 s into it (3 s left)
  const at = (offsetIntoPeriodS: number) => Math.floor(T0 / 30_000) * 30_000 + offsetIntoPeriodS * 1000;

  it("sends exactly the code as the only secret, to exactly the document, never to all frames", async () => {
    const calls = fakeChrome(() => [{ result: { ok: true, how: "single" } }]);
    const r = await fillCand(12, e, cand, { now: () => at(10), code: async () => ({ code: "654321" }) });
    expect(r).toEqual({ k: "filled", how: "single" });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.target).toEqual({ tabId: 12, documentIds: ["DOC-4"] });
    expect(Object.keys(c.target).sort()).toEqual(["documentIds", "tabId"]); // no allFrames, no frameIds
    expect(c.args).toEqual(["654321", "https://example.com", "example.com", "https://example.com", "feedfacefeedface"]);
    expect(c.files).toBeUndefined();
    // the account itself (its name, secret, other domains) is nowhere in the call
    expect(JSON.stringify(c.args)).not.toMatch(new RegExp(`${SECRET}|alice|Example`));
    expect(typeof c.func).toBe("function");
  });
  it("the code it sends is the account's current code (RFC 6238, SHA-1, T = 31 s: counter 1, 287082)", async () => {
    const calls = fakeChrome(() => [{ result: { ok: true, how: "single" } }]);
    await fillCand(1, e, cand, { now: () => 31_000, code: TEST_CODE });
    expect(calls[0]!.args![0]).toBe("287082");
  });
  it("a cancel that is only known after the wait (the vault locked meanwhile) stops the fill before the code is even worked out", async () => {
    const calls = fakeChrome(() => [{ result: { ok: true, how: "single" } }]);
    const code = vi.fn(async () => ({ code: "111111" }));
    let locked = false;
    const r = await fillCand(1, e, cand, {
      now: () => at(28),
      sleep: async () => void (locked = true),
      cancelled: async () => locked,
      code,
    });
    expect(r).toEqual({ k: "cancelled" });
    expect(code).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
  it("a vault read again after the wait that has no such account (locked, or deleted) stops it too; a changed account is the one used", async () => {
    fakeChrome(() => [{ result: { ok: true, how: "single" } }]);
    const code = vi.fn(async () => ({ code: "222222" }));
    expect(await fillCand(1, e, cand, { now: () => at(5), recheck: async () => null, code })).toEqual({
      k: "cancelled",
    });
    expect(code).not.toHaveBeenCalled();
    const renamed = { ...e, secret: "JBSWY3DPEHPK3PXP" };
    await fillCand(1, e, cand, { now: () => at(5), recheck: async () => renamed, code });
    expect(code).toHaveBeenCalledWith(renamed, expect.any(Number));
  });
  it("with 5 s or more left it fills at once; with less it waits for the next period and fills that code", async () => {
    let clock = at(27); // 3 s left
    const slept: number[] = [];
    const waited: number[] = [];
    const codes: number[] = [];
    const calls = fakeChrome(() => [{ result: { ok: true, how: "single" } }]);
    const r = await fillCand(1, e, cand, {
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      waiting: (ms) => waited.push(ms),
      code: async (_e, t) => (codes.push(t), { code: "111111" }),
    });
    expect(r.k).toBe("filled");
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThanOrEqual(3000);
    expect(waited).toEqual(slept);
    // the code was worked out AFTER the wait, in the next period
    expect(codes).toHaveLength(1);
    expect(Math.floor(codes[0]! / 30_000)).toBe(Math.floor(at(27) / 30_000) + 1);
    expect(calls).toHaveLength(1);

    clock = at(25); // exactly 5 s left: now
    slept.length = 0;
    await fillCand(1, e, cand, {
      now: () => clock,
      sleep: async (ms) => void slept.push(ms),
      code: async () => ({ code: "222222" }),
    });
    expect(slept).toEqual([]);
  });
  it("F7: after the wait, a tab or an address the user has left gets nothing (the code is not even worked out); with no wait the question is not asked; a lock still wins", async () => {
    const calls = fakeChrome(() => [{ result: { ok: true, how: "single" } }]);
    const code = vi.fn(async () => ({ code: "555555" }));
    const sleep = async () => undefined;
    for (const left of ["tab", "page"] as const)
      expect(await fillCand(1, e, cand, { now: () => at(28), sleep, away: async () => left, code })).toEqual({
        k: "failed",
        r: left,
      });
    expect(code).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    // still in front after the wait: filled
    expect((await fillCand(1, e, cand, { now: () => at(28), sleep, away: async () => null, code })).k).toBe("filled");
    // no wait (5 s or more left): the press has just looked at the tab in front; nothing is asked
    const away = vi.fn(async () => "tab" as const);
    expect((await fillCand(1, e, cand, { now: () => at(10), sleep, away, code })).k).toBe("filled");
    expect(away).not.toHaveBeenCalled();
    // the vault locked during the wait AND the user left: cancelled, as for a lock (nothing filled, no note of a page)
    expect(
      await fillCand(1, e, cand, { now: () => at(28), sleep, cancelled: () => true, away: async () => "tab", code }),
    ).toEqual({ k: "cancelled" });
    expect(calls).toHaveLength(2);
  });
  it("a cancel during the wait writes nothing", async () => {
    const calls = fakeChrome(() => [{ result: { ok: true, how: "single" } }]);
    const r = await fillCand(1, e, cand, {
      now: () => at(28),
      sleep: async () => undefined,
      cancelled: () => true,
      code: async () => ({ code: "333333" }),
    });
    expect(r).toEqual({ k: "cancelled" });
    expect(calls).toHaveLength(0);
  });
  it("a document that is gone (navigated, reloaded, closed) fails with nothing written", async () => {
    fakeChrome(() => new Error("No document with id DOC-4"));
    expect(await fillCand(1, e, cand, { now: () => at(5), code: async () => ({ code: "444444" }) })).toEqual({
      k: "failed",
      r: "gone",
    });
  });
  it("the page's answer is read as an enum: ok with a known strategy, or a known reason, else gone", async () => {
    for (const [answer, want] of [
      [
        { ok: true, how: "chars" },
        { k: "filled", how: "chars" },
      ],
      [
        { ok: true, how: "paste" },
        { k: "filled", how: "paste" },
      ],
      [
        { ok: true, how: "evil" },
        { k: "failed", r: "gone" },
      ],
      [
        { ok: false, r: "origin" },
        { k: "failed", r: "origin" },
      ],
      [
        { ok: false, r: "frame" },
        { k: "failed", r: "frame" },
      ],
      [
        { ok: false, r: "digits" },
        { k: "failed", r: "digits" },
      ],
      [
        { ok: false, r: "refused" },
        { k: "failed", r: "refused" },
      ],
      [
        { ok: false, r: "moved" },
        { k: "failed", r: "moved" },
      ],
      [
        { ok: false, r: "<script>" },
        { k: "failed", r: "gone" },
      ],
      [undefined, { k: "failed", r: "gone" }],
      ["ok", { k: "failed", r: "gone" }],
    ] as const) {
      fakeChrome(() => [{ result: answer }]);
      expect(
        await fillCand(1, e, cand, { now: () => at(5), code: async () => ({ code: "555555" }) }),
        JSON.stringify(answer),
      ).toEqual(want);
    }
  });
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(console, "log");
  });
  afterEach(() => spy.mockRestore());
  it("nothing is logged, whatever happens", async () => {
    const err = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    fakeChrome(() => [{ result: { ok: false, r: "refused" } }]);
    await fillCand(1, e, cand, { now: () => at(5), code: async () => ({ code: "987654" }) });
    fakeChrome(() => new Error("987654"));
    await fillCand(1, e, cand, { now: () => at(5), code: async () => ({ code: "987654" }) });
    for (const s of [spy, err, warn]) expect(s).not.toHaveBeenCalled();
    err.mockRestore();
    warn.mockRestore();
  });
});
