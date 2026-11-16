// The site rules' updater in real Chromium through the e2e build (TOTP autofill Stage 3, AF3-U2; docs/design/notes/
// AUTOFILL3-NOTES.md §10; the plan's §5, §6): its release gate is open there, its rules origin is https://rules.fix.test
// (a server of the test's, test/helpers/rules-server.ts) and it pins the two published test keys, with which the test
// signs its bundles (test/helpers/rules-live-kit.ts). Each world has the accounts registered for fix.test, the popup as
// the surface; live.fix.test is a page host no built-in rule names, rules2.fix.test the e2e build's test group rule's.
//   - Settings › Security › Autofill's switch, off by default: on, the worker checks at once, takes a valid bundle, and
//     the status line says so; the Fill path then uses the live bundle: its rule finds the box on live.fix.test, and
//     rules2.fix.test, which it does not name, has no rule any more (the live bundle replaces the built-in rules whole);
//     off: the built-in rules again at once; on again: it waits for a version above the one it had (the floor);
//   - the request: GET, Accept-Language *, no cookie, no referrer, from the extension's origin;
//   - refusals of §5.2 (a forged signature, an unpinned key, an old version, an expired manifest, a bundle that is not
//     the manifest's, a bundle with alias groups), a redirect, and a server without Access-Control-Allow-Origin (no grant
//     covers the origin): nothing taken; succession: the next key's bundle retires the current key;
//   - no page opens the updater's database (`sixkey-rules-live`): the worker alone does (the plan's S9).
import { expect, test, type Page } from "@playwright/test";
import { openOptions } from "./harness";
import { barText, clickFillAnyway, codesNow, LIVE_HOST, windowOpen, world, type World } from "./autofill-helpers";
import { serveRules, type RulesServer } from "../helpers/rules-server";
import { bundleBytes, DAY_MS, liveBundle, newKey, signedManifest, testKey, type Key } from "../helpers/rules-live-kit";

let w: World | undefined;
let rs: RulesServer | undefined;
test.afterEach(async () => {
  await w?.close();
  await rs?.close();
  w = undefined;
  rs = undefined;
});

/** Every page counts its opens of IndexedDB databases, by name, from its first script on. */
function countOpens() {
  const g = globalThis as unknown as { __skIdbOpens?: string[] };
  g.__skIdbOpens = [];
  const open = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (this: IDBFactory, name: string, version?: number) {
    g.__skIdbOpens!.push(name);
    return open.call(this, name, version as number);
  };
}

const ONE = { pages: [{ path: "/rule/", field: "#code-box", segments: 0, fill: "auto" }] };
/** Publish a bundle of `version` (its rules and hosts) with its manifest signed by `key`; `o` as signedManifest. */
async function publish(
  key: Key,
  version: number,
  hosts: Record<string, string> = { [LIVE_HOST]: "live-one" },
  o: { now?: number; days?: number; kid?: string; extra?: Record<string, unknown>; bytes?: Uint8Array } = {},
) {
  const b = liveBundle(version, { "live-one": ONE }, hosts, o.extra ?? {});
  const bytes = bundleBytes(b);
  const file = await signedManifest(key, bytes, b, { now: o.now ?? Date.now(), days: o.days, kid: o.kid });
  rs!.files.set("/v1/manifest.json", file);
  rs!.files.set(`/v1/bundle-${version}.json`, o.bytes ?? bytes);
}
/** The worker starts a check now (the e2e build's hook, as `__skFill` presses the shortcut), and says how it ended. */
const checkNow = () =>
  w!.p.ctx
    .serviceWorkers()[0]!
    .evaluate(() => (globalThis as unknown as { __skRules: (force: boolean) => Promise<string> }).__skRules(true));
/** The settings page at Security › Autofill, the switch drawn. */
async function settings(): Promise<Page> {
  const page = await openOptions(w!.p, "#autofill");
  await expect(page.locator("#ru-on")).toBeVisible();
  return page;
}
/** The status line once it says `re`. */
const statusSays = (page: Page, re: RegExp) => expect(page.locator("#ru-status")).toHaveText(re, { timeout: 30_000 });
/** The popup on `host`'s `path`: the strip's word once it has looked. */
async function strip(host: string, path: string) {
  const page = await w!.tab(host, path);
  const pop = await w!.icon(page);
  await pop.until(
    "document.querySelector('.fillbar.ok') || /No code box/.test(document.querySelector('.fillbar')?.textContent ?? '')",
    "the strip has looked",
  );
  return { page, pop, found: /Code box found/.test(await barText(pop)) };
}

