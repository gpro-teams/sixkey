// The View menu (docs/design/notes/QUICKVIEW-NOTES.md): Settings > Appearance's four choices (theme, rows, order, hidden
// codes) one click from the popup's search field, and in the side panel. Each is checked where the owner would look: it
// applies at once, it is kept where Settings keeps it, Settings shows it, and a change made in Settings shows in the open
// popup or panel. The menu's own manners (Escape, outside click, Tab, keys that belong to the list) and the screenshots
// the visual guard does not keep (SK_SHOTS=<dir> saves them) are here too.
import { chromium, expect, test, type Locator, type Page } from "@playwright/test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import {
  acceptable,
  addByPaste,
  AWS_URI,
  close,
  DIST,
  GITHUB_URI,
  launch,
  openOptions,
  openPopup,
  SECRET,
  startFresh,
  type Profile,
} from "./harness";
import { pageTextAndAttributes } from "./list-helpers";
import { closeDriven, drive, launchDriven, type Driver } from "./panel-helpers";

const ACME_URI = "otpauth://totp/Acme:zed?secret=JBSWY3DPEHPK3PXQ&issuer=Acme";
const AWS_SECRET = "JBSWY3DPEHPK3PXP";
const ACME_SECRET = "JBSWY3DPEHPK3PXQ";

