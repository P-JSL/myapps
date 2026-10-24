import { cleanup, deleteJob, directory, jobs, privateContext } from '../upscale/storage.ts';
import { OFFER_KEY, MAX_INPUT_BYTES, MAX_RUNTIME_MS, isJobId, type Job } from '../upscale/policy.ts';
import { MIME, processedName, processingOptions, type TrackInfo } from '../upscale/processing.ts';
import { record } from '../security/validation.ts';
import { appStorage } from '../data/database.ts';
import { SCOPE } from '../local/model.ts';

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
const isPrivate = privateContext();
const mode = element<HTMLSelectElement>('mode');
const audioInput = element<HTMLInputElement>('audio-file');
let input: File | undefined;
let worker: Worker | undefined;
let watchdog: ReturnType<typeof setTimeout> | undefined;
let output: { url: string; filename: string } | undefined;
let offerTouched = false;
const MODE_HINTS: Readonly<Record<string, string>> = Object.freeze({
  upscale: 'Lanczos 2x/4x 보간입니다. AI 복원은 아닙니다. 영상은 MP4(H.264/AAC), 이미지는 PNG로 저장합니다.',
  convert: 'MP4·MKV는 H.264/AAC, WebM은 VP8/Opus로 변환합니다. 선택 높이는 상한이며 작은 원본을 확대하지 않습니다.',
  audio: '영상 또는 오디오의 첫 음성 트랙을 저장합니다. MP3/M4A는 192kbps로 인코딩하며 WAV는 원본에서 디코딩한 PCM입니다.',
  merge: '영상 파일과 별도 음성 파일을 선택하세요. 영상의 기존 음성 대신 선택한 파일의 첫 음성 트랙을 사용합니다.',
});
const MODE_START_LABELS: Readonly<Record<string, string>> = Object.freeze({ upscale: '확대 시작', convert: '영상 변환', audio: '오디오 만들기', merge: '병합 시작' });

if (isPrivate) {
  offer.checked = false; offer.disabled = true;
  const hint = document.createElement('p'); hint.id = 'offer-private-status'; hint.className = 'hint';
  hint.textContent = '시크릿 창에서는 완료 파일의 임시 복사본을 보관하거나 일반 창의 업스케일링 알림 설정을 읽고 변경하지 않습니다. 아래에서 직접 파일을 선택해 미디어 도구를 사용할 수 있습니다.';
  offer.setAttribute('aria-describedby', hint.id); offer.closest('label')?.after(hint);
}

