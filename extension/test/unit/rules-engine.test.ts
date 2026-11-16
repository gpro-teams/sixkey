// TOTP autofill Stage 3, AF3-2: the finder's side of a site rule (src/inject/otp.ts; docs/design/notes/AUTOFILL3-NOTES.md
// §3), the parts that are pure functions. What it does on a page (the token kinds, the rule-made entries a look replaces, the
// boosts on real boxes, a selector that throws, the every-box checks) is tested in Chromium: test/e2e/rules-engine.spec.ts.
//   - S1: a rule promotes no box with a veto, a hard negative (`neg`) or type=password, with the real score();
//   - the hint the extension makes (lookup.ts hintOf, of a checked rule) is read whole, anything else not at all;
//   - the finder's copy of the selector grammar and of the path rule says what format.ts says, sample by sample.
import { describe, expect, it } from "vitest";
import { canonicalHost } from "../../src/core/match";
import { isShared } from "../../src/core/site-domains";
import { LIMITS, selectorOk, validate, type Bundle } from "../../src/core/rules/format";
import { hintOf, ruleFor, type Hint } from "../../src/core/rules/lookup";
import { boostable, readHint, RULE_BOOST, score, selOk, THRESHOLD, type Feat } from "../../src/inject/otp";

const C = { canonicalHost, isShared };
const box = (f: Partial<Feat> = {}): Feat => ({
  type: "text",
  autocomplete: "",
  inputmode: "",
  pattern: "",
  max: 0,
  ids: "",
  label: "",
  segments: 0,
  urlHint: false,
  alone: false,
  ...f,
});
const promotes = (f: Partial<Feat>) => boostable(f.type ?? "text", score(box(f)));

describe("S1: what a rule may promote, with the real score()", () => {
  // the boxes the plan's review measured (§R2.2): each would pass the threshold with the rule's boost if nothing stopped it
  const NEGATIVE: [string, Partial<Feat>][] = [
    ["a neutral-named password box", { type: "password", ids: "f2" }],
    [
      "an OTP box typed password (the heuristics may still offer it; a rule may not promote it)",
      { type: "password", ids: "otp" },
    ],
    ["name=cardNumber", { ids: "cardNumber" }],
    ["the label Card number", { label: "Card number" }],
    ["name=cvv", { ids: "cvv" }],
    ["a phone box", { type: "tel", ids: "phone" }],
    ["the label Mobile number", { type: "tel", label: "Mobile number" }],
    ["a search box by its words", { ids: "q", label: "Search" }],
    ["a coupon box", { ids: "coupon", label: "Promo code" }],
    ["name=zip", { ids: "zip" }],
    ["name=amount", { ids: "amount" }],
    ["name=username", { ids: "username" }],
    ["name=email", { ids: "email" }],
    ["the words of a captcha (a veto)", { label: "Enter the captcha" }],
    ["a password by name (a veto)", { type: "password", ids: "password" }],
    ["autocomplete=cc-number (a veto)", { autocomplete: "cc-number" }],
    ["type=search (a veto)", { type: "search" }],
  ];
  const POSITIVE: [string, Partial<Feat>][] = [
    ["a neutral box (no signal at all)", {}],
    ["autocomplete=one-time-code", { autocomplete: "one-time-code" }],
    ["the label Verification code", { label: "Verification code" }],
    ["name=token", { ids: "token" }],
    ["a code sent by SMS (a soft signal, not a block)", { label: "SMS code sent to your phone" }],
    ["a tel box with no name", { type: "tel" }],
  ];
  it("the boost lifts every one of the negative boxes over the threshold: that is why it needs conditions", () => {
    expect(RULE_BOOST).toBe(100);
    for (const [what, f] of NEGATIVE) {
      const s = score(box(f));
      expect(s.veto || s.score + RULE_BOOST >= THRESHOLD, what).toBe(true);
    }
  });
  it("no veto, no hard negative, no password box: none of the negative boxes is promoted, each of the others is", () => {
    for (const [what, f] of NEGATIVE) expect(promotes(f), what).toBe(false);
    for (const [what, f] of POSITIVE) expect(promotes(f), what).toBe(true);
  });
  it("neg is the −60 signal exactly: a negative name token or negative words, and nothing else", () => {
    expect(score(box({ ids: "phone" })).neg).toBe(true);
    expect(score(box({ label: "Zip code" })).neg).toBe(true);
    expect(score(box({ ids: "otp", label: "Phone number" })).neg).toBe(true);
    expect(score(box({ label: "SMS code sent to your phone" })).neg).toBe(false);
    expect(score(box({ type: "password", ids: "f2" })).neg).toBe(false); // the password rule is its own
    expect(score(box({ ids: "zip" })).score).toBe(score(box({})).score - 60);
    // the score is what it was before AF3-2: neg is read off it, not added to it
    expect(score(box({ ids: "cardNumber" })).score).toBe(-60);
    expect(score(box({ type: "tel", ids: "phone" })).score).toBe(-50);
  });
});

