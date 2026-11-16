// Settings > Backup (PHASE0X-PLAN C6; SYNC-DESIGN H2, H3): every export asks for the master password again, and
// "Export selected accounts" makes a file with only the chosen accounts, which restores a new profile or imports into one.
import { expect, test, type Page } from "@playwright/test";
import { openBackup } from "../../src/core/backup/backup";
import {
  addByPaste,
  AWS_URI,
  close,
  finishWizard,
  GITHUB_URI,
  launch,
  openFold,
  openOptions,
  openPopup,
  type Profile,
  SECRET,
  seedLegacyDeviceVault,
  showSection,
  startFresh,
  STRONG,
  writeTmp,
} from "./harness";
import { confirmExport, countDownloads, downloadText, editInPopup, securityKinds, vaultIdOf } from "./export-helpers";

const DROPBOX_URI = "otpauth://totp/Dropbox:me@example.com?secret=MFRGGZDFMZTWQ2LK&issuer=Dropbox";
const FILE_PW = "Lantern#Orbit7!Tulip2$Mesa"; // a file's own password, not the master password
const BUTTONS = ["#export-encrypted", "#export-plain", "#export-subset"] as const;
const failures = async (page: Page) => (await securityKinds(page)).filter((k) => k === "unlock_failed").length;

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

/** Everything each export needs except the master password. */
async function fillAllButTheMasterPassword(opt: Page) {
  await openFold(opt, "encrypted"); // one line until opened, as the selected accounts' box (BACKUP-VISUAL)
  await opt.locator("#backup-pw").fill(FILE_PW);
  await opt.locator("#backup-pw2").fill(FILE_PW);
  await opt.locator("#plain-ok").check();
  await opt.locator(".sub-item", { hasText: "GitHub" }).locator("input").check();
  await openFold(opt, "subset");
  await opt.locator("#subset-pw").fill(FILE_PW);
  await opt.locator("#subset-pw2").fill(FILE_PW);
}

test("every export asks for the master password: none without it, a wrong one is refused and recorded, each export asks again", async () => {
  await startFresh(p);
  await addByPaste(p, `${GITHUB_URI}\n${AWS_URI}`);
  const opt = await openOptions(p, "#backup");
  await openFold(opt, "subset");
  await showSection(opt, "security");
  await expect(opt.locator("#sm-export")).toContainText(/master password|主密码/); // Security mode: always on, part of neither mode
  await showSection(opt, "backup");
  await openFold(opt, "subset");
  const downloads = countDownloads(opt);

  // unlocked, every other field filled: still no export until the master password is typed again
  await fillAllButTheMasterPassword(opt);
  await expect(opt.locator("#export-pw")).toHaveValue("");
  for (const b of BUTTONS) await expect(opt.locator(b), b).toBeDisabled();
  await opt.locator("#backup-pw2").press("Enter"); // nor by Enter in a form (a disabled submit button blocks it)
  await opt.locator("#subset-pw2").press("Enter");
  await opt.waitForTimeout(300);
  await expect(opt.locator("#backup-error")).toHaveCount(0); // and nothing typed is not a guess: nothing recorded
  expect(await failures(opt)).toBe(0);

  // a wrong one, on each of the three: refused, nothing saved, one more wrong password in the security log
  let failed = 0;
  for (const b of BUTTONS) {
    await confirmExport(opt, "not my master password 42");
    await expect(opt.locator(b), b).toBeEnabled();
    await opt.locator(b).click();
    await expect(opt.locator("#backup-error"), b).toContainText(/Wrong password|密码错误/);
    failed++;
    await expect.poll(() => failures(opt), { message: b }).toBe(failed);
    await expect(opt.locator("#export-pw")).toHaveValue(""); // emptied: the next try is typed again
    await expect(opt.locator("#export-pw")).toBeFocused();
    await expect(opt.locator(b)).toBeDisabled();
  }
  expect(downloads.n).toBe(0);
  expect((await securityKinds(opt)).filter((k) => k.startsWith("export_"))).toEqual([]);

  // the right one: the file is saved and the export recorded; then the field is empty again and nothing can be exported
  for (const [b, kind] of [
    ["#export-encrypted", "export_encrypted"],
    ["#export-plain", "export_plain"],
    ["#export-subset", "export_subset"],
  ] as const) {
    await fillAllButTheMasterPassword(opt);
    await confirmExport(opt);
    const text = await downloadText(opt, () => opt.locator(b).click());
    expect(text.length, b).toBeGreaterThan(10);
    await expect(opt.locator("#backup-msg")).toBeVisible();
    await expect.poll(() => securityKinds(opt), { message: b }).toContain(kind);
    await expect(opt.locator("#export-pw")).toHaveValue("");
    for (const x of BUTTONS) {
      // the selected-accounts box closes itself after its own export (and drops its file password): opened again, its
      // button is disabled like the others
      if (x === "#export-subset") await openFold(opt, "subset");
      await expect(opt.locator(x), `${x} after ${b}`).toBeDisabled();
    }
  }
  expect(downloads.n).toBe(3);
  expect((await securityKinds(opt)).filter((k) => k.startsWith("export_"))).toEqual([
    "export_encrypted",
    "export_plain",
    "export_subset",
  ]);
  expect(await failures(opt)).toBe(failed); // the right password counts for nothing
});

