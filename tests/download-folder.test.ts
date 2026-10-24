import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadFolderConfirmed } from '../src/local/download-folder.ts';

test('only an explicitly stored boolean acknowledges the initial download folder setup', () => {
  assert.equal(downloadFolderConfirmed(), false);
  assert.equal(downloadFolderConfirmed(false), false);
  assert.equal(downloadFolderConfirmed(true), true);
  for (const value of [null, 0, 1, 'false', 'true', [], {}, { confirmed: true }]) assert.throws(() => downloadFolderConfirmed(value));
});
