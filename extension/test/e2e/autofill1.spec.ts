// TOTP autofill, Stage 1, through the extension in real Chromium (docs/design/notes/AUTOFILL1-NOTES.md §8). The browser's own click
// on the toolbar icon (Extensions.triggerAction: test/e2e/panel-helpers.ts) grants activeTab for the clicked tab, exactly as a
// person's click does, and the extension has no host permission in this build for the fixture sites: everything below works
// by activeTab and a user action alone, including a frame of another host (which the design left open: probe P2).
// The accounts: Example (registered for fix.test and 127.0.0.1, 6 digits), Work (fix.test, 8 digits), Related (no sites).
// Most pages are on the IP address 127.0.0.1 (http is fine there, M5); the *.fix.test hosts are http and ask first.
import { expect, test, type Page } from "@playwright/test";
import { acceptable, SECRET } from "./harness";
import {
  barText,
  clickFill,
  clickFillAnyway,
  codesNow,
  rowNames,
  TLS_HOST,
  urlOf,
  windowOpen,
  world,
  type World,
} from "./autofill-helpers";
import type { PanelPage } from "./panel-helpers";

let w: World | undefined;
test.afterEach(async () => {
  await w?.close();
  w = undefined;
});

const value = (page: Page, sel = "input") => page.locator(sel).first().inputValue();
const events = (page: Page) => page.evaluate(() => (window as unknown as { __ev: string[] }).__ev);
const groupValue = (page: Page) =>
  page.locator("#g input").evaluateAll((e) => e.map((x) => (x as HTMLInputElement).value).join(""));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the owner's login page, in the side panel: the card on top says the page has a code box, Fill types the code, nothing else happens", async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "panel" });
  const page = await w.tab("127.0.0.1", "/owner");
  const panel = await w.icon(page);
  await panel.until("document.querySelector('.sect.site .row')", "the account registered for this page, in This site");
  expect(await rowNames(panel)).toEqual(["Example"]);
  await panel.until("document.querySelector('.fillbar.ok')", "the strip says a code box was found");
  expect(await barText(panel)).toMatch(/Code box found/);
  // the Related account is a name guess for related.test only: not for this page, and no Fill button anywhere but "This site"
  expect(await panel.eval("document.querySelectorAll('.fillbtn').length")).toBe(1);
  expect(await panel.eval("document.querySelector('.sect.site .fillbtn').textContent")).toMatch(
    /Fill code into this page/,
  );
  expect(await panel.eval("document.querySelector('.sect.site .fillbtn').className")).not.toMatch(/ghost/); // the top match is the recommended one
  await windowOpen();
  await clickFill(panel);
  await panel.until("document.querySelector('.fillnote.ok')", "the result: filled");
  const got = await value(page, ".ant-input");
  expect(await codesNow()).toContain(got);
  expect(await value(page, "[name=username]")).toBe("");
  expect(await value(page, "[name=password]")).toBe("");
  expect(await page.locator("[name=remember]").isChecked()).toBe(false);
  expect(await page.evaluate(() => (window as unknown as { submitted?: boolean }).submitted)).toBeUndefined();
  expect(await events(page)).toEqual([]); // no submit, no click, no key
  expect(await panel.eval("document.body.innerText.includes(" + JSON.stringify(got) + ")")).toBe(false); // the panel does not show it either
});

test("the same page from the popup (the action's own popup): the same strip and button", async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "popup" });
  const page = await w.tab("127.0.0.1", "/otc");
  const pop = await w.icon(page);
  await pop.until("document.querySelector('.fillbar.ok')", "the strip says a code box was found");
  await windowOpen();
  await clickFill(pop);
  await pop.until("document.querySelector('.fillnote.ok')", "filled");
  expect(await codesNow()).toContain(await value(page));
});

test("a page with no code box says so honestly", async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "panel" });
  const page = await w.tab("127.0.0.1", "/nofield");
  const panel = await w.icon(page);
  await panel.until(
    "/No code box/.test(document.querySelector('.fillbar')?.textContent ?? '') && !document.querySelector('.fillbar.ok')",
    "no code box found",
  );
  await clickFill(panel);
  await panel.until("document.querySelector('.fillnote.bad')", "the click says so too");
  expect(await panel.eval("document.querySelector('.fillnote.bad').textContent")).toMatch(/No code box found/);
  expect(await value(page, "[name=username]")).toBe("");
  expect(await events(page)).toEqual([]);
});

test("the page changes without a navigation (a single-page app's next step): a click that finds no box, or finds its box gone, looks again and fills", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "panel" });
  const page = await w.tab("127.0.0.1", "/nofield");
  const panel = await w.icon(page);
  await panel.until(
    "/No code box/.test(document.querySelector('.fillbar')?.textContent ?? '') && !document.querySelector('.fillbar.ok')",
    "no code box yet",
  );
  // the next step is drawn in the same document: no navigation, so nothing tells the panel to look again
  await page.evaluate(() => {
    const i = document.createElement("input");
    i.id = "late";
    i.autocomplete = "one-time-code";
    i.inputMode = "numeric";
    i.maxLength = 6;
    i.setAttribute("aria-label", "Authenticator code");
    document.body.append(i);
  });
  await windowOpen();
  await clickFill(panel);
  await panel.until("document.querySelector('.fillnote.ok')", "filled, after a look of the click's own");
  expect(await codesNow()).toContain(await value(page, "#late"));
  // the box is drawn anew (a framework's re-render puts a new element in its place): the panel's look is of the old one
  await page.evaluate(() => {
    const old = document.getElementById("late")!;
    const box = old.cloneNode() as HTMLInputElement;
    box.id = "late2";
    old.replaceWith(box);
  });
  await windowOpen();
  await clickFill(panel);
  await expect.poll(() => value(page, "#late2"), { message: "the new box is filled" }).toMatch(/^\d{6}$/);
  expect(await panel.eval("document.querySelectorAll('.fillnote.bad').length")).toBe(0);
});

test("a page of another site gets nothing: no card, no button, and nothing is run in it", async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "panel" });
  const page = await w.tab("evil.test", "/owner");
  const panel = await w.icon(page);
  await panel.until("document.querySelector('#q')", "the list");
  await wait(1500);
  expect(await panel.eval("document.querySelectorAll('.sect.site').length")).toBe(0);
  expect(await panel.eval("document.querySelectorAll('.fillbtn, .fillbar').length")).toBe(0);
  expect(await value(page, ".ant-input")).toBe("");
});

