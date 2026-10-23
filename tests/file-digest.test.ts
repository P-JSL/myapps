import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IncrementalSha256, inspectPreparedFile } from '../src/security/file-digest.ts';

const encode = (value: string) => new TextEncoder().encode(value);
const expected = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function media(size: number) {
  const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
  view.setUint32(0, 20); bytes.set(encode('ftypisom'), 4); bytes.set(encode('mp42'), 16);
  return bytes;
}

test('incremental SHA-256 matches published known vectors and retains the unpadded byte count', () => {
  for (const [value, hash] of [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    ['a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
  ]) {
    const bytes = encode(value!), digest = new IncrementalSha256();
    for (let at = 0; at < bytes.length; at += 127) digest.update(bytes.subarray(at, at + 127));
    assert.equal(digest.byteLength, bytes.length);
    assert.equal(digest.digestHex(), hash); assert.equal(digest.digestHex(), hash);
    assert.equal(digest.byteLength, bytes.length);
    assert.throws(() => digest.update(new Uint8Array()), /완료/);
  }
});

test('incremental SHA-256 matches Node for padding boundaries, byte offsets and randomized chunk partitions', () => {
  let seed = 0x12345678;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (const size of [1, 7, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 4097, 65537]) {
    const allocation = new Uint8Array(size + 13), bytes = allocation.subarray(5, size + 5);
    for (let at = 0; at < bytes.length; at++) bytes[at] = next() & 255;
    const original = bytes.slice(), wanted = expected(bytes);
    for (const step of [1, 63, 64, 65, 513, 0]) {
      const digest = new IncrementalSha256();
      for (let at = 0; at < bytes.length;) {
        const count = step || 1 + next() % 151;
        digest.update(bytes.subarray(at, at + count)); digest.update(new Uint8Array()); at += count;
      }
      assert.equal(digest.digestHex(), wanted, `${size} bytes / ${step} chunk`);
      assert.deepEqual(bytes, original);
    }
  }
  assert.throws(() => new IncrementalSha256().update('invalid' as unknown as Uint8Array), TypeError);
});

test('incremental SHA-256 preserves the high bit-length word past 512 MiB with constant input memory', () => {
  const block = new Uint8Array(128 * 1024);
  for (let at = 0; at < block.length; at++) block[at] = (at * 31 + (at >>> 8)) & 255;
  const digest = new IncrementalSha256(), reference = createHash('sha256');
  for (let count = 0; count < 4097; count++) { digest.update(block); reference.update(block); }
  assert.equal(digest.byteLength, 4097 * block.length);
  assert(digest.byteLength * 8 > 0xffff_ffff);
  assert.equal(digest.digestHex(), reference.digest('hex'));
});

test('prepared-file inspection reads bounded slices, hashes all bytes, and keeps large static analysis explicitly partial', async () => {
  const bytes = media(8 * 1024 * 1024 + 257); bytes[bytes.length - 1] = 93;
  class InstrumentedBlob extends Blob {
    reads: Array<[number | undefined, number | undefined]> = [];
    override arrayBuffer(): Promise<ArrayBuffer> { assert.fail('Whole-file arrayBuffer must not be used'); }
    override slice(start?: number, end?: number, type?: string): Blob {
      this.reads.push([start, end]); return super.slice(start, end, type);
    }
  }
  const file = new InstrumentedBlob([bytes]), updates: Array<[number, number]> = [];
  const result = await inspectPreparedFile(file, new AbortController().signal, (loaded, total) => updates.push([loaded, total]));
  assert.equal(result.sha256, expected(bytes)); assert.equal(result.size, bytes.length);
  assert.deepEqual(file.reads, [[0, 4194304], [4194304, 8388608], [8388608, bytes.length]]);
  assert.deepEqual(updates, [[4194304, bytes.length], [8388608, bytes.length], [bytes.length, bytes.length]]);
  assert.equal(result.prefix.length, 8 * 1024 * 1024); assert.deepEqual(result.prefix, bytes.subarray(0, result.prefix.length));
  assert.equal(result.internalScan.status, 'incomplete'); assert.equal(result.internalScan.complete, false);
  assert.equal(result.internalScan.scannedBytes, result.prefix.length);
  assert(result.internalScan.findings.some(finding => finding.id === 'partial-input'));
  const small = await inspectPreparedFile(new Blob([media(1024)]), new AbortController().signal);
  assert.equal(small.internalScan.status, 'no-signals'); assert.equal(small.internalScan.complete, true);
});

test('prepared-file inspection detects a harmless test marker crossing read slices without shipping its raw marker', async () => {
  const bytes = media(4 * 1024 * 1024 + 256);
  const marker = new Uint8Array([88,53,79,33,80,37,64,65,80,91,52,92,80,90,88,53,52,40,80,94,41,55,67,67,41,55,125,36,69,73,67,65,82,45,83,84,65,78,68,65,82,68,45,65,78,84,73,86,73,82,85,83,45,84,69,83,84,45,70,73,76,69,33,36,72,43,72,42]);
  bytes.set(marker, 4 * 1024 * 1024 - 21);
  const result = await inspectPreparedFile(new Blob([bytes]), new AbortController().signal);
  assert.equal(result.sha256, expected(bytes)); assert.equal(result.internalScan.status, 'suspicious');
  assert(result.internalScan.findings.some(finding => finding.id === 'eicar-test-marker' && finding.offset === 4 * 1024 * 1024 - 21));
});

test('prepared-file inspection accepts greater-than-2-GiB metadata and aborts without allocating that file', async () => {
  const controller = new AbortController(); let reads = 0;
  class LargeBlob extends Blob {
    override get size() { return 3 * 1024 * 1024 * 1024 + 11; }
    override slice(start?: number, end?: number): Blob {
      assert.equal(start, 0); assert.equal(end, 4 * 1024 * 1024); reads++;
      controller.abort(new DOMException('Test cancellation', 'AbortError'));
      return new Blob();
    }
  }
  await assert.rejects(inspectPreparedFile(new LargeBlob(), controller.signal), { name: 'AbortError' });
  assert.equal(reads, 1);
});

test('prepared-file inspection refuses truncated reads, invalid sizes, and cancellation before publishing', async () => {
  class TruncatedBlob extends Blob {
    override slice(): Blob { return new Blob([new Uint8Array(1)]); }
  }
  await assert.rejects(inspectPreparedFile(new TruncatedBlob([media(100)]), new AbortController().signal), /변경|읽지/);
  class InvalidBlob extends Blob { override get size() { return Number.MAX_SAFE_INTEGER + 1; } }
  await assert.rejects(inspectPreparedFile(new InvalidBlob(), new AbortController().signal), RangeError);
  const before = new AbortController(); before.abort();
  await assert.rejects(inspectPreparedFile(new Blob(), before.signal), { name: 'AbortError' });
  const after = new AbortController();
  await assert.rejects(inspectPreparedFile(new Blob([media(100)]), after.signal, () => after.abort()), { name: 'AbortError' });
  const empty = await inspectPreparedFile(new Blob(), new AbortController().signal);
  assert.equal(empty.sha256, expected(new Uint8Array())); assert.equal(empty.internalScan.status, 'incomplete');
});
