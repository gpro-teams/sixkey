// PHASE0X-PLAN A4 (docs/audit/internal-reviews/A4-REVIEW.md A4R-1, A4R-8; docs/audit/internal-reviews/C6-REVIEW.md C6-1): forgetting the master password, and making a
// new recovery code. The reset runs in a settings tab (the popup's button opens it): the new code is shown before anything
// is written, and the tab stays open while the user saves it elsewhere, which would close the popup.
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

const NEW = "Zk4#nW8!qR2@vL7$mT5x";
let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

/** From the popup's lock screen: Use recovery key, then Set a new password, which opens the settings tab at #reset. */
async function resetTab(pop: Page): Promise<Page> {
  await pop.getByRole("button", { name: /Use recovery key|使用恢复密钥/ }).click();
  const [tab] = await Promise.all([p.ctx.waitForEvent("page"), pop.locator("#forgot-password").click()]);
  await expect(tab.locator("#reset")).toBeVisible();
  return tab;
}
async function prepare(tab: Page, code: string): Promise<string> {
  await tab.locator("#reset-code-in").fill(code);
  await tab.locator("#reset-pw").fill(NEW);
  await tab.locator("#reset-pw2").fill(NEW);
  await tab.locator("#reset-next").click();
  await expect(tab.locator("#recovery-code")).toBeVisible();
  return (await tab.locator("#recovery-code").textContent())!.replace(/[^0-9A-Z-]/g, "");
}
async function unlock(pop: Page, secret: string, recovery = false) {
  if (recovery) await pop.getByRole("button", { name: /Use recovery key|使用恢复密钥/ }).click();
  await pop.locator("#secret").fill(secret);
  await pop.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
}
/** The security log's entries as stored: oldest first. */
const securityKinds = (page: Page) =>
  page.evaluate(
    async () =>
      (
        (await chrome.storage.local.get("sk_security_log")).sk_security_log as
          { entries: { kind: string }[] } | undefined
      )?.entries.map((e) => e.kind) ?? [],
  );

test("forgot the password: the popup opens the reset in a tab; a weak or mistyped new password is caught; nothing changes until the new code is confirmed saved", async () => {
  const { recoveryCode: r1 } = await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const pop = await openPopup(p);
  await pop.getByRole("button", { name: /^(Lock|锁定)$/ }).click();
  const tab = await resetTab(pop);
  await tab.locator("#reset-code-in").fill(r1);
  await tab.locator("#reset-pw").fill("password1234!"); // passes the service floor, about 17 estimated bits
  await tab.locator("#reset-pw2").fill("password1234!");
  // under 10^6 guesses: too easy to guess, and no "Use anyway" (OWNER-DECISIONS/15 item 1)
  await expect(tab.locator("#reset-next")).toBeDisabled();
  await expect(tab.locator("#reset-strength")).toHaveText(/Too easy to guess|太容易猜/);
  await expect(tab.locator("#reset-anyway")).toHaveCount(0);
  await tab.locator("#reset-pw").fill(NEW);
  await tab.locator("#reset-pw2").fill(`${NEW}x`);
  await expect(tab.locator("#reset-next")).toBeDisabled(); // typed differently: a typo cannot become the only password
  await tab.locator("#reset-pw2").fill(NEW);
  await tab.locator("#reset-next").click();
  await expect(tab.locator("#recovery-code")).toBeVisible(); // the new code, before anything is written
  await expect(tab.locator("#reset-note")).toContainText(/Nothing has changed yet|现在还没有任何改动/);
  const unseen = (await tab.locator("#recovery-code").textContent())!.replace(/[^0-9A-Z-]/g, "");
  await tab.close(); // closed before it was confirmed

  // nothing changed: the new code opens nothing, the old one still opens
  const again = await openPopup(p);
  await unlock(again, unseen, true);
  await expect(again.getByRole("alert")).toContainText(/does not match|不匹配/);
  await again.locator("#secret").fill(r1);
  await again.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
  await expect(again.locator(".row", { hasText: "GitHub" })).toBeVisible();
  await again.getByRole("button", { name: /^(Lock|锁定)$/ }).click();

  // to the end this time: saved, then Continue writes it
  const tab2 = await resetTab(again);
  const r2 = await prepare(tab2, r1);
  expect(r2).not.toBe(unseen); // a new one each time
  await expect(tab2.locator("#recovery-done")).toBeDisabled(); // not before "I have saved my recovery key"
  await tab2.locator("#recovery-saved").check();
  await tab2.locator("#recovery-done").click();
  await expect(tab2.locator("#reset-done")).toBeVisible();
  await expect(tab2.locator("#reset")).toHaveCount(0);
  // the first tab's accepted code (recorded although that tab wrote nothing: A3-9); the guess with the unseen code; the
  // unlock with the old one; this tab's accepted code; the reset
  expect(await securityKinds(tab2)).toEqual([
    "recovery_used",
    "recovery_failed",
    "recovery_used",
    "recovery_used",
    "password_reset",
  ]);

  // the new password and the new code open; the old code does not
  const after = await openPopup(p);
  await expect(after.locator(".row", { hasText: "GitHub" })).toBeVisible(); // the reset unlocked
  await after.getByRole("button", { name: /^(Lock|锁定)$/ }).click();
  await unlock(after, NEW);
  await expect(after.locator(".row", { hasText: "GitHub" })).toBeVisible();
  await after.getByRole("button", { name: /^(Lock|锁定)$/ }).click();
  await unlock(after, r1, true);
  await expect(after.getByRole("alert")).toContainText(/does not match|不匹配/);
  await after.locator("#secret").fill(r2);
  await after.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
  await expect(after.locator(".row", { hasText: "GitHub" })).toBeVisible();
});

