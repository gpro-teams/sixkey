"""The email-OTP account provider (§5.1 auth_provider.py, §5.2).

AuthProvider is the whole interface the API uses. M8 adds SupabaseAuthProvider with the same
methods; the Supabase call each method maps to is in its docstring. M4 ships FakeAuthProvider,
which keeps the same semantics on a local Postgres (auth.users stub) and in memory:

  send_otp          creates an unconfirmed user for any address (create_user: true) and one live code
  verify_otp        consumes the code, confirms the user, returns access + refresh token
  revoke_session    ends the session (logout scope=local): its refresh token stops working; the
                    access token itself stays valid until exp, exactly like a Supabase JWT
  delete_user       hard-deletes the auth user; ON DELETE CASCADE clears every sixkey row
  purge_unconfirmed deletes users that never confirmed and were created before the cutoff (T3)

Codes, tokens and emails are never logged. The fake writes codes to an in-memory inbox for tests,
and to a JSON-lines file only when one is configured (local e2e); create_app refuses that in
production.
"""

from __future__ import annotations

import abc
import hmac
import json
import secrets
import uuid
from dataclasses import dataclass, field

import asyncpg
import jwt
from cryptography.hazmat.primitives.asymmetric import ec

from .clock import Clock, to_dt
from .constants import ACCOUNT_SESSION_TTL_S


class ProviderUnavailable(Exception):
    """The provider could not be reached; the API answers 503 unavailable."""


@dataclass(frozen=True)
class Session:
    access_token: str
    refresh_token: str
    expires_at_ms: int
    user_id: str


class AuthProvider(abc.ABC):
    issuer: str

    @abc.abstractmethod
    def jwt_keys(self) -> dict[str, ec.EllipticCurvePublicKey]:
        """kid -> ES256 public key. Supabase: GET {url}/auth/v1/.well-known/jwks.json (cached)."""

    @abc.abstractmethod
    async def send_otp(self, email: str) -> None:
        """Supabase: POST /auth/v1/otp {email, create_user: true} (no client IP forwarded, §5.6)."""

    @abc.abstractmethod
    async def verify_otp(self, email: str, token: str) -> Session | None:
        """Supabase: POST /auth/v1/verify {type: "email", email, token}. None for a wrong or expired code."""

    @abc.abstractmethod
    async def revoke_session(self, access_token: str) -> None:
        """Supabase: POST /auth/v1/logout?scope=local with the access token as Bearer."""

    @abc.abstractmethod
    async def delete_user(self, user_id: str) -> None:
        """Supabase: DELETE /auth/v1/admin/users/{id} with the secret key (hard delete, §5.7)."""

    @abc.abstractmethod
    async def purge_unconfirmed(self, created_before_ms: int) -> int:
        """Delete users with no confirmed email created before the cutoff (§5.2 T3). Supabase: admin
        API (list + delete) or SQL run by the owner."""

    async def close(self) -> None:
        return None


@dataclass
class _Code:
    code: str
    expires_ms: int
    user_id: str


@dataclass
class _Sess:
    user_id: str
    refresh_token: str
    revoked: bool = False


