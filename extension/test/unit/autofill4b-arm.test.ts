// TOTP autofill Stage 2, patch 4b (docs/design/notes/AUTOFILL2-NOTES.md §13): the in-page suggestion's decisions
// (src/inject/suggest-arm.ts), each rule of TOTP-AUTOFILL §4.5 as the patch 4 plan revised it, with its edges. The e2e set
// (test/e2e/autofill4b-suggest.spec.ts) drives the same rules in real pages; these hold them exactly.
import { describe, expect, it } from "vitest";
import {
  ARM_MS,
  arming,
  FULL,
  fullSize,
  GAP_MS,
  judge,
  meet,
  PILL_PX,
  place,
  readAnswer,
  type Click,
} from "../../src/inject/suggest-arm";

describe("the worker's answer to cand, held to its exact shape", () => {
  it("show: true with the shortcut, and show: false, are answers", () => {
    expect(readAnswer({ show: true, key: "Alt+Shift+F" })).toEqual({ show: true, key: "Alt+Shift+F" });
    expect(readAnswer({ show: true, key: "" })).toEqual({ show: true, key: "" });
    expect(readAnswer({ show: false })).toEqual({ show: false });
  });
  it("anything else is no answer (C2: and is not kept as show: false)", () => {
    for (const a of [
      undefined,
      null,
      true,
      "show",
      [],
      [{ show: true, key: "" }],
      {},
      { show: "true", key: "" },
      { show: 1, key: "" },
      { show: true },
      { show: true, key: 1 },
      { show: true, key: "x".repeat(65) },
      { show: true, key: "", more: 1 },
      { show: false, key: "" },
      { show: false, why: "off" },
    ])
      expect(readAnswer(a), JSON.stringify(a)).toBeNull();
    expect(readAnswer({ show: true, key: "x".repeat(64) })).not.toBeNull();
  });
});

describe("the arming clock (§4.5 item 3, S-7)", () => {
  const clock = () => {
    let t = 0;
    const a = arming(() => t);
    return { a, at: (ms: number) => void (t = ms) };
  };
  it("armed after ARM_MS of being seen whole without a break, not before", () => {
    const { a } = clock();
    expect(ARM_MS).toBe(800);
    a.frame(0);
    a.seen(true, 0);
    for (let t = 0; t <= ARM_MS; t += 16) a.frame(t);
    expect(a.armed(ARM_MS - 1)).toBe(false);
    expect(a.armed(ARM_MS)).toBe(true);
    expect(a.visible()).toBe(true);
  });
  it("a second report of the same keeps the start; a break starts it again", () => {
    const { a } = clock();
    a.seen(true, 0);
    a.seen(true, 500);
    expect(a.armed(ARM_MS)).toBe(true);
    a.seen(false, 900);
    expect(a.visible()).toBe(false);
    expect(a.armed(5000)).toBe(false);
    a.seen(true, 1000);
    expect(a.armed(1000 + ARM_MS - 1)).toBe(false);
    expect(a.armed(1000 + ARM_MS)).toBe(true);
  });
  it("a restart (a move, a top-layer toggle near it) needs ARM_MS again; while not seen it changes nothing", () => {
    const { a } = clock();
    a.restart(100);
    expect(a.visible()).toBe(false);
    a.seen(true, 0);
    a.restart(700);
    expect(a.armed(1000)).toBe(false);
    expect(a.armed(700 + ARM_MS)).toBe(true);
  });
  it("its frames: a pause longer than GAP_MS restarts the clock; fresh only while they keep coming", () => {
    const { a } = clock();
    expect(GAP_MS).toBe(250);
    a.seen(true, 0);
    for (let t = 0; t < 1000; t += 16) a.frame(t);
    a.frame(1000);
    expect(a.armed(1000)).toBe(true);
    expect(a.fresh(1000 + GAP_MS)).toBe(true);
    expect(a.fresh(1000 + GAP_MS + 1)).toBe(false); // held right now (a long task, a view transition's update)
    a.frame(1000 + GAP_MS); // a pause of exactly GAP_MS still counts as drawn all along
    expect(a.armed(1000 + GAP_MS)).toBe(true);
    a.frame(1000 + 2 * GAP_MS + 1); // and one longer: the 800 ms again
    expect(a.armed(1000 + 2 * GAP_MS + 1)).toBe(false);
    expect(a.armed(1000 + 2 * GAP_MS + 1 + ARM_MS)).toBe(true);
  });
  it("the default clock is the one given", () => {
    const { a, at } = clock();
    at(10);
    a.seen(true);
    a.frame();
    at(10 + ARM_MS);
    expect(a.armed()).toBe(true);
    expect(a.fresh()).toBe(false);
  });
});

describe("drawn at full size (M-5, R2-S3)", () => {
  it("its effective zoom and its rendered height, both at least FULL of its design", () => {
    expect([PILL_PX, FULL]).toEqual([32, 0.8]);
    expect(fullSize(1, 32)).toBe(true);
    expect(fullSize(0.9, 28.8)).toBe(true);
    expect(fullSize(0.8, 25.6)).toBe(true);
    expect(fullSize(0.79, 32)).toBe(false);
    expect(fullSize(1, 25.5)).toBe(false);
    expect(fullSize(0.5, 16)).toBe(false);
    expect(fullSize(0.1, 3.2)).toBe(false);
  });
});

