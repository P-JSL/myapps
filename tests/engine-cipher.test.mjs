import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { encryptEngine } from '../scripts/lib/engine-cipher.mjs';

const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const paths = { cipherPath: './encrypted.bin', coreModulePath: './core.mjs' };

async function fixture(t, source) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'my-video-engine-cipher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'core.mjs'), 'export default options => globalThis.engineCipherTestCore(options);\n');
  await writeFile(path.join(root, 'loader.mjs'), source);
  return { root, load: (await import(pathToFileURL(path.join(root, 'loader.mjs')).href)).default };
}

function runtime(t, responder) {
  let calls = 0;
  const requests = [];
  t.mock.method(globalThis, 'fetch', async request => {
    requests.push(request);
    return responder(request);
  });
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  const originalCore = Object.getOwnPropertyDescriptor(globalThis, 'engineCipherTestCore');
  globalThis.engineCipherTestCore = options => { calls += 1; return options; };
  t.after(() => {
    if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
    else delete globalThis.crypto;
    if (originalCore) Object.defineProperty(globalThis, 'engineCipherTestCore', originalCore);
    else delete globalThis.engineCipherTestCore;
  });
  return { requests, calls: () => calls };
}

test('generated engine loader decrypts exact bytes with Web Crypto and preserves core options', async t => {
  const encrypted = encryptEngine(wasm, paths);
  const state = runtime(t, () => new Response(encrypted.ciphertext, {
    headers: { 'content-length': String(encrypted.ciphertext.byteLength) },
  }));
  const { root, load } = await fixture(t, encrypted.loaderSource);
  const printErr = () => {};
  const options = { printErr, locateFile: name => name, wasmBinary: new Uint8Array([99]) };
  const result = await load(options);
  assert.deepEqual(result.wasmBinary, new Uint8Array(wasm));
  assert.equal(result.printErr, printErr);
  assert.equal(result.locateFile, options.locateFile);
  assert.deepEqual(options.wasmBinary, new Uint8Array([99]));
  assert.equal(state.calls(), 1);
  assert.equal(state.requests[0].href, pathToFileURL(path.join(root, 'encrypted.bin')).href);
  assert.equal(encrypted.ciphertext.byteLength, gzipSync(wasm, { level: 9 }).byteLength + 16);
  assert.notDeepEqual(encrypted.ciphertext.subarray(0, wasm.byteLength), wasm);
});

test('generated engine factory also accepts no options', async t => {
  const encrypted = encryptEngine(wasm, paths);
  const state = runtime(t, () => new Response(encrypted.ciphertext));
  const { load } = await fixture(t, encrypted.loaderSource);
  assert.deepEqual((await load()).wasmBinary, new Uint8Array(wasm));
  assert.equal(state.calls(), 1);
});

test('ciphertext and authentication tag mutations reject before calling core', async t => {
  const encrypted = encryptEngine(wasm, paths);
  let bytes = Buffer.from(encrypted.ciphertext);
  const state = runtime(t, () => new Response(bytes));
  const { load } = await fixture(t, encrypted.loaderSource);
  for (const index of [0, encrypted.ciphertext.length - 1]) {
    bytes = Buffer.from(encrypted.ciphertext);
    bytes[index] ^= 1;
    await assert.rejects(load(), { name: 'OperationError' });
    assert.equal(state.calls(), 0);
  }
});

test('wrong key, nonce or authenticated context reject before calling core', async t => {
  const encrypted = encryptEngine(wasm, paths);
  const state = runtime(t, () => new Response(encrypted.ciphertext));
  for (const field of ['keyBytes', 'iv']) {
    const changed = encrypted.loaderSource.replace(new RegExp(`const ${field} = Uint8Array\\.from\\(\\[([0-9]+)`),
      (_, byte) => `const ${field} = Uint8Array.from([${Number(byte) ^ 1}`);
    assert.notEqual(changed, encrypted.loaderSource);
    const { load } = await fixture(t, changed);
    await assert.rejects(load(), { name: 'OperationError' });
  }
  const changed = encrypted.loaderSource.replace('my-video-engine-v1', 'my-video-engine-v2');
  const { load } = await fixture(t, changed);
  await assert.rejects(load(), { name: 'OperationError' });
  assert.equal(state.calls(), 0);
});

