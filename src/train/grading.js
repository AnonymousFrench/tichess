/**
 * Pure grading and card-selection logic for the position trainers.
 * No DOM, no workers: unit tested directly.
 *
 * Engine lines are always from the side to move's point of view:
 *   { uci, cp, mate }  (cp in centipawns, mate in moves, either may be null)
 */
import { Chess } from 'chess.js';
import { cpToWinPercent, MATE_CP } from '../engines/evalMath.js';
import { normalizeCastlingUci } from '../engines/uci.js';

/** A move counts as correct when it keeps the mover within this many win-% points of the best move. */
export const ACCEPT_WIN_DROP = 6;
/** A "safe" move (blunder check, second step) may give up a little more. */
export const SAFE_WIN_DROP = 10;
/** Both moves at least this good for the mover count as equally decisive. */
export const DECISIVE_CP = 500;
/** A line keeps going only while the best move is this much better than the second best. */
export const CRITICAL_GAP = 12;
/** User moves asked for in one mistake drill, at most. */
export const MAX_DRILL_STEPS = 3;

/** Blunder checks come from this move range, where most of your blunders happen. */
export const BLUNDER_CHECK_MOVES = [13, 30];

/** Conversion trainer thresholds (mover's centipawns). */
export const CONVERT_MIN_PEAK_CP = 200;
export const CONVERT_FAIL_CP = 100;
export const CONVERT_WIN_CP = 800;
export const CONVERT_MIN_MOVES_FOR_WIN = 3;
export const CONVERT_HOLD_MOVES = 20;

export function lineCp(line) {
  if (!line) return 0;
  if (typeof line.mate === 'number') return line.mate > 0 ? MATE_CP : line.mate < 0 ? -MATE_CP : 0;
  return Number(line.cp) || 0;
}

export function lineWin(line) {
  if (!line) return 50;
  return cpToWinPercent(Number(line.cp) || 0, typeof line.mate === 'number' ? line.mate : null);
}

/** Win-% points the mover gives up by playing `played` instead of `best`. */
export function winDropBetween(best, played) {
  return Math.max(0, lineWin(best) - lineWin(played));
}

/**
 * Grade a move given the engine's best line and the line for the move played.
 * `played` must come from the same position and side to move.
 */
export function gradeAgainstBest(best, played, tolerance = ACCEPT_WIN_DROP) {
  if (!best || !played) return { ok: false, drop: 100 };
  // Finding any forced mate when one exists is always fine.
  if (typeof best.mate === 'number' && best.mate > 0 && typeof played.mate === 'number' && played.mate > 0) {
    return { ok: true, drop: 0 };
  }
  const drop = winDropBetween(best, played);
  if (lineCp(best) >= DECISIVE_CP && lineCp(played) >= DECISIVE_CP) {
    return { ok: true, drop: Number(drop.toFixed(1)) };
  }
  return { ok: drop <= tolerance, drop: Number(drop.toFixed(1)) };
}

/**
 * True when the position has one clearly best move: the second line is at
 * least CRITICAL_GAP win-% points worse, or there is only one legal line.
 */
export function isCritical(lines, gap = CRITICAL_GAP) {
  if (!Array.isArray(lines) || !lines.length) return false;
  if (lines.length === 1) return true;
  return lineWin(lines[0]) - lineWin(lines[1]) >= gap;
}

/** Find the engine line for `uci` among `lines`, normalizing castling notation. */
export function findLine(lines, fen, uci) {
  if (!Array.isArray(lines) || !uci) return null;
  const want = normalizeCastlingUci(fen, uci);
  return lines.find((l) => normalizeCastlingUci(fen, l.uci) === want) || null;
}

/** Negate a line's score: what was good for one side is bad for the other. */
export function flipLine(line) {
  if (!line) return null;
  return {
    ...line,
    cp: typeof line.cp === 'number' ? -line.cp : line.cp,
    mate: typeof line.mate === 'number' ? -line.mate : line.mate,
  };
}

/**
 * Pick Maia's reply: sample among moves it gives at least `minProb`, weighted
 * by probability, so the opponent varies like a human but avoids oddities.
 * `rand` is injectable for tests.
 */
export function pickMaiaMove(candidates, { minProb = 0.1, rand = Math.random } = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).filter((c) => c && c.uci && Number(c.prob) >= 0);
  if (!list.length) return null;
  const pool = list.filter((c) => c.prob >= minProb);
  const use = pool.length ? pool : [list[0]];
  const total = use.reduce((s, c) => s + c.prob, 0);
  if (!(total > 0)) return use[0];
  let x = rand() * total;
  for (const c of use) {
    x -= c.prob;
    if (x <= 0) return c;
  }
  return use[use.length - 1];
}

/**
 * Decide whether a conversion play-out is over after the user's move.
 * `myCp` is the mover's eval after their move (from the user's point of view).
 */
export function convertVerdict({ myCp, myMoves, gameOver = null }) {
  if (gameOver === 'checkmate-win') return 'won';
  if (gameOver === 'draw') return 'drawn';
  if (myCp < CONVERT_FAIL_CP) return 'slipped';
  if (myMoves >= CONVERT_MIN_MOVES_FOR_WIN && myCp >= CONVERT_WIN_CP) return 'won';
  if (myMoves >= CONVERT_HOLD_MOVES && myCp >= CONVERT_MIN_PEAK_CP) return 'held';
  return 'playing';
}

