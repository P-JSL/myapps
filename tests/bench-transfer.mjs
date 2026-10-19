import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import createFFmpegCore from '../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js';

const warmups = 3;
const samples = 11;
const helper = new URL('../src/security/transfer.ts', import.meta.url).href;
const worker = new Worker(`
  const { parentPort } = require('node:worker_threads');
  (async () => {
    const { ownedTransferBuffer } = await import(${JSON.stringify(helper)});
    parentPort.on('message', ({ size, method }) => {
      // Allocate and touch the source before timing, just as FS.readFile already
      // supplies a fully written owned output before this production operation.
      const source = new Uint8Array(size); source.fill(123);
      const started = performance.now();
      const output = method === 'clone' ? new Uint8Array(source).buffer : ownedTransferBuffer(source);
      parentPort.postMessage({ output }, [output]);
      parentPort.postMessage({ durationMs: performance.now() - started, sourceDetached: source.byteLength === 0 });
    });
    parentPort.postMessage({ ready: true });
  })().catch(error => { throw error; });
`, { eval: true });

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1), samplesMs: values };
}
async function round(size, method) {
  const received = [];
  const onMessage = message => received.push(message);
  worker.on('message', onMessage);
  try {
    const completed = new Promise((resolve, reject) => {
      const error = err => { worker.off('message', next); reject(err); };
      const next = message => { if (typeof message.durationMs === 'number') { worker.off('message', next); worker.off('error', error); resolve(message); } };
      worker.on('message', next); worker.once('error', error);
    });
    worker.postMessage({ size, method });
    const timing = await completed;
    const output = received.find(message => message.output)?.output;
    assert(output instanceof ArrayBuffer); assert.equal(output.byteLength, size);
    const bytes = new Uint8Array(output);
    for (const offset of [0, Math.floor(size / 2), size - 1]) assert.equal(bytes[offset], 123);
    assert.equal(timing.sourceDetached, method === 'owned');
    return timing.durationMs;
  } finally { worker.off('message', onMessage); }
}

let outputReport;
try {
  const [ready] = await once(worker, 'message'); assert.equal(ready.ready, true);
  const cases = [];
  for (const sizeMiB of [1, 8, 64]) {
    const bytes = sizeMiB * 1024 * 1024;
    const measured = { clone: [], owned: [] };
    // Alternate order to reduce systematic JIT, thermal and GC ordering bias.
    for (let index = -warmups; index < samples; index++) {
      const order = index % 2 === 0 ? ['clone', 'owned'] : ['owned', 'clone'];
      for (const method of order) {
        const elapsed = await round(bytes, method);
        if (index >= 0) measured[method].push(elapsed);
      }
    }
    const baseline = summary(measured.clone), optimized = summary(measured.owned);
    cases.push({ bytes, sizeMiB, baseline, optimized,
      medianSpeedup: baseline.medianMs / optimized.medianMs,
      additionalPayloadAllocationBytes: { baseline: bytes, optimized: 0 },
      extraCopyComplexity: { baseline: 'O(B)', optimized: 'O(1) for independently owned exact ArrayBuffer' } });
  }
  outputReport = { name: 'owned-worker-output-transfer', runtime: process.version, platform: process.platform,
    warmups, samples, measurement: 'Worker-side output selection plus real parentPort.postMessage transfer; excludes source allocation and FS.readFile',
    memoryNote: 'Additional payload allocation is calculated from the actual byte-array operations, not sampled peak RSS. Subviews/shared buffers retain O(B) copy fallback. JIT, GC, scheduling and transport overhead affect timings; these are local measurements, not end-to-end speedups.', cases };
} finally { await worker.terminate(); }

const selfDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'self');
Object.defineProperty(globalThis, 'self', { configurable: true, value: { location: { href: new URL('../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js', import.meta.url).href } } });
try {
  const core = await createFFmpegCore({ wasmBinary: await readFile(new URL('../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm', import.meta.url)) });
  const inputCases = [];
  for (const sizeMiB of [1, 8, 64]) {
    const bytes = sizeMiB * 1024 * 1024;
    const sourceFile = new File([new Uint8Array(bytes).fill(123)], 'input.bin');
    const measured = { clone: [], owned: [] };
    for (let index = -warmups; index < samples; index++) {
      const order = index % 2 === 0 ? ['clone', 'owned'] : ['owned', 'clone'];
      for (const method of order) {
        const started = performance.now();
        const input = new Uint8Array(await sourceFile.arrayBuffer());
        core.FS.writeFile('input.bin', input, { canOwn: method === 'owned' });
        const elapsed = performance.now() - started;
        const node = core.FS.lookupPath('input.bin').node;
        assert.equal(node.usedBytes, bytes);
        assert.equal(node.contents.buffer === input.buffer, method === 'owned');
        for (const offset of [0, Math.floor(bytes / 2), bytes - 1]) assert.equal(node.contents[offset], 123);
        core.FS.unlink('input.bin');
        if (index >= 0) measured[method].push(elapsed);
      }
    }
    const baseline = summary(measured.clone), optimized = summary(measured.owned);
    inputCases.push({ bytes, sizeMiB, baseline, optimized, medianSpeedup: baseline.medianMs / optimized.medianMs,
      applicationPayloadAllocationBytes: { baseline: bytes * 2, optimized: bytes },
      fsInsertionExtraCopyComplexity: { baseline: 'O(B)', optimized: 'O(1) for fresh File.arrayBuffer owned bytes' } });
  }
  outputReport.inputPreparation = { measurement: 'Actual pinned FFmpeg 0.12.10 MEMFS writeFile, including File.arrayBuffer; excludes File construction, FFmpeg initialization and processing',
    runtimeContext: 'Node with actual Wasm core and File/Blob; browser processing equivalence is checked separately',
    memoryNote: 'Payload allocations are calculated File.arrayBuffer plus MEMFS default copy, not peak RSS; source File/Blob storage, decoder, Wasm and output storage are excluded. Whole File preparation remains O(B).',
    cases: inputCases };
} finally {
  if (selfDescriptor) Object.defineProperty(globalThis, 'self', selfDescriptor);
  else Reflect.deleteProperty(globalThis, 'self');
}
process.stdout.write(`${JSON.stringify(outputReport, null, 2)}\n`);
