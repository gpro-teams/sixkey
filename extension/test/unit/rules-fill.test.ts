// TOTP autofill Stage 3, AF3-3b: the popup's and the side panel's Fill paths take the page's site rule
// (docs/design/notes/AUTOFILL3-NOTES.md §5).
//   - platform/site-rule.ts ruleForPage: the rule for the top page's host (exact) in the rules in effect (the package's
//     baseline: no live bundle), as the finder's hint and the site's minLeft; nothing on anything wrong;
//   - platform/autofill.ts scan given the rule still being read: installed at once, the look waits for the rule and passes
//     its hint as its one argument, the same calls as a plain hint's, frames and a slow look as for every look (one look
//     for every Fill path: round 2, the review's SHOULD-1); fillCand's wait with the rule's minLeft is waitFor's (one
//     formula: at least minLeft, at most half the period);
//   - who calls what: the Fill chunk alone reads rules, with `scripting` held; the worker's shortcut does not (the
//     maintainers' C27): check-dist refuses the read in sw.js, and the worker grows by the shared look's few bytes only.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "../../src/core/vault/model";
import type { Found } from "../../src/inject/otp";
import { parseBaseline } from "../../src/core/rules/baseline";
import { ENGINE_FILE, fillCand, MIN_LEFT_S, PAGE_CALL_MS, scan, waitFor, type Cand } from "../../src/platform/autofill";
import { e2eBaselineText } from "../../scripts/rules-package.mjs";

const EXT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(EXT, p), "utf8");
const COMMITTED = read("../rules/build/baseline.json");
const bundleOf = (text: string) => {
  const r = parseBaseline(text, { allowReserved: true });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock("../../src/platform/package-data");
});

/** ruleForPage with the package's read answering `bundle` (or failing): a fresh module each time. */
async function ruleForPageWith(read: () => Promise<unknown>) {
  const readRules = vi.fn(read);
  vi.doMock("../../src/platform/package-data", () => ({ readRules }));
  const m = await import("../../src/platform/site-rule");
  return { ruleForPage: m.ruleForPage, NO_RULE: m.NO_RULE, readRules };
}

describe("ruleForPage (platform/site-rule.ts): the page's rule as the Fill paths take it", () => {
  it("the rule of the top page's host, exactly, from the e2e build's bundle: its hint and minLeft", async () => {
    const bundle = bundleOf(await e2eBaselineText(COMMITTED));
    const { ruleForPage, NO_RULE } = await ruleForPageWith(async () => bundle);
    expect(await ruleForPage("http://rules.fix.test:8080/rule/one?x=1")).toEqual({
      hint: { d: ["rules.fix.test"], p: [{ at: "/rule/", sel: "#code-box", n: 0, how: 0 }], sent: false },
      minLeft: null,
      appends: false,
    });
    expect(await ruleForPage("https://RULES2.fix.test./rule/six")).toEqual({
      hint: { d: ["rules2.fix.test"], p: [{ at: "/rule/", sel: "input.digit", n: 6, how: 1 }], sent: true },
      minLeft: 20,
      appends: false,
    });
    // exact hosts: no parent, no child, no www. variant; and only http(s) pages
    for (const url of [
      "http://fix.test/rule/one",
      "http://a.rules.fix.test/rule/one",
      "http://www.rules.fix.test/rule/one",
      "http://app.fix.test/rule/one",
    ])
      expect(await ruleForPage(url), url).toEqual(NO_RULE);
  });
  it("no rule without reading at all for a page that is no http(s) page; a failed or refused read is no rule", async () => {
    const bundle = bundleOf(await e2eBaselineText(COMMITTED));
    const a = await ruleForPageWith(async () => bundle);
    for (const url of [undefined, "", "chrome://newtab/", "file:///x.html", "not a url"])
      expect(await a.ruleForPage(url as string | undefined)).toEqual(a.NO_RULE);
    expect(a.readRules).not.toHaveBeenCalled();
    vi.resetModules();
    const b = await ruleForPageWith(async () => null); // no bundle (the read failed: platform/package-data.ts)
    expect(await b.ruleForPage("http://rules.fix.test/rule/one")).toEqual(b.NO_RULE);
    vi.resetModules();
    const c = await ruleForPageWith(() => Promise.reject(new Error("x")));
    expect(await c.ruleForPage("http://rules.fix.test/rule/one")).toEqual(c.NO_RULE);
  });
  it("the store build's bundle (no rule yet) gives no rule for any page, the fixture pages' hosts among them", async () => {
    const bundle = bundleOf(COMMITTED);
    expect(bundle.rules.size).toBe(0);
    const { ruleForPage, NO_RULE } = await ruleForPageWith(async () => bundle);
    for (const host of ["rules.fix.test", "app.fix.test", "127.0.0.1", "example.com", "x.com"])
      expect(await ruleForPage(`https://${host}/rule/one`)).toEqual(NO_RULE);
  });
  it("in the e2e build, only the two test rules' hosts have a rule: every other fixture host has none", async () => {
    // (the e2e build's test host of the code after the password, and its subdomain, have that note and no rule: AF3-5,
    // test/unit/rules-appends.test.ts)
    const appends = new Set(["append.fix.test", "us.append.fix.test"]);
    const bundle = bundleOf(await e2eBaselineText(COMMITTED));
    expect([...bundle.hosts.keys()].sort()).toEqual(["rules.fix.test", "rules2.fix.test"]);
    const helpers = read("test/e2e/autofill-helpers.ts");
    const hosts = [...helpers.matchAll(/"([a-z0-9.-]+\.(?:test|0\.0\.1))"/g)].map((m) => m[1]!);
    expect(hosts).toEqual(
      expect.arrayContaining(["app.fix.test", "granted.fix.test", "tls.fix.test", ...appends, "notappend.fix.test"]),
    );
    const { ruleForPage, NO_RULE } = await ruleForPageWith(async () => bundle);
    for (const h of hosts.filter((h) => !h.startsWith("rules")))
      expect(await ruleForPage(`http://${h}/owner`), h).toEqual({ ...NO_RULE, appends: appends.has(h) });
  });
});

