// QR codes read one after another by the camera (Settings > Add account > Scan with camera). One otpauth:// code ends
// the scan. Google Authenticator's export shows several codes (otpauth-migration://, each with batch_size, batch_index
// and batch_id): they are collected across reads, a repeated read of a code is taken once, a code of another export
// (another batch_id, or another size) is refused, and the scan ends once every code of the export is in. Pure: the
// state is a value, nothing is kept elsewhere, and no secret reaches an event (events carry positions only).
// docs/design/notes/IMPORT-FILE-NOTES.md §4.
import { parseMigrationUri } from "../totp/migration";

export type ScanState = {
  /** the export being collected, from its first code; null before one */
  batchId: number | null;
  size: number;
  /** the codes read so far, by batch index (zero based) */
  parts: ReadonlyMap<number, string>;
};

export type ScanEvent =
  | { k: "link"; text: string } // an otpauth:// code
  | { k: "part"; index: number; size: number; missing: number[] } // a new code of the export; `missing` zero based
  | { k: "done"; texts: string[] } // the export is complete: every code, in index order
  | { k: "repeat"; index: number } // a code of this export read again: nothing changes
  | { k: "other_batch" } // a code of another export: not taken
  | { k: "not_otp" }; // a QR code that is not a 2FA code, or an export code that cannot be read

export const EMPTY_SCAN: ScanState = { batchId: null, size: 0, parts: new Map() };

const missingOf = (size: number, parts: ReadonlyMap<number, string>) => {
  const out: number[] = [];
  for (let i = 0; i < size; i++) if (!parts.has(i)) out.push(i);
  return out;
};

/** What one read code does to the scan. The state is never changed in place. */
export function takeScan(s: ScanState, raw: string): { state: ScanState; event: ScanEvent } {
  const text = raw.trim();
  if (/^otpauth:\/\//i.test(text)) return { state: s, event: { k: "link", text } };
  if (!/^otpauth-migration:\/\//i.test(text)) return { state: s, event: { k: "not_otp" } };
  const m = parseMigrationUri(text);
  if (!m.ok) return { state: s, event: { k: "not_otp" } };
  const { batchId, batchIndex: index } = m.batch;
  const size = Math.max(1, m.batch.batchSize); // 0: an old export without the field, one code
  if (!Number.isSafeInteger(index) || index < 0 || index >= size) return { state: s, event: { k: "not_otp" } };
  if (s.batchId !== null && (batchId !== s.batchId || size !== s.size))
    return { state: s, event: { k: "other_batch" } };
  if (s.parts.has(index)) return { state: s, event: { k: "repeat", index } };
  const parts = new Map(s.parts).set(index, text);
  const state: ScanState = { batchId, size, parts };
  const missing = missingOf(size, parts);
  if (missing.length === 0)
    return { state, event: { k: "done", texts: [...parts.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]) } };
  return { state, event: { k: "part", index, size, missing } };
}

/**
 * A scan that goes on from the export codes already in the paste box (read before, by the camera or from images), so
 * a scan restarted after a stop knows which codes it still needs. Only when the box holds codes of exactly one export:
 * with none, or of several, the scan starts empty and locks onto the first code it reads.
 */
export function seedScan(text: string): ScanState {
  let s = EMPTY_SCAN;
  let ids = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^otpauth-migration:\/\//i.test(line)) continue;
    const m = parseMigrationUri(line);
    if (!m.ok) continue;
    if (s.batchId !== m.batch.batchId) ids++;
    if (ids > 1) return EMPTY_SCAN;
    const next = takeScan(s, line);
    if (next.event.k === "other_batch") return EMPTY_SCAN;
    s = next.state;
  }
  return s.parts.size && missingOf(s.size, s.parts).length ? s : EMPTY_SCAN;
}

/** The codes of an export read so far, in index order (to add what was read when the user stops early). */
export const scannedParts = (s: ScanState): string[] =>
  [...s.parts.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);

/** "Code 2 of 3": the position for the screen, and the missing codes counted from 1. */
export const scanProgress = (s: ScanState) => ({
  received: s.parts.size,
  size: s.size,
  missing: missingOf(s.size, s.parts).map((i) => i + 1),
});
