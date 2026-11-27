/**
 * Flaw-to-Repertoire generator.
 *
 * Takes an identified opening flaw (from Studio's "My Games" / "Mine" Explorer
 * or Insights Coach's Opening Cliffs), diagnoses whether the move itself is
 * objectively weak or a sound move with weak follow-ups, expands a focused
 * branching repertoire using Lichess Explorer + local Stockfish 19 Lite WASM,
 * and compiles a valid `tichess-repertoire` v1 snippet ready to merge & drill.
 */
import { Chess } from 'chess.js';
import { START_FEN, normalizeFen } from '../state.js';
import { parseUciInfoLine, normalizeCastlingUci } from '../engines/uci.js';
import { MATE_CP } from '../engines/evalMath.js';
import { getCloudSyncState } from '../sync/cloudSync.js';
import { targetRatingBrackets, explorerSpeedsForTc } from '../insights/benchmark.js';
import { compileRepertoireFromSections } from './pgnImport.js';

const STOCKFISH_MT_URL = `${import.meta.env.BASE_URL}stockfish/stockfish-19-lite.js`;
const STOCKFISH_ST_URL = `${import.meta.env.BASE_URL}stockfish/stockfish-19-lite-single.js`;

export const FLAW_PRESETS = {
  quick: {
    key: 'quick',
    label: 'Quick',
    summary: '3 moves · ~5 lines',
    maxUserMoves: 3,
    maxLines: 5,
    maxOppReplies: 2,
    minOppShare: 0.14,
    minOppGames: 10,
    explorerBudget: 10,
  },
  standard: {
    key: 'standard',
    label: 'Standard',
    summary: '4 moves · ~10 lines',
    maxUserMoves: 4,
    maxLines: 10,
    maxOppReplies: 3,
    minOppShare: 0.11,
    minOppGames: 8,
    explorerBudget: 18,
  },
  deep: {
    key: 'deep',
    label: 'Deep',
    summary: '5 moves · ~16 lines',
    maxUserMoves: 5,
    maxLines: 16,
    maxOppReplies: 3,
    minOppShare: 0.08,
    minOppGames: 6,
    explorerBudget: 26,
  },
};

/* ------------------------------------------------------------------ */
/* Pure eval & notation helpers                                        */
/* ------------------------------------------------------------------ */

export function formatMoveLabel(ply, color, san) {
  const moveNum = Math.floor(ply / 2) + 1;
  return `${moveNum}${color === 'b' ? '...' : '.'}${san}`;
}

/** Format a White-POV evaluation as `+0.3`, `−0.8`, `0.0`, `#3`, `−#2`. */
export function formatEvalPawns(whiteCp, mate = null) {
  if (typeof mate === 'number' && mate !== 0) {
    return mate > 0 ? `#${mate}` : `−#${Math.abs(mate)}`;
  }
  const pawns = (Number(whiteCp) || 0) / 100;
  if (Math.abs(pawns) < 0.05) return '0.0';
  return `${pawns > 0 ? '+' : '−'}${Math.abs(pawns).toFixed(1)}`;
}

/** Convert White-POV score to `repertoire.theory[i].ev` format (pawns number or "#3"/"#-2"). */
export function toTheoryEv(whiteCp, mate = null) {
  if (typeof mate === 'number' && mate !== 0) {
    return mate > 0 ? `#${mate}` : `#-${Math.abs(mate)}`;
  }
  const pawns = Math.round(((Number(whiteCp) || 0) / 100) * 10) / 10;
  return Object.is(pawns, -0) ? 0 : pawns;
}

/** Convert a UCI PV list into SAN moves starting from `fen`. */
export function uciPvToSan(fen, uciPv, maxMoves = 6) {
  if (!fen || !Array.isArray(uciPv) || !uciPv.length) return [];
  let chess;
  try {
    chess = new Chess(fen);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const raw of uciPv.slice(0, maxMoves)) {
    const uci = normalizeCastlingUci(chess.fen(), String(raw || ''));
    if (uci.length < 4) break;
    let mv;
    try {
      mv = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4] || undefined,
      });
    } catch (_) {
      break;
    }
    if (!mv) break;
    out.push(mv.san);
  }
  return out;
}

function userPovCp(whiteCp, color) {
  const cp = Number(whiteCp) || 0;
  return color === 'b' ? -cp : cp;
}

function normalizeExplorerMoves(data, color) {
  const rawMoves = Array.isArray(data?.moves) ? data.moves : [];
  const totalGames =
    (Number(data?.white) || 0) + (Number(data?.draws) || 0) + (Number(data?.black) || 0) ||
    rawMoves.reduce((s, m) => s + (m.white || 0) + (m.draws || 0) + (m.black || 0), 0);

  const moves = rawMoves.map((m) => {
    const w = Number(m.white) || 0;
    const d = Number(m.draws) || 0;
    const b = Number(m.black) || 0;
    const games = w + d + b;
    const pts = color === 'b' ? b + d * 0.5 : w + d * 0.5;
    return {
      uci: String(m.uci || ''),
      san: String(m.san || ''),
      white: w,
      draws: d,
      black: b,
      games,
      share: totalGames ? games / totalGames : 0,
      score: games ? pts / games : 0,
      avgRating: Number(m.averageRating) || 0,
    };
  });
  return { totalGames, moves, opening: data?.opening || null };
}

