// The backup in Chrome's sync storage in the popup and the side panel (src/popup/main/CsbPop.tsx; the welcome's
// src/popup/screens/CsbFound.tsx), rendered by Preact into a minimal document (test/helpers/mini-dom.ts) over a stand-in
// chrome.*: storage.local with its change event, storage.session, a fake storage.sync (test/helpers/fake-sync-area.ts),
// and runtime.sendMessage, which records every message. What the header pill, its title and its colour say from the
// worker's two records, and that they come with the open's own read; the footer's problem line; the one click, which
// leaves "turn on now" for the card and sends nothing; this browser's word for Chrome Sync; the welcome's copy found and
// its restore; and that nothing the popup or the side panel can load sends a message of the backup's. The texts are the
// catalogs' own (catalogs/csb-popup-*.json), never retyped here. The real pages are test/e2e/csb-popup.spec.ts's.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import csbEn from "../../catalogs/csb-en.json";
import csbZh from "../../catalogs/csb-zh_CN.json";
import popEn from "../../catalogs/csb-popup-en.json";
import popZh from "../../catalogs/csb-popup-zh_CN.json";
import { STALE_AFTER_MS } from "../../src/core/cloud/status";
import { MemoryKV } from "../../src/core/storage/kv";
import { CSB_CFG_KEY, CSB_STATE_KEY, NEW_CSB_CONFIG, NEW_CSB_STATE } from "../../src/platform/csb-config";
import type { CsbConfig, CsbState } from "../../src/platform/csb-config";
import { fullCatalog } from "../../src/ui/catalog-full";
import { branded } from "../../src/ui/csb-brand";
import { csbChanges, watchCsbChanges } from "../../src/popup/csb-changes";
import { loadCatalog, setLangChoice, t } from "../../src/ui/i18n";
import { computer } from "../helpers/csb-pages";
import { FakeSyncArea } from "../helpers/fake-sync-area";
import { installMiniDom, type MiniElement } from "../helpers/mini-dom";

const EXT = resolve(__dirname, "../..");
const cb = (k: keyof typeof popEn, ...subs: (string | number)[]) =>
  popEn[k].message.replace(/\$(\d)/g, (_, n: string) => String(subs[Number(n) - 1]));
const T0 = 1_900_000_000_000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const CHROME = { userAgentData: { brands: [{ brand: "Chromium" }, { brand: "Google Chrome" }] } };
const EDGE = { userAgentData: { brands: [{ brand: "Chromium" }, { brand: "Microsoft Edge" }] } };
const ON: CsbConfig = { ...NEW_CSB_CONFIG, on: true };
const st = (s: Partial<CsbState> = {}): CsbState => ({ ...NEW_CSB_STATE, ...s });

let Pop: typeof import("../../src/popup/main/CsbPop");
let Found: typeof import("../../src/popup/screens/CsbFound");
let Welcome: typeof import("../../src/popup/screens/Welcome");
beforeAll(async () => {
  setLangChoice("en");
  await loadCatalog(fullCatalog);
  Pop = await import("../../src/popup/main/CsbPop");
  Found = await import("../../src/popup/screens/CsbFound");
  Welcome = await import("../../src/popup/screens/Welcome");
});

let dom: ReturnType<typeof installMiniDom>;
let root: MiniElement;
type Listener = (changes: Record<string, unknown>) => void;
/** The popup's chrome.*: storage.local (its change event fired by `records`), storage.session, the messages sent. */
function world(o: { sync?: FakeSyncArea } = {}) {
  const ls = new Set<Listener>();
  const local = Object.assign(new MemoryKV(), {
    onChanged: {
      addListener: (l: Listener) => void ls.add(l),
      removeListener: (l: Listener) => void ls.delete(l),
    },
  });
  const session = new MemoryKV();
  const sent: unknown[] = [];
  const tabs: string[] = [];
  const reads: string[][] = [];
  const get = local.get.bind(local);
  local.get = (keys: string[]) => (reads.push([...keys]), get(keys));
  const chromeStub = {
    storage: { local, session, ...(o.sync ? { sync: o.sync } : {}) },
    runtime: {
      sendMessage: async (m: unknown) => void sent.push(m),
      getURL: (p: string) => `chrome-extension://sixkey/${p}`,
    },
    tabs: { create: async (x: { url: string }) => void tabs.push(x.url) },
  };
  return {
    chrome: chromeStub,
    local,
    session,
    sent,
    tabs,
    reads,
    listeners: () => ls.size,
    /** The records as the worker writes them, and the change event it fires. */
    async records(cfg: unknown, s: unknown) {
      await local.set({ [CSB_CFG_KEY]: cfg, [CSB_STATE_KEY]: s });
      ls.forEach((l) => l({ [CSB_CFG_KEY]: {}, [CSB_STATE_KEY]: {} }));
    },
    /** The state alone, as the worker's runs write it, and the change event of that key alone. */
    async state(s: unknown) {
      await local.set({ [CSB_STATE_KEY]: s });
      ls.forEach((l) => l({ [CSB_STATE_KEY]: {} }));
    },
    /** A change of a key that is not theirs. */
    async other() {
      await local.set({ sk_last_backup: T0 });
      ls.forEach((l) => l({ sk_last_backup: {} }));
    },
  };
}
const settle = async () => {
  for (let i = 0; i < 8; i++) await act(() => new Promise((r) => setTimeout(r, 4)));
};
const byId = (id: string) => root.byId(id);
/** The footer's account count with no link: what the popup shows when it has nothing to ask (no reminder). */
const plainFoot = () =>
  root
    .all((e) => e.localName === "span" && e.getAttribute("class") === "bk")
    .map((e) => e.textContent)
    .join("|");
