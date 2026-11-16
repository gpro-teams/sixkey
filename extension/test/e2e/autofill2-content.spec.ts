// TOTP autofill, Stage 2 patch 3: the content script and its channel, without in-page UI (docs/design/notes/AUTOFILL2-NOTES.md
// §9). The e2e build grants two Stage 2 fixture hosts up front (grantedtls.fix.test over https, granted.fix.test over http;
// its tests cannot answer Chrome's prompt); tls.fix.test is https and ungranted. Whether a page runs Sixkey's content script is
// read from the page's own DevTools target: Chrome reports each content-script world as an execution context of the
// extension's origin, and the finder (`__skOtp`) is there in it.
//   - registered for exactly the listed and granted https sites; never on an ungranted site or an http page;
//   - a trusted click in the code box sets that tab's toolbar badge and tooltip; a page's focus() and its own synthetic events
//     do not; the page sees nothing (no global, no attribute, no change to its document but, with the in-page suggestion's
//     release gate open as in this build, Sixkey's own element with a closed shadow root);
//   - the shortcut fills there without activeTab (the site's grant);
//   - the content script's world cannot read storage.local or storage.session, and gets no answer to a page's message types;
//   - a grant withdrawn in Chrome's own settings removes the registration, and after a reload the page has no content script.
import { expect, test, type Page } from "@playwright/test";
import { codesNow, GRANTED, GRANTED_TLS, TLS_HOST, windowOpen, world, type World } from "./autofill-helpers";

let w: World | undefined;
test.afterEach(async () => {
  await w?.close();
  w = undefined;
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const worker = (x: World) => x.p.ctx.serviceWorkers()[0]!;
const setSites = (x: World, hosts: string[]) =>
  worker(x).evaluate((h) => chrome.storage.local.set({ sk_af_sites: { v: 1, hosts: h } }), hosts);
const registered = (x: World) =>
  worker(x).evaluate(
    async () => (await chrome.scripting.getRegisteredContentScripts({ ids: ["sk-suggest"] }))[0]?.matches ?? null,
  );
async function tabAt(x: World, url: string): Promise<Page> {
  const page = await x.p.ctx.newPage();
  await page.goto(url);
  await page.bringToFront();
  return page;
}
/** The tab of a page, brought to the front (where Sixkey has no access the worker cannot read its address). */
async function tabIdOf(x: World, page: Page): Promise<number> {
  await page.bringToFront();
  return worker(x).evaluate(
    async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? -1,
  );
}
const badge = async (x: World, page: Page) => {
  const tabId = await tabIdOf(x, page);
  return worker(x).evaluate(
    async (t) => ({
      text: await chrome.action.getBadgeText({ tabId: t }),
      title: await chrome.action.getTitle({ tabId: t }),
    }),
    tabId,
  );
};

/** The page's execution contexts of Sixkey's origin: one per frame Sixkey's content script (or an injection) runs in. */
async function sixkeyWorlds(
  x: World,
  page: Page,
): Promise<{ id: number; session: import("@playwright/test").CDPSession }> {
  const s = await page.context().newCDPSession(page);
  const ids: number[] = [];
  s.on("Runtime.executionContextCreated", (e: { context: { id: number; origin: string } }) => {
    if (e.context.origin === `chrome-extension://${x.p.id}`) ids.push(e.context.id);
  });
  await s.send("Runtime.enable");
  await wait(300);
  return { id: ids[0] ?? -1, session: s };
}
/**
 * Whether the page runs Sixkey's content script: the finder is there in Sixkey's world. (Chrome may keep an empty world of
 * the extension's in a document reloaded after a revocation [probed, Chromium 156]: the world alone proves nothing.)
 */
const hasContentScript = async (x: World, page: Page) => {
  const { id, session } = await sixkeyWorlds(x, page);
  const r =
    id === -1
      ? false
      : (
          (await session.send("Runtime.evaluate", {
            expression: 'typeof globalThis.__skOtp === "object"',
            contextId: id,
            returnByValue: true,
          })) as { result: { value?: unknown } }
        ).result.value === true;
  await session.detach();
  return r;
};

async function granted(): Promise<World> {
  const x = await world({ surface: "popup", tls: true });
  await setSites(x, [GRANTED_TLS, GRANTED]);
  // reconcile: granted.fix.test's https pattern is not granted (this build grants its http one), so only grantedtls counts
  await expect.poll(() => registered(x), { message: "the registration" }).toEqual([`https://${GRANTED_TLS}/*`]);
  return x;
}

test("registered for exactly the listed and granted https site: its pages get the content script; an ungranted site and an http page do not", async () => {
  test.setTimeout(120_000);
  w = await granted();
  const page = await tabAt(w, `https://${GRANTED_TLS}/otc`);
  expect(await hasContentScript(w, page)).toBe(true);
  expect(await hasContentScript(w, await tabAt(w, `https://${TLS_HOST}/otc`))).toBe(false); // https, not granted
  expect(await hasContentScript(w, await tabAt(w, `http://${GRANTED}/otc`))).toBe(false); // granted, but http
  // a frame of the granted site inside an ungranted page gets it (allFrames), and its message sets no badge (the top page
  // is not a site the user turned on)
  const framed = await tabAt(w, `https://${TLS_HOST}/frame?src=${encodeURIComponent(`https://${GRANTED_TLS}/otc`)}`);
  await framed.frameLocator("#f").locator("input").click();
  await wait(800);
  expect((await badge(w, framed)).text).toBe("");
});

test("a trusted click in the code box sets the tab's badge and tooltip; a page's focus() and its own events do not; the page sees nothing", async () => {
  test.setTimeout(120_000);
  w = await granted();
  const page = await tabAt(w, `https://${GRANTED_TLS}/otc`);
  expect(await hasContentScript(w, page)).toBe(true);
  const before = await page.evaluate(() => document.documentElement.outerHTML);
  // the page's own focus, and events it makes itself: not the user's
  await page.evaluate(() => {
    const i = document.querySelector("input")!;
    i.focus();
    i.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    i.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true, composed: true }));
  });
  await wait(800);
  expect(await badge(w, page)).toEqual({ text: "", title: "Sixkey" });
  // the user's click
  await page.locator("input").click();
  await expect.poll(() => badge(w!, page)).toMatchObject({ text: "1" });
  // the shortcut as Chrome writes it on this system (Alt+Shift+F, or ⌥⇧F on a Mac)
  expect((await badge(w, page)).title).toMatch(/^Sixkey can fill the code here: press (?:Alt\+Shift\+F|⌥⇧F)$/);
  // nothing of it in the page: no global, no attribute, the document as it was. This build has the in-page suggestion's
  // release gate open (AUTOFILL2 patch 4b), so one element more, at the end of the root: Sixkey's own, with no attribute
  // and nothing the page can read (a closed shadow root). A store build, the gate closed, adds nothing (check-dist)
  expect(
    await page.evaluate(() => [
      typeof (globalThis as { __skOtp?: unknown }).__skOtp,
      document.documentElement.outerHTML,
      document.querySelector("sixkey-suggest")?.shadowRoot,
    ]),
  ).toEqual([
    "undefined",
    before.replace(/<\/body><\/html>$/, "</body><sixkey-suggest></sixkey-suggest></html>"),
    null,
  ]);
  // the shortcut fills there without activeTab: the site's grant lets the worker in
  await windowOpen();
  const tabId = await tabIdOf(w, page);
  await worker(w).evaluate(async (t) => {
    const tab = await chrome.tabs.get(t);
    await (globalThis as unknown as { __skFill: (t: unknown) => Promise<void> }).__skFill(tab);
  }, tabId);
  await expect.poll(() => page.locator("input").first().inputValue()).toMatch(/^\d{6}$/);
  expect(await codesNow()).toContain(await page.locator("input").first().inputValue());
});

