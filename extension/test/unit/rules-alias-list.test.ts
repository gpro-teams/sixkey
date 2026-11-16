// TOTP autofill Stage 3, AF3-4: "same sign-in" suggestions in the popup's and the side panel's list
// (docs/design/notes/AUTOFILL3-NOTES.md §8; the plan's §3.4, §4.5; the maintainers' C29).
//   - src/popup/main/aliases.ts aliasNotes: the accounts Apple's list (the package's baseline, never a live bundle) offers
//     on a page, each with its line "Same sign-in as <its registered site>"; the matching rule is core/rules/alias.ts's
//     (equal once one leading www. is off each side, no other subdomain, never an IP address; twitter.com → x.com one
//     way, chat.com, chatgpt.com and openai.com both ways);
//   - model.ts filterRows and buildSections: such an account is `related`, with its note, never `registered`;
//   - aliases.ts ask and shown: the answer kept by page, the list redrawn when it came within 300 ms and changes something
//     (never for an empty answer where there was none, the review's N5), none shown once an account is registered for the
//     page (N4);
//   - Main.tsx and List.tsx with the real aliases.ts, drawn by Preact into a minimal document over a stand-in chrome.* and
//     service (as afmatch-dom.test.ts does), the package's read and the clock in the test's hands: the lookup after the
//     first code on a page no account is registered for; its answer shown at once when it comes within 300 ms, else at the
//     next render that rebuilds the list anyway (the search, the page, the accounts' ids and sites), never on a render a
//     click caused nor on a reload of the same accounts (the review's S1); a line never left on an account whose site it
//     named is gone, and asked again when the accounts change (N3); the row under "Possibly related" with its line, the
//     "Which account" line beside it, Remember and no Fill button; the side panel following another tab; and the way
//     through Remember to This site, with the other lines gone (N4).
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseBaseline } from "../../src/core/rules/baseline";
import type { Bundle } from "../../src/core/rules/format";
import { parseSettings } from "../../src/core/service/types";
import { createClock, type Clock } from "../../src/core/vault/hlc";
import { aliveEntries, emptyVault, type Entry, type Vault } from "../../src/core/vault/model";
import { addEntry, type NewEntry } from "../../src/core/vault/ops";
import { aliasKey, buildSections, filterRows } from "../../src/popup/main/model";
import { installMiniDom, MiniElement, type MiniEvent } from "../helpers/mini-dom";

const EXT = resolve(__dirname, "../..");
const BASELINE = (() => {
  const r = parseBaseline(readFileSync(resolve(EXT, "../rules/build/baseline.json"), "utf8"));
  if (!r.ok) throw new Error(r.error);
  return r.value;
})();
const g = globalThis as Record<string, unknown>;
const totp = (issuer: string, label: string, domains?: string[]): NewEntry => ({
  type: "totp",
  issuer,
  label,
  secret: "JBSWY3DPEHPK3PXP",
  algorithm: "SHA1",
  digits: 6,
  period: 30,
  ...(domains ? { domains } : {}),
});
let clock: Clock = createClock("aaaa");
function vaultOf(list: NewEntry[]): Vault {
  let v = emptyVault("v1");
  for (const e of list) v = addEntry(v, e, clock).vault;
  return v;
}
const entriesOf = (list: NewEntry[]) => aliveEntries(vaultOf(list));

/** aliasNotes with the package's read answering `read`, in `lang`: a fresh module each time. */
async function notesWith(read: () => Promise<unknown>, lang: "en" | "zh_CN" = "en") {
  vi.resetModules();
  vi.doMock("../../src/platform/package-data", () => ({ readRules: read }));
  const i18n = await import("../../src/ui/i18n");
  i18n.setLangChoice(lang);
  const m = await import("../../src/popup/main/aliases");
  return m.aliasNotes;
}
const byName = (entries: Entry[], m: Map<string, string>) =>
  Object.fromEntries([...m].map(([key, note]) => [entries.find((e) => aliasKey(e) === key)!.issuer, note]));

