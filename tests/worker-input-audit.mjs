/** Real Chromium workers and the pinned FFmpeg core; no extension APIs needed. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const workerSource = `
import createFFmpegCore from '/vendor/ffmpeg/ffmpeg-core.js';
import { processingArguments, resultFormat } from '../src/upscale/processing.ts';

const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
function probe(core, filename, report) {
  core.reset(); core.setTimeout(15000);
  const result = core.ffprobe('-v', 'error', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe', '-show_error', '-show_streams', '-show_format', '-of', 'json', '-o', report, filename);
  if (result !== 0 && result !== -1) throw Error('Fixture probe failed: ' + result);
  const metadata = JSON.parse(core.FS.readFile(report, { encoding: 'utf8' }));
  core.FS.unlink(report);
  if (metadata.error || !metadata.streams?.length) throw Error('Fixture streams missing');
  return metadata;
}
self.onmessage = async ({ data }) => {
  try {
    const core = await createFFmpegCore(); core.setLogger(() => {});
    const routes = data.mode === 'image' ? ['image.png'] : data.mode === 'merge' ? ['clip.mp4', 'audio-only.m4a'] : ['clip.mp4'];
    const files = await Promise.all(routes.map(async route => new File([await (await fetch('/fixtures/' + route)).blob()], route)));
    const originalHashes = await Promise.all(files.map(async file => digest(await file.arrayBuffer())));
    const ownedAliases = [];
    const randomReads = [];
    for (let index = 0; index < files.length; index++) {
      const name = index ? 'audio.media' : 'input.media';
      const bytes = new Uint8Array(await files[index].arrayBuffer());
      core.FS.writeFile(name, bytes, data.method === 'owned' ? { canOwn: true } : undefined);
      ownedAliases.push(core.FS.lookupPath(name).node.contents.buffer === bytes.buffer);
      for (const position of [0, Math.floor(bytes.length / 2), Math.max(0, bytes.length - 31)]) {
        const stream = core.FS.open(name, 'r');
        const chunk = new Uint8Array(Math.min(31, bytes.length - position));
        core.FS.read(stream, chunk, 0, chunk.length, position); core.FS.close(stream);
        randomReads.push(chunk.every((byte, offset) => byte === bytes[position + offset]));
      }
    }
    const metadata = probe(core, 'input.media', 'input-probe.json');
    const video = metadata.streams.find(stream => stream.codec_type === 'video');
    const info = { width: video?.width ?? 0, height: video?.height ?? 0, duration: Number(metadata.format.duration ?? 0),
      video: !!video, audio: metadata.streams.some(stream => stream.codec_type === 'audio'), kind: data.mode === 'image' ? 'image' : 'video' };
    const options = data.mode === 'audio' ? { mode: 'audio', format: 'mp3' } : data.mode === 'merge' ? { mode: 'merge', format: 'mp4' } : { mode: 'upscale', factor: 2 };
    core.reset(); core.setTimeout(120000);
    const result = core.exec(...processingArguments(info, options));
    if (result !== 0) throw Error('Fixture processing failed: ' + result);
    const name = 'output.' + resultFormat(options, info.kind);
    const output = core.FS.readFile(name);
    const outputMetadata = probe(core, name, 'output-probe.json');
    const afterHashes = await Promise.all(files.map(async file => digest(await file.arrayBuffer())));
    self.postMessage({ method: data.method, mode: data.mode, ownedAliases, randomReads, metadata, outputMetadata,
      sourceUnchanged: originalHashes.every((hash, index) => hash === afterHashes[index]), bytes: output.byteLength, sha256: await digest(output) });
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
`;

export async function prepareOwnedInputAudit(fixtures) {
  await build({ stdin: { contents: workerSource, resolveDir: path.dirname(fileURLToPath(import.meta.url)), loader: 'js' },
    bundle: true, format: 'esm', external: ['/vendor/ffmpeg/ffmpeg-core.js'],
    outfile: path.join(fixtures, 'owned-input-audit-worker.js') });
}

export async function verifyOwnedInputProcessing(page, origin) {
  const cases = await page.evaluate(async origin => {
    const outcomes = [];
    for (const mode of ['upscale', 'audio', 'merge', 'image']) {
      for (const method of ['clone', 'owned']) {
        const worker = new Worker(origin + '/fixtures/owned-input-audit-worker.js', { type: 'module' });
        try {
          outcomes.push(await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(Error('Owned input worker timed out')), 45000);
            worker.onmessage = event => { clearTimeout(timeout); resolve(event.data); };
            worker.onerror = event => { clearTimeout(timeout); reject(Error(event.message)); };
            worker.postMessage({ mode, method });
          }));
        } finally { worker.terminate(); }
      }
    }
    return outcomes;
  }, origin);
  assert.equal(cases.length, 8);
  for (const mode of ['upscale', 'audio', 'merge', 'image']) {
    const baseline = cases.find(item => item.mode === mode && item.method === 'clone');
    const optimized = cases.find(item => item.mode === mode && item.method === 'owned');
    for (const result of [baseline, optimized]) {
      assert(result); assert.equal(result.error, undefined, result.error);
      assert(result.sourceUnchanged); assert(result.randomReads.every(Boolean)); assert(result.bytes > 0);
      assert(result.ownedAliases.every(aliased => aliased === (result.method === 'owned')));
    }
    assert.equal(optimized.bytes, baseline.bytes);
    assert.equal(optimized.sha256, baseline.sha256);
    assert.deepEqual(optimized.metadata, baseline.metadata);
    assert.deepEqual(optimized.outputMetadata, baseline.outputMetadata);
  }
  return cases;
}
