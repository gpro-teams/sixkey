// TOTP autofill Stage 2, follow-up 4B-FU (docs/design/notes/AUTOFILL2-NOTES.md §13.8): the in-page suggestion's own code
// (src/inject/suggest-ui.ts) in a minimal page (test/helpers/suggest-dom.ts), with the clock, the frames, the observers'
// reports and the worker's answers in the test's hands. What the e2e set cannot pin down, because the browser decides first:
//   - N-1: the fullscreen and view-transition restarts (in Chrome a click never reaches the button then);
//   - N-2: the box the finder named before is shown again from its cached answer, inside the 2 s between looks;
//   - S-1: the content script's own deadline on the worker's answer, which keeps nothing;
//   - S-2: the box's direction read once, and the suggestion hidden after two minutes without the user's input;
//   - S-3: a click refused as too early, or on a held page, says so in the button for a few seconds.
import { afterEach, describe, expect, it } from "vitest";
import { ARM_MS, ASK_MS, CUE_MS, IDLE_MS } from "../../src/inject/suggest-arm";
import { mountSuggestion, type Page } from "../helpers/suggest-dom";

let p: Page | undefined;
afterEach(() => {
  p?.unmount();
  p = undefined;
});
const mount = async () => (p = await mountSuggestion());
const LABEL = "Fill code with Sixkey · x.test";
const WAIT = "One moment, then click again";

describe("the mini-DOM page itself", () => {
  it("the normal path: the user's click, the worker's show: true, 800 ms seen, a click: one `open`", async () => {
    const d = await mount();
    await d.showIt();
    expect(d.sent()).toEqual([{ type: "sk-af-cand" }]);
    expect(d.shown()).toBe(true);
    expect(d.pill().textContent).toBe(LABEL);
    d.frames(ARM_MS - 32);
    expect(d.armed()).toBe(false);
    d.frames(64);
    expect(d.armed()).toBe(true);
    await d.clickPill();
    expect(d.log()).toEqual(["show", "open"]);
    expect(d.sent()).toEqual([{ type: "sk-af-cand" }, { type: "sk-af-open" }]);
  });
});

describe("N-1: the restarts no click can reach in Chrome", () => {
  it("fullscreenchange: the 800 ms again", async () => {
    const d = await mount();
    await d.showIt();
    d.frames(ARM_MS + 50);
    expect(d.armed()).toBe(true);
    d.fire("fullscreenchange", d.doc);
    expect(d.armed()).toBe(false);
    d.frames(ARM_MS - 50);
    expect(d.armed()).toBe(false);
    d.frames(100);
    expect(d.armed()).toBe(true);
  });
  it("a view transition: never armed while it runs, its click refused as stale; the 800 ms again after it", async () => {
    const d = await mount();
    await d.showIt();
    d.frames(ARM_MS + 50);
    expect(d.armed()).toBe(true);
    d.env.transition = true;
    d.frames(32); // its frames keep coming (an animation): only the transition itself says the screen is its pictures
    expect(d.armed()).toBe(false);
    await d.clickPill(); // its clock restarted in each of those frames
    expect(d.log().at(-1)).toMatch(/^refused:(early|stale)$/);
    d.frames(ARM_MS * 2);
    expect(d.armed()).toBe(false);
    d.env.transition = false;
    d.frames(ARM_MS - 50);
    expect(d.armed()).toBe(false);
    d.frames(100);
    expect(d.armed()).toBe(true);
  });
});

describe("N-2: the box named before, again within the 2 s between looks", () => {
  it("a click elsewhere hides it; a click back into the box shows it at once, from the answer kept, with no new ask", async () => {
    const d = await mount();
    await d.showIt();
    d.frames(100);
    await d.press(d.doc.body); // elsewhere
    expect(d.shown()).toBe(false);
    d.advance(300);
    await d.press(); // back into the box, 0.4 s after the look
    expect(d.shown()).toBe(true);
    expect(d.sent()).toEqual([{ type: "sk-af-cand" }]);
    expect(d.log()).toEqual(["show", "show"]);
  });
});

