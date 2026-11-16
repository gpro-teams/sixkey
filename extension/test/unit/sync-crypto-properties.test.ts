// M1 properties (fast-check): round trips, tampering with any byte fails, and domain separation: moving a value to
// another label, tag or AAD field never verifies or opens.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { bs, fromB64, toB64, utf8 } from "../../src/core/crypto/bytes";
import type { Vk } from "../../src/core/crypto/vk";
import { openDeviceBackup, sealDeviceBackup } from "../../src/core/sync/crypto/device-backup";
import {
  generateDeviceKey,
  generateEphemeral,
  importDeviceKey,
  importEpk,
} from "../../src/core/sync/crypto/device-key";
import {
  checkDeviceName,
  openDeviceName,
  padDeviceName,
  sealDeviceName,
  unpadDeviceName,
} from "../../src/core/sync/crypto/device-name";
import {
  enrollKey,
  openPayload,
  openRevealName,
  sealPayload,
  sealRevealName,
  sharedSecret,
} from "../../src/core/sync/crypto/enroll-crypto";
import {
  canonicalJsonStrict,
  floorToHour,
  fromB64u,
  integerTokensOnly,
  parseIntegerJson,
  toB64u,
} from "../../src/core/sync/crypto/encoding";
import {
  bundleMac,
  bundleMacInput,
  parseBundleText,
  verifyBundleMac,
  type KeyBundle,
} from "../../src/core/sync/crypto/keybundle";
import { TAG } from "../../src/core/sync/crypto/labels";
import { paddedLength } from "../../src/core/sync/crypto/padding";
import { bodyHash, signInput, signingInput, verifyInput } from "../../src/core/sync/crypto/signature";
import { bundleMacKey, deviceBackupKey, deviceNameKey, writeProof } from "../../src/core/sync/crypto/subkeys";
import { G, VK1_RAW, VK2_RAW, privateJwk, vk } from "../helpers/sync-vectors";

const bytes = (min: number, max: number) => fc.uint8Array({ minLength: min, maxLength: max });
const flip = (b: Uint8Array, i: number, bit: number) => {
  const c = new Uint8Array(b);
  c[i % c.length]! ^= 1 << (bit % 8);
  return c;
};
const VAULT = "test-vault-0001";
const DEV1 = "EREREREREREREREREREREQ";
const DEV2 = "qqqqqqqqqqqqqqqqqqqqqg";
const RUNS = { numRuns: 60 };

describe("encodings", () => {
  it("base64url round-trips any bytes; any other string either decodes canonically or is refused", () => {
    fc.assert(
      fc.property(
        bytes(0, 80),
        (b) => toB64u(fromB64u(toB64u(b))) === toB64u(b) && fromB64u(toB64u(b)).length === b.length,
      ),
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), (s) => {
        try {
          return toB64u(fromB64u(s)) === s;
        } catch {
          return true;
        }
      }),
    );
  });
  it("integer-only JSON: any JSON of safe integers passes; one fraction or exponent anywhere fails", () => {
    const json = fc.letrec((tie) => ({
      v: fc.oneof(
        { depthSize: "small" },
        fc.maxSafeInteger(),
        fc.string(),
        fc.boolean(),
        fc.constant(null),
        fc.array(tie("v"), { maxLength: 4 }),
        fc.dictionary(fc.string({ maxLength: 4 }), tie("v"), { maxKeys: 4 }),
      ),
    })).v;
    fc.assert(
      fc.property(
        json,
        (v) =>
          integerTokensOnly(JSON.stringify(v)) &&
          canonicalJsonStrict(parseIntegerJson(JSON.stringify(v))) === canonicalJsonStrict(v),
      ),
    );
    fc.assert(
      fc.property(
        json,
        fc.constantFrom("1.5", "2e3", "1E-1", "-0.0", "9007199254740992"),
        (v, bad) => !integerTokensOnly(`{"a":${JSON.stringify(v)},"b":[${bad}]}`),
      ),
    );
    expect(() => canonicalJsonStrict({ a: 1.5 })).toThrow();
    expect(() => canonicalJsonStrict({ a: [undefined] })).toThrow();
    expect(() => canonicalJsonStrict({ a: new Date(0) })).toThrow();
  });
  it("canonical JSON ignores member order", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ maxLength: 5 }), fc.maxSafeInteger(), { maxKeys: 8 }), (d) => {
        const reversed = Object.fromEntries(Object.entries(d).reverse());
        return canonicalJsonStrict(d) === canonicalJsonStrict(reversed);
      }),
    );
  });
  it("hour truncation and padding bounds", () => {
    fc.assert(
      fc.property(fc.nat({ max: 2 ** 52 }), (ms) => {
        const h = floorToHour(ms);
        return h <= ms && ms < h + 3_600_000 && h % 3_600_000 === 0;
      }),
    );
    fc.assert(
      fc.property(fc.nat({ max: 10_000_000 }), (n) => {
        const p = paddedLength(n);
        return p % 16_384 === 0 && p >= n && p - n < 16_384;
      }),
    );
  });
});

