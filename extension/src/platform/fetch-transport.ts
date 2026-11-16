// The sync engine's network (SYNC-DESIGN §4.9, §5.4; M5): the one place in the extension that calls fetch, bundled into
// the service worker only (scripts/check-dist.mjs fails a build where `fetch` appears anywhere else, or more than once).
// The engine (core/sync/engine/api.ts) builds every request: its exact body text, Content-Type and the signature
// headers. This module sends that request, unchanged, to the one API origin, and hands back what came back:
//   - the URL is the configured origin plus the request target exactly as signed: a target that would parse to another
//     origin, or to a different path or query than the one signed, is refused before anything is sent;
//   - a request with a body must carry Content-Type exactly "application/json" (the server refuses anything else with
//     422, and the body is the signed text, never re-encoded); a request without one carries no Content-Type;
//   - no cookies, no HTTP cache, no referrer, no redirects (a redirect fails the request: the signature covers this
//     target on this host, and nothing is ever sent to another one);
//   - Accept-Language is "*", always: the browser would otherwise send the user's language list, a locale signal the
//     server never needs (the one header this module sets; the engine's requests never carry it, and one that does is
//     refused). User-Agent and Origin are the browser's and cannot be changed;
//   - one attempt, never a retry: a retry is the engine's, which signs again with a fresh time; a transport that resent
//     an old signature would let a request outlive the window the engine reasons about (§3.6.0);
//   - at most TIMEOUT_MS for the whole exchange, response body included, then the request is aborted;
//   - at most MAX_RESPONSE_BYTES of response body (counted as it streams, after any decompression), then aborted;
//   - every failure to get a complete answer rejects with NetworkError: the request may or may not have reached the
//     server, and the engine treats the outcome as unknown (transport.ts). Nothing is logged here, and no error carries
//     a URL, a header or a body.
// Response header names are lowercase (as the Fetch API gives them); the body is the text as received, decoded as UTF-8
// (RFC 8259 §8.1); a body that is not valid UTF-8 is handed back as no body, which the engine reads as malformed.
import { SYNC_CONSTANTS } from "../core/sync/crypto/constants";
import { NetworkError, type HttpRequest, type HttpResponse, type Transport } from "../core/sync/engine/transport";

/** The longest one exchange may take: at most 60 s, so no request outlives its ±300 s signature window (§3.6.0, §9 M5). */
export const TIMEOUT_MS = 60_000;
/**
 * The largest response body read. The largest answer the API gives holds one envelope (at most MAX_ENVELOPE_BYTES of
 * JSON text, §4.3) with a bundle and a few numbers; 9 MiB is the server's own limit for a request carrying one (§5.4).
 */
export const MAX_RESPONSE_BYTES = SYNC_CONSTANTS.MAX_ENVELOPE_BYTES + 1024 * 1024;

const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
/** Sent in place of the user's language list (a CORS-safelisted header, so it changes nothing else about a request). */
export const ACCEPT_LANGUAGE = "*";
// A path and an optional query of URL characters (RFC 3986 pchar and "/", "?"), nothing that a URL parser rewrites.
const TARGET_RE = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*(?:\?[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*)?$/;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type FetchTransportOptions = {
  /** The API origin (scheme://host[:port], no path): the only one this transport reaches. */
  origin: string;
  /** The Fetch API (tests pass a fake). Named so that the word itself appears once in the bundle (check-dist). */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Whether the browser believes it is online (navigator.onLine): only to name a failure "offline". */
  online?: () => boolean;
};

/** Thrown before anything is sent, for a request this transport will not make (never reached by the engine's own). */
export class RefusedRequest extends Error {
  constructor(what: string) {
    super(`refused: ${what}`);
    this.name = "RefusedRequest";
  }
}

const isNetworkError = (e: unknown): e is NetworkError => e instanceof NetworkError;

export class FetchTransport implements Transport {
  private readonly impl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly online: () => boolean;
  readonly origin: string;

  constructor(o: FetchTransportOptions) {
    const u = new URL(o.origin);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.origin !== o.origin)
      throw new Error("the API origin must be scheme://host[:port] with nothing after it");
    this.origin = o.origin;
    this.impl = o.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = Math.min(o.timeoutMs ?? TIMEOUT_MS, TIMEOUT_MS);
    this.maxBytes = o.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    this.online = o.online ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
  }

  /** The URL for a target, or a refusal: same origin, and the path and query exactly as given (as signed, §5.2). */
  urlOf(target: string): string {
    if (!TARGET_RE.test(target) || target.startsWith("//")) throw new RefusedRequest("target");
    const u = new URL(target, this.origin);
    if (u.origin !== this.origin || u.pathname + u.search !== target || u.username || u.password)
      throw new RefusedRequest("target");
    return u.href;
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    if (!METHODS.has(req.method)) throw new RefusedRequest("method");
    const url = this.urlOf(req.target);
    const headers: Record<string, string> = {};
    let contentType: string | undefined;
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v !== "string") throw new RefusedRequest("header");
      if (k.toLowerCase() === "accept-language") throw new RefusedRequest("header");
      if (k.toLowerCase() === "content-type") {
        if (contentType !== undefined) throw new RefusedRequest("header");
        contentType = v;
      }
      headers[k] = v;
    }
    headers["Accept-Language"] = ACCEPT_LANGUAGE;
    if (
      req.body !== undefined
        ? typeof req.body !== "string" || contentType !== "application/json"
        : contentType !== undefined
    )
      throw new RefusedRequest("content-type");

    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, this.timeoutMs);
    const lost = (): NetworkError => new NetworkError(timedOut ? "timeout" : this.online() ? "unknown" : "offline");
    try {
      let res: Response;
      try {
        res = await this.impl(url, {
          method: req.method,
          headers,
          ...(req.body !== undefined ? { body: req.body } : {}),
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          referrer: "",
          referrerPolicy: "no-referrer",
          mode: "cors",
          keepalive: false,
          signal: ctl.signal,
        });
      } catch {
        throw lost();
      }
      const body = await this.readBody(res, ctl).catch((e: unknown) => {
        throw isNetworkError(e) ? e : lost();
      });
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        out[k.toLowerCase()] = v;
      });
      return { status: res.status, headers: out, body };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The body as text, at most maxBytes of it (else the request is aborted and the outcome is unknown). */
  private async readBody(res: Response, ctl: AbortController): Promise<string> {
    const declared = res.headers.get("content-length");
    if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > this.maxBytes) {
      ctl.abort();
      throw new NetworkError("unknown");
    }
    if (!res.body) return "";
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > this.maxBytes) {
        ctl.abort();
        await reader.cancel().catch(() => undefined);
        throw new NetworkError("unknown");
      }
      parts.push(value);
    }
    const all = new Uint8Array(n);
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.byteLength;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(all);
    } catch {
      return "";
    }
  }
}
