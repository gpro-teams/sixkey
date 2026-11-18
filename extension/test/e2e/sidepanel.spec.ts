// The side panel mode (docs/design/notes/SIDEPANEL-NOTES.md), in the browser. The first two tests drive the real side
// panel: the browser's own click on the toolbar icon (Extensions.triggerAction, test/e2e/panel-helpers.ts) and the
// popup's "Open in side panel"; the panel's page is read through the DevTools protocol. The others load the panel's page
// in a tab, where Playwright's clock and input reach it: the idle cap with a sheet open, and a shared profile.
import { expect, test, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { addByPaste, GITHUB_URI, openOptions, openPopup, STRONG, startFresh, type Profile } from "./harness";
import { closeDriven, drive, launchDriven, type Driver } from "./panel-helpers";

let server: Server;
let port = 0;
test.beforeAll(async () => {
  server = createServer((q, r) => {
    r.setHeader("content-type", "text/html");
    r.end(`<!doctype html><title>${q.headers.host}</title><h1>${q.headers.host}</h1>`);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  port = (server.address() as { port: number }).port;
});
test.afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

/** Two web sites on the local server: github.test (GitHub's account is "possibly related" there) and other.test. */
const hosts = () => [`MAP github.test 127.0.0.1:${port}`, `MAP other.test 127.0.0.1:${port}`];
const popupOf = (p: Profile) => p.ctx.serviceWorkers()[0]!.evaluate(() => chrome.action.getPopup({}));
const settled = (page: Page) => expect(page.locator("#security-mode")).not.toHaveAttribute("aria-busy", "true");

async function pickOpener(p: Profile, v: "popup" | "panel") {
  const opt = await openOptions(p, "#appearance");
  await opt.locator(`#look-open-${v}`).check();
  await expect
    .poll(() => popupOf(p), { message: `the icon opens the ${v}` })
    .toBe(v === "panel" ? "" : `chrome-extension://${p.id}/popup/index.html`);
  await opt.close();
}

test("the toolbar icon opens the side panel: activeTab for the clicked tab, locks and unlocks elsewhere followed, the sender policy, back to the popup, never in a shared profile", async () => {
  test.setTimeout(120_000);
  const p = await launchDriven(hosts());
  let d: Driver | undefined;
  try {
    await startFresh(p);
    await addByPaste(p, GITHUB_URI);
    const sw = p.ctx.serviceWorkers()[0]!;
    // what the real panel's messages look like to the worker (sender.tab is the question: SIDEPANEL-NOTES.md)
    await sw.evaluate(() => {
      const g = globalThis as unknown as { __senders: unknown[] };
      g.__senders = [];
      chrome.runtime.onMessage.addListener((m: { type?: string }, s) => {
        if (s.url?.endsWith("/sidepanel/index.html"))
          g.__senders.push({ type: m?.type, url: s.url, tab: s.tab ?? null, origin: s.origin ?? null });
      });
    });

    expect(await popupOf(p)).toBe(`chrome-extension://${p.id}/popup/index.html`); // the default
    await pickOpener(p, "panel");

    const site = await p.ctx.newPage();
    await site.goto(`http://github.test:${port}/`);
    d = await drive(p);
    expect(await d.panels()).toBe(0);
    await d.clickIcon("github.test");
    const panel = await d.panel();
    await panel.until("document.querySelector('#q')", "the list, in the panel (the vault is unlocked)");
    // the click granted activeTab for that tab: the panel reads its address, and GitHub is "possibly related" there
    expect(await panel.eval("chrome.tabs.query({active: true, currentWindow: true}).then((t) => t[0]?.url)")).toBe(
      `http://github.test:${port}/`,
    );
    await panel.until("document.querySelector('.sect.related .row .remember')", "this site's account, with Remember");
    expect(await panel.eval("document.body.className")).toContain("panel");
    expect(await panel.eval("document.querySelector('#open-panel')")).toBeNull(); // the panel has no way to itself

    // the worker took the panel's message: an extension page at its own path, with no tab
    await expect
      .poll(() => sw.evaluate(() => (globalThis as unknown as { __senders: { type: string }[] }).__senders))
      .toContainEqual({
        type: "sk-reschedule-autolock",
        url: `chrome-extension://${p.id}/sidepanel/index.html`,
        tab: null,
        origin: `chrome-extension://${p.id}`,
      });
    await expect.poll(() => sw.evaluate(async () => !!(await chrome.alarms.get("sk-autolock")))).toBe(true);

    // another tab, never clicked: no address (activeTab is per tab), so no "this site"; back on the first, it is back
    const other = await p.ctx.newPage();
    await other.goto(`http://other.test:${port}/`);
    await other.bringToFront();
    await panel.until(
      "!document.querySelector('.sect.related')",
      "no site section on a tab the icon was not clicked on",
    );
    expect(
      await panel.eval("chrome.tabs.query({active: true, currentWindow: true}).then((t) => t[0]?.url ?? null)"),
    ).toBeNull();
    // ... and the line that says how to get it, in place of the site section (and above a scan's failure)
    await panel.until(
      "!document.querySelector('#panel-hint').hidden && document.querySelector('#panel-hint').offsetHeight > 0",
      "the hint on a tab the icon was not clicked on",
    );
    expect(await panel.eval("document.querySelector('#panel-hint').textContent")).toMatch(/Sixkey/);
    // under the search, above the list: where "this site" would be
    expect(
      await panel.eval(`(() => {
        const box = (q) => document.querySelector(q).getBoundingClientRect();
        return box('.search').bottom <= box('#panel-hint').top && box('#panel-hint').bottom <= box('#list').top;
      })()`),
    ).toBe(true);
    await site.bringToFront();
    await panel.until("document.querySelector('.sect.related')", "the first tab's site again");
    expect(await panel.eval("document.querySelector('#panel-hint').hidden")).toBe(true);
    // a click on the icon on the other tab, with the panel open: that tab is readable now, and the panel reads it again
    await other.bringToFront();
    await d.clickIcon("other.test");
    await expect
      .poll(() => panel.eval("chrome.tabs.query({active: true, currentWindow: true}).then((t) => t[0]?.url ?? null)"))
      .toBe(`http://other.test:${port}/`);
    expect(await d.panels()).toBe(1); // the same panel, not a second one

    // Adding an account remembers the site the user was on when the confirm page opened, not the tab active when Add is
    // pressed (SIDEPANEL-NOTES.md §4; review J1)
    await site.bringToFront();
    await panel.until("document.querySelector('.sect.related')", "github.test again");
    await panel.eval("document.querySelector('.pf .add').click()");
    await panel.until("document.querySelector('#pa-box')", "the add view");
    const BOB = GITHUB_URI.replace("alice@example.com", "bob@example.com").replace(
      /secret=[A-Z0-9]+/,
      "secret=ONSWG4TFORZWK3TU",
    );
    await panel.eval(`(async () => {
      const box = document.querySelector('#pa-box');
      box.value = ${JSON.stringify(BOB)};
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await panel.until("document.querySelector('#pa-site')", "the confirm page, with the site box");
    const siteLine = "document.querySelector('#pa-site').closest('label').textContent";
    expect(await panel.eval(siteLine)).toContain("github.test");
    expect(await panel.eval("document.querySelector('#pa-site').checked")).toBe(true);
    await other.bringToFront(); // readable: the icon was clicked on it above
    await expect
      .poll(() => panel.eval("chrome.tabs.query({active: true, currentWindow: true}).then((t) => t[0]?.url ?? null)"))
      .toBe(`http://other.test:${port}/`);
    await panel.eval("new Promise((r) => setTimeout(r, 300))"); // the list has read the new tab
    expect(await panel.eval(siteLine)).toContain("github.test");
    expect(await panel.eval(siteLine)).not.toContain("other.test");
    await panel.eval("document.querySelector('#pa-add').click()");
    await panel.until("document.querySelector('#q')", "back on the list");
    expect(await panel.eval("document.querySelector('.sect.site')")).toBeNull(); // nothing registered for other.test
    await site.bringToFront();
    await panel.until(
      "[...document.querySelectorAll('.sect.site .row')].some((r) => r.textContent.includes('bob@example.com'))",
      "the new account registered for github.test, where it was added",
    );

    // Settings from the panel: a settings tab opens, the panel stays open
    await panel.eval("[...document.querySelectorAll('.ph .tb')].at(-1).click()");
    await expect.poll(() => p.ctx.pages().some((pg) => pg.url().includes("/options/index.html"))).toBe(true);
    await panel.eval("new Promise((r) => setTimeout(r, 300))");
    expect(await d.panels()).toBe(1);
    expect(await panel.eval("!!document.querySelector('#q')")).toBe(true);

    // Lock now in the popup: the panel drops the list at once; an unlock in the popup opens it again
    const pop = await openPopup(p);
    await pop.locator("#lock-now").click();
    await panel.until(
      "document.querySelector('#secret') && !document.querySelector('#q')",
      "the lock screen in the panel",
    );
    // the panel's lock screen: the master password is never shown there (no Show box, no text field)
    expect(await panel.eval("document.querySelectorAll('#secret-show, input[type=text]#secret').length")).toBe(0);
    await pop.locator("#secret").fill(STRONG);
    await pop.locator("form .btn[type=submit]").click();
    await expect(pop.locator("#q")).toBeVisible();
    await panel.until("document.querySelector('#q')", "the list in the panel, unlocked elsewhere");
    // and an unlock in the panel itself
    await pop.locator("#lock-now").click();
    await panel.until("document.querySelector('#secret')", "locked again");
    await panel.eval(`(async () => {
      const f = document.querySelector('#secret');
      f.value = ${JSON.stringify(STRONG)};
      f.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200)); // the field's state is drawn before the form is sent
      document.querySelector('form').requestSubmit();
    })()`);
    await panel.until("document.querySelector('#q')", "unlocked in the panel");
    await pop.close();

    // the panel closes itself (window.close works in a side panel); the popup's button opens it again, in its window
    await panel.eval("window.close()");
    await expect.poll(() => d!.panels()).toBe(0);
    const pop2 = await openPopup(p);
    await pop2.locator("#open-panel").click();
    await expect.poll(() => d!.panels()).toBe(1);
    const again = await d.panel();
    await again.until("document.querySelector('#q')", "the list in the panel opened from the popup");

    // back to the popup: at once
    await pickOpener(p, "popup");

    // a shared profile: the panel closes, the icon opens the popup, Appearance offers no choice, the popup no button
    await pickOpener(p, "panel");
    const opt = await openOptions(p, "#security");
    await opt.locator("#sm-shared").check();
    await settled(opt);
    await expect.poll(() => d!.panels(), { message: "the panel closed itself" }).toBe(0);
    await expect.poll(() => popupOf(p)).toBe(`chrome-extension://${p.id}/popup/index.html`);
    await opt.goto(`chrome-extension://${p.id}/options/index.html#appearance`);
    await expect(opt.locator("#look-open-shared")).toBeVisible();
    await expect(opt.locator("#look-open-panel")).toHaveCount(0);
    await opt.close();
    const pop3 = await openPopup(p);
    await pop3.locator("#secret").fill(STRONG);
    await pop3.locator("form .btn[type=submit]").click();
    await expect(pop3.locator("#q")).toBeVisible();
    await expect(pop3.locator("#open-panel")).toHaveCount(0);
    // an attempt to open it anyway (as the browser's own side panel menu would): refused by the browser, the page
    // being disabled; and if a browser opened it all the same, the panel's page closes itself (the last test)
    const attempt = await pop3.evaluate(() =>
      chrome.windows
        .getCurrent()
        .then((w) => chrome.sidePanel.open({ windowId: w.id! }))
        .then(
          () => "opened",
          (e: unknown) => `refused: ${String(e)}`,
        ),
    );
    console.log(`side panel opened in a shared profile: ${attempt}`); // for SIDEPANEL-NOTES.md
    await expect.poll(() => d!.panels()).toBe(0);
  } finally {
    await closeDriven(p, d);
  }
});

test("the owner's report of 2026-11-18: a panel opened from the popup makes the icon open the panel, never a popup over it; its button goes back to the popup", async () => {
  test.setTimeout(120_000);
  const p = await launchDriven(hosts());
  let d: Driver | undefined;
  try {
    await startFresh(p);
    await addByPaste(p, GITHUB_URI);
    const POPUP = `chrome-extension://${p.id}/popup/index.html`;
    expect(await popupOf(p)).toBe(POPUP); // the default
    const site = await p.ctx.newPage();
    await site.goto(`http://github.test:${port}/`);
    d = await drive(p);
    const pop = await d.popup("github.test");
    await pop.until("document.querySelector('#open-panel')", "the popup's side panel button");
    await pop.click("#open-panel");
    await expect.poll(() => d!.panels()).toBe(1);
    await expect.poll(() => popupOf(p), { message: "the icon opens the panel now" }).toBe("");
    // the icon on that tab, with the panel open: no popup over it, the one panel, which lists the tab's site
    await d.clickIconOn(site);
    const panel = await d.panel();
    await panel.until("document.querySelector('.sect.related .row')", "the clicked tab's site, in the panel");
    expect(await d.popups()).toBe(0);
    expect(await d.panels()).toBe(1);
    // the panel's way back: the panel closes, and the icon opens the popup again
    await panel.until("document.querySelector('#to-popup')", "the panel's button back to the popup");
    expect(await panel.eval("document.querySelector('#to-popup').title")).toBe("Use the popup instead");
    await panel.gesture("document.querySelector('#to-popup').click()");
    await expect.poll(() => d!.panels()).toBe(0);
    await expect.poll(() => popupOf(p)).toBe(POPUP);
    const pop2 = await d.popup("github.test");
    await pop2.until("document.querySelector('#q')", "the popup, from the icon");
    await pop2.close();
  } finally {
    await closeDriven(p, d);
  }
});

test("a second window has its own panel; Lock now locks both", async () => {
  test.setTimeout(90_000);
  const p = await launchDriven(hosts());
  let d: Driver | undefined;
  try {
    await startFresh(p);
    await addByPaste(p, GITHUB_URI);
    await pickOpener(p, "panel");
    const a = await p.ctx.newPage();
    await a.goto(`http://github.test:${port}/`);
    d = await drive(p);
    await d.clickIcon("github.test");
    await expect.poll(() => d!.panels()).toBe(1);
    // a second window (a new browser window via the DevTools protocol), with a page of its own, and the icon clicked there
    const { targetId } = (await d.bs.send("Target.createTarget", {
      url: `http://other.test:${port}/`,
      newWindow: true,
    })) as { targetId: string };
    expect(targetId).toBeTruthy();
    await expect
      .poll(async () => {
        await d!.clickIcon("other.test").catch(() => undefined);
        return d!.panels();
      })
      .toBe(2);
    const both = await d.allPanels();
    expect(both).toHaveLength(2);
    for (const panel of both) await panel.until("document.querySelector('#q')", "the list in each window's panel");
    const pop = await openPopup(p);
    await pop.locator("#lock-now").click();
    for (const panel of both) await panel.until("document.querySelector('#secret')", "the lock screen in each panel");
  } finally {
    await closeDriven(p, d);
  }
});

test("the panel's page: 15 idle minutes lock it, with a sheet open; input moves the deadline", async () => {
  test.setTimeout(90_000);
  const p = await launchDriven();
  try {
    await startFresh(p); // lock after 15 idle minutes, the standard preset; the panel's cap is the same 15
    await addByPaste(p, GITHUB_URI);
    // (the worker's idle alarm runs on the real clock, and this page's clock is Playwright's: only the panel's cap locks)
    const page = await p.ctx.newPage();
    await page.clock.install();
    await page.setViewportSize({ width: 360, height: 760 });
    await page.goto(`chrome-extension://${p.id}/sidepanel/index.html`);
    await expect(page.locator("#q")).toBeVisible();
    await page.clock.fastForward(10 * 60_000);
    await page.locator("#q").press("a"); // input: the deadline moves
    await page.locator("#q").fill("");
    await page.clock.fastForward(10 * 60_000);
    await expect(page.locator("#q")).toBeVisible();
    // the edit sheet open, then 15 minutes without input
    const row = page.locator(".row").first();
    await row.hover();
    await row.locator(".more").click();
    await expect(page.locator("#e-issuer")).toBeVisible();
    await page.clock.fastForward(15 * 60_000 + 20_000);
    await expect(page.locator("#secret")).toBeVisible();
    await expect(page.locator("#e-issuer")).toHaveCount(0);
    await expect(page.locator(".row")).toHaveCount(0);
    // the soft lock: every page is locked
    const pop = await openPopup(p);
    await expect(pop.locator("#secret")).toBeVisible();
  } finally {
    await closeDriven(p);
  }
});

test("the panel's page: changes made elsewhere are not use; a secret typed on its lock screen is wiped after 2 idle minutes", async () => {
  test.setTimeout(90_000);
  const p = await launchDriven();
  try {
    await startFresh(p);
    await addByPaste(p, GITHUB_URI);
    const other = await openPopup(p);
    const display = (density: string) =>
      other.evaluate(async (d) => {
        const s = (await chrome.storage.local.get("sk_settings")).sk_settings as Record<string, unknown>;
        await chrome.storage.local.set({ sk_settings: { ...s, display: { ...(s.display as object), density: d } } });
      }, density);
    // an automatic lock longer than the panel's cap, so only the cap can lock here
    await other.evaluate(async () => {
      const s = (await chrome.storage.local.get("sk_settings")).sk_settings as Record<string, unknown>;
      await chrome.storage.local.set({ sk_settings: { ...s, autoLock: { mode: "idle", minutes: 60 } } });
    });
    const page = await p.ctx.newPage();
    await page.clock.install();
    await page.goto(`chrome-extension://${p.id}/sidepanel/index.html`);
    await expect(page.locator("#q")).toBeVisible();
    // a settings change elsewhere every 6 minutes reloads the list, and is no use of the panel
    await page.clock.fastForward(6 * 60_000);
    await display("compact");
    await expect(page.locator(".list.compact")).toBeVisible();
    await page.clock.fastForward(6 * 60_000);
    await display("standard");
    await expect(page.locator(".list:not(.compact)")).toBeVisible();
    await page.clock.fastForward(4 * 60_000);
    await expect(page.locator("#secret")).toBeVisible(); // 16 minutes without input
    // the lock screen: a recovery code typed with Show ticked, then 2 minutes without input
    await page.getByRole("button", { name: /recovery key|恢复密钥/ }).click();
    await page.locator("#secret-show").check();
    await page.locator("#secret").fill("ABCD-EFGH");
    await page.clock.fastForward(60_000);
    await expect(page.locator("#secret")).toHaveValue("ABCD-EFGH");
    await page.clock.fastForward(60_000 + 20_000);
    await expect(page.locator("#secret")).toHaveValue("");
    await expect(page.locator("#secret-show:checked")).toHaveCount(0);
  } finally {
    await closeDriven(p);
  }
});

test("in a shared profile the panel's page draws nothing", async () => {
  const p = await launchDriven();
  try {
    await startFresh(p, { risk: "shared" });
    const page = await p.ctx.newPage();
    const closed = page.waitForEvent("close", { timeout: 5000 }).then(
      () => true,
      () => false,
    );
    await page.goto(`chrome-extension://${p.id}/sidepanel/index.html`).catch(() => undefined);
    // it closes itself (window.close: in a tab that only this test opened, as in a side panel); if it stays, it is empty
    if (!(await closed)) {
      await expect(page.locator("#app")).toBeEmpty();
      await expect(page.locator("#secret, #q, #start-secure")).toHaveCount(0);
    }
  } finally {
    await closeDriven(p);
  }
});
