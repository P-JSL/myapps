import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { browserEntries, staticFiles, directoryCopies, capabilities } from './project.mjs';
import { files, hash, treeIdentity } from './lib/artifacts.mjs';
import { protectBuild } from './lib/protect-build.mjs';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
const common = { bundle: true, platform: 'browser', target: 'chrome120', logLevel: 'warning', minify: false, legalComments: 'eof', metafile: true };
const entries = [];
for (const entry of browserEntries) {
  const result = await build({ ...common, entryPoints: [entry.input], format: entry.format, external: entry.external ?? [], outfile: `dist/${entry.output}` });
  entries.push({ ...entry, inputs: Object.keys(result.metafile.inputs).sort(), bytes: (await stat(`dist/${entry.output}`)).size });
}
for (const asset of [...staticFiles, ...directoryCopies]) {
  const destination = path.join('dist', asset.output);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(asset.input, destination, { recursive: true });
}
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const { assetMap, protection } = await protectBuild('dist', { version: pkg.version, formats: Object.fromEntries(browserEntries.map(entry => [entry.output, entry.format])) });
for (const entry of entries) { entry.logicalOutput = entry.output; entry.output = assetMap[entry.output]; entry.bytes = (await stat(`dist/${entry.output}`)).size; }
const names = await files('dist');
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
assert.equal(manifest.name, 'My Video App');
assert.equal(manifest.version, pkg.version, 'Package and extension releases must match');
assert.equal(manifest.background.service_worker, assetMap['local/background.js']);
assert(!('key' in manifest) && !('update_url' in manifest));
assert(names.every(name => !['service/', 'injected/', '_locales/', 'download_worker/'].some(prefix => name.startsWith(prefix))));
for (const name of names.filter(n => /\.(js|mjs|html|json)$/.test(n))) {
  const text = await readFile(`dist/${name}`, 'utf8');
  assert(!/--origin-to-force-quic-on|--ignore-certificate-errors/.test(text), `Test-only transport/TLS flag shipped: ${name}`);
  assert(!/downloadhelper\.net|\/entitlements\/|on_activate_addon/.test(text), `Account/activation code unexpectedly shipped: ${name}`);
}
const buildSha256 = await treeIdentity('dist', names);
const wasm = await readFile('node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm');
const core = JSON.parse(await readFile('node_modules/@ffmpeg/core/package.json', 'utf8'));
assert.equal(core.version, pkg.devDependencies['@ffmpeg/core'], 'Use the pinned FFmpeg core');
await writeFile('reports/build.json', JSON.stringify({
  engine: 'independent-local', productName: manifest.name, version: manifest.version, buildSha256,
  originalRuntimeIncluded: false, accountActivationIncluded: false, capabilities,
  assetMap, protection, entries, appJavaScriptBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  ffmpeg: { package: '@ffmpeg/core', version: core.version, wasmSha256: hash(wasm), bytes: wasm.length },
  distFiles: names.length,
  distBytes: (await Promise.all(names.map(name => stat(`dist/${name}`).then(s => s.size)))).reduce((a, b) => a + b, 0),
}, null, 2) + '\n');
console.log(`Local build complete: ${names.length} files; ${entries.length} runtime entries; no test-only completion bundle.`);