test('"Possibly related" never gets a Fill button: it offers to remember the site, and only that', async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "panel" });
  const page = await w.tab("related.test", "/owner");
  const panel = await w.icon(page);
  await panel.until("document.querySelector('.sect.related .row .remember')", "the guess, with Remember");
  await wait(1500);
  expect(await panel.eval("document.querySelectorAll('.fillbtn, .fillbar').length")).toBe(0);
  expect(await value(page, ".ant-input")).toBe("");
});

test("two accounts registered for the site: each card has its own button, the first is recommended, and a code that does not fit is refused", async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "panel", accounts: ["example", "work"] });
  const page = await w.tab("127.0.0.1", "/otc"); // 127.0.0.1 is Example's only: Work is registered for fix.test
  const panel = await w.icon(page);
  await panel.until("document.querySelector('.fillbar.ok')", "found");
  expect(await rowNames(panel)).toEqual(["Example"]);
  const fix = await w.tab("app.fix.test", "/otc"); // both are registered for fix.test
  await panel.eval("0");
  await w.icon(fix);
  await panel.until(
    "document.querySelectorAll('.sect.site .fillbtn').length === 2 && document.querySelector('.fillbar.ok')",
    "two cards, two buttons, the box found",
  );
  const cls = await panel.eval<string[]>(
    "[...document.querySelectorAll('.sect.site .fillbtn')].map((b) => b.className)",
  );
  expect(cls[0]).not.toMatch(/ghost/);
  expect(cls[1]).toMatch(/ghost/);
  await windowOpen();
  await clickFillAnyway(panel, "Work"); // the box takes 6 digits: the 8-digit account does not fit it
  await panel.until("document.querySelector('.fillnote.bad')", "the 8-digit code does not fit a 6-digit box");
  expect(await panel.eval("document.querySelector('.fillnote.bad').textContent")).toMatch(/does not fit.*8-digit/);
  expect(await value(fix)).toBe("");
  await clickFillAnyway(panel, "Example");
  await panel.until("document.querySelector('.fillnote.ok')", "the 6-digit account fills it");
  expect(await codesNow()).toContain(await value(fix));
});

test("six one-character boxes: filled digit by digit; the 8-digit account is refused (a group of the wrong size)", async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "panel", accounts: ["example", "work"] });
  const page = await w.tab("app.fix.test", "/seg6");
  const panel = await w.icon(page);
  await panel.until("document.querySelector('.fillbar.ok')", "the group of boxes is found");
  await windowOpen();
  await clickFillAnyway(panel, "Work");
  await panel.until("document.querySelector('.fillnote.bad')", "an 8-digit code does not fit six boxes");
  expect(await groupValue(page)).toBe("");
  await clickFillAnyway(panel, "Example");
  await panel.until("document.querySelector('.fillnote.ok')", "filled");
  expect(await codesNow()).toContain(await groupValue(page));
  expect(await events(page)).toEqual([]);
});

test("a React-controlled input and a Chinese-labelled box, through the extension (the isolated world)", async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "panel" });
  const react = await w.tab("127.0.0.1", "/react");
  const panel = await w.icon(react);
  await panel.until("document.querySelector('.fillbar.ok')", "found");
  await windowOpen();
  await clickFill(panel);
  await panel.until("document.querySelector('.fillnote.ok')", "filled");
  const got = await react.evaluate(() => (window as unknown as { __state: { value: string } }).__state.value);
  expect(await codesNow()).toContain(got);
  expect(await value(react)).toBe(got);
  await react.close();
  const zh = await w.tab("127.0.0.1", `/label?mode=placeholder&text=${encodeURIComponent("请输入动态口令")}`);
  await w.icon(zh);
  // the earlier page's note and look go once the panel has looked at this one
  await panel.until("!document.querySelector('.fillnote.ok')", "the first page's note is gone");
  await panel.until("document.querySelector('.fillbar.ok')", "found by its Chinese placeholder");
  await windowOpen();
  await clickFill(panel);
  await panel.until("document.querySelector('.fillnote.ok')", "filled");
  expect(await codesNow()).toContain(await value(zh));
});

test("frames: a frame of the same origin is filled; a frame of another host is out of activeTab's reach, and the panel says so; a hostile top page gets nothing", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "panel" });
  const inner = (host: string) => encodeURIComponent(urlOf(w!.site, host, "/otc"));
  // a frame of the page's own origin: found and filled, with activeTab alone
  const same = await w.tab("127.0.0.1", `/frame?src=${encodeURIComponent("/otc")}`);
  const panel = await w.icon(same);
  await panel.until("document.querySelector('.fillbar.ok')", "the same-origin frame's box is found");
  await windowOpen();
  await clickFill(panel);
  await panel.until("document.querySelector('.fillnote.ok')", "filled");
  const frame = same.frames().find((f) => f !== same.mainFrame())!;
  expect(await codesNow()).toContain(await frame.locator("input").inputValue());
  await same.close();
  // a frame of another host, even of the same account's domain (auth.fix.test inside app.fix.test): the browser gives
  // activeTab no access to it (probe P2: no, in this Chromium), so Sixkey says what it cannot do and writes nothing
  const cross = await w.tab("app.fix.test", `/frame?src=${inner("auth.fix.test")}`);
  await w.icon(cross);
  await panel.until(
    "/frame from another site/.test(document.querySelector('.fillbar')?.textContent ?? '')",
    "says the box may be in another site's frame",
  );
  await clickFillAnyway(panel);
  await panel.until("document.querySelector('.fillnote.bad')", "the click finds none either");
  expect(await panel.eval("document.querySelector('.fillnote.bad').textContent")).toMatch(/frame from another site/);
  expect(
    await cross
      .frames()
      .find((f) => f !== cross.mainFrame())!
      .locator("input")
      .inputValue(),
  ).toBe("");
  await cross.close();
  // a hostile top page around the real login page: the tab is not registered, so there is nothing to click
  const hostile = await w.tab("evil.test", `/frame?src=${inner("app.fix.test")}`);
  await w.icon(hostile);
  await wait(1500);
  expect(await panel.eval("document.querySelectorAll('.fillbtn').length")).toBe(0);
  expect(
    await hostile
      .frames()
      .find((f) => f !== hostile.mainFrame())!
      .locator("input")
      .inputValue(),
  ).toBe("");
});

