// The code of the period before or after (the owner's request of 2026-11-18): arrows beside the selected row's code show
// it, the offset between them takes it back, and copying the row copies the code shown.
import { expect, test } from "@playwright/test";
import { decodeBase32 } from "../../src/core/totp/base32";
import { totp } from "../../src/core/totp/hotp";
import { addByPaste, close, GITHUB_URI, launch, openPopup, SECRET, startFresh, type Profile } from "./harness";

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

/** Waits until at least `s` seconds of the current 30-second period are left, so the steps below stay in one period. */
async function roomy(s = 12) {
  const left = () => 30 - (Math.floor(Date.now() / 1000) % 30);
  while (left() < s) await new Promise((r) => setTimeout(r, 250));
}
const codeAtSlot = (slot: number) =>
  totp(decodeBase32(SECRET), slot * 30_000 + 1, { algorithm: "SHA1", digits: 6, period: 30 });
const digits = (s: string | null) => (s ?? "").replace(/\D/g, "");

test("the arrows show the codes before and after; the offset goes back to now; copying copies the code shown", async () => {
  test.setTimeout(120_000);
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const pop = await openPopup(p);
  await roomy();
  const slot = Math.floor(Date.now() / 30_000);
  const row = pop.locator(".row").first();
  const code = row.locator(".code");
  await expect.poll(async () => digits(await code.textContent())).toBe(await codeAtSlot(slot));
  await row.hover(); // the row is selected: its arrows are there, but shown only with the pointer on the code
  await expect(row.locator(".shift .sb")).toHaveCount(2); // back and next, no offset yet
  await expect(row.locator(".shift")).toBeHidden();
  await code.hover();
  await expect(row.locator(".shift")).toBeVisible();

  await row.locator(".shift .sb").first().click(); // back
  await expect(row.locator(".shift .sb.n")).toHaveText("−30 s");
  await expect.poll(async () => digits(await code.textContent())).toBe(await codeAtSlot(slot - 1));
  await expect(pop.locator(".toast")).toHaveCount(0); // a click on an arrow copies nothing

  await row.locator(".shift .sb").last().click();
  await row.locator(".shift .sb").last().click(); // next, twice: one period ahead
  await expect(row.locator(".shift .sb.n")).toHaveText("+30 s");
  await expect.poll(async () => digits(await code.textContent())).toBe(await codeAtSlot(slot + 1));

  // copying the row copies the code shown
  await row.locator(".who").click();
  await expect.poll(() => pop.evaluate(() => navigator.clipboard.readText())).toBe(await codeAtSlot(slot + 1));

  // the offset: back to now
  await row.locator(".shift .sb.n").click();
  await expect(row.locator(".shift .sb.n")).toHaveCount(0);
  await expect.poll(async () => digits(await code.textContent())).toBe(await codeAtSlot(slot));
});
