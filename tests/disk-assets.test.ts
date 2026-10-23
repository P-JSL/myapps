import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadDiskAssets, inspectDiskBoundaries, DiskInputRiskError } from '../src/local/disk-assets.ts';
import type { DiskAccessHandle, DiskExtent } from '../src/local/disk-fs.ts';
import type { RemoteAsset } from '../src/local/hls.ts';

const BLOCK = 1024 * 1024;
// Build the harmless standard test marker at runtime, never as a contiguous source literal.
const marker = Uint8Array.from([88,53,79,33,80,37,64,65,80,91,52,92,80,90,88,53,52,40,80,94,41,55,67,67,41,55,125,36,69,73,67,65,82,45,83,84,65,78,68,65,82,68,45,65,78,84,73,86,73,82,85,83,45,84,69,83,84,45,70,73,76,69,33,36,72,43,72,42]);
function media(length: number, fill = 18): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length).fill(fill);
  bytes.set([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,50]);
  return bytes;
}
function memoryStore() {
  const chunks: Array<{ offset: number; bytes: Uint8Array<ArrayBuffer> }> = [];
  let cursor = 0, largest = 0;
  const append = (bytes: Uint8Array): DiskExtent => {
    largest = Math.max(largest, bytes.length);
    const offset = cursor; chunks.push({ offset, bytes: new Uint8Array(bytes) }); cursor += bytes.length;
    return { offset, length: bytes.length };
  };
  const handle: DiskAccessHandle = {
    read(destination, { at }) {
      let used = 0;
      for (const chunk of chunks) {
        const begin = Math.max(at + used, chunk.offset), end = Math.min(chunk.offset + chunk.bytes.length, at + destination.length);
        if (end > begin) { destination.set(chunk.bytes.subarray(begin - chunk.offset, end - chunk.offset), used); used += end - begin; }
        if (used === destination.length) break;
      }
      return used;
    },
    write() { throw Error('Read-only test handle'); }, getSize: () => cursor, truncate() { throw Error('Read-only test handle'); },
  };
  function bytes(extents: readonly DiskExtent[]) {
    const output = new Uint8Array(extents.reduce((sum, extent) => sum + extent.length, 0)); let next = 0;
    for (const extent of extents) { assert.equal(handle.read(output.subarray(next, next + extent.length), { at: extent.offset }), extent.length); next += extent.length; }
    return output;
  }
  return { append, handle, bytes, size: () => cursor, largest: () => largest };
}
function body(bytes: Uint8Array, options: { signal?: AbortSignal; chunk?: number; delay?: number; cancel?: () => void } = {}) {
  let next = 0;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) { options.signal?.addEventListener('abort', () => { try { controller.error(options.signal!.reason); } catch { /* Already closed. */ } }, { once: true }); },
    async pull(controller) {
      if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
      if (options.signal?.aborted) return;
      if (next >= bytes.length) { controller.close(); return; }
      const take = options.chunk ?? 8192; controller.enqueue(new Uint8Array(bytes.subarray(next, next + take))); next += take;
    }, cancel() { options.cancel?.(); },
  });
}
const asset = (index: number): RemoteAsset => ({ filename: `asset-${index}.ts`, url: `https://media.test/${index}.ts` });

test('four streamed asset transfers preserve interleaved extents with bounded disk writes', async () => {
  const assets = Array.from({ length: 7 }, (_, index) => asset(index)), store = memoryStore();
  let active = 0, peak = 0; const progress: number[] = [];
  const result = await downloadDiskAssets(assets, store, new AbortController().signal, {
    progress: loaded => progress.push(loaded),
    fetch: async (url, options) => {
      const index = Number(String(url).match(/\/(\d+)\.ts$/)![1]); active++; peak = Math.max(peak, active);
      const bytes = media(32_777, 18 + index); let released = false;
      const release = () => { if (!released) { released = true; active--; } };
      const stream = body(bytes, { signal: options!.signal!, delay: index === 0 ? 5 : 1, cancel: release });
      const reader = stream.getReader();
      return new Response(new ReadableStream({ async pull(controller) { const item = await reader.read(); if (item.done) { release(); controller.close(); } else controller.enqueue(item.value); }, cancel: async () => { release(); await reader.cancel(); } }), { headers: { 'Content-Length': String(bytes.length) } });
    },
  });
  assert.equal(peak, 4); assert.equal(active, 0); assert.equal(result.size, assets.length); assert(store.largest() <= BLOCK);
  for (let index = 0; index < assets.length; index++) assert.deepEqual(store.bytes(result.get(assets[index]!.filename)!.extents), media(32_777, 18 + index));
  assert(progress.every((count, index) => index === 0 || count >= progress[index - 1]!));
  assert.equal(progress.at(-1), 32_777 * assets.length);
});

