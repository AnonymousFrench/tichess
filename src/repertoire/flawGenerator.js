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
  triggerType = 'user_move',
  oppMove = null,
}) {
  const c = color === 'b' ? 'b' : 'w';
  const oppColor = c === 'w' ? 'b' : 'w';
  const oppWord = c === 'w' ? 'Black' : 'White';
  const isOppReply = triggerType === 'opponent_reply';
  const resolvedFlaw = isOppReply ? null : resolveMoveDetails(fen, flawedUci || flawedSan);
  const fUci = isOppReply ? '' : resolvedFlaw?.uci || normalizeCastlingUci(fen, flawedUci || '');
  const fSan = isOppReply ? '' : resolvedFlaw?.san || flawedSan || fUci;
  const moveLabel = isOppReply
    ? formatMoveLabel(oppMove?.ply ?? Math.max(0, ply - 1), oppColor, oppMove?.san || flawedSan)
    : formatMoveLabel(ply, c, fSan);

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

  if (isOppReply) {
    kind = 'opponent_reply';
    badge = 'Tough opponent reply';
    tone = 'cy';
    recommendedMode = 'vs_opponent';
    headline = `How to meet ${moveLabel} (${scorePct}% across ${total} game${total === 1 ? '' : 's'})`;
    explanation = `${moveLabel} is ${oppWord}'s move — you scored ${scorePct}% when facing it${
      bestLine ? `, even though the position is ${bestEvLabel} after ${bestLabel}` : ''
    }. Pick your main response below (such as ${altRefLabel}${altRefEv && altRefEv !== '—' ? ` · ${altRefEv}` : ''}) to build a focused repertoire against ${moveLabel}.`;
    whyDistinction = `Because ${moveLabel} is ${oppWord}'s reply, this leak is about your follow-up preparation after ${moveLabel} (you can also step back 1 move in Explorer to check whether your previous move itself was weak or sound).`;
  } else if (cpDrop !== null) {
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
    ? isOppReply
      ? `Small sample (${total} game${total === 1 ? '' : 's'}): even with ${total} games, preparing a clean reply against ${moveLabel} takes 2 minutes and stops repeat surprises.`
      : `Small sample (${total} game${total === 1 ? '' : 's'}): don't assume a move is bad from ${total} results alone — use the engine verdict above to decide whether to switch or repair.`
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

function matchesPrefixHeuristic(sans, prefixSans) {
  if (!Array.isArray(prefixSans) || prefixSans.length < 2) return true;
  if (sans.length < prefixSans.length) return false;
  // Exact prefix match (handles 95%+ of games immediately)
  let exact = true;
  for (let i = 0; i < prefixSans.length; i++) {
    if (sans[i] !== prefixSans[i]) {
      exact = false;
      break;
    }
  }
  if (exact) return true;
  // Transposition-tolerant check: at least 75% of prefix moves must appear in the opening window
  const windowSet = new Set(sans.slice(0, prefixSans.length + 6));
  let hits = 0;
  for (const s of prefixSans) {
    if (windowSet.has(s)) hits++;
  }
  return hits >= Math.ceil(prefixSans.length * 0.75);
}

function iterPersonalGameMoves(games, userColor, maxPlies = 28, prefixSans = []) {
  const color = userColor === 'b' ? 'b' : 'w';
  const seen = new Set();
  const parsed = [];

  for (const g of games || []) {
    let sans = null;
    let res = 0.5; // 1 = user win, 0.5 = draw, 0 = user loss
    let gameColor = color;
    let key = '';

    if (typeof g?.moves === 'string' && g.moves.trim()) {
      if (g.color && g.color !== color) continue;
      gameColor = g.color || color;
      sans = g.moves.split(' ').filter(Boolean).slice(0, maxPlies);
      if (!matchesPrefixHeuristic(sans, prefixSans)) continue;
      res = g.res === 1 ? 1 : g.res === 0 ? 0 : 0.5;
      key = g.id ? `id:${g.id}` : `m:${gameColor}|${res}|${g.moves.slice(0, 120)}`;
    } else if (typeof g?.pgn === 'string' && g.pgn.trim()) {
      key = g.id ? `id:${g.id}` : '';
      if (key && seen.has(key)) continue;
      try {
        const p = new Chess();
        p.loadPgn(g.pgn, { strict: false });
        sans = p.history().slice(0, maxPlies);
        if (!matchesPrefixHeuristic(sans, prefixSans)) continue;
        if (g.winner === 'white') res = color === 'w' ? 1 : 0;
        else if (g.winner === 'black') res = color === 'b' ? 1 : 0;
        else res = 0.5;
        if (!key) key = `p:${color}|${res}|${sans.join(' ').slice(0, 120)}`;
      } catch (_) {
        continue;
      }
    }

    if (!sans?.length || gameColor !== color) continue;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    parsed.push({ sans, res });
  }

  return parsed;
}

/**
 * Single-pass personal game indexer that returns both opponent replies (`oppMap`)
 * and the user's own past moves (`userMap`), pre-filtered by `prefixSans` so
 * thousands of unrelated games cost < 1ms instead of blocking the UI thread.
 */
export function indexPersonalGames(games, userColor = 'w', { prefixSans = [], maxPlies = 28 } = {}) {
  const color = userColor === 'b' ? 'b' : 'w';
  const oppTurn = color === 'w' ? 'b' : 'w';
  const oppRaw = new Map();
  const userRaw = new Map();

  for (const { sans, res } of iterPersonalGameMoves(games, color, maxPlies, prefixSans)) {
    const userLost = res === 0;
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
      const uci = mv.from + mv.to + (mv.promotion || '');
      if (turn === oppTurn) {
        let byUci = oppRaw.get(nf);
        if (!byUci) {
          byUci = new Map();
          oppRaw.set(nf, byUci);
        }
        let rec = byUci.get(uci);
        if (!rec) {
          rec = { uci, san: mv.san, games: 0, losses: 0 };
          byUci.set(uci, rec);
        }
        rec.games += 1;
        if (userLost) rec.losses += 1;
      } else {
        let byUci = userRaw.get(nf);
        if (!byUci) {
          byUci = new Map();
          userRaw.set(nf, byUci);
        }
        let rec = byUci.get(uci);
        if (!rec) {
          rec = { uci, san: mv.san, games: 0, wins: 0, draws: 0, losses: 0 };
          byUci.set(uci, rec);
        }
        rec.games += 1;
        if (res === 1) rec.wins += 1;
        else if (res === 0) rec.losses += 1;
        else rec.draws += 1;
      }
    }
  }

  const oppMap = new Map();
  for (const [nf, byUci] of oppRaw) {
    oppMap.set(nf, [...byUci.values()]);
  }

  const userMap = new Map();
  for (const [nf, byUci] of userRaw) {
    const list = [...byUci.values()]
      .map((r) => ({
        ...r,
        scorePct: r.games ? Math.round(((r.wins + 0.5 * r.draws) / r.games) * 100) : 0,
      }))
      .sort((a, b) => b.losses - a.losses || b.games - a.games || a.scorePct - b.scorePct);
    userMap.set(nf, list);
  }

  return { oppMap, userMap };
}

/**
 * Index opponent replies from the user's own games (`Insights` records or
 * Studio Explorer `recentGames`) into `Map<normFen, Array<{uci, san, games, losses}>>`.
 */
export function buildPersonalOppMap(games, userColor = 'w', maxPlies = 28) {
  return indexPersonalGames(games, userColor, { maxPlies }).oppMap;
}

/**
 * Index the user's OWN moves across their games into
 * `Map<normFen, Array<{uci, san, games, wins, draws, losses, scorePct}>>`
 * so generated repertoires can explicitly point out what the player used to play wrong.
 */
export function buildPersonalUserMoveMap(games, userColor = 'w', maxPlies = 28) {
  return indexPersonalGames(games, userColor, { maxPlies }).userMap;
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

function runWorkerEval(worker, fen, { depth = 11, multipv = 4, movetime = 550, signal } = {}) {
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

    const finishWithCurrent = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const lines = [...pvMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v)
        .filter((v) => v.uci);
      resolve(lines);
    };

    const watchdog = setTimeout(() => {
      if (settled) return;
      try {
        worker.postMessage('stop');
      } catch (_) {}
      setTimeout(finishWithCurrent, 300);
    }, Math.max(1500, movetime + 2200));

    const cleanup = () => {
      clearTimeout(watchdog);
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
    worker.postMessage(movetime > 0 ? `go depth ${depth} movetime ${movetime}` : `go depth ${depth}`);
  });
}

