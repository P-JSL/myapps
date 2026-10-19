/** Node 24 microbenchmarks. Outputs JSON; correctness is asserted, speed is never a CI gate. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { chooseQuality } from '../src/local/preferences.ts';
import { assembleBytes } from '../src/local/byte-assembly.ts';

function previousQuality(items, quality, height, bandwidth) {
  const known = items.filter(item => Number.isFinite(height(item)) && height(item) > 0);
  const ranked = values => [...values].sort((a, b) => height(b) - height(a) || bandwidth(b) - bandwidth(a))[0];
  if (!known.length) return [...items].sort((a, b) => bandwidth(b) - bandwidth(a))[0];
  if (quality === 'highest') return ranked(known);
  const eligible = known.filter(item => height(item) <= Number(quality));
  if (eligible.length) return ranked(eligible);
  const minimum = Math.min(...known.map(height));
  return ranked(known.filter(item => height(item) === minimum));
}
function previousBytes(chunks, total, offset = 0, length = total) {
  const result = new Uint8Array(total); let at = 0;
  for (const chunk of chunks) { result.set(chunk, at); at += chunk.length; }
  return offset === 0 && length === total ? result : result.slice(offset, offset + length);
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let sink;
function compare(before, after, iterations, warmup = 40) {
  for (let i = 0; i < warmup; i++) { sink = before(); sink = after(); }
  const samples = { before: [], after: [] };
  // Alternate order within each pair so temperature/JIT/GC do not always favor one side.
  for (let sample = 0; sample < 7; sample++) {
    for (const key of sample % 2 ? ['after', 'before'] : ['before', 'after']) {
      const fn = key === 'before' ? before : after;
      const start = performance.now();
      for (let i = 0; i < iterations; i++) sink = fn();
      samples[key].push((performance.now() - start) / iterations);
    }
  }
  const beforeMs = median(samples.before), afterMs = median(samples.after);
  return { iterations, samples: 7, beforeMs, afterMs, ratio: beforeMs / afterMs, measurements: samples };
}

const cases = [];
for (const [n, iterations] of [[8, 12000], [64, 3000], [1024, 200], [4096, 60]]) {
  let state = 12345;
  const items = Array.from({ length: n }, (_, id) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return { id, height: [360, 480, 720, 1080, 2160][state % 5], bandwidth: state };
  });
  const height = item => item.height, bandwidth = item => item.bandwidth;
  const before = () => previousQuality(items, 'highest', height, bandwidth);
  const after = () => chooseQuality(items, 'highest', height, bandwidth);
  assert.equal(after(), before());
  let previousReads = 0, currentReads = 0;
  previousQuality(items, 'highest', item => { previousReads++; return item.height; }, item => { previousReads++; return item.bandwidth; });
  chooseQuality(items, 'highest', item => { currentReads++; return item.height; }, item => { currentReads++; return item.bandwidth; });
  cases.push({ kind: 'quality-selection', n, ...compare(before, after, iterations), metadataReads: { before: previousReads, after: currentReads }, selectedId: after().id });
}

for (const spec of [
  { name: 'whole-multiple-chunks', total: 8 * 1024 * 1024, chunkSize: 64 * 1024, offset: 0, length: 8 * 1024 * 1024, iterations: 4 },
  { name: 'whole-single-owned-chunk', total: 8 * 1024 * 1024, chunkSize: 8 * 1024 * 1024, offset: 0, length: 8 * 1024 * 1024, iterations: 4 },
  { name: 'ignored-range-exact-span', total: 64 * 1024 * 1024, chunkSize: 64 * 1024, offset: 31 * 1024 * 1024 + 17, length: 1024 * 1024, iterations: 2 },
]) {
  const chunks = Array.from({ length: spec.total / spec.chunkSize }, (_, index) => new Uint8Array(spec.chunkSize).fill(index % 251));
  const before = () => previousBytes(chunks, spec.total, spec.offset, spec.length);
  const after = () => assembleBytes(chunks, spec.total, spec.offset, spec.length);
  assert.deepEqual(after(), before());
  assert.equal(after().byteOffset, 0); assert.equal(after().buffer.byteLength, spec.length);
  const isRange = spec.offset !== 0 || spec.length !== spec.total;
  const previousCopied = spec.total + (isRange ? spec.length : 0);
  const currentCopied = chunks.length === 1 && !isRange ? 0 : spec.length;
  cases.push({ kind: 'byte-assembly', name: spec.name, bytes: spec.total, chunks: chunks.length, offset: spec.offset, length: spec.length,
    ...compare(before, after, spec.iterations, 2),
    copiedBytes: { before: previousCopied, after: currentCopied },
    newBackingBytes: { before: previousCopied, after: currentCopied },
    inputBytesStillRead: spec.total,
  });
}
const sourceHashes = {};
for (const filename of ['src/local/preferences.ts', 'src/local/hls.ts', 'src/local/dash.ts', 'src/local/network.ts', 'src/local/byte-assembly.ts', 'src/local/stream-worker.ts', 'tests/bench-media.mjs', 'tests/media-optimization.test.ts']) {
  sourceHashes[filename] = createHash('sha256').update(await readFile(filename)).digest('hex');
}
assert.notEqual(sink, undefined);
console.log(JSON.stringify({
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length },
  method: 'Seven paired, alternately ordered samples after warmup; median milliseconds per operation; seeded synthetic inputs; no timing pass threshold. Byte cases measure only assembly after the entire body was read, not network throughput.',
  sourceHashes, cases,
}));
