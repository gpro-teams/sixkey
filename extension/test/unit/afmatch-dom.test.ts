// AFMATCH (docs/design/notes/AFMATCH-NOTES.md): the popup's list (src/popup/main/Main.tsx, List.tsx) on a page no account
// is registered for, rendered by Preact into a minimal document (test/helpers/mini-dom.ts) over a stand-in chrome.* and
// service: when the line "Which account for <host>?" is there and when it is not, what its button does (every row then
// offers "Remember", the same button a related row has), Escape, and the way from it through the "remember this site"
// sheet (the real one, with this page's choices) to "This site". The owner's case: accounts imported from Google
// Authenticator (no sites), on ws.g.pro. Round 3 (the review, AFMATCH-NOTES.md): the sheet names a picked account's own
// sites (AF-01), it closes with its page or its account (AF-03), and choosing is bound to the page in the side panel's
// first frame (K15). The follow-up after round 3's review (R3-01, R3-02): the warning stands above the Remember button and
// not on a host nothing can be remembered for, an unrelated reload leaves the sheet open, and a sheet whose code loads
// slowly opens on no page but its own. The Fill chunk and the confirm page are stand-ins here; the real browser is
// test/e2e/afmatch.spec.ts's.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSettings } from "../../src/core/service/types";
import { createClock, type Clock } from "../../src/core/vault/hlc";
import { aliveEntries, emptyVault, type Vault } from "../../src/core/vault/model";
import { addEntry, deleteEntry, type NewEntry } from "../../src/core/vault/ops";
import { installMiniDom, MiniElement, type MiniEvent } from "../helpers/mini-dom";

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
// what the owner had: imported from Google Authenticator, so no sites; "ws" is guessed on ws.g.pro (a whole label of 2)
const OWNER = [totp("ws", "admin"), totp("GitHub", "alice"), totp("Zoom", "bob")];

let dom: ReturnType<typeof installMiniDom>;
let root: MiniElement;
let docKeys: ((e: MiniEvent) => void)[];
let docPastes: ((e: MiniEvent) => void)[];
let tabUrl: string | undefined;
let vault: Vault;
let clock: Clock;
let saves: number;
let tabChanged: (() => void) | undefined;
let failSave: boolean;
/** Main drawn again over the vault as it is now (a change made elsewhere, as the service's reload would bring it). */
let repaint: () => Promise<void>;

const els = (test: (e: MiniElement) => boolean) => root.all(test);
const cls = (e: MiniElement, c: string) => (e.getAttribute("class") ?? "").split(" ").includes(c);
const line = () => els((e) => cls(e, "ask"))[0];
const pick = () => root.byId("ask-pick");
const rows = () => els((e) => cls(e, "row"));
const nameOf = (r: MiniElement) => r.all((e) => cls(e, "who"))[0]!.all((e) => e.localName === "b")[0]!.textContent;
const row = (name: string) => rows().find((r) => nameOf(r) === name)!;
const rememberOf = (r: MiniElement) => r.all((e) => e.localName === "button" && cls(e, "remember"))[0];
const sect = (r: MiniElement) => (r.parentNode as MiniElement).getAttribute("class");
const sheet = () => els((e) => e.localName === "form" && cls(e, "rm"))[0];
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
/** A key pressed with the focus on nothing in particular, as the document's listeners (Main's) hear it; the event. */
async function key(k: string) {
  const ev = {
    key: k,
    target: dom.doc.body,
    defaultPrevented: false,
    preventDefault: () => (ev.defaultPrevented = true),
  };
  await act(async () => {
    for (const f of docKeys) f(ev as unknown as MiniEvent);
  });
  return ev;
}
/** Ctrl+V with an otpauth link, with the focus on nothing in particular, as Main's document listener hears it. */
async function paste() {
  const text = "otpauth://totp/New:x?secret=JBSWY3DPEHPK3PXP&issuer=New";
  const ev = {
    target: dom.doc.body,
    clipboardData: { files: [], getData: (t: string) => (t === "text/plain" ? text : "") },
    defaultPrevented: false,
    preventDefault: () => (ev.defaultPrevented = true),
  };
  await act(async () => {
    for (const f of docPastes) f(ev as unknown as MiniEvent);
  });
  return ev;
}
/** The remember sheet's warning (AF-01), or undefined. */
const warning = () => root.byId("rm-warn") ?? undefined;

