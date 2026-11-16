// The cloud backup's file (CLOUDBK patch 1; src/core/cloud/format.ts): what is uploaded and what never is, the
// recovery-key-only transform, and the strict parser.
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { fromB64, sha256, toB64, utf8 } from "../../src/core/crypto/bytes";
import { encryptVault } from "../../src/core/crypto/envelope";
import {
  openWithPassword,
  rekey,
  removeMethod,
  unlockWithRecoveryCode,
  type Keyring,
} from "../../src/core/crypto/keyring";
import {
  CloudBackupError,
  cloudBackupText,
  makeCloudBackup,
  MAX_CLOUD_FILE_BYTES,
  parseCloudBackup,
  parseCloudBackupText,
  type CloudBackup,
} from "../../src/core/cloud/format";
import { canonicalJson } from "../../src/core/vault/merge";
import { serializeVault } from "../../src/core/vault/validate";
import type { Generation } from "../../src/core/storage/format";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { account, PASSWORD, protectedKeys, seal, vaultOf, type Keys } from "../helpers/cloud";
import { TEST_KDF_ITERATIONS } from "../helpers/kdf";
import { legacyDeviceGeneration } from "../helpers/vaults";

let keys: Keys;
let gen: Generation;
/** A keyring that went through a key rotation: it holds a previous vault key. */
let rotated: { keyring: Keyring; gen: Generation; recoveryCode: string };

beforeAll(async () => {
  keys = await protectedKeys();
  gen = await seal(keys, vaultOf(keys.keyring.vaultId, [account("GitHub", "JBSWY3DPEHPK3PXP")]), 7);
  const r = await rekey(keys.keyring, keys.vk, PASSWORD, { iterations: TEST_KDF_ITERATIONS });
  const vault = vaultOf(r.keyring.vaultId, [account("AWS", "GEZDGNBVGY3TQOJQ")]);
  const envelope = await encryptVault(serializeVault(vault), r.vk, { vaultId: r.keyring.vaultId, rev: 9 });
  rotated = {
    keyring: r.keyring,
    recoveryCode: r.recoveryCode,
    gen: { v: 1, seq: 9, savedAt: 1, envelope, keyring: r.keyring },
  };
});

const methods = (b: CloudBackup) => b.generation.keyring.wraps.map((w) => w.method).sort();
/** The error's code and message ("invalid_file: size"), to tell one refusal from another. */
const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return "parsed";
  } catch (e) {
    if (e instanceof CloudBackupError) return `${e.code}: ${e.message}`;
    throw e;
  }
};
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "parsed";
  } catch (e) {
    if (e instanceof CloudBackupError) return e.code;
    throw e;
  }
};
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
/** A file as plain JSON, to break in the parser's tests. */
type Any = Record<string, any>;

