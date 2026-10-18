/** ALPN observations only. Alt-Svc advertises availability, not the protocol used. */
export type Transport = 'h3' | 'h2' | 'http/1.1';
export function transport(value: unknown): Transport | undefined {
  if (typeof value !== 'string') return undefined;
  if (/^h3(?:-\d+)?$/.test(value)) return 'h3';
  if (value === 'h2') return 'h2';
  if (value === 'http/1.1') return 'http/1.1';
  return undefined;
}
export function transportLabel(value: Transport): string { return value === 'h3' ? 'HTTP/3' : value === 'h2' ? 'HTTP/2' : 'HTTP/1.1'; }
export function resourceTransport(url: string, since = 0): Transport | undefined {
  if (typeof performance === 'undefined' || !performance.getEntriesByName) return undefined;
  const entries = performance.getEntriesByName(url, 'resource') as PerformanceResourceTiming[];
  return transport(entries.filter(entry => entry.startTime >= since).at(-1)?.nextHopProtocol);
}
/** Resource entries can be delivered just after the body stream closes. */
export function observeTransport(url: string, since: number) {
  let observer: PerformanceObserver | undefined;
  let settle!: (value: Transport | undefined) => void;
  let done = false;
  const result = new Promise<Transport | undefined>(resolve => {
    settle = value => { if (!done) { done = true; observer?.disconnect(); resolve(value); } };
  });
  try {
    observer = new PerformanceObserver(list => {
      const entry = list.getEntries().find(entry => entry.name === url && entry.startTime >= since) as PerformanceResourceTiming | undefined;
      if (entry) settle(transport(entry.nextHopProtocol));
    });
    observer.observe({ type: 'resource', buffered: true });
  } catch { settle(undefined); }
  return {
    async finish() {
      const known = resourceTransport(url, since); if (known) settle(known);
      const timer = setTimeout(() => settle(undefined), 50);
      try { return await result; } finally { clearTimeout(timer); }
    },
    cancel() { settle(undefined); },
  };
}
