"""Devices: list, rename, revoke, fork (§2.4, §3.10, §3.14, §4.10)."""

from __future__ import annotations

import json

import asyncpg

from .. import sigauth, wire
from ..errors import ApiError
from ..pipeline import Ctx, _msg
from .common import bump_devices_rev, day_ms, delete_enrollments, hour_dt, lock_signer, ms, vault_vk_id


async def list_devices(ctx: Ctx) -> tuple[int, dict]:
    rows = await ctx.pool.fetch(
        "SELECT device_id, name_ct, joined_via, approved_by, created_at, last_seen_at, revoked_at, auth_failures "
        "FROM sixkey.devices WHERE user_id = $1 ORDER BY created_at, device_id",
        ctx.uid,
    )
    return 200, {
        "current": ctx.signer,
        "devices": [
            {
                "device_id": r["device_id"],
                "name_ct": json.loads(r["name_ct"]) if r["name_ct"] is not None else None,
                "joined_via": r["joined_via"],
                "approved_by": r["approved_by"],
                "created_at": ms(r["created_at"]),
                "last_seen_at": day_ms(r["last_seen_at"]),
                "revoked_at": ms(r["revoked_at"]),
                "auth_failures": r["auth_failures"],
            }
            for r in rows
        ],
    }


def _target(ctx: Ctx) -> str:
    t = ctx.path_params.get("id", "")
    if not sigauth.DEVICE_ID_RE.match(t):
        raise ApiError("not_found")
    return t


async def rename(ctx: Ctx) -> tuple[int, dict]:
    """pw_auth for every rename, this device included (S8). The name must be under the current VK."""
    target = _target(ctx)
    await ctx.enforce_proof()
    async with ctx.pool.acquire() as con, con.transaction():
        locked = await lock_signer(con, ctx.uid, ctx.signer, target)
        if target not in locked:
            raise ApiError("not_found")
        name = wire.name_ct(ctx.body["name_ct"], await vault_vk_id(con, ctx.uid))
        await con.execute(
            "UPDATE sixkey.devices SET name_ct = $3 WHERE device_id = $1 AND user_id = $2", target, ctx.uid, name
        )
        await bump_devices_rev(con, ctx.uid)
    return 200, {}


async def revoke(ctx: Ctx) -> tuple[int, dict]:
    """Idempotent. revoked_at at hour precision; the device's unfinished approvals are void (§3.10)."""
    target = _target(ctx)
    await ctx.enforce_proof()
    async with ctx.pool.acquire() as con, con.transaction():
        locked = await lock_signer(con, ctx.uid, ctx.signer, target)
        t = locked.get(target)
        if t is None:
            raise ApiError("not_found")
        if t["revoked_at"] is not None:
            return 200, {"revoked_at": ms(t["revoked_at"])}
        hour = hour_dt(ctx.now)
        await con.execute(
            "UPDATE sixkey.devices SET revoked_at = $3 WHERE device_id = $1 AND user_id = $2", target, ctx.uid, hour
        )
        await bump_devices_rev(con, ctx.uid)  # the vault row before enrollment rows (lock order)
        await ctx.st.pause("revoke.between")
        await delete_enrollments(con, "user_id = $1 AND approver_device_id = $2", ctx.uid, target)
    return 200, {"revoked_at": ms(hour)}


async def fork(ctx: Ctx) -> tuple[int, dict]:
    """§4.10: a new identity for a cloned profile. Sixkey-New-Sig is the new key's signature over the
    same signing input as Sixkey-Sig (S5, N1); missing or wrong is 401 bad_signature."""
    b = ctx.body
    new_sig = sigauth.parse_sig(ctx.request.headers.get("sixkey-new-sig"))
    if new_sig is None:
        raise ApiError("bad_signature")
    new_key = wire.spki_public_key(wire.b64d(b["new_sig_pubkey"]))
    if not sigauth.verify(new_key, _msg(ctx, ctx.signer, "-", ctx.request.headers.get("sixkey-ts", "")), new_sig):
        raise ApiError("bad_signature")
    await ctx.enforce_proof()
    new_id, hour = b["new_device_id"], hour_dt(ctx.now)
    try:
        async with ctx.pool.acquire() as con, con.transaction():
            await lock_signer(con, ctx.uid, ctx.signer)
            name = wire.name_ct(b["name_ct"], await vault_vk_id(con, ctx.uid))
            if await con.fetchval("SELECT 1 FROM sixkey.devices WHERE device_id = $1", new_id):
                raise ApiError("device_exists")
            await bump_devices_rev(con, ctx.uid)  # also locks the vault row: device creation is serialized
            n = await con.fetchval(
                "SELECT count(*) FROM sixkey.devices WHERE user_id = $1 AND revoked_at IS NULL", ctx.uid
            )
            if n >= ctx.st.settings.devices_max_active:
                raise ApiError("too_many_devices")
            await ctx.st.pause("fork.before_insert")
            if not await con.fetchval(
                "INSERT INTO sixkey.devices (device_id, user_id, sig_pubkey, name_ct, joined_via, approved_by, "
                "created_at) VALUES ($1, $2, $3, $4, 'fork', $5, $6) ON CONFLICT (device_id) DO NOTHING RETURNING 1",
                new_id,
                ctx.uid,
                wire.b64d(b["new_sig_pubkey"]),
                name,
                ctx.signer,
                hour,
            ):
                raise ApiError("device_exists")  # S8: taken concurrently, decided without an ERROR
    except asyncpg.UniqueViolationError:
        raise ApiError("device_exists") from None
    return 201, {"device_id": new_id}
