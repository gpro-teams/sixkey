// Autofill as the built-in, with `scripting` optional, in Chromium (the plugin platform's wave 1b, which made it so; the
// rest of that platform was removed on 2026-11-12, and autofill works as it did):
//   - a fresh install holds no `scripting`: the Fill button is there, and its first click asks for it in the click (Chrome
//     grants it without a dialog) and fills, with the Fill chunk and its text loaded lazily before (requirement C), in the
//     popup and in the side panel; the ask is in Settings › Security › Autofill's recent requests, under its switch;
//   - a site on the list before the first Fill: nothing registered until `scripting` comes, then the content script runs;
//   - the shortcut without it: Sixkey opens at the Fill button, whose click grants and fills;
//   - Off and On in Settings: the vault and the list kept; the content script unregistered BEFORE `scripting` is given
//     back (Chrome keeps running a registration left behind where a grant remains: probed); On asks once and restores;
//   - the upgrade's Chrome side (requirement D): a profile whose Sixkey held `scripting` as a required permission, with a
//     site on, started again where it is optional: still held, the registration, list and vault kept, the badge and the
//     fill work. Both sides are this build's code (its manifest written in the old shape first): what is tested is what
//     Chrome keeps. Which worker runs after an unpacked copy's files are replaced is not (the W1b review's F-01: a restart
//     kept the old one; OWNER-CHECKLIST item 41 updates with the reload button and checks the new worker's log line).
import { chromium, expect, test, type Page } from "@playwright/test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { servePages } from "../helpers/autofill-pages";
import {
  addSites,
  clickFill,
  codesNow,
  EXAMPLE_URI,
  GRANTED_TLS,
  holdsScripting,
  popupPage,
  urlOf,
  windowOpen,
  world,
  type World,
} from "./autofill-helpers";
import { addByPaste, close, DIST, openOptions, openPopup, startFresh, STRONG, type Profile } from "./harness";
import { drivenArgs, type PanelPage } from "./panel-helpers";

let w: World | undefined;
test.afterEach(async () => {
  await w?.close();
  w = undefined;
});

const AUTOFILL_ID = "a".repeat(32);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const worker = (p: Profile) => p.ctx.serviceWorkers()[0]!;
const value = (page: Page) => page.locator("input").first().inputValue();
const sitesOf = (p: Profile) =>
  worker(p).evaluate(() => chrome.storage.local.get("sk_af_sites").then((r) => r.sk_af_sites));
const setSites = (p: Profile, hosts: string[]) =>
  worker(p).evaluate((h) => chrome.storage.local.set({ sk_af_sites: { v: 1, hosts: h } }), hosts);
/** The registration's sites (null: none); only while Sixkey holds `scripting` (the calls are not there without it). */
const registered = (p: Profile) =>
  worker(p).evaluate(
    async () => (await chrome.scripting.getRegisteredContentScripts({ ids: ["sk-suggest"] }))[0]?.matches ?? null,
  );
/** The vault's records and autofill's list, as stored (what Off, On and the upgrade must keep). */
const kept = (p: Profile) =>
  worker(p).evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all)
      .filter((k) => /^sk_(active|keyring|slot_a|slot_b|store_v|af_sites)$/.test(k))
      .sort()
      .map((k) => [k, JSON.stringify(all[k])]);
  });
