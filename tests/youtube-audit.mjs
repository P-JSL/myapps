/** Actual protected background/offscreen/Workers/Wasm/OPFS and local media bytes.
 * Chrome/native messaging and googlevideo responses are explicit test doubles.
 * No real YouTube extraction, account, cookie, PO token, or public-site access is claimed. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ID = 'AAAAAAAAAAA';
const PAGE = `https://www.youtube.com/watch?v=${ID}`;
const HISTORY = 'my_video_app_history_v1';
const FOLDER = 'my_video_app_download_folder_confirmed_v1';
const AV = 'my_video_app_antivirus_enabled_v1';
const FIXTURES = ['video-mp4', 'audio-mp4', 'video-webm', 'audio-webm', 'video-av1'];
const fixtureName = name => `youtube-${name}.${name.endsWith('webm') ? 'webm' : name === 'audio-mp4' ? 'm4a' : 'mp4'}`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function command(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `${binary}: ${result.stderr?.slice(-1800)}`);
  return result.stdout;
}
function streamHash(filename, kind) {
  return command('ffmpeg', ['-v', 'error', '-i', filename, '-map', `0:${kind}:0`, '-c', 'copy', '-f', 'streamhash', '-hash', 'sha256', '-']).trim();
}
function assertPreservedStreams(filename, video, audio) {
  assert.equal(streamHash(filename, 'v'), streamHash(path.join('test-results/fixtures', fixtureName(video)), 'v'));
  assert.equal(streamHash(filename, 'a'), streamHash(path.join('test-results/fixtures', fixtureName(audio)), 'a'));
}

export async function prepareYouTubeAuditFixtures(fixtures) {
  await mkdir(fixtures, { recursive: true });
  const clip = path.join(fixtures, 'clip.mp4');
  const base = ['-hide_banner', '-loglevel', 'error', '-i', clip];
  for (const [name, args] of [
    ['video-mp4', ['-map', '0:v:0', '-an', '-c:v', 'copy']],
    ['audio-mp4', ['-map', '0:a:0', '-vn', '-c:a', 'copy']],
    ['video-webm', ['-map', '0:v:0', '-an', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '0', '-crf', '40']],
    ['audio-webm', ['-map', '0:a:0', '-vn', '-c:a', 'libopus', '-b:a', '64k']],
    ['video-av1', ['-map', '0:v:0', '-an', '-c:v', 'libaom-av1', '-cpu-used', '8', '-crf', '45', '-threads', '2']],
  ]) command('ffmpeg', [...base, ...args, '-y', path.join(fixtures, fixtureName(name))]);
}

export async function verifyYouTubeAudit(browser, origin, buildPaths) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 950 }, acceptDownloads: true });
  const outcomes = [], pageErrors = [], outboundRequests = [], mediaRequests = [];
  const fixtureBytes = new Map(await Promise.all(FIXTURES.map(async name => [name, await readFile(path.join('test-results/fixtures', fixtureName(name)))])));
  const check = async (name, run) => { await run(); outcomes.push({ name, status: 'passed' }); };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
    if (url.protocol !== 'https:' || url.hostname !== 'rr1---sn-audit.googlevideo.com' || url.pathname !== '/videoplayback') {
      outboundRequests.push(request.url()); return route.abort();
    }
    const headers = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'range,if-match', 'access-control-expose-headers': 'content-length,content-range,etag,accept-ranges',
      'cache-control': 'no-store', 'accept-ranges': 'bytes' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...headers, 'access-control-allow-methods': 'GET,OPTIONS' } });
    const name = url.searchParams.get('track'), bytes = fixtureBytes.get(name);
    mediaRequests.push({ track: name, epoch: url.searchParams.get('epoch'), expired: url.searchParams.has('expired'), range: request.headers().range ?? null });
    if (!bytes || url.searchParams.has('expired')) return route.fulfill({ status: 403, headers, body: 'Expired synthetic media URL' });
    const contentType = name.startsWith('audio') ? name.endsWith('webm') ? 'audio/webm' : 'audio/mp4' : name.endsWith('webm') ? 'video/webm' : 'video/mp4';
    const range = request.headers().range;
    if (range) {
      const match = range.match(/^bytes=(\d+)-(\d+)$/); assert(match, range);
      const start = Number(match[1]), end = Math.min(Number(match[2]), bytes.length - 1);
      assert(start <= end && start >= 0);
      const body = bytes.subarray(start, end + 1);
      return route.fulfill({ status: 206, headers: { ...headers, 'content-type': contentType, 'content-length': String(body.length),
        'content-range': `bytes ${start}-${end}/${bytes.length}`, etag: `"${digest(bytes)}"` }, body });
    }
    return route.fulfill({ status: 200, headers: { ...headers, 'content-type': contentType,
      'content-length': String(bytes.length), etag: `"${digest(bytes)}"` }, body: bytes });
  });
  await context.route(`${origin}/youtube-audit.html*`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>YouTube audit</title>' }));
  await context.addInitScript(({ assetMap, pageURL }) => {
    const privateContext = new URL(location.href).searchParams.has('private');
    const assetURL = value => {
      const split = value.search(/[?#]/), name = split < 0 ? value : value.slice(0, split);
      return new URL((assetMap[name] ?? name) + (split < 0 ? '' : value.slice(split)), location.origin + '/').href;
    };
    const events = () => { const handlers = []; return {
      addListener(fn) { handlers.push(fn); }, removeListener(fn) { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1); },
      fire(...args) { for (const fn of [...handlers]) fn(...args); },
    }; };
    const handlers = [];
    const dispatch = (message, sender) => new Promise((resolve, reject) => {
      let accepted = false, replied = false;
      const reply = value => { if (!replied) { replied = true; resolve(value); } };
      try { for (const handler of [...handlers]) if (handler(message, sender, reply) === true) accepted = true;
        if (!accepted && !replied) reject(Error('No production listener accepted YouTube audit message'));
      } catch (error) { reject(error); }
    });
    window.__ytRequests = []; window.__ytDownloads = []; window.__ytTabs = []; window.__ytMessages = [];
    window.__ytPermission = true; window.__ytPermissionGrant = true; window.__ytPermissions = 0;
    window.__ytMode = 'mp4'; window.__ytEpoch = 0; window.__ytClosed = 0; window.__ytAvConnections = 0; window.__ytIdbOpens = 0;
    const idbOpen = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => { window.__ytIdbOpens++; return idbOpen(...args); };
    const files = new Map(), blobs = new Map(); let sequence = 0;
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); blobs.set(url, blob); return url; };
    URL.revokeObjectURL = url => { blobs.delete(url); revoke(url); };
    let background, offscreen;
    window.__ytBoot = () => background ??= import(assetURL('local/background.js')).then(namespace => {
      if (Object.keys(namespace).length) throw Error('Production background exports test APIs');
    });
    const api = {
      extension: { inIncognitoContext: privateContext },
      permissions: { contains: async () => window.__ytPermission,
        request: async () => { window.__ytPermissions++; window.__ytPermission = window.__ytPermissionGrant; return window.__ytPermission; } },
      storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
      runtime: { id: 'youtube-audit-extension', getURL: value => new URL(value.replace(/^\/+/, ''), location.origin + '/').href,
        onInstalled: events(), onStartup: events(), onMessage: { addListener(fn) { handlers.push(fn); }, removeListener(fn) { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1); } },
        connectNative(host) {
          if (host !== 'com.myvideoapp.youtube') { window.__ytAvConnections++; throw Error('No AV native port expected when AV integration is OFF'); }
          if (window.__ytHostMissing) throw Error('Specified native messaging host not found');
          const port = { onMessage: events(), onDisconnect: events(), disconnect() { window.__ytClosed++; }, postMessage(request) {
            window.__ytRequests.push(structuredClone(request));
            const respond = () => {
              if (request.action === 'status') return port.onMessage.fire({ version: 1, requestId: request.requestId, status: 'ready',
                ytDlpVersion: '2026.10.21', runtime: 'Deno 2.9.8', message: 'Explicit native test double; no actual YouTube extraction.' });
              const epoch = ++window.__ytEpoch;
              const direct = name => `https://rr1---sn-audit.googlevideo.com/videoplayback?track=${name}&epoch=${epoch}${window.__ytExpired ? '&expired=1' : ''}`;
              const track = (name, kind, mime, formatId) => ({ url: direct(name), kind, mime, formatId, ...(kind === 'video' ? { height: 90 } : {}) });
              let tracks;
              if (request.output !== 'original') tracks = [track('audio-mp4', 'audio', 'audio/mp4', '140')];
              else if (window.__ytMode === 'webm') tracks = [track('video-webm', 'video', 'video/webm', '248'), track('audio-webm', 'audio', 'audio/webm', '251')];
              else if (window.__ytMode === 'mixed') tracks = [track('video-mp4', 'video', 'video/mp4', '137'), track('audio-webm', 'audio', 'audio/webm', '251')];
              else if (window.__ytMode === 'av1') tracks = [track('video-av1', 'video', 'video/mp4', '399'), track('audio-mp4', 'audio', 'audio/mp4', '140')];
              else if (window.__ytMode === 'false-audio') tracks = [track('video-mp4', 'video', 'video/mp4', '137'),
                { ...track('video-mp4', 'audio', 'audio/mp4', '140'), url: direct('video-mp4') + '&role=audio' }];
              else if (window.__ytMode === 'false-combined') tracks = [track('video-mp4', 'combined', 'video/mp4', '18')];
              else tracks = [track('video-mp4', 'video', 'video/mp4', '137'), track('audio-mp4', 'audio', 'audio/mp4', '140')];
              const response = { version: 1, requestId: request.requestId, status: 'resolved', videoId: 'AAAAAAAAAAA',
                title: '<img src=x onerror=alert(1)> YouTube fixture', duration: 1, tracks };
              if (window.__ytBadSource) response.videoId = 'BBBBBBBBBBB';
              if (window.__ytBadURL) response.tracks[0].url = 'https://untrusted.invalid/private-media';
              port.onMessage.fire(response);
            };
            if (request.action === 'resolve' && window.__ytHold) window.__ytRelease = respond;
            else queueMicrotask(respond);
          } };
          return port;
        },
        sendMessage: async message => {
          window.__ytMessages.push(structuredClone(message));
          const isOffscreen = message.scope === 'my-video-app/offscreen';
          if (isOffscreen) await (offscreen ??= import(assetURL('local/offscreen.js')));
          else await window.__ytBoot();
          const sender = { id: api.runtime.id, url: assetURL(isOffscreen ? 'local/background.js' : message.type === 'preparing-progress' ? 'local/offscreen.html' : 'local/index.html') };
          if (!isOffscreen && message.type !== 'preparing-progress') sender.tab = { incognito: privateContext };
          return dispatch(message, sender);
        },
      },
      tabs: { create: async value => { window.__ytTabs.push(value); return value; },
        query: async () => [{ id: 7, url: pageURL, title: 'YouTube fixture page', active: true, incognito: privateContext }],
        get: async id => ({ id, url: pageURL, title: 'YouTube fixture page', active: true, incognito: privateContext }),
        sendMessage: async () => ({ ok: true }), onRemoved: events(), onUpdated: events(), onActivated: events() },
      webRequest: { onHeadersReceived: events() }, commands: { onCommand: events() }, contextMenus: { onClicked: events(), create() {} },
      notifications: { onClicked: events(), onButtonClicked: events(), clear: async () => true, create: async () => '' },
      offscreen: { Reason: { BLOBS: 'BLOBS', WORKERS: 'WORKERS', DOM_PARSER: 'DOM_PARSER' }, hasDocument: async () => true, createDocument: async () => {} },
      sidePanel: { setPanelBehavior: async () => {} }, action: { setPopup: async () => {} },
      downloads: { onChanged: events(), download: async options => {
        if (!blobs.has(options.url)) throw Error('YouTube output must be a prepared app-owned blob');
        if (options.saveAs !== false || options.conflictAction !== 'uniquify') throw Error('YouTube must preserve automatic collision-safe saving');
        const bytes = await blobs.get(options.url).arrayBuffer();
        const id = ++sequence;
        files.set(id, { id, state: 'complete', filename: '/youtube-audit-downloads/' + options.filename,
          danger: 'safe', exists: true, fileSize: bytes.byteLength, bytesReceived: bytes.byteLength, totalBytes: bytes.byteLength, incognito: privateContext });
        window.__ytDownloads.push(structuredClone(options));
        const a = document.createElement('a'); a.href = options.url; a.download = options.filename; document.body.append(a); a.click(); a.remove();
        return id;
      }, search: async query => query.id === undefined ? [...files.values()] : [files.get(query.id)].filter(Boolean),
        cancel: async id => { const file = files.get(id); if (file) { file.state = 'interrupted'; file.error = 'USER_CANCELED'; } },
        removeFile: async id => { const file = files.get(id); if (file) file.exists = false; }, show() {}, showDefaultFolder: async () => {} },
    };
    Object.defineProperty(window, 'chrome', { configurable: true, value: api });
    window.__ytSend = async (type, values = {}, sender) => {
      await window.__ytBoot(); const message = { scope: 'my-video-app/local', type, ...values };
      return sender ? dispatch(message, sender) : api.runtime.sendMessage(message);
    };
    window.__ytSet = async values => (await import('/fixtures/database-audit.js')).appStorage.set(values);
    window.__ytGet = async key => (await import('/fixtures/database-audit.js')).appStorage.get(key);
    window.__ytAssetURL = assetURL;
  }, { assetMap: buildPaths.assetMap, pageURL: PAGE });
  let page;
  const pages = new Set();
  const open = async (logical = 'youtube-audit.html') => {
    const p = await context.newPage(); pages.add(p); p.on('pageerror', error => pageErrors.push(error.message));
    await p.goto(logical.startsWith('local/') ? buildPaths.url(origin, logical) : `${origin}/${logical}`);
    await p.evaluate(() => window.__ytBoot()); return p;
  };
  const call = (p, type, values = {}) => p.evaluate(({ type, values }) => window.__ytSend(type, values), { type, values });
  const history = async p => (await call(p, 'list')).history;
  const untilRow = async (p, id, state) => {
    const deadline = Date.now() + 45_000;
    for (;;) {
      const row = (await history(p)).find(item => item.id === id);
      if (row?.state === state) return row;
      assert(Date.now() < deadline, `YouTube task did not reach ${state}: ${JSON.stringify(row)}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const save = async (p, name, { output = 'original', quality = 'highest', retry } = {}) => {
    const pending = p.waitForEvent('download', { timeout: 45_000 });
    const result = retry ? await call(p, 'retry', { id: retry }) : await call(p, 'download-url', { url: `https://youtu.be/${ID}?si=tracking`, options: { quality, output } });
    assert.equal(result.ok, true); assert(result.item?.id, JSON.stringify(result));
    const download = await pending;
    const filename = path.join('test-results', `youtube-${name}.${download.suggestedFilename().split('.').at(-1)}`);
    await download.saveAs(filename); assert.equal(await download.failure(), null);
    const row = await untilRow(p, result.item.id, 'complete');
    assert.equal(row.url, PAGE); assert.equal(row.kind, 'youtube'); assert.equal(row.security.status, 'disabled');
    assert.equal(row.internalScan.status, 'no-signals'); assert.match(row.internalScanSha256, /^[a-f0-9]{64}$/);
    const bytes = await readFile(filename); assert.equal(digest(bytes), row.internalScanSha256); assert.equal(bytes.length, row.internalScanSize);
    const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename]));
    return { result, row, filename, probe, download };
  };
  try {
    page = await open();
    await check('Current YouTube page discovery and first-folder gate perform no extraction or media requests', async () => {
      const list = await call(page, 'list'); assert(list.items.some(item => item.kind === 'youtube' && item.url === PAGE));
      const before = mediaRequests.length;
      const result = await call(page, 'download-url', { url: PAGE });
      assert.equal(result.setupRequired, true);
      assert.deepEqual(await page.evaluate(() => [window.__ytRequests.length, window.__ytDownloads.length]), [0, 0]);
      assert.equal(mediaRequests.length, before); assert.deepEqual((await call(page, 'list')).history, []);
      assert.match(await page.evaluate(() => window.__ytTabs.at(-1).url), /setup=downloads/);
      await page.evaluate(async ({ folder, av }) => window.__ytSet({ [folder]: true, [av]: false }), { folder: FOLDER, av: AV });
    });
    await check('Permission denial and missing helper fail explicitly before any media transfer', async () => {
      const before = mediaRequests.length;
      await page.evaluate(() => { window.__ytPermission = false; });
      const denied = await call(page, 'download-url', { url: PAGE });
      if (denied.item) await untilRow(page, denied.item.id, 'error'); else assert.equal(denied.ok, false);
      await page.evaluate(() => { window.__ytPermission = true; window.__ytHostMissing = true; });
      const missing = await call(page, 'download-url', { url: PAGE });
      if (missing.item) await untilRow(page, missing.item.id, 'error'); else assert.equal(missing.ok, false);
      await page.evaluate(() => { window.__ytHostMissing = false; });
      assert.equal(mediaRequests.length, before); assert.equal(await page.evaluate(() => window.__ytDownloads.length), 0);
    });
    await check('Separate H264 and AAC tracks remux to real MP4 and retain internal scan and automatic save', async () => {
      const result = await save(page, 'mp4');
      assert.match(result.filename, /\.mp4$/);
      assert.deepEqual(result.probe.streams.map(stream => stream.codec_name), ['h264', 'aac']);
      assert.equal(result.probe.streams[0].width, 160); assert.equal(result.probe.streams[0].height, 90);
      assertPreservedStreams(result.filename, 'video-mp4', 'audio-mp4');
      const requested = await page.evaluate(() => window.__ytRequests.filter(request => request.action === 'resolve').at(-1));
      assert.equal(requested.url, PAGE); assert.equal(requested.quality, 'highest'); assert.equal(requested.output, 'original');
      assert.equal(await page.evaluate(() => window.__ytAvConnections), 0);
    });
    await check('VP9 and Opus tracks preserve their original codecs in a real WebM output', async () => {
      await page.evaluate(() => { window.__ytMode = 'webm'; });
      const result = await save(page, 'webm');
      assert.match(result.filename, /\.webm$/); assert.deepEqual(result.probe.streams.map(stream => stream.codec_name), ['vp9', 'opus']);
      assert.equal(result.probe.streams[0].width, 160);
      assertPreservedStreams(result.filename, 'video-webm', 'audio-webm');
    });
    await check('Mixed MP4 and WebM tracks use Matroska without discarding the original audio or video', async () => {
      await page.evaluate(() => { window.__ytMode = 'mixed'; });
      const result = await save(page, 'mixed');
      assert.match(result.filename, /\.mkv$/); assert.deepEqual(result.probe.streams.map(stream => stream.codec_name), ['h264', 'opus']);
      assertPreservedStreams(result.filename, 'video-mp4', 'audio-webm');
    });
    await check('AV1 and AAC tracks remux without silently converting the video to a lower format', async () => {
      await page.evaluate(() => { window.__ytMode = 'av1'; });
      const result = await save(page, 'av1');
      assert.match(result.filename, /\.mp4$/); assert.deepEqual(result.probe.streams.map(stream => stream.codec_name), ['av1', 'aac']);
      assertPreservedStreams(result.filename, 'video-av1', 'audio-mp4');
    });
    await check('YouTube audio output creates playable MP3 and M4A from the selected audio track', async () => {
      for (const [output, codec] of [['mp3', 'mp3'], ['m4a', 'aac']]) {
        const result = await save(page, output, { output, quality: '720' });
        assert.match(result.filename, new RegExp(`\\.${output}$`));
        assert.deepEqual(result.probe.streams.map(stream => stream.codec_name), [codec]);
        assert(Number(result.probe.format.duration) >= 0.9 && Number(result.probe.format.duration) < 1.3);
        const requested = await page.evaluate(() => window.__ytRequests.filter(request => request.action === 'resolve').at(-1));
        assert.equal(requested.output, output); assert.equal(requested.quality, '720');
      }
    });
    await check('Promised audio missing from separate or combined tracks cannot silently produce a video-only download', async () => {
      const saved = await page.evaluate(() => window.__ytDownloads.length);
      for (const mode of ['false-audio', 'false-combined']) {
        await page.evaluate(value => { window.__ytMode = value; }, mode);
        const result = await call(page, 'download-url', { url: PAGE });
        assert.equal(result.ok, true); assert(result.item?.id);
        const row = await untilRow(page, result.item.id, 'error');
        assert.match(row.error, /합칠 수 없습니다/);
        assert.equal(await page.evaluate(() => window.__ytDownloads.length), saved);
      }
      await page.evaluate(() => { window.__ytMode = 'mp4'; });
    });
    await check('Source-mismatched native metadata and non-googlevideo URLs cannot reach the media downloader', async () => {
      const before = mediaRequests.length, saved = await page.evaluate(() => window.__ytDownloads.length);
      for (const fault of ['__ytBadSource', '__ytBadURL']) {
        await page.evaluate(name => { window[name] = true; }, fault);
        const result = await call(page, 'download-url', { url: PAGE });
        if (result.item) await untilRow(page, result.item.id, 'error'); else assert.equal(result.ok, false);
        await page.evaluate(name => { window[name] = false; }, fault);
      }
      assert.equal(mediaRequests.length, before); assert.equal(await page.evaluate(() => window.__ytDownloads.length), saved);
      const hostile = await page.evaluate(pageURL => window.__ytSend('download-url', { url: pageURL },
        { id: chrome.runtime.id, url: location.origin + '/hostile-site', tab: { id: 7, incognito: false } }), PAGE);
      assert.equal(hostile.ok, false);
    });
    await check('Cancelling an unresolved YouTube task disconnects its native port and ignores a late response', async () => {
      await page.evaluate(() => { window.__ytHold = true; });
      const before = mediaRequests.length, closed = await page.evaluate(() => window.__ytClosed);
      const result = await call(page, 'download-url', { url: PAGE }); assert(result.item?.id);
      await page.waitForFunction(() => typeof window.__ytRelease === 'function');
      await call(page, 'cancel', { id: result.item.id });
      await untilRow(page, result.item.id, 'cancelled');
      assert(await page.evaluate(value => window.__ytClosed > value, closed));
      await page.evaluate(() => { window.__ytHold = false; window.__ytRelease(); });
      await page.waitForTimeout(60); assert.equal(mediaRequests.length, before);
    });
    await check('Expired signed URLs fail clearly and retry resolves fresh URLs while history keeps only the canonical page', async () => {
      await page.evaluate(() => { window.__ytExpired = true; window.__ytMode = 'mp4'; });
      const failed = await call(page, 'download-url', { url: PAGE });
      const row = await untilRow(page, failed.item.id, 'error'); assert.match(row.error, /403|만료|요청|다운로드/);
      const count = await page.evaluate(() => window.__ytRequests.filter(request => request.action === 'resolve').length);
      await page.evaluate(() => { window.__ytExpired = false; });
      await save(page, 'retry', { retry: failed.item.id });
      assert.equal(await page.evaluate(() => window.__ytRequests.filter(request => request.action === 'resolve').length), count + 1);
      assert(!JSON.stringify(await history(page)).includes('googlevideo.com'));
    });
    await check('YouTube settings and popup connect explicitly without enabling antivirus or auto-extracting', async () => {
      const app = await open('local/index.html?setup=youtube');
      try {
        await app.waitForFunction(() => document.querySelector('#youtube-connect'));
        assert.equal(await app.evaluate(() => window.__ytRequests.length), 0);
        assert.match(await app.locator('#youtube-connection').innerText(), /YouTube|유튜브/);
        await app.evaluate(() => { window.__ytPermissionGrant = false; });
        await app.locator('#youtube-connect').click();
        await app.waitForFunction(() => document.querySelector('#youtube-connection-status').textContent.includes('권한'));
        assert.equal(await app.evaluate(() => window.__ytRequests.length), 0);
        await app.evaluate(() => { window.__ytPermissionGrant = true; });
        await app.locator('#youtube-connect').click();
        await app.waitForFunction(() => document.querySelector('#youtube-connection-status').dataset.tone === 'ready');
        assert.equal(await app.evaluate(() => window.__ytAvConnections), 0);
        assert.equal((await app.evaluate(key => window.__ytGet(key), AV))[AV], false);
        await app.screenshot({ path: 'test-results/youtube-settings.png', fullPage: true });
      } finally { await app.close(); }
      const popup = await open('local/popup.html');
      try {
        await popup.locator('.media-title').first().waitFor();
        assert.match(await popup.locator('.media-detail').first().innerText(), /YouTube/);
        await popup.evaluate(() => { window.__ytPermissionGrant = false; });
        await popup.locator('[data-action=download]').first().click();
        await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('권한'));
        assert.equal(await popup.evaluate(() => window.__ytRequests.length), 0);
      } finally { await popup.close(); }
    });
    await check('Private YouTube discovery and helper readiness never open the normal IndexedDB', async () => {
      const p = await open('youtube-audit.html?private=1');
      try {
        const list = await call(p, 'list'); assert(list.items.some(item => item.kind === 'youtube'));
        assert.equal((await call(p, 'download-url', { url: PAGE })).setupRequired, true);
        await call(p, 'confirm-download-folder', { confirmed: true });
        const ready = await call(p, 'youtube-connect'); assert.equal(ready.ok, true); assert.equal(ready.youtube.status, 'ready');
        assert.equal(await p.evaluate(() => window.__ytIdbOpens), 0);
        assert.equal((await page.evaluate(key => window.__ytGet(key), AV))[AV], false);
      } finally { await p.close(); }
    });
    assert.deepEqual(pageErrors, []); assert.deepEqual(outboundRequests, []);
    const sourceSha256 = {};
    for (const file of ['src/local/youtube.ts', 'src/local/background.ts', 'src/local/offscreen.ts', 'src/local/large-stream-worker.ts', 'src/local/stream-worker.ts', 'tests/youtube-audit.mjs']) sourceSha256[file] = digest(await readFile(file));
    await writeFile('reports/youtube.json', JSON.stringify({ buildSha256: buildPaths.buildInfo.buildSha256,
      browser: browser.version(), mode: 'Protected production background, offscreen, Workers, Wasm, IndexedDB and OPFS with real locally generated H264/AAC/VP9/Opus/AV1 media. Chrome APIs, native extraction and googlevideo responses are explicit doubles. Real YouTube access, signatures, PO-token handling and installed-extension behavior not validated.',
      sourceSha256, outcomes, mediaRequests, fixtureSha256: Object.fromEntries([...fixtureBytes].map(([name, bytes]) => [name, digest(bytes)])), pageErrors, outboundRequests }, null, 2) + '\n');
    console.log(`PASS ${outcomes.length} YouTube browser and media checks`);
    return outcomes;
  } finally { for (const p of pages) if (!p.isClosed()) await p.close(); await context.close(); }
}
