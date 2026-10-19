import { cleanup, cleanupUnlocked, deleteJob, directory, jobs, withQueueLock, privateContext } from './storage.ts';
import { OFFER_KEY, JOBS_KEY, MAX_INPUT_BYTES, MAX_QUEUE_BYTES, MAX_JOBS, safeBasename, sniffMedia, isJobId, type Job } from './policy.ts';

interface CompletedDownload {
  internalFilename: string; filename: string; downloadId?: number; success: boolean; incognito: boolean;
  expectedSha256?: string; expectedSize?: number;
}
let serial: Promise<unknown> = Promise.resolve();
const revokedDownloads = new Set<number>();
const offerGenerations = new Map<number, number>();
export function authorizeDownloadOffers(downloadId: number): void {
  if (privateContext()) return;
  if (!Number.isSafeInteger(downloadId) || downloadId < 0) throw new Error('잘못된 다운로드 번호입니다.');
  offerGenerations.set(downloadId, (offerGenerations.get(downloadId) ?? 0) + 1);
  revokedDownloads.delete(downloadId);
}
export async function offerUpscale(event: CompletedDownload): Promise<void> {
  if (privateContext()) return;
  const generation = event.downloadId === undefined ? undefined : offerGenerations.get(event.downloadId) ?? 0;
  const permitted = () => event.downloadId !== undefined && !revokedDownloads.has(event.downloadId)
    && (offerGenerations.get(event.downloadId) ?? 0) === generation;
  // The downloader must never fail because the optional feature failed.
  const pending = serial.then(() => withQueueLock(async () => {
    const downloadId = event.downloadId;
    if (!event.success || event.incognito || typeof downloadId !== 'number' || !Number.isSafeInteger(downloadId) || downloadId < 0 || !permitted()) return;
    if ((await chrome.storage.local.get(OFFER_KEY))[OFFER_KEY] === false) return;
    const root = await navigator.storage.getDirectory();
    const source = await (await root.getFileHandle(event.internalFilename)).getFile();
    if (!source.size || source.size > MAX_INPUT_BYTES || !sniffMedia(new Uint8Array(await source.slice(0, 16).arrayBuffer()))) return;
    if (event.expectedSha256 !== undefined || event.expectedSize !== undefined) {
      if (typeof event.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(event.expectedSha256)
        || !Number.isSafeInteger(event.expectedSize) || source.size !== event.expectedSize) return;
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await source.arrayBuffer()));
      const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
      if (sha256 !== event.expectedSha256) return;
    }
      if (!permitted()) return;
    const retained = await cleanupUnlocked();
    if (retained.length >= MAX_JOBS || retained.reduce((total, job) => total + job.size, 0) + source.size > MAX_QUEUE_BYTES) return;
    const job: Job = { id: crypto.randomUUID(), filename: safeBasename(event.filename), size: source.size, createdAt: Date.now(), downloadId };
    const dir = await directory();
    const writable = await (await dir.getFileHandle(job.id, { create: true })).createWritable();
    try { await source.stream().pipeTo(writable); }
    catch (error) { await dir.removeEntry(job.id).catch(() => {}); throw error; }
    if (!permitted()) { await dir.removeEntry(job.id).catch(() => {}); return; }
    await chrome.storage.local.set({ [JOBS_KEY]: [job, ...retained] });
    if (!permitted()) {
      await chrome.storage.local.set({ [JOBS_KEY]: retained });
      await dir.removeEntry(job.id).catch(() => {}); return;
    }
    await chrome.notifications.create(`vdh-upscale:${job.id}`, {
      type: 'basic', iconUrl: chrome.runtime.getURL('bitmaps/logo-128-color.png'), title: '다운로드 완료 · 업스케일링',
      message: `${job.filename}\n확대본을 별도 파일로 만들 수 있습니다.`,
      buttons: [{ title: '업스케일링 선택' }, { title: '임시 복사본 삭제' }],
    }).catch(() => {});
    if (!permitted()) await chrome.notifications.clear(`vdh-upscale:${job.id}`).catch(() => {});
  }));
  serial = pending.catch(() => {});
  await serial;
}

/** Revoke retained copies and notifications when a previously finished download becomes unsafe. */
export async function revokeDownloadOffers(downloadId: number): Promise<void> {
  if (privateContext()) return;
  if (!Number.isSafeInteger(downloadId) || downloadId < 0) throw new Error('잘못된 다운로드 번호입니다.');
  revokedDownloads.add(downloadId);
  offerGenerations.set(downloadId, (offerGenerations.get(downloadId) ?? 0) + 1);
  const pending = serial.then(() => withQueueLock(async () => {
    const retained = await jobs();
    const revoked = retained.filter(job => job.downloadId === downloadId);
    if (!revoked.length) return;
    // Hide the jobs before deleting files so a failed removal cannot leave them selectable.
    await chrome.storage.local.set({ [JOBS_KEY]: retained.filter(job => job.downloadId !== downloadId) });
    await Promise.all(revoked.map(job => chrome.notifications.clear(`vdh-upscale:${job.id}`).catch(() => {})));
    const dir = await directory();
    const removals = await Promise.allSettled(revoked.map(job => dir.removeEntry(job.id).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    })));
    const failed = removals.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }));
  serial = pending.catch(() => {});
  await pending;
}

function openTools(job?: string) {
  const suffix = job && isJobId(job) ? `?job=${encodeURIComponent(job)}` : '';
  return chrome.tabs.create({ url: chrome.runtime.getURL(`upscale/index.html${suffix}`) });
}
chrome.notifications.onClicked.addListener(id => {
  if (privateContext()) return;
  if (id.startsWith('vdh-upscale:')) void openTools(id.slice('vdh-upscale:'.length));
});
chrome.notifications.onButtonClicked.addListener((id, button) => {
  if (privateContext()) return;
  if (!id.startsWith('vdh-upscale:')) return;
  const jobId = id.slice('vdh-upscale:'.length);
  if (!isJobId(jobId)) return;
  if (button === 0) void openTools(jobId);
  else if (button === 1) {
    serial = serial.then(async () => {
      const job = (await jobs()).find(j => j.id === jobId);
      if (job) await deleteJob(job);
    }).catch(() => {});
  }
  void chrome.notifications.clear(id);
});
chrome.runtime.onInstalled.addListener(() => {
  if (privateContext()) return;
  chrome.contextMenus.create({ id: 'vdh-upscale-tools', title: '업스케일링 · 보안 설정', contexts: ['action'] }, () => { void chrome.runtime.lastError; });
  void cleanup().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { if (!privateContext()) void cleanup().catch(() => {}); });
chrome.contextMenus.onClicked.addListener(info => { if (info.menuItemId === 'vdh-upscale-tools') void openTools(); });
