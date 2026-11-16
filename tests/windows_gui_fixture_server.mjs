// A private, TLS-verified fixture tunnel for the actual Windows child process.
// CONNECT never forwards to the Internet and accepts only these fixture hosts.
import { createSecureServer } from 'node:http2';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { readFile, appendFile } from 'node:fs/promises';

const [certificate, key, mp4, ts, log, control] = process.argv.slice(2);
const video = await readFile(mp4), fragment = await readFile(ts);
const id = 'a1b2c3d4-1234-5678-abcd-1234567890ab';
const sockets = new Set();
async function serve(req, res, encrypted) {
  const url = new URL(req.url, 'https://surrit.com');
  const authority = req.headers[':authority'] || req.headers.host || '';
  const page = authority === 'missav123.com';
  const state = JSON.parse(await readFile(control, 'utf8'));
  const allowed = !encrypted || page || (req.headers.origin === 'https://missav123.com'
    && req.headers.referer === 'https://missav123.com/' && req.headers['sec-fetch-site'] === 'cross-site');
  const denied = !allowed || (url.pathname.includes('/retry/') && state.deny);
  await appendFile(log, JSON.stringify({ pathname: url.pathname, status: denied ? 403 : 200, http: req.httpVersion, encrypted }) + '\n');
  if (denied) { res.writeHead(403).end('Forbidden'); return; }
  if (page) {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<title>Windows 한글 다운로드 검사</title><script>const source="https://surrit.com/${id}/playlist.m3u8";</script>`); return;
  }
  if (url.pathname.endsWith('.mp4')) {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': video.length }); res.end(video); return;
  }
  if (url.pathname.endsWith('.ts')) {
    if (url.pathname.includes('/slow/') && state.slow) await new Promise(resolve => setTimeout(resolve, 2000));
    if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': fragment.length }); res.end(fragment); }
    return;
  }
  if (url.pathname.endsWith('playlist.m3u8')) {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=160x90\n1080p/video.m3u8\n'); return;
  }
  if (url.pathname.endsWith('.m3u8')) {
    const count = url.pathname.includes('/slow/') ? 10 : 1;
    const parts = Array.from({ length: count }, (_, index) => `#EXTINF:1,\nclip-${index}.ts\n`).join('');
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n' + parts + '#EXT-X-ENDLIST\n'); return;
  }
  res.writeHead(404).end();
}
const tls = createSecureServer({ cert: await readFile(certificate), key: await readFile(key), allowHTTP1: true });
const proxy = createServer((req, res) => {
  if (!req.url.startsWith('/')) { res.writeHead(502).end(); return; }
  void serve(req, res, false).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
});
tls.on('request', (req, res) => { void serve(req, res, true).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
for (const server of [tls, proxy]) server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
proxy.on('connect', (req, client, head) => {
  if (!['surrit.com:443', 'missav123.com:443'].includes(req.url)) { client.end('HTTP/1.1 502 Fixture hosts only\r\n\r\n'); return; }
  const upstream = connect(tls.address().port, '127.0.0.1', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    client.pipe(upstream); upstream.pipe(client);
  });
  sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
  upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
});
await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
process.stdout.write(JSON.stringify({ proxy: proxy.address().port }) + '\n');
process.on('SIGTERM', () => { for (const socket of sockets) socket.destroy(); tls.close(); proxy.close(() => process.exit(0)); });