let server: Server;
let port = 0;
test.beforeAll(async () => {
  server = createServer((_, r) => {
    r.setHeader("content-type", "text/html");
    r.end("<!doctype html><title>a page</title><h1>a page</h1>");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  port = (server.address() as { port: number }).port;
});
test.afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

type Display = { density: string; hideCodes: boolean; sort: string };
/** The settings record as stored (what Settings > Appearance and the menu both write). */
const stored = (page: Page) =>
  page.evaluate(async () => (await chrome.storage.local.get("sk_settings")).sk_settings as Record<string, unknown>);
const displayOf = async (page: Page) => (await stored(page)).display as Display;
const names = (page: Page) => page.locator(".row .who b").allTextContents();
const choice = (page: Page, id: string): Locator => page.locator(`#view-${id}`);

/** Every code a correct app could show for the three accounts right now, whole and split in two as displayed. */
async function allCodes(): Promise<string[]> {
  const codes = [
    ...(await acceptable(SECRET)),
    ...(await acceptable(AWS_SECRET, 8)),
    ...(await acceptable(ACME_SECRET)),
  ];
  return codes.flatMap((c) => [c, `${c.slice(0, c.length / 2)} ${c.slice(c.length / 2)}`]);
}
async function expectNoCodeInPage(page: Page) {
  const seen = await pageTextAndAttributes(page);
  for (const c of await allCodes()) expect(seen, "a code is in the page").not.toContain(c.replace(/\s/g, ""));
}

/** A vault with three accounts, added in the order GitHub, AWS, Acme (by name they read Acme, AWS, GitHub). */
async function withAccounts() {
  await startFresh(p);
  await addByPaste(p, [GITHUB_URI, AWS_URI, ACME_URI].join("\n"));
}

/** Save a screenshot when SK_SHOTS names a directory (the visual guard keeps none). */
async function shot(page: Page, name: string) {
  const dir = process.env.SK_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

test("the four choices apply at once, are kept where Settings keeps them, and Settings shows them", async () => {
  test.setTimeout(120_000);
  await withAccounts();
  const pop = await openPopup(p);
  await expect(pop.locator(".row")).toHaveCount(3);
  const before = await stored(pop);

  // the button: named, collapsed, and nothing of the menu is in the page until it is opened
  const toggle = pop.locator("#view-toggle");
  await expect(toggle).toHaveAccessibleName("Appearance");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAttribute("aria-haspopup", "dialog");
  await expect(pop.locator(".vw-pop")).toHaveCount(0);
  await toggle.click();
  const menu = pop.locator(".vw-pop");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAccessibleName("Appearance");
  await expect(menu).toHaveAttribute("role", "dialog");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(choice(pop, "theme-auto")).toBeFocused(); // the focus is in, on the chosen theme
  // the defaults, as Settings has them
  for (const id of ["theme-auto", "density-standard", "sort-manual"]) await expect(choice(pop, id)).toBeChecked();
  await expect(choice(pop, "hide")).not.toBeChecked();
  await shot(pop, "menu-popup-light");

  // theme: the page at once, and the same key Settings reads
  await choice(pop, "theme-dark").check();
  await expect(pop.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await pop.evaluate(() => localStorage.getItem("sk_theme"))).toBe("dark");
  await shot(pop, "menu-popup-dark");
  await choice(pop, "theme-light").check();
  await expect(pop.locator("html")).toHaveAttribute("data-theme", "light");
  await choice(pop, "theme-auto").check();
  await expect(pop.locator("html")).not.toHaveAttribute("data-theme", /.*/);
  expect(await pop.evaluate(() => localStorage.getItem("sk_theme"))).toBeNull();
  await choice(pop, "theme-dark").check();

  // rows
  await expect(pop.locator(".list.compact")).toHaveCount(0);
  await choice(pop, "density-compact").check();
  await expect(pop.locator(".list.compact")).toHaveCount(1);
  expect((await displayOf(pop)).density).toBe("compact");

  // order: by name; back to the order the accounts were dragged into
  expect(await names(pop)).toEqual(["GitHub", "AWS", "Acme"]);
  await choice(pop, "sort-name").check();
  await expect.poll(() => names(pop)).toEqual(["Acme", "AWS", "GitHub"]);
  expect((await displayOf(pop)).sort).toBe("name");

  // hidden codes: not a digit in the page, and a click still copies
  await expect(pop.locator(".row .code:not(.hid):not(.wait)").first()).toBeVisible();
  await choice(pop, "hide").check();
  await expect(pop.locator(".row .code.hid")).toHaveCount(3);
  await expectNoCodeInPage(pop);
  expect((await displayOf(pop)).hideCodes).toBe(true);
  await shot(pop, "menu-popup-hidden");

  // nothing but `display` was written: the lock rules and the profile are as they were (no lock from here)
  const after = await stored(pop);
  expect({ ...after, display: undefined }).toEqual({ ...before, display: undefined });
  expect(after.display).toEqual({ density: "compact", hideCodes: true, sort: "name" });

  // Settings shows all four, and the popup opened again does too
  const opt = await openOptions(p, "#appearance");
  await expect(opt.locator("#look-theme-dark")).toBeChecked();
  await expect(opt.locator("#look-density-compact")).toBeChecked();
  await expect(opt.locator("#look-sort-name")).toBeChecked();
  await expect(opt.locator("#look-hide")).toBeChecked();
  const again = await openPopup(p);
  await expect(again.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(again.locator(".list.compact")).toHaveCount(1);
  await expect.poll(() => names(again)).toEqual(["Acme", "AWS", "GitHub"]);
  await expect(again.locator(".row .code.hid")).toHaveCount(3);
  await again.locator("#view-toggle").click();
  for (const id of ["theme-dark", "density-compact", "sort-name", "hide"])
    await expect(choice(again, id)).toBeChecked();
  await again.close();

  // ... and back, from Settings: the open menu and the open list follow (the popup is open beside the settings page here;
  // the real popup closes when it loses the focus, the side panel is the page that stays open: tested below)
  await opt.locator("#look-density-standard").check();
  await opt.locator("#look-sort-manual").check();
  await opt.locator("#look-hide").uncheck();
  await opt.locator("#look-theme-light").check();
  await expect(choice(pop, "density-standard")).toBeChecked();
  await expect(choice(pop, "sort-manual")).toBeChecked();
  await expect(choice(pop, "hide")).not.toBeChecked();
  await expect(choice(pop, "theme-light")).toBeChecked();
  await expect(pop.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(pop.locator(".list.compact")).toHaveCount(0);
  await expect.poll(() => names(pop)).toEqual(["GitHub", "AWS", "Acme"]);
  await expect(pop.locator(".row .code.hid")).toHaveCount(0);
  await opt.close();
});

test("Hide codes keeps the meaning it has: nothing in the page, a click copies without showing, Space shows one code, hiding again ends a reveal", async () => {
  test.setTimeout(120_000);
  await withAccounts();
  const pop = await openPopup(p);
  await expect(pop.locator(".row")).toHaveCount(3);
  await pop.locator("#view-toggle").click();
  await choice(pop, "hide").check();
  await expect(pop.locator(".row .code.hid")).toHaveCount(3);
  // the box is focused: Space toggles it, it does not show a code behind it
  await choice(pop, "hide").focus();
  await pop.keyboard.press("Space");
  await expect(choice(pop, "hide")).not.toBeChecked();
  await expect(pop.locator(".row .code.hid")).toHaveCount(0);
  await pop.keyboard.press("Space");
  await expect(choice(pop, "hide")).toBeChecked();
  await expect(pop.locator(".row .code.hid")).toHaveCount(3);
  await pop.waitForTimeout(300);
  await expectNoCodeInPage(pop);
  await pop.keyboard.press("Escape");
  await expect(pop.locator(".vw-pop")).toHaveCount(0);

  // on the list: Space shows the selected row's code, for 5 seconds
  const first = pop.locator(".row").first();
  await first.locator(".copy").focus();
  await pop.keyboard.press("Space");
  await expect(first.locator(".code:not(.hid):not(.wait)")).toBeVisible();
  await expect(pop.locator(".row .code.hid")).toHaveCount(2);

  // a code shown, then hidden again from the menu and shown by the same Space: the reveal is over, not resumed
  await pop.locator("#view-toggle").click();
  await choice(pop, "hide").uncheck();
  await expect(pop.locator(".row .code.hid")).toHaveCount(0);
  await choice(pop, "hide").check();
  await expect(pop.locator(".row .code.hid")).toHaveCount(3);
  await pop.waitForTimeout(300);
  await expectNoCodeInPage(pop);

  // a click still copies, and shows nothing
  await pop.keyboard.press("Escape");
  await first.locator(".copy").click();
  await expect(pop.locator(".toast")).toBeVisible();
  const copied = await pop.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/^\d{6,8}$/);
  await expect(pop.locator(".row .code.hid")).toHaveCount(3);
  await expectNoCodeInPage(pop);
});

test("the menu's manners: Escape, a press outside and the button close it; Tab goes round it; its keys are not the list's", async () => {
  test.setTimeout(90_000);
  await withAccounts();
  const pop = await openPopup(p);
  await expect(pop.locator(".row")).toHaveCount(3);
  const toggle = pop.locator("#view-toggle");
  const menu = pop.locator(".vw-pop");
  const open = async () => {
    await toggle.click();
    await expect(menu).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  };
  const closed = async () => {
    await expect(menu).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  };

  // the button toggles
  await open();
  await toggle.click();
  await closed();
  // Escape closes, and the focus is on the button again
  await open();
  await pop.keyboard.press("Escape");
  await closed();
  await expect(toggle).toBeFocused();
  // a press outside closes it (and does not do anything else with the press: here, a click on the search field's text)
  await open();
  await pop.locator(".ph").click();
  await closed();
  await open();
  await pop.locator("#q").click();
  await closed();
  await expect(pop.locator("#q")).toBeFocused();
  // the keyboard opens it: Enter on the button; Escape with the focus in the search field is the list's (clears it)
  await toggle.focus();
  await pop.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await pop.keyboard.press("Escape");
  await closed();

  // Tab goes round the menu: theme, rows, order, the box, and then the theme again; Shift+Tab goes the other way
  await open();
  const at = () => pop.evaluate(() => document.activeElement?.id ?? "");
  expect(await at()).toBe("view-theme-auto");
  await pop.keyboard.press("Tab");
  expect(await at()).toBe("view-density-standard");
  await pop.keyboard.press("Tab");
  expect(await at()).toBe("view-sort-manual");
  await pop.keyboard.press("Tab");
  expect(await at()).toBe("view-hide");
  await pop.keyboard.press("Tab");
  expect(await at()).toBe("view-theme-auto");
  await pop.keyboard.press("Shift+Tab");
  expect(await at()).toBe("view-hide");
  await pop.keyboard.press("Shift+Tab");
  expect(await at()).toBe("view-sort-manual");
  // arrow keys move between the choices of one row and choose (a radio group), and not the list's selection
  await pop.keyboard.press("Shift+Tab");
  await pop.keyboard.press("Shift+Tab");
  expect(await at()).toBe("view-theme-auto");
  const selected = await pop.locator(".row.sel").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id));
  await pop.keyboard.press("ArrowRight");
  expect(await at()).toBe("view-theme-light");
  await expect(pop.locator("html")).toHaveAttribute("data-theme", "light");
  await pop.keyboard.press("ArrowDown");
  expect(await at()).toBe("view-theme-dark");
  await pop.keyboard.press("ArrowUp");
  await pop.keyboard.press("ArrowUp");
  expect(await at()).toBe("view-theme-auto");
  expect(await pop.locator(".row.sel").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id))).toEqual(
    selected,
  );

  // Enter, a letter and Home do not reach the list: nothing is copied, the search box stays empty, the focus stays
  await pop.keyboard.press("Enter");
  await pop.keyboard.press("g");
  await pop.keyboard.press("Home");
  await expect(pop.locator(".toast")).toHaveCount(0);
  await expect(pop.locator("#q")).toHaveValue("");
  expect(await at()).toBe("view-theme-auto");
  await expect(menu).toBeVisible();
  // the clipboard was not written
  await pop.evaluate(() => navigator.clipboard.writeText("untouched"));
  await pop.keyboard.press("Enter");
  expect(await pop.evaluate(() => navigator.clipboard.readText())).toBe("untouched");
  await pop.keyboard.press("Escape");
  await closed();

  // the menu belongs to the list: a paste that opens the confirm page (focus not in a field) takes it away, and it does not
  // come back with the list
  await open();
  await pop.evaluate((text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, "otpauth://totp/Fresh:me?secret=JBSWY3DPEHPK3PXR&issuer=Fresh");
  await expect(pop.locator("#pa-add")).toBeVisible();
  await expect(pop.locator(".vw-pop")).toHaveCount(0);
  await pop
    .getByRole("button", { name: /Back|返回/ })
    .first()
    .click();
  await expect(pop.locator("#q")).toBeVisible();
  await expect(pop.locator(".vw-pop")).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // after Escape the list's keys are the list's again: "/" goes to the search field
  await pop.keyboard.press("/");
  await expect(pop.locator("#q")).toBeFocused();
});

test("in the side panel: the menu works, and a change made in Settings shows in the open panel (menu and list)", async () => {
  test.setTimeout(150_000);
  await withAccounts();
  const lang = await openPopup(p);
  await lang.evaluate(() => localStorage.setItem("sk_lang", "zh_CN"));
  await lang.close();
  const panel = await p.ctx.newPage();
  await panel.setViewportSize({ width: 360, height: 720 });
  await panel.goto(`chrome-extension://${p.id}/sidepanel/index.html`);
  await expect(panel.locator(".row")).toHaveCount(3);
  const toggle = panel.locator("#view-toggle");
  await expect(toggle).toHaveAccessibleName("外观");
  await toggle.click();
  await expect(panel.locator(".vw-pop")).toBeVisible();
  await expect(panel.getByText("隐藏验证码", { exact: true })).toBeVisible();
  await expect(panel.getByRole("radio", { name: "按名称" })).toBeVisible();
  await shot(panel, "menu-panel-zh");
  await choice(panel, "sort-name").check();
  await expect.poll(() => names(panel)).toEqual(["Acme", "AWS", "GitHub"]);
  await choice(panel, "hide").check();
  await expect(panel.locator(".row .code.hid")).toHaveCount(3);
  expect(await displayOf(panel)).toEqual({ density: "standard", hideCodes: true, sort: "name" });

  // Settings, in another tab, changes all four: the panel's menu and list follow, the theme with the menu closed too
  const opt = await openOptions(p, "#appearance");
  await expect(opt.locator("#look-sort-name")).toBeChecked();
  await expect(opt.locator("#look-hide")).toBeChecked();
  await opt.locator("#look-sort-manual").check();
  await opt.locator("#look-density-compact").check();
  await opt.locator("#look-hide").uncheck();
  await opt.locator("#look-theme-dark").check();
  await expect(choice(panel, "sort-manual")).toBeChecked();
  await expect(choice(panel, "density-compact")).toBeChecked();
  await expect(choice(panel, "hide")).not.toBeChecked();
  await expect(choice(panel, "theme-dark")).toBeChecked();
  await expect.poll(() => names(panel)).toEqual(["GitHub", "AWS", "Acme"]);
  await expect(panel.locator(".list.compact")).toHaveCount(1);
  await expect(panel.locator(".row .code.hid")).toHaveCount(0);
  await expect(panel.locator("html")).toHaveAttribute("data-theme", "dark");
  await panel.keyboard.press("Escape");
  await expect(panel.locator(".vw-pop")).toHaveCount(0);
  await opt.locator("#look-theme-light").check(); // the menu is closed: the theme still follows
  await expect(panel.locator("html")).toHaveAttribute("data-theme", "light");

  // the menu changes what an open settings page shows, too (it is open beside the panel)
  await toggle.click();
  await choice(panel, "density-standard").check();
  await choice(panel, "theme-auto").check();
  await expect(opt.locator("#look-density-standard")).toBeChecked();
  await expect(opt.locator("#look-theme-auto")).toBeChecked();
  await opt.close();

  // a lock made elsewhere takes the open menu with the list; it does not come back with the list
  await expect(panel.locator(".vw-pop")).toBeVisible();
  const pop = await openPopup(p);
  await pop.locator("#lock-now").click();
  await expect(panel.locator("#secret")).toBeVisible();
  await expect(panel.locator(".vw-pop")).toHaveCount(0);
  await expect(panel.locator("#view-toggle")).toHaveCount(0);
  await pop.close();
});

test("in the real side panel: the toolbar icon opens it, and its menu changes the list", async () => {
  test.setTimeout(150_000);
  await close(p);
  p = await launchDriven();
  let d: Driver | undefined;
  try {
    await startFresh(p);
    await addByPaste(p, [GITHUB_URI, AWS_URI, ACME_URI].join("\n"));
    const opt = await openOptions(p, "#appearance");
    await opt.locator("#look-open-panel").check();
    await expect.poll(() => p.ctx.serviceWorkers()[0]!.evaluate(() => chrome.action.getPopup({}))).toBe("");
    const site = await p.ctx.newPage();
    await site.goto(`http://127.0.0.1:${port}/`);
    d = await drive(p);
    await d.clickIcon(`127.0.0.1:${port}`);
    const panel = await d.panel();
    await panel.until("document.querySelectorAll('.row').length === 3", "the list, in the panel");
    await panel.eval("document.querySelector('#view-toggle').click()");
    await panel.until("document.querySelector('.vw-pop') && document.querySelector('#view-hide')", "the menu");
    expect(await panel.eval("document.activeElement.id")).toBe("view-theme-auto");
    await panel.eval("document.querySelector('#view-hide').click()");
    await panel.until("document.querySelectorAll('.row .code.hid').length === 3", "codes hidden in the panel");
    await panel.eval("document.querySelector('#view-sort-name').click()");
    await panel.until(
      "[...document.querySelectorAll('.row .who b')].map((b) => b.textContent).join() === 'Acme,AWS,GitHub'",
      "sorted by name in the panel",
    );
    await panel.eval("document.querySelector('#view-theme-dark').click()");
    await panel.until("document.documentElement.getAttribute('data-theme') === 'dark'", "dark in the panel");
    // Settings (a tab beside the panel) shows what the panel's menu chose
    await expect(opt.locator("#look-hide")).toBeChecked();
    await expect(opt.locator("#look-sort-name")).toBeChecked();
    await expect(opt.locator("#look-theme-dark")).toBeChecked();
    // ... and the other way: unhiding in Settings shows the codes in the panel, whose menu is open
    await opt.locator("#look-hide").uncheck();
    await panel.until("document.querySelectorAll('.row .code.hid').length === 0", "codes shown again in the panel");
    await panel.until("!document.querySelector('#view-hide').checked", "the panel's menu follows");
    await opt.close();
    await site.close();
  } finally {
    await closeDriven(p, d);
    p = await launch(); // for afterEach
  }
});

test("a short window (a high zoom, a short side panel) cuts nothing off: the menu scrolls to its last line", async () => {
  test.setTimeout(90_000);
  await withAccounts();
  const pop = await openPopup(p);
  await expect(pop.locator(".row")).toHaveCount(3);
  for (const [w, h] of [
    [376, 343], // the popup at 175% zoom
    [320, 320], // a short side panel
  ] as const) {
    await pop.setViewportSize({ width: w, height: h });
    await pop.locator("#view-toggle").click();
    const menu = pop.locator(".vw-pop");
    await expect(menu).toBeVisible();
    const box = await menu.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { bottom: r.bottom, h: innerHeight, scrolls: el.scrollHeight > el.clientHeight };
    });
    expect(box.bottom, `${w}x${h}: the menu ends inside the window`).toBeLessThanOrEqual(box.h);
    await menu.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const hint = await pop.locator("#view-hide-note").evaluate((el) => {
      const r = el.getBoundingClientRect();
      const m = el.closest(".vw-pop")!.getBoundingClientRect();
      return { bottom: r.bottom, menuBottom: m.bottom, h: innerHeight };
    });
    expect(hint.bottom, `${w}x${h}: the last line is reachable`).toBeLessThanOrEqual(Math.min(hint.menuBottom, hint.h));
    await pop.keyboard.press("Escape");
  }
});

