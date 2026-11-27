/**
 * Pure Maia-2 (NeurIPS 2024, CSSLab / MIT) tensor encoding, exact 1,880-move
 * vocabulary, Elo bucketing, board mirroring, and candidate grading helpers.
 * Zero DOM / ONNX Runtime dependencies so it can run inside Web Workers and Vitest.
 */
import { cpToWinPercent } from './evalMath.js';
import { analyzeMatingMaterial } from './humanfishMath.js';

const FILES = 'abcdefgh';

function sqName(sq) {
  return FILES[sq & 7] + String((sq >> 3) + 1);
}

/**
 * Generate Maia-2's exact 1,880-move canonical UCI vocabulary matching
 * `CSSLab/maia2` (`get_all_possible_moves` using python-chess MSB-first bitboard order).
 */
export function buildMaia2MoveVocabulary() {
  const moves = [];
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const fromSq = rank * 8 + file;
      const from = sqName(fromSq);

      // Queen moves from `fromSq`, scanned MSB-first (63 down to 0)
      for (let toSq = 63; toSq >= 0; toSq--) {
        if (toSq === fromSq) continue;
        const r2 = toSq >> 3;
        const f2 = toSq & 7;
        if (r2 === rank || f2 === file || Math.abs(r2 - rank) === Math.abs(f2 - file)) {
          moves.push(from + sqName(toSq));
        }
      }

      // Knight moves from `fromSq`, scanned MSB-first (63 down to 0)
      for (let toSq = 63; toSq >= 0; toSq--) {
        const dr = Math.abs((toSq >> 3) - rank);
        const df = Math.abs((toSq & 7) - file);
        if ((dr === 2 && df === 1) || (dr === 1 && df === 2)) {
          moves.push(from + sqName(toSq));
        }
      }
    }
  }

  // White 7th-to-8th rank promotions (Black positions are mirrored before inference)
  const promoPieces = ['q', 'r', 'b', 'n'];
  for (let fi = 0; fi < 8; fi++) {
    const f = FILES[fi];
    for (const p of promoPieces) moves.push(`${f}7${f}8${p}`);
    if (fi > 0) {
      const lf = FILES[fi - 1];
      for (const p of promoPieces) moves.push(`${f}7${lf}8${p}`);
    }
    if (fi < 7) {
      const rf = FILES[fi + 1];
      for (const p of promoPieces) moves.push(`${f}7${rf}8${p}`);
    }
  }
  return moves;
}

export const MAIA2_MOVES = buildMaia2MoveVocabulary();
export const MAIA2_MOVE_TO_IDX = new Map(MAIA2_MOVES.map((m, i) => [m, i]));

/**
 * Map a numeric Elo rating into Maia-2's 11 discrete buckets (0: <1100, 1..9: 1100..1999, 10: >=2000).
 */
export function eloToMaia2Category(elo) {
  const n = Math.round(Number(elo) || 1500);
  if (n < 1100) return 0;
  if (n >= 2000) return 10;
  return Math.floor((n - 1100) / 100) + 1;
}

/**
 * Mirror a UCI move vertically across ranks (1<->8, 2<->7, 3<->6, 4<->5).
 */
export function mirrorUci(uci) {
  if (!uci || uci.length < 4) return uci;
  const r1 = 9 - Number(uci[1]);
  const r2 = 9 - Number(uci[3]);
  return `${uci[0]}${r1}${uci[2]}${r2}${uci.slice(4)}`;
}

function swapCaseChar(ch) {
  const lower = ch.toLowerCase();
  return ch === lower ? ch.toUpperCase() : lower;
}

/**
 * Mirror a FEN vertically and swap piece colors (exact equivalent of `chess.Board(fen).mirror()`),
 * used by Maia-2 whenever Black is to move so the network always evaluates from White's perspective.
 */
