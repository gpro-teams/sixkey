// TOTP autofill Stage 3, AF3-5: the "code after the password" note on the popup's and the side panel's Fill card
// (docs/design/notes/AUTOFILL3-NOTES.md §7).
//   - platform/site-rule.ts ruleForPage's `appends`: the page's host is one of the baseline's appends (Apple's list: today
//     auth.redhat.com, etrade.com, usaa.com) or a subdomain of one, on label boundaries; never a look-alike; from the
//     baseline only (a bundle of another kind gives nothing); nothing on a failed read or a page that is no http(s) page;
//   - the e2e build's bundle adds its test host (test/fixtures/rules/appends.json) to Apple's;
//   - the Fill card (Fill.tsx FillBar, RowFill), drawn into a minimal document over a stand-in chrome.* as in
//     autofill1-fallbacks.test.ts: on such a site, where no code box is found, the strip says the note (in place of the
//     "no code box" advice, whatever made it: no box, a frame of another site, too many boxes), and so does a Fill press
//     under its card; where a box is found, the strip says so and no note is drawn; on any other host, the texts are as
//     before; the press and its calls are the same with the note as without.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseBaseline } from "../../src/core/rules/baseline";
import type { Bundle } from "../../src/core/rules/format";
import type { Entry } from "../../src/core/vault/model";
import { e2eBaselineText } from "../../scripts/rules-package.mjs";
import { TEST_CODE } from "../helpers/gate";
import { installMiniDom, MiniElement } from "../helpers/mini-dom";

