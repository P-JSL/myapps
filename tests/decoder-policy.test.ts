import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import createFFmpegCore from '../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js';
import type { FFmpegCore } from '../src/vendor/ffmpeg/ffmpeg-core.js';
import { blockedDecoder, hardenMediaCore } from '../src/security/decoder-policy.ts';
import { probeTrack } from '../src/upscale/probe.ts';

const inventory = [' VFS..D h264                 H.264 video', ' A....D aac                  AAC audio', ' VFS..D jpeg2000             JPEG 2000', ' V....D ppm                  PPM image'];
function fixture(lines = inventory, code = 0) {
  let currentLogger: Parameters<FFmpegCore['setLogger']>[0] = () => {};
  let resets = 0;
  const calls: string[][] = [], inspections: string[][] = [];
  const core = {
    reset: () => { resets++; }, setTimeout: () => {},
    setLogger: (value: typeof currentLogger) => { currentLogger = value; },
    exec: (...args: string[]) => { calls.push(args); if (args.includes('-decoders')) for (const message of lines) currentLogger({ type: 'stdout', message }); return code; },
    ffprobe: (...args: string[]) => { inspections.push(args); return -1; },
  } as unknown as FFmpegCore;
  return { core, calls, inspections, resets: () => resets, logger: () => currentLogger };
}

test('decoder policy preserves allowed decoders and protects each separate FFmpeg input', () => {
  const state = fixture();
  const logger = () => {};
  hardenMediaCore(state.core, logger);
  assert.equal(state.logger(), logger); assert.equal(state.resets(), 2);
  state.core.exec('-i', 'input.media', '-i', 'audio.media', '-c:v', 'copy', 'output.mp4');
  assert.deepEqual(state.calls[1], ['-codec_whitelist', 'aac,h264', '-i', 'input.media', '-codec_whitelist', 'aac,h264', '-i', 'audio.media', '-c:v', 'copy', 'output.mp4']);
  state.core.ffprobe('-show_entries', 'stream=codec_type', 'input.media');
  assert.deepEqual(state.inspections[0], ['-codec_whitelist', 'aac,h264', '-show_entries', 'stream=codec_type', 'input.media']);
});

test('decoder policy fails closed on missing, failed, excessive or blocked-only inventory', () => {
  for (const [lines, code] of [
    [[], 0], [['No registered decoders'], 0], [inventory, 1],
    [[' V....D ppm                  PPM image'], 0],
    [Array.from({ length: 4_097 }, () => inventory[0]!), 0],
    [['x'.repeat(256_001), ...inventory], 0],
  ] as [string[], number][]) {
    const state = fixture(lines, code), logger = () => {};
    assert.throws(() => hardenMediaCore(state.core, logger), /보안 정책/);
    assert.equal(state.logger(), logger); assert.equal(state.resets(), 2);
    assert.equal(state.calls.length, 1); assert.deepEqual(state.inspections, []);
  }
});

test('callers cannot replace the decoder whitelist after initialization', () => {
  const state = fixture(); hardenMediaCore(state.core, () => {});
  assert.throws(() => state.core.exec('-codec_whitelist', 'jpeg2000', '-i', 'input.media'), /변경/);
  assert.throws(() => state.core.ffprobe('-codec_whitelist', 'ppm', 'input.media'), /변경/);
  assert.equal(state.calls.length, 1); assert.deepEqual(state.inspections, []);
  for (const codec of ['jpeg2000', 'libopenjpeg', 'magicyuv', 'exr', 'sanm', 'pam', 'pbm', 'pfm', 'pgm', 'pgmyuv', 'ppm']) assert(blockedDecoder(codec));
  for (const codec of [undefined, 1, 'png', 'mjpeg', 'h264', 'aac', 'vp9']) assert(!blockedDecoder(codec));
});

test('pinned Wasm rejects restricted image/video decoders while normal PNG remains available', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, value: { location: { href: new URL('../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js', import.meta.url).href } } });
  try {
    const core = await createFFmpegCore({ wasmBinary: await readFile(new URL('../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm', import.meta.url)) });
    core.setLogger(() => {});
    core.FS.writeFile('pixel.raw', Uint8Array.of(0));
    core.reset(); core.setTimeout(15_000);
    assert.equal(core.exec('-hide_banner', '-f', 'rawvideo', '-pixel_format', 'gray', '-video_size', '1x1', '-i', 'pixel.raw', '-frames:v', '1', '-c:v', 'jpeg2000', '-y', 'safe.j2k'), 0);
    core.FS.unlink('pixel.raw');
    core.FS.writeFile('magic.raw', new Uint8Array(256));
    core.reset(); core.setTimeout(15_000);
    assert.equal(core.exec('-hide_banner', '-f', 'rawvideo', '-pixel_format', 'gray', '-video_size', '16x16', '-i', 'magic.raw', '-frames:v', '1', '-c:v', 'magicyuv', '-y', 'safe.avi'), 0);
    core.FS.unlink('magic.raw');
    core.FS.writeFile('safe.pbm', new TextEncoder().encode('P1\n1 1\n0\n'));
    core.FS.writeFile('safe.pgm', new TextEncoder().encode('P2\n1 1\n255\n0\n'));
    core.FS.writeFile('safe.ppm', new TextEncoder().encode('P3\n1 1\n255\n0 0 0\n'));
    core.FS.writeFile('safe.png', await readFile(new URL('../assets/bitmaps/logo-128-color.png', import.meta.url)));
    core.reset(); core.setTimeout(15_000);
    assert.equal(core.exec('-hide_banner', '-i', 'safe.png', '-frames:v', '1', '-pix_fmt', 'gbrpf32le', '-c:v', 'exr', '-y', 'safe.exr'), 0);
    const messages: string[] = [];
    hardenMediaCore(core, ({ message }) => { messages.push(message); });
    for (const filename of ['safe.pbm', 'safe.pgm', 'safe.ppm', 'safe.j2k', 'safe.avi', 'safe.exr']) {
      messages.length = 0; core.reset(); core.setTimeout(15_000);
      const result = core.exec('-hide_banner', '-i', filename, '-frames:v', '1', '-f', 'null', '-');
      assert.notEqual(result, 0, filename);
      assert(messages.some(line => /not on whitelist/.test(line)), `Decoder refusal missing for ${filename}: ${messages.slice(-4).join(' / ')}`);
      core.reset();
      assert.throws(() => probeTrack(core, filename, 'image'), /보안상 제한된|파일 정보를/);
    }
    const png = probeTrack(core, 'safe.png', 'image');
    assert.equal(png.kind, 'image'); assert.equal(png.width, 128); assert.equal(png.height, 128);
    core.reset(); core.setTimeout(15_000);
    assert.equal(core.exec('-hide_banner', '-i', 'safe.png', '-frames:v', '1', '-f', 'null', '-'), 0);
    for (const filename of ['safe.pbm', 'safe.pgm', 'safe.ppm', 'safe.j2k', 'safe.avi', 'safe.exr', 'safe.png']) core.FS.unlink(filename);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'self', descriptor);
    else Reflect.deleteProperty(globalThis, 'self');
  }
});
