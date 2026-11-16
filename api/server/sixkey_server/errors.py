"""API error codes (x-sixkey-error-codes). The code fixes the status; details live inside "error"."""

from __future__ import annotations

STATUS: dict[str, int] = {
    "invalid_email": 400,
    "invalid_request": 422,
    "otp_invalid": 401,
    "session_invalid": 401,
    "step_up_required": 401,
    "bad_signature": 401,
    "unknown_device": 401,
    "clock_skew": 401,
    "device_revoked": 403,
    "write_denied": 403,
    "password_mismatch": 403,
    "recovery_mismatch": 403,
    "no_vault": 404,
    "not_found": 404,
    "vault_exists": 409,
    "device_exists": 409,
    "version_conflict": 409,
    "vk_mismatch": 409,
    "keys_conflict": 409,
    "one_per_session": 409,
    "enroll_state": 409,
    "too_many_devices": 409,
    "enroll_gone": 410,
    "too_large": 413,
    "key_mismatch": 422,
    "rate_limited": 429,
    "internal_error": 500,
    "unavailable": 503,
}

# The only detail members the contract allows inside "error" (ErrorBody.error.additionalProperties = false).
DETAIL_KEYS = {"retry_after", "version", "vk_id", "kver", "handled_by"}


class ApiError(Exception):
    """Raised anywhere in a request; the pipeline turns it into the contract's error body."""

    def __init__(self, code: str, **details: object) -> None:
        if code not in STATUS:
            raise ValueError(f"unknown error code {code}")
        bad = set(details) - DETAIL_KEYS
        if bad:
            raise ValueError(f"error details not in the contract: {sorted(bad)}")
        super().__init__(code)
        self.code = code
        self.status = STATUS[code]
        self.details = {k: v for k, v in details.items() if v is not None}

    def __repr__(self) -> str:  # never carries user data, only the code
        return f"ApiError({self.code})"
