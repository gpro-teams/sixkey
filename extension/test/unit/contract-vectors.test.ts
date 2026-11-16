// M0 known-answer vectors (docs/SYNC-DESIGN.md §2.2–§3.14, §8.1), checked with WebCrypto and, wherever a Phase 0
// primitive already exists, with the shipped Phase 0 code itself. The same file is checked by contract/py (Python).
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { CryptoError, fromB64, sha256, toB64, utf8 } from "../../src/core/crypto/bytes";
import { decryptVault, encryptVault, isEnvelopeIntact } from "../../src/core/crypto/envelope";
import { assertKdfParams, hkdfBits, normalizePassword, pbkdf2Bits } from "../../src/core/crypto/kdf";
import {
  unlockWithPassword,
  unlockWithRecoveryCode,
  unwrapPreviousVks,
  validateKeyring,
} from "../../src/core/crypto/keyring";
import { formatRecoveryCode, parseRecoveryCode } from "../../src/core/crypto/recovery-code";
import { vkFromRaw } from "../../src/core/crypto/vk";
import { canonicalJson } from "../../src/core/vault/merge";
import { b64u, fromB64u, fromHex, hex, lintSchema, loadContract, validate, type J } from "../helpers/contract";

const { vectors: V, vectorSchema } = loadContract();
const G = V.groups;
const subtle = globalThis.crypto.subtle;
const EMPTY = new Uint8Array(0);
const bs = (b: Uint8Array): BufferSource => b as BufferSource;
const VK1 = fromHex(V.fixed_inputs.vk1_hex);
const VK2 = fromHex(V.fixed_inputs.vk2_hex);
const VK0 = fromHex(V.fixed_inputs.vk0_hex);

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle.importKey("raw", bs(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, bs(data)));
}
async function gcmEncrypt(key: Uint8Array, iv: Uint8Array, pt: Uint8Array, aad: string): Promise<Uint8Array> {
  const k = await subtle.importKey("raw", bs(key), "AES-GCM", false, ["encrypt"]);
  return new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: bs(iv), additionalData: bs(utf8(aad)), tagLength: 128 }, k, bs(pt)),
  );
}
async function gcmOpens(key: Uint8Array, iv: Uint8Array, ct: Uint8Array, aad: string): Promise<boolean> {
  const k = await subtle.importKey("raw", bs(key), "AES-GCM", false, ["decrypt"]);
  return subtle.decrypt({ name: "AES-GCM", iv: bs(iv), additionalData: bs(utf8(aad)), tagLength: 128 }, k, bs(ct)).then(
    () => true,
    () => false,
  );
}
async function sixDigits(tag: string, h: Uint8Array): Promise<[number, string]> {
  const d = await sha256(utf8(tag), h);
  const u32 = new DataView(d.buffer, d.byteOffset, 4).getUint32(0, false);
  return [u32, String(u32 % 1_000_000).padStart(6, "0")];
}
const b64 = toB64;

describe("contract vectors: file and schema", () => {
  it("the schema only uses the keyword subset both validators implement", () => {
    lintSchema(vectorSchema, "sync-v1.schema.json");
  });
  it("the vector file validates against its JSON Schema", () => {
    expect(validate(vectorSchema, V, vectorSchema)).toEqual([]);
  });
  it("the validator reports a broken file", () => {
    const { enrollment: _gone, ...rest } = G;
    expect(validate(vectorSchema, { ...V, groups: rest }, vectorSchema).length).toBeGreaterThan(0);
    expect(validate(vectorSchema, { ...V, v: 2 }, vectorSchema).length).toBeGreaterThan(0);
  });
  it("every group claims a TypeScript verifier and only known verifier ids", () => {
    for (const [name, g] of Object.entries<J>(G)) expect(g.verified_by, name).toContain("ts-phase0");
  });
});

/**
 * HKDF labels and AAD tags of records that never leave this device: the PIN's (src/core/crypto/pin.ts) and the device
 * unlock's PRF wrap (src/core/crypto/prf.ts, QUICK-UNLOCK Stage 2).
 */
// (and the PIN after a restart's MAC label and its two tags: OWNER-DECISIONS/20, pin-restart-wrap.ts)
const LOCAL_ONLY_LABELS = ["sixkey/v1/pin-cfg", "sixkey/v1/kek-prf", "sixkey/v1/gate-mac", "sixkey/v1/pin-restart-mac"];
// (the session PIN's "sixkey-quick|1|" went with it on 2026-10-30: OWNER-DECISIONS/20, its second note)
const LOCAL_ONLY_TAGS = [
  "sixkey-pin|1|",
  "sixkey-prf|1|",
  "sixkey-gate|1|",
  "sixkey-pin-restart|1|",
  "sixkey-pin-restart-mac|1|",
];

describe("contract vectors: labels and encodings", () => {
  it("HKDF labels are pairwise distinct; domain tags are distinct and prefix-free", () => {
    const labels: string[] = G.labels.hkdf_info.map((l: J) => l.label);
    const tags: string[] = G.labels.domain_tags.map((t: J) => t.tag);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set([...labels, ...tags]).size).toBe(labels.length + tags.length);
    for (const a of tags) for (const b of tags) if (a !== b) expect(b.startsWith(a), `${a} prefixes ${b}`).toBe(false);
  });
  it("every HKDF label in the shipped Phase 0 crypto code (any version) is in the vector list, or one of the local-only labels", () => {
    const dir = new URL("../../src/core/crypto/", import.meta.url);
    const inCode = new Set<string>();
    const text = readdirSync(dir)
      .map((f) => readFileSync(new URL(f, dir), "utf8"))
      .join("\n");
    for (const m of text.matchAll(/"(sixkey\/v\d+\/[a-z-]+)"/g)) inCode.add(m[1]!);
    expect(inCode.size).toBeGreaterThanOrEqual(5);
    const listed = new Set(G.labels.hkdf_info.map((l: J) => l.label));
    for (const l of inCode) expect(listed.has(l) || LOCAL_ONLY_LABELS.includes(l), l).toBe(true);
    // the pairing code's check-bit tag lives with the code in core/crypto (pairing-code.ts) and is a contract tag
    expect(text).toContain('"sixkey-pairing-code|1|"');
    expect(G.labels.domain_tags.some((t: J) => t.tag === "sixkey-pairing-code|1|")).toBe(true);
  });
  it("the local-only labels and tags (the PIN, QUICK-UNLOCK §5.2) are in the code, distinct from the contract's, and prefix-free", () => {
    // They never leave this device (sk_pin, sk_quick), so they are not part of the contract shared with the server;
    // they must still never collide with a label or tag that is.
    const labels: string[] = G.labels.hkdf_info.map((l: J) => l.label);
    const tags: string[] = G.labels.domain_tags.map((t: J) => t.tag);
    const local = ["pin.ts", "prf.ts", "pin-restart-wrap.ts"]
      .map((f) => readFileSync(new URL(`../../src/core/crypto/${f}`, import.meta.url), "utf8"))
      .join("\n");
    for (const x of [...LOCAL_ONLY_LABELS, ...LOCAL_ONLY_TAGS]) expect(local, x).toContain(`"${x}"`);
    const all = [...labels, ...tags, ...LOCAL_ONLY_LABELS, ...LOCAL_ONLY_TAGS];
    expect(new Set(all).size).toBe(all.length);
    const allTags = [...tags, ...LOCAL_ONLY_TAGS];
    for (const a of allTags)
      for (const b of allTags) if (a !== b) expect(b.startsWith(a), `${a} prefixes ${b}`).toBe(false);
  });
  it("base64url: encode, strict decode, rejects", () => {
    for (const c of G.base64url.encode) {
      expect(b64u(fromHex(c.hex))).toBe(c.b64u);
      expect(hex(fromB64u(c.b64u))).toBe(c.hex);
    }
    for (const c of G.base64url.decode_reject) expect(() => fromB64u(c.input), c.why).toThrow();
  });
  it("standard base64 matches Phase 0 toB64/fromB64", () => {
    for (const c of G.base64.encode) {
      expect(toB64(fromHex(c.hex))).toBe(c.b64);
      expect(hex(fromB64(c.b64))).toBe(c.hex);
    }
    for (const c of G.base64.decode_reject) expect(() => fromB64(c.input), c.why).toThrow(CryptoError);
    for (const c of G.base64.decode_accept_noncanonical) expect(hex(fromB64(c.input))).toBe(c.hex);
  });
  it("canonicalJson matches Phase 0 canonicalJson", () => {
    for (const c of G.canonical_json.cases) expect(canonicalJson(JSON.parse(c.input)), c.name).toBe(c.canonical);
  });
  it("hour, day and minute truncation", () => {
    for (const c of G.time_truncation.cases) {
      expect([
        Math.floor(c.ms / 3_600_000) * 3_600_000,
        Math.floor(c.ms / 86_400_000) * 86_400_000,
        Math.floor(c.ms / 60_000) * 60_000,
        c.ms % 3_600_000 === 0,
      ]).toEqual([c.hour, c.day, c.minute, c.hour_aligned]);
    }
  });
  it("padding to 16 KiB with spaces", async () => {
    const bucket: number = G.padding.bucket_bytes;
    for (const c of G.padding.lengths) expect(Math.ceil(c.utf8_len / bucket) * bucket).toBe(c.padded_len);
    for (const c of G.padding.concrete) {
      const b = utf8(c.plaintext);
      const padded = new Uint8Array(Math.ceil(b.length / bucket) * bucket).fill(0x20);
      padded.set(b);
      expect([b.length, padded.length]).toEqual([c.utf8_len, c.padded_len]);
      expect(toB64(await sha256(padded))).toBe(c.padded_sha256_b64);
      expect(JSON.parse(new TextDecoder().decode(padded))).toEqual(JSON.parse(c.plaintext));
    }
  });
});

