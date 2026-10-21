import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mediaURL, mediaKind, filenameFor, trustedCapture, trustedUI, retainHistory, MAX_HISTORY, type HistoryItem } from '../src/local/model.ts';
import { attributes, parseByteRange, planHls } from '../src/local/hls.ts';
import { fetchBytes } from '../src/local/network.ts';

test('history retention bounds records without hiding older unresolved downloads or mutating its input', () => {
  const active = ['preparing', 'downloading', 'scanning', 'review'].map((state, index) => ({
    id: crypto.randomUUID(), url: 'https://media.test/active.mp4', filename: 'active.mp4', kind: 'file', state,
    createdAt: index, incognito: false,
  } as HistoryItem));
  const completed = Array.from({ length: MAX_HISTORY + 20 }, (_, index) => ({
    ...active[0]!, id: crypto.randomUUID(), state: 'complete' as const, createdAt: 100 + index,
  }));
  const input = [...completed, ...active]; const originalIds = input.map(row => row.id);
  const retained = retainHistory(input);
  assert.equal(retained.length, MAX_HISTORY);
  assert.deepEqual(new Set(retained.slice(0, active.length).map(row => row.id)), new Set(active.map(row => row.id)));
  assert.equal(retained[active.length]!.id, completed.at(-1)!.id);
  assert.deepEqual(input.map(row => row.id), originalIds);
});

