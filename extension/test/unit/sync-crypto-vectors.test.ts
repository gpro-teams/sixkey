// M1 conformance: the production functions of core/sync/crypto reproduce every shared vector (contract/vectors/
// sync-v1.json) byte for byte and refuse every negative one. contract-vectors.test.ts checks the same file with test-local
// helpers; this file only calls shipped code (plus node:crypto to read keys that production holds non-extractable).
import { describe, expect, it } from "vitest";
import { createDecipheriv, createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { CryptoError, fromB64, sha256, toB64, utf8 } from "../../src/core/crypto/bytes";
import { formatPairingCode, parsePairingCode } from "../../src/core/crypto/pairing-code";
import { formatRecoveryCode, parseRecoveryCode } from "../../src/core/crypto/recovery-code";
import { encryptVault } from "../../src/core/crypto/envelope";
import { hkdfAesKey } from "../../src/core/crypto/kdf";
import type { Keyring } from "../../src/core/crypto/keyring";
import { decideRemoteUnlock } from "../../src/core/sync/crypto/adoption";
import { classifyKver } from "../../src/core/sync/crypto/adoption";
import { passwordProof, recoveryProof, recoveryProofFromSecret } from "../../src/core/sync/crypto/auth-proofs";
import { evaluateSameVkBundle, openKeyring, unwrappedPreviousIds } from "../../src/core/sync/crypto/bundle-eval";
import { openDeviceBackup, sealDeviceBackup } from "../../src/core/sync/crypto/device-backup";
import {
  importDeviceKey,
  importDpk,
  importEpk,
  isSpkiP256,
  isUncompressedPoint,
} from "../../src/core/sync/crypto/device-key";
import {
  checkDeviceName,
  openDeviceName,
  padDeviceName,
  sealDeviceName,
  unpadDeviceName,
} from "../../src/core/sync/crypto/device-name";
import { ApproverEnrollment } from "../../src/core/sync/crypto/enroll-approver";
import {
  commitInput,
  commitment,
  enrollKey,
  openPayload,
  openRevealName,
  sasOf,
  sealPayload,
  sealRevealName,
  sharedSecret,
  shortCode,
  transcript,
  transcriptHash,
  type TranscriptParts,
} from "../../src/core/sync/crypto/enroll-crypto";
import { ENROLL_LABEL, ENROLL_TAG as ETAG } from "../../src/core/sync/crypto/enroll-labels";
import { NewDeviceEnrollment } from "../../src/core/sync/crypto/enroll-new-device";
import {
  b64,
  canonicalJsonStrict,
  floorToHour,
  floorToUnit,
  fromB64u,
  integerTokensOnly,
  isHourAligned,
  parseIntegerJson,
  toB64u,
} from "../../src/core/sync/crypto/encoding";
import { SYNC_CONSTANTS } from "../../src/core/sync/crypto/constants";
import { SyncCryptoError } from "../../src/core/sync/crypto/errors";
import {
  bundleHasUnknownFields,
  bundleMacInput,
  checkBundleShape,
  parseBundleText,
  publishKver,
  requiredVerifiers,
  sameKeyring,
  sealBundle,
  verifyBundleMac,
} from "../../src/core/sync/crypto/keybundle";
import { LABEL, TAG } from "../../src/core/sync/crypto/labels";
import {
  envelopeHead,
  envelopeSizeBytes,
  envelopeText,
  fitsEnvelopeLimit,
  padPlaintext,
  paddedLength,
} from "../../src/core/sync/crypto/padding";
import { preSendCheck } from "../../src/core/sync/crypto/presend";
import {
  bodyHash,
  p1363InRange,
  signForkRequest,
  signRequest,
  signingInput,
  verifyInput,
  type Signer,
} from "../../src/core/sync/crypto/signature";
import {
  bundleMacKey,
  deviceBackupKey,
  deviceNameKey,
  writeKey,
  writeProof,
  writeProofInput,
} from "../../src/core/sync/crypto/subkeys";
import { fromHex, hex, type J } from "../helpers/contract";
import {
  F,
  G,
  V,
  VK0_RAW,
  VK1_RAW,
  VK2_RAW,
  ephemeralOf,
  fill,
  keyByName,
  privateJwk,
  queueRng,
  spkiOf,
  verifiedFor,
  vk,
  wireExample,
} from "../helpers/sync-vectors";

const VAULT = F.vault_id;
const PHASE0_LABELS = ["sixkey/v1/vk-id", "sixkey/v1/vault-enc", "sixkey/v1/kek-recovery", "sixkey/v1/kek-previous"];
const PHASE0_TAGS = ["sixkey-vault|1|", "sixkey-wrap|1|", "sixkey-prev|1|"];
const bs = (b: Uint8Array): BufferSource => b as BufferSource;
const rejectsWith = async (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code });
const signerOf = (s: string): Signer => (s.startsWith("enroll:") ? { enrollRid: s.slice(7) } : { deviceId: s });

/** Decrypt with node:crypto under a key given as hex: reads keys that production derives non-extractable. */
function nodeOpen(keyHex: string, iv: Uint8Array, ctTag: Uint8Array, aad: string): Buffer {
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), Buffer.from(iv));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(ctTag.subarray(ctTag.length - 16)));
  return Buffer.concat([d.update(Buffer.from(ctTag.subarray(0, ctTag.length - 16))), d.final()]);
}

describe("M1 vectors: labels", () => {
  const g = G.labels;
  it("the 6 sync labels, the enrolment's 1 and the 4 Phase 0 ones are exactly the doc's 11 HKDF labels (all except Phase 0 kek-device)", () => {
    const ours = [...Object.values(LABEL), ...Object.values(ENROLL_LABEL), ...PHASE0_LABELS];
    expect(ours.length).toBe(11);
    expect(new Set(ours)).toEqual(
      new Set(g.hkdf_info.map((l: J) => l.label).filter((l: string) => l !== "sixkey/v1/kek-device")),
    );
    for (const l of g.hkdf_info) expect(l.bits, l.label).toBe(l.label === "sixkey/v1/vk-id" ? 64 : 256);
  });
  it("the 7 sync tags, the enrolment's 6 and the 3 Phase 0 ones are exactly the 16 domain tags: distinct, prefix-free, and distinct from every label", () => {
    const tags = [...Object.values(TAG), ...Object.values(ETAG), ...PHASE0_TAGS];
    expect(tags.length).toBe(16);
    expect(new Set(tags)).toEqual(new Set(g.domain_tags.map((t: J) => t.tag)));
    const all = [
      ...Object.values(LABEL),
      ...Object.values(ENROLL_LABEL),
      ...PHASE0_LABELS,
      "sixkey/v1/kek-device",
      ...tags,
    ];
    expect(new Set(all).size).toBe(all.length);
    for (const a of tags) for (const b of tags) if (a !== b) expect(b.startsWith(a), `${a} prefixes ${b}`).toBe(false);
  });
  it("every sixkey literal in core/sync/crypto is a listed label or tag (any version), and the Phase 0 ones live in core/crypto", () => {
    const dir = new URL("../../src/core/sync/crypto/", import.meta.url);
    const listed = new Set<string>([...g.hkdf_info.map((l: J) => l.label), ...g.domain_tags.map((t: J) => t.tag)]);
    let n = 0;
    for (const f of readdirSync(dir)) {
      for (const m of readFileSync(new URL(f, dir), "utf8").matchAll(
        /"(sixkey(?:\/v\d+\/|-)[a-z-]+(?:\|\d+\||\|)?)"/g,
      )) {
        if (["sixkey-keybundle", "sixkey-keyring", "sixkey-enroll-payload", "sixkey-vault"].includes(m[1]!)) continue; // format names, not domain tags
        expect(listed.has(m[1]!), `${f}: ${m[1]}`).toBe(true);
        n++;
      }
    }
    expect(n).toBe(19); // 7 labels + 12 tags, each defined once (labels.ts, enroll-labels.ts)
    const p0 = readdirSync(new URL("../../src/core/crypto/", import.meta.url))
      .map((f) => readFileSync(new URL(`../../src/core/crypto/${f}`, import.meta.url), "utf8"))
      .join("\n");
    for (const s of [...PHASE0_LABELS, ...PHASE0_TAGS]) expect(p0.includes(s), s).toBe(true);
    // the pairing code's tag is defined with the code (core/crypto/pairing-code.ts), listed by enroll-labels.ts
    expect([p0.includes(`"${ETAG.pairingCode}"`), listed.has(ETAG.pairingCode)]).toEqual([true, true]);
  });
});

