"""Roles, RLS and cascade (§5.3 C2, §8.4 "角色与 RLS"), and UTC sessions (N4).

The local cluster's default timezone is Asia/Kolkata (+05:30) on purpose (scripts/pg.sh): the API's
sessions are UTC only because the migration says ALTER ROLE sixkey_api SET timezone = 'UTC'.
"""

from __future__ import annotations

import uuid

import asyncpg
import pytest

import sk

TABLES = ("vaults", "vault_versions", "devices", "enrollments")


async def as_role(w, role: str, sql: str, *args):
    async with w.admin.acquire() as con, con.transaction():
        await con.execute(f"SET LOCAL ROLE {role}")
        return await con.fetch(sql, *args)


async def test_api_role_can_use_its_tables(world):
    w = world
    acct, dev, keys = await w.vault()
    async with w.pool.acquire() as con:
        for t in TABLES:
            await con.fetch(f"SELECT * FROM sixkey.{t} LIMIT 1")
        assert await con.fetchval("SELECT current_user") == "sixkey_api"
        assert not await con.fetchval("SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user")


@pytest.mark.parametrize("role", ["anon", "authenticated", "public"])
async def test_supabase_api_roles_see_nothing(world, role):
    w = world
    await w.vault()
    if role == "public":
        async with w.admin.acquire() as con:
            await con.execute("DROP ROLE IF EXISTS sixkey_test_nobody")
            await con.execute("CREATE ROLE sixkey_test_nobody NOLOGIN")
        role = "sixkey_test_nobody"
    try:
        for t in TABLES:
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await as_role(w, role, f"SELECT * FROM sixkey.{t}")
    finally:
        if role == "sixkey_test_nobody":
            await w.sql("DROP ROLE IF EXISTS sixkey_test_nobody")


async def test_api_role_has_no_ddl_truncate_or_auth_access(world):
    w = world
    await w.vault()
    async with w.pool.acquire() as con:
        for sql in (
            "TRUNCATE sixkey.vaults",
            "DROP TABLE sixkey.devices",
            "ALTER TABLE sixkey.vaults DISABLE ROW LEVEL SECURITY",
            "CREATE TABLE sixkey.x (a int)",
            "SELECT * FROM auth.users",
            "DELETE FROM auth.users",
            "SELECT * FROM sixkey_meta.applied",
        ):
            with pytest.raises((asyncpg.InsufficientPrivilegeError, asyncpg.exceptions.UndefinedTableError)):
                async with con.transaction():
                    await con.execute(sql)


async def test_rls_and_policies_are_in_place(world):
    w = world
    rows = await w.sql(
        "SELECT relname, relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) AS owner "
        "FROM pg_class WHERE relnamespace = 'sixkey'::regnamespace AND relkind = 'r'"
    )
    assert {r["relname"] for r in rows} == set(TABLES)
    assert all(r["relrowsecurity"] and not r["relforcerowsecurity"] and r["owner"] == "sixkey_owner" for r in rows)
    pol = await w.sql(
        "SELECT tablename, policyname, roles::text[] AS roles, qual, with_check FROM pg_policies "
        "WHERE schemaname = 'sixkey'"
    )
    assert {p["tablename"] for p in pol} == set(TABLES)
    assert all(p["roles"] == ["sixkey_api"] and p["qual"] == "true" and p["with_check"] == "true" for p in pol)
    # without the policy the API would see nothing: RLS is really on (rolled back afterwards)
    await w.vault()
    async with w.admin.acquire() as con:
        tr = con.transaction()
        await tr.start()
        try:
            await con.execute("SET LOCAL ROLE sixkey_api")
            assert await con.fetchval("SELECT count(*) FROM sixkey.vaults") == 1
            await con.execute("RESET ROLE")
            await con.execute("DROP POLICY sixkey_api_all ON sixkey.vaults")
            await con.execute("SET LOCAL ROLE sixkey_api")
            assert await con.fetchval("SELECT count(*) FROM sixkey.vaults") == 0
        finally:
            await tr.rollback()
    assert len(await w.sql("SELECT 1 FROM pg_policies WHERE tablename = 'vaults'")) == 1


async def test_owner_is_not_a_login_role(world):
    w = world
    r = (await w.sql("SELECT rolcanlogin FROM pg_roles WHERE rolname = 'sixkey_owner'"))[0]
    assert r["rolcanlogin"] is False