test("an http page that is no IP address asks first (not secure), and the answer is honoured", async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "panel" });
  const page = await w.tab("app.fix.test", "/otc");
  const panel = await w.icon(page);
  await panel.until("document.querySelector('.fillbar.ok')", "found");
  await windowOpen();
  await clickFill(panel);
  await panel.until("document.querySelector('.fillnote.warn')", "asks first");
  expect(await value(page)).toBe("");
  await panel.eval(
    "[...document.querySelectorAll('.fillacts button')].find((b) => b.className.includes('quiet')).click()",
  );
  await panel.until("!document.querySelector('.fillnote.warn')", "cancelled");
  expect(await value(page)).toBe("");
  await clickFillAnyway(panel);
  await panel.until("document.querySelector('.fillnote.ok')", "filled after the answer");
  expect(await codesNow()).toContain(await value(page));
});

test("a failed load (an error page): in a tab the icon was not clicked on, no address, so no card and no button; once clicked on, its site's card, the line that Sixkey cannot look at this kind of page, and Fill says so too; nothing throws", async () => {
  // AF286: deterministic. The error page is waited for (page.url() chrome-error://), and the icon is clicked on that very
  // tab, in front (clickIconOn), as a person clicks it, long after the error page committed. Before, the click could
  // come before the error page's commit, whose navigation then took back the grant the click gave (no address), or
  // after it (the address): a race (docs/design/notes/PIN-RESTART-NOTES.md §16).
  test.setTimeout(120_000);
  w = await world({ surface: "panel" });
  const sw = w.p.ctx.serviceWorkers()[0]!;
  await sw.evaluate(() => {
    const g = globalThis as unknown as { __skErrors: string[] };
    g.__skErrors = [];
    self.addEventListener("error", (e) => g.__skErrors.push(String((e as ErrorEvent).message)));
    self.addEventListener("unhandledrejection", (e) => g.__skErrors.push(String((e as PromiseRejectionEvent).reason)));
  });
  const page = await w.tab("127.0.0.1", "/otc");
  const panel = await w.icon(page);
  await panel.until("document.querySelector('.fillbar.ok')", "the panel, open on a page of the site");
  await panel.eval(
    "(() => { window.__skErrors = []; addEventListener('error', (e) => window.__skErrors.push(String(e.message))); addEventListener('unhandledrejection', (e) => window.__skErrors.push(String(e.reason))); })()",
  );
  // a load that fails (Chrome refuses port 1: net::ERR_UNSAFE_PORT); its error page committed before anything else
  const down = await w.p.ctx.newPage();
  await down.goto(`http://down.fix.test:1/`).catch(() => undefined);
  await expect.poll(() => down.url()).toMatch(/^chrome-error:\/\//);
  await down.bringToFront();
  // the panel follows the tab in front; the icon was never clicked on this one, so the browser gives no address
  await panel.until("!document.querySelector('#panel-hint').hidden", "the hint: the icon is to be clicked on this tab");
  await panel.until("document.querySelectorAll('.fillbtn, .fillbar, .sect.site').length === 0", "no card, no button");
  await wait(1500);
  expect(await panel.eval("document.querySelectorAll('.fillbtn, .fillbar, .sect.site').length")).toBe(0);
  // the icon clicked on the failed tab itself: its address is given (down.fix.test, under the registered fix.test)
  await w.icon(down);
  await panel.until("document.querySelector('.sect.site .row')", "its site's card");
  expect(await rowNames(panel)).toEqual(["Example"]);
  await panel.until(
    "/cannot look at this kind of page|无法读取这类页面/.test(document.querySelector('.fillbar')?.textContent ?? '')",
    "the line: Sixkey cannot look at this kind of page",
  );
  expect(await panel.eval("document.querySelectorAll('.fillbar.ok').length")).toBe(0);
  // Fill looks again, cannot enter the error page either, and says why; the page is left as it is
  await clickFill(panel);
  await panel.until("document.querySelector('.fillnote.bad')", "the refusal");
  expect(await panel.eval("document.querySelector('.fillnote.bad').textContent")).toMatch(
    /cannot look at this kind of page|无法读取这类页面/,
  );
  expect(await panel.eval("document.querySelectorAll('.fillnote.ok').length")).toBe(0);
  expect(down.url()).toMatch(/^chrome-error:\/\//);
  expect(await panel.eval("window.__skErrors")).toEqual([]);
  expect(await sw.evaluate(() => (globalThis as unknown as { __skErrors: string[] }).__skErrors)).toEqual([]);
});

test("the time window: with under 5 s left the next code is filled, and the panel says when", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "panel" });
  const page = await w.tab("127.0.0.1", "/otc");
  const panel = await w.icon(page);
  await panel.until("document.querySelector('.fillbar.ok')", "found");
  const left = () => 30 - ((Date.now() / 1000) % 30);
  if (left() > 3.2) await wait((left() - 3.2) * 1000); // 3 s of the period remain
  const periodBefore = Math.floor(Date.now() / 30_000);
  await clickFill(panel);
  await panel.until(
    "document.querySelector('.fillnote') && /New code in/.test(document.querySelector('.fillnote').textContent)",
    "it waits for the next code",
  );
  await panel.until("document.querySelector('.fillnote.ok')", "and fills it", 20_000);
  const filled = await value(page);
  expect(Math.floor(Date.now() / 30_000)).toBe(periodBefore + 1);
  const { totp } = await import("../../src/core/totp/hotp");
  const { decodeBase32 } = await import("../../src/core/totp/base32");
  const at = (p: number) => totp(decodeBase32(SECRET), p * 30_000 + 1000, { algorithm: "SHA1", digits: 6, period: 30 });
  expect(filled).toBe(await at(periodBefore + 1)); // the new period's code
  expect(filled).not.toBe(await at(periodBefore));
  expect(await acceptable(SECRET, 6)).toContain(filled);
});

