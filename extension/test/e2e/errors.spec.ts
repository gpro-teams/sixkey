// PHASE0X-PLAN C8 / ux-study §2.12 P0: error text says what happened and what to do next, and never shows an internal
// error name (the popup's error screen used to print "Error: TypeError"). The error's class goes to the local
// diagnostics log instead, which the text points to.
import { expect, test, type Page } from "@playwright/test";
import { close, launch, openOptions, openPopup, startFresh, type Profile } from "./harness";

let p: Profile;
test.afterEach(async () => {
  await close(p);
});

/** Make every read of extension storage on this page fail with a TypeError, except the diagnostics log's own. */
async function breakStorage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const area = chrome.storage.local;
    const get = area.get.bind(area) as (keys: unknown) => Promise<unknown>;
    const w = window as unknown as { skBroken: boolean };
    w.skBroken = true;
    Object.defineProperty(area, "get", {
      configurable: true,
      value: (keys: unknown) =>
        w.skBroken && !(Array.isArray(keys) && keys.length === 1 && keys[0] === "sk_diag")
          ? Promise.reject(new TypeError("Cannot read properties of undefined (reading 'sk_slot_a')"))
          : get(keys),
    });
  });
}

test("popup error screen: what happened and what to do, no internal name; the class goes to diagnostics; Retry recovers", async () => {
  p = await launch();
  const page = await p.ctx.newPage();
  await breakStorage(page);
  await page.goto(`chrome-extension://${p.id}/popup/index.html`);

  await expect(page.locator("h1.prompt")).toHaveText(/Something unexpected went wrong|发生了意外错误/);
  await expect(page.locator("#app")).toContainText(
    /Try again\. If it keeps failing, save diagnostics under Settings › Advanced\.|请重试；仍然失败的话，到 设置 › 高级 保存诊断信息。/,
  );
  const text = await page.locator("#app").innerText();
  for (const leak of ["TypeError", "Error:", "错误：", "sk_slot_a", "Cannot read", "undefined"])
    expect(text, leak).not.toContain(leak);
  await expect(page.getByRole("button", { name: /^(Settings|设置)$/ })).toBeVisible();

  // The diagnostics log has the class, and where it happened; nothing else.
  await expect
    .poll(() => page.evaluate(async () => JSON.stringify((await chrome.storage.local.get(["sk_diag"])).sk_diag ?? [])))
    .toContain("TypeError");
  const log = await page.evaluate(
    async () => (await chrome.storage.local.get(["sk_diag"])).sk_diag as { message: string; error: string }[],
  );
  expect(log.map((x) => [x.message, x.error])).toEqual([["popup could not open", "TypeError"]]);

  // Once storage reads work again, Retry opens the popup normally.
  await page.evaluate(() => {
    (window as unknown as { skBroken: boolean }).skBroken = false;
  });
  await page.getByRole("button", { name: /^(Retry|重试)$/ }).click();
  await expect(page.locator("h1.prompt")).not.toHaveText(/Something unexpected went wrong|发生了意外错误/);
  await expect(page.getByRole("button", { name: /^(Retry|重试)$/ })).toHaveCount(0);
});

test("settings page: a wrong password says so and what to do, without the error code, and is not logged", async () => {
  p = await launch();
  await startFresh(p);
  const pop = await openPopup(p);
  await pop.getByRole("button", { name: /^(Lock|锁定)$/ }).click();
  await expect(pop.locator("#secret")).toBeVisible();
  const opt = await openOptions(p);
  await opt.locator("#unlock-pw").fill("not the password");
  await opt.locator("#unlock-btn").click();
  const err = opt.getByRole("alert");
  await expect(err).toHaveText(/^Wrong password\. Check it and try again\.$|^密码错误。请检查后重试。$/);
  await expect(err).not.toContainText("wrong_secret");
  expect(await opt.evaluate(async () => (await chrome.storage.local.get(["sk_diag"])).sk_diag ?? [])).toEqual([]);
});
