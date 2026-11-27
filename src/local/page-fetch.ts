/** Bounded, pull-based fetch RPC. Cookies and authentication headers never cross it. */
import { record } from '../security/validation.ts';

export const PAGE_FETCH = 'my-video-app/missav-fetch/';
export const PAGE_SERVER = 'my-video-app/missav-page/';
const CHUNK = 128 * 1024;
export interface FetchWire {
  send(value: unknown): void;
  listen(listener: (value: unknown) => void): void;
  disconnected(listener: () => void): void;
  close(): void;
}
export function chromeWire(port: chrome.runtime.Port): FetchWire {
  return { send: value => port.postMessage(value), listen: listener => port.onMessage.addListener(listener),
    disconnected: listener => port.onDisconnect.addListener(listener), close: () => port.disconnect() };
}
export function messageWire(port: MessagePort): FetchWire {
  port.start();
  return { send: value => port.postMessage(value), listen: listener => port.addEventListener('message', event => listener(event.data)),
    disconnected: listener => port.addEventListener('messageerror', listener), close: () => port.close() };
}
function encode(bytes: Uint8Array): string {
  let value = '';
  for (let at = 0; at < bytes.length; at += 8192) value += Reflect.apply(String.fromCharCode, undefined, bytes.subarray(at, at + 8192));
  return btoa(value);
}
function decode(value: unknown): Uint8Array<ArrayBuffer> {
  if (!record(value)) throw new Error('잘못된 페이지 미디어 응답입니다.');
  if (value.bytes instanceof Uint8Array && value.bytes.length <= CHUNK) return new Uint8Array(value.bytes);
  if (typeof value.base64 !== 'string' || value.base64.length > Math.ceil(CHUNK / 3) * 4) throw new Error('페이지 미디어 응답이 처리 한도를 초과했습니다.');
  const raw = atob(value.base64);
  if (raw.length > CHUNK) throw new Error('페이지 미디어 응답이 처리 한도를 초과했습니다.');
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}
export function requestHeaders(value: unknown): Record<string, string> {
  if (!record(value) || Object.keys(value).length > 2) throw new Error('허용되지 않은 페이지 요청 헤더입니다.');
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' || item.length > 512 || /[\r\n]/.test(item)
      || !['range', 'if-match'].includes(key.toLowerCase())) throw new Error('허용되지 않은 페이지 요청 헤더입니다.');
    if (key.toLowerCase() === 'range' && !/^bytes=\d+-\d*$/.test(item)) throw new Error('잘못된 페이지 미디어 범위입니다.');
    result[key] = item;
  }
  return result;
}
/** One response per wire; one source read per pull, including cancellation. */
export function serveFetch(wire: FetchWire, fetcher: typeof fetch, allowed: (url: string) => boolean, onClose = () => {}): () => void {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let remaining: Uint8Array | undefined, requested = false, pulling = false, ended = false;
  let binary = false;
  let timer: ReturnType<typeof setTimeout>;
  const close = () => { if (ended) return; ended = true; clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => {}); wire.close(); onClose(); };
  const touch = () => { clearTimeout(timer); timer = setTimeout(close, 45_000); };
  const fail = () => { if (!ended) { try { wire.send({ type: 'error', message: '원본 재생 페이지의 미디어 요청에 실패했습니다. 페이지를 열어 재생한 뒤 다시 시도하세요.' }); } finally { close(); } } };
  wire.disconnected(close); touch();
  wire.listen(value => { void (async () => {
    if (ended || !record(value)) return;
    touch();
    if (value.type === 'cancel') { close(); return; }
    if (value.type === 'request') {
      if (requested || typeof value.url !== 'string' || value.url.length > 8192 || !allowed(value.url)) throw new Error('잘못된 요청 범위입니다.');
      requested = true;
      // Older Chrome versions deserialize the probe as a plain object.
      binary = value.binaryProbe instanceof Uint8Array && value.binaryProbe.byteLength === 1;
      const response = await fetcher(value.url, { method: 'GET', headers: requestHeaders(value.headers),
        credentials: 'omit', redirect: 'error', signal: controller.signal });
      if (ended) { await response.body?.cancel(); return; }
      if (response.url && !allowed(response.url)) throw new Error('응답 주소가 요청 범위를 벗어났습니다.');
      const headers: Record<string, string> = {};
      for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Content-Encoding', 'Accept-Ranges', 'ETag', 'Retry-After']) {
        const item = response.headers.get(name); if (item && item.length <= 1024) headers[name] = item;
      }
      reader = response.body?.getReader();
      wire.send({ type: 'headers', status: response.status, url: response.url || value.url, headers });
    } else if (value.type === 'pull') {
      if (!requested || pulling) throw new Error('잘못된 페이지 데이터 요청입니다.');
      pulling = true;
      try {
        if (!remaining?.length) {
          const next = await reader?.read();
          if (!next || next.done) { wire.send({ type: 'end' }); close(); return; }
          remaining = next.value;
        }
        if (ended) return;
        const bytes = remaining.subarray(0, CHUNK); remaining = remaining.subarray(bytes.length);
        if (binary) {
          // Structured clone copies the backing buffer, so send only this view's bytes.
          wire.send({ type: 'data', bytes: bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice() });
        } else wire.send({ type: 'data', base64: encode(bytes) });
      } finally { pulling = false; }
    } else throw new Error('잘못된 페이지 요청입니다.');
  })().catch(fail); });
  wire.send({ type: 'ready' });
  return close;
}

