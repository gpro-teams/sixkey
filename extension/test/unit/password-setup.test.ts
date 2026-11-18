// Setting a new password (docs/design/notes/PASSWORD-SETUP-NOTES.md): the two generators (src/ui/strength.ts), what
// measure() says about their output and about anything else, and the strength line's view of it (meterView, the part of
// PasswordFields that decides; the repo has no DOM test library, so the component's wiring is held by source rules below
// and by test/e2e/password-setup.spec.ts).
import { dictionary } from "@zxcvbn-ts/language-common";
import fc from "fast-check";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkPasswordPolicy } from "../../src/core/crypto/password-policy";
import {
  CHAR_BITS,
  CHAR_COUNT,
  CHARS,
  MAX_DRAWS,
  MIN_BITS,
  WORD_COUNT,
  forgetGenerated,
  measure,
  meterView,
  suggestPassphrase,
  suggestPassword,
  uniformIndex,
  type Strength,
} from "../../src/ui/strength";

const SRC = join(__dirname, "../../src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
const LIST = dictionary["diceware-common"];
type Cat = Record<string, { message: string }>;
const catalog = (lang: string) =>
  JSON.parse(readFileSync(join(__dirname, `../../_locales/${lang}/messages.json`), "utf8")) as Cat;
const EN_CAT = catalog("en");
const ZH_CAT = catalog("zh_CN");

/** A seeded stand-in for crypto.getRandomValues (mulberry32): the same draws every run, so no test here can flake. */
function seeded(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  return vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
    const v = arr as unknown as Uint32Array;
    for (let i = 0; i < v.length; i++) v[i] = next();
    return arr;
  });
}
/** crypto.getRandomValues answering these 32-bit values in turn. */
function scripted(values: number[]) {
  let i = 0;
  return vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
    const v = arr as unknown as Uint32Array;
    for (let k = 0; k < v.length; k++) {
      if (i >= values.length) throw new Error("scripted randomness ran out");
      v[k] = values[i++]!;
    }
    return arr;
  });
}
afterEach(() => vi.restoreAllMocks());

/** Pearson's chi-square statistic of counts against a uniform expectation. */
function chiSquare(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  const e = total / counts.length;
  return counts.reduce((a, c) => a + (c - e) ** 2 / e, 0);
}
/** The chi-square value a uniform source exceeds with probability about 1e-6 (Wilson-Hilferty, z = 4.75). */
const chiLimit = (df: number) => df * (1 - 2 / (9 * df) + 4.75 * Math.sqrt(2 / (9 * df))) ** 3;

describe("the floor is not lowered", () => {
  it("MIN_BITS is 50 and both generators clear it with room", () => {
    expect(MIN_BITS).toBe(50);
    expect(CHAR_COUNT).toBe(16);
    expect(CHAR_BITS).toBeCloseTo(16 * Math.log2(31), 10);
    expect(CHAR_BITS).toBeGreaterThan(79);
    expect(WORD_COUNT).toBe(5);
    expect(WORD_COUNT * Math.log2(LIST.length)).toBeGreaterThan(64);
    expect(WORD_COUNT * Math.log2(LIST.length)).toBeGreaterThanOrEqual(MIN_BITS);
  });
  it("measure() accepts a password only when the service's floor does and the bits reach MIN_BITS", async () => {
    for (const pw of ["", "short", "aaaaaaaaaaaaaaaa", "qwertyuiop12", "Password12345!", "correct horse"]) {
      const s = await measure(pw);
      expect(s.ok, pw).toBe(checkPasswordPolicy(pw).ok && s.bits >= MIN_BITS);
      expect(s.generated, pw).toBe(false);
    }
    const strong = await measure("Q7m#Xv9!pL2@rT5$kB8w");
    expect(strong).toMatchObject({ ok: true, floorOk: true, generated: false });
    // plenty of estimated bits, but a keyboard run: the floor still says no
    const run = await measure("qwertyQ7m#Xv9!pL2@rT5");
    expect(run.floorOk).toBe(false);
    expect(run.bits).toBeGreaterThanOrEqual(MIN_BITS);
    expect(run.ok).toBe(false);
  });
});