test("the Fill shortcut's handler: one account fills without opening anything; a locked vault fills nothing", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "panel" });
  const sw = w.p.ctx.serviceWorkers()[0]!;
  const fill = () =>
    sw.evaluate(() => (globalThis as unknown as { __skFill: (t?: unknown) => Promise<void> }).__skFill());
  const page = await w.tab("127.0.0.1", "/otc");
  await w.icon(page); // the click grants activeTab for this tab (the shortcut does the same)
  await windowOpen();
  await fill();
  await expect.poll(() => value(page), { message: "the shortcut filled the box" }).toMatch(/^\d{6}$/);
  expect(await codesNow()).toContain(await value(page));
  expect(await events(page)).toEqual([]);
  await page.close();
  const again = await w.tab("127.0.0.1", "/otc");
  await w.icon(again);
  await sw.evaluate(() => chrome.storage.session.clear());
  await fill();
  await wait(1500);
  expect(await value(again)).toBe("");
});

test("what a script injected by Sixkey (or a renderer acting as one) cannot do: read the vault's storage, or make the worker act (probe P1, here in Chromium)", async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "panel" });
  const sw = w.p.ctx.serviceWorkers()[0]!;
  const page = await w.tab("127.0.0.1", "/otc");
  await w.icon(page); // activeTab for this tab, as for a fill
  const probe = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab!.id! },
      func: async () => {
        const out: Record<string, string> = {};
        for (const area of ["local", "session"] as const)
          try {
            await chrome.storage[area].get(null);
            out[area] = "read";
          } catch (e) {
            out[area] = "denied";
          }
        try {
          // every message type the worker knows, from a web page's context
          const types = ["sk-reschedule-autolock", "sk-clip-arm", "sk-offscreen-done"];
          out.msg = (
            await Promise.all(
              types.map((type) =>
                chrome.runtime.sendMessage({ type, hash: "x" }).then(
                  (a) => JSON.stringify(a ?? null),
                  (e) => "err",
                ),
              ),
            )
          ).join(",");
        } catch (e) {
          out.msg = "throws";
        }
        out.where = location.protocol;
        return out;
      },
    });
    return r!.result as Record<string, string>;
  });
  expect(probe.where).toBe("http:");
  expect(probe.local).toBe("denied");
  expect(probe.session).toBe("denied");
  expect(probe.msg).not.toMatch(/ok|true/); // nothing was taken (an answer of null is a message ignored)
});

test("two boxes that look alike: the panel asks which, and only the one chosen is filled", async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "panel" });
  const page = await w.tab("127.0.0.1", "/two");
  const panel = await w.icon(page);
  await panel.until("document.querySelector('.fillbar.ok')", "found");
  await windowOpen();
  await clickFill(panel);
  await panel.until("/Which box/.test(document.querySelector('.fill')?.innerText ?? '')", "asks which box");
  expect(await page.locator("input").evaluateAll((e) => e.map((x) => (x as HTMLInputElement).value))).toEqual(["", ""]);
  await panel.eval("document.querySelectorAll('.fillacts .btn.ghost')[1].click()");
  await panel.until("document.querySelector('.fillnote.ok')", "filled");
  const got = await page.locator("input").evaluateAll((e) => e.map((x) => (x as HTMLInputElement).value));
  expect(got.filter((v) => v !== "")).toHaveLength(1);
  expect(await codesNow()).toContain(got.find((v) => v !== "")!);
});

test("cancel while waiting for the next code: nothing is filled, not even at the boundary", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "panel" });
  const page = await w.tab("127.0.0.1", "/otc");
  const panel = await w.icon(page);
  await panel.until("document.querySelector('.fillbar.ok')", "found");
  const left = () => 30 - ((Date.now() / 1000) % 30);
  if (left() > 3.4) await wait((left() - 3.4) * 1000);
  await clickFill(panel);
  await panel.until("/New code in/.test(document.querySelector('.fillnote')?.textContent ?? '')", "it waits");
  await panel.eval("document.querySelector('.fillacts .quiet').click()");
  await wait(6000);
  expect(await value(page)).toBe("");
  expect(await panel.eval("document.querySelectorAll('.fillnote.ok').length")).toBe(0);
});

/** Wait until about 3.4 s of the code's period are left: a Fill pressed then waits for the next code (§8.2). */
const nearTheEnd = () => wait(((30 - ((Date.now() / 1000) % 30) - 3.4 + 30) % 30) * 1000);
const fillNote = (s: PanelPage) => s.eval<string>("document.querySelector('.sect.site .fill')?.textContent ?? ''");

for (const surface of ["panel", "popup"] as const)
  test(`F7 (${surface}): Fill pressed with under 5 s left, then the page changes or the user switches tabs during the wait: nothing is filled, and the card says why`, async () => {
    test.setTimeout(300_000);
    const ww = (w = await world({ surface }));
    const two = await ww.tab("127.0.0.1", "/otc?n=two");
    await ww.icon(two);
    const one = await ww.tab("127.0.0.1", "/otc?n=one");
    let s = await ww.icon(one);
    await s.until("document.querySelector('.fillbar.ok')", "found");
    // the click on the icon again: a new popup (the old one closes itself first), or, in the panel, activeTab for the page the
    // tab shows now
    const again = async () => {
      if (surface === "popup") {
        await s.eval("void setTimeout(() => window.close(), 50)");
        await wait(800);
      }
      return ww.icon(one);
    };
    // the page is loaded again during the wait (the same address, a new document: the call pinned to the old one fails, and
    // the new one is not looked at and filled in its place)
    await nearTheEnd();
    await clickFill(s);
    await s.until("/New code in/.test(document.querySelector('.fillnote')?.textContent ?? '')", "it waits");
    await one.reload();
    await s.until(
      "/Not filled: the page changed/.test(document.querySelector('.sect.site .fill')?.textContent ?? '')",
      "the card says why",
      15_000,
    );
    expect(await value(one)).toBe("");
    expect(await s.eval("document.querySelectorAll('.fillnote.ok').length")).toBe(0);
    // the page changes its address without a new document (a single-page app's route) during the wait: the box is still there,
    // and still nothing is filled
    s = await again();
    await s.until("document.querySelector('.sect.site .fillbtn')", "the button");
    await nearTheEnd();
    await clickFill(s);
    await s.until("/New code in/.test(document.querySelector('.fillnote')?.textContent ?? '')", "it waits");
    await one.evaluate(() => history.pushState(null, "", location.pathname + "?n=route"));
    await s.until(
      "/Not filled: the page changed/.test(document.querySelector('.sect.site .fill')?.textContent ?? '')",
      "the card says why, after a new address only",
      15_000,
    );
    expect(await value(one)).toBe("");
    // the user goes to another tab of the site during the wait: in the side panel the card says so; the popup closes with the
    // switch (the browser closes it), which cancels the fill as before; either way neither tab gets the code
    s = await again();
    await s.until("document.querySelector('.sect.site .fillbtn')", "the button");
    await nearTheEnd();
    await clickFill(s);
    await s.until("/New code in/.test(document.querySelector('.fillnote')?.textContent ?? '')", "it waits again");
    await two.bringToFront();
    if (surface === "panel")
      await s.until(
        "/Not filled: you switched tabs/.test(document.querySelector('.sect.site .fill')?.textContent ?? '')",
        "the card says why",
        15_000,
      );
    else await wait(6000);
    expect(await value(one)).toBe("");
    expect(await value(two)).toBe("");
    if (surface === "panel") expect(await fillNote(s)).not.toMatch(/Code filled/);
  });

