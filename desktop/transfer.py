"""Bounded, cancellable direct-media transfers into a newly owned disk file.

Every request holds one process network lease until its validated bytes are on
disk. Parallel requests retain at most one 4 MiB chunk each, regardless of the
file's size. Exceptions contain fixed public messages, never transport details.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import importlib.util
import os
from pathlib import Path
import random
import re
import stat
import sys
import threading
import time

try:
    from .concurrency import ResourceCancelled
    from .transport import TransportCancelled, TransportError
except ImportError:
    # The bundled isolated Python worker does not add desktop to sys.path.
    def _sibling(name):
        key = "_myvideoapp_" + name
        module = sys.modules.get(key) or sys.modules.get(name)
        if module is None:
            spec = importlib.util.spec_from_file_location(key, Path(__file__).absolute().with_name(name + ".py"))
            module = importlib.util.module_from_spec(spec)
            sys.modules[key] = module
            spec.loader.exec_module(module)
        return module

    ResourceCancelled = _sibling("concurrency").ResourceCancelled
    _transport = _sibling("transport")
    TransportCancelled = _transport.TransportCancelled
    TransportError = _transport.TransportError


PREFIX_BYTES = 65_536
CHUNK_BYTES = 4 * 1024 * 1024
PARALLEL_THRESHOLD = 8 * 1024 * 1024
MAX_WORKERS = 4
_MAX_INTEGER = (1 << 63) - 1
_PROTOCOLS = frozenset(("h3", "h2", "http/1.1"))


class TransferError(Exception):
    """A fixed, safe download error suitable for display in the application."""

    def __init__(self, message, *, compatibility_fallback=False):
        super().__init__(message)
        self.compatibility_fallback = bool(compatibility_fallback)


class TransferHTTPError(TransferError):
    """Only the public status code is retained, never response bodies or URLs."""

    def __init__(self, status):
        self.status = status
        super().__init__(f"서버가 다운로드 요청을 거부했습니다 (HTTP {status}).")


class TransferFileError(TransferError):
    """Preserve only numeric OS diagnostics for the engine's safe classification."""

    def __init__(self, error):
        self.errno = error.errno
        self.winerror = getattr(error, "winerror", None)
        super().__init__("다운로드 파일을 읽거나 기록하지 못했습니다.")


class TransferCancelled(TransferError):
    pass


@dataclass(frozen=True)
class TransferResult:
    size: int
    prefix: bytes
    mode: str
    protocols: tuple[str, ...]


class _TransientError(TransferError):
    def __init__(self, delay=None):
        super().__init__("다운로드 요청을 완료하지 못했습니다. 다시 시도하세요.")
        self.delay = delay


class _CombinedCancel:
    """An Event-compatible view; closing a request never sets caller state."""
    def __init__(self, caller, stopped):
        self.caller, self.stopped = caller, stopped

    def is_set(self):
        return self.caller.is_set() or self.stopped.is_set()

    def wait(self, timeout=None):
        deadline = None if timeout is None else time.monotonic() + max(0, timeout)
        while not self.is_set():
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                return self.is_set()
            self.stopped.wait(0.05 if remaining is None else min(0.05, remaining))
        return True


def _check(cancel):
    if cancel.is_set():
        raise TransferCancelled("다운로드를 취소했습니다.")


def _integer(value):
    if not isinstance(value, str) or len(value) > 19 or re.fullmatch(r"[0-9]+", value) is None:
        raise TransferError("서버가 올바르지 않은 파일 크기를 반환했습니다.")
    result = int(value)
    if result > _MAX_INTEGER:
        raise TransferError("서버가 올바르지 않은 파일 크기를 반환했습니다.")
    return result


def _length(headers):
    value = headers.get("content-length")
    return None if value is None else _integer(value)


def _range(headers):
    value = headers.get("content-range", "")
    match = re.fullmatch(r"bytes ([0-9]+)-([0-9]+)/([0-9]+|\*)", value, re.I)
    if match is None:
        raise TransferError("서버가 올바르지 않은 다운로드 범위를 반환했습니다.")
    start, end = _integer(match[1]), _integer(match[2])
    total = None if match[3] == "*" else _integer(match[3])
    if start > end or end == _MAX_INTEGER or (total is not None and total <= end):
        raise TransferError("서버가 올바르지 않은 다운로드 범위를 반환했습니다.")
    return start, end, total


