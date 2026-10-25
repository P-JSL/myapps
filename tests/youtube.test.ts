import test from 'node:test';
import assert from 'node:assert/strict';
import { YOUTUBE_HOST, youtubeVideo, youtubeResolution, probeYouTube, resolveYouTube } from '../src/local/youtube.ts';

const ID = 'AbC_def-123';
const URL = `https://www.youtube.com/watch?v=${ID}`;
const options = { quality: 'highest' as const, output: 'original' as const };
const userAgent = 'Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36';
const video = () => ({ url: 'https://rr1---example.googlevideo.com/videoplayback?expire=9999999999&id=video', kind: 'video', mime: 'video/mp4', formatId: '399', height: 2160, size: 4000 });
const audio = () => ({ url: 'https://rr2---example.googlevideo.com/videoplayback?expire=9999999999&id=audio', kind: 'audio', mime: 'audio/mp4', formatId: '140', size: 1000 });
const resolution = () => ({ videoId: ID, url: URL, title: '<img src=x onerror=alert(1)> 제목', tracks: [video(), audio()], duration: 14_402 });

test('YouTube links canonicalize one video without retaining playlist or signed parameters', () => {
  for (const address of [URL, `${URL}&list=PL-example&t=20`, `https://youtube.com/watch/?v=${ID}`, `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`, `https://youtu.be/${ID}?si=share`, `https://www.youtu.be/${ID}/`,
    `https://www.youtube.com/shorts/${ID}`, `https://www.youtube.com/embed/${ID}`, `https://www.youtube.com/live/${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`]) assert.deepEqual(youtubeVideo(address), { id: ID, url: URL });
});

test('Playlist-only, ambiguous, credential, origin-spoof and non-HTTPS source links never reach the extractor', () => {
  for (const address of [null, {}, '', `http://www.youtube.com/watch?v=${ID}`, `https://user:pass@youtube.com/watch?v=${ID}`,
    `https://youtube.com:444/watch?v=${ID}`, `https://youtube.com.evil.invalid/watch?v=${ID}`, `https://youtube.com@evil.invalid/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=${ID}&v=${ID}`, 'https://youtube.com/playlist?list=PL-example', 'https://youtube.com/watch',
    'https://youtube.com/watch?v=short', `https://youtube.com/watch?v=${ID}x`, `https://youtu.be/${ID}/more`,
    `https://youtube-nocookie.com/watch?v=${ID}`, `javascript:https://youtube.com/watch?v=${ID}`, `https://example.invalid/${ID}`,
    `https://youtube.com/shorts/${ID}%2fextra`, URL + '&x=' + 'a'.repeat(8192)]) assert.equal(youtubeVideo(address), undefined);
});

test('Resolved tracks are bound to the requested video and normalize video before audio', () => {
  const value = resolution(); value.tracks.reverse();
  const actual = youtubeResolution(value, `https://youtu.be/${ID}`);
  assert.equal(actual.url, URL); assert.equal(actual.videoId, ID); assert.equal(actual.duration, 14_402);
  assert.equal(actual.title, value.title); assert.deepEqual(actual.tracks.map(track => track.kind), ['video', 'audio']);
  assert.notEqual(actual.tracks, value.tracks); assert.equal(value.tracks[0]!.kind, 'audio');
  assert.deepEqual(youtubeResolution({ ...resolution(), title: '😀'.repeat(200) }, URL).title, '😀'.repeat(200));
});

