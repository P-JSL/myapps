// src/upscale/policy.ts
var MAX_INPUT_BYTES = 256 * 1024 * 1024;
var MAX_QUEUE_BYTES = 512 * 1024 * 1024;
var MAX_JOBS = 4;
var MAX_RUNTIME_MS = 3e5;
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
function safeBasename(input2) {
  return (input2.split(/[\\/]/).at(-1) ?? "media").replace(/[\x00-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, "_").replace(/[. ]+$/g, "").slice(0, 180) || "media";
}
function outputName(filename, factor2, kind) {
  const base = safeBasename(filename).replace(/\.[^.]+$/, "") || "media";
  return `${base}-${factor2}x.${kind === "video" ? "mp4" : "png"}`;
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

// src/security/validation.ts
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// src/local/preferences.ts
var QUALITIES = ["highest", "2160", "1080", "720", "480"];

// src/upscale/processing.ts
function processingOptions(value) {
  if (!record(value)) throw new Error("\uCC98\uB9AC \uC124\uC815\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  if (value.mode === "upscale" && (value.factor === 2 || value.factor === 4)) return { mode: "upscale", factor: value.factor };
  if (value.mode === "convert" && ["mp4", "webm", "mkv"].includes(String(value.format)) && QUALITIES.includes(value.quality)) return { mode: "convert", format: value.format, quality: value.quality };
  if (value.mode === "audio" && ["mp3", "m4a", "wav"].includes(String(value.format))) return { mode: "audio", format: value.format };
  if (value.mode === "merge" && ["mp4", "mkv"].includes(String(value.format))) return { mode: "merge", format: value.format };
  throw new Error("\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uCC98\uB9AC \uC124\uC815\uC785\uB2C8\uB2E4.");
}
var MIME = { mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", png: "image/png" };
function processedName(filename, options, kind) {
  if (options.mode === "upscale") return outputName(filename, options.factor, kind === "image" ? "image" : "video");
  let base = safeBasename(filename).replace(/\.[^.]+$/, "") || "media";
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  return `${base}-${options.mode === "audio" ? "audio" : options.mode === "merge" ? "merged" : "converted"}.${options.format}`;
}

// src/ui/app.ts
function element(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node;
}
var fileInput = element("file");
var selected = element("selected");
var status = element("status");
var details = element("details");
var start = element("start");
var cancel = element("cancel");
var save = element("save");
var factor = element("factor");
var progress = element("progress");
var offer = element("offer");
var isPrivate = privateContext();
var mode = element("mode");
var audioInput = element("audio-file");
var input;
var worker;
var watchdog;
var output;
if (isPrivate) {
  offer.checked = false;
  offer.disabled = true;
  const hint = document.createElement("p");
  hint.id = "offer-private-status";
  hint.className = "hint";
  hint.textContent = "\uC2DC\uD06C\uB9BF \uCC3D\uC5D0\uC11C\uB294 \uC644\uB8CC \uD30C\uC77C\uC758 \uC784\uC2DC \uBCF5\uC0AC\uBCF8\uC744 \uBCF4\uAD00\uD558\uAC70\uB098 \uC77C\uBC18 \uCC3D\uC758 \uC5C5\uC2A4\uCF00\uC77C\uB9C1 \uC54C\uB9BC \uC124\uC815\uC744 \uC77D\uACE0 \uBCC0\uACBD\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uC544\uB798\uC5D0\uC11C \uC9C1\uC811 \uD30C\uC77C\uC744 \uC120\uD0DD\uD574 \uBBF8\uB514\uC5B4 \uB3C4\uAD6C\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.";
  offer.setAttribute("aria-describedby", hint.id);
  offer.closest("label")?.after(hint);
}
function showError(error) {
  status.textContent = error instanceof Error ? error.message : "\uCC98\uB9AC \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4.";
}
function releaseOutput() {
  if (output) URL.revokeObjectURL(output.url);
  output = void 0;
  save.hidden = true;
}
function toggleControls(disabled) {
  for (const control of document.querySelectorAll("#convert-title ~ input, #convert-title ~ select, #upscale-settings select, #convert-settings select, #audio-settings select, #merge-settings input, #merge-settings select")) control.disabled = disabled;
}
function stop() {
  worker?.terminate();
  worker = void 0;
  clearTimeout(watchdog);
  watchdog = void 0;
  toggleControls(false);
  start.disabled = !input || mode.value === "merge" && !audioInput.files?.[0];
  cancel.disabled = true;
}
function settings() {
  return processingOptions({ mode: mode.value, factor: Number(factor.value), format: element(mode.value === "audio" ? "audio-format" : mode.value === "merge" ? "merge-format" : "video-format").value, quality: element("convert-quality").value });
}
function changeMode() {
  if (worker) return;
  releaseOutput();
  progress.value = 0;
  for (const name of ["upscale", "convert", "audio", "merge"]) element(`${name}-settings`).hidden = mode.value !== name;
  const hints = { upscale: "Lanczos 2x/4x \uBCF4\uAC04\uC785\uB2C8\uB2E4. AI \uBCF5\uC6D0\uC740 \uC544\uB2D9\uB2C8\uB2E4. \uC601\uC0C1\uC740 MP4(H.264/AAC), \uC774\uBBF8\uC9C0\uB294 PNG\uB85C \uC800\uC7A5\uD569\uB2C8\uB2E4.", convert: "MP4\xB7MKV\uB294 H.264/AAC, WebM\uC740 VP8/Opus\uB85C \uBCC0\uD658\uD569\uB2C8\uB2E4. \uC120\uD0DD \uB192\uC774\uB294 \uC0C1\uD55C\uC774\uBA70 \uC791\uC740 \uC6D0\uBCF8\uC744 \uD655\uB300\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.", audio: "\uC601\uC0C1 \uB610\uB294 \uC624\uB514\uC624\uC758 \uCCAB \uC74C\uC131 \uD2B8\uB799\uC744 \uC800\uC7A5\uD569\uB2C8\uB2E4. MP3/M4A\uB294 192kbps\uB85C \uC778\uCF54\uB529\uD558\uBA70 WAV\uB294 \uC6D0\uBCF8\uC5D0\uC11C \uB514\uCF54\uB529\uD55C PCM\uC785\uB2C8\uB2E4.", merge: "\uC601\uC0C1 \uD30C\uC77C\uACFC \uBCC4\uB3C4 \uC74C\uC131 \uD30C\uC77C\uC744 \uC120\uD0DD\uD558\uC138\uC694. \uC601\uC0C1\uC758 \uAE30\uC874 \uC74C\uC131 \uB300\uC2E0 \uC120\uD0DD\uD55C \uD30C\uC77C\uC758 \uCCAB \uC74C\uC131 \uD2B8\uB799\uC744 \uC0AC\uC6A9\uD569\uB2C8\uB2E4." };
  element("mode-hint").textContent = hints[mode.value] ?? "";
  start.textContent = { upscale: "\uD655\uB300 \uC2DC\uC791", convert: "\uC601\uC0C1 \uBCC0\uD658", audio: "\uC624\uB514\uC624 \uB9CC\uB4E4\uAE30", merge: "\uBCD1\uD569 \uC2DC\uC791" }[mode.value] ?? "\uC2DC\uC791";
  start.disabled = !input || mode.value === "merge" && !audioInput.files?.[0];
  status.textContent = "\uD30C\uC77C\uACFC \uCC98\uB9AC \uC124\uC815\uC744 \uC120\uD0DD\uD55C \uB4A4 \uC2DC\uC791\uD558\uC138\uC694.";
}
function select(file) {
  if (worker) return;
  releaseOutput();
  input = void 0;
  details.textContent = "";
  progress.value = 0;
  if (!file.size || file.size > MAX_INPUT_BYTES) {
    selected.textContent = "\uC120\uD0DD\uD55C \uD30C\uC77C \uC5C6\uC74C";
    showError(new Error("\uD30C\uC77C\uC740 0\uBC14\uC774\uD2B8\uBCF4\uB2E4 \uD06C\uACE0 256MiB \uC774\uD558\uC5EC\uC57C \uD569\uB2C8\uB2E4."));
    start.disabled = true;
    return;
  }
  input = file;
  selected.textContent = `${file.name} \xB7 ${(file.size / 1024 / 1024).toFixed(2)} MiB`;
  changeMode();
}
async function selectJob(job) {
  try {
    const file = await (await (await directory()).getFileHandle(job.id)).getFile();
    fileInput.value = "";
    select(new File([file], job.filename));
  } catch {
    showError(new Error("\uC784\uC2DC \uD30C\uC77C\uC774 \uC815\uB9AC\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uC800\uC7A5\uB41C \uC6D0\uBCF8 \uD30C\uC77C\uC744 \uC9C1\uC811 \uC120\uD0DD\uD558\uC138\uC694."));
    await refresh();
  }
}
async function refresh() {
  const retained = await cleanup();
  const list = element("jobs");
  list.replaceChildren();
  element("empty").hidden = retained.length > 0;
  for (const job of retained) {
    const row = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = job.filename;
    const choose = document.createElement("button");
    choose.textContent = "\uC120\uD0DD";
    choose.disabled = !!worker;
    choose.addEventListener("click", () => {
      void selectJob(job);
    });
    const remove = document.createElement("button");
    remove.textContent = "\uC0AD\uC81C";
    remove.className = "secondary";
    remove.addEventListener("click", () => {
      void deleteJob(job).then(refresh).catch(showError);
    });
    row.append(label, choose, remove);
    list.append(row);
  }
}
fileInput.addEventListener("change", () => {
  if (fileInput.files?.[0]) select(fileInput.files[0]);
});
mode.addEventListener("change", changeMode);
audioInput.addEventListener("change", changeMode);
element("refresh").addEventListener("click", () => {
  void refresh().catch(showError);
});
element("clear").addEventListener("click", () => {
  void (async () => {
    for (const job of await jobs()) await deleteJob(job);
    await refresh();
  })().catch(showError);
});
offer.addEventListener("change", () => {
  if (!isPrivate) void chrome.storage.local.set({ [OFFER_KEY]: offer.checked }).catch(showError);
});
cancel.addEventListener("click", () => {
  stop();
  progress.value = 0;
  status.textContent = "\uCDE8\uC18C\uD588\uC2B5\uB2C8\uB2E4. \uC6D0\uBCF8 \uD30C\uC77C\uC740 \uADF8\uB300\uB85C \uBCF4\uAD00\uB429\uB2C8\uB2E4.";
  void refresh().catch(showError);
});
start.addEventListener("click", () => {
  if (!input || worker) return;
  releaseOutput();
  const chosen = input;
  const options = settings();
  const audio = audioInput.files?.[0];
  if (options.mode === "merge" && (!audio || !audio.size || input.size + audio.size > MAX_INPUT_BYTES)) {
    showError(new Error("\uBCD1\uD569\uD560 \uB450 \uD30C\uC77C\uC740 0\uBC14\uC774\uD2B8\uBCF4\uB2E4 \uD06C\uACE0 \uD569\uACC4 256MiB \uC774\uD558\uC5EC\uC57C \uD569\uB2C8\uB2E4."));
    return;
  }
  start.disabled = true;
  cancel.disabled = false;
  toggleControls(true);
  progress.removeAttribute("value");
  status.textContent = "\uBBF8\uB514\uC5B4\uB97C \uD655\uC778\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4\u2026";
  details.textContent = "";
  worker = new Worker(chrome.runtime.getURL("hardening/upscale-worker.js"), { type: "module" });
  watchdog = setTimeout(() => {
    stop();
    showError(new Error("\uCC98\uB9AC \uC2DC\uAC04 5\uBD84\uC744 \uCD08\uACFC\uD574 \uC911\uB2E8\uD588\uC2B5\uB2C8\uB2E4. \uB354 \uC791\uC740 \uD30C\uC77C\uC744 \uC0AC\uC6A9\uD558\uC138\uC694."));
  }, MAX_RUNTIME_MS + 3e4);
  worker.addEventListener("error", () => {
    stop();
    progress.value = 0;
    showError(new Error("\uCC98\uB9AC \uC5D4\uC9C4\uC744 \uC2E4\uD589\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uD655\uC7A5 \uD504\uB85C\uADF8\uB7A8\uC744 \uB2E4\uC2DC \uB85C\uB4DC\uD558\uC138\uC694."));
  });
  worker.addEventListener("message", (event) => {
    const message = event.data;
    if (!record(message)) return;
    if (message.type === "status" && typeof message.message === "string") status.textContent = message.message;
    else if (message.type === "metadata" && record(message.info) && record(message.output)) {
      details.textContent = options.mode === "audio" ? "\uCCAB \uC624\uB514\uC624 \uD2B8\uB799\uC744 \uBCC4\uB3C4 \uD30C\uC77C\uB85C \uC800\uC7A5\uD569\uB2C8\uB2E4." : `${message.info.width} \xD7 ${message.info.height} \u2192 ${message.output.width} \xD7 ${message.output.height}`;
      progress.value = 0;
      status.textContent = "\uACB0\uACFC\uB97C \uB9CC\uB4E4\uACE0 \uC788\uC2B5\uB2C8\uB2E4. \uC774 \uD0ED\uC744 \uC5F4\uC5B4 \uB450\uC138\uC694.";
    } else if (message.type === "progress" && typeof message.value === "number") progress.value = message.value;
    else if (message.type === "error") {
      stop();
      showError(new Error(typeof message.message === "string" ? message.message : "\uBCC0\uD658\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4."));
      progress.value = 0;
    } else if (message.type === "done" && message.bytes instanceof ArrayBuffer && record(message.info)) {
      const kind = message.info.kind === "image" ? "image" : message.info.kind === "audio" ? "audio" : "video";
      const format = typeof message.format === "string" && Object.hasOwn(MIME, message.format) ? message.format : "mp4";
      output = { url: URL.createObjectURL(new Blob([message.bytes], { type: MIME[format] })), filename: processedName(chosen.name, options, kind) };
      stop();
      progress.value = 1;
      status.textContent = "\uACB0\uACFC\uAC00 \uC900\uBE44\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uBCC4\uB3C4 \uD30C\uC77C\uB85C \uC800\uC7A5\uD558\uC138\uC694.";
      save.hidden = false;
      void refresh().catch(showError);
    }
  });
  worker.postMessage({ file: chosen, options, ...options.mode === "merge" ? { audio } : {} });
  void refresh().catch(showError);
});
save.addEventListener("click", () => {
  if (!output) return;
  void chrome.downloads.download({ url: output.url, filename: output.filename, saveAs: true, conflictAction: "uniquify" }).catch(showError);
});
addEventListener("pagehide", () => {
  stop();
  releaseOutput();
});
void (async () => {
  if (!isPrivate) offer.checked = (await chrome.storage.local.get(OFFER_KEY))[OFFER_KEY] !== false;
  await refresh();
  const id = new URL(location.href).searchParams.get("job");
  if (isJobId(id)) {
    const job = (await jobs()).find((j) => j.id === id);
    if (job) await selectJob(job);
    else status.textContent = "\uC784\uC2DC \uBCF5\uC0AC\uBCF8\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uC6D0\uBCF8 \uD30C\uC77C\uC744 \uC9C1\uC811 \uC120\uD0DD\uD558\uC138\uC694.";
  }
})().catch(showError);