function vaultOf(list: NewEntry[]): Vault {
  let v = emptyVault("v1");
  for (const e of list) v = addEntry(v, e, clock).vault;
  return v;
}

/** Main, drawn over the stand-ins, in `lang`; `reload` draws it again over the vault as the service now has it. */
async function draw(list: NewEntry[], lang: "en" | "zh_CN" = "en", panel = false) {
  vault = vaultOf(list);
  const i18n = await import("../../src/ui/i18n");
  const { fullCatalog } = await import("../../src/ui/catalog-full");
  i18n.setLangChoice(lang);
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
        if (failSave) throw new Error("the write failed");
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
          vault,
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
  await settle(() => rows().length > 0 || els((e) => cls(e, "empty")).length > 0); // the tab's address is in
}

beforeEach(() => {
  vi.resetModules();
  // the Fill chunk (Fill.tsx, loaded once "This site" has an account): a stand-in that marks where its parts go
  vi.doMock("../../src/popup/main/Fill", () => ({
    connect: () => undefined,
    FillBar: () => h("div", { class: "fillbar" }),
    RowFill: (p: { entry: { id: string } }) =>
      h("button", { type: "button", class: "fillbtn", "data-for": p.entry.id }),
    Resume: () => null,
  }));
  // the confirm page (AddConfirm.tsx, loaded on a paste): a stand-in that shows it was opened
  vi.doMock("../../src/popup/main/AddConfirm", () => ({ AddConfirm: () => h("div", { id: "confirm-stub" }) }));
  dom = installMiniDom();
  root = dom.doc.body;
  docKeys = [];
  docPastes = [];
  saves = 0;
  failSave = false;
  tabChanged = undefined;
  tabUrl = "https://ws.g.pro/admin/";
  clock = createClock("aaaa");
  const proto = MiniElement.prototype as unknown as Record<string, unknown>;
  // what RememberSheet asks for: the radio that is checked (its first focus)
  proto.querySelector = function (this: MiniElement) {
    return this.all((e) => e.localName === "input" && e.checked)[0] ?? null;
  };
  Object.assign(dom.doc, {
    documentElement: dom.doc.createElement("html"),
    getElementById: (id: string) => root.byId(id),
    querySelector: () => null,
    addEventListener: (type: string, f: (e: MiniEvent) => void) =>
      type === "keydown" ? docKeys.push(f) : type === "paste" && docPastes.push(f),
    removeEventListener: (type: string, f: (e: MiniEvent) => void) => {
      docKeys = docKeys.filter((x) => x !== f);
      docPastes = docPastes.filter((x) => x !== f);
    },
  });
  g.chrome = {
    tabs: { query: async () => [{ id: 7, windowId: 1, url: tabUrl }] },
    commands: { getAll: async () => [] },
    storage: { session: { get: async () => ({}) } },
    runtime: { getURL: (p: string) => p },
  };
  g.window = Object.assign(globalThis, { document: dom.doc, innerHeight: 600 });
  g.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  g.CSS = { escape: (v: string) => v }; // the arrow keys find the next row by its id
});
afterEach(() => {
  act(() => render(null, root as unknown as Element));
  dom.undo();
  vi.doUnmock("../../src/popup/main/Fill");
  vi.doUnmock("../../src/popup/main/AddConfirm");
  vi.doUnmock("../../src/popup/main/Remember");
  delete g.chrome;
  delete g.localStorage;
  delete g.CSS;
});

