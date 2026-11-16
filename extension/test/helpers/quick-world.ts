// A browser profile for the quick unlock's tests (QUICK-UNLOCK Stages 1 and 2): chrome.storage.local (a MemoryKV), one
// chrome.storage.session shared by every context (a MemorySession), and the cross-context locks the runtime takes with
// navigator.locks (one mutex each, shared by every context's service). ctx() builds one more context (a popup, a
// settings tab, the service worker) exactly as platform/runtime.ts wires one: a RoutedSession over the shared session
// area, the PIN store (with the PIN's record, sk_pin_restart: OWNER-DECISIONS/20) and the device unlock's store
// (QUICK-UNLOCK Stage 2) listed among the records a key change moves, the security record. `restart` is the PIN box's
// lazy part (RestartAdmin: "Turn back on"). `fake` is the computer's authenticator (test/helpers/fake-webauthn.ts), shared
// by every context: each context's `device` (the settings box's DeviceAdmin) and `unlocker` (the lock screen's
// DeviceUnlocker) use it. Below it, the lock screens' steps as a page takes them (pinIn, lockScreen, notePassword) and a
// browser restart (restart).
import { createMutex, MemoryKV, type KV } from "../../src/core/storage/kv";
import { pinKit } from "../../src/core/service/pin-kit";
import { restartOffer } from "../../src/core/service/pin-restart-count";
import { notePassword as note, unlock as viaRecord } from "../../src/core/service/pin-restart-steps";
import { VaultStore } from "../../src/core/storage/store";
import { DeviceAdmin } from "../../src/core/service/device-admin";
import { DeviceUnlocker } from "../../src/core/service/device-unlock";
import { PinAdmin } from "../../src/core/service/pin-admin";
import { PinStore } from "../../src/core/service/pin-store";
import { RestartAdmin } from "../../src/core/service/pin-restart-admin";
import { PrfStore } from "../../src/core/service/prf-store";
import { SecurityLog } from "../../src/core/service/security-log";
import { VaultService, type ServiceDeps } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession, type SessionCache } from "../../src/core/service/types";
import { RoutedSession } from "../../src/platform/session";
import { createProtected, STRONG } from "./vaults";
import { FakeAuthenticator, type FakeOptions } from "./fake-webauthn";
import { TEST_KDF_ITERATIONS } from "./kdf";

export const PIN = "246813";
export const PIN2 = "135792";

export type QuickWorld = Awaited<ReturnType<typeof quickWorld>>;

export async function quickWorld(o: { pin?: string | null; fake?: Partial<FakeOptions> } = {}) {
  const kv = new MemoryKV();
  const area = new MemorySession(); // chrome.storage.session: sk_session, sk_lock_epoch, sk_quick
  const t = { now: 1_700_000_000_000 };
  const vaultLock = createMutex(); // webLock("sixkey-vault")
  const quickLock = createMutex(); // webLock("sixkey-quick")
  const logLock = createMutex(); // webLock("sixkey-security-log")
  const diag: string[] = [];
  const onDiag = (m: string, e?: unknown) =>
    diag.push(`${m} ${e instanceof Error ? `${e.name}:${e.message}` : String(e ?? "")}`);
  const settings = new KvSettingsStore(kv);
  const log = new SecurityLog({ kv, lock: logLock, now: () => t.now, onDiag });
  const fake = new FakeAuthenticator(o.fake);
  /** One context. `local` and `session` let a test put a faulty or recording layer under it. */
  const ctx = (x: { local?: KV; session?: SessionCache; deps?: Partial<ServiceDeps> } = {}) => {
    const local = x.local ?? kv;
    const pins = new PinStore(local, vaultLock);
    const prfs = new PrfStore(local, vaultLock);
    const service = new VaultService({
      store: new VaultStore({ kv: local, lock: vaultLock, now: () => t.now, onDiag }),
      session: new RoutedSession(x.session ?? area, new KvSettingsStore(local)),
      settings: new KvSettingsStore(local),
      now: () => t.now,
      onDiag,
      security: new SecurityLog({ kv: local, lock: logLock, now: () => t.now, onDiag }),
      vkRecords: [pins, prfs],
      pins,
      prfs,
      quickLock,
      kdfIterations: TEST_KDF_ITERATIONS,
      ...x.deps,
    });
    return {
      service,
      admin: new PinAdmin(service),
      restart: new RestartAdmin(service),
      pins,
      prfs,
      device: new DeviceAdmin(service, fake),
      unlocker: new DeviceUnlocker(service, fake),
    };
  };
  const first = ctx();
  const { recoveryCode } = await createProtected(first.service);
  if (o.pin !== null) await first.admin.setPin(STRONG, o.pin ?? PIN);
  /** The kinds in the security record, oldest first. */
  const kinds = async () => (await log.read()).entries.map((e) => e.kind).reverse();
  return { kv, area, t, settings, log, kinds, diag, ctx, first, recoveryCode, quickLock, vaultLock, fake };
}

/** A browser restart or an extension reload: chrome.storage.session is emptied (the unlocked key, the gate's sk_quick). */
export function restart(w: QuickWorld): void {
  w.area.quick = null;
  w.area.data = null;
}

/** A PIN typed on a lock screen (Locked.tsx, UnlockBar.tsx): its record's unlock, with the kit the lock screen hands it. */
export const pinIn = (svc: VaultService, pin: string) => viaRecord(svc, pin, pinKit);

/**
 * The lock screen's note after a master-password unlock: it takes the service's own mark of that unlock (unlockWithPassword
 * in this very service, no lock since), so after any other unlock it does nothing.
 */
export const notePassword = (svc: VaultService) => note(svc, pinKit);

/**
 * What the popup's lock screen shows (src/popup/screens/Locked.tsx): openView, with what the PIN offers folded in as the
 * screen does (pin-restart-count.ts restartOffer, from what openView read): its state as `pin` and its field as `field`.
 */
export async function lockScreen(w: QuickWorld) {
  const svc = w.ctx().service;
  const v = await svc.openView();
  const o = v.state === "locked" ? restartOffer(svc, pinKit) : null;
  return v.state === "locked" && o ? { ...v, pin: o.state, ...(o.field ? { field: o.field } : {}) } : v;
}
