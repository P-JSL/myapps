/** Execute the workflow's actual Python validator against real small ZIPs.
 * GitHub API responses are explicit offline doubles; no release is published. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const match = workflow.match(/          python3 - <<'PY'\n([\s\S]*?)          PY\n/);
assert(match, 'The release workflow must contain its reviewable Python validator');
const validator = match[1].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
const python = process.platform === 'win32' ? 'python' : 'python3';
const commit = 'a'.repeat(40), tag = 'v1.16.0';
const reference = '/git/ref/tags/' + tag, release = '/releases/tags/' + tag;
const matching = { object: { type: 'commit', sha: commit } };
const helperFiles = ['YOUTUBE.ko.md', 'youtube_host.py', 'install_youtube.py', 'youtube-requirements.txt'];
const mock = String.raw`
import json, os
from io import BytesIO
from urllib import request, error
def mocked_open(req, timeout=30):
    path = req.full_url.split('/repos/P-JSL/myapps', 1)[1]
    value = json.loads(os.environ['WORKFLOW_API_FIXTURE']).get(path, 404)
    if isinstance(value, int):
        raise error.HTTPError(req.full_url, value, 'Explicit offline API fixture', {}, None)
    return BytesIO(json.dumps(value).encode())
request.urlopen = mocked_open
`;
const zipFixture = String.raw`
import hashlib, json, struct, sys, warnings
from pathlib import Path
from zipfile import ZipFile, ZipInfo
warnings.filterwarnings('ignore', message='Duplicate name:')
options=json.loads(sys.stdin.read())
helper_files=['YOUTUBE.ko.md','youtube_host.py','install_youtube.py','youtube-requirements.txt']
root=Path('.')
assets={
 'my-video-app-extension.zip': [('my-video-app/manifest.json', json.dumps({'version':options.get('zipVersion','1.16.0')}))],
 'my-video-app-youtube-helper.zip': [('my-video-app-youtube-helper/'+name, (root/'native'/name).read_text()) for name in helper_files],
}
if options.get('missingHelper'): assets['my-video-app-youtube-helper.zip'].pop()
if options.get('extraHelper'): assets['my-video-app-youtube-helper.zip'].append(('my-video-app-youtube-helper/private-config.json', 'must never ship'))
if options.get('staleHelper'): assets['my-video-app-youtube-helper.zip'][0]=(assets['my-video-app-youtube-helper.zip'][0][0], 'stale source')
bad=options.get('unsafeMember')
if bad: assets['my-video-app-youtube-helper.zip'].append((bad,'bad member'))
if options.get('duplicateHelper'): assets['my-video-app-youtube-helper.zip'].append(assets['my-video-app-youtube-helper.zip'][0])
for name, members in assets.items():
 with ZipFile(root/'artifacts'/name,'w') as archive:
  for member, payload in members:
   info=ZipInfo(member)
   if options.get('symlinkHelper') and name.endswith('youtube-helper.zip') and member.endswith('YOUTUBE.ko.md'): info.external_attr=0o120777<<16
   archive.writestr(info,payload)
 if options.get('corruptHelper') and name.endswith('youtube-helper.zip'):
  file=root/'artifacts'/name
  data=bytearray(file.read_bytes())
  with ZipFile(file) as archive:
   info=archive.infolist()[0]
   offset=info.header_offset
   header=struct.unpack('<4s5H3I2H',data[offset:offset+30])
   data[offset+30+header[9]+header[10]] ^= 1
  file.write_bytes(data)
 if options.get('encryptedHelper') and name.endswith('youtube-helper.zip'):
  file=root/'artifacts'/name
  data=bytearray(file.read_bytes())
  central=data.index(b'PK\x01\x02')
  data[central+8] |= 1
  file.write_bytes(data)
lines=[]
for name in assets:
 digest=hashlib.sha256((root/'artifacts'/name).read_bytes()).hexdigest()
 if options.get('wrongHelperHash') and name.endswith('youtube-helper.zip'): digest='0'*64
 lines.append(digest+'  '+name)
(root/'artifacts/SHA256SUMS').write_text('\n'.join(lines)+'\n')
`;

test('release workflow validates both assets and refuses unsafe or mismatched helper releases', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'my-video-app-release-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['artifacts', 'src/local', 'native']) await mkdir(path.join(root, name), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"version":"1.16.0"}\n');
  await writeFile(path.join(root, 'src/local/manifest.json'), '{"version":"1.16.0"}\n');
  await writeFile(path.join(root, 'README.md'), '| **1.16.0** | YouTube fixture changes | Documentation |\n');
  for (const name of helperFiles) await writeFile(path.join(root, 'native', name), `Harmless committed source fixture: ${name}\n`);
  const run = (api = {}, options = {}) => {
    const fixture = spawnSync(python, ['-c', zipFixture], { cwd: root, input: JSON.stringify(options), encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);
    const responses = typeof api === 'function' ? api(root) : api;
    return spawnSync(python, ['-c', mock + '\n' + validator], { cwd: root, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, WORKFLOW_API_FIXTURE: JSON.stringify(responses), GITHUB_REPOSITORY: 'P-JSL/myapps',
        GITHUB_SHA: commit, GITHUB_API_URL: 'https://api.github.com', GH_TOKEN: 'nonfunctional-offline-fixture-token',
        RUNNER_TEMP: root, GITHUB_OUTPUT: path.join(root, 'outputs') } });
  };
  for (const [name, api, options, succeeds] of [
    ['new release with two validated ZIPs', {}, {}, true],
    ['same-commit release retry', { [reference]: matching, [release]: { id: 1 } }, {}, true],
    ['annotated tag resolves to exact commit', { [reference]: { object: { type: 'tag', sha: 'b'.repeat(40) } }, ['/git/tags/' + 'b'.repeat(40)]: matching }, {}, true],
    ['tag cannot move to another commit', { [reference]: { object: { type: 'commit', sha: 'c'.repeat(40) } } }, {}, false],
    ['API failure cannot count as missing tag', { [reference]: 403 }, {}, false],
    ['release without matching tag is rejected', { [release]: { id: 1 } }, {}, false],
    ['incorrect helper checksum', {}, { wrongHelperHash: true }, false],
    ['extra private helper member', {}, { extraHelper: true }, false],
    ['missing required helper member', {}, { missingHelper: true }, false],
    ['stale helper source bytes', {}, { staleHelper: true }, false],
    ['helper traversal', {}, { unsafeMember: 'my-video-app-youtube-helper/../secret' }, false],
    ['helper absolute path', {}, { unsafeMember: '/private-file' }, false],
    ['helper duplicate member', {}, { duplicateHelper: true }, false],
    ['helper symbolic link', {}, { symlinkHelper: true }, false],
    ['helper CRC corruption despite recomputed SHA', {}, { corruptHelper: true }, false],
    ['helper encrypted flag', {}, { encryptedHelper: true }, false],
    ['extension ZIP wrong version', {}, { zipVersion: '9.9.9' }, false],
  ]) {
    await t.test(name, () => {
      const result = run(api, options);
      assert.equal(result.error, undefined);
      assert.equal(result.status === 0, succeeds, `${result.stdout}\n${result.stderr}`);
      assert(!`${result.stdout}\n${result.stderr}`.includes('nonfunctional-offline-fixture-token'));
    });
  }
  const prior = 'c'.repeat(40), originalTree = 'd'.repeat(40), currentTree = 'e'.repeat(40);
  const files = [
    ['package.json', '1'],
    ['src/local/manifest.json', '2'],
    ['artifacts/my-video-app-extension.zip', '3'],
    ['artifacts/my-video-app-youtube-helper.zip', '4'],
    ['src/local/background.ts', '5'],
    ['.github/workflows/release.yml', '6'],
    ['tests/release-workflow.test.mjs', '7'],
  ];
  function rollbackAPI(directory, options = {}) {
    const item = ([path, letter]) => ({ path, mode: '100644', type: 'blob', sha: letter.repeat(40) });
    const before = files.map(item);
    const after = files.map(([path, letter]) => item([path,
      path === '.github/workflows/release.yml' ? '8' :
      path === 'tests/release-workflow.test.mjs' ? '9' :
      (options.changedSource && path === 'src/local/background.ts') ? 'a' : letter,
    ]));
    const treeDirectories = [
      { path: 'tests', mode: '040000', type: 'tree', sha: 'b'.repeat(40) },
      { path: '.github/workflows', mode: '040000', type: 'tree', sha: 'c'.repeat(40) },
    ];
    const archive = name => 'sha256:' + createHash('sha256').update(readFileSync(path.join(directory, 'artifacts', name))).digest('hex');
    const assets = [
      { name: 'my-video-app-extension.zip', digest: options.changedAsset ? 'sha256:' + '0'.repeat(64) : archive('my-video-app-extension.zip') },
      { name: 'my-video-app-youtube-helper.zip', digest: archive('my-video-app-youtube-helper.zip') },
    ];
    return {
      [reference]: { object: { type: 'commit', sha: prior } },
      [release]: options.missingRelease ? 404 : {
        id: 17, draft: options.draft === true, prerelease: false,
        assets: options.missingAsset ? assets.slice(0, 1) : assets,
      },
      ['/git/commits/' + prior]: { tree: { sha: originalTree } },
      ['/git/commits/' + commit]: { tree: { sha: currentTree } },
      ['/git/trees/' + originalTree + '?recursive=1']: { tree: [...treeDirectories, ...before], truncated: false },
      ['/git/trees/' + currentTree + '?recursive=1']: { tree: [
        ...treeDirectories.map(row => ({ ...row, sha: 'f'.repeat(40) })), ...after,
      ], truncated: options.truncated === true },
    };
  }

  for (const [name, options, succeeds] of [
    ['rollback with identical release content skips publishing', {}, true],
    ['changed program source requires a new version', { changedSource: true }, false],
    ['changed published asset digest is rejected', { changedAsset: true }, false],
    ['missing release asset fails closed', { missingAsset: true }, false],
    ['missing release for an existing tag fails closed', { missingRelease: true }, false],
    ['draft release cannot be treated as published stable', { draft: true }, false],
    ['truncated Git tree cannot establish rollback identity', { truncated: true }, false],
  ]) {
    await t.test(name, async () => {
      await writeFile(path.join(root, 'outputs'), '');
      const result = run(directory => rollbackAPI(directory, options));
      assert.equal(result.error, undefined);
      assert.equal(result.status === 0, succeeds, result.stdout + '\n' + result.stderr);
      const outputs = await readFile(path.join(root, 'outputs'), 'utf8');
      if (succeeds) {
        assert.match(outputs, /publish=false/);
        assert.match(result.stdout, /skip publication/);
        assert.doesNotMatch(outputs, /publish=true/);
      } else {
        assert.doesNotMatch(outputs, /publish=false/);
      }
    });
  }
  const notes = await readFile(path.join(root, 'release-notes.md'), 'utf8');
  assert.match(notes, /my-video-app-extension\.zip/); assert.match(notes, /my-video-app-youtube-helper\.zip/);
  assert.match(notes, /Python·Deno/);
});

test('release workflow publishes both validated assets with pinned checkout and exact tag target', () => {
  assert.match(workflow, /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /permissions:\n  contents: write\n/);
  assert.match(workflow, /gh release create "\$TAG" artifacts\/my-video-app-extension\.zip artifacts\/my-video-app-youtube-helper\.zip .*--target "\$GITHUB_SHA"/);
  assert.match(workflow, /gh release upload "\$TAG" artifacts\/my-video-app-extension\.zip artifacts\/my-video-app-youtube-helper\.zip/);
  assert.match(workflow, /if: steps\.validate\.outputs\.publish == 'true'/);
  assert.match(workflow, /Test release validation and rollback safety/);
  assert(!/git (?:tag|push).*--force/.test(workflow));
});