describe("the owner's case: ws.g.pro, accounts with no sites", () => {
  it("the line asks which account it is, above the sections, and only the guessed row offers Remember", async () => {
    await draw(OWNER);
    const l = line()!;
    expect(l).toBeDefined();
    expect(root.byId("ask-q")!.textContent).toBe("Which account for ws.g.pro?");
    expect(pick()!.textContent).toBe("Choose");
    expect(pick()!.type).toBe("button");
    expect(pick()!.getAttribute("aria-describedby")).toBe("ask-q"); // a screen reader hears the question with it
    expect(root.byId("list")!.childNodes[0]).toBe(l); // above every section
    expect(sect(row("ws"))).toMatch(/related/); // the guess of 2 (match.ts)
    expect(rows().map((r) => !!rememberOf(r))).toEqual([true, false, false]);
    expect(els((e) => cls(e, "site"))).toEqual([]);
  });

  it("in Chinese: the same line, its own words", async () => {
    await draw(OWNER, "zh_CN");
    expect(root.byId("ask-q")!.textContent).toBe("用哪个账户登录 ws.g.pro？");
    expect(pick()!.textContent).toBe("选择");
    await click(pick());
    expect(pick()!.textContent).toBe("取消");
    expect(rememberOf(row("Zoom"))!.getAttribute("aria-label")).toBe("记住：ws.g.pro 属于此账户 (Zoom)");
  });

  it("Choose: every row offers Remember, the related row's own button (name, text, tab order); Cancel ends it", async () => {
    await draw(OWNER);
    const before = rememberOf(row("ws"))!;
    const shape = (b: MiniElement, name: string) => ({
      tag: b.localName,
      type: b.type,
      class: b.getAttribute("class"),
      label: b.getAttribute("aria-label")!.replace(` (${name})`, " (NAME)"),
      text: b.textContent,
      icon: b.childNodes.map((c) => c.localName),
    });
    const related = shape(before, "ws");
    expect(related.label).toBe("Remember: ws.g.pro belongs to this account (NAME)");
    await click(pick());
    expect(pick()!.textContent).toBe("Cancel");
    expect(rows().map((r) => !!rememberOf(r))).toEqual([true, true, true]);
    for (const name of ["ws", "GitHub", "Zoom"]) expect(shape(rememberOf(row(name))!, name), name).toEqual(related);
    // only the selected row's buttons are in the tab order (roving tabindex): the first row, as for its copy button
    expect(rows().map((r) => rememberOf(r)!.getAttribute("tabIndex"))).toEqual(["0", "-1", "-1"]);
    expect(rows().map((r) => r.all((e) => cls(e, "copy"))[0]!.getAttribute("tabIndex"))).toEqual(["0", "-1", "-1"]);
    await click(pick());
    expect(pick()!.textContent).toBe("Choose");
    expect(rows().map((r) => !!rememberOf(r))).toEqual([true, false, false]);
  });

  it("Escape ends the choosing, puts the focus on the line's button, and is not passed on", async () => {
    await draw(OWNER);
    const nothing = await key("Escape"); // not choosing: Escape is not taken
    expect(nothing.defaultPrevented).toBe(false);
    await click(pick());
    expect(rememberOf(row("GitHub"))).toBeDefined();
    dom.doc.activeElement = null;
    const ev = await key("Escape");
    expect(ev.defaultPrevented).toBe(true);
    expect(rows().map((r) => !!rememberOf(r))).toEqual([true, false, false]);
    expect(pick()!.textContent).toBe("Choose");
    expect(dom.doc.activeElement).toBe(pick());
  });

  it("picking an account: the remember sheet with this page's choices; saved, it is This site, with the Fill slot, and the line goes", async () => {
    await draw(OWNER);
    await click(pick());
    await click(rememberOf(row("GitHub"))); // any account, not only a guessed one
    await settle(() => sheet(), "the remember sheet");
    const radios = sheet()!.all((e) => e.localName === "input");
    expect(radios.map((r) => [r.value, r.checked])).toEqual([
      ["ws.g.pro", true],
      ["g.pro", false],
    ]);
    expect(saves).toBe(0);
    await act(async () => void sheet()!.dispatch("submit"));
    await settle(() => !sheet() && rows().some((r) => /\bsite\b/.test(sect(r) ?? "")), "GitHub in This site");
    expect(saves).toBe(1);
    expect(aliveEntries(vault).find((e) => e.issuer === "GitHub")!.domains).toEqual(["ws.g.pro"]);
    expect(sect(row("GitHub"))).toBe("sect site");
    await settle(() => els((e) => cls(e, "fillbtn")).length > 0, "the Fill chunk");
    expect(row("GitHub").all((e) => cls(e, "fillbtn"))).toHaveLength(1); // Main put the Fill button in its card
    expect(els((e) => cls(e, "fillbar"))).toHaveLength(1);
    expect(line()).toBeUndefined();
    expect(pick()).toBeNull();
    // the choosing ended with it: only the guess still offers Remember
    expect(rows().map((r) => [nameOf(r), !!rememberOf(r)])).toEqual([
      ["GitHub", false],
      ["ws", true],
      ["Zoom", false],
    ]);
  });

  it("the sheet cancelled: still choosing, nothing written", async () => {
    await draw(OWNER);
    await click(pick());
    await click(rememberOf(row("Zoom")));
    await settle(() => sheet(), "the remember sheet");
    const cancel = sheet()!.all((e) => e.localName === "button" && e.textContent === "Cancel")[0];
    await click(cancel);
    expect(sheet()).toBeUndefined();
    expect(saves).toBe(0);
    expect(pick()!.textContent).toBe("Cancel");
    expect(rows().every((r) => !!rememberOf(r))).toBe(true);
  });
});

