import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DIRECTORY, JOBS_KEY, OFFER_KEY, type Job } from '../src/upscale/policy.ts';
import { appStorage } from '../src/data/database.ts';

class Event<Args extends unknown[]> {
  private listeners: Array<(...args: Args) => unknown> = [];
  addListener(listener: (...args: Args) => unknown) { this.listeners.push(listener); }
  emit(...args: Args) { for (const listener of this.listeners) listener(...args); }
}

test('split incognito queue APIs and events preserve ordinary retained files, notifications and authorizations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'my-video-app-queue-privacy-'));
  const bytes = new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
  const job: Job = { id: crypto.randomUUID(), filename: 'ordinary-private-name.mp4', size: bytes.length, createdAt: Date.now(), downloadId: 9010 };
  await mkdir(join(root, DIRECTORY));
  await writeFile(join(root, DIRECTORY, job.id), bytes);
  await writeFile(join(root, 'input.media'), bytes);
  const data: Record<string, unknown> = { [JOBS_KEY]: [job], [OFFER_KEY]: true };
  const effects = { reads: 0, writes: 0, ready: 0, status: 0, roots: 0, directories: 0, files: 0, fileWrites: 0, removals: 0, notices: 0, cleared: 0, menus: 0 };
  const notices = new Set([`vdh-upscale:${job.id}`]);
  const opened: string[] = [];
  const clicked = new Event<[string]>(); const buttonClicked = new Event<[string, number]>();
  const installed = new Event<[]>(); const startup = new Event<[]>(); const menuClicked = new Event<[{ menuItemId: string }]>();
  const extension = { inIncognitoContext: false };
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');
  const originalAppStorage = { get: appStorage.get, set: appStorage.set, ready: appStorage.ready, status: appStorage.status };
  appStorage.get = async keys => { effects.reads++; return Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map(key => [key, structuredClone(data[key])])); };
  appStorage.set = async values => { effects.writes++; Object.assign(data, structuredClone(values)); };
  appStorage.ready = async () => { effects.ready++; };
  appStorage.status = async () => { effects.status++; return { name: 'queue-test', version: 1, privateContext: false, historyCount: 0, jobCount: (data[JOBS_KEY] as unknown[] | undefined)?.length ?? 0, recoveryCount: 0, lastMaintenanceAt: null, migratedAt: null, legacyCleanupPending: false }; };
  const absent = (error: unknown): never => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DOMException('Missing test file', 'NotFoundError');
    throw error;
  };
  function directory(path: string): unknown {
    return {
      async getDirectoryHandle(name: string) { effects.directories++; await mkdir(join(path, name), { recursive: true }); return directory(join(path, name)); },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        effects.files++; const target = join(path, name);
        try { await stat(target); } catch (error) { if (options?.create) await writeFile(target, new Uint8Array()); else absent(error); }
        return {
          async getFile() { return new File([await readFile(target)], name); },
          async createWritable() {
            effects.fileWrites++; const chunks: Uint8Array[] = [];
            return new WritableStream<Uint8Array>({ write(chunk) { chunks.push(chunk); }, async close() { await writeFile(target, Buffer.concat(chunks)); } });
          },
        };
      },
      async removeEntry(name: string) { effects.removals++; try { await rm(join(path, name)); } catch (error) { absent(error); } },
      async *keys() { yield* await readdir(path); },
    };
  }
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    extension,
    runtime: { getURL: (path: string) => `chrome-extension://queue-test/${path}`, onInstalled: installed, onStartup: startup },
    storage: { local: {
      async get(key: string) { effects.reads++; return structuredClone({ [key]: data[key] }); },
      async set(values: Record<string, unknown>) { effects.writes++; Object.assign(data, structuredClone(values)); },
    } },
    notifications: {
      onClicked: clicked, onButtonClicked: buttonClicked,
      async create(id: string) { effects.notices++; notices.add(id); return id; },
      async clear(id: string) { effects.cleared++; return notices.delete(id); },
    },
    tabs: { async create({ url }: { url: string }) { opened.push(url); return {}; } },
    contextMenus: { onClicked: menuClicked, create() { effects.menus++; } },
  } });
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { async getDirectory() { effects.roots++; return directory(root); } } });
  try {
    const { privateContext, jobs, cleanup, cleanupUnlocked, deleteJob } = await import('../src/upscale/storage.ts');
    const { offerUpscale, authorizeDownloadOffers, revokeDownloadOffers } = await import('../src/upscale/completion.ts');
    const metadata = (downloadId: number) => ({ internalFilename: 'input.media', filename: 'video.mp4', downloadId, success: true, incognito: false });
    const drain = async () => {
      await navigator.locks.request('vdh-upscale-queue-v1', async () => {});
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      await navigator.locks.request('vdh-upscale-queue-v1', async () => {});
    };
    // Establish two opposite authorization states before the private context receives shared events.
    await revokeDownloadOffers(9020); authorizeDownloadOffers(9030);

    await t.test('private APIs do not read or mutate shared index, files, notifications or offer permissions', async () => {
      assert.deepEqual(await jobs(), [job]); const baseline = structuredClone(effects);
      extension.inIncognitoContext = true;
      assert.equal(privateContext(), true); assert.deepEqual(await jobs(), []);
      assert.deepEqual(await cleanup(), []); assert.deepEqual(await cleanupUnlocked(), []);
      await deleteJob(job); await revokeDownloadOffers(job.downloadId!);
      authorizeDownloadOffers(9020); await revokeDownloadOffers(9030);
      await offerUpscale(metadata(9040));
      assert.deepEqual(effects, baseline);
      assert.deepEqual(data[JOBS_KEY], [job]); assert.deepEqual(new Uint8Array(await readFile(join(root, DIRECTORY, job.id))), bytes);
      assert.ok(notices.has(`vdh-upscale:${job.id}`)); assert.deepEqual(opened, []);
    });

    await t.test('private startup, install and retained-copy notification events cannot select or erase ordinary copies', async () => {
      const baseline = structuredClone(effects);
      installed.emit(); startup.emit();
      clicked.emit(`vdh-upscale:${job.id}`);
      buttonClicked.emit(`vdh-upscale:${job.id}`, 0); buttonClicked.emit(`vdh-upscale:${job.id}`, 1);
      await drain();
      assert.deepEqual(effects, baseline); assert.deepEqual(opened, []);
      assert.deepEqual(data[JOBS_KEY], [job]); assert.deepEqual(new Uint8Array(await readFile(join(root, DIRECTORY, job.id))), bytes);
      assert.ok(notices.has(`vdh-upscale:${job.id}`));
    });

    await t.test('manual media tools remain available privately without selecting a retained ordinary job', async () => {
      const baseline = structuredClone(effects);
      menuClicked.emit({ menuItemId: 'vdh-upscale-tools' }); await drain();
      assert.deepEqual(opened, ['chrome-extension://queue-test/upscale/index.html']);
      assert.deepEqual(effects, baseline); assert.deepEqual(data[JOBS_KEY], [job]);
    });

    await t.test('returning to ordinary context preserves its files and opposite offer authorization states', async () => {
      extension.inIncognitoContext = false;
      assert.equal(privateContext(), false); assert.deepEqual(await jobs(), [job]);
      assert.deepEqual(new Uint8Array(await readFile(join(root, DIRECTORY, job.id))), bytes);
      const baseline = structuredClone(effects);
      await offerUpscale(metadata(9020));
      assert.deepEqual(effects, baseline, 'private authorization must not lift an ordinary revocation');
      await offerUpscale(metadata(9030));
      const retained = await jobs(); const offered = retained.find(row => row.downloadId === 9030);
      assert.ok(offered, 'private revocation must not revoke an authorized ordinary download');
      assert.deepEqual(new Uint8Array(await readFile(join(root, DIRECTORY, offered.id))), bytes);
      assert.ok(notices.has(`vdh-upscale:${offered.id}`));
      authorizeDownloadOffers(9020); await offerUpscale(metadata(9020));
      assert.equal((await jobs()).length, 3, 'a fresh ordinary authorization still enables offers');
      await deleteJob(offered);
      assert.ok(!(await jobs()).some(row => row.id === offered.id));
      await assert.rejects(stat(join(root, DIRECTORY, offered.id)));
      assert.ok((await cleanup()).some(row => row.id === job.id));
      assert.deepEqual(new Uint8Array(await readFile(join(root, DIRECTORY, job.id))), bytes);
    });
  } finally {
    Object.assign(appStorage, originalAppStorage);
    if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome); else Reflect.deleteProperty(globalThis, 'chrome');
    if (originalStorage) Object.defineProperty(navigator, 'storage', originalStorage); else Reflect.deleteProperty(navigator, 'storage');
    await rm(root, { recursive: true, force: true });
  }
});
