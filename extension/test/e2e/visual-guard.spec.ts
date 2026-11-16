// The visual guard: the popup's screens and the settings page, each probed as drawn, in both themes, for the defects a
// person sees at a glance and no functional test notices (visual-helpers.ts lists them: a checkbox drawn as a text field,
// text squeezed into a column, a squashed field, text running off its box or the page, a style sheet not loaded, a
// control too small to hit, low contrast, a control with no visible focus). The popup is sized as Chrome sizes it: 376
// px wide and as tall as its body, at most 600 px; at 150% zoom Chrome gives it 400 CSS px, and the list's header and
// footer must stay on screen. The lock screen is probed in each of its forms: the grouped boxes a generated password
// brings, the plain field, the recovery code with its Show box and the PIN, also with its body narrowed to 320 px. One
// test per language, each with one profile and one first run: cheap enough to run with every e2e run. No screenshots
// are kept; the probes read the page itself. The side panel (src/sidepanel/: the popup's screens in a column the user
// resizes) is probed at 320, 420 and 600 px wide, its list and its lock screen, and its document must not scroll either.
import { expect, test, type Page } from "@playwright/test";
import {
  addByPaste,
  GITHUB_URI,
  openFold,
  openOptions,
  openPopup,
  showSection,
  writeTmp,
  type Profile,
} from "./harness";
import { closeWith, FAKE_CAMERA, launchWith, stubPicker } from "./import-helpers";
import { grantScripting, holdsScripting } from "./autofill-helpers";
import { AEGIS_ENCRYPTED, K1, link, SAMPLE_LIST } from "../helpers/import-fixtures";
import { failedCount } from "./security-helpers";
import { editInPopup } from "./export-helpers";
import { focusIssues, layoutIssues, type Issue } from "./visual-helpers";

/**
 * By design, each with its reason: the kind, the element's name (tag#id.class "aria-label or text") and the states
 * (check()'s `where`) it is allowed in. Kept narrow, so a new control of the same kind elsewhere is still caught.
 */
