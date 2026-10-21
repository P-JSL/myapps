// src/security/validation.ts
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// src/local/model.ts
var SCOPE = "my-video-app/local";
var HISTORY_KEY = "my_video_app_history_v1";
var MAX_HISTORY = 200;
var MAX_STREAM_BYTES = 128 * 1024 * 1024;
var DOWNLOAD_STATES = ["preparing", "downloading", "scanning", "review", "discarded", "complete", "cancelled", "error"];
var ACTIVE_HISTORY_STATES = ["preparing", "downloading", "scanning", "review"];
function isActiveHistoryState(state) {
  return ACTIVE_HISTORY_STATES.includes(state);
}
function retainHistory(rows2) {
  const sorted = [...rows2].sort((a, b) => b.createdAt - a.createdAt);
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

// src/upscale/policy.ts
var MAX_INPUT_BYTES = 256 * 1024 * 1024;
var MAX_QUEUE_BYTES = 512 * 1024 * 1024;
var MAX_JOBS = 4;
var RETENTION_MS = 24 * 60 * 60 * 1e3;
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
function unwrap(rows2, valid) {
  const orders = /* @__PURE__ */ new Set();
  const result = [];
  for (const candidate of rows2) {
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
      guarded(tx, () => start(tx, (value) => {
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
      let request2;
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
        request2 = factory.open(name, DATABASE_VERSION);
      } catch (error) {
        fail(error);
        return;
      }
      request2.onblocked = () => {
        timeout ??= setTimeout(
          () => fail(new Error("\uB2E4\uB978 \uCC3D\uC774 \uB85C\uCEEC DB \uAC31\uC2E0\uC744 \uB9C9\uACE0 \uC788\uC2B5\uB2C8\uB2E4. \uD574\uB2F9 \uCC3D\uC744 \uB2EB\uACE0 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694.")),
          options.blockedTimeoutMs ?? 5e3
        );
      };
      request2.onerror = () => fail(request2.error ?? new Error("\uB85C\uCEEC DB\uB97C \uC5F4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4."));
      request2.onupgradeneeded = () => {
        if (settled) {
          request2.transaction?.abort();
          return;
        }
        const db = request2.result;
        for (const storeName of ["history", "jobs"]) {
          const store = db.objectStoreNames.contains(storeName) ? request2.transaction.objectStore(storeName) : db.createObjectStore(storeName, { keyPath: "id" });
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
      request2.onsuccess = () => {
        if (settled) {
          request2.result.close();
          return;
        }
        settled = true;
        clearTimeout(timeout);
        const db = request2.result;
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
        const request2 = tx.objectStore("meta").get(MIGRATION);
        request2.onsuccess = () => result(request2.result);
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
        const rows2 = [];
        for (const row of value) {
          if (containsPrivate(row)) continue;
          if (!valid(row) || seen.has(row.id)) {
            quarantine2(key, row, "invalid-or-duplicate-row");
            continue;
          }
          seen.add(row.id);
          rows2.push(row);
        }
        return rows2;
      };
      var quarantine = quarantine2, importRows = importRows2;
      const source = structuredClone(await legacy().get([...STORAGE_KEYS]));
      const at = timestamp();
      const recovery = [];
      const history = importRows2(HISTORY_KEY, validHistory);
      const jobs = importRows2(JOBS_KEY, isJob);
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
              replace(tx.objectStore("history"), history);
              replace(tx.objectStore("jobs"), jobs);
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
        const request2 = tx.objectStore("meta").get(CLEANUP_PENDING);
        request2.onsuccess = () => result(request2.result?.value);
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
      const jobs = tx.objectStore("jobs").getAll();
      const recovery = tx.objectStore("recovery").count();
      const marker = tx.objectStore("meta").get(MIGRATION);
      let remaining = 4;
      const finish = () => {
        if (--remaining) return;
        guarded(tx, () => {
          requireMigration(marker.result);
          const histories = unwrap(history.result, validHistory);
          const queued = unwrap(jobs.result, isJob);
          if (recovery.result === 0) {
            replace(tx.objectStore("history"), retainHistory(histories));
            replace(tx.objectStore("jobs"), retainJobs(queued, at));
          }
          tx.objectStore("meta").put({ key: MAINTENANCE, value: at });
        });
      };
      history.onsuccess = finish;
      jobs.onsuccess = finish;
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
              const request2 = tx.objectStore(
                key === HISTORY_KEY ? "history" : "jobs"
              ).getAll();
              request2.onsuccess = () => guarded(tx, () => {
                values[key] = key === HISTORY_KEY ? unwrap(request2.result, validHistory) : unwrap(request2.result, isJob);
              });
            } else {
              const request2 = tx.objectStore("settings").get(key);
              request2.onsuccess = () => guarded(tx, () => {
                if (request2.result === void 0) {
                  values[key] = void 0;
                  return;
                }
                if (request2.result.key !== key || !validSetting(key, request2.result.value) || containsPrivate(request2.result.value)) {
                  throw new Error("\uB85C\uCEEC DB \uC124\uC815\uC774 \uC190\uC0C1\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
                }
                values[key] = request2.result.value;
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
                const rows2 = snapshot[key];
                replace(
                  tx.objectStore("history"),
                  recovery.result ? rows2 : retainHistory(rows2)
                );
              } else if (key === JOBS_KEY) {
                const rows2 = snapshot[key];
                replace(
                  tx.objectStore("jobs"),
                  recovery.result ? rows2 : retainJobs(rows2, at)
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
        privateContext: isPrivate(),
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
          const request2 = tx.objectStore(storeName).count();
          request2.onsuccess = () => {
            status2[key] = request2.result;
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

// src/local/popup.ts
function node(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error("Missing " + id);
  return element;
}
var status = node("status");
var pendingDownloads = /* @__PURE__ */ new Set();
var rows = /* @__PURE__ */ new Map();
var selectedOptions = downloadOptions();
var preferencesLoaded = false;
var refreshing = false;
var currentItems = [];
var currentHistory = [];
function message(text) {
  status.textContent = text;
  status.hidden = !text;
}
function showError(error) {
  message(error instanceof Error ? error.message : "\uC694\uCCAD \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4.");
}
async function request(type, data = {}) {
  const result = await chrome.runtime.sendMessage({ scope: SCOPE, type, ...data });
  if (!record(result) || result.ok !== true) throw new Error(record(result) && typeof result.error === "string" ? result.error : "\uD655\uC7A5 \uD504\uB85C\uADF8\uB7A8\uC744 \uB2E4\uC2DC \uB85C\uB4DC\uD558\uACE0 \uD398\uC774\uC9C0\uB97C \uC0C8\uB85C\uACE0\uCE68\uD558\uC138\uC694.");
  return result;
}
function isMedia(value) {
  return record(value) && typeof value.id === "string" && typeof value.url === "string" && typeof value.title === "string" && typeof value.mime === "string" && ["file", "hls", "dash"].includes(String(value.kind)) && typeof value.tabId === "number" && typeof value.createdAt === "number";
}
var preferencesReady = (async () => {
  try {
    if (!chrome.extension.inIncognitoContext) selectedOptions = downloadOptions((await appStorage.get(DOWNLOAD_OPTIONS_KEY))[DOWNLOAD_OPTIONS_KEY]);
  } catch {
    message("\uC800\uC7A5\uB41C \uB2E4\uC6B4\uB85C\uB4DC \uC124\uC815\uC744 \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. \uCD5C\uACE0 \uD654\uC9C8\xB7\uC6D0\uBCF8 \uD615\uC2DD\uC73C\uB85C \uB2E4\uC6B4\uB85C\uB4DC\uD569\uB2C8\uB2E4.");
  } finally {
    preferencesLoaded = true;
    renderMedia();
  }
})();
function activeDownload(item) {
  return currentHistory.some((entry) => entry.url === item.url && isActiveHistoryState(entry.state) && (entry.options?.quality ?? "highest") === selectedOptions.quality && (entry.options?.output ?? "original") === selectedOptions.output);
}
function mediaDetail(item) {
  let host = "";
  try {
    host = new URL(item.url).hostname;
  } catch {
  }
  const kind = item.kind === "hls" ? "HLS" : item.kind === "dash" ? "DASH" : item.mime.startsWith("audio/") ? "\uC624\uB514\uC624" : "\uBBF8\uB514\uC5B4";
  const size = typeof item.size === "number" && item.size > 0 ? " \xB7 " + (item.size / 1024 / 1024).toFixed(1) + " MB" : "";
  return kind + (host ? " \xB7 " + host : "") + size;
}
function createRow(item) {
  const row = document.createElement("li");
  row.className = "media-row";
  row.dataset.rowId = item.id;
  const copy = document.createElement("div");
  copy.className = "media-copy";
  const title = document.createElement("p");
  title.className = "media-title";
  const detail = document.createElement("p");
  detail.className = "media-detail";
  const download = document.createElement("button");
  download.className = "download-button";
  download.dataset.action = "download";
  copy.append(title, detail);
  row.append(copy, download);
  const entry = { item, row, title, detail, download };
  download.addEventListener("click", () => {
    void startDownload(entry.item);
  });
  return entry;
}
function renderMedia() {
  const list = node("media");
  const focused = document.activeElement;
  const focusedButton = focused instanceof HTMLButtonElement && list.contains(focused) ? focused : void 0;
  const retained = /* @__PURE__ */ new Set();
  let cursor = list.firstElementChild;
  for (const item of currentItems) {
    if (retained.has(item.id)) continue;
    retained.add(item.id);
    const entry = rows.get(item.id) ?? createRow(item);
    rows.set(item.id, entry);
    entry.item = item;
    entry.title.textContent = item.title || "\uC81C\uBAA9 \uC5C6\uB294 \uBBF8\uB514\uC5B4";
    entry.title.title = item.title || "\uC81C\uBAA9 \uC5C6\uB294 \uBBF8\uB514\uC5B4";
    entry.detail.textContent = mediaDetail(item);
    const busy = pendingDownloads.has(item.id) || activeDownload(item);
    entry.download.textContent = busy ? "\uCC98\uB9AC \uC911" : "\uB2E4\uC6B4\uB85C\uB4DC";
    entry.download.disabled = busy || !preferencesLoaded;
    if (entry.row === cursor) cursor = cursor.nextElementSibling;
    else list.insertBefore(entry.row, cursor);
  }
  for (const [id, entry] of rows) if (!retained.has(id)) {
    entry.row.remove();
    rows.delete(id);
  }
  if (focusedButton?.isConnected && !focusedButton.disabled && document.activeElement !== focusedButton) focusedButton.focus({ preventScroll: true });
  node("waiting").hidden = retained.size > 0;
  node("media-view").hidden = retained.size === 0;
  node("media-count").textContent = retained.size + "\uAC1C";
  const reviews = currentHistory.filter((entry) => entry.state === "review").length;
  const summary = node("review-summary");
  summary.hidden = reviews === 0;
  summary.textContent = "\uD655\uC778\uC774 \uD544\uC694\uD55C \uB2E4\uC6B4\uB85C\uB4DC " + reviews + "\uAC1C \xB7 \uAE30\uB85D\uC5D0\uC11C \uAC80\uD1A0";
}
function applyResult(result) {
  currentItems = Array.isArray(result.items) ? result.items.filter(isMedia) : [];
  currentHistory = Array.isArray(result.history) ? result.history.filter(isHistory) : [];
  renderMedia();
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    applyResult(await request("list"));
  } catch (error) {
    showError(error);
  } finally {
    refreshing = false;
  }
}
async function startDownload(item) {
  if (pendingDownloads.has(item.id) || activeDownload(item)) return;
  pendingDownloads.add(item.id);
  renderMedia();
  try {
    await preferencesReady;
    message("");
    const result = await request("download", { id: item.id, options: selectedOptions });
    const started = result.item;
    if (isHistory(started)) currentHistory = [started, ...currentHistory.filter((entry) => entry.id !== started.id)];
    message("\uB2E4\uC6B4\uB85C\uB4DC\uB97C \uC2DC\uC791\uD588\uC2B5\uB2C8\uB2E4. \uC9C4\uD589 \uC0C1\uD669\uC740 \uAE30\uB85D\uC5D0\uC11C \uD655\uC778\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    pendingDownloads.delete(item.id);
    renderMedia();
  }
}
async function openApp(history = false) {
  await chrome.tabs.create({ url: chrome.runtime.getURL("local/index.html" + (history ? "?view=history" : "")) });
}
function action(id, run) {
  const button = node(id);
  button.addEventListener("click", () => {
    if (button.disabled) return;
    button.disabled = true;
    void run().catch(showError).finally(() => {
      button.disabled = false;
    });
  });
}
action("settings", () => openApp());
action("history", () => openApp(true));
action("review-summary", () => openApp(true));
action("folder", async () => {
  await chrome.downloads.showDefaultFolder();
});
action("upscale", async () => {
  await request("upscale");
});
action("clear-history", async () => {
  await request("clear-history");
  message("\uC644\uB8CC\uB41C \uAE30\uB85D\uB9CC \uC0AD\uC81C\uD588\uC2B5\uB2C8\uB2E4. \uC800\uC7A5\uD55C \uD30C\uC77C\uACFC \uC9C4\uD589\xB7\uAC80\uD1A0 \uC911\uC778 \uAE30\uB85D\uC740 \uC720\uC9C0\uB429\uB2C8\uB2E4.");
  await refresh();
});
action("rescan", async () => {
  if (refreshing) {
    message("\uBBF8\uB514\uC5B4 \uBAA9\uB85D\uC744 \uBD88\uB7EC\uC624\uB294 \uC911\uC785\uB2C8\uB2E4. \uC7A0\uC2DC \uB4A4 \uB2E4\uC2DC \uAC10\uC9C0\uD574 \uC8FC\uC138\uC694.");
    return;
  }
  message("\uD604\uC7AC \uD398\uC774\uC9C0\uC5D0\uC11C \uBBF8\uB514\uC5B4\uB97C \uB2E4\uC2DC \uAC10\uC9C0\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4\u2026");
  refreshing = true;
  try {
    applyResult(await request("rescan"));
    message(currentItems.length ? "\uD604\uC7AC \uD398\uC774\uC9C0\uC758 \uBBF8\uB514\uC5B4\uB97C \uB2E4\uC2DC \uAC10\uC9C0\uD588\uC2B5\uB2C8\uB2E4." : "\uAC10\uC9C0\uB41C \uBBF8\uB514\uC5B4\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4. \uC601\uC0C1\uC744 \uC7AC\uC0DD\uD55C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694.");
  } finally {
    refreshing = false;
  }
});
var dialog = node("info-dialog");
function showInfo(report) {
  node("info-title").textContent = report ? "\uBBF8\uB514\uC5B4 \uAC10\uC9C0 \uC2E0\uACE0" : "\uBBF8\uB514\uC5B4 \uAC10\uC9C0 \uB3C4\uC6C0\uB9D0";
  node("info-description").textContent = report ? "\uAC10\uC9C0\uB418\uC9C0 \uC54A\uB294 \uD398\uC774\uC9C0 \uC8FC\uC18C\uC640 \uC7AC\uD604 \uBC29\uBC95\uC744 \uBA54\uBAA8\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4. \uBA54\uBAA8\uB294 \uC774 \uD31D\uC5C5\uC5D0\uC11C\uB9CC \uC720\uC9C0\uB418\uBA70 \uC790\uB3D9\uC73C\uB85C \uC804\uC1A1\uD558\uAC70\uB098 \uC800\uC7A5\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." : "\uC601\uC0C1\uC774 \uC788\uB294 \uD398\uC774\uC9C0\uC5D0\uC11C \uC601\uC0C1\uC744 \uC7AC\uC0DD\uD55C \uB4A4 \uAC15\uC81C \uAC10\uC9C0\uB97C \uB20C\uB7EC \uC8FC\uC138\uC694.\nHTTP \uBBF8\uB514\uC5B4\uC640 \uC554\uD638\uD654\uB418\uC9C0 \uC54A\uC740 HLS\xB7DASH VOD\uB97C \uC9C0\uC6D0\uD569\uB2C8\uB2E4. DRM\uACFC \uB77C\uC774\uBE0C \uB179\uD654\uB294 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.\n\uC124\uC815\uC5D0\uC11C \uD654\uC9C8\xB7\uC800\uC7A5 \uD615\uC2DD\uC744 \uC120\uD0DD\uD558\uACE0, \uAE30\uB85D\uC5D0\uC11C \uC9C4\uD589 \uC0C1\uD669\uACFC \uAC80\uD1A0\uAC00 \uD544\uC694\uD55C \uD30C\uC77C\uC744 \uD655\uC778\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.";
  node("report-label").hidden = !report;
  node("report-notes").hidden = !report;
  dialog.showModal();
}
node("help").addEventListener("click", () => showInfo(false));
node("report").addEventListener("click", () => showInfo(true));
node("dismiss-hint").addEventListener("click", () => {
  node("discovery-card").hidden = true;
});
void refresh();
var poll = setInterval(() => {
  if (!document.hidden) void refresh();
}, 1500);
window.addEventListener("pagehide", () => {
  clearInterval(poll);
}, { once: true });