type Call = { target: Record<string, unknown>; files?: string[]; func?: unknown; args?: unknown[] };
const openStorage = () => ({
  local: { setAccessLevel: async () => undefined },
  session: { setAccessLevel: async () => undefined },
});
function fakeChrome(handler: (c: Call, i: number) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal("chrome", {
    windows: { get: async () => ({ focused: true }) },
    tabs: { get: async (id: number) => ({ id, active: true, windowId: 1 }) },
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
const report = { o: "https://example.com", a: [], top: true, c: [], x: 0, z: 0 };

describe("scan (platform/autofill.ts) given the rule still being read: one look for every Fill path", () => {
  const hint = { d: ["example.com"], p: [{ at: "/2fa", sel: "input#otp", n: 0, how: 0 as const }], sent: false };
  it("installs at once, and looks with the hint as its one argument once both are there: the calls of a plain hint", async () => {
    const order: string[] = [];
    let give!: (h: typeof hint) => void;
    const calls = fakeChrome((c) => {
      order.push(c.files ? "install" : "look");
      return c.files ? [] : [{ frameId: 0, documentId: "d", result: report }];
    });
    const r = scan(7, new Promise((ok) => (give = ok)));
    await vi.waitFor(() => expect(order).toEqual(["install"])); // the install does not wait for the rule
    await new Promise((x) => setTimeout(x, 20));
    expect(order).toEqual(["install"]); // and the look waits for it
    give(hint);
    expect((await r).k).toBe("ok");
    expect(order).toEqual(["install", "look"]);
    expect(calls[0]).toEqual({ target: { tabId: 7, allFrames: true }, files: [ENGINE_FILE] });
    expect(calls[1]!.target).toEqual({ tabId: 7, allFrames: true });
    expect(calls[1]!.args).toEqual([hint]);
    // the same calls as with the hint itself, and as the shortcut's (no hint: null)
    const plain = fakeChrome((c) => (c.files ? [] : [{ frameId: 0, documentId: "d", result: report }]));
    await scan(7, hint);
    await scan(7);
    expect(plain.slice(0, 2).map(({ target, files, args }) => ({ target, files, args }))).toEqual(
      calls.map(({ target, files, args }) => ({ target, files, args })),
    );
    expect(plain[3]!.args).toEqual([null]);
    expect(plain[1]!.func).toBe(calls[1]!.func);
  });
  it("a rule read that fails is no hint: the look goes on with null (the heuristics alone)", async () => {
    const calls = fakeChrome((c) => (c.files ? [] : []));
    expect((await scan(7, Promise.reject(new Error("lost")))).k).toBe("ok");
    expect(calls[1]!.args).toEqual([null]);
  });
  it("keeps only frames the browser names by number and document ID, whatever a page answers", async () => {
    fakeChrome((c) =>
      c.files
        ? []
        : [
            { frameId: 0, documentId: "top", result: report },
            { frameId: 3, documentId: 42, result: report }, // not a document ID
            { frameId: "x", documentId: "doc", result: report }, // not a frame number
            { frameId: 4, documentId: "doc4", result: { ...report, o: "javascript:1" } }, // not a report
          ],
    );
    const r = await scan(7, Promise.resolve(hint));
    expect(r.k === "ok" && r.frames.map((f) => [f.frameId, f.documentId])).toEqual([[0, "top"]]);
  });
  it("a look that never answers is slow, with the rule read or without (the page holds the call up)", async () => {
    vi.useFakeTimers();
    try {
      fakeChrome((c) => (c.files ? [] : new Promise(() => undefined)));
      const r = scan(7, Promise.resolve(hint));
      await vi.advanceTimersByTimeAsync(PAGE_CALL_MS + 10);
      expect(await r).toEqual({ k: "slow" });
    } finally {
      vi.useRealTimers();
    }
  });
  it("asks nothing of the page without `scripting`, and a page that cannot be scripted is blocked", async () => {
    vi.stubGlobal("chrome", { storage: openStorage() });
    expect(await scan(1, Promise.resolve(null))).toEqual({ k: "ask" });
    fakeChrome(() => new Error("Cannot access a chrome:// URL"));
    expect(await scan(1, Promise.resolve(hint))).toEqual({ k: "blocked" });
  });
});

describe("fillCand (platform/autofill.ts) with the rule's minLeft: one wait formula, waitFor's", () => {
  const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const e = { id: "e1", type: "totp", secret: SECRET, algorithm: "SHA1", digits: 6, period: 30 } as Entry;
  const found: Found = { t: "feedfacefeedface", k: 0, n: 6, s: 70, sent: false, weak: false, lab: "" };
  const cand: Cand = {
    frameId: 0,
    documentId: "D",
    origin: "https://a.test",
    top: "https://a.test",
    domain: "a.test",
    found,
  };
  /** A clock `s` seconds into a period. */
  const at = (s: number) => 1_700_000_010_000 - (1_700_000_010_000 % 30_000) + s * 1000;
  const run = async (s: number, minLeft: number | null | undefined, extra: Record<string, unknown> = {}) => {
    const calls = fakeChrome(() => [{ result: { ok: true, how: "single" } }]);
    let clock = at(s);
    const waits: number[] = [];
    const asked: string[] = [];
    const r = await fillCand(3, e, cand, {
      ...(minLeft === undefined ? {} : { minLeft }),
      now: () => clock,
      sleep: async (ms) => void (waits.push(ms), (clock += ms)),
      waiting: (ms) => void asked.push(`waiting ${ms}`),
      away: async () => (asked.push("away"), null),
      code: async () => ({ code: "123456" }),
      ...extra,
    });
    return { r, calls, waits, asked };
  };
  it("waitFor: at least minLeft (MIN_LEFT_S unless given), at most half the period", () => {
    const p30 = { period: 30 };
    for (const [left, minLeft, want] of [
      [12, undefined, 0],
      [4.5, undefined, 4560],
      [12, 20, 12_060], // capped at 15
      [16, 20, 0],
      [11, 10, 0],
      [9, 10, 9_060],
    ] as const)
      expect(waitFor(p30, left, minLeft), `${left} s left, minLeft ${minLeft}`).toBe(want);
    expect(waitFor({ period: 8 }, 3.5, 20)).toBe(3_560); // half of 8
  });
  it("no rule (no minLeft, or null): the default wait; the rule's: waitFor's, then `away`, then the fill", async () => {
    for (const m of [undefined, null, MIN_LEFT_S]) {
      const { r, waits, asked } = await run(18, m);
      expect(r).toEqual({ k: "filled", how: "single" });
      expect(waits, String(m)).toEqual([]);
      expect(asked).toEqual([]);
    }
    for (const [s, m] of [
      [18, 20],
      [14, 20],
      [19, 10],
      [21, 10],
    ] as const) {
      const { r, waits, asked, calls } = await run(s, m);
      const want = waitFor(e, 30 - s, m);
      expect(waits, `${30 - s} s left, minLeft ${m}`).toEqual(want ? [want] : []);
      expect(asked).toEqual(want ? [`waiting ${want}`, "away"] : []);
      expect(r).toEqual({ k: "filled", how: "single" });
      expect(calls).toHaveLength(1);
    }
  });
  it("after the rule's wait: a cancel stops it, and a page the user left is not filled (F7)", async () => {
    const c = await run(18, 20, { cancelled: async () => true });
    expect(c.r).toEqual({ k: "cancelled" });
    expect(c.calls).toHaveLength(0);
    const gone = await run(18, 20, { away: async () => "tab" as const });
    expect(gone.r).toEqual({ k: "failed", r: "tab" });
    expect(gone.calls).toHaveLength(0);
  });
});

describe("who reads the rules (source)", () => {
  const SRC = resolve(EXT, "src");
  const files: { path: string; text: string }[] = [];
  const walk = (d: string) => {
    for (const x of readdirSync(d, { withFileTypes: true }))
      if (x.isDirectory()) walk(resolve(d, x.name));
      else if (/\.tsx?$/.test(x.name))
        files.push({ path: resolve(d, x.name).slice(SRC.length + 1), text: readFileSync(resolve(d, x.name), "utf8") });
  };
  walk(SRC);
  const importers = (re: RegExp) => files.filter((f) => re.test(f.text)).map((f) => f.path);
  it("the Fill chunk alone takes a page's rule, with `scripting` held; the worker's shortcut looks with no rule (C27)", () => {
    expect(importers(/from "[./]+\/platform\/site-rule"/)).toEqual(["popup/main/Fill.tsx"]);
    // the package's reader: the Fill paths' rule (site-rule.ts) and, since AF3-4, the "same sign-in" chunk (aliases.ts)
    expect(importers(/from "[./]+\/(?:platform\/)?package-data"/)).toEqual([
      "platform/site-rule.ts",
      "popup/main/aliases.ts",
    ]);
    // which Main loads only by import(), after the first code, so it is in no counted file (check-dist holds the chunks)
    expect(importers(/from "\.\/aliases"/)).toEqual([]);
    expect(files.find((f) => f.path === "popup/main/Main.tsx")!.text).toMatch(/import\("\.\/aliases"\)/);
    const fill = files.find((f) => f.path === "popup/main/Fill.tsx")!.text;
    const flat = fill.replace(/\s+/g, "");
    // read only with `scripting` held and autofill on (the review's NIT-2), and passed to the one look
    expect(flat).toMatch(/construle=held&&!offHint\(\)\?ruleForPage\(tab\.url\):null;/);
    expect(flat).toMatch(/awaitscan\(tab\.id,rule\?rule\.then\(\(x\)=>x\.hint\):null\)/);
    expect(fill.match(/(?<![\w.])scan\(/g)).toHaveLength(1);
    // the fill takes the minLeft of the look it fills from
    expect(flat).toMatch(/awaitfillCand\(s\.tabId,e,pick,\{code,minLeft:s\.minLeft,/);
    expect(fill.match(/\bfillCand\(/g)).toHaveLength(1);
    const cmd = files.find((f) => f.path === "background/fill-command.ts")!.text;
    expect(cmd).not.toMatch(/site-rule|package-data|readRules|minLeft/);
    expect(cmd).toMatch(/const found = await scan\(tab\.id\);/);
    // no second copy of the look or the fill's wait
    expect(files.filter((f) => /scanWithRule|fillCandFor/.test(f.text)).map((f) => f.path)).toEqual([]);
  });
});
