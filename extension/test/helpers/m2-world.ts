// M2 test worlds: a profile's chrome.storage.local, its IndexedDB mirror and identity database, the session, one vault
// lock shared by the store, the records and the service (as webLock("sixkey-vault") is across contexts), and the
// service with sync's local side wired the way platform/runtime.ts wires it, plus SyncFlows on top (as M5 will).
import { bs, fromB64 } from "../../src/core/crypto/bytes";
import { rekey, setRecovery, unlockWithPassword, type Keyring } from "../../src/core/crypto/keyring";
import { vkFromRaw, type Vk } from "../../src/core/crypto/vk";
import { checkGeneration, KEYS, type Generation } from "../../src/core/storage/format";
import { createMutex, MemoryKV, type KV, type Lock } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService, type ServiceDeps } from "../../src/core/service/service";
import { SyncFlows } from "../../src/core/service/sync-flows";
import { KvSettingsStore, MemorySession, type SessionCache } from "../../src/core/service/types";
import type { SensitiveOp } from "../../src/core/sync/crypto/adoption";
import {
  evaluateSameVkBundle,
  unlockWithSync,
  type Adoption,
  type SameVkInput,
  type UnlockInput,
  type UnlockSecret,
} from "../../src/core/sync/crypto/bundle-eval";
import {
  adoptedRecord,
  newBundleAuth,
  sealBundle,
  truncateKeyringTimes,
  type BundleAuth,
  type KeyBundle,
} from "../../src/core/sync/crypto/keybundle";
import { preSendCheck, published, type Published } from "../../src/core/sync/crypto/presend";
import { generateDeviceKey, newDeviceId } from "../../src/core/sync/crypto/device-key";
import type { DeviceIdentity } from "../../src/core/sync/local/identity";
import { SYNC_KEYS } from "../../src/core/sync/local/keys";
import { createSyncPort } from "../../src/core/sync/local/port";
import { SyncLocal } from "../../src/core/sync/local/sync-local";
import { addEntry } from "../../src/core/vault/ops";
import { createProtected, STRONG } from "./vaults";
import { TEST_KDF_ITERATIONS } from "./kdf";

export const input = (issuer: string, secret = "JBSWY3DPEHPK3PXP") => ({
  type: "totp" as const,
  issuer,
  label: "a",
  secret,
  algorithm: "SHA1" as const,
  digits: 6 as const,
  period: 30,
});
export const HOUR = 3_600_000;

export function m2World() {
  const kv = new MemoryKV();
  const mirror = new MemoryKV();
  const idb = new MemoryKV();
  const session = new MemorySession();
  const t = { now: 1_700_000_000_000 };
  const lock: Lock = createMutex();
  const diag: string[] = [];
  const onDiag = (m: string) => diag.push(m);
  const settings = new KvSettingsStore(kv);
  /** The whole local side over `k` (the records read and write it under `lock`), and the identity over `id`. */
  const local = (k: KV = kv, id: KV = idb) =>
    new SyncLocal({ local: k, identity: id, vaultLock: lock, identityLock: createMutex() });
  const store = (k: KV = kv, m: KV = mirror) =>
    new VaultStore({
      kv: k,
      mirror: m,
      lock,
      now: () => t.now,
      onDiag,
      beforeRecoveryWrite: () => createSyncPort({ local: k, vaultLock: lock }).clearLastSynced(),
    });
  /** The service as runtime.ts builds it: the light port, its records, the recovery hook. */
  const svc = (k: KV = kv, m: KV = mirror, s: SessionCache = session, extra: Partial<ServiceDeps> = {}) => {
    const port = createSyncPort({ local: k, vaultLock: lock });
    return new VaultService({
      store: store(k, m),
      session: s,
      settings: new KvSettingsStore(k),
      now: () => t.now,
      onDiag,
      vkRecords: port.records,
      sync: port,
      kdfIterations: TEST_KDF_ITERATIONS,
      ...extra,
    });
  };
  const flows = (s: VaultService = svc(), l: SyncLocal = local()) => new SyncFlows(s, l);
  const add = async (s: VaultService, n: string, secret?: string) => {
    t.now += 60_000;
    await s.mutate((v, c) => addEntry(v, input(n, secret), c).vault);
  };
  const active = async (k: MemoryKV = kv): Promise<Generation> =>
    (await checkGeneration(k.data.get(KEYS.slot[k.data.get(KEYS.active) as "a" | "b"])))!;
  const sessionVk = async (s: MemorySession = session): Promise<Vk> => vkFromRaw(fromB64(s.data!.vk));
  return { kv, mirror, idb, session, t, lock, diag, settings, local, store, svc, flows, add, active, sessionVk };
}
export type M2World = ReturnType<typeof m2World>;

