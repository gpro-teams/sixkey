// The master password is the user's own (OWNER-DECISIONS/15; docs/design/notes/OWN-PASSWORD-NOTES.md), in the browser:
// the first run with a password of one's own below 50 bits (the warning, "Use anyway"), wrapped at the new count and
// opening after a browser restart; an existing user's generated password (wrapped at 600k, as before this change)
// changed to one of their own, re-wrapped at the new count; and the lock screen's line for a PIN that needs the master
// password once, in the popup and in the settings page's unlock bar, never in a shared profile.
import { expect, test, type Page } from "@playwright/test";
import { VaultService } from "../../src/core/service/service";
import { buildRuntime } from "../../src/platform/runtime-base";
import {
  close,
  launch,
  openFold,
  openOptions,
  openPopup,
  type Profile,
  showSection,
  startFresh,
  STRONG,
  skipFirstPin,
} from "./harness";

const OWN = "JennyLovesTea"; // 13 characters, about 34 bits: the owner's case
const GEN = "JDXT-NBSG-6JQG-XBTV"; // an existing user's generated password
const PIN = "246813";

let p: Profile;
test.beforeEach(async () => {
  p = await launch();
});
test.afterEach(async () => {
  await close(p);
});

/** The stored keyring's password wrap's PBKDF2 count, read from an extension page. */
const wrapCount = (page: Page) =>
  page.evaluate(async () => {
    const k = (await chrome.storage.local.get("sk_keyring")).sk_keyring as {
      keyring: { wraps: { method: string; kdf?: { iterations?: number } }[] };
    };
    return k.keyring.wraps.find((w) => w.method === "password")?.kdf?.iterations ?? null;
  });

/**
 * A vault as a version before this change made it: its master password wrapped at 600k. Built in Node with the core code
 * over memory areas (the test hook for the count), then written into chrome.storage.local from an extension page.
 */