describe("M1 vectors: encodings, time, padding", () => {
  it("base64url: encode, strict decode, and every reject", () => {
    for (const c of G.base64url.encode) {
      expect(toB64u(fromHex(c.hex))).toBe(c.b64u);
      expect(hex(fromB64u(c.b64u))).toBe(c.hex);
    }
    for (const c of G.base64url.decode_reject)
      expect(() => fromB64u(c.input), c.why).toThrow(expect.objectContaining({ code: "bad_encoding" }));
  });
  it("standard base64 keeps the Phase 0 rules, including the accepted non-canonical tail", () => {
    for (const c of G.base64.encode) expect([toB64(fromHex(c.hex)), hex(b64(c.b64))]).toEqual([c.b64, c.hex]);
    for (const c of G.base64.decode_reject) expect(() => b64(c.input), c.why).toThrow(SyncCryptoError);
    for (const c of G.base64.decode_accept_noncanonical) expect(hex(b64(c.input))).toBe(c.hex);
  });
  it("canonicalJson over integer-only JSON", () => {
    for (const c of G.canonical_json.cases)
      expect(canonicalJsonStrict(parseIntegerJson(c.input)), c.name).toBe(c.canonical);
  });
  it("hour truncation (day and minute through the same function) and hour alignment", () => {
    for (const c of G.time_truncation.cases) {
      expect([
        floorToHour(c.ms),
        floorToUnit(c.ms, 86_400_000),
        floorToUnit(c.ms, 60_000),
        isHourAligned(c.ms),
      ]).toEqual([c.hour, c.day, c.minute, c.hour_aligned]);
    }
  });
  it("padding to 16 KiB with spaces", async () => {
    expect(G.padding.bucket_bytes).toBe(16_384);
    for (const c of G.padding.lengths) expect(paddedLength(c.utf8_len)).toBe(c.padded_len);
    for (const c of G.padding.concrete) {
      const padded = padPlaintext(utf8(c.plaintext));
      expect(padded.length).toBe(c.padded_len);
      expect(toB64(await sha256(padded))).toBe(c.padded_sha256_b64);
      expect(JSON.parse(new TextDecoder().decode(padded))).toEqual(JSON.parse(c.plaintext));
    }
  });
  it("number tokens: only safe integer literals pass, on the raw text", () => {
    for (const c of G.number_tokens.cases) {
      expect(integerTokensOnly(c.text), c.name).toBe(c.integer_only);
      if (!c.integer_only)
        expect(() => parseIntegerJson(c.text), c.name).toThrow(expect.objectContaining({ code: "non_integer_number" }));
      if (c.text.includes("sixkey-keybundle")) {
        if (c.integer_only) expect(() => parseBundleText(c.text)).not.toThrow();
        else
          expect(() => parseBundleText(c.text), c.name).toThrow(
            expect.objectContaining({ code: "non_integer_number" }),
          );
      }
    }
  });
});

describe("M1 vectors: VK subkeys, envelope measures, write proof", () => {
  it("each subkey: K_write as bytes; K_mac, K_name, K_devbackup (non-extractable) proven equal through use", async () => {
    for (const k of G.vk_subkeys.keys) {
      const v = await vk(fromHex(k.vk_hex));
      expect(v.id).toBe(k.vk_id);
      const sub = (label: string) => k.subkeys.find((s: J) => s.label === label).hex as string;
      expect(hex(b64(await writeKey(v)))).toBe(sub("sixkey/v1/vault-write"));
      const probe = "sixkey M1 subkey probe";
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await bundleMacKey(v), bs(utf8(probe))));
      expect(hex(mac)).toBe(
        createHmac("sha256", Buffer.from(sub("sixkey/v1/keybundle-mac"), "hex"))
          .update(probe)
          .digest("hex"),
      );
      for (const [label, key] of [
        ["sixkey/v1/device-name", await deviceNameKey(v)],
        ["sixkey/v1/device-backup", await deviceBackupKey(v)],
      ] as const) {
        const iv = fill(7, 12);
        const ct = new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: bs(iv), additionalData: bs(utf8("a")) },
            key,
            bs(utf8(probe)),
          ),
        );
        expect(nodeOpen(sub(label), iv, ct, "a").toString(), label).toBe(probe);
      }
    }
  });
  it("WebCrypto hazard: K_write never equals K_enc (labels differ)", async () => {
    const c = G.vk_subkeys.webcrypto_hazard.cases;
    expect(hex(b64(await writeKey(await vk(VK1_RAW))))).toBe(
      c.find((x: J) => x.label === "sixkey/v1/vault-write").derive_bits_256_hex,
    );
    expect(c.find((x: J) => x.label === "sixkey/v1/vault-write").derive_bits_256_hex).not.toBe(
      c.find((x: J) => x.label === "sixkey/v1/vault-enc").derive_bits_256_hex,
    );
  });
  it("envelope text, size and head (the envelope itself is Phase 0 encryptVault)", async () => {
    const g = G.envelope;
    const env = await encryptVault(utf8(g.plaintext), await vk(VK1_RAW), { vaultId: g.vault_id, rev: g.rev }, () =>
      fromB64(g.iv_b64),
    );
    expect(envelopeText(env)).toBe(g.envelope_text);
    expect(envelopeSizeBytes(g.envelope_text)).toBe(utf8(g.envelope_text).length);
    expect(fitsEnvelopeLimit(g.envelope_text)).toBe(true);
    expect(await envelopeHead(g.envelope_text)).toBe(g.head_b64);
    expect(await envelopeHead(g.head_of_reserialized_text.envelope_text)).toBe(g.head_of_reserialized_text.head_b64);
  });
  it("write proof, its input, both write keys, and every verification case", async () => {
    const g = G.write_proof;
    const v1 = await vk(VK1_RAW);
    expect(await writeKey(v1)).toBe(g.write_key_b64);
    expect(await writeKey(await vk(VK2_RAW))).toBe(g.new_write_key_b64_vk2);
    const t = { vaultId: g.vault_id, ifVersion: g.if_version, checksum: g.checksum_b64 };
    expect(writeProofInput(t)).toBe(g.input);
    expect(await writeProof(v1, t)).toBe(g.write_proof_b64);
    for (const c of g.verify)
      expect(
        (await writeProof(v1, { vaultId: c.vault_id, ifVersion: c.if_version, checksum: c.checksum_b64 })) ===
          c.proof_b64,
        c.name,
      ).toBe(c.valid);
    expect(() => writeProofInput({ ...t, vaultId: "a|b" })).toThrow(SyncCryptoError);
    expect(() => writeProofInput({ ...t, checksum: "AA==" })).toThrow(SyncCryptoError);
  });
});

