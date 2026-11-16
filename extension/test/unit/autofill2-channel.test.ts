// TOTP autofill Stage 2, patch 3: the content script's channel and its registration (docs/design/notes/AUTOFILL2-NOTES.md
// §9), over stand-ins:
//   - the content script's own logic (src/inject/suggest-core.ts): only a trusted event on a code-ready <input> is a reason
//     to look; a page's focus() or its own synthetic events never are; the box must be the one the finder names, with a
//     score of 60, not weak, room for 6 or 8 digits; one look per 2 s; one message per page address;
//   - who sent a message (sender-policy.ts contentSender): from the browser's fields only, each refused in turn;
//   - the worker's end (platform/content-channel.ts): only the message's type is read (a claimed origin, URL or tab is
//     ignored, and so are unknown fields); 10 a minute per tab; the gate; both hosts on the list and granted; the badge;
//   - the registration (platform/autofill-register.ts): exactly the sites that count, the pinned object, the gate asked
//     again before registering, updated when the sites change, removed when none count (a revocation).
import { describe, expect, it } from "vitest";
import { boxOf, qualifies, roomy, watcher, type Finder } from "../../src/inject/suggest-core";
import { applyRegistration, SCRIPT_FILES, SCRIPT_ID, type Registrar } from "../../src/platform/autofill-register";
import {
  CAND_PER_MINUTE,
  createContentChannel,
  showCanFill,
  type BadgeChrome,
} from "../../src/platform/content-channel";
import { CONTENT_MESSAGES, contentSender, contentType, knownType } from "../../src/platform/sender-policy";

const SELF = "abcdefghijklmnopabcdefghijklmnop";

// ---- the content script ----------------------------------------------------------------------------------------------

/** A stand-in <input>: what boxOf reads of one. */
class FakeInput {
  type = "text";
  readOnly = false;
  disabled = false;
  w = 100;
  getBoundingClientRect() {
    return { width: this.w, height: this.w ? 20 : 0 };
  }
}
(globalThis as { HTMLInputElement?: unknown }).HTMLInputElement = FakeInput;
const input = (o: Partial<FakeInput> = {}) => Object.assign(new FakeInput(), o) as unknown as HTMLInputElement;
const finder = (c: Partial<Finder> & { box?: unknown; found?: Record<string, unknown>[]; z?: 0 | 1 } = {}) => {
  let looks = 0;
  const f = {
    inspect: () => (
      looks++,
      { c: (c.found ?? [{ t: "aaaaaaaaaaaaaaaa", k: 0, n: 6, s: 80, weak: false }]) as never, z: c.z ?? 0 }
    ),
    of: (el: unknown) => (el === c.box ? "aaaaaaaaaaaaaaaa" : null),
  } as Finder;
  return { f, looks: () => looks };
};

