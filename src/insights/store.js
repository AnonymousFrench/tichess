/**
 * Browser-local storage for Insights: normalized games plus the list of
 * linked accounts and their sync state. Nothing leaves the browser.
 */

const DB_NAME = 'tichess-insights';
const DB_VERSION = 2;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('games')) {
        const s = db.createObjectStore('games', { keyPath: 'id' });
        s.createIndex('account', ['src', 'acct']);
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('analyses')) db.createObjectStore('analyses', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = openDb().catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

function tx(storeNames, mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(storeNames, mode);
        let result;
        Promise.resolve(fn(t)).then((r) => {
          result = r;
        });
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
      })
  );
}

const reqResult = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export async function loadAllGames() {
  return tx('games', 'readonly', (t) => reqResult(t.objectStore('games').getAll()));
}

export async function countGames() {
  return tx('games', 'readonly', (t) => reqResult(t.objectStore('games').count()));
}

export async function putGames(records) {
  if (!records.length) return;
  await tx('games', 'readwrite', (t) => {
    const s = t.objectStore('games');
    for (const r of records) s.put(r);
  });
}

export async function deleteAccountGames(src, acct) {
  await tx('games', 'readwrite', (t) => {
    const idx = t.objectStore('games').index('account');
    const req = idx.openKeyCursor(IDBKeyRange.only([src, acct]));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      t.objectStore('games').delete(cur.primaryKey);
      cur.continue();
    };
  });
}

export async function loadAccounts() {
  const v = await tx('meta', 'readonly', (t) => reqResult(t.objectStore('meta').get('accounts')));
  return Array.isArray(v) ? v : [];
}

export async function saveAccounts(accounts) {
  await tx('meta', 'readwrite', (t) => {
    t.objectStore('meta').put(accounts, 'accounts');
  });
}

export async function loadPrefs() {
  const v = await tx('meta', 'readonly', (t) => reqResult(t.objectStore('meta').get('prefs')));
  return v && typeof v === 'object' ? v : {};
}

export async function savePrefs(prefs) {
  await tx('meta', 'readwrite', (t) => {
    t.objectStore('meta').put(prefs, 'prefs');
  });
}

export async function loadAllAnalyses() {
  return tx('analyses', 'readonly', (t) => reqResult(t.objectStore('analyses').getAll()));
}

export async function putAnalyses(records) {
  if (!records.length) return;
  await tx('analyses', 'readwrite', (t) => {
    const s = t.objectStore('analyses');
    for (const r of records) s.put(r);
  });
}

export async function deleteAnalyses(ids) {
  if (!ids.length) return;
  await tx('analyses', 'readwrite', (t) => {
    const s = t.objectStore('analyses');
    for (const id of ids) s.delete(id);
  });
}
