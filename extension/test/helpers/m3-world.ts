// M3 test worlds: several devices (Chrome profiles), each with its own chrome.storage.local, IndexedDB mirror, IndexedDB
// identity and session, its own vault lock and sixkey-sync lock (shared by that device's contexts), wired exactly the way
// platform/runtime.ts wires a context plus what M5 will add (SyncLocal, SyncFlows, the engine, the outbox writer as the
// port's afterCommit), all talking to one FakeServer through per-device FaultyTransports, on one virtual clock with a skew
// per device. A device's "context" can be rebuilt over the same storage: a service-worker restart (the session kept) or a
// browser restart (the session cleared and the store's self-check), so every test can kill the engine mid-round.
import { fromB64 } from "../../src/core/crypto/bytes";
import { decryptVault } from "../../src/core/crypto/envelope";
import { vkFromRaw, type Vk } from "../../src/core/crypto/vk";
import { checkGeneration, KEYS, type Generation } from "../../src/core/storage/format";
import { createMutex, MemoryKV, type KV, type Lock } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService, type SyncPort } from "../../src/core/service/service";
import { SyncFlows } from "../../src/core/service/sync-flows";
import { KvSettingsStore, MemorySession, type SessionCache } from "../../src/core/service/types";
import { SyncEngine } from "../../src/core/sync/engine/engine";
import type { TryLock } from "../../src/core/sync/engine/deps";
import { commitJoin, firstUpload, joinWithRecoveryCode } from "../../src/core/sync/engine/enroll";
import type { Scheduler, Wake, WakeName } from "../../src/core/sync/engine/schedule";
import type { Transport } from "../../src/core/sync/engine/transport";
import { createOutboxWriter } from "../../src/core/sync/local/outbox";
import { createSyncPort } from "../../src/core/sync/local/port";
import { SyncLocal } from "../../src/core/sync/local/sync-local";
import { formatHlc } from "../../src/core/vault/hlc";
import { canonicalJson } from "../../src/core/vault/merge";
import type { Vault } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { deserializeVault } from "../../src/core/vault/validate";
import { FakeServer, type Snapshot } from "./fake-server";
import { FaultyTransport, prng } from "./faulty-transport";
import { input, secretOf } from "./m2-world";
import { createProtected, STRONG } from "./vaults";
import { TEST_KDF_ITERATIONS } from "./kdf";

export const ORIGIN = "https://api.sixkey.app";
export const EMAIL = "owner@example.com";
export const T0 = 1_792_051_200_000; // a whole UTC hour

/** A sixkey-sync lock with ifAvailable semantics, shared by one device's contexts. */
export function tryMutex(): TryLock & { held(): boolean } {
  let busy = false;
  const f = (async <T>(fn: () => Promise<T>) => {
    if (busy) return { ran: false as const };
    busy = true;
    try {
      return { ran: true as const, value: await fn() };
    } finally {
      busy = false;
    }
  }) as TryLock & { held(): boolean };
  f.held = () => busy;
  return f;
}

/** The engine's timers on the virtual clock: what is scheduled, and when (M5 maps it to setTimeout / alarms). */
export class VirtualScheduler implements Scheduler {
  readonly wakes = new Map<WakeName, Wake>();
  readonly log: { name: WakeName; wake: Wake }[] = [];
  schedule(name: WakeName, wake: Wake): void {
    this.wakes.set(name, wake);
    this.log.push({ name, wake });
  }
  cancel(name: WakeName): void {
    this.wakes.delete(name);
  }
}

export type Disk = { kv: MemoryKV; mirror: MemoryKV; idb: MemoryKV; session: MemorySession };
const cloneKv = (m: MemoryKV) => {
  const n = new MemoryKV();
  for (const [k, v] of m.data) n.data.set(k, structuredClone(v));
  return n;
};
export const cloneDisk = (d: Disk): Disk => {
  const session = new MemorySession();
  session.data = d.session.data ? { ...d.session.data } : null;
  session.epoch = d.session.epoch;
  return { kv: cloneKv(d.kv), mirror: cloneKv(d.mirror), idb: cloneKv(d.idb), session };
};
export const newDisk = (): Disk => ({
  kv: new MemoryKV(),
  mirror: new MemoryKV(),
  idb: new MemoryKV(),
  session: new MemorySession(),
});

