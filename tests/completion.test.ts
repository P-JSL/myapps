import test from 'node:test';
import assert from 'node:assert/strict';
import { DIRECTORY, JOBS_KEY } from '../src/upscale/policy.ts';
import { appStorage } from '../src/data/database.ts';

test('revoked upscale copies stay unpublished and a fresh clean scan can authorize a new offer', async () => {
  const bytes = new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
  const data: Record<string, unknown> = {};
  const copies = new Map<string, Uint8Array>();
  const notices: string[] = [];
  let release: (() => void) | undefined;
  let copying: (() => void) | undefined;
  let gate = false;
  const event = { addListener() {} };
  const source = new File([bytes], 'source.mp4');
  source.stream = () => new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      const write = () => { controller.enqueue(bytes); controller.close(); };
      if (gate) { release = write; copying?.(); } else write();
    },
  });
  const dir = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!copies.has(name) && !options?.create) throw new DOMException('Not found', 'NotFoundError');
      return {
        async createWritable() {
          const chunks: Uint8Array[] = [];
          return new WritableStream<Uint8Array>({
            write(chunk) { chunks.push(chunk); },
            close() { copies.set(name, new Uint8Array(Buffer.concat(chunks))); },
          });
        },
      };
    },
    async removeEntry(name: string) { copies.delete(name); },
    async *keys() { yield* copies.keys(); },
  };
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');
  const originalAppStorage = { get: appStorage.get, set: appStorage.set, ready: appStorage.ready, status: appStorage.status };
  appStorage.get = async keys => Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map(key => [key, structuredClone(data[key])]));
  appStorage.set = async values => { Object.assign(data, structuredClone(values)); };
  appStorage.ready = async () => {};
  appStorage.status = async () => ({ name: 'completion-test', version: 1, privateContext: false, historyCount: 0, jobCount: (data[JOBS_KEY] as unknown[] | undefined)?.length ?? 0, recoveryCount: 0, lastMaintenanceAt: null, migratedAt: null, legacyCleanupPending: false });
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    storage: { local: { async get(key: string) { return { [key]: data[key] }; }, async set(values: Record<string, unknown>) { Object.assign(data, structuredClone(values)); } } },
    runtime: { getURL: (path: string) => path, onInstalled: event, onStartup: event },
    notifications: { onClicked: event, onButtonClicked: event, async create(id: string) { notices.push(id); return id; }, async clear(id: string) { const i = notices.indexOf(id); if (i >= 0) notices.splice(i, 1); return true; } },
    contextMenus: { onClicked: event },
  } });
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { async getDirectory() { return {
    async getFileHandle() { return { async getFile() { return source; } }; },
    async getDirectoryHandle(name: string) { assert.equal(name, DIRECTORY); return dir; },
  }; } } });
  try {
    const { offerUpscale, revokeDownloadOffers, authorizeDownloadOffers } = await import('../src/upscale/completion.ts');
    const downloadId = 9001;
    const metadata = { internalFilename: 'input.media', filename: 'video.mp4', downloadId, success: true, incognito: false };
    gate = true;
    const started = new Promise<void>(resolve => { copying = resolve; });
    const first = offerUpscale(metadata);
    await started;
    // Queue a second, stale offer, then revoke while the first still copies bytes.
    const stale = offerUpscale(metadata);
    const revoked = revokeDownloadOffers(downloadId);
    release!();
    await Promise.all([first, stale, revoked]);
    assert.equal(copies.size, 0);
    assert.equal((data[JOBS_KEY] as unknown[]).length, 0);
    assert.equal(notices.length, 0);
    // Only an explicit fresh clean authorization restores future offers.
    gate = false;
    await offerUpscale(metadata);
    assert.equal(notices.length, 0);
    authorizeDownloadOffers(downloadId);
    await offerUpscale(metadata);
    assert.equal(copies.size, 1);
    assert.equal((data[JOBS_KEY] as unknown[]).length, 1);
    assert.equal(notices.length, 1);
    assert.deepEqual(Array.from(copies.values())[0], bytes);
  } finally {
    Object.assign(appStorage, originalAppStorage);
    if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome); else Reflect.deleteProperty(globalThis, 'chrome');
    if (originalStorage) Object.defineProperty(navigator, 'storage', originalStorage); else Reflect.deleteProperty(navigator, 'storage');
  }
});
