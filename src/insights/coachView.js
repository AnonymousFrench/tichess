/**
 * Coach tab renderer for Insights ("+100 Elo" plan, engine/clock diagnostics,
 * +100 Elo opening benchmark, and spaced-repetition blunder drills).
 *
 * Matches the compact, calm density of views.js: no oversized hero banners or
 * splashy buttons.
 */
import { card, movesText } from './views.js';
import { esc, fmtInt, fmtPct, scoreColor, wdlBar } from './charts.js';
import { miniBoardHtml } from './miniBoard.js';
import {
  gameLengthProfile,
  findOpeningCliffs,
  aggregateDiagnostics,
  buildEloPlan,
} from './coach.js';
import { extractDrillDeck } from './drills.js';
import { targetRatingBrackets } from './benchmark.js';
import { extractBlunderCheckDeck, extractConvertDeck } from '../train/grading.js';
import { renderTrainCard } from './trainView.js';
import { renderToday } from './todayView.js';

const empty = (msg) => `<div class="py-6 text-center text-txtMuted text-[11.5px]">${msg}</div>`;

const sectionTabs = (items, active, act) =>
  `<div class="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-surface border border-borderSubtle text-[11px]">${items
    .map(
      ([v, l]) =>
        `<button data-act="${act}" data-v="${esc(v)}" class="px-2 py-0.5 rounded-md font-semibold whitespace-nowrap ${v === active ? 'bg-txt text-bg' : 'text-txtMuted hover:text-txt'}" aria-pressed="${v === active}">${esc(l)}</button>`
    )
    .join('')}</div>`;

const smBtn = (label, attrs, tone = '') =>
  `<button ${attrs} class="px-2 py-0.5 rounded-md border text-[10.5px] font-semibold whitespace-nowrap ${
    tone === 'em'
      ? 'bg-em/15 hover:bg-em/25 border-em/35 text-em'
      : tone === 'ro'
        ? 'bg-ro/15 hover:bg-ro/25 border-ro/35 text-ro'
        : 'bg-surface hover:bg-surfaceHover border-borderSubtle text-txt'
  }">${label}</button>`;

const linkBtn = (label, attrs) =>
  `<button ${attrs} class="shrink-0 text-[11px] text-cy hover:underline whitespace-nowrap">${label}</button>`;

