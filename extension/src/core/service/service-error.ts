// The service's error, in its own module so the service's lazy parts (pin-admin.ts, device-unlock.ts, ...) and the service
// share it without a cycle.
export type ServiceErrorCode =
  | "locked"
  | "wrong_secret"
  | "bad_state"
  | "weak_password"
  | "already_protected"
  | "not_protected"
  // a rotation that would drop a previous key whose copies a pending cleanup has not reached (SYNC-DESIGN §0.0i req. 10)
  | "cleanup_pending"
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
