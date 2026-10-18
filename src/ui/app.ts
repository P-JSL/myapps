import { cleanup, deleteJob, directory, jobs } from '../upscale/storage.ts';
import { OFFER_KEY, MAX_INPUT_BYTES, MAX_RUNTIME_MS, isJobId, outputName, type Factor, type Job, type MediaInfo } from '../upscale/policy.ts';
import { record } from '../security/validation.ts';

function element<T extends HTMLElement>(id: string): T { const node = document.getElementById(id); if (!node) throw new Error(`Missing element: ${id}`); return node as T; }
const fileInput = element<HTMLInputElement>('file');
const selected = element('selected');
const status = element('status');
const details = element('details');
const start = element<HTMLButtonElement>('start');
const cancel = element<HTMLButtonElement>('cancel');
const save = element<HTMLButtonElement>('save');
const factor = element<HTMLSelectElement>('factor');
const progress = element<HTMLProgressElement>('progress');
const offer = element<HTMLInputElement>('offer');
let input: File | undefined;
let worker: Worker | undefined;
let watchdog: ReturnType<typeof setTimeout> | undefined;
let output: { url: string; filename: string } | undefined;

function showError(error: unknown) { status.textContent = error instanceof Error ? error.message : '처리 중 오류가 발생했습니다.'; }
function releaseOutput() { if (output) URL.revokeObjectURL(output.url); output = undefined; save.hidden = true; }
function stop() { worker?.terminate(); worker = undefined; clearTimeout(watchdog); watchdog = undefined; start.disabled = !input; cancel.disabled = true; factor.disabled = false; fileInput.disabled = false; }
function select(file: File) {
  if (worker) return;
  releaseOutput(); input = undefined; details.textContent = ''; progress.value = 0;
  if (!file.size || file.size > MAX_INPUT_BYTES) { selected.textContent = '선택한 파일 없음'; showError(new Error('파일은 0바이트보다 크고 256MiB 이하여야 합니다.')); start.disabled = true; return; }
  input = file; selected.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MiB`; start.disabled = false;
  status.textContent = '확대 배율을 고른 뒤 확대 시작을 누르세요.';
}
async function selectJob(job: Job) {
  try { const file = await (await (await directory()).getFileHandle(job.id)).getFile(); fileInput.value = ''; select(new File([file], job.filename)); }
  catch { showError(new Error('임시 파일이 정리되었습니다. 저장된 원본 파일을 직접 선택하세요.')); await refresh(); }
}
async function refresh() {
  const retained = await cleanup();
  const list = element<HTMLUListElement>('jobs');
  list.replaceChildren(); element('empty').hidden = retained.length > 0;
  for (const job of retained) {
    const row = document.createElement('li');
    const label = document.createElement('span'); label.textContent = job.filename;
    const choose = document.createElement('button'); choose.textContent = '선택'; choose.disabled = !!worker; choose.addEventListener('click', () => { void selectJob(job); });
    const remove = document.createElement('button'); remove.textContent = '삭제'; remove.className = 'secondary'; remove.addEventListener('click', () => { void deleteJob(job).then(refresh).catch(showError); });
    row.append(label, choose, remove); list.append(row);
  }
}
fileInput.addEventListener('change', () => { if (fileInput.files?.[0]) select(fileInput.files[0]); });
element('refresh').addEventListener('click', () => { void refresh().catch(showError); });
element('clear').addEventListener('click', () => { void (async () => { for (const job of await jobs()) await deleteJob(job); await refresh(); })().catch(showError); });
offer.addEventListener('change', () => { void chrome.storage.local.set({ [OFFER_KEY]: offer.checked }).catch(showError); });
cancel.addEventListener('click', () => { stop(); progress.value = 0; status.textContent = '취소했습니다. 원본 파일은 그대로 보관됩니다.'; void refresh().catch(showError); });

start.addEventListener('click', () => {
  if (!input || worker) return;
  releaseOutput();
  const chosen = input;
  const scale: Factor = factor.value === '4' ? 4 : 2;
  start.disabled = true; cancel.disabled = false; factor.disabled = true; fileInput.disabled = true;
  progress.removeAttribute('value'); status.textContent = '미디어를 확인하고 있습니다…'; details.textContent = '';
  worker = new Worker(chrome.runtime.getURL('hardening/upscale-worker.js'), { type: 'module' });
  watchdog = setTimeout(() => { stop(); showError(new Error('처리 시간 5분을 초과해 중단했습니다. 더 작은 파일을 사용하세요.')); }, MAX_RUNTIME_MS + 30_000);
  worker.addEventListener('error', () => { stop(); showError(new Error('처리 엔진을 실행할 수 없습니다. 확장 프로그램을 다시 로드하세요.')); });
  worker.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (!record(message)) return;
    if (message.type === 'status' && typeof message.message === 'string') status.textContent = message.message;
    else if (message.type === 'metadata' && record(message.info) && record(message.output)) {
      details.textContent = `${message.info.width} × ${message.info.height} → ${message.output.width} × ${message.output.height}`;
      progress.value = 0; status.textContent = '확대본을 만들고 있습니다. 이 탭을 열어 두세요.';
    } else if (message.type === 'progress' && typeof message.value === 'number') progress.value = message.value;
    else if (message.type === 'error') { stop(); showError(new Error(typeof message.message === 'string' ? message.message : '변환에 실패했습니다.')); progress.value = 0; }
    else if (message.type === 'done' && message.bytes instanceof ArrayBuffer && record(message.info)) {
      const kind: MediaInfo['kind'] = message.info.kind === 'image' ? 'image' : 'video';
      output = { url: URL.createObjectURL(new Blob([message.bytes], { type: kind === 'image' ? 'image/png' : 'video/mp4' })), filename: outputName(chosen.name, scale, kind) };
      stop(); progress.value = 1; status.textContent = '확대본이 준비되었습니다. 별도 파일로 저장하세요.'; save.hidden = false;
      void refresh().catch(showError);
    }
  });
  worker.postMessage({ file: chosen, factor: scale });
  void refresh().catch(showError);
});
save.addEventListener('click', () => {
  if (!output) return;
  void chrome.downloads.download({ url: output.url, filename: output.filename, saveAs: true, conflictAction: 'uniquify' }).catch(showError);
});
addEventListener('pagehide', () => { stop(); releaseOutput(); });
void (async () => {
  offer.checked = (await chrome.storage.local.get(OFFER_KEY))[OFFER_KEY] !== false;
  await refresh();
  const id = new URL(location.href).searchParams.get('job');
  if (isJobId(id)) { const job = (await jobs()).find(j => j.id === id); if (job) await selectJob(job); else status.textContent = '임시 복사본을 찾을 수 없습니다. 원본 파일을 직접 선택하세요.'; }
})().catch(showError);
