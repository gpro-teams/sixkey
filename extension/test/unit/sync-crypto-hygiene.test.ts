// M1 hygiene: constants mirror the contract, the module stays pure and unimported by the shipped pages, keys stay
// non-extractable, test seams stay out of the public surface, and no error or result carries a secret.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toB64, utf8 } from "../../src/core/crypto/bytes";
import { formatPairingCode } from "../../src/core/crypto/pairing-code";
import { setPassword } from "../../src/core/crypto/keyring";
import * as index from "../../src/core/sync/crypto";
import { passwordProof } from "../../src/core/sync/crypto/auth-proofs";
import { unlockWithSync } from "../../src/core/sync/crypto/bundle-eval";
import { SYNC_CONSTANTS } from "../../src/core/sync/crypto/constants";
import { openDeviceBackup, sealDeviceBackup } from "../../src/core/sync/crypto/device-backup";
import {
  generateDeviceKey,
  generateEphemeral,
  importDeviceKey,
  importEpk,
} from "../../src/core/sync/crypto/device-key";
import { openDeviceName, padDeviceName, sealDeviceName } from "../../src/core/sync/crypto/device-name";
import {
  enrollKey,
  openPayload,
  parsePayloadText,
  sealPayload,
  sharedSecret,
} from "../../src/core/sync/crypto/enroll-crypto";
import { fromB64u, toB64u } from "../../src/core/sync/crypto/encoding";
import { parseBundleText, sealBundle } from "../../src/core/sync/crypto/keybundle";
import { preSendCheck } from "../../src/core/sync/crypto/presend";
import { signingInput } from "../../src/core/sync/crypto/signature";
import { bundleMacKey, deviceBackupKey, deviceNameKey, writeProofInput } from "../../src/core/sync/crypto/subkeys";
import { C, G, VK1_RAW, VK2_RAW, verifiedFor, vk } from "../helpers/sync-vectors";
import { VAULT, authFor, bundleOf, ctx, keyrings } from "../helpers/sync-keyrings";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

describe("constants mirror x-sixkey-constants", () => {
  it("every value equals the contract, and every client- or both-enforced constant is here", () => {
    const contract = C.openapi["x-sixkey-constants"];
    for (const [k, v] of Object.entries(SYNC_CONSTANTS)) expect(contract[k]?.value, k).toBe(v);
    for (const [k, c] of Object.entries<{ enforced_by: string }>(contract))
      if (c.enforced_by !== "server") expect(SYNC_CONSTANTS, k).toHaveProperty(k);
  });
});

