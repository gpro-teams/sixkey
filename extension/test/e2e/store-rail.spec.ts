// The settings page's rail in the store build (dist/; every build's rail is the same since the Sync section went from
// all of them: OWNER-DECISIONS/25), in the real extension, loaded unpacked as store-backup.spec.ts loads it. No line of
// the live sync: in its place the backup in Chrome sync's, in every state of its card, from the worker's two records written
// here as the worker writes them (its alarms cleared, or far off where a change waits, so it does not write them again
// meanwhile: the method of csb-card-visual.spec.ts), in English and in Chinese, in both themes, at 1400, 420 and 320 px
// (the last two where the rail's three facts sit in a row), nothing squashed, overflowing, clipped or unstyled
// (visual-helpers.ts).
// The last backup's line keeps its date: red with none while the backup is off or stopped, neutral while it runs.
// Then the card's own "Turn on", from off: the worker hands a copy over, and the rail says so (and the last backup's
// line says today: the worker counts a copy handed over as a backup, platform/csb-worker.ts).
// Playwright's Chromium is no Google Chrome: the page is told it is Chrome first, and the label is checked as the other
// browsers see it too. With RAIL_SHOTS set to a folder, the rail's card is saved there as a picture per state, language
// and theme, for a look (nothing compares them: the probe is the check).
import { chromium, expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addByPaste, close, finishWizard, GITHUB_URI, openOptions, openPopup, type Profile } from "./harness";
import { layoutIssues } from "./visual-helpers";

const PROD = resolve(import.meta.dirname, "../../dist");
const SHOTS = process.env.RAIL_SHOTS;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NEW_STATE = {
  v: 1,
  lastOk: null,
  err: null,
  errSince: null,
  pendingSince: null,
  retries: 0,
  lastRun: null,
  bytes: null,
  used: null,
  others: { n: 0, bytes: 0, otherVaults: 0, latest: null },
  seen: false,
  unsafe: false,
};
const NEW_CFG = { v: 1, on: false, opens: "both", declined: false, link: null };

