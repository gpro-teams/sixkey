// The PIN under races, page deaths and fan-out (QUICK-UNLOCK §5.4, §5.5; OWNER-DECISIONS/20 and its 2026-10-30 notes:
// docs/design/notes/QUICK-PIN-NOTES.md, PIN-RESTART-NOTES.md §18): a same-key password change pauses the PIN even when
// the page dies after the commit; committed()'s rule for the gate's arming and the PIN's record; the 5-try limit with many
// pages guessing at once, and quick_ended recorded once; a PIN changed while an unlock with the old one derives; a lock
// screen's stale look; chrome.storage.session kept to Sixkey's own contexts; the shared card ending it. Plus the owner's
// rule that a delete which cannot be undone always asks for the master password, so that a PIN guessed within its tries
// never reaches it.
import { describe, expect, it } from "vitest";
import { armDevice, wrapsTag } from "../../src/core/crypto/pin";
import type { RestartRecord } from "../../src/core/crypto/pin-restart";
import { PIN_KEY, RESTART_KEY } from "../../src/core/service/pin-store";
import { applyPreset } from "../../src/core/service/presets";
import { addEntry, deleteEntry } from "../../src/core/vault/ops";
import { aliveEntries, trashEntries } from "../../src/core/vault/model";
import { NO_PAGE, STRONG, legacyDeviceVault, resetWithCode } from "../helpers/vaults";
import { lockScreen, notePassword, PIN, PIN2, pinIn, quickWorld, type QuickWorld } from "../helpers/quick-world";

const STRONG2 = "granite-river-compass-31";
const WRONG = "975310";
const rec = (w: QuickWorld) => w.kv.data.get(RESTART_KEY) as RestartRecord | undefined;
const never = () => new Promise<never>(() => undefined);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
type Appender = { security: { append: (k: string) => Promise<void> } };

/** A context whose security-log write never returns: the page died right there, after the keyring's commit. */
function dyingAtLogWrite(w: QuickWorld, only?: string) {
  const c = w.ctx();
  const healthy = w.ctx().service as unknown as Appender;
  (c.service as unknown as Appender).security.append = (k) =>
    only === undefined || k === only ? never() : healthy.security.append(k);
  return c;
}
async function waitForWrapChange(w: QuickWorld, before: string) {
  for (let i = 0; i < 400; i++) {
    const g = await w.ctx().service.currentGeneration();
    if (JSON.stringify(g!.keyring.wraps) !== before) return;
    await tick(5);
  }
  throw new Error("the keyring never changed");
}
const wrapsNow = async (w: QuickWorld) => JSON.stringify((await w.ctx().service.currentGeneration())!.keyring.wraps);

describe("a same-key password change pauses the PIN even if the page dies after the commit (the owner's rule)", () => {
  it("changePassword: the page dies writing password_changed, before the record's wrap is set aside; the old record does not open Sixkey", async () => {
    const w = await quickWorld();
    const before = await wrapsNow(w);
    void dyingAtLogWrite(w).service.changePassword(STRONG, STRONG2); // never settles: the tab was closed
    await waitForWrapChange(w, before); // the new password is committed
    await tick(20);
    expect(rec(w)!.wrap).not.toBeNull(); // the page died before it could set the wrap aside
    expect((await w.ctx().admin.state()).restart?.state).toBe("paused"); // and the PIN box does not call it on
    const popup = w.ctx().service;
    await popup.lock();
    // not offered; the line says the master password brings the PIN back (OWNER-DECISIONS/15), which it does
    expect(await lockScreen(w)).toEqual({ state: "locked", events: [], pin: "paused" });
    expect(await pinIn(popup, PIN)).toEqual({ ok: false, reason: "ended" });
  });

  it("commitReset (forgot the password, the recovery code): the page dies writing password_reset", async () => {
    const w = await quickWorld();
    await w.ctx().service.lock();
    const before = await wrapsNow(w);
    void resetWithCode(dyingAtLogWrite(w, "password_reset").service, w.recoveryCode, STRONG2);
    await waitForWrapChange(w, before);
    await tick(20);
    expect(await pinIn(w.ctx().service, PIN)).toEqual({ ok: false, reason: "ended" });
  });

  it("a rotation in the same window: the key id changes too", async () => {
    const w = await quickWorld();
    const before = await wrapsNow(w);
    void dyingAtLogWrite(w).service.rotateKey(STRONG, NO_PAGE);
    await waitForWrapChange(w, before);
    await tick(20);
    const popup = w.ctx().service;
    await popup.lock();
    expect(await pinIn(popup, PIN)).toEqual({ ok: false, reason: "ended" });
  });

  it("the next master password makes the same PIN work again under the new wraps", async () => {
    const w = await quickWorld();
    await w.ctx().service.changePassword(STRONG, STRONG2);
    const s = w.ctx().service;
    await s.lock();
    await s.unlockWithPassword(STRONG2);
    await notePassword(s);
    await s.lock();
    expect((await pinIn(s, PIN)).ok).toBe(true);
  });
});

