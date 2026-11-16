// TOTP autofill, Stage 2 patch 1: the pending fill request R and the fill after an unlock (docs/design/notes/AUTOFILL2-NOTES.md).
// The `fill` shortcut's handler is called in the worker (__skFill, the e2e build's hook: a test cannot press a browser
// shortcut); the toolbar icon's real click (panel-helpers.ts) gives the tab activeTab first, as the key itself would. The
// popup that the worker opens with action.openPopup() is reached through the browser's DevTools session (popupPage).
// What must hold: the code goes into the page only after the unlock typed into THIS surface while it showed R's line, for R
// from a locked vault and one account; never into a tab of a window behind, never after a lock, never after 60 s, never
// into another page or tab, never without the http question; several accounts are only offered.
import { expect, test, type Page } from "@playwright/test";
import { clickFill, codesNow, popupPage, TLS_HOST, urlOf, windowOpen, world, type World } from "./autofill-helpers";
import { openFold, openOptions, STRONG } from "./harness";
import type { PanelPage } from "./panel-helpers";

let w: World | undefined;
test.afterEach(async () => {
  await w?.close();
  w = undefined;
});

const PIN = "246813";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const value = (page: Page, sel = "input") => page.locator(sel).first().inputValue();
const worker = (x: World) => x.p.ctx.serviceWorkers()[0]!;
/** The shortcut's handler (the key cannot be pressed from a test); resolves after the toolbar's few seconds. */
const press = (x: World) =>
  worker(x).evaluate(() => (globalThis as unknown as { __skFill: (t?: unknown) => Promise<void> }).__skFill());
/** R as it is in chrome.storage.session now, or null. */
const req = (x: World) =>
  worker(x).evaluate(
    async () =>
      ((await chrome.storage.session.get("sk_fill_req")).sk_fill_req ?? null) as Record<string, unknown> | null,
  );