/** A protected vault with `names`, unlocked; sync turned on in the sense the local side sees (sk_sync_cfg present). */
export async function vaultWith(
  w: M2World,
  names: string[] = ["GitHub", "AWS", "Stripe"],
  o: { syncOn?: boolean } = {},
) {
  const r = await createProtected(w.svc());
  for (const n of names) await w.add(w.svc(), n, secretOf(n));
  if (o.syncOn) markSyncOn(w.kv);
  return { recoveryCode: r.recoveryCode };
}

/** A distinct valid base32 secret per name, so identities differ. */
export function secretOf(name: string): string {
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let h = 7;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return Array.from({ length: 16 }, (_, i) => B32[((h >>> (i % 27)) % 32) ^ (i % 5)]!)
    .join("")
    .replace(/[^A-Z2-7]/g, "A");
}

/** What the local side counts as "sync on": a sync configuration (its copy is not opened by these checks). */
export function markSyncOn(
  kv: MemoryKV,
  state: Record<string, unknown> = { v: 1, lastSynced: { version: 7, head: "h", checksum: "c" }, serverOffsetMs: 0 },
) {
  kv.data.set(SYNC_KEYS.cfg, {
    v: 1,
    deviceId: "qqqqqqqqqqqqqqqqqqqqqg",
    apiOrigin: "https://api.sixkey.app",
    enc: { vkId: "0000000000000000", iv: "AAAAAAAAAAAAAAAA", ct: "AAAA" },
  });
  kv.data.set(SYNC_KEYS.state, state);
}

/** A device identity as M3/M5 will make one (§2.5 generation flow): the signing key non-extractable. */
export async function newIdentity(o: Partial<DeviceIdentity> = {}): Promise<{ id: DeviceIdentity; jwk: JsonWebKey }> {
  const dk = await generateDeviceKey();
  const publicKey = await crypto.subtle.importKey("spki", bs(dk.spki), { name: "ECDSA", namedCurve: "P-256" }, true, [
    "verify",
  ]);
  const id: DeviceIdentity = {
    v: 1,
    deviceId: newDeviceId(),
    keyPair: { privateKey: dk.privateKey, publicKey },
    apiOrigin: "https://api.sixkey.app",
    state: "pending",
    vkId: null,
    maxSeenVersion: 0,
    maxSeenKver: 0,
    vaultId: null,
    adopted: null,
    ...o,
  };
  return { id, jwk: dk.jwk };
}

/** A bundle for `keyring` (its times truncated to the hour, as before the first upload, §2.3), MACed with `vk`. */
export async function bundleFor(vk: Vk, keyring: Keyring, kver: number, auth?: BundleAuth): Promise<KeyBundle> {
  const kr = truncateKeyringTimes(keyring);
  const pw = kr.wraps.find((w) => w.method === "password")!.kdf!.salt;
  return (
    await sealBundle(vk, {
      vaultId: kr.vaultId,
      kver,
      keyring: kr,
      auth: auth ?? newBundleAuth(pw),
      by: "qqqqqqqqqqqqqqqqqqqqqg",
      now: 1_792_051_200_000,
    })
  ).bundle;
}

/** The local keyring rotated (as another device would, §3.8 P1): a new VK, the same password, a new recovery code. */
export async function rotated(keyring: Keyring, vk: Vk, pw = STRONG) {
  return rekey(keyring, vk, pw);
}

/** The same VK with a new recovery wrap (§3.7 on another device). */
export async function newCode(keyring: Keyring, vk: Vk) {
  return setRecovery(keyring, vk);
}

export const opensWithPw = (k: Keyring, pw: string) =>
  unlockWithPassword(k, pw).then(
    () => true,
    () => false,
  );

