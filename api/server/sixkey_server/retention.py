"""History retention (§5.8): keep the newest 30 versions plus, for each of the last 30 UTC days
(today and the 29 before it), that day's last version; the head is always kept. Then the 64 MiB cap:
drop the oldest versions that are not a day's last first, then the oldest days' lasts, never the head.
Days come from created_at, which is stored at hour precision; nothing finer exists to leak.
Runs inside the PUT / rotate transaction (bounded: about 60 rows) and from the daily job.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

import asyncpg

from .clock import day_floor, from_dt
from .constants import DAY_MS


@dataclass(frozen=True)
class Policy:
    keep_versions: int = 30
    keep_days: int = 30
    max_bytes: int = 67_108_864


def select_kept(rows: list[tuple[int, int, int]], now_ms: int, p: Policy) -> set[int]:
    """rows: (version, created_at_ms, size_bytes). Pure function, also used as the tests' oracle input."""
    if not rows:
        return set()
    by_v = sorted(rows, key=lambda r: r[0], reverse=True)
    head = by_v[0][0]
    keep = {r[0] for r in by_v[: p.keep_versions]}
    oldest_day = day_floor(now_ms) - (p.keep_days - 1) * DAY_MS
    daily: dict[int, int] = {}
    for v, created, _ in by_v:  # newest first: the first one seen for a day is its last version
        d = day_floor(created)
        if d >= oldest_day and d not in daily:
            daily[d] = v
    daily_last = set(daily.values())
    keep |= daily_last
    keep.add(head)
    size = {r[0]: r[2] for r in rows}
    total = sum(size[v] for v in keep)
    if total > p.max_bytes:
        oldest_first = sorted(keep)
        for group in (
            [v for v in oldest_first if v not in daily_last and v != head],
            [v for v in oldest_first if v in daily_last and v != head],
        ):
            for v in group:
                if total <= p.max_bytes:
                    break
                keep.discard(v)
                total -= size[v]
    return keep


async def prune(con: asyncpg.Connection, uid: uuid.UUID, now_ms: int, p: Policy) -> int:
    """Delete what select_kept drops and set vaults.history_bytes exactly. Returns the number deleted."""
    recs = await con.fetch("SELECT version, created_at, size_bytes FROM sixkey.vault_versions WHERE user_id = $1", uid)
    rows = [(r["version"], from_dt(r["created_at"]), r["size_bytes"]) for r in recs]
    keep = select_kept(rows, now_ms, p)
    drop = [v for v, _, _ in rows if v not in keep]
    if drop:
        await con.execute(
            "DELETE FROM sixkey.vault_versions WHERE user_id = $1 AND version = ANY($2::bigint[])", uid, drop
        )
    total = sum(s for v, _, s in rows if v in keep)
    await con.execute("UPDATE sixkey.vaults SET history_bytes = $2 WHERE user_id = $1", uid, total)
    return len(drop)
