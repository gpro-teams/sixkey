// Recovery code shares, the crypto module (src/core/crypto/shares.ts; docs/design/notes/SHAMIR-NOTES.md): the field, the
// interpolation, the digest, the text and its check bits, and what a set accepts. The arithmetic is also held to
// SLIP-39's own vectors (shares-slip39.test.ts); here it is held to independent definitions and to properties.
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { CryptoError } from "../../src/core/crypto/bytes";
import { formatPairingCode } from "../../src/core/crypto/pairing-code";
import { formatRecoveryCode, parseRecoveryCode } from "../../src/core/crypto/recovery-code";
import {
  DIGEST_INDEX,
  SECRET_INDEX,
  SHARE_SYMBOLS,
  combineShares,
  digestOf,
  checkOf,
  formatShare,
  gfInv,
  gfMul,
  interpolate,
  makeShareSet,
  parseShare,
  recoverSecret,
  recoveryCodeFromShares,
  setIdText,
  splitSecret,
  type RawShare,
  type Share,
} from "../../src/core/crypto/shares";
/** The recovery code rebuilt from share texts, as the pages and the service do it. */
const rebuild = (texts: readonly string[]) => recoveryCodeFromShares(texts, formatRecoveryCode);

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** A deterministic Random: SHA-256 of a seed and a counter. */
const seeded = (seed: string) => {
  let i = 0;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let o = 0; o < n; o += 32) {
      const h = createHash("sha256").update(`${seed}|${i++}`).digest();
      out.set(h.subarray(0, Math.min(32, n - o)), o);
    }
    return out;
  };
};

// An independent GF(2^8): the classic log/exp tables over the generator 3 (as SLIP-39's reference builds them).
const EXP: number[] = [];
const LOG: number[] = new Array(256).fill(0);
{
  let p = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = p;
    LOG[p] = i;
    p ^= p << 1;
    if (p & 0x100) p ^= 0x11b;
  }
}
const tableMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[(LOG[a]! + LOG[b]!) % 255]!);

/** A share's text from a header and value, its check made with `tag`: an independent encoder of the v1 layout. */
/** The check of the v1 layout, independently: the remainder of (tag || head) * x^20 by x^20 + 0xFD2A9, by long division. */
const G = (1n << 20n) | 0xfd2a9n;
function crcRef(tag: string, head: Buffer): bigint {
  let m = BigInt("0x" + (Buffer.concat([Buffer.from(tag), head]).toString("hex") || "0")) << 20n;
  for (let b = BigInt(m.toString(2).length - 1); b >= 20n; b--) if ((m >> b) & 1n) m ^= G << (b - 20n);
  return m;
}
function encode(head: Buffer, tag = "sixkey-share|1|"): string {
  let n = (BigInt("0x" + head.toString("hex")) << 20n) | crcRef(tag, head);
  let out = "";
  for (let i = 0; i < 36; i++) {
    out = ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

describe("GF(2^8) with the Rijndael polynomial, without tables", () => {
  it("gfMul equals the log/exp-table product for all 65,536 pairs", () => {
    for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) expect(gfMul(a, b)).toBe(tableMul(a, b));
  });
  it("FIPS-197's worked examples: {57}·{83} = {c1}, {57}·{13} = {fe}", () => {
    expect(gfMul(0x57, 0x83)).toBe(0xc1);
    expect(gfMul(0x57, 0x13)).toBe(0xfe);
  });
  it("gfInv(a)·a = 1 for every non-zero a, gfInv(0) = 0, and gfInv agrees with the tables", () => {
    for (let a = 1; a < 256; a++) {
      expect(gfMul(a, gfInv(a))).toBe(1);
      expect(gfInv(a)).toBe(EXP[(255 - LOG[a]!) % 255]);
    }
    expect(gfInv(0)).toBe(0);
  });
  it("the field's code has no table: no array literal of numbers, no indexed read of one", () => {
    const src = readFileSync(new URL("../../src/core/crypto/shares.ts", import.meta.url), "utf8");
    const field = src.slice(src.indexOf("// ---- GF(2^8)"), src.indexOf("// ---- the digest"));
    expect(field.length).toBeGreaterThan(500);
    expect(field).not.toMatch(/\[\s*\d+\s*,\s*\d+/); // no numeric table
    expect(field).not.toMatch(/(?:EXP|LOG|TABLE)\w*\[/i);
  });
});

/** f(x) for coefficients c[0] + c[1]x + ..., byte by byte (Horner), with the table product: an independent evaluator. */
function evaluate(coeffs: Uint8Array[], x: number): Uint8Array {
  const len = coeffs[0]!.length;
  const out = new Uint8Array(len);
  for (let k = 0; k < len; k++) {
    let acc = 0;
    for (let i = coeffs.length - 1; i >= 0; i--) acc = tableMul(acc, x) ^ coeffs[i]![k]!;
    out[k] = acc;
  }
  return out;
}

describe("Lagrange interpolation", () => {
  it("rebuilds any polynomial of degree t-1 from any t of its points, at any x (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.uint8Array({ minLength: 16 * 8, maxLength: 16 * 8 }),
        fc.shuffledSubarray([...Array(256).keys()], { minLength: 9, maxLength: 9 }),
        (t, bytes, xs) => {
          const coeffs = Array.from({ length: t }, (_, i) => bytes.slice(i * 16, i * 16 + 16));
          const points: RawShare[] = xs.slice(0, t).map((x) => ({ x, data: evaluate(coeffs, x) }));
          const at = xs[8]!;
          expect(hex(interpolate(points, at))).toBe(hex(evaluate(coeffs, at)));
          expect(hex(interpolate(points, 0))).toBe(hex(coeffs[0]!)); // f(0), the constant term
        },
      ),
      { numRuns: 200 },
    );
  });
  it("at one of its points, that point's value (a copy)", () => {
    const p = [
      { x: 3, data: Uint8Array.from([1, 2]) },
      { x: 9, data: Uint8Array.from([7, 7]) },
    ];
    const v = interpolate(p, 9);
    expect([...v]).toEqual([7, 7]);
    v[0] = 0;
    expect(p[1]!.data[0]).toBe(7);
  });
  it("refuses duplicate x, values of different lengths and no points", () => {
    const a = { x: 1, data: new Uint8Array(2) };
    expect(() => interpolate([a, { x: 1, data: new Uint8Array(2) }], 0)).toThrow(/shares_duplicate/);
    expect(() => interpolate([a, { x: 2, data: new Uint8Array(3) }], 0)).toThrow(/shares_mixed/);
    expect(() => interpolate([], 0)).toThrow(/shares_count/);
  });
});

