import test from 'node:test';
import assert from 'node:assert/strict';
import { appStorage } from '../src/data/database.ts';
import { HISTORY_KEY, SCOPE, OFFSCREEN_SCOPE, type HistoryItem } from '../src/local/model.ts';

class Events {
  addListener(_listener: (...args: never[]) => unknown) {}
}
interface State {
  data: Record<string, unknown>;
  download?: chrome.downloads.DownloadItem;
  cancelFails: boolean;
  failTrackingCommit: boolean;
  failScanningCommit: boolean;
  searchFailureAt: number;
  searches: number;
  danger?: string;
  persistentFailure: boolean;
  preparationFails: boolean;
  started: boolean;
  trackingWrites: number;
  cancelCalls: number[];
  notices: chrome.notifications.NotificationOptions[];
  disposed: string[];
  nativeCalls: number;
}
let state: State;
const fresh = (): State => ({ data: { [HISTORY_KEY]: [] }, cancelFails: false, failTrackingCommit: true, failScanningCommit: false, searchFailureAt: 0, searches: 0, persistentFailure: false,
  preparationFails: false, started: false, trackingWrites: 0, cancelCalls: [], notices: [], disposed: [], nativeCalls: 0 });
const ui = { id: 'runtime-security', url: 'chrome-extension://runtime-security/local/index.html' };
async function until(predicate: () => boolean) {
  const limit = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > limit) assert.fail('Timed out waiting for storage-failure cleanup');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('native download tracking fails closed when its safety record cannot be committed', async t => {
  state = fresh();
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');
  const originalAppStorage = { ...appStorage };
  const event = () => new Events();
  const fake = {
    extension: { inIncognitoContext: false },
    runtime: {
      id: 'runtime-security', getURL: (value: string) => `chrome-extension://runtime-security/${value}`,
      onMessage: event(), onInstalled: event(), onStartup: event(),
      connectNative() { state.nativeCalls++; throw new Error('An untracked download must not be accepted as scanned'); },
      async sendMessage(value: { scope: string; type: string; id: string }) {
        if (value.scope === OFFSCREEN_SCOPE && value.type === 'prepare') {
          if (state.preparationFails) { state.started = true; throw new Error('Preparation failed'); }
          return { ok: true, url: 'blob:chrome-extension://runtime-security/prepared', extension: 'mp4', mime: 'video/mp4' };
        }
        if (value.type === 'dispose') state.disposed.push(value.id);
        return { ok: true };
      },
    },
    downloads: {
      onChanged: event(),
      async download() {
        state.started = true;
        state.download = { id: 77, state: state.cancelFails ? 'complete' : 'in_progress', danger: state.danger ?? 'safe', exists: true,
          filename: '/downloads/video.mp4', fileSize: 16 } as chrome.downloads.DownloadItem;
        return 77;
      },
      async search() { state.searches++; if (state.searches === state.searchFailureAt) throw new Error('Chrome lookup failed'); return state.download ? [structuredClone(state.download)] : []; },
      async cancel(id: number) {
        state.cancelCalls.push(id);
        if (state.cancelFails) throw new Error('Download already completed');
        state.download!.state = 'interrupted'; state.download!.error = 'USER_CANCELED';
      },
    },
    notifications: {
      onClicked: event(), onButtonClicked: event(), async clear() { return true; },
      async create(_id: string, options: chrome.notifications.NotificationOptions) { state.notices.push(options); return 'notice'; },
    },
    tabs: { onRemoved: event(), onUpdated: event(), onActivated: event() },
    webRequest: { onHeadersReceived: event() }, commands: { onCommand: event() },
    offscreen: { async hasDocument() { return true; } },
    contextMenus: { onClicked: event() },
    sidePanel: { async setPanelBehavior() {} }, action: { async setPopup() {} },
  };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: fake });
  Object.defineProperty(navigator, 'storage', { configurable: true, value: {
    async getDirectory() { return { async removeEntry(name: string) { state.disposed.push(name); } }; },
  } });
  Object.assign(appStorage, {
    async ready() { throw new Error('Skip unrelated startup reconciliation in this workflow double'); },
    async get(keys: string | string[]) { return structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, state.data[key]]))); },
    async set(values: Record<string, unknown>) {
      const item = (values[HISTORY_KEY] as HistoryItem[] | undefined)?.[0];
      if (state.started && (state.persistentFailure || (state.failTrackingCommit && item?.state === 'downloading') || (state.failScanningCommit && item?.state === 'scanning'))) { state.trackingWrites++; throw new Error('Safety record commit failed'); }
      Object.assign(state.data, structuredClone(values));
    },
  });
  try {
    const { handleLocalMessage } = await import('../src/local/background.ts');
    const start = () => handleLocalMessage({ scope: SCOPE, type: 'download-url', url: 'https://media.test/video.mp4', options: { quality: 'highest', output: state.preparationFails ? 'mp3' : 'original' } }, ui);
    await t.test('a transient post-start commit failure cancels transmission and retains the actual ID', async () => {
      state = fresh();
      const result = await start() as { item: HistoryItem };
      await until(() => state.notices.length === 1);
      assert.deepEqual(state.cancelCalls, [77]);
      const item = (state.data[HISTORY_KEY] as HistoryItem[])[0]!;
      assert.equal(item.id, result.item.id); assert.equal(item.downloadId, 77);
      assert.equal(item.state, 'cancelled'); assert.equal(item.security?.status, 'error');
      assert.match(state.notices[0]!.message!, /중단/);
      assert(state.disposed.includes(`local-${item.id}.media`)); assert.equal(state.nativeCalls, 0);
    });
    await t.test('a completed download that cannot be cancelled remains in explicit review', async () => {
      state = fresh(); state.cancelFails = true;
      await start(); await until(() => state.notices.length === 1);
      const item = (state.data[HISTORY_KEY] as HistoryItem[])[0]!;
      assert.equal(item.downloadId, 77); assert.equal(item.state, 'review');
      assert.equal(item.security?.status, 'error'); assert.match(item.security?.message ?? '', /파일을 열지 말고/);
      assert.equal(state.nativeCalls, 0); assert.equal(state.trackingWrites, 1);
    });
    await t.test('a Chrome warning still takes precedence when the cancellation attempt fails', async () => {
      state = fresh(); state.cancelFails = true; state.danger = 'content';
      await start(); await until(() => state.notices.length === 1);
      const item = (state.data[HISTORY_KEY] as HistoryItem[])[0]!;
      assert.equal(item.downloadId, 77); assert.equal(item.state, 'review');
      assert.equal(item.security?.status, 'chrome-warning'); assert.equal(item.security?.danger, 'content');
      assert.equal(state.nativeCalls, 0);
    });
    await t.test('a lookup failure after a successful ID commit never overwrites it with the preparing entry', async () => {
      state = fresh(); state.failTrackingCommit = false; state.searchFailureAt = 1;
      const result = await start() as { item: HistoryItem };
      await until(() => state.notices.length === 1);
      const item = (state.data[HISTORY_KEY] as HistoryItem[])[0]!;
      assert.equal(item.id, result.item.id); assert.equal(item.downloadId, 77);
      assert.equal(item.state, 'cancelled'); assert.equal(state.trackingWrites, 0);
      assert.deepEqual(state.cancelCalls, [77]); assert.equal(state.nativeCalls, 0);
    });
    await t.test('a later scanning-state commit failure preserves the ID and explicit review', async () => {
      state = fresh(); state.failTrackingCommit = false; state.failScanningCommit = true; state.cancelFails = true;
      const result = await start() as { item: HistoryItem };
      await until(() => state.notices.length === 1);
      const item = (state.data[HISTORY_KEY] as HistoryItem[])[0]!;
      assert.equal(item.id, result.item.id); assert.equal(item.downloadId, 77);
      assert.equal(item.state, 'review'); assert.equal(item.security?.status, 'error');
      assert.equal(state.trackingWrites, 1); assert.deepEqual(state.cancelCalls, [77]); assert.equal(state.nativeCalls, 0);
    });
    await t.test('persistent storage failure still cancels and warns without an unhandled retry rejection', async () => {
      state = fresh(); state.cancelFails = true; state.persistentFailure = true;
      const result = await start() as { item: HistoryItem };
      await until(() => state.notices.length === 1);
      assert.deepEqual(state.cancelCalls, [77]); assert.equal(state.trackingWrites, 2);
      assert.match(state.notices[0]!.message!, /자동 검사를 보장할 수 없습니다/);
      assert(state.disposed.includes(`local-${result.item.id}.media`));
      assert.equal((state.data[HISTORY_KEY] as HistoryItem[])[0]!.state, 'preparing');
      assert.equal(state.nativeCalls, 0);
    });
    await t.test('preparation cleanup still runs when its error status also cannot be persisted', async () => {
      state = fresh(); state.preparationFails = true; state.persistentFailure = true;
      const result = await start() as { item: HistoryItem };
      await until(() => state.notices.length === 1);
      assert.equal(state.download, undefined); assert.deepEqual(state.cancelCalls, []);
      assert(state.disposed.includes(`local-${result.item.id}.media`));
      assert.match(state.notices[0]!.message!, /작업 상태를 저장하지 못했습니다/);
    });
  } finally {
    await navigator.locks.request('my-video-app-history', async () => {});
    await navigator.locks.request('vdh-upscale-queue-v1', async () => {});
    Object.assign(appStorage, originalAppStorage);
    if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome); else Reflect.deleteProperty(globalThis, 'chrome');
    if (originalStorage) Object.defineProperty(navigator, 'storage', originalStorage); else Reflect.deleteProperty(navigator, 'storage');
  }
});
