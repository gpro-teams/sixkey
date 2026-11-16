"""GET /healthz, POST /v1/auth/otp, POST /v1/auth/verify (§5.2, §5.5)."""

from __future__ import annotations

import re

from ..errors import ApiError
from ..pipeline import Ctx

_LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
EMAIL_RE = re.compile(
    r"(?!\.)(?!.*\.\.)[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}(?<!\.)@"
    + _LABEL
    + r"(?:\."
    + _LABEL
    + r")*\.[A-Za-z]{2,63}\Z"
)


def valid_email(s: str) -> bool:
    return len(s) <= 254 and EMAIL_RE.match(s) is not None


async def healthz(ctx: Ctx) -> tuple[int, dict]:
    """Liveness only: no authentication and no database (§5.1, N22)."""
    return 200, {"ok": True}


def _hits(ctx: Ctx, rules: list[tuple[str, tuple[int, int]]]) -> None:
    """All-or-nothing: if one bucket is full, the ones already taken by this request are given back."""
    taken: list[str] = []
    for key, (limit, window) in rules:
        retry = ctx.st.limiter.hit(key, limit, window)
        if retry is not None:
            for k in taken:
                ctx.st.limiter.refund(k)
            raise ApiError("rate_limited", retry_after=retry)
        taken.append(key)


async def otp(ctx: Ctx) -> tuple[int, dict]:
    email = ctx.body["email"]
    if not valid_email(email):
        raise ApiError("invalid_email")
    email = email.lower()
    lim, L = ctx.st.settings.limits, ctx.st.limiter
    ip = ctx.client_ip()
    _hits(
        ctx,
        [
            (L.hkey("oei", email + "|" + ip), lim.otp_send_email_ip),
            (L.hkey("oeid", email + "|" + ip), lim.otp_send_email_ip_day),
            (L.hkey("oe", email), lim.otp_send_email_day),
            (L.hkey("oi", ip), lim.otp_send_ip),
        ],
    )
    await ctx.st.provider.send_otp(email)
    L.reset(L.hkey("ov", email))  # a new code gets its own 5 attempts
    return 202, {}


async def verify(ctx: Ctx) -> tuple[int, dict]:
    email, token = ctx.body["email"].lower(), ctx.body["token"]
    lim, L = ctx.st.settings.limits, ctx.st.limiter
    _hits(ctx, [(L.hkey("vi", ctx.client_ip()), lim.otp_verify_ip)])
    if not valid_email(email):
        raise ApiError("otp_invalid")
    # §5.5: 5 attempts per code, then the code is dead. The attempt is reserved BEFORE the provider is
    # awaited, so concurrent guesses cannot all pass the check (S1); a success is not refunded.
    n = L.incr(L.hkey("ov", email))
    if n is None:
        raise ApiError("rate_limited", retry_after=60)  # the counter table is full (contract limiter rule)
    if n > lim.otp_verify_code:
        raise ApiError("otp_invalid")
    session = await ctx.st.provider.verify_otp(email, token)
    if session is None:
        raise ApiError("otp_invalid")
    # §5.2 C1: end the Supabase session at once; only the access token leaves the server.
    await ctx.st.provider.revoke_session(session.access_token)
    return 200, {"account_token": session.access_token, "expires_at": session.expires_at_ms}