function resolveMoveDetails(fen, uciOrSan) {
  try {
    const chess = new Chess(fen);
    let mv = null;
    const str = String(uciOrSan || '').trim();
    if (/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(str)) {
      const norm = normalizeCastlingUci(fen, str.toLowerCase());
      mv = chess.move({
        from: norm.slice(0, 2),
        to: norm.slice(2, 4),
        promotion: norm[4] || undefined,
      });
    } else if (str) {
      mv = chess.move(str);
    }
    if (!mv) return null;
    return {
      uci: mv.from + mv.to + (mv.promotion || ''),
      san: mv.san,
      fenAfter: chess.fen(),
      color: mv.color,
    };
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Pure diagnosis: Weak Move vs. Sound Move with Weak Follow-up        */
/* ------------------------------------------------------------------ */

/**
 * Diagnose why a move is flagged as a flaw by comparing Stockfish's evaluation
 * of the user's move against the engine's top choice and peer performance.
 */
export function diagnoseFlawMove({
  fen,
  ply = 0,
  color = 'w',
  flawedUci = '',
  flawedSan = '',
  flawedStats = {},
  engineLines = [],
  flawedEval = null,
  peerMoves = [],
  peerBracketLabel = '',
}) {
  const c = color === 'b' ? 'b' : 'w';
  const oppWord = c === 'w' ? 'Black' : 'White';
  const resolvedFlaw = resolveMoveDetails(fen, flawedUci || flawedSan);
  const fUci = resolvedFlaw?.uci || normalizeCastlingUci(fen, flawedUci || '');
  const fSan = resolvedFlaw?.san || flawedSan || fUci;
  const moveLabel = formatMoveLabel(ply, c, fSan);

  const total = Number(flawedStats?.total) || 0;
  const scorePct =
    typeof flawedStats?.scorePct === 'number'
      ? Math.round(flawedStats.scorePct)
      : total > 0
        ? Math.round(
            (((Number(flawedStats?.wins) || 0) + 0.5 * (Number(flawedStats?.draws) || 0)) / total) * 100
          )
        : 0;

  const normalizedEngine = (engineLines || [])
    .filter((ln) => ln && ln.uci)
    .map((ln) => {
      const uci = normalizeCastlingUci(fen, ln.uci);
      const det = ln.san ? { san: ln.san, uci } : resolveMoveDetails(fen, uci);
      return {
        uci,
        san: det?.san || ln.san || uci,
        whiteCp: Number(ln.whiteCp) || 0,
        mate: typeof ln.mate === 'number' ? ln.mate : null,
        pvSan: Array.isArray(ln.pvSan) && ln.pvSan.length ? ln.pvSan : uciPvToSan(fen, ln.pvUci || [uci]),
      };
    });

  const bestLine = normalizedEngine[0] || null;
  const bestLabel = bestLine ? formatMoveLabel(ply, c, bestLine.san) : '';
  const bestEvLabel = bestLine ? formatEvalPawns(bestLine.whiteCp, bestLine.mate) : '—';
  const bestUserCp = bestLine ? userPovCp(bestLine.whiteCp, c) : 0;

  // Match the flawed move's eval from either explicit `flawedEval` or Stockfish MultiPV.
  const flawEngineLine =
    normalizedEngine.find((ln) => ln.uci.slice(0, 4) === fUci.slice(0, 4)) ||
    (flawedEval
      ? {
          uci: fUci,
          san: fSan,
          whiteCp: Number(flawedEval.whiteCp) || 0,
          mate: typeof flawedEval.mate === 'number' ? flawedEval.mate : null,
          pvSan: Array.isArray(flawedEval.pvSan) ? flawedEval.pvSan : [fSan],
        }
      : null);

  const flawedUserCp = flawEngineLine ? userPovCp(flawEngineLine.whiteCp, c) : null;
  const flawedEvLabel = flawEngineLine ? formatEvalPawns(flawEngineLine.whiteCp, flawEngineLine.mate) : '—';
  const cpDrop =
    bestLine && flawedUserCp !== null ? Math.max(0, Math.round(bestUserCp - flawedUserCp)) : null;
  const dropPawns = cpDrop !== null ? (cpDrop / 100).toFixed(1) : null;

  // Build peer lookup map by normalized 4-char UCI.
  const peerByUci = new Map();
  for (const pm of peerMoves || []) {
    const u = normalizeCastlingUci(fen, pm.uci || '');
    if (u) peerByUci.set(u.slice(0, 4), pm);
  }
  const flawPeer = peerByUci.get(fUci.slice(0, 4)) || null;

  // Rank sound alternative candidates for "Switch move" mode.
  const candidateMap = new Map();
  for (const ln of normalizedEngine) {
    if (ln.uci.slice(0, 4) === fUci.slice(0, 4)) continue;
    const drop = Math.max(0, Math.round(bestUserCp - userPovCp(ln.whiteCp, c)));
    const peer = peerByUci.get(ln.uci.slice(0, 4)) || null;
    candidateMap.set(ln.uci.slice(0, 4), {
      uci: ln.uci,
      san: ln.san,
      label: formatMoveLabel(ply, c, ln.san),
      whiteCp: ln.whiteCp,
      mate: ln.mate,
      evLabel: formatEvalPawns(ln.whiteCp, ln.mate),
      cpDrop: drop,
      peerScore: peer ? Math.round((peer.score || 0) * 100) : null,
      peerShare: peer ? Math.round((peer.share || 0) * 100) : null,
      peerGames: peer?.games || 0,
      pvSan: ln.pvSan || [ln.san],
    });
  }
  // If no engine lines were available, fall back to top peer moves.
  if (!candidateMap.size) {
    for (const pm of (peerMoves || []).slice(0, 4)) {
      const det = resolveMoveDetails(fen, pm.uci || pm.san);
      if (!det || det.uci.slice(0, 4) === fUci.slice(0, 4)) continue;
      candidateMap.set(det.uci.slice(0, 4), {
        uci: det.uci,
        san: det.san,
        label: formatMoveLabel(ply, c, det.san),
        whiteCp: null,
        mate: null,
        evLabel: '—',
        cpDrop: null,
        peerScore: Math.round((pm.score || 0) * 100),
        peerShare: Math.round((pm.share || 0) * 100),
        peerGames: pm.games || 0,
        pvSan: [det.san],
      });
    }
  }

  const candidates = [...candidateMap.values()]
    .filter((cand) => cand.cpDrop === null || cand.cpDrop <= 80 || candidateMap.size <= 2)
    .sort((a, b) => {
      // Strongly prefer moves within 0.40 pawns of Stockfish #1, then blend peer score & frequency.
      const aSound = a.cpDrop === null || a.cpDrop <= 40 ? 1 : 0;
      const bSound = b.cpDrop === null || b.cpDrop <= 40 ? 1 : 0;
      if (aSound !== bSound) return bSound - aSound;
      const aScore =
        (a.peerScore !== null && a.peerGames >= 20 ? a.peerScore * 0.65 + Math.min(25, a.peerShare || 0) * 0.35 : 35) -
        (a.cpDrop || 0) * 0.35;
      const bScore =
        (b.peerScore !== null && b.peerGames >= 20 ? b.peerScore * 0.65 + Math.min(25, b.peerShare || 0) * 0.35 : 35) -
        (b.cpDrop || 0) * 0.35;
      return bScore - aScore;
    })
    .slice(0, 4);

  const topAlt = candidates[0] || null;
  const altRefLabel = topAlt?.label || bestLabel;
  const altRefEv = topAlt?.evLabel || bestEvLabel;

  let kind = 'unknown';
  let badge = 'Analysis needed';
  let tone = 'am';
  let headline = 'Reviewing opening choice';
  let recommendedMode = 'replace';
  let explanation = `You scored ${scorePct}% over ${total} games with ${moveLabel}. Pick an alternative to switch to, or build follow-up lines after ${moveLabel}.`;
  let whyDistinction =
    'A low win rate can mean either the move itself gives away an advantage (replace it), or the move is fine and the leak starts 1–3 moves later (repair the follow-ups).';

  const allowsMate =
    flawEngineLine &&
    typeof flawEngineLine.mate === 'number' &&
    (c === 'w' ? flawEngineLine.mate < 0 : flawEngineLine.mate > 0);
  const bestIsFlawed = bestLine && bestLine.uci.slice(0, 4) === fUci.slice(0, 4);

  if (cpDrop !== null) {
    if (allowsMate || cpDrop >= 60) {
      kind = 'weak_move';
      badge = 'Weak move';
      tone = 'ro';
      recommendedMode = 'replace';
      headline = `${moveLabel} is an objective mistake (${flawedEvLabel} vs ${bestLabel} ${bestEvLabel})`;
      explanation = `${moveLabel} drops ${dropPawns} pawns compared to ${bestLabel}${
        topAlt && topAlt.peerScore !== null && peerBracketLabel
          ? `, where ${peerBracketLabel} players score ${topAlt.peerScore}%`
          : ''
      }. Replacing ${moveLabel} fixes the root mistake instead of patching a bad position.`;
      whyDistinction = `Why replace: ${moveLabel} itself hurts your position immediately (−${dropPawns} pawns), so learning a stronger move here gives the cleanest rating gain.`;
    } else if (bestIsFlawed || (cpDrop <= 35 && flawedUserCp >= -65)) {
      kind = 'sound_followup';
      badge = 'Sound move · weak follow-up';
      tone = 'em';
      recommendedMode = 'repair';
      headline = `${moveLabel} is objectively sound (${flawedEvLabel}) — the leak is after it`;
      explanation = bestIsFlawed
        ? `${moveLabel} is actually Stockfish's #1 choice here (${flawedEvLabel}). Your ${scorePct}% score isn't because ${moveLabel} is a mistake — you're losing points on the follow-up moves after ${oppWord}'s replies.`
        : `${moveLabel} (${flawedEvLabel}) is objectively fine — within ${dropPawns} pawns of ${bestLabel} (${bestEvLabel})${
            flawPeer && flawPeer.games >= 20 && peerBracketLabel
              ? ` and scores ${Math.round(flawPeer.score * 100)}% at ${peerBracketLabel}`
              : ''
          }. Your ${scorePct}% score isn't because ${moveLabel} itself is a blunder; the leak happens in the moves right after it.`;
      whyDistinction = `Two good paths: keep ${moveLabel} and drill the exact answers to ${oppWord}'s main replies, or switch to ${altRefLabel} (${altRefEv}) if you prefer cleaner structures.`;
    } else {
      kind = 'dubious_move';
      badge = 'Slight inaccuracy';
      tone = 'am';
      recommendedMode = 'replace';
      headline = `${moveLabel} concedes ~${dropPawns} pawns (${flawedEvLabel} vs ${bestLabel} ${bestEvLabel})`;
      explanation = `${moveLabel} isn't a disaster, but it gives ${oppWord} an easier game than ${altRefLabel} (${altRefEv}). Switching to ${altRefLabel} gives you a healthier setup, or you can repair your follow-ups after ${moveLabel} if you like its style.`;
      whyDistinction = `Borderline move: switching to ${altRefLabel} is usually easier to play, while keeping ${moveLabel} works if you drill the concrete lines after it.`;
    }
  }

  const smallSample = total > 0 && total < 8;
  const sampleNote = smallSample
    ? `Small sample (${total} game${total === 1 ? '' : 's'}): don't assume a move is bad from ${total} results alone — use the engine verdict above to decide whether to switch or repair.`
    : '';

  return {
    kind,
    badge,
    tone,
    headline,
    explanation,
    whyDistinction,
    recommendedMode,
    flawedMove: {
      uci: fUci,
      san: fSan,
      label: moveLabel,
      whiteCp: flawEngineLine?.whiteCp ?? null,
      mate: flawEngineLine?.mate ?? null,
      evLabel: flawedEvLabel,
      cpDrop,
      peerScore: flawPeer ? Math.round((flawPeer.score || 0) * 100) : null,
      peerShare: flawPeer ? Math.round((flawPeer.share || 0) * 100) : null,
      peerGames: flawPeer?.games || 0,
      userScorePct: scorePct,
      userGames: total,
    },
    bestMove: bestLine
      ? {
          uci: bestLine.uci,
          san: bestLine.san,
          label: bestLabel,
          whiteCp: bestLine.whiteCp,
          mate: bestLine.mate,
          evLabel: bestEvLabel,
        }
      : null,
    candidates,
    smallSample,
    sampleNote,
  };
}

/* ------------------------------------------------------------------ */
/* Pure tree-expansion move selectors                                  */
/* ------------------------------------------------------------------ */

/**
 * Pick one clean repertoire move for the user's turn by combining Explorer
 * popularity/score with Stockfish soundness.
 */
export function pickBestUserMove({
  fen,
  explorerMoves = [],
  engineLines = [],
  color = 'w',
  avoidUci = '',
  maxCpDrop = 35,
}) {
  const avoid4 = avoidUci ? normalizeCastlingUci(fen, avoidUci).slice(0, 4) : '';
  const engineByUci = new Map();
  let bestUserCp = -Infinity;

  const cleanEngine = [];
  for (const ln of engineLines || []) {
    if (!ln?.uci) continue;
    const uci = normalizeCastlingUci(fen, ln.uci);
    if (avoid4 && uci.slice(0, 4) === avoid4) continue;
    const det = ln.san ? { uci, san: ln.san } : resolveMoveDetails(fen, uci);
    if (!det) continue;
    const uCp = userPovCp(ln.whiteCp, color);
    if (uCp > bestUserCp) bestUserCp = uCp;
    const item = {
      uci: det.uci,
      san: det.san,
      whiteCp: Number(ln.whiteCp) || 0,
      mate: typeof ln.mate === 'number' ? ln.mate : null,
      userCp: uCp,
      pvSan: Array.isArray(ln.pvSan) && ln.pvSan.length ? ln.pvSan : uciPvToSan(fen, ln.pvUci || [det.uci]),
    };
    cleanEngine.push(item);
    engineByUci.set(det.uci.slice(0, 4), item);
  }

  let bestPick = null;
  let bestScore = -Infinity;

  for (const m of explorerMoves || []) {
    if (!m?.uci || m.games < 5) continue;
    const uci = normalizeCastlingUci(fen, m.uci);
    if (avoid4 && uci.slice(0, 4) === avoid4) continue;
    const eng = engineByUci.get(uci.slice(0, 4));

    // When Stockfish lines are available, require the Explorer move to pass the soundness gate.
    if (cleanEngine.length) {
      if (!eng) continue;
      const drop = Math.max(0, bestUserCp - eng.userCp);
      if (drop > maxCpDrop) continue;
      const rankScore = m.score * 100 * 0.6 + Math.min(30, m.share * 100) * 0.4 - drop * 0.45;
      if (rankScore > bestScore) {
        bestScore = rankScore;
        bestPick = {
          uci: eng.uci,
          san: eng.san,
          whiteCp: eng.whiteCp,
          mate: eng.mate,
          peerScore: Math.round(m.score * 100),
          peerShare: Math.round(m.share * 100),
          peerGames: m.games,
          source: 'explorer+engine',
        };
      }
    } else {
      const det = resolveMoveDetails(fen, uci);
      if (!det) continue;
      const rankScore = m.score * 100 * 0.65 + Math.min(35, m.share * 100) * 0.35;
      if (rankScore > bestScore) {
        bestScore = rankScore;
        bestPick = {
          uci: det.uci,
          san: det.san,
          whiteCp: null,
          mate: null,
          peerScore: Math.round(m.score * 100),
          peerShare: Math.round(m.share * 100),
          peerGames: m.games,
          source: 'explorer',
        };
      }
    }
  }

  if (bestPick) return bestPick;

  if (cleanEngine.length) {
    const top = cleanEngine[0];
    return {
      uci: top.uci,
      san: top.san,
      whiteCp: top.whiteCp,
      mate: top.mate,
      peerScore: null,
      peerShare: null,
      peerGames: 0,
      source: 'engine',
    };
  }

  return null;
}

/**
 * Pick the top opponent replies to branch on:
 * 1. Replies that actually beat the user in their own games (if present),
 * 2. Top practical Explorer replies above `minShare`,
 * 3. Stockfish MultiPV fallback when Explorer has no data.
 */
export function pickOpponentReplies({
  fen,
  explorerMoves = [],
  personalOppMoves = [],
  engineLines = [],
  maxReplies = 3,
  minShare = 0.11,
  minGames = 8,
}) {
  const picked = [];
  const seen = new Set();

  const expByUci = new Map();
  for (const m of explorerMoves || []) {
    const u = normalizeCastlingUci(fen, m.uci || '');
    if (u) expByUci.set(u.slice(0, 4), { ...m, uci: u });
  }

  // 1. Prioritize opponent moves that actually hurt the user in their own games.
  const personalSorted = [...(personalOppMoves || [])]
    .filter((p) => p && (p.losses > 0 || p.games >= 2))
    .sort((a, b) => (b.losses || 0) - (a.losses || 0) || (b.games || 0) - (a.games || 0));

  for (const p of personalSorted.slice(0, Math.min(2, maxReplies))) {
    const det = resolveMoveDetails(fen, p.uci || p.san);
    if (!det) continue;
    const k = det.uci.slice(0, 4);
    if (seen.has(k)) continue;
    seen.add(k);
    const exp = expByUci.get(k);
    picked.push({
      uci: det.uci,
      san: det.san,
      share: exp?.share || 0,
      games: exp?.games || 0,
      personalGames: p.games || 0,
      personalLosses: p.losses || 0,
      source: 'personal',
    });
  }

  // 2. Fill remaining slots with top practical Explorer replies.
  for (const m of explorerMoves || []) {
    if (picked.length >= maxReplies) break;
    if (!m?.uci) continue;
    const meetsThreshold = m.share >= minShare && m.games >= minGames;
    if (!meetsThreshold && picked.length > 0) continue;
    if (m.games < 3) continue;
    const det = resolveMoveDetails(fen, m.uci);
    if (!det) continue;
    const k = det.uci.slice(0, 4);
    if (seen.has(k)) continue;
    seen.add(k);
    picked.push({
      uci: det.uci,
      san: det.san,
      share: m.share || 0,
      games: m.games || 0,
      personalGames: 0,
      personalLosses: 0,
      source: 'explorer',
    });
  }

  // 3. Fallback to Stockfish MultiPV opponent replies if Explorer was unavailable or empty.
  if (!picked.length) {
    for (const ln of (engineLines || []).slice(0, maxReplies)) {
      if (!ln?.uci) continue;
      const det = resolveMoveDetails(fen, ln.uci);
      if (!det) continue;
      const k = det.uci.slice(0, 4);
      if (seen.has(k)) continue;
      seen.add(k);
      picked.push({
        uci: det.uci,
        san: det.san,
        share: 0,
        games: 0,
        personalGames: 0,
        personalLosses: 0,
        source: 'engine',
      });
    }
  }

  return picked;
}

/* ------------------------------------------------------------------ */
/* Personal game indexing (extract replies that actually beat the user)*/
/* ------------------------------------------------------------------ */

/**
 * Index opponent replies from the user's own games (`Insights` records or
 * Studio Explorer `recentGames`) into `Map<normFen, Array<{uci, san, games, losses}>>`.
 */
export function buildPersonalOppMap(games, userColor = 'w', maxPlies = 28) {
  const color = userColor === 'b' ? 'b' : 'w';
  const oppTurn = color === 'w' ? 'b' : 'w';
  const map = new Map();

  for (const g of games || []) {
    let sans = null;
    let userLost = false;
    let gameColor = color;

    if (typeof g?.moves === 'string' && g.moves.trim()) {
      // Insights game record
      if (g.color && g.color !== color) continue;
      gameColor = g.color || color;
      sans = g.moves.split(' ').filter(Boolean).slice(0, maxPlies);
      userLost = g.res === 0;
    } else if (typeof g?.pgn === 'string' && g.pgn.trim()) {
      // Studio Explorer recentGame record
      try {
        const p = new Chess();
        p.loadPgn(g.pgn, { strict: false });
        sans = p.history().slice(0, maxPlies);
        if (g.winner === 'white') userLost = color === 'b';
        else if (g.winner === 'black') userLost = color === 'w';
      } catch (_) {
        continue;
      }
    }

    if (!sans?.length || gameColor !== color) continue;
    const chess = new Chess();
    for (let ply = 0; ply < sans.length; ply++) {
      const turn = chess.turn();
      const nf = normalizeFen(chess.fen());
      let mv;
      try {
        mv = chess.move(sans[ply]);
      } catch (_) {
        break;
      }
      if (!mv) break;
      if (turn === oppTurn) {
        const uci = mv.from + mv.to + (mv.promotion || '');
        let byUci = map.get(nf);
        if (!byUci) {
          byUci = new Map();
          map.set(nf, byUci);
        }
        let rec = byUci.get(uci);
        if (!rec) {
          rec = { uci, san: mv.san, games: 0, losses: 0 };
          byUci.set(uci, rec);
        }
        rec.games += 1;
        if (userLost) rec.losses += 1;
      }
    }
  }

  const out = new Map();
  for (const [nf, byUci] of map) {
    out.set(nf, [...byUci.values()]);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Browser Stockfish MultiPV evaluator & Explorer fetcher              */
/* ------------------------------------------------------------------ */

function canUseMt() {
  return (
    typeof crossOriginIsolated !== 'undefined' &&
    crossOriginIsolated === true &&
    typeof SharedArrayBuffer !== 'undefined'
  );
}

function bootStockfishWorker(url, threads, multipv, timeoutMs = 6000) {
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
        w.postMessage(`setoption name MultiPV value ${multipv}`);
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

async function createMultiPvWorker(multipv = 4) {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  const threads = canUseMt() ? Math.min(2, Math.max(1, cores - 1)) : 1;
  if (threads > 1) {
    try {
      return await bootStockfishWorker(STOCKFISH_MT_URL, threads, multipv, 5000);
    } catch (_) {
      /* fallback to single-threaded */
    }
  }
  return bootStockfishWorker(STOCKFISH_ST_URL, 1, multipv, 8000);
}

function runWorkerEval(worker, fen, { depth = 11, multipv = 4, signal } = {}) {
  let chess;
  try {
    chess = new Chess(fen);
  } catch (_) {
    return Promise.resolve([]);
  }
  if (chess.isGameOver()) return Promise.resolve([]);
  const flip = chess.turn() === 'b' ? -1 : 1;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const pvMap = new Map();
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
      reject(new Error(e?.message || 'Stockfish worker error'));
    };

    worker.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : '';
      if (!line) return;
      if (line.startsWith('info ') && line.includes(' score ') && line.includes(' pv ')) {
        const parsed = parseUciInfoLine(line);
        if (parsed && parsed.multipv >= 1 && parsed.multipv <= multipv && parsed.pv?.length) {
          const isMate = parsed.scoreType === 'mate';
          const signed = parsed.scoreVal * flip;
          const normFirst = normalizeCastlingUci(fen, parsed.pv[0]);
          const pvSan = uciPvToSan(fen, parsed.pv, 6);
          pvMap.set(parsed.multipv, {
            uci: normFirst,
            san: pvSan[0] || '',
            whiteCp: isMate ? (signed > 0 ? MATE_CP : -MATE_CP) : signed,
            mate: isMate ? signed : null,
            pvUci: parsed.pv.slice(0, 6),
            pvSan,
          });
        }
      } else if (line.startsWith('bestmove ')) {
        if (settled) return;
        settled = true;
        cleanup();
        const lines = [...pvMap.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, v]) => v)
          .filter((v) => v.uci);
        if (!lines.length) {
          const bm = line.split(/\s+/)[1];
          if (bm && bm !== '(none)') {
            const det = resolveMoveDetails(fen, bm);
            if (det) {
              lines.push({
                uci: det.uci,
                san: det.san,
                whiteCp: 0,
                mate: null,
                pvUci: [det.uci],
                pvSan: [det.san],
              });
            }
          }
        }
        resolve(lines);
      }
    };

    worker.postMessage(`setoption name MultiPV value ${multipv}`);
    worker.postMessage(`position fen ${fen}`);
    worker.postMessage(`go depth ${depth}`);
  });
}

