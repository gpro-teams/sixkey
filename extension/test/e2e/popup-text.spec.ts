// The popup-only catalog (scripts/catalog-keys.mjs, scripts/build.mjs): the popup ships only the message keys its code
// can use, so a key the collector missed would show as its name. This walks the popup's screens in both languages,
// the confirm page (a lazy chunk) in each of its states, the edit and "remember this site" sheets, the toasts, the lock
// screen in both modes with its errors, the security notice, the "data restored" banner, the unreadable-data and error
// screens, and checks each for key names: in the page's text (text-helpers.ts) and through the e2e build's console guard
// (src/ui/i18n.ts, harness.ts), which reports every t() of a key the catalog lacks. Not reachable here: the "newer
// version" screen (it needs a vault written by a newer schema; errors.ts maps it, test/unit/i18n-popup.test.ts checks
// that text) and the install-source banner (prod build only; install-source.spec.ts checks it).
import { expect, test, type Page } from "@playwright/test";
import {
  addByPaste,
  AWS_URI,
  close,
  GITHUB_URI,
  launch,
  missingTextOf,
  openPopup,
  startFresh,
  type Profile,
} from "./harness";
import { guessWrong, lockPopup, unlockPopup } from "./security-helpers";
import { expectNoRawKeys } from "./text-helpers";

const HOTP_URI = "otpauth://hotp/Counter:bob?secret=GEZDGNBVGY3TQOJQ&issuer=Counter&counter=0";
const NEW_URI = "otpauth://totp/Example:carol?secret=MFRGGZDFMZTWQ2LK&issuer=Example";
const GITHUB_NEW_KEY = "otpauth://totp/GitHub:alice@example.com?secret=ONSWG4TFORZWK3TU&issuer=GitHub";
const AWS_KEY_OTHER_NAME = "otpauth://totp/Mirror:dave?secret=JBSWY3DPEHPK3PXP&issuer=Mirror";
const BAD_LINE = "otpauth://totp/Bad:x?secret=1&issuer=Bad";

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

/** Both checks, now: no key name in the page, and nothing the guard reported on any page of the profile. */
async function look(page: Page, where: string): Promise<void> {
  await expectNoRawKeys(page, where);
  expect(missingTextOf(p), `console guard, ${where}`).toEqual([]);
}

/**
 * The popup, as if opened over https://github.com/login: a popup opened as a tab has no current page (site.spec.ts), so
 * the active-tab query is answered here, which brings in the site sections and "remember this site".
 */
async function popupOnGithub(): Promise<Page> {
  const page = await p.ctx.newPage();
  await page.addInitScript(() => {
    const real = chrome.tabs.query.bind(chrome.tabs);
    const fake = (async (q: chrome.tabs.QueryInfo) =>
      q?.active ? [{ url: "https://github.com/login" }] : real(q)) as typeof chrome.tabs.query;
    Object.defineProperty(chrome.tabs, "query", { configurable: true, value: fake });
  });
  await page.goto(`chrome-extension://${p.id}/popup/index.html`);
  return page;
}

/** Type `text` into the add view's paste zone and wait for the confirm page (from the list, opens the add view first). */
async function confirmPage(pop: Page, text: string): Promise<void> {
  if (!(await pop.locator("#pa-box").isVisible())) await pop.locator(".pf .add").click();
  await expect(pop.locator("#pa-box")).toBeFocused();
  await pop.locator("#pa-box").fill(text);
  await pop.locator("#pa-box").press("Enter");
  await expect(pop.locator(".cf")).toBeVisible();
  await expect(pop.locator(".cf .cf-line.muted[role=status]")).toHaveCount(0); // done reading
}
/** The confirm page's header button: back to the add view. */
async function leaveConfirm(pop: Page): Promise<void> {
  await pop.locator(".ph .back").click();
  await expect(pop.locator("#pa-box")).toBeVisible();
}

