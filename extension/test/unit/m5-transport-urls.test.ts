// The fetch transport's origin pinning and "the target exactly as signed" (src/platform/fetch-transport.ts).
// A corpus of URL-confusion targets: each one is either refused before fetch is called, or sent as exactly
// origin + target, to the pinned origin, and received by a real HTTP server as exactly that target (what the server
// verifies the signature against). Plus the response bounds a hostile server can push on (a lying Content-Length, a
// compression bomb, an endless chunked body, a trickle), and the rule that no error carries a URL, a header or a body.
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NetworkError, type HttpRequest } from "../../src/core/sync/engine/transport";
import { FetchTransport, RefusedRequest, type FetchLike } from "../../src/platform/fetch-transport";

const ORIGIN = "https://api.sixkey.app";
const get = (target: string, headers: Record<string, string> = {}): HttpRequest => ({ method: "GET", target, headers });

// Targets an attacker-influenced or buggy caller could hand over. None may leave the origin or be rewritten.
const CORPUS = [
  // ordinary
  "/v1/vault",
  "/v1/vault?x=1",
  "/v1/vault/versions/12",
  "/v1/enroll/requests/AbC-_9?x=%2F",
  // network-path and authority tricks
  "//evil.example/v1",
  "///evil.example",
  "////evil.example",
  "/\\evil.example",
  "/\\\\evil.example",
  "\\\\evil.example",
  "/@evil.example",
  "/:@evil.example/x",
  "/user:pass@evil.example",
  "https://evil.example/v1",
  "http://api.sixkey.app/v1",
  "https://api.sixkey.app.evil.example/v1",
  "https:evil.example",
  "javascript:alert(1)",
  "data:,x",
  "evil.example/v1",
  // ports and scheme confusion
  ":443/v1",
  "/:8787/v1",
  "//api.sixkey.app:8443/v1",
  "//api.sixkey.app@evil.example/",
  // dot segments, raw and percent-encoded (the WHATWG parser decodes %2e in segments)
  "/v1/../admin",
  "/v1/./vault",
  "/v1/vault/..",
  "/v1/vault/.",
  "/..",
  "/.",
  "/v1/%2e%2e/x",
  "/v1/%2E%2E/x",
  "/v1/.%2e/x",
  "/v1/%2e./x",
  "/v1/%2e/x",
  "/v1/x/%2e",
  "/v1/x/%2e%2e",
  "/%2e%2e/%2e%2e/evil",
  "/v1/..%2f..%2fevil",
  "/v1/%2e%2e%2fadmin",
  // encoded separators and backslashes stay literal (no rewrite), so they are either sent as is or refused
  "/%2F%2Fevil.example",
  "/%5Cevil.example",
  "/v1%2F..%2Fadmin",
  "/v1/%00",
  "/v1/%",
  "/v1/%zz",
  "/v1/%25",
  // fragments, queries the special-query set re-encodes, whitespace and controls (stripped or encoded by the parser)
  "/v1/x#",
  "/v1/x#frag",
  "/v1/x?#",
  "/v1/x?",
  "/v1/x??",
  "/v1/x?'",
  '/v1/x?"',
  "/v1/x?<",
  "/v1/x?`",
  "/v1/x?{}",
  "/v1/x\t",
  "/v1/x\n",
  "/v1/x\r",
  "\t/v1",
  " /v1",
  "/v1 ",
  "/v1/x\u0000",
  "/v1/x ",
  "/v1/x\u2028",
  "/v1/Ａ",
  "/é",
  // RFC 3986 sub-delims and pchars the pattern allows
  "/v1/x;y=1",
  "/v1/x:1",
  "/v1/x@y",
  "/v1/x!$&'()*+,=",
  "/v1/x~",
  "/v1/x?a=b&c=d;e",
  "/v1/x?a=/b?c",
  // empty and odd
  "",
  "/",
  "?x",
  "#x",
];