describe("aliasNotes (popup/main/aliases.ts): Apple's groups in the package, the §3.4 rule, the line", () => {
  beforeEach(() => {
    g.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  });
  afterEach(() => {
    vi.doUnmock("../../src/platform/package-data");
    vi.resetModules();
    delete g.localStorage;
  });
  const ACCOUNTS = [
    totp("Twitter", "a", ["twitter.com"]),
    totp("X", "b", ["x.com"]),
    totp("Twitter www", "c", ["www.twitter.com"]),
    totp("Twitter mobile", "d", ["mobile.twitter.com"]),
    totp("ChatGPT", "e", ["chatgpt.com"]),
    totp("OpenAI", "f", ["notes.example", "openai.com"]),
    totp("Wikia", "g", ["wikia.com"]),
    totp("Seek", "h", ["seek.com.au"]),
    totp("Plain", "i"),
    totp("Twitter IP", "j", ["192.0.2.1"]),
  ];
  it("one way: twitter.com's accounts on x.com (and www.x.com), never x.com's on twitter.com; www. on either side only", async () => {
    const entries = entriesOf(ACCOUNTS);
    const notes = await notesWith(async () => BASELINE);
    expect(byName(entries, await notes(entries, "x.com"))).toEqual({
      Twitter: "Same sign-in as twitter.com",
      "Twitter www": "Same sign-in as www.twitter.com",
    });
    expect(byName(entries, await notes(entries, "www.x.com"))).toEqual({
      Twitter: "Same sign-in as twitter.com",
      "Twitter www": "Same sign-in as www.twitter.com",
    });
    for (const host of ["twitter.com", "www.twitter.com", "mobile.x.com", "x.com.evil.test", "notx.com", "192.0.2.1"])
      expect(byName(entries, await notes(entries, host)), host).toEqual({});
  });
  it("both ways: chat.com, chatgpt.com and openai.com; the account's own site named (its first one at a member)", async () => {
    const entries = entriesOf(ACCOUNTS);
    const notes = await notesWith(async () => BASELINE);
    expect(byName(entries, await notes(entries, "chat.com"))).toEqual({
      ChatGPT: "Same sign-in as chatgpt.com",
      OpenAI: "Same sign-in as openai.com",
    });
    expect(byName(entries, await notes(entries, "openai.com"))).toEqual({ ChatGPT: "Same sign-in as chatgpt.com" });
    expect(byName(entries, await notes(entries, "www.chatgpt.com"))).toEqual({ OpenAI: "Same sign-in as openai.com" });
    // a subdomain of a member is not the member (N8): platform.openai.com is no page of the group
    expect(byName(entries, await notes(entries, "platform.openai.com"))).toEqual({});
  });
  it("a one-way group's members, and a member written with www. (seek.com.au, as Remember stores it, R4-3)", async () => {
    const entries = entriesOf(ACCOUNTS);
    const notes = await notesWith(async () => BASELINE);
    expect(byName(entries, await notes(entries, "fandom.com"))).toEqual({ Wikia: "Same sign-in as wikia.com" });
    expect(byName(entries, await notes(entries, "community.fandom.com"))).toEqual({}); // user content (N8)
    expect(byName(entries, await notes(entries, "wikia.com"))).toEqual({}); // one way
    expect(byName(entries, await notes(entries, "login.seek.com"))).toEqual({ Seek: "Same sign-in as seek.com.au" });
  });
  it("an account registered for the page is This site, not offered", async () => {
    const entries = entriesOf([totp("Both", "a", ["twitter.com", "x.com"]), totp("Twitter", "b", ["twitter.com"])]);
    const notes = await notesWith(async () => BASELINE);
    expect(byName(entries, await notes(entries, "x.com"))).toEqual({ Twitter: "Same sign-in as twitter.com" });
  });
  it("in Chinese", async () => {
    const entries = entriesOf(ACCOUNTS);
    const notes = await notesWith(async () => BASELINE, "zh_CN");
    expect(byName(entries, await notes(entries, "x.com")).Twitter).toBe("与 twitter.com 用同一账户登录");
  });
  it("nothing from a failed read, no bundle, or a bundle that is not the package's baseline (a live one: C29)", async () => {
    const entries = entriesOf(ACCOUNTS);
    const live = { ...BASELINE, kind: "live" } as Bundle; // with Apple's groups in it, as a forgery would carry them
    for (const read of [async () => null, async () => live, async () => ({ ...BASELINE, kind: undefined })]) {
      const notes = await notesWith(read);
      expect((await notes(entries, "x.com")).size).toBe(0);
    }
    const lost = await notesWith(() => Promise.reject(new Error("lost")));
    await expect(lost(entries, "x.com")).rejects.toThrow("lost"); // (readRules never rejects; Main drops a rejection)
  });
  it("no line without its text: nothing offered (never a key name)", async () => {
    for (const l of ["en", "zh_CN"])
      vi.doMock(`../../catalogs/autofill-${l}.json`, () => {
        throw new Error("chunk not found");
      });
    try {
      const entries = entriesOf(ACCOUNTS);
      const notes = await notesWith(async () => BASELINE);
      expect((await notes(entries, "x.com")).size).toBe(0);
    } finally {
      for (const l of ["en", "zh_CN"]) vi.doUnmock(`../../catalogs/autofill-${l}.json`);
    }
  });
});

