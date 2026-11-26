/**
 * Aggregations over normalized game records (see normalize.js). Everything
 * here is pure and synchronous: the page recomputes on every filter change,
 * which stays fast even for tens of thousands of games.
 */
import { openingFamily, TERM_LABEL, TC_LABEL } from './normalize.js';

export const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ */
/* Basics                                                              */
/* ------------------------------------------------------------------ */

/** Win/draw/loss tally. `score` is the owner's average points (0..1). */
export function wdl(games) {
  let w = 0;
  let d = 0;
  let l = 0;
  for (const g of games) {
    if (g.res === 1) w++;
    else if (g.res === 0) l++;
    else d++;
  }
  const n = w + d + l;
  return { n, w, d, l, score: n ? (w + d / 2) / n : 0 };
}

/** Elo expected score of a player rated `me` against `op`. */
export function expectedScore(me, op) {
  return 1 / (1 + 10 ** ((op - me) / 400));
}

/**
 * Performance rating: average opponent rating plus the Elo rating difference
 * implied by the score (score clamped to 1%..99%, which caps the bonus at
 * about ±800, as in FIDE's table). Returns null without rated opponents.
 */
export function performance(games) {
  let sumR = 0;
  let nR = 0;
  let pts = 0;
  for (const g of games) {
    if (!g.opR) continue;
    sumR += g.opR;
    nR++;
    pts += g.res;
  }
  if (!nR) return null;
  const p = Math.min(0.99, Math.max(0.01, pts / nR));
  return Math.round(sumR / nR + 400 * Math.log10(p / (1 - p)));
}

/** Latest start time in a list (no spread, so large lists are safe). */
function maxT(games) {
  let m = 0;
  for (const g of games) if (g.t > m) m = g.t;
  return m;
}

const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

/* ------------------------------------------------------------------ */
/* Filters                                                             */
/* ------------------------------------------------------------------ */

export const PERIODS = {
  all: { label: 'All time', ms: Infinity },
  '7d': { label: '7 days', ms: 7 * DAY_MS },
  '30d': { label: '30 days', ms: 30 * DAY_MS },
  '3m': { label: '3 months', ms: 91 * DAY_MS },
  '12m': { label: '12 months', ms: 365 * DAY_MS },
};

/**
 * @param {object[]} games
 * @param {{tc?: string[], color?: 'all'|'w'|'b', period?: string, rated?: 'all'|'rated'|'casual',
 *          opp?: 'all'|'higher'|'similar'|'lower', search?: string, accounts?: string[]}} f
 */
