// Settings > Backup > Export selected accounts when other pages change the vault (PHASE0X-PLAN C6, SYNC-DESIGN H2;
// docs/audit/internal-reviews/C6-REVIEW.md C6-2, C6-3, C6-7): the file holds exactly the accounts the page lists as ticked, as the page shows
// them, and nothing if any of them changed meanwhile. The picker offers live accounts only.
import { expect, test, type Page } from "@playwright/test";
import { openBackup } from "../../src/core/backup/backup";
import {
  addByPaste,
  AWS_URI,
  close,
  GITHUB_URI,
  launch,
  openFold,
  openOptions,
  type Profile,
  startFresh,
} from "./harness";
import {
  confirmExport,
  countDownloads,
  downloadText,
  editInPopup,
  securityKinds,
  trashInPopup,
} from "./export-helpers";

const FILE_PW = "Lantern#Orbit7!Tulip2$Mesa";
const exports = async (page: Page) => (await securityKinds(page)).filter((k) => k.startsWith("export_"));

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

async function tick(opt: Page, ...issuers: string[]) {
  for (const i of issuers) await opt.locator(".sub-item", { hasText: i }).locator("input").check();
}
async function readyToSave(opt: Page) {
  await confirmExport(opt);
  await openFold(opt, "subset");
  await opt.locator("#subset-pw").fill(FILE_PW);
  await opt.locator("#subset-pw2").fill(FILE_PW);
}
const opened = async (text: string) => (await openBackup(JSON.parse(text), FILE_PW)).vault;

test("a ticked account deleted in another page: nothing is saved, the page shows the change, and the next try holds the rest", async () => {
  await startFresh(p);
  await addByPaste(p, `${GITHUB_URI}\n${AWS_URI}`);
  const opt = await openOptions(p, "#backup");
  await openFold(opt, "subset");
  const downloads = countDownloads(opt);
  await tick(opt, "GitHub", "AWS");
  await trashInPopup(p, "AWS");
  await readyToSave(opt);
  await expect(opt.locator("#export-subset")).toHaveText(/Save 2 account/); // this page has not seen the change yet
  await opt.locator("#export-subset").click();
  await expect(opt.locator("#backup-error")).toContainText(/changed in another page|已在其他页面中被更改/);
  expect(downloads.n).toBe(0);
  expect(await exports(opt)).toEqual([]);
  // reloaded: AWS is gone from the list and from the selection
  await expect(opt.locator(".sub-item", { hasText: "AWS" })).toHaveCount(0);
  await expect(opt.locator("#sub-count")).toHaveText(/1 of 1|已选 1 \/ 1/);
  await readyToSave(opt);
  const vault = await opened(await downloadText(opt, () => opt.locator("#export-subset").click()));
  expect(vault.entries.map((e) => e.issuer)).toEqual(["GitHub"]);
  await expect(opt.locator("#backup-msg")).toContainText(/1 account|1 个账户/);
});

test("a ticked account renamed or regrouped in another page: nothing is saved until the page shows the new name and group", async () => {
  await startFresh(p);
  await addByPaste(p, `${GITHUB_URI}\n${AWS_URI}`);
  const opt = await openOptions(p, "#backup");
  await openFold(opt, "subset");
  const downloads = countDownloads(opt);
  await tick(opt, "GitHub");
  await editInPopup(p, "GitHub", { issuer: "GitHub Work", group: "Secret team" });
  await readyToSave(opt);
  await opt.locator("#export-subset").click();
  await expect(opt.locator("#backup-error")).toContainText(/changed in another page|已在其他页面中被更改/);
  expect(downloads.n).toBe(0);
  // now shown, still ticked, and saved as shown
  await expect(opt.locator("#sub-preview")).toContainText("GitHub Work");
  await expect(opt.locator("#sub-preview")).toContainText("Secret team");
  await readyToSave(opt);
  const vault = await opened(await downloadText(opt, () => opt.locator("#export-subset").click()));
  expect(vault.entries.map((e) => [e.issuer, e.group])).toEqual([["GitHub Work", "Secret team"]]);
});

