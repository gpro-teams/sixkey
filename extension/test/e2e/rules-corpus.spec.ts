// TOTP autofill Stage 3, AF3-3b: every site rule against its own synthetic pages, in real Chromium, with the finder as the
// e2e build builds it (dist-e2e/inject/otp.js) and the hint the Fill paths make of the rule (core/rules/lookup.ts hintOf;
// docs/design/notes/AUTOFILL3-NOTES.md §5; the plan's §6 "corpus spec"). The rules: the repository's (rules/sites/, none
// yet: the first come from real pages, AF3-6) and the e2e build's test rules (extension/test/fixtures/rules/sites/), each
// checked by the format's own checker first. One browser and context: each fixture is served by the context's route at the
// rule's own https://<host><path> (the path its <meta name="sixkey-path"> names, else the first page's), and every other
// request is aborted. For each fixture the rule's box is found (r: 1) and filled. Then a negative page at each rule's host,
// under each of its paths, with selectors that do match its boxes (a password, a card number, a phone, a search, a coupon,
// a user name), as one box and as the rule's own box count and way of typing: no box is promoted. A rule last verified
// more than 365 days ago is reported as an annotation.
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalHost } from "../../src/core/match";
import { validate, type SiteRule } from "../../src/core/rules/format";
import { hintOf, type Hint } from "../../src/core/rules/lookup";
import { isShared } from "../../src/core/site-domains";

const EXT = resolve(import.meta.dirname, "../..");
const ENGINE = readFileSync(resolve(EXT, "dist-e2e/inject/otp.js"), "utf8");
const CODE = "482915";

/** The rule folders: the repository's and the e2e build's own; a fixture is `<folder>/fixtures/<name>`. */
const FOLDERS = [
  { dir: resolve(EXT, "../rules"), reserved: false },
  { dir: resolve(EXT, "test/fixtures/rules"), reserved: true },
];
type Case = { rule: SiteRule; dir: string };
const CASES: Case[] = FOLDERS.flatMap(({ dir, reserved }) => {
  const sites = join(dir, "sites");
  if (!existsSync(sites)) return [];
  return readdirSync(sites)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => {
      const r = validate(
        JSON.parse(readFileSync(join(sites, n), "utf8")),
        "rule",
        { canonicalHost, isShared },
        {
          allowReserved: reserved,
        },
      );
      if (!r.ok) throw new Error(`${n}: ${r.error}`);
      return { rule: r.value, dir };
    });
});

const NEG = `<!doctype html><meta charset="utf-8"><title>Negatives</title><form onsubmit="return false">
  <p><input type="password" id="p1"></p><p><input name="cardNumber" id="c1"></p><p><input type="tel" name="phone" id="t1"></p>
  <p><input type="search" name="q" id="s1"></p><p><input name="coupon" id="k1" placeholder="Promo code"></p>
  <p><input name="username" id="u1"></p></form>`;
const NEG_SELECTORS = ["input", 'input[type="password"]', "#c1", 'input[type="tel"]', "#s1", "#k1", "#u1"];
/**
 * For a group rule: rows of its own box count that are no code (a PIN, a card number, a phone number), each laid out as a
 * code group's row (one line, boxes of one width) under its own words (the finder reads a group's words two levels up),
 * which it must not promote either; and one plain row it does promote (so the layout is not what keeps the others out).
 */
const negRows = (n: number) => {
  const row = (words: string, id: string, attrs: string) =>
    `<div><p>${words}</p><div class="row" id="${id}">${Array.from({ length: n }, () => `<input ${attrs}>`).join("")}</div></div>`;
  return `<!doctype html><meta charset="utf-8"><title>Negative rows</title>
  <style>.row{display:flex;gap:6px}.row input{width:34px;height:40px}</style><form onsubmit="return false">
  ${row("PIN", "pin", 'type="password" maxlength="1"')}
  ${row("Card number", "card", 'name="cardNumber" maxlength="1"')}
  ${row("Phone number", "tel", 'type="tel" maxlength="1"')}
  ${row("Step two", "plain", 'maxlength="1"')}</form>`;
};
const NEG_ROW_SELECTORS = ["#pin input", "#card input", "#tel input"];

type Found = { t: string; k: 0 | 1; n: number; s: number; r?: 1 };
type Engine = {
  inspect(h: unknown): { c: Found[] } | null;
  fill(c: string, o: string, d: string, t: string, k: string): Promise<{ ok: boolean; how?: string; r?: string }>;
};

