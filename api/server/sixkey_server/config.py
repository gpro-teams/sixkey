"""Configuration. Everything has a safe default; production values come from the environment (M8)."""

from __future__ import annotations

import dataclasses
import os
import re
import urllib.parse

MIN_CLIENT_VERSION_RE = re.compile(r"[0-9]{1,5}(\.[0-9]{1,5}){0,3}\Z")


@dataclasses.dataclass(frozen=True)
class RateLimits:
    """§5.5 defaults (x-sixkey-rate-limits); all configurable. (limit, window seconds)."""

    device_writes: tuple[int, int] = (30, 60)
    device_reads: tuple[int, int] = (60, 60)
    account_writes: tuple[int, int] = (600, 60)
    account_reads: tuple[int, int] = (1200, 60)
    invalid_proof_per_device: tuple[int, int] = (10, 60)
    otp_send_email_ip: tuple[int, int] = (3, 600)
    otp_send_email_ip_day: tuple[int, int] = (10, 86_400)
    otp_send_email_day: tuple[int, int] = (50, 86_400)
    otp_send_ip: tuple[int, int] = (20, 3600)
    otp_verify_code: int = 5
    otp_verify_ip: tuple[int, int] = (30, 3600)
    recovery_account_ip: tuple[int, int] = (5, 3600)
    recovery_account_day: tuple[int, int] = (50, 86_400)
    # Not in the contract table (docs/design/notes/M4-NOTES.md A21, B2): account-session endpoints get a per-session
    # bucket; requests with a valid pw_auth / recovery_auth (exempt from the per-device limits, S2) get a
    # per-account bucket of their own, revoke and rotate included; envelope writes have byte budgets: per
    # device (every signed envelope request without a valid proof, never refunded, so failing 8 MiB
    # write_denied floods are paid for) and per account (every envelope write, refunded on 401/403).
    session_writes: tuple[int, int] = (30, 60)
    session_reads: tuple[int, int] = (60, 60)
    proof_valid_account: tuple[int, int] = (60, 60)
    device_envelope_bytes: tuple[int, int] = (256 * 2**20, 3600)
    account_envelope_bytes: tuple[int, int] = (1024 * 2**20, 3600)
    # init's envelope bytes, per account session (re-review RR1; not in the contract yet). Not the
    # account's budget: a session only needs the email, and the email must not be able to use up the
    # budget the account's devices write against (D2).
    session_envelope_bytes: tuple[int, int] = (1024 * 2**20, 3600)


def api_host(origin: str) -> str:
    """URL.host of the configured API origin: lowercase host, port only when not the default (§5.2 N9)."""
    u = urllib.parse.urlsplit(origin)
    if u.scheme not in ("http", "https") or not u.hostname or u.path not in ("", "/") or u.query or u.fragment:
        raise ValueError("SIXKEY_API_ORIGIN must be scheme://host[:port]")
    host = u.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    default = 443 if u.scheme == "https" else 80
    if u.port is not None and u.port != default:
        host = f"{host}:{u.port}"
    return host


@dataclasses.dataclass(frozen=True)
class Settings:
    database_dsn: str
    api_origin: str = "https://api.sixkey.app"
    env: str = "production"  # dev | test | production; production-safe default (S12)
    db_pool_min: int = 1
    db_pool_max: int = 10
    db_statement_cache_size: int = 0  # 0 for a transaction pooler (§5.3)
    db_acquire_timeout_s: float = 5.0  # pool exhaustion -> 503 after this long (S10)
    large_body_slots: int = 8  # requests to the 9 MiB endpoints processed at once (S3)
    large_body_wait_s: float = 10.0  # waiting longer for a slot -> 503
    body_timeout_s: float = 60.0  # reading one request body (slow bodies) -> 503
    limiter_max_keys: int = 200_000  # bounded rate-limit memory (S5)
    cors_origins: tuple[str, ...] = ()  # chrome-extension://<id>, never a security decision
    min_client_version: str = "0.1.0"
    trusted_proxies: frozenset[str] = frozenset()  # peers whose single X-Forwarded-For is believed
    limits: RateLimits = RateLimits()
    devices_max_active: int = 200
    history_keep_versions: int = 30
    history_keep_days: int = 30
    history_max_bytes: int = 67_108_864
    # FakeAuthProvider only (local and tests).
    fake_auth_dsn: str | None = None
    fake_inbox_file: str | None = None
    jwt_issuer: str = "http://127.0.0.1:8787/auth/v1"

    def __post_init__(self) -> None:
        api_host(self.api_origin)
        if not MIN_CLIENT_VERSION_RE.match(self.min_client_version):
            raise ValueError("min_client_version must look like a Chrome manifest version")
        if self.env not in ("dev", "test", "production"):
            raise ValueError("env must be dev, test or production")

    @property
    def host(self) -> str:
        return api_host(self.api_origin)

    @staticmethod
    def from_env() -> "Settings":
        e = os.environ
        env = e.get("SIXKEY_ENV")
        if env not in ("dev", "test", "production"):
            raise SystemExit("SIXKEY_ENV must be set to dev, test or production")
        dsn = e.get("SIXKEY_DATABASE_DSN")
        if not dsn:
            raise SystemExit("SIXKEY_DATABASE_DSN is required (the sixkey_api role)")
        cors = tuple(x.strip() for x in e.get("SIXKEY_CORS_ORIGINS", "").split(",") if x.strip())
        proxies = frozenset(x.strip() for x in e.get("SIXKEY_TRUSTED_PROXIES", "").split(",") if x.strip())
        return Settings(
            database_dsn=dsn,
            api_origin=e.get("SIXKEY_API_ORIGIN", "http://127.0.0.1:8787"),
            env=env,
            db_pool_max=int(e.get("SIXKEY_DB_POOL_MAX", "10")),
            db_statement_cache_size=int(e.get("SIXKEY_DB_STATEMENT_CACHE_SIZE", "0")),
            cors_origins=cors,
            min_client_version=e.get("SIXKEY_MIN_CLIENT_VERSION", "0.1.0"),
            trusted_proxies=proxies,
            fake_auth_dsn=e.get("SIXKEY_FAKE_AUTH_DSN"),
            fake_inbox_file=e.get("SIXKEY_FAKE_INBOX_FILE"),
            jwt_issuer=e.get("SIXKEY_JWT_ISSUER", "http://127.0.0.1:8787/auth/v1"),
        )
