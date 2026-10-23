import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { readSync, writeSync, fstatSync, ftruncateSync, fsyncSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import createFFmpegCore from '../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js';
import { mountDiskFiles } from '../src/local/disk-fs.ts';

/** Real pinned Wasm/FS; Node disk handles double the worker OPFS sync contract. */
test('disk-backed FFmpeg files preserve extents, large positions and real remux output', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'my-video-disk-fs-'));
  const originalSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, value: { location: { href: 'file:///disk-fs-worker.js' } } });
  const handles = [];
  let mounted;
  try {
    const core = await createFFmpegCore({ wasmBinary: new Uint8Array(await readFile(new URL('../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm', import.meta.url))) });
    const fs = core.FS;
    const logs = []; core.setLogger(({ message }) => logs.push(message));
    core.reset(); core.setTimeout(30_000);
    assert.equal(core.exec('-hide_banner', '-f', 'lavfi', '-i', 'testsrc2=size=32x24:rate=2:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', 'fixture.mp4'), 0, logs.join('\n'));
    const fixture = fs.readFile('fixture.mp4'); assert(fixture instanceof Uint8Array);
    const physical = await open(path.join(directory, 'assets.bin'), 'w+');
    const result = await open(path.join(directory, 'output.bin'), 'w+'); handles.push(physical, result);
    const access = handle => ({
      read(buffer, { at }) { return readSync(handle.fd, buffer, 0, buffer.length, at); },
      write(buffer, { at }) { return writeSync(handle.fd, buffer, 0, buffer.length, at); },
      getSize() { return fstatSync(handle.fd).size; }, truncate(size) { ftruncateSync(handle.fd, size); }, flush() { fsyncSync(handle.fd); },
    });
    const assets = access(physical), output = access(result);
    const first = Math.floor(fixture.length / 3), second = first * 2;
    const far = 3 * 1024 ** 3 + 17;
    // Logical order deliberately differs from physical order; the last extent is beyond 3GiB.
    const extents = [{ offset: 8192, length: first }, { offset: 0, length: second - first }, { offset: far, length: fixture.length - second }];
    await physical.write(fixture.subarray(0, first), 0, first, extents[0].offset);
    await physical.write(fixture.subarray(first, second), 0, second - first, extents[1].offset);
    await physical.write(fixture.subarray(second), 0, fixture.length - second, extents[2].offset);
    const inputs = new Map([['input.mp4', extents], ['first.part', [extents[0]]], ['rest.part', extents.slice(1)]]);
    mounted = mountDiskFiles(fs, assets, output, inputs, 'output.mp4');

    await t.test('virtual aliases and cross-extent random reads preserve exact original bytes', () => {
      assert.deepEqual(fs.readFile(mounted.path('input.mp4')), fixture);
      for (const position of [0, first - 7, first, second - 9, second, fixture.length - 4, fixture.length]) {
        const stream = fs.open(mounted.path('input.mp4'), 'r');
        const bytes = new Uint8Array(23); fs.llseek(stream, position, 0);
        const count = fs.read(stream, bytes, 0, bytes.length); fs.close(stream);
        const expected = fixture.subarray(position, position + 23);
        assert.equal(count, expected.length); assert.deepEqual(bytes.subarray(0, count), expected);
      }
      assert.deepEqual(fs.readFile(mounted.path('first.part')), fixture.subarray(0, first));
      assert.deepEqual(fs.readFile(mounted.path('rest.part')), fixture.subarray(first));
      // Mount snapshots metadata; caller mutation cannot redirect a running FFmpeg read.
      extents[0].offset = 0;
      assert.deepEqual(fs.readFile(mounted.path('input.mp4')), fixture);
    });

    await t.test('output seek/write/read/truncate support sparse positions above signed 32-bit', () => {
      const stream = fs.open(mounted.path('output.mp4'), 'w+');
      assert.equal(fs.llseek(stream, far, 0), far);
      assert.equal(fs.write(stream, new Uint8Array([9, 8, 7]), 0, 3), 3);
      assert.equal(mounted.outputSize(), far + 3);
      assert.equal(fs.stat(mounted.path('output.mp4')).size, far + 3);
      assert.equal(fs.llseek(stream, -3, 2), far);
      const bytes = new Uint8Array(3); assert.equal(fs.read(stream, bytes, 0, 3), 3);
      assert.deepEqual(bytes, new Uint8Array([9, 8, 7])); fs.close(stream);
      assert.throws(() => fs.open(mounted.path('input.mp4'), 'w'));
      assert.throws(() => { const s = fs.open(mounted.path('output.mp4'), 'r'); try { fs.llseek(s, -1, 0); } finally { fs.close(s); } });
    });

    await t.test('real video/audio remux and faststart use disk files and fully decode', () => {
      core.reset(); core.setTimeout(30_000); logs.length = 0;
      assert.equal(core.exec('-hide_banner', '-nostdin', '-i', mounted.path('input.mp4'), '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', '-y', mounted.path('output.mp4')), 0, logs.join('\n'));
      mounted.flush(); assert(mounted.outputSize() > 100 && mounted.outputSize() < 1024 * 1024);
      core.reset(); core.setTimeout(30_000);
      const probe = core.ffprobe('-v', 'error', '-show_streams', '-show_format', '-of', 'json', '-o', 'probe.json', mounted.path('output.mp4'));
      assert([0, -1].includes(probe));
      const metadata = JSON.parse(fs.readFile('probe.json', { encoding: 'utf8' }));
      assert.equal(metadata.streams.find(stream => stream.codec_type === 'video').codec_name, 'h264');
      assert.equal(metadata.streams.find(stream => stream.codec_type === 'audio').codec_name, 'aac');
      assert.equal(metadata.streams.find(stream => stream.codec_type === 'video').nb_frames, '2');
      assert(Number(metadata.format.duration) >= 1 && Number(metadata.format.duration) < 1.1);
      core.reset(); core.setTimeout(30_000); logs.length = 0;
      assert.equal(core.exec('-hide_banner', '-i', mounted.path('output.mp4'), '-f', 'null', '-'), 0, logs.join('\n'));
    });

    await t.test('bad extents, names and short or failed disk operations fail explicitly', () => {
      for (const bad of [[{ offset: -1, length: 1 }], [{ offset: far, length: Number.MAX_SAFE_INTEGER }], [{ offset: physicalSize(assets), length: 1 }], [{ offset: 0, length: 0 }]]) {
        assert.throws(() => mountDiskFiles(fs, assets, output, new Map([['bad.mp4', bad]]), 'result.mp4', '/bad'));
      }
      assert.throws(() => mountDiskFiles(fs, assets, output, new Map([['../input', []]]), 'result.mp4', '/bad'));
      assert.throws(() => mounted.path('../input'));
      const partialAssets = { ...assets, read(buffer, options) { return assets.read(buffer.subarray(0, 7), options); } };
      const partialOutput = { ...output, write(buffer, options) { return output.write(buffer.subarray(0, 2), options); } };
      const partial = mountDiskFiles(fs, partialAssets, partialOutput, new Map([['partial.mp4', [{ offset: far, length: fixture.length - second }]]]), 'partial-result.mp4', '/partial');
      try {
        assert.deepEqual(fs.readFile(partial.path('partial.mp4')), fixture.subarray(second));
        const stream = fs.open(partial.path('partial-result.mp4'), 'w');
        try { assert.equal(fs.write(stream, new Uint8Array([1, 2, 3, 4, 5]), 0, 5), 5); }
        finally { fs.close(stream); }
        assert.deepEqual(fs.readFile(partial.path('partial-result.mp4')), new Uint8Array([1, 2, 3, 4, 5]));
      } finally { partial.unmount(); }
      const premature = mountDiskFiles(fs, { ...assets, read() { return 0; } }, output, new Map([['bad.mp4', [{ offset: 0, length: 1 }]]]), 'unused.mp4', '/premature');
      try { assert.throws(() => fs.readFile(premature.path('bad.mp4')), error => error.errno === 29); }
      finally { premature.unmount(); }
      const failed = { ...output, write() { throw new DOMException('Disk quota exhausted', 'QuotaExceededError'); } };
      const invalid = mountDiskFiles(fs, assets, failed, new Map(), 'failed.mp4', '/failed');
      try { const stream = fs.open(invalid.path('failed.mp4'), 'w'); try { assert.throws(() => fs.write(stream, new Uint8Array([1]), 0, 1), error => error.errno === 29); } finally { fs.close(stream); } }
      finally { invalid.unmount(); }
    });
  } finally {
    mounted?.unmount(); mounted?.unmount();
    for (const handle of handles) await handle.close();
    await rm(directory, { recursive: true, force: true });
    if (originalSelf) Object.defineProperty(globalThis, 'self', originalSelf); else Reflect.deleteProperty(globalThis, 'self');
  }
});
function physicalSize(handle) { return handle.getSize(); }