def _etag(headers):
    value = headers.get("etag")
    if isinstance(value, str) and len(value) <= 1024 and re.fullmatch(r'"[\x21\x23-\x7e\x80-\xff]*"', value):
        return value
    return None


def _identity(headers):
    value = headers.get("content-encoding", "")
    if not isinstance(value, str) or value.strip().lower() not in ("", "identity"):
        raise TransferError("서버가 요청과 다른 파일 인코딩을 반환했습니다.")


def _retry_after(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if re.fullmatch(r"[0-9]+", value):
        # Long decimal strings need no integer conversion to reject long waits.
        return float(value) if len(value) <= 8 else 6.0
    try:
        date = parsedate_to_datetime(value)
        if date.tzinfo is None:
            date = date.replace(tzinfo=timezone.utc)
        return max(0.0, (date - datetime.now(timezone.utc)).total_seconds())
    except (TypeError, ValueError, OverflowError):
        return None


class _OwnedFile:
    def __init__(self, destination, cancel):
        self.path = Path(destination)
        self.cancel = cancel
        self.lock = threading.Lock()
        self.fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
        try:
            self.identity = os.fstat(self.fd)
        except BaseException:
            os.close(self.fd)
            raise

    def write(self, position, data):
        # seek + write is protected on Windows, which does not provide pwrite.
        view = None
        try:
            with self.lock:
                _check(self.cancel)
                os.lseek(self.fd, position, os.SEEK_SET)
                view = memoryview(data)
                while view:
                    _check(self.cancel)
                    count = os.write(self.fd, view)
                    if count <= 0:
                        raise TransferError("다운로드 파일을 저장하지 못했습니다.")
                    view = view[count:]
        finally:
            if view is not None:
                view.release()
            data = None

    def close(self):
        if self.fd is not None:
            fd, self.fd = self.fd, None
            os.close(fd)

    def remove(self):
        # Never remove a preexisting file or a path replaced by another actor.
        try:
            current = self.path.lstat()
            if stat.S_ISREG(current.st_mode) and (current.st_dev, current.st_ino) == (self.identity.st_dev, self.identity.st_ino):
                self.path.unlink()
        except FileNotFoundError:
            pass


def download_file(url, destination, *, transport, resources, cancel, workers=4,
                  headers=None, progress=None, protocol=None, on_wait=None,
                  mode=None, connections=None) -> TransferResult:
    """Create ``destination`` exclusively and remove it on failed transfers.

    Callbacks receive progress(bytes, total_or_None), protocol(actual_value),
    mode('parallel' or 'single'), and connections(actual_worker_count). Callbacks
    are serialized. A supplied cancellation event is observed but never set.
    """
    if type(workers) is not int or not 1 <= workers <= MAX_WORKERS:
        raise TransferError("다운로드 연결 수가 올바르지 않습니다.")
    _check(cancel)
    stop = threading.Event()
    combined = _CombinedCancel(cancel, stop)
    callbacks = threading.RLock()
    scheduling = threading.Lock()
    observed = []
    failure = []
    threads = []
    writer = None
    completed = 0
    try:
        base_headers = {key: value for key, value in (headers or {}).items()
                        if key.lower() not in ("range", "if-range", "if-match", "accept-encoding")}
    except (AttributeError, TypeError, ValueError):
        raise TransferError("다운로드 요청 설정이 올바르지 않습니다.") from None
    base_headers["Accept-Encoding"] = "identity"

    def set_mode(value, count):
        with callbacks:
            if mode is not None:
                mode(value)
            if connections is not None:
                connections(count)

    def record_protocol(response):
        value = response.actual_protocol
        if value not in _PROTOCOLS:
            return
        with callbacks:
            if value not in observed:
                observed.append(value)
                if protocol is not None:
                    protocol(value)

    def waiting():
        with callbacks:
            if on_wait is not None:
                on_wait()

    def commit(position, data, total):
        nonlocal completed
        try:
            writer.write(position, data)
            with callbacks:
                _check(combined)
                completed += len(data)
                if progress is not None:
                    progress(completed, total)
        finally:
            data = None

    @contextmanager
    def request(target, extra=None):
        _check(combined)
        request_headers = {**base_headers, **(extra or {})}
        with resources.hold("network", combined, on_wait=waiting if on_wait is not None else None):
            _check(combined)
            with transport.open(target, headers=request_headers, cancel=combined, timeout=30) as response:
                _check(combined)
                record_protocol(response)
                status = response.status
                if status == 408 or status == 429 or 500 <= status <= 599:
                    delay = _retry_after(response.headers.get("retry-after"))
                    if delay is None or delay <= 5:
                        raise _TransientError(delay)
                    raise TransferError("서버가 긴 대기를 요청했습니다. 잠시 후 다시 시도하세요.")
                if status not in (200, 206):
                    raise TransferHTTPError(status)
                yield response

    def retry(work, *, single=False, committed=None):
        for attempt in range(3):
            _check(combined)
            try:
                return work()
            except TransportCancelled:
                raise TransferCancelled("다운로드를 취소했습니다.") from None
            except (_TransientError, TransportError) as error:
                _check(combined)
                retryable = isinstance(error, _TransientError) or error.retryable
                if attempt == 2 or not retryable or (single and completed) or (committed is not None and committed()):
                    raise TransferError("다운로드 연결이 중단되었습니다. 다시 시도하세요.",
                                        compatibility_fallback=isinstance(error, TransportError) and error.retryable) from None
                delay = error.delay if isinstance(error, _TransientError) else None
                if delay is None:
                    delay = min(5.0, 0.3 * (2 ** attempt) * random.uniform(0.8, 1.2))
                if combined.wait(delay):
                    raise TransferCancelled("다운로드를 취소했습니다.")

    def exact(response, length):
        data = bytearray(length)
        part = None
        try:
            used = 0
            while used < length:
                _check(combined)
                requested = min(65_536, length - used)
                part = response.read(requested)
                _check(combined)
                if not part:
                    raise TransferError("다운로드 파일이 불완전합니다. 다시 시도하세요.")
                if len(part) > requested:
                    raise TransferError("서버가 요청한 범위보다 많은 데이터를 반환했습니다.")
                data[used:used + len(part)] = part
                used += len(part)
            _check(combined)
            if response.read(1):
                raise TransferError("서버가 요청한 범위보다 많은 데이터를 반환했습니다.")
            _check(combined)
            return data
        finally:
            # Failed request tracebacks must not retain a chunk after its lease.
            part = None
            data = None

    def single(response):
        if response.status != 200 or "content-range" in response.headers:
            raise TransferError("서버가 전체 파일 요청에 일부 데이터만 반환했습니다.")
        _identity(response.headers)
        total = _length(response.headers)
        set_mode("single", 1)
        prefix = bytearray()
        size = 0
        part = None
        try:
            while True:
                _check(combined)
                requested = CHUNK_BYTES if total is None else min(CHUNK_BYTES, total - size + 1)
                part = response.read(requested)
                _check(combined)
                if not part:
                    break
                if len(part) > requested or size + len(part) > _MAX_INTEGER or (total is not None and size + len(part) > total):
                    raise TransferError("다운로드 파일 크기가 서버 응답과 일치하지 않습니다.")
                if len(prefix) < PREFIX_BYTES:
                    prefix.extend(memoryview(part)[:PREFIX_BYTES - len(prefix)])
                commit(size, part, total)
                size += len(part)
                # Drop buffers before another read or a request lease release.
                part = None
            if total is not None and size != total:
                raise TransferError("다운로드 파일이 불완전합니다. 다시 시도하세요.")
            return TransferResult(size, bytes(prefix), "single", tuple(observed))
        finally:
            part = None

    def probe():
        with request(url, {"Range": f"bytes=0-{PREFIX_BYTES - 1}"}) as response:
            if response.status == 200:
                return single(response)
            _identity(response.headers)
            start, end, total = _range(response.headers)
            if start != 0 or end >= PREFIX_BYTES or (total is not None and end != min(total, PREFIX_BYTES) - 1):
                raise TransferError("서버가 올바르지 않은 확인 범위를 반환했습니다.")
            expected = end + 1
            declared = _length(response.headers)
            if declared is not None and declared != expected:
                raise TransferError("다운로드 범위 크기가 서버 응답과 일치하지 않습니다.")
            prefix = exact(response, expected)
            etag = _etag(response.headers)
            if total is None or total < PARALLEL_THRESHOLD or etag is None or workers == 1:
                return None
            count = min(workers, (total - expected + CHUNK_BYTES - 1) // CHUNK_BYTES)
            set_mode("parallel", count)
            commit(0, prefix, total)
            return bytes(prefix), total, etag, response.url or url, count

    try:
        writer = _OwnedFile(destination, combined)
        try:
            result = retry(probe, single=True)
        except TransferHTTPError as error:
            # Some media endpoints reject Range even though ordinary GET is
            # permitted. No bytes were committed: use a fresh whole response.
            if error.status not in (400, 403, 405, 416) or completed:
                raise
            result = None
        if isinstance(result, TransferResult):
            _check(combined)
            writer.close()
            return result
        if result is None:
            def full():
                with request(url) as response:
                    return single(response)
            result = retry(full, single=True)
            _check(combined)
            writer.close()
            return result

        prefix, total, etag, target, count = result
        next_position = len(prefix)

        def worker():
            nonlocal next_position
            try:
                while True:
                    with scheduling:
                        _check(combined)
                        if next_position >= total:
                            return
                        start = next_position
                        length = min(CHUNK_BYTES, total - start)
                        next_position += length

                    written = False

                    def chunk():
                        nonlocal written
                        with request(target, {"Range": f"bytes={start}-{start + length - 1}",
                                              "If-Range": etag, "If-Match": etag}) as response:
                            _identity(response.headers)
                            if response.status != 206 or _etag(response.headers) != etag or (response.url and response.url != target):
                                raise TransferError("다운로드 중 파일이 변경되었거나 구간 요청을 지원하지 않습니다.")
                            actual = _range(response.headers)
                            declared = _length(response.headers)
                            if actual != (start, start + length - 1, total) or (declared is not None and declared != length):
                                raise TransferError("다운로드 조각의 범위나 크기가 일치하지 않습니다.")
                            data = None
                            try:
                                data = exact(response, length)
                                written = True
                                commit(start, data, total)
                            finally:
                                data = None
                    retry(chunk, committed=lambda: written)
            except BaseException as error:
                with scheduling:
                    if not failure:
                        # Joined workers retain only the public error, without
                        # keeping completed request frames or their buffers.
                        error.__traceback__ = None
                        error.__context__ = None
                        error.__cause__ = None
                        failure.append(error)
                    stop.set()

        for _ in range(count):
            thread = threading.Thread(target=worker, name="media-range", daemon=False)
            threads.append(thread)
            thread.start()
        for thread in threads:
            thread.join()
        if failure:
            raise failure[0]
        _check(combined)
        if completed != total:
            raise TransferError("다운로드 파일이 불완전합니다. 다시 시도하세요.")
        writer.close()
        return TransferResult(total, prefix, "parallel", tuple(observed))
    except BaseException as error:
        stop.set()
        for thread in threads:
            if thread.ident is not None:
                thread.join()
        if writer is not None:
            try:
                writer.close()
            except OSError:
                pass
            try:
                writer.remove()
            except OSError:
                pass
        if isinstance(error, (KeyboardInterrupt, SystemExit)):
            raise
        if cancel.is_set() or isinstance(error, (TransferCancelled, TransportCancelled, ResourceCancelled)):
            raise TransferCancelled("다운로드를 취소했습니다.") from None
        if isinstance(error, TransferError):
            raise error from None
        if isinstance(error, OSError):
            raise TransferFileError(error) from None
        raise TransferError("미디어 전송 처리 중 오류가 발생했습니다. 다시 시도하세요. (TRANSFER_INTERNAL)") from None


# Package imports and the isolated Windows worker share public type identities.
_this_module = sys.modules[__name__]
_shared_module = sys.modules.setdefault("_myvideoapp_transfer", _this_module)
if _shared_module is not _this_module:
    TransferError = _shared_module.TransferError
    TransferHTTPError = _shared_module.TransferHTTPError
    TransferFileError = _shared_module.TransferFileError
    TransferCancelled = _shared_module.TransferCancelled
    TransferResult = _shared_module.TransferResult
    download_file = _shared_module.download_file
    sys.modules[__name__] = _shared_module
