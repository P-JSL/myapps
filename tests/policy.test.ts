import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_INPUT_BYTES, MAX_DURATION, MAX_EDGE, MAX_OUTPUT_PIXELS,
  ffmpegArguments, isJob, isJobId, outputDimensions, outputName, safeBasename, sniffMedia,
} from '../src/upscale/policy.ts';

const video = { width: 640, height: 360, duration: 60, kind: 'video' as const };
const image = { width: 640, height: 360, duration: 0, kind: 'image' as const };

test('2x and 4x scaling preserve aspect ratio and use the expected pixel dimensions', () => {
  assert.deepEqual(outputDimensions(video, 2), { width: 1280, height: 720 });
  assert.deepEqual(outputDimensions(video, 4), { width: 2560, height: 1440 });
  assert.deepEqual(outputDimensions({ ...image, width: 1, height: 1 }, 2), { width: 2, height: 2 });
});

test('scaling rejects invalid factors, corrupt dimensions and invalid video durations', () => {
  for (const factor of [0, 1, 3, 8, '2', null, undefined, NaN, Infinity]) assert.throws(() => outputDimensions(video, factor));
  for (const dimensions of [{ width: 0 }, { height: -1 }, { width: 1.5 }, { height: NaN }, { width: Infinity }, { width: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => outputDimensions({ ...video, ...dimensions }, 2));
  }
  for (const duration of [0, -1, NaN, Infinity, MAX_DURATION + 0.01]) assert.throws(() => outputDimensions({ ...video, duration }, 2));
  assert.deepEqual(outputDimensions({ ...video, duration: MAX_DURATION }, 2), { width: 1280, height: 720 });
});

test('scaling accepts documented edge boundaries and rejects output resource exhaustion', () => {
  assert.deepEqual(outputDimensions({ ...image, width: MAX_EDGE / 2, height: 1 }, 2), { width: MAX_EDGE, height: 2 });
  const side = Math.sqrt(MAX_OUTPUT_PIXELS);
  assert.deepEqual(outputDimensions({ ...image, width: side / 2, height: side / 2 }, 2), { width: side, height: side });
  assert.throws(() => outputDimensions({ ...image, width: MAX_EDGE / 2 + 1, height: 1 }, 2));
  assert.throws(() => outputDimensions({ ...image, width: side / 2 + 1, height: side / 2 }, 2));
});

test('queue metadata accepts UUID-v4 jobs and rejects invalid identities and sizes', () => {
  const job = { id: '87a8602a-e3ae-47cb-85d4-aad74de3b88e', filename: 'movie.mp4', size: MAX_INPUT_BYTES, createdAt: 1_800_000_000_000 };
  assert.equal(isJobId(job.id), true);
  assert.equal(isJobId(job.id.toUpperCase()), true);
  assert.equal(isJob(job), true);
  for (const id of ['../../outside', '87a8602a-e3ae-17cb-85d4-aad74de3b88e', '87a8602a-e3ae-47cb-75d4-aad74de3b88e', '', null, 123]) assert.equal(isJobId(id), false);
  for (const change of [{ id: '../outside' }, { size: 0 }, { size: -1 }, { size: 1.5 }, { size: MAX_INPUT_BYTES + 1 }, { filename: 'a'.repeat(241) }, { createdAt: NaN }, { createdAt: Infinity }]) {
    assert.equal(isJob({ ...job, ...change }), false);
  }
  assert.equal(isJob(null), false);
});

test('download output filenames strip paths, control characters and direction overrides', () => {
  assert.equal(safeBasename('/tmp/nested/영상.mp4'), '영상.mp4');
  assert.equal(safeBasename('C:\\downloads\\movie.mp4'), 'movie.mp4');
  assert.equal(safeBasename('../../movie.mp4'), 'movie.mp4');
  assert.equal(safeBasename('bad\0\n<>:"|?*\u202e.mp4'), 'bad__________.mp4');
  assert.equal(safeBasename('trailing...  '), 'trailing');
  assert.equal(safeBasename('..'), 'media');
  assert.equal(safeBasename(''), 'media');
  assert.equal(safeBasename('x'.repeat(500)).length, 180);
  assert.equal(outputName('../../영상.original.mp4', 2, 'video'), '영상.original-2x.mp4');
  assert.equal(outputName('photo.jpeg', 4, 'image'), 'photo-4x.png');
});

test('media detection uses signatures rather than attacker-controlled filenames', () => {
  const bytes = (...values: number[]) => Uint8Array.from(values);
  const ascii = (value: string) => new TextEncoder().encode(value);
  assert.equal(sniffMedia(bytes(0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10)), 'image');
  assert.equal(sniffMedia(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image');
  assert.equal(sniffMedia(ascii('RIFF1234WEBP')), 'image');
  assert.equal(sniffMedia(bytes(0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70)), 'video');
  assert.equal(sniffMedia(ascii('RIFF1234AVI ')), 'video');
  assert.equal(sniffMedia(bytes(0x1a, 0x45, 0xdf, 0xa3)), 'video');
  for (const value of ['', '#EXTM3U\nhttps://example.com/segment', '<svg onload="alert(1)"></svg>', '<!doctype html><script>alert(1)</script>', 'PNG', 'RIFF1234WAVE']) {
    assert.equal(sniffMedia(ascii(value)), undefined);
  }
  assert.equal(sniffMedia(bytes(0x89, 0x50, 0x4e, 0x47)), undefined);
});

test('video encoding keeps audio optional, uses local-only input and bounds decoder resources', () => {
  const args = ffmpegArguments(video, 2);
  const value = (option: string) => args[args.indexOf(option) + 1];
  assert.equal(value('-i'), 'input.media');
  assert.equal(value('-protocol_whitelist'), 'file,pipe');
  assert.equal(value('-max_alloc'), '67108864');
  assert.equal(value('-threads'), '1');
  assert.equal(value('-vf'), 'scale=1280:720:flags=lanczos');
  assert.equal(value('-c:v'), 'libx264');
  assert.equal(value('-pix_fmt'), 'yuv420p');
  assert.equal(value('-c:a'), 'aac');
  assert.ok(args.includes('0:v:0'));
  assert.ok(args.includes('0:a?'));
  assert.ok(args.includes('-nostdin'));
  assert.equal(args.at(-1), 'output.mp4');
  assert.ok(!args.some(argument => /https?:|concat:|subfile:/.test(argument)));
});

test('image encoding emits a single PNG and applies the same dimension validation', () => {
  const args = ffmpegArguments(image, 4);
  assert.equal(args[args.indexOf('-frames:v') + 1], '1');
  assert.equal(args[args.indexOf('-c:v') + 1], 'png');
  assert.equal(args[args.indexOf('-vf') + 1], 'scale=2560:1440:flags=lanczos');
  assert.equal(args.at(-1), 'output.png');
  assert.ok(!args.includes('0:a?'));
  assert.throws(() => ffmpegArguments({ ...video, duration: MAX_DURATION + 1 }, 2));
});
