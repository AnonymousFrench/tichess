/**
 * Tab renderers for the Insights page. Each takes a context and returns HTML.
 * Interactive elements carry data-act attributes handled by app.js.
 *
 * Five views, each answering one question:
 *   Overview   How am I doing, and what should I work on?
 *   Openings   Which openings work for me, and where do my games go wrong? (list + explorer)
 *   Games      Show me the games behind any number (every chart drills down here).
 *   Opponents  How do I do against stronger and weaker players, and how do games end?
 *   Progress   Is my rating moving, and when and how do I play best?
 */
import { Chess } from 'chess.js';
import {
  wdl,
  byTimeControl,
  openings,
  opponents,
  terminations,
  ratingBuckets,
  byDay,
  dayKey,
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
  PERIODS,
  ratingContext,
  seriesChange,
  recentForm,
  openingExtremes,
  versusStrength,
  gamesWithPrefix,
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
import { BOARD_ICONS } from '../shared/boardControls.js';

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

export function card(title, body, { right = '', cls = '', pad = 'p-3', sub = '' } = {}) {
  return `<section class="bg-panel border border-borderSubtle rounded-xl ${pad} min-w-0 ${cls}">
    ${
      title || right
        ? `<div class="flex items-start justify-between gap-2 mb-2.5"><div class="min-w-0"><h3 class="text-[12.5px] font-semibold text-txt">${title}</h3>${
            sub ? `<p class="text-[11px] text-txtMuted mt-0.5">${sub}</p>` : ''
          }</div>${right}</div>`
        : ''
    }
    ${body}
  </section>`;
}

const empty = (msg) => `<div class="py-6 text-center text-txtMuted text-[11.5px]">${msg}</div>`;

const linkBtn = (label, attrs) => `<button ${attrs} class="shrink-0 text-[11px] text-cy hover:underline whitespace-nowrap">${label}</button>`;

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
  `<span class="inline-block w-2.5 h-2.5 rounded-[3px] border shrink-0 ${c === 'w' ? 'bg-[#e5e7eb] border-[#9aa3b5]' : 'bg-[#2a2f3a] border-[#5b6273]'}" title="${c === 'w' ? 'White' : 'Black'}"></span>`;

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

/** Signed change with an arrow: green when up is good. */
function delta(value, { unit = '', good = 1, digits = 0 } = {}) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  const r = Number(value.toFixed(digits));
  if (r === 0) return '<span class="text-txtMuted">no change</span>';
  const up = r > 0;
  const cls = up === good > 0 ? 'text-em' : 'text-ro';
  return `<span class="${cls} font-semibold">${up ? '▲' : '▼'} ${up ? '+' : '−'}${Math.abs(r)}${unit}</span>`;
}

