// TOTP autofill, Stage 2 patch 2: per-site grants (docs/design/notes/AUTOFILL2-NOTES.md §7). A test cannot answer Chrome's
// permission prompt, so the e2e build grants two Stage 2 fixture hosts up front (manifest.e2e.json: grantedtls.fix.test
// over https, granted.fix.test over http); a request for one of them is answered at once, without a prompt, and a request
// for any other host is refused (this build declares no optional host permission). Stage 1's fixture hosts stay ungranted.
// Chrome's real prompt, its "Deny", and a popup closing under it are owner checks (OWNER-CHECKLIST item 24).
//   - The Fill card's offer: after a fill on an https page at the default port, once; "Turn on" asks for exactly that site
//     in the click itself, and the site is on the list; nothing on an http page (even a granted host's), at another port
//     or on an IP address; "Not now", and a site Chrome will not grant, are not offered again.
//   - Settings › Security › Autofill (#autofill): the sites with Chrome's grant as Chrome says it now; Turn on again;
//     Remove (off the list even where Chrome refuses to remove a required grant).
//   - A grant withdrawn in Chrome's own settings (chrome://extensions › Site access) shows as "Turned off in Chrome", and
//     the list keeps the site; granted back, it is On again.
import { expect, test, type Page } from "@playwright/test";
import {
  clickFill,
  clickFillAnyway,
  codesNow,
  GRANTED,
  GRANTED_TLS,
  TLS_HOST,
  urlOf,
  windowOpen,
  world,
  type World,
} from "./autofill-helpers";
import { openOptions } from "./harness";
import type { PanelPage } from "./panel-helpers";

