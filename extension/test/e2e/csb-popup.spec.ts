// The backup in Chrome's sync storage in the popup and the side panel, in the real extension (dist-e2e/), in Playwright's
// Chromium, signed in to no Google account (storage.sync stays on this computer: test/e2e/csb-probe.spec.ts).
//   - The pill and the footer from the worker's two records, written here as the worker writes them (its alarms cleared,
//     its daily check recent, so it does not write them again meanwhile): off, handed over, stopped, this browser's
//     refusal; a change followed while the side panel stays open; another browser's word. And the open reads nothing more
//     for them: the popup's chrome.storage.local reads are counted, as perf.spec.ts counts them, with the backup on and off.
//   - The footer's one click: off, never turned off, no backup for a week, a profile only the person uses: "Back up now"
//     opens Settings › Backup, whose card turns the backup on; once the person turned it off (on the card, or by clearing
//     first run's box), the popup's own reminder only opens the card.
//   - No reminder while the backup runs: on, healthy, nothing changed for a week (so no copy handed over and no backup
//     time since), in the popup, the side panel and the settings page's rail (its last backup's line neutral), also
//     after the card's own 立即备份.
//   - A change written just after the open's read of the records, before the pill listens: shown all the same.
//   - The welcome on a computer with no vault: a copy in Chrome sync, made in Node with the same code, is offered first,
//     within the popup's size in both languages, and its restore opens first run's restore with it found.
// Playwright's Chromium is no Google Chrome: the popup writes "Chrome Sync" as "Browser sync" there, so each page is told
// it is Chrome first where the words are checked (the brands' only reader is the backup's text).
import { expect, test, type Page } from "@playwright/test";
import { makeCloudBackup } from "../../src/core/cloud/format";
import { planSlot } from "../../src/core/cloud/slots";
import { account, protectedKeys, seal, vaultOf } from "../helpers/cloud";
import { addByPaste, close, finishWizard, GITHUB_URI, launch, startFresh, type Profile } from "./harness";
import { layoutIssues } from "./visual-helpers";

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

let p: Profile;
test.afterEach(async () => {
  await close(p);
});

/**
 * A page of the extension at `path`, told it is Google Chrome (or not) before its scripts run, and, with `count`, its
 * chrome.storage.local reads counted (perf.spec.ts's way).
 */
async function page(path: string, o: { chrome?: boolean; count?: boolean } = {}): Promise<Page> {
  const pg = await p.ctx.newPage();
  await pg.addInitScript((c) => {
    Object.defineProperty(navigator, "userAgentData", {
      configurable: true,
      get: () => ({ brands: [{ brand: "Chromium" }, ...(c ? [{ brand: "Google Chrome" }] : [])] }),
    });
  }, o.chrome ?? true);
  if (o.count)
    await pg.addInitScript(() => {
      const g = globalThis as unknown as { __reads: number; __keys: unknown[] };
      g.__reads = 0;
      g.__keys = [];
      const area = chrome.storage?.local;
      if (!area) return;
      const get = area.get.bind(area) as (k?: unknown) => Promise<Record<string, unknown>>;
      (area as unknown as { get: unknown }).get = async (k?: unknown) => {
        const r = await get(k);
        g.__reads++;
        g.__keys.push(k ?? null);
        return r;
      };
    });
  await pg.goto(`chrome-extension://${p.id}/${path}`);
  return pg;
}
/** The reads once the page has stopped reading: unchanged for half a second. */
async function readsSettled(pg: Page): Promise<number> {
  const at = () => pg.evaluate(() => (globalThis as unknown as { __reads: number }).__reads);
  let last = await at();
  for (let same = 0, i = 0; same < 5 && i < 60; i++) {
    await pg.waitForTimeout(100);
    const now = await at();
    same = now === last ? same + 1 : 0;
    last = now;
  }
  return last;
}

