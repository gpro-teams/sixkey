"""Enrollment (§3.2 approval, §3.3 recovery code; state machine pending -> responded -> revealed ->
approved, then complete creates the device row and deletes the request).

- Every UPDATE/DELETE that advances a request carries "expires_at > now" (P6); a request that expired
  but was not yet deleted can never be advanced. Expired rows are deleted on access and daily.
- Unknown requests, other accounts' requests and expired ones are all 410 enroll_gone (no oracle).
- One request per account session (unique index on (user_id, session_ref), F8).
- The server checks what it can without keys: the formats of the public keys, the single approver,
  sig_pubkey_sha256 = SHA-256(new_sig_pubkey) (422 key_mismatch). It does not recompute h (P1).
- Recovery-code requests (via = recovery) are created already approved and are not polled.
"""

from __future__ import annotations

import re
import uuid

import asyncpg

from .. import wire
from ..clock import minute_ceil, minute_floor, to_dt
from ..constants import ENROLL_TTL_S
from ..errors import ApiError
from ..pipeline import Ctx
from .common import bump_devices_rev, delete_enrollments, hour_dt, lock_signer, ms, vault_vk_id

RID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")


def _rid(ctx: Ctx) -> uuid.UUID:
    r = ctx.path_params.get("rid", "")
    if not RID_RE.match(r):
        raise ApiError("enroll_gone")
    return uuid.UUID(r)


def _session_ref(ctx: Ctx) -> bytes:
    return wire.sha256(ctx.session.session_id.encode())


def _times(ctx: Ctx) -> tuple:
    """created_at at minute precision (C14); expires_at rounded up to the minute so the stored row
    carries nothing finer either and the request lives at least ENROLL_TTL_S."""
    return to_dt(minute_floor(ctx.now)), to_dt(minute_ceil(ctx.now + ENROLL_TTL_S * 1000))


async def _gone_or(con: asyncpg.Connection, ctx: Ctx, rid: uuid.UUID, uid: uuid.UUID) -> asyncpg.Record:
    """After a guarded UPDATE matched nothing: 410 for gone/expired/foreign, else the row (for 409)."""
    row = await con.fetchrow("SELECT * FROM sixkey.enrollments WHERE request_id = $1 AND user_id = $2", rid, uid)
    if row is None or row["via"] != "approval":
        raise ApiError("enroll_gone")
    if row["expires_at"] <= to_dt(ctx.now):
        await con.execute("DELETE FROM sixkey.enrollments WHERE request_id = $1", rid)
        raise ApiError("enroll_gone")
    return row


# ------------------------------------------------------------------------------------- M1: create


async def create(ctx: Ctx) -> tuple[int, dict]:
    b = ctx.body
    uid = uuid.UUID(ctx.session.sub)
    if not await ctx.pool.fetchval("SELECT 1 FROM sixkey.vaults WHERE user_id = $1", uid):
        raise ApiError("no_vault")
    created, expires = _times(ctx)
    try:
        async with ctx.pool.acquire() as con, con.transaction():
            await delete_enrollments(con, "user_id = $1 AND expires_at <= $2", uid, to_dt(ctx.now))
            if await con.fetchval("SELECT 1 FROM sixkey.devices WHERE device_id = $1", b["device_id"]):
                raise ApiError("device_exists")
            rid = await con.fetchval(
                "INSERT INTO sixkey.enrollments (user_id, via, session_ref, new_device_id, new_sig_pubkey, commit, "
                "state, created_at, expires_at) VALUES ($1, 'approval', $2, $3, $4, $5, 'pending', $6, $7) "
                "ON CONFLICT (user_id, session_ref) DO NOTHING RETURNING request_id",
                uid,
                _session_ref(ctx),
                b["device_id"],
                wire.b64d(b["sig_pubkey"]),
                wire.b64d(b["commit"]),
                created,
                expires,
            )
            if rid is None:  # S8: decided without an ERROR in the Postgres log
                raise ApiError("one_per_session")
    except asyncpg.UniqueViolationError:
        raise ApiError("one_per_session") from None
    except asyncpg.ForeignKeyViolationError:
        raise ApiError("session_invalid") from None
    return 201, {"request_id": str(rid), "expires_at": ms(expires)}


# ------------------------------------------------------------------------------------- M2: list, poll


