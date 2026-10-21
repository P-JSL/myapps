/** Actual Chromium comparison; extension APIs and collector debounce clock are
 * explicit test doubles. This is not an installed-extension integration test.
 * Frozen, hash-checked historical sources are test-only fixtures so this also
 * runs from a source ZIP without Git. They are never bundled in the extension.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const baselineRef = '6983b535ba089e7737e10583481ecd6ef35e7cc3';
const expectedBaselines = { 'collect.ts': '70474f55531579eed1075779b21c1ebfb35f1554f721b615c560eafefc57d619', 'ui.ts': 'd420b0ab96e2d15aba7a962fd719fd583eb7b0539dc2bf9d51d2e0144c539f90' };
const files = ['src/local/collect.ts', 'src/local/ui.ts'];
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceSha256 = {}, baselineSha256 = {}, bundles = {};
for (const file of files) {
  const old = await readFile(`tests/baselines/${path.basename(file, '.ts')}-1.7.0.txt`, 'utf8');
  assert.equal(hash(old), expectedBaselines[path.basename(file)], 'Historical benchmark source must match release 1.7.0');
  const current = await readFile(file, 'utf8');
  sourceSha256[file] = hash(current); baselineSha256[file] = hash(old);
  for (const [variant, contents] of [['baseline', old], ['optimized', current]]) {
    bundles[`${variant}/${path.basename(file, '.ts')}.js`] = (await build({ stdin: { contents, resolveDir: path.resolve(path.dirname(file)), sourcefile: path.basename(file), loader: 'ts' }, bundle: true, platform: 'browser', target: 'chrome120', format: 'iife', write: false, logLevel: 'silent' })).outputFiles[0].contents;
  }
}
const html = await readFile('src/local/index.html', 'utf8');
const server = createServer((request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname.slice(1);
  if (bundles[name]) { response.setHeader('Content-Type', 'text/javascript'); response.end(bundles[name]); }
  else if (name.endsWith('/index.html')) { response.setHeader('Content-Type', 'text/html'); response.end(html); }
  else if (name.endsWith('/collector.html')) { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><title>Collector</title></head><body><div id="churn"></div></body></html>'); }
  else response.writeHead(204).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext();
const regressions = [], scenarios = [];

async function collector(variant, links = 0) {
  const page = await context.newPage();
  await page.goto(`${origin}/fixture/collector.html?variant=${variant}`);
  await page.evaluate(count => {
    const root = document.createElement('div'); root.id = 'links';
    root.innerHTML = Array.from({ length: count }, (_, index) => `<a href="https://cdn.test/page/${index}">link</a>`).join('') + (count ? '<a href="https://cdn.test/original.mp4">movie</a>' : '');
    document.body.append(root);
    window.__captures = []; window.__scans = 0;
    window.chrome = { runtime: { sendMessage: async message => { window.__captures.push(...message.items); return {}; } } };
    const query = document.querySelectorAll.bind(document);
    document.querySelectorAll = selectors => { if (selectors === 'video,audio,video source,audio source,a[href]') window.__scans++; return query(selectors); };
    window.PerformanceObserver = class { constructor(callback) { window.__timing = entries => callback({ getEntries: () => entries }); } observe() {} };
    let pending;
    const timeout = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => delay === 500 ? (pending = callback, -1) : timeout(callback, delay, ...args);
    window.clearTimeout = id => { if (id === -1) pending = undefined; else clear(id); };
    window.__flush = async () => { await Promise.resolve(); const callback = pending; pending = undefined; callback?.(); await Promise.resolve(); };
  }, links);
  await page.addScriptTag({ url: `${origin}/${variant}/collect.js` });
  return page;
}
async function collectorBench(variant, links, rounds) {
  const page = await collector(variant, links);
  try {
    return await page.evaluate(async rounds => {
      window.__scans = 0;
      const started = performance.now();
      for (let index = 0; index < rounds; index++) {
        const span = document.createElement('span'); span.textContent = `irrelevant ${index}`;
        document.querySelector('#churn').replaceChildren(span); await window.__flush();
        window.__timing(Array.from({ length: 10 }, (_, entry) => ({ name: `https://cdn.test/images/${index}-${entry}.png`, nextHopProtocol: 'h2' })));
        await window.__flush();
      }
      return { elapsedMs: performance.now() - started, fullDocumentScans: window.__scans, captures: window.__captures };
    }, rounds);
  } finally { await page.close(); }
}
async function collectorRegression(variant) {
  const page = await collector(variant);
  try {
    const result = await page.evaluate(async () => {
      const links = document.querySelector('#links');
      links.innerHTML = Array.from({ length: 301 }, (_, index) => `<a href="https://cdn.test/backlog/${index}.mp4">movie</a>`).join(''); await window.__flush();
      document.querySelector('#churn').append(document.createElement('span')); await window.__flush();
      window.__timing([{ name: 'https://cdn.test/irrelevant.png', nextHopProtocol: 'h2' }]); await window.__flush();
      links.firstElementChild.remove(); await window.__flush();
      const backlog = new Set(window.__captures.map(item => item.url)).size;
      links.replaceChildren(); await window.__flush();
      const base = document.createElement('base'); base.href = 'https://cdn.test/a/'; document.head.append(base);
      const block = document.createElement('div'); block.innerHTML = '<a href="relative.mp4">relative</a><video preload="none"><source src="source.mp4" type="video/mp4"></video><audio preload="none" src="opaque-track"></audio>';
      links.append(block); await window.__flush();
      base.href = 'https://cdn.test/b/'; await window.__flush();
      const relative = document.querySelector('#links a'); relative.href = 'updated.mp4'; await window.__flush();
      document.title = 'Changed title'; await window.__flush();
      window.__timing([{ name: 'https://cdn.test/b/opaque-track', nextHopProtocol: 'h3' }]); await window.__flush();
      document.querySelector('title').firstChild.data = 'Changed character data';
      window.__timing([{ name: 'https://cdn.test/b/opaque-track', nextHopProtocol: 'h3' }]); await window.__flush();
      document.querySelector('source').type = 'video/custom'; await window.__flush();
      window.__timing([{ name: 'https://cdn.test/b/opaque-track', nextHopProtocol: 'h3' }]); await window.__flush();
      const video = document.querySelector('video'); video.dispatchEvent(new Event('loadedmetadata')); await window.__flush();
      const beforeRemoval = window.__scans; video.querySelector('source').remove(); await window.__flush();
      const removedSourceRescanned = window.__scans > beforeRemoval;
      base.remove(); await window.__flush();
      history.pushState({}, '', '/spa/new/page.html');
      window.__timing([{ name: 'https://cdn.test/b/opaque-track', nextHopProtocol: 'h3' }]); await window.__flush();
      return { backlog, captures: window.__captures, removedSourceRescanned };
    });
    assert.equal(result.backlog, 301, `${variant}: capped discoveries must continue on unrelated events`);
    assert(result.removedSourceRescanned, `${variant}: removing a source must preserve rescanning`);
    assert(result.captures.some(item => item.url === 'https://cdn.test/a/relative.mp4'));
    assert(result.captures.some(item => item.url === 'https://cdn.test/b/relative.mp4'));
    assert(result.captures.some(item => item.title === 'Changed title' && item.url.endsWith('/updated.mp4')));
    assert(result.captures.some(item => item.url.endsWith('/opaque-track') && item.observedTransport === 'h3'));
    assert(result.captures.some(item => item.title === 'Changed character data'));
    assert(result.captures.some(item => item.mime === 'video/custom'));
    assert(result.captures.some(item => item.url.endsWith('/spa/new/updated.mp4')));
    return result;
  } finally { await page.close(); }
}

async function ui(variant) {
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__media = Array.from({ length: 200 }, (_, index) => ({ id: `media-${index}`, kind: 'file', url: `https://cdn.test/${index}.mp4`, title: `Video ${index} ${'description '.repeat(5)}`, mime: 'video/mp4' }));
    window.__history = Array.from({ length: 200 }, (_, index) => ({ id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`, kind: 'file', url: `https://cdn.test/${index}.mp4`, filename: `video-${index}.mp4`, createdAt: 1_700_000_000_000, incognito: false, state: index === 0 ? 'preparing' : 'complete', ...(index === 0 ? { preparation: { stage: 'fetching', progress: 0 } } : {}) }));
    window.__commands = []; window.__listReads = 0; window.__created = 0; window.__mutations = 0;
    const create = document.createElement.bind(document); document.createElement = (...args) => { window.__created++; return create(...args); };
    window.setInterval = callback => { window.__poll = callback; return 1; }; window.clearInterval = () => {};
    window.__turn = () => new Promise(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); }; channel.port2.postMessage(null); });
    window.chrome = { extension: { inIncognitoContext: false }, runtime: { id: 'benchmark-api-double', sendMessage: async message => {
      if (message.type === 'list') { window.__listReads++; return { ok: true, items: structuredClone(window.__media), history: structuredClone(window.__history) }; }
      window.__commands.push(message);
      if (message.type === 'download' && window.__holdDownload) await new Promise(resolve => { window.__releaseDownload = resolve; });
      return { ok: true };
    } }, storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } } };
  });
  await page.goto(`${origin}/${variant}/index.html`);
  await page.waitForFunction(() => document.querySelectorAll('#history>li').length === 200);
  await page.evaluate(() => {
    const observer = new MutationObserver(records => { window.__mutations += records.reduce((total, record) => total + record.addedNodes.length + record.removedNodes.length, 0); });
    for (const id of ['media', 'history']) observer.observe(document.getElementById(id), { childList: true, subtree: true });
  });
  return page;
}
async function uiBench(variant, progress) {
  const page = await ui(variant);
  try {
    return await page.evaluate(async progress => {
      window.__created = 0; window.__mutations = 0;
      const started = performance.now();
      for (let index = 0; index < 100; index++) {
        if (progress) window.__history[0].preparation.progress = (index + 1) / 100;
        window.__poll(); await window.__turn();
      }
      return { elapsedMs: performance.now() - started, createdElements: window.__created, listNodeMutations: window.__mutations, text: document.querySelector('#media').textContent + document.querySelector('#history').textContent };
    }, progress);
  } finally { await page.close(); }
}
async function uiRegression(variant) {
  const page = await ui(variant);
  try {
    return await page.evaluate(async variant => {
      const poll = async () => { window.__poll(); await window.__turn(); };
      const button = document.querySelector('#media button'); button.focus(); await poll();
      if (variant === 'optimized') { if (!button.isConnected || document.activeElement !== button) throw Error('Unchanged focus/row was replaced'); }
      window.__media[0].title = 'Changed media title'; await poll();
      if (document.activeElement?.dataset.action !== 'download') throw Error('Changed row lost keyboard action focus');
      const first = window.__media[0]; window.__media = [window.__media[2], first]; await poll();
      if (document.querySelectorAll('#media>li').length !== 2 || document.querySelector('#media>li').dataset.rowId !== 'media-2') throw Error('Row ordering/removal changed');
      if (document.activeElement?.dataset.action !== 'download') throw Error('Reordered row lost keyboard action focus');
      if (variant === 'optimized') {
        window.__holdDownload = true; const action = document.querySelector('#media button'); action.click(); await window.__turn(); await poll();
        if (!action.isConnected || !action.disabled) throw Error('Polling lost pending disabled state');
        window.__releaseDownload(); await window.__turn();
      }
      window.__media = [{ ...first, id: 'duplicate', title: 'Duplicate one' }, { ...first, id: 'duplicate', title: 'Duplicate two' }]; await poll(); await poll();
      if (document.querySelectorAll('#media>li').length !== 2) throw Error('Duplicate IDs collapsed rows');
      window.__history = [{ ...window.__history[1], state: 'review', security: { status: 'infected', token: 'old-token', message: 'Old security result', threats: ['Test warning'] } }]; await poll();
      window.__history[0].security = { ...window.__history[0].security, token: 'new-token', message: 'New security result' }; await poll();
      if (!document.querySelector('#security-dialog').open || !document.querySelector('#security-details').textContent.includes('New security result')) throw Error('Security result did not update');
      document.querySelector('#security-acknowledge').checked = true; document.querySelector('#security-acknowledge').dispatchEvent(new Event('change')); document.querySelector('#security-keep').click(); await window.__turn();
      if (window.__commands.at(-1)?.token !== 'new-token') throw Error('Security action retained stale token');
      return { mediaText: document.querySelector('#media').textContent, securityToken: window.__commands.find(command => command.type === 'security-keep')?.token, duplicateRows: document.querySelectorAll('#media>li').length };
    }, variant);
  } finally { await page.close(); }
}
try {
  for (const [links, rounds] of [[200, 20], [10_000, 100]]) {
    const baseline = await collectorBench('baseline', links, rounds), optimized = await collectorBench('optimized', links, rounds);
    assert.deepEqual(optimized.captures, baseline.captures);
    scenarios.push({ name: `collector-unrelated-churn-${links}-anchors`, input: { anchors: links, mutationRounds: rounds, nonMediaTimings: rounds * 10 }, baseline: { elapsedMs: baseline.elapsedMs, fullDocumentScans: baseline.fullDocumentScans }, optimized: { elapsedMs: optimized.elapsedMs, fullDocumentScans: optimized.fullDocumentScans } });
  }
  const oldCollector = await collectorRegression('baseline'), newCollector = await collectorRegression('optimized');
  assert.deepEqual(newCollector, oldCollector); regressions.push('collector: 301-link capped backlog, unrelated DOM/timing continuation, base rebase/removal, SPA URL rebasing, title character data, source MIME/removal and opaque-URL HTTP/3 update match baseline');
  for (const progress of [false, true]) {
    const baseline = await uiBench('baseline', progress), optimized = await uiBench('optimized', progress);
    assert.equal(optimized.text, baseline.text);
    scenarios.push({ name: progress ? 'ui-one-progress-row' : 'ui-unchanged-poll', input: { mediaRows: 200, historyRows: 200, polls: 100 }, baseline: { elapsedMs: baseline.elapsedMs, createdElements: baseline.createdElements, listNodeMutations: baseline.listNodeMutations }, optimized: { elapsedMs: optimized.elapsedMs, createdElements: optimized.createdElements, listNodeMutations: optimized.listNodeMutations } });
  }
  assert.deepEqual(await uiRegression('optimized'), await uiRegression('baseline'));
  regressions.push('UI: unchanged/changed focus, ordering/removal, duplicate IDs, new security tokens/actions, and retained pending disabled button');
  process.stdout.write(JSON.stringify({ suite: 'ui-collector', baselineRef, baselineSha256, sourceSha256, browser: browser.version(), platform: process.platform, mode: 'real Chromium DOM and IndexedDB; Chrome APIs/resource timing/debounce clock are test doubles; no network latency benchmark', scenarios, regressions, status: 'passed' }) + '\n');
} finally {
  await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve));
}
