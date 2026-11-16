// The live harness: the sync engine in Node, sending real requests with the extension's own fetch transport
// (src/platform/fetch-transport.ts) to the real API server (server.ts), or, for the same scenarios run twice, to the
// in-memory FakeServer with the same origin and the same real clock. SYNC-DESIGN §8.5 asks that the client's tests give
// the same results against both; each scenario in m5-live.test.ts runs on both backends.
//
// A device is a Chrome profile's storage (chrome.storage.local, the IndexedDB mirror and identity, storage.session) wired
// the way test/helpers/m3-world.ts contextOver wires a context, with this backend's origin, a real clock and real sleeps.
// Its transport records each request's operation (method and path template), status and error code, never a body, a
// header value or a secret, and can be told to interleave another device before a request or to lose one answer.
import { fromB64 } from "../../src/core/crypto/bytes";
import { decryptVault } from "../../src/core/crypto/envelope";
import { vkFromRaw, type Vk } from "../../src/core/crypto/vk";
import { checkGeneration, KEYS, type Generation } from "../../src/core/storage/format";
import { createMutex, MemoryKV, type Lock } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService, type SyncPort } from "../../src/core/service/service";
import { SyncFlows } from "../../src/core/service/sync-flows";
import { KvSettingsStore, MemorySession } from "../../src/core/service/types";
import type { AccountSession } from "../../src/core/sync/engine/api";
import { SyncEngine, type RoundResult } from "../../src/core/sync/engine/engine";
import { commitJoin, firstUpload, joinWithRecoveryCode } from "../../src/core/sync/engine/enroll";
import {
  NetworkError,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "../../src/core/sync/engine/transport";
import type { DeviceIdentity } from "../../src/core/sync/local/identity";
import { createOutboxWriter } from "../../src/core/sync/local/outbox";
import { createSyncPort } from "../../src/core/sync/local/port";
import { SyncLocal } from "../../src/core/sync/local/sync-local";
import { aliveEntries, type Vault } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { deserializeVault } from "../../src/core/vault/validate";
import { FetchTransport } from "../../src/platform/fetch-transport";
import { FakeServer } from "../helpers/fake-server";
import { operationKey } from "../helpers/faulty-transport";
import { input, secretOf } from "../helpers/m2-world";
import { tryMutex } from "../helpers/m3-world";
import { createProtected, STRONG } from "../helpers/vaults";
import type { LiveServer } from "./server";

/**
 * Where requests go: the real server through the fetch transport, or the FakeServer in memory. Two controls the
 * scenarios need from either: the server's min_client_version (the real one restarts with it), and an outage (the real
 * one loses its database and answers 503 with Retry-After; the FakeServer is told to).
 */
export type Backend = {
  kind: "live" | "fake";
  origin: string;
  transport: Transport;
  session(email: string): Promise<AccountSession>;
  setMinimum(version: string): Promise<void>;
  outage(on: boolean): Promise<void>;
  fake?: FakeServer;
  server?: LiveServer;
};

export function liveBackend(server: LiveServer): Backend {
  const t = new FetchTransport({ origin: server.base });
  return {
    kind: "live",
    origin: server.origin,
    transport: t,
    server,
    setMinimum: (version) => server.restart({ minClientVersion: version }),
    outage: async (on) => (on ? server.stopDatabase() : server.startDatabase()),
    async session(email) {
      const o = await t.send({
        method: "POST",
        target: "/v1/auth/otp",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (o.status !== 202) throw new Error(`otp: HTTP ${o.status}`);
      const v = await t.send({
        method: "POST",
        target: "/v1/auth/verify",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, token: server.inbox(email) }),
      });
      if (v.status !== 200) throw new Error(`verify: HTTP ${v.status}`);
      const token = (JSON.parse(v.body) as { account_token: string }).account_token;
      const sub = (JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { sub: string }).sub;
      return { token, sub };
    },
  };
}

export function fakeBackend(origin = "http://127.0.0.1:8787"): Backend {
  const fake = new FakeServer({ origin, now: () => Date.now() });
  return {
    kind: "fake",
    origin,
    transport: fake.transport(),
    fake,
    session: (e) => fake.session(e),
    setMinimum: async (version) => {
      fake.minClientVersion = version;
    },
    outage: async (on) => {
      if (on)
        fake.fault({
          match: () => true,
          kind: "status",
          status: 503,
          code: "unavailable",
          retryAfter: 5,
          count: 1_000_000,
        });
      else fake.clearFaults();
    },
  };
}

export type WireEntry = { dev: string; op: string; status: number | "network" | "dropped"; code?: string };

/** One device's transport: records, and runs the test's interleavings and lost answers (each once). */
export class LiveTransport implements Transport {
  private readonly before: { match: string; fn: () => Promise<void> }[] = [];
  private readonly drops: string[] = [];
  private readonly fails: string[] = [];
  constructor(
    readonly dev: string,
    readonly wire: WireEntry[],
    private readonly inner: Transport,
  ) {}

  /** Before the next request of operation `op` is sent, run `fn` (another device's round, a server restart). */
  beforeOnce(op: string, fn: () => Promise<void>): void {
    this.before.push({ match: op, fn });
  }
  /** The next request of operation `op` reaches the server, and its answer is lost (NetworkError). */
  dropAnswerOnce(op: string): void {
    this.drops.push(op);
  }
  /** The next request of operation `op` never leaves (NetworkError, nothing sent: the network is down for it). */
  failOnce(op: string): void {
    this.fails.push(op);
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    const op = operationKey(req.method, req.target) ?? `${req.method} ?`;
    const b = this.before.findIndex((x) => x.match === op);
    if (b !== -1) await this.before.splice(b, 1)[0]!.fn();
    const f = this.fails.indexOf(op);
    if (f !== -1) {
      this.fails.splice(f, 1);
      this.wire.push({ dev: this.dev, op, status: "network" });
      throw new NetworkError("offline");
    }
    let res: HttpResponse;
    try {
      res = await this.inner.send(req);
    } catch (e) {
      this.wire.push({ dev: this.dev, op, status: "network" });
      throw e instanceof NetworkError ? e : new NetworkError("unknown");
    }
    const d = this.drops.indexOf(op);
    if (d !== -1) {
      this.drops.splice(d, 1);
      this.wire.push({ dev: this.dev, op, status: "dropped" });
      throw new NetworkError("unknown");
    }
    let code: string | undefined;
    if (res.status >= 400) {
      try {
        code = (JSON.parse(res.body) as { error?: { code?: string } }).error?.code;
      } catch {
        code = "(no JSON body)";
      }
    }
    this.wire.push({ dev: this.dev, op, status: res.status, ...(code ? { code } : {}) });
    return res;
  }
}

export class LiveDevice {
  readonly kv = new MemoryKV();
  readonly mirror = new MemoryKV();
  readonly idb = new MemoryKV();
  readonly session = new MemorySession();
  readonly lock: Lock = createMutex();
  readonly identityLock: Lock = createMutex();
  readonly syncLock = tryMutex();
  readonly diag: string[] = [];
  readonly net: LiveTransport;
  ctx!: ReturnType<LiveDevice["build"]>;
  constructor(
    readonly name: string,
    readonly w: LiveWorld,
    private readonly clientVersion = "0.1.0",
  ) {
    this.net = new LiveTransport(name, w.wire, w.backend.transport);
    this.restartWorker();
  }
  private build() {
    const now = () => Date.now();
    const port = createSyncPort({ local: this.kv, vaultLock: this.lock });
    const sync: SyncPort = { ...port, afterCommit: createOutboxWriter(this.kv) };
    const store = new VaultStore({
      kv: this.kv,
      mirror: this.mirror,
      lock: this.lock,
      now,
      beforeRecoveryWrite: () => port.clearLastSynced(),
      onDiag: (m) => this.diag.push(m),
    });
    const settings = new KvSettingsStore(this.kv);
    const svc = new VaultService({
      store,
      session: this.session,
      settings,
      now,
      vkRecords: port.records,
      sync,
      onDiag: (m) => this.diag.push(m),
    });
    const local = new SyncLocal({
      local: this.kv,
      identity: this.idb,
      vaultLock: this.lock,
      identityLock: this.identityLock,
    });
    const flows = new SyncFlows(svc, local);
    const engine = new SyncEngine({
      origin: this.w.backend.origin,
      transport: this.net,
      flows,
      local,
      kv: this.kv,
      vaultLock: this.lock,
      syncLock: this.syncLock,
      now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      random: () => 0.5,
      clientVersion: this.clientVersion,
      hlcDevice: () => settings.deviceId(),
      diag: (m) => this.diag.push(m),
    });
    return { store, svc, local, flows, engine, settings };
  }
  /** A service worker restart: nothing in memory survives; storage and storage.session do. */
  restartWorker(): void {
    this.ctx = this.build();
  }
  /** A browser restart: storage.session is cleared (locked), and the store's self-check runs. */
  async restartBrowser(): Promise<void> {
    this.session.data = null;
    this.restartWorker();
    await this.ctx.store.selfCheck();
  }
  get svc() {
    return this.ctx.svc;
  }
  get engine() {
    return this.ctx.engine;
  }
  get local() {
    return this.ctx.local;
  }
  async identity(): Promise<DeviceIdentity> {
    const id = await this.local.settlePins();
    if (!id || id === "damaged") throw new Error(`${this.name}: no identity`);
    return id;
  }
  async vk(): Promise<Vk> {
    return vkFromRaw(fromB64(this.session.data!.vk));
  }
  async generation(): Promise<Generation> {
    const ptr = this.kv.data.get(KEYS.active) as "a" | "b";
    return (await checkGeneration(this.kv.data.get(KEYS.slot[ptr])))!;
  }
  /** The vault as committed here, decrypted with `vk` (default: this device's session key). */
  async vault(vk?: Vk): Promise<Vault> {
    return deserializeVault(await decryptVault((await this.generation()).envelope, vk ?? (await this.vk())));
  }
  async issuers(vk?: Vk): Promise<string[]> {
    return aliveEntries(await this.vault(vk))
      .map((e) => e.issuer)
      .sort();
  }
  async add(name: string): Promise<void> {
    await this.svc.mutate((v, c, now) => addEntry(v, input(name, secretOf(name)), c, { now: () => now }).vault);
  }
  async unlock(): Promise<void> {
    await this.svc.unlockWithPassword(this.w.password);
  }
  round(o: Parameters<SyncEngine["round"]>[0] = {}): Promise<RoundResult> {
    return this.engine.round(o);
  }
}

/** One account on a backend. */
export class LiveWorld {
  readonly wire: WireEntry[] = [];
  readonly devices: LiveDevice[] = [];
  readonly email: string;
  readonly password = STRONG;
  code = "";
  constructor(
    readonly backend: Backend,
    tag: string,
  ) {
    this.email = `m5-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  }
  device(name: string, clientVersion?: string): LiveDevice {
    const d = new LiveDevice(name, this, clientVersion);
    this.devices.push(d);
    return d;
  }
  session(): Promise<AccountSession> {
    return this.backend.session(this.email);
  }
  /** Requests of operation `op` with status `status` so far (all devices). */
  count(op: string, status?: WireEntry["status"]): number {
    return this.wire.filter((e) => e.op === op && (status === undefined || e.status === status)).length;
  }
  /** The first device: a protected vault with `names`, the popup opened once, then §3.1's first upload. */
  async first(names: string[] = ["GitHub", "AWS"], name = "A"): Promise<LiveDevice> {
    const d = this.device(name);
    const r = await createProtected(d.svc, this.password);
    this.code = r.recoveryCode;
    await d.svc.openView();
    for (const n of names) await d.add(n);
    const res = await firstUpload(d.engine, {
      session: await this.session(),
      password: this.password,
      recoveryCode: this.code,
      deviceName: `Device ${name}`,
      email: this.email,
    });
    if (res.kind !== "done") throw new Error(`first upload: ${res.kind}`);
    return d;
  }
  /** Another device joins with the recovery code (§3.3) from an empty profile. */
  async join(name: string): Promise<LiveDevice> {
    const d = this.device(name);
    const plan = await joinWithRecoveryCode(d.engine, {
      session: await this.session(),
      recoveryCode: this.code,
      deviceName: `Device ${name}`,
      email: this.email,
    });
    const r = await commitJoin(plan);
    if (r !== "enrolled") throw new Error(`join: ${r}`);
    return d;
  }
  /** Rounds on every device until a pass changes nothing (every round "ok", no upload); at most `max` passes. */
  async quiesce(max = 6): Promise<number> {
    let last = "";
    for (let pass = 1; pass <= max; pass++) {
      let quiet = true;
      const line: string[] = [];
      for (const d of this.devices) {
        const r = await d.round({ explicit: true });
        line.push(`${d.name}:${r.status}${r.error ? `/${r.error}` : ""}${r.uploaded ? "+up" : ""}`);
        if (r.status !== "ok" || r.error || r.uploaded || r.merged) quiet = false;
      }
      last = line.join(" ");
      if (quiet) return pass;
    }
    throw new Error(`no quiescence after ${max} passes: ${last}`);
  }
}

/** The state record as stored (numbers and codes only). */
export const stateOf = (d: LiveDevice) =>
  d.kv.data.get("sk_sync_state") as
    | {
        status?: string;
        failures?: number;
        backoffUntil?: number | null;
        lastErrorCode?: string | null;
        serverOffsetMs?: number;
      }
    | undefined;