/** Create a reusable cached Stockfish MultiPV session with `.evaluate`, `.evalMove`, and `.close`. */
export async function createStockfishSession({ multipv = 4 } = {}) {
  const worker = await createMultiPvWorker(multipv);
  const cache = new Map();

  async function evaluate(fen, { depth = 11, multipv: mpv = multipv, signal } = {}) {
    const key = `${normalizeFen(fen)}|${depth}|${mpv}`;
    if (cache.has(key)) return cache.get(key);
    const res = await runWorkerEval(worker, fen, { depth, multipv: mpv, signal });
    cache.set(key, res);
    return res;
  }

  async function evalMove(fen, uci, { depth = 10, signal } = {}) {
    const det = resolveMoveDetails(fen, uci);
    if (!det) return null;
    const afterChess = new Chess(det.fenAfter);
    if (afterChess.isCheckmate()) {
      const whiteWon = afterChess.turn() === 'b';
      return {
        uci: det.uci,
        san: det.san,
        whiteCp: whiteWon ? MATE_CP : -MATE_CP,
        mate: whiteWon ? 1 : -1,
        pvSan: [det.san],
      };
    }
    if (afterChess.isDraw()) {
      return { uci: det.uci, san: det.san, whiteCp: 0, mate: null, pvSan: [det.san] };
    }
    const afterLines = await evaluate(det.fenAfter, { depth, multipv: 1, signal });
    const top = afterLines[0];
    if (!top) return null;
    return {
      uci: det.uci,
      san: det.san,
      whiteCp: top.whiteCp,
      mate: top.mate,
      pvSan: [det.san, ...(top.pvSan || []).slice(0, 5)],
    };
  }

  function close() {
    try {
      worker.terminate();
    } catch (_) {}
  }

  return { evaluate, evalMove, close };
}

