// Regression: the network (SYNC-DESIGN §7, §4.9). The extension can reach exactly one origin, the sync API's, and only
// through the service worker; with sync off it sends nothing at all. The browser enforces both parts (the manifest's
// connect-src names the API origin only, img-src 'self' data:, and each page's own connect-src 'none' leaves the worker
// the only context that reaches it); the build checks them again (scripts/check-dist.mjs). This e2e build declares the
// API origin as a required host permission (its tests cannot answer Chrome's prompt); the store build's is optional and
// asked for when sync is turned on, which test/unit/m5-api-permission.test.ts covers with a stand-in chrome.permissions.
//   1. A mock API on the e2e build's fixed origin (127.0.0.1:8787): the FakeServer, which checks every request against
//      the contract and verifies every signature and write proof, served over HTTP; and a decoy on a random port.
//   2. Sync off, the extension used (first run, an account added, the popup, the settings page): the API gets nothing.
//   3. fetch, image, XHR, WebSocket and beacon from the popup and the settings page, and fetch from the worker, to the
//      decoy: all blocked, nothing arrives.
//   4. The worker's fetch to the API origin goes through; an image or a fetch from it in a page does not (each page
//      carries its own connect-src 'none' on top of the manifest's policy).
//   5. Sync turned on (the developer sync page) and an edit synced: every request the API got was signed and accepted,
//      every body passed the contract, every one with a body said exactly "application/json", none carried a cookie or
//      a referrer, and every one said Accept-Language "*" (not the browser's language list).
import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { FakeServer } from "../helpers/fake-server";
import { addByPaste, AWS_URI, close, launch, openPopup, startFresh, STRONG, type Profile } from "../e2e/harness";
import { API_ORIGIN, dev, openDevSync, serveApi, signIn, type ApiServer } from "../e2e/sync-helpers";

let decoy: Server;
const decoyHits: string[] = [];
let api: ApiServer;
const fake = new FakeServer({ origin: API_ORIGIN, now: () => Date.now() });
const transport = fake.transport();

test.beforeAll(async () => {
  decoy = createServer((req, res) => {
    decoyHits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "image/gif" });
    res.end();
  });
  await new Promise<void>((r) => decoy.listen(0, "127.0.0.1", () => r()));
  api = await serveApi((req) => transport.send(req));
});
test.afterAll(async () => {
  decoy.close();
  await api.close();
});

