/**
 * Pure HumanFish context extraction, formatting, and diagnostic helpers.
 * Free of DOM dependencies so it can be unit-tested cleanly with Vitest.
 */

export const DEFAULT_HF_ELO = 2750;
export const DEFAULT_HF_CLOCK_S = 3600;

export const TC_PRESETS = {
  classical: { tc_category: 'classical', tc_initial_s: 5400, tc_increment_s: 30, has_move40: true },
  rapid: { tc_category: 'rapid', tc_initial_s: 900, tc_increment_s: 10, has_move40: false },
  blitz: { tc_category: 'blitz', tc_initial_s: 180, tc_increment_s: 2, has_move40: false },
};

/**
 * Parse a PGN / broadcast clock string (`1:59:45`, `12:30`, `0:44.5`, or seconds) into seconds.
 */
export function parseClockSeconds(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    return Number(s);
  }
  const parts = s.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return null;
}

/**
 * Format seconds cleanly for HumanFish clock badges / What-If controls.
 */
export function formatShortClock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${h}h`;
  }
  if (s >= 120) return `${Math.round(s / 60)}m`;
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${String(rem).padStart(2, '0')}`;
  }
  return `${s}s`;
}

/**
 * Parse a PGN `[TimeControl "..."]` header (e.g. `40/5400+30:1800+30`, `900+10`, `180+2`)
 * into HumanFish time-control fields.
 */
export function parseTimeControlHeader(tcStr) {
  const raw = String(tcStr || '').trim();
  if (!raw || raw === '?' || raw === '-') {
    return { ...TC_PRESETS.classical };
  }

  // Match move-40 phase syntax like "40/5400+30:1800+30" or "40/7200:3600"
  const m40 = raw.match(/^(\d+)\/(\d+)(?:\+(\d+))?/);
  if (m40) {
    const moves = parseInt(m40[1], 10);
    const initial = parseInt(m40[2], 10);
    const inc = m40[3] ? parseInt(m40[3], 10) : 0;
    const category = initial >= 1800 ? 'classical' : initial >= 600 ? 'rapid' : 'blitz';
    return {
      tc_category: category,
      tc_initial_s: Math.max(60, initial),
      tc_increment_s: Math.max(0, inc),
      has_move40: moves >= 30 && moves <= 45,
    };
  }

  // Match standard "initial+inc" (seconds) or "initial" (seconds)
  const std = raw.match(/^(\d+)(?:\+(\d+))?$/);
  if (std) {
    const initial = parseInt(std[1], 10);
    const inc = std[2] ? parseInt(std[2], 10) : 0;
    const estTotal = initial + 40 * inc;
    const category = estTotal >= 1800 ? 'classical' : estTotal >= 600 ? 'rapid' : 'blitz';
    return {
      tc_category: category,
      tc_initial_s: Math.max(30, initial),
      tc_increment_s: Math.max(0, inc),
      has_move40: false,
    };
  }

  return { ...TC_PRESETS.classical };
}

/**
 * Extract HumanFish evaluation parameters (FEN, ply, Elos, clocks, time control)
 * from the active Studio tab without mutating it.
 */
export function extractGameContextFromTab(tab) {
  const fen = tab?.current?.fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const fenParts = fen.split(/\s+/);
  const side = fenParts[1] === 'b' ? 'b' : 'w';
  const fullmove = Math.max(1, parseInt(fenParts[5] || '1', 10) || 1);

  // Count plies from root when available, else infer from FEN fullmove/turn
  let plyFromTree = 0;
  let cur = tab?.current;
  while (cur && cur.parent) {
    plyFromTree++;
    cur = cur.parent;
  }
  const ply = plyFromTree > 0 ? plyFromTree : Math.max(0, (fullmove - 1) * 2 + (side === 'b' ? 1 : 0));

  const rawW = parseInt(tab?.meta?.whiteElo || '', 10);
  const rawB = parseInt(tab?.meta?.blackElo || '', 10);
  const hasGameElos = Number.isFinite(rawW) && rawW >= 1000 && Number.isFinite(rawB) && rawB >= 1000;
  const white_elo = Number.isFinite(rawW) && rawW >= 1000 ? rawW : DEFAULT_HF_ELO;
  const black_elo = Number.isFinite(rawB) && rawB >= 1000 ? rawB : DEFAULT_HF_ELO;

  // Walk up from current node to find latest clocks (matching renderPlayerClockBars)
  let wClkRaw = tab?.liveClocks?.white || '';
  let bClkRaw = tab?.liveClocks?.black || '';
  let foundW = false;
  let foundB = false;
  let node = tab?.current;
  while (node && node.parent && (!foundW || !foundB)) {
    if (node.clk) {
      if (node.color === 'w' && !foundW) {
        wClkRaw = node.clk;
        foundW = true;
      }
      if (node.color === 'b' && !foundB) {
        bClkRaw = node.clk;
        foundB = true;
      }
    }
    node = node.parent;
  }

  const parsedWClk = parseClockSeconds(wClkRaw);
  const parsedBClk = parseClockSeconds(bClkRaw);
  const hasGameClocks = parsedWClk !== null || parsedBClk !== null;
  const tc = parseTimeControlHeader(tab?.meta?.timeControl || '');
  const fallbackClk = tc.tc_category === 'blitz' ? 120 : tc.tc_category === 'rapid' ? 600 : DEFAULT_HF_CLOCK_S;

  return {
    fen,
    ply,
    white_elo,
    black_elo,
    clk_white_s: parsedWClk !== null ? parsedWClk : fallbackClk,
    clk_black_s: parsedBClk !== null ? parsedBClk : fallbackClk,
    ...tc,
    hasGameElos,
    hasGameClocks,
  };
}

