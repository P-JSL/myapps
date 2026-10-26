import test from 'node:test';
import assert from 'node:assert/strict';
import { youtubeVideo, youtubeResolution, probeYouTube, resolveYouTube, browserYouTubeResolution } from '../src/local/youtube.ts';

const ID = 'AbC_def-123';
const URL = `https://www.youtube.com/watch?v=${ID}`;
const options = { quality: 'highest' as const, output: 'original' as const };
const video = () => ({ url: 'https://rr1---example.googlevideo.com/videoplayback?expire=9999999999&id=video', kind: 'video', mime: 'video/mp4', formatId: '399', height: 2160, size: 4000 });
const audio = () => ({ url: 'https://rr2---example.googlevideo.com/videoplayback?expire=9999999999&id=audio', kind: 'audio', mime: 'audio/mp4', formatId: '140', size: 1000 });
const resolution = () => ({ videoId: ID, url: URL, title: '<img src=x onerror=alert(1)> 제목', tracks: [video(), audio()], duration: 14_402 });

test('YouTube links canonicalize one video without retaining playlist or signed parameters', () => {
  for (const address of [URL, `${URL}&list=PL-example&t=20`, `https://youtube.com/watch/?v=${ID}`, `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`, `https://youtu.be/${ID}?si=share`, `https://www.youtu.be/${ID}/`,
    `https://www.youtube.com/shorts/${ID}`, `https://www.youtube.com/embed/${ID}`, `https://www.youtube.com/live/${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`]) assert.deepEqual(youtubeVideo(address), { id: ID, url: URL });
});

test('Playlist-only, ambiguous, credential, origin-spoof and non-HTTPS source links never reach the extractor', () => {
  for (const address of [null, {}, '', `http://www.youtube.com/watch?v=${ID}`, `https://user:pass@youtube.com/watch?v=${ID}`,
    `https://youtube.com:444/watch?v=${ID}`, `https://youtube.com.evil.invalid/watch?v=${ID}`, `https://youtube.com@evil.invalid/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=${ID}&v=${ID}`, 'https://youtube.com/playlist?list=PL-example', 'https://youtube.com/watch',
    'https://youtube.com/watch?v=short', `https://youtube.com/watch?v=${ID}x`, `https://youtu.be/${ID}/more`,
    `https://youtube-nocookie.com/watch?v=${ID}`, `javascript:https://youtube.com/watch?v=${ID}`, `https://example.invalid/${ID}`,
    `https://youtube.com/shorts/${ID}%2fextra`, URL + '&x=' + 'a'.repeat(8192)]) assert.equal(youtubeVideo(address), undefined);
});

test('Resolved tracks are bound to the requested video and normalize video before audio', () => {
  const value = resolution(); value.tracks.reverse();
  const actual = youtubeResolution(value, `https://youtu.be/${ID}`);
  assert.equal(actual.url, URL); assert.equal(actual.videoId, ID); assert.equal(actual.duration, 14_402);
  assert.equal(actual.title, value.title); assert.deepEqual(actual.tracks.map(track => track.kind), ['video', 'audio']);
  assert.notEqual(actual.tracks, value.tracks); assert.equal(value.tracks[0]!.kind, 'audio');
  assert.deepEqual(youtubeResolution({ ...resolution(), title: '😀'.repeat(200) }, URL).title, '😀'.repeat(200));
});

test('A browser resolver cannot substitute another origin, arbitrary headers or malformed track metadata', () => {
  for (const badURL of ['http://rr1.googlevideo.com/videoplayback', 'https://googlevideo.com.evil.invalid/videoplayback',
    'https://localhost/videoplayback', 'https://127.0.0.1/videoplayback', 'file:///tmp/movie.mp4',
    'https://googlevideo.com/videoplayback', 'https://rr1.googlevideo.com/other', 'https://user@rr1.googlevideo.com/videoplayback',
    'https://rr1.googlevideo.com:444/videoplayback', 'https://rr1.googlevideo.com/videoplayback#fragment']) {
    assert.throws(() => youtubeResolution({ ...resolution(), tracks: [{ ...video(), url: badURL }] }, URL));
  }
  for (const track of [{ ...video(), headers: { Cookie: 'private' } }, { ...video(), mime: 'audio/mp4' }, { ...audio(), mime: 'video/mp4' },
    { ...video(), formatId: '../unsafe' }, { ...video(), height: 0 }, { ...video(), height: Infinity }, { ...audio(), height: 100 },
    { ...video(), size: 0 }, { ...video(), size: Number.MAX_SAFE_INTEGER + 1 }, { ...video(), protocol: 'https' }, { ...video(), fragments: [] }]) {
    assert.throws(() => youtubeResolution({ ...resolution(), tracks: [track] }, URL));
  }
});

