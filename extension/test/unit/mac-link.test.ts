// The link with Sixkey for Mac (platform/mac-link.ts): nothing goes out while the permission is off; what goes out is
// the cloud backup container (no device key, no earlier keys), one message to "app.sixkey.mac"; a keyring a device key
// opens is never sent; the worker's sends come one after a burst of saves.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rekey } from "../../src/core/crypto/keyring";
import { encryptVault } from "../../src/core/crypto/envelope";
import { serializeVault } from "../../src/core/vault/validate";
import type { Generation } from "../../src/core/storage/format";
import type { LoadResult, ViewLoad } from "../../src/core/storage/store";
import { mergeVaults } from "../../src/core/vault/merge";
import type { Vault } from "../../src/core/vault/model";
import { makeCloudBackup } from "../../src/core/cloud/format";
import { derivePinKek, newPinKdf, sealPinRecord, wrapsTag } from "../../src/core/crypto/pin";
import { pinForMac, type MacPin } from "../../src/platform/mac-pin";
import {
  createMacLink,
  macHello,
  MAC_HOST,
  MAC_PULL_ALARM,
  mergeFromMac,
  sendVaultToMac,
  type MacService,
} from "../../src/platform/mac-link";
import { account, PASSWORD, protectedKeys, seal, vaultOf } from "../helpers/cloud";
import { TEST_KDF_ITERATIONS } from "../helpers/kdf";
import { legacyDeviceGeneration } from "../helpers/vaults";

let gen: Generation;
let rotated: Generation;
let keys: Awaited<ReturnType<typeof protectedKeys>>;
beforeAll(async () => {
  keys = await protectedKeys();
  gen = await seal(keys, vaultOf(keys.keyring.vaultId, [account("GitHub", "JBSWY3DPEHPK3PXP")]), 7);
  const r = await rekey(keys.keyring, keys.vk, PASSWORD, { iterations: TEST_KDF_ITERATIONS });
  const envelope = await encryptVault(serializeVault(vaultOf(r.keyring.vaultId, [])), r.vk, {
    vaultId: r.keyring.vaultId,
    rev: 9,
  });
  rotated = { v: 1, seq: 9, savedAt: 1, envelope, keyring: r.keyring };
});
afterEach(() => vi.unstubAllGlobals());

/** A chrome with the permission `granted` and a host answering with `reply` (undefined: no host). */
function stub(granted: boolean, reply?: (m: Record<string, unknown>) => unknown) {
  const sent: { host: string; message: Record<string, unknown> }[] = [];
  const runtime = {
    lastError: undefined as undefined | { message: string },
    sendNativeMessage: (host: string, message: Record<string, unknown>, done: (r: unknown) => void) => {
      sent.push({ host, message });
      if (reply) {
        runtime.lastError = undefined;
        done(reply(message));
      } else {
        runtime.lastError = { message: "Specified native messaging host not found." };
        done(undefined);
      }
    },
  };
  vi.stubGlobal("chrome", { runtime, permissions: { contains: async () => granted } });
  return sent;
}
const ok = (g: Generation) => async (): Promise<LoadResult> => ({ status: "ok", gen: g, events: [] });

