import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { browserEntries, vendorEntries, staticFiles, directoryCopies, capabilities } from './project.mjs';
import { files, hash, treeIdentity } from './lib/artifacts.mjs';
import { protectBuild } from './lib/protect-build.mjs';
import { assertNoTestMarker } from './lib/release-safety.mjs';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
const common = { bundle: true, platform: 'browser', target: 'chrome120', logLevel: 'warning', minify: true, charset: 'utf8', legalComments: 'eof', metafile: true };
const entries = [];
const sharedChunks = [];
const vendorModules = [];
const esmEntries = browserEntries.filter(entry => entry.format === 'esm');
const esm = await build({
  ...common, entryPoints: Object.fromEntries(esmEntries.map(entry => [entry.output.replace(/\.js$/, ''), entry.input])),
  format: 'esm', splitting: true, chunkNames: 'shared/[hash]', outdir: 'dist',
  external: [...new Set(esmEntries.flatMap(entry => entry.external ?? []))],
});
const logicalOutput = name => path.posix.relative('dist', name.replaceAll('\\', '/'));
const outputs = new Map(Object.entries(esm.metafile.outputs));
const importsOf = (name, metadata) => metadata.imports.map(item => ({
  path: item.external ? path.posix.normalize(path.posix.join(path.posix.dirname(logicalOutput(name)), item.path)) : logicalOutput(item.path),
  kind: item.kind, external: item.external === true,
}));
function transitiveInputs(name, seen = new Set(), inputs = new Set()) {
  if (seen.has(name)) return inputs;
  seen.add(name);
  const metadata = outputs.get(name);
  assert(metadata, `Missing generated module metadata: ${name}`);
  for (const input of Object.keys(metadata.inputs)) inputs.add(input);
  for (const item of metadata.imports) if (!item.external) transitiveInputs(item.path, seen, inputs);
  return inputs;
}
for (const entry of esmEntries) {
  const name = `dist/${entry.output}`, metadata = outputs.get(name);
  assert(metadata?.entryPoint === entry.input, `Missing ESM entry ${entry.input}`);
  entries.push({ ...entry, inputs: [...transitiveInputs(name)].sort(), imports: importsOf(name, metadata) });
}
for (const [name, metadata] of outputs) {
  if (metadata.entryPoint) continue;
  const output = logicalOutput(name);
  assert.match(output, /^shared\/[A-Z0-9]{8}\.js$/, 'Only esbuild-generated local shared modules are allowed');
  sharedChunks.push({ output, inputs: Object.keys(metadata.inputs).sort(), imports: importsOf(name, metadata), exports: metadata.exports });
}
for (const entry of browserEntries.filter(entry => entry.format !== 'esm')) {
  assert.equal(entry.format, 'iife', `Unsupported runtime format: ${entry.format}`);
  const result = await build({ ...common, entryPoints: [entry.input], format: entry.format, external: entry.external ?? [], outfile: `dist/${entry.output}` });
  assert.equal(result.metafile.outputs[`dist/${entry.output}`].imports.length, 0, 'The content script must stay self-contained');
  entries.push({ ...entry, inputs: Object.keys(result.metafile.inputs).sort(), imports: [] });
}
entries.sort((a, b) => browserEntries.findIndex(entry => entry.input === a.input) - browserEntries.findIndex(entry => entry.input === b.input));
for (const entry of vendorEntries) {
  const result = await build({ ...common, entryPoints: [entry.input], format: entry.format, outfile: `dist/${entry.output}` });
  assert.equal(result.metafile.outputs[`dist/${entry.output}`].imports.length, 0, 'Pinned vendor wrappers must stay self-contained');
  vendorModules.push({ ...entry, inputs: Object.keys(result.metafile.inputs).sort(), imports: [] });
}
for (const asset of [...staticFiles, ...directoryCopies]) {
  const destination = path.join('dist', asset.output);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(asset.input, destination, { recursive: true });
}
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const { assetMap, protection } = await protectBuild('dist', {
  version: pkg.version, formats: Object.fromEntries(browserEntries.map(entry => [entry.output, entry.format])),
  sharedModules: sharedChunks.map(chunk => ({ logicalOutput: chunk.output, exports: chunk.exports })),
});
for (const entry of [...entries, ...sharedChunks, ...vendorModules]) {
  entry.logicalOutput = entry.output; entry.output = assetMap[entry.output]; entry.bytes = (await stat(`dist/${entry.output}`)).size;
  entry.imports = entry.imports.map(item => {
    assert(assetMap[item.path], `Uncatalogued runtime module import ${item.path}`);
    return { ...item, logicalPath: item.path, path: assetMap[item.path] };
  });
}
const names = await files('dist');
for (const name of names) assertNoTestMarker(await readFile(`dist/${name}`), name);
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
  assetMap, protection, entries, sharedChunks, vendorModules, appJavaScriptBytes: [...entries, ...sharedChunks].reduce((sum, entry) => sum + entry.bytes, 0),
  ffmpeg: { package: '@ffmpeg/core', version: core.version, wasmSha256: hash(wasm), bytes: wasm.length },
  distFiles: names.length,
  distBytes: (await Promise.all(names.map(name => stat(`dist/${name}`).then(s => s.size)))).reduce((a, b) => a + b, 0),
}, null, 2) + '\n');
console.log(`Local build complete: ${names.length} files; ${entries.length} runtime entries; ${sharedChunks.length} shared modules; no test-only completion bundle.`);