export function filterGames(games, f = {}, now = Date.now()) {
  const tcs = f.tc && f.tc.length ? new Set(f.tc) : null;
  const accts = f.accounts && f.accounts.length ? new Set(f.accounts) : null;
  const periodMs = PERIODS[f.period || 'all']?.ms ?? Infinity;
  const minT = Number.isFinite(periodMs) ? now - periodMs : -Infinity;
  const search = (f.search || '').trim().toLowerCase();
  return games.filter((g) => {
    if (tcs && !tcs.has(g.tc)) return false;
    if (accts && !accts.has(`${g.src}:${g.acct}`)) return false;
    if (f.color && f.color !== 'all' && g.color !== f.color) return false;
    if (g.t < minT) return false;
    if (f.rated === 'rated' && !g.rated) return false;
    if (f.rated === 'casual' && g.rated) return false;
    if (f.opp && f.opp !== 'all') {
      if (!g.me || !g.opR) return false;
      const diff = g.opR - g.me;
      if (f.opp === 'higher' && diff < 50) return false;
      if (f.opp === 'lower' && diff > -50) return false;
      if (f.opp === 'similar' && Math.abs(diff) >= 50) return false;
    }
    if (search && !g.op.toLowerCase().includes(search) && !g.opening.toLowerCase().includes(search)) {
      return false;
    }
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* Breakdowns                                                          */
/* ------------------------------------------------------------------ */

/** Per time control: games, results, latest and peak rating. */
export function byTimeControl(games) {
  const map = new Map();
  for (const g of games) {
    let e = map.get(g.tc);
    if (!e) {
      e = { tc: g.tc, label: TC_LABEL[g.tc] || g.tc, games: [], rating: 0, ratingT: 0, peak: 0 };
      map.set(g.tc, e);
    }
    e.games.push(g);
    if (g.me && g.rated) {
      if (g.t > e.ratingT) {
        e.rating = g.me;
        e.ratingT = g.t;
      }
      if (g.me > e.peak) e.peak = g.me;
    }
  }
  return [...map.values()]
    .map((e) => ({ tc: e.tc, label: e.label, rating: e.rating, peak: e.peak, perf: performance(e.games), ...wdl(e.games) }))
    .sort((a, b) => b.n - a.n);
}

/** The owner's prefix of `ply` moves (the moves that define the opening). */
function openingPrefix(g) {
  if (!g.moves) return '';
  const toks = g.moves.split(' ');
  const ply = g.oply > 0 ? g.oply : Math.min(toks.length, 8);
  return toks.slice(0, ply).join(' ');
}

/**
 * Openings as one color, grouped by family or full name.
 * sort: 'played' | 'best' | 'worst' (best/worst rank by score, then games).
 */
export function openings(games, { color, groupBy = 'family', minGames = 1, sort = 'played' } = {}) {
  const map = new Map();
  for (const g of games) {
    if (color && g.color !== color) continue;
    const name = g.opening ? (groupBy === 'family' ? openingFamily(g.opening) : g.opening) : 'Unknown opening';
    let e = map.get(name);
    if (!e) {
      e = { name, games: [], prefixes: new Map(), eco: new Map() };
      map.set(name, e);
    }
    e.games.push(g);
    const p = openingPrefix(g);
    if (p) e.prefixes.set(p, (e.prefixes.get(p) || 0) + 1);
    if (g.eco) e.eco.set(g.eco, (e.eco.get(g.eco) || 0) + 1);
  }
  const rows = [];
  for (const e of map.values()) {
    if (e.games.length < minGames) continue;
    const r = wdl(e.games);
    rows.push({
      name: e.name,
      eco: topKey(e.eco),
      prefix: groupBy === 'family' ? commonPrefix(e.prefixes) : topKey(e.prefixes),
      perf: performance(e.games),
      last: maxT(e.games),
      ...r,
    });
  }
  if (sort === 'best') rows.sort((a, b) => b.score - a.score || b.n - a.n);
  else if (sort === 'worst') rows.sort((a, b) => a.score - b.score || b.n - a.n);
  else rows.sort((a, b) => b.n - a.n);
  return rows;
}

function topKey(map) {
  let best = '';
  let bestN = -1;
  for (const [k, n] of map) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

/** Longest move prefix shared by nearly all games of a family (at least 85% of them). */
function commonPrefix(prefixes) {
  const total = [...prefixes.values()].reduce((a, b) => a + b, 0);
  if (!total) return '';
  const top = topKey(prefixes).split(' ');
  for (let len = top.length; len > 0; len--) {
    const cand = top.slice(0, len).join(' ');
    let cover = 0;
    for (const [p, n] of prefixes) {
      if (p === cand || p.startsWith(`${cand} `)) cover += n;
    }
    if (cover / total >= 0.85) return cand;
  }
  return top.slice(0, 1).join(' ');
}

/** Opponents ranked by games played, plus titled opponents. */
export function opponents(games, { limit = 50 } = {}) {
  const map = new Map();
  for (const g of games) {
    const key = g.op.toLowerCase();
    let e = map.get(key);
    if (!e) {
      e = { name: g.op, games: [], title: '', ratings: [] };
      map.set(key, e);
    }
    e.games.push(g);
    if (g.opT) e.title = g.opT;
    if (g.opR) e.ratings.push(g.opR);
  }
  const rows = [...map.values()].map((e) => ({
    name: e.name,
    title: e.title,
    rating: Math.round(avg(e.ratings)),
    last: maxT(e.games),
    ...wdl(e.games),
  }));
  const mostPlayed = [...rows].sort((a, b) => b.n - a.n || b.last - a.last).slice(0, limit);
  const titled = rows
    .filter((r) => r.title && r.title !== 'BOT')
    .sort((a, b) => b.rating - a.rating)
    .slice(0, limit);
  return { mostPlayed, titled, unique: rows.length };
}

/** How games end, split by outcome. Each row: termination, count, share, average moves. */
export function terminations(games) {
  const groups = { win: new Map(), loss: new Map(), draw: new Map() };
  const totals = { win: 0, loss: 0, draw: 0 };
  for (const g of games) {
    const k = g.res === 1 ? 'win' : g.res === 0 ? 'loss' : 'draw';
    totals[k]++;
    let e = groups[k].get(g.term);
    if (!e) {
      e = { term: g.term, label: TERM_LABEL[g.term] || g.term, n: 0, moves: 0 };
      groups[k].set(g.term, e);
    }
    e.n++;
    e.moves += Math.ceil(g.plies / 2);
  }
  const fmt = (k) =>
    [...groups[k].values()]
      .map((e) => ({ term: e.term, label: e.label, n: e.n, share: totals[k] ? e.n / totals[k] : 0, avgMoves: e.n ? e.moves / e.n : 0 }))
      .sort((a, b) => b.n - a.n);
  return { win: fmt('win'), loss: fmt('loss'), draw: fmt('draw'), totals };
}

/** Results against weaker/stronger opponents, with the score Elo predicts. */
export function ratingBuckets(games) {
  const edges = [-Infinity, -200, -100, -25, 25, 100, 200, Infinity];
  const labels = ['−200 or less', '−200 to −100', '−100 to −25', 'Within 25', '+25 to +100', '+100 to +200', '+200 or more'];
  const buckets = labels.map((label) => ({ label, games: [], expected: 0 }));
  for (const g of games) {
    if (!g.me || !g.opR) continue;
    const diff = g.opR - g.me;
    let i = 0;
    while (i < edges.length - 2 && diff >= edges[i + 1]) i++;
    buckets[i].games.push(g);
    buckets[i].expected += expectedScore(g.me, g.opR);
  }
  return buckets.map((b) => ({
    label: b.label,
    expected: b.games.length ? b.expected / b.games.length : 0,
    ...wdl(b.games),
  }));
}

/* ------------------------------------------------------------------ */
/* Activity                                                            */
/* ------------------------------------------------------------------ */

export function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Per local day: games and score. */
export function byDay(games) {
  const map = new Map();
  for (const g of games) {
    const k = dayKey(g.t);
    let e = map.get(k);
    if (!e) {
      e = { n: 0, pts: 0 };
      map.set(k, e);
    }
    e.n++;
    e.pts += g.res;
  }
  return map;
}

/** 7×24 grid (Sunday first) of games and score, plus hour and weekday totals. */
export function timeOfDay(games) {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ n: 0, pts: 0 })));
  const hours = Array.from({ length: 24 }, () => ({ n: 0, pts: 0 }));
  const days = Array.from({ length: 7 }, () => ({ n: 0, pts: 0 }));
  for (const g of games) {
    const d = new Date(g.t);
    const wd = d.getDay();
    const h = d.getHours();
    grid[wd][h].n++;
    grid[wd][h].pts += g.res;
    hours[h].n++;
    hours[h].pts += g.res;
    days[wd].n++;
    days[wd].pts += g.res;
  }
  return { grid, hours, days };
}

