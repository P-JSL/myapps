import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import createFileSha256 from '../scripts/lib/browser-sha256.mjs';

test('the packaged file SHA-256 hashes offset views beyond a 32-bit bit count', async () => {
  const raw = Uint8Array.from({ length: 128 * 1024 + 7 }, (_, index) => (index * 31 + (index >>> 8)) & 255);
  const block = raw.subarray(3, -4);
  const actual = await createFileSha256();
  const expected = createHash('sha256');
  for (let count = 0; count < 4097; count++) {
    expected.update(block);
    actual.update(block);
  }
  assert.equal(actual.byteLength, 4097 * block.byteLength);
  assert.equal(actual.digestHex(), expected.digest('hex'));
});
