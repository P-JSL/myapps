/** Treat every message crossing a page/extension boundary as untrusted. */
export type RecordValue = Record<string, unknown>;
export function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function boundedData(value: unknown, maxChars = 16 * 1024 * 1024): boolean {
  const stack: Array<[unknown, number, boolean?]> = [[value, 0]];
  const visited = new Set<object>();
  let nodes = 0;
  let chars = 0;
  while (stack.length) {
    const [item, depth, exit] = stack.pop()!;
    if (exit) { visited.delete(item as object); continue; }
    if (++nodes > 100_000 || depth > 64) return false;
    if (typeof item === 'string') chars += item.length;
    else if (typeof item === 'number' && !Number.isFinite(item)) return false;
    else if (typeof item === 'object' && item !== null) {
      if (visited.has(item)) return false;
      visited.add(item);
      stack.push([item, depth, true]);
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
      for (const key of Object.keys(item)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return false;
        chars += key.length;
        stack.push([(item as RecordValue)[key], depth + 1]);
      }
    } else if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') return false;
    if (chars > maxChars) return false;
  }
  return true;
}

export interface Envelope { channel: number; msg: { name: string; data?: unknown } }
export function envelope(value: unknown): value is Envelope {
  return record(value) && Number.isInteger(value.channel) && Number(value.channel) >= 0 && Number(value.channel) <= 8
    && record(value.msg) && typeof value.msg.name === 'string' && value.msg.name.length > 0
    && value.msg.name.length <= 100 && boundedData(value.msg.data);
}

export interface Sender { id?: string | undefined; url?: string | undefined; tab?: { id?: number | undefined } | undefined; }
function url(value: unknown): URL | undefined {
  if (typeof value !== 'string') return undefined;
  try { return new URL(value); } catch { return undefined; }
}
function site(host: string, suffix: string): boolean { return host === suffix || host.endsWith(`.${suffix}`); }

export function allowRuntimeMessage(value: unknown, sender: Sender, id: string, expected: 0 | 1): boolean {
  if (!envelope(value) || value.channel !== expected || sender.id !== id) return false;
  const source = url(sender.url);
  if (!source) return false;
  if (expected === 1) return source.protocol === 'chrome-extension:' && source.hostname === id;
  if (!Number.isInteger(sender.tab?.id) || (sender.tab?.id ?? -1) < 0 || !['https:', 'http:'].includes(source.protocol)) return false;
  const { name, data } = value.msg;
  if (!record(data)) return false;
  switch (name) {
    case 'on_media': return record(data.media);
    case 'remove_media': return typeof data.hash === 'string' && data.hash.length <= 512;
    case 'on_activate_addon':
      return source.protocol === 'https:' && ['downloadhelper.net', 'app.downloadhelper.net', 'v10.downloadhelper.net'].includes(source.hostname)
        && source.pathname.startsWith('/activate') && typeof data.key === 'string' && data.key.length <= 8192;
    case 'qjs':
      return site(source.hostname, 'youtube.com') && typeof data.code === 'string' && data.code.length <= 4 * 1024 * 1024
        && (typeof data.uid === 'string' || typeof data.uid === 'number');
    case 'do_fetch_from_service': {
      const target = url(data.url);
      return ['vk.com', 'vk.ru', 'vkvideo.ru'].some(host => site(source.hostname, host))
        && target?.href === 'https://vk.com/al_video.php' && data.method === 'POST'
        && record(data.fetch_headers) && record(data.body_params)
        && (typeof data.uid === 'string' || typeof data.uid === 'number');
    }
    default: return false;
  }
}

export const bridgeResponses: Record<string, readonly string[]> = {
  youtube: ['youtube_on_visitor_data'], vimeo: ['vimeo_on_config'], iq: ['iq_on_config'],
  bilibili: ['bilibili_tv_on_config', 'bilibili_com_on_id'], javrank: ['javrank_on_manifest'],
  xgplayer_crypto: ['91porna_on_config'],
};
export function safeBridge(value: unknown, names: readonly string[]): boolean {
  if (!envelope(value) || value.channel !== 4 || !names.includes(value.msg.name) || !record(value.msg.data)) return false;
  const d = value.msg.data;
  switch (value.msg.name) {
    case 'youtube_on_visitor_data': return d.visitor_data === undefined || typeof d.visitor_data === 'string';
    case 'vimeo_on_config': case 'iq_on_config': return record(d.config);
    case 'javrank_on_manifest': return typeof d.raw === 'string' && d.raw.trimStart().startsWith('#EXTM3U');
    case '91porna_on_config': {
      const u = url(d.url);
      return typeof d.m3u8 === 'string' && d.m3u8.trimStart().startsWith('#EXTM3U') && !!u && ['http:', 'https:'].includes(u.protocol);
    }
    case 'bilibili_tv_on_config': return ['string', 'number', 'undefined'].includes(typeof d.ep_id) && ['string', 'number', 'undefined'].includes(typeof d.ai_id);
    case 'bilibili_com_on_id': return ['string', 'number'].includes(typeof d.cid) && typeof d.bvid === 'string';
    default: return false;
  }
}
