/**
 * Pure Coach & "+100 Elo" analytics for Insights.
 * Combines pure-stat Elo leak math (Phase 1) with real engine/clock diagnostics
 * from Lichess server evals or local Stockfish 19 WASM scans (Phase 2).
 */
import { Chess } from 'chess.js';
import {
  cpToWinPercent,
  classifyReviewedMove,
  formatReviewScore,
  uciMoveToSan,
  MATE_CP,
} from '../engines/evalMath.js';
import { normalizeCastlingUci } from '../engines/uci.js';
import {
  wdl,
  habits,
  terminations,
  versusStrength,
  byTimeControl,
  ratingContext,
} from './stats.js';

export const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export const PHASE_LABEL = {
  opening: 'Opening',
  middlegame: 'Middlegame',
  endgame: 'Endgame',
};

export const BLUNDER_TAG_LABEL = {
  hung_piece: 'Hung piece / free capture',
  endgame_error: 'Endgame technique',
  missed_tactic: 'Missed tactic',
  missed_mate: 'Missed checkmate',
  allowed_mate: 'Allowed checkmate',
  opening_blunder: 'Opening blunder',
  positional_blunder: 'Positional / strategic error',
};

/* ------------------------------------------------------------------ */
/* Elo math                                                            */
/* ------------------------------------------------------------------ */

/** Elo rating difference implied by a score in (0, 1). */
export function eloFromScore(score) {
  const p = Math.min(0.98, Math.max(0.02, Number(score) || 0.5));
  return 400 * Math.log10(p / (1 - p));
}

/** Expected score needed against equal peers to gain `gain` Elo (e.g. +100 → ~0.640). */
export function targetScoreForEloGain(gain = 100) {
  return 1 / (1 + 10 ** (-gain / 400));
}

/**
 * Counterfactual Elo gain if overall score improves from `baseScore` by `deltaScore`.
 * Uses the exact logistic Elo curve with safe clamping.
 */
export function eloGainFromScoreDelta(baseScore, deltaScore) {
  if (!Number.isFinite(baseScore) || !Number.isFinite(deltaScore) || deltaScore <= 0) return 0;
  const p1 = Math.min(0.95, Math.max(0.05, baseScore));
  const p2 = Math.min(0.97, Math.max(p1, p1 + deltaScore));
  return Math.max(0, Math.round(eloFromScore(p2) - eloFromScore(p1)));
}

/** Parse `'180+2'` → `{ initial: 180, inc: 2 }`, or null. */
export function parseClockSpec(clockStr) {
  const m = String(clockStr || '').match(/^(\d+)(?:\+(\d+))?$/);
  if (!m) return null;
  return { initial: Number(m[1]) || 0, inc: Number(m[2]) || 0 };
}

/* ------------------------------------------------------------------ */
/* Phase 1: Game length, opening cliffs, repertoire reality check      */
/* ------------------------------------------------------------------ */

/** Score by game length: short (≤20 moves), medium (21–40), long (41+). */
export function gameLengthProfile(games) {
  const buckets = [
    { id: 'short', label: 'Short (≤20 mv)', games: [] },
    { id: 'medium', label: 'Medium (21–40 mv)', games: [] },
    { id: 'long', label: 'Long (41+ mv)', games: [] },
  ];
  let earlyLosses = 0;
  for (const g of games) {
    const moves = Math.ceil((g.plies || 0) / 2);
    if (moves <= 20) {
      buckets[0].games.push(g);
      if (g.res === 0 && (g.term === 'mate' || g.term === 'resign')) earlyLosses++;
    } else if (moves <= 40) {
      buckets[1].games.push(g);
    } else {
      buckets[2].games.push(g);
    }
  }
  return {
    buckets: buckets.map((b) => ({ id: b.id, label: b.label, ...wdl(b.games) })),
    earlyLosses,
  };
}

/**
 * Walk the player's opening move tree (up to `maxPlies`) and find concrete
 * positions where the owner's own move causes a clear score drop vs baseline.
 */
