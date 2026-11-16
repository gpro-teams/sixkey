// The one thing the sync engine needs from the network (SYNC-DESIGN §4.9; M3): an HTTP-shaped exchange with the API
// origin. It is an interface on purpose: the engine never calls fetch. The service worker's implementation (fetch to the
// one allowed origin, platform/api.ts) is M5; the tests drive an in-memory FakeServer through the same interface
// (test/helpers/fake-server.ts), and the same engine tests can later run against the real server (M4) by giving them a
// transport that sends real requests. Signing, JSON, error mapping and the server clock live above this, in api.ts.
//
// A transport that rejects means "the outcome is unknown": the request may or may not have reached the server, and may
// or may not have changed something there (a lost connection, a timeout, a service worker stopped mid-request). The
// engine treats every such case as unknown and lets the next status query or GET /v1/keys settle it (§3.6.0, §4.2 step 6).

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One request. `target` is the raw request target (path and query exactly as signed, §5.2); `body` the exact text sent. */
export type HttpRequest = {
  method: HttpMethod;
  target: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
};

/** One response. Header names are lowercase (date, retry-after). `body` is the text as received ("" for 204). */
export type HttpResponse = { status: number; headers: Readonly<Record<string, string>>; body: string };

export interface Transport {
  send(req: HttpRequest): Promise<HttpResponse>;
}

/** Thrown by a transport (or the API client on its behalf) when the outcome of a request is unknown. Never carries data. */
export class NetworkError extends Error {
  constructor(readonly reason: "offline" | "timeout" | "aborted" | "unknown" = "unknown") {
    super(`network: ${reason}`);
    this.name = "NetworkError";
  }
}