test("https end to end: no question is asked, the code is filled, and the shortcut fills too", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "panel", tls: true });
  const page = await w.tab(TLS_HOST, "/owner");
  expect(page.url()).toMatch(/^https:\/\//);
  const panel = await w.icon(page);
  await panel.until("document.querySelector('.fillbar.ok')", "found on the https page");
  await windowOpen();
  await clickFill(panel);
  await panel.until("document.querySelector('.fillnote.ok')", "filled with no question");
  expect(await panel.eval("document.querySelectorAll('.fillnote.warn').length")).toBe(0);
  expect(await codesNow()).toContain(await value(page, ".ant-input"));
  expect(await events(page)).toEqual([]);
  // the button names the host it fills on: this is a subdomain of the registered fix.test (M6)
  expect(await panel.eval("document.querySelector('.sect.site .fillbtn').innerText")).toMatch(
    /Fill code on tls\.fix\.test/,
  );
  // the shortcut on a second https page
  const again = await w.tab(TLS_HOST, "/otc");
  await w.icon(again);
  await windowOpen();
  await w.p.ctx
    .serviceWorkers()[0]!
    .evaluate(() => (globalThis as unknown as { __skFill: (t?: unknown) => Promise<void> }).__skFill());
  await expect.poll(() => value(again), { message: "the shortcut filled the https page" }).toMatch(/^\d{6}$/);
});

test("M6: on a subdomain of the registered host the button names the host; on the registered host itself it does not", async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "panel" });
  const sub = await w.tab("app.fix.test", "/otc");
  const panel = await w.icon(sub);
  await panel.until("document.querySelector('.fillbar.ok')", "found");
  expect(await panel.eval("document.querySelector('.sect.site .fillbtn').innerText")).toMatch(
    /Fill code on app\.fix\.test/,
  );
  const ip = await w.tab("127.0.0.1", "/otc");
  await w.icon(ip);
  await panel.until(
    "/Fill code into this page/.test(document.querySelector('.sect.site .fillbtn')?.innerText ?? '')",
    "found on the registered host",
  );
  expect(await panel.eval("document.querySelector('.sect.site .fillbtn').innerText")).toMatch(
    /Fill code into this page/,
  );
});

test('http with two boxes: the answer to "not secure" and the choice of box are both kept (no endless loop)', async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "panel" });
  const page = await w.tab("app.fix.test", "/two");
  const panel = await w.icon(page);
  await panel.until("document.querySelector('.fillbar.ok')", "found");
  await windowOpen();
  await clickFill(panel);
  await panel.until("document.querySelector('.fillanyway')", "the not-secure question");
  await panel.eval("document.querySelector('.fillanyway').click()");
  await panel.until("/Which box/.test(document.querySelector('.fill')?.innerText ?? '')", "then which box");
  await panel.eval("document.querySelectorAll('.fillacts .btn.ghost')[0].click()");
  await panel.until("document.querySelector('.fillnote.ok')", "filled: the http answer was kept for the choice");
  const got = await page.locator("input").evaluateAll((e) => e.map((x) => (x as HTMLInputElement).value));
  expect(got.filter((v) => v !== "")).toHaveLength(1);
  expect(await panel.eval("document.querySelectorAll('.fillnote.warn').length")).toBe(0);
});

test("the shortcut: the vault locks during the wait for the next code: nothing is filled (the review's M-1)", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "panel" });
  const sw = w.p.ctx.serviceWorkers()[0]!;
  const page = await w.tab("127.0.0.1", "/otc");
  await w.icon(page);
  const left = () => 30 - ((Date.now() / 1000) % 30);
  if (left() > 3.6) await wait((left() - 3.6) * 1000);
  const pressed = sw.evaluate(() => (globalThis as unknown as { __skFill: (t?: unknown) => Promise<void> }).__skFill());
  await wait(1500);
  await sw.evaluate(() => chrome.storage.session.clear()); // the key leaves the session: locked
  await pressed;
  await wait(1000);
  expect(await value(page)).toBe("");
  expect(await events(page)).toEqual([]);
});

test("the panel: Lock now during the wait for the next code: nothing is filled", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "panel" });
  const page = await w.tab("127.0.0.1", "/otc");
  const panel = await w.icon(page);
  await panel.until("document.querySelector('.fillbar.ok')", "found");
  const left = () => 30 - ((Date.now() / 1000) % 30);
  if (left() > 3.6) await wait((left() - 3.6) * 1000);
  await clickFill(panel);
  await panel.until("/New code in/.test(document.querySelector('.fillnote')?.textContent ?? '')", "it waits");
  await panel.eval("document.querySelector('#lock-now').click()");
  await wait(5500);
  expect(await value(page)).toBe("");
});

// ---- the second review's findings (AUTOFILL1-R2-VERIFY.md): F1 to F6 --------------------------------------------------

