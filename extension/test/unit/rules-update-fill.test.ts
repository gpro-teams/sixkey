// The Fill paths with the site rules' updater (TOTP autofill Stage 3, AF3-U2; docs/design/notes/AUTOFILL3-NOTES.md §10):
// platform/site-rule.ts ruleForPage asks the worker for the live bundle's rule (`sk-af-rule`) while it reads the package,
// in a build whose updater's gate is open (the define, stubbed here), and takes:
//   - a live answer with a rule: that rule (and the package's is not used);
//   - a live answer with none: no rule, though the package has one (the live bundle replaces the built-in rules whole:
//     the plan's R4-1, the maintainers' C24/C33);
//   - no live bundle (null), no answer within ASK_MS, no answer at all, an answer of another shape: the package's rule;
// and the appends always from the package's baseline (AF3-5's review, NIT-2: appendsOn is given the package's alone).
// With the gate closed, nothing is sent. The worker's side of the message is test/unit/rules-update-worker.test.ts's.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBaseline } from "../../src/core/rules/baseline";
import { e2eBaselineText } from "../../scripts/rules-package.mjs";

const EXT = resolve(import.meta.dirname, "../..");
const COMMITTED = readFileSync(resolve(EXT, "../rules/build/baseline.json"), "utf8");
async function e2eBundle() {
  const r = parseBaseline(await e2eBaselineText(COMMITTED), { allowReserved: true });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock("../../src/platform/package-data");
});

/** ruleForPage with the gate as given, the package's read giving the e2e build's bundle, and the worker's answer. */
async function withWorker(answer: (msg: unknown) => Promise<unknown>, gate: boolean | "none" = true) {
  const bundle = await e2eBundle();
  const readRules = vi.fn(async () => bundle);
  vi.doMock("../../src/platform/package-data", () => ({ readRules }));
  if (gate !== "none") vi.stubGlobal("__RULES_UPDATE__", gate);
  const sendMessage = vi.fn(answer);
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  const m = await import("../../src/platform/site-rule");
  return { ...m, readRules, sendMessage };
}
const LIVE_RULE = {
  id: "live",
  host: "rules.fix.test",
  from: "live",
  rule: { pages: [{ path: "/live/", field: "#live-box", segments: 0, fill: "paste" }], sent: true, minLeft: 12 },
};
const PACKAGE_HINT = { d: ["rules.fix.test"], p: [{ at: "/rule/", sel: "#code-box", n: 0, how: 0 }], sent: false };