// ---- keys to commit, as M3 gets them from M1 (SYNC-DESIGN §0.0i item 16) ------------------------------------------------

/** The facts M1 decides on, from this device's identity settled first (§0.0i item 17), as M3 passes them. */
export async function factsOf(l: SyncLocal, expectedVaultId: string) {
  const id = await l.settlePins();
  const p = id && id !== "damaged" ? id : null;
  return {
    maxSeenKver: p?.maxSeenKver ?? 0,
    expectedVaultId,
    adoptedAuth: p?.adopted?.auth ?? null,
    adoptedDigest: p?.adopted?.digest ?? null,
    pinnedVkId: p?.vkId ?? null,
  };
}

/** R2 (a recovery wrap changed elsewhere) or the GM2-5 adopt-back: evaluateSameVkBundle's adopt verdict; throws otherwise. */
export async function adoptSameVk(i: SameVkInput): Promise<Adoption> {
  const v = await evaluateSameVkBundle(i);
  if (v.kind !== "adopt") throw new Error(`not an adoption: ${JSON.stringify(v)}`);
  return v;
}

/** R3, R6, the cloud restore: unlockWithSync's adopt (the typed secret opened the bundle); throws otherwise. */
export async function adoptByUnlock(i: UnlockInput): Promise<Adoption> {
  const r = await unlockWithSync(i);
  if (r.kind !== "adopt")
    throw new Error(`not an adoption: ${JSON.stringify(r.kind === "local" ? { ...r, vk: undefined } : r)}`);
  return r;
}

/**
 * A key operation this device made and the server accepted (§3.6–§3.8): preSendCheck on `server` (the bundle this device
 * holds as `local`, under `vk`; in sync with it by default), then published() for `sent` under `sentVk`, opened by
 * `sentSecret`.
 */
export async function publishedOf(o: {
  server: KeyBundle;
  local: Keyring;
  vk: Vk;
  op: SensitiveOp;
  secret?: UnlockSecret;
  sent: KeyBundle;
  sentVk: Vk;
  sentSecret: UnlockSecret;
  held?: Vk[];
  facts?: { maxSeenKver?: number; adoptedAuth?: BundleAuth | null; adoptedDigest?: string | null };
}): Promise<Published> {
  const r = await preSendCheck({
    op: o.op,
    serverRaw: JSON.stringify(o.server),
    secret: o.secret ?? { password: STRONG },
    local: o.local,
    vk: o.vk,
    expectedVaultId: o.server.vaultId,
    maxSeenKver: o.facts?.maxSeenKver ?? o.server.kver,
    adoptedAuth: o.facts?.adoptedAuth !== undefined ? o.facts.adoptedAuth : o.server.auth,
    adoptedDigest:
      o.facts?.adoptedDigest !== undefined ? o.facts.adoptedDigest : (await adoptedRecord(o.server)).digest,
  });
  if (!r.ok) throw new Error(`pre-send check refused: ${r.reason}`);
  return published({
    verified: r.verified,
    sent: o.sent,
    vk: o.sentVk,
    secret: o.sentSecret,
    ...(o.held ? { held: o.held } : {}),
  });
}

/**
 * Test set-up: this device enrolled and in sync with the server at `kver` (the steady state): the local keyring is the
 * bundle's (its times truncated, as before the first upload, §2.3; a store transact, as the init's local half will be,
 * M3), the cleanup done, and the identity pinned to it with adopted = that bundle. Returns the bundle and the identity.
 */
export async function steadyState(w: M2World, kver: number, o: Partial<DeviceIdentity> = {}) {
  const vk = await w.sessionVk();
  const g = await w.active();
  const bundle = await bundleFor(vk, g.keyring, kver);
  await w.store().transact(async (cur) => ({ envelope: cur!.envelope, keyring: bundle.keyring }));
  await w.svc().openView(); // the one cleanup the keyring change asks for
  const { id, jwk } = await newIdentity({ state: "enrolled", ...o });
  const identity: DeviceIdentity = {
    ...id,
    vkId: vk.id,
    vaultId: g.keyring.vaultId,
    maxSeenKver: kver,
    adopted: await adoptedRecord(bundle),
    ...o,
  };
  await w.local().identity.put(identity);
  return { vk, bundle, identity, jwk, vaultId: g.keyring.vaultId };
}
