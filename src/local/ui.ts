import { record } from '../security/validation.ts';
import { appStorage, DOWNLOAD_OPTIONS_KEY } from '../data/database.ts';
import { SCOPE, isHistory, type MediaItem, type HistoryItem } from './model.ts';
import { downloadOptions } from './preferences.ts';
import { transport, transportLabel } from './transport.ts';
import { HISTORY_STATE_LABELS, PREPARATION_STAGE_LABELS, SECURITY_STATUS_LABELS, internalScanPresentation, formatBytes } from './labels.ts';
import { mediaCopyButton } from './media-copy.ts';

function node<T extends HTMLElement>(id: string): T { const element = document.getElementById(id); if (!element) throw new Error(`Missing ${id}`); return element as T; }
const status = node('status');
let refreshing = false;
let hasError = false;
let preferencesTouched = false;
const deferredReviews = new Set<string>();
const securityDialog = node<HTMLDialogElement>('security-dialog');
let activeReview: HistoryItem | undefined;
let reviewBusy = false;
let antivirusEnabled: boolean | undefined;
let antivirusSettingsBusy = false;
let antivirusConnecting = false;
let antivirusSettingsEpoch = 0;
let antivirusSettingsPending: Promise<void> | undefined;
let folderConfirmed: boolean | undefined;
let folderSettingsBusy = false;
let folderOpening = false;
let folderSettingsEpoch = 0;
let folderSettingsPending: Promise<void> | undefined;
async function request(type: string, data: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result: unknown = await chrome.runtime.sendMessage({ scope: SCOPE, type, ...data });
  if (!record(result) || result.ok !== true) throw new Error(record(result) && typeof result.error === 'string' ? result.error : '확장 프로그램을 다시 로드하고 페이지를 새로고침하세요.');
  return result;
}
function error(value: unknown) { hasError = true; status.textContent = value instanceof Error ? value.message : '요청 중 오류가 발생했습니다.'; }
function folderControls() {
  const confirmed = folderConfirmed === true;
  const checkbox = node<HTMLInputElement>('download-folder-acknowledge');
  checkbox.disabled = folderSettingsBusy || folderConfirmed === undefined;
  node('download-folder-acknowledgement').hidden = confirmed;
  node<HTMLButtonElement>('download-folder-confirm').hidden = confirmed;
  node<HTMLButtonElement>('download-folder-confirm').disabled = folderSettingsBusy || folderConfirmed === undefined || !checkbox.checked;
  node<HTMLButtonElement>('download-folder-change').disabled = folderOpening || folderSettingsBusy;
  node('download-folder').setAttribute('aria-busy', String(folderSettingsBusy));
}
function folderStatus(text: string, tone = '') {
  const hint = node('download-folder-status'); hint.textContent = text; hint.dataset.tone = tone;
}
function refreshFolderSettings(): Promise<void> {
  if (folderSettingsBusy) return Promise.resolve();
  if (folderSettingsPending) return folderSettingsPending;
  const epoch = folderSettingsEpoch;
  folderSettingsPending = (async () => {
    try {
      const result = await request('download-folder-settings');
      if (typeof result.confirmed !== 'boolean') throw new Error('저장 폴더 설정 응답을 확인할 수 없습니다.');
      if (epoch !== folderSettingsEpoch || folderSettingsBusy) return;
      folderConfirmed = result.confirmed;
      folderStatus(result.confirmed
        ? `사용자의 최초 설정 확인을 ${chrome.extension.inIncognitoContext ? '시크릿 창 메모리에만 적용했습니다' : '이 브라우저에 저장했습니다'}. 실제 경로와 매번 묻기 상태는 Chrome 설정에서 확인하세요. 다운로드하려던 화면에서 다시 다운로드를 누르면 지정한 폴더로 저장합니다.`
        : '아직 최초 설정을 완료하지 않았습니다. 위의 두 설정을 확인하고 체크한 뒤 최초 설정 완료를 누르세요. 다운로드는 그다음에 시작할 수 있습니다.', result.confirmed ? 'ready' : '');
      node('download-folder-retry').hidden = true;
    } catch (value) {
      if (epoch !== folderSettingsEpoch || folderSettingsBusy) return;
      folderConfirmed = undefined;
      folderStatus(`저장 폴더의 최초 설정 여부를 확인하지 못했습니다. 설정을 다시 불러온 뒤 완료해 주세요.${value instanceof Error ? ` ${value.message}` : ''}`, 'error');
      node('download-folder-retry').hidden = false;
    }
    folderControls();
  })().finally(() => { folderSettingsPending = undefined; });
  return folderSettingsPending;
}
function showFolderSetup(result: Record<string, unknown>): boolean {
  if (result.setupRequired !== true) return false;
  hasError = true;
  status.textContent = '첫 다운로드 전에 저장 폴더 설정을 완료해 주세요. 완료한 뒤 다운로드를 다시 눌러 주세요.';
  const section = node('download-folder'); section.scrollIntoView({ block: 'start' }); section.focus({ preventScroll: true });
  void refreshFolderSettings();
  return true;
}
function antivirusControls() {
  const toggle = node<HTMLInputElement>('antivirus-enabled');
  if (!antivirusSettingsBusy) toggle.checked = antivirusEnabled ?? true;
  toggle.disabled = antivirusSettingsBusy || antivirusEnabled === undefined;
  toggle.setAttribute('aria-checked', String(toggle.checked));
  node('antivirus-toggle-state').textContent = antivirusSettingsBusy ? '저장 중…' : antivirusEnabled === undefined ? '확인 필요' : antivirusEnabled ? 'ON' : 'OFF';
  node('antivirus-setting').setAttribute('aria-busy', String(antivirusSettingsBusy));
  node<HTMLButtonElement>('security-connect').disabled = antivirusEnabled !== true || antivirusSettingsBusy || antivirusConnecting;
  node<HTMLButtonElement>('security-rescan').disabled = reviewBusy || antivirusEnabled !== true || antivirusSettingsBusy;
}
function applyAntivirusSetting(enabled: boolean) {
  const changed = antivirusEnabled !== enabled;
  antivirusEnabled = enabled;
  if (changed) {
    antivirusSettingsEpoch++;
    node('security-connection-status').textContent = enabled
      ? '백신 연동 ON · 도우미 설치 후 백신 연결을 눌러 검사기의 준비 상태를 확인하세요.'
      : '백신 연동 OFF · 앱에서 백신 도우미를 호출하지 않습니다. 브라우저 내부 위험 검사와 Chrome 기본 보호는 계속 적용됩니다.';
  }
  antivirusControls();
}
function refreshAntivirusSettings(): Promise<void> {
  if (antivirusSettingsBusy) return Promise.resolve();
  if (antivirusSettingsPending) return antivirusSettingsPending;
  const epoch = antivirusSettingsEpoch;
  antivirusSettingsPending = (async () => {
    try {
      const result = await request('antivirus-settings');
      if (typeof result.enabled !== 'boolean') throw new Error('백신 연동 설정 응답을 확인할 수 없습니다.');
      if (epoch !== antivirusSettingsEpoch || antivirusSettingsBusy) return;
      applyAntivirusSetting(result.enabled);
      node('antivirus-settings-status').textContent = chrome.extension.inIncognitoContext
        ? '시크릿 창의 선택은 메모리에서만 유지하며 일반 창의 설정을 읽거나 변경하지 않습니다.'
        : '백신 연동 선택은 이 브라우저에 저장되며 다음에도 적용됩니다.';
      node('antivirus-settings-retry').hidden = true;
    } catch (value) {
      if (epoch !== antivirusSettingsEpoch || antivirusSettingsBusy) return;
      antivirusEnabled = undefined;
      node('antivirus-settings-status').textContent = `백신 연동 설정을 확인하지 못했습니다. 설정을 다시 불러온 뒤 변경하거나 연결하세요.${value instanceof Error ? ` ${value.message}` : ''}`;
      node('antivirus-settings-retry').hidden = false;
      antivirusControls();
    }
  })().finally(() => { antivirusSettingsPending = undefined; });
  return antivirusSettingsPending;
}
async function refreshDatabaseStatus() {
  const hint = node('database-status');
  if (chrome.extension.inIncognitoContext) {
    hint.textContent = '시크릿 창의 기록은 메모리에서만 관리하며 일반 창의 내장 DB와 저장 설정을 읽거나 변경하지 않습니다.';
    return;
  }
  try {
    const database = await appStorage.status();
    const parts = [`내장 DB v${database.version} 준비됨`, `다운로드 기록 ${database.historyCount}개`, `임시 복사본 기록 ${database.jobCount}개`];
    if (database.lastMaintenanceAt !== null) parts.push(`최근 자동 정리 ${new Date(database.lastMaintenanceAt).toLocaleString('ko-KR')}`);
    if (database.legacyCleanupPending) parts.push('이전 데이터의 원본 정리를 다음 실행에서 다시 시도합니다.');
    if (database.recoveryCount > 0) parts.push(`확인이 필요한 이전 데이터 ${database.recoveryCount}개를 보존하고 있어 파일 자동 정리와 완료 후 자동 확대 제안을 보류합니다.`);
    hint.textContent = parts.join(' · ');
  } catch (value) {
    hint.textContent = `내장 DB를 확인하지 못했습니다. 자동 파일 정리를 중단하고 기존 데이터를 보존합니다.${value instanceof Error ? ` ${value.message}` : ''}`;
  }
}
function options() { return downloadOptions({ quality: node<HTMLSelectElement>('quality').value, output: node<HTMLSelectElement>('download-output').value }); }
const preferencesReady = (async () => {
  const hint = node('download-preferences-status');
  if (chrome.extension.inIncognitoContext) {
    hint.textContent = '시크릿 창의 화질·저장 형식은 이 화면에서만 사용하며 설정을 저장하거나 불러오지 않습니다.';
    return;
  }
  try {
    const saved: unknown = (await appStorage.get(DOWNLOAD_OPTIONS_KEY))[DOWNLOAD_OPTIONS_KEY];
    const restored = downloadOptions(saved);
    if (preferencesTouched) return;
    node<HTMLSelectElement>('quality').value = restored.quality;
    node<HTMLSelectElement>('download-output').value = restored.output;
  } catch {
    hint.textContent = '저장된 설정을 불러오지 못했습니다. 현재 화질·저장 형식으로 다운로드할 수 있습니다.';
  }
})();
for (const id of ['quality', 'download-output']) node(id).addEventListener('change', () => {
  preferencesTouched = true;
  if (chrome.extension.inIncognitoContext) return;
  const selected = options();
  void preferencesReady.then(() => appStorage.set({ [DOWNLOAD_OPTIONS_KEY]: selected })).then(() => {
    node('download-preferences-status').textContent = '화질·저장 형식 선택을 이 브라우저에 저장했습니다.';
  }).catch(() => {
    node('download-preferences-status').textContent = '설정을 저장하지 못했습니다. 현재 선택으로 다운로드할 수 있습니다.';
  });
});
function button(text: string, action: () => Promise<unknown>, secondary = false, actionKey = text): HTMLButtonElement {
  const element = document.createElement('button'); element.textContent = text; if (secondary) element.className = 'secondary';
  element.dataset.action = actionKey;
  element.addEventListener('click', () => { hasError = false; element.disabled = true; void action().then(() => refresh()).catch(error).finally(() => { element.disabled = false; }); });
  return element;
}
const rowCaches = new Map<string, Map<string, { signature: string; row: HTMLLIElement }>>();
function replaceRows<T extends { id: string }>(id: string, items: T[], render: (item: T) => HTMLLIElement) {
  const list = node(id);
  const focused = document.activeElement;
  const focusedButton = focused instanceof HTMLButtonElement && list.contains(focused) ? focused : undefined;
  const rowId = focusedButton?.closest<HTMLLIElement>('li[data-row-id]')?.dataset.rowId;
  const action = focusedButton?.dataset.action;
  // Malformed duplicate IDs still render as separate rows; one DOM node must
  // never stand in for multiple entries in a list.
  const previous = new Set(items.map(item => item.id)).size === items.length ? rowCaches.get(id) : undefined;
  const current = new Map<string, { signature: string; row: HTMLLIElement }>();
  const rows = items.map(item => {
    const signature = JSON.stringify(item);
    const cached = previous?.get(item.id);
    const entry = cached?.signature === signature ? cached : { signature, row: render(item) };
    current.set(item.id, entry);
    return entry.row;
  });
  rowCaches.set(id, current);
  const retained = new Set<Element>(rows);
  for (let child = list.firstElementChild; child;) {
    const next = child.nextElementSibling;
    if (!retained.has(child)) child.remove();
    child = next;
  }
  let cursor = list.firstElementChild;
  for (const row of rows) {
    if (row === cursor) cursor = cursor.nextElementSibling;
    else list.insertBefore(row, cursor);
  }
  while (cursor) { const next = cursor.nextElementSibling; cursor.remove(); cursor = next; }
  // Refreshing progress must not interrupt keyboard navigation or move focus from outside this list.
  if (focusedButton && document.activeElement !== focusedButton && rowId && action) {
    const row = rows.find(item => item.dataset.rowId === rowId);
    const replacement = Array.from(row?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(item => item.dataset.action === action && !item.disabled);
    replacement?.focus({ preventScroll: true });
  }
}
function mediaRow(item: MediaItem) {
  const row = document.createElement('li'); row.dataset.rowId = item.id;
  const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = item.kind === 'file' ? 'MEDIA FILE' : `${item.kind.toUpperCase()} · VOD`;
  const title = document.createElement('h3'); title.textContent = item.title || new URL(item.url).pathname.split('/').at(-1) || '미디어';
  const source = document.createElement('p'); source.textContent = new URL(item.url).hostname + (item.size ? ` · ${formatBytes(item.size)}` : '');
  const observed = transport(item.observedTransport); if (observed) source.textContent += ` · 페이지 연결 ${transportLabel(observed)}`;
  const controls = document.createElement('div'); controls.className = 'actions';
  controls.append(button('다운로드', async () => {
    await preferencesReady;
    const result = await request('download', { id: item.id, options: options() });
    if (showFolderSetup(result)) return;
    status.textContent = '파일을 준비하고 있습니다. 기록 탭에서 진행 상태를 확인하세요.';
  }, false, 'download'));
  const copy = mediaCopyButton(() => item, message => { status.textContent = message; }); copy.className = 'secondary'; controls.append(copy);
  row.append(kind, title, source, controls); return row;
}
function closeReview(defer = false) {
  if (defer && activeReview?.security?.token) deferredReviews.add(activeReview.security.token);
  if (securityDialog.open) securityDialog.close();
  activeReview = undefined;
  node<HTMLInputElement>('security-acknowledge').checked = false;
}
function reviewControls() {
  const chromeWarning = activeReview?.security?.status === 'chrome-warning';
  node<HTMLButtonElement>('security-delete').disabled = reviewBusy;
  node<HTMLButtonElement>('security-rescan').disabled = reviewBusy || antivirusEnabled !== true || antivirusSettingsBusy;
  node<HTMLButtonElement>('security-chrome').disabled = reviewBusy;
  node<HTMLInputElement>('security-acknowledge').disabled = reviewBusy;
  node<HTMLButtonElement>('security-keep').disabled = reviewBusy || chromeWarning || !node<HTMLInputElement>('security-acknowledge').checked;
  node<HTMLButtonElement>('security-later').disabled = reviewBusy;
}
function openReview(item: HistoryItem) {
  if (!item.security || reviewBusy) return;
  closeReview(); activeReview = item;
  const security = item.security;
  const chromeWarning = security.status === 'chrome-warning';
  const internal = internalScanPresentation(item.internalScan);
  const internalRisk = internal.tone === 'danger';
  node('security-filename').textContent = item.filename;
  node('security-result').textContent = internalRisk && !chromeWarning && security.status !== 'infected'
    ? internal.label : SECURITY_STATUS_LABELS[security.status];
  node('security-explanation').textContent = chromeWarning
    ? 'Chrome이 다운로드에 위험을 표시했습니다. Chrome 다운로드 화면에서 경고를 확인하세요. 이 앱은 Chrome의 경고를 자동으로 해제하지 않으며, 확인 전에는 완료 처리나 업스케일링을 진행하지 않습니다.'
    : internalRisk ? '내부 검사에서 위험 신호를 확인했습니다. 파일은 이미 디스크에 저장되어 있으며 확인 전에는 완료 처리나 자동 업스케일링을 진행하지 않습니다. 외부 백신의 미탐지와 별개로 삭제하거나 다시 검사하세요. 내부 신호는 악성코드 확정 판정이 아닙니다.'
    : '파일은 이미 디스크에 저장되어 있습니다. 확인 전에는 앱에서 완료 처리나 업스케일링을 진행하지 않습니다. 위협을 탐지했거나 검사를 완료하지 못한 파일은 삭제를 권장합니다. 미탐지 결과도 파일의 안전을 보장하지 않습니다.';
  const details = node('security-details');
  details.replaceChildren();
  const detail = (label: string, value: string | undefined) => {
    if (!value) return;
    const line = document.createElement('p'); line.textContent = `${label}: ${value}`; details.append(line);
  };
  detail('로컬 백신·Chrome 결과', SECURITY_STATUS_LABELS[security.status]);
  const internalResult = document.createElement('p');
  internalResult.className = 'internal-scan-summary'; internalResult.dataset.tone = internal.tone; internalResult.textContent = internal.label; details.append(internalResult);
  detail('내부 검사 범위', internal.scope);
  detail('내부 검사 안내', internal.explanation);
  if (internal.findings.length) {
    const findings = document.createElement('ul'); findings.className = 'internal-findings'; findings.dataset.tone = internal.tone;
    findings.setAttribute('aria-label', internal.tone === 'danger' ? '내부 검사 위험 신호' : '내부 검사 범위 안내');
    for (const message of internal.findings) { const line = document.createElement('li'); line.textContent = message; findings.append(line); }
    details.append(findings);
  }
  detail('검사 엔진', security.engine);
  detail('검사 안내', security.message);
  detail('Chrome 경고', security.danger);
  detail('SHA-256', security.sha256);
  if (typeof security.size === 'number' && Number.isFinite(security.size) && security.size >= 0) detail('검사 파일 크기', `${security.size.toLocaleString('ko-KR')} 바이트`);
  if (typeof security.checkedAt === 'number' && Number.isFinite(security.checkedAt)) detail('검사 시각', new Date(security.checkedAt).toLocaleString('ko-KR'));
  const threats = node('security-threats'); threats.replaceChildren();
  for (const threat of security.threats?.slice(0, 20) ?? []) { const line = document.createElement('li'); line.textContent = threat; threats.append(line); }
  threats.hidden = !threats.childElementCount;
  node('security-native-actions').hidden = chromeWarning;
  node('security-acknowledgement').hidden = chromeWarning;
  node('security-chrome').hidden = !chromeWarning;
  node('security-dialog-error').textContent = '';
  reviewControls();
  securityDialog.showModal();
  node<HTMLButtonElement>(chromeWarning ? 'security-chrome' : 'security-delete').focus();
}
async function securityAction(type: string, extra: Record<string, unknown> = {}) {
  const item = activeReview;
  if (!item?.security || reviewBusy) return;
  reviewBusy = true; reviewControls(); node('security-dialog-error').textContent = '';
  try {
    await request(type, { id: item.id, token: item.security.token, ...extra });
    closeReview(true);
  } catch (value) {
    node('security-dialog-error').textContent = value instanceof Error ? value.message : '보안 확인 요청에 실패했습니다.';
  } finally { reviewBusy = false; reviewControls(); }
  await refresh().catch(error);
}
function historyRow(item: HistoryItem) {
  const row = document.createElement('li'); row.dataset.rowId = item.id; const title = document.createElement('h3'); title.textContent = item.filename;
  const info = document.createElement('p'); info.textContent = `${HISTORY_STATE_LABELS[item.state]} · ${new Date(item.createdAt).toLocaleString('ko-KR')}`;
  if (item.state === 'preparing' && item.preparation) {
    const label = PREPARATION_STAGE_LABELS[item.preparation.stage];
    if (label) info.textContent += ` · ${label}`;
    if (typeof item.preparation.progress === 'number' && Number.isFinite(item.preparation.progress)) info.textContent += ` ${Math.round(Math.max(0, Math.min(1, item.preparation.progress)) * 100)}%`;
    if (typeof item.preparation.loaded === 'number' && item.preparation.loaded >= 0) {
      info.textContent += ` · ${formatBytes(item.preparation.loaded)}`;
      if (typeof item.preparation.total === 'number' && item.preparation.total > 0) info.textContent += ` / ${formatBytes(item.preparation.total)}`;
    }
  }
  if (item.state === 'downloading' && typeof item.receivedBytes === 'number' && item.receivedBytes >= 0) {
    info.textContent += ` · ${formatBytes(item.receivedBytes)}`;
    if (typeof item.totalBytes === 'number' && item.totalBytes > 0) info.textContent += ` / ${formatBytes(item.totalBytes)}`;
  }
  row.append(title, info);
  const security = document.createElement('p'); security.className = 'security-summary';
  security.textContent = item.security ? SECURITY_STATUS_LABELS[item.security.status] : '검사 기록 없음';
  if (item.security?.engine) security.textContent += ` · ${item.security.engine}`;
  if (item.security?.decision === 'keep') security.textContent += ' · 위험 안내 확인 후 사용자가 유지함';
  if (item.security?.decision === 'delete') security.textContent += ' · 사용자가 파일 삭제를 선택함';
  row.append(security);
  const internal = internalScanPresentation(item.internalScan);
  const internalSummary = document.createElement('p'); internalSummary.className = 'internal-scan-summary'; internalSummary.dataset.tone = internal.tone;
  internalSummary.textContent = internal.label + (internal.scope ? ` · ${internal.scope}` : ''); internalSummary.title = internal.explanation;
  row.append(internalSummary);
  const protocols = (Array.isArray(item.transferProtocols) ? item.transferProtocols : []).map(transport).filter(value => value !== undefined);
  if (protocols.length) { const connection = document.createElement('p'); connection.textContent = `준비 연결 ${protocols.map(transportLabel).join(', ')}`; row.append(connection); }
  if (item.error) { const message = document.createElement('p'); message.textContent = item.error; row.append(message); }
  const controls = document.createElement('div'); controls.className = 'actions';
  if (item.state === 'review' && item.security) controls.append(button('검사 결과 확인', async () => { openReview(item); }, true, 'security-review'));
  if (item.state === 'complete') controls.append(button('저장 폴더', () => request('show-file', { id: item.id }), true, 'show-file'));
  if (item.state === 'error' || item.state === 'cancelled') controls.append(button('다시 시도', async () => { showFolderSetup(await request('retry', { id: item.id })); }, true, 'retry'));
  if (item.state === 'downloading' || item.state === 'preparing') controls.append(button('취소', () => request('cancel', { id: item.id }), true, 'cancel'));
  row.append(controls); return row;
}
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    void refreshAntivirusSettings();
    void refreshFolderSettings();
    const result = await request('list');
    const media = Array.isArray(result.items) ? result.items.filter((item): item is MediaItem => record(item) && typeof item.id === 'string' && typeof item.url === 'string' && typeof item.title === 'string' && ['file', 'hls', 'dash'].includes(String(item.kind))) : [];
    const history = Array.isArray(result.history) ? result.history.filter(isHistory) : [];
    replaceRows('media', media, mediaRow); node('empty').hidden = media.length > 0;
    replaceRows('history', history, historyRow); node('history-empty').hidden = history.length > 0;
    if (activeReview && !reviewBusy && !history.some(row => row.id === activeReview?.id && row.state === 'review' && row.security?.token === activeReview?.security?.token)) closeReview();
    if (!activeReview && !reviewBusy) {
      const pending = history.find(row => row.state === 'review' && row.security && !deferredReviews.has(row.security.token));
      if (pending) openReview(pending);
    }
    const active = history.filter(row => ['preparing', 'downloading', 'scanning'].includes(row.state)).length;
    const pending = history.filter(row => row.state === 'review').length;
    if (!hasError) status.textContent = pending ? `${pending}개 파일의 보안 확인이 필요합니다. 기록 탭에서 확인하세요.` : active ? `${active}개 파일 처리 중 · 기록 탭에서 확인하세요.` : `${media.length}개 미디어 · 이 브라우저에만 기록을 저장합니다.`;
  } finally { refreshing = false; }
}
function show(history: boolean) {
  node('media-view').hidden = history; node('history-view').hidden = !history;
  node('media-tab').setAttribute('aria-pressed', String(!history)); node('history-tab').setAttribute('aria-pressed', String(history));
  void refresh().catch(error);
}
node('media-tab').addEventListener('click', () => show(false));
node('history-tab').addEventListener('click', () => show(true));
node('refresh').addEventListener('click', () => { hasError = false; void refresh().catch(error); void refreshDatabaseStatus(); });
node('upscale').addEventListener('click', () => { void request('upscale').catch(error); });
node('clear-history').addEventListener('click', () => { void request('clear-history').then(refresh).catch(error); });
node('security-acknowledge').addEventListener('change', reviewControls);
node('security-delete').addEventListener('click', () => { void securityAction('security-delete'); });
node('security-rescan').addEventListener('click', () => { void securityAction('security-rescan'); });
node('security-chrome').addEventListener('click', () => { void securityAction('review-chrome'); });
node('security-keep').addEventListener('click', () => {
  if (!node<HTMLInputElement>('security-acknowledge').checked || activeReview?.security?.status === 'chrome-warning') return;
  void securityAction('security-keep', { confirmed: true });
});
node('security-later').addEventListener('click', () => { if (!reviewBusy) closeReview(true); });
securityDialog.addEventListener('cancel', event => { event.preventDefault(); if (!reviewBusy) closeReview(true); });
node('extension-id').textContent = chrome.runtime.id || '설치한 확장 프로그램의 ID를 chrome://extensions에서 확인하세요.';
function showAntivirusStatus(value: unknown) {
  if (!record(value) || !['ready', 'unavailable', 'error', 'disabled'].includes(String(value.status))
    || (value.internalAvailable !== undefined && typeof value.internalAvailable !== 'boolean')) throw new Error('백신 도우미의 준비 상태를 확인할 수 없습니다. 최신 도우미 설치 상태를 확인하세요.');
  if (value.status === 'disabled') {
    applyAntivirusSetting(false);
    return;
  }
  const parts = [value.status === 'ready' ? '도우미 연결됨 · 검사기 선택 확인'
    : value.internalAvailable === true ? '도우미 연결됨 · 내부 위험 검사 사용 가능'
    : value.status === 'unavailable' ? '백신 연결을 사용할 수 없습니다' : '백신 연결 확인에 실패했습니다'];
  if (value.internalAvailable === true && value.status !== 'ready') parts.push(value.status === 'unavailable' ? '로컬 백신: 연결되지 않음' : '로컬 백신: 준비 상태 확인 실패');
  if (typeof value.engine === 'string' && value.engine) parts.push(`검사 엔진: ${value.engine.slice(0, 120)}`);
  if (Array.isArray(value.products)) {
    const products = value.products.filter((item): item is string => typeof item === 'string').slice(0, 16).map(item => item.slice(0, 160));
    if (products.length) parts.push(`활성 보호 제품: ${products.join(', ')}`);
  }
  if (typeof value.message === 'string' && value.message) parts.push(value.message.slice(0, 1000));
  parts.push(value.status === 'ready' ? '파일 검사는 다운로드가 끝난 뒤 별도로 수행하며 결과는 기록 탭에서 확인하세요.'
    : value.internalAvailable === true ? '내부 검사와 별개로 로컬 백신 검사 결과는 확인되지 않았습니다. 파일은 기록에서 확인 대기 상태로 유지합니다.'
    : '도우미·백신 설치와 활성 상태를 확인하세요. 미검사 파일은 기록에서 확인 대기 상태로 유지합니다.');
  node('security-connection-status').textContent = parts.join(' · ');
}
node('security-connect').addEventListener('click', () => {
  if (antivirusEnabled !== true || antivirusSettingsBusy || antivirusConnecting) return;
  const epoch = antivirusSettingsEpoch;
  const connection = node('security-connection-status');
  antivirusConnecting = true; antivirusControls(); connection.textContent = '현재 백신 연동 설정을 확인하고 있습니다…';
  // Other windows can turn integration off before this window's next poll.
  // Check the authoritative setting before requesting an optional permission.
  void request('antivirus-settings').then(async settings => {
    if (typeof settings.enabled !== 'boolean') throw new Error('현재 백신 연동 설정을 확인할 수 없습니다.');
    if (epoch !== antivirusSettingsEpoch || antivirusEnabled !== true || antivirusSettingsBusy) return;
    applyAntivirusSetting(settings.enabled);
    if (!settings.enabled) return;
    if (!navigator.userActivation.isActive) {
      connection.textContent = '백신 연동 ON을 확인했습니다. 연결 권한을 요청하려면 백신 연결을 다시 눌러 주세요.';
      return;
    }
    connection.textContent = '로컬 백신 연결 권한을 확인하고 있습니다…';
    const granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
    if (epoch !== antivirusSettingsEpoch || antivirusEnabled !== true || antivirusSettingsBusy) return;
    if (!granted) { connection.textContent = '연결 권한을 허용하지 않았습니다. 검사되지 않은 파일은 기록에서 확인하세요.'; return; }
    connection.textContent = '설치된 백신 도우미와 검사기의 준비 상태를 확인하고 있습니다…';
    const result = await request('security-connect');
    if (epoch !== antivirusSettingsEpoch || antivirusEnabled !== true || antivirusSettingsBusy) return;
    showAntivirusStatus(result.antivirus);
    await refresh();
  }).catch(value => { if (epoch === antivirusSettingsEpoch) connection.textContent = value instanceof Error ? value.message : '로컬 백신 연결에 실패했습니다.'; }).finally(() => { antivirusConnecting = false; antivirusControls(); });
});
node('antivirus-enabled').addEventListener('change', () => {
  if (antivirusSettingsBusy || antivirusEnabled === undefined) { antivirusControls(); return; }
  const enabled = node<HTMLInputElement>('antivirus-enabled').checked;
  antivirusSettingsEpoch++;
  antivirusSettingsBusy = true;
  antivirusControls();
  node('antivirus-settings-status').textContent = '백신 연동 설정을 저장하고 있습니다…';
  void request('set-antivirus-enabled', { enabled }).then(result => {
    if (typeof result.enabled !== 'boolean') throw new Error('저장한 백신 연동 설정을 확인할 수 없습니다.');
    applyAntivirusSetting(result.enabled);
    node('antivirus-settings-status').textContent = chrome.extension.inIncognitoContext
      ? `백신 연동 ${result.enabled ? 'ON' : 'OFF'} · 시크릿 창 메모리에만 적용했습니다.`
      : `백신 연동 ${result.enabled ? 'ON' : 'OFF'} 설정을 저장했습니다.`;
    node('antivirus-settings-retry').hidden = true;
  }).catch(value => {
    antivirusEnabled = undefined;
    node('antivirus-settings-status').textContent = `백신 연동 설정의 저장 여부를 확인하지 못했습니다. 다시 불러와 실제 설정을 확인하세요.${value instanceof Error ? ` ${value.message}` : ''}`;
    node('antivirus-settings-retry').hidden = false;
  }).finally(() => { antivirusSettingsBusy = false; antivirusControls(); });
});
node('antivirus-settings-retry').addEventListener('click', () => { void refreshAntivirusSettings(); });
node('download-folder-acknowledge').addEventListener('change', folderControls);
node('download-folder-retry').addEventListener('click', () => { void refreshFolderSettings(); });
node('download-folder-change').addEventListener('click', () => {
  if (folderOpening || folderSettingsBusy) return;
  folderOpening = true; folderControls();
  void request('open-download-folder-settings').then(() => {
    folderStatus('Chrome 다운로드 설정을 열었습니다. 위치 → 변경에서 절대경로의 폴더를 선택하고, 다운로드 전에 각 파일의 저장 위치 확인을 OFF로 바꿔 주세요. 변경된 위치는 다음 다운로드부터 적용됩니다.');
  }).catch(value => {
    folderStatus(`Chrome 다운로드 설정을 열지 못했습니다. Chrome 설정 → 다운로드에서 직접 변경할 수 있습니다.${value instanceof Error ? ` ${value.message}` : ''}`, 'error');
  }).finally(() => { folderOpening = false; folderControls(); });
});
node('download-folder-confirm').addEventListener('click', () => {
  if (folderSettingsBusy || folderConfirmed === undefined || !node<HTMLInputElement>('download-folder-acknowledge').checked) return;
  folderSettingsEpoch++; folderSettingsBusy = true; folderControls();
  folderStatus('최초 설정 확인을 저장하고 있습니다…');
  void request('confirm-download-folder', { confirmed: true }).then(result => {
    if (result.confirmed !== true) throw new Error('최초 설정 확인의 저장 여부를 확인할 수 없습니다.');
    folderConfirmed = true; hasError = false;
    folderStatus(`사용자의 최초 설정 확인을 ${chrome.extension.inIncognitoContext ? '시크릿 창 메모리에만 적용했습니다' : '이 브라우저에 저장했습니다'}. 다운로드하려던 화면에서 다시 다운로드를 눌러 주세요. 저장 위치는 언제든 저장 폴더 변경에서 바꿀 수 있습니다.`, 'ready');
    status.textContent = '저장 폴더의 최초 설정을 완료했습니다. 다운로드를 다시 눌러 주세요.';
    node('download-folder-retry').hidden = true;
  }).catch(value => {
    folderConfirmed = undefined;
    folderStatus(`최초 설정 확인의 저장 여부를 확인하지 못했습니다. 다시 불러와 확인해 주세요.${value instanceof Error ? ` ${value.message}` : ''}`, 'error');
    node('download-folder-retry').hidden = false;
  }).finally(() => { folderSettingsBusy = false; folderControls(); });
});
node('url-form').addEventListener('submit', event => {
  event.preventDefault();
  const url = node<HTMLInputElement>('url').value;
  void preferencesReady.then(() => request('download-url', { url, options: options() })).then(result => {
    if (showFolderSetup(result)) return;
    hasError = false; status.textContent = '파일을 준비하고 있습니다.'; show(true);
  }).catch(error);
});
const timer = setInterval(() => { if (!document.hidden) void refresh().catch(error); }, 2000);
addEventListener('pagehide', () => clearInterval(timer), { once: true });
void refreshDatabaseStatus();
if (new URL(location.href).searchParams.get('view') === 'history') show(true);
else void refresh().catch(error);
if (new URL(location.href).searchParams.get('setup') === 'downloads') {
  const section = node('download-folder'); section.scrollIntoView({ block: 'start' }); section.focus({ preventScroll: true });
}
