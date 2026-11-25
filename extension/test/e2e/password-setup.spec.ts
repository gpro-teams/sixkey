// Setting a new password (docs/design/notes/PASSWORD-SETUP-NOTES.md): "Generate for me", explained, shown as page
// text with Copy (never saved as a file, never in a text field the browser keeps); random words one click away; an edit
// falls back to the estimate; a typed password short of the bar says so and offers a generated one; pasting is never
// blocked. For the master password one's own comes first and "Generate for me" is secondary (OWNER-DECISIONS/15; the
// warning below 50 bits and its "Use anyway" are own-password.spec.ts's); a backup file keeps the generator first. First run, then Settings (turning the master password on, changing it, a backup file's password), then
// what the browser and the page keep (the profile on disk, a lock) and the races around a generation.
import { expect, test, type Page } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openBackup } from "../../src/core/backup/backup";
import { downloadText } from "./export-helpers";
import {
  close,
  launch,
  openFold,
  openOptions,
  openPopup,
  type Profile,
  seedLegacyDeviceVault,
  showSection,
  STRONG,
  skipFirstPin,
} from "./harness";

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

const CHARS = /^[A-HJKMNP-Z2-9]{4}(?:-[A-HJKMNP-Z2-9]{4}){3}$/;
const WORDS = /^[a-z]+(?:-[a-z]+){4}$/;
const lit = (page: Page, prefix: string) => page.locator(`#${prefix}-pw ~ .strength .meter i.on`);
const valueOf = (page: Page, prefix: string) => page.locator(`#${prefix}-pw`).inputValue();

