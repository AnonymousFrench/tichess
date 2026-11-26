import { Chess } from 'chess.js';
import { START_FEN, normalizeFen } from '../state.js';

const DB_NAME = 'ChessMonitorStudioLiveDB_v1';
const MIGRATION_KEY = 'cms_migr_v2';
const LEGACY_SAMPLE_ID = 'sample:wcc';
let dbPromise = null;

function deleteCollectionInDb(db, colId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['collections', 'games', 'positions'], 'readwrite');
    tx.objectStore('collections').delete(colId);
    ['games', 'positions'].forEach((sn) => {
      const r = tx.objectStore(sn).index('by_col').openKeyCursor(IDBKeyRange.only(colId));
      r.onsuccess = (e) => {
        const c = e.target.result;
        if (c) {
          tx.objectStore(sn).delete(c.primaryKey);
          c.continue();
        }
      };
    });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function runLegacyMigrations(db) {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(MIGRATION_KEY) === '1') {
      return;
    }
    await deleteCollectionInDb(db, LEGACY_SAMPLE_ID);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MIGRATION_KEY, '1');
    }
  } catch (_) {
    // Non-fatal: retry on next open
  }
}

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('collections')) {
        db.createObjectStore('collections', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('games')) {
        db.createObjectStore('games', { keyPath: 'id' }).createIndex('by_col', 'collectionId', { unique: false });
      }
      if (!db.objectStoreNames.contains('positions')) {
        db.createObjectStore('positions', { keyPath: 'key' }).createIndex('by_col', 'collectionId', { unique: false });
      }
    };
    req.onsuccess = async () => {
      const db = req.result;
      await runLegacyMigrations(db);
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function dbGetCollections() {
  try {
    const db = await openDB();
    return await new Promise((res, rej) => {
      const r = db.transaction('collections', 'readonly').objectStore('collections').getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  } catch (_) {
    return [];
  }
}

export async function dbDeleteCollection(colId) {
  const db = await openDB();
  return deleteCollectionInDb(db, colId);
}

export async function dbSaveCollection(meta, games, posMap) {
  await dbDeleteCollection(meta.id);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['collections', 'games', 'positions'], 'readwrite');
    tx.objectStore('collections').put(meta);
    const gs = tx.objectStore('games');
    for (const g of games) gs.put(g);
    const ps = tx.objectStore('positions');
    for (const [normFen, entries] of posMap.entries()) {
      ps.put({ key: `${meta.id}|${normFen}`, collectionId: meta.id, normFen, entries });
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbLookupPos(colId, normFen) {
  try {
    const db = await openDB();
    return await new Promise((res, rej) => {
      const r = db.transaction('positions', 'readonly').objectStore('positions').get(`${colId}|${normFen}`);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => rej(r.error);
    });
  } catch (_) {
    return null;
  }
}

export async function dbGetGamesByIds(ids) {
  if (!ids || !ids.length) return [];
  const db = await openDB();
  return new Promise((resolve) => {
    const store = db.transaction('games', 'readonly').objectStore('games');
    const out = [];
    let left = ids.length;
    for (const id of ids) {
      const r = store.get(id);
      r.onsuccess = () => {
        if (r.result) out.push(r.result);
        if (--left === 0) resolve(out);
      };
      r.onerror = () => {
        if (--left === 0) resolve(out);
      };
    }
  });
}

export async function dbWipeAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['collections', 'games', 'positions'], 'readwrite');
    tx.objectStore('collections').clear();
    tx.objectStore('games').clear();
    tx.objectStore('positions').clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function indexGamesCollection(meta, rawGames, progressCb = null) {
  const posMap = new Map();
  const storedGames = [];
  const targetUser = (meta.username || '').toLowerCase();

  for (let i = 0; i < rawGames.length; i++) {
    const rg = rawGames[i];
    if (!rg.pgn) continue;

    const parser = new Chess();
    try {
      parser.loadPgn(rg.pgn, { strict: false });
    } catch (_) {
      continue;
    }

    const h = parser.getHeaders();
    const startFen = h.FEN || START_FEN;
    const verbose = parser.history({ verbose: true });
    if (!verbose.length) continue;

    let replay;
    try {
      replay = new Chess(startFen);
    } catch (_) {
      continue;
    }

    const white = rg.white || h.White || 'White';
    const black = rg.black || h.Black || 'Black';
    const whiteElo = parseInt(rg.whiteElo || h.WhiteElo || '0', 10) || 0;
    const blackElo = parseInt(rg.blackElo || h.BlackElo || '0', 10) || 0;
    const result = rg.result || h.Result || '*';
    const date = rg.date || h.Date || h.UTCDate || '';
    const event = rg.event || h.Event || meta.name;
    const resCode = result === '1-0' ? 'w' : result === '0-1' ? 'b' : 'd';

    let pColor = 'both';
    if (targetUser) {
      if (white.toLowerCase().includes(targetUser)) pColor = 'white';
      else if (black.toLowerCase().includes(targetUser)) pColor = 'black';
    }

    const snippet = verbose
      .slice(0, 8)
      .map((m, idx) => (idx % 2 === 0 ? `${Math.floor(idx / 2) + 1}.${m.san}` : m.san))
      .join(' ');
    const gid = `${meta.id}:${storedGames.length}`;
    storedGames.push({
      id: gid,
      collectionId: meta.id,
      white,
      whiteElo,
      black,
      blackElo,
      result,
      date,
      event,
      pColor,
      snippet,
      pgn: rg.pgn,
    });

    const lim = Math.min(verbose.length, 40);
    for (let p = 0; p < lim; p++) {
      const norm = normalizeFen(replay.fen());
      let m = null;
      try {
        m = replay.move({
          from: verbose[p].from,
          to: verbose[p].to,
          promotion: verbose[p].promotion,
        });
      } catch (_) {
        break;
      }
      if (!m) break;
      const uci = m.from + m.to + (m.promotion || '');
      let arr = posMap.get(norm);
      if (!arr) {
        arr = [];
        posMap.set(norm, arr);
      }
      arr.push({ uci, san: m.san, res: resCode, pColor, gid });
    }

    if (progressCb && i % 15 === 0) {
      progressCb(50 + (i / Math.max(1, rawGames.length)) * 45, `Indexing ${i + 1}/${rawGames.length}...`);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  meta.gameCount = storedGames.length;
  await dbSaveCollection(meta, storedGames, posMap);
  return meta;
}
