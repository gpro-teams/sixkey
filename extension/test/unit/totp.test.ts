import { describe, expect, it } from "vitest";
import { hotp, totp, importHmacKey, totpCounter, secondsRemaining, type Algorithm } from "../../src/core/totp/hotp";

const ascii = (s: string) => new TextEncoder().encode(s);

// RFC 6238 Appendix B. Errata 2866: each hash uses its own seed length (20 / 32 / 64 bytes).
const SEEDS: Record<Algorithm, Uint8Array> = {
  SHA1: ascii("12345678901234567890"),
  SHA256: ascii("12345678901234567890123456789012"),
  SHA512: ascii("1234567890123456789012345678901234567890123456789012345678901234"),
};
const VECTORS: [number, string, string, string][] = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

describe("RFC 6238 appendix B", () => {
  for (const [t, sha1, sha256, sha512] of VECTORS) {
    it(`T=${t}`, async () => {
      const o = { digits: 8 as const, period: 30 };
      expect(await totp(SEEDS.SHA1, t * 1000, { ...o, algorithm: "SHA1" })).toBe(sha1);
      expect(await totp(SEEDS.SHA256, t * 1000, { ...o, algorithm: "SHA256" })).toBe(sha256);
      expect(await totp(SEEDS.SHA512, t * 1000, { ...o, algorithm: "SHA512" })).toBe(sha512);
    });
  }

  it("a 20-byte seed does not reproduce the SHA256/SHA512 vectors (documents the errata)", async () => {
    const got = await totp(SEEDS.SHA1, 59_000, { algorithm: "SHA256", digits: 8, period: 30 });
    expect(got).not.toBe("46119246");
  });
});

describe("RFC 4226 appendix D", () => {
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  it("counters 0-9", async () => {
    for (let c = 0; c < 10; c++) {
      expect(await hotp(SEEDS.SHA1, c, { algorithm: "SHA1", digits: 6 })).toBe(expected[c]);
    }
  });
});

describe("hotp edge cases", () => {
  it("accepts a pre-imported key and gives the same result", async () => {
    const key = await importHmacKey(SEEDS.SHA256, "SHA256");
    expect(await hotp(key, 1, { algorithm: "SHA256", digits: 8 })).toBe(
      await hotp(SEEDS.SHA256, 1, { algorithm: "SHA256", digits: 8 }),
    );
  });
  it("rejects an empty secret", async () => {
    await expect(hotp(new Uint8Array(0), 0, { algorithm: "SHA1", digits: 6 })).rejects.toThrow(RangeError);
  });
  it("rejects bad counters", async () => {
    const o = { algorithm: "SHA1", digits: 6 } as const;
    await expect(hotp(SEEDS.SHA1, -1, o)).rejects.toThrow(RangeError);
    await expect(hotp(SEEDS.SHA1, 1.5, o)).rejects.toThrow();
    await expect(hotp(SEEDS.SHA1, 2 ** 64, o)).rejects.toThrow(RangeError);
  });
  it("handles counters above 2^32 (no 32-bit truncation)", async () => {
    const o = { algorithm: "SHA1", digits: 6 } as const;
    expect(await hotp(SEEDS.SHA1, 2n ** 33n, o)).not.toBe(await hotp(SEEDS.SHA1, 0, o));
  });
  it("pads leading zeros", async () => {
    // RFC 6238 T=1111111109 SHA1 8 digits starts with 0
    expect(await totp(SEEDS.SHA1, 1111111109_000, { algorithm: "SHA1", digits: 8, period: 30 })).toBe("07081804");
  });
  it("period 60 uses a 60 second window", async () => {
    const o = { algorithm: "SHA1", digits: 6 } as const;
    expect(await totp(SEEDS.SHA1, 0, { ...o, period: 60 })).toBe(await totp(SEEDS.SHA1, 59_000, { ...o, period: 60 }));
    expect(await totp(SEEDS.SHA1, 0, { ...o, period: 60 })).not.toBe(
      await totp(SEEDS.SHA1, 60_000, { ...o, period: 60 }),
    );
  });
});

describe("time helpers", () => {
  it("counter and remaining", () => {
    expect(totpCounter(59_000, 30)).toBe(1);
    expect(totpCounter(60_000, 30)).toBe(2);
    expect(secondsRemaining(0, 30)).toBe(30);
    expect(secondsRemaining(29_500, 30)).toBeCloseTo(0.5);
  });
  it("rejects non-positive periods", () => {
    expect(() => totpCounter(0, 0)).toThrow(RangeError);
    expect(() => secondsRemaining(0, 1.5)).toThrow(RangeError);
  });
});
