import { DIRECTORY, JOBS_KEY, RETENTION_MS, MAX_QUEUE_BYTES, MAX_JOBS, isJob, type Job } from './policy.ts';
import { appStorage } from '../data/database.ts';

export function privateContext(): boolean { return chrome.extension?.inIncognitoContext === true; }
export async function jobs(): Promise<Job[]> {
  if (privateContext()) return [];
  const stored: unknown = (await appStorage.get(JOBS_KEY))[JOBS_KEY];
  // Recovery suspends caps in IndexedDB; do not hide valid recovered bindings.
  return Array.isArray(stored) ? stored.filter(isJob) : [];
}
export async function directory(): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(DIRECTORY, { create: true });
}
async function removeIfExists(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try { await dir.removeEntry(name); }
  catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
}
export async function deleteJob(job: Job): Promise<void> {
  if (privateContext()) return;
  await withQueueLock(async () => {
    const retained = (await jobs()).filter(j => j.id !== job.id);
    // Persist the user's removal before deleting bytes; a DB failure preserves the file.
    await appStorage.set({ [JOBS_KEY]: retained });
    const dir = await directory();
    await removeIfExists(dir, job.id);
  });
}
export async function withQueueLock<T>(operation: () => Promise<T>): Promise<T> {
  return await navigator.locks.request('vdh-upscale-queue-v1', { mode: 'exclusive' }, operation);
}
export function cleanup(now = Date.now()): Promise<Job[]> {
  if (privateContext()) return Promise.resolve([]);
  return withQueueLock(() => cleanupUnlocked(now));
}
/** Caller must hold the origin-wide queue lock for the entire transaction. */
export async function cleanupUnlocked(now = Date.now()): Promise<Job[]> {
  if (privateContext()) return [];
  await appStorage.ready();
  const stored = await jobs();
  // Unknown recovered metadata may still refer to files missing from this index.
  // Leave both metadata and bytes untouched until recovery is resolved.
  if ((await appStorage.status()).recoveryCount > 0) return stored;
  const dir = await directory();
  const retained: Job[] = [];
  let size = 0;
  for (const job of stored.sort((a, b) => b.createdAt - a.createdAt)) {
    if (now - job.createdAt < RETENTION_MS && job.createdAt <= now && size + job.size <= MAX_QUEUE_BYTES && retained.length < MAX_JOBS) {
      try { await dir.getFileHandle(job.id); retained.push(job); size += job.size; }
      catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
    }
  }
  const keep = new Set(retained.map(j => j.id));
  // A failed index commit must not discard any of the previously retained files.
  await appStorage.set({ [JOBS_KEY]: retained });
  // Clean orphan copies too, including a crash between writing the file and saving the index.
  const iterable = dir as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> };
  for await (const name of iterable.keys()) if (!keep.has(name)) await removeIfExists(dir, name);
  return retained;
}