test("first run: one's own first, 'Generate for me' secondary, explained and kept; words; an edit is estimated; short says so; the generated password opens the vault", async () => {
  const opt = await openOptions(p);
  await expect(opt.locator("#setup")).toBeVisible();

  // the fields come first, for one's own; the generator after them, as a secondary button
  const order = await opt.evaluate(() => {
    const gen = document.getElementById("fr-gen")!;
    return {
      after: !!(gen.compareDocumentPosition(document.getElementById("fr-pw2")!) & Node.DOCUMENT_POSITION_PRECEDING),
      secondary: gen.classList.contains("btn") && gen.classList.contains("ghost"),
    };
  });
  expect(order).toEqual({ after: true, secondary: true });
  await expect(opt.locator("#fr-gen")).toHaveText(/Generate for me|帮我生成/);
  await expect(opt.locator("#fr-own")).toHaveCount(0); // "Choose my own" comes with a generated one
  await expect(opt.locator("#fr-made")).toHaveCount(0);

  // one click: both fields filled, revealed, why it is strong enough, where to keep it, accepted
  await opt.locator("#fr-gen").click();
  const chars = await valueOf(opt, "fr");
  expect(chars).toMatch(CHARS);
  await expect(opt.locator("#fr-pw2")).toHaveValue(chars);
  // shown as page text in its box; the fields stay masked, so the browser keeps nothing of them
  await expect(opt.locator("#fr-value")).toHaveText(chars);
  for (const f of ["#fr-pw", "#fr-pw2"]) {
    await expect(opt.locator(f)).toHaveAttribute("type", "password");
    await expect(opt.locator(f)).toHaveAttribute("autocomplete", "new-password");
  }
  // Show reveals the fields, with autocomplete off while they are text
  await opt.locator("#fr-show").check();
  for (const f of ["#fr-pw", "#fr-pw2"]) {
    await expect(opt.locator(f)).toHaveAttribute("type", "text");
    await expect(opt.locator(f)).toHaveAttribute("autocomplete", "off");
    await expect(opt.locator(f)).toHaveAttribute("autocapitalize", "off");
    await expect(opt.locator(f)).toHaveAttribute("spellcheck", "false");
  }
  await opt.locator("#fr-show").uncheck();
  await expect(opt.locator("#fr-made")).toContainText(
    /16 random characters: about 79 bits, well above the 50|16 个随机字符：约 79 位/,
  );
  await expect(opt.locator("#fr-made")).toContainText(/password manager or write it on paper|密码管理器，或抄在纸上/);
  await expect(opt.locator("#fr-made")).not.toContainText(/recovery key|恢复密钥/);
  await expect(opt.locator("#fr-strength")).toHaveText(/Generated: 79 bits|已生成：79 位/);
  await expect(opt.locator("#fr-strength")).toHaveAttribute("aria-live", "polite");
  await expect(lit(opt, "fr")).toHaveCount(10);
  await expect(opt.locator("#fr-pw ~ .strength .meter")).toHaveClass(/good/);
  await expect(opt.locator("#fr-next")).toBeEnabled();

  // Copy hands over exactly the password; nothing offers to save it as a file
  await opt.locator("#fr-copy").click();
  await expect(opt.locator("#fr-copy")).toHaveText(/Copied|已复制/);
  await expect(opt.locator("#fr-made [role=status]")).toHaveText(/Copied|已复制/); // announced
  expect(await opt.evaluate(() => navigator.clipboard.readText())).toBe(chars);
  await expect(opt.locator("#fr-made").getByRole("button")).toHaveText([
    /Copy|Copied|复制|已复制/,
    /words|单词/,
    /Choose my own|自己设置/, // back to one's own (OWNER-DECISIONS/15)
  ]);
  await expect(opt.locator("#fr-save")).toHaveCount(0);

  // the easier-to-type style: five random words, its own honest count
  await opt.locator("#fr-style").click();
  await expect(opt.locator("#fr-made")).toContainText(/5 random words: about 64 bits|5 个随机单词：约 64 位/);
  const words = await valueOf(opt, "fr");
  expect(words).toMatch(WORDS);
  await expect(opt.locator("#fr-pw2")).toHaveValue(words);
  await expect(opt.locator("#fr-strength")).toHaveText(/Generated: 64 bits|已生成：64 位/);
  await expect(lit(opt, "fr")).toHaveCount(10);
  await expect(opt.locator("#fr-style")).toHaveText(/Use characters instead|改用字符/);

  // edited: no longer the generated one, so it is estimated like any other and the explanation goes
  await opt.locator("#fr-pw").press("End");
  await opt.locator("#fr-pw").pressSequentially("x");
  await expect(opt.locator("#fr-made")).toHaveCount(0);
  await expect(opt.locator("#fr-strength")).not.toHaveText(/Generated|已生成/);
  await expect(opt.locator("#fr-next")).toBeDisabled(); // and the two fields differ now

  // "Choose my own" after a fresh one: empties both and puts the cursor in the first
  await opt.locator("#fr-gen").click();
  await expect(opt.locator("#fr-made")).toBeVisible();
  await opt.locator("#fr-own").click();
  await expect(opt.locator("#fr-pw")).toHaveValue("");
  await expect(opt.locator("#fr-pw2")).toHaveValue("");
  await expect(opt.locator("#fr-pw")).toBeFocused();
  await expect(opt.locator("#fr-made")).toHaveCount(0);

  // typed, short of the bar: said so, never a full bar, and one click to a generated one
  await opt.locator("#fr-pw").fill("Password12345!");
  await opt.locator("#fr-pw2").fill("Password12345!");
  await expect(opt.locator("#fr-strength")).toHaveText(
    /Estimated \d+ bits, below the 50 we recommend|估算强度 \d+ 位，低于建议的 50 位/,
  );
  expect(await lit(opt, "fr").count()).toBeLessThan(10);
  await expect(opt.locator("#fr-next")).toBeDisabled();
  await opt.locator("#fr-use-gen").click();
  expect(await valueOf(opt, "fr")).toMatch(CHARS);
  await expect(opt.locator("#fr-made")).toBeVisible();
  await expect(opt.locator("#fr-use-gen")).toHaveCount(0);

  // pasting is never blocked, and a pasted strong password counts like a typed one
  const prevented = await opt.locator("#fr-pw").evaluate((el) => {
    const data = new DataTransfer();
    data.setData("text/plain", "anything");
    const ev = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await opt.locator("#fr-pw").fill(STRONG);
  await opt.locator("#fr-pw2").fill(STRONG);
  await expect(opt.locator("#fr-strength")).toHaveText(/Strong enough|强度足够/);

  // finish with a generated password, then come back locked and open it with that password
  await opt.locator("#fr-gen").click();
  const master = await valueOf(opt, "fr");
  await opt.locator("#fr-next").click();
  await opt.locator("#recovery-saved").check();
  await opt.locator("#recovery-done").click();
  await opt.locator("#fr-solo").check();
  await opt.locator("#fr-finish").click();
  await skipFirstPin(opt);
  await expect(opt.locator("#fr-hint")).toBeVisible();
  const dir = p.dir;
  await close(p, false);
  p = await launch(dir);
  const pop = await openPopup(p);
  await pop.locator("#secret").fill(master);
  await pop.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
  await expect(pop.locator("#q")).toBeVisible();
});

test("settings: turn the master password on and change it with generated ones; a backup file's generated password opens the file", async () => {
  await seedLegacyDeviceVault(p);
  const opt = await openOptions(p, "#security");

  // turning it on: the same first step, the recovery code's advice
  await opt.locator("#enable-gen").click();
  const first = await valueOf(opt, "enable");
  expect(first).toMatch(CHARS);
  await expect(opt.locator("#enable-made")).toContainText(/password manager|密码管理器/);
  await expect(opt.locator("#enable-strength")).toHaveText(/Generated: 79 bits|已生成：79 位/);
  await opt.locator("#enable-password").click();
  await expect(opt.locator("#recovery-code")).toBeVisible();
  await opt.locator("#recovery-saved").check();
  await opt.locator("#recovery-done").click();

  // changing it: the old one typed, a passphrase as the new one
  await showSection(opt, "security-keys");
  await openFold(opt, "fold-change");
  await opt.locator("#old-pw").fill(first);
  await opt.locator("#change-gen").click();
  await opt.locator("#change-style").click();
  await expect(opt.locator("#change-made")).toContainText(/5 random words|5 个随机单词/); // the word list loads first
  const second = await valueOf(opt, "change");
  expect(second).toMatch(WORDS);
  await expect(opt.locator("#change-strength")).toHaveText(/Generated: 64 bits|已生成：64 位/);
  await opt.getByRole("button", { name: /^(Change password|修改密码)$/ }).click();
  await expect(opt.locator(".ok-msg")).toBeVisible();

  // a backup file (the same page, further down): no recovery code there, so the advice says the file needs it
  await showSection(opt, "backup");
  await openFold(opt, "encrypted"); // one line until opened (BACKUP-VISUAL)
  await opt.locator("#backup-gen").click();
  const filePw = await valueOf(opt, "backup");
  expect(filePw).toMatch(CHARS);
  await expect(opt.locator("#backup-made")).toContainText(/cannot be opened without it|没有它就打不开文件/);
  await expect(opt.locator("#backup-made")).not.toContainText(/recovery key|恢复密钥/);
  await expect(opt.locator("#backup-save")).toHaveCount(0); // never a password file next to the backup file
  const locked = opt.locator("#export-pw");
  if (await locked.count()) await locked.fill(second); // the export asks for the master password again
  const text = await downloadText(opt, () => opt.locator("#export-encrypted").click());
  expect((await openBackup(JSON.parse(text), filePw)).vault.vaultId).toBeTruthy();
});

/** Every file under the profile holding `secret` in UTF-8 or UTF-16LE (Blink's page state is UTF-16). */
function onDisk(dir: string, secret: string): string[] {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const f = join(d, n);
      try {
        const st = statSync(f);
        return st.isDirectory() ? walk(f) : st.isFile() ? [f] : [];
      } catch {
        return [];
      }
    });
  const a = Buffer.from(secret, "utf8");
  const b = Buffer.from(secret, "utf16le");
  return walk(dir).filter((f) => {
    try {
      const x = readFileSync(f);
      return x.includes(a) || x.includes(b);
    } catch {
      return false;
    }
  });
}

