// The page transport (src/platform/bridge-page.ts) and the service worker's half (bridge-worker.ts; SYNC-DESIGN §4.9): who
// may ask, what may be asked, how the answers map back, and the engine running in a "page" with every request carried by
// the bridge to the FakeServer, which checks every signature and every body against the contract.
import { describe, expect, it } from "vitest";
import { NetworkError, type HttpRequest, type Transport } from "../../src/core/sync/engine/transport";
import { firstUpload } from "../../src/core/sync/engine/enroll";
import { BRIDGE_MESSAGE, BridgeTransport, responseOf } from "../../src/platform/bridge-page";
import {
  BRIDGE_PAGES,
  bridgeRequestOf,
  isBridgePage,
  MAX_BRIDGE_BODY,
  serveBridge,
} from "../../src/platform/bridge-worker";
import { RefusedRequest } from "../../src/platform/fetch-transport";
import { contextOver, EMAIL, newDisk, tryMutex, World } from "../helpers/m3-world";
import { createMutex } from "../../src/core/storage/kv";
import { createProtected } from "../helpers/vaults";

const SELF = "abcdefghijklmnopabcdefghijklmnop";
const OPTIONS = { id: SELF, url: `chrome-extension://${SELF}/options/index.html#sync` };
const req = (o: Partial<HttpRequest> = {}): HttpRequest => ({
  method: "GET",
  target: "/v1/sync/status",
  headers: { "Sixkey-Device": "AAAAAAAAAAAAAAAAAAAAAA", "Sixkey-Ts": "1", "Sixkey-Sig": "x" },
  ...o,
});
const ok = { send: async () => ({ status: 200, headers: { date: "x" }, body: "{}" }) } satisfies Transport;

describe("who may use the bridge", () => {
  it("only this extension's settings page (in a prod or unit-test build: the developer sync page is a dev and e2e build's)", () => {
    expect(BRIDGE_PAGES).toEqual(["/options/index.html"]);
    expect(isBridgePage(OPTIONS, SELF)).toBe(true);
    expect(isBridgePage({ id: SELF, url: `chrome-extension://${SELF}/options/index.html?x=1` }, SELF)).toBe(true);
    for (const s of [
      { id: SELF, url: `chrome-extension://${SELF}/popup/index.html` }, // the popup never runs the engine
      { id: SELF, url: `chrome-extension://${SELF}/offscreen/index.html` },
      { id: SELF, url: `chrome-extension://${SELF}/devsync/index.html` },
      { id: SELF }, // no URL: not a page (the worker itself, or a context without one)
      {
        id: "ponmlkjihgfedcbaponmlkjihgfedcba",
        url: `chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/options/index.html`,
      },
      { id: SELF, url: `chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/options/index.html` },
      { id: "ponmlkjihgfedcbaponmlkjihgfedcba", url: `chrome-extension://${SELF}/options/index.html` }, // the sender's ID counts, not only its URL
      { id: SELF, url: "https://evil.example/options/index.html" },
      { id: SELF, url: "not a url" },
      undefined,
    ])
      expect(isBridgePage(s, SELF), JSON.stringify(s)).toBe(false);
    expect(
      isBridgePage({ id: SELF, url: `chrome-extension://${SELF}/devsync/index.html` }, SELF, [
        "/options/index.html",
        "/devsync/index.html",
      ]),
    ).toBe(true);
  });

  it("a message from anyone else, or of another type, gets no answer at all and nothing is sent", async () => {
    let sent = 0;
    const t: Transport = {
      send: async () => {
        sent++;
        return { status: 200, headers: {}, body: "" };
      },
    };
    expect(
      await serveBridge(
        { type: BRIDGE_MESSAGE, req: req() },
        { id: SELF, url: `chrome-extension://${SELF}/popup/index.html` },
        { transport: t, selfId: SELF },
      ),
    ).toBeNull();
    expect(await serveBridge({ type: "sk-sync-soon", req: req() }, OPTIONS, { transport: t, selfId: SELF })).toBeNull();
    expect(await serveBridge(null, OPTIONS, { transport: t, selfId: SELF })).toBeNull();
    expect(sent).toBe(0);
  });
});

