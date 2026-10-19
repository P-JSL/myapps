import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function sourceIdentity() {
  const names = ['package.json', 'package-lock.json'];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '__pycache__') continue;
      assert(!entry.isSymbolicLink(), `Unexpected source symlink: ${dir}/${entry.name}`);
      const name = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await visit(name);
      else if (/\.(?:ts|mjs|py)$/.test(name) || (name.startsWith('tests/baselines/') && name.endsWith('.txt'))) names.push(name);
    }
  }
  for (const dir of ['src', 'native', 'scripts', 'tests']) await visit(dir);
  return Object.fromEntries(await Promise.all(names.sort().map(async name => [name, hash(await readFile(name))])));
}

// Run sequentially: competing benchmark processes would distort the comparison.
const sourceSha256 = await sourceIdentity();
const suites = [
  ['state', 'tests/bench-state.mjs'],
  ['media', 'tests/bench-media.mjs'],
  ['transfer', 'tests/bench-transfer.mjs'],
  ['ui', 'tests/bench-ui.mjs'],
  ['security', 'scripts/benchmark-security.mjs'],
];
const outcomes = [];
for (const [name, script] of suites) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', script], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300_000,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || '');
    throw new Error(`Algorithm benchmark failed: ${script} (${result.error?.message ?? result.status})`);
  }
  const report = JSON.parse(result.stdout);
  assert(report && typeof report === 'object' && !Array.isArray(report), `Missing report: ${script}`);
  const reportPath = `reports/performance-${name}.json`;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  outcomes.push({ name, command: `node --experimental-strip-types ${script}`, report: reportPath, status: 'passed', reportSha256: hash(await readFile(reportPath)) });
  console.log(`PASS ${name}: correctness assertions and comparative measurements completed`);
}
assert.deepEqual(await sourceIdentity(), sourceSha256, 'Source changed while benchmarks ran; use one consistent source snapshot');
const core = 'node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm';
const report = {
  version: 1, release: JSON.parse(await readFile('package.json', 'utf8')).version,
  baselineCommit: '6983b535ba089e7737e10583481ecd6ef35e7cc3',
  recordedAtUtc: new Date().toISOString(), status: 'passed',
  environment: { node: process.version, platform: `${process.platform}/${process.arch}`, cpu: cpus()[0]?.model, logicalCpus: cpus().length, hostMemoryBytes: totalmem(), ffmpegWasmSha256: hash(await readFile(core)) },
  methodology: 'Sequential comparative microbenchmarks with correctness assertions, warmup and repeated samples as detailed in each suite. No wall-time threshold is used as a correctness assertion. Operation speedups are not end-to-end download or encoding speedups.',
  sourceSha256, outcomes,
};
await writeFile('reports/performance.json', JSON.stringify(report, null, 2) + '\n');
console.log(`${outcomes.length} algorithm benchmark suites passed against a consistent source snapshot.`);