test("a generated password shown on screen never reaches the profile on disk (session restore state)", async () => {
  const opt = await openOptions(p);
  await opt.locator("#fr-gen").click();
  const pw = await opt.locator("#fr-pw").inputValue();
  await opt.evaluate(() => (location.hash = "#elsewhere")); // a section link; or nothing at all, then the browser quits
  await opt.waitForTimeout(1000);
  const dir = p.dir;
  await close(p, false);
  expect(onDisk(dir, pw)).toEqual([]);
  p = await launch(dir); // for afterEach
});

test("a typed password with Show ticked never reaches the profile on disk either", async () => {
  const opt = await openOptions(p);
  const pw = "Zq8-typed-Marker-77";
  await opt.locator("#fr-pw").fill(pw);
  await opt.locator("#fr-pw2").fill(pw);
  await opt.locator("#fr-show").check();
  await opt.waitForTimeout(1000);
  const dir = p.dir;
  await close(p, false);
  expect(onDisk(dir, pw)).toEqual([]);
  p = await launch(dir);
});

test("a generated password pasted back is estimated, and the line agrees with the button", async () => {
  const opt = await openOptions(p);
  await opt.locator("#fr-gen").click();
  const pw = await opt.locator("#fr-pw").inputValue();
  await opt.locator("#fr-own").click();
  await opt.locator("#fr-pw").fill(pw);
  await opt.locator("#fr-pw2").fill(pw);
  await expect(opt.locator("#fr-next")).toBeEnabled();
  await expect(opt.locator("#fr-strength")).not.toHaveText(/At least 50 bits|估算强度至少/);
  await expect(lit(opt, "fr")).toHaveCount(10);
});