/** Sixkey locked: the session's key gone, as after a browser restart (the master password, or a PIN set, opens it). */
const lockToPassword = (x: World) => worker(x).evaluate(() => chrome.storage.session.clear());
/** Whether a popup of Sixkey's is open (a DevTools target at popup/index.html that is not a tab). */
async function popupOpen(x: World): Promise<boolean> {
  const { targetInfos } = (await x.d.bs.send("Target.getTargets")) as {
    targetInfos: { url: string; type: string }[];
  };
  return targetInfos.some((t) => t.url === `chrome-extension://${x.p.id}/popup/index.html` && t.type !== "tab");
}
async function closePopup(x: World, s: PanelPage): Promise<void> {
  await s.eval("void setTimeout(() => window.close(), 50)");
  await expect.poll(() => popupOpen(x), { message: "the popup closed" }).toBe(false);
}
/** Type into the lock screen's field (the PIN sends itself at its length; a password is sent with the Unlock button). */
async function typeSecret(s: PanelPage, v: string, submit = true): Promise<void> {
  await s.eval(`(() => {
    const i = document.querySelector("#pin") || document.querySelector("#secret");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ${JSON.stringify(v)});
    i.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  if (!submit) return;
  await s.until("!document.querySelector('form.lock button[type=submit]')?.disabled", "the button");
  await s.eval("document.querySelector('form.lock button[type=submit]').click()");
}
const line = (s: PanelPage) => s.eval<string>("document.querySelector('#lock-fill')?.textContent ?? ''");
/** Settings › Security: the PIN, set with the master password (QUICK-PIN; as quick-pin.spec.ts does). */
async function setPin(x: World, always = false): Promise<void> {
  const opt = await openOptions(x.p, "#security");
  await expect(opt.locator(".status dd.num")).toHaveText(/^\d+$/);
  await openFold(opt, "pin-box");
  await opt.locator("#pin-pw").fill(STRONG);
  await opt.locator("#pin-new").fill(PIN);
  await opt.locator("#pin-new2").fill(PIN);
  await opt.locator("#pin-set").click();
  await expect(opt.locator("#pin-info")).toBeVisible();
  if (always) {
    await opt.locator("#al-mode").selectOption("always"); // lock every time the popup closes: a lock, which the PIN opens
    await expect(opt.locator("#unlock-pin")).toBeVisible();
    await opt.locator("#unlock-pin").fill(PIN);
    await opt.locator("#unlock-btn").click();
    await expect(opt.locator("#unlock-pin")).toHaveCount(0);
  }
  await opt.close();
}

test("popup, locked to the master password: Alt+Shift+F opens the popup on the lock screen with the page's line; the password typed there fills the page, and the popup closes", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "popup" });
  // the service worker's lifecycle from here, for a failure's message (AF2-77: a rare stall in which the worker answers no
  // evaluate for 15 s; a restart behind it, or none, is what the next one must show)
  const t0 = Date.now();
  const life: string[] = [];
  const mark = (what: string) => void life.push(`${((Date.now() - t0) / 1000).toFixed(1)} s ${what}`);
  const follow = (sw: { on(e: "close", f: () => void): unknown }) =>
    sw.on("close", () => mark("a service worker closed"));
  w.p.ctx.serviceWorkers().forEach(follow);
  w.p.ctx.on("serviceworker", (sw) => (mark("a new service worker"), follow(sw)));
  const page = await w.tab("127.0.0.1", "/otc");
  let s = await w.icon(page);
  await s.until("document.querySelector('.fillbar.ok')", "found");
  await closePopup(w, s);
  await lockToPassword(w);
  await windowOpen(14);
  mark("the shortcut pressed");
  const pressed = press(w);
  // R is written before the popup is opened (fill-command.ts runShortcut), so a failure here or below says which side
  // stalled: the shortcut itself (no R), or the browser's popup (R, and no popup: popupPage lists what it saw). AF2-77
  try {
    await expect
      .poll(() => req(w!), { message: "the shortcut's request R", timeout: 15_000 })
      .toMatchObject({ v: 1, why: "locked" });
  } catch (e) {
    const { targetInfos } = (await w.d.bs.send("Target.getTargets")) as {
      targetInfos: { url: string; type: string }[];
    };
    const seen = targetInfos.map((t) => `${t.type} ${t.url.replace(`chrome-extension://${w!.p.id}`, "ext")}`);
    throw new Error(
      `${(e as Error).message}\nworker lifecycle: ${JSON.stringify(life)}; workers now: ${w.p.ctx.serviceWorkers().length}; targets: ${JSON.stringify(seen)}`,
    );
  }
  s = await popupPage(w.d, w.p);
  await s.until("document.querySelector('#lock-fill')", "the line");
  expect(await line(s)).toBe("Unlock to fill the code on 127.0.0.1");
  expect(await s.eval("document.activeElement?.id")).toBe("secret"); // the field has the focus
  expect(await req(w)).toMatchObject({ v: 1, why: "locked", host: "127.0.0.1" });
  expect(await value(page)).toBe("");
  await typeSecret(s, STRONG);
  await expect.poll(() => value(page), { message: "filled after the unlock", timeout: 20_000 }).toMatch(/^\d{6}$/);
  expect(await codesNow()).toContain(await value(page));
  expect(await req(w)).toBeNull(); // taken: one use
  await expect.poll(() => popupOpen(w!), { message: "the popup closes after the fill", timeout: 10_000 }).toBe(false);
  await pressed;
});

test("panel open on the PIN lock screen: Alt+Shift+F shows the page's line in the open panel; the PIN fills the page; the panel stays and says so", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "panel" });
  await setPin(w);
  const page = await w.tab("127.0.0.1", "/otc");
  const panel = await w.icon(page);
  await panel.until("document.querySelector('.fillbar.ok')", "found");
  await panel.eval("document.querySelector('#lock-now').click()");
  await panel.until("document.querySelector('#pin')", "the PIN lock screen");
  expect(await line(panel)).toBe(""); // no request yet
  await windowOpen(14);
  const pressed = press(w);
  await panel.until("document.querySelector('#lock-fill')", "the line arrives in the open panel");
  expect(await line(panel)).toBe("Unlock to fill the code on 127.0.0.1");
  await typeSecret(panel, PIN, false); // sends itself at its length
  await expect.poll(() => value(page), { message: "filled after the PIN", timeout: 20_000 }).toMatch(/^\d{6}$/);
  expect(await codesNow()).toContain(await value(page));
  await panel.until("document.querySelector('.fillnote.ok')", "the card says so");
  expect(await req(w)).toBeNull();
  await pressed;
});

test("a second window at R's exact address (the reviewer's V-A): only the tab tells them apart; no line in the second window, nothing filled in either", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "popup" });
  const one = await w.tab("127.0.0.1", "/otc?n=same");
  let s = await w.icon(one);
  await s.until("document.querySelector('.fillbar.ok')", "found");
  await closePopup(w, s);
  await lockToPassword(w);
  await windowOpen(25);
  const pressed = press(w);
  s = await popupPage(w.d, w.p);
  await s.until("document.querySelector('#lock-fill')", "the line in the first window");
  const rUrl = String((await req(w))!.url);
  await closePopup(w, s);
  const [two] = await Promise.all([
    w.p.ctx.waitForEvent("page"),
    worker(w).evaluate(
      (u) => chrome.windows.create({ url: u, focused: true }),
      urlOf(w.site, "127.0.0.1", "/otc?n=w2"),
    ),
  ]);
  await two.waitForLoadState();
  s = await w.icon(two); // activeTab for the second window's tab, and that window's popup, on the lock screen
  await s.until("document.querySelector('form.lock')", "the lock screen in the second window");
  // the same document takes R's exact address (no navigation, so activeTab stays): only the tab's ID differs now
  await two.evaluate((u) => history.replaceState(null, "", new URL(u).pathname + new URL(u).search), rUrl);
  expect(two.url()).toBe(rUrl);
  await wait(1500);
  expect(await line(s)).toBe("");
  await typeSecret(s, STRONG);
  await s.until("document.querySelector('#q')", "unlocked in the second window");
  await wait(3000);
  expect(await value(one)).toBe("");
  expect(await value(two)).toBe("");
  expect(await req(w)).toMatchObject({ why: "locked" }); // not taken
  await pressed;
});

test("a second window: R from the first; Sixkey unlocked in the second shows no line there and fills neither window's page", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "popup" });
  const one = await w.tab("127.0.0.1", "/otc?n=one");
  let s = await w.icon(one);
  await s.until("document.querySelector('.fillbar.ok')", "found");
  await closePopup(w, s);
  await lockToPassword(w);
  await windowOpen(20);
  const pressed = press(w);
  s = await popupPage(w.d, w.p);
  await s.until("document.querySelector('#lock-fill')", "the line in the first window");
  await closePopup(w, s); // the user leaves it, and goes to another window
  const [two] = await Promise.all([
    w.p.ctx.waitForEvent("page"),
    worker(w).evaluate(
      (u) => chrome.windows.create({ url: u, focused: true }),
      urlOf(w.site, "127.0.0.1", "/otc?n=two"),
    ),
  ]);
  await two.waitForLoadState();
  s = await w.icon(two); // the popup of the second window, on its tab
  await s.until("document.querySelector('form.lock')", "the lock screen in the second window");
  await wait(500);
  expect(await line(s)).toBe(""); // R's tab is not the tab in front of THIS window
  await typeSecret(s, STRONG);
  await s.until("document.querySelector('#q')", "unlocked in the second window");
  await wait(3000);
  expect(await value(one)).toBe("");
  expect(await value(two)).toBe("");
  expect(await req(w)).toMatchObject({ why: "locked" }); // not taken
  await pressed;
});

for (const [what, change] of [
  ["a lock since (the lock epoch moved on)", "lock"],
  ["more than 60 s since the key", "old"],
  ["the tab went to another page", "page"],
] as const)
  test(`the line goes, and the unlock fills nothing: ${what}`, async () => {
    test.setTimeout(150_000);
    w = await world({ surface: "popup" });
    const page = await w.tab("127.0.0.1", "/otc");
    let s = await w.icon(page);
    await s.until("document.querySelector('.fillbar.ok')", "found");
    await closePopup(w, s);
    await lockToPassword(w);
    await windowOpen(14);
    const pressed = press(w);
    s = await popupPage(w.d, w.p);
    await s.until("document.querySelector('#lock-fill')", "the line");
    if (change === "lock")
      // what every lock does (platform/session.ts bumpLockEpoch)
      await worker(w).evaluate(async () => {
        const e = (await chrome.storage.session.get("sk_lock_epoch")).sk_lock_epoch;
        await chrome.storage.session.set({ sk_lock_epoch: (typeof e === "number" ? e : 0) + 1 });
      });
    else if (change === "old")
      await worker(w).evaluate(async () => {
        const r = (await chrome.storage.session.get("sk_fill_req")).sk_fill_req as { at: number };
        await chrome.storage.session.set({ sk_fill_req: { ...r, at: r.at - 61_000 } });
      });
    else await page.goto(page.url().replace("/otc", "/otc?n=moved"));
    await s.until("!document.querySelector('#lock-fill')", "the line has gone");
    await typeSecret(s, STRONG);
    await s.until("document.querySelector('#q')", "unlocked");
    await wait(3000);
    expect(await value(page)).toBe("");
    expect(await s.eval("document.querySelectorAll('.fillnote.ok').length")).toBe(0);
    await pressed;
  });

test("the side panel: a tab switch takes the line away, and the unlock fills neither tab", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "panel" });
  const one = await w.tab("127.0.0.1", "/otc?n=one");
  const panel = await w.icon(one);
  const two = await w.tab("127.0.0.1", "/otc?n=two");
  await w.d.clickIcon("n=two");
  await panel.eval(
    `chrome.tabs.query({}).then((t) => chrome.tabs.update(t.find((x) => (x.url ?? "").includes("n=one")).id, { active: true }))`,
  );
  await panel.until("document.querySelector('.fillbar.ok')", "found");
  await panel.eval("document.querySelector('#lock-now').click()");
  await panel.until("document.querySelector('form.lock')", "locked");
  await windowOpen(20);
  const pressed = press(w);
  await panel.until("document.querySelector('#lock-fill')", "the line for the first tab");
  await panel.eval(
    `chrome.tabs.query({}).then((t) => chrome.tabs.update(t.find((x) => (x.url ?? "").includes("n=two")).id, { active: true }))`,
  );
  await panel.until("!document.querySelector('#lock-fill')", "the line has gone");
  await typeSecret(panel, STRONG);
  await panel.until("document.querySelector('#q')", "unlocked");
  await wait(3000);
  expect(await value(one)).toBe("");
  expect(await value(two)).toBe("");
  await pressed;
});

test("two presses: the second request replaces the first, the line follows it, and the unlock fills once", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "popup" });
  const page = await w.tab("127.0.0.1", "/otc");
  let s = await w.icon(page);
  await s.until("document.querySelector('.fillbar.ok')", "found");
  await closePopup(w, s);
  await lockToPassword(w);
  await windowOpen(18);
  const first = press(w);
  s = await popupPage(w.d, w.p);
  await s.until("document.querySelector('#lock-fill')", "the line");
  const r1 = await req(w);
  await page.evaluate(() => {
    const i = document.querySelector("input")!;
    (window as unknown as { __inputs: number }).__inputs = 0;
    i.addEventListener("input", () => (window as unknown as { __inputs: number }).__inputs++);
  });
  const second = press(w); // (the popup is open already: the browser does not open another one)
  await expect.poll(async () => (await req(w!))?.nonce, { message: "a new request" }).not.toBe(r1!.nonce);
  await typeSecret(s, STRONG);
  await expect.poll(() => value(page), { timeout: 20_000 }).toMatch(/^\d{6}$/);
  expect(await page.evaluate(() => (window as unknown as { __inputs: number }).__inputs)).toBe(1); // one fill
  expect(await req(w)).toBeNull();
  await Promise.all([first, second]);
});

test("a plain http page: after the unlock the M5 question is asked; nothing is filled before Fill anyway", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "popup" });
  const page = await w.tab("app.fix.test", "/otc");
  let s = await w.icon(page);
  await s.until("document.querySelector('.fillbar.ok')", "found");
  await closePopup(w, s);
  await lockToPassword(w);
  await windowOpen(18);
  const pressed = press(w);
  s = await popupPage(w.d, w.p);
  await s.until("document.querySelector('#lock-fill')", "the line");
  expect(await line(s)).toBe("Unlock to fill the code on app.fix.test");
  await typeSecret(s, STRONG);
  await s.until("document.querySelector('.fillanyway')", "the not-secure question");
  await wait(1500);
  expect(await value(page)).toBe("");
  await s.eval("document.querySelector('.fillanyway').click()");
  await expect.poll(() => value(page), { timeout: 20_000 }).toMatch(/^\d{6}$/);
  await pressed;
});

test("several accounts for the site, Sixkey unlocked: the popup opens on the list, the first Fill button is offered (focused), nothing is filled", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "popup", accounts: ["example", "work", "related"] });
  const page = await w.tab("app.fix.test", "/otc");
  let s = await w.icon(page);
  await s.until("document.querySelectorAll('.sect.site .fillbtn').length === 2", "two cards with a button");
  await closePopup(w, s);
  const pressed = press(w);
  s = await popupPage(w.d, w.p);
  await s.until("document.activeElement?.classList.contains('fillbtn')", "the first Fill button has the focus");
  expect(await req(w)).toMatchObject({ why: "choose" });
  await wait(2000);
  expect(await value(page)).toBe("");
  await pressed;
});

test("a shortcut that fills by itself (unlocked, one account) leaves no request: a popup opened afterwards fills nothing", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "popup" });
  const page = await w.tab("127.0.0.1", "/otc");
  let s = await w.icon(page);
  await s.until("document.querySelector('.fillbar.ok')", "found");
  await closePopup(w, s);
  await windowOpen(14);
  await press(w);
  const code = await value(page);
  expect(code).toMatch(/^\d{6}$/);
  expect(await req(w)).toBeNull();
  await page.locator("input").fill("");
  s = await w.icon(page);
  await s.until("document.querySelector('.fillbar.ok')", "found");
  await wait(1500);
  expect(await value(page)).toBe("");
  expect(await s.eval("document.activeElement?.classList.contains('fillbtn') ?? false")).toBe(false);
});

test("unlocked elsewhere (the settings page) after the request: the popup opened on the page only offers the Fill button; nothing is filled until it is pressed", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "popup" });
  const page = await w.tab("127.0.0.1", "/otc");
  let s = await w.icon(page);
  await s.until("document.querySelector('.fillbar.ok')", "found");
  await closePopup(w, s);
  await lockToPassword(w);
  await windowOpen(20);
  const pressed = press(w);
  s = await popupPage(w.d, w.p);
  await s.until("document.querySelector('#lock-fill')", "the line");
  await closePopup(w, s);
  const opt = await openOptions(w.p);
  await opt.locator("#unlock-pw").fill(STRONG);
  await opt.locator("#unlock-btn").click();
  await expect(opt.locator("#unlock-pw")).toHaveCount(0);
  await opt.close();
  await page.bringToFront();
  s = await w.icon(page); // opened by the user, already unlocked: not this popup's own unlock
  await s.until("document.activeElement?.classList.contains('fillbtn')", "the Fill button is offered");
  await wait(2000);
  expect(await value(page)).toBe("");
  await clickFill(s);
  await expect.poll(() => value(page), { timeout: 20_000 }).toMatch(/^\d{6}$/);
  await pressed;
});

test("lock every time: Alt+Shift+F opens the popup on the PIN with the page's line; the PIN fills the page; the popup closes, which is the lock", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "popup" });
  await setPin(w, true);
  const page = await w.tab("127.0.0.1", "/otc");
  let s = await w.icon(page); // (activeTab for the tab; the popup is on the lock screen in this mode)
  await s.until("document.querySelector('#pin')", "the PIN lock screen");
  await closePopup(w, s);
  await windowOpen(14);
  const pressed = press(w);
  s = await popupPage(w.d, w.p);
  await s.until("document.querySelector('#lock-fill')", "the line");
  await typeSecret(s, PIN, false);
  await expect.poll(() => value(page), { message: "filled after the PIN", timeout: 20_000 }).toMatch(/^\d{6}$/);
  expect(await codesNow()).toContain(await value(page));
  await expect.poll(() => popupOpen(w!), { message: "the popup closes", timeout: 10_000 }).toBe(false);
  s = await w.icon(page);
  await s.until("document.querySelector('#pin')", "locked again: the popup closing was the lock");
  await pressed;
});

test("several accounts for the site, locked: after the unlock the list says to choose and offers the first Fill button; nothing is filled; a later press while the list stays open is offered too", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "popup", accounts: ["example", "work"], tls: true });
  const page = await w.tab(TLS_HOST, "/otc"); // https: no question; both accounts are registered for fix.test
  let s = await w.icon(page);
  await s.until("document.querySelectorAll('.sect.site .fillbtn').length === 2", "two cards with a button");
  await closePopup(w, s);
  await lockToPassword(w);
  await windowOpen(18);
  const pressed = press(w);
  s = await popupPage(w.d, w.p);
  await s.until("document.querySelector('#lock-fill')", "the line");
  await typeSecret(s, STRONG);
  await s.until(
    "/Choose the account to fill the code on tls.fix.test/.test(document.body.textContent)",
    "the line to choose",
  );
  await s.until("document.activeElement?.classList.contains('fillbtn')", "the first Fill button is offered");
  await wait(2000);
  expect(await value(page)).toBe("");
  await pressed;
  // a later press while this list stays open (AUTOFILL2-P1-VERIFY NIT-1): its request is offered too, not left unseen
  // because the list once resumed
  await s.eval("document.querySelector('#q').focus()");
  expect(await s.eval<boolean>("document.activeElement?.id === 'q'")).toBe(true);
  await windowOpen(18);
  const again = press(w);
  await expect.poll(async () => (await req(w!))?.why, { message: "the later request" }).toBe("choose");
  await s.until("document.activeElement?.classList.contains('fillbtn')", "the later request is offered");
  await wait(1500);
  expect(await value(page)).toBe("");
  await again;
});
