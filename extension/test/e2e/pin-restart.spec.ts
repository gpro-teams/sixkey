// The PIN's record end to end, in Chromium (OWNER-DECISIONS/20 and its two 2026-10-30 notes; docs/design/notes/
// PIN-RESTART-NOTES.md §17, §18): every PIN set has it, with what it costs said before; the same profile folder closed and
// launched again, and the extension reloaded, and the PIN opens Sixkey (the dial turns while it derives, the page stays
// responsive); a PIN of 4 digits as any other; 5 wrong PINs take its key off the disk until the master password, the count
// kept across a restart; a key change pauses it, the PIN alone turns it back on right after, the master password
// otherwise; the shared preset takes it away; no time limit (the page's clock 30 days on); "lock every time" opens every
// popup with it (each derives again: the times are measured and printed).
import { expect, test, type Page } from "@playwright/test";
import {
  addByPaste,
  close,
  GITHUB_URI,
  launch,
  openFold,
  openOptions,
  openPopup,
  showSection,
  type Profile,
  startFresh,
  STRONG,
} from "./harness";

const PIN = "246813";
const PIN4 = "4826";
const WRONG = "975310";
const DAY = 86_400_000;

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

type Rec = {
  id: string;
  vkId: string;
  fails: number;
  lastPasswordAt: number;
  wrap: { kdf: { iterations: number } } | null;
};
const recOf = (page: Page) =>
  page.evaluate(async () => (await chrome.storage.local.get("sk_pin_restart")).sk_pin_restart as Rec | undefined);
/** The key the PIN's set-up (sk_pin) is under. */
const pinKeyOf = (page: Page) =>
  page.evaluate(async () => ((await chrome.storage.local.get("sk_pin")).sk_pin as { vkId?: string } | undefined)?.vkId);

/** Settings › Security › PIN quick unlock: what it costs read first, the master password and the PIN twice, Set PIN. */
async function setPin(opt: Page, pin = PIN) {
  await expect(opt.locator(".status dd.num")).toHaveText(/^\d+$/); // loaded: nothing redraws the fields while typing
  await openFold(opt, "pin-box");
  await expect(opt.locator("#pin-restart-cost")).toContainText(/guess your PIN offline|离线猜你的 PIN/);
  await opt.locator("#pin-pw").fill(STRONG);
  await opt.locator("#pin-new").fill(pin);
  await opt.locator("#pin-new2").fill(pin);
  await opt.locator("#pin-set").click();
  await expect(opt.locator("#pin-info")).toBeVisible();
  await expect.poll(async () => !!(await recOf(opt))?.wrap).toBe(true);
}
/** The security record's lines as Settings › Security › Record lists them, newest first. */
async function recordLines(opt: Page): Promise<string[]> {
  await showSection(opt, "security-log");
  await expect(opt.locator("#sec-log-list li").first()).toBeVisible();
  const lines = await opt.locator("#sec-log-list li span").allTextContents();
  await showSection(opt, "security");
  return lines;
}
/** A new vault with one account and a PIN, from a settings tab (left open on Security). */
async function withPin(pin = PIN): Promise<Page> {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const opt = await openOptions(p, "#security");
  await setPin(opt, pin);
  return opt;
}
/** The same profile folder, the browser closed and launched again. */
async function restart() {
  await close(p, false);
  p = await launch(p.dir);
}
/** The PIN typed on a popup's lock screen; resolves once the list is up. Returns how long it took (ms). */
async function pinOpens(pop: Page, pin = PIN): Promise<number> {
  const field = pop.locator("#pin");
  await expect(field).toBeVisible();
  await expect(field).toBeFocused();
  const t0 = Date.now();
  await field.fill(pin); // the length reached: it submits by itself
  await expect(pop.locator("#q")).toBeVisible({ timeout: 30_000 });
  return Date.now() - t0;
}