const sectionTabs = (items, active, act) =>
  `<div class="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-surface border border-borderSubtle text-[11px]">${items
    .map(
      ([v, l]) =>
        `<button data-act="${act}" data-v="${esc(v)}" class="px-2 py-0.5 rounded-md font-semibold ${v === active ? 'bg-txt text-bg' : 'text-txtMuted hover:text-txt'}" aria-pressed="${v === active}">${esc(l)}</button>`
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

function clockLabel(clock) {
  const [b, i] = clock.split('+').map(Number);
  if (!Number.isFinite(b)) return clock;
  const base = b >= 60 && b % 60 === 0 ? `${b / 60}` : b >= 60 ? `${(b / 60).toFixed(1)}` : `${b}s`;
  return `${base}+${i || 0}`;
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

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

function formStrip(games) {
  const form = recentForm(games, 20);
  if (!form.length) return '';
  const cells = form
    .map((g) => {
      const c = g.res === 1 ? 'bg-em' : g.res === 0 ? 'bg-ro' : 'bg-[#5b6273]';
      const label = `${g.res === 1 ? 'Won' : g.res === 0 ? 'Lost' : 'Drew'} vs ${g.op}${g.opR ? ` (${g.opR})` : ''}, ${relTime(g.t)}`;
      return `<button data-act="open-game" data-id="${esc(g.id)}" class="w-3.5 h-3.5 rounded-[3px] ${c} hover:ring-2 hover:ring-txt/50" title="${esc(label)}" aria-label="${esc(label)}"></button>`;
    })
    .join('');
  const w = form.filter((g) => g.res === 1).length;
  const l = form.filter((g) => g.res === 0).length;
  return `<div class="flex items-center gap-2 flex-wrap"><span class="text-[11px] text-txtMuted">Last ${form.length}</span><div class="flex gap-[3px]">${cells}</div><span class="text-[11px] text-txtMuted font-mono">${w}W ${form.length - w - l}D ${l}L</span></div>`;
}

const TONE = {
  good: { box: 'border-em/40 bg-em/[0.06]', icon: '▲', color: 'text-em' },
  bad: { box: 'border-ro/40 bg-ro/[0.06]', icon: '▼', color: 'text-ro' },
  info: { box: 'border-cy/35 bg-cy/[0.05]', icon: '●', color: 'text-cy' },
};

/** Buttons for a finding: where to look next. */
function takeawayActions(t, i) {
  const l = t.link || {};
  const btn = (label, act) =>
    `<button data-act="${act}" data-i="${i}" class="px-2 py-0.5 rounded-md bg-surface hover:bg-surfaceHover border border-borderSubtle text-[10.5px] font-semibold text-txt">${label}</button>`;
  if (l.tab === 'explorer') return btn('Explore the line', 'takeaway') + btn('See the games', 'takeaway-games');
  if (l.tab === 'games') return btn('See the games', 'takeaway');
  if (l.tab === 'rating') return btn('Rating chart', 'takeaway');
  if (l.tab === 'activity') return btn('When you play best', 'takeaway');
  if (l.tab === 'openings') return btn('Compare openings', 'takeaway');
  return '';
}

function openingsSnapshot(games) {
  const col = (color) => {
    const x = openingExtremes(games, color);
    const side = color === 'w' ? 'White' : 'Black';
    const row = (r, tone) => `<button data-act="explore" data-color="${color}" data-prefix="${esc(r.prefix)}" class="w-full grid grid-cols-[1fr_auto_44px] items-center gap-2 py-1 px-1 -mx-1 rounded text-left text-[11.5px] hover:bg-surface/70">
        <span class="truncate">${esc(r.name)}</span><span class="font-mono text-[10.5px] text-txtMuted">${fmtInt(r.n)}</span><span class="text-right font-mono text-[11px] font-semibold ${tone}">${Math.round(r.score * 100)}%</span></button>`;
    const list = (rows, tone, label, none) =>
      `<div class="text-[10.5px] font-semibold ${tone} mt-1.5 mb-0.5">${label}</div>${rows.length ? rows.map((r) => row(r, tone)).join('') : `<div class="text-[11px] text-txtMuted py-1">${none}</div>`}`;
    return `<div class="min-w-0">
        <div class="flex items-center gap-1.5 text-[11.5px] font-semibold">${colorDot(color)}As ${side} <span class="text-txtMuted font-normal">· ${fmtInt(x.n)} games · avg ${x.n ? Math.round(x.base * 100) : 0}%</span></div>
        ${list(x.best, 'text-em', 'Working well', 'Nothing clearly above your average yet.')}
        ${list(x.worst, 'text-ro', 'Costing you points', 'Nothing clearly below your average.')}
      </div>`;
  };
  return `<div class="grid gap-4 sm:grid-cols-2">${col('w')}${col('b')}</div>`;
}

function strengthVerdict(vs) {
  const line = (b, who) => {
    if (b.n < 10) return '';
    const d = Math.round((b.score - b.expected) * 100);
    const verdict = Math.abs(d) < 2 ? 'as ratings predict' : d > 0 ? `${d} pts better than ratings predict` : `${-d} pts worse than ratings predict`;
    return `<div class="flex items-baseline justify-between gap-2 text-[11.5px]"><span>Against ${who} <span class="text-txtMuted">(${fmtInt(b.n)} games)</span></span><span class="${d >= 2 ? 'text-em' : d <= -2 ? 'text-ro' : 'text-txtMuted'} font-semibold text-right">${Math.round(b.score * 100)}%, ${verdict}</span></div>`;
  };
  return [line(vs.stronger, 'stronger players'), line(vs.weaker, 'weaker players')].filter(Boolean).join('');
}

export function renderOverview(ctx) {
  const { games, now } = ctx;
  if (!games.length) return empty('No games match these filters.');
  const total = wdl(games);
  const tcs = byTimeControl(games);
  const main = tcs.find((r) => r.rating) || tcs[0];
  const recent = [...games].sort((a, b) => b.t - a.t);
  const periodMs = PERIODS[ctx.ui.filters.period]?.ms ?? Infinity;
  const periodLabel = Number.isFinite(periodMs) ? PERIODS[ctx.ui.filters.period].label.toLowerCase() : 'all time';
  const prev = ctx.prevGames && ctx.prevGames.length >= 5 ? ctx.prevGames : null;
  const prevW = prev ? wdl(prev) : null;
  const rc = ratingContext(games);
  const series = ratingSeries(games, main.tc);
  const change = seriesChange(series);

  const kpi = (label, value, sub = '') =>
    `<div class="min-w-0"><div class="text-[11px] text-txtMuted">${label}</div><div class="text-[24px] font-bold leading-tight tabular-nums">${value}</div><div class="text-[11px] text-txtMuted truncate min-h-[16px]">${sub}</div></div>`;

  const kpis = `<section class="bg-panel border border-borderSubtle rounded-xl p-3 grid gap-3">
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        ${kpi('Games', fmtInt(total.n), prev ? `${delta(((total.n - prev.length) / prev.length) * 100, { unit: '%' })} vs previous ${esc(periodLabel)}` : `${fmtInt(total.w)} W · ${fmtInt(total.d)} D · ${fmtInt(total.l)} L`)}
        ${kpi('Score', `<span style="color:${scoreColor(total.score)}">${Math.round(total.score * 100)}%</span>`, prevW ? `${delta((total.score - prevW.score) * 100, { unit: ' pts' })} vs previous ${esc(periodLabel)}` : 'points per game, draws count half')}
        ${kpi(`${esc(main.label)} rating`, main.rating || '—', change !== null ? `${delta(change)} over ${esc(periodLabel)}${main.peak ? ` · peak ${main.peak}` : ''}` : main.peak ? `Peak ${main.peak}` : '')}
        ${kpi('Performance', rc.perf ?? '—', rc.diff !== null ? `${delta(rc.diff)} vs your rating (${rc.own})` : 'rating your results were worth')}
      </div>
      <div class="grid gap-2 md:grid-cols-[1fr_auto] items-center">
        ${wdlBar(total)}
        ${formStrip(games)}
      </div>
    </section>`;

  const takes = takeaways(games, now);
  ctx.setTakeaways(takes);
  const takeHtml = takes.length
    ? `<div class="grid gap-2">${takes
        .map((t, i) => {
          const tone = TONE[t.tone] || TONE.info;
          return `<div class="rounded-lg border ${tone.box} px-3 py-2">
            <div class="flex items-start gap-2"><span class="${tone.color} text-[10px] mt-[3px]">${tone.icon}</span><div class="min-w-0 flex-1">
            <div class="text-[12.5px] font-semibold text-txt">${esc(t.title)}</div><div class="text-[11.5px] text-txtMuted">${esc(t.detail)}</div>
            <div class="flex flex-wrap gap-1.5 mt-1.5">${takeawayActions(t, i)}</div></div></div></div>`;
        })
        .join('')}</div>`
    : empty('Play at least 30 games in this selection to see patterns.');

  const shownSeries = Number.isFinite(periodMs) ? series : series.filter((p) => p.t >= now - 365 * DAY_MS);
  const ratingChart = lineChart(
    shownSeries.map((p) => ({ x: p.t, y: p.r })),
    { height: 190, label: `${main.label} rating` }
  );

  const vs = versusStrength(games);
  const buckets = ratingBuckets(games);
  const strength = `<div class="grid gap-1.5 mb-3">${strengthVerdict(vs) || '<div class="text-[11px] text-txtMuted">Not enough rated games against stronger or weaker players.</div>'}</div><div class="grid gap-1.5">${expectedVsActual(buckets)}</div>`;

  const terms = terminations(games);
  const termRows = (rows, outcome, cls) =>
    rows
      .slice(0, 3)
      .map(
        (r) => `<button data-act="term-games" data-outcome="${outcome}" data-term="${esc(r.term)}" class="w-full flex items-center justify-between text-[11.5px] py-0.5 hover:text-txt text-txtMuted"><span>${esc(r.label)}</span><span class="font-mono ${cls}">${fmtPct(r.share)}</span></button>`
      )
      .join('');
  const endings = `<div class="grid grid-cols-2 gap-4"><div><div class="text-[10.5px] font-semibold text-em mb-1">Wins by</div>${termRows(terms.win, 'win', 'text-em')}</div><div><div class="text-[10.5px] font-semibold text-ro mb-1">Losses by</div>${termRows(terms.loss, 'loss', 'text-ro')}</div></div>`;

  const tcTable = `<table class="w-full text-[11.5px]"><tbody>${tcs
    .map(
      (r) => `<tr class="border-t border-borderSubtle/60 first:border-0"><td class="py-1.5 font-medium"><button data-act="set-filter" data-k="tc" data-v="${r.tc}" class="hover:text-em" title="Show only ${esc(r.label)}">${esc(r.label)}</button></td><td class="py-1.5 text-right font-mono text-txtMuted">${fmtInt(r.n)}</td><td class="py-1.5 text-right font-mono px-2">${r.rating || '—'}</td><td class="py-1.5 w-[45%]">${wdlBar(r, { labels: false, height: 'h-[10px]' })}</td></tr>`
    )
    .join('')}</tbody></table>`;

  const recentList = recent
    .slice(0, 6)
    .map((g) => gameRow(g, ctx, { compact: true }))
    .join('');

  return `<div class="grid gap-3">
    ${kpis}
    <div class="grid gap-3 lg:grid-cols-[1.1fr_1fr] items-start">
      ${card('What to work on', takeHtml, { sub: 'The patterns that move your results most, largest first.' })}
      ${card(`${esc(main.label)} rating`, ratingChart, { right: linkBtn('Progress', 'data-act="tab" data-v="progress"') })}
    </div>
    <div class="grid gap-3 lg:grid-cols-[1.1fr_1fr] items-start">
      ${card('Your openings', openingsSnapshot(games), { sub: 'Compared with your own average for each color. Click one to explore it.', right: linkBtn('All openings', 'data-act="tab" data-v="openings"') })}
      ${card('Against stronger and weaker players', strength, { sub: 'Your score by rating gap. The white tick is what Elo predicts.' })}
    </div>
    <div class="grid gap-3 lg:grid-cols-3 items-start">
      ${card('Time controls', tcTable)}
      ${card('How games end', endings, { sub: 'Click to see those games.' })}
      ${card('Recent games', recentList, { right: linkBtn('All games', 'data-act="tab" data-v="games"') })}
    </div>
  </div>`;
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
  if (ui.day) rows = rows.filter((g) => dayKey(g.t) === ui.day);
  if (ui.prefix) rows = gamesWithPrefix(rows, ui.prefix, ui.pcolor || null);
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

function drillChips(ui) {
  const chip = (label, key) =>
    `<span class="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-cy/15 border border-cy/35 text-cy text-[11px] font-semibold">${label}<button data-act="games-clear" data-k="${key}" class="w-4 h-4 rounded-full hover:bg-cy/25 leading-none" aria-label="Remove filter">×</button></span>`;
  const out = [];
  if (ui.prefix) out.push(chip(`${ui.pcolor === 'b' ? 'As Black' : ui.pcolor === 'w' ? 'As White' : ''} ${esc(movesText(ui.prefix.split(' ')))}`.trim(), 'prefix'));
  if (ui.day) out.push(chip(esc(new Date(`${ui.day}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })), 'day'));
  return out.join('');
}