function getManualLichessToken() {
  try {
    return localStorage.getItem('cms_lichess_token') || '';
  } catch (_) {
    return '';
  }
}

const explorerSessionCache = new Map();

/**
 * Create a throttled, cached Lichess Explorer fetcher for either:
 * - `pool: 'peers'` (+100–200 Elo brackets via Lichess DB)
 * - `pool: 'masters'` (Masters OTB database)
 */
export function createExplorerFetcher({ pool = 'peers', rating = 1500, tc = 'all', throttleMs = 150 } = {}) {
  const { param: ratings, label: bracketLabel } = targetRatingBrackets(rating || 1500);
  const speeds = explorerSpeedsForTc(tc);
  const poolLabel = pool === 'masters' ? 'Masters OTB' : `Lichess ${bracketLabel}`;
  let unavailableReason = '';
  let lastCallAt = 0;

  async function fetchPosition(fen, color = 'w', { signal } = {}) {
    if (unavailableReason) {
      return { status: 'unavailable', reason: unavailableReason, poolLabel, totalGames: 0, moves: [] };
    }
    const key = `${pool}|${ratings}|${speeds}|${normalizeFen(fen)}`;
    if (explorerSessionCache.has(key)) {
      const raw = explorerSessionCache.get(key);
      return { status: 'ok', poolLabel, ...normalizeExplorerMoves(raw, color) };
    }

    const auth = getCloudSyncState();
    const token = getManualLichessToken();
    const useProxy = Boolean(auth.authenticated && auth.configured);

    let url;
    const headers = { Accept: 'application/json' };
    if (useProxy) {
      url =
        pool === 'masters'
          ? `/api/lichess/explorer?source=masters&fen=${encodeURIComponent(fen)}`
          : `/api/lichess/explorer?source=lichess&fen=${encodeURIComponent(fen)}&ratings=${encodeURIComponent(ratings)}&speeds=${encodeURIComponent(speeds)}`;
    } else if (token) {
      url =
        pool === 'masters'
          ? `https://explorer.lichess.org/masters?fen=${encodeURIComponent(fen)}&topGames=0&recentGames=0`
          : `https://explorer.lichess.org/lichess?fen=${encodeURIComponent(fen)}&ratings=${encodeURIComponent(ratings)}&speeds=${encodeURIComponent(speeds)}&topGames=0&recentGames=0`;
      headers.Authorization = `Bearer ${token}`;
    } else {
      unavailableReason = 'Sign in with Lichess (or add a token in Settings) to include Explorer frequencies — using Stockfish lines.';
      return { status: 'unavailable', reason: unavailableReason, poolLabel, totalGames: 0, moves: [] };
    }

    const wait = lastCallAt + throttleMs - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    lastCallAt = Date.now();

    try {
      const res = await fetch(url, { signal, headers, credentials: useProxy ? 'same-origin' : 'omit' });
      if (res.status === 401 || res.status === 403) {
        unavailableReason = 'Lichess Explorer auth unavailable — using Stockfish lines.';
        return { status: 'unavailable', reason: unavailableReason, poolLabel, totalGames: 0, moves: [] };
      }
      if (res.status === 429) {
        unavailableReason = 'Lichess Explorer rate-limited — finished remaining branches with Stockfish.';
        return { status: 'rate_limited', reason: unavailableReason, poolLabel, totalGames: 0, moves: [] };
      }
      if (!res.ok) {
        return { status: 'error', reason: `Explorer HTTP ${res.status}`, poolLabel, totalGames: 0, moves: [] };
      }
      const data = await res.json();
      explorerSessionCache.set(key, data);
      return { status: 'ok', poolLabel, ...normalizeExplorerMoves(data, color) };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      unavailableReason = 'Could not reach Lichess Explorer — using Stockfish lines.';
      return { status: 'error', reason: unavailableReason, poolLabel, totalGames: 0, moves: [] };
    }
  }

  return { fetchPosition, poolLabel, bracketLabel };
}

