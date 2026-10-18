import { record } from '../security/validation.ts';
import { MAX_INPUT_BYTES } from '../upscale/policy.ts';
import { OFFSCREEN_SCOPE, PREPARE_TIMEOUT_MS, SCOPE, mediaURL } from './model.ts';
import { fetchBytes, fetchManifest } from './network.ts';
import { planHls, type StreamPlan } from './hls.ts';
import { planDash } from './dash.ts';

const prepared = new Map<string, { url: string; filename: string }>();
interface ActiveTask { id: string; controller: AbortController; worker?: Worker; reject?: (error: Error) => void; }
let active: ActiveTask | undefined;
export async function disposeLocal(id: string) {
  const item = prepared.get(id);
  if (item) { URL.revokeObjectURL(item.url); prepared.delete(id); }
  await (await navigator.storage.getDirectory()).removeEntry(`local-${id}.media`).catch(error => { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; });
}
export function cancelLocal(id: string) {
  if (active?.id !== id) return;
  active.controller.abort(); active.worker?.terminate(); active.reject?.(new Error('작업을 취소했습니다.'));
}
export async function prepareLocal(id: string, url: string, kind: string) {
  if (active) throw new Error('다른 파일을 준비하고 있습니다. 잠시 후 다시 시도하세요.');
  const task: ActiveTask = { id, controller: new AbortController() };
  active = task;
  const timeout = setTimeout(() => cancelLocal(id), PREPARE_TIMEOUT_MS);
  const heartbeat = setInterval(() => { void chrome.runtime.sendMessage({ scope: SCOPE, type: 'preparing-progress', id }).catch(() => {}); }, 15_000);
  try {
    let data: Uint8Array<ArrayBuffer>;
    if (kind === 'file') data = await fetchBytes(url, MAX_INPUT_BYTES, task.controller.signal);
    else {
      const plan: StreamPlan = kind === 'hls' ? await planHls(url, address => fetchManifest(address, task.controller.signal)) : planDash(await fetchManifest(url, task.controller.signal), url);
      data = await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
        task.reject = reject;
        const worker = new Worker(chrome.runtime.getURL('local/stream-worker.js'), { type: 'module' }); task.worker = worker;
        worker.addEventListener('error', () => reject(new Error('스트림 처리 엔진을 실행할 수 없습니다.')));
        worker.addEventListener('message', (event: MessageEvent<unknown>) => {
          if (!record(event.data)) return;
          if (event.data.type === 'done' && event.data.bytes instanceof ArrayBuffer) resolve(new Uint8Array(event.data.bytes));
          else if (event.data.type === 'error') reject(new Error(typeof event.data.message === 'string' ? event.data.message : '스트림 처리 오류'));
        });
        worker.postMessage({ plan });
      });
    }
    if (task.controller.signal.aborted) throw new Error('작업을 취소했습니다.');
    const root = await navigator.storage.getDirectory();
    const filename = `local-${id}.media`;
    const handle = await root.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    try { await writable.write(data); await writable.close(); } catch (error) { await writable.abort().catch(() => {}); throw error; }
    const file = await handle.getFile();
    const blob = URL.createObjectURL(file); prepared.set(id, { url: blob, filename });
    return { ok: true, url: blob, filename };
  } finally { clearTimeout(timeout); clearInterval(heartbeat); task.worker?.terminate(); active = undefined; }
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
  void prepareLocal(id, url, String(message.kind)).then(reply).catch(async (error: unknown) => { await disposeLocal(id).catch(() => {}); reply({ ok: false, error: error instanceof Error ? error.message : '파일 준비 오류' }); });
  return true;
});