describe("filterRows and buildSections (model.ts) with the notes", () => {
  const entries = entriesOf([
    totp("Twitter", "a", ["twitter.com"]),
    totp("X", "b", ["x.com"]),
    totp("Xavier", "c"),
    totp("Other", "d", ["example.org"]),
  ]);
  const key = (issuer: string) => aliasKey(entries.find((e) => e.issuer === issuer)!);
  const notes = new Map([
    [key("Twitter"), "Same sign-in as twitter.com"],
    [key("X"), "Same sign-in as x.com"], // stale: X is registered for x.com, and stays so, with no line
  ]);
  const shape = (rows: ReturnType<typeof filterRows>) => rows.map((r) => [r.entry.issuer, r.tier, r.note || null]);
  it("an account with a note is related, with it; a registered one keeps its tier and has none", () => {
    expect(shape(filterRows(entries, "", "x.com", notes))).toEqual([
      ["Twitter", "related", "Same sign-in as twitter.com"],
      ["X", "registered", null],
      ["Xavier", null, null],
      ["Other", null, null],
    ]);
    const sections = buildSections(filterRows(entries, "", "x.com", notes), "", "x.com", {
      results: "Results",
      ungrouped: "Other",
      related: "Possibly related",
    });
    expect(sections.map((s) => [s.key, s.rows.map((r) => r.entry.issuer)])).toEqual([
      ["site", ["X"]],
      ["related", ["Twitter"]],
      ["g:", ["Xavier", "Other"]],
    ]);
  });
  it("no two accounts share a key, whatever their ids (the review's r2-c: an id that runs on into another's site)", () => {
    const [a, b] = entriesOf([totp("A", "a", ["twitter.com"]), totp("B", "b", ["x.com"])]);
    const crafted = [
      { ...a!, id: "abcdefgh", domains: ["twitter.com"] },
      { ...b!, id: "abcdefghtwitter", domains: [".com"] },
    ];
    expect(aliasKey(crafted[0]!)).not.toBe(aliasKey(crafted[1]!));
    const lines = new Map([[aliasKey(crafted[0]!), "Same sign-in as twitter.com"]]);
    expect(shape(filterRows(crafted, "", "x.com", lines))).toEqual([
      ["A", "related", "Same sign-in as twitter.com"],
      ["B", null, null],
    ]);
  });
  it("a line keyed for the account's old sites is not read once they changed (N3)", () => {
    const moved = entries.map((e) => (e.issuer === "Twitter" ? { ...e, domains: ["example.org"] } : e));
    expect(shape(filterRows(moved, "", "x.com", notes))[0]).toEqual(["Twitter", null, null]);
  });
  it("without notes, or for another host's page, the rows are what they were", () => {
    expect(shape(filterRows(entries, "", "x.com"))).toEqual([
      ["Twitter", null, null],
      ["X", "registered", null],
      ["Xavier", null, null],
      ["Other", null, null],
    ]);
  });
  it("while searching: a match with a note comes with the site's matches, related", () => {
    expect(shape(filterRows(entries, "t", "x.com", notes))).toEqual([
      ["Twitter", "related", "Same sign-in as twitter.com"],
      ["Other", null, null],
    ]);
  });
});

// ---- ask and shown (aliases.ts): when the list is redrawn, and what it shows ----------------------------------------

