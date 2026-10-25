import { boundedData, record } from '../security/validation.ts';
import { downloadOptions, type DownloadOptions } from './preferences.ts';

export const YOUTUBE_HOST = 'com.myvideoapp.youtube';
const MAX_MESSAGE_BYTES = 64 * 1024;
const NATIVE_TIMEOUT_MS = 120_000;
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

function envelope(value: unknown, requestId: string): Record<string, unknown> {
  if (!bounded(value) || value.version !== 1 || value.requestId !== requestId || typeof value.status !== 'string') throw new Error('유튜브 도우미 응답이 올바르지 않습니다. 최신 도우미 설치 상태를 확인하세요.');
  return value;
}
function responseError(value: Record<string, unknown>): Error {
  return new Error(safeText(value.message, 1000) && value.message ? value.message : '유튜브 영상을 추출하지 못했습니다. 도우미와 영상의 공개 상태를 확인하세요.');
}
function readiness(value: unknown, requestId: string): YouTubeReadiness {
  const reply = envelope(value, requestId);
  if (!keys(reply, ['version', 'requestId', 'status', 'message', 'ytDlpVersion', 'runtime'])
    || !['ready', 'unavailable', 'error'].includes(reply.status as string) || !safeText(reply.message, 1000)) throw new Error('유튜브 도우미의 준비 상태를 확인할 수 없습니다.');
  const result: YouTubeReadiness = { status: reply.status as YouTubeReadiness['status'], message: reply.message };
  for (const field of ['ytDlpVersion', 'runtime'] as const) if (reply[field] !== undefined) {
    if (!safeText(reply[field], 120) || !reply[field]) throw new Error('유튜브 도우미 버전 정보가 올바르지 않습니다.');
    result[field] = reply[field];
  }
  if (result.status === 'ready' && (!result.ytDlpVersion || !result.runtime)) throw new Error('유튜브 도우미의 추출 엔진과 실행 환경을 확인할 수 없습니다.');
  return result;
}

function nativeRequest<T>(action: 'status' | 'resolve', payload: Record<string, unknown>, parse: (value: unknown, requestId: string) => T, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let port: chrome.runtime.Port | undefined, timer: ReturnType<typeof setTimeout> | undefined, settled = false;
    const requestId = crypto.randomUUID();
    const finish = (error?: unknown, result?: T) => {
      if (settled) return; settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try { port?.onMessage.removeListener(onMessage); port?.onDisconnect.removeListener(onDisconnect); } catch { /* A closed browser port needs no listeners. */ }
      try { port?.disconnect(); } catch { /* Already disconnected. */ }
      if (error !== undefined) reject(error); else resolve(result!);
    };
    const abort = () => finish(signal?.reason ?? new DOMException('작업을 취소했습니다.', 'AbortError'));
    const onMessage = (value: unknown) => { try { finish(undefined, parse(value, requestId)); } catch (error) { finish(error); } };
    const onDisconnect = () => {
      const error = chrome.runtime.lastError?.message;
      finish(new Error(error ? `유튜브 도우미 연결 실패: ${error.slice(0, 300)}` : '유튜브 도우미 연결이 종료되었습니다. 설치 상태를 확인하세요.'));
    };
    if (signal?.aborted) { abort(); return; }
    // Native API bindings must exist in this extension context. Permission
    // bookkeeping alone does not establish that the browser exposes the API.
    if (typeof chrome.runtime.connectNative !== 'function') {
      finish(new Error('현재 브라우저에서 로컬 도우미 연결 API를 사용할 수 없습니다. PC용 Chrome에서 확장을 업데이트·새로고침한 뒤 다시 시도하세요.'));
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      port = chrome.runtime.connectNative(YOUTUBE_HOST);
      port.onMessage.addListener(onMessage); port.onDisconnect.addListener(onDisconnect);
      timer = setTimeout(() => finish(new Error('유튜브 영상 정보 추출 시간이 초과되었습니다. 잠시 뒤 다시 시도하세요.')), NATIVE_TIMEOUT_MS);
      port.postMessage({ version: 1, requestId, action, ...payload });
    } catch (error) { finish(error instanceof Error ? error : new Error('유튜브 도우미에 연결할 수 없습니다.')); }
  });
}

let pendingReadiness: Promise<YouTubeReadiness> | undefined;
export function probeYouTube(): Promise<YouTubeReadiness> {
  if (pendingReadiness) return pendingReadiness;
  const pending = (async (): Promise<YouTubeReadiness> => {
    try {
      if (!await chrome.permissions.contains({ permissions: ['nativeMessaging'] })) return { status: 'unavailable', message: '유튜브 도우미 설치 후 유튜브 연결 권한을 허용하세요.' };
      return await nativeRequest('status', {}, readiness);
    } catch (error) { return { status: 'error', message: error instanceof Error ? error.message : '유튜브 도우미 연결 상태를 확인하지 못했습니다.' }; }
  })().finally(() => { if (pendingReadiness === pending) pendingReadiness = undefined; });
  pendingReadiness = pending; return pending;
}

export async function resolveYouTube(url: string, settings: DownloadOptions, signal: AbortSignal): Promise<YouTubeResolution> {
  signal.throwIfAborted();
  const source = youtubeVideo(url); if (!source) throw new Error('유효한 HTTPS 유튜브 영상 주소를 입력하세요.');
  const options = downloadOptions(settings);
  if (!await chrome.permissions.contains({ permissions: ['nativeMessaging'] })) throw new Error('설정에서 유튜브 도우미를 연결하고 권한을 허용하세요.');
  signal.throwIfAborted();
  const userAgent = navigator.userAgent;
  if (!/^[\x20-\x7e]{1,512}$/.test(userAgent)) throw new Error('브라우저 식별 정보를 유튜브 도우미에 전달할 수 없습니다.');
  const result = await nativeRequest('resolve', { url: source.url, quality: options.quality, output: options.output, userAgent }, (value, requestId) => {
    const reply = envelope(value, requestId);
    if (['error', 'unavailable'].includes(reply.status as string)) throw responseError(reply);
    if (reply.status !== 'resolved' || !keys(reply, ['version', 'requestId', 'status', 'videoId', 'title', 'duration', 'tracks'])) throw new Error('유튜브 도우미가 올바른 트랙을 반환하지 않았습니다.');
    const resolution = youtubeResolution({ videoId: reply.videoId, url: source.url, title: reply.title, tracks: reply.tracks, ...(reply.duration === undefined ? {} : { duration: reply.duration }) }, source.url);
    const hasVideo = resolution.tracks.some(track => track.kind !== 'audio'), hasAudio = resolution.tracks.some(track => track.kind !== 'video');
    if ((options.output === 'original' && !hasVideo) || (options.output !== 'original' && !hasAudio)) throw new Error('요청한 저장 형식에 필요한 유튜브 트랙이 없습니다.');
    return resolution;
  }, signal);
  signal.throwIfAborted(); return result;
}
