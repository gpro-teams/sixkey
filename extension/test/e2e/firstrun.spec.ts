// First run (PHASE0X-PLAN A1; SYNC-DESIGN H1, H5): master password -> recovery code -> one question -> first account,
// in a settings tab. Nothing is written before the recovery code is confirmed and the question answered.
import { expect, test, type Page } from "@playwright/test";
import { createBackup } from "../../src/core/backup/backup";
import { parseOtpauth } from "../../src/core/totp/otpauth";
import { createClock } from "../../src/core/vault/hlc";
import { emptyVault } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import {
  acceptable,
  AWS_URI,
  close,
  digitsOf,
  finishWizard,
  GITHUB_URI,
  launch,
  openOptions,
  openPopup,
  type Profile,
  SECRET,
  seedLegacyDeviceVault,
  showSection,
  STRONG,
  writeTmp,
} from "./harness";

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

const VAULT_KEYS = /^sk_(active|slot_[ab]|keyring|snap_.*|mirror_gen)$/;
const vaultKeys = (page: Page) =>
  page
    .evaluate(async () => Object.keys(await chrome.storage.local.get(null)))
    .then((ks) => ks.filter((k) => VAULT_KEYS.test(k)).sort());

async function wizardFromPopup(): Promise<Page> {
  const pop = await openPopup(p);
  const [opt] = await Promise.all([p.ctx.waitForEvent("page"), pop.locator("#start-secure").click()]);
  await opt.waitForLoadState();
  return opt;
}

test("a new install has no way to add an account before the master password, and leaving the wizard early writes nothing", async () => {
  const pop = await openPopup(p);
  await expect(pop.locator("#start-secure")).toBeVisible();
  await expect(pop.getByRole("button")).toHaveText([/中文|EN/, /Start/, /Restore/]); // language, start, restore: nothing else
  await expect(pop.locator("#q")).toHaveCount(0);

  // every way into "Add accounts" on the settings page lands on the wizard instead
  await pop.evaluate((u) => chrome.storage.session.set({ sk_scan_text: u }), GITHUB_URI); // as if a QR code had been read from a page
  for (const hash of ["", "#add", "#add-scanned", "#backup"]) {
    const opt = await openOptions(p, hash);
    await expect(opt.locator("#setup")).toBeVisible();
    // Backup's encrypted export is a fold (BACKUP-VISUAL): its box stands for the leaf
    for (const id of ["#add", "#paste-box", "#qr-file", "#choose-file", "#cam-start", "#manual-add", "#encrypted"])
      await expect(opt.locator(id), `${hash} ${id}`).toHaveCount(0);
    await opt.close();
  }

  // step 1 and 2 done, the code is on screen: still nothing stored. Closing the tab leaves a fresh install.
  const opt = await wizardFromPopup();
  await opt.locator("#fr-pw").fill(STRONG);
  await opt.locator("#fr-pw2").fill(STRONG);
  await opt.locator("#fr-next").click();
  await expect(opt.locator("#recovery-code")).toBeVisible();
  await expect(opt.locator("#fr-code-note")).toBeVisible();
  await opt.locator("#recovery-saved").check();
  await opt.locator("#recovery-done").click();
  await expect(opt.locator("#fr-finish")).toBeVisible();
  expect(await vaultKeys(opt)).toEqual([]);
  await opt.close();
  const again = await openPopup(p);
  await expect(again.locator("#start-secure")).toBeVisible();
  expect(await vaultKeys(again)).toEqual([]);
});

