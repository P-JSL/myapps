import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditSource } from '../scripts/audit-source.mjs';
import { files, hash, sourceIdentity, treeIdentity } from '../scripts/lib/artifacts.mjs';

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'my-video-tooling-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function put(root, name, content) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), content);
}

async function sourceFixture(t) {
  const root = await temporary(t);
  for (const name of ['src', 'native', 'scripts', 'tests']) await mkdir(path.join(root, name));
  await put(root, 'package.json', '{"name":"audit-fixture","version":"1.2.3"}\n');
  await put(root, 'package-lock.json', '{"lockfileVersion":3}\n');
  await put(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { noUnusedLocals: true, noUnusedParameters: true }, include: ['src/**/*.ts'] }));
  await put(root, 'src/main.ts', `import { value, type Name } from './shared.ts';
import type { OnlyType } from './types.ts';
export type { Name } from './shared.ts';
export { type OnlyType } from './types.ts';
console.log(value);
chrome.runtime.getURL('index.html' + (true ? '?view=history' : ''));
new Worker(chrome.runtime.getURL('worker.js'), { type: 'module' });
throw new Error('Browser source must never execute during an audit');
`);
  await put(root, 'src/shared.ts', 'export type Name = string; export const value = 1;\n');
  await put(root, 'src/types.ts', "import type { Name } from './shared.ts'; export interface OnlyType { name: Name; }\n");
  await put(root, 'src/ambient.ts', 'declare const ambientValue: number; export interface Ambient { value: number; }\n');
  await put(root, 'src/vendor.d.ts', "declare module '*ffmpeg-core.js';\n");
  await put(root, 'src/worker.ts', 'export const worker = true;\n');
  await put(root, 'src/index.html', '<!doctype html><script type="module" src="main.js"></script>');
  await put(root, 'src/manifest.json', JSON.stringify({ background: { service_worker: 'main.js' }, action: { default_popup: 'index.html' }, content_scripts: [{ js: ['worker.js'] }] }));
  const catalog = {
    browserEntries: [{ input: 'src/main.ts', output: 'main.js', format: 'esm' }, { input: 'src/worker.ts', output: 'worker.js', format: 'esm' }],
    staticFiles: [{ input: 'src/index.html', output: 'index.html' }, { input: 'src/manifest.json', output: 'manifest.json' }],
    directoryCopies: [],
  };
  return { root, catalog };
}

test('tree hashes preserve the original sorted name-NUL-content SHA format', async t => {
  const root = await temporary(t);
  await put(root, 'nested/z.bin', Buffer.from([0, 1, 255]));
  await put(root, 'a.txt', 'alpha\n');
  const names = await files(root);
  assert.deepEqual(names, ['a.txt', 'nested/z.bin']);
  assert.equal(hash('alpha\n'), 'b6a98d9ce9a2d9149288fa3df42d377c3e42737afdcdaf714e33c0a100b51060');
  const golden = 'bddf832b927e51978e5e52ca7cef90f50359913ca0ed99f8fd9dbaa02eca13d5';
  assert.equal(await treeIdentity(root), golden);
  // The optional list is the trusted, sorted result of files(), as used by build.
  assert.equal(await treeIdentity(root, names), golden);
});

test('tree hashes detect changed bytes, added files, renamed files and deletions', async t => {
  const root = await temporary(t);
  await put(root, 'a.txt', 'original');
  const original = await treeIdentity(root);
  await put(root, 'a.txt', 'changed');
  const changed = await treeIdentity(root);
  assert.notEqual(changed, original);
  await put(root, 'b.txt', 'second');
  const added = await treeIdentity(root);
  assert.notEqual(added, changed);
  await rename(path.join(root, 'b.txt'), path.join(root, 'c.txt'));
  const renamed = await treeIdentity(root);
  assert.notEqual(renamed, added);
  await rm(path.join(root, 'c.txt'));
  assert.equal(await treeIdentity(root), changed);
});

test('default inventories reject root, nested file and nested directory symlinks', async t => {
  const root = await temporary(t);
  await put(root, 'real/a.txt', 'a');
  await symlink(path.join(root, 'real'), path.join(root, 'root-link'), 'dir');
  await assert.rejects(files(path.join(root, 'root-link')), /real directory/);
  await assert.rejects(treeIdentity(path.join(root, 'root-link')), /real directory/);
  await rm(path.join(root, 'root-link'));
  await symlink(path.join(root, 'real/a.txt'), path.join(root, 'file-link'));
  await assert.rejects(files(root), /symlink/);
  await assert.rejects(treeIdentity(root), /symlink/);
  await rm(path.join(root, 'file-link'));
  await symlink(path.join(root, 'real'), path.join(root, 'directory-link'), 'dir');
  await assert.rejects(files(root), /symlink/);
});

