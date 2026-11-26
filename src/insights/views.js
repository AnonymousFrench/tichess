/**
 * Tab renderers for the Insights page. Each takes a context and returns HTML.
 * Interactive elements carry data-act attributes handled by app.js.
 */
import { Chess } from 'chess.js';
import {
  wdl,
  performance,
  byTimeControl,
  openings,
  opponents,
  terminations,
  ratingBuckets,
  byDay,
  timeOfDay,
  byMonth,
  habits,
  ratingSeries,
  performanceWindows,
  explorerNode,
  takeaways,
  fmtHour,
  fmtHourShort,
  DAY_MS,
} from './stats.js';
import { TC_LABEL, TERM_LABEL } from './normalize.js';
import {
  esc,
  fmtInt,
  fmtPct,
  scoreColor,
  wdlBar,
  lineChart,
  scoreBars,
  yearCalendar,
  hourGrid,
  expectedVsActual,
} from './charts.js';
import { miniBoardHtml } from './miniBoard.js';

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

export function card(title, body, { right = '', cls = '', pad = 'p-3' } = {}) {
  return `<section class="bg-panel border border-borderSubtle rounded-xl ${pad} min-w-0 ${cls}">
    ${title || right ? `<div class="flex items-center justify-between gap-2 mb-2.5"><h3 class="text-[10.5px] font-semibold uppercase tracking-wider text-txtMuted">${title}</h3>${right}</div>` : ''}
    ${body}
  </section>`;
}

const empty = (msg) => `<div class="py-6 text-center text-txtMuted text-[11.5px]">${msg}</div>`;