test('A native resolver cannot substitute another origin, arbitrary headers or malformed track metadata', () => {
  for (const badURL of ['http://rr1.googlevideo.com/videoplayback', 'https://googlevideo.com.evil.invalid/videoplayback',
    'https://localhost/videoplayback', 'https://127.0.0.1/videoplayback', 'file:///tmp/movie.mp4',
    'https://googlevideo.com/videoplayback', 'https://rr1.googlevideo.com/other', 'https://user@rr1.googlevideo.com/videoplayback',
    'https://rr1.googlevideo.com:444/videoplayback', 'https://rr1.googlevideo.com/videoplayback#fragment']) {
    assert.throws(() => youtubeResolution({ ...resolution(), tracks: [{ ...video(), url: badURL }] }, URL));
  }
  for (const track of [{ ...video(), headers: { Cookie: 'private' } }, { ...video(), mime: 'audio/mp4' }, { ...audio(), mime: 'video/mp4' },
    { ...video(), formatId: '../unsafe' }, { ...video(), height: 0 }, { ...video(), height: Infinity }, { ...audio(), height: 100 },
    { ...video(), size: 0 }, { ...video(), size: Number.MAX_SAFE_INTEGER + 1 }, { ...video(), protocol: 'https' }, { ...video(), fragments: [] }]) {
    assert.throws(() => youtubeResolution({ ...resolution(), tracks: [track] }, URL));
  }
});

test('Source mismatch, oversized metadata, duplicate tracks and unsupported track combinations fail closed', () => {
  for (const value of [null, {}, { ...resolution(), videoId: 'ZZZ_def-1234' }, { ...resolution(), url: 'https://www.youtube.com/watch?v=ZZZ_def-1234' },
    { ...resolution(), title: 'a'.repeat(201) }, { ...resolution(), title: 'line\nbreak' }, { ...resolution(), title: '😀'.repeat(201) },
    { ...resolution(), tracks: [] }, { ...resolution(), tracks: [video(), audio(), audio()] },
    { ...resolution(), tracks: [video(), video()] }, { ...resolution(), tracks: [audio(), audio()] },
    { ...resolution(), tracks: [{ ...video(), kind: 'combined' }, audio()] },
    { ...resolution(), tracks: [video(), { ...audio(), url: video().url }] },
    { ...resolution(), tracks: [video(), { ...audio(), formatId: video().formatId }] },
    { ...resolution(), duration: -1 }, { ...resolution(), duration: NaN }, { ...resolution(), headers: {} }]) assert.throws(() => youtubeResolution(value, URL));
  const cyclic: Record<string, unknown> = resolution(); cyclic.cycle = cyclic;
  assert.throws(() => youtubeResolution(cyclic, URL));
});

type Handler<T extends unknown[]> = (...args: T) => void;
class Events<T extends unknown[]> {
  listeners = new Set<Handler<T>>();
  addListener(listener: Handler<T>) { this.listeners.add(listener); }
  removeListener(listener: Handler<T>) { this.listeners.delete(listener); }
  emit(...values: T) { for (const listener of [...this.listeners]) listener(...values); }
}
interface Port {
  onMessage: Events<[unknown]>;
  onDisconnect: Events<[]>;
  disconnects: number;
  disconnect(): void;
  postMessage(value: Record<string, unknown>): void;
}
interface State {
  permission: boolean | Promise<boolean>;
  permissions: number;
  hosts: string[];
  posts: Record<string, unknown>[];
  ports: Port[];
  post?: (message: Record<string, unknown>, port: Port) => void;
  connectError?: boolean;
}
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise<void>(resolve => queueMicrotask(resolve));
async function withChrome(run: (state: State) => Promise<void>) {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const originalAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
  const state: State = { permission: true, permissions: 0, hosts: [], posts: [], ports: [] };
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent });
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    permissions: { async contains() { state.permissions++; return state.permission; } },
    runtime: { connectNative(host: string) {
      state.hosts.push(host); if (state.connectError) throw Error('Explicit native connection failure');
      const port: Port = { onMessage: new Events(), onDisconnect: new Events(), disconnects: 0,
        disconnect() { this.disconnects++; this.onDisconnect.emit(); },
        postMessage(message) {
          state.posts.push(structuredClone(message));
          if (state.post) state.post(message, port);
          else queueMicrotask(() => port.onMessage.emit(message.action === 'status'
            ? { version: 1, requestId: message.requestId, status: 'ready', ytDlpVersion: '2026.10.21', runtime: 'Deno 2.5.4', message: '추출 엔진 준비됨' }
            : { version: 1, requestId: message.requestId, status: 'resolved', videoId: ID, title: resolution().title, tracks: resolution().tracks, duration: 14_402 }));
        } };
      state.ports.push(port); return port;
    } },
  } });
  try { await run(state); }
  finally {
    if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome); else Reflect.deleteProperty(globalThis, 'chrome');
    if (originalAgent) Object.defineProperty(navigator, 'userAgent', originalAgent); else Reflect.deleteProperty(navigator, 'userAgent');
  }
}
function released(state: State) {
  for (const port of state.ports) {
    assert.equal(port.disconnects, 1); assert.equal(port.onMessage.listeners.size, 0); assert.equal(port.onDisconnect.listeners.size, 0);
  }
}

