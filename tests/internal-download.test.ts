import test from 'node:test';
import assert from 'node:assert/strict';
import { appStorage } from '../src/data/database.ts';
import { HISTORY_KEY, SCOPE, OFFSCREEN_SCOPE, isHistory, type HistoryItem } from '../src/local/model.ts';
import { internalScanResponse, scanResponse, combineInternalScans, readinessResponse } from '../src/local/antivirus.ts';
import type { InternalScanResult } from '../src/security/internal-scan.ts';
import { OFFER_KEY, JOBS_KEY } from '../src/upscale/policy.ts';

const digest = 'a'.repeat(64);
const noSignals = (): InternalScanResult => ({ version: 1, engine: 'builtin-static-v1', status: 'no-signals', scannedBytes: 16, complete: true, findings: [] });
const suspicious = (): InternalScanResult => ({ ...noSignals(), status: 'suspicious', findings: [{ id: 'eicar-test-marker', severity: 'high', message: '무해한 백신 시험 표식을 발견했습니다.', offset: 8 }] });

test('internal reports validate bounded findings, coverage and actual native file identity', () => {
  assert.deepEqual(internalScanResponse(noSignals(), 16), noSignals());
  for (const value of [null, {}, { ...noSignals(), version: 2 }, { ...noSignals(), status: 'clean' }, { ...noSignals(), complete: false },
    { ...noSignals(), findings: suspicious().findings }, { ...noSignals(), status: 'incomplete', complete: false, findings: [{ id: 'embedded-pe', severity: 'warning', message: 'Risk was mislabeled as incomplete' }] }, { ...suspicious(), findings: [] }, { ...suspicious(), scannedBytes: 0 },
    { ...suspicious(), findings: Array(17).fill(suspicious().findings[0]) }, { ...suspicious(), findings: [{ ...suspicious().findings[0], offset: 16 }] },
    { ...suspicious(), findings: [{ ...suspicious().findings[0], message: 'x'.repeat(501) }] }]) assert.throws(() => internalScanResponse(value));
  assert.throws(() => internalScanResponse(noSignals(), 15));
  const response = { version: 1, requestId: 'id', status: 'unavailable', sha256: digest, size: 16, internalScan: suspicious() };
  assert.deepEqual(scanResponse(response, 'id').internalScan, suspicious());
  assert.throws(() => scanResponse({ ...response, sha256: undefined }, 'id'));
  assert.throws(() => scanResponse({ ...response, size: undefined }, 'id'));
});

test('suspicious reports require a risk finding while retaining partial scan coverage notices', () => {
  const coverage = ['analysis-limit', 'empty-input', 'unsupported-format', 'partial-input'].map(id => ({ id, severity: 'warning' as const, message: 'Limited coverage' }));
  for (const findings of [...coverage.map(finding => [finding]), coverage]) {
    const invalid = { ...suspicious(), complete: false, findings };
    assert.throws(() => internalScanResponse(invalid));
    assert.throws(() => scanResponse({ version: 1, requestId: 'id', status: 'unavailable', sha256: digest, size: 16, internalScan: invalid }, 'id'));
  }
  const mixed = { ...suspicious(), complete: false, findings: [...coverage, ...suspicious().findings] };
  assert.deepEqual(internalScanResponse(mixed, 16), mixed);
});

test('risk evidence survives later no-signal reports and malformed stored history is not trusted', () => {
  assert.equal(combineInternalScans(suspicious(), noSignals()).status, 'suspicious');
  assert.equal(combineInternalScans(noSignals(), suspicious()).status, 'suspicious');
  const row: HistoryItem = { id: crypto.randomUUID(), url: 'https://media.test/a.mp4', filename: 'a.mp4', kind: 'file', state: 'review', createdAt: Date.now(), incognito: false, internalScan: suspicious(), internalScanSha256: digest, internalScanSize: 16 };
  assert(isHistory(row));
  assert(!isHistory({ ...row, internalScan: { ...noSignals(), complete: false } }));
  assert(!isHistory({ ...row, internalScanSha256: 'not-a-hash' }));
  assert(!isHistory({ ...row, internalScanSize: 8 }));
  const old = { ...row }; delete old.internalScan; delete old.internalScanSha256; delete old.internalScanSize;
  assert(isHistory(old));
});