test("the keys change in another window between the two steps: the tab says so, drops the code that can never work, and the form starts again", async () => {
  const { recoveryCode: r1 } = await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const pop = await openPopup(p);
  await pop.getByRole("button", { name: /^(Lock|锁定)$/ }).click();
  const tab = await resetTab(pop);
  await prepare(tab, r1);
  // meanwhile the owner, who remembers the password, unlocks and makes a new recovery code in another window
  const other = await openPopup(p);
  await unlock(other, STRONG);
  await expect(other.locator(".row", { hasText: "GitHub" })).toBeVisible();
  const sec = await openOptions(p, "#security-keys");
  await openFold(sec, "fold-code");
  await sec.locator("#code-pw").fill(STRONG);
  await sec.locator("#new-code").click();
  await expect(sec.locator("#recovery-code")).toBeVisible();
  // back in the reset tab
  await tab.locator("#recovery-saved").check();
  await tab.locator("#recovery-done").click();
  await expect(tab.getByRole("alert")).toContainText(/changed in another window|在另一个窗口中被更改/);
  await expect(tab.locator("#recovery-code")).toHaveCount(0); // no code left on screen that could never work
  await expect(tab.locator("#reset-next")).toBeVisible(); // the form, to start again
});

test("making a new recovery code asks for the master password (H3): a wrong one is refused and counted, no code; the right one shows it", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const sec = await openOptions(p, "#security-keys");
  await openFold(sec, "fold-code");
  await expect(sec.locator("#new-code")).toBeDisabled(); // nothing typed: nothing to press
  await sec.locator("#code-pw").fill("Wrong#Guess9!Zebra4$Pine");
  await sec.locator("#new-code").click();
  await expect(sec.getByRole("alert")).toContainText(/Wrong password|密码错误/);
  await expect(sec.locator("#recovery-code")).toHaveCount(0);
  expect(await securityKinds(sec)).toEqual(["unlock_failed"]);
  await sec.locator("#code-pw").fill(STRONG);
  await sec.locator("#new-code").click();
  await expect(sec.locator("#recovery-code")).toBeVisible();
  expect(await securityKinds(sec)).toEqual(["unlock_failed", "recovery_code_new"]);
});

test("the commit fails with an I/O error: the confirmed code stays on screen, and Continue again finishes the reset with that same code", async () => {
  const { recoveryCode: r1 } = await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const pop = await openPopup(p);
  await pop.getByRole("button", { name: /^(Lock|锁定)$/ }).click();
  const tab = await resetTab(pop);
  const r2 = await prepare(tab, r1);
  // the commit's pointer write lands and then reports an error (FIXb writes the old state back: nothing is in force)
  await tab.evaluate(() => {
    const area = chrome.storage.local;
    const set = area.set.bind(area);
    let once = false;
    (area as { set: (i: Record<string, unknown>) => Promise<void> }).set = async (items: Record<string, unknown>) => {
      await set(items);
      if (!once && "sk_active" in items) {
        once = true;
        throw new Error("IO error after the write");
      }
    };
  });
  await tab.locator("#recovery-saved").check();
  await tab.locator("#recovery-done").click();
  await expect(tab.locator(".err[role=alert]")).toBeVisible();
  await expect(tab.locator("#recovery-code")).toBeVisible(); // the code the user just saved is still the one on screen
  expect((await tab.locator("#recovery-code").textContent())!.replace(/[^0-9A-Z-]/g, "")).toBe(r2);
  await tab.locator("#recovery-done").click(); // Continue again
  await expect(tab.locator("#reset-done")).toBeVisible();
  const after = await openPopup(p);
  await after.getByRole("button", { name: /^(Lock|锁定)$/ }).click();
  await unlock(after, r2, true); // the code that was saved is the live one
  await expect(after.locator(".row", { hasText: "GitHub" })).toBeVisible();
});

test("the reset is written but the session cannot be stored: the tab says so and offers the unlock, with no code screen left (no 'already used' for a reset that worked)", async () => {
  const { recoveryCode: r1 } = await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const pop = await openPopup(p);
  await pop.getByRole("button", { name: /^(Lock|锁定)$/ }).click();
  const tab = await resetTab(pop);
  await prepare(tab, r1);
  // chrome.storage.session refuses writes in this tab (where the unlocked key would go)
  await tab.evaluate(() => {
    (chrome.storage.session as { set: (i: Record<string, unknown>) => Promise<void> }).set = async () => {
      throw new Error("session storage unavailable");
    };
  });
  await tab.locator("#recovery-saved").check();
  await tab.locator("#recovery-done").click();
  await expect(tab.locator("#reset-done")).toContainText(/Unlock with the new password|请用新密码解锁/);
  await expect(tab.locator("#recovery-code")).toHaveCount(0);
  await expect(tab.locator("#unlock-pw")).toBeVisible(); // the unlock bar
  // the reset is in force: the new password opens
  const after = await openPopup(p);
  await unlock(after, NEW);
  await expect(after.locator(".row", { hasText: "GitHub" })).toBeVisible();
});
