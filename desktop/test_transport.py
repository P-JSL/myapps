"""New real-socket desktop transport tests (no old suite is invoked).

python -I -B desktop/test_transport.py --app-root EXTRACTED_APP -v
Fixture-only packages can be supplied with repeatable --dependency-root PATH.
The extracted application's own bundled curl_cffi is always used when present.
"""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import select
import socket
import socketserver
import subprocess
import sys
import threading
import time
import unittest
import tempfile

_parser = argparse.ArgumentParser(add_help=False)
_parser.add_argument("--app-root", type=Path, default=Path(__file__).resolve().parents[1])
_parser.add_argument("--report", type=Path, default=Path("reports/desktop-transport.json"))
_parser.add_argument("--dependency-root", action="append", type=Path, default=[])
_options, _test_arguments = _parser.parse_known_args()
APP_ROOT = _options.app_root.resolve(strict=True)
for _root in reversed(_options.dependency_root):
    sys.path.insert(0, str(_root.resolve(strict=True)))
sys.path.insert(0, str(APP_ROOT / "desktop"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
from desktop_transport_server import HTTPOrigin, TLSOrigin, MEDIA
from transport import NativeTransport, TransportError, TransportCancelled
from bandwidth import BandwidthLimiter


def read_all(response, size=65536):
    NativeTransportTests.observed.add(response.protocol)
    chunks = []
    while chunk := response.read(size):
        if len(chunk) > size:
            raise AssertionError("Response.read exceeded its requested bound")
        chunks.append(chunk)
    return b"".join(chunks)


class _ConnectProxy(socketserver.ThreadingTCPServer):
    """Fixture-only proxy: tunnel exactly one loopback TLS origin."""
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, *_):
        pass  # Closing an authenticated tunnel is an expected test boundary.


class _ConnectTunnel(socketserver.StreamRequestHandler):
    def handle(self):
        line = self.rfile.readline(8192).decode("ascii")
        method, address, _ = line.split()
        headers = {}
        while line := self.rfile.readline(8192):
            if line == b"\r\n":
                break
            name, value = line.decode("ascii").split(":", 1)
            headers[name.lower()] = value.strip()
        if method != "CONNECT":
            # Recent curl can probe a proxy's UDP forwarding capability. This
            # plain HTTP fixture supports TCP CONNECT only.
            self.wfile.write(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            return
        if address != self.server.target:
            self.wfile.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            return
        expected = self.server.authorization
        if expected is not None and headers.get("proxy-authorization") != expected:
            self.wfile.write(b'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="loopback"\r\nContent-Length: 0\r\n\r\n')
            return
        self.server.tunnels += 1
        host, port = address.rsplit(":", 1)
        with socket.create_connection((host, int(port)), timeout=10) as target:
            self.wfile.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            self.wfile.flush()
            peers = (self.connection, target)
            while True:
                readable, _, _ = select.select(peers, (), (), 10)
                if not readable:
                    return
                for peer in readable:
                    try:
                        data = peer.recv(65536)
                        if not data:
                            return
                        (target if peer is self.connection else self.connection).sendall(data)
                    except (ConnectionError, OSError):
                        return


class NativeTransportTests(unittest.TestCase):
    observed = set()

    def client(self, **kwargs):
        client = NativeTransport(**kwargs)
        self.addCleanup(client.close)
        return client

    def test_unicode_ca_paths_verify_http2_and_http3(self):
        for enabled, expected in ((False, "h2"), (True, "h3")):
            with self.subTest(protocol=expected), TLSOrigin(http3=enabled, payload=MEDIA[:65536]) as origin:
                with tempfile.TemporaryDirectory(prefix="desktop-ca-") as temporary:
                    directory = Path(temporary) / "영상 인증서 日本語"
                    directory.mkdir()
                    trusted = directory / "신뢰 인증서.pem"
                    trusted.write_bytes(origin.ca_file.read_bytes())
                    client = self.client(http3_enabled=enabled, ca_file=trusted)
                    with client.open(origin.url + "/media", cancel=threading.Event(), timeout=15) as response:
                        self.assertEqual(response.protocol, expected)
                        self.assertEqual(read_all(response), MEDIA[:65536])

    def test_four_streams_share_one_payload_rate(self):
        payload = MEDIA[:256 * 1024]
        limiter = BandwidthLimiter(True, 256)
        with HTTPOrigin(payload=payload) as origin:
            client = self.client(http3_enabled=False, max_connections=4, bandwidth_limiter=limiter)
            def receive(_index):
                with client.open(origin.url + "/media", cancel=threading.Event(), timeout=15) as response:
                    return read_all(response)
            started = time.monotonic()
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(receive, range(4)))
            elapsed = time.monotonic() - started
            self.assertEqual(results, [payload] * 4)
            # One shared 256KiB/s budget with a single initial 64KiB burst:
            # four independent per-file buckets would finish in about 1s.
            self.assertGreaterEqual(elapsed, 3.0)
            self.assertLess(elapsed, 15)

    def test_disabling_limit_releases_a_live_native_stream(self):
        payload = MEDIA[:256 * 1024]
        limiter = BandwidthLimiter(True, 64)
        with HTTPOrigin(payload=payload) as origin:
            client = self.client(http3_enabled=False, bandwidth_limiter=limiter)
            with client.open(origin.url + "/media", cancel=threading.Event(), timeout=10) as response:
                prefix = bytearray()
                while len(prefix) < 64 * 1024:
                    prefix.extend(response.read(64 * 1024 - len(prefix)))
                deadline = time.monotonic() + 3
                waiting = False
                while time.monotonic() < deadline:
                    with limiter._condition:
                        waiting = bool(limiter._waiters)
                    if waiting:
                        break
                    time.sleep(.005)
                self.assertTrue(waiting, "Native body delivery never entered its shared limiter.")
                started = time.monotonic()
                limiter.configure(False, 64)
                self.assertEqual(bytes(prefix) + read_all(response), payload)
                self.assertLess(time.monotonic() - started, 2)

    def test_cancelling_a_native_rate_wait_is_prompt(self):
        limiter = BandwidthLimiter(True, 64)
        limiter.consume(64 * 1024)
        cancel = threading.Event()
        with HTTPOrigin(payload=MEDIA[:256 * 1024]) as origin:
            client = self.client(http3_enabled=False, bandwidth_limiter=limiter)
            with client.open(origin.url + "/media", cancel=cancel, timeout=10) as response:
                deadline = time.monotonic() + 3
                waiting = False
                while time.monotonic() < deadline:
                    with limiter._condition:
                        waiting = bool(limiter._waiters)
                    if waiting:
                        break
                    time.sleep(.005)
                self.assertTrue(waiting)
                started = time.monotonic()
                cancel.set()
                with self.assertRaises(TransportCancelled):
                    response.read(65536)
                self.assertLess(time.monotonic() - started, .5)

    def test_http1_stream_is_exact_and_reports_actual_protocol(self):
        with HTTPOrigin() as origin:
            client = self.client(http3_enabled=True, max_connections=4)
            response = client.open(origin.url + "/media", {"Range": "bytes=0-1048575"}, threading.Event(), timeout=10)
            try:
                self.assertEqual(response.status, 206)
                self.assertEqual(response.protocol, "http/1.1")
                self.assertEqual(response.headers["content-range"], f"bytes 0-1048575/{len(MEDIA)}")
                self.assertEqual(read_all(response, 1337), MEDIA[:1048576])
            finally:
                response.close()

    def test_four_real_streams_can_be_consumed_concurrently(self):
        with HTTPOrigin(body_delay=.15) as origin:
            client = self.client(http3_enabled=False, max_connections=4)
            def request(number):
                start = number * 1048576
                response = client.open(origin.url + "/media", {"Range": f"bytes={start}-{start + 1048575}"}, threading.Event(), timeout=10)
                try:
                    return read_all(response)
                finally:
                    response.close()
            with ThreadPoolExecutor(max_workers=4) as pool:
                data = list(pool.map(request, range(4)))
            self.assertEqual(b"".join(data), MEDIA[:4 * 1048576])
            self.assertEqual(origin.state.range_peak, 4)

    def test_cancel_closes_an_active_native_stream(self):
        with HTTPOrigin(rate=256 * 1024) as origin:
            cancel = threading.Event()
            response = self.client(http3_enabled=False, max_connections=1).open(origin.url + "/media", {}, cancel, timeout=10)
            try:
                self.assertTrue(response.read(4096))
                cancel.set()
                started = time.monotonic()
                with self.assertRaises(TransportCancelled):
                    while response.read(65536):
                        pass
                self.assertLess(time.monotonic() - started, 3)
            finally:
                response.close()

    def test_cancel_during_stalled_headers_is_prompt(self):
        with HTTPOrigin() as origin, ThreadPoolExecutor(max_workers=1) as pool:
            cancel = threading.Event()
            client = self.client(http3_enabled=False, max_connections=1)
            future = pool.submit(client.open, origin.url + "/stall-headers", {}, cancel, 15)
            self.assertTrue(origin.state.wait_for(lambda: origin.state.counts["/stall-headers"] == 1))
            started = time.monotonic()
            cancel.set()
            with self.assertRaises(TransportCancelled):
                future.result(timeout=3)
            self.assertLess(time.monotonic() - started, 3)

    def test_closing_one_response_preserves_another_stream(self):
        with HTTPOrigin(rate=4 * 1024 * 1024) as origin:
            cancel = threading.Event()
            client = self.client(http3_enabled=False, max_connections=2)
            first = client.open(origin.url + "/media", {"Range": "bytes=0-1048575"}, cancel, timeout=10)
            second = client.open(origin.url + "/media", {"Range": "bytes=1048576-2097151"}, cancel, timeout=10)
            try:
                self.assertTrue(first.read(4096))
                first.close()
                self.assertFalse(cancel.is_set())
                self.assertEqual(read_all(second), MEDIA[1048576:2097152])
            finally:
                first.close()
                second.close()

    def test_https_redirect_cannot_downgrade_to_http(self):
        with HTTPOrigin(payload=b"downgrade must not be requested") as plain, TLSOrigin(http3=False, payload=b"") as secure:
            secure.state.redirect_url = plain.url + "/media"
            client = self.client(http3_enabled=False, max_connections=1, ca_file=secure.ca_file)
            with self.assertRaises(TransportError):
                response = client.open(secure.url + "/redirect", {}, threading.Event(), timeout=10)
                try:
                    read_all(response)
                finally:
                    response.close()
            self.assertEqual(plain.state.requests, [])

    def test_http2_uses_verified_trusted_ca(self):
        with TLSOrigin(http3=False, payload=MEDIA[:1048576]) as origin:
            client = self.client(http3_enabled=False, max_connections=4, ca_file=origin.ca_file)
            response = client.open(origin.url + "/media", {}, threading.Event(), timeout=10)
            try:
                self.assertEqual(response.protocol, "h2")
                self.assertEqual(hashlib.sha256(read_all(response)).digest(), hashlib.sha256(MEDIA[:1048576]).digest())
            finally:
                response.close()
            self.assertEqual(origin.state.protocols["h2"], 1)

    def test_http3_uses_verified_trusted_ca_and_real_quic(self):
        with TLSOrigin(http3=True, payload=MEDIA[:1048576]) as origin:
            client = self.client(http3_enabled=True, max_connections=4, ca_file=origin.ca_file)
            response = client.open(origin.url + "/media", {}, threading.Event(), timeout=15)
            try:
                self.assertEqual(response.protocol, "h3")
                self.assertEqual(hashlib.sha256(read_all(response)).digest(), hashlib.sha256(MEDIA[:1048576]).digest())
            finally:
                response.close()
            self.assertGreater(origin.state.protocols["h3"], 0)

    def test_http3_unavailable_falls_back_to_real_http2(self):
        with TLSOrigin(http3=False, payload=MEDIA[:65536]) as origin:
            client = self.client(http3_enabled=True, max_connections=4, ca_file=origin.ca_file)
            response = client.open(origin.url + "/media", {}, threading.Event(), timeout=10)
            try:
                self.assertEqual(response.protocol, "h2")
                self.assertEqual(read_all(response), MEDIA[:65536])
            finally:
                response.close()

    def test_http3_honors_inherited_connect_proxy_with_auth_and_no_quic_bypass(self):
        child = r'''
import sys
sys.path[:0] = sys.argv[3:]
from transport import NativeTransport
with NativeTransport(http3_enabled=True, ca_file=sys.argv[1]) as transport:
    with transport.open(sys.argv[2] + "/media", timeout=10) as response:
        assert response.actual_protocol == "h2", response.actual_protocol
        chunks = []
        while chunk := response.read(65536):
            chunks.append(chunk)
        assert b"".join(chunks) == b"proxy-fixture-body" * 1000
        print(response.actual_protocol)
'''
        # The origin supports real QUIC: a proxy bypass would report h3 and
        # increment its h3 request count. Only the child gets proxy overrides.
        with TLSOrigin(http3=True, payload=b"proxy-fixture-body" * 1000) as origin:
            for use_auth in (False, True):
                with self.subTest(synthetic_proxy_auth=use_auth), _ConnectProxy(("127.0.0.1", 0), _ConnectTunnel) as proxy:
                    proxy.target = f"127.0.0.1:{origin.port}"
                    proxy.authorization = ("Basic " + base64.b64encode(b"fixture:synthetic").decode()) if use_auth else None
                    proxy.tunnels = 0
                    thread = threading.Thread(target=proxy.serve_forever, daemon=True)
                    thread.start()
                    local_proxy = f'http://{"fixture:synthetic@" if use_auth else ""}127.0.0.1:{proxy.server_address[1]}'
                    environment = os.environ.copy()
                    environment.update(HTTPS_PROXY=local_proxy, https_proxy=local_proxy, NO_PROXY="", no_proxy="")
                    roots = [str(APP_ROOT / "desktop"), *(str(root.resolve()) for root in _options.dependency_root)]
                    try:
                        completed = subprocess.run([sys.executable, "-I", "-B", "-c", child, str(origin.ca_file), origin.url, *roots],
                                                   env=environment, text=True, capture_output=True, timeout=20)
                        self.assertEqual(completed.returncode, 0, completed.stderr)
                        self.assertEqual(completed.stdout.strip(), "h2")
                        self.observed.add("h2")
                        self.assertGreater(proxy.tunnels, 0)
                        self.assertEqual(origin.state.protocols["h3"], 0)
                        self.assertTrue(all("proxy-authorization" not in request["headers"] for request in origin.state.requests))
                    finally:
                        proxy.shutdown()
                        thread.join(5)

    def test_unknown_ca_is_rejected_for_http2_and_http3(self):
        for enabled in (False, True):
            with self.subTest(http3=enabled), TLSOrigin(http3=enabled, payload=b"must not be trusted") as origin:
                client = self.client(http3_enabled=enabled, max_connections=1)
                with self.assertRaises(TransportError):
                    response = client.open(origin.url + "/media", {}, threading.Event(), timeout=10)
                    try:
                        read_all(response)
                    finally:
                        response.close()


if __name__ == "__main__":
    _options.report.unlink(missing_ok=True)
    _program = unittest.main(argv=[sys.argv[0], *_test_arguments], exit=False)
    _success = _program.result.wasSuccessful() and not _program.result.skipped
    if _success:
        _report = {"protocols": sorted(NativeTransportTests.observed), "tests": _program.result.testsRun,
                   "status": "passed", "scope": "Loopback TLS verified against a fixture CA; HTTP/1.1, HTTP/2 and QUIC HTTP/3 origins.",
                   "liveYouTubeVerified": False}
        _options.report.parent.mkdir(parents=True, exist_ok=True)
        _options.report.write_text(json.dumps(_report, indent=2) + "\n", encoding="utf-8")
    raise SystemExit(0 if _success else 1)
