// PHASE0X-PLAN C5: Settings > Security > Security mode. The two presets (src/core/service/presets.ts), Custom as soon as
// one bundled setting differs, the lock a change of lock mode causes, and the place the first-run wizard points to.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addByPaste,
  close,
  GITHUB_URI,
  launch,
  openOptions,
  openPopup,
  type Profile,
  showSection,
  startFresh,
  STRONG,
} from "./harness";

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

const settings = (page: Page) => page.evaluate(async () => (await chrome.storage.local.get("sk_settings")).sk_settings);
const saved = (page: Page) => expect(page.locator("#security-mode").getByText(/^(Saved|已保存)$/)).toBeVisible();
/** Every change made in the box is saved and the page shows the state after it (a change of lock mode locks Sixkey). */
const settled = (page: Page) => expect(page.locator("#security-mode")).not.toHaveAttribute("aria-busy", "true");
/** The page has read everything it shows (the rail's account count comes last): no reload will redraw it while we type. */
async function opened(page: Page): Promise<Page> {
  await expect(page.locator(".status dd.num")).toHaveText(/^\d+$/);
  return page;
}
async function unlockIfLocked(page: Page) {
  await settled(page);
  if (await page.locator("#unlock-pw").count()) {
    await page.locator("#unlock-pw").fill(STRONG);
    await page.locator("#unlock-btn").click();
    await expect(page.locator("#unlock-pw")).toHaveCount(0);
  }
}

test("Shared: locks every time and at once, and the popup hides codes; Standard brings back 15 idle minutes", async () => {
  await startFresh(p); // "only me" at first run: the standard preset
  await addByPaste(p, GITHUB_URI);
  const opt = await opened(await openOptions(p, "#security"));
  await expect(opt.locator("#sm-standard")).toBeChecked();
  await expect(opt.locator("#sm-shared")).not.toBeChecked();
  await expect(opt.locator("#sm-custom")).toHaveCount(0);

  await opt.locator("#sm-shared").check();
  await settled(opt);
  await saved(opt);
  await expect(opt.locator("#al-mode")).toHaveValue("always");
  await expect(opt.locator("#al-screen")).toBeChecked();
  await expect(opt.locator("#sm-hide")).toBeChecked();
  await expect(opt.locator("#sm-shared")).toBeChecked();
  // the change locked Sixkey (declared shared: a hard lock, quick unlock ends there), and the page says so where it was made
  await expect(opt.locator("#sm-locked")).toBeVisible();
  await expect(opt.locator("#unlock-pw")).toBeVisible();
  await showSection(opt, "appearance");
  await expect(opt.locator("#look-hide")).toBeChecked(); // the same setting in Appearance, kept in step
  await showSection(opt, "security");
  expect(await settings(opt)).toEqual({
    autoLock: { mode: "always" },
    lockOnScreenLock: true,
    display: { density: "standard", hideCodes: true, sort: "manual" },
    profile: "shared", // QUICK-UNLOCK §5.12 item 5
  });

  const pop = await openPopup(p);
  await expect(pop.locator("#secret")).toBeVisible(); // locked
  await pop.locator("#secret").fill(STRONG);
  await pop.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
  await expect(pop.locator(".row")).toHaveCount(1);
  await expect(pop.locator(".row .code.hid")).toHaveCount(1); // codes hidden
  await pop.close();

  await opt.locator("#unlock-pw").fill(STRONG);
  await opt.locator("#unlock-btn").click();
  await expect(opt.locator("#unlock-pw")).toHaveCount(0);
  await opt.locator("#sm-standard").check();
  await settled(opt);
  await saved(opt);
  await expect(opt.locator("#al-mode")).toHaveValue("idle");
  await expect(opt.locator("#al-minutes")).toHaveValue("15");
  await expect(opt.locator("#al-screen")).toBeChecked();
  await expect(opt.locator("#sm-hide")).not.toBeChecked();
  expect(await settings(opt)).toEqual({
    autoLock: { mode: "idle", minutes: 15 },
    lockOnScreenLock: true,
    display: { density: "standard", hideCodes: false, sort: "manual" },
    profile: "solo", // QUICK-UNLOCK §5.12 item 5
  });
});

