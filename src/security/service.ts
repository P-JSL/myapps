import { allowRuntimeMessage } from './validation.ts';
import { cleanup, cleanupUnlocked, deleteJob, directory, jobs, withQueueLock } from '../upscale/storage.ts';
import { OFFER_KEY, JOBS_KEY, MAX_INPUT_BYTES, MAX_QUEUE_BYTES, MAX_JOBS, safeBasename, sniffMedia, isJobId, type Job } from '../upscale/policy.ts';

export const allowMessage = (value: unknown, sender: chrome.runtime.MessageSender, expected: 0 | 1) => allowRuntimeMessage(value, sender, chrome.runtime.id, expected);
interface CompletedDownload { internalFilename: string; filename: string; downloadId?: number; success: boolean; incognito: boolean; }
let serial: Promise<unknown> = Promise.resolve();
export async function offerUpscale(event: CompletedDownload): Promise<void> {
  // The original downloader must never fail because the optional feature failed.
  const pending = serial.then(() => withQueueLock(async () => {
    if (!event.success || event.incognito || !Number.isInteger(event.downloadId)) return;
    if ((await chrome.storage.local.get(OFFER_KEY))[OFFER_KEY] === false) return;
    const root = await navigator.storage.getDirectory();
    const source = await (await root.getFileHandle(event.internalFilename)).getFile();
    if (!source.size || source.size > MAX_INPUT_BYTES || !sniffMedia(new Uint8Array(await source.slice(0, 16).arrayBuffer()))) return;
    const retained = await cleanupUnlocked();
    if (retained.length >= MAX_JOBS || retained.reduce((total, job) => total + job.size, 0) + source.size > MAX_QUEUE_BYTES) return;
    const job: Job = { id: crypto.randomUUID(), filename: safeBasename(event.filename), size: source.size, createdAt: Date.now() };
    const dir = await directory();
    const writable = await (await dir.getFileHandle(job.id, { create: true })).createWritable();
    try { await source.stream().pipeTo(writable); }
    catch (error) { await dir.removeEntry(job.id).catch(() => {}); throw error; }
    await chrome.storage.local.set({ [JOBS_KEY]: [job, ...retained] });
    await chrome.notifications.create(`vdh-upscale:${job.id}`, {
      type: 'basic', iconUrl: chrome.runtime.getURL('bitmaps/logo-128-color.png'), title: '다운로드 완료 · 업스케일링',
      message: `${job.filename}\n확대본을 별도 파일로 만들 수 있습니다.`,
      buttons: [{ title: '업스케일링 선택' }, { title: '임시 복사본 삭제' }],
    }).catch(() => {});
  }));
  serial = pending.catch(() => {});
  await serial;
}

function openTools(job?: string) {
  const suffix = job && isJobId(job) ? `?job=${encodeURIComponent(job)}` : '';
  return chrome.tabs.create({ url: chrome.runtime.getURL(`upscale/index.html${suffix}`) });
}
chrome.notifications.onClicked.addListener(id => {
  if (id.startsWith('vdh-upscale:')) void openTools(id.slice('vdh-upscale:'.length));
});
chrome.notifications.onButtonClicked.addListener((id, button) => {
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
  chrome.contextMenus.create({ id: 'vdh-upscale-tools', title: '업스케일링 · 보안 설정', contexts: ['action'] }, () => { void chrome.runtime.lastError; });
  void cleanup().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { void cleanup().catch(() => {}); });
chrome.contextMenus.onClicked.addListener(info => { if (info.menuItemId === 'vdh-upscale-tools') void openTools(); });
