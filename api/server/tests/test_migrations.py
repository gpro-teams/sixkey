"""Migrations apply cleanly to an empty database and are idempotent (runner and raw SQL)."""

from __future__ import annotations

import asyncpg
import pytest

import pgutil
from sixkey_server import migrate

CATALOG = """
SELECT 'col' AS k, table_schema || '.' || table_name || '.' || column_name || ':' || data_type || ':' ||
       is_nullable || ':' || coalesce(column_default, '') AS v
  FROM information_schema.columns WHERE table_schema IN ('sixkey', 'auth')
UNION ALL SELECT 'con', conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid)
  FROM pg_constraint WHERE connamespace IN ('sixkey'::regnamespace, 'auth'::regnamespace)
UNION ALL SELECT 'idx', schemaname || '.' || indexname || ':' || indexdef FROM pg_indexes WHERE schemaname IN ('sixkey', 'auth')
UNION ALL SELECT 'pol', tablename || ':' || policyname || ':' || roles::text FROM pg_policies WHERE schemaname = 'sixkey'
UNION ALL SELECT 'acl', relname || ':' || coalesce(relacl::text, '') FROM pg_class
  WHERE relnamespace IN ('sixkey'::regnamespace, 'auth'::regnamespace) AND relkind = 'r'
UNION ALL SELECT 'priv', 'public:' || has_schema_privilege('sixkey_api', 'public', 'CREATE')::text || ':' ||
       has_database_privilege('sixkey_api', current_database(), 'TEMP')::text
UNION ALL SELECT 'role', rolname || ':' || rolcanlogin || ':' || coalesce(array_to_string(rolconfig, ','), '')
  FROM pg_roles WHERE rolname IN ('sixkey_owner', 'sixkey_api', 'sixkey_fake_auth', 'anon', 'authenticated')
ORDER BY 1, 2
"""


@pytest.fixture
async def fresh():
    base = pgutil.admin_dsn()
    name = f"sixkey_mig_{__import__('secrets').token_hex(4)}"
    await migrate.create_database(base, name)
    dsn = migrate.with_database(base, name)
    yield dsn
    con = await asyncpg.connect(base)
    await con.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
    await con.close()


async def catalog(dsn):
    con = await asyncpg.connect(dsn)
    try:
        return [tuple(r) for r in await con.fetch(CATALOG)]
    finally:
        await con.close()


async def test_from_scratch_then_again(fresh):
    applied = await migrate.migrate(fresh, local_auth_stub=True)
    assert applied == ["local/0000_auth_stub.sql", "0001_sixkey.sql", "0002_least_privilege.sql"]
    first = await catalog(fresh)
    assert await migrate.migrate(fresh, local_auth_stub=True) == []  # recorded: nothing to do
    assert await catalog(fresh) == first
    # the SQL itself is idempotent: run every file twice more, bypassing the record
    con = await asyncpg.connect(fresh)
    try:
        for _ in range(2):
            for name in migrate.files(True):
                await con.execute(migrate.read(name))
    finally:
        await con.close()
    assert await catalog(fresh) == first
    kinds = {k for k, _ in first}
    assert kinds == {"col", "con", "idx", "pol", "acl", "priv", "role"}
    assert ("priv", "public:false:false") in first
    assert ("role", "sixkey_api:true:TimeZone=UTC") in first


async def test_a_changed_file_is_refused(fresh, monkeypatch):
    await migrate.migrate(fresh, local_auth_stub=True)
    real = migrate.read
    monkeypatch.setattr(migrate, "read", lambda n: real(n) + "\n-- edited\n" if n == "0001_sixkey.sql" else real(n))
    with pytest.raises(SystemExit):
        await migrate.migrate(fresh, local_auth_stub=True)


async def test_0002_fails_instead_of_silently_doing_nothing(fresh):
    """Re-review §5: run by a role that owns neither schema public nor the database (as can happen on
    Supabase), REVOKE ... FROM PUBLIC only WARNs and succeeds. 0002's post-condition must then raise, so
    the file is rolled back and not recorded; run by the owner it passes and removes the privileges."""
    await migrate.migrate(fresh, local_auth_stub=True)
    sql = migrate.read("0002_least_privilege.sql")
    con = await asyncpg.connect(fresh)
    try:
        tr = con.transaction()
        await tr.start()
        try:
            await con.execute("GRANT CREATE ON SCHEMA public TO PUBLIC")  # PostgreSQL 14's default
            await con.execute("CREATE ROLE sixkey_test_not_owner NOLOGIN")
            await con.execute("SET LOCAL ROLE sixkey_test_not_owner")
            with pytest.raises(asyncpg.RaiseError, match="sixkey_api still has CREATE"):
                await con.execute(sql)
        finally:
            await tr.rollback()  # the role and grant too
        async with con.transaction():
            await con.execute("GRANT CREATE ON SCHEMA public TO PUBLIC")
            assert await con.fetchval("SELECT has_schema_privilege('sixkey_api', 'public', 'CREATE')")
            await con.execute(sql)  # as the owner: it works
            assert not await con.fetchval("SELECT has_schema_privilege('sixkey_api', 'public', 'CREATE')")
        assert not await con.fetchval("SELECT 1 FROM pg_roles WHERE rolname = 'sixkey_test_not_owner'")
    finally:
        await con.close()


async def test_schema_has_the_doc_columns(fresh):
    await migrate.migrate(fresh, local_auth_stub=True)
    cols = {v.split(":")[0] for k, v in await catalog(fresh) if k == "col"}
    want = {
        "sixkey.vaults": [
            "user_id",
            "vault_id",
            "version",
            "vk_id",
            "envelope",
            "head",
            "devices_rev",
            "size_bytes",
            "kver",
            "bundle",
            "recovery_verifier",
            "password_verifier",
            "write_key",
            "history_bytes",
            "created_at",
            "updated_at",
        ],
        "sixkey.vault_versions": ["user_id", "version", "vk_id", "envelope", "size_bytes", "created_at"],
        "sixkey.devices": [
            "device_id",
            "user_id",
            "sig_pubkey",
            "name_ct",
            "joined_via",
            "approved_by",
            "created_at",
            "last_seen_at",
            "revoked_at",
            "auth_failures",
            "cursor",
        ],
        "sixkey.enrollments": [
            "request_id",
            "user_id",
            "via",
            "session_ref",
            "new_device_id",
            "new_sig_pubkey",
            "commit",
            "state",
            "approver_device_id",
            "approver_epk",
            "new_epk",
            "new_nonce",
            "new_name_ct",
            "transcript_hash",
            "payload",
            "name_ct",
            "created_at",
            "expires_at",
        ],
    }
    for t, cs in want.items():
        assert {c for c in cols if c.startswith(t + ".")} == {f"{t}.{c}" for c in cs}, t
    # no IP column anywhere, no revoked_by, no devices_changed_at (§5.6, T3, N15)
    names = {c.rsplit(".", 1)[1] for c in cols}
    assert not names & {"ip", "ip_address", "client_ip", "ip_hash", "user_agent", "revoked_by", "devices_changed_at"}
    assert not any(n.endswith("_ip") or n.startswith("ip_") for n in names)
    assert {c for c in cols if c.endswith(".email")} == {"auth.users.email"}  # only Supabase's own table