const EXT = resolve(__dirname, "../..");
const COMMITTED = readFileSync(resolve(EXT, "../rules/build/baseline.json"), "utf8");
const bundleOf = (text: string) => {
  const r = parseBaseline(text, { allowReserved: true });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const NOTE = "This site wants the code typed right after your password, in the same box.";
const NOTE_ZH = "此网站要求把验证码接在密码后面，填在同一个输入框里。";
const g = globalThis as Record<string, unknown>;

/** platform/site-rule.ts with the package's read answering `read`: a fresh module each time. */
async function siteRuleWith(read: () => Promise<unknown>) {
  const readRules = vi.fn(read);
  vi.doMock("../../src/platform/package-data", () => ({ readRules }));
  const m = await import("../../src/platform/site-rule");
  return { ...m, readRules };
}

describe("ruleForPage's appends (platform/site-rule.ts): the code after the password, from the baseline", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../../src/platform/package-data");
  });
  it("the store build's bundle: Apple's three hosts and their subdomains, on label boundaries; no look-alike", async () => {
    const bundle = bundleOf(COMMITTED);
    expect(bundle.appends).toEqual(["auth.redhat.com", "etrade.com", "usaa.com"]);
    const { ruleForPage } = await siteRuleWith(async () => bundle);
    for (const url of [
      "https://etrade.com/",
      "https://us.etrade.com/etx/pxy/login",
      "https://www.etrade.com/",
      "https://US.ETRADE.COM./login", // as the URL parser and hostOf write it
      "http://us.etrade.com:8080/login", // any http(s) page of the host, any port
      "https://auth.redhat.com/auth/realms",
      "https://sso.auth.redhat.com/",
      "https://usaa.com/",
      "https://www.usaa.com/my/logon",
    ])
      // no site rule for any of them (the store build has none yet): the note alone
      expect(await ruleForPage(url), url).toEqual({ hint: null, minLeft: null, appends: true });
    for (const url of [
      "https://notetrade.com/",
      "https://xusaa.com/",
      "https://etrade.com.evil.test/",
      "https://us.etrade.com.evil.test/",
      "https://etrade.co/",
      "https://etrade.com-login.test/",
      "https://redhat.com/", // the parent of an appends host is not one
      "https://sso.redhat.com/",
      "https://example.com/",
      "https://127.0.0.1/",
    ])
      expect(await ruleForPage(url), url).toEqual({ hint: null, minLeft: null, appends: false });
  });
  it("no page, no read: a page that is no http(s) page has none, and the package is not read for it", async () => {
    const bundle = bundleOf(COMMITTED);
    const m = await siteRuleWith(async () => bundle);
    for (const url of [undefined, "", "chrome://settings/", "file:///etrade.com/x.html", "ftp://etrade.com/"])
      expect(await m.ruleForPage(url), String(url)).toEqual(m.NO_RULE);
    expect(m.NO_RULE.appends).toBe(false);
    expect(m.readRules).not.toHaveBeenCalled();
  });
  it("a failed or refused read, or no bundle, is no note", async () => {
    for (const read of [async () => null, () => Promise.reject(new Error("lost"))]) {
      vi.resetModules();
      const m = await siteRuleWith(read);
      expect(await m.ruleForPage("https://us.etrade.com/login")).toEqual(m.NO_RULE);
    }
  });
  it("the baseline's only: a bundle of another kind (the reader never gives one) gives no note and no rule", async () => {
    const bundle = bundleOf(await e2eBaselineText(COMMITTED));
    const live = { ...bundle, kind: "live" } as Bundle; // a live bundle with the baseline's lists, as a forgery would be
    const m = await siteRuleWith(async () => live);
    for (const url of ["https://us.etrade.com/login", "http://append.fix.test/x", "http://rules.fix.test/rule/one"])
      expect(await m.ruleForPage(url), url).toEqual(m.NO_RULE);
  });
  it("the e2e build's bundle: Apple's hosts and its test host, with its subdomains; the test rules' hosts have none", async () => {
    const bundle = bundleOf(await e2eBaselineText(COMMITTED));
    expect(bundle.appends).toEqual(["append.fix.test", "auth.redhat.com", "etrade.com", "usaa.com"]);
    const { ruleForPage } = await siteRuleWith(async () => bundle);
    const appends = async (url: string) => (await ruleForPage(url)).appends;
    for (const host of ["append.fix.test", "us.append.fix.test", "a.b.append.fix.test", "us.etrade.com"])
      expect(await appends(`http://${host}:8080/nofield`), host).toBe(true);
    for (const host of [
      "notappend.fix.test",
      "append.fix.test.evil.test",
      "fix.test",
      "app.fix.test",
      "rules.fix.test",
    ])
      expect(await appends(`http://${host}:8080/nofield`), host).toBe(false);
    // a site rule and the note are independent: the rule's host has its hint and no note
    expect(await ruleForPage("http://rules.fix.test/rule/one")).toMatchObject({ hint: { d: ["rules.fix.test"] } });
  });
});

// ---- the Fill card ------------------------------------------------------------------------------------------------------

let dom: ReturnType<typeof installMiniDom>;
let root: MiniElement;
const entry = (domains = ["etrade.com", "notetrade.com"]): Entry =>
  ({
    id: "e1",
    createdAt: 0,
    type: "totp",
    issuer: "E*TRADE",
    label: "alice",
    secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    domains,
    hlc: "",
    order: "a",
    phlc: "",
  }) as Entry;
const texts = () => root.all((e) => !!e.textContent).map((e) => e.textContent);
const buttons = () => root.all((e) => e.localName === "button");
const BOX = { t: "0123456789abcdef", k: 0 as const, n: 6, s: 70, sent: false, weak: false, lab: "" };
type Call = { files?: string[]; func?: unknown; args?: unknown[]; target?: { documentIds?: string[] } };

