// The site rule for a page, the finder's argument made of it, and the "code after the password" hosts
// (src/core/rules/lookup.ts; AF3-1a): exact hosts only; a live bundle's rules replace the baseline's whole, so a wrong rule
// can be taken out (the r2 recheck's R4-1); the hint names the top page's host alone (R4-6); appends cover subdomains (R4-4).
import { describe, expect, it } from "vitest";
import { canonicalHost } from "../../src/core/match";
import { isShared } from "../../src/core/site-domains";
import { validate, type Bundle } from "../../src/core/rules/format";
import { appendsOn, hintOf, inEffect, minLeftOf, ruleFor } from "../../src/core/rules/lookup";

const C = { canonicalHost, isShared };
const page = (path: string, field: string, segments = 0, fill = "auto") => ({ path, field, segments, fill });
function read(
  kind: "baseline" | "live",
  rules: object,
  hosts: object,
  appends: string[] = [],
  version?: number,
): Bundle {
  const raw = {
    format: "sixkey-rules",
    kind,
    schema: 1,
    version: version ?? (kind === "live" ? 8 : 7),
    created: "2026-11-04",
    license: kind === "baseline" && appends.length ? "AGPL-3.0-or-later AND MIT" : "AGPL-3.0-or-later",
    source: kind === "live" ? "https://example.org/sixkey/tree/rules-v8/rules" : "",
    ...(kind === "baseline"
      ? {
          upstream: appends.length
            ? [
                {
                  id: "apple-append-2fa",
                  url: "https://github.com/apple/password-manager-resources",
                  commit: "e6a7cf40fe91aa8897b1be07b0ab416332c31488",
                  path: "quirks/websites-that-append-2fa-to-password.json",
                  sha256: "0".repeat(64),
                  license: "MIT",
                },
              ]
            : [],
          aliases: [],
          appends,
        }
      : {}),
    rules,
    hosts,
  };
  const r = validate(raw, kind, C);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
const BASE = read(
  "baseline",
  {
    a: {
      pages: [page("/2fa", "input#otp"), page("/verify", "div.code > input", 6, "paste")],
      flags: ["sent"],
      minLeft: 12,
    },
    b: { pages: [page("/", 'input[name="code"]')] },
  },
  { "login.a.com": "a", "www.a.com": "a", "b.com": "b" },
  ["auth.redhat.com", "etrade.com", "usaa.com"],
);
// a live bundle that fixes a.com's rule and takes b.com's out
const LIVE = read(
  "live",
  { a2: { pages: [page("/mfa", "input.code", 8, "chars")] } },
  { "login.a.com": "a2", "www.a.com": "a2" },
);

describe("the rules in effect", () => {
  it("are the live bundle's, whole, when there is one; else the baseline's", () => {
    expect(inEffect(LIVE, BASE)).toBe(LIVE);
    expect(inEffect(null, BASE)).toBe(BASE);
    expect(inEffect(undefined, BASE)).toBe(BASE);
    expect(inEffect(null, null)).toBeNull();
    expect(inEffect(LIVE, null)).toBe(LIVE);
  });
  it("only when the live bundle is newer than the baseline (a release may have brought a newer one), each of its own kind", () => {
    const old = read(
      "live",
      { a2: { pages: [page("/mfa", "input.code", 8, "chars")] } },
      { "login.a.com": "a2" },
      [],
      2,
    );
    const newer = read("baseline", { b: { pages: [page("/", 'input[name="code"]')] } }, { "b.com": "b" }, [], 5);
    expect(inEffect(old, newer)).toBe(newer); // live v2, baseline v5: the baseline's rules
    expect(ruleFor("b.com", inEffect(old, newer))?.id).toBe("b");
    const same = read("live", { b: { pages: [page("/", "input")] } }, { "b.com": "b" }, [], 5);
    expect(inEffect(same, newer)).toBe(newer); // not newer: the baseline
    // a bundle of the wrong kind in either place is never used
    expect(inEffect(BASE, null)).toBeNull();
    expect(inEffect(BASE, newer)).toBe(newer);
    expect(inEffect(LIVE, LIVE)).toBe(LIVE);
    expect(inEffect(null, LIVE)).toBeNull();
  });
  it("so a live bundle takes a rule out by leaving it out (b.com), and replaces one by naming its hosts (a.com)", () => {
    expect(ruleFor("b.com", inEffect(LIVE, BASE))).toBeNull();
    expect(ruleFor("b.com", inEffect(null, BASE))?.id).toBe("b");
    expect(ruleFor("login.a.com", inEffect(LIVE, BASE))).toMatchObject({ id: "a2", from: "live" });
    expect(ruleFor("www.a.com", inEffect(LIVE, BASE))).toMatchObject({ id: "a2", from: "live" });
  });
});

describe("the rule for a host", () => {
  it("exact hosts only: www. is a host of its own, and a subdomain gets nothing from its parent", () => {
    expect(ruleFor("login.a.com", BASE)?.id).toBe("a");
    expect(ruleFor("www.a.com", BASE)?.id).toBe("a");
    for (const h of ["a.com", "x.login.a.com", "www.b.com", "sub.b.com", "b.com.evil.com", "B.com"])
      expect(ruleFor(h, BASE), h).toBeNull();
    expect(ruleFor("b.com", BASE)).toMatchObject({ id: "b", host: "b.com", from: "baseline" });
  });
  it("nothing for no host, no bundle, or a name a plain object would answer for", () => {
    expect(ruleFor(null, BASE)).toBeNull();
    expect(ruleFor("", BASE)).toBeNull();
    expect(ruleFor("login.a.com", null)).toBeNull();
    for (const h of ["constructor", "__proto__", "toString"]) expect(ruleFor(h, BASE)).toBeNull();
  });
});

describe("the finder's argument", () => {
  it("the host the rule was found for alone, each page as prefix, selector, segments and strategy, and the sent flag", () => {
    expect(hintOf(ruleFor("login.a.com", BASE))).toEqual({
      d: ["login.a.com"],
      p: [
        { at: "/2fa", sel: "input#otp", n: 0, how: 0 },
        { at: "/verify", sel: "div.code > input", n: 6, how: 2 },
      ],
      sent: true,
    });
    // the same rule found for its other host names that host, not login.a.com
    expect(hintOf(ruleFor("www.a.com", BASE))?.d).toEqual(["www.a.com"]);
    expect(hintOf(ruleFor("login.a.com", LIVE))).toEqual({
      d: ["login.a.com"],
      p: [{ at: "/mfa", sel: "input.code", n: 8, how: 1 }],
      sent: false,
    });
    expect(hintOf(null)).toBeNull();
  });
  it("is a copy: changing it changes no bundle", () => {
    const h = hintOf(ruleFor("login.a.com", BASE))!;
    h.p[0]!.sel = "input";
    expect(BASE.rules.get("a")?.pages[0]?.field).toBe("input#otp");
  });
  it("minLeft: the rule's, or null for the default", () => {
    expect(minLeftOf(ruleFor("login.a.com", BASE))).toBe(12);
    expect(minLeftOf(ruleFor("b.com", BASE))).toBeNull();
    expect(minLeftOf(null)).toBeNull();
  });
});

describe("the code after the password (the baseline's appends)", () => {
  it("covers the host and its subdomains on label boundaries (E*TRADE signs in on us.etrade.com)", () => {
    for (const h of ["etrade.com", "us.etrade.com", "www.etrade.com", "auth.redhat.com", "usaa.com"])
      expect(appendsOn(BASE, h), h).toBe(true);
    for (const h of ["redhat.com", "notetrade.com", "etrade.com.evil.com", "etrade.co", "1.2.3.4"])
      expect(appendsOn(BASE, h), h).toBe(false);
    expect(appendsOn(null, "etrade.com")).toBe(false);
    expect(appendsOn(BASE, null)).toBe(false);
    // a live bundle has no appends: given one, it says so instead of answering no (the review's N5)
    expect(() => appendsOn(LIVE, "etrade.com")).toThrow(/baseline/);
  });
});
