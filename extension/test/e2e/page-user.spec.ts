// The account the page's user name names, listed first (platform/page-user.ts; the owner's report of 2026-11-18: on
// admin.cslink.vip, with "admin2" typed in the user name box, admin2 was 4th of 14). The page is the owner's form
// (autofill-pages.ts /user-login); the accounts are guessed for related.test by their issuer ("Related").
import { expect, test } from "@playwright/test";
import { holdsScripting, world, type World } from "./autofill-helpers";

let w: World | undefined;
test.afterEach(async () => {
  await w?.close();
  w = undefined;
});

const uri = (label: string, secret: string) => `otpauth://totp/Related:${label}?secret=${secret}&issuer=Related`;
const PASTE = [
  uri("N000021", "JBSWY3DPEHPK3PXA"),
  uri("N269225", "JBSWY3DPEHPK3PXB"),
  uri("admin", "JBSWY3DPEHPK3PXC"),
  uri("admin2", "JBSWY3DPEHPK3PXD"),
].join("\n");
const labels = (pop: Awaited<ReturnType<World["icon"]>>) =>
  pop.eval<string[]>("[...document.querySelectorAll('.sect.related .row .who i')].map((i) => i.textContent)");

const ORDERED = ["admin2", "N000021", "N269225", "admin"];

test("the user name typed on the page puts its account first (scripting held)", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "popup", accounts: ["example"], paste: PASTE });
  const pop = await w.icon(await w.tab("related.test", "/user-login"));
  await pop.until("document.querySelectorAll('.sect.related .row').length === 4", "the guessed accounts");
  await expect.poll(() => labels(pop), { timeout: 5000 }).toEqual(ORDERED);
});

test("not asked for yet: the popup's first click asks for scripting, and the next opening lists the account first", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "popup", accounts: ["example"], paste: PASTE, scripting: false });
  const page = await w.tab("related.test", "/user-login");
  let pop = await w.icon(page);
  await pop.until("document.querySelectorAll('.sect.related .row').length === 4", "the guessed accounts");
  // the page cannot be read yet: the stored order
  expect(await labels(pop)).toEqual(["N000021", "N269225", "admin", "admin2"]);
  expect(await holdsScripting(w.p)).toBe(false);
  // one click in the popup (with a second request in the same gesture, as a first Fill click makes): both granted, the
  // list does not move under the pointer
  await pop.gesture(
    "document.body.click(), chrome.permissions.request({ permissions: ['scripting'] }).then((r) => (window.__second = r), (e) => (window.__second = String(e)))",
  );
  await expect.poll(() => holdsScripting(w!.p)).toBe(true);
  await expect.poll(() => pop.eval("window.__second")).toBe(true);
  expect(await labels(pop)).toEqual(["N000021", "N269225", "admin", "admin2"]);
  // the next opening
  await page.bringToFront();
  await page.keyboard.press("Escape");
  pop = await w.icon(page);
  await pop.until("document.querySelectorAll('.sect.related .row').length === 4", "the guessed accounts again");
  await expect.poll(() => labels(pop), { timeout: 5000 }).toEqual(ORDERED);
});

test("on a site, the account copied more often comes first at the next opening; the list does not move after the click", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "popup", accounts: ["example"], paste: PASTE });
  const page = await w.tab("related.test", "/otc"); // no user name box
  let pop = await w.icon(page);
  await pop.until("document.querySelectorAll('.sect.related .row').length === 4", "the guessed accounts");
  expect(await labels(pop)).toEqual(["N000021", "N269225", "admin", "admin2"]);
  const copyRow = (label: string) =>
    pop.gesture(
      `[...document.querySelectorAll('.sect.related .row')].find((r) => r.querySelector('.who i').textContent === ${JSON.stringify(label)}).querySelector('.copy').click()`,
    );
  await copyRow("admin");
  await copyRow("admin");
  await copyRow("N269225");
  expect(await labels(pop)).toEqual(["N000021", "N269225", "admin", "admin2"]); // not under the pointer
  await page.bringToFront();
  await page.keyboard.press("Escape");
  pop = await w.icon(page);
  await pop.until("document.querySelectorAll('.sect.related .row').length === 4", "the guessed accounts again");
  await expect.poll(() => labels(pop), { timeout: 5000 }).toEqual(["admin", "N269225", "N000021", "admin2"]);
});
