"""Loopback-only fixtures for the new Python desktop transfer/transport tests.

No external sites or process-wide proxy/TLS settings are used. The HTTP/1 server
uses real sockets and deliberately faulty origin responses. TLS fixtures use a
new private CA for each run; tests must explicitly trust its certificate.
"""
from __future__ import annotations

import asyncio
from collections import Counter
from contextlib import suppress
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
from pathlib import Path
import re
import ssl
import tempfile
import threading
import time
from urllib.parse import urlsplit


# Deterministic, non-compressible-ish media-shaped bytes; no downloaded media.
_BLOCK = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + bytes((n * 73 + (n >> 3)) & 255 for n in range(65536))
MEDIA = (_BLOCK * ((16 * 1024 * 1024 + 123) // len(_BLOCK) + 1))[:16 * 1024 * 1024 + 123]
ETAG = '"desktop-fixture-v1"'


class OriginState:
    def __init__(self, payload=MEDIA, rate=None, body_delay=0.0, body_barrier=None):
        self.payload, self.rate, self.body_delay = payload, rate, body_delay
        self.body_barrier = threading.Barrier(body_barrier) if body_barrier else None
        self.condition = threading.Condition()
        self.requests = []
        self.counts = Counter()
        self.active = self.peak = 0
        self.range_active = self.range_peak = 0
        self.protocols = Counter()
        self.stopped = threading.Event()
        self.redirect_url = None

    def record(self, path, headers, protocol):
        with self.condition:
            path = urlsplit(path).path
            self.counts[path] += 1
            request = {"path": path, "headers": dict(headers), "protocol": protocol,
                       "at": time.monotonic(), "number": self.counts[path]}
            self.requests.append(request)
            self.protocols[protocol] += 1
            self.condition.notify_all()
            return request

    def start(self, is_range=False):
        with self.condition:
            self.active += 1
            self.peak = max(self.peak, self.active)
            if is_range:
                self.range_active += 1
                self.range_peak = max(self.range_peak, self.range_active)
            self.condition.notify_all()

    def finish(self, is_range=False):
        with self.condition:
            self.active -= 1
            if is_range:
                self.range_active -= 1
            self.condition.notify_all()

    def wait_for(self, predicate, timeout=10):
        with self.condition:
            return self.condition.wait_for(predicate, timeout)

    def response(self, path, headers, protocol):
        request = self.record(path, headers, protocol)
        path = request["path"]
        body = self.payload
        if path == "/redirect" and self.redirect_url:
            return 302, {"location": self.redirect_url, "content-length": "0"}, b"", False
        result = {"content-type": "video/mp4", "accept-ranges": "bytes", "etag": ETAG}
        if path in ("/transient503", "/transient429") and request["number"] <= 2:
            return (503 if path.endswith("503") else 429), {"retry-after": "0", "content-length": "0"}, b"", False
        if path == "/wait429":
            return 429, {"retry-after": "3", "content-length": "0"}, b"", False
        ranged = False
        status = 200
        match = re.fullmatch(r"bytes=(\d+)-(\d+)", headers.get("range", ""))
        if match and path != "/ignore":
            start, end = map(int, match.groups())
            if not 0 <= start <= end < len(body):
                return 416, {"content-range": f"bytes */{len(body)}", "content-length": "0"}, b"", False
            ranged, status = True, 206
            worker = end - start + 1 > 65536
            if worker and path == "/changed":
                return 412, {"content-length": "0", "etag": '"desktop-fixture-v2"'}, b"", False
            result["content-range"] = f"bytes {start}-{end}/{len(body)}"
            body = body[start:end + 1]
            if worker and path == "/bad-range":
                result["content-range"] = f"bytes {start + 1}-{end}/{len(self.payload)}"
            if worker and path == "/changed-etag":
                result["etag"] = '"desktop-fixture-v2"'
            if worker and path == "/missing-etag":
                result.pop("etag")
            if worker and path == "/gzip":
                result["content-encoding"] = "gzip"
        if path == "/weak-etag":
            result["etag"] = "W/" + ETAG
        if path == "/no-etag":
            result.pop("etag", None)
        result["content-length"] = str(len(body))
        if ranged and len(body) > 65536 and path == "/truncated":
            body = body[:len(body) // 2]
        return status, result, body, ranged


class _HTTPServer(ThreadingHTTPServer):
    request_queue_size = 64
    daemon_threads = True
    block_on_close = False

    def handle_error(self, *_):
        # Early closes are an expected cancellation/fault-test boundary.
        pass


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def do_GET(self):
        state = self.server.state
        status, headers, body, ranged = state.response(self.path, {k.lower(): v for k, v in self.headers.items()}, "http/1.1")
        if urlsplit(self.path).path == "/stall-headers":
            state.stopped.wait(10)
            return
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        state.start(ranged and len(body) > 65536)
        try:
            if state.body_barrier and ranged and len(body) > 65536:
                state.body_barrier.wait(timeout=10)
            if state.body_delay and len(body) > 65536:
                time.sleep(state.body_delay)
            started = time.monotonic()
            for offset in range(0, len(body), 65536):
                chunk = body[offset:offset + 65536]
                self.wfile.write(chunk)
                self.wfile.flush()
                if state.rate:
                    delay = (offset + len(chunk)) / state.rate - (time.monotonic() - started)
                    if delay > 0:
                        time.sleep(delay)
        except (BrokenPipeError, ConnectionResetError, OSError, threading.BrokenBarrierError):
            pass
        finally:
            state.finish(ranged and len(body) > 65536)


class HTTPOrigin:
    def __init__(self, **kwargs):
        self.state = OriginState(**kwargs)

    def __enter__(self):
        self.server = _HTTPServer(("127.0.0.1", 0), _Handler)
        self.server.state = self.state
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.state.stopped.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)


def _certificate(directory):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID
    now = datetime.now(timezone.utc)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Desktop loopback test CA")])
    ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name).public_key(key.public_key())
          .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=1))
          .not_valid_after(now + timedelta(days=2)).add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
          .sign(key, hashes.SHA256()))
    server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    server_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    server = (x509.CertificateBuilder().subject_name(server_name).issuer_name(ca_name).public_key(server_key.public_key())
              .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=1))
              .not_valid_after(now + timedelta(days=1)).add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
              .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
              .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
              .sign(key, hashes.SHA256()))
    for name, value in (("ca.pem", ca.public_bytes(serialization.Encoding.PEM)),
                        ("server.pem", server.public_bytes(serialization.Encoding.PEM)),
                        ("server.key", server_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))):
        (directory / name).write_bytes(value)


