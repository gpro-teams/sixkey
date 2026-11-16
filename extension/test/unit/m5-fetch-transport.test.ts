// The service worker's fetch transport (src/platform/fetch-transport.ts; SYNC-DESIGN §4.9, §5.4, §3.6.0): what it sends,
// what it refuses to send, and how every way of not getting a complete answer becomes NetworkError ("outcome unknown").
// First against a fake fetch that records the exact call, then against a real HTTP server on the loopback address, for
// what reaches the wire.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NetworkError, type HttpRequest } from "../../src/core/sync/engine/transport";
import {
  FetchTransport,
  MAX_RESPONSE_BYTES,
  RefusedRequest,
  TIMEOUT_MS,
  type FetchLike,
} from "../../src/platform/fetch-transport";

const ORIGIN = "https://api.sixkey.app";
const get = (target: string, headers: Record<string, string> = {}): HttpRequest => ({ method: "GET", target, headers });
const put = (
  target: string,
  body: string,
  headers: Record<string, string> = { "Content-Type": "application/json" },
): HttpRequest => ({ method: "PUT", target, headers, body });

/** A fake fetch: records every call, answers with `answer` (a Response, or a thrown error). */
function fakeFetch(
  answer: (url: string, init: RequestInit) => Response | Promise<Response> = () =>
    new Response('{"ok":true}', {
      status: 200,
      headers: { "Content-Type": "application/json", Date: "Sun, 18 Oct 2026 12:00:00 GMT" },
    }),
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return answer(url, init);
  };
  return { f, calls };
}