type DevPrivate = {
  developerPrivate: {
    updateProfileConfiguration(c: { inDeveloperMode: boolean }): Promise<void>;
    reload(id: string, o: { failQuietly: boolean }): Promise<void>;
  };
};
/** The extension reloaded as chrome://extensions's reload does (a store update likewise restarts it): a new worker. */
async function reloadExtension() {
  const ex = await p.ctx.newPage();
  await ex.goto("chrome://extensions/");
  await ex.waitForFunction(() => !!document.querySelector("extensions-manager"));
  const sw = p.ctx.waitForEvent("serviceworker");
  await ex.evaluate(async (id) => {
    const d = (chrome as unknown as DevPrivate).developerPrivate;
    await d.updateProfileConfiguration({ inDeveloperMode: true });
    await d.reload(id, { failQuietly: true });
  }, p.id);
  await sw;
  await ex.close();
}

test("a PIN set, a browser restart: the PIN opens Sixkey with no master password; the dial turns, the page answers meanwhile", async () => {
  const opt = await withPin();
  expect((await recOf(opt))!.wrap!.kdf.iterations).toBeGreaterThanOrEqual(2_000_000); // the shipped count
  const local = await opt.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  expect(local).not.toContain(PIN);
  // what Sixkey keeps in this profile lists it; the security record says the PIN was set, and nothing of a switch
  await showSection(opt, "security-log");
  await expect(opt.locator("#security-stored-restart")).toContainText(/guess your PIN offline|离线猜你的 PIN/);
  const lines = await recordLines(opt);
  expect(lines[0]).toMatch(/^(PIN set|设置了 PIN)$/);
  await opt.close();
  await restart();
  const pop = await openPopup(p);
  const field = pop.locator("#pin");
  await expect(field).toBeVisible();
  await expect(pop.locator("#secret")).toHaveCount(0); // no master password first
  await expect(pop.locator("#pin-tries")).toContainText("5");
  await field.fill(PIN);
  // while it derives (PBKDF2 at 2.6M iterations in all): the form is busy and the dial turns, and the page still answers
  const busy = await pop.evaluate(async () => {
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 0));
    return {
      form: document.querySelector("form.lock")?.getAttribute("aria-busy"),
      dial: document.querySelector(".dial")?.classList.contains("busy"),
      answered: performance.now() - t0,
    };
  });
  await expect(pop.locator("#q")).toBeVisible({ timeout: 30_000 });
  if (busy.form === "true") expect(busy.dial).toBe(true); // caught mid-derivation (fast machines may finish first)
  expect(busy.answered).toBeLessThan(500); // the derivation runs off the page's thread (WebCrypto)
  await expect(pop.locator(".row")).toHaveCount(1);
  expect((await recOf(pop))!.fails).toBe(0);
  // nothing of the PIN is in session memory: the next lock opens with the record again
  expect(await pop.evaluate(async () => (await chrome.storage.session.get("sk_quick")).sk_quick)).toBeUndefined();
  await pop.locator("#lock-now").click();
  await pinOpens(pop);
});

test("the extension reloaded (as a store update does): the PIN opens Sixkey", async () => {
  const opt = await withPin();
  await reloadExtension();
  await expect.poll(() => opt.isClosed()).toBe(true); // the extension's pages go with it
  const pop = await openPopup(p);
  // the session storage went with the reload: no session key; the record opens it
  expect(await pop.evaluate(async () => Object.keys(await chrome.storage.session.get(["sk_session"])))).toEqual([]);
  await expect(pop.locator("#secret")).toHaveCount(0);
  await pinOpens(pop);
});

test("a PIN of 4 digits (OWNER-DECISIONS/20, 2026-10-30): set as any other; after the extension reloads, the PIN alone opens Sixkey", async () => {
  const opt = await withPin(PIN4);
  await expect(opt.locator("#pin-state")).toContainText(/On \(4 digits\)|已开启（4 位）/);
  await expect(opt.locator("#pin-restart-error")).toHaveCount(0);
  await reloadExtension();
  await expect.poll(() => opt.isClosed()).toBe(true);
  const pop = await openPopup(p);
  await expect(pop.locator("#secret")).toHaveCount(0); // no master password first
  await expect(pop.locator("#pin-tries")).toContainText("5");
  await pinOpens(pop, PIN4);
  await expect(pop.locator(".row")).toHaveCount(1);
});

