// The API host permission and the page policy, on the wire (Playwright).
//   1. Without the permission (the dev build: optional, never granted here), what code in the service worker that
//      skipped the extension's own checks could get onto the wire: a CORS-simple request (a no-cors POST with a
//      text/plain body) is sent whole, its response unreadable; a request with the engine's headers sends only its
//      preflight (OPTIONS, no body, no signature). Honest code sends neither (test/unit/m5-api-permission.test.ts).
//      docs/security/local-vault.md states this boundary.
//   2. A page policy hidden in <noscript> is in the HTML text but not in the parsed page, which is why check-dist pins
//      the policy's place instead of searching for it.
// Both need 127.0.0.1:8787 free; a recording server listens there. npm run e2e builds the dev build for test 1.
import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DEV = resolve(import.meta.dirname, "../../dist-dev");
const E2E = resolve(import.meta.dirname, "../../dist-e2e");
const API = "http://127.0.0.1:8787";
const META = `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'">`;

let server: Server;
const hits: { method: string; url: string; body: string; headers: string[] }[] = [];
test.beforeAll(async () => {
  server = createServer((q, r) => {
    let body = "";
    q.on("data", (c) => (body += c));
    q.on("end", () => {
      hits.push({ method: q.method!, url: q.url!, body, headers: Object.keys(q.headers).sort() });
      r.writeHead(200);
      r.end("{}");
    });
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
  const profile = mkdtempSync(join(tmpdir(), "sixkey-permission-wire-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  return { ctx, id: new URL(sw.url()).host, profile };
}

test("without the permission: a simple request leaves whole, a signed-shape request only as its preflight", async () => {
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
          (e) => `error ${e}`,
        ),
      API,
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
      API,
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(simple).toBe("opaque");
    expect(signed).toBe("blocked");
    expect(hits.map((h) => `${h.method} ${h.url} ${h.body}`)).toEqual([
      "POST /simple JBSWY3DPEHPK3PXP",
      "OPTIONS /signed ",
    ]);
  } finally {
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test("a page policy inside <noscript> is no policy: the page reaches the API origin", async () => {
  const ext = mkdtempSync(join(tmpdir(), "sixkey-permission-wire-ext-"));
  cpSync(E2E, ext, { recursive: true });
  const f = join(ext, "popup/index.html");
  const h = readFileSync(f, "utf8");
  expect(h).toContain(META);
  writeFileSync(f, h.replace(META, `<noscript>${META}</noscript>`));
  const { ctx, id, profile } = await launchExt(ext);
  try {
    hits.length = 0;
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${id}/popup/index.html`);
    const res = await page.evaluate(
      async (api) =>
        fetch(`${api}/from-page`, { mode: "no-cors" }).then(
          () => "sent",
          () => "blocked",
        ),
      API,
    );
    expect(res).toBe("sent");
    expect(hits.map((x) => x.url)).toEqual(["/from-page"]);
  } finally {
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
  }
});