describe("the request as sent", () => {
  it("one call to the origin plus the target exactly, with the engine's headers and body unchanged (Accept-Language pinned), and every privacy option set", async () => {
    const { f, calls } = fakeFetch();
    const t = new FetchTransport({ origin: ORIGIN, fetchImpl: f });
    const headers = {
      "Content-Type": "application/json",
      "Sixkey-Device": "AAAAAAAAAAAAAAAAAAAAAA",
      "Sixkey-Ts": "1792051200000",
      "Sixkey-Sig": "c2ln",
    };
    const res = await t.send(put("/v1/vault", '{"if_version":3}', headers));
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://api.sixkey.app/v1/vault");
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual({ ...headers, "Accept-Language": "*" }); // nothing else added, renamed or rewritten
    expect(init.body).toBe('{"if_version":3}');
    expect({
      credentials: init.credentials,
      cache: init.cache,
      redirect: init.redirect,
      referrer: init.referrer,
      referrerPolicy: init.referrerPolicy,
      mode: init.mode,
      keepalive: init.keepalive,
    }).toEqual({
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrer: "",
      referrerPolicy: "no-referrer",
      mode: "cors",
      keepalive: false,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(res).toEqual({
      status: 200,
      headers: { "content-type": "application/json", date: "Sun, 18 Oct 2026 12:00:00 GMT" },
      body: '{"ok":true}',
    });
  });

  it("a GET has no body and no Content-Type; a query string is kept as signed", async () => {
    const { f, calls } = fakeFetch();
    const t = new FetchTransport({ origin: "http://127.0.0.1:8787", fetchImpl: f });
    await t.send(get("/v1/vault/versions/12?x=1&y=%2F"));
    expect(calls[0]!.url).toBe("http://127.0.0.1:8787/v1/vault/versions/12?x=1&y=%2F");
    expect("body" in calls[0]!.init).toBe(false);
    expect(calls[0]!.init.headers).toEqual({ "Accept-Language": "*" });
  });

  it("refuses, without calling fetch, any target that would leave the origin or not be sent exactly as signed", async () => {
    const { f, calls } = fakeFetch();
    const t = new FetchTransport({ origin: ORIGIN, fetchImpl: f });
    for (const target of [
      "//evil.example/v1/vault",
      "https://evil.example/v1",
      "v1/vault",
      "/v1/../admin",
      "/v1/./vault",
      "/v1/vault#frag",
      "/v1/va ult",
      "/v1\\vault",
      "/v1/vault?a=b#c",
      "/é",
      "",
      "/v1/%2e%2e/x",
    ]) {
      await expect(t.send(get(target)), target).rejects.toBeInstanceOf(RefusedRequest);
    }
    expect(calls).toEqual([]);
  });

  it("Content-Type must be exactly application/json on a request with a body, and absent on one without (§5.4)", async () => {
    const { f, calls } = fakeFetch();
    const t = new FetchTransport({ origin: ORIGIN, fetchImpl: f });
    await expect(t.send(put("/v1/vault", "{}", {}))).rejects.toBeInstanceOf(RefusedRequest);
    await expect(
      t.send(put("/v1/vault", "{}", { "Content-Type": "application/json; charset=utf-8" })),
    ).rejects.toBeInstanceOf(RefusedRequest);
    await expect(t.send(put("/v1/vault", "{}", { "Content-Type": "text/plain" }))).rejects.toBeInstanceOf(
      RefusedRequest,
    );
    await expect(
      t.send(put("/v1/vault", "{}", { "Content-Type": "application/json", "content-type": "application/json" })),
    ).rejects.toBeInstanceOf(RefusedRequest);
    await expect(t.send(get("/v1/keys", { "Content-Type": "application/json" }))).rejects.toBeInstanceOf(
      RefusedRequest,
    );
    await expect(
      t.send({ method: "TRACE" as HttpRequest["method"], target: "/v1/keys", headers: {} }),
    ).rejects.toBeInstanceOf(RefusedRequest);
    for (const name of ["Accept-Language", "accept-language"])
      await expect(t.send(get("/v1/keys", { [name]: "de-CH, de;q=0.9" })), name).rejects.toBeInstanceOf(RefusedRequest); // the transport's own
    expect(calls).toEqual([]);
    await t.send(put("/v1/vault", "{}", { "content-type": "application/json" })); // the name in any case, the value exact
    expect(calls).toHaveLength(1);
  });

  it("the origin must be scheme://host[:port] and nothing more", () => {
    for (const o of [
      "https://api.sixkey.app/",
      "https://api.sixkey.app/v1",
      "ftp://api.sixkey.app",
      "https://user@api.sixkey.app",
    ])
      expect(() => new FetchTransport({ origin: o }), o).toThrow();
    expect(new FetchTransport({ origin: "http://127.0.0.1:8787" }).origin).toBe("http://127.0.0.1:8787");
  });
});

describe("no retry, and every failure is NetworkError (the outcome is unknown)", () => {
  it("a fetch that rejects is called once and reported as unknown, or offline when the browser says so", async () => {
    const { f, calls } = fakeFetch(() => {
      throw new TypeError("Failed");
    });
    await expect(
      new FetchTransport({ origin: ORIGIN, fetchImpl: f, online: () => true }).send(get("/v1/keys")),
    ).rejects.toEqual(new NetworkError("unknown"));
    await expect(
      new FetchTransport({ origin: ORIGIN, fetchImpl: f, online: () => false }).send(get("/v1/keys")),
    ).rejects.toEqual(new NetworkError("offline"));
    expect(calls).toHaveLength(2); // one per send: never a second attempt
  });

  it("the timeout aborts the request (headers or body still pending) and is reported as timeout; it is never above 60 s", async () => {
    expect(TIMEOUT_MS).toBeLessThanOrEqual(60_000);
    let seen: AbortSignal | undefined;
    const hang: FetchLike = (_u, init) =>
      new Promise((_res, rej) => {
        seen = init.signal!;
        init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      });
    await expect(
      new FetchTransport({ origin: ORIGIN, fetchImpl: hang, timeoutMs: 30 }).send(get("/v1/keys")),
    ).rejects.toEqual(new NetworkError("timeout"));
    expect(seen!.aborted).toBe(true);
    // a body that never ends
    const slow: FetchLike = async (_u, init) =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("{"));
            init.signal!.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
          },
        }),
        { status: 200 },
      );
    await expect(
      new FetchTransport({ origin: ORIGIN, fetchImpl: slow, timeoutMs: 30 }).send(get("/v1/keys")),
    ).rejects.toEqual(new NetworkError("timeout"));
    // a larger timeout asked for is capped (read back through a fake that reports when it was aborted)
    const t = new FetchTransport({ origin: ORIGIN, fetchImpl: fakeFetch().f, timeoutMs: 10 * 60_000 });
    expect((t as unknown as { timeoutMs: number }).timeoutMs).toBe(TIMEOUT_MS);
  });

  it("a response body over the cap is not read to the end: by its Content-Length, or as it streams; either is unknown", async () => {
    const cap = 1000;
    const big = "x".repeat(cap + 1);
    await expect(
      new FetchTransport({
        origin: ORIGIN,
        maxResponseBytes: cap,
        fetchImpl: fakeFetch(
          () => new Response(big, { status: 200, headers: { "Content-Length": String(big.length) } }),
        ).f,
      }).send(get("/v1/vault")),
    ).rejects.toEqual(new NetworkError("unknown"));
    let pulled = 0;
    const endless = () =>
      new Response(
        new ReadableStream({
          pull(c) {
            pulled++;
            c.enqueue(new Uint8Array(400));
          },
        }),
        { status: 200 },
      );
    await expect(
      new FetchTransport({ origin: ORIGIN, maxResponseBytes: cap, fetchImpl: fakeFetch(endless).f }).send(
        get("/v1/vault"),
      ),
    ).rejects.toEqual(new NetworkError("unknown"));
    expect(pulled).toBeLessThanOrEqual(4); // stopped right after passing the cap
    // a declared length over the cap: refused before a single byte of the body is read
    let read = 0;
    const declared = () =>
      new Response(
        new ReadableStream(
          {
            pull(c) {
              read++;
              c.enqueue(new Uint8Array(10));
              c.close();
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 200, headers: { "Content-Length": String(cap + 1) } },
      );
    await expect(
      new FetchTransport({ origin: ORIGIN, maxResponseBytes: cap, fetchImpl: fakeFetch(declared).f }).send(
        get("/v1/vault"),
      ),
    ).rejects.toEqual(new NetworkError("unknown"));
    expect(read).toBe(0);
    const exact = "y".repeat(cap);
    expect(
      (
        await new FetchTransport({
          origin: ORIGIN,
          maxResponseBytes: cap,
          fetchImpl: fakeFetch(() => new Response(exact, { status: 200 })).f,
        }).send(get("/v1/vault"))
      ).body,
    ).toBe(exact);
    expect(MAX_RESPONSE_BYTES).toBe(8_388_608 + 1_048_576); // one envelope plus room for the rest of the answer (§5.4)
  });

  it("an error status is an answer, not a failure: it comes back with its body; a body that is not UTF-8 comes back empty", async () => {
    const err = await new FetchTransport({
      origin: ORIGIN,
      fetchImpl: fakeFetch(
        () => new Response('{"error":{"code":"rate_limited"}}', { status: 429, headers: { "Retry-After": "30" } }),
      ).f,
    }).send(get("/v1/keys"));
    expect(err).toMatchObject({
      status: 429,
      headers: { "retry-after": "30" },
      body: '{"error":{"code":"rate_limited"}}',
    });
    const bad = await new FetchTransport({
      origin: ORIGIN,
      fetchImpl: fakeFetch(() => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200 })).f,
    }).send(get("/v1/keys"));
    expect(bad.body).toBe("");
    const none = await new FetchTransport({
      origin: ORIGIN,
      fetchImpl: fakeFetch(() => new Response(null, { status: 204 })).f,
    }).send(get("/v1/keys"));
    expect(none).toMatchObject({ status: 204, body: "" });
  });
});