describe("when the line is not there", () => {
  it("an account registered for the page", async () => {
    await draw([totp("ws", "admin", ["ws.g.pro"]), totp("Zoom", "bob")]);
    expect(sect(row("ws"))).toBe("sect site");
    expect(line()).toBeUndefined();
    expect(pick()).toBeNull();
  });

  it("an account registered for a parent of the page", async () => {
    await draw([totp("Zoom", "bob"), totp("Admin", "x", ["g.pro"])]);
    expect(sect(row("Admin"))).toBe("sect site");
    expect(line()).toBeUndefined();
  });

  it("while searching; and a search ends the choosing", async () => {
    await draw(OWNER);
    await click(pick());
    const q = root.byId("q")!;
    // the search's first frame, drawn before any effect has run (outside act: Preact draws on a microtask, its effects
    // come a frame later): already no line, and no Remember on a result, not even for that frame
    q.value = "zo";
    q.dispatch("input");
    await new Promise((r) => setTimeout(r, 0));
    expect(line()).toBeUndefined();
    expect(rows().map((r) => [nameOf(r), !!rememberOf(r)])).toEqual([["Zoom", false]]);
    await settle();
    expect(line()).toBeUndefined();
    expect(rows().map((r) => [nameOf(r), !!rememberOf(r)])).toEqual([["Zoom", false]]);
    await act(async () => {
      q.value = "";
      q.dispatch("input");
    });
    expect(pick()!.textContent).toBe("Choose"); // back, not choosing
    expect(rows().map((r) => !!rememberOf(r))).toEqual([true, false, false]);
  });

  it("with no accounts at all", async () => {
    await draw([]);
    expect(root.byId("empty-paste")).not.toBeNull();
    expect(line()).toBeUndefined();
  });

  for (const url of ["http://localhost:3000/", "chrome://newtab/", "file:///tmp/x.html", undefined])
    it(`on a page that cannot be registered: ${url ?? "no address"}`, async () => {
      tabUrl = url;
      await draw(OWNER);
      expect(line()).toBeUndefined();
      expect(rows().some((r) => !!rememberOf(r))).toBe(false);
    });

  it("an IP address can be registered: the line asks there too", async () => {
    tabUrl = "http://192.168.1.10:5001/";
    await draw(OWNER);
    expect(root.byId("ask-q")!.textContent).toBe("Which account for 192.168.1.10?");
  });
});