describe("device names", () => {
  const nameArb = fc.string({ unit: "grapheme", minLength: 1, maxLength: 40 }).filter((s) => checkDeviceName(s).ok);
  it("every accepted name pads to 160 bytes and comes back unchanged, also through name_ct", async () => {
    const v1 = await vk(VK1_RAW);
    await fc.assert(
      fc.asyncProperty(nameArb, async (s) => {
        const name = (checkDeviceName(s) as { name: string }).name;
        const padded = padDeviceName(s);
        if (padded.length !== 160 || unpadDeviceName(padded) !== name) return false;
        return (
          (await openDeviceName(
            v1,
            { vaultId: VAULT, deviceId: DEV1 },
            await sealDeviceName(v1, { vaultId: VAULT, deviceId: DEV1 }, s),
          )) === name
        );
      }),
      RUNS,
    );
  });
  it("any flipped bit in iv or ct, and any other vault, device or VK, fails to open", async () => {
    const v1 = await vk(VK1_RAW);
    const v2 = await vk(VK2_RAW);
    const ct = await sealDeviceName(v1, { vaultId: VAULT, deviceId: DEV1 }, "Work");
    await fc.assert(
      fc.asyncProperty(fc.nat(), fc.nat(7), fc.boolean(), async (i, bit, inIv) => {
        const t = inIv
          ? { ...ct, iv: toB64(flip(fromB64(ct.iv), i, bit)) }
          : { ...ct, ct: toB64(flip(fromB64(ct.ct), i, bit)) };
        return openDeviceName(v1, { vaultId: VAULT, deviceId: DEV1 }, t).then(
          () => false,
          () => true,
        );
      }),
      RUNS,
    );
    for (const [k, owner, c] of [
      [v1, { vaultId: "test-vault-0002", deviceId: DEV1 }, ct],
      [v1, { vaultId: VAULT, deviceId: DEV2 }, ct],
      [v2, { vaultId: VAULT, deviceId: DEV1 }, { ...ct, vkId: v2.id }],
    ] as const) {
      await expect(openDeviceName(k as Vk, owner, c)).rejects.toMatchObject({ code: "decrypt_failed" });
    }
  });
});

