import { scanBytes, type InternalScanResult } from './internal-scan.ts';

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotate = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

/** Standard SHA-256 with constant working memory and no retained input chunks. */
export class IncrementalSha256 {
  private readonly state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private readonly words = new Uint32Array(64);
  private readonly pending = new Uint8Array(64);
  private pendingLength = 0;
  private length = 0;
  private result: string | undefined;

  get byteLength(): number { return this.length; }

  update(bytes: Uint8Array): this {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('SHA-256 입력은 바이트 배열이어야 합니다.');
    if (this.result !== undefined) throw new Error('완료된 SHA-256 검사는 다시 갱신할 수 없습니다.');
    if (!Number.isSafeInteger(this.length + bytes.byteLength)) throw new RangeError('파일 크기가 정확한 바이트 계산 범위를 초과했습니다.');
    this.length += bytes.byteLength;
    let offset = 0;
    if (this.pendingLength) {
      const take = Math.min(64 - this.pendingLength, bytes.byteLength);
      this.pending.set(bytes.subarray(0, take), this.pendingLength);
      this.pendingLength += take; offset = take;
      if (this.pendingLength === 64) { this.compress(this.pending, 0); this.pendingLength = 0; }
    }
    while (offset + 64 <= bytes.byteLength) { this.compress(bytes, offset); offset += 64; }
    if (offset < bytes.byteLength) {
      this.pending.set(bytes.subarray(offset), this.pendingLength);
      this.pendingLength += bytes.byteLength - offset;
    }
    return this;
  }

  digestHex(): string {
    if (this.result !== undefined) return this.result;
    const lengthBits = BigInt(this.length) * 8n;
    // Safe-integer byte lengths fit exactly inside SHA-256's unsigned 64-bit length.
    if (lengthBits > 0xffff_ffff_ffff_ffffn) throw new RangeError('SHA-256 길이 범위를 초과했습니다.');
    this.pending[this.pendingLength++] = 0x80;
    if (this.pendingLength > 56) { this.pending.fill(0, this.pendingLength); this.compress(this.pending, 0); this.pendingLength = 0; }
    this.pending.fill(0, this.pendingLength, 56);
    for (let index = 0; index < 8; index++) this.pending[63 - index] = Number((lengthBits >> BigInt(index * 8)) & 255n);
    this.compress(this.pending, 0);
    this.result = Array.from(this.state, value => value.toString(16).padStart(8, '0')).join('');
    this.pending.fill(0); this.words.fill(0);
    return this.result;
  }

  private compress(bytes: Uint8Array, offset: number): void {
    const words = this.words;
    for (let index = 0; index < 16; index++) {
      const at = offset + index * 4;
      words[index] = (bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!;
    }
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15]!, b = words[index - 2]!;
      const first = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
      const second = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
      words[index] = (words[index - 16]! + first + words[index - 7]! + second) >>> 0;
    }
    let a = this.state[0]!, b = this.state[1]!, c = this.state[2]!, d = this.state[3]!;
    let e = this.state[4]!, f = this.state[5]!, g = this.state[6]!, h = this.state[7]!;
    for (let index = 0; index < 64; index++) {
      const first = h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + ROUND_CONSTANTS[index]! + words[index]!;
      const second = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      h = g; g = f; f = e; e = (d + first) >>> 0;
      d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    this.state[0] = (this.state[0]! + a) >>> 0; this.state[1] = (this.state[1]! + b) >>> 0;
    this.state[2] = (this.state[2]! + c) >>> 0; this.state[3] = (this.state[3]! + d) >>> 0;
    this.state[4] = (this.state[4]! + e) >>> 0; this.state[5] = (this.state[5]! + f) >>> 0;
    this.state[6] = (this.state[6]! + g) >>> 0; this.state[7] = (this.state[7]! + h) >>> 0;
  }
}

const READ_BYTES = 4 * 1024 * 1024;
const PREFIX_BYTES = 8 * 1024 * 1024;
export interface PreparedFileInspection {
  sha256: string;
  size: number;
  prefix: Uint8Array<ArrayBuffer>;
  internalScan: InternalScanResult;
}

/** Hash every byte while retaining only an 8 MiB static-analysis prefix. */
export async function inspectPreparedFile(file: Blob, signal: AbortSignal,
  progress?: (loaded: number, total: number) => void): Promise<PreparedFileInspection> {
  signal.throwIfAborted();
  const size = file.size;
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('파일 크기를 정확하게 확인할 수 없습니다.');
  const prefix = new Uint8Array(Math.min(size, PREFIX_BYTES));
  const digest = new IncrementalSha256();
  for (let offset = 0; offset < size;) {
    signal.throwIfAborted();
    const end = Math.min(size, offset + READ_BYTES);
    const buffer = await file.slice(offset, end).arrayBuffer();
    signal.throwIfAborted();
    if (buffer.byteLength !== end - offset) throw new Error('파일 내용이 변경되었거나 일부 데이터를 읽지 못했습니다.');
    const bytes = new Uint8Array(buffer);
    digest.update(bytes);
    if (offset < prefix.byteLength) prefix.set(bytes.subarray(0, Math.min(bytes.byteLength, prefix.byteLength - offset)), offset);
    offset = end; progress?.(offset, size);
  }
  signal.throwIfAborted();
  if (file.size !== size || digest.byteLength !== size) throw new Error('검사 중 파일 크기가 변경되었습니다.');
  const internalScan = scanBytes(prefix, { complete: size <= PREFIX_BYTES, expectedMedia: true });
  signal.throwIfAborted();
  return { sha256: digest.digestHex(), size, prefix, internalScan };
}
