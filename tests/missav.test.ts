import test from 'node:test';
import assert from 'node:assert/strict';
import { isMissavPage, missavMediaURL, missavPlaylistURLs } from '../src/local/missav.ts';

const uuid = 'A1B2C3D4-1234-5678-abcd-1234567890ab';
const id = uuid.toLowerCase();
const playlist = 'https://surrit.com/' + id + '/playlist.m3u8';
const page = 'https://missav123.com/ko/ebwh-352-uncensored-leak';
const mirrors = ['missav.ws', 'missav.ai', 'missav.live', 'missav.fans',
  'missav.media', 'missav123.com', 'missav01.com'];

test('recognize the reported /ko/ MissAV page and supported mirrors', () => {
  assert.equal(isMissavPage(page), true);
  for (const host of mirrors) {
    assert.equal(isMissavPage('https://' + host + '/ko/example'), true, host);
    assert.equal(isMissavPage('https://www.' + host + '/dm22/en/example'), true, host);
  }
  for (const url of ['https://missav.ws.evil.test/watch', 'https://notmissav.ws/watch',
    'https://missav.ws@evil.test/video', 'https://example.org/watch', 'file:///video', 'bad url']) {
    assert.equal(isMissavPage(url), false, url);
    assert.deepEqual(missavPlaylistURLs(url, ['"' + uuid + '/seek"']), []);
  }
});

test('extract inline /seek player reference without requiring a direct video element', () => {
  assert.deepEqual(missavPlaylistURLs(page, [
    'window.player = {url:"' + uuid + '/seek"};',
  ]), [playlist]);
});

test('handle explicit, escaped and unicode-escaped CDN playlist URLs', () => {
  assert.deepEqual(missavPlaylistURLs(page, [
    'var src="https:\\/\\/surrit.com\\/' + uuid + '\\/playlist.m3u8";',
    'var duplicate="https://surrit.com/' + uuid + '/playlist.m3u8";',
    'var escape="https:\\u002f\\u002fsurrit.com\\u002f' + uuid + '\\u002fplaylist.m3u8";',
  ]), [playlist]);
});

test('resolve CDN variants and preserve the actually requested playlist', () => {
  const variant = 'https://surrit.com/' + id + '/720p/video.m3u8?token=example';
  assert.equal(missavMediaURL(variant), variant);
  assert.deepEqual(missavPlaylistURLs(page, [], [variant]), [variant]);
  assert.deepEqual(missavPlaylistURLs(page, [], [
    'https://surrit.com/' + uuid + '/720p/fragment000.ts',
  ]), [playlist]);
});

test('support reference player alternative CDN hosts without allowing arbitrary hosts', () => {
  assert.deepEqual(missavPlaylistURLs(page, [
    'https://nineyu.com/' + uuid + '/seek',
    'https://fourhoi.store/' + uuid + '/playlist.m3u8',
  ]), ['https://nineyu.com/' + id + '/playlist.m3u8',
    'https://fourhoi.store/' + id + '/playlist.m3u8']);
  for (const url of [
    'https://surrit.com.evil.test/' + uuid + '/playlist.m3u8',
    'http://surrit.com/' + uuid + '/playlist.m3u8',
    'https://evil.test/' + uuid + '/playlist.m3u8',
    'https://surrit.com/' + uuid + '/video.html',
    'https://surrit.com/' + uuid + '/bad.mp4@evil.test/',
  ]) assert.equal(missavMediaURL(url), undefined, url);
});

test('avoid unrelated UUID matches and unknown scripts', () => {
  assert.deepEqual(missavPlaylistURLs(page, ['const campaign = "' + uuid + '";']), []);
  assert.deepEqual(missavPlaylistURLs(page, [
    'seek(); const first="' + uuid + '"; const other="11111111-1111-1111-1111-111111111111";',
  ]), []);
});

test('strict bounds prevent scanning excessive inline scripts and resource URLs', () => {
  const inline = 'video = "' + uuid + '/seek";';
  assert.deepEqual(missavPlaylistURLs(page, [' '.repeat(512 * 1024 + 1), inline]), [playlist]);
  assert.deepEqual(missavPlaylistURLs(page, [...Array(256).fill(''), inline]), []);
  assert.deepEqual(missavPlaylistURLs(page, [], [...Array(1500).fill('bad'), playlist]), []);
});

test('observed HLS requests are recognized without nextHopProtocol/ALPN metadata', () => {
  const observed = 'https://surrit.com/' + uuid + '/playlist.m3u8';
  assert.deepEqual(missavPlaylistURLs(page, [], [observed]), [observed]);
  assert.equal(missavMediaURL('https://surrit.com/' + uuid + '/seek'), playlist);
});