test('cache exclusion is explicit and applies at every depth', async t => {
  const root = await temporary(t);
  await put(root, 'a.py', 'source');
  await put(root, '__pycache__/a.pyc', 'cached');
  await put(root, 'nested/__pycache__/b.pyc', 'cached');
  assert.deepEqual(await files(root), ['__pycache__/a.pyc', 'a.py', 'nested/__pycache__/b.pyc']);
  assert.deepEqual(await files(root, { skipDirectories: ['__pycache__'] }), ['a.py']);
});

test('source snapshots track new tooling, tsconfig and baseline files without caches', async t => {
  const { root } = await sourceFixture(t);
  await put(root, 'native/bridge.py', 'print("native")\n');
  await put(root, 'scripts/nested/new-tool.mjs', 'export const tool = true;\n');
  await put(root, 'tests/baselines/compatibility.txt', 'golden\n');
  await put(root, 'scripts/__pycache__/ignored.py', 'cached\n');
  await put(root, 'native/__pycache__/ignored.py', 'cached\n');
  const before = await sourceIdentity(root);
  assert.equal(before['scripts/nested/new-tool.mjs'], hash('export const tool = true;\n'));
  assert.equal(before['native/bridge.py'], hash('print("native")\n'));
  assert.equal(before['tests/baselines/compatibility.txt'], hash('golden\n'));
  assert.equal(before['package.json'], hash('{"name":"audit-fixture","version":"1.2.3"}\n'));
  assert(Object.hasOwn(before, 'package-lock.json'));
  assert(!Object.keys(before).some(name => name.includes('__pycache__') || name.endsWith('.html')));
  await put(root, 'tsconfig.json', '{"compilerOptions":{"noUnusedLocals":true,"noUnusedParameters":true},"include":["src/*.ts"]}\n');
  const after = await sourceIdentity(root);
  assert.notEqual(after['tsconfig.json'], before['tsconfig.json']);
  assert.equal(after['scripts/nested/new-tool.mjs'], before['scripts/nested/new-tool.mjs']);
});

test('source audit follows runtime imports without executing browser modules', async t => {
  const { root, catalog } = await sourceFixture(t);
  const report = await auditSource(root, catalog);
  assert.equal(report.status, 'passed');
  assert.equal(report.release, '1.2.3');
  assert.equal(report.moduleCount, 3);
  assert.equal(report.entryCount, 2);
  assert.deepEqual(report.edges, [{ from: 'src/main.ts', to: 'src/shared.ts' }]);
  assert.deepEqual(report.orphanModules, []);
  assert.deepEqual(report.runtimeCycles, []);
  assert.deepEqual(report.sourceSha256, await sourceIdentity(root));
});

test('source audit rejects orphan runtime modules but accepts type-only modules', async t => {
  const { root, catalog } = await sourceFixture(t);
  await put(root, 'src/unused.ts', 'export interface Unused { name: string; }\n');
  await auditSource(root, catalog);
  await put(root, 'src/unused.ts', 'export const unused = 1;\n');
  await assert.rejects(auditSource(root, catalog), /Orphan runtime modules: src\/unused.ts/);
});

test('source audit rejects runtime cycles and excludes explicit type-only backreferences', async t => {
  const { root, catalog } = await sourceFixture(t);
  await put(root, 'src/shared.ts', "import type { OnlyType } from './types.ts'; export type Name = string; export const value = 1;\n");
  await auditSource(root, catalog);
  await put(root, 'src/shared.ts', "import './main.ts'; export type Name = string; export const value = 1;\n");
  await assert.rejects(auditSource(root, catalog), /Runtime import cycles: src\/main.ts -> src\/shared.ts/);
  await put(root, 'src/shared.ts', "import './shared.ts'; export type Name = string; export const value = 1;\n");
  await assert.rejects(auditSource(root, catalog), /Runtime import cycles: src\/shared.ts/);
});

test('empty named imports still retain runtime side effects', async t => {
  const { root, catalog } = await sourceFixture(t);
  await put(root, 'src/shared.ts', "import {} from './main.ts'; export type Name = string; export const value = 1;\n");
  await assert.rejects(auditSource(root, catalog), /Runtime import cycles/);
});