describe("the digest share (SLIP-39 _create_digest and its place)", () => {
  it("is HMAC-SHA256 keyed by r over the secret, first 4 bytes (node:crypto's HMAC)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 12, maxLength: 12 }),
        fc.uint8Array({ minLength: 16, maxLength: 16 }),
        async (r, s) => {
          expect(hex(await digestOf(r, s))).toBe(
            createHmac("sha256", r).update(s).digest().subarray(0, 4).toString("hex"),
          );
        },
      ),
      { numRuns: 50 },
    );
  });
  it("the split puts digest || r at x = 254 and the secret at x = 255 (rebuilt from the shares)", async () => {
    const secret = seeded("dig-secret")(16);
    for (const [t, n] of [
      [2, 3],
      [3, 5],
    ] as const) {
      const shares = await splitSecret(t, n, secret, seeded(`dig-${t}`));
      const pts = shares.slice(0, t);
      expect(hex(interpolate(pts, SECRET_INDEX))).toBe(hex(secret));
      const d = interpolate(pts, DIGEST_INDEX);
      expect(hex(d.subarray(0, 4))).toBe(hex(await digestOf(d.subarray(4), secret)));
    }
  });
  // the review's test (R1): a digest share off in one byte only, each of the 4, must fail (all 4 bytes are compared)
  for (const k of [0, 1, 2, 3])
    it(`a digest share off in byte ${k} only is refused (the comparison covers all 4 bytes)`, async () => {
      const rng = seeded(`digest-byte-${k}`);
      const secret = rng(16);
      const r = rng(12);
      const d = new Uint8Array(16);
      d.set(await digestOf(r, secret), 0);
      d.set(r, 4);
      d[k]! ^= 1;
      const base = [
        { x: DIGEST_INDEX, data: d },
        { x: SECRET_INDEX, data: secret },
      ];
      const shares = [0, 1].map((x) => ({ x, data: interpolate(base, x) }));
      await expect(recoverSecret(2, shares)).rejects.toMatchObject({ code: "shares_digest" });
    });
  it("a combination whose digest fails is refused, and nothing of it is returned", async () => {
    const secret = seeded("bad-secret")(16);
    const shares = await splitSecret(2, 3, secret, seeded("bad"));
    shares[1]!.data[5]! ^= 0x40;
    await expect(recoverSecret(2, shares.slice(0, 2))).rejects.toMatchObject({ code: "shares_digest" });
  });
});

