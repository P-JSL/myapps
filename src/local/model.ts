import { record } from '../security/validation.ts';
import { safeBasename } from '../upscale/policy.ts';
import type { DownloadOptions } from './preferences.ts';
import type { Transport } from './transport.ts';
import type { FileSecurity } from './antivirus.ts';

export const SCOPE = 'my-video-app/local';
export const OFFSCREEN_SCOPE = 'my-video-app/offscreen';
export const HISTORY_KEY = 'my_video_app_history_v1';
export const MAX_HISTORY = 200;
export const MAX_MEDIA_PER_TAB = 200;
export const MAX_STREAM_BYTES = 128 * 1024 * 1024;
export const MAX_SEGMENTS = 4096;
export const PREPARE_TIMEOUT_MS = 300_000;
export type MediaKind = 'file' | 'hls' | 'dash';
export interface MediaItem {
  id: string; tabId: number; url: string; title: string; mime: string;
  kind: MediaKind; createdAt: number; size?: number; observedTransport?: Transport;
}
export type DownloadState = 'preparing' | 'downloading' | 'scanning' | 'review' | 'discarded' | 'complete' | 'cancelled' | 'error';
export interface HistoryItem {
  id: string; url: string; filename: string; kind: MediaKind; state: DownloadState;
  createdAt: number; incognito: boolean; downloadId?: number; error?: string; options?: DownloadOptions;
  preparation?: { stage: 'queued' | 'fetching' | 'processing' | 'saving'; progress?: number; loaded?: number; total?: number };
  transferProtocols?: Transport[]; receivedBytes?: number; totalBytes?: number;
  security?: FileSecurity;
}
export function mediaURL(value: unknown, base?: string): URL {
  if (typeof value !== 'string' || !value || value.length > 8192) throw new Error('미디어 주소가 올바르지 않습니다.');
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('HTTP 또는 HTTPS 미디어 주소만 지원합니다.');
  url.hash = '';
  return url;
}
export function mediaKind(url: string, mime = '', fromElement = false): MediaKind | undefined {
  const path = mediaURL(url).pathname.toLowerCase();
  if (/\.m3u8$/.test(path) || /mpegurl/i.test(mime)) return 'hls';
  if (/\.mpd$/.test(path) || /dash\+xml/i.test(mime)) return 'dash';
  if (!fromElement && (/\.(ts|m4s)$/.test(path) || /video\/mp2t/i.test(mime))) return undefined;
  if (/\.(mp4|webm|mkv|mov|avi|m4v|mp3|m4a|ogg|wav|flac|aac)$/.test(path) || /^(video|audio)\//i.test(mime) || fromElement) return 'file';
  return undefined;
}
export function filenameFor(media: Pick<MediaItem, 'url' | 'title' | 'mime' | 'kind'>): string {
  let leaf = '';
  try { leaf = decodeURIComponent(mediaURL(media.url).pathname.split('/').at(-1) ?? ''); } catch { /* Malformed percent escape. */ }
  const ext = media.kind !== 'file' ? 'mp4' : leaf.match(/\.(mp4|webm|mkv|mov|avi|m4v|mp3|m4a|ogg|wav|flac|aac)$/i)?.[1]?.toLowerCase()
    ?? ({ 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'video/webm': 'webm' }[media.mime.split(';')[0] ?? ''] ?? 'mp4');
  let base = safeBasename(media.title || leaf || 'media').replace(/\.(mp4|webm|mkv|mov|avi|m4v|mp3|m4a|ogg|wav|flac|aac|m3u8|mpd)$/i, '');
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  return `${base || 'media'}.${ext}`;
}
export function isHistory(value: unknown): value is HistoryItem {
  return record(value) && typeof value.id === 'string' && /^[a-f0-9-]{36}$/.test(value.id)
    && typeof value.url === 'string' && typeof value.filename === 'string'
    && ['file', 'hls', 'dash'].includes(String(value.kind))
    && ['preparing', 'downloading', 'scanning', 'review', 'discarded', 'complete', 'cancelled', 'error'].includes(String(value.state))
    && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) && typeof value.incognito === 'boolean';
}
interface LocalSender { id?: string | undefined; url?: string | undefined; tab?: { id?: number | undefined } | undefined; }
export function trustedUI(sender: LocalSender, id: string, base: string): boolean {
  if (sender.id !== id || typeof sender.url !== 'string') return false;
  try {
    const u = new URL(sender.url);
    return ['local/index.html', 'upscale/index.html'].some(page => u.href.split(/[?#]/)[0] === `${base}${page}`);
  } catch { return false; }
}
export function trustedCapture(sender: LocalSender, id: string): boolean {
  if (sender.id !== id || !Number.isInteger(sender.tab?.id) || (sender.tab?.id ?? -1) < 0) return false;
  try { mediaURL(sender.url); return true; } catch { return false; }
}
