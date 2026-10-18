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
      for (const key of Object.keys(item)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") return false;
        chars += key.length;
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
  return isJobId(v.id) && typeof v.filename === "string" && v.filename.length <= 240 && Number.isSafeInteger(v.size) && v.size > 0 && v.size <= MAX_INPUT_BYTES && typeof v.createdAt === "number" && Number.isFinite(v.createdAt);
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
async function offerUpscale(event) {
  const pending = serial.then(() => withQueueLock(async () => {
    if (!event.success || event.incognito || !Number.isInteger(event.downloadId)) return;
    if ((await chrome.storage.local.get(OFFER_KEY))[OFFER_KEY] === false) return;
    const root = await navigator.storage.getDirectory();
    const source = await (await root.getFileHandle(event.internalFilename)).getFile();
    if (!source.size || source.size > MAX_INPUT_BYTES || !sniffMedia(new Uint8Array(await source.slice(0, 16).arrayBuffer()))) return;
    const retained = await cleanupUnlocked();
    if (retained.length >= MAX_JOBS || retained.reduce((total, job2) => total + job2.size, 0) + source.size > MAX_QUEUE_BYTES) return;
    const job = { id: crypto.randomUUID(), filename: safeBasename(event.filename), size: source.size, createdAt: Date.now() };
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

// src/local/model.ts
var SCOPE = "my-video-app/local";
var OFFSCREEN_SCOPE = "my-video-app/offscreen";
var HISTORY_KEY = "my_video_app_history_v1";
var MAX_HISTORY = 200;
var MAX_MEDIA_PER_TAB = 200;
var MAX_STREAM_BYTES = 128 * 1024 * 1024;
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
  return record(value) && typeof value.id === "string" && /^[a-f0-9-]{36}$/.test(value.id) && typeof value.url === "string" && typeof value.filename === "string" && ["file", "hls", "dash"].includes(String(value.kind)) && ["preparing", "downloading", "complete", "cancelled", "error"].includes(String(value.state)) && typeof value.createdAt === "number" && Number.isFinite(value.createdAt) && typeof value.incognito === "boolean";
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

// src/local/background.ts
var media = /* @__PURE__ */ new Map();
var privateHistory = /* @__PURE__ */ new Map();
var cancelled = /* @__PURE__ */ new Set();
var finalizing = /* @__PURE__ */ new Set();
var lastTab;
var creatingOffscreen;
async function history() {
  const raw = (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY];
  return [...Array.isArray(raw) ? raw.filter(isHistory) : [], ...privateHistory.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_HISTORY);
}
async function update(item) {
  if (item.incognito) {
    privateHistory.set(item.id, item);
    return;
  }
  await navigator.locks.request("my-video-app-history", async () => {
    const existing = (await history()).filter((row) => !row.incognito && row.id !== item.id);
    const rows = [item, ...existing];
    const active = rows.filter((row) => row.state === "preparing" || row.state === "downloading");
    const completed = rows.filter((row) => row.state !== "preparing" && row.state !== "downloading");
    await chrome.storage.local.set({ [HISTORY_KEY]: [...active, ...completed.slice(0, Math.max(0, MAX_HISTORY - active.length))] });
  });
}
function add(tabId, address, mime, title, fromElement, size) {
  try {
    const url = mediaURL(address).href;
    const kind = mediaKind(url, mime, fromElement);
    if (!kind) return;
    const items = media.get(tabId) ?? /* @__PURE__ */ new Map();
    const existing = items.get(url);
    const item = { id: existing?.id ?? crypto.randomUUID(), tabId, url, title: title.slice(0, 200), mime: mime.slice(0, 100), kind, createdAt: Date.now() };
    if (Number.isSafeInteger(size) && size > 0) item.size = size;
    items.set(url, item);
    while (items.size > MAX_MEDIA_PER_TAB) items.delete(Array.from(items).find(([, entry]) => entry.kind === "file")?.[0] ?? items.keys().next().value);
    media.set(tabId, items);
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
  if (!["complete", "interrupted"].includes(download2.state) || finalizing.has(download2.id)) return;
  finalizing.add(download2.id);
  try {
    const item = (await history()).find((row) => row.downloadId === download2.id && row.state === "downloading");
    if (!item) return;
    const complete = download2.state === "complete";
    const next = { ...item, state: complete ? "complete" : cancelled.has(item.id) || download2.error === "USER_CANCELED" ? "cancelled" : "error" };
    if (!complete && next.state === "error") next.error = download2.error || "\uB2E4\uC6B4\uB85C\uB4DC\uAC00 \uC911\uB2E8\uB418\uC5C8\uC2B5\uB2C8\uB2E4.";
    await update(next);
    if (complete) await offerUpscale({ internalFilename: `local-${item.id}.media`, filename: item.filename, downloadId: download2.id, success: true, incognito: item.incognito });
    await dispose(item.id);
    if (item.incognito) privateHistory.delete(item.id);
    cancelled.delete(item.id);
  } finally {
    finalizing.delete(download2.id);
  }
}
async function download(item, options = downloadOptions()) {
  const tab = item.tabId < 0 ? { incognito: chrome.extension.inIncognitoContext } : await chrome.tabs.get(item.tabId);
  const filename = filenameFor(item);
  const entry = { id: crypto.randomUUID(), url: item.url, filename: options.output === "original" ? filename : filename.replace(/\.[^.]+$/, "") + "." + options.output, kind: item.kind, state: "preparing", createdAt: Date.now(), incognito: !!tab.incognito || chrome.extension.inIncognitoContext, options };
  await navigator.locks.request("my-video-app-start", async () => {
    const active = (await history()).filter((row) => row.state === "preparing" || row.state === "downloading");
    if (active.some((row) => row.url === item.url && (row.options?.quality ?? "highest") === options.quality && (row.options?.output ?? "original") === options.output)) throw new Error("\uAC19\uC740 \uBBF8\uB514\uC5B4\uB97C \uC774\uBBF8 \uCC98\uB9AC\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4.");
    if (active.length >= 8) throw new Error("\uB3D9\uC2DC\uC5D0 \uC900\uBE44\xB7\uB2E4\uC6B4\uB85C\uB4DC\uD558\uB294 \uD30C\uC77C\uC740 \uCD5C\uB300 8\uAC1C\uC785\uB2C8\uB2E4.");
    await update(entry);
  });
  void (async () => {
    try {
      let address = item.url;
      const offers = (await chrome.storage.local.get(OFFER_KEY))[OFFER_KEY] !== false;
      if (options.output !== "original" || item.kind !== "file" || offers && !entry.incognito && (!item.size || item.size <= MAX_INPUT_BYTES)) {
        try {
          await ensureOffscreen();
          const result = await chrome.runtime.sendMessage({ scope: OFFSCREEN_SCOPE, type: "prepare", id: entry.id, url: item.url, kind: item.kind, options });
          if (!record(result) || result.ok !== true || typeof result.url !== "string" || !result.url.startsWith(`blob:${chrome.runtime.getURL("")}`)) throw new Error(record(result) && typeof result.error === "string" ? result.error : "\uD30C\uC77C\uC744 \uC900\uBE44\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
          address = result.url;
        } catch (error) {
          if (options.output !== "original" || item.kind !== "file" || cancelled.has(entry.id)) throw error;
          address = item.url;
        }
      }
      if (cancelled.has(entry.id)) throw new Error("\uC791\uC5C5\uC744 \uCDE8\uC18C\uD588\uC2B5\uB2C8\uB2E4.");
      const id = await chrome.downloads.download({ url: address, filename: entry.filename, saveAs: true, conflictAction: "uniquify" });
      const downloading = { ...entry, state: "downloading", downloadId: id };
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
  const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (tab?.id !== void 0 && tab.url && /^https?:/.test(tab.url)) return tab.id;
  return lastTab ?? Array.from(media.keys()).at(-1);
}
async function handleLocalMessage(value, sender) {
  if (!record(value) || value.scope !== SCOPE || typeof value.type !== "string" || !boundedData(value, 128 * 1024)) throw new Error("\uC798\uBABB\uB41C \uC694\uCCAD\uC785\uB2C8\uB2E4.");
  if (value.type === "preparing-progress") {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("local/offscreen.html")) throw new Error("\uD5C8\uC6A9\uB418\uC9C0 \uC54A\uC740 \uBC1C\uC2E0\uC790\uC785\uB2C8\uB2E4.");
    return { ok: true };
  }
  if (value.type === "capture") {
    if (!trustedCapture(sender, chrome.runtime.id) || !Array.isArray(value.items) || value.items.length > 100) throw new Error("\uD5C8\uC6A9\uB418\uC9C0 \uC54A\uC740 \uC218\uC9D1 \uC694\uCCAD\uC785\uB2C8\uB2E4.");
    for (const item of value.items) if (record(item) && typeof item.url === "string") add(sender.tab.id, item.url, typeof item.mime === "string" ? item.mime : "", typeof item.title === "string" ? item.title : "", item.fromElement === true);
    return { ok: true };
  }
  if (!trustedUI(sender, chrome.runtime.id, chrome.runtime.getURL(""))) throw new Error("\uD655\uC7A5 \uD654\uBA74\uC5D0\uC11C\uB9CC \uC0AC\uC6A9\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
  if (value.type === "list") {
    const tabId = await currentTab();
    const items = tabId === void 0 ? [] : Array.from(media.get(tabId)?.values() ?? []).sort((a, b) => b.createdAt - a.createdAt);
    return { ok: true, items, history: await history(), tabId };
  }
  if (value.type === "download" && typeof value.id === "string") {
    const item = Array.from(media.values()).flatMap((map) => Array.from(map.values())).find((row) => row.id === value.id);
    if (!item) throw new Error("\uBBF8\uB514\uC5B4\uAC00 \uB9CC\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uC6D0\uB798 \uD398\uC774\uC9C0\uB97C \uC0C8\uB85C\uACE0\uCE68\uD558\uC138\uC694.");
    return { ok: true, item: await download(item, downloadOptions(value.options)) };
  }
  if (value.type === "download-url" && typeof value.url === "string") {
    const url = mediaURL(value.url).href;
    return { ok: true, item: await download({ id: crypto.randomUUID(), tabId: -1, url, title: "", mime: "", kind: mediaKind(url) ?? "file", createdAt: Date.now() }, downloadOptions(value.options)) };
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
    chrome.downloads.show(item.downloadId);
    return { ok: true };
  }
  if (value.type === "clear-history") {
    await navigator.locks.request("my-video-app-history", async () => {
      await chrome.storage.local.set({ [HISTORY_KEY]: (await history()).filter((row) => !row.incognito && ["preparing", "downloading"].includes(row.state)) });
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
  const size = Number(details.responseHeaders?.find((h) => h.name.toLowerCase() === "content-length")?.value);
  add(details.tabId, details.url, type, "", false, size);
  return void 0;
}, { urls: ["http://*/*", "https://*/*"] }, ["responseHeaders"]);
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === "complete" || delta.state?.current === "interrupted") void chrome.downloads.search({ id: delta.id }).then((items) => {
    if (items[0]) return finish(items[0]);
  }).catch(() => {
  });
});
chrome.tabs.onRemoved.addListener((id) => {
  media.delete(id);
  if (lastTab === id) lastTab = void 0;
});
chrome.tabs.onUpdated.addListener((id, changes, tab) => {
  if (changes.status === "loading") media.delete(id);
  if (tab.active && tab.url && /^https?:/.test(tab.url)) lastTab = id;
});
chrome.tabs.onActivated.addListener((info) => {
  void chrome.tabs.get(info.tabId).then((tab) => {
    if (tab.url && /^https?:/.test(tab.url)) lastTab = info.tabId;
  }).catch(() => {
  });
});
async function setup(restarted = false) {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => chrome.action.setPopup({ popup: "local/index.html" }));
  for (const item of await history()) {
    if (restarted && item.state === "preparing") {
      await update({ ...item, state: "error", error: "\uBE0C\uB77C\uC6B0\uC800\uAC00 \uB2E4\uC2DC \uC2DC\uC791\uB418\uC5B4 \uC900\uBE44 \uC791\uC5C5\uC774 \uC911\uB2E8\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uB2E4\uC2DC \uB2E4\uC6B4\uB85C\uB4DC\uD558\uC138\uC694." });
      await dispose(item.id).catch(() => {
      });
    } else if (item.state === "downloading" && item.downloadId !== void 0) {
      const current = (await chrome.downloads.search({ id: item.downloadId }))[0];
      if (current) await finish(current);
      else {
        await update({ ...item, state: "error", error: "\uBE0C\uB77C\uC6B0\uC800\uC758 \uB2E4\uC6B4\uB85C\uB4DC \uAE30\uB85D\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        await dispose(item.id).catch(() => {
        });
      }
    }
  }
  const keep = new Set((await history()).filter((item) => item.state === "preparing" || item.state === "downloading").map((item) => `local-${item.id}.media`));
  const root = await navigator.storage.getDirectory();
  for await (const name of root.keys()) if (/^local-[0-9a-f-]{36}\.media$/.test(name) && !keep.has(name)) await root.removeEntry(name).catch(() => {
  });
}
chrome.runtime.onInstalled.addListener(() => {
  void setup().catch(() => {
  });
});
chrome.runtime.onStartup.addListener(() => {
  void setup(true).catch(() => {
  });
});
chrome.commands.onCommand.addListener((command) => {
  if (command !== "default-action") return;
  void currentTab().then((id) => {
    const item = id === void 0 ? void 0 : Array.from(media.get(id)?.values() ?? [])[0];
    if (item) return download(item);
  }).catch(() => {
  });
});
export {
  handleLocalMessage
};
