// The one place the client reads sync limits from. Mirrors api/openapi.yaml x-sixkey-constants: a test asserts every
// value here equals the contract and that every constant the contract marks client- or both-enforced is present.
import { PBKDF2_MAX_ITERATIONS, PBKDF2_MIN_ITERATIONS } from "../../crypto/kdf";

export const SYNC_CONSTANTS = {
  MAX_ENVELOPE_BYTES: 8_388_608, // UTF-8 bytes of the envelope text (§4.3)
  PAD_BUCKET_BYTES: 16_384, // §4.1
  DEVICE_NAME_MAX_CODE_POINTS: 40, // §2.4, after NFKC
  DEVICE_NAME_PADDED_BYTES: 160, // §2.4
  DEVICE_NAME_CT_BYTES: 176, // 160 + GCM tag
  KEYRING_PREVIOUS_MAX: 64, // §2.3, §3.8 P1, §3.9 R3
  KVER_MAX_JUMP: 65_536, // §2.3, §3.9 R0/R1 (F-01)
  PBKDF2_MIN_ITERATIONS, // Phase 0 kdf.ts is the source; the contract repeats it
  PBKDF2_MAX_ITERATIONS,
  KDF_SALT_MIN_BYTES: 16,
  SIG_WINDOW_S: 300, // §5.2
  ENROLL_TTL_S: 600, // §3.2
  SAS_DIGITS: 6,
  SAS_ATTEMPTS: 3, // §3.2 M4
  AUTH_FAILURES_BANNER: 3, // §3.14
  ENTRY_LIMIT_ADD: 5000, // §3.13 C13
  ENTRY_LIMIT_PARSE: 50_000,
  TRUNC_HOUR_MS: 3_600_000, // §2.3 T1
  TRUNC_DAY_MS: 86_400_000,
  TRUNC_MINUTE_MS: 60_000,
} as const;
