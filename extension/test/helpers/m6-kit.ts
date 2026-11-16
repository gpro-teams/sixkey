// The Sync section's controllers over the M3 test worlds (test/helpers/m3-world.ts): a profile whose engine, like the
// settings page's, asks for the API permission before every round (EngineDeps.networkAllowed) and sends through a
// transport the permission gates (platform/api-permission.ts permissionGated, as the service worker's), with a stand-in
// chrome.permissions that answers a request only inside a user gesture, as Chrome does.
import { API_PERMISSION, permissionGated, type PermissionsLike } from "../../src/platform/api-permission";
import type { SyncKit } from "../../src/options/sync/gateway";
import { contextOver, type Device, type World } from "./m3-world";
import { createProtected } from "./vaults";

/** chrome.permissions for the API origin: `gesture` is true only while a test's click runs (click() below). */
export type PermFake = PermissionsLike & { granted: boolean; gesture: boolean; answer: boolean; log: string[] };

export function permissions(granted = false): PermFake {
  const p: PermFake = {
    granted,
    gesture: false,
    answer: true,
    log: [],
    async contains() {
      return p.granted;
    },
    // Chrome refuses a request made outside the user's gesture; the check is at the call, not after an await
    request() {
      p.log.push(p.gesture ? "request" : "request-without-gesture");
      if (!p.gesture) return Promise.reject(new Error("This function must be called during a user gesture"));
      if (p.answer) p.granted = true;
      return Promise.resolve(p.answer);
    },
    async remove() {
      p.log.push("remove");
      const was = p.granted;
      p.granted = false;
      return was;
    },
  };
  return p;
}

/** A click: the user's gesture lasts exactly as long as the handler's synchronous part. */
export function click(p: PermFake, handler: () => void): void {
  p.gesture = true;
  try {
    handler();
  } finally {
    p.gesture = false;
  }
}

/** The device's contexts rebuilt over the permission (the page's engine asks it, its transport is gated by it). */
export function gate(d: Device, perm: PermFake): void {
  const granted = () => perm.contains(API_PERMISSION);
  d.ctx = contextOver({
    ...d.disk,
    lock: d.lock,
    identityLock: d.identityLock,
    syncLock: d.syncLock,
    transport: permissionGated(d.net, granted),
    clock: d.now,
    scheduler: d.scheduler,
    diag: d.diag,
    networkAllowed: granted,
  });
}

export type TestKit = SyncKit & { changed: () => void; changes: () => number; copied: string[]; uncopied: string[] };

/** The kit the section's controllers use (gateway.ts SyncKit), over a test device. */
export function kitOf(d: Device, perm: PermFake): TestKit {
  let n = 0;
  const copied: string[] = [];
  const uncopied: string[] = [];
  return {
    get service() {
      return d.svc;
    },
    get engine() {
      return d.engine;
    },
    perm,
    changed: () => {
      n++;
    },
    changes: () => n,
    copied,
    copy: async (text) => {
      copied.push(text);
      return true;
    },
    uncopied,
    uncopy: (text) => {
      uncopied.push(text);
    },
  } as TestKit;
}

/** A profile with a protected vault holding `names` (and its recovery code), gated by `perm`, unlocked. */
export async function protectedProfile(
  w: World,
  name: string,
  perm: PermFake,
  names: string[] = ["GitHub"],
): Promise<{ d: Device; code: string }> {
  const d = w.device(name);
  gate(d, perm);
  const r = await createProtected(d.svc, w.password);
  await d.svc.openView();
  for (const n of names) {
    w.advance(1000);
    await d.add(n);
  }
  return { d, code: r.recoveryCode };
}

/** An empty profile (a new install), gated by `perm`. */
export function emptyProfile(w: World, name: string, perm: PermFake): Device {
  const d = w.device(name);
  gate(d, perm);
  return d;
}

/**
 * Waits until `ok()` holds, letting the controllers' promises run (no fake timers involved): at least `tries` turns of
 * the event loop and at least `ms` milliseconds. A key derivation before the awaited step (a new master password's)
 * takes longer than 400 turns on a slower machine, such as a CI runner, so turns alone are not enough.
 */
export async function until(ok: () => boolean, what = "condition", tries = 400, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  for (let i = 0; i < tries || Date.now() < end; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`timed out waiting for ${what}`);
}
