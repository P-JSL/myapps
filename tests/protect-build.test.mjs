import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { assetReference, rewriteJavaScript, rewriteHTML, privateApplicationModule, protectBuild } from '../scripts/lib/protect-build.mjs';
import { assertProtectedBuild } from './build-paths.mjs';

const map = {
  'local/index.html': 'assets/111.html', 'upscale/index.html': 'assets/222.html',
  'local/style.css': 'assets/333.css', 'upscale/style.css': 'assets/444.css',
  'vendor/ffmpeg/ffmpeg-core.js': 'assets/555.js',
};

test('Asset references preserve context, root trust paths and URL suffixes', () => {
  assert.equal(assetReference('./style.css', 'local/index.html', map['local/index.html'], map), './333.css');
  assert.equal(assetReference('./style.css', 'upscale/index.html', map['upscale/index.html'], map), './444.css');
  assert.equal(assetReference('/local/index.html', 'local/background.js', 'assets/999.js', map), '/assets/111.html');
  assert.equal(assetReference('local/index.html?view=history#item', 'local/background.js', 'assets/999.js', map), 'assets/111.html?view=history#item');
  assert.equal(assetReference('https://example.test/local/index.html', 'local/background.js', 'assets/999.js', map), 'https://example.test/local/index.html');
  assert.equal(assetReference('../vendor/ffmpeg/ffmpeg-core.js', 'local/worker.js', 'assets/999.js', map), './555.js');
});

test('JavaScript rewrites complete literals and template paths without substring edits', async () => {
  const source = 'export const a="local/index.html?view=history"; export const b=`upscale/index.html${"?id=1"}`; export const c="prefix local/index.html"; export const r=/local\\/index.html/;';
  const output = rewriteJavaScript(source, 'local/background.js', 'assets/999.js', map);
  const result = await import('data:text/javascript,' + encodeURIComponent(output));
  assert.equal(result.a, 'assets/111.html?view=history');
  assert.equal(result.b, 'assets/222.html?id=1');
  assert.equal(result.c, 'prefix local/index.html');
  assert.equal(result.r.source, 'local\\/index.html');
});

test('HTML resource rewriting preserves policy text and relative destinations', () => {
  const source = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'"><link href="style.css"><a href="../local/index.html#history">Settings</a>';
  assert.equal(rewriteHTML(source, 'upscale/index.html', map['upscale/index.html'], map), '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'"><link href="./444.css"><a href="./111.html#history">Settings</a>');
});


test('application exports are private but registered event handlers retain behavior', async () => {
  const source = 'const secret = 41; function internal(value) { return secret + value; } globalThis.__privateEntryTest = internal; export { internal as inspect };';
  const result = privateApplicationModule(source);
  assert.equal(result.removedExports, 1);
  try {
    const namespace = await import('data:text/javascript,' + encodeURIComponent(result.source));
    assert.deepEqual(Object.keys(namespace), []);
    assert.equal(globalThis.__privateEntryTest(1), 42);
    const direct = privateApplicationModule('export function hidden() { return 1; }');
    assert.equal(direct.removedExports, 1);
    assert.deepEqual(Object.keys(await import('data:text/javascript,' + encodeURIComponent(direct.source))), []);
  } finally { delete globalThis.__privateEntryTest; }
});

test('unexpected application re-exports and default interfaces fail closed', () => {
  for (const source of ['export * from "./private.js";', 'export { hidden } from "./private.js";', 'export default 1;', 'export default function hidden() {}']) {
    assert.throws(() => privateApplicationModule(source), /Unexpected application/);
  }
});

test('identical PNG aliases share one file while contextual resources remain distinct', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'my-video-build-dedup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const image = await readFile(new URL('../assets/bitmaps/logo-128-color.png', import.meta.url));
  const differentImage = Buffer.concat([image, Buffer.from([1])]);
  const fixtures = {
    'manifest.json': JSON.stringify({ icons: { 128: 'bitmaps/one.png' }, action: { default_icon: { 128: 'bitmaps/two.png' } } }),
    'bitmaps/one.png': image,
    'bitmaps/two.png': image,
    'bitmaps/three.png': differentImage,
    'local/index.html': '<img src="../bitmaps/one.png"><img src="../bitmaps/two.png">',
    'local/style.css': 'body { color: red; }',
    'upscale/style.css': 'body { color: red; }',
    'local/one.js': 'globalThis.same = true;',
    'local/two.js': 'globalThis.same = true;',
    'vendor/ffmpeg/ffmpeg-core.js': 'export default options => options;',
    'vendor/ffmpeg/ffmpeg-core.wasm': Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
  };
  for (const [name, value] of Object.entries(fixtures)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), value);
  }
  const { assetMap: assets } = await protectBuild(root, { version: 'test' });
  assert.equal(assets['bitmaps/one.png'], assets['bitmaps/two.png']);
  assert.notEqual(assets['bitmaps/one.png'], assets['bitmaps/three.png']);
  assert.notEqual(assets['local/style.css'], assets['upscale/style.css']);
  assert.notEqual(assets['local/one.js'], assets['local/two.js']);
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.icons[128], manifest.action.default_icon[128]);
  assert.equal(manifest.icons[128], assets['bitmaps/one.png']);
  assert.deepEqual(await readFile(path.join(root, manifest.icons[128])), image);
  const html = await readFile(path.join(root, assets['local/index.html']), 'utf8');
  assert.equal(html, `<img src="./${path.posix.basename(manifest.icons[128])}"><img src="./${path.posix.basename(manifest.icons[128])}">`);
  assert.equal((await readdir(path.join(root, 'assets'))).filter(name => name.endsWith('.png')).length, 2);
});