describe("what is uploaded", () => {
  it("is the generation's named fields, at every level, and nothing beside them", async () => {
    const g = clone(gen) as unknown as Any;
    g.pin = "PIN-RECORD-MARKER";
    g.envelope.extra = "ENVELOPE-MARKER";
    g.keyring.future = "KEYRING-MARKER";
    g.keyring.wraps[0].hint = "WRAP-MARKER";
    g.keyring.wraps[0].kdf.pepper = "KDF-MARKER";
    // made at all (the parser it ends with would refuse a field that rode along), then made without them
    expect(await code(makeCloudBackup(g as unknown as Generation, "both", "Sixkey test"))).toBe("parsed");
    const b = await makeCloudBackup(g as unknown as Generation, "both", "Sixkey test");
    const text = cloudBackupText(b);
    for (const m of ["PIN-RECORD-MARKER", "ENVELOPE-MARKER", "KEYRING-MARKER", "WRAP-MARKER", "KDF-MARKER"])
      expect(text).not.toContain(m);
    expect(Object.keys(b).sort()).toEqual(["app", "format", "generation", "opens", "retired", "v"]);
    expect(Object.keys(b.generation).sort()).toEqual(["envelope", "keyring", "savedAt", "seq", "v"]);
    expect(Object.keys(b.generation.envelope).sort()).toEqual(
      ["checksum", "cipher", "ciphertext", "format", "formatVersion", "iv", "rev", "vaultId", "vkId"].sort(),
    );
    expect(Object.keys(b.generation.keyring).sort()).toEqual(["format", "previous", "v", "vaultId", "vkId", "wraps"]);
    for (const w of b.generation.keyring.wraps)
      expect(Object.keys(w).sort()).toEqual(["createdAt", "iv", "kdf", "method", "vkId", "wrapped"]);
    // the data itself is the very ciphertext on disk: no key was needed to make the file
    expect(b.generation.envelope.ciphertext).toBe(gen.envelope.ciphertext);
    expect(b.generation.seq).toBe(7);
  });

  it("leaves the earlier vault keys out (review r2 CB-13): a restore never needs them, and they open older copies", async () => {
    const g = clone(rotated.gen);
    expect(g.keyring.previous.length).toBe(1);
    const b = await makeCloudBackup(g, "both", "x");
    expect(b.generation.keyring.previous).toEqual([]);
    const text = cloudBackupText(b);
    for (const p of rotated.keyring.previous) {
      expect(text).not.toContain(p.wrapped);
      expect(text).not.toContain(p.iv);
    }
    // and the file still opens with the rotated key's password
    expect((await openWithPassword(b.generation.keyring, PASSWORD)).vk.id).toBe(rotated.keyring.vkId);
    // the earlier keys' ids, and nothing else of them, go in `retired` (review r3, S4)
    expect(b.retired).toEqual(rotated.keyring.previous.map((p) => p.vkId));
    expect(b.retired).not.toContain(b.generation.keyring.vkId);
    const plain = await makeCloudBackup(clone(gen), "both", "x");
    expect(plain.retired).toEqual([]);
  });

  it("is made from the store as it is read with no key, and nothing else the profile holds goes along", async () => {
    const kv = new MemoryKV();
    const store = new VaultStore({ kv, lock: createMutex(), now: () => 1_900_000_000_000 });
    await store.transact(async () => ({ envelope: gen.envelope, keyring: gen.keyring }));
    // what sits beside the vault in storage.local: the PIN's records, Touch ID, plugin grants, settings, the logs
    const beside = {
      sk_pin: { marker: "SK-PIN-MARKER" },
      sk_pin_restart: { marker: "SK-PIN-RESTART-MARKER" },
      sk_prf: { marker: "SK-PRF-MARKER" },
      sk_plugins: { marker: "SK-PLUGINS-MARKER" },
      sk_settings: { marker: "SK-SETTINGS-MARKER" },
      sk_security_log: { marker: "SK-SECURITY-MARKER" },
      sk_diag: { marker: "SK-DIAG-MARKER" },
    };
    await kv.set(beside);
    const loaded = await store.load();
    if (loaded.status !== "ok") throw new Error("not loaded");
    const text = cloudBackupText(await makeCloudBackup(loaded.gen, "both", "x"));
    for (const v of Object.values(beside)) expect(text).not.toContain(v.marker);
    expect(text).toContain(gen.envelope.ciphertext);
  });

  it("opens with the master password and with the recovery key, as the copy on this computer does", async () => {
    const b = await makeCloudBackup(gen, "both", "x");
    expect(methods(b)).toEqual(["password", "recovery"]);
    expect((await openWithPassword(b.generation.keyring, PASSWORD)).vk.id).toBe(keys.vk.id);
    expect((await unlockWithRecoveryCode(b.generation.keyring, keys.recoveryCode)).id).toBe(keys.vk.id);
  });
});

describe("what is never uploaded", () => {
  it("a device-key vault (Phase 0): its file would open with no secret", async () => {
    expect(await code(makeCloudBackup(await legacyDeviceGeneration(), "both", "x"))).toBe("device_key");
    expect(await code(makeCloudBackup(await legacyDeviceGeneration(), "recovery", "x"))).toBe("device_key");
  });

  it("a keyring that still holds a device key or a device wrap beside its master password", async () => {
    const legacy = await legacyDeviceGeneration();
    const withKey = clone(gen);
    withKey.keyring.deviceKey = legacy.keyring.deviceKey;
    expect(await code(makeCloudBackup(withKey, "both", "x"))).toBe("device_key");
    expect(await code(makeCloudBackup(withKey, "recovery", "x"))).toBe("device_key");
    const withWrap = clone(gen);
    withWrap.keyring.wraps.push({ ...legacy.keyring.wraps[0]!, vkId: gen.keyring.vkId });
    expect(await code(makeCloudBackup(withWrap, "both", "x"))).toBe("device_key");
    expect(await code(makeCloudBackup(withWrap, "recovery", "x"))).toBe("device_key");
  });

  it("a generation the store's checks refuse", async () => {
    const g = clone(gen);
    const ct = fromB64(g.envelope.ciphertext);
    ct[0] = ct[0]! ^ 1;
    g.envelope.ciphertext = toB64(ct);
    expect(await code(makeCloudBackup(g, "both", "x"))).toBe("damaged");
  });
});

