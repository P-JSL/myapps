import { record } from '../security/validation.ts';
import { blockedDecoder } from '../security/decoder-policy.ts';
import type { FFmpegCore } from '../vendor/ffmpeg/ffmpeg-core.js';
import type { TrackInfo } from './processing.ts';

const MAX_PROBE_BYTES = 256_000;
// Arbitrary container tags are not needed for processing. Excluding them also
// avoids serializing large, attacker-controlled descriptions into MEMFS JSON.
const PROBE_FIELDS = 'stream=codec_type,codec_name,width,height,duration:stream_disposition=attached_pic:format=duration:error=code,string';

export function probeTrack(core: FFmpegCore, filename: string, kind: TrackInfo['kind']): TrackInfo {
  core.reset(); core.setTimeout(15_000);
  const report = 'probe.json';
  let code: number;
  try { code = core.ffprobe('-v', 'error', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe', '-show_error', '-show_entries', PROBE_FIELDS, '-of', 'json', '-o', report, filename); }
  catch { throw new Error('파일 정보를 읽을 수 없습니다.'); }
  // This pinned ffprobe also returns -1 on normal completion; require its fresh report.
  if (code !== 0 && code !== -1) throw new Error('파일 정보를 읽을 수 없습니다.');
  const { size } = core.FS.stat(report);
  try {
    // Check MEMFS length before readFile allocates or decodes its contents.
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PROBE_BYTES) throw new Error('파일 정보가 허용 범위를 초과했습니다.');
    const raw = core.FS.readFile(report, { encoding: 'utf8' });
    if (typeof raw !== 'string' || raw.length > MAX_PROBE_BYTES) throw new Error('파일 정보가 허용 범위를 초과했습니다.');
    const metadata: unknown = JSON.parse(raw);
    if (!record(metadata) || metadata.error || !Array.isArray(metadata.streams)) throw new Error('미디어 정보가 없습니다. 파일이 손상되었거나 지원하지 않는 형식입니다.');
    if (metadata.streams.some((stream: unknown) => record(stream) && blockedDecoder(stream.codec_name))) throw new Error('보안상 제한된 미디어 코덱입니다. JPEG 2000·PNM·MagicYUV·OpenEXR·SANM 계열은 처리하지 않습니다.');
    const video = metadata.streams.find((stream: unknown) => record(stream) && stream.codec_type === 'video' && !(record(stream.disposition) && stream.disposition.attached_pic === 1));
    const audio = metadata.streams.find((stream: unknown) => record(stream) && stream.codec_type === 'audio');
    const format = record(metadata.format) ? metadata.format : {};
    return { width: record(video) ? Number(video.width) : 0, height: record(video) ? Number(video.height) : 0,
      duration: Number(format.duration ?? (record(video) ? video.duration : record(audio) ? audio.duration : 0) ?? 0), video: !!video, audio: !!audio, kind: kind === 'image' ? 'image' : video ? 'video' : 'audio' };
  } finally { core.FS.unlink(report); }
}