test("only the sync API, only from the service worker, and nothing at all with sync off", async () => {
  const p: Profile = await launch();
  try {
    // 2. sync off, the extension used
    const { recoveryCode } = await startFresh(p);
    await addByPaste(p, AWS_URI);
    const pop = await openPopup(p);
    await expect(pop.locator(".row")).toHaveCount(1);
    await pop.close();
    await new Promise((r) => setTimeout(r, 500));
    expect(api.wire).toEqual([]);

    // 3. every primitive, from every context, to the decoy
    const base = `http://127.0.0.1:${(decoy.address() as { port: number }).port}`;
    for (const path of ["options/index.html", "popup/index.html"]) {
      const page = await p.ctx.newPage();
      await page.goto(`chrome-extension://${p.id}/${path}`);
      const results = await page.evaluate(
        async ([base, apiOrigin]) => {
          const out: Record<string, string> = {};
          const img = (u: string) =>
            new Promise((r) => {
              const i = new Image();
              i.onload = () => r("sent");
              i.onerror = () => r("blocked");
              i.src = u;
            });
          out.fetch = await fetch(`${base}/fetch?secret=JBSWY3DP`, { mode: "no-cors" }).then(
            () => "sent",
            () => "blocked",
          );
          out.img = (await img(`${base}/img?secret=JBSWY3DP`)) as string;
          out.xhr = await new Promise((r) => {
            const x = new XMLHttpRequest();
            x.onload = () => r("sent");
            x.onerror = () => r("blocked");
            x.open("GET", `${base}/xhr`);
            x.send();
          });
          out.beacon = navigator.sendBeacon(`${base}/beacon`, "JBSWY3DP") ? "queued" : "blocked";
          out.ws = await new Promise((r) => {
            try {
              const w = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/ws`);
              w.onopen = () => r("sent");
              w.onerror = () => r("blocked");
            } catch {
              r("blocked");
            }
          });
          out.apiImg = (await img(`${apiOrigin}/img`)) as string; // 4: img-src is 'self' data:, the API origin is not an image source
          out.apiFetch = await fetch(`${apiOrigin}/fetch`, { mode: "no-cors" }).then(
            () => "sent",
            () => "blocked",
          ); // each page's own connect-src 'none'
          return out;
        },
        [base, API_ORIGIN] as const,
      );
      expect(results.fetch, path).toBe("blocked");
      expect(results.img, path).toBe("blocked");
      expect(results.xhr, path).toBe("blocked");
      expect(results.ws, path).toBe("blocked");
      expect(results.apiImg, path).toBe("blocked");
      expect(results.apiFetch, path).toBe("blocked");
      await page.close();
    }
    const sw = p.ctx.serviceWorkers()[0]!;
    expect(
      await sw.evaluate(
        async (b) =>
          fetch(`${b}/sw?secret=JBSWY3DP`, { mode: "no-cors" }).then(
            () => "sent",
            () => "blocked",
          ),
        base,
      ),
    ).toBe("blocked");
    await new Promise((r) => setTimeout(r, 500));
    expect(decoyHits).toEqual([]); // nothing, including beacons, reached the decoy
    expect(api.wire.map((w) => w.target)).toEqual([]); // and the API image above never left the page

    // 4. the worker reaches the API origin
    expect(await sw.evaluate(async (o) => (await fetch(`${o}/healthz`)).status, API_ORIGIN)).toBe(200);
    expect(api.wire.map((w) => `${w.method} ${w.target}`)).toEqual(["GET /healthz"]);
    api.wire.length = 0;

    // 5. sync on, through the engine's own flows; then an edit, which the worker uploads on its own
    const email = "network@example.com";
    const d = await openDevSync(p);
    await signIn(d, email, (e) => fake.inbox(e));
    expect(await dev(d, "firstUpload", { password: STRONG, recoveryCode, deviceName: "E2E", email })).toBe("done");
    await addByPaste(p, "otpauth://totp/GitHub:me?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=GitHub");
    await expect
      .poll(() => fake.requests.filter((r) => r.op === "PUT /v1/vault" && r.status === 200).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    await d.close();
    expect(fake.violations).toEqual([]);
    expect(fake.requests.filter((r) => typeof r.status !== "number" || r.status >= 400)).toEqual([]);
    const ops = api.wire.map((w) => `${w.method} ${w.target.split("?")[0]}`);
    expect(ops).toEqual(
      expect.arrayContaining([
        "POST /v1/auth/otp",
        "POST /v1/auth/verify",
        "GET /v1/account",
        "POST /v1/vault/init",
        "GET /v1/sync/status",
        "PUT /v1/vault",
      ]),
    );
    for (const w of api.wire) {
      expect(w.cookie, w.target).toBe(false);
      expect(w.referer, w.target).toBe(false);
      expect(w.acceptLanguage, w.target).toBe("*"); // never the browser's language list
      if (w.method !== "GET") expect(w.contentType, w.target).toBe("application/json");
      else expect(w.contentType, w.target).toBeNull();
      // the one-time code's two requests carry nothing; the account query only the account session; everything else
      // is signed by a device (a registration signs as the device it registers)
      const path = w.target.split("?")[0];
      if (path === "/v1/auth/otp" || path === "/v1/auth/verify")
        expect([w.signer, w.authorization], w.target).toEqual([null, false]);
      else if (path === "/v1/account") expect([w.signer, w.authorization], w.target).toEqual([null, true]);
      else expect(w.signer, w.target).toBe("device");
    }
    await new Promise((r) => setTimeout(r, 500));
    expect(decoyHits).toEqual([]);
  } finally {
    await close(p);
  }
});
