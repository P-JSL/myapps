import { mediaURL } from './model.ts';
import { retryDelay, validExpectedSize, validateCompleteMediaResponse } from './network.ts';
import type { RemoteAsset } from './hls.ts';
import type { DiskAccessHandle, DiskExtent } from './disk-fs.ts';
import { observeTransport, type Transport } from './transport.ts';
import { scanBytes, type InternalScanResult } from '../security/internal-scan.ts';

const BLOCK_BYTES = 1024 * 1024;
const OVERLAP_BYTES = 64 * 1024;
const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
export class DiskInputRiskError extends Error {
  readonly internalScan: InternalScanResult;
  constructor(internalScan: InternalScanResult) {
    super(`내부 위험 검사에서 신호가 발견되어 스트림 처리를 중단했습니다. ${internalScan.findings.slice(0, 3).map(item => item.message).join(' ')}`);
    this.internalScan = internalScan;
  }
}
export interface DiskAsset { extents: DiskExtent[]; size: number; }
export interface DiskAssetStore { append(bytes: Uint8Array): DiskExtent; }
interface Monitor {
  progress?: (loaded: number, completed: number) => void;
  protocol?: (value: Transport) => void;
  fetch?: typeof globalThis.fetch;
  inactivityMs?: number;
}
class Retryable extends Error {
  readonly delay: number | undefined;
  constructor(message: string, delay?: number) { super(message); this.delay = delay; }
}
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, milliseconds);
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
  });
}
function inspect(bytes: Uint8Array, initial: boolean): void {
  const scan = scanBytes(bytes, { complete: false, expectedMedia: initial });
  if (scan.status === 'suspicious') throw new DiskInputRiskError(scan);
}
function checkedLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('미디어 응답 크기가 올바르지 않습니다.');
  return Number(value);
}
function strongETag(value: string | null): string | undefined {
  return value && value.length <= 1024 && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value) ? value : undefined;
}
/** Stream concurrently, retaining only four fixed blocks and bounded scan overlap. */
export async function downloadDiskAssets(assets: readonly RemoteAsset[], store: DiskAssetStore, signal: AbortSignal,
  monitor: Monitor = {}): Promise<Map<string, DiskAsset>> {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const result = new Map<string, DiskAsset>();
  let next = 0, loaded = 0, completed = 0, failure: unknown;
  const inactivityMs = monitor.inactivityMs ?? 60_000;
  if (!Number.isSafeInteger(inactivityMs) || inactivityMs < 1 || inactivityMs > 60_000) throw new Error('미디어 응답 대기 설정이 올바르지 않습니다.');
  // Several HLS/DASH ranges can reference one file. Bind all of them before
  // awaiting a body read, including concurrent responses and redirect aliases.
  const resourceURLs = new Map<string, string>();
  const rangeResources = new Map<string, { firstAsset: string; etag?: string; total?: number }>();
  async function fetchOne(asset: RemoteAsset): Promise<DiskAsset> {
    const address = mediaURL(asset.url).href;
    const range = asset.range;
    if (range && (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || range.offset < 0
      || range.length < 1 || !Number.isSafeInteger(range.offset + range.length))) throw new Error('미디어 바이트 범위가 올바르지 않습니다.');
    const expectedSize = validExpectedSize(asset.expectedSize, range);
    let pinned: string | undefined, pinnedURL: string | undefined;
    for (let attempt = 0; ; attempt++) {
      combined.throwIfAborted();
      const requestController = new AbortController();
      const requestSignal = AbortSignal.any([combined, requestController.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
      const touch = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timedOut = true; requestController.abort(new Error('미디어 조각 응답 대기 시간이 초과되었습니다.')); }, inactivityMs); };
      const observation = observeTransport(address, performance.now());
      let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined, failed: unknown;
      try {
        touch();
        const headers: Record<string, string> = {};
        if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
        if (pinned) headers['If-Match'] = pinned;
        response = await (monitor.fetch ?? globalThis.fetch)(address, { headers, credentials: 'include', redirect: 'follow', signal: requestSignal });
        touch(); requestSignal.throwIfAborted();
        if (!response.ok) {
          const wait = retryDelay(response.headers.get('Retry-After'));
          if (RETRY_STATUSES.has(response.status) && (wait === undefined || wait <= 5000)) throw new Retryable(`미디어 조각 요청 실패 (${response.status})`, wait);
          throw new Error(`미디어 조각 요청 실패 (${response.status})`);
        }
        if (expectedSize !== undefined) validateCompleteMediaResponse(response, expectedSize);
        const finalURL = response.url ? mediaURL(response.url).href : address;
        if (pinnedURL && finalURL !== pinnedURL) throw new Error('재시도 중 미디어 조각 주소가 변경되었습니다.');
        pinnedURL = finalURL;
        const etag = strongETag(response.headers.get('ETag'));
        if (pinned && etag !== pinned) throw new Error('재시도 중 미디어 조각이 변경되었습니다.');
        if (etag) pinned = etag;
        const encoding = response.headers.get('Content-Encoding');
        if (encoding && encoding.toLowerCase() !== 'identity') throw new Error('압축된 미디어 조각 응답은 지원하지 않습니다.');
        const declared = checkedLength(response.headers.get('Content-Length'));
        if (range) {
          const contentRange = response.headers.get('Content-Range')?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i);
          if (response.status !== 206 || !contentRange || Number(contentRange[1]) !== range.offset
            || Number(contentRange[2]) !== range.offset + range.length - 1
            || (contentRange[3] !== '*' && (!Number.isSafeInteger(Number(contentRange[3])) || Number(contentRange[3]) <= Number(contentRange[2]))))
            throw new Error('서버가 요청한 미디어 조각 범위를 반환하지 않았습니다.');
          if (declared !== undefined && declared !== range.length) throw new Error('미디어 조각의 범위와 크기가 일치하지 않습니다.');
          const knownURL = resourceURLs.get(address);
          if (knownURL !== undefined && knownURL !== finalURL) throw new Error('미디어 구간 요청 중 파일 주소가 변경되었습니다.');
          const total = contentRange[3] === '*' ? undefined : Number(contentRange[3]);
          const known = rangeResources.get(finalURL);
          if (known && known.firstAsset !== asset.filename && (!known.etag || !etag)) throw new Error('동일 파일의 여러 미디어 구간을 합치려면 서버의 강한 파일 식별자가 필요합니다.');
          if (known && ((known.etag !== undefined && etag !== known.etag) || (known.total !== undefined && total !== known.total))) throw new Error('미디어 구간 요청 중 파일 내용이나 크기가 변경되었습니다.');
          resourceURLs.set(address, finalURL);
          rangeResources.set(finalURL, { firstAsset: known?.firstAsset ?? asset.filename, ...(etag === undefined ? {} : { etag }), ...(total === undefined ? {} : { total }) });
        } else if (response.status !== 200) throw new Error('전체 조각 요청에 일부 데이터만 반환되었습니다.');
        if (!response.body) throw new Error('미디어 조각 데이터가 없습니다.');
        const extents: DiskExtent[] = [];
        let total = 0, used = 0, written = 0, overlap = new Uint8Array(0);
        const block = new Uint8Array(BLOCK_BYTES);
        function flush() {
          if (!used) return;
          try {
            const bytes = block.subarray(0, used), window = new Uint8Array(overlap.length + used);
            window.set(overlap); window.set(bytes, overlap.length); inspect(window, written === 0);
            const extent = store.append(bytes);
            if (!Number.isSafeInteger(extent.offset) || !Number.isSafeInteger(extent.length) || extent.offset < 0 || extent.length !== used
              || !Number.isSafeInteger(extent.offset + extent.length)) throw new Error('임시 미디어 저장 범위가 올바르지 않습니다.');
            const previous = extents.at(-1);
            if (previous && previous.offset + previous.length === extent.offset) previous.length += extent.length;
            else extents.push({ ...extent });
            written += used; overlap = window.slice(-OVERLAP_BYTES); used = 0;
          } catch (error) {
            // Storage failures and observed risk are permanent: stop other
            // writers before awaiting response-body cleanup, never retry them.
            controller.abort(error); throw error;
          }
        }
        reader = response.body.getReader();
        for (;;) {
          touch(); const chunk = await reader.read(); requestSignal.throwIfAborted(); touch();
          if (chunk.done) break;
          if (!Number.isSafeInteger(total + chunk.value.length)) throw new Error('미디어 조각 크기가 파일 시스템 범위를 초과했습니다.');
          total += chunk.value.length;
          if ((declared !== undefined && total > declared) || (range && total > range.length)) throw new Error('서버가 선언한 범위를 넘는 미디어 데이터를 반환했습니다.');
          if (expectedSize !== undefined && total > expectedSize) throw new Error('전체 미디어가 예상 크기를 초과했습니다.');
          let offset = 0;
          while (offset < chunk.value.length) {
            const take = Math.min(BLOCK_BYTES - used, chunk.value.length - offset);
            block.set(chunk.value.subarray(offset, offset + take), used); used += take; offset += take;
            if (used === BLOCK_BYTES) flush();
          }
          if (!Number.isSafeInteger(loaded + chunk.value.length)) throw new Error('다운로드 진행 크기가 허용 범위를 초과했습니다.');
          loaded += chunk.value.length; monitor.progress?.(loaded, completed);
        }
        if (!total) throw new Error('미디어 조각이 비어 있습니다.');
        if (expectedSize !== undefined && total !== expectedSize) throw new Error('전체 미디어가 예상 크기보다 작아 불완전합니다.');
        if ((declared !== undefined && total !== declared) || (range && total !== range.length)) throw new Retryable('미디어 조각이 불완전합니다.');
        flush(); if (timer) clearTimeout(timer);
        const protocol = await observation.finish(); if (protocol) monitor.protocol?.(protocol);
        combined.throwIfAborted(); return { extents, size: total };
      } catch (error) {
        failed = error;
        if (attempt >= 2 || (!(error instanceof Retryable) && !(error instanceof TypeError) && !timedOut)) controller.abort(error);
      }
      finally {
        if (timer) clearTimeout(timer); requestController.abort(); observation.cancel();
        if (reader) await reader.cancel().catch(() => {}); else await response?.body?.cancel().catch(() => {});
      }
      combined.throwIfAborted();
      if (attempt >= 2 || (!(failed instanceof Retryable) && !(failed instanceof TypeError) && !timedOut)) throw failed;
      await delay(failed instanceof Retryable && failed.delay !== undefined ? failed.delay : 300 * 2 ** attempt, combined);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, assets.length) }, async () => {
    try {
      while (next < assets.length) {
        combined.throwIfAborted(); const asset = assets[next++]!;
        const downloaded = await fetchOne(asset); result.set(asset.filename, downloaded);
        completed++; monitor.progress?.(loaded, completed);
      }
    } catch (error) { failure ??= error; controller.abort(); }
  }));
  if (failure !== undefined) throw failure;
  signal.throwIfAborted(); return result;
}