describe("the side panel, which follows the active tab", () => {
  it("another tab ends the choosing, and the line asks about that page", async () => {
    await draw(OWNER, "en", true);
    expect(tabChanged).toBeDefined();
    await click(pick());
    expect(rows().every((r) => !!rememberOf(r))).toBe(true);
    tabUrl = "https://zoom.example.com/";
    await act(async () => tabChanged!());
    await settle(() => root.byId("ask-q")?.textContent === "Which account for zoom.example.com?", "the new page");
    expect(pick()!.textContent).toBe("Choose");
    expect(rows().map((r) => [nameOf(r), !!rememberOf(r)])).toEqual([
      ["Zoom", true],
      ["ws", false],
      ["GitHub", false],
    ]);
    // a tab with no address (the icon not clicked on it): no line, nothing to remember
    tabUrl = undefined;
    await act(async () => tabChanged!());
    await settle(() => !line(), "no line");
    expect(rows().some((r) => !!rememberOf(r))).toBe(false);
  });
});

// Round 3, AF-01: an account picked from the line can already have sites of its own, on any page, a look-alike's too (a
// related one never has: match.ts stops guessing for it). The sheet then says so above Save, and still saves.
describe("the remember sheet names a picked account's own sites", () => {
  const LOOKALIKE = "https://github.com.attacker.io/login";
  const submit = () => sheet()!.all((e) => e.localName === "button" && e.type === "submit")[0]!;

  it("a bound account on a look-alike: the warning, tied to the dialog; Save is still there and saves", async () => {
    tabUrl = LOOKALIKE;
    await draw([totp("GitHub", "alice", ["github.com"]), totp("Zoom", "bob", ["com"])]);
    expect(rows().some((r) => !!rememberOf(r))).toBe(false); // bound: never a guess, so nothing offered before Choose
    await click(pick());
    await click(rememberOf(row("GitHub")));
    await settle(() => sheet(), "the remember sheet");
    expect(warning()?.textContent).toBe(
      "This account is already remembered for github.com. Remember only if this page is the same service.",
    );
    expect((sheet()!.parentNode as MiniElement).getAttribute("aria-describedby")).toBe("rm-warn");
    expect(
      sheet()!
        .all((e) => e.localName === "input")
        .map((r) => [r.value, r.checked]),
    ).toEqual([
      ["github.com.attacker.io", true],
      ["com.attacker.io", false],
      ["attacker.io", false],
    ]);
    expect(submit().disabled).toBe(false);
    // right above the Remember button, where the eye is when it is pressed (R3-02): before the buttons' row, with no
    // element in between
    const kids = sheet()!.childNodes;
    const [at, acts] = [kids.indexOf(warning()!), kids.indexOf(sheet()!.all((e) => cls(e, "acts"))[0]!)];
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(acts);
    expect(kids.slice(at + 1, acts).filter((n) => n instanceof MiniElement)).toEqual([]);
    await act(async () => void sheet()!.dispatch("submit"));
    await settle(() => !sheet(), "saved");
    expect(saves).toBe(1);
    expect(aliveEntries(vault).find((e) => e.issuer === "GitHub")!.domains).toEqual([
      "github.com",
      "github.com.attacker.io",
    ]);
  });

  it('an account with no usable site of its own (a stored "com" does not count): no warning', async () => {
    tabUrl = LOOKALIKE;
    await draw([totp("GitHub", "alice", ["github.com"]), totp("Zoom", "bob", ["com"])]);
    await click(pick());
    await click(rememberOf(row("Zoom")));
    await settle(() => sheet(), "the remember sheet");
    expect(warning()).toBeUndefined();
    expect((sheet()!.parentNode as MiniElement).getAttribute("aria-describedby")).toBeNull();
  });

  it("a host nothing can be remembered for (github.io, a shared suffix): no Remember button, so no warning", async () => {
    tabUrl = "https://github.io/";
    await draw([totp("GitHub", "alice", ["github.com"])]);
    await click(pick());
    await click(rememberOf(row("GitHub")));
    await settle(() => sheet(), "the remember sheet");
    expect(sheet()!.textContent).toContain("github.io is shared by many unrelated sites, so it cannot be remembered.");
    expect(sheet()!.all((e) => e.localName === "button" && e.type === "submit")).toEqual([]);
    expect(warning()).toBeUndefined();
  });

  it("the related path (a guess, so never bound): no warning", async () => {
    await draw(OWNER);
    await click(rememberOf(row("ws"))); // not choosing: the guess's own Remember
    await settle(() => sheet(), "the remember sheet");
    expect(warning()).toBeUndefined();
  });

  it("two sites are both named", async () => {
    tabUrl = LOOKALIKE;
    await draw([totp("GitHub", "alice", ["github.com", "gist.github.com"])]);
    await click(pick());
    await click(rememberOf(row("GitHub")));
    await settle(() => sheet(), "the remember sheet");
    expect(warning()?.textContent).toMatch(/^This account is already remembered for github\.com, gist\.github\.com\. /);
  });

  it("in Chinese, more than two: the first two, then …, a duplicate and an unusable one left out", async () => {
    tabUrl = LOOKALIKE;
    const sites = ["github.com", "GitHub.com.", "com", "gist.github.com", "githubusercontent.com"];
    await draw([totp("GitHub", "alice", sites)], "zh_CN");
    await click(pick());
    await click(rememberOf(row("GitHub")));
    await settle(() => sheet(), "the remember sheet");
    expect(warning()?.textContent).toBe(
      "这个账户已记住 github.com、gist.github.com、…。确认这里也是它的网站再点“记住”。",
    );
  });

  it("a save that fails: the error, still choosing, nothing written", async () => {
    await draw(OWNER);
    await click(pick());
    await click(rememberOf(row("GitHub")));
    await settle(() => sheet(), "the remember sheet");
    failSave = true;
    await act(async () => void sheet()!.dispatch("submit"));
    await settle(() => !sheet(), "the sheet closed");
    expect(saves).toBe(0);
    expect(aliveEntries(vault).every((e) => !e.domains)).toBe(true);
    expect(els((e) => cls(e, "toast")).map((e) => e.textContent)).toEqual(["Something unexpected went wrong"]);
    expect(pick()!.textContent).toBe("Cancel");
    expect(rows().every((r) => !!rememberOf(r))).toBe(true);
  });
});