test('readiness reports internal helper availability independently from the external antivirus', () => {
  const reply = { version: 1, requestId: 'status-id', status: 'unavailable', message: 'No external antivirus' };
  const available = readinessResponse({ ...reply, internalAvailable: true }, 'status-id');
  assert.equal(available.status, 'unavailable');
  assert.equal(available.engine, undefined);
  assert.equal(available.internalAvailable, true);
  assert.equal(readinessResponse({ ...reply, internalAvailable: false }, 'status-id').internalAvailable, false);
  assert.equal(Object.hasOwn(readinessResponse(reply, 'status-id'), 'internalAvailable'), false);
  for (const internalAvailable of [null, 0, 1, 'true', 'false', [], {}]) {
    assert.throws(() => readinessResponse({ ...reply, internalAvailable }, 'status-id'));
  }
  assert.throws(() => readinessResponse({ ...reply, internalAvailable: true }, 'wrong-request'));
});

class Events { addListener(_listener: (...args: never[]) => unknown) {} }
interface State {
  data: Record<string, unknown>; prepared: Record<string, unknown>; native: Record<string, unknown>; readiness: Record<string, unknown>;
  permission: boolean; hostMissing: boolean; nativeActions: string[];
  download?: chrome.downloads.DownloadItem; downloads: number; sourceReads: number; notices: string[]; disposed: string[]; nativeCalls: number; lateDanger: boolean;
}
const fresh = (): State => ({ data: { [HISTORY_KEY]: [], [JOBS_KEY]: [], [OFFER_KEY]: true },
  prepared: { ok: true, url: 'blob:chrome-extension://builtin-test/prepared', extension: 'mp4', mime: 'video/mp4', internalScan: noSignals(), internalScanSha256: digest, internalScanSize: 16 },
  native: { status: 'clean', engine: 'AV test double', sha256: digest, size: 16, internalScan: noSignals() },
  readiness: { status: 'ready', engine: 'AV test double' }, permission: true, hostMissing: false, nativeActions: [],
  downloads: 0, sourceReads: 0, notices: [], disposed: [], nativeCalls: 0, lateDanger: false });
