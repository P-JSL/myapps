import createFFmpegCore from '../vendor/ffmpeg/ffmpeg-core.js';
import { record } from '../security/validation.ts';
import { hardenMediaCore } from '../security/decoder-policy.ts';
import { mediaURL } from './model.ts';
import type { StreamPlan } from './hls.ts';
import { downloadDiskAssets, inspectDiskBoundaries, DiskInputRiskError } from './disk-assets.ts';
import { mountDiskFiles, type DiskAccessHandle, type DiskExtent } from './disk-fs.ts';
import type { Transport } from './transport.ts';

interface SyncHandle extends DiskAccessHandle { close(): void; }
type SyncFile = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle>; };
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage(value: unknown): void; };
let busy = false;
function validatePlan(value: unknown): StreamPlan {
  if (!record(value) || !Array.isArray(value.assets) || !value.assets.length || value.assets.length > 100_000
    || !Array.isArray(value.inputs) || !value.inputs.length || value.inputs.length > 2) throw new Error('잘못된 대용량 스트림 작업입니다.');
  const names = new Set<string>();
  for (const asset of value.assets) {
    if (!record(asset) || typeof asset.filename !== 'string' || !/^(?:asset-\d+\.(?:ts|m4s|data)|dash-\d+\.m4s)$/.test(asset.filename)
      || names.has(asset.filename)) throw new Error('잘못된 스트림 조각 이름입니다.');
    mediaURL(asset.url); names.add(asset.filename);
  }
  const inputs = new Set<string>();
  for (const input of value.inputs) {
    if (!record(input) || typeof input.filename !== 'string' || !/^input-[01]\.(mp4|m3u8)$/.test(input.filename)
      || inputs.has(input.filename)) throw new Error('잘못된 스트림 입력 이름입니다.');
    inputs.add(input.filename);
    if (typeof input.playlist === 'string') {
      if (input.playlist.length > 8 * 1024 * 1024 || !input.playlist.startsWith('#EXTM3U') || /https?:|\.\.|[\\]/i.test(input.playlist)) throw new Error('재작성된 스트림 목록이 올바르지 않습니다.');
      for (const line of input.playlist.split('\n').map(item => item.trim()).filter(Boolean)) {
        if (!line.startsWith('#')) { if (!names.has(line)) throw new Error('목록에 등록되지 않은 미디어 조각입니다.'); }
        else if (!/^#(?:EXTM3U$|EXTINF:|EXT-X-(?:VERSION:|TARGETDURATION:|MEDIA-SEQUENCE:|PLAYLIST-TYPE:|DISCONTINUITY|INDEPENDENT-SEGMENTS|ENDLIST|GAP|MAP:))/.test(line)) throw new Error('허용되지 않은 스트림 목록 항목입니다.');
        if (line.startsWith('#EXT-X-MAP:')) {
          const uri = line.match(/URI="([^"]+)"/);
          if (!uri || !names.has(uri[1]!)) throw new Error('잘못된 스트림 초기화 조각입니다.');
        }
      }
    } else if (!Array.isArray(input.parts) || !input.parts.length || input.parts.length > 100_000 || !input.parts.every(name => typeof name === 'string' && names.has(name))) throw new Error('잘못된 스트림 트랙 조각입니다.');
  }
  return value as unknown as StreamPlan;
}
scope.onmessage = async event => {
  if (busy) return; busy = true;
  let root: FileSystemDirectoryHandle | undefined, assets: SyncHandle | undefined, output: SyncHandle | undefined;
  let mounted: ReturnType<typeof mountDiskFiles> | undefined, core: Awaited<ReturnType<typeof createFFmpegCore>> | undefined;
  let assetsName = '', outputName = '', successful = false, failure: unknown;
  const controller = new AbortController();
  const protocols = new Set<Transport>();
  try {
    const message = event.data;
    if (!record(message) || typeof message.id !== 'string' || !/^[0-9a-f-]{36}$/.test(message.id)) throw new Error('잘못된 대용량 작업 ID입니다.');
    const plan = validatePlan(message.plan);
    assetsName = `local-${message.id}.assets`; outputName = `local-${message.id}.media`;
    root = await navigator.storage.getDirectory();
    assets = await (await root.getFileHandle(assetsName, { create: true }) as SyncFile).createSyncAccessHandle(); assets.truncate(0);
    output = await (await root.getFileHandle(outputName, { create: true }) as SyncFile).createSyncAccessHandle(); output.truncate(0);
    let cursor = 0;
    const assetHandle = assets;
    const append = (bytes: Uint8Array): DiskExtent => {
      if (!Number.isSafeInteger(cursor + bytes.length)) throw new Error('파일이 브라우저 파일 시스템의 주소 범위를 초과했습니다.');
      const start = cursor;
      let offset = 0;
      while (offset < bytes.length) {
        const count = assetHandle.write(bytes.subarray(offset), { at: cursor });
        if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) throw new Error('미디어를 디스크에 저장하지 못했습니다. 저장 공간을 확인하세요.');
        cursor += count; offset += count;
      }
      return { offset: start, length: bytes.length };
    };
    const downloaded = await downloadDiskAssets(plan.assets, { append }, controller.signal, {
      progress: (loaded, completed) => scope.postMessage({ type: 'progress', stage: 'fetching', loaded, value: completed / plan.assets.length * 0.8 }),
      protocol: value => protocols.add(value),
    });
    const inputs = new Map<string, readonly DiskExtent[]>();
    for (const [name, asset] of downloaded) inputs.set(name, asset.extents);
    for (const input of plan.inputs) {
      if (typeof input.playlist === 'string') inputs.set(input.filename, [append(new TextEncoder().encode(input.playlist))]);
      else {
        const parts = input.parts!.map(name => downloaded.get(name)!);
        inspectDiskBoundaries(assets, parts);
        inputs.set(input.filename, parts.flatMap(part => part.extents));
      }
    }
    assets.flush?.();
    scope.postMessage({ type: 'progress', stage: 'processing', value: 0.8 });
    core = await createFFmpegCore();
    let log = '';
    hardenMediaCore(core, ({ message }) => { log = message.slice(0, 300); });
    core.setProgress(({ progress }) => { if (Number.isFinite(progress)) scope.postMessage({ type: 'progress', stage: 'processing', value: 0.8 + Math.max(0, Math.min(1, progress)) * 0.2 }); });
    mounted = mountDiskFiles(core.FS, assets, output, inputs, 'output.mp4'); core.FS.chdir('/disk');
    const args = ['-hide_banner', '-nostdin', '-max_alloc', '67108864'];
    for (const input of plan.inputs) args.push('-protocol_whitelist', 'file,pipe', ...(input.playlist ? ['-allowed_extensions', 'ALL'] : []), '-i', input.filename);
    args.push('-map', '0:v:0?', '-map', plan.inputs.length === 2 ? '1:a:0?' : '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-y', 'output.mp4');
    // A valid long recording is not rejected by a fixed media-duration/runtime cap.
    // The parent can terminate this worker for an explicit cancellation.
    core.setTimeout(-1);
    if (core.exec(...args) !== 0) throw new Error(`스트림을 MP4로 합칠 수 없습니다. ${log}`);
    if (!mounted.outputSize()) throw new Error('처리 결과가 비어 있습니다.');
    mounted.flush(); core.FS.chdir('/'); mounted.unmount(); mounted = undefined;
    output.close(); output = undefined; assets.close(); assets = undefined;
    await root.removeEntry(assetsName); assetsName = '';
    successful = true;
  } catch (error) { failure = error; controller.abort(); }
  finally {
    try { core?.FS.chdir('/'); mounted?.unmount(); } catch { /* The worker will release its engine. */ }
    try { assets?.close(); } catch { /* Closing a failed handle must not hide the cause. */ }
    try { output?.close(); } catch { /* Closing a failed handle must not hide the cause. */ }
    if (root && assetsName) await root.removeEntry(assetsName).catch(() => {});
    if (!successful && root && outputName) await root.removeEntry(outputName).catch(() => {});
  }
  if (successful) scope.postMessage({ type: 'done', disk: true, protocols: [...protocols] });
  else scope.postMessage({ type: 'error', message: failure instanceof Error ? failure.message : '대용량 스트림 처리 오류',
    ...(failure instanceof DiskInputRiskError ? { internalScan: failure.internalScan } : {}) });
};
