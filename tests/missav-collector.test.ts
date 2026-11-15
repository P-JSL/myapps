import test from 'node:test';
import assert from 'node:assert/strict';

test('MissAV content script publishes an observed HLS resource with no ALPN timing', async () => {
  const keys = ['chrome', 'location', 'document', 'performance', 'PerformanceObserver', 'MutationObserver'] as const;
  const prior = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const observed: unknown[] = [];
  const uuid = 'a1b2c3d4-1234-5678-abcd-1234567890ab';
  const variant = 'https://surrit.com/' + uuid + '/720p/video.m3u8';
  try {
    const put = (name: string, value: unknown) =>
      Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
    put('location', { href: 'https://missav123.com/ko/ebwh-352-uncensored-leak' });
    put('document', {
      title: 'Offline MissAV video fixture', baseURI: 'https://missav123.com/ko/ebwh-352-uncensored-leak',
      scripts: [{ textContent: '' }],
      querySelectorAll: () => [],
      documentElement: {},
      addEventListener() {},
    });
    put('performance', {
      getEntriesByType: (type: string) => type === 'resource' ? [{ name: variant }] : [],
      getEntriesByName: () => [],
    });
    put('PerformanceObserver', class { constructor(_callback: unknown) {} observe() {} });
    put('MutationObserver', class { constructor(_callback: unknown) {} observe() {} });
    put('chrome', {
      runtime: {
        id: 'offline-missav-test',
        sendMessage(message: unknown) { observed.push(message); return Promise.resolve({ ok: true }); },
        onMessage: { addListener() {} },
      },
    });
    await import('../src/local/collect.ts');
    const matches = observed.flatMap(value => {
      if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items)) return [];
      return value.items as Array<{ url: string; mime: string }>;
    });
    assert(matches.some(item => item.url === variant && item.mime === 'application/vnd.apple.mpegurl'));
  } finally {
    for (const key of keys) {
      const descriptor = prior[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
