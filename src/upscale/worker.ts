import createFFmpegCore from '../vendor/ffmpeg/ffmpeg-core.js';
import { record } from '../security/validation.ts';
import { MAX_INPUT_BYTES, MAX_RUNTIME_MS, sniffMedia, ffmpegArguments, outputDimensions, type Factor, type MediaInfo } from './policy.ts';

const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage(data: unknown, transfer?: Transferable[]): void };
let busy = false;
scope.onmessage = async (event) => {
  if (busy) return;
  busy = true;
  try {
    const data = event.data;
    if (!record(data) || !(data.file instanceof File) || (data.factor !== 2 && data.factor !== 4)) throw new Error('잘못된 처리 요청입니다.');
    const file = data.file;
    if (!file.size || file.size > MAX_INPUT_BYTES) throw new Error('파일 크기는 256MiB 이하여야 합니다.');
    const kind = sniffMedia(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
    if (!kind) throw new Error('지원하는 형식: PNG, JPEG, WebP, MP4/MOV, WebM/MKV, AVI.');
    scope.postMessage({ type: 'status', message: '브라우저 내부 처리 엔진을 준비하고 있습니다…' });
    const core = await createFFmpegCore();
    let lastLog = '';
    core.setLogger(({ message }) => { lastLog = message.slice(0, 500); });
    core.FS.writeFile('input.media', new Uint8Array(await file.arrayBuffer()));
    core.setTimeout(15_000);
    const code = core.ffprobe('-v', 'error', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe', '-show_error', '-show_streams', '-show_format', '-of', 'json', '-o', 'probe.json', 'input.media');
    // @ffmpeg/core 0.12.10 ffprobe leaves ret=-1 on normal return. Require a fresh,
    // valid probe report as well, rather than treating that sentinel as success.
    if (code !== 0 && code !== -1) throw new Error('파일 정보를 읽을 수 없습니다. 손상되거나 지원하지 않는 파일입니다.');
    const raw = core.FS.readFile('probe.json', { encoding: 'utf8' });
    if (typeof raw !== 'string' || raw.length > 256_000) throw new Error('파일 정보가 허용 범위를 초과했습니다.');
    const metadata: unknown = JSON.parse(raw);
    if (!record(metadata) || metadata.error || !Array.isArray(metadata.streams)) throw new Error('미디어 정보가 없습니다. 파일이 손상되었거나 지원하지 않는 형식입니다.');
    const video: unknown = metadata.streams.find((stream: unknown) => record(stream) && stream.codec_type === 'video');
    if (!record(video)) throw new Error('영상 또는 이미지 트랙이 없습니다.');
    const format = record(metadata.format) ? metadata.format : {};
    const info: MediaInfo = { width: Number(video.width), height: Number(video.height), duration: Number(format.duration ?? video.duration ?? 0), kind };
    const dimensions = outputDimensions(info, data.factor);
    scope.postMessage({ type: 'metadata', info, output: dimensions });
    core.reset();
    core.setTimeout(MAX_RUNTIME_MS);
    let lastProgress = 0;
    core.setProgress(({ progress }) => {
      const now = performance.now();
      if (now - lastProgress > 200 && Number.isFinite(progress)) {
        scope.postMessage({ type: 'progress', value: Math.max(0, Math.min(0.99, progress)) });
        lastProgress = now;
      }
    });
    const result = core.exec(...ffmpegArguments(info, data.factor as Factor));
    if (result !== 0) throw new Error(`미디어 변환에 실패했습니다 (코드 ${result}). ${lastLog}`);
    const output = core.FS.readFile(kind === 'image' ? 'output.png' : 'output.mp4');
    // FFmpeg -fs may finish a truncated mux just below the cap. Reject the safety margin too.
    if (!(output instanceof Uint8Array) || !output.length || output.length >= MAX_INPUT_BYTES - 1024 * 1024) throw new Error('확대본이 비어 있거나 안전한 출력 용량 한도에 도달했습니다.');
    const bytes = new Uint8Array(output).buffer;
    scope.postMessage({ type: 'done', info, output: dimensions, bytes }, [bytes]);
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : '처리 중 오류가 발생했습니다.' });
  }
};
