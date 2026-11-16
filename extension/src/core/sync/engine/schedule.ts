// When the engine runs (SYNC-DESIGN §4.8, PLAN 6): pure decisions, no timers. The service worker (M5) turns a Wake into
// setTimeout (under 30 s: an MV3 worker lives at least that long) or chrome.alarms (30 s and more, which survive the
// worker being stopped); tests run them on a virtual clock. Everything that must survive a stopped worker is in
// sk_sync_state (kickAt, backoffUntil), and dirty is derived (§4.1), so a restarted worker simply asks again.
//   - "sync soon" after a local commit: a round 3 s later (debounce), and a 30 s alarm as the backstop;
//   - HOTP (§4.12) asks for an immediate round, no debounce;
//   - after n failures: min(30 min, 5 s × 2^n) ± 20 %; 429 and 503 follow Retry-After (never earlier); success resets;
//   - the 30-minute periodic alarm gets a random first phase (1–30 min) so dozens of profiles started together do not
//     hit the server at once.

export const DEBOUNCE_MS = 3_000;
export const KICK_BACKSTOP_MS = 30_000;
export const ALARM_MIN_MS = 30_000; // below this a setTimeout, at or above it an alarm
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 30 * 60 * 1000;
export const BACKOFF_JITTER = 0.2;
export const RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1000;
export const PERIODIC_MINUTES = 30;
/** The 409 retries inside one round (§4.2 step 6, §4.5) and their jitter. */
export const CONFLICT_RETRIES = 5;
export const CONFLICT_JITTER_MS = [200, 1000] as const;

export type Wake = { at: number; via: "timeout" | "alarm" };
export type WakeName = "sync" | "kick" | "retry";

/** What runs the engine's wakes (M5: setTimeout and chrome.alarms; tests: a virtual clock). */
export interface Scheduler {
  schedule(name: WakeName, wake: Wake): void;
  cancel(name: WakeName): void;
}

export const wakeAt = (now: number, at: number): Wake => ({ at, via: at - now < ALARM_MIN_MS ? "timeout" : "alarm" });

/** The delay after `failures` consecutive failures (n ≥ 1), with jitter from `rnd` in [0, 1): bounded by 30 min ± 20 %. */
export function backoffMs(failures: number, rnd: number): number {
  const n = Math.max(1, Math.min(30, Math.floor(failures)));
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** n);
  const r = Number.isFinite(rnd) ? Math.min(Math.max(rnd, 0), 1) : 0.5;
  return Math.round(base * (1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * r));
}

/** When to try again after a failure: the backoff, or Retry-After when the server asked for longer (never earlier). */
export function retryAt(now: number, failures: number, rnd: number, retryAfterS?: number): number {
  const b = backoffMs(failures, rnd);
  const ra =
    retryAfterS !== undefined && Number.isFinite(retryAfterS) && retryAfterS >= 0
      ? Math.min(retryAfterS * 1000, RETRY_AFTER_MAX_MS)
      : 0;
  return now + Math.max(b, ra);
}

/** The jitter between two 409 retries in a round. */
export const conflictDelay = (rnd: number): number =>
  Math.round(CONFLICT_JITTER_MS[0] + (CONFLICT_JITTER_MS[1] - CONFLICT_JITTER_MS[0]) * Math.min(Math.max(rnd, 0), 1));

/** The periodic alarm's first delay in minutes: 1 to 30, uniformly (§4.8). */
export const periodicPhaseMinutes = (rnd: number): number =>
  1 + Math.min(PERIODIC_MINUTES - 1, Math.floor(Math.min(Math.max(rnd, 0), 0.999999) * PERIODIC_MINUTES));

/**
 * The wakes after a "sync soon" at `now`: the debounced round, and the backstop alarm. `immediate` (HOTP, §4.12): now.
 * A backoff still running moves the round to its end (a failing server is not hammered by edits).
 */
export function kickWakes(
  now: number,
  o: { immediate?: boolean; backoffUntil?: number | null },
): { sync: Wake; kick: Wake } {
  const due = o.immediate ? now : now + DEBOUNCE_MS;
  const at = o.backoffUntil && o.backoffUntil > due ? o.backoffUntil : due;
  return { sync: wakeAt(now, at), kick: wakeAt(now, Math.max(at, now + KICK_BACKSTOP_MS)) };
}

/** Whether a wake at `now` may run a round: not before a running backoff ends (a user's explicit "sync now" may). */
export const mayRun = (now: number, backoffUntil: number | null | undefined, explicit = false): boolean =>
  explicit || !backoffUntil || now >= backoffUntil;