// Round 3, AF-03: the sheet is for one account on one page. While it is open, the list's keys and paste wait for it.
describe("the remember sheet closes with its page or its account", () => {
  const radios = () =>
    sheet()
      ?.all((e) => e.localName === "input")
      .map((r) => r.value);
  async function sheetOpen(panel: boolean) {
    await draw(OWNER, "en", panel);
    await click(pick());
    await click(rememberOf(row("Zoom")));
    await settle(() => sheet(), "the remember sheet");
    expect(
      sheet()!
        .all((e) => e.localName === "input")
        .map((r) => r.value),
    ).toEqual(["ws.g.pro", "g.pro"]);
  }

  it("side panel, another tab: the sheet closes (never ws.g.pro's names on zoom.example.com); typing and paste work", async () => {
    await sheetOpen(true);
    tabUrl = "https://zoom.example.com/";
    await act(async () => tabChanged!());
    await settle(() => root.byId("ask-q")?.textContent === "Which account for zoom.example.com?", "the new page");
    expect(sheet()).toBeUndefined();
    dom.doc.activeElement = null;
    await key("z");
    expect(dom.doc.activeElement).toBe(root.byId("q")); // a letter goes to the search, as on the list
    expect((await paste()).defaultPrevented).toBe(true);
    await settle(() => root.byId("confirm-stub"), "the confirm page");
  });

  it("side panel, a tab with no address: the sheet closes; the arrows and paste work", async () => {
    await sheetOpen(true);
    tabUrl = undefined;
    await act(async () => tabChanged!());
    await settle(() => !line(), "no line");
    expect(sheet()).toBeUndefined();
    expect((await key("ArrowDown")).defaultPrevented).toBe(true);
    // back on the page: the sheet does not come back
    tabUrl = "https://ws.g.pro/admin/";
    await act(async () => tabChanged!());
    await settle(() => !!line(), "the line again");
    expect(sheet()).toBeUndefined();
    expect((await paste()).defaultPrevented).toBe(true);
    await settle(() => root.byId("confirm-stub"), "the confirm page");
  });

  it("another account changed elsewhere (the vault read again): the sheet stays open, as it was", async () => {
    await sheetOpen(true);
    const github = aliveEntries(vault).find((e) => e.issuer === "GitHub")!.id;
    vault = deleteEntry(vault, github, clock);
    await repaint();
    await settle(() => !rows().some((r) => nameOf(r) === "GitHub"), "GitHub gone");
    expect(radios()).toEqual(["ws.g.pro", "g.pro"]);
  });

  it("side panel, another tab of the same site: the sheet stays open", async () => {
    await sheetOpen(true);
    tabUrl = "https://ws.g.pro/other/page";
    await act(async () => tabChanged!());
    await settle();
    expect(radios()).toEqual(["ws.g.pro", "g.pro"]);
  });

  it("the account deleted elsewhere: the sheet closes, the keys work", async () => {
    await sheetOpen(false);
    const zoom = aliveEntries(vault).find((e) => e.issuer === "Zoom")!.id;
    vault = deleteEntry(vault, zoom, clock);
    await repaint();
    await settle(() => !rows().some((r) => nameOf(r) === "Zoom"), "Zoom gone");
    expect(sheet()).toBeUndefined();
    expect((await key("ArrowDown")).defaultPrevented).toBe(true);
  });
});