describe("KeyBundle MAC", () => {
  const raw: string = G.keybundle.raw;
  /** Every scalar leaf of the bundle except mac, as a path, so a property can change exactly one. */
  const leaves: string[][] = [];
  (function walk(v: unknown, p: string[]) {
    if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, [...p, k]);
    else if (p[0] !== "mac") leaves.push(p);
  })(JSON.parse(raw), []);
  it("changing any single value (and any added or removed member) breaks the MAC", async () => {
    const v1 = await vk(VK1_RAW);
    expect(leaves.length).toBeGreaterThan(30);
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...leaves), async (path) => {
        const b = JSON.parse(raw);
        let o = b;
        for (const k of path.slice(0, -1)) o = o[k];
        const last = path[path.length - 1]!;
        o[last] =
          typeof o[last] === "number" ? o[last] + 3_600_000 : typeof o[last] === "string" ? `${o[last]}x` : !o[last];
        return !(await verifyBundleMac(v1, b as KeyBundle));
      }),
      { numRuns: leaves.length * 2 },
    );
    const b = parseBundleText(raw);
    expect(await verifyBundleMac(v1, { ...b, extra: 1 } as KeyBundle)).toBe(false);
    const { by: _by, ...noBy } = b;
    expect(await verifyBundleMac(v1, noBy as KeyBundle)).toBe(false);
  });
  it("domain separation: the MAC is bound to its key label and its tag", async () => {
    const v1 = await vk(VK1_RAW);
    const b = parseBundleText(raw);
    expect(await bundleMac(v1, b)).toBe(b.mac);
    const sign = async (key: CryptoKey, input: string) =>
      toB64(new Uint8Array(await crypto.subtle.sign("HMAC", key, bs(utf8(input)))));
    expect(await sign(await bundleMacKey(v1), bundleMacInput(b))).toBe(b.mac);
    expect(await sign(await bundleMacKey(v1), bundleMacInput(b).replace(TAG.keybundle, TAG.write))).not.toBe(b.mac);
    expect(await sign(await bundleMacKey(v1), bundleMacInput(b).slice(TAG.keybundle.length))).not.toBe(b.mac);
    expect(await verifyBundleMac(await vk(VK2_RAW), b)).toBe(false);
  });
});

describe("write proof", () => {
  it("changing the vault, the version, the checksum or the VK changes the proof", async () => {
    const v1 = await vk(VK1_RAW);
    const v2 = await vk(VK2_RAW);
    const t = { vaultId: VAULT, ifVersion: 41, checksum: G.write_proof.checksum_b64 };
    const p = await writeProof(v1, t);
    await fc.assert(
      fc.asyncProperty(fc.nat({ max: 1e9 }), bytes(32, 32), async (ver, cs) => {
        const other = await writeProof(v1, { ...t, ifVersion: ver, checksum: toB64(cs) });
        return other !== p || (ver === 41 && toB64(cs) === t.checksum);
      }),
      RUNS,
    );
    expect(await writeProof(v2, t)).not.toBe(p);
    expect(await writeProof(v1, { ...t, vaultId: "test-vault-0002" })).not.toBe(p);
  });
});

describe("enrollment ciphertexts under K_enroll", () => {
  async function key() {
    const a = await generateEphemeral();
    const b = await generateEphemeral();
    const h = crypto.getRandomValues(new Uint8Array(32));
    const s = crypto.getRandomValues(new Uint8Array(16)); // the pairing secret, the same on both sides
    const otherS = s.slice();
    otherS[0]! ^= 0x80;
    return {
      h,
      k: await enrollKey(await sharedSecret(a.privateKey, await importEpk(b.raw)), s.slice(), h),
      k2: await enrollKey(await sharedSecret(b.privateKey, await importEpk(a.raw)), s.slice(), h),
      kOtherS: await enrollKey(await sharedSecret(b.privateKey, await importEpk(a.raw)), otherS, h),
    };
  }
  it("both ECDH sides derive the same K; payloads round-trip; any flipped bit, other h, another S or swapped tag fails", async () => {
    const { h, k, k2, kOtherS } = await key();
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 300 }), fc.nat(), fc.nat(7), async (text, i, bit) => {
        const wire = await sealPayload(k, h, text);
        if ((await openPayload(k2, h, wire)) !== text) return false;
        const bad = toB64(flip(fromB64(wire), i, bit));
        return openPayload(k2, h, bad).then(
          () => false,
          () => true,
        );
      }),
      RUNS,
    );
    const wire = await sealPayload(k, h, "P");
    await expect(openPayload(k, flip(h, 0, 0), wire)).rejects.toMatchObject({ code: "decrypt_failed" });
    await expect(openRevealName(k, h, wire)).rejects.toMatchObject({ code: "decrypt_failed" });
    await expect(openPayload(k, h, await sealRevealName(k, h, "Work"))).rejects.toMatchObject({
      code: "decrypt_failed",
    });
    await expect(openPayload((await key()).k, h, wire)).rejects.toMatchObject({ code: "decrypt_failed" });
    await expect(openPayload(kOtherS, h, wire)).rejects.toMatchObject({ code: "decrypt_failed" }); // one bit of S
  });
});

