// TOTP-AUTOFILL §4.2 item 1: every message the service worker and the offscreen document accept passes one sender test
// first. The extension's ID is not a test: a content script has it. What counts is the sender's URL (an extension page at
// an exact path), its origin, its tab, and that the page is one the message's row names.
//
// Three layers: the policy functions on their own (URL forms and field-by-field), the real service worker module over
// fake chrome.* (every message type from every kind of sender, with the effect of each allowed message observed, so a
// deny-everything bug fails too), and the real offscreen document module. The expected table below is written out by
// hand and is NOT read from the policy module: a change to a row must change this file as well.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_PAGES } from "../../src/platform/bridge-worker";
import {
  acceptedType,
  knownType,
  MESSAGE_SENDERS,
  SURFACE_PATHS,
  surfaceOf,
  type Surface,
} from "../../src/platform/sender-policy";
import { loadWorker, OTHER, SELF, unload, url, wait, type World } from "../helpers/sw-world";

/**
 * The policy module as a production build and as a dev or e2e build have it. The developer page exists in the module
 * only when the build's `__SYNC_DEV__` define is true (a production worker does not mention it at all), so each copy is
 * a fresh import with the define set. The static import above is the module with no define at all.
 */
type Policy = typeof import("../../src/platform/sender-policy");
async function policyBuiltWith(dev: boolean): Promise<Policy> {
  vi.resetModules();
  vi.stubGlobal("__SYNC_DEV__", dev);
  try {
    return await import("../../src/platform/sender-policy");
  } finally {
    vi.unstubAllGlobals();
  }
}
let prodP: Policy;
let devP: Policy;
beforeAll(async () => {
  prodP = await policyBuiltWith(false);
  devP = await policyBuiltWith(true);
});

const SURFACES = [
  "popup",
  "sidepanel",
  "options",
  "devsync",
  "offscreen",
  "worker",
] as const satisfies readonly Surface[];

/** Message type -> [receiver, the surfaces that may send it], in a PRODUCTION build (no developer page). */
const EXPECTED: Record<string, [string, readonly Surface[]]> = {
  // the side panel (docs/design/notes/SIDEPANEL-NOTES.md) draws the popup's screens: exactly the popup's three messages
  "sk-reschedule-autolock": ["worker", ["popup", "sidepanel", "options"]],
  "sk-sync-soon": ["worker", ["popup", "sidepanel", "options"]],
  "sk-sync-changed": ["worker", ["options"]],
  "sk-clip-arm": ["worker", ["popup", "sidepanel", "options"]],
  "sk-api": ["worker", ["options"]],
  "sk-offscreen-done": ["worker", ["offscreen"]],
  "sk-offscreen-arm": ["offscreen", ["worker"]],
  // the backup in Chrome's sync storage (CSB-3): the settings page alone, its card and first run (CSB-4)
  "sk-csb-on": ["worker", ["options"]],
  "sk-csb-off": ["worker", ["options"]],
  "sk-csb-now": ["worker", ["options"]],
  "sk-csb-opens": ["worker", ["options"]],
  "sk-csb-restored": ["worker", ["options"]],
  "sk-csb-merged": ["worker", ["options"]],
  "sk-csb-drop": ["worker", ["options"]],
};
/** The Google Drive backup's messages, which went with its code: no row any more, so taken from no one. */
const GONE = [
  "sk-cloud-connected",
  "sk-cloud-now",
  "sk-cloud-off",
  "sk-cloud-switch",
  "sk-cloud-merged",
  "sk-cloud-purged",
  "sk-cloud-opens",
  "sk-cloud-disconnect",
  "sk-cloud-list",
  "sk-cloud-restored",
  "sk-cloud-own",
  "sk-cloud-removed",
  "sk-devcloud",
];
/** The same in a dev or e2e build: the developer sync page is a sender of exactly these. */
const DEV_EXTRA: Record<string, Surface[]> = {
  "sk-sync-soon": ["devsync"],
  "sk-sync-changed": ["devsync"],
  "sk-api": ["devsync"],
};

const PATH: Record<Surface, string> = {
  popup: "/popup/index.html",
  sidepanel: "/sidepanel/index.html",
  options: "/options/index.html",
  devsync: "/devsync/index.html",
  offscreen: "/offscreen/index.html",
  worker: "/sw.js",
};
const web = "https://evil.example/login";