function fmtClockSec(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function accColor(acc) {
  if (acc === null || acc === undefined) return 'text-txtMuted';
  if (acc >= 83) return 'text-em';
  if (acc >= 72) return 'text-am';
  return 'text-ro';
}

function accBarColor(acc) {
  if (acc >= 83) return '#10b981';
  if (acc >= 72) return '#f59e0b';
  return '#fb7185';
}

/* ------------------------------------------------------------------ */
/* Top controls + scan strip                                           */
/* ------------------------------------------------------------------ */

function coachTopBar(ctx, diag, unanalyzedCount) {
  const ui = ctx.ui.coach;
  const scan = ctx.scan;
  const cov = diag.coverage;

  let scanControls;
  if (scan) {
    const pct = scan.totalGames
      ? Math.round(((scan.gameIdx + (scan.plyIdx / Math.max(1, scan.totalPlies))) / scan.totalGames) * 100)
      : 0;
    scanControls = `<span class="flex items-center gap-2 text-[11px] text-txtMuted">
      <span class="w-2 h-2 rounded-full bg-em animate-pulse shrink-0"></span>
      <span class="font-mono">Scanning ${scan.gameIdx + 1}/${scan.totalGames} (${pct}%)</span>
      ${smBtn('Stop', 'data-act="coach-scan-stop"', 'ro')}
    </span>`;
  } else {
    const countSel = `<select data-act="coach-scan-count" aria-label="Games to scan" class="px-1.5 py-0.5 rounded-md bg-surface border border-borderSubtle text-[11px] text-txt">${[10, 25, 50]
      .map((n) => `<option value="${n}"${n === ui.scanCount ? ' selected' : ''}>Last ${n}</option>`)
      .join('')}</select>`;
    const toScan = Math.min(ui.scanCount, unanalyzedCount);
    scanControls = `<span class="flex items-center gap-1.5 flex-wrap">
      <span class="text-[11px] text-txtMuted font-mono">${fmtInt(cov.analyzed)}/${fmtInt(cov.total)} analyzed</span>
      ${countSel}
      ${
        toScan > 0
          ? smBtn(`Scan ${toScan} (Stockfish)`, 'data-act="coach-scan"', 'em')
          : '<span class="text-[11px] text-em font-medium">Recent games scanned</span>'
      }
    </span>`;
  }

  const progBar = scan
    ? `<div class="h-[3px] w-full rounded bg-surface overflow-hidden mt-2"><div class="h-full bg-em transition-all duration-150" style="width:${Math.min(
        100,
        Math.round(((scan.gameIdx + scan.plyIdx / Math.max(1, scan.totalPlies)) / Math.max(1, scan.totalGames)) * 100)
      )}%"></div></div>`
    : '';

  return `<div class="flex flex-wrap items-center justify-between gap-2">
    ${sectionTabs(
      [
        ['today', 'Today'],
        ['plan', '+100 Elo'],
        ['diagnostics', 'Diagnostics'],
        ['drills', 'Train'],
      ],
      ui.sub,
      'coach-sub'
    )}
    ${scanControls}
  </div>${progBar}`;
}

/* ------------------------------------------------------------------ */
/* Sub-view 1: +100 Elo Plan                                           */
/* ------------------------------------------------------------------ */

function renderPlanSub(ctx, plan, diag, cliffs) {
  const ui = ctx.ui.coach;
  const excluded = new Set(ui.excluded || []);
  const activeElo = plan.items.reduce((sum, it) => sum + (excluded.has(it.id) ? 0 : it.elo), 0);
  const projected = plan.currentRating ? plan.currentRating + activeElo : null;
  const pctGoal = Math.min(100, activeElo);

  const kpi = (label, value, sub = '') =>
    `<div class="min-w-0"><div class="text-[11px] text-txtMuted">${label}</div><div class="text-[20px] font-bold leading-tight tabular-nums">${value}</div><div class="text-[11px] text-txtMuted truncate">${sub}</div></div>`;

  const weakPhase = diag.weakestPhase ? diag.phases.find((p) => p.id === diag.weakestPhase) : null;
  const strongPhase = diag.strongestPhase ? diag.phases.find((p) => p.id === diag.strongestPhase) : null;
  const lengths = gameLengthProfile(ctx.games);

  const strip = `<section class="bg-panel border border-borderSubtle rounded-xl p-3 grid gap-2.5">
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      ${kpi(
        plan.mainTc ? `${esc(plan.mainTc.label)} target` : 'Target',
        plan.currentRating ? `${plan.currentRating} → <span class="text-em">${plan.targetRating}</span>` : '+100 Elo',
        `Needs +${plan.neededGainPct} pts score vs equal peers`
      )}
      ${kpi(
        'Selected fixes',
        `<span class="${activeElo >= 100 ? 'text-em' : 'text-txt'}">+${activeElo} Elo</span>`,
        projected ? `Projected ${projected} (${pctGoal}% of +100)` : `${plan.items.length} gaps identified`
      )}
      ${kpi(
        'Engine coverage',
        diag.coverage.analyzed ? `${fmtInt(diag.coverage.analyzed)} games` : 'None yet',
        diag.coverage.analyzed
          ? `${diag.overall.accuracy}% acc · ${diag.overall.acpl} ACPL`
          : 'Scan recent games for phase & clock depth'
      )}
      ${kpi(
        weakPhase ? 'Weakest phase' : 'Game length',
        weakPhase ? `<span class="text-ro">${esc(weakPhase.label)}</span>` : `${Math.round(plan.total.score * 100)}%`,
        weakPhase
          ? `${weakPhase.accuracy}% acc vs ${strongPhase?.accuracy ?? '—'}% ${strongPhase?.label?.toLowerCase() || ''}`
          : `${fmtInt(lengths.earlyLosses)} losses under 20 moves`
      )}
    </div>
    <div class="h-1.5 rounded-full bg-surface overflow-hidden" title="${pctGoal}% of +100 Elo goal">
      <div class="h-full bg-em transition-all duration-200" style="width:${pctGoal}%"></div>
    </div>
  </section>`;

  // Left card: Ranked Elo Leak Budget
  const renderAction = (it) => {
    const a = it.action;
    if (!a) return '';
    if (a.type === 'coach-sub') return linkBtn(it.actionLabel, `data-act="coach-sub" data-v="${esc(a.sub)}"`);
    if (a.type === 'benchmark') return linkBtn(it.actionLabel, `data-act="coach-bench-jump" data-prefix="${esc(a.cliffPrefix)}"`);
    if (a.type === 'tab') return linkBtn(it.actionLabel, `data-act="tab" data-v="${esc(a.tab)}"`);
    if (a.type === 'games') return linkBtn(it.actionLabel, `data-act="term-games" data-outcome="${esc(a.outcome || 'all')}" data-term="${esc(a.term || 'all')}"`);
    if (a.type === 'explore') return linkBtn(it.actionLabel, `data-act="explore" data-color="${esc(a.color)}" data-prefix="${esc(a.prefix)}"`);
    return '';
  };

  const planList = plan.items.length
    ? `<div class="divide-y divide-borderSubtle/60">${plan.items
        .map((it) => {
          const on = !excluded.has(it.id);
          return `<div class="py-2 first:pt-0 last:pb-0 flex items-start gap-2.5 text-[11.5px]">
            <input type="checkbox" data-act="coach-toggle-item" data-id="${esc(it.id)}" ${on ? 'checked' : ''} class="mt-0.5 accent-em cursor-pointer shrink-0" aria-label="Include ${esc(it.title)}">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="font-semibold ${on ? 'text-txt' : 'text-txtMuted line-through'}">${esc(it.title)}</span>
                <span class="px-1.5 py-[1px] rounded bg-surface text-txtMuted text-[10px] font-medium">${esc(it.phase)}</span>
              </div>
              <div class="text-[11px] text-txtMuted mt-0.5">${esc(it.detail)}</div>
            </div>
            <div class="shrink-0 text-right flex flex-col items-end gap-0.5">
              <span class="font-mono text-[11px] font-semibold ${on ? 'text-em' : 'text-txtMuted'}">+${it.elo}</span>
              ${renderAction(it)}
            </div>
          </div>`;
        })
        .join('')}</div>`
    : empty(
        plan.total.n < 15
          ? 'Play or sync at least 15 games in this selection to build a +100 Elo plan.'
          : 'No clear rating leaks found yet — scan recent games with Stockfish to inspect phases, conversions, and blunders.'
      );

  // Right column: Phase/Length snapshot + Repertoire reality check
  let phaseBody;
  if (diag.coverage.analyzed > 0) {
    phaseBody = `<div class="grid gap-2">${diag.phases
      .map((p) => {
        const tag =
          p.id === diag.strongestPhase
            ? '<span class="text-em font-semibold">Strength</span>'
            : p.id === diag.weakestPhase
              ? '<span class="text-ro font-semibold">Gap</span>'
              : '';
        return `<div class="grid gap-1 text-[11.5px]">
          <div class="flex items-center justify-between gap-2">
            <span class="font-medium">${esc(p.label)} ${tag ? `<span class="text-[10px] ml-1">${tag}</span>` : ''}</span>
            <span class="font-mono text-[11px]"><span class="text-txtMuted mr-2">${p.acpl ?? '—'} ACPL</span><span class="font-semibold ${accColor(p.accuracy)}">${p.accuracy !== null ? `${p.accuracy}%` : '—'}</span></span>
          </div>
          <div class="h-1.5 rounded bg-surface overflow-hidden"><div class="h-full" style="width:${p.accuracy || 0}%;background:${accBarColor(p.accuracy || 0)}"></div></div>
        </div>`;
      })
      .join('')}
      ${
        diag.conversion.reached > 0
          ? `<div class="pt-2 mt-1 border-t border-borderSubtle/60 flex items-center justify-between text-[11.5px]">
              <span class="text-txtMuted">Conversion from ≥ +2.5</span>
              <span class="font-mono"><b class="${diag.conversion.rate >= 0.8 ? 'text-em' : diag.conversion.rate >= 0.65 ? 'text-am' : 'text-ro'}">${fmtPct(diag.conversion.rate)}</b> <span class="text-txtMuted">(${diag.conversion.wins}/${diag.conversion.reached})</span></span>
            </div>`
          : ''
      }
    </div>`;
  } else {
    phaseBody = `<div class="grid gap-1.5">${lengths.buckets
      .map(
        (b) => `<div class="grid grid-cols-[112px_1fr_38px] items-center gap-2 text-[11.5px]">
          <span class="text-txtMuted">${esc(b.label)}</span>
          ${wdlBar(b, { height: 'h-[12px]' })}
          <span class="text-right font-mono text-[11px]" style="color:${scoreColor(b.score)}">${b.n ? `${Math.round(b.score * 100)}%` : '—'}</span>
        </div>`
      )
      .join('')}
      <p class="text-[11px] text-txtMuted pt-1">Scan recent games with Stockfish above for real Opening / Middlegame / Endgame accuracy and conversion rates.</p>
    </div>`;
  }

  // Repertoire reality check card (or top opening cliffs summary if no repertoire saved)
  const repDiff = ctx.repertoireDiff;
  let secondRightCard;
  if (repDiff && (repDiff.memorySlips.length || repDiff.missingSidelines.length)) {
    const slipsHtml = repDiff.memorySlips.length
      ? `<div class="text-[10.5px] font-semibold text-ro mb-1">Deviated from your repertoire</div>${repDiff.memorySlips
          .slice(0, 3)
          .map(
            (s) => `<div class="flex items-center justify-between gap-2 py-1 border-t border-borderSubtle/50 first:border-0 text-[11.5px]">
              <span class="truncate"><span class="font-mono text-ro">${esc(s.playedSan)}</span> <span class="text-txtMuted">instead of</span> <span class="font-mono text-em">${esc(s.expectedSans.join('/'))}</span> <span class="text-txtMuted text-[10.5px]">(${s.n}× · ${Math.round(s.score * 100)}%)</span></span>
              ${linkBtn('Explore', `data-act="explore" data-color="${s.color}" data-prefix="${esc(s.prefix)}"`)}
            </div>`
          )
          .join('')}`
      : '';
    const sideHtml = repDiff.missingSidelines.length
      ? `<div class="text-[10.5px] font-semibold text-am ${slipsHtml ? 'mt-2.5' : ''} mb-1">Common opponent sidelines outside your prep</div>${repDiff.missingSidelines
          .slice(0, 3)
          .map(
            (s) => `<div class="flex items-center justify-between gap-2 py-1 border-t border-borderSubtle/50 first:border-0 text-[11.5px]">
              <span class="truncate"><span class="font-mono">${esc(movesText(s.prefix.split(' ').filter(Boolean)))}</span> <span class="font-mono text-am">${esc(s.oppSan)}</span> <span class="text-txtMuted text-[10.5px]">(${s.n}× · ${Math.round(s.score * 100)}%)</span></span>
              ${linkBtn('Explore', `data-act="explore" data-color="${s.color}" data-prefix="${esc(s.prefix ? `${s.prefix} ${s.oppSan}` : s.oppSan)}"`)}
            </div>`
          )
          .join('')}`
      : '';
    secondRightCard = card('Repertoire vs your games', slipsHtml + sideHtml, {
      sub: `Checked your last ${fmtInt(repDiff.checkedGames)} games against your saved repertoire.`,
    });
  } else if (cliffs.length) {
    secondRightCard = card(
      'Opening cliff moves',
      `<div class="divide-y divide-borderSubtle/50">${cliffs
        .slice(0, 4)
        .map((c, ci) => {
          const mvNum = Math.floor(c.ply / 2) + 1;
          const mvLbl = `${mvNum}${c.color === 'w' ? '.' : '...'}${c.playedSan}`;
          return `<div class="py-1.5 first:pt-0 last:pb-0 flex items-center justify-between gap-2 text-[11.5px]">
            <span class="truncate"><span class="font-mono font-semibold text-ro mr-1">${esc(mvLbl)}</span><span class="text-txtMuted">${esc(c.opening ? c.opening.split(':')[0] : movesText(c.path))}</span></span>
            <span class="shrink-0 flex items-center gap-2 font-mono text-[11px]">
              <span class="text-txtMuted">${c.n}g</span>
              <span style="color:${scoreColor(c.score)}">${Math.round(c.score * 100)}%</span>
              ${linkBtn('Compare', `data-act="coach-bench-jump" data-prefix="${esc(c.childPrefix)}"`)}
              ${smBtn('Fix →', `data-act="coach-flaw-rep" data-i="${ci}"`, 'em')}
            </span>
          </div>`;
        })
        .join('')}</div>`,
      {
        sub: 'Exact moves where your score drops sharply vs baseline.',
        right: linkBtn('Benchmark', 'data-act="coach-sub" data-v="drills"'),
      }
    );
  } else {
    secondRightCard = '';
  }

  return `<div class="grid gap-3">
    ${strip}
    <div class="grid gap-3 lg:grid-cols-[1.25fr_1fr] items-start">
      ${card('Where your +100 Elo comes from', planList, {
        sub: 'Counterfactual Elo recovery on your games, largest first. Toggle items to test combinations.',
      })}
      <div class="grid gap-3 min-w-0">
        ${card(diag.coverage.analyzed ? 'Phase accuracy' : 'Score by game length', phaseBody, {
          right: diag.coverage.analyzed ? linkBtn('Full diagnostics', 'data-act="coach-sub" data-v="diagnostics"') : '',
        })}
        ${secondRightCard}
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Sub-view 2: Engine & Clock Diagnostics (Phase 2)                    */
/* ------------------------------------------------------------------ */

function renderDiagnosticsSub(ctx, diag, unanalyzedCount) {
  const ui = ctx.ui.coach;
  if (!diag.coverage.analyzed) {
    return card(
      'Engine & clock diagnostics',
      `<div class="py-6 text-center grid gap-2 justify-items-center">
        <p class="text-[12px] text-txt">No analyzed games in this filter selection yet.</p>
        <p class="text-[11px] text-txtMuted max-w-[460px]">Lichess games with server analysis load automatically on sync. For all other games (Chess.com, unanalyzed Lichess, PGN), run a local Stockfish 19 WASM scan — results cache offline in this browser.</p>
        ${unanalyzedCount > 0 ? `<div class="pt-1">${smBtn(`Scan last ${Math.min(ui.scanCount, unanalyzedCount)} games`, 'data-act="coach-scan"', 'em')}</div>` : ''}
      </div>`
    );
  }

  // Card 1: Phase Accuracy + clickable drilldown
  const selPhase = ui.phase || diag.weakestPhase || 'middlegame';
  const curPhase = diag.phases.find((p) => p.id === selPhase) || diag.phases[0];
  const phaseRows = diag.phases
    .map((p) => {
      const on = p.id === curPhase.id;
      const badge =
        p.id === diag.strongestPhase
          ? '<span class="text-em">Strength</span>'
          : p.id === diag.weakestPhase
            ? '<span class="text-ro">Weakest</span>'
            : '';
      return `<button data-act="coach-phase" data-v="${p.id}" class="w-full text-left p-2 rounded-lg border transition-colors ${
        on ? 'bg-surface border-borderBright' : 'border-transparent hover:bg-surface/60'
      }">
        <div class="flex items-center justify-between gap-2 text-[11.5px] mb-1">
          <span><b class="text-txt">${esc(p.label)}</b> <span class="text-[10.5px] text-txtMuted ml-1">${fmtInt(p.moves)} mv</span> ${badge ? `<span class="text-[10px] font-semibold ml-1">${badge}</span>` : ''}</span>
          <span class="font-mono text-[11px]"><span class="text-txtMuted mr-2">${p.acpl ?? '—'} ACPL · ${p.blundersPer10}/10g ??</span><b class="${accColor(p.accuracy)}">${p.accuracy !== null ? `${p.accuracy}%` : '—'}</b></span>
        </div>
        <div class="h-1.5 rounded bg-bg overflow-hidden"><div class="h-full" style="width:${p.accuracy || 0}%;background:${accBarColor(p.accuracy || 0)}"></div></div>
      </button>`;
    })
    .join('');

  const phaseExamples = curPhase.issues.length
    ? `<div class="mt-2 pt-2 border-t border-borderSubtle/60 grid gap-1">
        <div class="text-[10.5px] font-semibold text-txtMuted">Biggest ${esc(curPhase.label.toLowerCase())} mistakes</div>
        ${curPhase.issues
          .slice(0, 3)
          .map(
            (iss) => `<div class="flex items-center justify-between gap-2 text-[11px] py-0.5">
              <span class="truncate"><b class="text-txt">vs ${esc(iss.op)}</b> · mv ${iss.moveNum} <span class="font-mono text-ro">${esc(iss.playedSan)}${iss.kind === 'blunder' ? '??' : '?'}</span>${iss.bestSan ? ` <span class="text-txtMuted">→</span> <span class="font-mono text-em">${esc(iss.bestSan)}</span>` : ''} <span class="text-txtMuted">(${esc(iss.evalBeforeLabel)}→${esc(iss.evalAfterLabel)})</span></span>
              <span class="shrink-0 flex items-center gap-2">
                ${iss.bestUci && iss.winDrop >= 15 ? linkBtn('Drill', `data-act="coach-drill-open" data-id="${esc(`${iss.gameId}:${iss.ply}`)}"`) : ''}
                ${linkBtn('Studio', `data-act="open-game" data-id="${esc(iss.gameId)}"`)}
              </span>
            </div>`
          )
          .join('')}
      </div>`
    : '';

  // Card 2: Conversion & Resilience
  const c = diag.conversion;
  const r = diag.resilience;
  const convWdl = { n: c.reached, w: c.wins, d: c.draws, l: c.losses };
  const resWdl = { n: r.reached, w: r.wins, d: r.draws, l: r.losses };
  const thrownHtml = c.thrownGames.length
    ? `<div class="mt-2.5 pt-2 border-t border-borderSubtle/60">
        <div class="text-[10.5px] font-semibold text-txtMuted mb-1">Recent games slipped from ≥ +2.5</div>
        ${c.thrownGames
          .slice(0, 4)
          .map(({ game, analysis }) => {
            const worst = (analysis.issues || [])[0];
            return `<div class="flex items-center justify-between gap-2 text-[11px] py-1 border-t border-borderSubtle/40 first:border-0">
              <span class="truncate"><b class="text-txt">vs ${esc(game.op)}</b> <span class="text-txtMuted">${game.res === 0 ? 'Lost' : 'Drew'} · peak +${(analysis.peakCp / 100).toFixed(1)}${analysis.firstThrowPly ? ` · slipped mv ${Math.ceil(analysis.firstThrowPly / 2)}` : ''}</span></span>
              <span class="shrink-0 flex items-center gap-2">
                ${worst?.bestUci && worst.winDrop >= 15 ? linkBtn('Drill', `data-act="coach-drill-open" data-id="${esc(`${game.id}:${worst.ply}`)}"`) : ''}
                ${linkBtn('Studio', `data-act="open-game" data-id="${esc(game.id)}"`)}
              </span>
            </div>`;
          })
          .join('')}
      </div>`
    : '';

  const convBody = `<div class="grid gap-3 sm:grid-cols-2">
      <div class="grid gap-1">
        <div class="text-[11px] text-txtMuted">Reached ≥ +2.5 (${c.reached} games)</div>
        <div class="flex items-baseline gap-2">
          <span class="text-[18px] font-bold tabular-nums ${c.rate !== null && c.rate >= 0.78 ? 'text-em' : c.rate !== null && c.rate >= 0.62 ? 'text-am' : 'text-ro'}">${c.rate !== null ? fmtPct(c.rate) : '—'}</span>
          <span class="text-[11px] text-txtMuted">won · ${c.draws}D ${c.losses}L</span>
        </div>
        ${c.reached ? wdlBar(convWdl, { height: 'h-[10px]', labels: false }) : ''}
      </div>
      <div class="grid gap-1">
        <div class="text-[11px] text-txtMuted">Fell to ≤ −2.5 (${r.reached} games)</div>
        <div class="flex items-baseline gap-2">
          <span class="text-[18px] font-bold tabular-nums text-txt">${r.saveRate !== null ? fmtPct(r.saveRate) : '—'}</span>
          <span class="text-[11px] text-txtMuted">saved (${r.wins}W ${r.draws}D)</span>
        </div>
        ${r.reached ? wdlBar(resWdl, { height: 'h-[10px]', labels: false }) : ''}
      </div>
    </div>
    ${c.eloLeak >= 5 ? `<div class="text-[11px] text-ro mt-2">Converting half of your slipped wins recovers ~<b>+${c.eloLeak} Elo</b>.</div>` : ''}
    ${thrownHtml}`;

  // Card 3: Time Management
  const tm = diag.time;
  let timeBody;
  if (tm.totalClockedBlunders > 0 || tm.clockByMove.length > 0) {
    const barRow = (label, n, total, color) => {
      const share = total ? n / total : 0;
      return `<div class="grid gap-0.5 text-[11px]">
        <div class="flex justify-between"><span class="text-txtMuted">${label}</span><span class="font-mono"><b class="text-txt">${n}</b> (${fmtPct(share)})</span></div>
        <div class="h-1.5 rounded bg-surface overflow-hidden"><div class="h-full" style="width:${(share * 100).toFixed(1)}%;background:${color}"></div></div>
      </div>`;
    };
    const splitHtml = tm.totalClockedBlunders
      ? `<div class="grid gap-2">
          ${barRow('Impulsive (≤ 3s spent, ample clock)', tm.impulsive, tm.totalClockedBlunders, '#fb7185')}
          ${barRow('Time trouble (≤ 15% clock left)', tm.timeTrouble, tm.totalClockedBlunders, '#f59e0b')}
          ${barRow('Normal time', tm.normal, tm.totalClockedBlunders, '#38bdf8')}
        </div>`
      : '<div class="text-[11px] text-txtMuted">No clocked blunders recorded yet.</div>';

    const clkTable = tm.clockByMove.length
      ? `<div class="mt-2.5 pt-2 border-t border-borderSubtle/60">
          <div class="text-[10.5px] font-semibold text-txtMuted mb-1">Avg clock remaining (you vs opponent)</div>
          <div class="grid grid-cols-3 gap-2 text-center">${tm.clockByMove
            .map((r2) => {
              const diff = r2.mine - r2.opp;
              const diffCls = diff >= 5 ? 'text-em' : diff <= -5 ? 'text-ro' : 'text-txtMuted';
              return `<div class="rounded-lg bg-surface/70 border border-borderSubtle/60 py-1.5 px-2">
                <div class="text-[10px] text-txtMuted">Move ${r2.move}</div>
                <div class="font-mono text-[12px] font-bold">${fmtClockSec(r2.mine)}</div>
                <div class="font-mono text-[10px] ${diffCls}">${diff >= 0 ? '+' : '−'}${Math.abs(diff)}s</div>
              </div>`;
            })
            .join('')}</div>
        </div>`
      : '';
    timeBody = splitHtml + clkTable;
  } else {
    timeBody = empty('Clock data is captured automatically for synced Lichess/Chess.com games and PGNs with [%clk] tags. Re-sync or import games with clocks to populate time diagnostics.');
  }

  // Card 4: Recurring Error Types (Blunder Taxonomy)
  const taxBody = diag.taxonomy.length
    ? `<table class="w-full text-[11.5px]"><tbody>${diag.taxonomy
        .map(
          (row) => `<tr class="border-t border-borderSubtle/60 first:border-0">
            <td class="py-1.5 pr-2 font-medium">${esc(row.label)}</td>
            <td class="py-1.5 px-2 text-right font-mono text-ro font-semibold">${row.count}</td>
            <td class="py-1.5 text-right">${linkBtn('Drill', `data-act="coach-drill-tag" data-tag="${esc(row.tag)}"`)}</td>
          </tr>`
        )
        .join('')}</tbody></table>`
    : empty('No blunders (win-drop ≥ 20%) recorded in analyzed games yet.');

  const covNote = `Based on ${fmtInt(diag.coverage.analyzed)} analyzed games (${fmtInt(diag.coverage.fromLichess)} Lichess server · ${fmtInt(diag.coverage.fromStockfish)} local Stockfish).`;

  return `<div class="grid gap-3">
    <div class="text-[11px] text-txtMuted">${covNote}</div>
    <div class="grid gap-3 lg:grid-cols-2 items-start">
      ${card('Accuracy by phase', `<div class="grid gap-1">${phaseRows}</div>${phaseExamples}`, {
        sub: 'Split by material/queens. Click a phase to see its worst mistakes.',
      })}
      ${card('Conversion & resilience', convBody, {
        sub: 'Finishing winning positions (≥ +2.5) and saving lost ones (≤ −2.5).',
      })}
      ${card('Time management', timeBody, {
        sub: 'Blunders grouped by thinking time and remaining clock.',
      })}
      ${card('Recurring blunder types', taxBody, {
        sub: 'Tagged deterministically from Stockfish best lines and board state.',
      })}
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Sub-view 3: +100 Elo Opening Benchmark & Blunder Drills (Phase 3)   */
/* ------------------------------------------------------------------ */

function renderBenchmarkCard(ctx, cliffs, currentRating) {
  const ui = ctx.ui.coach;
  if (!cliffs.length) {
    return card('Opening benchmark (+100 Elo)', empty('Not enough repeated opening lines yet (need at least 5 games in a line with a clear score drop).'));
  }
  const idx = Math.min(cliffs.length - 1, Math.max(0, ui.benchIdx || 0));
  const cliff = cliffs[idx];
  const bench = ctx.benchmark; // { key, status, bracketLabel, moves, totalGames, message, loading }
  const { label: bracketLbl } = targetRatingBrackets(currentRating || 1500);

  const arrows = [];
  if (cliff.playedUci && cliff.playedUci.length >= 4) {
    arrows.push({ from: cliff.playedUci.slice(0, 2), to: cliff.playedUci.slice(2, 4), weight: 0.75, color: '#fb7185' });
  }
  const topPeer = bench?.status === 'ok' ? bench.moves?.[0] : null;
  if (topPeer?.uci && topPeer.uci.length >= 4 && topPeer.uci !== cliff.playedUci) {
    arrows.push({ from: topPeer.uci.slice(0, 2), to: topPeer.uci.slice(2, 4), weight: 0.9, color: '#10b981' });
  }

  const selector = `<div class="flex flex-wrap gap-1 mb-2.5">${cliffs
    .slice(0, 5)
    .map((c, i) => {
      const mvNum = Math.floor(c.ply / 2) + 1;
      const lbl = `${mvNum}${c.color === 'w' ? '.' : '...'}${c.playedSan}`;
      return `<button data-act="coach-bench-idx" data-i="${i}" class="px-2 py-0.5 rounded-md border text-[11px] font-mono ${
        i === idx ? 'bg-txt text-bg border-txt font-semibold' : 'bg-surface border-borderSubtle text-txtMuted hover:text-txt'
      }">${esc(lbl)} <span class="font-sans text-[10px] opacity-80">${Math.round(c.score * 100)}%</span></button>`;
    })
    .join('')}</div>`;

  let peerHtml;
  if (!bench || bench.loading) {
    peerHtml = `<div class="py-3 text-[11px] text-txtMuted">Loading Lichess ${esc(bracketLbl)} games…</div>`;
  } else if (bench.status === 'ok' && bench.moves?.length) {
    const mvNum = Math.floor(cliff.ply / 2) + 1;
    const prefixNum = `${mvNum}${cliff.color === 'w' ? '.' : '...'}`;
    peerHtml = `<table class="w-full text-[11.5px]"><thead><tr class="text-left text-txtMuted text-[10px] uppercase tracking-wider">
      <th class="font-semibold pb-1 pr-2">Move</th><th class="font-semibold pb-1 pr-2">Pool</th><th class="font-semibold pb-1 text-right">Score</th>
    </tr></thead><tbody>
      <tr class="border-t border-borderSubtle/60 bg-ro/[0.06]">
        <td class="py-1.5 pr-2 font-mono font-semibold text-ro">${esc(prefixNum + cliff.playedSan)}</td>
        <td class="py-1.5 pr-2 text-txtMuted">You (${cliff.n}g)</td>
        <td class="py-1.5 text-right font-mono font-semibold text-ro">${Math.round(cliff.score * 100)}%</td>
      </tr>
      ${bench.moves
        .slice(0, 4)
        .map(
          (m, mi) => `<tr class="border-t border-borderSubtle/60">
            <td class="py-1.5 pr-2 font-mono font-semibold ${mi === 0 ? 'text-em' : 'text-txt'}">${esc(prefixNum + m.san)}</td>
            <td class="py-1.5 pr-2 text-txtMuted">${esc(bench.bracketLabel)} (${fmtPct(m.share)})</td>
            <td class="py-1.5 text-right font-mono font-semibold" style="color:${scoreColor(m.score)}">${Math.round(m.score * 100)}%</td>
          </tr>`
        )
        .join('')}
    </tbody></table>`;
  } else if (bench.status === 'ok') {
    peerHtml = `<div class="py-2 text-[11px] text-txtMuted">No games in Lichess ${esc(bench.bracketLabel)} reached this exact move order.</div>`;
  } else {
    peerHtml = `<div class="py-2 text-[11px] text-txtMuted grid gap-1.5">
      <span>${esc(bench.message || 'Could not load Lichess Explorer.')}</span>
      <div>${smBtn('Retry', 'data-act="coach-bench-retry"')}</div>
    </div>`;
  }

  const body = `${selector}
    <div class="grid gap-3 sm:grid-cols-[200px_1fr] items-start">
      <div class="grid gap-1.5 max-w-[220px] w-full">
        ${miniBoardHtml(cliff.fen, { flipped: cliff.color === 'b', last: cliff.last, arrows })}
        <div class="flex items-center justify-between text-[10px] text-txtMuted">
          <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full bg-ro"></span>Yours</span>
          <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full bg-em"></span>${esc(bracketLbl)} top</span>
        </div>
      </div>
      <div class="min-w-0 grid gap-2">
        <div class="text-[11px] font-mono text-txtMuted truncate" title="${esc(movesText(cliff.path))}">${esc(movesText(cliff.path))}</div>
        ${peerHtml}
        <div class="flex items-center gap-3 pt-1 flex-wrap">
          ${smBtn('Generate repertoire →', `data-act="coach-flaw-rep" data-i="${idx}"`, 'em')}
          ${linkBtn('Explore line', `data-act="explore" data-color="${cliff.color}" data-prefix="${esc(cliff.prefix)}"`)}
          ${linkBtn('Open in Studio', `data-act="coach-bench-studio" data-i="${idx}"`)}
        </div>
      </div>
    </div>`;

  return card(`Opening benchmark · ${esc(bracketLbl)}`, body, {
    sub: 'Compare your weakest opening decisions against players rated +100–200 Elo higher.',
  });
}

/* ------------------------------------------------------------------ */
/* Main Coach Tab Entrypoint                                           */
/* ------------------------------------------------------------------ */

export function renderCoach(ctx) {
  const { games } = ctx;
  if (!games.length) return empty('No games match these filters.');

  const diag = aggregateDiagnostics(games, ctx.analyses);
  const cliffs = findOpeningCliffs(games, { minGames: Math.max(4, Math.min(8, Math.round(games.length * 0.02))), limit: 6 });
  const plan = buildEloPlan(games, diag, { cliffs, repertoireDiff: ctx.repertoireDiff });
  const unanalyzedCount = games.reduce((n, g) => n + (ctx.analyses.has(g.id) || !g.moves ? 0 : 1), 0);

  // Share computed cliffs & deck with controller for click actions.
  ctx.setCoachData({ cliffs, plan, diag });

  const top = coachTopBar(ctx, diag, unanalyzedCount);

  // Trainer decks feed both Today and Train.
  const sub = ctx.ui.coach.sub;
  let decks = null;
  if (sub === 'today' || sub === 'drills') {
    decks = {
      mistakes: extractDrillDeck(games, ctx.analyses, ctx.drillProgress, {
        now: ctx.now,
        tagFilter: ctx.ui.coach.drillTag || 'all',
      }),
      blunder: extractBlunderCheckDeck(games, ctx.analyses, ctx.drillProgress, { now: ctx.now }),
      convert: extractConvertDeck(games, ctx.analyses, ctx.drillProgress, { now: ctx.now }),
    };
    ctx.setCoachDeck(decks.mistakes);
    ctx.setTrainDecks(decks);
  }

  let body;
  if (sub === 'diagnostics') {
    body = renderDiagnosticsSub(ctx, diag, unanalyzedCount);
  } else if (sub === 'drills') {
    body = `<div class="grid gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] items-start">
      ${renderTrainCard({ ...ctx, train: ctx.getTrain(decks) })}
      ${renderBenchmarkCard(ctx, cliffs, plan.currentRating)}
    </div>`;
  } else if (sub === 'today') {
    body = renderToday({ ...ctx, today: ctx.getToday(decks) });
  } else {
    body = renderPlanSub(ctx, plan, diag, cliffs);
  }

  return `<div class="grid gap-3">${top}${body}</div>`;
}