export type Clock = { now: number };

/** One context of a device over (possibly wrapped) storage: the runtime's wiring plus M5's. */
export function contextOver(o: {
  kv: KV;
  mirror: KV;
  idb: KV;
  session: SessionCache;
  lock: Lock;
  identityLock: Lock;
  syncLock: TryLock;
  transport: Transport;
  clock: () => number;
  scheduler?: Scheduler;
  outbox?: boolean;
  diag?: string[];
  random?: () => number;
  clientVersion?: string;
  networkAllowed?: () => Promise<boolean>;
  /**
   * The master password's wraps made by this context's service. By default the sync engine's own count, 600k, which is
   * what these worlds test, at a third of the cost of the production count (2M since OWNER-DECISIONS/15, which doubled
   * the sync suites' time); "production" leaves the service's default, for test/unit/own-password.test.ts.
   */
  kdf?: "production";
}) {
  const port = createSyncPort({ local: o.kv, vaultLock: o.lock });
  const sync: SyncPort = o.outbox === false ? port : { ...port, afterCommit: createOutboxWriter(o.kv) };
  const store = new VaultStore({
    kv: o.kv,
    mirror: o.mirror,
    lock: o.lock,
    now: o.clock,
    beforeRecoveryWrite: () => port.clearLastSynced(),
    onDiag: (m) => o.diag?.push(m),
  });
  const settings = new KvSettingsStore(o.kv);
  const svc = new VaultService({
    store,
    session: o.session,
    settings,
    now: o.clock,
    vkRecords: port.records,
    sync,
    onDiag: (m) => o.diag?.push(m),
    ...(o.kdf === "production" ? {} : { kdfIterations: TEST_KDF_ITERATIONS }),
  });
  const local = new SyncLocal({ local: o.kv, identity: o.idb, vaultLock: o.lock, identityLock: o.identityLock });
  const flows = new SyncFlows(svc, local);
  const engine = new SyncEngine({
    origin: ORIGIN,
    transport: o.transport,
    flows,
    local,
    kv: o.kv,
    vaultLock: o.lock,
    syncLock: o.syncLock,
    now: o.clock,
    sleep: async () => undefined,
    ...(o.scheduler ? { scheduler: o.scheduler } : {}),
    random: o.random ?? (() => 0.5),
    clientVersion: o.clientVersion ?? "0.1.0", // M4's default minimum (the FakeServer's too); the manifest's 0.0.1 is M5's to bump
    hlcDevice: () => settings.deviceId(),
    diag: (m) => o.diag?.push(m),
    ...(o.networkAllowed ? { networkAllowed: o.networkAllowed } : {}),
  });
  return { store, svc, local, flows, engine, settings, port };
}
export type Context = ReturnType<typeof contextOver>;

