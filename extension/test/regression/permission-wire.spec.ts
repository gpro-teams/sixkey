// What reaches the wire, and the page policy's place (Playwright).
//   1. The dev build's worker, with nothing granted: code in the service worker that skipped the extension's own checks
//      gets nothing onto the wire towards the address the server sync's API origin had (127.0.0.1:8787): not a
//      CORS-simple request, not a preflight. Until that sync's client went (OWNER-DECISIONS/25, DV-0b) the origin was
//      the CSP's connect-src source and an optional host permission, and such code could send a simple request whole and
//      the preflight of any other; now no source of the CSP names it (the dev build's one source is the site rules'
//      updater's path), so the browser refuses both before they leave. docs/security/local-vault.md states this boundary.
//   2. A page policy hidden in <noscript> is in the HTML text but not in the parsed page, which is why check-dist pins
//      the policy's place instead of searching for it: such a page reaches what the manifest's policy allows, the site
//      rules' path (https://rules.fix.test/v1/ in the e2e build; test/helpers/rules-server.ts plays it).
// npm run e2e builds the dev build for test 1.
import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serveRules, type RulesServer } from "../helpers/rules-server";

const DEV = resolve(import.meta.dirname, "../../dist-dev");
const E2E = resolve(import.meta.dirname, "../../dist-e2e");
const OLD_API = "http://127.0.0.1:8787";
const RULES = "https://rules.fix.test";
const META = `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'">`;

let server: Server;
let rs: RulesServer;
const hits: { method: string; url: string; body: string }[] = [];
test.beforeAll(async () => {
  server = createServer((q, r) => {
    let body = "";
    q.on("data", (c) => (body += c));
    q.on("end", () => {
      hits.push({ method: q.method!, url: q.url!, body });
      r.writeHead(200);
      r.end("{}");
    });
  });
  await new Promise<void>((ok, err) => {
    server.once("error", err);
    server.listen(8787, "127.0.0.1", () => ok());
  });
  rs = await serveRules();
});
test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rs.close();
});

async function launchExt(ext: string): Promise<{ ctx: BrowserContext; id: string; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), "sixkey-permission-wire-"));
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

test("the dev build's worker gets nothing onto the wire towards the old API origin: no simple request, no preflight", async () => {
  expect(existsSync(join(DEV, "manifest.json")), "the dev build (npm run build:dev; npm run e2e makes it)").toBe(true);
  const { ctx, profile } = await launchExt(DEV);
  try {
    const sw = ctx.serviceWorkers()[0]!;
    expect(await sw.evaluate(async () => chrome.permissions.contains({ origins: ["http://127.0.0.1:8787/*"] }))).toBe(
      false,
    );
    hits.length = 0;
    const simple = await sw.evaluate(
      async (api) =>
        fetch(`${api}/simple`, { method: "POST", mode: "no-cors", body: "JBSWY3DPEHPK3PXP" }).then(
          (r) => r.type,
          () => "blocked",
        ),
      OLD_API,
    );
    const signed = await sw.evaluate(
      async (api) =>
        fetch(`${api}/signed`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "Sixkey-Sig": "x" },
          body: '{"s":"JBSWY3DPEHPK3PXP"}',
        }).then(
          (r) => String(r.status),
          () => "blocked",
        ),
      OLD_API,
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(simple).toBe("blocked");
    expect(signed).toBe("blocked");
    expect(hits).toEqual([]);
  } finally {
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test("a page policy inside <noscript> is no policy: the page reaches the manifest's one source, the rules origin", async () => {
  const ext = mkdtempSync(join(tmpdir(), "sixkey-permission-wire-ext-"));
  cpSync(E2E, ext, { recursive: true });
  const f = join(ext, "popup/index.html");
  const h = readFileSync(f, "utf8");
  expect(h).toContain(META);
  writeFileSync(f, h.replace(META, `<noscript>${META}</noscript>`));
  const { ctx, id, profile } = await launchExt(ext);
  try {
    rs.asked.length = 0;
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/popup/index.html`);
    const res = await page.evaluate(
      async (rules) =>
        fetch(`${rules}/v1/from-page`, { mode: "no-cors" }).then(
          () => "sent",
          () => "blocked",
        ),
      RULES,
    );
    expect(res).toBe("sent");
    expect(rs.asked.map((x) => x.path)).toEqual(["/v1/from-page"]);
  } finally {
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
  }
});
