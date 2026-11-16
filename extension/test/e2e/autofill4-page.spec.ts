// TOTP autofill Stage 2, patch 4a (docs/design/notes/AUTOFILL2-NOTES.md §12), in a real popup of the e2e build (the in-page
// suggestion's release gate open): a page's fill request R v2, written as the worker's `open` writes it, with the real
// top-frame documentId, then the popup opened in that window. No page UI is needed (that is patch 4b's): what is checked is
// the surface's side, which the unit tests hold only in a minimal document.
//   - locked with the PIN: the line names the page; the PIN typed at a normal pace sends itself, and the code goes into
//     that document; R is used up;
//   - unlocked: "Press Enter to fill the code on <host>", Fill drawn disabled during the input delay and focused; a press
//     after the delay fills that document;
//   - locked, a PIN typed inside the delay: kept and not sent at its length; Unlock, once the entry has been quiet, unlocks;
//     R is then only offered, not filled (the first digit came before R had been on screen 600 ms).
// (First written as the independent review's probes of patch 4a.)
import { expect, test, type Page } from "@playwright/test";
import { codesNow, GRANTED_TLS, popupPage, windowOpen, world, type World } from "./autofill-helpers";
import { openFold, openOptions, STRONG } from "./harness";

let w: World | undefined;
test.afterEach(async () => {
  await w?.close();
  w = undefined;
});
const PIN = "246813";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const worker = (x: World) => x.p.ctx.serviceWorkers()[0]!;
const value = (page: Page) => page.locator("input").first().inputValue();
const req = (x: World) =>
  worker(x).evaluate(async () => (await chrome.storage.session.get("sk_fill_req")).sk_fill_req ?? null);
async function setPin(x: World): Promise<void> {
  const opt = await openOptions(x.p, "#security");
  await expect(opt.locator(".status dd.num")).toHaveText(/^\d+$/);
  await openFold(opt, "pin-box");
  await opt.locator("#pin-pw").fill(STRONG);
  await opt.locator("#pin-new").fill(PIN);
  await opt.locator("#pin-new2").fill(PIN);
  await opt.locator("#pin-set").click();
  await expect(opt.locator("#pin-info")).toBeVisible();
  await opt.close();
}
/** What `open` writes, for the tab in front: R v2 with the real documentId, then the popup in that window. */
async function pageRequest(x: World): Promise<{ doc: string }> {
  return worker(x).evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: t!.id! }, func: () => 1 });
    const epoch = ((await chrome.storage.session.get("sk_lock_epoch")).sk_lock_epoch as number) ?? 0;
    const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await chrome.storage.session.set({
      sk_fill_req: {
        v: 2,
        nonce,
        tabId: t!.id,
        windowId: t!.windowId,
        url: t!.url,
        host: new URL(t!.url!).hostname,
        at: Date.now(),
        epoch,
        why: "page",
        doc: r!.documentId,
      },
    });
    await chrome.action.openPopup({ windowId: t!.windowId });
    return { doc: r!.documentId as string };
  });
}

test("a page's request, locked with the PIN: the line names the page, the PIN at a normal pace fills that document", async () => {
  test.setTimeout(170_000);
  w = await world({ surface: "popup", tls: true });
  await setPin(w);
  const page = await w.tab(GRANTED_TLS, "/otc");
  await worker(w).evaluate(() => chrome.storage.session.clear()); // locked; the PIN opens it
  await windowOpen(14);
  const { doc } = await pageRequest(w);
  expect(doc).toMatch(/^[0-9A-F]{32}$/); // the shape request v2 holds Chrome to
  const s = await popupPage(w.d, w.p);
  await s.until("document.querySelector('#lock-fill') && document.querySelector('#pin')", "the line and the PIN");
  expect(await s.eval("document.querySelector('#lock-fill').textContent")).toBe(
    `Unlock to fill the code on ${GRANTED_TLS}`,
  );
  await wait(900); // a normal pace: the first digit after the surface's input delay
  await s.eval(`(() => { const i = document.querySelector("#pin");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ${JSON.stringify(PIN)});
    i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await expect.poll(() => value(page), { message: "filled after the PIN", timeout: 20_000 }).toMatch(/^\d{6}$/);
  expect(await codesNow()).toContain(await value(page));
  expect(await req(w)).toBeNull();
});

test("a page's request, unlocked: the line, Fill drawn disabled during the delay and focused, a press after it fills", async () => {
  test.setTimeout(170_000);
  w = await world({ surface: "popup", tls: true });
  const page = await w.tab(GRANTED_TLS, "/otc");
  await windowOpen(14);
  await pageRequest(w);
  const s = await popupPage(w.d, w.p);
  await s.until("document.querySelector('#fill-page-go')", "the line");
  expect(await s.eval("document.querySelector('#fill-page-go').textContent")).toBe(
    `Press Enter to fill the code on ${GRANTED_TLS}`,
  );
  const early = await s.eval<number>("performance.now()");
  if (early < 550)
    expect(await s.eval("document.querySelector('.fillbtn')?.getAttribute('aria-disabled') ?? null")).toBe("true");
  await s.until("document.activeElement?.classList.contains('fillbtn')", "Fill focused");
  await wait(900);
  await s.eval("document.querySelector('.fillbtn').click()");
  await expect.poll(() => value(page), { message: "filled", timeout: 20_000 }).toMatch(/^\d{6}$/);
  expect(await req(w)).toBeNull();
});

test("a page's request, locked, a PIN typed inside the delay: not sent at its length; Unlock after its quiet unlocks, and R is only offered", async () => {
  test.setTimeout(170_000);
  w = await world({ surface: "popup", tls: true });
  await setPin(w);
  const page = await w.tab(GRANTED_TLS, "/otc");
  await worker(w).evaluate(() => chrome.storage.session.clear());
  await windowOpen(14);
  await pageRequest(w);
  const s = await popupPage(w.d, w.p);
  await s.until("document.querySelector('#pin')", "the PIN");
  await s.eval(`(() => { const i = document.querySelector("#pin");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ${JSON.stringify(PIN)});
    i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await wait(1500);
  expect(await s.eval("document.querySelector('#pin')?.value ?? null")).toBe(PIN); // kept, not sent
  expect(await value(page)).toBe("");
  await s.until("!document.querySelector('form.lock button[type=submit]')?.disabled", "the button after the quiet");
  await s.eval("document.querySelector('form.lock button[type=submit]').click()");
  await s.until("document.querySelector('#fill-page-go')", "unlocked, R offered");
  await wait(2500);
  expect(await value(page)).toBe(""); // not filled by the unlock: the first digit came too soon
  expect(await req(w)).not.toBeNull();
});
