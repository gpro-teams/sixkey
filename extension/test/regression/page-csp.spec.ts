// Each page's own policy (Playwright, the e2e build; SYNC-DESIGN §7, §4.9). The manifest's connect-src names the API
// origin, which the service worker needs, and the same manifest policy covers the pages; so each page carries its own
// <meta http-equiv="Content-Security-Policy" content="connect-src 'none'">, ahead of its first script. The browser
// enforces both policies (they intersect): no page reaches the API origin or any other host, while the service worker,
// which no page policy covers, still reaches the API, and the bridge still carries a sync page's request.
// The API origin of the e2e build is 127.0.0.1:8787; a recording server listens there for the test.
import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BUILT = resolve(import.meta.dirname, "../../dist-e2e");
const API = "http://127.0.0.1:8787";

let server: Server;
const hits: string[] = [];
test.beforeAll(async () => {
  server = createServer((q, r) => {
    hits.push(`${q.method} ${q.url}`);
    r.writeHead(200, { "content-type": "application/json" });
    r.end("{}");
  });
  await new Promise<void>((ok, err) => {
    server.once("error", err);
    server.listen(8787, "127.0.0.1", () => ok());
  });
});
test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function launchExt(ext: string): Promise<{ ctx: BrowserContext; id: string; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), "sixkey-page-csp-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  return { ctx, id: new URL(sw.url()).host, profile };
}

async function pageFetch(ctx: BrowserContext, url: string) {
  const page = await ctx.newPage();
  await page.goto(url);
  const r = await page.evaluate(async (api) => {
    let violated = false;
    document.addEventListener("securitypolicyviolation", () => {
      violated = true;
    });
    const res = await fetch(`${api}/from-page`, { mode: "no-cors" }).then(
      () => "sent",
      () => "blocked",
    );
    await new Promise((x) => setTimeout(x, 50));
    return { res, violated };
  }, API);
  await page.close();
  return r;
}

test("no page reaches the API origin; the worker and the bridge do, and the pages work", async () => {
  const { ctx, id, profile } = await launchExt(BUILT);
  try {
    hits.length = 0;
    for (const p of ["popup/index.html", "options/index.html", "devsync/index.html"]) {
      const r = await pageFetch(ctx, `chrome-extension://${id}/${p}`);
      expect(r, p).toEqual({ res: "blocked", violated: true });
    }
    expect(hits).toEqual([]);
    // the worker is not covered by a page's policy
    const sw = ctx.serviceWorkers()[0]!;
    expect(await sw.evaluate(async (api) => (await fetch(`${api}/from-worker`)).status, API)).toBe(200);
    // the bridge still carries a sync page's request (the developer page is a bridge page in the e2e build)
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/devsync/index.html`);
    const reply = await page.evaluate(() =>
      chrome.runtime.sendMessage({ type: "sk-api", req: { method: "GET", target: "/from-bridge", headers: {} } }),
    );
    expect(reply).toMatchObject({ ok: true, res: { status: 200 } });
    expect(hits).toEqual(["GET /from-worker", "GET /from-bridge"]);
    // and the pages still work (the popup renders its first screen)
    const pop = await ctx.newPage();
    const errors: string[] = [];
    pop.on("pageerror", (e) => errors.push(String(e)));
    await pop.goto(`chrome-extension://${id}/popup/index.html`);
    await expect(pop.locator("#app")).toContainText("Sixkey");
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
