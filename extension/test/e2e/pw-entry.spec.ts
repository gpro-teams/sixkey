// Typing a generated master password back (docs/design/notes/PASSWORD-SETUP-NOTES.md §7, §8), with real keys and the
// real clipboard: the settings page's grouped input (capitals, the caret moving on, Backspace across boxes, a whole code
// pasted into a box that already holds some, Show, the way to the plain field), the words' hint, a prompt that asks
// again; the popup's lock screen with the same grouped input under the hint but never shown (the arrows too, a code
// pasted with or without hyphens, a wrong one recorded once, the plain field a click away and clearing the error), its
// plain field without the hint taking the code without hyphens in lower case, a forged hint costing one click; an
// input method composing in the boxes; and nothing of it on disk.
import { expect, test, type Page } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { close, launch, openFold, openOptions, openPopup, type Profile, skipFirstPin } from "./harness";

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

const CHARS = /^[A-HJKMNP-Z2-9]{4}(?:-[A-HJKMNP-Z2-9]{4}){3}$/;
const boxes = (page: Page, id: string) => [id, `${id}-2`, `${id}-3`, `${id}-4`].map((b) => page.locator(`#${b}`));
const groupsOf = async (page: Page, id: string) => Promise.all(boxes(page, id).map((b) => b.inputValue()));

/** The first run with a generated password ("Generate for me", or its words): the password. */
async function firstRunGenerated(opt: Page, words = false): Promise<string> {
  await expect(opt.locator("#setup")).toBeVisible();
  await opt.locator("#fr-gen").click();
  if (words) {
    await opt.locator("#fr-style").click();
    await expect(opt.locator("#fr-made")).toContainText(/5 random words|5 个随机单词/);
  }
  const pw = await opt.locator("#fr-pw").inputValue();
  await opt.locator("#fr-next").click();
  await opt.locator("#recovery-saved").check();
  await opt.locator("#recovery-done").click();
  await opt.locator("#fr-solo").check();
  await opt.locator("#fr-finish").click();
  await skipFirstPin(opt);
  await expect(opt.locator("#fr-hint")).toBeVisible();
  return pw;
}

/** The input hint forged in `page` for this keyring's password wrap (code in Sixkey's own pages could write one). */
async function forgeHint(page: Page, format: string): Promise<void> {
  await page.evaluate(async (format) => {
    const { sk_active } = await chrome.storage.local.get("sk_active");
    const slot = (await chrome.storage.local.get(`sk_slot_${sk_active}`))[`sk_slot_${sk_active}`] as {
      keyring: { wraps: { method: string; kdf?: { salt: string } }[] };
    };
    const salt = slot.keyring.wraps.find((w) => w.method === "password")!.kdf!.salt;
    await chrome.storage.session.set({ sk_pw_format: { v: 1, format, salt } });
  }, format);
}
const hintIn = (page: Page) =>
  page.evaluate(
    async () => ((await chrome.storage.session.get("sk_pw_format")).sk_pw_format as { format?: string })?.format,
  );

/** Lock now in the popup: every page shows itself locked. */
async function lockNow(): Promise<void> {
  const pop = await openPopup(p);
  await pop.locator("#lock-now").click();
  await expect(pop.locator("#secret")).toBeVisible();
  await pop.close();
}