describe("ask and shown (popup/main/aliases.ts): each page's answer, when it redraws the list, and when it is shown", () => {
  let skewNow = 0;
  beforeEach(() => {
    g.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    skewNow = 0;
    const start = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => start + skewNow);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../../src/platform/package-data");
    vi.resetModules();
    delete g.localStorage;
    delete g.chrome;
  });
  /** What the module heard of chrome.storage.session's changes (it listens from when it is loaded). */
  let sessionChanged: ((changes: Record<string, unknown>) => void) | undefined;
  /** The module, with the package's read answering after `late` ms of the module's clock (0: at once). */
  async function moduleWith() {
    let late = 0;
    vi.resetModules();
    sessionChanged = undefined;
    g.chrome = {
      storage: { session: { onChanged: { addListener: (f: typeof sessionChanged) => (sessionChanged = f) } } },
    };
    vi.doMock("../../src/platform/package-data", () => ({
      readRules: async () => ((skewNow += late), BASELINE),
    }));
    (await import("../../src/ui/i18n")).setLangChoice("en");
    const m = await import("../../src/popup/main/aliases");
    return { m, lateBy: (ms: number) => void (late = ms) };
  }
  const twitter = entriesOf([totp("Twitter", "a", ["twitter.com"]), totp("Zoom", "b", ["zoom.us"])]);
  it("in time: kept and redrawn; late: kept, not redrawn; an empty answer where there was none: no redraw (N5)", async () => {
    const { m, lateBy } = await moduleWith();
    const redraw = vi.fn();
    await m.ask(twitter, "example.org", Date.now(), redraw);
    expect(redraw).not.toHaveBeenCalled(); // nothing there, nothing was: the list is not drawn again
    expect(m.shown(twitter, "example.org")).toBeUndefined(); // and an answer with no line is not kept (r2-b)
    await m.ask(twitter, "x.com", Date.now(), redraw);
    expect(redraw).toHaveBeenCalledTimes(1);
    expect(byName(twitter, m.shown(twitter, "x.com")!)).toEqual({ Twitter: "Same sign-in as twitter.com" });
    // the same page, its account's site gone: an empty answer where there was a line is a change, redrawn
    const gone = twitter.map((e) => (e.issuer === "Twitter" ? { ...e, domains: ["example.org"] } : e));
    await m.ask(gone, "x.com", Date.now(), redraw);
    expect(redraw).toHaveBeenCalledTimes(2);
    expect(m.shown(gone, "x.com")).toBeUndefined();
    // late: kept for the page, not redrawn
    lateBy(300);
    await m.ask(twitter, "www.x.com", Date.now(), redraw);
    expect(redraw).toHaveBeenCalledTimes(2);
    expect(byName(twitter, m.shown(twitter, "www.x.com")!)).toEqual({ Twitter: "Same sign-in as twitter.com" });
    lateBy(299);
    await m.ask(twitter, "x.com", Date.now(), redraw);
    expect(redraw).toHaveBeenCalledTimes(3); // just in time
  });
  it("the 300 ms count from `at`, Main's start of the lookup, not from this call: a chunk loaded late leaves less", async () => {
    const { m, lateBy } = await moduleWith();
    const redraw = vi.fn();
    lateBy(0); // the answer at once, but the lookup began 300 ms ago (the chunk's load)
    await m.ask(twitter, "x.com", Date.now() - 300, redraw);
    expect(redraw).not.toHaveBeenCalled();
    expect(m.shown(twitter, "x.com")?.size).toBe(1); // kept, for the next rebuild of the list
    await m.ask(twitter, "www.x.com", Date.now() - 299, redraw);
    expect(redraw).toHaveBeenCalledTimes(1);
  });
  it("a lock empties what it keeps (the lock epoch in chrome.storage.session); other changes do not (r2-b)", async () => {
    const { m } = await moduleWith();
    await m.ask(twitter, "x.com", Date.now(), () => undefined);
    expect(sessionChanged).toBeDefined();
    sessionChanged!({ sk_session: { newValue: {} } });
    expect(m.shown(twitter, "x.com")?.size).toBe(1);
    sessionChanged!({ sk_lock_epoch: { oldValue: 1, newValue: 2 } });
    expect(m.shown(twitter, "x.com")).toBeUndefined();
  });
  it("shown: none once an account is registered for the page (N4), none for no page, another page's never", async () => {
    const { m } = await moduleWith();
    await m.ask(twitter, "x.com", Date.now(), () => undefined);
    expect(m.shown(twitter, "x.com")?.size).toBe(1);
    expect(m.shown(twitter, null)).toBeUndefined();
    expect(m.shown(twitter, "example.org")).toBeUndefined();
    const withX = [...twitter, ...entriesOf([totp("X", "c", ["x.com"])])];
    expect(m.shown(withX, "x.com")).toBeUndefined();
  });
  it("a lookup that fails keeps what the page had, and never rejects", async () => {
    vi.resetModules();
    let fail = false;
    vi.doMock("../../src/platform/package-data", () => ({
      readRules: async () => {
        if (fail) throw new Error("lost");
        return BASELINE;
      },
    }));
    (await import("../../src/ui/i18n")).setLangChoice("en");
    const m = await import("../../src/popup/main/aliases");
    await m.ask(twitter, "x.com", Date.now(), () => undefined);
    fail = true;
    await expect(m.ask(twitter, "x.com", Date.now(), () => undefined)).resolves.toBeUndefined();
    expect(m.shown(twitter, "x.com")?.size).toBe(1);
  });
});

// ---- the list (Main.tsx, List.tsx) -----------------------------------------------------------------------------------

let dom: ReturnType<typeof installMiniDom>;
let root: MiniElement;
let docKeys: ((e: MiniEvent) => void)[];
let tabUrl: string | undefined;
let vault: Vault;
let saves: number;
let tabChanged: (() => void) | undefined;
/** Main drawn again over `vault` as it is now: what the service's reload gives (new objects, as openView decrypts them). */
let repaint: () => Promise<void>;
/** The package's read, as the test lets it answer; how many lookups started (one read each), and the hosts looked up. */
let read: () => Promise<Bundle | null>;
let reads: number;
let asked: string[];
/**
 * Date.now as Main and aliases.ts read it: a clock that stands still at the test's start plus `skew`, so that how late an
 * answer is depends on the test alone (a late answer is one that comes when skew has grown), never on how busy the
 * machine is.
 */
let skew = 0;

const els = (test: (e: MiniElement) => boolean) => root.all(test);
const cls = (e: MiniElement, c: string) => (e.getAttribute("class") ?? "").split(" ").includes(c);
const rows = () => els((e) => cls(e, "row"));
const nameOf = (r: MiniElement) => r.all((e) => cls(e, "who"))[0]!.all((e) => e.localName === "b")[0]!.textContent;
const linesOf = (r: MiniElement) =>
  r
    .all((e) => cls(e, "who"))[0]!
    .all((e) => e.localName === "i")
    .map((i) => i.textContent);
