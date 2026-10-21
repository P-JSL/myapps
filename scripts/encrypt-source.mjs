import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  decryptSourceArchive, encryptSourceArchive, MAX_ARCHIVE_BYTES, MAX_ENVELOPE_BYTES, MAX_PASSWORD_BYTES,
} from './lib/encryption.mjs';

const HELP = `Optional source ZIP encryption (Node standard-library crypto).

Usage:
  node scripts/encrypt-source.mjs encrypt --input source.zip --output source.zip.enc --password-stdin
  node scripts/encrypt-source.mjs decrypt --input source.zip.enc --output restored.zip --password-env SOURCE_ARCHIVE_PASSWORD

Commands: encrypt, decrypt
Options:
  --input PATH          Existing regular input file (symlinks are rejected).
  --output PATH         New output file; its parent directory must exist.
  --password-stdin      Read a piped password until EOF (the default).
  --password-env NAME   Read a password from the named environment variable.
  --help, -h            Show this help.

Passwords never appear in command arguments or output. Supply exactly one
password source. Stdin removes one final LF or CRLF; environment values are exact.
Use a strong, unique password stored separately; losing it prevents recovery.
Maximum archive: 32 MiB. Maximum password: 4096 UTF-8 bytes. Output permissions:
0600 (where supported). Existing output is never replaced, including symlinks.
The versioned envelope uses AES-256-GCM and scrypt (N=131072, r=8, p=1),
a fresh 16-byte salt and 12-byte nonce, and an authenticated header.
This encrypts a private source ZIP only; it does not encrypt extension runtime JS.
`;

function options(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const [command, ...flags] = args;
  if (!['encrypt', 'decrypt'].includes(command)) throw new Error('Expected encrypt or decrypt. Use --help for usage.');
  if (flags.length === 1 && ['--help', '-h'].includes(flags[0])) return { help: true };
  const result = { command };
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === '--password-stdin') {
      if (result.passwordSource) throw new Error('Specify only one password source.');
      result.passwordSource = 'stdin';
    } else if (['--input', '--output', '--password-env'].includes(flag)) {
      const value = flags[++index];
      if (!value || value.startsWith('--')) throw new Error('An option is missing its value.');
      const key = flag.slice(2);
      if (Object.hasOwn(result, key)) throw new Error('Repeated option.');
      result[key] = value;
      if (flag === '--password-env') {
        if (result.passwordSource) throw new Error('Specify only one password source.');
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('Invalid password environment-variable name.');
        result.passwordSource = 'environment';
      }
    } else throw new Error('Unknown option. Password values must use stdin or an environment variable.');
  }
  if (!result.input || !result.output) throw new Error('Both --input and --output are required.');
  return result;
}

async function readPassword(settings) {
  if (settings['password-env']) {
    const value = process.env[settings['password-env']];
    if (value === undefined) throw new Error('The password environment variable is not set.');
    if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) throw new Error('Password exceeds the size limit.');
    if (value.length === 0) throw new Error('Password must not be empty.');
    return Buffer.from(value, 'utf8');
  }
  if (process.stdin.isTTY) throw new Error('Password stdin must be piped; interactive input is not supported.');
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > MAX_PASSWORD_BYTES + 2) throw new Error('Password exceeds the size limit.');
      chunks.push(chunk);
    }
    const password = Buffer.concat(chunks);
    let end = password.length;
    if (password[end - 1] === 10) {
      end--;
      if (password[end - 1] === 13) end--;
    }
    if (end === 0 || end > MAX_PASSWORD_BYTES) {
      password.fill(0);
      throw new Error(end === 0 ? 'Password must not be empty.' : 'Password exceeds the size limit.');
    }
    const secret = Buffer.from(password.subarray(0, end));
    password.fill(0);
    return secret;
  } finally { for (const chunk of chunks) chunk.fill(0); }
}

async function readBoundedFile(filename, maximum) {
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Input must be a regular file, not a symlink.');
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) throw new Error('Input changed while it was being opened.');
    if (info.size > maximum) throw new Error('Input exceeds the size limit.');
    const data = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await file.read(data, length, data.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== info.size) {
      data.fill(0);
      throw new Error('Input changed while it was being read.');
    }
    return data.subarray(0, length);
  } finally { await file.close(); }
}

// A hard link publishes the completed file atomically and fails if the output
// already exists. Unlike rename(), it cannot replace a file created concurrently.
async function writeNewFile(filename, data) {
  const output = path.resolve(filename);
  const temporary = path.join(path.dirname(output), `.${path.basename(output)}.${randomBytes(16).toString('hex')}.tmp`);
  let file, created = false;
  try {
    file = await open(temporary, 'wx', 0o600);
    created = true;
    await file.writeFile(data);
    await file.sync();
    await file.close();
    file = undefined;
    await link(temporary, output);
  } finally {
    try { await file?.close(); }
    finally { if (created) await unlink(temporary); }
  }
}

export async function main(args = process.argv.slice(2)) {
  const settings = options(args);
  if (settings.help) { process.stdout.write(HELP); return; }
  const data = await readBoundedFile(settings.input, settings.command === 'encrypt' ? MAX_ARCHIVE_BYTES : MAX_ENVELOPE_BYTES);
  let password, output;
  try {
    password = await readPassword(settings);
    output = await (settings.command === 'encrypt' ? encryptSourceArchive : decryptSourceArchive)(data, password);
    await writeNewFile(settings.output, output);
    process.stdout.write(settings.command === 'encrypt' ? 'Encrypted source archive written.\n' : 'Source archive restored.\n');
  } finally {
    data.fill(0);
    password?.fill(0);
    output?.fill(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`Source archive operation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