describe("S-1: the content script's deadline on the worker's answer", () => {
  it("unanswered for ASK_MS: asked again at the next look; the late answer counts as none, and is not kept", async () => {
    expect(ASK_MS).toBe(20_000);
    const d = await mount();
    await d.press();
    expect(d.sent()).toHaveLength(1);
    d.advance(ASK_MS - 100);
    await d.press(); // its answer not overdue yet: not asked again
    expect(d.sent()).toHaveLength(1);
    d.advance(2100); // past ASK_MS, and past the 2 s between looks
    await d.press();
    expect(d.sent()).toEqual([{ type: "sk-af-cand" }, { type: "sk-af-cand" }]);
    await d.reply(0, { show: false }); // the first, late: none (were it kept, this page would never show it)
    expect(d.asks()).toEqual(["cand", "cand", "late"]);
    await d.reply(1, { show: true, key: "" });
    expect(d.shown()).toBe(true);
  });
  it("an answer within ASK_MS is taken", async () => {
    const d = await mount();
    await d.press();
    d.advance(ASK_MS - 1);
    await d.reply(0, { show: true, key: "" });
    expect(d.shown()).toBe(true);
    expect(d.asks()).toEqual(["cand", "show"]);
  });
  it("an answer just after ASK_MS is not", async () => {
    const d = await mount();
    await d.press();
    d.advance(ASK_MS + 1);
    await d.reply(0, { show: true, key: "" });
    expect(d.shown()).toBe(false);
    expect(d.asks()).toEqual(["cand", "late"]);
  });
});

describe("S-2: the frame loop's cost", () => {
  it("the box's direction is read once, when it shows, not in its frames", async () => {
    const d = await mount();
    await d.showIt();
    const reads = d.env.styleReads;
    expect(reads).toBe(1);
    d.frames(2000);
    expect(d.env.styleReads).toBe(reads);
  });
  it("hidden after IDLE_MS without the user's own click or key press; the frames stop; the next look shows it again", async () => {
    expect(IDLE_MS).toBe(120_000);
    const d = await mount();
    await d.showIt();
    d.frames(IDLE_MS / 2, 200);
    await d.key("a"); // the user's input: the two minutes from now
    d.frames(IDLE_MS - 400, 200);
    expect(d.shown()).toBe(true);
    d.frames(800, 200);
    expect(d.shown()).toBe(false);
    expect(d.log()).toEqual(["show", "idle"]);
    expect(d.env.raf).toHaveLength(0); // no frame asked for any more
    await d.press(); // the next look: shown again, from the answer kept
    expect(d.shown()).toBe(true);
    expect(d.sent()).toEqual([{ type: "sk-af-cand" }]);
  });
});

describe("S-2 (4B-FU2): what keeps it, and what arms it again", () => {
  it("only the user's own input keeps it: the page's own events every 30 s do not delay the idle hide", async () => {
    const d = await mount();
    await d.showIt();
    for (let i = 0; i < 6 && d.shown(); i++) {
      d.frames(30_000, 200);
      await d.event("pointerdown", { isTrusted: false });
      await d.event("keydown", { isTrusted: false, key: "1" });
    }
    expect(d.shown()).toBe(false);
    expect(d.log()).toEqual(["show", "idle"]);
  });
  it("…and the user's own every 30 s does keep it, past IDLE_MS", async () => {
    const d = await mount();
    await d.showIt();
    for (let i = 0; i < 6; i++) {
      d.frames(30_000, 200);
      await d.key("1");
    }
    expect(d.env.t - 1000).toBeGreaterThan(IDLE_MS);
    expect(d.shown()).toBe(true);
  });
  it("re-shown from the kept answer within 100 ms, at a moved place: armed only 800 ms after it is seen whole again", async () => {
    const d = await mount();
    await d.showIt();
    d.frames(ARM_MS + 50);
    expect(d.armed()).toBe(true);
    await d.press(d.doc.body); // elsewhere: hidden
    d.advance(50);
    d.box.rect = { ...d.box.rect, y: d.box.rect.y + 60 }; // the box moved meanwhile
    await d.press(); // back in the box, 50 ms later: shown at once, from the answer kept (N-2's path)
    expect(d.shown()).toBe(true);
    d.frames(32);
    expect(d.armed()).toBe(false); // its clock went with the hide
    d.seen(true); // IntersectionObserver sees it whole, at its new place
    d.frames(ARM_MS - 100);
    await d.clickPill();
    expect(d.log().at(-1)).toBe("refused:early");
    d.frames(150);
    expect(d.armed()).toBe(true);
  });
});

