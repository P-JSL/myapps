import { boundedData, record } from '../security/validation.ts';
import { downloadOptions, type DownloadOptions } from './preferences.ts';

const MAX_MESSAGE_BYTES = 64 * 1024;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const MIMES = ['video/mp4', 'video/webm', 'audio/mp4', 'audio/webm'] as const;

export interface YouTubeTrack {
  url: string;
  kind: 'video' | 'audio' | 'combined';
  mime: typeof MIMES[number];
  formatId: string;
  height?: number;
  size?: number;
}
export interface YouTubeResolution {
  videoId: string;
  url: string;
  title: string;
  tracks: YouTubeTrack[];
  duration?: number;
}
export interface YouTubeReadiness {
  status: 'ready' | 'unavailable' | 'error';
  message: string;
  ytDlpVersion?: string;
  runtime?: string;
}

/** Recognize one video only; never send arbitrary page URLs to a native extractor. */
export function youtubeVideo(value: unknown): { id: string; url: string } | undefined {
  if (typeof value !== 'string' || !value || value.length > 8192) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
    let id: string | undefined;
    if (['youtu.be', 'www.youtu.be'].includes(url.hostname)) {
      const match = url.pathname.match(/^\/([A-Za-z0-9_-]{11})\/?$/); id = match?.[1];
    } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)) {
      if (url.pathname === '/watch' || url.pathname === '/watch/') {
        const values = url.searchParams.getAll('v'); if (values.length === 1) id = values[0];
      } else id = url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
    } else if (['youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(url.hostname)) {
      id = url.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
    }
    if (id && VIDEO_ID.test(id)) return { id, url: `https://www.youtube.com/watch?v=${id}` };
  } catch { /* Invalid, unsupported and playlist-only URLs are not video requests. */ }
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(name => allowed.includes(name));
}
function bounded(value: unknown): value is Record<string, unknown> {
  if (!record(value) || !boundedData(value, MAX_MESSAGE_BYTES)) return false;
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_MESSAGE_BYTES; }
  catch { return false; }
}
function safeText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && Array.from(value).length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
}
function streamURL(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 8192) throw new Error('유튜브 미디어 주소가 올바르지 않습니다.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || !url.hostname.endsWith('.googlevideo.com') || url.pathname !== '/videoplayback') throw new Error('허용되지 않은 유튜브 미디어 주소입니다.');
  return url.href;
}

/** Revalidate source binding in the background and again before browser preparation. */
export function youtubeResolution(value: unknown, sourceURL: string): YouTubeResolution {
  const source = youtubeVideo(sourceURL);
  if (!source || !bounded(value) || !keys(value, ['videoId', 'url', 'title', 'tracks', 'duration'])
    || value.videoId !== source.id || youtubeVideo(value.url)?.url !== source.url
    || !safeText(value.title, 200) || !Array.isArray(value.tracks) || value.tracks.length < 1 || value.tracks.length > 2)
    throw new Error('유튜브 추출 결과가 요청한 영상과 일치하지 않습니다.');
  const tracks = value.tracks.map((track): YouTubeTrack => {
    if (!record(track) || !keys(track, ['url', 'kind', 'mime', 'formatId', 'height', 'size'])
      || !['video', 'audio', 'combined'].includes(String(track.kind)) || !MIMES.includes(track.mime as typeof MIMES[number])
      || typeof track.formatId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(track.formatId)
      || (track.kind === 'audio') !== String(track.mime).startsWith('audio/')) throw new Error('유튜브 트랙 정보가 올바르지 않습니다.');
    const result: YouTubeTrack = { url: streamURL(track.url), kind: track.kind as YouTubeTrack['kind'], mime: track.mime as YouTubeTrack['mime'], formatId: track.formatId };
    if (track.height !== undefined) {
      if (!Number.isSafeInteger(track.height) || Number(track.height) < 1 || Number(track.height) > 65535 || track.kind === 'audio') throw new Error('유튜브 영상 높이가 올바르지 않습니다.');
      result.height = Number(track.height);
    }
    if (track.size !== undefined) {
      if (!Number.isSafeInteger(track.size) || Number(track.size) < 1) throw new Error('유튜브 트랙 크기가 올바르지 않습니다.');
      result.size = Number(track.size);
    }
    return result;
  });
  if (tracks.length === 2) {
    if (tracks.filter(track => track.kind === 'video').length !== 1 || tracks.filter(track => track.kind === 'audio').length !== 1
      || tracks[0]!.url === tracks[1]!.url || tracks[0]!.formatId === tracks[1]!.formatId) throw new Error('유튜브 영상·음성 트랙 구성이 올바르지 않습니다.');
    tracks.sort((a, b) => Number(a.kind === 'audio') - Number(b.kind === 'audio'));
  }
  const result: YouTubeResolution = { videoId: source.id, url: source.url, title: value.title, tracks };
  if (value.duration !== undefined) {
    if (typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration <= 0 || value.duration > Number.MAX_SAFE_INTEGER) throw new Error('유튜브 영상 길이가 올바르지 않습니다.');
    result.duration = value.duration;
  }
  return result;
}


