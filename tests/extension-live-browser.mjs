// Explicitly invoked live URL verification. No routes, response fixtures, or
// Chrome API replacements. Only a diagnostic JSON is retained, never media.
import { chromium } from 'playwright-core';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';

const pageURL = process.env.MYVIDEOAPP_LIVE_PAGE_URL;
const mediaURL = process.env.MYVIDEOAPP_LIVE_MEDIA_URL;
assert(pageURL && mediaURL, 'Explicit page and media URLs are required');
assert.equal(new URL(pageURL).protocol, 'https:');
assert.equal(new URL(mediaURL).protocol, 'https:');
const root = process.cwd(), output = path.join(root, 'artifacts/live-windows-verification');
const work = path.join(root, '.cache/live-extension-verification');
await mkdir(output, { recursive: true }); await mkdir(work, { recursive: true });
const profile = await mkdtemp(path.join(work, 'profile-'));
const downloadDirectory = await mkdtemp(path.join(work, 'downloads-'));
const build = JSON.parse(await readFile(path.join(root, 'reports/build.json')));
const media = new URL(mediaURL), mediaPrefix = media.pathname.split('/').slice(0, 2).join('/') + '/';
const result = { platform: process.platform, buildSha256: build.buildSha256, chromeAPIsMocked: false,
  responsesMocked: false, pageHost: new URL(pageURL).hostname, mediaHost: media.hostname,
  manifestProbeForDiscovery: false, fullVideoVerified: false, mediaResponses: { ok: 0, failed: 0 }, events: [] };