test('Native resolution uses the dedicated host, canonical one-video request and browser user agent', async () => {
  await withChrome(async state => {
    const result = await resolveYouTube(`https://youtu.be/${ID}?list=PL-ignore`, options, new AbortController().signal);
    assert.equal(result.videoId, ID); assert.equal(result.tracks[0]!.height, 2160);
    assert.deepEqual(state.hosts, [YOUTUBE_HOST]); assert.equal(state.posts.length, 1);
    const message = state.posts[0]!;
    assert.deepEqual(Object.keys(message).sort(), ['action', 'output', 'quality', 'requestId', 'url', 'userAgent', 'version']);
    assert.equal(message.action, 'resolve'); assert.equal(message.url, URL); assert.equal(message.quality, 'highest'); assert.equal(message.output, 'original');
    assert.equal(message.userAgent, userAgent); assert.match(String(message.requestId), /^[0-9a-f-]{36}$/); released(state);
  });
});

test('Readiness deduplicates only active status calls and never caches signed media results', async () => {
  await withChrome(async state => {
    const first = probeYouTube(), second = probeYouTube(); assert.equal(first, second);
    assert.deepEqual(await first, { status: 'ready', ytDlpVersion: '2026.10.21', runtime: 'Deno 2.5.4', message: '추출 엔진 준비됨' });
    assert.equal(state.posts.length, 1); await probeYouTube(); assert.equal(state.posts.length, 2);
    await resolveYouTube(URL, options, new AbortController().signal); await resolveYouTube(URL, options, new AbortController().signal);
    assert.equal(state.posts.filter(message => message.action === 'resolve').length, 2); released(state);
  });
});

