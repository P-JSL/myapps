import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseQuality, downloadOptions } from '../src/local/preferences.ts';
import { planHls } from '../src/local/hls.ts';
import { convertedDimensions, processedName, processingArguments, processingOptions, sniffInput, validateTrack, type TrackInfo } from '../src/upscale/processing.ts';

const info: TrackInfo = { width: 1920, height: 1080, duration: 60, video: true, audio: true, kind: 'video' };
test('download preferences reject arbitrary codecs, heights and malformed settings', () => {
  assert.deepEqual(downloadOptions(), { quality: 'highest', output: 'original' });
  for (const value of [null, {}, { quality: 1080, output: 'original' }, { quality: '1080', output: '-i evil' }, { quality: '99999', output: 'mp3' }]) assert.throws(() => downloadOptions(value));
});
test('quality selection prioritizes height over bitrate and handles missing renditions', () => {
  const variants = [{ height: 2160, bandwidth: 5 }, { height: 1080, bandwidth: 99 }, { height: 720, bandwidth: 2 }, { height: 0, bandwidth: 999 }];
  const pick = (quality: 'highest' | '1080' | '480') => chooseQuality(variants, quality, x => x.height, x => x.bandwidth);
  assert.equal(pick('highest')?.height, 2160); assert.equal(pick('1080')?.height, 1080); assert.equal(pick('480')?.height, 720);
  assert.equal(chooseQuality(variants.slice(3), 'highest', x => x.height, x => x.bandwidth)?.bandwidth, 999);
});
test('HLS ceilings select real renditions and audio-only skips external video requests', async () => {
  const base = 'https://media.test/'; const loaded: string[] = [];
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=3840x2160,AUDIO="a"\n4k.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200,RESOLUTION=1920x1080,AUDIO="a"\nhd.m3u8\n';
  const load = async (url: string) => { loaded.push(url); return url === base + 'master.m3u8' ? master : '#EXTM3U\n#EXTINF:1,\npart.ts\n#EXT-X-ENDLIST\n'; };
  await planHls(base + 'master.m3u8', load, { quality: '1080', output: 'original' });
  assert(loaded.includes(base + 'hd.m3u8')); assert(!loaded.includes(base + '4k.m3u8'));
  loaded.length = 0;
  const audio = await planHls(base + 'master.m3u8', load, { quality: 'highest', output: 'mp3' });
  assert.deepEqual(loaded, [base + 'master.m3u8', base + 'audio.m3u8']); assert.equal(audio.inputs.length, 1);
});
test('processing options allow only fixed operations and formats', () => {
  assert.deepEqual(processingOptions({ mode: 'convert', format: 'webm', quality: '720' }), { mode: 'convert', format: 'webm', quality: '720' });
  for (const x of [{ mode: 'merge', format: 'webm' }, { mode: 'convert', format: 'mp4', quality: '-i x' }, { mode: 'audio', format: '../../file' }, { mode: 'upscale', factor: 8 }]) assert.throws(() => processingOptions(x));
});
test('conversion fits the height ceiling with even dimensions and never enlarges normal inputs', () => {
  assert.deepEqual(convertedDimensions(info, '720'), { width: 1280, height: 720 });
  assert.deepEqual(convertedDimensions({ width: 160, height: 90 }, '1080'), { width: 160, height: 90 });
});
test('media processing rejects missing tracks, excessive duration and unsafe video sizes', () => {
  for (const duration of [0, -1, NaN, Infinity, 601]) assert.throws(() => validateTrack({ ...info, duration }, { mode: 'audio', format: 'mp3' }));
  assert.throws(() => validateTrack({ ...info, audio: false }, { mode: 'audio', format: 'mp3' }));
  assert.throws(() => validateTrack({ ...info, width: 9000 }, { mode: 'convert', format: 'mp4', quality: '720' }));
  assert.throws(() => validateTrack({ ...info, video: false }, { mode: 'merge', format: 'mp4' }));
});
test('audio signatures do not accept executable documents or remote playlists', () => {
  for (const text of ['ID3hello', 'fLaChello', 'OggShello', 'RIFFxxxxWAVEdata']) assert.equal(sniffInput(new TextEncoder().encode(text)), 'audio');
  for (const text of ['<html>evil', '#EXTM3U', '<MPD>', 'https://example.test']) assert.equal(sniffInput(new TextEncoder().encode(text)), undefined);
});
test('audio and merge commands use local inputs, exact tracks and bounded output', () => {
  const audio = processingArguments(info, { mode: 'audio', format: 'mp3' });
  assert(audio.includes('libmp3lame')); assert(audio.includes('file,pipe')); assert(audio.includes('-fs')); assert(!audio.includes('-c:v'));
  const merge = processingArguments(info, { mode: 'merge', format: 'mp4' });
  assert(merge.includes('audio.media')); assert(merge.includes('copy')); assert(merge.includes('-shortest')); assert(merge.includes('1:a:0'));
});
test('processed names keep selected extensions and safe basenames', () => {
  assert.equal(processedName('../CON.mp4', { mode: 'audio', format: 'mp3' }, 'video'), '_CON-audio.mp3');
  assert.equal(processedName('clip.mp4', { mode: 'merge', format: 'mkv' }, 'video'), 'clip-merged.mkv');
});