async def list_requests(ctx: Ctx) -> tuple[int, dict]:
    async with ctx.pool.acquire() as con:
        await delete_enrollments(con, "user_id = $1 AND expires_at <= $2", ctx.uid, to_dt(ctx.now))
        rows = await con.fetch(
            "SELECT request_id, created_at, expires_at, state, approver_device_id FROM sixkey.enrollments "
            "WHERE user_id = $1 AND via = 'approval' AND expires_at > $2 ORDER BY created_at, request_id",
            ctx.uid,
            to_dt(ctx.now),
        )
    out = []
    for r in rows:
        item = {
            "request_id": str(r["request_id"]),
            "created_at": ms(r["created_at"]),
            "expires_at": ms(r["expires_at"]),
            "state": r["state"],
        }
        if r["approver_device_id"] is not None:
            item["handled_by"] = r["approver_device_id"]
        out.append(item)
    return 200, {"requests": out}


async def get_request(ctx: Ctx) -> tuple[int, dict]:
    rid = _rid(ctx)
    async with ctx.pool.acquire() as con:
        row = await _gone_or(con, ctx, rid, ctx.uid)
    st = row["state"]
    if ctx.enrollment is not None:  # the new device's view (§3.2 M3, M6)
        view: dict = {"state": st}
        if st != "pending":
            view["approver_device_id"] = row["approver_device_id"]
            view["approver_epk"] = wire.b64e(bytes(row["approver_epk"]))
        if st == "approved":
            view["payload"] = wire.b64e(bytes(row["payload"]))
        return 200, view
    view = {
        "state": st,
        "new_device_id": row["new_device_id"],
        "new_sig_pubkey": wire.b64e(bytes(row["new_sig_pubkey"])),
        "commit": wire.b64e(bytes(row["commit"])),
    }
    if st in ("revealed", "approved"):
        view["new_epk"] = wire.b64e(bytes(row["new_epk"]))
        view["new_nonce"] = wire.b64e(bytes(row["new_nonce"]))
        view["new_name_ct"] = wire.b64e(bytes(row["new_name_ct"]))
    return 200, view


# ------------------------------------------------------------------------------------- M2 / M3 / M5


async def respond(ctx: Ctx) -> tuple[int, dict]:
    rid = _rid(ctx)
    await ctx.enforce_proof()
    epk = wire.b64d(ctx.body["epk"])
    wire.point_public_key(epk)
    async with ctx.pool.acquire() as con, con.transaction():
        await lock_signer(con, ctx.uid, ctx.signer)
        ok = await con.fetchval(
            "UPDATE sixkey.enrollments SET state = 'responded', approver_device_id = $3, approver_epk = $4 "
            "WHERE request_id = $1 AND user_id = $2 AND via = 'approval' AND state = 'pending' AND expires_at > $5 "
            "RETURNING 1",
            rid,
            ctx.uid,
            ctx.signer,
            epk,
            to_dt(ctx.now),
        )
        if ok:
            return 200, {"state": "responded"}
        row = await _gone_or(con, ctx, rid, ctx.uid)
        if (
            row["state"] == "responded"
            and row["approver_device_id"] == ctx.signer
            and bytes(row["approver_epk"]) == epk
        ):
            return 200, {"state": "responded"}  # the same approver retrying the same step
        raise ApiError("enroll_state", handled_by=row["approver_device_id"])


async def reveal(ctx: Ctx) -> tuple[int, dict]:
    rid = ctx.enrollment["request_id"]
    b = ctx.body
    epk, nonce, name = wire.b64d(b["epk"]), wire.b64d(b["nonce"]), wire.b64d(b["name_ct"])
    wire.point_public_key(epk)
    async with ctx.pool.acquire() as con, con.transaction():
        ok = await con.fetchval(
            "UPDATE sixkey.enrollments SET state = 'revealed', new_epk = $2, new_nonce = $3, new_name_ct = $4 "
            "WHERE request_id = $1 AND via = 'approval' AND state = 'responded' AND expires_at > $5 RETURNING 1",
            rid,
            epk,
            nonce,
            name,
            to_dt(ctx.now),
        )
        if ok:
            return 200, {"state": "revealed"}
        row = await _gone_or(con, ctx, rid, ctx.enrollment["user_id"])
        if (
            row["state"] in ("revealed", "approved")
            and bytes(row["new_epk"]) == epk
            and bytes(row["new_nonce"]) == nonce
            and bytes(row["new_name_ct"]) == name
        ):
            return 200, {"state": "revealed"}  # an identical retry of this step
        raise ApiError("enroll_state", handled_by=row["approver_device_id"])