/**
 * Make the tab whose address has `part` the active one and press the first button matching `sel` in the same turn of the
 * panel's script, so that the press comes before the panel's own look at the tab (a debounced 250 ms): the press must not
 * trust the last look.
 */
const switchAndPress = (panel: PanelPage, part: string, sel: string) =>
  panel.eval(
    `(async () => { const t = (await chrome.tabs.query({})).find((x) => (x.url ?? '').includes(${JSON.stringify(part)})); await chrome.tabs.update(t.id, { active: true }); document.querySelector(${JSON.stringify(sel)}).click(); })()`,
  );

/** The shortcut's handler in the worker (the keys cannot be pressed from a test) and the tab's own title and badge, read back. */
const shortcut = (w: World) => {
  const sw = w.p.ctx.serviceWorkers()[0]!;
  return {
    sw,
    press: () => sw.evaluate(() => (globalThis as unknown as { __skFill: (t?: unknown) => Promise<void> }).__skFill()),
    toolbar: () =>
      sw.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const tabId = tab!.id!;
        return {
          title: await chrome.action.getTitle({ tabId }),
          global: await chrome.action.getTitle({}),
          badge: await chrome.action.getBadgeText({ tabId }),
        };
      }),
  };
};

test("F1: the toolbar tooltip says what the shortcut did and then comes back (Chrome refuses a null title and keeps an empty one)", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "panel" });
  const { sw, press, toolbar } = shortcut(w);
  // the probe the fix rests on: setTitle needs a string, and "" is not a reset (it is this tab's own empty title)
  const page = await w.tab("127.0.0.1", "/otc");
  await w.icon(page);
  const probe = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tabId = tab!.id!;
    let nullRefused = false;
    try {
      await chrome.action.setTitle({ tabId, title: null as never });
    } catch {
      nullRefused = true;
    }
    await chrome.action.setTitle({ tabId, title: "" });
    const empty = await chrome.action.getTitle({ tabId });
    await chrome.action.setTitle({ tabId, title: "Sixkey" });
    return { nullRefused, empty };
  });
  expect(probe).toEqual({ nullRefused: true, empty: "" });
  await windowOpen();
  const pressed = press();
  await expect
    .poll(async () => (await toolbar()).title, { message: "the tooltip says the code was filled" })
    .toMatch(/code filled/);
  expect((await toolbar()).badge).toBe("OK");
  await pressed; // resolves after the few seconds the mark stays
  expect(await toolbar()).toEqual({ title: "Sixkey", global: "Sixkey", badge: "" });
  expect(await value(page)).toMatch(/^\d{6}$/);
  // a locked vault: the tooltip says so, and is gone again after the mark (it used to stay for good)
  await sw.evaluate(() => chrome.storage.session.clear());
  const locked = press();
  await expect
    .poll(async () => (await toolbar()).title, { message: "the tooltip says it is locked" })
    .toMatch(/locked/);
  await locked;
  expect(await toolbar()).toEqual({ title: "Sixkey", global: "Sixkey", badge: "" });
});

/**
 * A record, kept in the panel's page, of every call the panel makes into a tab (the calls themselves go through unchanged):
 * the kind (install, look, fill), the tab, and whether it ended and how. A test's own probe, as visual-guard.spec.ts stubs the
 * same function: it lets the test know which tab the panel last looked at, and where a code went.
 */
const recordCalls = (panel: PanelPage) =>
  panel.eval(`(() => {
    if (window.__calls) return;
    window.__calls = [];
    const real = chrome.scripting.executeScript.bind(chrome.scripting);
    Object.defineProperty(chrome.scripting, "executeScript", {
      configurable: true,
      value: async (c) => {
        // the fill goes to one document; the look has an argument too (the hint, AF3-2)
        const r = { kind: c.files ? "install" : c.target.documentIds ? "fill" : "look", tab: c.target.tabId, end: "" };
        window.__calls.push(r);
        try {
          const out = await real(c);
          r.end = "ok";
          return out;
        } catch (e) {
          r.end = "threw";
          throw e;
        }
      },
    });
  })()`);
type Call = { kind: string; tab: number; end: string };
const calls = (panel: PanelPage) => panel.eval<Call[]>("window.__calls");
const tabIdOf = (panel: PanelPage, part: string) =>
  panel.eval<number>(
    `chrome.tabs.query({}).then((t) => t.find((x) => (x.url ?? "").includes(${JSON.stringify(part)})).id)`,
  );

test("F6: two tabs of one site: the look of the other tab is never used for the tab in front (the code goes only into the tab in front)", async () => {
  test.setTimeout(240_000);
  w = await world({ surface: "panel" });
  const t1 = await w.tab("127.0.0.1", "/otc?n=one");
  const panel = await w.icon(t1);
  await panel.until("document.querySelector('.fillbar.ok')", "found in the first tab");
  await recordCalls(panel);
  const t2 = await w.tab("127.0.0.1", "/otc?n=two");
  await w.d.clickIcon("n=two"); // the panel now follows the second tab, and looks at it
  const [one, two] = [await tabIdOf(panel, "n=one"), await tabIdOf(panel, "n=two")];
  // the precondition, checked rather than hoped for: the panel's last look is the second tab's, it has ended, and the panel
  // shows it (else the press below would not be a press with the other tab's look in hand)
  const settled = async () => {
    const c = await calls(panel);
    const looks = c.filter((x) => x.kind === "look" && x.end === "ok");
    return looks.at(-1)?.tab === two && c.every((x) => x.end !== "");
  };
  await expect.poll(settled, { message: "the panel's last look is the second tab's", timeout: 15_000 }).toBe(true);
  await panel.until("document.querySelector('.fillbar.ok')", "found in the second tab");
  await windowOpen(12);
  expect(await settled()).toBe(true);
  // back to the first tab and Fill in the same breath, inside the panel (the panel looks at the new tab only after 250 ms): the
  // last look is the second tab's, and must not be used
  await switchAndPress(panel, "n=one", ".sect.site .fillbtn");
  await expect.poll(() => value(t1), { message: "the tab in front is filled", timeout: 15_000 }).toMatch(/^\d{6}$/);
  const first = await value(t1);
  expect(await codesNow()).toContain(first);
  await panel.until("document.querySelector('.fillnote.ok')", "the card says the code was filled");
  expect(await value(t2)).toBe("");
  expect((await calls(panel)).filter((x) => x.kind === "fill").map((x) => x.tab)).toEqual([one]);
  // and the other way round
  await expect
    .poll(async () => (await calls(panel)).every((x) => x.end !== ""), { message: "no call under way" })
    .toBe(true);
  await switchAndPress(panel, "n=two", ".sect.site .fillbtn");
  await expect
    .poll(() => value(t2), { message: "the second tab, in front now, is filled", timeout: 15_000 })
    .toMatch(/^\d{6}$/);
  expect(await value(t1)).toBe(first);
  expect((await calls(panel)).filter((x) => x.kind === "fill").map((x) => x.tab)).toEqual([one, two]);
});

