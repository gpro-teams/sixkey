import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { openBackup } from "../../src/core/backup/backup";
import {
  acceptable,
  addByPaste,
  AWS_URI,
  close,
  digitsOf,
  finishWizard,
  GITHUB_URI,
  launch,
  openFold,
  openOptions,
  openPopup,
  qrPng,
  SECRET,
  seedLegacyDeviceVault,
  startFresh,
  STRONG,
  writeTmp,
  type Profile,
} from "./harness";
import { confirmExport } from "./export-helpers";

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

test("first run, add by paste, the code is right, copy and keyboard work", async () => {
  await startFresh(p);
  await addByPaste(p, `${GITHUB_URI}\n${AWS_URI}`);

  const pop = await openPopup(p);
  await expect(pop.locator(".row")).toHaveCount(2);
  const gh = pop.locator(".row", { hasText: "GitHub" });
  await expect(gh.locator(".code")).not.toHaveText(/•/);
  expect(await acceptable(SECRET)).toContain(digitsOf(await gh.locator(".code").textContent()));
  const aws = pop.locator(".row", { hasText: "AWS" });
  expect(digitsOf(await aws.locator(".code").textContent())).toHaveLength(8); // 8-digit account

  // click copies the code
  await gh.click();
  await expect(pop.locator(".toast")).toContainText(/GitHub|next code|下一个/); // within 3s of a boundary the next code is copied instead
  expect(await acceptable(SECRET)).toContain(await pop.evaluate(() => navigator.clipboard.readText()));

  // typing anywhere searches; Enter copies the only match
  await pop.keyboard.press("Escape");
  await pop.locator("body").click({ position: { x: 5, y: 5 } });
  await pop.keyboard.type("aws");
  await expect(pop.locator("#q")).toHaveValue("aws");
  await expect(pop.locator(".row")).toHaveCount(1);
  await pop.keyboard.press("Enter");
  await expect.poll(async () => (await pop.evaluate(() => navigator.clipboard.readText())).length).toBe(8);

  // "/" focuses search from the list, arrows move the selection
  await pop.keyboard.press("Escape");
  await pop.locator("#q").fill("");
  await pop.locator("body").click({ position: { x: 5, y: 5 } });
  await pop.keyboard.press("/");
  await expect(pop.locator("#q")).toBeFocused();
  expect((pop as unknown as { _errors: string[] })._errors).toEqual([]);
});

test("rename, group and delete from the popup", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const pop = await openPopup(p);
  // No force: a row just (re)mounted is skipped by content-visibility until the next frame, and a forced click
  // dispatched before then hit-tests to the row, not its edit button. The normal click waits for it to receive events.
  await pop.locator(".row .more").first().click();
  await pop.locator("#e-issuer").fill("GH Work");
  await pop.locator("#e-group").fill("Work");
  await pop.getByRole("button", { name: /^(Save|保存)$/ }).click();
  await expect(pop.locator(".row", { hasText: "GH Work" })).toBeVisible();
  await expect(pop.locator(".glabel", { hasText: "Work" })).toBeVisible();
  await pop.locator(".row .more").first().click(); // the row remounted in its new group's section
  await pop.getByRole("button", { name: /^(Delete|删除)$/ }).click();
  await pop.getByRole("button", { name: /Click again|再点一次/ }).click();
  await expect(pop.locator(".row")).toHaveCount(0);
  const opt = await openOptions(p, "#trash");
  await expect(opt.locator("#trash")).toContainText("GH Work");
});

