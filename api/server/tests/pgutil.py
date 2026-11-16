"""A real PostgreSQL for the tests: one fresh database per pytest session, migrated from scratch.

The cluster is the local one from scripts/pg.sh (or SIXKEY_TEST_ADMIN_DSN, any superuser DSN whose
database can be swapped). There is no SQLite or in-memory fallback: if Postgres is not running the
tests fail with the command to start it.
"""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass

import asyncpg

from sixkey_server.migrate import create_database, migrate, with_database

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.normpath(os.path.join(HERE, ".."))
PG_LOG = os.environ.get("SIXKEY_PG_LOG") or os.path.join(SERVER, ".pg", "postgres.log")


def admin_dsn() -> str:
    env = os.environ.get("SIXKEY_TEST_ADMIN_DSN")
    if env:
        return env
    run = os.path.join(SERVER, ".pg", "run")
    return f"postgresql://postgres@/postgres?host={run}&port={os.environ.get('SIXKEY_PGPORT', '55432')}"


def role_dsn(dsn: str, role: str) -> str:
    scheme, rest = dsn.split("://", 1)
    _, host = rest.split("@", 1)
    return f"{scheme}://{role}@{host}"


@dataclass(frozen=True)
class TestDb:
    name: str
    admin: str  # superuser on the test database
    api: str  # sixkey_api (what the server uses)
    fake_auth: str  # sixkey_fake_auth (what the FakeAuthProvider uses)


async def create_test_db() -> TestDb:
    base = admin_dsn()
    try:
        con = await asyncpg.connect(base)
        await con.close()
    except (OSError, asyncpg.PostgresError) as e:
        raise RuntimeError(f"PostgreSQL is not reachable ({type(e).__name__}); run: make pg-start") from None
    name = f"sixkey_test_{os.getpid()}_{secrets.token_hex(3)}"
    await create_database(base, name)
    admin = with_database(base, name)
    await migrate(admin, local_auth_stub=True)
    return TestDb(name, admin, role_dsn(admin, "sixkey_api"), role_dsn(admin, "sixkey_fake_auth"))


async def drop_test_db(db: TestDb) -> None:
    con = await asyncpg.connect(admin_dsn())
    try:
        await con.execute(f'DROP DATABASE IF EXISTS "{db.name}" WITH (FORCE)')
    finally:
        await con.close()


async def reset(db: TestDb) -> None:
    """Empty every table between tests: deleting all auth users cascades into all sixkey tables."""
    con = await asyncpg.connect(db.admin)
    try:
        await con.execute("TRUNCATE auth.users CASCADE")
    finally:
        await con.close()