test("the switch: on takes a signed bundle, the Fill path uses it whole; off is the built-in rules at once; on again waits for a newer one", async () => {
  test.setTimeout(240_000);
  rs = await serveRules();
  w = await world({ surface: "popup", rulesPort: rs.port });
  await w.p.ctx.addInitScript(countOpens);
  await publish(await testKey("current"), 2);

  // before: the built-in rules (live.fix.test has none, rules2.fix.test its test group's), and nothing asked of the server
  expect((await strip(LIVE_HOST, "/rule/one")).found).toBe(false);
  expect((await strip("rules2.fix.test", "/rule/six")).found).toBe(true);
  const opt = await settings();
  await expect(opt.locator("#ru-on")).not.toBeChecked();
  await statusSays(opt, /^Site rules: built in, version 1$/);
  await expect(opt.locator("#rules-update")).toContainText("rules.fix.test");
  expect(rs.asked).toEqual([]);

  // on: one check at once, the manifest then the bundle
  await opt.locator("#ru-on").check();
  await statusSays(opt, /^Site rules: updated on .+ \(version 2\)$/);
  expect(rs.asked.map((a) => `${a.method} ${a.path}`)).toEqual(["GET /v1/manifest.json", "GET /v1/bundle-2.json"]);
  for (const a of rs.asked) {
    expect(a.headers["accept-language"]).toBe("*");
    expect(a.headers.cookie).toBeUndefined();
    expect(a.headers.referer).toBeUndefined();
    expect(a.headers.origin).toBe(`chrome-extension://${w.p.id}`);
  }

  // the Fill path with the live bundle: its rule's box on live.fix.test, filled; no rule on rules2.fix.test any more
  const live = await strip(LIVE_HOST, "/rule/one");
  expect(live.found).toBe(true);
  await windowOpen();
  await clickFillAnyway(live.pop);
  await live.pop.until("document.querySelector('.fillnote.ok')", "filled");
  expect(await codesNow()).toContain(await live.page.locator("#code-box").inputValue());
  expect((await strip("rules2.fix.test", "/rule/six")).found).toBe(false);

  // off: the built-in rules at once
  await opt.locator("#ru-on").uncheck();
  await statusSays(opt, /^Site rules: built in, version 1$/);
  expect((await strip(LIVE_HOST, "/rule/one")).found).toBe(false);
  expect((await strip("rules2.fix.test", "/rule/six")).found).toBe(true);

  // on again: the version it had is not taken again (the floor stays: off and on is not a fresh install)
  const before = rs.asked.length;
  await opt.locator("#ru-on").check();
  await expect(opt.locator("#ru-wait")).toHaveText("Waiting for a version newer than 2", { timeout: 30_000 });
  await statusSays(opt, /^Site rules: built in, version 1$/);
  expect(rs.asked.slice(before).map((a) => a.path)).toEqual(["/v1/manifest.json"]);
  expect((await strip(LIVE_HOST, "/rule/one")).found).toBe(false);
  // a newer one is taken
  await publish(await testKey("current"), 3);
  expect(await checkNow()).toBe("new");
  expect((await strip(LIVE_HOST, "/rule/one")).found).toBe(true);

  // no page opened the updater's database; the count ran in each page looked at (the settings page, the popup)
  const pages = w.p.ctx.pages().filter((p) => p.url().startsWith(`chrome-extension://${w!.p.id}/`));
  expect(pages.length).toBeGreaterThan(0);
  for (const p of pages) {
    const opens = await p.evaluate(() => (globalThis as unknown as { __skIdbOpens?: string[] }).__skIdbOpens);
    expect(opens, p.url()).toBeDefined();
    expect(opens, p.url()).not.toContain("sixkey-rules-live");
  }
  // the toolbar popup, the page whose Fill path asks the worker: counted from its first script, by loading it again
  // with the count installed (Playwright's init scripts do not reach it), and once its look with the live rule is done
  const { pop } = await strip(LIVE_HOST, "/rule/one");
  await pop.cdp!("Page.enable", {});
  await pop.cdp!("Page.addScriptToEvaluateOnNewDocument", { source: `(${countOpens.toString()})()` });
  await pop.cdp!("Page.reload", {});
  await pop.until(
    "globalThis.__skIdbOpens && document.querySelector('.fillbar.ok')",
    "the popup again, counted, the live rule's box found",
  );
  const popOpens = await pop.eval<string[]>("globalThis.__skIdbOpens");
  expect(Array.isArray(popOpens)).toBe(true); // the count ran in this page, from its first script
  expect(popOpens).not.toContain("sixkey-rules-live");
  const counted = `${pages.length} tab page(s), and the toolbar popup: ${JSON.stringify(popOpens)}`;
  test.info().annotations.push({ type: "page opens counted", description: counted });
  console.log(`IndexedDB opens counted: ${counted}`);
});

