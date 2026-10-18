import createFFmpegCore, { type FFmpegCore } from '../vendor/ffmpeg/ffmpeg-core.js';
import { record } from '../security/validation.ts';
import { MAX_INPUT_BYTES, MAX_RUNTIME_MS, outputDimensions, type MediaInfo } from './policy.ts';
import { convertedDimensions, processingArguments, processingOptions, resultFormat, sniffInput, validateTrack, type TrackInfo } from './processing.ts';

const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage(data: unknown, transfer?: Transferable[]): void };
let busy = false;
async function checkFile(file: unknown): Promise<TrackInfo['kind']> {
  if (!(file instanceof File) || !file.size || file.size > MAX_INPUT_BYTES) throw new Error('파일은 0바이트보다 크고 256MiB 이하여야 합니다.');
  const kind = sniffInput(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
  if (!kind) throw new Error('지원하는 형식: 영상·이미지·오디오. HTML·목록 파일은 처리하지 않습니다.');
  return kind;
}
function probe(core: FFmpegCore, filename: string, kind: TrackInfo['kind']): TrackInfo {
  core.reset(); core.setTimeout(15_000);
  const code = core.ffprobe('-v', 'error', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe', '-show_error', '-show_streams', '-show_format', '-of', 'json', '-o', 'probe.json', filename);
  // This pinned ffprobe also returns -1 on normal completion; require its fresh report.
  if (code !== 0 && code !== -1) throw new Error('파일 정보를 읽을 수 없습니다.');
  const raw = core.FS.readFile('probe.json', { encoding: 'utf8' }); core.FS.unlink('probe.json');
  if (typeof raw !== 'string' || raw.length > 256_000) throw new Error('파일 정보가 허용 범위를 초과했습니다.');
  const metadata: unknown = JSON.parse(raw);
  if (!record(metadata) || metadata.error || !Array.isArray(metadata.streams)) throw new Error('미디어 정보가 없습니다. 파일이 손상되었거나 지원하지 않는 형식입니다.');
  const video = metadata.streams.find((stream: unknown) => record(stream) && stream.codec_type === 'video' && !(record(stream.disposition) && stream.disposition.attached_pic === 1));
  const audio = metadata.streams.find((stream: unknown) => record(stream) && stream.codec_type === 'audio');
  const format = record(metadata.format) ? metadata.format : {};
  return { width: record(video) ? Number(video.width) : 0, height: record(video) ? Number(video.height) : 0,
    duration: Number(format.duration ?? (record(video) ? video.duration : record(audio) ? audio.duration : 0) ?? 0), video: !!video, audio: !!audio, kind: kind === 'image' ? 'image' : video ? 'video' : 'audio' };
}
scope.onmessage = async event => {
  if (busy) return; busy = true;
  try {
    const data = event.data;
    if (!record(data)) throw new Error('잘못된 처리 요청입니다.');
    const options = processingOptions(data.options ?? { mode: 'upscale', factor: data.factor });
    const kind = await checkFile(data.file);
    const file = data.file as File;
    let secondary: File | undefined;
    if (options.mode === 'merge') {
      await checkFile(data.audio); secondary = data.audio as File;
      if (file.size + secondary.size > MAX_INPUT_BYTES) throw new Error('병합할 두 파일의 합계는 256MiB 이하여야 합니다.');
    }
    scope.postMessage({ type: 'status', message: '브라우저 내부 처리 엔진을 준비하고 있습니다…' });
    const core = await createFFmpegCore();
    let lastLog = ''; core.setLogger(({ message }) => { lastLog = message.slice(0, 500); });
    core.FS.writeFile('input.media', new Uint8Array(await file.arrayBuffer()));
    const info = probe(core, 'input.media', kind);
    if (options.mode === 'upscale' && !info.video) throw new Error('업스케일링할 영상 또는 이미지 트랙이 없습니다.');
    validateTrack(info, options);
    if (secondary) {
      core.FS.writeFile('audio.media', new Uint8Array(await secondary.arrayBuffer()));
      const audio = probe(core, 'audio.media', 'audio'); validateTrack(audio, { mode: 'audio', format: 'm4a' });
    }
    const dimensions = options.mode === 'upscale' ? outputDimensions(info as MediaInfo, options.factor)
      : options.mode === 'convert' ? convertedDimensions(info, options.quality) : { width: info.width, height: info.height };
    scope.postMessage({ type: 'metadata', info, output: dimensions });
    core.reset(); core.setTimeout(MAX_RUNTIME_MS);
    let lastProgress = 0;
    core.setProgress(({ progress }) => {
      const now = performance.now();
      if (now - lastProgress > 200 && Number.isFinite(progress)) { scope.postMessage({ type: 'progress', value: Math.max(0, Math.min(0.99, progress)) }); lastProgress = now; }
    });
    const result = core.exec(...processingArguments(info, options));
    if (result !== 0) throw new Error(`미디어 처리에 실패했습니다 (코드 ${result}). ${lastLog}`);
    const format = resultFormat(options, kind);
    const output = core.FS.readFile(`output.${format}`);
    if (!(output instanceof Uint8Array) || !output.length || output.length >= MAX_INPUT_BYTES - 1024 * 1024) throw new Error('결과가 비어 있거나 안전한 출력 용량 한도에 도달했습니다.');
    const bytes = new Uint8Array(output).buffer;
    scope.postMessage({ type: 'done', info, output: dimensions, format, bytes }, [bytes]);
  } catch (error) { scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : '처리 중 오류가 발생했습니다.' }); }
};