/* ------------------------------------------------------------------ */
/* High-level Diagnosis & Generation Orchestrators                     */
/* ------------------------------------------------------------------ */

/**
 * Step 1: Run Stockfish MultiPV + flaw-move eval + Lichess Explorer lookup
 * on the flaw position to diagnose Weak Move vs. Sound Follow-up.
 */
export async function diagnoseFlawPosition({
  fen,
  ply = 0,
  color = 'w',
  flawedUci = '',
  flawedSan = '',
  flawedStats = {},
  pool = 'peers',
  rating = 1500,
  tc = 'all',
  signal,
  evaluateFn,
  evalMoveFn,
  fetchExplorerFn,
}) {
  let sfSession = null;
  let evalPos = evaluateFn;
  let evalOne = evalMoveFn;
  const explorer = fetchExplorerFn
    ? { fetchPosition: fetchExplorerFn, poolLabel: 'Explorer', bracketLabel: targetRatingBrackets(rating).label }
    : createExplorerFetcher({ pool, rating, tc });

  try {
    if (!evalPos) {
      sfSession = await createStockfishSession({ multipv: 4 });
      evalPos = sfSession.evaluate;
      evalOne = sfSession.evalMove;
    }

    const [engineLines, expRes] = await Promise.all([
      evalPos(fen, { depth: 11, multipv: 4, signal }),
      explorer.fetchPosition(fen, color, { signal }),
    ]);

    const resolvedFlaw = resolveMoveDetails(fen, flawedUci || flawedSan);
    const fUci = resolvedFlaw?.uci || normalizeCastlingUci(fen, flawedUci || '');
    const alreadyInMultiPv = (engineLines || []).some(
      (ln) => normalizeCastlingUci(fen, ln.uci).slice(0, 4) === fUci.slice(0, 4)
    );

    let flawedEval = null;
    if (!alreadyInMultiPv && fUci && evalOne) {
      flawedEval = await evalOne(fen, fUci, { depth: 10, signal });
    }

    const diagnosis = diagnoseFlawMove({
      fen,
      ply,
      color,
      flawedUci: fUci,
      flawedSan: resolvedFlaw?.san || flawedSan,
      flawedStats,
      engineLines,
      flawedEval,
      peerMoves: expRes?.moves || [],
      peerBracketLabel: expRes?.poolLabel || explorer.poolLabel,
    });

    return {
      diagnosis,
      engineLines,
      explorerStatus: expRes?.status || 'ok',
      explorerNote: expRes?.reason || '',
      poolLabel: expRes?.poolLabel || explorer.poolLabel,
      openingFromExplorer: expRes?.opening?.name || '',
    };
  } finally {
    if (sfSession) sfSession.close();
  }
}

