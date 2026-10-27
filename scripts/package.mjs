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
const concurrencyMode = report.validationMode === 'focused-desktop-concurrency';
const transportMode = report.validationMode === 'focused-desktop-transport';
const recoveryMode = report.validationMode === 'focused-download-recovery';
const activityMode = report.validationMode === 'focused-desktop-activity';
const noHttp3Mode = report.validationMode === 'focused-desktop-no-http3';
if (noHttp3Mode) {
  assert.equal(version, '1.19.3');
  assert.equal(report.baseline, 'v1.19.2');
  assert.equal(report.baselineCommit, 'dd3187fcfab45cad89fb95ad1cb24c3edd2c6365');
  assert.equal(report.priorChecks, 'skipped-per-user');
  assert.equal(report.liveYouTubeVerified, false);
} else if (activityMode) {
  assert.equal(version, '1.19.2');
  assert.equal(report.baseline, 'v1.19.1');
  assert.equal(report.baselineCommit, 'c9d79dc393b76554d2b2144a52ae5085f11e0f54');
  assert.equal(report.priorChecks, 'skipped-per-user');
  assert.equal(report.liveYouTubeVerified, false);
} else if (recoveryMode) {
  assert.equal(version, '1.19.1');
  assert.equal(report.baseline, 'v1.19.0');
  assert.equal(report.baselineCommit, 'b09935f7d1ce9fe6f4003bce4d8a87d8e09d826a');
  assert.equal(report.priorChecks, 'skipped-per-user');
  assert.equal(report.liveYouTubeVerified, false);
} else if (transportMode) {
  assert.equal(version, '1.19.0', 'Desktop transport scope belongs to release 1.19.0');
  assert.equal(report.baseline, 'v1.18.0', 'Desktop transport baseline is fixed');
  assert.equal(report.baselineCommit, '1756c8dec1cb6e655fd486ab4a55fcc35641fd74', 'Desktop transport baseline commit is fixed');
  assert.equal(report.priorChecks, 'skipped-per-user', 'Previous checks must be recorded as skipped');
  assert.equal(report.liveYouTubeVerified, false, 'Focused transport checks do not establish live YouTube behavior');
  assert.equal(report.publicWANBenchmarked, false, 'Controlled loopback throughput does not establish public WAN performance');
} else if (concurrencyMode) {
  assert.equal(version, '1.18.0', 'Desktop concurrency scope belongs to release 1.18.0');
  assert.equal(report.baseline, 'v1.17.0', 'Desktop concurrency baseline is fixed');
  assert.equal(report.baselineCommit, '252b452da32f16dc81cb36cca94231879d43c5f1', 'Desktop concurrency baseline commit is fixed');
  assert.equal(report.priorChecks, 'skipped-per-user', 'Previous checks must be recorded as skipped');
  assert.equal(report.liveYouTubeVerified, false, 'Focused concurrency checks do not establish live YouTube behavior');
} else {
  assert.equal(version, '1.17.0', 'Architecture validation belongs to release 1.17.0');
  assert.equal(report.validationMode, 'focused-architecture-change');
}
if (noHttp3Mode || activityMode || recoveryMode || transportMode || concurrencyMode) {
  // Read-only source comparisons preserve the requested desktop-only scope.
  const extensionScope = spawnSync('git', ['diff', '--name-only', report.baselineCommit, '--', 'src', 'native', 'tsconfig.json', ':(exclude)src/local/manifest.json'], { encoding: 'utf8' });
  assert.equal(extensionScope.status, 0, extensionScope.stderr || extensionScope.error?.message);
  assert.equal(extensionScope.stdout.trim(), '', 'Focused desktop scope requires unchanged extension sources');
  const baselineManifest = spawnSync('git', ['show', `${report.baselineCommit}:src/local/manifest.json`], { encoding: 'utf8' });
  assert.equal(baselineManifest.status, 0, baselineManifest.stderr || baselineManifest.error?.message);
  const beforeManifest = JSON.parse(baselineManifest.stdout), currentManifest = await json('src/local/manifest.json');
  assert.equal(currentManifest.version, version, 'Extension source version metadata is stale');
  assert.equal(currentManifest.version_name, beforeManifest.version_name.replace(beforeManifest.version, version), 'Only the extension version label may change');
  for (const key of ['version', 'version_name']) { delete beforeManifest[key]; delete currentManifest[key]; }
  assert.deepEqual(currentManifest, beforeManifest, 'Only extension version metadata may change in the focused desktop scope');
}
assert.equal(report.userRequestedSkipPreviousChecks, true, 'Focused validation must record the requested scope');
assert.deepEqual(await sourceIdentity(), report.sourceSha256, 'Source inventory or contents changed since focused validation');
for (const name of noHttp3Mode ? ['noHttp3', 'noHttp3Gui', 'releaseScope'] : activityMode ? ['activity', 'activityGui', 'releaseScope'] : recoveryMode ? ['recovery', 'releaseScope'] : transportMode ? ['bandwidth', 'transfer', 'transport', 'engineTransport', 'releaseScope'] : concurrencyMode ? ['concurrency', 'concurrencyGui', 'releaseScope'] : ['extension', 'engine', 'gui', 'bundle', 'launcher']) {
  assert(Number.isInteger(report.checks?.[name]) && report.checks[name] > 0, `Successful focused ${name} checks required`);
}
for (const name of (noHttp3Mode || activityMode || recoveryMode || transportMode || concurrencyMode) ? ['build'] : ['typecheck', 'build']) assert.equal(report.checks?.[name], 'passed', `Successful ${name} required`);
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
    assert manifest['version']==json.loads((root/'package.json').read_text(encoding='utf-8'))['version'], 'Desktop manifest version mismatch'
    assert set(names)=={'MyVideoApp/'+name for name in manifest['files']}|{'MyVideoApp/APPMANIFEST.json'}, 'Desktop output inventory mismatch'
    for name, digest in manifest['files'].items():
        assert hashlib.sha256(bundle.read('MyVideoApp/'+name)).hexdigest()==digest, 'Desktop output changed: '+name
    assert manifest['sourceFiles'], 'Desktop source inventory required'
    if manifest['version'] in ('1.19.0', '1.19.3'):
        for required in ('desktop/bandwidth.py', 'desktop/transfer.py', 'desktop/transport.py', 'runtime/python/Lib/site-packages/curl_cffi/__init__.py'):
            assert 'MyVideoApp/'+required in names, 'Desktop transport runtime missing: '+required
    if manifest['version'] in ('1.19.2', '1.19.3'):
        required='desktop/activity.py'
        assert 'MyVideoApp/'+required in names, 'Desktop activity logging module missing'
        assert required in manifest['sourceFiles'], 'Desktop activity source identity missing'
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