describe("M1 vectors: recovery_auth and pw_auth", () => {
  it("recAuth and its verifier, from the code and every equivalent spelling; typos keep their Phase 0 codes", async () => {
    const g = G.recovery_auth;
    const want = { recoveryAuth: g.recovery_auth_b64, recoveryVerifier: g.recovery_verifier_b64 };
    expect(await recoveryProofFromSecret(fromHex(g.secret_hex))).toEqual(want);
    for (const s of [g.code, ...g.equivalent_inputs]) expect(await recoveryProof(s)).toEqual(want);
    for (const r of g.rejected_inputs) await rejectsWith(recoveryProof(r.input), r.error);
    for (const v of [g.contrast.kek_recovery_hex, g.contrast.recovery_auth_with_wrap_salt_b64])
      expect(v).not.toBe(g.recovery_auth_b64);
    expect(g.contrast.verifier_over_base64_text_b64).not.toBe(g.recovery_verifier_b64);
  });
  it("pw_auth and its verifier for every case; NFKC-equal passwords agree", async () => {
    const g = G.password_auth;
    for (const c of g.cases)
      expect(await passwordProof(c.password, g.kdf), c.name).toEqual({
        passwordAuth: c.password_auth_b64,
        passwordVerifier: c.password_verifier_b64,
      });
  }, 20_000);
  it("KDF parameter bounds: accepted ones pass the bundle check, rejected ones fail it and pw_auth refuses them", async () => {
    const g = G.password_auth.kdf_params;
    const bundle = JSON.parse(G.keybundle.raw);
    for (const p of g.accept) expect(() => checkBundleShape({ ...bundle, auth: { kdf: p } }, "read")).not.toThrow();
    for (const p of g.reject) {
      expect(() => checkBundleShape({ ...bundle, auth: { kdf: p } }, "read"), JSON.stringify(p)).toThrow(
        expect.objectContaining({ code: "invalid_bundle" }),
      );
      await expect(passwordProof("x", p)).rejects.toBeInstanceOf(CryptoError);
    }
  });
});

describe("M1 vectors: KeyBundle", () => {
  const g = G.keybundle;
  it("parse, MAC input, and sealBundle reproduces the raw text and MAC exactly", async () => {
    const b = parseBundleText(g.raw);
    expect(b).toEqual(g.bundle);
    expect(bundleMacInput(b)).toBe(g.mac_input);
    const v1 = await vk(VK1_RAW);
    for (const now of [g.bundle.at, F.now_ms]) {
      const sealed = await sealBundle(v1, {
        vaultId: g.bundle.vaultId,
        kver: g.bundle.kver,
        keyring: g.bundle.keyring,
        auth: g.bundle.auth,
        by: g.bundle.by,
        now,
      });
      expect(sealed.raw).toBe(g.raw);
      expect(sealed.bundle.mac).toBe(g.mac_b64);
    }
    expect(hex(fromHex(g.k_mac_hex))).toBe(
      G.vk_subkeys.keys[0].subkeys.find((s: J) => s.label === "sixkey/v1/keybundle-mac").hex,
    );
  });
  it("every MAC case verifies exactly when the vector says; unknown members are flagged, wherever they are", async () => {
    const v1 = await vk(VK1_RAW);
    for (const c of g.mac_cases) {
      const b = parseBundleText(c.raw);
      expect(await verifyBundleMac(v1, b), c.name).toBe(c.mac_valid);
      expect(bundleHasUnknownFields(b), c.name).toBe(c.name.startsWith("unknown"));
    }
  });
  it("shape cases: upload mode is the server's check (incl. whole hours); read mode lets unaligned times through (N16)", () => {
    for (const c of g.shape_cases) {
      const b = JSON.parse(c.raw);
      expect(() => checkBundleShape(b, "upload"), c.name).toSatisfy((f: () => unknown) => {
        try {
          f();
          return c.shape_valid;
        } catch (e) {
          return !c.shape_valid && e instanceof SyncCryptoError;
        }
      });
      const readOk = c.shape_valid || c.rule.includes("N16");
      if (readOk) expect(() => parseBundleText(c.raw), c.name).not.toThrow();
      else expect(() => parseBundleText(c.raw), c.name).toThrow(SyncCryptoError);
    }
  });
  it("its keyring opens with the password and the code; previous unwraps to VK0", async () => {
    const kr = parseBundleText(g.raw).keyring;
    expect(hex((await openKeyring(kr, { password: g.password }))!.raw)).toBe(hex(VK1_RAW));
    expect(hex((await openKeyring(kr, { recoveryCode: G.recovery_auth.code }))!.raw)).toBe(hex(VK1_RAW));
    expect(await openKeyring(kr, { password: "Sixkey test password 2" })).toBeNull();
    expect([...(await unwrappedPreviousIds(kr, await vk(VK1_RAW)))]).toEqual([(await vk(VK0_RAW)).id]);
  }, 20_000);
});

describe("M1 vectors: device name and device backup", () => {
  it("every rule case: accepted names, their padding and decoding; rejected names with the vector's reason", () => {
    for (const c of G.device_name.cases) {
      const r = checkDeviceName(c.input);
      if (c.valid) {
        expect(r, c.name).toEqual({ ok: true, name: c.normalized });
        const padded = padDeviceName(c.input);
        expect(toB64(padded), c.name).toBe(c.padded_b64);
        expect(unpadDeviceName(padded)).toBe(c.decoded);
        expect([[...c.normalized].length, c.normalized.length, utf8(c.normalized).length]).toEqual([
          c.code_points,
          c.utf16_units,
          c.utf8_len,
        ]);
      } else {
        expect(r, c.name).toEqual({ ok: false, problem: c.reason });
        expect(() => padDeviceName(c.input), c.name).toThrow(expect.objectContaining({ code: "invalid_device_name" }));
      }
    }
  });
  it("name_ct under K_name reproduces both cases and opens back", async () => {
    const e = G.device_name.encrypt;
    const v1 = await vk(VK1_RAW);
    for (const c of e.cases) {
      const owner = { vaultId: VAULT, deviceId: c.device_id };
      expect(c.aad).toBe(`${TAG.devname}${VAULT}|${v1.id}|${c.device_id}`);
      expect(await sealDeviceName(v1, owner, c.name, queueRng(fromB64(c.name_ct.iv)))).toEqual(c.name_ct);
      expect(await openDeviceName(v1, owner, c.name_ct)).toBe(c.name);
    }
  });
  it("name_ct must not open: other device, other vault, other vkId, other VK, other tag, flipped byte", async () => {
    const e = G.device_name.encrypt;
    const v1 = await vk(VK1_RAW);
    const v2 = await vk(VK2_RAW);
    const ct0 = e.cases[0].name_ct;
    for (const m of e.must_not_open) {
      // the production key with the case's exact AAD
      const key = await deviceNameKey(m.key === "VK1" ? v1 : v2);
      await expect(
        crypto.subtle.decrypt(
          { name: "AES-GCM", iv: bs(fromB64(m.iv_b64)), additionalData: bs(utf8(m.aad)) },
          key,
          bs(fromB64(m.ct_b64)),
        ),
        m.name,
      ).rejects.toBeDefined();
    }
    await rejectsWith(openDeviceName(v1, { vaultId: VAULT, deviceId: F.dev_a }, ct0), "decrypt_failed");
    await rejectsWith(openDeviceName(v1, { vaultId: "test-vault-0002", deviceId: F.dev_n }, ct0), "decrypt_failed");
    await rejectsWith(openDeviceName(v2, { vaultId: VAULT, deviceId: F.dev_n }, ct0), "decrypt_failed");
    await rejectsWith(
      openDeviceName(v2, { vaultId: VAULT, deviceId: F.dev_n }, { ...ct0, vkId: v2.id }),
      "decrypt_failed",
    );
    await rejectsWith(
      openDeviceName(
        v1,
        { vaultId: VAULT, deviceId: F.dev_n },
        { ...ct0, ct: e.must_not_open.find((m: J) => m.name === "ciphertext byte flipped").ct_b64 },
      ),
      "decrypt_failed",
    );
    await rejectsWith(openDeviceBackup(v1, { vaultId: VAULT, deviceId: F.dev_n }, ct0), "decrypt_failed");
  });
  it("sk_sync_cfg.enc under K_devbackup reproduces and opens back", async () => {
    const g = G.device_backup;
    const v1 = await vk(VK1_RAW);
    const owner = { vaultId: VAULT, deviceId: g.device_id };
    expect(g.aad).toBe(`${TAG.devkey}${VAULT}|${v1.id}|${g.device_id}`);
    const plain = JSON.parse(g.plaintext);
    expect(await sealDeviceBackup(v1, owner, plain, queueRng(fromB64(g.enc.iv)))).toEqual(g.enc);
    expect(
      await sealDeviceBackup(
        v1,
        owner,
        { ...plain, dsk: { ...plain.dsk, ext: true, key_ops: ["sign"] } },
        queueRng(fromB64(g.enc.iv)),
      ),
    ).toEqual(g.enc);
    expect(await openDeviceBackup(v1, owner, g.enc)).toEqual(plain);
    await rejectsWith(openDeviceBackup(v1, { ...owner, deviceId: F.dev_a }, g.enc), "decrypt_failed");
  });
});

