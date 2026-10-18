import { boundedData, record } from '../security/validation.ts';
import { offerUpscale } from '../upscale/completion.ts';
import { OFFER_KEY, MAX_INPUT_BYTES } from '../upscale/policy.ts';
import { SCOPE, OFFSCREEN_SCOPE, HISTORY_KEY, MAX_HISTORY, MAX_MEDIA_PER_TAB, filenameFor, isHistory, mediaKind, mediaURL, trustedCapture, trustedUI, type MediaItem, type HistoryItem } from './model.ts';

const media = new Map<number, Map<string, MediaItem>>();
const privateHistory = new Map<string, HistoryItem>();
const cancelled = new Set<string>();
const finalizing = new Set<number>();
let lastTab: number | undefined;
let creatingOffscreen: Promise<void> | undefined;

async function history(): Promise<HistoryItem[]> {
  const raw: unknown = (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY];
  return [...(Array.isArray(raw) ? raw.filter(isHistory) : []), ...privateHistory.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_HISTORY);
}
async function update(item: HistoryItem): Promise<void> {
  if (item.incognito) { privateHistory.set(item.id, item); return; }
  await navigator.locks.request('my-video-app-history', async () => {
    const existing = (await history()).filter(row => !row.incognito && row.id !== item.id);
    const rows = [item, ...existing];
    const active = rows.filter(row => row.state === 'preparing' || row.state === 'downloading');
    const completed = rows.filter(row => row.state !== 'preparing' && row.state !== 'downloading');
    await chrome.storage.local.set({ [HISTORY_KEY]: [...active, ...completed.slice(0, Math.max(0, MAX_HISTORY - active.length))] });
  });
}
function add(tabId: number, address: unknown, mime: string, title: string, fromElement: boolean, size?: number) {
  try {
    const url = mediaURL(address).href;
    const kind = mediaKind(url, mime, fromElement);
    if (!kind) return;
    const items = media.get(tabId) ?? new Map<string, MediaItem>();
    const existing = items.get(url);
    const item: MediaItem = { id: existing?.id ?? crypto.randomUUID(), tabId, url, title: title.slice(0, 200), mime: mime.slice(0, 100), kind, createdAt: Date.now() };
    if (Number.isSafeInteger(size) && size! > 0) item.size = size!;
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
async function finish(download: chrome.downloads.DownloadItem) {
  if (!['complete', 'interrupted'].includes(download.state) || finalizing.has(download.id)) return;
  finalizing.add(download.id);
  try {
    const item = (await history()).find(row => row.downloadId === download.id && row.state === 'downloading');
    if (!item) return;
    const complete = download.state === 'complete';
    const next: HistoryItem = { ...item, state: complete ? 'complete' : cancelled.has(item.id) || download.error === 'USER_CANCELED' ? 'cancelled' : 'error' };
    if (!complete && next.state === 'error') next.error = download.error || '다운로드가 중단되었습니다.';
    await update(next);
    if (complete) await offerUpscale({ internalFilename: `local-${item.id}.media`, filename: item.filename, downloadId: download.id, success: true, incognito: item.incognito });
    await dispose(item.id);
    if (item.incognito) privateHistory.delete(item.id);
    cancelled.delete(item.id);
  } finally { finalizing.delete(download.id); }
}
async function download(item: MediaItem) {
  const tab = item.tabId < 0 ? { incognito: chrome.extension.inIncognitoContext } : await chrome.tabs.get(item.tabId);
  const entry: HistoryItem = { id: crypto.randomUUID(), url: item.url, filename: filenameFor(item), kind: item.kind, state: 'preparing', createdAt: Date.now(), incognito: !!tab.incognito || chrome.extension.inIncognitoContext };
  await navigator.locks.request('my-video-app-start', async () => {
    const active = (await history()).filter(row => row.state === 'preparing' || row.state === 'downloading');
    if (active.some(row => row.url === item.url)) throw new Error('같은 미디어를 이미 처리하고 있습니다.');
    if (active.length >= 8) throw new Error('동시에 준비·다운로드하는 파일은 최대 8개입니다.');
    await update(entry);
  });
  void (async () => {
    try {
      let address = item.url;
      const offers = (await chrome.storage.local.get(OFFER_KEY))[OFFER_KEY] !== false;
      if (item.kind !== 'file' || (offers && !entry.incognito && (!item.size || item.size <= MAX_INPUT_BYTES))) {
        try {
          await ensureOffscreen();
          const result: unknown = await chrome.runtime.sendMessage({ scope: OFFSCREEN_SCOPE, type: 'prepare', id: entry.id, url: item.url, kind: item.kind });
          if (!record(result) || result.ok !== true || typeof result.url !== 'string' || !result.url.startsWith(`blob:${chrome.runtime.getURL('')}`)) throw new Error(record(result) && typeof result.error === 'string' ? result.error : '파일을 준비할 수 없습니다.');
          address = result.url;
        } catch (error) {
          if (item.kind !== 'file' || cancelled.has(entry.id)) throw error;
          // A native direct download still works when optional local prefetch fails.
          address = item.url;
        }
      }
      if (cancelled.has(entry.id)) throw new Error('작업을 취소했습니다.');
      const id = await chrome.downloads.download({ url: address, filename: entry.filename, saveAs: true, conflictAction: 'uniquify' });
      const downloading: HistoryItem = { ...entry, state: 'downloading', downloadId: id };
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
    return { ok: true };
  }
  if (value.type === 'capture') {
    if (!trustedCapture(sender, chrome.runtime.id) || !Array.isArray(value.items) || value.items.length > 100) throw new Error('허용되지 않은 수집 요청입니다.');
    for (const item of value.items) if (record(item) && typeof item.url === 'string') add(sender.tab!.id!, item.url, typeof item.mime === 'string' ? item.mime : '', typeof item.title === 'string' ? item.title : '', item.fromElement === true);
    return { ok: true };
  }
  if (!trustedUI(sender, chrome.runtime.id, chrome.runtime.getURL(''))) throw new Error('확장 화면에서만 사용할 수 있습니다.');
  if (value.type === 'list') {
    const tabId = await currentTab();
    const items = tabId === undefined ? [] : Array.from(media.get(tabId)?.values() ?? []).sort((a, b) => b.createdAt - a.createdAt);
    return { ok: true, items, history: await history(), tabId };
  }
  if (value.type === 'download' && typeof value.id === 'string') {
    const item = Array.from(media.values()).flatMap(map => Array.from(map.values())).find(row => row.id === value.id);
    if (!item) throw new Error('미디어가 만료되었습니다. 원래 페이지를 새로고침하세요.');
    return { ok: true, item: await download(item) };
  }
  if (value.type === 'download-url' && typeof value.url === 'string') {
    const url = mediaURL(value.url).href;
    return { ok: true, item: await download({ id: crypto.randomUUID(), tabId: -1, url, title: '', mime: '', kind: mediaKind(url) ?? 'file', createdAt: Date.now() }) };
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
    chrome.downloads.show(item.downloadId); return { ok: true };
  }
  if (value.type === 'clear-history') {
    await navigator.locks.request('my-video-app-history', async () => {
      await chrome.storage.local.set({ [HISTORY_KEY]: (await history()).filter(row => !row.incognito && ['preparing', 'downloading'].includes(row.state)) });
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
  const size = Number(details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-length')?.value);
  add(details.tabId, details.url, type, '', false, size);
  return undefined;
}, { urls: ['http://*/*', 'https://*/*'] }, ['responseHeaders']);
chrome.downloads.onChanged.addListener(delta => {
  if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') void chrome.downloads.search({ id: delta.id }).then(items => { if (items[0]) return finish(items[0]); }).catch(() => {});
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
    } else if (item.state === 'downloading' && item.downloadId !== undefined) {
      const current = (await chrome.downloads.search({ id: item.downloadId }))[0];
      if (current) await finish(current);
      else { await update({ ...item, state: 'error', error: '브라우저의 다운로드 기록을 찾을 수 없습니다.' }); await dispose(item.id).catch(() => {}); }
    }
  }
  const keep = new Set((await history()).filter(item => item.state === 'preparing' || item.state === 'downloading').map(item => `local-${item.id}.media`));
  const root = await navigator.storage.getDirectory() as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> };
  for await (const name of root.keys()) if (/^local-[0-9a-f-]{36}\.media$/.test(name) && !keep.has(name)) await root.removeEntry(name).catch(() => {});
}
chrome.runtime.onInstalled.addListener(() => { void setup().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void setup(true).catch(() => {}); });
chrome.commands.onCommand.addListener(command => {
  if (command !== 'default-action') return;
  void currentTab().then(id => { const item = id === undefined ? undefined : Array.from(media.get(id)?.values() ?? [])[0]; if (item) return download(item); }).catch(() => {});
});
