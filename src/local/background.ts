import { boundedData, record } from '../security/validation.ts';
import { appStorage } from '../data/database.ts';
import { offerUpscale, revokeDownloadOffers, authorizeDownloadOffers } from '../upscale/completion.ts';
import { jobs } from '../upscale/storage.ts';
import { SCOPE, OFFSCREEN_SCOPE, HISTORY_KEY, isActiveHistoryState, MediaCatalog, retainHistory, filenameFor, isHistory, mediaKind, mediaURL, trustedCapture, trustedUI, type MediaItem, type HistoryItem } from './model.ts';
import { downloadOptions, type DownloadOptions } from './preferences.ts';
import { transport, type Transport } from './transport.ts';
import { isMediaFileFormat, mediaFilename, probeMediaFile } from './media-file.ts';
import { chromeWarning, scanFile, probeAntivirus, cancelAntivirusRequests, internalScanResponse, incompleteInternalScan, combineInternalScans, type ScanResult, type FileSecurity } from './antivirus.ts';
import { ANTIVIRUS_ENABLED_KEY, antivirusEnabled } from './security-preferences.ts';
import { DOWNLOAD_FOLDER_CONFIRMED_KEY, downloadFolderConfirmed } from './download-folder.ts';
import { youtubeVideo, resolveYouTube, probeYouTube, type YouTubeResolution } from './youtube.ts';

const media = new MediaCatalog();
const discoveryEpochs = new Map<number, object>();
const rescans = new Map<number, { id: string; epoch: object; url: string }>();
const privateHistory = new Map<string, HistoryItem>();
const cancelled = new Set<string>();
const youtubeResolutions = new Map<string, AbortController>();
const finalizing = new Set<number>();
const finalizeAgain = new Set<number>();
const deciding = new Set<number>();
const trackedDownloadStates: readonly HistoryItem['state'][] = ['downloading', 'scanning', 'review', 'complete'];
let lastTab: number | undefined;
let creatingOffscreen: Promise<void> | undefined;
let privateAntivirusEnabled = true;
let antivirusPreferenceGeneration = 0;
let privateDownloadFolderConfirmed = false;
let openingDownloadFolderSetup: Promise<void> | undefined;

async function isDownloadFolderConfirmed(): Promise<boolean> {
  if (chrome.extension.inIncognitoContext) return privateDownloadFolderConfirmed;
  return downloadFolderConfirmed((await appStorage.get(DOWNLOAD_FOLDER_CONFIRMED_KEY))[DOWNLOAD_FOLDER_CONFIRMED_KEY]);
}
async function confirmDownloadFolder(): Promise<void> {
  if (chrome.extension.inIncognitoContext) privateDownloadFolderConfirmed = true;
  else await appStorage.set({ [DOWNLOAD_FOLDER_CONFIRMED_KEY]: true });
}
async function openDownloadFolderSetup(): Promise<void> {
  if (openingDownloadFolderSetup) return openingDownloadFolderSetup;
  openingDownloadFolderSetup = chrome.tabs.create({ url: chrome.runtime.getURL('local/index.html?setup=downloads#download-folder') }).then(() => {});
  try { await openingDownloadFolderSetup; } finally { openingDownloadFolderSetup = undefined; }
}
async function ensureDownloadFolder(): Promise<boolean> {
  if (await isDownloadFolderConfirmed()) return true;
  await openDownloadFolderSetup(); return false;
}
async function downloadReply(item: MediaItem, options: DownloadOptions) {
  const started = await download(item, options);
  return started ? { ok: true as const, item: started } : { ok: true as const, setupRequired: true as const };
}

function infectionObserved(security: FileSecurity | undefined): boolean {
  return security?.status === 'infected' || security?.infectionObserved === true;
}

async function antivirusIntegrationEnabled(): Promise<boolean> {
  if (chrome.extension.inIncognitoContext) return privateAntivirusEnabled;
  return antivirusEnabled((await appStorage.get(ANTIVIRUS_ENABLED_KEY))[ANTIVIRUS_ENABLED_KEY]);
}
async function setAntivirusEnabled(enabled: boolean): Promise<void> {
  await navigator.locks.request('my-video-app-antivirus-settings', async () => {
    if (chrome.extension.inIncognitoContext) privateAntivirusEnabled = enabled;
    else await appStorage.set({ [ANTIVIRUS_ENABLED_KEY]: enabled });
    antivirusPreferenceGeneration++;
    // Only committed user choices cancel connections; failed writes preserve protection.
    if (!enabled) {
      cancelAntivirusRequests();
      // Generation revocation is synchronous, even if queued file cleanup awaits.
      for (const id of finalizing) void revokeDownloadOffers(id).catch(() => {});
    }
  });
}

