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
import { testOriginalWorker } from './original-worker.mjs';

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
await writeFile(`${fixtures}/malicious.mp4`, '<html><script>fetch("https://invalid.example/upload")</script></html>');
const originalHash = createHash('sha256').update(await readFile(`${fixtures}/clip.mp4`)).digest('hex');

const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png', '.mp4': 'video/mp4', '.json': 'application/json' };
const server = createServer(async (request, response) => {
  try {
    const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (name.includes('..') || name.includes('\\')) { response.writeHead(403).end(); return; }
    const target = name.startsWith('/fixtures/') ? path.join(fixtures, name.slice('/fixtures/'.length)) : path.join(root, 'dist', name);
    const bytes = await readFile(target);
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
  const listeners = () => ({ addListener() {}, removeListener() {} });
  const storageKey = 'VDH_TEST_CHROME_STORAGE';
  const read = () => JSON.parse(localStorage.getItem(storageKey) ?? '{}');
  const api = {
    runtime: { id: 'test-double-only', getURL: path => `${location.origin}/${path.replace(/^\//, '')}`, onInstalled: listeners(), onStartup: listeners() },
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
    tabs: { create: async options => options },
    downloads: { download: async options => {
      const link = document.createElement('a'); link.href = options.url; link.download = options.filename; document.body.append(link); link.click(); link.remove(); return 1;
    } },
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
try {
  await checks('Built UI loads with CSP; actual FFmpeg Worker assets available', async () => {
    await openTools(); assert.equal(await page.title(), '업스케일링 · Video Download Helper');
    assert.equal(await page.locator('#start').isDisabled(), true);
    assert.equal(await (await context.request.get(`${origin}/vendor/ffmpeg/ffmpeg-core.wasm`)).status(), 200);
  });
  await checks('Unchanged original download worker preserves every MP4 byte', async () => {
    const result = await testOriginalWorker(page, `${origin}/fixtures/clip.mp4`, originalHash);
    await writeFile(`${results}/original-worker.json`, JSON.stringify(result, null, 2) + '\n');
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
  await checks('No outbound requests or page exceptions in new processing workflow', async () => { assert.deepEqual(outbound, []); assert.deepEqual(pageErrors, []); });
  await page.screenshot({ path: `${results}/upscaler.png`, fullPage: true });
  const buildInfo = JSON.parse(await readFile('reports/build.json', 'utf8'));
  await writeFile('reports/browser.json', JSON.stringify({ buildSha256: buildInfo.buildSha256, browser: browser.version(), mode: 'localhost harness: real browser/Wasm/OPFS; Chrome extension APIs mocked', extensionInstallation: { status: 'blocked', reason: 'Chromium administrator policy: Loading of unpacked extensions is disabled by the administrator. Verified separately; policy was not changed.' }, outcomes, originalFixtureSha256: originalHash, outboundRequests: outbound, pageErrors }, null, 2) + '\n');
  console.log(`${outcomes.length} browser harness checks passed. Actual extension installation remains blocked by administrator policy.`);
} finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
