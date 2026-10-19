// src/security/validation.ts
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function boundedData(value, maxChars = 16 * 1024 * 1024) {
  const stack = [[value, 0]];
  const visited = /* @__PURE__ */ new Set();
  let nodes = 0;
  let chars = 0;
  while (stack.length) {
    const [item, depth, exit] = stack.pop();
    if (exit) {
      visited.delete(item);
      continue;
    }
    if (++nodes > 1e5 || depth > 64) return false;
    if (typeof item === "string") chars += item.length;
    else if (typeof item === "number" && !Number.isFinite(item)) return false;
    else if (typeof item === "object" && item !== null) {
      if (visited.has(item)) return false;
      visited.add(item);
      stack.push([item, depth, true]);
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
      const keys = Object.keys(item);
      if (nodes + keys.length + stack.length - visited.size > 1e5) return false;
      for (const key of keys) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") return false;
        chars += key.length;
        if (chars > maxChars) return false;
        stack.push([item[key], depth + 1]);
      }
    } else if (typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") return false;
    if (chars > maxChars) return false;
  }
  return true;
}

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
function privateContext() {
  return chrome.extension?.inIncognitoContext === true;
}
async function jobs() {
  if (privateContext()) return [];
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
  if (privateContext()) return;
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
  if (privateContext()) return Promise.resolve([]);
  return withQueueLock(() => cleanupUnlocked(now));
}
async function cleanupUnlocked(now = Date.now()) {
  if (privateContext()) return [];
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
var offerGenerations = /* @__PURE__ */ new Map();
function authorizeDownloadOffers(downloadId) {
  if (privateContext()) return;
  if (!Number.isSafeInteger(downloadId) || downloadId < 0) throw new Error("\uC798\uBABB\uB41C \uB2E4\uC6B4\uB85C\uB4DC \uBC88\uD638\uC785\uB2C8\uB2E4.");
  offerGenerations.set(downloadId, (offerGenerations.get(downloadId) ?? 0) + 1);
  revokedDownloads.delete(downloadId);
}
async function offerUpscale(event) {
  if (privateContext()) return;
  const generation = event.downloadId === void 0 ? void 0 : offerGenerations.get(event.downloadId) ?? 0;
  const permitted = () => event.downloadId !== void 0 && !revokedDownloads.has(event.downloadId) && (offerGenerations.get(event.downloadId) ?? 0) === generation;
  const pending = serial.then(() => withQueueLock(async () => {
    const downloadId = event.downloadId;
    if (!event.success || event.incognito || typeof downloadId !== "number" || !Number.isSafeInteger(downloadId) || downloadId < 0 || !permitted()) return;
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
    if (!permitted()) return;
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
    if (!permitted()) {
      await dir.removeEntry(job.id).catch(() => {
      });
      return;
    }
    await chrome.storage.local.set({ [JOBS_KEY]: [job, ...retained] });
    if (!permitted()) {
      await chrome.storage.local.set({ [JOBS_KEY]: retained });
      await dir.removeEntry(job.id).catch(() => {
      });
      return;
    }
    await chrome.notifications.create(`vdh-upscale:${job.id}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("bitmaps/logo-128-color.png"),
      title: "\uB2E4\uC6B4\uB85C\uB4DC \uC644\uB8CC \xB7 \uC5C5\uC2A4\uCF00\uC77C\uB9C1",
      message: `${job.filename}
\uD655\uB300\uBCF8\uC744 \uBCC4\uB3C4 \uD30C\uC77C\uB85C \uB9CC\uB4E4 \uC218 \uC788\uC2B5\uB2C8\uB2E4.`,
      buttons: [{ title: "\uC5C5\uC2A4\uCF00\uC77C\uB9C1 \uC120\uD0DD" }, { title: "\uC784\uC2DC \uBCF5\uC0AC\uBCF8 \uC0AD\uC81C" }]
    }).catch(() => {
    });
    if (!permitted()) await chrome.notifications.clear(`vdh-upscale:${job.id}`).catch(() => {
    });
  }));
  serial = pending.catch(() => {
  });
  await serial;
}
async function revokeDownloadOffers(downloadId) {
  if (privateContext()) return;
  if (!Number.isSafeInteger(downloadId) || downloadId < 0) throw new Error("\uC798\uBABB\uB41C \uB2E4\uC6B4\uB85C\uB4DC \uBC88\uD638\uC785\uB2C8\uB2E4.");
  revokedDownloads.add(downloadId);
  offerGenerations.set(downloadId, (offerGenerations.get(downloadId) ?? 0) + 1);
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
  if (privateContext()) return;
  if (id.startsWith("vdh-upscale:")) void openTools(id.slice("vdh-upscale:".length));
});
chrome.notifications.onButtonClicked.addListener((id, button) => {
  if (privateContext()) return;
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
  if (privateContext()) return;
  chrome.contextMenus.create({ id: "vdh-upscale-tools", title: "\uC5C5\uC2A4\uCF00\uC77C\uB9C1 \xB7 \uBCF4\uC548 \uC124\uC815", contexts: ["action"] }, () => {
    void chrome.runtime.lastError;
  });
  void cleanup().catch(() => {
  });
});
chrome.runtime.onStartup.addListener(() => {
  if (!privateContext()) void cleanup().catch(() => {
  });
});
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "vdh-upscale-tools") void openTools();
});

// src/local/model.ts
var SCOPE = "my-video-app/local";
var OFFSCREEN_SCOPE = "my-video-app/offscreen";
var HISTORY_KEY = "my_video_app_history_v1";
var MAX_HISTORY = 200;
var MAX_MEDIA_PER_TAB = 200;
var MAX_STREAM_BYTES = 128 * 1024 * 1024;
var ACTIVE_HISTORY_STATES = ["preparing", "downloading", "scanning", "review"];
var MediaCatalog = class {
  byTab = /* @__PURE__ */ new Map();
  byId = /* @__PURE__ */ new Map();
  get size() {
    return this.byId.size;
  }
  get(tabId, url) {
    return this.byTab.get(tabId)?.get(url);
  }
  find(id) {
    return this.byId.get(id);
  }
  *tabIds() {
    yield* this.byTab.keys();
  }
  *items(tabId) {
    yield* this.byTab.get(tabId)?.values() ?? [];
  }
  set(item) {
    const previous = this.byId.get(item.id);
    if (previous && (previous.tabId !== item.tabId || previous.url !== item.url)) {
      const oldTab = this.byTab.get(previous.tabId);
      oldTab.delete(previous.url);
      if (!oldTab.size) this.byTab.delete(previous.tabId);
    }
    const tab = this.byTab.get(item.tabId) ?? /* @__PURE__ */ new Map();
    const replaced = tab.get(item.url);
    if (replaced && replaced.id !== item.id) this.byId.delete(replaced.id);
    tab.set(item.url, item);
    this.byId.set(item.id, item);
    if (tab.size > MAX_MEDIA_PER_TAB) {
      let evicted;
      for (const candidate of tab.values()) if (candidate.kind === "file") {
        evicted = candidate;
        break;
      }
      evicted ??= tab.values().next().value;
      tab.delete(evicted.url);
      this.byId.delete(evicted.id);
    }
    this.byTab.set(item.tabId, tab);
  }
  deleteTab(tabId) {
    const tab = this.byTab.get(tabId);
    if (!tab) return;
    for (const item of tab.values()) this.byId.delete(item.id);
    this.byTab.delete(tabId);
  }
};
function retainHistory(rows) {
  const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt);
  const active = (row) => ACTIVE_HISTORY_STATES.includes(row.state);
  return [...sorted.filter(active), ...sorted.filter((row) => !active(row))].slice(0, MAX_HISTORY);
}
function mediaURL(value, base) {
  if (typeof value !== "string" || !value || value.length > 8192) throw new Error("\uBBF8\uB514\uC5B4 \uC8FC\uC18C\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  const url = new URL(value, base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("HTTP \uB610\uB294 HTTPS \uBBF8\uB514\uC5B4 \uC8FC\uC18C\uB9CC \uC9C0\uC6D0\uD569\uB2C8\uB2E4.");
  url.hash = "";
  return url;
}
function mediaKind(url, mime = "", fromElement = false) {
  const path = mediaURL(url).pathname.toLowerCase();
  if (/\.m3u8$/.test(path) || /mpegurl/i.test(mime)) return "hls";
  if (/\.mpd$/.test(path) || /dash\+xml/i.test(mime)) return "dash";
  if (!fromElement && (/\.(ts|m4s)$/.test(path) || /video\/mp2t/i.test(mime))) return void 0;
  if (/\.(mp4|webm|mkv|mov|avi|m4v|mp3|m4a|ogg|wav|flac|aac)$/.test(path) || /^(video|audio)\//i.test(mime) || fromElement) return "file";
  return void 0;
}
function filenameFor(media2) {
  let leaf = "";
  try {
    leaf = decodeURIComponent(mediaURL(media2.url).pathname.split("/").at(-1) ?? "");
  } catch {
  }
  const ext = media2.kind !== "file" ? "mp4" : leaf.match(/\.(mp4|webm|mkv|mov|avi|m4v|mp3|m4a|ogg|wav|flac|aac)$/i)?.[1]?.toLowerCase() ?? ({ "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/ogg": "ogg", "video/webm": "webm" }[media2.mime.split(";")[0] ?? ""] ?? "mp4");
  let base = safeBasename(media2.title || leaf || "media").replace(/\.(mp4|webm|mkv|mov|avi|m4v|mp3|m4a|ogg|wav|flac|aac|m3u8|mpd)$/i, "");
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  return `${base || "media"}.${ext}`;
}
function isHistory(value) {
  return record(value) && typeof value.id === "string" && /^[a-f0-9-]{36}$/.test(value.id) && typeof value.url === "string" && typeof value.filename === "string" && ["file", "hls", "dash"].includes(String(value.kind)) && ["preparing", "downloading", "scanning", "review", "discarded", "complete", "cancelled", "error"].includes(String(value.state)) && typeof value.createdAt === "number" && Number.isFinite(value.createdAt) && typeof value.incognito === "boolean";
}
function trustedUI(sender, id, base) {
  if (sender.id !== id || typeof sender.url !== "string") return false;
  try {
    const u = new URL(sender.url);
    return ["local/index.html", "upscale/index.html"].some((page) => u.href.split(/[?#]/)[0] === `${base}${page}`);
  } catch {
    return false;
  }
}
function trustedCapture(sender, id) {
  if (sender.id !== id || !Number.isInteger(sender.tab?.id) || (sender.tab?.id ?? -1) < 0) return false;
  try {
    mediaURL(sender.url);
    return true;
  } catch {
    return false;
  }
}

// src/local/preferences.ts
var QUALITIES = ["highest", "2160", "1080", "720", "480"];
function downloadOptions(value) {
  if (value === void 0) return { quality: "highest", output: "original" };
  if (!record(value) || !QUALITIES.includes(value.quality) || !["original", "mp3", "m4a"].includes(String(value.output))) throw new Error("\uB2E4\uC6B4\uB85C\uB4DC \uD654\uC9C8 \uB610\uB294 \uC800\uC7A5 \uD615\uC2DD\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  return { quality: value.quality, output: value.output };
}

// src/local/transport.ts
function transport(value) {
  if (typeof value !== "string") return void 0;
  if (/^h3(?:-\d+)?$/.test(value)) return "h3";
  if (value === "h2") return "h2";
  if (value === "http/1.1") return "http/1.1";
  return void 0;
}

// src/local/antivirus.ts
var ANTIVIRUS_HOST = "com.myvideoapp.antivirus";
function chromeWarning(danger) {
  if (typeof danger !== "string" || !danger) return void 0;
  return ["safe", "accepted", "deepScannedSafe", "allowlistedByPolicy"].includes(danger) ? void 0 : danger.slice(0, 100);
}
function scanResponse(value, requestId) {
  if (!record(value) || !boundedData(value, 64 * 1024) || value.version !== 1 || value.requestId !== requestId || !["clean", "infected", "unavailable", "error"].includes(String(value.status))) throw new Error("\uBC31\uC2E0 \uC751\uB2F5\uC744 \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
  const result = { status: value.status, checkedAt: Date.now() };
  if (typeof value.engine === "string" && value.engine.length <= 120) result.engine = value.engine;
  if (typeof value.message === "string") result.message = value.message.slice(0, 1e3);
  if (Array.isArray(value.threats) && value.threats.length <= 16 && value.threats.every((x) => typeof x === "string" && x.length <= 240)) result.threats = value.threats;
  if (typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256)) result.sha256 = value.sha256;
  if (typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0) result.size = value.size;
  if (["clean", "infected"].includes(result.status) && (!result.engine || !result.sha256 || result.size === void 0)) throw new Error("\uBC31\uC2E0\uC774 \uAC80\uC0AC\uD55C \uD30C\uC77C \uC815\uBCF4\uB97C \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
  return result;
}
function readinessResponse(value, requestId) {
  if (!record(value) || !boundedData(value, 64 * 1024) || value.version !== 1 || value.requestId !== requestId || !["ready", "unavailable", "error"].includes(String(value.status))) throw new Error("\uBC31\uC2E0 \uC5F0\uACB0 \uC0C1\uD0DC \uC751\uB2F5\uC744 \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
  const result = { status: value.status, checkedAt: Date.now() };
  if (value.engine !== void 0) {
    if (typeof value.engine !== "string" || !value.engine.trim() || value.engine.length > 120) throw new Error("\uBC31\uC2E0 \uC5D4\uC9C4 \uC751\uB2F5\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
    result.engine = value.engine;
  }
  if (value.message !== void 0) {
    if (typeof value.message !== "string" || value.message.length > 1e3) throw new Error("\uBC31\uC2E0 \uC0C1\uD0DC \uC124\uBA85\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
    result.message = value.message;
  }
  if (value.products !== void 0) {
    if (!Array.isArray(value.products) || value.products.length > 32 || !value.products.every((name) => typeof name === "string" && name.trim() && name.length <= 500)) throw new Error("\uBC31\uC2E0 \uC81C\uD488 \uC751\uB2F5\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
    result.products = value.products;
  }
  if (result.status === "ready" && !result.engine) throw new Error("\uC5F0\uACB0\uD560 \uBC31\uC2E0 \uC5D4\uC9C4\uC744 \uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
  return result;
}
var readinessPending;
function probeAntivirus() {
  if (readinessPending) return readinessPending;
  readinessPending = (async () => {
    if (!await chrome.permissions.contains({ permissions: ["nativeMessaging"] })) return { status: "unavailable", checkedAt: Date.now(), message: "\uB85C\uCEEC \uBC31\uC2E0 \uC5F0\uACB0 \uAD8C\uD55C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4. \uBC31\uC2E0 \uB3C4\uC6B0\uBBF8 \uC124\uCE58 \uD6C4 \u2018\uB85C\uCEEC \uBC31\uC2E0 \uC5F0\uACB0\u2019\uC744 \uB20C\uB7EC \uC8FC\uC138\uC694." };
    return new Promise((resolve) => {
      let port;
      let timer;
      let settled = false;
      const finish2 = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try {
          port?.disconnect();
        } catch {
        }
        resolve(result);
      };
      try {
        port = chrome.runtime.connectNative(ANTIVIRUS_HOST);
        const requestId = crypto.randomUUID();
        port.onMessage.addListener((value) => {
          try {
            finish2(readinessResponse(value, requestId));
          } catch {
            finish2({ status: "error", checkedAt: Date.now(), message: "\uBC31\uC2E0 \uB3C4\uC6B0\uBBF8\uC758 \uC0C1\uD0DC \uC751\uB2F5\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uCD5C\uC2E0 \uB3C4\uC6B0\uBBF8\uB85C \uB2E4\uC2DC \uC124\uCE58\uD558\uC138\uC694." });
          }
        });
        port.onDisconnect.addListener(() => {
          const message = chrome.runtime.lastError?.message;
          finish2({ status: "unavailable", checkedAt: Date.now(), message: message ? `\uB85C\uCEEC \uBC31\uC2E0 \uC5F0\uACB0 \uC2E4\uD328: ${message.slice(0, 300)}` : "\uB85C\uCEEC \uBC31\uC2E0 \uB3C4\uC6B0\uBBF8 \uC5F0\uACB0\uC774 \uC885\uB8CC\uB410\uC2B5\uB2C8\uB2E4. \uC124\uCE58 \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uC138\uC694." });
        });
        timer = setTimeout(() => finish2({ status: "error", checkedAt: Date.now(), message: "\uBC31\uC2E0 \uC5F0\uACB0 \uC0C1\uD0DC \uD655\uC778\uC774 \uC81C\uD55C \uC2DC\uAC04\uC744 \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4." }), 6e4);
        port.postMessage({ version: 1, action: "status", requestId });
      } catch {
        finish2({ status: "unavailable", checkedAt: Date.now(), message: "\uB85C\uCEEC \uBC31\uC2E0 \uB3C4\uC6B0\uBBF8\uC5D0 \uC5F0\uACB0\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uC124\uCE58\uC640 \uAD8C\uD55C\uC744 \uD655\uC778\uD558\uC138\uC694." });
      }
    });
  })().finally(() => {
    readinessPending = void 0;
  });
  return readinessPending;
}
async function scanFile(path) {
  return navigator.locks.request("my-video-app-antivirus", async () => {
    if (!await chrome.permissions.contains({ permissions: ["nativeMessaging"] })) return { status: "unavailable", message: "\uB85C\uCEEC \uBC31\uC2E0 \uC5F0\uACB0 \uAD8C\uD55C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4. \uBC31\uC2E0 \uB3C4\uC6B0\uBBF8 \uC124\uCE58 \uD6C4 \u2018\uB85C\uCEEC \uBC31\uC2E0 \uC5F0\uACB0\u2019\uC744 \uB20C\uB7EC \uC8FC\uC138\uC694." };
    return new Promise((resolve) => {
      let port;
      let timer;
      let settled = false;
      const finish2 = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try {
          port?.disconnect();
        } catch {
        }
        resolve(result);
      };
      try {
        port = chrome.runtime.connectNative(ANTIVIRUS_HOST);
        const requestId = crypto.randomUUID();
        port.onMessage.addListener((value) => {
          try {
            finish2(scanResponse(value, requestId));
          } catch {
            finish2({ status: "error", message: "\uBC31\uC2E0 \uC751\uB2F5\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC544 \uAC80\uC0AC \uC644\uB8CC\uB85C \uCC98\uB9AC\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4." });
          }
        });
        port.onDisconnect.addListener(() => {
          const message = chrome.runtime.lastError?.message;
          finish2({ status: "unavailable", message: message ? `\uB85C\uCEEC \uBC31\uC2E0 \uC5F0\uACB0 \uC2E4\uD328: ${message.slice(0, 300)}` : "\uB85C\uCEEC \uBC31\uC2E0 \uB3C4\uC6B0\uBBF8\uAC00 \uC5F0\uACB0\uC744 \uC885\uB8CC\uD588\uC2B5\uB2C8\uB2E4. \uC124\uCE58 \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uC138\uC694." });
        });
        timer = setTimeout(() => finish2({ status: "error", message: "\uBC31\uC2E0 \uAC80\uC0AC\uAC00 \uC81C\uD55C \uC2DC\uAC04\uC744 \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4. \uAC80\uC0AC\uB418\uC9C0 \uC54A\uC740 \uD30C\uC77C\uC785\uB2C8\uB2E4." }), 24e4);
        port.postMessage({ version: 1, action: "scan", requestId, path });
      } catch {
        finish2({ status: "unavailable", message: "\uB85C\uCEEC \uBC31\uC2E0 \uB3C4\uC6B0\uBBF8\uC5D0 \uC5F0\uACB0\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uC124\uCE58\uC640 \uAD8C\uD55C\uC744 \uD655\uC778\uD558\uC138\uC694." });
      }
    });
  });
}

// src/local/background.ts
var media = new MediaCatalog();
var discoveryEpochs = /* @__PURE__ */ new Map();
var privateHistory = /* @__PURE__ */ new Map();
var cancelled = /* @__PURE__ */ new Set();
var finalizing = /* @__PURE__ */ new Set();
var finalizeAgain = /* @__PURE__ */ new Set();
var deciding = /* @__PURE__ */ new Set();
var activeStates = ACTIVE_HISTORY_STATES;
var lastTab;
var creatingOffscreen;
async function history() {
  if (chrome.extension.inIncognitoContext) return retainHistory([...privateHistory.values()]);
  const raw = (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY];
  return retainHistory(Array.isArray(raw) ? raw.filter(isHistory).filter((row) => !row.incognito) : []);
}
function updatePrivate(item) {
  const retained = retainHistory([item, ...privateHistory.values()].filter((row, index) => index === 0 || row.id !== item.id));
  privateHistory.clear();
  for (const row of retained) privateHistory.set(row.id, row);
}
async function update(item, onlyIfPreparing = false) {
  if (item.incognito) {
    if (!onlyIfPreparing || privateHistory.get(item.id)?.state === "preparing") updatePrivate(item);
    return;
  }
  await navigator.locks.request("my-video-app-history", async () => {
    const current = await history();
    if (onlyIfPreparing && current.find((row) => row.id === item.id)?.state !== "preparing") return;
    const existing = current.filter((row) => !row.incognito && row.id !== item.id);
    await chrome.storage.local.set({ [HISTORY_KEY]: retainHistory([item, ...existing]) });
  });
}
async function change(id, edit) {
  return navigator.locks.request("my-video-app-history", async () => {
    const rows = await history();
    const current = rows.find((row) => row.id === id);
    if (!current) return void 0;
    const next = edit(current);
    if (!next) return void 0;
    if (next.incognito) updatePrivate(next);
    else await chrome.storage.local.set({ [HISTORY_KEY]: rows.filter((row) => !row.incognito).map((row) => row.id === id ? next : row) });
    return next;
  });
}
async function reviewNotice(item) {
  if (item.incognito) return;
  await chrome.notifications.create(`my-video-app-security:${item.id}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("bitmaps/logo-128-color.png"),
    title: "\uB2E4\uC6B4\uB85C\uB4DC \uD30C\uC77C \uD655\uC778 \uD544\uC694",
    message: `${item.filename}
${item.security?.status === "infected" || item.security?.status === "chrome-warning" ? "\uC704\uD5D8\uC774 \uD0D0\uC9C0\uB418\uC5C8\uC2B5\uB2C8\uB2E4." : "\uBC31\uC2E0 \uAC80\uC0AC\uAC00 \uC644\uB8CC\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4."} \uC571\uC5D0\uC11C \uC0AD\uC81C \uB610\uB294 \uAC80\uD1A0\uB97C \uC120\uD0DD\uD558\uC138\uC694.`,
    requireInteraction: true
  }).catch(() => {
  });
}
async function missingDownload(item) {
  const next = await change(item.id, (row) => ["downloading", "scanning"].includes(row.state) ? { ...row, state: "review", security: { status: "error", token: crypto.randomUUID(), message: "Chrome \uB2E4\uC6B4\uB85C\uB4DC \uAE30\uB85D\uC774 \uC5C6\uC5B4 \uD30C\uC77C \uAC80\uC0AC\uB97C \uC644\uB8CC\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. \uC800\uC7A5\uD55C \uD30C\uC77C\uC744 \uC9C1\uC811 \uD655\uC778\uD558\uC138\uC694." } } : void 0);
  if (item.downloadId !== void 0) await revokeDownloadOffers(item.downloadId).catch(() => {
  });
  if (next) await reviewNotice(next);
}
function add(tabId, address, mime, title, fromElement, size, observed) {
  try {
    const url = mediaURL(address).href;
    const existing = media.get(tabId, url);
    const mergedMime = mime || existing?.mime || "";
    const kind = existing && existing.kind !== "file" ? existing.kind : mediaKind(url, mergedMime, fromElement);
    if (!kind) return;
    const item = { ...existing, id: existing?.id ?? crypto.randomUUID(), tabId, url, title: (title || existing?.title || "").slice(0, 200), mime: mergedMime.slice(0, 100), kind, createdAt: Date.now() };
    if (Number.isSafeInteger(size) && size > 0) item.size = size;
    const protocol = transport(observed);
    if (protocol) item.observedTransport = protocol;
    media.set(item);
  } catch {
  }
}
async function ensureOffscreen() {
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    if (!await chrome.offscreen.hasDocument()) await chrome.offscreen.createDocument({
      url: "local/offscreen.html",
      reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.DOM_PARSER],
      justification: "Prepare local media files and run the local stream remux worker."
    });
  })();
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = void 0;
  }
}
async function dispose(id) {
  if (await chrome.offscreen.hasDocument()) await chrome.runtime.sendMessage({ scope: OFFSCREEN_SCOPE, type: "dispose", id }).catch(() => {
  });
  await (await navigator.storage.getDirectory()).removeEntry(`local-${id}.media`).catch(() => {
  });
}
async function finish(download2) {
  if (finalizing.has(download2.id) || deciding.has(download2.id)) {
    finalizeAgain.add(download2.id);
    return;
  }
  finalizing.add(download2.id);
  try {
    const item = (await history()).find((row) => row.downloadId === download2.id && ["downloading", "scanning", "review", "complete"].includes(row.state));
    if (!item) return;
    const current = (await chrome.downloads.search({ id: download2.id }))[0];
    if (!current) {
      await missingDownload(item);
      return;
    }
    const danger = chromeWarning(current.danger);
    if (danger) {
      if (item.state === "review" && item.security?.status === "chrome-warning" && item.security.danger === danger) return;
      const next2 = await change(item.id, (row) => ["downloading", "scanning", "review", "complete"].includes(row.state) ? { ...row, state: "review", security: { status: "chrome-warning", token: crypto.randomUUID(), danger, message: "Chrome\uC774 \uC774 \uD30C\uC77C\uC744 \uACBD\uACE0\uD558\uAC70\uB098 \uAC80\uC0AC \uC911\uC785\uB2C8\uB2E4. Chrome \uB2E4\uC6B4\uB85C\uB4DC \uD654\uBA74\uC5D0\uC11C \uD655\uC778\uD558\uC138\uC694." } } : void 0);
      await revokeDownloadOffers(current.id).catch(() => {
      });
      if (next2) await reviewNotice(next2);
      return;
    }
    if (current.state === "interrupted") {
      if (item.state === "complete") return;
      await change(item.id, (row) => ({ ...row, state: cancelled.has(row.id) || current.error === "USER_CANCELED" ? "cancelled" : "error", error: current.error || "\uB2E4\uC6B4\uB85C\uB4DC\uAC00 \uC911\uB2E8\uB418\uC5C8\uC2B5\uB2C8\uB2E4." }));
      await dispose(item.id);
      cancelled.delete(item.id);
      return;
    }
    if (current.state !== "complete") {
      if (item.state === "review" && item.security?.status === "chrome-warning") await change(item.id, (row) => ({ ...row, state: "downloading" }));
      return;
    }
    if (item.state === "complete" || item.state === "review" && item.security?.status !== "chrome-warning") return;
    const scanning = await change(item.id, (row) => ["downloading", "scanning", "review"].includes(row.state) ? { ...row, state: "scanning", security: { status: "scanning", token: crypto.randomUUID() } } : void 0);
    if (!scanning) return;
    let result;
    try {
      result = await scanFile(current.filename);
    } catch {
      result = { status: "error", message: "\uB85C\uCEEC \uBC31\uC2E0 \uAC80\uC0AC\uB97C \uC644\uB8CC\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4." };
    }
    const latest = (await chrome.downloads.search({ id: current.id }))[0];
    if (!latest) {
      await missingDownload(scanning);
      return;
    }
    if (latest.state !== "complete" || chromeWarning(latest.danger)) {
      finalizeAgain.add(current.id);
      return;
    }
    if (latest.filename !== current.filename || ["clean", "infected"].includes(result.status) && latest.fileSize >= 0 && result.size !== latest.fileSize) {
      result = { status: "error", message: "\uB2E4\uC6B4\uB85C\uB4DC \uD30C\uC77C \uC815\uBCF4\uAC00 \uAC80\uC0AC \uACB0\uACFC\uC640 \uC77C\uCE58\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uB2E4\uC2DC \uAC80\uC0AC\uD558\uC138\uC694." };
    }
    const next = await change(item.id, (row) => row.state === "scanning" && row.security?.token === scanning.security?.token ? { ...row, state: result.status === "clean" ? "complete" : "review", security: { ...result, token: crypto.randomUUID() } } : void 0);
    if (!next) return;
    if (next.state === "review") {
      await reviewNotice(next);
      return;
    }
    await chrome.notifications.clear(`my-video-app-security:${item.id}`).catch(() => {
    });
    const beforeOffer = (await chrome.downloads.search({ id: current.id }))[0];
    if (!beforeOffer || beforeOffer.state !== "complete" || chromeWarning(beforeOffer.danger)) {
      await revokeDownloadOffers(current.id).catch(() => {
      });
      if (beforeOffer) finalizeAgain.add(current.id);
      return;
    }
    authorizeDownloadOffers(current.id);
    await offerUpscale({ internalFilename: `local-${item.id}.media`, filename: item.filename, downloadId: current.id, success: true, incognito: item.incognito, expectedSha256: result.sha256, expectedSize: result.size });
    const afterOffer = (await chrome.downloads.search({ id: current.id }))[0];
    if (afterOffer && chromeWarning(afterOffer.danger)) {
      await revokeDownloadOffers(current.id).catch(() => {
      });
      finalizeAgain.add(current.id);
    }
    await dispose(item.id);
    cancelled.delete(item.id);
  } finally {
    finalizing.delete(download2.id);
    if (finalizeAgain.delete(download2.id) && !deciding.has(download2.id)) void chrome.downloads.search({ id: download2.id }).then((items) => items[0] && finish(items[0])).catch(() => {
    });
  }
}
async function securityDecision(id, token, action) {
  const item = (await history()).find((row) => row.id === id && row.state === "review" && row.security?.token === token);
  if (!item || item.downloadId === void 0 || deciding.has(item.downloadId)) throw new Error("\uAC80\uC0AC \uC0C1\uD0DC\uAC00 \uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uAE30\uB85D\uC744 \uC0C8\uB85C\uACE0\uCE68\uD558\uC138\uC694.");
  deciding.add(item.downloadId);
  try {
    const current = (await chrome.downloads.search({ id: item.downloadId }))[0];
    if (!current) {
      if (action !== "keep" || item.security?.status === "chrome-warning") throw new Error("Chrome \uB2E4\uC6B4\uB85C\uB4DC \uAE30\uB85D\uC774 \uC5C6\uC5B4 \uC790\uB3D9 \uC0AD\uC81C\xB7\uC7AC\uAC80\uC0AC\uB97C \uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uC800\uC7A5\uD55C \uD30C\uC77C\uC744 \uC9C1\uC811 \uD655\uC778\uD558\uC138\uC694.");
      const next = await change(id, (row) => row.state === "review" && row.security?.token === token ? { ...row, state: "complete", security: { ...row.security, token: crypto.randomUUID(), decision: "keep" } } : void 0);
      if (!next) throw new Error("\uAC80\uC0AC \uC0C1\uD0DC\uAC00 \uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      await dispose(id);
      await chrome.notifications.clear(`my-video-app-security:${id}`).catch(() => {
      });
      return;
    }
    if (action !== "delete" && (current.state !== "complete" || chromeWarning(current.danger) || current.exists === false)) throw new Error("Chrome\uC758 \uACBD\uACE0\uB97C \uBA3C\uC800 \uD655\uC778\uD558\uACE0 \uD30C\uC77C \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uC138\uC694.");
    const claimed = await change(id, (row) => row.state === "review" && row.security?.token === token ? { ...row, security: { ...row.security, token: crypto.randomUUID() } } : void 0);
    if (!claimed) throw new Error("\uAC80\uC0AC \uC0C1\uD0DC\uAC00 \uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
    if (action === "delete") {
      try {
        if (current.state === "in_progress") await chrome.downloads.cancel(current.id);
        const latest = (await chrome.downloads.search({ id: current.id }))[0];
        if (latest?.exists !== false) await chrome.downloads.removeFile(current.id);
        await change(id, (row) => ({ ...row, state: "discarded", security: { ...claimed.security, decision: "delete" } }));
        await revokeDownloadOffers(current.id).catch(() => {
        });
        await dispose(id);
      } catch {
        await change(id, (row) => ({ ...row, state: "review", security: { ...claimed.security, token: crypto.randomUUID(), message: "\uD30C\uC77C \uC0AD\uC81C\uB97C \uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. Chrome \uB2E4\uC6B4\uB85C\uB4DC \uD654\uBA74\uC5D0\uC11C \uD30C\uC77C\uC744 \uD655\uC778\uD558\uAC70\uB098 \uB2E4\uC2DC \uC0AD\uC81C\uD558\uC138\uC694." } }));
        throw new Error("\uD30C\uC77C\uC744 \uC0AD\uC81C\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. \uD655\uC778 \uB300\uAE30 \uC0C1\uD0DC\uB97C \uC720\uC9C0\uD569\uB2C8\uB2E4.");
      }
    } else if (action === "keep") {
      await change(id, (row) => ({ ...row, state: "complete", security: { ...claimed.security, decision: "keep" } }));
      await dispose(id);
    } else {
      await change(id, (row) => ({ ...row, state: "scanning", security: { status: "scanning", token: crypto.randomUUID() } }));
    }
    await chrome.notifications.clear(`my-video-app-security:${id}`).catch(() => {
    });
  } finally {
    deciding.delete(item.downloadId);
    const current = (await chrome.downloads.search({ id: item.downloadId }))[0];
    if (current) void finish(current).catch(() => {
    });
  }
}
async function download(item, options = downloadOptions()) {
  const tab = item.tabId < 0 ? { incognito: chrome.extension.inIncognitoContext } : await chrome.tabs.get(item.tabId);
  if (!!tab.incognito !== chrome.extension.inIncognitoContext) throw new Error("\uB2E4\uB978 \uBE0C\uB77C\uC6B0\uC9D5 \uBAA8\uB4DC\uC758 \uBBF8\uB514\uC5B4\uC5D0\uB294 \uC811\uADFC\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
  const filename = filenameFor(item);
  const entry = { id: crypto.randomUUID(), url: item.url, filename: options.output === "original" ? filename : filename.replace(/\.[^.]+$/, "") + "." + options.output, kind: item.kind, state: "preparing", createdAt: Date.now(), incognito: !!tab.incognito || chrome.extension.inIncognitoContext, options };
  await navigator.locks.request("my-video-app-start", async () => {
    const active = (await history()).filter((row) => activeStates.includes(row.state));
    if (active.some((row) => row.url === item.url && (row.options?.quality ?? "highest") === options.quality && (row.options?.output ?? "original") === options.output)) throw new Error("\uAC19\uC740 \uBBF8\uB514\uC5B4\uB97C \uC774\uBBF8 \uCC98\uB9AC\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4.");
    if (active.length >= 8) throw new Error("\uB3D9\uC2DC\uC5D0 \uC900\uBE44\xB7\uB2E4\uC6B4\uB85C\uB4DC\uD558\uB294 \uD30C\uC77C\uC740 \uCD5C\uB300 8\uAC1C\uC785\uB2C8\uB2E4.");
    await update(entry);
  });
  void (async () => {
    try {
      let address = item.url;
      let transferProtocols = [];
      const offers = (await chrome.storage.local.get(OFFER_KEY))[OFFER_KEY] !== false;
      if (options.output !== "original" || item.kind !== "file" || offers && !entry.incognito && (!item.size || item.size <= MAX_INPUT_BYTES)) {
        try {
          await ensureOffscreen();
          if (cancelled.has(entry.id)) throw new DOMException("\uC791\uC5C5\uC744 \uCDE8\uC18C\uD588\uC2B5\uB2C8\uB2E4.", "AbortError");
          const result = await chrome.runtime.sendMessage({ scope: OFFSCREEN_SCOPE, type: "prepare", id: entry.id, url: item.url, kind: item.kind, options });
          if (!record(result) || result.ok !== true || typeof result.url !== "string" || !result.url.startsWith(`blob:${chrome.runtime.getURL("")}`)) throw new Error(record(result) && typeof result.error === "string" ? result.error : "\uD30C\uC77C\uC744 \uC900\uBE44\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
          address = result.url;
          if (Array.isArray(result.protocols)) transferProtocols = result.protocols.map(transport).filter((value) => value !== void 0);
        } catch (error) {
          if (options.output !== "original" || item.kind !== "file" || cancelled.has(entry.id)) throw error;
          address = item.url;
        }
      }
      if (cancelled.has(entry.id)) throw new Error("\uC791\uC5C5\uC744 \uCDE8\uC18C\uD588\uC2B5\uB2C8\uB2E4.");
      const id = await chrome.downloads.download({ url: address, filename: entry.filename, saveAs: true, conflictAction: "uniquify" });
      const downloading = { ...entry, state: "downloading", downloadId: id, transferProtocols };
      await update(downloading);
      if (cancelled.has(entry.id)) await chrome.downloads.cancel(id).catch(() => {
      });
      const current = (await chrome.downloads.search({ id }))[0];
      if (current) await finish(current);
    } catch (error) {
      const message = error instanceof Error ? error.message : "\uB2E4\uC6B4\uB85C\uB4DC \uC624\uB958";
      const wasCancelled = cancelled.has(entry.id) || /canceled by the user/i.test(message);
      await update({ ...entry, state: wasCancelled ? "cancelled" : "error", error: wasCancelled ? "\uC791\uC5C5\uC744 \uCDE8\uC18C\uD588\uC2B5\uB2C8\uB2E4." : message.slice(0, 500) });
      await dispose(entry.id).catch(() => {
      });
      cancelled.delete(entry.id);
      if (entry.incognito) privateHistory.delete(entry.id);
    }
  })();
  return entry;
}
async function currentTab() {
  const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true })).find((tab2) => !!tab2.incognito === chrome.extension.inIncognitoContext);
  if (tab?.id !== void 0 && tab.url && /^https?:/.test(tab.url)) return tab.id;
  return lastTab ?? Array.from(media.tabIds()).at(-1);
}
async function handleLocalMessage(value, sender) {
  if (!record(value) || value.scope !== SCOPE || typeof value.type !== "string" || !boundedData(value, 128 * 1024)) throw new Error("\uC798\uBABB\uB41C \uC694\uCCAD\uC785\uB2C8\uB2E4.");
  if (value.type === "preparing-progress") {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("local/offscreen.html")) throw new Error("\uD5C8\uC6A9\uB418\uC9C0 \uC54A\uC740 \uBC1C\uC2E0\uC790\uC785\uB2C8\uB2E4.");
    if (typeof value.id === "string" && ["queued", "fetching", "processing", "saving"].includes(String(value.stage))) {
      const item = (await history()).find((row) => row.id === value.id && row.state === "preparing");
      if (item) {
        const preparation = { stage: value.stage };
        if (typeof value.progress === "number" && Number.isFinite(value.progress)) preparation.progress = Math.max(0, Math.min(1, value.progress));
        for (const key of ["loaded", "total"]) if (typeof value[key] === "number" && Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= MAX_INPUT_BYTES) preparation[key] = value[key];
        await update({ ...item, preparation }, true);
      }
    }
    return { ok: true };
  }
  if (value.type === "capture") {
    if (!trustedCapture(sender, chrome.runtime.id) || !Array.isArray(value.items) || value.items.length > 100) throw new Error("\uD5C8\uC6A9\uB418\uC9C0 \uC54A\uC740 \uC218\uC9D1 \uC694\uCCAD\uC785\uB2C8\uB2E4.");
    if (!!sender.tab?.incognito !== chrome.extension.inIncognitoContext) throw new Error("\uB2E4\uB978 \uBE0C\uB77C\uC6B0\uC9D5 \uBAA8\uB4DC\uC758 \uC218\uC9D1 \uC694\uCCAD\uC785\uB2C8\uB2E4.");
    for (const item of value.items) if (record(item) && typeof item.url === "string") add(sender.tab.id, item.url, typeof item.mime === "string" ? item.mime : "", typeof item.title === "string" ? item.title : "", item.fromElement === true, void 0, item.observedTransport);
    return { ok: true };
  }
  if (!trustedUI(sender, chrome.runtime.id, chrome.runtime.getURL(""))) throw new Error("\uD655\uC7A5 \uD654\uBA74\uC5D0\uC11C\uB9CC \uC0AC\uC6A9\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
  if (value.type === "antivirus-status") return { ok: true, antivirus: await probeAntivirus() };
  if (["security-keep", "security-delete", "security-rescan"].includes(value.type) && typeof value.id === "string" && typeof value.token === "string") {
    if (value.type === "security-keep" && value.confirmed !== true) throw new Error("\uD30C\uC77C\uC758 \uC704\uD5D8\uC744 \uC774\uD574\uD588\uB2E4\uB294 \uD655\uC778\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.");
    await securityDecision(value.id, value.token, value.type === "security-keep" ? "keep" : value.type === "security-delete" ? "delete" : "rescan");
    return { ok: true };
  }
  if (value.type === "security-connect") {
    if (!await chrome.permissions.contains({ permissions: ["nativeMessaging"] })) throw new Error("\uB85C\uCEEC \uBC31\uC2E0 \uC5F0\uACB0 \uAD8C\uD55C\uC744 \uBA3C\uC800 \uD5C8\uC6A9\uD558\uC138\uC694.");
    const antivirus = await probeAntivirus();
    for (const item of await history()) if (antivirus.status === "ready" && item.state === "review" && item.security && ["unavailable", "error"].includes(item.security.status)) {
      await securityDecision(item.id, item.security.token, "rescan").catch(() => {
      });
    }
    return { ok: true, antivirus };
  }
  if (value.type === "review-chrome" && typeof value.id === "string" && typeof value.token === "string") {
    const item = (await history()).find((row) => row.id === value.id && row.state === "review" && row.security?.token === value.token);
    if (!item) throw new Error("\uAC80\uC0AC \uC0C1\uD0DC\uAC00 \uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
    await chrome.tabs.create({ url: "chrome://downloads/" });
    return { ok: true };
  }
  if (value.type === "list") {
    const tabId = await currentTab();
    const items = tabId === void 0 ? [] : Array.from(media.items(tabId)).sort((a, b) => b.createdAt - a.createdAt);
    const rows = await history();
    const progress = await Promise.all(rows.map(async (row) => {
      if (row.state !== "downloading" || row.downloadId === void 0) return row;
      const download2 = (await chrome.downloads.search({ id: row.downloadId }).catch(() => []))[0];
      return download2 ? { ...row, receivedBytes: download2.bytesReceived, totalBytes: download2.totalBytes } : row;
    }));
    return { ok: true, items, history: progress, tabId };
  }
  if (value.type === "download" && typeof value.id === "string") {
    const item = media.find(value.id);
    if (!item) throw new Error("\uBBF8\uB514\uC5B4\uAC00 \uB9CC\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uC6D0\uB798 \uD398\uC774\uC9C0\uB97C \uC0C8\uB85C\uACE0\uCE68\uD558\uC138\uC694.");
    return { ok: true, item: await download(item, downloadOptions(value.options)) };
  }
  if (value.type === "download-url" && typeof value.url === "string") {
    const url = mediaURL(value.url).href;
    return { ok: true, item: await download({ id: crypto.randomUUID(), tabId: -1, url, title: "", mime: "", kind: mediaKind(url) ?? "file", createdAt: Date.now() }, downloadOptions(value.options)) };
  }
  if (value.type === "retry" && typeof value.id === "string") {
    const item = (await history()).find((row) => row.id === value.id && ["error", "cancelled"].includes(row.state));
    if (!item) throw new Error("\uB2E4\uC2DC \uC2DC\uB3C4\uD560 \uB2E4\uC6B4\uB85C\uB4DC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.");
    return { ok: true, item: await download({ id: crypto.randomUUID(), tabId: -1, url: mediaURL(item.url).href, title: item.filename, mime: "", kind: item.kind, createdAt: Date.now() }, downloadOptions(item.options)) };
  }
  if (value.type === "cancel" && typeof value.id === "string") {
    const item = (await history()).find((row) => row.id === value.id);
    if (!item || !["preparing", "downloading"].includes(item.state)) throw new Error("\uC9C4\uD589 \uC911\uC778 \uC791\uC5C5\uC774 \uC544\uB2D9\uB2C8\uB2E4.");
    cancelled.add(item.id);
    if (item.downloadId !== void 0) await chrome.downloads.cancel(item.downloadId);
    else if (await chrome.offscreen.hasDocument()) await chrome.runtime.sendMessage({ scope: OFFSCREEN_SCOPE, type: "cancel", id: item.id });
    return { ok: true };
  }
  if (value.type === "show-file" && typeof value.id === "string") {
    const item = (await history()).find((row) => row.id === value.id);
    if (!item || item.state !== "complete" || item.downloadId === void 0) throw new Error("\uC644\uB8CC\uB41C \uB2E4\uC6B4\uB85C\uB4DC\uAC00 \uC544\uB2D9\uB2C8\uB2E4.");
    const current = (await chrome.downloads.search({ id: item.downloadId }))[0];
    if (!current || current.exists === false || chromeWarning(current.danger)) {
      if (current) void finish(current).catch(() => {
      });
      throw new Error("\uD30C\uC77C \uC0C1\uD0DC\uAC00 \uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4. Chrome \uB2E4\uC6B4\uB85C\uB4DC \uD654\uBA74\uC5D0\uC11C \uD655\uC778\uD558\uC138\uC694.");
    }
    chrome.downloads.show(item.downloadId);
    return { ok: true };
  }
  if (value.type === "clear-history") {
    await navigator.locks.request("my-video-app-history", async () => {
      if (chrome.extension.inIncognitoContext) {
        for (const [id, row] of privateHistory) if (!activeStates.includes(row.state)) privateHistory.delete(id);
      } else await chrome.storage.local.set({ [HISTORY_KEY]: (await history()).filter((row) => activeStates.includes(row.state)) });
    });
    return { ok: true };
  }
  if (value.type === "upscale") {
    await chrome.tabs.create({ url: chrome.runtime.getURL("upscale/index.html") });
    return { ok: true };
  }
  throw new Error("\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uC694\uCCAD\uC785\uB2C8\uB2E4.");
}
chrome.runtime.onMessage.addListener((value, sender, reply) => {
  if (!record(value) || value.scope !== SCOPE) return false;
  void handleLocalMessage(value, sender).then(reply).catch((error) => reply({ ok: false, error: error instanceof Error ? error.message : "\uC694\uCCAD \uC624\uB958" }));
  return true;
});
chrome.webRequest.onHeadersReceived.addListener((details) => {
  if (details.tabId < 0 || details.statusCode < 200 || details.statusCode >= 300) return void 0;
  const type = details.responseHeaders?.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
  try {
    if (!mediaKind(details.url, type)) return void 0;
  } catch {
    return void 0;
  }
  const header = (name) => details.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value;
  const size = Number(details.statusCode === 206 ? header("content-range")?.match(/^bytes \d+-\d+\/(\d+)$/i)?.[1] : header("content-length"));
  const epoch = discoveryEpochs.get(details.tabId) ?? {};
  discoveryEpochs.set(details.tabId, epoch);
  void chrome.tabs.get(details.tabId).then((tab) => {
    if (discoveryEpochs.get(details.tabId) === epoch && !!tab.incognito === chrome.extension.inIncognitoContext) add(details.tabId, details.url, type, "", false, size);
  }).catch(() => {
  });
  return void 0;
}, { urls: ["http://*/*", "https://*/*"] }, ["responseHeaders"]);
chrome.downloads.onChanged.addListener((delta) => {
  if (chromeWarning(delta.danger?.current)) void revokeDownloadOffers(delta.id).catch(() => {
  });
  if (delta.state || delta.danger) void chrome.downloads.search({ id: delta.id }).then((items) => {
    if (items[0]) return finish(items[0]);
  }).catch(() => {
  });
});
chrome.notifications.onClicked.addListener((id) => {
  if (!/^my-video-app-security:[a-f0-9-]{36}$/.test(id)) return;
  void chrome.tabs.create({ url: chrome.runtime.getURL("local/index.html?view=history") });
});
chrome.tabs.onRemoved.addListener((id) => {
  media.deleteTab(id);
  discoveryEpochs.delete(id);
  if (lastTab === id) lastTab = void 0;
});
chrome.tabs.onUpdated.addListener((id, changes, tab) => {
  if (!!tab.incognito !== chrome.extension.inIncognitoContext) return;
  if (changes.status === "loading") {
    media.deleteTab(id);
    discoveryEpochs.set(id, {});
  }
  if (tab.active && tab.url && /^https?:/.test(tab.url)) lastTab = id;
});
chrome.tabs.onActivated.addListener((info) => {
  void chrome.tabs.get(info.tabId).then((tab) => {
    if (!!tab.incognito === chrome.extension.inIncognitoContext && tab.url && /^https?:/.test(tab.url)) lastTab = info.tabId;
  }).catch(() => {
  });
});
async function setup(restarted = false) {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => chrome.action.setPopup({ popup: "local/index.html" }));
  if (!chrome.extension.inIncognitoContext) {
    const ids = new Set((await jobs()).map((job) => job.downloadId).filter((id) => id !== void 0));
    for (const id of ids) {
      const current = (await chrome.downloads.search({ id }))[0];
      if (!current || current.state !== "complete" || chromeWarning(current.danger)) await revokeDownloadOffers(id).catch(() => {
      });
    }
  }
  for (const item of await history()) {
    if (restarted && item.state === "preparing") {
      await update({ ...item, state: "error", error: "\uBE0C\uB77C\uC6B0\uC800\uAC00 \uB2E4\uC2DC \uC2DC\uC791\uB418\uC5B4 \uC900\uBE44 \uC791\uC5C5\uC774 \uC911\uB2E8\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uB2E4\uC2DC \uB2E4\uC6B4\uB85C\uB4DC\uD558\uC138\uC694." });
      await dispose(item.id).catch(() => {
      });
    } else if (["downloading", "scanning", "review", "complete"].includes(item.state) && item.downloadId !== void 0) {
      const current = (await chrome.downloads.search({ id: item.downloadId }))[0];
      if (current) await finish(current);
      else await missingDownload(item);
    }
  }
  const keep = new Set((await history()).filter((item) => activeStates.includes(item.state)).map((item) => `local-${item.id}.media`));
  const root = await navigator.storage.getDirectory();
  for await (const name of root.keys()) if (/^local-[0-9a-f-]{36}\.media$/.test(name) && !keep.has(name)) await root.removeEntry(name).catch(() => {
  });
}
chrome.runtime.onInstalled.addListener(() => {
  void setup(true).catch(() => {
  });
});
chrome.runtime.onStartup.addListener(() => {
  void setup(true).catch(() => {
  });
});
void setup().catch(() => {
});
chrome.commands.onCommand.addListener((command) => {
  if (command !== "default-action") return;
  void currentTab().then((id) => {
    const item = id === void 0 ? void 0 : media.items(id).next().value;
    if (item) return download(item);
  }).catch(() => {
  });
});
export {
  handleLocalMessage
};
