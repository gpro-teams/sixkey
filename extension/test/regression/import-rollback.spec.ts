// Regression, real browser: a batch with one oversize link used to show "Added 3" and then lose all three.
import { expect, test } from "@playwright/test";
import { close, launch, openOptions, openPopup, startFresh, type Profile } from "../e2e/harness";

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

test("pasting three links, one with a 300-character label: two are added and stay, the third is reported", async () => {
  await startFresh(p);
  const opt = await openOptions(p, "#add");
  await opt
    .locator("#paste-box")
    .fill(
      [
        "otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
        "otpauth://totp/AWS:root?secret=GEZDGNBVGY3TQOJQ&issuer=AWS",
        `otpauth://totp/Corp:${"x".repeat(300)}?secret=MFRGGZDFMZTWQ2LK&issuer=Corp`,
      ].join("\n"),
    );
  await expect(opt.locator("#preview")).toContainText(/2 to add|将添加 2/);
  await expect(opt.locator("#preview")).toContainText(/Line 3|第 3 行/);
  await opt.locator("#add-confirm").click();
  await expect(opt.locator("#add-done")).toContainText(/2/);
  const pop = await openPopup(p);
  await expect(pop.locator(".row")).toHaveCount(2);
  await expect(pop.getByRole("alert")).toHaveCount(0); // and no "restored" notice either
});
