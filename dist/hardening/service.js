// src/upscale/policy.ts
var MAX_INPUT_BYTES = 256 * 1024 * 1024;
var MAX_QUEUE_BYTES = 512 * 1024 * 1024;
var MAX_JOBS = 4;
var RETENTION_MS = 24 * 60 * 60 * 1e3;
var DIRECTORY = "vdh-upscale-v1";
var JOBS_KEY = "vdh_upscale_jobs_v1";
var OFFER_KEY = "vdh_upscale_offer_v1";
function isJobId(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function isJob(value) {
  if (!value || typeof value !== "object") return false;
  const v = value;
  return isJobId(v.id) && typeof v.filename === "string" && v.filename.length <= 240 && Number.isSafeInteger(v.size) && v.size > 0 && v.size <= MAX_INPUT_BYTES && typeof v.createdAt === "number" && Number.isFinite(v.createdAt) && (v.downloadId === void 0 || Number.isSafeInteger(v.downloadId) && v.downloadId >= 0);
}
function safeBasename(input) {
  return (input.split(/[\\/]/).at(-1) ?? "media").replace(/[\x00-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, "_").replace(/[. ]+$/g, "").slice(0, 180) || "media";
}
function sniffMedia(bytes) {
  const ascii = (start, count) => String.fromCharCode(...bytes.subarray(start, start + count));
  if (bytes[0] === 137 && ascii(1, 3) === "PNG" && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return "image";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image";
  if (ascii(4, 4) === "ftyp" || ascii(0, 4) === "RIFF" && ascii(8, 4) === "AVI ") return "video";
  if (bytes[0] === 26 && bytes[1] === 69 && bytes[2] === 223 && bytes[3] === 163) return "video";
  return void 0;
}

// src/upscale/storage.ts
async function jobs() {
  const stored = (await chrome.storage.local.get(JOBS_KEY))[JOBS_KEY];
  return Array.isArray(stored) ? stored.filter(isJob).slice(0, MAX_JOBS) : [];
}
async function directory() {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(DIRECTORY, { create: true });
}
async function removeIfExists(dir, name) {
  try {
    await dir.removeEntry(name);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  }
}
async function deleteJob(job) {
  await withQueueLock(async () => {
    const dir = await directory();
    await removeIfExists(dir, job.id);
    await chrome.storage.local.set({ [JOBS_KEY]: (await jobs()).filter((j) => j.id !== job.id) });
  });
}
async function withQueueLock(operation) {
  return await navigator.locks.request("vdh-upscale-queue-v1", { mode: "exclusive" }, operation);
}
function cleanup(now = Date.now()) {
  return withQueueLock(() => cleanupUnlocked(now));
}
async function cleanupUnlocked(now = Date.now()) {
  const dir = await directory();
  const stored = await jobs();
  const retained = [];
  let size = 0;
  for (const job of stored.sort((a, b) => b.createdAt - a.createdAt)) {
    if (now - job.createdAt < RETENTION_MS && job.createdAt <= now && size + job.size <= MAX_QUEUE_BYTES && retained.length < MAX_JOBS) {
      try {
        await dir.getFileHandle(job.id);
        retained.push(job);
        size += job.size;
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
      }
    }
  }
  const keep = new Set(retained.map((j) => j.id));
  const iterable = dir;
  for await (const name of iterable.keys()) if (!keep.has(name)) await removeIfExists(dir, name);
  await chrome.storage.local.set({ [JOBS_KEY]: retained });
  return retained;
}

// src/upscale/completion.ts
var serial = Promise.resolve();
var revokedDownloads = /* @__PURE__ */ new Set();
async function offerUpscale(event) {
  const pending = serial.then(() => withQueueLock(async () => {
    const downloadId = event.downloadId;
    if (!event.success || event.incognito || typeof downloadId !== "number" || !Number.isSafeInteger(downloadId) || downloadId < 0 || revokedDownloads.has(downloadId)) return;
    if ((await chrome.storage.local.get(OFFER_KEY))[OFFER_KEY] === false) return;
    const root = await navigator.storage.getDirectory();
    const source = await (await root.getFileHandle(event.internalFilename)).getFile();
    if (!source.size || source.size > MAX_INPUT_BYTES || !sniffMedia(new Uint8Array(await source.slice(0, 16).arrayBuffer()))) return;
    if (event.expectedSha256 !== void 0 || event.expectedSize !== void 0) {
      if (typeof event.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(event.expectedSha256) || !Number.isSafeInteger(event.expectedSize) || source.size !== event.expectedSize) return;
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await source.arrayBuffer()));
      const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (sha256 !== event.expectedSha256) return;
    }
    if (revokedDownloads.has(downloadId)) return;
    const retained = await cleanupUnlocked();
    if (retained.length >= MAX_JOBS || retained.reduce((total, job2) => total + job2.size, 0) + source.size > MAX_QUEUE_BYTES) return;
    const job = { id: crypto.randomUUID(), filename: safeBasename(event.filename), size: source.size, createdAt: Date.now(), downloadId };
    const dir = await directory();
    const writable = await (await dir.getFileHandle(job.id, { create: true })).createWritable();
    try {
      await source.stream().pipeTo(writable);
    } catch (error) {
      await dir.removeEntry(job.id).catch(() => {
      });
      throw error;
    }
    await chrome.storage.local.set({ [JOBS_KEY]: [job, ...retained] });
    await chrome.notifications.create(`vdh-upscale:${job.id}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("bitmaps/logo-128-color.png"),
      title: "\uB2E4\uC6B4\uB85C\uB4DC \uC644\uB8CC \xB7 \uC5C5\uC2A4\uCF00\uC77C\uB9C1",
      message: `${job.filename}
\uD655\uB300\uBCF8\uC744 \uBCC4\uB3C4 \uD30C\uC77C\uB85C \uB9CC\uB4E4 \uC218 \uC788\uC2B5\uB2C8\uB2E4.`,
      buttons: [{ title: "\uC5C5\uC2A4\uCF00\uC77C\uB9C1 \uC120\uD0DD" }, { title: "\uC784\uC2DC \uBCF5\uC0AC\uBCF8 \uC0AD\uC81C" }]
    }).catch(() => {
    });
  }));
  serial = pending.catch(() => {
  });
  await serial;
}
async function revokeDownloadOffers(downloadId) {
  if (!Number.isSafeInteger(downloadId) || downloadId < 0) throw new Error("\uC798\uBABB\uB41C \uB2E4\uC6B4\uB85C\uB4DC \uBC88\uD638\uC785\uB2C8\uB2E4.");
  revokedDownloads.add(downloadId);
  const pending = serial.then(() => withQueueLock(async () => {
    const retained = await jobs();
    const revoked = retained.filter((job) => job.downloadId === downloadId);
    if (!revoked.length) return;
    await chrome.storage.local.set({ [JOBS_KEY]: retained.filter((job) => job.downloadId !== downloadId) });
    await Promise.all(revoked.map((job) => chrome.notifications.clear(`vdh-upscale:${job.id}`).catch(() => {
    })));
    const dir = await directory();
    const removals = await Promise.allSettled(revoked.map((job) => dir.removeEntry(job.id).catch((error) => {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
    })));
    const failed = removals.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }));
  serial = pending.catch(() => {
  });
  await pending;
}
function openTools(job) {
  const suffix = job && isJobId(job) ? `?job=${encodeURIComponent(job)}` : "";
  return chrome.tabs.create({ url: chrome.runtime.getURL(`upscale/index.html${suffix}`) });
}
chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith("vdh-upscale:")) void openTools(id.slice("vdh-upscale:".length));
});
chrome.notifications.onButtonClicked.addListener((id, button) => {
  if (!id.startsWith("vdh-upscale:")) return;
  const jobId = id.slice("vdh-upscale:".length);
  if (!isJobId(jobId)) return;
  if (button === 0) void openTools(jobId);
  else if (button === 1) {
    serial = serial.then(async () => {
      const job = (await jobs()).find((j) => j.id === jobId);
      if (job) await deleteJob(job);
    }).catch(() => {
    });
  }
  void chrome.notifications.clear(id);
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "vdh-upscale-tools", title: "\uC5C5\uC2A4\uCF00\uC77C\uB9C1 \xB7 \uBCF4\uC548 \uC124\uC815", contexts: ["action"] }, () => {
    void chrome.runtime.lastError;
  });
  void cleanup().catch(() => {
  });
});
chrome.runtime.onStartup.addListener(() => {
  void cleanup().catch(() => {
  });
});
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "vdh-upscale-tools") void openTools();
});
export {
  offerUpscale,
  revokeDownloadOffers
};
