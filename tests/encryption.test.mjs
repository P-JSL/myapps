import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  decryptSourceArchive, encryptSourceArchive, MAX_ARCHIVE_BYTES, MAX_ENVELOPE_BYTES, MAX_PASSWORD_BYTES,
} from '../scripts/lib/encryption.mjs';

const cli = fileURLToPath(new URL('../scripts/encrypt-source.mjs', import.meta.url));
const password = randomBytes(32).toString('base64');

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'my-video-encryption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function run(args, input = '', extraEnvironment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...extraEnvironment }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('versioned encryption round-trips empty and binary archive bytes without mutating caller buffers', async () => {
  for (const archive of [Buffer.alloc(0), Buffer.from([0, 255, 1, 128]), randomBytes(400_000)]) {
    const original = Buffer.from(archive);
    const secret = Buffer.from(password);
    const encrypted = await encryptSourceArchive(archive, secret);
    assert.equal(encrypted.subarray(0, 8).toString('ascii'), 'MVSRCENC');
    assert.equal(encrypted[8], 1);
    assert.equal(encrypted.length, archive.length + 72);
    assert.deepEqual(await decryptSourceArchive(encrypted, secret), original);
    assert.deepEqual(archive, original);
    assert.equal(secret.toString(), password);
  }
});

test('each encryption uses a fresh salt and nonce even for identical input and password', async () => {
  const archive = Buffer.from('PK\x03\x04 source ZIP fixture');
  const first = await encryptSourceArchive(archive, password);
  const second = await encryptSourceArchive(archive, password);
  assert.notDeepEqual(first.subarray(28, 44), second.subarray(28, 44));
  assert.notDeepEqual(first.subarray(44, 56), second.subarray(44, 56));
  assert.notDeepEqual(first.subarray(56), second.subarray(56));
  assert(!first.includes(Buffer.from(password)));
});

test('wrong passwords and modified salt, nonce, ciphertext or tag fail authentication', async () => {
  const encrypted = await encryptSourceArchive(Buffer.from('private source archive'), password);
  await assert.rejects(decryptSourceArchive(encrypted, `${password}wrong`), /Authentication failed/);
  for (const offset of [28, 44, 56, encrypted.length - 1]) {
    const modified = Buffer.from(encrypted);
    modified[offset] ^= 1;
    await assert.rejects(decryptSourceArchive(modified, password), /Authentication failed/);
  }
});

test('unsupported headers, attacker-selected KDF costs, truncation and invalid lengths are rejected', async () => {
  const encrypted = await encryptSourceArchive(Buffer.from('source'), password);
  for (const offset of [0, 8, 9, 10, 11, 12, 16, 20]) {
    const modified = Buffer.from(encrypted);
    modified[offset] ^= 1;
    await assert.rejects(decryptSourceArchive(modified, password), /header/);
  }
  for (const length of [0, 8, 55, 71, encrypted.length - 1]) {
    await assert.rejects(decryptSourceArchive(encrypted.subarray(0, length), password), /Invalid|truncated/);
  }
  await assert.rejects(decryptSourceArchive(Buffer.concat([encrypted, Buffer.from([0])]), password), /length/);
  for (const length of [0, MAX_ARCHIVE_BYTES + 1, 0xffffffff]) {
    const modified = Buffer.from(encrypted);
    modified.writeUInt32BE(length, 24);
    await assert.rejects(decryptSourceArchive(modified, password), /length/);
  }
});

test('API bounds reject oversized archives, envelopes and passwords before cryptography', async () => {
  await assert.rejects(encryptSourceArchive(Buffer.alloc(MAX_ARCHIVE_BYTES + 1), password), /size limit/);
  await assert.rejects(decryptSourceArchive(Buffer.alloc(MAX_ENVELOPE_BYTES + 1), password), /size limit/);
  await assert.rejects(encryptSourceArchive(Buffer.from('source'), ''), /empty/);
  await assert.rejects(encryptSourceArchive(Buffer.from('source'), 'é'.repeat(MAX_PASSWORD_BYTES)), /size limit/);
  await assert.rejects(encryptSourceArchive(Buffer.from('source'), Buffer.alloc(MAX_PASSWORD_BYTES + 1)), /size limit/);
  await assert.rejects(encryptSourceArchive('not bytes', password), /Uint8Array/);
});

