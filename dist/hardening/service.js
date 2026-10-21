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

// src/security/validation.ts
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// src/local/model.ts
var HISTORY_KEY = "my_video_app_history_v1";
var MAX_HISTORY = 200;
var MAX_STREAM_BYTES = 128 * 1024 * 1024;
var ACTIVE_HISTORY_STATES = ["preparing", "downloading", "scanning", "review"];
function retainHistory(rows) {
  const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt);
  const active = (row) => ACTIVE_HISTORY_STATES.includes(row.state);
  return [...sorted.filter(active), ...sorted.filter((row) => !active(row))].slice(0, MAX_HISTORY);
}
function isHistory(value) {
  return record(value) && typeof value.id === "string" && /^[a-f0-9-]{36}$/.test(value.id) && typeof value.url === "string" && typeof value.filename === "string" && ["file", "hls", "dash"].includes(String(value.kind)) && ["preparing", "downloading", "scanning", "review", "discarded", "complete", "cancelled", "error"].includes(String(value.state)) && typeof value.createdAt === "number" && Number.isFinite(value.createdAt) && typeof value.incognito === "boolean";
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
      const history = importRows2(HISTORY_KEY, validHistory);
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
              replace(tx.objectStore("history"), history);
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
export {
  authorizeDownloadOffers,
  offerUpscale,
  revokeDownloadOffers
};
