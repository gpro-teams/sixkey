import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Base32Error, decodeBase32, encodeBase32, normalizeBase32 } from "../../src/core/totp/base32";

const ascii = (s: string) => new TextEncoder().encode(s);

describe("base32", () => {
  // RFC 4648 section 10 vectors (without padding)
  const vectors: [string, string][] = [
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ];
  for (const [plain, enc] of vectors) {
    it(`RFC 4648 "${plain}"`, () => {
      expect(encodeBase32(ascii(plain))).toBe(enc);
      expect(new TextDecoder().decode(decodeBase32(enc))).toBe(plain);
    });
  }
  it("is lenient on case, spaces, hyphens and padding", () => {
    expect(normalizeBase32("mzxw 6ytb-oi======")).toBe("MZXW6YTBOI");
    expect(normalizeBase32("  jbsw y3dp\nehpk3pxp ")).toBe("JBSWY3DPEHPK3PXP");
  });
  it("rejects characters outside the alphabet", () => {
    for (const bad of ["0", "1", "8", "9", "MZXW6!", "abc$"]) expect(() => decodeBase32(bad)).toThrow(Base32Error);
  });
  it("round-trips arbitrary bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 80 }), (bytes) => {
        expect(Array.from(decodeBase32(encodeBase32(bytes)))).toEqual(Array.from(bytes));
      }),
    );
  });
});