describe("device-key backup", () => {
  it("round-trips; any flipped bit, another device, vault or VK fails; K_devbackup is not K_name", async () => {
    const v1 = await vk(VK1_RAW);
    const owner = { vaultId: VAULT, deviceId: DEV1 };
    const dk = await generateDeviceKey();
    const enc = await sealDeviceBackup(v1, owner, { dsk: dk.jwk, email: "alice@example.invalid" });
    expect((await openDeviceBackup(v1, owner, enc)).email).toBe("alice@example.invalid");
    await fc.assert(
      fc.asyncProperty(fc.nat(), fc.nat(7), async (i, bit) =>
        openDeviceBackup(v1, owner, { ...enc, ct: toB64(flip(fromB64(enc.ct), i, bit)) }).then(
          () => false,
          () => true,
        ),
      ),
      RUNS,
    );
    await expect(openDeviceBackup(v1, { ...owner, deviceId: DEV2 }, enc)).rejects.toMatchObject({
      code: "decrypt_failed",
    });
    await expect(
      openDeviceBackup(await vk(VK2_RAW), owner, { ...enc, vkId: (await vk(VK2_RAW)).id }),
    ).rejects.toMatchObject({ code: "decrypt_failed" });
    const w = fromB64(enc.ct);
    const aad = utf8(`${TAG.devkey}${VAULT}|${v1.id}|${DEV1}`);
    await expect(
      crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bs(fromB64(enc.iv)), additionalData: bs(aad) },
        await deviceNameKey(v1),
        bs(w),
      ),
    ).rejects.toBeDefined();
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bs(fromB64(enc.iv)), additionalData: bs(aad) },
      await deviceBackupKey(v1),
      bs(w),
    ); // the right key opens it
  });
});

describe("request signatures", () => {
  it("sign then verify for any target, ts and body; changing any field of the input, or any bit of the signature, fails", async () => {
    const key = await importDeviceKey(privateJwk("dsk_A"));
    const spki = fromB64(G.public_keys.keys.find((k: { name: string }) => k.name === "dsk_A").spki_b64);
    const target = fc.stringMatching(/^\/v1\/[a-z0-9/_?=&%-]{0,30}$/);
    await fc.assert(
      fc.asyncProperty(
        target,
        fc.nat({ max: 2 ** 50 }),
        fc.string({ maxLength: 50 }),
        fc.nat(63),
        fc.nat(7),
        async (t, ts, body, i, bit) => {
          const p = {
            host: "api.sixkey.app",
            method: "POST",
            target: t,
            signer: { deviceId: DEV2 },
            sub: null,
            ts,
            bodySha256: await bodyHash(body),
          };
          const input = signingInput(p);
          const sig = await signInput(key, input);
          if (!(await verifyInput(spki, sig, input))) return false;
          const variants = [
            signingInput({ ...p, ts: ts + 1 }),
            signingInput({ ...p, method: "PUT" }),
            signingInput({ ...p, host: "api.sixkey.app:8443" }),
            signingInput({ ...p, target: `${t}x` }),
            signingInput({ ...p, signer: { deviceId: DEV1 } }),
            signingInput({ ...p, sub: "u" }),
            signingInput({ ...p, bodySha256: await bodyHash(`${body}.`) }),
          ];
          for (const v of variants) if (await verifyInput(spki, sig, v)) return false;
          return !(await verifyInput(spki, toB64u(flip(fromB64u(sig), i, bit)), input));
        },
      ),
      { numRuns: 40 },
    );
  });
});
