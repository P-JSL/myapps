"""Shared desktop scheduling policy and bounded, cancellable resource leases.

The job limit bounds worker lifetimes. Separate stage budgets keep extraction,
fragment downloads and media processing from multiplying that limit internally.
"""
from __future__ import annotations

from collections import deque
from contextlib import contextmanager
import os
import sys
import threading
from urllib.parse import urlsplit


AUTO_CONCURRENT_DOWNLOADS = 0
MAX_CONCURRENT_DOWNLOADS = 16
DEFAULT_HOST_DOWNLOADS = 4
MAX_HOST_DOWNLOADS = 16
NETWORK_BUDGET = 16
MAX_FRAGMENT_DOWNLOADS = 4
FFMPEG_THREADS = 2


def normalize_concurrency(value, default: int = AUTO_CONCURRENT_DOWNLOADS) -> int:
    """Accept only stored integers; booleans and numeric strings are invalid."""
    fallback = default if type(default) is int and 0 <= default <= MAX_CONCURRENT_DOWNLOADS else AUTO_CONCURRENT_DOWNLOADS
    return value if type(value) is int and 0 <= value <= MAX_CONCURRENT_DOWNLOADS else fallback


def effective_concurrency(value, cpu_count: int | None = None) -> int:
    setting = normalize_concurrency(value)
    if setting:
        return setting
    cpus = os.cpu_count() if cpu_count is None else cpu_count
    cpus = cpus if type(cpus) is int and cpus > 0 else 2
    return max(2, min(4, cpus // 2))


def fragment_parallelism(setting) -> int:
    return max(1, min(MAX_FRAGMENT_DOWNLOADS, NETWORK_BUDGET // effective_concurrency(setting)))


def normalize_host_concurrency(value, default: int = DEFAULT_HOST_DOWNLOADS) -> int:
    fallback = default if type(default) is int and 1 <= default <= MAX_HOST_DOWNLOADS else DEFAULT_HOST_DOWNLOADS
    return value if type(value) is int and 1 <= value <= MAX_HOST_DOWNLOADS else fallback


def source_key(url: str) -> str:
    """A host-only scheduling key; all supported YouTube aliases share a key."""
    if not isinstance(url, str):
        return ""
    try:
        hostname = (urlsplit(url).hostname or "").lower().rstrip(".")
        if hostname in ("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"):
            return "youtube.com"
        return hostname.encode("idna").decode("ascii")
    except (TypeError, ValueError, UnicodeError):
        return ""


class ResourceCancelled(Exception):
    """The caller cancelled before its resource lease was granted."""


class _Gate:
    def __init__(self, capacity: int):
        self.capacity = capacity
        self.used = 0
        self.waiters = deque()
        self.condition = threading.Condition()

    def acquire(self, units, cancel, on_wait):
        ticket = object()
        with self.condition:
            self.waiters.append(ticket)
            try:
                notified = False
                while True:
                    if cancel.is_set():
                        raise ResourceCancelled()
                    if self.waiters[0] is ticket and self.used + units <= self.capacity:
                        self.waiters.popleft()
                        self.used += units
                        self.condition.notify_all()
                        return
                    if not notified:
                        notified = True
                        if on_wait is not None:
                            # Call outside the gate lock: UI callbacks must never
                            # prevent another worker from returning its lease.
                            self.condition.release()
                            try:
                                on_wait()
                            finally:
                                self.condition.acquire()
                        continue
                    self.condition.wait(timeout=0.1)
            except BaseException:
                self.waiters.remove(ticket)
                self.condition.notify_all()
                raise

    def release(self, units):
        with self.condition:
            self.used -= units
            self.condition.notify_all()


class ResourceBudget:
    """FIFO stage gates; a weighted network lease is granted atomically.

    Leases are returned on success, errors and cancellation. A cancelled waiter
    leaves its queue within 100 ms without taking any partial resource grant.
    """
    DEFAULT_CAPACITIES = {"jobs": MAX_CONCURRENT_DOWNLOADS, "metadata": 2,
                          "network": NETWORK_BUDGET, "processing": 2, "scan": 1}

    def __init__(self, capacities: dict[str, int] | None = None):
        limits = {**self.DEFAULT_CAPACITIES, **(capacities or {})}
        if any(type(capacity) is not int or capacity < 1 for capacity in limits.values()):
            raise ValueError("Resource capacities must be positive integers.")
        self._gates = {name: _Gate(capacity) for name, capacity in limits.items()}

    @property
    def capacities(self) -> dict[str, int]:
        return {name: gate.capacity for name, gate in self._gates.items()}

    def snapshot(self) -> dict[str, dict[str, int]]:
        result = {}
        for name, gate in self._gates.items():
            with gate.condition:
                result[name] = {"capacity": gate.capacity, "used": gate.used, "waiting": len(gate.waiters)}
        return result

    @contextmanager
    def hold(self, resource: str, cancel: threading.Event, units: int = 1, *, on_wait=None):
        gate = self._gates[resource]
        if type(units) is not int or not 1 <= units <= gate.capacity:
            raise ValueError("A resource grant must fit its budget.")
        gate.acquire(units, cancel, on_wait)
        try:
            # Cancellation can race the grant. Return it before doing any work.
            if cancel.is_set():
                raise ResourceCancelled()
            yield units
        finally:
            gate.release(units)


# All Engine instances in this process share the safety limits.
PROCESS_RESOURCES = ResourceBudget()

# Package imports, desktop script imports and Windows isolated workers use
# different import paths. Keep their exception types and process budget shared.
_this_module = sys.modules[__name__]
_shared_module = sys.modules.setdefault("_myvideoapp_concurrency", _this_module)
if _shared_module is not _this_module:
    ResourceCancelled = _shared_module.ResourceCancelled
    ResourceBudget = _shared_module.ResourceBudget
    PROCESS_RESOURCES = _shared_module.PROCESS_RESOURCES
    sys.modules[__name__] = _shared_module
