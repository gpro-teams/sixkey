"""Protocol constants. tests/test_contract_constants.py asserts each one equals api/openapi.yaml."""

MAX_ENVELOPE_BYTES = 8_388_608  # §4.3, §5.3
MAX_BODY_BYTES_VAULT = 9_437_184  # §5.4 N13: init, PUT /v1/vault, rotate
MAX_BODY_BYTES_OTHER = 65_536  # §5.4 N13: everything else
KVER_MAX_JUMP = 65_536  # §2.3, §3.9 F-01
MAX_SAFE_INTEGER = 2**53 - 1
SIG_WINDOW_S = 300  # §5.2
ACCOUNT_SESSION_TTL_S = 900  # §5.2
STEP_UP_MAX_AGE_S = 600  # §3.12
ENROLL_TTL_S = 600  # §3.2
AUTH_FAILURES_CAP = 10  # §3.14
DEVICES_MAX_ACTIVE = 200  # §5.5
HISTORY_KEEP_VERSIONS = 30  # §5.8
HISTORY_KEEP_DAYS = 30  # §5.8
HISTORY_MAX_BYTES = 67_108_864  # §5.8 (64 MiB)
UNCONFIRMED_USER_TTL_S = 86_400  # §5.2 T3
DEVICE_NAME_CT_BYTES = 176  # §2.4
ENROLL_NAME_CT_BYTES = 188  # §3.2 (iv 12 + 160 + tag 16)

HOUR_MS = 3_600_000
DAY_MS = 86_400_000
MINUTE_MS = 60_000

PASSWORD_VERIFIER_PREFIX = b"sixkey-password-verifier|1|"
RECOVERY_VERIFIER_PREFIX = b"sixkey-recovery-verifier|1|"
SIGNING_PREFIX = "sixkey-req|1|"
WRITE_PROOF_PREFIX = "sixkey-write|1|"
