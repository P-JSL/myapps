// Real installed extension, runtime messages, content scripts, offscreen document,
// OPFS, FFmpeg workers and downloads. Only owned fixture HTTP responses are supplied.
import { chromium } from 'playwright-core';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.cache/missav-installed-browser');
await mkdir(output, { recursive: true });
const command = (binary, args) => {
  const value = spawnSync(binary, args, { encoding: 'utf8' });
  assert.equal(value.status, 0, value.stderr); return value.stdout;
};
const source = path.join(root, 'tests/fixtures/desktop-source.mp4');
const clipFile = path.join(output, 'clip.ts');
command('ffmpeg', ['-v', 'error', '-i', source, '-c', 'copy', '-f', 'mpegts', '-y', clipFile]);
const clip = await readFile(clipFile);
const build = JSON.parse(await readFile(path.join(root, 'reports/build.json')));
const version = JSON.parse(await readFile(path.join(root, 'package.json'))).version;
const profile = await mkdtemp(path.join(output, 'profile-'));
const requests = [], checks = [], errors = [], downloads = [];
const fixtures = new Map();
let context, browserVersion, extensionId, phase = 'setup';
try {
  const executablePath = process.env.CHROME_PATH;
  context = await chromium.launchPersistentContext(profile, {
    ...(executablePath ? { executablePath } : {}), channel: 'chromium', headless: true, acceptDownloads: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--no-sandbox', `--disable-extensions-except=${path.join(root, 'dist')}`, `--load-extension=${path.join(root, 'dist')}`],
  });
  browserVersion = context.browser().version();
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.join(output, 'downloads'), eventsEnabled: true });
  await context.route('https://missav123.com/**', async route => {
    const fixture = fixtures.get(new URL(route.request().url()).pathname.split('/').at(-1));
    assert(fixture);
    await route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Owned installed extension fixture</title><video controls></video><script>const source=${JSON.stringify(fixture.url)};fetch(source).then(r=>r.text()).catch(()=>{});</script>` });
  });
  await context.route('https://surrit.com/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const fixture = [...fixtures.values()].find(value => url.pathname.startsWith('/' + value.uuid + '/'));
    assert(fixture);
    const headers = await request.allHeaders();
    const allowed = headers.origin === 'https://missav123.com' && headers.referer === 'https://missav123.com/'
      && !fixture.fail && (url.pathname.endsWith('.ts') || request.url() === fixture.url);
    const status = allowed ? 200 : 403;
    requests.push({ phase, pathname: url.pathname, origin: headers.origin, referer: headers.referer, status });
    await route.fulfill({ status, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': url.pathname.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl' },
      body: allowed ? (url.pathname.endsWith('.ts') ? clip : '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\nclip.ts\n#EXT-X-ENDLIST\n') : 'Forbidden' });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
  extensionId = new URL(worker.url()).hostname;
  const base = `chrome-extension://${extensionId}/`;
  const ui = await context.newPage(); ui.on('pageerror', error => errors.push(error.message));
  await ui.goto(base + build.assetMap['local/index.html']);
  const request = (type, fields = {}) => ui.evaluate(({ type, fields }) => chrome.runtime.sendMessage({ scope: 'my-video-app/local', type, ...fields }), { type, fields });
  assert.equal((await request('confirm-download-folder', { confirmed: true })).ok, true);
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), version);

  async function openFixture(index, signed = false) {
    const slug = `owned-runtime-${index}`;
    const uuid = `a1b2c3d4-1234-5678-abcd-${String(index).padStart(12, '0')}`;
    const fixture = { uuid, url: `https://surrit.com/${uuid}/1080p/video.m3u8${signed ? '?sig=New%2FExact' : ''}`, fail: false };
    fixtures.set(slug, fixture);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    phase = 'source-' + index;
    await page.goto('https://missav123.com/ko/' + slug); await page.bringToFront();
    let media;
    for (let attempt = 0; attempt < 100; attempt++) {
      const list = await request('list'); media = list.items.find(item => item.url === fixture.url);
      if (media) break; await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(media, 'The real installed content script must detect its manifest');
    return { ...fixture, config: fixture, page, media };
  }
  async function start(type, fields) {
    const reply = await request(type, { options: { quality: 'highest', output: 'original' }, ...fields });
    assert.equal(reply.ok, true, reply.error); assert(reply.item);
    let row;
    for (let attempt = 0; attempt < 300; attempt++) {
      row = (await request('list')).history.find(item => item.id === reply.item.id);
      if (row && ['error', 'review', 'complete', 'cancelled'].includes(row.state)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(row && ['error', 'review', 'complete'].includes(row.state), 'Download must finish or fail within the test deadline');
    return row;
  }
  async function saved(row) {
    assert.notEqual(row.state, 'error', row.error);
    assert(Number.isInteger(row.downloadId));
    const download = await ui.evaluate(async id => (await chrome.downloads.search({ id }))[0], row.downloadId);
    assert.equal(download.state, 'complete'); assert.equal(download.exists, true);
    const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', download.filename]));
    assert.deepEqual(new Set(probe.streams.map(stream => stream.codec_type)), new Set(['video', 'audio']));
    const digest = filename => command('ffmpeg', ['-v', 'error', '-i', filename, '-map', '0:v:0', '-f', 'hash', '-hash', 'sha256', '-']);
    assert.equal(digest(download.filename), digest(source));
    downloads.push({ bytes: download.fileSize, state: download.state, codecs: probe.streams.map(stream => stream.codec_name) });
  }

  let fixture = await openFixture(1);
  phase = 'detected'; await saved(await start('download', { id: fixture.media.id }));
  checks.push('detected media uses the real page relay and saves valid MP4'); await fixture.page.close();

  fixture = await openFixture(2);
  phase = 'direct-input'; await saved(await start('download-url', { url: fixture.url }));
  checks.push('direct URL input recovers its original playing tab and saves valid MP4'); await fixture.page.close();

  fixture = await openFixture(3);
  phase = 'forced-403'; fixture.config.fail = true;
  const failed = await start('download', { id: fixture.media.id });
  assert.equal(failed.state, 'error'); assert.match(failed.error, /403/);
  fixture.config.fail = false; phase = 'retry';
  await saved(await start('retry', { id: failed.id }));
  checks.push('an actual HTTP 403 history item retries through its original page and saves valid MP4'); await fixture.page.close();

  fixture = await openFixture(4);
  const lookup = await worker.evaluate(async ({ tabId, url }) => await chrome.tabs.sendMessage(tabId,
    { scope: 'my-video-app/local', type: 'missav-context', url }, { frameId: 0 }), { tabId: fixture.media.tabId, url: fixture.url });
  assert.equal(lookup.ok, true); assert.equal(lookup.url, fixture.url);
  checks.push('the real content-script lookup channel identifies the same video for catalog recovery'); await fixture.page.close();

  fixture = await openFixture(5);
  await fixture.page.close(); phase = 'closed-source';
  const count = requests.length;
  const missing = await request('download-url', { url: fixture.url });
  assert.equal(missing.ok, false); assert.match(missing.error, /MissAV 탭/); assert.equal(requests.length, count);
  checks.push('closed source tabs fail with an actionable message before any media request');

  fixture = await openFixture(6, true);
  phase = 'fresh-signature';
  const stale = fixture.url.replace('New%2FExact', 'Expired%2FExact');
  await saved(await start('download-url', { url: stale }));
  checks.push('a stale signed URL is replaced by the intact currently observed URL'); await fixture.page.close();

  assert(requests.filter(value => value.status === 200).every(value => value.origin === 'https://missav123.com' && value.referer === 'https://missav123.com/'));
  assert.deepEqual(errors, []);
  console.log(`${checks.length} real installed-extension checks passed.`);
} finally {
  await writeFile(path.join(output, 'INSTALLED-EXTENSION-VALIDATION.json'), JSON.stringify({ version, buildSha256: build.buildSha256,
    browserVersion, extensionId, extensionInstalled: Boolean(extensionId), chromeAPIsMocked: false, targetFullVideoVerified: false,
    checks, errors, downloads, requests }, null, 2));
  await context?.close(); await rm(profile, { recursive: true, force: true });
}
