import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Run the product's archive writer itself, without executing release preconditions
// or duplicating its traversal and exclusion rules in a test implementation.
const packageSource = await readFile(new URL('../scripts/package.mjs', import.meta.url), 'utf8');
const writerMatch = packageSource.match(/const script = String\.raw`([\s\S]*?)`;/);
assert(writerMatch?.[1], 'The production Python archive writer must be available for verification');
const writer = writerMatch[1];
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
  for (const name of ['README.ko.md', 'antivirus_host.py', 'windows_antivirus.py', 'install.py', 'test_ignored.py']) {
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

test('normal release creates all five valid archives and checksums while excluding a node_modules symlink', async t => {
  const { source, outside, artifacts } = await fixture(t);
  await symlink(outside, path.join(source, 'node_modules'), 'dir');
  const result = archive(source);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const archives = inspect(artifacts);
  assert.deepEqual(archives.map(file => file.name), ['my-video-app-antivirus-helper.zip', 'my-video-app-extension.zip', 'my-video-app-source.zip', 'vdh-typescript-upscale-extension.zip', 'vdh-typescript-upscale-source.zip']);
  for (const file of archives) {
    assert.equal(file.corruptMember, null);
    assert.equal(file.containsOutsideFile, false, file.name);
    assert(!file.members.some(name => name.includes('/node_modules/')), file.name);
  }
  assert.deepEqual(archives.find(file => file.name === 'my-video-app-antivirus-helper.zip')?.members, ['my-video-app-antivirus-helper/README.ko.md', 'my-video-app-antivirus-helper/antivirus_host.py', 'my-video-app-antivirus-helper/install.py', 'my-video-app-antivirus-helper/windows_antivirus.py']);
  assert.deepEqual(await readFile(path.join(artifacts, 'my-video-app-extension.zip')), await readFile(path.join(artifacts, 'vdh-typescript-upscale-extension.zip')));
  assert.deepEqual(await readFile(path.join(artifacts, 'my-video-app-source.zip')), await readFile(path.join(artifacts, 'vdh-typescript-upscale-source.zip')));
  const checksums = (await readFile(path.join(artifacts, 'SHA256SUMS'), 'utf8')).trim().split('\n');
  assert.equal(checksums.length, 5);
  for (const line of checksums) {
    const match = line.match(/^([a-f0-9]{64})  ([a-z-]+\.zip)$/);
    assert(match?.[1] && match[2], 'Checksums must identify each archive');
    assert.equal(createHash('sha256').update(await readFile(path.join(artifacts, match[2]))).digest('hex'), match[1]);
  }
});
