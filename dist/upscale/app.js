// src/shared/filename.ts
function safeBasename(input2) {
  return (input2.split(/[\\/]/).at(-1) ?? "media").replace(/[\x00-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, "_").replace(/[. ]+$/g, "").slice(0, 180) || "media";
}

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
function outputName(filename, factor2, kind) {
  const base = safeBasename(filename).replace(/\.[^.]+$/, "") || "media";
  return `${base}-${factor2}x.${kind === "video" ? "mp4" : "png"}`;
}

// src/security/validation.ts
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// src/local/model.ts
var HISTORY_KEY = "my_video_app_history_v1";
var MAX_HISTORY = 200;
var MAX_STREAM_BYTES = 128 * 1024 * 1024;
var DOWNLOAD_STATES = ["preparing", "downloading", "scanning", "review", "discarded", "complete", "cancelled", "error"];
var ACTIVE_HISTORY_STATES = ["preparing", "downloading", "scanning", "review"];
function isActiveHistoryState(state) {
  return ACTIVE_HISTORY_STATES.includes(state);
}
function retainHistory(rows) {
  const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt);
  const active = (row) => isActiveHistoryState(row.state);
  return [...sorted.filter(active), ...sorted.filter((row) => !active(row))].slice(0, MAX_HISTORY);
}
function isHistory(value) {
  return record(value) && typeof value.id === "string" && /^[a-f0-9-]{36}$/.test(value.id) && typeof value.url === "string" && typeof value.filename === "string" && ["file", "hls", "dash"].includes(String(value.kind)) && DOWNLOAD_STATES.includes(String(value.state)) && typeof value.createdAt === "number" && Number.isFinite(value.createdAt) && typeof value.incognito === "boolean";
}

