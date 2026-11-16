// The server-clock rules a page needs to show codes (SYNC-DESIGN §4.14, F5, S3), apart from the engine so that the popup
// can use them without loading any of it (the popup's module graph holds no engine module). Pure functions over
// the offset stored in sk_sync_state (server − local, ms); the engine (core/sync/engine/clock.ts) estimates and stores it.
//   - The offset is used only within ±7 days (local/state.ts MAX_OFFSET_MS), for the HLC, the clamp and signatures.
//   - TOTP keeps this machine's clock unless the user turned on "use the corrected time", and never corrects by more
//     than an hour: a server that lies about the time cannot make every synced device's codes wrong (S3).
import { MAX_OFFSET_MS } from "./state";

/** Above this the popup shows the clock banner (§4.14). */
export const TOTP_NOTICE_MS = 15_000;
/** The most a user may correct TOTP by (§4.14 S3). */
export const TOTP_CORRECTION_LIMIT_MS = 60 * 60 * 1000;

export const clampOffset = (ms: number): number =>
  Number.isFinite(ms) ? Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, Math.round(ms))) : 0;

/** S3: the offset TOTP uses. 0 unless the user chose the corrected time and the offset is within an hour. */
export function totpOffset(offsetMs: number, useCorrected: boolean): number {
  return useCorrected && Math.abs(offsetMs) <= TOTP_CORRECTION_LIMIT_MS ? clampOffset(offsetMs) : 0;
}

/** What the clock banner offers (§4.14): nothing, the switch, or the warning alone (more than an hour off). */
export function clockNotice(offsetMs: number): "none" | "offer_correction" | "warn_only" {
  const a = Math.abs(offsetMs);
  if (a <= TOTP_NOTICE_MS) return "none";
  return a <= TOTP_CORRECTION_LIMIT_MS ? "offer_correction" : "warn_only";
}
