export const MAX_INPUT_BYTES = 256 * 1024 * 1024;
export const MAX_QUEUE_BYTES = 512 * 1024 * 1024;
export const MAX_JOBS = 4;
export const MAX_OUTPUT_PIXELS = 16_777_216;
export const MAX_EDGE = 8192;
export const MAX_DURATION = 600;
export const MAX_RUNTIME_MS = 300_000;
export const RETENTION_MS = 24 * 60 * 60 * 1000;
export const DIRECTORY = 'vdh-upscale-v1';
export const JOBS_KEY = 'vdh_upscale_jobs_v1';
export const OFFER_KEY = 'vdh_upscale_offer_v1';
export type Factor = 2 | 4;
export interface MediaInfo { width: number; height: number; duration: number; kind: 'image' | 'video'; }
export interface Job { id: string; filename: string; size: number; createdAt: number; downloadId?: number; }

export function isJobId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
export function isJob(value: unknown): value is Job {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<Job>;
  return isJobId(v.id) && typeof v.filename === 'string' && v.filename.length <= 240
    && Number.isSafeInteger(v.size) && v.size! > 0 && v.size! <= MAX_INPUT_BYTES
    && typeof v.createdAt === 'number' && Number.isFinite(v.createdAt)
    && (v.downloadId === undefined || (Number.isSafeInteger(v.downloadId) && v.downloadId >= 0));
}
export function outputDimensions(info: MediaInfo, factor: unknown): { width: number; height: number } {
  if (factor !== 2 && factor !== 4) throw new Error('확대 배율은 2배 또는 4배여야 합니다.');
  if (!Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width < 1 || info.height < 1) throw new Error('영상 크기를 읽을 수 없습니다.');
  if (info.kind === 'video' && (!Number.isFinite(info.duration) || info.duration <= 0 || info.duration > MAX_DURATION)) throw new Error('최대 10분 길이의 동영상만 처리할 수 있습니다.');
  let width = info.width * factor;
  let height = info.height * factor;
  if (info.kind === 'video') { width += width % 2; height += height % 2; }
  if (width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_OUTPUT_PIXELS) throw new Error('확대 결과는 한 변 8,192픽셀, 전체 1,677만 픽셀 이하여야 합니다.');
  return { width, height };
}
export function safeBasename(input: string): string {
  return (input.split(/[\\/]/).at(-1) ?? 'media').replace(/[\x00-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '_').replace(/[. ]+$/g, '').slice(0, 180) || 'media';
}
export function outputName(filename: string, factor: Factor, kind: MediaInfo['kind']): string {
  const base = safeBasename(filename).replace(/\.[^.]+$/, '') || 'media';
  return `${base}-${factor}x.${kind === 'video' ? 'mp4' : 'png'}`;
}
/** Reject playlists, SVG/HTML and non-media before invoking a decoder. */
export function sniffMedia(bytes: Uint8Array): 'image' | 'video' | undefined {
  const ascii = (start: number, count: number) => String.fromCharCode(...bytes.subarray(start, start + count));
  if (bytes[0] === 0x89 && ascii(1, 3) === 'PNG' && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return 'image';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image';
  if (ascii(4, 4) === 'ftyp' || (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'AVI ')) return 'video';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video';
  return undefined;
}
export function ffmpegArguments(info: MediaInfo, factor: Factor): string[] {
  const { width, height } = outputDimensions(info, factor);
  const args = ['-hide_banner', '-nostdin', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe', '-i', 'input.media', '-map', '0:v:0', '-vf', `scale=${width}:${height}:flags=lanczos`, '-threads', '1'];
  if (info.kind === 'image') args.push('-frames:v', '1', '-c:v', 'png', '-fs', String(MAX_INPUT_BYTES), '-y', 'output.png');
  else args.push('-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-fs', String(MAX_INPUT_BYTES), '-y', 'output.mp4');
  return args;
}
