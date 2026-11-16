// Settings › Backup's card for the backup in Chrome's sync storage, in every state, as drawn in the real extension
// (dist-e2e/): in English and in Chinese, in both themes, at 320, 420, 600 and 1400 px, nothing squashed, overflowing,
// clipped or unstyled (visual-helpers.ts, the probe the visual guard uses), and at 1400 x 900 the Backup leaf within a
// screen and a half (1,350 px) with the card in any state. Each state comes from the worker's two records, written here
// as the worker writes them; the worker is kept from rewriting them meanwhile (a recent run and no change waiting, or a
// change waiting with its alarm far off). Playwright's Chromium is no Google Chrome: the card writes "Chrome Sync" as
// "browser sync" there, so each page is told it is Chrome first (the brands' only reader is the card's text), and one
// state is drawn as the other browsers see it. Two states need more than the records: a held copy that no key held here
// opens (its copy, made in Node, put into storage.sync as Chrome sync would deliver it), whose merge asks what opens it
// and says a wrong one; and the space taken, whose merge-and-remove asks too. With CSB_SHOTS set to a folder, each state
// is saved there as a picture, per language and theme, for review (nothing compares them: the probe is the check).
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { close, finishWizard, launch, openOptions, openPopup, addByPaste, GITHUB_URI, type Profile } from "./harness";
import { layoutIssues } from "./visual-helpers";
import { makeCloudBackup } from "../../src/core/cloud/format";
import { planSlot, wrapsOf } from "../../src/core/cloud/slots";
import { account, protectedKeys, seal, vaultOf } from "../helpers/cloud";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const SHOTS = process.env.CSB_SHOTS;

type Rec = {
  cfg: Record<string, unknown>;
  st: Record<string, unknown>;
  alarm?: boolean;
  sync?: Record<string, unknown>;
};
/** A held copy that no key held here opens: its items and the link that names it. */
type Held = { items: Record<string, unknown>; link: Record<string, unknown> };
/**
 * Each state the card can be in, by the records that put it there (`alarm`: a change waits for an alarm far off), and
 * what is done in it before it is measured ("clean": the merge-and-remove's field; "held": the held merge's field, and a
 * wrong secret said).
 */
function states(now: number, held: Held): [string, Rec, ("clean" | "held")?][] {
  const on = { on: true };
  const others = (n: number, bytes: number, otherVaults: number) => ({ n, bytes, otherVaults, latest: now - DAY });
  return [
    ["off", { cfg: {}, st: {} }],
    ["off-unsafe", { cfg: {}, st: { unsafe: true } }],
    ["saving", { cfg: on, st: { pendingSince: now, lastRun: now }, alarm: true }],
    ["empty", { cfg: on, st: { lastRun: now } }],
    ["ok", { cfg: on, st: { lastOk: now - 3 * MIN, lastRun: now, seen: true, used: 66_000, bytes: 6_000 } }],
    ["ok-near-full", { cfg: on, st: { lastOk: now - 3 * MIN, lastRun: now, used: 92_000, bytes: 30_000 } }],
    ["ok-others", { cfg: on, st: { lastOk: now - DAY, lastRun: now, others: others(1, 4_000, 1) } }],
    ["waiting", { cfg: on, st: { lastOk: now - 9 * MIN, pendingSince: now - MIN, lastRun: now }, alarm: true }],
    [
      "failed",
      { cfg: on, st: { lastOk: now - DAY, err: "busy", errSince: now, pendingSince: now, lastRun: now }, alarm: true },
    ],
    [
      "stale",
      {
        cfg: on,
        st: { lastOk: now - 5 * DAY, err: "other", errSince: now - 4 * DAY, pendingSince: now - 4 * DAY, lastRun: now },
        alarm: true,
      },
    ],
    ["too_large", { cfg: on, st: { err: "too_large", errSince: now, lastRun: now } }],
    ["no_room", { cfg: on, st: { err: "no_room", errSince: now, lastRun: now, others: others(2, 97_000, 0) } }],
    [
      "no_room-merge",
      { cfg: on, st: { err: "no_room", errSince: now, lastRun: now, others: others(2, 97_000, 0) } },
      "clean",
    ],
    ["held", { cfg: on, st: { err: "held", errSince: now, lastRun: now } }],
    ["no_password", { cfg: on, st: { err: "no_password", errSince: now, lastRun: now } }],
    ["unreadable", { cfg: on, st: { err: "unreadable", errSince: now, lastRun: now } }],
    ["unsafe", { cfg: on, st: { unsafe: true, lastOk: now - DAY, lastRun: now } }],
    [
      "held-secret",
      { cfg: { on: true, link: held.link }, st: { err: "held", errSince: now, lastRun: now }, sync: held.items },
      "held",
    ],
  ];
}
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

