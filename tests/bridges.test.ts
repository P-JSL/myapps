import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { build } from 'esbuild';

interface BrowserHarness {
  messages: unknown[];
  channels: Array<{ name: string; closed: boolean; listeners: Array<(event: { data: unknown }) => void> }>;
  request(name: string, channel?: number): Promise<void>;
  run(code: string): unknown;
  hide(persisted?: boolean): void;
}

async function browser(source: string, href: string, fixture: Record<string, unknown> = {}): Promise<BrowserHarness> {
  const messages: unknown[] = [];
  const channels: BrowserHarness['channels'] = [];
  const lifecycle = new Map<string, (event: { persisted: boolean }) => void>();
  const context = vm.createContext({
    AbortController,
    performance: { now: () => 1000 },
    setTimeout: () => 1,
    clearTimeout: () => {},
    addEventListener: (name: string, handler: (event: { persisted: boolean }) => void) => lifecycle.set(name, handler),
    BroadcastChannel: class {
      name: string;
      closed = false;
      listeners: Array<(event: { data: unknown }) => void> = [];
      constructor(name: string) { this.name = name; channels.push(this); }
      addEventListener(_name: string, listener: (event: { data: unknown }) => void) { this.listeners.push(listener); }
      removeEventListener(_name: string, listener: (event: { data: unknown }) => void) { this.listeners = this.listeners.filter(item => item !== listener); }
      postMessage(value: unknown) { messages.push(structuredClone(value)); }
      close() { this.closed = true; }
    },
  });
  // Build fixtures inside the VM so object prototypes match the page's realm.
  vm.runInContext(`
    globalThis.window = globalThis;
    globalThis.location = { href: ${JSON.stringify(href)} };
    Object.assign(globalThis, JSON.parse(${JSON.stringify(JSON.stringify(fixture))}));
    class XMLHttpRequest {
      listeners = [];
      responseURL = '';
      responseText = '';
      responseType = '';
      open() {}
      addEventListener(_name, handler) { this.listeners.push(handler); }
      complete(url, body) { this.responseURL = url; this.responseText = body; for (const handler of this.listeners) handler(); }
    }
    globalThis.XMLHttpRequest = XMLHttpRequest;
  `, context);
  vm.runInContext(source, context);
  await setImmediate();
  return {
    messages,
    channels,
    async request(name: string, channel = 5) {
      // Requests are also created in the receiving realm, like structured cloning.
      const data = vm.runInContext(`({ channel: ${channel}, msg: { name: ${JSON.stringify(name)} } })`, context) as unknown;
      for (const bus of channels.filter(item => item.name.startsWith('injected-'))) {
        for (const listener of bus.listeners) listener({ data });
      }
      await setImmediate();
    },
    run(code: string) { return vm.runInContext(code, context); },
    hide(persisted = false) { lifecycle.get('pagehide')?.({ persisted }); },
  };
}

const compiled = new Map<string, Promise<string>>();
function rewritten(site: string): Promise<string> {
  let result = compiled.get(site);
  if (!result) {
    result = build({ entryPoints: [resolve(`src/bridges/${site}.ts`)], bundle: true, write: false, format: 'iife', target: 'chrome120' })
      .then(output => output.outputFiles[0]!.text);
    compiled.set(site, result);
  }
  return result;
}
function original(site: string) { return readFile(resolve(`vendor/original/injected/${site}_untrusted.js`), 'utf8'); }

test('rewritten channel hashes match packaged extension channels for arbitrary page URLs', async () => {
  const [beforeSource, afterSource] = await Promise.all([original('youtube'), rewritten('youtube')]);
  for (const href of [
    'https://www.youtube.com/watch?v=abcd1234',
    'https://www.youtube.com/watch?v=x&list=PL123#t=23',
    'https://example.com/영상?query=🎬',
    'https://player.vimeo.com/video/12345678',
    'https://www.bilibili.tv/en/play/12345/67890',
    '',
  ]) {
    const before = await browser(beforeSource, href);
    const after = await browser(afterSource, href);
    assert.equal(after.channels[0]!.name, before.channels.find(channel => channel.name.startsWith('injected-'))!.name, href);
    assert.deepEqual(after.messages, before.messages, href);
  }
});

