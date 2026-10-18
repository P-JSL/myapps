import test from 'node:test';
import assert from 'node:assert/strict';
import { allowRuntimeMessage, boundedData, envelope, record, safeBridge, bridgeResponses } from '../src/security/validation.ts';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const page = { id: extensionId, url: 'https://www.youtube.com/watch?v=example', tab: { id: 12 } };
const message = (name: string, data: unknown, channel = 0) => ({ channel, msg: { name, data } });

test('bounded data accepts ordinary structured messages and repeated non-cyclic references', () => {
  const shared = { title: '영상', values: [null, true, false, 0, 1.5, undefined] };
  assert.equal(boundedData({ first: shared, second: shared }), true);
  assert.equal(boundedData(Object.assign(Object.create(null), { title: 'null prototype' })), true);
  assert.equal(record({}), true);
  for (const value of [null, undefined, [], 'object', 2]) assert.equal(record(value), false);
});

test('bounded data rejects cycles, exotic objects, invalid primitives and prototype keys', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const array: unknown[] = [];
  array.push(array);
  for (const value of [cyclic, array, new Date(), new Map(), new Set(), new Uint8Array(8), NaN, Infinity, -Infinity, 1n, Symbol('x'), () => 1]) {
    assert.equal(boundedData(value), false);
  }
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.equal(boundedData(JSON.parse(`{"nested":{"${key}":"pollution"}}`)), false);
  }
});

test('bounded data accounts for key and value lengths and enforces depth and node limits', () => {
  assert.equal(boundedData({ a: '1234' }, 5), true);
  assert.equal(boundedData({ a: '12345' }, 5), false);
  let deep: unknown = 'leaf';
  for (let i = 0; i < 65; i++) deep = [deep];
  assert.equal(boundedData(deep), false);
  assert.equal(boundedData(new Array(100_001).fill(null)), false);
});

test('envelopes enforce message shape, valid channel numbers and bounded payloads', () => {
  for (let channel = 0; channel <= 8; channel++) assert.equal(envelope(message('hello', { ok: true }, channel)), true);
  for (const value of [null, [], {}, { channel: '0', msg: { name: 'ok' } }, message('x', {}, -1), message('x', {}, 9), message('x', {}, 1.5), message('', {}), message('x'.repeat(101), {}), message('x', { fn() {} })]) {
    assert.equal(envelope(value), false);
  }
});

test('runtime pages require the installed extension sender, an HTTP page and a valid tab', () => {
  const media = message('on_media', { media: { url: 'https://cdn.example/video.mp4' } });
  assert.equal(allowRuntimeMessage(media, page, extensionId, 0), true);
  for (const sender of [
    { ...page, id: 'different-extension' },
    { ...page, url: 'javascript:alert(1)' },
    { ...page, url: 'file:///tmp/page.html' },
    { ...page, url: 'data:text/html,hello' },
    { ...page, url: 'chrome-extension://other/page.html' },
    { ...page, url: 'invalid url' },
    { ...page, tab: {} },
    { ...page, tab: { id: -1 } },
    { ...page, tab: { id: 1.5 } },
  ]) assert.equal(allowRuntimeMessage(media, sender, extensionId, 0), false);
  assert.equal(allowRuntimeMessage({ ...media, channel: 1 }, page, extensionId, 0), false);
  assert.equal(allowRuntimeMessage(message('not-supported', {}), page, extensionId, 0), false);
  assert.equal(allowRuntimeMessage(message('on_media', { media: [] }), page, extensionId, 0), false);
});

test('privileged content messages require this extension origin', () => {
  const content = message('service_request', { ok: true }, 1);
  assert.equal(allowRuntimeMessage(content, { id: extensionId, url: `chrome-extension://${extensionId}/panel/main.html` }, extensionId, 1), true);
  for (const url of ['https://example.com/', `https://${extensionId}/`, 'chrome-extension://other/page.html']) {
    assert.equal(allowRuntimeMessage(content, { id: extensionId, url }, extensionId, 1), false);
  }
});

test('activation is restricted to HTTPS activation routes on exact service hosts', () => {
  const activation = message('on_activate_addon', { key: 'activation-key' });
  for (const host of ['downloadhelper.net', 'app.downloadhelper.net', 'v10.downloadhelper.net']) {
    assert.equal(allowRuntimeMessage(activation, { ...page, url: `https://${host}/activate/complete` }, extensionId, 0), true);
  }
  for (const url of ['http://downloadhelper.net/activate', 'https://downloadhelper.net.evil.example/activate', 'https://evil.downloadhelper.net/activate', 'https://downloadhelper.net/other', 'https://downloadhelper.net@evil.example/activate']) {
    assert.equal(allowRuntimeMessage(activation, { ...page, url }, extensionId, 0), false);
  }
  assert.equal(allowRuntimeMessage(message('on_activate_addon', { key: 'x'.repeat(8193) }), { ...page, url: 'https://downloadhelper.net/activate' }, extensionId, 0), false);
});

