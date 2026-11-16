// The service's error, in its own module so the sync flows (loaded on demand) and the service share it without a cycle.
export type ServiceErrorCode =
  | "locked"
  | "wrong_secret"
  | "bad_state"
  | "weak_password"
  | "already_protected"
  | "not_protected"
  // sync's local side (M2): an edit the server would refuse (§4.3), a merge the guard stops (§4.4, MergeBlocked), a
  // remote of another vault (I6), a merge past the parse limit (D7), a rotation that would drop a previous key whose
  // copies a pending cleanup has not reached (§0.0i req. 10), a Phase 0 key operation while sync is on (it must go
  // through the server first, §3.6–§3.8; §0.0i item 18)
  | "too_large_for_sync"
  | "review_needed"
  | "different_vault"
  | "too_large"
  | "cleanup_pending"
  | "sync_on"
  // a join whose kept vault would not fit on sk_prejoin's list (§3.5 ④; local/record-writers.ts KEPT_MAX)
  | "kept_full"
  // the PIN (QUICK-UNLOCK §5.4): a new PIN that is not 4 to 8 digits (one too easy to guess is taken since 2026-10-30,
  // OWNER-DECISIONS/20), and quick unlock not available here (a profile declared shared, §5.12 item 5; or a runtime
  // without it)
  | "bad_pin"
  | "quick_off";
export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ServiceError";
  }
}
