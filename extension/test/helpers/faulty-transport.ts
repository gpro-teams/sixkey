// Network faults for the sync engine's tests (SYNC-DESIGN §8.2, §8.3): wrappers around any Transport, so the same faults
// apply to the in-memory FakeServer and, later, to a transport that talks to the real server (M4/M5). Nothing here looks
// inside a request beyond its method and target: no body or header is kept, so no secret can end up in the log.
//
// Fault kinds (one per delivered request, chosen by a scripted rule or the seeded random mix):
//   lose_response  the request is delivered and its response dropped: the caller gets a NetworkError (the server may have
//                  committed: a "result unknown")
//   fail_before    the caller gets a NetworkError and nothing reaches the server
//   duplicate      the request is delivered twice (a retried or duplicated packet); the caller gets the first answer
//                  ("first", default) or the second ("second")
//   late           the caller gets a NetworkError at once (it timed out), and the request reaches the server later, at
//                  flushLate() (delivery after the client gave up)
//   hold           the caller waits; the request reaches the server only at release() (reorder: release(…, "reverse"))
//   latency        the request is delivered after sleep(ms) (an injected sleep, so tests keep virtual time)
// partition(true) makes every call fail_before until partition(false).
import {
  NetworkError,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "../../src/core/sync/engine/transport";

/** The contract's operation templates (api/openapi.yaml paths), most specific first. */
const TEMPLATES: { method: string; re: RegExp; key: string }[] = [
  ["GET", "/healthz"],
  ["POST", "/v1/auth/otp"],
  ["POST", "/v1/auth/verify"],
  ["GET", "/v1/account"],
  ["DELETE", "/v1/account"],
  ["POST", "/v1/vault/init"],
  ["GET", "/v1/sync/status"],
  ["GET", "/v1/vault"],
  ["PUT", "/v1/vault"],
  ["GET", "/v1/vault/versions"],
  ["DELETE", "/v1/vault/versions"],
  ["GET", "/v1/vault/versions/{v}"],
  ["GET", "/v1/keys"],
  ["PUT", "/v1/keys"],
  ["POST", "/v1/keys/rotate"],
  ["GET", "/v1/devices"],
  ["POST", "/v1/devices/fork"],
  ["PATCH", "/v1/devices/{id}"],
  ["POST", "/v1/devices/{id}/revoke"],
  ["POST", "/v1/enroll/requests"],
  ["GET", "/v1/enroll/requests"],
  ["GET", "/v1/enroll/requests/{rid}"],
  ["POST", "/v1/enroll/requests/{rid}/respond"],
  ["POST", "/v1/enroll/requests/{rid}/reveal"],
  ["POST", "/v1/enroll/requests/{rid}/approve"],
  ["POST", "/v1/enroll/requests/{rid}/complete"],
  ["POST", "/v1/enroll/requests/{rid}/reject"],
  ["POST", "/v1/enroll/reject-all"],
  ["POST", "/v1/enroll/recovery"],
].map(([method, path]) => ({
  method: method!,
  key: `${method} ${path}`,
  re: new RegExp(`^${path!.replace(/\{[a-z]+\}/g, "([^/?#]+)")}$`),
}));

/** "METHOD /path-template" of a request (e.g. "PUT /v1/vault"), or null for a path outside the contract. */
export function operationKey(method: string, target: string): string | null {
  const path = target.split("?")[0]!;
  for (const t of TEMPLATES) if (t.method === method && t.re.test(path)) return t.key;
  return null;
}

/** The path parameters of a request for its template ({v}, {id}, {rid}), in order. */
export function pathParams(target: string, key: string): string[] {
  const t = TEMPLATES.find((x) => x.key === key);
  const m = t ? t.re.exec(target.split("?")[0]!) : null;
  return m ? m.slice(1) : [];
}

export type FaultKind = "lose_response" | "fail_before" | "duplicate" | "late" | "hold" | "latency";
/** Which requests a rule applies to: an operation key ("PUT /v1/vault"), a predicate, or every request. */
export type Match = string | ((req: HttpRequest, key: string | null) => boolean) | undefined;
export type Rule = { match?: Match; kind: FaultKind; count?: number; answer?: "first" | "second"; ms?: number };
export type LogEntry = { n: number; op: string; kind: FaultKind | "ok" | "partition" };

/** A small seeded PRNG (mulberry32), so a failing random mix replays with its seed. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type RandomMix = {
  seed: number;
  /** Per-request probability of each kind (they are tried in this order; the rest is delivered normally). */
  rates: Partial<Record<Exclude<FaultKind, "hold">, number>>;
  /** Latency range for "latency" (ms). */
  latencyMs?: [number, number];
  match?: Match;
};