let state = fresh();
const ui = { id: 'builtin-test', url: 'chrome-extension://builtin-test/local/index.html' };
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > deadline) assert.fail('Timed out waiting for internal download review'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const row = () => (state.data[HISTORY_KEY] as HistoryItem[])[0]!;

test('internal signals remain a separate, fail-closed download safety gate', async t => {
  const oldChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const oldStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');
  const oldApp = { ...appStorage };
  const event = () => new Events();
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    extension: { inIncognitoContext: false }, permissions: { async contains() { return state.permission; } },
    runtime: { id: 'builtin-test', getURL: (value: string) => `chrome-extension://builtin-test/${value}`, onMessage: event(), onInstalled: event(), onStartup: event(),
      async sendMessage(value: { scope: string; type: string; id: string }) { if (value.scope === OFFSCREEN_SCOPE && value.type === 'prepare') return structuredClone(state.prepared); if (value.type === 'dispose') state.disposed.push(value.id); return { ok: true }; },
      connectNative() {
        if (state.hostMissing) throw new Error('Native host was not found');
        state.nativeCalls++; let listener: ((value: unknown) => void) | undefined;
        return { onMessage: { addListener(fn: (value: unknown) => void) { listener = fn; } }, onDisconnect: event(), disconnect() {},
          postMessage(request: { requestId: string; action: string }) { state.nativeActions.push(request.action); queueMicrotask(() => { if (state.lateDanger) state.download!.danger = 'content'; listener?.({ version: 1, requestId: request.requestId, ...structuredClone(request.action === 'status' ? state.readiness : state.native) }); }); } };
      },
    },
    downloads: { onChanged: event(), async download() { state.downloads++; state.download = { id: 771, state: 'complete', danger: 'safe', exists: true, filename: '/downloads/a.mp4', fileSize: 16 } as chrome.downloads.DownloadItem; return 771; },
      async search() { return state.download ? [structuredClone(state.download)] : []; }, async cancel() { throw new Error('Already complete'); }, async removeFile() { state.download!.exists = false; } },
    notifications: { onClicked: event(), onButtonClicked: event(), async clear() { return true; }, async create(_id: string, options: chrome.notifications.NotificationOptions) { state.notices.push(options.message!); return 'notice'; } },
    tabs: { onRemoved: event(), onUpdated: event(), onActivated: event() }, webRequest: { onHeadersReceived: event() }, commands: { onCommand: event() },
    offscreen: { async hasDocument() { return true; } }, contextMenus: { onClicked: event() }, sidePanel: { async setPanelBehavior() {} }, action: { async setPopup() {} },
  } });
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { async getDirectory() { return {
    async removeEntry(name: string) { state.disposed.push(name); }, async getFileHandle() { state.sourceReads++; throw new Error('No auto-processing source supplied in this gate test'); },
  }; } } });
  Object.assign(appStorage, {
    async ready() { throw new Error('Skip unrelated startup reconciliation'); },
    async status() { return { recoveryCount: 0 }; },
    async get(keys: string | string[]) { return structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, state.data[key]]))); },
    async set(values: Record<string, unknown>) { Object.assign(state.data, structuredClone(values)); },
  });
  try {
    const { handleLocalMessage } = await import('../src/local/background.ts');
    const start = () => handleLocalMessage({ scope: SCOPE, type: 'download-url', url: 'https://media.test/a.mp4' }, ui);
    await t.test('prepared app risk remains review even when the external antivirus reports clean', async () => {
      state = fresh(); state.prepared.internalScan = suspicious();
      await start(); await until(() => row()?.state === 'review' && state.notices.length > 0);
      assert.equal(row().security?.status, 'clean'); assert.equal(row().internalScan?.status, 'suspicious');
      assert.equal(state.downloads, 1); assert.equal(state.sourceReads, 0); assert.match(state.notices[0]!, /내부 검사/);
      const firstToken = row().security!.token;
      await handleLocalMessage({ scope: SCOPE, type: 'security-rescan', id: row().id, token: firstToken }, ui);
      await until(() => row()?.state === 'review' && row().security!.token !== firstToken && state.nativeCalls === 2);
      assert.equal(row().internalScan?.status, 'suspicious'); assert.equal(state.sourceReads, 0);
      await assert.rejects(handleLocalMessage({ scope: SCOPE, type: 'security-keep', id: row().id, token: row().security!.token }, ui), /확인/);
      await handleLocalMessage({ scope: SCOPE, type: 'security-keep', id: row().id, token: row().security!.token, confirmed: true }, ui);
      assert.equal(row().state, 'complete'); assert.equal(row().security?.decision, 'keep'); assert.equal(state.sourceReads, 0);
    });
    await t.test('internal no-signals never turns an unavailable antivirus into a clean verdict', async () => {
      state = fresh(); state.native.status = 'unavailable';
      await start(); await until(() => row()?.state === 'review' && state.notices.length > 0);
      assert.equal(row().security?.status, 'unavailable'); assert.equal(row().internalScan?.status, 'no-signals'); assert.equal(state.sourceReads, 0);
    });
    await t.test('manual connect resumes internal-only scans while keeping the unavailable external verdict', async () => {
      state = fresh(); state.native.status = 'unavailable';
      await start(); await until(() => row()?.state === 'review' && state.notices.length > 0);
      state.readiness = { status: 'unavailable', internalAvailable: true, message: 'No external antivirus' };
      state.native.internalScan = suspicious();
      const firstToken = row().security!.token;
      const reply = await handleLocalMessage({ scope: SCOPE, type: 'security-connect' }, ui) as { antivirus: { status: string; internalAvailable: boolean } };
      assert.equal(reply.antivirus.status, 'unavailable'); assert.equal(reply.antivirus.internalAvailable, true);
      await until(() => row()?.state === 'review' && row().security!.token !== firstToken && row().internalScan?.status === 'suspicious');
      assert.deepEqual(state.nativeActions, ['scan', 'status', 'scan']);
      assert.equal(row().security?.status, 'unavailable'); assert.equal(state.sourceReads, 0);
      const secondToken = row().security!.token;
      await handleLocalMessage({ scope: SCOPE, type: 'security-rescan', id: row().id, token: secondToken }, ui);
      await until(() => row()?.state === 'review' && row().security!.token !== secondToken);
      assert.deepEqual(state.nativeActions, ['scan', 'status', 'scan', 'scan']);
      assert.equal(row().security?.status, 'unavailable'); assert.equal(state.sourceReads, 0);
    });
    await t.test('a status-only check never resumes a pending file even with an internal helper', async () => {
      state = fresh(); state.native.status = 'unavailable';
      await start(); await until(() => row()?.state === 'review' && state.notices.length > 0);
      state.readiness = { status: 'unavailable', internalAvailable: true };
      const token = row().security!.token;
      await handleLocalMessage({ scope: SCOPE, type: 'antivirus-status' }, ui);
      assert.deepEqual(state.nativeActions, ['scan', 'status']);
      assert.equal(row().security!.token, token); assert.equal(row().state, 'review');
    });
    await t.test('manual connect does not resume files for absent, false or malformed internal availability', async () => {
      for (const readiness of [{ status: 'unavailable' }, { status: 'unavailable', internalAvailable: false }, { status: 'unavailable', internalAvailable: 'true' }]) {
        state = fresh(); state.native.status = 'unavailable';
        await start(); await until(() => row()?.state === 'review' && state.notices.length > 0);
        state.readiness = readiness;
        const token = row().security!.token;
        const reply = await handleLocalMessage({ scope: SCOPE, type: 'security-connect' }, ui) as { antivirus: { status: string; internalAvailable?: boolean } };
        assert.notEqual(reply.antivirus.status, 'ready'); assert.notEqual(reply.antivirus.internalAvailable, true);
        assert.deepEqual(state.nativeActions, ['scan', 'status']);
        assert.equal(row().security!.token, token); assert.equal(row().state, 'review');
      }
    });
    await t.test('missing permission or host cannot claim internal availability or resume pending files', async () => {
      for (const missing of ['permission', 'host']) {
        state = fresh(); state.native.status = 'unavailable';
        await start(); await until(() => row()?.state === 'review' && state.notices.length > 0);
        const token = row().security!.token;
        if (missing === 'permission') state.permission = false; else state.hostMissing = true;
        if (missing === 'permission') await assert.rejects(handleLocalMessage({ scope: SCOPE, type: 'security-connect' }, ui), /권한/);
        else {
          const reply = await handleLocalMessage({ scope: SCOPE, type: 'security-connect' }, ui) as { antivirus: { status: string; internalAvailable?: boolean } };
          assert.equal(reply.antivirus.status, 'unavailable'); assert.equal(reply.antivirus.internalAvailable, undefined);
        }
        assert.deepEqual(state.nativeActions, ['scan']);
        assert.equal(row().security!.token, token); assert.equal(row().state, 'review');
      }
    });
    await t.test('a verified native internal report supplies risk coverage when browser metadata is absent', async () => {
      state = fresh(); delete state.prepared.internalScan; delete state.prepared.internalScanSha256; delete state.prepared.internalScanSize;
      state.native.internalScan = suspicious();
      await start(); await until(() => row()?.state === 'review' && state.notices.length > 0);
      assert.equal(row().security?.status, 'clean'); assert.equal(row().internalScan?.status, 'suspicious'); assert.equal(row().internalScanSha256, digest); assert.equal(state.sourceReads, 0);
    });
    await t.test('malformed prepared metadata cannot trigger a silent direct-download fallback', async () => {
      state = fresh(); state.prepared.internalScan = { ...noSignals(), complete: false };
      await start(); await until(() => row()?.state === 'error');
      assert.equal(state.downloads, 0); assert.equal(state.nativeCalls, 0); assert.equal(row().internalScan?.status, 'incomplete');
    });
    await t.test('a scan refusal from preparation never silently downloads the original URL', async () => {
      state = fresh(); state.prepared = { ok: false, internalRisk: true, internalScan: suspicious(), error: '내부 검사 위험 신호로 처리를 중단했습니다.' };
      await start(); await until(() => row()?.state === 'error');
      assert.equal(state.downloads, 0); assert.equal(row().internalScan?.status, 'suspicious'); assert.equal(state.sourceReads, 0);
    });
    await t.test('saved-file hash mismatch invalidates the prepared no-signal evidence', async () => {
      state = fresh(); state.native.sha256 = 'b'.repeat(64);
      await start(); await until(() => row()?.state === 'review' && state.notices.length > 0);
      assert.equal(row().security?.status, 'error'); assert.equal(row().internalScan?.status, 'incomplete'); assert.equal(state.sourceReads, 0);
    });
    await t.test('Chrome warnings retain priority and do not erase app findings', async () => {
      state = fresh(); state.prepared.internalScan = suspicious(); state.lateDanger = true;
      await start(); await until(() => row()?.security?.status === 'chrome-warning' && state.notices.length > 0);
      assert.equal(row().state, 'review'); assert.equal(row().internalScan?.status, 'suspicious'); assert.equal(state.sourceReads, 0);
    });
    await t.test('normal clean downloads still reach the optional automatic-processing gate', async () => {
      state = fresh();
      await start(); await until(() => row()?.state === 'complete' && state.sourceReads === 1);
      assert.equal(row().security?.status, 'clean'); assert.equal(row().internalScan?.status, 'no-signals');
    });
  } finally {
    await navigator.locks.request('my-video-app-history', async () => {});
    await navigator.locks.request('vdh-upscale-queue-v1', async () => {});
    Object.assign(appStorage, oldApp);
    if (oldChrome) Object.defineProperty(globalThis, 'chrome', oldChrome); else Reflect.deleteProperty(globalThis, 'chrome');
    if (oldStorage) Object.defineProperty(navigator, 'storage', oldStorage); else Reflect.deleteProperty(navigator, 'storage');
  }
});
