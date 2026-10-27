"""New, focused checks for the removal of the desktop HTTP/3 request path.

python -I -B desktop/test_no_http3.py --app-root EXTRACTED_APP -v
Add --real-http1 with the bundled interpreter to require a real curl loopback
HTTP/1.1 transfer. Other checks use only stdlib-controlled boundaries; they do
not claim a live HTTP/2 negotiation or contact an external media service.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import inspect
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch


_parser = argparse.ArgumentParser(add_help=False)
_parser.add_argument("--app-root", type=Path, default=Path(__file__).resolve().parents[1])
_parser.add_argument("--real-http1", action="store_true")
_options, _test_arguments = _parser.parse_known_args()
APP_ROOT = _options.app_root.resolve(strict=True)
sys.path.insert(0, str(APP_ROOT / "desktop"))

import engine
from concurrency import ResourceBudget
from storage import Storage
import transfer
import transport


DIRECT = "https://media.example.test/fixture.mp4"
MEDIA = b"\0\0\0\x18ftypisom" + bytes(range(256)) * 640


class NoLimit:
    def consume(self, amount, cancel=None):
        pass


class FakeHandle:
    def __init__(self, version=3, url=DIRECT):
        self.options = {}
        self.version, self.url = version, url
        self._curl = object()
        self.resets = 0

    def reset(self):
        self.resets += 1
        self.options.clear()

    def setopt(self, name, value):
        self.options[name] = value

    def getinfo(self, name):
        return self.version if name == "HTTP_VERSION" else self.url.encode()


def fake_backend():
    # V3 is deliberately absent: configuring a request cannot require it.
    names = """URL HTTPGET HTTP_VERSION FOLLOWLOCATION MAXREDIRS PROTOCOLS_STR
        REDIR_PROTOCOLS_STR SUPPRESS_CONNECT_HEADERS SSL_VERIFYPEER SSL_VERIFYHOST
        PROXY_SSL_VERIFYPEER PROXY_SSL_VERIFYHOST CAINFO PROXY_CAINFO NOSIGNAL
        NETRC DISALLOW_USERNAME_IN_URL CONNECTTIMEOUT_MS LOW_SPEED_LIMIT
        LOW_SPEED_TIME BUFFERSIZE MAXCONNECTS TCP_KEEPALIVE HTTP_CONTENT_DECODING
        HTTPHEADER HEADERFUNCTION WRITEFUNCTION NOPROGRESS CAINFO_BLOB
        PROXY_CAINFO_BLOB XFERINFOFUNCTION""".split()
    native_options = []
    return SimpleNamespace(
        CurlOpt=SimpleNamespace(**{name: name for name in names}),
        CurlInfo=SimpleNamespace(HTTP_VERSION="HTTP_VERSION", EFFECTIVE_URL="EFFECTIVE_URL"),
        CurlHttpVersion=SimpleNamespace(V2TLS=object()),
        ffi=SimpleNamespace(NULL=None, cast=lambda kind, address: address,
                            callback=lambda kind, function, error: function),
        lib=SimpleNamespace(_curl_easy_setopt=lambda handle, name, value:
                            native_options.append((name, value)) or 0),
        native_options=native_options,
    )


class NativeConfigurationTests(unittest.TestCase):
    def response(self, url=DIRECT, version=3):
        client = transport.NativeTransport(bandwidth_limiter=NoLimit())
        client._backend = fake_backend()
        handle = FakeHandle(version, url)
        response = transport.Response(client, handle, url, [b"Range: bytes=0-3"], threading.Event(), 7.5)
        return client, handle, response

    def test_removed_capability_cannot_be_enabled_by_a_constructor_argument(self):
        self.assertNotIn("http3_enabled", inspect.signature(transport.NativeTransport).parameters)
        self.assertFalse(hasattr(transport.NativeTransport(), "http3_enabled"))
        with self.assertRaises(TypeError):
            transport.NativeTransport(http3_enabled=True)

    def test_http_and_https_always_use_v2tls_without_a_v3_enum(self):
        for url in (DIRECT, DIRECT.replace("https:", "http:")):
            with self.subTest(url=url):
                client, handle, response = self.response(url)
                with patch.object(client, "_trusted_ca_bytes", return_value=b"fixture CA bytes"), \
                     patch.dict(os.environ, {"CURL_IMPERSONATE": ""}):
                    response._configure()
                self.assertFalse(hasattr(client._backend.CurlHttpVersion, "V3"))
                self.assertIs(handle.options["HTTP_VERSION"], client._backend.CurlHttpVersion.V2TLS)
                self.assertEqual(handle.resets, 1)
                self.assertEqual(handle.options["HTTPHEADER"], [b"Range: bytes=0-3"])
                self.assertEqual(handle.options["REDIR_PROTOCOLS_STR"], "https" if url.startswith("https:") else "http,https")
                self.assertEqual(handle.options["CONNECTTIMEOUT_MS"], 7500)
                self.assertEqual(handle.options["LOW_SPEED_TIME"], 8)
                for option, expected in (("SSL_VERIFYPEER", 1), ("SSL_VERIFYHOST", 2),
                                         ("PROXY_SSL_VERIFYPEER", 1), ("PROXY_SSL_VERIFYHOST", 2),
                                         ("FOLLOWLOCATION", 1), ("NETRC", 0), ("HTTP_CONTENT_DECODING", 0)):
                    self.assertEqual(handle.options[option], expected)
                self.assertEqual([name for name, _ in client._backend.native_options],
                                 ["CAINFO_BLOB", "PROXY_CAINFO_BLOB", "XFERINFOFUNCTION"])
                self.assertEqual(response._progress_callback(None, 0, 0, 0, 0), 0)
                response._cancel.set()
                self.assertEqual(response._progress_callback(None, 0, 0, 0, 0), 1)

    def test_actual_http2_and_http1_protocol_mappings_are_preserved(self):
        for version, protocol in ((3, "h2"), (2, "http/1.1"), (1, "http/1.0")):
            with self.subTest(version=version):
                _, _, response = self.response(version=version)
                response._header_status = 200
                response._header_values = {"content-length": "4"}
                response._publish_headers()
                self.assertEqual((response.actual_protocol, response.protocol), (protocol, protocol))
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers["Content-Length"], "4")

    def test_unexpected_http3_result_cannot_be_published(self):
        _, _, response = self.response(version=30)
        response._header_status = 200
        with self.assertRaises(transport.TransportError):
            response._publish_headers()
        self.assertFalse(response._headers_ready.is_set())
        self.assertEqual(response.actual_protocol, "")


class PreferenceMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="myvideoapp-no-http3-prefs-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def test_startup_removes_only_the_legacy_key_and_is_idempotent(self):
        store = Storage(self.directory)
        preferences = {"download_folder": str(self.directory / "chosen"), "folder_confirmed": True,
                       "theme": "dark", "concurrent_downloads": 2, "host_concurrent_downloads": 1,
                       "scan_after_download": True, "quality": "1080", "output": "mkv",
                       "parallel_downloads": False, "speed_limit_enabled": True, "speed_limit_kib": 4096}
        store.save_settings(preferences)
        store.insert({"job_id": "a" * 32, "url": DIRECT, "title": "Earlier download",
                      "folder": str(self.directory), "quality": "highest", "output": "original",
                      "stage": "complete", "request_digest": "b" * 64, "message": "HTTP/3"})
        history = store.history()
        with store.connect() as database:
            database.executemany("INSERT INTO preferences(key,value) VALUES (?,?)",
                                 [("http3_enabled", "true"), ("future_preference", '"retained"')])
            before = dict(database.execute("SELECT key,value FROM preferences"))
        for _ in range(2):
            store = Storage(self.directory)
            self.assertEqual(store.history(), history)
            self.assertEqual(store.settings(), {**preferences, "future_preference": "retained"})
            with store.connect() as database:
                self.assertEqual(dict(database.execute("SELECT key,value FROM preferences")),
                                 {key: value for key, value in before.items() if key != "http3_enabled"})

    def test_legacy_values_are_ignored_on_reads_and_cannot_be_saved(self):
        store = Storage(self.directory)
        for value in (True, False, "true"):
            with self.subTest(value=value):
                store.save_settings({"http3_enabled": value, "parallel_downloads": False})
                self.assertNotIn("http3_enabled", store.settings())
                with store.connect() as database:
                    self.assertIsNone(database.execute("SELECT value FROM preferences WHERE key='http3_enabled'").fetchone())
        with store.connect() as database:
            database.execute("INSERT INTO preferences(key,value) VALUES ('http3_enabled','true')")
        self.assertNotIn("http3_enabled", store.settings())
        self.assertFalse(store.settings()["parallel_downloads"])


class Harness(engine.Engine):
    def _dependencies(self, youtube, cancel):
        return SimpleNamespace(), Path("deno.exe"), Path("ffmpeg.exe"), Path("ffprobe.exe")

    def _extract_isolated(self, *args):
        return {"id": "fixture", "title": "Protocol fixture", "formats": [{
            "format_id": "combined", "url": DIRECT, "protocol": "https", "ext": "mp4",
            "vcodec": "avc1", "acodec": "mp4a", "filesize": len(MEDIA)}]}

    def _run(self, arguments, cancel, **kwargs):
        engine._check_cancel(cancel)
        if arguments[0] == "ffprobe.exe":
            return b'{"streams":[{"codec_type":"video"},{"codec_type":"audio"}]}'
        Path(arguments[-1]).write_bytes(MEDIA)
        return b""


class EngineProtocolTests(unittest.TestCase):
    def run_download(self, protocol, *, parallel):
        temporary = tempfile.TemporaryDirectory(prefix="myvideoapp-no-http3-engine-")
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        data = directory / "data"
        store = Storage(data)
        store.save_settings({"parallel_downloads": parallel, "speed_limit_enabled": False, "speed_limit_kib": 4096})
        with store.connect() as database:
            database.execute("INSERT INTO preferences(key,value) VALUES ('http3_enabled','true')")
        subject = Harness(APP_ROOT, data, resources=ResourceBudget())
        subject.save_settings({"http3_enabled": True})
        events, calls, clients = [], [], []

        class Client:
            closed = False

            def __enter__(self):
                return self

            def __exit__(self, *_):
                self.closed = True

        # An obsolete keyword raises TypeError here instead of being swallowed.
        def native(*, max_connections, bandwidth_limiter):
            client = Client()
            clients.append(client)
            calls.append((max_connections, bandwidth_limiter))
            return client

        def download(url, path, **options):
            self.assertIs(options["transport"], clients[-1])
            self.assertEqual(options["workers"], 4 if parallel else 1)
            options["protocol"](protocol)
            options["mode"]("parallel" if parallel else "single")
            options["connections"](2 if parallel else 1)
            path.write_bytes(MEDIA)
            options["progress"](len(MEDIA), len(MEDIA))
            return SimpleNamespace(size=len(MEDIA), protocols=(protocol,))

        destination = directory / "downloads"
        destination.mkdir()
        with patch.object(engine, "NativeTransport", native), patch.object(engine, "download_file", download):
            result = subject.download(engine.DownloadRequest(DIRECT, destination), events.append, threading.Event())
        self.assertEqual(calls, [(4, subject.bandwidth)])
        self.assertTrue(clients[0].closed)
        self.assertEqual(Path(result.filepath).read_bytes(), MEDIA)
        self.assertFalse(hasattr(subject, "_http3_enabled"))
        self.assertNotIn("http3_enabled", subject.settings())
        self.assertEqual(subject.settings()["parallel_downloads"], parallel)
        self.assertEqual(subject.settings()["speed_limit_kib"], 4096)
        return result, events

    def test_engine_calls_native_transport_without_the_removed_argument(self):
        for protocol, expected in (("h2", "HTTP/2"), ("http/1.1", "HTTP/1.1")):
            with self.subTest(protocol=protocol):
                result, events = self.run_download(protocol, parallel=protocol == "h2")
                self.assertIn(expected, result.message)
                self.assertTrue(any(event.transport == protocol for event in events))
                self.assertNotIn("HTTP/3", result.message)

    def test_engine_ignores_unsupported_http3_progress_and_summary(self):
        result, events = self.run_download("h3", parallel=True)
        self.assertNotIn("HTTP/3", result.message)
        self.assertTrue(all(event.transport is None for event in events))


class TransferProtocolTests(unittest.TestCase):
    def test_transfer_callbacks_report_only_http2_or_http11(self):
        class Response(io.BytesIO):
            status = 200
            headers = {"content-length": str(len(MEDIA))}
            url = DIRECT

        for protocol in ("h2", "http/1.1", "h3"):
            with self.subTest(protocol=protocol), tempfile.TemporaryDirectory(prefix="myvideoapp-no-http3-transfer-") as temporary:
                def open_response(*args, **kwargs):
                    response = Response(MEDIA)
                    response.actual_protocol = protocol
                    return response

                observed = []
                path = Path(temporary) / "media.mp4"
                result = transfer.download_file(DIRECT, path, transport=SimpleNamespace(open=open_response),
                                                resources=ResourceBudget(), cancel=threading.Event(),
                                                workers=1, protocol=observed.append)
                expected = [protocol] if protocol != "h3" else []
                self.assertEqual(observed, expected)
                self.assertEqual(result.protocols, tuple(expected))
                self.assertEqual(path.read_bytes(), MEDIA)


@contextmanager
def http1_origin():
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            self.server.requests.append((self.request_version, self.path, self.headers.get("X-Fixture")))
            self.send_response(200)
            self.send_header("Content-Length", str(len(MEDIA)))
            self.send_header("Content-Type", "video/mp4")
            self.end_headers()
            self.wfile.write(MEDIA)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    server.requests = []
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield server, f"http://127.0.0.1:{server.server_address[1]}/fixture.mp4"
    finally:
        server.shutdown()
        server.server_close()
        worker.join(2)


if _options.real_http1:
    class RealHTTP1Tests(unittest.TestCase):
        def test_packaged_backend_streams_real_http11_exactly(self):
            # The explicit flag requires the real packaged dependencies. A
            # missing backend, mismatch or socket failure fails this test.
            with http1_origin() as (origin, url), \
                 patch.dict(os.environ, {"NO_PROXY": "127.0.0.1", "no_proxy": "127.0.0.1"}), \
                 transport.NativeTransport(max_connections=1, bandwidth_limiter=NoLimit()) as client:
                with client.open(url, {"X-Fixture": "http1"}, threading.Event(), timeout=10) as response:
                    self.assertEqual((response.status, response.actual_protocol), (200, "http/1.1"))
                    self.assertEqual(response.headers["content-length"], str(len(MEDIA)))
                    chunks = []
                    while chunk := response.read(8192):
                        chunks.append(chunk)
                    self.assertEqual(b"".join(chunks), MEDIA)
                self.assertEqual(origin.requests, [("HTTP/1.1", "/fixture.mp4", "http1")])


if __name__ == "__main__":
    program = unittest.main(argv=[sys.argv[0], *_test_arguments], exit=False)
    raise SystemExit(0 if program.result.wasSuccessful() and not program.result.skipped else 1)
