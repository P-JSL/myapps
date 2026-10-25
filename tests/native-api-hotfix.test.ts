/** Focused regression only: Chrome APIs/native ports are explicit test doubles. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { YOUTUBE_HOST, probeYouTube, resolveYouTube } from '../src/local/youtube.ts';

const VIDEO_ID = 'AbC_def-123';
const SOURCE = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const OPTIONS = { quality: 'highest' as const, output: 'original' as const };

class Events<T extends unknown[]> {
  listeners = new Set<(...args: T) => void>();
  addListener(listener: (...args: T) => void) { this.listeners.add(listener); }
  removeListener(listener: (...args: T) => void) { this.listeners.delete(listener); }
  emit(...args: T) { for (const listener of [...this.listeners]) listener(...args); }
}
interface Port {
  onMessage: Events<[unknown]>;
  onDisconnect: Events<[]>;
  disconnects: number;
  disconnect(): void;
  postMessage(message: Record<string, unknown>): void;
}
interface State {
  hosts: string[];
  requests: Record<string, unknown>[];
  ports: Port[];
}
async function withNativeAPI(available: boolean, run: (state: State) => Promise<void>) {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const originalAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
  const state: State = { hosts: [], requests: [], ports: [] };
  const runtime: Record<string, unknown> = {};
  if (available) runtime.connectNative = (host: string) => {
    state.hosts.push(host);
    const port: Port = {
      onMessage: new Events(), onDisconnect: new Events(), disconnects: 0,
      disconnect() { this.disconnects++; this.onDisconnect.emit(); },
      postMessage(message) {
        state.requests.push(message);
        queueMicrotask(() => port.onMessage.emit(message.action === 'status'
          ? { version: 1, requestId: message.requestId, status: 'ready', message: 'Explicit native test double',
            ytDlpVersion: '2026.10.21', runtime: 'Deno 2.9.8' }
          : { version: 1, requestId: message.requestId, status: 'resolved', videoId: VIDEO_ID,
            title: 'Startup native API fixture', duration: 1, tracks: [
              { url: 'https://rr1-hotfix.googlevideo.com/videoplayback?id=video', kind: 'video', mime: 'video/mp4', formatId: '137', height: 1080 },
              { url: 'https://rr1-hotfix.googlevideo.com/videoplayback?id=audio', kind: 'audio', mime: 'audio/mp4', formatId: '140' },
            ] }));
      },
    };
    state.ports.push(port); return port;
  };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    runtime, permissions: { async contains(query: { permissions: string[] }) {
      assert.deepEqual(query.permissions, ['nativeMessaging']); return true;
    } },
  } });
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36' });
  try { await run(state); }
  finally {
    if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome); else Reflect.deleteProperty(globalThis, 'chrome');
    if (originalAgent) Object.defineProperty(navigator, 'userAgent', originalAgent); else Reflect.deleteProperty(navigator, 'userAgent');
  }
}

test('Native messaging is a required startup permission for the privileged module worker', async () => {
  const manifest = JSON.parse(await readFile(new URL('../src/local/manifest.json', import.meta.url), 'utf8'));
  assert(manifest.permissions.includes('nativeMessaging'));
  assert(!(manifest.optional_permissions ?? []).includes('nativeMessaging'));
  assert.deepEqual(manifest.background, { service_worker: 'local/background.js', type: 'module' });
});

test('Missing native API gives reload and desktop Chrome guidance instead of connectNative TypeError', async () => {
  await withNativeAPI(false, async state => {
    const readiness = await probeYouTube();
    assert(['error', 'unavailable'].includes(readiness.status));
    assert.match(readiness.message, /PC.*Chrome/);
    assert.match(readiness.message, /새로고침|다시.*로드/);
    assert.doesNotMatch(readiness.message, /is not a function/);
    await assert.rejects(resolveYouTube(SOURCE, OPTIONS, new AbortController().signal), (error: unknown) => {
      assert(error instanceof Error); assert(!(error instanceof TypeError));
      assert.match(error.message, /PC.*Chrome/);
      assert.match(error.message, /새로고침|다시.*로드/);
      assert.doesNotMatch(error.message, /is not a function|googlevideo\.com|watch\?v=/);
      return true;
    });
    assert.deepEqual(state.requests, []); assert.deepEqual(state.ports, []);
  });
});

test('Available startup native API resolves bound video and audio tracks and releases each port', async () => {
  await withNativeAPI(true, async state => {
    assert.equal((await probeYouTube()).status, 'ready');
    const result = await resolveYouTube(`https://youtu.be/${VIDEO_ID}`, OPTIONS, new AbortController().signal);
    assert.equal(result.videoId, VIDEO_ID); assert.equal(result.url, SOURCE);
    assert.deepEqual(result.tracks.map(track => track.kind), ['video', 'audio']);
    assert.deepEqual(state.hosts, [YOUTUBE_HOST, YOUTUBE_HOST]);
    assert.deepEqual(state.requests.map(request => request.action), ['status', 'resolve']);
    assert.equal(state.requests[1]!.url, SOURCE);
    assert.notEqual(state.requests[0]!.requestId, state.requests[1]!.requestId);
    for (const port of state.ports) {
      assert.equal(port.disconnects, 1);
      assert.equal(port.onMessage.listeners.size, 0); assert.equal(port.onDisconnect.listeners.size, 0);
    }
  });
});
