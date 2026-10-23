import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { brotliCompressSync } from 'node:zlib';
import test from 'node:test';
import { BrotliDecStream } from 'brotli-dec-wasm/web';
import decodeBrotli from '../scripts/lib/browser-brotli.mjs';

const wasmBinary = new Uint8Array(await readFile(new URL('../node_modules/brotli-dec-wasm/pkg/brotli_dec_wasm_bg.wasm', import.meta.url)));
const sample = Uint8Array.from({ length: 262_157 }, (_, i) => (i * 17 + (i >>> 8)) & 255);
const compressed = brotliCompressSync(sample);

test('bounded Brotli decoder recovers after invalid bootstrap bytes and preserves exact binary bytes', async () => {
  await assert.rejects(decodeBrotli(compressed, { expectedBytes: sample.length, wasmBinary: new Uint8Array([0]) }));
  assert.deepEqual(await decodeBrotli(compressed, { expectedBytes: sample.length, wasmBinary }), sample);
});

test('Brotli decoder rejects truncation, trailing data, corrupted input and wrong exact output sizes', async () => {
  for (const input of [compressed.subarray(0, compressed.length - 1), Buffer.concat([compressed, Buffer.from([0])]), new Uint8Array(100)]) {
    await assert.rejects(decodeBrotli(input, { expectedBytes: sample.length, wasmBinary }));
  }
  for (const expectedBytes of [sample.length - 1, sample.length + 1]) {
    await assert.rejects(decodeBrotli(compressed, { expectedBytes, wasmBinary }), /invalid size/);
  }
});

test('decoder bounds highly compressed expansion and releases native state on failure', async t => {
  const input = brotliCompressSync(Buffer.alloc(4 * 1024 * 1024, 97));
  const original = BrotliDecStream.prototype.free;
  let freed = 0;
  t.mock.method(BrotliDecStream.prototype, 'free', function () { freed++; return original.call(this); });
  await assert.rejects(decodeBrotli(input, { expectedBytes: 65_536, wasmBinary }), /invalid size/);
  assert.equal(freed, 1);
  assert.deepEqual(await decodeBrotli(compressed, { expectedBytes: sample.length, wasmBinary }), sample);
  assert.equal(freed, 2);
});

test('decoder respects pre-abort and mid-stream cancellation, frees state and remains reusable', async t => {
  const input = brotliCompressSync(Buffer.alloc(4 * 1024 * 1024, 98));
  const pre = new AbortController(); pre.abort();
  await assert.rejects(decodeBrotli(input, { expectedBytes: 4 * 1024 * 1024, wasmBinary, signal: pre.signal }), { name: 'AbortError' });
  const active = new AbortController();
  const originalDec = BrotliDecStream.prototype.dec, originalFree = BrotliDecStream.prototype.free;
  let calls = 0, freed = 0;
  t.mock.method(BrotliDecStream.prototype, 'dec', function (...args) { calls++; return originalDec.apply(this, args); });
  t.mock.method(BrotliDecStream.prototype, 'free', function () { freed++; return originalFree.call(this); });
  const timer = setTimeout(() => active.abort(), 0);
  try { await assert.rejects(decodeBrotli(input, { expectedBytes: 4 * 1024 * 1024, wasmBinary, signal: active.signal }), { name: 'AbortError' }); }
  finally { clearTimeout(timer); }
  assert(calls > 0 && calls < 64, 'cancellation must interrupt after decoding starts');
  assert.equal(freed, 1);
  assert.deepEqual(await decodeBrotli(compressed, { expectedBytes: sample.length, wasmBinary }), sample);
});

test('concurrent bounded decoder streams keep independent output and reject invalid resource declarations', async () => {
  const other = Buffer.alloc(2 * 1024 * 1024, 101);
  const [left, right] = await Promise.all([
    decodeBrotli(compressed, { expectedBytes: sample.length, wasmBinary }),
    decodeBrotli(brotliCompressSync(other), { expectedBytes: other.length, wasmBinary }),
  ]);
  assert.deepEqual(left, sample); assert.deepEqual(right, new Uint8Array(other));
  assert.notEqual(left.buffer, right.buffer);
  for (const expectedBytes of [0, -1, 1.5, 64 * 1024 * 1024 + 1]) {
    await assert.rejects(decodeBrotli(compressed, { expectedBytes, wasmBinary }), /Invalid bounded Brotli input/);
  }
  await assert.rejects(decodeBrotli(new Uint8Array(), { expectedBytes: sample.length, wasmBinary }), /Invalid bounded Brotli input/);
});