describe("M1 vectors: public keys", () => {
  it("every fixed key imports as dpk (SPKI) and epk (point); the private JWKs sign what their SPKI verifies", async () => {
    for (const k of G.public_keys.keys) {
      expect(isSpkiP256(fromB64(k.spki_b64)) && isUncompressedPoint(fromB64(k.point_b64))).toBe(true);
      await importDpk(fromB64(k.spki_b64));
      await importEpk(fromB64(k.point_b64));
      expect(hex(fromB64(k.spki_b64)).startsWith(G.public_keys.spki_p256_prefix_hex)).toBe(true);
      const sig = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          await importDeviceKey(privateJwk(k.name)),
          bs(utf8("probe")),
        ),
      );
      expect(await verifyInput(fromB64(k.spki_b64), toB64u(sig), "probe"), k.name).toBe(true);
    }
  });
  it("every malformed epk and dpk is refused", async () => {
    for (const r of G.public_keys.epk_reject) await rejectsWith(importEpk(fromB64(r.b64)), "invalid_key");
    for (const r of G.public_keys.dpk_reject) await rejectsWith(importDpk(fromB64(r.b64)), "invalid_key");
  });
});

describe("M1 vectors: enrollment (§3.2; enrolment v2, revision 27)", () => {
  const g = G.enrollment;
  const i = g.inputs;
  const parts: TranscriptParts = {
    rid: i.rid,
    devN: i.dev_n,
    devA: i.dev_a,
    dpkN: fromB64(i.dpk_n_spki_b64),
    epkN: fromB64(i.epk_n_b64),
    epkA: fromB64(i.epk_a_b64),
    nN: fromB64(i.n_n_b64),
  };
  const S = () => fromHex(i.pairing_secret_hex);
  const NAME = "Chrome 配置文件";
  const pendingView = {
    state: "pending",
    new_device_id: i.dev_n,
    new_sig_pubkey: i.dpk_n_spki_b64,
    commit: g.commit_b64,
  };

  it("both state machines, driven with the vector keys, S, nonce and IVs, produce every wire byte", async () => {
    const { machine: n, request } = await NewDeviceEnrollment.start(
      { deviceId: i.dev_n, dpk: parts.dpkN, name: NAME },
      { ephemeral: await ephemeralOf("esk_N"), rng: queueRng(parts.nN, fromB64(g.reveal_name.iv_b64)) },
    );
    expect(request).toEqual(wireExample("POST /v1/enroll/requests", "request").body);
    n.requestCreated(i.rid);
    const { machine: a, respond } = await ApproverEnrollment.start(
      { approverId: i.dev_a, rid: i.rid, request: pendingView, verified: await verifiedFor("respond") },
      {
        ephemeral: await ephemeralOf("esk_A"),
        rng: queueRng(fromB64(g.payload.iv_b64), fill(0x21, 12)),
        pairingSecret: S(),
      },
    );
    const { password_auth: _r, ...respondWire } = wireExample("POST /v1/enroll/requests/{rid}/respond", "request").body;
    expect(respond).toEqual(respondWire);
    expect(() => a.pairingCode).toThrow(expect.objectContaining({ code: "enroll_state" })); // not before respond's 200
    expect(a.respondAccepted()).toEqual({ kind: "show_code", code: i.pairing_code });
    expect(await a.onPoll(pendingView)).toEqual({ kind: "wait" });
    expect(await n.onPoll({ state: "pending" })).toEqual({ kind: "wait" });
    expect(await n.onPoll({ state: "responded", approver_device_id: i.dev_a, approver_epk: respond.epk })).toEqual({
      kind: "enter_code",
    });
    const reveal = await n.submitPairingCode(i.pairing_code.toLowerCase().replace(/-/g, " "));
    expect(reveal).toEqual({
      kind: "reveal",
      body: wireExample("POST /v1/enroll/requests/{rid}/reveal", "request").body,
      sas: g.sas,
    });
    if (reveal.kind !== "reveal") throw new Error("unreachable");
    const view = G.wire_examples.examples.find(
      (e: J) => e.operation === "GET /v1/enroll/requests/{rid}" && e.body.state === "revealed",
    ).body;
    expect(await a.onPoll(view)).toEqual({ kind: "enter_sas", claimedName: NAME });
    expect(() => a.pairingCode).toThrow(expect.objectContaining({ code: "enroll_state" })); // gone at the reveal
    expect(await a.submitSas(g.sas.slice(0, 3) + " " + g.sas.slice(3))).toEqual({ kind: "matched" });
    const built = await a.buildApproval({ verified: await verifiedFor("approve"), now: F.now_ms });
    const { password_auth: _p, ...approveWire } = wireExample("POST /v1/enroll/requests/{rid}/approve", "request").body;
    expect(built).toEqual({ kind: "approve", body: approveWire });
    if (built.kind !== "approve") throw new Error("unreachable");
    expect(await a.approveAccepted()).toEqual({ kind: "approved" });
    const approvedView = G.wire_examples.examples.find(
      (e: J) => e.operation === "GET /v1/enroll/requests/{rid}" && e.body.state === "approved",
    ).body;
    const done = await n.onPoll(approvedView);
    expect(done.kind).toBe("accepted");
    if (done.kind !== "accepted") throw new Error("unreachable");
    expect([hex(done.keys.vk.raw), done.keys.bundleRaw, done.keys.approver, done.keys.at, done.keys.vaultId]).toEqual([
      hex(VK1_RAW),
      G.keybundle.raw,
      i.dev_a,
      F.now_ms,
      VAULT,
    ]);
    expect(n.phase).toBe("accepted");
    expect(a.phase).toBe("approved");
  });

  it("primitives: commitment, transcript, h, Z from both sides, the pairing code, K_enroll over Z || S, SAS, sig_pubkey_sha256", async () => {
    expect(commitInput(i.dev_n, parts.dpkN, parts.epkN, parts.nN)).toBe(g.commit_input);
    expect(toB64(await commitment(i.dev_n, parts.dpkN, parts.epkN, parts.nN))).toBe(g.commit_b64);
    expect(transcript(parts)).toBe(g.transcript);
    const h = await transcriptHash(parts);
    expect([hex(h), toB64(h), toB64u(h)]).toEqual([g.h_hex, g.h_b64, g.h_b64u]);
    const zN = await sharedSecret((await ephemeralOf("esk_N")).privateKey, await importEpk(parts.epkA));
    const zA = await sharedSecret((await ephemeralOf("esk_A")).privateKey, await importEpk(parts.epkN));
    expect([hex(zN), hex(zA)]).toEqual([g.z_hex, g.z_hex]);
    expect(hex(zN) + i.pairing_secret_hex).toBe(i.ikm_hex);
    expect(await formatPairingCode(S())).toBe(i.pairing_code);
    expect(hex(await parsePairingCode(i.pairing_code))).toBe(i.pairing_secret_hex);
    const s = S();
    const k = await enrollKey(zN, s, h);
    expect([hex(zN), hex(s)]).toEqual(["00".repeat(32), "00".repeat(16)]); // Z and S are wiped once K exists
    expect(await sealPayload(k, h, g.payload.plaintext, queueRng(fromB64(g.payload.iv_b64)))).toBe(g.payload.wire_b64);
    expect(await sealRevealName(k, h, NAME, queueRng(fromB64(g.reveal_name.iv_b64)))).toBe(g.reveal_name.wire_b64);
    expect(
      nodeOpen(
        g.k_enroll_hex,
        fromB64(g.payload.wire_b64).subarray(0, 12),
        fromB64(g.payload.wire_b64).subarray(12),
        g.payload.aad,
      ).toString(),
    ).toBe(g.payload.plaintext);
    expect(await openPayload(k, h, g.payload.wire_b64)).toBe(g.payload.plaintext);
    expect(await openRevealName(k, h, g.reveal_name.wire_b64)).toBe(NAME);
    expect([fromB64(g.reveal_name.wire_b64).length, toB64(padDeviceName(NAME))]).toEqual([
      g.reveal_name.wire_bytes,
      g.reveal_name.plaintext_padded_b64,
    ]);
    expect(await sasOf(h)).toBe(g.sas);
    expect(Number(await shortCode(ETAG.sas, h, 2 ** 32))).toBe(g.sas_u32);
    expect(toB64(await sha256(parts.dpkN))).toBe(g.sig_pubkey_sha256_b64);
    expect(g.cc).toBeUndefined(); // revision 27: no confirmation code
    expect(JSON.parse(g.payload.plaintext).v).toBe(2);
    expect([g.reveal_name.aad, g.payload.aad]).toEqual([
      `${ETAG.enrollName}${g.h_b64u}`,
      `${ETAG.enrollPayload}${g.h_b64u}`,
    ]);
  });

  it("label_swap: the check bits are domain-separated; a recovery code is no pairing code and the other way round", async () => {
    const l = g.label_swap;
    expect(await formatPairingCode(fromHex(l.secret_hex))).toBe(l.as_pairing_code);
    expect(await formatRecoveryCode(fromHex(l.secret_hex))).toBe(l.as_recovery_code);
    expect(l.as_pairing_code).not.toBe(l.as_recovery_code);
    await expect(parsePairingCode(l.as_recovery_code)).rejects.toMatchObject({ code: l.recovery_code_as_pairing_code });
    await expect(parseRecoveryCode(l.as_pairing_code)).rejects.toMatchObject({ code: l.pairing_code_as_recovery_code });
  });

  it("one-field substitutions and the two-session MITM, through the production transcript and SAS", async () => {
    const bytesField = new Set(["dpkN", "epkN", "epkA", "nN"]);
    for (const s of g.substitutions) {
      const t = {
        ...parts,
        [s.field]: bytesField.has(s.field) ? fromB64u(s.value_b64u) : s.value_b64u,
      } as TranscriptParts;
      expect(transcript(t), s.field).toBe(s.transcript);
      const h = await transcriptHash(t);
      expect([hex(h), await sasOf(h)]).toEqual([s.h_hex, s.sas]);
      expect(s.cc).toBeUndefined();
    }
    const sub = Object.fromEntries(g.substitutions.map((s: J) => [s.field, fromB64u(s.value_b64u)]));
    const m = g.mitm;
    const h1 = await transcriptHash({ ...parts, epkA: sub.epkA! });
    const h2 = await transcriptHash({ ...parts, epkN: sub.epkN!, nN: sub.nN! });
    expect([hex(h1), hex(h2)]).toEqual([m.h1_hex, m.h2_hex]);
    expect(toB64(await commitment(i.dev_n, parts.dpkN, sub.epkN!, sub.nN!))).toBe(m.commit_substituted_b64);
    expect([await sasOf(h1), await sasOf(h2)]).toEqual([m.sas_shown_by_N, m.sas_expected_by_A]);
    expect(Object.keys(m).sort()).toEqual(
      ["commit_substituted_b64", "h1_hex", "h2_hex", "note", "sas_expected_by_A", "sas_shown_by_N"].sort(),
    );
  });

  it("pinned-commitment checks, through the approver state machine", async () => {
    for (const c of g.commit_checks) {
      expect(
        toB64(await commitment(c.dev_n, fromB64(c.dpk_n_b64), fromB64(c.epk_n_b64), fromB64(c.nonce_b64))) ===
          g.commit_b64,
        c.name,
      ).toBe(c.opens_pinned_commit);
      const { machine: a } = await ApproverEnrollment.start(
        { approverId: i.dev_a, rid: i.rid, request: pendingView, verified: await verifiedFor("respond") },
        { ephemeral: await ephemeralOf("esk_A"), pairingSecret: S() },
      );
      a.respondAccepted();
      const view = {
        state: "revealed",
        new_device_id: c.dev_n,
        new_sig_pubkey: c.dpk_n_b64,
        commit: g.commit_b64,
        new_epk: c.epk_n_b64,
        new_nonce: c.nonce_b64,
        new_name_ct: g.reveal_name.wire_b64,
      };
      const step = await a.onPoll(view);
      const pinnedChanged = c.dev_n !== i.dev_n || c.dpk_n_b64 !== i.dpk_n_spki_b64;
      const want = c.opens_pinned_commit
        ? { kind: "enter_sas", claimedName: NAME }
        : { kind: "failed", reason: pinnedChanged ? "tampered" : "commit_mismatch" };
      expect(step, c.name).toEqual(want);
    }
  });

  it("an approver whose S differs from the one the reveal used ends with pairing_mismatch (the flipped-bit vector)", async () => {
    const flipped = S();
    flipped[15]! ^= 0x01;
    const { machine: a } = await ApproverEnrollment.start(
      { approverId: i.dev_a, rid: i.rid, request: pendingView, verified: await verifiedFor("respond") },
      { ephemeral: await ephemeralOf("esk_A"), pairingSecret: flipped },
    );
    a.respondAccepted();
    const view = G.wire_examples.examples.find(
      (e: J) => e.operation === "GET /v1/enroll/requests/{rid}" && e.body.state === "revealed",
    ).body;
    expect(await a.onPoll(view)).toEqual({ kind: "failed", reason: "pairing_mismatch" });
  });

  it("payload and reveal name must not open under Z only (v1 or v2 label), a flipped S, swapped IKM, swapped or v1 AADs, an unsalted or substituted K, a base64 AAD, or a flipped byte", async () => {
    const h = fromHex(g.h_hex);
    const z = () => fromHex(g.z_hex);
    const flipped = () => {
      const s = S();
      s[15]! ^= 0x01;
      return s;
    };
    const k = await enrollKey(z(), S(), h);
    const hSub = await transcriptHash({
      ...parts,
      epkA: fromB64u(g.substitutions.find((s: J) => s.field === "epkA").value_b64u),
    });
    const keyFor: Record<string, () => Promise<CryptoKey>> = {
      "K from Z only (the v1 derivation, no S): payload": () => hkdfAesKey(z(), h, "sixkey/v1/enroll-key"),
      "K from Z only (the v1 derivation, no S): reveal name": () => hkdfAesKey(z(), h, "sixkey/v1/enroll-key"),
      "K from Z only with the v2 label": () => hkdfAesKey(z(), h, ENROLL_LABEL.enrollKey),
      "S with one bit flipped: reveal name": () => enrollKey(z(), flipped(), h),
      "S with one bit flipped: payload": () => enrollKey(z(), flipped(), h),
      "IKM in the wrong order (S || Z)": () => hkdfAesKey(new Uint8Array([...S(), ...z()]), h, ENROLL_LABEL.enrollKey),
      "K derived without salt h": () =>
        hkdfAesKey(new Uint8Array([...z(), ...S()]), new Uint8Array(0), ENROLL_LABEL.enrollKey),
      "K and AAD from a substituted transcript (epk_A)": () => enrollKey(z(), S(), hSub),
    };
    expect(Object.keys(keyFor).every((n) => g.must_not_open.some((m: J) => m.name === n))).toBe(true);
    for (const m of g.must_not_open) {
      const key = await (keyFor[m.name]?.() ?? Promise.resolve(k));
      const hFor = m.name.startsWith("K and AAD") ? hSub : h;
      const productionAad =
        m.aad === `${ETAG.enrollPayload}${toB64u(hFor)}` || m.aad === `${ETAG.enrollName}${toB64u(hFor)}`;
      if (!productionAad) {
        // an AAD production never builds (standard base64 h, the v1 tags, a swapped tag): decrypt with it directly
        const w = fromB64(m.wire_b64);
        await expect(
          crypto.subtle.decrypt(
            { name: "AES-GCM", iv: bs(w.subarray(0, 12)), additionalData: bs(utf8(m.aad)) },
            key,
            bs(w.subarray(12)),
          ),
          m.name,
        ).rejects.toBeDefined();
        continue;
      }
      const viaPayloadTag = m.aad.startsWith(ETAG.enrollPayload);
      await expect(
        viaPayloadTag ? openPayload(key, hFor, m.wire_b64) : openRevealName(key, hFor, m.wire_b64),
        m.name,
      ).rejects.toMatchObject({ code: "decrypt_failed" });
    }
  });

  it("SAS edge cases: leading zeros, the high bit, a zero top byte", async () => {
    for (const c of G.sas.cases) {
      const h = fromHex(c.h_hex);
      expect([await sasOf(h), Number(await shortCode(ETAG.sas, h, 2 ** 32))], c.name).toEqual([c.sas, c.sas_u32]);
    }
  });

  it("the pairing code group: every case, every equivalent input, every rejected input, through production code", async () => {
    const p = G.pairing_code;
    for (const c of p.cases) {
      expect(await formatPairingCode(fromHex(c.secret_hex)), c.name).toBe(c.code);
      expect(hex(await parsePairingCode(c.code)), c.name).toBe(c.secret_hex);
    }
    for (const x of p.equivalent_inputs)
      expect(hex(await parsePairingCode(x)), JSON.stringify(x)).toBe(i.pairing_secret_hex);
    for (const r of p.rejected_inputs)
      await expect(parsePairingCode(r.input), r.why).rejects.toMatchObject({ code: r.error });
  });
});

