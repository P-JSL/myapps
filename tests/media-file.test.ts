import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMediaFile, mediaFilename, probeMediaFile, InvalidMediaFileError } from '../src/local/media-file.ts';
const text = (value: string) => new TextEncoder().encode(value);
function iso(brand = 'isom', compatible = 'mp42') {
  const bytes = new Uint8Array(20); new DataView(bytes.buffer).setUint32(0, 20);
  bytes.set(text('ftyp'), 4); bytes.set(text(brand), 8); bytes.set(text(compatible), 16); return bytes;
}
function ebml(type: string) {
  return new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80 | (3 + type.length), 0x42, 0x82, 0x80 | type.length, ...text(type)]);
}
test('container signatures distinguish MP4, MOV, M4A, WebM and Matroska', () => {
  for (const [bytes, mime, extension] of [
    [iso(), 'video/mp4', 'mp4'], [iso('qt  '), 'video/quicktime', 'mov'], [iso('M4A '), 'audio/mp4', 'm4a'],
    [ebml('webm'), 'video/webm', 'webm'], [ebml('matroska'), 'video/x-matroska', 'mkv'],
  ] as const) assert.deepEqual(inspectMediaFile(bytes), { mime, extension });
});
test('non-media and image containers cannot masquerade as video', () => {
  for (const bytes of [text('<html>video.mp4</html>'), text('download failed'), text('{"video":"mp4"}'), text('MZ executable'),
    new Uint8Array(), iso().subarray(0, 12), iso('avif'), iso('heic'), iso('mif1'), iso('isom', 'avif'),
    ebml('not-media'), text('RIFFxxxxWEBP'), text('OggS random text')]) assert.throws(() => inspectMediaFile(bytes), InvalidMediaFileError);
});
test('download names use detected format and remove misleading text suffixes safely', () => {
  const mp4 = inspectMediaFile(iso()), webm = inspectMediaFile(ebml('webm'));
  assert.equal(mediaFilename('video.txt', mp4), 'video.mp4');
  assert.equal(mediaFilename('video.txt.mp4', mp4), 'video.mp4');
  assert.equal(mediaFilename('recording.mp4', webm), 'recording.webm');
  const safe = mediaFilename('../../CON.txt', mp4);
  assert(!/[\\/]/.test(safe)); assert(!/^CON(?:\.|$)/i.test(safe));
  assert.equal(mediaFilename(mediaFilename('video.txt', mp4), mp4), 'video.mp4');
});
test('signature probe bounds and cancels ignored Range responses despite text MIME', async () => {
  let pulls = 0, canceled = 0;
  const payload = new Uint8Array(131_072); payload.set(iso());
  const actual = await probeMediaFile('https://media.test/video.txt', undefined, { fetch: async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('Range'), 'bytes=0-65535');
    assert.equal(init?.credentials, 'include'); assert.equal(init?.redirect, 'follow'); assert(init?.signal);
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(payload); }, cancel() { canceled++; },
    }), { headers: { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="video.txt"' } });
  } });
  assert.deepEqual(actual, { mime: 'video/mp4', extension: 'mp4' }); assert.equal(canceled, 1); assert(pulls <= 2);
});
test('signature probe rejects mislabeled HTML, images, HTTP errors and invalid ranges', async () => {
  for (const body of [text('<html>Access denied</html>'), text('not a video'), iso('avif')]) {
    await assert.rejects(probeMediaFile('https://media.test/video.mp4', undefined, {
      fetch: async () => new Response(body, { headers: { 'Content-Type': 'video/mp4' } }),
    }), InvalidMediaFileError);
  }
  await assert.rejects(probeMediaFile('https://media.test/video.mp4', undefined, { fetch: async () => new Response(iso(), { status: 403 }) }), /403/);
  for (const range of ['bytes 1-19/20', 'bytes 0-65536/65537', 'bytes 0-19/19']) {
    await assert.rejects(probeMediaFile('https://media.test/video.mp4', undefined, {
      fetch: async () => new Response(iso(), { status: 206, headers: { 'Content-Range': range } }),
    }), /범위/);
  }
  assert.equal((await probeMediaFile('https://media.test/video.txt', undefined, {
    fetch: async () => new Response(iso(), { status: 206, headers: { 'Content-Range': 'bytes 0-19/20' } }),
  })).extension, 'mp4');
});
test('signature probe cancels and times out stalled fetch and body', async () => {
  const controller = new AbortController(); controller.abort(new Error('already canceled'));
  let fetched = false;
  await assert.rejects(probeMediaFile('https://media.test/video.mp4', controller.signal, {
    fetch: async () => { fetched = true; return new Response(iso()); },
  }), /already canceled/); assert.equal(fetched, false);
  await assert.rejects(probeMediaFile('https://media.test/video.mp4', undefined, {
    timeoutMs: 15, fetch: async () => new Promise<Response>(() => {}),
  }), /초과/);
  let canceled = false;
  await assert.rejects(probeMediaFile('https://media.test/video.mp4', undefined, {
    timeoutMs: 15, fetch: async () => new Response(new ReadableStream<Uint8Array>({ cancel() { canceled = true; } })),
  }), /초과/); assert.equal(canceled, true);
});
test('large ID3 metadata preserves MP3 frames beyond the signature prefix', () => {
  const bytes = new Uint8Array(100_014); bytes.set([73, 68, 51, 4, 0, 0, 0, 6, 13, 32]);
  bytes.set([255, 251, 144, 0], 100_010);
  assert.deepEqual(inspectMediaFile(bytes), { mime: 'audio/mpeg', extension: 'mp3' });
  assert.throws(() => inspectMediaFile(bytes.subarray(0, 100_010)), InvalidMediaFileError);
});