test("changing any one bundled setting shows Custom; picking a mode again leaves it", async () => {
  await startFresh(p);
  const opt = await opened(await openOptions(p, "#security"));
  await expect(opt.locator("#sm-standard")).toBeChecked();

  const changes: [string, (o: Page) => Promise<void>][] = [
    [
      "idle minutes",
      async (o) => {
        await o.locator("#al-minutes").fill("30");
        await o.locator("#al-minutes").press("Enter");
      },
    ],
    ["screen lock", (o) => o.locator("#al-screen").uncheck()],
    ["hidden codes", (o) => o.locator("#sm-hide").check()],
    [
      "hidden codes, from Appearance",
      async (o) => {
        await showSection(o, "appearance");
        await o.locator("#look-hide").check();
        await showSection(o, "security");
      },
    ],
    [
      "lock mode",
      async (o) => {
        await o.locator("#al-mode").selectOption("session");
      },
    ],
  ];
  for (const [what, change] of changes) {
    await change(opt);
    await expect(opt.locator("#sm-custom"), what).toBeChecked();
    await expect(opt.locator("#sm-standard"), what).not.toBeChecked();
    await expect(opt.locator("#sm-shared"), what).not.toBeChecked();
    await unlockIfLocked(opt); // a change of lock mode locked it
    await opt.locator("#sm-standard").check();
    await expect(opt.locator("#sm-custom"), what).toHaveCount(0);
    await expect(opt.locator("#sm-standard"), what).toBeChecked();
    await unlockIfLocked(opt);
  }
  // Custom is a reading of the settings, not a stored choice: a new page shows the same
  await opt.locator("#al-minutes").fill("5");
  await opt.locator("#al-minutes").press("Enter");
  await expect(opt.locator("#sm-custom")).toBeChecked();
  await settled(opt);
  await opt.reload();
  await expect(opt.locator("#sm-custom")).toBeChecked();
  await expect(opt.locator("#al-minutes")).toHaveValue("5");
});

test("Security mode and Appearance change parts of one record without undoing each other", async () => {
  await startFresh(p);
  const opt = await opened(await openOptions(p, "#appearance"));
  await opt.locator("#look-density-compact").check();
  await expect(opt.locator("#appearance").getByText(/^(Saved|已保存)$/)).toBeVisible();
  await showSection(opt, "security");
  await opt.locator("#al-minutes").fill("45");
  await opt.locator("#al-minutes").press("Enter");
  await settled(opt);
  await saved(opt);
  await showSection(opt, "appearance");
  await opt.locator("#look-sort-name").check();
  await showSection(opt, "security");
  await opt.locator("#al-screen").uncheck();
  await expect
    .poll(() => settings(opt))
    .toEqual({
      autoLock: { mode: "idle", minutes: 45 },
      lockOnScreenLock: false,
      display: { density: "compact", hideCodes: false, sort: "name" },
      profile: "solo", // QUICK-UNLOCK §5.12 item 5
    });
  await expect(opt.locator("#al-minutes")).toHaveValue("45"); // nothing on the page went back either
  await showSection(opt, "appearance");
  await expect(opt.locator("#look-density-compact")).toBeChecked();
});

test("the first-run note's path is real: Settings › Security › Security mode, in both languages", async () => {
  // the wizard's note names the path with these very titles (frRiskNote)
  for (const lang of ["en", "zh_CN"]) {
    const m = JSON.parse(
      readFileSync(join(import.meta.dirname, `../../_locales/${lang}/messages.json`), "utf8"),
    ) as Record<string, { message: string }>;
    expect(m.frRiskNote!.message, lang).toContain(
      [m.settings!.message, m.secTitle!.message, m.smTitle!.message].join(" › "),
    );
  }
  await startFresh(p);
  const opt = await openOptions(p);
  for (const [lang, path] of [
    ["en", ["Settings", "Security", "Security mode"]],
    ["zh_CN", ["设置", "安全", "安全模式"]],
  ] as const) {
    await opt.evaluate((l) => localStorage.setItem("sk_lang", l), lang);
    await opt.reload();
    await expect(opt.locator("h1")).toHaveText(path[0]);
    // the path's "Security" is the rail's group; the leaf that holds the Security mode is Locking (its tab and its heading)
    await expect(opt.locator("#security > header h2")).toHaveText(lang === "en" ? "Locking" : "锁定");
    await expect(opt.locator('.subnav a[href="#security"]')).toHaveText(lang === "en" ? "Locking" : "锁定");
    await expect(opt.locator("#security #security-mode h3")).toHaveText(path[2]);
    await expect(opt.locator(`.rail nav a[href="#security"]`)).toHaveText(path[1]);
  }
});
