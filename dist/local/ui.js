// src/security/validation.ts
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// src/upscale/policy.ts
var MAX_INPUT_BYTES = 256 * 1024 * 1024;
var MAX_QUEUE_BYTES = 512 * 1024 * 1024;
var RETENTION_MS = 24 * 60 * 60 * 1e3;

// src/local/model.ts
var SCOPE = "my-video-app/local";
var MAX_STREAM_BYTES = 128 * 1024 * 1024;
function isHistory(value) {
  return record(value) && typeof value.id === "string" && /^[a-f0-9-]{36}$/.test(value.id) && typeof value.url === "string" && typeof value.filename === "string" && ["file", "hls", "dash"].includes(String(value.kind)) && ["preparing", "downloading", "complete", "cancelled", "error"].includes(String(value.state)) && typeof value.createdAt === "number" && Number.isFinite(value.createdAt) && typeof value.incognito === "boolean";
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
function transportLabel(value) {
  return value === "h3" ? "HTTP/3" : value === "h2" ? "HTTP/2" : "HTTP/1.1";
}

// src/local/ui.ts
function node(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing ${id}`);
  return element;
}
var status = node("status");
var refreshing = false;
var hasError = false;
async function request(type, data = {}) {
  const result = await chrome.runtime.sendMessage({ scope: SCOPE, type, ...data });
  if (!record(result) || result.ok !== true) throw new Error(record(result) && typeof result.error === "string" ? result.error : "\uD655\uC7A5 \uD504\uB85C\uADF8\uB7A8\uC744 \uB2E4\uC2DC \uB85C\uB4DC\uD558\uACE0 \uD398\uC774\uC9C0\uB97C \uC0C8\uB85C\uACE0\uCE68\uD558\uC138\uC694.");
  return result;
}
function error(value) {
  hasError = true;
  status.textContent = value instanceof Error ? value.message : "\uC694\uCCAD \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4.";
}
function options() {
  return downloadOptions({ quality: node("quality").value, output: node("download-output").value });
}
function button(text, action, secondary = false) {
  const element = document.createElement("button");
  element.textContent = text;
  if (secondary) element.className = "secondary";
  element.addEventListener("click", () => {
    hasError = false;
    element.disabled = true;
    void action().then(() => refresh()).catch(error).finally(() => {
      element.disabled = false;
    });
  });
  return element;
}
function mediaRow(item) {
  const row = document.createElement("li");
  const kind = document.createElement("span");
  kind.className = "kind";
  kind.textContent = item.kind === "file" ? "MEDIA FILE" : `${item.kind.toUpperCase()} \xB7 VOD`;
  const title = document.createElement("h3");
  title.textContent = item.title || new URL(item.url).pathname.split("/").at(-1) || "\uBBF8\uB514\uC5B4";
  const source = document.createElement("p");
  source.textContent = new URL(item.url).hostname + (item.size ? ` \xB7 ${(item.size / 1024 / 1024).toFixed(1)} MiB` : "");
  const observed = transport(item.observedTransport);
  if (observed) source.textContent += ` \xB7 \uD398\uC774\uC9C0 \uC5F0\uACB0 ${transportLabel(observed)}`;
  const controls = document.createElement("div");
  controls.className = "actions";
  controls.append(button("\uB2E4\uC6B4\uB85C\uB4DC", async () => {
    await request("download", { id: item.id, options: options() });
    status.textContent = "\uD30C\uC77C\uC744 \uC900\uBE44\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4. \uAE30\uB85D \uD0ED\uC5D0\uC11C \uC9C4\uD589 \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uC138\uC694.";
  }));
  row.append(kind, title, source, controls);
  return row;
}
var stateLabels = { preparing: "\uD30C\uC77C \uC900\uBE44 \uC911", downloading: "\uB2E4\uC6B4\uB85C\uB4DC \uC911", complete: "\uC644\uB8CC", cancelled: "\uCDE8\uC18C\uB428", error: "\uC2E4\uD328" };
function historyRow(item) {
  const row = document.createElement("li");
  const title = document.createElement("h3");
  title.textContent = item.filename;
  const info = document.createElement("p");
  info.textContent = `${stateLabels[item.state]} \xB7 ${new Date(item.createdAt).toLocaleString("ko-KR")}`;
  if (item.state === "preparing" && item.preparation) {
    const label = { queued: "\uC900\uBE44 \uB300\uAE30 \uC911", fetching: "\uD30C\uC77C \uBC1B\uB294 \uC911", processing: "\uBBF8\uB514\uC5B4 \uD569\uCE58\uB294 \uC911", saving: "\uC800\uC7A5 \uC900\uBE44 \uC911" }[item.preparation.stage];
    if (label) info.textContent += ` \xB7 ${label}`;
    if (typeof item.preparation.progress === "number" && Number.isFinite(item.preparation.progress)) info.textContent += ` ${Math.round(Math.max(0, Math.min(1, item.preparation.progress)) * 100)}%`;
  }
  if (item.state === "downloading" && typeof item.receivedBytes === "number" && item.receivedBytes >= 0) {
    info.textContent += ` \xB7 ${(item.receivedBytes / 1024 / 1024).toFixed(1)} MiB`;
    if (typeof item.totalBytes === "number" && item.totalBytes > 0) info.textContent += ` / ${(item.totalBytes / 1024 / 1024).toFixed(1)} MiB`;
  }
  row.append(title, info);
  const protocols = (Array.isArray(item.transferProtocols) ? item.transferProtocols : []).map(transport).filter((value) => value !== void 0);
  if (protocols.length) {
    const connection = document.createElement("p");
    connection.textContent = `\uC900\uBE44 \uC5F0\uACB0 ${protocols.map(transportLabel).join(", ")}`;
    row.append(connection);
  }
  if (item.error) {
    const message = document.createElement("p");
    message.textContent = item.error;
    row.append(message);
  }
  const controls = document.createElement("div");
  controls.className = "actions";
  if (item.state === "complete") controls.append(button("\uC800\uC7A5 \uD3F4\uB354", () => request("show-file", { id: item.id }), true));
  if (item.state === "error" || item.state === "cancelled") controls.append(button("\uB2E4\uC2DC \uC2DC\uB3C4", () => request("retry", { id: item.id }), true));
  if (item.state === "downloading" || item.state === "preparing") controls.append(button("\uCDE8\uC18C", () => request("cancel", { id: item.id }), true));
  row.append(controls);
  return row;
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const result = await request("list");
    const media = Array.isArray(result.items) ? result.items.filter((item) => record(item) && typeof item.id === "string" && typeof item.url === "string" && typeof item.title === "string" && ["file", "hls", "dash"].includes(String(item.kind))) : [];
    const history = Array.isArray(result.history) ? result.history.filter(isHistory) : [];
    node("media").replaceChildren(...media.map(mediaRow));
    node("empty").hidden = media.length > 0;
    node("history").replaceChildren(...history.map(historyRow));
    node("history-empty").hidden = history.length > 0;
    const active = history.filter((row) => row.state === "preparing" || row.state === "downloading").length;
    if (!hasError) status.textContent = active ? `${active}\uAC1C \uD30C\uC77C \uCC98\uB9AC \uC911 \xB7 \uAE30\uB85D \uD0ED\uC5D0\uC11C \uD655\uC778\uD558\uC138\uC694.` : `${media.length}\uAC1C \uBBF8\uB514\uC5B4 \xB7 \uC774 \uBE0C\uB77C\uC6B0\uC800\uC5D0\uB9CC \uAE30\uB85D\uC744 \uC800\uC7A5\uD569\uB2C8\uB2E4.`;
  } finally {
    refreshing = false;
  }
}
function show(history) {
  node("media-view").hidden = history;
  node("history-view").hidden = !history;
  node("media-tab").setAttribute("aria-pressed", String(!history));
  node("history-tab").setAttribute("aria-pressed", String(history));
  void refresh().catch(error);
}
node("media-tab").addEventListener("click", () => show(false));
node("history-tab").addEventListener("click", () => show(true));
node("refresh").addEventListener("click", () => {
  hasError = false;
  void refresh().catch(error);
});
node("upscale").addEventListener("click", () => {
  void request("upscale").catch(error);
});
node("clear-history").addEventListener("click", () => {
  void request("clear-history").then(refresh).catch(error);
});
node("url-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const url = node("url").value;
  void request("download-url", { url, options: options() }).then(() => {
    hasError = false;
    status.textContent = "\uD30C\uC77C\uC744 \uC900\uBE44\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4.";
    show(true);
  }).catch(error);
});
var timer = setInterval(() => {
  if (!document.hidden) void refresh().catch(error);
}, 2e3);
addEventListener("pagehide", () => clearInterval(timer), { once: true });
void refresh().catch(error);
