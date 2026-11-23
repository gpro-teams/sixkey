// The store build's backup from CSB-0 on, from which the Drive backup through the plugin is withdrawn (the
// maintainers' C8): dist/, loaded unpacked as smoke.spec.ts and install-source.spec.ts load it, hides the cloud
// backup's pages and trusts no cloud plugin (that path's code is gone since), so nothing in it leads to the official
// cloud plugin or its store page. First run offers a restore from a file, and from the backup in Chrome's sync storage,
// which took the Drive backup's place; the popup's own 立即备份 opens Settings › Backup, whose card is that backup's, with
// none of Google Drive's words, and its encrypted file restores a new profile from the welcome screen; a downloaded
// cloud backup file chosen there, with no readable vault, restores through first run, its own words throughout and what
// the restore found at its end. From CSB-3
// on (the maintainers' C9) every build hides the Drive path's pages, the e2e build (dist-e2e/) too, which this checks
// as well; the control is then an element of the cloud backup's put into a page, which the same look, with the same
// wait, finds. scripts/check-dist.mjs holds the built files to the same.
import { chromium, expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openBackup } from "../../src/core/backup/backup";
import { makeCloudBackup } from "../../src/core/cloud/format";
import { account, PASSWORD, protectedKeys, seal, vaultOf } from "../helpers/cloud";
import {
  addByPaste,
  close,
  finishWizard,
  GITHUB_URI,
  launch,
  openFold,
  openOptions,
  openPopup,
  type Profile,
  SECRET,
  writeTmp,
} from "./harness";
import { confirmExport, downloadText } from "./export-helpers";

const PROD = resolve(import.meta.dirname, "../../dist");
const FILE_PW = "Lantern#Orbit7!Tulip2$Mesa"; // a file's own password, not the master password
/** Every element of the cloud backup a page of the store build must not show (check-dist's list once, and first run's). */
const CLOUD = [
  "#cloud-card",
  "#ck-restore",
  "#ck-restore-start",
  "#ck-after",
  "#ck-offer",
  "#cloud-pill",
  "#cloud-now",
  "#cloud-problem",
  "#fr-to-cloud",
].join(", ");

