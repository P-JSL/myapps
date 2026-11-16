import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { missavMediaURL, missavPlaylistURLs } from '../src/local/missav.ts';

const page = 'https://missav123.com/ko/offline-fixture';
const uuid = 'A1B2C3D4-1234-5678-AbCd-1234567890AB';
const id = uuid.toLowerCase();
const requested = `https://surrit.com/${uuid}/720p//video.m3u8?signature=Keep%2FCase%2BExact&expires=123`;

test('keep a requested playlist path and signed query exactly as the browser used them', () => {
  assert.equal(missavMediaURL(requested + '#player'), requested);
  assert.deepEqual(missavPlaylistURLs(page, [], [requested]), [requested]);
});

test('a requested playlist replaces guessed masters and stale script URLs for the same video', () => {
  const guessed = `https://surrit.com/${id}/seek`;
  const script = `const src="https://nineyu.com/${id}/playlist.m3u8?signature=expired";`;
  assert.deepEqual(missavPlaylistURLs(page, [script], [guessed, requested]), [requested]);
  assert.deepEqual(missavPlaylistURLs(page, [script], [requested, guessed]), [requested]);
});

test('real playlist URLs in scripts take precedence over synthesized fallback hosts', () => {
  const explicit = `https://fourhoi.store/${uuid}/playlist.m3u8?sig=Original`;
  assert.deepEqual(missavPlaylistURLs(page,
    [`const other="https://nineyu.com/${id}/seek";`, `const real="${explicit}";`]), [explicit]);
});

test('retain unrelated video candidates while dropping only weaker guesses of an observed video', () => {
  const other = '11111111-1111-1111-1111-111111111111';
  assert.deepEqual(missavPlaylistURLs(page, [`const src="${other}/seek";`], [requested]),
    [requested, `https://surrit.com/${other}/playlist.m3u8`]);
});

test('selecting the exact requested URL avoids a reproducible HTTP 403 from a case-sensitive signed endpoint', async () => {
  const path = new URL(requested).pathname + new URL(requested).search;
  const hits: Array<{ path: string; status: number }> = [];
  const server = createServer((req, res) => {
    const status = req.url === path ? 200 : 403;
    hits.push({ path: req.url ?? '', status });
    res.writeHead(status, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(status === 200 ? '#EXTM3U\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n' : 'Forbidden');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert(address && typeof address !== 'string');
    const urls = missavPlaylistURLs(page, [`const source="${id}/seek";`], [requested]);
    assert.deepEqual(urls, [requested]);
    const selected = new URL(urls[0]!);
    const result = await fetch(`http://127.0.0.1:${address.port}${selected.pathname}${selected.search}`);
    assert.equal(result.status, 200);
    assert.match(await result.text(), /^#EXTM3U/);
    assert.deepEqual(hits, [{ path, status: 200 }]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
