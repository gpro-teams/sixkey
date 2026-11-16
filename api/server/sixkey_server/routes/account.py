"""GET /v1/account and DELETE /v1/account (§3.1 step 3, §3.5, §3.12, §5.7)."""

from __future__ import annotations

import asyncio
import uuid

from ..auth_provider import ProviderUnavailable
from ..constants import STEP_UP_MAX_AGE_S
from ..errors import ApiError
from ..pipeline import Ctx
from .common import ms


async def get_account(ctx: Ctx) -> tuple[int, dict]:
    uid = uuid.UUID(ctx.session.sub)
    row = await ctx.pool.fetchrow(
        "SELECT v.created_at, (SELECT count(*) FROM sixkey.devices d WHERE d.user_id = v.user_id "
        "AND d.revoked_at IS NULL) AS n FROM sixkey.vaults v WHERE v.user_id = $1",
        uid,
    )
    if row is None:
        return 200, {"has_vault": False}
    return 200, {"has_vault": True, "vault_created_at": ms(row["created_at"]), "device_count": row["n"]}


async def delete_account(ctx: Ctx) -> tuple[int, None]:
    """Device signature + a fresh account session of the same account + pw_auth; then one auth-user
    delete, and ON DELETE CASCADE clears every row. A failure deletes nothing (§5.7 F12)."""
    s = ctx.session
    if s.sub != ctx.user_id or s.iat * 1000 < ctx.now - STEP_UP_MAX_AGE_S * 1000:
        raise ApiError("step_up_required")
    await ctx.enforce_proof()
    for attempt in (1, 2):
        try:
            await ctx.st.provider.delete_user(ctx.user_id)
            return 204, None
        except ProviderUnavailable:
            # transient, e.g. the cascade deadlocked with another device's write (A1): Postgres rolled
            # it back, so nothing was deleted. Retry once, then 503 + Retry-After (S7).
            if attempt == 2:
                raise
            await asyncio.sleep(0.05)
        except Exception:
            raise ApiError("internal_error") from None
    raise ApiError("internal_error")