test("refusals take nothing; a server without Access-Control-Allow-Origin fails; the next key's bundle retires the current one", async () => {
  test.setTimeout(240_000);
  rs = await serveRules();
  w = await world({ surface: "popup", rulesPort: rs.port });
  const [current, next, stranger] = [await testKey("current"), await testKey("next"), await newKey()];
  const opt = await settings();
  rs.files.set("/v1/manifest.json", "{}"); // turned on with nothing valid published: nothing taken
  await opt.locator("#ru-on").check();
  await statusSays(opt, /^Site rules: built in, version 1$/);

  // no grant covers the rules origin: the server's CORS answer is all the browser goes by
  expect(
    await w.p.ctx
      .serviceWorkers()[0]!
      .evaluate(() => chrome.permissions.contains({ origins: ["https://rules.fix.test/*"] })),
  ).toBe(false);
  await publish(current, 2);
  rs.cors.on = false;
  const seen = rs.asked.length;
  expect(await checkNow()).toBe("net");
  expect(rs.asked.length).toBeGreaterThan(seen); // the request reached the server: refused by the browser, not lost
  rs.cors.on = true;

  // a redirect is refused (redirect: "error")
  const file = rs.files.get("/v1/manifest.json")!;
  rs.files.set("/v1/manifest.json", { redirect: "/v1/other.json" });
  rs.files.set("/v1/other.json", file);
  expect(await checkNow()).toBe("net");
  rs.files.set("/v1/manifest.json", file);

  // §5.2's refusals: nothing is taken
  const now = Date.now();
  const refusals: [string, () => Promise<void>, string][] = [
    ["a key the build does not pin", () => publish(stranger, 2), "manifest"],
    [
      "a pinned key's id over another key's signature",
      () => publish(stranger, 2, undefined, { kid: current.kid }),
      "manifest",
    ],
    ["the built-in rules' own version", () => publish(current, 1), "same"],
    ["an expired manifest", () => publish(current, 2, undefined, { now: now - 20 * DAY_MS, days: 10 }), "manifest"],
    [
      "a bundle that is not the manifest's",
      () =>
        publish(current, 2, undefined, {
          bytes: bundleBytes(liveBundle(2, { "live-one": ONE }, { "x.fix.test": "live-one" })),
        }),
      "bundle",
    ],
    ["a live bundle with alias groups", () => publish(current, 2, undefined, { extra: { aliases: [] } }), "bundle"],
  ];
  for (const [what, serve, outcome] of refusals) {
    await serve();
    expect(await checkNow(), what).toBe(outcome);
  }
  expect((await strip(LIVE_HOST, "/rule/one")).found).toBe(false);

  // valid: taken; then the next key's: taken, and the current key is retired on this browser
  await publish(current, 2);
  expect(await checkNow()).toBe("new");
  await publish(next, 3);
  expect(await checkNow()).toBe("new");
  await publish(current, 4);
  expect(await checkNow()).toBe("manifest");
  await publish(next, 4);
  expect(await checkNow()).toBe("new");
  await opt.reload();
  await statusSays(opt, /^Site rules: updated on .+ \(version 4\)$/);
  expect((await strip(LIVE_HOST, "/rule/one")).found).toBe(true);
});