/**
 * Resolve the browser endpoint URL for HumanFish evaluation.
 * Uses the built-in `/api/humanfish/evaluate` proxy by default, or a user-provided
 * local/self-hosted HumanFish FastAPI server (e.g. `http://localhost:8842`).
 */
export function resolveHumanfishEndpoint(customServerUrl = '') {
  const cleaned = String(customServerUrl || '').trim().replace(/\/+$/, '');
  if (!cleaned) return '/api/humanfish/evaluate';
  if (/\/api\/evaluate$/i.test(cleaned)) return cleaned;
  return `${cleaned}/api/evaluate`;
}

/**
 * Build a deterministic cache key for HumanFish evaluation requests.
 */
export function buildHumanfishCacheKey(params, endpoint = '') {
  return [
    endpoint,
    params.fen,
    Math.round(params.white_elo),
    Math.round(params.black_elo),
    Math.round(params.clk_white_s),
    Math.round(params.clk_black_s),
    params.tc_category,
    Math.round(params.tc_initial_s),
    Math.round(params.tc_increment_s),
    params.has_move40 ? 1 : 0,
  ].join('|');
}

/**
 * Analyze whether White and Black have mating material based on the FEN piece placement.
 * - A bare King (`count === 0`) can NEVER win under any chess rules (even on timeout).
 * - Dead-draw material combinations (`K vs K`, `K+B vs K`, `K+N vs K`, `K+B vs K+B` same-color)
 *   cannot be won by either side.
 */
export function analyzeMatingMaterial(fen) {
  const placement = String(fen || '').trim().split(/\s+/)[0] || '';
  const ranks = placement.split('/');
  if (ranks.length !== 8) {
    return { whiteCanWin: true, blackCanWin: true, deadDraw: false, reason: '' };
  }

  let wNonKing = 0;
  let bNonKing = 0;
  const wMinors = [];
  const bMinors = [];
  let wMajorOrPawn = 0;
  let bMajorOrPawn = 0;

  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of ranks[r]) {
      if (ch >= '1' && ch <= '8') {
        f += Number(ch);
        continue;
      }
      const sqColor = (r + f) % 2;
      if (ch === 'P' || ch === 'R' || ch === 'Q') {
        wNonKing++;
        wMajorOrPawn++;
      } else if (ch === 'N' || ch === 'B') {
        wNonKing++;
        wMinors.push({ type: ch, color: sqColor });
      } else if (ch === 'p' || ch === 'r' || ch === 'q') {
        bNonKing++;
        bMajorOrPawn++;
      } else if (ch === 'n' || ch === 'b') {
        bNonKing++;
        bMinors.push({ type: ch, color: sqColor });
      }
      f++;
    }
  }

  // Bare king can never win under any ruleset (including timeout)
  let whiteCanWin = wNonKing > 0;
  let blackCanWin = bNonKing > 0;
  let deadDraw = false;
  let reason = '';

  if (wMajorOrPawn === 0 && bMajorOrPawn === 0) {
    const wMinorCnt = wMinors.length;
    const bMinorCnt = bMinors.length;
    if (wMinorCnt === 0 && bMinorCnt === 0) {
      deadDraw = true;
      reason = 'Insufficient mating material (K vs K)';
    } else if (wMinorCnt + bMinorCnt === 1) {
      deadDraw = true;
      reason = 'Insufficient mating material';
    } else if (
      wMinorCnt === 1 &&
      bMinorCnt === 1 &&
      wMinors[0].type === 'B' &&
      bMinors[0].type === 'b' &&
      wMinors[0].color === bMinors[0].color
    ) {
      deadDraw = true;
      reason = 'Insufficient mating material (same-color bishops)';
    }
  }

  if (deadDraw) {
    whiteCanWin = false;
    blackCanWin = false;
  } else if (!whiteCanWin) {
    reason = 'White has only a bare king';
  } else if (!blackCanWin) {
    reason = 'Black has only a bare king';
  }

  return { whiteCanWin, blackCanWin, deadDraw, reason };
}