export function findOpeningCliffs(games, { minGames = 5, maxPlies = 12, limit = 8 } = {}) {
  const totalN = games.length;
  if (totalN < minGames) return [];
  const overallScore = wdl(games).score;
  const cliffs = [];

  for (const color of ['w', 'b']) {
    const cGames = games.filter((g) => g.color === color && g.moves);
    if (cGames.length < minGames) continue;
    const colorBase = wdl(cGames).score;

    // Build move prefix counts up to maxPlies.
    const nodes = new Map(); // prefixKey -> { path, n, pts, opening, children: Map<san, childKey> }
    const rootKey = '';
    nodes.set(rootKey, { path: [], n: 0, pts: 0, opening: '', children: new Map() });

    for (const g of cGames) {
      const sans = g.moves.split(' ').slice(0, maxPlies);
      let parentKey = rootKey;
      const root = nodes.get(rootKey);
      root.n++;
      root.pts += g.res;

      for (let ply = 0; ply < sans.length; ply++) {
        const san = sans[ply];
        const key = parentKey ? `${parentKey} ${san}` : san;
        let node = nodes.get(key);
        if (!node) {
          node = { path: sans.slice(0, ply + 1), n: 0, pts: 0, opening: g.opening || '', children: new Map() };
          nodes.set(key, node);
        }
        node.n++;
        node.pts += g.res;
        if (!node.opening && g.opening) node.opening = g.opening;
        nodes.get(parentKey).children.set(san, key);
        parentKey = key;
      }
    }

    // Look for owner-turn decisions where the move underperforms both baseline and parent.
    const candidates = [];
    for (const [parentKey, parent] of nodes) {
      const ply = parent.path.length;
      const isMyTurn = (ply % 2 === 0) === (color === 'w');
      if (!isMyTurn || ply === 0 || parent.n < minGames) continue;
      const parentScore = parent.pts / parent.n;

      for (const [san, childKey] of parent.children) {
        const child = nodes.get(childKey);
        if (!child || child.n < minGames) continue;
        const score = child.pts / child.n;
        const refScore = Math.max(colorBase, parentScore);
        const deficit = refScore - score;
        if (deficit < 0.06) continue;
        const lostPoints = deficit * child.n;
        const eloImpact = eloGainFromScoreDelta(overallScore, lostPoints / totalN);
        candidates.push({
          color,
          ply,
          prefix: parentKey,
          path: parent.path,
          playedSan: san,
          childPrefix: childKey,
          n: child.n,
          parentN: parent.n,
          score,
          parentScore,
          colorBase,
          deficit,
          lostPoints,
          eloImpact,
          opening: child.opening || parent.opening || '',
        });
      }
    }

    // Deduplicate overlapping prefixes (keep the deepest/strongest distinct cliff per branch).
    candidates.sort((a, b) => b.lostPoints - a.lostPoints || b.ply - a.ply);
    const picked = [];
    for (const c of candidates) {
      const overlaps = picked.some(
        (p) =>
          p.childPrefix === c.childPrefix ||
          p.childPrefix.startsWith(`${c.childPrefix} `) ||
          c.childPrefix.startsWith(`${p.childPrefix} `)
      );
      if (overlaps) continue;
      const pos = replayPath(c.path, c.playedSan);
      if (!pos) continue;
      picked.push({
        ...c,
        fen: pos.fen,
        playedUci: pos.playedUci,
        last: pos.last,
      });
      if (picked.length >= Math.ceil(limit / 2) + 2) break;
    }
    cliffs.push(...picked);
  }

  return cliffs.sort((a, b) => b.lostPoints - a.lostPoints).slice(0, limit);
}

function replayPath(path, nextSan) {
  const chess = new Chess();
  let last = null;
  for (const s of path) {
    try {
      const m = chess.move(s);
      if (!m) return null;
      last = { from: m.from, to: m.to };
    } catch (_) {
      return null;
    }
  }
  const fen = chess.fen();
  let playedUci = '';
  if (nextSan) {
    try {
      const m = chess.move(nextSan);
      if (m) playedUci = m.from + m.to + (m.promotion || '');
    } catch (_) {
      /* ignore */
    }
  }
  return { fen, playedUci, last };
}

function normFen4(fen) {
  return String(fen || '').split(' ').slice(0, 4).join(' ');
}

/**
 * Compare the player's actual games against their saved repertoire (from repertoire.html).
 * Surfaces:
 *   - memorySlips: positions in your repertoire where YOU deviated on your turn
 *   - missingSidelines: opponent moves not yet in your repertoire
 */
export function compareRepertoireToGames(repertoire, games, { maxGames = 300, maxPlies = 24 } = {}) {
  if (!repertoire?.pos?.length || !games.length) return null;

  // Map normalized FEN -> repertoire position entry per color.
  const posByFen = new Map();
  for (const p of repertoire.pos) {
    if (!p?.f || !Array.isArray(p.e)) continue;
    const key = normFen4(p.f);
    if (!posByFen.has(key)) posByFen.set(key, p);
  }

  const recent = [...games].sort((a, b) => b.t - a.t).slice(0, maxGames);
  const slips = new Map();
  const sidelines = new Map();
  let checkedGames = 0;

  for (const g of recent) {
    if (!g.moves) continue;
    const sans = g.moves.split(' ').slice(0, maxPlies);
    if (!sans.length) continue;
    const chess = new Chess();
    let inBook = false;
    checkedGames++;

    for (let ply = 0; ply < sans.length; ply++) {
      const nf = normFen4(chess.fen());
      const repPos = posByFen.get(nf);
      let mv;
      try {
        mv = chess.move(sans[ply]);
      } catch (_) {
        break;
      }
      if (!mv) break;
      const uci = mv.from + mv.to + (mv.promotion || '');

      if (!repPos || !repPos.e.length) {
        if (inBook) break;
        continue;
      }

      const myTurn = (ply % 2 === 0) === (g.color === 'w');
      const matched = repPos.e.find((e) => e[0] === uci || e[1] === mv.san);
      if (matched) {
        inBook = true;
        continue;
      }

      // Only record deviations after at least 1 move matched (or on move 1 if repertoire covers it).
      if (!inBook && ply > 1) break;

      const prefix = sans.slice(0, ply).join(' ');
      if (myTurn) {
        // Check if this repertoire node actually has a move intended for the owner's color.
        const hasMyMove = repPos.e.some((e) => e[5]);
        if (hasMyMove) {
          const k = `${g.color}|${prefix}|${mv.san}`;
          let entry = slips.get(k);
          if (!entry) {
            const expected = repPos.e.filter((e) => e[5]).map((e) => e[1]);
            entry = { color: g.color, prefix, playedSan: mv.san, expectedSans: expected, n: 0, pts: 0 };
            slips.set(k, entry);
          }
          entry.n++;
          entry.pts += g.res;
        }
      } else if (inBook) {
        const k = `${g.color}|${prefix}|${mv.san}`;
        let entry = sidelines.get(k);
        if (!entry) {
          entry = { color: g.color, prefix, oppSan: mv.san, n: 0, pts: 0 };
          sidelines.set(k, entry);
        }
        entry.n++;
        entry.pts += g.res;
      }
      break;
    }
  }

  const fmt = (map) =>
    [...map.values()]
      .filter((e) => e.n >= 2)
      .map((e) => ({ ...e, score: e.pts / e.n }))
      .sort((a, b) => b.n - a.n || a.score - b.score)
      .slice(0, 6);

  return {
    checkedGames,
    memorySlips: fmt(slips),
    missingSidelines: fmt(sidelines),
  };
}

