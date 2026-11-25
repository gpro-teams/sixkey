// QUICK-UNLOCK Stage 1 end to end (docs/design/notes/QUICK-PIN-NOTES.md; OWNER-DECISIONS/20 and its 2026-10-30 notes:
// PIN-RESTART-NOTES.md §18): the PIN set in Settings › Security behind the master password, what it costs said before, a
// weak one said and taken; Lock now and the PIN field focused at once; 4 wrong and 1 right; 5 wrong and then only the
// master password, which makes the PIN work again; an open popup dropping its codes when another page locks; a real
// browser restart keeping the PIN; the shared preset taking it away; lock every time the popup closes reopening with the
// PIN; the `lock` shortcut declared and shown.
// Real keyboard shortcuts cannot be pressed from Playwright (they are browser accelerators): the command's handler is
// covered by test/unit/m5-sw-wiring.test.ts, and here its binding is read back as site.spec.ts reads Alt+Shift+K.
import { expect, test, type Page } from "@playwright/test";
import {
  addByPaste,
  close,
  GITHUB_URI,
  launch,
  openFold,
  openOptions,
  openPopup,
  type Profile,
  startFresh,
  STRONG,
} from "./harness";

const PIN = "246813";
const WRONG = "975310";

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

/** Settings › Security › PIN quick unlock: the master password and the PIN twice, then Set PIN. */
async function setPin(pin = PIN): Promise<Page> {
  const opt = await openOptions(p, "#security");
  await expect(opt.locator(".status dd.num")).toHaveText(/^\d+$/); // loaded: nothing redraws the fields while typing
  await expect(opt.locator("#pin-box")).toBeVisible();
  await openFold(opt, "pin-box");
  await opt.locator("#pin-pw").fill(STRONG);
  await opt.locator("#pin-new").fill(pin);
  await opt.locator("#pin-new2").fill(pin);
  await opt.locator("#pin-set").click();
  await expect(opt.locator("#pin-info")).toBeVisible();
  await expect(opt.locator("#pin-state")).toBeVisible();
  await openFold(opt, "pin-box"); // the box closed itself; opened again, nothing is left in the fields
  await expect(opt.locator("#pin-pw-pin")).toHaveValue(""); // a PIN set now: its change asks for it (OWNER-DECISIONS/26)
  await expect(opt.locator("#pin-new")).toHaveValue("");
  return opt;
}
/** The PIN's record (sk_pin_restart): its count of wrong tries and whether its wrap is there. */
const recOf = (page: Page) =>
  page.evaluate(
    async () =>
      (await chrome.storage.local.get("sk_pin_restart")).sk_pin_restart as
        { fails: number; wrap: object | null } | undefined,
  );
/** The settings page's unlock bar, with the master password: unlocked, and the PIN usable again, the box saying so. */
async function unlockArmed(opt: Page) {
  await opt.locator("#unlock-pw").fill(STRONG);
  await opt.locator("#unlock-btn").click();
  await expect(opt.locator("#unlock-pw")).toHaveCount(0);
  await expect.poll(async () => !!(await recOf(opt))?.wrap).toBe(true);
  await expect(opt.locator("#pin-state")).toContainText(/On \(6 digits\)|已开启（6 位）/);
}

