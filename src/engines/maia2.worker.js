import * as ort from 'onnxruntime-web/wasm';
import {
  eloToMaia2Category,
  mirrorFenForMaia2,
  fenToMaia2Tensor,
  decodeMaia2Policy,
  decodeMaia2WhiteExpectedScore,
} from './maia2Math.js';

const IDB_NAME = 'tichess-maia2-cache';
const IDB_STORE = 'models';
const MODEL_CACHE_KEY = 'maia2-rapid-q8-v1';

let session = null;
let initPromise = null;

function openCacheDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readCachedModel() {
  try {
    const db = await openCacheDb();
    if (!db) return null;
    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const get = tx.objectStore(IDB_STORE).get(MODEL_CACHE_KEY);
      get.onsuccess = () => resolve(get.result instanceof ArrayBuffer ? get.result : null);
      get.onerror = () => resolve(null);
    });
  } catch (_) {
    return null;
  }
}

async function writeCachedModel(buffer) {
  try {
    const db = await openCacheDb();
    if (!db) return;
    await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(buffer, MODEL_CACHE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch (_) {
    // Ignore storage quota errors — model still works from memory for this session
  }
}

async function fetchModelWithProgress(modelUrl) {
  const resp = await fetch(modelUrl);
  if (!resp.ok) {
    throw new Error(`Failed to download Maia 2 model (HTTP ${resp.status})`);
  }
  const total = Number(resp.headers.get('content-length') || 0);
  if (!resp.body?.getReader) {
    const buf = await resp.arrayBuffer();
    self.postMessage({ type: 'progress', pct: 100 });
    return buf;
  }

  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;
  let lastReported = -1;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    if (total > 0) {
      const pct = Math.min(99, Math.round((loaded / total) * 100));
      if (pct !== lastReported) {
        lastReported = pct;
        self.postMessage({ type: 'progress', pct, loaded, total });
      }
    }
  }

  const combined = new Uint8Array(loaded);
  let offset = 0;
  for (const ch of chunks) {
    combined.set(ch, offset);
    offset += ch.byteLength;
  }
  self.postMessage({ type: 'progress', pct: 100, loaded, total: total || loaded });
  return combined.buffer;
}

async function ensureSession(modelUrl, wasmPaths) {
  if (session) return session;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    ort.env.wasm.wasmPaths = wasmPaths;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;

    let buffer = await readCachedModel();
    if (!buffer) {
      self.postMessage({ type: 'status', status: 'downloading' });
      buffer = await fetchModelWithProgress(modelUrl);
      await writeCachedModel(buffer);
    }

    self.postMessage({ type: 'status', status: 'initializing' });
    session = await ort.InferenceSession.create(new Uint8Array(buffer), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    self.postMessage({ type: 'status', status: 'ready' });
    return session;
  })().catch((err) => {
    initPromise = null;
    throw err;
  });

  return initPromise;
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === 'init') {
    try {
      await ensureSession(msg.modelUrl, msg.wasmPaths);
    } catch (err) {
      self.postMessage({
        type: 'error',
        error: err?.message || 'Failed to initialize Maia 2 ONNX Runtime',
      });
    }
    return;
  }

  if (msg.type === 'predict') {
    const { reqId, fen, eloWhite, eloBlack, legalMoves, modelUrl, wasmPaths } = msg;
    try {
      const sess = await ensureSession(modelUrl, wasmPaths);
      const isBlack = String(fen || '').split(/\s+/)[1] === 'b';
      const canonicalFen = isBlack ? mirrorFenForMaia2(fen) : fen;
      const boardData = fenToMaia2Tensor(canonicalFen);

      const selfElo = isBlack ? eloBlack : eloWhite;
      const oppoElo = isBlack ? eloWhite : eloBlack;

      const feeds = {
        boards: new ort.Tensor('float32', boardData, [1, 18, 8, 8]),
        elo_self: new ort.Tensor('int64', BigInt64Array.from([BigInt(eloToMaia2Category(selfElo))]), [1]),
        elo_oppo: new ort.Tensor('int64', BigInt64Array.from([BigInt(eloToMaia2Category(oppoElo))]), [1]),
      };

      const outputs = await sess.run(feeds, ['logits_maia', 'logits_value']);
      const logits = outputs.logits_maia.data;
      const valLogit = outputs.logits_value.data[0];

      const allRanked = decodeMaia2Policy(logits, legalMoves, isBlack);
      const { whiteExp, materialAdjusted, materialReason } = decodeMaia2WhiteExpectedScore(
        valLogit,
        isBlack,
        fen
      );

      self.postMessage({
        type: 'result',
        reqId,
        fen,
        eloWhite,
        eloBlack,
        isBlack,
        whiteExp,
        materialAdjusted,
        materialReason,
        candidates: allRanked.slice(0, 6),
      });
    } catch (err) {
      self.postMessage({
        type: 'error',
        reqId,
        error: err?.message || 'Maia 2 inference failed',
      });
    }
  }
};