describe("S-3: a refused click explains itself (warn, do not block)", () => {
  it("too early: the button says to wait for CUE_MS, then its words again; the click changes nothing else", async () => {
    expect(CUE_MS).toBe(3000);
    const d = await mount();
    await d.showIt();
    d.frames(300);
    await d.clickPill();
    expect(d.log().at(-1)).toBe("refused:early");
    expect(d.pill().textContent).toBe(WAIT);
    d.frames(CUE_MS - 100);
    expect(d.pill().textContent).toBe(WAIT);
    d.frames(200);
    expect(d.pill().textContent).toBe(LABEL);
    expect(d.shown()).toBe(true);
    await d.clickPill(); // armed by now
    expect(d.log().at(-1)).toBe("open");
  });
  it("on a page that held its rendering (stale): the same cue", async () => {
    const d = await mount();
    await d.showIt();
    d.frames(ARM_MS + 50);
    expect(d.armed()).toBe(true);
    d.advance(400); // no frame for 400 ms
    await d.clickPill();
    expect(d.log().at(-1)).toBe("refused:stale");
    expect(d.pill().textContent).toBe(WAIT);
  });
  it("hidden while it says to wait: shown again with its own words", async () => {
    const d = await mount();
    await d.showIt();
    d.frames(300);
    await d.clickPill();
    expect(d.pill().textContent).toBe(WAIT);
    await d.press(d.doc.body);
    await d.press();
    expect(d.shown()).toBe(true);
    expect(d.pill().textContent).toBe(LABEL);
  });
  it("refused for any other reason: no cue (covered: nothing to read; used: gone)", async () => {
    const d = await mount();
    await d.showIt();
    d.frames(ARM_MS + 50);
    await d.clickPill({ isTrusted: false }); // not the user's (a page cannot reach the button; the order is pinned anyway)
    expect(d.log().at(-1)).toBe("refused:untrusted");
    expect(d.pill().textContent).toBe(LABEL);
    d.pending(false); // covered, not reported yet
    await d.clickPill();
    expect(d.log().at(-1)).toBe("refused:hidden");
    expect(d.pill().textContent).toBe(LABEL);
  });
  it("the live region says the cue, then its own line again", async () => {
    const d = await mount();
    await d.showIt();
    const own = d.live();
    expect(own).toBe("Sixkey can fill the code here: press Alt+Shift+F");
    d.frames(300);
    await d.clickPill();
    expect(d.live()).toBe(WAIT);
    d.frames(CUE_MS + 100);
    expect(d.live()).toBe(own);
  });
  it("right to left: the cue's other width neither moves it nor restarts its clock", async () => {
    const d = await mount();
    d.box.dirStyle = "rtl";
    await d.showIt();
    d.frames(300);
    await d.clickPill(); // early: the cue, words of another length
    expect(d.pill().textContent).toBe(WAIT);
    d.frames(ARM_MS - 300 + 50); // 850 ms after it was first seen whole
    expect(d.armed()).toBe(true);
    d.frames(CUE_MS); // the cue ends: its own words, and the place it had
    expect(d.pill().textContent).toBe(LABEL);
    expect(d.armed()).toBe(true);
  });
});