async function tabAt(p: Profile, url: string): Promise<Page> {
  const page = await p.ctx.newPage();
  await page.goto(url);
  await page.bringToFront();
  return page;
}
/** Whether the page runs Sixkey's content script: the finder is there in Sixkey's world (as autofill2-content.spec.ts). */
async function hasContentScript(p: Profile, page: Page): Promise<boolean> {
  const s = await page.context().newCDPSession(page);
  const ids: number[] = [];
  s.on("Runtime.executionContextCreated", (e: { context: { id: number; origin: string } }) => {
    if (e.context.origin === `chrome-extension://${p.id}`) ids.push(e.context.id);
  });
  await s.send("Runtime.enable");
  await wait(300);
  const id = ids[0] ?? -1;
  const r =
    id !== -1 &&
    (
      (await s.send("Runtime.evaluate", {
        expression: 'typeof globalThis.__skOtp === "object"',
        contextId: id,
        returnByValue: true,
      })) as { result: { value?: unknown } }
    ).result.value === true;
  await s.detach();
  return r;
}
async function closePopup(x: World, s: PanelPage): Promise<void> {
  await s.eval("void setTimeout(() => window.close(), 50)");
  await expect
    .poll(async () => {
      const { targetInfos } = (await x.d.bs.send("Target.getTargets")) as {
        targetInfos: { url: string; type: string }[];
      };
      return targetInfos.some((t) => t.url === `chrome-extension://${x.p.id}/popup/index.html` && t.type !== "tab");
    })
    .toBe(false);
}
const fillText = (s: PanelPage) => s.eval<string>("document.querySelector('.sect.site .fill')?.textContent ?? ''");
/** The platform's request log's autofill lines (storage.session sk_plugin_log): one outcome per fill's ask. */
const forPage = (p: Profile) =>
  worker(p).evaluate(async (id) => {
    const l = ((await chrome.storage.session.get("sk_plugin_log")).sk_plugin_log ?? { log: [] }) as {
      log: { pluginId: string; type: string; outcome: string }[];
    };
    return l.log.filter((e) => e.pluginId === id && e.type === "codes.forPage").map((e) => e.outcome);
  }, AUTOFILL_ID);
/** Autofill's switch, flipped on its own page with a real click; resolves once the page shows the new state. */
async function flip(p: Profile, on: boolean): Promise<void> {
  const opt = await openOptions(p, "#autofill");
  await expect(opt.locator("#af-on")).toBeChecked({ checked: !on });
  await opt.locator("#af-on").click();
  await expect(opt.locator("#af-on")).toBeChecked({ checked: on });
  await opt.close();
}
/** One character of the grant record's tag changed (a missed re-tag after a key change, a damaged record). */
const spoilTag = (p: Profile) =>
  worker(p).evaluate(async () => {
    const r = (await chrome.storage.local.get("sk_plugins")).sk_plugins as { tag: string };
    await chrome.storage.local.set({ sk_plugins: { ...r, tag: (r.tag[0] === "A" ? "B" : "A") + r.tag.slice(1) } });
  });

test("a fresh install holds no `scripting`: the Fill button is there; its first click asks for it, in the click, and fills; the ask is in the request log", async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "popup", scripting: false });
  expect(await holdsScripting(w.p)).toBe(false);
  const page = await w.tab("127.0.0.1", "/otc");
  const s = await w.icon(page);
  // the Fill chunk and its text are loaded (lazily) before the button can be there: then the click
  await s.until("document.querySelector('.sect.site .fillbtn')", "the Fill button");
  expect(await s.eval("document.querySelectorAll('.fillbar').length")).toBe(0); // not looked at: nothing to look with
  await windowOpen();
  await clickFill(s);
  await expect.poll(() => value(page)).toMatch(/^\d{6}$/);
  expect(await codesNow()).toContain(await value(page));
  expect(await holdsScripting(w.p)).toBe(true);
  // Settings › Security › Autofill: Autofill, on, and its one request in the request log under the switch
  await expect.poll(() => forPage(w!.p)).toEqual(["ok"]);
  const opt = await openOptions(w.p, "#autofill");
  const row = opt.locator("#autofill #af-switch");
  await expect(row).toContainText("Autofill");
  await expect(row).not.toContainText("Official"); // the plugin platform's chips went with it
  await expect(row).not.toContainText("Built in");
  await expect(row.locator("#af-on")).toBeChecked();
  await expect(row.locator("#af-log")).toHaveCount(1); // (an assertion, before the click that needs it)
  await row.locator("#af-log summary").click();
  await expect(row.locator("#af-log li")).toHaveCount(1);
  await expect(row.locator("#af-log li")).toContainText("Code given for the page"); // the outcome in words
  await expect(row.locator("#af-log li")).not.toContainText("codes.forPage");
  await expect(opt.locator("#plugins")).toHaveCount(0); // no Settings › Plugins any more
});

