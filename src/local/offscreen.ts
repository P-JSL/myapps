import { record } from '../security/validation.ts';
import { scanBytes, type InternalScanResult } from '../security/internal-scan.ts';
import { inspectPreparedFile } from '../security/file-digest.ts';
import { internalScanResponse, incompleteInternalScan } from './antivirus.ts';
import { MAX_INPUT_BYTES } from '../upscale/policy.ts';
import { OFFSCREEN_SCOPE, PREPARE_TIMEOUT_MS, MAX_DISK_MANIFEST_BYTES, SCOPE, mediaURL, browserMediaURL } from './model.ts';
import { fetchManifestResource } from './network.ts';
import { inspectMediaFile, inspectMediaBlob, InvalidMediaFileError } from './media-file.ts';
import { downloadParallelFile } from './parallel-download.ts';
import { planHls, type StreamPlan } from './hls.ts';
import { planDash } from './dash.ts';
import { downloadOptions } from './preferences.ts';
import { PreparationQueue } from './queue.ts';
import { transport, type Transport } from './transport.ts';

class PreparedInspectionError extends Error {
  constructor(message: string, readonly internalScan: InternalScanResult, readonly invalidMedia = false) { super(message); }
}
const prepared = new Map<string, { url: string; filename: string }>();
interface ActiveTask { id: string; controller: AbortController; worker?: Worker; reject?: (error: Error) => void; }
const queue = new PreparationQueue();
export async function disposeLocal(id: string) {
  const item = prepared.get(id);
  if (item) { URL.revokeObjectURL(item.url); prepared.delete(id); }
  const root = await navigator.storage.getDirectory();
  for (const suffix of ['media', 'assets']) {
    for (let attempt = 0; ; attempt++) {
      try { await root.removeEntry(`local-${id}.${suffix}`); break; }
      catch (error) {
        if (error instanceof DOMException && error.name === 'NotFoundError') break;
        if (attempt >= 19 || !(error instanceof DOMException) || !['NoModificationAllowedError', 'InvalidStateError'].includes(error.name)) throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  }
}
export function cancelLocal(id: string) {
  queue.cancel(id);
}
export async function prepareLocal(id: string, url: string, kind: string, settings?: unknown) {
  if (!/^[0-9a-f-]{36}$/.test(id) || prepared.has(id) || !['file', 'hls', 'dash'].includes(kind)) throw new Error('잘못된 파일 준비 요청입니다.');
  const options = downloadOptions(settings);
  const address = browserMediaURL(url).href;
  let latest: Record<string, unknown> = { stage: 'queued' };
  let lastSent = 0;
  function report(value: Record<string, unknown>, force = false) {
    latest = value;
    if (!force && Date.now() - lastSent < 500) return;
    lastSent = Date.now();
    void chrome.runtime.sendMessage({ scope: SCOPE, type: 'preparing-progress', id, ...latest }).catch(() => {});
  }
  report(latest, true);
  const heartbeat = setInterval(() => report(latest, true), 15_000);
  try { return await queue.run(id, signal => prepareOne(id, address, kind, options, signal, report)); }
  finally { clearInterval(heartbeat); }
}
async function prepareOne(id: string, url: string, kind: string, options: ReturnType<typeof downloadOptions>, signal: AbortSignal,
  report: (value: Record<string, unknown>, force?: boolean) => void) {
  const task: ActiveTask = { id, controller: new AbortController() };
  const abort = () => { task.controller.abort(); task.worker?.terminate(); task.reject?.(new DOMException('작업을 취소했습니다.', 'AbortError')); };
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  // Downloads are bounded by storage and request inactivity, not video duration.
  const timeout = options.output === 'original' ? undefined : setTimeout(() => cancelLocal(id), PREPARE_TIMEOUT_MS);
  const protocols = new Set<Transport>();
  try {
    signal.throwIfAborted(); report({ stage: 'fetching', progress: 0 }, true);
    let data: Uint8Array<ArrayBuffer> | undefined;
    const root = await navigator.storage.getDirectory();
    const filename = `local-${id}.media`;
    if (kind === 'file' && options.output === 'original') {
      const handle = await root.getFileHandle(filename, { create: true });
      const writable = await handle.createWritable();
      let writing: Promise<void> = Promise.resolve();
      try {
        const result = await downloadParallelFile(url, {
          write: (position, bytes) => {
            writing = writing.then(() => writable.write({ type: 'write', position, data: bytes }));
            return writing;
          },
        }, task.controller.signal, {
          progress: (loaded, total) => report({ stage: 'fetching', loaded, ...(total ? { total, progress: loaded / total } : {}) }),
        });
        for (const protocol of result.protocols) protocols.add(protocol);
        await writing; task.controller.signal.throwIfAborted(); await writable.close();
      } catch (error) { await writing.catch(() => {}); await writable.abort().catch(() => {}); throw error; }
    }
    else {
      let plan: StreamPlan;
      if (kind === 'file') plan = { assets: [{ url, filename: 'asset-00000.data' }], inputs: [{ filename: 'input-0.mp4', parts: ['asset-00000.data'] }] };
      else if (kind === 'hls') plan = await planHls(url, address => fetchManifestResource(address, task.controller.signal, options.output === 'original' ? MAX_DISK_MANIFEST_BYTES : undefined), options, options.output === 'original');
      else {
        const resource = await fetchManifestResource(url, task.controller.signal, options.output === 'original' ? MAX_DISK_MANIFEST_BYTES : undefined);
        plan = planDash(resource.text, resource.url, options, options.output === 'original');
      }
      task.controller.signal.throwIfAborted();
      data = await new Promise<Uint8Array<ArrayBuffer> | undefined>((resolve, reject) => {
        task.reject = reject;
        const worker = new Worker(chrome.runtime.getURL(options.output === 'original' ? 'local/large-stream-worker.js' : 'local/stream-worker.js'), { type: 'module' }); task.worker = worker;
        worker.addEventListener('error', () => reject(new Error('스트림 처리 엔진을 실행할 수 없습니다.')));
        worker.addEventListener('message', (event: MessageEvent<unknown>) => {
          if (!record(event.data)) return;
          if (event.data.type === 'progress' && typeof event.data.value === 'number') report({ stage: event.data.stage === 'processing' ? 'processing' : 'fetching', progress: event.data.value,
            ...(Number.isSafeInteger(event.data.loaded) && Number(event.data.loaded) >= 0 ? { loaded: event.data.loaded } : {}) }, event.data.stage === 'processing');
          else if (event.data.type === 'done' && event.data.disk === true && options.output === 'original') {
            if (Array.isArray(event.data.protocols)) for (const value of event.data.protocols) { const actual = transport(value); if (actual) protocols.add(actual); }
            resolve(undefined);
          }
          else if (event.data.type === 'done' && event.data.bytes instanceof ArrayBuffer) {
            if (Array.isArray(event.data.protocols)) for (const value of event.data.protocols) { const actual = transport(value); if (actual) protocols.add(actual); }
            resolve(new Uint8Array(event.data.bytes));
          }
          else if (event.data.type === 'error') {
            const message = typeof event.data.message === 'string' ? event.data.message : '스트림 처리 오류';
            if (event.data.internalScan !== undefined) {
              try {
                const result = internalScanResponse(event.data.internalScan);
                reject(new PreparedInspectionError(message, { ...result, complete: false }));
              } catch { reject(new PreparedInspectionError('스트림 내부 검사 결과를 확인할 수 없습니다.', incompleteInternalScan('스트림 입력 검사 결과가 올바르지 않아 처리를 중단했습니다.'))); }
            } else reject(new Error(message));
          }
        });
        worker.postMessage({ id, plan, options });
      });
    }
    if (task.controller.signal.aborted) throw new Error('작업을 취소했습니다.');
    const handle = await root.getFileHandle(filename, { create: data !== undefined });
    if (data !== undefined) {
      const writable = await handle.createWritable();
      try { await writable.write(data); await writable.close(); } catch (error) { await writable.abort().catch(() => {}); throw error; }
    }
    const file = await handle.getFile();
    // Preserve full static inspection for existing small preparations; large files
    // use a bounded prefix and an incremental hash of every byte on disk.
    if (data === undefined && file.size <= MAX_INPUT_BYTES) data = new Uint8Array(await file.arrayBuffer());
    let internalScan: InternalScanResult;
    let internalScanSha256: string;
    try {
      if (data !== undefined) {
        internalScan = internalScanResponse(scanBytes(data, { complete: true, expectedMedia: true }), data.byteLength);
        const digest = await crypto.subtle.digest('SHA-256', data);
        internalScanSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      } else {
        const inspection = await inspectPreparedFile(file, task.controller.signal, (loaded, total) => report({ stage: 'saving', loaded, total, progress: loaded / total }));
        internalScan = internalScanResponse(inspection.internalScan, file.size); internalScanSha256 = inspection.sha256;
      }
    }
    catch { throw new PreparedInspectionError('앱 내부 위험 검사를 완료하지 못해 파일 준비를 중단했습니다.', incompleteInternalScan('앱 내부 검사 오류로 파일을 저장하지 않았습니다.')); }
    let actual: ReturnType<typeof inspectMediaFile>;
    try { actual = data !== undefined ? inspectMediaFile(data) : await inspectMediaBlob(file, task.controller.signal); }
    catch (error) { throw new PreparedInspectionError(error instanceof Error ? error.message : '미디어 형식을 확인할 수 없습니다.', internalScan, error instanceof InvalidMediaFileError); }
    task.controller.signal.throwIfAborted();
    report({ stage: 'saving', progress: 1 }, true);
    signal.throwIfAborted();
    const blob = URL.createObjectURL(new Blob([file], { type: actual.mime })); prepared.set(id, { url: blob, filename });
    return { ok: true, url: blob, filename, ...actual, protocols: [...protocols], internalScan, internalScanSha256, internalScanSize: file.size };
  } catch (error) {
    await disposeLocal(id).catch(() => {});
    throw error;
  }
  finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); task.worker?.terminate(); }
}
chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  if (!record(message) || message.scope !== OFFSCREEN_SCOPE || sender.id !== chrome.runtime.id || sender.tab
    || (sender.url && !sender.url.startsWith(chrome.runtime.getURL('')))
    || typeof message.id !== 'string' || !/^[0-9a-f-]{36}$/.test(message.id)) return false;
  const id = message.id;
  if (message.type === 'cancel') { cancelLocal(id); reply({ ok: true }); return false; }
  if (message.type === 'dispose') { void disposeLocal(id).then(() => reply({ ok: true })).catch(() => reply({ ok: false })); return true; }
  if (message.type !== 'prepare' || !['file', 'hls', 'dash'].includes(String(message.kind))) return false;
  let url: string;
  try { url = mediaURL(message.url).href; } catch { reply({ ok: false, error: '미디어 주소가 올바르지 않습니다.' }); return false; }
  void prepareLocal(id, url, String(message.kind), message.options).then(reply).catch((error: unknown) => { reply({ ok: false, error: error instanceof Error ? error.message : '파일 준비 오류', invalidMedia: error instanceof InvalidMediaFileError || (error instanceof PreparedInspectionError && error.invalidMedia),
    ...(error instanceof PreparedInspectionError ? { internalRisk: true, internalScan: error.internalScan } : {}) }); });
  return true;
});