describe("contract vectors: VK subkeys, envelope, write proof", () => {
  it("HKDF subkeys of each VK (Phase 0 hkdfBits, vkFromRaw)", async () => {
    for (const k of G.vk_subkeys.keys) {
      const vk = fromHex(k.vk_hex);
      expect((await vkFromRaw(vk)).id).toBe(k.vk_id);
      for (const s of k.subkeys) expect(hex(await hkdfBits(vk, EMPTY, s.label, s.bits)), s.label).toBe(s.hex);
      expect(new Set(k.subkeys.map((s: J) => s.hex)).size).toBe(k.subkeys.length);
    }
  });
  it("WebCrypto hazard: deriveKey(AES-256) exported equals deriveBits(256) for one label", async () => {
    for (const c of G.vk_subkeys.webcrypto_hazard.cases) {
      const base = await subtle.importKey("raw", bs(VK1), "HKDF", false, ["deriveKey"]);
      const key = await subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: bs(EMPTY), info: bs(utf8(c.label)) },
        base,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt"],
      );
      const exported = hex(new Uint8Array(await subtle.exportKey("raw", key)));
      expect(exported).toBe(c.derive_key_aes256_export_hex);
      expect(exported).toBe(hex(await hkdfBits(VK1, EMPTY, c.label, 256)));
    }
  });
  it("envelope: Phase 0 encryptVault with the fixed iv reproduces it; head is SHA-256 of the raw text", async () => {
    const g = G.envelope;
    const vk = await vkFromRaw(VK1);
    const env = await encryptVault(utf8(g.plaintext), vk, { vaultId: g.vault_id, rev: g.rev }, () => fromB64(g.iv_b64));
    expect(env).toEqual(g.envelope);
    expect(JSON.stringify(env)).toBe(g.envelope_text);
    expect(await isEnvelopeIntact(g.envelope)).toBe(true);
    expect(new TextDecoder().decode(await decryptVault(g.envelope, vk))).toBe(g.plaintext);
    expect(toB64(await sha256(utf8(g.envelope_text)))).toBe(g.head_b64);
    expect(toB64(await sha256(utf8(g.head_of_reserialized_text.envelope_text)))).toBe(
      g.head_of_reserialized_text.head_b64,
    );
    expect(g.head_of_reserialized_text.head_b64).not.toBe(g.head_b64);
  });
  it("envelope tampering: any ciphertext, tag or iv byte, and any AAD field, makes Phase 0 decryptVault fail", async () => {
    const g = G.envelope;
    const vk = await vkFromRaw(VK1);
    const kEnc = await hkdfBits(VK1, EMPTY, "sixkey/v1/vault-enc", 256);
    for (const m of g.must_not_open)
      expect(await gcmOpens(kEnc, fromB64(m.iv_b64), fromB64(m.ciphertext_b64), m.aad), m.name).toBe(false);
    const byteFlips = g.must_not_open.filter((m: J) => m.aad === g.aad);
    expect(byteFlips.length).toBe(3);
    for (const m of byteFlips)
      await expect(
        decryptVault({ ...g.envelope, iv: m.iv_b64, ciphertext: m.ciphertext_b64 }, vk),
        m.name,
      ).rejects.toThrow(CryptoError);
    await expect(decryptVault({ ...g.envelope, rev: g.rev + 1 }, vk)).rejects.toThrow(CryptoError);
    expect(await isEnvelopeIntact({ ...g.envelope, rev: g.rev + 1 })).toBe(false);
  });
  it("write proof and its verification cases", async () => {
    const g = G.write_proof;
    const kw = await hkdfBits(VK1, EMPTY, "sixkey/v1/vault-write", 256);
    expect(toB64(kw)).toBe(g.write_key_b64);
    expect(toB64(await hkdfBits(VK2, EMPTY, "sixkey/v1/vault-write", 256))).toBe(g.new_write_key_b64_vk2);
    expect(hex(kw)).not.toBe(hex(await hkdfBits(VK1, EMPTY, "sixkey/v1/vault-enc", 256)));
    expect(g.input).toBe(`sixkey-write|1|${g.vault_id}|${g.if_version}|${g.checksum_b64}`);
    expect(toB64(await hmac(kw, utf8(g.input)))).toBe(g.write_proof_b64);
    for (const c of g.verify) {
      const want = toB64(await hmac(kw, utf8(`sixkey-write|1|${c.vault_id}|${c.if_version}|${c.checksum_b64}`)));
      expect(want === c.proof_b64, c.name).toBe(c.valid);
    }
  });
});

