import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import createFFmpegCore from '../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js';
import { ownedTransferBuffer } from '../src/security/transfer.ts';

test('owned worker output reuses only an exact non-shared buffer', () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  assert.equal(ownedTransferBuffer(bytes), bytes.buffer);
  for (const view of [bytes.subarray(1, 3), bytes.subarray(0, 3), bytes.subarray(1)]) {
    const buffer = ownedTransferBuffer(view);
    assert.notEqual(buffer, bytes.buffer);
    assert.deepEqual(new Uint8Array(buffer), view);
    assert.equal(buffer.byteLength, view.byteLength);
  }
  const shared = new Uint8Array(new SharedArrayBuffer(4)); shared.set(bytes);
  for (const view of [shared, shared.subarray(1, 3)]) {
    const buffer = ownedTransferBuffer(view);
    assert(buffer instanceof ArrayBuffer);
    assert.deepEqual(new Uint8Array(buffer), view);
    shared.fill(9);
    assert.notDeepEqual(new Uint8Array(buffer), view);
    shared.set(bytes);
  }
});

test('Wasm heap subviews copy exact bytes without detaching the heap', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const heap = new Uint8Array(memory.buffer); heap.set([4, 5, 6, 7], 32);
  const result = ownedTransferBuffer(heap.subarray(32, 36));
  assert.equal(result.byteLength, 4);
  assert.deepEqual(new Uint8Array(structuredClone(result, { transfer: [result] })), new Uint8Array([4, 5, 6, 7]));
  assert.equal(memory.buffer.byteLength, 65536);
  assert.deepEqual(heap.slice(32, 36), new Uint8Array([4, 5, 6, 7]));
});

test('real worker transfer detaches owned output and preserves fallback backing bytes', async () => {
  const helper = new URL('../src/security/transfer.ts', import.meta.url).href;
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    (async () => {
      const { ownedTransferBuffer } = await import(${JSON.stringify(helper)});
      for (const kind of ['owned', 'subview', 'shared']) {
        const backing = kind === 'shared' ? new Uint8Array(new SharedArrayBuffer(258)) : new Uint8Array(kind === 'owned' ? 256 : 258);
        const view = kind === 'owned' ? backing : backing.subarray(1, 257);
        for (let index = 0; index < view.length; index++) view[index] = index;
        if (kind !== 'owned') { backing[0] = 199; backing[257] = 201; }
        const buffer = ownedTransferBuffer(view);
        parentPort.postMessage({ kind, buffer }, [buffer]);
        parentPort.postMessage({ kind, detached: buffer.byteLength === 0, sourceLength: backing.byteLength,
          guards: kind === 'owned' ? [] : [backing[0], backing[257]] });
      }
      parentPort.close();
    })().catch(error => { throw error; });
  `, { eval: true });
  const messages: Array<{ kind: string; buffer?: ArrayBuffer; detached?: boolean; sourceLength?: number; guards?: number[] }> = [];
  worker.on('message', message => messages.push(message));
  try {
    const [code] = await once(worker, 'exit'); assert.equal(code, 0);
    assert.equal(messages.length, 6);
    for (const kind of ['owned', 'subview', 'shared']) {
      const received = messages.find(message => message.kind === kind && message.buffer);
      assert(received?.buffer);
      assert.deepEqual(new Uint8Array(received.buffer), Uint8Array.from({ length: 256 }, (_, index) => index));
      const state = messages.find(message => message.kind === kind && message.detached);
      assert(state?.detached);
      assert.equal(state.sourceLength, kind === 'owned' ? 0 : 258);
      assert.deepEqual(state.guards, kind === 'owned' ? [] : [199, 201]);
    }
  } finally { await worker.terminate(); }
});

test('pinned FFmpeg readFile owns a fresh buffer and transfer leaves MEMFS usable', async () => {
  const selfDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, value: { location: { href: new URL('../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js', import.meta.url).href } } });
  try {
    const core = await createFFmpegCore({ wasmBinary: await readFile(new URL('../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm', import.meta.url)) });
    const original = new Uint8Array([0, 1, 127, 128, 254, 255]);
    core.FS.writeFile('transfer.bin', original);
    const first = core.FS.readFile('transfer.bin'), second = core.FS.readFile('transfer.bin');
    assert(first instanceof Uint8Array); assert(second instanceof Uint8Array);
    assert.equal(first.byteOffset, 0); assert.equal(first.buffer.byteLength, first.byteLength);
    assert.notEqual(first.buffer, second.buffer);
    first[0] = 99;
    assert.deepEqual(core.FS.readFile('transfer.bin'), original);
    first[0] = original[0]!;
    const buffer = ownedTransferBuffer(first);
    const transferred = structuredClone(buffer, { transfer: [buffer] });
    assert.equal(first.byteLength, 0);
    assert.deepEqual(new Uint8Array(transferred), original);
    assert.deepEqual(core.FS.readFile('transfer.bin'), original);
    assert.deepEqual(second, original);
    core.FS.writeFile('after-transfer.bin', new Uint8Array([9]));
    assert.deepEqual(core.FS.readFile('after-transfer.bin'), new Uint8Array([9]));
    const sourceFile = new File([original], 'input.media');
    const input = new Uint8Array(await sourceFile.arrayBuffer());
    core.FS.writeFile('owned-input.media', input, { canOwn: true });
    assert.deepEqual(core.FS.readFile('owned-input.media'), original);
    // Mutation is only used here to prove actual ownership; production drops
    // its fresh input reference after insertion and never changes it again.
    input[0] = 99;
    assert.equal((core.FS.readFile('owned-input.media') as Uint8Array)[0], 99);
    assert.deepEqual(new Uint8Array(await sourceFile.arrayBuffer()), original);
    core.FS.writeFile('owned-input.media', new Uint8Array([8, 7]), { canOwn: true });
    assert.deepEqual(core.FS.readFile('owned-input.media'), new Uint8Array([8, 7]));
    core.FS.writeFile('owned-input.media', new Uint8Array([6]));
    assert.deepEqual(core.FS.readFile('owned-input.media'), new Uint8Array([6]));
    core.FS.unlink('owned-input.media');
    core.FS.unlink('transfer.bin'); core.FS.unlink('after-transfer.bin');
  } finally {
    if (selfDescriptor) Object.defineProperty(globalThis, 'self', selfDescriptor);
    else Reflect.deleteProperty(globalThis, 'self');
  }
});
