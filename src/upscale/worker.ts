import createFFmpegCore from '../vendor/ffmpeg/ffmpeg-core.js';
import { record } from '../security/validation.ts';
import { ownedTransferBuffer } from '../security/transfer.ts';
import { hardenMediaCore } from '../security/decoder-policy.ts';
import { scanBytes, type InternalScanResult } from '../security/internal-scan.ts';
import { MAX_INPUT_BYTES, MAX_RUNTIME_MS, outputDimensions, type MediaInfo } from './policy.ts';
import { probeTrack } from './probe.ts';
import { convertedDimensions, processingArguments, processingOptions, resultFormat, sniffInput, validateTrack, type TrackInfo } from './processing.ts';

const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage(data: unknown, transfer?: Transferable[]): void };
let busy = false;
class InternalRiskError extends Error {
  readonly internalScan: InternalScanResult;
  constructor(scan: InternalScanResult) {
    super(`내부 위험 검사에서 신호가 발견되어 미디어 처리를 중단했습니다. ${scan.findings.slice(0, 3).map(finding => finding.message).join(' ')}`);
    this.internalScan = scan;
  }
}
function inspectInput(bytes: Uint8Array) {
  const scan = scanBytes(bytes, { expectedMedia: true });
  if (scan.status === 'suspicious') throw new InternalRiskError(scan);
}
async function checkFile(file: unknown): Promise<TrackInfo['kind']> {
  if (!(file instanceof File) || !file.size || file.size > MAX_INPUT_BYTES) throw new Error('파일은 0바이트보다 크고 256MiB 이하여야 합니다.');
  const kind = sniffInput(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
  if (!kind) throw new Error('지원하는 형식: 영상·이미지·오디오. HTML·목록 파일은 처리하지 않습니다.');
  return kind;
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
    scope.postMessage({ type: 'status', message: '파일의 내부 위험 신호를 확인하고 있습니다…' });
    const inputBytes = new Uint8Array(await file.arrayBuffer());
    inspectInput(inputBytes);
    const audioBytes = secondary ? new Uint8Array(await secondary.arrayBuffer()) : undefined;
    if (audioBytes) inspectInput(audioBytes);
    scope.postMessage({ type: 'status', message: '브라우저 내부 처리 엔진을 준비하고 있습니다…' });
    const core = await createFFmpegCore();
    let lastLog = ''; hardenMediaCore(core, ({ message }) => { lastLog = message.slice(0, 500); });
    // These fresh File buffers have no other consumer; MEMFS can retain them.
    core.FS.writeFile('input.media', inputBytes, { canOwn: true });
    const info = probeTrack(core, 'input.media', kind);
    if (options.mode === 'upscale' && !info.video) throw new Error('업스케일링할 영상 또는 이미지 트랙이 없습니다.');
    validateTrack(info, options);
    if (audioBytes) {
      core.FS.writeFile('audio.media', audioBytes, { canOwn: true });
      const audio = probeTrack(core, 'audio.media', 'audio'); validateTrack(audio, { mode: 'audio', format: 'm4a' });
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
    const bytes = ownedTransferBuffer(output);
    scope.postMessage({ type: 'done', info, output: dimensions, format, bytes }, [bytes]);
  } catch (error) { scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : '처리 중 오류가 발생했습니다.',
    ...(error instanceof InternalRiskError ? { internalScan: error.internalScan } : {}) }); }
};