test("master password: turn on, lock, unlock, survive a browser restart locked, leave no device key behind", async () => {
  // Turning the password on is now only for a vault made before it was required (Phase 0, device key): seed an empty one,
  // then add as before, so the device key also reaches the other slot, a snapshot and the mirror before it is scrubbed.
  await seedLegacyDeviceVault(p);
  await addByPaste(p, GITHUB_URI);

  const opt = await openOptions(p, "#security");
  await opt.locator("#enable-pw").fill(STRONG);
  await opt.locator("#enable-pw2").fill(STRONG);
  await expect(opt.locator("#enable-strength")).toContainText(/Strong enough|强度足够/);
  await opt.locator("#enable-password").click();
  const code = (await opt.locator("#recovery-code").textContent())!.trim();
  expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
  await expect(opt.locator("#recovery-done")).toBeDisabled();
  await opt.locator("#recovery-saved").check();
  await opt.locator("#recovery-done").click();

  const stored = await opt.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  expect(stored).not.toContain('"deviceKey"');
  expect(stored).not.toContain("JBSWY3DP");

  // lock from the popup, then unlock
  const pop = await openPopup(p);
  await pop.getByRole("button", { name: /^(Lock|锁定)$/ }).click();
  await expect(pop.locator("#secret")).toBeVisible();
  await pop.locator("#secret").fill("wrong password");
  await pop.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
  await expect(pop.getByRole("alert")).toBeVisible();
  await pop.locator("#secret").fill(STRONG);
  await pop.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
  await expect(pop.locator(".row")).toHaveCount(1);

  // restart the browser on the same profile: still protected, comes back locked
  const dir = p.dir;
  await close(p, false);
  p = await launch(dir);
  const again = await openPopup(p);
  await expect(again.locator("#secret")).toBeVisible();
  await again.getByRole("button", { name: /Use recovery key|使用恢复密钥/ }).click();
  await again.locator("#secret").fill(code);
  await again.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
  await expect(again.locator(".row")).toHaveCount(1);
});

test("a new install: the master password comes first, storage never holds a device key, a restart comes back locked, the recovery code opens it", async () => {
  const { recoveryCode } = await startFresh(p);
  const opt = await openOptions(p);
  const stored = () => opt.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  const empty = await stored();
  await addByPaste(p, GITHUB_URI);
  for (const s of [empty, await stored()]) {
    expect(s).toContain('"method":"password"'); // a vault is there, and it is protected
    expect(s).not.toContain("deviceKey");
    expect(s).not.toContain('"method":"device"');
    expect(s).not.toContain(SECRET);
  }
  const dir = p.dir;
  await close(p, false);
  p = await launch(dir);
  const pop = await openPopup(p);
  await expect(pop.locator("#secret")).toBeVisible();
  await pop.getByRole("button", { name: /Use recovery key|使用恢复密钥/ }).click();
  await pop.locator("#secret").fill(recoveryCode);
  await pop.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
  await expect(pop.locator(".row")).toHaveCount(1);
});

test("if the browser loses its local storage, the mirror brings everything back and says so", async () => {
  await startFresh(p);
  await addByPaste(p, `${GITHUB_URI}\n${AWS_URI}`);
  const opt = await openOptions(p);
  await opt.evaluate(() => chrome.storage.local.clear());
  const pop = await openPopup(p);
  await expect(pop.locator(".row")).toHaveCount(2);
  await expect(pop.getByRole("alert")).toContainText(/restored|恢复/);
  await pop.getByRole("button", { name: /Got it|知道了/ }).click();
  await expect(pop.getByRole("alert")).toHaveCount(0);
  // acknowledged for good
  const pop2 = await openPopup(p);
  await expect(pop2.locator(".row")).toHaveCount(2);
  await expect(pop2.getByRole("alert")).toHaveCount(0);
});

test("a damaged active slot is repaired from the other one and reported", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  await addByPaste(p, AWS_URI);
  const opt = await openOptions(p);
  await opt.evaluate(async () => {
    const { sk_active } = (await chrome.storage.local.get("sk_active")) as { sk_active: "a" | "b" };
    await chrome.storage.local.set({ [`sk_slot_${sk_active}`]: { torn: "half a write" } });
  });
  const pop = await openPopup(p);
  await expect(pop.getByRole("alert")).toContainText(/restored|恢复/);
  await expect(pop.locator(".row")).toHaveCount(1); // the previous state: before the second add
});