describe("the content script: when it looks, and when it tells the worker", () => {
  it("only an event the browser marks as the user's, on a text-like, editable <input> with a size", () => {
    const el = input();
    expect(boxOf({ isTrusted: true, target: el })).toBe(el);
    expect(boxOf({ isTrusted: false, target: el })).toBeNull(); // the page's own dispatchEvent, el.focus() handlers
    for (const t of ["text", "tel", "number", "password", ""])
      expect(boxOf({ isTrusted: true, target: input({ type: t }) })).not.toBeNull();
    for (const t of ["email", "search", "checkbox", "hidden", "date"])
      expect(boxOf({ isTrusted: true, target: input({ type: t }) }), t).toBeNull();
    expect(boxOf({ isTrusted: true, target: input({ readOnly: true }) })).toBeNull();
    expect(boxOf({ isTrusted: true, target: input({ disabled: true }) })).toBeNull();
    expect(boxOf({ isTrusted: true, target: input({ w: 0 }) })).toBeNull();
    expect(boxOf({ isTrusted: true, target: { type: "text" } })).toBeNull(); // not an input element
    // a box in an open shadow root: the event's first target, not its host
    expect(boxOf({ isTrusted: true, target: {}, composedPath: () => [el] })).toBe(el);
  });

  it("the box must be the one the finder names: score 60 or more, not weak, room for 6 or 8 digits", () => {
    const el = input();
    const one = (f: Record<string, unknown>) =>
      qualifies(finder({ box: el, found: [{ t: "aaaaaaaaaaaaaaaa", ...f }] }).f, el);
    expect(one({ k: 0, n: 6, s: 60, weak: false })).toBe(true);
    expect(one({ k: 0, n: 0, s: 90, weak: false })).toBe(true);
    expect(one({ k: 1, n: 8, s: 90, weak: false })).toBe(true);
    expect(one({ k: 0, n: 6, s: 59, weak: false })).toBe(false);
    expect(one({ k: 0, n: 6, s: 90, weak: true })).toBe(false);
    expect(one({ k: 0, n: 4, s: 90, weak: false })).toBe(false);
    expect(one({ k: 1, n: 4, s: 90, weak: false })).toBe(false);
    expect(qualifies(finder({ box: input() }).f, el)).toBe(false); // the finder names another box
    expect(qualifies(finder({ box: el, z: 1 }).f, el)).toBe(false); // a page too complex to look through
    expect([roomy({ k: 1, n: 6 }), roomy({ k: 1, n: 7 }), roomy({ k: 0, n: 7 })]).toEqual([true, false, true]);
  });

  it("one look per 2 s, one message per page address (its hash aside), none for a page's own event", () => {
    const el = input();
    const { f, looks } = finder({ box: el });
    let sent = 0;
    let t = 0;
    const on = watcher(
      () => f,
      () => void sent++,
      () => t,
    );
    on({ isTrusted: false, target: el }, "https://a.example/login");
    expect([looks(), sent]).toEqual([0, 0]);
    on({ isTrusted: true, target: el }, "https://a.example/login");
    expect([looks(), sent]).toEqual([1, 1]);
    t += 5000;
    on({ isTrusted: true, target: el }, "https://a.example/login#step2");
    expect([looks(), sent]).toEqual([1, 1]); // the same page
    on({ isTrusted: true, target: el }, "https://a.example/next");
    expect([looks(), sent]).toEqual([2, 2]); // a single-page app's next address
    on({ isTrusted: true, target: el }, "https://a.example/again");
    expect([looks(), sent]).toEqual([2, 2]); // within 2 s of the last look: no look
    t += 2000;
    // a box that does not qualify: looked at, nothing sent, and no second look within 2 s
    const other = input();
    on({ isTrusted: true, target: other }, "https://a.example/third");
    on({ isTrusted: true, target: other }, "https://a.example/third");
    expect([looks(), sent]).toEqual([3, 2]);
    t += 2000;
    on({ isTrusted: true, target: el }, "https://a.example/third");
    expect([looks(), sent]).toEqual([4, 3]);
    // no finder in this world (it was not installed): nothing
    const none = watcher(
      () => undefined,
      () => void sent++,
      () => t,
    );
    none({ isTrusted: true, target: el }, "https://a.example/x");
    expect(sent).toBe(3);
  });
});

// ---- who sent it ----------------------------------------------------------------------------------------------------

const good = () => ({
  id: SELF,
  url: "https://login.example.com/2fa?x=1",
  origin: "https://login.example.com",
  frameId: 0,
  documentId: "0123456789ABCDEF0123456789ABCDEF",
  documentLifecycle: "active",
  tab: { id: 7, windowId: 3, url: "https://login.example.com/2fa?x=1", active: true, incognito: false },
});