describe("the recovery-key-only file (the card's switch)", () => {
  it("leaves no password wrap, nothing of it, and still opens with the recovery key", async () => {
    expect(await code(makeCloudBackup(gen, "recovery", "x"))).toBe("parsed");
    const b = await makeCloudBackup(gen, "recovery", "x");
    expect(b.opens).toBe("recovery");
    expect(methods(b)).toEqual(["recovery"]);
    const pw = gen.keyring.wraps.find((w) => w.method === "password")!;
    const text = cloudBackupText(b);
    expect(text).not.toContain(pw.wrapped);
    expect(text).not.toContain(pw.iv);
    expect(text).not.toContain((pw.kdf as { salt: string }).salt);
    expect(text).not.toContain("PBKDF2");
    expect(text).not.toContain('"password"');
    expect((await unlockWithRecoveryCode(b.generation.keyring, keys.recoveryCode)).id).toBe(keys.vk.id);
    await expect(openWithPassword(b.generation.keyring, PASSWORD)).rejects.toMatchObject({ code: "no_such_method" });
  });

  it("needs a recovery wrap; the file with both needs the password wrap", async () => {
    const noRecovery = { ...gen, keyring: removeMethod(gen.keyring, "recovery") };
    expect(await code(makeCloudBackup(noRecovery, "recovery", "x"))).toBe("no_wrap");
    expect(methods(await makeCloudBackup(noRecovery, "both", "x"))).toEqual(["password"]);
    const noPassword = { ...gen, keyring: removeMethod(gen.keyring, "password") };
    expect(await code(makeCloudBackup(noPassword, "both", "x"))).toBe("no_wrap");
    expect(methods(await makeCloudBackup(noPassword, "recovery", "x"))).toEqual(["recovery"]);
  });
});

