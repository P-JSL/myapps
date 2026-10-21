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
function createAppStorage(options2 = {}) {
  const name = options2.name ?? DATABASE_NAME;
  const isPrivate = options2.privateContext ?? (() => globalThis.chrome?.extension?.inIncognitoContext === true);
  const now = options2.now ?? Date.now;
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
    return options2.legacy ?? {
      get: (keys) => chrome.storage.local.get(keys),
      remove: (keys) => chrome.storage.local.remove(keys)
    };
  }
  function abort(tx, error2) {
    if (!transactionErrors.has(tx)) transactionErrors.set(tx, error2);
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
      } catch (error2) {
        reject(error2);
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
    } catch (error2) {
      abort(tx, error2);
    }
  }
  function open() {
    assertNormal();
    return new Promise((resolve, reject) => {
      let request2;
      let settled = false;
      let timeout;
      const fail = (error2) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error2);
      };
      try {
        const factory = options2.factory ?? globalThis.indexedDB;
        if (!factory) throw new Error("\uC774 \uBE0C\uB77C\uC6B0\uC800\uC5D0\uC11C \uB0B4\uC7A5 DB\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
        request2 = factory.open(name, DATABASE_VERSION);
      } catch (error2) {
        fail(error2);
        return;
      }
      request2.onblocked = () => {
        timeout ??= setTimeout(
          () => fail(new Error("\uB2E4\uB978 \uCC3D\uC774 \uB85C\uCEEC DB \uAC31\uC2E0\uC744 \uB9C9\uACE0 \uC788\uC2B5\uB2C8\uB2E4. \uD574\uB2F9 \uCC3D\uC744 \uB2EB\uACE0 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694.")),
          options2.blockedTimeoutMs ?? 5e3
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
        } catch (error2) {
          db.close();
          if (connection === db) connection = void 0;
          throw error2;
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

// src/local/labels.ts
var HISTORY_STATE_LABELS = Object.freeze({
  preparing: "\uD30C\uC77C \uC900\uBE44 \uC911",
  downloading: "\uB2E4\uC6B4\uB85C\uB4DC \uC911",
  scanning: "\uB85C\uCEEC \uBC31\uC2E0 \uAC80\uC0AC \uC911",
  review: "\uBCF4\uC548 \uAC80\uC0AC \uD655\uC778 \uD544\uC694",
  discarded: "\uD30C\uC77C \uC0AD\uC81C\uB428",
  complete: "\uC644\uB8CC",
  cancelled: "\uCDE8\uC18C\uB428",
  error: "\uC2E4\uD328"
});
var SECURITY_STATUS_LABELS = Object.freeze({
  scanning: "\uB85C\uCEEC \uBC31\uC2E0: \uAC80\uC0AC \uC911",
  clean: "\uB85C\uCEEC \uBC31\uC2E0: \uC704\uD611 \uBBF8\uD0D0\uC9C0",
  infected: "\uB85C\uCEEC \uBC31\uC2E0: \uC704\uD611 \uD0D0\uC9C0",
  unavailable: "\uB85C\uCEEC \uBC31\uC2E0: \uC5F0\uACB0\uB418\uC9C0 \uC54A\uC74C",
  error: "\uB85C\uCEEC \uBC31\uC2E0: \uAC80\uC0AC \uC2E4\uD328",
  "chrome-warning": "Chrome \uB2E4\uC6B4\uB85C\uB4DC \uACBD\uACE0"
});
var PREPARATION_STAGE_LABELS = Object.freeze({
  queued: "\uC900\uBE44 \uB300\uAE30 \uC911",
  fetching: "\uD30C\uC77C \uBC1B\uB294 \uC911",
  processing: "\uBBF8\uB514\uC5B4 \uD569\uCE58\uB294 \uC911",
  saving: "\uC800\uC7A5 \uC900\uBE44 \uC911"
});

// src/local/ui.ts
function node(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing ${id}`);
  return element;
}
var status = node("status");
var refreshing = false;
var hasError = false;
var preferencesTouched = false;
var deferredReviews = /* @__PURE__ */ new Set();
var securityDialog = node("security-dialog");
var activeReview;
var reviewBusy = false;
async function request(type, data = {}) {
  const result = await chrome.runtime.sendMessage({ scope: SCOPE, type, ...data });
  if (!record(result) || result.ok !== true) throw new Error(record(result) && typeof result.error === "string" ? result.error : "\uD655\uC7A5 \uD504\uB85C\uADF8\uB7A8\uC744 \uB2E4\uC2DC \uB85C\uB4DC\uD558\uACE0 \uD398\uC774\uC9C0\uB97C \uC0C8\uB85C\uACE0\uCE68\uD558\uC138\uC694.");
  return result;
}
function error(value) {
  hasError = true;
  status.textContent = value instanceof Error ? value.message : "\uC694\uCCAD \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4.";
}
async function refreshDatabaseStatus() {
  const hint = node("database-status");
  if (chrome.extension.inIncognitoContext) {
    hint.textContent = "\uC2DC\uD06C\uB9BF \uCC3D\uC758 \uAE30\uB85D\uC740 \uBA54\uBAA8\uB9AC\uC5D0\uC11C\uB9CC \uAD00\uB9AC\uD558\uBA70 \uC77C\uBC18 \uCC3D\uC758 \uB0B4\uC7A5 DB\uC640 \uC800\uC7A5 \uC124\uC815\uC744 \uC77D\uAC70\uB098 \uBCC0\uACBD\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.";
    return;
  }
  try {
    const database = await appStorage.status();
    const parts = [`\uB0B4\uC7A5 DB v${database.version} \uC900\uBE44\uB428`, `\uB2E4\uC6B4\uB85C\uB4DC \uAE30\uB85D ${database.historyCount}\uAC1C`, `\uC784\uC2DC \uBCF5\uC0AC\uBCF8 \uAE30\uB85D ${database.jobCount}\uAC1C`];
    if (database.lastMaintenanceAt !== null) parts.push(`\uCD5C\uADFC \uC790\uB3D9 \uC815\uB9AC ${new Date(database.lastMaintenanceAt).toLocaleString("ko-KR")}`);
    if (database.legacyCleanupPending) parts.push("\uC774\uC804 \uB370\uC774\uD130\uC758 \uC6D0\uBCF8 \uC815\uB9AC\uB97C \uB2E4\uC74C \uC2E4\uD589\uC5D0\uC11C \uB2E4\uC2DC \uC2DC\uB3C4\uD569\uB2C8\uB2E4.");
    if (database.recoveryCount > 0) parts.push(`\uD655\uC778\uC774 \uD544\uC694\uD55C \uC774\uC804 \uB370\uC774\uD130 ${database.recoveryCount}\uAC1C\uB97C \uBCF4\uC874\uD558\uACE0 \uC788\uC5B4 \uD30C\uC77C \uC790\uB3D9 \uC815\uB9AC\uC640 \uC644\uB8CC \uD6C4 \uC790\uB3D9 \uD655\uB300 \uC81C\uC548\uC744 \uBCF4\uB958\uD569\uB2C8\uB2E4.`);
    hint.textContent = parts.join(" \xB7 ");
  } catch (value) {
    hint.textContent = `\uB0B4\uC7A5 DB\uB97C \uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. \uC790\uB3D9 \uD30C\uC77C \uC815\uB9AC\uB97C \uC911\uB2E8\uD558\uACE0 \uAE30\uC874 \uB370\uC774\uD130\uB97C \uBCF4\uC874\uD569\uB2C8\uB2E4.${value instanceof Error ? ` ${value.message}` : ""}`;
  }
}
function options() {
  return downloadOptions({ quality: node("quality").value, output: node("download-output").value });
}
var preferencesReady = (async () => {
  const hint = node("download-preferences-status");
  if (chrome.extension.inIncognitoContext) {
    hint.textContent = "\uC2DC\uD06C\uB9BF \uCC3D\uC758 \uD654\uC9C8\xB7\uC800\uC7A5 \uD615\uC2DD\uC740 \uC774 \uD654\uBA74\uC5D0\uC11C\uB9CC \uC0AC\uC6A9\uD558\uBA70 \uC124\uC815\uC744 \uC800\uC7A5\uD558\uAC70\uB098 \uBD88\uB7EC\uC624\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.";
    return;
  }
  try {
    const saved = (await appStorage.get(DOWNLOAD_OPTIONS_KEY))[DOWNLOAD_OPTIONS_KEY];
    const restored = downloadOptions(saved);
    if (preferencesTouched) return;
    node("quality").value = restored.quality;
    node("download-output").value = restored.output;
  } catch {
    hint.textContent = "\uC800\uC7A5\uB41C \uC124\uC815\uC744 \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. \uD604\uC7AC \uD654\uC9C8\xB7\uC800\uC7A5 \uD615\uC2DD\uC73C\uB85C \uB2E4\uC6B4\uB85C\uB4DC\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.";
  }
})();
for (const id of ["quality", "download-output"]) node(id).addEventListener("change", () => {
  preferencesTouched = true;
  if (chrome.extension.inIncognitoContext) return;
  const selected = options();
  void preferencesReady.then(() => appStorage.set({ [DOWNLOAD_OPTIONS_KEY]: selected })).then(() => {
    node("download-preferences-status").textContent = "\uD654\uC9C8\xB7\uC800\uC7A5 \uD615\uC2DD \uC120\uD0DD\uC744 \uC774 \uBE0C\uB77C\uC6B0\uC800\uC5D0 \uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4.";
  }).catch(() => {
    node("download-preferences-status").textContent = "\uC124\uC815\uC744 \uC800\uC7A5\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. \uD604\uC7AC \uC120\uD0DD\uC73C\uB85C \uB2E4\uC6B4\uB85C\uB4DC\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.";
  });
});
function button(text, action, secondary = false, actionKey = text) {
  const element = document.createElement("button");
  element.textContent = text;
  if (secondary) element.className = "secondary";
  element.dataset.action = actionKey;
  element.addEventListener("click", () => {
    hasError = false;
    element.disabled = true;
    void action().then(() => refresh()).catch(error).finally(() => {
      element.disabled = false;
    });
  });
  return element;
}
var rowCaches = /* @__PURE__ */ new Map();
function replaceRows(id, items, render) {
  const list = node(id);
  const focused = document.activeElement;
  const focusedButton = focused instanceof HTMLButtonElement && list.contains(focused) ? focused : void 0;
  const rowId = focusedButton?.closest("li[data-row-id]")?.dataset.rowId;
  const action = focusedButton?.dataset.action;
  const previous = new Set(items.map((item) => item.id)).size === items.length ? rowCaches.get(id) : void 0;
  const current = /* @__PURE__ */ new Map();
  const rows = items.map((item) => {
    const signature = JSON.stringify(item);
    const cached = previous?.get(item.id);
    const entry = cached?.signature === signature ? cached : { signature, row: render(item) };
    current.set(item.id, entry);
    return entry.row;
  });
  rowCaches.set(id, current);
  const retained = new Set(rows);
  for (let child = list.firstElementChild; child; ) {
    const next = child.nextElementSibling;
    if (!retained.has(child)) child.remove();
    child = next;
  }
  let cursor = list.firstElementChild;
  for (const row of rows) {
    if (row === cursor) cursor = cursor.nextElementSibling;
    else list.insertBefore(row, cursor);
  }
  while (cursor) {
    const next = cursor.nextElementSibling;
    cursor.remove();
    cursor = next;
  }
  if (focusedButton && document.activeElement !== focusedButton && rowId && action) {
    const row = rows.find((item) => item.dataset.rowId === rowId);
    const replacement = Array.from(row?.querySelectorAll("button") ?? []).find((item) => item.dataset.action === action && !item.disabled);
    replacement?.focus({ preventScroll: true });
  }
}
function mediaRow(item) {
  const row = document.createElement("li");
  row.dataset.rowId = item.id;
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
    await preferencesReady;
    await request("download", { id: item.id, options: options() });
    status.textContent = "\uD30C\uC77C\uC744 \uC900\uBE44\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4. \uAE30\uB85D \uD0ED\uC5D0\uC11C \uC9C4\uD589 \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uC138\uC694.";
  }, false, "download"));
  row.append(kind, title, source, controls);
  return row;
}
function closeReview(defer = false) {
  if (defer && activeReview?.security?.token) deferredReviews.add(activeReview.security.token);
  if (securityDialog.open) securityDialog.close();
  activeReview = void 0;
  node("security-acknowledge").checked = false;
}
function reviewControls() {
  const chromeWarning = activeReview?.security?.status === "chrome-warning";
  node("security-delete").disabled = reviewBusy;
  node("security-rescan").disabled = reviewBusy;
  node("security-chrome").disabled = reviewBusy;
  node("security-acknowledge").disabled = reviewBusy;
  node("security-keep").disabled = reviewBusy || chromeWarning || !node("security-acknowledge").checked;
  node("security-later").disabled = reviewBusy;
}
function openReview(item) {
  if (!item.security || reviewBusy) return;
  closeReview();
  activeReview = item;
  const security = item.security;
  const chromeWarning = security.status === "chrome-warning";
  node("security-filename").textContent = item.filename;
  node("security-result").textContent = SECURITY_STATUS_LABELS[security.status];
  node("security-explanation").textContent = chromeWarning ? "Chrome\uC774 \uB2E4\uC6B4\uB85C\uB4DC\uC5D0 \uC704\uD5D8\uC744 \uD45C\uC2DC\uD588\uC2B5\uB2C8\uB2E4. Chrome \uB2E4\uC6B4\uB85C\uB4DC \uD654\uBA74\uC5D0\uC11C \uACBD\uACE0\uB97C \uD655\uC778\uD558\uC138\uC694. \uC774 \uC571\uC740 Chrome\uC758 \uACBD\uACE0\uB97C \uC790\uB3D9\uC73C\uB85C \uD574\uC81C\uD558\uC9C0 \uC54A\uC73C\uBA70, \uD655\uC778 \uC804\uC5D0\uB294 \uC644\uB8CC \uCC98\uB9AC\uB098 \uC5C5\uC2A4\uCF00\uC77C\uB9C1\uC744 \uC9C4\uD589\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." : "\uD30C\uC77C\uC740 \uC774\uBBF8 \uB514\uC2A4\uD06C\uC5D0 \uC800\uC7A5\uB418\uC5B4 \uC788\uC2B5\uB2C8\uB2E4. \uD655\uC778 \uC804\uC5D0\uB294 \uC571\uC5D0\uC11C \uC644\uB8CC \uCC98\uB9AC\uB098 \uC5C5\uC2A4\uCF00\uC77C\uB9C1\uC744 \uC9C4\uD589\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uC704\uD611\uC744 \uD0D0\uC9C0\uD588\uAC70\uB098 \uAC80\uC0AC\uB97C \uC644\uB8CC\uD558\uC9C0 \uBABB\uD55C \uD30C\uC77C\uC740 \uC0AD\uC81C\uB97C \uAD8C\uC7A5\uD569\uB2C8\uB2E4. \uBBF8\uD0D0\uC9C0 \uACB0\uACFC\uB3C4 \uD30C\uC77C\uC758 \uC548\uC804\uC744 \uBCF4\uC7A5\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.";
  const details = node("security-details");
  details.replaceChildren();
  const detail = (label, value) => {
    if (!value) return;
    const line = document.createElement("p");
    line.textContent = `${label}: ${value}`;
    details.append(line);
  };
  detail("\uAC80\uC0AC \uC5D4\uC9C4", security.engine);
  detail("\uAC80\uC0AC \uC548\uB0B4", security.message);
  detail("Chrome \uACBD\uACE0", security.danger);
  detail("SHA-256", security.sha256);
  if (typeof security.size === "number" && Number.isFinite(security.size) && security.size >= 0) detail("\uAC80\uC0AC \uD30C\uC77C \uD06C\uAE30", `${security.size.toLocaleString("ko-KR")} \uBC14\uC774\uD2B8`);
  if (typeof security.checkedAt === "number" && Number.isFinite(security.checkedAt)) detail("\uAC80\uC0AC \uC2DC\uAC01", new Date(security.checkedAt).toLocaleString("ko-KR"));
  const threats = node("security-threats");
  threats.replaceChildren();
  for (const threat of security.threats?.slice(0, 20) ?? []) {
    const line = document.createElement("li");
    line.textContent = threat;
    threats.append(line);
  }
  threats.hidden = !threats.childElementCount;
  node("security-native-actions").hidden = chromeWarning;
  node("security-acknowledgement").hidden = chromeWarning;
  node("security-chrome").hidden = !chromeWarning;
  node("security-dialog-error").textContent = "";
  reviewControls();
  securityDialog.showModal();
  node(chromeWarning ? "security-chrome" : "security-delete").focus();
}
async function securityAction(type, extra = {}) {
  const item = activeReview;
  if (!item?.security || reviewBusy) return;
  reviewBusy = true;
  reviewControls();
  node("security-dialog-error").textContent = "";
  try {
    await request(type, { id: item.id, token: item.security.token, ...extra });
    closeReview(true);
  } catch (value) {
    node("security-dialog-error").textContent = value instanceof Error ? value.message : "\uBCF4\uC548 \uD655\uC778 \uC694\uCCAD\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.";
  } finally {
    reviewBusy = false;
    reviewControls();
  }
  await refresh().catch(error);
}
function historyRow(item) {
  const row = document.createElement("li");
  row.dataset.rowId = item.id;
  const title = document.createElement("h3");
  title.textContent = item.filename;
  const info = document.createElement("p");
  info.textContent = `${HISTORY_STATE_LABELS[item.state]} \xB7 ${new Date(item.createdAt).toLocaleString("ko-KR")}`;
  if (item.state === "preparing" && item.preparation) {
    const label = PREPARATION_STAGE_LABELS[item.preparation.stage];
    if (label) info.textContent += ` \xB7 ${label}`;
    if (typeof item.preparation.progress === "number" && Number.isFinite(item.preparation.progress)) info.textContent += ` ${Math.round(Math.max(0, Math.min(1, item.preparation.progress)) * 100)}%`;
  }
  if (item.state === "downloading" && typeof item.receivedBytes === "number" && item.receivedBytes >= 0) {
    info.textContent += ` \xB7 ${(item.receivedBytes / 1024 / 1024).toFixed(1)} MiB`;
    if (typeof item.totalBytes === "number" && item.totalBytes > 0) info.textContent += ` / ${(item.totalBytes / 1024 / 1024).toFixed(1)} MiB`;
  }
  row.append(title, info);
  const security = document.createElement("p");
  security.className = "security-summary";
  security.textContent = item.security ? SECURITY_STATUS_LABELS[item.security.status] : "\uAC80\uC0AC \uAE30\uB85D \uC5C6\uC74C";
  if (item.security?.engine) security.textContent += ` \xB7 ${item.security.engine}`;
  if (item.security?.decision === "keep") security.textContent += " \xB7 \uC704\uD5D8 \uC548\uB0B4 \uD655\uC778 \uD6C4 \uC0AC\uC6A9\uC790\uAC00 \uC720\uC9C0\uD568";
  if (item.security?.decision === "delete") security.textContent += " \xB7 \uC0AC\uC6A9\uC790\uAC00 \uD30C\uC77C \uC0AD\uC81C\uB97C \uC120\uD0DD\uD568";
  row.append(security);
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
  if (item.state === "review" && item.security) controls.append(button("\uAC80\uC0AC \uACB0\uACFC \uD655\uC778", async () => {
    openReview(item);
  }, true, "security-review"));
  if (item.state === "complete") controls.append(button("\uC800\uC7A5 \uD3F4\uB354", () => request("show-file", { id: item.id }), true, "show-file"));
  if (item.state === "error" || item.state === "cancelled") controls.append(button("\uB2E4\uC2DC \uC2DC\uB3C4", () => request("retry", { id: item.id }), true, "retry"));
  if (item.state === "downloading" || item.state === "preparing") controls.append(button("\uCDE8\uC18C", () => request("cancel", { id: item.id }), true, "cancel"));
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
    replaceRows("media", media, mediaRow);
    node("empty").hidden = media.length > 0;
    replaceRows("history", history, historyRow);
    node("history-empty").hidden = history.length > 0;
    if (activeReview && !reviewBusy && !history.some((row) => row.id === activeReview?.id && row.state === "review" && row.security?.token === activeReview?.security?.token)) closeReview();
    if (!activeReview && !reviewBusy) {
      const pending2 = history.find((row) => row.state === "review" && row.security && !deferredReviews.has(row.security.token));
      if (pending2) openReview(pending2);
    }
    const active = history.filter((row) => ["preparing", "downloading", "scanning"].includes(row.state)).length;
    const pending = history.filter((row) => row.state === "review").length;
    if (!hasError) status.textContent = pending ? `${pending}\uAC1C \uD30C\uC77C\uC758 \uBCF4\uC548 \uD655\uC778\uC774 \uD544\uC694\uD569\uB2C8\uB2E4. \uAE30\uB85D \uD0ED\uC5D0\uC11C \uD655\uC778\uD558\uC138\uC694.` : active ? `${active}\uAC1C \uD30C\uC77C \uCC98\uB9AC \uC911 \xB7 \uAE30\uB85D \uD0ED\uC5D0\uC11C \uD655\uC778\uD558\uC138\uC694.` : `${media.length}\uAC1C \uBBF8\uB514\uC5B4 \xB7 \uC774 \uBE0C\uB77C\uC6B0\uC800\uC5D0\uB9CC \uAE30\uB85D\uC744 \uC800\uC7A5\uD569\uB2C8\uB2E4.`;
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
  void refreshDatabaseStatus();
});
node("upscale").addEventListener("click", () => {
  void request("upscale").catch(error);
});
node("clear-history").addEventListener("click", () => {
  void request("clear-history").then(refresh).catch(error);
});
node("security-acknowledge").addEventListener("change", reviewControls);
node("security-delete").addEventListener("click", () => {
  void securityAction("security-delete");
});
node("security-rescan").addEventListener("click", () => {
  void securityAction("security-rescan");
});
node("security-chrome").addEventListener("click", () => {
  void securityAction("review-chrome");
});
node("security-keep").addEventListener("click", () => {
  if (!node("security-acknowledge").checked || activeReview?.security?.status === "chrome-warning") return;
  void securityAction("security-keep", { confirmed: true });
});
node("security-later").addEventListener("click", () => {
  if (!reviewBusy) closeReview(true);
});
securityDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  if (!reviewBusy) closeReview(true);
});
node("extension-id").textContent = chrome.runtime.id || "\uC124\uCE58\uD55C \uD655\uC7A5 \uD504\uB85C\uADF8\uB7A8\uC758 ID\uB97C chrome://extensions\uC5D0\uC11C \uD655\uC778\uD558\uC138\uC694.";
function showAntivirusStatus(value) {
  if (!record(value) || !["ready", "unavailable", "error"].includes(String(value.status))) throw new Error("\uBC31\uC2E0 \uB3C4\uC6B0\uBBF8\uC758 \uC900\uBE44 \uC0C1\uD0DC\uB97C \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uCD5C\uC2E0 \uB3C4\uC6B0\uBBF8 \uC124\uCE58 \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uC138\uC694.");
  const parts = [value.status === "ready" ? "\uB3C4\uC6B0\uBBF8 \uC5F0\uACB0\uB428 \xB7 \uAC80\uC0AC\uAE30 \uC120\uD0DD \uD655\uC778" : value.status === "unavailable" ? "\uBC31\uC2E0 \uC5F0\uACB0\uC744 \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4" : "\uBC31\uC2E0 \uC5F0\uACB0 \uD655\uC778\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4"];
  if (typeof value.engine === "string" && value.engine) parts.push(`\uAC80\uC0AC \uC5D4\uC9C4: ${value.engine.slice(0, 120)}`);
  if (Array.isArray(value.products)) {
    const products = value.products.filter((item) => typeof item === "string").slice(0, 16).map((item) => item.slice(0, 160));
    if (products.length) parts.push(`\uD65C\uC131 \uBCF4\uD638 \uC81C\uD488: ${products.join(", ")}`);
  }
  if (typeof value.message === "string" && value.message) parts.push(value.message.slice(0, 1e3));
  parts.push(value.status === "ready" ? "\uD30C\uC77C \uAC80\uC0AC\uB294 \uB2E4\uC6B4\uB85C\uB4DC\uAC00 \uB05D\uB09C \uB4A4 \uBCC4\uB3C4\uB85C \uC218\uD589\uD558\uBA70 \uACB0\uACFC\uB294 \uAE30\uB85D \uD0ED\uC5D0\uC11C \uD655\uC778\uD558\uC138\uC694." : "\uB3C4\uC6B0\uBBF8\xB7\uBC31\uC2E0 \uC124\uCE58\uC640 \uD65C\uC131 \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uC138\uC694. \uBBF8\uAC80\uC0AC \uD30C\uC77C\uC740 \uAE30\uB85D\uC5D0\uC11C \uD655\uC778 \uB300\uAE30 \uC0C1\uD0DC\uB85C \uC720\uC9C0\uD569\uB2C8\uB2E4.");
  node("security-connection-status").textContent = parts.join(" \xB7 ");
}
node("security-connect").addEventListener("click", () => {
  const connect = node("security-connect");
  const connection = node("security-connection-status");
  connect.disabled = true;
  connection.textContent = "\uB85C\uCEEC \uBC31\uC2E0 \uC5F0\uACB0 \uAD8C\uD55C\uC744 \uD655\uC778\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4\u2026";
  let permission;
  try {
    permission = chrome.permissions.request({ permissions: ["nativeMessaging"] });
  } catch {
    permission = Promise.reject(new Error("\uC774 \uBE0C\uB77C\uC6B0\uC800\uC5D0\uC11C\uB294 \uB85C\uCEEC \uBC31\uC2E0 \uC5F0\uACB0 \uAD8C\uD55C\uC744 \uC694\uCCAD\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4."));
  }
  void permission.then(async (granted) => {
    if (!granted) {
      connection.textContent = "\uC5F0\uACB0 \uAD8C\uD55C\uC744 \uD5C8\uC6A9\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uAC80\uC0AC\uB418\uC9C0 \uC54A\uC740 \uD30C\uC77C\uC740 \uAE30\uB85D\uC5D0\uC11C \uD655\uC778\uD558\uC138\uC694.";
      return;
    }
    connection.textContent = "\uC124\uCE58\uB41C \uBC31\uC2E0 \uB3C4\uC6B0\uBBF8\uC640 \uAC80\uC0AC\uAE30\uC758 \uC900\uBE44 \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4\u2026";
    const result = await request("security-connect");
    showAntivirusStatus(result.antivirus);
    await refresh();
  }).catch((value) => {
    connection.textContent = value instanceof Error ? value.message : "\uB85C\uCEEC \uBC31\uC2E0 \uC5F0\uACB0\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.";
  }).finally(() => {
    connect.disabled = false;
  });
});
node("url-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const url = node("url").value;
  void preferencesReady.then(() => request("download-url", { url, options: options() })).then(() => {
    hasError = false;
    status.textContent = "\uD30C\uC77C\uC744 \uC900\uBE44\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4.";
    show(true);
  }).catch(error);
});
var timer = setInterval(() => {
  if (!document.hidden) void refresh().catch(error);
}, 2e3);
addEventListener("pagehide", () => clearInterval(timer), { once: true });
void refreshDatabaseStatus();
if (new URL(location.href).searchParams.get("view") === "history") show(true);
else void refresh().catch(error);