test("set the PIN, Lock now, the PIN field focused and numeric; the PIN opens Sixkey; nothing of it is left behind", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const opt = await setPin();
  // what a PIN costs is said in the box, above its form (OWNER-DECISIONS/20, 2026-10-30)
  await openFold(opt, "pin-box");
  await expect(opt.locator("#pin-restart-cost")).toContainText(/guess your PIN offline|离线猜你的 PIN/);
  // a weak PIN is said to be weak, and taken (warn, do not block); the PIN set confirms its change (OWNER-DECISIONS/26)
  await opt.locator("#pin-pw-pin").fill(PIN);
  await opt.locator("#pin-new").fill("1234");
  await opt.locator("#pin-new2").fill("1234");
  await expect(opt.locator("#pin-hint")).toHaveText(/1234/);
  await expect(opt.locator("#pin-set")).toBeEnabled();
  await opt.locator("#pin-pw-pin").fill("");
  // nothing of the PIN is in chrome.storage.local: its set-up under the vault key, and its record (the vault key under
  // a key only the PIN derives)
  const local = await opt.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  expect(local).not.toContain(PIN);
  expect(local).not.toContain("sk_quick");
  expect(local).toContain("sk_pin");
  expect(local).toContain("sk_pin_restart");
  await opt.close();

  const pop = await openPopup(p);
  await expect(pop.locator("#q")).toBeVisible();
  await pop.locator("#lock-now").click(); // Lock now in the header
  const pin = pop.locator("#pin");
  await expect(pin).toBeVisible();
  await expect(pin).toBeFocused();
  await expect(pin).toHaveAttribute("type", "password");
  await expect(pin).toHaveAttribute("inputmode", "numeric");
  await expect(pin).toHaveAttribute("autocomplete", "off");
  await expect(pop.locator("label[for=pin]")).toBeVisible();
  await expect(pin).toHaveAttribute("aria-describedby", "pin-tries");
  await expect(pop.locator("#pin-tries")).toContainText("5");
  // typed straight in: it submits by itself at the PIN's length
  await pop.keyboard.type(PIN);
  await expect(pop.locator("#q")).toBeVisible();
  await expect(pop.locator(".row")).toHaveCount(1);
  expect(pop.url()).not.toContain(PIN);
  expect(await pop.content()).not.toContain(PIN);
  await pop.close();
});

test("4 wrong PINs and the right one; then 5 wrong ones end it, and only the master password opens Sixkey", async () => {
  await startFresh(p);
  await (await setPin()).close();
  const pop = await openPopup(p);
  await pop.locator("#lock-now").click();
  const pin = pop.locator("#pin");
  for (const left of [4, 3, 2, 1]) {
    await pin.fill(WRONG); // fill sets the whole value: the length reached, it submits
    await expect(pop.locator("[role=alert]")).toContainText(String(left));
    await expect(pin).toHaveValue(""); // emptied at once
    await expect(pop.locator("#pin-tries")).toContainText(String(left));
  }
  await pin.fill(PIN);
  await expect(pop.locator("#q")).toBeVisible();
  expect((await recOf(pop))!.fails).toBe(0);

  await pop.locator("#lock-now").click();
  for (let i = 0; i < 5; i++) {
    await expect(pop.locator("#pin")).toBeFocused();
    await pop.locator("#pin").fill(WRONG);
    if (i < 4) await expect(pop.locator("#pin-tries")).toContainText(String(4 - i));
  }
  // the master password, focused, with the reason
  await expect(pop.locator("#secret")).toBeVisible();
  await expect(pop.locator("#secret")).toBeFocused();
  await expect(pop.locator("[role=alert]")).toBeVisible();
  await expect(pop.locator("#use-pin")).toHaveCount(0);
  expect((await recOf(pop))!.wrap).toBeNull(); // its key off the disk
  await pop.close();
  const again = await openPopup(p);
  await expect(again.locator("#secret")).toBeVisible(); // no PIN field any more
  await expect(again.locator("#pin")).toHaveCount(0);
  await expect(again.locator("#pin-waiting")).toBeVisible(); // the line: the master password once
  await again.locator("#secret").fill(STRONG);
  await again.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
  await expect(again.locator("#q")).toBeVisible();
  await expect.poll(async () => (await recOf(again))?.fails).toBe(0); // the master password made it again
  await expect.poll(async () => !!(await recOf(again))?.wrap).toBe(true);
});

test("an open popup drops its codes at once when another page locks; the master password is one button away", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  await (await setPin()).close();
  const open = await openPopup(p);
  await expect(open.locator(".row")).toHaveCount(1);
  const other = await openPopup(p);
  await other.locator("#lock-now").click();
  await expect(open.locator(".row")).toHaveCount(0); // without being reloaded
  await expect(open.locator("#pin")).toBeVisible();
  await open.locator("#use-password").click();
  await expect(open.locator("#secret")).toBeFocused();
  await open.locator("#use-pin").click();
  await expect(open.locator("#pin")).toBeFocused();
  await other.close();
  await open.close();
});

test("a browser restart keeps the PIN (OWNER-DECISIONS/20, 2026-10-30): the PIN opens Sixkey, no master password first", async () => {
  await startFresh(p);
  await (await setPin()).close();
  const before = await openPopup(p);
  await before.locator("#lock-now").click();
  await expect(before.locator("#pin")).toBeVisible();
  await before.close();
  await close(p, false);
  p = await launch(p.dir);
  const pop = await openPopup(p);
  await expect(pop.locator("#pin")).toBeFocused();
  await expect(pop.locator("#secret")).toHaveCount(0);
  await pop.keyboard.type(PIN);
  await expect(pop.locator("#q")).toBeVisible({ timeout: 30_000 });
  await pop.locator("#lock-now").click();
  await expect(pop.locator("#pin")).toBeVisible();
});