export function relTime(t, now = Date.now()) {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 90) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.round(m)} min ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)} h ago`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'} ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const fmtDate = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const colorDot = (c) =>
  `<span class="inline-block w-2.5 h-2.5 rounded-[3px] border ${c === 'w' ? 'bg-[#e5e7eb] border-[#9aa3b5]' : 'bg-[#2a2f3a] border-[#5b6273]'}" title="${c === 'w' ? 'White' : 'Black'}"></span>`;

const resultChip = (res) =>
  res === 1
    ? '<span class="px-1.5 py-[1px] rounded bg-em/15 text-em font-semibold">Win</span>'
    : res === 0
      ? '<span class="px-1.5 py-[1px] rounded bg-ro/15 text-ro font-semibold">Loss</span>'
      : '<span class="px-1.5 py-[1px] rounded bg-surface text-txtMuted font-semibold">Draw</span>';

const scorePill = (score, n) =>
  n
    ? `<span class="font-mono text-[11px] font-semibold" style="color:${scoreColor(score)}">${Math.round(score * 100)}%</span>`
    : '<span class="text-txtMuted">—</span>';

const sectionTabs = (items, active, act) =>
  `<div class="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-surface border border-borderSubtle text-[11px]">${items
    .map(
      ([v, l]) =>
        `<button data-act="${act}" data-v="${esc(v)}" class="px-2 py-0.5 rounded-md font-semibold ${v === active ? 'bg-em text-[#04130d]' : 'text-txtMuted hover:text-txt'}">${esc(l)}</button>`
    )
    .join('')}</div>`;

/** "1.e4 c5 2.Nf3" from a SAN list starting at ply 0. */
export function movesText(sans, startPly = 0) {
  let out = '';
  sans.forEach((s, i) => {
    const ply = startPly + i;
    if (ply % 2 === 0) out += `${ply / 2 + 1}.${s} `;
    else out += i === 0 ? `${(ply + 1) / 2}...${s} ` : `${s} `;
  });
  return out.trim();
}

/** Replays SAN moves; returns fen, the last move, and UCI moves (stops at the first illegal move). */
export function replay(sans) {
  const g = new Chess();
  const ucis = [];
  let last = null;
  for (const s of sans) {
    let m;
    try {
      m = g.move(s);
    } catch (_) {
      break;
    }
    if (!m) break;
    ucis.push(m.from + m.to + (m.promotion || ''));
    last = { from: m.from, to: m.to };
  }
  return { fen: g.fen(), last, ucis, chess: g };
}

function gameRow(g, ctx, { compact = false } = {}) {
  const tc = `<span class="text-txtMuted">${esc(TC_LABEL[g.tc] || g.tc)}${g.clock && !compact ? ` <span class="font-mono text-[10px]">${esc(clockLabel(g.clock))}</span>` : ''}</span>`;
  const opp = `<span class="font-medium text-txt">${g.opT ? `<span class="text-am font-bold mr-1">${esc(g.opT)}</span>` : ''}${esc(g.op)}</span>${g.opR ? ` <span class="font-mono text-[10px] text-txtMuted">${g.opR}</span>` : ''}`;
  const opening = `<span class="truncate text-txtMuted">${g.eco ? `<span class="font-mono text-[10px] mr-1">${esc(g.eco)}</span>` : ''}${esc(g.opening || movesText(g.moves.split(' ').slice(0, 6)))}</span>`;
  const actions = `<span class="flex items-center justify-end gap-1">
      <button data-act="open-game" data-id="${esc(g.id)}" class="px-1.5 py-0.5 rounded bg-em/15 hover:bg-em/25 text-em text-[10px] font-semibold" title="Open this game in the Studio">Studio</button>
      ${g.url ? `<a href="${esc(g.url)}" target="_blank" rel="noopener noreferrer" class="px-1.5 py-0.5 rounded bg-surface hover:bg-surfaceHover text-txtMuted hover:text-txt text-[10px]" title="View on ${g.src === 'chesscom' ? 'Chess.com' : 'Lichess'}">↗</a>` : ''}
    </span>`;
  if (compact) {
    return `<div class="grid grid-cols-[auto_auto_1fr_auto] items-center gap-2 py-1.5 border-b border-borderSubtle/60 last:border-0 text-[11.5px]">
      ${colorDot(g.color)}${resultChip(g.res)}<span class="min-w-0 truncate">${opp} <span class="text-txtMuted text-[10.5px]">· ${esc(relTime(g.t, ctx.now))}</span></span>${actions}</div>`;
  }
  return `<tr class="border-b border-borderSubtle/60 hover:bg-surface/50">
    <td class="py-1.5 pr-2 whitespace-nowrap text-txtMuted">${esc(relTime(g.t, ctx.now))}</td>
    <td class="py-1.5 pr-2 whitespace-nowrap">${tc}</td>
    <td class="py-1.5 pr-2">${colorDot(g.color)}</td>
    <td class="py-1.5 pr-2 whitespace-nowrap">${resultChip(g.res)} <span class="text-[10px] text-txtMuted hidden md:inline">${esc(TERM_LABEL[g.term] || '')}</span></td>
    <td class="py-1.5 pr-2 whitespace-nowrap">${opp}</td>
    <td class="py-1.5 pr-2 font-mono text-txtMuted text-right">${Math.ceil(g.plies / 2)}</td>
    <td class="py-1.5 pr-2 max-w-[280px] hidden lg:table-cell"><div class="truncate">${opening}</div></td>
    <td class="py-1.5">${actions}</td>
  </tr>`;
}

function clockLabel(clock) {
  const [b, i] = clock.split('+').map(Number);
  if (!Number.isFinite(b)) return clock;
  const base = b >= 60 && b % 60 === 0 ? `${b / 60}` : b >= 60 ? `${(b / 60).toFixed(1)}` : `${b}s`;
  return `${base}+${i || 0}`;
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

export function renderOverview(ctx) {
  const { games, now } = ctx;
  if (!games.length) return empty('No games match these filters.');
  const total = wdl(games);
  const tcs = byTimeControl(games);
  const main = tcs[0];
  const recent = [...games].sort((a, b) => b.t - a.t);
  const last100 = performance(recent.slice(0, 100));
  const lastGame = recent[0];
  const takes = takeaways(games, now);

  const kpi = (label, value, sub = '') =>
    `<div class="min-w-0"><div class="text-[10.5px] text-txtMuted uppercase tracking-wider font-semibold">${label}</div><div class="text-[22px] font-bold leading-tight tabular-nums">${value}</div>${sub ? `<div class="text-[11px] text-txtMuted truncate">${sub}</div>` : ''}</div>`;

  const kpis = `<section class="bg-panel border border-borderSubtle rounded-xl p-3 grid grid-cols-2 md:grid-cols-5 gap-3 items-center">
      ${kpi('Games', fmtInt(total.n), `${fmtInt(total.w)} W · ${fmtInt(total.d)} D · ${fmtInt(total.l)} L`)}
      <div class="col-span-2 md:col-span-1 min-w-0"><div class="text-[10.5px] text-txtMuted uppercase tracking-wider font-semibold mb-1">Score ${scorePill(total.score, total.n)}</div>${wdlBar(total)}</div>
      ${kpi(`${esc(main.label)} rating`, main.rating || '—', main.peak ? `Peak ${main.peak}` : '')}
      ${kpi('Performance', last100 ?? '—', 'Last 100 games')}
      ${kpi('Last game', lastGame ? esc(relTime(lastGame.t, now)) : '—', lastGame ? `${lastGame.res === 1 ? 'Won' : lastGame.res === 0 ? 'Lost' : 'Drew'} vs ${esc(lastGame.op)}` : '')}
    </section>`;

  const toneStyle = { good: 'border-em/40 bg-em/[0.06]', bad: 'border-ro/40 bg-ro/[0.06]', info: 'border-cy/35 bg-cy/[0.05]' };
  const toneIcon = { good: '▲', bad: '▼', info: '●' };
  const toneColor = { good: 'text-em', bad: 'text-ro', info: 'text-cy' };
  const takeHtml = takes.length
    ? `<div class="grid gap-2">${takes
        .map(
          (t, i) => `<button data-act="takeaway" data-i="${i}" class="text-left rounded-lg border ${toneStyle[t.tone]} px-3 py-2 hover:brightness-125 transition">
            <div class="flex items-start gap-2"><span class="${toneColor[t.tone]} text-[10px] mt-[3px]">${toneIcon[t.tone]}</span><div class="min-w-0">
            <div class="text-[12.5px] font-semibold text-txt">${esc(t.title)}</div><div class="text-[11.5px] text-txtMuted">${esc(t.detail)}</div></div></div></button>`
        )
        .join('')}</div>`
    : empty('Play at least 30 games in this selection to see patterns.');
  ctx.setTakeaways(takes);

  const tcTable = `<table class="w-full text-[11.5px]"><thead><tr class="text-txtMuted text-[10px] uppercase tracking-wider"><th class="text-left font-semibold pb-1.5">Time control</th><th class="text-right font-semibold pb-1.5">Games</th><th class="text-right font-semibold pb-1.5 px-2">Rating</th><th class="font-semibold pb-1.5 w-[42%]">Results</th></tr></thead><tbody>${tcs
    .map(
      (r) => `<tr class="border-t border-borderSubtle/60"><td class="py-1.5 font-medium"><button data-act="set-filter" data-k="tc" data-v="${r.tc}" class="hover:text-em">${esc(r.label)}</button></td><td class="py-1.5 text-right font-mono">${fmtInt(r.n)}</td><td class="py-1.5 text-right font-mono px-2">${r.rating || '—'}</td><td class="py-1.5">${wdlBar(r)}</td></tr>`
    )
    .join('')}</tbody></table>`;

  const openingList = (color) => {
    const rows = openings(games, { color, groupBy: 'family' }).slice(0, 6);
    if (!rows.length) return empty('No games');
    return rows
      .map(
        (r) => `<button data-act="explore" data-color="${color}" data-prefix="${esc(r.prefix)}" class="w-full grid grid-cols-[1fr_44px_90px] items-center gap-2 py-1 text-left text-[11.5px] hover:text-em">
          <span class="truncate">${esc(r.name)}</span><span class="text-right font-mono text-txtMuted">${fmtInt(r.n)}</span>${wdlBar(r, { labels: false, height: 'h-[10px]' })}</button>`
      )
      .join('');
  };

  const series = ratingSeries(games, main.tc).filter((p) => p.t >= now - 365 * DAY_MS);
  const ratingChart = lineChart(
    series.map((p) => ({ x: p.t, y: p.r })),
    { height: 170, label: `${main.label} rating, last 12 months` }
  );

  const dayMap = byDay(games.filter((g) => g.t >= now - 16 * 7 * DAY_MS));
  const recentWeeks = weeksStrip(dayMap, now, 16);

  const w = wdl(games.filter((g) => g.color === 'w'));
  const b = wdl(games.filter((g) => g.color === 'b'));
  const byColor = `<div class="grid gap-2 text-[11.5px]">
      <div class="grid grid-cols-[70px_48px_1fr] items-center gap-2"><span class="flex items-center gap-1.5">${colorDot('w')}White</span><span class="font-mono text-right text-txtMuted">${fmtInt(w.n)}</span>${wdlBar(w)}</div>
      <div class="grid grid-cols-[70px_48px_1fr] items-center gap-2"><span class="flex items-center gap-1.5">${colorDot('b')}Black</span><span class="font-mono text-right text-txtMuted">${fmtInt(b.n)}</span>${wdlBar(b)}</div>
    </div>`;

  const terms = terminations(games);
  const termMini = (rows, cls) =>
    rows
      .slice(0, 3)
      .map((r) => `<div class="flex items-center justify-between text-[11px]"><span class="text-txtMuted">${esc(r.label)}</span><span class="font-mono ${cls}">${fmtPct(r.share)}</span></div>`)
      .join('');
  const endings = `<div class="grid grid-cols-2 gap-3"><div><div class="text-[10.5px] font-semibold text-em mb-1">Wins by</div>${termMini(terms.win, 'text-em')}</div><div><div class="text-[10.5px] font-semibold text-ro mb-1">Losses by</div>${termMini(terms.loss, 'text-ro')}</div></div>`;

  const recentList = recent
    .slice(0, 8)
    .map((g) => gameRow(g, ctx, { compact: true }))
    .join('');

  return `<div class="grid gap-3">
    ${kpis}
    <div class="grid gap-3 lg:grid-cols-[1.15fr_1fr] items-start">
      ${card('What stands out', takeHtml)}
      <div class="grid gap-3">
        ${card('Time controls', tcTable)}
        <div class="grid gap-3 sm:grid-cols-2">${card('By color', byColor)}${card('How games end', endings)}</div>
      </div>
    </div>
    <div class="grid gap-3 lg:grid-cols-3">
      ${card(`${esc(main.label)} rating · 12 months`, ratingChart, { right: '<button data-act="tab" data-v="rating" class="text-[10.5px] text-cy hover:underline">Details</button>' })}
      ${card('Openings as White', openingList('w'), { right: '<button data-act="tab" data-v="openings" class="text-[10.5px] text-cy hover:underline">All</button>' })}
      ${card('Openings as Black', openingList('b'), { right: '<button data-act="tab" data-v="openings" class="text-[10.5px] text-cy hover:underline">All</button>' })}
    </div>
    <div class="grid gap-3 lg:grid-cols-[1fr_2fr] items-start">
      ${card('Last 16 weeks', recentWeeks, { right: '<button data-act="tab" data-v="activity" class="text-[10.5px] text-cy hover:underline">Activity</button>' })}
      ${card('Recent games', recentList, { right: '<button data-act="tab" data-v="games" class="text-[10.5px] text-cy hover:underline">All games</button>' })}
    </div>
  </div>`;
}

/** Compact calendar of the last `weeks` weeks ending today. */
function weeksStrip(dayMap, now, weeks) {
  const cell = 13;
  const gap = 3;
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(end.getDate() - end.getDay() - (weeks - 1) * 7);
  const max = Math.max(1, ...[...dayMap.values()].map((v) => v.n));
  let rects = '';
  for (let wk = 0; wk < weeks; wk++) {
    for (let wd = 0; wd < 7; wd++) {
      const d = new Date(start);
      d.setDate(start.getDate() + wk * 7 + wd);
      if (d > end) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const v = dayMap.get(key);
      const x = wk * (cell + gap);
      const y = wd * (cell + gap);
      rects += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2.5" fill="#1b1e25"/>`;
      if (v?.n) {
        const s = Math.max(4, Math.round(cell * Math.sqrt(v.n / max)));
        const o = (cell - s) / 2;
        rects += `<rect x="${x + o}" y="${y + o}" width="${s}" height="${s}" rx="2" fill="${scoreColor(v.pts / v.n)}"><title>${key}: ${v.n} games, ${Math.round((v.pts / v.n) * 100)}%</title></rect>`;
      }
    }
  }
  const W = weeks * (cell + gap);
  const H = 7 * (cell + gap);
  return `<svg viewBox="0 0 ${W} ${H}" class="w-full h-auto block">${rects}</svg>
    <div class="flex items-center justify-between mt-2 text-[10px] text-txtMuted"><span>Size: games played</span><span class="flex items-center gap-1">Score <i class="inline-block w-2.5 h-2.5 rounded-sm" style="background:${scoreColor(0.3)}"></i><i class="inline-block w-2.5 h-2.5 rounded-sm" style="background:${scoreColor(0.5)}"></i><i class="inline-block w-2.5 h-2.5 rounded-sm" style="background:${scoreColor(0.7)}"></i></span></div>`;
}

