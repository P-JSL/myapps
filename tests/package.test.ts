import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Run the product's archive writer itself, without executing release preconditions
// or duplicating its traversal and exclusion rules in a test implementation.
const writer = await readFile(new URL('../scripts/archive.py', import.meta.url), 'utf8');
const python = process.platform === 'win32' ? 'python' : 'python3';
const sentinel = 'Harmless external file: must never be copied into a release archive.';

async function fixture(t: TestContext) {
  const base = await mkdtemp(path.join(tmpdir(), 'my-video-app-package-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'), outside = path.join(base, 'outside');
  for (const name of ['dist', 'src', 'native']) await mkdir(path.join(source, name), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, 'sentinel.txt'), sentinel);
  await writeFile(path.join(source, 'dist', 'manifest.json'), '{"name":"Archive fixture","version":"1.0.0"}\n');
  await writeFile(path.join(source, 'src', 'main.ts'), 'export const fixture = true;\n');
  await writeFile(path.join(source, 'README.md'), 'Harmless release fixture.\n');
  for (const name of ['README.ko.md', 'antivirus_host.py', 'windows_antivirus.py', 'internal_scan.py', 'install.py', 'test_ignored.py', 'YOUTUBE.ko.md', 'youtube_host.py', 'install_youtube.py', 'youtube-requirements.txt']) {
    await writeFile(path.join(source, 'native', name), `Harmless fixture: ${name}\n`);
  }
  return { source, outside, artifacts: path.join(source, 'artifacts') };
}
function archive(source: string) { return spawnSync(python, ['-c', writer], { cwd: source, encoding: 'utf8' }); }
interface ArchiveInfo { name: string; members: string[]; containsOutsideFile: boolean; corruptMember: string | null; }
function inspect(artifacts: string): ArchiveInfo[] {
  const result = spawnSync(python, ['-c', `
from pathlib import Path
from zipfile import ZipFile
import json, sys
archives=[]
for file in sorted(Path(sys.argv[1]).glob('*.zip')):
    with ZipFile(file) as archive:
        archives.append({'name':file.name,'members':archive.namelist(),'containsOutsideFile':any(sys.argv[2].encode() in archive.read(name) for name in archive.namelist()),'corruptMember':archive.testzip()})
print(json.dumps(archives))
`, artifacts, sentinel], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as ArchiveInfo[];
}

for (const kind of ['file', 'dir'] as const) {
  test(`release archive rejects a source ${kind} symlink without leaking external bytes or publishing checksums`, async t => {
    const { source, outside, artifacts } = await fixture(t);
    await symlink(kind === 'file' ? path.join(outside, 'sentinel.txt') : outside, path.join(source, 'src', kind === 'file' ? 'linked.ts' : 'linked-directory'), kind);
    const result = archive(source);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, 'An external source symlink must fail the actual release writer');
    assert.match(result.stderr, /Symbolic links are not allowed in packages/);
    assert.equal((await readdir(artifacts)).includes('SHA256SUMS'), false, 'A failed archive must not publish a successful checksum manifest');
    const partialArchives = inspect(artifacts);
    assert(partialArchives.length > 0, 'Inspect the actual archives written before rejection');
    for (const partial of partialArchives) {
      assert.equal(partial.corruptMember, null);
      assert.equal(partial.containsOutsideFile, false, partial.name);
      assert(!partial.members.some(name => name.includes('linked')), partial.name);
    }
  });
}

test('normal release creates all six valid archives and keeps the two native helpers separate', async t => {
  const { source, outside, artifacts } = await fixture(t);
  await symlink(outside, path.join(source, 'node_modules'), 'dir');
  await symlink(outside, path.join(source, '.venv'), 'dir');
  for (const name of ['config.json', 'youtube-config.json']) await writeFile(path.join(source, 'native', name), sentinel);
  const result = archive(source);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const archives = inspect(artifacts);
  assert.deepEqual(archives.map(file => file.name), ['my-video-app-antivirus-helper.zip', 'my-video-app-extension.zip', 'my-video-app-source.zip', 'my-video-app-youtube-helper.zip', 'vdh-typescript-upscale-extension.zip', 'vdh-typescript-upscale-source.zip']);
  for (const file of archives) {
    assert.equal(file.corruptMember, null);
    assert.equal(file.containsOutsideFile, false, file.name);
    assert(!file.members.some(name => name.includes('/node_modules/')), file.name);
    assert(!file.members.some(name => /\/(?:\.venv|config\.json|youtube-config\.json)(?:\/|$)/.test(name)), file.name);
  }
  assert.deepEqual(archives.find(file => file.name === 'my-video-app-antivirus-helper.zip')?.members, ['my-video-app-antivirus-helper/README.ko.md', 'my-video-app-antivirus-helper/antivirus_host.py', 'my-video-app-antivirus-helper/install.py', 'my-video-app-antivirus-helper/internal_scan.py', 'my-video-app-antivirus-helper/windows_antivirus.py']);
  assert.deepEqual(archives.find(file => file.name === 'my-video-app-youtube-helper.zip')?.members, ['my-video-app-youtube-helper/YOUTUBE.ko.md', 'my-video-app-youtube-helper/install_youtube.py', 'my-video-app-youtube-helper/youtube-requirements.txt', 'my-video-app-youtube-helper/youtube_host.py']);
  assert.deepEqual(await readFile(path.join(artifacts, 'my-video-app-extension.zip')), await readFile(path.join(artifacts, 'vdh-typescript-upscale-extension.zip')));
  assert.deepEqual(await readFile(path.join(artifacts, 'my-video-app-source.zip')), await readFile(path.join(artifacts, 'vdh-typescript-upscale-source.zip')));
  const checksums = (await readFile(path.join(artifacts, 'SHA256SUMS'), 'utf8')).trim().split('\n');
  assert.equal(checksums.length, 6);
  for (const line of checksums) {
    const match = line.match(/^([a-f0-9]{64})  ([a-z-]+\.zip)$/);
    assert(match?.[1] && match[2], 'Checksums must identify each archive');
    assert.equal(createHash('sha256').update(await readFile(path.join(artifacts, match[2]))).digest('hex'), match[1]);
  }
});

