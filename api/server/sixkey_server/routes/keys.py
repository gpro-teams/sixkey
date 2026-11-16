"""KeyBundle: GET /v1/keys, PUT /v1/keys, POST /v1/keys/rotate (§2.3, §3.6-§3.8, §4.2 repair, §5.3).

Order inside both writes (docs/design/notes/M4-NOTES.md explains why):
  shape and kver range (422) -> byte-identical stored bundle = idempotent 200 (§3.6.0; before any
  proof, because a replay carries the proofs of the state it replaced) -> CAS preconditions (409,
  before the proofs so an honest race is not counted as a wrong password) -> write proof (rotate,
  403) -> pw_auth / recovery_auth (403, counted) -> keyless consistency: vaultId, vkId, by, P4 (422)
  -> one transaction (lock the device rows, CAS, ...).
"""

from __future__ import annotations

from .. import wire
from ..errors import ApiError
from ..pipeline import Ctx
from ..retention import prune
from .common import bump_devices_rev, delete_enrollments, hour_dt, lock_devices, lock_signer
from .vault import policy, version_conflict


async def get_keys(ctx: Ctx) -> tuple[int, dict]:
    row = await ctx.pool.fetchrow("SELECT kver, bundle FROM sixkey.vaults WHERE user_id = $1", ctx.uid)
    if row is None:
        raise ApiError("no_vault")
    return 200, {"kver": row["kver"], "bundle": row["bundle"]}


def _verifier(b: dict, key: str) -> bytes | None:
    return wire.b64d(b[key]) if key in b else None


async def put_keys(ctx: Ctx) -> tuple[int, dict]:
    b, c = ctx.body, ctx.st.contract
    bun = wire.bundle(c, b["bundle"])
    if_kver = b["if_kver"]
    if not wire.kver_in_range(if_kver, bun.kver):
        raise ApiError("invalid_request")
    v = await ctx.pool.fetchrow("SELECT vault_id, vk_id, kver, bundle FROM sixkey.vaults WHERE user_id = $1", ctx.uid)
    if v is None:
        raise ApiError("no_vault")
    if v["bundle"] == bun.text:
        return 200, {"kver": v["kver"]}
    if v["kver"] != if_kver:
        raise ApiError("keys_conflict")
    await ctx.enforce_proof()
    if bun.vault_id != v["vault_id"] or bun.vk_id != v["vk_id"] or bun.by != ctx.signer:
        raise ApiError("invalid_request")
    stored = wire.bundle(c, v["bundle"])
    wire.p4(stored, bun, "recovery_verifier" in b, "password_verifier" in b)
    rv, pv = _verifier(b, "recovery_verifier"), _verifier(b, "password_verifier")
    await ctx.st.pause("put_keys.before_tx")
    async with ctx.pool.acquire() as con, con.transaction():
        await lock_signer(con, ctx.uid, ctx.signer)
        kver = await con.fetchval(
            "UPDATE sixkey.vaults SET kver = $3, bundle = $4, recovery_verifier = COALESCE($5, recovery_verifier),"
            " password_verifier = COALESCE($6, password_verifier), updated_at = $7"
            " WHERE user_id = $1 AND kver = $2 RETURNING kver",
            ctx.uid,
            if_kver,
            bun.kver,
            bun.text,
            rv,
            pv,
            hour_dt(ctx.now),
        )
        if kver is None:
            now = await con.fetchrow("SELECT kver, bundle FROM sixkey.vaults WHERE user_id = $1", ctx.uid)
            if now["bundle"] == bun.text:
                return 200, {"kver": now["kver"]}
            raise ApiError("keys_conflict")
    return 200, {"kver": kver}