describe("uniformIndex: rejection sampling, no modulo bias", () => {
  it("throws away a draw at or above the largest multiple of n, and takes the next", () => {
    const limit = 2 ** 32 - (2 ** 32 % 31); // 4294967292
    const spy = scripted([2 ** 32 - 1, limit, 7]);
    expect(uniformIndex(31)).toBe(7); // `b % 31` would have answered 3 (2^32 - 1 ≡ 3 mod 31)
    expect(spy).toHaveBeenCalledTimes(3);
    scripted([limit - 1]);
    expect(uniformIndex(31)).toBe((limit - 1) % 31); // the last value kept: 30
    scripted([2 ** 32 - 1, 2 ** 32 - 1, 12345]);
    expect(uniformIndex(7776)).toBe(12345 % 7776); // 2^32 - 1 is past 7776's last full block too
  });
  it("covers every value, and only those", () => {
    seeded(1);
    for (const n of [1, 2, 31, 7776]) {
      const seen = new Set<number>();
      for (let i = 0; i < n * 40; i++) {
        const k = uniformIndex(n);
        expect(Number.isInteger(k) && k >= 0 && k < n).toBe(true);
        seen.add(k);
      }
      expect(seen.size).toBe(n);
    }
  });
  it("refuses a range it cannot serve", () => {
    for (const n of [0, -1, 1.5, NaN, 2 ** 32 + 1]) expect(() => uniformIndex(n)).toThrow(RangeError);
  });
  it("is flat for the word list's size (chi-square)", () => {
    seeded(2);
    const counts = new Array<number>(LIST.length).fill(0);
    for (let i = 0; i < LIST.length * 30; i++) counts[uniformIndex(LIST.length)]!++;
    expect(chiSquare(counts)).toBeLessThan(chiLimit(LIST.length - 1));
  });
});

describe("suggestPassword: 16 characters from 31", () => {
  it("the alphabet is 31 distinct symbols without look-alikes", () => {
    expect(new Set(CHARS).size).toBe(31);
    expect(CHARS).toMatch(/^[A-Z2-9]+$/);
    for (const c of "ILO01") expect(CHARS).not.toContain(c);
  });
  it("four groups of four, from the alphabet only, and every one passes the service's floor", () => {
    const re = new RegExp(`^[${CHARS}]{4}(?:-[${CHARS}]{4}){3}$`);
    for (let i = 0; i < 2000; i++) {
      const g = suggestPassword();
      expect(g.value).toMatch(re);
      expect(g).toMatchObject({ kind: "chars", count: 16, bits: CHAR_BITS });
      expect(checkPasswordPolicy(g.value).ok, g.value).toBe(true);
    }
  });
  it("every symbol in every position is equally likely (chi-square over 4,000 passwords)", () => {
    seeded(3);
    const counts = new Array<number>(CHARS.length).fill(0);
    const perPosition = Array.from({ length: CHAR_COUNT }, () => new Array<number>(CHARS.length).fill(0));
    for (let i = 0; i < 4000; i++) {
      const s = suggestPassword().value.replace(/-/g, "");
      [...s].forEach((c, k) => {
        counts[CHARS.indexOf(c)]!++;
        perPosition[k]![CHARS.indexOf(c)]!++;
      });
    }
    // `byte % 31` would put 9/256 on the first 8 symbols and 8/256 on the rest: a statistic near 180 here
    expect(chiSquare(counts)).toBeLessThan(chiLimit(30));
    for (const c of perPosition) expect(chiSquare(c)).toBeLessThan(chiLimit(30));
  });
  it("an output the floor would refuse is drawn again, never handed out", async () => {
    // sixteen draws of 0 make AAAA-AAAA-AAAA-AAAA (one symbol: too repetitive); then sixteen different ones
    scripted([...new Array<number>(16).fill(0), ...Array.from({ length: 16 }, (_, i) => i)]);
    const g = suggestPassword();
    expect(g.value).toBe("ABCD-EFGH-JKMN-PQRS");
    vi.restoreAllMocks();
    expect((await measure("AAAA-AAAA-AAAA-AAAA")).generated).toBe(false);
  });
});

