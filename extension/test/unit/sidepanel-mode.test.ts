// What the toolbar icon opens, the popup or the side panel (src/platform/action-mode.ts, src/background/action-first.ts;
// docs/design/notes/SIDEPANEL-NOTES.md): the choice and the profile turned into a plan, the plan put into the browser in
// a safe order, the worker's start, its change listener and its click handler (the panel opened in the click itself, the
// popup as the fallback), over fake chrome.* objects, and then the real service worker module (test/helpers/sw-world.ts).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAction,
  CLICK_KEY,
  OPENER_KEY,
  openerOf,
  PANEL_PATH,
  panelSupported,
  planAction,
  POPUP_PATH,
  serveAction,
} from "../../src/platform/action-mode";
import { loadWorker, unload, wait } from "../helpers/sw-world";

const SOLO = { autoLock: { mode: "idle", minutes: 15 }, lockOnScreenLock: true, profile: "solo" };
const SHARED = {
  autoLock: { mode: "always" },
  lockOnScreenLock: true,
  display: { density: "standard", hideCodes: true, sort: "manual" },
  profile: "shared",
};
/** Saved before the profile marker existed, exactly the shared preset's settings: read as shared (types.ts profileOf). */
const SHARED_LEGACY = { autoLock: { mode: "always" }, lockOnScreenLock: true, display: { hideCodes: true } };

type Tab = { windowId: number; id?: number };
type Call = [string, ...unknown[]];

/** chrome.* for serveAction: every call logged in order; `get` can hang until released, `open` can fail. */
function fake(
  o: {
    stored?: Record<string, unknown>;
    panel?: boolean;
    open?: "ok" | "reject" | "throw";
    get?: "ok" | "hang" | "reject";
    noAction?: boolean;
    /** The clicked window's type (chrome.windows.get): "normal" unless said. */
    windowType?: string;
  } = {},
) {
  const calls: Call[] = [];
  const data = new Map(Object.entries(o.stored ?? {}));
  let clicked: ((t: Tab) => void) | undefined;
  let changed: ((c: Record<string, unknown>) => void) | undefined;
  const held: (() => void)[] = [];
  const c = {
    ...(o.noAction
      ? {}
      : {
          action: {
            setPopup: async (d: { popup: string; tabId?: number }) =>
              void calls.push(
                d.tabId === undefined ? ["setPopup", d.popup] : ["setPopup", d.popup, { tabId: d.tabId }],
              ),
            openPopup: async (o?: { windowId?: number }) => void calls.push(["openPopup", o?.windowId]),
            onClicked: {
              addListener: (l: (t: Tab) => void) => {
                calls.push(["listen", "click"]);
                clicked = l;
              },
            },
          },
        }),
    ...(o.panel === false
      ? {}
      : {
          sidePanel: {
            setOptions: async (d: unknown) => void calls.push(["setOptions", d]),
            open: (d: unknown) => {
              calls.push(["open", d]);
              if (o.open === "throw") throw new Error("open() may only be called in response to a user gesture");
              return o.open === "reject" ? Promise.reject(new Error("no panel")) : Promise.resolve();
            },
          },
        }),
    windows: { get: async () => ({ type: o.windowType ?? "normal" }) },
    storage: {
      local: {
        get: (keys: string[]) => {
          calls.push(["get", keys]);
          const v = Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, data.get(k)]));
          if (o.get === "reject") return Promise.reject(new Error("storage"));
          if (o.get === "hang") return new Promise<Record<string, unknown>>((r) => held.push(() => r(v)));
          return Promise.resolve(v);
        },
        onChanged: {
          addListener: (l: (c: Record<string, unknown>) => void) => {
            calls.push(["listen", "change"]);
            changed = l;
          },
        },
      },
      session: { set: async (i: Record<string, unknown>) => void calls.push(["session.set", Object.keys(i)]) },
    },
  };
  return {
    c,
    calls,
    data,
    click: (t: Tab) => clicked!(t),
    change: (...keys: string[]) => changed!(Object.fromEntries(keys.map((k) => [k, { newValue: data.get(k) }]))),
    release: () => held.splice(0).forEach((f) => f()),
    /** The calls of one kind, in order. */
    of: (kind: string) => calls.filter((x) => x[0] === kind).map((x) => x.slice(1)),
  };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