describe("contentSender: who sent a content script's message, from the browser's fields only", () => {
  it("the real shape (as a registered content script's message arrives)", () => {
    expect(contentSender(good(), SELF)).toEqual({
      tabId: 7,
      windowId: 3,
      frameId: 0,
      documentId: "0123456789ABCDEF0123456789ABCDEF",
      host: "login.example.com",
      topHost: "login.example.com",
    });
    // a frame of another https site under it: both hosts, for the worker to check
    const frame = { ...good(), frameId: 4, url: "https://auth.example.net/f", origin: "https://auth.example.net" };
    expect(contentSender(frame, SELF)).toMatchObject({
      host: "auth.example.net",
      topHost: "login.example.com",
      frameId: 4,
    });
  });

  it("refuses each departure from it", () => {
    const g = good();
    const cases: [string, unknown][] = [
      ["no sender", undefined],
      ["another extension", { ...g, id: "ponmlkjihgfedcbaponmlkjihgfedcba" }],
      ["no tab (an extension page, a worker)", { ...g, tab: undefined }],
      ["a tab without an ID", { ...g, tab: { ...g.tab, id: undefined } }],
      ["a tab without a window", { ...g, tab: { ...g.tab, windowId: undefined } }],
      ["a tab without an address", { ...g, tab: { ...g.tab, url: undefined } }],
      ["a tab behind another (not active)", { ...g, tab: { ...g.tab, active: false } }],
      ["an incognito tab", { ...g, tab: { ...g.tab, incognito: true } }],
      ["no document ID", { ...g, documentId: undefined }],
      ["no frame ID", { ...g, frameId: undefined }],
      ["a prerendered document", { ...g, documentLifecycle: "prerender" }],
      ["a document in the back-forward cache", { ...g, documentLifecycle: "cached" }],
      ["an http frame", { ...g, origin: "http://login.example.com", url: "http://login.example.com/2fa" }],
      [
        "a frame at another port",
        { ...g, origin: "https://login.example.com:8443", url: "https://login.example.com:8443/" },
      ],
      ["an address not on the origin", { ...g, url: "https://evil.example/2fa" }],
      ["an address that only starts like it", { ...g, url: "https://login.example.com.evil.example/" }],
      ["no origin", { ...g, origin: undefined }],
      ["an opaque origin", { ...g, origin: "null" }],
      [
        "an extension page as the frame",
        { ...g, origin: `chrome-extension://${SELF}`, url: `chrome-extension://${SELF}/x` },
      ],
      ["an http top page", { ...g, tab: { ...g.tab, url: "http://login.example.com/" } }],
      ["a top page at another port", { ...g, tab: { ...g.tab, url: "https://login.example.com:444/" } }],
    ];
    for (const [what, s] of cases) expect(contentSender(s as never, SELF), what).toBeNull();
    expect(contentSender(g, "")).toBeNull();
  });

  it("the content script's types are its own: no page's row takes them, and they take no page's type", () => {
    expect(contentType({ type: "sk-af-cand" })).toBe("sk-af-cand");
    expect(knownType({ type: "sk-af-cand" })).toBeNull();
    for (const t of ["sk-clip-arm", "sk-api", "sk-af-use", "constructor", "toString"])
      expect(contentType({ type: t }), t).toBeNull();
    expect(contentType(Object.create({ type: "sk-af-cand" }))).toBeNull(); // own property only
    expect(Object.keys(CONTENT_MESSAGES)).toEqual(["sk-af-cand"]);
  });
});

// ---- the worker's end -----------------------------------------------------------------------------------------------

function channel(o: { sites?: string[]; granted?: string[]; gate?: boolean; off?: boolean | "throws" } = {}) {
  const st = {
    sites: o.sites ?? ["login.example.com"],
    granted: new Set(o.granted ?? ["login.example.com"]),
    gate: o.gate ?? true,
    off: o.off ?? false,
  };
  const badges: number[] = [];
  const asked: string[] = [];
  /** The deps read, in order: the switch, the gate and the list (Chrome's grants are `asked`). */
  const reads: string[] = [];
  let t = 1_000_000;
  const on = createContentChannel({
    selfId: SELF,
    off: async () => {
      reads.push("off");
      if (st.off === "throws") throw new Error("storage.local unavailable");
      return st.off;
    },
    gate: async () => (reads.push("gate"), st.gate),
    sites: async () => (reads.push("sites"), st.sites),
    granted: async (h) => (asked.push(h), st.granted.has(h)),
    badge: async (tabId) => void badges.push(tabId),
    now: () => t,
  });
  return { on, st, badges, asked, reads, tick: (ms: number) => void (t += ms) };
}
const cand = { type: "sk-af-cand" };

