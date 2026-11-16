import { record } from '../security/validation.ts';
import { SCOPE, type MediaCatalog, type MediaItem } from './model.ts';
import { isMissavPage, missavMediaURL, missavPlaylistCandidates, missavVideoId } from './missav.ts';

const NO_SOURCE = '이 영상을 재생한 MissAV 탭을 열고 영상을 재생한 뒤 다시 시도하세요. 확장을 업데이트했다면 재생 페이지를 새로고침하세요.';
const samePath = (left: string, right: string) => {
  const a = new URL(left), b = new URL(right);
  // The UUID identifies the video; the observed URL supplies the opaque path
  // and fresh signature. Never rebuild or transplant query parameters.
  return a.pathname.split('/').slice(2).join('/') === b.pathname.split('/').slice(2).join('/');
};
export function missavPageSource(page: string, scripts: Iterable<string>, resources: Iterable<string>, requested: string): string | undefined {
  const id = missavVideoId(requested);
  if (!id || missavMediaURL(requested) !== requested || !isMissavPage(page)) return;
  const candidates = missavPlaylistCandidates(page, scripts, resources).filter(item => missavVideoId(item.url) === id);
  if (!candidates.length) return;
  return candidates.find(item => item.rank === 2 && samePath(item.url, requested))?.url ?? requested;
}
function matchingSource(item: MediaItem, candidates: MediaItem[], tab: chrome.tabs.Tab): MediaItem | undefined {
  if (tab.id === undefined || !tab.url || !isMissavPage(tab.url) || !!tab.incognito !== chrome.extension.inIncognitoContext) return;
  const source = candidates.find(candidate => candidate.tabId === tab.id);
  if (!source) return;
  const fresh = candidates.find(candidate => candidate.tabId === tab.id && candidate.missavRank === 2 && samePath(candidate.url, item.url));
  return { ...item, tabId: tab.id, url: fresh?.url ?? item.url, title: source.title || item.title };
}

/** Direct input and history retries must recover the same page context as detection. */
export async function recoverMissavContext(item: MediaItem, catalog: MediaCatalog): Promise<MediaItem> {
  const id = missavVideoId(item.url);
  if (item.kind !== 'hls' || !id || missavMediaURL(item.url) !== item.url) return item;
  const candidates = [...catalog.tabIds()].flatMap(tabId => [...catalog.items(tabId)])
    .filter(candidate => missavVideoId(candidate.url) === id)
    .sort((a, b) => Number(samePath(b.url, item.url)) - Number(samePath(a.url, item.url)) || b.createdAt - a.createdAt);
  if (item.tabId >= 0) {
    const fresh = candidates.find(candidate => candidate.tabId === item.tabId && candidate.missavRank === 2 && samePath(candidate.url, item.url));
    return fresh && fresh.url !== item.url ? { ...item, url: fresh.url, title: fresh.title || item.title } : item;
  }
  const ids = [...new Set(candidates.map(candidate => candidate.tabId))];
  for (const tabId of ids) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    const found = tab && matchingSource(item, candidates, tab);
    if (found) return found;
  }
  // Catalogs live in the service worker and disappear when Chrome stops it.
  // Existing content scripts can identify their own video without reloading.
  const tabs = (await chrome.tabs.query({})).filter(tab => tab.id !== undefined && tab.url && isMissavPage(tab.url)
    && !!tab.incognito === chrome.extension.inIncognitoContext)
    .sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)).slice(0, 16);
  for (let offset = 0; offset < tabs.length; offset += 4) {
    const found = await Promise.all(tabs.slice(offset, offset + 4).map(async tab => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const response: unknown = await Promise.race([
          chrome.tabs.sendMessage(tab.id!, { scope: SCOPE, type: 'missav-context', url: item.url }, { frameId: 0 }),
          new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1500); }),
        ]);
        if (!record(response) || response.ok !== true || typeof response.url !== 'string'
          || missavVideoId(response.url) !== id || missavMediaURL(response.url) !== response.url) return;
        return { ...item, tabId: tab.id!, url: response.url, title: typeof response.title === 'string' ? response.title.slice(0, 200) : item.title };
      } catch { return; }
      finally { clearTimeout(timer); }
    }));
    const source = found.find(value => value !== undefined);
    if (source) return source;
  }
  throw new Error(NO_SOURCE);
}
