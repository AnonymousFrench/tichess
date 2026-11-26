/**
 * "Mine" explorer source for the Studio: the user's own games downloaded on
 * the Insights page (Lichess, Chess.com and PGN imports), read straight from
 * this browser's IndexedDB. Works offline and needs no sign-in.
 *
 * Positions are matched by move order from the starting position, the same
 * way the Insights explorer works.
 */
import { Chess } from 'chess.js';
import { START_FEN, normalizeFen } from '../state.js';
import { explorerNode } from '../insights/stats.js';
import { computeSinceFilter } from '../api/lichess.js';

let gamesPromise = null;
let cachedAt = 0;
const CACHE_MS = 60_000;

/** Lazily load (and briefly cache) the Insights game store. */
export async function loadMyGames() {
  if (!gamesPromise || Date.now() - cachedAt > CACHE_MS) {
    cachedAt = Date.now();
    gamesPromise = import('../insights/store.js')
      .then((m) => m.loadAllGames())
      .catch(() => []);
  }
  return gamesPromise;
}

/** Number of downloaded games, without keeping them in memory. */
export async function countMyGames() {
  try {
    const m = await import('../insights/store.js');
    return await m.countGames();
  } catch (_) {
    return 0;
  }
}

/** SAN moves from the tab's root to `node`, or null if the root is not the start position. */
export function sanPathTo(node) {
  const path = [];
  let cur = node;
  while (cur && cur.parent) {
    path.push(cur.san);
    cur = cur.parent;
  }
  if (!cur || normalizeFen(cur.fen) !== normalizeFen(START_FEN)) return null;
  return path.reverse();
}

const resultToWdb = (g) => {
  // Convert an owner-side result to White / Draw / Black counts.
  if (g.res === 0.5) return 'd';
  return (g.res === 1) === (g.color === 'w') ? 'w' : 'b';
};

/**
 * Explorer data in the same shape the Lichess explorer returns:
 * { moves: [{san, uci, white, draws, black}], white, draws, black, recentGames }.
 */
export async function fetchMineExplorer(node, { color = 'white', sinceKey = '' } = {}) {
  const path = sanPathTo(node);
  if (!path) return { moves: [], white: 0, draws: 0, black: 0, recentGames: [], unsupported: true };
  const all = await loadMyGames();
  const { sinceMs } = computeSinceFilter(sinceKey);
  const games = sinceMs ? all.filter((g) => g.t >= sinceMs) : all;
  const res = explorerNode(games, path, { color: color === 'black' ? 'b' : 'w' });
  const fen = node.fen;
  // One pass: White / Draw / Black tallies for each next move.
  const pre = path.join(' ');
  const start = pre.length ? pre.length + 1 : 0;
  const tallies = new Map();
  const totals = { w: 0, d: 0, b: 0 };
  for (const g of res.reached) {
    const k = resultToWdb(g);
    totals[k]++;
    if (start >= g.moves.length) continue;
    const sp = g.moves.indexOf(' ', start);
    const san = sp === -1 ? g.moves.slice(start) : g.moves.slice(start, sp);
    let t = tallies.get(san);
    if (!t) {
      t = { w: 0, d: 0, b: 0 };
      tallies.set(san, t);
    }
    t[k]++;
  }
  const moves = res.moves.map((m) => {
    let uci = '';
    try {
      const mv = new Chess(fen).move(m.san);
      if (mv) uci = mv.from + mv.to + (mv.promotion || '');
    } catch (_) {
      /* keep san only */
    }
    const t = tallies.get(m.san) || { w: 0, d: 0, b: 0 };
    return { san: m.san, uci, white: t.w, draws: t.d, black: t.b };
  });
  const recentGames = [...res.reached]
    .sort((a, b) => b.t - a.t)
    .slice(0, 20)
    .map((g) => toExplorerGame(g));
  return { moves, white: totals.w, draws: totals.d, black: totals.b, recentGames, total: res.reached.length };
}

function toExplorerGame(g) {
  const me = { name: g.acct, rating: g.me || '' };
  const opp = { name: g.op, rating: g.opR || '' };
  const white = g.color === 'w' ? me : opp;
  const black = g.color === 'w' ? opp : me;
  const winner = g.res === 0.5 ? null : (g.res === 1) === (g.color === 'w') ? 'white' : 'black';
  const d = new Date(g.t);
  const sans = g.moves ? g.moves.split(' ') : [];
  let movetext = '';
  sans.forEach((s, i) => {
    movetext += i % 2 === 0 ? `${i / 2 + 1}. ${s} ` : `${s} `;
  });
  const result = winner === 'white' ? '1-0' : winner === 'black' ? '0-1' : '1/2-1/2';
  const pgn = `[White "${white.name}"]\n[Black "${black.name}"]\n[Result "${result}"]\n\n${movetext}${result}\n`;
  return {
    id: g.id,
    white,
    black,
    winner,
    month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
    pgn,
  };
}