const row = (name: string) => rows().find((r) => nameOf(r) === name)!;
const sect = (r: MiniElement) => (r.parentNode as MiniElement).getAttribute("class");
const rememberOf = (r: MiniElement) => r.all((e) => e.localName === "button" && cls(e, "remember"))[0];
const sheet = () => els((e) => e.localName === "form" && cls(e, "rm"))[0];
/** The list as the user sees it: each row's section, name and lines, in order. */
const picture = () => rows().map((r) => [sect(r), nameOf(r), ...linesOf(r).filter(Boolean)].join(" | "));
const settle = async (until: () => unknown = () => true, what = "the list") => {
  for (let i = 0; i < 150; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    if (until()) return;
  }
  throw new Error(`never came: ${what}`);
};
const click = (e: MiniElement | null | undefined) => act(async () => void e!.dispatch("click"));
const search = (text: string) =>
  act(async () => {
    const q = root.byId("q")!;
    q.value = text;
    q.dispatch("input");
  });
/** A read the test lets go when it likes: `go(after)` gives the bundle `after` ms of the clock after it was asked. */
function deferred() {
  let give!: (b: Bundle) => void;
  const p = new Promise<Bundle>((ok) => (give = ok));
  return { p, go: (after: number) => ((skew += after), give(BASELINE)) };
}
const TWITTER_LINE = "Same sign-in as twitter.com";
/** The vault with `fn` made to one account (`issuer`), as an edit saved elsewhere and the service's reload give it. */
const editAccount = (issuer: string, fn: (e: Entry) => Entry) =>
  (vault = { ...vault, entries: vault.entries.map((e) => (e.issuer === issuer ? fn(e) : e)) });

async function draw(list: NewEntry[], panel = false) {
  vault = vaultOf(list);
  const i18n = await import("../../src/ui/i18n");
  const { fullCatalog } = await import("../../src/ui/catalog-full");
  i18n.setLangChoice("en");
  await i18n.loadCatalog(fullCatalog);
  if (panel) {
    const { surface } = await import("../../src/popup/surface");
    surface.panel = {
      shown: () => undefined,
      attach: () => () => undefined,
      watchTab: (again) => ((tabChanged = again), () => undefined),
    };
  }
  const { Main } = await import("../../src/popup/main/Main");
  const rt = {
    service: {
      mutate: async (fn: (v: Vault, c: Clock, now: number) => Vault | Promise<Vault>) => {
        vault = await fn(vault, clock, Date.now());
        saves++;
        return vault;
      },
      ackEvents: async () => undefined,
      lock: async () => undefined,
      grantKeys: async () => null,
    },
  };
  const paint = () =>
    render(
      h(Main, {
        rt: rt as never,
        screen: {
          k: "main",
          vault: structuredClone(vault), // as openView gives it: new objects each time, whatever changed
          events: [],
          protected: true,
          lastBackup: Date.now(),
          settings: parseSettings({ autoLock: { mode: "idle", minutes: 15 }, lockOnScreenLock: true }),
        },
        reload: async () => paint(),
      }),
      root as unknown as Element,
    );
  repaint = () => act(async () => paint());
  await act(async () => paint());
  await settle(() => rows().length > 0, "the list");
  // the first codes are in (the lookup waits for them)
  await settle(() => els((e) => cls(e, "code") && !cls(e, "wait")).length > 0, "the first code");
}

const LIST = [totp("Twitter", "alice", ["twitter.com"]), totp("GitHub", "bob", ["github.com"]), totp("Zoom", "carol")];
const PLAIN = ["sect | Twitter | alice", "sect | GitHub | bob", "sect | Zoom | carol"];
const WITH_LINE = [
  "sect related | Twitter | alice | Same sign-in as twitter.com",
  "sect | GitHub | bob",
  "sect | Zoom | carol",
];

