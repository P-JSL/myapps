import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchOverWire, serveFetch, requestHeaders, type FetchWire } from '../src/local/page-fetch.ts';
import { fetchManifestResource } from '../src/local/network.ts';
import { downloadDiskAssets } from '../src/local/disk-assets.ts';
import { planHls } from '../src/local/hls.ts';
import { downloadOptions } from '../src/local/preferences.ts';
import { isMissavAssetURL } from '../src/local/missav.ts';

const root = 'https://surrit.com/a1b2c3d4-1234-5678-abcd-1234567890ab/';
const manifest = root + '1080p/video.m3u8?sig=Case%2FExact';
function pair(binary = false): [FetchWire, FetchWire] {
  const listeners: Array<((value: unknown) => void) | undefined> = [];
  const disconnected: Array<(() => void) | undefined> = [];
  const closed = [false, false];
  return [0, 1].map(index => ({ binary,
    send(value: unknown) { if (closed[index]) throw new Error('closed'); const copy: unknown = binary ? structuredClone(value) : JSON.parse(JSON.stringify(value)); queueMicrotask(() => listeners[1 - index]?.(copy)); },
    listen(listener: (value: unknown) => void) { listeners[index] = listener; },
    disconnected(listener: () => void) { disconnected[index] = listener; },
    close() { if (!closed[index]) { closed[index] = true; queueMicrotask(() => disconnected[1 - index]?.()); } },
  })) as [FetchWire, FetchWire];
}
function relay(fetcher: typeof fetch, binary = false): typeof fetch {
  return fetchOverWire(() => {
    const [client, server] = pair(binary);
    serveFetch(server, fetcher, address => isMissavAssetURL(address, manifest));
    return client;
  });
}

for (const binary of [false, true]) test(`stream a response with bounded pulls over ${binary ? 'worker' : 'Chrome JSON'} messages`, async () => {
  const bytes = Uint8Array.from({ length: 1024 * 1024 + 137 }, (_, index) => index % 256);
  let pulls = 0, stopped = false;
  const fetcher = relay(async (_input, options) => {
    assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'error');
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; if (pulls === 1) controller.enqueue(bytes); else controller.close(); },
      cancel() { stopped = true; },
    }), { headers: { 'Content-Length': String(bytes.length), 'Content-Type': 'video/mp2t' } });
  }, binary);
  const response = await fetcher(root + '1080p/segment.ts');
  assert.equal(response.url, root + '1080p/segment.ts');
  assert.equal(response.status, 200);
  assert.equal(pulls, 1, 'headers must not drain the response');
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) { const next = await reader.read(); if (next.done) break; assert(next.value.length <= 128 * 1024); chunks.push(next.value); }
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(bytes));
  assert.equal(pulls, 2); assert.equal(stopped, false);
});

test('cancelling a pending page request aborts its actual source request', async () => {
  const controller = new AbortController();
  let aborted = false;
  const fetcher = relay(async (_input, options) => await new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); });
  }));
  const pending = fetcher(manifest, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(aborted, true);
});

test('a different host, video UUID, local address, credentials or port never reaches fetch', async () => {
  let requests = 0;
  const fetcher = relay(async () => { requests++; return new Response('unexpected'); });
  for (const url of ['https://evil.test/file', 'http://127.0.0.1/private', root.replace('surrit.com', 'surrit.com.evil.test') + 'file.ts',
    root.replace('surrit.com', 'name:password@surrit.com') + 'file.ts', root.replace('surrit.com', 'surrit.com:8443') + 'file.ts',
    root.replace('a1b2c3d4', '11111111') + 'segment.ts']) await assert.rejects(fetcher(url));
  assert.equal(requests, 0);
});

test('never relay cookies, authorization, origin or arbitrary headers', () => {
  for (const name of ['Cookie', 'Authorization', 'Origin', 'Referer', 'X-Custom']) assert.throws(() => requestHeaders({ [name]: 'secret' }));
  assert.throws(() => requestHeaders({ Range: 'bytes=0-1\r\nCookie: value' }));
  assert.deepEqual(requestHeaders({ Range: 'bytes=1-9', 'If-Match': '"revision"' }), { Range: 'bytes=1-9', 'If-Match': '"revision"' });
});

test('use the relay for HLS discovery and every media segment, preserving failed status codes', async () => {
  const hit: string[] = [];
  const fetcher = relay(async input => {
    const url = String(input); hit.push(url);
    if (url === manifest) return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nseg.ts\n#EXT-X-ENDLIST\n');
    if (url === root + '1080p/seg.ts') return new Response(new Uint8Array([0x47, 1, 2, 3]));
    return new Response('Forbidden', { status: 403 });
  });
  const signal = new AbortController().signal;
  const plan = await planHls(manifest, url => fetchManifestResource(url, signal, undefined, fetcher), downloadOptions(), true);
  let written = 0;
  const assets = await downloadDiskAssets(plan.assets, { append(bytes) { const offset = written; written += bytes.length; return { offset, length: bytes.length }; } }, signal, { fetch: fetcher });
  assert.equal(assets.size, 1); assert.equal(written, 4);
  assert.deepEqual(hit, [manifest, root + '1080p/seg.ts']);
  await assert.rejects(fetchManifestResource(root + 'blocked.m3u8', signal, undefined, fetcher), /403/);
});

test('a content-script disconnect fails the in-flight request rather than leaving it waiting', async () => {
  const fetcher = fetchOverWire(() => {
    const [client, server] = pair(); queueMicrotask(() => server.close()); return client;
  });
  await assert.rejects(fetcher(manifest), /연결이 끊겼/);
});