test("the side panel, on a fresh install: its Fill button's first click asks for `scripting` in the panel's own click, and fills", async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "panel", scripting: false });
  expect(await holdsScripting(w.p)).toBe(false);
  const page = await w.tab("127.0.0.1", "/otc");
  const s = await w.icon(page);
  await s.until("document.querySelector('.sect.site .fillbtn')", "the Fill button");
  expect(await s.eval("document.querySelectorAll('.fillbar').length")).toBe(0);
  await windowOpen();
  await clickFill(s);
  await expect.poll(() => value(page)).toMatch(/^\d{6}$/);
  expect(await codesNow()).toContain(await value(page));
  expect(await holdsScripting(w.p)).toBe(true);
  await expect.poll(() => forPage(w!.p)).toEqual(["ok"]); // the side panel's fill went through the gate, once
});

test("a site on the list before the first Fill: nothing is registered until `scripting` comes; the first Fill brings it, and the content script runs", async () => {
  test.setTimeout(120_000);
  w = await world({ surface: "popup", tls: true, scripting: false });
  await setSites(w.p, [GRANTED_TLS]);
  await wait(1500); // the worker's reconcile, which has nothing it can register with
  expect(await hasContentScript(w.p, await tabAt(w.p, `https://${GRANTED_TLS}/otc`))).toBe(false);
  const page = await w.tab(GRANTED_TLS, "/otc");
  const s = await w.icon(page);
  await s.until("document.querySelector('.sect.site .fillbtn')", "the Fill button");
  await windowOpen();
  await clickFill(s);
  await expect.poll(() => value(page)).toMatch(/^\d{6}$/);
  await expect.poll(() => registered(w!.p)).toEqual([`https://${GRANTED_TLS}/*`]);
  expect(await hasContentScript(w.p, await tabAt(w.p, `https://${GRANTED_TLS}/otc`))).toBe(true);
});

test("the shortcut without `scripting`: Sixkey opens at its Fill button (focused, nothing filled); that click asks, grants and fills", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "popup", scripting: false });
  const page = await w.tab("127.0.0.1", "/otc");
  let s = await w.icon(page);
  await s.until("document.querySelector('.sect.site .fillbtn')", "the Fill button");
  await closePopup(w, s);
  const pressed = worker(w.p).evaluate(() =>
    (globalThis as unknown as { __skFill: (t?: unknown) => Promise<void> }).__skFill(),
  );
  s = await popupPage(w.d, w.p);
  await s.until("document.activeElement?.classList.contains('fillbtn')", "the Fill button has the focus");
  await wait(1000);
  expect(await value(page)).toBe("");
  expect(await holdsScripting(w.p)).toBe(false);
  await windowOpen();
  await clickFill(s);
  await expect.poll(() => value(page)).toMatch(/^\d{6}$/);
  expect(await holdsScripting(w.p)).toBe(true);
  await pressed;
  await expect.poll(() => forPage(w!.p)).toEqual(["ok"]);
  // and the shortcut's own fill, now that `scripting` is held, goes through the worker's gate: one line more
  await page.locator("input").first().fill("");
  await closePopup(w, s);
  await windowOpen(14);
  await worker(w.p).evaluate(() => (globalThis as unknown as { __skFill: (t?: unknown) => Promise<void> }).__skFill());
  await expect.poll(() => value(page)).toMatch(/^\d{6}$/);
  await expect.poll(() => forPage(w!.p)).toEqual(["ok", "ok"]);
});

