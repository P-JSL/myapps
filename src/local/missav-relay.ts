import { record } from '../security/validation.ts';
import { isMissavPage, missavMediaURL, isMissavAssetURL } from './missav.ts';
import { PAGE_FETCH, PAGE_SERVER, chromeWire, serveFetch } from './page-fetch.ts';

const KEY = 'my_video_app_missav_job_';
const ID = /^[a-f0-9-]{36}$/;
export async function bindMissavJob(id: string, tab: Partial<chrome.tabs.Tab>, manifest: string): Promise<boolean> {
  if (!ID.test(id) || tab.id === undefined || !tab.url || !isMissavPage(tab.url) || missavMediaURL(manifest) !== manifest) return false;
  await chrome.storage.session.set({ [KEY + id]: { tabId: tab.id, page: tab.url, manifest } });
  return true;
}
export async function unbindMissavJob(id: string): Promise<void> { await chrome.storage.session.remove(KEY + id); }

/** The background alone authorizes a job's original top-level tab and video ID. */
export function installMissavRelay(): void {
  const active = new Map<string, Set<chrome.runtime.Port>>();
  chrome.runtime.onConnect?.addListener(port => {
    if (!port.name.startsWith(PAGE_FETCH)) return;
    const id = port.name.slice(PAGE_FETCH.length);
    if (!ID.test(id) || port.sender?.id !== chrome.runtime.id || port.sender.tab
      || port.sender.url !== chrome.runtime.getURL('local/offscreen.html')) { port.disconnect(); return; }
    const ports = active.get(id) ?? new Set<chrome.runtime.Port>();
    if (ports.size >= 8 || [...active.values()].reduce((sum, item) => sum + item.size, 0) >= 64) { port.disconnect(); return; }
    ports.add(port); active.set(id, ports);
    let remote: chrome.runtime.Port | undefined, closed = false;
    const close = () => { if (closed) return; closed = true; ports.delete(port); if (!ports.size) active.delete(id); port.disconnect(); remote?.disconnect(); };
    port.onDisconnect.addListener(close);
    port.onMessage.addListener(value => {
      if (!remote || !record(value)) { close(); return; }
      remote.postMessage(value);
    });
    void (async () => {
      const values = await chrome.storage.session.get(KEY + id);
      const binding = values[KEY + id];
      if (!record(binding) || !Number.isInteger(binding.tabId) || typeof binding.page !== 'string'
        || !isMissavPage(binding.page) || typeof binding.manifest !== 'string' || !missavMediaURL(binding.manifest)) throw new Error('작업 바인딩 없음');
      const tab = await chrome.tabs.get(Number(binding.tabId));
      if (closed) return;
      if (tab.url !== binding.page || !!tab.incognito !== chrome.extension.inIncognitoContext) throw new Error('원본 페이지가 변경됨');
      remote = chrome.tabs.connect(Number(binding.tabId), { frameId: 0, name: PAGE_SERVER + binding.manifest });
      remote.onDisconnect.addListener(close);
      remote.onMessage.addListener(value => { if (!closed) port.postMessage(value); });
    })().catch(close);
  });
}

/** Content-script fetch follows the same origin/CORS rules as the playing page. */
export function installMissavPageFetch(): void {
  if (!isMissavPage(location.href)) return;
  let active = 0;
  chrome.runtime.onConnect?.addListener(port => {
    if (!port.name.startsWith(PAGE_SERVER)) return;
    const manifest = port.name.slice(PAGE_SERVER.length);
    if (port.sender?.id !== chrome.runtime.id || port.sender.tab || !isMissavPage(location.href)
      || !missavMediaURL(manifest) || active >= 32) { port.disconnect(); return; }
    active++;
    let done = false;
    const release = () => { if (!done) { done = true; active--; } };
    port.onDisconnect.addListener(release);
    const hide = () => { close(); release(); };
    // A source document can set no-referrer even though its player supplies an
    // explicit referrer. Keep the CDN's required page origin on these authorized
    // job requests; never send the page path or query string.
    const mediaFetch: typeof fetch = (address, options) => fetch(address, {
      ...options, referrer: location.origin + '/', referrerPolicy: 'origin',
    });
    const close = serveFetch(chromeWire(port), mediaFetch, address => isMissavAssetURL(address, manifest), () => { removeEventListener('pagehide', hide); release(); });
    addEventListener('pagehide', hide, { once: true });
  });
}