/** The browser: tab 7 in front at `url`, its look answering `c` boxes (and `x` foreign frames, `z` a look cut short). */
function browser(url: string, o: { c?: (typeof BOX)[]; x?: number; z?: number } = {}) {
  const calls: Call[] = [];
  const origin = new URL(url).origin;
  g.chrome = {
    commands: { getAll: async () => [] },
    tabs: {
      query: async () => [{ id: 7, url }],
      get: async (id: number) => ({ id, active: true, windowId: 1 }),
    },
    windows: { get: async (id: number) => ({ id, focused: true }) },
    scripting: {
      executeScript: vi.fn(async (c: Call) => {
        calls.push(c);
        if (c.files) return [];
        if (c.target?.documentIds) return [{ result: { ok: true, how: "single" } }];
        return [
          {
            frameId: 0,
            documentId: "d0",
            result: { o: origin, a: [], top: true, c: o.c ?? [], x: o.x ?? 0, z: o.z ?? 0 },
          },
        ];
      }),
    },
    storage: {
      local: {
        get: async () => ({}),
        onChanged: { addListener: () => undefined, removeListener: () => undefined },
        setAccessLevel: async () => undefined,
      },
      session: {
        get: async () => ({}),
        set: async () => undefined,
        remove: async () => undefined,
        setAccessLevel: async () => undefined,
        onChanged: { addListener: () => undefined, removeListener: () => undefined },
      },
    },
  };
  return calls;
}
const settle = () =>
  act(async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 5));
  });

/** The card for the page at `url` (the store build's bundle read), drawn; `lang` the language the surface shows. */
async function card(url: string, lang: "en" | "zh_CN" = "en") {
  const bundle = bundleOf(COMMITTED);
  const readRules = vi.fn(async () => bundle);
  vi.doMock("../../src/platform/package-data", () => ({ readRules }));
  const i18n = await import("../../src/ui/i18n");
  i18n.setLangChoice(lang);
  await i18n.loadCatalog(async () => ({ cancel: { message: "Cancel" } }));
  const { FillBar, RowFill } = await import("../../src/popup/main/Fill");
  const host = new URL(url).hostname;
  await act(async () => {
    render(
      h(
        "div",
        null,
        h(FillBar, { host, rows: [{ entry: entry(), tier: "registered" }] }),
        h(RowFill, { entry: entry(), first: true }),
      ),
      root as unknown as Element,
    );
  });
  await settle();
  return { readRules };
}
async function press(): Promise<void> {
  const btn = buttons().find((e) => e.getAttribute("class")?.includes("fillbtn") === true)!;
  expect(btn.getAttribute("disabled") ?? null).toBeNull();
  await act(async () => void btn.dispatch("click", {}));
  await settle();
}
const classed = (c: string) => root.all((e) => e.getAttribute("class")?.split(" ").includes(c) === true);
/** The strip's words (FillBar), or null when it is not drawn. */
const strip = () => classed("fillbar")[0]?.textContent ?? null;
/** The notes under the card (RowFill), each one's words. */
const notes = () => classed("fillnote").map((e) => e.textContent);

