// AUTOFILL2 patch 4a (docs/design/notes/AUTOFILL2-NOTES.md §12; the plan review's M-3): the input delay of a surface that
// holds a page's fill request (src/popup/page-delay.ts), on a fake clock. The input delay's 600 ms, re-armed by input, but
// not by a character typed into a secret field; a press counts only if it began after the delay.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Mod = typeof import("../../src/popup/page-delay");
const g = globalThis as Record<string, unknown>;
let win: Record<string, ((e: unknown) => void)[]>;
let mod: Mod;
const secret = { localName: "input", type: "password" };
const search = { localName: "input", type: "text" };

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["performance", "Date", "setTimeout", "clearTimeout"] });
  win = {};
  g.addEventListener = (t: string, f: (e: unknown) => void) => void (win[t] ??= []).push(f);
  mod = await import("../../src/popup/page-delay");
});
const start = () => mod.startPageDelay(); // App's call at the document's start (the gate open)

describe("before it is started (a build with the gate closed never starts it)", () => {
  it("does nothing at import: no listener, no timer, no clock", () => {
    expect(Object.keys(win)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(mod.surfaceStart()).toBe(0);
    start();
    expect(Object.keys(win)).toEqual(["focus"]);
    expect(mod.surfaceStart()).toBeGreaterThan(0);
    start(); // once: a second call adds nothing
    expect(win.focus).toHaveLength(1);
  });
});
afterEach(() => {
  vi.useRealTimers();
  delete g.addEventListener;
});
const at = () => performance.now();
const tick = (ms: number) => vi.advanceTimersByTime(ms);

describe("the surface's input delay while a page's request is here", () => {
  beforeEach(start);
  it("is the SDK's 600 ms from the document's start", () => {
    expect(mod.INPUT_DELAY_MS).toBe(600);
    expect(mod.pageDelay.ready()).toBe(false);
    tick(599);
    expect(mod.pageDelay.ready()).toBe(false);
    tick(1);
    expect(mod.pageDelay.ready()).toBe(true);
    expect(mod.pageDelay.pressOk()).toBe(true);
  });

  it("a press during the delay re-arms it and does not count; a stream of presses never lands", () => {
    tick(300);
    mod.onPress({ type: "keydown", key: "Enter", target: search });
    expect(mod.pageDelay.pressOk()).toBe(false);
    tick(500); // 800 ms from the start, but 500 from the press
    expect(mod.pageDelay.ready()).toBe(false);
    // typing on, a key every 200 ms: each one re-arms the delay, and none counts
    for (let i = 0; i < 10; i++) {
      mod.onPress({ type: "keydown", key: "a", target: search });
      expect(mod.pageDelay.pressOk()).toBe(false);
      tick(200);
    }
    expect(mod.pageDelay.ready()).toBe(false);
    tick(400);
    expect(mod.pageDelay.ready()).toBe(true);
    // the next press, after the delay, counts
    mod.onPress({ type: "keydown", key: "Enter", target: search });
    expect(mod.pageDelay.pressOk()).toBe(true);
  });

  it("a character typed into a secret field during the delay is kept and does not re-arm it (its Enter does)", () => {
    tick(200);
    mod.onPress({ type: "keydown", key: "4", target: secret });
    mod.onPress({ type: "keydown", key: "2", target: secret });
    expect(mod.pageDelay.pressOk()).toBe(false); // that press began in the delay
    tick(400);
    expect(mod.pageDelay.ready()).toBe(true); // 600 ms from the start: the digits did not move it
    mod.onPress({ type: "keydown", key: "Enter", target: secret });
    expect(mod.pageDelay.pressOk()).toBe(true);
    // an Enter inside the delay re-arms
    mod.pageDelay.rearm();
    tick(100);
    mod.onPress({ type: "keydown", key: "Enter", target: secret });
    tick(550);
    expect(mod.pageDelay.ready()).toBe(false);
  });

  it("a key repeat never counts; a pointer press re-arms like a key", () => {
    tick(700);
    mod.onPress({ type: "keydown", key: "Enter", repeat: true, target: search });
    expect(mod.pageDelay.pressOk()).toBe(false);
    mod.pageDelay.rearm();
    tick(100);
    mod.onPress({ type: "pointerdown", target: search });
    tick(600);
    expect(mod.pageDelay.ready()).toBe(true);
    expect(at() - mod.pageDelay.lastPress()).toBe(600);
  });

  it("the window's focus re-arms it, except the focus a press in this document just brought (the side panel clicked into)", () => {
    tick(1000);
    expect(mod.pageDelay.ready()).toBe(true);
    for (const f of win.focus ?? []) f({});
    expect(mod.pageDelay.ready()).toBe(false);
    tick(1000);
    mod.onPress({ type: "pointerdown", target: search });
    tick(10);
    for (const f of win.focus ?? []) f({});
    expect(mod.pageDelay.ready()).toBe(true);
    expect(mod.pageDelay.pressOk()).toBe(true);
  });

  it("tells its subscribers when it arms and when it ends", () => {
    const seen: number[] = [];
    mod.pageDelay.subscribe(() => seen.push(Math.round(at())));
    mod.pageDelay.rearm();
    tick(700);
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });
});
