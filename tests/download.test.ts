import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { ByteBudget, fetchBytes, fetchManifestResource, retryDelay } from '../src/local/network.ts';
import { planHls } from '../src/local/hls.ts';
import { PreparationQueue } from '../src/local/queue.ts';
import { downloadAssets } from '../src/local/assets.ts';
import { transport, transportLabel } from '../src/local/transport.ts';

async function serve(handler: RequestListener, run: (base: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
test('transport accepts actual ALPN values without treating HTTPS or Alt-Svc as observed HTTP/3', () => {
  for (const alpn of ['h3', 'h3-29']) assert.equal(transport(alpn), 'h3');
  assert.equal(transportLabel('h3'), 'HTTP/3'); assert.equal(transport('h2'), 'h2'); assert.equal(transport('http/1.1'), 'http/1.1');
  for (const value of ['', 'https', 'h3=":443"', 'h3://example.test', 'quic', null, 'HTTP/3']) assert.equal(transport(value), undefined);
});
test('Retry-After supports delay seconds and HTTP dates without shortening long server waits', () => {
  assert.equal(retryDelay('5'), 5000); assert.equal(retryDelay('120'), 120_000);
  assert.equal(retryDelay('Sun, 18 Oct 2026 12:00:05 GMT', Date.parse('2026-10-18T12:00:00Z')), 5000);
  assert.equal(retryDelay('invalid'), undefined);
});
test('GET retries transient HTTP failures and returns exactly one intact response', async () => {
  let requests = 0;
  await serve((_, response) => { requests++; if (requests < 3) response.writeHead(503, { 'Retry-After': '0' }).end('busy'); else response.end('complete'); }, async base => {
    const bytes = await fetchBytes(base, 32, new AbortController().signal);
    assert.equal(new TextDecoder().decode(bytes), 'complete'); assert.equal(requests, 3);
  });
});
test('redirected HLS masters and child playlists resolve references against each successful response URL', async () => {
  const hits: string[] = [];
  const redirects: Record<string, string> = {
    '/entry.m3u8': '/cdn/master.m3u8',
    '/cdn/video.m3u8': '/media/video/list.m3u8',
    '/cdn/audio.m3u8': '/media/audio/list.m3u8',
  };
  const playlists: Record<string, string> = {
    '/cdn/master.m3u8': '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=10,AUDIO="a"\nvideo.m3u8',
    '/media/video/list.m3u8': '#EXTM3U\n#EXTINF:1,\nvideo.ts\n#EXT-X-ENDLIST',
    '/media/audio/list.m3u8': '#EXTM3U\n#EXTINF:1,\naudio.ts\n#EXT-X-ENDLIST',
  };
  await serve((request, response) => {
    const path = request.url!; hits.push(path);
    if (redirects[path]) response.writeHead(302, { Location: redirects[path] }).end();
    else if (playlists[path]) response.end(playlists[path]);
    else response.writeHead(404).end();
  }, async base => {
    const signal = new AbortController().signal;
    const plan = await planHls(base + '/entry.m3u8', url => fetchManifestResource(url, signal));
    assert.deepEqual(plan.assets.map(asset => asset.url), [base + '/media/video/video.ts', base + '/media/audio/audio.ts']);
    assert.deepEqual(hits, ['/entry.m3u8', '/cdn/master.m3u8', '/cdn/video.m3u8', '/media/video/list.m3u8', '/cdn/audio.m3u8', '/media/audio/list.m3u8']);
    const resource = await fetchManifestResource(base + '/entry.m3u8', signal);
    assert.equal(resource.url, base + '/cdn/master.m3u8');
    assert.equal(resource.text, playlists['/cdn/master.m3u8']);
  });
});
test('authorization failures and long rate-limit waits are not repeatedly requested', async () => {
  const hits: Record<string, number> = {};
  await serve((request, response) => { const path = request.url!; hits[path] = (hits[path] ?? 0) + 1; response.writeHead(path === '/auth' ? 403 : 429, { 'Retry-After': '120' }).end('stop'); }, async base => {
    await assert.rejects(fetchBytes(base + '/auth', 32, new AbortController().signal), /403/);
    await assert.rejects(fetchBytes(base + '/rate', 32, new AbortController().signal), /긴 대기/);
    assert.deepEqual(hits, { '/auth': 1, '/rate': 1 });
  });
});
test('cancellation during retry backoff starts no further network request', async () => {
  let hits = 0; const controller = new AbortController();
  await serve((_, response) => { hits++; response.writeHead(503, { 'Retry-After': '1' }).end(); setTimeout(() => controller.abort(), 25); }, async base => {
    await assert.rejects(fetchBytes(base, 32, controller.signal)); assert.equal(hits, 1);
  });
});
test('cancellation after body completion during timing observation rejects and releases its byte reservation', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'PerformanceObserver');
  Object.defineProperty(globalThis, 'PerformanceObserver', { configurable: true, value: class { observe() {} disconnect() {} } });
  const controller = new AbortController(); const budget = new ByteBudget(8); let hits = 0;
  try {
    await serve((_, response) => { hits++; response.end('data'); }, async base => {
      await assert.rejects(fetchBytes(base, 8, controller.signal, undefined, { budget, progress: () => { setTimeout(() => controller.abort(), 5); } }));
      assert.equal(hits, 1); assert.equal(budget.remaining, 8);
    });
  } finally {
    if (original) Object.defineProperty(globalThis, 'PerformanceObserver', original);
    else Reflect.deleteProperty(globalThis, 'PerformanceObserver');
  }
});
test('partial responses without a range and malformed range totals are rejected', async () => {
  let hits = 0;
  await serve((_, response) => { hits++; response.writeHead(206, { 'Content-Range': 'bytes 2-4/4' }).end('234'); }, async base => {
    await assert.rejects(fetchBytes(base, 10, new AbortController().signal), /일부/);
    await assert.rejects(fetchBytes(base, 10, new AbortController().signal, { offset: 2, length: 3 }), /범위/);
    assert.equal(hits, 2);
  });
});
test('failed/truncated attempts return their reservations before a retry', async () => {
  let hits = 0; const budget = new ByteBudget(4);
  await serve((_, response) => {
    hits++;
    if (hits === 1) { response.writeHead(200, { 'Content-Length': 4 }); response.write('xx'); setTimeout(() => response.destroy(), 10); }
    else response.end('done');
  }, async base => {
    const bytes = await fetchBytes(base, 4, new AbortController().signal, undefined, { budget });
    assert.equal(new TextDecoder().decode(bytes), 'done'); assert.equal(budget.remaining, 0); assert.equal(hits, 2);
  });
});
test('range fallback retains only the requested bytes in the shared budget', async () => {
  const budget = new ByteBudget(10);
  await serve((_, response) => response.end('0123456789'), async base => {
    assert.equal(new TextDecoder().decode(await fetchBytes(base, 10, new AbortController().signal, { offset: 2, length: 3 }, { budget })), '234');
    assert.equal(budget.remaining, 7);
  });
});
test('parallel requests cannot exceed their shared retained-byte limit', async () => {
  const budget = new ByteBudget(8);
  await serve((_, response) => response.end('1234'), async base => {
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => fetchBytes(base, 8, new AbortController().signal, undefined, { budget })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
    assert.equal(results.filter(r => r.status === 'rejected').length, 1); assert.equal(budget.remaining, 0);
  });
});
test('segments run concurrently with a maximum of three and keep filename/data associations', async () => {
  let active = 0, peak = 0; const received = new Map<string, string>(); const progress: number[] = [];
  await serve((request, response) => { active++; peak = Math.max(peak, active); setTimeout(() => { active--; response.end(request.url); }, 20); }, async base => {
    const assets = Array.from({ length: 7 }, (_, i) => ({ filename: `asset-${i}.ts`, url: `${base}/${i}` }));
    await downloadAssets(assets, (name, bytes) => { received.set(name, new TextDecoder().decode(bytes)); }, new AbortController().signal, completed => progress.push(completed));
    assert.equal(peak, 3); assert.deepEqual(progress, [1, 2, 3, 4, 5, 6, 7]);
    for (let i = 0; i < 7; i++) assert.equal(received.get(`asset-${i}.ts`), `/${i}`);
  });
});
test('preparation queue is FIFO, bounded and removes a cancelled waiting job', async () => {
  const queue = new PreparationQueue(3); const order: string[] = [];
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const first = queue.run('first', async () => { order.push('first'); await gate; return 1; });
  const cancelled = queue.run('cancelled', async () => { throw new Error('cancelled work must not start'); });
  const next = queue.run('next', async () => { order.push('next'); return 2; });
  await assert.rejects(queue.run('overflow', async () => 0), /대기열/);
  await assert.rejects(queue.run('first', async () => 0), /이미/);
  const rejected = assert.rejects(cancelled, /취소/); queue.cancel('cancelled'); await rejected;
  release(); assert.equal(await first, 1); assert.equal(await next, 2); assert.deepEqual(order, ['first', 'next']);
});
test('cancelling a running preparation releases the next queued job', async () => {
  const queue = new PreparationQueue();
  const first = queue.run('first', signal => new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const next = queue.run('next', async () => 'ready');
  const rejected = assert.rejects(first); queue.cancel('first'); await rejected; assert.equal(await next, 'ready');
});
