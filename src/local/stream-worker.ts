import createFFmpegCore from '../vendor/ffmpeg/ffmpeg-core.js';
import { record } from '../security/validation.ts';
import { MAX_SEGMENTS, MAX_STREAM_BYTES, mediaURL } from './model.ts';
import { fetchBytes } from './network.ts';
import type { StreamPlan } from './hls.ts';

const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage(value: unknown, transfer?: Transferable[]): void };
let busy = false;
scope.onmessage = async event => {
  if (busy) return; busy = true;
  try {
    const data = event.data;
    if (!record(data) || !record(data.plan) || !Array.isArray(data.plan.assets) || !Array.isArray(data.plan.inputs)
      || !data.plan.assets.length || data.plan.assets.length > MAX_SEGMENTS || !data.plan.inputs.length || data.plan.inputs.length > 2) throw new Error('잘못된 스트림 작업입니다.');
    const plan = data.plan as unknown as StreamPlan;
    const names = new Set<string>();
    for (const asset of plan.assets) {
      if (!/^asset-\d+\.(ts|m4s)$|^dash-\d+\.m4s$/.test(asset.filename) || names.has(asset.filename)) throw new Error('잘못된 조각 파일명입니다.');
      mediaURL(asset.url); names.add(asset.filename);
    }
    const core = await createFFmpegCore();
    let log = '';
    core.setLogger(({ message }) => { log = message.slice(0, 300); });
    let bytes = 0;
    for (let index = 0; index < plan.assets.length; index++) {
      const asset = plan.assets[index]!;
      const data = await fetchBytes(asset.url, MAX_STREAM_BYTES - bytes, new AbortController().signal, asset.range);
      bytes += data.length;
      if (bytes > MAX_STREAM_BYTES) throw new Error('스트림은 총 128MiB 이하만 처리할 수 있습니다.');
      core.FS.writeFile(asset.filename, data);
      scope.postMessage({ type: 'progress', value: (index + 1) / plan.assets.length * 0.8 });
    }
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
        core.FS.writeFile(input.filename, joined);
        for (const part of input.parts) core.FS.unlink(part);
        args.push('-protocol_whitelist', 'file,pipe', '-i', input.filename);
      } else throw new Error('스트림 입력을 읽을 수 없습니다.');
    }
    args.push('-map', '0:v:0?', '-map', plan.inputs.length === 2 ? '1:a:0?' : '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-fs', String(MAX_STREAM_BYTES), '-y', 'output.mp4');
    core.setTimeout(120_000);
    const result = core.exec(...args);
    if (result !== 0) throw new Error(`스트림을 MP4로 합칠 수 없습니다. ${log}`);
    const output = core.FS.readFile('output.mp4');
    if (!(output instanceof Uint8Array) || !output.length || output.length >= MAX_STREAM_BYTES - 1024 * 1024) throw new Error('결과가 비어 있거나 안전한 출력 용량을 초과했습니다.');
    const buffer = new Uint8Array(output).buffer;
    scope.postMessage({ type: 'done', bytes: buffer }, [buffer]);
  } catch (error) { scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : '스트림 처리 오류' }); }
};
