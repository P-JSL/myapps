import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { browserEntries } from '../scripts/project.mjs';

test('standard collector is byte-identical to pre-MissAV implementation', async () => {
  const source = await readFile('src/local/collect-standard.ts');
  const sha = createHash('sha1').update('blob ' + source.length + '\0').update(source).digest('hex');
  assert.equal(sha, '6ee8b1844b0ecded15a34efadedd42fb2fa4718a');
  assert.doesNotMatch(source.toString('utf8'), /missav|surrit|fourhoi|nineyu/i);
});

test('build variant selects one content script with unchanged extension entrypoint', () => {
  const selected = browserEntries.find(entry => entry.output === 'local/collect.js');
  assert.ok(selected);
  assert.equal(selected.format, 'iife');
  assert.equal(selected.input,
    process.env.MY_VIDEO_APP_EXTENSION_VARIANT === 'standard'
      ? 'src/local/collect-standard.ts'
      : 'src/local/collect.ts');
});