describe("contract vectors: recovery_auth and pw_auth", () => {
  it("recovery code text (Phase 0), recAuth and its verifier", async () => {
    const g = G.recovery_auth;
    const secret = fromHex(g.secret_hex);
    expect(await formatRecoveryCode(secret)).toBe(g.code);
    expect(hex(await parseRecoveryCode(g.code))).toBe(g.secret_hex);
    for (const s of g.equivalent_inputs) expect(hex(await parseRecoveryCode(s))).toBe(g.secret_hex);
    for (const r of g.rejected_inputs)
      await expect(parseRecoveryCode(r.input)).rejects.toMatchObject({ code: r.error });
    const recAuth = await hkdfBits(secret, EMPTY, "sixkey/v1/recovery-auth", 256);
    expect(toB64(recAuth)).toBe(g.recovery_auth_b64);
    expect(toB64(await sha256(utf8("sixkey-recovery-verifier|1|"), recAuth))).toBe(g.recovery_verifier_b64);
    const salt = fromB64(g.contrast.kek_recovery_salt_b64);
    expect(hex(await hkdfBits(secret, salt, "sixkey/v1/kek-recovery", 256))).toBe(g.contrast.kek_recovery_hex);
    expect(g.contrast.kek_recovery_hex).not.toBe(hex(recAuth));
    expect(toB64(await hkdfBits(secret, salt, "sixkey/v1/recovery-auth", 256))).toBe(
      g.contrast.recovery_auth_with_wrap_salt_b64,
    );
    expect(toB64(await sha256(utf8(`sixkey-recovery-verifier|1|${toB64(recAuth)}`)))).toBe(
      g.contrast.verifier_over_base64_text_b64,
    );
  });
  it("pw_auth = HKDF(PBKDF2(NFKC(pw))) and its verifier (Phase 0 normalizePassword, pbkdf2Bits)", async () => {
    const g = G.password_auth;
    assertKdfParams(g.kdf);
    const salt = fromB64(g.kdf.salt);
    const seen = new Map<string, string>();
    for (const c of g.cases) {
      expect(normalizePassword(c.password)).toBe(c.nfkc);
      const pb = await pbkdf2Bits(utf8(c.nfkc), salt, g.kdf.iterations, 256);
      expect(hex(pb), c.name).toBe(c.pbkdf2_hex);
      const pwAuth = await hkdfBits(pb, EMPTY, "sixkey/v1/password-auth", 256);
      expect(toB64(pwAuth)).toBe(c.password_auth_b64);
      expect(toB64(await sha256(utf8("sixkey-password-verifier|1|"), pwAuth))).toBe(c.password_verifier_b64);
      seen.set(c.name, c.password_auth_b64);
    }
    expect(new Set(seen.values()).size).toBe(seen.size - 1); // the fullwidth input is NFKC-equal to the ascii one
    for (const p of g.kdf_params.accept) expect(() => assertKdfParams(p)).not.toThrow();
    for (const p of g.kdf_params.reject) expect(() => assertKdfParams(p), JSON.stringify(p)).toThrow(CryptoError);
  }, 20_000);
});

const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/;
function kdfOk(p: J): boolean {
  try {
    assertKdfParams(p);
    return p.name === "PBKDF2";
  } catch {
    return false;
  }
}
/** The explicit KeyBundle rules of §2.3/§3.13 (the keyless checks M1 and the server must both apply). */
function bundleShapeOk(b: J): boolean {
  try {
    if (
      b?.format !== "sixkey-keybundle" ||
      b.v !== 1 ||
      typeof b.vaultId !== "string" ||
      !Number.isSafeInteger(b.kver) ||
      b.kver < 1
    )
      return false;
    const kr = validateKeyring(b.keyring); // Phase 0 shape, then the sync constraints
    if (kr.vaultId !== b.vaultId || kr.deviceKey !== undefined || kr.wraps.length !== 2) return false;
    if (
      kr.wraps
        .map((w) => w.method)
        .sort()
        .join() !== "password,recovery"
    )
      return false;
    if (!kdfOk(kr.wraps.find((w) => w.method === "password")!.kdf)) return false;
    if (kr.wraps.find((w) => w.method === "recovery")!.kdf?.name !== "HKDF") return false;
    if (!kdfOk(b.auth?.kdf) || typeof b.by !== "string" || !DEVICE_ID.test(b.by) || !Number.isSafeInteger(b.at))
      return false;
    // §2.3 (§0.0d N16): the server rejects bundle times that are not whole UTC hours.
    const times = [b.at, ...kr.wraps.map((w) => w.createdAt), ...kr.previous.map((p) => p.createdAt)];
    if (!times.every((x) => Number.isSafeInteger(x) && x % 3_600_000 === 0)) return false;
    return fromB64(b.mac).length === 32;
  } catch {
    return false;
  }
}

describe("contract vectors: KeyBundle", () => {
  const g = G.keybundle;
  const macOf = async (b: J, key: Uint8Array) => {
    const { mac: _m, ...rest } = b;
    return toB64(await hmac(key, utf8(`sixkey-keybundle|1|${canonicalJson(rest)}`)));
  };
  it("MAC over the Phase 0 canonicalJson, and every MAC case", async () => {
    const kMac = await hkdfBits(VK1, EMPTY, "sixkey/v1/keybundle-mac", 256);
    expect(hex(kMac)).toBe(g.k_mac_hex);
    const bundle = JSON.parse(g.raw);
    expect(bundle).toEqual(g.bundle);
    const { mac: _m, ...rest } = bundle;
    expect(`sixkey-keybundle|1|${canonicalJson(rest)}`).toBe(g.mac_input);
    expect(await macOf(bundle, kMac)).toBe(g.mac_b64);
    const k512 = await hkdfBits(VK1, EMPTY, "sixkey/v1/keybundle-mac", 512);
    for (const c of g.mac_cases) {
      const b = JSON.parse(c.raw);
      expect((await macOf(b, kMac)) === b.mac, c.name).toBe(c.mac_valid);
      if (c.name.includes("512-bit")) expect(await macOf(b, k512)).toBe(b.mac);
    }
  });
  it("shape rules (every case carries a valid MAC so only the named rule fails)", async () => {
    const kMac = await hkdfBits(VK1, EMPTY, "sixkey/v1/keybundle-mac", 256);
    for (const c of g.shape_cases) {
      const b = JSON.parse(c.raw);
      expect(await macOf(b, kMac), c.name).toBe(b.mac);
      expect(bundleShapeOk(b), c.name).toBe(c.shape_valid);
    }
  });
  it("its keyring opens with Phase 0 unlockWithPassword / unlockWithRecoveryCode / unwrapPreviousVks", async () => {
    const kr = validateKeyring(g.bundle.keyring);
    const byPw = await unlockWithPassword(kr, g.password);
    const byCode = await unlockWithRecoveryCode(kr, G.recovery_auth.code);
    expect(hex(byPw.raw)).toBe(hex(VK1));
    expect(hex(byCode.raw)).toBe(hex(VK1));
    const prev = await unwrapPreviousVks(kr, byPw);
    expect(prev.map((p) => hex(p.raw))).toEqual([hex(VK0)]);
    for (const t of [g.bundle.at, ...kr.wraps.map((w) => w.createdAt), ...kr.previous.map((p) => p.createdAt)])
      expect(t % 3_600_000).toBe(0);
    expect(g.bundle.auth.kdf.salt).not.toBe(kr.wraps.find((w) => w.method === "password")!.kdf!.salt);
  }, 20_000);
});

/** §2.4 (revision 5, §0.0d N5): NFKC, trim U+0020 at both ends, then reject in a fixed order. */
function deviceNameRule(input: string): J {
  if (/[\uD800-\uDFFF]/u.test(input)) return { valid: false, reason: "not_well_formed" }; // a lone surrogate (pairs are one code point under /u)
  const n = input.normalize("NFKC").replace(/^ +| +$/g, "");
  const cps = [...n].length;
  if (cps < 1) return { valid: false, reason: "empty", normalized: n };
  if (cps > 40) return { valid: false, reason: "too_long", normalized: n, code_points: cps };
  if (/\p{Cc}/u.test(n)) return { valid: false, reason: "control_char", normalized: n };
  if (/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(n))
    return { valid: false, reason: "bidi_control", normalized: n };
  if (/[\u200b-\u200d\u2060\ufeff]/u.test(n)) return { valid: false, reason: "zero_width", normalized: n };
  const bytes = utf8(n);
  const padded = new Uint8Array(160).fill(0x20);
  padded.set(bytes);
  return {
    valid: true,
    normalized: n,
    code_points: cps,
    utf16_units: n.length,
    utf8_len: bytes.length,
    padded_b64: toB64(padded),
    decoded: new TextDecoder().decode(padded).replace(/ +$/, ""),
  };
}

