// Operate both extension builds through their actual popup and download form.
// Chrome APIs, background/offscreen workers and downloads are never replaced.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const variant = process.env.MY_VIDEO_APP_EXTENSION_VARIANT === 'standard' ? 'standard' : 'missav';
const output = path.join(root, '.cache/extension-ui-installed-browser', variant);
await mkdir(output, { recursive: true });
const command = (binary, args) => {
  const result = spawnSync(binary, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout;
};
const source = path.join(root, 'tests/fixtures/desktop-source.mp4');
const fragmentFile = path.join(output, 'clip.ts');
command('ffmpeg', ['-v', 'error', '-i', source, '-c', 'copy', '-f', 'mpegts', '-y', fragmentFile]);
const mp4 = await readFile(source), fragment = await readFile(fragmentFile);
const build = JSON.parse(await readFile(path.join(root, `reports/build-${variant}.json`)));
for (const [logical, stem] of [['local/background.js', 'background'], ['local/collect.js', 'collect']]) {
  assert.equal(build.entries.find(entry => entry.logicalOutput === logical)?.input,
    `src/local/${stem}${variant === 'standard' ? '-standard' : ''}.ts`, 'Test the requested build variant');
}
const checks = [], errors = [], downloads = [], traffic = [];
let deny = true, context, ui, popup, browserVersion, extensionId;
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  const status = deny && pathname.startsWith('/retry/') ? 403 : 200;
  traffic.push({ pathname, status });
  if (status === 403) { response.writeHead(403).end('Forbidden'); return; }
  if (pathname === '/page') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Owned extension UI video</title><video src="/detected.mp4" controls preload="metadata"></video>');
  } else if (pathname.endsWith('.m3u8')) {
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    response.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\nclip.ts\n#EXT-X-ENDLIST\n');
  } else if (pathname.endsWith('.ts') || pathname.endsWith('.mp4')) {
    const body = pathname.endsWith('.ts') ? fragment : mp4;
    response.writeHead(200, { 'Content-Type': pathname.endsWith('.ts') ? 'video/mp2t' : 'video/mp4', 'Content-Length': body.length });
    response.end(body);
  } else response.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(path.join(output, 'profile-'));
async function until(predicate, message) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const value = await predicate(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
try {
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    channel: 'chromium', headless: true, acceptDownloads: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--no-sandbox', `--disable-extensions-except=${path.join(root, 'extensions', variant)}`, `--load-extension=${path.join(root, 'extensions', variant)}`],
  });
  browserVersion = context.browser().version();
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.join(output, 'downloads'), eventsEnabled: true });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
  extensionId = new URL(worker.url()).hostname;
  const base = `chrome-extension://${extensionId}/`;
  ui = await context.newPage();
  await ui.addLocatorHandler(ui.locator('#security-dialog[open]'), async () => {
    await ui.locator('#security-later').click();
  });
  await ui.goto(base + build.assetMap['local/index.html']);
  await ui.locator('#download-folder-acknowledge').check();
  await ui.locator('#download-folder-confirm').click();
  await until(async () => (await ui.locator('#download-folder-status').textContent()).includes('최초 설정 확인을'), 'Folder confirmation UI did not save');
  // Read the genuine background state only for assertions; starts/retries use UI.
  const state = () => ui.evaluate(() => chrome.runtime.sendMessage({ scope: 'my-video-app/local', type: 'list' }));
  async function finished(url, expectedError = false, identity) {
    const row = await until(async () => (await state()).history?.find(item => item.url === url
      && (!identity || item.id === identity) && ['error', 'review', 'complete'].includes(item.state)), 'UI download did not finish');
    if (expectedError) { assert.equal(row.state, 'error'); assert.match(row.error, /403/); return row; }
    assert.notEqual(row.state, 'error', row.error);
    assert(Number.isInteger(row.downloadId));
    const download = await until(async () => {
      const item = await ui.evaluate(async id => (await chrome.downloads.search({ id }))[0], row.downloadId);
      return item?.state === 'complete' && item.exists ? item : undefined;
    }, 'Chrome did not save the file');
    const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', download.filename]));
    assert.deepEqual(new Set(probe.streams.map(stream => stream.codec_type)), new Set(['video', 'audio']));
    const digest = filename => command('ffmpeg', ['-v', 'error', '-i', filename, '-map', '0:v:0', '-f', 'hash', '-hash', 'sha256', '-']);
    assert.equal(digest(download.filename), digest(source));
    downloads.push({ state: download.state, bytes: download.fileSize, codecs: probe.streams.map(stream => stream.codec_name) });
    return row;
  }
  async function reloadUI() {
    await ui.reload();
    await ui.locator('#download-folder[aria-busy="false"]').waitFor();
    await until(async () => (await ui.locator('#status').textContent()) !== '미디어를 확인하고 있습니다…', 'Extension UI did not refresh');
  }
  async function enter(url) {
    await ui.locator('#media-tab').click();
    await ui.locator('details:has(#url-form) > summary').click();
    await ui.locator('#url').fill(url);
    await ui.locator('#url-form button[type="submit"]').click();
  }

  const page = await context.newPage(); await page.goto(origin + '/page');
  await until(async () => (await state()).items?.find(item => item.url === origin + '/detected.mp4'), 'Installed collector did not detect the video');
  popup = await context.newPage(); await popup.goto(base + build.assetMap['local/popup.html']);
  await popup.locator('#media [data-action="download"]').first().click();
  await finished(origin + '/detected.mp4');
  await popup.screenshot({ path: path.join(output, 'popup.png'), fullPage: true });
  checks.push('actual popup download button saves detected MP4 with identical video frames and audio');

  await reloadUI();
  await enter(origin + '/direct/list.m3u8');
  await finished(origin + '/direct/list.m3u8');
  checks.push('actual direct-address form saves a valid HLS MP4 with identical video frames and audio');

  await reloadUI();
  const retryURL = origin + '/retry/list.m3u8';
  await enter(retryURL);
  const failed = await finished(retryURL, true);
  const retry = ui.locator(`#history li[data-row-id="${failed.id}"] [data-action="retry"]`);
  await retry.waitFor(); deny = false; await retry.click();
  const retried = await until(async () => (await state()).history.find(item => item.url === retryURL && item.id !== failed.id),
    'Retry button did not create a new download attempt');
  await finished(retryURL, false, retried.id);
  await reloadUI(); await ui.locator('#history-tab').click();
  await ui.screenshot({ path: path.join(output, 'history.png'), fullPage: true });
  checks.push('actual HTTP 403 history card retry button saves the requested media');
  assert(traffic.some(item => item.status === 403));
  assert.deepEqual(errors, []);
  console.log(`${variant}: ${checks.length} installed-extension UI checks passed.`);
} catch (error) {
  errors.push(error.stack || String(error));
  await ui?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, 'VALIDATION.json'), JSON.stringify({ platform: process.platform, variant,
    buildSha256: build.buildSha256, browserVersion, extensionId, chromeAPIsMocked: false, startsAndRetriesUseUI: true,
    ownedMediaOnly: true, targetFullVideoVerified: false, checks, errors, downloads, traffic }, null, 2));
  await context?.close(); await rm(profile, { recursive: true, force: true });
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
