/** MissAV-only playback discovery. Do not fetch pages or run page scripts. */
const UUID = '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}';
const CDN_UUID = new RegExp('(?:https?:)?\\/\\/(?:www\\.)?surrit\\.com\\/(' + UUID + ')(?=\\/|[\\s"\\x27\\x60]|$)', 'gi');
const UUID_NEAR_SEEK = new RegExp('(' + UUID + ')[^\\r\\n]{0,80}\\bseek\\b', 'gi');
const ANY_UUID = new RegExp(UUID, 'gi');
const MAX_SCRIPTS = 256;
const MAX_SCRIPT_LENGTH = 512 * 1024;
const MAX_PLAYLISTS = 8;

export function isMissavPage(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && /^(?:[a-z0-9-]+\.)?missav\d*\.[a-z]{2,}$/i.test(url.hostname);
  } catch { return false; }
}

/**
 * Discover the documented surrit.com master HLS URL from visible inline
 * player configuration. An unrelated UUID is not sufficient evidence.
 * Existing HLS preparation, download limits and DRM checks remain unchanged.
 */
export function missavPlaylistURLs(pageURL: string, scripts: Iterable<string>): string[] {
  if (!isMissavPage(pageURL)) return [];
  const found = new Set<string>();
  const add = (id: string) => {
    if (found.size < MAX_PLAYLISTS) found.add('https://surrit.com/' + id.toLowerCase() + '/playlist.m3u8');
  };
  let inspected = 0;
  for (const original of scripts) {
    if (++inspected > MAX_SCRIPTS || found.size >= MAX_PLAYLISTS) break;
    if (typeof original !== 'string' || !original || original.length > MAX_SCRIPT_LENGTH) continue;
    // JSON-escaped URLs are common in embedded player configuration.
    const script = original.replace(/\\\//g, '/');
    for (const match of script.matchAll(CDN_UUID)) add(match[1]!);
    for (const match of script.matchAll(UUID_NEAR_SEEK)) add(match[1]!);
    // The reference extractor falls back to one UUID in a player script.
    if (/\bseek\b/i.test(script)) {
      const matches = new Set([...script.matchAll(ANY_UUID)].map(match => match[0].toLowerCase()));
      if (matches.size === 1) add(matches.values().next().value!);
    }
  }
  return [...found];
}