/** The records written as the worker writes them, its alarm far off when a change waits; the card draws them. */
async function put(page: Page, r: Rec) {
  await page.evaluate(
    async ({ cfg, st, alarm, sync }) => {
      await chrome.alarms.clear("sk-csb-soon");
      await chrome.alarms.clear("sk-csb-retry");
      if (alarm) await chrome.alarms.create("sk-csb-soon", { when: Date.now() + 60 * 60_000 });
      if (sync) await chrome.storage.sync.set(sync); // (the test's, as Chrome sync delivers another computer's)
      await chrome.storage.local.set({ sk_csb_cfg: cfg, sk_csb_state: st });
    },
    { cfg: { ...NEW_CFG, ...r.cfg }, st: { ...NEW_STATE, ...r.st }, alarm: r.alarm ?? false, sync: r.sync ?? null },
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

const found: string[] = [];
/** A 16 px checkbox and its label on one full-width 22 px line: the visual guard's allowance for the settings page. */
const allowed = (kind: string, el: string) => kind === "target" && /^label\.check(\.hinted)? "/.test(el);
let p: Profile;
test.afterEach(async () => {
  await close(p);
});

for (const lang of ["en", "zh_CN"] as const)
  test(`${lang}: every state of the card, both themes, 320 to 1400 px; the Backup leaf within 1,350 px`, async () => {
    test.setTimeout(480_000);
    found.length = 0;
    p = await launch();
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
    const now = await opt.evaluate(() => Date.now());
    // a copy under another key, in the slot a held link names
    const keys = await protectedKeys("Other#Vault5!Pass9$Word");
    const gen = await seal(keys, vaultOf(keys.keyring.vaultId, [account("Proton", "JBSWY3DPEHPK3PXQ")]), 3);
    const plan = await planSlot(await makeCloudBackup(gen, "both", "x"), "heldslot", "abababababababab");
    if (plan.kind !== "plan") throw new Error("unexpected");
    const held: Held = {
      items: plan.items,
      link: {
        v: 1,
        slot: "heldslot",
        gen: "abababababababab",
        seq: gen.seq,
        sum: gen.envelope.checksum,
        vaultId: gen.envelope.vaultId,
        vkId: gen.keyring.vkId,
        opens: "both",
        wraps: wrapsOf(gen.keyring.wraps),
        held: true,
        mine: ["heldslot"],
      },
    };
    for (const [name, rec, open] of states(now, held)) {
      await put(opt, rec);
      const kind = name.replace(/-.*$/, "");
      await expect(opt.locator("#csb-card"), name).toHaveAttribute("data-state", kind === "off" ? "off" : kind);
      if (open === "clean") {
        await opt.locator("#cs-merge-clean").click();
        await expect(opt.locator("#cs-secret")).toBeVisible();
      } else if (open === "held") {
        await opt.locator("#cs-held-merge").click();
        await expect(opt.locator("#cs-secret")).toBeVisible({ timeout: 30_000 });
        await opt.locator("#cs-secret").fill("not it");
        await opt.locator("#cs-merge-go").click();
        await expect(opt.locator("#cs-error")).toBeVisible({ timeout: 30_000 });
      }
      for (const colorScheme of ["light", "dark"] as const) {
        await opt.emulateMedia({ colorScheme, reducedMotion: "reduce" });
        for (const width of [320, 420, 600, 1400]) {
          await opt.setViewportSize({ width, height: 900 });
          for (const i of await layoutIssues(opt, { root: "#csb-card" }))
            if (!allowed(i.kind, i.el))
              found.push(`${name}, ${width} px (${colorScheme}): ${i.kind} ${i.el}: ${i.detail}`);
        }
        await opt.setViewportSize({ width: 1400, height: 900 });
        const tall = await opt.evaluate(() => document.documentElement.scrollHeight);
        if (tall > 1350) found.push(`${name} (${colorScheme}): the Backup leaf is ${tall} px tall at 1400 x 900`);
        if (SHOTS) {
          await opt.setViewportSize({ width: 600, height: 900 });
          await opt.locator("#csb-card").screenshot({ path: join(SHOTS, `${lang}-${colorScheme}-${name}.png`) });
        }
      }
      if (open) await opt.locator("#cs-merge-cancel").click();
    }
    await opt.evaluate(() => chrome.storage.sync.clear()); // (the test's own items)
    // as another browser sees it: "browser sync", and that Sixkey does not know whether it syncs it
    const other = await openOptions(p, "#backup");
    await brand(other, false);
    await other.reload();
    await put(other, states(now, held).find(([n]) => n === "ok")![1]);
    await expect(other.locator("#csb-card")).toHaveAttribute("data-state", "ok");
    await expect(other.locator("#cs-status")).toHaveText(
      lang === "en" ? /^Handed to browser sync · / : /^已交给浏览器同步 · /,
    );
    for (const colorScheme of ["light", "dark"] as const) {
      await other.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      for (const width of [320, 1400]) {
        await other.setViewportSize({ width, height: 900 });
        for (const i of await layoutIssues(other, { root: "#csb-card" }))
          if (!allowed(i.kind, i.el))
            found.push(`ok, another browser, ${width} px (${colorScheme}): ${i.kind} ${i.el}: ${i.detail}`);
      }
      if (SHOTS) {
        await other.setViewportSize({ width: 600, height: 900 });
        await other
          .locator("#csb-card")
          .screenshot({ path: join(SHOTS, `${lang}-${colorScheme}-ok-other-browser.png`) });
      }
    }
    expect(found).toEqual([]);
  });

// The popup's part of the backup: its pill in the header, at the side panel's narrowest (320 px) and in the popup as the
// toolbar shows it (376 px), in both languages and themes, in Google Chrome and another browser, handed over and
// stopped. The pill's words are whole (the brand's word gives way first in a narrow header; the pill's ellipsis is the
// last resort), the language button keeps one line, and the probe finds nothing (a row's Edit button excepted, as the
// visual guard allows it). The widths measured are printed for the record.
for (const lang of ["en", "zh_CN"] as const)
  test(`${lang}: the popup's pill whole at 320 px in the side panel and 376 px in the popup, every state, both themes`, async () => {
    test.setTimeout(300_000);
    p = await launch();
    const welcome = await openPopup(p);
    await welcome.evaluate((l) => localStorage.setItem("sk_lang", l), lang);
    const [setup] = await Promise.all([p.ctx.waitForEvent("page"), welcome.locator("#start-secure").click()]);
    await setup.waitForLoadState();
    await finishWizard(setup, { csb: false });
    await setup.close();
    await addByPaste(p, GITHUB_URI);
    const issues: string[] = [];
    const lines: string[] = [];
    const setter = await openPopup(p);
    const now = await setter.evaluate(() => Date.now());
    for (const [state, rec] of [
      ["ok", { cfg: { on: true }, st: { lastOk: now - 3 * MIN, lastRun: now } }],
      ["stopped", { cfg: { on: true }, st: { err: "no_room", errSince: now, lastRun: now } }],
    ] as const) {
      await put(setter, rec);
      for (const chrome of [true, false])
        for (const [path, width] of [
          ["sidepanel/index.html", 320],
          ["popup/index.html", 376],
        ] as const) {
          const pg = await p.ctx.newPage();
          await brand(pg, chrome);
          await pg.goto(`chrome-extension://${p.id}/${path}`);
          for (const colorScheme of ["light", "dark"] as const) {
            await pg.emulateMedia({ colorScheme, reducedMotion: "reduce" });
            await pg.setViewportSize({ width, height: 600 });
            await expect(pg.locator("#csb-pill > span")).toBeVisible();
            const m = await pg.evaluate(() => {
              const s = document.querySelector("#csb-pill > span") as HTMLElement;
              const lang = document.querySelector("#lang-toggle")!.getBoundingClientRect();
              const brandWord = document.querySelector(".ph .brand b") as HTMLElement | null;
              return {
                text: s.textContent,
                shown: s.clientWidth,
                full: s.scrollWidth,
                langHeight: Math.round(lang.height),
                brand: brandWord ? getComputedStyle(brandWord).display !== "none" : false,
              };
            });
            const where = `${state}, ${chrome ? "Chrome" : "another browser"}, ${path.split("/")[0]} ${width} px (${colorScheme})`;
            lines.push(`${where}: "${m.text}" ${m.shown}/${m.full} px, brand word ${m.brand ? "shown" : "hidden"}`);
            if (m.full > m.shown) issues.push(`${where}: the pill's words cut, ${m.shown} of ${m.full} px`);
            if (m.langHeight > 32) issues.push(`${where}: the language button on two lines (${m.langHeight} px)`);
            for (const i of await layoutIssues(pg, { popup: true }))
              if (!(i.kind === "target" && /^button\.more "/.test(i.el)))
                issues.push(`${where}: ${i.kind} ${i.el}: ${i.detail}`);
          }
          // for the record, not held: with one more toolbar button (the plugins' menu, when a plugin is approved), the
          // narrowest header leaves the pill what it can, ending in its ellipsis only then
          if (width === 320) {
            const more = await pg.evaluate(() => {
              const b = document.createElement("button");
              b.className = "tb";
              b.style.width = "30px";
              document.querySelector(".ph .sp")!.after(b);
              const s = document.querySelector("#csb-pill > span") as HTMLElement;
              const r = `${s.clientWidth}/${s.scrollWidth}`;
              b.remove();
              return r;
            });
            lines.push(
              `${state}, ${chrome ? "Chrome" : "another browser"}, sidepanel 320 px, one more button: ${more} px`,
            );
          }
          await pg.close();
        }
    }
    // the last resort, narrower than any side panel (280 px, one more button): the pill's words may be cut then, but
    // with their ellipsis, and nothing else gives (no spill, no second line, no sideways scroll)
    {
      await put(setter, { cfg: { on: true }, st: { err: "no_room", errSince: now, lastRun: now } });
      const pg = await p.ctx.newPage();
      await brand(pg, true);
      await pg.goto(`chrome-extension://${p.id}/sidepanel/index.html`);
      await pg.setViewportSize({ width: 280, height: 600 });
      await expect(pg.locator("#csb-pill > span")).toBeVisible();
      const m = await pg.evaluate(() => {
        const b = document.createElement("button");
        b.className = "tb";
        b.style.width = "30px";
        document.querySelector(".ph .sp")!.after(b);
        const s = document.querySelector("#csb-pill > span") as HTMLElement;
        return { shown: s.clientWidth, full: s.scrollWidth, overflow: getComputedStyle(s).textOverflow };
      });
      lines.push(`stopped, Chrome, sidepanel 280 px, one more button: ${m.shown}/${m.full} px, ${m.overflow}`);
      expect(m.overflow).toBe("ellipsis");
      for (const i of await layoutIssues(pg, { popup: true }))
        if (!(i.kind === "target" && /^button\.more "/.test(i.el)))
          issues.push(`280 px: ${i.kind} ${i.el}: ${i.detail}`);
      await pg.close();
    }
    console.log(`the popup's pill (${lang}):\n${lines.join("\n")}`);
    expect(issues).toEqual([]);
  });
