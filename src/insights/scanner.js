/**
 * Background Stockfish 19 Lite WASM batch scanner for Insights Coach.
 * Evaluates unanalyzed recent games locally in a single reusable Web Worker
 * (multi-threaded with automatic single-threaded fallback) and emits each
 * completed analysis record immediately so IndexedDB & UI stay live.
 */
import { Chess } from 'chess.js';
import { parseUciInfoLine, normalizeCastlingUci } from '../engines/uci.js';
import { MATE_CP } from '../engines/evalMath.js';
import { buildGameAnalysis } from './coach.js';

const STOCKFISH_MT_URL = `${import.meta.env.BASE_URL}stockfish/stockfish-19-lite.js`;
const STOCKFISH_ST_URL = `${import.meta.env.BASE_URL}stockfish/stockfish-19-lite-single.js`;
const MAX_SCAN_PLIES = 140;

function canUseMt() {
  return (
    typeof crossOriginIsolated !== 'undefined' &&
    crossOriginIsolated === true &&
    typeof SharedArrayBuffer !== 'undefined'
  );
}

function bootWorker(url, threads, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let uciOk = false;
    let w;
    const finish = (err, worker) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        if (w) {
          try {
            w.terminate();
          } catch (_) {}
        }
        reject(err);
      } else {
        resolve(worker);
      }
    };
    const timer = setTimeout(() => finish(new Error('Stockfish worker timed out')), timeoutMs);
    try {
      w = new Worker(url);
    } catch (err) {
      finish(err);
      return;
    }
    w.onerror = (e) => finish(new Error(e?.message || 'Stockfish worker error'));
    w.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : '';
      if (!line) return;
      if (line === 'uciok' && !uciOk) {
        uciOk = true;
        if (threads > 1) {
          w.postMessage(`setoption name Threads value ${threads}`);
          w.postMessage('setoption name Hash value 16');
        }
        w.postMessage('setoption name MultiPV value 1');
        w.postMessage('isready');
        return;
      }
      if (line === 'readyok' && uciOk) {
        w.onmessage = null;
        w.onerror = null;
        finish(null, w);
      }
    };
    w.postMessage('uci');
  });
}

async function createScanWorker() {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  const threads = canUseMt() ? Math.min(2, Math.max(1, cores - 1)) : 1;
  if (threads > 1) {
    try {
      return await bootWorker(STOCKFISH_MT_URL, threads, 5000);
    } catch (_) {
      /* fallback to single-threaded */
    }
  }
  return bootWorker(STOCKFISH_ST_URL, 1, 8000);
}

function evalFen(worker, fen, depth, signal) {
  let chess;
  try {
    chess = new Chess(fen);
  } catch (_) {
    return Promise.resolve({ whiteCp: 0, mate: null, bestUci: '' });
  }
  if (chess.isGameOver()) {
    if (chess.isCheckmate()) {
      const whiteWon = chess.turn() === 'b';
      return Promise.resolve({ whiteCp: whiteWon ? MATE_CP : -MATE_CP, mate: 0, bestUci: '' });
    }
    return Promise.resolve({ whiteCp: 0, mate: null, bestUci: '' });
  }
  const flip = chess.turn() === 'b' ? -1 : 1;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    let last = { whiteCp: 0, mate: null, bestUci: '' };
    let settled = false;

    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      try {
        worker.postMessage('stop');
      } catch (_) {}
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    worker.onerror = (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(e?.message || 'Stockfish crashed during scan'));
    };

    worker.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : '';
      if (!line) return;
      if (line.startsWith('info ') && line.includes(' score ') && line.includes(' pv ')) {
        const parsed = parseUciInfoLine(line);
        if (parsed && parsed.multipv === 1) {
          const isMate = parsed.scoreType === 'mate';
          const signed = parsed.scoreVal * flip;
          const rawFirst = parsed.pv?.[0] || '';
          last = {
            whiteCp: isMate ? (signed > 0 ? MATE_CP : -MATE_CP) : signed,
            mate: isMate ? signed : null,
            bestUci: rawFirst ? normalizeCastlingUci(fen, rawFirst) : '',
          };
        }
      } else if (line.startsWith('bestmove ')) {
        if (settled) return;
        settled = true;
        cleanup();
        const bm = line.split(/\s+/)[1];
        if (bm && bm !== '(none)' && !last.bestUci) {
          last.bestUci = normalizeCastlingUci(fen, bm);
        }
        resolve(last);
      }
    };

    worker.postMessage(`position fen ${fen}`);
    worker.postMessage(`go depth ${depth}`);
  });
}

function collectGameFens(game) {
  const sans = game.moves ? game.moves.split(' ').filter(Boolean).slice(0, MAX_SCAN_PLIES) : [];
  if (sans.length < 2) return [];
  const chess = new Chess();
  const fens = [chess.fen()];
  for (const s of sans) {
    try {
      if (!chess.move(s)) break;
      fens.push(chess.fen());
    } catch (_) {
      break;
    }
  }
  return fens;
}

/**
 * Scan `games` sequentially with a single background Stockfish worker.
 * Calls `onGameDone(analysis, index, total)` after each game and
 * `onProgress({ gameIdx, totalGames, plyIdx, totalPlies, opp })` during evaluation.
 */
export async function scanGamesWithStockfish(
  games,
  { depth = 10, signal, onProgress, onGameDone } = {}
) {
  if (!games.length) return { scanned: 0 };
  const worker = await createScanWorker();
  let scanned = 0;
  try {
    for (let gi = 0; gi < games.length; gi++) {
      if (signal?.aborted) break;
      const g = games[gi];
      const fens = collectGameFens(g);
      if (fens.length < 3) continue;

      worker.postMessage('ucinewgame');
      const rawPoints = [];
      for (let pi = 0; pi < fens.length; pi++) {
        if (signal?.aborted) break;
        const ev = await evalFen(worker, fens[pi], depth, signal);
        rawPoints.push(ev);
        if (pi === 0 || pi === fens.length - 1 || pi % 6 === 0) {
          onProgress?.({
            gameIdx: gi,
            totalGames: games.length,
            plyIdx: pi + 1,
            totalPlies: fens.length,
            opp: g.op,
          });
        }
      }
      if (signal?.aborted) break;
      const analysis = buildGameAnalysis(g, rawPoints, { source: 'stockfish', depth });
      if (analysis) {
        scanned++;
        await onGameDone?.(analysis, gi + 1, games.length);
      }
    }
  } finally {
    try {
      worker.terminate();
    } catch (_) {}
  }
  return { scanned };
}
