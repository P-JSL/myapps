/** MissAV-only stream recognition. No page requests, script execution or CDN policy bypass. */
const UUID = '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}';
const UUID_RE = new RegExp('^' + UUID + '$', 'i');
const CDN_REFERENCE = new RegExp(
  '(?:https?:\\/\\/)?(?:www\\.)?((?:surrit|nineyu|fourhoi)\\.(?:com|store))\\/(' + UUID + ')(?=\\/)', 'gi',
);
const UUID_NEAR_SEEK = new RegExp('(' + UUID + ')[^\\r\\n]{0,100}\\/seek\\b', 'gi');
const ANY_UUID = new RegExp(UUID, 'gi');
const MAX_SCRIPTS = 256;
const MAX_SCRIPT_LENGTH = 512 * 1024;
const MAX_PLAYLISTS = 8;
const MAX_RESOURCES = 1500;

export function isMissavPage(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && /^(?:[a-z0-9-]+\.)?missav\d*\.[a-z]{2,}$/i.test(url.hostname);
  } catch { return false; }
}

function isCDN(host: string): boolean {
  return /^(?:surrit|nineyu|fourhoi)\.(?:com|store)$/i.test(host.replace(/^www\./i, ''));
}

export function missavVideoId(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !isCDN(url.hostname)) return;
    const id = url.pathname.split('/')[1];
    return id && UUID_RE.test(id) ? id.toLowerCase() : undefined;
  } catch { return; }
}
export function isMissavAssetURL(value: string, manifest: string): boolean {
  const id = missavVideoId(manifest);
  return value.length <= 8192 && id !== undefined && missavVideoId(value) === id;
}

/** Only real, HTTPS CDN URLs can be published through the existing HLS pipeline. */
export function missavMediaURL(value: string): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !isCDN(url.hostname)) return undefined;
    const parts = url.pathname.split('/').filter(Boolean);
    const id = parts[0];
    if (!id || !UUID_RE.test(id)) return undefined;
    if (/\.m3u8$/i.test(url.pathname)) {
      // CDN paths and signed query strings are opaque. Preserve the address
      // that actually played, including case and repeated path separators.
      url.hash = '';
      return url.href;
    }
    // CDN segment/seek requests establish the canonical master URL, but must
    // never be published themselves as complete media files.
    if (parts.length >= 2 && (parts[1] === 'seek' || parts.slice(1).some(part => /\.(?:ts|m4s|mp4)$/i.test(part)))) {
      return url.origin + '/' + id.toLowerCase() + '/playlist.m3u8';
    }
    return undefined;
  } catch { return undefined; }
}

function unescapePlayerText(value: string): string {
  return value.replace(/\\u002f/gi, '/').replace(/\\\//g, '/');
}

/**
 * Read only existing page inline scripts and browser-observed resource URLs.
 * Prefer requested playlists to synthesized masters; do not guess from unrelated UUIDs.
 */
export function missavPlaylistCandidates(pageURL: string, scripts: Iterable<string>, resourceURLs: Iterable<string> = []): Array<{ url: string; rank: number }> {
  if (!isMissavPage(pageURL)) return [];
  const found = new Map<string, { rank: number; urls: Set<string> }>();
  const add = (value: string | undefined, rank = 0) => {
    if (!value) return;
    const id = new URL(value).pathname.split('/').filter(Boolean)[0]!.toLowerCase();
    const previous = found.get(id);
    if (previous && previous.rank > rank) return;
    if (!previous || previous.rank < rank) found.set(id, { rank, urls: new Set([value]) });
    else {
      if (rank === 2) {
        const next = new URL(value);
        for (const old of previous.urls) {
          const before = new URL(old);
          if (before.origin === next.origin && before.pathname === next.pathname) previous.urls.delete(old);
        }
      }
      previous.urls.add(value);
    }
  };
  let inspectedResources = 0;
  for (const url of resourceURLs) {
    if (++inspectedResources > MAX_RESOURCES) break;
    add(missavMediaURL(url), /\.m3u8(?:[?#]|$)/i.test(url) ? 2 : 0);
  }
  let inspected = 0;
  for (const original of scripts) {
    if (++inspected > MAX_SCRIPTS) break;
    if (typeof original !== 'string' || !original || original.length > MAX_SCRIPT_LENGTH) continue;
    const script = unescapePlayerText(original);
    let knownHost = false;
    // Handle full playback URLs, including CDN sub-variants and encoded paths.
    for (const match of script.matchAll(/https:\/\/[^\s"'<>\\]{1,2048}\.m3u8(?:\?[^\s"'<>\\]{0,1024})?/gi)) {
      const url = missavMediaURL(match[0]);
      if (url) { knownHost = true; add(url, 1); }
    }
    // A known packed-player format stores the UUID parts in reverse order.
    // Accept only the exact five UUID fields to avoid matching unrelated tokens.
    for (const match of script.matchAll(/m3u8\|([0-9a-f|]{36,100})\|com\|(surrit|nineyu|fourhoi)\|https/gi)) {
      const fields = match[1]!.split('|').reverse();
      const packedId = fields.join('-').toLowerCase();
      if (fields.length === 5 && UUID_RE.test(packedId)) {
        knownHost = true;
        add('https://' + match[2]!.toLowerCase() + '.com/' + packedId + '/playlist.m3u8');
      }
    }
    // MissAV player URLs often contain a CDN UUID /seek path, not a .m3u8 URL.
    for (const match of script.matchAll(CDN_REFERENCE)) {
      knownHost = true;
      add('https://' + match[1]!.toLowerCase() + '/' + match[2]!.toLowerCase() + '/playlist.m3u8');
    }
    // Only assume the default CDN if this script contained no known CDN host.
    // Otherwise the same UUID can be published for a wrong host.
    if (!knownHost) {
      for (const match of script.matchAll(UUID_NEAR_SEEK)) {
        add('https://surrit.com/' + match[1]!.toLowerCase() + '/playlist.m3u8');
      }
      if (/\bseek\b/i.test(script)) {
        const ids = new Set([...script.matchAll(ANY_UUID)].map(match => match[0].toLowerCase()));
        if (ids.size === 1) add('https://surrit.com/' + ids.values().next().value! + '/playlist.m3u8');
      }
    }
  }
  return [...found.values()].sort((a, b) => b.rank - a.rank).flatMap(item => [...item.urls].map(url => ({ url, rank: item.rank }))).slice(0, MAX_PLAYLISTS);
}
export function missavPlaylistURLs(pageURL: string, scripts: Iterable<string>, resourceURLs: Iterable<string> = []): string[] {
  return missavPlaylistCandidates(pageURL, scripts, resourceURLs).map(item => item.url);
}
