// The page→worker bridge (src/platform/bridge-worker.ts, src/background/sw.ts). Sender spoofing (other
// schemes, other IDs, look-alike paths, frames), malformed payloads (prototype keys, arrays, nulls, control characters,
// oversized values), and the worker module itself: a bridge message can only ever produce a request to the API origin,
// and the bridge code never takes the sixkey-sync lock.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { HttpRequest, Transport } from "../../src/core/sync/engine/transport";
import { BRIDGE_MESSAGE } from "../../src/platform/bridge-page";
import { bridgeRequestOf, isBridgePage, serveBridge } from "../../src/platform/bridge-worker";
import { FetchTransport, type FetchLike } from "../../src/platform/fetch-transport";

const SELF = "abcdefghijklmnopabcdefghijklmnop";
const OTHER = "ponmlkjihgfedcbaponmlkjihgfedcba";
const good = (o: Partial<HttpRequest> = {}): HttpRequest => ({
  method: "GET",
  target: "/v1/sync/status",
  headers: { "Sixkey-Device": "AAAA", "Sixkey-Ts": "1", "Sixkey-Sig": "x" },
  ...o,
});

describe("sender spoofing", () => {
  it("only chrome-extension://<self>/options/index.html (any query or fragment) passes", () => {
    const pass = [
      `chrome-extension://${SELF}/options/index.html`,
      `chrome-extension://${SELF}/options/index.html?x#y`,
      `CHROME-EXTENSION://${SELF}/options/index.html`, // the scheme is case-insensitive in the parser; still this extension
      // userinfo is not looked at: harmless, Chrome reports the real page's URL and nothing outside the extension can make
      // one of its pages load under such a URL (no web_accessible_resources)
      `chrome-extension://x@${SELF}/options/index.html`,
    ];
    const fail = [
      `chrome-extension://${SELF}/options/index.html/`,
      `chrome-extension://${SELF}/options/index.htm`,
      `chrome-extension://${SELF}/options/`,
      `chrome-extension://${SELF}/options%2Findex.html`,
      `chrome-extension://${SELF}/Options/index.html`,
      `chrome-extension://${SELF.toUpperCase()}/options/index.html`,
      `chrome-extension://${SELF}:443/options/index.html`,
      `chrome-extension://${SELF}.evil/options/index.html`,
      `chrome-extension://${OTHER}/options/index.html`,
      `blob:chrome-extension://${SELF}/0b1c`,
      `filesystem:chrome-extension://${SELF}/temporary/options/index.html`,
      "about:blank",
      "about:srcdoc",
      "data:text/html,x",
      `https://${SELF}/options/index.html`,
      `http://${SELF}/options/index.html`,
      `chrome://extensions/?id=${SELF}`,
      `chrome-untrusted://${SELF}/options/index.html`,
      `chrome-extension://${SELF}/popup/index.html`,
      `chrome-extension://${SELF}/offscreen/index.html`,
      `chrome-extension://${SELF}/devsync/index.html`,
      `chrome-extension://${SELF}/sw.js`,
      "",
    ];
    for (const url of pass) expect(isBridgePage({ id: SELF, url }, SELF), url).toBe(true);
    for (const url of fail) expect(isBridgePage({ id: SELF, url }, SELF), url).toBe(false);
    // the ID must be this extension's, whatever the URL says; a missing or non-string URL never passes
    expect(isBridgePage({ id: OTHER, url: pass[0] }, SELF)).toBe(false);
    expect(isBridgePage({ url: pass[0] }, SELF)).toBe(false);
    expect(isBridgePage({ id: SELF, url: 5 as unknown as string }, SELF)).toBe(false);
    expect(isBridgePage({ id: "", url: pass[0] }, "")).toBe(false); // an empty self ID cannot match a URL host
  });
});