test('missing native helper source aborts packaging and removes a stale checksum manifest', async t => {
  const { source, artifacts } = await fixture(t);
  await mkdir(artifacts); await writeFile(path.join(artifacts, 'SHA256SUMS'), 'old-success\n');
  await rm(path.join(source, 'native', 'youtube_host.py'));
  const result = archive(source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Required native helper files are missing: youtube_host.py/);
  assert.equal((await readdir(artifacts)).includes('SHA256SUMS'), false);
});

test('release entries use maximum DEFLATE compression even with deterministic custom ZipInfo metadata', async t => {
  const { source, artifacts } = await fixture(t);
  // Mixed repeated records exercise the longer match search of level9. A tiny
  // repeated string would compress identically at6 and9 and miss this regression.
  const payload = Buffer.from(Array.from({ length: 5000 }, (_, index) => JSON.stringify({
    id: index % 137, title: 'media asset ' + (index % 41), url: 'https://media.invalid/clip/' + (index % 67) + '.mp4',
    payload: 'LOCAL_VIDEO_APP'.repeat(1 + index % 31), quality: [1080, 720, 480][index % 3],
  })).join('\n'));
  for (const directory of ['dist', 'src']) await writeFile(path.join(source, directory, 'level-fixture.txt'), payload);
  for (const name of ['README.ko.md', 'YOUTUBE.ko.md']) await writeFile(path.join(source, 'native', name), payload);
  const result = archive(source);
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const oracle = spawnSync(python, ['-c', `
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json, struct, sys, zlib
payload=Path(sys.argv[1]).read_bytes()
def raw(level):
    encoder=zlib.compressobj(level,zlib.DEFLATED,-zlib.MAX_WBITS)
    return encoder.compress(payload)+encoder.flush()
six,nine=raw(6),raw(9)
results=[]
for name,member in [
    ('my-video-app-extension.zip','my-video-app/level-fixture.txt'),
    ('my-video-app-source.zip','my-video-app-source/src/level-fixture.txt'),
    ('my-video-app-antivirus-helper.zip','my-video-app-antivirus-helper/README.ko.md'),
    ('my-video-app-youtube-helper.zip','my-video-app-youtube-helper/YOUTUBE.ko.md'),
    ('vdh-typescript-upscale-extension.zip','my-video-app/level-fixture.txt'),
    ('vdh-typescript-upscale-source.zip','my-video-app-source/src/level-fixture.txt'),
]:
    file=Path(sys.argv[2])/name
    with ZipFile(file) as archive:
        info=archive.getinfo(member)
        with file.open('rb') as stream:
            stream.seek(info.header_offset)
            header=struct.unpack('<4s5H3I2H',stream.read(30))
            assert header[0]==b'PK\\x03\\x04'
            stream.seek(header[9]+header[10],1)
            compressed=stream.read(info.compress_size)
        results.append({'name':name,'maximumCompression':compressed==nine,
            'decodedBytesMatch':archive.read(member)==payload,'corruptMember':archive.testzip(),
            'deflated':info.compress_type==ZIP_DEFLATED,'dateTime':info.date_time,'mode':info.external_attr>>16})
print(json.dumps({'sixBytes':len(six),'nineBytes':len(nine),'archives':results}))
`, path.join(source, 'src', 'level-fixture.txt'), artifacts], { encoding: 'utf8' });
  assert.equal(oracle.error, undefined); assert.equal(oracle.status, 0, oracle.stderr);
  const evidence = JSON.parse(oracle.stdout) as { sixBytes: number; nineBytes: number; archives: Array<{
    name: string; maximumCompression: boolean; decodedBytesMatch: boolean; corruptMember: string | null;
    deflated: boolean; dateTime: number[]; mode: number;
  }> };
  assert(evidence.nineBytes < evidence.sixBytes, 'Fixture must distinguish the maximum compression from the default level');
  assert.equal(evidence.archives.length, 6);
  for (const file of evidence.archives) {
    assert.equal(file.maximumCompression, true, file.name);
    assert.equal(file.decodedBytesMatch, true, file.name); assert.equal(file.corruptMember, null, file.name);
    assert.equal(file.deflated, true); assert.deepEqual(file.dateTime, [2026, 10, 18, 0, 0, 0]); assert.equal(file.mode, 0o100644);
  }
  assert.deepEqual(await readFile(path.join(artifacts, 'my-video-app-extension.zip')), await readFile(path.join(artifacts, 'vdh-typescript-upscale-extension.zip')));
  assert.deepEqual(await readFile(path.join(artifacts, 'my-video-app-source.zip')), await readFile(path.join(artifacts, 'vdh-typescript-upscale-source.zip')));
});