@dataclass
class FakeAuthProvider(AuthProvider):
    """Local and test provider. pool connects as sixkey_fake_auth (the owner of auth.users)."""

    pool: asyncpg.Pool
    clock: Clock
    issuer: str = "http://127.0.0.1:8787/auth/v1"
    otp_ttl_s: int = 3600
    inbox_file: str | None = None
    inbox: dict[str, list[str]] = field(default_factory=dict)
    fail_delete: bool = False  # test hook: delete_user raises (§5.7, F12)
    unavailable: bool = False  # test hook: every call raises ProviderUnavailable

    def __post_init__(self) -> None:
        self._key = ec.generate_private_key(ec.SECP256R1())
        self.kid = secrets.token_hex(8)
        self._codes: dict[str, _Code] = {}
        self._sessions: dict[str, _Sess] = {}

    def jwt_keys(self) -> dict[str, ec.EllipticCurvePublicKey]:
        return {self.kid: self._key.public_key()}

    def _check(self) -> None:
        if self.unavailable:
            raise ProviderUnavailable()

    async def send_otp(self, email: str) -> None:
        self._check()
        now = self.clock.now_ms()
        async with self.pool.acquire() as con:
            uid = await con.fetchval(
                "INSERT INTO auth.users (email, created_at) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id",
                email,
                to_dt(now),
            )
            if uid is None:
                uid = await con.fetchval("SELECT id FROM auth.users WHERE email = $1", email)
        code = f"{secrets.randbelow(1_000_000):06d}"
        self._codes[email] = _Code(code, now + self.otp_ttl_s * 1000, str(uid))
        self.inbox.setdefault(email, []).append(code)
        if self.inbox_file:
            with open(self.inbox_file, "a", encoding="utf-8") as f:
                f.write(json.dumps({"email": email, "code": code}) + "\n")

    async def verify_otp(self, email: str, token: str) -> Session | None:
        self._check()
        now = self.clock.now_ms()
        c = self._codes.get(email)
        if c is None or c.expires_ms <= now or not hmac.compare_digest(c.code, token):
            return None
        del self._codes[email]  # single use
        async with self.pool.acquire() as con:
            n = await con.fetchval(
                "UPDATE auth.users SET email_confirmed_at = COALESCE(email_confirmed_at, $2) WHERE id = $1 RETURNING 1",
                uuid.UUID(c.user_id),
                to_dt(now),
            )
        if n is None:  # the user was deleted meanwhile
            return None
        return self._issue(c.user_id, email, now)

    def _issue(self, user_id: str, email: str, now: int) -> Session:
        sid = str(uuid.uuid4())
        refresh = secrets.token_urlsafe(32)
        self._sessions[sid] = _Sess(user_id, refresh)
        iat = now // 1000
        claims = {
            "iss": self.issuer,
            "aud": "authenticated",
            "sub": user_id,
            "iat": iat,
            "exp": iat + ACCOUNT_SESSION_TTL_S,
            "session_id": sid,
            "role": "authenticated",
            "is_anonymous": False,
            "email": email,
        }
        token = self.sign(claims)
        return Session(token, refresh, (iat + ACCOUNT_SESSION_TTL_S) * 1000, user_id)

    def sign(self, claims: dict, *, kid: str | None = None, key: ec.EllipticCurvePrivateKey | None = None) -> str:
        """Test helper as well: sign arbitrary claims with this provider's key."""
        return jwt.encode(claims, key or self._key, algorithm="ES256", headers={"kid": kid or self.kid})

    async def revoke_session(self, access_token: str) -> None:
        self._check()
        claims = jwt.decode(
            access_token,
            self._key.public_key(),
            algorithms=["ES256"],
            audience="authenticated",
            options={"verify_exp": False, "verify_iat": False, "verify_nbf": False},
        )
        s = self._sessions.get(claims["session_id"])
        if s is not None:
            s.revoked = True

    def refresh(self, refresh_token: str) -> bool:
        """Test helper: would this refresh token still work? (False once the session is revoked.)"""
        return any(s.refresh_token == refresh_token and not s.revoked for s in self._sessions.values())

    async def delete_user(self, user_id: str) -> None:
        self._check()
        if self.fail_delete:
            raise RuntimeError("injected delete_user failure")
        try:
            async with self.pool.acquire() as con:
                await con.execute("DELETE FROM auth.users WHERE id = $1", uuid.UUID(user_id))
        except (asyncpg.exceptions.DeadlockDetectedError, asyncpg.exceptions.SerializationError):
            raise ProviderUnavailable() from None  # rolled back: nothing deleted, safe to retry

    async def purge_unconfirmed(self, created_before_ms: int) -> int:
        self._check()
        async with self.pool.acquire() as con:
            rows = await con.fetch(
                "DELETE FROM auth.users WHERE email_confirmed_at IS NULL AND created_at < $1 RETURNING 1",
                to_dt(created_before_ms),
            )
        return len(rows)

    def last_code(self, email: str) -> str | None:
        codes = self.inbox.get(email)
        return codes[-1] if codes else None