/**
 * Clamp impossible win probabilities when a side has no mating material.
 * Any impossible win mass is moved to Draw so White + Draw + Black remains 1.0.
 */
export function enforceMatingMaterialConstraint(fen, outcome) {
  if (!outcome || typeof outcome !== 'object') return outcome;
  const mat = analyzeMatingMaterial(fen);
  if (mat.whiteCanWin && mat.blackCanWin) {
    return { ...outcome, materialAdjusted: false, materialReason: '' };
  }

  let w = Math.max(0, Number(outcome.white) || 0);
  let d = Math.max(0, Number(outcome.draw) || 0);
  let b = Math.max(0, Number(outcome.black) || 0);

  if (mat.deadDraw || (!mat.whiteCanWin && !mat.blackCanWin)) {
    return {
      ...outcome,
      white: 0,
      draw: 1,
      black: 0,
      expected_score: 0.5,
      materialAdjusted: true,
      materialReason: mat.reason,
    };
  }

  if (!mat.whiteCanWin) {
    d += w;
    w = 0;
  }
  if (!mat.blackCanWin) {
    d += b;
    b = 0;
  }
  const sum = w + d + b;
  if (sum > 0) {
    w /= sum;
    d /= sum;
    b /= sum;
  } else {
    w = 0;
    d = 1;
    b = 0;
  }

  return {
    ...outcome,
    white: Math.round(w * 10000) / 10000,
    draw: Math.round(d * 10000) / 10000,
    black: Math.round(b * 10000) / 10000,
    expected_score: Math.round((w + 0.5 * d) * 10000) / 10000,
    materialAdjusted: true,
    materialReason: mat.reason,
  };
}

/**
 * Select the active W/D/L prediction block (`human` with clocks vs `human_no_clock` board-only),
 * applying chess insufficient-material constraints so a bare king never gets nonzero win odds.
 */
export function getActiveHumanOutcome(result, useClocks = true) {
  if (!result || typeof result !== 'object') return null;
  const raw = !useClocks && result.human_no_clock ? result.human_no_clock : result.human || null;
  if (!raw) return null;
  return result.fen ? enforceMatingMaterialConstraint(result.fen, raw) : raw;
}

/**
 * Classify position danger / trap severity from HumanFish diagnostics.
 */
export function computeDangerLevel(result) {
  const diag = result?.diagnostics || {};
  const regret = Number(diag.expected_regret_mover) || 0;
  const blunderProb = Number(diag.p_human_blunder_08) || 0;
  const hiddenOnly = Number(diag.hidden_only_move_score) || 0;

  if (regret >= 0.09 || blunderProb >= 0.35 || hiddenOnly >= 0.08) {
    return { level: 'high', label: 'Trap Risk' };
  }
  if (regret >= 0.04 || blunderProb >= 0.16 || hiddenOnly >= 0.03) {
    return { level: 'med', label: 'Sharp' };
  }
  return { level: 'low', label: 'Calm' };
}

/**
 * Compare HumanFish expected score against Stockfish 19 expected score.
 */
export function computeDivergenceInfo(result, useClocks = true) {
  const hum = getActiveHumanOutcome(result, useClocks);
  const sf = result?.stockfish;
  if (!hum || !sf) {
    return { deltaPp: 0, flippedFavorite: false, significant: false, summary: '' };
  }
  const hExp = Number(hum.expected_score);
  const sExp = Number(sf.expected_score);
  if (!Number.isFinite(hExp) || !Number.isFinite(sExp)) {
    return { deltaPp: 0, flippedFavorite: false, significant: false, summary: '' };
  }
  const deltaPp = Math.round((hExp - sExp) * 1000) / 10;
  const flippedFavorite = (hExp - 0.5) * (sExp - 0.5) < -0.0025 && Math.abs(deltaPp) >= 8;
  const significant = Math.abs(deltaPp) >= 7.5;

  let summary = '';
  if (flippedFavorite) {
    summary = `Disagrees with SF 19 on favorite (${deltaPp > 0 ? '+' : ''}${deltaPp.toFixed(1)} pp for White)`;
  } else if (significant) {
    const favored = deltaPp > 0 ? 'White' : 'Black';
    summary = `HumanFish favors ${favored} by ${Math.abs(deltaPp).toFixed(1)} pp more than SF 19`;
  }
  return { deltaPp, flippedFavorite, significant, summary };
}

/**
 * Format signed percentage-point delta (e.g. "+19.4 pp", "-4.2 pp", "0.0 pp").
 */
export function formatSignedPp(delta) {
  const pp = (Number(delta) || 0) * 100;
  if (Math.abs(pp) < 0.05) return '0.0 pp';
  return `${pp > 0 ? '+' : ''}${pp.toFixed(1)} pp`;
}