describe("the plan: the choice and the profile", () => {
  it("the popup by default; the panel only when chosen exactly, in a single-person profile, where the API exists", () => {
    expect(planAction({}, true)).toEqual({ offered: true, opens: "popup" });
    expect(planAction({ sk_settings: SOLO }, true)).toEqual({ offered: true, opens: "popup" });
    expect(planAction({ [OPENER_KEY]: "panel" }, true)).toEqual({ offered: true, opens: "panel" });
    expect(planAction({ [OPENER_KEY]: "panel", sk_settings: SOLO }, true)).toEqual({ offered: true, opens: "panel" });
    expect(planAction({ [OPENER_KEY]: "popup", sk_settings: SOLO }, true)).toEqual({ offered: true, opens: "popup" });
    for (const raw of ["Panel", "sidepanel", true, 1, {}, ["panel"], null, ""])
      expect(planAction({ [OPENER_KEY]: raw }, true), JSON.stringify(raw)).toEqual({ offered: true, opens: "popup" });
    expect(openerOf("panel")).toBe("panel");
    expect(openerOf(undefined)).toBe("popup");
  });

  it("a shared profile is never offered the panel, whatever is stored, the legacy record without a marker included", () => {
    for (const sk_settings of [SHARED, SHARED_LEGACY])
      expect(planAction({ [OPENER_KEY]: "panel", sk_settings }, true)).toEqual({ offered: false, opens: "popup" });
    // a single-person profile with the shared preset's lock settings is custom, not shared (QUICK-PIN-NOTES §3)
    expect(planAction({ [OPENER_KEY]: "panel", sk_settings: { ...SHARED, profile: "solo" } }, true).opens).toBe(
      "panel",
    );
  });

  it("no side panel API (another browser, a profile where it is missing): never offered, the popup", () => {
    expect(planAction({ [OPENER_KEY]: "panel", sk_settings: SOLO }, false)).toEqual({ offered: false, opens: "popup" });
    expect(panelSupported(undefined)).toBe(false);
    expect(panelSupported({})).toBe(false);
    expect(panelSupported({ sidePanel: { setOptions: async () => undefined } })).toBe(false); // Chrome 114/115: no open()
    expect(panelSupported({ sidePanel: { open: async () => undefined, setOptions: async () => undefined } })).toBe(
      true,
    );
  });
});

describe("applying a plan", () => {
  it("the popup first, then the panel's page, enabled only where it is offered", async () => {
    const f = fake();
    await applyAction({ offered: true, opens: "panel" }, f.c);
    await applyAction({ offered: true, opens: "popup" }, f.c);
    await applyAction({ offered: false, opens: "popup" }, f.c);
    expect(f.calls).toEqual([
      ["setPopup", ""],
      ["setOptions", { path: PANEL_PATH, enabled: true }],
      ["setPopup", POPUP_PATH],
      ["setOptions", { path: PANEL_PATH, enabled: true }],
      ["setPopup", POPUP_PATH],
      ["setOptions", { enabled: false }],
    ]);
  });

  it("without the side panel API only the popup is set; without chrome.action nothing throws", async () => {
    const f = fake({ panel: false });
    await applyAction({ offered: false, opens: "popup" }, f.c);
    expect(f.calls).toEqual([["setPopup", POPUP_PATH]]);
    await applyAction({ offered: true, opens: "panel" }, undefined);
    await applyAction({ offered: true, opens: "panel" }, {});
  });

  it("the paths are the manifest's popup and the side panel's page", () => {
    const m = JSON.parse(readFileSync(resolve(__dirname, "../../manifest.base.json"), "utf8"));
    expect(m.action.default_popup).toBe(POPUP_PATH);
    expect(PANEL_PATH).toBe("sidepanel/index.html");
    expect(statSync(resolve(__dirname, "../../src", PANEL_PATH)).isFile()).toBe(true);
    expect(m.side_panel).toBeUndefined(); // the worker enables the page, for a single-person profile only
    expect(m.permissions).toContain("sidePanel");
    expect(m.optional_permissions).not.toContain("sidePanel");
  });
});

