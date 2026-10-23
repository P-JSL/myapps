import { inspectMediaFile, type MediaFileFormat } from './media-file.ts';
import { mediaURL } from './model.ts';
import { retryDelay } from './network.ts';
import { observeTransport, type Transport } from './transport.ts';

const PREFIX_BYTES = 65_536;
const CHUNK_BYTES = 4 * 1024 * 1024;
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
export interface PositionedSink {
  /** Concurrent calls must retain each complete write at its supplied offset. */
  write(position: number, data: Uint8Array<ArrayBuffer>): Promise<void>;
}
export interface ParallelDownloadMonitor {
  progress?: (loaded: number, total?: number) => void;
  protocol?: (value: Transport) => void;
  fetch?: typeof globalThis.fetch;
  /** Internal controls for tests; production defaults use four 4MiB requests. */
  chunkBytes?: number;
  concurrency?: number;
  inactivityMs?: number;
}
export interface ParallelFileResult {
  size: number;
  prefix: Uint8Array<ArrayBuffer>;
  /** Absent only for a valid ID3 header extending beyond the prefix: inspect the final disk file. */
  format?: MediaFileFormat;
  mode: 'parallel' | 'single';
  protocols: Transport[];
}
class RetryableDownloadError extends Error {
  readonly delay: number | undefined;
  constructor(message: string, delay?: number) { super(message); this.delay = delay; }
}
function prefixFormat(prefix: Uint8Array): MediaFileFormat | undefined {
  try { return inspectMediaFile(prefix); }
  catch (error) {
    if (prefix.length >= 10 && prefix[0] === 73 && prefix[1] === 68 && prefix[2] === 51
      && [2, 3, 4].includes(prefix[3]!) && prefix[4] !== 255 && prefix.subarray(6, 10).every(value => value < 128)) {
      let offset = 10 + prefix[6]! * 2 ** 21 + prefix[7]! * 2 ** 14 + prefix[8]! * 128 + prefix[9]!;
      if (prefix[3] === 4 && (prefix[5]! & 0x10)) offset += 10;
      if (offset + 4 > prefix.length) return undefined;
    }
    throw error;
  }
}
interface RequestBody {
  response: Response;
  read(): Promise<ReadableStreamReadResult<Uint8Array<ArrayBuffer>>>;
  close(): Promise<void>;
  complete(): Promise<void>;
}
function safeInteger(text: string | undefined): number | undefined {
  if (text === undefined || !/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function contentRange(response: Response): { start: number; end: number; total?: number } {
  const fields = response.headers.get('Content-Range')?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i);
  const start = safeInteger(fields?.[1]), end = safeInteger(fields?.[2]);
  const total = fields?.[3] === '*' ? undefined : safeInteger(fields?.[3]);
  if (start === undefined || end === undefined || start > end || !Number.isSafeInteger(end + 1)
    || (fields?.[3] !== '*' && (total === undefined || total <= end))) throw new Error('서버가 잘못된 다운로드 범위를 반환했습니다.');
  return { start, end, ...(total === undefined ? {} : { total }) };
}
function identityEncoding(response: Response): boolean {
  const encoding = response.headers.get('Content-Encoding');
  return !encoding || encoding.trim().toLowerCase() === 'identity';
}
function declaredLength(response: Response): number | undefined {
  const text = response.headers.get('Content-Length');
  if (text === null) return undefined;
  const value = safeInteger(text);
  if (value === undefined) throw new Error('서버의 파일 크기가 올바르지 않습니다.');
  return value;
}
function strongETag(response: Response): string | undefined {
  const value = response.headers.get('ETag');
  return value && value.length <= 1024 && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value) ? value : undefined;
}
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
}
function interrupted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

