// H7 (C2): plain text key lines in Settings > Add account. The preview finds the key column, says the other columns
// are dropped, never shows their content, and lets the user choose when the key column is not clear.
import { expect, test } from "@playwright/test";
import {
  acceptable,
  close,
  digitsOf,
  launch,
  openOptions,
  openPopup,
  SECRET,
  startFresh,
  type Profile,
} from "./harness";

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

const PW = "Hunter2-Correct!Horse";

test("name|key|password lines: the key column is found, passwords are not shown, and the accounts work", async () => {
  await startFresh(p);
  const opt = await openOptions(p, "#add");
  await opt.locator("#paste-box").fill(`GitHub|${SECRET}|${PW}\nAWS|JBSW Y3DP EHPK 3PXP|${PW}-2\njbswy3dpehpk3pxp`);
  const preview = opt.locator("#preview");
  await expect(preview).toContainText(/3 to add|将添加 3/);
  await expect(opt.locator("#lines-key")).toHaveValue("1");
  await expect(opt.locator("#lines-name")).toHaveValue("0");
  await expect(opt.locator("#lines")).toContainText(/never saved|不会保存/);
  await expect(opt.locator("#lines-note")).toContainText(/3 from plain text|3 个来自纯文本/);
  expect(await preview.innerText()).not.toContain("Hunter2");
  expect(await opt.locator("#lines-key option").allInnerTexts()).toHaveLength(3); // described by position and length only
  for (const o of await opt.locator("#lines-key option, #lines-name option").allInnerTexts())
    expect(o).not.toMatch(/Hunter|GitHub|AWS|JBSW/);

  await opt.locator("#add-confirm").click();
  await expect(opt.locator("#add-done")).toContainText(/3/);
  await expect(opt.locator("#paste-box")).toHaveValue("");

  const pop = await openPopup(p);
  await expect(pop.locator(".row")).toHaveCount(3);
  const gh = pop.locator(".row", { hasText: "GitHub" }).locator(".code");
  await expect(gh).toHaveText(/\d{3}\D*\d{3}/); // codes are computed after the rows render
  // drawn as well: rows use content-visibility: auto (B1), so a row's innerText is empty until the frame after it changes
  await expect.poll(async () => digitsOf(await gh.innerText())).toMatch(/^\d{6}$/);
  expect(await acceptable(SECRET)).toContain(digitsOf(await gh.innerText()));
  expect(await pop.locator("body").innerText()).not.toContain("Hunter2");
});

test("when two columns both look like keys, nothing is added until the user picks one", async () => {
  await startFresh(p);
  const opt = await openOptions(p, "#add");
  await opt.locator("#paste-box").fill(`${SECRET}|JBSWY3DPEHPK3PXP|GitHub`);
  await expect(opt.locator("#lines-key")).toHaveValue("");
  await expect(opt.locator("#preview")).toContainText(/0 to add|将添加 0/);
  await expect(opt.locator("#lines")).toContainText(/Choose the key column|请选择密钥列/);
  await expect(opt.locator("#add-confirm")).toBeDisabled();

  await opt.locator("#lines-key").selectOption("0");
  await opt.locator("#lines-name").selectOption("2");
  await expect(opt.locator("#preview")).toContainText(/1 to add|将添加 1/);
  await opt.locator("#add-confirm").click();
  await expect(opt.locator("#add-done")).toBeVisible();

  const pop = await openPopup(p);
  await expect(pop.locator(".row")).toHaveCount(1);
  await expect(pop.locator(".row .who b")).toHaveText("GitHub");
  await expect(pop.locator(".row .code")).toHaveText(/\d{3}\D*\d{3}/);
  await expect.poll(async () => digitsOf(await pop.locator(".row .code").innerText())).toMatch(/^\d{6}$/); // drawn (see above)
  expect(await acceptable(SECRET)).toContain(digitsOf(await pop.locator(".row .code").innerText()));
  await pop.close();

  // A link next to an unclear row: the link alone is ready, but Add waits until the row's key column is chosen,
  // so the row is never dropped without a decision.
  await opt
    .locator("#paste-box")
    .fill(`otpauth://totp/AWS:root?secret=JBSWY3DPEHPK3PXP&issuer=AWS\n${SECRET}|MFRGGZDFMZTWQ2LK|Corp`);
  await expect(opt.locator("#preview")).toContainText(/1 to add|将添加 1/);
  await expect(opt.locator("#add-confirm")).toBeDisabled();
  await opt.locator("#lines-key").selectOption("1");
  await expect(opt.locator("#preview")).toContainText(/2 to add|将添加 2/);
  await expect(opt.locator("#add-confirm")).toBeEnabled();
});