describe("the worker's end: the badge, and nothing else", () => {
  it("a message from a site the user turned on, granted: the tab's badge", async () => {
    const c = channel();
    expect(await c.on(cand, good())).toBe("badge");
    expect(c.badges).toEqual([7]);
    expect(c.asked).toEqual(["login.example.com"]);
  });

  it("unknown fields are ignored: a message with more in it works as the bare one", async () => {
    const c = channel();
    expect(await c.on({ ...cand, extra: 1, t: "aaaaaaaaaaaaaaaa", code: "123456" }, good())).toBe("badge");
  });

  it("a claimed origin, address or tab is ignored: only the browser's sender counts", async () => {
    // a page of an ungranted site claims to be the granted one: nothing
    const c = channel();
    const evil = {
      ...good(),
      url: "https://evil.example/",
      origin: "https://evil.example",
      tab: { ...good().tab, url: "https://evil.example/" },
    };
    const claims = {
      ...cand,
      origin: "https://login.example.com",
      url: "https://login.example.com/2fa",
      host: "login.example.com",
      tabId: 99,
    };
    expect(await c.on(claims, evil)).toBe("not-on");
    expect(c.badges).toEqual([]);
    // and the real granted page's message claiming another tab still badges its own tab only
    expect(await c.on({ ...cand, tabId: 99, tab: { id: 99 } }, good())).toBe("badge");
    expect(c.badges).toEqual([7]);
  });

  it("a frame of an ungranted site inside a granted page, claiming the granted origin or address, gets nothing", async () => {
    // the top page is a site the user turned on; the frame is not, and says it is
    const c = channel();
    const frame = { ...good(), frameId: 3, url: "https://ads.example.net/f", origin: "https://ads.example.net" };
    for (const claims of [
      { origin: "https://login.example.com" },
      { url: "https://login.example.com/2fa", origin: "https://login.example.com", host: "login.example.com" },
      { sender: { origin: "https://login.example.com" }, frameId: 0, documentId: "x" },
    ]) {
      expect(await c.on({ ...cand, ...claims }, frame), JSON.stringify(claims)).toBe("not-on");
      expect(c.badges).toEqual([]);
    }
    expect(c.asked).toEqual([]); // the frame's own host was refused before Chrome was asked about it
  });

  it("a site not on the list, or not granted, or a frame whose top page is not, gets nothing", async () => {
    expect(await channel({ sites: [] }).on(cand, good())).toBe("not-on");
    expect(await channel({ granted: [] }).on(cand, good())).toBe("not-on");
    const frame = { ...good(), url: "https://auth.example.net/f", origin: "https://auth.example.net" };
    expect(await channel({ sites: ["auth.example.net"], granted: ["auth.example.net"] }).on(cand, frame)).toBe(
      "not-on",
    );
    const both = channel({
      sites: ["auth.example.net", "login.example.com"],
      granted: ["auth.example.net", "login.example.com"],
    });
    expect(await both.on(cand, frame)).toBe("badge");
  });

  it("Autofill switched off: nothing, though the site is still listed and Chrome still grants it (AFSWITCH)", async () => {
    // Off keeps the list and gives back each listed site's own grant, but a broad "On all sites" grant chosen in Chrome
    // stays, and a page already open keeps its script until its next load: the switch itself must be asked
    const c = channel({ off: true });
    expect(await c.on(cand, good())).toBe("off");
    expect(c.badges).toEqual([]);
    expect(c.reads).toEqual(["off"]); // asked first after the rate limit: neither the gate, the list nor Chrome
    expect(c.asked).toEqual([]);
    // On again: the next message badges, without a new worker (the switch is read at every message)
    c.st.off = false;
    expect(await c.on(cand, good())).toBe("badge");
    expect(c.badges).toEqual([7]);
    expect(c.reads).toEqual(["off", "off", "gate", "sites"]);
  });

  it("a switch that cannot be read counts as Off", async () => {
    const c = channel({ off: "throws" });
    expect(await c.on(cand, good())).toBe("off");
    expect(c.badges).toEqual([]);
    expect(c.asked).toEqual([]);
  });

  it("the rate limit comes before the switch: a message over the limit reads nothing", async () => {
    const c = channel();
    for (let i = 0; i < CAND_PER_MINUTE; i++) await c.on(cand, good());
    const before = c.reads.length;
    expect(await c.on(cand, good())).toBe("limited");
    expect(c.reads.length).toBe(before);
  });

  it("the gate closed: nothing", async () => {
    const c = channel({ gate: false });
    expect(await c.on(cand, good())).toBe("gated");
    expect(c.badges).toEqual([]);
  });

  it(`at most ${CAND_PER_MINUTE} a minute per tab; another tab has its own; a minute later, again`, async () => {
    const c = channel();
    for (let i = 0; i < CAND_PER_MINUTE; i++) expect(await c.on(cand, good())).toBe("badge");
    expect(await c.on(cand, good())).toBe("limited");
    expect(c.asked.length).toBe(CAND_PER_MINUTE); // the 11th did not even ask Chrome
    const other = { ...good(), tab: { ...good().tab, id: 8 } };
    expect(await c.on(cand, other)).toBe("badge");
    c.tick(60_000);
    expect(await c.on(cand, good())).toBe("badge");
  });

  it("anything that is not the content script's message, or not from a content script, is no message at all", async () => {
    const c = channel();
    for (const m of [undefined, null, "sk-af-cand", ["sk-af-cand"], { type: "sk-clip-arm" }, {}])
      expect(await c.on(m, good())).toBe("ignored");
    const page = { id: SELF, url: `chrome-extension://${SELF}/popup/index.html`, origin: `chrome-extension://${SELF}` };
    expect(await c.on(cand, page)).toBe("ignored");
    expect(c.badges).toEqual([]);
  });

  it("the badge: '1' on that tab, and the tooltip naming the shortcut as set (or saying to open Sixkey)", async () => {
    const calls: unknown[] = [];
    const ch = (shortcut: string): BadgeChrome => ({
      action: {
        setBadgeText: async (o) => void calls.push(["text", o]),
        setBadgeBackgroundColor: async (o) => void calls.push(["color", o.tabId]),
        setTitle: async (o) => void calls.push(["title", o]),
      },
      commands: {
        getAll: async () => [
          { name: "fill", shortcut },
          { name: "lock", shortcut: "Alt+Shift+L" },
        ],
      },
      i18n: {
        getMessage: (k, s) =>
          k === "afCanFill" ? `can fill: ${s?.[0]}` : k === "afCanFillOpen" ? "can fill: open" : "",
      },
    });
    await showCanFill(7, ch("Alt+Shift+F"));
    expect(calls).toEqual([
      ["text", { tabId: 7, text: "1" }],
      ["color", 7],
      ["title", { tabId: 7, title: "can fill: Alt+Shift+F" }],
    ]);
    calls.length = 0;
    await showCanFill(7, ch(""));
    expect(calls.at(-1)).toEqual(["title", { tabId: 7, title: "can fill: open" }]);
  });
});