class TLSOrigin:
    """Real TLS HTTP/2 and optionally QUIC HTTP/3 on the same loopback port."""
    def __init__(self, *, http3=True, payload=MEDIA):
        self.http3 = http3
        self.state = OriginState(payload=payload)
        self.ready = threading.Event()
        self.errors = []

    def __enter__(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="desktop-transport-tls-")
        self.directory = Path(self.temporary.name)
        _certificate(self.directory)
        self.ca_file = self.directory / "ca.pem"
        self.thread = threading.Thread(target=self._thread, daemon=True)
        self.thread.start()
        if not self.ready.wait(15):
            self.temporary.cleanup()
            raise RuntimeError("TLS fixture did not become ready")
        if self.errors:
            self.temporary.cleanup()
            raise RuntimeError("TLS fixture failed") from self.errors[0]
        self.url = f"https://127.0.0.1:{self.port}"
        return self

    def _thread(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_until_complete(self._run())
        except BaseException as error:
            self.errors.append(error)
            self.ready.set()
        finally:
            pending = asyncio.all_tasks(self.loop)
            for task in pending:
                task.cancel()
            if pending:
                self.loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            self.loop.close()

    async def _run(self):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.directory / "server.pem", self.directory / "server.key")
        context.set_alpn_protocols(["h2", "http/1.1"])
        self.tcp = await asyncio.start_server(self._tcp, "127.0.0.1", 0, ssl=context)
        self.port = self.tcp.sockets[0].getsockname()[1]
        self.stop = asyncio.Event()
        quic = None
        if self.http3:
            from aioquic.asyncio import QuicConnectionProtocol, serve
            from aioquic.h3.connection import H3_ALPN, H3Connection
            from aioquic.h3.events import HeadersReceived
            from aioquic.quic.configuration import QuicConfiguration
            owner = self

            class HTTP3(QuicConnectionProtocol):
                def __init__(self, *args, **kwargs):
                    super().__init__(*args, **kwargs)
                    self.http = H3Connection(self._quic)

                def quic_event_received(self, event):
                    for item in self.http.handle_event(event):
                        if isinstance(item, HeadersReceived):
                            headers = {k.decode(): v.decode() for k, v in item.headers}
                            status, output, body, _ = owner.state.response(headers[":path"], headers, "h3")
                            self.http.send_headers(item.stream_id, [(b":status", str(status).encode())] + [(k.encode(), v.encode()) for k, v in output.items()])
                            self.http.send_data(item.stream_id, body, end_stream=True)
                            self.transmit()

            configuration = QuicConfiguration(is_client=False, alpn_protocols=H3_ALPN)
            configuration.load_cert_chain(self.directory / "server.pem", self.directory / "server.key")
            quic = await serve("127.0.0.1", self.port, configuration=configuration, create_protocol=HTTP3)
        self.ready.set()
        await self.stop.wait()
        if quic:
            quic.close()
        self.tcp.close()
        await self.tcp.wait_closed()
        # Let accepted TLS sessions and QUIC handles observe closure.
        await asyncio.sleep(.05)

    async def _tcp(self, reader, writer):
        try:
            if writer.get_extra_info("ssl_object").selected_alpn_protocol() == "h2":
                await self._h2(reader, writer)
            else:
                raw = await reader.readuntil(b"\r\n\r\n")
                lines = raw.decode().split("\r\n")
                headers = dict(line.lower().split(": ", 1) for line in lines[1:] if ": " in line)
                status, output, body, _ = self.state.response(lines[0].split()[1], headers, "http/1.1")
                writer.write(f"HTTP/1.1 {status} OK\r\n".encode() + b"\r\n".join(f"{k}: {v}".encode() for k, v in output.items()) + b"\r\nConnection: close\r\n\r\n" + body)
                await writer.drain()
        except (ConnectionError, asyncio.IncompleteReadError, ssl.SSLError):
            pass
        finally:
            writer.close()
            with suppress(ConnectionError, ssl.SSLError):
                await writer.wait_closed()

    async def _h2(self, reader, writer):
        from h2.config import H2Configuration
        from h2.connection import H2Connection
        from h2.events import RequestReceived, StreamReset
        connection = H2Connection(H2Configuration(client_side=False, header_encoding="utf-8"))
        connection.initiate_connection()
        writer.write(connection.data_to_send())
        pending = {}
        while data := await reader.read(65536):
            for event in connection.receive_data(data):
                if isinstance(event, RequestReceived):
                    headers = dict(event.headers)
                    status, output, body, _ = self.state.response(headers[":path"], headers, "h2")
                    connection.send_headers(event.stream_id, [(":status", str(status))] + list(output.items()), end_stream=not body)
                    if body:
                        pending[event.stream_id] = (body, 0)
                elif isinstance(event, StreamReset):
                    pending.pop(event.stream_id, None)
            for stream, (body, offset) in list(pending.items()):
                while offset < len(body):
                    size = min(connection.local_flow_control_window(stream), connection.max_outbound_frame_size, len(body) - offset)
                    if size <= 0:
                        break
                    connection.send_data(stream, body[offset:offset + size], end_stream=offset + size == len(body))
                    offset += size
                if offset == len(body):
                    pending.pop(stream)
                else:
                    pending[stream] = (body, offset)
            writer.write(connection.data_to_send())
            await writer.drain()

    def __exit__(self, *_):
        if self.thread.is_alive() and hasattr(self, "stop"):
            self.loop.call_soon_threadsafe(self.stop.set)
            self.thread.join(10)
        self.temporary.cleanup()
