import { mediaKind, mediaURL, SCOPE } from './model.ts';

const sent = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
function scan() {
  const found: Array<{ url: string; title: string; mime: string; fromElement: boolean }> = [];
  const add = (value: string, mime: string, fromElement: boolean) => {
    try {
      const url = mediaURL(value, location.href).href;
      if (sent.has(url) || !mediaKind(url, mime, fromElement)) return;
      sent.add(url); found.push({ url, title: document.title.slice(0, 200), mime: mime.slice(0, 100), fromElement });
    } catch { /* blob/MSE sources are discovered through network manifests instead. */ }
  };
  for (const element of document.querySelectorAll('video,audio,video source,audio source,a[href]')) {
    if (found.length >= 100) break;
    if (element instanceof HTMLMediaElement) add(element.currentSrc || element.src, '', true);
    else if (element instanceof HTMLSourceElement) add(element.src, element.type, true);
    else if (element instanceof HTMLAnchorElement) add(element.href, '', false);
  }
  if (sent.size > 1000) sent.clear();
  for (let index = 0; index < found.length; index += 10) void chrome.runtime.sendMessage({ scope: SCOPE, type: 'capture', items: found.slice(index, index + 10) }).catch(() => {});
}
function schedule() { clearTimeout(timer); timer = setTimeout(scan, 500); }
new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href'] });
document.addEventListener('loadedmetadata', schedule, true);
scan();
