"""Per-unit rate limiting for telemetry ingestion.

The phone sends one fix every 10 seconds or 25 metres while a response is en
route, and buffers up to 12 fixes when it cannot reach dispatch, so a healthy
unit sends a handful of small requests per minute and an occasional catch-up
batch after a tunnel.

The limit therefore has to allow that burst pattern while still bounding what one
credential can cost the server:

* **Refill** `GREENROUTE_TELEMETRY_FIXES_PER_MINUTE` fixes per minute (default
  60: ten times the normal cadence, which absorbs retries and clock jitter).
* **Burst capacity** `GREENROUTE_TELEMETRY_BURST` fixes (default 90: one maximum
  size batch of 60 plus a full buffered backlog of 12, with headroom).

A rejected request consumes nothing and is answered with `429` and
`Retry-After`, so the phone keeps the fixes in its own outbox and retries with
its existing backoff rather than dropping them.

The buckets live in process memory, keyed by vehicle id. This application is a
single Flask process on SQLite; there is no second worker to share state with,
and a restart simply resets the buckets. Keeping them out of the database is
deliberate: a rate limiter must not generate the writes it is meant to bound.
"""

from __future__ import annotations

import os
import threading
import time

DEFAULT_REFILL_PER_MINUTE = 60
DEFAULT_BURST = 90


def _int_env(name: str, default: int, minimum: int) -> int:
    try:
        return max(minimum, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


def capacity() -> int:
    return _int_env("GREENROUTE_TELEMETRY_BURST", DEFAULT_BURST, 1)


def refill_per_minute() -> int:
    return _int_env(
        "GREENROUTE_TELEMETRY_FIXES_PER_MINUTE", DEFAULT_REFILL_PER_MINUTE, 1
    )


class Bucket:
    """A token bucket for one unit, refilled continuously from a clock."""

    __slots__ = ("capacity", "refill_per_second", "tokens", "updated_at", "clock")

    def __init__(self, capacity: int, refill_per_second: float, clock):
        self.capacity = float(capacity)
        self.refill_per_second = float(refill_per_second)
        self.tokens = float(capacity)
        self.updated_at = clock()
        self.clock = clock

    def _refill(self) -> None:
        now = self.clock()
        elapsed = max(0.0, now - self.updated_at)
        if elapsed:
            self.tokens = min(self.capacity, self.tokens + elapsed * self.refill_per_second)
            self.updated_at = now

    def available(self) -> float:
        self._refill()
        return self.tokens

    def take(self, amount: float) -> tuple[bool, float]:
        """Consume `amount` if possible. Returns `(allowed, retry_after_seconds)`."""
        self._refill()
        if amount <= 0:
            return True, 0.0
        if amount <= self.tokens:
            self.tokens -= amount
            return True, 0.0
        missing = amount - self.tokens
        return False, missing / self.refill_per_second if self.refill_per_second else 1.0


class Limiter:
    """Buckets keyed by unit id."""

    def __init__(self, clock=time.monotonic):
        self._lock = threading.Lock()
        self._buckets: dict[int, Bucket] = {}
        self._clock = clock

    def reset(self) -> None:
        """Drop every bucket. Used by tests and when configuration changes."""
        with self._lock:
            self._buckets.clear()

    def consume(self, unit_id: int, amount: int) -> float:
        """Return 0.0 when the request may proceed, else seconds to wait."""
        cap = float(capacity())
        rate = refill_per_minute() / 60.0
        with self._lock:
            bucket = self._buckets.get(unit_id)
            if bucket is None:
                bucket = Bucket(cap, rate, self._clock)
                self._buckets[unit_id] = bucket
            else:
                # Configuration can change between requests (tests, restarts of
                # the app with different env); keep the bucket in step.
                bucket.capacity = cap
                bucket.refill_per_second = rate
                bucket.tokens = min(bucket.tokens, cap)
            allowed, retry_after = bucket.take(amount)
        return 0.0 if allowed else max(1.0, retry_after)


#: The process-wide limiter used by the driver API.
limiter = Limiter()


def retry_after_seconds(unit_id: int, amount: int) -> float:
    """Return the number of seconds a client should wait before retrying.
    The helper applies a mathematical ceiling via ``math.ceil`` and enforces a
    minimum of one second, matching the rate‑limit contract.
    """
    wait = limiter.consume(unit_id, amount)
    if wait <= 0:
        return 0.0
    import math
    return float(max(1, math.ceil(wait)))