let w: World | undefined;
test.afterEach(async () => {
  await w?.close();
  w = undefined;
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const worker = (x: World) => x.p.ctx.serviceWorkers()[0]!;
const stored = (x: World, area: "local" | "session", key: string) =>
  worker(x).evaluate(
    async ([a, k]) => ((await chrome.storage[a as "local" | "session"].get(k!))[k!] ?? null) as unknown,
    [area, key],
  );
const sites = (x: World) => stored(x, "local", "sk_af_sites");
/** A tab at exactly this address, in front. */
async function tabAt(x: World, url: string): Promise<Page> {
  const page = await x.p.ctx.newPage();
  await page.goto(url);
  await page.bringToFront();
  return page;
}
/** Fill the empty box from the surface (answering the http question where it is asked): the code is in, "Code filled". */
async function fill(s: PanelPage, page: Page, http = false): Promise<void> {
  const box = page.locator("input").first();
  expect(await box.inputValue()).toBe("");
  await s.until("document.querySelector('.fillbar.ok')", "the box found");
  await windowOpen();
  if (http) await clickFillAnyway(s);
  else await clickFill(s);
  await expect.poll(() => box.inputValue(), { message: "the code in the box" }).toMatch(/^\d{6}$/);
  expect(await codesNow()).toContain(await box.inputValue());
  await s.until("document.querySelector('.sect.site .fillnote.ok')", "Code filled");
}
const offer = (s: PanelPage) => s.eval<string | null>("document.querySelector('.fillsite')?.textContent ?? null");
/** Record what the page asks of chrome.permissions.request (the call passes through, inside the same gesture). */
const recordAsks = (s: PanelPage) =>
  s.eval(`(() => {
    const p = chrome.permissions; const real = p.request.bind(p); window.__asked = [];
    p.request = (x) => (window.__asked.push(x), real(x));
    return p.request !== real;
  })()`);
async function closePopup(x: World, s: PanelPage): Promise<void> {
  await s.eval("void setTimeout(() => window.close(), 50)");
  await expect
    .poll(async () => {
      const { targetInfos } = (await x.d.bs.send("Target.getTargets")) as {
        targetInfos: { url: string; type: string }[];
      };
      return targetInfos.some((t) => t.url === `chrome-extension://${x.p.id}/popup/index.html` && t.type !== "tab");
    })
    .toBe(false);
}

for (const surface of ["popup", "panel"] as const)
  test(`${surface}: after a fill on an https site, the Fill card offers to suggest codes there; Turn on asks Chrome for exactly that site, and the site is on the list and On in Settings`, async () => {
    test.setTimeout(120_000);
    w = await world({ surface, tls: true });
    const page = await w.tab(GRANTED_TLS, "/otc");
    expect(page.url()).toBe(`https://${GRANTED_TLS}/otc`); // the default port: the host rule maps it to the TLS server
    const s = await w.icon(page);
    await fill(s, page);
    await s.until("document.querySelector('.fillsite')", "the offer");
    expect(await offer(s)).toContain(`Suggest codes automatically on ${GRANTED_TLS}?`);
    expect(await offer(s)).toContain(`read and change your data on ${GRANTED_TLS}`);
    const recorded = await recordAsks(s);
    await s.gesture("document.querySelector('.fillsiteon').click()");
    await s.until(
      `document.querySelector('.sect.site .fill')?.textContent.includes('Code suggestions are on for ${GRANTED_TLS}.')`,
      "turned on",
    );
    expect(recorded).toBe(true);
    // with `scripting`, in the one request (optional since wave 1b: a site turned on before any Fill gets it there)
    expect(await s.eval("window.__asked")).toEqual([
      { permissions: ["scripting"], origins: [`https://${GRANTED_TLS}/*`] },
    ]);
    expect(await sites(w)).toEqual({ v: 1, hosts: [GRANTED_TLS] });
    expect(await stored(w, "session", "sk_af_pending")).toBeNull();
    // the offer is not made again for a site on the list (a new popup on the page, filled again)
    if (surface === "popup") {
      await closePopup(w, s);
      await page.reload();
      const again = await w.icon(page);
      await fill(again, page);
      await wait(500);
      expect(await offer(again)).toBeNull();
    }
    // Settings › Security › Autofill (a tab of its own: the toolbar popup closes when it opens)
    const opt = await openOptions(w.p, "#autofill");
    const row = opt.locator(`#afs-sites tr[data-host="${GRANTED_TLS}"]`);
    await expect(row).toContainText("On");
    await expect(row.locator(".afs-again")).toHaveCount(0);
    await expect(opt.locator("#afs-old")).toHaveCount(0); // this Chromium can close storage to pages
  });

test("no offer on an http page (even of a granted host), at another port or on an IP address; a site Chrome will not grant, and Not now, are not offered again", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "panel", tls: true });
  const panelFor = async (page: Page) => w!.icon(page);
  // http, of a host this build grants, at the default port (the host rule maps it to the plain server's): no offer
  let page = await tabAt(w, `http://${GRANTED}/otc`);
  let s = await panelFor(page);
  await fill(s, page, true);
  await wait(500);
  expect(await offer(s)).toBeNull();
  // https at another port (tls.fix.test's own address has one): no offer
  page = await w.tab(TLS_HOST, "/otc");
  expect(new URL(urlOf(w.site, TLS_HOST, "/otc")).port).not.toBe("");
  s = await panelFor(page);
  await fill(s, page);
  await wait(500);
  expect(await offer(s)).toBeNull();
  // an IP address (Example is registered for 127.0.0.1): no offer
  page = await w.tab("127.0.0.1", "/otc");
  s = await panelFor(page);
  await fill(s, page);
  await wait(500);
  expect(await offer(s)).toBeNull();
  // https at the default port, a site this build does not grant: offered; Turn on is refused by Chrome (no optional
  // host permission in this build), so nothing is on the list, and it is not offered again
  page = await tabAt(w, `https://${TLS_HOST}/otc`);
  s = await panelFor(page);
  await fill(s, page);
  await s.until("document.querySelector('.fillsite')", "the offer");
  await s.gesture("document.querySelector('.fillsiteon').click()");
  await s.until("!document.querySelector('.fillsite')", "the offer gone");
  expect(await sites(w)).toBeNull();
  expect(await stored(w, "session", "sk_af_later")).toEqual({ v: 1, hosts: [TLS_HOST] });
  await page.reload();
  await fill(s, page);
  await wait(500);
  expect(await offer(s)).toBeNull();
  // Not now, on the granted https host: nothing asked, nothing on the list, not offered again
  page = await w.tab(GRANTED_TLS, "/otc");
  s = await panelFor(page);
  await fill(s, page);
  await s.until("document.querySelector('.fillsite')", "the offer");
  await s.eval("[...document.querySelectorAll('.fillsite button')].at(-1).click()");
  await s.until("!document.querySelector('.fillsite')", "the offer gone");
  expect(await sites(w)).toBeNull();
  await page.reload();
  await fill(s, page);
  await wait(500);
  expect(await offer(s)).toBeNull();
});

