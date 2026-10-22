import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

type WorkerMessage = { type: string; [key: string]: unknown };
type Handler = (event: { data: unknown }) => Promise<void>;
interface Asset { filename: string; url: string; }
const marker = new TextEncoder().encode(['X5O!P%@AP[4\\PZX54(P^)7CC)7}', '$EICAR-', 'STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(''));
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...new Uint8Array(24)]);
const mp4 = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, ...new Uint8Array(20)]);
function join(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
let sequence = 0;
async function fixture(entry: 'stream' | 'upscale', assets = new Map<string, Uint8Array>()) {
  const messages: WorkerMessage[] = [], writes: { name: string; bytes: Uint8Array; owned: boolean }[] = [];
  const calls: string[][] = [], probes: string[][] = [], files = new Map<string, Uint8Array>();
  let logger = (_value: { message: string; type: string }) => {}, created = 0;
  const core = {
    reset() {}, setTimeout() {}, setProgress() {}, setLogger(value: typeof logger) { logger = value; },
    exec(...args: string[]) {
      calls.push(args);
      if (args.includes('-decoders')) for (const message of [' VFS..D h264                 H.264', ' VF...D png                  PNG', ' A....D aac                  AAC']) logger({ type: 'stdout', message });
      return 0;
    },
    ffprobe(...args: string[]) {
      probes.push(args);
      const audio = args.at(-1) === 'audio.media';
      files.set('probe.json', new TextEncoder().encode(JSON.stringify({ streams: [{ codec_type: audio ? 'audio' : 'video', codec_name: audio ? 'aac' : 'png', width: 64, height: 48 }], format: { duration: 1 } })));
      return 0;
    },
    FS: {
      writeFile(name: string, bytes: Uint8Array, options?: { canOwn?: boolean }) { writes.push({ name, bytes, owned: options?.canOwn === true }); files.set(name, bytes); },
      readFile(name: string, options?: { encoding?: string }) {
        const bytes = files.get(name) ?? (name.startsWith('output.') ? Uint8Array.of(1, 2, 3) : undefined);
        if (!bytes) throw new Error('No such fixture file');
        return options?.encoding === 'utf8' ? new TextDecoder().decode(bytes) : bytes;
      },
      stat(name: string) { const bytes = files.get(name); if (!bytes) throw new Error('No such fixture file'); return { size: bytes.byteLength }; },
      unlink(name: string) { files.delete(name); },
    },
  };
  const globals = {
    onmessage: null,
    postMessage: (message: WorkerMessage) => { messages.push(message); },
    __mediaGateCreateCore: async () => { created++; return core; },
    __mediaGateDownloadAssets: async (requested: Asset[], consume: (name: string, bytes: Uint8Array) => void, _signal: AbortSignal,
      progress: (completed: number) => void, protocol: (value: string) => void) => {
      let completed = 0;
      for (const asset of requested) { const bytes = assets.get(asset.filename); assert(bytes, 'Asset fixture missing'); consume(asset.filename, bytes); progress(++completed); }
      protocol('h3');
    },
  };
  const original = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  try {
    const result = await build({
      entryPoints: [entry === 'stream' ? 'src/local/stream-worker.ts' : 'src/upscale/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'chrome120',
      plugins: [{ name: 'isolated-media-gate-fixtures', setup(builder) {
        builder.onResolve({ filter: /vendor\/ffmpeg\/ffmpeg-core\.js$/ }, () => ({ path: 'core', namespace: 'media-gate-fixtures' }));
        builder.onResolve({ filter: /(?:^|\/)assets\.ts$/ }, () => ({ path: 'assets', namespace: 'media-gate-fixtures' }));
        builder.onLoad({ filter: /.*/, namespace: 'media-gate-fixtures' }, args => ({ contents: args.path === 'core'
          ? 'export default () => globalThis.__mediaGateCreateCore();'
          : 'export const downloadAssets = (...args) => globalThis.__mediaGateDownloadAssets(...args);', loader: 'js' }));
      } }],
    });
    await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}#${sequence++}`);
    const handler = (globalThis as unknown as { onmessage: Handler }).onmessage;
    return { messages, writes, calls, probes, created: () => created, run: async (data: unknown) => handler({ data }), close() {
      for (const [name, descriptor] of original) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    } };
  } catch (error) {
    for (const [name, descriptor] of original) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    throw error;
  }
}
function file(bytes: Uint8Array<ArrayBuffer>, name: string, type: string): File { return new File([bytes], name, { type }); }
function plan(names: string[], playlist = false) {
  return { assets: names.map(filename => ({ filename, url: `https://media.test/${filename}` })), inputs: [playlist
    ? { filename: 'input-0.m3u8', playlist: '#EXTM3U\n' + names.join('\n') }
    : { filename: 'input-0.mp4', parts: names }] };
}
function assertRefused(state: Awaited<ReturnType<typeof fixture>>) {
  const error = state.messages.find(message => message.type === 'error');
  assert(error); assert.match(String(error.message), /내부 위험 검사/);
  assert.equal((error.internalScan as { status: string }).status, 'suspicious');
  assert(!state.messages.some(message => message.type === 'done'));
  assert.deepEqual(state.calls.filter(args => !args.includes('-decoders')), []);
  assert.deepEqual(state.probes, []);
}

test('local processing refuses suspicious primary and secondary files before engine creation', async () => {
  for (const secondary of [false, true]) {
    const state = await fixture('upscale');
    try {
      const bad = file(join(png, marker), 'image.png', 'image/png');
      await state.run(secondary
        ? { file: file(mp4, 'video.mp4', 'video/mp4'), audio: bad, options: { mode: 'merge', format: 'mp4' } }
        : { file: bad, factor: 2 });
      assertRefused(state); assert.equal(state.created(), 0); assert.deepEqual(state.writes, []);
    } finally { state.close(); }
  }
});

test('a suspicious stream asset is refused before MEMFS staging or decoding', async () => {
  const name = 'asset-00000.ts';
  const state = await fixture('stream', new Map([[name, join(mp4, marker)]]));
  try {
    await state.run({ plan: plan([name], true) });
    assertRefused(state); assert.equal(state.created(), 1); assert.deepEqual(state.writes, []);
  } finally { state.close(); }
});

test('joined track inspection catches a marker that straddles separately fetched asset boundaries', async () => {
  const first = 'dash-0.m4s', second = 'dash-1.m4s', split = Math.floor(marker.length / 2);
  const state = await fixture('stream', new Map([[first, join(mp4, marker.subarray(0, split))], [second, marker.subarray(split)]]));
  try {
    await state.run({ plan: plan([first, second]) });
    assertRefused(state);
    assert.deepEqual(state.writes.map(write => write.name), [first, second]);
    assert(!state.writes.some(write => write.name === 'input-0.mp4'));
  } finally { state.close(); }
});

test('benign whole-file and fragment inputs preserve owned buffers, protocol observations and output flow', async () => {
  const bytes = new Uint8Array(png);
  const input = file(bytes, 'image.png', 'image/png');
  Object.defineProperty(input, 'arrayBuffer', { value: async () => bytes.buffer });
  const image = await fixture('upscale');
  try {
    await image.run({ file: input, factor: 2 });
    assert.equal(image.messages.at(-1)?.type, 'done');
    assert.equal(image.writes[0]?.name, 'input.media'); assert.equal(image.writes[0]?.bytes.buffer, bytes.buffer); assert.equal(image.writes[0]?.owned, true);
    assert.equal(image.probes.length, 1);
  } finally { image.close(); }
  const name = 'asset-00000.ts', chunk = Uint8Array.from([71, ...new Uint8Array(187)]);
  const stream = await fixture('stream', new Map([[name, chunk]]));
  try {
    await stream.run({ plan: plan([name], true) });
    assert.equal(stream.messages.at(-1)?.type, 'done');
    assert.deepEqual(stream.messages.at(-1)?.protocols, ['h3']);
    assert.equal(stream.writes[0]?.bytes, chunk); assert(stream.calls.some(args => args.includes('-i')));
  } finally { stream.close(); }
});
