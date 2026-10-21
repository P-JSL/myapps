/** Real Chromium/FFmpeg/OPFS integration harness. Chrome extension APIs are TEST DOUBLES.
 * This is deliberately not described as a successfully installed extension test.
 */
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat, mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { prepareDashAuditFixtures, verifyDashPlanner } from './dash-audit.mjs';
import { prepareOwnedInputAudit, verifyOwnedInputProcessing } from './worker-input-audit.mjs';
import { prepareDatabaseAudit, verifyDatabaseAudit } from './database-audit.mjs';
import { verifyPopupAudit } from './popup-audit.mjs';
import { loadBuildPaths, assertProtectedBuild } from './build-paths.mjs';

const root = path.resolve('.');
const buildPaths = await loadBuildPaths(root);
const { buildInfo, assetMap } = buildPaths;
const results = path.join(root, 'test-results');
await mkdir(results, { recursive: true });
const fixtures = path.join(results, 'fixtures');
await mkdir(fixtures, { recursive: true });
function command(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${binary} failed: ${result.stderr?.slice(-2000)}`);
  return result.stdout;
}
command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', `${fixtures}/clip.mp4`]);
command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `${fixtures}/clip.mp4`, '-c:v', 'libvpx', '-c:a', 'libopus', '-y', `${fixtures}/clip.webm`]);
command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x48', '-frames:v', '1', '-threads', '1', '-y', `${fixtures}/image.png`]);
command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=8192x2', '-frames:v', '1', '-threads', '1', '-y', `${fixtures}/wide.png`]);
for (const directory of ['hls', 'dash', 'range', 'video', 'audio', 'low', 'high', 'quality-dash', 'parallel', 'retry', 'redirect']) await mkdir(`${fixtures}/${directory}`, { recursive: true });
command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `${fixtures}/clip.mp4`, '-c:v', 'libx264', '-g', '6', '-keyint_min', '6', '-c:a', 'aac', '-hls_time', '0.5', '-hls_playlist_type', 'vod', '-hls_segment_filename', `${fixtures}/hls/seg-%03d.ts`, '-y', `${fixtures}/hls/list.m3u8`]);
command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `${fixtures}/clip.mp4`, '-map', '0', '-c', 'copy', '-seg_duration', '0.5', '-use_template', '1', '-use_timeline', '1', '-f', 'dash', '-y', `${fixtures}/dash/list.mpd`]);
command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `${fixtures}/clip.mp4`, '-c', 'copy', '-hls_time', '0.5', '-hls_playlist_type', 'vod', '-hls_flags', 'single_file', '-y', `${fixtures}/range/list.m3u8`]);
command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `${fixtures}/clip.mp4`, '-map', '0:v:0', '-c', 'copy', '-hls_time', '0.5', '-hls_playlist_type', 'vod', '-y', `${fixtures}/video/list.m3u8`]);
command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `${fixtures}/clip.mp4`, '-map', '0:a:0', '-c', 'copy', '-hls_time', '0.5', '-hls_playlist_type', 'vod', '-y', `${fixtures}/audio/list.m3u8`]);
command('python3', ['-c', `import pathlib,xml.etree.ElementTree as E
p=pathlib.Path(${JSON.stringify(fixtures)})/'dash';ns='{urn:mpeg:dash:schema:mpd:2011}'
for replace in [False,True]:
 root=E.parse(p/'list.mpd').getroot()
 for adaptation in root.iter(ns+'AdaptationSet'):
  rep=adaptation.find(ns+'Representation');template=rep.find(ns+'SegmentTemplate')
  init=template.attrib.pop('initialization');rep.remove(template);adaptation.insert(0,template)
  child=E.SubElement(rep,ns+'SegmentTemplate',initialization=init)
  if replace:
   timeline=template.find(ns+'SegmentTimeline');template.remove(timeline);child.append(timeline)
   bad=E.SubElement(template,ns+'SegmentTimeline');E.SubElement(bad,ns+'S',d='1',r='9000')
 E.ElementTree(root).write(p/('inherited-replaced.mpd' if replace else 'inherited.mpd'),encoding='unicode')
`]);
await writeFile(`${fixtures}/redirect/master.m3u8`, '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",DEFAULT=YES,URI="audio-start.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=200000,AUDIO="audio"\nvideo-start.m3u8\n');
await writeFile(`${fixtures}/master.m3u8`, '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",DEFAULT=YES,URI="audio/list.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=200000,AUDIO="audio"\nvideo/list.m3u8\n');
command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `${fixtures}/clip.mp4`, '-map', '0:v:0', '-c', 'copy', '-y', `${fixtures}/video-only.mp4`]);
command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=1', '-c:a', 'aac', '-y', `${fixtures}/audio-only.m4a`]);
for (const [name, size] of [['low', '640:360'], ['high', '960:540']]) command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `${fixtures}/clip.mp4`, '-vf', `scale=${size}`, '-c:v', 'libx264', '-c:a', 'copy', '-hls_time', '0.5', '-hls_playlist_type', 'vod', '-y', `${fixtures}/${name}/list.m3u8`]);
await writeFile(`${fixtures}/quality.m3u8`, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360\nlow/list.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=960x540\nhigh/list.m3u8\n');
command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `${fixtures}/clip.mp4`, '-map', '0:v:0', '-map', '0:v:0', '-map', '0:a:0', '-filter:v:0', 'scale=640:360', '-filter:v:1', 'scale=960:540', '-c:v', 'libx264', '-c:a', 'copy', '-f', 'dash', '-y', `${fixtures}/quality-dash/list.mpd`]);
for (const name of ['parallel', 'retry', 'redirect']) command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `${fixtures}/clip.mp4`, '-c:v', 'libx264', '-g', '4', '-keyint_min', '4', '-c:a', 'aac', '-hls_time', '0.333333', '-hls_playlist_type', 'vod', '-hls_segment_filename', `${fixtures}/${name}/seg-%03d.ts`, '-y', `${fixtures}/${name}/list.m3u8`]);
await writeFile(`${fixtures}/encrypted.m3u8`, '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://invalid.example/key"\n#EXTINF:1,\nclip.mp4\n#EXT-X-ENDLIST\n');
await writeFile(`${fixtures}/protected.mpd`, '<MPD type="static" mediaPresentationDuration="PT1S"><Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:protected"/><Representation id="v" bandwidth="1"><BaseURL>https://invalid.example/private.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>');
await writeFile(`${fixtures}/malicious.mp4`, '<html><script>fetch("https://invalid.example/upload")</script></html>');
await writeFile(`${fixtures}/plain.txt`, 'This response is text, not a video file.');
await prepareDashAuditFixtures(fixtures);
await prepareOwnedInputAudit(fixtures, buildPaths);
await prepareDatabaseAudit(fixtures);
const completionFixture = await build({ entryPoints: ['src/upscale/completion.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', write: false });
// This source-only fixture needs the production locations explicitly; production
// runtime.getURL below deliberately performs no mapping or repair.
let completionSource = completionFixture.outputFiles[0].text;
for (const [logical, physical] of Object.entries(assetMap)) completionSource = completionSource.replaceAll(logical, physical);
await writeFile(`${fixtures}/completion-audit.js`, completionSource);
const originalHash = createHash('sha256').update(await readFile(`${fixtures}/clip.mp4`)).digest('hex');

const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png', '.mp4': 'video/mp4', '.json': 'application/json', '.m3u8': 'application/vnd.apple.mpegurl', '.mpd': 'application/dash+xml', '.ts': 'video/mp2t' };
let parallelActive = 0, parallelPeak = 0, retrySegmentHits = 0, slowActive = 0, slowPeak = 0;
const slowHits = new Map();
const productionAssets = new Set();
const legacyRuntimeRequests = [];
const server = createServer(async (request, response) => {
  try {
    const address = new URL(request.url, 'http://localhost');
    const name = decodeURIComponent(address.pathname);
    const redirect = { '/fixtures/redirect-start.m3u8': '/fixtures/redirect/master.m3u8', '/fixtures/redirect/video-start.m3u8': '/fixtures/video/list.m3u8', '/fixtures/redirect/audio-start.m3u8': '/fixtures/audio/list.m3u8', '/fixtures/dash-redirect.mpd': '/fixtures/dash/list.mpd' }[name];
    if (redirect) { response.writeHead(302, { Location: redirect }).end(); return; }

    if (name.includes('..') || name.includes('\\')) { response.writeHead(403).end(); return; }
    if (Object.hasOwn(assetMap, name.slice(1))) { legacyRuntimeRequests.push(name + address.search); response.writeHead(404).end('Legacy runtime paths are not shipped'); return; }
    if (name === '/fixtures/retry/seg-000.ts' && ++retrySegmentHits === 1) { response.writeHead(503, { 'Retry-After': '0' }).end('busy'); return; }
    if (name.startsWith('/fixtures/parallel/') && name.endsWith('.ts')) { parallelActive++; parallelPeak = Math.max(parallelPeak, parallelActive); await new Promise(resolve => setTimeout(resolve, 60)); parallelActive--; }
    if (address.searchParams.has('slow')) { const id = address.searchParams.get('slow'); slowHits.set(id, (slowHits.get(id) ?? 0) + 1); slowActive++; slowPeak = Math.max(slowPeak, slowActive); await new Promise(resolve => setTimeout(resolve, 100)); slowActive--; }
    const alias = {
      '/fixtures/video.txt': ['clip.mp4', 'text/plain'],
      '/fixtures/webm.txt': ['clip.webm', 'text/plain', 'attachment; filename="video.txt"'],
      '/fixtures/disposition.txt': ['clip.mp4', 'application/octet-stream', 'attachment; filename="video.txt"'],
      '/fixtures/html.txt': ['malicious.mp4', 'text/html'],
      '/fixtures/spoofed.mp4': ['malicious.mp4', 'video/mp4'],
    }[name];
    const target = alias ? path.join(fixtures, alias[0]) : name.startsWith('/fixtures/') ? path.join(fixtures, name.slice('/fixtures/'.length)) : path.join(root, 'dist', name);
    const bytes = await readFile(target);
    if (name.startsWith('/assets/')) productionAssets.add(name.slice(1));
    const contentType = alias?.[1] ?? types[path.extname(target)] ?? 'application/octet-stream';
    const disposition = alias?.[2] ? { 'Content-Disposition': alias[2] } : {};
    if (request.headers.range) {
      const range = request.headers.range.match(/^bytes=(\d+)-(\d+)$/);
      if (!range || Number(range[1]) >= bytes.length || Number(range[2]) < Number(range[1])) { response.writeHead(416).end(); return; }
      const start = Number(range[1]), end = Math.min(Number(range[2]), bytes.length - 1);
      response.writeHead(206, { 'Content-Type': contentType, ...disposition, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 });
      response.end(bytes.subarray(start, end + 1)); return;
    }
    response.writeHead(200, { 'Content-Type': contentType, ...disposition, 'Cache-Control': 'no-store' }); response.end(bytes);
  } catch { response.writeHead(404).end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1100, height: 1000 } });
const outcomes = [];
const outbound = [];
await context.route('**/*', route => {
  const url = route.request().url();
  if (url.startsWith(origin + '/') || url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
  outbound.push(url); return route.abort();
});
await context.addInitScript(assetMap => {
  const assetURL = value => {
    const name = value.replace(/^\/+/, '');
    const split = name.search(/[?#]/);
    const pathname = split < 0 ? name : name.slice(0, split);
    return new URL((assetMap[pathname] ?? pathname) + (split < 0 ? '' : name.slice(split)), location.origin + '/').href;
  };
  window.__testAssetURL = assetURL;
  const listeners = () => {
    const handlers = [];
    return { addListener(fn) { handlers.push(fn); }, removeListener(fn) { const index = handlers.indexOf(fn); if (index >= 0) handlers.splice(index, 1); }, fire(...args) { for (const fn of handlers) fn(...args); } };
  };
  const blobs = new Map();
  const createObjectURL = URL.createObjectURL.bind(URL); const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = blob => { const url = createObjectURL(blob); blobs.set(url, blob); return url; };
  URL.revokeObjectURL = url => { blobs.delete(url); revokeObjectURL(url); };
  const storageKey = 'VDH_TEST_CHROME_STORAGE';
  const read = () => JSON.parse(localStorage.getItem(storageKey) ?? '{}');
  const downloads = new Map(); let sequence = 0; let hasOffscreen = false;
  window.__testDownloads = downloads;
  window.__appGet = async key => (await import('/fixtures/database-audit.js')).appStorage.get(key);
  window.__appSet = async values => (await import('/fixtures/database-audit.js')).appStorage.set(values);
  // Actual IndexedDB reads and commits run normally. Preference timing tests
  // explicitly delay delivery of the transaction completion callback.
  const originalGet = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (key) {
    const request = originalGet.call(this, key);
    if (this.name === 'settings' && key === 'vdh_upscale_offer_v1') window.__offerReads = (window.__offerReads || 0) + 1;
    if (this.name === 'settings' && key === 'my_video_app_download_options_v1') {
      window.__prefsReads = (window.__prefsReads || 0) + 1;
      if (new URL(location.href).searchParams.has('test-delay-preferences') && !window.__preferencesReleased) {
        const pending = []; let released = false;
        const transaction = request.transaction;
        const completed = transaction.oncomplete;
        if (typeof completed !== 'function') throw new Error('Preference audit requires an installed transaction completion callback');
        transaction.oncomplete = function (event) {
          if (released) completed.call(this, event);
          else pending.push(() => completed.call(this, event));
        };
        window.__releasePreferences = () => { released = true; window.__preferencesReleased = true; for (const replay of pending.splice(0)) replay(); };
      }
    }
    return request;
  };
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, ...args) {
    if (this.name === 'settings' && value?.key === 'vdh_upscale_offer_v1') window.__offerWrites = (window.__offerWrites || 0) + 1;
    return originalPut.call(this, value, ...args);
  };
  const api = {
    permissions: { contains: async () => window.__avPermission !== false, request: async () => { window.__avPermission = true; return true; } },
    runtime: { connectNative: () => {
      const port = { onMessage: listeners(), onDisconnect: listeners(), disconnect() {}, postMessage: request => {
        window.__avRequests = [...(window.__avRequests || []), request];
        if (request.action === 'status') { queueMicrotask(() => port.onMessage.fire({ version: 1, requestId: request.requestId, status: window.__avHostMissing ? 'unavailable' : 'ready', engine: 'Test double; no actual AV', message: window.__avHostMissing ? '백신 도우미가 설치되어 있지 않습니다.' : '도우미와 검사기 선택 확인. 파일 검사는 다운로드 후 수행합니다.' })); return; }
        const file = Array.from(downloads.values()).find(item => item.filename === request.path);
        const respond = () => port.onMessage.fire({ version: 1, requestId: request.requestId, status: window.__avStatus || 'clean', engine: 'Test double; no actual AV', sha256: file?.testSha256 || 'a'.repeat(64), size: file?.fileSize ?? 12, ...(window.__avStatus === 'infected' ? { threats: ['Harmless test detection <img src=x onerror=alert(1)>'] } : {}) });
        if (window.__avHold) window.__avRelease = respond; else queueMicrotask(respond);
      } }; return port;
    }, id: 'test-double-only', getURL: value => new URL(value.replace(/^\/+/, ''), location.origin + '/').href, onInstalled: listeners(), onStartup: listeners(), onMessage: listeners(), sendMessage: async message => {
      if (message.scope === 'my-video-app/offscreen') {
        const module = await import(window.__testAssetURL('local/offscreen.js'));
        if (message.type === 'prepare') { try { return await module.prepareLocal(message.id, message.url, message.kind, message.options); } catch (error) { await module.disposeLocal(message.id); return { ok: false, error: error.message, invalidMedia: error.name === 'InvalidMediaFileError' }; } }
        if (message.type === 'cancel') { module.cancelLocal(message.id); return { ok: true }; }
        if (message.type === 'dispose') { await module.disposeLocal(message.id); return { ok: true }; }
      }
      const background = await import(window.__testAssetURL('local/background.js'));
      const sender = { id: 'test-double-only', url: assetURL(message.type === 'preparing-progress' ? 'local/offscreen.html' : 'local/index.html') };
      if (message.type === 'capture') { sender.url = `${location.origin}/example-page`; sender.tab = { id: 7 }; }
      const result = await background.handleLocalMessage(message, sender);
      if (message.type === 'list') window.__listReads = (window.__listReads || 0) + 1;
      return result;
    } },
    extension: { inIncognitoContext: new URL(location.href).searchParams.has('test-incognito') },
    storage: { local: {
      get: async key => { const data = read(); if (!key) return data; if (typeof key === 'string') return { [key]: data[key] }; return Object.fromEntries(key.map(k => [k, data[k]])); },
      set: async values => { localStorage.setItem(storageKey, JSON.stringify({ ...read(), ...values })); },
      remove: async keys => { const data = read(); for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key]; localStorage.setItem(storageKey, JSON.stringify(data)); },
    } },
    notifications: {
      onClicked: listeners(), onButtonClicked: listeners(), clear: async () => true,
      create: async (id, options) => { localStorage.setItem('VDH_TEST_NOTIFICATION', JSON.stringify({ id, options })); return id; },
    },
    contextMenus: { onClicked: listeners(), create() {} },
    tabs: { create: async options => { window.__lastCreatedTab = options; return options; }, query: async () => [{ id: 7, url: `${location.origin}/example-page`, active: true, incognito: false }], get: async id => ({ id, url: `${location.origin}/example-page`, incognito: false }), onRemoved: listeners(), onUpdated: listeners(), onActivated: listeners() },
    webRequest: { onHeadersReceived: listeners() }, commands: { onCommand: listeners() },
    offscreen: { Reason: { BLOBS: 'BLOBS', WORKERS: 'WORKERS', DOM_PARSER: 'DOM_PARSER' }, hasDocument: async () => hasOffscreen, createDocument: async () => { hasOffscreen = true; } },
    sidePanel: { setPanelBehavior: async () => {} }, action: { setPopup: async () => {} },
    downloads: { onChanged: listeners(), download: async options => {
      const bytes = options.url.startsWith('blob:') ? await blobs.get(options.url).arrayBuffer() : await (await fetch(options.url)).arrayBuffer();
      const testSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      const link = document.createElement('a'); link.href = options.url; link.download = options.filename; document.body.append(link); link.click(); link.remove();
      const id = ++sequence; downloads.set(id, { id, state: window.__holdDownloads ? 'in_progress' : 'complete', filename: '/test-downloads/' + options.filename, danger: window.__downloadDanger || 'safe', exists: true, fileSize: bytes.byteLength, testSha256, url: options.url, incognito: false, bytesReceived: 12, totalBytes: 24 }); return id;
    }, search: async query => {
      if (window.__duplicateCompletion && query.id !== undefined && downloads.get(query.id)?.state === 'complete') {
        window.__duplicateCompletion = false;
        api.downloads.onChanged.fire({ id: query.id, state: { current: 'complete' } });
        api.downloads.onChanged.fire({ id: query.id, state: { current: 'complete' } });
      }
      return query.id === undefined ? Array.from(downloads.values()) : [downloads.get(query.id)].filter(Boolean);
    }, cancel: async id => { const item = downloads.get(id); if (item) { item.state = 'interrupted'; item.error = 'USER_CANCELED'; api.downloads.onChanged.fire({ id, state: { current: 'interrupted' } }); } }, removeFile: async id => { if (window.__avDeleteFail) throw new Error('simulated removal failure'); const item = downloads.get(id); if (item) item.exists = false; }, show() {} },
  };
  Object.defineProperty(window, 'chrome', { value: api, configurable: true });
}, assetMap);
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
const checks = async (name, run) => { await run(); outcomes.push({ name, status: 'passed' }); console.log(`PASS ${name}`); };
// Playwright polls synchronous predicates; poll async storage/OPFS checks explicitly.
async function waitForAsync(predicate, argument, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!await page.evaluate(predicate, argument)) {
    assert(Date.now() < deadline, 'Timed out waiting for an asynchronous browser condition');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function openTools(target = page) { await target.goto(buildPaths.url(origin, 'upscale/index.html')); await target.waitForFunction(() => document.querySelector('#offer')?.checked === true); }
async function convert(filename, scale, destination) {
  await page.locator('#file').setInputFiles(`${fixtures}/${filename}`);
  await page.locator('#factor').selectOption(String(scale));
  await page.locator('#start').click();
  await page.waitForFunction(() => !document.querySelector('#save').hidden || (!document.querySelector('#start').disabled && document.querySelector('#progress').value === 0), undefined, { timeout: 60_000 });
  assert.equal(await page.locator('#save').isVisible(), true, await page.locator('#status').innerText());
  const pending = page.waitForEvent('download');
  await page.locator('#save').click();
  const download = await pending;
  await download.saveAs(destination);
  assert.equal(await download.failure(), null);
  return JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', destination]));
}
async function remux(playlist, kind, filename, options, expectedHeight = 90) {
  const prepared = await page.evaluate(async ({ url, kind, options }) => {
    const offscreen = await import(window.__testAssetURL('local/offscreen.js'));
    const id = crypto.randomUUID();
    const result = await offscreen.prepareLocal(id, url, kind, options);
    return { id, ...result };
  }, { url: `${origin}/fixtures/${playlist}`, kind, options });
  try {
    const pending = page.waitForEvent('download');
    await page.evaluate(({ url, filename }) => { const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); }, { url: prepared.url, filename });
    const file = await pending; await file.saveAs(`${results}/${filename}`); assert.equal(await file.failure(), null);
    const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', `${results}/${filename}`]));
    const video = probe.streams.find(stream => stream.codec_type === 'video');
    const audio = probe.streams.find(stream => stream.codec_type === 'audio');
    if (options?.output && options.output !== 'original') { assert.equal(video, undefined); assert.equal(audio.codec_name, options.output === 'mp3' ? 'mp3' : 'aac'); }
    else { assert.equal(video.codec_name, 'h264'); assert.equal(Number(video.nb_frames), 12); assert.equal(video.height, expectedHeight); assert.equal(audio.codec_name, 'aac'); }
    assert(Number(probe.format.duration) >= 0.9 && Number(probe.format.duration) < 1.5);
    command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `${results}/${filename}`, '-f', 'null', '-']);
  } finally { await page.evaluate(async id => { const module = await import(window.__testAssetURL('local/offscreen.js')); await module.disposeLocal(id); }, prepared.id); }
}
async function processFile(mode, format, destination, input = `${fixtures}/clip.mp4`, secondary) {
  await page.locator('#mode').selectOption(mode);
  await page.locator('#file').setInputFiles(input);
  await page.locator(mode === 'audio' ? '#audio-format' : mode === 'merge' ? '#merge-format' : '#video-format').selectOption(format);
  if (secondary) await page.locator('#audio-file').setInputFiles(secondary);
  await page.locator('#start').click();
  await page.waitForFunction(() => !document.querySelector('#save').hidden || (!document.querySelector('#start').disabled && document.querySelector('#progress').value === 0), undefined, { timeout: 60_000 });
  assert.equal(await page.locator('#save').isVisible(), true, await page.locator('#status').innerText());
  const pending = page.waitForEvent('download'); await page.locator('#save').click();
  const file = await pending; await file.saveAs(destination); assert.equal(await file.failure(), null);
  command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', destination, '-f', 'null', '-']);
  return JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', destination]));
}
function toneFrequency(filename) {
  // Measure steady audio after codec priming; AAC in Matroska retains initial delay samples.
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', filename, '-ss', '0.1', '-map', '0:a:0', '-t', '0.7', '-ac', '1', '-ar', '44100', '-f', 's16le', '-'], { maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0); const bytes = result.stdout; let crossings = 0;
  for (let i = 2; i < bytes.length; i += 2) if (bytes.readInt16LE(i - 2) <= 0 && bytes.readInt16LE(i) > 0) crossings++;
  return crossings * 44100 / (bytes.length / 2);
}
try {
  await checks('Embedded database creates, migrates and manages data atomically in real IndexedDB', () => verifyDatabaseAudit(context, origin));
  await checks('Toolbar popup and authenticated collector rescan work with real DOM and IndexedDB', () => verifyPopupAudit(browser, origin, buildPaths));
  await checks('Built UI loads with CSP; actual FFmpeg Worker assets available', async () => {
    await openTools(); assert.equal(await page.title(), '미디어 도구 · My Video App');
    assert.equal(await page.locator('#start').isDisabled(), true);
    assert.equal(await (await context.request.get(buildPaths.url(origin, 'vendor/ffmpeg/ffmpeg-core.wasm'))).status(), 200);
    assert.equal(page.url(), buildPaths.url(origin, 'upscale/index.html'));
  });
  await checks('Local install uses independent entry points without an account/activation engine', async () => {
    const manifest = await assertProtectedBuild(root, buildPaths);
    assert.equal(manifest.background.service_worker, buildPaths.resolve('local/background.js'));
    assert.equal(manifest.action.default_popup, buildPaths.resolve('local/popup.html'));
    assert.equal(manifest.options_ui.page, buildPaths.resolve('local/index.html'));
    assert.equal(manifest.side_panel.default_path, buildPaths.resolve('local/index.html'));
    assert.deepEqual(manifest.content_scripts[0].js, [buildPaths.resolve('local/collect.js')]);
    assert.equal(manifest.version, JSON.parse(await readFile('package.json', 'utf8')).version);
    assert.equal(manifest.key, undefined); assert.equal(manifest.update_url, undefined);
    const result = await context.request.get(`${origin}/service/main.js`); assert.equal(result.status(), 404);
  });
  await checks('PNG 2x produces a real decodable 128x96 image', async () => {
    const probe = await convert('image.png', 2, `${results}/image-2x.png`);
    assert.equal(probe.streams[0].width, 128); assert.equal(probe.streams[0].height, 96);
    assert.equal(probe.streams[0].codec_name, 'png');
  });
  await checks('PNG 4x produces a real decodable 256x192 image', async () => {
    const probe = await convert('image.png', 4, `${results}/image-4x.png`);
    assert.equal(probe.streams[0].width, 256); assert.equal(probe.streams[0].height, 192);
  });
  await checks('MP4 2x preserves duration and audio in separate H.264/AAC output', async () => {
    const probe = await convert('clip.mp4', 2, `${results}/clip-2x.mp4`);
    const video = probe.streams.find(stream => stream.codec_type === 'video');
    const audio = probe.streams.find(stream => stream.codec_type === 'audio');
    assert.equal(video.width, 320); assert.equal(video.height, 180); assert.equal(video.codec_name, 'h264');
    assert.equal(Number(video.nb_frames), 12); assert.equal(audio.codec_name, 'aac');
    assert(Math.abs(Number(probe.format.duration) - 1) < 0.15);
    assert.equal(createHash('sha256').update(await readFile(`${fixtures}/clip.mp4`)).digest('hex'), originalHash);
    command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `${results}/clip-2x.mp4`, '-f', 'null', '-']);
  });
  await checks('Owned input buffers preserve exact media outputs, metadata, random reads and source files in eight real Workers', () => verifyOwnedInputProcessing(page, origin));
  for (const format of ['mp4', 'mkv', 'webm']) await checks(`Local video conversion writes decodable ${format.toUpperCase()} with its expected codecs`, async () => {
    const result = await processFile('convert', format, `${results}/converted.${format}`);
    const video = result.streams.find(s => s.codec_type === 'video'); const audio = result.streams.find(s => s.codec_type === 'audio');
    assert.equal(video.codec_name, format === 'webm' ? 'vp8' : 'h264'); assert.equal(audio.codec_name, format === 'webm' ? 'opus' : 'aac');
    assert.equal(video.width, 160); assert.equal(video.height, 90);
    assert(Math.abs(Number(result.format.duration) - 1) < 0.2);
  });
  for (const format of ['mp3', 'm4a', 'wav']) await checks(`Local audio extraction writes ${format.toUpperCase()} with the original audible tone`, async () => {
    const filename = `${results}/extracted.${format}`;
    const result = await processFile('audio', format, filename);
    assert.equal(result.streams.filter(s => s.codec_type === 'video').length, 0);
    assert.equal(result.streams[0].codec_name, { mp3: 'mp3', m4a: 'aac', wav: 'pcm_s16le' }[format]);
    assert(Math.abs(toneFrequency(filename) - 440) < 10);
  });
  for (const format of ['mp4', 'mkv']) await checks(`Local ${format.toUpperCase()} merge copies video and replaces its audio with the chosen file`, async () => {
    const filename = `${results}/merged.${format}`;
    const result = await processFile('merge', format, filename, `${fixtures}/video-only.mp4`, `${fixtures}/audio-only.m4a`);
    assert.equal(result.streams.find(s => s.codec_type === 'video').codec_name, 'h264');
    const hash = name => command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', name, '-map', '0:v:0', '-c', 'copy', '-f', 'streamhash', '-hash', 'sha256', '-']);
    assert.equal(hash(filename), hash(`${fixtures}/video-only.mp4`));
    assert(Math.abs(toneFrequency(filename) - 880) < 10);
  });
  await checks('Standalone audio files can be converted without a video track', async () => {
    const result = await processFile('audio', 'm4a', `${results}/audio-reencoded.m4a`, `${results}/extracted.mp3`);
    assert.equal(result.streams.length, 1); assert.equal(result.streams[0].codec_name, 'aac');
  });
  await checks('Missing audio is rejected and conversion cancellation allows the next job', async () => {
    await page.locator('#mode').selectOption('audio'); await page.locator('#file').setInputFiles(`${fixtures}/video-only.mp4`); await page.locator('#start').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('오디오 트랙이 없습니다'));
    assert.equal(await page.locator('#save').isVisible(), false);
    await page.locator('#mode').selectOption('convert'); await page.locator('#file').setInputFiles(`${fixtures}/clip.mp4`); await page.locator('#start').click();
    assert.equal(await page.locator('#mode').isDisabled(), true); await page.locator('#cancel').click();
    assert.equal(await page.locator('#mode').isDisabled(), false); assert.equal(await page.locator('#save').isVisible(), false);
    await processFile('convert', 'mp4', `${results}/converted-after-cancel.mp4`);
    await page.screenshot({ path: `${results}/media-tools.png`, fullPage: true });
    await page.locator('#mode').selectOption('upscale');
  });
  await checks('HTML disguised as MP4 is rejected before decode', async () => {
    await page.locator('#file').setInputFiles(`${fixtures}/malicious.mp4`); await page.locator('#start').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('지원하는 형식'));
    assert.equal(await page.locator('#save').isVisible(), false);
  });
  await checks('Excessive output dimensions are rejected', async () => {
    await page.locator('#file').setInputFiles(`${fixtures}/wide.png`); await page.locator('#start').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('8,192'));
    assert.equal(await page.locator('#save').isVisible(), false);
  });
  await checks('Cancel terminates actual Worker and allows a new job', async () => {
    await page.locator('#file').setInputFiles(`${fixtures}/clip.mp4`); await page.locator('#start').click(); await page.locator('#cancel').click();
    assert.match(await page.locator('#status').innerText(), /취소했습니다/); assert.equal(await page.locator('#start').isDisabled(), false);
    assert.equal(await page.locator('#save').isVisible(), false);
    await convert('image.png', 2, `${results}/after-cancel.png`);
  });
  await checks('Completion hook stages successful file before original cleanup; other outcomes skipped', async () => {
    const result = await page.evaluate(async () => {
      const { offerUpscale } = await import('/fixtures/completion-audit.js');
      const root = await navigator.storage.getDirectory();
      const file = await (await root.getFileHandle('finished-download.mp4', { create: true })).createWritable();
      const response = await fetch('/fixtures/clip.mp4'); await response.body.pipeTo(file);
      const args = { internalFilename: 'finished-download.mp4', filename: 'folder/completed.mp4', downloadId: 99, success: true, incognito: false };
      await offerUpscale({ ...args, success: false }); await offerUpscale({ ...args, incognito: true });
      const before = (await window.__appGet('vdh_upscale_jobs_v1')).vdh_upscale_jobs_v1 ?? [];
      await offerUpscale(args);
      const jobs = (await window.__appGet('vdh_upscale_jobs_v1')).vdh_upscale_jobs_v1;
      await root.removeEntry('finished-download.mp4');
      const dir = await root.getDirectoryHandle('vdh-upscale-v1');
      const blob = await (await dir.getFileHandle(jobs[0].id)).getFile();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))).map(b => b.toString(16).padStart(2, '0')).join('');
      return { before: before.length, jobs, hash, notification: JSON.parse(localStorage.getItem('VDH_TEST_NOTIFICATION')) };
    });
    assert.equal(result.before, 0); assert.equal(result.jobs.length, 1); assert.equal(result.jobs[0].filename, 'completed.mp4');
    assert.equal(result.hash, originalHash); assert.match(result.notification.id, /^vdh-upscale:/);
    await page.locator('#refresh').click(); await page.waitForFunction(() => document.querySelectorAll('#jobs li').length === 1);
    await page.locator('#jobs li button').first().click();
    await page.waitForFunction(() => document.querySelector('#selected').textContent.includes('completed.mp4'));
  });
  await checks('Shared queue lock survives simultaneous offer and cleanup in two tabs', async () => {
    const second = await context.newPage(); await openTools(second);
    const stage = page.evaluate(async () => {
      const { offerUpscale } = await import('/fixtures/completion-audit.js');
      const root = await navigator.storage.getDirectory();
      const file = await (await root.getFileHandle('parallel.png', { create: true })).createWritable();
      await (await fetch('/fixtures/image.png')).body.pipeTo(file);
      await offerUpscale({ internalFilename: 'parallel.png', filename: 'parallel.png', downloadId: 100, success: true, incognito: false });
      await root.removeEntry('parallel.png');
    });
    await second.locator('#refresh').click(); await stage; await second.locator('#refresh').click();
    await second.waitForFunction(() => document.querySelectorAll('#jobs li').length === 2);
    await second.close();
  });
  await checks('Private tools hide the shared normal queue and preserve its files while manual processing remains usable', async () => {
    const before = await page.evaluate(async () => (await window.__appGet('vdh_upscale_jobs_v1')).vdh_upscale_jobs_v1);
    assert.equal(before.length, 2);
    const target = await context.newPage();
    try {
      await target.goto(buildPaths.url(origin, 'upscale/index.html?test-incognito=1'));
      await target.waitForFunction(() => document.querySelector('#offer').disabled);
      assert.equal(await target.locator('#offer').isChecked(), false);
      assert.match(await target.locator('#offer-private-status').innerText(), /시크릿/);
      assert.equal(await target.locator('#jobs li').count(), 0);
      await target.locator('#refresh').click(); await target.locator('#clear').click();
      await target.locator('#file').setInputFiles(`${fixtures}/image.png`);
      await target.locator('#factor').selectOption('2'); await target.locator('#start').click();
      await target.waitForFunction(() => !document.querySelector('#save').hidden);
      const pending = target.waitForEvent('download'); await target.locator('#save').click();
      const file = await pending; await file.saveAs(`${results}/private-manual-image.png`);
      const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', `${results}/private-manual-image.png`]));
      assert.equal(probe.streams[0].width, 128); assert.equal(probe.streams[0].height, 96);
      const after = await page.evaluate(async () => (await window.__appGet('vdh_upscale_jobs_v1')).vdh_upscale_jobs_v1);
      assert.deepEqual(after, before);
      assert.deepEqual(await target.evaluate(() => [window.__offerReads || 0, window.__offerWrites || 0]), [0, 0]);
      const retained = await page.evaluate(async ids => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('vdh-upscale-v1');
        return Promise.all(ids.map(async id => (await (await dir.getFileHandle(id)).getFile()).size));
      }, before.map(job => job.id));
      assert.deepEqual(retained, before.map(job => job.size));
    } finally { await target.close(); }
  });
  await checks('Opt-out skips staging; TTL and delete clean real OPFS data', async () => {
    await page.locator('#offer').uncheck();
    await page.evaluate(async () => {
      const { offerUpscale } = await import('/fixtures/completion-audit.js');
      await offerUpscale({ internalFilename: 'does-not-need-to-exist', filename: 'disabled.mp4', downloadId: 101, success: true, incognito: false });
      const key = 'vdh_upscale_jobs_v1';
      const stored = (await window.__appGet(key))[key];
      stored[0].createdAt = Date.now() - 25 * 60 * 60 * 1000;
      await window.__appSet({ [key]: stored });
    });
    await page.locator('#refresh').click(); await page.waitForFunction(() => document.querySelectorAll('#jobs li').length === 1);
    await page.locator('#clear').click(); await page.waitForFunction(() => document.querySelectorAll('#jobs li').length === 0);
    const count = await page.evaluate(async () => { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('vdh-upscale-v1'); return (await Array.fromAsync(dir.keys())).length; });
    assert.equal(count, 0); await page.locator('#offer').check();
  });
  await page.screenshot({ path: `${results}/upscaler.png`, fullPage: true });
  await checks('Independent HLS VOD remux preserves video frames and audio', () => remux('hls/list.m3u8', 'hls', 'local-hls.mp4'));
  await checks('Parallel segment downloads multiplex up to three requests and preserve the complete decoded video', async () => {
    await remux('parallel/list.m3u8', 'hls', 'local-parallel.mp4'); assert.equal(parallelPeak, 3);
  });
  await checks('Transient segment failure is retried without a duplicate or missing media segment', async () => {
    await remux('retry/list.m3u8', 'hls', 'local-retried.mp4'); assert.equal(retrySegmentHits, 2);
  });
  await checks('Concurrent preparations queue successfully and cancelling a waiting job makes no file request', async () => {
    const results = await page.evaluate(async origin => {
      const module = await import(window.__testAssetURL('local/offscreen.js'));
      const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
      const work = ids.map((id, i) => module.prepareLocal(id, `${origin}/fixtures/clip.mp4?slow=${['first', 'second', 'cancelled'][i]}`, 'file'));
      module.cancelLocal(ids[2]);
      const outcomes = await Promise.allSettled(work); const hashes = [];
      for (let i = 0; i < 2; i++) {
        if (outcomes[i].status !== 'fulfilled') throw outcomes[i].reason;
        const file = await (await (await navigator.storage.getDirectory()).getFileHandle(outcomes[i].value.filename)).getFile();
        const bytes = await file.arrayBuffer();
        hashes.push(Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join(''));
        await module.disposeLocal(ids[i]);
      }
      return { statuses: outcomes.map(row => row.status), hashes };
    }, origin);
    assert.deepEqual(results.statuses, ['fulfilled', 'fulfilled', 'rejected']); assert.deepEqual(results.hashes, [originalHash, originalHash]);
    assert.equal(slowPeak, 1); assert.equal(slowHits.get('cancelled'), undefined);
  });
  await checks('Browser-reported HTTP/1.1 is observed on a real fetch without forcing a transport', async () => {
    const observation = await page.evaluate(async origin => {
      const module = await import(window.__testAssetURL('local/offscreen.js')); const id = crypto.randomUUID();
      try { const result = await module.prepareLocal(id, `${origin}/fixtures/clip.mp4?observe=1`, 'file'); return { protocols: result.protocols, entries: performance.getEntriesByName(`${origin}/fixtures/clip.mp4?observe=1`).map(entry => ({ protocol: entry.nextHopProtocol, start: entry.startTime, end: entry.responseEnd })) }; }
      finally { await module.disposeLocal(id); }
    }, origin);
    assert(observation.protocols.includes('http/1.1'), JSON.stringify(observation));
  });
  await checks('HLS master handles its separate default audio track', () => remux('master.m3u8', 'hls', 'local-master.mp4'));
  await checks('HLS byte ranges produce a complete decodable MP4', () => remux('range/list.m3u8', 'hls', 'local-range.mp4'));
  await checks('Independent static DASH remux preserves separate video and audio tracks', () => remux('dash/list.mpd', 'dash', 'local-dash.mp4'));
  await checks('Redirected HLS master and child playlists resolve relative media against each actual response URL', () => remux('redirect-start.m3u8', 'hls', 'redirect-hls.mp4'));
  await checks('Redirected DASH manifest resolves relative initialization and media against its actual response URL', () => remux('dash-redirect.mpd', 'dash', 'redirect-dash.mp4'));
  await checks('DASH representation templates inherit parent attributes and timeline while overriding initialization', () => remux('dash/inherited.mpd', 'dash', 'inherited-dash.mp4'));
  await checks('DASH child timeline replaces its parent timeline without losing inherited attributes', () => remux('dash/inherited-replaced.mpd', 'dash', 'replaced-dash.mp4'));
  await checks('DASH terminal repeats respect inherited presentation offsets in real 100-second fragments', () => remux('audit-offset/list.mpd', 'dash', 'offset-dash.mp4'));
  await checks('DASH SegmentList inherits initialization and replaces ancestor media URLs in a complete remux', () => remux('audit-list/list.mpd', 'dash', 'list-dash.mp4'));
  await checks('DASH planner checks ten offset, inheritance, fractional-boundary and overflow invariants in Chromium', () => verifyDashPlanner(page, origin));

  await checks('HLS highest quality selects the larger rendition even at lower declared bitrate', () => remux('quality.m3u8', 'hls', 'quality-highest-hls.mp4', { quality: 'highest', output: 'original' }, 540));
  await checks('HLS height ceiling selects the actual available lower rendition', () => remux('quality.m3u8', 'hls', 'quality-lower-hls.mp4', { quality: '480', output: 'original' }, 360));
  await checks('DASH highest quality selects the actual larger rendition', () => remux('quality-dash/list.mpd', 'dash', 'quality-highest-dash.mp4', { quality: 'highest', output: 'original' }, 540));
  await checks('DASH height ceiling selects the actual available lower rendition', () => remux('quality-dash/list.mpd', 'dash', 'quality-lower-dash.mp4', { quality: '480', output: 'original' }, 360));
  await checks('HLS separate audio can be saved as a decodable MP3', () => remux('master.m3u8', 'hls', 'download-hls.mp3', { quality: 'highest', output: 'mp3' }));
  await checks('DASH audio can be saved as a decodable M4A', () => remux('dash/list.mpd', 'dash', 'download-dash.m4a', { quality: 'highest', output: 'm4a' }));
  await checks('Direct MP4 can be downloaded as audio through the same local worker', () => remux('clip.mp4', 'file', 'download-direct.mp3', { quality: 'highest', output: 'mp3' }));
  await checks('Local video conversion applies a real height ceiling', async () => {
    await page.locator('#mode').selectOption('convert');
    await page.locator('#convert-quality').selectOption('480');
    const result = await processFile('convert', 'mp4', `${results}/converted-lower.mp4`, `${results}/quality-highest-hls.mp4`);
    assert.equal(result.streams.find(s => s.codec_type === 'video').height, 480);
    assert.equal(result.streams.find(s => s.codec_type === 'video').width, 852);
  });
  await checks('Encrypted HLS and protected DASH are rejected without any key/license requests', async () => {
    const messages = await page.evaluate(async origin => {
      const offscreen = await import(window.__testAssetURL('local/offscreen.js')); const messages = [];
      for (const [path, kind] of [['encrypted.m3u8', 'hls'], ['protected.mpd', 'dash']]) {
        try { await offscreen.prepareLocal(crypto.randomUUID(), `${origin}/fixtures/${path}`, kind); messages.push('unexpected success'); }
        catch (error) { messages.push(error.message); }
      }
      return messages;
    }, origin);
    assert.equal(messages.length, 2); assert(messages.every(message => /암호화|DRM/.test(message)));
  });
  await checks('Cancelling stream preparation terminates the real worker and allows a new task', async () => {
    const message = await page.evaluate(async origin => {
      const offscreen = await import(window.__testAssetURL('local/offscreen.js')); const id = crypto.randomUUID();
      const pending = offscreen.prepareLocal(id, `${origin}/fixtures/hls/list.m3u8`, 'hls');
      const timeout = setTimeout(() => offscreen.cancelLocal(id), 50);
      try { await pending; return 'unexpected success'; } catch (error) { return error.message; }
      finally { clearTimeout(timeout); await offscreen.disposeLocal(id); }
    }, origin);
    assert.match(message, /취소|abort/i);
    await remux('hls/list.m3u8', 'hls', 'local-after-cancel.mp4');
  });
  await checks('Website collectors cannot invoke download/history commands or impersonate the app', async () => {
    const result = await page.evaluate(async () => {
      const background = await import(window.__testAssetURL('local/background.js')); const denied = [];
      for (const type of ['download-url', 'clear-history', 'upscale', 'retry', 'preparing-progress']) {
        try { await background.handleLocalMessage({ scope: 'my-video-app/local', type, url: location.origin + '/fixtures/clip.mp4' }, { id: chrome.runtime.id, url: 'https://website.example/page', tab: { id: 7 } }); denied.push(false); }
        catch { denied.push(true); }
      }
      try { await background.handleLocalMessage({ scope: 'my-video-app/local', type: 'capture', items: [] }, { id: 'other-extension', url: 'https://website.example/page', tab: { id: 7 } }); denied.push(false); }
      catch { denied.push(true); }
      return denied;
    });
    assert.deepEqual(result, [true, true, true, true, true, true]);
  });
  await checks('Media collector discovers DOM video sources without initiating downloads', async () => {
    await page.goto(buildPaths.url(origin, 'local/index.html'));
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('미디어'));
    await page.evaluate(origin => { const video = document.createElement('video'); video.preload = 'none'; video.src = `${origin}/fixtures/clip.mp4`; document.body.append(video); }, origin);
    await page.addScriptTag({ url: buildPaths.url(origin, 'local/collect.js') });
    const discovered = await page.evaluate(async () => { const background = await import(window.__testAssetURL('local/background.js')); return background.handleLocalMessage({ scope: 'my-video-app/local', type: 'list' }, { id: chrome.runtime.id, url: window.__testAssetURL('local/index.html') }); });
    assert.equal(discovered.items.length, 1); assert.match(discovered.items[0].url, /clip\.mp4$/);
    assert.equal(discovered.history.length, 0);
  });
  await checks('HTTP/3 observation metadata and partial-response totals preserve existing stream classification using API doubles', async () => {
    const result = await page.evaluate(async origin => {
      chrome.webRequest.onHeadersReceived.fire({ tabId: 7, statusCode: 200, url: `${origin}/no-extension`, responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl' }] });
      chrome.webRequest.onHeadersReceived.fire({ tabId: 7, statusCode: 206, url: `${origin}/fixtures/clip.mp4`, responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Length', value: '3' }, { name: 'Content-Range', value: 'bytes 2-4/1000' }] });
      await chrome.runtime.sendMessage({ scope: 'my-video-app/local', type: 'capture', items: [{ url: `${origin}/no-extension`, title: 'stream', fromElement: true }, { url: `${origin}/fixtures/clip.mp4`, observedTransport: 'h3', title: 'HTTP3 timing double', fromElement: true }] });
      return chrome.runtime.sendMessage({ scope: 'my-video-app/local', type: 'list' });
    }, origin);
    const stream = result.items.find(item => item.url.endsWith('/no-extension')); assert.equal(stream.kind, 'hls');
    const file = result.items.find(item => item.url.endsWith('/clip.mp4')); assert.equal(file.size, 1000); assert.equal(file.observedTransport, 'h3');
    await page.locator('#refresh').click(); await page.waitForFunction(() => document.querySelector('#media').textContent.includes('페이지 연결 HTTP/3'));
    await page.evaluate(() => chrome.tabs.onUpdated.fire(7, { status: 'loading' }, { active: true, url: location.origin + '/example-page' }));
  });
  await checks('Local app downloads detected MP4 byte-for-byte and records completion using API doubles', async () => {
    await page.goto(buildPaths.url(origin, 'local/index.html')); await page.waitForFunction(() => document.querySelector('#status').textContent.includes('미디어'));
    assert.equal(await page.title(), 'My Video App');
    await page.evaluate(async origin => { await chrome.runtime.sendMessage({ scope: 'my-video-app/local', type: 'capture', items: [{ url: `${origin}/fixtures/clip.mp4`, title: '로컬 테스트 영상', mime: 'video/mp4', fromElement: true }] }); }, origin);
    await page.locator('#refresh').click(); await page.waitForFunction(() => document.querySelectorAll('#media li').length === 1);
    await page.evaluate(() => { window.__duplicateCompletion = true; });
    const pending = page.waitForEvent('download'); await page.locator('#media button').click();
    const file = await pending; await file.saveAs(`${results}/local-direct.mp4`);
    assert.equal(createHash('sha256').update(await readFile(`${results}/local-direct.mp4`)).digest('hex'), originalHash);
    await waitForAsync(async () => (await window.__appGet('my_video_app_history_v1')).my_video_app_history_v1?.[0]?.state === 'complete');
    await page.locator('#history-tab').click(); await page.waitForFunction(() => document.querySelector('#history li')?.textContent.includes('완료'));
    assert.match(await page.locator('#history').innerText(), /로컬 테스트 영상\.mp4/);
    await waitForAsync(async () => (await window.__appGet('vdh_upscale_jobs_v1')).vdh_upscale_jobs_v1?.length === 1);
    assert.equal(await page.evaluate(async () => (await window.__appGet('vdh_upscale_jobs_v1')).vdh_upscale_jobs_v1.length), 1);
  });
  await checks('Polling reuses unchanged rows, restores focus on changed rows and leaves outside controls focused', async () => {
    await page.locator('#media-tab').click();
    await page.locator('#media li button').first().focus();
    const expected = await page.evaluate(() => { window.__focusedMediaAction = document.activeElement; window.__previousListReads = window.__listReads; return document.activeElement.closest('li').dataset.rowId; });
    await page.waitForFunction(() => window.__listReads > window.__previousListReads);
    assert.equal(await page.evaluate(() => document.activeElement === window.__focusedMediaAction && window.__focusedMediaAction.isConnected), true);
    await page.evaluate(async origin => chrome.runtime.sendMessage({ scope: 'my-video-app/local', type: 'capture', items: [{ url: `${origin}/fixtures/clip.mp4`, title: '갱신된 로컬 테스트 영상', mime: 'video/mp4', fromElement: true }] }), origin);
    await page.waitForFunction(() => !window.__focusedMediaAction.isConnected);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'download');
    assert.equal(await page.evaluate(() => document.activeElement.closest('li').dataset.rowId), expected);
    await page.locator('#quality').focus();
    await page.evaluate(() => { window.__oldMediaRow = document.querySelector('#media li'); window.__previousListReads = window.__listReads; });
    await page.waitForFunction(() => window.__listReads > window.__previousListReads);
    assert.equal(await page.evaluate(() => window.__oldMediaRow === document.querySelector('#media li') && window.__oldMediaRow.isConnected), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'quality');
  });
  await checks('Local download UI passes the chosen audio format through background and offscreen using API doubles', async () => {
    await page.locator('#media-tab').click();
    await page.locator('#download-output').selectOption('mp3'); await page.locator('#quality').selectOption('720');
    const pending = page.waitForEvent('download'); await page.locator('#media li button').first().click();
    const file = await pending; assert(file.suggestedFilename().endsWith('.mp3')); await file.saveAs(`${results}/local-ui-audio.mp3`);
    await waitForAsync(async () => (await window.__appGet('my_video_app_history_v1')).my_video_app_history_v1.some(row => row.filename.endsWith('.mp3') && row.state === 'complete'));
    assert(Math.abs(toneFrequency(`${results}/local-ui-audio.mp3`) - 440) < 10);
    await page.locator('#download-output').selectOption('original'); await page.locator('#quality').selectOption('highest');
  });
  await checks('Concurrent duplicate requests are coalesced and native cancellation updates history using API doubles', async () => {
    await page.evaluate(async () => { window.__holdDownloads = true; await window.__appSet({ vdh_upscale_offer_v1: false }); });
    const pending = page.waitForEvent('download');
    const result = await page.evaluate(async origin => {
      const background = await import(window.__testAssetURL('local/background.js'));
      const sender = { id: chrome.runtime.id, url: window.__testAssetURL('local/index.html') };
      const message = { scope: 'my-video-app/local', type: 'download-url', url: `${origin}/fixtures/clip.mp4` };
      return (await Promise.allSettled([background.handleLocalMessage(message, sender), background.handleLocalMessage(message, sender)])).map(item => item.status);
    }, origin);
    assert.deepEqual(result.sort(), ['fulfilled', 'rejected']);
    const saved = await pending; await saved.saveAs(`${results}/local-cancel-api-double.mp4`);
    await waitForAsync(async () => (await window.__appGet('my_video_app_history_v1')).my_video_app_history_v1.some(row => row.state === 'downloading'));
    const progress = await page.evaluate(async () => (await chrome.runtime.sendMessage({ scope: 'my-video-app/local', type: 'list' })).history.find(row => row.state === 'downloading'));
    assert.equal(progress.receivedBytes, 12); assert.equal(progress.totalBytes, 24);
    await page.locator('#history-tab').click(); await page.getByRole('button', { name: '취소', exact: true }).click();
    await waitForAsync(async () => (await window.__appGet('my_video_app_history_v1')).my_video_app_history_v1.some(row => row.state === 'cancelled'));
    await page.evaluate(async () => { window.__holdDownloads = false; await window.__appSet({ vdh_upscale_offer_v1: true }); });
  });
  await checks('History retry creates a new intact download and keeps the cancelled record using API doubles', async () => {
    await page.locator('#history-tab').click();
    const row = page.locator('#history li').filter({ hasText: '취소됨' });
    const pending = page.waitForEvent('download'); await row.getByRole('button', { name: '다시 시도' }).click();
    const file = await pending; await file.saveAs(`${results}/local-history-retry.mp4`);
    assert.equal(createHash('sha256').update(await readFile(`${results}/local-history-retry.mp4`)).digest('hex'), originalHash);
    await waitForAsync(async () => { const rows = (await window.__appGet('my_video_app_history_v1')).my_video_app_history_v1; return rows[0]?.state === 'complete' && rows.some(row => row.state === 'cancelled'); });
  });
  await checks('Cancellation while the offscreen document starts prevents the later media request using API doubles', async () => {
    const id = await page.evaluate(async origin => {
      const background = await import(window.__testAssetURL('local/background.js'));
      const originalHas = chrome.offscreen.hasDocument, originalCreate = chrome.offscreen.createDocument;
      let release, started;
      const gate = new Promise(resolve => { release = resolve; });
      const starting = new Promise(resolve => { started = resolve; });
      chrome.offscreen.hasDocument = async () => false;
      chrome.offscreen.createDocument = async options => { started(); await gate; await originalCreate(options); chrome.offscreen.hasDocument = originalHas; };
      const sender = { id: chrome.runtime.id, url: window.__testAssetURL('local/index.html') };
      try {
        const result = await background.handleLocalMessage({ scope: 'my-video-app/local', type: 'download-url', url: `${origin}/fixtures/clip.mp4?slow=startup-cancel`, options: { quality: 'highest', output: 'mp3' } }, sender);
        await starting;
        await background.handleLocalMessage({ scope: 'my-video-app/local', type: 'cancel', id: result.item.id }, sender);
        return result.item.id;
      } finally { release(); chrome.offscreen.createDocument = originalCreate; }
    }, origin);
    await waitForAsync(async id => (await window.__appGet('my_video_app_history_v1')).my_video_app_history_v1.find(row => row.id === id)?.state === 'cancelled', id);
    assert.equal(slowHits.get('startup-cancel'), undefined);
  });
  async function securityFixture(status, danger = 'safe') {
    return page.evaluate(async ({ status, danger }) => {
      window.__avStatus = status;
      const id = crypto.randomUUID(); const downloadId = 5000 + window.__testDownloads.size;
      window.__testDownloads.set(downloadId, { id: downloadId, state: 'complete', filename: '/test-downloads/review.mp4', danger, exists: true, fileSize: 12 });
      const data = (await window.__appGet('my_video_app_history_v1')).my_video_app_history_v1 || [];
      await window.__appSet({ my_video_app_history_v1: [{ id, downloadId, url: location.origin + '/fixtures/clip.mp4?review=' + id, filename: '검사 확인 영상.mp4', kind: 'file', state: 'downloading', createdAt: Date.now(), incognito: false }, ...data] });
      chrome.downloads.onChanged.fire({ id: downloadId, state: { current: 'complete' } });
      return { id, downloadId };
    }, { status, danger });
  }
  let reviewFixture;
  await checks('Infected verdict opens an explicit review dialog and renders untrusted threat names as text using API doubles', async () => {
    reviewFixture = await securityFixture('infected');
    await page.waitForFunction(() => document.querySelector('#security-dialog').open);
    assert.equal(await page.locator('#security-keep').isDisabled(), true);
    assert.equal(await page.locator('#security-dialog img').count(), 0);
    assert.match(await page.locator('#security-threats').innerText(), /<img src=x/);
    await page.screenshot({ path: `${results}/malware-review.png`, fullPage: true, animations: 'disabled' });
    await page.locator('#security-later').click();
    assert.equal(await page.locator('#security-dialog').evaluate(node => node.open), false);
    await page.locator('#history-tab').click();
    await page.getByRole('button', { name: '검사 결과 확인', exact: true }).click();
    assert.equal(await page.locator('#security-dialog').evaluate(node => node.open), true);
  });
  await checks('Delete failure preserves review and a later explicit deletion records success using API doubles', async () => {
    await page.evaluate(() => { window.__avDeleteFail = true; });
    await page.locator('#security-delete').click();
    await page.waitForFunction(() => document.querySelector('#security-dialog').open && !document.querySelector('#security-delete').disabled && document.querySelector('#security-details').textContent.includes('파일 삭제를 확인하지 못했습니다'));
    const row = await page.evaluate(async id => (await window.__appGet('my_video_app_history_v1')).my_video_app_history_v1.find(row => row.id === id), reviewFixture.id);
    assert.equal(row.state, 'review');
    await page.evaluate(() => { window.__avDeleteFail = false; });
    await page.locator('#security-delete').click();
    await waitForAsync(async id => (await window.__appGet('my_video_app_history_v1')).my_video_app_history_v1.find(row => row.id === id).state === 'discarded', reviewFixture.id);
    assert.equal(await page.evaluate(id => window.__testDownloads.get(id).exists, reviewFixture.downloadId), false);
    await page.waitForFunction(() => !document.querySelector('#security-dialog').open);
  });
  await checks('Unavailable local scanner remains unverified until the user explicitly acknowledges keeping the file', async () => {
    const fixture = await securityFixture('unavailable');
    await page.waitForFunction(() => document.querySelector('#security-dialog').open);
    assert.equal(await page.locator('#security-keep').isDisabled(), true);
    await page.locator('#security-acknowledge').check();
    await page.locator('#security-keep').click();
    await waitForAsync(async id => (await window.__appGet('my_video_app_history_v1')).my_video_app_history_v1.find(row => row.id === id).state === 'complete', fixture.id);
    const row = await page.evaluate(async id => (await window.__appGet('my_video_app_history_v1')).my_video_app_history_v1.find(row => row.id === id), fixture.id);
    assert.equal(row.security.status, 'unavailable'); assert.equal(row.security.decision, 'keep');
    await page.waitForFunction(() => !document.querySelector('#security-dialog').open);
  });
  await checks('Chrome danger offers browser review and cannot be overridden by the app keep control using API doubles', async () => {
    const fixture = await securityFixture('clean', 'content');
    await page.waitForFunction(() => document.querySelector('#security-dialog').open);
    assert.equal(await page.locator('#security-native-actions').isVisible(), false);
    assert.equal(await page.locator('#security-acknowledgement').isVisible(), false);
    await page.locator('#security-chrome').click();
    await page.waitForFunction(() => window.__lastCreatedTab?.url === 'chrome://downloads/');
    assert.equal(await page.evaluate(() => window.__lastCreatedTab.url), 'chrome://downloads/');
    await page.evaluate(id => { const item = window.__testDownloads.get(id); item.danger = 'accepted'; chrome.downloads.onChanged.fire({ id, danger: { current: 'accepted' } }); }, fixture.downloadId);
    await waitForAsync(async id => (await window.__appGet('my_video_app_history_v1')).my_video_app_history_v1.find(row => row.id === id).state === 'complete', fixture.id);
  });
  await checks('Local antivirus permission is requested only by the visible connect button using API doubles', async () => {
    await page.evaluate(() => { window.__avPermission = false; });
    await page.locator('#security-connect').click();
    await page.waitForFunction(() => !document.querySelector('#security-connect').disabled);
    assert.equal(await page.evaluate(() => window.__avPermission), true);
    assert.match(await page.locator('#security-connection-status').innerText(), /도우미 연결됨/);
    assert.equal(await page.evaluate(() => window.__avRequests.at(-1).action), 'status');
    await page.evaluate(() => { window.__avStatus = 'clean'; });
  });
  await checks('Missing antivirus helper is shown as unavailable rather than a successful connection', async () => {
    await page.evaluate(() => { window.__avHostMissing = true; });
    await page.locator('#security-connect').click();
    await page.waitForFunction(() => !document.querySelector('#security-connect').disabled);
    const text = await page.locator('#security-connection-status').innerText();
    assert.match(text, /설치되어 있지 않습니다/); assert.doesNotMatch(text, /도우미 연결됨/);
    await page.evaluate(() => { window.__avHostMissing = false; });
  });
  await checks('Clearing local history leaves downloaded files intact', async () => {
    await page.locator('#clear-history').click(); await page.waitForFunction(() => document.querySelectorAll('#history li').length === 0);
    assert.equal(createHash('sha256').update(await readFile(`${results}/local-direct.mp4`)).digest('hex'), originalHash);
  });
  await checks('Restart reconciliation releases interrupted preparation slots and cleans owned temp files using API doubles', async () => {
    const id = '12345678-1234-4123-8123-123456789abc';
    await page.evaluate(async ({ id, origin }) => {
      const file = await (await (await navigator.storage.getDirectory()).getFileHandle(`local-${id}.media`, { create: true })).createWritable();
      await file.write('temporary test input'); await file.close();
      await window.__appSet({ my_video_app_history_v1: [{ id, url: `${origin}/fixtures/clip.mp4`, filename: 'interrupted.mp4', kind: 'file', state: 'preparing', createdAt: Date.now(), incognito: false }] });
      chrome.runtime.onStartup.fire();
    }, { id, origin });
    await waitForAsync(async () => (await window.__appGet('my_video_app_history_v1')).my_video_app_history_v1[0]?.state === 'error');
    await waitForAsync(async id => { try { await (await navigator.storage.getDirectory()).getFileHandle(`local-${id}.media`); return false; } catch { return true; } }, id);
  });
  await checks('Validated download quality and output choices survive reopening the local app', async () => {
    await page.locator('#media-tab').click();
    await page.locator('#quality').selectOption('720'); await page.locator('#download-output').selectOption('mp3');
    await waitForAsync(async () => { const v = (await window.__appGet('my_video_app_download_options_v1')).my_video_app_download_options_v1; return v?.quality === '720' && v.output === 'mp3'; });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#quality').value === '720' && document.querySelector('#download-output').value === 'mp3');
  });
  async function immediatePreferenceDownload(kind, changeBeforeRestore = false) {
    await page.evaluate(async () => window.__appSet({ my_video_app_download_options_v1: { quality: '720', output: 'mp3' } }));
    const target = await context.newPage();
    try {
      await target.goto(buildPaths.url(origin, 'local/index.html?test-delay-preferences=1'));
      await target.waitForFunction(() => !!window.__releasePreferences);
      await target.evaluate(async origin => {
        const original = chrome.runtime.sendMessage.bind(chrome.runtime);
        window.__immediateDownloads = [];
        chrome.runtime.sendMessage = async message => {
          if (message.type === 'download' || message.type === 'download-url') {
            window.__immediateDownloads.push(structuredClone(message));
            return { ok: true };
          }
          return original(message);
        };
        await original({ scope: 'my-video-app/local', type: 'capture', items: [{ url: `${origin}/fixtures/clip.mp4`, title: 'Preference timing', mime: 'video/mp4', fromElement: true }] });
      }, origin);
      if (kind === 'download') {
        await target.locator('#refresh').click(); await target.waitForFunction(() => document.querySelectorAll('#media li').length === 1);
        await target.locator('#media li button').click();
      } else {
        await target.locator('summary').filter({ hasText: '미디어 주소 직접 입력' }).click();
        await target.locator('#url').fill(`${origin}/fixtures/clip.mp4`);
        await target.locator('#url-form button').click();
      }
      assert.equal(await target.evaluate(() => window.__immediateDownloads.length), 0, 'Download must wait for saved options to finish loading');
      if (changeBeforeRestore) {
        await target.locator('#quality').selectOption('480'); await target.locator('#download-output').selectOption('m4a');
      }
      await target.evaluate(() => window.__releasePreferences());
      await target.waitForFunction(() => window.__immediateDownloads.length === 1);
      const message = await target.evaluate(() => window.__immediateDownloads[0]);
      assert.equal(message.type, kind);
      assert.deepEqual(message.options, changeBeforeRestore ? { quality: '480', output: 'm4a' } : { quality: '720', output: 'mp3' });
    } finally { await target.close(); }
  }
  await checks('An immediate media-row download waits for saved quality and audio format using API doubles', () => immediatePreferenceDownload('download'));
  await checks('An immediate direct-URL download waits for saved quality and audio format using API doubles', () => immediatePreferenceDownload('download-url'));
  await checks('Choices changed while an immediate download waits take precedence over late saved options using API doubles', () => immediatePreferenceDownload('download', true));
  await checks('A late preferences restore never overwrites choices the user has already changed', async () => {
    const target = await context.newPage();
    try {
      await target.goto(buildPaths.url(origin, 'local/index.html?test-delay-preferences=1'));
      await target.waitForFunction(() => !!window.__releasePreferences);
      await target.locator('#quality').selectOption('480'); await target.locator('#download-output').selectOption('m4a');
      await target.evaluate(() => window.__releasePreferences());
      await target.waitForFunction(() => document.querySelector('#download-preferences-status').textContent.includes('저장했습니다'));
      assert.equal(await target.locator('#quality').inputValue(), '480'); assert.equal(await target.locator('#download-output').inputValue(), 'm4a');
      const stored = await page.evaluate(async () => (await window.__appGet('my_video_app_download_options_v1')).my_video_app_download_options_v1);
      assert.deepEqual(stored, { quality: '480', output: 'm4a' });
    } finally { await target.close(); }
  });
  await checks('Incognito choices neither read nor overwrite the stored normal-window preferences using API doubles', async () => {
    const target = await context.newPage();
    try {
      await target.goto(buildPaths.url(origin, 'local/index.html?test-incognito=1'));
      await target.waitForFunction(() => document.querySelector('#download-preferences-status').textContent.includes('시크릿'));
      assert.equal(await target.locator('#quality').inputValue(), 'highest'); assert.equal(await target.locator('#download-output').inputValue(), 'original');
      assert.equal(await target.evaluate(() => window.__prefsReads || 0), 0);
      await target.locator('#quality').selectOption('1080'); await target.locator('#download-output').selectOption('mp3');
      const stored = await page.evaluate(async () => (await window.__appGet('my_video_app_download_options_v1')).my_video_app_download_options_v1);
      assert.deepEqual(stored, { quality: '480', output: 'm4a' });
    } finally { await target.close(); }
    await page.locator('#quality').selectOption('highest'); await page.locator('#download-output').selectOption('original');
  });
  const misleadingMedia = [
    { alias: 'video.txt', source: 'clip.mp4', extension: 'mp4', mime: 'video/mp4' },
    { alias: 'disposition.txt', source: 'clip.mp4', extension: 'mp4', mime: 'video/mp4' },
    { alias: 'webm.txt', source: 'clip.webm', extension: 'webm', mime: 'video/webm' },
  ];
  async function assertExactPlayable(filename, source) {
    const saved = await readFile(filename), original = await readFile(`${fixtures}/${source}`);
    assert.equal(createHash('sha256').update(saved).digest('hex'), createHash('sha256').update(original).digest('hex'));
    const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', filename]));
    assert(probe.streams.some(stream => stream.codec_type === 'video'));
    assert(probe.streams.some(stream => stream.codec_type === 'audio'));
    command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', filename, '-f', 'null', '-']);
  }
  await checks('Prepared files ignore misleading text MIME and attachment names and save exact playable MP4/WebM', async () => {
    for (const fixture of misleadingMedia) {
      const prepared = await page.evaluate(async ({ url }) => {
        const module = await import(window.__testAssetURL('local/offscreen.js')), id = crypto.randomUUID();
        const result = await module.prepareLocal(id, url, 'file');
        return { id, ...result, blobType: (await (await fetch(result.url)).blob()).type };
      }, { url: `${origin}/fixtures/${fixture.alias}` });
      try {
        assert.equal(prepared.mime, fixture.mime); assert.equal(prepared.extension, fixture.extension); assert.equal(prepared.blobType, fixture.mime);
        const pending = page.waitForEvent('download');
        await page.evaluate(url => {
          const link = document.createElement('a'); link.href = url; link.download = ''; document.body.append(link); link.click(); link.remove();
        }, prepared.url);
        const download = await pending;
        assert(download.suggestedFilename().endsWith('.' + fixture.extension), download.suggestedFilename());
        assert(!download.suggestedFilename().endsWith('.txt'));
        const filename = `${results}/typed-${fixture.alias}.${fixture.extension}`; await download.saveAs(filename);
        assert.equal(await download.failure(), null); await assertExactPlayable(filename, fixture.source);
      } finally { await page.evaluate(async id => (await import(window.__testAssetURL('local/offscreen.js'))).disposeLocal(id), prepared.id); }
    }
  });
  await checks('Background downloads preserve playable media and canonical extensions with upscale disabled using API doubles', async () => {
    await page.evaluate(async () => {
      await window.__appSet({ vdh_upscale_offer_v1: false });
      window.__avStatus = 'clean'; window.__avHold = false; window.__avHostMissing = false;
      window.__downloadDanger = 'safe'; window.__holdDownloads = false;
    });
    try {
      for (const fixture of misleadingMedia) {
        const pending = page.waitForEvent('download');
        const reply = await page.evaluate(url => chrome.runtime.sendMessage({ scope: 'my-video-app/local', type: 'download-url', url, options: { quality: 'highest', output: 'original' } }), `${origin}/fixtures/${fixture.alias}?background=1`);
        assert.equal(reply.ok, true);
        const download = await pending;
        assert(download.suggestedFilename().endsWith('.' + fixture.extension), download.suggestedFilename());
        assert(!download.suggestedFilename().endsWith('.txt'));
        const filename = `${results}/background-${fixture.alias}.${fixture.extension}`; await download.saveAs(filename);
        assert.equal(await download.failure(), null); await assertExactPlayable(filename, fixture.source);
        await waitForAsync(async id => (await window.__appGet('my_video_app_history_v1')).my_video_app_history_v1.some(row => row.id === id && row.state === 'complete'), reply.item.id);
      }
    } finally { await page.evaluate(async () => window.__appSet({ vdh_upscale_offer_v1: true })); }
  });
  await checks('HTML, plain text and fake video MIME are rejected before the browser download API using real file bytes', async () => {
    for (const name of ['html.txt', 'plain.txt', 'spoofed.mp4']) {
      const direct = await page.evaluate(async url => {
        const module = await import(window.__testAssetURL('local/offscreen.js')), id = crypto.randomUUID();
        try { await module.prepareLocal(id, url, 'file'); return 'unexpected success'; }
        catch (error) { return error.message; }
        finally { await module.disposeLocal(id); }
      }, `${origin}/fixtures/${name}`);
      assert.match(direct, /실제 영상·오디오 파일/);
      const before = await page.evaluate(() => window.__testDownloads.size);
      const reply = await page.evaluate(url => chrome.runtime.sendMessage({ scope: 'my-video-app/local', type: 'download-url', url, options: { quality: 'highest', output: 'original' } }), `${origin}/fixtures/${name}?background=1`);
      assert.equal(reply.ok, true);
      await waitForAsync(async id => (await window.__appGet('my_video_app_history_v1')).my_video_app_history_v1.some(row => row.id === id && row.state === 'error'), reply.item.id, 10_000);
      assert.equal(await page.evaluate(() => window.__testDownloads.size), before);
    }
  });
  await checks('No outbound requests or page exceptions in new processing workflow', async () => {
    assert.deepEqual(outbound, []); assert.deepEqual(pageErrors, []); assert.deepEqual(legacyRuntimeRequests, []);
    for (const logical of ['local/background.js', 'local/collect.js', 'local/offscreen.js', 'local/ui.js', 'local/popup.js', 'local/stream-worker.js', 'hardening/upscale-worker.js', 'upscale/app.js', 'vendor/ffmpeg/ffmpeg-core.js', 'vendor/ffmpeg/ffmpeg-core.wasm']) {
      assert(productionAssets.has(buildPaths.resolve(logical)), `Production runtime was not exercised: ${logical}`);
    }
    const engineModule = buildInfo.protection?.engine?.coreModulePath;
    if (engineModule) assert(productionAssets.has(engineModule), 'The production engine module must execute');
  });
  await page.locator('#media-tab').click();
  await page.screenshot({ path: `${results}/local-app.png`, fullPage: true });
  await writeFile('reports/browser.json', JSON.stringify({ buildSha256: buildInfo.buildSha256, browser: browser.version(), engine: 'independent-local', mode: 'localhost harness: protected production assets; real browser/Wasm/OPFS; Chrome extension APIs mocked', extensionInstallation: { status: 'blocked', reason: 'Chromium administrator policy: Loading of unpacked extensions is disabled by the administrator. Verified separately; policy was not changed.' }, outcomes, productionAssets: [...productionAssets].sort(), legacyRuntimeRequests, directFixtureSha256: originalHash, outboundRequests: outbound, pageErrors }, null, 2) + '\n');
  console.log(`${outcomes.length} browser harness checks passed. Actual extension installation remains blocked by administrator policy.`);
} finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