async function launchStore(): Promise<Profile> {
  const dir = mkdtempSync(join(tmpdir(), "sixkey-e2e-"));
  // Bundled Chromium only: branded Chrome 137+ ignores --load-extension.
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${PROD}`, `--load-extension=${PROD}`],
    acceptDownloads: true,
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  return { dir, ctx, id: new URL(sw.url()).host };
}

/** How long a page is given for the cloud backup's lazy parts to arrive where a build has them (the control below). */
const SETTLE_MS = 1000;
/** What of the cloud backup a page shows once it has settled. */
async function cloudOn(page: Page): Promise<number> {
  await page.waitForTimeout(SETTLE_MS);
  return page.locator(CLOUD).count();
}
/** A page of the store build, as it settles: nothing of the cloud backup appears, then or a little later. */
async function noCloud(page: Page, where: string): Promise<void> {
  expect(await cloudOn(page), where).toBe(0);
}

const open: Profile[] = [];
test.afterEach(async () => {
  for (const p of open.splice(0)) await close(p);
});

test("store build: no cloud backup anywhere; 立即备份 opens Settings › Backup, whose encrypted file restores a new profile", async () => {
  test.setTimeout(120_000);
  const p = await launchStore();
  open.push(p);
  expect(
    await p.ctx.serviceWorkers()[0]!.evaluate(() => "externally_connectable" in chrome.runtime.getManifest()),
  ).toBe(false);

  // first run: a restore from a file beside the new vault, and from Chrome Sync, no restore from Google Drive; at its
  // end, no offer
  const welcome = await openPopup(p);
  const [setup] = await Promise.all([p.ctx.waitForEvent("page"), welcome.locator("#start-secure").click()]);
  await setup.waitForLoadState();
  await expect(setup.locator("#fr-to-restore")).toBeVisible();
  await expect(setup.locator("#fr-to-csb")).toBeVisible();
  await noCloud(setup, "first run");
  await finishWizard(setup);
  await noCloud(setup, "the end of first run");
  await setup.close();
  await addByPaste(p, GITHUB_URI);

  // the popup: its own pill, and its own 立即备份 (never backed up), to Settings › Backup
  const pop = await openPopup(p);
  await expect(pop.locator(".row", { hasText: "GitHub" })).toHaveCount(1);
  const now = pop.locator(".pf a.bk.old");
  await expect(now).toBeVisible();
  await noCloud(pop, "the popup");
  const [opt] = await Promise.all([p.ctx.waitForEvent("page"), now.click()]);
  await opt.waitForLoadState();
  expect(new URL(opt.url()).hash).toBe("#backup");
  await expect(opt.locator("#export-pw-plain")).toBeVisible(); // unlocked: the plain list's form asks for the master password
  // the backup in Chrome sync's card in its place, off (first run's box was cleared), and none of Google Drive's
  await expect(opt.locator("#csb-card")).toHaveAttribute("data-state", "off");
  await expect(opt.locator("#csb-card")).not.toContainText(/Drive|云端硬盘/);
  await noCloud(opt, "Settings › Backup");

  // the encrypted file
  await openFold(opt, "encrypted");
  await opt.locator("#backup-pw").fill(FILE_PW);
  await opt.locator("#backup-pw2").fill(FILE_PW);
  await confirmExport(opt);
  const text = await downloadText(opt, () => opt.locator("#export-encrypted").click());
  const { vault } = await openBackup(JSON.parse(text), FILE_PW);
  expect(vault.entries.map((e) => e.issuer)).toEqual(["GitHub"]);
  const again = await openPopup(p);
  await expect(again.locator(".row", { hasText: "GitHub" })).toHaveCount(1);
  await expect(again.locator(".pf a.bk.old")).toHaveCount(0); // backed up: no reminder
  await noCloud(again, "the popup after the backup");

  // a new profile: the welcome screen's Restore, the file, its password, then this profile's master password
  const fresh = await launchStore();
  open.push(fresh);
  const w2 = await openPopup(fresh);
  const [o2] = await Promise.all([fresh.ctx.waitForEvent("page"), w2.locator("#start-restore").click()]);
  await o2.waitForLoadState();
  await noCloud(o2, "the restore's first run");
  await o2.locator("#fr-backup-file").setInputFiles(writeTmp("store-backup.json", text));
  await o2.locator("#fr-open-pw").fill(FILE_PW);
  await o2.getByRole("button", { name: /Open backup|打开备份/ }).click();
  await o2.locator("#fr-restore-next").click();
  await finishWizard(o2);
  await expect(o2.locator("#fr-hint")).toContainText(/Restored 1|已恢复 1/);
  await noCloud(o2, "the end of the restore");
  const pop2 = await openPopup(fresh);
  await expect(pop2.locator(".row", { hasText: "GitHub" })).toHaveCount(1);
});

test("store build: a cloud backup file, no readable vault, opened in Settings › Backup, restores through first run", async () => {
  test.setTimeout(120_000);
  // a downloaded cloud backup (sixkey-cloud-backup), opened with the master password it was made under
  const keys = await protectedKeys();
  const backup = await makeCloudBackup(
    await seal(keys, vaultOf(keys.keyring.vaultId, [account("GitHub", SECRET)]), 3),
    "both",
    "x",
  );
  const file = writeTmp("sixkey-cloud-backup.json", JSON.stringify(backup));
  const p = await launchStore();
  open.push(p);
  // data that cannot be read (as firstrun.spec.ts makes it): Settings › Backup is the way out
  const seed = await openPopup(p);
  await seed.evaluate(() => chrome.storage.local.set({ sk_active: "a", sk_slot_a: { torn: "half a write" } }));
  await seed.close();
  const opt = await openOptions(p, "#backup");
  await noCloud(opt, "Settings › Backup with no readable vault");
  await opt.locator("#backup-file").setInputFiles(file);
  await expect(opt.locator("label[for=open-pw]")).not.toContainText(/Drive|云端硬盘|cloud backup/i);
  await opt.locator("#open-pw").fill(PASSWORD);
  await opt.getByRole("button", { name: /Open backup|打开备份/ }).click();
  // first run, on to the profile question: the file's keys as they were, no new password or recovery code
  await expect(opt.locator("#setup")).toBeVisible();
  await expect(opt.locator("#fr-solo")).toBeVisible({ timeout: 20_000 });
  await expect(opt.locator("#fr-pw")).toHaveCount(0);
  await expect(opt.locator(".fr-steps li").first()).toHaveText(/^(Backup file|备份文件)$/); // done: a check, no number
  await noCloud(opt, "first run with the cloud backup file");
  await expect(opt.locator("#open-pw")).toHaveCount(0);
  await opt.locator("#fr-solo").check();
  await opt.locator("#fr-finish").click();
  await expect(opt.locator("#fr-hint")).toContainText(/Restored 1|已恢复 1/);
  // what the restore found and how the backup goes on, in the backup's own words (none of Google Drive's), at its end:
  // the box was left ticked, so it is on
  await expect(opt.locator("#cs-after")).toHaveText(
    /^(Automatic backup to (Chrome Sync|browser sync) is on\.|已开启自动备份到(Chrome |浏览器)同步。)$/,
  );
  await expect(opt.locator("#fr-hint")).not.toContainText(/Drive|云端硬盘/);
  await noCloud(opt, "the end of the cloud backup file's restore");
  const pop = await openPopup(p);
  await expect(pop.locator(".row", { hasText: "GitHub" })).toHaveCount(1);
});

test("the e2e build hides it too since CSB-3; the control: an element of the cloud backup put into a page is found", async () => {
  test.setTimeout(120_000);
  const p = await launch(); // dist-e2e/
  open.push(p);
  const welcome = await openPopup(p);
  const [setup] = await Promise.all([p.ctx.waitForEvent("page"), welcome.locator("#start-secure").click()]);
  await setup.waitForLoadState();
  await noCloud(setup, "the e2e build's first run");
  await finishWizard(setup);
  await noCloud(setup, "the end of the e2e build's first run");
  await setup.close();
  const opt = await openOptions(p, "#backup");
  await noCloud(opt, "the e2e build's Settings › Backup");
  // the same look, with the same wait, is no blind one: the card's element, put in halfway through the wait (not there
  // when it starts), is found
  await opt.evaluate((ms) => {
    setTimeout(() => {
      const card = document.createElement("section");
      card.id = "cloud-card";
      document.body.append(card);
    }, ms);
  }, SETTLE_MS / 2);
  expect(await opt.locator(CLOUD).count(), "not yet").toBe(0);
  expect(await cloudOn(opt), "an element put in halfway").toBe(1);
  await opt.close();
});