describe("committed()'s rule, by record kind: the gate's arming ends; the PIN's record pauses only when its keys change", () => {
  type Committed = (kind: string | null, vk: unknown, o?: Record<string, unknown>) => Promise<void>;
  async function vkOf(w: QuickWorld) {
    const { vkFromRaw } = await import("../../src/core/crypto/vk");
    const { fromB64 } = await import("../../src/core/crypto/bytes");
    return vkFromRaw(fromB64((await w.area.get())!.vk));
  }
  async function gateArmed(w: QuickWorld) {
    const k = (await w.ctx().service.currentGeneration())!.keyring;
    await w.area.setQuick(armDevice(await vkOf(w), k.vaultId, w.t.now, wrapsTag(k)));
  }
  for (const kind of ["keys_adopted", "keys_adopted_back", "sync_on", "password_changed", "recovery_code_new"])
    it(`${kind}, with the same vault key and wraps, ends the gate's sk_quick and leaves the PIN's record`, async () => {
      const w = await quickWorld();
      await gateArmed(w);
      const kept = JSON.stringify(rec(w));
      const svc = w.ctx().service as unknown as { committed: Committed };
      await svc.committed(kind, await vkOf(w), { held: [], session: false });
      expect(await w.area.getQuick()).toBeNull();
      expect(JSON.stringify(rec(w))).toBe(kept);
    });
  it("no kind and the same key (the keyring's times floored before a first upload) keeps both", async () => {
    const w = await quickWorld();
    await gateArmed(w);
    const svc = w.ctx().service as unknown as { committed: Committed };
    await svc.committed(null, await vkOf(w), { held: [], session: false });
    expect(await w.area.getQuick()).not.toBeNull();
    expect(rec(w)!.wrap).not.toBeNull();
  });
});

describe("the 5-try limit under fan-out (many pages guessing at once)", () => {
  it("7 concurrent wrong PINs: exactly 5 tries spent and recorded, the wrap gone, the right PIN refused", async () => {
    const w = await quickWorld();
    await w.ctx().service.lock();
    const out = await Promise.all(Array.from({ length: 7 }, () => pinIn(w.ctx().service, WRONG)));
    expect((await w.kinds()).filter((k) => k === "pin_failed").length).toBe(5);
    expect(out.filter((r) => !r.ok && r.reason === "wrong").length).toBe(4);
    expect(out.filter((r) => !r.ok && (r.reason === "ended" || r.reason === "exhausted")).length).toBe(3);
    expect(out.filter((r) => !r.ok && r.reason === "exhausted").length).toBeGreaterThanOrEqual(1); // the 5th says so
    expect(rec(w)).toMatchObject({ fails: 5, wrap: null });
    expect(await pinIn(w.ctx().service, PIN)).toEqual({ ok: false, reason: "ended" });
  });

  it("...and the 5th wrong PIN is recorded as quick_ended, once", async () => {
    const w = await quickWorld();
    await w.ctx().service.lock();
    await Promise.all(Array.from({ length: 7 }, () => pinIn(w.ctx().service, WRONG)));
    expect((await w.kinds()).filter((k) => k === "quick_ended").length).toBe(1);
  });

  it("the 5th wrong PIN ends the gate's arming too (whatever ends the PIN ends the gate: OWNER-DECISIONS/17 Q1)", async () => {
    const w = await quickWorld();
    const { vkFromRaw } = await import("../../src/core/crypto/vk");
    const { fromB64 } = await import("../../src/core/crypto/bytes");
    const k = (await w.ctx().service.currentGeneration())!.keyring;
    await w.area.setQuick(
      armDevice(await vkFromRaw(fromB64((await w.area.get())!.vk)), k.vaultId, w.t.now, wrapsTag(k)),
    );
    await w.ctx().service.lock();
    for (let i = 0; i < 4; i++) await pinIn(w.ctx().service, WRONG);
    expect(await w.area.getQuick()).not.toBeNull(); // the 4th leaves it
    expect(await pinIn(w.ctx().service, WRONG)).toEqual({ ok: false, reason: "exhausted" });
    expect(await w.area.getQuick()).toBeNull();
  });

  it("guesses interleaved with a lock screen opening in a third page never give a 6th try", async () => {
    const w = await quickWorld();
    await w.ctx().service.lock();
    const guesses = Array.from({ length: 6 }, () => pinIn(w.ctx().service, WRONG));
    const looks = Array.from({ length: 6 }, () => w.ctx().service.openView());
    await Promise.all([...guesses, ...looks]);
    expect((await w.kinds()).filter((k) => k === "pin_failed").length).toBe(5);
    expect(rec(w)).toMatchObject({ fails: 5, wrap: null });
  });
});