test("locked, and no `scripting` yet: the shortcut asks for the unlock first; after it the Fill button is offered, nothing filled", async () => {
  test.setTimeout(150_000);
  w = await world({ surface: "popup", scripting: false });
  const page = await w.tab("127.0.0.1", "/otc");
  let s = await w.icon(page);
  await s.until("document.querySelector('.sect.site .fillbtn')", "the Fill button");
  await closePopup(w, s);
  await worker(w.p).evaluate(() => chrome.storage.session.clear()); // locked to the master password
  const pressed = worker(w.p).evaluate(() =>
    (globalThis as unknown as { __skFill: (t?: unknown) => Promise<void> }).__skFill(),
  );
  s = await popupPage(w.d, w.p);
  await s.until("document.querySelector('#lock-fill')", "the lock screen's line for the page");
  expect(
    await worker(w.p).evaluate(async () => {
      const r = (await chrome.storage.session.get("sk_fill_req")).sk_fill_req as { why?: string } | undefined;
      return r?.why ?? null;
    }),
  ).toBe("locked");
  await s.eval(`(() => {
    const i = document.querySelector("#secret");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ${JSON.stringify(STRONG)});
    i.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await s.until("!document.querySelector('form.lock button[type=submit]')?.disabled", "the button");
  await s.eval("document.querySelector('form.lock button[type=submit]').click()");
  await s.until("document.activeElement?.classList.contains('fillbtn')", "the Fill button has the focus");
  expect(await s.eval<string>("document.querySelector('.fillnote.resume')?.textContent ?? ''")).toBe("");
  expect(await value(page)).toBe("");
  expect(await holdsScripting(w.p)).toBe(false); // nothing asked without a click
  await windowOpen();
  await clickFill(s);
  await expect.poll(() => value(page)).toMatch(/^\d{6}$/);
  await pressed;
});

test("Off and On in Settings: the vault and the list kept; unregistered, then `scripting` given back; a Fill says it is off; On asks once and restores", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "popup", tls: true });
  await setSites(w.p, [GRANTED_TLS]);
  await expect.poll(() => registered(w!.p)).toEqual([`https://${GRANTED_TLS}/*`]);
  const before = await kept(w.p);
  // Off, on its own page (Settings › Security › Autofill: the switch is a chunk of its own, loaded first)
  const opt = await openOptions(w.p, "#autofill");
  await expect(opt.locator("#af-switch")).toContainText("Autofill");
  await expect(opt.locator("#af-on")).toBeChecked();
  await opt.locator("#af-on").click(); // a real click
  await expect(opt.locator("#af-on")).not.toBeChecked();
  await expect.poll(() => holdsScripting(w!.p), { message: "the worker gave `scripting` back" }).toBe(false);
  expect(await opt.evaluate(() => localStorage.getItem("sk_af_off"))).toBe("1");
  expect(await kept(w.p)).toEqual(before); // the vault, the list and everything else as they were
  expect(await sitesOf(w.p)).toEqual({ v: 1, hosts: [GRANTED_TLS] });
  // the registration went first: a new page of the site has no content script (Chrome runs a registration left behind)
  expect(await hasContentScript(w.p, await tabAt(w.p, `https://${GRANTED_TLS}/otc`))).toBe(false);
  // the site's row says nothing of Chrome while autofill is off (its grant was given back on purpose: the switch says)
  await opt.reload();
  await expect(opt.locator(`#afs-sites tr[data-host="${GRANTED_TLS}"]`)).toHaveCount(1);
  await expect(opt.locator(`#afs-sites tr[data-host="${GRANTED_TLS}"] .chip`)).toHaveCount(0);
  await expect(opt.locator(".afs-again")).toHaveCount(0);
  // a Fill: nothing is asked of Chrome, nothing filled, and the line says why
  const page = await w.tab(GRANTED_TLS, "/otc");
  const s = await w.icon(page);
  await s.until("document.querySelector('.sect.site .fillbtn')", "the Fill button");
  await clickFill(s);
  await s.until("document.querySelector('.sect.site .fillnote.bad')", "the refusal");
  expect(await fillText(s)).toContain("Autofill is off. Turn it on in Settings › Security › Autofill.");
  expect(await value(page)).toBe("");
  expect(await holdsScripting(w.p)).toBe(false);
  expect(await s.eval("document.querySelectorAll('.fillbar').length")).toBe(0); // the page was not looked at
  await closePopup(w, s);
  // the shortcut while Off: Sixkey opens at its Fill button (it says why there), nothing is looked at or filled
  await windowOpen(14);
  const pressed = worker(w.p).evaluate(() =>
    (globalThis as unknown as { __skFill: (t?: unknown) => Promise<void> }).__skFill(),
  );
  const shown = await popupPage(w.d, w.p);
  await shown.until("document.querySelector('.sect.site .fillbtn')", "the Fill button");
  await pressed;
  expect(await value(page)).toBe("");
  expect(await forPage(w.p)).toEqual([]); // no code was even asked for
  await closePopup(w, shown);
  // On, from Settings › Security › Autofill, the page the line names
  const settings = await openOptions(w.p, "#autofill");
  const row = settings.locator("#autofill #af-switch");
  await expect(row.locator("#af-on")).not.toBeChecked();
  await settings.evaluate(() => {
    const p = chrome.permissions;
    const real = p.request.bind(p);
    (window as unknown as { __asked: unknown[] }).__asked = [];
    p.request = ((x: chrome.permissions.Permissions) => (
      (window as unknown as { __asked: unknown[] }).__asked.push(x),
      real(x)
    )) as typeof p.request;
  });
  await row.locator("#af-on").click();
  await expect(row.locator("#af-on")).toBeChecked();
  expect(await settings.evaluate(() => (window as unknown as { __asked: unknown[] }).__asked)).toEqual([
    { permissions: ["scripting"], origins: [`https://${GRANTED_TLS}/*`] },
  ]);
  expect(await holdsScripting(w.p)).toBe(true);
  expect(await settings.evaluate(() => localStorage.getItem("sk_af_off"))).toBeNull();
  await expect.poll(() => registered(w!.p)).toEqual([`https://${GRANTED_TLS}/*`]);
  expect(await hasContentScript(w.p, await tabAt(w.p, `https://${GRANTED_TLS}/otc`))).toBe(true);
  expect(await kept(w.p)).toEqual(before);
  // and a Fill fills again
  await page.reload();
  const again = await w.icon(page);
  await again.until("document.querySelector('.fillbar.ok')", "found");
  await windowOpen();
  await clickFill(again);
  await expect.poll(() => value(page)).toMatch(/^\d{6}$/);
});

test("a grant record whose tag fails: the switch is read from it tighten-only, the same in Settings, the gate and the worker (OD-1)", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "popup", tls: true });
  const p = w.p;
  await setSites(p, [GRANTED_TLS]);
  await expect.poll(() => registered(p)).toEqual([`https://${GRANTED_TLS}/*`]);
  // a record exists (Off, then On), autofill approved in it; then its tag fails
  await flip(p, false);
  await expect.poll(() => holdsScripting(p)).toBe(false);
  await flip(p, true);
  await expect.poll(() => registered(p)).toEqual([`https://${GRANTED_TLS}/*`]);
  await spoilTag(p);
  await wait(2500); // the worker follows the write: the record, read unverified, says On
  // Settings: On, and the line that the record could not be checked
  const opt = await openOptions(p, "#autofill");
  await expect(opt.locator("#af-on")).toBeChecked();
  await expect(opt.locator("#af-switch")).toContainText("Sixkey could not check its saved autofill setting.");
  // the worker agrees: still registered, `scripting` held, the content script runs; and a Fill fills
  expect(await registered(p)).toEqual([`https://${GRANTED_TLS}/*`]);
  expect(await holdsScripting(p)).toBe(true);
  expect(await hasContentScript(p, await tabAt(p, `https://${GRANTED_TLS}/otc`))).toBe(true);
  const page = await w.tab(GRANTED_TLS, "/otc");
  const s = await w.icon(page);
  await s.until("document.querySelector('.fillbar.ok')", "found");
  await windowOpen();
  await clickFill(s);
  await expect.poll(() => value(page)).toMatch(/^\d{6}$/);
  await closePopup(w, s);
  // Off from there writes a new, tagged record, and the worker follows it as always
  await opt.locator("#af-on").click();
  await expect(opt.locator("#af-on")).not.toBeChecked();
  await expect(opt.locator("#af-switch")).not.toContainText("could not check");
  await expect.poll(() => holdsScripting(p)).toBe(false);
  // that Off record's tag fails too: still Off, in every part
  await spoilTag(p);
  await wait(2500);
  await opt.reload();
  await expect(opt.locator("#af-on")).not.toBeChecked();
  await expect(opt.locator("#af-switch")).toContainText("Sixkey could not check its saved autofill setting.");
  expect(await holdsScripting(p)).toBe(false);
  expect(await hasContentScript(p, await tabAt(p, `https://${GRANTED_TLS}/otc`))).toBe(false);
});