test("a weak PIN is said to be weak and taken (OWNER-DECISIONS/20, 2026-10-30), and opens Sixkey after a restart", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const opt = await openOptions(p, "#security");
  await expect(opt.locator(".status dd.num")).toHaveText(/^\d+$/);
  await openFold(opt, "pin-box");
  await opt.locator("#pin-pw").fill(STRONG);
  await opt.locator("#pin-new").fill("1111");
  await opt.locator("#pin-new2").fill("1111");
  await expect(opt.locator("#pin-hint")).toHaveText(/1234|重复/); // pinWeak: said
  await expect(opt.locator("#pin-set")).toBeEnabled(); // and taken
  await opt.locator("#pin-set").click();
  await expect(opt.locator("#pin-info")).toBeVisible();
  await opt.close();
  await restart();
  await pinOpens(await openPopup(p), "1111");
});

test("5 wrong PINs take its key off the disk, the count kept across a restart; then the master password, which makes it anew", async () => {
  await (await withPin()).close();
  await restart();
  const pop = await openPopup(p);
  const field = pop.locator("#pin");
  for (let i = 0; i < 3; i++) {
    await expect(field).toBeFocused();
    await field.fill(WRONG);
    await expect(pop.locator("#pin-tries")).toContainText(String(4 - i));
  }
  await pop.close();
  await restart(); // someone at the keyboard restarts the browser: no fresh tries
  const pop2 = await openPopup(p);
  await expect(pop2.locator("#pin-tries")).toContainText("2");
  await expect(pop2.locator("#pin")).toBeFocused();
  await pop2.locator("#pin").fill(WRONG);
  await expect(pop2.locator("#pin-tries")).toContainText("1"); // answered: the next one is typed after it
  await expect(pop2.locator("#pin")).toBeFocused();
  await pop2.locator("#pin").fill(WRONG);
  await expect(pop2.locator("#secret")).toBeVisible();
  await expect(pop2.locator("#pin-waiting")).toContainText(/once you type the master password|输一次主密码后/);
  const ended = await recOf(pop2);
  expect(ended!.wrap).toBeNull(); // no key material left
  await pop2.close();
  await restart();
  const again = await openPopup(p);
  await expect(again.locator("#pin")).toHaveCount(0);
  await again.locator("#secret").fill(STRONG);
  await again.locator("#secret").press("Enter");
  await expect(again.locator("#q")).toBeVisible();
  await expect.poll(async () => !!(await recOf(again))?.wrap).toBe(true); // the note made it anew
  expect((await recOf(again))!.id).not.toBe(ended!.id);
  await again.close();
  await restart();
  await pinOpens(await openPopup(p));
});

test("the master password typed while the PIN waits, the popup closed the moment the list shows: the record is made, and the next lock screen opens with the PIN alone (review of PINONE, PO-02; timed)", async () => {
  await (await withPin()).close();
  const pop = await openPopup(p);
  await pop.locator("#lock-now").click();
  for (let i = 0; i < 5; i++) {
    await expect(pop.locator("#pin")).toBeFocused();
    await pop.locator("#pin").fill(WRONG);
    if (i < 4) await expect(pop.locator("#pin-tries")).toContainText(String(4 - i));
  }
  await expect(pop.locator("#pin-waiting")).toBeVisible();
  const before = (await recOf(pop))!;
  expect(before.wrap).toBeNull();
  await pop.close();
  const again = await openPopup(p);
  await expect(again.locator("#pin-waiting")).toContainText(/once you type the master password|输一次主密码后/);
  await again.locator("#secret").fill(STRONG);
  const t0 = Date.now();
  await again.locator("#secret").press("Enter");
  await expect(again.locator("#q")).toBeVisible({ timeout: 30_000 });
  const making = Date.now() - t0;
  await again.close(); // a code copied, the page clicked: the popup goes at once
  const look = await openPopup(p); // still unlocked (the default lock mode): it reads the record as the popup left it
  const made = (await recOf(look))!;
  expect(made.wrap, "the PIN works again after the master password typed once").not.toBeNull();
  expect(made.id).not.toBe(before.id);
  expect(made.fails).toBe(0);
  await look.locator("#lock-now").click();
  // the steady state, for the time beside it: the master password with a healthy record writes nothing, derives nothing
  await look.locator("#use-password").click();
  await look.locator("#secret").fill(STRONG);
  const t1 = Date.now();
  await look.locator("#secret").press("Enter");
  await expect(look.locator("#q")).toBeVisible({ timeout: 30_000 });
  const steady = Date.now() - t1;
  expect((await recOf(look))!.id).toBe(made.id); // nothing made again
  process.stdout.write(`PIN-NOTE timing (ms): the unlock that makes the record ${making}, a steady one ${steady}\n`);
  await look.locator("#lock-now").click();
  await pinOpens(look); // the next lock screen: the PIN alone
});