async def approve(ctx: Ctx) -> tuple[int, dict]:
    rid = _rid(ctx)
    await ctx.enforce_proof()
    b = ctx.body
    th, payload, sp = wire.b64d(b["transcript_hash"]), wire.b64d(b["payload"]), wire.b64d(b["sig_pubkey_sha256"])
    async with ctx.pool.acquire() as con, con.transaction():
        await lock_signer(con, ctx.uid, ctx.signer)
        row = await con.fetchrow(
            "SELECT via, state, approver_device_id, new_sig_pubkey FROM sixkey.enrollments "
            "WHERE request_id = $1 AND user_id = $2 FOR UPDATE",
            rid,
            ctx.uid,
        )
        if row is None or row["via"] != "approval":
            raise ApiError("enroll_gone")
        if row["state"] != "revealed" or row["approver_device_id"] != ctx.signer:
            raise ApiError("enroll_state", handled_by=row["approver_device_id"])
        if wire.sha256(bytes(row["new_sig_pubkey"])) != sp:
            raise ApiError("key_mismatch")
        name = wire.name_ct(b["name_ct"], await vault_vk_id(con, ctx.uid))
        ok = await con.fetchval(
            "UPDATE sixkey.enrollments SET state = 'approved', transcript_hash = $4, payload = $5, name_ct = $6 "
            "WHERE request_id = $1 AND user_id = $2 AND state = 'revealed' AND approver_device_id = $3 "
            "AND expires_at > $7 RETURNING 1",
            rid,
            ctx.uid,
            ctx.signer,
            th,
            payload,
            name,
            to_dt(ctx.now),
        )
        if not ok:
            await _gone_or(con, ctx, rid, ctx.uid)
            raise ApiError("enroll_state", handled_by=row["approver_device_id"])
    return 200, {"state": "approved"}


# ------------------------------------------------------------------------------------- M7: complete


async def complete(ctx: Ctx) -> tuple[int, dict]:
    """Create the device row (joined_via approval or recovery) and delete the request. Idempotent when
    the same device id with the same key already is in this account (D4)."""
    enr = ctx.enrollment
    rid, uid = enr["request_id"], enr["user_id"]
    async with ctx.pool.acquire() as con, con.transaction():
        # lock order (routes/common.py): the vault row before enrollment rows, as rotate and revoke do
        await con.execute("SELECT 1 FROM sixkey.vaults WHERE user_id = $1 FOR UPDATE", uid)
        row = await con.fetchrow("SELECT * FROM sixkey.enrollments WHERE request_id = $1 FOR UPDATE", rid)
        await ctx.st.pause("complete.locked")
        if row is None:
            raise ApiError("enroll_gone")
        if row["state"] != "approved":
            raise ApiError("enroll_state", handled_by=row["approver_device_id"])
        if row["via"] == "approval":
            if "name_ct" in ctx.body:
                raise ApiError("invalid_request")  # sent with approve on this path
            name = row["name_ct"]
        elif "name_ct" in ctx.body:
            name = wire.name_ct(ctx.body["name_ct"], await vault_vk_id(con, uid))
        else:
            name = None
        gone = await con.fetchval(
            "DELETE FROM sixkey.enrollments WHERE request_id = $1 AND state = 'approved' AND expires_at > $2 "
            "RETURNING 1",
            rid,
            to_dt(ctx.now),
        )
        if not gone:
            await con.execute("DELETE FROM sixkey.enrollments WHERE request_id = $1", rid)
            raise ApiError("enroll_gone")
        d = await con.fetchrow(
            "SELECT user_id, sig_pubkey FROM sixkey.devices WHERE device_id = $1", row["new_device_id"]
        )
        if d is not None:
            if d["user_id"] == uid and bytes(d["sig_pubkey"]) == bytes(row["new_sig_pubkey"]):
                return 200, {"device_id": row["new_device_id"]}
            raise ApiError("enroll_state")
        await bump_devices_rev(con, uid)  # locks the vault row: device creation is serialized per account
        n = await con.fetchval("SELECT count(*) FROM sixkey.devices WHERE user_id = $1 AND revoked_at IS NULL", uid)
        if n >= ctx.st.settings.devices_max_active:
            raise ApiError("too_many_devices")
        await ctx.st.pause("complete.before_insert")
        if not await con.fetchval(
            "INSERT INTO sixkey.devices (device_id, user_id, sig_pubkey, name_ct, joined_via, approved_by, "
            "created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (device_id) DO NOTHING RETURNING 1",
            row["new_device_id"],
            uid,
            bytes(row["new_sig_pubkey"]),
            name,
            row["via"],
            row["approver_device_id"] if row["via"] == "approval" else None,
            hour_dt(ctx.now),
        ):
            raise ApiError("enroll_state")  # taken meanwhile (rolls back; the request survives)
    return 200, {"device_id": row["new_device_id"]}


# ------------------------------------------------------------------------------------- reject