describe("on the wire (a real HTTP server on 127.0.0.1)", () => {
  let server: Server;
  let origin = "";
  const seen: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void = (_q, r) => r.end();
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        handler(req, res, body);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("sends the exact target, body and Content-Type, and no cookie or referer even after the server set a cookie", async () => {
    handler = (_q, r) => {
      r.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "track=1; Path=/" });
      r.end('{"ok":true}');
    };
    const t = new FetchTransport({ origin });
    await t.send(put("/v1/vault?x=%2F", '{"a":"ü"}', { "Content-Type": "application/json", "Sixkey-Ts": "1" }));
    await t.send(get("/v1/keys"));
    const [a, b] = seen.slice(-2);
    expect(a).toMatchObject({ method: "PUT", url: "/v1/vault?x=%2F", body: '{"a":"ü"}' });
    expect(a!.headers["content-type"]).toBe("application/json");
    expect(a!.headers["sixkey-ts"]).toBe("1");
    for (const r of [a!, b!]) {
      expect(r.headers.cookie).toBeUndefined();
      expect(r.headers.referer).toBeUndefined();
      expect(r.headers["accept-language"]).toBe("*"); // never the user's language list
    }
    expect(b!.headers["content-type"]).toBeUndefined();
  });

  it("a redirect is not followed: the request fails with NetworkError and nothing is asked of the redirect target", async () => {
    handler = (q, r) => {
      if (q.url === "/v1/keys") {
        r.writeHead(307, { Location: "/v1/elsewhere" });
        r.end();
      } else {
        r.writeHead(200);
        r.end("{}");
      }
    };
    const n = seen.length;
    await expect(new FetchTransport({ origin }).send(get("/v1/keys"))).rejects.toBeInstanceOf(NetworkError);
    expect(seen.slice(n).map((s) => s.url)).toEqual(["/v1/keys"]);
  });

  it("a response larger than the cap is cut off; a connection refused is NetworkError", async () => {
    handler = (_q, r) => {
      r.writeHead(200);
      r.end("z".repeat(5000));
    };
    await expect(new FetchTransport({ origin, maxResponseBytes: 4096 }).send(get("/v1/vault"))).rejects.toEqual(
      new NetworkError("unknown"),
    );
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((r) => closed.close(() => r()));
    await expect(
      new FetchTransport({ origin: `http://127.0.0.1:${port}` }).send(get("/v1/keys")),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});