describe("the parser", () => {
  let good: CloudBackup;
  beforeAll(async () => {
    good = await makeCloudBackup(gen, "both", "Sixkey 0.2.0");
  });
  const edit = (f: (b: Any) => void): Any => {
    const b = clone(good) as Any;
    f(b);
    return b;
  };
  const recheck = async (b: Any) => {
    // a changed header needs a checksum that fits it, or the change would be caught as damage, not by the rule tested
    const e = b.generation.envelope;
    const aad = utf8(`sixkey-vault|1|${e.vaultId}|${e.vkId}|${e.rev}`);
    e.checksum = toB64(await sha256(aad, fromB64(e.iv), fromB64(e.ciphertext)));
    return b;
  };

  it("reads back what it wrote, field for field", async () => {
    const back = await parseCloudBackupText(cloudBackupText(good));
    expect(canonicalJson(back)).toBe(canonicalJson(good));
    const r = await makeCloudBackup(gen, "recovery", "x");
    expect(canonicalJson(await parseCloudBackup(clone(r)))).toBe(canonicalJson(r));
  });

  it("refuses a device wrap, with the KDF a device wrap has, beside the password and recovery wraps", async () => {
    const device = clone((await legacyDeviceGeneration()).keyring.wraps[0]!);
    expect(device.method).toBe("device");
    const b = edit((x) => x.generation.keyring.wraps.push({ ...device, vkId: x.generation.keyring.vkId }));
    expect(await code(parseCloudBackup(b))).toBe("invalid_file");
  });

  it("names a later version's file as newer, never as damaged", async () => {
    expect(await code(parseCloudBackup(edit((b) => (b.v = 2))))).toBe("newer_format");
    expect(await code(parseCloudBackup(edit((b) => ((b.v = 2), (b.more = { x: 1 })))))).toBe("newer_format");
  });

  it.each([
    ["an extra field at the top", (b: Any) => (b.extra = 1)],
    ["a missing field", (b: Any) => delete b.app],
    ["another format", (b: Any) => (b.format = "sixkey-backup")],
    ["version 0", (b: Any) => (b.v = 0)],
    ["a version as text", (b: Any) => (b.v = "1")],
    ["an app name over 40 characters", (b: Any) => (b.app = "x".repeat(41))],
    ["an unknown `opens`", (b: Any) => (b.opens = "password")],
    ["an extra field in the generation", (b: Any) => (b.generation.pin = "1234")],
    ["an extra field in the envelope", (b: Any) => (b.generation.envelope.note = "x")],
    ["a device key in the keyring", (b: Any) => (b.generation.keyring.deviceKey = toB64(new Uint8Array(32)))],
    ["an extra field in the keyring", (b: Any) => (b.generation.keyring.hint = "x")],
    ["a device wrap", (b: Any) => (b.generation.keyring.wraps[0].method = "device")],
    ["one method twice", (b: Any) => b.generation.keyring.wraps.push(clone(b.generation.keyring.wraps[0]))],
    ["an extra field in a wrap", (b: Any) => (b.generation.keyring.wraps[0].hint = "x")],
    ["a wrap's time as text", (b: Any) => (b.generation.keyring.wraps[0].createdAt = "now")],
    ["an extra field in a KDF", (b: Any) => (b.generation.keyring.wraps[0].kdf.pepper = "x")],
    [
      "a password wrap under HKDF",
      (b: Any) => {
        const w = b.generation.keyring.wraps.find((x: Any) => x.method === "password");
        w.kdf = { name: "HKDF", hash: "SHA-256", salt: w.kdf.salt, v: 1 };
      },
    ],
    [
      "a recovery wrap under PBKDF2",
      (b: Any) => {
        const w = b.generation.keyring.wraps.find((x: Any) => x.method === "recovery");
        w.kdf = { name: "PBKDF2", hash: "SHA-256", iterations: 600_000, salt: w.kdf.salt, v: 1 };
      },
    ],
    ["a recovery-only file with a password wrap", (b: Any) => (b.opens = "recovery")],
    [
      "a file for both without its password wrap",
      (b: Any) => (b.generation.keyring.wraps = b.generation.keyring.wraps.filter((x: Any) => x.method !== "password")),
    ],
    ["no wraps", (b: Any) => (b.generation.keyring.wraps = [])],
    ["wraps that are not a list", (b: Any) => (b.generation.keyring.wraps = {})],
    [
      "an earlier vault key (never uploaded, CB-13)",
      (b: Any) => b.generation.keyring.previous.push({ vkId: "0123456789abcdef", iv: "x", wrapped: "y", createdAt: 1 }),
    ],
    [
      "a password wrap below PBKDF2's floor (CB-09: refused before anything is derived)",
      (b: Any) => (b.generation.keyring.wraps.find((x: Any) => x.method === "password").kdf.iterations = 599_999),
    ],
    [
      "a password wrap above the ceiling",
      (b: Any) => (b.generation.keyring.wraps.find((x: Any) => x.method === "password").kdf.iterations = 20_000_001),
    ],
    ["a generation that is a list", (b: Any) => (b.generation = [])],
    ["no list of retired keys (S4)", (b: Any) => delete b.retired],
    ["a retired key that is not a key id", (b: Any) => (b.retired = ["not-a-key-id"])],
    ["a retired key twice", (b: Any) => (b.retired = ["0123456789abcdef", "0123456789abcdef"])],
    ["the file's own key as retired", (b: Any) => (b.retired = [b.generation.keyring.vkId])],
    [
      "more retired keys than a keyring keeps",
      (b: Any) => (b.retired = Array.from({ length: 65 }, (_, i) => i.toString(16).padStart(16, "0"))),
    ],
  ])("refuses %s", async (_what, f) => {
    expect(await code(parseCloudBackup(edit(f)))).toBe("invalid_file");
  });

  it.each([
    ["a changed byte of the data", (b: Any) => (b.generation.envelope.ciphertext = toB64(new Uint8Array(64)))],
    ["a checksum that does not fit", (b: Any) => (b.generation.envelope.checksum = toB64(new Uint8Array(32)))],
    ["keys of another vault", (b: Any) => (b.generation.keyring.vaultId = "AAAAAAAAAAAAAAAAAAAAAA")],
  ])("calls %s damage", async (_what, f) => {
    expect(await code(parseCloudBackup(edit(f)))).toBe("damaged");
  });

  it("checks the envelope's header against its checksum, so a header changed with a fitting checksum is still the store's to judge", async () => {
    // another vault id in the header with a checksum made for it: shape and checksum pass, the key/data agreement fails
    const b = await recheck(edit((x) => (x.generation.envelope.vaultId = "BBBBBBBBBBBBBBBBBBBBBB")));
    expect(await code(parseCloudBackup(b))).toBe("damaged");
  });

  it("refuses text that is not JSON, and valid JSON larger than any vault, for its size (CB-12)", async () => {
    expect(await reason(parseCloudBackupText("{"))).toBe("invalid_file: not JSON");
    expect(await reason(parseCloudBackupText("null"))).toBe("invalid_file: file: not an object");
    const big = JSON.stringify({ pad: "x".repeat(MAX_CLOUD_FILE_BYTES) });
    expect(() => JSON.parse(big)).not.toThrow();
    expect(await reason(parseCloudBackupText(big))).toBe("invalid_file: size");
    // the limit counts UTF-8 bytes, not characters
    const wide = JSON.stringify({ pad: "备".repeat(Math.ceil(MAX_CLOUD_FILE_BYTES / 3) + 1) });
    expect(wide.length).toBeLessThan(MAX_CLOUD_FILE_BYTES);
    expect(await reason(parseCloudBackupText(wide))).toBe("invalid_file: size");
  });
});