describe("contract vectors: device name and device backup", () => {
  it("device-name rules (§2.4): NFKC, trim, 1..40 code points, no Cc / bidi / zero width, padded to 160 bytes", () => {
    for (const c of G.device_name.cases) {
      const { name: _n, input: _i, ...want } = c;
      expect(deviceNameRule(c.input), c.name).toEqual(want);
    }
  });
  it("name_ct under K_name and the AADs that must not open it", async () => {
    const e = G.device_name.encrypt;
    const kName = await hkdfBits(VK1, EMPTY, "sixkey/v1/device-name", 256);
    expect(hex(kName)).toBe(e.k_name_hex);
    for (const c of e.cases) {
      expect(c.aad).toBe(`sixkey-devname|1|${V.fixed_inputs.vault_id}|${c.name_ct.vkId}|${c.device_id}`);
      expect(
        toB64(await gcmEncrypt(kName, fromB64(c.name_ct.iv), fromB64(deviceNameRule(c.name).padded_b64), c.aad)),
      ).toBe(c.name_ct.ct);
    }
    const kName2 = await hkdfBits(VK2, EMPTY, "sixkey/v1/device-name", 256);
    for (const m of e.must_not_open)
      expect(
        await gcmOpens(m.key === "VK1" ? kName : kName2, fromB64(m.iv_b64), fromB64(m.ct_b64), m.aad),
        m.name,
      ).toBe(false);
  });
  it("sk_sync_cfg.enc under K_devbackup", async () => {
    const g = G.device_backup;
    expect(g.aad).toBe(`sixkey-devkey|1|${V.fixed_inputs.vault_id}|${g.enc.vkId}|${g.device_id}`);
    const k = await hkdfBits(VK1, EMPTY, "sixkey/v1/device-backup", 256);
    expect(toB64(await gcmEncrypt(k, fromB64(g.enc.iv), utf8(g.plaintext), g.aad))).toBe(g.enc.ct);
  });
});

const SPKI_PREFIX = "3059301306072a8648ce3d020106082a8648ce3d030107034200";
const keyByName = (name: string): J => G.public_keys.keys.find((k: J) => k.name === name);
const jwkOf = (k: J) => ({
  kty: "EC",
  crv: "P-256",
  d: b64u(fromHex(k.d_hex)),
  x: b64u(fromHex(k.x_hex)),
  y: b64u(fromHex(k.y_hex)),
});
async function importsAsPoint(raw: Uint8Array): Promise<boolean> {
  return subtle.importKey("raw", bs(raw), { name: "ECDH", namedCurve: "P-256" }, true, []).then(
    () => true,
    () => false,
  );
}
const epkFormatOk = (raw: Uint8Array) => raw.length === 65 && raw[0] === 0x04;
const dpkFormatOk = (spki: Uint8Array) =>
  spki.length === 91 && hex(spki.slice(0, 26)) === SPKI_PREFIX && spki[26] === 0x04;

