import { DIRECTORY, JOBS_KEY, RETENTION_MS, MAX_QUEUE_BYTES, MAX_JOBS, isJob, type Job } from './policy.ts';

export function privateContext(): boolean { return chrome.extension?.inIncognitoContext === true; }
export async function jobs(): Promise<Job[]> {
  if (privateContext()) return [];
  const stored: unknown = (await chrome.storage.local.get(JOBS_KEY))[JOBS_KEY];
  return Array.isArray(stored) ? stored.filter(isJob).slice(0, MAX_JOBS) : [];
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
    const dir = await directory();
    await removeIfExists(dir, job.id);
    await chrome.storage.local.set({ [JOBS_KEY]: (await jobs()).filter(j => j.id !== job.id) });
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
  const dir = await directory();
  const stored = await jobs();
  const retained: Job[] = [];
  let size = 0;
  for (const job of stored.sort((a, b) => b.createdAt - a.createdAt)) {
    if (now - job.createdAt < RETENTION_MS && job.createdAt <= now && size + job.size <= MAX_QUEUE_BYTES && retained.length < MAX_JOBS) {
      try { await dir.getFileHandle(job.id); retained.push(job); size += job.size; }
      catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
    }
  }
  const keep = new Set(retained.map(j => j.id));
  // Clean orphan copies too, including a crash between writing the file and saving the index.
  const iterable = dir as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> };
  for await (const name of iterable.keys()) if (!keep.has(name)) await removeIfExists(dir, name);
  await chrome.storage.local.set({ [JOBS_KEY]: retained });
  return retained;
}