/** Senders that carry this extension's ID or look like it, and must be refused for EVERY message type. */
const HOSTILE: [string, unknown][] = [
  [
    "content script on a web page",
    { id: SELF, url: web, origin: "https://evil.example", tab: { id: 1, url: web }, frameId: 0, documentId: "D" },
  ],
  [
    "content script in a web iframe",
    { id: SELF, url: web, origin: "https://evil.example", tab: { id: 1, url: web }, frameId: 7 },
  ],
  ["web URL that spells our page's path", { id: SELF, url: "https://evil.example/popup/index.html" }],
  ["web URL with our ID as the host", { id: SELF, url: `https://${SELF}/popup/index.html` }],
  ["our page URL, tab on a web page", { id: SELF, url: url("/popup/index.html"), tab: { id: 1, url: web } }],
  [
    "our side panel's URL, tab on a web page",
    { id: SELF, url: url("/sidepanel/index.html"), tab: { id: 1, url: web } },
  ],
  ["our side panel's URL, web origin", { id: SELF, url: url("/sidepanel/index.html"), origin: "https://evil.example" }],
  ["web URL that spells the side panel's path", { id: SELF, url: "https://evil.example/sidepanel/index.html" }],
  ["the side panel's path with a suffix", { id: SELF, url: url("/sidepanel/index.html.evil") }],
  ["the side panel's directory", { id: SELF, url: url("/sidepanel/") }],
  ["the side panel's path in the wrong case", { id: SELF, url: url("/SidePanel/index.html") }],
  ["our page URL, tab with no readable URL", { id: SELF, url: url("/options/index.html"), tab: { id: 1 } }],
  [
    "our page URL, tab on another extension",
    { id: SELF, url: url("/options/index.html"), tab: { url: url("/x.html", OTHER) } },
  ],
  ["our page URL, web origin", { id: SELF, url: url("/popup/index.html"), origin: "https://evil.example" }],
  [
    "our page URL, another extension's origin",
    { id: SELF, url: url("/popup/index.html"), origin: `chrome-extension://${OTHER}` },
  ],
  ["another extension's ID, its own page", { id: OTHER, url: url("/popup/index.html", OTHER) }],
  ["another extension's ID, our page URL", { id: OTHER, url: url("/popup/index.html") }],
  ["our ID, another extension's page URL", { id: SELF, url: url("/popup/index.html", OTHER) }],
  ["no ID", { url: url("/popup/index.html") }],
  ["no URL", { id: SELF }],
  ["our page URL, an empty origin", { id: SELF, url: url("/popup/index.html"), origin: "" }],
  [
    "our page URL, an origin that only starts like ours",
    { id: SELF, url: url("/popup/index.html"), origin: `chrome-extension://${SELF}x` },
  ],
  ["our page URL, a tab whose URL is empty", { id: SELF, url: url("/options/index.html"), tab: { id: 1, url: "" } }],
  ["an empty URL", { id: SELF, url: "" }],
  ["no sender at all", undefined],
  ["not a URL", { id: SELF, url: "popup/index.html" }],
  ["about:blank", { id: SELF, url: "about:blank" }],
  ["a data: URL", { id: SELF, url: "data:text/html,x" }],
  ["a blob of ours", { id: SELF, url: `blob:chrome-extension://${SELF}/0b1c` }],
  ["a filesystem URL of ours", { id: SELF, url: `filesystem:chrome-extension://${SELF}/temporary/popup/index.html` }],
  ["chrome://", { id: SELF, url: `chrome://extensions/?id=${SELF}` }],
  ["chrome-untrusted://", { id: SELF, url: `chrome-untrusted://${SELF}/popup/index.html` }],
  ["host with a suffix", { id: SELF, url: url("/popup/index.html", `${SELF}.evil`) }],
  ["host in upper case", { id: SELF, url: url("/popup/index.html", SELF.toUpperCase()) }],
  ["host with a port", { id: SELF, url: `chrome-extension://${SELF}:443/popup/index.html` }],
  ["host with userinfo", { id: SELF, url: `chrome-extension://${OTHER}@${SELF}/popup/index.html` }],
  ["path with a suffix (a startsWith test would pass it)", { id: SELF, url: url("/popup/index.html.evil") }],
  ["path with a trailing slash", { id: SELF, url: url("/popup/index.html/") }],
  ["path one level deeper", { id: SELF, url: url("/popup/index.html/x") }],
  ["path in the wrong case", { id: SELF, url: url("/Popup/index.html") }],
  ["path with an encoded slash", { id: SELF, url: url("/popup%2Findex.html") }],
  ["a page of ours that is no sender", { id: SELF, url: url("/unknown/index.html") }],
  ["the extension's root", { id: SELF, url: url("/") }],
];

