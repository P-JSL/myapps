import { HISTORY_KEY, isHistory, retainHistory, type HistoryItem } from '../local/model.ts';
import { downloadOptions } from '../local/preferences.ts';
import { ANTIVIRUS_ENABLED_KEY } from '../local/security-preferences.ts';
import { DOWNLOAD_FOLDER_CONFIRMED_KEY } from '../local/download-folder.ts';
import { JOBS_KEY, OFFER_KEY, MAX_JOBS, MAX_QUEUE_BYTES, RETENTION_MS, isJob, type Job } from '../upscale/policy.ts';

export const DATABASE_NAME = 'my-video-app';
export const DATABASE_VERSION = 1;
export const DOWNLOAD_OPTIONS_KEY = 'my_video_app_download_options_v1';
export const STORAGE_KEYS = [HISTORY_KEY, JOBS_KEY, OFFER_KEY, DOWNLOAD_OPTIONS_KEY, ANTIVIRUS_ENABLED_KEY, DOWNLOAD_FOLDER_CONFIRMED_KEY] as const;
const STORES = ['history', 'jobs', 'settings', 'meta', 'recovery'];
const MIGRATION = 'migration-v1';
const MAINTENANCE = 'last-maintenance';
const CLEANUP_PENDING = 'legacy-cleanup-pending';
const MAINTENANCE_INTERVAL = 60_000;

export interface DatabaseStatus {
  name: string;
  version: number;
  privateContext: boolean;
  historyCount: number;
  jobCount: number;
  recoveryCount: number;
  lastMaintenanceAt: number | null;
  migratedAt: number | null;
  legacyCleanupPending: boolean;
}
export interface LegacyStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  remove(keys: string[]): Promise<void>;
}
export interface DatabaseOptions {
  name?: string;
  factory?: IDBFactory;
  legacy?: LegacyStorage;
  privateContext?: () => boolean;
  now?: () => number;
  blockedTimeoutMs?: number;
}
export interface AppStorage {
  ready(): Promise<void>;
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  status(): Promise<DatabaseStatus>;
  close(): void;
}
interface Row<T> {
  id: string;
  order: number;
  value: T;
}
interface Recovery {
  key: string;
  reason: string;
  value: unknown;
  createdAt: number;
}
interface Meta {
  key: string;
  value: unknown;
}

function privateRow(value: unknown): boolean {
  return value !== null && typeof value === 'object'
    && (value as { incognito?: unknown }).incognito === true;
}

/** Damaged containers must never copy private rows into recovery. */
function containsPrivate(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  if (privateRow(value)) return true;
  seen.add(value);
  return Object.values(value).some(item => containsPrivate(item, seen));
}

function validHistory(value: unknown): value is HistoryItem {
  return isHistory(value) && value.incognito === false
    && (value.downloadId === undefined
      || (Number.isSafeInteger(value.downloadId) && value.downloadId >= 0));
}

function validSetting(key: string, value: unknown): boolean {
  if (key === OFFER_KEY || key === ANTIVIRUS_ENABLED_KEY || key === DOWNLOAD_FOLDER_CONFIRMED_KEY) return typeof value === 'boolean';
  if (key !== DOWNLOAD_OPTIONS_KEY || value === undefined) return false;
  try {
    downloadOptions(value);
    return true;
  } catch {
    return false;
  }
}

function keyList(keys: string | string[]): string[] {
  const result = typeof keys === 'string' ? [keys] : keys;
  if (!Array.isArray(result)
    || result.some(key => !(STORAGE_KEYS as readonly string[]).includes(key))) {
    throw new Error('지원하지 않는 로컬 DB 항목입니다.');
  }
  return [...new Set(result)];
}

function wrap<T extends { id: string }>(values: T[]): Row<T>[] {
  return values.map((value, order) => ({ id: value.id, order, value }));
}