/* ------------------------------------------------------------------ */
/* Phase 2: Engine & Clock Per-Game Analysis                           */
/* ------------------------------------------------------------------ */

/** Deterministic game phase from material & queens via chess.js. */
export function detectPhase(chess, ply) {
  let queens = 0;
  let nonPawnMat = 0;
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq || sq.type === 'k' || sq.type === 'p') continue;
      if (sq.type === 'q') queens++;
      nonPawnMat += PIECE_VALUE[sq.type] || 0;
    }
  }
  if (queens === 0 || nonPawnMat <= 24) return 'endgame';
  if (ply <= 20 && nonPawnMat >= 48) return 'opening';
  return 'middlegame';
}

/**
 * Deterministic blunder/mistake tagger from real board state & engine evaluations.
 */
export function classifyBlunderTag({ fenBefore, playedUci, bestUci, beforeEval, afterEval, phase, moverColor, winDrop }) {
  const beforeMateForMe = typeof beforeEval.mate === 'number' && (moverColor === 'w' ? beforeEval.mate > 0 : beforeEval.mate < 0);
  const afterMateForMe = typeof afterEval.mate === 'number' && (moverColor === 'w' ? afterEval.mate > 0 : afterEval.mate < 0);
  const beforeMateAgainst = typeof beforeEval.mate === 'number' && (moverColor === 'w' ? beforeEval.mate < 0 : beforeEval.mate > 0);
  const afterMateAgainst = typeof afterEval.mate === 'number' && (moverColor === 'w' ? afterEval.mate < 0 : afterEval.mate > 0);

  if (beforeMateForMe && !afterMateForMe) return 'missed_mate';
  if (!beforeMateAgainst && afterMateAgainst) return 'allowed_mate';

  // Check if opponent's immediate reply captures a piece cleanly ("hung piece").
  if (fenBefore && playedUci && playedUci.length >= 4) {
    try {
      const c = new Chess(fenBefore);
      const normPlayed = normalizeCastlingUci(fenBefore, playedUci);
      const playedMv = c.move({
        from: normPlayed.slice(0, 2),
        to: normPlayed.slice(2, 4),
        promotion: normPlayed[4] || undefined,
      });
      if (playedMv) {
        const oppReply = afterEval.bestUci ? normalizeCastlingUci(c.fen(), afterEval.bestUci) : '';
        if (oppReply && oppReply.length >= 4) {
          const targetPiece = c.get(oppReply.slice(2, 4));
          const movedValue = PIECE_VALUE[playedMv.captured] || 0;
          const lostValue = targetPiece ? PIECE_VALUE[targetPiece.type] || 0 : 0;
          if (lostValue >= 3 && lostValue - movedValue >= 2) {
            const capMv = c.move({
              from: oppReply.slice(0, 2),
              to: oppReply.slice(2, 4),
              promotion: oppReply[4] || undefined,
            });
            if (capMv) {
              // Check if mover can immediately recapture equal or greater material on that square.
              const recaps = c
                .moves({ verbose: true })
                .filter((m) => m.to === capMv.to && m.captured);
              const attackerVal = PIECE_VALUE[capMv.piece] || 0;
              if (!recaps.length || lostValue - attackerVal >= 2) {
                return 'hung_piece';
              }
            }
          }
        }
      }
    } catch (_) {
      /* ignore invalid FEN/UCI */
    }
  }

  if (phase === 'endgame') return 'endgame_error';
  if (phase === 'opening') return 'opening_blunder';

  // Missed tactical strike if engine's best move is a capture or check with large win drop.
  if (fenBefore && bestUci && bestUci.length >= 4 && winDrop >= 15) {
    try {
      const c = new Chess(fenBefore);
      const normBest = normalizeCastlingUci(fenBefore, bestUci);
      const bm = c.move({
        from: normBest.slice(0, 2),
        to: normBest.slice(2, 4),
        promotion: normBest[4] || undefined,
      });
      if (bm && (bm.captured || c.inCheck())) return 'missed_tactic';
    } catch (_) {
      /* ignore */
    }
  }

  return 'positional_blunder';
}

/**
 * Build a compact, cached per-game Coach analysis from a game record and an
 * array of position evaluations `rawPoints` (`rawPoints[0]` = start position,
 * `rawPoints[i]` = position after ply `i`, each `{ whiteCp, mate, bestUci }`).
 */
