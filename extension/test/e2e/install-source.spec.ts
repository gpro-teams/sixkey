// H4 install-source banner (PHASE0X-PLAN C3). Only the prod build checks (scripts/build.mjs), so these tests load the
// prod dist/ unpacked, as smoke.spec.ts does: installType is "development", and the banner must show, with this copy's
// ID. The e2e build, which every other spec uses, must never show it.
import { chromium, expect, test, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { close, launch, openOptions, openPopup, startFresh, type Profile } from "./harness";
import { expectNoRawKeys } from "./text-helpers";
import { layoutIssues } from "./visual-helpers";

const PROD = resolve(import.meta.dirname, "../../dist");
const BANNER = /Not from the Chrome Web Store|不是从 Chrome 应用商店安装的/;
// Sixkey's store ID, as the tree pins it (scripts/store-id.mjs): the prod build carries it (scripts/build.mjs).
const STORE_ID = /^export const STORE_ID = "([a-p]{32})";$/m.exec(
  readFileSync(resolve(import.meta.dirname, "../../scripts/store-id.mjs"), "utf8"),
)?.[1];

async function launchProd(): Promise<Profile> {
  const dir = mkdtempSync(join(tmpdir(), "sixkey-e2e-"));
  // Bundled Chromium only: branded Chrome 137+ ignores --load-extension.
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${PROD}`, `--load-extension=${PROD}`],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  return { dir, ctx, id: new URL(sw.url()).host };
}

let p: Profile;
test.afterEach(async () => {
  await close(p);
});

test("prod build loaded unpacked: popup and settings page say it is not from the store, with this copy's ID", async () => {
  p = await launchProd();
  const pop = await openPopup(p);

  // getSelf works without the management permission, and this is what it reports for an unpacked copy.
  const self = await pop.evaluate(async () => {
    const s = await chrome.management.getSelf();
    const m = chrome.runtime.getManifest();
    return { id: s.id, installType: s.installType, perms: m.permissions, optional: m.optional_permissions };
  });
  expect(self).toEqual({
    id: p.id,
    installType: "development",
    perms: ["storage", "unlimitedStorage", "activeTab", "alarms", "idle", "offscreen", "sidePanel"], // (SIDEPANEL-NOTES.md)
    // scripting: AUTOFILL1-NOTES.md, optional since wave 1b of the plugin platform (PLUGINS-W1B-NOTES.md)
    optional: ["clipboardRead", "clipboardWrite", "scripting"],
  });

  // First screen of a new install (inside Frame): the banner comes a moment after the first frame, as a status.
  const banner = pop.locator("#install-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute("role", "status");
  await expect(banner).toContainText(BANNER);
  await expect(pop.getByRole("alert")).toHaveCount(0);
  await expectNoRawKeys(pop, "the welcome screen with the banner (prod build: only the popup's own catalog)");

  // "Details" opens the settings page at the notice: this copy's ID, the store's beside it, and the limits of the check.
  const opened = p.ctx.waitForEvent("page");
  await banner.getByRole("button", { name: /Details|详情/ }).click();
  const opt = await opened;
  await expect(opt).toHaveURL(new RegExp(`options/index\\.html#install$`));
  const notice = opt.locator("#install");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("role", "status");
  await expect(notice).toContainText(BANNER);
  await expect(opt.locator("#install-id")).toHaveText(p.id);
  expect(STORE_ID).toBeDefined();
  await expect(opt.locator("#install-store-id")).toHaveText(STORE_ID!);
  await expect(notice).not.toContainText(/not in the Chrome Web Store yet|还没有上架/);
  await expect(notice).toContainText(/cannot catch a modified copy|发现不了被改过的副本/);
  await expect(opt.getByRole("alert")).toHaveCount(0);
});