export function mirrorFenForMaia2(fen) {
  const parts = String(fen || '').trim().split(/\s+/);
  if (parts.length < 4) return fen;

  const ranks = parts[0].split('/');
  if (ranks.length !== 8) return fen;

  const mirroredPlacement = [...ranks]
    .reverse()
    .map((row) =>
      row
        .split('')
        .map((ch) => (ch >= '1' && ch <= '8' ? ch : swapCaseChar(ch)))
        .join('')
    )
    .join('/');

  const nextSide = parts[1] === 'b' ? 'w' : 'b';

  let nextCastle = '-';
  if (parts[2] && parts[2] !== '-') {
    let wPart = '';
    let bPart = '';
    if (parts[2].includes('k')) wPart += 'K';
    if (parts[2].includes('q')) wPart += 'Q';
    if (parts[2].includes('K')) bPart += 'k';
    if (parts[2].includes('Q')) bPart += 'q';
    nextCastle = wPart + bPart || '-';
  }

  let nextEp = '-';
  if (parts[3] && parts[3] !== '-' && parts[3].length === 2) {
    nextEp = parts[3][0] + String(9 - Number(parts[3][1]));
  }

  return [mirroredPlacement, nextSide, nextCastle, nextEp, parts[4] || '0', parts[5] || '1'].join(' ');
}

const PIECE_CHANNEL = {
  P: 0,
  N: 1,
  B: 2,
  R: 3,
  Q: 4,
  K: 5,
  p: 6,
  n: 7,
  b: 8,
  r: 9,
  q: 10,
  k: 11,
};

/**
 * Encode a White-to-move (already mirrored if Black) FEN into Maia-2's `[18, 8, 8]` Float32Array.
 * Matches `CSSLab/maia2` `board_to_tensor` bit-for-bit (`row = rank 0..7` from rank 1 to rank 8).
 */
export function fenToMaia2Tensor(canonicalFen) {
  const tensor = new Float32Array(18 * 64);
  const parts = String(canonicalFen || '').trim().split(/\s+/);
  const ranks = (parts[0] || '').split('/');
  if (ranks.length !== 8) return tensor;

  for (let fenRow = 0; fenRow < 8; fenRow++) {
    const rankIdx = 7 - fenRow; // rank 1 = 0, rank 8 = 7
    let fileIdx = 0;
    for (const ch of ranks[fenRow]) {
      if (ch >= '1' && ch <= '8') {
        fileIdx += Number(ch);
      } else {
        const chIdx = PIECE_CHANNEL[ch];
        if (chIdx !== undefined && fileIdx < 8) {
          tensor[chIdx * 64 + rankIdx * 8 + fileIdx] = 1.0;
        }
        fileIdx++;
      }
    }
  }

  // Channel 12: side to move (1.0 when White)
  if (parts[1] !== 'b') {
    tensor.fill(1.0, 12 * 64, 13 * 64);
  }

  // Channels 13-16: castling rights K, Q, k, q
  const castle = parts[2] || '-';
  if (castle.includes('K')) tensor.fill(1.0, 13 * 64, 14 * 64);
  if (castle.includes('Q')) tensor.fill(1.0, 14 * 64, 15 * 64);
  if (castle.includes('k')) tensor.fill(1.0, 15 * 64, 16 * 64);
  if (castle.includes('q')) tensor.fill(1.0, 16 * 64, 17 * 64);

  // Channel 17: en passant target square
  const ep = parts[3] || '-';
  if (ep !== '-' && ep.length === 2) {
    const epFile = FILES.indexOf(ep[0]);
    const epRank = Number(ep[1]) - 1;
    if (epFile >= 0 && epFile < 8 && epRank >= 0 && epRank < 8) {
      tensor[17 * 64 + epRank * 8 + epFile] = 1.0;
    }
  }

  return tensor;
}

/**
 * Apply masked softmax over legal moves from Maia-2's 1,880 policy logits and un-mirror Black moves.
 * `legalMoves`: array of `{ uci, san }` in ORIGINAL board coordinates.
 */
export function decodeMaia2Policy(logits, legalMoves, isBlack) {
  if (!logits || !legalMoves?.length) return [];

  const scored = [];
  let maxLogit = -Infinity;
  for (const mv of legalMoves) {
    const canonical = isBlack ? mirrorUci(mv.uci) : mv.uci;
    const idx = MAIA2_MOVE_TO_IDX.get(canonical);
    const logit = idx !== undefined ? Number(logits[idx]) : -50;
    if (logit > maxLogit) maxLogit = logit;
    scored.push({ uci: mv.uci, san: mv.san, logit });
  }

  let sumExp = 0;
  for (const item of scored) {
    item.exp = Math.exp(Math.max(-60, item.logit - maxLogit));
    sumExp += item.exp;
  }

  const inv = sumExp > 0 ? 1 / sumExp : 1 / scored.length;
  return scored
    .map((item) => ({
      uci: item.uci,
      san: item.san,
      prob: item.exp * inv,
    }))
    .sort((a, b) => b.prob - a.prob);
}