/**
 * Compile a set of generated branches into a validated `tichess-repertoire` v1
 * snippet with coaching notes, `theory.alts`, and `warn` habit alerts.
 */
export function compileFlawRepertoire({
  prefixMoves = [],
  startFen = START_FEN,
  color = 'w',
  openingName = '',
  flawedUci = '',
  flawedSan = '',
  flawedStats = {},
  mode = 'replace',
  anchorMove,
  diagnosis = null,
  branches = [],
  theoryByNormFen = new Map(),
  sectionName = '',
}) {
  const c = color === 'b' ? 'b' : 'w';
  const flawPly = prefixMoves.length;
  const flawLabel = formatMoveLabel(flawPly, c, flawedSan);
  const anchorLabel = formatMoveLabel(flawPly, c, anchorMove.san);
  const shortOpening = (openingName || 'Opening').split(':')[0].trim().slice(0, 32);
  const cleanSection =
    (sectionName || '').trim().slice(0, 60) ||
    (mode === 'repair'
      ? `Fix: ${shortOpening} (${flawLabel} follow-ups)`
      : `Fix: ${shortOpening} (${anchorLabel} vs ${flawLabel})`).slice(0, 60);

  const total = Number(flawedStats?.total) || 0;
  const scorePct =
    typeof flawedStats?.scorePct === 'number'
      ? Math.round(flawedStats.scorePct)
      : total > 0
        ? Math.round(
            (((Number(flawedStats?.wins) || 0) + 0.5 * (Number(flawedStats?.draws) || 0)) / total) * 100
          )
        : 0;

  const anchorNote =
    mode === 'repair'
      ? `${flawLabel} is objectively sound${diagnosis?.flawedMove?.evLabel ? ` (${diagnosis.flawedMove.evLabel})` : ''}. Your ${scorePct}% (${total}g) leak starts right after it — master the concrete follow-ups below.`
      : `You scored ${scorePct}% (${total}g) with ${flawLabel}. Switch to ${anchorLabel}${
          anchorMove.evLabel ? ` (${anchorMove.evLabel})` : ''
        }${anchorMove.peerScore !== null && anchorMove.peerScore !== undefined ? ` — scores ${anchorMove.peerScore}% among stronger peers` : ''}.`;

  const linesSpec = branches.map((br, idx) => {
    const combined = [
      ...prefixMoves.map((m) => ({
        san: m.san,
        uci: m.uci,
        fen: m.fen,
        color: m.color,
        comment: '',
      })),
      ...br.moves.map((m, mi) => ({
        san: m.san,
        uci: m.uci,
        fen: m.fen,
        color: m.color,
        comment: mi === 0 ? anchorNote : m.comment || '',
      })),
    ];

    const firstOpp = br.moves.find((m) => m.color !== c);
    const firstOppLabel = firstOpp
      ? formatMoveLabel(flawPly + 1, c === 'w' ? 'b' : 'w', firstOpp.san)
      : anchorLabel;
    const secondOpp = br.moves.filter((m) => m.color !== c)[1];
    const secondOppLabel = secondOpp
      ? ` · ${formatMoveLabel(flawPly + 3, c === 'w' ? 'b' : 'w', secondOpp.san)}`
      : '';

    const personalTag = br.personalLosses > 0 ? ` (lost ${br.personalLosses}×)` : '';
    return {
      name: `${anchorLabel} vs ${firstOppLabel}${secondOppLabel}${personalTag}`.slice(0, 72),
      note: idx === 0 ? anchorNote : br.summaryNote || anchorNote,
      alt: idx > 0,
      moves: combined,
    };
  });

  const repertoire = compileRepertoireFromSections([
    {
      name: cleanSection,
      color: c,
      startFen,
      lines: linesSpec,
    },
  ]);

  // Enrich `repertoire.theory` with Stockfish evaluations and MultiPV alts.
  for (const node of repertoire.pos) {
    const nf = normalizeFen(node.f);
    const th = theoryByNormFen?.get(nf);
    if (!th) continue;
    const idx = repertoire.theory.length;
    repertoire.theory.push({
      ev: th.ev ?? null,
      name: th.name || openingName || cleanSection,
      alts: Array.isArray(th.alts) ? th.alts : [],
    });
    node.t = idx;
  }

  // Attach habit warnings in `repertoire.warn`.
  if (mode === 'replace' && flawedUci && flawPly < (repertoire.lines[0]?.pos?.length || 0)) {
    const firstLn = repertoire.lines[0];
    const flawPosIdx = firstLn.pos[flawPly];
    const normFlawUci = normalizeCastlingUci(repertoire.pos[flawPosIdx]?.f || startFen, flawedUci);
    if (normFlawUci) {
      repertoire.warn[`${flawPosIdx}|${normFlawUci}`] =
        `Old habit: you scored ${scorePct}% (${total}g) with ${flawLabel}. Play ${anchorLabel} instead.`;
    }
    if (flawPly > 0) {
      const prevPosIdx = firstLn.pos[flawPly - 1];
      const prevOppUci = firstLn.uci[flawPly - 1];
      if (prevOppUci) {
        repertoire.warn[`${prevPosIdx}|${prevOppUci}`] =
          `Watch out: avoid your old habit ${flawLabel} (${scorePct}% over ${total}g) — play ${anchorLabel}.`;
      }
    }
  }

  // Collect card IDs strictly at and after the flaw ply so drilling jumps straight into the fix.
  const drillCardIds = [];
  const seenCards = new Set();
  for (const ln of repertoire.lines) {
    for (let p = flawPly; p < ln.uci.length; p++) {
      const edge = repertoire.pos[ln.pos[p]]?.e?.find((e) => e[0] === ln.uci[p]);
      if (edge?.[5] && repertoire.cards[edge[5]] && !seenCards.has(edge[5])) {
        seenCards.add(edge[5]);
        drillCardIds.push(edge[5]);
      }
    }
  }

  const linesPreview = branches.map((br, idx) => ({
    index: idx,
    name: repertoire.lines[idx]?.name || `Line ${idx + 1}`,
    movesText: br.moves
      .map((m, mi) => {
        const absPly = flawPly + mi;
        return absPly % 2 === 0 ? `${Math.floor(absPly / 2) + 1}.${m.san}` : mi === 0 ? `${Math.floor(absPly / 2) + 1}...${m.san}` : m.san;
      })
      .join(' '),
    oppSharePct: br.firstOppShare ? Math.round(br.firstOppShare * 100) : null,
    personalLosses: br.personalLosses || 0,
    personalGames: br.personalGames || 0,
    stoppedBy: br.stoppedBy || 'depth',
  }));

  return {
    repertoire,
    sectionName: cleanSection,
    drillCardIds,
    linesPreview,
    stats: {
      lines: repertoire.lines.length,
      cards: drillCardIds.length,
      totalCardsInSection: Object.keys(repertoire.cards).length,
    },
  };
}

