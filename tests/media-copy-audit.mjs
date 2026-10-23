import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

/** Real DOM/Clipboard in Chromium; extension APIs and explicit denial are doubles. */
export async function verifyMediaCopyAudit(browser, origin, buildPaths) {
  const outcomes = [], pageErrors = [], outboundRequests = [];
  async function prepareContext(grants) {
    const context = await browser.newContext({ viewport: { width: 640, height: 700 } });
    if (grants) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(origin + '/') || url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
      outboundRequests.push(url); return route.abort();
    });
    await context.addInitScript(() => {
      window.__copyMedia = { id: '11111111-1111-4111-8111-111111111111', tabId: 7,
        url: 'https://media.invalid/clip.mp4?token=owned-fixture&title=%3Cimg%3E',
        title: '<script>copy fixture</script>', mime: 'video/mp4', kind: 'file', createdAt: Date.now() };
      window.__copyMessages = []; window.__copyHistory = [];
      Object.defineProperty(window, 'chrome', { configurable: true, value: {
        extension: { inIncognitoContext: false },
        storage: { local: { get: async () => ({}), remove: async () => {}, set: async () => {} } },
        runtime: {
          id: 'media-copy-audit', getURL: value => new URL(value.replace(/^\/+/, ''), location.origin + '/').href,
          sendMessage: async message => {
            window.__copyMessages.push(structuredClone(message));
            if (message.type === 'antivirus-settings') return { ok: true, enabled: true };
            if (message.type === 'list') return { ok: true, items: [structuredClone(window.__copyMedia)], history: structuredClone(window.__copyHistory) };
            return { ok: true };
          },
        },
        tabs: { create: async () => ({ id: 99 }) }, downloads: { showDefaultFolder: async () => {} },
      } });
    });
    return context;
  }
  const context = await prepareContext(true);
  const open = async (logical, target = context) => {
    const page = await target.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(buildPaths.url(origin, logical));
    await page.locator('#media [data-action=copy-url]').waitFor();
    return page;
  };
  const check = async (name, run) => { await run(); outcomes.push({ name, status: 'passed' }); };
  try {
    await check('Popup and app copy on trusted click with default permissions before any test read grant', async () => {
      for (const logical of ['local/popup.html', 'local/index.html']) {
        const fresh = await prepareContext(false);
        try {
          const page = await open(logical, fresh);
          // This write must succeed before the harness grants any clipboard
          // permission. Only then allow a test read of the known written URL.
          await page.locator('#media [data-action=copy-url]').click();
          await page.waitForFunction(() => document.querySelector('#status').textContent.includes('주소를 복사했습니다'));
          assert.equal(await page.locator('.media-copy-dialog').count(), 0);
          await fresh.grantPermissions(['clipboard-read'], { origin });
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await page.evaluate(() => window.__copyMedia.url));
        } finally { await fresh.close(); }
      }
    });
    for (const [label, logical] of [['popup', 'local/popup.html'], ['app', 'local/index.html']]) {
      await check(`${label}: explicit click and keyboard copy exact URL with real Clipboard API`, async () => {
        const page = await open(logical);
        try {
          await page.evaluate(() => navigator.clipboard.writeText('owned clipboard sentinel'));
          const button = page.locator('#media [data-action=copy-url]');
          assert.equal(await button.textContent(), '주소 복사');
          assert.match(await button.getAttribute('aria-label'), /주소 복사$/);
          assert.equal(await page.locator('#media script').count(), 0);
          // Synthetic DOM clicks may not mutate the clipboard or create a manual dialog.
          await button.evaluate(element => element.click());
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'owned clipboard sentinel');
          assert.equal(await page.locator('.media-copy-dialog').count(), 0);
          await button.click();
          await page.waitForFunction(() => document.querySelector('#status').textContent.includes('주소를 복사했습니다'));
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await page.evaluate(() => window.__copyMedia.url));
          await page.evaluate(() => navigator.clipboard.writeText('owned keyboard sentinel'));
          await button.focus(); await page.keyboard.press('Enter');
          await page.waitForFunction(async () => await navigator.clipboard.readText() === window.__copyMedia.url);
          assert.equal(await button.evaluate(element => document.activeElement === element), true);
          assert.equal(await page.locator('.media-copy-dialog').count(), 0);
          assert.equal(await page.evaluate(() => window.__copyMessages.some(message => message.type === 'download')), false);
        } finally { await page.close(); }
      });
      await check(`${label}: denied and unavailable writes offer selected literal manual copy and restore focus`, async () => {
        const page = await open(logical);
        try {
          await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
            writeText: () => Promise.reject(new DOMException('Injected browser denial', 'NotAllowedError')),
          } }));
          const button = page.locator('#media [data-action=copy-url]');
          await button.click();
          const dialog = page.locator('.media-copy-dialog'); await dialog.waitFor();
          const selected = dialog.locator('textarea');
          assert.equal(await selected.inputValue(), await page.evaluate(() => window.__copyMedia.url));
          assert.deepEqual(await selected.evaluate(element => ({ readonly: element.readOnly, start: element.selectionStart, end: element.selectionEnd, length: element.value.length, focused: document.activeElement === element })),
            { readonly: true, start: 0, end: (await selected.inputValue()).length, length: (await selected.inputValue()).length, focused: true });
          assert.match(await dialog.innerText(), /Ctrl\+C.*⌘C/);
          assert.equal(await dialog.locator('img,script,a').count(), 0);
          await page.keyboard.press('Escape');
          await page.waitForFunction(() => document.querySelector('.media-copy-dialog textarea').value === '');
          assert.equal(await button.evaluate(element => document.activeElement === element), true);
          assert.equal(await selected.inputValue(), '');
          await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
          await button.focus(); await page.keyboard.press('Space'); await dialog.waitFor();
          assert.equal(await selected.inputValue(), await page.evaluate(() => window.__copyMedia.url));
          await dialog.getByRole('button', { name: '닫기', exact: true }).click();
          await page.waitForFunction(() => document.querySelector('.media-copy-dialog textarea').value === '');
          assert.equal(await button.evaluate(element => document.activeElement === element), true);
          assert.equal(await selected.inputValue(), '');
        } finally { await page.close(); }
      });
    }
    await check('Popup retained copy controls use current URL and reject unsafe schemes without clipboard writes', async () => {
      const page = await open('local/popup.html');
      try {
        await page.evaluate(() => { window.__copyWrites = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          writeText: async value => { window.__copyWrites.push(value); },
        } }); window.__copyMedia.url = 'https://media.invalid/new.mp4'; });
        await page.waitForFunction(() => document.querySelector('.media-detail').textContent.includes('media.invalid'));
        await page.waitForFunction(() => window.__copyMessages.filter(message => message.type === 'list').length >= 2);
        const button = page.locator('#media [data-action=copy-url]');
        await button.click();
        assert.deepEqual(await page.evaluate(() => window.__copyWrites), ['https://media.invalid/new.mp4']);
        await page.evaluate(() => { window.__copyMedia.url = 'javascript:alert(1)'; });
        await page.waitForFunction(() => !document.querySelector('.media-detail').textContent.includes('media.invalid'));
        await button.click();
        await page.waitForFunction(() => document.querySelector('#status').textContent.includes('복사하지 않았습니다'));
        assert.deepEqual(await page.evaluate(() => window.__copyWrites), ['https://media.invalid/new.mp4']);
        assert.equal(await page.locator('.media-copy-dialog').count(), 0);
      } finally { await page.close(); }
    });
    await check('Popup active URL index respects selected quality, output and terminal history states', async () => {
      const page = await open('local/popup.html');
      try {
        for (const [state, quality, output, disabled] of [
          ['preparing', 'highest', 'original', true], ['downloading', '720', 'original', false],
          ['scanning', 'highest', 'mp3', false], ['review', 'highest', 'original', true],
          ['complete', 'highest', 'original', false], ['cancelled', 'highest', 'original', false],
        ]) {
          const reads = await page.evaluate(values => {
            window.__copyHistory = [{ id: '22222222-2222-4222-8222-222222222222',
              url: window.__copyMedia.url, filename: 'owned.mp4', kind: 'file', createdAt: Date.now(), incognito: false,
              state: values[0], options: { quality: values[1], output: values[2] } }];
            return window.__copyMessages.filter(message => message.type === 'list').length;
          }, [state, quality, output]);
          await page.waitForFunction(previous => window.__copyMessages.filter(message => message.type === 'list').length > previous, reads);
          assert.equal(await page.locator('#media [data-action=download]').isDisabled(), disabled, `${state}/${quality}/${output}`);
          assert.equal(await page.locator('#media [data-action=copy-url]').isDisabled(), false);
        }
      } finally { await page.close(); }
    });
  } finally { await context.close(); }
  assert.deepEqual(pageErrors, []); assert.deepEqual(outboundRequests, []);
  if (buildPaths.buildInfo?.buildSha256) await writeFile('reports/media-copy.json', JSON.stringify({ buildSha256: buildPaths.buildInfo.buildSha256,
    mode: 'Real Chromium Clipboard writes on trusted click with fresh default-permission contexts before any grant; only afterward test read permission inspects the known URL. Additional click/keyboard/denial cases use test read/write grants or explicit denial/unavailability doubles. Chrome extension APIs are doubles. Product never reads clipboard.',
    outcomes, pageErrors, outboundRequests }, null, 2) + '\n');
  return outcomes;
}
