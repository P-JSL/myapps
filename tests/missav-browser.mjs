// Focused browser check: real page origins, Workers, WASM and OPFS; Chrome
// runtime ports are test doubles because managed Chrome blocks extension installs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.cache/missav-browser');
await mkdir(output, { recursive: true });
const command = (executable, args) => {
  const value = spawnSync(executable, args, { encoding: 'utf8' });
  assert.equal(value.status, 0, value.stderr); return value.stdout;
};
const source = path.join(root, 'tests/fixtures/desktop-source.mp4');
const ts = path.join(output, 'clip.ts');
command('ffmpeg', ['-v', 'error', '-i', source, '-c', 'copy', '-f', 'mpegts', '-y', ts]);
const clip = await readFile(ts);
const rpc = (await build({ entryPoints: [path.join(root, 'src/local/page-fetch.ts')], bundle: true, format: 'esm', platform: 'browser', write: false })).outputFiles[0].text;
const info = JSON.parse(await readFile(path.join(root, 'reports/build.json')));
let originalOrigin, appOrigin, mediaOrigin;
const requests = [];
const media = createServer((req, res) => {
  const allowed = req.headers.origin === originalOrigin && req.headers.referer === originalOrigin + '/';
  const status = allowed ? 200 : 403;
  requests.push({ path: req.url, origin: req.headers.origin, referer: req.headers.referer, site: req.headers['sec-fetch-site'], status });
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Type');
  if (!allowed) { res.writeHead(403).end('Forbidden'); return; }
  if (req.url === '/blocked.m3u8') { res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Just a moment...</title>'); return; }
  if (req.url === '/video.m3u8') res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\nclip.ts\n#EXT-X-ENDLIST\n');
  else if (req.url === '/clip.ts') res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': clip.length }).end(clip);
  else res.writeHead(404).end();
});
const original = createServer((req, res) => {
  if (req.url === '/rpc.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(rpc); return; }
  res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<script type="module">
    import {chromeWire, serveFetch} from '/rpc.js';
    const adapt = port => ({postMessage: value => port.postMessage(JSON.parse(JSON.stringify(value))),
      onMessage:{addListener: listener => {port.onmessage=event=>listener(event.data);port.start();}},
      onDisconnect:{addListener:()=>{}},disconnect:()=>port.close()});
    addEventListener('message', event => {
      if(event.origin !== ${JSON.stringify(appOrigin)} || !event.ports[0])return;
      serveFetch(chromeWire(adapt(event.ports[0])),fetch,url=>url.startsWith(${JSON.stringify(mediaOrigin + '/')}));
    });
    parent.postMessage({ready:true},${JSON.stringify(appOrigin)});
  </script>`);
});
const application = createServer(async (req, res) => {
  try {
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>MissAV page context verification</title>'); return; }
    const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '');
    assert(!name.split('/').includes('..'));
    const bytes = await readFile(path.join(root, 'dist', name));
    const mime = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.bin': 'application/octet-stream' }[path.extname(name)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime }).end(bytes);
  } catch { res.writeHead(404).end(); }
});
const listen = (server, host) => new Promise(resolve => server.listen(0, host, () => resolve(`http://${host}:${server.address().port}`)));
mediaOrigin = await listen(media, '127.0.0.1');
appOrigin = await listen(application, '127.0.0.1');
originalOrigin = await listen(original, '127.0.0.2');
const profile = await mkdtemp(path.join(output, 'profile-'));
let context;
const checks = [], errors = [];
try {
  let executablePath = process.env.CHROME_PATH;
  if (!executablePath) for (const candidate of ['/usr/bin/chromium', '/usr/bin/google-chrome']) {
    try { await access(candidate); executablePath = candidate; break; } catch {}
  }
  context = await chromium.launchPersistentContext(profile, { ...(executablePath ? { executablePath } : {}), headless: true, args: ['--no-sandbox'] });
  await context.route('**/*', route => [appOrigin, originalOrigin, mediaOrigin].some(origin => route.request().url().startsWith(origin + '/')) || route.request().url().startsWith('blob:') ? route.continue() : route.abort());
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(appOrigin);
  const plain = await page.evaluate(async url => (await fetch(url)).status, mediaOrigin + '/video.m3u8');
  assert.equal(plain, 403); checks.push('ordinary app-origin request reproduces HTTP 403');
  await page.evaluate(async ({ originalOrigin, assetMap }) => {
    const ready = new Promise(resolve => addEventListener('message', event => { if (event.origin === originalOrigin && event.data.ready) resolve(); }));
    const frame = document.createElement('iframe'); frame.src = originalOrigin; document.body.append(frame);
    await ready;
    window.__progress = [];
    window.chrome = { runtime: { id: 'focused-port-test', getURL: value => new URL(value, location.origin + '/').href,
      onMessage: { addListener: listener => { window.__prepare = listener; } },
      sendMessage: async value => { window.__progress.push(value); },
      connect: () => {
        const channel = new MessageChannel();
        frame.contentWindow.postMessage({ request: true }, originalOrigin, [channel.port2]);
        const disconnected = [];
        return { postMessage: value => channel.port1.postMessage(JSON.parse(JSON.stringify(value))),
          onMessage: { addListener: listener => { channel.port1.onmessage = event => listener(event.data); channel.port1.start(); } },
          onDisconnect: { addListener: listener => disconnected.push(listener) }, disconnect: () => channel.port1.close() };
      } } };
    await import(new URL(assetMap['local/offscreen.js'], location.origin + '/'));
    window.__run = (url, output) => new Promise(resolve => window.__prepare({ scope: 'my-video-app/offscreen', type: 'prepare', id: crypto.randomUUID(), url, kind: 'hls', options: { quality: 'highest', output }, pageContext: true },
      { id: chrome.runtime.id, url: location.origin + '/background.js' }, resolve));
  }, { originalOrigin, assetMap: info.assetMap });
  for (const format of ['original', 'mp3']) {
    const result = await page.evaluate(async ({ url, format }) => {
      const prepared = await window.__run(url, format);
      if (!prepared.ok) throw new Error(prepared.error);
      return { size: prepared.internalScanSize, bytes: Array.from(new Uint8Array(await (await fetch(prepared.url)).arrayBuffer())) };
    }, { url: mediaOrigin + '/video.m3u8', format });
    const destination = path.join(output, `relay-output.${format === 'original' ? 'mp4' : 'mp3'}`);
    await writeFile(destination, Buffer.from(result.bytes));
    const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', destination]));
    assert(probe.streams.some(stream => stream.codec_type === 'audio'));
    if (format === 'original') {
      assert(probe.streams.some(stream => stream.codec_type === 'video'));
      const digest = filename => command('ffmpeg', ['-v', 'error', '-i', filename, '-map', '0:v:0', '-f', 'hash', '-hash', 'sha256', '-']);
      assert.equal(digest(destination), digest(source));
    }
    checks.push(`page-context HLS and all segments produce valid ${format === 'original' ? 'MP4 with identical decoded frames' : 'MP3'}`);
  }
  const blocked = await page.evaluate(url => window.__run(url, 'original'), mediaOrigin + '/blocked.m3u8');
  assert.equal(blocked.ok, false); assert.equal(blocked.url, undefined); checks.push('HTML challenge is rejected without an output file');
  assert(requests.filter(item => item.status === 200).every(item => item.origin === originalOrigin && item.site === 'cross-site'));
  assert(requests.some(item => item.path === '/clip.ts' && item.status === 200));
  assert.deepEqual(errors, []);
  console.log(`${checks.length} focused browser checks passed.`);
} finally {
  await writeFile(path.join(output, 'BROWSER-VALIDATION.json'), JSON.stringify({ version: JSON.parse(await readFile(path.join(root, 'package.json'))).version, buildSha256: info.buildSha256, mode: 'real cross-origin page fetch; production offscreen, workers, WASM and OPFS; Chrome ports are test doubles', extensionInstallationVerified: false, targetFullVideoVerified: false, checks, errors, requests }, null, 2));
  await context?.close();
  await Promise.all([original, media, application].map(server => new Promise(resolve => server.close(resolve))));
  await rm(profile, { recursive: true, force: true });
}
