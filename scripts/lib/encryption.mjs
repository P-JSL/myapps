import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const MAX_PASSWORD_BYTES = 4096;

// Version 1: magic[8], version/u8, cipher/u8, KDF/u8, reserved/u8,
// scrypt N/u32be, r/u32be, p/u32be, ciphertext length/u32be,
// salt[16], nonce[12], ciphertext[length], GCM tag[16].
// The complete 56-byte header is authenticated as GCM additional data.
// Parameters are fixed and checked before deriving a key; envelope bytes cannot
// request arbitrary memory/CPU use. ZIP compression belongs before encryption.
const MAGIC = Buffer.from('MVSRCENC', 'ascii');
const HEADER_BYTES = 56;
const TAG_BYTES = 16;
const SALT_OFFSET = 28;
const NONCE_OFFSET = 44;
const SCRYPT_N = 131072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const derive = promisify(scrypt);

export const MAX_ENVELOPE_BYTES = MAX_ARCHIVE_BYTES + HEADER_BYTES + TAG_BYTES;

function bytes(value, maximum, label) {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be a Uint8Array.`);
  if (value.byteLength > maximum) throw new RangeError(`${label} exceeds the size limit.`);
  return Buffer.from(value);
}

function passwordBytes(value) {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) throw new RangeError('Password exceeds the size limit.');
    value = Buffer.from(value, 'utf8');
  } else value = bytes(value, MAX_PASSWORD_BYTES, 'Password');
  if (value.length === 0) throw new TypeError('Password must not be empty.');
  return value;
}

async function deriveKey(password, salt) {
  try {
    return await derive(password, salt, 32, {
      N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * 1024 * 1024,
    });
  } finally { password.fill(0); }
}

function headerFor(length) {
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header);
  header[8] = 1; // Envelope version.
  header[9] = 1; // AES-256-GCM.
  header[10] = 1; // scrypt.
  header.writeUInt32BE(SCRYPT_N, 12);
  header.writeUInt32BE(SCRYPT_R, 16);
  header.writeUInt32BE(SCRYPT_P, 20);
  header.writeUInt32BE(length, 24);
  randomBytes(16).copy(header, SALT_OFFSET);
  randomBytes(12).copy(header, NONCE_OFFSET);
  return header;
}

function checkHeader(envelope) {
  if (envelope.length < HEADER_BYTES + TAG_BYTES) throw new Error('Invalid or truncated encrypted archive.');
  if (!envelope.subarray(0, 8).equals(MAGIC)
    || envelope[8] !== 1 || envelope[9] !== 1 || envelope[10] !== 1 || envelope[11] !== 0
    || envelope.readUInt32BE(12) !== SCRYPT_N || envelope.readUInt32BE(16) !== SCRYPT_R
    || envelope.readUInt32BE(20) !== SCRYPT_P) throw new Error('Unsupported encrypted archive header.');
  const length = envelope.readUInt32BE(24);
  if (length > MAX_ARCHIVE_BYTES || envelope.length !== HEADER_BYTES + length + TAG_BYTES) {
    throw new Error('Invalid encrypted archive length.');
  }
  return length;
}

/** Encrypt already-compressed archive bytes with a fresh salt and nonce.
 * Passwords are nonempty UTF-8 strings or exact byte arrays (no normalization).
 * Returns a versioned binary envelope. The password/key are never serialized.
 */
export async function encryptSourceArchive(archive, password) {
  const plaintext = bytes(archive, MAX_ARCHIVE_BYTES, 'Archive');
  let key;
  try {
    const secret = passwordBytes(password);
    const header = headerFor(plaintext.length);
    key = await deriveKey(secret, header.subarray(SALT_OFFSET, NONCE_OFFSET));
    const cipher = createCipheriv('aes-256-gcm', key, header.subarray(NONCE_OFFSET), { authTagLength: TAG_BYTES });
    cipher.setAAD(header);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
  } finally {
    key?.fill(0);
    plaintext.fill(0);
  }
}

/** Authenticate an entire envelope before returning any restored archive bytes.
 * Wrong passwords, changed bytes, unsupported parameters and lengths reject.
 */
export async function decryptSourceArchive(encrypted, password) {
  const envelope = bytes(encrypted, MAX_ENVELOPE_BYTES, 'Encrypted archive');
  const length = checkHeader(envelope);
  const secret = passwordBytes(password);
  let key, plaintext, final;
  try {
    key = await deriveKey(secret, envelope.subarray(SALT_OFFSET, NONCE_OFFSET));
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(NONCE_OFFSET, HEADER_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(envelope.subarray(0, HEADER_BYTES));
    decipher.setAuthTag(envelope.subarray(HEADER_BYTES + length));
    try {
      plaintext = decipher.update(envelope.subarray(HEADER_BYTES, HEADER_BYTES + length));
      final = decipher.final();
      return Buffer.concat([plaintext, final]);
    } catch {
      throw new Error('Authentication failed: incorrect password or modified archive.');
    }
  } finally {
    key?.fill(0);
    plaintext?.fill(0);
    final?.fill(0);
  }
}