describe("the link with Sixkey for Mac", () => {
  it("sends nothing while it is off, and the container when it is on", async () => {
    let sent = stub(false, () => ({ type: "kept" }));
    expect((await sendVaultToMac(ok(gen), "Sixkey test")).sent).toBe("off");
    expect(sent).toEqual([]);

    sent = stub(true, (m) => ({ v: 1, id: m.id, type: "kept", mac: { from: "the Mac" } }));
    expect(await sendVaultToMac(ok(rotated), "Sixkey test")).toEqual({ sent: "kept", mac: { from: "the Mac" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.host).toBe(MAC_HOST);
    const { type, gen: backup } = sent[0]!.message as { type: string; gen: Record<string, any> };
    expect(type).toBe("gen");
    expect(backup.format).toBe("sixkey-cloud-backup");
    expect(backup.opens).toBe("both");
    // the very ciphertext, the password and recovery wraps, never the earlier keys or a device key
    expect(backup.generation.envelope.ciphertext).toBe(rotated.envelope.ciphertext);
    expect(backup.generation.keyring.previous).toEqual([]);
    expect(backup.generation.keyring.wraps.map((w: { method: string }) => w.method).sort()).toEqual([
      "password",
      "recovery",
    ]);
    expect(JSON.stringify(sent)).not.toContain(rotated.keyring.previous[0]!.wrapped);
  });

  it("never sends a keyring a device key opens, and says when no app answers", async () => {
    const sent = stub(true, () => ({ type: "kept" }));
    expect((await sendVaultToMac(ok(await legacyDeviceGeneration()), "Sixkey test")).sent).toBe("not_sendable");
    expect(sent).toEqual([]);
    expect((await sendVaultToMac(async () => ({ status: "empty" }), "Sixkey test")).sent).toBe("no_vault");

    stub(true);
    expect((await sendVaultToMac(ok(gen), "Sixkey test")).sent).toBe("no_app");
    expect(await macHello("0.1.1")).toEqual({ found: false });
    stub(true, (m) => ({ v: 1, id: m.id, type: "hello", app: { version: "0.1.0" }, vault: null }));
    expect(await macHello("0.1.1")).toEqual({ found: true, app: "0.1.0", vault: null });
  });

  it("merges the Mac's copy only when it brings something new, and never one it cannot open", async () => {
    const mine = vaultOf(gen.keyring.vaultId, [
      account("GitHub", "JBSWY3DPEHPK3PXP"),
      account("AWS", "GEZDGNBVGY3TQOJQ"),
    ]);
    const imports: Vault[] = [];
    const service = (theirs: Vault | null, state = "unlocked"): MacService => ({
      status: async () => ({ state }),
      openOwnGenerations: async () => [theirs],
      read: async () => ({ vault: mine }),
      importBackup: async (v) => void imports.push(v),
    });
    const container = await makeCloudBackup(gen, "both", "Sixkey for Mac (tests)");
    // the same accounts, the entries in another order: nothing saved
    const reordered = { ...mine, entries: [...mine.entries].reverse() };
    expect(await mergeFromMac(service(reordered), container)).toBe("same");
    // one account more on the Mac: merged once
    const more = mergeVaults(mine, vaultOf(mine.vaultId, [account("Bank", "KRUGS4ZANFZSAYJA")]));
    expect(await mergeFromMac(service(more), container)).toBe("merged");
    expect(imports).toEqual([more]);
    expect(await mergeFromMac(service(null), container)).toBe("other");
    expect(await mergeFromMac(service(more, "locked"), container)).toBe("locked");
    expect(await mergeFromMac(service(more), { not: "a container" })).toBe("bad");
    expect(await mergeFromMac(service(more), null)).toBe("none");
    expect(imports).toHaveLength(1);
  });

  it("sends once after a burst of saves, and pulls on its alarm only while linked and unlocked", async () => {
    vi.useFakeTimers();
    try {
      const sent = stub(true, (m) => ({ v: 1, id: m.id, type: "kept", mac: null }));
      const alarms = {
        create: vi.fn(async () => undefined),
        clear: vi.fn(async () => true),
        get: vi.fn(async () => undefined),
      };
      let state = "locked";
      const service: MacService = {
        status: async () => ({ state }),
        openOwnGenerations: async () => [null],
        read: async () => ({ vault: vaultOf(gen.keyring.vaultId, []) }),
        importBackup: async () => undefined,
      };
      const link = createMacLink({
        load: ok(gen),
        app: "Sixkey test",
        service,
        alarms: alarms as never,
        delayMs: 2_000,
      });
      link.changed();
      link.changed();
      await vi.advanceTimersByTimeAsync(1_000);
      link.changed();
      expect(sent).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2_500);
      // the send itself awaits real work (the container is checked with WebCrypto)
      vi.useRealTimers();
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 50));
      expect(sent).toHaveLength(1);
      expect(alarms.create).toHaveBeenCalledWith(MAC_PULL_ALARM, { periodInMinutes: 1 });
      // the pull: not while locked; while unlocked, one "pull" message
      expect(link.alarm("sk-daily")).toBe(false);
      expect(link.alarm(MAC_PULL_ALARM)).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(sent).toHaveLength(1);
      state = "unlocked";
      link.alarm(MAC_PULL_ALARM);
      await vi.waitFor(() => expect(sent).toHaveLength(2));
      expect(sent[1]!.message.type).toBe("pull");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the PIN once it changed, locked or not, and null once it stops opening Sixkey here", async () => {
    const sent = stub(true, (m) => ({ v: 1, id: m.id, type: m.type === "pin" ? "pin-kept" : "mac", gen: null }));
    const alarms = {
      create: vi.fn(async () => undefined),
      clear: vi.fn(async () => true),
      get: vi.fn(async () => ({})),
    };
    let pin: MacPin | null = { restart: { v: 1, id: "r1" }, digits: 4, setupIterations: 600_000 };
    const service: MacService = {
      status: async () => ({ state: "locked" }),
      openOwnGenerations: async () => [null],
      read: async () => ({ vault: vaultOf(gen.keyring.vaultId, []) }),
      importBackup: async () => undefined,
    };
    const link = createMacLink({
      load: ok(gen),
      app: "Sixkey test",
      service,
      alarms: alarms as never,
      pin: async () => pin,
    });
    link.alarm(MAC_PULL_ALARM);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.message).toMatchObject({ type: "pin", pin });
    link.alarm(MAC_PULL_ALARM);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(1); // the same PIN is not sent again, and nothing is pulled while locked
    pin = null;
    link.alarm(MAC_PULL_ALARM);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.message).toMatchObject({ type: "pin", pin: null });
  });

  it("gives the app the PIN's record only while the PIN opens Sixkey here", async () => {
    const kdf = newPinKdf();
    const set = await sealPinRecord(keys.vk, keys.keyring.vaultId, await derivePinKek("4821", kdf), { digits: 4, kdf });
    const wrap = { kdf: { ...kdf, iterations: 2_000_000 }, iv: "AAAAAAAAAAAAAAAA", wrapped: "AAAA" };
    const restart = {
      v: 1,
      id: "AAAAAAAAAAAAAAAAAAAAAA==",
      vaultId: keys.keyring.vaultId,
      vkId: keys.keyring.vkId,
      setup: kdf.salt,
      wraps: wrapsTag(keys.keyring),
      mac: "AAAA",
      lastPasswordAt: 1,
      fails: 0,
      wrap,
    };
    const view = (also: Record<string, unknown>) => async (): Promise<ViewLoad> => ({
      status: "ok",
      gen: { ...gen, keyring: keys.keyring },
      events: [],
      cleanup: {} as never,
      also,
    });
    expect(await pinForMac(view({ sk_pin: set, sk_pin_restart: restart }))).toEqual({
      restart,
      digits: 4,
      setupIterations: kdf.iterations,
    });
    // set aside (the 5th wrong PIN, "End quick unlock now"), a profile declared shared, no PIN: null
    expect(await pinForMac(view({ sk_pin: set, sk_pin_restart: { ...restart, wrap: null } }))).toBeNull();
    expect(
      await pinForMac(view({ sk_pin: set, sk_pin_restart: restart, sk_settings: { profile: "shared" } })),
    ).toBeNull();
    expect(await pinForMac(view({ sk_pin_restart: restart }))).toBeNull();
  });
});