for (const lang of ["en", "zh_CN"] as const) {
  test(`${lang}: every popup screen shows its text, never a message key`, async () => {
    test.setTimeout(180_000);
    // The language for every page of this profile (localStorage is the extension's, shared by its pages).
    const first = await openPopup(p);
    await first.evaluate((l) => localStorage.setItem("sk_lang", l), lang);
    await first.reload();
    await expect(first.locator("html")).toHaveAttribute("lang", lang === "zh_CN" ? "zh-CN" : "en");
    await expect(first.locator("#start-secure")).toBeVisible();
    await look(first, "the welcome screen");
    // the unreadable-data screen, on this new profile: data that cannot be read and no other copy to recover from
    await first.evaluate(() => chrome.storage.local.set({ sk_active: "a", sk_slot_a: { torn: "half a write" } }));
    await first.reload();
    await expect(first.locator("h1.prompt")).toBeVisible();
    await expect(first.locator("#start-secure")).toHaveCount(0);
    await look(first, "the unreadable-data screen");
    await first.evaluate(() => chrome.storage.local.clear());
    await first.close();

    await startFresh(p); // the first run, on the settings page: watched by the guard as well
    await addByPaste(p, `${GITHUB_URI}\n${AWS_URI}\n${HOTP_URI}`);
    const pop = await popupOnGithub();
    await expect(pop.locator(".row")).toHaveCount(3);
    await expect(pop.locator(".row .code:not(.wait)").first()).toBeVisible();
    await look(pop, "the list, with a current site, an HOTP row and the backup reminder");

    // search: no match, then a match
    await pop.locator("#q").fill("zzzz");
    await expect(pop.locator(".row")).toHaveCount(0);
    await look(pop, "a search with no match");
    await pop.locator("#q").fill("a");
    await expect(pop.locator(".row").first()).toBeVisible();
    await look(pop, "search results");
    await pop.locator("#q").press("Escape");
    await expect(pop.locator(".row")).toHaveCount(3);

    // copying: the toast and the clipboard countdown
    const github = pop.locator(".row", { has: pop.locator(".who b", { hasText: "GitHub" }) });
    await github.locator(".copy").click();
    await expect(pop.locator(".toast")).toBeVisible();
    await expect(pop.locator(".clip")).toBeVisible();
    await look(pop, "the copy toast and the clipboard countdown");

    // "remember this site"
    await github.hover();
    await github.locator(".remember").click();
    await expect(pop.locator(".sheet.rm")).toBeVisible();
    await look(pop, "the remember-this-site sheet");
    await pop
      .locator(".sheet.rm")
      .getByRole("button", { name: /^(Cancel|取消)$/ })
      .click();
    await expect(pop.locator(".sheet.rm")).toHaveCount(0);

    // the edit sheet, with a refused site and the delete confirmation
    await github.hover();
    await github.locator(".more").click();
    await expect(pop.locator("#e-issuer")).toBeVisible();
    await look(pop, "the edit sheet");
    await pop.locator("#e-site").fill("co.uk");
    await pop.locator("#e-site").press("Enter");
    await expect(pop.locator("#e-site-note.err")).toBeVisible();
    await pop.getByRole("button", { name: /^(Delete|删除)$/ }).click();
    await look(pop, "the edit sheet with a refused site and the delete confirmation");
    await pop.getByRole("button", { name: /^(Cancel|取消)$/ }).click();
    await expect(pop.locator("#e-issuer")).toHaveCount(0);

    // the add view, then the confirm page in each state
    await pop.locator(".pf .add").click();
    await expect(pop.locator("#pa-box")).toBeFocused();
    await look(pop, "the add view");
    await pop.locator(".ph .back").click();

    await confirmPage(pop, NEW_URI);
    await expect(pop.locator("#pa-issuer")).toHaveValue("Example");
    await look(pop, "the confirm page: a new account");
    await leaveConfirm(pop);

    await confirmPage(pop, GITHUB_URI);
    await expect(pop.locator("#pa-verdict")).toBeVisible();
    await look(pop, "the confirm page: already there");
    await leaveConfirm(pop);

    await confirmPage(pop, GITHUB_NEW_KEY);
    await expect(pop.locator("#pa-keep")).toBeVisible();
    await look(pop, "the confirm page: the same account with a new key");
    await leaveConfirm(pop);

    await confirmPage(pop, AWS_KEY_OTHER_NAME);
    await expect(pop.locator("#pa-verdict")).toBeVisible();
    await look(pop, "the confirm page: a key already saved under another name");
    await leaveConfirm(pop);

    await confirmPage(pop, `${NEW_URI}\n${HOTP_URI}\n${BAD_LINE}`);
    await expect(pop.locator("#pa-list")).toBeVisible();
    await expect(pop.locator(".cf-line.err")).toHaveCount(1);
    await look(pop, "the confirm page: a list, with a skipped line and an HOTP account");
    await leaveConfirm(pop);

    await confirmPage(pop, BAD_LINE);
    await expect(pop.locator(".cf-alert.bad")).toBeVisible();
    await look(pop, "the confirm page: one line that cannot be used");
    await leaveConfirm(pop);

    await confirmPage(pop, "hello there, nothing to add");
    await expect(pop.locator(".cf-alert.bad")).toBeVisible();
    await look(pop, "the confirm page: nothing found");
    await leaveConfirm(pop);

    await confirmPage(pop, "GitHub|JBSWY3DPEHPK3PXP|a password\nAWS|GEZDGNBVGY3TQOJQ|another");
    await expect(pop.locator("#pa-settings")).toBeVisible();
    await look(pop, "the confirm page: columns");
    await leaveConfirm(pop);

    await confirmPage(pop, NEW_URI);
    await look(pop, "the confirm page again, from the add view");
    await pop.locator("#pa-add-copy").click();
    await expect(pop.locator(".row")).toHaveCount(4);
    await expect(pop.locator(".toast")).toBeVisible();
    await look(pop, "the list after adding, with its toast");

    // the lock screen: password, a wrong one, the recovery code, a malformed one
    await lockPopup(pop);
    await look(pop, "the lock screen");
    await guessWrong(pop, 2);
    await expect(pop.getByRole("alert")).toBeVisible();
    await look(pop, "the lock screen after a wrong password");
    await pop.getByRole("button", { name: /^(Use recovery key|使用恢复密钥)$/ }).click();
    await expect(pop.locator("#forgot-password")).toBeVisible();
    await look(pop, "the lock screen in recovery mode");
    await pop.locator("#secret").fill("ABCD-EFGH");
    await pop.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
    await expect(pop.getByRole("alert")).toBeVisible();
    await look(pop, "the lock screen after a malformed recovery code");
    await pop
      .locator(".duo")
      .getByRole("button", { name: /^(Back|返回)$/ })
      .click();

    // unlocked again after wrong passwords: the security notice; then "data restored" after a damaged copy
    await unlockPopup(pop);
    await expect(pop.locator("#sec-notice")).toBeVisible();
    await look(pop, "the list with the security notice");
    await pop.evaluate(async () => {
      const { sk_active } = (await chrome.storage.local.get("sk_active")) as { sk_active: "a" | "b" };
      await chrome.storage.local.set({ [`sk_slot_${sk_active}`]: { torn: "half a write" } });
    });
    await pop.reload();
    await expect(pop.locator("#secret, #q").first()).toBeVisible();
    if (await pop.locator("#secret").isVisible()) await unlockPopup(pop);
    await expect(pop.getByRole("alert")).toBeVisible();
    await look(pop, "the list with the data-restored banner");
    await pop.close();

    // the error screen: every storage read fails
    const broken = await p.ctx.newPage();
    await broken.addInitScript(() => {
      const area = chrome.storage.local;
      Object.defineProperty(area, "get", {
        configurable: true,
        value: () => Promise.reject(new TypeError("broken for the test")),
      });
    });
    await broken.goto(`chrome-extension://${p.id}/popup/index.html`);
    await expect(broken.getByRole("button", { name: /^(Retry|重试)$/ })).toBeVisible();
    await look(broken, "the error screen");
    await broken.close();
  });
}