test("a key change pauses it (not offered after a restart); right after it, the PIN alone turns it back on in Settings", async () => {
  const opt = await withPin();
  const before = (await recOf(opt))!;
  await showSection(opt, "security-keys");
  await openFold(opt, "fold-rotate");
  await opt.locator("#rot-pw").fill(STRONG);
  await opt.locator("#rotate-key").click();
  await expect(opt.locator("#recovery-code")).toBeVisible();
  await expect.poll(async () => (await recOf(opt))?.wrap).toBeNull(); // paused: the old key's wrap is gone
  await opt.locator("#recovery-saved").check();
  await opt.locator("#recovery-done").click();
  // back in this very page's PIN box: the PIN alone turns it back on (this page's own key change, just now)
  await showSection(opt, "security");
  await openFold(opt, "pin-box");
  await expect(opt.locator("#pin-restart-pin")).toBeVisible();
  await opt.locator("#pin-restart-pin").fill(PIN);
  await opt.locator("#pin-restart-go").click();
  await expect.poll(async () => !!(await recOf(opt))?.wrap).toBe(true);
  const after = (await recOf(opt))!;
  expect(after.vkId).not.toBe(before.vkId);
  await opt.close();
  await restart();
  await pinOpens(await openPopup(p));
});

test("paused, a restart: no PIN offered and the line says the master password once; the master password brings the PIN back", async () => {
  const opt = await withPin();
  const old = await pinKeyOf(opt);
  expect(old).toBeTruthy();
  await showSection(opt, "security-keys");
  await openFold(opt, "fold-rotate");
  await opt.locator("#rot-pw").fill(STRONG);
  await opt.locator("#rotate-key").click();
  await expect(opt.locator("#recovery-code")).toBeVisible();
  // The code is shown before the key change's cleanup moves the PIN's set-up to the new key (service.ts, after a key
  // change). A restart before that leaves the set-up under the old key, which offers nothing until the master password
  // finishes the cleanup, so this test waits for the move: the restart it means comes after it.
  await expect.poll(() => pinKeyOf(opt)).not.toBe(old);
  await opt.close();
  await restart();
  const pop = await openPopup(p);
  await expect(pop.locator("#secret")).toBeVisible();
  await expect(pop.locator("#pin")).toHaveCount(0);
  await expect(pop.locator("#pin-waiting")).toContainText(/once you type the master password|输一次主密码后/);
  await pop.locator("#secret").fill(STRONG);
  await pop.locator("#secret").press("Enter");
  await expect(pop.locator("#q")).toBeVisible();
  await expect.poll(async () => !!(await recOf(pop))?.wrap).toBe(true); // made again under the new key
  await pop.close();
  await restart();
  await pinOpens(await openPopup(p));
});

test("a new PIN of 4 digits: the record made again with it, which opens after a restart; paused by a key change, the new PIN makes its own", async () => {
  const opt = await withPin();
  const first = (await recOf(opt))!;
  await setPin(opt, PIN4);
  const second = (await recOf(opt))!;
  expect(second.id).not.toBe(first.id);
  await expect(opt.locator("#pin-state")).toContainText(/On \(4 digits\)|已开启（4 位）/);
  await opt.close();
  await restart();
  await pinOpens(await openPopup(p), PIN4);
  const page = await openOptions(p, "#security-keys");
  await openFold(page, "fold-rotate");
  await page.locator("#rot-pw").fill(STRONG);
  await page.locator("#rotate-key").click();
  await expect(page.locator("#recovery-code")).toBeVisible(); // the new key is committed: the record is paused
  await page.locator("#recovery-saved").check();
  await page.locator("#recovery-done").click();
  await showSection(page, "security");
  await setPin(page, "8152");
  expect((await recOf(page))!.id).not.toBe(second.id);
  await page.close();
  await restart();
  await pinOpens(await openPopup(p), "8152");
});