test("F6: a look of the other tab still under way (that page is busy) when the user switches back and presses Fill is not used for the tab in front", async () => {
  test.setTimeout(240_000);
  w = await world({ surface: "panel" });
  const t1 = await w.tab("127.0.0.1", "/otc?n=one");
  const panel = await w.icon(t1);
  await panel.until("document.querySelector('.fillbar.ok')", "found in the first tab");
  const t2 = await w.tab("127.0.0.1", "/otc?n=two");
  await w.d.clickIcon("n=two"); // the second tab has had its click: the panel may look at it from now on
  await recordCalls(panel);
  const [one, two] = [await tabIdOf(panel, "n=one"), await tabIdOf(panel, "n=two")];
  const idle = async () => (await calls(panel)).every((x) => x.end !== "");
  const lastLook = async () => (await calls(panel)).filter((x) => x.kind === "look" && x.end === "ok").at(-1)?.tab;
  await expect.poll(async () => (await idle()) && (await lastLook()) === two, { timeout: 15_000 }).toBe(true);
  // back to the first tab (the panel looks at it again), then the second tab is made busy for 6 s and brought to the front:
  // the panel's look at it starts and cannot end until the page is free
  await panel.eval(`chrome.tabs.update(${one}, { active: true })`);
  await expect.poll(async () => (await idle()) && (await lastLook()) === one, { timeout: 15_000 }).toBe(true);
  await windowOpen(14);
  await t2.evaluate(() => {
    setTimeout(() => {
      const t = Date.now();
      while (Date.now() - t < 6000);
    }, 0);
  });
  await panel.eval(`chrome.tabs.update(${two}, { active: true })`);
  await expect
    .poll(async () => (await calls(panel)).some((x) => x.tab === two && x.end === ""), {
      message: "a look at the busy tab is under way",
      timeout: 5000,
    })
    .toBe(true);
  // the first tab to the front and Fill, in one turn: the press finds the busy tab's look under way and joins it
  const joined = await panel.eval<boolean>(
    `(async () => { await chrome.tabs.update(${one}, { active: true }); const busy = window.__calls.some((x) => x.tab === ${two} && x.end === ""); document.querySelector(".sect.site .fillbtn").click(); return busy; })()`,
  );
  expect(joined, "the press came while the look at the other tab was under way").toBe(true);
  await expect.poll(() => value(t1), { message: "the tab in front is filled", timeout: 20_000 }).toMatch(/^\d{6}$/);
  expect(await codesNow()).toContain(await value(t1));
  await expect.poll(idle, { message: "every call has ended", timeout: 15_000 }).toBe(true);
  expect(await value(t2)).toBe("");
  expect((await calls(panel)).filter((x) => x.kind === "fill").map((x) => x.tab)).toEqual([one]);
});

/**
 * Make `setAccessLevel` of storage.local refuse in this context, as before Chrome 140 (where it does not exist; Sixkey
 * requires 140 since wave 1b, and STORAGEGATE stays as the second layer this tests).
 */
const REFUSE = `Object.defineProperty(chrome.storage.local, "setAccessLevel", {
  configurable: true,
  value: () => Promise.reject(new Error("not on this Chrome")),
})`;

test("STORAGEGATE: where Sixkey cannot close storage.local to the page's scripts, nothing is injected: the press, the next look and the shortcut", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "panel" });
  const page = await w.tab("127.0.0.1", "/otc");
  const panel = await w.icon(page);
  await panel.until("document.querySelector('.fillbar.ok')", "found (the gate is open in this browser)");
  await recordCalls(panel);
  await panel.eval(REFUSE);
  // a press with the last look in hand: the gate is asked again at the fill, and refuses
  await windowOpen();
  await clickFill(panel);
  await panel.until(
    "/Autofill needs Chrome 140 or later/.test(document.querySelector('.sect.site .fill')?.textContent ?? '')",
    "the card says why",
  );
  expect(await value(page)).toBe("");
  // the next look (the tab goes to another page of the site; the panel looks again): not made; the strip says why, and there
  // is no Fill button
  await page.goto(page.url().replace("/otc", "/otc?n=next"));
  await panel.until(
    "/Autofill needs Chrome 140 or later/.test(document.querySelector('.fillbar')?.textContent ?? '')",
    "the strip says why",
    15_000,
  );
  expect(await panel.eval("document.querySelectorAll('.sect.site .fillbtn, .fillbar button').length")).toBe(0);
  expect(await calls(panel)).toEqual([]); // not one call into the tab since the refusal
  // the shortcut, in the worker: the same refusal there gives "!" and the reason, and the box stays empty
  const sw = w.p.ctx.serviceWorkers()[0]!;
  await sw.evaluate(REFUSE);
  await windowOpen();
  const pressed = sw.evaluate(() => (globalThis as unknown as { __skFill: (t?: unknown) => Promise<void> }).__skFill());
  await expect
    .poll(
      () =>
        sw.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          return `${await chrome.action.getBadgeText({ tabId: tab!.id! })} ${await chrome.action.getTitle({ tabId: tab!.id! })}`;
        }),
      { message: "the icon says why" },
    )
    .toBe("! Sixkey: autofill needs Chrome 140 or later");
  await pressed;
  expect(await value(page)).toBe("");
});