describe("the target corpus: refused, or sent exactly as signed to the pinned origin", () => {
  for (const origin of [ORIGIN, "http://127.0.0.1:8787"]) {
    it(`origin ${origin}`, async () => {
      const calls: string[] = [];
      const f: FetchLike = async (url) => {
        calls.push(url);
        return new Response("{}", { status: 200 });
      };
      const t = new FetchTransport({ origin, fetchImpl: f });
      let sent = 0;
      for (const target of CORPUS) {
        const before = calls.length;
        let refused = false;
        try {
          await t.send(get(target));
        } catch (e) {
          expect(e, JSON.stringify(target)).toBeInstanceOf(RefusedRequest);
          refused = true;
        }
        if (refused) {
          expect(calls.length, JSON.stringify(target)).toBe(before); // nothing sent
          continue;
        }
        sent++;
        expect(calls.length, JSON.stringify(target)).toBe(before + 1);
        const url = calls.at(-1)!;
        expect(url, JSON.stringify(target)).toBe(origin + target); // byte for byte what was signed
        const u = new URL(url);
        expect(u.origin).toBe(origin);
        expect(u.username + u.password).toBe("");
        expect(u.hash).toBe("");
        expect(u.pathname + u.search).toBe(target); // a second parse (the browser's) does not rewrite it either
      }
      expect(sent).toBeGreaterThan(10); // not vacuous: the ordinary ones went out
    });
  }

  it("on the wire: every target the transport accepts reaches a real server as exactly that target", async () => {
    const seen: string[] = [];
    const server: Server = createServer((q, r) => {
      seen.push(q.url!);
      r.writeHead(200, { "content-type": "application/json" });
      r.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const t = new FetchTransport({ origin });
      for (const target of CORPUS) {
        const n = seen.length;
        const ok = await t.send(get(target)).then(
          () => true,
          (e) => {
            expect(e).toBeInstanceOf(RefusedRequest);
            return false;
          },
        );
        if (ok) expect(seen.slice(n), JSON.stringify(target)).toEqual([target]);
        else expect(seen.length).toBe(n);
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("bodies", () => {
  it("a body that is not the signed text (bytes, an object, a stream) is refused before fetch", async () => {
    const calls: string[] = [];
    const t = new FetchTransport({
      origin: ORIGIN,
      fetchImpl: async (url) => {
        calls.push(url);
        return new Response("{}");
      },
    });
    for (const body of [new Uint8Array([123, 125]), { a: 1 }, new Blob(["{}"]), 5]) {
      await expect(
        t.send({
          method: "PUT",
          target: "/v1/vault",
          headers: { "Content-Type": "application/json" },
          body: body as unknown as string,
        }),
      ).rejects.toBeInstanceOf(RefusedRequest);
    }
    expect(calls).toEqual([]);
  });
});

describe("headers the caller cannot smuggle", () => {
  it("a header value the Fetch API rejects (CR/LF, non-Latin-1) sends nothing and is reported as unknown, never as an answer", async () => {
    const seen: string[] = [];
    const server: Server = createServer((q, r) => {
      seen.push(q.url!);
      r.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const t = new FetchTransport({ origin });
      for (const v of ["a\r\nX-Injected: 1", "a\nb", "☃"]) {
        await expect(t.send(get("/v1/keys", { "Sixkey-Sig": v }))).rejects.toBeInstanceOf(NetworkError);
      }
      expect(seen).toEqual([]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("a hostile server's response", () => {
  let server: Server;
  let origin = "";
  let handler: (res: import("node:http").ServerResponse) => void = (r) => r.end();
  beforeAll(async () => {
    server = createServer((_q, r) => handler(r));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );

  it("a gzip bomb whose compressed size and Content-Length are under the cap is cut off after decompression", async () => {
    const cap = 64 * 1024;
    const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024, 0x61)); // 4 MiB of 'a', a few KiB compressed
    expect(bomb.length).toBeLessThan(cap);
    handler = (r) => {
      r.writeHead(200, { "content-encoding": "gzip", "content-length": String(bomb.length) });
      r.end(bomb);
    };
    await expect(new FetchTransport({ origin, maxResponseBytes: cap }).send(get("/v1/vault"))).rejects.toEqual(
      new NetworkError("unknown"),
    );
  });

  it("an endless chunked body is cut off at the cap", async () => {
    handler = (r) => {
      r.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(16 * 1024, 0x7a);
      const pump = () => {
        while (r.write(chunk)) {
          /* fill */
        }
        r.once("drain", pump);
      };
      r.on("close", () => r.removeAllListeners("drain"));
      pump();
    };
    await expect(new FetchTransport({ origin, maxResponseBytes: 100 * 1024 }).send(get("/v1/vault"))).rejects.toEqual(
      new NetworkError("unknown"),
    );
  });

  it("a Content-Length smaller than the body does not lift the cap; one that is not a number is ignored", async () => {
    const big = "y".repeat(10_000);
    const lying =
      (cl: string): FetchLike =>
      async () =>
        new Response(big, { status: 200, headers: { "content-length": cl } });
    for (const cl of ["10", "abc", "-1", "1e3", "100, 100"]) {
      await expect(
        new FetchTransport({ origin: ORIGIN, maxResponseBytes: 5_000, fetchImpl: lying(cl) }).send(get("/v1/vault")),
        cl,
      ).rejects.toEqual(new NetworkError("unknown"));
    }
  });

  it("a trickle that never finishes is ended by the timeout, the body included", async () => {
    handler = (r) => {
      r.writeHead(200, { "content-type": "application/json" });
      r.write("{");
      const iv = setInterval(() => r.write(" "), 10);
      r.on("close", () => clearInterval(iv));
    };
    await expect(new FetchTransport({ origin, timeoutMs: 200 }).send(get("/v1/vault"))).rejects.toEqual(
      new NetworkError("timeout"),
    );
  });
});

describe("no error carries a URL, a header or a body", () => {
  it("refusals and failures say what kind of failure, nothing of the request", async () => {
    const SECRET = "JBSWY3DPEHPK3PXP";
    const req = (target: string): HttpRequest => ({
      method: "PUT",
      target,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
      body: `{"s":"${SECRET}"}`,
    });
    const errors: unknown[] = [];
    const throwing: FetchLike = async (url) => {
      throw new TypeError(`fetch failed for ${url} ${SECRET}`);
    };
    for (const [t, target] of [
      [new FetchTransport({ origin: ORIGIN, fetchImpl: throwing }), `/v1/${SECRET}`],
      [new FetchTransport({ origin: ORIGIN, fetchImpl: throwing }), `//evil/${SECRET}`],
      [
        new FetchTransport({
          origin: ORIGIN,
          fetchImpl: async () => new Response(SECRET.repeat(100), { status: 200 }),
          maxResponseBytes: 10,
        }),
        `/v1/${SECRET}`,
      ],
    ] as const) {
      await t.send(req(target)).catch((e: unknown) => errors.push(e));
    }
    expect(errors).toHaveLength(3);
    for (const e of errors) {
      const all = `${String(e)} ${(e as Error).stack ?? ""} ${JSON.stringify(e)} ${String((e as { cause?: unknown }).cause ?? "")}`;
      expect(all).not.toContain(SECRET);
      expect((e as { cause?: unknown }).cause).toBeUndefined();
    }
  });
});