export function buildGameAnalysis(game, rawPoints, { source = 'stockfish', depth = 10 } = {}) {
  const sans = game.moves ? game.moves.split(' ').filter(Boolean) : [];
  if (!sans.length || !Array.isArray(rawPoints) || rawPoints.length < 2) return null;

  const chess = new Chess();
  const clockSpec = parseClockSpec(game.clock);
  const clks = Array.isArray(game.clks) ? game.clks : null;
  const myColor = game.color;

  const initPhase = () => ({ moves: 0, accSum: 0, cpLossSum: 0, blunders: 0, mistakes: 0 });
  const phases = { opening: initPhase(), middlegame: initPhase(), endgame: initPhase() };

  let moveCount = 0;
  let accSum = 0;
  let cpLossSum = 0;
  let blunders = 0;
  let mistakes = 0;
  let inaccuracies = 0;

  let peakCp = -Infinity;
  let minCp = Infinity;
  let peakWin = 0;
  let minWin = 100;
  let peakPly = 0;
  let firstThrowPly = 0;

  const clockSnaps = {};
  const issues = [];

  const recordEvalExtremes = (pt, ply) => {
    const myCp = myColor === 'w' ? pt.whiteCp : -pt.whiteCp;
    const wWin = cpToWinPercent(pt.whiteCp, pt.mate);
    const myWin = myColor === 'w' ? wWin : 100 - wWin;
    if (myCp > peakCp) {
      peakCp = myCp;
      peakPly = ply;
    }
    if (myCp < minCp) minCp = myCp;
    if (myWin > peakWin) peakWin = myWin;
    if (myWin < minWin) minWin = myWin;
  };

  recordEvalExtremes(rawPoints[0], 0);

  const limit = Math.min(sans.length, rawPoints.length - 1);
  for (let i = 0; i < limit; i++) {
    const ply = i + 1;
    const fenBefore = chess.fen();
    const phase = detectPhase(chess, ply);

    let mv;
    try {
      mv = chess.move(sans[i]);
    } catch (_) {
      break;
    }
    if (!mv) break;

    const playedUci = mv.from + mv.to + (mv.promotion || '');
    const before = rawPoints[i];
    const after = rawPoints[i + 1];
    recordEvalExtremes(after, ply);

    // Record clock snapshots at full moves 10, 20, 30.
    const moveNum = Math.ceil(ply / 2);
    if (clks && clks[i] !== null && clks[i] !== undefined && (moveNum === 10 || moveNum === 20 || moveNum === 30)) {
      if (!clockSnaps[moveNum]) clockSnaps[moveNum] = {};
      if (mv.color === myColor) clockSnaps[moveNum].mine = clks[i];
      else clockSnaps[moveNum].opp = clks[i];
    }

    if (mv.color !== myColor) continue;

    const cls = classifyReviewedMove(before, after, myColor, playedUci);
    moveCount++;
    accSum += cls.accuracy;
    cpLossSum += cls.cpLoss;
    const ph = phases[phase];
    ph.moves++;
    ph.accSum += cls.accuracy;
    ph.cpLossSum += cls.cpLoss;

    if (cls.kind === 'blunder') {
      blunders++;
      ph.blunders++;
    } else if (cls.kind === 'mistake') {
      mistakes++;
      ph.mistakes++;
    } else if (cls.kind === 'inaccuracy') {
      inaccuracies++;
    }

    // Track first moment a winning game slipped below +1.0.
    const myCpBefore = myColor === 'w' ? before.whiteCp : -before.whiteCp;
    const myCpAfter = myColor === 'w' ? after.whiteCp : -after.whiteCp;
    if (!firstThrowPly && myCpBefore >= 250 && myCpAfter < 100) {
      firstThrowPly = ply;
    }

    if (cls.kind === 'blunder' || cls.kind === 'mistake') {
      let clockLeft = null;
      let timeSpent = null;
      let clockPct = null;
      if (clks && clks[i] !== null && clks[i] !== undefined) {
        clockLeft = clks[i];
        const prevClk = i >= 2 ? clks[i - 2] : clockSpec?.initial ?? null;
        if (prevClk !== null && prevClk !== undefined) {
          timeSpent = Math.max(0, prevClk + (clockSpec?.inc || 0) - clockLeft);
        }
        if (clockSpec?.initial > 0) {
          clockPct = Number((clockLeft / clockSpec.initial).toFixed(3));
        }
      }

      const bestUci = before.bestUci ? normalizeCastlingUci(fenBefore, before.bestUci) : '';
      const bestSan = bestUci ? uciMoveToSan(fenBefore, bestUci) : '';
      const tag = classifyBlunderTag({
        fenBefore,
        playedUci,
        bestUci,
        beforeEval: before,
        afterEval: after,
        phase,
        moverColor: myColor,
        winDrop: cls.winDrop,
      });

      issues.push({
        gameId: game.id,
        ply,
        moveNum,
        color: myColor,
        fenBefore,
        playedSan: mv.san,
        playedUci,
        bestSan,
        bestUci,
        evalBeforeCp: before.whiteCp,
        evalBeforeMate: before.mate ?? null,
        evalAfterCp: after.whiteCp,
        evalAfterMate: after.mate ?? null,
        evalBeforeLabel: formatReviewScore(before.whiteCp, before.mate ?? null),
        evalAfterLabel: formatReviewScore(after.whiteCp, after.mate ?? null),
        winDrop: cls.winDrop,
        cpLoss: cls.cpLoss,
        kind: cls.kind,
        phase,
        tag,
        timeSpent,
        clockLeft,
        clockPct,
      });
    }
  }

  if (!moveCount) return null;

  // Keep up to 6 most severe issues per game so IndexedDB stays small.
  issues.sort((a, b) => b.winDrop - a.winDrop || a.ply - b.ply);

  return {
    id: game.id,
    src: source,
    depth,
    analyzedAt: Date.now(),
    moveCount,
    accuracy: Number((accSum / moveCount).toFixed(1)),
    acpl: Math.round(cpLossSum / moveCount),
    blunders,
    mistakes,
    inaccuracies,
    phases,
    peakCp: Number.isFinite(peakCp) ? Math.round(peakCp) : 0,
    minCp: Number.isFinite(minCp) ? Math.round(minCp) : 0,
    peakWin: Number(peakWin.toFixed(1)),
    minWin: Number(minWin.toFixed(1)),
    peakPly,
    firstThrowPly,
    clockSnaps,
    issues: issues.slice(0, 6),
  };
}