test("the unlock bar: four groups, capitals, the caret moving on, Backspace, a pasted code, Show; then unlocked", async () => {
  const opt = await openOptions(p);
  const pw = await firstRunGenerated(opt);
  expect(pw).toMatch(CHARS);
  const code = pw.replace(/-/g, "");
  await lockNow();
  const [b1, b2, b3, b4] = boxes(opt, "unlock-pw");
  await expect(b1!).toBeVisible();
  for (const [i, b] of [b1!, b2!, b3!, b4!].entries()) {
    await expect(b).toHaveAttribute("type", "password");
    await expect(b).toHaveAttribute("autocomplete", "off");
    await expect(b).toHaveAttribute("autocapitalize", "off");
    await expect(b).toHaveAttribute("spellcheck", "false");
    await expect(b).toHaveAttribute("aria-label", new RegExp(`(Master password|主密码).*${i + 1}.*4`));
  }
  await expect(opt.locator("label[for=unlock-pw]")).toBeVisible();

  // typed in lower case, no hyphens: capitals, and after four the caret is in the next box
  await b1!.click();
  await opt.keyboard.type(code.slice(0, 5).toLowerCase());
  await expect(b2!).toBeFocused();
  expect(await groupsOf(opt, "unlock-pw")).toEqual([code.slice(0, 4), code[4], "", ""]);
  // a hyphen or a space typed is left out
  await opt.keyboard.type("- ");
  expect(await groupsOf(opt, "unlock-pw")).toEqual([code.slice(0, 4), code[4], "", ""]);
  // Backspace: the symbol in this box, then, at its start, the one before it in the previous box
  await opt.keyboard.press("Backspace");
  await opt.keyboard.press("Backspace");
  await expect(b1!).toBeFocused();
  expect(await groupsOf(opt, "unlock-pw")).toEqual([code.slice(0, 3), "", "", ""]);

  // the whole code pasted, from the real clipboard, into a box that already holds some: it replaces them
  await opt.evaluate((t) => navigator.clipboard.writeText(t), `  ${pw.toLowerCase().replace(/-/g, " ")} `);
  await b1!.focus();
  await opt.keyboard.press("ControlOrMeta+V");
  expect(await groupsOf(opt, "unlock-pw")).toEqual([0, 1, 2, 3].map((k) => code.slice(4 * k, 4 * k + 4)));
  await expect(b4!).toBeFocused();

  // Show: text, still autocomplete off; pressed again, masked
  const show = opt.locator(".pw-groups button[aria-pressed]");
  await show.click();
  await expect(show).toHaveAttribute("aria-pressed", "true");
  for (const b of [b1!, b2!, b3!, b4!]) {
    await expect(b).toHaveAttribute("type", "text");
    await expect(b).toHaveAttribute("autocomplete", "off");
  }
  await show.click();
  await expect(b1!).toHaveAttribute("type", "password");

  await opt.locator("#unlock-btn").click();
  await expect(b1!).toHaveCount(0); // unlocked
});

test("the plain field is one click away, and takes the code loosely", async () => {
  const opt = await openOptions(p);
  const pw = await firstRunGenerated(opt);
  await lockNow();
  await expect(opt.locator("#unlock-pw-2")).toBeVisible();
  await opt.locator("#unlock-pw-plain").click();
  await expect(opt.locator("#unlock-pw-2")).toHaveCount(0);
  await expect(opt.locator("#unlock-pw")).toBeFocused();
  await expect(opt.locator("#unlock-pw")).toHaveAttribute("type", "password");
  await opt.locator("#unlock-pw").fill(pw.toLowerCase().replace(/-/g, " "));
  await opt.locator("#unlock-btn").click();
  await expect(opt.locator("#unlock-pw")).toHaveCount(0);
});