export class Device {
  readonly lock: Lock = createMutex();
  readonly identityLock: Lock = createMutex();
  readonly syncLock = tryMutex();
  readonly net: FaultyTransport;
  readonly scheduler = new VirtualScheduler();
  readonly diag: string[] = [];
  skewMs = 0;
  ctx: Context;
  constructor(
    readonly name: string,
    readonly disk: Disk,
    private readonly w: World,
    o: { skewMs?: number } = {},
  ) {
    this.skewMs = o.skewMs ?? 0;
    this.net = new FaultyTransport(w.server.transport());
    this.ctx = this.build();
  }
  /** This device's clock (the world's, skewed). */
  now = (): number => this.w.clock.now + this.skewMs;
  build(): Context {
    return contextOver({
      ...this.disk,
      lock: this.lock,
      identityLock: this.identityLock,
      syncLock: this.syncLock,
      transport: this.net,
      clock: this.now,
      scheduler: this.scheduler,
      diag: this.diag,
      random: prng(this.name.length * 7919 + 1),
      ...(this.w.productionKdf ? { kdf: "production" as const } : {}),
    });
  }
  get svc() {
    return this.ctx.svc;
  }
  get flows() {
    return this.ctx.flows;
  }
  get local() {
    return this.ctx.local;
  }
  get engine() {
    return this.ctx.engine;
  }
  /** The service worker stopped and started again: nothing in memory survives; storage and storage.session do. */
  restartWorker(): void {
    this.ctx = this.build();
  }
  /** The browser restarted: storage.session is cleared (locked), and the store's self-check runs. */
  async restartBrowser(): Promise<void> {
    this.disk.session.data = null;
    this.ctx = this.build();
    await this.ctx.store.selfCheck();
  }
  async lockNow(): Promise<void> {
    await this.ctx.svc.lock();
  }
  async unlock(): Promise<void> {
    await this.ctx.svc.unlockWithRecoveryCode(this.w.code);
  }
  /** This device's session key (it must be unlocked). */
  async vk(): Promise<Vk> {
    return vkFromRaw(fromB64(this.disk.session.data!.vk));
  }
  /** The vault as committed on this device (decrypted with the session key or the given one). */
  async vault(vk?: Vk): Promise<Vault> {
    const g = await this.generation();
    const key = vk ?? (await vkFromRaw(fromB64(this.disk.session.data!.vk)));
    return deserializeVault(await decryptVault(g.envelope, key));
  }
  /**
   * The active generation as stored. With the active slot torn (a tear test), the other slot, which the store's next load
   * recovers to: read-only, so the harness's own reads (the oracle, an edit's pick) never run the recovery themselves.
   */
  async generation(): Promise<Generation> {
    const ptr = this.disk.kv.data.get(KEYS.active) as "a" | "b";
    const g = await checkGeneration(this.disk.kv.data.get(KEYS.slot[ptr]));
    return g ?? (await checkGeneration(this.disk.kv.data.get(KEYS.slot[ptr === "a" ? "b" : "a"])))!;
  }
  async add(name: string, secret = secretOf(name)): Promise<void> {
    await this.svc.mutate((v, c, now) => addEntry(v, input(name, secret), c, { now: () => now }).vault);
  }
}

export class World {
  readonly clock: Clock = { now: T0 };
  readonly server: FakeServer;
  readonly devices: Device[] = [];
  code = "";
  password = STRONG;
  /** Every device's service at the production count of master-password wraps (contextOver's `kdf`). */
  productionKdf = false;
  constructor(o: { server?: FakeServer; validateWire?: boolean } = {}) {
    this.server =
      o.server ??
      new FakeServer({ now: () => this.clock.now, ...(o.validateWire === false ? { validateWire: false } : {}) });
  }
  advance(ms: number): void {
    this.clock.now += ms;
  }
  device(name: string, disk: Disk = newDisk(), o: { skewMs?: number } = {}): Device {
    const d = new Device(name, disk, this, o);
    this.devices.push(d);
    return d;
  }
  /** The head vault on the server, decrypted with `vk`. */
  async serverVault(vk: Vk): Promise<Vault | null> {
    const v = this.server.account(EMAIL).vault;
    if (!v) return null;
    return deserializeVault(await decryptVault(JSON.parse(v.envelope), vk));
  }
}

/** The first device: a protected vault with `names`, then §3.1's first upload. Returns the world, the device and its VK. */
export async function firstDevice(
  w: World,
  names: string[] = ["GitHub", "AWS"],
  o: { skewMs?: number; name?: string } = {},
): Promise<Device> {
  const d = w.device(o.name ?? "A", newDisk(), o.skewMs !== undefined ? { skewMs: o.skewMs } : {});
  const r = await createProtected(d.svc, w.password);
  w.code = r.recoveryCode;
  await d.svc.openView(); // the popup opened once: its first full check records the store as clean (sk_store_v)
  for (const n of names) {
    w.advance(1000);
    await d.add(n);
  }
  const session = await w.server.session(EMAIL);
  const res = await firstUpload(d.engine, {
    session,
    password: w.password,
    recoveryCode: w.code,
    deviceName: `Device ${d.name}`,
    email: EMAIL,
  });
  if (res.kind !== "done") throw new Error(`first upload: ${res.kind}`);
  return d;
}

/** Another device joins with the recovery code (§3.3, empty profile), then completes. */
export async function joinDevice(w: World, name: string, o: { skewMs?: number; disk?: Disk } = {}): Promise<Device> {
  const d = w.device(name, o.disk ?? newDisk(), o.skewMs !== undefined ? { skewMs: o.skewMs } : {});
  const session = await w.server.session(EMAIL);
  const plan = await joinWithRecoveryCode(d.engine, {
    session,
    recoveryCode: w.code,
    deviceName: `Device ${name}`,
    email: EMAIL,
  });
  const r = await commitJoin(plan);
  if (r !== "enrolled") throw new Error(`join: ${r}`);
  return d;
}