// Round 3, K15 (the review's survivor): in the side panel, the first frame on another page no account is registered for,
// drawn before any effect has run (outside act, as the search's first frame above): the choosing was for the page
// before, so it is not choosing here, not even for that frame.
describe("choosing is bound to its page", () => {
  it("side panel, the first frame on another unregistered page", async () => {
    await draw(OWNER, "en", true);
    await click(pick());
    expect(rows().every((r) => !!rememberOf(r))).toBe(true);
    tabUrl = "https://zoom.example.com/";
    void tabChanged!();
    await new Promise((r) => setTimeout(r, 0));
    expect(root.byId("ask-q")!.textContent).toBe("Which account for zoom.example.com?");
    expect(pick()!.textContent).toBe("Choose");
    expect(rows().map((r) => [nameOf(r), !!rememberOf(r)])).toEqual([
      ["Zoom", true],
      ["ws", false],
      ["GitHub", false],
    ]);
    await settle();
    expect(pick()!.textContent).toBe("Choose");
  });
});

// R3-01: the sheet's code comes in with the first Remember (the remember sheet and the site rules, two lazy chunks). If
// the side panel moves to another page while they load, nothing opens: the closing above runs when the page changes,
// which is before this sheet exists.
describe("a sheet whose code loads slowly opens on no page but its own", () => {
  it("side panel: Remember on ws.g.pro, then zoom.example.com before the code is in: no sheet; there, its own", async () => {
    let loaded!: () => void;
    const code = new Promise<void>((r) => (loaded = r));
    vi.doMock("../../src/popup/main/Remember", async () => {
      await new Promise((r) => setTimeout(r, 300)); // a first load on a slow machine
      const m = await vi.importActual("../../src/popup/main/Remember");
      loaded();
      return m;
    });
    await draw(OWNER, "en", true);
    await click(pick());
    await click(rememberOf(row("Zoom"))); // the code starts loading, for ws.g.pro
    tabUrl = "https://zoom.example.com/";
    await act(async () => tabChanged!());
    await settle(() => root.byId("ask-q")?.textContent === "Which account for zoom.example.com?", "the new page");
    expect(sheet()).toBeUndefined();
    await act(async () => {
      await code;
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(sheet()).toBeUndefined(); // the code is in: still nothing for the page left behind
    await click(rememberOf(row("Zoom"))); // Zoom is the guess here
    await settle(() => sheet(), "the remember sheet");
    expect(
      sheet()!
        .all((e) => e.localName === "input")
        .map((r) => r.value),
    ).toEqual(["zoom.example.com", "example.com"]);
  });
});