describe("ruleForPage with the updater's gate open", () => {
  it("asks the worker for the page's host (exactly as hostOf writes it), while it reads the package", async () => {
    let answer!: (a: unknown) => void;
    const w = await withWorker(() => new Promise((r) => (answer = r)));
    const p = w.ruleForPage("https://RULES.fix.test./rule/one");
    await vi.waitFor(() => expect(w.readRules).toHaveBeenCalledTimes(1)); // read while the worker has not answered yet
    expect(w.sendMessage).toHaveBeenCalledTimes(1);
    expect(w.sendMessage).toHaveBeenCalledWith({ type: "sk-af-rule", host: "rules.fix.test" });
    answer(null);
    expect((await p).hint).toEqual(PACKAGE_HINT);
  });
  it("a live bundle with a rule for the host: that rule's hint and minLeft, not the package's", async () => {
    const w = await withWorker(async () => ({ v: 2, rule: LIVE_RULE }));
    expect(await w.ruleForPage("http://rules.fix.test/rule/one")).toEqual({
      hint: { d: ["rules.fix.test"], p: [{ at: "/live/", sel: "#live-box", n: 0, how: 2 }], sent: true },
      minLeft: 12,
      appends: false,
    });
  });
  it("C24: a live bundle with no rule for the host gives no rule, though the package has one", async () => {
    const w = await withWorker(async () => ({ v: 2, rule: null }));
    expect(await w.ruleForPage("http://rules.fix.test/rule/one")).toEqual(w.NO_RULE);
    expect(await w.ruleForPage("http://rules2.fix.test/rule/six")).toEqual(w.NO_RULE);
  });
  it("no live bundle in use (null): the package's rule", async () => {
    const w = await withWorker(async () => null);
    expect((await w.ruleForPage("http://rules.fix.test/rule/one")).hint).toEqual(PACKAGE_HINT);
  });
  it("no answer within ASK_MS (1 s): the package's rule, and a later answer changes nothing", async () => {
    vi.useFakeTimers();
    let late!: (a: unknown) => void;
    const w = await withWorker(() => new Promise((r) => (late = r)));
    expect(w.ASK_MS).toBe(1000);
    const p = w.ruleForPage("http://rules.fix.test/rule/one");
    await vi.advanceTimersByTimeAsync(999);
    let done = false;
    void p.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).hint).toEqual(PACKAGE_HINT);
    late({ v: 2, rule: null });
    await vi.advanceTimersByTimeAsync(10);
    expect((await p).hint).toEqual(PACKAGE_HINT);
  });
  it("no answer at all (no listener: the message rejects), or an answer of another shape: the package's rule", async () => {
    for (const answer of [
      () => Promise.reject(new Error("Could not establish connection. Receiving end does not exist.")),
      async () => undefined,
      async () => ({ v: "2", rule: null }),
      async () => ({ rule: null }),
      async () => ({ v: 2 }),
      async () => "x",
      async () => 7,
    ]) {
      const w = await withWorker(answer);
      expect((await w.ruleForPage("http://rules.fix.test/rule/one")).hint, String(answer)).toEqual(PACKAGE_HINT);
      vi.resetModules();
    }
  });
  it("a message that throws at once (a context the extension's update invalidated): the package's rule and appends, nothing left waiting (the review's N4)", async () => {
    vi.useFakeTimers();
    const bundle = await e2eBundle();
    vi.doMock("../../src/platform/package-data", () => ({ readRules: vi.fn(async () => bundle) }));
    vi.stubGlobal("__RULES_UPDATE__", true);
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: () => {
          throw new Error("Extension context invalidated.");
        },
      },
    });
    const m = await import("../../src/platform/site-rule");
    const timers = vi.getTimerCount();
    await expect(m.askWorker("rules.fix.test")).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(timers); // its 1 s timer cleared, not left to fire
    const r = await m.ruleForPage("http://rules.fix.test/rule/one");
    expect(r.hint).toEqual(PACKAGE_HINT);
    expect((await m.ruleForPage("http://us.append.fix.test/x")).appends).toBe(true);
  });
  it("NIT-2: the appends are the package's, whatever the worker says (a live bundle has none)", async () => {
    for (const answer of [null, { v: 2, rule: null }, { v: 2, rule: { ...LIVE_RULE, host: "append.fix.test" } }]) {
      const w = await withWorker(async () => answer);
      expect((await w.ruleForPage("http://us.append.fix.test/x")).appends, JSON.stringify(answer)).toBe(true);
      expect((await w.ruleForPage("http://notappend.fix.test/x")).appends).toBe(false);
      vi.resetModules();
    }
  });
});

describe("ruleForPage with the gate closed (or no define)", () => {
  it("sends nothing, and takes the package's rule", async () => {
    for (const gate of [false, "none"] as const) {
      const w = await withWorker(async () => ({ v: 2, rule: null }), gate);
      expect((await w.ruleForPage("http://rules.fix.test/rule/one")).hint).toEqual(PACKAGE_HINT);
      expect(w.sendMessage).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});

describe("the source (platform/site-rule.ts)", () => {
  const src = readFileSync(resolve(EXT, "src/platform/site-rule.ts"), "utf8");
  it("NIT-2: appendsOn is called once, with the package's baseline (the read's result) and the host", () => {
    expect(src.match(/appendsOn\(/g)).toHaveLength(1); // the one call
    expect(src).toMatch(/const baseline = await readRules\(\);/);
    expect(src).toMatch(/appends: appendsOn\(baseline, host\)/);
  });
  it("asks only with the gate open, before the read, and takes the live answer's rule as final", () => {
    expect(src).toMatch(
      /const asked = RULES_UPDATE \? askWorker\(host\) : null;\s*const baseline = await readRules\(\);/,
    );
    expect(src).toMatch(/const found = live \? live\.rule : ruleFor\(host, inEffect\(null, baseline\)\);/);
    expect(src).toMatch(/const RULES_UPDATE = typeof __RULES_UPDATE__ === "boolean" && __RULES_UPDATE__;/);
    expect(src).not.toMatch(/indexedDB|sixkey-rules-live/); // pages never open the updater's database (S9)
  });
});