export function renderGames(ctx) {
  const ui = ctx.ui.games;
  const rows = filterGamesTab(ctx.games, ui);
  const shown = rows.slice(0, ui.limit);
  const sel = (key, opts, value, label) =>
    `<select data-act="games-ui" data-k="${key}" aria-label="${label}" class="px-2 py-1 rounded-lg border text-[11.5px] focus:outline-none focus:border-em ${
      value && value !== 'all' && key !== 'sort' ? 'bg-em/15 border-em/40 text-em' : 'bg-surface border-borderSubtle'
    }">${opts.map(([v, l]) => `<option value="${v}"${v === value ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  const terms = [['all', 'Any ending'], ...Object.entries(TERM_LABEL)];
  const r = wdl(rows);
  const toolbar = `<div class="flex flex-wrap items-center gap-2 mb-2.5">
      <input data-act="games-search" value="${esc(ui.search)}" placeholder="Search opponent or opening…" class="flex-1 min-w-[180px] max-w-[320px] px-2.5 py-1 rounded-lg bg-surface border border-borderSubtle text-[16px] sm:text-[11.5px] focus:outline-none focus:border-em" aria-label="Search games">
      ${sel('outcome', [['all', 'All results'], ['win', 'Wins'], ['draw', 'Draws'], ['loss', 'Losses']], ui.outcome, 'Result')}
      ${sel('term', terms, ui.term, 'Ending')}
      ${sel('sort', [['new', 'Newest'], ['old', 'Oldest'], ['opp', 'Strongest opponent'], ['long', 'Longest'], ['short', 'Shortest']], ui.sort, 'Sort')}
      ${drillChips(ui)}
      <span class="ml-auto flex items-center gap-2">
        <span class="text-[11px] text-txtMuted font-mono">${fmtInt(rows.length)} games · ${scorePill(r.score, rows.length)}</span>
        <button data-act="export-pgn" class="px-2.5 py-1 rounded-lg bg-surface hover:bg-surfaceHover border border-borderSubtle text-[11px] font-semibold" ${rows.length ? '' : 'disabled'}>Download PGN</button>
      </span>
    </div>
    ${rows.length ? `<div class="mb-2.5">${wdlBar(r, { height: 'h-[8px]', labels: false })}</div>` : ''}`;
  const table = shown.length
    ? `<div class="overflow-x-auto"><table class="w-full text-[11.5px]"><thead><tr class="text-left text-txtMuted text-[10px] uppercase tracking-wider">
        <th class="font-semibold pb-1.5 pr-2">Played</th><th class="font-semibold pb-1.5 pr-2">Time</th><th class="font-semibold pb-1.5 pr-2"></th><th class="font-semibold pb-1.5 pr-2">Result</th><th class="font-semibold pb-1.5 pr-2">Opponent</th><th class="font-semibold pb-1.5 pr-2 text-right">Moves</th><th class="font-semibold pb-1.5 pr-2 hidden lg:table-cell">Opening</th><th></th></tr></thead>
        <tbody>${shown.map((g) => gameRow(g, ctx)).join('')}</tbody></table></div>
        ${rows.length > shown.length ? `<div class="flex justify-center mt-3"><button data-act="games-more" class="px-3 py-1.5 rounded-lg bg-surface hover:bg-surfaceHover border border-borderSubtle text-[11.5px] font-semibold">Show more (${fmtInt(rows.length - shown.length)} left)</button></div>` : ''}`
    : empty('No games match.');
  return card('', toolbar + table);
}

/* ------------------------------------------------------------------ */
/* Openings: your repertoire in numbers (left) + your own explorer     */
/* ------------------------------------------------------------------ */

function explorerPanel(ctx) {
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
  const flipped = ui.flipped ?? ui.color === 'b';
  const board = miniBoardHtml(fen, { flipped, last, arrows });
  const fullPath = Array.isArray(ui.fullPath) ? ui.fullPath : [];
  const hasFullFwd = fullPath.length > ui.path.length && ui.path.every((s, i) => fullPath[i] === s);
  const topSan = node.moves[0]?.san || '';
  const atStart = ui.path.length === 0;
  const canFwd = hasFullFwd || Boolean(topSan);
  const canLast = hasFullFwd;
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

  const recentHere = [...node.reached].sort((a, b) => b.t - a.t).slice(0, 5);
  const side = ui.color === 'w' ? 'White' : 'Black';
  return `<div class="grid gap-3 xl:grid-cols-[minmax(240px,360px)_1fr] items-start min-w-0" id="insExplorer">
    <div class="grid gap-1.5">
      ${board}
      <div class="board-controls board-controls-bare">
        <div class="board-nav" role="group" aria-label="Move navigation">
          <button data-act="ex-goto" data-i="0" class="board-btn board-btn-nav" title="First move" aria-label="Start position" ${atStart ? 'disabled' : ''}>${BOARD_ICONS.first}</button>
          <button data-act="ex-back" class="board-btn board-btn-nav" title="Previous move" aria-label="Back one move" ${atStart ? 'disabled' : ''}>${BOARD_ICONS.prev}</button>
          <button data-act="ex-fwd" data-top="${esc(topSan)}" class="board-btn board-btn-nav" title="Next move" aria-label="Forward one move" ${canFwd ? '' : 'disabled'}>${BOARD_ICONS.next}</button>
          <button data-act="ex-last" class="board-btn board-btn-nav" title="Last move" aria-label="Last move" ${canLast ? '' : 'disabled'}>${BOARD_ICONS.last}</button>
        </div>
        <div class="board-actions">
          <button data-act="ex-flip" class="board-btn board-btn-ico" title="Flip board" aria-label="Flip board">${BOARD_ICONS.flip}</button>
          <button data-act="ex-studio" class="board-btn board-btn-ico board-btn-em" title="Open in Studio" aria-label="Open in Studio">${BOARD_ICONS.studio}</button>
        </div>
      </div>
    </div>
    <div class="grid gap-3 min-w-0">
      ${card(
        '',
        `<div class="flex flex-wrap items-center gap-1 text-[11.5px] mb-1.5">${crumbs}</div>
          <div class="flex flex-wrap items-center justify-between gap-2 mb-2 text-[11px] text-txtMuted">
            <span><b class="text-txt font-mono">${fmtInt(node.total.n)}</b> games as ${side} · ${scorePill(node.total.score, node.total.n)} · ${myTurn ? 'your move' : 'opponent to move'}</span>
            ${node.total.n ? `<button data-act="ex-games" class="text-cy hover:underline">See these ${fmtInt(node.total.n)} games</button>` : ''}
          </div>
          ${node.total.n ? `<div class="mb-2">${wdlBar(node.total, { height: 'h-[10px]', labels: false })}</div>` : ''}
          <div class="overflow-x-auto"><table class="w-full text-[11.5px]"><thead><tr class="text-left text-txtMuted text-[10px] uppercase tracking-wider"><th class="font-semibold pb-1 pr-2">Move</th><th class="font-semibold pb-1 pr-2 text-right">Games</th><th class="font-semibold pb-1 pr-2">Results</th><th class="font-semibold pb-1 pr-2 text-right">Score</th><th class="font-semibold pb-1 text-right hidden sm:table-cell">Last played</th></tr></thead><tbody>${rows}</tbody></table></div>`
      )}
      ${recentHere.length ? card('Your latest games here', recentHere.map((g) => gameRow(g, ctx, { compact: true })).join('')) : ''}
    </div>
  </div>`;
}

export function renderOpenings(ctx) {
  const ui = ctx.ui.openings;
  const color = ctx.ui.explorer.color;
  const colorGames = ctx.games.filter((g) => g.color === color);
  const total = wdl(colorGames);
  const rows = openings(ctx.games, { color, groupBy: ui.group, minGames: ui.min, sort: ui.sort }).slice(0, 60);
  const max = Math.max(1, ...rows.map((r) => r.n));
  const path = ctx.ui.explorer.path.join(' ');
  // The row whose line the explorer is in (longest matching prefix).
  let activePrefix = '';
  for (const r of rows) {
    if (r.prefix && (path === r.prefix || path.startsWith(`${r.prefix} `)) && r.prefix.length > activePrefix.length) activePrefix = r.prefix;
  }
  const list = rows.length
    ? rows
        .map((r) => {
          const on = r.prefix && r.prefix === activePrefix;
          return `<button data-act="op-pick" data-color="${color}" data-prefix="${esc(r.prefix)}" class="w-full text-left grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 py-1.5 px-2 rounded-lg border ${on ? 'bg-em/10 border-em/40' : 'border-transparent hover:bg-surface/60'}">
              <span class="min-w-0 truncate text-[12px] font-medium">${r.eco ? `<span class="font-mono text-[10px] text-txtMuted mr-1.5">${esc(r.eco)}</span>` : ''}${esc(r.name)}</span>
              <span class="text-right text-[11px] font-mono text-txtMuted">${fmtInt(r.n)} · ${scorePill(r.score, r.n)}</span>
              <span class="col-span-2 block" style="width:${Math.max(14, (r.n / max) * 100).toFixed(1)}%">${wdlBar(r, { labels: false, height: 'h-[6px]' })}</span>
            </button>`;
        })
        .join('')
    : empty(`No openings with at least ${ui.min} games.`);

  const controls = `<div class="flex flex-wrap items-center gap-2">
      ${sectionTabs([['w', 'As White'], ['b', 'As Black']], color, 'ex-color')}
      ${sectionTabs([['played', 'Most played'], ['best', 'Best'], ['worst', 'Worst']], ui.sort, 'op-sort')}
      ${sectionTabs([['family', 'Openings'], ['name', 'Variations']], ui.group, 'op-group')}
      <label class="text-[11px] text-txtMuted flex items-center gap-1.5">Min. games
        <select data-act="op-min" class="px-1.5 py-0.5 rounded-lg bg-surface border border-borderSubtle text-[11px]">${[1, 5, 10, 25, 50, 100]
          .map((v) => `<option value="${v}"${v === ui.min ? ' selected' : ''}>${v}</option>`)
          .join('')}</select></label>
    </div>`;

  return `<div class="grid gap-3">
    ${controls}
    <div class="grid gap-3 lg:grid-cols-[minmax(280px,380px)_1fr] items-start">
      ${card(
        `As ${color === 'w' ? 'White' : 'Black'} · ${fmtInt(total.n)} games · ${Math.round(total.score * 100)}%`,
        `<div class="grid gap-0.5 lg:max-h-[calc(100vh-190px)] lg:overflow-y-auto -mx-1 px-1">${list}</div>`,
        { sub: 'Games · your score. Pick one to explore it move by move.' }
      )}
      ${explorerPanel(ctx)}
    </div>
  </div>`;
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
  const vs = versusStrength(games);

  const oppTable = (rows) =>
    rows.length
      ? `<table class="w-full text-[11.5px]"><thead><tr class="text-left text-txtMuted text-[10px] uppercase tracking-wider"><th class="font-semibold pb-1">Opponent</th><th class="font-semibold pb-1 text-right">Games</th><th class="font-semibold pb-1 text-right px-2">Rating</th><th class="font-semibold pb-1 w-[38%]">Results</th><th class="font-semibold pb-1 text-right hidden md:table-cell">Last</th></tr></thead><tbody>${rows
          .map(
            (r) => `<tr class="border-t border-borderSubtle/60 hover:bg-surface/50 cursor-pointer" data-act="opp-games" data-name="${esc(r.name)}" title="See your games against ${esc(r.name)}">
              <td class="py-1.5 pr-2 truncate max-w-[180px]">${r.title ? `<span class="text-am font-bold mr-1">${esc(r.title)}</span>` : ''}${esc(r.name)}</td>
              <td class="py-1.5 text-right font-mono">${fmtInt(r.n)}</td><td class="py-1.5 text-right font-mono px-2">${r.rating || '—'}</td>
              <td class="py-1.5">${wdlBar(r)}</td><td class="py-1.5 text-right text-txtMuted whitespace-nowrap hidden md:table-cell pl-2">${esc(relTime(r.last, ctx.now))}</td></tr>`
          )
          .join('')}</tbody></table>`
      : empty('None in this selection.');

  const termTable = (rows, outcome, color) =>
    rows.length
      ? rows
          .map(
            (r) => `<button data-act="term-games" data-outcome="${outcome}" data-term="${esc(r.term)}" class="w-full grid grid-cols-[1fr_46px_52px] items-center gap-2 text-[11.5px] py-1 border-t border-borderSubtle/50 text-left hover:bg-surface/50">
              <span class="truncate">${esc(r.label)}</span>
              <span class="text-right font-mono ${color}">${fmtPct(r.share)}</span>
              <span class="text-right font-mono text-txtMuted" title="Average moves">${r.avgMoves.toFixed(0)} mv</span></button>`
          )
          .join('')
      : empty('None');

  return `<div class="grid gap-3">
    <div class="grid gap-3 lg:grid-cols-[1.1fr_1fr]">
      ${card(
        'Results by rating gap',
        `<div class="grid gap-1.5 mb-3">${strengthVerdict(vs)}</div><div class="grid gap-1.5">${expectedVsActual(buckets)}</div>`,
        { sub: 'Your score against opponents rated lower or higher than you. The white tick is what Elo predicts.' }
      )}
      ${card(
        'How games end',
        `<div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div><div class="text-[11px] font-semibold text-em mb-1">Wins · ${fmtInt(terms.totals.win)}</div>${termTable(terms.win, 'win', 'text-em')}</div>
          <div><div class="text-[11px] font-semibold text-ro mb-1">Losses · ${fmtInt(terms.totals.loss)}</div>${termTable(terms.loss, 'loss', 'text-ro')}</div>
          <div><div class="text-[11px] font-semibold text-txtMuted mb-1">Draws · ${fmtInt(terms.totals.draw)}</div>${termTable(terms.draw, 'draw', 'text-txt')}</div>
        </div>`,
        { sub: 'Click a line to see those games.' }
      )}
    </div>
    <div class="grid gap-3 lg:grid-cols-2">
      ${card(`Most played · ${fmtInt(o.unique)} opponents`, oppTable(o.mostPlayed))}
      ${card('Titled opponents', oppTable(o.titled))}
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Progress: rating, then activity and habits                          */
/* ------------------------------------------------------------------ */

function ratingSection(ctx) {
  const { games, now } = ctx;
  const tcs = byTimeControl(games).filter((r) => r.rating);
  if (!tcs.length) return card('Rating', empty('No rated games in this selection.'));
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
    return delta(current.r - ref.r) || '—';
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

  const stat = (label, value) => `<div><div class="text-[11px] text-txtMuted">${label}</div><div class="text-[20px] font-bold tabular-nums leading-tight">${value}</div></div>`;
  return `<div class="grid gap-3">
    <section class="bg-panel border border-borderSubtle rounded-xl p-3">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 class="text-[12.5px] font-semibold">Rating</h3>
        <div class="flex flex-wrap items-center gap-2">
          ${sectionTabs(tcs.map((r) => [r.tc, r.label]), tc, 'rt-tc')}
          ${sectionTabs([['90', '3M'], ['365', '1Y'], ['1095', '3Y'], ['all', 'All']], ui.range, 'rt-range')}
        </div>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-3">
        ${stat('Current', current?.r ?? '—')}
        ${stat('Peak', peak ? `${peak.r}<span class="text-[11px] text-txtMuted font-normal ml-1.5">${esc(fmtDate(peak.t))}</span>` : '—')}
        ${stat('30 days', `<span class="text-[16px]">${change(30)}</span>`)}${stat('1 year', `<span class="text-[16px]">${change(365)}</span>`)}${stat('Games', fmtInt(tcGames.length))}
      </div>
      ${lineChart(shown.map((p) => ({ x: p.t, y: p.r })), { height: 230, label: `${TC_LABEL[tc]} rating` })}
    </section>
    <div class="grid gap-3 lg:grid-cols-2">
      ${card(
        `Performance · ${esc(TC_LABEL[tc])}`,
        `<table class="w-full text-[11.5px]"><thead><tr class="text-left text-txtMuted text-[10px] uppercase tracking-wider"><th class="font-semibold pb-1">Games</th><th class="font-semibold pb-1 text-right">Performance</th><th class="font-semibold pb-1 text-right px-2">Score</th><th class="font-semibold pb-1 w-[40%]">Results</th></tr></thead><tbody>${windows
          .map((w) => `<tr class="border-t border-borderSubtle/60"><td class="py-1.5">${esc(w.label)}</td><td class="py-1.5 text-right font-mono font-semibold">${w.perf ?? '—'}</td><td class="py-1.5 text-right px-2">${scorePill(w.score, w.n)}</td><td class="py-1.5">${wdlBar(w, { labels: false, height: 'h-[10px]' })}</td></tr>`)
          .join('')}</tbody></table>`,
        { sub: 'The rating your results were worth over your most recent games.' }
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

function activitySection(ctx) {
  const { games } = ctx;
  const days = byDay(games);
  const years = [...new Set(games.map((g) => new Date(g.t).getFullYear()))].sort((a, b) => b - a);
  const shownYears = years.slice(0, ctx.ui.activity.years);
  const maxN = Math.max(1, ...[...days.values()].map((v) => v.n));
  const cal = shownYears
    .map((y) => {
      const yGames = [...days.entries()].filter(([k]) => k.startsWith(`${y}-`));
      const n = yGames.reduce((a, [, v]) => a + v.n, 0);
      return `<div class="mb-3 last:mb-0"><div class="flex items-baseline gap-2 mb-1"><span class="text-[12px] font-semibold">${y}</span><span class="text-[10.5px] text-txtMuted">${fmtInt(n)} games · ${yGames.length} active days</span></div>${yearCalendar(y, days, { maxN })}</div>`;
    })
    .join('');
  const more = years.length > shownYears.length ? `<button data-act="act-more" class="text-[11px] text-cy hover:underline">Show ${years.length - shownYears.length} older year${years.length - shownYears.length > 1 ? 's' : ''}</button>` : '';

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
    <div class="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
      ${card('When you play best', hourGrid(tod.grid, { hourLabel: fmtHour }), { sub: 'Square size: games played. Color: your score.' })}
      ${card('Habits', habitsHtml, { sub: 'A session is a run of games less than 30 minutes apart.' })}
    </div>
    <div class="grid gap-3 lg:grid-cols-3">
      ${card('By hour', scoreBars(hourItems))}
      ${card('By weekday', scoreBars(dayItems))}
      ${card('Games per month', scoreBars(monthItems, { showScore: false }), { sub: 'Last 24 months' })}
    </div>
    ${card('Every day you played', cal + more, { sub: 'Click a day to see its games.' })}
  </div>`;
}

export function renderProgress(ctx) {
  if (!ctx.games.length) return empty('No games match these filters.');
  return `<div class="grid gap-3">${ratingSection(ctx)}${activitySection(ctx)}</div>`;
}

export { movesText as formatMoves };