describe("contract vectors: public key encodings", () => {
  it("each fixed key: JWK import, 65-byte point and SPKI DER agree with WebCrypto", async () => {
    for (const k of G.public_keys.keys) {
      const priv = await subtle.importKey("jwk", jwkOf(k), { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
      const jwk = await subtle.exportKey("jwk", priv);
      const pub = await subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["verify"],
      );
      expect(toB64(new Uint8Array(await subtle.exportKey("raw", pub)))).toBe(k.point_b64);
      expect(toB64(new Uint8Array(await subtle.exportKey("spki", pub)))).toBe(k.spki_b64);
      expect(k.spki_b64u).toBe(b64u(fromB64(k.spki_b64)));
      expect(hex(fromB64(k.spki_b64)).startsWith(SPKI_PREFIX)).toBe(true);
    }
  });
  it("malformed epk and dpk are rejected by the explicit format rules", async () => {
    for (const r of G.public_keys.epk_reject) {
      const raw = fromB64(r.b64);
      expect(epkFormatOk(raw) && (await importsAsPoint(raw)), r.name).toBe(false);
    }
    for (const r of G.public_keys.dpk_reject) {
      const spki = fromB64(r.b64);
      expect(dpkFormatOk(spki) && (await importsAsPoint(spki.slice(26))), r.name).toBe(false);
    }
  });
});

type Tr = {
  rid: string;
  devN: string;
  devA: string;
  dpkN: Uint8Array;
  epkN: Uint8Array;
  epkA: Uint8Array;
  nN: Uint8Array;
};
const transcriptOf = (t: Tr) =>
  `sixkey-enroll|2|${t.rid}|${t.devN}|${t.devA}|${b64u(t.dpkN)}|${b64u(t.epkN)}|${b64u(t.epkA)}|${b64u(t.nN)}`;
const commitOf = (devN: string, dpk: Uint8Array, epk: Uint8Array, n: Uint8Array) =>
  sha256(utf8(`sixkey-enroll-commit|2|${devN}|${b64u(dpk)}|${b64u(epk)}|${b64u(n)}`));
async function ecdh(own: J, peerRaw: Uint8Array): Promise<Uint8Array> {
  const priv = await subtle.importKey("jwk", jwkOf(own), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const pub = await subtle.importKey("raw", bs(peerRaw), { name: "ECDH", namedCurve: "P-256" }, true, []);
  return new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256));
}
const SAS_TAG = "sixkey/v2/enroll-sas|";
const ENROLL_KEY = "sixkey/v2/enroll-key";
const PAIRING_TAG = "sixkey-pairing-code|1|";
/** A test-local reading of the 28-symbol codes (the generator's and contract/py's rule), independent of src/. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
async function check12(tag: string, secret: Uint8Array): Promise<number> {
  const h = await sha256(utf8(tag), secret);
  return (h[0]! << 4) | (h[1]! >> 4);
}
async function codeOf(secret: Uint8Array, tag: string): Promise<string> {
  let n = (BigInt(`0x${hex(secret)}`) << 12n) | BigInt(await check12(tag, secret));
  let s = "";
  for (let k = 0; k < 28; k++, n >>= 5n) s = CROCKFORD[Number(n & 31n)] + s;
  return s.match(/.{4}/g)!.join("-");
}
async function readCode(input: string, tag: string, kind: string): Promise<Uint8Array> {
  const s = input
    .toUpperCase()
    .replace(/[\s\-_]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (s.length !== 28) throw Object.assign(new Error(), { code: `${kind}_length` });
  let n = 0n;
  for (const ch of s) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) throw Object.assign(new Error(), { code: `${kind}_char` });
    n = (n << 5n) | BigInt(v);
  }
  const secret = fromHex((n >> 12n).toString(16).padStart(32, "0"));
  if ((await check12(tag, secret)) !== Number(n & 0xfffn))
    throw Object.assign(new Error(), { code: `${kind}_checksum` });
  return secret;
}

describe("contract vectors: enrollment (§3.2; enrolment v2, revision 27)", () => {
  const g = G.enrollment;
  const i = g.inputs;
  const tr: Tr = {
    rid: i.rid,
    devN: i.dev_n,
    devA: i.dev_a,
    dpkN: fromB64(i.dpk_n_spki_b64),
    epkN: fromB64(i.epk_n_b64),
    epkA: fromB64(i.epk_a_b64),
    nN: fromB64(i.n_n_b64),
  };
  const S = fromHex(i.pairing_secret_hex);

  it("commitment, transcript, h, ECDH from both sides, the pairing code, K_enroll over Z || S, the SAS; no CC", async () => {
    expect(g.commit_input).toBe(`sixkey-enroll-commit|2|${i.dev_n}|${b64u(tr.dpkN)}|${b64u(tr.epkN)}|${b64u(tr.nN)}`);
    expect(toB64(await commitOf(i.dev_n, tr.dpkN, tr.epkN, tr.nN))).toBe(g.commit_b64);
    expect(transcriptOf(tr)).toBe(g.transcript);
    const h = await sha256(utf8(g.transcript));
    expect([hex(h), toB64(h), b64u(h)]).toEqual([g.h_hex, g.h_b64, g.h_b64u]);
    const zN = await ecdh(keyByName("esk_N"), tr.epkA);
    const zA = await ecdh(keyByName("esk_A"), tr.epkN);
    expect(hex(zN)).toBe(g.z_hex);
    expect(hex(zA)).toBe(g.z_hex);
    expect(await codeOf(S, PAIRING_TAG)).toBe(i.pairing_code);
    expect(hex(await readCode(i.pairing_code, PAIRING_TAG, "pairing"))).toBe(i.pairing_secret_hex);
    expect(i.ikm_hex).toBe(hex(zN) + hex(S));
    expect(hex(await hkdfBits(fromHex(i.ikm_hex), h, ENROLL_KEY, 256))).toBe(g.k_enroll_hex);
    expect(hex(await hkdfBits(zN, h, ENROLL_KEY, 256))).not.toBe(g.k_enroll_hex); // K depends on S
    expect(await sixDigits(SAS_TAG, h)).toEqual([g.sas_u32, g.sas]);
    expect([g.cc, g.cc_u32]).toEqual([undefined, undefined]);
    expect(toB64(await sha256(tr.dpkN))).toBe(g.sig_pubkey_sha256_b64);
  });
  it("label_swap: the same secret as a recovery code and as a pairing code; each is rejected where the other belongs", async () => {
    const l = g.label_swap;
    const secret = fromHex(l.secret_hex);
    expect(l.secret_hex).toBe(i.pairing_secret_hex);
    expect([await codeOf(secret, PAIRING_TAG), await codeOf(secret, "")]).toEqual([
      l.as_pairing_code,
      l.as_recovery_code,
    ]);
    expect([await check12(PAIRING_TAG, secret), await check12("", secret)]).toEqual([
      l.pairing_check_bits,
      l.recovery_check_bits,
    ]);
    expect(l.pairing_check_bits).not.toBe(l.recovery_check_bits);
    await expect(readCode(l.as_recovery_code, PAIRING_TAG, "pairing")).rejects.toMatchObject({
      code: l.recovery_code_as_pairing_code,
    });
    await expect(parseRecoveryCode(l.as_pairing_code)).rejects.toMatchObject({ code: l.pairing_code_as_recovery_code }); // Phase 0 code
    expect(await formatRecoveryCode(secret)).toBe(l.as_recovery_code); // the recovery code's untagged check bits are Phase 0's
  });
  it("payload and reveal name: AES-GCM under K_enroll, iv || ct || tag, and the inputs that must not open them", async () => {
    const K = fromHex(g.k_enroll_hex);
    const name = fromB64(g.reveal_name.wire_b64);
    const payload = fromB64(g.payload.wire_b64);
    expect(g.reveal_name.aad).toBe(`sixkey-enroll-name|2|${g.h_b64u}`);
    expect(g.payload.aad).toBe(`sixkey-enroll-payload|2|${g.h_b64u}`);
    expect(toB64(name.slice(0, 12))).toBe(g.reveal_name.iv_b64);
    expect(hex(name.slice(12))).toBe(
      hex(await gcmEncrypt(K, name.slice(0, 12), fromB64(g.reveal_name.plaintext_padded_b64), g.reveal_name.aad)),
    );
    expect(hex(payload.slice(12))).toBe(
      hex(await gcmEncrypt(K, payload.slice(0, 12), utf8(g.payload.plaintext), g.payload.aad)),
    );
    expect(g.reveal_name.plaintext_padded_b64).toBe(deviceNameRule("Chrome 配置文件").padded_b64);
    const P = JSON.parse(g.payload.plaintext);
    expect(canonicalJson(P)).toBe(g.payload.plaintext);
    expect([P.format, P.v, P.vaultId, P.vk, P.bundle, P.approver]).toEqual([
      "sixkey-enroll-payload",
      2,
      V.fixed_inputs.vault_id,
      toB64(VK1),
      G.keybundle.raw,
      V.fixed_inputs.dev_a,
    ]);
    const z = fromHex(g.z_hex);
    const h = fromHex(g.h_hex);
    const flipped = S.slice();
    flipped[15]! ^= 0x01;
    const hSub = fromHex(g.substitutions.find((s: J) => s.field === "epkA").h_hex);
    const keyOf = (name: string) => g.must_not_open.find((m: J) => m.name === name).key_hex;
    expect(keyOf("K from Z only (the v1 derivation, no S): payload")).toBe(
      hex(await hkdfBits(z, h, "sixkey/v1/enroll-key", 256)),
    );
    expect(keyOf("K from Z only (the v1 derivation, no S): reveal name")).toBe(
      hex(await hkdfBits(z, h, "sixkey/v1/enroll-key", 256)),
    );
    expect(keyOf("K from Z only with the v2 label")).toBe(hex(await hkdfBits(z, h, ENROLL_KEY, 256)));
    for (const n of ["S with one bit flipped: reveal name", "S with one bit flipped: payload"])
      expect(keyOf(n)).toBe(hex(await hkdfBits(new Uint8Array([...z, ...flipped]), h, ENROLL_KEY, 256)));
    expect(keyOf("IKM in the wrong order (S || Z)")).toBe(
      hex(await hkdfBits(new Uint8Array([...S, ...z]), h, ENROLL_KEY, 256)),
    );
    expect(keyOf("K derived without salt h")).toBe(
      hex(await hkdfBits(new Uint8Array([...z, ...S]), EMPTY, ENROLL_KEY, 256)),
    );
    expect(keyOf("K and AAD from a substituted transcript (epk_A)")).toBe(
      hex(await hkdfBits(new Uint8Array([...z, ...S]), hSub, ENROLL_KEY, 256)),
    );
    expect(g.must_not_open.filter((m: J) => /^sixkey-enroll-(payload|name)\|1\|/.test(m.aad)).length).toBe(2);
    for (const m of g.must_not_open) {
      const w = fromB64(m.wire_b64);
      expect(await gcmOpens(fromHex(m.key_hex), w.slice(0, 12), w.slice(12), m.aad), m.name).toBe(false);
    }
  });
  it("one-field substitutions, the two-session MITM and the pinned-commitment checks", async () => {
    const bytesFields = new Set(["dpkN", "epkN", "epkA", "nN"]);
    for (const s of g.substitutions) {
      const t2 = { ...tr, [s.field]: bytesFields.has(s.field) ? fromB64u(s.value_b64u) : s.value_b64u } as Tr;
      expect(transcriptOf(t2), s.field).toBe(s.transcript);
      const h2 = await sha256(utf8(s.transcript));
      expect(hex(h2)).toBe(s.h_hex);
      expect(s.h_hex).not.toBe(g.h_hex);
      expect((await sixDigits(SAS_TAG, h2))[1]).toBe(s.sas);
      expect(s.sas).not.toBe(g.sas);
      expect(s.cc).toBeUndefined();
    }
    const sub = Object.fromEntries(g.substitutions.map((s: J) => [s.field, s.value_b64u]));
    const m = g.mitm;
    const h1 = await sha256(utf8(transcriptOf({ ...tr, epkA: fromB64u(sub.epkA) })));
    const h2 = await sha256(utf8(transcriptOf({ ...tr, epkN: fromB64u(sub.epkN), nN: fromB64u(sub.nN) })));
    expect([hex(h1), hex(h2)]).toEqual([m.h1_hex, m.h2_hex]);
    expect(toB64(await commitOf(i.dev_n, tr.dpkN, fromB64u(sub.epkN), fromB64u(sub.nN)))).toBe(
      m.commit_substituted_b64,
    );
    expect([(await sixDigits(SAS_TAG, h1))[1], (await sixDigits(SAS_TAG, h2))[1]]).toEqual([
      m.sas_shown_by_N,
      m.sas_expected_by_A,
    ]);
    expect(m.sas_shown_by_N).not.toBe(m.sas_expected_by_A);
    expect([m.cc_expected_by_N, m.cc_shown_by_A]).toEqual([undefined, undefined]);
    for (const c of g.commit_checks) {
      const opens =
        toB64(await commitOf(c.dev_n, fromB64(c.dpk_n_b64), fromB64(c.epk_n_b64), fromB64(c.nonce_b64))) ===
        g.commit_b64;
      expect(opens, c.name).toBe(c.opens_pinned_commit);
    }
  });
  it("SAS edge cases: leading zeros, high bit, top byte zero", async () => {
    for (const c of G.sas.cases) {
      const h = fromHex(c.h_hex);
      expect(await sixDigits(SAS_TAG, h), c.name).toEqual([c.sas_u32, c.sas]);
      expect(c.cc, c.name).toBeUndefined();
    }
  });
  it("the pairing code: formatting, the reading (case, spaces, '-', O/I/L), wrong length, bad check bits, a recovery code", async () => {
    const p = G.pairing_code;
    for (const c of p.cases) {
      const secret = fromHex(c.secret_hex);
      expect([await codeOf(secret, PAIRING_TAG), await check12(PAIRING_TAG, secret)], c.name).toEqual([
        c.code,
        c.check_bits,
      ]);
    }
    expect(p.code).toBe(i.pairing_code);
    for (const x of p.equivalent_inputs)
      expect(hex(await readCode(x, PAIRING_TAG, "pairing")), JSON.stringify(x)).toBe(i.pairing_secret_hex);
    for (const r of p.rejected_inputs)
      await expect(readCode(r.input, PAIRING_TAG, "pairing"), r.why).rejects.toMatchObject({ code: r.error });
    expect(p.rejected_inputs.some((r: J) => r.input === G.recovery_auth.code && r.error === "pairing_checksum")).toBe(
      true,
    );
    expect(new Set(p.rejected_inputs.map((r: J) => r.error))).toEqual(
      new Set(["pairing_checksum", "pairing_length", "pairing_char"]),
    );
  });
});

function signingInput(c: J): string {
  for (const k of ["host", "method", "target", "signer", "sub"])
    if (String(c[k]).includes("|")) throw new Error(`'|' in ${k}`);
  if (!c.target.startsWith("/")) throw new Error("target must start with /");
  if (!/^[A-Z]+$/.test(c.method)) throw new Error("method must be uppercase");
  if (!/^[0-9]+$/.test(String(c.ts))) throw new Error("ts must be decimal");
  return `sixkey-req|1|${c.host}|${c.method}|${c.target}|${c.signer}|${c.sub}|${c.ts}|${c.body_sha256_b64u}`;
}
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const big = (b: Uint8Array) => BigInt(`0x${hex(b) || "0"}`);
function p1363Ok(sig: Uint8Array): boolean {
  if (sig.length !== 64) return false;
  const r = big(sig.slice(0, 32));
  const s = big(sig.slice(32));
  return r > 0n && r < N && s > 0n && s < N;
}
function derInt(b: Uint8Array): number[] {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  const v = [...b.slice(i)];
  if (v[0]! & 0x80) v.unshift(0);
  return [0x02, v.length, ...v];
}
const p1363ToDer = (sig: Uint8Array) => {
  const body = [...derInt(sig.slice(0, 32)), ...derInt(sig.slice(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
};
async function verifySig(spkiB64: string, sig: Uint8Array, input: string): Promise<boolean> {
  const key = await subtle.importKey("spki", bs(fromB64(spkiB64)), { name: "ECDSA", namedCurve: "P-256" }, false, [
    "verify",
  ]);
  return subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bs(sig), bs(utf8(input)));
}

/** §2.3, §5.4 (§0.0d N20): every number token is an integer literal with |n| <= 2^53 - 1, checked on the raw text. */
function integerTokensOnly(text: string): boolean {
  const num = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
  let inStr = false;
  for (let i = 0; i < text.length;) {
    const c = text[i]!;
    if (inStr) {
      if (c === "\\") i += 2;
      else {
        if (c === '"') inStr = false;
        i++;
      }
    } else if (c === '"') {
      inStr = true;
      i++;
    } else if (c === "-" || (c >= "0" && c <= "9")) {
      num.lastIndex = i;
      const m = num.exec(text);
      if (!m || m[1] || m[2]) return false;
      const v = BigInt(m[0]);
      if (v > 9007199254740991n || v < -9007199254740991n) return false;
      i += m[0].length;
    } else i++;
  }
  return true;
}