describe("surfaceOf: who sent it, by URL, origin and tab", () => {
  it("each surface is recognised by its exact path, with any query or fragment, an upper-case scheme, and a tab of ours", () => {
    for (const s of SURFACES) {
      const p = PATH[s];
      const forms: Record<string, unknown>[] = [
        { id: SELF, url: url(p) },
        { id: SELF, url: `${url(p)}?x=1#y` },
        { id: SELF, url: url(p).replace("chrome-extension", "CHROME-EXTENSION") },
        { id: SELF, url: url(p), origin: `chrome-extension://${SELF}` },
        { id: SELF, url: url(p), tab: { id: 3, url: url("/options/index.html") } }, // a page of ours open in a tab
      ];
      for (const sender of forms) expect(devP.surfaceOf(sender, SELF), `${s} ${JSON.stringify(sender)}`).toBe(s);
    }
    expect(devP.SURFACE_PATHS).toEqual(PATH);
    const { devsync: _dev, ...production } = PATH;
    expect(prodP.SURFACE_PATHS).toEqual(production);
    expect(SURFACE_PATHS).toEqual(production);
  });

  it("the Google Drive backup's developer page is no surface in any build, and its messages and that path's have no row", async () => {
    const page = { id: SELF, url: url("/devcloud/index.html"), origin: `chrome-extension://${SELF}` };
    for (const p of [prodP, devP]) {
      expect(p.surfaceOf(page, SELF)).toBeNull();
      expect(Object.values(p.SURFACE_PATHS)).not.toContain("/devcloud/index.html");
      for (const type of GONE) {
        expect(p.knownType({ type }), type).toBeNull();
        for (const s of SURFACES)
          for (const receiver of ["worker", "offscreen"] as const)
            expect(
              p.acceptedType({ type }, { id: SELF, url: url(PATH[s]) }, SELF, receiver),
              `${type} ${s}`,
            ).toBeNull();
      }
    }
  });

  it("the developer page is a surface only when the build has it", () => {
    expect(prodP.surfaceOf({ id: SELF, url: url(PATH.devsync) }, SELF)).toBeNull();
    expect(devP.surfaceOf({ id: SELF, url: url(PATH.devsync) }, SELF)).toBe("devsync");
    expect(surfaceOf({ id: SELF, url: url(PATH.devsync) }, SELF)).toBeNull(); // unit tests are not a dev build
  });

  it("every hostile sender is no surface at all, in a dev build as well", () => {
    for (const [what, sender] of HOSTILE) {
      expect(devP.surfaceOf(sender as never, SELF), what).toBeNull();
      expect(prodP.surfaceOf(sender as never, SELF), what).toBeNull();
    }
  });

  it("an empty own ID never matches (a stubbed or broken runtime)", () => {
    expect(surfaceOf({ id: "", url: "chrome-extension:///popup/index.html" }, "")).toBeNull();
  });

  it("each field is checked on its own: one wrong field refuses an otherwise good sender", () => {
    const good = {
      id: SELF,
      url: url(PATH.popup),
      origin: `chrome-extension://${SELF}`,
      tab: { url: url(PATH.options) },
    };
    expect(surfaceOf(good, SELF)).toBe("popup");
    expect(surfaceOf({ ...good, id: OTHER }, SELF)).toBeNull();
    expect(surfaceOf({ ...good, url: web }, SELF)).toBeNull();
    expect(surfaceOf({ ...good, origin: "https://evil.example" }, SELF)).toBeNull();
    expect(surfaceOf({ ...good, tab: { url: web } }, SELF)).toBeNull();
    expect(surfaceOf({ ...good, tab: {} }, SELF)).toBeNull();
  });
});

