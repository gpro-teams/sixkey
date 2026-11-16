// AFMATCH (docs/design/notes/AFMATCH-NOTES.md), the owner's case of 2026-10-30, through the extension in real Chromium:
// accounts imported from Google Authenticator have no sites, and on the owner's ws.g.pro the popup showed neither "This
// site" nor a Fill button. Here the page is ws.g.test (a label of 2, no account registered for it), and "ws" comes in as
// a Google Authenticator export pasted on the settings page. The browser's own click on the toolbar icon grants activeTab
// (autofill-helpers.ts world, as autofill1.spec.ts); Example (registered for fix.test and 127.0.0.1) and Related (no
// sites) are the world's other accounts.
import { expect, test } from "@playwright/test";
import { encodeBase32 } from "../../src/core/totp/base32";
import { migration } from "../helpers/import-fixtures";
import { clickFillAnyway, rowNames, windowOpen, world, type World } from "./autofill-helpers";
import { acceptable, STRONG } from "./harness";
import type { PanelPage } from "./panel-helpers";

let w: World | undefined;
test.afterEach(async () => {
  await w?.close();
  w = undefined;
});

const HOST = "ws.g.test";
const WS = { seed: 7, name: "admin", issuer: "ws" };
/** The key the export carries for it (import-fixtures.ts migration: 10 bytes made from the seed). */
const WS_SECRET = encodeBase32(Uint8Array.from({ length: 10 }, (_, i) => (WS.seed * 17 + i) & 0xff));
const EXPORT = migration([WS], { size: 1, index: 0, id: 1 });

const text = (s: PanelPage, sel: string) =>
  s.eval<string | null>(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const count = (s: PanelPage, sel: string) => s.eval<number>(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
/** For each row in the list: its name, and whether it offers "Remember". */
const remembers = (s: PanelPage) =>
  s.eval<[string, boolean][]>(
    "[...document.querySelectorAll('.row')].map((r) => [r.querySelector('.who b').textContent, !!r.querySelector('.remember')])",
  );
/** A click, in a user gesture, as a person's. */
const press = (s: PanelPage, sel: string) => s.gesture(`document.querySelector(${JSON.stringify(sel)}).click()`);
// The waits below are for what comes in the same frame as the thing checked (the rows, the button's own text), so a
// missing line or button fails on its assertion, not on a wait.
const LISTED = "document.querySelectorAll('.row').length === 3";
const CHOOSING = "document.querySelector('#ask-pick')?.textContent === 'Cancel'";

test("the owner's case: an imported account with no sites on a page with a label of 2: guessed, chosen from the line, remembered, then filled", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "popup", paste: EXPORT });
  const page = await w.tab(HOST, "/owner");
  const pop = await w.icon(page);
  await pop.until(LISTED, "the list for this page");
  expect(await text(pop, "#ask-q")).toBe(`Which account for ${HOST}?`);
  expect(await text(pop, "#ask-pick")).toBe("Choose");
  // the guess of 2: "ws" is "Possibly related" here (with its Remember); nothing is "This site", so no Fill button
  expect(await remembers(pop)).toEqual([
    ["ws", true],
    ["Example", false],
    ["Related", false],
  ]);
  expect(await pop.eval("document.querySelector('.sect.related .who b').textContent")).toBe("ws");
  expect(await count(pop, ".sect.site, .fillbtn, .fillbar")).toBe(0);

  // locked: the lock screen has no list and no line; unlocked again, the line is back
  await pop.eval("document.querySelector('#lock-now').click()");
  await pop.until("document.querySelector('#secret') && !document.querySelector('#q')", "the lock screen");
  expect(await count(pop, ".glabel.ask, #ask-pick, .row")).toBe(0);
  await pop.eval(`(() => {
    const i = document.querySelector("#secret");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ${JSON.stringify(STRONG)});
    i.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await pop.until("!document.querySelector('form.lock button[type=submit]')?.disabled", "the Unlock button");
  await pop.eval("document.querySelector('form.lock button[type=submit]').click()");
  await pop.until(LISTED, "unlocked: the list again");
  expect(await text(pop, "#ask-q")).toBe(`Which account for ${HOST}?`);

  // Choose: every row offers Remember; the button now ends the choosing
  await press(pop, "#ask-pick");
  await pop.until(CHOOSING, "choosing");
  expect(await remembers(pop)).toEqual([
    ["ws", true],
    ["Example", true],
    ["Related", true],
  ]);
  // ws: the sheet offers this page and its parent, this page first
  await pop.gesture(
    "[...document.querySelectorAll('.row')].find((r) => r.querySelector('.who b').textContent === 'ws').querySelector('.remember').click()",
  );
  await pop.until("document.querySelector('.sheet.rm')", "the remember sheet");
  expect(
    await pop.eval(
      "[...document.querySelectorAll('.sheet.rm input[type=radio]')].map((i) => i.value + (i.checked ? ' *' : ''))",
    ),
  ).toEqual([`${HOST} *`, "g.test"]);
  await pop.eval("document.querySelector('.sheet.rm button[type=submit]').click()");
  await pop.until("document.querySelector('.sect.site .row') && !document.querySelector('.sheet.rm')", "This site");
  expect(await rowNames(pop)).toEqual(["ws"]);
  expect(await count(pop, ".glabel.ask, #ask-pick, .row .remember")).toBe(0);

  // as on any page an account is registered for: the strip and the Fill button (an http page asks first, M5)
  await pop.until(
    "document.querySelector('.sect.site .fillbtn') && document.querySelector('.fillbar.ok')",
    "the Fill button, and the code box found",
  );
  await windowOpen();
  await clickFillAnyway(pop, "ws");
  await pop.until("document.querySelector('.fillnote.ok')", "filled");
  expect(await acceptable(WS_SECRET)).toContain(await page.locator(".ant-input").first().inputValue());
});

test("the side panel follows the tab: another page ends the choosing; back on the page, the line asks again", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "panel", paste: EXPORT });
  const page = await w.tab(HOST, "/owner");
  const panel = await w.icon(page);
  await panel.until(LISTED, "the list for this page");
  await press(panel, "#ask-pick");
  await panel.until(CHOOSING, "choosing");
  expect(await count(panel, ".row .remember")).toBe(3);
  // a page Example is registered for: "This site", and no line
  const other = await w.tab("127.0.0.1", "/owner");
  await w.icon(other);
  await panel.until("document.querySelector('.sect.site .row')", "This site");
  expect(await rowNames(panel)).toEqual(["Example"]);
  expect(await count(panel, ".glabel.ask, #ask-pick, .row .remember")).toBe(0);
  // back: asked again, not choosing
  await w.icon(page);
  await panel.until("document.querySelector('.sect.related .row')", "this page's list again");
  expect(await text(panel, "#ask-q")).toBe(`Which account for ${HOST}?`);
  expect(await text(panel, "#ask-pick")).toBe("Choose");
  expect(await remembers(panel)).toEqual([
    ["ws", true],
    ["Example", false],
    ["Related", false],
  ]);
});
