// The side panel's own rules (src/sidepanel/guard.ts; docs/design/notes/SIDEPANEL-NOTES.md §3), over the real runtime
// wiring (createRuntime over fake storage areas, as the read-budget tests build it) and a fake clock: the 15-minute idle
// cap counted from the user's input and from the key's shared record of activity, the soft lock it ends in, the page's own
// key dropped with "lock every time" and on close (and nothing else), the wall clock read again when the panel is shown
// or focused, changes made elsewhere followed, a shared profile closing the panel, and the active tab followed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addEntry } from "../../src/core/vault/ops";
import { CLICK_KEY } from "../../src/platform/action-mode";
import { createRuntime, type Runtime } from "../../src/platform/runtime";
import { LOCK_EPOCH_KEY, SESSION_KEY } from "../../src/platform/session";
import {
  FOLLOW_UNLOCK_MS,
  INPUT_EVENTS,
  LOCK_SCREEN_WIPE_MS,
  PANEL_IDLE_MS,
  panelHooks,
  sharedNow,
  TICK_MS,
  TOUCH_EVERY_MS,
  type PanelEnv,
} from "../../src/sidepanel/guard";
import { STRONG } from "../helpers/vaults";

const MIN = 60_000;

function area() {
  const data = new Map<string, unknown>();
  const a = {
    async get(keys?: string | string[] | null) {
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(ks.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
  return { data, area: a as unknown as chrome.storage.StorageArea };
}

/** An event source with the listener sets visible, for DOM targets and chrome.* events alike. */
function source() {
  const ls = new Map<string, Set<(...a: never[]) => unknown>>();
  const set = (t: string) => ls.get(t) ?? ls.set(t, new Set()).get(t)!;
  return {
    addEventListener: (t: string, l: (...a: never[]) => unknown) => void set(t).add(l),
    removeEventListener: (t: string, l: (...a: never[]) => unknown) => void set(t).delete(l),
    fire: (t: string, ...a: unknown[]) => [...set(t)].forEach((l) => (l as (...x: unknown[]) => unknown)(...a)),
    count: (t: string) => set(t).size,
    event: (t: string) => ({
      addListener: (l: (...a: never[]) => unknown) => void set(t).add(l),
      removeListener: (l: (...a: never[]) => unknown) => void set(t).delete(l),
    }),
  };
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

let local: ReturnType<typeof area>;
let session: ReturnType<typeof area>;
let doc: ReturnType<typeof source> & { visibilityState: string };
let win: ReturnType<typeof source>;
let ev: ReturnType<typeof source>;
let ticks: (() => void)[];
let sent: unknown[];
let shut: number;
let reloads: number;
let showing: string;
let env: PanelEnv;
/** The page's fields (the lock screen's): anything typed or ticked; wipes; the hint's state; the active tab's address. */
let typed: boolean;
let wipes: number;
let hints: boolean[];
let activeUrl: string | undefined;

/** A new profile with a vault, unlocked in `rt` (the panel's runtime): created there, so the key is in its session. */
async function unlocked(mode: "idle" | "always" | "session", minutes = 15): Promise<Runtime> {
  local = area();
  session = area();
  const rt = createRuntime({ local: local.area, session: session.area, mirror: null });
  const autoLock = mode === "idle" ? { mode, minutes } : { mode };
  await rt.settings.set({ autoLock, lockOnScreenLock: true, profile: "solo" } as never);
  await rt.service.create(await rt.service.prepareKeys(STRONG)); // the session starts now, in this runtime
  await rt.service.mutate(
    (v, c) =>
      addEntry(
        v,
        { type: "totp", issuer: "A", label: "a", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 },
        c,
      ).vault,
  );
  expect(await rt.session.get()).not.toBeNull();
  return rt;
}
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
const tick = async () => {
  ticks.forEach((f) => f());
  await settle();
};
const epoch = () => (session.data.get(LOCK_EPOCH_KEY) as number | undefined) ?? 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-20T10:00:00Z") });
  local = area();
  session = area();
  doc = Object.assign(source(), { visibilityState: "visible" });
  win = source();
  ev = source();
  ticks = [];
  sent = [];
  shut = 0;
  reloads = 0;
  showing = "main";
  typed = false;
  wipes = 0;
  hints = [];
  activeUrl = "https://example.test/";
  env = {
    chrome: {
      storage: { local: { onChanged: ev.event("local") }, session: { onChanged: ev.event("session") } },
      tabs: {
        onActivated: ev.event("activated"),
        onUpdated: ev.event("updated"),
        query: async () => [{ url: activeUrl }],
      },
      runtime: { sendMessage: async (m: unknown) => void sent.push(m) },
    },
    doc,
    win,
    now: () => Date.now(),
    setInterval: (f: () => void) => ticks.push(f),
    clearInterval: () => void ticks.splice(0),
    shut: () => void shut++,
    typed: () => typed,
    wipe: () => void wipes++,
    hint: (show: boolean) => void hints.push(show),
  } as unknown as PanelEnv;
});
afterEach(() => vi.useRealTimers());

function attach(rt: Runtime) {
  const reload = async () => {
    reloads++;
  };
  return panelHooks(env).attach(rt as never, reload, () => showing);
}

describe("the idle cap", () => {
  it("is 15 minutes, checked every 10 seconds, and input touches at most every 30 seconds", () => {
    expect(PANEL_IDLE_MS).toBe(15 * MIN);
    expect(TICK_MS).toBe(10_000);
    expect(TOUCH_EVERY_MS).toBe(30_000);
    expect([...INPUT_EVENTS]).toEqual(["pointerdown", "keydown", "wheel", "touchstart"]);
  });

  for (const [mode, minutes] of [
    ["idle", 60],
    ["session", 0],
  ] as const)
    it(`locks after 15 idle minutes in "${mode}" mode${mode === "idle" ? ` (${minutes} min)` : ""}: the soft lock, everywhere`, async () => {
      const rt = await unlocked(mode, minutes);
      attach(rt);
      const e0 = epoch();
      later(15 * MIN - 1000);
      await tick();
      expect(await rt.session.get()).not.toBeNull();
      expect(reloads).toBe(0);
      later(2000);
      await tick();
      expect(session.data.has(SESSION_KEY)).toBe(false); // the shared key is gone
      expect(epoch()).toBe(e0 + 1); // every page holding a key drops it
      expect(reloads).toBe(1); // this panel shows the lock screen
    });

  it("the user's input in the panel moves the deadline, and touches the key's record of activity", async () => {
    const rt = await unlocked("idle", 60);
    attach(rt);
    later(10 * MIN);
    doc.fire("keydown", {});
    await settle();
    expect((await rt.session.get())!.lastActive).toBe(Date.now());
    later(10 * MIN);
    await tick();
    expect(await rt.session.get()).not.toBeNull(); // 10 minutes after the key was pressed
    later(5 * MIN + 1000);
    await tick();
    expect(await rt.session.get()).toBeNull();
  });

  it("each kind of input counts; anything else (a reload, the codes' tick, focus) does not", async () => {
    for (const kind of INPUT_EVENTS) {
      const rt = await unlocked("idle", 60);
      const stop = attach(rt);
      later(14 * MIN);
      doc.fire(kind, {});
      later(14 * MIN);
      await tick();
      expect(await rt.session.get(), kind).not.toBeNull();
      stop();
    }
    const rt = await unlocked("idle", 60);
    attach(rt);
    later(14 * MIN);
    for (const kind of ["focusin", "scroll", "pointermove", "mousemove", "pointerover", "mouseover", "pointerenter"])
      doc.fire(kind, {}); // a pointer moving over the panel is not use: the user may be reading the page beside it
    win.fire("focus");
    await settle();
    later(2 * MIN);
    await tick();
    expect(await rt.session.get()).toBeNull();
  });

  it("a hidden panel (a minimised window) is still checked at every tick, and locks", async () => {
    const rt = await unlocked("idle", 60);
    attach(rt);
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    later(15 * MIN + 1000);
    await tick();
    expect(await rt.session.get()).toBeNull();
    expect(reloads).toBe(1);
  });

  it("touches are throttled: a burst of input writes the record once", async () => {
    const rt = await unlocked("idle", 60);
    attach(rt);
    let writes = 0;
    const plain = session.area as unknown as { set(i: Record<string, unknown>): Promise<void> };
    const set = plain.set.bind(plain);
    plain.set = async (i: Record<string, unknown>) => {
      if (SESSION_KEY in i) writes++;
      return set(i);
    };
    for (let i = 0; i < 20; i++) {
      later(1000);
      doc.fire("pointerdown", {});
    }
    await settle();
    expect(writes).toBe(1);
  });

  it("use of Sixkey elsewhere (another window's panel, the popup) counts: the shared record decides", async () => {
    const rt = await unlocked("idle", 60);
    attach(rt);
    later(10 * MIN);
    const elsewhere = createRuntime({ local: local.area, session: session.area, mirror: null });
    await elsewhere.service.touch();
    later(6 * MIN);
    await tick();
    expect(await rt.session.get()).not.toBeNull(); // 16 minutes for this panel, 6 since the other page was used
    later(10 * MIN);
    await tick();
    expect(await rt.session.get()).toBeNull();
  });

  it('"lock every time": the panel drops its own key only; no epoch, so another window\'s panel keeps its key', async () => {
    const rt = await unlocked("always");
    const other = createRuntime({ local: local.area, session: session.area, mirror: null });
    await other.session.set((await rt.session.get())!); // another panel, unlocked on its own
    attach(rt);
    const e0 = epoch();
    later(15 * MIN + 1000);
    await tick();
    expect(await rt.session.get()).toBeNull();
    expect(reloads).toBe(1);
    expect(epoch()).toBe(e0);
    expect(await other.session.get()).not.toBeNull();
  });

  it("nothing is checked or locked while the panel is not showing the list", async () => {
    const rt = await unlocked("idle", 60);
    attach(rt);
    showing = "locked";
    later(60 * MIN);
    await tick();
    expect(await rt.session.get()).not.toBeNull();
    expect(reloads).toBe(0);
  });

  it("a timer slowed down while hidden, or stopped by sleep: the wall clock is read when the panel is shown or focused", async () => {
    const rt = await unlocked("idle", 60);
    attach(rt);
    later(40 * MIN); // no tick came
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    await settle();
    expect(await rt.session.get()).not.toBeNull(); // hidden: nothing to show, the next tick or showing decides
    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    await settle();
    expect(await rt.session.get()).toBeNull();

    const rt2 = await unlocked("idle", 60);
    attach(rt2);
    later(20 * MIN);
    win.fire("focus");
    await settle();
    expect(await rt2.session.get()).toBeNull();
  });

  it("before the deadline seen at the last read, a tick reads nothing", async () => {
    const rt = await unlocked("idle", 60);
    attach(rt);
    later(1000);
    await tick(); // reads, and learns the deadline
    let reads = 0;
    const plain = session.area as unknown as { get(k: unknown): Promise<Record<string, unknown>> };
    const get = plain.get.bind(plain);
    plain.get = async (k: unknown) => {
      reads++;
      return get(k);
    };
    for (let i = 0; i < 50; i++) {
      later(TICK_MS);
      await tick();
    }
    expect(reads).toBe(0);
    later(10 * MIN);
    await tick();
    expect(reads).toBeGreaterThan(0);
    expect(await rt.session.get()).toBeNull();
  });
});

describe("the lock screen in a page that stays open", () => {
  it("anything typed or a Show box ticked is wiped after 2 minutes without input; nothing typed, nothing redrawn", async () => {
    expect(LOCK_SCREEN_WIPE_MS).toBe(2 * MIN);
    const rt = await unlocked("idle", 15);
    attach(rt);
    showing = "locked";
    typed = true;
    doc.fire("keydown", {}); // typing
    later(LOCK_SCREEN_WIPE_MS - 1000);
    await tick();
    expect(wipes).toBe(0);
    later(2000);
    await tick();
    expect(wipes).toBe(1);
    typed = false;
    later(10 * MIN);
    await tick();
    expect(wipes).toBe(1); // an empty lock screen is left as it is
  });

  it("and when the panel is hidden; never on the list", async () => {
    const rt = await unlocked("idle", 15);
    attach(rt);
    typed = true;
    showing = "main";
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    later(5 * MIN);
    await tick();
    expect(wipes).toBe(0); // the list's own fields (search) are not secrets
    showing = "locked";
    doc.fire("visibilitychange");
    expect(wipes).toBe(1);
  });
});

describe("close", () => {
  it('pagehide drops the page\'s own key ("lock every time") and stops every listener and the timer', async () => {
    const rt = await unlocked("always");
    attach(rt);
    expect(ticks).toHaveLength(1);
    win.fire("pagehide", { persisted: false });
    expect(await rt.session.get()).toBeNull();
    expect(ticks).toHaveLength(0);
    for (const t of [...INPUT_EVENTS, "visibilitychange"]) expect(doc.count(t), t).toBe(0);
    for (const t of ["focus", "pagehide"]) expect(win.count(t), t).toBe(0);
    expect(ev.count("local") + ev.count("session")).toBe(0);
  });

  it("a shared key stays at close, as when the popup closes: the automatic lock and the idle cap end it", async () => {
    const rt = await unlocked("idle", 15);
    attach(rt);
    const e0 = epoch();
    win.fire("pagehide", { persisted: false });
    expect(session.data.has(SESSION_KEY)).toBe(true);
    expect(epoch()).toBe(e0);
  });

  it("a page kept by the browser (persisted) still drops its key, and keeps its listeners for when it is shown", async () => {
    const rt = await unlocked("always");
    attach(rt);
    win.fire("pagehide", { persisted: true });
    expect(await rt.session.get()).toBeNull();
    expect(ticks).toHaveLength(1);
  });
});

describe("following what happens elsewhere", () => {
  it("a commit or a settings change elsewhere reloads the list; nothing reloads the lock screen for it", async () => {
    const rt = await unlocked("idle", 15);
    attach(rt);
    ev.fire("local", { sk_active: { newValue: "b" } });
    ev.fire("local", { sk_settings: { newValue: { autoLock: { mode: "idle", minutes: 5 }, profile: "solo" } } });
    ev.fire("local", { sk_diag: { newValue: [] } });
    expect(reloads).toBe(2);
    showing = "locked";
    ev.fire("local", { sk_active: { newValue: "a" } });
    expect(reloads).toBe(2);
  });

  it("an unlock elsewhere (the shared key appears) opens the list at once in a panel used in the last 5 minutes", async () => {
    expect(FOLLOW_UNLOCK_MS).toBe(5 * MIN);
    const rt = await unlocked("idle", 15);
    attach(rt);
    showing = "locked";
    later(FOLLOW_UNLOCK_MS - 1000);
    ev.fire("session", { [SESSION_KEY]: { newValue: { vk: "x", lastActive: 1 } } });
    expect(reloads).toBe(1);
    ev.fire("session", { [SESSION_KEY]: { oldValue: { vk: "x" } } }); // removed: the lock epoch's listener in App handles it
    showing = "main";
    ev.fire("session", { [SESSION_KEY]: { newValue: { vk: "x", lastActive: 2 } } }); // a touch: no reload
    expect(reloads).toBe(1);
  });

  it("a panel left alone (another window, a shared screen) stays locked after an unlock elsewhere, until its next input", async () => {
    const rt = await unlocked("idle", 15);
    attach(rt);
    showing = "locked";
    later(FOLLOW_UNLOCK_MS + 1000);
    ev.fire("session", { [SESSION_KEY]: { newValue: { vk: "x", lastActive: 1 } } });
    await tick();
    expect(reloads).toBe(0);
    doc.fire("pointerdown", {}); // the user's own input in this panel: the list
    expect(reloads).toBe(1);
    doc.fire("pointerdown", {});
    expect(reloads).toBe(1); // once
    // and a lock in between forgets it: the next input in a locked panel opens nothing
    showing = "locked";
    later(FOLLOW_UNLOCK_MS + 1000);
    ev.fire("session", { [SESSION_KEY]: { newValue: { vk: "x", lastActive: 2 } } });
    ev.fire("session", { [SESSION_KEY]: { oldValue: { vk: "x" } } });
    doc.fire("keydown", {});
    expect(reloads).toBe(1);
  });

  it("a switch to a shared profile closes the panel: its key dropped, everything stopped", async () => {
    const rt = await unlocked("always");
    attach(rt);
    ev.fire("local", {
      sk_settings: { newValue: { autoLock: { mode: "always" }, lockOnScreenLock: true, profile: "shared" } },
    });
    expect(shut).toBe(1);
    expect(await rt.session.get()).toBeNull();
    expect(ticks).toHaveLength(0);
    expect(ev.count("local")).toBe(0);
    expect(sharedNow(undefined)).toBe(false);
    expect(sharedNow({ autoLock: { mode: "always" }, lockOnScreenLock: true, display: { hideCodes: true } })).toBe(
      true,
    );
  });

  it("the list shown: the worker re-arms its idle alarm; the key's activity is not touched", async () => {
    const rt = await unlocked("idle", 15);
    const before = (await rt.session.get())!.lastActive;
    later(MIN);
    panelHooks(env).shown(rt as never);
    await settle();
    expect(sent).toEqual([{ type: "sk-reschedule-autolock" }]);
    expect((await rt.session.get())!.lastActive).toBe(before);
  });

  it("a tab that gives no address (the icon not clicked on it): the hint, read again with the tab; gone when the list goes", async () => {
    activeUrl = undefined;
    const stop = panelHooks(env).watchTab(() => undefined);
    await settle();
    expect(hints).toEqual([true]);
    activeUrl = "https://example.test/"; // back on the clicked tab
    ev.fire("activated", { tabId: 1, windowId: 1 });
    await settle();
    expect(hints).toEqual([true, false]);
    activeUrl = undefined;
    ev.fire("session", { [CLICK_KEY]: { newValue: 1 } });
    await settle();
    expect(hints.at(-1)).toBe(true);
    stop();
    expect(hints.at(-1)).toBe(false);
    activeUrl = undefined;
    ev.fire("activated", {}); // no listener left
    await settle();
    expect(hints.at(-1)).toBe(false);
  });

  it("the active tab: read again on a tab change, a load in the active tab and a new click on the icon", () => {
    let n = 0;
    const stop = panelHooks(env).watchTab(() => n++);
    ev.fire("activated", { tabId: 2, windowId: 1 });
    ev.fire("updated", 2, { status: "complete" }, { active: true });
    ev.fire("updated", 3, { status: "complete" }, { active: false }); // a tab in the background
    ev.fire("updated", 2, { status: "loading" }, { active: true });
    ev.fire("session", { [CLICK_KEY]: { newValue: 1 } });
    ev.fire("session", { [SESSION_KEY]: { newValue: {} } });
    expect(n).toBe(3);
    stop();
    expect(ev.count("activated") + ev.count("updated") + ev.count("session")).toBe(0);
  });
});