/* ------------------------------------------------------------------ */
/* Games                                                               */
/* ------------------------------------------------------------------ */

export function filterGamesTab(games, ui) {
  let rows = games;
  if (ui.outcome === 'win') rows = rows.filter((g) => g.res === 1);
  else if (ui.outcome === 'draw') rows = rows.filter((g) => g.res === 0.5);
  else if (ui.outcome === 'loss') rows = rows.filter((g) => g.res === 0);
  if (ui.term && ui.term !== 'all') rows = rows.filter((g) => g.term === ui.term);
  const q = (ui.search || '').trim().toLowerCase();
  if (q) rows = rows.filter((g) => g.op.toLowerCase().includes(q) || g.opening.toLowerCase().includes(q) || g.eco.toLowerCase() === q);
  const sorters = {
    new: (a, b) => b.t - a.t,
    old: (a, b) => a.t - b.t,
    opp: (a, b) => b.opR - a.opR,
    long: (a, b) => b.plies - a.plies,
    short: (a, b) => a.plies - b.plies,
  };
  return [...rows].sort(sorters[ui.sort] || sorters.new);
}

export function renderGames(ctx) {
  const ui = ctx.ui.games;
  const rows = filterGamesTab(ctx.games, ui);
  const shown = rows.slice(0, ui.limit);
  const sel = (key, opts, value, label) =>
    `<select data-act="games-ui" data-k="${key}" aria-label="${label}" class="px-2 py-1 rounded-lg bg-surface border border-borderSubtle text-[11.5px] focus:outline-none focus:border-em">${opts
      .map(([v, l]) => `<option value="${v}"${v === value ? ' selected' : ''}>${l}</option>`)
      .join('')}</select>`;
  const terms = [['all', 'Any ending'], ...Object.entries(TERM_LABEL)];
  const toolbar = `<div class="flex flex-wrap items-center gap-2 mb-2.5">
      <input data-act="games-search" value="${esc(ui.search)}" placeholder="Search opponent or opening…" class="flex-1 min-w-[180px] max-w-[320px] px-2.5 py-1 rounded-lg bg-surface border border-borderSubtle text-[16px] sm:text-[11.5px] focus:outline-none focus:border-em" aria-label="Search games">
      ${sel('outcome', [['all', 'All results'], ['win', 'Wins'], ['draw', 'Draws'], ['loss', 'Losses']], ui.outcome, 'Result')}
      ${sel('term', terms, ui.term, 'Ending')}
      ${sel('sort', [['new', 'Newest'], ['old', 'Oldest'], ['opp', 'Strongest opponent'], ['long', 'Longest'], ['short', 'Shortest']], ui.sort, 'Sort')}
      <span class="ml-auto flex items-center gap-2">
        <span class="text-[11px] text-txtMuted font-mono">${fmtInt(rows.length)} games · ${scorePill(wdl(rows).score, rows.length)}</span>
        <button data-act="export-pgn" class="px-2.5 py-1 rounded-lg bg-surface hover:bg-surfaceHover border border-borderSubtle text-[11px] font-semibold" ${rows.length ? '' : 'disabled'}>Download PGN</button>
      </span>
    </div>`;
  const table = shown.length
    ? `<div class="overflow-x-auto"><table class="w-full text-[11.5px]"><thead><tr class="text-left text-txtMuted text-[10px] uppercase tracking-wider">
        <th class="font-semibold pb-1.5 pr-2">Played</th><th class="font-semibold pb-1.5 pr-2">Time</th><th class="font-semibold pb-1.5 pr-2"></th><th class="font-semibold pb-1.5 pr-2">Result</th><th class="font-semibold pb-1.5 pr-2">Opponent</th><th class="font-semibold pb-1.5 pr-2 text-right">Moves</th><th class="font-semibold pb-1.5 pr-2 hidden lg:table-cell">Opening</th><th></th></tr></thead>
        <tbody>${shown.map((g) => gameRow(g, ctx)).join('')}</tbody></table></div>
        ${rows.length > shown.length ? `<div class="flex justify-center mt-3"><button data-act="games-more" class="px-3 py-1.5 rounded-lg bg-surface hover:bg-surfaceHover border border-borderSubtle text-[11.5px] font-semibold">Show more (${fmtInt(rows.length - shown.length)} left)</button></div>` : ''}`
    : empty('No games match.');
  return card('', toolbar + table);
}

