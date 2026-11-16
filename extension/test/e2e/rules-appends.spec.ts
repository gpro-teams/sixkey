// TOTP autofill Stage 3, AF3-5: the "code after the password" note on the popup's and the side panel's Fill card, in real
// Chromium through the extension (docs/design/notes/AUTOFILL3-NOTES.md §7). The e2e build's bundle adds one test host to
// Apple's appends (test/fixtures/rules/appends.json): append.fix.test and its subdomains want the code typed right after
// the password, in the same box. The pages are the fixture server's, served on every host: a sign-in with a password box
// and no code box (/nofield), and a code box (/otc). So the same page elsewhere is a page without the note. The accounts
// are registered for fix.test, which covers every host here. The *.fix.test pages are http: a Fill press asks first (M5).
import { expect, test } from "@playwright/test";
import { openOptions } from "./harness";
import { barText, clickFillAnyway, codesNow, windowOpen, world, type World } from "./autofill-helpers";
import type { PanelPage } from "./panel-helpers";

let w: World | undefined;
test.afterEach(async () => {
  await w?.close();
  w = undefined;
});

const NOTE = "This site wants the code typed right after your password, in the same box.";
const NOTE_ZH = "此网站要求把验证码接在密码后面，填在同一个输入框里。";
/** The strip's words are `text` (the side panel may still show the last page's for a moment). */
const stripSays = (s: PanelPage, text: string, what: string) =>
  s.until(`(document.querySelector('.fillbar')?.textContent ?? '').includes(${JSON.stringify(text)})`, what);
/** The notes under the cards of "This site", each one's words. */
const notes = (s: PanelPage) =>
  s.eval<string[]>("[...document.querySelectorAll('.sect.site .fillnote')].map((n) => n.textContent)");

test("popup, the test host: the strip says to type the code after the password; Fill says it under the card as a note, types nothing; Copy copies", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "popup" });
  const page = await w.tab("append.fix.test", "/nofield");
  const pop = await w.icon(page);
  await stripSays(pop, NOTE, "the note in the strip");
  expect(await barText(pop)).not.toMatch(/No code box/);
  expect(await pop.eval<boolean>("!!document.querySelector('.fillbar.ok')")).toBe(false);
  // the card's Fill button, as on any page with an account for it, and a press: the http question, then the note
  expect(await pop.eval<boolean>("!document.querySelector('.sect.site .fillbtn').disabled")).toBe(true);
  await clickFillAnyway(pop);
  await pop.until(
    `document.querySelector('.sect.site .fillnote')?.textContent === ${JSON.stringify(NOTE)}`,
    "the note under the card, as the press's answer",
  );
  expect(await notes(pop)).toEqual([NOTE]);
  // a note, not a refusal: not drawn in the "bad" style (AF3-5's review NIT, done with AF3-4)
  expect(await pop.eval<string>("document.querySelector('.sect.site .fillnote').className")).toBe("fillnote");
  // nothing typed into the page, and no key or input event there
  expect(await page.locator('input[name="username"]').inputValue()).toBe("");
  expect(await page.locator('input[name="password"]').inputValue()).toBe("");
  const ev = await page.evaluate(() => (window as unknown as { __ev: string[] }).__ev);
  expect(ev.filter((e) => /^(keydown|keyup|keypress|beforeinput|submit)/.test(e))).toEqual([]);
  // the card's code is copied as on any page
  await pop.gesture("document.querySelector('.sect.site .row .copy').click()");
  await pop.until("/Copied/.test(document.querySelector('.toast')?.textContent ?? '')", "the code copied");
});

test("side panel: a subdomain of the test host has the note; the look-alike and another host say 'no code box' as before", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "panel" });
  const sub = await w.tab("us.append.fix.test", "/nofield");
  const panel = await w.icon(sub);
  await stripSays(panel, NOTE, "the note on us.append.fix.test (a subdomain, on a label boundary)");
  for (const host of ["notappend.fix.test", "app.fix.test"]) {
    const other = await w.tab(host, "/nofield");
    const p = await w.icon(other);
    await stripSays(p, "No code box found on this page.", `no code box on ${host}`);
    expect(await barText(p), host).not.toContain(NOTE);
    expect(await notes(p), host).toEqual([]);
  }
});

test("popup, a code box on the test host: found and filled as on any page, with no note", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "popup" });
  const page = await w.tab("append.fix.test", "/otc");
  const pop = await w.icon(page);
  await pop.until("document.querySelector('.fillbar.ok')", "the strip says a code box was found");
  expect(await barText(pop)).toMatch(/Code box found/);
  await windowOpen();
  await clickFillAnyway(pop);
  await pop.until("document.querySelector('.fillnote.ok')", "filled");
  expect(await codesNow()).toContain(await page.locator('input[name="code"]').inputValue());
  expect(await pop.eval<string>("document.body.innerText")).not.toContain(NOTE);
});

test("popup in Chinese: the Chinese note", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "popup" });
  const opt = await openOptions(w.p);
  await opt.evaluate(() => localStorage.setItem("sk_lang", "zh_CN"));
  await opt.close();
  const page = await w.tab("us.append.fix.test", "/nofield");
  const pop = await w.icon(page);
  await stripSays(pop, NOTE_ZH, "the Chinese note");
});