describe("the table", () => {
  it("has exactly the message types of the hand-written table, receiver and senders alike (production senders; the developer page is added in dev builds only, below)", () => {
    expect(Object.keys(MESSAGE_SENDERS).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [type, [to, from]] of Object.entries(EXPECTED)) {
      const row = MESSAGE_SENDERS[type as keyof typeof MESSAGE_SENDERS];
      expect(row.to, type).toBe(to);
      expect([...(row.from as readonly Surface[])].sort(), type).toEqual([...from].sort()); // no developer page in the rows
    }
  });

  it("acceptedType says yes to exactly the allowed (type, surface) pairs, no for the rest, in prod and in dev builds", () => {
    for (const dev of [false, true])
      for (const [type, [to, from]] of Object.entries(EXPECTED))
        for (const s of SURFACES) {
          const sender = { id: SELF, url: url(PATH[s]) };
          const allowed = from.includes(s) || (dev && (DEV_EXTRA[type] ?? []).includes(s));
          for (const receiver of ["worker", "offscreen"] as const) {
            const got = (dev ? devP : prodP).acceptedType({ type }, sender, SELF, receiver);
            expect(got, `${type} from ${s} to ${receiver} dev=${dev}`).toBe(allowed && receiver === to ? type : null);
          }
        }
  });

  it("the api bridge's page list is the same pages (bridge-worker.ts keeps its own check as a second line)", () => {
    const prod = SURFACES.filter((s) =>
      prodP.acceptedType({ type: "sk-api" }, { id: SELF, url: url(PATH[s]) }, SELF, "worker"),
    );
    expect(prod.map((s) => PATH[s])).toEqual([...BRIDGE_PAGES]); // BRIDGE_PAGES is the production list in unit tests
    const dev = SURFACES.filter((s) =>
      devP.acceptedType({ type: "sk-api" }, { id: SELF, url: url(PATH[s]) }, SELF, "worker"),
    );
    expect(dev.map((s) => PATH[s]).sort()).toEqual(["/devsync/index.html", "/options/index.html"]);
  });

  it("a type counts only if it is an own, string `type` of an object: no prototype names, no arrays, no look-alike case", () => {
    const ok = { id: SELF, url: url(PATH.popup) };
    for (const type of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "valueOf",
      "SK-CLIP-ARM",
      "sk-clip-arm ",
      "",
    ])
      expect(knownType({ type }), type).toBeNull();
    for (const msg of [
      null,
      undefined,
      "sk-clip-arm",
      7,
      ["sk-clip-arm"],
      {},
      { type: 1 },
      { type: ["sk-clip-arm"] },
      { type: { toString: () => "sk-clip-arm" } },
    ])
      expect(acceptedType(msg, ok, SELF, "worker"), JSON.stringify(msg)).toBeNull();
    expect(knownType(Object.create({ type: "sk-clip-arm" }))).toBeNull(); // inherited `type` is not the message's
    expect(knownType({ type: "sk-clip-arm" })).toBe("sk-clip-arm");
  });
});

// The real worker. Each type has a message that works if it is let through, and one effect that shows it was.
const PAYLOAD = { hash: "abc", delayMs: 1000, req: { method: "GET", target: "/healthz", headers: {} } };
const message = (type: string) => ({ type, ...PAYLOAD });
const effect = (w: World, type: string): number => {
  switch (type) {
    case "sk-reschedule-autolock":
    case "sk-sync-soon":
    case "sk-sync-changed":
      return w.syncReads(); // the engine looked at its state once, sync being off
    case "sk-clip-arm":
      return w.sent.filter((m) => (m as { type?: string }).type === "sk-offscreen-arm").length;
    case "sk-offscreen-done":
      return w.fx.closed;
    case "sk-api":
      return w.fx.fetched.length;
    case "sk-csb-on":
    case "sk-csb-off":
    case "sk-csb-now":
    case "sk-csb-opens":
    case "sk-csb-restored":
    case "sk-csb-merged":
    case "sk-csb-drop":
      return w.answers.filter((a) => a.type === type).length; // answered after its work, once
    case "sk-offscreen-arm":
      // not a message the worker answers at all: nothing it does would show; the other counters must stay still
      return w.syncReads() + w.fx.closed + w.fx.created + w.fx.fetched.length + w.sent.length + w.answers.length;
    default:
      throw new Error(`no effect known for ${type}`);
  }
};
const WORKER_TYPES = Object.entries(EXPECTED)
  .filter(([, [to]]) => to === "worker")
  .map(([t]) => t);