describe("contract vectors: number tokens (§2.3, §5.4)", () => {
  it("only integer literals within the safe range pass; JSON.parse alone would hide 3.0, 1.7920512e12 and 6e5", () => {
    const base = canonicalJson(JSON.parse(G.number_tokens.cases[0].text));
    for (const c of G.number_tokens.cases) {
      expect(integerTokensOnly(c.text), c.name).toBe(c.integer_only);
      if ("same_value_after_json_parse" in c)
        expect(canonicalJson(JSON.parse(c.text)) === base, c.name).toBe(c.same_value_after_json_parse);
    }
  });
});

describe("contract vectors: request signatures (§5.2)", () => {
  const g = G.request_signature;
  it("signing input, body hash, P1363 signature and its DER form", async () => {
    expect(b64u(await sha256(EMPTY))).toBe(g.empty_body_sha256_b64u);
    for (const c of g.cases) {
      expect(b64u(await sha256(utf8(c.body))), c.name).toBe(c.body_sha256_b64u);
      expect(signingInput(c), c.name).toBe(c.signing_input);
      const sig = fromB64u(c.sig_p1363_b64u);
      expect(await verifySig(c.signer_key_spki_b64, sig, c.signing_input), c.name).toBe(true);
      expect(hex(p1363ToDer(sig))).toBe(c.sig_der_hex);
    }
  });
  it("verification negatives, signature format rejects, conversion cases, malformed inputs", async () => {
    for (const v of g.verify)
      expect(await verifySig(v.key_spki_b64, fromB64u(v.sig_p1363_b64u), v.signing_input), v.name).toBe(v.valid);
    for (const f of g.signature_format_reject) expect(p1363Ok(fromB64u(f.sig_b64u)), f.name).toBe(false);
    for (const c of g.p1363_to_der) expect(hex(p1363ToDer(fromHex(c.p1363_hex))), c.name).toBe(c.der_hex);
    for (const r of g.signing_input_reject)
      expect(() => signingInput({ ...r, body_sha256_b64u: g.empty_body_sha256_b64u }), r.name).toThrow();
  });
});