test("the shared preset takes the PIN away (a hard lock) and says why; Only me brings it back after the master password", async () => {
  await startFresh(p);
  const opt = await setPin();
  await opt.locator("#sm-shared").check();
  await expect(opt.locator("#unlock-pw")).toBeVisible(); // a hard lock: no PIN in the unlock bar either
  await expect(opt.locator("#unlock-pin")).toHaveCount(0);
  await expect(opt.locator("#pin-shared")).toBeVisible();
  await expect.poll(() => recOf(opt)).toBeUndefined(); // its record removed
  const pop = await openPopup(p);
  await expect(pop.locator("#secret")).toBeVisible();
  await expect(pop.locator("#pin")).toHaveCount(0);
  await pop.close();
  await opt.locator("#unlock-pw").fill(STRONG);
  await opt.locator("#unlock-btn").click();
  await expect(opt.locator("#unlock-pw")).toHaveCount(0);
  expect(await recOf(opt)).toBeUndefined(); // no PIN in a shared profile
  await opt.locator("#sm-standard").check();
  await expect(opt.locator("#unlock-pw")).toBeVisible();
  await unlockArmed(opt);
});

test("lock every time the popup closes, in a solo profile: each new popup opens on the PIN; the settings page's unlock bar takes the PIN too", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const opt = await setPin();
  await opt.locator("#al-mode").selectOption("always"); // a change of lock mode: a lock, which the PIN opens
  await expect(opt.locator("#unlock-pin")).toBeVisible();
  await opt.locator("#unlock-pin").fill(PIN);
  await opt.locator("#unlock-btn").click();
  await expect(opt.locator("#unlock-pin")).toHaveCount(0);
  for (let i = 0; i < 2; i++) {
    const pop = await openPopup(p);
    await expect(pop.locator("#pin")).toBeFocused();
    await pop.keyboard.type(PIN);
    await expect(pop.locator(".row")).toHaveCount(1);
    // the unlocked key is in this popup's memory only
    expect(await pop.evaluate(async () => (await chrome.storage.session.get("sk_session")).sk_session)).toBeUndefined();
    await pop.close(); // closing it is the lock
  }
  // the settings page, locked by the popup's lock elsewhere, asks for the PIN first
  const pop = await openPopup(p);
  await expect(pop.locator("#pin")).toBeFocused();
  await pop.keyboard.type(PIN);
  await expect(pop.locator(".row")).toHaveCount(1);
  await pop.locator("#lock-now").click();
  await expect(opt.locator("#unlock-pin")).toBeVisible();
  await opt.locator("#unlock-pin").fill(PIN);
  await opt.locator("#unlock-btn").click();
  await expect(opt.locator("#unlock-pin")).toHaveCount(0);
  await expect(opt.locator("#pin-state")).toBeVisible();
});

test("the `lock` shortcut is declared (Alt+Shift+L, no permission) and bound on a fresh profile; Settings shows it and where to change it", async () => {
  await startFresh(p);
  const opt = await openOptions(p, "#security");
  const m = await opt.evaluate(() => chrome.runtime.getManifest());
  expect(m.commands?.lock?.suggested_key).toEqual({ default: "Alt+Shift+L" });
  expect(m.commands?.lock?.description).toBeTruthy();
  const commands = await opt.evaluate(() => chrome.commands.getAll());
  const lock = commands.find((c) => c.name === "lock");
  expect(lock, JSON.stringify(commands)).toBeDefined();
  expect(lock!.shortcut, "assigned on a fresh profile").toMatch(/L$/);
  expect(lock!.description).toMatch(/Sixkey/);
  await expect(opt.locator("#sm-lock-key kbd")).toHaveText(lock!.shortcut!);
  await expect(opt.locator("#sm-lock-key-edit")).toBeVisible();
  const pop = await openPopup(p);
  await expect(pop.locator("#lock-now")).toHaveAttribute(
    "title",
    new RegExp(`\\(${lock!.shortcut!.replace(/[+]/g, "\\+")}\\)$`),
  );
});