/** A profile launched from a private copy of the e2e build, so a chunk can be taken away after the vault is made. */
async function launchFromCopy() {
  const dist = mkdtempSync(join(tmpdir(), "sixkey-quickview-dist-"));
  cpSync(DIST, dist, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "sixkey-e2e-"));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    acceptDownloads: true,
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const prof: Profile = { dir, ctx, id: new URL(sw.url()).host };
  const take = (re: RegExp) => {
    const gone = readdirSync(join(dist, "assets")).filter((n) => re.test(n));
    expect(gone.length, `${re} is in the build`).toBeGreaterThan(0);
    for (const n of gone) unlinkSync(join(dist, "assets", n));
  };
  return {
    prof,
    take,
    done: async () => {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(dist, { recursive: true, force: true });
    },
  };
}

test("a lazy chunk that cannot be loaded: a toast for the menu and the add view, the menu's own line when its text is gone, and the page's text untouched", async () => {
  test.setTimeout(180_000);
  await close(p);
  const l = await launchFromCopy();
  p = await launch(); // for afterEach
  try {
    await startFresh(l.prof);
    await addByPaste(l.prof, [GITHUB_URI, AWS_URI].join("\n"));
    const lang = await openPopup(l.prof);
    await lang.evaluate(() => localStorage.setItem("sk_lang", "zh_CN"));
    await lang.close();

    // the menu's text: neither language's chunk. The menu opens and says so; every other word of the popup stays Chinese.
    l.take(/^view-locale-(en|zh_CN)-/);
    const pop = await openPopup(l.prof);
    await expect(pop.locator(".row")).toHaveCount(2);
    await pop.locator("#view-toggle").click();
    await expect(pop.locator(".vw-pop [role=alert]")).toHaveText("发生了意外错误");
    await expect(pop.locator(".vw-pop input")).toHaveCount(0);
    await expect(pop.locator("#q")).toHaveAttribute("placeholder", "输入即搜索");
    await expect(pop.locator(".pf")).toContainText("2 个账户");
    await pop.keyboard.press("Escape");
    await expect(pop.locator(".vw-pop")).toHaveCount(0);
    await expect(pop.locator("#q")).toHaveAttribute("placeholder", "输入即搜索");

    // the menu's code: the button says so with the page's toast and nothing opens
    l.take(/^View-[\w-]+\.js$/);
    const again = await openPopup(l.prof);
    await expect(again.locator(".row")).toHaveCount(2);
    await again.locator("#view-toggle").click();
    await expect(again.locator(".toast")).toContainText("发生了意外错误");
    await expect(again.locator(".vw-pop")).toHaveCount(0);
    await expect(again.locator("#view-toggle")).toHaveAttribute("aria-expanded", "false");

    // the add view: the same, and the list is back
    l.take(/^AddMenu-[\w-]+\.js$/);
    await again.locator(".pf .add").click();
    await expect(again.locator(".toast")).toContainText("发生了意外错误");
    await expect(again.locator("#q")).toBeVisible();
    await expect(again.locator("#pa-box")).toHaveCount(0);
  } finally {
    await l.done();
  }
});