describe("properties", () => {
  const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
  const junk = (taken: readonly string[]) =>
    fc.dictionary(
      fc.string({ minLength: 1, maxLength: 12 }).filter((k) => !taken.includes(k) && !RESERVED.has(k)),
      fc.jsonValue({ maxDepth: 2 }),
      { maxKeys: 4 },
    );

  it("fields beside the named ones, of any name and any value, never change the file", async () => {
    const clean = canonicalJson(await makeCloudBackup(gen, "both", "x"));
    await fc.assert(
      fc.asyncProperty(
        junk(["v", "seq", "savedAt", "envelope", "keyring"]),
        junk(["format", "formatVersion", "cipher", "vaultId", "vkId", "rev", "iv", "ciphertext", "checksum"]),
        junk(["format", "v", "vaultId", "vkId", "wraps", "previous", "deviceKey"]),
        junk(["method", "vkId", "kdf", "iv", "wrapped", "createdAt"]),
        async (gj, ej, kj, wj) => {
          const g = clone(gen) as unknown as Record<string, Record<string, unknown>>;
          Object.assign(g, gj);
          Object.assign(g.envelope!, ej);
          Object.assign(g.keyring!, kj);
          for (const w of g.keyring!.wraps as Record<string, unknown>[]) Object.assign(w, wj);
          expect(canonicalJson(await makeCloudBackup(g as unknown as Generation, "both", "x"))).toBe(clean);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("any field added to a valid file, at any level, makes it invalid", async () => {
    const good = clone(await makeCloudBackup(gen, "both", "x")) as Any;
    const places = [
      (b: Any) => b,
      (b: Any) => b.generation,
      (b: Any) => b.generation.envelope,
      (b: Any) => b.generation.keyring,
      (b: Any) => b.generation.keyring.wraps[0],
      (b: Any) => b.generation.keyring.wraps[0].kdf,
    ];
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: places.length - 1 }),
        fc.string({ minLength: 1, maxLength: 12 }).filter((k) => !RESERVED.has(k)),
        fc.jsonValue({ maxDepth: 1 }),
        async (at, key, value) => {
          const b = clone(good);
          const o = places[at]!(b);
          fc.pre(!(key in o));
          o[key] = value;
          expect(await code(parseCloudBackup(b))).toBe("invalid_file");
        },
      ),
      { numRuns: 80 },
    );
  });
});