/** The records written as the worker writes them, its alarms cleared and its daily check recent. */
async function put(pg: Page, cfg: Record<string, unknown> | null, st: Record<string, unknown> = {}) {
  await pg.evaluate(
    async ({ cfg, st }) => {
      await chrome.alarms.clear("sk-csb-soon");
      await chrome.alarms.clear("sk-csb-retry");
      if (cfg === null) await chrome.storage.local.remove(["sk_csb_cfg", "sk_csb_state"]);
      else await chrome.storage.local.set({ sk_csb_cfg: cfg, sk_csb_state: st });
    },
    { cfg: cfg && { ...NEW_CFG, ...cfg }, st: { ...NEW_STATE, ...st } },
  );
}
const now = (pg: Page) => pg.evaluate(() => Date.now());

test("the pill and the footer, in the popup and the side panel, from the records; read with the open's own read", async () => {
  test.setTimeout(180_000);
  p = await launch();
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  let pop = await page("popup/index.html");
  await expect(pop.locator("#q")).toBeVisible();
  const t = await now(pop);
  // off and never set up (a vault made before the backup existed: no records); no backup for a week (none yet): the
  // popup's own pill, the one click in the footer
  await put(pop, null);
  await pop.reload();
  await expect(pop.locator("#csb-now")).toBeVisible();
  await expect(pop.locator("#csb-pill")).toHaveCount(0);
  await expect(pop.locator(".ph .loc")).toHaveCount(1);

  // handed over
  await put(pop, { on: true }, { lastOk: t - 3 * MIN, lastRun: t });
  await pop.reload();
  await expect(pop.locator("#csb-pill")).toHaveText("Chrome Sync");
  await expect(pop.locator("#csb-pill")).toHaveAttribute("title", "Handed to Chrome Sync · 3 minutes ago");
  await expect(pop.locator("#csb-pill")).toHaveAttribute("class", "loc");
  await expect(pop.locator("#csb-problem")).toHaveCount(0);
  await expect(pop.locator("#csb-now")).toHaveCount(0);

  // stopped: amber, and the footer's problem line opens Settings › Backup
  await put(
    pop,
    { on: true },
    { err: "no_room", errSince: t, lastRun: t, others: { n: 2, bytes: 97_000, otherVaults: 0, latest: t - DAY } },
  );
  await pop.reload();
  await expect(pop.locator("#csb-pill")).toHaveText("Backup stopped");
  await expect(pop.locator("#csb-pill")).toHaveAttribute("class", "loc stop");
  await expect(pop.locator("#csb-problem")).toHaveText("1 account · backup problem");
  const [opt] = await Promise.all([p.ctx.waitForEvent("page"), pop.locator("#csb-problem").click()]);
  await opt.waitForLoadState();
  expect(opt.url()).toBe(`chrome-extension://${p.id}/options/index.html#backup`);
  await expect(opt.locator("#csb-card")).toHaveAttribute("data-state", "no_room");
  await opt.close();
  if (!pop.isClosed()) await pop.close(); // (the popup closes itself as it opens the settings page)
  pop = await page("popup/index.html");

  // this browser would not close the area: stopped too
  await put(pop, { on: true }, { unsafe: true, lastOk: t - DAY, lastRun: t });
  await pop.reload();
  await expect(pop.locator("#csb-pill")).toHaveText("Backup stopped");
  await expect(pop.locator("#csb-problem")).toBeVisible();

  // another browser: its word, no Chrome
  const other = await page("popup/index.html", { chrome: false });
  await put(other, { on: true }, { lastOk: t - 3 * MIN, lastRun: t });
  await other.reload();
  await expect(other.locator("#csb-pill")).toHaveText("Browser sync");
  await expect(other.locator("#csb-pill")).toHaveAttribute("title", "Handed to browser sync · 3 minutes ago");
  await other.close();

  // the side panel follows a change of the records while it stays open, with no reload
  const panel = await page("sidepanel/index.html");
  await expect(panel.locator("#csb-pill")).toHaveText("Chrome Sync");
  await put(panel, { on: true }, { err: "held", errSince: t, lastRun: t });
  await expect(panel.locator("#csb-pill")).toHaveText("Backup stopped");
  await expect(panel.locator("#csb-problem")).toBeVisible();
  await put(panel, null);
  await expect(panel.locator("#csb-pill")).toHaveCount(0);
  await expect(panel.locator("#csb-now")).toBeVisible();
  await panel.close();
  await pop.close();

  // an open reads as many times with the backup on as off: its records come with the settings, in the one get that
  // names them (the pill and the footer read none of their own)
  const reads: number[] = [];
  for (const cfg of [null, { on: true }]) {
    const set = await page("popup/index.html");
    await put(set, cfg, { lastOk: t - 3 * MIN, lastRun: t });
    await set.close();
    const counted = await page("popup/index.html", { count: true });
    await expect(counted.locator(".row .code:not(.wait)").first()).toBeVisible();
    await expect(counted.locator(cfg ? "#csb-pill" : "#csb-now")).toBeVisible();
    reads.push(await readsSettled(counted));
    const naming = await counted.evaluate(() =>
      (globalThis as unknown as { __keys: unknown[] }).__keys.filter(
        (k) => Array.isArray(k) && (k.includes("sk_csb_cfg") || k.includes("sk_csb_state")),
      ),
    );
    expect(naming, JSON.stringify(cfg)).toHaveLength(1);
    expect(naming[0]).toEqual(expect.arrayContaining(["sk_settings", "sk_last_backup", "sk_csb_cfg", "sk_csb_state"]));
    await counted.close();
  }
  expect(reads[1], `reads off ${reads[0]}, on ${reads[1]}`).toBe(reads[0]);
});

