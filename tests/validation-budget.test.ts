import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedData } from '../src/security/validation.ts';

test('node budget accepts exactly 100000 visits including aliases and excludes exit markers', () => {
  assert.equal(boundedData(Array(99_999).fill(null)), true);
  assert.equal(boundedData(Array(100_000).fill(null)), false);
  const shared = { value: null };
  assert.equal(boundedData(Array(49_999).fill(shared)), true);
  assert.equal(boundedData(Array(50_000).fill(shared)), false);
  assert.equal(boundedData([Array(49_998).fill(null), Array(49_999).fill(null)]), true);
  assert.equal(boundedData([Array(49_999).fill(null), Array(49_999).fill(null)]), false);
});

test('wide rejected data does not read values beyond the traversal budget', () => {
  let reads = 0;
  const wide = new Proxy(Array(100_000).fill(null), {
    get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); },
  });
  assert.equal(boundedData(wide), false);
  assert.equal(reads, 0);
});

test('early budgets preserve sparse arrays, exact depth and character boundaries', () => {
  const sparse = Array(1_000_000);
  sparse[999_999] = null;
  assert.equal(boundedData(sparse), true);
  assert.equal(boundedData({ abc: null }, 3), true);
  assert.equal(boundedData({ abc: null }, 2), false);
  let deep: unknown = null;
  for (let i = 0; i < 64; i++) deep = [deep];
  assert.equal(boundedData(deep), true);
  assert.equal(boundedData([deep]), false);
});