/**
 * Convert a Lichess game record that already carries server `evals` into a full
 * Coach analysis record without running local Stockfish.
 *
 * Lichess's `analysis[i]` is the eval AFTER ply `i+1`; when `analysis[i].b`
 * (`best`) is present, it is the best move BEFORE ply `i+1`.
 */
export function buildLichessGameAnalysis(game) {
  if (!Array.isArray(game?.evals) || !game.evals.length || !game.moves) return null;
  const sans = game.moves.split(' ').filter(Boolean);
  if (sans.length < 2) return null;

  const rawPoints = [{ whiteCp: 20, mate: null, bestUci: game.evals[0]?.b || '' }];
  const n = Math.min(sans.length, game.evals.length);
  for (let i = 0; i < n; i++) {
    const a = game.evals[i] || {};
    const isMate = typeof a.m === 'number';
    const whiteCp = isMate ? (a.m > 0 ? MATE_CP : -MATE_CP) : typeof a.c === 'number' ? a.c : rawPoints[i].whiteCp;
    const mate = isMate ? a.m : null;
    // Best move for the NEXT position is attached to game.evals[i + 1].b on Lichess.
    const nextBest = game.evals[i + 1]?.b || '';
    rawPoints.push({ whiteCp, mate, bestUci: nextBest });
  }
  return buildGameAnalysis(game, rawPoints, { source: 'lichess', depth: 20 });
}

/* ------------------------------------------------------------------ */
/* Phase 2: Aggregate Engine & Clock Diagnostics                       */
/* ------------------------------------------------------------------ */

/**
 * Aggregate cached analyses across the filtered games list.
 */
