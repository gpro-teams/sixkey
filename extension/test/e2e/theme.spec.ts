// PHASE0X-PLAN C4: the colour theme (follow the system, light, dark) on the popup and the settings page, chosen in
// Settings > Appearance, and the panel's other controls: the popup's density, order and hidden codes, and the shortcut.
import { expect, test, type Page } from "@playwright/test";
import { addByPaste, close, launch, openOptions, openPopup, type Profile, showSection, startFresh } from "./harness";

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

/** The page as drawn: its data-theme, its color-scheme meta, and whether the body's background is dark. */
const look = (page: Page) =>
  page.evaluate(() => {
    const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g)!.map(Number) as [
      number,
      number,
      number,
    ];
    return {
      theme: document.documentElement.getAttribute("data-theme"),
      meta: document.querySelector('meta[name="color-scheme"]')?.getAttribute("content"),
      dark: 0.2126 * r + 0.7152 * g + 0.0722 * b < 128,
    };
  });

/** A page opened with the system in `scheme`, recording the theme at its first animation frame (before that frame paints). */
async function openAs(path: string, scheme: "light" | "dark"): Promise<Page> {
  const page = await p.ctx.newPage();
  await page.emulateMedia({ colorScheme: scheme });
  await page.addInitScript(() => {
    requestAnimationFrame(() => {
      (window as unknown as { firstFrameTheme: string | null }).firstFrameTheme =
        document.documentElement.getAttribute("data-theme");
    });
  });
  await page.goto(`chrome-extension://${p.id}/${path}`);
  return page;
}
const firstFrameTheme = (page: Page) =>
  page
    .waitForFunction(() => "firstFrameTheme" in window)
    .then(() => page.evaluate(() => (window as unknown as { firstFrameTheme: string | null }).firstFrameTheme));

test("a chosen theme wins over the system's on both pages, from the first frame; following the system follows it", async () => {
  await startFresh(p);
  const opt = await openOptions(p, "#appearance");
  await opt.emulateMedia({ colorScheme: "light" });
  await expect(opt.locator("#look-theme-auto")).toBeChecked(); // the default
  expect(await look(opt)).toEqual({ theme: null, meta: "light dark", dark: false });

  // dark, with the system light
  await opt.locator("#look-theme-dark").check();
  expect(await look(opt)).toEqual({ theme: "dark", meta: "dark", dark: true });
  for (const path of ["popup/index.html", "options/index.html"]) {
    const page = await openAs(path, "light");
    await expect(page.locator("#app > *").first()).toBeVisible();
    expect(await firstFrameTheme(page), path).toBe("dark"); // set by public/theme-boot.js before anything was drawn
    expect(await look(page), path).toEqual({ theme: "dark", meta: "dark", dark: true });
    await page.close();
  }

  // light, with the system dark
  await opt.emulateMedia({ colorScheme: "dark" });
  await opt.locator("#look-theme-light").check();
  expect(await look(opt)).toEqual({ theme: "light", meta: "light", dark: false });
  const pop = await openAs("popup/index.html", "dark");
  await expect(pop.locator("#q")).toBeVisible();
  expect(await firstFrameTheme(pop)).toBe("light");
  expect(await look(pop)).toEqual({ theme: "light", meta: "light", dark: false });
  await pop.close();

  // following the system: no data-theme, and the page changes with the system
  await opt.locator("#look-theme-auto").check();
  expect(await look(opt)).toEqual({ theme: null, meta: "light dark", dark: true });
  await opt.emulateMedia({ colorScheme: "light" });
  expect((await look(opt)).dark).toBe(false);
  const pop2 = await openAs("popup/index.html", "dark");
  await expect(pop2.locator("#q")).toBeVisible();
  expect(await look(pop2)).toEqual({ theme: null, meta: "light dark", dark: true });
  await pop2.emulateMedia({ colorScheme: "light" });
  expect((await look(pop2)).dark).toBe(false);

  // the choice is kept: a new settings page opens with it
  await opt.reload();
  await expect(opt.locator("#look-theme-auto")).toBeChecked();
});