describe("what may be asked", () => {
  it("exactly the engine's request shape: its methods, its headers (any case, once each), string values and bodies within the server's limits", () => {
    expect(bridgeRequestOf({ type: BRIDGE_MESSAGE, req: req() })).toEqual(req());
    const put = req({
      method: "PUT",
      target: "/v1/vault",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer t",
        "sixkey-enroll": "r",
        "Sixkey-New-Sig": "s",
      },
      body: "{}",
    });
    expect(bridgeRequestOf({ type: BRIDGE_MESSAGE, req: put })).toEqual(put);
    const bad: unknown[] = [
      req({ method: "TRACE" as HttpRequest["method"] }),
      req({ target: "https://evil.example/v1" }),
      req({ target: `/${"a".repeat(2048)}` }),
      req({ headers: { Cookie: "a=b" } }),
      req({ headers: { Host: "evil.example" } }),
      req({ headers: { "Sixkey-Ts": "1", "sixkey-ts": "2" } }),
      req({ headers: { "Sixkey-Ts": 1 as unknown as string } }),
      req({ headers: { Authorization: "x".repeat(8193) } }),
      req({ body: 5 as unknown as string }),
      req({ body: "x".repeat(MAX_BRIDGE_BODY + 1) }),
      { ...req(), extra: 1 },
      "GET /v1/keys",
    ];
    for (const b of bad)
      expect(bridgeRequestOf({ type: BRIDGE_MESSAGE, req: b }), JSON.stringify(b).slice(0, 80)).toBeNull();
    expect(bridgeRequestOf({ type: "other", req: req() })).toBeNull();
  });

  it("a request the bridge or the transport refuses is answered 'refused' and not sent; failures keep their reason", async () => {
    let sent = 0;
    const counting: Transport = {
      send: async () => {
        sent++;
        return { status: 200, headers: {}, body: "" };
      },
    };
    expect(
      await serveBridge({ type: BRIDGE_MESSAGE, req: req({ headers: { Cookie: "a" } }) }, OPTIONS, {
        transport: counting,
        selfId: SELF,
      }),
    ).toEqual({ ok: false, reason: "refused" });
    expect(sent).toBe(0);
    const refusing: Transport = {
      send: async () => {
        throw new RefusedRequest("target");
      },
    };
    expect(
      await serveBridge({ type: BRIDGE_MESSAGE, req: req() }, OPTIONS, { transport: refusing, selfId: SELF }),
    ).toEqual({ ok: false, reason: "refused" });
    for (const reason of ["offline", "timeout", "unknown"] as const) {
      const failing: Transport = {
        send: async () => {
          throw new NetworkError(reason);
        },
      };
      expect(
        await serveBridge({ type: BRIDGE_MESSAGE, req: req() }, OPTIONS, { transport: failing, selfId: SELF }),
      ).toEqual({ ok: false, reason });
    }
    const broken: Transport = {
      send: async () => {
        throw new Error("bug");
      },
    };
    expect(
      await serveBridge({ type: BRIDGE_MESSAGE, req: req() }, OPTIONS, { transport: broken, selfId: SELF }),
    ).toEqual({ ok: false, reason: "unknown" });
    expect(await serveBridge({ type: BRIDGE_MESSAGE, req: req() }, OPTIONS, { transport: ok, selfId: SELF })).toEqual({
      ok: true,
      res: { status: 200, headers: { date: "x" }, body: "{}" },
    });
  });
});

describe("the page's side", () => {
  it("passes the request through unchanged and returns a well-formed response; anything else is NetworkError", async () => {
    const posted: unknown[] = [];
    const answer = {
      ok: true,
      res: { status: 409, headers: { "retry-after": "5" }, body: '{"error":{"code":"version_conflict"}}' },
    };
    const t = new BridgeTransport(async (m) => {
      posted.push(m);
      return answer;
    });
    const r = req({
      method: "PUT",
      target: "/v1/vault",
      headers: { "Content-Type": "application/json" },
      body: '{"if_version":1}',
    });
    expect(await t.send(r)).toEqual(answer.res);
    expect(posted).toEqual([{ type: BRIDGE_MESSAGE, req: r }]);
    const replies: [unknown, string][] = [
      [{ ok: false, reason: "timeout" }, "timeout"],
      [{ ok: false, reason: "offline" }, "offline"],
      [{ ok: false, reason: "refused" }, "unknown"],
      [{ ok: false, reason: "whatever" }, "unknown"],
      [undefined, "unknown"],
      [{ ok: true, res: { status: 200, headers: {}, body: 5 } }, "unknown"],
      [{ ok: true, res: { status: 99, headers: {}, body: "" } }, "unknown"],
      [{ ok: true, res: { status: 200, headers: { a: 1 }, body: "" } }, "unknown"],
    ];
    for (const [reply, reason] of replies)
      await expect(new BridgeTransport(async () => reply).send(req()), JSON.stringify(reply)).rejects.toEqual(
        new NetworkError(reason as NetworkError["reason"]),
      );
    await expect(
      new BridgeTransport(async () => {
        throw new Error("Could not establish connection");
      }).send(req()),
    ).rejects.toEqual(new NetworkError("unknown"));
    expect(responseOf({ ok: true, res: { status: 204, headers: {}, body: "" } })).toEqual({
      status: 204,
      headers: {},
      body: "",
    });
  });
});

describe("a page running the engine through the bridge (§4.9)", () => {
  it("turns sync on and runs rounds with every request carried by the worker's transport; the server sees valid signatures and bodies only", async () => {
    const w = new World();
    const disk = newDisk();
    const server = w.server.transport();
    const carried: string[] = [];
    const worker: Transport = {
      send: async (r) => {
        carried.push(`${r.method} ${r.target.split("?")[0]}`);
        return server.send(r);
      },
    };
    const page = new BridgeTransport((m) => serveBridge(m, OPTIONS, { transport: worker, selfId: SELF }));
    const ctx = contextOver({
      ...disk,
      lock: createMutex(),
      identityLock: createMutex(),
      syncLock: tryMutex(),
      transport: page,
      clock: () => w.clock.now,
    });
    const r = await createProtected(ctx.svc, w.password);
    await ctx.svc.openView();
    w.advance(1000);
    expect(
      (
        await firstUpload(ctx.engine, {
          session: await w.server.session(EMAIL),
          password: w.password,
          recoveryCode: r.recoveryCode,
          deviceName: "Page",
          email: EMAIL,
        })
      ).kind,
    ).toBe("done");
    w.advance(1000);
    expect((await ctx.engine.round()).status).toBe("ok");
    expect(carried).toContain("POST /v1/vault/init");
    expect(carried).toContain("GET /v1/sync/status");
    expect(w.server.violations).toEqual([]);
    expect(w.server.requests.filter((x) => typeof x.status === "number" && x.status >= 400)).toEqual([]);
  });
});
