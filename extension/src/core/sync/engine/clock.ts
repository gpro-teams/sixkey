// Time with sync on (SYNC-DESIGN §4.14, F5, S3): pure decisions over the server's time samples.
//   - The offset (server − local) comes from every response (api.ts: body server_time, or the Date header), estimated at
//     the midpoint of the exchange, used only within ±7 days (local/state.ts MAX_OFFSET_MS) for the HLC, the clamp and
//     request signatures (refNow = now + offset).
//   - What TOTP and the clock banner do with it lives in local/time.ts, which the popup can load without the engine;
//     it is re-exported here for the engine and its tests.
import { clampOffset } from "../local/time";
import type { ServerTimeSample } from "./api";

export { clampOffset, clockNotice, TOTP_CORRECTION_LIMIT_MS, TOTP_NOTICE_MS, totpOffset } from "../local/time";

/** Offsets closer than this to the stored one are not written again (one write per real change, not per round). */
export const OFFSET_WRITE_THRESHOLD_MS = 1_000;

/** server − local at the midpoint of the exchange. */
export const offsetOf = (s: ServerTimeSample): number => clampOffset(s.serverMs - (s.sentAt + s.receivedAt) / 2);

/** refNow (§4.2): this machine's clock corrected by the (clamped) server offset. */
export const refNow = (now: number, offsetMs: number): number => now + clampOffset(offsetMs);