describe("4B-FU3: the second refused click in a row says what works (the shortcut), until it arms or hides", () => {
  const LINE = "Sixkey can fill the code here: press Alt+Shift+F";
  it("early twice: first a moment, then the shortcut's line, which stays (past CUE_MS) until it arms", async () => {
    const d = await mount();
    await d.showIt();
    d.frames(200);
    await d.clickPill();
    expect(d.log().at(-1)).toBe("refused:early");
    expect(d.pill().textContent).toBe(WAIT);
    d.frames(100);
    await d.clickPill();
    expect(d.log().at(-1)).toBe("refused:early");
    expect(d.pill().textContent).toBe(LINE);
    expect(d.live()).toBe(LINE);
    // a page that keeps it from arming (its clock restarted every half second): the line stays, past CUE_MS
    for (let i = 0; i < 10; i++) {
      d.fire("fullscreenchange", d.doc);
      d.frames(500);
    }
    expect(d.armed()).toBe(false);
    expect(d.pill().textContent).toBe(LINE);
    d.frames(ARM_MS + 50); // left alone: it arms, and has its own words again
    expect(d.armed()).toBe(true);
    expect(d.pill().textContent).toBe(LABEL);
    expect(d.live()).toBe(LINE); // (the live region's line is the shortcut's line: afCanFill)
  });
  it("after it armed, the next refusal (stale) says a moment again", async () => {
    const d = await mount();
    await d.showIt();
    d.frames(200);
    await d.clickPill();
    d.frames(100);
    await d.clickPill();
    expect(d.pill().textContent).toBe(LINE);
    d.frames(ARM_MS);
    expect(d.armed()).toBe(true);
    d.advance(400); // no frame for 400 ms
    await d.clickPill();
    expect(d.log().at(-1)).toBe("refused:stale");
    expect(d.pill().textContent).toBe(WAIT);
  });
  it("a hide starts the row again", async () => {
    const d = await mount();
    await d.showIt();
    d.frames(200);
    await d.clickPill();
    expect(d.pill().textContent).toBe(WAIT);
    await d.press(d.doc.body); // hidden
    await d.press(); // shown again (N-2's path), not armed
    d.seen(true);
    d.frames(200);
    await d.clickPill();
    expect(d.log().at(-1)).toBe("refused:early");
    expect(d.pill().textContent).toBe(WAIT);
  });
  it("another reason between two breaks the row", async () => {
    const d = await mount();
    await d.showIt();
    d.frames(200);
    await d.clickPill();
    expect(d.pill().textContent).toBe(WAIT);
    d.pending(false);
    await d.clickPill();
    expect(d.log().at(-1)).toBe("refused:hidden");
    d.seen(true);
    d.frames(100);
    await d.clickPill();
    expect(d.log().at(-1)).toBe("refused:early");
    expect(d.pill().textContent).toBe(WAIT);
  });
  it("with no shortcut set: the line says to open Sixkey", async () => {
    const d = await mount();
    await d.press();
    await d.reply(0, { show: true, key: "" });
    d.seen(true);
    d.frames(200);
    await d.clickPill();
    d.frames(100);
    await d.clickPill();
    expect(d.pill().textContent).toBe("Sixkey can fill the code here: open Sixkey");
  });
});