let context, ui, failed = false;
const save = () => writeFile(path.join(output, 'LIVE-VALIDATION.json'), JSON.stringify(result, null, 2));
const command = (binary, args) => {
  const response = spawnSync(binary, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
  assert.equal(response.status, 0, `${binary} failed`); return response.stdout;
};
async function until(predicate, message, milliseconds = 30_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await predicate(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(message);
}
try {
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    channel: 'chromium', headless: process.platform !== 'win32', acceptDownloads: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--no-sandbox', `--disable-extensions-except=${path.join(root, 'dist')}`, `--load-extension=${path.join(root, 'dist')}`],
  });
  result.browserVersion = context.browser().version();
  context.on('response', response => {
    const url = new URL(response.url());
    if (url.hostname === media.hostname && url.pathname.startsWith(mediaPrefix)) {
      if (response.status() >= 200 && response.status() < 300) result.mediaResponses.ok++;
      else result.mediaResponses.failed++;
      if (url.pathname.endsWith('.m3u8')) void response.request().allHeaders().then(headers => {
        result.manifestRequests ??= [];
        result.manifestRequests.push({ status: response.status(), origin: headers.origin,
          refererOrigin: headers.referer ? new URL(headers.referer).origin : null,
          fetchSite: headers['sec-fetch-site'] });
      }).catch(() => {});
    }
  });
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory, eventsEnabled: true });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const base = `chrome-extension://${new URL(worker.url()).hostname}/`;
  ui = await context.newPage(); await ui.goto(base + build.assetMap['local/index.html']);
  await ui.addLocatorHandler(ui.locator('#security-dialog[open]'), async () => ui.locator('#security-later').click());
  await ui.locator('#download-folder-acknowledge').check(); await ui.locator('#download-folder-confirm').click();
  await until(async () => (await ui.locator('#download-folder-status').textContent()).includes('최초 설정 확인을'), 'Folder settings did not save');
  const state = () => ui.evaluate(() => chrome.runtime.sendMessage({ scope: 'my-video-app/local', type: 'list' }));
  const page = await context.newPage();
  const response = await page.goto(pageURL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  result.pageStatus = response?.status();
  await new Promise(resolve => setTimeout(resolve, 5000));
  result.pageChallenge = await page.evaluate(() => /cf-chl-|challenge-platform|just a moment/i.test(document.documentElement.outerHTML));
  result.pageSummary = await page.evaluate(id => ({ origin: location.origin,
    challengeTitle: /just a moment|attention required|checking your browser/i.test(document.title),
    challengeForm: !!document.querySelector('#challenge-running, #challenge-stage, form#challenge-form'),
    htmlCharacters: document.documentElement.outerHTML.length,
    videoElements: document.querySelectorAll('video').length,
    requestedIdInPage: document.documentElement.outerHTML.includes(id),
    pageReferrerPolicy: document.querySelector('meta[name="referrer"]')?.content,
  }), media.pathname.split('/')[1]);
  // First test ordinary discovery from the real page as it currently exists.
  let found;
  try {
    found = await until(async () => (await state()).items?.find(item => {
      const url = new URL(item.url); return url.hostname === media.hostname && url.pathname.startsWith(mediaPrefix);
    }), 'No matching media discovered on the original page', 10_000);
  } catch {
    result.events.push('Original page did not expose the requested media to the installed collector');
  }
  // A user-supplied manifest can be probed from the existing source tab. This
  // makes a real request with browser-managed Origin/Referer and records the
  // genuine resource timing entry. It does not solve a Cloudflare challenge or
  // replace a page/player response, and is reported separately from discovery.
  result.manifestProbeForDiscovery = !found;
  const manifest = await page.evaluate(async address => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(address, { signal: controller.signal,
        referrer: location.origin + '/', referrerPolicy: 'origin' });
      const text = await response.text();
      return { status: response.status, hls: text.trimStart().startsWith('#EXTM3U'),
        vod: text.includes('#EXT-X-ENDLIST'), encrypted: /#EXT-X-KEY:(?!METHOD=NONE)/.test(text),
        segments: (text.match(/^#EXTINF:/gm) || []).length,
        durationSeconds: [...text.matchAll(/^#EXTINF:([0-9.]+)/gm)].reduce((sum, match) => sum + Number(match[1]), 0) };
    } catch (error) { return { errorType: error.name }; }
    finally { clearTimeout(timer); }
  }, mediaURL);
  result.manifest = manifest; await save();
  assert.equal(manifest.status, 200, 'Live manifest request failed in the real source tab');
  assert(manifest.hls && manifest.vod && !manifest.encrypted, 'Live source is not an unencrypted HLS VOD');
  found = await until(async () => (await state()).items?.find(item => item.url === mediaURL), 'Real manifest request was not detected by the installed extension');
  if (process.env.MYVIDEOAPP_LIVE_PROBE_ONLY === '1') {
    result.events.push('Probe-only run: full extension download was not attempted');
  } else {
    const existing = new Set((await state()).history.map(item => item.id));
    await ui.locator('details:has(#url-form) > summary').click();
    await ui.locator('#url').fill(mediaURL); await ui.locator('#url-form button[type="submit"]').click();
    const job = await until(async () => (await state()).history.find(item => !existing.has(item.id)), 'Real direct-address form did not create a job');
    result.jobStarted = true;
    const deadline = Date.now() + 24 * 60_000;
    let row, lastLog = 0;
    while (Date.now() < deadline) {
      row = (await state()).history.find(item => item.id === job.id);
      if (Date.now() - lastLog > 10_000) {
        result.lastProgress = { state: row?.state, receivedBytes: row?.receivedBytes,
          totalBytes: row?.totalBytes, mediaResponses: { ...result.mediaResponses } };
        console.log(JSON.stringify(result.lastProgress)); await save(); lastLog = Date.now();
      }
      if (row && ['error', 'cancelled', 'review', 'complete'].includes(row.state)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    result.jobState = row?.state;
    if (row?.error) result.downloadError = row.error.replace(/https?:\/\/\S+/g, '[URL]');
    assert(row && ['review', 'complete'].includes(row.state), result.downloadError || 'Live full download did not complete before the deadline');
    const download = await until(async () => {
      const value = await ui.evaluate(async id => (await chrome.downloads.search({ id }))[0], row.downloadId);
      return value?.state === 'complete' && value.exists ? value : undefined;
    }, 'Chrome did not finish saving the full file', 120_000);
    const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height', '-of', 'json', download.filename]));
    assert(probe.streams.some(stream => stream.codec_type === 'video') && probe.streams.some(stream => stream.codec_type === 'audio'));
    const duration = Number(probe.format.duration);
    assert(Math.abs(duration - manifest.durationSeconds) < 3, 'Saved duration does not match the full live playlist');
    for (const position of ['0', String(Math.max(0, duration - 2))]) {
      command('ffmpeg', ['-v', 'error', '-ss', position, '-i', download.filename, '-t', '1', '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
    }
    result.savedMedia = { bytes: download.fileSize, ...probe };
    result.fullVideoVerified = true;
    console.log('Live full video saved; duration, video/audio and beginning/end decode passed.');
  }
} catch (error) {
  failed = true;
  // Keep query strings, page HTML, media titles, and video frames out of artifacts.
  result.failure = { type: error.name, message: String(error.message).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 1200) };
  console.error(JSON.stringify(result.failure));
} finally {
  await save(); await context?.close();
  await rm(profile, { recursive: true, force: true });
  await rm(downloadDirectory, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
