/**
 * Pure evaluation & accuracy math shared between Studio Game Review and Insights Coach.
 * Kept free of DOM / Studio dependencies so the Insights bundle stays lean.
 */
import { Chess } from 'chess.js';
import { normalizeCastlingUci } from './uci.js';

export const MATE_CP = 10000;
export const WIN_CLAMP_CP = 1000;
export const ACPL_CAP_CP = 1000;

/**
 * Convert a White-perspective centipawn score into White's winning chances [0, 100].
 * Uses the standard logistic curve calibrated to centipawn evaluations.
 */
export function cpToWinPercent(whiteCp, mate = null) {
  if (typeof mate === 'number') {
    if (mate > 0) return 100;
    if (mate < 0) return 0;
    return (Number(whiteCp) || 0) >= 0 ? 100 : 0;
  }
  const clamped = Math.max(-WIN_CLAMP_CP, Math.min(WIN_CLAMP_CP, Number(whiteCp) || 0));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
}

/**
 * Compute single-move accuracy [0, 100] from the mover's winning chances before and after the move.
 */
export function moveAccuracyFromWinDrop(winDrop) {
  const drop = Math.max(0, Number(winDrop) || 0);
  if (drop === 0) return 100;
  const raw = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Classify a played move by comparing the position evaluation before and after the move.
 * Both `beforeEval` and `afterEval` are White-perspective `{ whiteCp, mate, bestUci }`.
 */
export function classifyReviewedMove(beforeEval, afterEval, moverColor, playedUci = '') {
  const wBefore = cpToWinPercent(beforeEval.whiteCp, beforeEval.mate);
  const wAfter = cpToWinPercent(afterEval.whiteCp, afterEval.mate);
  const moverWinBefore = moverColor === 'w' ? wBefore : 100 - wBefore;
  const moverWinAfter = moverColor === 'w' ? wAfter : 100 - wAfter;
  const winDrop = Math.max(0, moverWinBefore - moverWinAfter);

  const moverCpBefore = moverColor === 'w' ? beforeEval.whiteCp : -beforeEval.whiteCp;
  const moverCpAfter = moverColor === 'w' ? afterEval.whiteCp : -afterEval.whiteCp;
  const cpLoss = Math.min(ACPL_CAP_CP, Math.max(0, moverCpBefore - moverCpAfter));
  const accuracy = moveAccuracyFromWinDrop(winDrop);

  const isBest =
    Boolean(beforeEval.bestUci && playedUci && beforeEval.bestUci === playedUci) ||
    winDrop <= 0.5;

  let kind = isBest ? 'best' : 'good';
  let nag = '';
  if (!isBest) {
    if (winDrop >= 20) {
      kind = 'blunder';
      nag = '??';
    } else if (winDrop >= 10) {
      kind = 'mistake';
      nag = '?';
    } else if (winDrop >= 5) {
      kind = 'inaccuracy';
      nag = '?!';
    }
  }

  return {
    kind,
    nag,
    winDrop: Number(winDrop.toFixed(1)),
    cpLoss: Math.round(cpLoss),
    accuracy: Number(accuracy.toFixed(1)),
  };
}

/**
 * Format a White-perspective score as a compact label (e.g. "+1.45", "-0.30", "+M3").
 */
export function formatReviewScore(whiteCp, mate = null) {
  if (typeof mate === 'number') {
    if (mate === 0) return whiteCp >= 0 ? '+M0' : '-M0';
    return `${mate > 0 ? '+M' : '-M'}${Math.abs(mate)}`;
  }
  const cp = Number(whiteCp) || 0;
  return `${cp >= 0 ? '+' : ''}${(cp / 100).toFixed(2)}`;
}

/**
 * Convert a single UCI move from `fen` into SAN (empty string on failure).
 */
export function uciMoveToSan(fen, uci) {
  if (!fen || !uci || uci.length < 4) return '';
  try {
    const chess = new Chess(fen);
    const norm = normalizeCastlingUci(fen, uci);
    const m = chess.move({
      from: norm.slice(0, 2),
      to: norm.slice(2, 4),
      promotion: norm[4] || undefined,
    });
    return m ? m.san : '';
  } catch (_) {
    return '';
  }
}
