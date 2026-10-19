import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { MediaCatalog, MAX_MEDIA_PER_TAB, retainHistory } from '../src/local/model.ts';

// Source-equivalent baseline from background.ts at 6983b53: nested maps and flatMap/find.
class PreviousCatalog {
  tabs = new Map();
  set(item) {
    const tab = this.tabs.get(item.tabId) ?? new Map(); tab.set(item.url, item);
    while (tab.size > MAX_MEDIA_PER_TAB) tab.delete(Array.from(tab).find(([, entry]) => entry.kind === 'file')?.[0] ?? tab.keys().next().value);
    this.tabs.set(item.tabId, tab);
  }
  find(id) { return Array.from(this.tabs.values()).flatMap(tab => Array.from(tab.values())).find(row => row.id === id); }
  deleteTab(id) { this.tabs.delete(id); }
}

let sink = 0;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function measure(operation, count) {
  const start = performance.now();
  for (let index = 0; index < count; index++) operation(index);
  return (performance.now() - start) * 1000 / count;
}
function compare(before, after, count, rounds = 7) {
  const timings = { before: [], after: [] };
  measure(before, Math.min(count, 200)); measure(after, Math.min(count, 200));
  for (let round = 0; round < rounds; round++) for (const key of round % 2 ? ['after', 'before'] : ['before', 'after']) timings[key].push(measure(key === 'before' ? before : after, count));
  const beforeUs = median(timings.before); const afterUs = median(timings.after);
  return { beforeMedianUs: beforeUs, afterMedianUs: afterUs, speedup: beforeUs / afterUs, iterationsPerRound: count, rounds };
}
const cases = [];
for (const tabCount of [1, 10, 50]) {
  const entries = Array.from({ length: tabCount * MAX_MEDIA_PER_TAB }, (_, index) => ({
    id: `item-${index}`, tabId: Math.floor(index / MAX_MEDIA_PER_TAB), url: `https://media.test/${index}.mp4`,
    title: 'video', mime: 'video/mp4', kind: index % 5 ? 'file' : 'hls', createdAt: index,
  }));
  const before = new PreviousCatalog(); const after = new MediaCatalog();
  for (const entry of entries) { before.set(entry); after.set(entry); }
  const targets = [entries[0].id, entries[Math.floor(entries.length / 2)].id, entries.at(-1).id, 'missing'];
  const lookup = compare(index => { sink += before.find(targets[index % targets.length])?.tabId ?? 0; }, index => { sink += after.find(targets[index % targets.length])?.tabId ?? 0; }, 1200);
  const construction = compare(() => { const catalog = new PreviousCatalog(); for (const entry of entries) catalog.set(entry); sink += catalog.tabs.size; }, () => { const catalog = new MediaCatalog(); for (const entry of entries) catalog.set(entry); sink += catalog.size; }, Math.max(2, Math.floor(10_000 / entries.length)), 5);
  const removal = compare(index => {
    const catalog = new PreviousCatalog(); for (const entry of entries.slice(0, MAX_MEDIA_PER_TAB)) catalog.set(entry);
    catalog.deleteTab(0); sink += index;
  }, index => {
    const catalog = new MediaCatalog(); for (const entry of entries.slice(0, MAX_MEDIA_PER_TAB)) catalog.set(entry);
    catalog.deleteTab(0); sink += index;
  }, 200, 5);
  cases.push({ tabCount, retainedItems: entries.length, lookup, construction, constructionAndRemovalOfOneFullTab: removal, extraIndexEntries: after.size });
}
const history = Array.from({ length: 200 }, (_, index) => ({
  id: `history-${index}`, url: '', filename: '', kind: 'file', state: index % 25 ? 'complete' : 'review', createdAt: (index * 37) % 200, incognito: false,
}));
const historyUs = measure(() => { sink += retainHistory(history).length; }, 10_000);
const modelSource = await readFile(new URL('../src/local/model.ts', import.meta.url));
console.log(JSON.stringify({
  benchmark: 'media-catalog-index', baselineCommit: '6983b53', node: process.version, platform: `${process.platform}/${process.arch}`,
  modelSha256: createHash('sha256').update(modelSource).digest('hex'), unit: 'microseconds per operation', cases,
  historyRetentionAt200MeanUs: historyUs,
  complexity: {
    selectBefore: 'O(N) time and O(N) intermediate references across all retained tabs',
    selectAfter: 'Map lookup expected O(1), no full-catalog intermediate array',
    additionalMemory: 'One ID Map entry per retained media item, at most 200 per live tab',
    insertion: 'Expected O(1) below cap; first-file eviction remains O(200) bounded per tab',
    tabRemovalBefore: 'O(1) Map deletion excluding garbage collection', tabRemovalAfter: 'O(k) deletion of at most 200 secondary ID entries',
    persistedHistoryAndQueue: 'Unchanged: H<=200, J<=4. Safety storage reads, origin locks, Chrome revalidation and O(bytes) hashing/copying remain.',
  },
  limitations: 'CPU microbenchmark excludes browser IPC, network, GC pause accounting and video encoding; lookup speedup is not end-to-end download acceleration.',
  sink,
}, null, 2));
