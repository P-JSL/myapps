import createFFmpegCore from '../vendor/ffmpeg/ffmpeg-core.js';
import { record } from '../security/validation.ts';
import { MAX_SEGMENTS, MAX_STREAM_BYTES, mediaURL } from './model.ts';
import { downloadAssets } from './assets.ts';
import { validExpectedSize } from './network.ts';
import type { StreamPlan } from './hls.ts';
import { downloadOptions } from './preferences.ts';
import { ownedTransferBuffer } from '../security/transfer.ts';
import { ENCODER_ARGUMENTS } from '../shared/media.ts';
import { hardenMediaCore } from '../security/decoder-policy.ts';
import { scanBytes, type InternalScanResult } from '../security/internal-scan.ts';

const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage(value: unknown, transfer?: Transferable[]): void };
let busy = false;
class InternalRiskError extends Error {
  readonly internalScan: InternalScanResult;
  constructor(scan: InternalScanResult) {
    super(`내부 위험 검사에서 신호가 발견되어 스트림 처리를 중단했습니다. ${scan.findings.slice(0, 3).map(finding => finding.message).join(' ')}`);
    this.internalScan = scan;
  }
}
function inspectInput(bytes: Uint8Array) {
  // Stream fragments need not carry a standalone media header.
  const scan = scanBytes(bytes, { expectedMedia: false });
  if (scan.status === 'suspicious') throw new InternalRiskError(scan);
}
scope.onmessage = async event => {
  if (busy) return; busy = true;
  try {
    const data = event.data;
    if (!record(data) || !record(data.plan) || !Array.isArray(data.plan.assets) || !Array.isArray(data.plan.inputs)
      || !data.plan.assets.length || data.plan.assets.length > MAX_SEGMENTS || !data.plan.inputs.length || data.plan.inputs.length > 2) throw new Error('잘못된 스트림 작업입니다.');
    const plan = data.plan as unknown as StreamPlan;
    const options = downloadOptions(data.options);
    const outputFormat = data.outputFormat ?? 'mp4';
    if (typeof outputFormat !== 'string' || !['mp4', 'webm', 'mkv'].includes(outputFormat)) throw new Error('잘못된 스트림 저장 형식입니다.');
    if (data.requireVideo !== undefined && typeof data.requireVideo !== 'boolean') throw new Error('잘못된 영상 트랙 설정입니다.');
    if (data.requireAudio !== undefined && typeof data.requireAudio !== 'boolean') throw new Error('잘못된 음성 트랙 설정입니다.');
    const names = new Set<string>();
    for (const asset of plan.assets) {
      if (!/^asset-\d+\.(ts|m4s|data)$|^dash-\d+\.m4s$/.test(asset.filename) || names.has(asset.filename)) throw new Error('잘못된 조각 파일명입니다.');
      mediaURL(asset.url); validExpectedSize(asset.expectedSize, asset.range); names.add(asset.filename);
    }
    const core = await createFFmpegCore();
    let log = '';
    hardenMediaCore(core, ({ message }) => { log = message.slice(0, 300); });
    const protocols = new Set<string>();
    await downloadAssets(plan.assets, (name, bytes) => {
      inspectInput(bytes);
      core.FS.writeFile(name, bytes);
    }, new AbortController().signal,
      completed => scope.postMessage({ type: 'progress', value: completed / plan.assets.length * 0.8, stage: 'fetching' }),
      value => protocols.add(value));
    scope.postMessage({ type: 'progress', value: 0.8, stage: 'processing' });
    const args = ['-hide_banner', '-nostdin', '-max_alloc', '67108864'];
    for (const input of plan.inputs) {
      if (!/^input-[01]\.(mp4|m3u8)$/.test(input.filename)) throw new Error('잘못된 입력 파일명입니다.');
      if (typeof input.playlist === 'string') {
        if (input.playlist.length > 2 * 1024 * 1024 || /https?:|\.\.|[\\]/i.test(input.playlist)) throw new Error('재작성된 목록이 올바르지 않습니다.');
        core.FS.writeFile(input.filename, new TextEncoder().encode(input.playlist));
        args.push('-protocol_whitelist', 'file,pipe', '-allowed_extensions', 'ALL', '-i', input.filename);
      } else if (Array.isArray(input.parts) && input.parts.length && input.parts.every(name => names.has(name))) {
        const chunks = input.parts.map(name => core.FS.readFile(name));
        if (!chunks.every((chunk): chunk is Uint8Array => chunk instanceof Uint8Array)) throw new Error('DASH 조각이 올바르지 않습니다.');
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        if (total > MAX_STREAM_BYTES) throw new Error('DASH 트랙 용량 한도를 초과했습니다.');
        const joined = new Uint8Array(total); let offset = 0;
        for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
        // Inspect the joined track as well: signatures can span asset boundaries.
        inspectInput(joined);
        core.FS.writeFile(input.filename, joined);
        for (const part of input.parts) core.FS.unlink(part);
        args.push('-protocol_whitelist', 'file,pipe', '-i', input.filename);
      } else throw new Error('스트림 입력을 읽을 수 없습니다.');
    }
    const outputName = `output.${options.output === 'original' ? outputFormat : options.output}`;
    if (options.output === 'original') args.push('-map', data.requireVideo === true ? '0:v:0' : '0:v:0?', '-map',
      `${plan.inputs.length === 2 ? '1' : '0'}:a:0${data.requireAudio === true ? '' : '?'}`, '-c', 'copy',
      ...(outputFormat === 'mp4' ? ['-movflags', '+faststart'] : []));
    else {
      args.push('-map', plan.inputs.length === 2 ? '1:a:0' : '0:a:0', '-vn', ...(options.output === 'mp3' ? ENCODER_ARGUMENTS.mp3 : ENCODER_ARGUMENTS.aac), '-threads', '1');
      if (options.output === 'm4a') args.push('-movflags', '+faststart');
    }
    args.push('-fs', String(MAX_STREAM_BYTES), '-y', outputName);
    core.setTimeout(120_000);
    const result = core.exec(...args);
    if (result !== 0) throw new Error(`미디어를 저장 형식으로 처리할 수 없습니다. ${log}`);
    const output = core.FS.readFile(outputName);
    if (!(output instanceof Uint8Array) || !output.length || output.length >= MAX_STREAM_BYTES - 1024 * 1024) throw new Error('결과가 비어 있거나 안전한 출력 용량을 초과했습니다.');
    const buffer = ownedTransferBuffer(output);
    scope.postMessage({ type: 'done', bytes: buffer, protocols: [...protocols] }, [buffer]);
  } catch (error) { scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : '스트림 처리 오류',
    ...(error instanceof InternalRiskError ? { internalScan: error.internalScan } : {}) }); }
};
