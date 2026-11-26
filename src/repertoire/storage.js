/**
 * Browser-local storage for the repertoire trainer. The repertoire itself
 * (several hundred KB) lives in IndexedDB; review progress is small and
 * written often, so it lives in localStorage like the original trainer.
 * Nothing here is ever sent over the network.
 */

const DB_NAME = 'tichess-repertoire';
const STORE = 'kv';
const PROGRESS_KEY = 'tichess-rep-progress';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kv(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** @returns {Promise<{repertoire: object, name: string} | null>} */
export async function loadRepertoire() {
  try {
    const v = await kv('readonly', (s) => s.get('repertoire'));
    return v && v.repertoire ? v : null;
  } catch (_) {
    return null;
  }
}

export function saveRepertoire(repertoire, name) {
  return kv('readwrite', (s) => s.put({ repertoire, name: name || '' }, 'repertoire'));
}

export function clearRepertoire() {
  return kv('readwrite', (s) => s.delete('repertoire'));
}

export function loadProgress() {
  try {
    const v = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch (_) {
    return {};
  }
}

/** @returns {boolean} whether the write succeeded */
export function saveProgress(progress) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
    return true;
  } catch (_) {
    return false;
  }
}
