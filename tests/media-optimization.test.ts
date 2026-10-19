import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chooseQuality, QUALITIES, type Quality } from '../src/local/preferences.ts';
import { assembleBytes } from '../src/local/byte-assembly.ts';
import { ByteBudget, fetchBytes } from '../src/local/network.ts';
import { planHls } from '../src/local/hls.ts';

// Behavioral oracle copied from the implementation before the optimization.
function previousQuality<T>(items: T[], quality: Quality, height: (item: T) => number, bandwidth: (item: T) => number): T | undefined {
  const known = items.filter(item => Number.isFinite(height(item)) && height(item) > 0);
  const ranked = (values: T[]) => [...values].sort((a, b) => height(b) - height(a) || bandwidth(b) - bandwidth(a))[0];
  if (!known.length) return [...items].sort((a, b) => bandwidth(b) - bandwidth(a))[0];
  if (quality === 'highest') return ranked(known);
  const eligible = known.filter(item => height(item) <= Number(quality));
  if (eligible.length) return ranked(eligible);
  const minimum = Math.min(...known.map(height));
  return ranked(known.filter(item => height(item) === minimum));
}

test('quality selection preserves the stable-sort oracle across ceilings, ties and nonfinite metadata', () => {
  let state = 0x12345678;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const heights = [NaN, Infinity, -Infinity, -1, 0, 360, 480, 720, 1080, 2160];
  const bandwidths = [NaN, Infinity, -Infinity, -1, 0, 1, 1, 100, 200, 500];
  for (let sample = 0; sample < 700; sample++) {
    const items = Array.from({ length: random() % 161 }, (_, id) => ({ id, height: heights[random() % heights.length]!, bandwidth: bandwidths[random() % bandwidths.length]! }));
    const original = [...items];
    for (const quality of QUALITIES) assert.equal(chooseQuality(items, quality, item => item.height, item => item.bandwidth), previousQuality(items, quality, item => item.height, item => item.bandwidth));
    assert.deepEqual(items, original, 'selection must preserve source ordering');
  }
  const values = [undefined, { id: 'later' }];
  assert.equal(chooseQuality(values, 'highest', () => 0, () => 5), undefined, 'undefined can itself be the first tied item');
});

test('finite quality selection bounds metadata reads linearly and keeps the first tied rendition', () => {
  const items = Array.from({ length: 4096 }, (_, id) => ({ id, height: 720, bandwidth: 100 }));
  let heights = 0, bandwidths = 0;
  const selected = chooseQuality(items, '1080', item => { heights++; return item.height; }, item => { bandwidths++; return item.bandwidth; });
  assert.equal(selected, items[0]);
  assert.equal(heights, items.length * 2);
  assert.equal(bandwidths, items.length);
});

test('HLS audio selection preserves the first default in its chosen group and the first fallback', async () => {
  for (const defaults of [true, false]) {
    const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="other",DEFAULT=YES,URI="wrong.m3u8"\n'
      + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="first.m3u8"\n'
      + `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",DEFAULT=${defaults ? 'YES' : 'NO'},URI="default.m3u8"\n`
      + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",DEFAULT=YES,URI="later.m3u8"\n'
      + '#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=640x360,AUDIO="audio"\nvideo.m3u8';
    const text = defaults ? master : master.replace('DEFAULT=YES,URI="later.m3u8"', 'DEFAULT=NO,URI="later.m3u8"');
    const loaded: string[] = [];
    const plan = await planHls('https://media.test/master.m3u8', async address => {
      loaded.push(address);
      return address.endsWith('/master.m3u8') ? text : `#EXTM3U\n#EXTINF:1,\n${address.split('/').at(-1)!.replace('.m3u8', '.ts')}\n#EXT-X-ENDLIST`;
    });
    assert.equal(plan.assets[1]!.url, `https://media.test/${defaults ? 'default' : 'first'}.ts`);
    assert.equal(loaded.length, 3);
    assert.ok(!loaded.some(address => /wrong|later/.test(address)));
  }
});

test('byte assembly preserves exact bytes across chunk boundaries and returns an exact backing buffer', () => {
  const bytes = Uint8Array.from({ length: 8192 }, (_, index) => index % 251);
  const chunks = [bytes.subarray(0, 3), bytes.subarray(3, 4097), bytes.subarray(4097)];
  for (const [offset, length] of [[0, bytes.length], [2, 5], [4090, 14], [bytes.length - 7, 7]]) {
    const result = assembleBytes(chunks, bytes.length, offset, length);
    assert.deepEqual(result, bytes.slice(offset, offset! + length!));
    assert.equal(result.byteOffset, 0); assert.equal(result.buffer.byteLength, length);
  }
  const whole = assembleBytes([bytes], bytes.length);
  assert.equal(whole.buffer, bytes.buffer, 'a complete fetch chunk needs no second allocation');
  const window = assembleBytes([bytes.subarray(2, 7)], 5);
  assert.deepEqual(window, bytes.slice(2, 7)); assert.equal(window.buffer.byteLength, 5); assert.notEqual(window.buffer, bytes.buffer);
  const shared = new Uint8Array(new SharedArrayBuffer(5)); shared.set([1, 2, 3, 4, 5]);
  const owned = assembleBytes([shared], shared.length);
  assert.ok(owned.buffer instanceof ArrayBuffer); assert.deepEqual([...owned], [...shared]);
});

test('ignored HTTP ranges still read and budget the entire body before retaining only the requested bytes', async () => {
  const bytes = Buffer.from(Uint8Array.from({ length: 65536 }, (_, index) => index % 251));
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.headers.range, 'bytes=65529-65535');
    response.writeHead(200, { 'Content-Length': bytes.length });
    response.write(bytes.subarray(0, 4096)); response.end(bytes.subarray(4096));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try {
    const budget = new ByteBudget(bytes.length);
    let observed = 0;
    const result = await fetchBytes(`http://127.0.0.1:${address.port}/ignored`, bytes.length, new AbortController().signal, { offset: bytes.length - 7, length: 7 }, {
      budget,
      progress: loaded => { observed = loaded; assert.equal(budget.remaining, bytes.length - loaded); },
    });
    assert.deepEqual(result, new Uint8Array(bytes.subarray(-7)));
    assert.equal(observed, bytes.length); assert.equal(requests, 1);
    assert.equal(result.buffer.byteLength, 7); assert.equal(budget.remaining, bytes.length - 7);
    const tooSmall = new ByteBudget(bytes.length - 1);
    await assert.rejects(fetchBytes(`http://127.0.0.1:${address.port}/ignored`, bytes.length, new AbortController().signal, { offset: bytes.length - 7, length: 7 }, { budget: tooSmall }), /한도/);
    assert.equal(tooSmall.remaining, bytes.length - 1, 'failed reads release every reserved chunk');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
