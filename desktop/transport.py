"""Verified native HTTP streaming for desktop media transfers.

Each leased curl easy handle belongs to one response thread. Consumers receive a
bounded stream, and closing a response cancels only that response. No browser
profile, default User-Agent, or disabled TLS verification is used.
"""
from __future__ import annotations

from collections.abc import Mapping
import ctypes
import importlib
import importlib.util
import math
import os
from pathlib import Path
import queue
import re
import sys
import threading
import time
from urllib.parse import urlsplit


CURL_CFFI_VERSION = "0.17.0"
CHUNK_SIZE = 64 * 1024
BUFFER_SLOTS = 2
_POLL_SECONDS = 0.05
_MAX_HEADER_BYTES = 256 * 1024
_MAX_CA_BYTES = 2 * 1024 * 1024
_WRITE_ERROR = 0xFFFFFFFF
_HEADER_NAME = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+\Z")
_RETRYABLE_CODES = frozenset((5, 6, 7, 16, 18, 28, 35, 52, 55, 56, 81, 92, 95, 96, 97))
_BANDWIDTH_IMPORT_LOCK = threading.Lock()


class _CurlBlob(ctypes.Structure):
    # curl_cffi 0.17.0's compiled FFI does not declare struct curl_blob.
    _fields_ = (("data", ctypes.c_void_p), ("length", ctypes.c_size_t), ("flags", ctypes.c_uint))


class TransportError(Exception):
    """A fixed public message; native errors can contain private source URLs."""

    def __init__(self, message="The media connection failed.", *, retryable=True, code=None):
        super().__init__(message)
        self.retryable = bool(retryable)
        self.code = code if type(code) is int else None


class TransportCancelled(TransportError):
    def __init__(self):
        super().__init__("The media connection was cancelled.", retryable=False)


class _Headers(Mapping):
    """Immutable header view with lowercase keys and case-insensitive lookup."""

    def __init__(self, headers):
        self._values = dict(headers)

    def __getitem__(self, name):
        return self._values[name.lower()]

    def __iter__(self):
        return iter(self._values)

    def __len__(self):
        return len(self._values)


def _cancelled(cancel):
    return cancel is not None and cancel.is_set()


def _default_bandwidth():
    with _BANDWIDTH_IMPORT_LOCK:
        key = "_myvideoapp_bandwidth"
        module = sys.modules.get(key)
        if module is None:
            try:
                module = importlib.import_module(".bandwidth", __package__)
            except (ImportError, TypeError):
                spec = importlib.util.spec_from_file_location(key, Path(__file__).absolute().with_name("bandwidth.py"))
                module = importlib.util.module_from_spec(spec)
                sys.modules[key] = module
                try:
                    spec.loader.exec_module(module)
                except BaseException:
                    sys.modules.pop(key, None)
                    raise
        return module.PROCESS_BANDWIDTH


def _safe_error(error):
    if isinstance(error, TransportError):
        return error
    code = getattr(error, "code", None)
    code = int(code) if isinstance(code, int) else None
    return TransportError(retryable=code in _RETRYABLE_CODES, code=code)


def _request_headers(headers):
    result = []
    total = 0
    try:
        for name, value in (headers or {}).items():
            if not isinstance(name, str) or not _HEADER_NAME.fullmatch(name) or not isinstance(value, str):
                raise ValueError()
            if name.lower() in ("authorization", "cookie", "proxy-authorization"):
                raise ValueError()
            if any(ord(character) < 32 and character != "\t" or ord(character) == 127 for character in value):
                raise ValueError()
            line = (name + ": " + value).encode("latin-1")
            total += len(line) + 2
            if total > _MAX_HEADER_BYTES:
                raise ValueError()
            result.append(line)
    except (AttributeError, ValueError, UnicodeError):
        raise TransportError("The media request headers are invalid.", retryable=False) from None
    return result


def _validate_url(url):
    try:
        if not isinstance(url, str) or not 1 <= len(url) <= 16384 or "\\" in url:
            raise ValueError()
        if any(ord(character) <= 32 or ord(character) == 127 for character in url):
            raise ValueError()
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username is not None or parts.password is not None or parts.port == 0:
            raise ValueError()
    except (ValueError, UnicodeError):
        raise TransportError("The media address is invalid.", retryable=False) from None


