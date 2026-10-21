import test from 'node:test';
import assert from 'node:assert/strict';
import { assetReference, rewriteJavaScript, rewriteHTML } from '../scripts/lib/protect-build.mjs';

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
