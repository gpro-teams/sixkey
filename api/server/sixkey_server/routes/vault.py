"""Vault: init, status, head, CAS PUT, history (§3.1, §4.2, §4.10, §5.3, §5.8)."""

from __future__ import annotations

import re

import asyncpg

from .. import wire
from ..clock import to_date, to_dt
from ..errors import ApiError
from ..pipeline import Ctx
from ..retention import Policy, prune
from .common import hour_dt, lock_signer, ms

VERSION_RE = re.compile(r"[1-9][0-9]{0,18}\Z")
MAX_BIGINT = 2**63 - 1


def policy(ctx: Ctx) -> Policy:
    s = ctx.st.settings
    return Policy(s.history_keep_versions, s.history_keep_days, s.history_max_bytes)


class _Retry(Exception):
    pass


def version_conflict(row: asyncpg.Record) -> ApiError:
    return ApiError("version_conflict", version=row["version"], vk_id=row["vk_id"], kver=row["kver"])


# ------------------------------------------------------------------------------------- init


async def init(ctx: Ctx) -> tuple[int, dict]:
    """§3.1 step 6. Idempotent on the raw request (D4): same vault_id, device_id, sig_pubkey and
    bundle text -> the same 201; anything else with a vault present -> 409 vault_exists."""
    b, c = ctx.body, ctx.st.contract
    vault_id, dev = b["vault_id"], b["device"]
    env = wire.envelope(c, b["envelope"])
    bun = wire.bundle(c, b["bundle"])
    if env.vault_id != vault_id or env.rev != 1:
        raise ApiError("invalid_request")
    if bun.kver != 1 or bun.vault_id != vault_id or bun.vk_id != env.vk_id or bun.by != dev["device_id"]:
        raise ApiError("invalid_request")
    name = wire.name_ct(dev["name_ct"], env.vk_id)
    spki = wire.b64d(dev["sig_pubkey"])
    rv, pv, wk = (wire.b64d(b[k]) for k in ("recovery_verifier", "password_verifier", "write_key"))
    hour = hour_dt(ctx.now)
    for attempt in (1, 2):
        try:
            async with ctx.pool.acquire() as con, con.transaction():
                existing = await con.fetchrow(
                    "SELECT vault_id, bundle FROM sixkey.vaults WHERE user_id = $1 FOR UPDATE", ctx.uid
                )
                if existing is not None:
                    d = await con.fetchrow(
                        "SELECT user_id, sig_pubkey FROM sixkey.devices WHERE device_id = $1", dev["device_id"]
                    )
                    if (
                        existing["vault_id"] == vault_id
                        and existing["bundle"] == bun.text
                        and d is not None
                        and d["user_id"] == ctx.uid
                        and bytes(d["sig_pubkey"]) == spki
                    ):
                        return 201, {"version": 1, "kver": 1}
                    raise ApiError("vault_exists")
                if await con.fetchval("SELECT 1 FROM sixkey.devices WHERE device_id = $1", dev["device_id"]):
                    raise ApiError("device_exists")
                await ctx.st.pause("init.checked")
                # ON CONFLICT DO NOTHING: an expected conflict is a decision, not an ERROR whose DETAIL
                # would carry ids into the Postgres log (S8)
                if not await con.fetchval(
                    "INSERT INTO sixkey.vaults (user_id, vault_id, version, vk_id, envelope, head, devices_rev, "
                    "size_bytes, kver, bundle, recovery_verifier, password_verifier, write_key, history_bytes, "
                    "created_at, updated_at) VALUES ($1, $2, 1, $3, $4, $5, 1, $6, 1, $7, $8, $9, $10, $11, $12, $12)"
                    " ON CONFLICT (user_id) DO NOTHING RETURNING 1",
                    ctx.uid,
                    vault_id,
                    env.vk_id,
                    env.text,
                    env.head,
                    env.size_bytes,
                    bun.text,
                    rv,
                    pv,
                    wk,
                    env.size_bytes,
                    hour,
                ):
                    raise _Retry()  # a concurrent init of the same account won: decide again
                await con.execute(
                    "INSERT INTO sixkey.vault_versions (user_id, version, vk_id, envelope, size_bytes, created_at) "
                    "VALUES ($1, 1, $2, $3, $4, $5)",
                    ctx.uid,
                    env.vk_id,
                    env.text,
                    env.size_bytes,
                    hour,
                )
                if not await con.fetchval(
                    "INSERT INTO sixkey.devices (device_id, user_id, sig_pubkey, name_ct, joined_via, created_at) "
                    "VALUES ($1, $2, $3, $4, 'first', $5) ON CONFLICT (device_id) DO NOTHING RETURNING 1",
                    dev["device_id"],
                    ctx.uid,
                    spki,
                    name,
                    hour,
                ):
                    raise ApiError("device_exists")  # rolls the vault insert back
            return 201, {"version": 1, "kver": 1}
        except _Retry:
            if attempt == 2:
                raise ApiError("vault_exists") from None
        except asyncpg.UniqueViolationError as e:  # not expected any more; kept as a race fallback
            if e.constraint_name == "devices_pkey":
                raise ApiError("device_exists") from None
            if attempt == 2:
                raise ApiError("vault_exists") from None
            # a concurrent init of the same account won the insert: decide again against what it stored
        except asyncpg.ForeignKeyViolationError:
            raise ApiError("session_invalid") from None  # the auth user is gone
    raise ApiError("vault_exists")