test("Appearance sets the popup's density, order and hidden codes, and saves the whole settings record", async () => {
  await startFresh(p);
  await addByPaste(
    p,
    [
      "otpauth://totp/Zeta:z?secret=JBSWY3DPEHPK3PXP&issuer=Zeta",
      "otpauth://totp/Alpha:a?secret=GEZDGNBVGY3TQOJQ&issuer=Alpha",
    ].join("\n"),
  );
  const opt = await openOptions(p, "#security");
  await expect(opt.locator(".status dd.num")).toHaveText("2"); // loaded: no reload will redraw the field while it is typed in
  await opt.locator("#al-minutes").fill("30");
  await opt.locator("#al-minutes").press("Enter");
  await expect
    .poll(() => opt.evaluate(async () => (await chrome.storage.local.get("sk_settings")).sk_settings))
    .toMatchObject({ autoLock: { mode: "idle", minutes: 30 } });

  const before = await openPopup(p);
  await expect(before.locator(".row")).toHaveCount(2);
  await expect(before.locator(".row .who b")).toHaveText(["Zeta", "Alpha"]); // manual: the order they were added in
  await expect(before.locator(".list.compact")).toHaveCount(0);
  await before.close();

  await showSection(opt, "appearance");
  await opt.locator("#look-density-compact").check();
  await opt.locator("#look-sort-name").check();
  await opt.locator("#look-hide").check();
  await expect(opt.locator("#appearance").getByText(/^(Saved|已保存)$/)).toBeVisible();
  const stored = await opt.evaluate(async () => (await chrome.storage.local.get("sk_settings")).sk_settings);
  expect(stored).toEqual({
    autoLock: { mode: "idle", minutes: 30 },
    lockOnScreenLock: true,
    display: { density: "compact", hideCodes: true, sort: "name" },
    profile: "solo", // QUICK-UNLOCK §5.12 item 5
  });

  const pop = await openPopup(p);
  await expect(pop.locator(".list.compact")).toBeVisible();
  await expect(pop.locator(".row .who b")).toHaveText(["Alpha", "Zeta"]);
  await expect(pop.locator(".row .code.hid")).toHaveCount(2);
  await pop.close();

  // back to the defaults, and the page shows what is stored
  await opt.locator("#look-density-standard").check();
  await opt.locator("#look-sort-manual").check();
  await opt.locator("#look-hide").uncheck();
  await expect
    .poll(() => opt.evaluate(async () => (await chrome.storage.local.get("sk_settings")).sk_settings))
    .toEqual({
      autoLock: { mode: "idle", minutes: 30 },
      lockOnScreenLock: true,
      display: { density: "standard", hideCodes: false, sort: "manual" },
      profile: "solo", // QUICK-UNLOCK §5.12 item 5
    });
  await opt.reload();
  await expect(opt.locator("#look-density-standard")).toBeChecked();
  await expect(opt.locator("#look-sort-manual")).toBeChecked();
  await expect(opt.locator("#look-hide")).not.toBeChecked();
  await showSection(opt, "security");
  await expect(opt.locator("#al-minutes")).toHaveValue("30");
});

test("the panel shows the shortcut that opens the popup, and opens Chrome's page to change it", async () => {
  await startFresh(p);
  const opt = await openOptions(p, "#appearance");
  await expect(opt.locator(".rail nav a[href='#appearance']")).toBeVisible();
  await expect(opt.locator("#look-shortcut")).toHaveText(/K/); // manifest: Alt+Shift+K, shown the way this platform writes it
  const [tab] = await Promise.all([p.ctx.waitForEvent("page"), opt.locator("#look-shortcut-edit").click()]);
  await expect.poll(() => tab.url()).toBe("chrome://extensions/shortcuts");
});