describe("M1 vectors: request signatures and fork (§5.2, §4.10)", () => {
  const g = G.request_signature;
  const paramsOf = async (c: J) => ({
    host: c.host,
    method: c.method,
    target: c.target,
    signer: signerOf(c.signer),
    sub: c.sub === "-" ? null : c.sub,
    ts: c.ts,
    bodySha256: await bodyHash(c.body),
  });
  it("body hash and signing input for every case; the vector signature verifies; our own signature verifies", async () => {
    expect(await bodyHash()).toBe(g.empty_body_sha256_b64u);
    expect(await bodyHash(new Uint8Array(0))).toBe(g.empty_body_sha256_b64u);
    for (const c of g.cases) {
      expect(await bodyHash(c.body === "" ? null : c.body), c.name).toBe(c.body_sha256_b64u);
      expect(signingInput(await paramsOf(c)), c.name).toBe(c.signing_input);
      expect(await verifyInput(fromB64(c.signer_key_spki_b64), c.sig_p1363_b64u, c.signing_input), c.name).toBe(true);
      const headers = await signRequest(await importDeviceKey(privateJwk(c.signer_key)), {
        host: c.host,
        method: c.method,
        target: c.target,
        signer: signerOf(c.signer),
        sub: c.sub === "-" ? null : c.sub,
        ts: c.ts,
        body: c.body,
      });
      expect(await verifyInput(fromB64(c.signer_key_spki_b64), headers["Sixkey-Sig"], c.signing_input), c.name).toBe(
        true,
      );
      expect(headers["Sixkey-Ts"]).toBe(String(c.ts));
      if (c.signer.startsWith("enroll:"))
        expect([headers["Sixkey-Enroll"], headers["Sixkey-Device"]]).toEqual([c.signer.slice(7), undefined]);
      else expect([headers["Sixkey-Device"], headers["Sixkey-Enroll"]]).toEqual([c.signer, undefined]);
    }
  });
  it("every verification negative, signature-format reject and malformed signing input is refused", async () => {
    for (const v of g.verify)
      expect(await verifyInput(fromB64(v.key_spki_b64), v.sig_p1363_b64u, v.signing_input), v.name).toBe(v.valid);
    const c0 = g.cases[0];
    for (const f of g.signature_format_reject) {
      expect(p1363InRange(fromB64u(f.sig_b64u)), f.name).toBe(false);
      expect(await verifyInput(fromB64(c0.signer_key_spki_b64), f.sig_b64u, c0.signing_input), f.name).toBe(false);
    }
    for (const r of g.signing_input_reject)
      expect(
        () => signingInput({ ...r, signer: signerOf(r.signer), sub: null, bodySha256: g.empty_body_sha256_b64u }),
        r.name,
      ).toThrow(expect.objectContaining({ code: "invalid_signing_input" }));
  });
  it("fork: one signing input, Sixkey-Sig by the current DSK and Sixkey-New-Sig by the new key", async () => {
    const f = G.fork_signature;
    const body = JSON.parse(f.body);
    expect(
      signingInput({
        host: f.host,
        method: f.method,
        target: f.target,
        signer: { deviceId: f.signer },
        sub: null,
        ts: f.ts,
        bodySha256: await bodyHash(f.body),
      }),
    ).toBe(f.signing_input);
    expect(await verifyInput(fromB64(f.old_key_spki_b64), f.sixkey_sig_b64u, f.signing_input)).toBe(true);
    expect(await verifyInput(fromB64(body.new_sig_pubkey), f.sixkey_new_sig_b64u, f.signing_input)).toBe(true);
    for (const v of f.verify)
      expect(await verifyInput(fromB64(v.key_spki_b64), v.sig_p1363_b64u, v.signing_input), v.name).toBe(v.valid);
    const headers = await signForkRequest(
      await importDeviceKey(privateJwk("dsk_A")),
      await importDeviceKey(privateJwk("dsk_F")),
      { host: f.host, method: f.method, target: f.target, signer: { deviceId: f.signer }, ts: f.ts, body: f.body },
    );
    expect(await verifyInput(spkiOf("dsk_A"), headers["Sixkey-Sig"], f.signing_input)).toBe(true);
    expect(await verifyInput(spkiOf("dsk_F"), headers["Sixkey-New-Sig"]!, f.signing_input)).toBe(true);
    expect(await verifyInput(spkiOf("dsk_A"), headers["Sixkey-New-Sig"]!, f.signing_input)).toBe(false);
    expect(
      await sealDeviceName(
        await vk(VK1_RAW),
        { vaultId: VAULT, deviceId: f.new_device_id },
        f.name.name,
        queueRng(fill(0x24, 12)),
      ),
    ).toEqual(body.name_ct);
    await expect(
      signForkRequest(await importDeviceKey(privateJwk("dsk_A")), await importDeviceKey(privateJwk("dsk_F")), {
        host: f.host,
        method: f.method,
        target: f.target,
        signer: { enrollRid: F.rid },
        ts: f.ts,
      }),
    ).rejects.toMatchObject({ code: "invalid_signing_input" });
  });
});