describe("the service worker (src/background/sw.ts)", () => {
  let w: World;
  beforeEach(async () => {
    w = await loadWorker();
  });
  afterEach(unload);

  it("every worker message type does its work for each allowed sender, once", async () => {
    for (const type of WORKER_TYPES)
      for (const s of EXPECTED[type]![1]) {
        const senders = [
          { id: SELF, url: url(PATH[s]) },
          { id: SELF, url: url(PATH[s]), origin: `chrome-extension://${SELF}`, tab: { id: 2, url: url(PATH[s]) } }, // in a tab
        ];
        for (const sender of senders) {
          const before = effect(w, type);
          w.send(message(type), sender);
          await wait();
          expect(effect(w, type) - before, `${type} from ${s} ${JSON.stringify(sender)}`).toBe(1);
        }
      }
  });

  it("every worker message type is ignored from every hostile sender: no effect, no answer, nothing kept open", async () => {
    for (const type of WORKER_TYPES) {
      const before = effect(w, type);
      for (const [what, sender] of HOSTILE) {
        const kept = w.send(message(type), sender).filter((r) => r !== undefined);
        expect(kept, `${type} / ${what}`).toEqual([]);
      }
      await wait();
      expect(effect(w, type) - before, type).toBe(0);
    }
  });

  it("every worker message type is ignored from every extension page that its row does not name (production build)", async () => {
    for (const type of WORKER_TYPES)
      for (const s of SURFACES.filter((x) => !EXPECTED[type]![1].includes(x))) {
        const before = effect(w, type);
        const kept = w.send(message(type), { id: SELF, url: url(PATH[s]) }).filter((r) => r !== undefined);
        await wait();
        expect(kept, `${type} from ${s}`).toEqual([]);
        expect(effect(w, type) - before, `${type} from ${s}`).toBe(0);
      }
  });

  it("the offscreen document's own message type is not the worker's: ignored from every sender, the worker included", async () => {
    const before = effect(w, "sk-offscreen-arm");
    for (const s of SURFACES) w.send(message("sk-offscreen-arm"), { id: SELF, url: url(PATH[s]) });
    for (const [, sender] of HOSTILE) w.send(message("sk-offscreen-arm"), sender);
    await wait();
    expect(effect(w, "sk-offscreen-arm")).toBe(before);
  });

  it("types with no row, and look-alikes, are ignored from the most trusted sender there is", async () => {
    const before = effect(w, "sk-offscreen-arm");
    for (const type of [
      "sk-unknown",
      "constructor",
      "__proto__",
      "sk-lock",
      "SK-API",
      "sk-clip-arm\u0000",
      undefined,
      1,
      null,
    ])
      w.send({ type, ...PAYLOAD }, { id: SELF, url: url(PATH.options) });
    w.send(null, { id: SELF, url: url(PATH.options) });
    w.send("sk-api", { id: SELF, url: url(PATH.options) });
    await wait();
    expect(effect(w, "sk-offscreen-arm")).toBe(before);
  });

  it("the backup in Chrome sync's messages keep a channel open for the settings page alone, and are answered after the work", async () => {
    for (const type of WORKER_TYPES.filter((t) => t.startsWith("sk-csb-"))) {
      const replies: unknown[] = [];
      expect(
        w.send(message(type), { id: SELF, url: url(PATH.options) }, (r) => replies.push(r)),
        type,
      ).toEqual([undefined, undefined, true, undefined]);
      expect(w.send(message(type), { id: SELF, url: url(PATH.popup) }), type).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      await wait();
      expect(replies, type).toHaveLength(1);
    }
    // the backup was never set up, and these carry nothing a handler takes but sk-csb-on (and sk-csb-off): the one
    // that turned it on did, the next turned it off again; nothing fetched, nothing written to storage.sync
    expect(w.fx.fetched).toEqual([]);
    expect(w.sync.callsOf("set")).toEqual([]);
  });

  it("the Google Drive backup's messages, which have no row, are taken from no sender: no channel kept open, no answer, nothing done", async () => {
    for (const type of GONE)
      for (const s of SURFACES) {
        expect(w.send(message(type), { id: SELF, url: url(PATH[s]) }), `${type} from ${s}`).toEqual([
          undefined,
          undefined,
          undefined,
          undefined,
        ]);
      }
    await wait();
    expect(w.answers.filter((a) => String(a.type).startsWith("sk-cloud-"))).toEqual([]);
    expect(w.fx.fetched).toEqual([]);
    expect([...w.alarms.keys()].filter((n) => n.startsWith("sk-cloud-"))).toEqual([]);
    expect(w.local.data.has("sk_cloud_cfg")).toBe(false);
  });

  it("only the bridge keeps a channel open among the other messages, and only for the settings page; the answer is the API's", async () => {
    const reply = (sender: unknown) =>
      new Promise<unknown>((resolve) => {
        const kept = w.send(message("sk-api"), sender, resolve).filter((r) => r === true).length;
        if (kept === 0) resolve("not kept");
      });
    expect(await reply({ id: SELF, url: url(PATH.options) })).toMatchObject({ ok: true, res: { status: 200 } });
    expect(await reply({ id: SELF, url: url(PATH.popup) })).toBe("not kept");
    expect(await reply({ id: SELF, url: web, tab: { url: web } })).toBe("not kept");
    expect(w.fx.fetched).toEqual(["https://api.sixkey.app/healthz"]);
  });

  it("the clip-arm request reaches the offscreen document with the hash and the delay, from the popup, the side panel and the settings page only", async () => {
    w.send({ type: "sk-clip-arm", hash: "h1", delayMs: 5000 }, { id: SELF, url: url(PATH.popup) });
    await wait();
    expect(w.sent).toEqual([{ type: "sk-offscreen-arm", hash: "h1", delayMs: 5000 }]);
    expect(w.fx.created).toBe(1);
    w.send({ type: "sk-clip-arm", hash: 5 }, { id: SELF, url: url(PATH.popup) }); // a hash that is no string: nothing
    await wait();
    expect(w.sent).toHaveLength(1);
  });

  it("sk-clip-arm is answered {ok: true} when taken, {ok: false} for a hash that is no string, and not at all to a refused sender", async () => {
    const answers = (msg: unknown, sender: unknown) => {
      const got: unknown[] = [];
      w.send(msg, sender, (r) => got.push(r));
      return got;
    };
    const ok = { id: SELF, url: url(PATH.popup) };
    expect(answers({ type: "sk-clip-arm", hash: "h" }, ok)).toEqual([{ ok: true }]);
    expect(answers({ type: "sk-clip-arm", hash: 5 }, ok)).toEqual([{ ok: false }]);
    for (const [what, sender] of HOSTILE) expect(answers({ type: "sk-clip-arm", hash: "h" }, sender), what).toEqual([]);
    expect(answers({ type: "sk-clip-arm", hash: "h" }, { id: SELF, url: url(PATH.offscreen) })).toEqual([]);
  });

  it("armClipboardClear (what the popup and the settings page call) is true only if the worker took the request", async () => {
    const { armClipboardClear } = await import("../../src/platform/clipboard");
    const via = (sender: unknown) =>
      vi.stubGlobal("chrome", {
        ...w.chrome,
        runtime: {
          ...w.chrome.runtime,
          sendMessage: (m: { type: string }) =>
            m.type === "sk-clip-arm"
              ? new Promise((resolve) => {
                  w.send(m, sender, resolve);
                  setTimeout(() => resolve(undefined), 30); // a refused sender is never answered
                })
              : w.chrome.runtime.sendMessage(m),
        },
      });
    via({ id: SELF, url: url(PATH.options) });
    expect(await armClipboardClear("123456")).toBe(true);
    await wait();
    expect(w.sent.filter((m) => (m as { type?: string }).type === "sk-offscreen-arm")).toHaveLength(1);
    for (const [what, sender] of HOSTILE.slice(0, 4).concat([
      ["offscreen page", { id: SELF, url: url(PATH.offscreen) }],
    ])) {
      via(sender);
      expect(await armClipboardClear("123456"), what).toBe(false);
    }
    await wait();
    expect(w.sent.filter((m) => (m as { type?: string }).type === "sk-offscreen-arm")).toHaveLength(1); // nothing more armed
  });

  it("the gate is ahead of the work in every listener: with a hostile sender neither listener reads storage at all", async () => {
    const reads = w.local.reads.length + w.session.reads.length;
    for (const type of WORKER_TYPES) for (const [, sender] of HOSTILE) w.send(message(type), sender);
    await wait();
    expect(w.local.reads.length + w.session.reads.length).toBe(reads);
  });
});