/** The popup's own reminder clicked: Settings › Backup opens with the card off, and stays so (no handoff taken). */
async function ownReminderLeavesItOff(pop: Page) {
  await expect(pop.locator("#csb-pill")).toHaveCount(0);
  await expect(pop.locator("#csb-now")).toHaveCount(0);
  const own = pop.locator(".pf a.bk.old");
  await expect(own).toHaveText("1 account · back up now");
  const [card] = await Promise.all([p.ctx.waitForEvent("page"), own.click()]);
  await card.waitForLoadState();
  await expect(card.locator("#csb-card")).toHaveAttribute("data-state", "off");
  await card.waitForTimeout(1_000); // (a card that took a handoff would have sent its message by now)
  expect(
    await card.evaluate(async () => (await chrome.storage.local.get("sk_csb_cfg")).sk_csb_cfg as { on: boolean }),
  ).toMatchObject({ on: false, declined: true });
  await card.close();
}

test("the footer's one click turns the backup on in the card; once the person turned it off, the reminder only opens the card", async () => {
  test.setTimeout(180_000);
  p = await launch();
  await startFresh(p); // first run's box cleared: the person's turning it off
  await addByPaste(p, GITHUB_URI);
  let pop = await page("popup/index.html");
  await ownReminderLeavesItOff(pop);
  if (!pop.isClosed()) await pop.close();

  // a vault made before the backup existed (no records): the one click
  pop = await page("popup/index.html");
  await put(pop, null);
  await pop.reload();
  const link = pop.locator("#csb-now");
  await expect(link).toHaveText("1 account · back up now");
  const [opt] = await Promise.all([p.ctx.waitForEvent("page"), link.click()]);
  await opt.waitForLoadState();
  expect(opt.url()).toBe(`chrome-extension://${p.id}/options/index.html#backup`);
  // the card took the click and turned the backup on (one click, no dialog); the handoff is gone
  await expect
    .poll(() =>
      opt.evaluate(async () => ((await chrome.storage.local.get("sk_csb_cfg")).sk_csb_cfg as { on?: boolean })?.on),
    )
    .toBe(true);
  await expect(opt.locator("#csb-card")).not.toHaveAttribute("data-state", "off");
  await expect(opt.locator("#cs-cost")).toBeVisible(); // the cost line, in view as it turns on
  expect(await opt.evaluate(() => chrome.storage.session.get("sk_cloud_go"))).toEqual({});
  // and the worker hands the copy over: the pill says so
  await expect
    .poll(() => opt.evaluate(async () => Object.keys(await chrome.storage.sync.get(null)).length), { timeout: 30_000 })
    .toBeGreaterThan(0);
  if (!pop.isClosed()) await pop.close(); // (the popup closes itself as it opens the settings page)
  pop = await page("popup/index.html");
  await expect(pop.locator("#csb-pill")).toHaveText("Chrome Sync");
  await expect(pop.locator("#csb-pill")).toHaveAttribute("title", /^Handed to Chrome Sync · /);

  // the person turns it off: the copy goes; with no backup for a week again, the popup's own reminder only opens the card
  await opt.locator("#cs-off").click();
  await expect(opt.locator("#csb-card")).toHaveAttribute("data-state", "off");
  await opt.close();
  await pop.evaluate((t) => chrome.storage.local.set({ sk_last_backup: t }), (await now(pop)) - 8 * DAY);
  await pop.reload();
  await ownReminderLeavesItOff(pop);
  if (!pop.isClosed()) await pop.close();
});

