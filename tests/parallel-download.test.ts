import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { downloadParallelFile, type PositionedSink } from '../src/local/parallel-download.ts';
import { InvalidMediaFileError } from '../src/local/media-file.ts';

const PREFIX = 65_536, CHUNK = 65_536;
function media(length: number) {
  const data = Uint8Array.from({ length }, (_, index) => index * 31 % 251);
  data.set([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,50]);
  return data;
}
function collected(size: number) {
  const bytes = new Uint8Array(size), writes: number[] = [];
  const sink: PositionedSink = { async write(position, data) { writes.push(position); bytes.set(data, position); } };
  return { bytes, writes, sink };
}
function stream(bytes: Uint8Array, chunk = 8192, cancel?: () => void): ReadableStream<Uint8Array<ArrayBuffer>> {
  let next = 0;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(controller) {
    if (next >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(next, next + chunk)); next += chunk;
  }, ...(cancel ? { cancel } : {}) });
}
function partial(data: Uint8Array, start: number, end: number, etag?: string, total = data.length) {
  return new Response(stream(data.subarray(start, end + 1)), { status: 206,
    headers: { 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(end - start + 1), ...(etag ? { ETag: etag } : {}) } });
}
function range(options?: RequestInit): [number, number] | undefined {
  const value = new Headers(options?.headers).get('Range');
  const match = value?.match(/^bytes=(\d+)-(\d+)$/);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}