async function history(): Promise<HistoryItem[]> {
  // storage.local is shared between split incognito and ordinary extension contexts.
  if (chrome.extension.inIncognitoContext) return retainHistory([...privateHistory.values()]);
  const raw: unknown = (await appStorage.get(HISTORY_KEY))[HISTORY_KEY];
  // IndexedDB enforces normal retention; recovery must preserve every valid row.
  return Array.isArray(raw) ? raw.filter((row: unknown): row is HistoryItem => isHistory(row) && !row.incognito) : [];
}
function updatePrivate(item: HistoryItem) {
  const retained = retainHistory([item, ...privateHistory.values()].filter((row, index) => index === 0 || row.id !== item.id));
  privateHistory.clear();
  for (const row of retained) privateHistory.set(row.id, row);
}
async function update(item: HistoryItem, onlyIfPreparing = false): Promise<void> {
  if (item.incognito) { if (!onlyIfPreparing || privateHistory.get(item.id)?.state === 'preparing') updatePrivate(item); return; }
  await navigator.locks.request('my-video-app-history', async () => {
    const current = await history();
    if (onlyIfPreparing && current.find(row => row.id === item.id)?.state !== 'preparing') return;
    const existing = current.filter(row => !row.incognito && row.id !== item.id);
    await appStorage.set({ [HISTORY_KEY]: [item, ...existing] });
  });
}
async function change(id: string, edit: (item: HistoryItem) => HistoryItem | undefined): Promise<HistoryItem | undefined> {
  return navigator.locks.request('my-video-app-history', async () => {
    const rows = await history(); const current = rows.find(row => row.id === id);
    if (!current) return undefined;
    const next = edit(current); if (!next) return undefined;
    if (next.incognito) updatePrivate(next);
    else await appStorage.set({ [HISTORY_KEY]: rows.filter(row => !row.incognito).map(row => row.id === id ? next : row) });
    return next;
  });
}
async function reviewNotice(item: HistoryItem) {
  if (item.incognito) return;
  await chrome.notifications.create(`my-video-app-security:${item.id}`, {
    type: 'basic', iconUrl: chrome.runtime.getURL('bitmaps/logo-128-color.png'), title: '다운로드 파일 확인 필요',
    message: `${item.filename}\n${item.security?.status === 'chrome-warning' ? 'Chrome이 파일을 경고합니다.' : item.internalScan?.status === 'suspicious' ? '앱 내부 검사에서 위험 신호를 발견했습니다.' : item.security?.status === 'infected' ? '백신이 위협을 탐지했습니다.' : '백신 검사가 완료되지 않았습니다.'} 앱에서 삭제 또는 검토를 선택하세요.`,
    requireInteraction: true,
  }).catch(() => {});
}
async function storageFailureNotice(item: HistoryItem, message: string, title = '다운로드 기록 저장 실패') {
  if (item.incognito) return;
  await chrome.notifications.create(`my-video-app-security:${item.id}`, {
    type: 'basic', iconUrl: chrome.runtime.getURL('bitmaps/logo-128-color.png'), title,
    message: `${item.filename}\n${message}`, requireInteraction: true,
  }).catch(() => {});
}
/** A started native download must not continue silently without its safety record. */
async function stopUntrackedDownload(item: HistoryItem) {
  const id = item.downloadId!;
  await chrome.downloads.cancel(id).catch(() => {});
  const current = await chrome.downloads.search({ id }).then(items => items[0]).catch(() => undefined);
  const danger = chromeWarning(current?.danger);
  const stopped = current?.state === 'interrupted' && !danger;
  const message = stopped
    ? '다운로드 상태 확인에 실패하여 전송을 중단했습니다. 파일이 남아 있으면 Chrome 다운로드 화면에서 직접 확인하세요.'
    : '다운로드 상태 확인에 실패하여 자동 검사를 보장할 수 없습니다. 파일을 열지 말고 Chrome 다운로드 화면과 로컬 백신으로 직접 확인하세요.';
  const next: HistoryItem = { ...item, state: stopped ? 'cancelled' : 'review', error: message,
    security: { status: danger ? 'chrome-warning' : 'error', token: crypto.randomUUID(), message, ...(danger ? { danger } : {}) } };
  // A transient commit failure may have recovered. Keep the actual download ID
  // so retries/explicit review remain possible; persistent failures still notify.
  await update(next).catch(() => {});
  await revokeDownloadOffers(id).catch(() => {});
  await dispose(item.id).catch(() => {});
  cancelled.delete(item.id);
  await storageFailureNotice(next, message, '다운로드 상태 확인 필요');
}
async function missingDownload(item: HistoryItem) {
  const next = await change(item.id, row => ['downloading', 'scanning'].includes(row.state)
    ? { ...row, state: 'review', security: { status: 'error', token: crypto.randomUUID(), message: 'Chrome 다운로드 기록이 없어 파일 검사를 완료하지 못했습니다. 저장한 파일을 직접 확인하세요.' } } : undefined);
  if (item.downloadId !== undefined) await revokeDownloadOffers(item.downloadId).catch(() => {});
  if (next) await reviewNotice(next);
}
function add(tabId: number, address: unknown, mime: string, title: string, fromElement: boolean, size?: number, observed?: unknown) {
  try {
    const url = mediaURL(address).href;
    const existing = media.get(tabId, url);
    const mergedMime = mime || existing?.mime || '';
    const kind = existing && existing.kind !== 'file' ? existing.kind : mediaKind(url, mergedMime, fromElement);
    if (!kind) return;
    const item: MediaItem = { ...existing, id: existing?.id ?? crypto.randomUUID(), tabId, url, title: (title || existing?.title || '').slice(0, 200), mime: mergedMime.slice(0, 100), kind, createdAt: Date.now() };
    if (Number.isSafeInteger(size) && size! > 0) item.size = size!;
    const protocol = transport(observed); if (protocol) item.observedTransport = protocol;
    media.set(item);
  } catch { /* Unsupported URLs and protocols are not media candidates. */ }
}
async function ensureOffscreen() {
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    if (!await chrome.offscreen.hasDocument()) await chrome.offscreen.createDocument({
      url: 'local/offscreen.html', reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.DOM_PARSER],
      justification: 'Prepare local media files and run the local stream remux worker.',
    });
  })();
  try { await creatingOffscreen; } finally { creatingOffscreen = undefined; }
}
async function dispose(id: string) {
  if (await chrome.offscreen.hasDocument()) await chrome.runtime.sendMessage({ scope: OFFSCREEN_SCOPE, type: 'dispose', id }).catch(() => {});
  await (await navigator.storage.getDirectory()).removeEntry(`local-${id}.media`).catch(() => {});
}
async function finish(download: chrome.downloads.DownloadItem): Promise<void> {
  if (finalizing.has(download.id) || deciding.has(download.id)) { finalizeAgain.add(download.id); return; }
  finalizing.add(download.id);
  try {
    const item = (await history()).find(row => row.downloadId === download.id && trackedDownloadStates.includes(row.state));
    if (!item) return;
    const current = (await chrome.downloads.search({ id: download.id }))[0];
    if (!current) { await missingDownload(item); return; }
    const danger = chromeWarning(current.danger);
    if (danger) {
      if (item.state === 'review' && item.security?.status === 'chrome-warning' && item.security.danger === danger) return;
      const next = await change(item.id, row => trackedDownloadStates.includes(row.state)
        ? { ...row, state: 'review', security: { ...(infectionObserved(row.security) ? { ...row.security, infectionObserved: true as const } : {}),
          status: 'chrome-warning', token: crypto.randomUUID(), danger, message: 'Chrome이 이 파일을 경고하거나 검사 중입니다. Chrome 다운로드 화면에서 확인하세요.' } } : undefined);
      await revokeDownloadOffers(current.id).catch(() => {});
      if (next) await reviewNotice(next);
      return;
    }
    if (current.state === 'interrupted') {
      if (item.state === 'complete') return;
      await change(item.id, row => ({ ...row, state: cancelled.has(row.id) || current.error === 'USER_CANCELED' ? 'cancelled' : 'error', error: current.error || '다운로드가 중단되었습니다.' }));
      await dispose(item.id); cancelled.delete(item.id); return;
    }
    if (current.state !== 'complete') {
      if (item.state === 'review' && item.security?.status === 'chrome-warning') await change(item.id, row => ({ ...row, state: 'downloading' }));
      return;
    }
    if (item.state === 'complete' || (item.state === 'review' && item.security?.status !== 'chrome-warning')) return;
    const scanning = await change(item.id, row => ['downloading', 'scanning', 'review'].includes(row.state)
      ? { ...row, state: 'scanning', security: infectionObserved(row.security)
        ? { ...row.security, status: 'infected', infectionObserved: true, token: crypto.randomUUID() } : { status: 'scanning', token: crypto.randomUUID() } } : undefined);
    if (!scanning) return;
    const scanGeneration = antivirusPreferenceGeneration;
    let result: ScanResult;
    try { result = await scanFile(current.filename, antivirusIntegrationEnabled); }
    catch { result = { status: 'error', message: '로컬 백신 검사를 완료하지 못했습니다.' }; }
    const latest = (await chrome.downloads.search({ id: current.id }))[0];
    if (!latest) { await missingDownload(scanning); return; }
    const measured = result.sha256 !== undefined && result.size !== undefined;
    const identityMismatch = latest.filename !== current.filename || (measured && latest.fileSize >= 0 && result.size !== latest.fileSize)
      || (measured && item.internalScanSha256 !== undefined && (result.sha256 !== item.internalScanSha256 || result.size !== item.internalScanSize));
    let internalScan = combineInternalScans(scanning.internalScan, result.internalScan);
    if (identityMismatch) {
      result = { status: 'error', message: '다운로드 파일 정보가 검사 결과 또는 앱 내부 검사 대상과 일치하지 않습니다. 다시 확인하세요.' };
      internalScan = scanning.internalScan?.status === 'suspicious' ? scanning.internalScan : incompleteInternalScan('앱에서 검사한 바이트와 저장 파일이 일치하는지 확인하지 못했습니다.');
    }
    if (latest.state !== 'complete' || chromeWarning(latest.danger)) {
      // Chrome wins presentation without dropping independently bound risk evidence.
      if (result.status === 'infected' || internalScan.status === 'suspicious') {
        const positive = { ...result }; delete positive.internalScan;
        await change(item.id, row => row.state === 'scanning' && row.security?.token === scanning.security?.token
          ? { ...row, internalScan, ...(measured && !identityMismatch ? { internalScanSha256: result.sha256!, internalScanSize: result.size! } : {}),
            ...(result.status === 'infected' ? { security: { ...positive, status: 'infected', infectionObserved: true, token: row.security!.token } } : {}) } : undefined);
      }
      finalizeAgain.add(current.id); return;
    }
    // The external antivirus verdict stays independent from app risk signals.
    let external: Omit<FileSecurity, 'token'> = { ...result }; delete external.internalScan;
    // A cancelled rescan is not evidence that a previously infected file is safe.
    if (result.status === 'disabled' && infectionObserved(scanning.security)) {
      external = { ...scanning.security, status: 'infected', infectionObserved: true, message: '백신 연동을 꺼서 재검사를 중단했습니다. 이전 위협 탐지 결과를 유지합니다.' };
    }
    const next = await change(item.id, row => row.state === 'scanning' && row.security?.token === scanning.security?.token
      ? { ...row, internalScan, ...(measured && !identityMismatch ? { internalScanSha256: result.sha256!, internalScanSize: result.size! } : {}),
        state: ['clean', 'disabled'].includes(external.status) && internalScan.status !== 'suspicious' ? 'complete' : 'review', security: { ...external, token: crypto.randomUUID() } } : undefined);
    if (!next) return;
    if (next.state === 'review') { await revokeDownloadOffers(current.id).catch(() => {}); await reviewNotice(next); return; }
    await chrome.notifications.clear(`my-video-app-security:${item.id}`).catch(() => {});
    // Opting out of AV is a download preference, never a verified processing verdict.
    if (next.security?.status !== 'clean' || scanGeneration !== antivirusPreferenceGeneration
      || !await antivirusIntegrationEnabled() || scanGeneration !== antivirusPreferenceGeneration) {
      await revokeDownloadOffers(current.id).catch(() => {}); await dispose(item.id); cancelled.delete(item.id); return;
    }
    const beforeOffer = (await chrome.downloads.search({ id: current.id }))[0];
    if (!beforeOffer || beforeOffer.state !== 'complete' || chromeWarning(beforeOffer.danger)) {
      await revokeDownloadOffers(current.id).catch(() => {});
      if (beforeOffer) finalizeAgain.add(current.id);
      return;
    }
    if (scanGeneration !== antivirusPreferenceGeneration
      || !await antivirusIntegrationEnabled() || scanGeneration !== antivirusPreferenceGeneration) {
      await revokeDownloadOffers(current.id).catch(() => {}); await dispose(item.id); cancelled.delete(item.id); return;
    }
    authorizeDownloadOffers(current.id);
    await offerUpscale({ internalFilename: `local-${item.id}.media`, filename: item.filename, downloadId: current.id, success: true, incognito: item.incognito, expectedSha256: result.sha256!, expectedSize: result.size! });
    const afterOffer = (await chrome.downloads.search({ id: current.id }))[0];
    if (afterOffer && chromeWarning(afterOffer.danger)) { await revokeDownloadOffers(current.id).catch(() => {}); finalizeAgain.add(current.id); }
    await dispose(item.id);
    cancelled.delete(item.id);
  } finally {
    finalizing.delete(download.id);
    if (finalizeAgain.delete(download.id) && !deciding.has(download.id)) void chrome.downloads.search({ id: download.id }).then(items => items[0] && finish(items[0])).catch(() => {});
  }
}
async function securityDecision(id: string, token: string, action: 'keep' | 'delete' | 'rescan') {
  if (action === 'rescan' && !await antivirusIntegrationEnabled()) throw new Error('다시 검사하려면 로컬 백신 연동을 켜세요. 기존 검사 결과는 유지됩니다.');
  const item = (await history()).find(row => row.id === id && row.state === 'review' && row.security?.token === token);
  if (!item || item.downloadId === undefined || deciding.has(item.downloadId)) throw new Error('검사 상태가 변경되었습니다. 기록을 새로고침하세요.');
  deciding.add(item.downloadId);
  try {
    const current = (await chrome.downloads.search({ id: item.downloadId }))[0];
    if (!current) {
      if (action !== 'keep' || item.security?.status === 'chrome-warning') throw new Error('Chrome 다운로드 기록이 없어 자동 삭제·재검사를 할 수 없습니다. 저장한 파일을 직접 확인하세요.');
      const next = await change(id, row => row.state === 'review' && row.security?.token === token
        ? { ...row, state: 'complete', security: { ...row.security, token: crypto.randomUUID(), decision: 'keep' } } : undefined);
      if (!next) throw new Error('검사 상태가 변경되었습니다.');
      await dispose(id); await chrome.notifications.clear(`my-video-app-security:${id}`).catch(() => {}); return;
    }
    if (action !== 'delete' && (current.state !== 'complete' || chromeWarning(current.danger) || current.exists === false)) throw new Error('Chrome의 경고를 먼저 확인하고 파일 상태를 확인하세요.');
    const claimed = await change(id, row => row.state === 'review' && row.security?.token === token
      ? { ...row, security: { ...row.security, token: crypto.randomUUID() } } : undefined);
    if (!claimed) throw new Error('검사 상태가 변경되었습니다.');
    if (action === 'delete') {
      try {
        if (current.state === 'in_progress') await chrome.downloads.cancel(current.id);
        const latest = (await chrome.downloads.search({ id: current.id }))[0];
        if (latest?.exists !== false) await chrome.downloads.removeFile(current.id);
        await change(id, row => ({ ...row, state: 'discarded', security: { ...claimed.security!, decision: 'delete' } }));
        await revokeDownloadOffers(current.id).catch(() => {}); await dispose(id);
      } catch {
        await change(id, row => ({ ...row, state: 'review', security: { ...claimed.security!, token: crypto.randomUUID(), message: '파일 삭제를 확인하지 못했습니다. Chrome 다운로드 화면에서 파일을 확인하거나 다시 삭제하세요.' } }));
        throw new Error('파일을 삭제하지 못했습니다. 확인 대기 상태를 유지합니다.');
      }
    } else if (action === 'keep') {
      await change(id, row => ({ ...row, state: 'complete', security: { ...claimed.security!, decision: 'keep' } }));
      // Explicitly retained risky/unverified files never enter the automatic processing queue.
      await dispose(id);
    } else {
      await revokeDownloadOffers(current.id).catch(() => {});
      await change(id, row => ({ ...row, state: 'scanning', security: infectionObserved(row.security)
        ? { ...row.security, status: 'infected', infectionObserved: true, token: crypto.randomUUID() } : { status: 'scanning', token: crypto.randomUUID() } }));
    }
    await chrome.notifications.clear(`my-video-app-security:${id}`).catch(() => {});
  } finally {
    deciding.delete(item.downloadId);
    const current = (await chrome.downloads.search({ id: item.downloadId }))[0];
    if (current) void finish(current).catch(() => {});
  }
}
async function download(item: MediaItem, options: DownloadOptions = downloadOptions()) {
  const tab = item.tabId < 0 ? { incognito: chrome.extension.inIncognitoContext } : await chrome.tabs.get(item.tabId);
  if (!!tab.incognito !== chrome.extension.inIncognitoContext) throw new Error('다른 브라우징 모드의 미디어에는 접근할 수 없습니다.');
  // Gate every entry point before creating history, preparing bytes or starting a transfer.
  // Never pass an absolute path to downloads.download: Chrome only accepts relative names.
  if (!await ensureDownloadFolder()) return;
  if (item.kind === 'youtube') {
    const source = youtubeVideo(item.url);
    if (!source) throw new Error('지원하는 YouTube 단일 영상 주소가 아닙니다.');
    item = { ...item, url: source.url };
    if (!await chrome.permissions.contains({ permissions: ['nativeMessaging'] })) throw new Error('설정의 YouTube 다운로드에서 로컬 도우미 연결 권한을 먼저 허용하세요.');
  }
  const filename = filenameFor(item);
  const entry: HistoryItem = { id: crypto.randomUUID(), url: item.url, filename: options.output === 'original' ? filename : filename.replace(/\.[^.]+$/, '') + '.' + options.output, kind: item.kind, state: 'preparing', createdAt: Date.now(), incognito: !!tab.incognito || chrome.extension.inIncognitoContext, options, internalScan: incompleteInternalScan('다운로드 파일 전체의 내부 검사는 아직 수행되지 않았습니다.') };
  await navigator.locks.request('my-video-app-start', async () => {
    const active = (await history()).filter(row => isActiveHistoryState(row.state));
    if (active.some(row => row.url === item.url && (row.options?.quality ?? 'highest') === options.quality && (row.options?.output ?? 'original') === options.output)) throw new Error('같은 미디어를 이미 처리하고 있습니다.');
    if (active.length >= 8) throw new Error('동시에 준비·다운로드하는 파일은 최대 8개입니다.');
    await update(entry);
  });
  void (async () => {
    let startedDownload: HistoryItem | undefined;
    try {
      let address = item.url;
      let transferProtocols: Transport[] = [];
      let resolution: YouTubeResolution | undefined;
      if (item.kind === 'youtube') {
        const controller = new AbortController();
        youtubeResolutions.set(entry.id, controller);
        try {
          if (cancelled.has(entry.id)) controller.abort(new DOMException('작업을 취소했습니다.', 'AbortError'));
          resolution = await resolveYouTube(item.url, options, controller.signal);
          const base = filenameFor({ ...item, title: resolution.title || item.title });
          entry.filename = options.output === 'original' ? base : base.replace(/\.[^.]+$/, '') + '.' + options.output;
          await update(entry, true);
        } finally { youtubeResolutions.delete(entry.id); }
      }
      const directOriginal = options.output === 'original' && item.kind === 'file';
      // Type ordinary originals regardless of private mode or upscale preferences.
      {
        let result: unknown;
        try {
          await ensureOffscreen();
          if (cancelled.has(entry.id)) throw new DOMException('작업을 취소했습니다.', 'AbortError');
          result = await chrome.runtime.sendMessage({ scope: OFFSCREEN_SCOPE, type: 'prepare', id: entry.id, url: item.url, kind: item.kind, options, ...(resolution ? { resolution } : {}) });
        } catch (error) {
          if (!directOriginal || cancelled.has(entry.id)) throw error;
        }
        if (record(result) && result.internalScan !== undefined) {
          try {
            const size = typeof result.internalScanSize === 'number' ? result.internalScanSize : undefined;
            entry.internalScan = internalScanResponse(result.internalScan, size);
            if (result.ok === true) {
              if (typeof result.internalScanSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.internalScanSha256) || size === undefined || !Number.isSafeInteger(size) || size < 0) throw new Error('준비한 파일의 내부 검사 대상 정보를 확인할 수 없습니다.');
              entry.internalScanSha256 = result.internalScanSha256; entry.internalScanSize = size;
            }
          } catch { entry.internalScan = incompleteInternalScan('준비한 파일의 내부 검사 결과가 올바르지 않습니다.'); throw new Error('앱 내부 검사 결과를 확인하지 못해 파일 저장을 중단했습니다.'); }
        }
        if (record(result) && result.ok === true) {
          if (typeof result.url !== 'string' || !result.url.startsWith(`blob:${chrome.runtime.getURL('')}`) || !isMediaFileFormat(result)) throw new Error('준비한 파일의 미디어 형식을 확인할 수 없습니다.');
          address = result.url;
          entry.filename = mediaFilename(entry.filename, result);
          if (Array.isArray(result.protocols)) transferProtocols = result.protocols.map(transport).filter((value): value is Transport => value !== undefined);
        } else if (!directOriginal || (record(result) && (result.invalidMedia === true || result.internalRisk === true))) {
          throw new Error(record(result) && typeof result.error === 'string' ? result.error : '파일을 준비할 수 없습니다.');
        }
      }
      if (cancelled.has(entry.id)) throw new DOMException('작업을 취소했습니다.', 'AbortError');
      if (address === item.url) {
        const controller = new AbortController();
        const stop = setInterval(() => { if (cancelled.has(entry.id)) controller.abort(); }, 50);
        try { entry.filename = mediaFilename(entry.filename, await probeMediaFile(item.url, controller.signal)); }
        finally { clearInterval(stop); }
      }
      if (cancelled.has(entry.id)) throw new DOMException('작업을 취소했습니다.', 'AbortError');
      await update(entry, true);
      if (cancelled.has(entry.id)) throw new DOMException('작업을 취소했습니다.', 'AbortError');
      const id = await chrome.downloads.download({ url: address, filename: entry.filename, saveAs: false, conflictAction: 'uniquify' });
      const downloading: HistoryItem = { ...entry, state: 'downloading', downloadId: id, transferProtocols };
      startedDownload = downloading;
      await update(downloading);
      if (cancelled.has(entry.id)) await chrome.downloads.cancel(id).catch(() => {});
      const current = (await chrome.downloads.search({ id }))[0]; if (current) await finish(current);
    } catch (error) {
      if (startedDownload) { await stopUntrackedDownload(startedDownload); return; }
      const message = error instanceof Error ? error.message : '다운로드 오류';
      const wasCancelled = cancelled.has(entry.id) || /canceled by the user/i.test(message);
      try { await update({ ...entry, state: wasCancelled ? 'cancelled' : 'error', error: wasCancelled ? '작업을 취소했습니다.' : message.slice(0, 500) }); }
      catch { await storageFailureNotice(entry, '작업 상태를 저장하지 못했습니다. 로컬 저장소 상태를 확인한 뒤 다시 시도하세요.'); }
      finally {
        await dispose(entry.id).catch(() => {}); cancelled.delete(entry.id);
        if (entry.incognito) privateHistory.delete(entry.id);
      }
    }
  })();
  return entry;
}
function observeYouTubeTab(tab: chrome.tabs.Tab): void {
  if (tab.id === undefined || !!tab.incognito !== chrome.extension.inIncognitoContext) return;
  const source = youtubeVideo(tab.url);
  for (const item of media.items(tab.id)) if (item.kind === 'youtube' && item.url !== source?.url) media.delete(item.id);
  if (!source) return;
  const previous = media.get(tab.id, source.url);
  const title = typeof tab.title === 'string' ? tab.title.slice(0, 200) : previous?.title || 'YouTube 영상';
  media.set({ id: previous?.id ?? crypto.randomUUID(), tabId: tab.id, url: source.url, title, mime: 'video/mp4', kind: 'youtube', createdAt: previous?.createdAt ?? Date.now() });
}
async function currentTab() {
  const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true })).find(tab => !!tab.incognito === chrome.extension.inIncognitoContext);
  if (tab?.id !== undefined && tab.url && /^https?:/.test(tab.url)) { observeYouTubeTab(tab); return tab.id; }
  return lastTab ?? Array.from(media.tabIds()).at(-1);
}
async function rescanCurrentTab(): Promise<number> {
  const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true })).find(candidate =>
    !!candidate.incognito === chrome.extension.inIncognitoContext && candidate.id !== undefined
    && typeof candidate.url === 'string' && /^https?:/.test(candidate.url));
  if (tab?.id === undefined || !tab.url) throw new Error('영상이 있는 웹페이지를 연 뒤 다시 감지하세요.');
  const tabId = tab.id;
  if (youtubeVideo(tab.url)) { observeYouTubeTab(tab); return tabId; }
  const epoch = discoveryEpochs.get(tabId) ?? {};
  discoveryEpochs.set(tabId, epoch);
  const ticket = { id: crypto.randomUUID(), epoch, url: tab.url };
  rescans.set(tabId, ticket);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result: unknown = await Promise.race([
      chrome.tabs.sendMessage(tabId, { scope: SCOPE, type: 'rescan', rescanId: ticket.id }, { frameId: 0 }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('페이지의 응답이 없습니다. 새로고침한 뒤 다시 감지하세요.')), 3000); }),
    ]);
    if (!record(result) || result.ok !== true) throw new Error('페이지를 새로고침한 뒤 다시 감지하세요.');
    const current = await chrome.tabs.get(tabId);
    if (rescans.get(tabId) !== ticket || ticket.epoch !== discoveryEpochs.get(tabId)
      || current.url !== ticket.url || !!current.incognito !== chrome.extension.inIncognitoContext) {
      throw new Error('페이지가 변경되어 감지 결과를 취소했습니다.');
    }
  } finally {
    clearTimeout(timeout);
    if (rescans.get(tabId) === ticket) rescans.delete(tabId);
  }
  return tabId;
}
async function listMedia(tabId: number | undefined) {
  const candidates = tabId === undefined ? [] : Array.from(media.items(tabId));
  // A YouTube page exposes separate transient ranges. Offer its source page,
  // then resolve complete video/audio tracks only after the explicit click.
  const primary = candidates.find(item => item.kind === 'youtube');
  const items = primary ? [primary] : candidates.sort((a, b) => b.createdAt - a.createdAt);
  const rows = await history();
  const progress = await Promise.all(rows.map(async row => {
    if (row.state !== 'downloading' || row.downloadId === undefined) return row;
    const download = (await chrome.downloads.search({ id: row.downloadId }).catch(() => []))[0];
    return download ? { ...row, receivedBytes: download.bytesReceived, totalBytes: download.totalBytes } : row;
  }));
  return { ok: true, items, history: progress, tabId };
}
export async function handleLocalMessage(value: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (!record(value) || value.scope !== SCOPE || typeof value.type !== 'string' || !boundedData(value, 128 * 1024)) throw new Error('잘못된 요청입니다.');
  if (value.type === 'preparing-progress') {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('local/offscreen.html')) throw new Error('허용되지 않은 발신자입니다.');
    if (typeof value.id === 'string' && ['queued', 'fetching', 'processing', 'saving'].includes(String(value.stage))) {
      const item = (await history()).find(row => row.id === value.id && row.state === 'preparing');
      if (item) {
        const preparation: NonNullable<HistoryItem['preparation']> = { stage: value.stage as NonNullable<HistoryItem['preparation']>['stage'] };
        if (typeof value.progress === 'number' && Number.isFinite(value.progress)) preparation.progress = Math.max(0, Math.min(1, value.progress));
        for (const key of ['loaded', 'total'] as const) if (typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 0) preparation[key] = value[key];
        await update({ ...item, preparation }, true);
      }
    }
    return { ok: true };
  }
  if (value.type === 'capture') {
    if (!trustedCapture(sender, chrome.runtime.id) || !Array.isArray(value.items) || value.items.length > 100) throw new Error('허용되지 않은 수집 요청입니다.');
    if (!!sender.tab?.incognito !== chrome.extension.inIncognitoContext) throw new Error('다른 브라우징 모드의 수집 요청입니다.');
    if (value.rescanId !== undefined) {
      const ticket = rescans.get(sender.tab!.id!);
      if (!ticket || value.rescanId !== ticket.id || ticket.epoch !== discoveryEpochs.get(sender.tab!.id!)
        || mediaURL(sender.url).href !== mediaURL(ticket.url).href) throw new Error('페이지가 변경되어 감지 결과를 취소했습니다.');
    }
    for (const item of value.items) if (record(item) && typeof item.url === 'string') add(sender.tab!.id!, item.url, typeof item.mime === 'string' ? item.mime : '', typeof item.title === 'string' ? item.title : '', item.fromElement === true, undefined, item.observedTransport);
    return { ok: true };
  }
  if (!trustedUI(sender, chrome.runtime.id, chrome.runtime.getURL(''))) throw new Error('확장 화면에서만 사용할 수 있습니다.');
  if (value.type === 'youtube-status' || value.type === 'youtube-connect') {
    if (sender.tab?.incognito !== undefined && sender.tab.incognito !== chrome.extension.inIncognitoContext) throw new Error('다른 브라우징 모드의 YouTube 도우미에는 접근할 수 없습니다.');
    return { ok: true, youtube: await probeYouTube() };
  }
  if (['download-folder-settings', 'open-download-folder-settings', 'confirm-download-folder', 'prepare-output-save'].includes(value.type)) {
    if (sender.tab?.incognito !== undefined && sender.tab.incognito !== chrome.extension.inIncognitoContext) throw new Error('다른 브라우징 모드의 다운로드 폴더 설정에는 접근할 수 없습니다.');
    if (value.type === 'open-download-folder-settings') {
      await chrome.tabs.create({ url: 'chrome://settings/downloads' });
      return { ok: true };
    }
    if (value.type === 'prepare-output-save') return { ok: true, setupRequired: !await ensureDownloadFolder() };
    if (value.type === 'confirm-download-folder') {
      if (value.confirmed !== true) throw new Error('Chrome에서 저장 위치와 매번 저장 위치 묻기 설정을 확인하세요.');
      await confirmDownloadFolder();
    }
    return { ok: true, confirmed: await isDownloadFolderConfirmed() };
  }
  if (value.type === 'antivirus-settings' || value.type === 'set-antivirus-enabled') {
    if (sender.tab?.incognito !== undefined && sender.tab.incognito !== chrome.extension.inIncognitoContext) throw new Error('다른 브라우징 모드의 백신 설정에는 접근할 수 없습니다.');
    if (value.type === 'set-antivirus-enabled') {
      if (typeof value.enabled !== 'boolean') throw new Error('백신 연동 설정은 켜기 또는 끄기여야 합니다.');
      await setAntivirusEnabled(value.enabled);
    }
    return { ok: true, enabled: await antivirusIntegrationEnabled() };
  }
  if (value.type === 'antivirus-status') return { ok: true, antivirus: await probeAntivirus(antivirusIntegrationEnabled) };
  if (['security-keep', 'security-delete', 'security-rescan'].includes(value.type) && typeof value.id === 'string' && typeof value.token === 'string') {
    if (value.type === 'security-keep' && value.confirmed !== true) throw new Error('파일의 위험을 이해했다는 확인이 필요합니다.');
    await securityDecision(value.id, value.token, value.type === 'security-keep' ? 'keep' : value.type === 'security-delete' ? 'delete' : 'rescan');
    return { ok: true };
  }
  if (value.type === 'security-connect') {
    if (!await antivirusIntegrationEnabled()) throw new Error('로컬 백신 연동이 꺼져 있습니다. 설정에서 켠 뒤 연결하세요.');
    if (!await chrome.permissions.contains({ permissions: ['nativeMessaging'] })) throw new Error('로컬 백신 연결 권한을 먼저 허용하세요.');
    const antivirus = await probeAntivirus(antivirusIntegrationEnabled);
    for (const item of await history()) if ((antivirus.status === 'ready' || antivirus.internalAvailable === true) && item.state === 'review' && item.security && ['unavailable', 'error'].includes(item.security.status)) {
      await securityDecision(item.id, item.security.token, 'rescan').catch(() => {});
    }
    return { ok: true, antivirus };
  }
  if (value.type === 'review-chrome' && typeof value.id === 'string' && typeof value.token === 'string') {
    const item = (await history()).find(row => row.id === value.id && row.state === 'review' && row.security?.token === value.token);
    if (!item) throw new Error('검사 상태가 변경되었습니다.');
    await chrome.tabs.create({ url: 'chrome://downloads/' }); return { ok: true };
  }
  if (value.type === 'list') return listMedia(await currentTab());
  if (value.type === 'rescan') return listMedia(await rescanCurrentTab());
  if (value.type === 'download' && typeof value.id === 'string') {
    const item = media.find(value.id);
    if (!item) throw new Error('미디어가 만료되었습니다. 원래 페이지를 새로고침하세요.');
    return downloadReply(item, downloadOptions(value.options));
  }
  if (value.type === 'download-url' && typeof value.url === 'string') {
    const address = mediaURL(value.url).href;
    const source = youtubeVideo(address);
    const url = source?.url ?? address;
    return downloadReply({ id: crypto.randomUUID(), tabId: -1, url, title: '', mime: '', kind: source ? 'youtube' : mediaKind(url) ?? 'file', createdAt: Date.now() }, downloadOptions(value.options));
  }
  if (value.type === 'retry' && typeof value.id === 'string') {
    const item = (await history()).find(row => row.id === value.id && ['error', 'cancelled'].includes(row.state));
    if (!item) throw new Error('다시 시도할 다운로드가 없습니다.');
    return downloadReply({ id: crypto.randomUUID(), tabId: -1, url: mediaURL(item.url).href, title: item.filename, mime: '', kind: item.kind, createdAt: Date.now() }, downloadOptions(item.options));
  }
  if (value.type === 'cancel' && typeof value.id === 'string') {
    const item = (await history()).find(row => row.id === value.id);
    if (!item || !['preparing', 'downloading'].includes(item.state)) throw new Error('진행 중인 작업이 아닙니다.');
    cancelled.add(item.id);
    youtubeResolutions.get(item.id)?.abort(new DOMException('작업을 취소했습니다.', 'AbortError'));
    if (item.downloadId !== undefined) await chrome.downloads.cancel(item.downloadId);
    else if (await chrome.offscreen.hasDocument()) await chrome.runtime.sendMessage({ scope: OFFSCREEN_SCOPE, type: 'cancel', id: item.id });
    return { ok: true };
  }
  if (value.type === 'show-file' && typeof value.id === 'string') {
    const item = (await history()).find(row => row.id === value.id);
    if (!item || item.state !== 'complete' || item.downloadId === undefined) throw new Error('완료된 다운로드가 아닙니다.');
    const current = (await chrome.downloads.search({ id: item.downloadId }))[0];
    if (!current || current.exists === false || chromeWarning(current.danger)) {
      if (current) void finish(current).catch(() => {});
      throw new Error('파일 상태가 변경되었습니다. Chrome 다운로드 화면에서 확인하세요.');
    }
    chrome.downloads.show(item.downloadId); return { ok: true };
  }
  if (value.type === 'clear-history') {
    await navigator.locks.request('my-video-app-history', async () => {
      if (chrome.extension.inIncognitoContext) {
        for (const [id, row] of privateHistory) if (!isActiveHistoryState(row.state)) privateHistory.delete(id);
      } else await appStorage.set({ [HISTORY_KEY]: (await history()).filter(row => isActiveHistoryState(row.state)) });
    });
    return { ok: true };
  }
  if (value.type === 'upscale') { await chrome.tabs.create({ url: chrome.runtime.getURL('upscale/index.html') }); return { ok: true }; }
  throw new Error('지원하지 않는 요청입니다.');
}
chrome.runtime.onMessage.addListener((value: unknown, sender, reply) => {
  if (!record(value) || value.scope !== SCOPE) return false;
  void handleLocalMessage(value, sender).then(reply).catch((error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : '요청 오류' }));
  return true;
});
chrome.webRequest.onHeadersReceived.addListener((details): undefined => {
  if (details.tabId < 0 || details.statusCode < 200 || details.statusCode >= 300) return undefined;
  const type = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type')?.value ?? '';
  try { if (!mediaKind(details.url, type)) return undefined; } catch { return undefined; }
  const header = (name: string) => details.responseHeaders?.find(h => h.name.toLowerCase() === name)?.value;
  const size = Number(details.statusCode === 206 ? header('content-range')?.match(/^bytes \d+-\d+\/(\d+)$/i)?.[1] : header('content-length'));
  const epoch = discoveryEpochs.get(details.tabId) ?? {};
  discoveryEpochs.set(details.tabId, epoch);
  // webRequest does not include an incognito field; resolve its tab before retaining URLs.
  void chrome.tabs.get(details.tabId).then(tab => {
    if (discoveryEpochs.get(details.tabId) === epoch && !!tab.incognito === chrome.extension.inIncognitoContext) add(details.tabId, details.url, type, '', false, size);
  }).catch(() => {});
  return undefined;
}, { urls: ['http://*/*', 'https://*/*'] }, ['responseHeaders']);
chrome.downloads.onChanged.addListener(delta => {
  // Retained copies outlive cleared/pruned download history.
  if (chromeWarning(delta.danger?.current)) void revokeDownloadOffers(delta.id).catch(() => {});
  if (delta.state || delta.danger) void chrome.downloads.search({ id: delta.id }).then(items => { if (items[0]) return finish(items[0]); }).catch(() => {});
});
chrome.notifications.onClicked.addListener(id => {
  if (!/^my-video-app-security:[a-f0-9-]{36}$/.test(id)) return;
  void chrome.tabs.create({ url: chrome.runtime.getURL('local/index.html?view=history') });
});
chrome.tabs.onRemoved.addListener(id => { media.deleteTab(id); discoveryEpochs.delete(id); rescans.delete(id); if (lastTab === id) lastTab = undefined; });
chrome.tabs.onUpdated.addListener((id, changes, tab) => {
  if (changes.url !== undefined) rescans.delete(id);
  if (!!tab.incognito !== chrome.extension.inIncognitoContext) return;
  if (changes.status === 'loading') { media.deleteTab(id); discoveryEpochs.set(id, {}); }
  if (changes.url !== undefined || changes.title !== undefined) observeYouTubeTab(tab);
  if (tab.active && tab.url && /^https?:/.test(tab.url)) lastTab = id;
});
chrome.tabs.onActivated.addListener(info => { void chrome.tabs.get(info.tabId).then(tab => { if (!!tab.incognito === chrome.extension.inIncognitoContext && tab.url && /^https?:/.test(tab.url)) { observeYouTubeTab(tab); lastTab = info.tabId; } }).catch(() => {}); });
async function setup(restarted = false) {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  await chrome.action.setPopup({ popup: 'local/popup.html' });
  if (!chrome.extension.inIncognitoContext) {
    // Migration/open errors must stop reconciliation before it can delete retained files.
    await appStorage.ready();
    // An unsafe verdict may arrive while the service worker is stopped, after history was cleared.
    const ids = new Set((await jobs()).map(job => job.downloadId).filter((id): id is number => id !== undefined));
    for (const id of ids) {
      const current = (await chrome.downloads.search({ id }))[0];
      if (!current || current.state !== 'complete' || chromeWarning(current.danger)) await revokeDownloadOffers(id).catch(() => {});
    }
  }
  for (const item of await history()) {
    if (restarted && item.state === 'preparing') {
      await update({ ...item, state: 'error', error: '브라우저가 다시 시작되어 준비 작업이 중단되었습니다. 다시 다운로드하세요.' });
      await dispose(item.id).catch(() => {});
    } else if (trackedDownloadStates.includes(item.state) && item.downloadId !== undefined) {
      const current = (await chrome.downloads.search({ id: item.downloadId }))[0];
      if (current) await finish(current);
      else await missingDownload(item);
    }
  }
  // Recovered legacy records can refer to otherwise unindexed temporary inputs.
  // Automatic orphan deletion must wait; explicit safety decisions remain available.
  if (!chrome.extension.inIncognitoContext && (await appStorage.status()).recoveryCount > 0) return;
  const keep = new Set((await history()).filter(item => isActiveHistoryState(item.state)).flatMap(item => [`local-${item.id}.media`, `local-${item.id}.assets`]));
  const root = await navigator.storage.getDirectory() as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> };
  for await (const name of root.keys()) if (/^local-[0-9a-f-]{36}\.(media|assets)$/.test(name) && !keep.has(name)) await root.removeEntry(name).catch(() => {});
}
chrome.runtime.onInstalled.addListener(() => { void setup(true).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void setup(true).catch(() => {}); });
// A suspended MV3 worker can resume without a browser onStartup event.
void setup().catch(() => {});
chrome.commands.onCommand.addListener(command => {
  if (command !== 'default-action') return;
  void currentTab().then(id => { const item = id === undefined ? undefined : media.items(id).next().value; if (item) return download(item); }).catch(() => {});
});