describe("suggestPassphrase: 5 words from the EFF list zxcvbn-ts already ships", () => {
  it("the list: 7,776 distinct lower-case words, no separator inside one", () => {
    expect(LIST.length).toBe(7776);
    expect(new Set(LIST).size).toBe(7776);
    for (const w of LIST) expect(w).toMatch(/^[a-z]+$/);
  });
  it("five listed words joined by '-', 5 × log2(7776) bits, through the floor", async () => {
    const words = new Set(LIST);
    for (let i = 0; i < 300; i++) {
      const g = await suggestPassphrase();
      const parts = g.value.split("-");
      expect(parts).toHaveLength(5);
      for (const w of parts) expect(words.has(w), w).toBe(true);
      expect(g).toMatchObject({ kind: "words", count: 5 });
      expect(g.bits).toBeCloseTo(5 * Math.log2(7776), 10);
      expect(checkPasswordPolicy(g.value).ok, g.value).toBe(true);
    }
  });
  it("refuses a list with repeats, with other characters, or too short for the bar", async () => {
    const name = (i: number): string =>
      (i < 26 ? "" : name(Math.floor(i / 26) - 1)) + String.fromCharCode(97 + (i % 26));
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${name(i)}`); // distinct, a-z only
    expect(new Set(words(7776)).size).toBe(7776);
    const bad = [
      ["repeats", [...words(7775), "wa"]],
      ["a separator inside a word", [...words(7775), "ab-cd"]],
      ["too short: 5 × log2(1000) < 50", words(1000)],
    ] as const;
    try {
      for (const [why, list] of bad) {
        vi.resetModules();
        vi.doMock("@zxcvbn-ts/language-common", () => ({
          dictionary: { "diceware-common": list },
          adjacencyGraphs: {},
        }));
        const fresh = await import("../../src/ui/strength");
        await expect(fresh.suggestPassphrase(), why).rejects.toThrow();
        vi.doUnmock("@zxcvbn-ts/language-common");
      }
    } finally {
      vi.doUnmock("@zxcvbn-ts/language-common");
      vi.resetModules();
    }
  });
  it("a phrase the floor would refuse is drawn again", async () => {
    const acid = LIST.indexOf("acid"); // acid-acid-acid-acid-acid: five different characters only
    expect(acid).toBeGreaterThan(0);
    expect(checkPasswordPolicy("acid-acid-acid-acid-acid").ok).toBe(false);
    scripted([...new Array<number>(5).fill(acid), 0, 1, 2, 3, 4]);
    expect((await suggestPassphrase()).value).toBe(LIST.slice(0, 5).join("-"));
  });
});

describe("measure() and the generators agree, and only on the exact string", () => {
  it("a generated password is reported with its known entropy, accepted", async () => {
    const c = suggestPassword();
    expect(await measure(c.value)).toEqual({ bits: CHAR_BITS, ok: true, floorOk: true, generated: true });
    const w = await suggestPassphrase();
    expect(await measure(w.value)).toEqual({ bits: w.bits, ok: true, floorOk: true, generated: true });
  });
  it("an edited one falls back to zxcvbn, whatever the edit", async () => {
    const c = suggestPassword();
    const w = await suggestPassphrase();
    for (const v of [c.value + "x", c.value.slice(0, -1), c.value.toLowerCase(), ` ${c.value}`, w.value + "-a"]) {
      expect((await measure(v)).generated, v).toBe(false);
    }
    const shorter = w.value.split("-").slice(0, 2).join("-"); // two of its words: zxcvbn's estimate, well short
    const s = await measure(shorter);
    expect(s.generated).toBe(false);
    expect(s.ok).toBe(false);
  });
  it("zxcvbn alone also clears the bar for strings of the characters' shape (so the two never disagree on those)", async () => {
    // the same draws as the generator, but strings it never handed out: measure() estimates them with zxcvbn
    seeded(4);
    const shapes = Array.from({ length: 60 }, () =>
      Array.from({ length: 16 }, () => CHARS[uniformIndex(31)])
        .join("")
        .match(/.{4}/g)!
        .join("-"),
    );
    vi.restoreAllMocks();
    for (const v of shapes) {
      const s = await measure(v);
      expect(s.generated).toBe(false);
      expect(s.bits, v).toBeGreaterThanOrEqual(MIN_BITS);
    }
  });
  it("keeps at most 4, the most fields a page shows at once (the fields forget theirs sooner)", async () => {
    const first = suggestPassword().value;
    const next = Array.from({ length: 4 }, () => suggestPassword().value);
    expect((await measure(first)).generated).toBe(false);
    for (const v of next) expect((await measure(v)).generated, v).toBe(true);
  });
  it("forgets one, or all (as on a lock): forgotten ones are estimated like any other string", async () => {
    const g = suggestPassword().value;
    const keep = suggestPassword().value;
    forgetGenerated(g);
    expect((await measure(g)).generated).toBe(false);
    expect((await measure(keep)).generated).toBe(true);
    const w = (await suggestPassphrase()).value;
    forgetGenerated();
    expect((await measure(keep)).generated).toBe(false);
    expect((await measure(w)).generated).toBe(false);
  });
  it("measure() never adds to it: a string measured twice is still estimated", async () => {
    for (const pw of ["Password12345!", "ABCD-EFGH-JKMN-PQRS", "correct-horse-battery-staple-x"]) {
      await measure(pw);
      expect((await measure(pw)).generated, pw).toBe(false);
    }
  });
  it("a full-width (NFKC-equal) spelling of a generated string is estimated, not counted as generated", async () => {
    const g = suggestPassword().value;
    const wide = [...g].map((c) => (c === "-" ? "－" : String.fromCharCode(c.charCodeAt(0) + 0xfee0))).join("");
    expect(wide.normalize("NFKC")).toBe(g);
    expect((await measure(wide)).generated).toBe(false);
  });
});

describe("crypto.getRandomValues is the only source of randomness, and a broken one fails visibly", () => {
  it("when it fails, neither generator produces anything", async () => {
    vi.spyOn(crypto, "getRandomValues").mockImplementation(() => {
      throw new Error("no entropy");
    });
    const random = vi.spyOn(Math, "random");
    const now = vi.spyOn(Date, "now");
    expect(() => suggestPassword()).toThrow("no entropy");
    await expect(suggestPassphrase()).rejects.toThrow("no entropy");
    expect(() => uniformIndex(31)).toThrow("no entropy");
    expect(random).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });
  it("the same draws give the same password (nothing else feeds it)", () => {
    const draws = Array.from({ length: 16 }, (_, i) => (i * 2654435761) >>> 0);
    scripted(draws);
    const a = suggestPassword().value;
    vi.restoreAllMocks();
    scripted(draws);
    expect(suggestPassword().value).toBe(a);
    expect(a.replace(/-/g, "")).toBe(draws.map((d) => CHARS[d % 31]).join(""));
  });
  it("each symbol takes exactly one 32-bit draw, from a Uint32Array of one", () => {
    const spy = vi.spyOn(crypto, "getRandomValues");
    suggestPassword(); // a floor redraw has probability ~1.8e-10
    expect(spy).toHaveBeenCalledTimes(16);
    for (const [arr] of spy.mock.calls) {
      expect(arr).toBeInstanceOf(Uint32Array);
      expect((arr as Uint32Array).length).toBe(1);
    }
  });
  it("a source that keeps answering out of range, or always the same, makes no password: it throws, it does not hang", async () => {
    expect(MAX_DRAWS).toBe(1000);
    const stuck = (x: number) =>
      vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
        (arr as unknown as Uint32Array).fill(x);
        return arr;
      });
    stuck(2 ** 32 - 1); // always rejected
    expect(() => uniformIndex(31)).toThrow(/random source/);
    await expect(suggestPassphrase()).rejects.toThrow(/random source/);
    vi.restoreAllMocks();
    const spy = stuck(0); // always "A": AAAA-AAAA-AAAA-AAAA fails the floor every time
    expect(() => suggestPassword()).toThrow(/broken random source/);
    expect(spy).toHaveBeenCalledTimes(16 * MAX_DRAWS);
  });
});

describe("every word of the list can be drawn, by its own index", () => {
  // a draw from fewer words (list[uniformIndex(Math.min(list.length, 4096))]: 60.0 bits while claiming 64.6) or one that
  // never reaches the last word (list.length - 1) would pass membership and chi-square checks; this one sees them
  it("draw k gives list[k], for indices across the whole list including the last", async () => {
    const picks = [7775, 4096, 5000, 6999, 7774];
    scripted(picks);
    expect((await suggestPassphrase()).value).toBe(picks.map((k) => LIST[k]).join("-"));
  });
});

describe("the rejection bound for awkward ranges (exactness, termination)", () => {
  for (const n of [3, 31, 7776, 2 ** 31 + 1, 2 ** 32 - 1, 2 ** 32]) {
    it(`n = ${n}: the limit is the largest multiple of n not above 2^32; limit - 1 kept, limit rejected`, () => {
      const limit = 2 ** 32 - (2 ** 32 % n);
      expect(limit % n).toBe(0);
      expect(limit).toBeLessThanOrEqual(2 ** 32);
      expect(2 ** 32 - limit).toBeLessThan(n);
      scripted([limit - 1]);
      expect(uniformIndex(n)).toBe((limit - 1) % n);
      vi.restoreAllMocks();
      if (limit < 2 ** 32) {
        scripted([limit, 2 ** 32 - 1, 0]);
        expect(uniformIndex(n)).toBe(0); // both rejected, the third kept
      }
    });
  }
});

describe("the strength line (meterView)", () => {
  const S = (bits: number, floorOk = true, generated = false): Strength => ({
    bits,
    floorOk,
    generated,
    ok: floorOk && bits >= MIN_BITS,
  });
  it("empty: the hint, no bars", () => {
    expect(meterView("", null)).toEqual({
      on: 0,
      tone: "",
      msg: { key: "strengthHint", subs: [50] },
      offer: false,
      warn: false,
    });
    expect(meterView("x", null).msg.key).toBe("strengthHint");
  });
  it("a generated password: every bar, 'generated, X bits'", async () => {
    const c = suggestPassword();
    expect(meterView(c.value, await measure(c.value))).toEqual({
      on: 10,
      tone: "good",
      msg: { key: "strengthGenerated", subs: [79] },
      offer: false,
      warn: false,
    });
    const w = await suggestPassphrase();
    expect(meterView(w.value, await measure(w.value))).toEqual({
      on: 10,
      tone: "good",
      msg: { key: "strengthGenerated", subs: [64] },
      offer: false,
      warn: false,
    });
    // the same on the master password's pages: a generated one is handled exactly as before (OWNER-DECISIONS/15)
    expect(meterView(c.value, await measure(c.value), true)).toEqual(meterView(c.value, await measure(c.value)));
    expect(meterView(w.value, await measure(w.value), true)).toEqual(meterView(w.value, await measure(w.value)));
  });
  it("typed, below the bar: by how much, and a generated one offered", () => {
    expect(meterView("x", S(34.7))).toEqual({
      on: 6,
      tone: "fair",
      msg: { key: "strengthLow", subs: [34, 50, 16] },
      offer: true,
      warn: false,
    });
    expect(meterView("x", S(12))).toMatchObject({ tone: "weak", msg: { subs: [12, 50, 38] }, offer: true });
    expect(meterView("x", S(49.99))).toMatchObject({ on: 9, msg: { key: "strengthLow", subs: [49, 50, 1] } });
    expect(meterView("x", S(70, false))).toMatchObject({ on: 9, msg: { key: "strengthFloor" }, offer: true });
    expect(meterView("x", S(64))).toEqual({
      on: 10,
      tone: "good",
      msg: { key: "strengthOk", subs: [] },
      offer: false,
      warn: false,
    });
  });
  it("every bar is lit exactly when the password is accepted; a shortfall is never shown as zero", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 200, noNaN: true }), fc.boolean(), fc.boolean(), (bits, floorOk, gen) => {
        const s = S(bits, floorOk, gen);
        const v = meterView("x", s);
        expect(v.on === 10).toBe(s.ok);
        expect(v.offer).toBe(!s.ok);
        expect(v.warn).toBe(false); // MIN_BITS is the bar here (backup files, the sync key operations)
        expect(v.tone === "good").toBe(s.ok);
        if (v.msg.key === "strengthLow") expect(v.msg.subs[2]).toBeGreaterThanOrEqual(1);
        if (v.msg.key === "strengthGenerated") expect(s.generated && s.ok).toBe(true);
      }),
    );
  });
});

describe("PasswordFields and its callers (source rules)", () => {
  const shared = read("options/shared.tsx");
  const fields = shared.slice(
    shared.indexOf("export function PasswordFields"),
    shared.indexOf("export function RecoveryCodeBox"),
  );
  it("every page that sets a new password uses PasswordFields; backup files say so", () => {
    const callers: Record<string, number> = {
      "options/FirstRun.tsx": 1,
      "options/Security.tsx": 2,
      "options/Reset.tsx": 1,
      "options/Backup.tsx": 2,
    };
    for (const [f, n] of Object.entries(callers)) {
      const text = read(f);
      expect(text.match(/<PasswordFields\s/g), f).toHaveLength(n);
      const file = text.match(/<PasswordFields[^>]*purpose="file"/g) ?? [];
      expect(file.length, f).toBe(f === "options/Backup.tsx" ? 2 : 0);
    }
    expect(read("options/Backup.tsx").match(/autocomplete="new-password"/g)).toBeNull(); // no field of its own
  });
  it("the master password: the user's own first, 'Generate for me' secondary after it; a backup file: the generator first and primary; nothing blocks pasting", () => {
    // one generator and one box, placed before the fields for a backup file and after them otherwise (the DOM order is
    // password-fields-dom.test.ts's)
    expect(fields).toMatch(/const ownFirst = p\.purpose !== "file";/);
    expect(fields).toMatch(/class=\{ownFirst \? "btn sm ghost" : "btn"\}\s+id=\{`\$\{id\}-gen`\}/);
    const pwField = fields.indexOf("id={`${id}-pw`}");
    const before = fields.indexOf("{!ownFirst && generator}\n      {!ownFirst && madeBox}");
    const after = fields.indexOf("{ownFirst && generator}\n      {ownFirst && madeBox}");
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(pwField);
    expect(after).toBeGreaterThan(fields.indexOf("id={`${id}-pw2`}"));
    expect(fields.match(/id=\{`\$\{id\}-gen`\}/g)).toHaveLength(1);
    expect(fields).toMatch(/id=\{`\$\{id\}-own`\}/);
    expect(fields).not.toMatch(/onPaste|onCopy|onCut|onDrop|preventDefault/);
  });
  it("no control saves a password to a file: Copy only (a plaintext password in Downloads undoes the protection)", () => {
    expect(fields).not.toMatch(/\bdownload\(|saveAsFile|name="download"|createObjectURL|new Blob|\.download\s*=/);
    expect(fields).toMatch(/const v = made\.value;\s+try \{\s+await navigator\.clipboard\.writeText\(v\);/);
    // the advice names a password manager or paper, never a file or the recovery code
    for (const k of ["pwSaveMaster", "pwSaveFile"]) {
      for (const cat of [EN_CAT, ZH_CAT])
        expect(cat[k]!.message, k).not.toMatch(/file as|download|recovery|恢复码|恢复密钥|下载/i);
      expect(EN_CAT[k]!.message, k).toMatch(/password manager/);
    }
  });
  it("the EFF list's notice names the passphrase generator that now uses it", () => {
    const data = readFileSync(join(__dirname, "../../scripts/notices-data.mjs"), "utf8");
    const eff = data.slice(data.indexOf('file: "src/diceware.json"'), data.indexOf('file: "src/passwords.json"'));
    expect(eff).toMatch(/what: "[^"]*passphrase generator[^"]*"/);
  });
  it("the strength comes from measure() alone: no field prop or caller passes a bit count", () => {
    expect(fields).toMatch(/const v = p\.value;\s+void measure\(v\)/);
    expect(fields).not.toMatch(/\bbits\s*[:=]/);
    const strength = read("ui/strength.ts");
    expect(strength.match(/\bremember\(/g)).toHaveLength(3); // its definition and the two generators
    expect(strength).not.toMatch(/export\s+(?:function|const)\s+remember/);
    expect(strength).not.toMatch(/Math\.random/);
    const code = strength.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code.match(/%/g)).toHaveLength(2); // uniformIndex: the limit and the result, nowhere else
  });
  it("the strength line is announced and described", () => {
    expect(fields).toMatch(/id=\{`\$\{id\}-strength`\}\s+aria-live="polite"/);
    expect(fields).toMatch(/aria-describedby=/);
  });
  it("the last check before writing is measure() as well, on every page that sets a password", () => {
    const recheck = (v: string) =>
      new RegExp(`if \\(!\\(await measure\\(${v}\\)\\)\\.ok\\) throw new ServiceError\\("weak_password"\\)`);
    // the master password's pages: the same measure(), through masterAccepts with "Use anyway" for this value
    const recheckMaster = (v: string, anyway: string) =>
      new RegExp(
        `if \\(!masterAccepts\\(await measure\\(${v}\\), ${anyway}\\)\\) throw new ServiceError\\("weak_password"\\)`,
      );
    // [file, the check, the write it must come before]
    const sites: [string, RegExp, string][] = [
      ["options/FirstRun.tsx", recheckMaster("pw", "anyway === pw"), "rt.service.prepareKeys("],
      ["options/Reset.tsx", recheckMaster("pw", "anyway === pw"), "rt.service.prepareReset("],
      ["options/key-ops.ts", recheckMaster("pw", "anyway"), "rt.service.enableMasterPassword("], // SHORT-SETTINGS F1
      ["options/key-ops.ts", recheckMaster("pw", "anyway"), "rt.service.changePassword("],
      ["options/Backup.tsx", recheck("pw"), "createBackup(v, pw)"],
      ["options/Backup.tsx", recheck("subPw"), "createSubsetBackup(v, ids, subPw)"],
    ];
    for (const [f, check, write] of sites) {
      const text = read(f);
      const at = text.indexOf(write);
      expect(at, `${f}: ${write}`).toBeGreaterThan(0);
      const before = text.slice(Math.max(0, at - 400), at);
      expect(before.match(check), `${f}: ${write}`).not.toBeNull();
    }
    // the pages hand key-ops the press for this very value, and their buttons wait for the same rule
    const security = read("options/Security.tsx");
    expect(security).toContain("keys.enable(pw, anyway === pw)");
    expect(security).toContain("keys.change(old, pw, anyway === pw)");
    for (const f of ["options/FirstRun.tsx", "options/Reset.tsx", "options/Security.tsx"]) {
      const text = read(f);
      const n = f === "options/Security.tsx" ? 2 : 1;
      expect(text.match(/masterAccepts\(strength, anyway === pw\)/g), f).toHaveLength(n);
      expect(text.match(/anyway=\{\{ value: anyway, set: setAnyway \}\}/g), f).toHaveLength(n);
      expect(text, f).not.toMatch(/strength\?\.ok === true/);
    }
    // a backup file keeps the bar: no "Use anyway" there (nor in the Sync section's key operations, gone from every
    // build: OWNER-DECISIONS/25)
    expect(read("options/Backup.tsx")).not.toMatch(/anyway/);
  });
  it("a password is never in a text field the browser keeps: masked, or shown with autocomplete off", () => {
    expect(fields).toMatch(/type: shown \? "text" : "password",/);
    expect(fields).toMatch(/autocomplete: shown \? "off" : "new-password",/);
    expect(fields).toMatch(/autocapitalize: "off",/);
    expect(fields).toMatch(/spellcheck: false,/);
    // both fields take exactly these, and nothing reveals a password on its own
    expect(fields.match(/<input\s+id=\{`\$\{id\}-pw2?`\}[^>]*\{\.\.\.field\}/g)).toHaveLength(2);
    expect(fields).not.toMatch(/type="text"|autocomplete="new-password"|setShown\(true\)/);
    // a generated password is shown as page text, in its box
    expect(fields).toMatch(/<code id=\{`\$\{id\}-value`\}>\{made\.value\}<\/code>/);
  });
  it("the page keeps a generated password only while it is on screen", () => {
    // replaced, edited or emptied; a lock from any page; the page going away; unmount
    expect(fields).toMatch(/if \(made && made\.value !== p\.value\) \{\s+forgetGenerated\(made\.value\)/);
    expect(fields).toMatch(/if \(LOCK_EPOCH_KEY in changes\) drop\(\);/);
    expect(fields).toMatch(/addEventListener\("pagehide", drop\);/);
    const drop = fields.slice(fields.indexOf("const drop = () => {"), fields.indexOf("const locked ="));
    for (const x of ["run.current++", "forgetGenerated(m.value)", "setMade(null)", 'q.onValue("")', 'q.onConfirm("")'])
      expect(drop, x).toContain(x);
    const unmount = fields.slice(fields.indexOf('removeEventListener("pagehide", drop);'));
    expect(unmount.slice(0, 200)).toMatch(/forgetGenerated\(m\.value\)/);
    const old = fields.indexOf("const old = latest.current.made;");
    expect(fields.slice(old, old + 120)).toMatch(/if \(old\) forgetGenerated\(old\.value\)/);
  });
  it("what the user does wins over a generation still under way; the strength shown is the current value's", () => {
    expect(fields).toMatch(/const mine = \+\+run\.current;/);
    expect(fields).toMatch(/if \(mine !== run\.current\) \{\s+forgetGenerated\(g\.value\);/);
    for (const f of [
      "const own = () => {\n    run.current++;",
      "const onType = (set: (v: string) => void) => (e: Event) => {\n    run.current++;",
    ])
      expect(fields).toContain(f);
    expect(fields).toMatch(/const cur = s !== null && s\.for === p\.value \? s\.r : null;/);
    expect(fields).toMatch(/meterView\(p\.value, cur, p\.anyway !== undefined\)/);
    expect(fields).toMatch(/useLayoutEffect\(\(\) => \{\s+p\.onStrength\?\.\(null\);/);
  });
  it("focus and announcements: the generator buttons keep focus while busy, Copy is announced and arms the clean-up", () => {
    expect(fields).not.toMatch(/(?<!aria-)disabled=\{making\}/);
    expect(fields.match(/aria-disabled=\{making\}/g)).toHaveLength(3);
    expect(fields).toMatch(/use\("chars", \{ focusCopy: true \}\)/);
    expect(fields).toMatch(/<span class="pw-status" role="status">\s+\{copied \? t\("copied"\) : ""\}/);
    const copy = fields.slice(fields.indexOf("await navigator.clipboard.writeText(v);"));
    expect(copy.slice(0, 300)).toMatch(/setCopied\(true\);\s+await armClipboardClear\(v\);/);
  });
  it("the popup imports neither the generators nor the fields (settings page only)", () => {
    const walk = (dir: string): string[] =>
      readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : [],
      );
    const popup = walk("popup");
    expect(popup.length).toBeGreaterThan(5);
    for (const f of popup) expect(read(f), f).not.toMatch(/from\s+"[^"]*(?:ui\/strength|options\/)[^"]*"/);
  });
});
