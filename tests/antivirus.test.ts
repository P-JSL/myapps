import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ANTIVIRUS_HOST, chromeWarning, scanFile, scanResponse } from '../src/local/antivirus.ts';
import { HISTORY_KEY, SCOPE, type HistoryItem } from '../src/local/model.ts';
import { DIRECTORY, JOBS_KEY, OFFER_KEY } from '../src/upscale/policy.ts';

const mediaBytes = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
const digest = createHash('sha256').update(mediaBytes).digest('hex');
const nativeResponse = (requestId: string, status = 'clean') => ({ version: 1, requestId, status, engine: 'Test scanner', sha256: digest, size: 16, threats: status === 'infected' ? ['Eicar-Test-Signature'] : [] });

test('Chrome warning classification preserves pending and unknown danger states', () => {
  for (const danger of ['safe', 'accepted', 'deepScannedSafe', 'allowlistedByPolicy', '', undefined]) assert.equal(chromeWarning(danger), undefined);
  for (const danger of ['file', 'content', 'uncommon', 'unwanted', 'sensitiveContentWarning', 'deepScanning', 'asyncScanning', 'blockedScanFailed', 'future-warning']) assert.equal(chromeWarning(danger), danger);
  assert.equal(chromeWarning('x'.repeat(1000))?.length, 100);
});

test('native scan results bind the verdict to the request and measured file identity', () => {
  for (const status of ['clean', 'infected']) {
    const result = scanResponse(nativeResponse('request', status), 'request');
    assert.equal(result.status, status); assert.equal(result.sha256, digest); assert.equal(result.size, 16);
    assert.equal(result.engine, 'Test scanner'); assert.ok(result.checkedAt! <= Date.now());
  }
  for (const status of ['unavailable', 'error']) assert.equal(scanResponse({ version: 1, requestId: 'request', status }, 'request').status, status);
});

test('malformed, mismatched, oversized and unverifiable native verdicts never count as clean', () => {
  const valid = nativeResponse('request');
  for (const value of [null, [], {}, { ...valid, version: 2 }, { ...valid, requestId: 'other' }, { ...valid, status: 'safe' }, { ...valid, status: null }, { ...valid, sha256: undefined }, { ...valid, sha256: 'not-a-hash' }, { ...valid, size: undefined }, { ...valid, size: -1 }, { ...valid, size: 1.5 }, { ...valid, engine: '' }, { ...valid, engine: 'x'.repeat(121) }, { ...valid, message: 'x'.repeat(70_000) }]) assert.throws(() => scanResponse(value, 'request'));
});

class FakeEvent<Args extends unknown[] = unknown[]> {
  listeners: Array<(...args: Args) => unknown> = [];
  addListener(listener: (...args: Args) => unknown) { this.listeners.push(listener); }
  emit(...args: Args) { for (const listener of this.listeners) listener(...args); }
}
interface NativeRequest { version: number; action: string; requestId: string; path: string; }
interface FakePort {
  onMessage: FakeEvent<[unknown]>; onDisconnect: FakeEvent<[]>;
  disconnected: boolean; disconnect(): void; postMessage(value: NativeRequest): void;
}
interface State {
  data: Record<string, unknown>; downloads: Map<number, chrome.downloads.DownloadItem>;
  permission: boolean; permissionRequests: number; connections: string[]; requests: NativeRequest[];
  native: (request: NativeRequest, port: FakePort) => void;
  notices: string[]; cleared: string[]; removed: number[]; removeFails: boolean;
  shown: number[]; root: string;
}
let state: State;
const changed = new FakeEvent<[chrome.downloads.DownloadDelta]>();
const ui: chrome.runtime.MessageSender = { id: 'test-extension', url: 'chrome-extension://test-extension/local/index.html' };
const content: chrome.runtime.MessageSender = { id: 'test-extension', url: 'https://site.test/player', tab: { id: 42 } as chrome.tabs.Tab };

