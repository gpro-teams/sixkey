// One chosen or dropped file, read for Settings > Add account: what it is comes from its bytes (file-text.ts), and its
// accounts from the format reader (file-formats.ts) or, for an image, from the QR reader (lib/qr.ts). The file's bytes
// and text live only inside readPicked; what is kept is the checked links it adds to the import, its name, and its
// handle and size and time, for the delete prompt afterwards (platform/file-access.ts). docs/design/notes/IMPORT-FILE-NOTES.md.
import { encryptedByName, readImportText, readQrTexts, type FileRead } from "../core/import/file-formats";
import { decodeText, HEAD_BYTES, kindOf, MAX_IMAGE_BYTES, MAX_TEXT_BYTES } from "../core/import/file-text";
import { decodeAllQrFromBlob } from "../lib/qr";
import { sha256Hex, type FileHandleLike, type Picked, type Seen } from "../platform/file-access";

/** What a file turned out to be, for the page to say. */
export type SourceOut =
  | Extract<FileRead, { kind: "accounts" }>
  | { kind: "encrypted"; app: string }
  | { kind: "sixkey_backup" }
  | { kind: "html" }
  | { kind: "too_large" }
  | { kind: "nothing" }
  | { kind: "noqr" } // an image without a QR code
  | { kind: "zip" }
  | { kind: "binary" };

export type Source = {
  id: number;
  name: string;
  handle: FileHandleLike | null;
  seen: Seen;
  out: SourceOut;
  /** what it adds to the import: checked links, or plain key lines (file-formats.ts) */
  lines: string[];
  /** an image (a QR screenshot), from its bytes */
  image: boolean;
  /** entries the reader did not take (Steam and other kinds, unreadable entries): lost if the file is deleted */
  refused: number;
};

type Read = SourceOut & { image?: true; sha256?: string };

async function outOf(file: File): Promise<Read> {
  let head: Uint8Array;
  try {
    head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  } catch {
    return { kind: "binary" };
  }
  const kind = kindOf(head);
  if (kind === "zip") return { kind: "zip" };
  if (kind === "image") {
    if (file.size > MAX_IMAGE_BYTES) return { kind: "too_large", image: true };
    const sha256 = await sha256Hex(await file.arrayBuffer());
    const texts = await decodeAllQrFromBlob(file);
    const r = texts.length ? readQrTexts(texts) : null;
    return r?.kind === "accounts" ? { ...r, image: true, sha256 } : { kind: "noqr", image: true };
  }
  if (file.size > MAX_TEXT_BYTES) return { kind: "too_large" };
  let buf: ArrayBuffer;
  try {
    buf = await file.arrayBuffer();
  } catch {
    return { kind: "binary" };
  }
  const text = decodeText(new Uint8Array(buf));
  if (text === null) {
    const app = encryptedByName(file.name);
    return app ? { kind: "encrypted", app } : { kind: "binary" };
  }
  const r = readImportText(text);
  return r.kind === "accounts" ? { ...r, sha256: await sha256Hex(buf) } : r;
}

/** Reads one picked file. Never throws: a file that cannot be read is "binary". */
export async function readPicked(p: Picked, id: number): Promise<Source> {
  let read: Read;
  try {
    read = await outOf(p.file);
  } catch {
    read = { kind: "binary" };
  }
  const { image, sha256, ...out } = read;
  const seen: Seen = { size: p.file.size, lastModified: p.file.lastModified, ...(sha256 ? { sha256 } : {}) };
  return {
    id,
    name: p.file.name,
    handle: p.handle,
    seen,
    out,
    lines: out.kind === "accounts" ? out.lines : [],
    image: image === true,
    refused: out.kind === "accounts" ? out.skipped.length + out.types.reduce((n, k) => n + k.n, 0) : 0,
  };
}

/**
 * The codes the camera read, checked as a QR image's are (file-formats.ts readQrTexts, the one check every link goes
 * through: Steam, `&amp;`, a word run into the key): only the links it takes join the import.
 */
export const readScanned = (codes: readonly string[]): SourceOut => readQrTexts(codes);