# ------------------------------------------------------------------------------------- reads


async def status(ctx: Ctx) -> tuple[int, dict]:
    """Read-only except last_seen_at, written at most once per UTC day (§5.3 T2)."""
    row = await ctx.pool.fetchrow(
        "SELECT version, head, vk_id, kver, devices_rev FROM sixkey.vaults WHERE user_id = $1", ctx.uid
    )
    if row is None:
        raise ApiError("no_vault")
    pending = await ctx.pool.fetchval(
        "SELECT count(*) FROM sixkey.enrollments WHERE user_id = $1 AND via = 'approval' AND state = 'pending' "
        "AND expires_at > $2",
        ctx.uid,
        to_dt(ctx.now),
    )
    today = to_date(ctx.now)
    await ctx.pool.execute(
        "UPDATE sixkey.devices SET last_seen_at = $2 WHERE device_id = $1 AND (last_seen_at IS NULL OR last_seen_at < $2)",
        ctx.signer,
        today,
    )
    return 200, {
        "version": row["version"],
        "head": wire.b64e(bytes(row["head"])),
        "vk_id": row["vk_id"],
        "kver": row["kver"],
        "pending_enrollments": pending,
        "devices_rev": row["devices_rev"],
        "min_client_version": ctx.st.settings.min_client_version,
    }


async def get_vault(ctx: Ctx) -> tuple[int, dict]:
    row = await ctx.pool.fetchrow("SELECT version, envelope FROM sixkey.vaults WHERE user_id = $1", ctx.uid)
    if row is None:
        raise ApiError("no_vault")
    return 200, {"version": row["version"], "envelope": row["envelope"]}


async def list_versions(ctx: Ctx) -> tuple[int, dict]:
    async with ctx.pool.acquire() as con:
        if not await con.fetchval("SELECT 1 FROM sixkey.vaults WHERE user_id = $1", ctx.uid):
            raise ApiError("no_vault")
        rows = await con.fetch(
            "SELECT version, vk_id, size_bytes, created_at FROM sixkey.vault_versions WHERE user_id = $1 "
            "ORDER BY version DESC",
            ctx.uid,
        )
    return 200, {
        "versions": [
            {
                "version": r["version"],
                "vk_id": r["vk_id"],
                "size_bytes": r["size_bytes"],
                "created_at": ms(r["created_at"]),
            }
            for r in rows
        ]
    }


async def get_version(ctx: Ctx) -> tuple[int, dict]:
    v = ctx.path_params.get("v", "")
    if not VERSION_RE.match(v) or int(v) > MAX_BIGINT:
        raise ApiError("not_found")
    async with ctx.pool.acquire() as con:
        if not await con.fetchval("SELECT 1 FROM sixkey.vaults WHERE user_id = $1", ctx.uid):
            raise ApiError("no_vault")
        row = await con.fetchrow(
            "SELECT version, envelope FROM sixkey.vault_versions WHERE user_id = $1 AND version = $2", ctx.uid, int(v)
        )
    if row is None:
        raise ApiError("not_found")
    return 200, {"version": row["version"], "envelope": row["envelope"]}


# ------------------------------------------------------------------------------------- PUT