/* ------------------------------------------------------------------ */
/* Explorer                                                            */
/* ------------------------------------------------------------------ */

export function renderExplorer(ctx) {
  const ui = ctx.ui.explorer;
  const node = explorerNode(ctx.games, ui.path, { color: ui.color });
  const { fen, last, chess } = replay(ui.path);
  const maxN = node.moves[0]?.n || 1;
  const arrows = [];
  for (const m of node.moves.slice(0, 4)) {
    const c = new Chess(fen);
    try {
      const mv = c.move(m.san);
      if (mv) arrows.push({ from: mv.from, to: mv.to, weight: m.n / maxN });
    } catch (_) {
      /* ignore */
    }
  }
  const board = miniBoardHtml(fen, { flipped: ui.color === 'b', last, arrows });
  const crumbs = [`<button data-act="ex-goto" data-i="0" class="hover:text-em ${ui.path.length ? 'text-txtMuted' : 'text-txt font-semibold'}">Start</button>`]
    .concat(
      ui.path.map((s, i) => {
        const num = i % 2 === 0 ? `${i / 2 + 1}.` : i === 0 ? '1...' : '';
        return `<button data-act="ex-goto" data-i="${i + 1}" class="font-mono hover:text-em ${i === ui.path.length - 1 ? 'text-txt font-semibold' : 'text-txtMuted'}">${num}${esc(s)}</button>`;
      })
    )
    .join('<span class="text-borderBright">›</span>');

  const turn = chess.turn();
  const myTurn = (turn === 'w') === (ui.color === 'w');
  const rows = node.moves.length
    ? node.moves
        .map(
          (m) => `<tr class="border-t border-borderSubtle/60 hover:bg-surface/60 cursor-pointer" data-act="ex-move" data-san="${esc(m.san)}">
            <td class="py-1.5 pr-2 font-mono font-semibold">${esc(m.san)}</td>
            <td class="py-1.5 pr-2 text-right font-mono">${fmtInt(m.n)}<span class="text-txtMuted text-[10px] ml-1">${Math.round((m.n / node.total.n) * 100)}%</span></td>
            <td class="py-1.5 pr-2 w-[40%]">${wdlBar(m)}</td>
            <td class="py-1.5 pr-2 text-right">${scorePill(m.score, m.n)}</td>
            <td class="py-1.5 text-right text-txtMuted whitespace-nowrap hidden sm:table-cell">${esc(relTime(m.last, ctx.now))}</td>
          </tr>`
        )
        .join('')
    : `<tr><td colspan="5">${empty(node.total.n ? 'No further moves: games ended here.' : 'No games reached this position.')}</td></tr>`;

  const recentHere = [...node.reached].sort((a, b) => b.t - a.t).slice(0, 6);
  const side = ui.color === 'w' ? 'White' : 'Black';

  return `<div class="grid gap-3 lg:grid-cols-[minmax(280px,440px)_1fr] items-start">
    <div class="grid gap-2">
      ${board}
      <div class="flex items-center gap-1.5">
        <button data-act="ex-goto" data-i="0" class="px-2.5 py-1 rounded-lg bg-surface hover:bg-surfaceHover border border-borderSubtle font-mono text-[11px]" aria-label="Start position">⏮</button>
        <button data-act="ex-back" class="px-2.5 py-1 rounded-lg bg-surface hover:bg-surfaceHover border border-borderSubtle font-mono text-[11px]" aria-label="Back one move">◀</button>
        <span class="ml-auto"></span>
        <button data-act="ex-studio" class="px-2.5 py-1 rounded-lg bg-em/15 hover:bg-em/25 text-em border border-em/35 text-[11px] font-semibold">Open in Studio ↗</button>
      </div>
    </div>
    <div class="grid gap-3 min-w-0">
      ${card(
        '',
        `<div class="flex flex-wrap items-center justify-between gap-2 mb-2">
            ${sectionTabs([['w', 'As White'], ['b', 'As Black']], ui.color, 'ex-color')}
            <span class="text-[11px] text-txtMuted"><b class="text-txt font-mono">${fmtInt(node.total.n)}</b> games · ${scorePill(node.total.score, node.total.n)} score · ${myTurn ? 'your move' : 'opponent to move'}</span>
          </div>
          <div class="flex flex-wrap items-center gap-1 text-[11.5px] mb-2">${crumbs}</div>
          ${node.total.n ? `<div class="mb-2">${wdlBar(node.total)}</div>` : ''}
          <div class="overflow-x-auto"><table class="w-full text-[11.5px]"><thead><tr class="text-left text-txtMuted text-[10px] uppercase tracking-wider"><th class="font-semibold pb-1 pr-2">Move</th><th class="font-semibold pb-1 pr-2 text-right">Games</th><th class="font-semibold pb-1 pr-2">Results (${side})</th><th class="font-semibold pb-1 pr-2 text-right">Score</th><th class="font-semibold pb-1 text-right hidden sm:table-cell">Last played</th></tr></thead><tbody>${rows}</tbody></table></div>`
      )}
      ${recentHere.length ? card('Your recent games here', recentHere.map((g) => gameRow(g, ctx, { compact: true })).join('')) : ''}
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Openings                                                            */
/* ------------------------------------------------------------------ */

export function renderOpenings(ctx) {
  const ui = ctx.ui.openings;
  const col = (color) => {
    const rows = openings(ctx.games, { color, groupBy: ui.group, minGames: ui.min, sort: ui.sort }).slice(0, 40);
    const max = Math.max(1, ...rows.map((r) => r.n));
    const total = wdl(ctx.games.filter((g) => g.color === color));
    const body = rows.length
      ? rows
          .map(
            (r) => `<button data-act="explore" data-color="${color}" data-prefix="${esc(r.prefix)}" class="w-full text-left grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 py-2 border-t border-borderSubtle/60 hover:bg-surface/50 px-1 rounded">
              <span class="min-w-0 truncate text-[12px] font-medium">${r.eco ? `<span class="font-mono text-[10px] text-txtMuted mr-1.5">${esc(r.eco)}</span>` : ''}${esc(r.name)}</span>
              <span class="text-right text-[11px] font-mono text-txtMuted">${fmtInt(r.n)} · ${scorePill(r.score, r.n)}${r.perf ? ` · ${r.perf}` : ''}</span>
              <span class="col-span-2 block" style="width:${Math.max(14, (r.n / max) * 100).toFixed(1)}%">${wdlBar(r, { labels: false, height: 'h-[8px]' })}</span>
            </button>`
          )
          .join('')
      : empty(`No openings with at least ${ui.min} games.`);
    return card(`As ${color === 'w' ? 'White' : 'Black'} · ${fmtInt(total.n)} games · ${Math.round(total.score * 100)}%`, body);
  };
  const controls = `<div class="flex flex-wrap items-center gap-2 mb-3">
      ${sectionTabs([['played', 'Most played'], ['best', 'Best'], ['worst', 'Worst']], ui.sort, 'op-sort')}
      ${sectionTabs([['family', 'Openings'], ['name', 'Variations']], ui.group, 'op-group')}
      <label class="text-[11px] text-txtMuted flex items-center gap-1.5">Min. games
        <select data-act="op-min" class="px-1.5 py-0.5 rounded-lg bg-surface border border-borderSubtle text-[11px]">${[1, 5, 10, 25, 50, 100]
          .map((v) => `<option value="${v}"${v === ui.min ? ' selected' : ''}>${v}</option>`)
          .join('')}</select></label>
      <span class="text-[11px] text-txtMuted ml-auto">Games · your score · performance. Bar length shows how often you play it. Click to explore.</span>
    </div>`;
  return `${controls}<div class="grid gap-3 lg:grid-cols-2">${col('w')}${col('b')}</div>`;
}

/* ------------------------------------------------------------------ */
/* Opponents                                                           */
/* ------------------------------------------------------------------ */

export function renderOpponents(ctx) {
  const { games } = ctx;
  if (!games.length) return empty('No games match these filters.');
  const o = opponents(games, { limit: 25 });
  const buckets = ratingBuckets(games);
  const terms = terminations(games);

  const oppTable = (rows) =>
    rows.length
      ? `<table class="w-full text-[11.5px]"><thead><tr class="text-left text-txtMuted text-[10px] uppercase tracking-wider"><th class="font-semibold pb-1">Opponent</th><th class="font-semibold pb-1 text-right">Games</th><th class="font-semibold pb-1 text-right px-2">Rating</th><th class="font-semibold pb-1 w-[38%]">Results</th><th class="font-semibold pb-1 text-right hidden md:table-cell">Last</th></tr></thead><tbody>${rows
          .map(
            (r) => `<tr class="border-t border-borderSubtle/60 hover:bg-surface/50 cursor-pointer" data-act="opp-games" data-name="${esc(r.name)}">
              <td class="py-1.5 pr-2 truncate max-w-[180px]">${r.title ? `<span class="text-am font-bold mr-1">${esc(r.title)}</span>` : ''}${esc(r.name)}</td>
              <td class="py-1.5 text-right font-mono">${fmtInt(r.n)}</td><td class="py-1.5 text-right font-mono px-2">${r.rating || '—'}</td>
              <td class="py-1.5">${wdlBar(r)}</td><td class="py-1.5 text-right text-txtMuted whitespace-nowrap hidden md:table-cell pl-2">${esc(relTime(r.last, ctx.now))}</td></tr>`
          )
          .join('')}</tbody></table>`
      : empty('None in this selection.');

  const termTable = (rows, color) =>
    rows.length
      ? rows
          .map(
            (r) => `<div class="grid grid-cols-[1fr_46px_52px] items-center gap-2 text-[11.5px] py-1 border-t border-borderSubtle/50">
              <span class="truncate">${esc(r.label)}</span>
              <span class="text-right font-mono ${color}">${fmtPct(r.share)}</span>
              <span class="text-right font-mono text-txtMuted" title="Average moves">${r.avgMoves.toFixed(0)} mv</span></div>`
          )
          .join('')
      : empty('None');

  return `<div class="grid gap-3">
    <div class="grid gap-3 lg:grid-cols-[1.1fr_1fr]">
      ${card(
        'Results by rating gap',
        `<p class="text-[11px] text-txtMuted mb-2.5">Your score against opponents rated lower or higher than you. The white tick is what Elo predicts; green means you beat the prediction.</p><div class="grid gap-1.5">${expectedVsActual(buckets)}</div>`
      )}
      ${card(
        'How games end',
        `<div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div><div class="text-[11px] font-semibold text-em mb-1">Wins · ${fmtInt(terms.totals.win)}</div>${termTable(terms.win, 'text-em')}</div>
          <div><div class="text-[11px] font-semibold text-ro mb-1">Losses · ${fmtInt(terms.totals.loss)}</div>${termTable(terms.loss, 'text-ro')}</div>
          <div><div class="text-[11px] font-semibold text-txtMuted mb-1">Draws · ${fmtInt(terms.totals.draw)}</div>${termTable(terms.draw, 'text-txt')}</div>
        </div>`
      )}
    </div>
    <div class="grid gap-3 lg:grid-cols-2">
      ${card(`Most played · ${fmtInt(o.unique)} opponents`, oppTable(o.mostPlayed))}
      ${card('Titled opponents', oppTable(o.titled))}
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Activity                                                            */
/* ------------------------------------------------------------------ */

export function renderActivity(ctx) {
  const { games } = ctx;
  if (!games.length) return empty('No games match these filters.');
  const days = byDay(games);
  const years = [...new Set(games.map((g) => new Date(g.t).getFullYear()))].sort((a, b) => b - a);
  const shownYears = years.slice(0, ctx.ui.activity.years);
  const maxN = Math.max(1, ...[...days.values()].map((v) => v.n));
  const cal = shownYears
    .map((y) => {
      const yGames = [...days.entries()].filter(([k]) => k.startsWith(`${y}-`));
      const n = yGames.reduce((a, [, v]) => a + v.n, 0);
      const active = yGames.length;
      return `<div class="mb-3 last:mb-0"><div class="flex items-baseline gap-2 mb-1"><span class="text-[12px] font-semibold">${y}</span><span class="text-[10.5px] text-txtMuted">${fmtInt(n)} games · ${active} active days</span></div>${yearCalendar(y, days, { maxN })}</div>`;
    })
    .join('');
  const more = years.length > shownYears.length ? `<button data-act="act-more" class="text-[10.5px] text-cy hover:underline">Show ${years.length - shownYears.length} older year${years.length - shownYears.length > 1 ? 's' : ''}</button>` : '';

  const tod = timeOfDay(games);
  const hourItems = tod.hours.map((h, i) => ({ label: i % 3 === 0 ? fmtHourShort(i) : '', n: h.n, score: h.n ? h.pts / h.n : 0 }));
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayItems = tod.days.map((d, i) => ({ label: dayNames[i], n: d.n, score: d.n ? d.pts / d.n : 0 }));
  const months = byMonth(games).slice(-24);
  const monthItems = months.map((m) => ({ label: m.month.slice(5) === '01' ? m.month.slice(0, 4) : '', n: m.n, score: m.score }));

  const h = habits(games);
  const habitRow = (label, r) =>
    `<div class="grid grid-cols-[110px_1fr_44px] items-center gap-2 text-[11.5px]"><span class="text-txtMuted">${label}</span>${wdlBar(r, { height: 'h-[14px]' })}<span class="text-right">${scorePill(r.score, r.n)}</span></div>`;
  const habitsHtml = `<div class="grid gap-1.5">
      ${h.bySessionPosition.map((p) => habitRow(p.label, p)).join('')}
      <div class="h-px bg-borderSubtle my-1"></div>
      ${habitRow('After a win', h.afterWin)}${habitRow('After a draw', h.afterDraw)}${habitRow('After a loss', h.afterLoss)}
      <div class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-txtMuted mt-1.5">
        <span>${fmtInt(h.sessions)} sessions · ${h.avgSessionGames.toFixed(1)} games each</span>
        <span>Longest streaks: <b class="text-em">${h.longestWin}</b> wins, <b class="text-ro">${h.longestLoss}</b> losses</span>
      </div>
    </div>`;

  return `<div class="grid gap-3">
    ${card('Every day you played', cal + more, { right: '<span class="text-[10px] text-txtMuted">Size: games · Color: score</span>' })}
    <div class="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
      ${card('Week at a glance', hourGrid(tod.grid, { hourLabel: fmtHour }))}
      ${card('Habits', `<p class="text-[11px] text-txtMuted mb-2">A session is a run of games less than 30 minutes apart.</p>${habitsHtml}`)}
    </div>
    <div class="grid gap-3 lg:grid-cols-3">
      ${card('By hour', scoreBars(hourItems))}
      ${card('By weekday', scoreBars(dayItems))}
      ${card('Games per month · 24 months', scoreBars(monthItems, { showScore: false }))}
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Rating                                                              */
/* ------------------------------------------------------------------ */

export function renderRating(ctx) {
  const { games, now } = ctx;
  const tcs = byTimeControl(games).filter((r) => r.rating);
  if (!tcs.length) return empty('No rated games in this selection.');
  const ui = ctx.ui.rating;
  const tc = tcs.some((r) => r.tc === ui.tc) ? ui.tc : tcs[0].tc;
  const series = ratingSeries(games, tc);
  const range = ui.range === 'all' ? Infinity : Number(ui.range) * DAY_MS;
  const shown = series.filter((p) => p.t >= now - range);
  const current = series[series.length - 1];
  const peak = series.reduce((a, b) => (b.r > a.r ? b : a), series[0]);
  const change = (days) => {
    const ref = [...series].reverse().find((p) => p.t <= now - days * DAY_MS);
    if (!ref || !current) return '—';
    const d = current.r - ref.r;
    return `<span class="${d >= 0 ? 'text-em' : 'text-ro'}">${d >= 0 ? '+' : '−'}${Math.abs(d)}</span>`;
  };
  const tcGames = games.filter((g) => g.tc === tc);
  const windows = performanceWindows(tcGames);
  const profileRows = ctx.profiles
    .flatMap((p) =>
      Object.entries(p.perfs || {})
        .filter(([k]) => ['bullet', 'blitz', 'rapid', 'classical', 'correspondence', 'daily'].includes(k))
        .map(([k, v]) => ({ acct: p.name, src: p.src, k, ...v }))
    )
    .filter((r) => r.games > 0);

  const stat = (label, value) => `<div><div class="text-[10.5px] text-txtMuted uppercase tracking-wider font-semibold">${label}</div><div class="text-[20px] font-bold tabular-nums leading-tight">${value}</div></div>`;
  return `<div class="grid gap-3">
    <div class="flex flex-wrap items-center gap-2">
      ${sectionTabs(tcs.map((r) => [r.tc, r.label]), tc, 'rt-tc')}
      ${sectionTabs([['90', '3M'], ['365', '1Y'], ['1095', '3Y'], ['all', 'All']], ui.range, 'rt-range')}
    </div>
    <section class="bg-panel border border-borderSubtle rounded-xl p-3">
      <div class="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-3">
        ${stat('Current', current?.r ?? '—')}
        ${stat('Peak', peak ? `${peak.r}<span class="text-[11px] text-txtMuted font-normal ml-1.5">${esc(fmtDate(peak.t))}</span>` : '—')}
        ${stat('30 days', change(30))}${stat('1 year', change(365))}${stat('Games', fmtInt(tcGames.length))}
      </div>
      ${lineChart(shown.map((p) => ({ x: p.t, y: p.r })), { height: 230, label: `${TC_LABEL[tc]} rating` })}
    </section>
    <div class="grid gap-3 lg:grid-cols-2">
      ${card(
        `Performance · ${esc(TC_LABEL[tc])}`,
        `<p class="text-[11px] text-txtMuted mb-2">The rating your results were worth over your most recent games, from your score and your opponents' ratings.</p>
        <table class="w-full text-[11.5px]"><thead><tr class="text-left text-txtMuted text-[10px] uppercase tracking-wider"><th class="font-semibold pb-1">Games</th><th class="font-semibold pb-1 text-right">Performance</th><th class="font-semibold pb-1 text-right px-2">Score</th><th class="font-semibold pb-1 w-[40%]">Results</th></tr></thead><tbody>${windows
          .map((w) => `<tr class="border-t border-borderSubtle/60"><td class="py-1.5">${esc(w.label)}</td><td class="py-1.5 text-right font-mono font-semibold">${w.perf ?? '—'}</td><td class="py-1.5 text-right px-2">${scorePill(w.score, w.n)}</td><td class="py-1.5">${wdlBar(w, { labels: false, height: 'h-[10px]' })}</td></tr>`)
          .join('')}</tbody></table>`
      )}
      ${card(
        'Ratings on your accounts',
        profileRows.length
          ? `<table class="w-full text-[11.5px]"><tbody>${profileRows
              .map((r) => `<tr class="border-t border-borderSubtle/60 first:border-0"><td class="py-1.5">${esc(r.acct)} <span class="text-txtMuted text-[10px]">${r.src === 'chesscom' ? 'Chess.com' : 'Lichess'}</span></td><td class="py-1.5 capitalize">${esc(r.k === 'correspondence' ? 'Daily' : r.k)}</td><td class="py-1.5 text-right font-mono font-semibold">${r.rating}${r.prov ? '?' : ''}</td><td class="py-1.5 text-right font-mono text-txtMuted">${fmtInt(r.games)} games</td></tr>`)
              .join('')}</tbody></table><p class="text-[10.5px] text-txtMuted mt-2">Live from each site. A ? marks a provisional rating.</p>`
          : empty('Sync an account to see its current ratings.')
      )}
    </div>
  </div>`;
}

export { movesText as formatMoves };