test("encrypted backup restores a fresh install", async () => {
  await startFresh(p);
  await addByPaste(p, `${GITHUB_URI}\n${AWS_URI}`);
  const opt = await openOptions(p, "#backup");
  await openFold(opt, "encrypted"); // one line until opened (BACKUP-VISUAL)
  await opt.locator("#backup-pw").fill(STRONG);
  await opt.locator("#backup-pw2").fill(STRONG);
  await confirmExport(opt); // H3: the master password again, before any export
  const [dl] = await Promise.all([opt.waitForEvent("download"), opt.locator("#export-encrypted").click()]);
  const file = writeTmp("backup.json", readFileSync(await dl.path()));
  const text = readFileSync(file, "utf8");
  expect(text).not.toContain("JBSWY3DP");
  expect(text).not.toContain(SECRET);
  expect(JSON.parse(text).format).toBe("sixkey-backup");

  // a brand-new profile: "Restore from a backup file" on the welcome screen, then the first run (H1: the master password
  // and recovery code before the accounts are written)
  const fresh = await launch();
  try {
    const welcome = await openPopup(fresh);
    const [o2] = await Promise.all([fresh.ctx.waitForEvent("page"), welcome.locator("#start-restore").click()]);
    await o2.waitForLoadState();
    await o2.locator("#fr-backup-file").setInputFiles(file);
    await o2.locator("#fr-open-pw").fill("not the password");
    await o2.getByRole("button", { name: /Open backup|打开备份/ }).click();
    await expect(o2.locator("#fr-backup-error")).toBeVisible();
    await o2.locator("#fr-open-pw").fill(STRONG);
    await o2.getByRole("button", { name: /Open backup|打开备份/ }).click();
    await o2.locator("#fr-restore-next").click();
    await finishWizard(o2);
    await expect(o2.locator("#fr-hint")).toContainText(/Restored 2|已恢复 2/);
    const pop = await openPopup(fresh);
    await expect(pop.locator(".row")).toHaveCount(2);
    const gh = pop.locator(".row", { hasText: "GitHub" }).locator(".code");
    await expect(gh).toHaveText(/\d{3}/); // the row is there before its first code is
    expect(await acceptable(SECRET)).toContain(digitsOf(await gh.textContent()));
  } finally {
    await close(fresh);
  }
});

test("QR images are read: a plain otpauth code and a Google Authenticator export", async () => {
  await startFresh(p);
  const opt = await openOptions(p, "#add");
  const plain = writeTmp("a.png", qrPng(GITHUB_URI));
  const ga = writeTmp(
    "b.png",
    qrPng("otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8SGEV4YW1wbGU6YWxpY2VAZ29vZ2xlLmNvbRoHRXhhbXBsZTAC", 5),
  );
  await opt.locator("#qr-file").setInputFiles([plain, ga]);
  await expect(opt.locator("#preview")).toContainText(/2 to add|将添加 2/);
  await opt.locator("#add-confirm").click();
  await expect(opt.locator("#add-done")).toBeVisible();
  const pop = await openPopup(p);
  await expect(pop.locator(".row")).toHaveCount(2);
  await expect(pop.locator(".who b", { hasText: /^Example$/ })).toBeVisible();
});

test("manual entry rejects a bad key and accepts a good one", async () => {
  await startFresh(p);
  const opt = await openOptions(p, "#add");
  await opt.locator("#m-issuer").fill("Manual");
  await opt.locator("#m-label").fill("me");
  await opt.locator("#m-secret").fill("not base32 !!");
  await opt.locator("#manual-add").click();
  await expect(opt.locator("#add-manual .err")).toBeVisible();
  await opt.locator("#m-secret").fill("jbsw y3dp ehpk 3pxp");
  await opt.locator("#manual-add").click();
  const pop = await openPopup(p);
  await expect(pop.locator(".row", { hasText: "Manual" })).toBeVisible();
});

test("popup is quick: codes appear within 100ms of the page starting to render (unlocked)", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const pop = await p.ctx.newPage();
  await pop.goto(`chrome-extension://${p.id}/popup/index.html`, { waitUntil: "commit" });
  await pop.locator(".row .code").filter({ hasNotText: "•" }).first().waitFor();
  const t = await pop.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    return { domInteractive: nav.domInteractive, now: performance.now() };
  });
  console.log(`first code rendered ${Math.round(t.now)}ms after navigation start (dev machine, headless)`);
  expect(t.now).toBeLessThan(1500); // generous in CI; the real target (100ms) is tracked in the report
});