/** Per calendar month (oldest first): games, score and average own rating. */
export function byMonth(games) {
  const map = new Map();
  for (const g of games) {
    const d = new Date(g.t);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    let e = map.get(k);
    if (!e) {
      e = { month: k, n: 0, pts: 0, rSum: 0, rN: 0, games: [] };
      map.set(k, e);
    }
    e.n++;
    e.pts += g.res;
    e.games.push(g);
    if (g.me && g.rated) {
      e.rSum += g.me;
      e.rN++;
    }
  }
  return [...map.values()]
    .sort((a, b) => (a.month < b.month ? -1 : 1))
    .map((e) => ({ month: e.month, n: e.n, score: e.pts / e.n, rating: e.rN ? Math.round(e.rSum / e.rN) : null, perf: performance(e.games) }));
}

/**
 * Habits: splits play into sessions (games less than `gapMin` minutes apart)
 * and measures score by position in the session and after a win or a loss.
 */
export function habits(games, { gapMin = 30 } = {}) {
  const sorted = [...games].sort((a, b) => a.t - b.t);
  const gap = gapMin * 60_000;
  const pos = [
    { label: 'Games 1–3', games: [] },
    { label: 'Games 4–6', games: [] },
    { label: 'Games 7–10', games: [] },
    { label: 'Game 11+', games: [] },
  ];
  const afterWin = [];
  const afterLoss = [];
  const afterDraw = [];
  let sessions = 0;
  let idx = 0;
  let longestWin = 0;
  let longestLoss = 0;
  let curW = 0;
  let curL = 0;
  for (let i = 0; i < sorted.length; i++) {
    const g = sorted[i];
    const prev = sorted[i - 1];
    if (!prev || g.t - prev.t > gap) {
      sessions++;
      idx = 0;
    } else {
      if (prev.res === 1) afterWin.push(g);
      else if (prev.res === 0) afterLoss.push(g);
      else afterDraw.push(g);
    }
    idx++;
    pos[idx <= 3 ? 0 : idx <= 6 ? 1 : idx <= 10 ? 2 : 3].games.push(g);
    if (g.res === 1) {
      curW++;
      curL = 0;
    } else if (g.res === 0) {
      curL++;
      curW = 0;
    } else {
      curW = 0;
      curL = 0;
    }
    longestWin = Math.max(longestWin, curW);
    longestLoss = Math.max(longestLoss, curL);
  }
  return {
    sessions,
    avgSessionGames: sessions ? sorted.length / sessions : 0,
    bySessionPosition: pos.map((p) => ({ label: p.label, ...wdl(p.games) })),
    afterWin: wdl(afterWin),
    afterLoss: wdl(afterLoss),
    afterDraw: wdl(afterDraw),
    longestWin,
    longestLoss,
  };
}

