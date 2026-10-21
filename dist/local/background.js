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
  const ascii2 = (start, count) => String.fromCharCode(...bytes.subarray(start, start + count));
  if (bytes[0] === 137 && ascii2(1, 3) === "PNG" && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return "image";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image";
  if (ascii2(0, 4) === "RIFF" && ascii2(8, 4) === "WEBP") return "image";
  if (ascii2(4, 4) === "ftyp" || ascii2(0, 4) === "RIFF" && ascii2(8, 4) === "AVI ") return "video";
  if (bytes[0] === 26 && bytes[1] === 69 && bytes[2] === 223 && bytes[3] === 163) return "video";
  return void 0;
}

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
    return ["local/index.html", "local/popup.html", "upscale/index.html"].some((page) => u.href.split(/[?#]/)[0] === `${base}${page}`);
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

// src/data/database.ts
var DATABASE_NAME = "my-video-app";
var DATABASE_VERSION = 1;
var DOWNLOAD_OPTIONS_KEY = "my_video_app_download_options_v1";
var STORAGE_KEYS = [HISTORY_KEY, JOBS_KEY, OFFER_KEY, DOWNLOAD_OPTIONS_KEY];
var STORES = ["history", "jobs", "settings", "meta", "recovery"];
var MIGRATION = "migration-v1";
var MAINTENANCE = "last-maintenance";
var CLEANUP_PENDING = "legacy-cleanup-pending";
var MAINTENANCE_INTERVAL = 6e4;
function privateRow(value) {
  return value !== null && typeof value === "object" && value.incognito === true;
}
function containsPrivate(value, seen = /* @__PURE__ */ new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  if (privateRow(value)) return true;
  seen.add(value);
  return Object.values(value).some((item) => containsPrivate(item, seen));
}
function validHistory(value) {
  return isHistory(value) && value.incognito === false && (value.downloadId === void 0 || Number.isSafeInteger(value.downloadId) && value.downloadId >= 0);
}
function validSetting(key, value) {
  if (key === OFFER_KEY) return typeof value === "boolean";
  if (key !== DOWNLOAD_OPTIONS_KEY || value === void 0) return false;
  try {
    downloadOptions(value);
    return true;
  } catch {
    return false;
  }
}
function keyList(keys) {
  const result = typeof keys === "string" ? [keys] : keys;
  if (!Array.isArray(result) || result.some((key) => !STORAGE_KEYS.includes(key))) {
    throw new Error("\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uB85C\uCEEC DB \uD56D\uBAA9\uC785\uB2C8\uB2E4.");
  }
  return [...new Set(result)];
}
function wrap(values) {
  return values.map((value, order) => ({ id: value.id, order, value }));
}
function unwrap(rows, valid) {
  const orders = /* @__PURE__ */ new Set();
  const result = [];
  for (const candidate of rows) {
    const row = candidate;
    if (!row || !Number.isSafeInteger(row.order) || row.order < 0 || orders.has(row.order) || !valid(row.value) || containsPrivate(row.value) || row.id !== row.value.id) {
      throw new Error("\uB85C\uCEEC DB \uAE30\uB85D\uC774 \uC190\uC0C1\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uC790\uB3D9 \uD30C\uC77C \uC815\uB9AC\uB97C \uC911\uB2E8\uD588\uC2B5\uB2C8\uB2E4.");
    }
    orders.add(row.order);
    result.push(row);
  }
  return result.sort((a, b) => a.order - b.order).map((row) => row.value);
}
function retainJobs(values, now) {
  let size = 0;
  const retained = [];
  for (const job of [...values].sort((a, b) => b.createdAt - a.createdAt)) {
    if (now - job.createdAt >= RETENTION_MS || job.createdAt > now || size + job.size > MAX_QUEUE_BYTES || retained.length >= MAX_JOBS) continue;
    retained.push(job);
    size += job.size;
  }
  return retained;
}
function replace(store, values) {
  store.clear();
  for (const row of wrap(values)) store.put(row);
}
function metaNumber(value) {
  if (value === void 0) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("\uB85C\uCEEC DB \uAD00\uB9AC \uC815\uBCF4\uAC00 \uC190\uC0C1\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
  }
  return value;
}
function migrationTime(marker) {
  if (marker === void 0) return null;
  const value = metaNumber(marker.value);
  if (value === null) throw new Error("\uB85C\uCEEC DB \uC774\uC804 \uC815\uBCF4\uAC00 \uC190\uC0C1\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
  return value;
}
function requireMigration(marker) {
  const value = migrationTime(marker);
  if (value === null) {
    throw new Error("\uB85C\uCEEC DB \uC774\uC804 \uC815\uBCF4\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4. \uAE30\uC874 \uAE30\uB85D\uC744 \uBCF4\uD638\uD558\uAE30 \uC704\uD574 \uC790\uB3D9 \uC774\uC804\uACFC \uD30C\uC77C \uC815\uB9AC\uB97C \uC911\uB2E8\uD588\uC2B5\uB2C8\uB2E4.");
  }
  return value;
}
function createAppStorage(options = {}) {
  const name = options.name ?? DATABASE_NAME;
  const isPrivate = options.privateContext ?? (() => globalThis.chrome?.extension?.inIncognitoContext === true);
  const now = options.now ?? Date.now;
  const transactionErrors = /* @__PURE__ */ new WeakMap();
  let connection;
  let barrier;
  let lastMaintenance = -Infinity;
  function assertNormal() {
    if (isPrivate()) throw new Error("\uC2DC\uD06C\uB9BF \uBAA8\uB4DC\uC5D0\uC11C\uB294 \uB85C\uCEEC DB\uB97C \uC0AC\uC6A9\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  }
  function timestamp() {
    const value = now();
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("\uB85C\uCEEC DB \uAD00\uB9AC \uC2DC\uAC04\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
    }
    return value;
  }
  function legacy() {
    return options.legacy ?? {
      get: (keys) => chrome.storage.local.get(keys),
      remove: (keys) => chrome.storage.local.remove(keys)
    };
  }
  function abort(tx, error) {
    if (!transactionErrors.has(tx)) transactionErrors.set(tx, error);
    try {
      tx.abort();
    } catch (abortError) {
      if (!(abortError instanceof DOMException && abortError.name === "InvalidStateError")) throw abortError;
    }
  }
  function transaction(db, names, mode, start) {
    return new Promise((resolve, reject) => {
      let result;
      let tx;
      try {
        tx = db.transaction(names, mode);
      } catch (error) {
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(transactionErrors.get(tx) ?? tx.error ?? new Error("\uB85C\uCEEC DB \uD2B8\uB79C\uC7AD\uC158\uC744 \uC644\uB8CC\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4."));
      tx.onerror = () => {
      };
      try {
        start(tx, (value) => {
          result = value;
        });
      } catch (error) {
        abort(tx, error);
      }
    });
  }
  function guarded(tx, run) {
    try {
      run();
    } catch (error) {
      abort(tx, error);
    }
  }
  function open() {
    assertNormal();
    return new Promise((resolve, reject) => {
      let request;
      let settled = false;
      let timeout;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      try {
        const factory = options.factory ?? globalThis.indexedDB;
        if (!factory) throw new Error("\uC774 \uBE0C\uB77C\uC6B0\uC800\uC5D0\uC11C \uB0B4\uC7A5 DB\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
        request = factory.open(name, DATABASE_VERSION);
      } catch (error) {
        fail(error);
        return;
      }
      request.onblocked = () => {
        timeout ??= setTimeout(
          () => fail(new Error("\uB2E4\uB978 \uCC3D\uC774 \uB85C\uCEEC DB \uAC31\uC2E0\uC744 \uB9C9\uACE0 \uC788\uC2B5\uB2C8\uB2E4. \uD574\uB2F9 \uCC3D\uC744 \uB2EB\uACE0 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694.")),
          options.blockedTimeoutMs ?? 5e3
        );
      };
      request.onerror = () => fail(request.error ?? new Error("\uB85C\uCEEC DB\uB97C \uC5F4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4."));
      request.onupgradeneeded = () => {
        if (settled) {
          request.transaction?.abort();
          return;
        }
        const db = request.result;
        for (const storeName of ["history", "jobs"]) {
          const store = db.objectStoreNames.contains(storeName) ? request.transaction.objectStore(storeName) : db.createObjectStore(storeName, { keyPath: "id" });
          const indexes = [
            ["order", "order"],
            ["createdAt", "value.createdAt"],
            ["downloadId", "value.downloadId"]
          ];
          if (storeName === "history") indexes.push(["state", "value.state"]);
          for (const [index, path] of indexes) {
            if (!store.indexNames.contains(index)) store.createIndex(index, path);
          }
        }
        for (const storeName of ["settings", "meta"]) {
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName, { keyPath: "key" });
          }
        }
        if (!db.objectStoreNames.contains("recovery")) {
          db.createObjectStore("recovery", { keyPath: "id", autoIncrement: true });
        }
      };
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        clearTimeout(timeout);
        const db = request.result;
        const invalidate = () => {
          db.close();
          if (connection === db) {
            connection = void 0;
            barrier = void 0;
            lastMaintenance = -Infinity;
          }
        };
        db.onversionchange = invalidate;
        db.onclose = invalidate;
        resolve(db);
      };
    });
  }
  async function migration(db) {
    const marker = await transaction(
      db,
      ["meta"],
      "readonly",
      (tx, result) => {
        const request = tx.objectStore("meta").get(MIGRATION);
        request.onsuccess = () => result(request.result);
      }
    );
    migrationTime(marker);
    if (marker === void 0) {
      let quarantine2 = function(key, value, reason) {
        if (!containsPrivate(value)) recovery.push({ key, reason, value, createdAt: at });
      }, importRows2 = function(key, valid) {
        const value = source[key];
        if (value === void 0) return [];
        if (!Array.isArray(value)) {
          quarantine2(key, value, "invalid-container");
          return [];
        }
        const seen = /* @__PURE__ */ new Set();
        const rows = [];
        for (const row of value) {
          if (containsPrivate(row)) continue;
          if (!valid(row) || seen.has(row.id)) {
            quarantine2(key, row, "invalid-or-duplicate-row");
            continue;
          }
          seen.add(row.id);
          rows.push(row);
        }
        return rows;
      };
      var quarantine = quarantine2, importRows = importRows2;
      const source = structuredClone(await legacy().get([...STORAGE_KEYS]));
      const at = timestamp();
      const recovery = [];
      const history2 = importRows2(HISTORY_KEY, validHistory);
      const jobs2 = importRows2(JOBS_KEY, isJob);
      const settings = [];
      for (const key of [OFFER_KEY, DOWNLOAD_OPTIONS_KEY]) {
        if (source[key] === void 0) continue;
        if (validSetting(key, source[key]) && !containsPrivate(source[key])) {
          settings.push({ key, value: source[key] });
        } else {
          quarantine2(key, source[key], "invalid-setting");
        }
      }
      await transaction(db, STORES, "readwrite", (tx) => {
        const check = tx.objectStore("meta").get(MIGRATION);
        check.onsuccess = () => guarded(tx, () => {
          if (check.result !== void 0) {
            migrationTime(check.result);
            return;
          }
          let remaining = STORES.length;
          let populated = false;
          for (const storeName of STORES) {
            const count = tx.objectStore(storeName).count();
            count.onsuccess = () => guarded(tx, () => {
              populated ||= count.result !== 0;
              if (--remaining) return;
              if (populated) {
                throw new Error("\uB85C\uCEEC DB \uC774\uC804 \uC815\uBCF4\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4. \uAE30\uC874 \uAE30\uB85D\uC744 \uBCF4\uD638\uD558\uAE30 \uC704\uD574 \uC790\uB3D9 \uC774\uC804\uACFC \uD30C\uC77C \uC815\uB9AC\uB97C \uC911\uB2E8\uD588\uC2B5\uB2C8\uB2E4.");
              }
              replace(tx.objectStore("history"), history2);
              replace(tx.objectStore("jobs"), jobs2);
              for (const setting of settings) tx.objectStore("settings").put(setting);
              for (const row of recovery) tx.objectStore("recovery").add(row);
              tx.objectStore("meta").put({ key: MIGRATION, value: at });
              tx.objectStore("meta").put({ key: CLEANUP_PENDING, value: true });
            });
          }
        });
      });
    }
    const pending = await transaction(
      db,
      ["meta"],
      "readonly",
      (tx, result) => {
        const request = tx.objectStore("meta").get(CLEANUP_PENDING);
        request.onsuccess = () => result(request.result?.value);
      }
    );
    if (pending === true) {
      try {
        await legacy().remove([...STORAGE_KEYS]);
      } catch {
        return;
      }
      await transaction(db, ["meta"], "readwrite", (tx) => {
        tx.objectStore("meta").put({ key: CLEANUP_PENDING, value: false });
      });
    }
  }
  async function maintain(db) {
    const at = timestamp();
    await transaction(db, STORES, "readwrite", (tx) => {
      const history2 = tx.objectStore("history").getAll();
      const jobs2 = tx.objectStore("jobs").getAll();
      const recovery = tx.objectStore("recovery").count();
      const marker = tx.objectStore("meta").get(MIGRATION);
      let remaining = 4;
      const finish2 = () => {
        if (--remaining) return;
        guarded(tx, () => {
          requireMigration(marker.result);
          const histories = unwrap(history2.result, validHistory);
          const queued = unwrap(jobs2.result, isJob);
          if (recovery.result === 0) {
            replace(tx.objectStore("history"), retainHistory(histories));
            replace(tx.objectStore("jobs"), retainJobs(queued, at));
          }
          tx.objectStore("meta").put({ key: MAINTENANCE, value: at });
        });
      };
      history2.onsuccess = finish2;
      jobs2.onsuccess = finish2;
      recovery.onsuccess = finish2;
      marker.onsuccess = finish2;
    });
    lastMaintenance = at;
  }
  async function ensure() {
    assertNormal();
    if (!barrier) {
      const pending = (async () => {
        const db = await open();
        connection = db;
        try {
          await migration(db);
          await maintain(db);
        } catch (error) {
          db.close();
          if (connection === db) connection = void 0;
          throw error;
        }
      })();
      barrier = pending;
      void pending.catch(() => {
        if (barrier === pending) barrier = void 0;
      });
    }
    await barrier;
    if (!connection) return ensure();
    return connection;
  }
  async function current() {
    const db = await ensure();
    if (timestamp() - lastMaintenance >= MAINTENANCE_INTERVAL) await maintain(db);
    return db;
  }
  const storage = {
    async ready() {
      if (!isPrivate()) await ensure();
    },
    async get(keys) {
      assertNormal();
      const requested = keyList(keys);
      const db = await current();
      return transaction(
        db,
        ["history", "jobs", "settings", "meta"],
        "readonly",
        (tx, result) => {
          const values = {};
          result(values);
          const marker = tx.objectStore("meta").get(MIGRATION);
          marker.onsuccess = () => guarded(tx, () => {
            requireMigration(marker.result);
          });
          for (const key of requested) {
            if (key === HISTORY_KEY || key === JOBS_KEY) {
              const request = tx.objectStore(
                key === HISTORY_KEY ? "history" : "jobs"
              ).getAll();
              request.onsuccess = () => guarded(tx, () => {
                values[key] = key === HISTORY_KEY ? unwrap(request.result, validHistory) : unwrap(request.result, isJob);
              });
            } else {
              const request = tx.objectStore("settings").get(key);
              request.onsuccess = () => guarded(tx, () => {
                if (request.result === void 0) {
                  values[key] = void 0;
                  return;
                }
                if (request.result.key !== key || !validSetting(key, request.result.value) || containsPrivate(request.result.value)) {
                  throw new Error("\uB85C\uCEEC DB \uC124\uC815\uC774 \uC190\uC0C1\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
                }
                values[key] = request.result.value;
              });
            }
          }
        }
      );
    },
    async set(values) {
      assertNormal();
      const snapshot = structuredClone(values);
      const keys = keyList(Object.keys(snapshot));
      for (const key of keys) {
        const value = snapshot[key];
        if (key === HISTORY_KEY || key === JOBS_KEY) {
          if (!Array.isArray(value) || value.some((row) => containsPrivate(row) || !(key === HISTORY_KEY ? validHistory(row) : isJob(row))) || new Set(value.map((row) => row.id)).size !== value.length) {
            throw new Error("\uC800\uC7A5\uD560 \uB85C\uCEEC DB \uAE30\uB85D\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
          }
        } else if (!validSetting(key, value) || containsPrivate(value)) {
          throw new Error("\uC800\uC7A5\uD560 \uB85C\uCEEC DB \uC124\uC815\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
        }
      }
      const db = await current();
      const at = timestamp();
      await transaction(db, STORES, "readwrite", (tx) => {
        const recovery = tx.objectStore("recovery").count();
        const marker = tx.objectStore("meta").get(MIGRATION);
        let remaining = 2;
        const write = () => {
          if (--remaining) return;
          guarded(tx, () => {
            requireMigration(marker.result);
            for (const key of keys) {
              if (key === HISTORY_KEY) {
                const rows = snapshot[key];
                replace(
                  tx.objectStore("history"),
                  recovery.result ? rows : retainHistory(rows)
                );
              } else if (key === JOBS_KEY) {
                const rows = snapshot[key];
                replace(
                  tx.objectStore("jobs"),
                  recovery.result ? rows : retainJobs(rows, at)
                );
              } else {
                tx.objectStore("settings").put({ key, value: snapshot[key] });
              }
            }
          });
        };
        recovery.onsuccess = write;
        marker.onsuccess = write;
      });
    },
    async status() {
      const status = {
        name,
        version: DATABASE_VERSION,
        privateContext: isPrivate(),
        historyCount: 0,
        jobCount: 0,
        recoveryCount: 0,
        lastMaintenanceAt: null,
        migratedAt: null,
        legacyCleanupPending: false
      };
      if (status.privateContext) return status;
      const db = await current();
      return transaction(db, STORES, "readonly", (tx, result) => {
        result(status);
        for (const [storeName, key] of [
          ["history", "historyCount"],
          ["jobs", "jobCount"],
          ["recovery", "recoveryCount"]
        ]) {
          const request = tx.objectStore(storeName).count();
          request.onsuccess = () => {
            status[key] = request.result;
          };
        }
        const maintenance = tx.objectStore("meta").get(MAINTENANCE);
        maintenance.onsuccess = () => guarded(tx, () => {
          status.lastMaintenanceAt = metaNumber(maintenance.result?.value);
        });
        const migration2 = tx.objectStore("meta").get(MIGRATION);
        migration2.onsuccess = () => guarded(tx, () => {
          status.migratedAt = requireMigration(migration2.result);
        });
        const pending = tx.objectStore("meta").get(CLEANUP_PENDING);
        pending.onsuccess = () => {
          status.legacyCleanupPending = pending.result?.value === true;
        };
      });
    },
    close() {
      connection?.close();
      connection = void 0;
      barrier = void 0;
      lastMaintenance = -Infinity;
    }
  };
  return storage;
}
var appStorage = createAppStorage();

// src/upscale/storage.ts
function privateContext() {
  return chrome.extension?.inIncognitoContext === true;
}
async function jobs() {
  if (privateContext()) return [];
  const stored = (await appStorage.get(JOBS_KEY))[JOBS_KEY];
  return Array.isArray(stored) ? stored.filter(isJob) : [];
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
    const retained = (await jobs()).filter((j) => j.id !== job.id);
    await appStorage.set({ [JOBS_KEY]: retained });
    const dir = await directory();
    await removeIfExists(dir, job.id);
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
  await appStorage.ready();
  const stored = await jobs();
  if ((await appStorage.status()).recoveryCount > 0) return stored;
  const dir = await directory();
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
  await appStorage.set({ [JOBS_KEY]: retained });
  const iterable = dir;
  for await (const name of iterable.keys()) if (!keep.has(name)) await removeIfExists(dir, name);
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
    if ((await appStorage.get(OFFER_KEY))[OFFER_KEY] === false) return;
    if ((await appStorage.status()).recoveryCount > 0) return;
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
    await appStorage.set({ [JOBS_KEY]: [job, ...retained] });
    if (!permitted()) {
      await appStorage.set({ [JOBS_KEY]: retained });
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
    await appStorage.set({ [JOBS_KEY]: retained.filter((job) => job.downloadId !== downloadId) });
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

// src/local/transport.ts
function transport(value) {
  if (typeof value !== "string") return void 0;
  if (/^h3(?:-\d+)?$/.test(value)) return "h3";
  if (value === "h2") return "h2";
  if (value === "http/1.1") return "http/1.1";
  return void 0;
}

// src/local/media-file.ts
var MIME_BY_EXTENSION = {
  mp4: "video/mp4",
  m4a: "audio/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  ogg: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  mp3: "audio/mpeg",
  aac: "audio/aac"
};
var InvalidMediaFileError = class extends Error {
  constructor() {
    super("\uC2E4\uC81C \uC601\uC0C1\xB7\uC624\uB514\uC624 \uD30C\uC77C\uC774 \uC544\uB2D9\uB2C8\uB2E4. HTML\xB7\uD14D\uC2A4\uD2B8\xB7\uC774\uBBF8\uC9C0 \uB300\uC2E0 \uC6D0\uBCF8 \uBBF8\uB514\uC5B4 \uC8FC\uC18C\uB97C \uC0AC\uC6A9\uD558\uC138\uC694.");
    this.name = "InvalidMediaFileError";
  }
};
function isMediaFileFormat(value) {
  if (!value || typeof value !== "object") return false;
  const actual = value;
  return typeof actual.extension === "string" && Object.hasOwn(MIME_BY_EXTENSION, actual.extension) && (actual.mime === MIME_BY_EXTENSION[actual.extension] || actual.extension === "ogg" && actual.mime === "video/ogg");
}
function format(extension) {
  return { mime: MIME_BY_EXTENSION[extension], extension };
}
function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
function uint32(bytes, offset, little = false) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, little);
}
function vint(bytes, offset) {
  const first = bytes[offset];
  if (first === void 0 || first === 0) return void 0;
  let length = 1, marker = 128;
  while (!(first & marker)) {
    length++;
    marker >>= 1;
  }
  if (offset + length > bytes.length) return void 0;
  let value = first & marker - 1;
  for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i];
  return Number.isSafeInteger(value) ? { value, length } : void 0;
}
function ebmlFormat(bytes) {
  if (bytes.length < 5 || uint32(bytes, 0) !== 440786851) return void 0;
  const header = vint(bytes, 4);
  if (!header) return void 0;
  const end = 4 + header.length + header.value;
  if (end > bytes.length) return void 0;
  for (let offset = 4 + header.length; offset < end; ) {
    const id = vint(bytes, offset);
    if (!id || id.length > 4) return void 0;
    const idText = ascii(bytes, offset, id.length);
    offset += id.length;
    const size = vint(bytes, offset);
    if (!size) return void 0;
    offset += size.length;
    if (offset + size.value > end) return void 0;
    if (idText === "B\x82") {
      const type = ascii(bytes, offset, size.value);
      return type === "webm" ? format("webm") : type === "matroska" ? format("mkv") : void 0;
    }
    offset += size.value;
  }
  return void 0;
}
var IMAGE_BRANDS = /* @__PURE__ */ new Set(["avif", "avis", "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "miaf", "MA1A", "MA1B"]);
var MP4_BRANDS = /* @__PURE__ */ new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso7", "iso8", "iso9", "mp41", "mp42", "avc1", "dash", "MSNV", "M4V ", "M4VH", "M4VP", "F4V "]);
var AUDIO_BRANDS = /* @__PURE__ */ new Set(["M4A ", "M4B ", "M4P ", "F4A ", "F4B "]);
function isoFormat(bytes) {
  for (let offset = 0; offset + 8 <= bytes.length; ) {
    const size = uint32(bytes, offset), type = ascii(bytes, offset + 4, 4);
    if (type === "ftyp") {
      if (size < 16 || size % 4 !== 0 || offset + size > bytes.length) return void 0;
      const brands = [ascii(bytes, offset + 8, 4)];
      for (let i = offset + 16; i < offset + size; i += 4) brands.push(ascii(bytes, i, 4));
      if (brands.some((brand) => IMAGE_BRANDS.has(brand))) return void 0;
      if (brands[0] === "qt  ") return format("mov");
      if (AUDIO_BRANDS.has(brands[0])) return format("m4a");
      if (brands.some((brand) => MP4_BRANDS.has(brand))) return format("mp4");
      return void 0;
    }
    if (type === "moov" && size >= 16 && offset + 16 <= bytes.length) {
      const childSize = uint32(bytes, offset + 8), childType = ascii(bytes, offset + 12, 4);
      if (childSize >= 8 && childSize <= size - 8 && ["mvhd", "trak", "udta", "cmov"].includes(childType)) return format("mov");
    }
    if (!["free", "skip", "wide"].includes(type) || size < 8 || offset + size > bytes.length) return void 0;
    offset += size;
  }
  return void 0;
}
function mp3Header(bytes, offset) {
  if (offset + 4 > bytes.length || bytes[offset] !== 255) return false;
  const second = bytes[offset + 1], third = bytes[offset + 2], fourth = bytes[offset + 3];
  return (second & 224) === 224 && (second >> 3 & 3) !== 1 && (second >> 1 & 3) === 1 && third >> 4 > 0 && third >> 4 < 15 && (third >> 2 & 3) < 3 && (fourth & 3) !== 2;
}
function inspectMediaFile(input) {
  const bytes = input.subarray(0, 65536);
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && uint32(bytes, 4, true) >= 4) {
    if (ascii(bytes, 8, 4) === "WAVE") return format("wav");
    if (ascii(bytes, 8, 4) === "AVI ") return format("avi");
  }
  const iso = isoFormat(bytes);
  if (iso) return iso;
  const ebml = ebmlFormat(bytes);
  if (ebml) return ebml;
  if (bytes.length >= 28 && ascii(bytes, 0, 4) === "OggS" && bytes[4] === 0 && bytes[26] > 0) {
    const segments = bytes[26], body = 27 + segments;
    let packet = 0;
    for (let i = 27; i < body && i < bytes.length; i++) {
      packet += bytes[i];
      if (bytes[i] !== 255) break;
    }
    if (packet > 0 && body + packet <= bytes.length) {
      if (ascii(bytes, body, 7) === "\x80theora") return { mime: "video/ogg", extension: "ogg" };
      if (ascii(bytes, body, 7) === "vorbis" || ascii(bytes, body, 8) === "OpusHead" || ascii(bytes, body, 5) === "\x7FFLAC" || ascii(bytes, body, 8) === "Speex   ") return format("ogg");
    }
  }
  if (bytes.length >= 42 && ascii(bytes, 0, 4) === "fLaC" && (bytes[4] & 127) === 0 && bytes[5] === 0 && bytes[6] === 0 && bytes[7] === 34) return format("flac");
  let audioOffset = 0;
  if (bytes.length >= 10 && ascii(bytes, 0, 3) === "ID3") {
    if (![2, 3, 4].includes(bytes[3]) || bytes[4] === 255 || bytes.subarray(6, 10).some((value) => value >= 128)) throw new InvalidMediaFileError();
    audioOffset = 10 + bytes[6] * 2 ** 21 + bytes[7] * 2 ** 14 + bytes[8] * 128 + bytes[9];
    if (bytes[3] === 4 && bytes[5] & 16) audioOffset += 10;
  }
  if (mp3Header(input, audioOffset)) return format("mp3");
  if (bytes.length >= 7 && bytes[0] === 255 && (bytes[1] & 246) === 240 && (bytes[2] >> 2 & 15) < 13) {
    const length = (bytes[3] & 3) * 2048 + bytes[4] * 8 + (bytes[5] >> 5);
    if (length >= (bytes[1] & 1 ? 7 : 9)) return format("aac");
  }
  throw new InvalidMediaFileError();
}
function mediaFilename(old, actual) {
  if (!isMediaFileFormat(actual)) throw new InvalidMediaFileError();
  let base = safeBasename(old).replace(/\.[^.]+$/, "").replace(/(?:\.(?:txt|text))+$/i, "").replace(/[. ]+$/g, "") || "media";
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  return `${base.slice(0, 174)}.${actual.extension}`;
}
function abortable(work, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("\uC791\uC5C5\uC744 \uCDE8\uC18C\uD588\uC2B5\uB2C8\uB2E4.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}
async function probeMediaFile(url, signal, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Math.min(15e3, Math.max(1, Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15e3));
  const timer = setTimeout(() => controller.abort(new Error("\uBBF8\uB514\uC5B4 \uD30C\uC77C \uD655\uC778 \uC2DC\uAC04\uC774 \uCD08\uACFC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.")), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let response, reader;
  const prefix = new Uint8Array(65536);
  try {
    combined.throwIfAborted();
    const request = (options.fetch ?? globalThis.fetch)(mediaURL(url).href, {
      method: "GET",
      headers: { Range: "bytes=0-65535" },
      credentials: "include",
      redirect: "follow",
      signal: combined
    }).then((value) => {
      if (combined.aborted) {
        if (value.body) void value.body.cancel().catch(() => {
        });
        combined.throwIfAborted();
      }
      return value;
    });
    response = await abortable(request, combined);
    combined.throwIfAborted();
    if (!response.ok || ![200, 206].includes(response.status)) throw new Error(`\uBBF8\uB514\uC5B4 \uD655\uC778 \uC694\uCCAD \uC2E4\uD328 (${response.status})`);
    if (response.url) mediaURL(response.url);
    if (response.status === 206) {
      const range = response.headers.get("Content-Range")?.match(/^bytes 0-(\d+)\/(\d+|\*)$/i);
      if (!range || Number(range[1]) > 65535 || range[2] !== "*" && Number(range[2]) <= Number(range[1])) throw new Error("\uC11C\uBC84\uAC00 \uC798\uBABB\uB41C \uBBF8\uB514\uC5B4 \uD655\uC778 \uBC94\uC704\uB97C \uBC18\uD658\uD588\uC2B5\uB2C8\uB2E4.");
      const encoding = response.headers.get("Content-Encoding");
      if (encoding && encoding.toLowerCase() !== "identity") throw new Error("\uC555\uCD95\uB41C \uBBF8\uB514\uC5B4 \uD655\uC778 \uBC94\uC704\uB294 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
    }
    if (!response.body) throw new InvalidMediaFileError();
    reader = response.body.getReader();
    let used = 0;
    while (used < prefix.length) {
      const chunk = await abortable(reader.read(), combined);
      combined.throwIfAborted();
      if (chunk.done) break;
      const take = Math.min(chunk.value.length, prefix.length - used);
      prefix.set(chunk.value.subarray(0, take), used);
      used += take;
    }
    return inspectMediaFile(prefix.subarray(0, used));
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {
    });
    else if (response?.body) void response.body.cancel().catch(() => {
    });
  }
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
var rescans = /* @__PURE__ */ new Map();
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
  const raw = (await appStorage.get(HISTORY_KEY))[HISTORY_KEY];
  return Array.isArray(raw) ? raw.filter(isHistory).filter((row) => !row.incognito) : [];
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
    await appStorage.set({ [HISTORY_KEY]: [item, ...existing] });
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
    else await appStorage.set({ [HISTORY_KEY]: rows.filter((row) => !row.incognito).map((row) => row.id === id ? next : row) });
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
      const directOriginal = options.output === "original" && item.kind === "file";
      if (!directOriginal || !item.size || item.size <= MAX_INPUT_BYTES) {
        let result;
        try {
          await ensureOffscreen();
          if (cancelled.has(entry.id)) throw new DOMException("\uC791\uC5C5\uC744 \uCDE8\uC18C\uD588\uC2B5\uB2C8\uB2E4.", "AbortError");
          result = await chrome.runtime.sendMessage({ scope: OFFSCREEN_SCOPE, type: "prepare", id: entry.id, url: item.url, kind: item.kind, options });
        } catch (error) {
          if (!directOriginal || cancelled.has(entry.id)) throw error;
        }
        if (record(result) && result.ok === true) {
          if (typeof result.url !== "string" || !result.url.startsWith(`blob:${chrome.runtime.getURL("")}`) || !isMediaFileFormat(result)) throw new Error("\uC900\uBE44\uD55C \uD30C\uC77C\uC758 \uBBF8\uB514\uC5B4 \uD615\uC2DD\uC744 \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
          address = result.url;
          entry.filename = mediaFilename(entry.filename, result);
          if (Array.isArray(result.protocols)) transferProtocols = result.protocols.map(transport).filter((value) => value !== void 0);
        } else if (!directOriginal || record(result) && result.invalidMedia === true) {
          throw new Error(record(result) && typeof result.error === "string" ? result.error : "\uD30C\uC77C\uC744 \uC900\uBE44\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
        }
      }
      if (cancelled.has(entry.id)) throw new DOMException("\uC791\uC5C5\uC744 \uCDE8\uC18C\uD588\uC2B5\uB2C8\uB2E4.", "AbortError");
      if (address === item.url) {
        const controller = new AbortController();
        const stop = setInterval(() => {
          if (cancelled.has(entry.id)) controller.abort();
        }, 50);
        try {
          entry.filename = mediaFilename(entry.filename, await probeMediaFile(item.url, controller.signal));
        } finally {
          clearInterval(stop);
        }
      }
      if (cancelled.has(entry.id)) throw new DOMException("\uC791\uC5C5\uC744 \uCDE8\uC18C\uD588\uC2B5\uB2C8\uB2E4.", "AbortError");
      await update(entry, true);
      if (cancelled.has(entry.id)) throw new DOMException("\uC791\uC5C5\uC744 \uCDE8\uC18C\uD588\uC2B5\uB2C8\uB2E4.", "AbortError");
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
    if (value.rescanId !== void 0) {
      const ticket = rescans.get(sender.tab.id);
      if (!ticket || value.rescanId !== ticket.id || ticket.epoch !== discoveryEpochs.get(sender.tab.id) || mediaURL(sender.url).href !== mediaURL(ticket.url).href) throw new Error("\uD398\uC774\uC9C0\uAC00 \uBCC0\uACBD\uB418\uC5B4 \uAC10\uC9C0 \uACB0\uACFC\uB97C \uCDE8\uC18C\uD588\uC2B5\uB2C8\uB2E4.");
    }
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
  if (value.type === "list" || value.type === "rescan") {
    let tabId;
    if (value.type === "rescan") {
      const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true })).find((candidate) => !!candidate.incognito === chrome.extension.inIncognitoContext && candidate.id !== void 0 && typeof candidate.url === "string" && /^https?:/.test(candidate.url));
      if (tab?.id === void 0 || !tab.url) throw new Error("\uC601\uC0C1\uC774 \uC788\uB294 \uC6F9\uD398\uC774\uC9C0\uB97C \uC5F0 \uB4A4 \uB2E4\uC2DC \uAC10\uC9C0\uD558\uC138\uC694.");
      tabId = tab.id;
      const epoch = discoveryEpochs.get(tabId) ?? {};
      discoveryEpochs.set(tabId, epoch);
      const ticket = { id: crypto.randomUUID(), epoch, url: tab.url };
      rescans.set(tabId, ticket);
      let timeout;
      try {
        const result = await Promise.race([
          chrome.tabs.sendMessage(tabId, { scope: SCOPE, type: "rescan", rescanId: ticket.id }, { frameId: 0 }),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("\uD398\uC774\uC9C0\uC758 \uC751\uB2F5\uC774 \uC5C6\uC2B5\uB2C8\uB2E4. \uC0C8\uB85C\uACE0\uCE68\uD55C \uB4A4 \uB2E4\uC2DC \uAC10\uC9C0\uD558\uC138\uC694.")), 3e3);
          })
        ]);
        if (!record(result) || result.ok !== true) throw new Error("\uD398\uC774\uC9C0\uB97C \uC0C8\uB85C\uACE0\uCE68\uD55C \uB4A4 \uB2E4\uC2DC \uAC10\uC9C0\uD558\uC138\uC694.");
        const current = await chrome.tabs.get(tabId);
        if (rescans.get(tabId) !== ticket || ticket.epoch !== discoveryEpochs.get(tabId) || current.url !== ticket.url || !!current.incognito !== chrome.extension.inIncognitoContext) {
          throw new Error("\uD398\uC774\uC9C0\uAC00 \uBCC0\uACBD\uB418\uC5B4 \uAC10\uC9C0 \uACB0\uACFC\uB97C \uCDE8\uC18C\uD588\uC2B5\uB2C8\uB2E4.");
        }
      } finally {
        clearTimeout(timeout);
        if (rescans.get(tabId) === ticket) rescans.delete(tabId);
      }
    } else tabId = await currentTab();
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
      } else await appStorage.set({ [HISTORY_KEY]: (await history()).filter((row) => activeStates.includes(row.state)) });
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
  rescans.delete(id);
  if (lastTab === id) lastTab = void 0;
});
chrome.tabs.onUpdated.addListener((id, changes, tab) => {
  if (changes.url !== void 0) rescans.delete(id);
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
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {
  });
  await chrome.action.setPopup({ popup: "local/popup.html" });
  if (!chrome.extension.inIncognitoContext) {
    await appStorage.ready();
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
  if (!chrome.extension.inIncognitoContext && (await appStorage.status()).recoveryCount > 0) return;
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
