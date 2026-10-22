import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ANTIVIRUS_HOST, cancelAntivirusRequests, probeAntivirus, scanFile } from '../src/local/antivirus.ts';

interface NativeRequest { version: number; action: string; requestId: string; path?: string; }
class FakeEvent<Args extends unknown[]> {
  listeners: Array<(...args: Args) => void> = [];
  addListener(listener: (...args: Args) => void) { this.listeners.push(listener); }
  emit(...args: Args) { for (const listener of this.listeners) listener(...args); }
}
class FakePort {
  onMessage = new FakeEvent<[unknown]>();
  onDisconnect = new FakeEvent<[]>();
  requests: NativeRequest[] = [];
  disconnects = 0;
  postMessage(request: NativeRequest) { this.requests.push(request); }
  disconnect() { this.disconnects++; this.onDisconnect.emit(); }
}
/** Wait for the observable native request without advancing its mocked deadline. */
async function posted(ports: FakePort[], index = 0): Promise<FakePort> {
  for (let turn = 0; turn < 32; turn++) {
    const port = ports[index];
    if (port?.requests.length) return port;
    await Promise.resolve();
  }
  assert.fail('Native request was not posted after bounded microtask delivery');
}
function installNative(t: TestContext) {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  const ports: FakePort[] = [];
  const calls: string[] = [];
  const state = { permission: true, connectThrows: false, postThrows: false };
  const runtime = {
    lastError: undefined as { message: string } | undefined,
    connectNative(host: string) {
      assert.equal(host, ANTIVIRUS_HOST); calls.push('connect');
      if (state.connectThrows) throw new Error('No native host');
      const port = new FakePort();
      if (state.postThrows) port.postMessage = () => { throw new Error('Port closed'); };
      ports.push(port); return port;
    },
  };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    runtime,
    permissions: { async contains(value: unknown) {
      assert.deepEqual(value, { permissions: ['nativeMessaging'] }); calls.push('permission'); return state.permission;
    } },
  } });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    async request(name: string, callback: () => Promise<unknown>) {
      assert.equal(name, 'my-video-app-antivirus'); calls.push('lock'); return callback();
    },
  } });
  t.after(() => {
    cancelAntivirusRequests();
    if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome); else Reflect.deleteProperty(globalThis, 'chrome');
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks); else Reflect.deleteProperty(navigator, 'locks');
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return { ports, calls, state, runtime };
}
const protocols = [
  {
    action: 'status', start: () => probeAntivirus(), timeout: 60_000,
    timeoutMessage: '백신 연결 상태 확인이 제한 시간을 초과했습니다.',
    malformedMessage: '백신 도우미의 상태 응답이 올바르지 않습니다. 최신 도우미로 다시 설치하세요.',
    disconnectedMessage: '로컬 백신 도우미 연결이 종료됐습니다. 설치 상태를 확인하세요.',
    response: (requestId: string) => ({ version: 1, requestId, status: 'ready', engine: 'Test scanner' }),
  },
  {
    action: 'scan', start: () => scanFile('/downloads/video.mp4'), timeout: 240_000,
    timeoutMessage: '백신 검사가 제한 시간을 초과했습니다. 검사되지 않은 파일입니다.',
    malformedMessage: '백신 응답이 올바르지 않아 검사 완료로 처리하지 않았습니다.',
    disconnectedMessage: '로컬 백신 도우미가 연결을 종료했습니다. 설치 상태를 확인하세요.',
    response: (requestId: string) => ({ version: 1, requestId, status: 'clean', engine: 'Test scanner', sha256: 'a'.repeat(64), size: 16 }),
  },
];