// ---- the registration -----------------------------------------------------------------------------------------------

function registrar() {
  const now = new Map<string, { id: string; matches: string[]; js: string[] } & Record<string, unknown>>();
  const log: string[] = [];
  const c: Registrar = {
    getRegisteredContentScripts: async (f) =>
      [...now.values()].filter((s) => f.ids.includes(s.id)).map((s) => structuredClone(s)),
    registerContentScripts: async (ss) => {
      for (const s of ss as { id: string }[]) {
        if (now.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
        now.set(s.id, structuredClone(s) as never);
        log.push("register");
      }
    },
    updateContentScripts: async (ss) => {
      for (const s of ss as { id: string }[]) {
        now.set(s.id, structuredClone(s) as never);
        log.push("update");
      }
    },
    unregisterContentScripts: async (f) => {
      for (const id of f.ids) now.delete(id);
      log.push("unregister");
    },
  };
  return { c, now, log };
}

describe("the registration: exactly the sites that count, behind the gate asked again", () => {
  it("the one object: the finder then the content script, each site's own pattern, every frame, at idle, kept", async () => {
    const r = registrar();
    await applyRegistration(["login.example.com", "auth.example.net"], r.c, async () => true);
    expect(r.now.get(SCRIPT_ID)).toEqual({
      id: SCRIPT_ID,
      js: [...SCRIPT_FILES],
      matches: ["https://login.example.com/*", "https://auth.example.net/*"],
      allFrames: true,
      runAt: "document_idle",
      persistAcrossSessions: true,
    });
    expect(SCRIPT_FILES).toEqual(["inject/otp.js", "inject/suggest.js"]);
    expect(Object.keys(r.now.get(SCRIPT_ID)!)).not.toContain("world");
  });

  it("idempotent: the same sites again change nothing; other sites update it; none (a revocation) removes it", async () => {
    const r = registrar();
    const gate = async () => true;
    await applyRegistration(["a.example.com"], r.c, gate);
    await applyRegistration(["a.example.com"], r.c, gate);
    expect(r.log).toEqual(["register"]);
    await applyRegistration(["a.example.com", "b.example.com"], r.c, gate);
    expect(r.now.get(SCRIPT_ID)!.matches).toEqual(["https://a.example.com/*", "https://b.example.com/*"]);
    await applyRegistration(["b.example.com"], r.c, gate); // a withdrawn in Chrome's settings
    expect(r.now.get(SCRIPT_ID)!.matches).toEqual(["https://b.example.com/*"]);
    await applyRegistration([], r.c, gate); // the last one too
    expect(r.now.has(SCRIPT_ID)).toBe(false);
    expect(r.log).toEqual(["register", "update", "update", "unregister"]);
    await applyRegistration([], r.c, gate);
    expect(r.log.at(-1)).toBe("unregister"); // nothing registered: nothing to remove, no second call
    expect(r.log.length).toBe(4);
  });

  it("the gate asked again before it registers: closed, nothing is registered, and what was is removed", async () => {
    const r = registrar();
    let asked = 0;
    await applyRegistration(["a.example.com"], r.c, async () => (asked++, false));
    expect(r.now.size).toBe(0);
    expect(asked).toBe(1);
    await applyRegistration(["a.example.com"], r.c, async () => true);
    await applyRegistration(["a.example.com"], r.c, async () => false);
    expect(r.now.size).toBe(0);
    // with no site, the gate is not even asked (nothing would be registered)
    asked = 0;
    await applyRegistration([], r.c, async () => (asked++, true));
    expect(asked).toBe(0);
  });

  it("applies run one after another (P3 verify NIT-1): a late apply finishes before the next reads; a hung one holds the next up only so long", async () => {
    const r = registrar();
    let release!: () => void;
    const slow: Registrar = {
      ...r.c,
      getRegisteredContentScripts: async (f) => {
        await new Promise<void>((done) => (release = done));
        return r.c.getRegisteredContentScripts(f);
      },
    };
    const first = applyRegistration(["a.example.com"], slow, async () => true);
    const second = applyRegistration(["b.example.com"], r.c, async () => true);
    await new Promise((done) => setTimeout(done, 20));
    expect(r.log).toEqual([]); // the second waits for the first
    release();
    await Promise.all([first, second]);
    expect(r.log).toEqual(["register", "update"]); // no second register of the same ID
    expect(r.now.get(SCRIPT_ID)!.matches).toEqual(["https://b.example.com/*"]);
    // a first apply the browser never answers: the next one goes ahead after its wait
    const hung: Registrar = { ...r.c, getRegisteredContentScripts: () => new Promise(() => undefined) };
    void applyRegistration(["c.example.com"], hung, async () => true, 30);
    await applyRegistration(["d.example.com"], r.c, async () => true, 30);
    expect(r.now.get(SCRIPT_ID)!.matches).toEqual(["https://d.example.com/*"]);
  });

  it("a host that may not be a site never gets a pattern", async () => {
    const r = registrar();
    await applyRegistration(
      ["localhost", "127.0.0.1", "co.uk", "api.sixkey.app", "ok.example.com"],
      r.c,
      async () => true,
    );
    expect(r.now.get(SCRIPT_ID)!.matches).toEqual(["https://ok.example.com/*"]);
  });
});