test("export selected accounts: by group or one by one, only those are in the file, which restores a new profile and imports into a vault", async () => {
  test.setTimeout(150_000);
  await startFresh(p);
  await addByPaste(p, `${GITHUB_URI}\n${AWS_URI}\n${DROPBOX_URI}`);
  for (const name of ["GitHub", "Dropbox"]) await editInPopup(p, name, { group: "Shared" });

  const opt = await openOptions(p, "#backup");
  await openFold(opt, "subset");
  const source = await vaultIdOf(opt);
  await expect(opt.locator("#sub-count")).toHaveText(/0 of 3|已选 0 \/ 3/);
  await expect(opt.locator("#sub-preview")).toHaveCount(0);
  // the whole group; one account out of it (the group shows "some"), and back in
  const group = opt.locator(".sub-g", { hasText: "Shared" }).locator("input");
  await group.check();
  await expect(opt.locator("#sub-count")).toHaveText(/2 of 3|已选 2 \/ 3/);
  await opt.locator(".sub-item", { hasText: "Dropbox" }).locator("input").uncheck();
  await expect(group).toHaveJSProperty("indeterminate", true);
  await expect(opt.locator("#sub-count")).toHaveText(/1 of 3|已选 1 \/ 3/);
  await opt.locator(".sub-item", { hasText: "Dropbox" }).locator("input").check();
  await expect(group).toBeChecked();
  // the preview: those two, by name only
  const preview = opt.locator("#sub-preview");
  await expect(preview).toContainText(/only these 2 account|文件里只有这 2 个账户/);
  await expect(preview).toContainText("GitHub");
  await expect(preview).toContainText("Dropbox");
  await expect(preview).not.toContainText("AWS");
  await expect(preview).not.toContainText("MFRGGZDF");

  // the file's password is not the master password: whoever opens the file learns it
  await openFold(opt, "subset");
  await opt.locator("#subset-pw").fill(STRONG);
  await opt.locator("#subset-pw2").fill(STRONG);
  await confirmExport(opt);
  await expect(opt.locator("#subset-same")).toBeVisible();
  await expect(opt.locator("#export-subset")).toBeDisabled();
  await openFold(opt, "subset");
  await opt.locator("#subset-pw").fill(FILE_PW);
  await opt.locator("#subset-pw2").fill(FILE_PW);
  await expect(opt.locator("#export-subset")).toHaveText(/Save 2 account|保存这 2 个账户/);
  const text = await downloadText(opt, () => opt.locator("#export-subset").click());
  await expect(opt.locator("#backup-msg")).toContainText(/2 account|2 个账户/);

  // a standard backup file, and it opens to exactly the two, in a new vault. (The raw text is ciphertext, so that scan
  // only shows nothing is outside it; the checks on the opened vault are the ones that count.)
  const raw = JSON.parse(text) as Record<string, unknown>;
  expect(Object.keys(raw).sort()).toEqual(["app", "ciphertext", "created", "format", "iv", "kdf", "v"]);
  expect(raw).toMatchObject({ format: "sixkey-backup", v: 1 });
  for (const x of ["GitHub", "Dropbox", "AWS", "Shared", SECRET, "JBSWY3DPEHPK3PXP", "MFRGGZDFMZTWQ2LK", source])
    expect(text).not.toContain(x);
  const { vault } = await openBackup(raw, FILE_PW);
  expect(vault.vaultId).not.toBe(source);
  expect(vault.entries.map((e) => e.issuer).sort()).toEqual(["Dropbox", "GitHub"]);
  expect(vault.entries.map((e) => e.group)).toEqual(["Shared", "Shared"]);
  expect(JSON.stringify(vault)).not.toContain("JBSWY3DPEHPK3PXP");
  // a few accounts are not a backup: "Last backup" stays as it was (never)
  expect(
    await opt.evaluate(async () => (await chrome.storage.local.get("sk_last_backup")).sk_last_backup ?? null),
  ).toBeNull();
  const file = writeTmp("selected.json", text);

  // a new profile: Restore on the welcome screen, then the first run asks for that profile's own master password
  const fresh = await launch();
  try {
    const welcome = await openPopup(fresh);
    const [o2] = await Promise.all([fresh.ctx.waitForEvent("page"), welcome.locator("#start-restore").click()]);
    await o2.waitForLoadState();
    await o2.locator("#fr-backup-file").setInputFiles(file);
    await o2.locator("#fr-open-pw").fill(FILE_PW);
    await o2.getByRole("button", { name: /Open backup|打开备份/ }).click();
    await o2.locator("#fr-restore-next").click();
    await finishWizard(o2);
    await expect(o2.locator("#fr-hint")).toContainText(/Restored 2|已恢复 2/);
    const pop2 = await openPopup(fresh);
    await expect(pop2.locator(".row")).toHaveCount(2);
    await expect(pop2.locator(".row", { hasText: "AWS" })).toHaveCount(0);
    expect(await vaultIdOf(pop2)).toBe(vault.vaultId);
  } finally {
    await close(fresh);
  }

  // a profile that has a vault already: Import adds the two next to what is there
  const other = await launch();
  try {
    await startFresh(other);
    await addByPaste(other, AWS_URI);
    const o3 = await openOptions(other, "#backup");
    await o3.locator("#backup-file").setInputFiles(file);
    await o3.locator("#open-pw").fill(FILE_PW);
    await o3.getByRole("button", { name: /Open backup|打开备份/ }).click();
    await o3.locator("#apply-backup").click();
    await expect(o3.locator("#backup-msg")).toContainText(/Added 2|已添加 2/);
    const pop3 = await openPopup(other);
    await expect(pop3.locator(".row")).toHaveCount(3);
  } finally {
    await close(other);
  }
});

