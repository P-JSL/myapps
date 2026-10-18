import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedData, record } from '../src/security/validation.ts';

test('bounded data accepts ordinary structured messages and repeated non-cyclic references', () => {
  const shared = { title: '영상', values: [null, true, false, 0, 1.5, undefined] };
  assert.equal(boundedData({ first: shared, second: shared }), true);
  assert.equal(boundedData(Object.assign(Object.create(null), { title: 'null prototype' })), true);
  assert.equal(record({}), true);
  for (const value of [null, undefined, [], 'object', 2]) assert.equal(record(value), false);
});

test('bounded data rejects cycles, exotic objects, invalid primitives and prototype keys', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const array: unknown[] = [];
  array.push(array);
  for (const value of [cyclic, array, new Date(), new Map(), new Set(), new Uint8Array(8), NaN, Infinity, -Infinity, 1n, Symbol('x'), () => 1]) {
    assert.equal(boundedData(value), false);
  }
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.equal(boundedData(JSON.parse(`{"nested":{"${key}":"pollution"}}`)), false);
  }
});

test('bounded data accounts for key and value lengths and enforces depth and node limits', () => {
  assert.equal(boundedData({ a: '1234' }, 5), true);
  assert.equal(boundedData({ a: '12345' }, 5), false);
  let deep: unknown = 'leaf';
  for (let i = 0; i < 65; i++) deep = [deep];
  assert.equal(boundedData(deep), false);
  assert.equal(boundedData(new Array(100_001).fill(null)), false);
});
