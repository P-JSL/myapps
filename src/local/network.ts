import { mediaURL } from './model.ts';
import { observeTransport, type Transport } from './transport.ts';

export interface ByteRange { offset: number; length: number; }
export function validRange(range: ByteRange): void {
  if (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || !Number.isSafeInteger(range.offset + range.length) || range.offset < 0 || range.length < 1 || range.length > 128 * 1024 * 1024) throw new Error('미디어 바이트 범위가 허용 범위를 초과했습니다.');
}
/** Counts retained bytes across parallel requests, including their in-flight chunks. */
export class ByteBudget {
  private used = 0;
  readonly limit: number;
  constructor(limit: number) { if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('잘못된 용량 한도입니다.'); this.limit = limit; }
  take(bytes: number) { if (this.used + bytes > this.limit) throw new Error('미디어 용량이 처리 한도를 초과했습니다.'); this.used += bytes; }
  release(bytes: number) { this.used -= bytes; }
  get remaining() { return this.limit - this.used; }
}
interface FetchMonitor { budget?: ByteBudget; progress?: (loaded: number, total?: number) => void; protocol?: (value: Transport) => void; finalURL?: (value: string) => void; }
class Retryable extends Error { readonly delay: number | undefined; constructor(message: string, delay?: number) { super(message); this.delay = delay; } }
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
export function retryDelay(header: string | null, now = Date.now()): number | undefined {
  if (header === null) return undefined;
  const text = header.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text); return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(signal.reason ?? new DOMException('취소했습니다.', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
  });
}
export async function fetchBytes(url: string, maximum: number, signal: AbortSignal, range?: ByteRange, monitor: FetchMonitor = {}): Promise<Uint8Array<ArrayBuffer>> {
  // Chrome negotiates HTTP/1.1, HTTP/2 or HTTP/3 for this ordinary HTTP(S) URL.
  // Do not force hop-by-hop headers, invent h3:// URLs or bypass its TLS/proxy policy.
  const address = mediaURL(url).href;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256 * 1024 * 1024) throw new Error('미디어 용량이 처리 한도를 초과했습니다.');
  if (range) validRange(range);
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let reserved = 0;
    let success = false;
    let failure: unknown;
    let observation: ReturnType<typeof observeTransport> | undefined;
    try {
      const started = performance.now();
      observation = observeTransport(address, started);
      const options: RequestInit = { credentials: 'include', redirect: 'follow', signal: AbortSignal.any([signal, controller.signal]) };
      if (range) options.headers = { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` };
      response = await fetch(address, options);
      if (!response.ok) {
        const delay = retryDelay(response.headers.get('Retry-After'));
        const message = `미디어 요청 실패 (${response.status})${delay !== undefined && delay > 5000 ? ' · 서버가 더 긴 대기를 요청했습니다. 나중에 다시 시도하세요.' : ''}`;
        if (RETRY_STATUS.has(response.status) && (delay === undefined || delay <= 5000)) throw new Retryable(message, delay);
        throw new Error(message);
      }
      if (!response.body) throw new Error('미디어 응답에 파일 데이터가 없습니다.');
      const finalURL = response.url ? mediaURL(response.url).href : address;
      if (!range && response.status === 206) throw new Error('전체 파일 요청에 일부 미디어만 반환되었습니다.');
      const length = response.headers.get('Content-Length');
      const declared = length !== null && /^\d+$/.test(length) ? Number(length) : undefined;
      if (declared !== undefined && declared > maximum) throw new Error('미디어 용량이 처리 한도를 초과했습니다.');
      const encoding = response.headers.get('Content-Encoding');
      if (range && encoding && encoding.toLowerCase() !== 'identity') throw new Error('압축된 미디어 바이트 범위는 지원하지 않습니다.');
      if (range && response.status === 206) {
        const contentRange = response.headers.get('Content-Range')?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i);
        if (!contentRange || Number(contentRange[1]) !== range.offset || Number(contentRange[2]) !== range.offset + range.length - 1
          || (contentRange[3] !== '*' && Number(contentRange[3]) <= Number(contentRange[2]))) throw new Error('서버가 잘못된 미디어 범위를 반환했습니다.');
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const result = await reader.read(); if (result.done) break;
        total += result.value.length;
        if (total > maximum) throw new Error('미디어 용량이 처리 한도를 초과했습니다.');
        monitor.budget?.take(result.value.length); reserved += result.value.length;
        chunks.push(result.value); monitor.progress?.(total, encoding && encoding !== 'identity' ? undefined : declared);
      }
      if (!total) throw new Error('미디어 파일이 비어 있습니다.');
      if ((!encoding || encoding === 'identity') && declared !== undefined && total !== declared) throw new Retryable('미디어 파일이 불완전합니다.');
      let result = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
      if (range) {
        if (response.status === 206) { if (result.length !== range.length) throw new Retryable('미디어 조각이 불완전합니다.'); }
        else {
          if (response.status !== 200 || result.length < range.offset + range.length) throw new Error('서버가 바이트 범위를 지원하지 않습니다.');
          result = result.slice(range.offset, range.offset + range.length);
          monitor.budget?.release(reserved - result.length); reserved = result.length;
        }
      }
      const protocol = await observation.finish();
      signal.throwIfAborted();
      if (protocol) monitor.protocol?.(protocol);
      monitor.finalURL?.(finalURL);
      success = true; return result;
    } catch (error) { failure = error; }
    finally {
      clearTimeout(timer); controller.abort();
      observation?.cancel();
      if (reader) await reader.cancel().catch(() => {}); else await response?.body?.cancel().catch(() => {});
      if (!success) monitor.budget?.release(reserved);
    }
    signal.throwIfAborted();
    if (attempt >= 2 || (!(failure instanceof Retryable) && !(failure instanceof TypeError) && !timedOut)) throw failure;
    await wait(failure instanceof Retryable && failure.delay !== undefined ? failure.delay : 300 * 2 ** attempt, signal);
  }
}
export async function fetchManifest(url: string, signal: AbortSignal): Promise<string> {
  return (await fetchManifestResource(url, signal)).text;
}
export interface ManifestResource { text: string; url: string; }
/** Relative manifest references use the URL of the successful response, after redirects. */
export async function fetchManifestResource(url: string, signal: AbortSignal): Promise<ManifestResource> {
  let address = mediaURL(url).href;
  const bytes = await fetchBytes(address, 2 * 1024 * 1024, signal, undefined, { finalURL: value => { address = value; } });
  return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), url: address };
}