async function serve(handler: RequestListener, run: (address: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  try { await run(`http://127.0.0.1:${address.port}/movie.mp4`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('four actual HTTP range transfers merge out-of-order chunks into exactly one original file', async () => {
  const data = media(PREFIX + CHUNK * 7 + 19), target = collected(data.length);
  let active = 0, maximum = 0; const progress: number[] = [], completed: number[] = [];
  await serve((request, response) => {
    const match = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/); assert(match);
    const start = Number(match[1]), end = Math.min(Number(match[2]), data.length - 1);
    if (start) assert.equal(request.headers['if-range'], '"stable-v1"');
    response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1, ETag: '"stable-v1"' });
    if (!start) { response.end(data.subarray(start, end + 1)); return; }
    active++; maximum = Math.max(maximum, active);
    setTimeout(() => { active--; completed.push(start); response.end(data.subarray(start, end + 1)); }, start === PREFIX ? 60 : 5);
  }, async address => {
    const result = await downloadParallelFile(address, target.sink, new AbortController().signal, { chunkBytes: CHUNK, progress: count => progress.push(count) });
    assert.equal(result.mode, 'parallel'); assert.equal(result.size, data.length); assert.equal(result.format?.extension, 'mp4');
    assert.deepEqual(result.prefix, data.slice(0, PREFIX));
  });
  assert.equal(maximum, 4); assert.notEqual(completed[0], PREFIX);
  assert.deepEqual(target.bytes, data); assert.equal(new Set(target.writes).size, target.writes.length);
  assert(progress.every((value, index) => index === 0 || value > progress[index - 1]!)); assert.equal(progress.at(-1), data.length);
});

test('ignored Range streams its existing 200 response once with bounded writes, without arrayBuffer', async () => {
  const data = media(PREFIX * 4 + 9), target = collected(data.length); let calls = 0, largest = 0;
  const fetcher: typeof fetch = async (_, options) => {
    calls++; assert.deepEqual(range(options), [0, PREFIX - 1]);
    const response = new Response(stream(data), { headers: { 'Content-Length': String(data.length), 'Content-Type': 'text/plain' } });
    response.arrayBuffer = async () => { assert.fail('Whole-file arrayBuffer is forbidden'); };
    return response;
  };
  const result = await downloadParallelFile('https://media.test/a.txt', { async write(position, bytes) { largest = Math.max(largest, bytes.length); await target.sink.write(position, bytes); } }, new AbortController().signal, { fetch: fetcher });
  assert.equal(result.mode, 'single'); assert.equal(calls, 1); assert(largest <= PREFIX);
  assert.deepEqual(target.bytes, data); assert.equal(result.format?.extension, 'mp4');
});

test('a partial response without a strong validator falls back to one complete request', async () => {
  for (const etag of [undefined, 'W/"weak"']) {
    const data = media(PREFIX + 91), target = collected(data.length); const requests: unknown[] = [];
    const result = await downloadParallelFile('https://media.test/a.mp4', target.sink, new AbortController().signal, { fetch: async (_, options) => {
      requests.push(range(options));
      return range(options) ? partial(data, 0, PREFIX - 1, etag) : new Response(stream(data));
    } });
    assert.equal(result.mode, 'single'); assert.deepEqual(requests, [[0, PREFIX - 1], undefined]); assert.deepEqual(target.bytes, data);
  }
});

test('large ID3 artwork remains provisional until the caller inspects the actual final frame', async () => {
  const data = new Uint8Array(100_000), frameOffset = 80_000;
  data.set([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]);
  const tagBytes = frameOffset - 10;
  for (let index = 0; index < 4; index++) data[9 - index] = (tagBytes >>> (index * 7)) & 127;
  data.set([0xff, 0xfb, 0x90, 0], frameOffset);
  const target = collected(data.length);
  const result = await downloadParallelFile('https://media.test/a.mp3', target.sink, new AbortController().signal, {
    fetch: async () => new Response(stream(data)),
  });
  assert.equal(result.format, undefined); assert.equal(result.prefix.length, PREFIX); assert.deepEqual(target.bytes, data);
  data[6] = 128;
  await assert.rejects(downloadParallelFile('https://media.test/a.mp3', { async write() { assert.fail('Invalid ID3 must not write'); } }, new AbortController().signal, {
    fetch: async () => new Response(stream(data)),
  }), InvalidMediaFileError);
});

test('multi-gigabyte size is metadata only and cancellation stops outstanding ranges without huge allocation', async () => {
  const total = 3 * 1024 ** 3 + 19, prefix = media(PREFIX), controller = new AbortController();
  let calls = 0, written = 0, observedTotal = 0;
  const pending = downloadParallelFile('https://media.test/big.mp4', { async write(position, data) { assert.equal(position, 0); written += data.length; } }, controller.signal, {
    progress: (_, size) => { observedTotal = size!; },
    fetch: async (_, options) => {
      const requested = range(options)!; calls++;
      if (requested[0] === 0) return partial(prefix, 0, PREFIX - 1, '"gb"', total);
      assert.equal(new Headers(options?.headers).get('If-Range'), '"gb"');
      queueMicrotask(() => controller.abort(new Error('Stopped after gigabyte metadata')));
      return new Response(new ReadableStream(), { status: 206, headers: { ETag: '"gb"', 'Content-Range': `bytes ${requested[0]}-${requested[1]}/${total}` } });
    },
  });
  await assert.rejects(pending, /gigabyte metadata/);
  assert.equal(observedTotal, total); assert.equal(written, PREFIX); assert(calls >= 2 && calls <= 5);
});

test('changed validators, totals, redirects, ignored ranges and compressed partial data never return a merged file', async () => {
  const data = media(PREFIX + 100);
  for (const failure of ['etag', 'total', 'redirect', 'range', 'encoding', 'length']) {
    let calls = 0;
    await assert.rejects(downloadParallelFile('https://media.test/a.mp4', collected(data.length).sink, new AbortController().signal, { fetch: async (_, options) => {
      const [start, end] = range(options)!; calls++;
      if (start === 0) return partial(data, start, end, '"v1"');
      const response = partial(data, start, end, failure === 'etag' ? '"v2"' : '"v1"', failure === 'total' ? data.length + 1 : data.length);
      if (failure === 'redirect') Object.defineProperty(response, 'url', { value: 'https://changed.test/a.mp4' });
      if (failure === 'range') return new Response(stream(data), { headers: { ETag: '"v1"' } });
      if (failure === 'encoding') response.headers.set('Content-Encoding', 'gzip');
      if (failure === 'length') response.headers.set('Content-Length', '1');
      return response;
    } }));
    assert.equal(calls, 2, `Invalid ${failure} must not retry or redownload the whole file`);
  }
});

test('a truncated part retries before committing and transient HTTP failures use bounded retries', async () => {
  const data = media(PREFIX + 113), target = collected(data.length); let probes = 0, parts = 0;
  await downloadParallelFile('https://media.test/a.mp4', target.sink, new AbortController().signal, { fetch: async (_, options) => {
    const [start, end] = range(options)!;
    if (!start && ++probes === 1) return new Response('retry', { status: 503, headers: { 'Retry-After': '0' } });
    if (!start) return partial(data, start, end, '"same"');
    parts++;
    if (parts === 1) return new Response(stream(data.subarray(start, end)), { status: 206, headers: { ETag: '"same"', 'Content-Range': `bytes ${start}-${end}/${data.length}` } });
    return partial(data, start, end, '"same"');
  } });
  assert.equal(probes, 2); assert.equal(parts, 2); assert.deepEqual(target.bytes, data); assert.deepEqual(target.writes, [0, PREFIX]);
});

test('HTML masquerading as a video is rejected and its body is canceled before any disk write', async () => {
  let canceled = 0, writes = 0;
  await assert.rejects(downloadParallelFile('https://media.test/a.mp4', { async write() { writes++; } }, new AbortController().signal, {
    fetch: async () => new Response(stream(new TextEncoder().encode('<html>' + 'x'.repeat(PREFIX * 2)), 8192, () => { canceled++; }), { headers: { 'Content-Type': 'video/mp4' } }),
  }), InvalidMediaFileError);
  assert.equal(writes, 0); assert.equal(canceled, 1);
});

test('network inactivity is bounded, but slow disk backpressure does not consume network inactivity time', async () => {
  const controller = new AbortController();
  await assert.rejects(downloadParallelFile('https://media.test/a.mp4', { async write() { assert.fail(); } }, controller.signal, {
    inactivityMs: 5, fetch: async () => new Promise<Response>(() => {}),
  }), /대기 시간/);
  const data = media(PREFIX + 7), target = collected(data.length);
  const result = await downloadParallelFile('https://media.test/a.mp4', { async write(position, bytes) { await new Promise(resolve => setTimeout(resolve, 12)); await target.sink.write(position, bytes); } }, controller.signal, {
    inactivityMs: 5, fetch: async () => new Response(stream(data)),
  });
  assert.equal(result.size, data.length); assert.deepEqual(target.bytes, data);
});

test('unsafe range sizes and malformed probe ranges are rejected before any file allocation', async () => {
  for (const header of ['bytes 0-65535/9007199254740992', 'bytes 1-65535/100000', 'bytes 0-4/100000']) {
    let writes = 0;
    await assert.rejects(downloadParallelFile('https://media.test/a.mp4', { async write() { writes++; } }, new AbortController().signal, {
      fetch: async () => new Response(stream(media(PREFIX)), { status: 206, headers: { 'Content-Range': header } }),
    }), /범위/);
    assert.equal(writes, 0);
  }
});
