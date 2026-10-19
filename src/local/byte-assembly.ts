/** Assemble a previously validated body or range without retaining a larger backing buffer. */
export function assembleBytes(chunks: readonly Uint8Array[], total: number, offset = 0, length = total): Uint8Array<ArrayBuffer> {
  const only = chunks.length === 1 ? chunks[0] : undefined;
  if (offset === 0 && length === total && only?.byteLength === total && only.byteOffset === 0) {
    const buffer = only.buffer;
    if (buffer instanceof ArrayBuffer && buffer.byteLength === total) return new Uint8Array(buffer);
  }
  const output = new Uint8Array(length);
  if (offset === 0 && length === total) {
    let written = 0;
    for (const chunk of chunks) { output.set(chunk, written); written += chunk.length; }
    if (written !== length) throw new Error('미디어 조각이 불완전합니다.');
    return output;
  }
  let position = 0, written = 0;
  for (const chunk of chunks) {
    const begin = Math.max(0, offset - position);
    const end = Math.min(chunk.length, offset + length - position);
    if (begin < end) { output.set(chunk.subarray(begin, end), written); written += end - begin; }
    position += chunk.length;
    if (written === length) break;
  }
  if (written !== length) throw new Error('미디어 조각이 불완전합니다.');
  return output;
}
