// Review: the "lock every time" mode and the routed session, with several contexts (popup, options, service worker).
import { describe, expect, it } from "vitest";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession, type SessionData } from "../../src/core/service/types";
import { RoutedSession } from "../../src/platform/session";
import { createProtected, STRONG } from "../helpers/vaults";

async function world() {
  const kv = new MemoryKV();
  const settings = new KvSettingsStore(kv);
  const storageSession = new MemorySession(); // stands in for chrome.storage.session, shared by all contexts
  const t = { now: 1_700_000_000_000 };
  const ctx = () =>
    new VaultService({
      store: new VaultStore({ lock: createMutex(), kv, now: () => t.now }),
      session: new RoutedSession(storageSession, settings),
      settings,
      now: () => t.now,
    });
  const first = ctx();
  await createProtected(first);
  return { kv, settings, storageSession, t, ctx };
}

describe('"lock every time the popup closes"', () => {
  it("screen lock (the service worker calls lock()) also locks an open options tab", async () => {
    const w = await world();
    const options = w.ctx();
    const sw = w.ctx();
    await options.updateSettings({ autoLock: { mode: "always" }, lockOnScreenLock: true });
    await options.unlockWithPassword(STRONG); // the options tab unlocks; its key lives in that page's memory
    expect((await options.status()).state).toBe("unlocked");
    await sw.lock(); // sw.ts: idle.onStateChanged("locked") -> rt.service.lock()
    expect((await options.status()).state).toBe("locked");
  });
  it("an options tab left open does not stay unlocked for days", async () => {
    const w = await world();
    const options = w.ctx();
    await options.updateSettings({ autoLock: { mode: "always" }, lockOnScreenLock: true });
    await options.unlockWithPassword(STRONG);
    w.t.now += 3 * 86_400_000;
    // The idle timer only applies to mode "idle"; in the strictest mode an open options tab never locks by time.
    expect((await options.status()).state).toBe("locked");
  });
});

describe("switching to 'lock every time' while another context is writing the session", () => {
  it("the key does not stay in chrome.storage.session after the switch", async () => {
    const w = await world();
    await w.settings.set({ autoLock: { mode: "idle", minutes: 15 }, lockOnScreenLock: true });
    const popup = w.ctx();
    await popup.unlockWithPassword(STRONG); // key now in storage.session
    const options = w.ctx();

    // Interleave: the popup's touch() has read the session (mode was "idle"), the options page switches mode and clears,
    // then the popup's write lands.
    const s = (await w.storageSession.get()) as SessionData;
    await options.updateSettings({ autoLock: { mode: "always" }, lockOnScreenLock: true });
    // RoutedSession.set re-reads the mode, so model the write that was already routed to storage.session before the switch:
    await w.storageSession.set({ ...s, lastActive: w.t.now });
    // Nothing ever clears storage.session in "always" mode: enforceAutoLock and status() look only at page memory.
    const sw = w.ctx();
    await sw.enforceAutoLock();
    w.t.now += 86_400_000;
    await sw.enforceAutoLock();
    expect(await w.storageSession.get()).toBeNull();
  });
});