describe("the worker's half (serveAction)", () => {
  it("at start: both listeners, then the read, all before anything is awaited; then the plan applied", async () => {
    const f = fake({ stored: { [OPENER_KEY]: "panel", sk_settings: SOLO } });
    const w = serveAction(f.c);
    expect(f.calls).toEqual([
      ["listen", "click"],
      ["listen", "change"],
      ["get", [OPENER_KEY, "sk_settings"]],
    ]);
    expect(w.plan).toBeUndefined();
    await settle();
    expect(w.plan).toEqual({ offered: true, opens: "panel" });
    expect(f.calls.slice(3)).toEqual([
      ["setPopup", ""],
      ["setOptions", { path: PANEL_PATH, enabled: true }],
    ]);
  });

  it("at start with nothing stored: the popup, and the panel's page enabled (the popup's own button opens it)", async () => {
    const f = fake();
    serveAction(f.c);
    await settle();
    expect(f.of("setPopup")).toEqual([[POPUP_PATH]]);
    expect(f.of("setOptions")).toEqual([[{ path: PANEL_PATH, enabled: true }]]);
  });

  it("at start in a shared profile: the popup, and the panel's page disabled", async () => {
    const f = fake({ stored: { [OPENER_KEY]: "panel", sk_settings: SHARED } });
    serveAction(f.c);
    await settle();
    expect(f.of("setPopup")).toEqual([[POPUP_PATH]]);
    expect(f.of("setOptions")).toEqual([[{ enabled: false }]]);
  });

  it("a change of the choice or of the settings applies at once; any other key reads nothing", async () => {
    const f = fake();
    serveAction(f.c);
    await settle();
    f.data.set(OPENER_KEY, "panel");
    f.change(OPENER_KEY);
    await settle();
    expect(f.of("setPopup").at(-1)).toEqual([""]);
    f.data.set("sk_settings", SHARED); // Security mode: the shared preset
    f.change("sk_settings");
    await settle();
    expect(f.of("setPopup").at(-1)).toEqual([POPUP_PATH]);
    expect(f.of("setOptions").at(-1)).toEqual([{ enabled: false }]);
    const reads = f.of("get").length;
    f.change("sk_diag", "sk_active", "sk_events");
    await settle();
    expect(f.of("get")).toHaveLength(reads);
  });

  it("changes in quick succession are applied in order, so the last one stored is the one in force", async () => {
    const f = fake({ get: "hang" });
    serveAction(f.c);
    f.data.set(OPENER_KEY, "panel");
    f.change(OPENER_KEY);
    f.data.delete(OPENER_KEY);
    f.change(OPENER_KEY);
    for (let i = 0; i < 4; i++) {
      f.release();
      await settle();
    }
    expect(f.of("setPopup").at(-1)).toEqual([POPUP_PATH]);
    expect(f.of("get")).toHaveLength(3); // one read each, one after the other
  });

  it("a read that fails is reported once it can be, and the next change tries again", async () => {
    const f = fake({ get: "reject" });
    const w = serveAction(f.c);
    await settle();
    const seen: string[] = [];
    w.onProblem((m) => seen.push(m));
    expect(seen).toEqual(["toolbar action: could not apply the side panel setting"]);
    expect(f.of("setPopup")).toEqual([]); // nothing applied: the icon keeps what it had
  });

  it("a click in panel mode opens the panel in the click itself, in the clicked window, with nothing awaited first", async () => {
    const f = fake({ stored: { [OPENER_KEY]: "panel" } });
    serveAction(f.c);
    await settle();
    const before = f.calls.length;
    f.click({ windowId: 7, id: 3 });
    // synchronously, in the listener: the path again, then open(); no read in between
    expect(f.calls.slice(before)).toEqual([
      ["setOptions", { path: PANEL_PATH, enabled: true }],
      ["open", { windowId: 7 }],
    ]);
    await settle();
    expect(f.of("session.set")).toEqual([[[CLICK_KEY]]]); // an open panel reads the clicked tab again
  });

  it("a click that wakes the worker opens the panel before the first read has answered, and leaves its page as it is", () => {
    const f = fake({ stored: { [OPENER_KEY]: "panel" }, get: "hang" });
    serveAction(f.c);
    f.click({ windowId: 2 });
    expect(f.of("open")).toEqual([[{ windowId: 2 }]]);
    expect(f.of("setOptions")).toEqual([]); // the profile is not known yet: the page is never enabled on a guess
  });

  it("a click while the plan says popup (an apply on its way): the popup for that tab, opened, never the panel, no diagnostics", async () => {
    const f = fake({ stored: { [OPENER_KEY]: "popup" } });
    const w = serveAction(f.c);
    await settle();
    f.click({ windowId: 1, id: 5 });
    await settle();
    expect(f.of("open")).toEqual([]);
    expect(f.calls.slice(-2)).toEqual([
      ["setPopup", POPUP_PATH, { tabId: 5 }],
      ["openPopup", 1],
    ]);
    const seen: string[] = [];
    w.onProblem((m) => seen.push(m));
    expect(seen).toEqual([]);
  });

  for (const how of ["reject", "throw"] as const)
    it(`a panel that will not open (${how}): the popup in that tab only, the choice and the other windows unchanged, one diagnostics line`, async () => {
      const f = fake({ stored: { [OPENER_KEY]: "panel" }, open: how });
      const w = serveAction(f.c);
      await settle();
      const applied = f.of("setPopup").length;
      f.click({ windowId: 1, id: 8 });
      f.click({ windowId: 1, id: 8 });
      await settle();
      // never the global popup: only the clicked tab's, set before it is opened
      expect(f.of("setPopup").slice(applied)).toEqual([
        [POPUP_PATH, { tabId: 8 }],
        [POPUP_PATH, { tabId: 8 }],
      ]);
      expect(f.of("openPopup")).toEqual([[1], [1]]);
      const firstSet = f.calls.findIndex((x) => x[0] === "setPopup" && x[2] !== undefined);
      expect(f.calls.findIndex((x) => x[0] === "openPopup")).toBeGreaterThan(firstSet);
      expect(f.data.get(OPENER_KEY)).toBe("panel");
      const seen: string[] = [];
      w.onProblem((m) => seen.push(m));
      expect(seen).toEqual(["toolbar action: the side panel did not open; the popup is used in that tab"]);
      expect(f.of("session.set")).toEqual([]);
    });

  for (const type of ["popup", "app"])
    it(`a ${type} window, where open() resolves but there is no side panel: the popup in that tab`, async () => {
      const f = fake({ stored: { [OPENER_KEY]: "panel" }, windowType: type });
      serveAction(f.c);
      await settle();
      f.click({ windowId: 4, id: 9 });
      await settle();
      expect(f.of("open")).toEqual([[{ windowId: 4 }]]);
      expect(f.calls.slice(-2)).toEqual([
        ["setPopup", POPUP_PATH, { tabId: 9 }],
        ["openPopup", 4],
      ]);
      expect(f.of("session.set")).toEqual([]);
    });

  it("a browser without the side panel API: the popup at start, and a click (none should come) opens the popup", async () => {
    const f = fake({ stored: { [OPENER_KEY]: "panel" }, panel: false });
    serveAction(f.c);
    await settle();
    expect(f.of("setPopup")).toEqual([[POPUP_PATH]]);
    f.click({ windowId: 1 });
    await settle();
    expect(f.calls.at(-1)).toEqual(["openPopup", 1]);
  });

  it("no chrome.action, or no chrome at all: nothing throws", async () => {
    expect(() => serveAction(fake({ noAction: true }).c)).not.toThrow();
    const w = serveAction(undefined);
    await w.apply();
    expect(w.plan).toBeUndefined();
  });
});