test("Off, with the page hint gone: a Fill click asks for `scripting` again, the gate says Off, and the worker gives it back", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "popup" });
  const p = w.p;
  await flip(p, false);
  await expect.poll(() => holdsScripting(p)).toBe(false);
  const opt = await openOptions(p, "#autofill");
  await opt.evaluate(() => localStorage.removeItem("sk_af_off")); // an Off whose hint never came (cut short)
  await opt.close();
  const page = await w.tab("127.0.0.1", "/otc");
  let s = await w.icon(page);
  await s.until("document.querySelector('.sect.site .fillbtn')", "the Fill button");
  await windowOpen();
  await clickFill(s);
  await s.until("document.querySelector('.sect.site .fillnote')", "a line");
  expect(await fillText(s)).toContain("Autofill is off");
  expect(await value(page)).toBe("");
  await closePopup(w, s);
  // regained while Off: the worker follows the switch a few seconds after that grant, and gives it back
  await expect.poll(() => holdsScripting(p), { timeout: 20_000 }).toBe(false);
  // and the next popup does not look at the page (the hint is back)
  const page2 = await w.tab("127.0.0.1", "/otc");
  s = await w.icon(page2);
  await s.until("document.querySelector('.sect.site .fillbtn')", "the Fill button");
  await wait(1500);
  expect(await s.eval("document.querySelectorAll('.fillbar').length")).toBe(0);
});