describe("contract vectors: fork with Sixkey-New-Sig (§4.10, §5.2)", () => {
  const g = G.fork_signature;
  it("one signing input, signed by the current DSK and by the new key; both verify", async () => {
    expect(g.old_key_spki_b64).toBe(keyByName("dsk_A").spki_b64);
    expect(g.new_key_spki_b64).toBe(keyByName("dsk_F").spki_b64);
    const body = JSON.parse(g.body);
    expect("new_sig" in body).toBe(false);
    expect([body.new_device_id, body.new_sig_pubkey]).toEqual([g.new_device_id, g.new_key_spki_b64]);
    expect(b64u(await sha256(utf8(g.body)))).toBe(g.body_sha256_b64u);
    expect(signingInput(g)).toBe(g.signing_input);
    expect(await verifySig(g.old_key_spki_b64, fromB64u(g.sixkey_sig_b64u), g.signing_input)).toBe(true);
    expect(await verifySig(body.new_sig_pubkey, fromB64u(g.sixkey_new_sig_b64u), g.signing_input)).toBe(true);
    for (const v of g.verify)
      expect(await verifySig(v.key_spki_b64, fromB64u(v.sig_p1363_b64u), v.signing_input), v.name).toBe(v.valid);
    const kName = await hkdfBits(VK1, EMPTY, "sixkey/v1/device-name", 256);
    expect(
      toB64(
        await gcmEncrypt(kName, fromB64(body.name_ct.iv), fromB64(deviceNameRule(g.name.name).padded_b64), g.name.aad),
      ),
    ).toBe(body.name_ct.ct);
  });
});

describe("contract vectors: repairing the cloud from this device (§4.2, rotate without a VK change)", () => {
  const g = G.rotate_repair;
  it("the rotate body is consistent: VK2 envelope and bundle, K_write of VK1, typed recovery code, both verifiers", async () => {
    const req = g.request;
    const env2 = JSON.parse(req.envelope);
    const b2 = JSON.parse(req.bundle);
    const vk1 = await vkFromRaw(VK1);
    const vk2 = await vkFromRaw(VK2);
    expect(g.server).toEqual({
      version: G.envelope.rev,
      kver: G.keybundle.bundle.kver,
      vk_id: vk1.id,
      head_b64: G.envelope.head_b64,
    });
    expect([env2.vkId, b2.keyring.vkId]).toEqual([vk2.id, vk2.id]);
    expect(env2.vkId).not.toBe(g.server.vk_id);
    expect([req.if_version, env2.rev, req.if_kver, b2.kver]).toEqual([
      g.server.version,
      g.server.version + 1,
      g.server.kver,
      publishKver(g.server.kver, g.device.max_seen_kver),
    ]);
    expect(b2.kver).toBeGreaterThan(req.if_kver);
    expect(new TextDecoder().decode(await decryptVault(env2, vk2))).toBe(g.plaintext);
    expect(g.write_input).toBe(`sixkey-write|1|${V.fixed_inputs.vault_id}|${req.if_version}|${env2.checksum}`);
    expect(toB64(await hmac(await hkdfBits(VK1, EMPTY, "sixkey/v1/vault-write", 256), utf8(g.write_input)))).toBe(
      req.write_proof,
    );
    expect(toB64(await hkdfBits(VK2, EMPTY, "sixkey/v1/vault-write", 256))).toBe(req.new_write_key);
    const { mac, ...rest } = b2;
    expect(
      toB64(
        await hmac(
          await hkdfBits(VK2, EMPTY, "sixkey/v1/keybundle-mac", 256),
          utf8(`sixkey-keybundle|1|${canonicalJson(rest)}`),
        ),
      ),
    ).toBe(mac);
    expect(bundleShapeOk(b2)).toBe(true);
    const kr2 = validateKeyring(b2.keyring);
    expect(hex((await unlockWithPassword(kr2, g.password)).raw)).toBe(hex(VK2));
    expect(hex((await unlockWithRecoveryCode(kr2, g.recovery_code2)).raw)).toBe(hex(VK2));
    expect((await unwrapPreviousVks(kr2, vk2)).map((p) => p.id).sort()).toEqual(
      [vk1.id, (await vkFromRaw(VK0)).id].sort(),
    );
    const serverKdf = G.keybundle.bundle.auth.kdf;
    const pwAuth = await hkdfBits(
      await pbkdf2Bits(utf8(normalizePassword(g.password)), fromB64(serverKdf.salt), serverKdf.iterations, 256),
      EMPTY,
      "sixkey/v1/password-auth",
      256,
    );
    expect(toB64(pwAuth)).toBe(req.password_auth);
    const pwAuth2 = await hkdfBits(
      await pbkdf2Bits(utf8(normalizePassword(g.password)), fromB64(b2.auth.kdf.salt), b2.auth.kdf.iterations, 256),
      EMPTY,
      "sixkey/v1/password-auth",
      256,
    );
    expect(toB64(await sha256(utf8("sixkey-password-verifier|1|"), pwAuth2))).toBe(req.password_verifier);
    const secret2 = await parseRecoveryCode(g.recovery_code2);
    expect(hex(secret2)).toBe(g.recovery_secret2_hex);
    expect(
      toB64(
        await sha256(
          utf8("sixkey-recovery-verifier|1|"),
          await hkdfBits(secret2, EMPTY, "sixkey/v1/recovery-auth", 256),
        ),
      ),
    ).toBe(req.recovery_verifier);
    const kName2 = await hkdfBits(VK2, EMPTY, "sixkey/v1/device-name", 256);
    for (const d of req.device_names) {
      expect(d.name_ct.vkId).toBe(vk2.id);
      const aad = `sixkey-devname|1|${V.fixed_inputs.vault_id}|${vk2.id}|${d.device_id}`;
      expect(await gcmOpens(kName2, fromB64(d.name_ct.iv), fromB64(d.name_ct.ct), aad)).toBe(true);
    }
  }, 30_000);
});

const KVER_MAX_JUMP = 65536; // §2.3, §3.9 R0/R1 (§0.0f F-01)
/** §3.9 R1 (§0.0e N27, §0.0f F-01): min(max(server kver, maxSeenKver) + 1, server kver + KVER_MAX_JUMP); unsafe -> kver_overflow. */
function publishKver(serverKver: number, maxSeenKver: number): number {
  const next = Math.min(Math.max(serverKver, maxSeenKver) + 1, serverKver + KVER_MAX_JUMP);
  if (!Number.isSafeInteger(next)) throw new Error("kver_overflow");
  return next;
}
/** §2.3 if_kver < kver <= if_kver + KVER_MAX_JUMP (else 422), then the CAS on if_kver; a failed CAS with identical stored text is 200 (§3.6.0, §5.3). */
function serverAccept(c: J): string {
  if (!(c.kver > c.if_kver && c.kver <= c.if_kver + KVER_MAX_JUMP)) return "422 invalid_request";
  if (c.if_kver !== c.server_kver) return c.raw_equals_stored ? "200 idempotent" : "409 keys_conflict";
  return "200 applied";
}
/** §3.9 R0/R1 (§0.0e N27, §0.0f F-01): beyond maxSeen + KVER_MAX_JUMP counts as <= maxSeen, unless maxSeen is 0. */
function r1Adoption(maxSeen: number, kver: number, same: boolean): J {
  if (kver > maxSeen && (maxSeen === 0 || kver <= maxSeen + KVER_MAX_JUMP))
    return same
      ? { outcome: "in_sync", max_seen_after: kver }
      : { outcome: "adopt_candidate", max_seen_after_adoption: kver };
  return same
    ? { outcome: "in_sync", max_seen_after: maxSeen }
    : { outcome: "keys_behind", max_seen_after: maxSeen, r3_unlock_needs_confirmation: true };
}

