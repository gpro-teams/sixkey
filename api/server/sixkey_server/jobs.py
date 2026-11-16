"""The daily job (§5.1 jobs.py): expired enrollments, unconfirmed auth users older than 24 hours
(T3), and history retention for every vault (§5.8). Run it once a day (cron, or pg_cron at M8):

    python -m sixkey_server.jobs        (needs SIXKEY_DATABASE_DSN and SIXKEY_FAKE_AUTH_DSN locally)

It prints counts only; never ids, emails or times.
"""

from __future__ import annotations

import asyncio

import asyncpg

from .auth_provider import AuthProvider, FakeAuthProvider
from .clock import Clock, to_dt
from .config import Settings
from .constants import UNCONFIRMED_USER_TTL_S
from .retention import Policy, prune
from .routes.common import delete_enrollments


async def run_daily(pool: asyncpg.Pool, provider: AuthProvider, clock: Clock, policy: Policy) -> dict[str, int]:
    now = clock.now_ms()
    async with pool.acquire() as con:
        expired = len(await delete_enrollments(con, "expires_at <= $1", to_dt(now)))
        users = [r["user_id"] for r in await con.fetch("SELECT user_id FROM sixkey.vaults")]
    unconfirmed = await provider.purge_unconfirmed(now - UNCONFIRMED_USER_TTL_S * 1000)
    versions = 0
    for uid in users:
        async with pool.acquire() as con, con.transaction():
            if await con.fetchval("SELECT 1 FROM sixkey.vaults WHERE user_id = $1 FOR UPDATE", uid):
                versions += await prune(con, uid, now, policy)
    return {"enrollments": expired, "unconfirmed_users": unconfirmed, "versions": versions}


async def _main() -> None:
    s = Settings.from_env()
    if s.env not in ("dev", "test"):
        raise SystemExit("production needs SupabaseAuthProvider (milestone M8); FakeAuthProvider is local only")
    pool = await asyncpg.create_pool(s.database_dsn, min_size=1, max_size=2, statement_cache_size=0)
    auth_pool = await asyncpg.create_pool(s.fake_auth_dsn, min_size=1, max_size=2, statement_cache_size=0)
    try:
        prov = FakeAuthProvider(auth_pool, Clock(), issuer=s.jwt_issuer)
        print(
            await run_daily(
                pool, prov, Clock(), Policy(s.history_keep_versions, s.history_keep_days, s.history_max_bytes)
            )
        )
    finally:
        await pool.close()
        await auth_pool.close()


if __name__ == "__main__":
    asyncio.run(_main())