describe("malformed payloads", () => {
  it("every shape other than the engine's is refused", () => {
    const viaJson = (s: string) => JSON.parse(s) as unknown;
    const bad: unknown[] = [
      null,
      1,
      "x",
      [],
      [good()],
      { ...good(), method: "get" },
      { ...good(), method: "OPTIONS" },
      { ...good(), method: "HEAD" },
      { ...good(), target: 5 },
      { ...good(), target: "v1/x" },
      { ...good(), target: `/${"a".repeat(4096)}` },
      { ...good(), headers: null },
      { ...good(), headers: [] },
      { ...good(), headers: [["Sixkey-Ts", "1"]] },
      viaJson(`{"method":"GET","target":"/v1/x","headers":{"__proto__":{"x":"1"}}}`),
      viaJson(`{"method":"GET","target":"/v1/x","headers":{"constructor":"x"}}`),
      { ...good(), headers: { "Sixkey-Ts": "1", "SIXKEY-TS": "1" } },
      { ...good(), headers: { "Sixkey-Ts ": "1" } },
      { ...good(), headers: { "X-Forwarded-For": "1.2.3.4" } },
      { ...good(), headers: { Origin: "https://evil.example" } },
      { ...good(), headers: { Referer: "https://evil.example" } },
      { ...good(), headers: { "Sec-Fetch-Site": "none" } },
      { ...good(), body: null },
      { ...good(), body: {} },
      { ...good(), body: ["x"] },
      { ...good(), signal: "x" },
      { ...good(), credentials: "include" },
      { ...good(), redirect: "follow" },
      { ...good(), url: "https://evil.example" },
    ];
    for (const b of bad)
      expect(bridgeRequestOf({ type: BRIDGE_MESSAGE, req: b }), JSON.stringify(b)?.slice(0, 100)).toBeNull();
    expect(bridgeRequestOf({ type: BRIDGE_MESSAGE, req: viaJson(JSON.stringify(good())) })).toEqual(good());
  });

  it("whatever passes the shape, the worker's transport sends nowhere but the API origin, and never a CR/LF header", async () => {
    const urls: string[] = [];
    const f: FetchLike = async (url, init) => {
      new Headers(init.headers); // as the real fetch does: a CR/LF or non-Latin-1 value is a TypeError, nothing is sent
      urls.push(url);
      return new Response("{}", { status: 200 });
    };
    const transport = new FetchTransport({ origin: "https://api.sixkey.app", fetchImpl: f });
    const sender = { id: SELF, url: `chrome-extension://${SELF}/options/index.html` };
    const targets = ["//evil.example/x", "/\\evil.example", "/v1/%2e%2e/%2e%2e/x", "/v1/x#y", "/v1/x?y=1"];
    const replies = [];
    for (const target of targets)
      replies.push(
        await serveBridge({ type: BRIDGE_MESSAGE, req: good({ target }) }, sender, { transport, selfId: SELF }),
      );
    replies.push(
      await serveBridge(
        { type: BRIDGE_MESSAGE, req: good({ headers: { "Sixkey-Sig": "a\r\nCookie: x=1" } }) },
        sender,
        { transport, selfId: SELF },
      ),
    );
    expect(urls).toEqual(["https://api.sixkey.app/v1/x?y=1"]);
    expect(replies.map((r) => (r && "reason" in r ? r.reason : r?.ok))).toEqual([
      "refused",
      "refused",
      "refused",
      "refused",
      true,
      "unknown",
    ]);
  });

  it("a refused or failed request answers with a reason only: nothing of the request comes back", async () => {
    const SECRET = "Bearer-SECRET-TOKEN";
    const sender = { id: SELF, url: `chrome-extension://${SELF}/options/index.html` };
    const failing: Transport = {
      send: async () => {
        throw new Error(`boom ${SECRET}`);
      },
    };
    for (const req of [
      good({ headers: { Authorization: SECRET, Cookie: "x" } }),
      good({ headers: { Authorization: SECRET } }),
    ]) {
      const r = await serveBridge({ type: BRIDGE_MESSAGE, req }, sender, { transport: failing, selfId: SELF });
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
  });
});

describe("the bridge never takes the sixkey-sync lock (§4.9 D10), and never stores what passes through", () => {
  it("its modules name no lock and no storage", () => {
    const src = (p: string) =>
      readFileSync(resolve(__dirname, "../../src/platform", p), "utf8")
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
    for (const f of ["bridge-worker.ts", "bridge-page.ts", "fetch-transport.ts"]) {
      const s = src(f);
      expect(s, f).not.toMatch(
        /sixkey-sync|tryWebLock|webLock|navigator\.locks|chrome\.storage|indexedDB|IdbKV|localStorage|sessionStorage/,
      );
    }
  });
});
