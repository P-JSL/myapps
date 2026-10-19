#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { boundedData } from '../src/security/validation.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(import.meta.url);

// Frozen pre-optimization algorithm. Keep limits and ordering equivalent to the
// secure baseline; this is benchmark code, never included in the extension.
function baseline(value, maxChars = 16 * 1024 * 1024) {
  const stack = [[value, 0]], visited = new Set();
  let nodes = 0, chars = 0;
  while (stack.length) {
    const [item, depth, exit] = stack.pop();
    if (exit) { visited.delete(item); continue; }
    if (++nodes > 100_000 || depth > 64) return false;
    if (typeof item === 'string') chars += item.length;
    else if (typeof item === 'number' && !Number.isFinite(item)) return false;
    else if (typeof item === 'object' && item !== null) {
      if (visited.has(item)) return false;
      visited.add(item); stack.push([item, depth, true]);
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
      for (const key of Object.keys(item)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return false;
        chars += key.length; stack.push([item[key], depth + 1]);
      }
    } else if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') return false;
    if (chars > maxChars) return false;
  }
  return true;
}

function fixture(name) {
  if (name === 'wide-rejected') return Array(500_000).fill(null);
  if (name === 'normal') return Array.from({ length: 1000 }, (_, index) => ({ a: String(index), b: [null, 1, true] }));
  throw new Error('Unknown benchmark fixture');
}

function equivalent() {
  const shared = { a: null }, cyclic = {};
  cyclic.self = cyclic;
  const sparse = Array(1_000_000); sparse[999_999] = null;
  const cases = [null, undefined, NaN, Infinity, 1n, () => {}, new Date(), new Uint8Array(4),
    cyclic, [shared, shared], sparse, Object.assign(Object.create(null), { a: 'hello' }),
    JSON.parse('{"nested":{"__proto__":"forbidden"}}'), Array(99_999).fill(null), Array(100_000).fill(null),
    [Array(49_998).fill(null), Array(49_999).fill(null)], [Array(49_999).fill(null), Array(49_999).fill(null)]];
  let deep = null;
  for (let i = 0; i < 64; i++) deep = [deep];
  cases.push(deep, [deep]);
  let seed = 143;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let i = 0; i < 1000; i++) {
    const value = { title: String(random()), values: Array.from({ length: random() % 20 }, () => random() % 3 ? random() : shared) };
    cases.push(value);
  }
  for (const value of cases) for (const budget of [0, 3, 1024, 16 * 1024 * 1024]) assert.equal(boundedData(value, budget), baseline(value, budget));
  return cases.length * 4;
}

if (process.argv[2] === '--worker') {
  const mode = process.argv[3], name = process.argv[4], value = fixture(name);
  const implementation = mode === 'baseline' ? baseline : boundedData;
  const repeats = name === 'normal' ? 15 : 7, iterations = name === 'normal' ? 20 : 1;
  for (let i = 0; i < (name === 'normal' ? 100 : 1); i++) implementation(value);
  const samples = [];
  let result;
  for (let repeat = 0; repeat < repeats; repeat++) {
    global.gc?.();
    const start = performance.now();
    for (let i = 0; i < iterations; i++) result = implementation(value);
    samples.push((performance.now() - start) / iterations);
  }
  samples.sort((a, b) => a - b);
  console.log(JSON.stringify({ mode, fixture: name, result, repetitions: repeats, iterationsPerSample: iterations,
    medianMs: samples[Math.floor(samples.length / 2)], minMs: samples[0], maxMs: samples.at(-1),
    peakProcessRssKiB: process.resourceUsage().maxRSS }));
} else {
  const comparisons = equivalent(), metrics = [];
  for (const name of ['normal', 'wide-rejected']) for (const mode of ['baseline', 'optimized']) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--expose-gc', script, '--worker', mode, name], { cwd: repository, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || 'Validation benchmark worker failed');
    metrics.push(JSON.parse(result.stdout));
  }
  const native = spawnSync(process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), ['-B', 'scripts/benchmark-native.py'], { cwd: repository, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (native.error) throw native.error;
  if (native.status !== 0) throw new Error(native.stderr || 'Native experiment failed');
  const report = { name: 'security-validation', status: 'passed', runtime: process.version,
    behaviorEquivalent: true, equivalenceComparisons: comparisons,
    datasets: { normal: { rows: 1000, traversalNodes: 6001, accepted: true }, 'wide-rejected': { entries: 500000, traversalNodes: 500001, accepted: false } },
    limits: { nodes: 100000, depth: 64, defaultChars: 16 * 1024 * 1024 },
    operationChange: 'Reject excess pending nodes before allocating child tuples or reading their values; stop at exceeded key-character budget. Object.keys still enumerates all own enumerable keys.',
    complexity: 'Traversal remains O(visited nodes + enumerated keys); wide Object.keys memory remains O(width). No constant-time or sublinear total-validation claim.',
    assumptions: 'Plain structured-clone/JSON boundary data; getters and Proxy side effects are not a supported transport data contract.',
    metrics, nativeExperiment: JSON.parse(native.stdout),
    sourceSha256: { 'src/security/validation.ts': createHash('sha256').update(await readFile(new URL('../src/security/validation.ts', import.meta.url))).digest('hex') },
    baselineAlgorithmSha256: createHash('sha256').update(baseline.toString()).digest('hex') };
  if (process.argv[2] === '--report') {
    if (!process.argv[3]) throw new Error('Provide a report output path');
    await writeFile(process.argv[3], JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report));
}
