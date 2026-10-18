import { boundedData, record } from '../security/validation.ts';
import { offerUpscale, revokeDownloadOffers } from '../upscale/completion.ts';
import { OFFER_KEY, MAX_INPUT_BYTES } from '../upscale/policy.ts';
import { SCOPE, OFFSCREEN_SCOPE, HISTORY_KEY, MAX_HISTORY, MAX_MEDIA_PER_TAB, filenameFor, isHistory, mediaKind, mediaURL, trustedCapture, trustedUI, type MediaItem, type HistoryItem } from './model.ts';
import { downloadOptions, type DownloadOptions } from './preferences.ts';
import { transport, type Transport } from './transport.ts';
import { chromeWarning, scanFile, type ScanResult } from './antivirus.ts';

const media = new Map<number, Map<string, MediaItem>>();
const privateHistory = new Map<string, HistoryItem>();
const cancelled = new Set<string>();
const finalizing = new Set<number>();
const finalizeAgain = new Set<number>();
const deciding = new Set<number>();
const activeStates = ['preparing', 'downloading', 'scanning', 'review'];
let lastTab: number | undefined;
let creatingOffscreen: Promise<void> | undefined;

async function history(): Promise<HistoryItem[]> {
  const raw: unknown = (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY];
  return [...(Array.isArray(raw) ? raw.filter(isHistory) : []), ...privateHistory.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_HISTORY);
}
async function update(item: HistoryItem, onlyIfPreparing = false): Promise<void> {
  if (item.incognito) { if (!onlyIfPreparing || privateHistory.get(item.id)?.state === 'preparing') privateHistory.set(item.id, item); return; }
  await navigator.locks.request('my-video-app-history', async () => {
    const current = await history();
    if (onlyIfPreparing && current.find(row => row.id === item.id)?.state !== 'preparing') return;
    const existing = current.filter(row => !row.incognito && row.id !== item.id);
    const rows = [item, ...existing];
    const active = rows.filter(row => activeStates.includes(row.state));
    const completed = rows.filter(row => !activeStates.includes(row.state));
    await chrome.storage.local.set({ [HISTORY_KEY]: [...active, ...completed.slice(0, Math.max(0, MAX_HISTORY - active.length))] });
  });
}
async function change(id: string, edit: (item: HistoryItem) => HistoryItem | undefined): Promise<HistoryItem | undefined> {
  return navigator.locks.request('my-video-app-history', async () => {
    const rows = await history(); const current = rows.find(row => row.id === id);
    if (!current) return undefined;
    const next = edit(current); if (!next) return undefined;
    if (next.incognito) privateHistory.set(next.id, next);
    else await chrome.storage.local.set({ [HISTORY_KEY]: rows.filter(row => !row.incognito).map(row => row.id === id ? next : row) });
    return next;
  });
}
async function reviewNotice(item: HistoryItem) {
  if (item.incognito) return;
  await chrome.notifications.create(`my-video-app-security:${item.id}`, {
    type: 'basic', iconUrl: chrome.runtime.getURL('bitmaps/logo-128-color.png'), title: '다운로드 파일 확인 필요',
    message: `${item.filename}\n${item.security?.status === 'infected' || item.security?.status === 'chrome-warning' ? '위험이 탐지되었습니다.' : '백신 검사가 완료되지 않았습니다.'} 앱에서 삭제 또는 검토를 선택하세요.`,
    requireInteraction: true,
  }).catch(() => {});
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
    const items = media.get(tabId) ?? new Map<string, MediaItem>();
    const existing = items.get(url);
    const mergedMime = mime || existing?.mime || '';
    const kind = existing && existing.kind !== 'file' ? existing.kind : mediaKind(url, mergedMime, fromElement);
    if (!kind) return;
    const item: MediaItem = { ...existing, id: existing?.id ?? crypto.randomUUID(), tabId, url, title: (title || existing?.title || '').slice(0, 200), mime: mergedMime.slice(0, 100), kind, createdAt: Date.now() };
    if (Number.isSafeInteger(size) && size! > 0) item.size = size!;
    const protocol = transport(observed); if (protocol) item.observedTransport = protocol;
    items.set(url, item);
    while (items.size > MAX_MEDIA_PER_TAB) items.delete(Array.from(items).find(([, entry]) => entry.kind === 'file')?.[0] ?? items.keys().next().value!);
    media.set(tabId, items);
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
    const item = (await history()).find(row => row.downloadId === download.id && ['downloading', 'scanning', 'review', 'complete'].includes(row.state));
    if (!item) return;
    const current = (await chrome.downloads.search({ id: download.id }))[0];
    if (!current) { await missingDownload(item); return; }
    const danger = chromeWarning(current.danger);
    if (danger) {
      if (item.state === 'review' && item.security?.status === 'chrome-warning' && item.security.danger === danger) return;
      const next = await change(item.id, row => ['downloading', 'scanning', 'review', 'complete'].includes(row.state)
        ? { ...row, state: 'review', security: { status: 'chrome-warning', token: crypto.randomUUID(), danger, message: 'Chrome이 이 파일을 경고하거나 검사 중입니다. Chrome 다운로드 화면에서 확인하세요.' } } : undefined);
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
      ? { ...row, state: 'scanning', security: { status: 'scanning', token: crypto.randomUUID() } } : undefined);
    if (!scanning) return;
    let result: ScanResult;
    try { result = await scanFile(current.filename); }
    catch { result = { status: 'error', message: '로컬 백신 검사를 완료하지 못했습니다.' }; }
    const latest = (await chrome.downloads.search({ id: current.id }))[0];
    if (!latest) { await missingDownload(scanning); return; }
    if (latest.state !== 'complete' || chromeWarning(latest.danger)) {
      finalizeAgain.add(current.id); return;
    }
    if (latest.filename !== current.filename || (['clean', 'infected'].includes(result.status) && latest.fileSize >= 0 && result.size !== latest.fileSize)) {
      result = { status: 'error', message: '다운로드 파일 정보가 검사 결과와 일치하지 않습니다. 다시 검사하세요.' };
    }
    const next = await change(item.id, row => row.state === 'scanning' && row.security?.token === scanning.security?.token
      ? { ...row, state: result.status === 'clean' ? 'complete' : 'review', security: { ...result, token: crypto.randomUUID() } } : undefined);
    if (!next) return;
    if (next.state === 'review') { await reviewNotice(next); return; }
    await chrome.notifications.clear(`my-video-app-security:${item.id}`).catch(() => {});
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
      await change(id, row => ({ ...row, state: 'scanning', security: { status: 'scanning', token: crypto.randomUUID() } }));
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
  const filename = filenameFor(item);
  const entry: HistoryItem = { id: crypto.randomUUID(), url: item.url, filename: options.output === 'original' ? filename : filename.replace(/\.[^.]+$/, '') + '.' + options.output, kind: item.kind, state: 'preparing', createdAt: Date.now(), incognito: !!tab.incognito || chrome.extension.inIncognitoContext, options };
  await navigator.locks.request('my-video-app-start', async () => {
    const active = (await history()).filter(row => activeStates.includes(row.state));
    if (active.some(row => row.url === item.url && (row.options?.quality ?? 'highest') === options.quality && (row.options?.output ?? 'original') === options.output)) throw new Error('같은 미디어를 이미 처리하고 있습니다.');
    if (active.length >= 8) throw new Error('동시에 준비·다운로드하는 파일은 최대 8개입니다.');
    await update(entry);
  });
  void (async () => {
    try {
      let address = item.url;
      let transferProtocols: Transport[] = [];
      const offers = (await chrome.storage.local.get(OFFER_KEY))[OFFER_KEY] !== false;
      if (options.output !== 'original' || item.kind !== 'file' || (offers && !entry.incognito && (!item.size || item.size <= MAX_INPUT_BYTES))) {
        try {
          await ensureOffscreen();
          if (cancelled.has(entry.id)) throw new DOMException('작업을 취소했습니다.', 'AbortError');
          const result: unknown = await chrome.runtime.sendMessage({ scope: OFFSCREEN_SCOPE, type: 'prepare', id: entry.id, url: item.url, kind: item.kind, options });
          if (!record(result) || result.ok !== true || typeof result.url !== 'string' || !result.url.startsWith(`blob:${chrome.runtime.getURL('')}`)) throw new Error(record(result) && typeof result.error === 'string' ? result.error : '파일을 준비할 수 없습니다.');
          address = result.url;
          if (Array.isArray(result.protocols)) transferProtocols = result.protocols.map(transport).filter((value): value is Transport => value !== undefined);
        } catch (error) {
          if (options.output !== 'original' || item.kind !== 'file' || cancelled.has(entry.id)) throw error;
          // A native direct download still works when optional local prefetch fails.
          address = item.url;
        }
      }
      if (cancelled.has(entry.id)) throw new Error('작업을 취소했습니다.');
      const id = await chrome.downloads.download({ url: address, filename: entry.filename, saveAs: true, conflictAction: 'uniquify' });
      const downloading: HistoryItem = { ...entry, state: 'downloading', downloadId: id, transferProtocols };
      await update(downloading);
      if (cancelled.has(entry.id)) await chrome.downloads.cancel(id).catch(() => {});
      const current = (await chrome.downloads.search({ id }))[0]; if (current) await finish(current);
    } catch (error) {
      const message = error instanceof Error ? error.message : '다운로드 오류';
      const wasCancelled = cancelled.has(entry.id) || /canceled by the user/i.test(message);
      await update({ ...entry, state: wasCancelled ? 'cancelled' : 'error', error: wasCancelled ? '작업을 취소했습니다.' : message.slice(0, 500) });
      await dispose(entry.id).catch(() => {}); cancelled.delete(entry.id);
      if (entry.incognito) privateHistory.delete(entry.id);
    }
  })();
  return entry;
}
async function currentTab() {
  const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (tab?.id !== undefined && tab.url && /^https?:/.test(tab.url)) return tab.id;
  return lastTab ?? Array.from(media.keys()).at(-1);
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
        for (const key of ['loaded', 'total'] as const) if (typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= MAX_INPUT_BYTES) preparation[key] = value[key];
        await update({ ...item, preparation }, true);
      }
    }
    return { ok: true };
  }
  if (value.type === 'capture') {
    if (!trustedCapture(sender, chrome.runtime.id) || !Array.isArray(value.items) || value.items.length > 100) throw new Error('허용되지 않은 수집 요청입니다.');
    for (const item of value.items) if (record(item) && typeof item.url === 'string') add(sender.tab!.id!, item.url, typeof item.mime === 'string' ? item.mime : '', typeof item.title === 'string' ? item.title : '', item.fromElement === true, undefined, item.observedTransport);
    return { ok: true };
  }
  if (!trustedUI(sender, chrome.runtime.id, chrome.runtime.getURL(''))) throw new Error('확장 화면에서만 사용할 수 있습니다.');
  if (['security-keep', 'security-delete', 'security-rescan'].includes(value.type) && typeof value.id === 'string' && typeof value.token === 'string') {
    if (value.type === 'security-keep' && value.confirmed !== true) throw new Error('파일의 위험을 이해했다는 확인이 필요합니다.');
    await securityDecision(value.id, value.token, value.type === 'security-keep' ? 'keep' : value.type === 'security-delete' ? 'delete' : 'rescan');
    return { ok: true };
  }
  if (value.type === 'security-connect') {
    if (!await chrome.permissions.contains({ permissions: ['nativeMessaging'] })) throw new Error('로컬 백신 연결 권한을 먼저 허용하세요.');
    for (const item of await history()) if (item.state === 'review' && item.security && ['unavailable', 'error'].includes(item.security.status)) {
      await securityDecision(item.id, item.security.token, 'rescan').catch(() => {});
    }
    return { ok: true };
  }
  if (value.type === 'review-chrome' && typeof value.id === 'string' && typeof value.token === 'string') {
    const item = (await history()).find(row => row.id === value.id && row.state === 'review' && row.security?.token === value.token);
    if (!item) throw new Error('검사 상태가 변경되었습니다.');
    await chrome.tabs.create({ url: 'chrome://downloads/' }); return { ok: true };
  }
  if (value.type === 'list') {
    const tabId = await currentTab();
    const items = tabId === undefined ? [] : Array.from(media.get(tabId)?.values() ?? []).sort((a, b) => b.createdAt - a.createdAt);
    const rows = await history();
    const progress = await Promise.all(rows.map(async row => {
      if (row.state !== 'downloading' || row.downloadId === undefined) return row;
      const download = (await chrome.downloads.search({ id: row.downloadId }).catch(() => []))[0];
      return download ? { ...row, receivedBytes: download.bytesReceived, totalBytes: download.totalBytes } : row;
    }));
    return { ok: true, items, history: progress, tabId };
  }
  if (value.type === 'download' && typeof value.id === 'string') {
    const item = Array.from(media.values()).flatMap(map => Array.from(map.values())).find(row => row.id === value.id);
    if (!item) throw new Error('미디어가 만료되었습니다. 원래 페이지를 새로고침하세요.');
    return { ok: true, item: await download(item, downloadOptions(value.options)) };
  }
  if (value.type === 'download-url' && typeof value.url === 'string') {
    const url = mediaURL(value.url).href;
    return { ok: true, item: await download({ id: crypto.randomUUID(), tabId: -1, url, title: '', mime: '', kind: mediaKind(url) ?? 'file', createdAt: Date.now() }, downloadOptions(value.options)) };
  }
  if (value.type === 'retry' && typeof value.id === 'string') {
    const item = (await history()).find(row => row.id === value.id && ['error', 'cancelled'].includes(row.state));
    if (!item) throw new Error('다시 시도할 다운로드가 없습니다.');
    return { ok: true, item: await download({ id: crypto.randomUUID(), tabId: -1, url: mediaURL(item.url).href, title: item.filename, mime: '', kind: item.kind, createdAt: Date.now() }, downloadOptions(item.options)) };
  }
  if (value.type === 'cancel' && typeof value.id === 'string') {
    const item = (await history()).find(row => row.id === value.id);
    if (!item || !['preparing', 'downloading'].includes(item.state)) throw new Error('진행 중인 작업이 아닙니다.');
    cancelled.add(item.id);
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
      await chrome.storage.local.set({ [HISTORY_KEY]: (await history()).filter(row => !row.incognito && activeStates.includes(row.state)) });
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
  const header = (name: string) => details.responseHeaders?.find(h => h.name.toLowerCase() === name)?.value;
  const size = Number(details.statusCode === 206 ? header('content-range')?.match(/^bytes \d+-\d+\/(\d+)$/i)?.[1] : header('content-length'));
  add(details.tabId, details.url, type, '', false, size);
  return undefined;
}, { urls: ['http://*/*', 'https://*/*'] }, ['responseHeaders']);
chrome.downloads.onChanged.addListener(delta => {
  if (delta.state || delta.danger) void chrome.downloads.search({ id: delta.id }).then(items => { if (items[0]) return finish(items[0]); }).catch(() => {});
});
chrome.notifications.onClicked.addListener(id => {
  if (!/^my-video-app-security:[a-f0-9-]{36}$/.test(id)) return;
  void chrome.tabs.create({ url: chrome.runtime.getURL('local/index.html?view=history') });
});
chrome.tabs.onRemoved.addListener(id => { media.delete(id); if (lastTab === id) lastTab = undefined; });
chrome.tabs.onUpdated.addListener((id, changes, tab) => {
  if (changes.status === 'loading') media.delete(id);
  if (tab.active && tab.url && /^https?:/.test(tab.url)) lastTab = id;
});
chrome.tabs.onActivated.addListener(info => { void chrome.tabs.get(info.tabId).then(tab => { if (tab.url && /^https?:/.test(tab.url)) lastTab = info.tabId; }).catch(() => {}); });
async function setup(restarted = false) {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => chrome.action.setPopup({ popup: 'local/index.html' }));
  for (const item of await history()) {
    if (restarted && item.state === 'preparing') {
      await update({ ...item, state: 'error', error: '브라우저가 다시 시작되어 준비 작업이 중단되었습니다. 다시 다운로드하세요.' });
      await dispose(item.id).catch(() => {});
    } else if (['downloading', 'scanning', 'review', 'complete'].includes(item.state) && item.downloadId !== undefined) {
      const current = (await chrome.downloads.search({ id: item.downloadId }))[0];
      if (current) await finish(current);
      else await missingDownload(item);
    }
  }
  const keep = new Set((await history()).filter(item => activeStates.includes(item.state)).map(item => `local-${item.id}.media`));
  const root = await navigator.storage.getDirectory() as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> };
  for await (const name of root.keys()) if (/^local-[0-9a-f-]{36}\.media$/.test(name) && !keep.has(name)) await root.removeEntry(name).catch(() => {});
}
chrome.runtime.onInstalled.addListener(() => { void setup().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void setup(true).catch(() => {}); });
// A suspended MV3 worker can resume without a browser onStartup event.
void setup().catch(() => {});
chrome.commands.onCommand.addListener(command => {
  if (command !== 'default-action') return;
  void currentTab().then(id => { const item = id === undefined ? undefined : Array.from(media.get(id)?.values() ?? [])[0]; if (item) return download(item); }).catch(() => {});
});