/** A world with `n` devices in sync (the first uploads, the others join and run one round each). */
export async function worldOf(
  n: number,
  names: string[] = ["GitHub", "AWS"],
  skews: number[] = [],
  o: { validateWire?: boolean } = {},
): Promise<World> {
  const w = new World(o);
  const a = await firstDevice(w, names, skews[0] !== undefined ? { skewMs: skews[0] } : {});
  await a.engine.round();
  for (let i = 1; i < n; i++) {
    const d = await joinDevice(w, String.fromCharCode(65 + i), skews[i] !== undefined ? { skewMs: skews[i] } : {});
    await d.engine.round();
  }
  return w;
}

/** A copy of a world: every device's storage and the server's database (to reuse an expensive set-up). */
export function cloneWorld(w: World): World {
  const c = new World();
  c.clock.now = w.clock.now;
  c.code = w.code;
  c.password = w.password;
  c.server.restore(w.server.snapshot() as Snapshot);
  c.server.skewMs = w.server.skewMs;
  for (const d of w.devices) c.device(d.name, cloneDisk(d.disk), { skewMs: d.skewMs });
  return c;
}

/**
 * Rounds on every device until nothing moves: every round succeeded ("ok"), none uploaded, no generation changed. At most
 * `max` passes. Returns the passes it took. A failed round (offline, an error) is never "quiet".
 */
export async function quiesce(w: World, max = 8, devices: Device[] = w.devices): Promise<number> {
  let last: string[] = [];
  for (let pass = 1; pass <= max; pass++) {
    const before = w.server.requests.filter((r) => r.op === "PUT /v1/vault" && r.status === 200).length;
    const gens = await Promise.all(devices.map(async (d) => (await d.generation())?.envelope.checksum ?? "unreadable")); // torn: the round recovers it
    let allOk = true;
    last = [];
    for (const d of devices) {
      w.advance(1000);
      let r = await d.engine.round({ explicit: true });
      // a merge the guard stopped: the model's user applies it (the merge itself, i.e. the join; "keep mine" would commit anew)
      if (r.status === "review_needed" && r.blocked)
        r = await d.engine.round({
          explicit: true,
          answer: {
            seen: r.blocked.seen,
            accept: [...r.blocked.report.secretChanged, ...r.blocked.report.purgedAlive],
          },
        });
      last.push(`${d.name}:${r.status}${r.error ? `/${r.error}` : ""}`);
      if (r.status !== "ok" || r.error) allOk = false;
    }
    const after = w.server.requests.filter((r) => r.op === "PUT /v1/vault" && r.status === 200).length;
    const gens2 = await Promise.all(
      devices.map(async (d) => (await d.generation())?.envelope.checksum ?? "unreadable"),
    );
    if (allOk && after === before && gens.every((g, i) => g === gens2[i])) return pass;
  }
  throw new Error(`no quiescence after ${max} passes: ${last.join(" ")}`);
}

export const cj = (v: unknown): string => canonicalJson(v);

/** `n` valid entries built directly (not through addEntry: thousands of them), ids `${prefix}-0000001`… */
export function bulkEntries(
  n: number,
  prefix: string,
  wall: number,
  o: { device?: string; text?: number } = {},
): Vault["entries"] {
  const dev = o.device ?? "bulk";
  const pad = (x: string) => (o.text ? x.padEnd(o.text, "x") : x);
  return Array.from({ length: n }, (_, i) => {
    const hlc = formatHlc(wall, i % 0xffff, dev);
    return {
      id: `${prefix}-${String(i).padStart(7, "0")}`,
      createdAt: wall,
      type: "totp" as const,
      issuer: pad(`Bulk ${i}`),
      label: pad("a"),
      secret: "JBSWY3DPEHPK3PXP",
      algorithm: "SHA1" as const,
      digits: 6 as const,
      period: 30,
      hlc,
      order: `V${String(i).padStart(6, "1")}`.replace(/0/g, "1"),
      phlc: hlc,
    };
  });
}
