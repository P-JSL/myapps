import { record } from '../security/validation.ts';
import { scanBytes, type InternalScanResult } from '../security/internal-scan.ts';
import { internalScanResponse, incompleteInternalScan } from './antivirus.ts';
import { MAX_INPUT_BYTES } from '../upscale/policy.ts';
import { OFFSCREEN_SCOPE, PREPARE_TIMEOUT_MS, SCOPE, mediaURL } from './model.ts';
import { fetchBytes, fetchManifestResource } from './network.ts';
import { inspectMediaFile, InvalidMediaFileError } from './media-file.ts';
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
  await (await navigator.storage.getDirectory()).removeEntry(`local-${id}.media`).catch(error => { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; });
}
export function cancelLocal(id: string) {
  queue.cancel(id);
}
export async function prepareLocal(id: string, url: string, kind: string, settings?: unknown) {
  if (!/^[0-9a-f-]{36}$/.test(id) || prepared.has(id) || !['file', 'hls', 'dash'].includes(kind)) throw new Error('잘못된 파일 준비 요청입니다.');
  const options = downloadOptions(settings);
  const address = mediaURL(url).href;
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
  const timeout = setTimeout(() => cancelLocal(id), PREPARE_TIMEOUT_MS);
  const protocols = new Set<Transport>();
  try {
    signal.throwIfAborted(); report({ stage: 'fetching', progress: 0 }, true);
    let data: Uint8Array<ArrayBuffer>;
    if (kind === 'file' && options.output === 'original') data = await fetchBytes(url, MAX_INPUT_BYTES, task.controller.signal, undefined, {
      progress: (loaded, total) => report({ stage: 'fetching', loaded, ...(total ? { total, progress: loaded / total } : {}) }),
      protocol: value => protocols.add(value),
    });
    else {
      let plan: StreamPlan;
      if (kind === 'file') plan = { assets: [{ url, filename: 'asset-00000.data' }], inputs: [{ filename: 'input-0.mp4', parts: ['asset-00000.data'] }] };
      else if (kind === 'hls') plan = await planHls(url, address => fetchManifestResource(address, task.controller.signal), options);
      else {
        const resource = await fetchManifestResource(url, task.controller.signal);
        plan = planDash(resource.text, resource.url, options);
      }
      task.controller.signal.throwIfAborted();
      data = await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
        task.reject = reject;
        const worker = new Worker(chrome.runtime.getURL('local/stream-worker.js'), { type: 'module' }); task.worker = worker;
        worker.addEventListener('error', () => reject(new Error('스트림 처리 엔진을 실행할 수 없습니다.')));
        worker.addEventListener('message', (event: MessageEvent<unknown>) => {
          if (!record(event.data)) return;
          if (event.data.type === 'progress' && typeof event.data.value === 'number') report({ stage: event.data.stage === 'processing' ? 'processing' : 'fetching', progress: event.data.value }, event.data.stage === 'processing');
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
        worker.postMessage({ plan, options });
      });
    }
    if (task.controller.signal.aborted) throw new Error('작업을 취소했습니다.');
    let internalScan: InternalScanResult;
    try { internalScan = internalScanResponse(scanBytes(data, { complete: true, expectedMedia: true }), data.byteLength); }
    catch { throw new PreparedInspectionError('앱 내부 위험 검사를 완료하지 못해 파일 준비를 중단했습니다.', incompleteInternalScan('앱 내부 검사 오류로 파일을 저장하지 않았습니다.')); }
    let actual: ReturnType<typeof inspectMediaFile>;
    try { actual = inspectMediaFile(data); }
    catch (error) { throw new PreparedInspectionError(error instanceof Error ? error.message : '미디어 형식을 확인할 수 없습니다.', internalScan, error instanceof InvalidMediaFileError); }
    const digest = await crypto.subtle.digest('SHA-256', data);
    const internalScanSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    task.controller.signal.throwIfAborted();
    report({ stage: 'saving', progress: 1 }, true);
    const root = await navigator.storage.getDirectory();
    const filename = `local-${id}.media`;
    const handle = await root.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    try { await writable.write(data); await writable.close(); } catch (error) { await writable.abort().catch(() => {}); throw error; }
    signal.throwIfAborted();
    const file = await handle.getFile();
    const blob = URL.createObjectURL(new Blob([file], { type: actual.mime })); prepared.set(id, { url: blob, filename });
    return { ok: true, url: blob, filename, ...actual, protocols: [...protocols], internalScan, internalScanSha256, internalScanSize: data.byteLength };
  } catch (error) { await disposeLocal(id).catch(() => {}); throw error; }
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
