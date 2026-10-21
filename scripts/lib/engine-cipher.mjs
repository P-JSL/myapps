import { createCipheriv, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';

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
export function encryptEngine(wasmBuffer, { cipherPath, coreModulePath } = {}) {
  if (!(wasmBuffer instanceof Uint8Array)) throw new TypeError('Engine bytes must be a Uint8Array');
  if (!wasmBuffer.byteLength || wasmBuffer.byteLength > MAX_ENGINE_BYTES) {
    throw new RangeError(`Engine size must be between 1 and ${MAX_ENGINE_BYTES} bytes`);
  }
  relativeAsset(cipherPath, 'cipherPath');
  relativeAsset(coreModulePath, 'coreModulePath');
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const compressed = gzipSync(wasmBuffer, { level: 9 });
  const aad = `${FORMAT}\0gzip\0${cipherPath}\0${coreModulePath}\0${wasmBuffer.byteLength}\0${compressed.byteLength}`;
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final(), cipher.getAuthTag()]);
  const metadataNoKey = {
    format: FORMAT,
    algorithm: 'AES-256-GCM',
    compression: 'gzip',
    cipherPath,
    coreModulePath,
    iv: iv.toString('base64'),
    tagBits: TAG_BYTES * 8,
    plaintextBytes: wasmBuffer.byteLength,
    compressedBytes: compressed.byteLength,
    ciphertextBytes: ciphertext.byteLength,
    clientKeyEmbedded: true,
  };

  const loaderSource = `import core from ${JSON.stringify(coreModulePath)};

// The key ships to the client; encrypted packaging does not provide secrecy.
const keyBytes = Uint8Array.from(${JSON.stringify([...key])});
const iv = Uint8Array.from(${JSON.stringify([...iv])});
const additionalData = new TextEncoder().encode(${JSON.stringify(aad)});
const ciphertextBytes = ${ciphertext.byteLength};
const plaintextBytes = ${wasmBuffer.byteLength};

async function readBoundedStream(stream, expectedBytes, label) {
  const bytes = new Uint8Array(expectedBytes);
  const reader = stream.getReader();
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > expectedBytes - offset) {
        await reader.cancel();
        throw new Error(label + ' has an invalid size');
      }
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== expectedBytes) throw new Error(label + ' has an invalid size');
  return bytes;
}

export default async function createEngine(options = {}) {
  if (!globalThis.crypto?.subtle) throw new Error('Encrypted engine requires Web Crypto');
  if (typeof globalThis.DecompressionStream !== 'function') throw new Error('Encrypted engine requires gzip decompression');
  const response = await fetch(new URL(${JSON.stringify(cipherPath)}, import.meta.url));
  if (!response.ok) throw new Error('Encrypted engine request failed (' + response.status + ')');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\\d+$/.test(length) || Number(length) !== ciphertextBytes)) {
    throw new Error('Encrypted engine has an invalid size');
  }
  if (!response.body) throw new Error('Encrypted engine response has no body');
  const ciphertext = await readBoundedStream(response.body, ciphertextBytes, 'Encrypted engine');
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const compressed = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData, tagLength: ${TAG_BYTES * 8} }, key, ciphertext);
  const decompressed = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const wasmBinary = await readBoundedStream(decompressed, plaintextBytes, 'Decompressed engine');
  return core({ ...options, wasmBinary });
}
`;
  return { ciphertext, loaderSource, metadataNoKey };
}
