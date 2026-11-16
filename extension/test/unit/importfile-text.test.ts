// File import (IMPORT-FILE-NOTES.md §2): what a file is comes from its bytes, never its name. Text in UTF-8 (with or
// without a byte order mark) or UTF-16 (either order, with or without one) is read; binary data is refused.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readImportText } from "../../src/core/import/file-formats";
import { decodeText, kindOf } from "../../src/core/import/file-text";
import { K1, link } from "../helpers/import-fixtures";

const LINE = link("GitHub", "alice", K1);
const utf8 = (s: string) => new TextEncoder().encode(s);
function utf16(s: string, le: boolean, bom: boolean): Uint8Array {
  const out: number[] = bom ? (le ? [0xff, 0xfe] : [0xfe, 0xff]) : [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out.push(...(le ? [c & 0xff, c >> 8] : [c >> 8, c & 0xff]));
  }
  return Uint8Array.from(out);
}

describe("kindOf: from the first bytes", () => {
  it("images the QR reader takes, and ZIP archives", () => {
    expect(kindOf(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image");
    expect(kindOf(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image");
    expect(kindOf(utf8("GIF89a...."))).toBe("image");
    expect(kindOf(utf8("RIFF\0\0\0\0WEBPVP8 "))).toBe("image");
    const bmp = new Uint8Array(30);
    bmp.set([0x42, 0x4d]);
    bmp[14] = 40;
    expect(kindOf(bmp)).toBe("image");
    expect(kindOf(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 20, 0]))).toBe("zip");
  });
  it("text that merely starts like a magic number is not an image", () => {
    expect(kindOf(utf8("BMW account export, version 2, 2026"))).toBe("other");
    expect(kindOf(utf8(LINE))).toBe("other");
  });
});

describe("decodeText", () => {
  it("UTF-8 with and without a byte order mark", () => {
    expect(decodeText(utf8(LINE))).toBe(LINE);
    expect(decodeText(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8(LINE)]))).toBe(LINE);
    expect(decodeText(utf8("中文 名称\r\n"))).toBe("中文 名称\r\n");
  });
  it("UTF-16 little and big endian, with and without a byte order mark", () => {
    for (const le of [true, false])
      for (const bom of [true, false])
        expect(decodeText(utf16(`${LINE}\r\n${LINE}`, le, bom)), `${le} ${bom}`).toBe(`${LINE}\r\n${LINE}`);
  });
  it("a UTF-16 file reads like the same file in UTF-8", () => {
    const r = readImportText(decodeText(utf16(`${LINE}\n`, true, true))!);
    expect(r.kind === "accounts" && r.lines).toEqual([LINE]);
  });
  it("binary is refused: a NUL, control characters, undecodable bytes, UTF-32", () => {
    expect(decodeText(Uint8Array.from([...utf8("abc"), 0, ...utf8("def")]))).toBeNull();
    expect(decodeText(Uint8Array.from([...utf8(`${LINE}\n`.repeat(200)), 0, ...utf8(LINE)]))).toBeNull(); // one NUL is enough
    expect(decodeText(Uint8Array.from({ length: 4096 }, (_, i) => (i * 73 + 11) & 0xff))).toBeNull();
    expect(decodeText(Uint8Array.from([0xff, 0xfe, 0, 0, 0x41, 0, 0, 0]))).toBeNull();
    expect(decodeText(Uint8Array.from([...utf8("ok "), 0x01, 0x02, 0x03, 0x04]))).toBeNull();
  });
  it("tabs, carriage returns and a few stray bytes are still text", () => {
    expect(decodeText(utf8("a\tb\r\nc\f"))).toBe("a\tb\r\nc\f");
    const mostly = Uint8Array.from([...utf8("x".repeat(1000)), 0xc3]); // one broken byte at the end
    expect(decodeText(mostly)).not.toBeNull();
  });
  it("never throws on arbitrary bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2000 }), (b) => {
        const t = decodeText(b);
        expect(t === null || typeof t === "string").toBe(true);
        expect(["image", "zip", "other"]).toContain(kindOf(b));
      }),
      { numRuns: 300 },
    );
  });
});