/**
 * Step 2: Expand a focused branching repertoire from the chosen anchor move
 * (either the replacement move or the sound move being repaired).
 */
export async function generateFlawRepertoire({
  prefixMoves = [],
  startFen = START_FEN,
  fen,
  color = 'w',
  openingName = '',
  flawedUci = '',
  flawedSan = '',
  flawedStats = {},
  mode = 'replace',
  anchorMove,
  diagnosis = null,
  presetKey = 'standard',
  pool = 'peers',
  rating = 1500,
  tc = 'all',
  existingRepertoire = null,
  personalGames = [],
  sectionName = '',
  onProgress,
  signal,
  evaluateFn,
  fetchExplorerFn,
}) {
  const c = color === 'b' ? 'b' : 'w';
  const preset = FLAW_PRESETS[presetKey] || FLAW_PRESETS.standard;
  const rootFen = fen || (prefixMoves.length ? prefixMoves[prefixMoves.length - 1].fen : startFen);
  const anchorDet = resolveMoveDetails(rootFen, anchorMove?.uci || anchorMove?.san);
  if (!anchorDet) {
    throw new Error('Selected anchor move is not legal in this position.');
  }

  // Index positions already prepared in the user's existing repertoire (to avoid redundant expansion).
  const existingRepFenSet = new Set();
  if (existingRepertoire?.pos?.length) {
    for (const p of existingRepertoire.pos) {
      if (p?.f && p.e?.some((e) => e[3] & 1)) {
        existingRepFenSet.add(normalizeFen(p.f));
      }
    }
  }
  existingRepFenSet.delete(normalizeFen(rootFen));

  const personalOppMap = buildPersonalOppMap(personalGames, c);

  let sfSession = null;
  let evalPos = evaluateFn;
  const explorer = fetchExplorerFn
    ? { fetchPosition: fetchExplorerFn, poolLabel: 'Explorer' }
    : createExplorerFetcher({ pool, rating, tc });

  const theoryByNormFen = new Map();
  let explorerCalls = 0;
  let engineCalls = 0;
  let explorerFallbackNote = '';

  const recordTheory = (posFen, lines, nameHint = openingName) => {
    if (!Array.isArray(lines) || !lines.length) return;
    const nf = normalizeFen(posFen);
    if (theoryByNormFen.has(nf)) return;
    const top = lines[0];
    theoryByNormFen.set(nf, {
      ev: toTheoryEv(top.whiteCp, top.mate),
      name: nameHint || openingName || '',
      alts: lines.slice(0, 3).map((ln) => ({
        uci: ln.uci,
        san: ln.san,
        ev: toTheoryEv(ln.whiteCp, ln.mate),
        pv: Array.isArray(ln.pvSan) && ln.pvSan.length ? ln.pvSan : [ln.san],
      })),
    });
  };

  async function queryExplorer(posFen) {
    if (explorerCalls >= preset.explorerBudget) {
      return { status: 'budget', moves: [], totalGames: 0 };
    }
    explorerCalls++;
    const res = await explorer.fetchPosition(posFen, c, { signal });
    if (res?.status !== 'ok' && res?.reason && !explorerFallbackNote) {
      explorerFallbackNote = res.reason;
    }
    return res || { status: 'error', moves: [], totalGames: 0 };
  }

  async function queryEngine(posFen, multipv = 3) {
    engineCalls++;
    const lines = await evalPos(posFen, { depth: 10, multipv, signal });
    recordTheory(posFen, lines);
    return lines;
  }

  try {
    if (!evalPos) {
      sfSession = await createStockfishSession({ multipv: 3 });
      evalPos = sfSession.evaluate;
    }

    onProgress?.({
      step: 1,
      totalEstimate: preset.maxLines * 2,
      label: `Analyzing ${formatMoveLabel(prefixMoves.length, c, anchorDet.san)}…`,
    });

    // Store theory at the flaw root position as well.
    const rootLines = await queryEngine(rootFen, 4);
    recordTheory(rootFen, rootLines, openingName);

    const anchorStep = {
      san: anchorDet.san,
      uci: anchorDet.uci,
      fen: anchorDet.fenAfter,
      color: c,
      comment: '',
    };

    const branches = [];

    async function expandFromOpponentTurn(curFen, pathMoves, userMovesSoFar, meta) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const chess = new Chess(curFen);
      if (chess.isGameOver() || userMovesSoFar >= preset.maxUserMoves || branches.length >= preset.maxLines) {
        branches.push({
          moves: pathMoves,
          firstOppShare: meta.firstOppShare,
          personalLosses: meta.personalLosses,
          personalGames: meta.personalGames,
          summaryNote: meta.summaryNote,
          stoppedBy: chess.isGameOver() ? 'gameover' : 'depth',
        });
        return;
      }

      const nf = normalizeFen(curFen);
      const personalHere = personalOppMap.get(nf) || [];
      const expRes = await queryExplorer(curFen);
      let oppEngineLines = [];
      if (!expRes.moves?.length && !personalHere.length) {
        oppEngineLines = await queryEngine(curFen, preset.maxOppReplies);
      }

      const remainingBranchBudget = Math.max(1, preset.maxLines - branches.length);
      // Taper breadth deeper in the tree so lines stay crisp and readable.
      const depthReplyCap =
        userMovesSoFar === 1
          ? Math.min(preset.maxOppReplies, remainingBranchBudget)
          : userMovesSoFar === 2
            ? Math.min(2, remainingBranchBudget)
            : 1;

      const oppReplies = pickOpponentReplies({
        fen: curFen,
        explorerMoves: expRes.moves || [],
        personalOppMoves: personalHere,
        engineLines: oppEngineLines,
        maxReplies: Math.max(1, depthReplyCap),
        minShare: userMovesSoFar === 1 ? preset.minOppShare : Math.max(preset.minOppShare, 0.18),
        minGames: preset.minOppGames,
      });

      if (!oppReplies.length) {
        branches.push({
          moves: pathMoves,
          firstOppShare: meta.firstOppShare,
          personalLosses: meta.personalLosses,
          personalGames: meta.personalGames,
          summaryNote: meta.summaryNote,
          stoppedBy: 'leaf',
        });
        return;
      }

      for (const opp of oppReplies) {
        if (branches.length >= preset.maxLines) break;
        const oppDet = resolveMoveDetails(curFen, opp.uci);
        if (!oppDet) continue;

        const nextPly = prefixMoves.length + pathMoves.length;
        onProgress?.({
          step: Math.min(preset.maxLines * 2, engineCalls + explorerCalls),
          totalEstimate: preset.maxLines * 2,
          label: `Checking ${formatMoveLabel(nextPly, oppDet.color, oppDet.san)}…`,
        });

        const oppStep = {
          san: oppDet.san,
          uci: oppDet.uci,
          fen: oppDet.fenAfter,
          color: oppDet.color,
          comment: '',
        };

        const afterOppNf = normalizeFen(oppDet.fenAfter);
        const oppChess = new Chess(oppDet.fenAfter);
        const branchPersonalLosses = Math.max(meta.personalLosses || 0, opp.personalLosses || 0);
        const branchPersonalGames = Math.max(meta.personalGames || 0, opp.personalGames || 0);
        if (oppChess.isGameOver()) {
          branches.push({
            moves: [...pathMoves, oppStep],
            firstOppShare: meta.firstOppShare ?? opp.share,
            personalLosses: branchPersonalLosses,
            personalGames: branchPersonalGames,
            summaryNote: meta.summaryNote,
            stoppedBy: 'gameover',
          });
          continue;
        }

        // Stop if this position already exists in the user's saved repertoire (clean transposition!).
        if (existingRepFenSet.has(afterOppNf)) {
          branches.push({
            moves: [...pathMoves, oppStep],
            firstOppShare: meta.firstOppShare ?? opp.share,
            personalLosses: branchPersonalLosses,
            personalGames: branchPersonalGames,
            summaryNote: meta.summaryNote || 'Transposes into your existing repertoire.',
            stoppedBy: 'repertoire',
          });
          continue;
        }

        // User's turn: evaluate with Stockfish + Explorer to pick one strong, sound response.
        const [userEng, userExp] = await Promise.all([
          queryEngine(oppDet.fenAfter, 3),
          queryExplorer(oppDet.fenAfter),
        ]);

        const bestReply = pickBestUserMove({
          fen: oppDet.fenAfter,
          explorerMoves: userExp.moves || [],
          engineLines: userEng,
          color: c,
        });

        if (!bestReply) {
          branches.push({
            moves: [...pathMoves, oppStep],
            firstOppShare: meta.firstOppShare ?? opp.share,
            personalLosses: branchPersonalLosses,
            personalGames: branchPersonalGames,
            summaryNote: meta.summaryNote,
            stoppedBy: 'leaf',
          });
          continue;
        }

        const replyDet = resolveMoveDetails(oppDet.fenAfter, bestReply.uci);
        if (!replyDet) continue;

        const oppRateStr = opp.share ? `${Math.round(opp.share * 100)}% of games` : '';
        const personalStr =
          opp.personalLosses > 0
            ? `beat you ${opp.personalLosses}×`
            : opp.personalGames > 0
              ? `faced ${opp.personalGames}×`
              : '';
        const whyParts = [
          personalStr ? `Opponent played ${oppDet.san} (${personalStr}${oppRateStr ? `, ${oppRateStr}` : ''}).` : oppRateStr ? `Common reply (${oppRateStr}).` : '',
          `Answer with ${replyDet.san}${bestReply.whiteCp !== null ? ` (${formatEvalPawns(bestReply.whiteCp, bestReply.mate)})` : ''}${bestReply.peerScore !== null ? ` · ${bestReply.peerScore}% peer score` : ''}.`,
        ].filter(Boolean);

        const userStep = {
          san: replyDet.san,
          uci: replyDet.uci,
          fen: replyDet.fenAfter,
          color: c,
          comment: whyParts.join(' '),
        };

        await expandFromOpponentTurn(
          replyDet.fenAfter,
          [...pathMoves, oppStep, userStep],
          userMovesSoFar + 1,
          {
            firstOppShare: meta.firstOppShare ?? opp.share,
            personalLosses: branchPersonalLosses,
            personalGames: branchPersonalGames,
            summaryNote: meta.summaryNote || whyParts.join(' '),
          }
        );
      }
    }

    await expandFromOpponentTurn(anchorDet.fenAfter, [anchorStep], 1, {
      firstOppShare: null,
      personalLosses: 0,
      personalGames: 0,
      summaryNote: '',
    });

    if (!branches.length) {
      branches.push({
        moves: [anchorStep],
        firstOppShare: null,
        personalLosses: 0,
        personalGames: 0,
        summaryNote: '',
        stoppedBy: 'leaf',
      });
    }

    const compiled = compileFlawRepertoire({
      prefixMoves,
      startFen,
      color: c,
      openingName,
      flawedUci,
      flawedSan,
      flawedStats,
      mode,
      anchorMove: {
        ...anchorMove,
        uci: anchorDet.uci,
        san: anchorDet.san,
      },
      diagnosis,
      branches,
      theoryByNormFen,
      sectionName,
    });

    return {
      ...compiled,
      explorerCalls,
      engineCalls,
      explorerFallbackNote,
      poolLabel: explorer.poolLabel,
    };
  } finally {
    if (sfSession) sfSession.close();
  }
}