class NativeTransport:
    """A bounded, thread-safe curl easy-handle pool using HTTP/2 or HTTP/1.1.

    ``timeout`` on open bounds connection/header waits and read inactivity, not
    the duration of the complete media download. Proxy environment variables are
    inherited by libcurl. A supplied CA or CA environment override is verified
    for both the origin and HTTPS proxy.
    """

    def __init__(self, max_connections=4, ca_file=None, bandwidth_limiter=None):
        if type(max_connections) is not int or not 1 <= max_connections <= 64:
            raise ValueError("max_connections must be between 1 and 64.")
        self.max_connections = max_connections
        self.ca_file = str(ca_file) if ca_file is not None else None
        self.bandwidth_limiter = bandwidth_limiter
        self._condition = threading.Condition()
        self._idle = []
        self._created = 0
        self._responses = set()
        self._threads = set()
        self._closed = False
        self._backend = None

    def _load_backend(self):
        if self._backend is not None:
            return self._backend
        # This libcurl fork applies this environment profile even to low-level
        # curl_easy_init/reset. Refuse it without modifying process-wide state.
        if os.environ.get("CURL_IMPERSONATE"):
            raise TransportError("Browser impersonation is not supported.", retryable=False)
        try:
            backend = importlib.import_module("curl_cffi")
            if backend.__version__ != CURL_CFFI_VERSION:
                raise ImportError()
        except (ImportError, OSError, AttributeError):
            raise TransportError("The native media transport is unavailable.", retryable=False) from None
        self._backend = backend
        return backend

    def _trusted_ca(self):
        path = self.ca_file
        if path is None:
            for name in ("SSL_CERT_FILE", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE"):
                if os.environ.get(name):
                    path = os.environ[name]
                    break
        if path is None:
            try:
                path = importlib.import_module("certifi").where()
            except (ImportError, OSError, AttributeError):
                raise TransportError("The trusted certificate bundle is unavailable.", retryable=False) from None
        if not isinstance(path, str) or not Path(path).is_file():
            raise TransportError("The trusted certificate bundle is unavailable.", retryable=False)
        return path

    def _trusted_ca_bytes(self):
        try:
            # Python opens Unicode Windows paths natively. Limit the read too,
            # so a changed file cannot bypass a prior size check.
            with Path(self._trusted_ca()).open("rb") as bundle:
                certificates = bundle.read(_MAX_CA_BYTES + 1)
            if not certificates or len(certificates) > _MAX_CA_BYTES:
                raise ValueError()
            return certificates
        except (OSError, ValueError):
            raise TransportError("The trusted certificate bundle is unavailable.", retryable=False) from None

    def _acquire(self, cancel):
        with self._condition:
            while True:
                if _cancelled(cancel):
                    raise TransportCancelled()
                if self._closed:
                    raise TransportError("The media transport is closed.", retryable=False)
                self._threads = {thread for thread in self._threads if thread.is_alive()}
                if self._idle:
                    return self._idle.pop()
                if self._created < self.max_connections:
                    backend = self._load_backend()
                    try:
                        handle = backend.Curl(cacert=self._trusted_ca())
                    except TransportError:
                        raise
                    except Exception:
                        raise TransportError("The native media transport is unavailable.", retryable=False) from None
                    self._created += 1
                    return handle
                self._condition.wait(_POLL_SECONDS)

    def _release(self, handle, response=None, reusable=True):
        with self._condition:
            if response is not None:
                self._responses.discard(response)
            if self._closed or not reusable:
                try:
                    handle.close()
                finally:
                    self._created -= 1
            else:
                self._idle.append(handle)
            self._condition.notify_all()

    def open(self, url, headers=None, cancel=None, timeout=30):
        _validate_url(url)
        prepared_headers = _request_headers(headers)
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be a positive finite number.")
        handle = self._acquire(cancel)
        with self._condition:
            if self._closed or _cancelled(cancel):
                self._release(handle)
                if _cancelled(cancel):
                    raise TransportCancelled()
                raise TransportError("The media transport is closed.", retryable=False)
            response = Response(self, handle, url, prepared_headers, cancel, float(timeout))
            self._responses.add(response)
            self._threads.add(response._thread)
            try:
                response._thread.start()
            except BaseException:
                self._threads.discard(response._thread)
                self._release(handle, response)
                raise
        try:
            response._wait_headers()
            return response
        except BaseException:
            response.close()
            raise

    def close(self):
        with self._condition:
            self._closed = True
            responses = tuple(self._responses)
            threads = tuple(self._threads)
            idle, self._idle = self._idle, []
            for response in responses:
                response._stop.set()
            self._condition.notify_all()
        for handle in idle:
            try:
                handle.close()
            finally:
                with self._condition:
                    self._created -= 1
                    self._condition.notify_all()
        for thread in threads:
            if thread is not threading.current_thread():
                thread.join()
        with self._condition:
            # An opener can have reserved a handle just before close acquired
            # the lock. It observes _closed and returns that handle itself.
            while self._created:
                self._condition.wait(_POLL_SECONDS)
            self._threads.clear()

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()


class Response:
    """A response whose body is pulled from at most two 64 KiB queue slots."""

    def __init__(self, transport, handle, url, request_headers, cancel, timeout):
        self.status = 0
        self.status_code = 0
        self.headers = _Headers({})
        self.url = url
        self.actual_protocol = ""
        self.protocol = ""
        self._transport = transport
        self._handle = handle
        self._request_url = url
        self._request_headers = request_headers
        self._cancel = cancel
        self._timeout = timeout
        self._stop = threading.Event()
        self._closed = threading.Event()
        self._done = threading.Event()
        self._headers_ready = threading.Event()
        self._queue = queue.Queue(maxsize=BUFFER_SLOTS)
        self._read_lock = threading.Lock()
        self._remainder = b""
        self._error = None
        self._header_status = 0
        self._header_values = {}
        self._header_bytes = 0
        self._progress_callback = None
        self._bandwidth_limiter = None
        self._thread = threading.Thread(target=self._run, name="native-media-stream", daemon=True)

    def _is_cancelled(self):
        return self._stop.is_set() or _cancelled(self._cancel)

    def _check_cancel(self):
        if self._is_cancelled():
            raise TransportCancelled()

    # The shared limiter accepts an Event-compatible cancellation view. Keeping
    # this local avoids ever setting the caller's Event when a response closes.
    def is_set(self):
        return self._is_cancelled()

    def wait(self, timeout=None):
        deadline = None if timeout is None else time.monotonic() + max(0, timeout)
        while not self._is_cancelled():
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                return False
            self._stop.wait(_POLL_SECONDS if remaining is None else min(_POLL_SECONDS, remaining))
        return True

    def _wait_headers(self):
        deadline = time.monotonic() + self._timeout
        while not self._headers_ready.wait(_POLL_SECONDS):
            self._check_cancel()
            if self._done.is_set():
                raise self._error or TransportError()
            if time.monotonic() >= deadline:
                raise TransportError("The media connection timed out.", code=28)
        self._check_cancel()

    def _publish_headers(self):
        if self._headers_ready.is_set():
            return
        backend = self._transport._backend
        version = int(self._handle.getinfo(backend.CurlInfo.HTTP_VERSION))
        protocol = {3: "h2", 2: "http/1.1", 1: "http/1.0"}.get(version)
        if protocol is None or not 100 <= self._header_status <= 599:
            raise TransportError("The media response is invalid.", retryable=False)
        effective = self._handle.getinfo(backend.CurlInfo.EFFECTIVE_URL)
        effective = effective.decode("utf-8", "replace") if isinstance(effective, bytes) else str(effective)
        _validate_url(effective)
        self.status = self.status_code = self._header_status
        self.headers = _Headers(self._header_values)
        self.url = effective
        self.actual_protocol = self.protocol = protocol
        self._headers_ready.set()

    def _on_header(self, data):
        if self._is_cancelled():
            return _WRITE_ERROR
        if self._headers_ready.is_set():
            return len(data)  # Trailers cannot change the published response.
        self._header_bytes += len(data)
        if self._header_bytes > _MAX_HEADER_BYTES:
            raise TransportError("The media response headers are too large.", retryable=False)
        if data.startswith(b"HTTP/"):
            try:
                status = int(data.split(None, 2)[1])
                if not 100 <= status <= 599:
                    raise ValueError()
            except (IndexError, ValueError):
                raise TransportError("The media response is invalid.", retryable=False) from None
            self._header_status = status
            self._header_values = {}
        elif data in (b"\r\n", b"\n"):
            if self._header_status >= 200 and not (300 <= self._header_status < 400 and "location" in self._header_values):
                self._publish_headers()
        elif b":" in data:
            name, value = data.split(b":", 1)
            name = name.decode("latin-1").lower()
            if not _HEADER_NAME.fullmatch(name):
                raise TransportError("The media response is invalid.", retryable=False)
            value = value.strip().decode("latin-1")
            # Duplicate singleton validators/range metadata are ambiguous. Keep
            # their comma-joined form so transfer validation rejects them.
            if name in self._header_values:
                value = self._header_values[name] + ", " + value
            self._header_values[name] = value
        return len(data)

    def _on_body(self, data):
        if self._is_cancelled():
            return _WRITE_ERROR
        redirect = 300 <= self._header_status < 400 and "location" in self._header_values and not self._headers_ready.is_set()
        if not redirect and not self._headers_ready.is_set():
            self._publish_headers()
        for offset in range(0, len(data), CHUNK_SIZE):
            chunk = data[offset:offset + CHUNK_SIZE]
            self._bandwidth_limiter.consume(len(chunk), self)
            if redirect:
                continue
            while True:
                if self._is_cancelled():
                    return _WRITE_ERROR
                try:
                    self._queue.put(chunk, timeout=_POLL_SECONDS)
                    break
                except queue.Full:
                    pass
        return len(data)

    def _configure(self):
        backend = self._transport._backend
        option = backend.CurlOpt
        handle = self._handle
        if os.environ.get("CURL_IMPERSONATE"):
            raise TransportError("Browser impersonation is not supported.", retryable=False)
        self._bandwidth_limiter = self._transport.bandwidth_limiter
        if self._bandwidth_limiter is None:
            self._bandwidth_limiter = _default_bandwidth()
        handle.reset()
        certificates = self._transport._trusted_ca_bytes()
        settings = (
            (option.URL, self._request_url),
            (option.HTTPGET, 1),
            (option.HTTP_VERSION, backend.CurlHttpVersion.V2TLS),
            (option.FOLLOWLOCATION, 1),
            (option.MAXREDIRS, 10),
            (option.PROTOCOLS_STR, "http,https"),
            (option.REDIR_PROTOCOLS_STR, "https" if urlsplit(self._request_url).scheme == "https" else "http,https"),
            (option.SUPPRESS_CONNECT_HEADERS, 1),
            (option.SSL_VERIFYPEER, 1),
            (option.SSL_VERIFYHOST, 2),
            (option.PROXY_SSL_VERIFYPEER, 1),
            (option.PROXY_SSL_VERIFYHOST, 2),
            # Suppress Curl._ensure_cacert's narrow Windows filepath handling.
            # The trusted PEM bytes are installed below for origin and proxy.
            (option.CAINFO, backend.ffi.NULL),
            (option.PROXY_CAINFO, backend.ffi.NULL),
            (option.NOSIGNAL, 1),
            (option.NETRC, 0),
            (option.DISALLOW_USERNAME_IN_URL, 1),
            (option.CONNECTTIMEOUT_MS, max(1, min(2147483647, int(min(self._timeout, 2147483.647) * 1000)))),
            (option.LOW_SPEED_LIMIT, 1),
            (option.LOW_SPEED_TIME, min(2147483647, max(1, math.ceil(self._timeout)))),
            (option.BUFFERSIZE, CHUNK_SIZE),
            (option.MAXCONNECTS, 1),
            (option.TCP_KEEPALIVE, 1),
            (option.HTTP_CONTENT_DECODING, 0),
            (option.HTTPHEADER, self._request_headers),
            (option.HEADERFUNCTION, self._on_header),
            (option.WRITEFUNCTION, self._on_body),
            (option.NOPROGRESS, 0),
        )
        for name, value in settings:
            handle.setopt(name, value)
        # CURLOPT_*_CAINFO_BLOB accepts a standard ABI struct curl_blob. COPY=1
        # makes libcurl own its bytes before these local buffers are released.
        # Unsupported blob options fail closed; TLS verification stays enabled.
        ca_buffer = ctypes.create_string_buffer(certificates, len(certificates))
        ca_blob = _CurlBlob(ctypes.addressof(ca_buffer), len(certificates), 1)
        ca_pointer = backend.ffi.cast("void *", ctypes.addressof(ca_blob))
        for name in (option.CAINFO_BLOB, option.PROXY_CAINFO_BLOB):
            result = backend.lib._curl_easy_setopt(handle._curl, name, ca_pointer)
            if result:
                raise TransportError("The trusted certificate bundle is unavailable.", retryable=False)
        # 0.17.0's Python setopt wrapper has no XFERINFOFUNCTION conversion.
        # Keep this CFFI closure alive until the owning perform/reset completes.
        self._progress_callback = backend.ffi.callback(
            "int(void *, curl_off_t, curl_off_t, curl_off_t, curl_off_t)",
            lambda *_args: int(self._is_cancelled()),
            error=1,
        )
        result = backend.lib._curl_easy_setopt(handle._curl, option.XFERINFOFUNCTION, self._progress_callback)
        if result:
            raise TransportError("The native media transport is unavailable.", retryable=False)

    def _run(self):
        reusable = True
        try:
            self._check_cancel()
            self._configure()
            self._handle.perform()
            self._check_cancel()
            if not self._headers_ready.is_set():
                self._publish_headers()
        except BaseException as error:
            self._error = TransportCancelled() if self._is_cancelled() else _safe_error(error)
        finally:
            try:
                # perform cleans its callback buffers; configure failures must
                # do so too. Reset removes native pointers before pool reuse.
                self._handle.reset()
                self._handle.clean_handles_and_buffers()
            except Exception:
                reusable = False
            self._progress_callback = None
            self._done.set()
            self._transport._release(self._handle, self, reusable)

    def read(self, size=CHUNK_SIZE):
        if type(size) is not int or size < 0:
            raise ValueError("A nonnegative read size is required.")
        if size == 0:
            return b""
        with self._read_lock:
            deadline = time.monotonic() + self._timeout
            while True:
                if self._closed.is_set():
                    return b""
                self._check_cancel()
                if self._remainder:
                    chunk, self._remainder = self._remainder, b""
                    break
                try:
                    # Wake as soon as bytes arrive; polling only empty streams
                    # keeps cancellation bounded without throttling downloads.
                    chunk = self._queue.get(timeout=min(_POLL_SECONDS, max(0, deadline - time.monotonic())))
                    break
                except queue.Empty:
                    if self._done.is_set():
                        if self._error is not None:
                            raise self._error
                        return b""
                    if time.monotonic() >= deadline:
                        self._stop.set()
                        raise TransportError("The media connection timed out.", code=28)
            if self._closed.is_set():
                return b""
            self._check_cancel()
            result, self._remainder = chunk[:size], chunk[size:]
            return result

    def close(self):
        self._closed.set()
        self._stop.set()
        if self._thread is not threading.current_thread():
            self._thread.join()
        self._remainder = b""
        while True:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()


# Isolated desktop workers and package imports must share exception identities.
_this_module = sys.modules[__name__]
_shared_module = sys.modules.setdefault("_myvideoapp_transport", _this_module)
if _shared_module is not _this_module:
    TransportError = _shared_module.TransportError
    TransportCancelled = _shared_module.TransportCancelled
    NativeTransport = _shared_module.NativeTransport
    Response = _shared_module.Response
    sys.modules[__name__] = _shared_module
