import { record } from '../security/validation.ts';
import { safeBasename } from '../shared/filename.ts';
import type { DownloadOptions } from './preferences.ts';
import type { Transport } from './transport.ts';
import { internalScanResponse, type FileSecurity } from './antivirus.ts';
import type { InternalScanResult } from '../security/internal-scan.ts';

export const SCOPE = 'my-video-app/local';
export const OFFSCREEN_SCOPE = 'my-video-app/offscreen';
export const HISTORY_KEY = 'my_video_app_history_v1';
export const MAX_HISTORY = 200;
export const MAX_MEDIA_PER_TAB = 200;
export const MAX_STREAM_BYTES = 128 * 1024 * 1024;
export const MAX_SEGMENTS = 4096;
export const PREPARE_TIMEOUT_MS = 300_000;
export const DOWNLOAD_STATES = ['preparing', 'downloading', 'scanning', 'review', 'discarded', 'complete', 'cancelled', 'error'] as const;
export type DownloadState = typeof DOWNLOAD_STATES[number];
export const ACTIVE_HISTORY_STATES = ['preparing', 'downloading', 'scanning', 'review'] as const satisfies readonly DownloadState[];
export function isActiveHistoryState(state: DownloadState): boolean {
  return (ACTIVE_HISTORY_STATES as readonly DownloadState[]).includes(state);
}
export type MediaKind = 'file' | 'hls' | 'dash';
export interface MediaItem {
  id: string; tabId: number; url: string; title: string; mime: string;
  kind: MediaKind; createdAt: number; size?: number; observedTransport?: Transport;
}
/** Own both indexes so selecting an ID never scans or copies unrelated tabs. */
export class MediaCatalog {
  private readonly byTab = new Map<number, Map<string, MediaItem>>();
  private readonly byId = new Map<string, MediaItem>();
  get size(): number { return this.byId.size; }
  get(tabId: number, url: string): MediaItem | undefined { return this.byTab.get(tabId)?.get(url); }
  find(id: string): MediaItem | undefined { return this.byId.get(id); }
  *tabIds(): IterableIterator<number> { yield* this.byTab.keys(); }
  *items(tabId: number): IterableIterator<MediaItem> { yield* this.byTab.get(tabId)?.values() ?? []; }
  set(item: MediaItem): void {
    const previous = this.byId.get(item.id);
    if (previous && (previous.tabId !== item.tabId || previous.url !== item.url)) {
      const oldTab = this.byTab.get(previous.tabId)!;
      oldTab.delete(previous.url);
      if (!oldTab.size) this.byTab.delete(previous.tabId);
    }
    const tab = this.byTab.get(item.tabId) ?? new Map<string, MediaItem>();
    const replaced = tab.get(item.url);
    if (replaced && replaced.id !== item.id) this.byId.delete(replaced.id);
    tab.set(item.url, item); this.byId.set(item.id, item);
    if (tab.size > MAX_MEDIA_PER_TAB) {
      let evicted: MediaItem | undefined;
      for (const candidate of tab.values()) if (candidate.kind === 'file') { evicted = candidate; break; }
      evicted ??= tab.values().next().value!;
      tab.delete(evicted.url); this.byId.delete(evicted.id);
    }
    this.byTab.set(item.tabId, tab);
  }
  deleteTab(tabId: number): void {
    const tab = this.byTab.get(tabId);
    if (!tab) return;
    for (const item of tab.values()) this.byId.delete(item.id);
    this.byTab.delete(tabId);
  }
}
export interface HistoryItem {
  id: string; url: string; filename: string; kind: MediaKind; state: DownloadState;
  createdAt: number; incognito: boolean; downloadId?: number; error?: string; options?: DownloadOptions;
  preparation?: { stage: 'queued' | 'fetching' | 'processing' | 'saving'; progress?: number; loaded?: number; total?: number };
  transferProtocols?: Transport[]; receivedBytes?: number; totalBytes?: number;
  security?: FileSecurity;
  internalScan?: InternalScanResult; internalScanSha256?: string; internalScanSize?: number;
}
/** Keep unresolved work visible even when newer completed records reach the cap. */
export function retainHistory(rows: HistoryItem[]): HistoryItem[] {
  const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt);
  const active = (row: HistoryItem) => isActiveHistoryState(row.state);
  return [...sorted.filter(active), ...sorted.filter(row => !active(row))].slice(0, MAX_HISTORY);
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
  if (record(value) && (value.internalScan !== undefined || value.internalScanSha256 !== undefined || value.internalScanSize !== undefined)) {
    try {
      if (value.internalScan !== undefined) internalScanResponse(value.internalScan, typeof value.internalScanSize === 'number' ? value.internalScanSize : undefined);
      if (value.internalScanSha256 !== undefined && (typeof value.internalScanSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.internalScanSha256))) return false;
      if (value.internalScanSize !== undefined && (!Number.isSafeInteger(value.internalScanSize) || Number(value.internalScanSize) < 0)) return false;
    } catch { return false; }
  }
  return record(value) && typeof value.id === 'string' && /^[a-f0-9-]{36}$/.test(value.id)
    && typeof value.url === 'string' && typeof value.filename === 'string'
    && ['file', 'hls', 'dash'].includes(String(value.kind))
    && (DOWNLOAD_STATES as readonly string[]).includes(String(value.state))
    && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) && typeof value.incognito === 'boolean';
}
interface LocalSender { id?: string | undefined; url?: string | undefined; tab?: { id?: number | undefined } | undefined; }
export function trustedUI(sender: LocalSender, id: string, base: string): boolean {
  if (sender.id !== id || typeof sender.url !== 'string') return false;
  try {
    const u = new URL(sender.url);
    return ['local/index.html', 'local/popup.html', 'upscale/index.html'].some(page => u.href.split(/[?#]/)[0] === `${base}${page}`);
  } catch { return false; }
}
export function trustedCapture(sender: LocalSender, id: string): boolean {
  if (sender.id !== id || !Number.isInteger(sender.tab?.id) || (sender.tab?.id ?? -1) < 0) return false;
  try { mediaURL(sender.url); return true; } catch { return false; }
}
