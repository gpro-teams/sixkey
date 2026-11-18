// Each page's own policy (Playwright, the e2e build; SYNC-DESIGN §7, §4.9). The manifest's connect-src names one source,
// the site rules' updater's one path (https://rules.fix.test/v1/, the e2e build's rules origin, with that release gate
// open), which the service worker needs, and the same manifest policy covers the pages; so each page carries its own
// <meta http-equiv="Content-Security-Policy" content="connect-src 'none'">, ahead of its first script. The browser
// enforces both policies (they intersect): no page reaches the rules origin or any other host, while the service worker,
// which no page policy covers, still reaches that one path. (Until DV-0b the source was the server sync's API origin,
// and the bridge carried a sync page's request through the worker; both went with that sync's client.)
// The rules origin is test/helpers/rules-server.ts's server, the browser mapping the name to it and ignoring its
// throw-away certificate, as test/e2e/rules-update.spec.ts runs it.
import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serveRules, type RulesServer } from "../helpers/rules-server";

const BUILT = resolve(import.meta.dirname, "../../dist-e2e");
const RULES = "https://rules.fix.test";

let rs: RulesServer;
test.beforeAll(async () => {
  rs = await serveRules();
  rs.files.set("/v1/from-worker", "{}");
});
test.afterAll(async () => {
  await rs.close();
});

async function launchExt(ext: string): Promise<{ ctx: BrowserContext; id: string; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), "sixkey-page-csp-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      `--host-resolver-rules=MAP rules.fix.test 127.0.0.1:${rs.port}`,
      "--ignore-certificate-errors",
    ],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  return { ctx, id: new URL(sw.url()).host, profile };
}

async function pageFetch(ctx: BrowserContext, url: string) {
  const page = await ctx.newPage();
  await page.goto(url);
  const r = await page.evaluate(async (rules) => {
    let violated = false;
    document.addEventListener("securitypolicyviolation", () => {
      violated = true;
    });
    const res = await fetch(`${rules}/v1/from-page`, { mode: "no-cors" }).then(
      () => "sent",
      () => "blocked",
    );
    await new Promise((x) => setTimeout(x, 50));
    return { res, violated };
  }, RULES);
  await page.close();
  return r;
}

test("no page reaches the rules origin, the manifest's one connect-src source; the worker does, and the pages work", async () => {
  const { ctx, id, profile } = await launchExt(BUILT);
  try {
    rs.asked.length = 0;
    for (const p of ["popup/index.html", "options/index.html"]) {
      const r = await pageFetch(ctx, `chrome-extension://${id}/${p}`);
      expect(r, p).toEqual({ res: "blocked", violated: true });
    }
    expect(rs.asked).toEqual([]);
    // the worker is not covered by a page's policy: the manifest's lets it reach that one path
    const sw = ctx.serviceWorkers()[0]!;
    expect(await sw.evaluate(async (rules) => (await fetch(`${rules}/v1/from-worker`)).status, RULES)).toBe(200);
    expect(rs.asked.map((a) => `${a.method} ${a.path}`)).toEqual(["GET /v1/from-worker"]);
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