test("the backup runs, nothing changed for a week: no reminder in the popup, the side panel or the settings page, also after the card's 立即备份", async () => {
  test.setTimeout(240_000);
  p = await launch();
  const welcome = await page("popup/index.html");
  const [setup] = await Promise.all([p.ctx.waitForEvent("page"), welcome.locator("#start-secure").click()]);
  await setup.waitForLoadState();
  await finishWizard(setup, { csb: true }); // the box left ticked: on
  await setup.close();
  await addByPaste(p, GITHUB_URI);
  const opt = await page("options/index.html#backup");
  await expect
    .poll(() => opt.evaluate(async () => Object.keys(await chrome.storage.sync.get(null)).length), { timeout: 60_000 })
    .toBeGreaterThan(0);
  // (the empty vault was handed over at "完成"; the account's copy follows after the debounce)
  await expect(opt.locator("#csb-card")).toHaveAttribute("data-state", "ok", { timeout: 60_000 });
  // a week on with nothing changed: the last copy and the last backup a week and more ago, the daily check run since
  const t = await now(opt);
  await opt.evaluate(async (t) => {
    const st = (await chrome.storage.local.get("sk_csb_state")).sk_csb_state as Record<string, unknown>;
    const week = t - 8 * 24 * 60 * 60_000;
    await chrome.storage.local.set({
      sk_last_backup: week,
      sk_csb_state: { ...st, lastOk: week, lastRun: t - 2 * 86_400_000 },
    });
  }, t);
  /** The footer of a popup or side panel page: what it says, and whether it holds any link (a reminder). */
  const footer = async (path: string) => {
    const pg = await page(path);
    await expect(pg.locator("#csb-pill")).toHaveText("Chrome Sync");
    await expect(pg.locator("#csb-pill")).toHaveAttribute("title", "Handed to Chrome Sync · 8 days ago");
    await expect(pg.locator(".pf span.bk")).toHaveText("1 account");
    const out = {
      links: await pg.locator(".pf a.bk").count(),
      text: await pg.locator(".pf .bk").first().textContent(),
    };
    await pg.close();
    return out;
  };
  for (const path of ["popup/index.html", "sidepanel/index.html"])
    expect(await footer(path), path).toEqual({ links: 0, text: "1 account" });
  // the settings page's rail: its backup line neutral, not amber
  await opt.reload();
  await expect(opt.locator(".rail .fresh")).toHaveClass(/\bnone\b/);
  // the card's own 立即备份: the worker runs, finds nothing to hand over, and still nothing reminds
  await opt.locator("#cs-now").click();
  await expect
    .poll(() =>
      opt.evaluate(
        async () => ((await chrome.storage.local.get("sk_csb_state")).sk_csb_state as { lastRun: number }).lastRun,
      ),
    )
    .toBeGreaterThan(t - 60_000);
  expect(await footer("popup/index.html")).toEqual({ links: 0, text: "1 account" });
  await expect(opt.locator(".rail .fresh")).toHaveClass(/\bnone\b/);
});