/** A bundle with one rule, checked, and the hint the extension makes of it for `host`. */
function hintFor(pages: object[], host = "login.example.com", sent = false): Hint {
  const raw = {
    format: "sixkey-rules",
    kind: "baseline",
    schema: 1,
    version: 3,
    created: "2026-11-04",
    license: "AGPL-3.0-or-later",
    source: "",
    upstream: [],
    rules: { r: { pages, ...(sent ? { flags: ["sent"] } : {}) } },
    hosts: { [host]: "r" },
    aliases: [],
    appends: [],
  };
  const v = validate(raw, "baseline", C);
  if (!v.ok) throw new Error(v.error);
  return hintOf(ruleFor(host, v.value as Bundle))!;
}
const page = (path: string, field: string, segments = 0, fill = "auto") => ({ path, field, segments, fill });

describe("the hint, as the finder reads it", () => {
  it("is taken whole when the extension made it: one box, a group, each strategy, the sent flag", () => {
    const h = hintFor(
      [page("/2fa", "input#otp"), page("/mfa/", "div.code > input", 6, "chars"), page("/", "input.d", 8, "paste")],
      "login.example.com",
      true,
    );
    expect(h).toEqual({
      d: ["login.example.com"],
      p: [
        { at: "/2fa", sel: "input#otp", n: 0, how: 0 },
        { at: "/mfa/", sel: "div.code > input", n: 6, how: 1 },
        { at: "/", sel: "input.d", n: 8, how: 2 },
      ],
      sent: true,
    });
    expect(readHint(h)).toBe(h);
    expect(readHint(JSON.parse(JSON.stringify(h)))).toEqual(h); // as executeScript hands it over: a copy
  });
  it("is nothing (the heuristics alone) when it is not one: no hint, a wrong shape, a value out of bounds", () => {
    const ok = (): Record<string, any> => ({
      d: ["a.example.com"],
      p: [{ at: "/", sel: "input", n: 0, how: 0 }],
      sent: false,
    });
    const entry = (e: object) => ({ ...ok(), p: [{ ...ok().p[0], ...e }] });
    expect(readHint(ok())).not.toBeNull();
    const bad: [string, unknown][] = [
      ["null", null],
      ["undefined", undefined],
      ["a string", "input"],
      ["a list", [ok()]],
      ["an extra field", { ...ok(), x: 1 }],
      ["no sent", { d: ok().d, p: ok().p }],
      ["sent not a boolean", { ...ok(), sent: 1 }],
      ["no hosts", { ...ok(), d: [] }],
      ["17 hosts", { ...ok(), d: Array(17).fill("a.example.com") }],
      ["a host not a string", { ...ok(), d: [1] }],
      ["a host of 254 characters", { ...ok(), d: ["a".repeat(254)] }],
      ["no pages", { ...ok(), p: [] }],
      ["9 pages", { ...ok(), p: Array(9).fill(ok().p[0]) }],
      ["a page with an extra field", entry({ wait: 1 })],
      ["a page with no strategy", { ...ok(), p: [{ at: "/", sel: "input", n: 0 }] }],
      ["a path without its slash", entry({ at: "2fa" })],
      ["a path with a space", entry({ at: "/a b" })],
      ["a path of 129 characters", entry({ at: "/" + "a".repeat(128) })],
      ["a selector outside the grammar", entry({ sel: "input:focus" })],
      ["a selector of 201 characters", entry({ sel: "a".repeat(201) })],
      ["no selector", entry({ sel: "" })],
      ["3 segments", entry({ n: 3 })],
      ["9 segments", entry({ n: 9 })],
      ["1 segment", entry({ n: 1 })],
      ["4.5 segments", entry({ n: 4.5 })],
      ["segments as text", entry({ n: "6" })],
      ["strategy 3", entry({ how: 3 })],
      ["one box typed chars (n 0 takes only auto)", entry({ how: 1 })],
      ["one box pasted", entry({ how: 2 })],
      ["fields inherited, not its own", Object.create(ok())],
    ];
    for (const [what, h] of bad) expect(readHint(h), what).toBeNull();
    // the bounds themselves pass
    expect(readHint({ ...ok(), d: Array(16).fill("a".repeat(253)) })).not.toBeNull();
    expect(readHint({ ...ok(), p: Array(8).fill(ok().p[0]) })).not.toBeNull();
    expect(readHint(entry({ at: "/" + "a".repeat(127) }))).not.toBeNull();
    expect(readHint(entry({ sel: "a ".repeat(7) + "a" }))).not.toBeNull();
    for (const n of [4, 6, 8])
      for (const how of [0, 1, 2]) expect(readHint(entry({ n, how })), `${n} ${how}`).not.toBeNull();
  });
  it("its bounds are the format's", () => {
    expect(LIMITS.hosts[1]).toBe(16);
    expect(LIMITS.host).toBe(253);
    expect(LIMITS.pages[1]).toBe(8);
    expect(LIMITS.path).toBe(128);
    expect(LIMITS.field).toBe(200);
    expect(LIMITS.segments).toEqual([4, 8]);
  });
});