describe("the list: the line under Possibly related, at the right moment", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../../src/popup/main/Fill", () => ({
      connect: () => undefined,
      FillBar: () => h("div", { class: "fillbar" }),
      RowFill: (p: { entry: { id: string } }) =>
        h("button", { type: "button", class: "fillbtn", "data-for": p.entry.id }),
      Resume: () => null,
    }));
    reads = 0;
    asked = [];
    read = async () => BASELINE;
    vi.doMock("../../src/platform/package-data", () => ({ readRules: () => (reads++, read()) }));
    vi.doMock("../../src/core/rules/alias", async (importOriginal) => {
      const real = await importOriginal<typeof import("../../src/core/rules/alias")>();
      return {
        ...real,
        aliasRelated: (...a: Parameters<typeof real.aliasRelated>) => (asked.push(a[1]!), real.aliasRelated(...a)),
      };
    });
    skew = 0;
    const start = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => start + skew);
    dom = installMiniDom();
    root = dom.doc.body;
    docKeys = [];
    saves = 0;
    tabChanged = undefined;
    tabUrl = "https://x.com/home";
    clock = createClock("aaaa");
    const proto = MiniElement.prototype as unknown as Record<string, unknown>;
    proto.querySelector = function (this: MiniElement) {
      return this.all((e) => e.localName === "input" && e.checked)[0] ?? null;
    };
    Object.assign(dom.doc, {
      documentElement: dom.doc.createElement("html"),
      getElementById: (id: string) => root.byId(id),
      querySelector: () => null,
      addEventListener: (type: string, f: (e: MiniEvent) => void) => type === "keydown" && docKeys.push(f),
      removeEventListener: () => undefined,
    });
    g.chrome = {
      tabs: { query: async () => [{ id: 7, windowId: 1, url: tabUrl }] },
      commands: { getAll: async () => [] },
      storage: { session: { get: async () => ({}) } },
      runtime: { getURL: (p: string) => p },
    };
    g.window = Object.assign(globalThis, { document: dom.doc, innerHeight: 600 });
    g.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    g.CSS = { escape: (v: string) => v };
  });
  afterEach(() => {
    act(() => render(null, root as unknown as Element));
    dom.undo();
    vi.restoreAllMocks();
    vi.doUnmock("../../src/popup/main/Fill");
    vi.doUnmock("../../src/platform/package-data");
    vi.doUnmock("../../src/core/rules/alias");
    delete g.chrome;
    delete g.localStorage;
    delete g.CSS;
  });

  it("an answer in time: Twitter under Possibly related with its line, Remember, no Fill; the Which account line stays", async () => {
    await draw(LIST);
    await settle(() => linesOf(row("Twitter")).includes(TWITTER_LINE), "the line");
    expect(asked).toEqual(["x.com"]); // once, after the first code
    expect(sect(row("Twitter"))).toBe("sect related");
    expect(linesOf(row("Twitter"))).toEqual(["alice", TWITTER_LINE]);
    expect(rememberOf(row("Twitter"))!.getAttribute("aria-label")).toBe(
      "Remember: x.com belongs to this account (Twitter)",
    );
    expect(els((e) => cls(e, "fillbtn"))).toEqual([]); // related: no Fill button, no This site
    expect(els((e) => cls(e, "site"))).toEqual([]);
    expect(root.byId("ask-q")!.textContent).toBe("Which account for x.com?"); // N15: both show
    expect(picture()).toEqual(WITH_LINE);
  });

  it("a late answer moves nothing, not on a click's render either; the next search shows it, and so does clearing it", async () => {
    const late = deferred();
    read = () => late.p;
    await draw(LIST);
    await settle(() => reads > 0, "the lookup");
    expect(picture()).toEqual(PLAIN);
    await act(async () => late.go(301));
    await settle(() => asked.length > 0, "the answer");
    await settle();
    expect(picture()).toEqual(PLAIN);
    // a click's render: the copy button (the clipboard fails here, so its toast is drawn): nothing moves
    await click(row("GitHub").all((e) => cls(e, "copy"))[0]);
    await settle(() => els((e) => cls(e, "toast")).length > 0, "the copy's toast");
    expect(picture()).toEqual(PLAIN);
    // the code's own clock ticks the list again: nothing moves
    await new Promise((r) => setTimeout(r, 1100));
    await settle();
    expect(picture()).toEqual(PLAIN);
    // a search rebuilds the list anyway: the answer is in it
    await search("tw");
    expect(picture()).toEqual(["sect | Twitter | alice | Same sign-in as twitter.com"]);
    await search("");
    expect(picture()).toEqual(WITH_LINE);
  });

  it("a late answer, then a new order only (a drag here, one synced from another device): nothing moves, nothing is asked again", async () => {
    const late = deferred();
    read = () => late.p;
    await draw(LIST);
    await settle(() => reads > 0, "the lookup");
    await act(async () => late.go(301));
    await settle(() => asked.length > 0, "the answer");
    await settle();
    read = async () => BASELINE; // were it asked again, it would answer at once
    // the user drags Zoom onto GitHub (the list's own drag: Main's move, the service's write, the reload). Preact listens for
    // "DragStart" and the like in this minimal document, which has no ondrag* properties to tell it the lower-case names
    await act(async () => void row("Zoom").dispatch("DragStart"));
    await act(async () => void row("GitHub").dispatch("DragOver"));
    await act(async () => void row("GitHub").dispatch("Drop"));
    await settle(() => saves === 1 && nameOf(rows()[1]!) === "Zoom", "the drag saved");
    await settle();
    expect(picture()).toEqual(["sect | Twitter | alice", "sect | Zoom | carol", "sect | GitHub | bob"]);
    // another device's order synced in: the same accounts, Twitter last
    const first = vault.entries.find((e) => e.issuer === "Twitter")!.order;
    const last = vault.entries.find((e) => e.issuer === "GitHub")!.order;
    editAccount("Twitter", (e) => ({ ...e, order: last }));
    editAccount("GitHub", (e) => ({ ...e, order: first }));
    await repaint();
    await settle();
    expect(picture()).toEqual(["sect | GitHub | bob", "sect | Zoom | carol", "sect | Twitter | alice"]);
    expect(reads).toBe(1);
  });

  it("a late answer, then reloads of the same accounts (a View menu choice, the panel following a setting): nothing moves, nothing is asked again (S1)", async () => {
    const late = deferred();
    read = () => late.p;
    await draw(LIST);
    await settle(() => reads > 0, "the lookup");
    await act(async () => late.go(301));
    await settle(() => asked.length > 0, "the answer");
    read = async () => BASELINE; // were it asked again, it would answer at once
    for (let i = 0; i < 3; i++) {
      await repaint(); // the same accounts, new objects
      await settle();
      expect(picture()).toEqual(PLAIN);
    }
    expect(reads).toBe(1);
    await search("z");
    await search("");
    expect(picture()).toEqual(WITH_LINE); // and the next rebuild of the list shows it
  });

  it("just in time and just late: under 300 ms it is shown at once, at 300 ms it waits", async () => {
    const soon = deferred();
    read = () => soon.p;
    await draw(LIST);
    await settle(() => reads > 0, "the lookup");
    await act(async () => soon.go(299));
    await settle(() => linesOf(row("Twitter")).includes(TWITTER_LINE), "the line, at 299 ms");
    act(() => render(null, root as unknown as Element));
    vi.resetModules();
    reads = 0;
    const at = deferred();
    read = () => at.p;
    await draw(LIST);
    await settle(() => reads > 0, "the lookup");
    await act(async () => at.go(300));
    await settle(() => asked.length > 1, "the answer");
    await settle();
    expect(linesOf(row("Twitter"))).toEqual(["alice"]);
  });

  it("an account's site taken off: its line goes with it at once, before the new answer comes (N3)", async () => {
    await draw([totp("Twitter", "alice", ["twitter.com", "example.org"]), totp("GitHub", "bob", ["github.com"])]);
    await settle(() => linesOf(row("Twitter")).includes(TWITTER_LINE), "the line");
    const late = deferred();
    read = () => late.p;
    editAccount("Twitter", (e) => ({ ...e, domains: ["example.org"] }));
    await repaint();
    await settle(() => reads > 1, "asked again");
    expect(picture()).toEqual(["sect | Twitter | alice", "sect | GitHub | bob"]);
    await act(async () => late.go(301));
    await settle();
    expect(picture()).toEqual(["sect | Twitter | alice", "sect | GitHub | bob"]);
  });

  it("an account given a site of the group: asked again, its line in time; another account's edit moves no other row (N3)", async () => {
    await draw(LIST);
    await settle(() => linesOf(row("Twitter")).includes(TWITTER_LINE), "Twitter's line");
    editAccount("GitHub", (e) => ({ ...e, domains: ["github.com", "twitter.com"] }));
    await repaint();
    await settle(() => linesOf(row("GitHub")).includes(TWITTER_LINE), "GitHub's line, asked again");
    expect(asked).toEqual(["x.com", "x.com"]);
    expect(picture()).toEqual([
      "sect related | Twitter | alice | Same sign-in as twitter.com",
      "sect related | GitHub | bob | Same sign-in as twitter.com",
      "sect | Zoom | carol",
    ]);
  });

  it("the side panel: each page has its own answer, and a late one for a page left behind never shows on another", async () => {
    await draw(LIST, true);
    await settle(() => linesOf(row("Twitter")).includes(TWITTER_LINE), "x.com's line");
    tabUrl = "https://example.org/";
    await act(async () => tabChanged!());
    await settle(() => !linesOf(row("Twitter")).includes(TWITTER_LINE), "example.org's list");
    expect(picture()).toEqual(PLAIN);
    tabUrl = "https://www.x.com/";
    await act(async () => tabChanged!());
    await settle(() => linesOf(row("Twitter")).includes(TWITTER_LINE), "www.x.com's line");
    await settle(() => asked.length === 3, "three pages asked");
    expect(asked).toEqual(["x.com", "example.org", "www.x.com"]);
    // x.com again, its read late this time; the panel moves on to example.org before it comes
    const late = deferred();
    read = () => late.p;
    tabUrl = "https://x.com/i";
    await act(async () => tabChanged!());
    await settle(() => reads === 4, "x.com asked again");
    read = async () => BASELINE;
    tabUrl = "https://example.org/a";
    await act(async () => tabChanged!());
    await settle(() => reads === 5, "example.org asked again");
    await act(async () => late.go(400));
    await settle(() => asked.length === 5, "both answers in");
    await search("tw"); // example.org's list rebuilt: x.com's answer is not in it
    expect(picture()).toEqual(["sect | Twitter | alice"]);
    await search("");
    expect(picture()).toEqual(PLAIN);
  });

  it("not asked: an account registered for the page; no account with a site; a page that is no web page", async () => {
    await draw([totp("X", "a", ["x.com"]), totp("Twitter", "b", ["twitter.com"])]);
    await settle();
    expect(reads).toBe(0); // This site has an account: no Which account line, no lookup
    act(() => render(null, root as unknown as Element));
    vi.resetModules();
    await draw([totp("Twitter", "a"), totp("Zoom", "b")]);
    await settle();
    expect(reads).toBe(0);
    act(() => render(null, root as unknown as Element));
    vi.resetModules();
    tabUrl = "chrome://newtab/";
    await draw(LIST);
    await settle();
    expect(reads).toBe(0);
  });

  it("a read that fails, or a module that cannot be loaded: the list as it was", async () => {
    read = () => Promise.reject(new Error("lost"));
    await draw(LIST);
    await settle(() => reads > 0, "the lookup");
    await settle();
    expect(picture()).toEqual(PLAIN);
    act(() => render(null, root as unknown as Element));
    vi.resetModules();
    vi.doMock("../../src/popup/main/aliases", () => {
      throw new Error("Failed to fetch dynamically imported module");
    });
    try {
      read = async () => BASELINE;
      await draw(LIST);
      await settle();
      expect(picture()).toEqual(PLAIN);
    } finally {
      vi.doUnmock("../../src/popup/main/aliases");
    }
  });

  it("Remember on the row: the sheet for x.com, naming the account's own site; saved, Twitter is This site, with no line", async () => {
    await draw(LIST);
    await settle(() => linesOf(row("Twitter")).includes(TWITTER_LINE), "the line");
    expect(saves).toBe(0); // the suggestion itself writes nothing
    await click(rememberOf(row("Twitter")));
    await settle(() => sheet(), "the remember sheet");
    expect(root.byId("rm-warn")!.textContent).toMatch(/already remembered for twitter\.com/); // AFMATCH's AF-01
    await act(async () => void sheet()!.dispatch("submit"));
    await settle(() => !sheet() && sect(row("Twitter")) === "sect site", "Twitter in This site");
    expect(saves).toBe(1);
    expect(aliveEntries(vault).find((e) => e.issuer === "Twitter")!.domains).toEqual(["twitter.com", "x.com"]);
    expect(linesOf(row("Twitter"))).toEqual(["alice"]);
  });

  it("another account remembered for the page: the other rows' lines go in this opening too, as in the next (N4)", async () => {
    await draw([...LIST, totp("X", "dave")]);
    await settle(() => linesOf(row("Twitter")).includes(TWITTER_LINE), "the line");
    await click(root.byId("ask-pick")); // "Which account for x.com?" → Choose
    await click(rememberOf(row("X")));
    await settle(() => sheet(), "the remember sheet");
    await act(async () => void sheet()!.dispatch("submit"));
    await settle(() => !sheet() && sect(row("X")) === "sect site", "X in This site");
    await settle();
    expect(picture()).toEqual([
      "sect site | X | dave",
      "sect | Twitter | alice",
      "sect | GitHub | bob",
      "sect | Zoom | carol",
    ]);
  });

  // last: it holds the chunk's own module (vitest's importOriginal), which the tests after it must not share
  it("the 300 ms count from the lookup's start in Main, the chunk's load in them: held 300 ms, a fast answer moves nothing; held 299 ms, it is shown", async () => {
    // the chunk's load held by the test (as on a cold or busy open), the package's read then at once
    let release!: () => void;
    let loading = 0;
    const hold = () => {
      const gate = new Promise<void>((ok) => (release = ok));
      vi.doMock("../../src/popup/main/aliases", async (importOriginal) => {
        loading++;
        await gate;
        return importOriginal();
      });
    };
    try {
      hold();
      await draw(LIST);
      await settle(() => loading > 0, "the chunk asked for");
      skew += 300;
      await act(async () => release());
      await settle(() => asked.length > 0, "the answer");
      await settle();
      expect(picture()).toEqual(PLAIN);
      await search("tw");
      await search("");
      expect(picture()).toEqual(WITH_LINE); // kept, and read at the next rebuild of the list
      act(() => render(null, root as unknown as Element));
      vi.resetModules();
      asked = [];
      loading = 0;
      hold();
      await draw(LIST);
      await settle(() => loading > 0, "the chunk asked for");
      skew += 299;
      await act(async () => release());
      await settle(() => linesOf(row("Twitter")).includes(TWITTER_LINE), "the line, at 299 ms");
    } finally {
      vi.doUnmock("../../src/popup/main/aliases");
      vi.resetModules();
    }
  });
});