test("a vault without a master password (Phase 0) warns, then exports without asking for one", async () => {
  await seedLegacyDeviceVault(p, [GITHUB_URI, AWS_URI]);
  const opt = await openOptions(p, "#backup");
  await openFold(opt, "subset");
  await expect(opt.locator("#export-nopw")).toBeVisible();
  await expect(opt.locator("#export-pw")).toHaveCount(0);
  await opt.locator("#plain-ok").check();
  const text = await downloadText(opt, () => opt.locator("#export-plain").click());
  expect(text.split("\n").filter(Boolean)).toHaveLength(2);
  await opt.locator(".sub-item", { hasText: "AWS" }).locator("input").check();
  await openFold(opt, "subset");
  await opt.locator("#subset-pw").fill(FILE_PW);
  await opt.locator("#subset-pw2").fill(FILE_PW);
  const sub = await downloadText(opt, () => opt.locator("#export-subset").click());
  expect((await openBackup(JSON.parse(sub), FILE_PW)).vault.entries.map((e) => e.issuer)).toEqual(["AWS"]);
  await expect.poll(() => securityKinds(opt)).toEqual(["export_plain", "export_subset"]);
});

// ---- the rest of H3, from the review (docs/audit/internal-reviews/C6-REVIEW.md, C6-3 and C6-4 to C6-6) --------------------------

const WRONG = "Wrong#Guess9!Zebra4$Pine";
const fullWidth = (s: string) =>
  [...s].map((c) => (c >= "!" && c <= "~" ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c)).join("");