describe("the service worker in a dev or e2e build (the developer sync page exists)", () => {
  afterEach(unload);
  it("the developer page sends exactly the sync messages, and is refused for the rest; the other pages are unchanged", async () => {
    const w = await loadWorker({ dev: true });
    for (const type of WORKER_TYPES) {
      const allowed = (DEV_EXTRA[type] ?? []).includes("devsync");
      const before = effect(w, type);
      w.send(message(type), { id: SELF, url: url(PATH.devsync) });
      await wait();
      expect(effect(w, type) - before, type).toBe(allowed ? 1 : 0);
    }
    const before = w.syncReads();
    w.send({ type: "sk-sync-soon" }, { id: SELF, url: url(PATH.options) });
    w.send({ type: "sk-sync-soon" }, { id: SELF, url: web, tab: { url: web } });
    await wait();
    expect(w.syncReads() - before).toBe(1);
  });

  it("a production build (the define is false) and a bare module (no define) refuse the developer page for every type", async () => {
    for (const dev of [false, undefined]) {
      const w = await loadWorker(dev === undefined ? {} : { dev });
      for (const type of WORKER_TYPES) {
        const before = effect(w, type);
        w.send(message(type), { id: SELF, url: url(PATH.devsync) });
        await wait();
        expect(effect(w, type) - before, `${type} dev=${dev}`).toBe(0);
      }
      unload();
    }
  });
});

