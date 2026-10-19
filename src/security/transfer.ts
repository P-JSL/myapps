/**
 * Consume an exclusively owned byte array when handing it to a worker recipient.
 * The pinned FFmpeg FS.readFile allocates such an array independently of MEMFS
 * and the Wasm heap. Callers must not use that array after transferring it.
 * Subviews and shared buffers are copied so unrelated bytes are never exposed.
 */
export function ownedTransferBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
  return new Uint8Array(bytes).buffer;
}