test("'shared or automated': lock every time, clipboard guidance, and still unlocked for the first account", async () => {
  const opt = await wizardFromPopup();
  await opt.locator("#fr-pw").fill(STRONG);
  await opt.locator("#fr-pw2").fill(STRONG);
  await opt.locator("#fr-next").click();
  await opt.locator("#recovery-saved").check();
  await opt.locator("#recovery-done").click();
  // the backup in Chrome sync's box is ticked for "only me" and cleared for a shared profile, with whose account it is
  await expect(opt.locator("#fr-csb")).toBeChecked();
  await opt.locator("#fr-shared").check();
  await expect(opt.locator("#fr-csb")).not.toBeChecked();
  await expect(opt.locator("#fr-csb-shared")).toBeVisible();
  await opt.locator("#fr-finish").click();
  await expect(opt.locator("#fr-clip")).toBeVisible(); // the guidance (the e2e build already holds the permission)
  await expect(opt.locator("#fr-clip-state").or(opt.locator("#fr-clip-enable"))).toBeVisible();
  // the vault is written by now: no "restore instead" or "join instead" any more (UI sweep)
  await expect(opt.locator("#fr-to-restore, #fr-to-create, #fr-to-join")).toHaveCount(0);
  await opt.locator("#fr-clip-next").click();

  // step 4, same page: unlocked, the answer applied, the key in this page's memory only
  await expect(opt.locator("#fr-hint")).toBeVisible();
  await expect(opt.locator("#fr-hint")).toContainText(/first account|第一个账户/);
  await expect(opt.locator("#add")).toBeVisible(); // the wizard ends at Add accounts
  await showSection(opt, "security");
  await expect(opt.locator("#al-mode")).toHaveValue("always");
  await expect(opt.locator("#unlock-pw")).toHaveCount(0);
  await showSection(opt, "add");
  await opt.locator("#paste-box").fill(GITHUB_URI);
  await opt.locator("#add-confirm").click();
  await expect(opt.locator("#add-done")).toBeVisible();
  expect(await opt.evaluate(async () => JSON.stringify(await chrome.storage.session.get(null)))).not.toContain(
    "sk_session",
  );

  const pop = await openPopup(p);
  await expect(pop.locator("#secret")).toBeVisible(); // a new popup is locked
  await pop.locator("#secret").fill(STRONG);
  await pop.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
  await expect(pop.locator(".row")).toHaveCount(1);
  // the box left cleared: the backup was never turned on, and nothing went to Chrome sync
  expect(await pop.evaluate(() => chrome.storage.local.get("sk_csb_cfg"))).toEqual({});
  expect(await pop.evaluate(() => chrome.storage.sync.get(null))).toEqual({});
});

