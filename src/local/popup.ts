import { appStorage, DOWNLOAD_OPTIONS_KEY } from '../data/database.ts';
import { record } from '../security/validation.ts';
import { SCOPE, isActiveHistoryState, isHistory, type HistoryItem, type MediaItem } from './model.ts';
import { downloadOptions } from './preferences.ts';
import { internalScanPresentation } from './labels.ts';
import { mediaCopyButton } from './media-copy.ts';

function node<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error('Missing ' + id);
  return element as T;
}
const status = node('status');
const pendingDownloads = new Set<string>();
const rows = new Map<string, MediaRow>();
let selectedOptions = downloadOptions();
let preferencesLoaded = false;
let refreshing = false;
let currentItems: MediaItem[] = [];
let currentHistory: HistoryItem[] = [];
interface MediaRow {
  item: MediaItem;
  row: HTMLLIElement;
  title: HTMLParagraphElement;
  detail: HTMLParagraphElement;
  download: HTMLButtonElement;
  downloadLabel: HTMLSpanElement;
  copyURL: HTMLButtonElement;
}
function message(text: string, tone: 'info' | 'warning' | 'error' = 'info') { status.textContent = text; status.dataset.tone = tone; status.hidden = !text; }
function showError(error: unknown) { message(error instanceof Error ? error.message : '요청 중 오류가 발생했습니다.', 'error'); }
async function request(type: string, data: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result: unknown = await chrome.runtime.sendMessage({ scope: SCOPE, type, ...data });
  if (!record(result) || result.ok !== true) throw new Error(record(result) && typeof result.error === 'string' ? result.error : '확장 프로그램을 다시 로드하고 페이지를 새로고침하세요.');
  return result;
}
function isMedia(value: unknown): value is MediaItem {
  return record(value) && typeof value.id === 'string' && typeof value.url === 'string'
    && typeof value.title === 'string' && typeof value.mime === 'string'
    && ['file', 'hls', 'dash'].includes(String(value.kind))
    && typeof value.tabId === 'number' && typeof value.createdAt === 'number';
}
const preferencesReady = (async () => {
  try {
    if (!chrome.extension.inIncognitoContext) selectedOptions = downloadOptions((await appStorage.get(DOWNLOAD_OPTIONS_KEY))[DOWNLOAD_OPTIONS_KEY]);
  } catch { message('저장된 다운로드 설정을 불러오지 못했습니다. 최고 화질·원본 형식으로 다운로드합니다.', 'warning'); }
  finally { preferencesLoaded = true; renderMedia(); }
})();
function matchingDownload(entry: HistoryItem): boolean {
  return isActiveHistoryState(entry.state)
    && (entry.options?.quality ?? 'highest') === selectedOptions.quality
    && (entry.options?.output ?? 'original') === selectedOptions.output;
}
function activeDownload(item: MediaItem): boolean { return currentHistory.some(entry => entry.url === item.url && matchingDownload(entry)); }
function mediaDetail(item: MediaItem): string {
  let host = '';
  try { host = new URL(item.url).hostname; } catch {}
  const kind = item.kind === 'hls' ? 'HLS' : item.kind === 'dash' ? 'DASH' : item.mime.startsWith('audio/') ? '오디오' : '미디어';
  const size = typeof item.size === 'number' && item.size > 0 ? ' · ' + (item.size / 1024 / 1024).toFixed(1) + ' MB' : '';
  return kind + (host ? ' · ' + host : '') + size;
}
function icon(pathData: string, viewBox = '0 0 24 24'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', viewBox); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathData); svg.append(path); return svg;
}
function createRow(item: MediaItem): MediaRow {
  const row = document.createElement('li'); row.className = 'media-row'; row.dataset.rowId = item.id;
  const marker = document.createElement('span'); marker.className = 'media-marker'; marker.setAttribute('aria-hidden', 'true');
  marker.append(icon('M5 4h14v16H5zM10 8l5 4-5 4z'));
  const copy = document.createElement('div'); copy.className = 'media-copy';
  const title = document.createElement('p'); title.className = 'media-title';
  const detail = document.createElement('p'); detail.className = 'media-detail';
  const download = document.createElement('button'); download.className = 'download-button'; download.dataset.action = 'download';
  const downloadLabel = document.createElement('span');
  download.append(icon('M12 4v11m-4-4 4 4 4-4M5 16v4h14v-4'), downloadLabel);
  const entry: MediaRow = { item, row, title, detail, download, downloadLabel, copyURL: undefined! };
  entry.copyURL = mediaCopyButton(() => entry.item, message); entry.copyURL.className = 'download-button copy-url-button';
  copy.append(title, detail); row.append(marker, copy, entry.copyURL, download);
  download.addEventListener('click', () => { void startDownload(entry.item); });
  return entry;
}
function renderMedia() {
  const list = node('media');
  const focused = document.activeElement;
  const focusedButton = focused instanceof HTMLButtonElement && list.contains(focused) ? focused : undefined;
  const retained = new Set<string>();
  const activeURLs = new Set(currentHistory.filter(matchingDownload).map(entry => entry.url));
  let cursor = list.firstElementChild;
  for (const item of currentItems) {
    if (retained.has(item.id)) continue;
    retained.add(item.id);
    const entry = rows.get(item.id) ?? createRow(item); rows.set(item.id, entry); entry.item = item;
    entry.title.textContent = item.title || '제목 없는 미디어'; entry.title.title = item.title || '제목 없는 미디어';
    entry.detail.textContent = mediaDetail(item);
    entry.copyURL.setAttribute('aria-label', (item.title || '미디어') + ' 주소 복사');
    const busy = pendingDownloads.has(item.id) || activeURLs.has(item.url);
    entry.downloadLabel.textContent = busy ? '처리 중' : '다운로드'; entry.download.disabled = busy || !preferencesLoaded;
    entry.download.setAttribute('aria-label', (item.title || '제목 없는 미디어') + (busy ? ' 처리 중' : ' 다운로드'));
    entry.download.setAttribute('aria-busy', String(busy));
    if (entry.row === cursor) cursor = cursor.nextElementSibling;
    else list.insertBefore(entry.row, cursor);
  }
  for (const [id, entry] of rows) if (!retained.has(id)) { entry.row.remove(); rows.delete(id); }
  if (focusedButton?.isConnected && !focusedButton.disabled && document.activeElement !== focusedButton) focusedButton.focus({ preventScroll: true });
  node('waiting').hidden = retained.size > 0; node('media-view').hidden = retained.size === 0; node('media-count').textContent = retained.size + '개';
  const reviews = currentHistory.filter(entry => entry.state === 'review').length;
  const summary = node<HTMLButtonElement>('review-summary'); summary.hidden = reviews === 0;
  const internalRisks = currentHistory.filter(entry => entry.state === 'review' && internalScanPresentation(entry.internalScan).tone === 'danger').length;
  summary.textContent = '확인이 필요한 다운로드 ' + reviews + '개' + (internalRisks ? ' · 내부 위험 신호 ' + internalRisks + '개' : '') + ' · 기록에서 검토';
}
function applyResult(result: Record<string, unknown>) {
  currentItems = Array.isArray(result.items) ? result.items.filter(isMedia) : [];
  currentHistory = Array.isArray(result.history) ? result.history.filter(isHistory) : [];
  renderMedia();
}
async function refresh() {
  if (refreshing) return; refreshing = true;
  try { applyResult(await request('list')); } catch (error) { showError(error); }
  finally { refreshing = false; }
}
async function startDownload(item: MediaItem) {
  if (pendingDownloads.has(item.id) || activeDownload(item)) return;
  pendingDownloads.add(item.id); renderMedia();
  try {
    await preferencesReady; message('');
    const result = await request('download', { id: item.id, options: selectedOptions });
    const started = result.item;
    if (isHistory(started)) currentHistory = [started, ...currentHistory.filter(entry => entry.id !== started.id)];
    message('다운로드를 시작했습니다. 진행 상황은 기록에서 확인할 수 있습니다.');
    await refresh();
  } catch (error) { showError(error); }
  finally { pendingDownloads.delete(item.id); renderMedia(); }
}
async function openApp(history = false) { await chrome.tabs.create({ url: chrome.runtime.getURL('local/index.html' + (history ? '?view=history' : '')) }); }
function action(id: string, run: () => Promise<unknown>) {
  const button = node<HTMLButtonElement>(id);
  button.addEventListener('click', () => {
    if (button.disabled) return; button.disabled = true;
    void run().catch(showError).finally(() => { button.disabled = false; });
  });
}
action('settings', () => openApp());
action('history', () => openApp(true));
action('review-summary', () => openApp(true));
action('folder', async () => { await chrome.downloads.showDefaultFolder(); });
action('upscale', async () => { await request('upscale'); });
action('clear-history', async () => {
  await request('clear-history'); message('완료된 기록만 삭제했습니다. 저장한 파일과 진행·검토 중인 기록은 유지됩니다.'); await refresh();
});
action('rescan', async () => {
  if (refreshing) { message('미디어 목록을 불러오는 중입니다. 잠시 뒤 다시 감지해 주세요.'); return; }
  message('현재 페이지에서 미디어를 다시 감지하고 있습니다…'); refreshing = true;
  try {
    applyResult(await request('rescan'));
    message(currentItems.length ? '현재 페이지의 미디어를 다시 감지했습니다.' : '감지된 미디어가 없습니다. 영상을 재생한 뒤 다시 시도해 주세요.');
  } finally { refreshing = false; }
});
const dialog = node<HTMLDialogElement>('info-dialog');
function showInfo(report: boolean) {
  node('info-title').textContent = report ? '미디어 감지 신고' : '미디어 감지 도움말';
  node('info-description').textContent = report
    ? '감지되지 않는 페이지 주소와 재현 방법을 메모할 수 있습니다. 메모는 이 팝업에서만 유지되며 자동으로 전송하거나 저장하지 않습니다.'
    : '영상이 있는 페이지에서 영상을 재생한 뒤 강제 감지를 눌러 주세요.\nHTTP 미디어와 암호화되지 않은 HLS·DASH VOD를 지원합니다. DRM과 라이브 녹화는 지원하지 않습니다.\n설정에서 화질·저장 형식을 선택하고, 기록에서 진행 상황과 검토가 필요한 파일을 확인할 수 있습니다.\n앱 내부에서 파일 위장과 위험 신호를 보조 검사하며 파일을 외부로 전송하지 않습니다. 전체 악성코드 DB 검사는 아니며, 신호 없음이 안전을 보장하지 않습니다.';
  node('report-label').hidden = !report; node('report-notes').hidden = !report; dialog.showModal();
}
node('help').addEventListener('click', () => showInfo(false));
node('report').addEventListener('click', () => showInfo(true));
node('dismiss-hint').addEventListener('click', () => { node('discovery-card').hidden = true; });
void refresh();
const poll = setInterval(() => { if (!document.hidden) void refresh(); }, 1500);
window.addEventListener('pagehide', () => { clearInterval(poll); }, { once: true });
