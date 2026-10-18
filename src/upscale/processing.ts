import { record } from '../security/validation.ts';
import { MAX_DURATION, MAX_EDGE, MAX_INPUT_BYTES, MAX_OUTPUT_PIXELS, ffmpegArguments, outputName, safeBasename, sniffMedia, type Factor, type MediaInfo } from './policy.ts';
import { QUALITIES, type Quality } from '../local/preferences.ts';

export type VideoFormat = 'mp4' | 'webm' | 'mkv';
export type AudioFormat = 'mp3' | 'm4a' | 'wav';
export type ProcessingOptions = { mode: 'upscale'; factor: Factor }
  | { mode: 'convert'; format: VideoFormat; quality: Quality }
  | { mode: 'audio'; format: AudioFormat }
  | { mode: 'merge'; format: 'mp4' | 'mkv' };
export interface TrackInfo { width: number; height: number; duration: number; video: boolean; audio: boolean; kind: 'image' | 'video' | 'audio'; }
export function processingOptions(value: unknown): ProcessingOptions {
  if (!record(value)) throw new Error('처리 설정이 올바르지 않습니다.');
  if (value.mode === 'upscale' && (value.factor === 2 || value.factor === 4)) return { mode: 'upscale', factor: value.factor };
  if (value.mode === 'convert' && ['mp4', 'webm', 'mkv'].includes(String(value.format)) && QUALITIES.includes(value.quality as Quality)) return { mode: 'convert', format: value.format as VideoFormat, quality: value.quality as Quality };
  if (value.mode === 'audio' && ['mp3', 'm4a', 'wav'].includes(String(value.format))) return { mode: 'audio', format: value.format as AudioFormat };
  if (value.mode === 'merge' && ['mp4', 'mkv'].includes(String(value.format))) return { mode: 'merge', format: value.format as 'mp4' | 'mkv' };
  throw new Error('지원하지 않는 처리 설정입니다.');
}
export function sniffInput(bytes: Uint8Array): TrackInfo['kind'] | undefined {
  const visual = sniffMedia(bytes); if (visual) return visual;
  const ascii = (start: number, count: number) => String.fromCharCode(...bytes.subarray(start, start + count));
  if (ascii(0, 3) === 'ID3' || ascii(0, 4) === 'fLaC' || ascii(0, 4) === 'OggS'
    || (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return 'audio';
  return undefined;
}
export function validateTrack(info: TrackInfo, options: ProcessingOptions) {
  if (options.mode === 'upscale') return;
  if (!Number.isFinite(info.duration) || info.duration <= 0 || info.duration > MAX_DURATION) throw new Error('최대 10분 길이의 미디어만 처리할 수 있습니다.');
  if (options.mode === 'audio') { if (!info.audio) throw new Error('저장할 오디오 트랙이 없습니다.'); return; }
  if (!info.video || info.kind === 'image') throw new Error('영상 트랙이 있는 동영상 파일을 선택하세요.');
  if (!Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width < 2 || info.height < 2
    || info.width > MAX_EDGE || info.height > MAX_EDGE || info.width * info.height > MAX_OUTPUT_PIXELS) throw new Error('영상 크기가 안전한 처리 한도를 초과했습니다.');
}
export function convertedDimensions(info: Pick<TrackInfo, 'width' | 'height'>, quality: Quality) {
  const ratio = quality === 'highest' ? 1 : Math.min(1, Number(quality) / info.height);
  return { width: Math.max(2, Math.floor(info.width * ratio / 2) * 2), height: Math.max(2, Math.floor(info.height * ratio / 2) * 2) };
}
export function resultFormat(options: ProcessingOptions, kind: TrackInfo['kind']): VideoFormat | AudioFormat | 'png' {
  return options.mode === 'upscale' ? kind === 'image' ? 'png' : 'mp4' : options.format;
}
export const MIME = { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', png: 'image/png' } as const;
export function processedName(filename: string, options: ProcessingOptions, kind: TrackInfo['kind']): string {
  if (options.mode === 'upscale') return outputName(filename, options.factor, kind === 'image' ? 'image' : 'video');
  let base = safeBasename(filename).replace(/\.[^.]+$/, '') || 'media';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  return `${base}-${options.mode === 'audio' ? 'audio' : options.mode === 'merge' ? 'merged' : 'converted'}.${options.format}`;
}
export function processingArguments(info: TrackInfo, options: ProcessingOptions): string[] {
  if (options.mode === 'upscale') return ffmpegArguments(info as MediaInfo, options.factor);
  validateTrack(info, options);
  const args = ['-hide_banner', '-nostdin', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe', '-i', 'input.media'];
  if (options.mode === 'merge') args.push('-protocol_whitelist', 'file,pipe', '-i', 'audio.media');
  args.push('-threads', '1', '-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn');
  if (options.mode === 'audio') {
    args.push('-map', '0:a:0', '-vn', '-c:a', options.format === 'mp3' ? 'libmp3lame' : options.format === 'm4a' ? 'aac' : 'pcm_s16le');
    if (options.format !== 'wav') args.push('-b:a', '192k');
  } else if (options.mode === 'merge') args.push('-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest');
  else {
    const dimensions = convertedDimensions(info, options.quality);
    args.push('-map', '0:v:0', '-map', '0:a:0?', '-vf', `scale=${dimensions.width}:${dimensions.height}:flags=lanczos`, '-pix_fmt', 'yuv420p');
    if (options.format === 'webm') args.push('-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '4', '-crf', '10', '-b:v', '4M', '-c:a', 'libopus', '-b:a', '192k');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k');
  }
  if (options.format === 'mp4' || options.format === 'm4a') args.push('-movflags', '+faststart');
  args.push('-fs', String(MAX_INPUT_BYTES), '-y', `output.${options.format}`);
  return args;
}