describe("a PIN change or removal during an unlock with the OLD PIN", () => {
  async function slowUnlock(w: QuickWorld) {
    // solo + "lock every time": the settings tab holds the key in its own memory while the popup sits on the PIN screen
    const tab = w.ctx();
    await tab.service.updateSettings({ ...(await w.settings.get()), autoLock: { mode: "always" } }); // hard lock
    await tab.service.unlockWithPassword(STRONG); // the tab is unlocked (memory)
    const popupCtx = w.ctx();
    await popupCtx.service.openView();
    // a slow machine: the popup's loadView is done, then it waits before the count and the derivation
    const store = (popupCtx.service as unknown as { store: { loadView: (...a: unknown[]) => Promise<unknown> } }).store;
    const realLoad = store.loadView.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    store.loadView = async (...a: unknown[]) => {
      const r = await realLoad(...a);
      await gate;
      return r;
    };
    const p = pinIn(popupCtx.service, PIN); // the OLD PIN: its record read
    await tick(20);
    return { tab, p, release };
  }
  it("setPin(PIN2) lands while the old PIN waits to be counted: the old PIN does not open Sixkey", async () => {
    const w = await quickWorld();
    const { tab, p, release } = await slowUnlock(w);
    await tab.admin.setPin(STRONG, PIN2); // the change completes: the old record deleted, the new one made
    const made = JSON.stringify(rec(w));
    release();
    expect(await p).toEqual({ ok: false, reason: "ended" });
    expect(JSON.stringify(rec(w))).toBe(made); // the new record is not touched
  });
  it("removePin lands while the old PIN waits to be counted: refused too", async () => {
    const w = await quickWorld();
    const { tab, p, release } = await slowUnlock(w);
    await tab.admin.removePin(STRONG);
    release();
    expect(await p).toEqual({ ok: false, reason: "ended" });
  });
  it("control: the master password typed elsewhere meanwhile (its note: nothing to write) still lets the right PIN open", async () => {
    const w = await quickWorld();
    const { p, release } = await slowUnlock(w);
    w.t.now += 1000;
    const other = w.ctx().service;
    await other.unlockWithPassword(STRONG);
    await notePassword(other);
    release();
    expect((await p).ok).toBe(true);
  });
});

describe("the answer to a wrong PIN names the PIN's length", () => {
  it("a PIN changed to another length while a lock screen stays open: the next answer carries the new length", async () => {
    const w = await quickWorld(); // 6 digits
    await w.first.admin.setPin(STRONG, "27182818");
    await w.ctx().service.lock();
    expect(await pinIn(w.ctx().service, "27182817")).toEqual({
      ok: false,
      reason: "wrong",
      triesLeft: 4,
      digits: 8,
    });
  });
});

describe("a lock screen's own stale look never decides an unlock", () => {
  it("its read predates a PIN just set: it offers what it read, and the unlock, which reads again, opens with the new PIN", async () => {
    const w = await quickWorld();
    const page = w.ctx();
    const store = (page.service as unknown as { store: { loadView: (also: string[]) => Promise<unknown> } }).store;
    const stale = await store.loadView([PIN_KEY, RESTART_KEY]); // read before the change
    await w.first.admin.setPin(STRONG, PIN2);
    const real = store.loadView.bind(store);
    let once = true;
    store.loadView = async (also: string[]) => (once ? ((once = false), stale) : real(also));
    await w.ctx().service.lock();
    await page.service.openView(); // the stale look
    expect(await pinIn(page.service, PIN2)).toMatchObject({ ok: true });
  });
});