test('CLI encrypts piped passwords, decrypts named environment passwords and creates private files', async t => {
  const root = await temporary(t);
  const input = path.join(root, 'source.zip');
  const encrypted = path.join(root, 'source.zip.enc');
  const restored = path.join(root, 'restored.zip');
  const archive = randomBytes(400_000);
  await writeFile(input, archive);
  const result = await run(['encrypt', '--input', input, '--output', encrypted, '--password-stdin'], `${password}\r\n`);
  assert.equal(result.code, 0, result.stderr);
  assert(!result.stdout.includes(password));
  assert(!result.stderr.includes(password));
  const restoredResult = await run(['decrypt', '--input', encrypted, '--output', restored, '--password-env', 'SOURCE_ENCRYPTION_TEST_PASSWORD'], '', { SOURCE_ENCRYPTION_TEST_PASSWORD: password });
  assert.equal(restoredResult.code, 0, restoredResult.stderr);
  assert.deepEqual(await readFile(restored), archive);
  if (process.platform !== 'win32') assert.equal((await stat(restored)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(root)).sort(), ['restored.zip', 'source.zip', 'source.zip.enc']);
});

test('CLI leaves no output or temporary file after incorrect password, tampering or truncation', async t => {
  const root = await temporary(t);
  const input = path.join(root, 'source.zip.enc');
  const output = path.join(root, 'restored.zip');
  const encrypted = await encryptSourceArchive(Buffer.from('private source'), password);
  for (const [archive, secret] of [
    [encrypted, `${password}wrong`],
    [Buffer.from(encrypted), password],
    [encrypted.subarray(0, encrypted.length - 1), password],
  ]) {
    if (archive !== encrypted && archive.length === encrypted.length) archive[56] ^= 1;
    await writeFile(input, archive);
    const result = await run(['decrypt', '--input', input, '--output', output], secret);
    assert.equal(result.code, 1);
    assert(!result.stdout.includes(secret));
    assert(!result.stderr.includes(secret));
    assert.deepEqual(await readdir(root), ['source.zip.enc']);
  }
});

test('CLI never replaces existing files, output symlinks, or its own input', async t => {
  const root = await temporary(t);
  const input = path.join(root, 'source.zip');
  const output = path.join(root, 'existing.enc');
  const alias = path.join(root, 'alias.enc');
  const archive = Buffer.from('original archive bytes');
  await writeFile(input, archive);
  await writeFile(output, 'keep me');
  await symlink(output, alias);
  for (const target of [output, alias, input]) {
    const result = await run(['encrypt', '--input', input, '--output', target], password);
    assert.equal(result.code, 1);
    assert.deepEqual(await readFile(input), archive);
    assert.equal(await readFile(output, 'utf8'), 'keep me');
    assert.deepEqual((await readdir(root)).sort(), ['alias.enc', 'existing.enc', 'source.zip']);
  }
  const encrypted = await encryptSourceArchive(archive, password);
  await writeFile(input, encrypted);
  const rejected = await run(['decrypt', '--input', input, '--output', output], `${password}wrong`);
  assert.equal(rejected.code, 1);
  assert.equal(await readFile(output, 'utf8'), 'keep me');
});

test('CLI enforces input and password limits and rejects unsafe inputs without output', async t => {
  const root = await temporary(t);
  const input = path.join(root, 'source.zip');
  const output = path.join(root, 'encrypted.enc');
  await writeFile(input, 'source');
  for (const secret of ['', '\n', 'a'.repeat(MAX_PASSWORD_BYTES + 3)]) {
    const result = await run(['encrypt', '--input', input, '--output', output], secret);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Password/);
  }
  await truncate(input, MAX_ARCHIVE_BYTES + 1);
  const oversized = await run(['encrypt', '--input', input, '--output', output], password);
  assert.equal(oversized.code, 1);
  assert.match(oversized.stderr, /size limit/);
  await truncate(input, 0);
  const alias = path.join(root, 'source-alias.zip');
  await symlink(input, alias);
  const symlinkResult = await run(['encrypt', '--input', alias, '--output', output], password);
  assert.equal(symlinkResult.code, 1);
  const directoryResult = await run(['encrypt', '--input', root, '--output', output], password);
  assert.equal(directoryResult.code, 1);
  assert.deepEqual((await readdir(root)).sort(), ['source-alias.zip', 'source.zip']);
});

test('CLI help documents password handling and parser never prints unrecognized secret arguments', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--password-stdin/);
  assert.match(help.stdout, /--password-env/);
  const result = await run(['encrypt', '--password', password]);
  assert.equal(result.code, 1);
  assert(!result.stdout.includes(password));
  assert(!result.stderr.includes(password));
  const conflict = await run(['encrypt', '--input', 'unused', '--output', 'unused', '--password-stdin', '--password-env', 'UNUSED']);
  assert.equal(conflict.code, 1);
  assert.match(conflict.stderr, /one password source/);
});