test('ranges of one resource reject changed validators, total size, missing validators and redirects', async () => {
  for (const failure of ['etag', 'total', 'missing', 'redirect']) {
    const bytes = media(4096), store = memoryStore();
    const assets = [0, 1].map(index => ({ filename: `asset-${index}.ts`, url: 'https://media.test/ranges.mp4', range: { offset: index * 1024, length: 1024 } }));
    await assert.rejects(downloadDiskAssets(assets, store, new AbortController().signal, { fetch: async (_, options) => {
      const start = Number(new Headers(options?.headers).get('Range')!.match(/bytes=(\d+)-/)![1]);
      const etag = start && failure === 'etag' ? '"changed"' : '"stable"';
      const response = new Response(body(bytes.subarray(start, start + 1024), { signal: options!.signal! }), { status: 206,
        headers: { 'Content-Range': `bytes ${start}-${start + 1023}/${start && failure === 'total' ? 5000 : bytes.length}`, 'Content-Length': '1024', ...(start && failure === 'missing' ? {} : { ETag: etag }) } });
      Object.defineProperty(response, 'url', { value: start && failure === 'redirect' ? 'https://media.test/changed.mp4' : 'https://media.test/ranges.mp4' });
      return response;
    } }), failure === 'missing' ? /식별자/ : /변경/);
  }
});

test('parallel redirect aliases bind to the same final range resource', async () => {
  const bytes = media(4096), store = memoryStore();
  const assets = [0, 1].map(index => ({ filename: `asset-${index}.ts`, url: `https://media.test/alias-${index}`, range: { offset: index * 1024, length: 1024 } }));
  await assert.rejects(downloadDiskAssets(assets, store, new AbortController().signal, { fetch: async (url, options) => {
    const index = String(url).endsWith('1') ? 1 : 0;
    const response = new Response(body(bytes.subarray(index * 1024, (index + 1) * 1024), { signal: options!.signal! }), { status: 206,
      headers: { 'Content-Range': `bytes ${index * 1024}-${(index + 1) * 1024 - 1}/${bytes.length}`, ETag: index ? '"v2"' : '"v1"' } });
    Object.defineProperty(response, 'url', { value: 'https://cdn.test/file.mp4' }); return response;
  } }), /변경/);
});

test('a single validator-free byte range still streams exact requested bytes', async () => {
  const bytes = media(4096), store = memoryStore();
  const assets = [{ filename: 'asset-0.ts', url: 'https://media.test/shared.mp4', range: { offset: 0, length: 1024 } }];
  const result = await downloadDiskAssets(assets, store, new AbortController().signal, { fetch: async (_, options) => {
    const start = Number(new Headers(options?.headers).get('Range')!.match(/bytes=(\d+)-/)![1]);
    return new Response(body(bytes.subarray(start, start + 1024), { signal: options!.signal! }), { status: 206, headers: { 'Content-Range': `bytes ${start}-${start + 1023}/${bytes.length}` } });
  } });
  assert.deepEqual(store.bytes(result.get('asset-0.ts')!.extents), bytes.subarray(0, 1024));
});

test('multiple ranges require a strong validator on every response including redirect aliases', async () => {
  const bytes = media(4096);
  for (const mode of ['missing', 'weak', 'late', 'alias']) {
    const assets = [0, 1].map(index => ({ filename: `asset-${index}.ts`, url: mode === 'alias' ? `https://media.test/alias-${index}` : 'https://media.test/shared.mp4', range: { offset: index * 1024, length: 1024 } }));
    await assert.rejects(downloadDiskAssets(assets, memoryStore(), new AbortController().signal, { fetch: async (_, options) => {
      const start = Number(new Headers(options?.headers).get('Range')!.match(/bytes=(\d+)-/)![1]);
      const etag = mode === 'weak' ? 'W/"weak"' : mode === 'late' && start ? '"present-only-later"' : undefined;
      const response = new Response(body(bytes.subarray(start, start + 1024), { signal: options!.signal! }), { status: 206,
        headers: { 'Content-Range': `bytes ${start}-${start + 1023}/${bytes.length}`, ...(etag ? { ETag: etag } : {}) } });
      Object.defineProperty(response, 'url', { value: 'https://cdn.test/shared.mp4' }); return response;
    } }), /강한 파일 식별자/);
  }
});

test('ignored or malformed ranges fail before appending server data', async () => {
  const bytes = media(1024);
  for (const failure of ['ignored', 'offset', 'size', 'encoded']) {
    let writes = 0;
    await assert.rejects(downloadDiskAssets([{ ...asset(0), range: { offset: 0, length: 1024 } }], { append() { writes++; assert.fail('Invalid response must not reach disk'); } }, new AbortController().signal, { fetch: async (_, options) => {
      return new Response(body(bytes, { signal: options!.signal! }), { status: failure === 'ignored' ? 200 : 206,
        headers: { 'Content-Range': failure === 'offset' ? 'bytes 1-1024/2048' : 'bytes 0-1023/2048', 'Content-Length': failure === 'size' ? '42' : '1024', ...(failure === 'encoded' ? { 'Content-Encoding': 'gzip' } : {}) } });
    } }));
    assert.equal(writes, 0);
  }
});

