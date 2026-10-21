import { safeBasename } from '../upscale/policy.ts';
import { mediaURL } from './model.ts';
const MIME_BY_EXTENSION = {
  mp4: 'video/mp4', m4a: 'audio/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', mp3: 'audio/mpeg', aac: 'audio/aac',
} as const;
export interface MediaFileFormat { mime: string; extension: keyof typeof MIME_BY_EXTENSION; }
export class InvalidMediaFileError extends Error {
  constructor() { super('실제 영상·오디오 파일이 아닙니다. HTML·텍스트·이미지 대신 원본 미디어 주소를 사용하세요.'); this.name = 'InvalidMediaFileError'; }
}
export function isMediaFileFormat(value: unknown): value is MediaFileFormat {
  if (!value || typeof value !== 'object') return false;
  const actual = value as Partial<MediaFileFormat>;
  return typeof actual.extension === 'string' && Object.hasOwn(MIME_BY_EXTENSION, actual.extension)
    && (actual.mime === MIME_BY_EXTENSION[actual.extension] || (actual.extension === 'ogg' && actual.mime === 'video/ogg'));
}
function format(extension: MediaFileFormat['extension']): MediaFileFormat { return { mime: MIME_BY_EXTENSION[extension], extension }; }
function ascii(bytes: Uint8Array, offset: number, length: number): string { return String.fromCharCode(...bytes.subarray(offset, offset + length)); }
function uint32(bytes: Uint8Array, offset: number, little = false): number { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, little); }
function vint(bytes: Uint8Array, offset: number): { value: number; length: number } | undefined {
  const first = bytes[offset]; if (first === undefined || first === 0) return undefined;
  let length = 1, marker = 0x80;
  while (!(first & marker)) { length++; marker >>= 1; }
  if (offset + length > bytes.length) return undefined;
  let value = first & (marker - 1);
  for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i]!;
  return Number.isSafeInteger(value) ? { value, length } : undefined;
}
function ebmlFormat(bytes: Uint8Array): MediaFileFormat | undefined {
  if (bytes.length < 5 || uint32(bytes, 0) !== 0x1a45dfa3) return undefined;
  const header = vint(bytes, 4); if (!header) return undefined;
  const end = 4 + header.length + header.value; if (end > bytes.length) return undefined;
  for (let offset = 4 + header.length; offset < end;) {
    const id = vint(bytes, offset); if (!id || id.length > 4) return undefined;
    const idText = ascii(bytes, offset, id.length); offset += id.length;
    const size = vint(bytes, offset); if (!size) return undefined; offset += size.length;
    if (offset + size.value > end) return undefined;
    if (idText === '\x42\x82') {
      const type = ascii(bytes, offset, size.value);
      return type === 'webm' ? format('webm') : type === 'matroska' ? format('mkv') : undefined;
    }
    offset += size.value;
  }
  return undefined;
}
const IMAGE_BRANDS = new Set(['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'miaf', 'MA1A', 'MA1B']);
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'avc1', 'dash', 'MSNV', 'M4V ', 'M4VH', 'M4VP', 'F4V ']);
const AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ']);
function isoFormat(bytes: Uint8Array): MediaFileFormat | undefined {
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const size = uint32(bytes, offset), type = ascii(bytes, offset + 4, 4);
    if (type === 'ftyp') {
      if (size < 16 || size % 4 !== 0 || offset + size > bytes.length) return undefined;
      const brands = [ascii(bytes, offset + 8, 4)];
      for (let i = offset + 16; i < offset + size; i += 4) brands.push(ascii(bytes, i, 4));
      if (brands.some(brand => IMAGE_BRANDS.has(brand))) return undefined;
      if (brands[0] === 'qt  ') return format('mov');
      if (AUDIO_BRANDS.has(brands[0]!)) return format('m4a');
      if (brands.some(brand => MP4_BRANDS.has(brand))) return format('mp4');
      return undefined;
    }
    if (type === 'moov' && size >= 16 && offset + 16 <= bytes.length) {
      const childSize = uint32(bytes, offset + 8), childType = ascii(bytes, offset + 12, 4);
      if (childSize >= 8 && childSize <= size - 8 && ['mvhd', 'trak', 'udta', 'cmov'].includes(childType)) return format('mov');
    }
    if (!['free', 'skip', 'wide'].includes(type) || size < 8 || offset + size > bytes.length) return undefined;
    offset += size;
  }
  return undefined;
}
function mp3Header(bytes: Uint8Array, offset: number): boolean {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff) return false;
  const second = bytes[offset + 1]!, third = bytes[offset + 2]!, fourth = bytes[offset + 3]!;
  return (second & 0xe0) === 0xe0 && ((second >> 3) & 3) !== 1 && ((second >> 1) & 3) === 1
    && (third >> 4) > 0 && (third >> 4) < 15 && ((third >> 2) & 3) < 3 && (fourth & 3) !== 2;
}
// Classify actual container/frame headers; HTTP MIME and URL suffixes are ignored.
export function inspectMediaFile(input: Uint8Array): MediaFileFormat {
  const bytes = input.subarray(0, 65_536);
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && uint32(bytes, 4, true) >= 4) {
    if (ascii(bytes, 8, 4) === 'WAVE') return format('wav');
    if (ascii(bytes, 8, 4) === 'AVI ') return format('avi');
  }
  const iso = isoFormat(bytes); if (iso) return iso;
  const ebml = ebmlFormat(bytes); if (ebml) return ebml;
  if (bytes.length >= 28 && ascii(bytes, 0, 4) === 'OggS' && bytes[4] === 0 && bytes[26]! > 0) {
    const segments = bytes[26]!, body = 27 + segments; let packet = 0;
    for (let i = 27; i < body && i < bytes.length; i++) { packet += bytes[i]!; if (bytes[i] !== 255) break; }
    if (packet > 0 && body + packet <= bytes.length) {
      if (ascii(bytes, body, 7) === '\x80theora') return { mime: 'video/ogg', extension: 'ogg' };
      if (ascii(bytes, body, 7) === '\x01vorbis' || ascii(bytes, body, 8) === 'OpusHead' || ascii(bytes, body, 5) === '\x7fFLAC' || ascii(bytes, body, 8) === 'Speex   ') return format('ogg');
    }
  }
  if (bytes.length >= 42 && ascii(bytes, 0, 4) === 'fLaC' && (bytes[4]! & 0x7f) === 0 && bytes[5] === 0 && bytes[6] === 0 && bytes[7] === 34) return format('flac');
  let audioOffset = 0;
  if (bytes.length >= 10 && ascii(bytes, 0, 3) === 'ID3') {
    if (![2, 3, 4].includes(bytes[3]!) || bytes[4] === 0xff || bytes.subarray(6, 10).some(value => value >= 128)) throw new InvalidMediaFileError();
    audioOffset = 10 + bytes[6]! * 2 ** 21 + bytes[7]! * 2 ** 14 + bytes[8]! * 128 + bytes[9]!;
    if (bytes[3] === 4 && (bytes[5]! & 0x10)) audioOffset += 10;
  }
  // Album artwork can place the first MP3 frame beyond the signature prefix.
  if (mp3Header(input, audioOffset)) return format('mp3');
  if (bytes.length >= 7 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0 && ((bytes[2]! >> 2) & 15) < 13) {
    const length = (bytes[3]! & 3) * 2048 + bytes[4]! * 8 + (bytes[5]! >> 5);
    if (length >= ((bytes[1]! & 1) ? 7 : 9)) return format('aac');
  }
  throw new InvalidMediaFileError();
}
export function mediaFilename(old: string, actual: MediaFileFormat): string {
  if (!isMediaFileFormat(actual)) throw new InvalidMediaFileError();
  let base = safeBasename(old).replace(/\.[^.]+$/, '').replace(/(?:\.(?:txt|text))+$/i, '').replace(/[. ]+$/g, '') || 'media';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  return `${base.slice(0, 174)}.${actual.extension}`;
}
export interface MediaProbeOptions { fetch?: typeof globalThis.fetch; timeoutMs?: number; }
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new DOMException('작업을 취소했습니다.', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
// A bounded signature request; the later native URL download is a separate request.
export async function probeMediaFile(url: string, signal?: AbortSignal, options: MediaProbeOptions = {}): Promise<MediaFileFormat> {
  const controller = new AbortController();
  const timeoutMs = Math.min(15_000, Math.max(1, Number.isFinite(options.timeoutMs) ? options.timeoutMs! : 15_000));
  const timer = setTimeout(() => controller.abort(new Error('미디어 파일 확인 시간이 초과되었습니다.')), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const prefix = new Uint8Array(65_536);
  try {
    combined.throwIfAborted();
    const request = (options.fetch ?? globalThis.fetch)(mediaURL(url).href, {
      method: 'GET', headers: { Range: 'bytes=0-65535' }, credentials: 'include', redirect: 'follow', signal: combined,
    }).then(value => {
      if (combined.aborted) { if (value.body) void value.body.cancel().catch(() => {}); combined.throwIfAborted(); }
      return value;
    });
    response = await abortable(request, combined); combined.throwIfAborted();
    if (!response.ok || ![200, 206].includes(response.status)) throw new Error(`미디어 확인 요청 실패 (${response.status})`);
    if (response.url) mediaURL(response.url);
    if (response.status === 206) {
      const range = response.headers.get('Content-Range')?.match(/^bytes 0-(\d+)\/(\d+|\*)$/i);
      if (!range || Number(range[1]) > 65_535 || (range[2] !== '*' && Number(range[2]) <= Number(range[1]))) throw new Error('서버가 잘못된 미디어 확인 범위를 반환했습니다.');
      const encoding = response.headers.get('Content-Encoding');
      if (encoding && encoding.toLowerCase() !== 'identity') throw new Error('압축된 미디어 확인 범위는 지원하지 않습니다.');
    }
    if (!response.body) throw new InvalidMediaFileError();
    reader = response.body.getReader(); let used = 0;
    while (used < prefix.length) {
      const chunk = await abortable(reader.read(), combined); combined.throwIfAborted(); if (chunk.done) break;
      const take = Math.min(chunk.value.length, prefix.length - used); prefix.set(chunk.value.subarray(0, take), used); used += take;
    }
    return inspectMediaFile(prefix.subarray(0, used));
  } finally {
    clearTimeout(timer); controller.abort();
    if (reader) void reader.cancel().catch(() => {}); else if (response?.body) void response.body.cancel().catch(() => {});
  }
}