for (const protocol of protocols) {
  test(`${protocol.action} times out at its deadline and ignores late replies and reentrant disconnects`, async t => {
    const { ports, calls } = installNative(t);
    const pending = protocol.start();
    let resolved = false;
    void pending.then(() => { resolved = true; });
    const port = await posted(ports); const request = port.requests[0]!;
    assert.deepEqual(calls, protocol.action === 'scan' ? ['lock', 'permission', 'connect'] : ['permission', 'connect']);
    assert.deepEqual(request, { version: 1, action: protocol.action, requestId: request.requestId,
      ...(protocol.action === 'scan' ? { path: '/downloads/video.mp4' } : {}) });
    assert.match(request.requestId, /^[0-9a-f-]{36}$/);
    t.mock.timers.tick(protocol.timeout - 1);
    await Promise.resolve(); assert.equal(resolved, false);
    t.mock.timers.tick(1);
    const result = await pending;
    assert.equal(result.status, 'error'); assert.equal(result.message, protocol.timeoutMessage);
    assert.equal(port.disconnects, 1);
    if (protocol.action === 'status') assert.equal(typeof result.checkedAt, 'number');
    else assert.equal(result.checkedAt, undefined);
    port.onMessage.emit(protocol.response(request.requestId));
    port.onMessage.emit(null); port.onDisconnect.emit();
    t.mock.timers.tick(240_000);
    assert.equal(await pending, result); assert.equal(port.disconnects, 1);
  });

  test(`${protocol.action} rejects malformed replies once even when cleanup disconnects synchronously`, async t => {
    const { ports } = installNative(t);
    const pending = protocol.start();
    const port = await posted(ports); const request = port.requests[0]!;
    port.onMessage.emit({ ...protocol.response(request.requestId), requestId: 'another-request' });
    const result = await pending;
    assert.equal(result.status, 'error'); assert.equal(result.message, protocol.malformedMessage);
    port.onMessage.emit(protocol.response(request.requestId));
    t.mock.timers.tick(protocol.timeout);
    assert.equal(await pending, result); assert.equal(port.disconnects, 1);
  });

  test(`${protocol.action} keeps a valid response when cleanup disconnects synchronously`, async t => {
    const { ports } = installNative(t);
    const pending = protocol.start();
    const port = await posted(ports); const request = port.requests[0]!;
    port.onMessage.emit(protocol.response(request.requestId));
    const result = await pending;
    assert.equal(result.status, protocol.action === 'status' ? 'ready' : 'clean');
    port.onMessage.emit(null); t.mock.timers.tick(protocol.timeout);
    assert.equal(await pending, result); assert.equal(port.disconnects, 1);
  });

  test(`${protocol.action} reports disconnect details and limits native error text`, async t => {
    const { ports, runtime } = installNative(t);
    for (const message of [undefined, 'x'.repeat(400)]) {
      const index = ports.length;
      const pending = protocol.start();
      const port = await posted(ports, index);
      runtime.lastError = message === undefined ? undefined : { message };
      port.onDisconnect.emit(); runtime.lastError = undefined;
      const result = await pending;
      assert.equal(result.status, 'unavailable');
      assert.equal(result.message, message ? `로컬 백신 연결 실패: ${'x'.repeat(300)}` : protocol.disconnectedMessage);
      assert.equal(port.disconnects, 1);
      t.mock.timers.tick(protocol.timeout); assert.equal(port.disconnects, 1);
    }
  });

  test(`${protocol.action} checks permission before connecting and handles connection setup failures`, async t => {
    const { ports, calls, state } = installNative(t);
    state.permission = false;
    const denied = await protocol.start();
    assert.equal(denied.status, 'unavailable');
    assert.equal(denied.message, '로컬 백신 연결 권한이 없습니다. 백신 도우미 설치 후 ‘로컬 백신 연결’을 눌러 주세요.');
    assert.deepEqual(calls, protocol.action === 'scan' ? ['lock', 'permission'] : ['permission']);
    assert.equal(ports.length, 0);
    state.permission = true;
    for (const failure of ['connectThrows', 'postThrows'] as const) {
      state[failure] = true;
      const result = await protocol.start();
      assert.equal(result.status, 'unavailable');
      assert.equal(result.message, '로컬 백신 도우미에 연결할 수 없습니다. 설치와 권한을 확인하세요.');
      state[failure] = false;
    }
    assert.equal(ports[0]!.disconnects, 1);
  });
}

test('readiness shares the pending promise and starts a new request after a timeout', async t => {
  const { ports, calls } = installNative(t);
  const first = probeAntivirus();
  assert.equal(probeAntivirus(), first);
  await posted(ports);
  assert.deepEqual(calls, ['permission', 'connect']);
  t.mock.timers.tick(60_000); await first;
  const next = probeAntivirus(); assert.notEqual(next, first);
  assert.equal(probeAntivirus(), next);
  await posted(ports, 1);
  assert.equal(ports.length, 2);
  const port = ports[1]!;
  port.onMessage.emit({ version: 1, requestId: port.requests[0]!.requestId, status: 'ready', engine: 'Test scanner' });
  assert.equal((await next).status, 'ready');
});
