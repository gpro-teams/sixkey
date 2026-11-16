"""Apply the migrations: python -m sixkey_server.migrate --dsn DSN [--local-auth-stub] [--create-db NAME]

Each file runs once, in its own transaction, and is recorded with its SHA-256 in sixkey_meta.applied
(a file that changed after it was applied is an error). The SQL itself is idempotent as well, so a
re-run of any file is harmless (tests/test_migrations.py runs every file twice).
The DSN is a migrating role: the local superuser, or Supabase's postgres role at M8.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import os

import asyncpg

HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATIONS = os.path.normpath(os.path.join(HERE, "..", "migrations"))
LOCAL_STUB = "local/0000_auth_stub.sql"


def files(local_auth_stub: bool) -> list[str]:
    main = sorted(f for f in os.listdir(MIGRATIONS) if f.endswith(".sql"))
    return ([LOCAL_STUB] if local_auth_stub else []) + main


def read(name: str) -> str:
    with open(os.path.join(MIGRATIONS, name), encoding="utf-8") as f:
        return f.read()


async def migrate(dsn: str, *, local_auth_stub: bool) -> list[str]:
    con = await asyncpg.connect(dsn)
    try:
        await con.execute(
            "CREATE SCHEMA IF NOT EXISTS sixkey_meta; REVOKE ALL ON SCHEMA sixkey_meta FROM PUBLIC; "
            "CREATE TABLE IF NOT EXISTS sixkey_meta.applied (name text PRIMARY KEY, sha256 text NOT NULL, "
            "applied_at timestamptz NOT NULL DEFAULT now())"
        )
        done = []
        for name in files(local_auth_stub):
            sql = read(name)
            sha = hashlib.sha256(sql.encode()).hexdigest()
            prior = await con.fetchval("SELECT sha256 FROM sixkey_meta.applied WHERE name = $1", name)
            if prior is not None:
                if prior != sha:
                    raise SystemExit(f"migration {name} changed after it was applied")
                continue
            async with con.transaction():
                await con.execute(sql)
                await con.execute("INSERT INTO sixkey_meta.applied (name, sha256) VALUES ($1, $2)", name, sha)
            done.append(name)
        return done
    finally:
        await con.close()


async def create_database(admin_dsn: str, name: str) -> None:
    con = await asyncpg.connect(admin_dsn)
    try:
        if not await con.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", name):
            await con.execute(f'CREATE DATABASE "{name}"')
    finally:
        await con.close()


def with_database(dsn: str, name: str) -> str:
    """Swap the database in a postgresql://user@/db?host=... DSN."""
    head, sep, query = dsn.partition("?")
    base = head.rsplit("/", 1)[0]
    return f"{base}/{name}{sep}{query}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", required=True, help="a migrating role's DSN (database = the target, or see --create-db)")
    ap.add_argument("--local-auth-stub", action="store_true", help="also apply the local auth.users stub")
    ap.add_argument("--create-db", metavar="NAME", help="create database NAME first and migrate it")
    a = ap.parse_args()
    dsn = a.dsn
    if a.create_db:
        asyncio.run(create_database(dsn, a.create_db))
        dsn = with_database(dsn, a.create_db)
    for name in asyncio.run(migrate(dsn, local_auth_stub=a.local_auth_stub)) or ["(nothing to apply)"]:
        print(name)


if __name__ == "__main__":
    main()