function fileDirectory(path: string): unknown {
  return {
    async getDirectoryHandle(name: string) { await mkdir(join(path, name), { recursive: true }); return fileDirectory(join(path, name)); },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      const filePath = join(path, name);
      if (options?.create) await writeFile(filePath, new Uint8Array()); else await stat(filePath);
      return {
        async getFile() { return new File([await readFile(filePath)], name); },
        async createWritable() {
          const chunks: Uint8Array[] = [];
          return new WritableStream<Uint8Array>({ write(chunk) { chunks.push(chunk); }, async close() { await writeFile(filePath, Buffer.concat(chunks)); } });
        },
      };
    },
    async removeEntry(name: string) {
      try { await rm(join(path, name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DOMException('Missing test file', 'NotFoundError'); throw error; }
    },
    async *keys() { for (const name of await readdir(path)) yield name; },
  };
}
function installChrome() {
  const fake = {
    runtime: {
      id: 'test-extension', lastError: undefined,
      getURL: (path: string) => `chrome-extension://test-extension/${path}`,
      connectNative(host: string) {
        state.connections.push(host);
        const port: FakePort = {
          onMessage: new FakeEvent<[unknown]>(), onDisconnect: new FakeEvent<[]>(), disconnected: false,
          disconnect() { this.disconnected = true; },
          postMessage(request: NativeRequest) { state.requests.push(structuredClone(request)); queueMicrotask(() => state.native(request, port)); },
        };
        return port;
      },
      onMessage: new FakeEvent(), onInstalled: new FakeEvent(), onStartup: new FakeEvent(),
    },
    permissions: {
      async contains() { return state.permission; },
      async request() { state.permissionRequests++; return state.permission; },
    },
    storage: { local: {
      async get(key: string) { return structuredClone({ [key]: state.data[key] }); },
      async set(values: Record<string, unknown>) { Object.assign(state.data, structuredClone(values)); },
    } },
    downloads: {
      onChanged: changed,
      async search({ id }: { id: number }) { const item = state.downloads.get(id); return item ? [structuredClone(item)] : []; },
      async removeFile(id: number) {
        if (state.removeFails) throw new Error('Filesystem denied deletion');
        const item = state.downloads.get(id); assert.ok(item);
        await rm(item.filename, { force: true }); item.exists = false; state.removed.push(id);
      },
      async cancel(id: number) { const item = state.downloads.get(id); if (item) item.state = 'interrupted'; },
      show(id: number) { state.shown.push(id); },
    },
    notifications: {
      async create(id: string) { state.notices.push(id); return id; },
      async clear(id: string) { state.cleared.push(id); return true; },
      onClicked: new FakeEvent(), onButtonClicked: new FakeEvent(),
    },
    tabs: {
      async query() { return []; }, async create() { return {}; },
      async get() { return { id: 42, url: 'https://site.test/player' }; },
      onRemoved: new FakeEvent(), onUpdated: new FakeEvent(), onActivated: new FakeEvent(),
    },
    webRequest: { onHeadersReceived: new FakeEvent() },
    offscreen: { async hasDocument() { return false; } },
    sidePanel: { async setPanelBehavior() {} }, action: { async setPopup() {} },
    contextMenus: { create() {}, onClicked: new FakeEvent() }, commands: { onCommand: new FakeEvent() },
    extension: { inIncognitoContext: false },
  };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: fake });
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { async getDirectory() { return fileDirectory(state.root); } } });
}
function rows(): HistoryItem[] { return state.data[HISTORY_KEY] as HistoryItem[]; }
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (!await predicate()) {
    if (Date.now() >= deadline) assert.fail('Timed out waiting for the background security transition');
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}
let sequence = 1000;
async function seed(status: HistoryItem['state'] = 'downloading'): Promise<HistoryItem> {
  const downloadId = ++sequence; const id = crypto.randomUUID(); const filename = join(state.root, `download-${downloadId}.mp4`);
  await writeFile(filename, mediaBytes); await writeFile(join(state.root, `local-${id}.media`), mediaBytes);
  const item: HistoryItem = { id, url: 'https://media.test/clip.mp4', filename: 'clip.mp4', kind: 'file', createdAt: Date.now(), incognito: false, state: status, downloadId };
  if (status === 'review') item.security = { status: 'infected', token: crypto.randomUUID(), engine: 'Test scanner', threats: ['Eicar-Test-Signature'], sha256: digest, size: 16 };
  state.data[HISTORY_KEY] = [item];
  state.downloads.set(downloadId, { id: downloadId, filename, state: 'complete', danger: 'safe', exists: true, fileSize: 16 } as chrome.downloads.DownloadItem);
  return item;
}
function complete(item: HistoryItem) { changed.emit({ id: item.downloadId!, state: { current: 'complete' } }); }

