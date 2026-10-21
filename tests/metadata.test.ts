import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadOptions, QUALITIES as publicQualities } from '../src/local/preferences.ts';
import { isMediaFileFormat } from '../src/local/media-file.ts';
import { MIME, processingArguments, processingOptions, type ProcessingOptions, type TrackInfo } from '../src/upscale/processing.ts';
import { AUDIO_FORMATS, DOWNLOAD_OUTPUTS, ENCODER_ARGUMENTS, MEDIA_FILE_MIME, MERGE_FORMATS, PROCESSING_MIME, QUALITIES, VIDEO_FORMATS } from '../src/shared/media.ts';

const info: TrackInfo = { width: 1920, height: 1080, duration: 60, video: true, audio: true, kind: 'video' };
const input = ['-hide_banner', '-nostdin', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe', '-i', 'input.media'];
const limits = ['-threads', '1', '-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn'];
const converted = ['-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=1280:720:flags=lanczos', '-pix_fmt', 'yuv420p'];
const h264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k'];
const merged = ['-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest'];
const cases: { options: Exclude<ProcessingOptions, { mode: 'upscale' }>; modeArguments: string[] }[] = [
  { options: { mode: 'audio', format: 'mp3' }, modeArguments: ['-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k'] },
  { options: { mode: 'audio', format: 'm4a' }, modeArguments: ['-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'] },
  { options: { mode: 'audio', format: 'wav' }, modeArguments: ['-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le'] },
  { options: { mode: 'convert', format: 'mp4', quality: '720' }, modeArguments: [...converted, ...h264, '-movflags', '+faststart'] },
  { options: { mode: 'convert', format: 'mkv', quality: '720' }, modeArguments: [...converted, ...h264] },
  { options: { mode: 'convert', format: 'webm', quality: '720' }, modeArguments: [...converted, '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '4', '-crf', '10', '-b:v', '4M', '-c:a', 'libopus', '-b:a', '192k'] },
  { options: { mode: 'merge', format: 'mp4' }, modeArguments: [...merged, '-movflags', '+faststart'] },
  { options: { mode: 'merge', format: 'mkv' }, modeArguments: merged },
];

test('shared encoder profiles preserve the complete ordered command for every output', () => {
  for (const { options, modeArguments } of cases) {
    const secondInput = options.mode === 'merge' ? ['-protocol_whitelist', 'file,pipe', '-i', 'audio.media'] : [];
    const expected = [...input, ...secondInput, ...limits, ...modeArguments, '-fs', '268435456', '-y', `output.${options.format}`];
    const actual = processingArguments(info, options);
    assert.deepEqual(actual, expected, `${options.mode}/${options.format}`);
    actual.fill('changed');
    assert.deepEqual(processingArguments(info, options), expected, 'each command owns its argument array');
  }
});

test('media metadata is immutable and keeps input and output format scopes separate', () => {
  assert.equal(MIME, PROCESSING_MIME);
  assert.equal(publicQualities, QUALITIES);
  assert.deepEqual(MIME, { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', png: 'image/png' });
  for (const metadata of [MEDIA_FILE_MIME, PROCESSING_MIME, VIDEO_FORMATS, AUDIO_FORMATS, MERGE_FORMATS, QUALITIES, DOWNLOAD_OUTPUTS, ENCODER_ARGUMENTS, ...Object.values(ENCODER_ARGUMENTS)]) assert(Object.isFrozen(metadata));
  for (const [extension, mime] of Object.entries(MEDIA_FILE_MIME)) assert(isMediaFileFormat({ extension, mime }));
  assert(isMediaFileFormat({ extension: 'ogg', mime: 'video/ogg' }));
  for (const value of [{ extension: 'png', mime: 'image/png' }, { extension: 'mp4', mime: 'audio/mp4' }, { extension: 'toString', mime: Object.prototype.toString }]) assert.equal(isMediaFileFormat(value), false);
});

test('metadata validation preserves existing format coercion and strict quality matching', () => {
  const boxedFormat = new String('mp3');
  assert.equal(downloadOptions({ quality: '720', output: boxedFormat }).output, boxedFormat);
  const options = processingOptions({ mode: 'audio', format: boxedFormat });
  assert.equal(options.mode === 'audio' && options.format, boxedFormat);
  const args = processingArguments(info, options);
  assert.equal(args[args.indexOf('-c:a') + 1], 'pcm_s16le');
  assert.equal(args[args.indexOf('-b:a') + 1], '192k');
  assert.throws(() => downloadOptions({ quality: new String('720'), output: 'mp3' }));
  assert.throws(() => processingOptions({ mode: 'convert', format: 'mp4', quality: new String('720') }));
});