async function launchStore(): Promise<Profile> {
  const dir = mkdtempSync(join(tmpdir(), "sixkey-e2e-"));
  // Bundled Chromium only: branded Chrome 137+ ignores --load-extension.
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${PROD}`, `--load-extension=${PROD}`],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  return { dir, ctx, id: new URL(sw.url()).host };
}

type Rec = { cfg: Record<string, unknown>; st: Record<string, unknown>; alarm?: boolean };
/** Each state, its records, what the rail says in it ([en, zh_CN]), its tone, whether the last backup's is neutral. */
function states(now: number): [string, Rec, [string | RegExp, string | RegExp], string, boolean][] {
  const on = { on: true };
  return [
    ["off", { cfg: {}, st: {} }, ["Off", "未开启"], "none", false],
    ["empty", { cfg: on, st: { lastRun: now } }, ["On", "已开启"], "none", true],
    [
      "saving",
      { cfg: on, st: { pendingSince: now, lastRun: now }, alarm: true },
      ["Handing over…", "正在交给…"],
      "none",
      true,
    ],
    [
      "ok",
      { cfg: on, st: { lastOk: now - 3 * MIN, lastRun: now } },
      [/^Handed over · \d minutes ago$/, /^已交给 · \d分钟前$/],
      "good",
      true,
    ],
    [
      "waiting",
      { cfg: on, st: { lastOk: now - 9 * MIN, pendingSince: now - MIN, lastRun: now }, alarm: true },
      ["Handing over soon", "稍后自动交给"],
      "none",
      true,
    ],
    [
      "failed",
      { cfg: on, st: { lastOk: now - DAY, err: "busy", errSince: now, pendingSince: now, lastRun: now }, alarm: true },
      ["Not handed over · will retry", "没交给 · 会自动重试"],
      "warn",
      true,
    ],
    [
      "stale",
      {
        cfg: on,
        st: { lastOk: now - 5 * DAY, err: "other", errSince: now - 4 * DAY, pendingSince: now - 4 * DAY, lastRun: now },
        alarm: true,
      },
      ["Backup stopped", "备份已停"],
      "warn",
      false,
    ],
    [
      "too_large",
      { cfg: on, st: { err: "too_large", errSince: now, lastRun: now } },
      ["Backup stopped", "备份已停"],
      "warn",
      false,
    ],
    [
      "unsafe",
      { cfg: on, st: { unsafe: true, lastOk: now - DAY, lastRun: now } },
      ["Backup stopped", "备份已停"],
      "warn",
      false,
    ],
  ];
}

/** The records written as the worker writes them, its alarm far off when a change waits. */
async function put(page: Page, r: Rec) {
  await page.evaluate(
    async ({ cfg, st, alarm }) => {
      await chrome.alarms.clear("sk-csb-soon");
      await chrome.alarms.clear("sk-csb-retry");
      if (alarm) await chrome.alarms.create("sk-csb-soon", { when: Date.now() + 60 * 60_000 });
      await chrome.storage.local.set({ sk_csb_cfg: cfg, sk_csb_state: st });
    },
    { cfg: { ...NEW_CFG, ...r.cfg }, st: { ...NEW_STATE, ...r.st }, alarm: r.alarm ?? false },
  );
}

/** Each page of the profile told it is Google Chrome (or not), before its scripts run. */
async function brand(page: Page, chrome: boolean) {
  await page.addInitScript((c) => {
    Object.defineProperty(navigator, "userAgentData", {
      configurable: true,
      get: () => ({ brands: [{ brand: "Chromium" }, ...(c ? [{ brand: "Google Chrome" }] : [])] }),
    });
  }, chrome);
}

let p: Profile | undefined;
test.afterEach(async () => {
  if (p) await close(p);
  p = undefined;
});

for (const lang of ["en", "zh_CN"] as const)
  test(`store build, ${lang}: no line of the live sync; the backup in Chrome sync's in every state`, async () => {
    test.setTimeout(300_000);
    const zh = lang === "zh_CN";
    p = await launchStore();
    const welcome = await openPopup(p);
    await welcome.evaluate((l) => localStorage.setItem("sk_lang", l), lang);
    const [setup] = await Promise.all([p.ctx.waitForEvent("page"), welcome.locator("#start-secure").click()]);
    await setup.waitForLoadState();
    await finishWizard(setup, { csb: false });
    await setup.close();
    await addByPaste(p, GITHUB_URI);
    const opt = await openOptions(p, "#backup");
    await brand(opt, true);
    await opt.reload();
    await expect(opt.locator("#csb-card")).toBeVisible();
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    const rail = opt.locator(".rail .status");
    const line = opt.locator("#rail-csb");
    const fresh = opt.locator(".rail .fresh");
    // nothing of the live sync, whatever the page does: its line, its label, its group
    await expect(line).toBeVisible();
    await expect(opt.locator("#rail-sync")).toHaveCount(0);
    await expect(opt.locator(".rail .sync")).toHaveCount(0);
    await expect(opt.locator('.rail nav a[href="#sync"]')).toHaveCount(0);
    await expect(opt.locator(".rail .csb dt")).toHaveText(zh ? "Chrome 同步" : "Chrome Sync");
    await expect(fresh.locator("dd")).toHaveText(zh ? "从未" : "Never");

    const found: string[] = [];
    const now = await opt.evaluate(() => Date.now());
    for (const [name, rec, words, tone, neutral] of states(now)) {
      await put(opt, rec);
      await expect(opt.locator("#csb-card"), name).toHaveAttribute("data-state", name);
      await expect(line, name).toHaveText(words[zh ? 1 : 0]);
      await expect(opt.locator(".rail .csb"), name).toHaveClass(`csb ${tone}`);
      await expect(fresh, name).toHaveClass(neutral ? "fresh none" : "fresh bad");
      await expect(opt.locator("#rail-sync"), name).toHaveCount(0);
      for (const colorScheme of ["light", "dark"] as const) {
        await opt.emulateMedia({ colorScheme, reducedMotion: "reduce" });
        for (const width of [1400, 420, 320]) {
          await opt.setViewportSize({ width, height: 900 });
          for (const i of await layoutIssues(opt, { root: ".rail .status" }))
            found.push(`${name}, ${width} px (${colorScheme}): ${i.kind} ${i.el}: ${i.detail}`);
        }
        if (SHOTS) {
          await opt.setViewportSize({ width: 1400, height: 900 });
          await rail.screenshot({ path: join(SHOTS, `${lang}-${colorScheme}-${name}.png`) });
        }
      }
    }
    expect(found).toEqual([]);

    // as another browser sees it: its own word for Chrome Sync
    await opt.close();
    const other = await openOptions(p, "#backup");
    await brand(other, false);
    await other.reload();
    await expect(other.locator(".rail .csb dt")).toHaveText(zh ? "浏览器同步" : "Browser sync");

    // from off, the card's own button: the worker hands a copy over, and the rail says so, with when
    await put(other, { cfg: {}, st: {} });
    await expect(other.locator("#rail-csb")).toHaveText(zh ? "未开启" : "Off");
    await expect(other.locator(".rail .fresh")).toHaveClass("fresh bad");
    await other.locator("#cs-on").click();
    await expect(other.locator("#csb-card")).toHaveAttribute("data-state", "ok", { timeout: 60_000 });
    await expect(other.locator("#rail-csb")).toHaveText(zh ? /^已交给 · .+$/ : /^Handed over · .+$/);
    await expect(other.locator(".rail .csb")).toHaveClass("csb good");
    await expect(other.locator(".rail .fresh")).toHaveClass("fresh good");
    await expect(other.locator(".rail .fresh dd")).toHaveText(zh ? "今天" : "Today");
    await expect(other.locator("#rail-sync")).toHaveCount(0);
  });
