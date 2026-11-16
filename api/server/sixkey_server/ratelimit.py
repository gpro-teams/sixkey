"""In-memory sliding-window rate limits (§5.1 ratelimit.py, §5.5, §5.6).

Single instance only (several instances would need Redis, §5.1). Nothing is written to disk.
IPs, emails, accounts and sessions are only ever keys of the form HMAC-SHA256(daily key, value):
the daily key is random, lives in process memory, and is replaced at each UTC midnight, which also
drops every counter (so no counter outlives its day and none can be linked across days).
Device ids are random 128-bit identifiers and are used as keys directly.

Memory is bounded: every window keeps only the entries inside it (a garbage-collection pass at least
once a minute prunes every key to its own window, so IP-keyed entries live at most their window,
1 hour for the IP buckets, §5.6 IP_COUNTER_TTL_S), plain counters expire after COUNTER_TTL_MS, and the
number of keys is capped: past the cap a new key is refused (429) instead of growing the table.
"""

from __future__ import annotations

import collections
import hashlib
import hmac
import secrets

from .clock import Clock, day_floor

GC_EVERY_OPS = 256
GC_EVERY_MS = 60_000
COUNTER_TTL_MS = 3_600_000  # the per-code OTP counter: a code lives at most an hour


class _Window:
    __slots__ = ("window_ms", "entries", "total")

    def __init__(self, window_ms: int) -> None:
        self.window_ms = window_ms
        self.entries: collections.deque[tuple[int, int]] = collections.deque()
        self.total = 0

    def prune(self, now: int) -> None:
        cutoff = now - self.window_ms
        while self.entries and self.entries[0][0] <= cutoff:
            self.total -= self.entries.popleft()[1]


class Limiter:
    def __init__(self, clock: Clock, max_keys: int = 200_000) -> None:
        self.clock = clock
        self.max_keys = max_keys
        self._day = -1
        self._daily_key = b""
        self._hits: dict[str, _Window] = {}
        self._counters: dict[str, tuple[int, int]] = {}
        self._ops = 0
        self._last_gc = 0
        self._rotate()

    # -------------------------------------------------------------------------------- keys

    def _rotate(self) -> None:
        day = day_floor(self.clock.now_ms())
        if day != self._day:
            self._day = day
            self._daily_key = secrets.token_bytes(32)
            self._hits.clear()
            self._counters.clear()

    def hkey(self, kind: str, value: str) -> str:
        """kind:hex(HMAC(daily key, value))[:32]; the only form in which IPs/emails/accounts appear."""
        self._rotate()
        return kind + ":" + hmac.new(self._daily_key, value.encode(), hashlib.sha256).hexdigest()[:32]

    def ref(self, value: str) -> str:
        """§5.6: the 5xx log reference, HMAC(daily key, user_id), first 8 characters."""
        self._rotate()
        return hmac.new(self._daily_key, b"ref|" + value.encode(), hashlib.sha256).hexdigest()[:8]

    # -------------------------------------------------------------------------------- windows

    def hit(self, key: str, limit: int, window_s: int, amount: int = 1) -> int | None:
        """Consume `amount` units (1 for a request, bytes for a byte budget). Returns None if allowed,
        else the seconds until enough units free up."""
        self._rotate()
        now = self.clock.now_ms()
        self._gc(now)
        w = self._hits.get(key)
        if w is None:
            if len(self._hits) >= self.max_keys:
                return 60  # bounded memory: refuse rather than grow
            w = self._hits[key] = _Window(window_s * 1000)
        w.prune(now)
        if w.total + amount > limit:
            if not w.entries or amount > limit:  # nothing frees up enough inside the window
                return max(1, window_s)
            need, freed = w.total + amount - limit, 0
            for ts, n in w.entries:
                freed += n
                if freed >= need:
                    return max(1, -(-(ts + w.window_ms - now) // 1000))
            return max(1, window_s)
        w.entries.append((now, amount))
        w.total += amount
        return None

    def refund(self, key: str, amount: int = 1) -> None:
        """Give back one earlier hit of this amount (the newest such entry)."""
        w = self._hits.get(key)
        if not w:
            return
        for i in range(len(w.entries) - 1, -1, -1):
            if w.entries[i][1] == amount:
                del w.entries[i]
                w.total -= amount
                return

    def count(self, key: str) -> int:
        """Units currently in the window (for tests)."""
        w = self._hits.get(key)
        if not w:
            return 0
        w.prune(self.clock.now_ms())
        return w.total

    def _gc(self, now: int) -> None:
        self._ops += 1
        if self._ops % GC_EVERY_OPS and now - self._last_gc < GC_EVERY_MS:
            return
        self._last_gc = now
        for k in list(self._hits):
            w = self._hits[k]
            w.prune(now)
            if not w.entries:
                del self._hits[k]
        for k in [k for k, (_, t) in self._counters.items() if now - t >= COUNTER_TTL_MS]:
            del self._counters[k]

    def gc(self) -> None:
        """Force a pass (tests)."""
        self._last_gc = -GC_EVERY_MS
        self._gc(self.clock.now_ms())

    # -------------------------------------------------------------------------------- plain counters

    def incr(self, key: str) -> int | None:
        """Add one and return the new value; None when the key is new and the table is full (the caller
        answers 429, as for a full window table). Counters expire COUNTER_TTL_MS after they started."""
        self._rotate()
        now = self.clock.now_ms()
        self._gc(now)
        n, t = self._counters.get(key, (0, now))
        if now - t >= COUNTER_TTL_MS:
            n, t = 0, now
        if n == 0 and len(self._counters) >= self.max_keys:
            return None  # bounded memory: refuse rather than grow
        self._counters[key] = (n + 1, t)
        return n + 1

    def get(self, key: str) -> int:
        self._rotate()
        n, t = self._counters.get(key, (0, 0))
        return 0 if self.clock.now_ms() - t >= COUNTER_TTL_MS else n

    def reset(self, key: str) -> None:
        self._counters.pop(key, None)
