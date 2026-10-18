import { MAX_SEGMENTS, mediaURL } from './model.ts';
import { validRange, type ByteRange, type ManifestResource } from './network.ts';
import { chooseQuality, downloadOptions, type DownloadOptions } from './preferences.ts';

export interface RemoteAsset { url: string; filename: string; range?: ByteRange; }
export interface StreamInput { filename: string; playlist?: string; parts?: string[]; }
export interface StreamPlan { assets: RemoteAsset[]; inputs: StreamInput[]; }
export function attributes(value: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  const pattern = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))(?:,|$)/g;
  for (const match of value.matchAll(pattern)) result[match[1]!] = match[2] ?? match[3] ?? '';
  return result;
}
function check(text: string): string[] {
  if (text.length > 2 * 1024 * 1024 || !text.trimStart().startsWith('#EXTM3U')) throw new Error('올바른 HLS 목록이 아닙니다.');
  const lines = text.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^#EXT-X-(?:SESSION-)?KEY:/.test(line) && attributes(line.slice(line.indexOf(':') + 1)).METHOD !== 'NONE') throw new Error('암호화·DRM 스트림은 지원하지 않습니다.');
  }
  return lines;
}
export function parseByteRange(value: string, offset = 0): ByteRange {
  const match = value.match(/^(\d+)(?:@(\d+))?$/);
  if (!match) throw new Error('잘못된 HLS 바이트 범위입니다.');
  const range = { length: Number(match[1]), offset: match[2] === undefined ? offset : Number(match[2]) };
  validRange(range); return range;
}
export async function planHls(url: string, load: (url: string) => Promise<string | ManifestResource>, options: DownloadOptions = downloadOptions()): Promise<StreamPlan> {
  const assets: RemoteAsset[] = [];
  const inputs: StreamInput[] = [];
  async function playlist(address: string, depth: number, ancestors: Set<string>, includeAudio: boolean): Promise<void> {
    if (depth > 3 || ancestors.has(address)) throw new Error('HLS 목록이 순환하거나 너무 깊습니다.');
    const requested = address;
    const resource = await load(address);
    address = mediaURL(typeof resource === 'string' ? address : resource.url).href;
    if (ancestors.has(address)) throw new Error('HLS 목록이 순환하거나 너무 깊습니다.');
    const next = new Set(ancestors).add(requested).add(address);
    const lines = check(typeof resource === 'string' ? resource : resource.text);
    const variants: Array<{ url: string; bandwidth: number; height: number; audio?: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
      const attr = attributes(line.slice(line.indexOf(':') + 1));
      const child = lines[i + 1];
      if (!child || child.startsWith('#')) throw new Error('HLS 변형 목록이 불완전합니다.');
      const variant: { url: string; bandwidth: number; height: number; audio?: string } = { url: mediaURL(child, address).href, bandwidth: Number(attr.BANDWIDTH) || 0, height: Number(attr.RESOLUTION?.match(/^\d+x(\d+)$/)?.[1]) || 0 };
      if (attr.AUDIO) variant.audio = attr.AUDIO;
      variants.push(variant);
    }
    if (variants.length) {
      const chosen = chooseQuality(variants, options.quality, item => item.height, item => item.bandwidth)!;
      let audio: Record<string, string> | undefined;
      if (includeAudio && chosen.audio) {
        audio = lines.filter(line => line.startsWith('#EXT-X-MEDIA:')).map(line => attributes(line.slice(line.indexOf(':') + 1)))
          .filter(a => a.TYPE === 'AUDIO' && a['GROUP-ID'] === chosen.audio && a.URI).sort((a, b) => Number(b.DEFAULT === 'YES') - Number(a.DEFAULT === 'YES'))[0];
      }
      if (options.output !== 'original' && audio?.URI) { await playlist(mediaURL(audio.URI, address).href, depth + 1, next, false); return; }
      await playlist(chosen.url, depth + 1, next, false);
      if (audio?.URI) await playlist(mediaURL(audio.URI, address).href, depth + 1, next, false);
      return;
    }
    if (!lines.includes('#EXT-X-ENDLIST')) throw new Error('현재 로컬 버전은 완료된 VOD 목록만 지원합니다.');
    const rewritten: string[] = [];
    let range: ByteRange | undefined;
    let previousEnd = 0;
    let previousURL = '';
    let pendingRange = '';
    let segments = 0;
    function asset(remote: string, bytes?: ByteRange): string {
      if (assets.length >= MAX_SEGMENTS) throw new Error('미디어 조각 개수 한도를 초과했습니다.');
      const item: RemoteAsset = { url: mediaURL(remote, address).href, filename: `asset-${assets.length.toString().padStart(5, '0')}.${/\.(mp4|m4s)(?:[?#]|$)/i.test(remote) ? 'm4s' : 'ts'}` };
      if (bytes) item.range = bytes;
      assets.push(item); return item.filename;
    }
    for (const line of lines) {
      if (line.startsWith('#EXT-X-BYTERANGE:')) { pendingRange = line.slice(17); continue; }
      if (line.startsWith('#EXT-X-MAP:')) {
        const attr = attributes(line.slice(11));
        if (!attr.URI) throw new Error('HLS 초기화 조각이 없습니다.');
        const initRange = attr.BYTERANGE ? parseByteRange(attr.BYTERANGE) : undefined;
        rewritten.push(`#EXT-X-MAP:URI="${asset(attr.URI, initRange)}"`); continue;
      }
      if (line.startsWith('#')) {
        if (/^#(?:EXTM3U$|EXTINF:|EXT-X-(?:VERSION:|TARGETDURATION:|MEDIA-SEQUENCE:|PLAYLIST-TYPE:|DISCONTINUITY|INDEPENDENT-SEGMENTS|ENDLIST|GAP))/.test(line)) rewritten.push(line);
        continue;
      }
      const remote = mediaURL(line, address).href;
      if (pendingRange) {
        if (!pendingRange.includes('@') && previousURL !== remote) throw new Error('HLS 연속 바이트 범위의 기준이 없습니다.');
        range = parseByteRange(pendingRange, previousEnd); previousEnd = range.offset + range.length;
      } else { range = undefined; previousEnd = 0; }
      rewritten.push(asset(remote, range)); previousURL = remote; pendingRange = ''; segments++;
    }
    if (!segments) throw new Error('HLS 목록에 미디어 조각이 없습니다.');
    inputs.push({ filename: `input-${inputs.length}.m3u8`, playlist: rewritten.join('\n') + '\n' });
  }
  await playlist(mediaURL(url).href, 0, new Set(), true);
  if (!inputs.length || inputs.length > 2) throw new Error('지원하지 않는 HLS 트랙 구성입니다.');
  return { assets, inputs };
}