test("On while another page holds the vault's lock for 9 s: the grant waits for the switch's write, and nothing is given back (the r2 review's P6)", async () => {
  test.setTimeout(180_000);
  w = await world({ surface: "popup", tls: true });
  const p = w.p;
  await setSites(p, [GRANTED_TLS]);
  await expect.poll(() => registered(p)).toEqual([`https://${GRANTED_TLS}/*`]);
  await flip(p, false);
  await expect.poll(() => holdsScripting(p)).toBe(false);
  const opt = await openOptions(p, "#autofill");
  await expect(opt.locator("#af-on")).not.toBeChecked();
  // another of Sixkey's pages holds the vault's lock (a long vault operation, a busy machine)
  const busy = await openOptions(p, "#appearance");
  await busy.evaluate(() => {
    void navigator.locks.request("sixkey-vault", () => new Promise((r) => setTimeout(r, 9000)));
  });
  await wait(300);
  await opt.bringToFront();
  const t0 = Date.now();
  await opt.locator("#af-on").click(); // Chrome grants at once; the tagged write waits for the lock
  await wait(1500);
  expect(await holdsScripting(p)).toBe(true);
  await expect(opt.locator("#af-on")).toBeChecked({ timeout: 20_000 });
  expect(Date.now() - t0).toBeGreaterThan(7000); // (the write did wait)
  await wait(3000); // the worker follows the On's write
  expect(await holdsScripting(p)).toBe(true);
  await expect.poll(() => registered(p)).toEqual([`https://${GRANTED_TLS}/*`]);
});

