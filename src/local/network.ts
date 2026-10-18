import { mediaURL } from './model.ts';

export interface ByteRange { offset: number; length: number; }
export function validRange(range: ByteRange): void {
  if (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || !Number.isSafeInteger(range.offset + range.length) || range.offset < 0 || range.length < 1 || range.length > 128 * 1024 * 1024) throw new Error('미디어 바이트 범위가 허용 범위를 초과했습니다.');
}
export async function fetchBytes(url: string, maximum: number, signal: AbortSignal, range?: ByteRange): Promise<Uint8Array<ArrayBuffer>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const options: RequestInit = { credentials: 'include', redirect: 'follow', signal: AbortSignal.any([signal, controller.signal]) };
    if (range) { validRange(range); options.headers = { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` }; }
    const response = await fetch(mediaURL(url), options);
    if (!response.ok || !response.body) throw new Error(`미디어 요청 실패 (${response.status})`);
    if (response.url) mediaURL(response.url);
    const declared = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > maximum) throw new Error('미디어 용량이 처리 한도를 초과했습니다.');
    if (range && response.status === 206) {
      const contentRange = response.headers.get('Content-Range')?.match(/^bytes (\d+)-(\d+)\//i);
      if (!contentRange || Number(contentRange[1]) !== range.offset || Number(contentRange[2]) !== range.offset + range.length - 1) throw new Error('서버가 잘못된 미디어 범위를 반환했습니다.');
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.length;
      if (total > maximum) throw new Error('미디어 용량이 처리 한도를 초과했습니다.');
      chunks.push(result.value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    if (range) {
      if (response.status === 206) { if (result.length !== range.length) throw new Error('미디어 조각이 불완전합니다.'); return result; }
      if (response.status !== 200 || result.length < range.offset + range.length) throw new Error('서버가 바이트 범위를 지원하지 않습니다.');
      return result.slice(range.offset, range.offset + range.length);
    }
    return result;
  } finally {
    clearTimeout(timer);
    controller.abort();
    await reader?.cancel().catch(() => {});
  }
}
export async function fetchManifest(url: string, signal: AbortSignal): Promise<string> {
  return new TextDecoder('utf-8', { fatal: true }).decode(await fetchBytes(url, 2 * 1024 * 1024, signal));
}
