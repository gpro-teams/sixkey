// The PBKDF2 count of the master-password wraps that the write-order, crash and sync test worlds make (the service's
// `kdfIterations` test hook): the sync engine's own count and the read-time minimum. These tests are about the order of
// writes, not the count, and at the shipped count (PBKDF2_PASSWORD_WRAP_ITERATIONS, 2M; OWNER-DECISIONS/15) the unit
// suite took twice as long. The shipped count is tested where it matters: test/unit/own-password.test.ts (every key
// operation, a sync world at the production count), the services built as shipped (createRuntime) and every e2e spec
// (docs/design/notes/OWN-PASSWORD-NOTES.md §2.4).
export const TEST_KDF_ITERATIONS = 600_000;