describe("contract vectors: kver rules after a rollback (§3.9 R1, §0.0e N27)", () => {
  const g = G.kver_rules;
  it("publish max(server kver, maxSeenKver) + 1; the server takes any kver > if_kver, CAS on if_kver, same text is idempotent", () => {
    expect(g.kver_max_jump).toBe(KVER_MAX_JUMP);
    for (const c of g.publish) {
      if ("error" in c) expect(() => publishKver(c.server_kver, c.max_seen_kver)).toThrow(c.error);
      else expect(publishKver(c.server_kver, c.max_seen_kver)).toBe(c.publish_kver);
    }
    for (const c of g.server_accept) expect(serverAccept(c), c.name).toBe(c.expect);
    expect(g.server_accept.some((c: J) => c.kver === c.if_kver + KVER_MAX_JUMP && c.expect === "200 applied")).toBe(
      true,
    );
    expect(
      g.server_accept.some((c: J) => c.kver === c.if_kver + KVER_MAX_JUMP + 1 && c.expect === "422 invalid_request"),
    ).toBe(true);
  });
  it("R1: adopt only above maxSeenKver; at or below it, same keyring (canonicalJson) is in sync, a different one is keys_behind", () => {
    const repaired = JSON.parse(G.keys_repair.request.bundle);
    const keyrings: Record<string, J> = {
      keybundle: G.keybundle.bundle.keyring,
      keys_repair: repaired.keyring,
      keybundle_reordered: JSON.parse(g.keybundle_reordered_text),
    };
    const kvers: Record<string, number> = { keybundle: G.keybundle.bundle.kver, keys_repair: repaired.kver };
    for (const c of g.adoption) {
      const same = canonicalJson(keyrings[c.bundle]) === canonicalJson(keyrings[c.local_keyring]);
      expect([same, c.facts_only === true ? c.bundle_kver : kvers[c.bundle]], c.name).toEqual([
        c.same_keyring,
        c.bundle_kver,
      ]);
      const {
        name: _n,
        facts_only: _f,
        max_seen_kver: _m,
        bundle: _b,
        bundle_kver: _k,
        local_keyring: _l,
        same_keyring: _s,
        ...want
      } = c;
      expect(r1Adoption(c.max_seen_kver, c.bundle_kver, same), c.name).toEqual(want);
    }
  });
});

describe("contract vectors: P4 consistency (§2.3, §0.0f S-2)", () => {
  /** Which verifiers a key request needs, against the server's bundle; a wrap changed when its iv or wrapped bytes did. */
  function p4(server: J, next: J): J {
    const w = (b: J, m: string) => b.keyring.wraps.find((x: J) => x.method === m);
    const changed = (m: string) =>
      hex(fromB64(w(server, m).iv)) !== hex(fromB64(w(next, m).iv)) ||
      hex(fromB64(w(server, m).wrapped)) !== hex(fromB64(w(next, m).wrapped));
    const authChanged = canonicalJson(server.auth.kdf) !== canonicalJson(next.auth.kdf);
    if (changed("password") !== authChanged) return "422 invalid_request";
    return { recovery_verifier: changed("recovery"), password_verifier: changed("password") };
  }
  it("every P4 case, including two wraps that differ only in createdAt", async () => {
    const kMac = await hkdfBits(VK1, EMPTY, "sixkey/v1/keybundle-mac", 256);
    for (const c of G.keys_repair.p4_cases) {
      const b = JSON.parse(c.bundle);
      const { mac, ...rest } = b;
      expect(toB64(await hmac(kMac, utf8(`sixkey-keybundle|1|${canonicalJson(rest)}`))), c.name).toBe(mac);
      expect(bundleShapeOk(b), c.name).toBe(true);
      expect(p4(G.keybundle.bundle, b), c.name).toEqual(c.expect);
    }
    expect(
      G.keys_repair.p4_cases.some(
        (c: J) =>
          c.name.includes("createdAt") && c.expect.recovery_verifier === false && c.expect.password_verifier === false,
      ),
    ).toBe(true);
  });
});

describe("contract vectors: same-VK repair through PUT /v1/keys (§4.2, §0.0e N27)", () => {
  const g = G.keys_repair;
  it("if_kver = server kver, jumped kver, P4 verifiers, and the keyring opens with Phase 0", async () => {
    const req = g.request;
    const b = JSON.parse(req.bundle);
    const server = G.keybundle.bundle;
    expect(g.server).toEqual({ kver: server.kver, vk_id: server.keyring.vkId });
    expect(b.keyring.vkId).toBe(g.server.vk_id);
    expect([req.if_kver, b.kver]).toEqual([g.server.kver, publishKver(g.server.kver, g.device.max_seen_kver)]);
    expect(
      serverAccept({ server_kver: g.server.kver, if_kver: req.if_kver, kver: b.kver, raw_equals_stored: false }),
    ).toBe("200 applied");
    const { mac, ...rest } = b;
    expect(
      toB64(
        await hmac(
          await hkdfBits(VK1, EMPTY, "sixkey/v1/keybundle-mac", 256),
          utf8(`sixkey-keybundle|1|${canonicalJson(rest)}`),
        ),
      ),
    ).toBe(mac);
    expect(bundleShapeOk(b)).toBe(true);
    const wrap = (k: J, m: string) => k.wraps.find((w: J) => w.method === m);
    expect(canonicalJson(wrap(b.keyring, "recovery"))).not.toBe(canonicalJson(wrap(server.keyring, "recovery")));
    expect(canonicalJson(wrap(b.keyring, "password"))).not.toBe(canonicalJson(wrap(server.keyring, "password")));
    expect(canonicalJson(b.auth.kdf)).not.toBe(canonicalJson(server.auth.kdf));
    const kr = validateKeyring(b.keyring);
    expect(hex((await unlockWithPassword(kr, g.password)).raw)).toBe(hex(VK1));
    expect(hex((await unlockWithRecoveryCode(kr, g.recovery_code3)).raw)).toBe(hex(VK1));
    const pwAuth = await hkdfBits(
      await pbkdf2Bits(
        utf8(normalizePassword(g.password)),
        fromB64(server.auth.kdf.salt),
        server.auth.kdf.iterations,
        256,
      ),
      EMPTY,
      "sixkey/v1/password-auth",
      256,
    );
    expect(toB64(pwAuth)).toBe(req.password_auth);
    const pwAuth3 = await hkdfBits(
      await pbkdf2Bits(utf8(normalizePassword(g.password)), fromB64(b.auth.kdf.salt), b.auth.kdf.iterations, 256),
      EMPTY,
      "sixkey/v1/password-auth",
      256,
    );
    expect(toB64(await sha256(utf8("sixkey-password-verifier|1|"), pwAuth3))).toBe(req.password_verifier);
    const secret3 = await parseRecoveryCode(g.recovery_code3);
    expect(
      toB64(
        await sha256(
          utf8("sixkey-recovery-verifier|1|"),
          await hkdfBits(secret3, EMPTY, "sixkey/v1/recovery-auth", 256),
        ),
      ),
    ).toBe(req.recovery_verifier);
  }, 30_000);
});