/** Create a reusable cached Stockfish MultiPV session with `.evaluate`, `.evalMove`, and `.close`. */
export async function createStockfishSession({ multipv = 4 } = {}) {
  const worker = await createMultiPvWorker(multipv);
  const cache = new Map();

  async function evaluate(fen, { depth = 11, multipv: mpv = multipv, movetime = 550, signal } = {}) {
    const key = `${normalizeFen(fen)}|${depth}|${mpv}`;
    if (cache.has(key)) return cache.get(key);
    const res = await runWorkerEval(worker, fen, { depth, multipv: mpv, movetime, signal });
    cache.set(key, res);
    return res;
  }

  async function evalMove(fen, uci, { depth = 10, movetime = 450, signal } = {}) {
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
    const afterLines = await evaluate(det.fenAfter, { depth, multipv: 1, movetime, signal });
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

    const reqCtrl = new AbortController();
    const onOuterAbort = () => reqCtrl.abort();
    if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });
    const reqTimer = setTimeout(() => reqCtrl.abort(), 4500);

    try {
      const res = await fetch(url, {
        signal: reqCtrl.signal,
        headers,
        credentials: useProxy ? 'same-origin' : 'omit',
      });
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
      if (signal?.aborted) throw err;
      unavailableReason =
        err?.name === 'AbortError'
          ? 'Lichess Explorer timed out — finished remaining branches with Stockfish.'
          : 'Could not reach Lichess Explorer — using Stockfish lines.';
      return { status: 'error', reason: unavailableReason, poolLabel, totalGames: 0, moves: [] };
    } finally {
      clearTimeout(reqTimer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
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
  triggerType = 'user_move',
  oppMove = null,
  pool = 'peers',
  rating = 1500,
  tc = 'all',
  signal,
  sfSession: externalSfSession = null,
  evaluateFn,
  evalMoveFn,
  fetchExplorerFn,
}) {
  let ownedSfSession = null;
  let evalPos = evaluateFn || externalSfSession?.evaluate;
  let evalOne = evalMoveFn || externalSfSession?.evalMove;
  const explorer = fetchExplorerFn
    ? { fetchPosition: fetchExplorerFn, poolLabel: 'Explorer', bracketLabel: targetRatingBrackets(rating).label }
    : createExplorerFetcher({ pool, rating, tc });

  try {
    if (!evalPos) {
      ownedSfSession = await createStockfishSession({ multipv: 4 });
      evalPos = ownedSfSession.evaluate;
      evalOne = ownedSfSession.evalMove;
    }

    const [engineLines, expRes] = await Promise.all([
      evalPos(fen, { depth: 11, multipv: 4, movetime: 650, signal }),
      explorer.fetchPosition(fen, color, { signal }),
    ]);

    const isOppReply = triggerType === 'opponent_reply';
    const resolvedFlaw = isOppReply ? null : resolveMoveDetails(fen, flawedUci || flawedSan);
    const fUci = isOppReply ? '' : resolvedFlaw?.uci || normalizeCastlingUci(fen, flawedUci || '');
    const alreadyInMultiPv =
      !isOppReply &&
      (engineLines || []).some(
        (ln) => normalizeCastlingUci(fen, ln.uci).slice(0, 4) === fUci.slice(0, 4)
      );

    let flawedEval = null;
    if (!isOppReply && !alreadyInMultiPv && fUci && evalOne) {
      flawedEval = await evalOne(fen, fUci, { depth: 10, movetime: 450, signal });
    }

    const diagnosis = diagnoseFlawMove({
      fen,
      ply,
      color,
      flawedUci: fUci,
      flawedSan: isOppReply ? oppMove?.san || flawedSan : resolvedFlaw?.san || flawedSan,
      flawedStats,
      engineLines,
      flawedEval,
      peerMoves: expRes?.moves || [],
      peerBracketLabel: expRes?.poolLabel || explorer.poolLabel,
      triggerType,
      oppMove,
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
    if (ownedSfSession) ownedSfSession.close();
  }
}

/**
 * Compile a set of generated branches into a validated `tichess-repertoire` v1
 * snippet with coaching notes, `theory.alts`, and `warn` habit alerts.
 */
function formatHabitsSummary(habits) {
  if (!Array.isArray(habits) || !habits.length) return '';
  return habits
    .slice(0, 2)
    .map((h) => {
      const stats = [
        `${h.scorePct}%`,
        `${h.games}g`,
        h.losses > 0 ? `${h.losses}L` : '',
        h.evLabel ? `eval ${h.evLabel}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      return `${h.label} (${stats})`;
    })
    .join(' / ');
}

function computeFlawSectionName({
  sectionName = '',
  openingName = '',
  mode = 'replace',
  flawPly = 0,
  color = 'w',
  flawedSan = '',
  oppMove = null,
  anchorSan = '',
}) {
  const c = color === 'b' ? 'b' : 'w';
  const oppColor = c === 'w' ? 'b' : 'w';
  const flawLabel = formatMoveLabel(flawPly, c, flawedSan);
  const oppLabel = oppMove?.san
    ? formatMoveLabel(oppMove.ply ?? Math.max(0, flawPly - 1), oppColor, oppMove.san)
    : flawLabel;
  const anchorLabel = formatMoveLabel(flawPly, c, anchorSan);
  const shortOpening = (openingName || 'Opening').split(':')[0].trim().slice(0, 32);
  return (
    (sectionName || '').trim().slice(0, 60) ||
    (mode === 'vs_opponent'
      ? `Fix: ${shortOpening} (vs ${oppLabel})`
      : mode === 'repair'
        ? `Fix: ${shortOpening} (${flawLabel} follow-ups)`
        : `Fix: ${shortOpening} (${anchorLabel} vs ${flawLabel})`)
  ).slice(0, 60);
}

function formatFixedHabitsPlan(fixedHabits) {
  if (!Array.isArray(fixedHabits) || !fixedHabits.length) return '';
  const items = fixedHabits.slice(0, 3).map((h) => {
    const stats = [`${h.scorePct}%`, `${h.games}g`, h.losses > 0 ? `${h.losses}L` : ''].filter(Boolean).join(', ');
    return h.expectedLabel ? `${h.label} (${stats}) → ${h.expectedLabel}` : `${h.label} (${stats})`;
  });
  return `Fixes your old ${items.length > 1 ? 'habits' : 'habit'}: ${items.join('; ')}.`;
}

export function compileFlawRepertoire({
  prefixMoves = [],
  startFen = START_FEN,
  color = 'w',
  openingName = '',
  flawedUci = '',
  flawedSan = '',
  flawedStats = {},
  mode = 'replace',
  oppMove = null,
  anchorMove,
  anchorHabits = [],
  diagnosis = null,
  branches = [],
  theoryByNormFen = new Map(),
  positionHabitsByNormFen = new Map(),
  sectionName = '',
}) {
  const c = color === 'b' ? 'b' : 'w';
  const oppColor = c === 'w' ? 'b' : 'w';
  const flawPly = prefixMoves.length;
  const flawLabel = formatMoveLabel(flawPly, c, flawedSan);
  const oppLabel = oppMove?.san
    ? formatMoveLabel(oppMove.ply ?? Math.max(0, flawPly - 1), oppColor, oppMove.san)
    : flawLabel;
  const anchorLabel = formatMoveLabel(flawPly, c, anchorMove.san);
  const cleanSection = computeFlawSectionName({
    sectionName,
    openingName,
    mode,
    flawPly,
    color: c,
    flawedSan,
    oppMove,
    anchorSan: anchorMove.san,
  });

  const total = Number(flawedStats?.total) || 0;
  const scorePct =
    typeof flawedStats?.scorePct === 'number'
      ? Math.round(flawedStats.scorePct)
      : total > 0
        ? Math.round(
            (((Number(flawedStats?.wins) || 0) + 0.5 * (Number(flawedStats?.draws) || 0)) / total) * 100
          )
        : 0;

  const anchorHabitStr = formatHabitsSummary(anchorHabits);
  const anchorNote =
    mode === 'vs_opponent'
      ? `${anchorHabitStr ? `Against ${oppLabel}, you used to play ${anchorHabitStr}. ` : `Against ${oppLabel} (where you scored ${scorePct}% over ${total}g), `}Answer with ${anchorLabel}${
          anchorMove.evLabel ? ` (${anchorMove.evLabel})` : ''
        }${anchorMove.peerScore !== null && anchorMove.peerScore !== undefined ? ` — scores ${anchorMove.peerScore}% among stronger peers` : ''}.`
      : mode === 'repair'
        ? `${flawLabel} is objectively sound${diagnosis?.flawedMove?.evLabel ? ` (${diagnosis.flawedMove.evLabel})` : ''}. Your ${scorePct}% (${total}g) leak starts right after it — master the concrete follow-ups below.`
        : `You used to play ${flawLabel} here (${scorePct}% over ${total}g). Switch to ${anchorLabel}${
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
    const basePlan = idx === 0 ? anchorNote : br.summaryNote || anchorNote;
    const unmentionedHabits = (br.fixedHabits || []).filter(
      (h) => h?.label && !basePlan.includes(h.label)
    );
    const habitPlan = formatFixedHabitsPlan(unmentionedHabits);
    const lineNote = habitPlan ? `${basePlan} ${habitPlan}`.trim() : basePlan;
    return {
      name: `${anchorLabel} vs ${firstOppLabel}${secondOppLabel}${personalTag}`.slice(0, 72),
      note: lineNote,
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

  // Attach habit or opponent-reply warnings in `repertoire.warn`.
  if (mode === 'replace' && flawedUci && flawPly < (repertoire.lines[0]?.pos?.length || 0)) {
    const firstLn = repertoire.lines[0];
    const flawPosIdx = firstLn.pos[flawPly];
    const normFlawUci = normalizeCastlingUci(repertoire.pos[flawPosIdx]?.f || startFen, flawedUci);
    if (normFlawUci) {
      repertoire.warn[`${flawPosIdx}|${normFlawUci}`] =
        `Old habit: you played ${flawLabel} (${scorePct}% over ${total}g). Play ${anchorLabel} instead.`;
    }
    if (flawPly > 0) {
      const prevPosIdx = firstLn.pos[flawPly - 1];
      const prevOppUci = firstLn.uci[flawPly - 1];
      if (prevOppUci) {
        repertoire.warn[`${prevPosIdx}|${prevOppUci}`] =
          `Watch out: you used to play ${flawLabel} here (${scorePct}% over ${total}g) — play ${anchorLabel} instead.`;
      }
    }
  } else if (mode === 'vs_opponent' && flawPly > 0 && flawPly < (repertoire.lines[0]?.pos?.length || 0)) {
    const firstLn = repertoire.lines[0];
    const prevPosIdx = firstLn.pos[flawPly - 1];
    const prevOppUci = firstLn.uci[flawPly - 1];
    if (prevOppUci) {
      repertoire.warn[`${prevPosIdx}|${prevOppUci}`] = anchorHabitStr
        ? `Watch out: vs ${oppLabel} you used to play ${anchorHabitStr} — answer with ${anchorLabel}.`
        : `Watch out: ${oppLabel} has been tough (${scorePct}% over ${total}g) — answer with ${anchorLabel}.`;
    }
  }

  // Attach warnings for every wrong habit the player actually played along the generated lines.
  if (positionHabitsByNormFen?.size) {
    for (const ln of repertoire.lines) {
      for (let p = flawPly; p < ln.uci.length; p++) {
        const posIdx = ln.pos[p];
        const posNode = repertoire.pos[posIdx];
        if (!posNode?.f) continue;
        const entry = positionHabitsByNormFen.get(normalizeFen(posNode.f));
        if (!entry?.habits?.length) continue;

        const expectedUci = ln.uci[p];
        const expectedLabel = entry.expectedLabel || formatMoveLabel(p, c, ln.san[p]);

        for (const h of entry.habits.slice(0, 2)) {
          const normH = normalizeCastlingUci(posNode.f, h.uci);
          if (!normH || normH.slice(0, 4) === expectedUci.slice(0, 4)) continue;
          const key = `${posIdx}|${normH}`;
          if (!repertoire.warn[key]) {
            const lossTxt = h.losses > 0 ? `, ${h.losses}L` : '';
            repertoire.warn[key] =
              `Old habit: you played ${h.label} (${h.scorePct}% over ${h.games}g${lossTxt}). Play ${expectedLabel} instead.`;
          }
        }

        if (p > 0) {
          const prevPosIdx = ln.pos[p - 1];
          const prevOppUci = ln.uci[p - 1];
          const prevKey = `${prevPosIdx}|${prevOppUci}`;
          if (prevOppUci && !repertoire.warn[prevKey]) {
            const top = entry.habits[0];
            repertoire.warn[prevKey] =
              `You used to play ${top.label} here (${top.scorePct}% over ${top.games}g) — play ${expectedLabel} instead.`;
          }
        }
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
    fixedHabits: Array.isArray(br.fixedHabits) ? br.fixedHabits : [],
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
  oppMove = null,
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
  onLineReady,
  signal,
  sfSession: externalSfSession = null,
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

  // Index positions from OTHER repertoire sections so transpositions merge cleanly,
  // while NOT self-blocking when regenerating the same section or same prefix+anchor branch.
  const targetSectionName = computeFlawSectionName({
    sectionName,
    openingName,
    mode,
    flawPly: prefixMoves.length,
    color: c,
    flawedSan,
    oppMove,
    anchorSan: anchorDet.san,
  });
  const targetSecKey = targetSectionName.trim().toLowerCase();
  const existingRepFenSet = new Set();
  if (existingRepertoire?.pos?.length && existingRepertoire?.lines?.length) {
    const secNameById = new Map(
      (existingRepertoire.secs || []).map((s) => [s.id, (s.name || '').trim().toLowerCase()])
    );
    const branchPrefixUcis = [...prefixMoves.map((m) => m.uci), anchorDet.uci];
    for (const ln of existingRepertoire.lines) {
      if (ln.color !== c) continue;
      const lnSecName = secNameById.get(ln.sec) || '';
      if (targetSecKey && lnSecName === targetSecKey) continue;
      const isSameBranch =
        ln.uci.length >= branchPrefixUcis.length &&
        branchPrefixUcis.every((u, idx) => ln.uci[idx]?.slice(0, 4) === u.slice(0, 4));
      if (isSameBranch) continue;
      for (const pi of ln.pos || []) {
        const p = existingRepertoire.pos[pi];
        if (p?.f && p.e?.some((e) => e[3] & 1)) {
          existingRepFenSet.add(normalizeFen(p.f));
        }
      }
    }
  }
  existingRepFenSet.delete(normalizeFen(rootFen));
  existingRepFenSet.delete(normalizeFen(anchorDet.fenAfter));

  const prefixSans = prefixMoves.map((m) => m.san).filter(Boolean);
  const { oppMap: personalOppMap, userMap: personalUserMap } = indexPersonalGames(personalGames, c, {
    prefixSans,
    maxPlies: Math.max(24, prefixSans.length + preset.maxUserMoves * 2 + 4),
  });

  let ownedSfSession = null;
  let evalPos = evaluateFn || externalSfSession?.evaluate;
  const explorer = fetchExplorerFn
    ? { fetchPosition: fetchExplorerFn, poolLabel: 'Explorer' }
    : createExplorerFetcher({ pool, rating, tc });

  const theoryByNormFen = new Map();
  const positionHabitsByNormFen = new Map();
  let explorerCalls = 0;
  let engineCalls = 0;
  let explorerFallbackNote = '';

  const findWrongHabitsAt = (posFen, absPly, expectedUci, engineLines = []) => {
    const nf = normalizeFen(posFen);
    const played = personalUserMap.get(nf) || [];
    if (!played.length) return [];
    const exp4 = normalizeCastlingUci(posFen, expectedUci).slice(0, 4);
    const bestEngCp = engineLines?.length ? userPovCp(engineLines[0].whiteCp, c) : null;
    const engBy4 = new Map();
    for (const ln of engineLines || []) {
      if (ln?.uci) engBy4.set(normalizeCastlingUci(posFen, ln.uci).slice(0, 4), ln);
    }
    return played
      .filter((m) => {
        const u4 = normalizeCastlingUci(posFen, m.uci).slice(0, 4);
        if (u4 === exp4) return false;
        return m.losses > 0 || m.scorePct < 50 || m.games >= 2;
      })
      .slice(0, 2)
      .map((m) => {
        const u4 = normalizeCastlingUci(posFen, m.uci).slice(0, 4);
        const eng = engBy4.get(u4);
        let evLabel = '';
        if (eng && bestEngCp !== null && bestEngCp - userPovCp(eng.whiteCp, c) >= 40) {
          evLabel = formatEvalPawns(eng.whiteCp, eng.mate);
        }
        return {
          ...m,
          label: formatMoveLabel(absPly, c, m.san),
          evLabel,
        };
      });
  };

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

  async function queryEngine(posFen, multipv = 3, { depth = 9, movetime = 400 } = {}) {
    engineCalls++;
    const lines = await evalPos(posFen, { depth, multipv, movetime, signal });
    recordTheory(posFen, lines);
    return lines;
  }

  try {
    if (!evalPos) {
      onProgress?.({
        step: 0,
        linesBuilt: 0,
        maxLines: preset.maxLines,
        totalEstimate: preset.maxLines * 2,
        label: 'Starting Stockfish engine…',
      });
      ownedSfSession = await createStockfishSession({ multipv: 3 });
      evalPos = ownedSfSession.evaluate;
    }

    onProgress?.({
      step: 1,
      linesBuilt: 0,
      maxLines: preset.maxLines,
      totalEstimate: preset.maxLines * 2,
      label: `Analyzing ${formatMoveLabel(prefixMoves.length, c, anchorDet.san)}…`,
    });

    // Store theory at the flaw root position as well.
    const rootLines = await queryEngine(rootFen, 4, { depth: 10, movetime: 550 });
    recordTheory(rootFen, rootLines, openingName);

    const anchorHabits =
      mode === 'repair'
        ? []
        : findWrongHabitsAt(rootFen, prefixMoves.length, anchorDet.uci, rootLines);
    if (anchorHabits.length) {
      positionHabitsByNormFen.set(normalizeFen(rootFen), {
        expectedLabel: formatMoveLabel(prefixMoves.length, c, anchorDet.san),
        habits: anchorHabits,
      });
    }

    const anchorStep = {
      san: anchorDet.san,
      uci: anchorDet.uci,
      fen: anchorDet.fenAfter,
      color: c,
      comment: '',
    };

    const branches = [];
    const flawPly = prefixMoves.length;
    const pushBranch = (br) => {
      branches.push(br);
      if (onLineReady) {
        const movesText = br.moves
          .map((m, mi) => {
            const absPly = flawPly + mi;
            return absPly % 2 === 0
              ? `${Math.floor(absPly / 2) + 1}.${m.san}`
              : mi === 0
                ? `${Math.floor(absPly / 2) + 1}...${m.san}`
                : m.san;
          })
          .join(' ');
        onLineReady(
          {
            index: branches.length - 1,
            movesText,
            oppSharePct: br.firstOppShare ? Math.round(br.firstOppShare * 100) : null,
            personalLosses: br.personalLosses || 0,
            fixedHabits: br.fixedHabits || [],
            stoppedBy: br.stoppedBy || 'depth',
          },
          branches.length,
          preset.maxLines
        );
      }
    };

    async function expandFromOpponentTurn(curFen, pathMoves, userMovesSoFar, meta) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const chess = new Chess(curFen);
      if (chess.isGameOver() || userMovesSoFar >= preset.maxUserMoves || branches.length >= preset.maxLines) {
        pushBranch({
          moves: pathMoves,
          firstOppShare: meta.firstOppShare,
          personalLosses: meta.personalLosses,
          personalGames: meta.personalGames,
          fixedHabits: meta.fixedHabits || [],
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
        pushBranch({
          moves: pathMoves,
          firstOppShare: meta.firstOppShare,
          personalLosses: meta.personalLosses,
          personalGames: meta.personalGames,
          fixedHabits: meta.fixedHabits || [],
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
          linesBuilt: branches.length,
          maxLines: preset.maxLines,
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
          pushBranch({
            moves: [...pathMoves, oppStep],
            firstOppShare: meta.firstOppShare ?? opp.share,
            personalLosses: branchPersonalLosses,
            personalGames: branchPersonalGames,
            fixedHabits: meta.fixedHabits || [],
            summaryNote: meta.summaryNote,
            stoppedBy: 'gameover',
          });
          continue;
        }

        // Stop if this position already exists in another saved repertoire section (clean transposition!).
        if (existingRepFenSet.has(afterOppNf)) {
          pushBranch({
            moves: [...pathMoves, oppStep],
            firstOppShare: meta.firstOppShare ?? opp.share,
            personalLosses: branchPersonalLosses,
            personalGames: branchPersonalGames,
            fixedHabits: meta.fixedHabits || [],
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
          pushBranch({
            moves: [...pathMoves, oppStep],
            firstOppShare: meta.firstOppShare ?? opp.share,
            personalLosses: branchPersonalLosses,
            personalGames: branchPersonalGames,
            fixedHabits: meta.fixedHabits || [],
            summaryNote: meta.summaryNote,
            stoppedBy: 'leaf',
          });
          continue;
        }

        const replyDet = resolveMoveDetails(oppDet.fenAfter, bestReply.uci);
        if (!replyDet) continue;

        const userPly = nextPly + 1;
        const replyLabel = formatMoveLabel(userPly, c, replyDet.san);
        const wrongHabits = findWrongHabitsAt(oppDet.fenAfter, userPly, replyDet.uci, userEng);
        if (wrongHabits.length && !positionHabitsByNormFen.has(afterOppNf)) {
          positionHabitsByNormFen.set(afterOppNf, {
            expectedLabel: replyLabel,
            habits: wrongHabits,
          });
        }

        const oppRateStr = opp.share ? `${Math.round(opp.share * 100)}% of games` : '';
        const personalStr =
          opp.personalLosses > 0
            ? `beat you ${opp.personalLosses}×`
            : opp.personalGames > 0
              ? `faced ${opp.personalGames}×`
              : '';
        const evalBit = bestReply.whiteCp !== null ? ` (${formatEvalPawns(bestReply.whiteCp, bestReply.mate)})` : '';
        const peerBit =
          bestReply.peerScore !== null && bestReply.peerGames >= 10
            ? ` · ${bestReply.peerScore}% peer score`
            : '';
        const habitStr = formatHabitsSummary(wrongHabits);

        const whyParts = habitStr
          ? [
              `You used to play ${habitStr} here.`,
              `Play ${replyLabel}${evalBit}${peerBit} instead${
                personalStr ? ` — after ${oppDet.san} (${personalStr}${oppRateStr ? `, ${oppRateStr}` : ''})` : oppRateStr ? ` — after ${oppDet.san} (${oppRateStr})` : ''
              }.`,
            ]
          : [
              personalStr ? `Opponent played ${oppDet.san} (${personalStr}${oppRateStr ? `, ${oppRateStr}` : ''}).` : oppRateStr ? `Common reply (${oppRateStr}).` : '',
              `Answer with ${replyDet.san}${evalBit}${peerBit}.`,
            ].filter(Boolean);

        const userStep = {
          san: replyDet.san,
          uci: replyDet.uci,
          fen: replyDet.fenAfter,
          color: c,
          comment: whyParts.join(' '),
        };

        const nextFixedHabits = [...(meta.fixedHabits || [])];
        if (wrongHabits.length) {
          const topH = wrongHabits[0];
          if (!nextFixedHabits.some((x) => x.label === topH.label)) {
            nextFixedHabits.push({
              label: topH.label,
              san: topH.san,
              expectedLabel: replyLabel,
              scorePct: topH.scorePct,
              games: topH.games,
              losses: topH.losses,
            });
          }
        }

        await expandFromOpponentTurn(
          replyDet.fenAfter,
          [...pathMoves, oppStep, userStep],
          userMovesSoFar + 1,
          {
            firstOppShare: meta.firstOppShare ?? opp.share,
            personalLosses: branchPersonalLosses,
            personalGames: branchPersonalGames,
            fixedHabits: nextFixedHabits,
            summaryNote: meta.summaryNote || whyParts.join(' '),
          }
        );
      }
    }

    const anchorExpectedLabel = formatMoveLabel(prefixMoves.length, c, anchorDet.san);
    const initialFixedHabits = anchorHabits.length
      ? [
          {
            label: anchorHabits[0].label,
            san: anchorHabits[0].san,
            expectedLabel: anchorExpectedLabel,
            scorePct: anchorHabits[0].scorePct,
            games: anchorHabits[0].games,
            losses: anchorHabits[0].losses,
          },
        ]
      : [];

    await expandFromOpponentTurn(anchorDet.fenAfter, [anchorStep], 1, {
      firstOppShare: null,
      personalLosses: 0,
      personalGames: 0,
      fixedHabits: initialFixedHabits,
      summaryNote: '',
    });

    if (!branches.length) {
      pushBranch({
        moves: [anchorStep],
        firstOppShare: null,
        personalLosses: 0,
        personalGames: 0,
        fixedHabits: initialFixedHabits,
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
      oppMove,
      anchorMove: {
        ...anchorMove,
        uci: anchorDet.uci,
        san: anchorDet.san,
      },
      anchorHabits,
      diagnosis,
      branches,
      theoryByNormFen,
      positionHabitsByNormFen,
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
    if (ownedSfSession) ownedSfSession.close();
  }
}