test('shared ESM preserves UTF-8 behavior with private entries and a closed local module graph', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'my-video-split-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => { delete globalThis.__splitBuildResults; });
  const source = path.join(root, 'source'), dist = path.join(root, 'dist');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(source, 'shared.js'), 'export function label(value) { return "영상 다운로드 · " + value; }');
  const entryPoints = {};
  for (const [name, value] of [['one', '첫 번째'], ['two', '두 번째']]) {
    const input = path.join(source, name + '.js');
    await writeFile(input, `import { label } from './shared.js'; globalThis.__splitBuildResults.push(label(${JSON.stringify(value)})); export function inspect() { return label('내부'); }`);
    entryPoints['local/' + name] = input;
  }
  const options = { entryPoints, bundle: true, platform: 'browser', target: 'chrome120', minify: true, charset: 'utf8', format: 'esm', metafile: true };
  const baseline = path.join(root, 'baseline');
  await build({ ...options, outdir: baseline });
  globalThis.__splitBuildResults = [];
  for (const name of ['one', 'two']) await import(pathToFileURL(path.join(baseline, 'local', name + '.js')).href);
  const expected = [...globalThis.__splitBuildResults];
  assert.deepEqual(expected, ['영상 다운로드 · 첫 번째', '영상 다운로드 · 두 번째']);
  const result = await build({ ...options, splitting: true, chunkNames: 'shared/[hash]', outdir: dist });
  const logical = name => path.relative(dist, path.resolve(name)).replaceAll('\\', '/');
  const generated = Object.entries(result.metafile.outputs).map(([name, metadata]) => ({ logicalOutput: logical(name), metadata }));
  const declaredShared = generated.filter(item => !item.metadata.entryPoint).map(item => ({ logicalOutput: item.logicalOutput, exports: item.metadata.exports }));
  assert.equal(declaredShared.length, 1, 'The fixture must exercise real esbuild sharing');
  const html = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'"><script type="module" src="../local/one.js"></script>';
  const manifest = JSON.stringify({ content_security_policy: { extension_pages: "default-src 'self'" }, permissions: [], optional_permissions: [], host_permissions: [] });
  const fixtures = {
    'manifest.json': manifest, 'upscale/index.html': html,
    'vendor/ffmpeg/ffmpeg-core.js': 'export default options => options;',
    'vendor/ffmpeg/ffmpeg-core.wasm': Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
  };
  for (const [name, value] of Object.entries(fixtures)) {
    await mkdir(path.dirname(path.join(dist, name)), { recursive: true });
    await writeFile(path.join(dist, name), value);
  }
  await mkdir(path.join(root, 'src/local'), { recursive: true });
  await mkdir(path.join(root, 'src/ui'), { recursive: true });
  await writeFile(path.join(root, 'src/local/manifest.json'), manifest);
  await writeFile(path.join(root, 'src/ui/index.html'), html);
  const formats = { 'local/one.js': 'esm', 'local/two.js': 'esm' };
  const { assetMap, protection } = await protectBuild(dist, { version: 'test', formats, sharedModules: declaredShared });
  const records = generated.map(item => ({
    logicalOutput: item.logicalOutput, output: assetMap[item.logicalOutput],
    imports: item.metadata.imports.map(value => ({ path: assetMap[logical(value.path)], logicalPath: logical(value.path), kind: value.kind, external: value.external === true })),
    exports: item.metadata.exports,
  }));
  const sharedChunks = records.filter(item => item.logicalOutput.startsWith('shared/'));
  const entries = records.filter(item => !item.logicalOutput.startsWith('shared/'));
  const paths = { assetMap, buildInfo: { assetMap, protection, entries, sharedChunks }, resolve: name => assetMap[name] ?? name };
  await assertProtectedBuild(root, paths);
  globalThis.__splitBuildResults = [];
  for (const entry of entries) assert.deepEqual(Object.keys(await import(pathToFileURL(path.join(dist, entry.output)).href)), []);
  assert.deepEqual(globalThis.__splitBuildResults, expected);
  assert.equal(protection.charset, 'utf8');
  const sharedPath = path.join(dist, sharedChunks[0].output), originalShared = await readFile(sharedPath, 'utf8');
  assert(originalShared.includes('영상 다운로드'), 'Korean text must remain literal UTF-8');
  assert(!originalShared.includes('\\uC601'), 'Avoid expanding Korean UI text into ASCII escape sequences');
  for (const [addition, message] of [
    ['import "https://example.test/remote.js";', /Nonlocal production module import/],
    ['import "../escape.js";', /Missing or escaping production module import/],
    ['export const leaked = 1;', /Unexpected public production API/],
  ]) {
    await writeFile(sharedPath, originalShared + addition);
    await assert.rejects(assertProtectedBuild(root, paths), message);
  }
  await writeFile(sharedPath, originalShared);
  await assert.rejects(assertProtectedBuild(root, { ...paths, buildInfo: { ...paths.buildInfo, sharedChunks: [] } }), /Uncatalogued shared module/);
});
