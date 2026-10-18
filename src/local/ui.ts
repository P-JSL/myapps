import { record } from '../security/validation.ts';
import { SCOPE, isHistory, type MediaItem, type HistoryItem } from './model.ts';
import { downloadOptions } from './preferences.ts';

function node<T extends HTMLElement>(id: string): T { const element = document.getElementById(id); if (!element) throw new Error(`Missing ${id}`); return element as T; }
const status = node('status');
let refreshing = false;
let hasError = false;
async function request(type: string, data: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result: unknown = await chrome.runtime.sendMessage({ scope: SCOPE, type, ...data });
  if (!record(result) || result.ok !== true) throw new Error(record(result) && typeof result.error === 'string' ? result.error : '확장 프로그램을 다시 로드하고 페이지를 새로고침하세요.');
  return result;
}
function error(value: unknown) { hasError = true; status.textContent = value instanceof Error ? value.message : '요청 중 오류가 발생했습니다.'; }
function options() { return downloadOptions({ quality: node<HTMLSelectElement>('quality').value, output: node<HTMLSelectElement>('download-output').value }); }
function button(text: string, action: () => Promise<unknown>, secondary = false): HTMLButtonElement {
  const element = document.createElement('button'); element.textContent = text; if (secondary) element.className = 'secondary';
  element.addEventListener('click', () => { hasError = false; element.disabled = true; void action().then(() => refresh()).catch(error).finally(() => { element.disabled = false; }); });
  return element;
}
function mediaRow(item: MediaItem) {
  const row = document.createElement('li');
  const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = item.kind === 'file' ? 'MEDIA FILE' : `${item.kind.toUpperCase()} · VOD`;
  const title = document.createElement('h3'); title.textContent = item.title || new URL(item.url).pathname.split('/').at(-1) || '미디어';
  const source = document.createElement('p'); source.textContent = new URL(item.url).hostname + (item.size ? ` · ${(item.size / 1024 / 1024).toFixed(1)} MiB` : '');
  const controls = document.createElement('div'); controls.className = 'actions';
  controls.append(button('다운로드', async () => { await request('download', { id: item.id, options: options() }); status.textContent = '파일을 준비하고 있습니다. 기록 탭에서 진행 상태를 확인하세요.'; }));
  row.append(kind, title, source, controls); return row;
}
const stateLabels = { preparing: '파일 준비 중', downloading: '다운로드 중', complete: '완료', cancelled: '취소됨', error: '실패' };
function historyRow(item: HistoryItem) {
  const row = document.createElement('li'); const title = document.createElement('h3'); title.textContent = item.filename;
  const info = document.createElement('p'); info.textContent = `${stateLabels[item.state]} · ${new Date(item.createdAt).toLocaleString('ko-KR')}`;
  row.append(title, info);
  if (item.error) { const message = document.createElement('p'); message.textContent = item.error; row.append(message); }
  const controls = document.createElement('div'); controls.className = 'actions';
  if (item.state === 'complete') controls.append(button('저장 폴더', () => request('show-file', { id: item.id }), true));
  if (item.state === 'downloading' || item.state === 'preparing') controls.append(button('취소', () => request('cancel', { id: item.id }), true));
  row.append(controls); return row;
}
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    const result = await request('list');
    const media = Array.isArray(result.items) ? result.items.filter((item): item is MediaItem => record(item) && typeof item.id === 'string' && typeof item.url === 'string' && typeof item.title === 'string' && ['file', 'hls', 'dash'].includes(String(item.kind))) : [];
    const history = Array.isArray(result.history) ? result.history.filter(isHistory) : [];
    node('media').replaceChildren(...media.map(mediaRow)); node('empty').hidden = media.length > 0;
    node('history').replaceChildren(...history.map(historyRow)); node('history-empty').hidden = history.length > 0;
    const active = history.filter(row => row.state === 'preparing' || row.state === 'downloading').length;
    if (!hasError) status.textContent = active ? `${active}개 파일 처리 중 · 기록 탭에서 확인하세요.` : `${media.length}개 미디어 · 이 브라우저에만 기록을 저장합니다.`;
  } finally { refreshing = false; }
}
function show(history: boolean) {
  node('media-view').hidden = history; node('history-view').hidden = !history;
  node('media-tab').setAttribute('aria-pressed', String(!history)); node('history-tab').setAttribute('aria-pressed', String(history));
  void refresh().catch(error);
}
node('media-tab').addEventListener('click', () => show(false));
node('history-tab').addEventListener('click', () => show(true));
node('refresh').addEventListener('click', () => { hasError = false; void refresh().catch(error); });
node('upscale').addEventListener('click', () => { void request('upscale').catch(error); });
node('clear-history').addEventListener('click', () => { void request('clear-history').then(refresh).catch(error); });
node('url-form').addEventListener('submit', event => {
  event.preventDefault();
  const url = node<HTMLInputElement>('url').value;
  void request('download-url', { url, options: options() }).then(() => { hasError = false; status.textContent = '파일을 준비하고 있습니다.'; show(true); }).catch(error);
});
const timer = setInterval(() => { if (!document.hidden) void refresh().catch(error); }, 2000);
addEventListener('pagehide', () => clearInterval(timer), { once: true });
void refresh().catch(error);