describe("M1 vectors: repairing the cloud (§4.2) and the kver rules (§3.9 R1, N27)", () => {
  it("rotate repair: every request field comes out of production code, and the pre-send check yields its password_auth", async () => {
    const g = G.rotate_repair;
    const req = g.request;
    const v1 = await vk(VK1_RAW);
    const v2 = await vk(VK2_RAW);
    const b2 = parseBundleText(req.bundle);
    const env2 = await encryptVault(utf8(g.plaintext), v2, { vaultId: VAULT, rev: g.server.version + 1 }, () =>
      fill(0x0f, 12),
    );
    expect(envelopeText(env2)).toBe(req.envelope);
    const t = { vaultId: VAULT, ifVersion: req.if_version, checksum: env2.checksum };
    expect(writeProofInput(t)).toBe(g.write_input);
    expect([await writeProof(v1, t), await writeKey(v2)]).toEqual([req.write_proof, req.new_write_key]);
    expect(publishKver(g.server.kver, g.device.max_seen_kver)).toBe(b2.kver);
    expect(
      (
        await sealBundle(v2, {
          vaultId: VAULT,
          kver: b2.kver,
          keyring: b2.keyring,
          auth: b2.auth,
          by: b2.by,
          now: b2.at,
        })
      ).raw,
    ).toBe(req.bundle);
    expect((await passwordProof(g.password, G.keybundle.bundle.auth.kdf)).passwordAuth).toBe(req.password_auth);
    expect((await passwordProof(g.password, b2.auth.kdf)).passwordVerifier).toBe(req.password_verifier);
    expect((await recoveryProof(g.recovery_code2)).recoveryVerifier).toBe(req.recovery_verifier);
    for (const d of req.device_names) {
      const owner = { vaultId: VAULT, deviceId: d.device_id };
      const name = await openDeviceName(v2, owner, d.name_ct);
      expect(await sealDeviceName(v2, owner, name, queueRng(fromB64(d.name_ct.iv)))).toEqual(d.name_ct);
    }
    const pre = await preSendCheck({
      op: "repair",
      serverRaw: G.keybundle.raw,
      secret: { password: g.password },
      local: b2.keyring,
      vk: v2,
      maxSeenKver: g.device.max_seen_kver,
      expectedVaultId: VAULT,
      adoptedAuth: b2.auth,
      adoptedDigest: null,
    });
    expect(pre).toMatchObject({
      ok: true,
      proof: { password_auth: req.password_auth },
      verified: { keysBehind: true, op: "repair", raw: G.keybundle.raw },
    });
    if (pre.ok) expect(pre.verified.vk.id).toBe(v1.id);
  }, 30_000);

  it("same-VK repair: the bundle, both verifiers, the pre-send check, and R1/R2 verdicts on both bundles", async () => {
    const g = G.keys_repair;
    const req = g.request;
    const v1 = await vk(VK1_RAW);
    const repaired = parseBundleText(req.bundle);
    const server = parseBundleText(G.keybundle.raw);
    expect(req.if_kver).toBe(g.server.kver);
    expect(
      (
        await sealBundle(v1, {
          vaultId: VAULT,
          kver: publishKver(g.server.kver, g.device.max_seen_kver),
          keyring: repaired.keyring,
          auth: repaired.auth,
          by: repaired.by,
          now: repaired.at,
        })
      ).raw,
    ).toBe(req.bundle);
    expect((await passwordProof(g.password, server.auth.kdf)).passwordAuth).toBe(req.password_auth);
    expect((await passwordProof(g.password, repaired.auth.kdf)).passwordVerifier).toBe(req.password_verifier);
    expect((await recoveryProof(g.recovery_code3)).recoveryVerifier).toBe(req.recovery_verifier);
    const base = {
      serverRaw: G.keybundle.raw,
      secret: { password: g.password },
      local: repaired.keyring,
      vk: v1,
      maxSeenKver: g.device.max_seen_kver,
      expectedVaultId: VAULT,
      adoptedAuth: repaired.auth,
      adoptedDigest: null,
    };
    expect(await preSendCheck({ ...base, op: "repair" })).toMatchObject({
      ok: true,
      proof: { password_auth: req.password_auth },
      verified: { keysBehind: true },
    });
    expect(await preSendCheck({ ...base, op: "revoke" })).toMatchObject({
      ok: true,
      proof: { password_auth: req.password_auth },
      verified: { keysBehind: true },
    });
    for (const op of ["change_password", "change_recovery", "rotate", "approve", "respond"] as const)
      expect(await preSendCheck({ ...base, op }), op).toEqual({ ok: false, reason: "keys_behind" });
    const at = { vk: v1, expectedVaultId: VAULT, adoptedDigest: null };
    expect(
      await evaluateSameVkBundle({
        ...at,
        bundle: server,
        local: repaired.keyring,
        maxSeenKver: 6,
        adoptedAuth: repaired.auth,
      }),
    ).toEqual({ kind: "keys_behind", maxSeenKver: 6 });
    expect(
      await evaluateSameVkBundle({
        ...at,
        bundle: repaired,
        local: server.keyring,
        maxSeenKver: 3,
        adoptedAuth: server.auth,
      }),
    ).toEqual({ kind: "needs_new_password", maxSeenKverOnAdoption: 7 });
    expect(
      await evaluateSameVkBundle({
        ...at,
        bundle: repaired,
        local: repaired.keyring,
        maxSeenKver: 6,
        adoptedAuth: repaired.auth,
      }),
    ).toEqual({ kind: "in_sync", maxSeenKver: 7 });
  }, 30_000);

  it("P4: both repair requests carry exactly the verifiers the client-side consistency rule asks for", () => {
    const server = parseBundleText(G.keybundle.raw);
    expect(requiredVerifiers(server, parseBundleText(G.keys_repair.request.bundle))).toEqual({
      recoveryVerifier: true,
      passwordVerifier: true,
    });
    expect(requiredVerifiers(server, parseBundleText(G.rotate_repair.request.bundle))).toEqual({
      recoveryVerifier: true,
      passwordVerifier: true,
    });
    for (const req of [G.keys_repair.request, G.rotate_repair.request])
      expect([typeof req.recovery_verifier, typeof req.password_verifier]).toEqual(["string", "string"]);
    const counter = G.wire_examples.examples.find(
      (e: J) => e.operation === "POST /v1/keys/rotate" && e.expect_valid === false,
    );
    expect(counter.body.recovery_verifier).toBeUndefined(); // the contract's counterexample: a repair without recovery_verifier
    expect(requiredVerifiers(server, server)).toEqual({ recoveryVerifier: false, passwordVerifier: false });
    for (const c of G.keys_repair.p4_cases) {
      const next = parseBundleText(c.bundle);
      if (c.expect === "422 invalid_request")
        expect(() => requiredVerifiers(server, next), c.name).toThrow(
          expect.objectContaining({ code: "invalid_bundle" }),
        );
      else
        expect(requiredVerifiers(server, next), c.name).toEqual({
          recoveryVerifier: c.expect.recovery_verifier,
          passwordVerifier: c.expect.password_verifier,
        });
    }
  });
  it("kver rules: publish values and every R1 adoption case", () => {
    const g = G.kver_rules;
    expect(g.kver_max_jump).toBe(SYNC_CONSTANTS.KVER_MAX_JUMP);
    for (const c of g.publish) {
      if ("error" in c)
        expect(() => publishKver(c.server_kver, c.max_seen_kver), JSON.stringify(c)).toThrow(
          expect.objectContaining({ code: c.error }),
        );
      else expect(publishKver(c.server_kver, c.max_seen_kver), JSON.stringify(c)).toBe(c.publish_kver);
    }
    const repaired = parseBundleText(G.keys_repair.request.bundle);
    const keyrings: Record<string, Keyring> = {
      keybundle: G.keybundle.bundle.keyring,
      keys_repair: repaired.keyring,
      keybundle_reordered: JSON.parse(g.keybundle_reordered_text),
    };
    for (const c of g.adoption) {
      const same = sameKeyring(keyrings[c.bundle]!, keyrings[c.local_keyring]!);
      expect(same, c.name).toBe(c.same_keyring);
      if (c.facts_only !== true)
        expect(c.bundle_kver, c.name).toBe(c.bundle === "keybundle" ? G.keybundle.bundle.kver : repaired.kver);
      const k = classifyKver(c.bundle_kver, c.max_seen_kver, same);
      const got: J = {
        outcome: k.outcome,
        ...(k.outcome === "adopt_candidate"
          ? { max_seen_after_adoption: k.maxSeenAfterAdoption }
          : { max_seen_after: k.maxSeenAfter }),
      };
      if (k.outcome === "keys_behind") {
        const d = decideRemoteUnlock({
          vaultOk: true,
          macValid: true,
          kver: k.outcome,
          confirmedOlder: false,
          vkIsPinned: true,
          reachesPinned: false,
          reachesLocal: true,
          previousCovers: true,
          authOk: true,
        });
        got.r3_unlock_needs_confirmation = d.kind === "confirm_older";
      }
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
      expect(got, c.name).toEqual(want);
    }
  });
});

