import init, { BrotliDecStream } from 'brotli-dec-wasm/web';

const BLOCK_BYTES = 65_536;
const MAX_BYTES = 64 * 1024 * 1024;
let initialization;

/** Offline engine decoder. Never use the dependency's unbounded one-shot API. */
export default async function decodeBrotli(compressed, { expectedBytes, wasmBinary, signal } = {}) {
  // A maximum-sized incompressible engine may include a small format overhead.
  if (!(compressed instanceof Uint8Array) || !compressed.byteLength || compressed.byteLength > MAX_BYTES + 1024 * 1024
    || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > MAX_BYTES
    || (!(wasmBinary instanceof Uint8Array) && !(wasmBinary instanceof ArrayBuffer))) {
    throw new TypeError('Invalid bounded Brotli input');
  }
  signal?.throwIfAborted();
  // Explicit bytes prevent the vendored initializer from requesting a remote URL.
  initialization ??= init({ module_or_path: wasmBinary }).catch(error => { initialization = undefined; throw error; });
  await initialization;
  signal?.throwIfAborted();
  const output = new Uint8Array(expectedBytes);
  const decoder = new BrotliDecStream();
  let consumed = 0, written = 0, calls = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const input = compressed.subarray(consumed, Math.min(compressed.byteLength, consumed + BLOCK_BYTES));
      let result;
      try {
        // The extra byte detects expansion beyond the exact authenticated size.
        result = decoder.dec(input, Math.min(BLOCK_BYTES, expectedBytes - written + 1));
        const bytes = result.buf, code = result.code, offset = result.input_offset;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > input.byteLength
          || bytes.byteLength > expectedBytes - written) throw new Error('Brotli engine has an invalid size');
        consumed += offset;
        output.set(bytes, written); written += bytes.byteLength;
        if (code === 1) {
          if (consumed !== compressed.byteLength || written !== expectedBytes || decoder.total_out() !== written) {
            throw new Error('Brotli engine has an invalid size');
          }
          signal?.throwIfAborted();
          return output;
        }
        if ((code !== 2 && code !== 3) || (!offset && !bytes.byteLength)) {
          throw new Error('Brotli engine is truncated or stalled');
        }
      } finally { result?.free(); }
      // Cooperate with cancellation without accumulating input/output chunks.
      if (++calls % 16 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally { decoder.free(); }
}
