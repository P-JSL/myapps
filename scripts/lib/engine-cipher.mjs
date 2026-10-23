import { createCipheriv, randomBytes } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

const MAX_ENGINE_BYTES = 64 * 1024 * 1024;
const TAG_BYTES = 16;
const FORMAT = 'my-video-engine-v1';

function relativeAsset(value, name) {
  if (typeof value !== 'string' || !/^\.\.?\//.test(value) || /[\\\0?#]/.test(value)) {
    throw new TypeError(`${name} must be a relative asset path`);
  }
  return value;
}

/**
 * Compress and encrypt the packaged engine and emit its ordinary ESM loader.
 * The loader includes the client key: this obscures the packaged bytes and
 * authenticates them, but cannot keep the engine secret from its users.
 */
export function encryptEngine(wasmBuffer, { cipherPath, coreModulePath, decoderModulePath, decoderWasmPath,
  decoderWasmBytes, decoderWasmSha256 } = {}) {
  if (!(wasmBuffer instanceof Uint8Array)) throw new TypeError('Engine bytes must be a Uint8Array');
  if (!wasmBuffer.byteLength || wasmBuffer.byteLength > MAX_ENGINE_BYTES) {
    throw new RangeError(`Engine size must be between 1 and ${MAX_ENGINE_BYTES} bytes`);
  }
  relativeAsset(cipherPath, 'cipherPath');
  relativeAsset(coreModulePath, 'coreModulePath');
  const brotli = [decoderModulePath, decoderWasmPath, decoderWasmBytes, decoderWasmSha256].some(value => value !== undefined);
  if (brotli) {
    relativeAsset(decoderModulePath, 'decoderModulePath');
    relativeAsset(decoderWasmPath, 'decoderWasmPath');
    if (!Number.isSafeInteger(decoderWasmBytes) || decoderWasmBytes < 1 || decoderWasmBytes > 1024 * 1024
      || typeof decoderWasmSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(decoderWasmSha256)) {
      throw new TypeError('Decoder must have a bounded size and SHA-256 identity');
    }
  }
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const compression = brotli ? 'brotli' : 'gzip';
  const format = brotli ? 'my-video-engine-v2' : FORMAT;
  const compressed = brotli ? brotliCompressSync(wasmBuffer, { params: {
    [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 22,
    [constants.BROTLI_PARAM_SIZE_HINT]: wasmBuffer.byteLength,
  } }) : gzipSync(wasmBuffer, { level: 9 });
  if (compressed.byteLength > MAX_ENGINE_BYTES + 1024 * 1024) throw new RangeError('Compressed engine exceeds its size bound');
  const aad = `${format}\0${compression}\0${cipherPath}\0${coreModulePath}\0${wasmBuffer.byteLength}\0${compressed.byteLength}`
    + (brotli ? `\0${decoderModulePath}\0${decoderWasmPath}\0${decoderWasmBytes}\0${decoderWasmSha256}` : '');
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final(), cipher.getAuthTag()]);
  const metadataNoKey = {
    format,
    algorithm: 'AES-256-GCM',
    compression,
    cipherPath,
    coreModulePath,
    iv: iv.toString('base64'),
    tagBits: TAG_BYTES * 8,
    plaintextBytes: wasmBuffer.byteLength,
    compressedBytes: compressed.byteLength,
    ciphertextBytes: ciphertext.byteLength,
    clientKeyEmbedded: true,
    ...(brotli ? {
      compressionOptions: { quality: 11, windowBits: 22 },
      decoder: { modulePath: decoderModulePath, wasmPath: decoderWasmPath, wasmBytes: decoderWasmBytes, wasmSha256: decoderWasmSha256 },
    } : {}),
  };

  const loaderSource = `import core from ${JSON.stringify(coreModulePath)};

// The key ships to the client; encrypted packaging does not provide secrecy.
const keyBytes = Uint8Array.from(${JSON.stringify([...key])});
const iv = Uint8Array.from(${JSON.stringify([...iv])});
const additionalData = new TextEncoder().encode(${JSON.stringify(aad)});
const ciphertextBytes = ${ciphertext.byteLength};
const plaintextBytes = ${wasmBuffer.byteLength};

async function readBoundedStream(stream, expectedBytes, label, signal) {
  signal?.throwIfAborted();
  const bytes = new Uint8Array(expectedBytes);
  const reader = stream.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  let offset = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (value.byteLength > expectedBytes - offset) {
        await reader.cancel();
        throw new Error(label + ' has an invalid size');
      }
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  if (offset !== expectedBytes) throw new Error(label + ' has an invalid size');
  return bytes;
}

export default async function createEngine(options = {}) {
  if (!globalThis.crypto?.subtle) throw new Error('Encrypted engine requires Web Crypto');
  ${brotli ? '' : "if (typeof globalThis.DecompressionStream !== 'function') throw new Error('Encrypted engine requires gzip decompression');"}
  const signal = options.signal;
  signal?.throwIfAborted();
  const response = await fetch(new URL(${JSON.stringify(cipherPath)}, import.meta.url), { signal });
  if (!response.ok) throw new Error('Encrypted engine request failed (' + response.status + ')');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\\d+$/.test(length) || Number(length) !== ciphertextBytes)) {
    throw new Error('Encrypted engine has an invalid size');
  }
  if (!response.body) throw new Error('Encrypted engine response has no body');
  const ciphertext = await readBoundedStream(response.body, ciphertextBytes, 'Encrypted engine', signal);
  signal?.throwIfAborted();
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const compressed = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData, tagLength: ${TAG_BYTES * 8} }, key, ciphertext);
  signal?.throwIfAborted();
  ${brotli ? `const decoderResponse = await fetch(new URL(${JSON.stringify(decoderWasmPath)}, import.meta.url), { signal });
  if (!decoderResponse.ok || !decoderResponse.body) throw new Error('Engine decoder request failed');
  const decoderLength = decoderResponse.headers.get('content-length');
  if (decoderLength !== null && (!/^\\d+$/.test(decoderLength) || Number(decoderLength) !== ${decoderWasmBytes})) {
    throw new Error('Engine decoder has an invalid size');
  }
  const decoderBytes = await readBoundedStream(decoderResponse.body, ${decoderWasmBytes}, 'Engine decoder', signal);
  const decoderDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', decoderBytes));
  const decoderSha256 = Array.from(decoderDigest, byte => byte.toString(16).padStart(2, '0')).join('');
  if (decoderSha256 !== ${JSON.stringify(decoderWasmSha256)}) throw new Error('Engine decoder identity mismatch');
  signal?.throwIfAborted();
  const { default: decodeBrotli } = await import(${JSON.stringify(decoderModulePath)});
  const wasmBinary = await decodeBrotli(new Uint8Array(compressed), { expectedBytes: plaintextBytes, wasmBinary: decoderBytes, signal });`
    : `const decompressed = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const wasmBinary = await readBoundedStream(decompressed, plaintextBytes, 'Decompressed engine', signal);`}
  signal?.throwIfAborted();
  return core({ ...options, wasmBinary });
}
`;
  return { ciphertext, loaderSource, metadataNoKey };
}