async def test_deleting_the_auth_user_cascades_through_rls(world):
    w = world
    acct, dev, keys = await w.vault()
    await w.recovery_device(acct, keys)
    await w.start_approval(acct)
    await w.api.put_vault(dev, keys, 1)
    acct2, _, _ = await w.vault()
    rows = await w.rows(acct.sub)
    assert all(rows[t] for t in rows)
    async with w.auth_pool.acquire() as con:  # as Supabase's auth service would
        await con.execute("DELETE FROM auth.users WHERE id = $1", uuid.UUID(acct.sub))
    assert all(v == [] for v in (await w.rows(acct.sub)).values())
    rows2 = await w.rows(acct2.sub)
    assert all(rows2[t] for t in ("auth.users", "sixkey.vaults", "sixkey.devices"))


async def test_api_sessions_are_utc_although_the_cluster_is_not(world):
    w = world
    async with w.pool.acquire() as con:
        assert await con.fetchval("SHOW timezone") == "UTC"
        h = await con.fetchval("SELECT extract(epoch FROM date_trunc('hour', now()))::bigint")
        assert h % 3600 == 0
    async with w.admin.acquire() as con:  # control: a +05:30 session truncates to :30 in UTC
        await con.execute("SET timezone = 'Asia/Kolkata'")
        h = await con.fetchval("SELECT extract(epoch FROM date_trunc('hour', now()))::bigint")
        assert h % 3600 == 1800
    # the cluster itself is not UTC (scripts/pg.sh), so the role setting is what made the API UTC
    assert await w.val("SELECT setting FROM pg_settings WHERE name = 'TimeZone'") == "Asia/Kolkata"


async def test_every_written_time_is_utc_hour_day_or_minute(world):
    w = world
    w.clock.set(1_792_055_555_555)  # not on any boundary
    acct, dev, keys = await w.vault()
    await w.api.put_vault(dev, keys, 1)
    await w.recovery_device(acct, keys)
    await w.start_approval(acct)
    await w.api.status(dev)
    other = await w.recovery_device(acct, keys)
    await w.api.call("POST", f"/v1/devices/{other.device_id}/revoke", {"password_auth": keys.pw_auth_b64}, dev=dev)
    H, D, M = 3_600_000, 86_400_000, 60_000

    def ms(v):
        return int(v.timestamp() * 1000)

    for r in await w.sql("SELECT created_at, updated_at FROM sixkey.vaults"):
        assert ms(r["created_at"]) % H == 0 and ms(r["updated_at"]) % H == 0
    for r in await w.sql("SELECT created_at FROM sixkey.vault_versions"):
        assert ms(r["created_at"]) % H == 0
    for r in await w.sql("SELECT created_at, revoked_at, last_seen_at FROM sixkey.devices"):
        assert ms(r["created_at"]) % H == 0
        assert r["revoked_at"] is None or ms(r["revoked_at"]) % H == 0
        assert r["last_seen_at"] is None or str(r["last_seen_at"]) == "2026-10-15"
    for r in await w.sql("SELECT created_at, expires_at FROM sixkey.enrollments"):
        assert ms(r["created_at"]) % M == 0 and ms(r["expires_at"]) % M == 0
    # and every time in every response
    devs = (await w.api.call("GET", "/v1/devices", dev=dev)).json()["devices"]
    for d in devs:
        assert d["created_at"] % H == 0 and (d["last_seen_at"] is None or d["last_seen_at"] % D == 0)
        assert d["revoked_at"] is None or d["revoked_at"] % H == 0


async def test_api_role_cannot_create_anything_anywhere(world):
    """S11: no CREATE in any schema (public included: PostgreSQL 14 grants it to PUBLIC unless revoked),
    no TEMP and no CREATE on the database; and the attempts really fail."""
    w = world
    schemas = [r["nspname"] for r in await w.sql("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_toast%'")]
    for n in schemas:
        assert not await w.val("SELECT has_schema_privilege('sixkey_api', $1, 'CREATE')", n), n
    for priv in ("TEMP", "CREATE"):
        assert not await w.val("SELECT has_database_privilege('sixkey_api', current_database(), $1)", priv), priv
    async with w.pool.acquire() as con:
        for sql in (
            "CREATE TABLE public.evil (a int)",
            "CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS 'SELECT 1'",
            "CREATE TEMP TABLE t (a int)",
            "CREATE SCHEMA evil",
        ):
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                async with con.transaction():
                    await con.execute(sql)