/**
 * Browser-only extractor: read the public watch response as DATA, never load
 * remote JavaScript or bypass signatures, authentication, or DRM.
 * Any unsupported player response fails closed rather than pretending success.
 */
const MAX_PAGE_BYTES = 6 * 1024 * 1024;
const MAX_PLAYER_BYTES = 3 * 1024 * 1024;

function playerResponseFromHTML(html: string): Record<string, unknown> {
  const pattern = /\bytInitialPlayerResponse\s*=\s*/g;
  for (const match of html.matchAll(pattern)) {
    const start = match.index! + match[0].length;
    if (html[start] !== '{') continue;
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < html.length && index - start <= MAX_PLAYER_BYTES; index++) {
      const character = html[index]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) {
        try {
          const parsed: unknown = JSON.parse(html.slice(start, index + 1));
          if (record(parsed)) return parsed;
        } catch { /* Other inline JSON objects do not qualify. */ }
        break;
      }
    }
  }
  throw new Error('이 영상의 브라우저용 재생 정보를 확인할 수 없습니다. YouTube 재생 방식 변경 또는 접근 제한일 수 있습니다.');
}

async function boundedWatchPage(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error',
    cache: 'no-store', referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'text/html' },
  });
  if (!response.ok || response.url !== url || !response.headers.get('content-type')?.toLowerCase().includes('text/html'))
    throw new Error('YouTube의 공개 영상 페이지를 확인할 수 없습니다. 로그인이나 접근 제한이 없는 영상인지 확인하세요.');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) throw new Error('영상 페이지가 허용된 크기를 초과했습니다.');
  if (!response.body) throw new Error('영상 페이지의 응답 본문을 확인할 수 없습니다.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_PAGE_BYTES) throw new Error('영상 페이지가 허용된 크기를 초과했습니다.');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

interface BrowserFormat { track: YouTubeTrack; bitrate: number; }
function browserTrack(value: unknown): BrowserFormat | undefined {
  if (!record(value) || typeof value.url !== 'string' || value.signatureCipher || value.cipher) return;
  if (typeof value.mimeType !== 'string' || !/^(?:video|audio)\/(?:mp4|webm)(?:;|$)/.test(value.mimeType)) return;
  const mime = value.mimeType.split(';', 1)[0] as YouTubeTrack['mime'];
  if (!MIMES.includes(mime)) return;
  if (!Number.isSafeInteger(value.itag) || Number(value.itag) < 1 || Number(value.itag) > 99999) return;
  let url: string;
  try { url = streamURL(value.url); } catch { return; }
  // Do not accept ciphered signatures, encrypted fragments, or playlist URLs.
  const hasVideo = mime.startsWith('video/');
  const hasAudio = !hasVideo || typeof value.audioQuality === 'string';
  const kind: YouTubeTrack['kind'] = hasVideo ? hasAudio ? 'combined' : 'video' : 'audio';
  const track: YouTubeTrack = { url, mime, kind, formatId: String(value.itag) };
  if (hasVideo) {
    if (!Number.isSafeInteger(value.height) || Number(value.height) < 1 || Number(value.height) > 65535) return;
    track.height = Number(value.height);
  }
  if (Number.isSafeInteger(value.contentLength) && Number(value.contentLength) > 0) track.size = Number(value.contentLength);
  else if (typeof value.contentLength === 'string' && /^[1-9][0-9]{0,15}$/.test(value.contentLength)) {
    const size = Number(value.contentLength);
    if (Number.isSafeInteger(size)) track.size = size;
  }
  const bitrate = Number.isFinite(value.bitrate) && Number(value.bitrate) > 0 ? Number(value.bitrate) : 0;
  return { track, bitrate };
}

export function browserYouTubeResolution(player: unknown, url: string, options: DownloadOptions): YouTubeResolution {
  const source = youtubeVideo(url), selected = downloadOptions(options);
  if (!source || !record(player)) throw new Error('영상 페이지의 재생 정보를 확인할 수 없습니다.');
  const status = record(player.playabilityStatus) ? player.playabilityStatus.status : undefined;
  const details = record(player.videoDetails) ? player.videoDetails : undefined;
  if (status !== 'OK' || !details || details.videoId !== source.id
    || details.isLiveContent === true || details.isLive === true)
    throw new Error('공개된 일반 YouTube 영상만 지원합니다. 로그인·라이브·제한 영상은 지원하지 않습니다.');
  const streaming = record(player.streamingData) ? player.streamingData : undefined;
  if (!streaming) throw new Error('직접 다운로드할 수 있는 스트림이 없습니다. YouTube의 서명·토큰 확인이 필요한 영상은 현재 지원하지 않습니다.');
  const all = [
    ...(Array.isArray(streaming.formats) ? streaming.formats : []),
    ...(Array.isArray(streaming.adaptiveFormats) ? streaming.adaptiveFormats : []),
  ];
  if (all.length > 4096) throw new Error('영상 스트림 정보가 허용 범위를 초과했습니다.');
  const usable = all.map(browserTrack).filter((value): value is BrowserFormat => value !== undefined);
  const audio = usable.filter(value => value.track.kind === 'audio');
  const pickAudio = (webm: boolean): YouTubeTrack | undefined => {
    const preferred = audio.filter(value => value.track.mime === (webm ? 'audio/webm' : 'audio/mp4'));
    return (preferred.length ? preferred : audio).sort((a, b) => b.bitrate - a.bitrate)[0]?.track;
  };
  let tracks: YouTubeTrack[];
  if (selected.output !== 'original') {
    const chosen = pickAudio(false);
    if (!chosen) throw new Error('오디오 스트림이 없거나 서명 해석이 필요하여 브라우저만으로 처리할 수 없습니다.');
    tracks = [chosen];
  } else {
    const video = usable.filter(value => value.track.kind !== 'audio' && value.track.height !== undefined);
    if (!video.length) throw new Error('영상 스트림이 없거나 서명 해석이 필요하여 브라우저만으로 처리할 수 없습니다.');
    const ceiling = selected.quality === 'highest' ? Infinity : Number(selected.quality);
    const eligible = video.filter(value => value.track.height! <= ceiling);
    const candidates = eligible.length ? eligible : video;
    candidates.sort((a, b) => b.track.height! - a.track.height! || b.bitrate - a.bitrate);
    const best = candidates[0]!.track;
    tracks = [best];
    if (best.kind === 'video') {
      const soundtrack = pickAudio(best.mime === 'video/webm');
      if (!soundtrack) throw new Error('병합할 오디오 스트림을 확인할 수 없습니다.');
      tracks.push(soundtrack);
    }
  }
  const title = typeof details.title === 'string' ? Array.from(details.title).filter(char => !/[\x00-\x1f\x7f]/.test(char)).slice(0, 200).join('') : '';
  const duration = typeof details.lengthSeconds === 'string' && /^[0-9]{1,15}$/.test(details.lengthSeconds)
    ? Number(details.lengthSeconds) : undefined;
  return youtubeResolution({
    videoId: source.id, url: source.url, title: title || 'YouTube ' + source.id, tracks,
    ...(duration && Number.isSafeInteger(duration) ? { duration } : {}),
  }, source.url);
}

export async function probeYouTube(): Promise<YouTubeReadiness> {
  return {
    status: 'ready', runtime: 'Chrome 내장',
    message: '브라우저 기반 공개 스트림 분석기가 포함되어 있습니다. 실제 지원 여부는 영상 다운로드 시 확인합니다.',
  };
}

export async function resolveYouTube(url: string, settings: DownloadOptions, signal: AbortSignal): Promise<YouTubeResolution> {
  signal.throwIfAborted();
  const source = youtubeVideo(url);
  if (!source) throw new Error('유효한 HTTPS YouTube 단일 영상 주소를 입력하세요.');
  const options = downloadOptions(settings);
  const page = await boundedWatchPage(source.url, signal);
  signal.throwIfAborted();
  const player = playerResponseFromHTML(page);
  const result = browserYouTubeResolution(player, source.url, options);
  signal.throwIfAborted();
  return result;
}