describe("the offscreen document (src/offscreen/main.ts)", () => {
  type L = (...a: unknown[]) => unknown;
  let listeners: L[];
  let calls: string[];
  let sent: unknown[];
  const hex = async (s: string) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    listeners = [];
    calls = [];
    sent = [];
    const buf = { value: "", focus() {}, select() {} };
    vi.stubGlobal("document", {
      getElementById: () => buf,
      execCommand: (c: string) => {
        calls.push(c);
        if (c === "paste") buf.value = "the code";
      },
    });
    vi.stubGlobal("chrome", {
      runtime: {
        id: SELF,
        onMessage: { addListener: (l: L) => listeners.push(l) },
        sendMessage: async (m: unknown) => void sent.push(m),
      },
    });
    await import("../../src/offscreen/main");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // The hash is computed with WebCrypto, which settles outside the fake clock: after the timers run, wait in real time.
  const realSetTimeout = globalThis.setTimeout;
  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    await new Promise((r) => realSetTimeout(r, 40));
  };
  const arm = async (sender: unknown, msg: unknown) => {
    for (const l of listeners) l(msg, sender, () => undefined);
    await advance(121_000);
  };

  it("registers one listener", () => {
    expect(listeners).toHaveLength(1);
  });

  it("the service worker arms it: the clipboard is read, cleared if it still holds the code, and the worker told", async () => {
    await arm(
      { id: SELF, url: url(PATH.worker) },
      { type: "sk-offscreen-arm", hash: await hex("the code"), delayMs: 1000 },
    );
    expect(calls).toEqual(["paste", "copy"]);
    expect(sent).toEqual([{ type: "sk-offscreen-done" }]);
  });

  it("a different hash only reads: nothing is cleared (the existing rule)", async () => {
    await arm(
      { id: SELF, url: url(PATH.worker) },
      { type: "sk-offscreen-arm", hash: await hex("other"), delayMs: 1000 },
    );
    expect(calls).toEqual(["paste"]);
  });

  it("every other sender is ignored, for the arm message and every other message type: nothing is read, cleared or sent", async () => {
    const msg = { type: "sk-offscreen-arm", hash: await hex("the code"), delayMs: 1000 };
    const others: [string, unknown][] = [
      ...HOSTILE,
      ...SURFACES.filter((s) => s !== "worker").map((s): [string, unknown] => [
        `the ${s} page`,
        { id: SELF, url: url(PATH[s]) },
      ]),
    ];
    for (const [what, sender] of others) {
      await arm(sender, msg);
      expect(calls, what).toEqual([]);
      expect(sent, what).toEqual([]);
    }
    for (const type of Object.keys(EXPECTED).filter((t) => t !== "sk-offscreen-arm"))
      await arm({ id: SELF, url: url(PATH.worker) }, { ...msg, type }); // the right sender, a type that is not this document's
    expect(calls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("a malformed arm message from the worker does nothing, and a delay that is no number falls back to 30 s", async () => {
    const worker = { id: SELF, url: url(PATH.worker) };
    await arm(worker, { type: "sk-offscreen-arm" });
    await arm(worker, { type: "sk-offscreen-arm", hash: 5 });
    expect(calls).toEqual([]);
    const h = await hex("the code");
    for (const l of listeners) l({ type: "sk-offscreen-arm", hash: h, delayMs: "0" }, worker, () => undefined);
    await advance(20_000);
    expect(calls).toEqual([]); // "0" did not mean "now"
    await advance(11_000);
    expect(calls).toEqual(["paste", "copy"]);
  });
});
