import { bridge } from './common.ts';
const bus = bridge(['javrank_request_manifest'], ['javrank_on_manifest']);
let manifest: string | undefined;
function send(raw: string) {
  if (raw.length <= 16 * 1024 * 1024 && raw.trimStart().startsWith('#EXTM3U')) {
    manifest = raw;
    bus.send('javrank_on_manifest', { raw });
  }
}
const originalOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['open']>) {
  this.addEventListener('load', () => {
    try { if (this.responseURL.includes('.m3u8') && (!this.responseType || this.responseType === 'text')) send(this.responseText); } catch { /* Binary responses have no responseText. */ }
  }, { once: true });
  return Reflect.apply(originalOpen, this, args);
} as XMLHttpRequest['open'];
bus.listen(() => { if (manifest) send(manifest); });
