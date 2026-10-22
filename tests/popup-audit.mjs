import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { loadBuildPaths } from './build-paths.mjs';
export async function verifyPopupAudit(browser, origin, buildPaths) {
  buildPaths ??= await loadBuildPaths();
  const context = await browser.newContext({ viewport: { width: 640, height: 600 } });
  const outcomes = [], outboundRequests = [], pageErrors = [];
  const productionAssets = new Set();
  context.on('request', request => {
    const name = new URL(request.url()).pathname.slice(1);
    if (Object.values(buildPaths.assetMap).includes(name)) productionAssets.add(name);
  });
  await context.route('**' + '/' + '*', route => {
    const url = route.request().url();
    if (url.startsWith(origin + '/') || url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
    outboundRequests.push(url); return route.abort();
  });
  await context.route(`${origin}/popup-seed.html`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Seed</title>' }));
  await context.addInitScript(() => {
    const q = new URL(location.href).searchParams;
    const media = { id: '11111111-1111-4111-8111-111111111111', tabId: 7, url: 'https://media.invalid/clip.mp4',
      title: '<img src=x onerror=alert(1)> 안전한 제목', mime: 'video/mp4', kind: 'file', createdAt: Date.now() };
    window.__popupState = { items: q.has('media') ? [media] : [], history: q.has('review') ? [{
      id: '22222222-2222-4222-8222-222222222222', url: media.url, filename: 'clip.mp4', kind: 'file',
      state: 'review', createdAt: Date.now(), incognito: false, options: { quality: '720', output: 'mp3' },
      internalScan: { version: 1, engine: 'builtin-static-v1', status: 'suspicious', complete: true, scannedBytes: 12, findings: [{ id: 'embedded-pe', severity: 'high', message: '실행 파일 구조 위험 신호', offset: 0 }] },
    }] : [] };
    window.__popupMessages = []; window.__popupTabs = []; window.__popupFolders = 0;
    window.__popupOpens = 0; window.__popupPreferenceReads = 0;
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => { window.__popupOpens++; return open(...args); };
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      if (this.name === 'settings' && key === 'my_video_app_download_options_v1') {
        window.__popupPreferenceReads++;
        if (q.has('delay')) {
          const tx = this.transaction, complete = tx.oncomplete;
          tx.oncomplete = event => { window.__releasePopupPreferences = () => complete?.call(tx, event); };
        }
      }
      return get.call(this, key);
    };
    Object.defineProperty(window, 'chrome', { configurable: true, value: {
      extension: { inIncognitoContext: q.has('private') },
      storage: { local: { get: async () => ({}), remove: async () => {}, set: async () => {} } },
      runtime: {
        id: 'popup-audit-extension', getURL: value => new URL(value.replace(/^\/+/, ''), location.origin + '/').href,
        sendMessage: async message => {
          window.__popupMessages.push(structuredClone(message));
          if (window.__popupFail === message.type) return { ok: false, error: '검사 오류: 다시 시도하세요.' };
          if (message.type === 'list' || message.type === 'rescan') return { ok: true, ...structuredClone(window.__popupState) };
          if (message.type === 'clear-history') window.__popupState.history = [];
          return { ok: true };
        },
      },
      tabs: { create: async value => { window.__popupTabs.push(value); return { id: 99, ...value }; } },
      downloads: { showDefaultFolder: async () => { window.__popupFolders++; } },
    } });
  });
  const pageFor = async suffix => {
    const p = await context.newPage(); p.on('pageerror', e => pageErrors.push(e.message));
    await p.goto(buildPaths.url(origin, `local/popup.html${suffix}`));
    assert.equal(p.url(), buildPaths.url(origin, `local/popup.html${suffix}`));
    await p.waitForFunction(() => window.__popupMessages.some(m => m.type === 'list')); return p;
  };
  const check = async (name, run) => { await run(); outcomes.push({ name, status: 'passed' }); };
  try {
    const seed = await context.newPage(); await seed.goto(`${origin}/popup-seed.html`);
    await seed.evaluate(async () => {
      const { appStorage } = await import('/fixtures/database-audit.js');
      await appStorage.set({ my_video_app_download_options_v1: { quality: '720', output: 'mp3' } }); await appStorage.close();
    }); await seed.close();
    await check('Dark popup and settings, history, folder, help, rescan and tools actions', async () => {
      const p = await pageFor('');
      try {
        await p.locator('#waiting').waitFor(); assert.match(await p.locator('#waiting').innerText(), /미디어 대기 중/);
        assert.deepEqual(await p.evaluate(() => [document.body.offsetWidth, document.body.offsetHeight,
          getComputedStyle(document.documentElement).backgroundColor]), [640, 600, 'rgb(16, 20, 25)']);
        assert.equal(await p.locator('.brand-name').innerText(), 'My Video App');
        assert.equal(await p.locator('.tab-indicator').innerText(), '현재 탭');
        assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('footer button, #rescan, #report')].map(button => {
          const r = button.getBoundingClientRect();
          return r.width >= 40 && r.height >= 30 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
        })), Array(8).fill(true));
        assert(await p.evaluate(() => document.documentElement.scrollHeight <= innerHeight));
        await p.locator('#settings').focus(); await p.keyboard.press('Tab');
        assert.equal(await p.evaluate(() => document.activeElement?.id), 'history');
        assert.equal(await p.locator('#history').evaluate(button => getComputedStyle(button).outlineWidth), '2px');
        await p.screenshot({ path: 'test-results/popup-empty.png' });
        await p.locator('#settings').click(); await p.locator('#history').click();
        assert.deepEqual(await p.evaluate(() => window.__popupTabs.map(x => x.url)),
          [buildPaths.url(origin, 'local/index.html'), buildPaths.url(origin, 'local/index.html?view=history')]);
        await p.locator('#folder').click(); assert.equal(await p.evaluate(() => window.__popupFolders), 1);
        await p.locator('#help').click(); await p.locator('#info-dialog').waitFor();
        assert.match(await p.locator('#info-description').innerText(), /강제 감지/); await p.keyboard.press('Escape');
        await p.locator('#report').click(); await p.locator('#report-notes').fill('개인 메모'); await p.locator('#info-close').click();
        await p.locator('#upscale').click(); await p.locator('#rescan').click();
        await p.waitForFunction(() => window.__popupMessages.some(m => m.type === 'rescan'));
        const types = await p.evaluate(() => window.__popupMessages.map(m => m.type));
        assert(types.includes('upscale')); assert(types.every(t => ['list', 'upscale', 'rescan'].includes(t)));
        await p.locator('#dismiss-hint').click(); assert(await p.locator('#discovery-card').isHidden());
      } finally { await p.close(); }
    });
    await check('Media titles remain literal text and review rows open history', async () => {
      const p = await pageFor('?media=1&review=1');
      try {
        await p.locator('.media-title').waitFor();
        assert.equal(await p.locator('.media-title').innerText(), '<img src=x onerror=alert(1)> 안전한 제목');
        assert.equal(await p.locator('.media-title img').count(), 0);
        assert.equal(await p.locator('.media-marker svg').count(), 1);
        assert.equal(await p.locator('[data-action=download]').getAttribute('aria-label'), '<img src=x onerror=alert(1)> 안전한 제목 처리 중');
        await p.locator('#review-summary').waitFor(); assert(await p.locator('[data-action=download]').isDisabled());
        assert.match(await p.locator('#review-summary').innerText(), /내부.*위험.*1/);
        await p.screenshot({ path: 'test-results/popup-media.png' }); await p.locator('#review-summary').click();
        assert.equal(await p.evaluate(() => window.__popupTabs.at(-1).url), buildPaths.url(origin, 'local/index.html?view=history'));
        await p.locator('#clear-history').click();
        await p.waitForFunction(() => document.querySelector('#status').textContent.includes('저장한 파일'));
      } finally { await p.close(); }
    });
    await check('Download waits for real IndexedDB saved preferences', async () => {
      const p = await pageFor('?media=1&delay=1');
      try {
        await p.waitForFunction(() => !!window.__releasePopupPreferences);
        assert(await p.locator('[data-action=download]').isDisabled());
        assert.equal(await p.evaluate(() => window.__popupMessages.filter(m => m.type === 'download').length), 0);
        await p.evaluate(() => window.__releasePopupPreferences());
        await p.waitForFunction(() => !document.querySelector('[data-action=download]').disabled);
        await p.locator('[data-action=download]').click();
        await p.waitForFunction(() => window.__popupMessages.some(m => m.type === 'download'));
        assert.deepEqual(await p.evaluate(() => window.__popupMessages.find(m => m.type === 'download').options), { quality: '720', output: 'mp3' });
        assert.equal(await p.evaluate(() => window.__popupPreferenceReads), 1);
      } finally { await p.close(); }
    });
    await check('Private popup uses defaults without IndexedDB', async () => {
      const p = await pageFor('?media=1&private=1');
      try {
        await p.waitForFunction(() => !document.querySelector('[data-action=download]').disabled);
        await p.locator('[data-action=download]').click();
        await p.waitForFunction(() => window.__popupMessages.some(m => m.type === 'download'));
        assert.deepEqual(await p.evaluate(() => window.__popupMessages.find(m => m.type === 'download').options), { quality: 'highest', output: 'original' });
        assert.deepEqual(await p.evaluate(() => [window.__popupOpens, window.__popupPreferenceReads]), [0, 0]);
      } finally { await p.close(); }
    });
    await check('Errors display and controls recover', async () => {
      const p = await pageFor('');
      try {
        await p.evaluate(() => { window.__popupFail = 'rescan'; }); await p.locator('#rescan').click();
        await p.waitForFunction(() => document.querySelector('#status').textContent.includes('검사 오류') && !document.querySelector('#rescan').disabled);
        await p.evaluate(() => { window.__popupFail = undefined; }); await p.locator('#rescan').click();
        await p.waitForFunction(() => document.querySelector('#status').textContent.includes('감지된 미디어가 없습니다'));
      } finally { await p.close(); }
    });
    await check('Built collector authenticates rescan nonce and awaits every capture acknowledgement', async () => {
      const p = await context.newPage(); p.on('pageerror', e => pageErrors.push(e.message));
      await p.route(`${origin}/collector.html`, r => r.fulfill({ contentType: 'text/html', body: '<!doctype html>' +
        Array.from({ length: 12 }, (_, i) => `<a href="/fixtures/clip.mp4?c=${i}">Media</a>`).join('') }));
      try {
        await p.goto(`${origin}/collector.html`);
        await p.evaluate(() => {
          window.__collector = { handlers: [], messages: [], releases: [], hold: false, fetches: 0, ack: null };
          window.fetch = async () => { window.__collector.fetches++; throw Error('Unexpected fetch'); };
          chrome.runtime.onMessage = { addListener(fn) { window.__collector.handlers.push(fn); } };
          chrome.runtime.sendMessage = async m => {
            window.__collector.messages.push(structuredClone(m));
            if (window.__collector.hold) return new Promise(resolve => window.__collector.releases.push(resolve));
            return { ok: true };
          };
        });
        await p.addScriptTag({ url: buildPaths.url(origin, 'local/collect.js') });
        await p.waitForFunction(() => window.__collector.messages.length === 2);
        assert.equal(await p.evaluate(() => window.__collector.messages.flatMap(m => m.items).length), 12);
        assert.deepEqual(await p.evaluate(() => {
          const s = window.__collector, fn = s.handlers[0], m = { scope: 'my-video-app/local', type: 'rescan', rescanId: '33333333-3333-4333-8333-333333333333' };
          const reply = r => { s.ack = r; };
          const rejected = [fn(m, { id: 'other' }, reply), fn(m, { id: chrome.runtime.id, tab: { id: 7 } }, reply),
            fn({ ...m, rescanId: 'bad' }, { id: chrome.runtime.id }, reply)];
          s.hold = true; return { rejected, accepted: fn(m, { id: chrome.runtime.id }, reply) };
        }), { rejected: [false, false, false], accepted: true });
        await p.waitForFunction(() => window.__collector.releases.length === 2);
        assert.equal(await p.evaluate(() => window.__collector.ack), null);
        assert(await p.evaluate(() => window.__collector.messages.slice(2).every(m => m.rescanId === '33333333-3333-4333-8333-333333333333')));
        await p.evaluate(() => window.__collector.releases[0]({ ok: true })); assert.equal(await p.evaluate(() => window.__collector.ack), null);
        await p.evaluate(() => window.__collector.releases[1]({ ok: true }));
        await p.waitForFunction(() => window.__collector.ack?.ok === true); assert.equal(await p.evaluate(() => window.__collector.fetches), 0);
      } finally { await p.close(); }
    });
  } finally { await context.close(); }
  assert.deepEqual(outboundRequests, []); assert.deepEqual(pageErrors, []);
  for (const logical of ['local/popup.html', 'local/popup.js', 'local/popup.css', 'local/collect.js']) {
    assert(productionAssets.has(buildPaths.resolve(logical)), `Popup must execute the built ${logical}`);
  }
  const build = buildPaths.buildInfo;
  await writeFile('reports/popup.json', JSON.stringify({ buildSha256: build.buildSha256, browser: browser.version(),
    mode: 'Protected production popup and collector; real DOM and IndexedDB; Chrome APIs are doubles', outcomes, productionAssets: [...productionAssets].sort(), outboundRequests, pageErrors }, null, 2) + '\n');
  console.log(`PASS ${outcomes.length} popup/collector checks`); return outcomes;
}
