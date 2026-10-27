"""One fair, cancellable bandwidth bucket for all desktop media transfers.

Reservations are limited to 64 KiB and take FIFO turns, so a large request does
not reserve seconds of future bandwidth ahead of another download. Configuration
changes wake current transfers and never retain debt from the previous rate.
"""
from __future__ import annotations

from collections import deque
import sys
import threading
import time


MIN_RATE_KIB = 64
MAX_RATE_KIB = 1_048_576
DEFAULT_RATE_KIB = 10_240
MAX_BURST_BYTES = 64 * 1024
_CANCEL_POLL_SECONDS = 0.05


class BandwidthCancelled(Exception):
    """A caller cancelled while waiting for its bandwidth reservation."""


class BandwidthLimiter:
    """A process-wide token bucket with bounded bursts and live configuration.

    The first enabled reservation may use one burst immediately. Changing an
    active rate discards accumulated credit and restarts from the new rate;
    disabling the limiter releases every waiting caller without delay.
    """

    def __init__(self, enabled: bool = False, rate_kib: int = DEFAULT_RATE_KIB):
        self._validate(enabled, rate_kib)
        self._condition = threading.Condition()
        self._waiters = deque()
        self._enabled = enabled
        self._rate_kib = rate_kib
        self._tokens = float(self._capacity(rate_kib))
        self._updated = time.monotonic()

    @staticmethod
    def _validate(enabled, rate_kib):
        if type(enabled) is not bool:
            raise ValueError("Bandwidth limiting must be enabled or disabled.")
        if type(rate_kib) is not int or not MIN_RATE_KIB <= rate_kib <= MAX_RATE_KIB:
            raise ValueError("Bandwidth limit must be between 64 and 1048576 KiB/s.")

    @staticmethod
    def _capacity(rate_kib):
        return min(MAX_BURST_BYTES, rate_kib * 1024)

    @property
    def enabled(self) -> bool:
        with self._condition:
            return self._enabled

    @property
    def rate_kib(self) -> int:
        with self._condition:
            return self._rate_kib

    def configure(self, enabled: bool, rate_kib: int):
        self._validate(enabled, rate_kib)
        with self._condition:
            if (enabled, rate_kib) == (self._enabled, self._rate_kib):
                return
            was_enabled = self._enabled
            self._enabled = enabled
            self._rate_kib = rate_kib
            self._updated = time.monotonic()
            self._tokens = 0.0 if enabled and was_enabled else float(self._capacity(rate_kib))
            self._condition.notify_all()

    @staticmethod
    def _check(cancel):
        if cancel is not None and cancel.is_set():
            raise BandwidthCancelled()

    def consume(self, byte_count: int, cancel=None):
        """Reserve actual media bytes, returning when the caller may proceed.

        Cancellation never sets or clears the supplied event. Large progress
        deltas take separate FIFO turns instead of reserving a large future debt.
        """
        if type(byte_count) is not int or byte_count < 0:
            raise ValueError("Bandwidth byte count must be a nonnegative integer.")
        self._check(cancel)
        remaining = byte_count
        while remaining:
            amount = min(remaining, MAX_BURST_BYTES)
            if not self._consume_chunk(amount, cancel):
                return
            remaining -= amount

    def _consume_chunk(self, amount, cancel):
        with self._condition:
            self._check(cancel)
            if not self._enabled:
                return False
            ticket = object()
            self._waiters.append(ticket)
            try:
                while True:
                    self._check(cancel)
                    if not self._enabled:
                        return False
                    now = time.monotonic()
                    rate = self._rate_kib * 1024
                    capacity = self._capacity(self._rate_kib)
                    self._tokens = min(capacity, self._tokens + max(0.0, now - self._updated) * rate)
                    self._updated = now
                    if self._waiters[0] is ticket and self._tokens >= amount:
                        self._tokens -= amount
                        return True
                    delay = (amount - self._tokens) / rate if self._waiters[0] is ticket else _CANCEL_POLL_SECONDS
                    self._condition.wait(timeout=min(_CANCEL_POLL_SECONDS, max(0.0001, delay)))
            finally:
                self._waiters.remove(ticket)
                self._condition.notify_all()


PROCESS_BANDWIDTH = BandwidthLimiter()

# Package imports, desktop script imports and isolated workers share the same
# limiter and exception identity, as they do for the concurrency resource budget.
_this_module = sys.modules[__name__]
_shared_module = sys.modules.setdefault("_myvideoapp_bandwidth", _this_module)
if _shared_module is not _this_module:
    BandwidthCancelled = _shared_module.BandwidthCancelled
    BandwidthLimiter = _shared_module.BandwidthLimiter
    PROCESS_BANDWIDTH = _shared_module.PROCESS_BANDWIDTH
    sys.modules[__name__] = _shared_module
