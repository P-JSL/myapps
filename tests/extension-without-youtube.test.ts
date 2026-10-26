import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { appStorage } from '../src/data/database.ts';
import { SCOPE, HISTORY_KEY, browserMediaURL, isHistory, mediaKind, type HistoryItem } from '../src/local/model.ts';

const desktopMessage = /YouTube는 별도 데스크톱 앱에서 다운로드/;
const blocked = [
  'https://www.youtube.com/watch?v=abc_def-1234',
  'https://m.youtube.com/shorts/abc_def-1234',
  'https://music.youtube.com/watch?v=abc_def-1234',
  'https://www.youtube.com./watch?v=abc_def-1234',
  'https://youtu.be/abc_def-1234',
  'https://www.youtube-nocookie.com/embed/abc_def-1234',
  'https://rr1.example.googlevideo.com/videoplayback?range=0-1023',
];

test('browser discovery excludes YouTube pages and playback chunks while retaining ordinary files and VOD', () => {
  for (const url of blocked) {
    assert.equal(mediaKind(url, 'video/mp4', true), undefined, url);
    assert.throws(() => browserMediaURL(url), desktopMessage);
  }
  assert.equal(mediaKind('https://media.test/movie.mp4', 'video/mp4'), 'file');
  assert.equal(mediaKind('https://media.test/master.m3u8'), 'hls');
  assert.equal(mediaKind('https://media.test/feed', 'application/dash+xml'), 'dash');
  assert.equal(mediaKind('https://youtube.com.media.test/movie.mp4'), 'file');
  assert.equal(browserMediaURL('https://media.test/video.mp4#start').href, 'https://media.test/video.mp4');
});

// Exercise the actual background router with inert Chrome APIs. Storage remains
// inspectable so a rejected desktop URL cannot create work or ask for a helper.
const id = 'extension-without-youtube';
const ui = { id, url: `chrome-extension://${id}/local/index.html` };
let route: (value: unknown, sender: chrome.runtime.MessageSender) => Promise<unknown>;
let history: HistoryItem[] = [];
const effects = { writes: 0, downloads: 0, native: 0, opens: 0 };
const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
const originalStorage = { ...appStorage };
const event = () => ({ addListener() {} });

test.before(async () => {
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    extension: { inIncognitoContext: false },
    permissions: { async contains() { effects.native++; throw new Error('No native permission request expected'); } },
    runtime: { id, getURL: (name: string) => `chrome-extension://${id}/${name}`,
      onMessage: event(), onInstalled: event(), onStartup: event(),
      connectNative() { effects.native++; throw new Error('No native connection expected'); } },
    downloads: { onChanged: event(), async download() { effects.downloads++; throw new Error('No transfer expected'); } },
    tabs: { onRemoved: event(), onUpdated: event(), onActivated: event(),
      async query() { return [{ id: 1, url: blocked[0], title: 'YouTube page', incognito: false }]; },
      async create() { effects.opens++; return {}; } },
    notifications: { onClicked: event(), onButtonClicked: event() },
    contextMenus: { onClicked: event() }, webRequest: { onHeadersReceived: event() }, commands: { onCommand: event() },
    sidePanel: { async setPanelBehavior() {} }, action: { async setPopup() {} },
  } });
  Object.assign(appStorage, {
    async ready() { throw new Error('Startup reconciliation is outside this router fixture'); },
    async get() { return { [HISTORY_KEY]: structuredClone(history) }; },
    async set() { effects.writes++; throw new Error('No history mutation expected'); },
  });
  route = (await import('../src/local/background.ts')).handleLocalMessage;
});
test.after(() => {
  Object.assign(appStorage, originalStorage);
  if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome);
  else Reflect.deleteProperty(globalThis, 'chrome');
});

test('direct YouTube links fail before folder setup, history, transfer, or native helper access', async () => {
  for (const url of blocked) await assert.rejects(route({ scope: SCOPE, type: 'download-url', url }, ui), desktopMessage);
  for (const type of ['youtube-connect', 'youtube-status', 'youtube-helper-installer', 'recording-start']) {
    await assert.rejects(route({ scope: SCOPE, type }, ui), /지원하지 않는 요청/);
  }
  assert.deepEqual(effects, { writes: 0, downloads: 0, native: 0, opens: 0 });
});

test('legacy YouTube history remains visible without retry or synthesized media cards', async () => {
  const old: HistoryItem = { id: crypto.randomUUID(), url: blocked[0]!, filename: 'old.mp4', kind: 'youtube', state: 'error', createdAt: 1, incognito: false };
  assert(isHistory(old)); history = [old];
  await assert.rejects(route({ scope: SCOPE, type: 'retry', id: old.id }, ui), desktopMessage);
  await route({ scope: SCOPE, type: 'capture', items: [
    { url: blocked.at(-1), title: 'partial track', mime: 'video/mp4', fromElement: true },
    { url: 'https://media.test/whole.mp4', title: 'ordinary video', mime: 'video/mp4', fromElement: true },
  ] }, { id, url: blocked[0]!, tab: { id: 1, incognito: false } as chrome.tabs.Tab });
  const listed = await route({ scope: SCOPE, type: 'list' }, ui) as { items: Array<{ url: string; kind: string }>; history: HistoryItem[] };
  assert.deepEqual(listed.items.map(item => [item.url, item.kind]), [['https://media.test/whole.mp4', 'file']]);
  assert.deepEqual(listed.history, [old]);
  assert.deepEqual(effects, { writes: 0, downloads: 0, native: 0, opens: 0 });
});

test('extension packaging has no YouTube scripts, capture permissions, settings, or embedded installer', async () => {
  const manifest = JSON.parse(await readFile('src/local/manifest.json', 'utf8'));
  assert.deepEqual(manifest.optional_permissions, ['nativeMessaging']); // Existing antivirus connection remains optional.
  assert(!manifest.permissions.some((permission: string) => ['nativeMessaging', 'tabCapture', 'scripting'].includes(permission)));
  assert.deepEqual(manifest.content_scripts.flatMap((entry: { js: string[] }) => entry.js), ['local/collect.js']);
  const [catalog, popup, settings, background, offscreen] = await Promise.all([
    'scripts/project.mjs', 'src/local/popup.ts', 'src/local/index.html', 'src/local/background.ts', 'src/local/offscreen.ts',
  ].map(name => readFile(name, 'utf8')));
  assert.doesNotMatch(catalog!, /youtube|tab-recording|setup\//i);
  assert.doesNotMatch(popup!, /youtube|nativeMessaging|recording/i);
  assert.doesNotMatch(settings!, /youtube|녹화 시작|설치 ZIP/i);
  assert.doesNotMatch(background!, /connectNative|resolveYouTube|observeYouTube|youtube-connect|tabCapture/);
  assert.doesNotMatch(offscreen!, /youtube|resolution|recording/i);
  assert.match(settings!, /id="security-connect"/);
  assert.match(background!, /로컬 백신 연결 권한/);
});
