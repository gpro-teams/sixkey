// TOTP autofill Stage 2, patch 3: the tab in front, at every fill (P1-VERIFY item 4, AUTOFILL2-PLAN-REVIEW M2 and M6;
// docs/design/notes/AUTOFILL2-NOTES.md §9). Right before the one call that carries the code, platform/autofill.ts fillCand
// asks whether the tab is the active tab of the focused window (inFront), and fills nothing otherwise, whoever started the
// fill (the popup's Fill, the side panel's, the shortcut, a resumed pending request). The page side of the same rule, the
// document on screen, is inject/otp.ts fill's own check (autofill-engine.spec.ts). Headless Chromium reports every
// window focused, so this rule is held here, over stand-ins; the owner's checklist has the real windows.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fillCand, inFront, type Cand } from "../../src/platform/autofill";
import type { Entry } from "../../src/core/vault/model";
import { TEST_CODE } from "../helpers/gate";

const entry = {
  id: "e1",
  createdAt: 0,
  type: "totp",
  issuer: "Example",
  label: "alice",
  secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  algorithm: "SHA1",
  digits: 6,
  period: 30,
  domains: ["example.com"],
  hlc: "",
  order: "a",
  phlc: "",
} as unknown as Entry;
const cand: Cand = {
  frameId: 0,
  documentId: "DOC",
  origin: "https://example.com",
  top: "https://example.com",
  domain: "example.com",
  found: { t: "feedfacefeedface", k: 0, n: 6, s: 70, sent: false, weak: false, lab: "" },
};
const NOW = Math.floor(1_700_000_000_000 / 30_000) * 30_000 + 10_000; // 20 s left: no wait

function browser(o: { active?: boolean; focused?: boolean; tabsThrow?: boolean; windowsThrow?: boolean } = {}) {
  const fills: unknown[] = [];
  vi.stubGlobal("chrome", {
    storage: { local: { setAccessLevel: async () => undefined }, session: { setAccessLevel: async () => undefined } },
    tabs: {
      get: async (id: number) => {
        if (o.tabsThrow) throw new Error("No tab with id");
        return { id, active: o.active ?? true, windowId: 5 };
      },
    },
    windows: {
      get: async (id: number) => {
        if (o.windowsThrow) throw new Error("No window with id");
        return { id, focused: o.focused ?? true };
      },
    },
    scripting: {
      executeScript: vi.fn(async (c: unknown) => {
        fills.push(c);
        return [{ result: { ok: true, how: "single" } }];
      }),
    },
  });
  return fills;
}
afterEach(() => vi.unstubAllGlobals());

describe("inFront: the active tab of the focused window, from the browser", () => {
  it("both, and only both; a failure to ask is a no", async () => {
    browser();
    expect(await inFront(3)).toBe(true);
    browser({ active: false });
    expect(await inFront(3)).toBe(false);
    browser({ focused: false });
    expect(await inFront(3)).toBe(false);
    browser({ tabsThrow: true });
    expect(await inFront(3)).toBe(false);
    browser({ windowsThrow: true });
    expect(await inFront(3)).toBe(false);
    vi.stubGlobal("chrome", {});
    expect(await inFront(3)).toBe(false);
  });
});

describe("fillCand: no code goes into a tab the user is not looking at", () => {
  for (const [what, o] of [
    ["a tab behind another in its window", { active: false }],
    ["a window that is not focused", { focused: false }],
    ["a tab the browser no longer has", { tabsThrow: true }],
  ] as const)
    it(`${what}: not filled, and the code call is never made`, async () => {
      const fills = browser(o);
      const r = await fillCand(3, entry, cand, { now: () => NOW, code: async () => ({ code: "654321" }) });
      expect(r).toEqual({ k: "failed", r: "tab" });
      expect(fills).toEqual([]);
    });

  it("in front of a focused window: filled", async () => {
    const fills = browser();
    expect(await fillCand(3, entry, cand, { now: () => NOW, code: async () => ({ code: "654321" }) })).toEqual({
      k: "filled",
      how: "single",
    });
    expect(fills).toHaveLength(1);
  });

  it("asked after the wait for the next code, right before the call: a window left during the wait gets nothing", async () => {
    const fills = browser();
    let focused = true;
    vi.stubGlobal("chrome", {
      ...(globalThis as unknown as { chrome: object }).chrome,
      windows: { get: async () => ({ focused }) },
    });
    const r = await fillCand(3, entry, cand, {
      now: () => NOW + 17_000, // 3 s left: the next code is waited for
      sleep: async () => void (focused = false),
      code: async () => ({ code: "654321" }),
    });
    expect(r).toEqual({ k: "failed", r: "tab" });
    expect(fills).toEqual([]);
  });

  it("a stand-in answer is used where one is given (the tests' seam), and its no is a no", async () => {
    const fills = browser();
    expect(await fillCand(3, entry, cand, { now: () => NOW, front: async () => false, code: TEST_CODE })).toEqual({
      k: "failed",
      r: "tab",
    });
    expect(fills).toEqual([]);
  });
});