test('HTTP errors, size mismatch and oversized streams reject before calling core', async t => {
  const encrypted = encryptEngine(wasm, paths);
  let response;
  const state = runtime(t, () => response);
  const { load } = await fixture(t, encrypted.loaderSource);
  response = new Response('missing', { status: 404 });
  await assert.rejects(load(), /request failed \(404\)/);
  response = new Response(encrypted.ciphertext, { headers: { 'content-length': '999999999' } });
  await assert.rejects(load(), /invalid size/);
  response = new Response(encrypted.ciphertext, { headers: { 'content-length': 'invalid' } });
  await assert.rejects(load(), /invalid size/);
  response = new Response(encrypted.ciphertext.subarray(1));
  await assert.rejects(load(), /invalid size/);
  response = new Response(null);
  await assert.rejects(load(), /no body/);
  let cancelled = false;
  response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(encrypted.ciphertext.length + 1));
    },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(load(), /invalid size/);
  assert.equal(cancelled, true);
  assert.equal(state.calls(), 0);
});

test('streamed responses reconstruct the ciphertext across arbitrary chunk boundaries', async t => {
  const encrypted = encryptEngine(wasm, paths);
  runtime(t, () => new Response(new ReadableStream({
    start(controller) {
      for (const byte of encrypted.ciphertext) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  })));
  const { load } = await fixture(t, encrypted.loaderSource);
  assert.deepEqual((await load()).wasmBinary, new Uint8Array(wasm));
});

test('gzip reduces repetitive engine bytes before encryption and decompresses exactly', async t => {
  const engine = Buffer.alloc(1024 * 1024, 97);
  const encrypted = encryptEngine(engine, paths);
  runtime(t, () => new Response(encrypted.ciphertext));
  const { load } = await fixture(t, encrypted.loaderSource);
  assert.equal(encrypted.metadataNoKey.compression, 'gzip');
  assert.equal(encrypted.metadataNoKey.plaintextBytes, engine.byteLength);
  assert.equal(encrypted.metadataNoKey.compressedBytes, encrypted.ciphertext.byteLength - 16);
  assert(encrypted.ciphertext.byteLength < engine.byteLength / 100);
  assert.deepEqual((await load()).wasmBinary, new Uint8Array(engine));
});

test('decompressed output must fit the exact expected size before calling core', async t => {
  const encrypted = encryptEngine(Buffer.alloc(256 * 1024, 97), paths);
  const state = runtime(t, () => new Response(encrypted.ciphertext));
  for (const expectedSize of [8, encrypted.metadataNoKey.plaintextBytes + 1]) {
    // Change only the decompression bound; the encrypted gzip bytes and AAD stay valid.
    const source = encrypted.loaderSource.replace(/const plaintextBytes = \d+;/, `const plaintextBytes = ${expectedSize};`);
    assert.notEqual(source, encrypted.loaderSource);
    const { load } = await fixture(t, source);
    await assert.rejects(load(), /Decompressed engine has an invalid size/);
  }
  assert.equal(state.calls(), 0);
});

test('each encryption gets independent random key and nonce and emits no key in metadata', () => {
  const first = encryptEngine(wasm, paths);
  const second = encryptEngine(wasm, paths);
  assert.notDeepEqual(first.ciphertext, second.ciphertext);
  assert.notEqual(first.metadataNoKey.iv, second.metadataNoKey.iv);
  const keyPattern = /const keyBytes = Uint8Array\.from\((\[[^\]]+\])/;
  const firstKey = JSON.parse(first.loaderSource.match(keyPattern)[1]);
  const secondKey = JSON.parse(second.loaderSource.match(keyPattern)[1]);
  assert.equal(firstKey.length, 32);
  assert.notDeepEqual(firstKey, secondKey);
  assert.deepEqual(Object.keys(first.metadataNoKey).sort(), [
    'algorithm', 'cipherPath', 'ciphertextBytes', 'clientKeyEmbedded', 'compressedBytes', 'compression', 'coreModulePath', 'format', 'iv', 'plaintextBytes', 'tagBits',
  ]);
  assert.equal(first.metadataNoKey.clientKeyEmbedded, true);
  assert(!JSON.stringify(first.metadataNoKey).includes(JSON.stringify(firstKey)));
  assert(!/\beval\s*\(|new\s+Function\b|unsafe-eval|unsafe-inline/.test(first.loaderSource));
});

test('encryptEngine validates engine size and relative packaged asset paths', () => {
  assert.throws(() => encryptEngine('not bytes', paths), /Uint8Array/);
  assert.throws(() => encryptEngine(new Uint8Array(), paths), /Engine size/);
  assert.throws(() => encryptEngine(new Uint8Array(64 * 1024 * 1024 + 1), paths), /Engine size/);
  for (const value of ['/absolute', 'https://example.test/asset', 'asset', './asset?query', './asset#hash', './bad\\asset']) {
    for (const field of ['cipherPath', 'coreModulePath']) {
      assert.throws(() => encryptEngine(wasm, { ...paths, [field]: value }), /relative asset path/);
    }
  }
});