export function fetchFromParent(post: (message: unknown, transfer: Transferable[]) => void): typeof fetch {
  return fetchOverWire(() => {
    const channel = new MessageChannel();
    post({ type: 'page-fetch', port: channel.port2 }, [channel.port2]);
    return messageWire(channel.port1);
  });
}

export function fetchOverWire(open: () => FetchWire): typeof fetch {
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (init.method && init.method !== 'GET') throw new Error('페이지 미디어는 GET 요청만 지원합니다.');
    const signal = init.signal;
    signal?.throwIfAborted();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key] = value; }); requestHeaders(headers);
    const wire = open();
    return await new Promise<Response>((resolve, reject) => {
      let body: ReadableStreamDefaultController<Uint8Array> | undefined, ended = false, gotHeaders = false;
      let timer: ReturnType<typeof setTimeout>;
      const close = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); wire.close(); };
      const fail = (error: Error) => { if (ended) return; ended = true; reject(error); body?.error(error); close(); };
      const abort = () => { try { wire.send({ type: 'cancel' }); } finally { fail(new DOMException('작업을 취소했습니다.', 'AbortError')); } };
      const touch = () => { clearTimeout(timer); timer = setTimeout(() => fail(new Error('재생 페이지의 응답을 기다리는 시간이 초과됐습니다.')), 40_000); };
      signal?.addEventListener('abort', abort, { once: true });
      wire.disconnected(() => fail(new Error('원본 재생 페이지와 연결이 끊겼습니다. 페이지를 열어 재생한 뒤 다시 시도하세요.')));
      wire.listen(value => {
        try {
          if (ended || !record(value)) return;
          touch();
          if (value.type === 'ready') wire.send({ type: 'request', url, headers, binaryProbe: new Uint8Array(1) });
          else if (value.type === 'error') fail(new Error(typeof value.message === 'string' ? value.message.slice(0, 300) : '페이지 미디어 요청 실패'));
          else if (value.type === 'headers') {
            if (gotHeaders || !Number.isInteger(value.status) || Number(value.status) < 200 || Number(value.status) > 599 || !record(value.headers)
              || Object.keys(value.headers).length > 8 || typeof value.url !== 'string' || value.url.length > 8192) throw new Error('잘못된 페이지 미디어 응답입니다.');
            gotHeaders = true;
            const stream = new ReadableStream<Uint8Array>({
              start(controller) { body = controller; },
              pull() { wire.send({ type: 'pull' }); },
              cancel() { if (!ended) { ended = true; wire.send({ type: 'cancel' }); close(); } },
            }, { highWaterMark: 0 });
            const response = new Response([204, 205, 304].includes(Number(value.status)) ? null : stream,
              { status: Number(value.status), headers: value.headers as Record<string, string> });
            Object.defineProperty(response, 'url', { value: value.url }); resolve(response);
          } else if (value.type === 'data') { if (!gotHeaders || !body) throw new Error('응답 헤더가 없습니다.'); body.enqueue(decode(value)); }
          else if (value.type === 'end') { ended = true; body?.close(); close(); }
          else throw new Error('잘못된 페이지 미디어 응답입니다.');
        } catch (error) { fail(error instanceof Error ? error : new Error('페이지 미디어 요청 실패')); }
      });
      touch(); if (signal?.aborted) abort();
    });
  };
}
