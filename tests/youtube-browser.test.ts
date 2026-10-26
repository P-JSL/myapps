import test from 'node:test';
import assert from 'node:assert/strict';
import { browserYouTubeResolution, probeYouTube } from '../src/local/youtube.ts';

const id = 'AAAAAAAAAAA';
const page = 'https://www.youtube.com/watch?v=' + id;
const track = (itag: number, mimeType: string, extra: object = {}) => ({ itag, mimeType, url: 'https://rr1---sn-example.googlevideo.com/videoplayback?itag=' + itag, bitrate: itag * 100, ...extra });
const source = (adaptiveFormats: object[]) => ({ playabilityStatus: { status: 'OK' }, videoDetails: { videoId: id, title: 'Test', lengthSeconds: '120', isLiveContent: false }, streamingData: { adaptiveFormats } });
const original = { quality: 'highest' as const, output: 'original' as const };
test('browser-only extractor selects video and audio without native access', () => {
  const result = browserYouTubeResolution(source([track(137, 'video/mp4; codecs="avc1"', { height: 1080 }), track(140, 'audio/mp4; codecs="mp4a"')]), page, original);
  assert.equal(result.videoId, id);
  assert.deepEqual(result.tracks.map(t => t.kind), ['video', 'audio']);
  assert.equal(result.tracks[0]?.height, 1080);
});
test('browser-only extractor rejects cipher-only and unrelated hosts', () => {
  assert.throws(() => browserYouTubeResolution(source([track(137, 'video/mp4', { height: 1080, signatureCipher: 'x' })]), page, original), /서명/);
  assert.throws(() => browserYouTubeResolution(source([track(137, 'video/mp4', { height: 1080, url: 'https://localhost/videoplayback' })]), page, original), /서명/);
  assert.throws(() => browserYouTubeResolution({ ...source([]), playabilityStatus: { status: 'LOGIN_REQUIRED' } }, page, original), /로그인/);
});
test('probe reports browser engine without native messaging', async () => {
  const value = await probeYouTube();
  assert.equal(value.status, 'ready');
  assert.equal(value.runtime, 'Chrome 내장');
});