test("End quick unlock and lock is offered on a locked settings page too, with no password: it ends the PIN", async () => {
  await startFresh(p);
  const opt = await setPin();
  const pop = await openPopup(p);
  await pop.locator("#lock-now").click(); // the soft lock reaches the settings page: it asks for the PIN
  await expect(opt.locator("#unlock-pin")).toBeVisible();
  await expect(opt.locator("#quick-end")).toBeVisible();
  await opt.locator("#quick-end").click();
  await expect(opt.locator("#pin-info")).toBeVisible();
  await expect(opt.locator("#unlock-pw")).toBeVisible(); // the master password only now
  await expect(opt.locator("#unlock-pin")).toHaveCount(0);
  expect((await recOf(opt))!.wrap).toBeNull(); // its key off the disk: the master password makes it again
  await pop.reload();
  await expect(pop.locator("#secret")).toBeVisible();
  await expect(pop.locator("#pin")).toHaveCount(0);
});

test("Delete forever asks again (it cannot be undone): the PIN since 2026-11-24, a wrong one refused; the edit dialog loads on first use", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  await (await setPin()).close();
  const pop = await openPopup(p);
  await pop.locator("#lock-now").click();
  await expect(pop.locator("#pin")).toBeFocused(); // the lock screen is up: the digits go to the PIN field
  await pop.keyboard.type(PIN); // in with the PIN only
  await expect(pop.locator(".row")).toHaveCount(1);
  await pop.locator(".row .more").first().click(); // the edit dialog, a chunk of its own
  await pop.getByRole("button", { name: /^(Delete|删除)$/ }).click();
  await pop.getByRole("button", { name: /Click again|再点一次/ }).click();
  await expect(pop.locator(".row")).toHaveCount(0);
  const opt = await openOptions(p, "#trash");
  const row = opt.locator("#trash tr", { hasText: "GitHub" });
  const erase = row.getByRole("button", { name: /^(Delete forever|永久删除)$/ });
  await expect(erase).toBeDisabled(); // nothing typed
  await opt.locator("#trash-pw-pin").fill(WRONG); // a wrong PIN: refused, with its tries left (OWNER-DECISIONS/26)
  await erase.click();
  await expect(opt.locator("#trash [role=alert]")).toContainText(/Tries left: 4|还可以再试 4 次/);
  await expect(row).toHaveCount(1);
  await opt.locator("#trash-pw-pin").fill(PIN);
  await erase.click();
  await expect(row).toHaveCount(0);
  await expect(opt.locator("#trash-pw-pin")).toHaveCount(0); // nothing left in the trash: no field
});

test("first run's PIN step (2026-11-25): set right after the recovery key, without the master password, and the lock screen takes it", async () => {
  await startFresh(p, { pin: PIN });
  const pop = await openPopup(p);
  await expect(pop.locator("#q")).toBeVisible();
  await pop.locator("#lock-now").click();
  const pin = pop.locator("#pin");
  await expect(pin).toBeVisible();
  await pin.fill(PIN);
  await expect(pop.locator("#q")).toBeVisible();
});

test("first run's PIN step: a lock while it is open empties the fields, and the PIN is left to Settings", async () => {
  const pop = await openPopup(p);
  const [opt] = await Promise.all([p.ctx.waitForEvent("page"), pop.locator("#start-secure").click()]);
  await opt.waitForLoadState();
  await opt.locator("#fr-pw").fill(STRONG);
  await opt.locator("#fr-pw2").fill(STRONG);
  await opt.locator("#fr-next").click();
  await opt.locator("#recovery-saved").check();
  await opt.locator("#recovery-done").click();
  await opt.locator("#fr-solo").check();
  await opt.locator("#fr-csb").setChecked(false);
  await opt.locator("#fr-finish").click();
  await opt.locator("#fr-pin-new").fill(PIN);
  const lock = await openPopup(p);
  await lock.locator("#lock-now").click();
  await expect(opt.locator("#fr-pin-later")).toBeVisible();
  await expect(opt.locator("#fr-pin-new")).toHaveCount(0);
  await expect(opt.locator("#fr-pin-set")).toHaveCount(0);
  await opt.locator("#fr-pin-skip").click(); // Continue: the page, locked, at its unlock bar
  await expect(opt.locator("#unlock-pw")).toBeVisible();
});
