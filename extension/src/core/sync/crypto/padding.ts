// Upload padding (§4.1) and the measures taken on the envelope text (§4.3, §5.3 head).
import { sha256, toB64, utf8 } from "../../crypto/bytes";
import type { EncryptedVault } from "../../crypto/envelope";
import { SYNC_CONSTANTS as C } from "./constants";

/** The next multiple of 16 KiB; a length already at a multiple stays (§4.1, N23). */
export function paddedLength(n: number): number {
  return Math.ceil(n / C.PAD_BUCKET_BYTES) * C.PAD_BUCKET_BYTES;
}

/** Plaintext followed by ASCII spaces up to paddedLength. JSON.parse ignores trailing whitespace, so the vault reads back unchanged. */
export function padPlaintext(plaintext: Uint8Array): Uint8Array {
  const out = new Uint8Array(paddedLength(plaintext.length)).fill(0x20);
  out.set(plaintext);
  return out;
}

/** The envelope travels and is stored as this exact text (§3.13); the server never re-serializes it. */
export const envelopeText = (envelope: EncryptedVault): string => JSON.stringify(envelope);

/** UTF-8 bytes of the envelope text: the one size measure, also the server's size_bytes (§4.3). */
export const envelopeSizeBytes = (text: string): number => utf8(text).length;

export const fitsEnvelopeLimit = (text: string): boolean => envelopeSizeBytes(text) <= C.MAX_ENVELOPE_BYTES;

/** head = SHA-256 of the stored envelope text, standard base64 (§4.1, D5). Different text for the same object is a different head. */
export async function envelopeHead(text: string): Promise<string> {
  return toB64(await sha256(utf8(text)));
}
