/**
 * Spaced-repetition blunder drills extracted from the player's own analyzed games.
 * Uses the same Leitner box schedule as src/repertoire/model.js.
 */
import { Chess } from 'chess.js';
import { IVL, MASTERED_BOX } from '../repertoire/model.js';
import { normalizeCastlingUci } from '../engines/uci.js';
import { BLUNDER_TAG_LABEL, PHASE_LABEL } from './coach.js';

export {
  DRILL_PROGRESS_KEY,
  loadDrillProgress,
  saveDrillProgress,
  recordDrillOutcome,
} from '../train/progressStore.js';

/** Unique stable ID for a blunder puzzle card. */
export function drillId(issue) {
  return `${issue.gameId}:${issue.ply}`;
}

/**
 * Extract playable drill cards from analyzed games in the current filter.
 * Keeps mistakes/blunders with a known engine best move (`bestUci`) and `winDrop >= 15`.
 */
export function extractDrillDeck(games, analysesMap, progress = {}, { now = Date.now(), tagFilter = 'all', phaseFilter = 'all' } = {}) {
  const gameMap = new Map(games.map((g) => [g.id, g]));
  const cards = [];

  for (const [id, analysis] of analysesMap || []) {
    const g = gameMap.get(id);
    if (!g) continue;
    for (const iss of analysis.issues || []) {
      if (!iss.bestUci || !iss.fenBefore || iss.winDrop < 15) continue;
      if (tagFilter !== 'all' && iss.tag !== tagFilter) continue;
      if (phaseFilter !== 'all' && iss.phase !== phaseFilter) continue;
      const cid = drillId(iss);
      const st = progress[cid] || { box: 0, due: 0, ok: 0, miss: 0 };
      cards.push({
        id: cid,
        ...iss,
        op: g.op,
        opR: g.opR,
        t: g.t,
        tc: g.tc,
        tagLabel: BLUNDER_TAG_LABEL[iss.tag] || iss.tag,
        phaseLabel: PHASE_LABEL[iss.phase] || iss.phase,
        box: st.box || 0,
        due: st.due || 0,
        isDue: !st.due || st.due <= now,
        mastered: (st.box || 0) >= MASTERED_BOX,
      });
    }
  }

  // Due cards first, then newest/largest winDrop.
  cards.sort((a, b) => Number(b.isDue) - Number(a.isDue) || b.winDrop - a.winDrop || b.t - a.t);
  const dueCount = cards.filter((c) => c.isDue).length;
  const masteredCount = cards.filter((c) => c.mastered).length;
  return { cards, dueCount, masteredCount };
}

/**
 * Validate a user's attempted move (`fromSq -> toSq`) against a drill card.
 * Accepts exact `bestUci` match (auto-promoting to queen or bestUci's promotion piece),
 * OR any legal move that delivers immediate checkmate!
 */
export function checkDrillAttempt(card, fromSq, toSq) {
  if (!card?.fenBefore || !fromSq || !toSq) return { legal: false, correct: false };
  let chess;
  try {
    chess = new Chess(card.fenBefore);
  } catch (_) {
    return { legal: false, correct: false };
  }
  const bestNorm = normalizeCastlingUci(card.fenBefore, card.bestUci || '');
  const promo = bestNorm.length === 5 && bestNorm.slice(0, 4) === `${fromSq}${toSq}` ? bestNorm[4] : 'q';
  let mv;
  try {
    mv = chess.move({ from: fromSq, to: toSq, promotion: promo });
  } catch (_) {
    return { legal: false, correct: false };
  }
  if (!mv) return { legal: false, correct: false };

  const playedUci = mv.from + mv.to + (mv.promotion || '');
  const playedNorm = normalizeCastlingUci(card.fenBefore, playedUci);
  const correct = playedNorm === bestNorm || chess.isCheckmate();
  return {
    legal: true,
    correct,
    san: mv.san,
    uci: playedNorm,
    fenAfter: chess.fen(),
  };
}

/** Human-readable next review interval after solving a card at `box`. */
export function nextIntervalLabel(nextBox) {
  const days = IVL[Math.min(IVL.length - 1, Math.max(0, nextBox))] || 1;
  return days === 1 ? '1 day' : `${days} days`;
}
