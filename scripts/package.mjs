import { spawnSync } from 'node:child_process';
import { readFile, access, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
await access('dist/manifest.json');
const report = JSON.parse(await readFile('reports/browser.json', 'utf8'));
assert(report.outcomes.length >= 71 && report.outcomes.every(outcome => outcome.status === 'passed'), 'Successful current local-app feature/browser harness results required');
const http3 = JSON.parse(await readFile('reports/http3.json', 'utf8'));
assert(http3.transport === 'h3' && http3.outcomes.length >= 4 && http3.outcomes.every(outcome => outcome.status === 'passed'), 'Successful real HTTP/3 results required');
const antivirus = JSON.parse(await readFile('reports/antivirus.json', 'utf8'));
assert(antivirus.outcomes.length >= 6 && antivirus.outcomes.every(outcome => outcome.status === 'passed'), 'Successful real antivirus integration results required');
assert.equal(createHash('sha256').update(await readFile('native/antivirus_host.py')).digest('hex'), antivirus.sourceSha256, 'Native host changed since real antivirus validation');
const native = JSON.parse(await readFile('reports/native-tests.json', 'utf8'));
assert(native.status === 'passed' && native.count >= 48, 'Successful native unit results required');
for (const name of ['native/antivirus_host.py', 'native/windows_antivirus.py', 'native/install.py']) assert.equal(createHash('sha256').update(await readFile(name)).digest('hex'), native.sourceSha256[name], `Native source changed since verification: ${name}`);
assert.equal(JSON.parse(await readFile('reports/build.json', 'utf8')).engine, 'independent-local');
const performance = JSON.parse(await readFile('reports/performance.json', 'utf8'));
assert(performance.status === 'passed' && performance.outcomes.length === 5 && performance.outcomes.every(outcome => outcome.status === 'passed'), 'Successful current algorithm benchmarks required');
assert.deepEqual(performance.outcomes.map(outcome => outcome.name), ['state', 'media', 'transfer', 'ui', 'security'], 'All required algorithm scopes must be validated');
assert.equal(performance.release, JSON.parse(await readFile('package.json', 'utf8')).version, 'Algorithm report belongs to another release');
const algorithmSources = ['package.json', 'package-lock.json'];
for (const dir of ['src', 'native', 'scripts', 'tests']) algorithmSources.push(...(await files(dir)).filter(name => (/\.(?:ts|mjs|py)$/.test(name) || (dir === 'tests' && name.startsWith('baselines/') && name.endsWith('.txt'))) && !name.split('/').includes('__pycache__')).map(name => `${dir}/${name}`));
assert.deepEqual(Object.keys(performance.sourceSha256).sort(), algorithmSources.sort(), 'Algorithm source inventory changed since validation');
for (const [name, digest] of Object.entries(performance.sourceSha256)) assert.equal(createHash('sha256').update(await readFile(name)).digest('hex'), digest, `Source changed since algorithm validation: ${name}`);
for (const outcome of performance.outcomes) assert.equal(createHash('sha256').update(await readFile(outcome.report)).digest('hex'), outcome.reportSha256, `Algorithm measurement report changed: ${outcome.report}`);
async function files(dir, prefix = '') {
  const names = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + entry.name;
    assert(!entry.isSymbolicLink());
    if (entry.isDirectory()) names.push(...await files(dir + '/' + entry.name, name + '/'));
    else names.push(name);
  }
  return names.sort();
}
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = hash((await Promise.all((await files('dist')).map(async name => `${name}\0${hash(await readFile(`dist/${name}`))}`))).join('\n'));
assert.equal(identity, report.buildSha256, 'dist changed since successful browser validation; rebuild and revalidate');
assert.equal(identity, http3.buildSha256, 'dist changed since real HTTP/3 validation; run npm run test:http3');
const script = String.raw`
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import hashlib, json, shutil
root=Path.cwd()
out=root/'artifacts'
out.mkdir(exist_ok=True)
packages=[('my-video-app-extension.zip',root/'dist','my-video-app'),('my-video-app-source.zip',root,'my-video-app-source'),('my-video-app-antivirus-helper.zip',root/'native','my-video-app-antivirus-helper')]
for name,source,prefix in packages:
    with ZipFile(out/name,'w',compression=ZIP_DEFLATED,compresslevel=9) as z:
        for p in sorted(source.rglob('*')):
            rel=p.relative_to(source)
            if source==root and rel.parts[0] in {'.git','node_modules','dist','dist-compat','artifacts','test-results','.cache'}: continue
            if '__pycache__' in rel.parts or p.suffix in {'.log','.pyc','.eml','.pem','.key','.p12'}: continue
            if p.is_symlink(): raise ValueError('Symbolic links are not allowed in packages: '+str(rel))
            if not p.is_file(): continue
            if source==root/'native' and rel.name.startswith('test_'): continue
            info=ZipInfo(prefix+'/'+rel.as_posix(),date_time=(2026,10,18,0,0,0))
            info.compress_type=ZIP_DEFLATED
            info.external_attr=0o100644<<16
            z.writestr(info,p.read_bytes())
    print(name,(out/name).stat().st_size,'bytes')
aliases={'vdh-typescript-upscale-extension.zip':'my-video-app-extension.zip','vdh-typescript-upscale-source.zip':'my-video-app-source.zip'}
for alias,name in aliases.items():
    shutil.copyfile(out/name,out/alias)
lines=[]
for name in [p[0] for p in packages]+list(aliases):
    p=out/name
    lines.append(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+name)
(out/'SHA256SUMS').write_text('\n'.join(lines)+'\n')
print('\n'.join(lines))
`;
const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exitCode = result.status ?? 1;
