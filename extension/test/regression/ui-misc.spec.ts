// Regression, real browser: nothing in the trash is erased because of the wall clock.
import { expect, test } from "@playwright/test";
import {
  addByPaste,
  close,
  GITHUB_URI,
  launch,
  openOptions,
  openPopup,
  startFresh,
  STRONG,
  type Profile,
} from "../e2e/harness";

test("a clock that jumps 31 days ahead for one page load does not erase the trash", async () => {
  const p: Profile = await launch();
  try {
    await startFresh(p);
    await addByPaste(p, GITHUB_URI);
    const pop = await openPopup(p);
    await pop.locator(".row .more").first().click({ force: true });
    await pop.getByRole("button", { name: /^(Delete|删除)$/ }).click();
    await pop.getByRole("button", { name: /Click again|再点一次/ }).click();
    await expect(pop.locator(".row")).toHaveCount(0);
    await pop.close();

    // Playwright's clock is shared by the whole browser context, so this is the last thing the test does.
    const skewed = await p.ctx.newPage();
    await skewed.clock.install({ time: Date.now() + 31 * 86_400_000 }); // e.g. a wrong system date for a moment
    await skewed.goto(`chrome-extension://${p.id}/options/index.html#trash`);
    // Every vault has a master password now (H1), and 31 days is past the 15-minute idle lock: unlock to see the trash.
    await skewed.locator("#unlock-pw").fill(STRONG);
    await skewed.locator("#unlock-btn").click();
    await expect(skewed.locator("#trash-clear-old")).toBeVisible(); // offered, never done by itself
    await skewed.waitForTimeout(1000);
    await skewed.reload();
    await expect(skewed.locator("#trash")).toContainText("GitHub"); // still there, still restorable
    await expect(skewed.locator("#trash")).not.toContainText("Nothing in the trash");
  } finally {
    await close(p);
  }
});
