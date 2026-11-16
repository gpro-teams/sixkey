// File import (IMPORT-FILE-NOTES.md §2): one picked file read as the page reads it (import-read.ts), with File objects
// made in Node. The size caps hold before anything is read, the bytes as read are kept as a SHA-256 for the delete
// prompt, and what the reader refused is counted, for the prompt to say what deleting the file would lose.
import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES, MAX_TEXT_BYTES } from "../../src/core/import/file-text";
import { readPicked } from "../../src/options/import-read";
import { sha256Hex } from "../../src/platform/file-access";
import { K1, K2, link } from "../helpers/import-fixtures";

const file = (parts: BlobPart[], name: string) => new File(parts, name, { lastModified: 1_760_000_000_000 });
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const noise = () => Uint8Array.from({ length: 64 }, (_, i) => (i * 97 + 1) & 255);

describe("readPicked", () => {
  it("text over 5 MiB is too large, unread; an image over 20 MiB too", async () => {
    const big = await readPicked(
      { file: file([new Uint8Array(MAX_TEXT_BYTES + 1).fill(0x41)], "big.txt"), handle: null },
      1,
    );
    expect(big.out).toEqual({ kind: "too_large" });
    expect(big.lines).toEqual([]);
    const at = await readPicked(
      { file: file([new Uint8Array(MAX_TEXT_BYTES).fill(0x0a)], "lines.txt"), handle: null },
      2,
    );
    expect(at.out.kind).toBe("nothing"); // exactly the cap is read
    const img = await readPicked(
      { file: file([PNG, new Uint8Array(MAX_IMAGE_BYTES + 1 - PNG.length)], "shot.png"), handle: null },
      3,
    );
    expect(img.out).toEqual({ kind: "too_large" });
    expect(img.image).toBe(true);
  });

  it("a links file: its lines, its size, time and SHA-256, and what was refused", async () => {
    const text = `${link("A", "a", K1)}\notpauth://steam/S:me?secret=${K2}\nnot a link\n`;
    const bytes = new TextEncoder().encode(text);
    const s = await readPicked({ file: file([text], "export.txt"), handle: null }, 4);
    expect(s.out.kind).toBe("accounts");
    expect(s.lines).toEqual([link("A", "a", K1)]);
    expect(s.refused).toBe(2);
    expect(s.seen).toEqual({
      size: bytes.length,
      lastModified: 1_760_000_000_000,
      sha256: await sha256Hex(bytes.buffer as ArrayBuffer),
    });
    expect(s.image).toBe(false);
  });

  it("an encrypted andOTP backup by its name, a ZIP by its bytes, a web page export, binary", async () => {
    const aes = await readPicked({ file: file([noise()], "otp_accounts.json.aes"), handle: null }, 5);
    expect(aes.out).toEqual({ kind: "encrypted", app: "andOTP" });
    const zip = await readPicked(
      { file: file([Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0])], "a.zip"), handle: null },
      6,
    );
    expect(zip.out).toEqual({ kind: "zip" });
    const html = await readPicked(
      { file: file(["<!DOCTYPE html><html><body><img src=x></body></html>"], "ente.html"), handle: null },
      7,
    );
    expect(html.out).toEqual({ kind: "html" });
    const bin = await readPicked({ file: file([noise()], "x.bin"), handle: null }, 8);
    expect(bin.out).toEqual({ kind: "binary" });
    expect([aes, zip, html, bin].every((s) => s.lines.length === 0 && s.seen.sha256 === undefined)).toBe(true);
  });
});
