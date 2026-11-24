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
  | "quick_off"
  // the PIN typed again for something done while unlocked (VaultService.confirmSecret, OWNER-DECISIONS/26): wrong (the
  // message: the tries left), not 4 to 8 digits (a typo, not counted), its 5th wrong one (the PIN ended), or it no longer
  // confirms (ended, or set up again in another page): the master password then
  | "pin_wrong"
  | "pin_typo"
  | "pin_exhausted"
  | "pin_ended";
export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ServiceError";
  }
}