test("a device-key page whose vault got a master password from another page meanwhile exports nothing, then asks", async () => {
  await seedLegacyDeviceVault(p, [GITHUB_URI, AWS_URI]);
  const stale = await openOptions(p, "#backup");
  await expect(stale.locator("#export-nopw")).toBeVisible();
  const downloads = countDownloads(stale);
  const other = await openOptions(p, "#security");
  await other.locator("#enable-pw").fill(STRONG);
  await other.locator("#enable-pw2").fill(STRONG);
  await other.locator("#enable-password").click();
  await expect(other.locator("#recovery-code")).toBeVisible();
  // the stale page still shows no password field
  await stale.locator("#plain-ok").check();
  await stale.locator("#export-plain").click();
  await expect(stale.locator("#export-pw")).toBeVisible(); // reloaded: it asks now
  expect(downloads.n).toBe(0);
  expect((await securityKinds(stale)).filter((k) => k.startsWith("export_"))).toEqual([]);
  expect(await failures(stale)).toBe(0);
});

test("the master password, right or wrong, lands nowhere: storage, page storage, the page, the URL, diagnostics", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const opt = await openOptions(p, "#backup");
  await openFold(opt, "subset");
  await confirmExport(opt, WRONG);
  await opt.locator("#plain-ok").check();
  await opt.locator("#export-plain").click();
  await expect(opt.locator("#backup-error")).toBeVisible();
  await confirmExport(opt);
  expect(await opt.locator("#export-pw").getAttribute("value")).toBeNull(); // a property, never an attribute
  await downloadText(opt, () => opt.locator("#export-plain").click());
  const dump = await opt.evaluate(async () =>
    JSON.stringify({
      local: await chrome.storage.local.get(null),
      session: await chrome.storage.session.get(null).catch(() => ({})),
      ls: { ...localStorage },
      ss: { ...sessionStorage },
      url: location.href,
      html: document.documentElement.outerHTML,
    }),
  );
  for (const s of [STRONG, WRONG]) expect(dump).not.toContain(s);
  const misc = await openOptions(p, "#advanced");
  const diag = await downloadText(misc, () =>
    misc.getByRole("button", { name: /Save diagnostics|保存诊断信息/ }).click(),
  );
  expect(diag.length).toBeGreaterThan(10);
  for (const s of [STRONG, WRONG, "GitHub", SECRET]) expect(diag).not.toContain(s);
});

test("one export at a time: clicks queued in one task run one check, one file, one record", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const opt = await openOptions(p, "#backup");
  await openFold(opt, "subset");
  const downloads = countDownloads(opt);
  const thrice = () =>
    opt.evaluate(() => {
      const b = document.querySelector<HTMLButtonElement>("#export-plain")!;
      b.click();
      b.click();
      b.click();
    });
  await opt.locator("#plain-ok").check();
  await confirmExport(opt, WRONG);
  await thrice();
  await expect(opt.locator("#backup-error")).toBeVisible();
  await opt.waitForTimeout(800);
  expect(await failures(opt)).toBe(1); // one wrong password, counted once
  await confirmExport(opt);
  await thrice();
  await expect(opt.locator("#backup-msg")).toBeVisible();
  await opt.waitForTimeout(800);
  expect(downloads.n).toBe(1);
  expect((await securityKinds(opt)).filter((k) => k === "export_plain")).toHaveLength(1);
  // a real double click: two tasks, the second lands on a disabled button
  await confirmExport(opt);
  await opt.locator("#plain-ok").check();
  await opt.locator("#export-plain").dblclick();
  await opt.waitForTimeout(800);
  expect(downloads.n).toBe(2);
  expect((await securityKinds(opt)).filter((k) => k === "export_plain")).toHaveLength(2);
});