describe("M1 vectors: wire examples built by production code", () => {
  it("init, PUT /v1/vault, recovery enrollment, rename and fork bodies", async () => {
    const v1 = await vk(VK1_RAW);
    const init = wireExample("POST /v1/vault/init", "request").body;
    expect(init.envelope).toBe(G.envelope.envelope_text);
    expect(init.bundle).toBe(G.keybundle.raw);
    expect(init.write_key).toBe(await writeKey(v1));
    expect(init.recovery_verifier).toBe((await recoveryProof(G.recovery_auth.code)).recoveryVerifier);
    expect(init.password_verifier).toBe(
      (await passwordProof(G.keybundle.password, G.keybundle.bundle.auth.kdf)).passwordVerifier,
    );
    expect(init.device.sig_pubkey).toBe(toB64(spkiOf("dsk_A")));
    expect(
      await sealDeviceName(
        v1,
        { vaultId: VAULT, deviceId: init.device.device_id },
        "Work profile 3",
        queueRng(fromB64(init.device.name_ct.iv)),
      ),
    ).toEqual(init.device.name_ct);
    const put = wireExample("PUT /v1/vault", "request").body;
    expect(
      await writeProof(v1, { vaultId: VAULT, ifVersion: put.if_version, checksum: JSON.parse(put.envelope).checksum }),
    ).toBe(put.write_proof);
    const rec = wireExample("POST /v1/enroll/recovery", "request").body;
    expect(rec.recovery_auth).toBe((await recoveryProof(G.recovery_auth.code)).recoveryAuth);
    const patch = wireExample("PATCH /v1/devices/{id}", "request").body;
    expect(
      await sealDeviceName(
        v1,
        { vaultId: VAULT, deviceId: F.dev_n },
        "Chrome 配置文件",
        queueRng(fromB64(patch.name_ct.iv)),
      ),
    ).toEqual(patch.name_ct);
    for (const op of ["PATCH /v1/devices/{id}", "DELETE /v1/vault/versions", "POST /v1/devices/fork"])
      expect(wireExample(op, "request").body.password_auth).toBe(G.password_auth.cases[0].password_auth_b64);
  }, 20_000);
});