test('local media URLs reject executable schemes and embedded credentials', () => {
  assert.equal(mediaURL('../video.mp4?sig=abc#time', 'https://example.test/a/page').href, 'https://example.test/video.mp4?sig=abc');
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hello', 'ftp://example.test/a.mp4', 'https://user:pass@example.test/a.mp4']) assert.throws(() => mediaURL(url));
});
test('media discovery recognizes manifests and whole files without offering transport fragments', () => {
  assert.equal(mediaKind('https://media.test/list.m3u8?token=x'), 'hls');
  assert.equal(mediaKind('https://media.test/feed', 'application/dash+xml'), 'dash');
  assert.equal(mediaKind('https://media.test/feed', 'video/mp4'), 'file');
  assert.equal(mediaKind('https://media.test/feed', '', true), 'file');
  assert.equal(mediaKind('https://media.test/segment.ts', 'video/mp2t'), undefined);
  assert.equal(mediaKind('https://media.test/segment.m4s', 'video/mp4'), undefined);
  assert.equal(mediaKind('https://media.test/page.html', 'text/html'), undefined);
});
test('local filenames use media extensions, strip paths and support Windows reserved names', () => {
  const input = { url: 'https://media.test/raw.exe', title: '../CON', mime: 'video/mp4', kind: 'file' as const };
  assert.equal(filenameFor(input), '_CON.mp4');
  assert.equal(filenameFor({ ...input, title: '', url: 'https://media.test/a.webm' }), 'a.webm');
  assert.equal(filenameFor({ ...input, title: '영화', kind: 'hls' }), '영화.mp4');
});
test('local commands distinguish extension UI from website collectors', () => {
  const id = 'example'; const base = 'chrome-extension://example/';
  assert(trustedUI({ id, url: base + 'local/index.html?x=1' }, id, base));
  assert(trustedUI({ id, url: base + 'upscale/index.html' }, id, base));
  assert(!trustedUI({ id, url: base + 'local/index.html.evil' }, id, base));
  assert(!trustedUI({ id, url: 'https://example.test/local/index.html' }, id, base));
  assert(!trustedUI({ id: 'other', url: base + 'local/index.html' }, id, base));
  assert(trustedCapture({ id, url: 'https://example.test/page', tab: { id: 5 } }, id));
  assert(!trustedCapture({ id, url: base + 'local/index.html', tab: { id: 5 } }, id));
  assert(!trustedCapture({ id, url: 'https://example.test/page' }, id));
});
test('popup commands require exact extension page and origin', () => {
  const id = 'example', base = 'chrome-extension://example/';
  for (const suffix of ['', '?view=history', '#settings']) assert(trustedUI({ id, url: base + 'local/popup.html' + suffix }, id, base));
  for (const url of [base + 'local/popup.html.evil', base + 'local/popup.html/other', base + 'local/POPUP.html',
    'https://example.test/local/popup.html', 'chrome-extension://other/local/popup.html']) assert(!trustedUI({ id, url }, id, base), url);
  assert(!trustedUI({ id: 'other', url: base + 'local/popup.html' }, id, base));
});
test('HLS attributes preserve quoted commas and reject dangerous byte ranges', () => {
  assert.equal(attributes('TYPE=AUDIO,GROUP-ID="audio",NAME="English, main",DEFAULT=YES').NAME, 'English, main');
  assert.deepEqual(parseByteRange('42@10'), { length: 42, offset: 10 });
  assert.deepEqual(parseByteRange('42', 52), { length: 42, offset: 52 });
  for (const input of ['-1@0', '0@0', '2@-1', '1@9007199254740992', '2@9007199254740991', '999999999999999']) assert.throws(() => parseByteRange(input));
});
test('HLS media plans rewrite all source references into controlled local paths', async () => {
  const text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\none.ts?sig=x\n#EXTINF:1,\n../two.ts\n#EXT-X-ENDLIST\n';
  const plan = await planHls('https://media.test/a/list.m3u8', async () => text);
  assert.deepEqual(plan.assets.map(a => a.url), ['https://media.test/a/one.ts?sig=x', 'https://media.test/two.ts']);
  assert.match(plan.inputs[0]!.playlist!, /asset-00000.ts/);
  assert(!plan.inputs[0]!.playlist!.includes('https:'));
});
test('HLS masters choose a complete video and its default external audio', async () => {
  const sources: Record<string, string> = {
    'https://media.test/master.m3u8': '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=10\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO="a"\nhigh.m3u8',
    'https://media.test/high.m3u8': '#EXTM3U\n#EXTINF:1,\nvideo.ts\n#EXT-X-ENDLIST',
    'https://media.test/audio.m3u8': '#EXTM3U\n#EXTINF:1,\naudio.ts\n#EXT-X-ENDLIST',
  };
  const plan = await planHls('https://media.test/master.m3u8', async url => { assert(url in sources); return sources[url]!; });
  assert.equal(plan.inputs.length, 2); assert.equal(plan.assets.length, 2);
  assert.equal(plan.assets[0]!.url, 'https://media.test/video.ts');
  assert.equal(plan.assets[1]!.url, 'https://media.test/audio.ts');
});
test('HLS byte ranges and init segments are materialized as separate local files', async () => {
  const text = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="10@0"\n#EXTINF:1,\n#EXT-X-BYTERANGE:20@10\nall.m4s\n#EXTINF:1,\n#EXT-X-BYTERANGE:30\nall.m4s\n#EXT-X-ENDLIST';
  const plan = await planHls('https://media.test/list.m3u8', async () => text);
  assert.deepEqual(plan.assets.map(a => a.range), [{ length: 10, offset: 0 }, { length: 20, offset: 10 }, { length: 30, offset: 30 }]);
  assert(!plan.inputs[0]!.playlist!.includes('BYTERANGE'));
});
test('HLS rejects encryption before fetching a key or child playlist', async () => {
  let reads = 0;
  await assert.rejects(planHls('https://media.test/list.m3u8', async () => { reads++; return '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://keys.test/key"\n#EXTINF:1,\nvideo.ts\n#EXT-X-ENDLIST'; }), /암호화/);
  assert.equal(reads, 1);
});
test('HLS rejects open live windows, cycles, executable URLs and empty streams', async () => {
  await assert.rejects(planHls('https://media.test/list.m3u8', async () => '#EXTM3U\n#EXTINF:1,\na.ts'), /VOD/);
  await assert.rejects(planHls('https://media.test/list.m3u8', async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlist.m3u8'), /순환/);
  await assert.rejects(planHls('https://media.test/list.m3u8', async () => '#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n#EXT-X-ENDLIST'), /HTTP/);
  await assert.rejects(planHls('https://media.test/list.m3u8', async () => '#EXTM3U\n#EXT-X-ENDLIST'), /조각/);
});
test('HLS redirect aliases cannot bypass cycle detection or URL validation', async () => {
  const root = 'https://media.test/master.m3u8';
  const effective = 'https://cdn.test/path/master.m3u8';
  let reads = 0;
  await assert.rejects(planHls(root, async () => {
    reads++;
    return { url: effective, text: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nalias.m3u8' };
  }), /순환/);
  assert.equal(reads, 2);
  for (const url of ['file:///video/list.m3u8', 'https://user:secret@cdn.test/list.m3u8']) {
    await assert.rejects(planHls(root, async () => ({ url, text: '#EXTM3U\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST' })), /HTTP/);
  }
});
test('network reader enforces byte limits, validates ranges, handles ignored ranges and aborts', async () => {
  const data = Buffer.from('0123456789');
  const server = createServer((request, response) => {
    if (request.url === '/partial') response.writeHead(206, { 'Content-Range': 'bytes 2-4/10' }).end(data.subarray(2, 5));
    else if (request.url === '/wrong') response.writeHead(206, { 'Content-Range': 'bytes 0-2/10' }).end(data.subarray(0, 3));
    else response.writeHead(200, { 'Content-Length': data.length }).end(data);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const signal = new AbortController().signal;
    assert.equal(new TextDecoder().decode(await fetchBytes(base, 10, signal)), '0123456789');
    await assert.rejects(fetchBytes(base, 9, signal), /한도/);
    assert.equal(new TextDecoder().decode(await fetchBytes(base + '/partial', 10, signal, { offset: 2, length: 3 })), '234');
    assert.equal(new TextDecoder().decode(await fetchBytes(base, 10, signal, { offset: 2, length: 3 })), '234');
    await assert.rejects(fetchBytes(base + '/wrong', 10, signal, { offset: 2, length: 3 }), /범위/);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(fetchBytes(base, 10, abort.signal));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
