"""Account session: the Supabase access token returned once by /v1/auth/verify (§5.2, PLAN 7.1).

Checked exactly as for Supabase: ES256 only (alg whitelist; no HS256 key confusion, no 'none'),
the kid must be one of the provider's JWKS keys, aud = authenticated, iss, exp, iat, sub (a UUID),
session_id (a UUID; it keys "one pending enrollment per session"), and is_anonymous must not be true.
exp and iat are compared with the server's injectable clock.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass

import jwt
from cryptography.hazmat.primitives.asymmetric import ec

from .errors import ApiError

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
IAT_FUTURE_SKEW_S = 60


@dataclass(frozen=True)
class AccountSession:
    sub: str
    session_id: str
    iat: int
    exp: int


def bearer(header: str | None) -> str | None:
    if not header or not header.startswith("Bearer "):
        return None
    token = header[len("Bearer ") :]
    return token if token and " " not in token else None


def verify(token: str | None, keys: dict[str, ec.EllipticCurvePublicKey], issuer: str, now_ms: int) -> AccountSession:
    if not token or len(token) > 8192:
        raise ApiError("session_invalid")
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError:
        raise ApiError("session_invalid") from None
    if header.get("alg") != "ES256" or header.get("kid") not in keys:
        raise ApiError("session_invalid")
    try:
        claims = jwt.decode(
            token,
            keys[header["kid"]],
            algorithms=["ES256"],
            audience="authenticated",
            issuer=issuer,
            options={
                "require": ["exp", "iat", "sub", "aud", "iss"],
                "verify_exp": False,
                "verify_iat": False,
                "verify_nbf": False,
            },
        )
    except jwt.PyJWTError:
        raise ApiError("session_invalid") from None
    exp, iat, sub, sid = claims.get("exp"), claims.get("iat"), claims.get("sub"), claims.get("session_id")
    if not all(isinstance(x, int) and not isinstance(x, bool) for x in (exp, iat)):
        raise ApiError("session_invalid")
    if exp * 1000 <= now_ms or iat * 1000 > now_ms + IAT_FUTURE_SKEW_S * 1000:
        raise ApiError("session_invalid")
    if not isinstance(sub, str) or not UUID_RE.match(sub) or not isinstance(sid, str):
        raise ApiError("session_invalid")
    try:
        uuid.UUID(sid)
    except ValueError:
        raise ApiError("session_invalid") from None
    # exactly what a signed-in Supabase user's access token carries (no audience lists, no missing role)
    if (
        claims.get("is_anonymous") is True
        or claims.get("role") != "authenticated"
        or claims.get("aud") != "authenticated"
    ):
        raise ApiError("session_invalid")
    return AccountSession(sub=sub, session_id=sid.lower(), iat=iat, exp=exp)