describe("4B-FU3-r2: the review's C-M1 (the line ends when it arms, whatever came between) and C-N2 (no wider then)", () => {
  const LINE = "Sixkey can fill the code here: press Alt+Shift+F";
  it("early, early (the line), refused for another reason, then it arms: its own words again (C-M1)", async () => {
    const d = await mount();
    await d.showIt();
    d.frames(200);
    await d.clickPill();
    d.frames(100);
    await d.clickPill();
    expect(d.pill().textContent).toBe(LINE);
    d.pending(false); // covered, not reported yet
    await d.clickPill();
    expect(d.log().at(-1)).toBe("refused:hidden");
    d.seen(true);
    d.frames(ARM_MS + 50);
    expect(d.armed()).toBe(true);
    expect(d.pill().textContent).toBe(LABEL);
    expect(d.live()).toBe(LINE); // the live region's own line (afCanFill)
  });
  it("…and an early click after that other reason starts a new row: a moment, not the line", async () => {
    const d = await mount();
    await d.showIt();
    d.frames(200);
    await d.clickPill();
    d.frames(100);
    await d.clickPill();
    d.pending(false);
    await d.clickPill();
    d.seen(true);
    d.frames(100);
    await d.clickPill();
    expect(d.log().at(-1)).toBe("refused:early");
    expect(d.pill().textContent).toBe(WAIT);
  });
  it("a cue narrower than its own words (a moment, on x.test): held at their width, so their return cannot widen it", async () => {
    const d = await mount();
    await d.showIt();
    d.frames(200);
    const own = d.width();
    expect(8 * WAIT.length + 30).toBeLessThan(own); // the cue's own width would be the narrower
    await d.clickPill();
    expect(d.pill().textContent).toBe(WAIT);
    expect(d.width()).toBe(own);
    d.frames(ARM_MS); // armed while it still says to wait
    expect(d.armed()).toBe(true);
    expect(d.pill().textContent).toBe(WAIT);
    for (let i = 0; i < 200 && d.pill().textContent !== LABEL; i++) {
      d.frames(16);
      expect(d.width()).toBe(own);
    }
    expect(d.pill().textContent).toBe(LABEL);
    expect(d.width()).toBe(own);
    expect(d.sheets().join("")).not.toMatch(/#p\{min-width:/); // the hold went with the cue's words
    await d.clickPill(); // armed all along: its words back, at once clickable, and no clock restarted by them
    expect(d.log().at(-1)).toBe("open");
  });
  it("the shortcut's line narrower than its own words (a long host): never wider, frame by frame, through the arming", async () => {
    const host = "sign-in.accounts.example-bank.test";
    const d = await mount();
    (globalThis as unknown as { location: { hostname: string } }).location.hostname = host; // before it is built
    await d.showIt();
    d.frames(200);
    const own = d.width();
    expect(8 * LINE.length + 30).toBeLessThan(own);
    await d.clickPill();
    d.frames(100);
    await d.clickPill();
    expect(d.pill().textContent).toBe(LINE);
    expect(d.width()).toBe(own);
    let w = d.width();
    let armedAt = -1;
    for (let i = 0; i < 60; i++) {
      d.frames(16);
      if (armedAt < 0 && d.armed()) armedAt = i;
      expect(d.width()).toBeLessThanOrEqual(w);
      w = d.width();
    }
    expect(armedAt).toBeGreaterThan(0);
    expect(d.pill().textContent).toBe(`Fill code with Sixkey · ${host}`);
    expect(d.width()).toBe(own);
  });
});

describe("4B-FU4 (the review's P-M1): another code box while it is shown is a new showing", () => {
  const LINE = "Sixkey can fill the code here: press Alt+Shift+F";
  const B = { x: 100, y: 400, width: 200, height: 30 };
  it("a key in box B while armed under A: moved there, not armed until IntersectionObserver's first report at B and 800 ms", async () => {
    const d = await mount();
    await d.showIt();
    d.frames(ARM_MS + 50);
    expect(d.armed()).toBe(true);
    d.frames(2100); // past the 2 s between looks
    d.box2.rect = B;
    d.ioFresh();
    await d.event("keydown", { target: d.box2, key: "1" });
    expect(d.log().at(-1)).toBe("show");
    expect(d.armed()).toBe(false);
    d.frames(16);
    expect(d.armed()).toBe(false);
    await d.clickPill(); // at once: not seen at B yet
    expect(d.log().at(-1)).toBe("refused:hidden");
    expect(d.ioFresh()).toEqual([d.pill()]); // observed afresh: IntersectionObserver reports it at B
    expect(d.report(true)).toBe(true);
    d.frames(ARM_MS - 50);
    expect(d.armed()).toBe(false);
    await d.clickPill();
    expect(d.log().at(-1)).toBe("refused:early");
    d.frames(100);
    expect(d.armed()).toBe(true);
  });
  it("a click into box B (hidden and shown again in one task): reported afresh, so it arms there", async () => {
    const d = await mount();
    await d.showIt();
    d.frames(ARM_MS + 50);
    d.frames(2100);
    d.box2.rect = B;
    await d.press(d.box2);
    expect(d.shown()).toBe(true);
    expect(d.log().at(-1)).toBe("show");
    expect(d.armed()).toBe(false);
    // nothing changed for IntersectionObserver between the hide and the show: only a target observed afresh is reported
    expect(d.report(true)).toBe(true);
    d.frames(ARM_MS + 50);
    expect(d.armed()).toBe(true);
    await d.clickPill();
    expect(d.log().at(-1)).toBe("open");
  });
  it("five switches between the boxes, by key and by click: one frame loop", async () => {
    const d = await mount();
    await d.showIt();
    d.frames(ARM_MS + 50);
    d.box2.rect = B;
    for (let i = 0; i < 5; i++) {
      d.frames(2100);
      const to = i % 2 ? d.box : d.box2;
      if (i < 3) await d.event("keydown", { target: to, key: "1" });
      else await d.press(to);
      expect(d.shown()).toBe(true);
      expect(d.log().at(-1)).toBe("show");
      d.frames(16); // an older loop's frame, if any: it stops there
      expect(d.env.raf.length).toBe(1);
    }
  });
  it("moved to box B with the shortcut's line up: its own words there, and a row of its own (a moment first)", async () => {
    const d = await mount();
    await d.showIt();
    d.frames(200);
    await d.clickPill();
    d.frames(100);
    await d.clickPill();
    expect(d.pill().textContent).toBe(LINE);
    for (let i = 0; i < 5; i++) {
      d.fire("fullscreenchange", d.doc); // kept from arming, past the 2 s between looks
      d.frames(500);
    }
    expect(d.pill().textContent).toBe(LINE);
    d.box2.rect = B;
    await d.event("keydown", { target: d.box2, key: "1" });
    expect(d.log().at(-1)).toBe("show");
    expect(d.pill().textContent).toBe(LABEL);
    expect(d.width()).toBe(8 * LABEL.length + 30); // and no hold left from the line
    expect(d.report(true)).toBe(true);
    d.frames(200);
    await d.clickPill();
    expect(d.log().at(-1)).toBe("refused:early");
    expect(d.pill().textContent).toBe(WAIT);
  });
});