test('local antivirus and background safety decisions', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'my-video-app-antivirus-tests-'));
  state = {
    root: temp, data: { [HISTORY_KEY]: [], [OFFER_KEY]: false }, downloads: new Map(), permission: true, permissionRequests: 0,
    connections: [], requests: [], native: (request, port) => port.onMessage.emit(nativeResponse(request.requestId)),
    notices: [], cleared: [], removed: [], removeFails: false, shown: [],
  };
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');
  installChrome();
  try {
    const { handleLocalMessage } = await import('../src/local/background.ts');
    // Let the MV3 startup recovery finish against the initial empty history.
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    const command = (type: string, value: Record<string, unknown> = {}, sender = ui) => handleLocalMessage({ scope: SCOPE, type, ...value }, sender);
    t.beforeEach(async () => {
      state.data = { [HISTORY_KEY]: [], [OFFER_KEY]: false }; state.downloads.clear();
      state.permission = true; state.permissionRequests = 0; state.connections = []; state.requests = [];
      state.native = (request, port) => port.onMessage.emit(nativeResponse(request.requestId));
      state.notices = []; state.cleared = []; state.removed = []; state.removeFails = false; state.shown = [];
    });
    t.afterEach(async () => {
      // Drain filesystem cleanup and lock callbacks before changing the shared Chrome test double.
      for (let i = 0; i < 3; i++) {
        await navigator.locks.request('my-video-app-history', async () => {});
        await navigator.locks.request('vdh-upscale-queue-v1', async () => {});
        await new Promise<void>(resolve => setTimeout(resolve, 5));
      }
    });

    await t.test('missing nativeMessaging permission leaves the file unverified without opening a native port', async () => {
      state.permission = false;
      assert.equal((await scanFile(join(temp, 'video.mp4'))).status, 'unavailable');
      assert.equal(state.connections.length, 0);
    });
    await t.test('scanner uses connectNative and one versioned request containing the selected local filename', async () => {
      const path = join(temp, 'video with spaces.mp4');
      const result = await scanFile(path);
      assert.equal(result.status, 'clean'); assert.deepEqual(state.connections, [ANTIVIRUS_HOST]);
      assert.equal(state.requests.length, 1); assert.equal(state.requests[0]!.action, 'scan');
      assert.equal(state.requests[0]!.version, 1); assert.equal(state.requests[0]!.path, path);
    });
    await t.test('mismatched native reply is an error and a disconnected host remains unavailable', async () => {
      state.native = (_, port) => port.onMessage.emit(nativeResponse('different-request'));
      assert.equal((await scanFile(join(temp, 'video.mp4'))).status, 'error');
      state.native = (_, port) => port.onDisconnect.emit();
      assert.equal((await scanFile(join(temp, 'video.mp4'))).status, 'unavailable');
    });
    await t.test('infected download enters review and cannot trigger automatic upscale or file opening', async () => {
      state.data[OFFER_KEY] = true;
      state.native = (request, port) => port.onMessage.emit(nativeResponse(request.requestId, 'infected'));
      const item = await seed(); complete(item);
      await until(() => rows()[0]?.state === 'review' && state.notices.includes(`my-video-app-security:${item.id}`));
      assert.equal(rows()[0]!.security?.status, 'infected');
      assert.ok(!state.notices.some(id => id.startsWith('vdh-upscale:')));
      assert.equal(state.data[JOBS_KEY], undefined);
      await assert.rejects(command('show-file', { id: item.id })); assert.equal(state.shown.length, 0);
    });
    await t.test('unavailable antivirus and malformed clean replies require review instead of succeeding', async () => {
      state.permission = false;
      const item = await seed(); complete(item);
      await until(() => rows()[0]?.state === 'review'); assert.equal(rows()[0]!.security?.status, 'unavailable');
      state.permission = true;
      state.native = (request, port) => port.onMessage.emit({ version: 1, requestId: request.requestId, status: 'clean', engine: 'Test scanner' });
      await command('security-rescan', { id: item.id, token: rows()[0]!.security!.token });
      await until(() => rows()[0]?.state === 'review' && rows()[0]?.security?.status === 'error');
      assert.ok(!state.notices.some(id => id.startsWith('vdh-upscale:')));
    });
    await t.test('a verifiable clean scan completes, while a file-size mismatch still requires review', async () => {
      const item = await seed(); complete(item);
      await until(() => rows()[0]?.state === 'complete'); assert.equal(rows()[0]!.security?.status, 'clean');
      const mismatch = await seed(); state.downloads.get(mismatch.downloadId!)!.fileSize = 17; complete(mismatch);
      await until(() => rows()[0]?.id === mismatch.id && rows()[0]?.state === 'review');
      assert.equal(rows()[0]!.security?.status, 'error');
    });
    await t.test('automatic upscale is offered only after a completed clean scan', async () => {
      state.data[OFFER_KEY] = true;
      let reply: (() => void) | undefined;
      state.native = (request, port) => { reply = () => port.onMessage.emit(nativeResponse(request.requestId)); };
      const item = await seed(); complete(item);
      await until(() => !!reply && rows()[0]?.state === 'scanning');
      assert.equal(state.data[JOBS_KEY], undefined); assert.equal(state.notices.length, 0);
      reply!();
      await until(() => state.notices.some(id => id.startsWith('vdh-upscale:')));
      const jobs = Reflect.get(state.data, JOBS_KEY) as Array<{ id: string; downloadId: number }>;
      assert.equal(jobs.length, 1); assert.equal(jobs[0]!.downloadId, item.downloadId);
      assert.equal(rows()[0]!.state, 'complete');
      assert.equal((await stat(join(temp, DIRECTORY, jobs[0]!.id))).size, 16);
    });
    await t.test('retained upscale bytes must match the size and SHA256 of the scanned disk file', async () => {
      state.data[OFFER_KEY] = true;
      const differentHash = Buffer.from(mediaBytes); differentHash[differentHash.length - 1] = 1;
      for (const altered of [differentHash, Buffer.concat([mediaBytes, Buffer.from([0])])]) {
        const item = await seed(); const internalFilename = join(temp, `local-${item.id}.media`);
        await writeFile(internalFilename, altered); complete(item);
        // Disposing the internal input happens after offerUpscale has either accepted or rejected it.
        await until(async () => { try { await stat(internalFilename); return false; } catch { return true; } });
        assert.equal(rows()[0]!.state, 'complete'); assert.equal(rows()[0]!.security?.sha256, digest);
        assert.equal(state.data[JOBS_KEY], undefined);
        assert.ok(!state.notices.some(id => id.startsWith('vdh-upscale:')));
        assert.equal(createHash('sha256').update(await readFile(state.downloads.get(item.downloadId!)!.filename)).digest('hex'), digest);
      }
    });
    await t.test('a browser record disappearing during scanning becomes review instead of remaining stuck scanning', async () => {
      state.data[OFFER_KEY] = true;
      let reply: (() => void) | undefined;
      state.native = (request, port) => { reply = () => port.onMessage.emit(nativeResponse(request.requestId)); };
      const item = await seed(); complete(item);
      await until(() => !!reply && rows()[0]?.state === 'scanning');
      state.downloads.delete(item.downloadId!); reply!();
      await until(() => rows()[0]?.state === 'review' && state.notices.includes(`my-video-app-security:${item.id}`));
      assert.equal(rows()[0]!.security?.status, 'error');
      assert.equal(state.data[JOBS_KEY], undefined); assert.ok(!state.notices.some(id => id.startsWith('vdh-upscale:')));
      const token = rows()[0]!.security!.token;
      for (const type of ['security-delete', 'security-rescan', 'security-keep']) await assert.rejects(command(type, { id: item.id, token }));
      assert.equal(rows()[0]!.state, 'review');
      await command('security-keep', { id: item.id, token, confirmed: true });
      assert.equal(rows()[0]!.state, 'complete'); assert.equal(rows()[0]!.security?.status, 'error');
      assert.equal(rows()[0]!.security?.decision, 'keep');
      assert.equal(state.data[JOBS_KEY], undefined); assert.ok(!state.notices.some(id => id.startsWith('vdh-upscale:')));
    });
    await t.test('a Chrome warning arriving during a native clean scan wins over that clean response', async () => {
      state.data[OFFER_KEY] = true;
      let reply: (() => void) | undefined;
      state.native = (request, port) => { reply = () => port.onMessage.emit(nativeResponse(request.requestId)); };
      const item = await seed(); complete(item);
      await until(() => !!reply && rows()[0]?.state === 'scanning');
      state.downloads.get(item.downloadId!)!.danger = 'content';
      changed.emit({ id: item.downloadId!, danger: { current: 'content' } });
      reply!();
      await until(() => rows()[0]?.state === 'review' && rows()[0]?.security?.status === 'chrome-warning');
      assert.equal(state.data[JOBS_KEY], undefined);
      assert.ok(!state.notices.some(id => id.startsWith('vdh-upscale:')));
    });
    await t.test('keeping a detected file requires explicit confirmation and the current review token', async () => {
      state.data[OFFER_KEY] = true;
      const item = await seed('review'); const token = item.security!.token;
      await assert.rejects(command('security-keep', { id: item.id, token }));
      await assert.rejects(command('security-keep', { id: item.id, token, confirmed: 'true' }));
      await assert.rejects(command('security-keep', { id: item.id, token: crypto.randomUUID(), confirmed: true }));
      assert.equal(rows()[0]!.state, 'review');
      await command('security-keep', { id: item.id, token, confirmed: true });
      assert.equal(rows()[0]!.state, 'complete'); assert.equal(rows()[0]!.security?.decision, 'keep');
      assert.equal(rows()[0]!.security?.status, 'infected');
      assert.ok(!state.notices.some(id => id.startsWith('vdh-upscale:'))); assert.equal(state.requests.length, 0);
      await assert.rejects(command('security-keep', { id: item.id, token, confirmed: true }));
    });
    await t.test('failed deletion retains review with a fresh token; successful deletion removes the actual browser file', async () => {
      const item = await seed('review'); const token = item.security!.token;
      state.removeFails = true;
      await assert.rejects(command('security-delete', { id: item.id, token }));
      assert.equal(rows()[0]!.state, 'review'); assert.notEqual(rows()[0]!.security?.token, token);
      assert.equal(state.downloads.get(item.downloadId!)!.exists, true);
      await assert.rejects(command('security-delete', { id: item.id, token }));
      state.removeFails = false;
      const filename = state.downloads.get(item.downloadId!)!.filename;
      await command('security-delete', { id: item.id, token: rows()[0]!.security!.token });
      assert.equal(rows()[0]!.state, 'discarded'); assert.equal(rows()[0]!.security?.decision, 'delete');
      assert.deepEqual(state.removed, [item.downloadId]); await assert.rejects(stat(filename));
    });
    await t.test('rescan takes the current Chrome filename and ignores a caller-supplied path', async () => {
      const item = await seed('review'); const browserFilename = state.downloads.get(item.downloadId!)!.filename;
      await command('security-rescan', { id: item.id, token: item.security!.token, path: '/other/private/file' });
      await until(() => rows()[0]?.state === 'complete');
      assert.equal(state.requests.length, 1); assert.equal(state.requests[0]!.path, browserFilename);
    });
    await t.test('late Chrome danger revokes retained upscale jobs and their files', async () => {
      const item = await seed('complete'); const jobId = crypto.randomUUID();
      const directory = join(temp, DIRECTORY); await mkdir(directory, { recursive: true });
      await writeFile(join(directory, jobId), Buffer.alloc(16));
      state.data[JOBS_KEY] = [{ id: jobId, filename: 'clip.mp4', size: 16, createdAt: Date.now(), downloadId: item.downloadId }];
      state.downloads.get(item.downloadId!)!.danger = 'content';
      changed.emit({ id: item.downloadId!, danger: { current: 'content' } });
      await until(() => rows()[0]?.state === 'review' && state.cleared.includes(`vdh-upscale:${jobId}`));
      await until(async () => { try { await stat(join(directory, jobId)); return false; } catch { return true; } });
      assert.equal(rows()[0]!.security?.status, 'chrome-warning'); assert.deepEqual(state.data[JOBS_KEY], []);
      await assert.rejects(command('security-keep', { id: item.id, token: rows()[0]!.security!.token, confirmed: true }));
    });
    await t.test('website senders cannot connect, scan arbitrary paths or decide security outcomes', async () => {
      const item = await seed('review');
      for (const type of ['security-connect', 'security-rescan', 'security-delete', 'security-keep', 'review-chrome']) {
        await assert.rejects(command(type, { id: item.id, token: item.security!.token, confirmed: true, path: '/private/file' }, content), /확장 화면/);
      }
      assert.equal(state.permissionRequests, 0); assert.equal(state.connections.length, 0);
      assert.equal(state.requests.length, 0); assert.equal(state.removed.length, 0); assert.equal(rows()[0]!.state, 'review');
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
    if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome); else Reflect.deleteProperty(globalThis, 'chrome');
    if (originalStorage) Object.defineProperty(navigator, 'storage', originalStorage); else Reflect.deleteProperty(navigator, 'storage');
  }
});
