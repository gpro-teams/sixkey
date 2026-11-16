"""Database access. The API connects as sixkey_api (least privilege, §5.3 C2).

Every handler goes through Db, whose acquire() has a timeout: when the pool is exhausted a request
waits at most Settings.db_acquire_timeout_s and then gets 503 unavailable (S10), instead of queueing
forever. Driver exceptions are never logged or returned (§5.6 P7): they map to 503 unavailable
(connection trouble, pool timeout, deadlock or serialization failure, all transient: the client retries
on Retry-After) or 500 internal_error, and only the exception class name reaches the log.
"""

from __future__ import annotations

import asyncio
from typing import Any

import asyncpg

from .config import Settings
from .errors import ApiError

UNAVAILABLE = (
    asyncpg.exceptions.ConnectionDoesNotExistError,
    asyncpg.exceptions.CannotConnectNowError,
    asyncpg.exceptions.TooManyConnectionsError,
    asyncpg.exceptions.ConnectionFailureError,
    asyncpg.exceptions.InterfaceError,
    asyncpg.exceptions.DeadlockDetectedError,  # e.g. account deletion's cascade racing a write (A1, S7)
    asyncpg.exceptions.SerializationError,
    ConnectionError,
    OSError,
    asyncio.TimeoutError,
)


async def create_pool(settings: Settings) -> asyncpg.Pool:
    return await asyncpg.create_pool(
        settings.database_dsn,
        min_size=settings.db_pool_min,
        max_size=settings.db_pool_max,
        statement_cache_size=settings.db_statement_cache_size,
        command_timeout=60,
    )


class Db:
    """The pool with a bounded wait for a connection."""

    def __init__(self, pool: asyncpg.Pool, acquire_timeout_s: float) -> None:
        self._pool, self._timeout = pool, acquire_timeout_s

    def acquire(self) -> Any:
        return self._pool.acquire(timeout=self._timeout)

    async def fetchrow(self, query: str, *args: Any) -> asyncpg.Record | None:
        async with self.acquire() as con:
            return await con.fetchrow(query, *args)

    async def fetchval(self, query: str, *args: Any) -> Any:
        async with self.acquire() as con:
            return await con.fetchval(query, *args)

    async def fetch(self, query: str, *args: Any) -> list[asyncpg.Record]:
        async with self.acquire() as con:
            return await con.fetch(query, *args)

    async def execute(self, query: str, *args: Any) -> str:
        async with self.acquire() as con:
            return await con.execute(query, *args)


def map_exception(exc: BaseException) -> ApiError:
    if isinstance(exc, UNAVAILABLE):
        return ApiError("unavailable", retry_after=5)
    return ApiError("internal_error")
