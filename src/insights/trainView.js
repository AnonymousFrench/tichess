/**
 * Coach → Train: one board for three trainers built from your own games
 * (mistake drills, blunder checks, conversions), plus the opening benchmark.
 * All text that comes from game data goes through esc().
 */
import { card, relTime } from './views.js';
import { esc } from './charts.js';
import { miniBoardHtml } from './miniBoard.js';
import { TC_LABEL } from './normalize.js';
import { BLUNDER_TAG_LABEL, PHASE_LABEL } from './coach.js';
import { nextIntervalLabel } from './drills.js';
import { MAIA_MIN_ELO, MAIA_MAX_ELO } from '../train/maiaOpponent.js';
import { BLUNDER_CHECK_MOVES, MAX_DRILL_STEPS } from '../train/grading.js';
import { formatReviewScore } from '../engines/evalMath.js';

export const TRAIN_MODES = [
  ['mistakes', 'Mistakes'],
  ['blunder', 'Blunder check'],
  ['convert', 'Convert'],
];

const empty = (msg) => `<div class="py-6 text-center text-txtMuted text-[11.5px]">${msg}</div>`;

const smBtn = (label, attrs, tone = '') =>
  `<button ${attrs} class="px-2 py-0.5 rounded-md border text-[10.5px] font-semibold whitespace-nowrap ${
    tone === 'em'
      ? 'bg-em/15 hover:bg-em/25 border-em/35 text-em'
      : 'bg-surface hover:bg-surfaceHover border-borderSubtle text-txt'
  }">${label}</button>`;

const linkBtn = (label, attrs) =>
  `<button ${attrs} class="shrink-0 text-[11px] text-cy hover:underline whitespace-nowrap">${label}</button>`;