test('Denied permission, already aborted signal and invalid source never open native connections', async () => {
  await withChrome(async state => {
    state.permission = false;
    assert.equal((await probeYouTube()).status, 'unavailable');
    await assert.rejects(resolveYouTube(URL, options, new AbortController().signal), /권한/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(resolveYouTube(URL, options, controller.signal), { name: 'AbortError' });
    await assert.rejects(resolveYouTube('https://example.invalid/watch?v=' + ID, options, new AbortController().signal));
    assert.deepEqual(state.hosts, []);
  });
});

test('Cancellation while permission is pending prevents the later native request', async () => {
  await withChrome(async state => {
    const permission = deferred<boolean>(); state.permission = permission.promise;
    const controller = new AbortController(), result = resolveYouTube(URL, options, controller.signal);
    controller.abort(); permission.resolve(true);
    await assert.rejects(result, { name: 'AbortError' }); assert.deepEqual(state.hosts, []);
  });
});

test('Cancellation disconnects the active port and stale responses cannot revive the request', async () => {
  await withChrome(async state => {
    state.post = () => {};
    const controller = new AbortController(), result = resolveYouTube(URL, options, controller.signal);
    await turn(); assert.equal(state.posts.length, 1);
    controller.abort(); await assert.rejects(result, { name: 'AbortError' }); released(state);
    state.ports[0]!.onMessage.emit({ version: 1, requestId: state.posts[0]!.requestId, status: 'resolved', ...resolution() });
    released(state);
  });
});

test('Mismatched response IDs, forged origins and forbidden metadata are never accepted', async () => {
  await withChrome(async state => {
    for (const changes of [{ version: 2 }, { requestId: 'another-request' }, { status: 'clean' }, { videoId: 'ZZZ_def-1234' },
      { headers: { Cookie: 'not-allowed' } }, { title: 'x'.repeat(70_000) }, { tracks: [{ ...video(), url: 'https://evil.invalid/videoplayback' }] }]) {
      state.post = (message, port) => queueMicrotask(() => port.onMessage.emit({ version: 1, requestId: message.requestId, status: 'resolved', videoId: ID, title: 'Safe', tracks: [video(), audio()], ...changes }));
      await assert.rejects(resolveYouTube(URL, options, new AbortController().signal));
    }
    released(state);
  });
});

test('Extraction failures, unavailable host and insufficient tracks remain explicit errors', async () => {
  await withChrome(async state => {
    state.post = (message, port) => queueMicrotask(() => port.onMessage.emit({ version: 1, requestId: message.requestId, status: 'error', message: '로그인이 필요한 영상입니다.' }));
    await assert.rejects(resolveYouTube(URL, options, new AbortController().signal), /로그인/);
    state.post = (message, port) => queueMicrotask(() => port.onMessage.emit({ version: 1, requestId: message.requestId, status: 'resolved', videoId: ID, title: 'Audio', tracks: [audio()] }));
    await assert.rejects(resolveYouTube(URL, options, new AbortController().signal), /필요한.*트랙/);
    const result = await resolveYouTube(URL, { ...options, output: 'm4a' }, new AbortController().signal); assert.equal(result.tracks[0]!.kind, 'audio');
    state.post = (message, port) => queueMicrotask(() => port.onMessage.emit({ version: 1, requestId: message.requestId, status: 'resolved', videoId: ID, title: 'Video', tracks: [video()] }));
    await assert.rejects(resolveYouTube(URL, { ...options, output: 'mp3' }, new AbortController().signal), /필요한.*트랙/); released(state);
    state.connectError = true; assert.equal((await probeYouTube()).status, 'error');
  });
});

test('Readiness requires request-bound package and local runtime evidence instead of a fabricated ready status', async () => {
  await withChrome(async state => {
    for (const changes of [{ ytDlpVersion: undefined }, { runtime: undefined }, { requestId: 'other' }, { status: 'resolved' },
      { message: 'line\nbreak' }, { headers: {} }]) {
      state.post = (message, port) => queueMicrotask(() => port.onMessage.emit({ version: 1, requestId: message.requestId, status: 'ready', message: 'Ready', ytDlpVersion: '2026.10.21', runtime: 'Deno 2.5.4', ...changes }));
      assert.equal((await probeYouTube()).status, 'error');
    }
    released(state);
  });
});

test('A disconnected host and extraction timeout clean listeners and settle exactly once', async () => {
  await withChrome(async state => {
    state.post = (_message, port) => queueMicrotask(() => port.onDisconnect.emit());
    await assert.rejects(resolveYouTube(URL, options, new AbortController().signal), /종료/); released(state);
    const oldTimeout = globalThis.setTimeout, oldClear = globalThis.clearTimeout;
    let expire: (() => void) | undefined, cleared = 0;
    Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (callback: () => void, milliseconds: number) => {
      assert.equal(milliseconds, 120_000); expire = callback; return 123;
    } });
    Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, value: (id: unknown) => { assert.equal(id, 123); cleared++; } });
    try {
      state.post = () => {};
      const result = resolveYouTube(URL, options, new AbortController().signal); await turn(); assert(expire);
      expire(); await assert.rejects(result, /시간.*초과/); assert.equal(cleared, 1); released(state);
    } finally {
      Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: oldTimeout });
      Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, value: oldClear });
    }
  });
});

test('Unusable browser header values cannot be forwarded into the native extractor', async () => {
  await withChrome(async state => {
    for (const agent of ['', 'x'.repeat(513), 'Injected\r\nCookie: bad', 'nonASCII😀']) {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: agent });
      await assert.rejects(resolveYouTube(URL, options, new AbortController().signal), /식별 정보/);
    }
    assert.deepEqual(state.hosts, []);
  });
});