test("lock every time: a new popup is always locked and the key is never in shared session storage", async () => {
  await startFresh(p); // the master password is set during the first run
  await addByPaste(p, GITHUB_URI);
  const opt = await openOptions(p, "#security");
  await opt.locator("#al-mode").selectOption("always");
  await expect(opt.getByText(/^(Saved|已保存)$/)).toBeVisible();
  // unlock in this options page, then check what other contexts could see
  await expect(opt.locator("#unlock-pw")).toBeVisible();
  await opt.locator("#unlock-pw").fill(STRONG);
  await opt.locator("#unlock-btn").click();
  await expect(opt.locator("#unlock-pw")).toHaveCount(0);
  expect(await opt.evaluate(async () => JSON.stringify(await chrome.storage.session.get(null)))).not.toContain(
    "sk_session",
  );
  const pop = await openPopup(p);
  await expect(pop.locator("#secret")).toBeVisible();
});

test("clipboard: the copied code is cleared after 30 seconds", async () => {
  test.setTimeout(90_000);
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const pop = await openPopup(p);
  await pop.locator(".row", { hasText: "GitHub" }).click();
  await expect(pop.locator(".clip")).toBeVisible();
  expect((await pop.evaluate(() => navigator.clipboard.readText())).length).toBe(6);
  await pop.waitForTimeout(34_000);
  // Browsers cannot "copy nothing", so a single blank space replaces the code, as other password managers do.
  expect((await pop.evaluate(() => navigator.clipboard.readText())).trim()).toBe("");
});

test("clipboard: something the user copied since is left alone", async () => {
  test.setTimeout(90_000);
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const pop = await openPopup(p);
  await pop.locator(".row", { hasText: "GitHub" }).click();
  await expect(pop.locator(".clip")).toBeVisible();
  await pop.evaluate(() => navigator.clipboard.writeText("my own text"));
  await pop.waitForTimeout(34_000);
  expect(await pop.evaluate(() => navigator.clipboard.readText())).toBe("my own text");
});

test("a backup holds what was added after the settings page opened", async () => {
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const stale = await openOptions(p, "#backup"); // loaded now, with one account
  await expect(stale.locator("#backup")).toBeVisible();
  await addByPaste(p, AWS_URI); // a second page adds another account
  await openFold(stale, "encrypted");
  await stale.locator("#backup-pw").fill(STRONG);
  await stale.locator("#backup-pw2").fill(STRONG);
  await confirmExport(stale); // H3: the master password again, before any export
  const [dl] = await Promise.all([stale.waitForEvent("download"), stale.locator("#export-encrypted").click()]);
  const { vault } = await openBackup(JSON.parse(readFileSync(await dl.path(), "utf8")), STRONG);
  expect(vault.entries.filter((e) => e.secret !== "")).toHaveLength(2);

  await confirmExport(stale); // and again: every export asks
  const [dl2] = await Promise.all([
    stale.waitForEvent("download"),
    (async () => {
      await stale.locator("#plain-ok").check();
      await stale.locator("#export-plain").click();
    })(),
  ]);
  expect(
    readFileSync(await dl2.path(), "utf8")
      .split("\n")
      .filter(Boolean),
  ).toHaveLength(2);
});

// The password reset (forgot the password) moved from the popup to a settings tab: test/e2e/reset.spec.ts (A4R-1).

test("language: follows the browser by default, switches in one tap, and sticks across pages", async () => {
  const pop = await openPopup(p);
  await expect(pop.getByRole("button", { name: /Start \(set a master password first\)/ })).toBeVisible(); // Playwright's browser is English
  await pop.locator("#lang-toggle").click();
  await expect(pop.getByRole("button", { name: "开始（先设置主密码）" })).toBeVisible();
  await expect(pop.locator("body")).toContainText("欢迎使用 Sixkey");
  expect(await pop.evaluate(() => document.documentElement.lang)).toBe("zh-CN");

  // With no vault yet the settings page is the first-run wizard (H1), so its heading is the one to read.
  const opt = await openOptions(p);
  await expect(opt.getByRole("heading", { name: "开始使用 Sixkey" })).toBeVisible(); // the settings page shares the choice
  await opt.locator("#lang-select").selectOption("en");
  await expect(opt.getByRole("heading", { name: "Set up Sixkey" })).toBeVisible();
  await opt.locator("#lang-select").selectOption("auto");
  await expect(opt.getByRole("heading", { name: "Set up Sixkey" })).toBeVisible();
});