async def reject(ctx: Ctx) -> tuple[int, dict]:
    """An enrolled device with pw_auth (S8), or the new device rejecting its own request (no pw_auth)."""
    if ctx.enrollment is not None:
        if "password_auth" in ctx.body:
            raise ApiError("invalid_request")
        rid, uid = ctx.enrollment["request_id"], ctx.enrollment["user_id"]
        async with ctx.pool.acquire() as con:
            exp = await con.fetchval("DELETE FROM sixkey.enrollments WHERE request_id = $1 RETURNING expires_at", rid)
    else:
        rid = _rid(ctx)
        await ctx.enforce_proof()
        async with ctx.pool.acquire() as con, con.transaction():
            await lock_signer(con, ctx.uid, ctx.signer)
            exp = await con.fetchval(
                "DELETE FROM sixkey.enrollments WHERE request_id = $1 AND user_id = $2 RETURNING expires_at",
                rid,
                ctx.uid,
            )
    if exp is None or exp <= to_dt(ctx.now):
        raise ApiError("enroll_gone")
    return 200, {}


async def reject_all(ctx: Ctx) -> tuple[int, dict]:
    """Every open request of the account, approval and recovery alike (§0.0c, §5.5), that existed when
    the request was signed: only requests created at or before the minute of the signed Sixkey-Ts, so a
    replay inside the window cannot reject requests opened after the original (docs/design/notes/M4-NOTES.md A2)."""
    await ctx.enforce_proof()
    async with ctx.pool.acquire() as con, con.transaction():
        await lock_signer(con, ctx.uid, ctx.signer)
        rows = await delete_enrollments(con, "user_id = $1 AND created_at <= $2", ctx.uid, to_dt(minute_floor(ctx.ts)))
    now = to_dt(ctx.now)
    return 200, {"rejected": sum(1 for r in rows if r["expires_at"] > now)}


# ------------------------------------------------------------------------------------- recovery code


async def recovery(ctx: Ctx) -> tuple[int, dict]:
    """§3.3 step 3: rate limit, then a constant-time compare of the verifier; on success an
    enrollment (via = recovery, state = approved) and the vault and bundle. Same device id and key
    inside the validity window: the same result."""
    b = ctx.body
    uid = uuid.UUID(ctx.session.sub)
    lim, L = ctx.st.settings.limits, ctx.st.limiter
    ctx._hit(L.hkey("rai", ctx.session.sub + "|" + ctx.client_ip()), lim.recovery_account_ip, refundable=False)
    ctx._hit(L.hkey("rad", ctx.session.sub), lim.recovery_account_day, refundable=False)
    v = await ctx.pool.fetchrow(
        "SELECT vault_id, version, envelope, kver, bundle, recovery_verifier FROM sixkey.vaults WHERE user_id = $1", uid
    )
    if v is None:
        raise ApiError("no_vault")
    if not wire.proof_matches(wire.RECOVERY_VERIFIER_PREFIX, b["recovery_auth"], v["recovery_verifier"]):
        raise ApiError("recovery_mismatch")
    spki = wire.b64d(b["sig_pubkey"])
    created, expires = _times(ctx)
    try:
        async with ctx.pool.acquire() as con, con.transaction():
            await delete_enrollments(con, "user_id = $1 AND expires_at <= $2", uid, to_dt(ctx.now))
            same = await con.fetchrow(
                "SELECT request_id, new_sig_pubkey FROM sixkey.enrollments WHERE user_id = $1 AND via = 'recovery' "
                "AND new_device_id = $2",
                uid,
                b["device_id"],
            )
            if same is not None and bytes(same["new_sig_pubkey"]) == spki:
                rid = same["request_id"]
            else:
                if await con.fetchval("SELECT 1 FROM sixkey.devices WHERE device_id = $1", b["device_id"]):
                    raise ApiError("device_exists")
                rid = await con.fetchval(
                    "INSERT INTO sixkey.enrollments (user_id, via, session_ref, new_device_id, new_sig_pubkey, state, "
                    "created_at, expires_at) VALUES ($1, 'recovery', $2, $3, $4, 'approved', $5, $6) "
                    "ON CONFLICT (user_id, session_ref) DO NOTHING RETURNING request_id",
                    uid,
                    _session_ref(ctx),
                    b["device_id"],
                    spki,
                    created,
                    expires,
                )
                if rid is None:
                    raise ApiError("one_per_session")
    except asyncpg.UniqueViolationError:
        raise ApiError("one_per_session") from None
    except asyncpg.ForeignKeyViolationError:
        raise ApiError("session_invalid") from None
    return 200, {
        "request_id": str(rid),
        "vault_id": v["vault_id"],
        "version": v["version"],
        "envelope": v["envelope"],
        "kver": v["kver"],
        "bundle": v["bundle"],
    }
