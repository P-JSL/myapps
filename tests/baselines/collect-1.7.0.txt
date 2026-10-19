import { mediaKind, mediaURL, SCOPE } from './model.ts';
import { resourceTransport, transport, type Transport } from './transport.ts';

const sent = new Map<string, string>();
const timings = new Map<string, Transport>();
let timer: ReturnType<typeof setTimeout> | undefined;
function scan() {
  const found: Array<{ url: string; title: string; mime: string; fromElement: boolean; observedTransport?: Transport }> = [];
  const add = (value: string, mime: string, fromElement: boolean) => {
    try {
      const url = mediaURL(value, location.href).href;
      if (!mediaKind(url, mime, fromElement)) return;
      const protocol = timings.get(url) ?? resourceTransport(url);
      const signature = `${mime}|${document.title.slice(0, 200)}|${protocol ?? ''}`;
      if (sent.get(url) === signature) return;
      sent.set(url, signature); found.push({ url, title: document.title.slice(0, 200), mime: mime.slice(0, 100), fromElement, ...(protocol ? { observedTransport: protocol } : {}) });
    } catch { /* blob/MSE sources are discovered through network manifests instead. */ }
  };
  for (const element of document.querySelectorAll('video,audio,video source,audio source,a[href]')) {
    if (found.length >= 100) break;
    if (element instanceof HTMLMediaElement) add(element.currentSrc || element.src, '', true);
    else if (element instanceof HTMLSourceElement) add(element.src, element.type, true);
    else if (element instanceof HTMLAnchorElement) add(element.href, '', false);
  }
  for (const url of timings.keys()) { if (found.length >= 100) break; add(url, '', false); }
  if (sent.size > 1000) sent.clear();
  for (let index = 0; index < found.length; index += 10) void chrome.runtime.sendMessage({ scope: SCOPE, type: 'capture', items: found.slice(index, index + 10) }).catch(() => {});
}
function schedule() { clearTimeout(timer); timer = setTimeout(scan, 500); }
try {
  new PerformanceObserver(list => {
    for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
      const protocol = transport(entry.nextHopProtocol); if (!protocol) continue;
      try { timings.set(mediaURL(entry.name).href, protocol); } catch { /* Ignore non-network resources. */ }
    }
    while (timings.size > 1000) timings.delete(timings.keys().next().value!);
    schedule();
  }).observe({ type: 'resource', buffered: true });
} catch { /* Timing data can be unavailable; downloads still use Chrome negotiation. */ }
new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href'] });
document.addEventListener('loadedmetadata', schedule, true);
scan();