async function seedOlderVault(password: string): Promise<void> {
  const data = new Map<string, unknown>();
  const mem = {
    async get(keys?: string | string[] | null) {
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(ks.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  } as unknown as chrome.storage.StorageArea;
  const session = {
    ...mem,
    get: async () => ({}),
    set: async () => undefined,
  } as unknown as chrome.storage.StorageArea;
  const rt = buildRuntime(
    { local: mem, session, mirror: null },
    (d) => new VaultService({ ...d, kdfIterations: 600_000 }),
  );
  await rt.service.create(await rt.service.prepareKeys(password), { preset: "standard" });
  const items = JSON.parse(JSON.stringify(Object.fromEntries(data))) as Record<string, unknown>;
  const page = await p.ctx.newPage();
  await page.goto(`chrome-extension://${p.id}/popup/index.html`);
  await page.evaluate((x) => chrome.storage.local.set(x), items);
  await page.close();
}

async function unlockPopup(page: Page, pw: string) {
  await page.locator("#secret").fill(pw);
  await page.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
}

test("first run with a password of one's own below 50 bits: the warning, 'Use anyway', 2M iterations, opens after a restart", async () => {
  const opt = await openOptions(p, "#setup");
  await expect(opt.locator("#fr-pw")).toBeVisible(); // the first run's part is in
  // one's own first: the fields, then "Generate for me" as a secondary button
  const order = await opt.evaluate(() => {
    const gen = document.getElementById("fr-gen")!;
    return {
      after: !!(gen.compareDocumentPosition(document.getElementById("fr-pw2")!) & Node.DOCUMENT_POSITION_PRECEDING),
      secondary: gen.classList.contains("ghost"),
    };
  });
  expect(order).toEqual({ after: true, secondary: true });
  await expect(opt.locator("#fr-strength")).toHaveText(/At least 12 characters|至少 12 个字符/);

  // refused by the floor: why, and no "Use anyway"
  await opt.locator("#fr-pw").fill("Jenny2Loves");
  await opt.locator("#fr-pw2").fill("Jenny2Loves");
  await expect(opt.locator("#fr-strength")).toHaveText(/Too short: at least 12 characters|太短：至少 12 个字符/);
  await expect(opt.locator("#fr-anyway")).toHaveCount(0);
  await expect(opt.locator("#fr-next")).toBeDisabled();
  // under 10^6 guesses, a common password with digits: refused outright (OWNER-DECISIONS/15 item 1)
  await opt.locator("#fr-pw").fill("Password1234");
  await opt.locator("#fr-pw2").fill("Password1234");
  await expect(opt.locator("#fr-strength")).toHaveText(/Too easy to guess|太容易猜/);
  await expect(opt.locator("#fr-anyway")).toHaveCount(0);
  await expect(opt.locator("#fr-next")).toBeDisabled();

  // past the floor, below the bar: the warning, with how long one graphics card takes
  await opt.locator("#fr-pw").fill(OWN);
  await opt.locator("#fr-pw2").fill(OWN);
  await expect(opt.locator("#fr-strength")).toHaveText(
    /Estimated 34 bits, below the 50|估算强度 34 位，低于建议的 50 位/,
  );
  await expect(opt.locator("#fr-weak")).toBeVisible();
  await expect(opt.locator("#fr-weak-why")).toContainText(/copies this browser profile|拷走这个浏览器配置文件/);
  await expect(opt.locator("#fr-weak-why")).toContainText(/about 40 days|大约 40天/);
  await expect(opt.locator("#fr-next")).toBeDisabled();
  await opt.locator("#fr-pw2").press("Enter"); // no way around the button
  await expect(opt.locator("#recovery-code")).toHaveCount(0);
  // "Use anyway": a toggle, in the page (no dialog), for this value only
  let dialogs = 0;
  opt.on("dialog", () => void dialogs++);
  await opt.locator("#fr-anyway").click();
  await expect(opt.locator("#fr-anyway")).toHaveAttribute("aria-pressed", "true");
  await expect(opt.locator("#fr-next")).toBeEnabled();
  await opt.locator("#fr-pw").press("End");
  await opt.locator("#fr-pw").pressSequentially("x");
  await expect(opt.locator("#fr-next")).toBeDisabled(); // an edit lets go of it
  await opt.locator("#fr-pw").press("Backspace");
  await expect(opt.locator("#fr-anyway")).toHaveAttribute("aria-pressed", "false");
  await expect(opt.locator("#fr-next")).toBeDisabled();
  await opt.locator("#fr-anyway").click();
  await opt.locator("#fr-next").click();
  expect(dialogs).toBe(0);
  await opt.locator("#recovery-saved").check();
  await opt.locator("#recovery-done").click();
  await opt.locator("#fr-solo").check();
  await opt.locator("#fr-finish").click();
  await skipFirstPin(opt);
  await expect(opt.locator("#fr-hint")).toBeVisible();
  expect(await wrapCount(opt)).toBe(2_000_000);

  // a browser restart: the popup's lock screen takes it, at the new count, in real Chrome
  const dir = p.dir;
  await close(p, false);
  p = await launch(dir);
  const pop = await openPopup(p);
  const t0 = Date.now();
  await unlockPopup(pop, OWN);
  await expect(pop.locator("#q")).toBeVisible();
  test.info().annotations.push({ type: "unlock-ms", description: String(Date.now() - t0) });
});

test("an existing user's generated password, wrapped at 600k, changed to one of their own: re-wrapped at 2M only then", async () => {
  await seedOlderVault(GEN);
  const pop = await openPopup(p);
  expect(await wrapCount(pop)).toBe(600_000);
  await unlockPopup(pop, GEN.toLowerCase().replace(/-/g, "")); // typed loosely, as before
  await expect(pop.locator("#q")).toBeVisible();
  expect(await wrapCount(pop)).toBe(600_000); // an unlock never re-wraps
  await pop.close();

  const opt = await openOptions(p, "#security");
  await showSection(opt, "security-keys");
  await openFold(opt, "fold-change");
  await opt.locator("#old-pw").fill(GEN);
  await opt.locator("#change-pw").fill(OWN);
  await opt.locator("#change-pw2").fill(OWN);
  const change = opt.getByRole("button", { name: /^(Change password|修改密码)$/ });
  await expect(opt.locator("#change-weak")).toBeVisible();
  await expect(change).toBeDisabled();
  await opt.locator("#change-anyway").click();
  await expect(change).toBeEnabled();
  await change.click();
  await expect(opt.locator(".ok-msg")).toBeVisible();
  expect(await wrapCount(opt)).toBe(2_000_000);

  const again = await openPopup(p);
  await again.locator("#lock-now").click();
  await unlockPopup(again, GEN);
  await expect(again.getByRole("alert")).toBeVisible(); // the old one no longer opens
  await unlockPopup(again, OWN);
  await expect(again.locator("#q")).toBeVisible();
});

test("the lock screen's line: a PIN that needs the master password once (the end of quick unlock, also after a restart), never in a shared profile", async () => {
  await startFresh(p);
  const opt = await openOptions(p, "#security");
  await expect(opt.locator("#pin-box")).toBeVisible();
  await openFold(opt, "pin-box");
  await opt.locator("#pin-pw").fill(STRONG);
  await opt.locator("#pin-new").fill(PIN);
  await opt.locator("#pin-new2").fill(PIN);
  await opt.locator("#pin-set").click();
  await expect(opt.locator("#pin-info")).toBeVisible();

  // a live PIN: its own screen, no line
  const pop = await openPopup(p);
  await pop.locator("#lock-now").click();
  await expect(pop.locator("#pin")).toBeVisible();
  await expect(pop.locator("#pin-waiting")).toHaveCount(0);
  await expect(opt.locator("#unlock-pin")).toBeVisible();
  await expect(opt.locator("#unlock-pin-waiting")).toHaveCount(0);

  // the quick unlock ended: the master password's field, and the line, in the popup and the settings page
  await opt.locator("#quick-end").click();
  await expect(opt.locator("#unlock-pw")).toBeVisible();
  await expect(opt.locator("#unlock-pin-waiting")).toHaveText(
    /The PIN works again once you type the master password|输一次主密码后，PIN 就能重新使用/,
  );
  await pop.reload();
  await expect(pop.locator("#secret")).toBeVisible();
  await expect(pop.locator("#pin-waiting")).toBeVisible();
  await pop.close();

  // a browser restart: still waiting (the PIN's record set aside stays so until the master password)
  await opt.close();
  const dir = p.dir;
  await close(p, false);
  p = await launch(dir);
  const after = await openPopup(p);
  await expect(after.locator("#pin-waiting")).toBeVisible();
  await unlockPopup(after, STRONG); // the master password brings the PIN back
  await expect(after.locator("#q")).toBeVisible();
  // its note makes the PIN's record again after the unlock (two derivations): done before the lock
  await expect
    .poll(() =>
      after.evaluate(async () => {
        const r = (await chrome.storage.local.get("sk_pin_restart")).sk_pin_restart as { wrap?: unknown } | undefined;
        return !!r?.wrap;
      }),
    )
    .toBe(true);
  await after.locator("#lock-now").click();
  await expect(after.locator("#pin")).toBeVisible();
  await expect(after.locator("#pin-waiting")).toHaveCount(0);

  // declared shared: the PIN is never armed, and the lock screen says nothing of it
  const page = await openOptions(p, "#security");
  await page.locator("#unlock-pin").fill(PIN);
  await page.locator("#unlock-btn").click();
  await expect(page.locator("#unlock-pin")).toHaveCount(0);
  await page.locator("#sm-shared").check();
  await expect(page.locator("#unlock-pw")).toBeVisible();
  await expect(page.locator("#unlock-pin-waiting")).toHaveCount(0);
  await after.reload();
  await expect(after.locator("#secret")).toBeVisible();
  await expect(after.locator("#pin-waiting")).toHaveCount(0);
});
