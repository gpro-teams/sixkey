// End-to-end helpers for sync (SYNC-DESIGN §7, §8.6): an API on the e2e build's fixed origin, and the developer sync page
// (src/devsync/, dev and e2e builds only) that turns sync on with the engine's own flows.
//
// The e2e build's API origin is http://127.0.0.1:8787 (scripts/api-origin.mjs). serveApi() listens there and records what
// arrives on the wire (method, target, header names and the few header values the tests check, never a body or a
// signature) before handing each request to a handler: the in-memory FakeServer (the regular e2e suite), or a proxy to
// the real server (test/sync/). Another program may listen on the IPv6 wildcard of the same port on a developer machine;
// binding the IPv4 loopback address is more specific and takes its connections, and serveApi() checks that its own
// listener answers before returning.
import { expect, type Page } from "@playwright/test";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { HttpRequest, HttpResponse } from "../../src/core/sync/engine/transport";
import type { Profile } from "./harness";

export const API_PORT = 8787;
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;

/**
 * What the tests may know of a request that reached the API: never its body, a signature or a token. `device` is the
 * Sixkey-Device header (a random device ID, which the tests compare across a restart).
 */
export type WireRecord = {
  method: string;
  target: string;
  headerNames: string[];
  contentType: string | null;
  acceptLanguage: string | null;
  cookie: boolean;
  referer: boolean;
  signer: "device" | "enroll" | null;
  device: string | null;
  authorization: boolean;
  at: number;
  status?: number | "dropped";
};

export type ApiServer = { server: Server; wire: WireRecord[]; close(): Promise<void> };

function record(method: string, target: string, h: IncomingHttpHeaders): WireRecord {
  return {
    method,
    target,
    headerNames: Object.keys(h).sort(),
    contentType: typeof h["content-type"] === "string" ? h["content-type"] : null,
    acceptLanguage: typeof h["accept-language"] === "string" ? h["accept-language"] : null,
    cookie: h.cookie !== undefined,
    referer: h.referer !== undefined,
    authorization: h.authorization !== undefined,
    signer: h["sixkey-device"] !== undefined ? "device" : h["sixkey-enroll"] !== undefined ? "enroll" : null,
    device: typeof h["sixkey-device"] === "string" ? h["sixkey-device"] : null,
    at: Date.now(),
  };
}

/** An HTTP server on 127.0.0.1:8787 answering with `handle`, recording each request (see WireRecord). */
export async function serveApi(handle: (req: HttpRequest) => Promise<HttpResponse>): Promise<ApiServer> {
  const wire: WireRecord[] = [];
  const marker = `/__sixkey_e2e_${Math.random().toString(36).slice(2)}`;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.url === marker) {
        res.writeHead(204);
        res.end();
        return;
      }
      const rec = record(req.method ?? "", req.url ?? "", req.headers);
      wire.push(rec);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      const body = Buffer.concat(chunks).toString("utf8");
      void handle({
        method: req.method as HttpRequest["method"],
        target: req.url ?? "/",
        headers,
        ...(chunks.length ? { body } : {}),
      }).then(
        (r) => {
          rec.status = r.status;
          res.writeHead(r.status, { ...r.headers, date: new Date().toUTCString() });
          res.end(r.body);
        },
        () => {
          rec.status = "dropped";
          res.destroy(); // a lost answer: the client sees a network error
        },
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(API_PORT, "127.0.0.1", () => resolve());
  });
  const ping = await fetch(`${API_ORIGIN}${marker}`).then(
    (r) => r.status,
    () => 0,
  );
  if (ping !== 204) {
    server.close();
    throw new Error(`something else answers on ${API_ORIGIN}; the e2e API needs that address`);
  }
  return { server, wire, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** The developer sync page of a profile, ready (its engine built). */
export async function openDevSync(p: Profile): Promise<Page> {
  const page = await p.ctx.newPage();
  await page.goto(`chrome-extension://${p.id}/devsync/index.html`);
  await expect(page.locator("#out")).toHaveText("sixkey-dev-sync: ready");
  return page;
}

type Dev = {
  unlock(password: string): Promise<void>;
  requestCode(email: string): Promise<void>;
  signIn(email: string, code: string): Promise<{ expiresAt: number }>;
  firstUpload(o: { password: string; recoveryCode: string; deviceName: string; email: string }): Promise<string>;
  joinWithRecoveryCode(o: { recoveryCode: string; deviceName: string; email: string }): Promise<string>;
  round(): Promise<{ status: string; error?: string; uploaded: boolean; pulled: boolean }>;
  view(): Promise<Record<string, unknown>>;
  turnSyncOff(password: string): Promise<void>;
  approverList(): Promise<{ id: string; state: string }[]>;
  approverStart(rid: string, password: string): Promise<void>;
  approverPairingCode(): string;
  approverPoll(password: string): Promise<string>;
  approverSas(sas: string, password: string): Promise<{ kind: string }>;
};

/** Calls one of the developer page's functions (globalThis.sixkeyDevSync) with JSON-able arguments. */
export async function dev<K extends keyof Dev>(
  page: Page,
  name: K,
  ...args: Parameters<Dev[K]>
): Promise<Awaited<ReturnType<Dev[K]>>> {
  return page.evaluate(
    ([n, a]) =>
      (globalThis as unknown as { sixkeyDevSync: Record<string, (...x: unknown[]) => unknown> }).sixkeyDevSync[
        n as string
      ]!(...(a as unknown[])),
    [name, args] as const,
  ) as Promise<Awaited<ReturnType<Dev[K]>>>;
}

/** Signs this page in: asks for a one-time code, reads it with `code(email)` (the server's inbox), and verifies it. */
export async function signIn(
  page: Page,
  email: string,
  code: (email: string) => string | Promise<string>,
): Promise<void> {
  await dev(page, "requestCode", email);
  await dev(page, "signIn", email, await code(email));
}
