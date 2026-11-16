// PHASE0X-PLAN B1: the popup works out the first screen's codes first, ticks once a second just after the second
// turns, and draws the countdown ring without animation (so reduced motion needs no second code path).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Entry } from "../../src/core/vault/model";
import { ringFill } from "../../src/ui/art";
import { FIRST_SCREEN, msToNextSecond, planCodes } from "../../src/ui/hooks";

const T = 1_759_999_990_000; // a fixed instant, 10 s into a 30 s period and into a 60 s one
const counter = (ms: number, period = 30) => Math.floor(ms / 1000 / period);
function entries(k: number, over: Partial<Entry> = {}): Entry[] {
  return Array.from(
    { length: k },
    (_, i) =>
      ({
        id: `e${i}`,
        type: "totp",
        issuer: `A${i}`,
        label: "",
        secret: "JBSWY3DPEHPK3PXP",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        ...over,
      }) as Entry,
  );
}
const ids = (es: Entry[]) => es.map((e) => e.id);
const key = (e: Entry) => e.id + e.secret;
const none = new Map<string, number>();

describe("first screen first: planCodes", () => {
  it("splits uncomputed codes into the first screen and the rest, keeping display order", () => {
    const es = entries(40);
    const { first, rest } = planCodes(es, T, none, none, none);
    expect(FIRST_SCREEN).toBe(16);
    expect(ids(first)).toEqual(ids(es.slice(0, 16)));
    expect(ids(rest)).toEqual(ids(es.slice(16)));
  });

  it("skips entries that cannot make a code (counter-based, purged)", () => {
    const es = [
      ...entries(2),
      { ...entries(1)[0]!, id: "h", type: "hotp" } as Entry,
      { ...entries(1)[0]!, id: "p", secret: "" } as Entry,
    ];
    const { first, rest } = planCodes(es, T, none, none, none);
    expect(ids(first)).toEqual(["e0", "e1"]);
    expect(rest).toEqual([]);
  });

  it("asks for nothing while every code on screen is for the current period, and for everything when the period turns", () => {
    const es = entries(20);
    const shown = new Map(es.map((e) => [key(e), counter(T)]));
    expect(planCodes(es, T, shown, shown, shown)).toEqual({ first: [], rest: [] });
    const next = planCodes(es, T + 20_000, shown, shown, shown); // 30 s into the period: the next one
    expect(ids(next.first)).toHaveLength(16);
    expect(ids(next.rest)).toHaveLength(4);
  });

  it("an account that moves up into the first screen after being queued with the rest is asked for again at once", () => {
    const es = entries(40);
    const asked = new Map(es.map((e) => [key(e), counter(T)]));
    const askedFirst = new Map(es.slice(0, 16).map((e) => [key(e), counter(T)]));
    // the current site turned out to be e30: it now leads the list, its code not yet back
    const reordered = [es[30]!, ...es.filter((e) => e.id !== "e30")];
    const { first, rest } = planCodes(reordered, T, none, asked, askedFirst);
    expect(ids(first)).toEqual(["e30"]);
    expect(rest).toEqual([]); // nothing queued twice
  });

  it("a code already on its way in a first batch is not asked for again", () => {
    const es = entries(3);
    const asked = new Map(es.map((e) => [key(e), counter(T)]));
    expect(planCodes(es, T, none, asked, asked)).toEqual({ first: [], rest: [] });
  });

  it("each account's own period decides when its code is due", () => {
    const es = [...entries(1), ...entries(1, { id: "sixty", period: 60 })];
    const shown = new Map([
      [key(es[0]!), counter(T)],
      [key(es[1]!), counter(T, 60)],
    ]);
    const at = T + 25_000; // the 30 s period has turned; the 60 s one (started at T - 10 s) has not
    expect(ids(planCodes(es, at, shown, shown, shown).first)).toEqual(["e0"]);
  });

  it("an edited secret counts as a different code", () => {
    const [e] = entries(1);
    const shown = new Map([[key(e!), counter(T)]]);
    const changed = { ...e!, secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" };
    expect(ids(planCodes([changed], T, shown, shown, shown).first)).toEqual(["e0"]);
  });
});

describe("the once-a-second clock", () => {
  it("fires just after the next whole second, never before it", () => {
    expect(msToNextSecond(5_000)).toBe(1010);
    expect(msToNextSecond(5_001)).toBe(1009);
    expect(msToNextSecond(5_999)).toBe(11);
    for (const now of [T, T + 1, T + 499, T + 990, T + 999]) {
      const at = now + msToNextSecond(now);
      expect(Math.floor(at / 1000)).toBe(Math.floor(now / 1000) + 1);
      expect(at % 1000).toBe(10);
    }
  });
});

describe("countdown ring", () => {
  // The drawing before PHASE0X-PLAN B1, kept here as the reference the six segments must still match.
  const SEGS = Array.from({ length: 6 }, (_, i) => [i * 60 + 4.5, (i + 1) * 60 - 4.5] as const);
  const reference = (rem: number, period: number) => {
    const gone = (1 - Math.max(0, Math.min(period, rem)) / period) * 360;
    return SEGS.map(([a0, a1]) => Math.max(0, Math.min(1, (a1 - Math.max(a0, gone)) / (a1 - a0))));
  };

  it("is full at the start of a period, empty at the end, and matches the previous drawing in between", () => {
    expect(ringFill(30, 30)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(ringFill(0, 30)).toEqual([0, 0, 0, 0, 0, 0]);
    for (const period of [30, 60, 15])
      for (let rem = 0; rem <= period; rem += 0.25) expect(ringFill(rem, period)).toEqual(reference(rem, period));
  });

  it("drains one segment at a time, in order, and never fills back up during a period", () => {
    let prev = ringFill(30, 30);
    for (let rem = 29.9; rem >= 0; rem -= 0.1) {
      const f = ringFill(rem, 30);
      f.forEach((v, i) => expect(v).toBeLessThanOrEqual(prev[i]! + 1e-12));
      expect(f.filter((v) => v > 0 && v < 1).length).toBeLessThanOrEqual(1);
      prev = f;
    }
    // mid-period: the first three sixths are gone, the last three are full
    expect(ringFill(15, 30).slice(3)).toEqual([1, 1, 1]);
    expect(ringFill(15, 30).slice(0, 3)).toEqual([0, 0, 0]);
  });

  it("the last five seconds of a 30 s period are the red segment, and only it is left", () => {
    const f = ringFill(5, 30);
    expect(f.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(f[5]).toBeGreaterThan(0.9);
  });

  it("reduced motion shows the same ring: nothing on the ring's segments is animated or transitioned", () => {
    // The global prefers-reduced-motion rule shortens every animation and transition to 0.001 ms. A ring drawn by an
    // animation would then jump straight to "empty"; one drawn statically (redrawn once a second) is unaffected.
    const css = readFileSync(join(__dirname, "../../src/ui/styles.css"), "utf8");
    const rules = [...css.matchAll(/([^{}]*\.ring[^{}]*)\{([^}]*)\}/g)].map((m) => ({
      sel: m[1]!.trim(),
      body: m[2]!,
    }));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r.body, r.sel).not.toMatch(/animation|stroke-dashoffset/);
      const transition = /transition\s*:([^;]*)/.exec(r.body)?.[1] ?? "";
      expect(transition, r.sel).not.toMatch(/dash|all/);
    }
    const popup = readFileSync(join(__dirname, "../../src/popup/popup.css"), "utf8");
    for (const m of popup.matchAll(/([^{}]*\.fil[^{}]*)\{([^}]*)\}/g))
      expect(m[2], m[1]).not.toMatch(/animation|transition|stroke-dashoffset/);
  });
});
