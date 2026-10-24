/** Real protected app/background and IndexedDB; Chrome APIs and media preparation
 * are explicit doubles. No physical Chrome preference or user folder is changed. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const KEY = 'my_video_app_download_folder_confirmed_v1';
const HISTORY = 'my_video_app_history_v1';

export async function verifyDownloadFolderAudit(browser, origin, buildPaths) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 850 } });
  const outcomes = [], pageErrors = [], outboundRequests = [];
  const check = async (name, run) => { await run(); outcomes.push({ name, status: 'passed' }); };
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(origin + '/') || url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
    outboundRequests.push(url); return route.abort();
  });
  await context.route(`${origin}/download-folder-audit.html*`, route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Download folder audit</title>',
  }));
  await context.addInitScript(({ assetMap, key }) => {
    const q = new URL(location.href).searchParams;
    const privateContext = q.has('private');
    const assetURL = name => {
      const cut = name.search(/[?#]/), base = cut < 0 ? name : name.slice(0, cut);
      return new URL((assetMap[base] ?? base) + (cut < 0 ? '' : name.slice(cut)), location.origin + '/').href;
    };
    const event = () => {
      const handlers = [];
      return { addListener(fn) { handlers.push(fn); }, removeListener(fn) { const index = handlers.indexOf(fn); if (index >= 0) handlers.splice(index, 1); },
        fire(...values) { for (const fn of [...handlers]) fn(...values); } };
    };
    const onMessage = event();
    const messages = [];
    onMessage.addListener = fn => messages.push(fn);
    const dispatch = (message, sender) => new Promise((resolve, reject) => {
      try {
        let accepted = false;
        for (const listener of messages) if (listener(message, sender, resolve) === true) accepted = true;
        if (!accepted) reject(Error('No production message listener accepted folder audit request'));
      } catch (error) { reject(error); }
    });
    window.__folderTabs = []; window.__folderDownloads = []; window.__folderPrepares = 0;
    window.__folderMediaRequests = []; window.__folderIdbOpens = 0; window.__folderIdbOperations = 0;
    window.__folderReadFault = q.has('read-fault'); window.__folderWriteFault = false;
    const nativeOpen = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => { window.__folderIdbOpens++; return nativeOpen(...args); };
    const get = IDBObjectStore.prototype.get, put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.get = function (name) {
      window.__folderIdbOperations++;
      if (this.name === 'settings' && name === key && window.__folderReadFault) throw new DOMException('Injected folder read failure', 'UnknownError');
      return get.call(this, name);
    };
    IDBObjectStore.prototype.put = function (value, ...args) {
      window.__folderIdbOperations++;
      if (this.name === 'settings' && value?.key === key && window.__folderWriteFault) throw new DOMException('Injected folder commit failure', 'QuotaExceededError');
      return put.call(this, value, ...args);
    };
    const fetch = window.fetch.bind(window);
    window.fetch = (...args) => {
      const url = String(args[0]?.url ?? args[0]);
      if (url.includes('/fixtures/clip.mp4') || url.includes('/fixtures/list.m3u8')) window.__folderMediaRequests.push(url);
      return fetch(...args);
    };
    const files = new Map();
    const api = {
      runtime: { id: 'folder-audit-extension', getURL: value => new URL(value.replace(/^\/+/, ''), location.origin + '/').href,
        onMessage, onInstalled: event(), onStartup: event(),
        sendMessage: async message => {
          if (message.scope === 'my-video-app/offscreen') {
            if (message.type !== 'prepare') return { ok: true };
            window.__folderPrepares++;
            const extension = message.options?.output === 'original' ? 'mp4' : message.options?.output ?? 'mp4';
            const mime = extension === 'mp3' ? 'audio/mpeg' : extension === 'm4a' ? 'audio/mp4' : 'video/mp4';
            return { ok: true, url: URL.createObjectURL(new Blob(['Harmless preparation API double'], { type: mime })), extension, mime };
          }
          await window.__folderBoot();
          const sender = message.type === 'capture'
            ? { id: api.runtime.id, url: location.origin + '/video-page', tab: { id: 7, incognito: privateContext } }
            : { id: api.runtime.id, url: assetURL('local/index.html'), tab: { incognito: privateContext } };
          return dispatch(message, sender);
        },
      },
      extension: { inIncognitoContext: privateContext },
      storage: { local: { get: async () => ({}), remove: async () => {}, set: async () => {} } },
      permissions: { contains: async () => false, request: async () => false },
      tabs: { create: async value => { window.__folderTabs.push(structuredClone(value)); return value; },
        query: async () => [{ id: 7, url: location.origin + '/video-page', active: true, incognito: privateContext }],
        get: async id => ({ id, url: location.origin + '/video-page', incognito: privateContext }),
        onRemoved: event(), onUpdated: event(), onActivated: event() },
      contextMenus: { onClicked: event(), create() {} }, commands: { onCommand: event() },
      webRequest: { onHeadersReceived: event() },
      notifications: { onClicked: event(), onButtonClicked: event(), create: async () => '', clear: async () => true },
      sidePanel: { setPanelBehavior: async () => {} }, action: { setPopup: async () => {} },
      offscreen: { Reason: { BLOBS: 'BLOBS', WORKERS: 'WORKERS', DOM_PARSER: 'DOM_PARSER' },
        hasDocument: async () => true, createDocument: async () => {} },
      downloads: { onChanged: event(), download: async options => {
        window.__folderDownloads.push(structuredClone(options));
        const id = files.size + 1;
        files.set(id, { id, state: 'in_progress', filename: '/test-downloads/' + options.filename,
          danger: 'safe', exists: true, bytesReceived: 0, totalBytes: 12 }); return id;
      }, search: async query => query.id === undefined ? [...files.values()] : [files.get(query.id)].filter(Boolean),
        cancel: async id => { files.delete(id); }, removeFile: async () => {}, showDefaultFolder: async () => {}, show() {} },
    };
    Object.defineProperty(window, 'chrome', { configurable: true, value: api });
    let boot;
    window.__folderBoot = () => boot ??= import(assetURL('local/background.js')).then(namespace => {
      if (Object.keys(namespace).length) throw Error('The production background must not expose test helpers');
    });
    window.__folderSend = async (type, values = {}, sender) => {
      const message = { scope: 'my-video-app/local', type, ...values };
      await window.__folderBoot();
      return sender ? dispatch(message, sender) : api.runtime.sendMessage(message);
    };
    window.__folderAppSet = async value => (await import('/fixtures/database-audit.js')).appStorage.set(value);
    window.__folderAppGet = async name => (await import('/fixtures/database-audit.js')).appStorage.get(name);
    window.__folderAssetURL = assetURL;
  }, { assetMap: buildPaths.assetMap, key: KEY });
  const pageFor = async (name = 'download-folder-audit.html') => {
    const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(name.startsWith('local/') ? buildPaths.url(origin, name) : `${origin}/${name}`);
    await page.evaluate(() => window.__folderBoot()); return page;
  };
  const call = (page, type, values = {}) => page.evaluate(({ type, values }) => window.__folderSend(type, values), { type, values });
  const set = (page, values) => page.evaluate(values => window.__folderAppSet(values), values);
  const counters = page => page.evaluate(() => ({ prepares: window.__folderPrepares, downloads: window.__folderDownloads.length, media: window.__folderMediaRequests.length }));
  const zero = { prepares: 0, downloads: 0, media: 0 };
  let page;
  try {
    page = await pageFor();
    await check('A fresh installation blocks first direct download before preparation, history and media requests', async () => {
      assert.equal((await call(page, 'download-folder-settings')).confirmed, false);
      const result = await call(page, 'download-url', { url: `${origin}/fixtures/clip.mp4?folder=first` });
      assert.equal(result.ok, true); assert.equal(result.setupRequired, true); assert.equal(result.item, undefined);
      const output = await call(page, 'prepare-output-save');
      assert.equal(output.ok, true); assert.equal(output.setupRequired, true);
      assert.deepEqual(await counters(page), zero);
      assert.deepEqual((await call(page, 'list')).history, []);
      assert.equal(await page.evaluate(() => window.__folderTabs.at(-1).url), buildPaths.url(origin, 'local/index.html?setup=downloads#download-folder'));
    });
    await check('Detected media, retry and the keyboard shortcut share the same first-folder guard', async () => {
      await call(page, 'capture', { items: [{ url: `${origin}/fixtures/clip.mp4?folder=discovered`, title: 'Folder gate clip', fromElement: true }] });
      const media = (await call(page, 'list')).items[0]; assert(media);
      const retry = { id: '22222222-2222-4222-8222-222222222222', url: `${origin}/fixtures/clip.mp4?folder=retry`,
        filename: 'retry.mp4', kind: 'file', state: 'cancelled', createdAt: Date.now(), incognito: false };
      await set(page, { [HISTORY]: [retry] });
      assert.equal((await call(page, 'download', { id: media.id })).setupRequired, true);
      assert.equal((await call(page, 'retry', { id: retry.id })).setupRequired, true);
      const before = await page.evaluate(() => window.__folderTabs.length);
      await page.evaluate(() => chrome.commands.onCommand.fire('default-action'));
      await page.waitForFunction(before => window.__folderTabs.length > before, before);
      assert.deepEqual(await counters(page), zero);
      assert.deepEqual((await call(page, 'list')).history, [retry]);
    });
    await check('Website and cross-mode senders cannot acknowledge or open folder settings', async () => {
      const denied = await page.evaluate(async () => {
        const results = [];
        for (const sender of [
          { id: chrome.runtime.id, url: location.origin + '/website', tab: { id: 7, incognito: false } },
          { id: 'another-extension', url: window.__folderAssetURL('local/index.html') },
          { id: chrome.runtime.id, url: window.__folderAssetURL('local/index.html'), tab: { incognito: true } },
        ]) for (const type of ['download-folder-settings', 'open-download-folder-settings', 'confirm-download-folder', 'prepare-output-save']) {
          results.push((await window.__folderSend(type, { confirmed: true }, sender)).ok === false);
        }
        return results;
      });
      assert.deepEqual(denied, Array(12).fill(true));
      assert.equal((await call(page, 'download-folder-settings')).confirmed, false);
      assert.equal((await call(page, 'confirm-download-folder', { confirmed: false })).ok, false);
      assert.equal((await call(page, 'confirm-download-folder')).ok, false);
    });
    await check('The folder change action opens only Chrome downloads settings without confirming setup', async () => {
      assert.equal((await call(page, 'open-download-folder-settings', { url: 'https://untrusted.invalid/', path: '/ignored/path' })).ok, true);
      assert.deepEqual(await page.evaluate(() => window.__folderTabs.at(-1)), { url: 'chrome://settings/downloads' });
      assert.equal((await call(page, 'download-folder-settings')).confirmed, false);
    });
    await check('Explicit confirmation commits to IndexedDB and survives page/service-worker recreation', async () => {
      assert.deepEqual(await call(page, 'confirm-download-folder', { confirmed: true }), { ok: true, confirmed: true });
      assert.equal((await page.evaluate(key => window.__folderAppGet(key), KEY))[KEY], true);
      await set(page, { [HISTORY]: [] });
      await page.reload(); await page.evaluate(() => window.__folderBoot());
      assert.equal((await call(page, 'download-folder-settings')).confirmed, true);
      assert.deepEqual(await call(page, 'prepare-output-save'), { ok: true, setupRequired: false });
    });
    await check('Confirmed original, stream and audio downloads request automatic save with collision-safe basenames', async () => {
      for (const [name, output] of [['clip.mp4', 'original'], ['list.m3u8', 'original'], ['clip.mp4', 'mp3'], ['clip.mp4', 'm4a']]) {
        const response = await call(page, 'download-url', { url: `${origin}/fixtures/${name}?folder=${output}-${name}`,
          options: { quality: 'highest', output } });
        assert.equal(response.ok, true); assert(response.item?.id); assert.equal(response.setupRequired, undefined);
      }
      await page.waitForFunction(() => window.__folderDownloads.length === 4);
      await page.waitForFunction(async historyKey => {
        const rows = (await window.__folderAppGet(historyKey))[historyKey];
        return rows.length === 4 && rows.every(row => row.state === 'downloading');
      }, HISTORY);
      const saved = await page.evaluate(() => window.__folderDownloads);
      assert(saved.every(options => options.saveAs === false && options.conflictAction === 'uniquify'));
      assert(saved.every(options => !/[\\/]/.test(options.filename) && !options.filename.includes('..')));
      assert.deepEqual(saved.map(options => options.filename.split('.').at(-1)).sort(), ['m4a', 'mp3', 'mp4', 'mp4']);
    });
    await check('Failed confirmation commit and failed settings reads cannot silently enable downloads', async () => {
      await set(page, { [KEY]: false, [HISTORY]: [] });
      await page.evaluate(() => { window.__folderWriteFault = true; });
      assert.equal((await call(page, 'confirm-download-folder', { confirmed: true })).ok, false);
      await page.evaluate(() => { window.__folderWriteFault = false; });
      assert.equal((await call(page, 'download-folder-settings')).confirmed, false);
      const before = await counters(page);
      await page.evaluate(() => { window.__folderReadFault = true; });
      assert.equal((await call(page, 'download-url', { url: `${origin}/fixtures/clip.mp4?folder=read-fault` })).ok, false);
      await page.evaluate(() => { window.__folderReadFault = false; });
      assert.deepEqual(await counters(page), before);
      assert.equal((await call(page, 'download-folder-settings')).confirmed, false);
    });
    await check('Private first-use acknowledgement remains in memory and never reads or writes the normal database', async () => {
      await set(page, { [KEY]: true, [HISTORY]: [] });
      const privatePage = await pageFor('download-folder-audit.html?private=1');
      try {
        assert.equal((await call(privatePage, 'download-folder-settings')).confirmed, false);
        assert.equal((await call(privatePage, 'download-url', { url: `${origin}/fixtures/clip.mp4?folder=private` })).setupRequired, true);
        assert.equal((await call(privatePage, 'confirm-download-folder', { confirmed: true })).confirmed, true);
        assert.equal((await call(privatePage, 'download-folder-settings')).confirmed, true);
        assert.deepEqual(await privatePage.evaluate(() => [window.__folderIdbOpens, window.__folderIdbOperations]), [0, 0]);
        await privatePage.reload(); await privatePage.evaluate(() => window.__folderBoot());
        assert.equal((await call(privatePage, 'download-folder-settings')).confirmed, false);
        assert.deepEqual(await privatePage.evaluate(() => [window.__folderIdbOpens, window.__folderIdbOperations]), [0, 0]);
        assert.equal((await call(page, 'download-folder-settings')).confirmed, true);
      } finally { await privatePage.close(); }
    });
    await set(page, { [KEY]: false, [HISTORY]: [] }); await page.close(); page = undefined;
    await check('First-use settings explain the actual Chrome folder and prevent false download-start UI', async () => {
      const app = await pageFor('local/index.html?setup=downloads#download-folder');
      try {
        await app.waitForFunction(() => !document.querySelector('#download-folder-acknowledge').disabled);
        assert.equal(await app.evaluate(() => document.activeElement?.id), 'download-folder');
        const instructions = await app.locator('#download-folder').innerText();
        assert.match(instructions, /절대경로/); assert.match(instructions, /다운로드 전에 각 파일의 저장 위치 확인/);
        assert.match(instructions, /Chrome/); assert.equal(await app.locator('#download-folder input[type=text]').count(), 0);
        assert(await app.locator('#download-folder-confirm').isDisabled());
        await app.screenshot({ path: 'test-results/download-folder-setup.png', fullPage: true });
        await app.locator('#download-folder-change').click();
        assert.equal(await app.evaluate(() => window.__folderTabs.at(-1).url), 'chrome://settings/downloads');
        await app.locator('summary').filter({ hasText: '미디어 주소 직접 입력' }).click();
        await app.locator('#url').fill(`${origin}/fixtures/clip.mp4?folder=ui-first`); await app.locator('#url-form button').click();
        await app.waitForFunction(() => document.querySelector('#status').textContent.includes('폴더'));
        assert.equal(await app.locator('#history-view').isHidden(), true);
        assert.doesNotMatch(await app.locator('#status').innerText(), /파일을 준비하고 있습니다|다운로드를 시작/);
        assert.deepEqual(await counters(app), zero);
        await app.locator('#download-folder-acknowledge').check(); await app.locator('#download-folder-confirm').click();
        await app.waitForFunction(() => document.querySelector('#download-folder-confirm').hidden);
        assert.equal((await call(app, 'download-folder-settings')).confirmed, true);
        assert.match(await app.locator('#download-folder-status').innerText(), /다시 다운로드|다시.*다운로드|다운로드.*다시/);
        await app.reload();
        await app.waitForFunction(() => document.querySelector('#download-folder-confirm').hidden);
        assert.equal(await app.locator('#download-folder-change').isEnabled(), true);
      } finally { await app.close(); }
    });
    await check('Folder settings UI exposes failed read/commit and recovers only after an authoritative reread', async () => {
      const app = await pageFor('local/index.html?read-fault=1');
      try {
        await app.locator('#download-folder-retry').waitFor();
        assert(await app.locator('#download-folder-acknowledge').isDisabled());
        assert(await app.locator('#download-folder-confirm').isDisabled());
        await app.evaluate(async key => { window.__folderReadFault = false; await window.__folderAppSet({ [key]: false }); }, KEY);
        await app.locator('#download-folder-retry').click();
        await app.waitForFunction(() => !document.querySelector('#download-folder-acknowledge').disabled);
        await app.locator('#download-folder-acknowledge').check();
        await app.evaluate(() => { window.__folderWriteFault = true; });
        await app.locator('#download-folder-confirm').click();
        await app.locator('#download-folder-retry').waitFor();
        assert(await app.locator('#download-folder-confirm').isDisabled());
        assert.match(await app.locator('#download-folder-status').innerText(), /저장 여부|저장.*확인하지 못/);
        await app.evaluate(() => { window.__folderWriteFault = false; });
        await app.locator('#download-folder-retry').click();
        await app.waitForFunction(() => !document.querySelector('#download-folder-acknowledge').disabled);
        assert.equal((await call(app, 'download-folder-settings')).confirmed, false);
        assert(await app.locator('#download-folder-confirm').isVisible());
      } finally { await app.close(); }
    });
    assert.deepEqual(pageErrors, []); assert.deepEqual(outboundRequests, []);
    const sourceSha256 = {};
    for (const filename of ['src/local/background.ts', 'src/local/download-folder.ts', 'src/data/database.ts', 'src/local/ui.ts', 'src/local/popup.ts', 'tests/download-folder-audit.mjs']) {
      sourceSha256[filename] = createHash('sha256').update(await readFile(filename)).digest('hex');
    }
    await writeFile('reports/download-folder.json', JSON.stringify({ buildSha256: buildPaths.buildInfo.buildSha256,
      browser: browser.version(), mode: 'protected production background/UI and real Chromium IndexedDB; Chrome extension APIs and media preparation are explicit doubles; no actual browser preference or filesystem destination changed',
      sourceSha256, outcomes, pageErrors, outboundRequests }, null, 2) + '\n');
    console.log(`PASS ${outcomes.length} download folder and automatic-save checks`);
    return outcomes;
  } finally { await page?.close(); await context.close(); }
}