describe("purity and isolation", () => {
  const ours = files(join(SRC, "core/sync/crypto"));
  it("core/sync/crypto uses no browser API, network, storage, clock, timer or logging, and imports only Phase 0 crypto and canonicalJson", () => {
    expect(ours.length).toBeGreaterThanOrEqual(15);
    for (const f of ours) {
      const t = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1"); // code only, not comments
      for (const bad of [
        /\bchrome\./,
        /\bfetch\s*\(/,
        /\bconsole\./,
        /localStorage|sessionStorage|indexedDB/,
        /XMLHttpRequest|WebSocket|EventSource|sendBeacon/,
        /Date\.now|new Date\(/,
        /setTimeout|setInterval/,
        /\bnavigator\./,
        /\bimport\s*\(\s*["'`]/,
      ]) {
        expect(bad.test(t), `${f}: ${bad}`).toBe(false);
      }
      for (const m of t.matchAll(/from "([^"]+)"/g))
        expect(
          /^\.\/[a-z-]+$|^\.\.\/\.\.\/crypto\/[a-z-]+$|^\.\.\/\.\.\/vault\/merge$/.test(m[1]!),
          `${f} imports ${m[1]}`,
        ).toBe(true);
    }
  });
  // M1 had "no page, worker or other layer imports it yet". M2 is the storage and service layer the engine builds on, so
  // from M2 the service, sync's local side (core/sync/local) and the platform wiring that builds it import core/sync;
  // no page, worker, UI or other layer does (they reach sync through the service and the runtime only).
  // M5 adds the wiring of the contexts that sync: the service worker's (sync-worker, its fetch transport, the bridge's
  // worker half, the API host permission's gate), a page's (sync-engine, the bridge's page half) and the developer sync page of dev and e2e builds. The
  // popup and the UI still import none of it (and m3-source-rules checks the popup's module graph). M6 adds the settings
  // page's Sync section: its one door to sync (options/sync/gateway.ts, in a chunk loaded when the section is shown), and
  // the section's place in the page (options/SyncHost.tsx: the names of sync's storage keys, to decide when to load it,
  // and the lazy import of the section itself). QUICK-UNLOCK Stage 1 adds the PIN's set-up record (core/service/pin-store.ts):
  // it names its key from core/sync/local/keys.ts (LOCAL_ONLY_KEYS, beside sk_prf and sk_oath) and reads the active
  // keyring the way the other VkRecords do (core/sync/local/records.ts activeKeyring); it is service-layer code, no page.
  // (the budget relief split the service in two, service-core.ts and service.ts, and the wiring out of the runtime into
  // platform/runtime-base.ts: the same code, in more files)
  const M2_IMPORTERS = new Set([
    "core/service/service.ts",
    "core/service/service-core.ts",
    "core/service/sync-flows.ts",
    "core/service/pin-store.ts",
    "core/service/prf-store.ts", // the device unlock's record: the keyring read and LOCAL_ONLY_KEYS, as pin-store.ts
    "core/service/device-admin.ts", // its writes check the vault's active keyring (activeKeyring), as pin-store.ts
    "platform/runtime.ts",
    "platform/runtime-base.ts",
    "platform/api-permission.ts",
    "platform/bridge-page.ts",
    "platform/bridge-worker.ts",
    "platform/fetch-transport.ts",
    "platform/sync-engine.ts",
    "platform/sync-worker.ts",
    "devsync/main.ts",
    "options/SyncHost.tsx",
    "options/sync/gateway.ts",
  ]);
  it("only the service (and its sync flows), the runtime wiring (M2) and M5's wiring of the contexts that sync import core/sync from outside it; no popup, settings page or UI module does", () => {
    const seen = new Set<string>();
    for (const f of files(SRC)) {
      if (f.includes(join("core", "sync"))) continue;
      const rel = f.slice(SRC.length).split("\\").join("/");
      // any import path that reaches core/sync, also relative ones like "../sync" from inside core/ (the review's nit)
      const imports = [...readFileSync(f, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
        (m) => m[1]!,
      );
      for (const spec of imports) {
        const reaches = /(^|\/)sync(\/|$)/.test(spec) || /core\/sync/.test(spec);
        if (reaches) seen.add(rel);
        expect(!reaches || M2_IMPORTERS.has(rel), `${rel} imports ${spec}`).toBe(true);
      }
    }
    expect([...seen].sort()).toEqual([...M2_IMPORTERS].sort()); // and both really do (the rule is not vacuous)
  });
  it("the public index exposes neither the state-machine classes nor the test seams", async () => {
    const names = Object.keys(index);
    for (const hidden of [
      "NewDeviceEnrollment",
      "ApproverEnrollment",
      "shortCode",
      "hkdfHmacKey",
      "bundleMacKey",
      "decideSameVk",
      "decideRemoteUnlock",
      "sharedSecret",
      "enrollKey",
      "classifyKver",
      "sameVkVerdict",
    ])
      expect(names).not.toContain(hidden);
    for (const shown of [
      "capPrevious",
      "adoptedRecord",
      "verifyReceivedBundle",
      "preSendCheck",
      "isVerifiedServerBundle",
      "publishKver",
    ])
      expect(names).toContain(shown);
    const dk = await generateDeviceKey();
    const start = index.startNewDeviceEnrollment as (
      i: unknown,
      o?: unknown,
    ) => ReturnType<typeof index.startNewDeviceEnrollment>;
    const { machine } = await start({ deviceId: index.newDeviceId(), dpk: dk.spki, name: "x" }, { codeSpace: 16 });
    machine.requestCreated(crypto.randomUUID());
    const a = await generateEphemeral();
    expect(
      await machine.onPoll({ state: "responded", approver_device_id: index.newDeviceId(), approver_epk: toB64(a.raw) }),
    ).toEqual({ kind: "enter_code" });
    const step = await machine.submitPairingCode(await formatPairingCode(crypto.getRandomValues(new Uint8Array(16))));
    expect(step.kind === "reveal" && step.sas.length).toBe(6); // the code-space seam cannot be reached through the index
    // nor the approver's pairing-secret seam: the index draws S itself, whatever a caller passes
    const seam = new Uint8Array(16).fill(7);
    const approve = index.startApproval as (i: unknown, o?: unknown) => ReturnType<typeof index.startApproval>;
    const { machine: ap } = await approve(
      {
        approverId: index.newDeviceId(),
        rid: crypto.randomUUID(),
        request: {
          state: "pending",
          new_device_id: index.newDeviceId(),
          new_sig_pubkey: toB64(dk.spki),
          commit: toB64(new Uint8Array(32)),
        },
        verified: await verifiedFor("respond"),
      },
      { pairingSecret: seam },
    );
    const shown = ap.respondAccepted();
    expect(shown.kind === "show_code" && shown.code).not.toBe(await formatPairingCode(new Uint8Array(16).fill(7)));
  });
});

describe("keys stay inside WebCrypto", () => {
  it("K_mac, K_name, K_devbackup, K_enroll, ephemeral and signing keys are non-extractable", async () => {
    const v1 = await vk(VK1_RAW);
    const a = await generateEphemeral();
    const b = await generateEphemeral();
    const keys = [
      await bundleMacKey(v1),
      await deviceNameKey(v1),
      await deviceBackupKey(v1),
      await enrollKey(
        await sharedSecret(a.privateKey, await importEpk(b.raw)),
        crypto.getRandomValues(new Uint8Array(16)),
        new Uint8Array(32),
      ),
      a.privateKey,
      (await generateDeviceKey()).privateKey,
      await importDeviceKey((await generateDeviceKey()).jwk),
    ];
    for (const k of keys) expect(k.extractable).toBe(false);
    expect((await bundleMacKey(v1)).algorithm).toMatchObject({ name: "HMAC", length: 256 });
  });
});

describe("no secret in any error or result (timing independence is not testable from JS: see the M1 report)", () => {
  const PW = "Zebra-Quartz-9931-unique-pw";
  const forms = (b: Uint8Array) => [
    Buffer.from(b).toString("hex"),
    toB64(b),
    toB64u(b),
    Buffer.from(b).toString("hex").toUpperCase(),
  ];
  const vkSecret = VK2_RAW;
  const SECRETS = [PW, ...forms(vkSecret), ...forms(VK1_RAW), ...forms(utf8(PW)), "alice-secret@example.invalid"];
  function leaked(x: unknown): string[] {
    const e = x as Record<string, unknown>;
    const texts = [
      String(x),
      JSON.stringify(x) ?? "",
      typeof e?.message === "string" ? e.message : "",
      typeof e?.stack === "string" ? e.stack : "",
      JSON.stringify(Object.entries(e ?? {})),
    ];
    return SECRETS.filter((s) => texts.some((t) => t.includes(s)));
  }
  const thrown = async (f: () => unknown): Promise<unknown> => {
    try {
      await f();
    } catch (e) {
      return e;
    }
    throw new Error("expected a failure");
  };

  it("every failure path tried with distinctive secrets reports a fixed code", async () => {
    const v1 = await vk(VK1_RAW);
    const v2 = await vk(vkSecret);
    const errors: unknown[] = [];
    errors.push(
      await thrown(() =>
        passwordProof(PW, { name: "PBKDF2", hash: "SHA-256", iterations: 5, salt: toB64(vkSecret), v: 1 }),
      ),
    );
    errors.push(await thrown(() => fromB64u(`${PW}|${toB64(vkSecret)}`)));
    errors.push(await thrown(() => writeProofInput({ vaultId: `${PW}|`, ifVersion: 1, checksum: toB64(vkSecret) })));
    errors.push(
      await thrown(() =>
        signingInput({
          host: "api.sixkey.app",
          method: "GET",
          target: "/x",
          signer: { deviceId: "qqqqqqqqqqqqqqqqqqqqqg" },
          sub: `${PW}|`,
          ts: 1,
          bodySha256: toB64u(vkSecret),
        }),
      ),
    );
    errors.push(await thrown(() => padDeviceName(`${PW}\u202E`)));
    errors.push(
      await thrown(() =>
        parseBundleText(JSON.stringify({ format: "sixkey-keybundle", v: 1, secret: PW, vk: toB64(vkSecret) })),
      ),
    );
    errors.push(await thrown(() => parseBundleText(`{"x":"${PW}","n":1.5}`)));
    errors.push(
      await thrown(() =>
        parsePayloadText(
          JSON.stringify({
            format: "sixkey-enroll-payload",
            v: 1,
            vaultId: "test-vault-0001",
            vk: toB64(vkSecret),
            bundle: PW,
          }),
        ),
      ),
    );
    const ct = await sealDeviceName(v1, { vaultId: "test-vault-0001", deviceId: "qqqqqqqqqqqqqqqqqqqqqg" }, "Work");
    errors.push(
      await thrown(() =>
        openDeviceName(v2, { vaultId: "test-vault-0001", deviceId: "qqqqqqqqqqqqqqqqqqqqqg" }, { ...ct, vkId: v2.id }),
      ),
    );
    const dk = await generateDeviceKey();
    const owner = { vaultId: "test-vault-0001", deviceId: "qqqqqqqqqqqqqqqqqqqqqg" };
    const enc = await sealDeviceBackup(v1, owner, { dsk: dk.jwk, email: "alice-secret@example.invalid" });
    errors.push(await thrown(() => openDeviceBackup(v1, { ...owner, deviceId: "EREREREREREREREREREREQ" }, enc)));
    errors.push(
      await thrown(() =>
        sealDeviceBackup(v1, owner, {
          dsk: { ...dk.jwk, crv: "P-384", d: toB64u(vkSecret) },
          email: "alice-secret@example.invalid",
        }),
      ),
    );
    errors.push(
      await thrown(() => importDeviceKey({ kty: "EC", crv: "P-256", d: toB64u(vkSecret), x: "AA", y: "AA" })),
    );
    const f = await keyrings();
    errors.push(
      await thrown(() =>
        sealBundle(v2, {
          vaultId: "test-vault-0001",
          kver: 1,
          keyring: f.k1,
          auth: { kdf: f.k1.wraps[0]!.kdf as never },
          by: "qqqqqqqqqqqqqqqqqqqqqg",
          now: 0,
        }),
      ),
    );
    const a = await generateEphemeral();
    const k = await enrollKey(
      await sharedSecret(a.privateKey, await importEpk((await generateEphemeral()).raw)),
      crypto.getRandomValues(new Uint8Array(16)),
      new Uint8Array(32),
    );
    errors.push(
      await thrown(async () =>
        openPayload(
          await enrollKey(
            await sharedSecret(a.privateKey, await importEpk((await generateEphemeral()).raw)),
            crypto.getRandomValues(new Uint8Array(16)),
            new Uint8Array(32),
          ),
          new Uint8Array(32),
          await sealPayload(k, new Uint8Array(32), `{"vk":"${toB64(vkSecret)}","pw":"${PW}"}`),
        ),
      ),
    );
    for (const e of errors) expect(leaked(e), String(e)).toEqual([]);
    expect(errors.length).toBe(14);
  }, 20_000);

  it("refusals returned as results carry no secret either", async () => {
    const f = await keyrings();
    const changed = await bundleOf(f.v1, await setPassword(f.k1, f.v1, PW, ctx), 2);
    const r1 = await preSendCheck({
      op: "revoke",
      serverRaw: JSON.stringify(changed),
      secret: { password: "Zebra-Quartz-9931-unique-pw-old" },
      local: f.k1,
      vk: f.v1,
      maxSeenKver: 1,
      expectedVaultId: VAULT,
      adoptedAuth: authFor(f.k1),
      adoptedDigest: null,
    });
    const r2 = await unlockWithSync({
      secret: { password: `${PW}-wrong` },
      local: f.k1,
      remote: changed,
      pinnedVkId: f.v1.id,
      maxSeenKver: 1,
      needsPassword: false,
      expectedVaultId: VAULT,
      adoptedAuth: authFor(f.k1),
      adoptedDigest: null,
    });
    expect([r1, r2]).toEqual([
      { ok: false, reason: "wrong_secret" },
      { kind: "reject", reason: "wrong_secret" },
    ]);
    for (const r of [r1, r2]) expect(leaked(r)).toEqual([]);
    expect(G.keybundle.raw.includes(PW)).toBe(false);
  }, 20_000);
});