/**
 * Every array in every vector group is accounted for: checked above with production code, or deliberately left to the
 * server (M4) or to Phase 0 code that contract-vectors.test.ts already runs. A new vector array fails this until mapped.
 */
const COVERAGE: Record<string, Record<string, string>> = {
  labels: { hkdf_info: "prod: labels", domain_tags: "prod: labels" },
  base64url: { encode: "prod", decode_reject: "prod" },
  base64: { encode: "prod", decode_reject: "prod", decode_accept_noncanonical: "prod" },
  canonical_json: { cases: "prod" },
  time_truncation: { cases: "prod (day/minute are server-side precisions; floorToUnit covers them)" },
  padding: { lengths: "prod", concrete: "prod" },
  vk_subkeys: {
    keys: "prod: writeKey bytes; K_mac/K_name/K_devbackup via node:crypto; vk-id/vault-enc/kek-previous are Phase 0",
    "keys[].subkeys": "same",
    "webcrypto_hazard.cases": "prod",
  },
  envelope: { must_not_open: "phase0: decryptVault (contract-vectors.test.ts); M1 adds only text/size/head" },
  write_proof: { verify: "prod" },
  recovery_auth: { equivalent_inputs: "prod", rejected_inputs: "prod" },
  password_auth: {
    cases: "prod",
    "kdf_params.accept": "prod: shape check",
    "kdf_params.reject": "prod: shape check + passwordProof",
  },
  keybundle: { mac_cases: "prod", shape_cases: "prod" },
  number_tokens: { cases: "prod" },
  device_name: { cases: "prod", "encrypt.cases": "prod", "encrypt.must_not_open": "prod" },
  device_backup: {},
  public_keys: { keys: "prod", epk_reject: "prod", dpk_reject: "prod" },
  enrollment: { substitutions: "prod", commit_checks: "prod: approver machine", must_not_open: "prod" },
  sas: { cases: "prod" },
  pairing_code: { cases: "prod", equivalent_inputs: "prod", rejected_inputs: "prod" },
  request_signature: {
    cases: "prod",
    verify: "prod",
    signature_format_reject: "prod",
    p1363_to_der: "server-only (M4 wire.py converts P1363 to DER; clients never do)",
    signing_input_reject: "prod",
  },
  fork_signature: { verify: "prod" },
  rotate_repair: { "request.device_names": "prod" },
  keys_repair: { p4_cases: "prod: requiredVerifiers" },
  kver_rules: {
    publish: "prod (incl. kver_overflow)",
    server_accept: "server-only (M4: if_kver < kver <= if_kver + KVER_MAX_JUMP, CAS, idempotent text)",
    adoption: "prod (facts_only cases through the same classifier)",
  },
  wire_examples: {
    examples:
      "prod for the enrollment, init, PUT, recovery, rename and fork bodies; schema-only for responses and counterexamples (contract-vectors.test.ts)",
  },
};

function arrayPaths(node: J, path: string, out: string[], depth: number): void {
  if (Array.isArray(node)) {
    if (node.some((x) => x !== null && typeof x === "object")) {
      out.push(path);
      if (depth < 2)
        for (const x of node)
          if (x && typeof x === "object")
            for (const [k, v] of Object.entries<J>(x)) arrayPaths(v, `${path}[].${k}`, out, depth + 1);
    }
    return;
  }
  if (node && typeof node === "object" && depth < 2)
    for (const [k, v] of Object.entries<J>(node)) arrayPaths(v, path ? `${path}.${k}` : k, out, depth + 1);
}

describe("M1 vectors: coverage", () => {
  it("every vector group and every array of cases in it is mapped to a production check or a stated owner", () => {
    expect(Object.keys(COVERAGE).sort()).toEqual(Object.keys(G).sort());
    for (const [name, group] of Object.entries<J>(G)) {
      const paths: string[] = [];
      arrayPaths(group, "", paths, 0);
      for (const p of [...new Set(paths)]) expect(COVERAGE[name]![p], `${name}.${p} is not mapped`).toBeDefined();
    }
    expect(V.format).toBe("sixkey-contract-vectors");
  });
});