test("the upgrade: `scripting` required, a site on; started again where it is optional: still held, the registration, list and vault kept; the badge and the fill work", async () => {
  test.setTimeout(240_000);
  const site = await servePages(true);
  const hosts = [`MAP ${GRANTED_TLS} 127.0.0.1:${site.tlsPort}`, `MAP app.fix.test 127.0.0.1:${site.port}`];
  const ext = mkdtempSync(join(tmpdir(), "sixkey-upgrade-ext-"));
  const dir = mkdtempSync(join(tmpdir(), "sixkey-upgrade-"));
  const NEW = readFileSync(join(DIST, "manifest.json"), "utf8");
  // the build before wave 1b, as its manifest had it: `scripting` required, nothing of it optional, Chrome 120 up
  const old = JSON.parse(NEW);
  old.permissions = [...old.permissions, "scripting"];
  old.optional_permissions = old.optional_permissions.filter((x: string) => x !== "scripting");
  old.minimum_chrome_version = "120";
  cpSync(DIST, ext, { recursive: true });
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(old, null, 2));
  const start = async (): Promise<Profile> => {
    const ctx = await chromium.launchPersistentContext(dir, {
      channel: "chromium",
      args: [
        `--disable-extensions-except=${ext}`,
        `--load-extension=${ext}`,
        ...drivenArgs(hosts),
        "--ignore-certificate-errors",
      ],
    });
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
    return { dir, ctx, id: new URL(sw.url()).host };
  };
  let p = await start();
  try {
    expect(await worker(p).evaluate(() => chrome.runtime.getManifest().permissions)).toContain("scripting");
    await startFresh(p);
    await addByPaste(p, EXAMPLE_URI);
    await addSites(p, "Example", ["fix.test"]);
    await setSites(p, [GRANTED_TLS]);
    await expect.poll(() => registered(p)).toEqual([`https://${GRANTED_TLS}/*`]);
    const before = await kept(p);
    const id = p.id;
    // the update: the browser closed, the new manifest in place, the same profile and folder started again
    await p.ctx.close();
    writeFileSync(join(ext, "manifest.json"), NEW);
    p = await start();
    expect(p.id).toBe(id);
    const m = await worker(p).evaluate(() => chrome.runtime.getManifest());
    expect(m.permissions).not.toContain("scripting");
    expect(m.optional_permissions).toContain("scripting");
    expect(await holdsScripting(p)).toBe(true); // Chrome keeps the grant: it becomes the optional one
    await expect.poll(() => registered(p)).toEqual([`https://${GRANTED_TLS}/*`]);
    expect(await sitesOf(p)).toEqual({ v: 1, hosts: [GRANTED_TLS] });
    // started again locked (a browser restart): unlock, and the vault is all there
    const pop = await openPopup(p);
    await expect(pop.locator("#secret")).toBeVisible();
    await pop.locator("#secret").fill(STRONG);
    await pop.getByRole("button", { name: /^(Unlock|解锁)$/ }).click();
    await expect(pop.locator(".row")).toHaveCount(1);
    await pop.close();
    expect(await kept(p)).toEqual(before);
    // the content script runs on the site, a trusted click in its box sets the badge, and the shortcut fills there
    const page = await tabAt(p, urlOf(site, GRANTED_TLS, "/otc"));
    expect(await hasContentScript(p, page)).toBe(true);
    await page.locator("input").click();
    const tabId = await worker(p).evaluate(
      async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? -1,
    );
    await expect.poll(() => worker(p).evaluate((t) => chrome.action.getBadgeText({ tabId: t }), tabId)).toBe("1");
    await windowOpen();
    await worker(p).evaluate(async (t) => {
      const tab = await chrome.tabs.get(t);
      await (globalThis as unknown as { __skFill: (t: unknown) => Promise<void> }).__skFill(tab);
    }, tabId);
    await expect.poll(() => value(page)).toMatch(/^\d{6}$/);
    expect(await codesNow()).toContain(await value(page));
  } finally {
    await p.ctx.close().catch(() => undefined);
    await site.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
  }
});
