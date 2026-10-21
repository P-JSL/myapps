import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import createFFmpegCore from '../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js';
import { probeTrack } from '../src/upscale/probe.ts';
import type { FFmpegCore } from '../src/vendor/ffmpeg/ffmpeg-core.js';

function fixture(metadata: unknown, { size, code = -1 }: { size?: number; code?: number } = {}) {
  const report = JSON.stringify(metadata);
  const reads: string[] = [], removed: string[] = [], commands: string[][] = [];
  let timeout = 0, resets = 0;
  const core = {
    FS: {
      stat: (name: string) => { assert.equal(name, 'probe.json'); return { size: size ?? Buffer.byteLength(report) }; },
      readFile: (name: string) => { reads.push(name); return report; },
      unlink: (name: string) => { removed.push(name); },
    },
    reset: () => { resets++; }, setTimeout: (value: number) => { timeout = value; },
    ffprobe: (...args: string[]) => { commands.push(args); return code; },
  } as unknown as FFmpegCore;
  return { core, reads, removed, commands, timeout: () => timeout, resets: () => resets };
}

test('media probe keeps required track fields and omits arbitrary container tags', () => {
  const state = fixture({ streams: [
    { codec_type: 'video', width: 200, height: 200, disposition: { attached_pic: 1 } },
    { codec_type: 'video', width: 1920, height: 1080, duration: '3.25', disposition: { attached_pic: 0 } },
    { codec_type: 'audio', duration: '3.3' },
  ], format: { duration: '3.5' } });
  assert.deepEqual(probeTrack(state.core, 'input.media', 'video'), { width: 1920, height: 1080, duration: 3.5, video: true, audio: true, kind: 'video' });
  assert.equal(state.resets(), 1); assert.equal(state.timeout(), 15_000);
  const command = state.commands[0]!;
  assert.equal(command[command.indexOf('-protocol_whitelist') + 1], 'file,pipe');
  const entries = command[command.indexOf('-show_entries') + 1]!;
  assert(entries.includes('stream=codec_type,codec_name,width,height,duration'));
  assert(entries.includes('stream_disposition=attached_pic'));
  assert(entries.includes('format=duration'));
  assert(!entries.includes('tags'));
  assert.deepEqual(state.reads, ['probe.json']); assert.deepEqual(state.removed, ['probe.json']);
});

test('oversized and invalid probe reports reject before reading or decoding their data', () => {
  for (const size of [256_001, 268_435_456, 0, -1, 1.5, NaN, Infinity]) {
    const state = fixture({ streams: [] }, { size });
    assert.throws(() => probeTrack(state.core, 'input.media', 'video'), /허용 범위/);
    assert.deepEqual(state.reads, [], `Must reject size ${size} before readFile`);
    assert.deepEqual(state.removed, ['probe.json']);
  }
});

test('probe preserves image/audio classification and stream duration fallbacks', () => {
  const image = fixture({ streams: [{ codec_type: 'video', width: 16, height: 8 }], format: {} }, { code: 0 });
  assert.deepEqual(probeTrack(image.core, 'input.media', 'image'), { width: 16, height: 8, duration: 0, video: true, audio: false, kind: 'image' });
  const audio = fixture({ streams: [{ codec_type: 'audio', duration: '2.75' }], format: {} });
  assert.deepEqual(probeTrack(audio.core, 'audio.media', 'audio'), { width: 0, height: 0, duration: 2.75, video: false, audio: true, kind: 'audio' });
});

test('probe rejects decoder errors and malformed reports while cleaning up decoded reports', () => {
  for (const metadata of [{ error: { code: -1 }, streams: [] }, { streams: null }, null]) {
    const state = fixture(metadata);
    assert.throws(() => probeTrack(state.core, 'input.media', 'video'), /미디어 정보/);
    assert.deepEqual(state.removed, ['probe.json']);
  }
  const failure = fixture({ streams: [] }, { code: 2 });
  assert.throws(() => probeTrack(failure.core, 'input.media', 'video'), /파일 정보를/);
  assert.deepEqual(failure.reads, []);
});


test('pinned Wasm ffprobe omits large WAV metadata tags while preserving audio duration', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, value: { location: { href: new URL('../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js', import.meta.url).href } } });
  try {
    const core = await createFFmpegCore({ wasmBinary: await readFile(new URL('../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm', import.meta.url)) });
    core.setLogger(() => {});
    const format = Buffer.alloc(24);
    format.write('fmt '); format.writeUInt32LE(16, 4); format.writeUInt16LE(1, 8); format.writeUInt16LE(1, 10);
    format.writeUInt32LE(8_000, 12); format.writeUInt32LE(16_000, 16); format.writeUInt16LE(2, 20); format.writeUInt16LE(16, 22);
    const tags = Buffer.alloc(1_000_020, 97);
    tags.write('LIST'); tags.writeUInt32LE(tags.length - 8, 4); tags.write('INFO', 8); tags.write('ICMT', 12); tags.writeUInt32LE(tags.length - 20, 16); tags[tags.length - 1] = 0;
    const data = Buffer.alloc(1_608); data.write('data'); data.writeUInt32LE(1_600, 4);
    const header = Buffer.alloc(12); header.write('RIFF'); header.writeUInt32LE(4 + format.length + tags.length + data.length, 4); header.write('WAVE', 8);
    core.FS.writeFile('input.media', Buffer.concat([header, format, tags, data]));
    let report = '';
    const read = core.FS.readFile.bind(core.FS);
    core.FS.readFile = (name, options) => {
      const bytes = read(name, options);
      if (name === 'probe.json' && typeof bytes === 'string') report = bytes;
      return bytes;
    };
    const actual = probeTrack(core, 'input.media', 'audio');
    assert.deepEqual(actual, { width: 0, height: 0, duration: 0.1, video: false, audio: true, kind: 'audio' });
    assert(report.length > 0 && report.length < 4_096, `Probe report unexpectedly large: ${report.length}`);
    assert(!report.includes('tags')); assert(!report.includes('aaaa'));
    assert.throws(() => core.FS.stat('probe.json'), 'Fresh report must be removed after reading');
    core.FS.unlink('input.media');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'self', descriptor);
    else Reflect.deleteProperty(globalThis, 'self');
  }
});
