"""Loopback-only HTTP/1.1 + HTTP/3 fixture server for tests/http3.mjs."""
import asyncio
import contextlib
import json
import re
import signal
import ssl
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

from aioquic.asyncio import QuicConnectionProtocol, serve
from aioquic.h3.connection import H3_ALPN, H3Connection
from aioquic.h3.events import HeadersReceived
from aioquic.quic.configuration import QuicConfiguration

temporary = Path(sys.argv[1])
project = Path(sys.argv[2])
counts = {"h1": 0, "h3": 0}
port = 0
types = {".js": "text/javascript", ".html": "text/html", ".wasm": "application/wasm", ".mp4": "video/mp4", ".ts": "video/mp2t", ".m3u8": "application/vnd.apple.mpegurl"}


def response(path, headers, protocol):
    counts[protocol] += 1
    (temporary / "stats.json").write_text(json.dumps(counts))
    name = unquote(urlsplit(path).path)
    status = 200
    if name == "/":
        body, mime = b"<!doctype html><html><title>My Video App HTTP/3 test</title></html>", "text/html"
    elif name == "/network.js":
        body, mime = (temporary / "network.js").read_bytes(), "text/javascript"
    else:
        base = project / ("test-results" if name.startswith("/fixtures/") else "dist")
        target = (base / name.lstrip("/")).resolve()
        if not target.is_relative_to(base.resolve()) or not target.is_file():
            body, mime, status = b"Not found", "text/plain", 404
        else:
            body, mime = target.read_bytes(), types.get(target.suffix, "application/octet-stream")
    result = [(b"content-type", mime.encode()), (b"cache-control", b"no-store"), (b"alt-svc", f'h3=":{port}"; ma=3600'.encode())]
    if b"range" in headers and status == 200:
        match = re.fullmatch(rb"bytes=(\d+)-(\d+)", headers[b"range"])
        if not match or not (0 <= int(match[1]) <= int(match[2]) < len(body)):
            body, status = b"Invalid range", 416
        else:
            start, end = int(match[1]), int(match[2])
            result.append((b"content-range", f"bytes {start}-{end}/{len(body)}".encode()))
            body, status = body[start:end + 1], 206
    result.append((b"content-length", str(len(body)).encode()))
    return status, result, body


class HTTP3Server(QuicConnectionProtocol):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.http = H3Connection(self._quic)

    def quic_event_received(self, event):
        for item in self.http.handle_event(event):
            if isinstance(item, HeadersReceived):
                headers = dict(item.headers)
                status, output_headers, body = response(headers[b":path"].decode(), headers, "h3")
                self.http.send_headers(item.stream_id, [(b":status", str(status).encode())] + output_headers)
                self.http.send_data(item.stream_id, body, end_stream=True)
                self.transmit()


async def tcp(reader, writer):
    try:
        raw = await reader.readuntil(b"\r\n\r\n")
        lines = raw.decode().split("\r\n")
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                key, value = line.split(":", 1)
                headers[key.lower().encode()] = value.strip().encode()
        status, output_headers, body = response(lines[0].split(" ")[1], headers, "h1")
        writer.write(f"HTTP/1.1 {status} OK\r\n".encode() + b"\r\n".join(k + b": " + v for k, v in output_headers) + b"\r\nConnection: close\r\n\r\n" + body)
        await writer.drain()
    except (ConnectionError, asyncio.IncompleteReadError):
        pass
    finally:
        writer.close()
        with contextlib.suppress(ConnectionError):
            await writer.wait_closed()


async def main():
    global port
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(temporary / "server.pem", temporary / "server.key")
    context.set_alpn_protocols(["http/1.1"])
    tcp_server = await asyncio.start_server(tcp, "127.0.0.1", 0, ssl=context)
    port = tcp_server.sockets[0].getsockname()[1]
    config = QuicConfiguration(is_client=False, alpn_protocols=H3_ALPN)
    config.load_cert_chain(temporary / "server.pem", temporary / "server.key")
    quic = await serve("127.0.0.1", port, configuration=config, create_protocol=HTTP3Server)
    (temporary / "ready.json").write_text(json.dumps({"port": port}))
    stopped = asyncio.Event()
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, stopped.set)
    await stopped.wait()
    quic.close()
    tcp_server.close()
    await tcp_server.wait_closed()


asyncio.run(main())