test('YouTube operations cannot be requested by lookalike domains or oversized code', () => {
  const qjs = message('qjs', { code: 'return 1', uid: 'request-1' });
  for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com']) {
    assert.equal(allowRuntimeMessage(qjs, { ...page, url: `https://${host}/watch?v=x` }, extensionId, 0), true);
  }
  for (const host of ['youtube.com.evil.example', 'notyoutube.com', 'example.com']) {
    assert.equal(allowRuntimeMessage(qjs, { ...page, url: `https://${host}/` }, extensionId, 0), false);
  }
  assert.equal(allowRuntimeMessage(message('qjs', { code: 'x'.repeat(4 * 1024 * 1024 + 1), uid: 1 }), page, extensionId, 0), false);
  assert.equal(allowRuntimeMessage(message('qjs', { code: 'return 1' }), page, extensionId, 0), false);
});

test('VK fetch delegation permits only its fixed POST endpoint', () => {
  const data = { url: 'https://vk.com/al_video.php', method: 'POST', fetch_headers: {}, body_params: { act: 'show' }, uid: 1 };
  for (const host of ['vk.com', 'm.vk.com', 'vk.ru', 'vkvideo.ru']) {
    assert.equal(allowRuntimeMessage(message('do_fetch_from_service', data), { ...page, url: `https://${host}/video1` }, extensionId, 0), true);
  }
  for (const url of ['https://evil.example/al_video.php', 'http://vk.com/al_video.php', 'https://vk.com/al_video.php?redirect=1', 'https://vk.com/al_video.php#fragment', 'file:///etc/passwd', 'javascript:alert(1)']) {
    assert.equal(allowRuntimeMessage(message('do_fetch_from_service', { ...data, url }), { ...page, url: 'https://vk.com/' }, extensionId, 0), false);
  }
  assert.equal(allowRuntimeMessage(message('do_fetch_from_service', { ...data, method: 'GET' }), { ...page, url: 'https://vk.com/' }, extensionId, 0), false);
  assert.equal(allowRuntimeMessage(message('do_fetch_from_service', data), { ...page, url: 'https://vk.com.evil.example/' }, extensionId, 0), false);
});

test('page bridges accept valid site-specific results and reject other channels and names', () => {
  const fixtures: Array<[string, string, unknown]> = [
    ['youtube', 'youtube_on_visitor_data', { visitor_data: 'visitor' }],
    ['youtube', 'youtube_on_visitor_data', {}],
    ['vimeo', 'vimeo_on_config', { config: { request: { files: {} } } }],
    ['iq', 'iq_on_config', { config: { video: 'id' } }],
    ['javrank', 'javrank_on_manifest', { raw: '\n#EXTM3U\n#EXTINF:10,\nsegment.ts' }],
    ['xgplayer_crypto', '91porna_on_config', { url: 'https://cdn.example/movie.m3u8', m3u8: '#EXTM3U\n' }],
    ['bilibili', 'bilibili_tv_on_config', { ep_id: 1234, ai_id: undefined }],
    ['bilibili', 'bilibili_com_on_id', { cid: 1234, bvid: 'BV12345' }],
  ];
  for (const [site, name, data] of fixtures) {
    assert.equal(safeBridge(message(name, data, 4), bridgeResponses[site]!), true, name);
    assert.equal(safeBridge(message(name, data, 5), bridgeResponses[site]!), false, name);
    assert.equal(safeBridge(message(name, data, 4), ['unrelated_response']), false, name);
  }
});

test('page bridges reject malformed media metadata and dangerous URLs', () => {
  for (const [name, data] of [
    ['youtube_on_visitor_data', { visitor_data: {} }],
    ['vimeo_on_config', { config: [] }],
    ['javrank_on_manifest', { raw: '<html>#EXTM3U</html>' }],
    ['91porna_on_config', { url: 'javascript:alert(1)', m3u8: '#EXTM3U' }],
    ['91porna_on_config', { url: 'file:///tmp/video.m3u8', m3u8: '#EXTM3U' }],
    ['91porna_on_config', { url: 'https://cdn.example/file', m3u8: 'not a playlist' }],
    ['bilibili_com_on_id', { cid: {}, bvid: 'BV12345' }],
    ['bilibili_com_on_id', { cid: 1, bvid: 123 }],
  ] as Array<[string, unknown]>) {
    assert.equal(safeBridge(message(name, data, 4), [name]), false, name);
  }
});