// src/shared/media.ts
var MEDIA_FILE_MIME = Object.freeze({
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
});
var PROCESSING_MIME = Object.freeze({
  mp4: MEDIA_FILE_MIME.mp4,
  webm: MEDIA_FILE_MIME.webm,
  mkv: MEDIA_FILE_MIME.mkv,
  mp3: MEDIA_FILE_MIME.mp3,
  m4a: MEDIA_FILE_MIME.m4a,
  wav: MEDIA_FILE_MIME.wav,
  png: "image/png"
});
var VIDEO_FORMATS = Object.freeze(["mp4", "webm", "mkv"]);
var AUDIO_FORMATS = Object.freeze(["mp3", "m4a", "wav"]);
var MERGE_FORMATS = Object.freeze(["mp4", "mkv"]);
var QUALITIES = Object.freeze(["highest", "2160", "1080", "720", "480"]);
var DOWNLOAD_OUTPUTS = Object.freeze(["original", "mp3", "m4a"]);
var ENCODER_ARGUMENTS = Object.freeze({
  h264: Object.freeze(["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"]),
  vp8: Object.freeze(["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "4", "-crf", "10", "-b:v", "4M"]),
  mp3: Object.freeze(["-c:a", "libmp3lame", "-b:a", "192k"]),
  aac: Object.freeze(["-c:a", "aac", "-b:a", "192k"]),
  pcm16: Object.freeze(["-c:a", "pcm_s16le"]),
  opus: Object.freeze(["-c:a", "libopus", "-b:a", "192k"])
});

// src/local/preferences.ts
function downloadOptions(value) {
  if (value === void 0) return { quality: "highest", output: "original" };
  if (!record(value) || !QUALITIES.includes(value.quality) || !DOWNLOAD_OUTPUTS.includes(String(value.output))) throw new Error("\uB2E4\uC6B4\uB85C\uB4DC \uD654\uC9C8 \uB610\uB294 \uC800\uC7A5 \uD615\uC2DD\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
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
  const isPrivate2 = options.privateContext ?? (() => globalThis.chrome?.extension?.inIncognitoContext === true);
  const now = options.now ?? Date.now;
  const transactionErrors = /* @__PURE__ */ new WeakMap();
  let connection;
  let barrier;
  let lastMaintenance = -Infinity;
  function assertNormal() {
    if (isPrivate2()) throw new Error("\uC2DC\uD06C\uB9BF \uBAA8\uB4DC\uC5D0\uC11C\uB294 \uB85C\uCEEC DB\uB97C \uC0AC\uC6A9\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
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
  function transaction(db, names, mode2, start2) {
    return new Promise((resolve, reject) => {
      let result;
      let tx;
      try {
        tx = db.transaction(names, mode2);
      } catch (error) {
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(transactionErrors.get(tx) ?? tx.error ?? new Error("\uB85C\uCEEC DB \uD2B8\uB79C\uC7AD\uC158\uC744 \uC644\uB8CC\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4."));
      tx.onerror = () => {
      };
      guarded(tx, () => start2(tx, (value) => {
        result = value;
      }));
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
      const history = importRows2(HISTORY_KEY, validHistory);
      const jobs2 = importRows2(JOBS_KEY, isJob);
      const settings2 = [];
      for (const key of [OFFER_KEY, DOWNLOAD_OPTIONS_KEY]) {
        if (source[key] === void 0) continue;
        if (validSetting(key, source[key]) && !containsPrivate(source[key])) {
          settings2.push({ key, value: source[key] });
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
              replace(tx.objectStore("history"), history);
              replace(tx.objectStore("jobs"), jobs2);
              for (const setting of settings2) tx.objectStore("settings").put(setting);
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
      const history = tx.objectStore("history").getAll();
      const jobs2 = tx.objectStore("jobs").getAll();
      const recovery = tx.objectStore("recovery").count();
      const marker = tx.objectStore("meta").get(MIGRATION);
      let remaining = 4;
      const finish = () => {
        if (--remaining) return;
        guarded(tx, () => {
          requireMigration(marker.result);
          const histories = unwrap(history.result, validHistory);
          const queued = unwrap(jobs2.result, isJob);
          if (recovery.result === 0) {
            replace(tx.objectStore("history"), retainHistory(histories));
            replace(tx.objectStore("jobs"), retainJobs(queued, at));
          }
          tx.objectStore("meta").put({ key: MAINTENANCE, value: at });
        });
      };
      history.onsuccess = finish;
      jobs2.onsuccess = finish;
      recovery.onsuccess = finish;
      marker.onsuccess = finish;
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
      if (!isPrivate2()) await ensure();
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
      const status2 = {
        name,
        version: DATABASE_VERSION,
        privateContext: isPrivate2(),
        historyCount: 0,
        jobCount: 0,
        recoveryCount: 0,
        lastMaintenanceAt: null,
        migratedAt: null,
        legacyCleanupPending: false
      };
      if (status2.privateContext) return status2;
      const db = await current();
      return transaction(db, STORES, "readonly", (tx, result) => {
        result(status2);
        for (const [storeName, key] of [
          ["history", "historyCount"],
          ["jobs", "jobCount"],
          ["recovery", "recoveryCount"]
        ]) {
          const request = tx.objectStore(storeName).count();
          request.onsuccess = () => {
            status2[key] = request.result;
          };
        }
        const maintenance = tx.objectStore("meta").get(MAINTENANCE);
        maintenance.onsuccess = () => guarded(tx, () => {
          status2.lastMaintenanceAt = metaNumber(maintenance.result?.value);
        });
        const migration2 = tx.objectStore("meta").get(MIGRATION);
        migration2.onsuccess = () => guarded(tx, () => {
          status2.migratedAt = requireMigration(migration2.result);
        });
        const pending = tx.objectStore("meta").get(CLEANUP_PENDING);
        pending.onsuccess = () => {
          status2.legacyCleanupPending = pending.result?.value === true;
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

// src/upscale/processing.ts
function processingOptions(value) {
  if (!record(value)) throw new Error("\uCC98\uB9AC \uC124\uC815\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  if (value.mode === "upscale" && (value.factor === 2 || value.factor === 4)) return { mode: "upscale", factor: value.factor };
  if (value.mode === "convert" && VIDEO_FORMATS.includes(String(value.format)) && QUALITIES.includes(value.quality)) return { mode: "convert", format: value.format, quality: value.quality };
  if (value.mode === "audio" && AUDIO_FORMATS.includes(String(value.format))) return { mode: "audio", format: value.format };
  if (value.mode === "merge" && MERGE_FORMATS.includes(String(value.format))) return { mode: "merge", format: value.format };
  throw new Error("\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uCC98\uB9AC \uC124\uC815\uC785\uB2C8\uB2E4.");
}
var MIME = PROCESSING_MIME;
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
var offerTouched = false;
var MODE_HINTS = Object.freeze({
  upscale: "Lanczos 2x/4x \uBCF4\uAC04\uC785\uB2C8\uB2E4. AI \uBCF5\uC6D0\uC740 \uC544\uB2D9\uB2C8\uB2E4. \uC601\uC0C1\uC740 MP4(H.264/AAC), \uC774\uBBF8\uC9C0\uB294 PNG\uB85C \uC800\uC7A5\uD569\uB2C8\uB2E4.",
  convert: "MP4\xB7MKV\uB294 H.264/AAC, WebM\uC740 VP8/Opus\uB85C \uBCC0\uD658\uD569\uB2C8\uB2E4. \uC120\uD0DD \uB192\uC774\uB294 \uC0C1\uD55C\uC774\uBA70 \uC791\uC740 \uC6D0\uBCF8\uC744 \uD655\uB300\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.",
  audio: "\uC601\uC0C1 \uB610\uB294 \uC624\uB514\uC624\uC758 \uCCAB \uC74C\uC131 \uD2B8\uB799\uC744 \uC800\uC7A5\uD569\uB2C8\uB2E4. MP3/M4A\uB294 192kbps\uB85C \uC778\uCF54\uB529\uD558\uBA70 WAV\uB294 \uC6D0\uBCF8\uC5D0\uC11C \uB514\uCF54\uB529\uD55C PCM\uC785\uB2C8\uB2E4.",
  merge: "\uC601\uC0C1 \uD30C\uC77C\uACFC \uBCC4\uB3C4 \uC74C\uC131 \uD30C\uC77C\uC744 \uC120\uD0DD\uD558\uC138\uC694. \uC601\uC0C1\uC758 \uAE30\uC874 \uC74C\uC131 \uB300\uC2E0 \uC120\uD0DD\uD55C \uD30C\uC77C\uC758 \uCCAB \uC74C\uC131 \uD2B8\uB799\uC744 \uC0AC\uC6A9\uD569\uB2C8\uB2E4."
});
var MODE_START_LABELS = Object.freeze({ upscale: "\uD655\uB300 \uC2DC\uC791", convert: "\uC601\uC0C1 \uBCC0\uD658", audio: "\uC624\uB514\uC624 \uB9CC\uB4E4\uAE30", merge: "\uBCD1\uD569 \uC2DC\uC791" });
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
var offerPreferencesReady = (async () => {
  if (isPrivate) return;
  try {
    const enabled = (await appStorage.get(OFFER_KEY))[OFFER_KEY] !== false;
    if (!offerTouched) offer.checked = enabled;
  } catch (error) {
    showError(error);
  }
})();
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
  element("mode-hint").textContent = MODE_HINTS[mode.value] ?? "";
  start.textContent = MODE_START_LABELS[mode.value] ?? "\uC2DC\uC791";
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
  offerTouched = true;
  if (isPrivate) return;
  const enabled = offer.checked;
  void offerPreferencesReady.then(() => appStorage.set({ [OFFER_KEY]: enabled })).catch(showError);
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
  await offerPreferencesReady;
  await refresh();
  const id = new URL(location.href).searchParams.get("job");
  if (isJobId(id)) {
    const job = (await jobs()).find((j) => j.id === id);
    if (job) await selectJob(job);
    else status.textContent = "\uC784\uC2DC \uBCF5\uC0AC\uBCF8\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uC6D0\uBCF8 \uD30C\uC77C\uC744 \uC9C1\uC811 \uC120\uD0DD\uD558\uC138\uC694.";
  }
})().catch(showError);
