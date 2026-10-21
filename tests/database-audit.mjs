/** Real Chromium IndexedDB. API exceptions/aborts are explicit fault injection;
 * no fake IndexedDB, extension installation, or physical disk exhaustion claimed. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

export async function prepareDatabaseAudit(fixtures) {
  await build({ entryPoints: ['src/data/database.ts'], bundle: true, format: 'esm',
    outfile: path.join(fixtures, 'database-audit.js') });
}

export async function verifyDatabaseAudit(parentContext, origin) {
  const context = await parentContext.browser().newContext();
  await context.route(`${origin}/database-audit.html`, route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>IndexedDB audit</title>',
  }));
  await context.addInitScript(() => {
    Object.defineProperty(window, 'chrome', { configurable: true, value: {
      extension: { inIncognitoContext: false }, storage: { local: {
        get: async () => ({}), remove: async () => {},
      } },
    } });
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  let outcomes;
  try {
    await page.goto(`${origin}/database-audit.html`);
    outcomes = await page.evaluate(async () => {
      const { createAppStorage, DATABASE_VERSION } = await import('/fixtures/database-audit.js');
      const H = 'my_video_app_history_v1', J = 'vdh_upscale_jobs_v1';
      const O = 'vdh_upscale_offer_v1', P = 'my_video_app_download_options_v1';
      const now = 1_800_000_000_000, day = 86_400_000, MiB = 1024 * 1024;
      const outcomes = [], databases = [], stores = [];
      let sequence = 0;
      const check = (condition, message) => { if (!condition) throw Error(message); };
      const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
      const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
      const timeout = async (promise, label, milliseconds = 4000) => {
        let timer;
        try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), milliseconds); })]); }
        finally { clearTimeout(timer); }
      };
      const rejects = async (run, label) => {
        try { await timeout(Promise.resolve().then(run), label); }
        catch (error) { check(!String(error).includes('Timed out:'), String(error)); return String(error); }
        throw Error(`Expected rejection: ${label}`);
      };
      const requestResult = request => new Promise((resolve, reject) => {
        request.addEventListener('success', () => resolve(request.result), { once: true });
        request.addEventListener('error', () => reject(request.error ?? Error('IDB request failed')), { once: true });
      });
      const complete = transaction => new Promise((resolve, reject) => {
        transaction.addEventListener('complete', resolve, { once: true });
        transaction.addEventListener('abort', () => reject(transaction.error ?? Error('IDB transaction aborted')), { once: true });
      });
      const nativeOpen = indexedDB.open.bind(indexedDB);
      const rawOpen = (name, version) => requestResult(version === undefined ? nativeOpen(name) : nativeOpen(name, version));
      const rawGet = async (name, store, key) => {
        const db = await rawOpen(name);
        try {
          const tx = db.transaction(store, 'readonly'), done = complete(tx);
          const result = await requestResult(key === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(key));
          await done; return result;
        } finally { db.close(); }
      };
      const rawPut = async (name, store, value) => {
        const db = await rawOpen(name);
        try { const tx = db.transaction(store, 'readwrite'), done = complete(tx); tx.objectStore(store).put(value); await done; }
        finally { db.close(); }
      };
      const newName = () => { const name = `my-video-app-audit-${++sequence}`; databases.push(name); return name; };
      const legacy = initial => {
        const adapter = { data: structuredClone(initial), gets: 0, removes: 0,
          async get(keys) { this.gets++; return Object.fromEntries(keys.map(key => [key, structuredClone(this.data[key])])); },
          async remove(keys) { this.removes++; for (const key of keys) delete this.data[key]; },
        }; return adapter;
      };
      const create = options => { const value = createAppStorage({ now: () => now, legacy: legacy({}), ...options }); stores.push(value); return value; };
      const id = value => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
      const history = (value, extra = {}) => ({ id: id(value), url: `https://example.invalid/${value}.mp4`, filename: `${value}.mp4`, kind: 'file', state: 'complete', createdAt: now, incognito: false, ...extra });
      const job = (value, extra = {}) => ({ id: id(value), filename: `${value}.mp4`, size: 1024, createdAt: now, ...extra });
      const run = async (name, test) => {
        try { await timeout(test(), name, 10_000); outcomes.push({ name, status: 'passed' }); }
        catch (error) { outcomes.push({ name, status: 'failed', error: error instanceof Error ? error.message : String(error) }); }
      };

      await run('Automatic schema creation and real indexes', async () => {
        const name = newName(), storage = create({ name }); await storage.ready();
        const db = await rawOpen(name);
        try {
          equal(db.version, DATABASE_VERSION, 'Schema version');
          equal([...db.objectStoreNames], ['history', 'jobs', 'meta', 'recovery', 'settings'], 'Object stores');
          const tx = db.transaction([...db.objectStoreNames]);
          for (const [store, expected] of [['history', ['createdAt', 'downloadId', 'order', 'state']], ['jobs', ['createdAt', 'downloadId', 'order']]]) {
            equal([...tx.objectStore(store).indexNames], expected, `${store} indexes`);
            equal(tx.objectStore(store).keyPath, 'id', `${store} key path`);
          }
          equal(tx.objectStore('settings').keyPath, 'key', 'Settings key path');
          check(tx.objectStore('recovery').autoIncrement, 'Recovery records need generated local IDs');
        } finally { db.close(); }
        const status = await storage.status();
        equal([status.version, status.historyCount, status.jobCount, status.recoveryCount], [DATABASE_VERSION, 0, 0, 0], 'Empty status');
        check(status.migratedAt === now && status.lastMaintenanceAt === now, 'Automatic migration and maintenance timestamps');
      });

      await run('Legacy import commits before cleanup and preserves tied order', async () => {
        const name = newName(), initial = { [H]: [history(2), history(1)], [J]: [job(4), job(3)], [O]: false, [P]: { quality: '720', output: 'mp3' } };
        const source = legacy(initial), original = IDBObjectStore.prototype.put;
        let migrationCommitted = false, removedAfterCommit = false;
        IDBObjectStore.prototype.put = function (value, ...keys) {
          if (this.transaction.db.name === name && this.name === 'meta' && value.key === 'migration-v1') this.transaction.addEventListener('complete', () => { migrationCommitted = true; }, { once: true });
          return original.call(this, value, ...keys);
        };
        source.remove = async function (keys) { check(migrationCommitted, 'Legacy removal ran before transaction commit'); removedAfterCommit = true; this.removes++; for (const key of keys) delete this.data[key]; };
        try {
          const storage = create({ name, legacy: source }); await storage.ready();
          const data = await storage.get([H, J, O, P]);
          equal(data[H], initial[H], 'History values and tied order'); equal(data[J], initial[J], 'Job values and tied order');
          equal(data[O], false, 'False offer setting'); equal(data[P], initial[P], 'Download options');
          check(removedAfterCommit && source.removes === 1, 'Legacy cleaned once'); equal(source.data, {}, 'Legacy keys removed');
          const persisted = await rawGet(name, 'history'); check(persisted.every(row => row.value && Number.isInteger(row.order)), 'History uses ordered metadata wrappers');
        } finally { IDBObjectStore.prototype.put = original; }
      });

      await run('Reopen and repeated initialization preserve current DB over stale legacy', async () => {
        const name = newName(), stale = legacy({ [H]: [history(10)], [O]: true });
        const storage = create({ name, legacy: stale }); await storage.ready();
        await storage.set({ [H]: [history(11)], [O]: false }); await storage.close();
        const staleAgain = legacy({ [H]: [history(10)], [O]: true });
        const reopened = create({ name, legacy: staleAgain }); await Promise.all([reopened.ready(), reopened.ready()]);
        equal((await reopened.get(H))[H].map(row => row.id), [id(11)], 'Reopen must not reimport old history');
        equal((await reopened.get(O))[O], false, 'Reopen must not overwrite preference');
      });

      await run('Concurrent stale legacy snapshot cannot overwrite a newer committed write', async () => {
        const name = newName(), entered = deferred(), release = deferred(), old = legacy({ [H]: [history(20)] });
        old.get = async () => { entered.resolve(); await release.promise; return { [H]: [history(20)] }; };
        const slow = create({ name, legacy: old }); const pending = slow.ready();
        await timeout(entered.promise, 'Held legacy read');
        const fast = create({ name, legacy: legacy({ [H]: [history(21)] }) });
        try { await fast.ready(); await fast.set({ [H]: [history(22)] }); }
        finally { release.resolve(); }
        await pending;
        equal((await slow.get(H))[H].map(row => row.id), [id(22)], 'Migration marker must be rechecked inside write transaction');
      });

      await run('Actual migration transaction abort preserves legacy and supports retry', async () => {
        const name = newName(), initial = { [H]: [history(30)], [O]: false }, source = legacy(initial);
        const storage = create({ name, legacy: source }), original = IDBObjectStore.prototype.put;
        let aborted = false;
        IDBObjectStore.prototype.put = function (value, ...keys) {
          const request = original.call(this, value, ...keys);
          if (this.transaction.db.name === name && this.name === 'meta' && value.key === 'migration-v1' && !aborted) { aborted = true; this.transaction.abort(); }
          return request;
        };
        try { await rejects(() => storage.ready(), 'Aborted migration'); }
        finally { IDBObjectStore.prototype.put = original; }
        check(aborted, 'Real transaction abort was injected'); equal(source.removes, 0, 'Aborted import must not remove legacy');
        equal(source.data, initial, 'Legacy bytes remain intact'); equal(await rawGet(name, 'history'), [], 'Aborted history writes rolled back');
        equal(await rawGet(name, 'meta', 'migration-v1'), undefined, 'Aborted marker rolled back');
        await storage.ready(); equal((await storage.get(H))[H], initial[H], 'Retry imports original history');
      });

      await run('Quota exception aborts a multi-key write without clearing existing records', async () => {
        const name = newName(), storage = create({ name }); await storage.ready();
        await storage.set({ [H]: [history(40)], [O]: false });
        const original = IDBObjectStore.prototype.put; let injected = false;
        IDBObjectStore.prototype.put = function (value, ...keys) {
          if (this.transaction.db.name === name && this.name === 'history') { injected = true; throw new DOMException('Explicit audit quota fault', 'QuotaExceededError'); }
          return original.call(this, value, ...keys);
        };
        try { await rejects(() => storage.set({ [O]: true, [H]: [history(41)] }), 'Quota-injected write'); }
        finally { IDBObjectStore.prototype.put = original; }
        check(injected, 'Quota fault hook reached'); const data = await storage.get([H, O]);
        equal(data[H].map(row => row.id), [id(40)], 'Old history preserved'); equal(data[O], false, 'Other setting rolled back atomically');
      });

      await run('Open failure is reported without legacy cleanup or fallback', async () => {
        const name = newName(), source = legacy({ [H]: [history(50)] }); let opens = 0;
        const storage = create({ name, legacy: source, factory: { open() { opens++; throw new DOMException('Explicit audit security fault', 'SecurityError'); } } });
        for (const operation of [() => storage.ready(), () => storage.get(H), () => storage.set({ [O]: true }), () => storage.status()]) await rejects(operation, 'Unavailable IndexedDB');
        check(opens > 0, 'Open fault exercised'); equal(source.removes, 0, 'Open failure cannot clear legacy'); equal(source.data[H], [history(50)], 'Legacy preserved');
      });

      await run('Real blocked upgrade times out and late success releases its connection', async () => {
        const name = newName(), blocker = await rawOpen(name, DATABASE_VERSION), source = legacy({});
        let request;
        const factory = { open(dbName, version) { request = nativeOpen(dbName, version + 1); return request; } };
        const storage = create({ name, factory, legacy: source, blockedTimeoutMs: 40 });
        try { await rejects(() => storage.ready(), 'Blocked upgrade'); }
        finally { blocker.close(); }
        check(request, 'Real open request created');
        let lateError;
        try {
          if (request.readyState !== 'done') await timeout(requestResult(request), 'Late blocked request settles');
          else if (request.error) throw request.error;
        } catch (error) { lateError = error; }
        check(lateError?.name === 'AbortError', 'A timed-out upgrade must abort when it eventually unblocks');
        equal(source.gets, 0, 'Blocked opening must not read legacy'); equal(source.removes, 0, 'Blocked opening must not clear legacy');
        const preserved = await rawOpen(name);
        equal(preserved.version, DATABASE_VERSION, 'Timed-out upgrade preserves original DB version');
        equal([...preserved.objectStoreNames], [], 'Timed-out upgrade preserves original schema'); preserved.close();
        await timeout(requestResult(indexedDB.deleteDatabase(name)), 'Late request leaves no leaked connection');
      });

      await run('Versionchange closes the live connection and unknown versions remain intact', async () => {
        const name = newName(), storage = create({ name }); await storage.ready(); await storage.set({ [H]: [history(60)] });
        const upgraded = await timeout(rawOpen(name, DATABASE_VERSION + 1), 'Automatic close on versionchange');
        upgraded.close();
        await rejects(() => storage.get(H), 'Unsupported newer DB version');
        const db = await rawOpen(name); equal(db.version, DATABASE_VERSION + 1, 'Newer DB not destructively reset'); db.close();
        equal((await rawGet(name, 'history'))[0].value.id, id(60), 'Newer DB data preserved');
      });

      await run('Private mode makes zero IndexedDB and legacy calls', async () => {
        let opens = 0, legacyCalls = 0;
        const storage = create({ name: newName(), privateContext: () => true,
          factory: { open() { opens++; throw Error('Private IDB access'); } },
          legacy: { async get() { legacyCalls++; throw Error('Private legacy read'); }, async remove() { legacyCalls++; throw Error('Private legacy remove'); } },
        });
        await storage.ready(); const status = await storage.status();
        check(status.privateContext, 'Private status'); equal([status.historyCount, status.jobCount, status.recoveryCount], [0, 0, 0], 'Private counts');
        await rejects(() => storage.get(H), 'Private metadata get'); await rejects(() => storage.set({ [O]: true }), 'Private metadata set'); await storage.close();
        equal([opens, legacyCalls], [0, 0], 'No persistent private access');
      });

      await run('History retention caps at 200 with unresolved work and stable ties first', async () => {
        const storage = create({ name: newName() }); await storage.ready();
        const finished = Array.from({ length: 210 }, (_, index) => history(1000 + index, { createdAt: now - index }));
        const active = [history(2000, { state: 'scanning', createdAt: now - day }), history(2001, { state: 'review', createdAt: now - day }), history(2002, { state: 'downloading', createdAt: now - 1000 })];
        await storage.set({ [H]: [...finished, ...active] }); const rows = (await storage.get(H))[H];
        equal(rows.length, 200, 'History cap'); equal(rows.slice(0, 3).map(row => row.id), [id(2002), id(2000), id(2001)], 'Active priority and tied order');
        equal(rows.slice(3).map(row => row.id), finished.slice(0, 197).map(row => row.id), 'Newest completed history retained');
      });

      await run('Job management enforces count bytes TTL and lazy maintenance', async () => {
        let clock = now; const storage = create({ name: newName(), now: () => clock }); await storage.ready();
        await storage.set({ [J]: Array.from({ length: 5 }, (_, index) => job(3000 + index, { createdAt: now - index })) });
        equal((await storage.get(J))[J].map(row => row.id), [3000, 3001, 3002, 3003].map(id), 'Four newest job cap');
        await storage.set({ [J]: [job(3100, { size: 200 * MiB }), job(3101, { size: 200 * MiB, createdAt: now - 1 }), job(3102, { size: 200 * MiB, createdAt: now - 2 }), job(3103, { createdAt: now - day - 1 }), job(3104, { createdAt: now + 1 })] });
        equal((await storage.get(J))[J].map(row => row.id), [id(3100), id(3101)], '512 MiB budget and invalid timestamps');
        clock += day + 1; equal((await storage.get(J))[J], [], 'Lazy maintenance expires old metadata');
        equal((await storage.status()).lastMaintenanceAt, clock, 'Maintenance timestamp advances');
      });

      await run('Malformed legacy is quarantined without persisting private rows or pruning bindings', async () => {
        const name = newName(), secret = 'PRIVATE_AUDIT_SENTINEL_DO_NOT_STORE';
        const expired = job(4000, { createdAt: now - day - 1 });
        const source = legacy({ [H]: [history(4001), { ...history(4002), incognito: true, url: secret }, { incognito: true, secret }, { bad: 'PUBLIC_RECOVERY_SENTINEL' }], [J]: [expired, { bad: 'JOB_RECOVERY_SENTINEL' }], [O]: 'invalid', [P]: { quality: 'invalid', output: 'original' } });
        const storage = create({ name, legacy: source }); await storage.ready();
        const status = await storage.status(); equal(status.recoveryCount, 4, 'Each malformed nonprivate item quarantined');
        equal((await storage.get(H))[H].map(row => row.id), [id(4001)], 'Only valid public history visible');
        equal((await storage.get(J))[J], [expired], 'Recovery prevents destructive retention of uncertain file bindings');
        const recovery = await rawGet(name, 'recovery'), serialized = JSON.stringify(recovery);
        check(serialized.includes('PUBLIC_RECOVERY_SENTINEL') && serialized.includes('JOB_RECOVERY_SENTINEL'), 'Malformed source preserved for local recovery');
        check(!serialized.includes(secret) && !serialized.includes('"secret"'), 'Private legacy is never quarantined');
        await storage.close(); const reopened = create({ name }); await reopened.ready();
        equal((await reopened.status()).recoveryCount, 4, 'Recovery survives reopening');
        equal((await reopened.get(J))[J], [expired], 'Reopening keeps unknown file bindings');
      });

      await run('Corrupted current DB row rejects reads without clearing the row', async () => {
        const name = newName(), storage = create({ name }); await storage.ready(); await storage.set({ [H]: [history(5000)] });
        const corrupt = { id: id(5000), order: 0, value: { bad: 'CORRUPTED_CURRENT_ROW' } };
        await rawPut(name, 'history', corrupt); await rejects(() => storage.get(H), 'Corrupt history metadata');
        equal(await rawGet(name, 'history', id(5000)), corrupt, 'Read error does not erase corrupt data or produce a fake empty store');
      });

      await run('Legacy cleanup failure is visible and retry preserves newer DB writes', async () => {
        const name = newName(), source = legacy({ [H]: [history(6000)], [O]: true }); let allowCleanup = false;
        source.remove = async function (keys) { this.removes++; if (!allowCleanup) throw Error('Explicit legacy cleanup failure'); for (const key of keys) delete this.data[key]; };
        const storage = create({ name, legacy: source }); await storage.ready();
        check((await storage.status()).legacyCleanupPending, 'Cleanup warning reported');
        equal(source.data[H], [history(6000)], 'Unremoved legacy preserved'); await storage.set({ [O]: false }); await storage.close();
        allowCleanup = true; const reopened = create({ name, legacy: source }); await reopened.ready();
        check(!(await reopened.status()).legacyCleanupPending, 'Cleanup retry clears warning');
        equal((await reopened.get(O))[O], false, 'Cleanup retry never reimports stale settings'); equal(source.data, {}, 'Legacy eventually cleaned');
      });

      await run('Legacy read failure leaves no marker and a later retry can migrate', async () => {
        const name = newName(), source = legacy({ [H]: [history(7000)] }), original = source.get; let fail = true;
        source.get = async function (keys) { if (fail) throw Error('Explicit legacy read failure'); return original.call(this, keys); };
        const storage = create({ name, legacy: source }); await rejects(() => storage.ready(), 'Legacy read failure');
        equal(source.removes, 0, 'Failed read cannot remove legacy'); equal(await rawGet(name, 'meta', 'migration-v1'), undefined, 'Failed read cannot mark migration complete');
        fail = false; await storage.ready(); equal((await storage.get(H))[H], [history(7000)], 'Retry imports original data');
      });

      await run('Duplicate legacy IDs are retained in recovery instead of silently overwritten', async () => {
        const name = newName(), first = history(8000), duplicate = history(8000, { state: 'review', error: 'DUPLICATE_REVIEW_SENTINEL' });
        const firstJob = job(8001), duplicateJob = job(8001, { filename: 'duplicate.mp4' });
        const storage = create({ name, legacy: legacy({ [H]: [first, duplicate], [J]: [firstJob, duplicateJob] }) });
        await storage.ready(); equal((await storage.get(H))[H], [first], 'Deterministic first history retained');
        equal((await storage.get(J))[J], [firstJob], 'Deterministic first job retained');
        equal((await storage.status()).recoveryCount, 2, 'Duplicate records are visible as recovery warnings');
        const recovery = JSON.stringify(await rawGet(name, 'recovery'));
        check(recovery.includes('DUPLICATE_REVIEW_SENTINEL') && recovery.includes('duplicate.mp4'), 'Duplicate data remains available for local recovery');
      });

      await run('Missing migration marker in a populated DB rejects without reimport or deletion', async () => {
        const name = newName(), storage = create({ name }); await storage.ready();
        await storage.set({ [H]: [history(9000, { state: 'review' })], [J]: [job(9001)], [O]: false, [P]: { quality: '720', output: 'm4a' } });
        await storage.close();
        const db = await rawOpen(name);
        try {
          const tx = db.transaction('meta', 'readwrite'), done = complete(tx);
          tx.objectStore('meta').delete('migration-v1'); await done;
        } finally { db.close(); }
        const names = ['history', 'jobs', 'settings', 'meta', 'recovery'];
        const before = {};
        for (const store of names) before[store] = await rawGet(name, store);
        const initialLegacy = { [H]: [history(9002)], [J]: [job(9003)], [O]: true, [P]: { quality: '480', output: 'mp3' } };
        const source = legacy(initialLegacy), reopened = create({ name, legacy: source });
        for (const operation of [() => reopened.ready(), () => reopened.get([H, J, O, P]), () => reopened.status()]) await rejects(operation, 'Missing migration marker in populated DB');
        for (const store of names) equal(await rawGet(name, store), before[store], store + ' must remain byte-for-byte unchanged');
        equal(source.removes, 0, 'Corrupt migration metadata cannot clear legacy');
        equal(source.data, initialLegacy, 'Stale legacy remains intact for recovery');
      });

      await run('Live migration marker corruption blocks reads writes status and due maintenance', async () => {
        const name = newName(), source = legacy({}); let clock = now;
        const storage = create({ name, legacy: source, now: () => clock }); await storage.ready();
        await storage.set({ [H]: [history(9100, { state: 'review' })], [J]: [job(9101, { createdAt: now - day + 30_000 })], [O]: false, [P]: { quality: '720', output: 'm4a' } });
        const legacyRemoves = source.removes;
        const db = await rawOpen(name);
        try {
          const tx = db.transaction('meta', 'readwrite'), done = complete(tx);
          tx.objectStore('meta').delete('migration-v1'); await done;
        } finally { db.close(); }
        const names = ['history', 'jobs', 'settings', 'meta', 'recovery'], before = {};
        for (const store of names) before[store] = await rawGet(name, store);
        for (const elapsed of [0, 60_001]) {
          clock = now + elapsed;
          const operations = [
            () => storage.get([H, J, O, P]),
            () => storage.set({ [H]: [history(9102)], [J]: [job(9103)], [O]: true, [P]: { quality: '480', output: 'mp3' } }),
            () => storage.status(),
          ];
          for (const operation of operations) {
            await rejects(operation, 'Live missing marker after ' + elapsed + 'ms');
            for (const store of names) equal(await rawGet(name, store), before[store], store + ' unchanged after failed live operation at ' + elapsed + 'ms');
          }
        }
        equal(source.removes, legacyRemoves, 'Live corruption cannot trigger legacy cleanup');
      });

      for (const store of stores) await store.close();
      for (const name of databases) {
        try { await timeout(requestResult(indexedDB.deleteDatabase(name)), `Audit DB cleanup ${name}`); }
        catch (error) { outcomes.push({ name: 'Audit connection cleanup', status: 'failed', error: String(error) }); }
      }
      return outcomes;
    });
  } finally { await context.close(); }
  const sourceSha256 = {};
  for (const filename of ['src/data/database.ts', 'tests/database-audit.mjs']) sourceSha256[filename] = createHash('sha256').update(await readFile(filename)).digest('hex');
  await writeFile('reports/database.json', JSON.stringify({ browser: parentContext.browser().version(),
    mode: 'real Chromium IndexedDB in an isolated localhost browser context; Chrome legacy storage adapter mocked; abort/quota/open/version faults explicitly injected',
    sourceSha256, outcomes, pageErrors }, null, 2) + '\n');
  const failures = outcomes.filter(result => result.status !== 'passed');
  assert.deepEqual(pageErrors, [], 'Unexpected exceptions in the real IndexedDB audit context');
  assert.equal(failures.length, 0, failures.map(result => `${result.name}: ${result.error}`).join('\n'));
  console.log(`PASS ${outcomes.length} real IndexedDB database checks`);
  return outcomes;
}
