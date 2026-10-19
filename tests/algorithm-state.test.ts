import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaCatalog, MAX_MEDIA_PER_TAB, type MediaItem } from '../src/local/model.ts';

const item = (id: string, tabId: number, url = `https://media.test/${id}.mp4`, kind: MediaItem['kind'] = 'file'): MediaItem => ({
  id, tabId, url, kind, title: id, mime: 'video/mp4', createdAt: 1,
});

// Original background catalog behavior, retained as an independent ordering/eviction oracle.
class PreviousCatalog {
  tabs = new Map<number, Map<string, MediaItem>>();
  set(entry: MediaItem) {
    const entries = this.tabs.get(entry.tabId) ?? new Map<string, MediaItem>();
    entries.set(entry.url, entry);
    while (entries.size > MAX_MEDIA_PER_TAB) entries.delete(Array.from(entries).find(([, row]) => row.kind === 'file')?.[0] ?? entries.keys().next().value!);
    this.tabs.set(entry.tabId, entries);
  }
  find(id: string) { return Array.from(this.tabs.values()).flatMap(entries => Array.from(entries.values())).find(row => row.id === id); }
}

test('indexed media lookup preserves stable IDs, richer replacements, separate tabs and original eviction order', () => {
  const current = new MediaCatalog(); const previous = new PreviousCatalog();
  const insert = (entry: MediaItem) => { current.set(entry); previous.set(entry); };
  for (let index = 0; index < MAX_MEDIA_PER_TAB; index++) insert(item(`media-${index}`, 7, undefined, index < 3 ? 'hls' : 'file'));
  const upgraded = { ...current.find('media-3')!, title: 'rich metadata', observedTransport: 'h3' as const, size: 777 };
  insert(upgraded);
  assert.equal(current.find('media-3'), upgraded);
  assert.equal([...current.items(7)][3], upgraded, 'replacing a URL retains its insertion order');
  insert(item('media-extra', 7));
  assert.equal(current.find('media-3'), undefined, 'the oldest file is evicted before older manifests');
  assert.deepEqual([...current.items(7)], [...previous.tabs.get(7)!.values()]);
  const otherTab = item('other-tab', 8, current.find('media-0')!.url);
  insert(otherTab); current.deleteTab(7); previous.tabs.delete(7);
  assert.equal(current.find('media-0'), undefined); assert.equal(current.find('other-tab'), otherTab);
  assert.equal(current.size, 1); assert.deepEqual([...current.tabIds()], [8]);
  current.deleteTab(8); assert.equal(current.size, 0); assert.deepEqual([...current.tabIds()], []);
});

test('indexed media catalog equals the prior implementation across deterministic mixed mutations', () => {
  const current = new MediaCatalog(); const previous = new PreviousCatalog();
  let seed = 0x35d8621; let sequence = 0;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const ids: string[] = [];
  for (let operation = 0; operation < 4000; operation++) {
    const tabId = random() % 8; const choice = random() % 100;
    if (choice < 94) {
      const url = `https://media.test/${random() % 260}.mp4`;
      const existing = previous.tabs.get(tabId)?.get(url);
      const id = existing?.id ?? `random-${sequence++}`; ids.push(id);
      const entry = { ...item(id, tabId, url, (['file', 'hls', 'dash'] as const)[random() % 3]!), createdAt: random() % 10, title: `update-${operation}` };
      current.set(entry); previous.set(entry);
    } else { current.deleteTab(tabId); previous.tabs.delete(tabId); }
    assert.deepEqual([...current.tabIds()], [...previous.tabs.keys()]);
    let retained = 0;
    for (const [tab, entries] of previous.tabs) {
      assert.deepEqual([...current.items(tab)], [...entries.values()]); retained += entries.size;
      for (const entry of entries.values()) assert.equal(current.find(entry.id), previous.find(entry.id));
    }
    assert.equal(current.size, retained);
    const sampled = ids[random() % ids.length] ?? 'missing';
    assert.equal(current.find(sampled), previous.find(sampled)); assert.equal(current.find('missing'), undefined);
  }
});

test('catalog indexes remove replaced IDs and relocated entries rather than keeping stale selectable references', () => {
  const current = new MediaCatalog(); const first = item('first', 1);
  current.set(first);
  const replaced = { ...first, id: 'replacement' }; current.set(replaced);
  assert.equal(current.find('first'), undefined); assert.equal(current.find('replacement'), replaced); assert.equal(current.size, 1);
  const moved = { ...replaced, tabId: 2, url: 'https://media.test/moved.mp4' }; current.set(moved);
  assert.deepEqual([...current.items(1)], []); assert.deepEqual([...current.tabIds()], [2]);
  assert.equal(current.get(1, first.url), undefined); assert.equal(current.get(2, moved.url), moved);
  current.deleteTab(1); assert.equal(current.find(moved.id), moved);
  current.deleteTab(2); assert.equal(current.find(moved.id), undefined); assert.equal(current.size, 0);
});

test('a full manifest-only tab keeps the original preference for evicting files before manifests', () => {
  const current = new MediaCatalog(); const previous = new PreviousCatalog();
  const insert = (entry: MediaItem) => { current.set(entry); previous.set(entry); };
  for (let index = 0; index < MAX_MEDIA_PER_TAB; index++) insert(item(`manifest-${index}`, 9, undefined, 'hls'));
  insert(item('new-file', 9));
  assert.equal(current.find('new-file'), undefined, 'a new file is evicted when every older item is a manifest');
  assert.equal(current.size, MAX_MEDIA_PER_TAB);
  insert(item('new-manifest', 9, undefined, 'dash'));
  assert.equal(current.find('manifest-0'), undefined, 'without files the oldest manifest is evicted');
  assert.equal(current.find('new-manifest')?.kind, 'dash');
  assert.deepEqual([...current.items(9)], [...previous.tabs.get(9)!.values()]);
});
