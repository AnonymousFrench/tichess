/**
 * Shared Stockfish 19 Lite worker for the position trainers.
 * One worker, one request at a time (queued), MultiPV and `searchmoves` support.
 * Lines come back from the side to move's point of view: { uci, cp, mate, pv }.
 */
import { Chess } from 'chess.js';
import { parseUciInfoLine, normalizeCastlingUci } from '../engines/uci.js';
import { createScanWorker } from '../insights/scanner.js';

export const TRAINER_DEPTH = 13;

let workerPromise = null;
let queue = Promise.resolve();
let currentMultiPv = 1;

function getWorker() {
  if (!workerPromise) {
    workerPromise = createScanWorker().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

/** Stop and discard the worker (e.g. when leaving the trainer). */
export function disposeTrainerEngine() {
  const p = workerPromise;
  workerPromise = null;
  currentMultiPv = 1;
  if (p) {
    p.then((w) => {
      try {
        w.terminate();
      } catch (_) {}
    }).catch(() => {});
  }
}

function terminalResult(chess) {
  if (chess.isCheckmate()) return { over: 'checkmate', lines: [] };
  if (chess.isGameOver()) return { over: 'draw', lines: [] };
  return null;
}

function runSearch(worker, fen, { depth, multipv, searchmoves }) {
  return new Promise((resolve, reject) => {
    const byPv = new Map();
    const timer = setTimeout(() => {
      try {
        worker.postMessage('stop');
      } catch (_) {}
    }, 20000);

    worker.onerror = (e) => {
      clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      reject(new Error(e?.message || 'Stockfish crashed'));
    };
    worker.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : '';
      if (!line) return;
      if (line.startsWith('info ') && line.includes(' score ') && line.includes(' pv ')) {
        const p = parseUciInfoLine(line);
        if (!p || !p.pv?.length) return;
        const isMate = p.scoreType === 'mate';
        byPv.set(p.multipv, {
          uci: normalizeCastlingUci(fen, p.pv[0]),
          cp: isMate ? null : p.scoreVal,
          mate: isMate ? p.scoreVal : null,
          pv: p.pv.slice(0, 8),
          depth: p.depth,
        });
      } else if (line.startsWith('bestmove ')) {
        clearTimeout(timer);
        worker.onmessage = null;
        worker.onerror = null;
        const lines = [...byPv.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
        if (!lines.length) {
          const bm = line.split(/\s+/)[1];
          if (bm && bm !== '(none)') lines.push({ uci: normalizeCastlingUci(fen, bm), cp: 0, mate: null, pv: [bm] });
        }
        resolve(lines);
      }
    };

    if (multipv !== currentMultiPv) {
      worker.postMessage(`setoption name MultiPV value ${multipv}`);
      currentMultiPv = multipv;
    }
    worker.postMessage(`position fen ${fen}`);
    const sm = searchmoves?.length ? ` searchmoves ${searchmoves.join(' ')}` : '';
    worker.postMessage(`go depth ${depth}${sm}`);
  });
}

/**
 * Analyse `fen`. Returns { over: null | 'checkmate' | 'draw', lines }.
 * With `searchmoves`, only those moves are searched (used to score the move played).
 */
export function analyse(fen, { depth = TRAINER_DEPTH, multipv = 3, searchmoves = null } = {}) {
  let chess;
  try {
    chess = new Chess(fen);
  } catch (_) {
    return Promise.reject(new Error('Invalid position'));
  }
  const term = terminalResult(chess);
  if (term) return Promise.resolve(term);

  const legal = new Set(chess.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion || '')));
  const sm = (searchmoves || []).filter((u) => legal.has(u));
  if (searchmoves && !sm.length) return Promise.reject(new Error('Move is not legal here'));
  const mpv = Math.max(1, Math.min(5, sm.length ? 1 : Math.min(multipv, legal.size)));

  const job = queue.then(async () => {
    const worker = await getWorker();
    const lines = await runSearch(worker, fen, { depth, multipv: mpv, searchmoves: sm });
    return { over: null, lines };
  });
  // Keep the queue alive even if this job fails.
  queue = job.catch(() => {});
  return job;
}

/** Score one specific move: the best line for the side to move restricted to `uci`. */
export async function scoreMove(fen, uci, { depth = TRAINER_DEPTH } = {}) {
  const norm = normalizeCastlingUci(fen, uci);
  const res = await analyse(fen, { depth, multipv: 1, searchmoves: [norm] });
  return res.lines[0] || null;
}