test("the content script's world: storage.local and storage.session are closed to it, and a page's message types get no answer", async () => {
  test.setTimeout(120_000);
  w = await granted();
  const page = await tabAt(w, `https://${GRANTED_TLS}/otc`);
  const { id, session } = await sixkeyWorlds(w, page);
  expect(id).not.toBe(-1);
  const run = async (expression: string) =>
    (
      (await session.send("Runtime.evaluate", {
        expression,
        contextId: id,
        awaitPromise: true,
        returnByValue: true,
      })) as {
        result: { value?: unknown };
      }
    ).result.value;
  for (const area of ["local", "session"])
    expect(await run(`chrome.storage.${area}.get(null).then(() => "read", (e) => "refused: " + e.message)`)).toMatch(
      /^refused: /,
    );
  for (const type of ["sk-clip-arm", "sk-reschedule-autolock", "sk-sync-soon", "sk-api"])
    expect(
      await run(
        `chrome.runtime.sendMessage({ type: ${JSON.stringify(type)}, hash: "x" }).then((r) => r === undefined ? "no answer" : JSON.stringify(r), (e) => "error: " + e.message)`,
      ),
      type,
    ).toMatch(/^no answer$|^error: /);
  await session.detach();
});

test("a grant withdrawn in Chrome's own settings removes the registration; after a reload the page has no content script; granted back, it has", async () => {
  test.setTimeout(120_000);
  w = await granted();
  const page = await tabAt(w, `https://${GRANTED_TLS}/otc`);
  expect(await hasContentScript(w, page)).toBe(true);
  const ext = await w.p.ctx.newPage();
  await ext.goto("chrome://extensions/");
  const access = (hostAccess: string) =>
    ext.evaluate(
      ([id, a]) =>
        (
          chrome as unknown as { developerPrivate: { updateExtensionConfiguration(u: unknown): Promise<void> } }
        ).developerPrivate.updateExtensionConfiguration({ extensionId: id, hostAccess: a }),
      [w!.p.id, hostAccess],
    );
  await access("ON_CLICK");
  await expect.poll(() => registered(w!), { message: "the registration removed" }).toBeNull();
  await wait(1000); // the browser hands the change to its renderers
  await page.bringToFront();
  await page.reload();
  expect(await hasContentScript(w, page)).toBe(false);
  await page.locator("input").click();
  await wait(800);
  expect((await badge(w, page)).text).toBe("");
  await access("ON_ALL_SITES");
  await expect.poll(() => registered(w!), { message: "registered again" }).toEqual([`https://${GRANTED_TLS}/*`]);
  await page.reload();
  expect(await hasContentScript(w, page)).toBe(true);
});