test("prod build: the list shows the banner too, and from the second opening it is there before the check answers", async () => {
  p = await launchProd();
  await startFresh(p);
  const first = await openPopup(p);
  await expect(first.locator("#q")).toBeVisible();
  await expect(first.locator("#install-banner")).toBeVisible();
  await expect(first.locator("#install-banner")).toContainText(BANNER);
  await first.close();

  // The browser never answers on this page, so a banner here can only come from the last answer, in the first frame.
  const page: Page = await p.ctx.newPage();
  await page.addInitScript(() => {
    const never = Object.assign(() => new Promise(() => undefined), { stub: true });
    Object.defineProperty(chrome.management, "getSelf", { value: never, configurable: true, writable: true });
  });
  await page.goto(`chrome-extension://${p.id}/popup/index.html`);
  expect(await page.evaluate(() => "stub" in chrome.management.getSelf)).toBe(true);
  await expect(page.locator("#q")).toBeVisible();
  await expect(page.locator("#install-banner")).toBeVisible();
  await expectNoRawKeys(page, "the list with the banner (prod build)");
  // and in Chinese: the banner's text comes from the popup's own catalog in each language
  await page.evaluate(() => localStorage.setItem("sk_lang", "zh_CN"));
  await page.reload();
  await expect(page.locator("#install-banner")).toContainText(BANNER);
  await expectNoRawKeys(page, "the list with the banner, in Chinese (prod build)");
});

test("e2e build (every other spec): no banner on any popup screen or the settings page", async () => {
  p = await launch();
  const pop = await openPopup(p);
  await pop.waitForTimeout(1500); // well past the moment the check would have answered
  await expect(pop.locator("#install-banner")).toHaveCount(0);
  await pop.close();
  await startFresh(p);
  const list = await openPopup(p);
  await expect(list.locator("#q")).toBeVisible();
  await list.waitForTimeout(1500);
  await expect(list.locator("#install-banner")).toHaveCount(0);
  const opt = await openOptions(p);
  await expect(opt.locator("#security")).toBeVisible();
  await opt.waitForTimeout(1500);
  await expect(opt.locator("#install")).toHaveCount(0);
  expect(await list.evaluate(() => localStorage.getItem("sk_install"))).toBeNull();
});

test("prod build: the settings page's notice is one line until Details is opened, never hidden for good, and fits every width", async () => {
  test.setTimeout(120_000);
  p = await launchProd();
  await startFresh(p);
  const shots = process.env.SHORT_SETTINGS_SHOTS; // a folder for the screenshots a person looks at (optional)
  for (const lang of ["en", "zh_CN"] as const) {
    const opt = await openOptions(p);
    await opt.evaluate((l) => localStorage.setItem("sk_lang", l), lang);
    await opt.reload();
    const notice = opt.locator("#install");
    await expect(notice).toBeVisible();
    // one line: closed, the ID and the explanation are not on the page, and it does not push the content down
    await expect(opt.locator("#install details")).not.toHaveAttribute("open", "");
    await expect(opt.locator("#install-id")).toBeHidden();
    await opt.setViewportSize({ width: 1400, height: 900 });
    expect((await notice.boundingBox())!.height).toBeLessThanOrEqual(56);
    // opening it (and closing it again) is a click; nothing is remembered, so the next opening of the page is closed
    await notice.locator("summary").click();
    await expect(opt.locator("#install-id")).toHaveText(p.id);
    await expect(notice).toContainText(/cannot catch a modified copy|发现不了被改过的副本/);
    for (const colorScheme of ["light", "dark"] as const)
      for (const width of [320, 600, 1400]) {
        await opt.emulateMedia({ colorScheme, reducedMotion: "reduce" });
        await opt.setViewportSize({ width, height: 900 });
        for (const open of [false, true]) {
          if (((await opt.locator("#install details").getAttribute("open")) === null) === open)
            await notice.locator("summary").click();
          const issues = await layoutIssues(opt, { root: "#install" });
          expect(issues, `${lang} ${colorScheme} ${width} px, details ${open ? "open" : "closed"}`).toEqual([]);
          if (shots && ((colorScheme === "dark" && width === 1400) || (colorScheme === "light" && width === 320)))
            await opt.screenshot({
              path: `${shots}/install-${lang}-${colorScheme}-${width}-${open ? "open" : "closed"}.png`,
            });
        }
      }
    await opt.close();
    const again = await openOptions(p);
    await expect(again.locator("#install")).toBeVisible();
    await expect(again.locator("#install details")).not.toHaveAttribute("open", "");
    // the popup's banner opens the details
    const at = await openOptions(p, "#install");
    await expect(at.locator("#install details")).toHaveAttribute("open", "");
    await expect(at.locator("#install-id")).toBeVisible();
    // an address written in the page itself (a link, Back) opens the details too
    await expect(again.locator("#install details")).not.toHaveAttribute("open", "");
    await again.evaluate(() => (location.hash = "#install"));
    await expect(again.locator("#install details")).toHaveAttribute("open", "");
    await again.close();
    await at.close();
  }
});