test("a change written just after the open's read of the records, before the pill listens: shown all the same", async () => {
  test.setTimeout(180_000);
  p = await launch();
  await startFresh(p);
  await addByPaste(p, GITHUB_URI);
  const setter = await page("popup/index.html");
  const t = await now(setter);
  await setter.close();
  for (const path of ["sidepanel/index.html", "popup/index.html"]) {
    const reset = await page("popup/index.html");
    await put(reset, { on: true }, { lastOk: t - 3 * MIN, lastRun: t });
    await reset.close();
    // as the worker would: a run's state written right as the open's read of the settings (with the records) returns
    const pg = await p.ctx.newPage();
    await pg.addInitScript(() => {
      Object.defineProperty(navigator, "userAgentData", {
        configurable: true,
        get: () => ({ brands: [{ brand: "Chromium" }, { brand: "Google Chrome" }] }),
      });
      const area = chrome.storage?.local;
      if (!area) return;
      const get = area.get.bind(area) as (k?: unknown) => Promise<Record<string, unknown>>;
      let done = false;
      (area as unknown as { get: unknown }).get = async (k?: unknown) => {
        const r = await get(k);
        if (!done && Array.isArray(k) && k.includes("sk_csb_state") && k.includes("sk_settings")) {
          done = true;
          const st = r.sk_csb_state as Record<string, unknown>;
          void area.set({ sk_csb_state: { ...st, err: "no_room", errSince: Date.now() } });
        }
        return r;
      };
    });
    await pg.goto(`chrome-extension://${p.id}/${path}`);
    await expect(pg.locator("#csb-pill"), path).toHaveText("Backup stopped");
    await expect(pg.locator("#csb-problem"), path).toBeVisible();
    await pg.close();
  }
});

test("the welcome: a copy in Chrome sync is offered first, within the popup's size; its restore opens first run's restore with it found", async () => {
  test.setTimeout(180_000);
  p = await launch();
  // another computer's copy, made in Node with the same code, as Chrome sync delivers it
  const keys = await protectedKeys();
  const gen = await seal(
    keys,
    vaultOf(keys.keyring.vaultId, [account("GitHub", "JBSWY3DPEHPK3PXP")]),
    3,
    Date.now() - DAY,
  );
  const plan = await planSlot(await makeCloudBackup(gen, "both", "Sixkey 0.0.0"), "abcd2345", "abababababababab");
  if (plan.kind !== "plan") throw new Error("the copy does not fit");
  for (const lang of ["en", "zh_CN"] as const) {
    const welcome = await page("popup/index.html");
    await welcome.evaluate((l) => localStorage.setItem("sk_lang", l), lang);
    await welcome.evaluate((i) => chrome.storage.sync.set(i), plan.items);
    await welcome.reload();
    await expect(welcome.locator("#csb-found")).toHaveText(
      lang === "en"
        ? "Found a Sixkey backup in Chrome Sync (latest yesterday)."
        : "在 Chrome 同步里找到了 Sixkey 的备份（最近一份 昨天）。",
    );
    await expect(welcome.locator("#csb-restore")).toHaveText(
      lang === "en" ? "Restore from Chrome Sync" : "从 Chrome 同步恢复",
    );
    await expect(welcome.locator("#start-secure")).toHaveAttribute("class", "btn ghost");
    const order = await welcome.evaluate(() =>
      [...document.querySelectorAll("#csb-restore, #start-secure, #start-restore")].map((e) => e.id),
    );
    expect(order).toEqual(["csb-restore", "start-secure", "start-restore"]);
    // within the popup as the toolbar shows it: 376 px wide, at most 600 tall (its body hides what is past that, so the
    // body's own content must fit, its last button inside it), in both themes
    for (const colorScheme of ["light", "dark"] as const) {
      await welcome.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await welcome.setViewportSize({ width: 376, height: 600 });
      const fit = await welcome.evaluate(() => ({
        content: document.body.scrollHeight,
        body: document.body.clientHeight,
        last: Math.ceil(document.querySelector("#start-restore")!.getBoundingClientRect().bottom),
      }));
      expect(fit.content, `${lang} ${colorScheme}`).toBeLessThanOrEqual(fit.body + 1);
      expect(fit.last, `${lang} ${colorScheme}`).toBeLessThanOrEqual(Math.min(fit.body, 600));
      await welcome.setViewportSize({ width: 376, height: fit.body });
      expect(await layoutIssues(welcome, { popup: true }), `${lang} ${colorScheme}`).toEqual([]);
    }
    if (lang === "zh_CN") {
      await welcome.close();
      break;
    }
    const [opt] = await Promise.all([p.ctx.waitForEvent("page"), welcome.locator("#csb-restore").click()]);
    await opt.waitForLoadState();
    await expect(opt.locator("#cs-found-n")).toBeVisible();
    await expect(opt.locator("#cs-restore-secret")).toBeVisible();
    await opt.close();
    if (!welcome.isClosed()) await welcome.close();
  }
});