describe("the decision on a click, in the order of its reasons (§4.5 item 4)", () => {
  const ok: Click = {
    trusted: true,
    detail: 1,
    used: false,
    pendingHidden: false,
    visible: true,
    armed: true,
    fresh: true,
    fullSize: true,
    downHere: true,
    topIsHost: true,
  };
  it("a trusted, armed click at full size, pressed on it and hitting it, opens", () => {
    expect(judge(ok)).toBe("open");
  });
  it("each reason alone refuses", () => {
    expect(judge({ ...ok, used: true })).toBe("used");
    expect(judge({ ...ok, trusted: false })).toBe("untrusted");
    expect(judge({ ...ok, pendingHidden: true })).toBe("hidden"); // K1: what IntersectionObserver has not reported yet
    expect(judge({ ...ok, visible: false })).toBe("hidden");
    expect(judge({ ...ok, fullSize: false })).toBe("small");
    expect(judge({ ...ok, armed: false })).toBe("early");
    expect(judge({ ...ok, fresh: false })).toBe("stale");
    expect(judge({ ...ok, downHere: false })).toBe("nopd");
    expect(judge({ ...ok, topIsHost: false })).toBe("hit");
  });
  it("the order: used, untrusted, hidden, small, early, stale, then the pointer's two", () => {
    const none: Click = {
      trusted: false,
      detail: 1,
      used: true,
      pendingHidden: true,
      visible: false,
      armed: false,
      fresh: false,
      fullSize: false,
      downHere: false,
      topIsHost: false,
    };
    const steps: [Partial<Click>, string][] = [
      [{}, "used"],
      [{ used: false }, "untrusted"],
      [{ trusted: true }, "hidden"],
      [{ pendingHidden: false }, "hidden"],
      [{ visible: true }, "small"],
      [{ fullSize: true }, "early"],
      [{ armed: true }, "stale"],
      [{ fresh: true }, "nopd"],
      [{ downHere: true }, "hit"],
      [{ topIsHost: true }, "open"],
    ];
    let c = none;
    for (const [change, v] of steps) {
      c = { ...c, ...change };
      expect(judge(c), JSON.stringify(change)).toBe(v);
    }
  });
  it("from the keyboard or a screen reader (detail 0): no pointer to test, armed is enough", () => {
    expect(judge({ ...ok, detail: 0, downHere: false, topIsHost: false })).toBe("open");
    expect(judge({ ...ok, detail: 0, armed: false })).toBe("early");
    expect(judge({ ...ok, detail: 0, trusted: false })).toBe("untrusted");
  });
});

describe("two rectangles meet (S-7: a top-layer element toggled over its place)", () => {
  const r = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
  it("overlap meets; touching edges and apart do not", () => {
    expect(meet(r(0, 0, 10, 10), r(5, 5, 15, 15))).toBe(true);
    expect(meet(r(0, 0, 10, 10), r(2, 2, 3, 3))).toBe(true);
    expect(meet(r(0, 0, 10, 10), r(10, 0, 20, 10))).toBe(false);
    expect(meet(r(0, 0, 10, 10), r(0, 10, 10, 20))).toBe(false);
    expect(meet(r(0, 0, 10, 10), r(30, 30, 40, 40))).toBe(false);
    expect(meet(r(0, 0, 0, 0), r(-5, -5, 5, 5))).toBe(false); // a hidden element's empty rect
  });
});

describe("where it goes: under the box, else over it, at the start edge, inside the viewport", () => {
  const view = { width: 1000, height: 700 };
  const pill = { width: 300, height: 32 };
  const box = { left: 100, top: 200, right: 260, bottom: 236 };
  it("under the box, 4 px below, at its left edge", () => {
    expect(place(box, pill, view, false)).toEqual({ left: 100, top: 240 });
  });
  it("right to left: its right edge at the box's", () => {
    expect(place(box, pill, view, true)).toEqual({ left: 8, top: 240 }); // (260 - 300, kept inside)
    expect(place({ ...box, left: 500, right: 900 }, pill, view, true)).toEqual({ left: 600, top: 240 });
  });
  it("over the box when there is no room under it, never above the top margin", () => {
    expect(place({ ...box, top: 640, bottom: 676 }, pill, view, false)).toEqual({ left: 100, top: 604 });
    expect(place({ ...box, top: 0, bottom: 690 }, pill, view, false)).toEqual({ left: 100, top: 8 });
  });
  it("kept 8 px inside the viewport's sides; rounded to whole pixels", () => {
    expect(place({ ...box, left: -50 }, pill, view, false).left).toBe(8);
    expect(place({ ...box, left: 900 }, pill, view, false).left).toBe(692);
    expect(place({ ...box, left: 100.4, bottom: 236.6 }, pill, view, false)).toEqual({ left: 100, top: 241 });
  });
});
