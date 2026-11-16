// The M3 crash machinery (the style of M2's test/helpers/m2-crash.ts, extended to the network): one process for a
// device's chrome.storage.local, its IndexedDB mirror and identity, its session AND its transport. It dies at step N of
// an operation, where a step is any storage write or any request sent:
//   before  the step never happens (a write not made; a request never sent), and the process is dead;
//   after   the step happens (the write lands; the request reaches the server and is executed), then the process dies
//           before hearing about it (for a request: the answer is lost with the worker);
//   lie     a storage write is acknowledged and dropped (A4R-10, the lying disk), or a request is delivered and its
//           answer lost (a NetworkError), and the process goes on.
// After the death the device restarts (a service-worker restart keeps storage.session; a browser restart clears it and
// runs the store's self-check), and the tests check what must hold whatever the step was.
import type { KV } from "../../src/core/storage/kv";
import type { SessionCache, SessionData } from "../../src/core/service/types";
import { MemoryKV } from "../../src/core/storage/kv";
import { MemorySession } from "../../src/core/service/types";
import {
  NetworkError,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "../../src/core/sync/engine/transport";
import { contextOver, type Context, type Device } from "./m3-world";

export class Dead extends Error {
  constructor() {
    super("process died");
    this.name = "Dead";
  }
}
export type Mode = "before" | "after" | "lie";

export class Proc {
  calls = 0;
  dead = false;
  readonly steps: string[] = [];
  constructor(
    public at = Infinity,
    public mode: Mode = "before",
  ) {}
  /** True: the step happens. False: it does not ("before", or a "lie"). Throws Dead once dead. */
  hit(what: string): boolean {
    if (this.dead) throw new Dead();
    this.calls++;
    this.steps.push(what);
    if (this.calls === this.at) {
      if (this.mode === "lie") return false;
      this.dead = true;
      return this.mode === "after";
    }
    return true;
  }
}

export class ProcKV implements KV {
  constructor(
    private readonly inner: MemoryKV,
    private readonly p: Proc,
    private readonly name: string,
  ) {}
  async get(k: string[]) {
    if (this.p.dead) throw new Dead();
    return this.inner.get(k);
  }
  async keys() {
    if (this.p.dead) throw new Dead();
    return this.inner.keys();
  }
  async set(items: Record<string, unknown>) {
    const land = this.p.hit(`${this.name}.set ${Object.keys(items).join(",")}`);
    if (land) await this.inner.set(items);
    if (this.p.dead) throw new Dead();
  }
  async remove(keys: string[]) {
    const land = this.p.hit(`${this.name}.remove ${keys.join(",")}`);
    if (land) await this.inner.remove(keys);
    if (this.p.dead) throw new Dead();
  }
}

export class ProcSession implements SessionCache {
  constructor(
    private readonly inner: MemorySession,
    private readonly p: Proc,
  ) {}
  async get() {
    if (this.p.dead) throw new Dead();
    return this.inner.get();
  }
  async set(d: SessionData) {
    const land = this.p.hit("session.set");
    if (land) await this.inner.set(d);
    if (this.p.dead) throw new Dead();
  }
  async clear() {
    const land = this.p.hit("session.clear");
    if (land) await this.inner.clear();
    if (this.p.dead) throw new Dead();
  }
  async lockEpoch() {
    return this.inner.lockEpoch();
  }
  async bumpLockEpoch() {
    return this.inner.bumpLockEpoch();
  }
  // the session quick unlock (QUICK-UNLOCK Stage 1): passed through, not a crash point; a dead process touches nothing
  async getQuick() {
    if (this.p.dead) throw new Dead();
    return this.inner.getQuick();
  }
  async setQuick(q: Parameters<SessionCache["setQuick"]>[0]) {
    if (this.p.dead) throw new Dead();
    return this.inner.setQuick(q);
  }
  async clearQuick() {
    if (this.p.dead) throw new Dead();
    return this.inner.clearQuick();
  }
}

/** A request is a step: "before" never sends it; "after" sends it and dies before the answer; "lie" loses the answer. */
export class ProcTransport implements Transport {
  constructor(
    private readonly inner: Transport,
    private readonly p: Proc,
  ) {}
  async send(req: HttpRequest): Promise<HttpResponse> {
    const what = `send ${req.method} ${req.target.split("?")[0]}`;
    if (this.p.dead) throw new Dead();
    this.p.calls++;
    this.p.steps.push(what);
    if (this.p.calls === this.p.at) {
      if (this.p.mode === "before") {
        this.p.dead = true;
        throw new Dead();
      }
      await this.inner.send(req).catch(() => undefined);
      if (this.p.mode === "after") {
        this.p.dead = true;
        throw new Dead();
      }
      throw new NetworkError("unknown"); // lie: delivered, the answer lost, the process goes on
    }
    const res = await this.inner.send(req);
    if (this.p.dead) throw new Dead();
    return res;
  }
}

/** The device's context over dying storage and a dying transport (its locks are the device's own). */
export function dyingContext(d: Device, p: Proc): Context {
  return contextOver({
    kv: new ProcKV(d.disk.kv, p, "local"),
    mirror: new ProcKV(d.disk.mirror, p, "mirror"),
    idb: new ProcKV(d.disk.idb, p, "idb"),
    session: new ProcSession(d.disk.session, p),
    lock: d.lock,
    identityLock: d.identityLock,
    syncLock: d.syncLock,
    transport: new ProcTransport(d.net, p),
    clock: d.now,
    scheduler: d.scheduler,
    diag: d.diag,
  });
}

/** Runs `op` until it dies (or finishes); true when it reached step `at` (false: it finished before, the matrix is done). */
export async function runDying(
  d: Device,
  at: number,
  mode: Mode,
  op: (c: Context) => Promise<unknown>,
): Promise<{ reached: boolean; error?: unknown; steps: string[] }> {
  const p = new Proc(at, mode);
  let error: unknown;
  try {
    await op(dyingContext(d, p));
  } catch (e) {
    if (!(e instanceof Dead)) error = e;
  }
  return { reached: p.calls >= at, ...(error !== undefined ? { error } : {}), steps: p.steps };
}