/** Any reminder or link in the footer (the popup's own reminder is a.bk.old, as the one click and the problem line). */
const footLinks = () => root.all((e) => e.localName === "a" && (e.getAttribute("class") ?? "").includes("bk"));
function click(el: MiniElement | null) {
  expect(el).not.toBeNull();
  act(() => void el!.dispatch("click", { preventDefault() {} }));
}
let w: ReturnType<typeof world>;
const opened: string[] = [];
/** What the open read, as the screen holds it (`also`: KvSettingsStore's read of the two keys with the settings). */
const alsoOf = (cfg: unknown, s: unknown) => ({ [CSB_CFG_KEY]: cfg, [CSB_STATE_KEY]: s });
/** The pill and the footer as Main draws them: the open's records, and the count of changes when it read them. */
const parts = (also: Record<string, unknown> | undefined, o: { due?: boolean; mark?: number } = {}) =>
  h(
    "div",
    null,
    h(Pop.Pill, { also, mark: o.mark ?? csbChanges(), children: h("span", { id: "local-pill" }, "local") }),
    h(Pop.Foot, {
      also,
      mark: o.mark ?? csbChanges(),
      count: "3 accounts",
      due: o.due ?? false,
      open: (x: string) => void opened.push(x),
      children: h("span", { id: "own-foot" }, "own"),
    }),
  );
/** The pill and the footer as Main draws them, with the records the open read (written to storage.local as well). */
async function mount(cfg: unknown, s: unknown, o: { due?: boolean } = {}) {
  w = world();
  vi.stubGlobal("chrome", w.chrome);
  await w.local.set({ [CSB_CFG_KEY]: cfg, [CSB_STATE_KEY]: s });
  w.reads.length = 0;
  opened.length = 0;
  act(() => render(parts(alsoOf(cfg, s), o), root as unknown as Element));
  await settle();
}

