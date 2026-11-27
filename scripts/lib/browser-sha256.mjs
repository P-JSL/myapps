import { createSHA256 } from 'hash-wasm';

export default async function createFileSha256() {
  const hasher = await createSHA256();
  let byteLength = 0;
  return {
    get byteLength() { return byteLength; },
    update(bytes) { hasher.update(bytes); byteLength += bytes.byteLength; },
    digestHex() { return hasher.digest('hex'); },
  };
}
