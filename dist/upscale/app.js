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
  return isJobId(v.id) && typeof v.filename === "string" && v.filename.length <= 240 && Number.isSafeInteger(v.size) && v.size > 0 && v.size <= MAX_INPUT_BYTES && typeof v.createdAt === "number" && Number.isFinite(v.createdAt);
}
function safeBasename(input2) {
  return (input2.split(/[\\/]/).at(-1) ?? "media").replace(/[\x00-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, "_").replace(/[. ]+$/g, "").slice(0, 180) || "media";
}
function outputName(filename, factor2, kind) {
  const base = safeBasename(filename).replace(/\.[^.]+$/, "") || "media";
  return `${base}-${factor2}x.${kind === "video" ? "mp4" : "png"}`;
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

// src/security/validation.ts
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
var input;
var worker;
var watchdog;
var output;
function showError(error) {
  status.textContent = error instanceof Error ? error.message : "\uCC98\uB9AC \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4.";
}
function releaseOutput() {
  if (output) URL.revokeObjectURL(output.url);
  output = void 0;
  save.hidden = true;
}
function stop() {
  worker?.terminate();
  worker = void 0;
  clearTimeout(watchdog);
  watchdog = void 0;
  start.disabled = !input;
  cancel.disabled = true;
  factor.disabled = false;
  fileInput.disabled = false;
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
  start.disabled = false;
  status.textContent = "\uD655\uB300 \uBC30\uC728\uC744 \uACE0\uB978 \uB4A4 \uD655\uB300 \uC2DC\uC791\uC744 \uB204\uB974\uC138\uC694.";
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
  void chrome.storage.local.set({ [OFFER_KEY]: offer.checked }).catch(showError);
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
  const scale = factor.value === "4" ? 4 : 2;
  start.disabled = true;
  cancel.disabled = false;
  factor.disabled = true;
  fileInput.disabled = true;
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
    showError(new Error("\uCC98\uB9AC \uC5D4\uC9C4\uC744 \uC2E4\uD589\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uD655\uC7A5 \uD504\uB85C\uADF8\uB7A8\uC744 \uB2E4\uC2DC \uB85C\uB4DC\uD558\uC138\uC694."));
  });
  worker.addEventListener("message", (event) => {
    const message = event.data;
    if (!record(message)) return;
    if (message.type === "status" && typeof message.message === "string") status.textContent = message.message;
    else if (message.type === "metadata" && record(message.info) && record(message.output)) {
      details.textContent = `${message.info.width} \xD7 ${message.info.height} \u2192 ${message.output.width} \xD7 ${message.output.height}`;
      progress.value = 0;
      status.textContent = "\uD655\uB300\uBCF8\uC744 \uB9CC\uB4E4\uACE0 \uC788\uC2B5\uB2C8\uB2E4. \uC774 \uD0ED\uC744 \uC5F4\uC5B4 \uB450\uC138\uC694.";
    } else if (message.type === "progress" && typeof message.value === "number") progress.value = message.value;
    else if (message.type === "error") {
      stop();
      showError(new Error(typeof message.message === "string" ? message.message : "\uBCC0\uD658\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4."));
      progress.value = 0;
    } else if (message.type === "done" && message.bytes instanceof ArrayBuffer && record(message.info)) {
      const kind = message.info.kind === "image" ? "image" : "video";
      output = { url: URL.createObjectURL(new Blob([message.bytes], { type: kind === "image" ? "image/png" : "video/mp4" })), filename: outputName(chosen.name, scale, kind) };
      stop();
      progress.value = 1;
      status.textContent = "\uD655\uB300\uBCF8\uC774 \uC900\uBE44\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uBCC4\uB3C4 \uD30C\uC77C\uB85C \uC800\uC7A5\uD558\uC138\uC694.";
      save.hidden = false;
      void refresh().catch(showError);
    }
  });
  worker.postMessage({ file: chosen, factor: scale });
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
  offer.checked = (await chrome.storage.local.get(OFFER_KEY))[OFFER_KEY] !== false;
  await refresh();
  const id = new URL(location.href).searchParams.get("job");
  if (isJobId(id)) {
    const job = (await jobs()).find((j) => j.id === id);
    if (job) await selectJob(job);
    else status.textContent = "\uC784\uC2DC \uBCF5\uC0AC\uBCF8\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uC6D0\uBCF8 \uD30C\uC77C\uC744 \uC9C1\uC811 \uC120\uD0DD\uD558\uC138\uC694.";
  }
})().catch(showError);
