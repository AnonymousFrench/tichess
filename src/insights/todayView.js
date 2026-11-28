/**
 * Coach → Today: one short daily session built from what you already have.
 * Repertoire reviews, mistake drills, blunder checks, one conversion, one game
 * to review, and a pointer to opponent prep when you have scouted someone.
 */
import { card, relTime } from './views.js';
import { esc } from './charts.js';
import { cardStatus } from '../repertoire/model.js';

export const TODAY_TARGETS = { repertoire: 10, mistakes: 5, blunder: 3, convert: 1, review: 1 };
const REVIEWED_KEY = 'tichess_reviewed_games_v1';
const MAX_REVIEWED = 400;

export function localDayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function loadReviewedGames() {
  try {
    const arr = JSON.parse(localStorage.getItem(REVIEWED_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter((x) => x && typeof x.id === 'string' && Number.isFinite(x.t)) : [];
  } catch (_) {
    return [];
  }
}

export function markGameReviewed(id, now = Date.now()) {
  if (typeof id !== 'string' || !id) return;
  const list = loadReviewedGames().filter((x) => x.id !== id);
  list.unshift({ id, t: now });
  try {
    localStorage.setItem(REVIEWED_KEY, JSON.stringify(list.slice(0, MAX_REVIEWED)));
  } catch (_) {}
}

/**
 * Pure summary of today's session.
 *  repertoire: the user's repertoire doc (or null), repProgress: its progress object
 *  decks: { mistakes, blunder, convert } with { cards, dueCount }
 *  drillProgress: trainer progress records; games: filtered games, newest first not required
 */
export function computeToday({ repertoire, repProgress, decks, drillProgress, games, reviewed, scoutTargets, now = Date.now() }) {
  const dayStart = startOfDay(now);

  let repDue = 0;
  let repNew = 0;
  const cards = repertoire && typeof repertoire.cards === 'object' && repertoire.cards ? Object.keys(repertoire.cards) : [];
  for (const id of cards) {
    const st = cardStatus(repProgress?.[id], now);
    if (st === 'due') repDue++;
    else if (st === 'new') repNew++;
  }
  const repDoneToday = Number(repProgress?.days?.d?.[localDayKey(now)]?.n) || 0;

  const doneToday = { mistakes: 0, blunder: 0, convert: 0 };
  for (const [id, r] of Object.entries(drillProgress || {})) {
    if (!r || !(r.last >= dayStart)) continue;
    if (id.startsWith('bc:')) doneToday.blunder++;
    else if (id.startsWith('cv:')) doneToday.convert++;
    else doneToday.mistakes++;
  }

  const reviewedSet = new Set((reviewed || []).map((x) => x.id));
  const reviewedToday = (reviewed || []).filter((x) => x.t >= dayStart).length;
  const sorted = [...(games || [])].filter((g) => g && g.moves).sort((a, b) => b.t - a.t);
  const reviewGame = sorted.find((g) => g.res === 0 && !reviewedSet.has(g.id)) || null;

  return {
    repertoire: { hasRepertoire: cards.length > 0, due: repDue, fresh: repNew, done: repDoneToday },
    mistakes: { due: decks?.mistakes?.dueCount || 0, total: decks?.mistakes?.cards?.length || 0, done: doneToday.mistakes },
    blunder: { due: decks?.blunder?.dueCount || 0, total: decks?.blunder?.cards?.length || 0, done: doneToday.blunder },
    convert: { due: decks?.convert?.dueCount || 0, total: decks?.convert?.cards?.length || 0, done: doneToday.convert },
    review: { game: reviewGame, done: reviewedToday },
    prep: { targets: Array.isArray(scoutTargets) ? scoutTargets.length : 0 },
  };
}

function progressPill(done, target) {
  const full = done >= target;
  return `<span class="font-mono text-[10.5px] px-1.5 py-[1px] rounded ${full ? 'bg-em/15 text-em' : 'bg-surface text-txtMuted'}">${Math.min(
    done,
    target
  )}/${target}</span>`;
}

function row({ title, detail, done, target, act, v, label, disabled = false }) {
  return `<div class="flex items-center gap-2 py-2 border-b border-borderSubtle/60 last:border-b-0">
    <div class="min-w-0 flex-1">
      <div class="text-[12px] font-semibold text-txt">${title}</div>
      <div class="text-[11px] text-txtMuted leading-snug">${detail}</div>
    </div>
    ${target ? progressPill(done, target) : ''}
    <button data-act="${act}" data-v="${esc(v)}" ${disabled ? 'disabled' : ''} class="shrink-0 px-2.5 py-1 rounded-md border text-[11px] font-semibold ${
      disabled ? 'opacity-50 cursor-not-allowed bg-surface border-borderSubtle text-txtMuted' : 'bg-em/15 hover:bg-em/25 border-em/35 text-em'
    }">${label}</button>
  </div>`;
}

export function renderToday(ctx) {
  const t = ctx.today;
  const T = TODAY_TARGETS;
  const rows = [];

  rows.push(
    row({
      title: 'Repertoire',
      detail: t.repertoire.hasRepertoire
        ? `${t.repertoire.due} due · ${t.repertoire.fresh} new moves to learn`
        : 'No repertoire loaded yet. Import one in Repertoire.',
      done: t.repertoire.done,
      target: t.repertoire.hasRepertoire ? T.repertoire : 0,
      act: 'today-go',
      v: 'repertoire',
      label: t.repertoire.hasRepertoire ? 'Review' : 'Open',
    })
  );
  rows.push(
    row({
      title: 'Mistake drills',
      detail: t.mistakes.total ? `${t.mistakes.due} due of ${t.mistakes.total} positions from your games` : 'Scan games to build drills',
      done: t.mistakes.done,
      target: T.mistakes,
      act: 'today-go',
      v: 'mistakes',
      label: 'Drill',
      disabled: !t.mistakes.total,
    })
  );
  rows.push(
    row({
      title: 'Blunder check',
      detail: t.blunder.total ? `${t.blunder.due} due · moves 13–30, where most of your blunders happen` : 'Scan games to find your blunders',
      done: t.blunder.done,
      target: T.blunder,
      act: 'today-go',
      v: 'blunder',
      label: 'Check',
      disabled: !t.blunder.total,
    })
  );
  rows.push(
    row({
      title: 'Convert',
      detail: t.convert.total ? `${t.convert.due} due · positions where you were +2 and didn't win` : 'No thrown winning positions found yet',
      done: t.convert.done,
      target: T.convert,
      act: 'today-go',
      v: 'convert',
      label: 'Play',
      disabled: !t.convert.total,
    })
  );
  const g = t.review.game;
  rows.push(
    row({
      title: 'Review a loss',
      detail: g ? `vs ${esc(g.op)}${g.opR ? ` (${esc(g.opR)})` : ''} · ${esc(relTime(g.t, ctx.now))}` : 'No unreviewed losses in these games',
      done: t.review.done,
      target: T.review,
      act: 'today-review',
      v: g ? g.id : '',
      label: 'Open',
      disabled: !g,
    })
  );
  if (t.prep.targets) {
    rows.push(
      row({
        title: 'Opponent prep',
        detail: `${t.prep.targets} scouted opponent${t.prep.targets === 1 ? '' : 's'} · check their weak spots against your repertoire`,
        done: 0,
        target: 0,
        act: 'today-go',
        v: 'prep',
        label: 'Prep',
      })
    );
  }

  return card('Today', `<div>${rows.join('')}</div>`, {
    sub: 'About 20 minutes: repertoire, your own mistakes, one conversion and one game. Progress resets at midnight.',
  });
}
