// The store build without externally_connectable in Chromium: the plugin platform, the one user of other extensions'
// messages, was removed, and so were the manifest's key and every listener of another extension's messages or ports
// (check-dist refuses onMessageExternal and onConnectExternal in shipped code). The prod build in dist/, loaded unpacked
// as the owner loads it, beside two extensions made here: a caller (no key) whose page and worker message Sixkey and an
// ID that is not installed, and which declares one web host, so that a page there has chrome.runtime; and a control that
// declares {"ids": []}, so the test sees Chrome's warning where there is one.
//   (a) No warning, and no key: chrome://extensions with developer mode on, Sixkey and the control reloaded (Chrome's
//       error console collects a manifest's warnings when it is loaded while developer mode is on): the control has the
//       warning and its Warnings button, Sixkey has neither, and its manifest has no externally_connectable.
//   (b) Another extension is refused like a missing one: sendMessage and connect, from its page and from its worker,
//       end with exactly the error of an ID that is not installed (with no key, Chrome lets it try; nothing listens).
//   (c) No web page gets in: a page of the host the caller declares (it has chrome.runtime) is refused like a missing
//       extension; any other page has no chrome.runtime at all.
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PROD = resolve(import.meta.dirname, "../../dist");
/** An ID that is not installed (checked below). */
const MISSING = "b".repeat(32);
const REFUSED = "Could not establish connection. Receiving end does not exist.";
const WARNING = "'externally_connectable' specifies neither 'matches' nor 'ids'; nothing will be able to connect";
const DECLARED = "https://www.example.com/";
const PAGES = [DECLARED, "https://sixkey.invalid/", "https://other.example.org/"];

type Store = { ctx: BrowserContext; dir: string; sixkey: string; caller: string; control: string };

function extension(root: string, name: string, manifest: Record<string, unknown>, files: Record<string, string> = {}) {
  const dir = join(root, name.split(" ").pop()!);
  mkdirSync(dir);
  const m = { manifest_version: 3, name, version: "1.0", background: { service_worker: "sw.js" }, ...manifest };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2));
  writeFileSync(join(dir, "sw.js"), "// nothing to do\n");
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  return dir;
}

const CALLER = { externally_connectable: { matches: [`${DECLARED}*`] } };
const CALLER_PAGE = { "page.html": '<!doctype html><meta charset="utf-8"><title>Caller</title><p>caller</p>' };
/** An empty `ids`: Chrome warns of it (the control that shows the warning is found where there is one). */
const CONTROL = { externally_connectable: { ids: [] } };

async function launchStore(): Promise<Store> {
  const dir = mkdtempSync(join(tmpdir(), "sixkey-ec-"));
  const caller = extension(dir, "Sixkey e2e caller", CALLER, CALLER_PAGE);
  const all = [PROD, caller, extension(dir, "Sixkey e2e control", CONTROL)].join(",");
  // Bundled Chromium only: branded Chrome 137+ ignores --load-extension.
  const ctx = await chromium.launchPersistentContext(join(dir, "profile"), {
    channel: "chromium",
    args: [`--disable-extensions-except=${all}`, `--load-extension=${all}`],
  });
  while (ctx.serviceWorkers().length < 3) await ctx.waitForEvent("serviceworker");
  const ids: Record<string, string> = {};
  for (const sw of ctx.serviceWorkers())
    ids[await sw.evaluate(() => chrome.runtime.getManifest().name)] = new URL(sw.url()).host;
  const sixkey = Object.entries(ids).find(([n]) => !n.startsWith("Sixkey e2e "))?.[1];
  const [callerId, controlId] = [ids["Sixkey e2e caller"], ids["Sixkey e2e control"]];
  if (!sixkey || !callerId || !controlId) throw new Error(`the extensions did not load: ${JSON.stringify(ids)}`);
  expect(Object.values(ids)).not.toContain(MISSING);
  return { ctx, dir, sixkey, caller: callerId, control: controlId };
}
async function closeStore(s: Store) {
  await s.ctx.close();
  rmSync(s.dir, { recursive: true, force: true });
}

/** sendMessage and connect to `target` (a hello, as a plugin of the removed platform sent it), where it runs: what each gave. */
async function callIn(target: string) {
  const rt = (globalThis as unknown as { chrome?: { runtime?: typeof chrome.runtime } }).chrome?.runtime;
  if (typeof rt?.sendMessage !== "function") return { runtime: false };
  const hello = { sdk: 1, id: "req-00000001", type: "hello", body: {} };
  const sent = await rt.sendMessage(target, hello).then(
    (r: unknown) => ({ answered: r ?? null }),
    (e: Error) => ({ error: e.message }),
  );
  const port = rt.connect(target, { name: "sixkey-plugin/1" });
  const connected = await new Promise((done) => {
    const t = setTimeout(() => done({ open: true }), 1500);
    port.onDisconnect.addListener(() => {
      clearTimeout(t);
      done({ disconnected: rt.lastError?.message ?? null });
    });
  });
  return { runtime: true, sent, connected };
}
function callFrom(where: Page | Worker, id: string) {
  return "goto" in where ? where.evaluate(callIn, id) : where.evaluate(callIn, id);
}
const REFUSED_BOTH = { runtime: true, sent: { error: REFUSED }, connected: { disconnected: REFUSED } };