const ALLOWED: readonly (readonly [kind: string, el: RegExp, where: RegExp, why: string])[] = [
  [
    "target",
    /^button\.more "/,
    /^(popup|panel)/,
    "a row's Edit button, 22 px wide beside the row's copy button, which fills the row",
  ],
  ["target", /^button\.clear "/, /^(popup|panel)/, "Clear search: 24 px, inside the 38 px search field"],
  [
    "target",
    /^button "(Remove|移除) /,
    /^popup: the edit sheet/,
    "a site chip's remove button: 20 px, inside its 26 px chip",
  ],
  [
    "target",
    /^button\.remember "/,
    /^(popup|panel): remember/,
    "Remember this site: a full-width line of text under its row (a related one, or each while choosing: AFMATCH)",
  ],
  [
    "target",
    /^label\.show "/,
    /^(popup|panel): locked/,
    "the lock screen's Show box: a full-width 18 px line (UISWEEP-REPORT.md)",
  ],
  [
    "target",
    /^label "/,
    /^popup: confirm page, a new key/,
    "Keep both / Replace: full-width 18 px radio lines (WCAG 2.5.8)",
  ],
  [
    "target",
    /^label\.check(\.strong|\.sub-g|\.sub-item)? "/,
    /^settings/,
    "a 16 px checkbox and its label on one full-width 22 px line (WCAG 2.5.8)",
  ],
  ["target", /^a#sm-(clip|lock-key-edit) "/, /^settings/, "a link inside a sentence (WCAG 2.5.8 inline exception)"],
  ["target", /^summary "/, /^settings/, "a disclosure: a full-width line of text"],
];
const allowed = (i: Issue, where: string) =>
  ALLOWED.some(([kind, el, at]) => kind === i.kind && el.test(i.el) && at.test(where));

const LONG = [
  "otpauth://totp/Extremely%20Long%20Issuer%20Name%20Incorporated%20International%20Holdings:someone.with.a.very.long.address%40subdomain.example-company.co.uk?secret=JBSWY3DPEHPK3PXQ&issuer=Extremely%20Long%20Issuer%20Name%20Incorporated%20International%20Holdings",
  "otpauth://totp/%E4%B8%AD%E5%9B%BD%E5%B7%A5%E5%95%86%E9%93%B6%E8%A1%8C%E7%BD%91%E4%B8%8A%E9%93%B6%E8%A1%8C:%E5%BC%A0%E4%B8%89%E7%9A%84%E5%B7%A5%E4%BD%9C%E9%82%AE%E7%AE%B1%E8%B4%A6%E6%88%B7%E5%90%8D%E7%A7%B0%E5%BE%88%E9%95%BF?secret=JBSWY3DPEHPK3PXR&issuer=%E4%B8%AD%E5%9B%BD%E5%B7%A5%E5%95%86%E9%93%B6%E8%A1%8C%E7%BD%91%E4%B8%8A%E9%93%B6%E8%A1%8C",
  "otpauth://totp/%F0%9F%A6%8A%20Firefox:fox%40example.com?secret=JBSWY3DPEHPK3PXS&issuer=%F0%9F%A6%8A%20Firefox",
  "otpauth://totp/Supercalifragilisticexpialidociousissuernamewithoutspaces:x?secret=JBSWY3DPEHPK3PXT&issuer=Supercalifragilisticexpialidociousissuernamewithoutspaces",
  "otpauth://hotp/Counter:bob?secret=GEZDGNBVGY3TQOJQ&issuer=Counter&counter=0",
  "otpauth://totp/AWS:root?secret=JBSWY3DPEHPK3PXP&issuer=AWS&digits=8",
  ...Array.from(
    { length: 12 },
    (_, i) => `otpauth://totp/Acme%20${i}:user${i}?secret=KRSXG5CTMVRXEZL${"QRSTUVWXYZ23"[i]}&issuer=Acme%20${i}`,
  ),
];

let p: Profile;
test.beforeEach(async () => {
  p = await launchWith(FAKE_CAMERA); // Chromium's fake camera, for Add account's camera (import-helpers.ts)
});
test.afterEach(async () => {
  await closeWith(p);
});

/** The popup as the toolbar shows it: 376 px wide and as tall as its body, up to `cap` (600, or 400 at 150% zoom). */
async function asPopup(page: Page, cap = 600, width = 376): Promise<void> {
  await page.setViewportSize({ width, height: cap });
  const h = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
  await page.setViewportSize({ width, height: Math.min(h, cap) });
}

const found: string[] = [];

/**
 * The popup or the side panel's page in a tab, with the tab's address and the finder's answers stubbed (the real ones are
 * autofill1.spec.ts's): `mode` is what the page looks like to the finder (found: one box; none: no box; blocked: a page that
 * cannot be scripted; two: two boxes that look alike; digits: the page refuses the code's length; moved: the box went away
 * after the code went in; slowlook, slowfill: the page does not answer the look, or the fill, in time: the extension's 8 s
 * limit is made 50 ms here; gated: storage.local cannot be closed to the page's scripts: STORAGEGATE's second layer, kept
 * since Chrome 140 is the minimum).
 */
async function fillPage(p: Profile, surface: "popup" | "panel", mode: string, url: string): Promise<Page> {
  // `scripting` held, as after a first Fill click (optional since wave 1b): the finder's answers are stubbed on it below
  if (!(await holdsScripting(p))) await grantScripting(p);
  const page = await p.ctx.newPage();
  await page.addInitScript(
    ({ mode, url }) => {
      // gated: Sixkey cannot close storage.local to the page's scripts (STORAGEGATE's second layer): no look, no button, one line
      if (mode === "gated")
        Object.defineProperty(chrome.storage.local, "setAccessLevel", {
          configurable: true,
          value: () => Promise.reject(new Error("not on this Chrome")),
        });
      if (mode.startsWith("slow")) {
        const st = window.setTimeout.bind(window);
        window.setTimeout = ((f: () => void, ms?: number) => st(f, ms === 8000 ? 50 : ms)) as typeof window.setTimeout;
      }
      const real = chrome.tabs.query.bind(chrome.tabs);
      Object.defineProperty(chrome.tabs, "query", {
        configurable: true,
        value: async (q: chrome.tabs.QueryInfo) => (q?.active ? [{ id: 1, url }] : real(q)),
      });
      // the stand-in tab is the tab in front of this (real, focused) window, as the fill asks before it fills
      // (platform/autofill.ts inFront, AUTOFILL2 patch 3)
      const get = chrome.tabs.get.bind(chrome.tabs);
      Object.defineProperty(chrome.tabs, "get", {
        configurable: true,
        value: async (id: number) =>
          id === 1 ? { id: 1, url, active: true, windowId: (await chrome.windows.getCurrent()).id } : get(id),
      });
      const box = (t: string, lab: string, s: number) => ({ t, k: 0, n: 6, s, sent: false, weak: false, lab });
      const seen = (c: unknown[]) => [
        {
          frameId: 0,
          documentId: "d0",
          result: { o: new URL(url).origin, a: [], top: true, c, x: 0, z: mode === "complex" ? 1 : 0 },
        },
      ];
      Object.defineProperty(chrome.scripting, "executeScript", {
        configurable: true,
        value: async (c: { files?: string[]; target: { documentIds?: string[] } }) => {
          if (mode === "blocked") throw new Error("Cannot access contents of the page");
          if (c.files) return [];
          // the fill goes to one document; the look has an argument too (the hint, AF3-2)
          const fill = !!c.target.documentIds;
          if ((mode === "slowfill" && fill) || (mode === "slowlook" && !fill)) return new Promise(() => undefined);
          if (fill)
            return [
              {
                result:
                  mode === "digits"
                    ? { ok: false, r: "digits" }
                    : mode === "moved"
                      ? { ok: false, r: "moved" }
                      : { ok: true, how: "single" },
              },
            ];
          return seen(
            mode === "none" || mode === "complex"
              ? []
              : mode === "two"
                ? [box("aaaaaaaaaaaaaaaa", "Work", 70), box("bbbbbbbbbbbbbbbb", "Personal", 65)]
                : [box("aaaaaaaaaaaaaaaa", "", 70)],
          );
        },
      });
    },
    { mode, url },
  );
  await page.goto(`chrome-extension://${p.id}/${surface === "popup" ? "popup" : "sidepanel"}/index.html`);
  await expect(page.locator(".sect.site .row")).toHaveCount(1);
  return page;
}
/** With AUTOFILL_SHOTS=<dir>: a screenshot of the page in both colour schemes, to look at. */
async function shot(page: Page, name: string, surface: string, width?: number): Promise<void> {
  const dir = process.env.AUTOFILL_SHOTS;
  if (!dir) return;
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    if (surface === "popup") await asPopup(page, 600, 376);
    else await page.setViewportSize({ width: width ?? 360, height: 520 });
    await page.screenshot({
      path: `${dir}/${await page.evaluate(() => document.documentElement.lang)}-${colorScheme}-${name}.png`,
    });
  }
}
/** Probe the page in both themes (and walk it with Tab if `focus`); every issue not allowed is noted for the end. */
async function check(
  page: Page,
  where: string,
  o: { popup?: boolean; focus?: boolean; width?: number; height?: number; panel?: boolean } = {},
) {
  // the popup is 376 px wide (popup.css); `width` there narrows its body, to see the screen keep its shape with less room
  if (o.popup && o.width) await page.evaluate((w) => (document.body.style.width = `${w}px`), o.width);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    if (o.popup) await asPopup(page, 600, o.width);
    else if (o.panel)
      await page.setViewportSize({ width: o.width ?? 360, height: 720 }); // a side panel's column
    else await page.setViewportSize({ width: o.width ?? 1280, height: o.height ?? 860 });
    // the popup's and the side panel's document must not scroll (only the list does)
    for (const i of await layoutIssues(page, { popup: (o.popup || o.panel) ?? false }))
      if (!allowed(i, where)) found.push(`${where} (${colorScheme}): ${i.kind} ${i.el}: ${i.detail}`);
  }
  if (o.popup && o.width) await page.evaluate(() => document.body.style.removeProperty("width"));
  if (o.focus)
    for (const i of (await focusIssues(page, 150)).issues)
      found.push(`${where} (focus): ${i.kind} ${i.el}: ${i.detail}`);
}

for (const lang of ["en", "zh_CN"] as const)
  test(`${lang}: every popup screen and the settings page: no squashed, oversized, overflowing, unstyled or unfocusable control`, async () => {
    test.setTimeout(480_000);
    found.length = 0;

    const welcome = await openPopup(p);
    // the language for every page of this profile (localStorage is the extension's, shared by its pages)
    await welcome.evaluate((l) => localStorage.setItem("sk_lang", l), lang);
    await welcome.reload();
    await expect(welcome.locator("html")).toHaveAttribute("lang", lang === "zh_CN" ? "zh-CN" : "en");
    await expect(welcome.locator("#start-secure")).toBeVisible();
    await check(welcome, "popup: welcome", { popup: true, focus: true });
    await welcome.close();

    // the first run, step by step, with a generated password: the lock screen then shows its grouped boxes (the input
    // hint, PASSWORD-SETUP-NOTES.md §8.3)
    const opt = await openOptions(p, "#setup");
    await expect(opt.locator("#fr-gen")).toBeVisible();
    await check(opt, "settings: first run", { focus: true });
    await check(opt, "settings: first run, 420 px", { width: 420 });
    await opt.locator("#fr-gen").click();
    await opt.locator("#fr-show").check();
    await check(opt, "settings: first run, a generated password shown");
    await opt.locator("#fr-show").uncheck();
    const pw = await opt.locator("#fr-pw").inputValue();
    await opt.locator("#fr-next").click();
    await expect(opt.locator("#recovery-code")).toBeVisible();
    await check(opt, "settings: first run, the recovery code");
    await opt.locator("#recovery-saved").check();
    await opt.locator("#recovery-done").click();
    await expect(opt.locator("#fr-solo")).toBeVisible();
    await check(opt, "settings: first run, this profile");
    await opt.locator("#fr-solo").check();
    await opt.locator("#fr-finish").click();
    await expect(opt.locator("#fr-hint")).toBeVisible();
    await opt.close();

    // the empty list, the add view, the confirm page
    const pop = await openPopup(p);
    await expect(pop.locator("#empty-paste")).toBeVisible();
    await check(pop, "popup: no accounts yet", { popup: true });
    await pop.locator("#empty-paste").click();
    await expect(pop.locator("#pa-box")).toBeVisible();
    await check(pop, "popup: add", { popup: true, focus: true });
    await pop.locator("#pa-box").fill(GITHUB_URI);
    await pop.locator("#pa-box").press("Enter");
    await expect(pop.locator("#pa-add")).toBeVisible();
    await check(pop, "popup: confirm page", { popup: true });
    await pop.locator("#pa-add").click();
    await expect(pop.locator(".row")).toHaveCount(1);
    await pop.locator(".pf .add").click();
    await pop.locator("#pa-box").fill(GITHUB_URI.replace("GEZDGNBVGY3TQOJQ", "ONSWG4TFORZWK3TU"));
    await pop.locator("#pa-box").press("Enter");
    await expect(pop.locator("#pa-keep")).toBeVisible();
    await check(pop, "popup: confirm page, a new key for an account", { popup: true });
    await pop.close();

    // a long list: long, Chinese, emoji and unbroken names, a group
    await addByPaste(p, LONG.join("\n"));
    await editInPopup(p, "AWS", { group: "A very long group name for testing the labels in the popup list" });
    const list = await openPopup(p);
    await expect(list.locator(".row .code:not(.wait)").first()).toBeVisible();
    await list.mouse.move(0, 0);
    await check(list, "popup: the list", { popup: true, focus: true });
    // the View menu open (QUICKVIEW-NOTES.md), over the list
    await list.locator("#view-toggle").click();
    await expect(list.locator(".vw-pop")).toBeVisible();
    await check(list, "popup: the View menu", { popup: true, focus: true });
    await check(list, "popup: the View menu, 320 px", { popup: true, width: 320 });
    await list.keyboard.press("Escape");
    await expect(list.locator(".vw-pop")).toHaveCount(0);
    for (const [cap, zoom] of [
      [480, "125%"],
      [400, "150%"],
    ] as const) {
      await asPopup(list, cap);
      const at = await list.evaluate(() => ({
        head: document.querySelector(".ph")!.getBoundingClientRect().top,
        foot: document.querySelector(".pf")!.getBoundingClientRect().bottom,
        search: document.querySelector(".search")!.getBoundingClientRect().height,
        h: innerHeight,
      }));
      if (at.head < 0 || at.foot > at.h + 0.5 || at.search < 36)
        found.push(
          `popup: the list at ${zoom} zoom: header top ${at.head}, footer bottom ${at.foot} of ${at.h}, search ${at.search} px`,
        );
    }
    await list.locator("#q").fill("zzzz");
    await check(list, "popup: a search with no match", { popup: true });
    await list.locator("#q").fill("");
    const row = list.locator(".row", { hasText: "Extremely Long" });
    await row.hover();
    await row.locator(".more").click();
    await expect(list.locator("#e-issuer")).toBeVisible();
    await list.locator("#e-site").fill("co.uk");
    await list.locator("#e-site").press("Enter");
    await expect(list.locator("#e-site-note.err")).toBeVisible();
    await check(list, "popup: the edit sheet", { popup: true });
    await list.keyboard.press("Escape");
    await expect(list.locator(".dialog")).toHaveCount(0);

    const unbroken = list.locator(".row", { hasText: "Supercalifragilistic" });
    await unbroken.hover();
    await unbroken.locator(".more").click();
    await list.getByRole("button", { name: /^(Delete|删除)$/ }).click();
    await list.getByRole("button", { name: /Click again|再点一次/ }).click();
    await expect(list.locator(".dialog")).toHaveCount(0);
    await list.close();

    // the side panel's page with the same long list, at the panel's widths, and its lock screen there
    const panel = await p.ctx.newPage();
    await panel.goto(`chrome-extension://${p.id}/sidepanel/index.html`);
    await expect(panel.locator(".row .code:not(.wait)").first()).toBeVisible();
    await panel.mouse.move(0, 0);
    for (const width of [320, 420, 600]) await check(panel, `panel: the list, ${width} px`, { panel: true, width });
    await check(panel, "panel: the list, 360 px", { panel: true, focus: true });
    // the View menu open (QUICKVIEW-NOTES.md), over the list: at the panel's widths, and with the focus walked round it
    await panel.locator("#view-toggle").click();
    await expect(panel.locator(".vw-pop")).toBeVisible();
    for (const width of [320, 420, 600])
      await check(panel, `panel: the View menu, ${width} px`, { panel: true, width });
    await check(panel, "panel: the View menu, 360 px", { panel: true, focus: true });
    await panel.keyboard.press("Escape");
    await expect(panel.locator(".vw-pop")).toHaveCount(0);
    await panel.locator("#lock-now").click();
    await expect(panel.locator("#secret-4")).toBeVisible();
    for (const width of [320, 420, 600])
      await check(panel, `panel: locked, grouped boxes, ${width} px`, { panel: true, width });
    await panel.locator("#secret-plain").click();
    for (const width of [320, 600])
      await check(panel, `panel: locked, the plain field, ${width} px`, { panel: true, width });
    await panel.locator("#secret").fill(pw);
    await panel.locator("form .btn[type=submit]").click();
    await expect(panel.locator("#q")).toBeVisible();
    await panel.close();
    // the panel on a tab the icon was not clicked on (the browser gives no address): the hint line under the search
    const blind = await p.ctx.newPage();
    await blind.addInitScript(() => {
      const real = chrome.tabs.query.bind(chrome.tabs);
      const fake = (async (q: chrome.tabs.QueryInfo) => (q?.active ? [{}] : real(q))) as typeof chrome.tabs.query;
      Object.defineProperty(chrome.tabs, "query", { configurable: true, value: fake });
    });
    await blind.goto(`chrome-extension://${p.id}/sidepanel/index.html`);
    await expect(blind.locator("#panel-hint")).toBeVisible();
    await blind.mouse.move(0, 0);
    for (const width of [320, 420, 600])
      await check(blind, `panel: the hint on a tab not clicked, ${width} px`, { panel: true, width });
    await blind.close();

    // the current site: "possibly related", and the remember sheet drawn before any edit sheet was opened
    const site = await p.ctx.newPage();
    await site.addInitScript(() => {
      const real = chrome.tabs.query.bind(chrome.tabs);
      const fake = (async (q: chrome.tabs.QueryInfo) =>
        q?.active ? [{ url: "https://github.com/login" }] : real(q)) as typeof chrome.tabs.query;
      Object.defineProperty(chrome.tabs, "query", { configurable: true, value: fake });
    });
    await site.goto(`chrome-extension://${p.id}/popup/index.html`);
    // AFMATCH: no account is registered for the page, so the line above the list asks which one it is; Choose puts
    // Remember on every row (a related row's own button), and the line's button ends it
    await expect(site.locator(".glabel.ask")).toBeVisible();
    await check(site, "popup: remember, the line asking which account", { popup: true, focus: true });
    await site.locator("#ask-pick").click();
    await expect(site.locator(".row .remember")).toHaveCount(await site.locator(".row").count());
    await check(site, "popup: remember, choosing the page's account", { popup: true });
    await site.locator("#ask-pick").click();
    await expect(site.locator(".row .remember")).toHaveCount(await site.locator(".sect.related .row").count());
    // the same list in the side panel, at its narrowest and widest
    const sitePanel = await p.ctx.newPage();
    await sitePanel.addInitScript(() => {
      const real = chrome.tabs.query.bind(chrome.tabs);
      const fake = (async (q: chrome.tabs.QueryInfo) =>
        q?.active ? [{ url: "https://github.com/login" }] : real(q)) as typeof chrome.tabs.query;
      Object.defineProperty(chrome.tabs, "query", { configurable: true, value: fake });
    });
    await sitePanel.goto(`chrome-extension://${p.id}/sidepanel/index.html`);
    await expect(sitePanel.locator(".glabel.ask")).toBeVisible();
    await sitePanel.mouse.move(0, 0);
    for (const width of [320, 600])
      await check(sitePanel, `panel: remember, the line asking which account, ${width} px`, { panel: true, width });
    await sitePanel.close();
    const related = site.locator(".sect.related .row").first();
    await related.hover();
    await related.locator(".remember").click();
    await expect(site.locator(".sheet.rm")).toBeVisible();
    await check(site, "popup: remember this site", { popup: true });
    // remember it: the account is now registered for the page, and its card has the Fill button (AUTOFILL1-NOTES.md)
    await site.locator(".sheet.rm button[type=submit]").click();
    await expect(site.locator(".sect.site .row")).toHaveCount(1);
    await site.close();

    // AFMATCH round 3: a long look-alike of the site GitHub is now registered for. The question wraps, never cut, so
    // the host's end, the part one could register, stays in view (AF-02); the remember sheet for GitHub names the site
    // it already has, above Save (AF-01). In the popup and in the side panel at its narrowest and widest.
    const LOOK = "github.com.login-session-verify.attacker.io";
    const onLook = async (path: string) => {
      const page = await p.ctx.newPage();
      await page.addInitScript((u) => {
        const real = chrome.tabs.query.bind(chrome.tabs);
        const fake = (async (q: chrome.tabs.QueryInfo) =>
          q?.active ? [{ url: u }] : real(q)) as typeof chrome.tabs.query;
        Object.defineProperty(chrome.tabs, "query", { configurable: true, value: fake });
      }, `https://${LOOK}/login`);
      await page.goto(`chrome-extension://${p.id}/${path}`);
      await expect(page.locator("#ask-q")).toContainText(LOOK);
      await page.mouse.move(0, 0);
      return page;
    };
    const cut = (page: Page) => page.locator("#ask-q").evaluate((b) => b.scrollWidth > b.clientWidth + 1);
    const pickGitHub = async (page: Page) => {
      await page.locator("#ask-pick").click();
      const gh = page.locator(".row", { has: page.locator(".who b", { hasText: /^GitHub$/ }) });
      await gh.locator(".remember").click();
      await expect(page.locator("#rm-warn")).toContainText("github.com");
    };
    const look = await onLook("popup/index.html");
    expect(await cut(look)).toBe(false);
    await check(look, "popup: remember, the line on a long look-alike", { popup: true });
    await pickGitHub(look);
    await check(look, "popup: remember, a registered account on a long look-alike", { popup: true });
    await look.close();
    const lookPanel = await onLook("sidepanel/index.html");
    for (const width of [320, 600]) {
      await lookPanel.setViewportSize({ width, height: 720 });
      expect(await cut(lookPanel), `${width} px`).toBe(false);
      await check(lookPanel, `panel: remember, the line on a long look-alike, ${width} px`, { panel: true, width });
    }
    await pickGitHub(lookPanel);
    await check(lookPanel, "panel: remember, a registered account on a long look-alike, 320 px", {
      panel: true,
      width: 320,
    });
    await lookPanel.close();

    // TOTP autofill, Stage 1: the Fill button's states on that page, in the popup and in the side panel's widths. The page
    // is a stand-in (the tab's address and the finder's answers are stubbed; the real ones are autofill1.spec.ts's)
    for (const [mode, url, where] of [
      ["found", "https://github.com/login", "a code box found"],
      ["none", "https://github.com/login", "no code box found"],
      ["blocked", "https://github.com/login", "a page that cannot be looked at"],
      ["two", "https://github.com/login", "two boxes to choose from"],
      ["found", "http://github.com/login", "an http page asks first"],
      ["digits", "https://github.com/login", "the code does not fit the box"],
      ["complex", "https://github.com/login", "a page too complex to look through"],
      ["moved", "https://github.com/login", "the page moved on after the code went in"],
      ["slowfill", "https://github.com/login", "the page did not answer the fill in time"],
      ["slowlook", "https://github.com/login", "the page did not answer the look in time"],
      ["gated", "https://github.com/login", "storage cannot be closed to the page (Chrome before 140)"],
      ["found", "https://docs.github.com/login", "on a subdomain the button names the host"],
    ] as const) {
      for (const surface of ["popup", "panel"] as const) {
        for (const width of surface === "popup" ? [undefined] : [320, 420, 600]) {
          const page = await fillPage(p, surface, mode, url);
          const here = `${surface}: fill, ${where}${width ? `, ${width} px` : ""}`;
          await page.locator(".fillbar").waitFor();
          if (
            mode === "none" ||
            mode === "complex" ||
            mode === "digits" ||
            mode === "moved" ||
            mode === "slowfill" ||
            mode === "two" ||
            url.startsWith("http:")
          ) {
            await page.locator(".fillbtn").first().click();
            // the note the state ends on (not "New code in …", which comes first when the code is about to change)
            const end =
              mode === "two"
                ? ".fillacts .btn.ghost"
                : mode === "moved" || mode === "slowfill" || url.startsWith("http:")
                  ? ".fillnote.warn"
                  : ".fillnote.bad";
            await page.locator(end).first().waitFor();
          }
          if (mode === "slowlook") await page.locator(".fillbar .btn").waitFor(); // "Look again": the look has ended
          if (mode === "gated") await page.locator(".fillbar", { hasText: "140" }).waitFor();
          if (mode === "found" && url.startsWith("https:") && surface === "popup") {
            await page.locator(".fillbtn").first().click();
            await page.locator(".fillnote.ok").waitFor();
          }
          await page.mouse.move(0, 0);
          await shot(page, here.replace(/[^a-z0-9]+/gi, "-"), surface, width);
          await check(
            page,
            here,
            surface === "popup" ? { popup: true, focus: mode === "found" } : { panel: true, width },
          );
          await page.close();
        }
      }
    }

    // the lock screen: the grouped boxes (wide and narrow), a wrong code in them, the plain field, a wrong password and
    // straight on to the recovery code (the late answer is not that field's error), the recovery code with its Show box
    const lock = await openPopup(p);
    await lock.locator("#lock-now").click();
    await expect(lock.locator("#secret-4")).toBeVisible();
    await check(lock, "popup: locked, grouped boxes", { popup: true, focus: true });
    await check(lock, "popup: locked, grouped boxes, 320 px", { popup: true, width: 320 });
    // a pending fill request for the tab in front (AUTOFILL2 patch 1): the lock screen's line names the page. The tab in front
    // is stubbed (as fillPage does), so that a request for it can be written; the popup and the side panel's page
    for (const surface of ["popup", "panel"] as const) {
      const pending = await p.ctx.newPage();
      await pending.addInitScript(() => {
        const real = chrome.tabs.query.bind(chrome.tabs);
        Object.defineProperty(chrome.tabs, "query", {
          configurable: true,
          value: async (q: chrome.tabs.QueryInfo) =>
            q?.active ? [{ id: 1, windowId: 1, url: "https://github.com/login" }] : real(q),
        });
      });
      await pending.goto(`chrome-extension://${p.id}/${surface === "popup" ? "popup" : "sidepanel"}/index.html`);
      await expect(pending.locator("form.lock")).toBeVisible();
      await pending.evaluate(async () => {
        const epoch = (await chrome.storage.session.get("sk_lock_epoch")).sk_lock_epoch ?? 0;
        await chrome.storage.session.set({
          sk_fill_req: {
            v: 1,
            nonce: "0123456789abcdef0123456789abcdef",
            tabId: 1,
            windowId: 1,
            url: "https://github.com/login",
            host: "github.com",
            at: Date.now(),
            epoch,
            why: "locked",
          },
        });
      });
      await expect(pending.locator("#lock-fill")).toContainText("github.com");
      await shot(pending, `${surface}-locked-pending-fill`, surface, 320);
      if (surface === "popup") await check(pending, "popup: locked, a pending fill's line", { popup: true });
      else await check(pending, "panel: locked, a pending fill's line, 320 px", { panel: true, width: 320 });
      await pending.evaluate(() => chrome.storage.session.remove("sk_fill_req"));
      await pending.close();
    }
    await lock.locator("#secret").focus();
    await lock.keyboard.type("AAAA-BBBB-CCCC-DDDD");
    await lock.locator("form .btn[type=submit]").click();
    await expect(lock.getByRole("alert")).toBeVisible();
    await check(lock, "popup: locked, grouped boxes, a wrong password", { popup: true });
    await lock.locator("#secret-plain").click();
    await expect(lock.locator("#secret-2")).toHaveCount(0);
    await check(lock, "popup: locked, the plain field", { popup: true, focus: true });
    await check(lock, "popup: locked, the plain field, 320 px", { popup: true, width: 320 });
    const failed = (await failedCount(lock)) ?? 0;
    await lock.locator("#secret").fill("Wrong#Guess9!Zebra4$Pine");
    await lock.locator("form .btn[type=submit]").click();
    await lock.getByRole("button", { name: /recovery key|恢复密钥/ }).click();
    await expect.poll(() => failedCount(lock)).toBe(failed + 1);
    await expect(lock.locator(".dial.busy")).toHaveCount(0); // the attempt has answered
    await expect(lock.getByRole("alert")).toHaveCount(0);
    await expect(lock.locator("#secret-show")).toBeVisible();
    await lock.locator("#secret-show").check();
    await check(lock, "popup: locked, the recovery code", { popup: true });
    await check(lock, "popup: locked, the recovery code, 320 px", { popup: true, width: 320 });
    // "Set a new password" opens the reset in a settings tab: the recovery code field with its own Show box
    const reset = await openOptions(p, "#reset");
    await expect(reset.locator("#reset-code-in")).toBeVisible();
    await check(reset, "settings: reset the password", { focus: true });
    await check(reset, "settings: reset the password, 420 px", { width: 420 });
    await reset.close();
    await lock.locator(".duo .btn").first().click();
    await lock.locator("#secret").fill(pw); // the plain field, still asked for: it takes the generated password too
    await lock.locator("form .btn[type=submit]").click();
    await expect(lock.locator("#q")).toBeVisible();
    await lock.close();

    // the settings page with a vault, an account in the trash, wide and narrow
    const settings = await openOptions(p);
    await expect(settings.locator(".status dd.num")).toHaveText(/^\d+$/);
    await check(settings, "settings", { focus: true });
    await check(settings, "settings, 420 px", { width: 420 });

    // Every leaf of the settings page, one at a time (SHORT-SETTINGS-NOTES.md), at the widths of a narrow window, a
    // side-by-side one and a wide one, in both themes (check()): each is probed as drawn (the groups of the rail and the
    // leaves under the title wrap, they never scroll sideways: no hscroll is allowed), and at 1400 x 900 the page of a
    // leaf must not run past a screen and a half (1350 px) unless its content is long by nature (LONG_BY_NATURE says
    // which: none now). A folded box is opened and probed too.
    const groups = await settings
      .locator(".rail nav a")
      .evaluateAll((a) => a.map((x) => x.getAttribute("href")!.slice(1)));
    expect(groups).toEqual(["accounts", "security", "appearance", "sync", "advanced"]);
    const LEAVES = [
      "security",
      "security-keys",
      "security-log",
      "autofill", // AUTOFILL2 patch 2 (harness.ts is frozen and does not know it: reached by its address below)
      "sync",
      "add",
      "backup",
      "trash",
      "appearance",
      "advanced",
    ];
    const LONG_BY_NATURE = new Set<string>(); // none: the longest leaf (Appearance with Clipboard) is about 1,320 px
    for (const id of LEAVES) {
      if (id === "autofill") {
        await settings.evaluate(() => (location.hash = "#autofill"));
        await expect(settings.locator("#autofill")).toBeVisible();
      } else await showSection(settings, id);
      for (const width of [320, 420, 600]) await check(settings, `settings: ${id}, ${width} px`, { width });
      await check(settings, `settings: ${id}, 1400 px`, { width: 1400, height: 900 });
      await settings.setViewportSize({ width: 1400, height: 900 });
      const tall = await settings.evaluate(() => document.documentElement.scrollHeight);
      if (tall > 1350 && !LONG_BY_NATURE.has(id))
        found.push(`settings: ${id}: the page is ${tall} px tall at 1400 x 900 (more than a screen and a half)`);
    }
    for (const [section, fold] of [
      ["security-keys", "fold-change"],
      ["security-keys", "fold-code"],
      ["security-keys", "fold-rotate"],
      ["security-keys", "fold-shares"], // its wizard is a lazy chunk (SHAMIR-NOTES.md §5): drawn before the checks
      ["security", "pin-box"],
      ["backup", "encrypted"], // a fold since the cloud backup's card is the leaf's first (BACKUP-VISUAL)
      ["backup", "subset"],
    ] as const) {
      await showSection(settings, section);
      await openFold(settings, fold);
      if (fold === "fold-shares") await expect(settings.locator("#shares-make")).toBeVisible();
      await check(settings, `settings: ${section}, ${fold} open`);
      await check(settings, `settings: ${section}, ${fold} open, 320 px`, { width: 320 });
      await check(settings, `settings: ${section}, ${fold} open, 420 px`, { width: 420 });
      await settings.locator(`#${fold}-toggle`).click();
    }
    // a short window (a zoomed or a small one): the rail scrolls by itself, and the page has no sideways scroll
    await showSection(settings, "security");
    await check(settings, "settings: security, 1400 x 500 px", { width: 1400, height: 500 });
    await showSection(settings, "security");

    // Add account (IMPORT-FILE-NOTES.md): files chosen (an export with a line skipped and a Steam account counted, and
    // an encrypted export with a long name), the camera refused, then live on the fake device, and the delete prompt,
    // without a handle and with one
    await showSection(settings, "add");
    await expect(settings.locator("#choose-file")).toBeEnabled();
    await settings
      .locator("#qr-file")
      .setInputFiles([
        writeTmp(
          "authenticator-uris-2026-10-20.txt",
          `${SAMPLE_LIST}otpauth://totp/Broken%20Bank:me?secret=*&issuer=Broken%20Bank\notpauth://steam/Steam:me?secret=${K1}\n`,
        ),
        writeTmp("aegis-encrypted-export-with-a-rather-long-file-name-2026-10-20.json", AEGIS_ENCRYPTED),
      ]);
    await expect(settings.locator("#add-files .src")).toHaveCount(2);
    await expect(settings.locator("#preview")).toContainText(/10/);
    await check(settings, "settings: add account, files chosen");
    await check(settings, "settings: add account, files chosen, 420 px", { width: 420 });
    await settings.evaluate(() =>
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: () => Promise.reject(new DOMException("refused", "NotAllowedError")),
      }),
    );
    await settings.locator("#cam-start").click();
    await expect(settings.locator("#cam-error")).toBeVisible();
    await check(settings, "settings: add account, camera refused");
    await check(settings, "settings: add account, camera refused, 420 px", { width: 420 });
    await settings.evaluate(() => delete (navigator.mediaDevices as { getUserMedia?: unknown }).getUserMedia);
    await settings.bringToFront();
    await settings.locator("#cam-start").click();
    await expect(settings.locator("#cam-live video.on")).toBeVisible();
    await check(settings, "settings: add account, camera live");
    await check(settings, "settings: add account, camera live, 420 px", { width: 420 });
    await settings.locator("#cam-stop").click();
    await expect(settings.locator("#cam-live")).toHaveCount(0);
    await settings.locator("#add-confirm").click();
    await expect(settings.locator("#del-ask .del-ok")).toBeVisible();
    await check(settings, "settings: add account, the delete prompt without a handle");
    await settings.locator("#del-ask .del-ok").click();
    await stubPicker(settings, "export.txt", `${link("Picked", "me", "MFRGGZDFMZTWQ2LKMFRGGZDF")}\n`);
    await settings.locator("#choose-file").click();
    await expect(settings.locator("#preview")).toContainText(/1/);
    await settings.locator("#add-confirm").click();
    await expect(settings.locator("#del-ask .del-yes")).toBeVisible();
    await check(settings, "settings: add account, the delete prompt", { focus: true });
    await check(settings, "settings: add account, the delete prompt, 420 px", { width: 420 });
    await settings.locator("#del-ask .del-keep").click();

    // a PIN, and the lock screen that opens on it: its tries-left line takes the field's gap, not a paragraph's margins
    await showSection(settings, "security");
    await openFold(settings, "pin-box");
    await settings.locator("#pin-pw").fill(pw);
    await settings.locator("#pin-new").fill("246813");
    await settings.locator("#pin-new2").fill("246813");
    await settings.locator("#pin-set").click();
    await expect(settings.locator("#pin-info")).toBeVisible(); // set: its record made (it opens the lock screen below)
    await expect(settings.locator("#pin-state")).toBeVisible();
    await settings.close();
    const pin = await openPopup(p);
    await pin.locator("#lock-now").click();
    await expect(pin.locator("#pin")).toBeVisible();
    await check(pin, "popup: locked, PIN", { popup: true, focus: true });
    await check(pin, "popup: locked, PIN, 320 px", { popup: true, width: 320 });
    expect(await pin.locator("#pin-tries").evaluate((el) => getComputedStyle(el).margin)).toBe("0px");
    await pin.close();

    expect(found, found.join("\n")).toEqual([]);
  });