describe("split and recover: properties", () => {
  const subsets = <T>(all: T[], k: number): T[][] =>
    k === 0 ? [[]] : all.flatMap((s, i) => subsets(all.slice(i + 1), k - 1).map((r) => [s, ...r]));
  it("random secrets, every (t, n) with 2 <= t <= n <= 6: every subset of t recovers the secret", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 16, maxLength: 16 }),
        fc.integer({ min: 2, max: 6 }).chain((n) => fc.tuple(fc.integer({ min: 2, max: n }), fc.constant(n))),
        fc.string(),
        async (secret, [t, n], seed) => {
          const shares = await splitSecret(t, n, secret, seeded(seed));
          expect(shares.map((s) => s.x)).toEqual([...Array(n).keys()]);
          for (const sub of subsets(shares, t)) expect(hex(await recoverSecret(t, sub))).toBe(hex(secret));
        },
      ),
      { numRuns: 60 },
    );
  });
  it("fewer than t shares do not give the secret: a set refuses them, and the raw arithmetic gives something else", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 16, maxLength: 16 }),
        fc.integer({ min: 3, max: 6 }).chain((n) => fc.tuple(fc.integer({ min: 2, max: n }), fc.constant(n))),
        fc.string(),
        async (secret, [t, n], seed) => {
          const set = await makeShareSet(secret, t, n, seeded(seed));
          const parsed = await Promise.all(set.shares.map(parseShare));
          for (const sub of subsets(parsed, t - 1)) {
            await expect(combineShares(sub)).rejects.toMatchObject({ code: "shares_count" });
            if (sub.length === 0) continue;
            // forced through as if t - 1 were the threshold: the digest fails (but for 2^-32), and f(255) is not R
            const raw = sub.map((s) => ({ x: s.index, data: s.value }));
            expect(hex(interpolate(raw, SECRET_INDEX))).not.toBe(hex(secret));
            if (raw.length > 1)
              await expect(recoverSecret(t - 1, raw)).rejects.toMatchObject({ code: "shares_digest" });
          }
        },
      ),
      { numRuns: 40 },
    );
  });
  it("one share of a 2-of-n set is unrelated to the secret: no byte of it is forced (no zero-coefficient rule)", async () => {
    // With uniform coefficients a share byte equals the secret byte 1 time in 256; a rule rejecting zero slopes would make it never.
    let equal = 0;
    let total = 0;
    const rng = seeded("uniform");
    for (let i = 0; i < 400; i++) {
      const secret = rng(16);
      const [s0] = await splitSecret(2, 2, secret, rng);
      for (let k = 0; k < 16; k++) {
        total++;
        if (s0!.data[k] === secret[k]) equal++;
      }
    }
    expect(equal).toBeGreaterThan(0); // about total / 256 = 25
    expect(equal).toBeLessThan(total / 64);
  });
  it("the threshold bounds: 1 <= t <= n <= 16, a secret of at least 16 bytes and an even length", async () => {
    const s = new Uint8Array(16);
    await expect(splitSecret(0, 3, s)).rejects.toThrow(RangeError);
    await expect(splitSecret(4, 3, s)).rejects.toThrow(RangeError);
    await expect(splitSecret(2, 17, s)).rejects.toThrow(RangeError);
    await expect(splitSecret(2, 3, new Uint8Array(15))).rejects.toThrow(RangeError);
    await expect(splitSecret(2, 3, new Uint8Array(14))).rejects.toThrow(RangeError);
    expect((await splitSecret(16, 16, s, seeded("16"))).length).toBe(16);
  });
  it("the random bytes are drawn as the reference draws them: t - 2 of 16, then one of 12", async () => {
    const sizes: number[] = [];
    const base = seeded("sizes");
    await splitSecret(5, 7, new Uint8Array(16), (n) => (sizes.push(n), base(n)));
    expect(sizes).toEqual([16, 16, 16, 12]);
  });
  it("the caller's secret and random buffers are not changed by the split (its own copies are zeroed)", async () => {
    const secret = seeded("keep")(16);
    const before = hex(secret);
    const given: Uint8Array[] = [];
    const base = seeded("keep-rng");
    await splitSecret(3, 4, secret, (n) => {
      const b = base(n);
      given.push(b);
      return b;
    });
    expect(hex(secret)).toBe(before);
    expect(given.every((b) => b.some((x) => x !== 0))).toBe(true);
  });
});