test("the shared preset: no PIN there, and its record is removed", async () => {
  const opt = await withPin();
  await openFold(opt, "pin-box");
  await opt.locator("#sm-shared").check();
  await expect(opt.locator("#pin-shared")).toBeVisible();
  await expect.poll(() => recOf(opt)).toBeUndefined();
  await opt.close();
  await restart();
  const pop = await openPopup(p);
  await expect(pop.locator("#secret")).toBeVisible();
  await expect(pop.locator("#pin")).toHaveCount(0);
  await expect(pop.locator("#pin-waiting")).toHaveCount(0); // nothing said of a PIN there
});

test("no time limit (OWNER-DECISIONS/20, 2026-10-30): with the page's clock 13 days, 15 days and 30 days on, the PIN opens", async () => {
  await (await withPin()).close();
  await restart();
  const at = Date.now();
  for (const days of [13, 15, 30]) {
    const page = await p.ctx.newPage();
    await page.clock.install({ time: at + days * DAY });
    await page.clock.resume();
    await page.goto(`chrome-extension://${p.id}/popup/index.html`);
    await pinOpens(page);
    await page.locator("#lock-now").click();
    await page.close();
  }
});

test("a stub planted in the storage (no vault key) is never listed nor used, and is replaced; the PIN works again (review r2, PINR-01)", async () => {
  const opt = await withPin();
  const plant = () =>
    opt.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      const g = all[`sk_slot_${all.sk_active}`] as {
        keyring: { vaultId: string; vkId: string; wraps: { wrapped: string }[] };
      };
      const pin = all.sk_pin as { kdf: { salt: string } };
      const b64 = (n: number) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n))));
      await chrome.storage.local.set({
        sk_pin_restart: {
          v: 1,
          id: b64(16),
          vaultId: g.keyring.vaultId,
          vkId: g.keyring.vkId,
          setup: pin.kdf.salt,
          wraps: g.keyring.wraps.map((w) => w.wrapped).join(","),
          mac: b64(32), // not Sixkey's: the planter has no vault key
          lastPasswordAt: 0,
          fails: 5,
          wrap: null,
        },
      });
    });
  // planted while "What Sixkey keeps" is the leaf shown (Security record): the PIN box, which also removes it, is not
  // mounted there, so the inventory is the first to read it (review r2's M04)
  await showSection(opt, "security-log");
  await plant();
  await opt.reload();
  await expect(opt.locator(".status dd.num")).toHaveText(/^\d+$/);
  // "What Sixkey keeps" does not list it, and its look removes it: its lines come in one render with the snapshots'
  // line, so once that one is shown the record's line would be too
  await expect(opt.locator("#security-stored li", { hasText: /older encrypted copies|较早的加密副本/ })).toBeVisible();
  await expect(opt.locator("#security-stored-restart")).toHaveCount(0);
  await expect.poll(() => recOf(opt)).toBeUndefined(); // removed by the inventory's look
  // planted again: the lock screen shows no PIN field for it, and the master password replaces it with Sixkey's own
  await plant();
  await opt.close();
  await restart();
  const pop = await openPopup(p);
  await expect(pop.locator("#secret")).toBeVisible();
  await expect(pop.locator("#pin")).toHaveCount(0);
  await pop.locator("#secret").fill(STRONG);
  await pop.locator("#secret").press("Enter");
  await expect(pop.locator("#q")).toBeVisible();
  await expect.poll(async () => (await recOf(pop))?.fails).toBe(0);
  await expect.poll(async () => !!(await recOf(pop))?.wrap).toBe(true);
  await pop.close();
  await restart();
  await pinOpens(await openPopup(p));
});

test("lock every time the popup closes: after a restart every popup opens with the PIN, each deriving again (timed)", async () => {
  const opt = await withPin();
  await opt.locator("#al-mode").selectOption("always");
  await expect.poll(() => recOf(opt)).toBeDefined(); // a change of lock mode leaves it
  await opt.close();
  await restart();
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const pop = await openPopup(p);
    times.push(await pinOpens(pop));
    await pop.close(); // the lock, in this mode
  }
  process.stdout.write(`PIN-RESTART timing (ms): record ${times.join(", ")}\n`);
  for (const t of times) expect(t).toBeLessThan(30_000);
});