const matches = (m: Match, req: HttpRequest, key: string | null): boolean =>
  m === undefined ? true : typeof m === "string" ? m === key : m(req, key);

export class FaultyTransport implements Transport {
  readonly log: LogEntry[] = [];
  private rules: (Rule & { left: number })[] = [];
  private mix: { m: RandomMix; rnd: () => number } | null = null;
  private cut = false;
  private n = 0;
  private lateQueue: HttpRequest[] = [];
  private held: { req: HttpRequest; resolve: (r: HttpResponse) => void; reject: (e: unknown) => void }[] = [];
  /** Responses of late and duplicate deliveries that nobody waited for (their outcome, for assertions). */
  readonly orphans: { op: string; status: number | "error" }[] = [];

  constructor(
    private readonly inner: Transport,
    private readonly sleep: (ms: number) => Promise<void> = async () => undefined,
  ) {}

  /** A scripted fault for the next `count` (default 1) matching requests. Rules are tried in the order added. */
  inject(rule: Rule): this {
    this.rules.push({ ...rule, left: rule.count ?? 1 });
    return this;
  }

  /** A seeded random mix (null: off). */
  random(m: RandomMix | null): this {
    this.mix = m ? { m, rnd: prng(m.seed) } : null;
    return this;
  }

  partition(on: boolean): this {
    this.cut = on;
    return this;
  }

  /** Drop the scripted faults not used yet (the network is fine from now on). */
  clearRules(): this {
    this.rules = [];
    return this;
  }

  /** Deliver every "late" request now, in arrival order (or reversed). Their answers go nowhere (orphans). */
  async flushLate(order: "fifo" | "reverse" = "fifo"): Promise<void> {
    const q = order === "fifo" ? this.lateQueue : [...this.lateQueue].reverse();
    this.lateQueue = [];
    for (const req of q) await this.orphan(req);
  }

  get lateCount(): number {
    return this.lateQueue.length;
  }
  get heldCount(): number {
    return this.held.length;
  }

  /** Deliver the held requests to the server, in arrival order (or reversed), and answer their callers. */
  async release(order: "fifo" | "reverse" = "fifo"): Promise<void> {
    const q = order === "fifo" ? this.held : [...this.held].reverse();
    this.held = [];
    for (const h of q) {
      try {
        h.resolve(await this.inner.send(h.req));
      } catch (e) {
        h.reject(e);
      }
    }
  }

  private async orphan(req: HttpRequest): Promise<void> {
    const op = operationKey(req.method, req.target) ?? req.target;
    try {
      const r = await this.inner.send(req);
      this.orphans.push({ op, status: r.status });
    } catch {
      this.orphans.push({ op, status: "error" });
    }
  }

  private choose(req: HttpRequest, key: string | null): Rule | null {
    for (const r of this.rules) {
      if (r.left > 0 && matches(r.match, req, key)) {
        r.left--;
        this.rules = this.rules.filter((x) => x.left > 0);
        return r;
      }
    }
    if (this.mix && matches(this.mix.m.match, req, key)) {
      const { m, rnd } = this.mix;
      for (const kind of ["fail_before", "lose_response", "duplicate", "late", "latency"] as const) {
        const p = m.rates[kind] ?? 0;
        if (p > 0 && rnd() < p) {
          const [lo, hi] = m.latencyMs ?? [10, 1000];
          return { kind, ms: Math.round(lo + rnd() * (hi - lo)) };
        }
      }
    }
    return null;
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    const n = ++this.n;
    const key = operationKey(req.method, req.target);
    const op = key ?? req.target.split("?")[0]!;
    if (this.cut) {
      this.log.push({ n, op, kind: "partition" });
      throw new NetworkError("offline");
    }
    const rule = this.choose(req, key);
    this.log.push({ n, op, kind: rule?.kind ?? "ok" });
    switch (rule?.kind) {
      case undefined:
        return this.inner.send(req);
      case "fail_before":
        throw new NetworkError("offline");
      case "lose_response":
        await this.inner.send(req).catch(() => undefined);
        throw new NetworkError("timeout");
      case "duplicate": {
        const first = await this.inner.send(req);
        const second = await this.inner.send(req);
        if (rule.answer === "second") {
          this.orphans.push({ op, status: first.status });
          return second;
        }
        this.orphans.push({ op, status: second.status });
        return first;
      }
      case "late":
        this.lateQueue.push(req);
        throw new NetworkError("timeout");
      case "hold":
        return new Promise<HttpResponse>((resolve, reject) => this.held.push({ req, resolve, reject }));
      case "latency":
        await this.sleep(rule.ms ?? 100);
        return this.inner.send(req);
    }
  }
}
