import { envelope, safeBridge } from '../security/validation.ts';

/** cyrb53: preserve the exact channel name used by the packaged extension. */
export function channelHash(text: string, seed = 0): number {
  let a = 0xdeadbeef ^ seed;
  let b = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507);
  a ^= Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507);
  b ^= Math.imul(a ^ (a >>> 13), 3266489909);
  return 4294967296 * (2097151 & b) + (a >>> 0);
}

export function bridge(requests: readonly string[], responses: readonly string[]) {
  const channel = new BroadcastChannel(`injected-${channelHash(location.href)}`);
  const abort = new AbortController();
  let pending = false;
  const send = (name: string, data: unknown) => {
    const message = { channel: 4, msg: { name, data } };
    if (!abort.signal.aborted && safeBridge(message, responses)) channel.postMessage(message);
  };
  const poll = async (read: () => boolean | Promise<boolean>) => {
    if (pending) return;
    pending = true;
    try {
      let attempt = 1;
      while (!abort.signal.aborted) {
        try { if (await read()) return; } catch { /* Site state may be partially initialized. */ }
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, Math.min(attempt++ * 1000, 30_000));
          abort.signal.addEventListener('abort', done, { once: true });
        });
      }
    } finally { pending = false; }
  };
  let lastRequest = -Infinity;
  const listen = (handler: (name: string) => void) => channel.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (!envelope(event.data) || event.data.channel !== 5 || !requests.includes(event.data.msg.name)) return;
    const now = performance.now();
    if (now - lastRequest < 100) return;
    lastRequest = now;
    handler(event.data.msg.name);
  });
  addEventListener('pagehide', event => { if (!event.persisted) { abort.abort(); channel.close(); } });
  return { send, poll, listen };
}

export const siteWindow = window as Window & {
  ytcfg?: unknown; playerConfig?: unknown; __playerdata__?: unknown;
  __INITIAL_STATE__?: unknown; __initialState?: unknown;
};