let browser: Browser;
let ctx: BrowserContext;
/** What the context serves: https://<host><path> → the page. */
const served = new Map<string, string>();
test.beforeAll(async () => {
  browser = await chromium.launch({ channel: "chromium" });
  ctx = await browser.newContext();
  await ctx.route("**/*", (route) => {
    const u = new URL(route.request().url());
    const body = u.protocol === "https:" ? served.get(`${u.hostname}${u.pathname}`) : undefined;
    return body === undefined
      ? route.abort()
      : route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
  });
});
test.afterAll(async () => {
  await browser?.close();
});

async function open(host: string, path: string, html: string): Promise<Page> {
  served.set(`${host}${path}`, html);
  const page = await ctx.newPage();
  await page.goto(`https://${host}${path}`);
  await page.evaluate(ENGINE);
  return page;
}
const look = (page: Page, hint: Hint) =>
  page.evaluate((h) => (globalThis as unknown as { __skOtp: Engine }).__skOtp.inspect(h)!, hint);

test("there are rules to check: the e2e build's test rules at least (the repository's own come with AF3-6)", () => {
  expect(CASES.filter((c) => c.dir.endsWith("test/fixtures/rules")).length).toBeGreaterThanOrEqual(2);
});

for (const { rule, dir } of CASES)
  test(`${rule.id}: its box is found by the rule and filled on each of its pages, and promotes no negative box`, async () => {
    const days = (Date.now() - Date.parse(`${rule.verified}T00:00:00Z`)) / 86_400_000;
    if (days > 365)
      test.info().annotations.push({ type: "stale", description: `${rule.id} last verified ${rule.verified}` });
    for (const host of rule.hosts) {
      const hint = hintOf({ id: rule.id, host, rule: rule.rule, from: "baseline" })!;
      for (const f of rule.fixtures) {
        const html = readFileSync(join(dir, "fixtures", f), "utf8");
        const path = /<meta name="sixkey-path" content="([^"]+)"/.exec(html)?.[1] ?? rule.rule.pages[0]!.path;
        const page = await open(host, path, html);
        const got = (await look(page, hint)).c.filter((c) => c.r === 1);
        expect(got, `${f} at https://${host}${path}`).toHaveLength(1);
        const res = await page.evaluate(
          ([c, o, d, t]) => (globalThis as unknown as { __skOtp: Engine }).__skOtp.fill(c, o, d, o, t),
          [CODE, `https://${host}`, host, got[0]!.t] as const,
        );
        expect(res.ok, `${f}: ${JSON.stringify(res)}`).toBe(true);
        const typed = await page.$$eval("input", (els) => (els as HTMLInputElement[]).map((e) => e.value).join(""));
        expect(typed, f).toBe(CODE);
        await page.close();
      }
      // the negative page under each of the rule's paths, with the rule's own selectors and with ones that match its boxes:
      // as one box, and as the rule's own entry (its box count and way of typing: a group rule's six, AF3-3b's review)
      for (const [i, p] of rule.rule.pages.entries()) {
        const page = await open(host, p.path, NEG);
        const own = hint.p[i]!;
        for (const sel of [p.field, ...NEG_SELECTORS])
          for (const e of own.n === 0 ? [own] : [{ ...own, n: 0, how: 0 as const }, own]) {
            const neg: Hint = { d: [host], p: [{ ...e, sel }], sent: hint.sent };
            expect(
              (await look(page, neg)).c.filter((c) => c.r === 1),
              `${sel} (n: ${e.n}) at ${host}${p.path}`,
            ).toEqual([]);
          }
        await page.close();
        if (own.n === 0) continue;
        // and rows of the rule's own box count that are no code: a PIN, a card number, a phone number
        const rows = await open(host, p.path, negRows(own.n));
        const plain = (await look(rows, { d: [host], p: [{ ...own, sel: "#plain input" }], sent: hint.sent })).c;
        expect(plain.filter((c) => c.r === 1 && c.n === own.n)).toHaveLength(1);
        for (const sel of NEG_ROW_SELECTORS) {
          expect(await rows.locator(sel).count(), sel).toBe(own.n);
          expect(
            (await look(rows, { d: [host], p: [{ ...own, sel }], sent: hint.sent })).c.filter((c) => c.r === 1),
            `${sel} (n: ${own.n}) at ${host}${p.path}`,
          ).toEqual([]);
        }
        await rows.close();
      }
    }
  });