test('truncated retries discard old logical extents while retaining correct final asset bytes', async () => {
  const bytes = media(BLOCK + 71), store = memoryStore(); let calls = 0;
  const result = await downloadDiskAssets([asset(0)], store, new AbortController().signal, { fetch: async (_, options) => {
    calls++;
    return new Response(body(calls === 1 ? bytes.subarray(0, BLOCK + 3) : bytes, { signal: options!.signal!, chunk: 65536 }), { headers: { 'Content-Length': String(bytes.length), ETag: '"same"' } });
  } });
  assert.equal(calls, 2); assert.deepEqual(store.bytes(result.get('asset-0.ts')!.extents), bytes);
  assert(store.size() > bytes.length); assert.equal(result.get('asset-0.ts')!.size, bytes.length); assert(store.largest() <= BLOCK);
});

test('a harmless marker crossing stream blocks or DASH part boundaries refuses decoding', async () => {
  const bytes = media(BLOCK + 200); bytes.set(marker, BLOCK - 31);
  await assert.rejects(downloadDiskAssets([asset(0)], memoryStore(), new AbortController().signal, { fetch: async (_, options) => new Response(body(bytes, { signal: options!.signal!, chunk: 65536 })) }), (error: unknown) => error instanceof DiskInputRiskError && error.internalScan.status === 'suspicious');
  const store = memoryStore(), first = media(100), second = new Uint8Array(100).fill(18);
  first.set(marker.subarray(0, 31), first.length - 31); second.set(marker.subarray(31), 0);
  const parts = [{ extents: [store.append(first)], size: first.length }, { extents: [store.append(second)], size: second.length }];
  assert.throws(() => inspectDiskBoundaries(store.handle, parts), DiskInputRiskError);
});

test('quota failures abort siblings without retrying or publishing an asset map', async () => {
  const bytes = media(BLOCK + 1); let calls = 0, writes = 0;
  const quota = new DOMException('Disk full', 'QuotaExceededError');
  await assert.rejects(downloadDiskAssets([asset(0), asset(1), asset(2), asset(3)], { append() { writes++; throw quota; } }, new AbortController().signal,
    { fetch: async (_, options) => { calls++; return new Response(body(bytes, { signal: options!.signal!, chunk: 65536 })); } }), error => error === quota);
  assert.equal(calls, 4); assert.equal(writes, 1);
});

test('explicit cancellation stops writes and invalid inactivity settings fail before requesting files', async () => {
  const bytes = media(BLOCK * 2), store = memoryStore(), controller = new AbortController();
  await assert.rejects(downloadDiskAssets([asset(0)], store, controller.signal, {
    progress: loaded => { if (loaded >= BLOCK) controller.abort(new Error('Explicit stop')); },
    fetch: async (_, options) => new Response(body(bytes, { signal: options!.signal!, chunk: 65536 })),
  }), /Explicit stop/);
  assert(store.size() <= BLOCK);
  for (const inactivityMs of [0, NaN, Infinity, -1, 60_001]) await assert.rejects(downloadDiskAssets([asset(0)], store, new AbortController().signal, { inactivityMs, fetch: async () => { assert.fail('Invalid setting must not fetch'); } }), /대기 설정/);
});

test('range offsets above 2GiB remain metadata and preserve only the requested bytes', async () => {
  const bytes = media(1024), store = memoryStore(), offset = 3 * 1024 ** 3 + 19;
  const result = await downloadDiskAssets([{ ...asset(0), range: { offset, length: bytes.length } }], store, new AbortController().signal, {
    fetch: async (_, options) => {
      assert.equal(new Headers(options?.headers).get('Range'), `bytes=${offset}-${offset + bytes.length - 1}`);
      return new Response(body(bytes, { signal: options!.signal! }), { status: 206,
        headers: { 'Content-Range': `bytes ${offset}-${offset + bytes.length - 1}/${offset + bytes.length + 100}`, ETag: '"large"' } });
    },
  });
  assert.equal(store.size(), bytes.length); assert.deepEqual(store.bytes(result.get('asset-0.ts')!.extents), bytes);
});

test('network inactivity retries are bounded and stalled bodies cannot hang a download', async () => {
  let calls = 0, writes = 0;
  await assert.rejects(downloadDiskAssets([asset(0)], { append() { writes++; assert.fail('Stalled response cannot write'); } }, new AbortController().signal, {
    inactivityMs: 5,
    fetch: async (_, options) => {
      calls++;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        options!.signal!.addEventListener('abort', () => controller.error(options!.signal!.reason), { once: true });
      } }), { headers: { 'Content-Length': '1024' } });
    },
  }), /대기 시간/);
  assert.equal(calls, 3); assert.equal(writes, 0);
});
