import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { browserEntries } from '../scripts/project.mjs';

const snapshots = [
  { path: 'src/local/collect-standard.ts', sha: '6ee8b1844b0ecded15a34efadedd42fb2fa4718a' },
  { path: 'src/local/background-standard.ts', sha: 'ded1fd13e653b38ffd14b505ac8e0141824ed479' },
];

test('standard runtime files are byte-identical to pre-MissAV originals', async () => {
  for (const item of snapshots) {
    const source = await readFile(item.path);
    const sha = createHash('sha1').update('blob ' + source.length + '\0').update(source).digest('hex');
    assert.equal(sha, item.sha, item.path);
    assert.doesNotMatch(source.toString('utf8'), /missav|surrit|fourhoi|nineyu/i, item.path);
  }
});

test('build variant uses matching original or patched runtime entry points', () => {
  const standard = process.env.MY_VIDEO_APP_EXTENSION_VARIANT === 'standard';
  for (const [entrypoint, original, patched] of [
    ['local/collect.js', 'src/local/collect-standard.ts', 'src/local/collect.ts'],
    ['local/background.js', 'src/local/background-standard.ts', 'src/local/background.ts'],
  ]) {
    const entry = browserEntries.find(item => item.output === entrypoint);
    assert.ok(entry, entrypoint);
    assert.equal(entry.input, standard ? original : patched);
  }
  assert.equal(browserEntries.find(item => item.output === 'local/collect.js')?.format, 'iife');
  assert.equal(browserEntries.find(item => item.output === 'local/background.js')?.format, 'esm');
});