test('F5: the answer to "not secure (http)" is for one page and one fill: asked again for the next fill and on another page', async () => {
  test.setTimeout(240_000);
  w = await world({ surface: "panel" });
  const page = await w.tab("app.fix.test", "/otc");
  const panel = await w.icon(page);
  await panel.until("document.querySelector('.fillbar.ok')", "found");
  await windowOpen(12);
  await clickFillAnyway(panel, "Example");
  await panel.until("document.querySelector('.fillnote.ok')", "filled after the answer");
  // the same page, the next press: the question comes again (the answer was used up by the fill)
  await clickFill(panel, "Example");
  await panel.until("document.querySelector('.fillanyway')", "asked again");
  expect(await panel.eval("document.querySelectorAll('.fillnote.ok').length")).toBe(0);
  // cancelled: asked again, too
  await panel.eval("[...document.querySelectorAll('.fillacts .btn.quiet')][0].click()");
  await clickFill(panel, "Example");
  await panel.until("document.querySelector('.fillanyway')", "asked again after Cancel");
  await panel.eval("[...document.querySelectorAll('.fillacts .btn.quiet')][0].click()");
  // two boxes: the answer is kept for the choice of box, for that page only: with another http tab of the site in front (it has
  // had the click on the icon, so a fill there would work), the choice is not carried over: the question comes instead
  const other = await w.tab("app.fix.test", "/otc?n=other");
  await w.icon(other);
  const two = await w.tab("app.fix.test", "/two");
  await w.icon(two);
  await panel.until("document.querySelector('.fillbar.ok')", "found on the two-box page");
  await clickFill(panel, "Example");
  await panel.until("document.querySelector('.fillanyway')", "the question on the two-box page");
  await panel.eval("document.querySelector('.fillanyway').click()");
  await panel.until("/Which box/.test(document.querySelector('.fill')?.innerText ?? '')", "which box");
  // Cancel on "Which box?" ends the answer too: the next press asks again
  await panel.eval("[...document.querySelectorAll('.fillacts .btn.quiet')][0].click()");
  await clickFill(panel, "Example");
  await panel.until("document.querySelector('.fillanyway')", "asked again after Cancel on 'Which box?'");
  await panel.eval("document.querySelector('.fillanyway').click()");
  await panel.until("/Which box/.test(document.querySelector('.fill')?.innerText ?? '')", "which box, again");
  await switchAndPress(panel, "n=other", ".fillacts .btn.ghost"); // (the panel looks at the other tab only 250 ms later)
  await panel.until("document.querySelector('.fillanyway')", "asked again on the other page");
  await wait(1500);
  expect(await value(other)).toBe("");
  expect(await two.locator("input").evaluateAll((e) => e.map((x) => (x as HTMLInputElement).value).join(""))).toBe("");
});

test("F2: a visible real box and, apart from it, a box whose digits cannot be seen: the extension fills the real one", async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "panel" });
  const page = await w.tab("127.0.0.1", "/real-and-honey");
  const panel = await w.icon(page);
  await panel.until("document.querySelector('.fillbar.ok')", "found");
  await windowOpen();
  await clickFill(panel);
  await panel.until("document.querySelector('.fillnote.ok')", "filled");
  expect(await codesNow()).toContain(await value(page, "#real"));
  expect(await value(page, "#honey")).toBe("");
});

test("F2: a box hidden by its parent is not offered, and the strip says no box was found", async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "panel" });
  const page = await w.tab("127.0.0.1", "/hp?kind=parentclip");
  const panel = await w.icon(page);
  await panel.until("/No code box/.test(document.querySelector('.fillbar')?.textContent ?? '')", "no box");
  await clickFill(panel);
  await panel.until("document.querySelector('.fillnote.bad')", "the click says so too");
  expect(await value(page)).toBe("");
});

test("F3: a page that hides the box right after the code went in: the panel does not say the code was refused, and does not claim it was filled", async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "panel" });
  const page = await w.tab("127.0.0.1", "/hide-on-input");
  const panel = await w.icon(page);
  await panel.until("document.querySelector('.fillbar.ok')", "found");
  await windowOpen();
  await clickFill(panel);
  await panel.until("document.querySelector('.fillnote.warn')", "the note");
  const note = await panel.eval<string>("document.querySelector('.fillnote.warn').textContent");
  expect(note).toMatch(/The code was entered, then the page changed/);
  expect(note).not.toMatch(/did not keep|Type it yourself|Code filled/);
  expect(await panel.eval("document.querySelectorAll('.fillnote.bad, .fillnote.ok').length")).toBe(0);
  expect(await value(page, "input")).toMatch(/^\d{6}$/); // the value is in the (now hidden) box
});

test("F4: a fill the page does not answer in time says the code may have been entered; a look it does not answer in time says that, not 'cannot look at this kind of page'", async () => {
  test.setTimeout(240_000);
  w = await world({ surface: "panel" });
  const hang = await w.tab("127.0.0.1", "/hang-input");
  const panel = await w.icon(hang);
  await panel.until("document.querySelector('.fillbar.ok')", "found");
  await windowOpen(14);
  await clickFill(panel);
  await panel.until("document.querySelector('.fillnote.warn')", "the note after the 8 s", 30_000);
  const note = await panel.eval<string>("document.querySelector('.fillnote.warn').textContent");
  expect(note).toMatch(/may have been entered/);
  expect(note).not.toMatch(/type the code yourself/i);
  expect(await value(hang)).toMatch(/^\d{6}$/); // it is in the box: written before the page's handler ran
  // a busy page: its main thread is held for 14 s from the moment of the click on the icon (the page cannot be asked anything
  // meanwhile, and so neither can the tab: the click is sent first and the page is made busy right behind it)
  const busy = await w.tab("127.0.0.1", "/otc?n=busy"); // (its own address: the click on the icon finds the tab by it)
  const click = w.d.clickIcon("n=busy");
  await busy.evaluate(() => {
    setTimeout(() => {
      const t = Date.now();
      while (Date.now() - t < 14000);
    }, 0);
  });
  await click;
  await panel.until(
    "/did not answer in time/.test(document.querySelector('.fillbar')?.textContent ?? '')",
    "a slow look",
    40_000,
  );
  expect(await barText(panel)).not.toMatch(/cannot look at this kind of page/);
  expect(await panel.eval("document.querySelectorAll('.fillbar button').length")).toBe(1); // Look again
});