describe("the Fill card (Fill.tsx): the note where no code box is found on such a site, and nowhere else", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"], now: Math.floor(1_700_000_000_000 / 30_000) * 30_000 + 10_000 }); // 20 s left
    dom = installMiniDom();
    const proto = MiniElement.prototype as unknown as Record<string, unknown>;
    proto.querySelectorAll = function (this: MiniElement, sel: string) {
      return this.all((e) => e !== this && e.localName === sel);
    };
    proto.querySelector = () => null;
    proto.contains = function (this: MiniElement, n: MiniElement) {
      return this.all((e) => e === n).length > 0;
    };
    Object.assign(dom.doc, {
      documentElement: dom.doc.createElement("html"),
      querySelector: () => null,
      getElementById: () => null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      hasFocus: () => true,
    });
    root = dom.doc.body;
    g.window = Object.assign(globalThis, {
      document: dom.doc,
      innerHeight: 600,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    g.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  });
  afterEach(() => {
    act(() => render(null, root as unknown as Element));
    dom.undo();
    vi.useRealTimers();
    vi.doUnmock("../../src/platform/package-data");
    delete g.chrome;
    delete g.localStorage;
  });

  it("us.etrade.com, no code box: the strip says the note, a press says it under the card, and nothing is filled", async () => {
    const calls = browser("https://us.etrade.com/etx/pxy/login");
    const { readRules } = await card("https://us.etrade.com/etx/pxy/login");
    expect(readRules).toHaveBeenCalledTimes(1);
    expect(strip()).toContain(NOTE);
    expect(texts().join("|")).not.toMatch(/No code box found/);
    // the Fill button is there, as on any page with an account for it
    expect(buttons().map((b) => b.textContent)).toEqual(expect.arrayContaining([expect.stringMatching(/^Fill code/)]));
    await press();
    // under the card: the same words, as the press's answer (it looked again, and found no box again)
    expect(notes()).toEqual([NOTE]);
    // said as a note, not as a refusal: no "bad" (red) style, the info mark (AF3-5's review NIT, done with AF3-4)
    expect(classed("fillnote").map((e) => e.getAttribute("class"))).toEqual(["fillnote"]);
    expect(strip()).toContain(NOTE);
    expect(calls.filter((c) => c.target?.documentIds)).toEqual([]); // no fill
    expect(calls.filter((c) => c.func).length).toBeGreaterThanOrEqual(2); // the open's look and the press's look again
  });
  it("etrade.com itself, with a frame of another site or a look cut short: the note, not the frame's or the size's advice", async () => {
    for (const o of [{ x: 1 }, { z: 1 }, { x: 2, z: 1 }]) {
      vi.resetModules();
      browser("https://etrade.com/login", o);
      await card("https://etrade.com/login");
      expect(strip(), JSON.stringify(o)).toContain(NOTE);
      expect(texts().join("|")).not.toMatch(/frame from another site|too many boxes/);
      act(() => render(null, root as unknown as Element));
    }
  });
  it("in Chinese: the Chinese note", async () => {
    browser("https://us.etrade.com/login");
    await card("https://us.etrade.com/login", "zh_CN");
    expect(strip()).toContain(NOTE_ZH);
  });
  it("a code box found on such a site: the strip says so and no note is drawn, before or after the press, which fills", async () => {
    const calls = browser("https://us.etrade.com/2fa", { c: [BOX] });
    vi.doMock("../../src/platform/plugins/autofill-gate", () => ({ gatedCode: () => TEST_CODE }));
    try {
      await card("https://us.etrade.com/2fa");
      expect(strip()).toContain("Code box found on this page");
      expect(texts().join("|")).not.toContain(NOTE);
      await press();
      expect(calls.filter((c) => c.target?.documentIds)).toHaveLength(1);
      expect(texts()).toContain("Code filled. Continue on the page.");
      expect(texts().join("|")).not.toContain(NOTE);
    } finally {
      vi.doUnmock("../../src/platform/plugins/autofill-gate");
    }
  });
  it("any other host: the texts as before (no box, a frame, too many boxes), and the press's answer too", async () => {
    for (const [url, o, want] of [
      ["https://notetrade.com/login", {}, /^No code box found on this page\. Open the step/],
      ["https://notetrade.com/login", { x: 1 }, /^No code box found\. It may be in a frame from another site/],
      ["https://notetrade.com/login", { z: 1 }, /^This page has too many boxes/],
      ["https://etrade.com.evil.test/login", {}, /^No code box found on this page/],
    ] as const) {
      vi.resetModules();
      const calls = browser(url, o);
      await card(url);
      expect(strip(), url).toMatch(want);
      await press();
      expect(texts().join("|"), url).not.toContain(NOTE);
      expect(notes(), url).toEqual([expect.stringMatching(want)]);
      expect(
        classed("fillnote").map((e) => e.getAttribute("class")),
        url,
      ).toEqual(["fillnote bad"]); // a refusal, as before
      expect(calls.filter((c) => c.target?.documentIds)).toEqual([]);
      act(() => render(null, root as unknown as Element));
    }
  });
  it("without `scripting`: no look, no read of the package, nothing drawn (the first click asks), as before", async () => {
    browser("https://us.etrade.com/login");
    (g.chrome as Record<string, unknown>).permissions = { contains: async () => false };
    const { readRules } = await card("https://us.etrade.com/login");
    expect(readRules).not.toHaveBeenCalled();
    expect(texts().join("|")).not.toContain(NOTE);
    expect(strip()).toBeNull();
  });
});