/* ------------------------------------------------------------------ */
/* Rating                                                              */
/* ------------------------------------------------------------------ */

/** Own rating over time for one time control: last rated game per day. */
export function ratingSeries(games, tc) {
  const byDayMap = new Map();
  for (const g of games) {
    if (g.tc !== tc || !g.rated || !g.me) continue;
    const k = dayKey(g.t);
    const cur = byDayMap.get(k);
    if (!cur || g.t > cur.t) byDayMap.set(k, { t: g.t, r: g.me });
  }
  return [...byDayMap.values()].sort((a, b) => a.t - b.t);
}

/** Performance and average own rating over the last N games (newest first window). */
export function performanceWindows(games, sizes = [10, 20, 50, 100, 200, 500, 1000, 5000]) {
  const sorted = [...games].sort((a, b) => b.t - a.t);
  const out = [];
  for (const n of sizes) {
    if (n > sorted.length) break;
    const slice = sorted.slice(0, n);
    out.push({ n, label: `Last ${n.toLocaleString('en-US')}`, perf: performance(slice), ...wdl(slice) });
  }
  if (sorted.length && !sizes.includes(sorted.length)) {
    out.push({ n: sorted.length, label: `All ${sorted.length.toLocaleString('en-US')}`, perf: performance(sorted), ...wdl(sorted) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Personal explorer                                                   */
/* ------------------------------------------------------------------ */

/**
 * Moves played from a position reached by `prefix` (SAN list), by move order.
 * Returns the games reaching the position and the next-move breakdown, each
 * with results from the owner's point of view.
 */
export function explorerNode(games, prefix = [], { color } = {}) {
  const pre = prefix.join(' ');
  const len = pre.length;
  const reached = [];
  const next = new Map();
  for (const g of games) {
    if (color && g.color !== color) continue;
    if (len) {
      if (!g.moves.startsWith(pre)) continue;
      if (g.moves.length > len && g.moves[len] !== ' ') continue;
    }
    reached.push(g);
    const start = len ? len + 1 : 0;
    if (start >= g.moves.length) continue;
    const sp = g.moves.indexOf(' ', start);
    const san = sp === -1 ? g.moves.slice(start) : g.moves.slice(start, sp);
    let e = next.get(san);
    if (!e) {
      e = { san, games: [] };
      next.set(san, e);
    }
    e.games.push(g);
  }
  const moves = [...next.values()]
    .map((e) => ({
      san: e.san,
      last: maxT(e.games),
      avgOpR: Math.round(avg(e.games.filter((g) => g.opR).map((g) => g.opR))),
      perf: performance(e.games),
      ...wdl(e.games),
    }))
    .sort((a, b) => b.n - a.n);
  return { reached, total: wdl(reached), moves };
}

/* ------------------------------------------------------------------ */
/* Takeaways                                                           */
/* ------------------------------------------------------------------ */

const pct = (x) => `${Math.round(x * 100)}%`;

/**
 * A short, ranked list of plain-language findings for the overview. Each:
 * { tone: 'good' | 'bad' | 'info', title, detail, link?: { tab, ... } }.
 * Findings need enough games to be meaningful; small samples are skipped.
 */
export function takeaways(games, now = Date.now()) {
  const out = [];
  if (games.length < 30) return out;
  const overall = wdl(games);

  // Rating trend in the main time control (last 30 days vs the 30 before).
  const tcs = byTimeControl(games);
  const main = tcs[0];
  if (main) {
    const series = ratingSeries(games, main.tc);
    const last = series[series.length - 1];
    const ref = [...series].reverse().find((p) => p.t <= now - 30 * DAY_MS);
    if (last && ref && last.t > now - 30 * DAY_MS) {
      const diff = last.r - ref.r;
      if (Math.abs(diff) >= 15) {
        out.push({
          tone: diff > 0 ? 'good' : 'bad',
          weight: Math.abs(diff) / 10,
          title: `${main.label} rating ${diff > 0 ? 'up' : 'down'} ${Math.abs(diff)} in 30 days`,
          detail: `From ${ref.r} to ${last.r}.`,
          link: { tab: 'rating' },
        });
      }
    }
  }

  // Strongest and weakest openings per color (enough games, clear deviation).
  for (const color of ['w', 'b']) {
    const colorGames = games.filter((g) => g.color === color);
    const minGames = Math.max(12, Math.round(colorGames.length * 0.02));
    const rows = openings(colorGames, { color, groupBy: 'family', minGames });
    const base = wdl(colorGames).score;
    const side = color === 'w' ? 'White' : 'Black';
    let best = null;
    let worst = null;
    for (const r of rows) {
      const z = (r.score - base) * Math.sqrt(r.n);
      if (!best || z > best.z) best = { ...r, z };
      if (!worst || z < worst.z) worst = { ...r, z };
    }
    if (worst && worst.z < -1.2 && worst.score < base - 0.04) {
      out.push({
        tone: 'bad',
        weight: -worst.z,
        title: `${worst.name} is costing you points as ${side}`,
        detail: `${pct(worst.score)} score in ${worst.n.toLocaleString('en-US')} games, vs ${pct(base)} in your other ${side} games.`,
        link: { tab: 'explorer', color, prefix: worst.prefix },
      });
    }
    if (best && best.z > 1.2 && best.score > base + 0.04) {
      out.push({
        tone: 'good',
        weight: best.z * 0.8,
        title: `${best.name} works well for you as ${side}`,
        detail: `${pct(best.score)} score in ${best.n.toLocaleString('en-US')} games, vs ${pct(base)} overall as ${side}.`,
        link: { tab: 'explorer', color, prefix: best.prefix },
      });
    }
  }

  // Tilt: results right after a loss vs right after a win.
  const h = habits(games);
  if (h.afterLoss.n >= 40 && h.afterWin.n >= 40) {
    const gap = h.afterWin.score - h.afterLoss.score;
    if (gap >= 0.04) {
      out.push({
        tone: 'bad',
        weight: gap * 25,
        title: 'You score less right after a loss',
        detail: `${pct(h.afterLoss.score)} in the next game after a loss, vs ${pct(h.afterWin.score)} after a win. A short break may help.`,
        link: { tab: 'activity' },
      });
    }
  }
  const early = h.bySessionPosition[0];
  const lateGroup = h.bySessionPosition[3];
  if (early.n >= 40 && lateGroup.n >= 40 && early.score - lateGroup.score >= 0.04) {
    out.push({
      tone: 'bad',
      weight: (early.score - lateGroup.score) * 20,
      title: 'Long sessions hurt your results',
      detail: `${pct(lateGroup.score)} from the 11th game of a session onward, vs ${pct(early.score)} in the first three.`,
      link: { tab: 'activity' },
    });
  }

  // Time of day: best vs worst 4-hour block with enough games.
  const tod = timeOfDay(games);
  const blocks = [];
  for (let s = 0; s < 24; s += 4) {
    let n = 0;
    let pts = 0;
    for (let hh = s; hh < s + 4; hh++) {
      n += tod.hours[hh].n;
      pts += tod.hours[hh].pts;
    }
    if (n >= Math.max(40, games.length * 0.04)) blocks.push({ s, n, score: pts / n });
  }
  if (blocks.length >= 2) {
    blocks.sort((a, b) => b.score - a.score);
    const bestB = blocks[0];
    const worstB = blocks[blocks.length - 1];
    if (bestB.score - worstB.score >= 0.05) {
      const span = (b) => `${fmtHour(b.s)}–${fmtHour((b.s + 4) % 24)}`;
      out.push({
        tone: 'info',
        weight: (bestB.score - worstB.score) * 18,
        title: `You play best ${span(bestB)}`,
        detail: `${pct(bestB.score)} score then, vs ${pct(worstB.score)} ${span(worstB)}.`,
        link: { tab: 'activity' },
      });
    }
  }

  // Losing on time.
  const terms = terminations(games);
  const timeLoss = terms.loss.find((r) => r.term === 'time');
  if (timeLoss && terms.totals.loss >= 40 && timeLoss.share >= 0.3) {
    out.push({
      tone: 'bad',
      weight: timeLoss.share * 6,
      title: `${pct(timeLoss.share)} of your losses are on time`,
      detail: 'Spending less time in the opening, or a longer time control, would save some of these.',
      link: { tab: 'activity' },
    });
  }

  // Color balance.
  const w = wdl(games.filter((g) => g.color === 'w'));
  const b = wdl(games.filter((g) => g.color === 'b'));
  if (w.n >= 50 && b.n >= 50 && Math.abs(w.score - b.score) >= 0.05) {
    const better = w.score > b.score ? 'White' : 'Black';
    out.push({
      tone: 'info',
      weight: Math.abs(w.score - b.score) * 15,
      title: `Stronger with ${better}`,
      detail: `${pct(w.score)} as White, ${pct(b.score)} as Black.`,
      link: { tab: 'openings' },
    });
  }

  if (!out.length) {
    out.push({
      tone: 'info',
      weight: 0,
      title: `${pct(overall.score)} score over ${overall.n.toLocaleString('en-US')} games`,
      detail: 'No opening, habit or time-of-day pattern stands out in this selection.',
    });
  }
  return out.sort((a, b2) => b2.weight - a.weight).slice(0, 5);
}

/** "12a", "3p": compact hour labels for narrow charts. */
export function fmtHourShort(h) {
  const hh = ((h % 24) + 24) % 24;
  return `${hh % 12 === 0 ? 12 : hh % 12}${hh < 12 ? 'a' : 'p'}`;
}

export function fmtHour(h) {
  const hh = ((h % 24) + 24) % 24;
  const ampm = hh < 12 ? 'am' : 'pm';
  const x = hh % 12 === 0 ? 12 : hh % 12;
  return `${x}${ampm}`;
}
