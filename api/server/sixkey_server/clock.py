"""The one clock of the server. Tests inject a FakeClock; every timestamp the API writes or checks
(signature window, expiry, rate limits, JWT exp/iat, stored hour/day/minute times) comes from here."""

from __future__ import annotations

import datetime as dt
import time

from .constants import DAY_MS, HOUR_MS, MINUTE_MS

UTC = dt.timezone.utc


class Clock:
    def now_ms(self) -> int:
        return time.time_ns() // 1_000_000

    def monotonic(self) -> float:
        return time.monotonic()


class FakeClock(Clock):
    def __init__(self, now_ms: int) -> None:
        self._now = now_ms

    def now_ms(self) -> int:
        return self._now

    def monotonic(self) -> float:
        return self._now / 1000.0

    def set(self, now_ms: int) -> None:
        self._now = now_ms

    def advance(self, ms: int) -> None:
        self._now += ms


def floor_to(ms: int, unit: int) -> int:
    return ms // unit * unit


def hour_floor(ms: int) -> int:
    return floor_to(ms, HOUR_MS)


def day_floor(ms: int) -> int:
    return floor_to(ms, DAY_MS)


def minute_floor(ms: int) -> int:
    return floor_to(ms, MINUTE_MS)


def minute_ceil(ms: int) -> int:
    return -(-ms // MINUTE_MS) * MINUTE_MS


EPOCH = dt.datetime(1970, 1, 1, tzinfo=UTC)


def to_dt(ms: int) -> dt.datetime:
    return EPOCH + dt.timedelta(milliseconds=ms)


def to_date(ms: int) -> dt.date:
    return to_dt(day_floor(ms)).date()


def from_dt(value: dt.datetime) -> int:
    if value.tzinfo is None:
        raise ValueError("naive datetime")
    delta = value - EPOCH
    return (delta.days * 86_400 + delta.seconds) * 1000 + delta.microseconds // 1000


def from_date(value: dt.date) -> int:
    return (value - dt.date(1970, 1, 1)).days * DAY_MS