function unwrap<T extends { id: string }>(
  rows: unknown[],
  valid: (value: unknown) => value is T,
): T[] {
  const orders = new Set<number>();
  const result: Row<T>[] = [];
  for (const candidate of rows) {
    const row = candidate as Partial<Row<T>> | null;
    if (!row || !Number.isSafeInteger(row.order) || row.order! < 0
      || orders.has(row.order!) || !valid(row.value)
      || containsPrivate(row.value) || row.id !== row.value.id) {
      throw new Error('로컬 DB 기록이 손상되었습니다. 자동 파일 정리를 중단했습니다.');
    }
    orders.add(row.order!);
    result.push(row as Row<T>);
  }
  return result.sort((a, b) => a.order - b.order).map(row => row.value);
}

function retainJobs(values: Job[], now: number): Job[] {
  let size = 0;
  const retained: Job[] = [];
  for (const job of [...values].sort((a, b) => b.createdAt - a.createdAt)) {
    if (now - job.createdAt >= RETENTION_MS || job.createdAt > now
      || size + job.size > MAX_QUEUE_BYTES || retained.length >= MAX_JOBS) continue;
    retained.push(job);
    size += job.size;
  }
  return retained;
}

function replace<T extends { id: string }>(store: IDBObjectStore, values: T[]): void {
  store.clear();
  for (const row of wrap(values)) store.put(row);
}

function metaNumber(value: unknown): number | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('로컬 DB 관리 정보가 손상되었습니다.');
  }
  return value;
}

function migrationTime(marker: Meta | undefined): number | null {
  if (marker === undefined) return null;
  const value = metaNumber(marker.value);
  if (value === null) throw new Error('로컬 DB 이전 정보가 손상되었습니다.');
  return value;
}

function requireMigration(marker: Meta | undefined): number {
  const value = migrationTime(marker);
  if (value === null) {
    throw new Error('로컬 DB 이전 정보가 없습니다. 기존 기록을 보호하기 위해 자동 이전과 파일 정리를 중단했습니다.');
  }
  return value;
}