function modeTabs(active, decks) {
  return `<div class="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-surface border border-borderSubtle text-[11px] max-w-full overflow-x-auto">${TRAIN_MODES.map(
    ([v, l]) => {
      const due = decks[v]?.dueCount || 0;
      return `<button data-act="trn-mode" data-v="${v}" class="px-2 py-0.5 rounded-md font-semibold whitespace-nowrap ${
        v === active ? 'bg-txt text-bg' : 'text-txtMuted hover:text-txt'
      }" aria-pressed="${v === active}">${l}${due ? ` <span class="font-mono text-[10px] opacity-80">${due}</span>` : ''}</button>`;
    }
  ).join('')}</div>`;
}

const MODE_INFO = {
  mistakes: {
    title: 'Mistake drills',
    sub: `Positions where you went wrong. Any move close to the best counts; in sharp lines you play up to ${MAX_DRILL_STEPS} moves deep.`,
    emptyMsg: (n) =>
      n ? 'No drillable mistakes match this filter.' : 'Scan recent games with Stockfish (top right) to build drills from your own games.',
  },
  blunder: {
    title: 'Blunder check',
    sub: `Your blunders from moves ${BLUNDER_CHECK_MOVES[0]} to ${BLUNDER_CHECK_MOVES[1]}: first find the reply your move allowed, then a safe move instead.`,
    emptyMsg: (n) =>
      n ? `No blunders between moves ${BLUNDER_CHECK_MOVES[0]} and ${BLUNDER_CHECK_MOVES[1]} in these games.` : 'Scan recent games with Stockfish to find your blunders.',
  },
  convert: {
    title: 'Convert winning positions',
    sub: 'Games where you reached +2 and did not win. Play them out against Maia 2; Stockfish judges every move.',
    emptyMsg: (n) => (n ? 'No thrown winning positions in these games. Nice.' : 'Scan recent games with Stockfish to find positions you let slip.'),
  },
};

function resultLine(v) {
  const map = {
    solved: ['text-em', '✓ Solved'],
    revealed: ['text-txtMuted', 'Shown'],
    won: ['text-em', '✓ Converted'],
    held: ['text-em', '✓ Advantage held for 20 moves'],
    slipped: ['text-ro', '✗ Advantage slipped'],
    drawn: ['text-am', '½ Drawn'],
  };
  const [cls, label] = map[v.result] || ['text-txt', ''];
  return label ? `<div class="text-[12px] font-semibold ${cls}">${label}</div>` : '';
}

function infoPanel(v, card, ctx, decks) {
  const deck = decks[v.mode];
  const idx = deck?.cards?.findIndex((c) => c.id === card.id) ?? -1;
  const meta = `<div class="flex items-center justify-between gap-2 text-[11px] text-txtMuted">
      <span class="min-w-0 truncate"><b class="text-txt">vs ${esc(card.op || '?')}</b>${card.opR ? ` (${esc(card.opR)})` : ''} · ${esc(TC_LABEL[card.tc] || card.tc || '')} · ${esc(relTime(card.t, ctx.now))}</span>
      <span class="font-mono shrink-0">${idx + 1}/${deck?.cards?.length || 0}</span>
    </div>`;

  let context;
  if (v.mode === 'mistakes') {
    context = `<div class="text-[11px] text-txtMuted">Move ${esc(card.moveNum)} (${esc(PHASE_LABEL[card.phase] || card.phase || '')} · ${esc(
      card.tagLabel || BLUNDER_TAG_LABEL[card.tag] || ''
    )})</div>
    <div class="text-[11.5px]">In game: <span class="font-mono font-semibold text-ro">${esc(card.playedSan)}${card.kind === 'blunder' ? '??' : '?'}</span>
      <span class="text-txtMuted font-mono text-[10.5px]">(${esc(card.evalBeforeLabel)} → ${esc(card.evalAfterLabel)})</span></div>`;
  } else if (v.mode === 'blunder') {
    context = `<div class="text-[11px] text-txtMuted">Move ${esc(card.moveNum)} · step ${v.step === 'refute' ? '1' : '2'} of 2</div>`;
  } else {
    const opts = [];
    for (let e = MAIA_MAX_ELO; e >= MAIA_MIN_ELO + 600; e -= 200) opts.push(e);
    context = `<div class="flex items-center gap-2 text-[11px] text-txtMuted flex-wrap">
      <span>Move ${esc(card.moveNum)} · you peaked at <b class="text-txt font-mono">${esc(formatReviewScore(card.peakCp))}</b></span>
      <label class="flex items-center gap-1">Maia
        <select data-act="trn-maia-elo" aria-label="Maia strength" class="px-1 py-0.5 rounded bg-surface border border-borderSubtle text-[10.5px] text-txt">
          ${opts.map((e) => `<option value="${e}"${e === v.maiaElo ? ' selected' : ''}>${e}</option>`).join('')}
        </select>
      </label>
      ${v.opponent === 'stockfish' ? '<span class="text-am">Stockfish defending</span>' : ''}
    </div>`;
    if (v.history.length) {
      context += `<div class="text-[10.5px] font-mono text-txtMuted break-words">${esc(v.history.join(' '))}</div>`;
    }
  }

  let status;
  if (v.phase === 'loading' || v.phase === 'checking') {
    status = `<div class="text-[11.5px] text-txtMuted">${esc(v.maiaStatus || 'Thinking…')}</div>`;
  } else if (v.phase === 'error') {
    status = `<div class="text-[11.5px] text-ro">${esc(v.error)}</div>`;
  } else {
    status = `<div class="text-[11.5px] text-txt">${esc(v.prompt)}</div>`;
  }
  const feedback = v.feedback
    ? `<div class="text-[11.5px] font-semibold ${v.tone === 'good' ? 'text-em' : v.tone === 'bad' ? 'text-ro' : 'text-txt'}">${esc(v.feedback)}</div>`
    : '';
  const evalChip = v.evalLabel && v.phase !== 'loading' ? `<span class="font-mono text-[10.5px] text-txtMuted">eval ${esc(v.evalLabel)}</span>` : '';

  let next = '';
  if (v.phase === 'done') {
    const st = ctx.drillProgress?.[card.id];
    next = st?.due ? `<div class="text-[10.5px] text-txtMuted">Next review in ${esc(nextIntervalLabel(st.box || 0))}</div>` : '';
  }

  const playing = v.phase === 'move' || v.phase === 'wrong';
  const buttons = [
    playing ? smBtn('Hint', 'data-act="trn-hint"') : '',
    playing ? smBtn(v.mode === 'convert' ? 'Show best' : 'Solution', 'data-act="trn-reveal"') : '',
    v.phase === 'done' || v.phase === 'error' ? smBtn('Retry', 'data-act="trn-retry"') : '',
    (deck?.cards?.length || 0) > 1 ? smBtn(v.phase === 'done' ? 'Next' : 'Skip', 'data-act="trn-next"', v.phase === 'done' ? 'em' : '') : '',
    linkBtn('Open game', `data-act="open-game" data-id="${esc(card.gameId)}"`),
  ].join('');

  return `<div class="min-w-0 grid gap-2">
    ${meta}
    ${context}
    ${resultLine(v)}
    ${status}
    ${feedback}
    <div class="flex items-center gap-2">${evalChip}</div>
    ${next}
    <div class="flex flex-wrap items-center gap-1.5 pt-1">${buttons}</div>
  </div>`;
}

/**
 * ctx.train = { mode, decks: { mistakes, blunder, convert }, view, drillTag }
 * where `view` is the trainer controller's view() snapshot.
 */
export function renderTrainCard(ctx) {
  const t = ctx.train;
  const decks = t.decks;
  const mode = t.mode;
  const info = MODE_INFO[mode];
  const deck = decks[mode];
  const v = t.view;

  const filter =
    mode === 'mistakes'
      ? `<select data-act="coach-drill-filter" aria-label="Filter mistakes" class="px-1.5 py-0.5 rounded-md bg-surface border border-borderSubtle text-[11px] text-txt">
          <option value="all"${t.drillTag === 'all' ? ' selected' : ''}>All mistake types</option>
          ${Object.entries(BLUNDER_TAG_LABEL)
            .map(([k, lbl]) => `<option value="${esc(k)}"${t.drillTag === k ? ' selected' : ''}>${esc(lbl)}</option>`)
            .join('')}
        </select>`
      : '';
  const right = `<div class="flex items-center gap-1.5 flex-wrap justify-end">${filter}<span class="font-mono text-[10.5px] text-txtMuted">${
    deck?.dueCount || 0
  } due</span></div>`;

  const header = `<div class="mb-2">${modeTabs(mode, decks)}</div>`;

  if (!deck?.cards?.length) {
    return card(info.title, header + empty(info.emptyMsg(ctx.analysesCount)), { sub: info.sub, right });
  }

  const active = deck.cards.find((c) => c.id === v.cardId) || null;
  if (!active || v.mode !== mode) {
    return card(info.title, header + empty('Loading position…'), { sub: info.sub, right });
  }

  const arrows = [...(v.arrows || [])];
  const board = miniBoardHtml(v.fen || active.fenBefore || active.fen, {
    flipped: v.flipped,
    interactive: v.interactive,
    sqAct: 'trn-sq',
    selected: v.selected,
    dests: v.dests,
    hint: v.hintSq && v.interactive ? v.hintSq : null,
    bad: v.lastBad,
    last: v.lastMove,
    arrows,
  });

  const body = `${header}<div class="grid gap-3 sm:grid-cols-[240px_1fr] items-start">
    <div class="max-w-[260px] w-full">${board}</div>
    ${infoPanel(v, active, ctx, decks)}
  </div>`;
  return card(info.title, body, { sub: info.sub, right });
}
