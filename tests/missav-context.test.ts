import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaCatalog, type MediaItem } from '../src/local/model.ts';
import { missavPageSource, recoverMissavContext } from '../src/local/missav-context.ts';

const id = 'a1b2c3d4-1234-5678-abcd-1234567890ab';
const url = `https://surrit.com/${id}/1080p//video.m3u8?sig=Old%2FCase`;
const fresh = url.replace('Old%2FCase', 'New%2FExact');
const page = 'https://missav123.com/ko/owned-fixture';
const item = (changes: Partial<MediaItem> = {}): MediaItem => ({ id: crypto.randomUUID(), tabId: -1, url, title: '', mime: '', kind: 'hls', createdAt: 1, ...changes });
async function chromeAPI<T>(tabs: unknown, run: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { tabs, extension: { inIncognitoContext: false } } });
  try { return await run(); }
  finally { if (previous) Object.defineProperty(globalThis, 'chrome', previous); else Reflect.deleteProperty(globalThis, 'chrome'); }
}

test('direct input and retries recover the detected source tab and its fresh opaque signature', async () => {
  const catalog = new MediaCatalog();
  catalog.set(item({ tabId: 7, url: fresh, title: 'Owned video', missavRank: 2 }));
  await chromeAPI({ get: async (id: number) => ({ id, url: page, incognito: false }) }, async () => {
    const restored = await recoverMissavContext(item(), catalog);
    assert.equal(restored.tabId, 7); assert.equal(restored.url, fresh); assert.equal(restored.title, 'Owned video');
  });
});

test('recover a matching open page after the service worker loses its media catalog', async () => {
  const queries: number[] = [];
  await chromeAPI({ query: async () => [
    { id: 1, url: 'https://example.test/', active: true },
    { id: 2, url: page, incognito: true },
    { id: 3, url: page, incognito: false, active: true },
    { id: 4, url: page, incognito: false },
  ], sendMessage: async (tab: number) => {
    queries.push(tab);
    return { ok: true, url: tab === 3 ? fresh.replace(id, '11111111-1111-1111-1111-111111111111') : fresh, title: 'Recovered source' };
  } }, async () => {
    const restored = await recoverMissavContext(item(), new MediaCatalog());
    assert.equal(restored.tabId, 4); assert.equal(restored.url, fresh);
    assert.deepEqual(queries, [3, 4]);
  });
});

test('a missing or stale source page fails before any extension-origin media fetch', async () => {
  await chromeAPI({ query: async () => [{ id: 7, url: page, incognito: false }], sendMessage: async () => { throw new Error('Receiving end does not exist'); } }, async () => {
    await assert.rejects(recoverMissavContext(item(), new MediaCatalog()), /재생 페이지를 새로고침/);
  });
});

test('ordinary media and existing detected items keep their original download path', async () => {
  await chromeAPI({}, async () => {
    for (const source of [item({ url: 'https://example.test/list.m3u8' }), item({ tabId: 7 }), item({ kind: 'file' })]) {
      assert.equal(await recoverMissavContext(source, new MediaCatalog()), source);
    }
  });
});

test('page lookup proves the same video and refreshes only a whole observed endpoint', () => {
  assert.equal(missavPageSource(page, [], [fresh], url), fresh);
  assert.equal(missavPageSource(page, [], [url, fresh], url), fresh);
  assert.equal(missavPageSource(page, [], [fresh.replace('/1080p/', '/720p/')], url), url);
  assert.equal(missavPageSource(page, [], [fresh.replace(id, '11111111-1111-1111-1111-111111111111')], url), undefined);
  assert.equal(missavPageSource('https://other.test/', [], [fresh], url), undefined);
});

test('untrusted lookup replies cannot switch to local, authenticated or unrelated URLs', async () => {
  for (const unsafe of ['http://127.0.0.1/private', fresh.replace('surrit.com', 'evil.test'), fresh.replace('surrit.com', 'user:secret@surrit.com'), fresh.replace('surrit.com', 'surrit.com:8443')]) {
    await chromeAPI({ query: async () => [{ id: 7, url: page, incognito: false }], sendMessage: async () => ({ ok: true, url: unsafe }) }, async () => {
      await assert.rejects(recoverMissavContext(item(), new MediaCatalog()), /MissAV 탭/);
    });
  }
});
