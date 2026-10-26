import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { hash, sourceIdentity, treeIdentity } from './lib/artifacts.mjs';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const json = async name => JSON.parse(await readFile(name, 'utf8'));
const version = (await json('package.json')).version;
const report = await json('reports/release-validation.json');
assert.equal(report.release, version, 'Validation belongs to another release');
assert.equal(report.status, 'passed', 'Successful focused validation required');
assert.equal(report.validationMode, 'focused-architecture-change');
assert.equal(report.userRequestedSkipPreviousChecks, true, 'Focused validation must record the requested scope');
assert.deepEqual(await sourceIdentity(), report.sourceSha256, 'Source inventory or contents changed since focused validation');
for (const name of ['extension', 'engine', 'gui', 'bundle', 'launcher']) {
  assert(Number.isInteger(report.checks?.[name]) && report.checks[name] > 0, `Successful focused ${name} checks required`);
}
for (const name of ['typecheck', 'build']) assert.equal(report.checks?.[name], 'passed', `Successful ${name} required`);
assert(Object.keys(report.logSha256 ?? {}).length > 0, 'Validation log hashes required');
for (const [name, digest] of Object.entries(report.logSha256)) {
  assert(name.startsWith('reports/') && !name.split('/').includes('..') && !name.includes('\\'), 'Validation logs must be local report paths');
  assert.equal(hash(await readFile(name)), digest, `Validation log changed: ${name}`);
}
const identity = await treeIdentity('dist');
assert.equal(report.buildSha256, identity, 'Build changed since focused validation');
assert.equal((await json('reports/build.json')).buildSha256, identity, 'Build inventory is stale');
assert.equal((await json('dist/manifest.json')).version, version, 'Extension build version is stale');
const desktop = await json('reports/desktop-build.json');
assert.equal(desktop.version, version, 'Desktop report version is stale');
assert.equal(desktop.artifact, 'artifacts/my-video-app-desktop-windows-x64.zip');
assert.equal(hash(await readFile(desktop.artifact)), desktop.sha256, 'Desktop artifact changed since validation');
assert.equal(report.desktop?.sha256, desktop.sha256, 'Focused validation belongs to another desktop bundle');
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
// Check every packaged output and every current source named by the app manifest.
const desktopCheck = spawnSync(python, ['-B', '-c', `
import hashlib, json
from pathlib import Path, PurePosixPath
from zipfile import ZipFile
root=Path.cwd()
with ZipFile(root/'artifacts/my-video-app-desktop-windows-x64.zip') as bundle:
    names=bundle.namelist()
    assert len(names)==len(set(names)), 'Duplicate desktop members'
    manifest=json.loads(bundle.read('MyVideoApp/APPMANIFEST.json'))
    assert manifest['version']==json.loads((root/'package.json').read_text())['version'], 'Desktop manifest version mismatch'
    assert set(names)=={'MyVideoApp/'+name for name in manifest['files']}|{'MyVideoApp/APPMANIFEST.json'}, 'Desktop output inventory mismatch'
    for name, digest in manifest['files'].items():
        assert hashlib.sha256(bundle.read('MyVideoApp/'+name)).hexdigest()==digest, 'Desktop output changed: '+name
    assert manifest['sourceFiles'], 'Desktop source inventory required'
    for name, digest in manifest['sourceFiles'].items():
        path=PurePosixPath(name)
        assert not path.is_absolute() and '..' not in path.parts and '\\\\' not in name, 'Unsafe desktop source path'
        assert hashlib.sha256((root/name).read_bytes()).hexdigest()==digest, 'Desktop source changed: '+name
`], { encoding: 'utf8' });
assert.equal(desktopCheck.status, 0, desktopCheck.stderr || desktopCheck.error?.message);
const result = spawnSync(python, ['-B', fileURLToPath(new URL('./archive.py', import.meta.url))], { encoding: 'utf8' });
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
