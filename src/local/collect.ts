import { mediaKind, mediaURL, SCOPE } from './model.ts';
import { resourceTransport, transport, type Transport } from './transport.ts';

const sent = new Map<string, string>();
const timings = new Map<string, Transport>();
const candidates = 'video,audio,video source,audio source,a[href]';
const affected = `${candidates},base`;
let timer: ReturnType<typeof setTimeout> | undefined;
let scannedTitle = document.title;
let scannedBase = document.baseURI;
let saturated = false;
function scan() {
  scannedTitle = document.title;
  scannedBase = document.baseURI;
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
  for (const element of document.querySelectorAll(candidates)) {
    if (found.length >= 100) break;
    if (element instanceof HTMLMediaElement) add(element.currentSrc || element.src, '', true);
    else if (element instanceof HTMLSourceElement) add(element.src, element.type, true);
    else if (element instanceof HTMLAnchorElement) add(element.href, '', false);
  }
  for (const url of timings.keys()) { if (found.length >= 100) break; add(url, '', false); }
  // A scan publishes at most 100 discoveries. Preserve the next event as a
  // continuation even when that event itself does not contain media.
  saturated = found.length >= 100;
  if (sent.size > 1000) sent.clear();
  for (let index = 0; index < found.length; index += 10) void chrome.runtime.sendMessage({ scope: SCOPE, type: 'capture', items: found.slice(index, index + 10) }).catch(() => {});
}
function schedule() { clearTimeout(timer); timer = setTimeout(scan, 500); }
try {
  new PerformanceObserver(list => {
    let changed = false;
    for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
      const protocol = transport(entry.nextHopProtocol); if (!protocol) continue;
      try {
        const url = mediaURL(entry.name).href;
        if (timings.get(url) !== protocol && (sent.has(url) || mediaKind(url))) changed = true;
        timings.set(url, protocol);
      } catch { /* Ignore non-network resources. */ }
    }
    while (timings.size > 1000) timings.delete(timings.keys().next().value!);
    if (saturated || changed || document.title !== scannedTitle || document.baseURI !== scannedBase) schedule();
  }).observe({ type: 'resource', buffered: true });
} catch { /* Timing data can be unavailable; downloads still use Chrome negotiation. */ }
new MutationObserver(records => {
  // Unrelated page churn cannot add a media candidate. Relevant changes still
  // use a fresh document scan, avoiding a long-lived cache of DOM elements.
  if (saturated || document.title !== scannedTitle || document.baseURI !== scannedBase) { schedule(); return; }
  for (const record of records) {
    if (record.type === 'attributes') {
      if (record.target instanceof Element && (record.target.matches(affected) || record.target instanceof HTMLAnchorElement)) { schedule(); return; }
    } else if (record.target instanceof HTMLMediaElement) { schedule(); return; }
    else for (const changed of [...record.addedNodes, ...record.removedNodes]) {
      if (changed instanceof Element && (changed.matches(affected) || changed.querySelector(affected))) { schedule(); return; }
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'type'] });
document.addEventListener('loadedmetadata', schedule, true);
scan();
