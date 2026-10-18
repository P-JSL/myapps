import { build } from 'esbuild';
import { cp, mkdir, readdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const hash = data => createHash('sha256').update(data).digest('hex');
async function files(dir, prefix = '') {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink());
    const name = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await files(path.join(dir, entry.name), name)); else result.push(name);
  }
  return result.sort();
}
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
const common = { bundle: true, platform: 'browser', target: 'chrome120', logLevel: 'warning', minify: false, legalComments: 'eof' };
for (const name of ['background', 'collect', 'offscreen', 'ui']) await build({ ...common, entryPoints: [`src/local/${name}.ts`], format: name === 'collect' ? 'iife' : 'esm', outfile: `dist/local/${name}.js` });
await build({ ...common, entryPoints: ['src/local/stream-worker.ts'], format: 'esm', external: ['../vendor/ffmpeg/ffmpeg-core.js'], outfile: 'dist/local/stream-worker.js' });
await build({ ...common, entryPoints: ['src/upscale/completion.ts'], format: 'esm', outfile: 'dist/hardening/service.js' });
await build({ ...common, entryPoints: ['src/upscale/worker.ts'], format: 'esm', external: ['../vendor/ffmpeg/ffmpeg-core.js'], outfile: 'dist/hardening/upscale-worker.js' });
await build({ ...common, entryPoints: ['src/ui/app.ts'], format: 'esm', outfile: 'dist/upscale/app.js' });
for (const name of ['index.html', 'offscreen.html', 'style.css']) await cp(`src/local/${name}`, `dist/local/${name}`);
for (const name of ['index.html', 'style.css']) await cp(`src/ui/${name}`, `dist/upscale/${name}`);
await cp('src/local/manifest.json', 'dist/manifest.json');
await cp('assets/bitmaps', 'dist/bitmaps', { recursive: true });
await mkdir('dist/vendor/ffmpeg', { recursive: true });
for (const name of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) await cp(`node_modules/@ffmpeg/core/dist/esm/${name}`, `dist/vendor/ffmpeg/${name}`);
await mkdir('dist/licenses', { recursive: true });
await cp('THIRD_PARTY_NOTICES.md', 'dist/licenses/THIRD_PARTY_NOTICES.md');
await cp('licenses/ffmpeg-GPL-2.0.txt', 'dist/licenses/ffmpeg-GPL-2.0.txt');
for (const name of ['LOCAL_MODE.ko.md', 'FEATURES.ko.md', 'DOWNLOADS_HTTP3.ko.md', 'SECURITY_DOWNLOADS.ko.md']) await cp(`reports/${name}`, `dist/${name}`);
const names = await files('dist');
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
assert.equal(manifest.name, 'My Video App');
assert.equal(manifest.background.service_worker, 'local/background.js');
assert(!('key' in manifest) && !('update_url' in manifest));
assert(names.every(name => !name.startsWith('service/') && !name.startsWith('injected/') && !name.startsWith('_locales/') && !name.startsWith('download_worker/')));
for (const name of names.filter(n => /\.(js|mjs|html|json)$/.test(n))) {
  const text = await readFile(`dist/${name}`, 'utf8');
  assert(!/--origin-to-force-quic-on|--ignore-certificate-errors/.test(text), `Test-only transport/TLS flag shipped: ${name}`);
  assert(!/downloadhelper\.net|\/entitlements\/|on_activate_addon/.test(text), `Account/activation code unexpectedly shipped: ${name}`);
}
const buildSha256 = hash((await Promise.all(names.map(async name => `${name}\0${hash(await readFile(`dist/${name}`))}`))).join('\n'));
const wasm = await readFile('dist/vendor/ffmpeg/ffmpeg-core.wasm');
await writeFile('reports/build.json', JSON.stringify({ engine: 'independent-local', productName: manifest.name, version: manifest.version, buildSha256, originalRuntimeIncluded: false, accountActivationIncluded: false, capabilities: ['http-media-detection', 'native-download', 'unencrypted-hls-vod', 'unencrypted-dash-vod', 'local-history', 'local-upscale', 'stream-quality-selection', 'audio-download', 'local-transcode', 'audio-extract', 'local-track-merge', 'browser-http3-negotiation', 'observed-transport', 'bounded-network-retries', 'queued-preparation', 'parallel-segments', 'local-antivirus-integration', 'browser-danger-review', 'explicit-security-decisions'], ffmpeg: { package: '@ffmpeg/core', version: '0.12.10', wasmSha256: hash(wasm), bytes: wasm.length }, distFiles: names.length, distBytes: (await Promise.all(names.map(name => stat(`dist/${name}`).then(s => s.size)))).reduce((a, b) => a + b, 0) }, null, 2) + '\n');
console.log(`Local build complete: ${names.length} files; no original account/activation engine included.`);