test('source audit checks both noUnused compiler guards', async t => {
  const { root, catalog } = await sourceFixture(t);
  for (const disabled of ['noUnusedLocals', 'noUnusedParameters']) {
    await put(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { noUnusedLocals: true, noUnusedParameters: true, [disabled]: false }, include: ['src/**/*.ts'] }));
    await assert.rejects(auditSource(root, catalog), new RegExp(`${disabled} must be true`));
  }
});

test('source audit catches missing manifest, HTML script, Worker and runtime getURL paths', async t => {
  const { root, catalog } = await sourceFixture(t);
  await put(root, 'src/index.html', '<script src="missing.js"></script>');
  await assert.rejects(auditSource(root, catalog), /Runtime resource missing.*missing\.js/);
  await put(root, 'src/index.html', '<script src="main.js"></script>');
  await put(root, 'src/manifest.json', '{"background":{"service_worker":"missing.js"}}');
  await assert.rejects(auditSource(root, catalog), /Runtime resource missing.*missing\.js/);
  await put(root, 'src/manifest.json', '{}');
  await put(root, 'src/shared.ts', "export type Name = string; export const value = 1; chrome.runtime.getURL('missing.html');\n");
  await assert.rejects(auditSource(root, catalog), /Runtime resource missing.*missing\.html/);
  await put(root, 'src/shared.ts', "export type Name = string; export const value = 1; new Worker(chrome.runtime.getURL('index.html'));\n");
  await assert.rejects(auditSource(root, catalog), /Worker is not a browser entry/);
});

test('HTML script paths resolve relative to their catalog output directory', async t => {
  const { root, catalog } = await sourceFixture(t);
  catalog.staticFiles[0].output = 'pages/index.html';
  await put(root, 'src/index.html', '<script src="../main.js?cache=1"></script>');
  await put(root, 'src/manifest.json', '{}');
  await put(root, 'src/main.ts', "import { value } from './shared.ts'; console.log(value); new Worker(chrome.runtime.getURL('worker.js'));\n");
  await auditSource(root, catalog);
});

test('copied directory resources must name a real inventoried file', async t => {
  const { root, catalog } = await sourceFixture(t);
  catalog.directoryCopies.push({ input: 'assets/icons', output: 'icons' });
  await put(root, 'assets/icons/actual.png', 'png');
  await put(root, 'src/shared.ts', "export type Name = string; export const value = 1; chrome.runtime.getURL('icons/actual.png');\n");
  await auditSource(root, catalog);
  await rm(path.join(root, 'assets/icons/actual.png'));
  await assert.rejects(auditSource(root, catalog), /Runtime resource missing.*icons\/actual\.png/);
});

test('relative FFmpeg externals must be allowed for every owning browser entry', async t => {
  const { root, catalog } = await sourceFixture(t);
  catalog.browserEntries[0].output = 'local/main.js';
  catalog.browserEntries[1].output = 'local/worker.js';
  catalog.staticFiles.push({ input: 'vendor/core.js', output: 'vendor/ffmpeg/ffmpeg-core.js' });
  await put(root, 'vendor/core.js', 'export default function core() {}\n');
  await put(root, 'src/index.html', '<script src="local/main.js"></script>');
  await put(root, 'src/manifest.json', '{}');
  await put(root, 'src/main.ts', "import { value } from './shared.ts'; console.log(value);\n");
  await put(root, 'src/worker.ts', "import { value } from './shared.ts'; console.log(value);\n");
  await put(root, 'src/shared.ts', "import core from '../vendor/ffmpeg/ffmpeg-core.js'; export const value = core;\n");
  const external = '../vendor/ffmpeg/ffmpeg-core.js';
  catalog.browserEntries[0].external = [external];
  await assert.rejects(auditSource(root, catalog), /Uncatalogued runtime import for src\/worker\.ts/);
  catalog.browserEntries[1].external = [external];
  await auditSource(root, catalog);
});

test('source audit rejects dynamic imports and unresolved resource expressions', async t => {
  const { root, catalog } = await sourceFixture(t);
  await put(root, 'src/shared.ts', "export type Name = string; export const value = 1; void import(location.hash);\n");
  await assert.rejects(auditSource(root, catalog), /Non-static runtime import/);
  await put(root, 'src/shared.ts', "export type Name = string; export const value = 1; chrome.runtime.getURL(location.hash);\n");
  await assert.rejects(auditSource(root, catalog), /Non-static runtime resource/);
});