export function aggregateDiagnostics(games, analysesMap) {
  const analyzedPairs = [];
  let fromLichess = 0;
  let fromStockfish = 0;
  let clocked = 0;

  for (const g of games) {
    if (Array.isArray(g.clks) && g.clks.length) clocked++;
    const a = analysesMap?.get(g.id);
    if (!a) continue;
    analyzedPairs.push({ game: g, analysis: a });
    if (a.src === 'lichess') fromLichess++;
    else fromStockfish++;
  }

  const analyzed = analyzedPairs.length;
  const initAggPhase = (key) => ({
    id: key,
    label: PHASE_LABEL[key],
    moves: 0,
    accSum: 0,
    cpLossSum: 0,
    blunders: 0,
    mistakes: 0,
    gamesWithMoves: 0,
    issues: [],
  });
  const phaseAgg = {
    opening: initAggPhase('opening'),
    middlegame: initAggPhase('middlegame'),
    endgame: initAggPhase('endgame'),
  };

  let totalMoves = 0;
  let totalAccSum = 0;
  let totalCpLossSum = 0;
  let totalBlunders = 0;
  let totalMistakes = 0;
  let totalInaccuracies = 0;

  const conv = { reached: 0, wins: 0, draws: 0, losses: 0, thrownGames: [] };
  const res = { reached: 0, wins: 0, draws: 0, losses: 0 };
  const time = {
    impulsive: 0,
    timeTrouble: 0,
    normal: 0,
    totalClockedBlunders: 0,
    impulsiveIssues: [],
    timeTroubleIssues: [],
    clockSnaps: {
      10: { mineSum: 0, oppSum: 0, n: 0 },
      20: { mineSum: 0, oppSum: 0, n: 0 },
      30: { mineSum: 0, oppSum: 0, n: 0 },
    },
  };
  const taxMap = new Map();

  for (const { game, analysis } of analyzedPairs) {
    totalMoves += analysis.moveCount || 0;
    totalAccSum += (analysis.accuracy || 0) * (analysis.moveCount || 0);
    totalCpLossSum += (analysis.acpl || 0) * (analysis.moveCount || 0);
    totalBlunders += analysis.blunders || 0;
    totalMistakes += analysis.mistakes || 0;
    totalInaccuracies += analysis.inaccuracies || 0;

    for (const key of ['opening', 'middlegame', 'endgame']) {
      const p = analysis.phases?.[key];
      if (!p || !p.moves) continue;
      const dst = phaseAgg[key];
      dst.moves += p.moves;
      dst.accSum += p.accSum;
      dst.cpLossSum += p.cpLossSum;
      dst.blunders += p.blunders;
      dst.mistakes += p.mistakes;
      dst.gamesWithMoves++;
    }

    // Conversion: reached >= +2.5 (250 cp) or forced mate.
    if (analysis.peakCp >= 250) {
      conv.reached++;
      if (game.res === 1) conv.wins++;
      else if (game.res === 0.5) {
        conv.draws++;
        conv.thrownGames.push({ game, analysis });
      } else {
        conv.losses++;
        conv.thrownGames.push({ game, analysis });
      }
    }

    // Resilience: fell to <= -2.5 (-250 cp).
    if (analysis.minCp <= -250) {
      res.reached++;
      if (game.res === 1) res.wins++;
      else if (game.res === 0.5) res.draws++;
      else res.losses++;
    }

    // Clock snapshots at move 10 / 20 / 30.
    for (const mvNum of [10, 20, 30]) {
      const snap = analysis.clockSnaps?.[mvNum];
      if (snap && typeof snap.mine === 'number' && typeof snap.opp === 'number') {
        time.clockSnaps[mvNum].mineSum += snap.mine;
        time.clockSnaps[mvNum].oppSum += snap.opp;
        time.clockSnaps[mvNum].n++;
      }
    }

    const clockSpec = parseClockSpec(game.clock);
    for (const iss of analysis.issues || []) {
      const enriched = { ...iss, op: game.op, opR: game.opR, t: game.t, res: game.res, tc: game.tc };
      if (phaseAgg[iss.phase]) phaseAgg[iss.phase].issues.push(enriched);

      if (iss.kind === 'blunder') {
        const tag = iss.tag || 'positional_blunder';
        let entry = taxMap.get(tag);
        if (!entry) {
          entry = { tag, label: BLUNDER_TAG_LABEL[tag] || tag, count: 0, issues: [] };
          taxMap.set(tag, entry);
        }
        entry.count++;
        entry.issues.push(enriched);

        if (iss.clockLeft !== null && iss.clockLeft !== undefined) {
          time.totalClockedBlunders++;
          const init = clockSpec?.initial || 0;
          const isTimeTrouble =
            (iss.clockPct !== null && iss.clockPct <= 0.15) ||
            (init > 0 && iss.clockLeft <= Math.min(20, init * 0.15)) ||
            (init === 0 && iss.clockLeft <= 15);
          const isImpulsive =
            !isTimeTrouble &&
            iss.timeSpent !== null &&
            iss.timeSpent <= 3 &&
            iss.clockLeft >= Math.max(30, init * 0.25);

          if (isImpulsive) {
            time.impulsive++;
            time.impulsiveIssues.push(enriched);
          } else if (isTimeTrouble) {
            time.timeTrouble++;
            time.timeTroubleIssues.push(enriched);
          } else {
            time.normal++;
          }
        }
      }
    }
  }

  const phases = ['opening', 'middlegame', 'endgame'].map((k) => {
    const p = phaseAgg[k];
    p.issues.sort((a, b) => b.winDrop - a.winDrop || b.t - a.t);
    return {
      id: p.id,
      label: p.label,
      moves: p.moves,
      gamesWithMoves: p.gamesWithMoves,
      accuracy: p.moves ? Number((p.accSum / p.moves).toFixed(1)) : null,
      acpl: p.moves ? Math.round(p.cpLossSum / p.moves) : null,
      blunders: p.blunders,
      mistakes: p.mistakes,
      blundersPer10: p.gamesWithMoves ? Number(((p.blunders / p.gamesWithMoves) * 10).toFixed(1)) : 0,
      issues: p.issues.slice(0, 6),
    };
  });

  const rankedPhases = phases.filter((p) => p.moves >= 15 && p.accuracy !== null);
  rankedPhases.sort((a, b) => b.accuracy - a.accuracy);
  const strongestPhase = rankedPhases[0]?.id || null;
  const weakestPhase = rankedPhases.length >= 2 ? rankedPhases[rankedPhases.length - 1].id : null;

  conv.thrownGames.sort((a, b) => b.game.t - a.game.t);
  const analyzedScore = analyzed ? wdl(analyzedPairs.map((p) => p.game)).score : 0.5;
  // Recovering half of thrown winning points (1 pt per thrown loss, 0.5 pt per thrown draw).
  const thrownPts = conv.losses + conv.draws * 0.5;
  const convEloLeak = analyzed >= 5 && thrownPts > 0
    ? eloGainFromScoreDelta(analyzedScore, (thrownPts * 0.5) / analyzed)
    : 0;

  const taxonomy = [...taxMap.values()]
    .map((e) => ({
      ...e,
      issues: e.issues.sort((a, b) => b.winDrop - a.winDrop || b.t - a.t).slice(0, 8),
    }))
    .sort((a, b) => b.count - a.count);

  const clockByMove = [10, 20, 30]
    .map((mv) => {
      const s = time.clockSnaps[mv];
      return {
        move: mv,
        n: s.n,
        mine: s.n ? Math.round(s.mineSum / s.n) : null,
        opp: s.n ? Math.round(s.oppSum / s.n) : null,
      };
    })
    .filter((r) => r.n >= 3);

  return {
    coverage: { total: games.length, analyzed, fromLichess, fromStockfish, clocked },
    overall: {
      accuracy: totalMoves ? Number((totalAccSum / totalMoves).toFixed(1)) : null,
      acpl: totalMoves ? Math.round(totalCpLossSum / totalMoves) : null,
      blunders: totalBlunders,
      mistakes: totalMistakes,
      inaccuracies: totalInaccuracies,
    },
    phases,
    strongestPhase,
    weakestPhase,
    conversion: {
      reached: conv.reached,
      wins: conv.wins,
      draws: conv.draws,
      losses: conv.losses,
      rate: conv.reached ? conv.wins / conv.reached : null,
      eloLeak: convEloLeak,
      thrownGames: conv.thrownGames.slice(0, 6),
    },
    resilience: {
      reached: res.reached,
      wins: res.wins,
      draws: res.draws,
      losses: res.losses,
      saveRate: res.reached ? (res.wins + res.draws) / res.reached : null,
    },
    time: {
      impulsive: time.impulsive,
      timeTrouble: time.timeTrouble,
      normal: time.normal,
      totalClockedBlunders: time.totalClockedBlunders,
      impulsiveShare: time.totalClockedBlunders ? time.impulsive / time.totalClockedBlunders : 0,
      timeTroubleShare: time.totalClockedBlunders ? time.timeTrouble / time.totalClockedBlunders : 0,
      clockByMove,
    },
    taxonomy,
  };
}