test("the file never holds an account this page no longer lists: ticked, trashed elsewhere, page reloads, restored elsewhere", async () => {
  await startFresh(p);
  await addByPaste(p, `${GITHUB_URI}\n${AWS_URI}`);
  const opt = await openOptions(p, "#backup");
  await openFold(opt, "subset");
  await tick(opt, "GitHub", "AWS");
  await trashInPopup(p, "AWS");
  // this page reloads for its own reason, without leaving Backup (a refused export reloads it, C6-2): AWS leaves the
  // list, and the selection (C6-3)
  await readyToSave(opt);
  await opt.locator("#export-subset").click();
  await expect(opt.locator("#backup-error")).toContainText(/changed in another page|已在其他页面中被更改/);
  await expect(opt.locator(".sub-item", { hasText: "AWS" })).toHaveCount(0);
  await expect(opt.locator("#sub-count")).toHaveText(/1 of 1|已选 1 \/ 1/);
  // a third page restores AWS from the trash; this page is not reloaded and still lists GitHub only
  const o2 = await openOptions(p, "#trash");
  await o2
    .locator("#trash tr", { hasText: "AWS" })
    .getByRole("button", { name: /^(Restore|恢复)$/ })
    .click();
  await expect(o2.locator("#trash tr", { hasText: "AWS" })).toHaveCount(0);
  await expect(opt.locator("#sub-preview li")).toHaveCount(1);
  await readyToSave(opt);
  await expect(opt.locator("#export-subset")).toHaveText(/Save 1 account/);
  const vault = await opened(await downloadText(opt, () => opt.locator("#export-subset").click()));
  expect(vault.entries.map((e) => e.issuer)).toEqual(["GitHub"]);
  await expect(opt.locator("#backup-msg")).toContainText(/1 account|1 个账户/);
  // the next reload (another refused export, GitHub having changed elsewhere) lists AWS again, not ticked: it left the
  // selection when it left the list
  await editInPopup(p, "GitHub", { group: "Moved" });
  await readyToSave(opt);
  await opt.locator("#export-subset").click();
  await expect(opt.locator("#backup-error")).toContainText(/changed in another page|已在其他页面中被更改/);
  await expect(opt.locator(".sub-item", { hasText: "AWS" })).toHaveCount(1);
  await expect(opt.locator(".sub-item", { hasText: "AWS" }).locator("input")).not.toBeChecked();
});

test("the picker offers live accounts only: one in the trash is not listed, ticked by its group, or counted", async () => {
  await startFresh(p);
  await addByPaste(p, `${GITHUB_URI}\n${AWS_URI}`);
  await editInPopup(p, "AWS", { group: "Shared" });
  await editInPopup(p, "GitHub", { group: "Shared" });
  await trashInPopup(p, "AWS");
  const opt = await openOptions(p, "#backup");
  await openFold(opt, "subset");
  await expect(opt.locator("#sub-list")).not.toContainText("AWS");
  await expect(opt.locator("#sub-count")).toHaveText(/0 of 1|已选 0 \/ 1/);
  await opt.locator(".sub-g", { hasText: "Shared" }).locator("input").check();
  await expect(opt.locator("#sub-count")).toHaveText(/1 of 1|已选 1 \/ 1/);
});

test("a selection that is gone by export time: an error, no file, and no export recorded", async () => {
  await startFresh(p);
  await addByPaste(p, `${GITHUB_URI}\n${AWS_URI}`);
  const opt = await openOptions(p, "#backup");
  await openFold(opt, "subset");
  const downloads = countDownloads(opt);
  await tick(opt, "AWS");
  await trashInPopup(p, "AWS");
  await readyToSave(opt);
  await opt.locator("#export-subset").click();
  await expect(opt.locator("#backup-error")).toBeVisible();
  await opt.waitForTimeout(500);
  expect(downloads.n).toBe(0);
  expect(await exports(opt)).toEqual([]);
  await expect(opt.locator("#export-subset")).toBeDisabled(); // nothing is ticked any more
});

test("the preview shows all that goes with each account except its key: name, account, group and remembered sites", async () => {
  await startFresh(p);
  await addByPaste(p, `${GITHUB_URI}\n${AWS_URI}`);
  await editInPopup(p, "GitHub", { group: "Shared", site: "admin.corp.example" });
  const opt = await openOptions(p, "#backup");
  await openFold(opt, "subset");
  await tick(opt, "GitHub");
  const preview = opt.locator("#sub-preview");
  await expect(preview).toContainText("alice@example.com");
  await expect(preview).toContainText(/Group: Shared|分组: Shared/);
  await expect(preview).toContainText(/Sites: admin\.corp\.example|网站: admin\.corp\.example/);
  await readyToSave(opt);
  const vault = await opened(await downloadText(opt, () => opt.locator("#export-subset").click()));
  expect(vault.entries.map((e) => [e.issuer, e.group, e.domains])).toEqual([
    ["GitHub", "Shared", ["admin.corp.example"]],
  ]);
});
