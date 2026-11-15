import test from 'node:test';
import assert from 'node:assert/strict';
import { isMissavPage, missavPlaylistURLs } from '../src/local/missav.ts';

const uuid = 'A1B2C3D4-1234-5678-abcd-1234567890ab';
const playlist = 'https://surrit.com/' + uuid.toLowerCase() + '/playlist.m3u8';
const mirrors = ['missav.ws', 'missav.ai', 'missav.live', 'missav.fans', 'missav.media', 'missav123.com', 'missav01.com'];

test('detect only MissAV pages, including mirrors and localized paths', () => {
  for (const host of mirrors) {
    assert.equal(isMissavPage('https://' + host + '/en/video-123'), true, host);
    assert.equal(isMissavPage('https://www.' + host + '/dm22/en/video-123'), true, host);
  }
  for (const url of ['https://missav.ws.evil.example/video', 'https://notmissav.ws/video',
    'https://missav.ws@evil.example/video', 'https://example.org/video', 'file:///video', 'bad url']) {
    assert.equal(isMissavPage(url), false, url);
    assert.deepEqual(missavPlaylistURLs(url, ["'" + uuid + "/seek'"]), []);
  }
});

test('resolve the reference player seek pattern from inline script', () => {
  assert.deepEqual(missavPlaylistURLs('https://missav.ws/en/abc-123', [
    'window.player = {url:"' + uuid + '/seek"};',
  ]), [playlist]);
});

test('detect explicit and JSON-escaped CDN URLs and deduplicate master HLS', () => {
  const script = 'var hls="https:\\/\\/surrit.com\\/' + uuid + '\\/playlist.m3u8";';
  assert.deepEqual(missavPlaylistURLs('https://missav01.com/movie', [
    script, 'https://surrit.com/' + uuid + '/720p/playlist.m3u8',
  ]), [playlist]);
});

test('ignore unrelated UUIDs and ambiguous fallback matches', () => {
  assert.deepEqual(missavPlaylistURLs('https://missav.ws/video', ["const tracking = '" + uuid + "';"]), []);
  assert.deepEqual(missavPlaylistURLs('https://missav.ws/video', [
    'seek(); const first="' + uuid + '"; const other="11111111-1111-1111-1111-111111111111";',
  ]), []);
});

test('bound script inspection without losing later valid scripts', () => {
  const script = 'url = "' + uuid + '/seek";';
  assert.deepEqual(missavPlaylistURLs('https://missav.ws/video', [' '.repeat(512 * 1024 + 1), script]), [playlist]);
  assert.deepEqual(missavPlaylistURLs('https://missav.ws/video', [...Array(256).fill(''), script]), []);
});
