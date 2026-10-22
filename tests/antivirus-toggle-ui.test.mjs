import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

test('antivirus toggle UI preserves settings and permissions across delayed or failed operations', async t => {
  // Actual browser/UI module. Backend commands and permission dialogs are doubles;
  // download/native lifecycle coverage lives in the main browser harness.
  const bundle = (await build({ entryPoints: ['src/local/ui.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'chrome120', logLevel: 'silent' })).outputFiles[0].contents;
  const html = await readFile('src/local/index.html');
  const server = createServer((request, response) => {
    if (request.url === '/ui.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle); }
    else if (request.url === '/index.html') { response.setHeader('Content-Type', 'text/html'); response.end(html); }
    else response.writeHead(204).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    await context.addInitScript(() => {
      window.__enabled = true; window.__commands = []; window.__permissions = 0;
      window.setInterval = callback => { window.__poll = callback; return 1; };
      window.clearInterval = () => {};
      window.chrome = {
        extension: { inIncognitoContext: false },
        storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
        permissions: { request: async () => { window.__permissions++; if (window.__holdPermission) return new Promise(resolve => { window.__releasePermission = resolve; }); return true; } },
        runtime: { id: 'av-ui-test-double', sendMessage: async message => {
          window.__commands.push(structuredClone(message));
          if (message.type === 'antivirus-settings') {
            if (window.__readFails) return { ok: false, error: 'test read failed' };
            const enabled = window.__enabled;
            if (window.__holdRead) return new Promise(resolve => { window.__releaseRead = () => resolve({ ok: true, enabled }); });
            return { ok: true, enabled };
          }
          if (message.type === 'set-antivirus-enabled') {
            if (window.__saveFails) return { ok: false, error: 'test save failed' };
            if (window.__holdSave) await new Promise(resolve => { window.__releaseSave = resolve; });
            window.__enabled = message.enabled; return { ok: true, enabled: window.__enabled };
          }
          if (message.type === 'security-connect') return { ok: true, antivirus: { status: 'ready', engine: 'UI test double' } };
          return { ok: true, items: [], history: [] };
        } },
      };
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const page = await context.newPage();
    await t.test('pending startup settings block the switch and permission prompt', async () => {
      await page.addInitScript(() => { window.__holdRead = true; });
      await page.goto(`${origin}/index.html`);
      await page.waitForFunction(() => typeof window.__releaseRead === 'function');
      assert(await page.locator('#antivirus-enabled').isDisabled());
      assert(await page.locator('#security-connect').isDisabled());
      await page.evaluate(() => { document.querySelector('#security-connect').click(); window.__releaseRead(); });
      await page.waitForFunction(() => !document.querySelector('#antivirus-enabled').disabled);
      assert.equal(await page.evaluate(() => window.__permissions), 0);
      // This init script also applies on subsequent reloads, so release startup
      // reads explicitly in later scenarios before exercising other operations.
    });
    const ready = async () => {
      await page.goto(`${origin}/index.html`);
      await page.waitForFunction(() => typeof window.__releaseRead === 'function');
      await page.evaluate(() => { window.__holdRead = false; window.__releaseRead(); });
      await page.waitForFunction(() => !document.querySelector('#antivirus-enabled').disabled);
    };
    await t.test('stale settings read cannot overwrite a newer successful OFF save', async () => {
      await ready();
      await page.evaluate(() => { window.__holdRead = true; document.querySelector('#refresh').click(); });
      await page.waitForFunction(() => window.__commands.filter(message => message.type === 'antivirus-settings').length >= 2);
      await page.locator('#antivirus-enabled').uncheck();
      await page.waitForFunction(() => document.querySelector('#antivirus-toggle-state').textContent === 'OFF');
      await page.evaluate(() => window.__releaseRead());
      await page.waitForTimeout(20);
      assert.equal(await page.locator('#antivirus-enabled').isChecked(), false);
      assert(await page.locator('#security-connect').isDisabled());
      assert.match(await page.locator('#security-connection-status').textContent(), /연동 OFF/);
      assert.equal(await page.evaluate(() => window.__permissions), 0);
    });
    await t.test('switch stays disabled during save and OFF cancels a pending permission continuation', async () => {
      await ready();
      await page.evaluate(() => { window.__holdPermission = true; window.__holdSave = true; });
      await page.locator('#security-connect').click();
      await page.waitForFunction(() => typeof window.__releasePermission === 'function');
      await page.locator('#antivirus-enabled').uncheck();
      await page.waitForFunction(() => typeof window.__releaseSave === 'function');
      assert(await page.locator('#antivirus-enabled').isDisabled());
      assert.match(await page.locator('#antivirus-settings-status').textContent(), /저장/);
      await page.evaluate(() => window.__releaseSave());
      await page.waitForFunction(() => document.querySelector('#antivirus-toggle-state').textContent === 'OFF');
      await page.evaluate(() => window.__releasePermission(true));
      await page.waitForTimeout(20);
      assert.equal(await page.evaluate(() => window.__commands.filter(message => message.type === 'security-connect').length), 0);
      assert(await page.locator('#security-connect').isDisabled());
      assert.match(await page.locator('#security-connection-status').textContent(), /연동 OFF/);
    });
    await t.test('failed save blocks uncertain controls and explicit reread restores actual setting', async () => {
      await ready();
      await page.evaluate(() => { window.__saveFails = true; });
      await page.locator('#antivirus-enabled').click();
      await page.waitForFunction(() => !document.querySelector('#antivirus-settings-retry').hidden);
      assert(await page.locator('#antivirus-enabled').isDisabled());
      assert(await page.locator('#security-connect').isDisabled());
      assert.match(await page.locator('#antivirus-settings-status').textContent(), /저장 여부를 확인하지 못했습니다/);
      await page.locator('#antivirus-settings-retry').click();
      await page.waitForFunction(() => !document.querySelector('#antivirus-enabled').disabled);
      assert(await page.locator('#antivirus-enabled').isChecked());
      assert.equal(await page.locator('#security-connect').isDisabled(), false);
    });
    await t.test('cross-window setting refresh and failed read never imply a clean AV verdict', async () => {
      await ready();
      await page.evaluate(() => { window.__enabled = false; window.__poll(); });
      await page.waitForFunction(() => document.querySelector('#antivirus-toggle-state').textContent === 'OFF');
      assert(await page.locator('#security-connect').isDisabled());
      assert.match(await page.locator('#antivirus-toggle-help').textContent(), /Windows 백신 자체를 끄지 않/);
      await page.evaluate(() => { window.__readFails = true; window.__poll(); });
      await page.waitForFunction(() => !document.querySelector('#antivirus-settings-retry').hidden);
      assert(await page.locator('#antivirus-enabled').isDisabled());
      assert.match(await page.locator('#antivirus-settings-status').textContent(), /설정을 확인하지 못했습니다/);
      await page.evaluate(() => { window.__readFails = false; window.__enabled = true; });
      await page.locator('#antivirus-settings-retry').click();
      await page.waitForFunction(() => !document.querySelector('#antivirus-enabled').disabled);
      assert(await page.locator('#antivirus-enabled').isChecked());
    });
    await t.test('authoritative OFF blocks permission requests before the next cross-window UI poll', async () => {
      await ready();
      await page.evaluate(() => { window.__enabled = false; });
      assert(await page.locator('#antivirus-enabled').isChecked());
      assert.equal(await page.locator('#security-connect').isDisabled(), false);
      await page.locator('#security-connect').click();
      await page.waitForFunction(() => document.querySelector('#antivirus-toggle-state').textContent === 'OFF');
      assert.equal(await page.evaluate(() => window.__permissions), 0);
      assert.equal(await page.evaluate(() => window.__commands.filter(message => message.type === 'security-connect').length), 0);
      assert(await page.locator('#security-connect').isDisabled());
    });
    await t.test('expired user activation asks for a fresh click without opening a permission prompt', async () => {
      await ready();
      // Explicitly model expiry during the asynchronous settings round trip;
      // normal connect tests above use real Chromium transient activation.
      await page.evaluate(() => { Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: false } }); });
      await page.locator('#security-connect').click();
      await page.waitForFunction(() => document.querySelector('#security-connection-status').textContent.includes('다시 눌러'));
      assert.equal(await page.evaluate(() => window.__permissions), 0);
      assert.equal(await page.evaluate(() => window.__commands.filter(message => message.type === 'security-connect').length), 0);
      assert.equal(await page.locator('#security-connect').isDisabled(), false);
    });
    await context.close();
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