describe("Sixkey share v1: the text", () => {
  const share = (o: Partial<Share> = {}): Share => ({
    setId: 0x7f2a,
    threshold: 2,
    index: 1,
    value: Uint8Array.from({ length: 16 }, (_, i) => i * 17),
    ...o,
  });
  it("36 symbols in 9 groups of 4, and a known answer (the layout and the CRC-20 check bits are pinned)", async () => {
    const text = await formatShare(share());
    expect(text).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){8}$/);
    // header 0x10 7f 2a 11, value 00 11 22 ... ff, check = CRC-20 over "sixkey-share|1|" || those 20 bytes
    const head = Buffer.from("107f2a11" + "00112233445566778899aabbccddeeff", "hex");
    expect(text.replace(/-/g, "")).toBe(encode(head));
  });
  it("round trip, with the reading of the recovery code: any case, spaces, hyphens, O as 0, I and L as 1", async () => {
    const s = share({ setId: 0x0001, threshold: 3, index: 15 });
    const text = await formatShare(s);
    const loose = text.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l");
    for (const t of [text, loose, text.replace(/-/g, "")]) {
      const back = await parseShare(t);
      expect({ ...back, value: hex(back.value) }).toEqual({ ...s, value: hex(s.value) });
    }
  });
  it("guaranteed, on 120 random shares: all 36 x 31 single-symbol substitutions and all 35 swaps of neighbours are caught", async () => {
    const rng = seeded("crc-exhaustive");
    let subs = 0;
    let swaps = 0;
    for (let k = 0; k < 120; k++) {
      const b = rng(4);
      const s = share({ setId: (b[0]! << 8) | b[1]!, threshold: (b[2]! % 16) + 1, index: b[3]! % 16, value: rng(16) });
      const text = (await formatShare(s)).replace(/-/g, "");
      for (let i = 0; i < SHARE_SYMBOLS; i++) {
        for (const c of ALPHABET) {
          if (c === text[i]) continue;
          subs++;
          const typo = text.slice(0, i) + c + text.slice(i + 1);
          await expect(parseShare(typo), `${text} at ${i}: ${c}`).rejects.toMatchObject({ code: "share_checksum" });
        }
        if (i < SHARE_SYMBOLS - 1 && text[i] !== text[i + 1]) {
          swaps++;
          const swapped = text.slice(0, i) + text[i + 1] + text[i] + text.slice(i + 2);
          await expect(parseShare(swapped), `${text} swap ${i}`).rejects.toMatchObject({ code: "share_checksum" });
        }
      }
    }
    expect(subs).toBe(120 * 36 * 31);
    expect(swaps).toBeGreaterThan(120 * 33);
  });
  it("why it holds for every share: the check is linear, a burst of <= 20 bits never divides by x^20 + 0xFD2A9, and the 1,116 single-symbol syndromes are distinct and non-zero (so every two substitutions are caught too)", () => {
    // the syndrome of value v at symbol i: (v(x) * x^(175 - 5i)) mod G, which is the check's change for that typo
    const mod = (e: bigint) => {
      for (let b = BigInt(e.toString(2).length - 1); b >= 20n; b--) if ((e >> b) & 1n) e ^= G << (b - 20n);
      return e;
    };
    const seen = new Set<bigint>();
    for (let i = 0; i < SHARE_SYMBOLS; i++)
      for (let v = 1n; v < 32n; v++) {
        const syn = mod(v << BigInt(175 - 5 * i));
        expect(syn, `${i}:${v}`).not.toBe(0n);
        seen.add(syn);
      }
    expect(seen.size).toBe(36 * 31);
    // every burst confined to 20 consecutive bits (any 4 consecutive symbols): a non-zero remainder, sampled across
    // every position and many patterns (the algebra: G has degree 20 and a constant term, so it divides no such burst)
    const rng = seeded("bursts");
    for (let start = 0; start <= 160; start += 5)
      for (let k = 0; k < 60; k++) {
        const r = rng(3);
        const pattern = (BigInt(r[0]!) << 12n) | (BigInt(r[1]!) << 4n) | BigInt(r[2]! >> 4) | 1n;
        expect(mod(pattern << BigInt(160 - start))).not.toBe(0n);
      }
    // the code's own checkOf is this CRC
    const head = Buffer.from("107f2a1100112233445566778899aabbccddeeff", "hex");
    expect(BigInt(checkOf(head))).toBe(crcRef("sixkey-share|1|", head));
  });
  it("two substitutions anywhere in a share are caught (sampled over the pairs of places, on random shares)", async () => {
    const rng = seeded("pairs");
    for (let k = 0; k < 400; k++) {
      const s = share({ setId: k, value: rng(16) });
      const text = (await formatShare(s)).replace(/-/g, "");
      const r = rng(4);
      const i = r[0]! % 36;
      const j = (i + 1 + (r[1]! % 35)) % 36;
      const ci = ALPHABET[(ALPHABET.indexOf(text[i]!) + 1 + (r[2]! % 31)) % 32]!;
      const cj = ALPHABET[(ALPHABET.indexOf(text[j]!) + 1 + (r[3]! % 31)) % 32]!;
      const t = [...text];
      t[i] = ci;
      t[j] = cj;
      await expect(parseShare(t.join("")), `${text} at ${i},${j}`).rejects.toMatchObject({ code: "share_checksum" });
    }
  });
  it("a typo in the first symbol (the version) is a typo, not 'made by a newer Sixkey'", async () => {
    const text = await formatShare(share());
    expect(text[0]).toBe("2");
    for (const c of "01Z")
      await expect(parseShare(c + text.slice(1))).rejects.toMatchObject({ code: "share_checksum" });
  });
  const forge = (head0: number, tag?: string) =>
    encode(Buffer.concat([Buffer.from([head0, 0x7f, 0x2a, 0x11]), Buffer.from(share().value)]), tag);
  it("a well-formed share of another version or kind: share_newer (version 2, version 0, kind 1 the heir share)", async () => {
    expect((await parseShare(forge(0x10))).setId).toBe(0x7f2a); // control: v1, kind 0
    for (const h of [0x20, 0x00, 0x11, 0x1f, 0xf0])
      await expect(parseShare(forge(h))).rejects.toMatchObject({ code: "share_newer" });
  });
  it("the check is domain-separated: the same bytes checked with another tag (none, the pairing code's) fail", async () => {
    for (const tag of ["", "sixkey-pairing-code|1|", "sixkey-share|2|"])
      await expect(parseShare(forge(0x10, tag))).rejects.toMatchObject({ code: "share_checksum" });
  });
  it("a recovery code or a pairing code is not a share, and a share is not a recovery code (lengths differ)", async () => {
    const secret = seeded("codes")(16);
    await expect(parseShare(await formatRecoveryCode(secret))).rejects.toMatchObject({ code: "share_length" });
    await expect(parseShare(await formatPairingCode(secret))).rejects.toMatchObject({ code: "share_length" });
    await expect(parseRecoveryCode(await formatShare(share()))).rejects.toMatchObject({ code: "recovery_length" });
    await expect(parseShare("U".repeat(36))).rejects.toMatchObject({ code: "share_char" });
    await expect(parseShare("")).rejects.toMatchObject({ code: "share_length" });
  });
  it("errors carry no input: the message is the code", async () => {
    const text = await formatShare(share());
    const e = await parseShare("1" + text.slice(1)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CryptoError);
    expect((e as Error).message).toBe("share_checksum");
  });
  it("formatShare refuses what does not fit its fields", async () => {
    await expect(formatShare(share({ setId: 0x10000 }))).rejects.toThrow(RangeError);
    await expect(formatShare(share({ index: 16 }))).rejects.toThrow(RangeError);
    await expect(formatShare(share({ threshold: 17 }))).rejects.toThrow(RangeError);
    await expect(formatShare(share({ value: new Uint8Array(15) }))).rejects.toThrow(RangeError);
  });
  it("setIdText: four upper-case hexadecimal digits", () => {
    expect(setIdText(0x7f2a)).toBe("7F2A");
    expect(setIdText(0x0001)).toBe("0001");
  });
});