test("the popup's lock screen under the hint: four groups, never shown, capitals, Backspace and the arrows, a pasted code; a wrong one recorded once; the plain field clears it", async () => {
  const opt = await openOptions(p);
  const pw = await firstRunGenerated(opt);
  const code = pw.replace(/-/g, "");
  const groups = [0, 1, 2, 3].map((k) => code.slice(4 * k, 4 * k + 4));
  await lockNow();
  const pop = await openPopup(p);
  const [b1, b2, b3, b4] = boxes(pop, "secret");
  await expect(b4!).toBeVisible();
  await expect(b1!).toBeFocused(); // the lock screen's field has the focus, as the plain one had
  for (const [i, b] of [b1!, b2!, b3!, b4!].entries()) {
    await expect(b).toHaveAttribute("type", "password");
    await expect(b).toHaveAttribute("autocomplete", "off");
    await expect(b).toHaveAttribute("autocapitalize", "off");
    await expect(b).toHaveAttribute("spellcheck", "false");
    await expect(b).toHaveAttribute("aria-label", new RegExp(`(Master password|主密码).*${i + 1}.*4`));
  }
  await expect(pop.getByRole("group", { name: /^(Master password|主密码)$/ })).toBeVisible();
  await expect(pop.locator("#lock-label")).toHaveAttribute("for", "secret");
  await expect(pop.locator("#use-pin")).toHaveCount(0); // no PIN set: the screen as before, but for the field
  await expect(pop.locator(".pw-groups button")).toHaveCount(0); // no Show: the master password is never shown here

  // typed in lower case: capitals, the caret moving on; a hyphen typed is left out
  await pop.keyboard.type(code.slice(0, 5).toLowerCase() + "-");
  await expect(b2!).toBeFocused();
  expect(await groupsOf(pop, "secret")).toEqual([groups[0], code[4], "", ""]);
  // Backspace: the symbol in this box, then, at its start, the one before it in the box before
  await pop.keyboard.press("Backspace");
  await pop.keyboard.press("Backspace");
  await expect(b1!).toBeFocused();
  expect(await groupsOf(pop, "secret")).toEqual([code.slice(0, 3), "", "", ""]);
  // the arrows at a box's edge go on into the box beside; inside a box they are the browser's
  await pop.keyboard.type(code[3]!.toLowerCase());
  await expect(b2!).toBeFocused();
  await pop.keyboard.press("ArrowLeft");
  await expect(b1!).toBeFocused();
  expect(await b1!.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(3);
  await pop.keyboard.press("ArrowRight");
  await expect(b1!).toBeFocused();
  await pop.keyboard.press("ArrowRight");
  await expect(b2!).toBeFocused();
  expect(await b2!.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(0);
  expect(await groupsOf(pop, "secret")).toEqual([groups[0], "", "", ""]);

  // a wrong code pasted (the real clipboard, no hyphens, lower case): one failure, the boxes marked
  const wrong = code.toLowerCase().replace(/.$/, (c) => (c === "a" ? "b" : "a"));
  await pop.evaluate((t) => navigator.clipboard.writeText(t), wrong);
  await pop.keyboard.press("ControlOrMeta+V");
  expect((await groupsOf(pop, "secret")).join("")).toBe(wrong.toUpperCase());
  await pop.locator("button[type=submit]").click();
  await expect(pop.locator(".err")).toBeVisible();
  for (const b of [b1!, b2!, b3!, b4!]) await expect(b).toHaveAttribute("aria-invalid", "true");
  const log = await pop.evaluate(async () => JSON.stringify(await chrome.storage.local.get("sk_security_log")));
  expect(log.match(/unlock_failed/g)?.length).toBe(1);

  // the right one pasted with its hyphens, in lower case, into a box holding the wrong one's symbols: it replaces them
  await pop.evaluate((t) => navigator.clipboard.writeText(t), pw.toLowerCase());
  await b3!.focus();
  await pop.keyboard.press("ControlOrMeta+V");
  expect(await groupsOf(pop, "secret")).toEqual(groups);
  await expect(b4!).toBeFocused();
  await b4!.press("Enter"); // Enter in a box submits, as in the plain field
  await expect(pop.locator("#q")).toBeVisible();

  // locked again: the hint survives a lock; after a wrong try, the plain field is one click away, which clears the
  // error and the value, and takes the code loosely
  await pop.locator("#lock-now").click();
  await expect(b2!).toBeVisible();
  await expect(b1!).toBeFocused();
  await pop.keyboard.type(wrong);
  await pop.keyboard.press("Enter");
  await expect(pop.locator(".err")).toBeVisible();
  await expect(b1!).toHaveAttribute("aria-invalid", "true");
  await pop.locator("#secret-plain").click();
  await expect(pop.locator(".err")).toHaveCount(0);
  await expect(b2!).toHaveCount(0);
  await expect(pop.locator("#secret")).not.toHaveAttribute("aria-invalid", /.*/);
  await expect(pop.locator("#secret")).toBeFocused();
  await expect(pop.locator("#secret")).toHaveAttribute("type", "password");
  await expect(pop.locator("#secret")).toHaveAttribute("autocomplete", "off");
  await expect(pop.locator("#secret")).toHaveValue("");
  await pop.locator("#secret").fill(pw.toLowerCase().replace(/-/g, " "));
  await pop.locator("button[type=submit]").click();
  await expect(pop.locator("#q")).toBeVisible();
  expect((pop as Page & { _errors: string[] })._errors).toEqual([]);
});

test("the popup without the hint (gone, as after a restart): its plain field takes the code without hyphens in lower case, and that unlock brings the boxes back", async () => {
  const opt = await openOptions(p);
  const pw = await firstRunGenerated(opt);
  await lockNow();
  await opt.evaluate(() => chrome.storage.session.remove("sk_pw_format")); // session storage is memory only
  const pop = await openPopup(p);
  await expect(pop.locator("#secret")).toBeFocused();
  await expect(pop.locator("#secret-2")).toHaveCount(0);
  await expect(pop.locator("#secret-plain")).toHaveCount(0);
  await expect(pop.locator("#secret")).toHaveAttribute("type", "password");
  await expect(pop.locator("#secret")).toHaveAttribute("autocomplete", "off");
  await pop.locator("#secret").fill(pw.toLowerCase().replace(/-/g, ""));
  await pop.locator("button[type=submit]").click();
  await expect(pop.locator("#q")).toBeVisible();
  expect(await hintIn(pop)).toBe("gen16-v1"); // learnt again by that unlock
  await pop.locator("#lock-now").click();
  await expect(pop.locator("#secret-2")).toBeVisible();
});

test("the words: the plain field says how to type them, and spaces and capitals work", async () => {
  const opt = await openOptions(p);
  const pw = await firstRunGenerated(opt, true);
  expect(pw).toMatch(/^[a-z]+(?:-[a-z]+){4}$/);
  await lockNow();
  await expect(opt.locator("#unlock-pw")).toBeVisible();
  await expect(opt.locator("#unlock-pw-2")).toHaveCount(0);
  await expect(opt.locator("#unlock-pw-words")).toHaveText(/5 words; spaces or hyphens|5 个词/);
  await expect(opt.locator("#unlock-pw")).toHaveAttribute("aria-describedby", "unlock-pw-words");
  const spaced = pw
    .split("-")
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("  ");
  await opt.locator("#unlock-pw").fill(spaced);
  await opt.locator("#unlock-btn").click();
  await expect(opt.locator("#unlock-pw")).toHaveCount(0);

  // the popup shows its plain field for words; a 16-symbol hint forged over them shows the boxes, which cannot take
  // words: the plain field is one click away and takes them typed loosely, and the unlock puts the hint right
  await lockNow();
  let pop = await openPopup(p);
  await expect(pop.locator("#secret")).toBeVisible();
  await expect(pop.locator("#secret-2")).toHaveCount(0);
  await pop.close();
  await forgeHint(opt, "gen16-v1");
  pop = await openPopup(p);
  await expect(pop.locator("#secret-2")).toBeVisible();
  await pop.locator("#secret-plain").click();
  await expect(pop.locator("#secret")).toBeFocused();
  await pop.locator("#secret").fill(spaced);
  await pop.locator("button[type=submit]").click();
  await expect(pop.locator("#q")).toBeVisible();
  expect(await hintIn(pop)).toBe("gen5words-v1");
});

test("a prompt that asks for it again (a new recovery code) is grouped too, and takes a typed code", async () => {
  const opt = await openOptions(p);
  const pw = await firstRunGenerated(opt);
  await opt.goto(`chrome-extension://${p.id}/options/index.html#security-keys`);
  await openFold(opt, "fold-code");
  const [c1, c2] = boxes(opt, "code-pw");
  await expect(c2!).toBeVisible();
  await c1!.click();
  await opt.keyboard.type(pw.replace(/-/g, "").toLowerCase());
  await opt.locator("#new-code").click();
  await expect(opt.locator("#recovery-code")).toBeVisible();
});

/** Every file under the profile holding `secret` (UTF-16LE, as Blink keeps page state; and UTF-8 when `utf8`). */
function onDisk(dir: string, secret: string, utf8: boolean): string[] {
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
  const forms = [Buffer.from(secret, "utf16le"), ...(utf8 ? [Buffer.from(secret, "utf8")] : [])];
  return walk(dir).filter((f) => {
    try {
      const x = readFileSync(f);
      return forms.some((b) => x.includes(b));
    } catch {
      return false;
    }
  });
}

test("an input method: the boxes are left alone while it composes and take what it commits, Show on (settings) or masked (popup)", async () => {
  const opt = await openOptions(p);
  const pw = await firstRunGenerated(opt);
  const code = pw.replace(/-/g, "");
  await lockNow();
  /** An input method's steps in `page` (Chrome's own composition, through CDP), then its commit. */
  const compose = async (page: Page, steps: string[], commit: string) => {
    const cdp = await page.context().newCDPSession(page);
    for (const text of steps)
      await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    await cdp.send("Input.insertText", { text: commit });
    await cdp.detach();
  };
  const three = code.slice(0, 3).toLowerCase();
  // the settings page with Show on: text boxes, where an input method runs
  await opt.locator(".pw-groups button[aria-pressed]").click();
  await opt.locator("#unlock-pw").focus();
  await compose(opt, [three.slice(0, 1), three.slice(0, 2), three], three);
  expect(await groupsOf(opt, "unlock-pw")).toEqual([code.slice(0, 3), "", "", ""]);
  // a word with nothing of the code in it, committed: nothing changes
  await compose(opt, ["\u8fdb", "\u8fdb\u884c"], "\u8fdb\u884c");
  expect(await groupsOf(opt, "unlock-pw")).toEqual([code.slice(0, 3), "", "", ""]);
  await compose(opt, [code[3]!.toLowerCase(), code.slice(3, 6).toLowerCase()], code.slice(3, 6).toLowerCase());
  expect(await groupsOf(opt, "unlock-pw")).toEqual([code.slice(0, 4), code.slice(4, 6), "", ""]);
  // the popup's masked boxes, the same
  const pop = await openPopup(p);
  await expect(pop.locator("#secret")).toBeFocused();
  await compose(pop, [three.slice(0, 2), three], three);
  expect(await groupsOf(pop, "secret")).toEqual([code.slice(0, 3), "", "", ""]);
});

test("typed into the groups with Show pressed, nothing of the password reaches the profile on disk", async () => {
  const opt = await openOptions(p);
  const pw = await firstRunGenerated(opt);
  await lockNow();
  await opt.locator("#unlock-pw").click();
  await opt.keyboard.type(pw.replace(/-/g, ""));
  await opt.locator(".pw-groups button[aria-pressed]").click();
  await expect(opt.locator("#unlock-pw")).toHaveAttribute("type", "text");
  await opt.evaluate(() => (location.hash = "#elsewhere"));
  // the popup's boxes too (masked: the popup has no Show)
  const pop = await openPopup(p);
  await pop.locator("#secret").click();
  await pop.keyboard.type(pw.replace(/-/g, ""));
  expect(await groupsOf(pop, "secret")).toEqual(pw.split("-"));
  await expect(pop.locator("#secret")).toHaveAttribute("type", "password");
  await opt.waitForTimeout(1000);
  const dir = p.dir;
  await close(p, false);
  // the boxes' values one by one (4 symbols each: UTF-16 only, where a chance match is out of reach), and the whole
  expect(pw.split("-").flatMap((g) => onDisk(dir, g, false))).toEqual([]);
  expect(onDisk(dir, pw, true)).toEqual([]);
  expect(onDisk(dir, pw.replace(/-/g, ""), true)).toEqual([]);
  p = await launch(dir); // for afterEach
});
