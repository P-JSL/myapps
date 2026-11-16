// Owned loopback HTTP/2 fixture. Never contacts an external host.
import { createSecureServer } from 'node:http2';
import { readFile, appendFile } from 'node:fs/promises';
const [cert, key, clip, log] = process.argv.slice(2);
const bytes = await readFile(clip);
const id = 'a1b2c3d4-1234-5678-abcd-1234567890ab';
const server = createSecureServer({ cert: await readFile(cert), key: await readFile(key), allowHTTP1: true });
const sessions = new Set();
server.on('session', session => { sessions.add(session); session.on('close', () => sessions.delete(session)); });
server.on('request', (req, res) => { void (async () => {
  const url = new URL(req.url, 'https://surrit.com');
  const page = req.headers[':authority'] === 'missav123.com' || req.headers.host === 'missav123.com';
  const allowed = page || (req.headers.origin === 'https://missav123.com' && req.headers.referer === 'https://missav123.com/'
    && req.headers['sec-fetch-mode'] === 'cors' && req.headers['sec-fetch-site'] === 'cross-site');
  await appendFile(log, JSON.stringify({ path: url.pathname, status: allowed ? 200 : 403, http: req.httpVersion, page }) + '\n');
  if (!allowed) { res.writeHead(403).end('Forbidden'); return; }
  if (page) { res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<title>Owned MissAV fixture</title><script>const source="https://surrit.com/${id}/playlist.m3u8";</script>`); return; }
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  if (url.pathname.endsWith('/playlist.m3u8')) res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=1280x720\n720p/video.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=1920x1080\n1080p/video.m3u8\n');
  else if (url.pathname.endsWith('/encrypted.m3u8')) res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:1,\nclip.ts\n#EXT-X-ENDLIST\n');
  else if (url.pathname.endsWith('/live.m3u8')) res.end('#EXTM3U\n#EXTINF:1,\nclip.ts\n');
  else if (url.pathname.endsWith('/redirect.m3u8')) res.writeHead(302, { Location: 'https://evil.invalid/private' }).end();
  else if (url.pathname.endsWith('/error.m3u8')) { res.setHeader('Content-Type', 'text/html'); res.end('<title>Just a moment...</title>'); }
  else if (url.pathname.endsWith('/video.m3u8') || url.pathname.endsWith('/missing.m3u8')) res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\n${url.pathname.endsWith('missing.m3u8') ? 'unavailable' : 'clip'}.ts\n#EXT-X-ENDLIST\n`);
  else if (url.pathname.endsWith('/clip.ts')) { res.setHeader('Content-Type', 'video/mp2t'); res.setHeader('Content-Length', bytes.length); res.end(bytes); }
  else res.writeHead(404).end('Not found');
})().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n'));
process.on('SIGTERM', () => { for (const session of sessions) session.destroy(); server.close(() => process.exit(0)); });