describe("source rules", () => {
  const SRC = resolve(__dirname, "../../src");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
  const all = files(SRC).map((p) => ({ path: relative(SRC, p).split("\\").join("/"), text: readFileSync(p, "utf8") }));

  it("the side panel API's open-on-click behaviour is named nowhere (it loses activeTab: ux-study E2)", () => {
    expect(all.filter((f) => /openPanelOnActionClick|setPanelBehavior/.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  it("sidePanel.open() is called in three places, each in the user's action with nothing awaited before it", () => {
    const callers = all.filter((f) => /sidePanel!?\??\.open!?\(/.test(f.text)).map((f) => f.path);
    expect(callers.sort()).toEqual(["background/fill-command.ts", "platform/action-mode.ts", "popup/main/Main.tsx"]);
    // the Fill shortcut's report starts opening the panel or popup before it awaits anything (the shortcut is the user's
    // action), and the opening function's first awaited call is the open itself
    const fill = all.find((f) => f.path === "background/fill-command.ts")!.text;
    const report = fill.slice(fill.indexOf("export async function reportFill("));
    const before = report.slice(report.indexOf("{\n"), report.indexOf("openSurface(c, opens")).replace(/\/\/.*$/gm, "");
    expect(before).not.toMatch(/\bawait\b|\.then\(/);
    const surfaceFn = fill.slice(
      fill.indexOf("async function openSurface("),
      fill.indexOf("export async function reportFill("),
    );
    expect(surfaceFn).toContain("await c.sidePanel.open(");
    expect(surfaceFn.slice(0, surfaceFn.indexOf("await c.sidePanel.open(")).replace(/\/\/.*$/gm, "")).not.toMatch(
      /\bawait\b|\.then\(/,
    );
    const action = all.find((f) => f.path === "platform/action-mode.ts")!.text;
    const click = action.slice(action.indexOf("onClicked?.addListener("), action.indexOf("storage?.local?.onChanged"));
    expect(click.slice(0, click.indexOf(".open!("))).not.toMatch(/\bawait\b|\.then\(|\bget\(/);
    const main = all.find((f) => f.path === "popup/main/Main.tsx")!.text;
    const open = main.slice(main.indexOf("function openPanel()"), main.indexOf("async function ack("));
    expect(open.slice(0, open.indexOf("sidePanel.open("))).not.toMatch(/\bawait\b|\.then\(/);
  });

  it("the lock screen takes the focus in the side panel only while the panel has it (a lock must not pull a page's digits into the PIN)", () => {
    const locked = all.find((f) => f.path === "popup/screens/Locked.tsx")!.text;
    const focus = [...locked.matchAll(/input\.current\?\.focus\(\)/g)];
    expect(focus).toHaveLength(2);
    const before = locked.slice(Math.max(0, focus[0]!.index! - 120), focus[0]!.index!);
    expect(before).toMatch(/if \(!surface\.panel \|\| document\.hasFocus\(\)\)\s*$/);
    // the other: after the user's own Touch ID / Windows Hello attempt was cancelled or failed (PRF-NOTES.md §1), to the
    // master password's field, never the PIN's (which sends itself at the PIN's length), and in the side panel only while
    // the panel has the focus, as the first: a ceremony that ends after the user went back to the web page (a click there
    // dismisses Chrome's passkey prompt) must not pull their next keys into Sixkey's field
    const fallback = locked.slice(Math.max(0, focus[1]!.index! - 160), focus[1]!.index!);
    expect(fallback).toMatch(
      /onFallback=\{\(\) => \{\s*if \(now\.current !== "pin" && \(!surface\.panel \|\| document\.hasFocus\(\)\)\)\s*$/,
    );
  });

  it("the worker imports the access level first and the toolbar icon second, before everything else", () => {
    const sw = all.find((f) => f.path === "background/sw.ts")!.text;
    const imports = [...sw.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.slice(0, 2)).toEqual(["./storage-access-first", "./action-first"]);
    expect(all.find((f) => f.path === "background/action-first.ts")!.text).toMatch(
      /^export const action = serveAction\(\);$/m,
    );
  });
});

describe("the real service worker", () => {
  afterEach(unload);

  it("at start sets the icon from storage: the panel's mode, its page enabled; a click opens it in that window", async () => {
    const w = await loadWorker({ seedLocal: { [OPENER_KEY]: "panel", sk_settings: SOLO } });
    expect(w.local.reads[0]).toEqual([OPENER_KEY, "sk_settings"]); // the worker's first read
    expect(w.log.slice(0, 2).sort()).toEqual(["local.setAccessLevel", "session.setAccessLevel"]);
    expect(w.log.indexOf("addListener:clicked")).toBeLessThan(w.log.indexOf("addListener:message"));
    expect(w.icon).toEqual([
      ["popup", ""],
      ["panel", { path: PANEL_PATH, enabled: true }],
    ]);
    expect(w.listeners.clicked).toHaveLength(1);
    w.listeners.clicked![0]!({ windowId: 9, id: 4 });
    expect(w.opened).toEqual([{ windowId: 9 }]);
    await wait();
    expect(w.session.data.has(CLICK_KEY)).toBe(true);
  });

  it("the choice turned off (the settings page removes the key): the popup again, at once", async () => {
    const w = await loadWorker({ seedLocal: { [OPENER_KEY]: "panel" } });
    w.local.data.delete(OPENER_KEY);
    for (const l of w.listeners.localChanged!) l({ [OPENER_KEY]: { oldValue: "panel" } });
    await wait();
    expect(w.icon.at(-2)).toEqual(["popup", POPUP_PATH]);
  });

  it("a shared profile: the popup and the panel's page disabled, from the first start", async () => {
    const w = await loadWorker({ seedLocal: { [OPENER_KEY]: "panel", sk_settings: SHARED } });
    expect(w.icon).toEqual([
      ["popup", POPUP_PATH],
      ["panel", { enabled: false }],
    ]);
  });

  it("no side panel API: the popup, and the lock shortcut still locks (commands are unchanged)", async () => {
    const w = await loadWorker({ seedLocal: { [OPENER_KEY]: "panel" }, panel: false });
    expect(w.icon).toEqual([["popup", POPUP_PATH]]);
    expect(w.listeners.command).toHaveLength(1);
  });
});
