import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  clampHlc,
  createClock,
  formatHlc,
  isHlc,
  newDeviceId,
  parseHlc,
  MAX_FUTURE_DRIFT_MS,
} from "../../src/core/vault/hlc";
import { isOrderKey, orderBetween } from "../../src/core/vault/fractional";

describe("hlc", () => {
  it("formats to a fixed width that sorts like time", () => {
    const a = formatHlc(1_700_000_000_000, 0, "aaaa");
    const b = formatHlc(1_700_000_000_000, 1, "aaaa");
    const c = formatHlc(1_700_000_000_001, 0, "aaaa");
    const d = formatHlc(1_700_000_000_000, 0, "bbbb");
    expect([c, d, b, a].sort()).toEqual([a, d, b, c].sort());
    expect(a < b && b < c && a < d && d < b).toBe(true); // counter outranks device id
    for (const h of [a, b, c, d]) expect(isHlc(h)).toBe(true);
    expect(parseHlc(b)).toEqual({ wall: 1_700_000_000_000, counter: 1, device: "aaaa" });
  });
  it("rejects malformed timestamps", () => {
    for (const bad of [
      "",
      "x",
      "1700000000000.0000.aaaa ",
      "170000000000.0000.aaaa",
      "1700000000000.00000.aaaa",
      "1700000000000.0000.AAAA",
      "1700000000000.0000.abc",
      5,
      null,
    ]) {
      expect(isHlc(bad)).toBe(false);
    }
    expect(() => formatHlc(1, 0, "A")).toThrow(RangeError);
  });
  it("next() is strictly increasing, even when the wall clock stalls or goes backwards", () => {
    let t = 1_700_000_000_000;
    const c = createClock("aaaa", { now: () => t });
    const seen = [c.next(), c.next()];
    t -= 5000;
    seen.push(c.next(), c.next());
    t += 10_000;
    seen.push(c.next());
    expect([...seen].sort()).toEqual(seen);
    expect(new Set(seen).size).toBe(seen.length);
  });
  it("resumes after a restart from the last stamp", () => {
    const c1 = createClock("aaaa", { now: () => 1_700_000_000_000 });
    c1.next();
    const last = c1.next();
    const c2 = createClock("aaaa", { now: () => 1_699_999_999_000, last });
    expect(c2.next() > last).toBe(true);
  });
  it("observe() moves the clock past a remote stamp", () => {
    const remote = formatHlc(1_700_000_005_000, 7, "bbbb");
    const c = createClock("aaaa", { now: () => 1_700_000_000_000 });
    c.observe(remote);
    expect(c.next() > remote).toBe(true);
  });
  it("a remote clock far in the future cannot push ours beyond now + 24h", () => {
    const now = 1_700_000_000_000;
    const c = createClock("aaaa", { now: () => now });
    c.observe(formatHlc(now + 400 * 86_400_000, 0, "bbbb"));
    expect(parseHlc(c.next())!.wall).toBeLessThanOrEqual(now + MAX_FUTURE_DRIFT_MS + 1);
    const clamped = clampHlc(formatHlc(now + 400 * 86_400_000, 3, "bbbb"), now);
    expect(parseHlc(clamped)).toEqual({ wall: now + MAX_FUTURE_DRIFT_MS, counter: 3, device: "bbbb" });
    expect(clampHlc(formatHlc(now, 0, "bbbb"), now)).toBe(formatHlc(now, 0, "bbbb"));
  });
  it("counter overflow rolls into the next millisecond", () => {
    const c = createClock("aaaa", { now: () => 1_700_000_000_000, last: formatHlc(1_700_000_000_000, 0xfffe, "aaaa") });
    const a = c.next();
    const b = c.next();
    expect(b > a).toBe(true);
    expect(parseHlc(b)!.wall).toBe(1_700_000_000_001);
  });
  it("device ids are valid", () => {
    expect(newDeviceId()).toMatch(/^[a-z0-9]{8}$/);
  });
});

describe("fractional order keys", () => {
  it("first key and neighbours", () => {
    const first = orderBetween(null, null);
    expect(isOrderKey(first)).toBe(true);
    expect(orderBetween(first, null) > first).toBe(true);
    expect(orderBetween(null, first) < first).toBe(true);
  });
  it("always lands strictly between, over random insertions", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(1000), { minLength: 1, maxLength: 120 }), (positions) => {
        const list: string[] = [];
        for (const p of positions) {
          const i = p % (list.length + 1);
          const k = orderBetween(list[i - 1] ?? null, list[i] ?? null);
          expect(isOrderKey(k)).toBe(true);
          if (i > 0) expect(list[i - 1]! < k).toBe(true);
          if (i < list.length) expect(k < list[i]!).toBe(true);
          list.splice(i, 0, k);
        }
        expect([...list].sort()).toEqual(list);
      }),
      { numRuns: 200 },
    );
  });
  it("refuses bad ranges and keys", () => {
    const a = orderBetween(null, null);
    expect(() => orderBetween(a, a)).toThrow(RangeError);
    expect(() => orderBetween("b", "a")).toThrow(RangeError);
    expect(() => orderBetween("a0", null)).toThrow(RangeError);
    expect(() => orderBetween("", null)).toThrow(RangeError);
  });
  it("repeated appends grow slowly", () => {
    let k: string | null = null;
    for (let i = 0; i < 100; i++) k = orderBetween(k, null);
    expect(k!.length).toBeLessThan(32);
  });
});
