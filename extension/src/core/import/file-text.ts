// What a chosen file is, from its bytes, never from its name: an image (a QR screenshot), a ZIP archive, text (UTF-8
// with or without a byte order mark, or UTF-16 either way round), or something else. Pure, no DOM, never throws.
// The bytes themselves are never put into an error or a log: the caller gets a kind, and the text only when it is text.
// docs/design/notes/IMPORT-FILE-NOTES.md §2.

/** Text files above this are refused before they are read. Every real export is far smaller. */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
/** Images above this are refused before they are decoded. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** How many bytes of a file decide what it is (the magic numbers and the binary check read no more than this). */
export const HEAD_BYTES = 64 * 1024;

export type FileKind = "image" | "zip" | "other";

const starts = (b: Uint8Array, magic: readonly number[], at = 0) =>
  b.length >= at + magic.length && magic.every((x, i) => b[at + i] === x);

/** An image the QR reader takes (PNG, JPEG, GIF, WebP, BMP), a ZIP archive, or anything else, from the first bytes. */
export function kindOf(head: Uint8Array): FileKind {
  if (
    starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) || // PNG
    starts(head, [0xff, 0xd8, 0xff]) || // JPEG
    starts(head, [0x47, 0x49, 0x46, 0x38]) || // GIF8
    (starts(head, [0x52, 0x49, 0x46, 0x46]) && starts(head, [0x57, 0x45, 0x42, 0x50], 8)) || // RIFF....WEBP
    (starts(head, [0x42, 0x4d]) && head.length >= 26 && head[14]! >= 12 && head[15] === 0) // BM + a plausible header size
  )
    return "image";
  if (starts(head, [0x50, 0x4b, 0x03, 0x04]) || starts(head, [0x50, 0x4b, 0x05, 0x06])) return "zip";
  return "other";
}

type Encoding = "utf-8" | "utf-16le" | "utf-16be";

/** The encoding and where the text starts: a byte order mark decides; without one, UTF-16 shows as zero bytes on one side. */
function encodingOf(b: Uint8Array): { enc: Encoding; skip: number } | null {
  if (starts(b, [0xef, 0xbb, 0xbf])) return { enc: "utf-8", skip: 3 };
  if (starts(b, [0xff, 0xfe, 0x00, 0x00]) || starts(b, [0x00, 0x00, 0xfe, 0xff])) return null; // UTF-32: not a text export
  if (starts(b, [0xff, 0xfe])) return { enc: "utf-16le", skip: 2 };
  if (starts(b, [0xfe, 0xff])) return { enc: "utf-16be", skip: 2 };
  const n = Math.min(b.length, HEAD_BYTES) & ~1;
  if (n >= 4) {
    let evenZero = 0;
    let oddZero = 0;
    for (let i = 0; i < n; i += 2) {
      if (b[i] === 0) evenZero++;
      if (b[i + 1] === 0) oddZero++;
    }
    const half = n / 2;
    // ASCII text in UTF-16: every other byte is zero, the other side almost never
    if (oddZero > half * 0.4 && evenZero < half * 0.05) return { enc: "utf-16le", skip: 0 };
    if (evenZero > half * 0.4 && oddZero < half * 0.05) return { enc: "utf-16be", skip: 0 };
  }
  return { enc: "utf-8", skip: 0 };
}

/**
 * The file's text, or null when it is not text: a NUL character, or more than 2% control characters or undecodable
 * bytes in its first 64 KiB, is binary (an encrypted backup, an archive, a program). The byte order mark is dropped.
 */
export function decodeText(bytes: Uint8Array): string | null {
  const e = encodingOf(bytes);
  if (!e) return null;
  let text: string;
  try {
    text = new TextDecoder(e.enc, { fatal: false, ignoreBOM: true }).decode(bytes.subarray(e.skip));
  } catch {
    return null;
  }
  const head = text.length > HEAD_BYTES ? text.slice(0, HEAD_BYTES) : text;
  let bad = 0;
  for (let i = 0; i < head.length; i++) {
    const c = head.charCodeAt(i);
    if (c === 0) return null;
    // tab, line feed, vertical tab, form feed, carriage return and escape are allowed; other C0 controls and U+FFFD count
    if ((c < 0x20 && !(c >= 0x09 && c <= 0x0d) && c !== 0x1b) || c === 0xfffd || c === 0x7f) bad++;
  }
  if (bad > head.length * 0.02) return null;
  return text;
}