async def rotate(ctx: Ctx) -> tuple[int, dict]:
    """§3.8 P3 and the §4.2 repair: one transaction swaps envelope, vk_id, bundle, verifiers and
    write_key under a double CAS, writes history, re-encrypts device names, voids every enrollment."""
    b, c = ctx.body, ctx.st.contract
    if_version, if_kver = b["if_version"], b["if_kver"]
    env = wire.envelope(c, b["envelope"])
    bun = wire.bundle(c, b["bundle"])
    if env.rev != if_version + 1 or not wire.kver_in_range(if_kver, bun.kver):
        raise ApiError("invalid_request")
    v = await ctx.pool.fetchrow(
        "SELECT vault_id, version, vk_id, kver, bundle, write_key FROM sixkey.vaults WHERE user_id = $1", ctx.uid
    )
    if v is None:
        raise ApiError("no_vault")
    if v["bundle"] == bun.text:
        return 200, {"version": v["version"], "kver": v["kver"]}
    if v["kver"] != if_kver:
        raise ApiError("keys_conflict")
    if v["version"] != if_version:
        raise version_conflict(v)
    if not wire.write_proof_ok(bytes(v["write_key"]), v["vault_id"], if_version, env.checksum, b["write_proof"]):
        raise ApiError("write_denied")
    await ctx.enforce_proof()
    if env.vault_id != v["vault_id"] or bun.vault_id != v["vault_id"] or bun.vk_id != env.vk_id or bun.by != ctx.signer:
        raise ApiError("invalid_request")
    wire.p4(wire.bundle(c, v["bundle"]), bun, True, True)
    names: dict[str, str] = {}
    for d in b["device_names"]:
        if d["device_id"] in names:
            raise ApiError("invalid_request")
        names[d["device_id"]] = wire.name_ct(d["name_ct"], env.vk_id)
    rv, pv, nwk = (wire.b64d(b[k]) for k in ("recovery_verifier", "password_verifier", "new_write_key"))
    hour = hour_dt(ctx.now)
    await ctx.st.pause("rotate.before_tx")
    async with ctx.pool.acquire() as con, con.transaction():
        all_ids = [
            r["device_id"] for r in await con.fetch("SELECT device_id FROM sixkey.devices WHERE user_id = $1", ctx.uid)
        ]
        locked = await lock_devices(con, ctx.uid, all_ids + [ctx.signer])
        me = locked.get(ctx.signer)
        if me is None or me["revoked_at"] is not None:
            raise ApiError("device_revoked")
        if any(i not in locked for i in names):
            raise ApiError("invalid_request")
        version = await con.fetchval(
            "WITH upd AS ("
            "  UPDATE sixkey.vaults SET version = version + 1, vk_id = $4, envelope = $5, head = $6, size_bytes = $7,"
            "         kver = $8, bundle = $9, recovery_verifier = $10, password_verifier = $11, write_key = $12,"
            "         updated_at = $13"
            "   WHERE user_id = $1 AND version = $2 AND kver = $3"
            "  RETURNING user_id, version, vk_id, envelope, size_bytes)"
            " INSERT INTO sixkey.vault_versions (user_id, version, vk_id, envelope, size_bytes, created_at)"
            " SELECT user_id, version, vk_id, envelope, size_bytes, $13 FROM upd RETURNING version",
            ctx.uid,
            if_version,
            if_kver,
            env.vk_id,
            env.text,
            env.head,
            env.size_bytes,
            bun.kver,
            bun.text,
            rv,
            pv,
            nwk,
            hour,
        )
        if version is None:
            now = await con.fetchrow(
                "SELECT version, vk_id, kver, bundle FROM sixkey.vaults WHERE user_id = $1", ctx.uid
            )
            if now["bundle"] == bun.text:
                return 200, {"version": now["version"], "kver": now["kver"]}
            if now["kver"] != if_kver:
                raise ApiError("keys_conflict")
            raise version_conflict(now)
        if names:
            await con.executemany(
                "UPDATE sixkey.devices SET name_ct = $3 WHERE device_id = $1 AND user_id = $2",
                [(i, ctx.uid, n) for i, n in names.items()],
            )
            await bump_devices_rev(con, ctx.uid)
        await delete_enrollments(con, "user_id = $1", ctx.uid)
        await prune(con, ctx.uid, ctx.now, policy(ctx))
    return 200, {"version": version, "kver": bun.kver}