/**
 * Convert Maia-2's value-head logit to White's expected score [0, 1],
 * respecting chess insufficient mating material constraints.
 */
export function decodeMaia2WhiteExpectedScore(valueLogit, isBlack, fen) {
  const rawMover = Math.max(0, Math.min(1, Number(valueLogit) / 2 + 0.5));
  let whiteExp = isBlack ? 1 - rawMover : rawMover;
  const mat = analyzeMatingMaterial(fen);
  let materialAdjusted = false;
  let materialReason = '';

  if (mat.deadDraw || (!mat.whiteCanWin && !mat.blackCanWin)) {
    whiteExp = 0.5;
    materialAdjusted = true;
    materialReason = mat.reason;
  } else if (!mat.blackCanWin && whiteExp < 0.5) {
    whiteExp = 0.5;
    materialAdjusted = true;
    materialReason = mat.reason;
  } else if (!mat.whiteCanWin && whiteExp > 0.5) {
    whiteExp = 0.5;
    materialAdjusted = true;
    materialReason = mat.reason;
  }

  return {
    whiteExp: Math.round(whiteExp * 10000) / 10000,
    materialAdjusted,
    materialReason,
  };
}

/**
 * Combine Maia-2 top human candidate moves with Stockfish evaluations
 * (`sfEvalMap`: Map<uci, { cpWhite, mate, pv }>, `bestSfUci`, `bestSfCpWhite`, `bestSfMate`)
 * to grade each move (`best` / `inaccuracy` / `blunder`), compute expected regret, and flag traps.
 */
export function gradeMaiaCandidates({
  candidates,
  isBlack,
  sfEvalMap,
  bestSfUci = '',
  bestSfCpWhite = 0,
  bestSfMate = null,
}) {
  const bestWhiteWin = cpToWinPercent(bestSfCpWhite, bestSfMate) / 100;
  const bestMoverWin = isBlack ? 1 - bestWhiteWin : bestWhiteWin;

  let coveredMass = 0;
  let weightedDrop = 0;
  let blunderMass = 0;

  const graded = candidates.map((c) => {
    const sf = sfEvalMap?.get(c.uci) || null;
    const isBest = Boolean(bestSfUci && c.uci === bestSfUci);
    if (!sf) {
      return {
        ...c,
        is_sf_best: isBest,
        cp_white: null,
        mate: null,
        drop_mover: null,
        grade: isBest ? 'best' : 'unknown',
        refutation: [],
      };
    }

    const whiteWin = cpToWinPercent(sf.cpWhite, sf.mate) / 100;
    const moverWin = isBlack ? 1 - whiteWin : whiteWin;
    const drop = isBest ? 0 : Math.max(0, bestMoverWin - moverWin);
    const grade = drop <= 0.03 ? 'best' : drop <= 0.08 ? 'inaccuracy' : 'blunder';

    coveredMass += c.prob;
    weightedDrop += c.prob * drop;
    if (drop >= 0.08) blunderMass += c.prob;

    return {
      ...c,
      is_sf_best: isBest,
      cp_white: sf.cpWhite,
      mate: sf.mate ?? null,
      drop_mover: Math.round(drop * 1000) / 1000,
      grade,
      refutation: Array.isArray(sf.pv) ? sf.pv.slice(1, 4) : [],
    };
  });

  const expectedRegret = coveredMass > 0.05 ? weightedDrop / coveredMass : 0;
  const blunderProb = coveredMass > 0.05 ? blunderMass / coveredMass : 0;
  const danger =
    expectedRegret >= 0.09 || blunderProb >= 0.32
      ? { level: 'high', label: 'Trap Risk' }
      : expectedRegret >= 0.04 || blunderProb >= 0.14
        ? { level: 'med', label: 'Sharp' }
        : { level: 'low', label: 'Calm' };

  return {
    candidates: graded,
    expectedRegret: Math.round(expectedRegret * 1000) / 1000,
    blunderProb: Math.round(blunderProb * 1000) / 1000,
    danger,
  };
}