const fixtures = [
  { site: 'youtube', url: 'https://www.youtube.com/watch?v=example', state: { ytcfg: { data_: { VISITOR_DATA: 'visitor-token-123' } } }, request: 'youtube_request_visitor_data' },
  { site: 'youtube', url: 'https://www.youtube.com/watch?v=example', state: {}, request: 'youtube_request_visitor_data' },
  { site: 'vimeo', url: 'https://player.vimeo.com/video/12345678', state: { playerConfig: { video: { id: 12345678 }, request: { files: { progressive: [{ url: 'https://cdn.example/video.mp4', width: 1280, height: 720 }] } } } }, request: 'vimeo_request_config' },
  { site: 'iq', url: 'https://www.iq.com/play/example', state: { __playerdata__: { videoId: '12345', tracks: [{ format: 'm3u8' }] } }, request: 'iq_request_config' },
  { site: 'bilibili', url: 'https://www.bilibili.com/video/BV12345', state: { __INITIAL_STATE__: { cid: 98765, videoData: { bvid: 'BV12345' } } }, request: 'bilibili_com_request_id' },
  { site: 'bilibili', url: 'https://www.bilibili.tv/en/play/12345/67890', state: { __initialState: { ogv: { epId: { _value: 12345 } }, ugc: { aid: {} } } }, request: 'bilibili_tv_request_config' },
  { site: 'bilibili', url: 'https://www.bilibili.tv/en/video/12345', state: { __initialState: { ogv: { epId: {} }, ugc: { aid: { _value: '67890' } } } }, request: 'bilibili_tv_request_config' },
];

for (const fixture of fixtures) {
  test(`${fixture.site}: initial and requested valid metadata match the packaged implementation (${fixture.url})`, async () => {
    const [beforeSource, afterSource] = await Promise.all([original(fixture.site), rewritten(fixture.site)]);
    const before = await browser(beforeSource, fixture.url, fixture.state);
    const after = await browser(afterSource, fixture.url, fixture.state);
    assert.ok(before.messages.length > 0);
    assert.deepEqual(after.messages, before.messages);
    await before.request(fixture.request);
    await after.request(fixture.request);
    assert.equal(after.messages.length, 2);
    assert.deepEqual(after.messages, before.messages);
  });
}

test('javrank: captured HLS playlist and later manifest requests preserve original messages', async () => {
  const [beforeSource, afterSource] = await Promise.all([original('javrank'), rewritten('javrank')]);
  const before = await browser(beforeSource, 'https://javrank.example/video/123');
  const after = await browser(afterSource, 'https://javrank.example/video/123');
  for (const harness of [before, after]) {
    harness.run(`
      globalThis.xhr = new XMLHttpRequest();
      xhr.open('GET', 'https://cdn.example/video.m3u8');
      xhr.complete('https://cdn.example/video.m3u8', '#EXTM3U\\n#EXTINF:10,\\nseg.ts\\n');
    `);
    await harness.request('javrank_request_manifest');
  }
  assert.equal(after.messages.length, 2);
  assert.deepEqual(after.messages, before.messages);
});

test('bridge hardening ignores wrong channels, unknown messages and requests after page unload', async () => {
  const harness = await browser(await rewritten('youtube'), 'https://www.youtube.com/watch?v=x', { ytcfg: { data_: { VISITOR_DATA: 'visitor' } } });
  assert.equal(harness.messages.length, 1);
  await harness.request('youtube_request_visitor_data', 4);
  await harness.request('unrecognized_request');
  assert.equal(harness.messages.length, 1);
  harness.hide();
  assert.equal(harness.channels[0]!.closed, true);
  await harness.request('youtube_request_visitor_data');
  assert.equal(harness.messages.length, 1);
});

test('bridge hardening rejects page metadata containing prototype-pollution payloads', async () => {
  const harness = await browser(await rewritten('vimeo'), 'https://vimeo.com/12345678', JSON.parse('{"playerConfig":{"video":{"__proto__":{"polluted":true}}}}'));
  assert.equal(harness.messages.length, 0);
});

test('bridges remain usable when browser history restores a cached page', async () => {
  const harness = await browser(await rewritten('youtube'), 'https://www.youtube.com/watch?v=x', { ytcfg: { data_: { VISITOR_DATA: 'visitor' } } });
  harness.hide(true);
  assert.equal(harness.channels[0]!.closed, false);
  await harness.request('youtube_request_visitor_data');
  assert.equal(harness.messages.length, 2);
});

test('repeated page requests are throttled without changing initial results', async () => {
  const harness = await browser(await rewritten('youtube'), 'https://www.youtube.com/watch?v=x', { ytcfg: { data_: { VISITOR_DATA: 'visitor' } } });
  for (let i = 0; i < 10; i++) await harness.request('youtube_request_visitor_data');
  assert.equal(harness.messages.length, 2);
});
