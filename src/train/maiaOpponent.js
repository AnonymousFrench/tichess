/**
 * Maia 2 as a human-like sparring partner for the conversion trainer.
 * Runs its own instance of the existing Maia 2 Web Worker (same cached model),
 * so it never disturbs the Studio's Maia panel.
 */
import { Chess } from 'chess.js';

const MAIA_MODEL_URL = `${import.meta.env.BASE_URL}models/maia2-rapid-q8.onnx`;
const MAIA_WASM_PATHS = `${import.meta.env.BASE_URL}ort/`;
export const MAIA_MIN_ELO = 1000;
export const MAIA_MAX_ELO = 2200;

let worker = null;
let reqSeq = 0;
const pending = new Map();
let statusListener = null;

export function clampMaiaElo(elo) {
  const n = Math.round((Number(elo) || MAIA_MAX_ELO) / 100) * 100;
  return Math.max(MAIA_MIN_ELO, Math.min(MAIA_MAX_ELO, n));
}

/** Get notified of model download / init status: 'downloading' | 'initializing' | 'ready'. */
export function onMaiaStatus(fn) {
  statusListener = fn;
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../engines/maia2.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type === 'status' || msg.type === 'progress') {
      try {
        statusListener?.(msg.type === 'progress' ? { status: 'downloading', pct: msg.pct } : { status: msg.status });
      } catch (_) {}
      return;
    }
    const p = msg.reqId ? pending.get(msg.reqId) : null;
    if (!p) return;
    pending.delete(msg.reqId);
    clearTimeout(p.timer);
    if (msg.type === 'result') p.resolve(msg.candidates || []);
    else p.reject(new Error(msg.error || 'Maia 2 failed'));
  };
  worker.onerror = (err) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(err?.message || 'Maia 2 worker failed'));
      pending.delete(id);
    }
    try {
      worker.terminate();
    } catch (_) {}
    worker = null;
  };
  return worker;
}

export function disposeMaiaOpponent() {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error('Cancelled'));
    pending.delete(id);
  }
  if (worker) {
    try {
      worker.terminate();
    } catch (_) {}
    worker = null;
  }
}

/**
 * Maia's move probabilities for the side to move, both players at `elo`.
 * Resolves to [{ uci, san, prob }] sorted by probability.
 * The first call may download the model (~23 MB, cached afterwards).
 */
export function maiaCandidates(fen, elo, { timeoutMs = 90000 } = {}) {
  let chess;
  try {
    chess = new Chess(fen);
  } catch (_) {
    return Promise.reject(new Error('Invalid position'));
  }
  const legalMoves = chess.moves({ verbose: true }).map((m) => ({ uci: m.from + m.to + (m.promotion || ''), san: m.san }));
  if (!legalMoves.length) return Promise.resolve([]);
  const e = clampMaiaElo(elo);
  const w = ensureWorker();
  const reqId = ++reqSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error('Maia 2 timed out'));
    }, timeoutMs);
    pending.set(reqId, { resolve, reject, timer });
    w.postMessage({
      type: 'predict',
      reqId,
      fen,
      eloWhite: e,
      eloBlack: e,
      legalMoves,
      modelUrl: MAIA_MODEL_URL,
      wasmPaths: MAIA_WASM_PATHS,
    });
  });
}