type Info = { manifestErrors: { message: string }[]; installWarnings: string[] };
type DevPrivate = {
  developerPrivate: {
    updateProfileConfiguration(c: { inDeveloperMode: boolean }): Promise<void>;
    reload(id: string, o: { failQuietly: boolean }): Promise<void>;
    getExtensionInfo(id: string): Promise<Info>;
  };
};
/** chrome://extensions's own record of an extension: its manifest errors and install warnings. */
const infoOf = (ex: Page, id: string) =>
  ex.evaluate(async (i) => {
    const x = await (chrome as unknown as DevPrivate).developerPrivate.getExtensionInfo(i);
    return { manifestErrors: x.manifestErrors.map((e) => e.message), installWarnings: x.installWarnings };
  }, id);
/** The card of an extension on chrome://extensions: its Errors (or Warnings) button, if it has one. */
const errorsButtonOf = (ex: Page, id: string) =>
  ex.evaluate((i) => {
    const list = document.querySelector("extensions-manager")?.shadowRoot?.querySelector("extensions-item-list");
    const item = list?.shadowRoot?.querySelector(`extensions-item[id="${i}"]`);
    if (!item?.shadowRoot) return "no card";
    const b = item.shadowRoot.querySelector<HTMLElement>("#errors-button");
    return b && !b.hidden && b.offsetWidth > 0 ? (b.textContent ?? "").trim() : "none";
  }, id);

test("store build: no externally_connectable, and no warning in Chromium (an ids: [] has one)", async () => {
  const s = await launchStore();
  try {
    const ex = await s.ctx.newPage();
    await ex.goto("chrome://extensions/");
    await ex.waitForFunction(() => !!document.querySelector("extensions-manager"));
    // developer mode on, then both loaded again, as the owner's "Load unpacked" does with developer mode on
    await ex.evaluate(
      async ([a, b]) => {
        const d = (chrome as unknown as DevPrivate).developerPrivate;
        await d.updateProfileConfiguration({ inDeveloperMode: true });
        for (const id of [a!, b!]) await d.reload(id, { failQuietly: true });
      },
      [s.sixkey, s.control],
    );
    // the control, loaded again after Sixkey: the warning, found the way this test looks for it
    await expect.poll(async () => (await infoOf(ex, s.control)).manifestErrors).toEqual([WARNING]);
    // Sixkey: no manifest error, no install warning
    expect(await infoOf(ex, s.sixkey)).toEqual({ manifestErrors: [], installWarnings: [] });
    // and on the page: the control's card has its Warnings button, Sixkey's card no Errors or Warnings button
    await ex.reload();
    await ex.waitForFunction(() => !!document.querySelector("extensions-manager"));
    await expect.poll(() => errorsButtonOf(ex, s.control)).toBe("Warnings");
    expect(await errorsButtonOf(ex, s.sixkey)).toBe("none");
    // and the manifest Chrome took is the store build's: no externally_connectable at all
    const pg = await s.ctx.newPage();
    await pg.goto(`chrome-extension://${s.sixkey}/offscreen/index.html`);
    expect(await pg.evaluate(() => "externally_connectable" in chrome.runtime.getManifest())).toBe(false);
  } finally {
    await closeStore(s);
  }
});

test("store build: another extension's sendMessage and connect fail exactly as for an ID not installed", async () => {
  const s = await launchStore();
  try {
    const page = await s.ctx.newPage();
    await page.goto(`chrome-extension://${s.caller}/page.html`);
    const worker = s.ctx.serviceWorkers().find((w) => new URL(w.url()).host === s.caller)!;
    for (const [where, from] of [
      ["page", page],
      ["worker", worker],
    ] as const) {
      const missing = await callFrom(from, MISSING);
      expect(missing, where).toEqual(REFUSED_BOTH);
      expect(await callFrom(from, s.sixkey), where).toEqual(missing);
    }
    // nothing reached Sixkey's worker: nothing was logged
    const pg = await s.ctx.newPage();
    await pg.goto(`chrome-extension://${s.sixkey}/offscreen/index.html`);
    expect(await pg.evaluate(() => chrome.storage.session.get("sk_plugin_log"))).toEqual({});
  } finally {
    await closeStore(s);
  }
});

test("store build: no web page reaches it", async () => {
  const s = await launchStore();
  try {
    // the pages, served here as a changed DNS answer and a certificate the browser trusts would serve them
    await s.ctx.route(/^https:\/\/(?:www\.example\.com|sixkey\.invalid|other\.example\.org)\//, (r) =>
      r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>page</title><p>page</p>" }),
    );
    for (const url of PAGES) {
      const page = await s.ctx.newPage();
      await page.goto(url);
      if (url === DECLARED) {
        // chrome.runtime is there (the caller declares this host), and Sixkey is refused like an ID not installed
        const missing = await callFrom(page, MISSING);
        expect(missing, url).toEqual(REFUSED_BOTH);
        expect(await callFrom(page, s.sixkey), url).toEqual(missing);
      } else {
        // no extension declares the host: the page has no chrome.runtime at all, so it cannot even ask
        expect(await callFrom(page, s.sixkey), url).toEqual({ runtime: false });
      }
      await page.close();
    }
  } finally {
    await closeStore(s);
  }
});
