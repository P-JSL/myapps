// Compare an immutable published extension with the candidate on one Windows
// runner. ABBA order reduces simple warmup/time-order bias. No media is retained.
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

assert.equal(process.platform, 'win32', 'The paired full-video comparison requires native Windows');
const root = process.cwd(), output = path.join(root, 'artifacts/speed-verification');
await mkdir(output, { recursive: true });
const runs = [];
for (const [index, method] of ['baseline', 'candidate', 'candidate', 'baseline'].entries()) {
  const directory = path.join(output, `${index + 1}-${method}`);
  const extension = method === 'baseline' ? '.cache/speed-baseline/my-video-app-missav' : 'extensions/missav';
  const report = method === 'baseline' ? '.cache/speed-baseline/MISSAV-BUILD.json' : 'reports/build-missav.json';
  console.log(`Starting full-video run ${index + 1}/4: ${method}`);
  const result = spawnSync(process.execPath, ['tests/extension-live-browser.mjs'], {
    stdio: 'inherit', env: { ...process.env, MYVIDEOAPP_LIVE_OUTPUT_DIR: directory,
      MYVIDEOAPP_LIVE_EXTENSION_DIR: path.resolve(extension), MYVIDEOAPP_LIVE_BUILD_REPORT: path.resolve(report) },
  });
  assert.equal(result.status, 0, `${method} run failed; no performance conclusion can be drawn`);
  const evidence = JSON.parse(await readFile(path.join(directory, 'LIVE-VALIDATION.json')));
  assert(evidence.fullVideoVerified && evidence.downloadElapsedMs > 0 && /^[a-f0-9]{64}$/.test(evidence.savedFileSha256));
  runs.push({ method, downloadElapsedMs: evidence.downloadElapsedMs, bytes: evidence.savedMedia.bytes,
    sha256: evidence.savedFileSha256, duration: evidence.savedMedia.format.duration,
    buildSha256: evidence.buildSha256, browserVersion: evidence.browserVersion });
  await writeFile(path.join(output, 'RUNS.json'), JSON.stringify(runs, null, 2));
}
assert.equal(new Set(runs.map(row => row.sha256)).size, 1, 'Saved media changed between comparison runs');
assert.equal(new Set(runs.map(row => row.browserVersion)).size, 1);
const baseline = runs.filter(row => row.method === 'baseline').map(row => row.downloadElapsedMs);
const candidate = runs.filter(row => row.method === 'candidate').map(row => row.downloadElapsedMs);
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const result = { platform: process.platform, order: 'ABBA', runs, sampleCountPerMethod: 2,
  baselineMeanMs: mean(baseline), candidateMeanMs: mean(candidate),
  timeReductionPercent: (1 - mean(candidate) / mean(baseline)) * 100,
  identicalSavedFileSha256: runs[0].sha256,
  // Require non-overlapping outcomes with at least a 5% margin, rather than
  // promoting a small mean change that could be site/network variation.
  benefitConfirmed: Math.max(...candidate) < Math.min(...baseline) * .95,
  limitations: 'Two full downloads per method on one runner; site/network load can still vary. No universal bandwidth claim.' };
await writeFile(path.join(output, 'COMPARISON.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