test("focus stays on a control after 'Use a generated password instead' and after switching style", async () => {
  const opt = await openOptions(p);
  await opt.locator("#fr-pw").fill("Password12345!");
  await opt.locator("#fr-pw2").fill("Password12345!");
  await opt.locator("#fr-use-gen").focus();
  await opt.keyboard.press("Enter");
  await expect(opt.locator("#fr-made")).toBeVisible();
  await expect(opt.locator("#fr-copy")).toBeFocused(); // the button that asked is gone
  await opt.locator("#fr-style").focus();
  await opt.keyboard.press("Enter");
  await expect(opt.locator("#fr-style")).toHaveText(/characters|字符/);
  await expect(opt.locator("#fr-style")).toBeFocused(); // busy while the word list loads, but still focused
});

test("'Choose my own' wins over a passphrase still being made", async () => {
  const opt = await openOptions(p);
  await opt.locator("#fr-gen").click();
  await opt.evaluate(() => {
    document.getElementById("fr-style")!.click(); // words: waits for the word list
    document.getElementById("fr-own")!.click();
  });
  await opt.locator("#fr-pw").fill("my own typed password 1");
  await opt.waitForTimeout(1500);
  await expect(opt.locator("#fr-pw")).toHaveValue("my own typed password 1");
  await expect(opt.locator("#fr-pw")).toHaveAttribute("type", "password");
  await expect(opt.locator("#fr-made")).toHaveCount(0);
});

test("the parent's button is never enabled on the answer for an earlier value", async () => {
  const opt = await openOptions(p);
  await opt.locator("#fr-gen").click();
  await expect(opt.locator("#fr-next")).toBeEnabled();
  const enabledAfterEdit = await opt.evaluate(async () => {
    const set = (el: HTMLInputElement, v: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const pw = document.getElementById("fr-pw") as HTMLInputElement;
    const pw2 = document.getElementById("fr-pw2") as HTMLInputElement;
    set(pw2, "Password12345!");
    await new Promise((r) => setTimeout(r, 300));
    set(pw, "Password12345!"); // both now hold a floor-passing password below 50 bits
    await new Promise((r) => setTimeout(r, 0)); // the next task: a click or Enter could land here
    return !(document.getElementById("fr-next") as HTMLButtonElement).disabled;
  });
  expect(enabledAfterEdit).toBe(false);
});

test("a lock empties and hides a backup file's password", async () => {
  const opt = await openOptions(p);
  await opt.locator("#fr-gen").click();
  await opt.locator("#fr-next").click();
  await opt.locator("#recovery-saved").check();
  await opt.locator("#recovery-done").click();
  await opt.locator("#fr-solo").check();
  await opt.locator("#fr-finish").click();
  await skipFirstPin(opt);
  await expect(opt.locator("#fr-hint")).toBeVisible();
  await opt.goto(opt.url().replace(/#.*$/, "") + "#backup");
  await openFold(opt, "encrypted");
  await opt.locator("#backup-gen").click();
  await expect(opt.locator("#backup-pw")).not.toHaveValue("");
  const pop = await openPopup(p);
  await pop
    .getByRole("button", { name: /^(Lock|锁定)$/ })
    .first()
    .click();
  await pop.close();
  await opt.bringToFront();
  await expect(opt.locator("#backup-pw")).toHaveValue("");
  await expect(opt.locator("#backup-pw2")).toHaveValue("");
  await expect(opt.locator("#backup-made")).toHaveCount(0);
});
