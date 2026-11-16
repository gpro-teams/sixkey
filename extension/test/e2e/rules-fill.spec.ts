// TOTP autofill Stage 3, AF3-3b: the popup's and the side panel's Fill paths take the page's site rule, in real Chromium
// through the extension (docs/design/notes/AUTOFILL3-NOTES.md §5). The e2e build's bundle holds two test rules
// (test/fixtures/rules/): rules.fix.test's box that says nothing of a code (the heuristics offer nothing there), and
// rules2.fix.test's six one-digit boxes without maxlength (no group the heuristics see), with the "sent" flag, typed one
// character at a time, and a minLeft of 20 s (at most half the period: 15 s). Their pages are served on every fixture host,
// so the same page elsewhere is a page without a rule. The *.fix.test pages are http: the fill asks first (M5).
// The keyboard shortcut takes no rule in this patch (the maintainers' C27): its worker is byte for byte 2468c75's.
import { expect, test, type Page } from "@playwright/test";
import { SECRET } from "./harness";
import { barText, clickFill, clickFillAnyway, codesNow, windowOpen, world, type World } from "./autofill-helpers";
import type { PanelPage } from "./panel-helpers";

let w: World | undefined;
test.afterEach(async () => {
  await w?.close();
  w = undefined;
});

const value = (page: Page, sel: string) => page.locator(sel).first().inputValue();
const values = (page: Page, sel: string) =>
  page.locator(sel).evaluateAll((e) => e.map((x) => (x as HTMLInputElement).value));
/**
 * Whether this surface's page loaded the Fill chunk, the one script of a page that reads the rules (check-dist holds the
 * read to it): its stylesheet comes with it. (A page's resource timing has no entry for its own package's files.)
 */
const fillLoaded = (s: PanelPage) =>
  s.eval<boolean>(
    "[...document.querySelectorAll('link[rel=stylesheet]')].some((l) => /\\/Fill-[\\w-]+\\.css$/.test(l.href))",
  );

test("a rule's box, in the side panel: the strip finds it, Fill types the code into it; the same page on another host finds nothing", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "panel" });
  const page = await w.tab("rules.fix.test", "/rule/one");
  const panel = await w.icon(page);
  await panel.until("document.querySelector('.fillbar.ok')", "the strip says a code box was found (the rule's)");
  expect(await barText(panel)).toMatch(/Code box found/);
  await windowOpen();
  await clickFillAnyway(panel);
  await panel.until("document.querySelector('.fillnote.ok')", "filled");
  expect(await codesNow()).toContain(await value(page, "#code-box"));
  // the same page at another host has no rule: the heuristics alone, which offer nothing there
  const other = await w.tab("app.fix.test", "/rule/one");
  const panel2 = await w.icon(other);
  await panel2.until(
    "/No code box/.test(document.querySelector('.fillbar')?.textContent ?? '') && !document.querySelector('.fillbar.ok')",
    "no code box on a page without a rule",
  );
  expect(await value(other, "#code-box")).toBe("");
});

test("a rule's group, in the popup: six boxes the heuristics do not group, one digit each, and the rule's sent-code note", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "popup" });
  const page = await w.tab("rules2.fix.test", "/rule/six");
  const pop = await w.icon(page);
  await pop.until("document.querySelector('.fillbar.ok')", "the strip says a code box was found (the rule's group)");
  await pop.until("/may expect a code sent to you/.test(document.body.innerText)", "the rule's sent-code note");
  await windowOpen(17); // the rule asks for 15 s of the period (minLeft 20, at most half): no wait now
  await clickFillAnyway(pop);
  await pop.until("document.querySelector('.fillnote.ok')", "filled");
  const got = await values(page, "input.digit");
  expect(got.every((d) => /^\d$/.test(d))).toBe(true);
  expect(await codesNow()).toContain(got.join(""));
});

test("the rule's minLeft: with 7 to 13 s left (enough for the default 5 s), the fill waits for the next code", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "popup" });
  const page = await w.tab("rules2.fix.test", "/rule/six");
  const pop = await w.icon(page);
  await pop.until("document.querySelector('.fillbar.ok')", "the rule's group found");
  await clickFill(pop);
  await pop.until("document.querySelector('.fillnote.warn')", "the not-secure question");
  // the answer is given with 7 to 13 s of the period left
  const left = () => 30 - ((Date.now() / 1000) % 30);
  while (left() < 8 || left() > 12) await new Promise((r) => setTimeout(r, 200));
  const periodAtClick = Math.floor(Date.now() / 30_000);
  await pop.eval("document.querySelector('.fillanyway').click()");
  await pop.until(
    "document.querySelector('.fillnote') && /New code in/.test(document.querySelector('.fillnote').textContent)",
    "the wait for the next code",
  );
  await pop.until("document.querySelector('.fillnote.ok')", "filled after the wait", 20_000);
  const { totp } = await import("../../src/core/totp/hotp");
  const { decodeBase32 } = await import("../../src/core/totp/base32");
  const at = (p: number) => totp(decodeBase32(SECRET), p * 30_000 + 1000, { algorithm: "SHA1", digits: 6, period: 30 });
  expect((await values(page, "input.digit")).join("")).toBe(await at(periodAtClick + 1));
});

test("an open with no account for the page loads no Fill chunk, so reads no rules; with one, the heuristics' box as before", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "popup" });
  // evil.test: no account is registered for it, so the Fill chunk, the one reader of the rules in a page, is not loaded
  const none = await w.tab("evil.test", "/otc");
  const pop = await w.icon(none);
  await pop.until("document.querySelector('.row')", "the list");
  await new Promise((r) => setTimeout(r, 1500));
  expect(await fillLoaded(pop)).toBe(false);
  // 127.0.0.1: Example is registered for it; the strip looks at the page with the rules read (no rule for an IP address)
  const mine = await w.tab("127.0.0.1", "/otc");
  const pop2 = await w.icon(mine);
  await pop2.until("document.querySelector('.fillbar.ok')", "the heuristics' box, as before");
  expect(await fillLoaded(pop2)).toBe(true);
});