/** Browser-owned metadata database. Media bytes remain in OPFS / Chrome downloads. */
export function createAppStorage(options: DatabaseOptions = {}): AppStorage {
  const name = options.name ?? DATABASE_NAME;
  const isPrivate = options.privateContext
    ?? (() => globalThis.chrome?.extension?.inIncognitoContext === true);
  const now = options.now ?? Date.now;
  const transactionErrors = new WeakMap<IDBTransaction, unknown>();
  let connection: IDBDatabase | undefined;
  let barrier: Promise<void> | undefined;
  let lastMaintenance = -Infinity;

  function assertNormal(): void {
    if (isPrivate()) throw new Error('시크릿 모드에서는 로컬 DB를 사용하지 않습니다.');
  }

  function timestamp(): number {
    const value = now();
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('로컬 DB 관리 시간이 올바르지 않습니다.');
    }
    return value;
  }

  function legacy(): LegacyStorage {
    return options.legacy ?? {
      get: keys => chrome.storage.local.get(keys),
      remove: keys => chrome.storage.local.remove(keys),
    };
  }

  function abort(tx: IDBTransaction, error: unknown): void {
    if (!transactionErrors.has(tx)) transactionErrors.set(tx, error);
    try { tx.abort(); }
    catch (abortError) {
      // An external abort may already have ended the transaction.
      if (!(abortError instanceof DOMException && abortError.name === 'InvalidStateError')) throw abortError;
    }
  }

  function transaction<T>(
    db: IDBDatabase,
    names: string[],
    mode: IDBTransactionMode,
    start: (tx: IDBTransaction, result: (value: T) => void) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let result!: T;
      let tx: IDBTransaction;
      try {
        tx = db.transaction(names, mode);
      } catch (error) {
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(transactionErrors.get(tx) ?? tx.error
        ?? new Error('로컬 DB 트랜잭션을 완료하지 못했습니다.'));
      tx.onerror = () => {
        // The abort event retains the original IndexedDB request error.
      };
      guarded(tx, () => start(tx, value => { result = value; }));
    });
  }

  function guarded(tx: IDBTransaction, run: () => void): void {
    try {
      run();
    } catch (error) {
      abort(tx, error);
    }
  }

  function open(): Promise<IDBDatabase> {
    assertNormal();
    return new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      try {
        const factory = options.factory ?? globalThis.indexedDB;
        if (!factory) throw new Error('이 브라우저에서 내장 DB를 사용할 수 없습니다.');
        request = factory.open(name, DATABASE_VERSION);
      } catch (error) {
        fail(error);
        return;
      }
      request.onblocked = () => {
        timeout ??= setTimeout(
          () => fail(new Error('다른 창이 로컬 DB 갱신을 막고 있습니다. 해당 창을 닫고 다시 시도하세요.')),
          options.blockedTimeoutMs ?? 5_000,
        );
      };
      request.onerror = () => fail(request.error ?? new Error('로컬 DB를 열지 못했습니다.'));
      request.onupgradeneeded = () => {
        if (settled) { request.transaction?.abort(); return; }
        const db = request.result;
        for (const storeName of ['history', 'jobs']) {
          const store = db.objectStoreNames.contains(storeName)
            ? request.transaction!.objectStore(storeName)
            : db.createObjectStore(storeName, { keyPath: 'id' });
          const indexes: [string, string][] = [
            ['order', 'order'],
            ['createdAt', 'value.createdAt'],
            ['downloadId', 'value.downloadId'],
          ];
          if (storeName === 'history') indexes.push(['state', 'value.state']);
          for (const [index, path] of indexes) {
            if (!store.indexNames.contains(index)) store.createIndex(index, path);
          }
        }
        for (const storeName of ['settings', 'meta']) {
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName, { keyPath: 'key' });
          }
        }
        if (!db.objectStoreNames.contains('recovery')) {
          db.createObjectStore('recovery', { keyPath: 'id', autoIncrement: true });
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
            connection = undefined;
            barrier = undefined;
            lastMaintenance = -Infinity;
          }
        };
        db.onversionchange = invalidate;
        db.onclose = invalidate;
        resolve(db);
      };
    });
  }

  async function migration(db: IDBDatabase): Promise<void> {
    const marker = await transaction<Meta | undefined>(
      db, ['meta'], 'readonly', (tx, result) => {
        const request = tx.objectStore('meta').get(MIGRATION);
        request.onsuccess = () => result(request.result);
      },
    );
    migrationTime(marker);
    if (marker === undefined) {
      // Finish external reads before opening the atomic migration transaction.
      const source = structuredClone(await legacy().get([...STORAGE_KEYS]));
      const at = timestamp();
      const recovery: Recovery[] = [];

      function quarantine(key: string, value: unknown, reason: string): void {
        if (!containsPrivate(value)) recovery.push({ key, reason, value, createdAt: at });
      }

      function importRows<T extends { id: string }>(
        key: string,
        valid: (value: unknown) => value is T,
      ): T[] {
        const value = source[key];
        if (value === undefined) return [];
        if (!Array.isArray(value)) {
          quarantine(key, value, 'invalid-container');
          return [];
        }
        const seen = new Set<string>();
        const rows: T[] = [];
        for (const row of value) {
          if (containsPrivate(row)) continue;
          if (!valid(row) || seen.has(row.id)) {
            quarantine(key, row, 'invalid-or-duplicate-row');
            continue;
          }
          seen.add(row.id);
          rows.push(row);
        }
        return rows;
      }

      const history = importRows(HISTORY_KEY, validHistory);
      const jobs = importRows(JOBS_KEY, isJob);
      const settings: { key: string; value: unknown }[] = [];
      for (const key of [OFFER_KEY, DOWNLOAD_OPTIONS_KEY, ANTIVIRUS_ENABLED_KEY, DOWNLOAD_FOLDER_CONFIRMED_KEY]) {
        if (source[key] === undefined) continue;
        if (validSetting(key, source[key]) && !containsPrivate(source[key])) {
          settings.push({ key, value: source[key] });
        } else {
          quarantine(key, source[key], 'invalid-setting');
        }
      }
      await transaction<void>(db, STORES, 'readwrite', tx => {
        const check = tx.objectStore('meta').get(MIGRATION);
        check.onsuccess = () => guarded(tx, () => {
          // Recheck within the serialized write transaction before importing.
          if (check.result !== undefined) {
            migrationTime(check.result);
            return;
          }
          // Missing migration metadata in a populated DB is corruption, never
          // permission to replace committed records with a legacy snapshot.
          let remaining = STORES.length;
          let populated = false;
          for (const storeName of STORES) {
            const count = tx.objectStore(storeName).count();
            count.onsuccess = () => guarded(tx, () => {
              populated ||= count.result !== 0;
              if (--remaining) return;
              if (populated) {
                throw new Error('로컬 DB 이전 정보가 없습니다. 기존 기록을 보호하기 위해 자동 이전과 파일 정리를 중단했습니다.');
              }
              replace(tx.objectStore('history'), history);
              replace(tx.objectStore('jobs'), jobs);
              for (const setting of settings) tx.objectStore('settings').put(setting);
              for (const row of recovery) tx.objectStore('recovery').add(row);
              tx.objectStore('meta').put({ key: MIGRATION, value: at });
              tx.objectStore('meta').put({ key: CLEANUP_PENDING, value: true });
            });
          }
        });
      });
    }

    const pending = await transaction<unknown>(
      db, ['meta'], 'readonly', (tx, result) => {
        const request = tx.objectStore('meta').get(CLEANUP_PENDING);
        request.onsuccess = () => result(request.result?.value);
      },
    );
    if (pending === true) {
      try {
        // Removal happens only after the migration transaction commits.
        await legacy().remove([...STORAGE_KEYS]);
      } catch {
        // DB data remains usable; status reports pending source cleanup.
        return;
      }
      await transaction<void>(db, ['meta'], 'readwrite', tx => {
        tx.objectStore('meta').put({ key: CLEANUP_PENDING, value: false });
      });
    }
  }

  async function maintain(db: IDBDatabase): Promise<void> {
    const at = timestamp();
    await transaction<void>(db, STORES, 'readwrite', tx => {
      const history = tx.objectStore('history').getAll();
      const jobs = tx.objectStore('jobs').getAll();
      const recovery = tx.objectStore('recovery').count();
      const marker = tx.objectStore('meta').get(MIGRATION);
      let remaining = 4;
      const finish = () => {
        if (--remaining) return;
        guarded(tx, () => {
          requireMigration(marker.result);
          const histories = unwrap(history.result, validHistory);
          const queued = unwrap(jobs.result, isJob);
          // Unknown file bindings in recovery suspend automatic pruning.
          if (recovery.result === 0) {
            replace(tx.objectStore('history'), retainHistory(histories));
            replace(tx.objectStore('jobs'), retainJobs(queued, at));
          }
          tx.objectStore('meta').put({ key: MAINTENANCE, value: at });
        });
      };
      history.onsuccess = finish;
      jobs.onsuccess = finish;
      recovery.onsuccess = finish;
      marker.onsuccess = finish;
    });
    lastMaintenance = at;
  }

  async function ensure(): Promise<IDBDatabase> {
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
          if (connection === db) connection = undefined;
          throw error;
        }
      })();
      barrier = pending;
      void pending.catch(() => {
        if (barrier === pending) barrier = undefined;
      });
    }
    await barrier;
    if (!connection) return ensure();
    return connection;
  }

  async function current(): Promise<IDBDatabase> {
    const db = await ensure();
    if (timestamp() - lastMaintenance >= MAINTENANCE_INTERVAL) await maintain(db);
    return db;
  }

  const storage: AppStorage = {
    async ready() {
      if (!isPrivate()) await ensure();
    },

    async get(keys) {
      assertNormal();
      const requested = keyList(keys);
      const db = await current();
      return transaction<Record<string, unknown>>(
        db, ['history', 'jobs', 'settings', 'meta'], 'readonly', (tx, result) => {
          const values: Record<string, unknown> = {};
          result(values);
          const marker = tx.objectStore('meta').get(MIGRATION);
          marker.onsuccess = () => guarded(tx, () => { requireMigration(marker.result); });
          for (const key of requested) {
            if (key === HISTORY_KEY || key === JOBS_KEY) {
              const request = tx.objectStore(
                key === HISTORY_KEY ? 'history' : 'jobs',
              ).getAll();
              request.onsuccess = () => guarded(tx, () => {
                values[key] = key === HISTORY_KEY
                  ? unwrap(request.result, validHistory)
                  : unwrap(request.result, isJob);
              });
            } else {
              const request = tx.objectStore('settings').get(key);
              request.onsuccess = () => guarded(tx, () => {
                if (request.result === undefined) {
                  values[key] = undefined;
                  return;
                }
                if (request.result.key !== key
                  || !validSetting(key, request.result.value)
                  || containsPrivate(request.result.value)) {
                  throw new Error('로컬 DB 설정이 손상되었습니다.');
                }
                values[key] = request.result.value;
              });
            }
          }
        },
      );
    },

    async set(values) {
      assertNormal();
      // Clone before awaiting so callers cannot change validated inputs while
      // database startup or another transaction is pending.
      const snapshot = structuredClone(values);
      const keys = keyList(Object.keys(snapshot));
      for (const key of keys) {
        const value = snapshot[key];
        if (key === HISTORY_KEY || key === JOBS_KEY) {
          if (!Array.isArray(value)
            || value.some(row => containsPrivate(row)
              || !(key === HISTORY_KEY ? validHistory(row) : isJob(row)))
            || new Set(value.map(row => row.id)).size !== value.length) {
            throw new Error('저장할 로컬 DB 기록이 올바르지 않습니다.');
          }
        } else if (!validSetting(key, value) || containsPrivate(value)) {
          throw new Error('저장할 로컬 DB 설정이 올바르지 않습니다.');
        }
      }
      const db = await current();
      const at = timestamp();
      await transaction<void>(db, STORES, 'readwrite', tx => {
        const recovery = tx.objectStore('recovery').count();
        const marker = tx.objectStore('meta').get(MIGRATION);
        let remaining = 2;
        const write = () => {
          if (--remaining) return;
          guarded(tx, () => {
            requireMigration(marker.result);
            for (const key of keys) {
              if (key === HISTORY_KEY) {
                const rows = snapshot[key] as HistoryItem[];
                replace(
                  tx.objectStore('history'),
                  recovery.result ? rows : retainHistory(rows),
                );
              } else if (key === JOBS_KEY) {
                const rows = snapshot[key] as Job[];
                replace(
                  tx.objectStore('jobs'),
                  recovery.result ? rows : retainJobs(rows, at),
                );
              } else {
                tx.objectStore('settings').put({ key, value: snapshot[key] });
              }
            }
          });
        };
        recovery.onsuccess = write;
        marker.onsuccess = write;
      });
    },

    async status() {
      const status: DatabaseStatus = {
        name,
        version: DATABASE_VERSION,
        privateContext: isPrivate(),
        historyCount: 0,
        jobCount: 0,
        recoveryCount: 0,
        lastMaintenanceAt: null,
        migratedAt: null,
        legacyCleanupPending: false,
      };
      if (status.privateContext) return status;
      const db = await current();
      return transaction<DatabaseStatus>(db, STORES, 'readonly', (tx, result) => {
        result(status);
        for (const [storeName, key] of [
          ['history', 'historyCount'],
          ['jobs', 'jobCount'],
          ['recovery', 'recoveryCount'],
        ] as const) {
          const request = tx.objectStore(storeName).count();
          request.onsuccess = () => { status[key] = request.result; };
        }
        const maintenance = tx.objectStore('meta').get(MAINTENANCE);
        maintenance.onsuccess = () => guarded(tx, () => {
          status.lastMaintenanceAt = metaNumber(maintenance.result?.value);
        });
        const migration = tx.objectStore('meta').get(MIGRATION);
        migration.onsuccess = () => guarded(tx, () => {
          status.migratedAt = requireMigration(migration.result);
        });
        const pending = tx.objectStore('meta').get(CLEANUP_PENDING);
        pending.onsuccess = () => {
          status.legacyCleanupPending = pending.result?.value === true;
        };
      });
    },

    close() {
      connection?.close();
      connection = undefined;
      barrier = undefined;
      lastMaintenance = -Infinity;
    },
  };
  return storage;
}

// Construction is lazy: imports do not open IndexedDB or read legacy storage.
export const appStorage = createAppStorage();