def _cursor_step(stored: bytes | None, cur: bytes | None, pending: bytes) -> tuple[bytes | None, bool]:
    """§4.10 clone soft detection -> (value to store or None for unchanged, forked)."""
    if stored is None:
        return pending, False  # first write of this identity starts a chain
    if cur is not None and stored == cur:
        return pending, False
    if stored == pending:
        return None, False  # the client did not see our last 200
    return None, True  # another copy of this identity wrote


async def put_vault(ctx: Ctx) -> tuple[int, dict]:
    """§5.3 CAS. Checked before the transaction: envelope (rev = if_version + 1, vaultId, checksum,
    size), CAS preconditions (409 with the server's state), then the write proof (403)."""
    b, c = ctx.body, ctx.st.contract
    if_version = b["if_version"]
    env = wire.envelope(c, b["envelope"])
    if env.rev != if_version + 1:
        raise ApiError("invalid_request")
    v = await ctx.pool.fetchrow(
        "SELECT vault_id, version, vk_id, kver, write_key FROM sixkey.vaults WHERE user_id = $1", ctx.uid
    )
    if v is None:
        raise ApiError("no_vault")
    if env.vault_id != v["vault_id"]:
        raise ApiError("invalid_request")
    if v["version"] != if_version:
        raise version_conflict(v)
    if v["vk_id"] != env.vk_id:
        raise ApiError("vk_mismatch")
    if not wire.write_proof_ok(bytes(v["write_key"]), v["vault_id"], if_version, env.checksum, b["write_proof"]):
        raise ApiError("write_denied")
    cursor = b["cursor"]
    pending = wire.b64d(cursor["pending"])
    cur = wire.b64d(cursor["cur"]) if "cur" in cursor else None
    hour = hour_dt(ctx.now)
    await ctx.st.pause("put_vault.before_tx")
    async with ctx.pool.acquire() as con, con.transaction():
        me = (await lock_signer(con, ctx.uid, ctx.signer))[ctx.signer]
        await ctx.st.pause("put_vault.locked")
        new_version = await con.fetchval(
            "WITH upd AS ("
            "  UPDATE sixkey.vaults SET version = version + 1, envelope = $2, head = $3, size_bytes = $4,"
            "         updated_at = $5"
            "   WHERE user_id = $1 AND version = $6 AND vk_id = $7"
            "  RETURNING user_id, version, vk_id, envelope, size_bytes)"
            " INSERT INTO sixkey.vault_versions (user_id, version, vk_id, envelope, size_bytes, created_at)"
            " SELECT user_id, version, vk_id, envelope, size_bytes, $5 FROM upd RETURNING version",
            ctx.uid,
            env.text,
            env.head,
            env.size_bytes,
            hour,
            if_version,
            env.vk_id,
        )
        if new_version is None:
            now = await con.fetchrow("SELECT version, vk_id, kver FROM sixkey.vaults WHERE user_id = $1", ctx.uid)
            if now["version"] != if_version:
                raise version_conflict(now)
            raise ApiError("vk_mismatch")
        stored = bytes(me["cursor"]) if me["cursor"] is not None else None
        new_cursor, forked = _cursor_step(stored, cur, pending)
        if new_cursor is not None:
            await con.execute("UPDATE sixkey.devices SET cursor = $2 WHERE device_id = $1", ctx.signer, new_cursor)
        await prune(con, ctx.uid, ctx.now, policy(ctx))
    return 200, {"version": new_version, "forked": forked}


# ------------------------------------------------------------------------------------- clear history


async def delete_versions(ctx: Ctx) -> tuple[int, dict]:
    """§5.8 C1: delete every history row except the head; idempotent; pw_auth."""
    await ctx.enforce_proof()
    await ctx.st.pause("delete_versions.before_tx")
    async with ctx.pool.acquire() as con, con.transaction():
        await lock_signer(con, ctx.uid, ctx.signer)
        head = await con.fetchrow(
            "SELECT version, size_bytes FROM sixkey.vaults WHERE user_id = $1 FOR UPDATE", ctx.uid
        )
        await ctx.st.pause("delete_versions.locked")
        if head is None:
            raise ApiError("no_vault")
        rows = await con.fetch(
            "DELETE FROM sixkey.vault_versions WHERE user_id = $1 AND version <> $2 RETURNING 1",
            ctx.uid,
            head["version"],
        )
        await con.execute("UPDATE sixkey.vaults SET history_bytes = $2 WHERE user_id = $1", ctx.uid, head["size_bytes"])
    return 200, {"deleted": len(rows)}