test("'only me': 15 idle minutes, screen lock, and the popup is unlocked", async () => {
  const opt = await wizardFromPopup();
  await finishWizard(opt, { risk: "solo" });
  expect(opt.url()).toMatch(/#add$/); // the wizard ended at Add accounts, and the address says so
  await showSection(opt, "security");
  await expect(opt.locator("#al-mode")).toHaveValue("idle");
  await expect(opt.locator("#al-minutes")).toHaveValue("15");
  await expect(opt.locator("#al-screen")).toBeChecked();
  await expect(opt.locator("#fr-clip")).toHaveCount(0);
  const pop = await openPopup(p);
  await expect(pop.locator("#q")).toBeVisible();
  // the box cleared (the harness clears it): recorded as the person's turning the backup off, as the card's Turn off
  // records it, so the popup's Back up now turns nothing on; nothing went to Chrome sync
  expect((await pop.evaluate(() => chrome.storage.local.get("sk_csb_cfg"))).sk_csb_cfg).toMatchObject({
    on: false,
    declined: true,
    link: null,
  });
  expect(await pop.evaluate(() => chrome.storage.sync.get(null))).toEqual({});
});

test("an old device-key vault still works, with a warning in the popup and on the settings page's side rail", async () => {
  await seedLegacyDeviceVault(p, [GITHUB_URI]);
  const pop = await openPopup(p);
  await expect(pop.locator(".row")).toHaveCount(1);
  await expect(pop.locator(".row .code").first()).toHaveText(/\d{3}/);
  expect(await acceptable(SECRET)).toContain(digitsOf(await pop.locator(".row .code").first().textContent()));
  await expect(pop.locator(".note.warn")).toContainText(/master password|主密码/);

  const opt = await openOptions(p);
  await expect(opt.locator("#setup")).toHaveCount(0); // a vault exists: no wizard
  await expect(opt.locator(".rail .status")).toContainText(/Device key only|仅设备密钥/);
  await opt.locator("#rail-set-password").click();
  await expect(opt.locator("#enable-pw")).toBeVisible(); // the upgrade path is right there
});

test("unreadable data, then 'Restore' on the Backup panel: the wizard takes the password first, then the accounts come back", async () => {
  const clock = createClock("dddd");
  let v = emptyVault("backup-vault-fr-1");
  for (const u of [GITHUB_URI, AWS_URI]) {
    const r = parseOtpauth(u);
    if (!r.ok) throw new Error(r.error);
    v = addEntry(v, r.value, clock).vault;
  }
  const file = writeTmp("backup.json", JSON.stringify(await createBackup(v, STRONG)));
  const seed = await openPopup(p);
  await seed.evaluate(() => chrome.storage.local.set({ sk_active: "a", sk_slot_a: { torn: "half a write" } }));
  await seed.close();

  const opt = await openOptions(p, "#backup");
  await opt.locator("#backup-file").setInputFiles(file);
  await opt.locator("#open-pw").fill(STRONG);
  await opt.getByRole("button", { name: /Open backup|打开备份/ }).click();
  await opt.locator("#apply-backup").click();
  await expect(opt.locator("#setup")).toBeVisible();
  await expect(opt.locator("#setup")).toContainText(/2 account|2 个账户/);
  expect(await vaultKeys(opt)).toEqual(["sk_active", "sk_slot_a"]); // still only the unreadable data
  await finishWizard(opt);
  await expect(opt.locator("#fr-hint")).toContainText(/Restored 2|已恢复 2/);
  const pop = await openPopup(p);
  await expect(pop.locator(".row")).toHaveCount(2);
  const code = pop.locator(".row", { hasText: "GitHub" }).locator(".code");
  await expect(code).toHaveText(/\d{3}/);
  expect(await acceptable(SECRET)).toContain(digitsOf(await code.textContent()));
});

test("two setup tabs: the one that finishes second is told so and changes nothing, not even the security answer", async () => {
  const first = await openOptions(p, "#setup");
  const second = await openOptions(p, "#setup");
  for (const opt of [first, second]) {
    // both get as far as the question, keys ready, nothing written
    await opt.locator("#fr-pw").fill(STRONG);
    await opt.locator("#fr-pw2").fill(STRONG);
    await opt.locator("#fr-next").click();
    await opt.locator("#recovery-saved").check();
    await opt.locator("#recovery-done").click();
  }
  await first.locator("#fr-solo").check();
  await first.locator("#fr-finish").click();
  await expect(first.locator("#fr-hint")).toBeVisible();

  await second.locator("#fr-shared").check();
  await second.locator("#fr-finish").click();
  await expect(second.locator("#fr-changed")).toBeVisible();
  await second.locator("#fr-changed").click();
  await expect(second.locator("#setup")).toHaveCount(0);
  await expect(second.locator("#al-mode")).toHaveValue("idle"); // the first tab's answer stands
  await expect(second.locator("#unlock-pw")).toHaveCount(0); // and its session was not cleared
});

test("below the 50-bit estimate the master password needs 'Use anyway' (OWNER-DECISIONS/15; A1 review F2's rule before)", async () => {
  const opt = await openOptions(p, "#setup");
  await opt.locator("#fr-pw").fill("Password12345!"); // long and varied enough for the floor, about 22 estimated bits
  await opt.locator("#fr-pw2").fill("Password12345!");
  await expect(opt.locator("#fr-strength")).toContainText(/Estimated|估算强度/);
  await expect(opt.locator("#fr-next")).toBeDisabled();
  await opt.locator("#fr-pw2").press("Enter"); // and no way around the button
  await expect(opt.locator("#recovery-code")).toHaveCount(0);
  await expect(opt.locator("#fr-anyway")).toBeVisible();
  await opt.locator("#fr-pw").fill(STRONG);
  await opt.locator("#fr-pw2").fill(STRONG);
  await expect(opt.locator("#fr-anyway")).toHaveCount(0);
  await expect(opt.locator("#fr-next")).toBeEnabled();
});

test("'Start over' needs DELETE typed exactly, and leaving its wizard, even with a code shown, erases nothing", async () => {
  const seed = await openPopup(p);
  await seed.evaluate(() => chrome.storage.local.set({ sk_active: "a", sk_slot_a: { torn: "half a write" } }));
  await seed.close();
  const opt = await openOptions(p, "#advanced");
  const slotA = () => opt.evaluate(async () => (await chrome.storage.local.get("sk_slot_a")).sk_slot_a);
  await expect(opt.locator("#so-go")).toBeDisabled();
  await opt.locator("#so-confirm").fill("delete");
  await expect(opt.locator("#so-go")).toBeDisabled();
  await opt.locator("#so-confirm").fill("DELETE");
  await opt.locator("#so-go").click();
  await expect(opt.locator("#setup")).toContainText(/Nothing is erased until you finish|完成之前不会清除任何数据/);
  await opt.locator("#fr-pw").fill(STRONG);
  await opt.locator("#fr-pw2").fill(STRONG);
  await opt.locator("#fr-next").click();
  await expect(opt.locator("#recovery-code")).toBeVisible();
  expect(await vaultKeys(opt)).toEqual(["sk_active", "sk_slot_a"]);
  expect(await slotA()).toEqual({ torn: "half a write" });
  await opt.locator("#fr-cancel").click();
  await expect(opt.locator("#setup")).toHaveCount(0);
  await expect(opt.getByRole("alert").first()).toContainText(/could not be read|无法读取/);
  expect(await vaultKeys(opt)).toEqual(["sk_active", "sk_slot_a"]);
  expect(await slotA()).toEqual({ torn: "half a write" });
});

test("while a code is on screen and nothing is saved, leaving asks first and the language menu waits", async () => {
  const opt = await openOptions(p, "#setup");
  await expect(opt.locator("#lang-select")).toBeEnabled(); // nothing to lose yet
  await opt.locator("#fr-pw").fill(STRONG);
  await opt.locator("#fr-pw2").fill(STRONG);
  await opt.locator("#fr-next").click();
  await expect(opt.locator("#recovery-code")).toBeVisible();
  await expect(opt.locator("#lang-select")).toBeDisabled(); // switching language reloads the page

  const asked: string[] = [];
  opt.on("dialog", (d) => {
    asked.push(d.type());
    void d.dismiss();
  });
  await opt.close({ runBeforeUnload: true });
  await expect.poll(() => asked).toEqual(["beforeunload"]);
  expect(opt.isClosed()).toBe(false); // the user stayed: same page, same code
  await expect(opt.locator("#recovery-code")).toBeVisible();

  await opt.locator("#recovery-saved").check();
  await opt.locator("#recovery-done").click();
  await opt.locator("#fr-solo").check();
  await opt.locator("#fr-finish").click();
  await expect(opt.locator("#fr-hint")).toBeVisible();
  await expect(opt.locator("#lang-select")).toBeEnabled();
  await opt.close({ runBeforeUnload: true }); // written: nothing left to ask about
  await expect.poll(() => opt.isClosed()).toBe(true);
  expect(asked).toEqual(["beforeunload"]);
});

test("after a restore on a fresh install the page goes straight to the accounts: no second wizard, not even for one frame", async () => {
  const clock = createClock("eeee");
  let v = emptyVault("backup-vault-fr-2");
  const r = parseOtpauth(GITHUB_URI);
  if (!r.ok) throw new Error(r.error);
  v = addEntry(v, r.value, clock).vault;
  const file = writeTmp("backup.json", JSON.stringify(await createBackup(v, STRONG)));
  const opt = await openOptions(p, "#setup-restore");
  await opt.locator("#fr-backup-file").setInputFiles(file);
  await opt.locator("#fr-open-pw").fill(STRONG);
  await opt.getByRole("button", { name: /Open backup|打开备份/ }).click();
  await opt.locator("#fr-restore-next").click();
  await opt.locator("#fr-pw").fill(STRONG);
  await opt.locator("#fr-pw2").fill(STRONG);
  await opt.locator("#fr-next").click();
  await opt.locator("#recovery-saved").check();
  await opt.locator("#recovery-done").click();
  // from here on, a password field appearing again would be a new "create" wizard over the vault just restored
  await opt.evaluate(() => {
    const w = window as unknown as { frAgain: number };
    w.frAgain = 0;
    new MutationObserver(() => {
      if (document.getElementById("fr-pw")) w.frAgain++;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await opt.locator("#fr-solo").check();
  await opt.locator("#fr-finish").click();
  await expect(opt.locator("#fr-hint")).toContainText(/Restored 1|已恢复 1/);
  await expect(opt.locator("#add")).toBeVisible();
  expect(await opt.evaluate(() => (window as unknown as { frAgain: number }).frAgain)).toBe(0);
});