describe("chrome.storage.session stays trusted-contexts-only (sk_quick and sk_session live there)", () => {
  it("setAccessLevel only in platform/storage-access.ts and only with TRUSTED_CONTEXTS, and no content scripts or debugger permission in any manifest (scripting is allowed since TOTP autofill, Stage 1)", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mjs|js)$/.test(n) ? [p] : [];
      });
    const root = join(__dirname, "../..");
    // AUTOFILL-PRE: the one place that sets the level (it closes local and session; test/unit/autofill-pre-storage.test.ts)
    for (const f of walk(join(root, "src")))
      if (!f.endsWith("/platform/storage-access.ts")) expect(readFileSync(f, "utf8"), f).not.toMatch(/setAccessLevel/);
    expect(readFileSync(join(root, "src/platform/storage-access.ts"), "utf8").match(/accessLevel: "[A-Z_]+"/g)).toEqual(
      ['accessLevel: "TRUSTED_CONTEXTS"', 'accessLevel: "TRUSTED_CONTEXTS"'],
    );
    for (const m of ["manifest.base.json", "manifest.dev.json", "manifest.e2e.json"]) {
      const j = JSON.parse(readFileSync(join(root, m), "utf8")) as Record<string, unknown>;
      expect(j, m).not.toHaveProperty("content_scripts");
      expect(JSON.stringify(j.permissions ?? []), m).not.toMatch(/debugger/);
    }
  });
});

describe("the shared card while a PIN is set up", () => {
  it("removes the PIN's record and locks; a password unlock then makes nothing", async () => {
    const w = await quickWorld();
    const svc = w.ctx().service;
    await svc.updateSettings(applyPreset(await w.settings.get(), "shared"));
    expect(rec(w)).toBeUndefined();
    expect((await w.ctx().service.openView()).state).toBe("locked");
    await svc.unlockWithPassword(STRONG);
    await notePassword(svc);
    expect(rec(w)).toBeUndefined();
    expect(await w.area.getQuick()).toBeNull();
  });
});

describe("a delete that cannot be undone asks for the master password (the owner's rule), so a PIN never reaches it", () => {
  async function trashed(w: QuickWorld) {
    const svc = w.ctx().service;
    await svc.mutate(
      (v, c) =>
        addEntry(
          v,
          {
            type: "totp",
            issuer: "Bank",
            label: "a",
            secret: "JBSWY3DPEHPK3PXP",
            algorithm: "SHA1",
            digits: 6,
            period: 30,
          },
          c,
        ).vault,
    );
    const id = (await svc.read()).vault.entries.find((e) => e.issuer === "Bank")!.id;
    await svc.mutate((v, c) => deleteEntry(v, id, c));
    return id;
  }
  it("Delete forever after a PIN unlock: refused with no password and with a wrong one (recorded); nothing is erased", async () => {
    const w = await quickWorld();
    const id = await trashed(w);
    const popup = w.ctx().service;
    await popup.lock();
    expect((await pinIn(popup, PIN)).ok).toBe(true); // in with the PIN only
    await expect(popup.purgeForever([id], "")).rejects.toMatchObject({ code: "empty_password" });
    await expect(popup.purgeForever([id], PIN)).rejects.toMatchObject({ code: "wrong_secret" });
    await expect(popup.purgeForever([id], "not the master password")).rejects.toMatchObject({ code: "wrong_secret" });
    expect(trashEntries((await popup.read()).vault).map((e) => e.id)).toEqual([id]); // still in the trash
    expect((await w.kinds()).filter((k) => k === "unlock_failed")).toHaveLength(2);
    await popup.purgeForever([id], STRONG);
    expect(trashEntries((await popup.read()).vault)).toEqual([]);
    expect(aliveEntries((await popup.read()).vault).map((e) => e.issuer)).not.toContain("Bank");
  });
  it("a Phase 0 vault without a master password has none to ask for: anyone at it can open it anyway", async () => {
    const { MemoryKV, createMutex } = await import("../../src/core/storage/kv");
    const { VaultStore } = await import("../../src/core/storage/store");
    const { VaultService } = await import("../../src/core/service/service");
    const { KvSettingsStore, MemorySession } = await import("../../src/core/service/types");
    const kv = new MemoryKV();
    const store = new VaultStore({ kv, lock: createMutex() });
    await legacyDeviceVault(store);
    const svc = new VaultService({ store, session: new MemorySession(), settings: new KvSettingsStore(kv) });
    await svc.mutate(
      (v, c) =>
        addEntry(
          v,
          {
            type: "totp",
            issuer: "Old",
            label: "a",
            secret: "JBSWY3DPEHPK3PXP",
            algorithm: "SHA1",
            digits: 6,
            period: 30,
          },
          c,
        ).vault,
    );
    const id = (await svc.read()).vault.entries[0]!.id;
    await svc.mutate((v, c) => deleteEntry(v, id, c));
    await svc.purgeForever([id], "");
    expect(trashEntries((await svc.read()).vault)).toEqual([]);
  });
});