describe("a set: made, and combined only from exactly its threshold of its own shares", () => {
  const R = Uint8Array.from({ length: 16 }, (_, i) => 200 - i);
  it("2 of 3 and 3 of 5: the set id is the same in every share, members 1..n, any t rebuild R", async () => {
    for (const [t, n] of [
      [2, 3],
      [3, 5],
    ] as const) {
      const set = await makeShareSet(R, t, n, seeded(`set-${t}`));
      expect(set.shares).toHaveLength(n);
      const parsed = await Promise.all(set.shares.map(parseShare));
      expect(new Set(parsed.map((p) => p.setId))).toEqual(new Set([set.setId]));
      expect(parsed.map((p) => p.index)).toEqual([...Array(n).keys()]);
      expect(parsed.every((p) => p.threshold === t)).toBe(true);
      expect(hex(await combineShares(parsed.slice(n - t)))).toBe(hex(R));
      expect(await rebuild(set.shares.slice(0, t))).toBe(await formatRecoveryCode(R));
    }
  });
  it("shares of two sets of the same key: refused as different sets before any arithmetic (no HMAC computed)", async () => {
    const a = await Promise.all((await makeShareSet(R, 2, 3, seeded("A"))).shares.map(parseShare));
    const b = await Promise.all((await makeShareSet(R, 2, 3, seeded("B"))).shares.map(parseShare));
    expect(a[0]!.setId).not.toBe(b[0]!.setId);
    const sign = vi.spyOn(crypto.subtle, "sign");
    const imp = vi.spyOn(crypto.subtle, "importKey");
    try {
      await expect(combineShares([a[0]!, b[1]!])).rejects.toMatchObject({ code: "shares_mixed" });
      await expect(combineShares([a[0]!, a[0]!])).rejects.toMatchObject({ code: "shares_duplicate" });
      await expect(combineShares([a[0]!, a[1]!, a[2]!])).rejects.toMatchObject({ code: "shares_count" });
      expect(sign).not.toHaveBeenCalled();
      expect(imp).not.toHaveBeenCalled();
    } finally {
      sign.mockRestore();
      imp.mockRestore();
    }
  });
  it("the same set id with another threshold is another set (shares_mixed)", async () => {
    const two = await formatShare({ setId: 5, threshold: 2, index: 0, value: new Uint8Array(16) });
    const three = await formatShare({ setId: 5, threshold: 3, index: 1, value: new Uint8Array(16) });
    await expect(combineShares([await parseShare(two), await parseShare(three)])).rejects.toMatchObject({
      code: "shares_mixed",
    });
  });
  it("a set never has a threshold below 2 (a share would be R itself), on making or on reading", async () => {
    await expect(makeShareSet(R, 1, 3)).rejects.toThrow(RangeError);
    const one = await parseShare(await formatShare({ setId: 9, threshold: 1, index: 0, value: R }));
    await expect(combineShares([one])).rejects.toMatchObject({ code: "shares_count" });
  });
  it("a set id collision between two sets of different keys fails the digest (shares_digest), not with a wrong key", async () => {
    // two sets that happen to share an id (1 in 65,536): forced here by the same first two random bytes
    const fixedId = (seed: string) => {
      const r = seeded(seed);
      let first = true;
      return (n: number) => (first && n === 2 ? ((first = false), Uint8Array.from([0xab, 0xcd])) : r(n));
    };
    const other = Uint8Array.from({ length: 16 }, (_, i) => i);
    const a = await Promise.all((await makeShareSet(R, 2, 3, fixedId("x"))).shares.map(parseShare));
    const b = await Promise.all((await makeShareSet(other, 2, 3, fixedId("y"))).shares.map(parseShare));
    expect(a[0]!.setId).toBe(b[0]!.setId);
    await expect(combineShares([a[0]!, b[1]!])).rejects.toMatchObject({ code: "shares_digest" });
  });
  it("recoveryCodeFromShares zeroes R once the formatter has it (the review's R15)", async () => {
    const set = await makeShareSet(R, 2, 3, seeded("zero-r"));
    let held: Uint8Array | null = null;
    const code = await recoveryCodeFromShares(set.shares.slice(1), async (secret) => {
      held = secret;
      return formatRecoveryCode(Uint8Array.from(secret));
    });
    expect(code).toBe(await formatRecoveryCode(R));
    expect([...held!].every((b) => b === 0)).toBe(true);
  });
  it("recoveryCodeFromShares zeroes what it parsed and rebuilt, also when they do not combine", async () => {
    const set = await makeShareSet(R, 2, 3, seeded("zero"));
    const fills: Uint8Array[] = [];
    const orig = Uint8Array.prototype.fill;
    const spy = vi.spyOn(Uint8Array.prototype, "fill").mockImplementation(function (this: Uint8Array, ...a) {
      fills.push(this);
      return orig.apply(this, a as Parameters<typeof orig>);
    });
    try {
      await rebuild(set.shares.slice(0, 2));
      expect(fills.filter((b) => b.length === 16).length).toBeGreaterThanOrEqual(3); // two values and R
      fills.length = 0;
      await expect(rebuild([set.shares[0]!, set.shares[0]!])).rejects.toMatchObject({
        code: "shares_duplicate",
      });
      expect(fills.filter((b) => b.length === 16).length).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
  });
});