test('Source mismatch, oversized metadata, duplicate tracks and unsupported track combinations fail closed', () => {
  for (const value of [null, {}, { ...resolution(), videoId: 'ZZZ_def-1234' }, { ...resolution(), url: 'https://www.youtube.com/watch?v=ZZZ_def-1234' },
    { ...resolution(), title: 'a'.repeat(201) }, { ...resolution(), title: 'line\nbreak' }, { ...resolution(), title: '😀'.repeat(201) },
    { ...resolution(), tracks: [] }, { ...resolution(), tracks: [video(), audio(), audio()] },
    { ...resolution(), tracks: [video(), video()] }, { ...resolution(), tracks: [audio(), audio()] },
    { ...resolution(), tracks: [{ ...video(), kind: 'combined' }, audio()] },
    { ...resolution(), tracks: [video(), { ...audio(), url: video().url }] },
    { ...resolution(), tracks: [video(), { ...audio(), formatId: video().formatId }] },
    { ...resolution(), duration: -1 }, { ...resolution(), duration: NaN }, { ...resolution(), headers: {} }]) assert.throws(() => youtubeResolution(value, URL));
  const cyclic: Record<string, unknown> = resolution(); cyclic.cycle = cyclic;
  assert.throws(() => youtubeResolution(cyclic, URL));
});


const source = (formats: object[], extra: object = {}) => ({
  playabilityStatus: { status: 'OK' },
  videoDetails: { videoId: ID, title: '공개 영상', lengthSeconds: '104', isLiveContent: false },
  streamingData: { formats: [], adaptiveFormats: formats },
  ...extra,
});
const stream = (itag: number, mimeType: string, extra: object = {}) => ({
  itag, mimeType, url: 'https://rr1---sn-test.googlevideo.com/videoplayback?itag=' + itag,
  bitrate: 1000000 + itag, ...extra,
});
test('Browser extractor selects video and audio at the requested quality', () => {
  const formats = [
    stream(137, 'video/mp4; codecs="avc1"', { height: 1080 }),
    stream(136, 'video/mp4; codecs="avc1"', { height: 720 }),
    stream(140, 'audio/mp4; codecs="mp4a.40.2"'),
  ];
  const full = browserYouTubeResolution(source(formats), URL, options);
  assert.deepEqual(full.tracks.map(track => track.kind), ['video', 'audio']);
  assert.equal(full.tracks[0]?.height, 1080);
  assert.equal(browserYouTubeResolution(source(formats), URL, { quality: '720', output: 'original' }).tracks[0]?.height, 720);
  assert.deepEqual(browserYouTubeResolution(source(formats), URL, { quality: 'highest', output: 'm4a' }).tracks.map(track => track.kind), ['audio']);
});
test('Ciphered URLs, untrusted hosts and nonpublic videos fail closed', () => {
  for (const changes of [
    { signatureCipher: 'cipher' },
    { url: 'https://example.net/videoplayback' },
    { url: 'http://rr1.googlevideo.com/videoplayback' },
  ]) assert.throws(() => browserYouTubeResolution(source([stream(137, 'video/mp4', { height: 1080, ...changes })]), URL, options));
  assert.throws(() => browserYouTubeResolution(source([]), URL, options), /서명/);
  assert.throws(() => browserYouTubeResolution(source([], { playabilityStatus: { status: 'LOGIN_REQUIRED' } }), URL, options), /로그인/);
});
test('Browser readiness does not depend on a Native Messaging host', async () => {
  assert.equal((await probeYouTube()).status, 'ready');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(resolveYouTube(URL, options, controller.signal), { name: 'AbortError' });
});
test('HTML watch-response JSON is parsed without running page scripts', async () => {
  const original = globalThis.fetch;
  const player = source([stream(137, 'video/mp4', { height: 1080 }), stream(140, 'audio/mp4')]);
  const html = '<html><script>var ytInitialPlayerResponse = ' + JSON.stringify(player) + ';</script></html>';
  globalThis.fetch = async (input: string | URL | Request) => {
    const response = new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    Object.defineProperty(response, 'url', { value: String(input) });
    return response;
  };
  try {
    const actual = await resolveYouTube(URL, options, new AbortController().signal);
    assert.equal(actual.videoId, ID);
    assert.equal(actual.tracks.length, 2);
  } finally { globalThis.fetch = original; }
});