test("Enter cannot submit what the button refuses: the file password is the master password (also full-width), or the two differ", async () => {
  await startFresh(p);
  await addByPaste(p, `${GITHUB_URI}\n${AWS_URI}`);
  const opt = await openOptions(p, "#backup");
  await openFold(opt, "subset");
  const downloads = countDownloads(opt);
  await opt.evaluate(() => {
    (window as unknown as { submits: number }).submits = 0;
    document.addEventListener(
      "submit",
      () => {
        (window as unknown as { submits: number }).submits++;
      },
      true,
    );
  });
  const submits = () => opt.evaluate(() => (window as unknown as { submits: number }).submits);
  await opt.locator(".sub-item", { hasText: "GitHub" }).locator("input").check();
  for (const same of [STRONG, fullWidth(STRONG)]) {
    await confirmExport(opt);
    await openFold(opt, "subset");
    await opt.locator("#subset-pw").fill(same);
    await opt.locator("#subset-pw2").fill(same);
    await expect(opt.locator("#subset-same")).toBeVisible(); // NFKC: the full-width spelling is the same password
    await expect(opt.locator("#export-subset")).toBeDisabled();
    await opt.locator("#subset-pw2").press("Enter");
  }
  await openFold(opt, "encrypted");
  await opt.locator("#backup-pw").fill(FILE_PW);
  await opt.locator("#backup-pw2").fill(`${FILE_PW}x`);
  await expect(opt.locator("#export-encrypted")).toBeDisabled();
  await opt.locator("#backup-pw2").press("Enter");
  await opt.waitForTimeout(500);
  // a disabled submit button stops implicit submission: no submit event at all, so the handlers' own checks are a
  // second guard only
  expect(await submits()).toBe(0);
  expect(downloads.n).toBe(0);
  expect(await failures(opt)).toBe(0);
  // with the button enabled, Enter does submit (the measurement above means something)
  await opt.locator("#backup-pw2").fill(FILE_PW);
  await expect(opt.locator("#export-encrypted")).toBeEnabled();
  await downloadText(opt, () => opt.locator("#backup-pw2").press("Enter"));
  expect(await submits()).toBe(1);
});

test("a typed master password does not wait in the field: emptied after a minute idle, when the tab is hidden, and on a lock", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const opt = await p.ctx.newPage();
  await opt.clock.install();
  await opt.goto(`chrome-extension://${p.id}/options/index.html#backup`);
  // a minute without typing; typing again starts the minute again (runFor: every timer in between fires in order)
  await expect(opt.locator("#export-pw")).toBeVisible();
  await confirmExport(opt);
  await opt.clock.runFor(40_000);
  await confirmExport(opt, `${STRONG}!`);
  await opt.clock.runFor(40_000);
  await expect(opt.locator("#export-pw")).toHaveValue(`${STRONG}!`);
  await opt.clock.runFor(25_000);
  await expect(opt.locator("#export-pw")).toHaveValue("");
  // the tab is hidden
  await confirmExport(opt);
  await opt.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });
  await expect(opt.locator("#export-pw")).toHaveValue("");
  // Sixkey is locked from the popup (this page is not reloaded: it learns of the lock from session storage). The field
  // goes with the rest of the unlocked page, often before a test can read it (reading it then was a race); unlocked
  // again on this page, it is back and empty.
  await confirmExport(opt);
  const pop = await openPopup(p);
  await pop.getByRole("button", { name: /^(Lock|锁定)$/ }).click();
  await expect(opt.locator("#unlock-pw")).toBeVisible();
  await expect(opt.locator("#export-pw")).toHaveCount(0);
  await opt.locator("#unlock-pw").fill(STRONG);
  await opt.locator("#unlock-btn").click();
  await expect(opt.locator("#export-pw")).toBeVisible();
  await expect(opt.locator("#export-pw")).toHaveValue("");
});

// KNOWN OPEN: C6-REVIEW C6-1 (High), not C6's to fix. Settings › Security › "Create new recovery code" asks for no
// password, so someone at the unlocked browser makes a code, locks, resets the master password with it, and exports
// every seed with their own password. The fix (a master password for a new recovery code: VaultService.newRecoveryCode
// and Security.tsx) lands after A4. Until then this test fails, so it is marked test.fail(); once the fix is in it
// passes, test.fail() reports that, and the marker is to be removed.
test("C6-1: no export of every seed without the master password, by way of a new recovery code", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const sec = await openOptions(p, "#security-keys");
  await openFold(sec, "fold-code");
  // with the fix, the button asks for the master password first (disabled, or an error), and no code is shown
  const minted = await sec
    .getByRole("button", { name: /Create new recovery key|生成新的恢复密钥/ })
    .click({ timeout: 3000 })
    .then(() => sec.locator("#recovery-code").waitFor({ timeout: 3000 }))
    .then(
      () => true,
      () => false,
    );
  expect(minted).toBe(false); // the rest of the way (reset, export) is closed at this step: test/e2e/reset.spec.ts
});