/** Streams to a caller-owned disk sink; total size/duration never becomes a RAM allocation. */
export async function downloadParallelFile(url: string, sink: PositionedSink, signal: AbortSignal,
  monitor: ParallelDownloadMonitor = {}): Promise<ParallelFileResult> {
  const address = mediaURL(url).href;
  const chunkBytes = monitor.chunkBytes ?? CHUNK_BYTES, concurrency = monitor.concurrency ?? 4;
  const inactivityMs = monitor.inactivityMs ?? 30_000;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > CHUNK_BYTES
    || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4
    || !Number.isSafeInteger(inactivityMs) || inactivityMs < 1 || inactivityMs > 120_000) throw new Error('다운로드 작업 설정이 올바르지 않습니다.');
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
  const protocols = new Set<Transport>();
  const fetching = monitor.fetch ?? globalThis.fetch;
  const recordProtocol = (value: Transport) => { protocols.add(value); monitor.protocol?.(value); };
  async function request(target: string, headers?: HeadersInit): Promise<RequestBody> {
    combined.throwIfAborted();
    const local = new AbortController(), active = AbortSignal.any([combined, local.signal]);
    const observation = observeTransport(target, performance.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
    let closed = false;
    async function pending<T>(work: () => Promise<T>): Promise<T> {
      active.throwIfAborted();
      timer = setTimeout(() => local.abort(new RetryableDownloadError('다운로드 응답 대기 시간이 초과되었습니다.')), inactivityMs);
      try { return await interrupted(work(), active); }
      finally { if (timer) clearTimeout(timer); timer = undefined; }
    }
    const close = async () => {
      if (closed) return; closed = true;
      if (timer) clearTimeout(timer);
      local.abort(); observation.cancel();
      if (reader) await reader.cancel().catch(() => {}); else await response?.body?.cancel().catch(() => {});
    };
    try {
      response = await pending<Response>(() => fetching(target, { method: 'GET', credentials: 'include', redirect: 'follow', signal: active, ...(headers ? { headers } : {}) }).then(value => {
        if (active.aborted) { void value.body?.cancel().catch(() => {}); active.throwIfAborted(); }
        return value;
      }));
      if (!response.ok) {
        const delay = retryDelay(response.headers.get('Retry-After'));
        const message = `다운로드 요청 실패 (${response.status})${delay !== undefined && delay > 5000 ? ' · 서버가 긴 대기를 요청했습니다.' : ''}`;
        if (RETRY_STATUS.has(response.status) && (delay === undefined || delay <= 5000)) throw new RetryableDownloadError(message, delay);
        throw new Error(message);
      }
      if (!response.body) throw new Error('다운로드 응답에 파일 데이터가 없습니다.');
      if (response.url) mediaURL(response.url);
      reader = response.body.getReader();
      return { response, read: () => pending(() => reader!.read()), close,
        complete: async () => { const value = await observation.finish(); combined.throwIfAborted(); if (value) recordProtocol(value); } };
    } catch (error) { await close(); throw error; }
  }
  async function retry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await work(); }
      catch (error) {
        combined.throwIfAborted();
        if (attempt >= 2 || (!(error instanceof RetryableDownloadError) && !(error instanceof TypeError))) throw error;
        await pause(error instanceof RetryableDownloadError && error.delay !== undefined ? error.delay : 300 * 2 ** attempt, combined);
      }
    }
  }
  async function exact(body: RequestBody, length: number): Promise<Uint8Array<ArrayBuffer>> {
    const bytes = new Uint8Array(length); let used = 0;
    for (;;) {
      const item = await body.read();
      if (item.done) break;
      if (item.value.length > length - used) throw new Error('서버가 요청한 범위보다 많은 데이터를 반환했습니다.');
      bytes.set(item.value, used); used += item.value.length;
    }
    if (used !== length) throw new RetryableDownloadError('다운로드 조각이 불완전합니다.');
    await body.complete(); return bytes;
  }
  async function single(body: RequestBody): Promise<ParallelFileResult> {
    try {
      if (body.response.status !== 200) throw new Error('전체 파일 요청에 일부 데이터만 반환되었습니다.');
      const total = identityEncoding(body.response) ? declaredLength(body.response) : undefined;
      const storage = new Uint8Array(PREFIX_BYTES); let head = 0, remainder: Uint8Array<ArrayBuffer> | undefined;
      while (head < PREFIX_BYTES) {
        const item = await body.read(); if (item.done) break;
        const count = Math.min(item.value.length, PREFIX_BYTES - head);
        storage.set(item.value.subarray(0, count), head); head += count;
        if (count < item.value.length) remainder = item.value.subarray(count);
      }
      const prefix = storage.slice(0, head), format = prefixFormat(prefix);
      let written = 0;
      async function consume(bytes: Uint8Array<ArrayBuffer>) {
        for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
          combined.throwIfAborted();
          const part = bytes.subarray(offset, offset + CHUNK_BYTES);
          if (!Number.isSafeInteger(written + part.length) || (total !== undefined && written + part.length > total)) throw new Error('다운로드 파일 크기가 응답과 일치하지 않습니다.');
          await sink.write(written, part); written += part.length; monitor.progress?.(written, total);
        }
      }
      await consume(prefix); if (remainder) await consume(remainder);
      for (;;) { const item = await body.read(); if (item.done) break; await consume(item.value); }
      if (total !== undefined && written !== total) throw new Error('다운로드 파일이 불완전합니다. 다시 시도하세요.');
      await body.complete(); combined.throwIfAborted();
      return { size: written, prefix, ...(format ? { format } : {}), mode: 'single', protocols: [...protocols] };
    } finally { await body.close(); }
  }
  try {
    // Header requests may retry; a streamed whole-file response is never restarted after writes.
    const probe = await retry(async () => {
      const body = await request(address, { Range: `bytes=0-${PREFIX_BYTES - 1}` });
      if (body.response.status === 200) return { body };
      try {
        if (body.response.status !== 206 || !identityEncoding(body.response)) throw new Error('서버의 미디어 범위 응답이 올바르지 않습니다.');
        const range = contentRange(body.response);
        if (range.start !== 0 || range.end >= PREFIX_BYTES || (range.total !== undefined && range.end !== Math.min(PREFIX_BYTES, range.total) - 1)) throw new Error('서버가 잘못된 미디어 확인 범위를 반환했습니다.');
        const expected = range.end + 1, length = declaredLength(body.response);
        if (length !== undefined && length !== expected) throw new Error('미디어 범위 크기가 응답과 일치하지 않습니다.');
        const prefix = await exact(body, expected);
        return { prefix, format: prefixFormat(prefix), total: range.total, etag: strongETag(body.response), target: body.response.url ? mediaURL(body.response.url).href : address };
      } finally { await body.close(); }
    });
    if ('body' in probe) return await single(probe.body);
    if (probe.total === undefined || !probe.etag) return await single(await retry(() => request(address)));
    const total = probe.total, etag = probe.etag, target = probe.target;
    combined.throwIfAborted(); await sink.write(0, probe.prefix);
    let completed = probe.prefix.length, next = probe.prefix.length;
    monitor.progress?.(completed, total);
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(concurrency, Math.ceil((total - next) / chunkBytes)) }, async () => {
      try {
        while (next < total) {
          combined.throwIfAborted(); const start = next, length = Math.min(chunkBytes, total - next); next += length;
          const data = await retry(async () => {
            const body = await request(target, { Range: `bytes=${start}-${start + length - 1}`, 'If-Range': etag });
            try {
              if (body.response.status !== 206 || !identityEncoding(body.response) || strongETag(body.response) !== etag
                || (body.response.url && mediaURL(body.response.url).href !== target)) throw new Error('다운로드 중 파일이 변경되었거나 서버가 구간 요청을 지원하지 않습니다.');
              const range = contentRange(body.response), declared = declaredLength(body.response);
              if (range.start !== start || range.end !== start + length - 1 || range.total !== total || (declared !== undefined && declared !== length)) throw new Error('다운로드 조각의 범위나 크기가 일치하지 않습니다.');
              return await exact(body, length);
            } finally { await body.close(); }
          });
          combined.throwIfAborted(); await sink.write(start, data); completed += data.length; monitor.progress?.(completed, total);
        }
      } catch (error) { if (!controller.signal.aborted) controller.abort(error); throw error; }
    }));
    const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failed) throw controller.signal.reason ?? failed.reason;
    combined.throwIfAborted();
    return { size: total, prefix: probe.prefix, ...(probe.format ? { format: probe.format } : {}), mode: 'parallel', protocols: [...protocols] };
  } catch (error) { controller.abort(error); throw error; }
}