/** Only small boundary windows are copied; joined DASH tracks stay disk-backed. */
export function inspectDiskBoundaries(handle: DiskAccessHandle, parts: readonly DiskAsset[]): void {
  const window = new Uint8Array(OVERLAP_BYTES * 2);
  function read(asset: DiskAsset, start: number, destination: Uint8Array) {
    let logical = 0, used = 0;
    for (const extent of asset.extents) {
      const end = logical + extent.length;
      if (end > start && used < destination.length) {
        const offset = Math.max(0, start - logical), take = Math.min(extent.length - offset, destination.length - used);
        let read = 0;
        while (read < take) {
          const count = handle.read(destination.subarray(used + read, used + take), { at: extent.offset + offset + read });
          if (!Number.isSafeInteger(count) || count <= 0 || count > take - read) throw new Error('저장된 미디어 조각을 읽을 수 없습니다.');
          read += count;
        }
        used += take;
      }
      logical = end;
      if (used === destination.length) break;
    }
    if (used !== destination.length) throw new Error('저장된 미디어 조각이 불완전합니다.');
  }
  for (let index = 1; index < parts.length; index++) {
    const previous = parts[index - 1]!, next = parts[index]!;
    const left = Math.min(OVERLAP_BYTES, previous.size), right = Math.min(OVERLAP_BYTES, next.size);
    read(previous, previous.size - left, window.subarray(0, left)); read(next, 0, window.subarray(left, left + right));
    inspect(window.subarray(0, left + right), false);
  }
}
