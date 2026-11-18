// Settings › Accounts › Groups (the owner's report of 2026-11-18: 57 accounts, a group set one at a time): accounts found
// by a search and ticked (ticks outside the search stay), moved into a new group in one go; the popup shows the group as
// its own section, last. Then the accounts are taken out of it again.
import { expect, test } from "@playwright/test";
import { addByPaste, close, launch, openOptions, openPopup, startFresh, type Profile } from "./harness";

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

const uri = (issuer: string, label: string, secret: string) =>
  `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}`;
const PASTE = [
  uri("OldShop", "a", "JBSWY3DPEHPK3PXA"),
  uri("GitHub", "me", "JBSWY3DPEHPK3PXB"),
  uri("OldForum", "b", "JBSWY3DPEHPK3PXC"),
  uri("AWS", "root", "JBSWY3DPEHPK3PXD"),
].join("\n");

test("accounts ticked across searches move into a new group in one go, which the popup shows last; then out again", async () => {
  test.setTimeout(120_000);
  await startFresh(p);
  await addByPaste(p, PASTE);
  const opt = await openOptions(p, "#groups");
  await expect(opt.locator("#groups .sub-item")).toHaveCount(4);
  // one search, a tick; another search, another tick: both stay ticked
  await opt.locator("#groups-q").fill("oldshop");
  await expect(opt.locator("#groups .sub-item")).toHaveCount(1);
  await opt.locator(".sub-item", { hasText: "OldShop" }).locator("input").check();
  await opt.locator("#groups-q").fill("forum");
  await opt.locator(".sub-item", { hasText: "OldForum" }).locator("input").check();
  await opt.locator("#groups-q").fill("");
  await expect(opt.locator("#groups .sub-item input:checked")).toHaveCount(2);
  await expect(opt.locator("#sub-preview")).toHaveCount(0); // the export's preview is not here
  await expect(opt.locator("#groups-move")).toBeDisabled(); // no group named yet
  await opt.locator("#groups-name").fill("Old");
  await expect(opt.locator("#groups-move")).toHaveText("Move 2 to this group");
  await opt.locator("#groups-move").click();
  await expect(opt.locator("#groups-done")).toHaveText("Moved 2 account(s) to Old.");
  await expect(opt.locator("#groups .sub-item input:checked")).toHaveCount(0);
  await expect(opt.locator("#groups .sub-group legend b")).toHaveText([/^accounts$/i, "Old"]);

  // the popup: the others first, then the new group as its own section
  const pop = await openPopup(p);
  await expect(pop.locator(".sect .glabel b")).toHaveText([/^accounts$/i, "Old"]);
  await expect(pop.locator(".sect").last().locator(".who b")).toHaveText(["OldShop", "OldForum"]);
  await pop.close();

  // out of the group again: one section, nothing labelled
  await opt.locator(".sub-group", { hasText: "Old" }).locator("legend input").check();
  await opt.locator("#groups-clear").click();
  await expect(opt.locator("#groups-done")).toHaveText("Took 2 account(s) out of their groups.");
  const pop2 = await openPopup(p);
  await expect(pop2.locator(".row")).toHaveCount(4);
  await expect(pop2.locator(".sect .glabel")).toHaveCount(0);
});

test("the popup groups by name in one click, while there is something to group and no search; and undoes it", async () => {
  test.setTimeout(120_000);
  await startFresh(p);
  await addByPaste(
    p,
    [
      uri("Sharelife", "admin", "JBSWY3DPEHPK3PXA"),
      uri("CSLink", "N1", "JBSWY3DPEHPK3PXB"),
      uri("Sharelife", "admin2", "JBSWY3DPEHPK3PXC"),
      uri("GitHub", "me", "JBSWY3DPEHPK3PXD"),
      uri("CSLink", "N2", "JBSWY3DPEHPK3PXE"),
    ].join("\n"),
  );
  const pop = await openPopup(p);
  await expect(pop.locator(".row")).toHaveCount(5);
  await expect(pop.locator(".sect .glabel")).toHaveCount(0);
  await expect(pop.locator("#auto-group")).toHaveText("Group");
  // a search hides it
  await pop.locator("#q").fill("git");
  await expect(pop.locator("#auto-group")).toHaveCount(0);
  await pop.locator("#q").fill("");
  await pop.locator("#auto-group").click();
  await expect(pop.locator(".toast")).toHaveText("4 accounts in 2 groups");
  await expect(pop.locator(".sect .glabel b")).toHaveText(["Sharelife", "CSLink", /^accounts$/i]);
  await expect(pop.locator("#auto-group")).toHaveCount(0);
  // undone: no groups again, and the offer is back
  await pop.locator("#auto-undo").click();
  await expect(pop.locator(".sect .glabel")).toHaveCount(0);
  await expect(pop.locator("#auto-undo")).toHaveCount(0);
  await expect(pop.locator("#auto-group")).toBeVisible();
  // done again and the popup opened anew: grouped, nothing more to offer
  await pop.locator("#auto-group").click();
  await expect(pop.locator(".sect .glabel b")).toHaveText(["Sharelife", "CSLink", /^accounts$/i]);
  await pop.close();
  const again = await openPopup(p);
  await expect(again.locator(".sect .glabel b")).toHaveText(["Sharelife", "CSLink", /^accounts$/i]);
  await expect(again.locator("#auto-group, #auto-undo")).toHaveCount(0);
});

test("two accounts of the same name are marked with their number; a note tells them apart, is shown and searched", async () => {
  test.setTimeout(120_000);
  await startFresh(p);
  await addByPaste(
    p,
    [
      uri("NbdPay OTC", "admin", "JBSWY3DPEHPK3PXA"),
      uri("NbdPay OTC", "M10001", "JBSWY3DPEHPK3PXB"),
      uri("NbdPay OTC", "admin", "JBSWY3DPEHPK3PXC"),
    ].join("\n"),
  );
  const pop = await openPopup(p);
  await expect(pop.locator(".row")).toHaveCount(3);
  await expect(pop.locator(".row .who .dup")).toHaveText(["Same name 1", "Same name 2"]);
  // side by side, in one frame: the two "admin" first, then M10001
  await expect(pop.locator(".row .who i")).toHaveText(["adminSame name 1", "adminSame name 2", "M10001"]);
  await expect(pop.locator(".dupset")).toHaveCount(1);
  await expect(pop.locator(".dupset .row")).toHaveCount(2);
  await expect(pop.locator(".dupset .dupcap")).toHaveText("Same name · 2 accounts");
  // the second "admin": a note, from the edit sheet
  await pop.locator(".row").nth(1).locator(".more").click();
  await pop.locator("#e-note").fill("Shop B");
  await pop.getByRole("button", { name: /^(Save|保存)$/ }).click();
  await expect(pop.locator(".dialog")).toHaveCount(0);
  await expect(pop.locator(".row").nth(1).locator(".who i")).toHaveText("adminShop BSame name 2");
  await pop.locator("#q").fill("shop b");
  await expect(pop.locator(".row")).toHaveCount(1);
  await pop.close();
  const again = await openPopup(p);
  await expect(again.locator(".row .who .memo")).toHaveText(["Shop B"]);
});