describe("the finder's copy of the grammar says what format.ts says", () => {
  const SAMPLES = [
    "input#otp",
    'input[id=":r1:"]',
    "div.code > input",
    'input[aria-label="Code > digits, then Enter"]',
    "a b c d e f g h",
    "a b c d e f g h i",
    '[class~="2fa-code"]',
    '[name~="a b"]',
    '[name~=""]',
    '[name^="otp"]',
    "#1a",
    ".2fa",
    ".-otp",
    "#-a",
    "a>b",
    "input:focus",
    "a, b",
    "a ~ b",
    "[name=otp]",
    '[name$="x"]',
    "INPUT",
    " input",
    "input ",
    "input >input",
    "input  input",
    'input[name="ü"]',
    ".a\\:b",
    "#a#b",
    "input#a.b.c[d][e]",
    "a input",
    "#a input",
    '[data-x="a\\"b"]',
    "",
  ];
  it("on the format's own samples", () => {
    for (const s of SAMPLES) expect(selOk(s), JSON.stringify(s)).toBe(selectorOk(s));
    for (const s of [undefined, null, 1, ["input"]]) expect(selOk(s)).toBe(false);
    expect(selOk("a".repeat(200))).toBe(selectorOk("a".repeat(200)));
    expect(selOk("a".repeat(201))).toBe(false);
  });
  it("on 20,000 strings made of the grammar's own characters (a fixed seed)", () => {
    const ALPHA = 'aAz09#.-_[]="^~ >:*,()\\ü';
    let x = 20261104;
    const next = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff), x);
    let accepted = 0;
    for (let i = 0; i < 20_000; i++) {
      const n = 1 + (next() % 24);
      let s = "";
      for (let j = 0; j < n; j++) s += ALPHA[next() % ALPHA.length];
      expect(selOk(s), JSON.stringify(s)).toBe(selectorOk(s));
      if (selectorOk(s)) accepted++;
    }
    expect(accepted).toBeGreaterThan(500); // the samples reach the grammar, not only its refusals
  });
  it("and the path rule is the format's", () => {
    const PATHS = [
      "/",
      "/2fa",
      "/a/b/",
      "/a-b_c.d~e",
      "/%2F",
      "/a?b",
      "/a#b",
      "/a b",
      '/a"b',
      "/a<b",
      "/A",
      "/é",
      "",
      "a",
      "/a\\b",
      "/a*b",
      "/a{b}",
      "/a|b",
      "/a^b",
      "/a`b",
    ];
    for (const at of PATHS) {
      const rule = {
        id: "r",
        hosts: ["login.example.com"],
        pages: [page(at, "input")],
        verified: "2026-11-01",
        fixtures: ["r/a.html"],
      };
      const format = validate(rule, "rule", C).ok;
      const finder =
        readHint({ d: ["login.example.com"], p: [{ at, sel: "input", n: 0, how: 0 }], sent: false }) !== null;
      expect(finder, JSON.stringify(at)).toBe(format);
    }
  });
});