test("Settings › Security › Autofill: each site with Chrome's grant as Chrome says it now; Turn on again asks Chrome; Remove takes a site off the list, even one whose grant Chrome will not remove", async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "popup" });
  await worker(w).evaluate(
    (hosts) => chrome.storage.local.set({ sk_af_sites: { v: 1, hosts } }),
    [GRANTED_TLS, TLS_HOST, "example.org"],
  );
  const opt = await openOptions(w.p, "#autofill");
  // a leaf of the Security group
  await expect(opt.locator('.rail nav a[href="#security"]')).toHaveAttribute("aria-current", "true");
  await expect(opt.locator('.subnav a[href="#autofill"]')).toHaveAttribute("aria-current", "page");
  const row = (h: string) => opt.locator(`#afs-sites tr[data-host="${h}"]`);
  await expect(row(GRANTED_TLS)).toContainText("On");
  await expect(row(TLS_HOST)).toContainText("Turned off in Chrome");
  await expect(row("example.org")).toContainText("Turned off in Chrome");
  await expect(opt.locator("#autofill")).toContainText(
    "Chrome keeps this list of sites in its own settings, unencrypted.",
  );
  // Turn on again: a real click asks Chrome; this build cannot grant tls.fix.test, so it stays off
  await row(TLS_HOST).locator(".afs-again").click();
  await wait(500);
  await expect(row(TLS_HOST)).toContainText("Turned off in Chrome");
  // Remove
  await row("example.org").locator(".afs-remove").click();
  await expect(row("example.org")).toHaveCount(0);
  await row(GRANTED_TLS).locator(".afs-remove").click(); // its grant is a required one here: Chrome keeps it
  await expect(row(GRANTED_TLS)).toHaveCount(0);
  expect(await sites(w)).toEqual({ v: 1, hosts: [TLS_HOST] });
  await row(TLS_HOST).locator(".afs-remove").click();
  await expect(opt.locator("#autofill")).toContainText("No sites yet.");
  expect(await sites(w)).toEqual({ v: 1, hosts: [] });
});

test("a grant withdrawn in Chrome's own settings (chrome://extensions › Site access) reads Turned off in Chrome; the list keeps the site; granted back, it is On again", async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "popup" });
  await worker(w).evaluate(() => chrome.storage.local.set({ sk_af_sites: { v: 1, hosts: ["grantedtls.fix.test"] } }));
  const opt = await openOptions(w.p, "#autofill");
  const row = opt.locator(`#afs-sites tr[data-host="${GRANTED_TLS}"]`);
  await expect(row).toContainText("On");
  // what the extensions page's "Site access" control calls (chrome.developerPrivate, only on that page)
  const ext = await w.p.ctx.newPage();
  await ext.goto("chrome://extensions/");
  const access = (hostAccess: string) =>
    ext.evaluate(
      ([id, a]) =>
        (
          chrome as unknown as {
            developerPrivate: { updateExtensionConfiguration(u: unknown): Promise<void> };
          }
        ).developerPrivate.updateExtensionConfiguration({ extensionId: id, hostAccess: a }),
      [w!.p.id, hostAccess],
    );
  await access("ON_CLICK");
  await expect(row).toContainText("Turned off in Chrome");
  expect(await sites(w)).toEqual({ v: 1, hosts: [GRANTED_TLS] });
  await access("ON_ALL_SITES");
  await expect(row).toContainText("On");
  await expect(row).not.toContainText("Turned off");
});

test("the list across computers (the owner's request of 2026-11-18): this computer's site is marked on its accounts in the vault; a computer without it offers it, turned on by a click; Remove takes the mark off", async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "popup" }); // Example is registered for fix.test
  await worker(w).evaluate((hosts) => chrome.storage.local.set({ sk_af_sites: { v: 1, hosts } }), [GRANTED_TLS]);
  const opt = await openOptions(w.p, "#autofill");
  const row = opt.locator(`#afs-sites tr[data-host="${GRANTED_TLS}"]`);
  await expect(row).toContainText("On");
  await expect(opt.locator("#afs-others")).toHaveCount(0); // on this computer: nothing to offer
  // another computer: the vault carries the mark, its own list does not have the site (here: the list emptied)
  await wait(1000); // the mark is written once the page has read the list
  await worker(w).evaluate(() => chrome.storage.local.set({ sk_af_sites: { v: 1, hosts: [] } }));
  const other = opt.locator(`#afs-others tr[data-host="${GRANTED_TLS}"]`);
  await expect(other).toBeVisible();
  await expect(opt.locator("#afs-others")).toContainText("Turned on on your other computers");
  expect(await sites(w)).toEqual({ v: 1, hosts: [] }); // only offered: never put on this computer's list by itself
  await other.locator(".afs-here").click(); // Chrome's grant (a required one in this build), then this computer's list
  await expect(row).toContainText("On");
  await expect(opt.locator("#afs-others")).toHaveCount(0);
  expect(await sites(w)).toEqual({ v: 1, hosts: [GRANTED_TLS] });
  // Remove: off this computer's list and off the accounts, so no computer offers it any more
  await row.locator(".afs-remove").click();
  await expect(opt.locator("#autofill")).toContainText("No sites yet.");
  await wait(1000);
  await expect(opt.locator("#afs-others")).toHaveCount(0);
});
