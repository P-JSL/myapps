/** Real production offscreen/OPFS and browser disk-download audit. Chrome APIs
 * are the main harness's doubles; the 2 GiB media response is generated in small
 * chunks, never allocated or kept as a giant fixture in the repository.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PADDING_BYTES = 2 ** 31;
const RESPONSE_CHUNK_BYTES = 64 * 1024;
const MAXIMUM_BLOB_READ = 8 * 1024 * 1024;
const ENDPOINTS = new Set(['large-parallel.mp4', 'large-cancel.mp4', 'large-quota.mp4', 'large-stream.mp4']);
let fixture;
const stats = new Map();
const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function patchChunkOffsets(bytes, start, end, insertedAt) {
  for (let offset = start; offset < end;) {
    assert(offset + 8 <= end, 'Complete MP4 box header required');
    const length = bytes.readUInt32BE(offset);
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    assert(length >= 8 && offset + length <= end, 'Fixture uses bounded 32-bit MP4 boxes');
    if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(kind)) patchChunkOffsets(bytes, offset + 8, offset + length, insertedAt);
    if (kind === 'stco' || kind === 'co64') {
      assert(offset + 16 <= offset + length);
      const count = bytes.readUInt32BE(offset + 12), width = kind === 'stco' ? 4 : 8;
      assert(offset + 16 + count * width <= offset + length);
      for (let index = 0; index < count; index++) {
        const position = offset + 16 + index * width;
        const current = width === 4 ? bytes.readUInt32BE(position) : Number(bytes.readBigUInt64BE(position));
        if (current < insertedAt) continue;
        const updated = current + PADDING_BYTES;
        if (width === 4) { assert(updated <= 0xffffffff); bytes.writeUInt32BE(updated, position); }
        else bytes.writeBigUInt64BE(BigInt(updated), position);
      }
    }
    offset += length;
  }
}

function virtualBytes(start, length) {
  const bytes = Buffer.alloc(length);
  const stop = start + length;
  for (const [offset, source] of fixture.regions) {
    const from = Math.max(start, offset), to = Math.min(stop, offset + source.length);
    if (to > from) source.copy(bytes, from - start, from - offset, to - offset);
  }
  return bytes;
}

export async function prepareLargeDownloadAudit(fixtures) {
  const originalPath = path.join(fixtures, 'clip.mp4');
  const clip = Buffer.from(await readFile(originalPath));
  const firstBoxSize = clip.readUInt32BE(0);
  assert.equal(clip.toString('ascii', 4, 8), 'ftyp');
  assert(firstBoxSize >= 16 && firstBoxSize <= clip.length);
  patchChunkOffsets(clip, 0, clip.length, firstBoxSize);
  const paddingHeader = Buffer.alloc(8); paddingHeader.writeUInt32BE(PADDING_BYTES, 0); paddingHeader.write('free', 4, 'ascii');
  fixture = { size: clip.length + PADDING_BYTES,
    regions: [[0, clip.subarray(0, firstBoxSize)], [firstBoxSize, paddingHeader], [firstBoxSize + PADDING_BYTES, clip.subarray(firstBoxSize)]],
    buildSha256: JSON.parse(await readFile('reports/build.json', 'utf8')).buildSha256,
    originalPath,
  };
  const hash = createHash('sha256');
  for (let position = 0; position < fixture.size; position += 4 * 1024 * 1024) {
    hash.update(virtualBytes(position, Math.min(4 * 1024 * 1024, fixture.size - position)));
  }
  fixture.sha256 = hash.digest('hex');
  // Two genuine low-frame-rate frames span four hours without generating or
  // retaining hours of encoded pictures. Duration and decoding are both real.
  const longPath = path.join(fixtures, 'long-duration.mp4');
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=1/7201',
    '-frames:v', '2', '-fps_mode', 'passthrough', '-c:v', 'libx264', '-bf', '0', '-g', '1', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', '-y', longPath]);
  fixture.longPath = longPath;
  fixture.longMetadata = probe(longPath);
  fixture.longDuration = Number(fixture.longMetadata.format.duration);
  assert(fixture.longDuration > 7200);
  assert.equal(Number(fixture.longMetadata.streams.find(stream => stream.codec_type === 'video').nb_read_frames), 2);
  assert((await stat(longPath)).size < 64 * 1024, 'Sparse-duration fixture must stay small');
  stats.clear();
  return { size: fixture.size, sha256: fixture.sha256 };
}

function stateFor(name) {
  if (!stats.has(name)) stats.set(name, { requests: 0, rangeRequests: 0, maximumActive: 0, active: 0, bytesSent: 0, aborted: 0 });
  return stats.get(name);
}

async function serve(request, response, name) {
  const state = stateFor(name); state.requests++; state.active++; state.maximumActive = Math.max(state.maximumActive, state.active);
  let ended = false;
  const finish = () => { if (!ended) { ended = true; state.active--; } };
  response.once('finish', finish);
  response.once('close', () => { if (!response.writableFinished) state.aborted++; finish(); });
  let start = 0, end = fixture.size - 1;
  if (request.headers.range) {
    const match = request.headers.range.match(/^bytes=(\d+)-(\d+)$/);
    if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2]))) { response.writeHead(416).end(); return; }
    start = Number(match[1]); end = Math.min(Number(match[2]), fixture.size - 1);
    if (start > end || start >= fixture.size) { response.writeHead(416).end(); return; }
    state.rangeRequests++;
  }
  const headers = { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, ETag: '"owned-large-fixture-v1"', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
  if (request.headers.range) headers['Content-Range'] = `bytes ${start}-${end}/${fixture.size}`;
  response.writeHead(request.headers.range ? 206 : 200, headers);
  for (let position = start; position <= end && !response.destroyed;) {
    const length = Math.min(RESPONSE_CHUNK_BYTES, end - position + 1);
    const accepted = response.write(virtualBytes(position, length));
    state.bytesSent += length; position += length;
    if (!accepted) await new Promise(resolve => {
      const done = () => { response.off('drain', done); response.off('close', done); resolve(); };
      response.once('drain', done); response.once('close', done);
    });
    if (name === 'large-cancel.mp4') await delay(4);
    else await tick();
  }
  if (!response.destroyed) response.end();
}

/** Call at the beginning of the main harness HTTP handler. */
export function handleLargeDownloadRequest(request, response) {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const name = pathname.startsWith('/fixtures/') ? pathname.slice('/fixtures/'.length) : '';
  if (fixture && ['large-stream.mpd', 'long-duration.mpd'].includes(name)) {
    const long = name === 'long-duration.mpd';
    const xml = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT${long ? fixture.longDuration : 1}S"><Period><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v" bandwidth="100000"><BaseURL>${long ? 'long-duration.mp4' : 'large-stream.mp4'}</BaseURL></Representation></AdaptationSet></Period></MPD>`;
    response.writeHead(200, { 'Content-Type': 'application/dash+xml', 'Content-Length': Buffer.byteLength(xml), 'Cache-Control': 'no-store' }).end(xml);
    return true;
  }
  if (!fixture || !ENDPOINTS.has(name)) return false;
  void serve(request, response, name).catch(error => { if (!response.destroyed) response.destroy(error); });
  return true;
}

async function fileSha256(filename) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(filename, { highWaterMark: 4 * 1024 * 1024 })) hash.update(bytes);
  return hash.digest('hex');
}

function run(binary, args, encoding = 'utf8') {
  const result = spawnSync(binary, args, { encoding, maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
  assert.equal(result.status, 0, `${binary} failed: ${result.error?.message ?? result.stderr?.toString().slice(-1500)}`);
  return result.stdout;
}

function probe(filename) {
  return JSON.parse(run('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', filename]));
}

function videoPayloadSha256(filename) {
  return createHash('sha256').update(run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', filename,
    '-map', '0:v:0', '-c:v', 'copy', '-an', '-f', 'h264', 'pipe:1'], null)).digest('hex');
}

function decode(filename) {
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', filename, '-vsync', '0', '-f', 'null', '-']);
}

async function savePrepared(page, url, destination) {
  const pending = page.waitForEvent('download', { timeout: 300_000 });
  await page.evaluate(({ url, name }) => {
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name;
    document.body.append(anchor); anchor.click(); anchor.remove();
  }, { url, name: path.basename(destination) });
  const download = await pending; await download.saveAs(destination);
  assert.equal(await download.failure(), null);
}

async function waitFor(predicate, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { assert(Date.now() < deadline, message); await delay(20); }
}

async function assertRemoved(page, id) {
  const leftovers = await page.evaluate(async id => {
    const root = await navigator.storage.getDirectory(), found = [];
    for (const name of [`local-${id}.media`, `local-${id}.assets`]) {
      try { await root.getFileHandle(name); found.push(name); }
      catch (error) { if (error.name !== 'NotFoundError') throw error; }
    }
    return found;
  }, id);
  assert.deepEqual(leftovers, [], 'Owned partial files must be removed');
}

/** Five end-to-end scenarios; no giant media fixture is retained after audit. */
export async function runLargeDownloadAudit(page, origin, results, checks) {
  assert(fixture, 'prepareLargeDownloadAudit must run before the HTTP server starts');
  const quotaBytes = 8 * 1024 * 1024 * 1024;
  const quotaBefore = await page.evaluate(() => navigator.storage.estimate());
  const session = await page.context().newCDPSession(page);
  try {
    const quotaProtocolBefore = await session.send('Storage.getUsageAndQuota', { origin });
    // The production manifest already grants unlimitedStorage. Its API double
    // runs at a disposable HTTP origin without that extension exemption.
    await session.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: quotaBytes });
    const quotaDuring = await page.evaluate(() => navigator.storage.estimate());
    const quotaProtocolDuring = await session.send('Storage.getUsageAndQuota', { origin });
    assert.equal(quotaProtocolDuring.quota, quotaBytes);
    assert.equal(quotaProtocolDuring.overrideActive, true);
    assert(quotaProtocolDuring.quota >= fixture.size, 'The isolated audit quota must fit the virtual video');
    const outcomes = [];
    await checks('A real video exceeding 2 GiB downloads in parallel to OPFS and saves as one byte-identical playable MP4', async () => {
      const id = await page.evaluate(() => crypto.randomUUID());
      const destination = path.join(results, 'large-parallel-audit.mp4');
      let prepared;
      try {
        await page.evaluate(maximum => {
          window.__largeOriginalBlobRead = Blob.prototype.arrayBuffer;
          window.__largestBlobRead = 0;
          Blob.prototype.arrayBuffer = function () {
            window.__largestBlobRead = Math.max(window.__largestBlobRead, this.size);
            if (this.size > maximum) throw Error('Audit disallows whole-file arrayBuffer on a large Blob');
            return window.__largeOriginalBlobRead.call(this);
          };
        }, MAXIMUM_BLOB_READ);
        prepared = await page.evaluate(async ({ id, url }) => {
          const offscreen = await window.__testOffscreen();
          const result = await offscreen.prepareLocal(id, url, 'file', { quality: 'highest', output: 'original' });
          const file = await (await (await navigator.storage.getDirectory()).getFileHandle(`local-${id}.media`)).getFile();
          return { result, size: file.size, maximumBlobRead: window.__largestBlobRead };
        }, { id, url: `${origin}/fixtures/large-parallel.mp4` });
        assert.equal(prepared.size, fixture.size);
        assert.equal(prepared.result.internalScanSize, fixture.size);
        assert.equal(prepared.result.internalScanSha256, fixture.sha256);
        assert.equal(prepared.result.extension, 'mp4');
        assert.equal(prepared.result.internalScan.complete, false, 'Partial structural screening must remain explicitly incomplete');
        assert(prepared.maximumBlobRead <= MAXIMUM_BLOB_READ);
        const pending = page.waitForEvent('download', { timeout: 300_000 });
        await page.evaluate(url => { const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'large-parallel-audit.mp4'; document.body.append(anchor); anchor.click(); anchor.remove(); }, prepared.result.url);
        const download = await pending; await download.saveAs(destination);
        assert.equal(await download.failure(), null);
        assert.equal((await stat(destination)).size, fixture.size);
        assert.equal(await fileSha256(destination), fixture.sha256);
        const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', destination], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 30_000 });
        assert.equal(probe.status, 0, probe.stderr);
        const metadata = JSON.parse(probe.stdout);
        assert(metadata.streams.some(stream => stream.codec_type === 'video' && stream.codec_name === 'h264'));
        assert(metadata.streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
        assert(Number(metadata.format.duration) > 0.9 && Number(metadata.format.duration) < 1.2);
        const traffic = { ...stateFor('large-parallel.mp4') };
        assert(traffic.rangeRequests > 10); assert(traffic.maximumActive >= 2 && traffic.maximumActive <= 4);
        assert.equal(traffic.bytesSent, fixture.size, 'Each byte is fetched once, including the retained probe');
        outcomes.push({ name: 'parallel-over-2-gib', status: 'passed', size: fixture.size, sha256: fixture.sha256,
          maximumBlobRead: prepared.maximumBlobRead, traffic, codecs: metadata.streams.map(stream => stream.codec_name), durationSeconds: Number(metadata.format.duration) });
      } finally {
        await page.evaluate(async id => { if (window.__largeOriginalBlobRead) Blob.prototype.arrayBuffer = window.__largeOriginalBlobRead; await (await window.__testOffscreen()).disposeLocal(id); }, id);
        await unlink(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      await assertRemoved(page, id);
    });
    await checks('Cancelling a multi-gigabyte preparation aborts parallel bodies and removes partial disk data', async () => {
      const id = await page.evaluate(async url => {
        const id = crypto.randomUUID(), offscreen = await window.__testOffscreen();
        window.__largeCancelled = offscreen.prepareLocal(id, url, 'file', { quality: 'highest', output: 'original' })
          .then(value => ({ ok: true, value }), error => ({ ok: false, message: error.message }));
        return id;
      }, `${origin}/fixtures/large-cancel.mp4`);
      await waitFor(() => stateFor('large-cancel.mp4').active >= 2 && stateFor('large-cancel.mp4').bytesSent > 256 * 1024, 'Parallel cancellation fixture must start');
      const result = await page.evaluate(async id => { await (await window.__testOffscreen()).cancelLocal(id); return window.__largeCancelled; }, id);
      assert.equal(result.ok, false); await assertRemoved(page, id);
      await waitFor(() => stateFor('large-cancel.mp4').active === 0, 'Cancelled network bodies must close');
      const traffic = { ...stateFor('large-cancel.mp4') };
      assert(traffic.aborted > 0); assert(traffic.bytesSent < fixture.size / 4);
      outcomes.push({ name: 'cancel-and-cleanup', status: 'passed', traffic });
    });
    await checks('An injected disk quota error aborts preparation and removes the partial OPFS video', async () => {
      const id = await page.evaluate(() => crypto.randomUUID());
      let result;
      try {
        result = await page.evaluate(async ({ id, url }) => {
          const original = FileSystemWritableFileStream.prototype.write;
          let written = 0;
          FileSystemWritableFileStream.prototype.write = function (chunk) {
            const data = chunk?.type === 'write' ? chunk.data : chunk;
            written += data?.byteLength ?? data?.size ?? 0;
            if (written > 128 * 1024) return Promise.reject(new DOMException('Injected audit quota limit', 'QuotaExceededError'));
            return original.call(this, chunk);
          };
          try {
            await (await window.__testOffscreen()).prepareLocal(id, url, 'file', { quality: 'highest', output: 'original' });
            return { ok: true, written };
          } catch (error) { return { ok: false, message: error.message, written }; }
          finally { FileSystemWritableFileStream.prototype.write = original; }
        }, { id, url: `${origin}/fixtures/large-quota.mp4` });
        assert.equal(result.ok, false); assert(result.written > 128 * 1024);
        await assertRemoved(page, id);
        await waitFor(() => stateFor('large-quota.mp4').active === 0, 'Quota failure must abort sibling requests');
        outcomes.push({ name: 'injected-quota-and-cleanup', status: 'passed', injectedFailure: true, traffic: { ...stateFor('large-quota.mp4') } });
      } finally { await page.evaluate(async id => (await window.__testOffscreen()).disposeLocal(id), id); }
    });
    await checks('A DASH source exceeding 2 GiB remuxes through real OPFS-backed FFmpeg into one intact MP4', async () => {
      const id = await page.evaluate(() => crypto.randomUUID());
      const destination = path.join(results, 'large-stream-remux-audit.mp4');
      try {
        await page.evaluate(maximum => {
          window.__largeOriginalBlobRead = Blob.prototype.arrayBuffer; window.__largestBlobRead = 0;
          Blob.prototype.arrayBuffer = function () {
            window.__largestBlobRead = Math.max(window.__largestBlobRead, this.size);
            if (this.size > maximum) throw Error('Large stream input must stay disk-backed');
            return window.__largeOriginalBlobRead.call(this);
          };
        }, MAXIMUM_BLOB_READ);
        const prepared = await page.evaluate(async ({ id, url }) => {
          const result = await (await window.__testOffscreen()).prepareLocal(id, url, 'dash', { quality: 'highest', output: 'original' });
          const file = await (await (await navigator.storage.getDirectory()).getFileHandle(`local-${id}.media`)).getFile();
          return { result, size: file.size, maximumBlobRead: window.__largestBlobRead };
        }, { id, url: `${origin}/fixtures/large-stream.mpd` });
        assert(prepared.result.ok); assert.equal(prepared.result.extension, 'mp4');
        assert(prepared.size > 0 && prepared.size < 1024 * 1024, 'Remux must omit the input free-box padding');
        assert(prepared.maximumBlobRead <= MAXIMUM_BLOB_READ);
        await savePrepared(page, prepared.result.url, destination);
        const metadata = probe(destination), video = metadata.streams.find(stream => stream.codec_type === 'video');
        assert.equal(video.codec_name, 'h264'); assert.equal(Number(video.nb_read_frames), 12);
        assert(metadata.streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
        assert(Number(metadata.format.duration) > 0.9 && Number(metadata.format.duration) < 1.2);
        const payloadSha256 = videoPayloadSha256(destination);
        assert.equal(payloadSha256, videoPayloadSha256(fixture.originalPath)); decode(destination);
        const traffic = { ...stateFor('large-stream.mp4') };
        assert.equal(traffic.bytesSent, fixture.size); assert.equal(traffic.requests, 1);
        outcomes.push({ name: 'disk-stream-remux-over-2-gib', status: 'passed', inputBytes: fixture.size,
          outputBytes: prepared.size, maximumPageBlobRead: prepared.maximumBlobRead, videoPayloadSha256: payloadSha256,
          frames: Number(video.nb_read_frames), durationSeconds: Number(metadata.format.duration), traffic });
      } finally {
        await page.evaluate(async id => { if (window.__largeOriginalBlobRead) Blob.prototype.arrayBuffer = window.__largeOriginalBlobRead; await (await window.__testOffscreen()).disposeLocal(id); }, id);
        await unlink(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      await assertRemoved(page, id);
    });
    await checks('A four-hour finite video downloads through DASH without a media-duration cap and preserves both frames', async () => {
      const id = await page.evaluate(() => crypto.randomUUID());
      const destination = path.join(results, 'long-duration-remux-audit.mp4');
      try {
        const prepared = await page.evaluate(async ({ id, url }) => (await window.__testOffscreen()).prepareLocal(id, url, 'dash', { quality: 'highest', output: 'original' }),
          { id, url: `${origin}/fixtures/long-duration.mpd` });
        assert(prepared.ok); assert.equal(prepared.extension, 'mp4');
        await savePrepared(page, prepared.url, destination);
        const metadata = probe(destination), video = metadata.streams.find(stream => stream.codec_type === 'video');
        assert.equal(video.codec_name, 'h264'); assert.equal(Number(video.nb_read_frames), 2);
        assert(Number(metadata.format.duration) > 7200);
        assert(Math.abs(Number(metadata.format.duration) - fixture.longDuration) < 0.1);
        const payloadSha256 = videoPayloadSha256(destination);
        assert.equal(payloadSha256, videoPayloadSha256(fixture.longPath)); decode(destination);
        outcomes.push({ name: 'long-duration-disk-stream', status: 'passed', sourceFrames: 2, outputFrames: Number(video.nb_read_frames),
          durationSeconds: Number(metadata.format.duration), videoPayloadSha256: payloadSha256,
          fixtureScope: 'Two low-frame-rate frames spanning four hours; verifies real media timestamps and frame preservation, not hours of continuous recording throughput.' });
      } finally {
        await page.evaluate(async id => (await window.__testOffscreen()).disposeLocal(id), id);
        await unlink(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      await assertRemoved(page, id);
    });
    // Reset before publishing a successful report; cleanup also retries in finally.
    await session.send('Storage.overrideQuotaForOrigin', { origin });
    const quotaAfter = await page.evaluate(() => navigator.storage.estimate());
    const quotaProtocolAfter = await session.send('Storage.getUsageAndQuota', { origin });
    assert.equal(quotaProtocolAfter.overrideActive, false);
    const report = { buildSha256: fixture.buildSha256, browser: page.context().browser()?.version(), status: 'passed',
      storageQuotaFixture: {
        scope: 'Disposable regular disk-backed Chromium profile and localhost test origin only. This HTTP harness lacks the extension manifest existing unlimitedStorage exemption; no product permission, OS setting or user profile is changed. Actual installed-extension permission behavior remains unverified.',
        method: 'CDP Storage.overrideQuotaForOrigin', requestedQuotaBytes: quotaBytes,
        estimateBefore: quotaBefore, estimateDuring: quotaDuring, estimateAfterRestore: quotaAfter, overrideRestored: true,
        protocolBefore: quotaProtocolBefore, protocolDuring: quotaProtocolDuring, protocolAfterRestore: quotaProtocolAfter,
        estimateScope: 'navigator.storage.estimate may report a privacy-rounded quota; CDP values above verify the actual isolated override and its removal.',
      },
      mode: 'Protected production offscreen; real Chromium fetch, OPFS and browser disk download. Chrome extension APIs doubled; no installed-extension integration claim.',
      memoryScope: 'Page-scope Blob.arrayBuffer calls are guarded at8MiB in both successful large scenarios; workers use the production disk filesystem and are not instrumented by this page guard. Server/host hashing uses bounded chunks. This is not a complete browser heap/RSS measurement.',
      fixtureScope: 'Owned one-second H264/AAC MP4 with a2GiB free box and relocated chunk offsets; a separate two-frame H264 source spans14402seconds. Virtual giant HTTP bytes and resulting large files are not retained in the repository.', outcomes };
    await writeFile('reports/large-download.json', JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally {
    // Idempotent reset covers failures in any case and precedes profile disposal.
    await session.send('Storage.overrideQuotaForOrigin', { origin }).catch(() => {});
    await session.detach().catch(() => {});
  }
}