/** Play a UCI move on a fresh Chess instance; returns { chess, move } or null. */
export function applyUci(fen, uci) {
  if (!fen || !uci || uci.length < 4) return null;
  let chess;
  try {
    chess = new Chess(fen);
  } catch (_) {
    return null;
  }
  const norm = normalizeCastlingUci(fen, uci);
  let move;
  try {
    move = chess.move({ from: norm.slice(0, 2), to: norm.slice(2, 4), promotion: norm[4] || undefined });
  } catch (_) {
    move = null;
  }
  return move ? { chess, move } : null;
}

/** FEN after the first `ply` SAN moves of a game, or '' if the moves don't replay. */
export function fenAtPly(movesSan, ply) {
  const sans = String(movesSan || '').split(' ').filter(Boolean);
  if (ply < 0 || ply > sans.length) return '';
  const chess = new Chess();
  for (let i = 0; i < ply; i++) {
    try {
      if (!chess.move(sans[i])) return '';
    } catch (_) {
      return '';
    }
  }
  return chess.fen();
}

function dueInfo(progress, id, now) {
  const st = progress[id] || null;
  return {
    box: st?.box || 0,
    due: st?.due || 0,
    isDue: !st || !st.due || st.due <= now,
    seen: Boolean(st),
  };
}

const PEAK_CACHE_MAX = 4000;
const afterFenCache = new Map();

function afterFen(key, fenBefore, uci) {
  const k = `${key}|${uci}`;
  if (afterFenCache.has(k)) return afterFenCache.get(k);
  const after = applyUci(fenBefore, uci);
  const fen = after ? after.chess.fen() : '';
  if (afterFenCache.size >= PEAK_CACHE_MAX) afterFenCache.clear();
  afterFenCache.set(k, fen);
  return fen;
}

/**
 * Blunder-check cards: your blunders (and big mistakes) between moves 13 and 30.
 * Step one shows the position after your game move and asks for their best reply;
 * step two asks for a safe move instead.
 */
export function extractBlunderCheckDeck(games, analysesMap, progress = {}, { now = Date.now() } = {}) {
  const gameMap = new Map((games || []).map((g) => [g.id, g]));
  const [lo, hi] = BLUNDER_CHECK_MOVES;
  const cards = [];
  for (const [id, analysis] of analysesMap || []) {
    const g = gameMap.get(id);
    if (!g) continue;
    for (const iss of analysis?.issues || []) {
      if (!iss?.fenBefore || !iss.playedUci) continue;
      if (iss.moveNum < lo || iss.moveNum > hi) continue;
      if (!(iss.kind === 'blunder' || (iss.kind === 'mistake' && iss.winDrop >= 20))) continue;
      const cid = `bc:${iss.gameId}:${iss.ply}`;
      const fenAfter = afterFen(cid, iss.fenBefore, iss.playedUci);
      if (!fenAfter) continue;
      cards.push({
        id: cid,
        mode: 'blunder',
        gameId: iss.gameId,
        ply: iss.ply,
        moveNum: iss.moveNum,
        color: iss.color,
        fenBefore: iss.fenBefore,
        fenAfter,
        playedSan: iss.playedSan,
        playedUci: iss.playedUci,
        evalBeforeLabel: iss.evalBeforeLabel,
        evalAfterLabel: iss.evalAfterLabel,
        winDrop: iss.winDrop,
        tag: iss.tag,
        op: g.op,
        opR: g.opR,
        t: g.t,
        tc: g.tc,
        ...dueInfo(progress, cid, now),
      });
    }
  }
  cards.sort((a, b) => Number(b.isDue) - Number(a.isDue) || b.winDrop - a.winDrop || b.t - a.t);
  return { cards, dueCount: cards.filter((c) => c.isDue).length };
}

// Replaying moves is the slow part of building the deck, and decks are rebuilt on
// every render, so remember each game's peak position ('' = unusable).
const peakFenCache = new Map();

function peakFen(g, ply) {
  const key = `${g.id}:${ply}:${g.moves.length}`;
  if (peakFenCache.has(key)) return peakFenCache.get(key);
  let fen = fenAtPly(g.moves, ply);
  if (fen) {
    try {
      if (new Chess(fen).isGameOver()) fen = '';
    } catch (_) {
      fen = '';
    }
  }
  if (peakFenCache.size >= PEAK_CACHE_MAX) peakFenCache.clear();
  peakFenCache.set(key, fen);
  return fen;
}

/**
 * Conversion cards: games where you reached +2 or better and did not win.
 * The card starts at your peak position.
 */
export function extractConvertDeck(games, analysesMap, progress = {}, { now = Date.now() } = {}) {
  const gameMap = new Map((games || []).map((g) => [g.id, g]));
  const cards = [];
  for (const [id, a] of analysesMap || []) {
    const g = gameMap.get(id);
    if (!g || !g.moves || !(g.res < 1)) continue;
    if (!(a?.peakCp >= CONVERT_MIN_PEAK_CP) || !(a.peakPly > 0)) continue;
    const fen = peakFen(g, a.peakPly);
    if (!fen) continue;
    const cid = `cv:${g.id}:${a.peakPly}`;
    cards.push({
      id: cid,
      mode: 'convert',
      gameId: g.id,
      ply: a.peakPly,
      moveNum: Math.ceil(a.peakPly / 2),
      color: g.color,
      fen,
      peakCp: a.peakCp,
      res: g.res,
      op: g.op,
      opR: g.opR,
      t: g.t,
      tc: g.tc,
      ...dueInfo(progress, cid, now),
    });
  }
  // Losses before draws, then the biggest advantages thrown away, newest first.
  cards.sort(
    (a, b) => Number(b.isDue) - Number(a.isDue) || a.res - b.res || Math.min(b.peakCp, 2000) - Math.min(a.peakCp, 2000) || b.t - a.t
  );
  return { cards, dueCount: cards.filter((c) => c.isDue).length };
}
