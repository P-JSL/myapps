import type { FFmpegCore } from '../vendor/ffmpeg/ffmpeg-core.js';

type Logger = Parameters<FFmpegCore['setLogger']>[0];
// These families have security fixes after the pinned 5.1.4 engine. This is a
// decoder exposure reduction, not a replacement for updating the engine.
const BLOCKED_DECODERS = new Set(['jpeg2000', 'libopenjpeg', 'magicyuv', 'exr', 'sanm', 'pam', 'pbm', 'pfm', 'pgm', 'pgmyuv', 'ppm']);
export function blockedDecoder(name: unknown): boolean { return typeof name === 'string' && BLOCKED_DECODERS.has(name); }

/** Initialize before loading any untrusted bytes into a fresh engine. */
export function hardenMediaCore(core: FFmpegCore, logger: Logger): void {
  const names = new Set<string>();
  let logBytes = 0, logLines = 0, exceeded = false, result = -1;
  core.reset(); core.setTimeout(15_000);
  core.setLogger(({ message }) => {
    if (typeof message !== 'string' || ++logLines > 4_096 || (logBytes += message.length) > 256_000) { exceeded = true; return; }
    const match = /^\s*[VAS][A-Z.]{5}\s+([a-zA-Z0-9_][a-zA-Z0-9_.-]*)\s/.exec(message);
    if (match && !blockedDecoder(match[1])) names.add(match[1]!);
  });
  try { result = core.exec('-hide_banner', '-decoders'); }
  finally { core.reset(); core.setLogger(logger); }
  if (result !== 0 || exceeded || !names.size) throw new Error('미디어 디코더 보안 정책을 초기화할 수 없습니다. 확장 프로그램을 다시 로드하세요.');
  const whitelist = [...names].sort().join(',');
  const execute = core.exec.bind(core), inspect = core.ffprobe.bind(core);
  const rejectOverride = (args: string[]) => {
    if (args.includes('-codec_whitelist')) throw new Error('미디어 디코더 보안 정책을 변경할 수 없습니다.');
  };
  core.exec = (...args: string[]) => {
    rejectOverride(args);
    // FFmpeg format options apply to the next input, so each -i needs its own
    // whitelist, including the second input when merging separate tracks.
    const protectedArgs = args.flatMap(argument => argument === '-i' ? ['-codec_whitelist', whitelist, argument] : [argument]);
    return execute(...protectedArgs);
  };
  core.ffprobe = (...args: string[]) => {
    rejectOverride(args);
    return inspect('-codec_whitelist', whitelist, ...args);
  };
}