beforeEach(() => {
  dom = installMiniDom();
  root = dom.doc.body;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.stubGlobal("navigator", CHROME);
  vi.stubGlobal("window", globalThis); // the popup closes itself after opening the settings page (chrome.tsx)
  vi.stubGlobal("close", () => undefined);
});
afterEach(() => {
  act(() => render(null, root as unknown as Element));
  dom.undo();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("when the popup speaks up (stopped): the card's problems that wait for the person", () => {
  it("not off, nor a copy handed over or about to be, nor a passing failure; every stopping error, three days stale, and this browser's refusal", () => {
    const r = (cfg: CsbConfig, s: Partial<CsbState>) => Pop.stopped({ cfg, st: st(s) }, T0);
    expect(r(NEW_CSB_CONFIG, { err: "no_room", unsafe: true })).toBe(false); // off: the popup's own pill
    for (const s of [
      { lastOk: T0 - MIN }, // handed over
      { lastOk: T0 - MIN, pendingSince: T0 }, // a change waiting
      { pendingSince: T0 }, // nothing handed over yet
      { lastRun: T0 }, // an empty vault
      { err: "busy" as const, errSince: T0, pendingSince: T0 }, // a passing failure: the card's alone
      { err: "other" as const, errSince: T0, pendingSince: T0 - STALE_AFTER_MS + 1 },
    ])
      expect(r(ON, s), JSON.stringify(s)).toBe(false);
    for (const err of ["too_large", "no_room", "held", "no_password", "unreadable"] as const)
      expect(r(ON, { err, errSince: T0 }), err).toBe(true);
    expect(r(ON, { pendingSince: T0 - STALE_AFTER_MS })).toBe(true); // three days with changes waiting
    expect(r(ON, { err: "busy", errSince: T0 - 4 * DAY, pendingSince: T0 - 4 * DAY })).toBe(true);
    expect(r(ON, { unsafe: true, lastOk: T0 - MIN })).toBe(true); // this browser would not close the area
    expect(r({ ...ON, declined: true }, { lastOk: T0 })).toBe(false);
  });

  it("what the card says agrees: the popup speaks up exactly where the card's line is stopped, stale or this browser's refusal", async () => {
    const { cardView } = await import("../../src/options/csb/model");
    const errs = [null, "busy", "other", "too_large", "no_room", "held", "no_password", "unreadable"] as const;
    let n = 0;
    for (const cfg of [NEW_CSB_CONFIG, ON, { ...ON, declined: true }])
      for (const err of errs)
        for (const pendingSince of [null, T0, T0 - STALE_AFTER_MS + 1, T0 - STALE_AFTER_MS, T0 - 9 * DAY])
          for (const lastOk of [null, T0 - MIN])
            for (const unsafe of [false, true])
              for (const lastRun of [null, T0]) {
                const s = st({ err, errSince: err ? T0 : null, pendingSince, lastOk, unsafe, lastRun });
                const k = cardView(cfg, s, T0).kind;
                expect(Pop.stopped({ cfg, st: s }, T0), JSON.stringify({ cfg, s })).toBe(
                  k === "stopped" || k === "stale" || k === "unsafe",
                );
                n++;
              }
    expect(n).toBe(3 * 8 * 5 * 2 * 2 * 2);
  });

  it("the records read strictly, as the card reads them: one that does not check out is a backup never set up", () => {
    expect(Pop.recsOf({})).toEqual({ cfg: NEW_CSB_CONFIG, st: NEW_CSB_STATE });
    expect(Pop.recsOf(alsoOf({ ...ON, extra: 1 }, { ...st(), lastOk: "now" }))).toEqual({
      cfg: NEW_CSB_CONFIG,
      st: NEW_CSB_STATE,
    });
    expect(Pop.recsOf(alsoOf(ON, st({ lastOk: T0 })))).toEqual({ cfg: ON, st: st({ lastOk: T0 }) });
  });
});

describe("the popup's pill and footer", () => {
  it("off: the popup's own pill and footer", async () => {
    await mount(NEW_CSB_CONFIG, st());
    expect(byId("local-pill")).not.toBeNull();
    expect(byId("csb-pill")).toBeNull();
    expect(byId("own-foot")).not.toBeNull();
  });

  it("handed over: 'Chrome Sync' with a check, its title the card's line with when; the footer the account count only", async () => {
    await mount(ON, st({ lastOk: T0 - 3 * MIN, lastRun: T0 }));
    const pill = byId("csb-pill")!;
    expect(pill.textContent).toBe(cb("cbPill"));
    expect(pill.getAttribute("title")).toBe(cb("cbOk", "3 minutes ago"));
    expect(pill.getAttribute("class")).toBe("loc");
    expect(byId("local-pill")).toBeNull();
    expect(plainFoot()).toBe("3 accounts");
    expect(byId("own-foot")).toBeNull();
    expect(byId("csb-problem")).toBeNull();
  });

  it("the backup runs, its last copy a week and more ago (a vault unchanged since), the reminder due: no reminder, the account count only", async () => {
    // on and not stopped, whatever its state: handed over long ago, a change waiting, a passing failure, nothing yet
    for (const s of [
      st({ lastOk: T0 - 8 * DAY, lastRun: T0 - 2 * DAY }),
      st({ lastOk: T0 - 8 * DAY, pendingSince: T0 - MIN }),
      st({ lastOk: T0 - 8 * DAY, err: "busy", errSince: T0, pendingSince: T0 }),
      st({ pendingSince: T0 }),
    ]) {
      await mount(ON, s, { due: true });
      expect(plainFoot(), JSON.stringify(s)).toBe("3 accounts");
      expect(footLinks(), JSON.stringify(s)).toEqual([]); // no 立即备份, no one click, no problem line
      expect(byId("own-foot")).toBeNull();
      act(() => render(null, root as unknown as Element));
    }
  });

  it("on, nothing handed over yet (or a passing failure): the pill, its title the backup's name until a copy is handed over", async () => {
    await mount(ON, st({ pendingSince: T0 }));
    expect(byId("csb-pill")!.textContent).toBe(cb("cbPill"));
    expect(byId("csb-pill")!.getAttribute("title")).toBe(cb("cbTitle"));
    act(() => render(null, root as unknown as Element));
    await mount(ON, st({ lastOk: T0 - 2 * 60 * MIN, err: "busy", errSince: T0, pendingSince: T0 }));
    expect(byId("csb-pill")!.textContent).toBe(cb("cbPill"));
    expect(byId("csb-pill")!.getAttribute("title")).toBe(cb("cbOk", "2 hours ago"));
    expect(plainFoot()).toBe("3 accounts");
  });

  for (const [why, s] of [
    ["no room", st({ err: "no_room", errSince: T0 })],
    ["three days stale", st({ lastOk: T0 - 5 * DAY, pendingSince: T0 - 3 * DAY })],
    ["this browser's refusal (unsafe)", st({ unsafe: true, lastOk: T0 - MIN })],
  ] as const)
    it(`stopped (${why}): 备份已停 in amber, and the footer's problem line opens Settings › Backup, asking nothing`, async () => {
      await mount(ON, s, { due: true });
      const pill = byId("csb-pill")!;
      expect(pill.textContent).toBe(cb("cbStopped"));
      expect(pill.getAttribute("title")).toBe(cb("cbStopped"));
      expect(pill.getAttribute("class")).toBe("loc stop");
      expect(byId("csb-problem")!.textContent).toBe(`3 accounts · ${cb("cbProblem")}`);
      expect(byId("csb-now")).toBeNull();
      click(byId("csb-problem"));
      await settle();
      expect(opened).toEqual(["#backup"]);
      expect(w.sent).toEqual([]);
      expect(await w.session.get(["sk_cloud_go"])).toEqual({});
    });

  it("the one click: off, never turned off, the reminder due: 立即备份 leaves 'turn on now' for the card and opens it, sending nothing", async () => {
    await mount(NEW_CSB_CONFIG, st(), { due: true });
    const link = byId("csb-now")!;
    expect(link.textContent).toBe(`3 accounts · ${t("backupNow")}`);
    expect(byId("own-foot")).toBeNull();
    click(link);
    await settle();
    expect((await w.session.get(["sk_cloud_go"])).sk_cloud_go).toBe(T0);
    expect(opened).toEqual(["#backup"]);
    expect(w.sent).toEqual([]); // the card turns it on; the popup sends the worker nothing
  });

  it("no one click where the person turned it off before, or where it is not due: the popup's own footer", async () => {
    for (const [cfg, s, due] of [
      [{ ...NEW_CSB_CONFIG, declined: true }, st(), true],
      [NEW_CSB_CONFIG, st(), false],
    ] as const) {
      await mount(cfg, s, { due });
      expect(byId("csb-now"), JSON.stringify(cfg)).toBeNull();
      expect(byId("own-foot")).not.toBeNull();
      act(() => render(null, root as unknown as Element));
    }
  });

  it("a change of the state alone (a run of the worker's) redraws both; a change of another key reads nothing", async () => {
    await mount(ON, st({ lastOk: T0 }));
    await w.other();
    await settle();
    expect(w.reads).toEqual([]);
    await w.state(st({ err: "too_large", errSince: T0 }));
    await settle();
    expect(w.reads).toEqual([[CSB_CFG_KEY, CSB_STATE_KEY]]);
    expect(byId("csb-pill")!.textContent).toBe(cb("cbStopped"));
    expect(byId("csb-problem")).not.toBeNull();
  });

  it("a change of the records redraws both, from one read of the two", async () => {
    await mount(ON, st({ lastOk: T0 }));
    expect(w.reads).toEqual([]);
    await w.records(ON, st({ err: "held", errSince: T0 }));
    await settle();
    expect(w.reads).toEqual([[CSB_CFG_KEY, CSB_STATE_KEY]]);
    expect(byId("csb-pill")!.textContent).toBe(cb("cbStopped"));
    expect(byId("csb-problem")).not.toBeNull();
    await w.records(NEW_CSB_CONFIG, st());
    await settle();
    expect(w.reads).toHaveLength(2);
    expect(byId("csb-pill")).toBeNull();
    expect(byId("local-pill")).not.toBeNull();
  });
});

describe("the records come with the open's own read (test/e2e/perf.spec.ts: the open reads nothing more for them)", () => {
  it("drawn from what the open read: no read of their own; one per change; gone with the last, and read afresh by a later mount", async () => {
    await mount(ON, st({ err: "no_room", errSince: T0 }));
    expect(w.reads).toEqual([]);
    expect(byId("csb-pill")!.textContent).toBe(cb("cbStopped"));
    expect(w.listeners()).toBe(1); // one listener for both
    // the list left (the Add view) and shown again with the same screen: its records may be older than a change
    // nobody heard meanwhile, so they are read afresh, once
    act(() => render(null, root as unknown as Element));
    expect(w.listeners()).toBe(0);
    await w.local.set({ [CSB_CFG_KEY]: ON, [CSB_STATE_KEY]: st({ lastOk: T0 }) }); // the change nobody hears
    const also = alsoOf(ON, st({ err: "no_room", errSince: T0 }));
    act(() => render(parts(also), root as unknown as Element));
    await settle();
    expect(w.reads).toEqual([]); // a screen not drawn before: its records, as read
    act(() => render(null, root as unknown as Element));
    act(() => render(parts(also), root as unknown as Element));
    await settle();
    expect(w.reads).toEqual([[CSB_CFG_KEY, CSB_STATE_KEY]]); // the same screen again: read afresh
    expect(byId("csb-pill")!.textContent).toBe(cb("cbPill"));
    expect(byId("csb-problem")).toBeNull();
  });

  it("with no records from the open (a screen without them): one read, shared by both", async () => {
    w = world();
    vi.stubGlobal("chrome", w.chrome);
    await w.local.set({ [CSB_CFG_KEY]: ON, [CSB_STATE_KEY]: st({ lastOk: T0 }) });
    w.reads.length = 0;
    act(() => render(parts(undefined), root as unknown as Element));
    await settle();
    expect(w.reads).toEqual([[CSB_CFG_KEY, CSB_STATE_KEY]]);
    expect(byId("csb-pill")!.textContent).toBe(cb("cbPill"));
  });

  it("a change heard after the open's read began (the screen's mark): read again, the newer records shown; none heard: none read", async () => {
    w = world();
    vi.stubGlobal("chrome", w.chrome);
    watchCsbChanges(w.local); // the page's start (App), before any read
    await w.local.set({ [CSB_CFG_KEY]: ON, [CSB_STATE_KEY]: st({ lastOk: T0 }) });
    const mark = csbChanges(); // the open's read begins: it reads these
    const read = alsoOf(ON, st({ lastOk: T0 }));
    await w.state(st({ err: "no_room", errSince: T0 })); // the worker writes, before the pill listens
    expect(csbChanges()).toBe(mark + 1);
    w.reads.length = 0;
    act(() => render(parts(read, { mark }), root as unknown as Element));
    await settle();
    expect(w.reads).toEqual([[CSB_CFG_KEY, CSB_STATE_KEY]]);
    expect(byId("csb-pill")!.textContent).toBe(cb("cbStopped"));
    expect(byId("csb-problem")).not.toBeNull();
    // a later open whose read began after that change: its records as read, nothing read again
    act(() => render(null, root as unknown as Element));
    const later = alsoOf(ON, st({ err: "no_room", errSince: T0 }));
    act(() => render(parts(later, { mark: csbChanges() }), root as unknown as Element));
    await settle();
    expect(w.reads).toHaveLength(1);
    expect(byId("csb-pill")!.textContent).toBe(cb("cbStopped"));
  });

  it("a change while a read is out: once more after it, so the read that began before the change is not the last word", async () => {
    w = world();
    vi.stubGlobal("chrome", w.chrome);
    const get = w.local.get.bind(w.local);
    let hold: (() => void) | null = null;
    let n = 0;
    w.local.get = (keys: string[]) => {
      n++;
      if (n > 1) return get(keys);
      const before = { [CSB_CFG_KEY]: ON, [CSB_STATE_KEY]: st({ lastOk: T0 }) }; // as the first read finds them
      return new Promise((r) => (hold = () => r(before)));
    };
    act(() => render(parts(undefined), root as unknown as Element)); // no records from the open: a read, held
    await vi.waitFor(() => expect(hold).not.toBeNull());
    await w.records(ON, st({ err: "held", errSince: T0 })); // heard while that read is out
    hold!();
    await settle();
    expect(n).toBe(2);
    expect(byId("csb-pill")?.textContent).toBe(cb("cbStopped"));
  });

  it("mounted again while the last read is still out: once more after it, so a change made while nothing listened is not lost", async () => {
    w = world();
    vi.stubGlobal("chrome", w.chrome);
    const get = w.local.get.bind(w.local);
    let hold: (() => void) | null = null;
    let n = 0;
    w.local.get = (keys: string[]) => {
      n++;
      if (n > 1) return get(keys);
      const before = { [CSB_CFG_KEY]: ON, [CSB_STATE_KEY]: st({ lastOk: T0 }) }; // as the first read finds them
      return new Promise((r) => (hold = () => r(before)));
    };
    const pill = () => h(Pop.Pill, { children: h("span", { id: "local-pill" }, "local") });
    act(() => render(pill(), root as unknown as Element));
    act(() => render(null, root as unknown as Element)); // the last one goes: no listener now
    await w.local.set({ [CSB_CFG_KEY]: ON, [CSB_STATE_KEY]: st({ err: "held", errSince: T0 }) }); // nobody hears it
    act(() => render(pill(), root as unknown as Element)); // back while the first read is still out
    expect(hold).not.toBeNull();
    hold!();
    await settle();
    expect(n).toBe(2);
    expect(byId("csb-pill")?.textContent).toBe(cb("cbStopped"));
  });
});

describe("this browser's word, and the words", () => {
  it("a browser that is not Google Chrome: 'Browser sync', handed to browser sync; no Chrome, no Google account", async () => {
    vi.stubGlobal("navigator", EDGE);
    await mount(ON, st({ lastOk: T0 - 3 * MIN }));
    const pill = byId("csb-pill")!;
    expect(pill.textContent).toBe("Browser sync");
    expect(pill.getAttribute("title")).toBe("Handed to browser sync · 3 minutes ago");
    for (const k of Object.keys(popEn) as (keyof typeof popEn)[]) {
      expect(branded(popEn[k].message, false, popEn.cbBrowser.message), k).not.toMatch(/Chrome|Google/);
      expect(branded(popZh[k].message, false, popZh.cbBrowser.message), k).not.toMatch(/Chrome|Google/);
    }
    // Chinese without the space it keeps before a Latin word
    expect(branded(popZh.cbOk.message.replace("$1", "3分钟前"), false, popZh.cbBrowser.message)).toBe(
      "已交给浏览器同步 · 3分钟前",
    );
    expect(branded(popZh.cbPill.message, false, popZh.cbBrowser.message)).toBe("浏览器同步");
    expect(branded(popZh.cbRestore.message, false, popZh.cbBrowser.message)).toBe("从浏览器同步恢复");
  });

  it("the act, never the outcome: no line says backed up or in the cloud, in either language; none names a Google account", () => {
    for (const [cat, lang] of [
      [popEn, "en"],
      [popZh, "zh_CN"],
    ] as const)
      for (const [k, v] of Object.entries(cat)) {
        expect(v.message, `${lang} ${k}`).not.toMatch(/backed up|in the cloud|已备份|云端|Google/i);
      }
    expect(Object.keys(popEn)).toEqual(Object.keys(popZh));
  });

  it("the lines both pages show are the settings catalog's own, word for word, in both languages", () => {
    const same = { cbOk: "csOk", cbTitle: "csTitle", cbFoundAt: "csFoundAt", cbArrived: "csArrived" } as const;
    const more = { cbRestore: "csRestore", cbBrowser: "csBrowser" } as const;
    for (const [p, s] of Object.entries({ ...same, ...more }) as [keyof typeof popEn, keyof typeof csbEn][]) {
      expect(popEn[p].message, p).toBe(csbEn[s].message);
      expect(popZh[p].message, p).toBe(csbZh[s].message);
    }
  });
});

describe("the welcome: a copy in Chrome Sync, offered first", () => {
  /** Another computer's copy, as its worker wrote it into its storage.sync. */
  async function written() {
    const a = computer();
    await a.makeVault();
    await a.add("GitHub");
    await a.worker.on();
    await a.worker.idle();
    return a.area.snapshot();
  }
  function welcome(sync: FakeSyncArea | undefined) {
    w = world({ ...(sync ? { sync } : {}) });
    vi.stubGlobal("chrome", w.chrome);
    act(() =>
      render(h(Welcome.Welcome, { rt: {} as never, reload: async () => undefined }), root as unknown as Element),
    );
  }
  const shown = (id: string) => vi.waitFor(() => expect(byId(id)).not.toBeNull(), { timeout: 15_000 });

  it("found: its line with when, 从 Chrome 同步恢复 first, opening first run's restore from it; start is not the main button", async () => {
    const items = await written();
    const sync = new FakeSyncArea({ items });
    welcome(sync);
    await shown("csb-found");
    await settle();
    expect(byId("csb-found")!.textContent).toBe(cb("cbFoundAt", "now"));
    const restore = byId("csb-restore")!;
    expect(restore.textContent).toBe(cb("cbRestore"));
    expect(restore.getAttribute("class")).toBe("btn");
    expect(byId("start-secure")!.getAttribute("class")).toBe("btn ghost");
    expect(byId("start-restore")).not.toBeNull();
    // first in the page's order: the found line, its button, then the welcome's own
    const order = root.all((e) => ["csb-found", "csb-restore", "start-secure"].includes(e.id)).map((e) => e.id);
    expect(order).toEqual(["csb-found", "csb-restore", "start-secure"]);
    click(restore);
    expect(w.tabs).toEqual(["chrome-extension://sixkey/options/index.html#setup-csb"]);
    // read only: nothing written to Chrome Sync, nothing sent
    expect(sync.callsOf("set")).toEqual([]);
    expect(sync.callsOf("remove")).toEqual([]);
    expect(w.sent).toEqual([]);
  }, 60_000);

  it("none there: the welcome as it was; one that arrives while it is open: said as just arrived", async () => {
    const items = await written();
    const sync = new FakeSyncArea();
    welcome(sync);
    await settle();
    expect(byId("csb-found")).toBeNull();
    expect(byId("start-secure")!.getAttribute("class")).toBe("btn");
    sync.remote.put(items);
    sync.remote.deliverAll();
    await shown("csb-found");
    await settle();
    expect(byId("csb-found")!.textContent).toBe(cb("cbArrived"));
    expect(byId("start-secure")!.getAttribute("class")).toBe("btn ghost");
  }, 60_000);

  it("a copy still arriving is not offered; no storage.sync, or one that cannot be read: the welcome as it was", async () => {
    const items = await written();
    const partial = new FakeSyncArea();
    partial.remote.put(items);
    partial.remote.deliver(Object.keys(items).find((k) => !/\.\d+$/.test(k))!); // the manifest only
    welcome(partial);
    await settle();
    expect(byId("csb-found")).toBeNull();
    act(() => render(null, root as unknown as Element));

    welcome(undefined);
    await settle();
    expect(byId("csb-found")).toBeNull();
    expect(byId("start-secure")).not.toBeNull();
    act(() => render(null, root as unknown as Element));

    const broken = new FakeSyncArea({ items });
    broken.get = () => Promise.reject(new Error("unreadable"));
    welcome(broken);
    await settle();
    expect(byId("csb-found")).toBeNull();
    expect(byId("start-secure")!.getAttribute("class")).toBe("btn");
  }, 60_000);

  it("a first read that fails: a copy found later has just arrived, and is said so", async () => {
    const items = await written();
    const sync = new FakeSyncArea();
    const get = sync.get.bind(sync);
    let fail = true;
    sync.get = (k: null | string | readonly string[] = null) =>
      fail ? ((fail = false), Promise.reject(new Error("unreadable"))) : get(k);
    welcome(sync);
    await settle();
    expect(fail).toBe(false); // the first read was made, and failed
    expect(byId("csb-found")).toBeNull();
    sync.remote.put(items);
    sync.remote.deliverAll();
    await shown("csb-found");
    await settle();
    expect(byId("csb-found")!.textContent).toBe(cb("cbArrived"));
  }, 60_000);

  it("a browser that is not Google Chrome: its word, no Chrome", async () => {
    vi.stubGlobal("navigator", EDGE);
    const sync = new FakeSyncArea({ items: await written() });
    welcome(sync);
    await shown("csb-found");
    expect(byId("csb-found")!.textContent).toBe("Found a Sixkey backup in browser sync (latest now).");
    expect(byId("csb-restore")!.textContent).toBe("Restore from browser sync");
  }, 60_000);
});

describe("the welcome's part with no words (its catalog cannot be read)", () => {
  afterEach(() => {
    vi.doUnmock("../../src/ui/csb-popup-text");
  });
  it("draws nothing, a copy there or not; the welcome is as it was", async () => {
    const a = computer();
    await a.makeVault();
    await a.add("GitHub");
    await a.worker.on();
    await a.worker.idle();
    vi.resetModules();
    vi.doMock("../../src/ui/csb-popup-text", () => ({
      cb: Object.assign((k: string) => k, { loaded: Promise.resolve(), words: () => null }),
    }));
    const { CsbFound } = await import("../../src/popup/screens/CsbFound");
    w = world({ sync: new FakeSyncArea({ items: a.area.snapshot() }) });
    vi.stubGlobal("chrome", w.chrome);
    const found: boolean[] = [];
    act(() => render(h(CsbFound, { onFound: (f: boolean) => void found.push(f) }), root as unknown as Element));
    for (let i = 0; i < 20; i++) await settle();
    expect(byId("csb-found")).toBeNull();
    expect(byId("csb-restore")).toBeNull();
    expect(found.every((f) => !f)).toBe(true);
  }, 60_000);
});

describe("the popup's footer as Main draws it: the one click in a profile only the person uses, with the open's records", () => {
  // Main over the stand-ins (as afmatch-dom.test.ts draws it), with CsbPop a stand-in that records what Main tells it: a
  // shared profile turns the backup on from the card, never by the popup's nudge
  const told: { pill?: unknown; due?: boolean; also?: unknown; mark?: unknown }[] = [];
  /** `chunk`: "fails" when the pill's chunk cannot be loaded (a damaged install). Returns the first frame's footer. */
  async function drawMain(profile: "solo" | "shared", chunk: "loads" | "fails" = "loads") {
    vi.resetModules();
    vi.doMock("../../src/popup/main/CsbPop", () => {
      if (chunk === "fails") throw new Error("the chunk cannot be loaded");
      return {
        Pill: (p: { also?: unknown; mark?: unknown; children: preact.ComponentChildren }) => (
          told.push({ pill: p.also, mark: p.mark }),
          p.children
        ),
        Foot: (p: { also?: unknown; mark?: unknown; due: boolean; children: preact.ComponentChildren }) => (
          told.push({ due: p.due, also: p.also, mark: p.mark }),
          p.children
        ),
      };
    });
    const i18n = await import("../../src/ui/i18n");
    i18n.setLangChoice("en");
    await i18n.loadCatalog((await import("../../src/ui/catalog-full")).fullCatalog);
    const { parseSettings } = await import("../../src/core/service/types");
    const { createClock } = await import("../../src/core/vault/hlc");
    const { emptyVault } = await import("../../src/core/vault/model");
    const { addEntry } = await import("../../src/core/vault/ops");
    const { Main } = await import("../../src/popup/main/Main");
    w = world();
    vi.stubGlobal("chrome", {
      ...w.chrome,
      tabs: { query: async () => [{ id: 7, windowId: 1, url: "https://example.org/" }] },
      commands: { getAll: async () => [] },
    });
    Object.assign(dom.doc, {
      documentElement: dom.doc.createElement("html"),
      getElementById: (id: string) => root.byId(id),
      querySelector: () => null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("innerHeight", 600);
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    vi.stubGlobal("CSS", { escape: (v: string) => v });
    const clock = createClock("aaaa");
    const entry = { type: "totp", issuer: "GitHub", label: "alice", secret: "JBSWY3DPEHPK3PXP" } as const;
    const vault = addEntry(emptyVault("v1"), { ...entry, algorithm: "SHA1", digits: 6, period: 30 }, clock).vault;
    const settings = parseSettings({ autoLock: { mode: "idle", minutes: 15 }, lockOnScreenLock: true, profile });
    const service = { mutate: async () => vault, ackEvents: async () => undefined, lock: async () => undefined };
    const also = alsoOf(NEW_CSB_CONFIG, st());
    told.length = 0;
    act(() =>
      render(
        h(Main, {
          rt: { service: { ...service, grantKeys: async () => null } } as never,
          // the last backup a week and more ago (none): the reminder is due
          screen: { k: "main", vault, events: [], protected: true, lastBackup: null, settings, also, mark: 7 },
          reload: async () => undefined,
        }),
        root as unknown as Element,
      ),
    );
    const first = { plain: plainFoot(), links: footLinks().length };
    if (chunk === "fails") {
      for (let i = 0; i < 100 && footLinks().length === 0; i++) await settle();
      return { first, dues: [] };
    }
    for (let i = 0; i < 100 && !told.some((x) => "due" in x); i++) await settle();
    expect(told.some((x) => "due" in x)).toBe(true);
    // both get the records the open read, as they are, and the count of changes when it read them
    expect(told.filter((x) => "pill" in x).every((x) => x.pill === also && x.mark === 7)).toBe(true);
    expect(told.filter((x) => "due" in x).every((x) => x.also === also && x.mark === 7)).toBe(true);
    return { first, dues: told.filter((x) => "due" in x).map((x) => x.due) };
  }
  afterEach(() => {
    vi.doUnmock("../../src/popup/main/CsbPop");
  });

  it("solo: due, so the footer may offer the one click; until the chunk is in, the account count only (no reminder)", async () => {
    const { first, dues } = await drawMain("solo");
    expect(first).toEqual({ plain: "1 account", links: 0 });
    expect(new Set(dues)).toEqual(new Set([true]));
  });

  it("the chunk cannot be loaded: the popup's own reminder", async () => {
    const { first } = await drawMain("solo", "fails");
    expect(first).toEqual({ plain: "1 account", links: 0 });
    const own = root.all((e) => e.localName === "a" && (e.getAttribute("class") ?? "").split(" ").includes("old"));
    expect(own).toHaveLength(1);
    expect(own[0]!.textContent).toContain(t("backupNow"));
  });

  it("shared (vendor-synced, scripted): never due for the one click; the popup's own reminder stays", async () => {
    expect(new Set((await drawMain("shared")).dues)).toEqual(new Set([false]));
    const own = root.all((e) => e.localName === "a" && (e.getAttribute("class") ?? "").split(" ").includes("old"));
    expect(own).toHaveLength(1);
    expect(own[0]!.textContent).toContain(t("backupNow"));
  });
});

describe("the popup never sends a message of the backup's (the settings page alone does)", () => {
  /** Every module the popup and the side panel can load, statically or lazily, from their entries: the source's graph. */
  function graph(): Map<string, string> {
    const src = join(EXT, "src");
    const seen = new Map<string, string>();
    const todo = [join(src, "popup/main.tsx"), join(src, "sidepanel/main.tsx")];
    const resolveFrom = (from: string, spec: string): string | null => {
      if (!spec.startsWith(".")) return null; // a package (preact)
      const base = resolve(dirname(from), spec);
      for (const f of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")])
        try {
          if (statSync(f).isFile()) return f;
        } catch {
          /* the next */
        }
      return null;
    };
    while (todo.length) {
      const f = todo.pop()!;
      if (seen.has(f) || !/\.tsx?$/.test(f)) continue;
      const code = readFileSync(f, "utf8");
      seen.set(f, code);
      // static imports and re-exports (not those of types alone, which load nothing), and import()
      for (const m of code.matchAll(/\b(?:import|export)\s+(type\s+)?(?:[^;"'`]*?\sfrom\s*)?["']([^"']+)["']/g)) {
        const to = m[1] ? null : resolveFrom(f, m[2]!);
        if (to) todo.push(to);
      }
      for (const m of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
        const to = resolveFrom(f, m[1]!);
        if (to) todo.push(to);
      }
    }
    return new Map([...seen].map(([f, c]) => [relative(src, f), c]));
  }

  it("no module either page can load names an sk-csb- message as a string, nor imports the settings page's writes", () => {
    const g = graph();
    expect(g.has("popup/main/CsbPop.tsx")).toBe(true);
    expect(g.has("popup/screens/CsbFound.tsx")).toBe(true);
    expect(g.has("platform/cloud-go.ts")).toBe(true);
    const named = [...g].filter(([, c]) => /["'`]sk-csb-/.test(c)).map(([f]) => f);
    expect(named).toEqual([]);
    // nothing of the settings page's (budget-split.test.ts holds the popup's graph to that too); the copies' reader is
    // the pages', read only
    expect([...g.keys()].filter((f) => f.startsWith("options/"))).toEqual([]);
    expect(g.has("platform/csb-read.ts")).toBe(true);
    // and the walk sees what it should: a message the settings page sends is found where it is
    expect(readFileSync(join(EXT, "src/options/csb/CsbCard.tsx"), "utf8")).toMatch(/["'`]sk-csb-on["'`]/);
    expect(readdirSync(join(EXT, "src/popup/main"))).toContain("CsbPop.tsx");
  });
});