test("shots: the menu at the popup's width and the panel's, light and dark, English and Chinese", async () => {
  test.skip(!process.env.SK_SHOTS, "set SK_SHOTS=<directory> to save them");
  test.setTimeout(240_000);
  await withAccounts();
  for (const lang of ["en", "zh_CN"] as const) {
    const w = await openPopup(p);
    await w.evaluate((l) => localStorage.setItem("sk_lang", l), lang);
    await w.close();
    for (const [width, kind] of [
      [376, "popup"],
      [320, "panel"],
      [420, "panel"],
      [600, "panel"],
    ] as const) {
      const page = await p.ctx.newPage();
      await page.setViewportSize({ width, height: kind === "popup" ? 560 : 720 });
      await page.goto(`chrome-extension://${p.id}/${kind === "popup" ? "popup" : "sidepanel"}/index.html`);
      await expect(page.locator(".row .code:not(.wait)").first()).toBeVisible();
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.locator("#view-toggle").click();
        await expect(page.locator(".vw-pop")).toBeVisible();
        await page.waitForTimeout(300); // the field's focus ring fades out
        await shot(page, `${kind}-${width}-${lang}-${scheme}`);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
        if (width === 376) await shot(page, `${kind}-${width}-${lang}-${scheme}-closed-focus`);
      }
      await page.close();
    }
  }
  // over a compact list with the codes hidden, by name
  const page = await p.ctx.newPage();
  await page.setViewportSize({ width: 376, height: 560 });
  await page.goto(`chrome-extension://${p.id}/popup/index.html`);
  await page.locator("#view-toggle").click();
  await choice(page, "density-compact").check();
  await choice(page, "sort-name").check();
  await choice(page, "hide").check();
  await expect(page.locator(".row .code.hid")).toHaveCount(3);
  await page.waitForTimeout(300);
  await shot(page, "popup-376-compact-hidden-name");
  await page.close();
});
