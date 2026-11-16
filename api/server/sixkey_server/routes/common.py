"""Helpers shared by the handlers.

Lock order (no deadlocks): device rows first, several of them in device_id order, then the vault row,
then enrollment rows (several in request_id order, delete_enrollments). Every write transaction takes
the locks it needs in that order (it may skip levels); vault_versions rows are only touched while the
vault row is held. tests/test_cas.py and tests/test_enroll.py force the interleavings that would
deadlock otherwise.
Device rows are locked FOR NO KEY UPDATE rather than §5.3's FOR SHARE: the same transactions update
those rows (cursor, auth_failures, names), and two FOR SHARE holders that then both update the row
deadlock (two clones PUTting at once). The lock still serializes every write with a concurrent
revocation, which is what C3 asks for (docs/design/notes/M4-NOTES.md).
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

import asyncpg

from ..clock import from_date, from_dt, hour_floor, to_dt
from ..errors import ApiError


def hour_dt(now_ms: int) -> dt.datetime:
    return to_dt(hour_floor(now_ms))


def ms(value: dt.datetime | None) -> int | None:
    return None if value is None else from_dt(value)


def day_ms(value: dt.date | None) -> int | None:
    return None if value is None else from_date(value)


async def lock_devices(con: asyncpg.Connection, uid: uuid.UUID, ids: list[str]) -> dict[str, asyncpg.Record]:
    rows = await con.fetch(
        "SELECT device_id, revoked_at, cursor, auth_failures FROM sixkey.devices "
        "WHERE device_id = ANY($1::text[]) AND user_id = $2 ORDER BY device_id FOR NO KEY UPDATE",
        sorted(set(ids)),
        uid,
    )
    return {r["device_id"]: r for r in rows}


async def lock_signer(con: asyncpg.Connection, uid: uuid.UUID, signer: str, *others: str) -> dict[str, asyncpg.Record]:
    """Lock the signing device (and others) and re-check, inside the transaction, that the signer is
    not revoked (§5.2, §5.3 C3, P6)."""
    rows = await lock_devices(con, uid, [signer, *others])
    me = rows.get(signer)
    if me is None or me["revoked_at"] is not None:
        raise ApiError("device_revoked")
    return rows


async def delete_enrollments(con: asyncpg.Connection, cond: str, *args: Any) -> list[asyncpg.Record]:
    """Delete enrollment rows locking them in request_id order first, so two multi-row deletes of one
    account (reject-all, rotate, revoke, the expiry clean-ups) cannot deadlock. cond is a constant."""
    return await con.fetch(
        "DELETE FROM sixkey.enrollments WHERE request_id IN (SELECT request_id FROM sixkey.enrollments "
        f"WHERE {cond} ORDER BY request_id FOR UPDATE) RETURNING expires_at",
        *args,
    )


async def bump_devices_rev(con: asyncpg.Connection, uid: uuid.UUID) -> None:
    await con.execute("UPDATE sixkey.vaults SET devices_rev = devices_rev + 1 WHERE user_id = $1", uid)


async def vault_vk_id(con: Any, uid: uuid.UUID) -> str:
    vk = await con.fetchval("SELECT vk_id FROM sixkey.vaults WHERE user_id = $1", uid)
    if vk is None:
        raise ApiError("no_vault")
    return vk