/* ------------------------------------------------------------------ */
/* Unified "+100 Elo" Plan (Phase 1 + Phase 2 + Phase 3)               */
/* ------------------------------------------------------------------ */

const pct = (x) => `${Math.round((Number(x) || 0) * 100)}%`;

/**
 * Build the ranked "+100 Elo" gap checklist combining pure-stat leaks and
 * engine/clock diagnostics (when available). Every Elo estimate comes directly
 * from counterfactual score recovery on the player's actual games.
 */
export function buildEloPlan(games, diag, { cliffs = [], repertoireDiff = null } = {}) {
  const total = wdl(games);
  const rc = ratingContext(games);
  const tcs = byTimeControl(games);
  const mainTc = tcs.find((r) => r.rating) || tcs[0] || null;
  const currentRating = mainTc?.rating || rc.own || null;
  const targetRating = currentRating ? currentRating + 100 : null;
  const neededGainPct = Math.round((targetScoreForEloGain(100) - 0.5) * 100); // 14

  const items = [];
  if (total.n < 15) {
    return { currentRating, targetRating, mainTc, neededGainPct, total, items };
  }

  // 1. Engine: Thrown winning positions (highest ROI when available).
  if (diag?.conversion?.reached >= 4 && diag.conversion.eloLeak >= 5) {
    const c = diag.conversion;
    items.push({
      id: 'thrown-wins',
      phase: 'Engine',
      title: `Convert winning positions (${c.losses} lost, ${c.draws} drawn from ≥ +2.5)`,
      detail: `You won ${c.wins}/${c.reached} (${pct(c.rate)}) games where you reached +2.5 or better. Converting half the slips recovers ~${c.eloLeak} Elo.`,
      elo: c.eloLeak,
      action: { type: 'coach-sub', sub: 'diagnostics' },
      actionLabel: 'Diagnostics',
    });
  }

  // 2. Engine + Clocks: Impulsive blunders.
  if (diag?.time?.totalClockedBlunders >= 5 && diag.time.impulsive >= 3 && diag.time.impulsiveShare >= 0.25) {
    const t = diag.time;
    const estElo = Math.min(35, Math.max(8, Math.round((t.impulsive / Math.max(10, diag.coverage.analyzed)) * 35)));
    items.push({
      id: 'impulsive-blunders',
      phase: 'Clocks',
      title: `Pause before forcing moves (${t.impulsive} impulsive blunders)`,
      detail: `${pct(t.impulsiveShare)} of your clocked blunders took ≤ 3s while you still had ample clock left.`,
      elo: estElo,
      action: { type: 'coach-sub', sub: 'diagnostics' },
      actionLabel: 'Clock split',
    });
  }

  // 3. Engine: Weakest game phase (if clearly trailing the strongest phase).
  if (diag?.weakestPhase && diag?.strongestPhase) {
    const weak = diag.phases.find((p) => p.id === diag.weakestPhase);
    const strong = diag.phases.find((p) => p.id === diag.strongestPhase);
    if (weak && strong && strong.accuracy - weak.accuracy >= 6) {
      const estElo = Math.min(32, Math.max(8, Math.round((strong.accuracy - weak.accuracy) * 1.4)));
      items.push({
        id: `phase-${weak.id}`,
        phase: 'Engine',
        title: `Shore up ${weak.label.toLowerCase()} play (${weak.accuracy}% vs ${strong.accuracy}% in ${strong.label.toLowerCase()})`,
        detail: `${weak.acpl} ACPL and ${weak.blundersPer10} blunders per 10 games in ${weak.label.toLowerCase()} positions.`,
        elo: estElo,
        action: { type: 'coach-sub', sub: 'drills' },
        actionLabel: 'Drill mistakes',
      });
    }
  }

  // 4. Phase 1: Opening cliff moves (top 2 highest Elo-impact leaks).
  for (const c of cliffs.slice(0, 2)) {
    if (c.eloImpact < 3) continue;
    const side = c.color === 'w' ? 'White' : 'Black';
    const moveNum = Math.floor(c.ply / 2) + 1;
    const moveLbl = `${moveNum}${c.color === 'w' ? '.' : '...'}${c.playedSan}`;
    items.push({
      id: `cliff-${c.color}-${c.childPrefix}`,
      phase: 'Opening',
      title: `Fix ${moveLbl} as ${side}${c.opening ? ` (${c.opening.split(':')[0]})` : ''}`,
      detail: `${pct(c.score)} over ${c.n} games vs ${pct(c.colorBase)} baseline as ${side}. Compare against +100 Elo players.`,
      elo: c.eloImpact,
      action: { type: 'benchmark', cliffPrefix: c.childPrefix },
      actionLabel: 'Benchmark',
    });
  }

  // 5. Phase 1: Tilt after a loss.
  const h = habits(games);
  if (h.afterLoss.n >= 20 && h.afterWin.n >= 20) {
    const gap = h.afterWin.score - h.afterLoss.score;
    if (gap >= 0.04) {
      const deltaScore = (h.afterLoss.n / total.n) * gap;
      const elo = eloGainFromScoreDelta(total.score, deltaScore);
      if (elo >= 4) {
        items.push({
          id: 'tilt-after-loss',
          phase: 'Habits',
          title: `Take a short break after losses (${pct(h.afterLoss.score)} vs ${pct(h.afterWin.score)} after wins)`,
          detail: `${h.afterLoss.n} games played immediately after a loss drop your score by ${Math.round(gap * 100)} pts.`,
          elo,
          action: { type: 'tab', tab: 'progress' },
          actionLabel: 'Habits',
        });
      }
    }
  }

  // 6. Phase 1: Session fatigue (Game 7+ or 11+).
  const early = h.bySessionPosition[0];
  const late = h.bySessionPosition[3];
  if (early.n >= 20 && late.n >= 15 && early.score - late.score >= 0.05) {
    const gap = early.score - late.score;
    const elo = eloGainFromScoreDelta(total.score, (late.n / total.n) * gap);
    if (elo >= 4) {
      items.push({
        id: 'session-fatigue',
        phase: 'Habits',
        title: `Cap long sessions (${pct(late.score)} from game 11+ vs ${pct(early.score)} in games 1–3)`,
        detail: `${late.n} games played deep into long sessions leak points to fatigue.`,
        elo,
        action: { type: 'tab', tab: 'progress' },
        actionLabel: 'Habits',
      });
    }
  }

  // 7. Phase 1: Losses on time.
  const terms = terminations(games);
  const timeLoss = terms.loss.find((r) => r.term === 'time');
  if (timeLoss && terms.totals.loss >= 20 && timeLoss.share >= 0.25) {
    // Saving one-third of time losses into draws/wins (0.5 pt each).
    const elo = eloGainFromScoreDelta(total.score, (timeLoss.n * 0.35 * 0.5) / total.n);
    if (elo >= 4) {
      items.push({
        id: 'time-losses',
        phase: 'Clock',
        title: `Cut losses on time (${pct(timeLoss.share)} of all losses)`,
        detail: `${timeLoss.n} games lost on the clock (avg ${Math.round(timeLoss.avgMoves)} moves). Saving a third adds ~${elo} Elo.`,
        elo,
        action: { type: 'games', outcome: 'loss', term: 'time' },
        actionLabel: 'See games',
      });
    }
  }

  // 8. Phase 1: Underperforming against weaker players.
  const vs = versusStrength(games);
  if (vs.weaker.n >= 15 && vs.weaker.expected - vs.weaker.score >= 0.04) {
    const gap = vs.weaker.expected - vs.weaker.score;
    const elo = eloGainFromScoreDelta(total.score, (vs.weaker.n / total.n) * gap);
    if (elo >= 4) {
      items.push({
        id: 'weaker-opponents',
        phase: 'Opponents',
        title: `Tighten up vs lower-rated players (${pct(vs.weaker.score)} vs ${pct(vs.weaker.expected)} expected)`,
        detail: `${vs.weaker.n} games against players 25+ pts below you — avoid overpressing and keep exchanges clean.`,
        elo,
        action: { type: 'tab', tab: 'opponents' },
        actionLabel: 'Opponents',
      });
    }
  }

  // 9. Phase 1: Repertoire memory slips (if user has a saved repertoire).
  if (repertoireDiff?.memorySlips?.length) {
    const top = repertoireDiff.memorySlips[0];
    if (top.n >= 3 && top.score < total.score) {
      const elo = Math.max(3, eloGainFromScoreDelta(total.score, ((total.score - top.score) * top.n) / total.n));
      items.push({
        id: `rep-slip-${top.prefix}-${top.playedSan}`,
        phase: 'Repertoire',
        title: `Stick to your prep: played ${top.playedSan} instead of ${top.expectedSans.join('/')}`,
        detail: `Happened ${top.n} times (${pct(top.score)} score). Review this line in Repertoire.`,
        elo,
        action: { type: 'explore', color: top.color, prefix: top.prefix },
        actionLabel: 'Explore',
      });
    }
  }

  items.sort((a, b) => b.elo - a.elo);
  return {
    currentRating,
    targetRating,
    mainTc,
    neededGainPct,
    total,
    items: items.slice(0, 7),
  };
}
