/**
 * "+100 Elo" opening peer benchmark via Lichess Opening Explorer.
 * Selects the Lichess rating brackets ~100–200 Elo above the player's current
 * rating and fetches real move frequencies and scores for a given FEN.
 */
import { getCloudSyncState } from '../sync/cloudSync.js';

const LICHESS_BRACKETS = [400, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
const cache = new Map();

/**
 * Choose 1–2 Lichess rating brackets representing players ~100–200 Elo above `rating`.
 */
export function targetRatingBrackets(rating) {
  const r = Number(rating) || 1500;
  const target = r + 100;
  // Find the first bracket >= target - 100, plus the next bracket up.
  let idx = LICHESS_BRACKETS.findIndex((b) => b >= target);
  if (idx === -1) idx = LICHESS_BRACKETS.length - 1;
  const first = LICHESS_BRACKETS[Math.max(0, idx)];
  const second = LICHESS_BRACKETS[Math.min(LICHESS_BRACKETS.length - 1, idx + 1)];
  const brackets = first === second ? [first] : [first, second];
  const label = brackets.length === 1 ? `${brackets[0]}+` : `${brackets[0]}–${brackets[1]}`;
  return { brackets, param: brackets.join(','), label };
}

/** Map Insights time-control filter to Lichess Explorer speeds. */
export function explorerSpeedsForTc(tc) {
  if (tc === 'bullet') return 'bullet,blitz';
  if (tc === 'blitz') return 'blitz';
  if (tc === 'rapid') return 'rapid';
  if (tc === 'classical') return 'classical';
  if (tc === 'daily') return 'correspondence,classical';
  return 'blitz,rapid,classical';
}

function lichessToken() {
  try {
    return localStorage.getItem('cms_lichess_token') || '';
  } catch (_) {
    return '';
  }
}

/**
 * Normalize raw Lichess Explorer JSON into owner-color perspective moves.
 */
export function normalizeBenchmarkMoves(data, color) {
  const totalGames = (data?.white || 0) + (data?.draws || 0) + (data?.black || 0);
  const moves = (data?.moves || []).slice(0, 6).map((m) => {
    const w = m.white || 0;
    const d = m.draws || 0;
    const b = m.black || 0;
    const n = w + d + b;
    const pts = color === 'w' ? w + d * 0.5 : b + d * 0.5;
    return {
      san: m.san,
      uci: m.uci,
      n,
      share: totalGames ? n / totalGames : 0,
      score: n ? pts / n : 0,
      avgRating: m.averageRating || 0,
    };
  });
  return { totalGames, moves };
}

/**
 * Fetch +100 Elo peer moves for `fen`. Never fabricates data: returns
 * `{ status: 'ok', ... }` or `{ status: 'auth_required' | 'rate_limited' | 'error', message }`.
 */
export async function fetchPeerBenchmark(fen, { rating = 1500, tc = 'all', color = 'w', signal } = {}) {
  const { param: ratings, label: bracketLabel } = targetRatingBrackets(rating);
  const speeds = explorerSpeedsForTc(tc);
  const key = `${fen}|${ratings}|${speeds}|${color}`;
  if (cache.has(key)) return cache.get(key);

  const auth = getCloudSyncState();
  const token = lichessToken();
  const useProxy = Boolean(auth.authenticated && auth.configured);

  let url;
  const headers = { Accept: 'application/json' };
  if (useProxy) {
    url = `/api/lichess/explorer?source=lichess&fen=${encodeURIComponent(fen)}&ratings=${encodeURIComponent(ratings)}&speeds=${encodeURIComponent(speeds)}`;
  } else if (token) {
    url = `https://explorer.lichess.org/lichess?fen=${encodeURIComponent(fen)}&ratings=${encodeURIComponent(ratings)}&speeds=${encodeURIComponent(speeds)}&topGames=0&recentGames=0`;
    headers.Authorization = `Bearer ${token}`;
  } else {
    return {
      status: 'auth_required',
      bracketLabel,
      message: 'Sign in with Lichess (top right) or add a Lichess token in Studio Settings to load +100 Elo Lichess Explorer benchmarks.',
    };
  }

  try {
    const res = await fetch(url, { signal, headers });
    if (res.status === 401 || res.status === 403) {
      return {
        status: 'auth_required',
        bracketLabel,
        message: 'Lichess Explorer requires a fresh Lichess sign-in or personal token.',
      };
    }
    if (res.status === 429) {
      return {
        status: 'rate_limited',
        bracketLabel,
        message: 'Lichess Explorer asked us to slow down — try again in a minute.',
      };
    }
    if (!res.ok) {
      return { status: 'error', bracketLabel, message: `Explorer request failed (${res.status}).` };
    }
    const data = await res.json();
    const norm = normalizeBenchmarkMoves(data, color);
    const out = { status: 'ok', bracketLabel, ratings, speeds, ...norm };
    cache.set(key, out);
    return out;
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return { status: 'error', bracketLabel, message: err?.message || 'Could not reach Lichess Explorer.' };
  }
}

export function clearBenchmarkCache() {
  cache.clear();
}