function showError(error: unknown) { status.textContent = error instanceof Error ? error.message : '처리 중 오류가 발생했습니다.'; }
const offerPreferencesReady = (async () => {
  if (isPrivate) return;
  try {
    const enabled = (await appStorage.get(OFFER_KEY))[OFFER_KEY] !== false;
    if (!offerTouched) offer.checked = enabled;
  } catch (error) { showError(error); }
})();
function releaseOutput() { if (output) URL.revokeObjectURL(output.url); output = undefined; save.hidden = true; }
function toggleControls(disabled: boolean) { for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#convert-title ~ input, #convert-title ~ select, #upscale-settings select, #convert-settings select, #audio-settings select, #merge-settings input, #merge-settings select')) control.disabled = disabled; }
function stop() { worker?.terminate(); worker = undefined; clearTimeout(watchdog); watchdog = undefined; toggleControls(false); start.disabled = !input || (mode.value === 'merge' && !audioInput.files?.[0]); cancel.disabled = true; }
function settings() {
  return processingOptions({ mode: mode.value, factor: Number(factor.value), format: element<HTMLSelectElement>(mode.value === 'audio' ? 'audio-format' : mode.value === 'merge' ? 'merge-format' : 'video-format').value, quality: element<HTMLSelectElement>('convert-quality').value });
}
function changeMode() {
  if (worker) return;
  releaseOutput(); progress.value = 0;
  for (const name of ['upscale', 'convert', 'audio', 'merge']) element(`${name}-settings`).hidden = mode.value !== name;
  element('mode-hint').textContent = MODE_HINTS[mode.value] ?? '';
  start.textContent = MODE_START_LABELS[mode.value] ?? '시작';
  start.disabled = !input || (mode.value === 'merge' && !audioInput.files?.[0]);
  status.textContent = '파일과 처리 설정을 선택한 뒤 시작하세요.';
}
function select(file: File) {
  if (worker) return;
  releaseOutput(); input = undefined; details.textContent = ''; progress.value = 0;
  if (!file.size || file.size > MAX_INPUT_BYTES) { selected.textContent = '선택한 파일 없음'; showError(new Error('파일은 0바이트보다 크고 256MiB 이하여야 합니다.')); start.disabled = true; return; }
  input = file; selected.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MiB`; changeMode();
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
mode.addEventListener('change', changeMode);
audioInput.addEventListener('change', changeMode);
element('refresh').addEventListener('click', () => { void refresh().catch(showError); });
element('clear').addEventListener('click', () => { void (async () => { for (const job of await jobs()) await deleteJob(job); await refresh(); })().catch(showError); });
offer.addEventListener('change', () => {
  offerTouched = true;
  if (isPrivate) return;
  const enabled = offer.checked;
  void offerPreferencesReady.then(() => appStorage.set({ [OFFER_KEY]: enabled })).catch(showError);
});
cancel.addEventListener('click', () => { stop(); progress.value = 0; status.textContent = '취소했습니다. 원본 파일은 그대로 보관됩니다.'; void refresh().catch(showError); });

start.addEventListener('click', () => {
  if (!input || worker) return;
  releaseOutput();
  const chosen = input;
  const options = settings();
  const audio = audioInput.files?.[0];
  if (options.mode === 'merge' && (!audio || !audio.size || input.size + audio.size > MAX_INPUT_BYTES)) { showError(new Error('병합할 두 파일은 0바이트보다 크고 합계 256MiB 이하여야 합니다.')); return; }
  start.disabled = true; cancel.disabled = false; toggleControls(true);
  progress.removeAttribute('value'); status.textContent = '미디어를 확인하고 있습니다…'; details.textContent = '';
  worker = new Worker(chrome.runtime.getURL('hardening/upscale-worker.js'), { type: 'module' });
  watchdog = setTimeout(() => { stop(); showError(new Error('처리 시간 5분을 초과해 중단했습니다. 더 작은 파일을 사용하세요.')); }, MAX_RUNTIME_MS + 30_000);
  worker.addEventListener('error', () => { stop(); progress.value = 0; showError(new Error('처리 엔진을 실행할 수 없습니다. 확장 프로그램을 다시 로드하세요.')); });
  worker.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (!record(message)) return;
    if (message.type === 'status' && typeof message.message === 'string') status.textContent = message.message;
    else if (message.type === 'metadata' && record(message.info) && record(message.output)) {
      details.textContent = options.mode === 'audio' ? '첫 오디오 트랙을 별도 파일로 저장합니다.' : `${message.info.width} × ${message.info.height} → ${message.output.width} × ${message.output.height}`;
      progress.value = 0; status.textContent = '결과를 만들고 있습니다. 이 탭을 열어 두세요.';
    } else if (message.type === 'progress' && typeof message.value === 'number') progress.value = message.value;
    else if (message.type === 'error') { stop(); showError(new Error(typeof message.message === 'string' ? message.message : '변환에 실패했습니다.')); progress.value = 0; }
    else if (message.type === 'done' && message.bytes instanceof ArrayBuffer && record(message.info)) {
      const kind: TrackInfo['kind'] = message.info.kind === 'image' ? 'image' : message.info.kind === 'audio' ? 'audio' : 'video';
      const format = typeof message.format === 'string' && Object.hasOwn(MIME, message.format) ? message.format as keyof typeof MIME : 'mp4';
      output = { url: URL.createObjectURL(new Blob([message.bytes], { type: MIME[format] })), filename: processedName(chosen.name, options, kind) };
      stop(); progress.value = 1; status.textContent = '결과가 준비되었습니다. 별도 파일로 저장하세요.'; save.hidden = false;
      void refresh().catch(showError);
    }
  });
  worker.postMessage({ file: chosen, options, ...(options.mode === 'merge' ? { audio } : {}) });
  void refresh().catch(showError);
});
save.addEventListener('click', () => {
  if (!output || save.disabled) return;
  const chosen = output;
  save.disabled = true;
  void (async () => {
    const result: unknown = await chrome.runtime.sendMessage({ scope: SCOPE, type: 'prepare-output-save' });
    if (!record(result) || result.ok !== true || typeof result.setupRequired !== 'boolean') throw new Error(record(result) && typeof result.error === 'string' ? result.error : '다운로드 저장 폴더 설정을 확인하지 못했습니다.');
    if (output !== chosen) return;
    if (result.setupRequired) {
      status.textContent = '첫 저장 전에 열린 설정에서 저장 폴더를 설정해 주세요. 결과는 이 탭에 유지됩니다. 설정 완료 후 결과 저장을 다시 누르세요.';
      return;
    }
    await chrome.downloads.download({ url: chosen.url, filename: chosen.filename, saveAs: false, conflictAction: 'uniquify' });
  })().catch(showError).finally(() => { save.disabled = false; });
});
addEventListener('pagehide', () => { stop(); releaseOutput(); });
void (async () => {
  await offerPreferencesReady;
  await refresh();
  const id = new URL(location.href).searchParams.get('job');
  if (isJobId(id)) { const job = (await jobs()).find(j => j.id === id); if (job) await selectJob(job); else status.textContent = '임시 복사본을 찾을 수 없습니다. 원본 파일을 직접 선택하세요.'; }
})().catch(showError);
